import type { SessionUpdate, ToolCallStatus } from '@agentclientprotocol/sdk';

import { AimeAcpError } from '../errors.js';
import type {
  NormalizedAimeEvent,
  NormalizedPlanStep,
  NormalizedReference,
} from './event-types.js';

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REFERENCES = 20;

interface PlanStepSnapshot {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface AimeEventState {
  readonly messages: Readonly<Record<string, string>>;
  readonly thought: string;
  readonly references: readonly NormalizedReference[];
  readonly sourcesEmitted: boolean;
  readonly planId?: string;
  readonly planStatus?: string;
  readonly steps: Readonly<Record<string, PlanStepSnapshot>>;
  readonly toolIds: readonly string[];
}

export interface EventReduction {
  readonly nextState: AimeEventState;
  readonly update?: SessionUpdate;
  readonly terminal?: 'idle' | 'awaiting_user';
}

function protocolDrift(): never {
  throw new AimeAcpError(
    'AIME_PROTOCOL_DRIFT',
    'AIME event sequence is contradictory.',
    false,
  );
}

function cloneState(state: AimeEventState): {
  messages: Record<string, string>;
  thought: string;
  references: NormalizedReference[];
  sourcesEmitted: boolean;
  planId?: string;
  planStatus?: string;
  steps: Record<string, PlanStepSnapshot>;
  toolIds: Set<string>;
} {
  return {
    messages: { ...state.messages },
    thought: state.thought,
    references: [...state.references],
    sourcesEmitted: state.sourcesEmitted,
    ...(state.planId === undefined ? {} : { planId: state.planId }),
    ...(state.planStatus === undefined ? {} : { planStatus: state.planStatus }),
    steps: { ...state.steps },
    toolIds: new Set(state.toolIds),
  };
}

function freezeState(next: ReturnType<typeof cloneState>): AimeEventState {
  return {
    messages: Object.freeze({ ...next.messages }),
    thought: next.thought,
    references: Object.freeze(
      next.references.map((reference) => Object.freeze({ ...reference })),
    ),
    sourcesEmitted: next.sourcesEmitted,
    ...(next.planId === undefined ? {} : { planId: next.planId }),
    ...(next.planStatus === undefined ? {} : { planStatus: next.planStatus }),
    steps: Object.freeze({ ...next.steps }),
    toolIds: Object.freeze([...next.toolIds]),
  };
}

export function initialAimeEventState(): AimeEventState {
  return freezeState({
    messages: {},
    thought: '',
    references: [],
    sourcesEmitted: false,
    steps: {},
    toolIds: new Set(),
  });
}

function textUpdate(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  messageId?: string,
  meta?: Readonly<Record<string, unknown>>,
): SessionUpdate | undefined {
  if (text.length === 0) return undefined;
  return {
    sessionUpdate,
    content: { type: 'text', text },
    ...(messageId === undefined ? {} : { messageId }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function planStatus(status: string | undefined): PlanStepSnapshot['status'] {
  switch (status?.toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'success':
      return 'completed';
    case 'running':
    case 'executing':
    case 'in_progress':
    case 'in-progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function toolStatus(status: string | undefined): ToolCallStatus {
  switch (status?.toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'success':
      return 'completed';
    case 'failed':
    case 'failure':
    case 'error':
      return 'failed';
    case 'started':
    case 'running':
    case 'executing':
    case 'in_progress':
    case 'in-progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.slice(0, MAX_DESCRIPTION_LENGTH);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceUpdate(
  references: readonly NormalizedReference[],
): SessionUpdate | undefined {
  if (references.length === 0) return undefined;
  const lines = references.map(
    (reference) =>
      `- [${reference.title.replaceAll(']', '\\]')}](${reference.uri})`,
  );
  return textUpdate(
    'agent_message_chunk',
    `Sources:\n${lines.join('\n')}`,
    'aime-sources',
    { 'aime.acp.message_kind': 'sources' },
  );
}

function terminalSourceUpdate(
  state: ReturnType<typeof cloneState>,
): SessionUpdate | undefined {
  if (state.sourcesEmitted) return undefined;
  const update = sourceUpdate(state.references);
  if (update !== undefined) state.sourcesEmitted = true;
  return update;
}

function appendReferences(
  current: readonly NormalizedReference[],
  next: readonly NormalizedReference[],
): NormalizedReference[] {
  const seen = new Set(current.map((reference) => reference.uri));
  const result = [...current];
  for (const reference of next) {
    if (result.length >= MAX_REFERENCES) break;
    if (!isHttpUrl(reference.uri) || seen.has(reference.uri)) continue;
    seen.add(reference.uri);
    result.push(reference);
  }
  return result;
}

function planUpdate(
  steps: Readonly<Record<string, PlanStepSnapshot | undefined>>,
): SessionUpdate | undefined {
  const entries = Object.values(steps)
    .filter((step): step is PlanStepSnapshot => step !== undefined)
    .map((step) => ({
      content: step.title,
      priority: 'medium' as const,
      status: step.status,
    }));
  if (entries.length === 0) return undefined;
  return { sessionUpdate: 'plan', entries };
}

function stepId(event: NormalizedAimeEvent & { kind: 'step.update' }): string {
  return event.step.id ?? event.eventId ?? protocolDrift();
}

function stepSnapshot(step: NormalizedPlanStep): PlanStepSnapshot | undefined {
  const title = step.title?.trim() || step.summary?.trim();
  if (!title) return undefined;
  return { title, status: planStatus(step.status) };
}

function progressText(
  status: Extract<NormalizedAimeEvent, { kind: 'progress' }>['status'],
): string {
  switch (status) {
    case 'preparing':
      return 'AIME is preparing.';
    case 'thinking':
      return 'AIME is thinking.';
    case 'executing':
      return 'AIME is executing.';
    case 'waiting_for_next':
      return 'AIME is waiting for your next message.';
  }
}

function helpText(question: string, options: readonly string[]): string {
  const choices =
    options.length === 0
      ? ''
      : `\n\n${options.map((option) => `- ${option}`).join('\n')}`;
  return `HELP: AIME 需要你补充信息：\n\n${question}${choices}\n\n请在下一条消息中直接回答。`;
}

/** Reduces a single normalized event to zero or one ACP update without mutation. */
export function reduceAimeEvent(
  state: AimeEventState,
  event: NormalizedAimeEvent,
): EventReduction {
  const next = cloneState(state);
  switch (event.kind) {
    case 'ping':
    case 'unknown':
      return { nextState: freezeState(next) };
    case 'message.create': {
      if (event.message.role !== 'assistant')
        return { nextState: freezeState(next) };
      const prior = next.messages[event.message.id];
      if (prior !== undefined && !event.message.content.startsWith(prior)) {
        return protocolDrift();
      }
      const suffix =
        prior === undefined
          ? event.message.content
          : event.message.content.slice(prior.length);
      next.messages[event.message.id] = event.message.content;
      const update = textUpdate(
        'agent_message_chunk',
        suffix,
        event.message.id,
      );
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
      };
    }
    case 'message.delta': {
      next.messages[event.messageId] =
        (next.messages[event.messageId] ?? '') + event.content;
      const update = textUpdate(
        'agent_message_chunk',
        event.content,
        event.messageId,
      );
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
      };
    }
    case 'progress': {
      if (event.status === 'waiting_for_next') {
        const update = terminalSourceUpdate(next);
        return {
          nextState: freezeState(next),
          ...(update === undefined ? {} : { update }),
          terminal: 'idle',
        };
      }
      const update = textUpdate(
        'agent_thought_chunk',
        progressText(event.status),
        event.eventId ?? `progress:${event.offset}:${event.timestampMs}`,
      );
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
      };
    }
    case 'think.tips': {
      const suffix = next.thought.length === 0 ? event.text : `\n${event.text}`;
      next.thought += suffix;
      const update = textUpdate(
        'agent_thought_chunk',
        suffix,
        event.eventId ?? `thought:${event.offset}:${event.timestampMs}`,
      );
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
      };
    }
    case 'reference':
      next.references = appendReferences(next.references, event.references);
      return { nextState: freezeState(next) };
    case 'plan.update':
      if (event.plan.id === undefined) delete next.planId;
      else next.planId = event.plan.id;
      next.planStatus = event.plan.status;
      return { nextState: freezeState(next) };
    case 'step.update': {
      const id = stepId(event);
      const snapshot = stepSnapshot(event.step);
      if (snapshot) next.steps[id] = snapshot;
      else delete next.steps[id];
      const update = planUpdate(next.steps);
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
      };
    }
    case 'action.use_tool': {
      const id = event.tool.id ?? event.eventId ?? protocolDrift();
      const description = bounded(event.tool.description);
      const content =
        description === undefined
          ? undefined
          : [
              {
                type: 'content' as const,
                content: { type: 'text' as const, text: description },
              },
            ];
      const base = {
        toolCallId: id,
        title: event.tool.name,
        status: toolStatus(event.tool.status),
        ...(content === undefined ? {} : { content }),
      };
      const sessionUpdate = next.toolIds.has(id)
        ? 'tool_call_update'
        : 'tool_call';
      next.toolIds.add(id);
      return {
        nextState: freezeState(next),
        update: { sessionUpdate, ...base } as SessionUpdate,
      };
    }
    case 'action.tool_call_required': {
      const update = textUpdate(
        'agent_message_chunk',
        helpText(event.question, event.options),
      );
      return {
        nextState: freezeState(next),
        ...(update === undefined ? {} : { update }),
        terminal: 'awaiting_user',
      };
    }
  }
}
