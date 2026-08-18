import { AimeAcpError } from '../errors.js';
import type {
  EventMeta,
  NormalizedAimeEvent,
  NormalizedMessage,
  NormalizedPlanStep,
  NormalizedReference,
  NormalizedToolCall,
} from './event-types.js';

type RecordValue = Readonly<Record<string, unknown>>;

const TOOL_CALL_REQUIRED = 'session.action.tool_call_required';

function protocolDrift(): never {
  throw new AimeAcpError(
    'AIME_PROTOCOL_DRIFT',
    'AIME returned an incompatible event.',
    false,
  );
}

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return protocolDrift();
  }
  return value as RecordValue;
}

function string(value: unknown): string {
  if (typeof value !== 'string') return protocolDrift();
  return value;
}

function nonEmpty(value: unknown): string {
  const result = string(value);
  if (result.length === 0) return protocolDrift();
  return result;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value);
}

function optionalReplyMessageId(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  return nonEmpty(value);
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return protocolDrift();
  }
  return value;
}

function metadata(value: RecordValue, rawType: string): EventMeta {
  const timestamp = nonNegativeInteger(value.timestamp);
  const timestampMs = timestamp * 1_000;
  if (!Number.isSafeInteger(timestampMs)) return protocolDrift();
  nonEmpty(value.event_key);
  return {
    ...(value.event_id === undefined
      ? {}
      : { eventId: nonEmpty(value.event_id) }),
    offset: nonNegativeInteger(value.event_offset),
    timestampMs,
    rawType,
  };
}

function message(value: unknown): NormalizedMessage {
  const source = record(value);
  const role = string(source.role);
  if (role !== 'user' && role !== 'assistant') return protocolDrift();
  return {
    id: nonEmpty(source.message_id),
    role,
    content: string(source.content),
  };
}

function references(value: unknown): readonly NormalizedReference[] {
  if (!Array.isArray(value)) return protocolDrift();
  return value.map((item) => {
    const source = record(item);
    const id = nonNegativeInteger(source.id);
    return {
      id: String(id),
      title: string(source.title),
      uri: string(source.uri),
      snippet: string(source.snippet),
    };
  });
}

function step(value: RecordValue): NormalizedPlanStep {
  const id =
    optionalString(value.agent_step_id) ??
    optionalString(value.step_id) ??
    optionalString(value.event_id);
  return {
    ...(id === undefined ? {} : { id }),
    ...(value.status === undefined ? {} : { status: nonEmpty(value.status) }),
    ...(value.title === undefined ? {} : { title: nonEmpty(value.title) }),
    ...(value.summary === undefined
      ? {}
      : { summary: nonEmpty(value.summary) }),
  };
}

function tool(value: RecordValue): NormalizedToolCall {
  const id =
    optionalString(value.tool_call_id) ??
    optionalString(value.agent_step_id) ??
    optionalString(value.event_id);
  const description =
    value.summary === undefined || value.summary === ''
      ? value.description
      : value.summary;
  return {
    ...(id === undefined ? {} : { id }),
    name: nonEmpty(value.tool_name),
    ...(value.status === undefined ? {} : { status: nonEmpty(value.status) }),
    ...(description === undefined
      ? {}
      : { description: nonEmpty(description) }),
  };
}

function question(value: RecordValue): {
  readonly question: string;
  readonly options: readonly string[];
} {
  const rawQuestion = nonEmpty(value.question);
  const rawOptions = value.options;
  if (rawOptions === undefined) return { question: rawQuestion, options: [] };
  if (!Array.isArray(rawOptions)) return protocolDrift();
  return {
    question: rawQuestion,
    options: rawOptions.map((option) => {
      if (typeof option === 'string') return nonEmpty(option);
      return nonEmpty(record(option).label);
    }),
  };
}

/** Normalizes only the static, pinned bytedcli AIME event envelope. */
export function normalizeAimeEvent(raw: unknown): NormalizedAimeEvent {
  const envelope = record(raw);
  const type = nonEmpty(envelope.type);
  if (type === 'ping') return { kind: 'ping' };

  const data = record(envelope.data);
  if (type === 'unknown') {
    if (data.eventType !== TOOL_CALL_REQUIRED) {
      return { kind: 'unknown', offset: 0, timestampMs: 0, rawType: 'unknown' };
    }
    // The pinned parser preserves the original parsed SSE object in `raw`.
    const source = record(data.raw);
    const help = question(source);
    return {
      kind: 'action.tool_call_required',
      ...metadata(source, TOOL_CALL_REQUIRED),
      ...help,
    };
  }

  const meta = metadata(data, type);
  switch (type) {
    case 'session.message.create': {
      const replyMessageId = optionalReplyMessageId(data.reply_message_id);
      return {
        kind: 'message.create',
        ...meta,
        message: message(data.message),
        ...(replyMessageId === undefined ? {} : { replyMessageId }),
      };
    }
    case 'session.message.delta':
      return {
        kind: 'message.delta',
        ...meta,
        messageId: nonEmpty(data.message_id),
        content: string(data.content),
        finished:
          typeof data.is_finished === 'boolean'
            ? data.is_finished
            : protocolDrift(),
      };
    case 'session.progress_notice': {
      const status = nonEmpty(data.status);
      if (
        !['preparing', 'thinking', 'executing', 'waiting_for_next'].includes(
          status,
        )
      ) {
        return protocolDrift();
      }
      return {
        kind: 'progress',
        ...meta,
        status: status as
          | 'preparing'
          | 'thinking'
          | 'executing'
          | 'waiting_for_next',
      };
    }
    case 'session.think.tips':
      if (
        !Array.isArray(data.tips) ||
        !data.tips.every((tip) => typeof tip === 'string')
      ) {
        return protocolDrift();
      }
      return { kind: 'think.tips', ...meta, text: data.tips.join('\n') };
    case 'session.reference':
      return {
        kind: 'reference',
        ...meta,
        references: references(data.references),
      };
    case 'session.plan.update':
      return {
        kind: 'plan.update',
        ...meta,
        plan: {
          ...(data.plan_id === undefined ? {} : { id: nonEmpty(data.plan_id) }),
          status: nonEmpty(data.status),
        },
      };
    case 'session.step.update':
      return { kind: 'step.update', ...meta, step: step(data) };
    case 'session.action.use_tool':
      return { kind: 'action.use_tool', ...meta, tool: tool(data) };
    default:
      return protocolDrift();
  }
}
