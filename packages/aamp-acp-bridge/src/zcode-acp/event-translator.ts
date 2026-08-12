import type {
  PlanEntryPriority,
  PlanEntryStatus,
  SessionUpdate,
  ToolCallStatus,
} from '@agentclientprotocol/sdk'
import {
  inferToolKind,
  toAcpConfigOptions,
  toAcpModes,
} from './translator.js'

const MAX_SEEN_EVENT_IDS = 2048

export interface ZCodeEventTranslation {
  updates: SessionUpdate[]
  completion?: {
    stopReason: 'end_turn' | 'cancelled' | 'max_turn_requests' | 'max_tokens'
    inputId?: string
  }
  failure?: Error
}

export interface ZCodeEventTranslator {
  translate(event: unknown): ZCodeEventTranslation
  reset(): void
  lastSequence(): number
}

interface TextStreamState {
  emitted: string
  sources: Map<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mapPlanStatus(value: unknown): PlanEntryStatus {
  switch (value) {
    case 'completed':
    case 'done':
      return 'completed'
    case 'in_progress':
    case 'doing':
    case 'running':
      return 'in_progress'
    default:
      return 'pending'
  }
}

function mapPlanPriority(value: unknown): PlanEntryPriority {
  return value === 'high' || value === 'low' || value === 'medium'
    ? value
    : 'medium'
}

function mapToolStatus(value: string): ToolCallStatus | undefined {
  switch (value) {
    case 'scheduled':
    case 'pending':
      return 'pending'
    case 'started':
    case 'running':
    case 'progress':
      return 'in_progress'
    case 'result':
    case 'completed':
      return 'completed'
    case 'error':
    case 'failed':
      return 'failed'
    default:
      return undefined
  }
}

class EventTranslator implements ZCodeEventTranslator {
  private sequence = 0
  private readonly seenEventIds = new Set<string>()
  private readonly textStreams = new Map<string, TextStreamState>()
  private readonly seenTools = new Set<string>()

  constructor(private readonly sessionId: string) {}

  translate(rawEvent: unknown): ZCodeEventTranslation {
    if (!isRecord(rawEvent)) {
      return { updates: [], failure: new Error('Malformed ZCode event') }
    }
    if (rawEvent.sessionId !== this.sessionId) return { updates: [] }

    const seq = numeric(rawEvent.seq)
    const type = text(rawEvent.type)
    if (seq === undefined || !type) {
      return { updates: [], failure: new Error('Malformed ZCode event metadata') }
    }
    const eventId = text(rawEvent.eventId)
    if ((eventId && this.seenEventIds.has(eventId)) || seq <= this.sequence) {
      return { updates: [] }
    }
    this.sequence = seq
    if (eventId) this.rememberEventId(eventId)

    const payload = isRecord(rawEvent.payload) ? rawEvent.payload : {}
    switch (type) {
      case 'model.streaming':
        return { updates: this.translateModelStreaming(payload, rawEvent) }
      case 'part.delta':
        return { updates: this.translatePartDelta(payload) }
      case 'part.upserted':
        return { updates: this.translatePartUpsert(payload) }
      case 'message.upserted':
        return { updates: this.translateMessageUpsert(payload) }
      case 'tool.updated':
        return this.translateTool(payload)
      case 'session.updated':
        return { updates: this.translateSessionUpdate(payload) }
      case 'session.titleUpdated':
        return { updates: this.translateTitle(payload) }
      case 'session.usage':
      case 'usage.updated':
        return { updates: this.translateUsage(payload) }
      case 'turn.completed':
        return this.translateCompletion(payload)
      case 'turn.failed':
        return this.translateFailure(payload)
      default:
        return { updates: [] }
    }
  }

  reset(): void {
    this.sequence = 0
    this.seenEventIds.clear()
    this.textStreams.clear()
    this.seenTools.clear()
  }

  lastSequence(): number {
    return this.sequence
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId)
    if (this.seenEventIds.size <= MAX_SEEN_EVENT_IDS) return
    const oldest = this.seenEventIds.values().next().value as string | undefined
    if (oldest) this.seenEventIds.delete(oldest)
  }

  private translateModelStreaming(
    payload: Record<string, unknown>,
    event: Record<string, unknown>,
  ): SessionUpdate[] {
    const kind = text(payload.kind)
    if (kind !== 'text_delta' && kind !== 'reasoning_delta') return []
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    if (delta.length === 0) return []
    const channel = kind === 'text_delta' ? 'text' : 'reasoning'
    const messageId = text(payload.assistantMessageId) ?? text(event.turnId)
    const partId = text(payload.partId) ?? channel
    return this.emitText(
      channel,
      messageId,
      partId,
      'model.streaming',
      delta,
      false,
    )
  }

  private translatePartDelta(payload: Record<string, unknown>): SessionUpdate[] {
    const field = text(payload.field)
    const channel = field?.includes('reasoning') ? 'reasoning'
      : field?.includes('text') ? 'text'
        : undefined
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    if (!channel || delta.length === 0) return []
    const messageId = text(payload.messageId)
    const partId = text(payload.partId) ?? channel
    return this.emitText(
      channel,
      messageId,
      partId,
      'part.delta',
      delta,
      false,
    )
  }

  private translatePartUpsert(payload: Record<string, unknown>): SessionUpdate[] {
    const part = isRecord(payload.part) ? payload.part : payload
    return this.translateFullPart(
      part,
      text(payload.messageId),
      'part.upserted',
    )
  }

  private translateMessageUpsert(payload: Record<string, unknown>): SessionUpdate[] {
    const message = isRecord(payload.message) ? payload.message : payload
    const info = isRecord(message.info) ? message.info : {}
    const messageId = text(info.messageId)
    if (!Array.isArray(message.parts)) return []
    return message.parts.flatMap((part) => isRecord(part)
      ? this.translateFullPart(part, messageId, 'message.upserted')
      : [])
  }

  private translateFullPart(
    part: Record<string, unknown>,
    messageId: string | undefined,
    source: string,
  ): SessionUpdate[] {
    const channel = part.type === 'reasoning' ? 'reasoning'
      : part.type === 'text' ? 'text'
        : undefined
    if (!channel || typeof part.text !== 'string') return []
    const partId = text(part.partId) ?? text(part.id) ?? channel
    return this.emitText(
      channel,
      messageId,
      partId,
      source,
      part.text,
      true,
    )
  }

  private emitText(
    channel: 'text' | 'reasoning',
    messageId: string | undefined,
    partId: string,
    source: string,
    value: string,
    full: boolean,
  ): SessionUpdate[] {
    const key = `${messageId ?? 'message'}:${partId}:${channel}`
    const state = this.textStreams.get(key) ?? {
      emitted: '',
      sources: new Map<string, string>(),
    }
    const candidate = full
      ? value
      : `${state.sources.get(source) ?? ''}${value}`
    state.sources.set(source, candidate)
    this.textStreams.set(key, state)

    if (state.emitted.startsWith(candidate)) return []
    if (!candidate.startsWith(state.emitted)) return []

    const suffix = candidate.slice(state.emitted.length)
    if (suffix.length === 0) return []
    state.emitted = candidate
    return [{
      sessionUpdate: channel === 'text'
        ? 'agent_message_chunk'
        : 'agent_thought_chunk',
      ...(messageId ? { messageId } : {}),
      content: { type: 'text', text: suffix },
    }]
  }

  private translateTool(payload: Record<string, unknown>): ZCodeEventTranslation {
    const update = isRecord(payload.update) ? payload.update : payload
    const toolCallId = text(payload.toolCallId) ?? text(payload.callId)
      ?? text(update.toolCallId) ?? text(update.callId)
    if (!toolCallId) {
      return {
        updates: [],
        failure: new Error('Malformed ZCode tool.updated event: missing toolCallId'),
      }
    }
    const tool = isRecord(update.tool) ? update.tool
      : isRecord(payload.tool) ? payload.tool
        : {}
    const toolName = text(update.toolName) ?? text(update.name)
      ?? text(payload.toolName) ?? text(payload.name)
      ?? text(tool.name) ?? 'tool'
    const statusName = text(update.status) ?? text(update.type)
      ?? text(update.kind) ?? text(payload.status) ?? text(payload.kind)
    const status = statusName ? mapToolStatus(statusName) : undefined
    if (!status) {
      return {
        updates: [],
        failure: new Error('Malformed ZCode tool.updated event: invalid status'),
      }
    }

    const first = !this.seenTools.has(toolCallId)
    this.seenTools.add(toolCallId)
    const input = update.input !== undefined ? update.input : payload.input
    const output = update.result !== undefined
      ? update.result
      : update.error !== undefined
        ? update.error
        : payload.result !== undefined
          ? payload.result
          : payload.error
    const common = {
      toolCallId,
      title: toolName,
      kind: inferToolKind(toolName),
      status,
      ...(input !== undefined ? { rawInput: input } : {}),
      ...(output !== undefined ? { rawOutput: output } : {}),
    }
    return {
      updates: [first
        ? { sessionUpdate: 'tool_call', ...common }
        : { sessionUpdate: 'tool_call_update', ...common }],
    }
  }

  private translateSessionUpdate(payload: Record<string, unknown>): SessionUpdate[] {
    const updates: SessionUpdate[] = []
    const projection = isRecord(payload.projection) ? payload.projection : {}
    const todos = Array.isArray(projection.todos) ? projection.todos : undefined
    if (todos) {
      updates.push({
        sessionUpdate: 'plan',
        entries: todos.flatMap((todo) => {
          if (!isRecord(todo)) return []
          const content = text(todo.content) ?? text(todo.title)
          if (!content) return []
          return [{
            content,
            status: mapPlanStatus(todo.status),
            priority: mapPlanPriority(todo.priority),
          }]
        }),
      })
    }

    const settings = isRecord(payload.settings) ? payload.settings : undefined
    if (settings && settings.mode !== undefined) {
      updates.push({
        sessionUpdate: 'current_mode_update',
        currentModeId: toAcpModes({ settings }).currentModeId,
      })
    }
    if (settings && settings.model !== undefined) {
      const configOptions = toAcpConfigOptions({ settings })
      if (configOptions.length > 0) {
        updates.push({
          sessionUpdate: 'config_option_update',
          configOptions,
        })
      }
    }
    updates.push(...this.translateTitle(payload))
    if (isRecord(projection.usage)) {
      updates.push(...this.translateUsage(projection.usage))
    }
    return updates
  }

  private translateTitle(payload: Record<string, unknown>): SessionUpdate[] {
    if (typeof payload.title !== 'string') return []
    return [{
      sessionUpdate: 'session_info_update',
      title: payload.title,
    }]
  }

  private translateUsage(payload: Record<string, unknown>): SessionUpdate[] {
    const used = numeric(payload.used)
    const size = numeric(payload.size)
    if (used === undefined || size === undefined) return []
    return [{
      sessionUpdate: 'usage_update',
      used,
      size,
    }]
  }

  private translateCompletion(payload: Record<string, unknown>): ZCodeEventTranslation {
    const resultType = text(payload.resultType)
    const inputId = text(payload.inputId)
    if (!resultType) {
      return {
        updates: [],
        failure: new Error('Malformed ZCode turn.completed event: missing resultType'),
      }
    }
    if (resultType === 'error_during_execution') {
      return {
        updates: [],
        failure: new Error(
          `ZCode turn execution failed${inputId ? ` for input ${inputId}` : ''}`,
        ),
      }
    }

    const stopReason = resultType === 'success' ? 'end_turn'
      : resultType === 'cancelled' ? 'cancelled'
        : resultType === 'error_max_budget' ? 'max_tokens'
          : resultType === 'error_max_turns' || resultType === 'error_max_tool_calls'
            ? 'max_turn_requests'
            : undefined
    if (!stopReason) {
      return {
        updates: [],
        failure: new Error(`Unknown ZCode turn result: ${resultType}`),
      }
    }
    return {
      updates: [],
      completion: {
        stopReason,
        ...(inputId ? { inputId } : {}),
      },
    }
  }

  private translateFailure(payload: Record<string, unknown>): ZCodeEventTranslation {
    const error = isRecord(payload.error) ? payload.error : {}
    const message = text(error.message) ?? 'ZCode turn failed'
    const phase = text(payload.turnPhase)
    const inputId = text(payload.inputId)
    return {
      updates: [],
      failure: new Error([
        message,
        phase ? `during ${phase}` : '',
        inputId ? `for input ${inputId}` : '',
      ].filter(Boolean).join(' ')),
    }
  }
}

export function createZcodeEventTranslator(sessionId: string): ZCodeEventTranslator {
  return new EventTranslator(sessionId)
}
