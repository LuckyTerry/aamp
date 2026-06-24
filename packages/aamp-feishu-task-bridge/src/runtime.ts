import {
  AampClient,
  type AampStreamEvent,
  type SendTaskOptions,
  type StreamSubscription,
  type TaskAck,
  type TaskHelp,
  type TaskResult,
  type TaskStreamOpened,
} from 'aamp-sdk'
import { buildAckComment, markAckCommented, shouldCommentAck } from './ack.js'
import {
  createDefaultBridgeState,
  FEISHU_BOE_DOMAIN,
  FEISHU_PRE_DOMAIN,
  loadBridgeState,
  saveBridgeState,
} from './config.js'
import type { FeishuTaskDispatchOptions } from './dispatch.js'
import { buildFeishuTaskDispatch } from './dispatch.js'
import { classifyFeishuTaskEvent } from './events.js'
import { OapiFeishuTaskClient } from './feishu.js'
import type {
  BridgeConfig,
  FeishuAgentRegistrationState,
  BridgeState,
  BridgeTaskState,
  FeishuTaskClient,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskEventKind,
  FeishuTaskSubscriptionState,
} from './types.js'

type Logger = Pick<Console, 'error' | 'log'>
type ConnectivityKind = keyof BridgeState['connectivity']
type TaskFlowIntent = 'complete_task' | 'comment_reply'
type FeishuTaskEventIgnoreReason =
  | 'event_type_not_allowlisted'
  | 'subtask_create_context_only'
  | 'task_create_deferred_to_reminder'
  | 'recurring_task_create_deferred'
const MAX_STREAM_STEPS_PER_TASK = 16
const STREAM_STEP_FLUSH_BATCH_SIZE = 4
const STREAM_STEP_FLUSH_INTERVAL_MS = 5000

interface PendingStreamStep {
  content: string
  normalized: string
}

interface StreamStepBuffer {
  steps: PendingStreamStep[]
  timer?: ReturnType<typeof setTimeout>
}

function createDebugLogger(logger: Logger, enabled: boolean): Logger {
  return {
    log: (message) => {
      if (enabled) logger.log(message)
    },
    error: (message) => {
      logger.error(message)
    },
  }
}

function normalizeDomain(domain: string | undefined): string | undefined {
  return domain?.trim().replace(/\/+$/, '') || undefined
}

function isFeishuBoeDomain(domain: string | undefined): boolean {
  return normalizeDomain(domain) === FEISHU_BOE_DOMAIN
}

function isFeishuPreDomain(domain: string | undefined): boolean {
  return normalizeDomain(domain) === FEISHU_PRE_DOMAIN
}

function getFeishuHeader(headers: Record<string, string> | undefined, headerName: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === headerName) return value.trim() || undefined
  }
  return undefined
}

function getFeishuEnvHeader(headers: Record<string, string> | undefined): string | undefined {
  return getFeishuHeader(headers, 'x-tt-env')
}

function isFeishuPpeHeaderEnabled(headers: Record<string, string> | undefined): boolean {
  return getFeishuHeader(headers, 'x-use-ppe') === '1'
}

function buildFeishuTaskDispatchOptions(config: BridgeConfig): FeishuTaskDispatchOptions {
  const feishuEnv = getFeishuEnvHeader(config.feishu.headers)
  const ppeEnabled = isFeishuPpeHeaderEnabled(config.feishu.headers)
  const feishuEnvMode = feishuEnv
    ? isFeishuBoeDomain(config.feishu.domain)
      ? 'boe'
      : isFeishuPreDomain(config.feishu.domain) && ppeEnabled
        ? 'pre'
        : ppeEnabled
          ? 'ppe'
          : undefined
    : undefined
  return {
    ...(feishuEnv ? { feishuEnv } : {}),
    ...(feishuEnvMode ? { feishuEnvMode } : {}),
  }
}

function buildFeishuAgentRegistrationIdentity(
  config: BridgeConfig,
): Omit<FeishuAgentRegistrationState, 'registeredAt'> {
  const env = getFeishuEnvHeader(config.feishu.headers)
  return {
    appId: config.feishu.appId,
    domain: normalizeDomain(config.feishu.domain) ?? 'default',
    ...(env ? { env } : {}),
  }
}

function buildFeishuTaskSubscriptionIdentity(
  config: BridgeConfig,
): Omit<FeishuTaskSubscriptionState, 'subscribedAt'> {
  const env = getFeishuEnvHeader(config.feishu.headers)
  return {
    appId: config.feishu.appId,
    domain: normalizeDomain(config.feishu.domain) ?? 'default',
    ...(env ? { env } : {}),
    userIdType: config.feishu.userIdType ?? 'open_id',
  }
}

function hasMatchingFeishuAgentRegistration(
  current: FeishuAgentRegistrationState | undefined,
  expected: Omit<FeishuAgentRegistrationState, 'registeredAt'>,
): boolean {
  return Boolean(current)
    && current?.appId === expected.appId
    && current?.domain === expected.domain
    && (current?.env ?? undefined) === (expected.env ?? undefined)
}

function hasMatchingFeishuTaskSubscription(
  current: FeishuTaskSubscriptionState | undefined,
  expected: Omit<FeishuTaskSubscriptionState, 'subscribedAt'>,
): boolean {
  return Boolean(current)
    && current?.appId === expected.appId
    && current?.domain === expected.domain
    && (current?.env ?? undefined) === (expected.env ?? undefined)
    && current?.userIdType === expected.userIdType
}

function describeFeishuAgentRegistration(
  registration: Omit<FeishuAgentRegistrationState, 'registeredAt'>,
): string {
  return [
    `app=${registration.appId}`,
    `domain=${registration.domain}`,
    `env=${registration.env ?? '(none)'}`,
  ].join(' ')
}

function describeFeishuTaskSubscription(
  subscription: Omit<FeishuTaskSubscriptionState, 'subscribedAt'>,
): string {
  return [
    `app=${subscription.appId}`,
    `domain=${subscription.domain}`,
    `env=${subscription.env ?? '(none)'}`,
    `userIdType=${subscription.userIdType}`,
  ].join(' ')
}

type TaskResultDisposition =
  | { kind: 'answered'; summary?: string; taskFlowIntent?: TaskFlowIntent }
  | { kind: 'success'; summary: string; deliverableSummary?: string }
  | { kind: 'failure'; summary?: string; message: string }
  | { kind: 'help_needed'; message: string }

const FEISHU_RESULT_MARKER = 'FEISHU_TASK_RESULT_JSON:'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function normalizeResultText(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
}

function getString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeResultText(value).trim()
  return normalized ? normalized : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function getTaskFlowIntent(payload: Record<string, unknown>): TaskFlowIntent | undefined {
  const taskFlowIntent = getString(payload.task_flow_intent)?.toLowerCase()
  if (taskFlowIntent === 'complete_task' || taskFlowIntent === 'comment_reply') return taskFlowIntent

  const legacyCommentIntent = getString(payload.comment_intent)?.toLowerCase()
  if (legacyCommentIntent === 'rerun') return 'complete_task'
  if (legacyCommentIntent === 'reply_only') return 'comment_reply'
  return undefined
}

function parseFeishuResultPayload(output: string): Record<string, unknown> | undefined {
  const markerIndex = output.indexOf(FEISHU_RESULT_MARKER)
  if (markerIndex < 0) return undefined
  const jsonText = output.slice(markerIndex + FEISHU_RESULT_MARKER.length).trim()
  if (!jsonText) return undefined
  const parsed = JSON.parse(jsonText) as unknown
  return asRecord(parsed)
}

function classifyTaskResult(result: TaskResult): TaskResultDisposition {
  const output = result.output.trim()
  if (result.status === 'rejected') {
    return {
      kind: 'failure',
      message: result.errorMsg?.trim() || output || 'ACP agent rejected the task without an error message.',
    }
  }

  let payload: Record<string, unknown> | undefined
  try {
    payload = parseFeishuResultPayload(output)
  } catch (error) {
    return {
      kind: 'failure',
      message: `智能体返回了无法解析的 FEISHU_TASK_RESULT_JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (payload) {
    const status = getString(payload.status)?.toLowerCase()
    const summary = getString(payload.summary)
    const deliverableSummary = getString(payload.deliverable_summary) ?? getString(payload.delivery)
    const error = getString(payload.error)
    const question = getString(payload.question)
    const helpNeeded = getBoolean(payload.help_needed)
    const taskFlowIntent = getTaskFlowIntent(payload)
    if (status === 'answered') {
      return { kind: 'answered', ...(summary ? { summary } : {}), ...(taskFlowIntent ? { taskFlowIntent } : {}) }
    }
    if (status === 'success') {
      return {
        kind: 'success',
        summary: summary ?? deliverableSummary ?? '已完成交付物处理。',
        ...(deliverableSummary ? { deliverableSummary } : {}),
      }
    }
    if (status === 'need_help' || status === 'help_needed' || helpNeeded === true) {
      return { kind: 'help_needed', message: question ?? summary ?? error ?? '智能体需要更多信息才能继续处理该任务。' }
    }
    if (status === 'failure' || status === 'failed' || error) {
      return {
        kind: 'failure',
        ...(summary ? { summary } : {}),
        message: error ?? summary ?? '智能体报告任务执行失败，但未提供具体错误。',
      }
    }
    return {
      kind: 'failure',
      message: `智能体返回了未知 FEISHU_TASK_RESULT_JSON.status：${status ?? '(missing)'}`,
    }
  }

  return {
    kind: 'failure',
    message: output
      ? `智能体返回了非预期结果，未按 FEISHU_TASK_RESULT_JSON 协议收尾：${output}`
      : '智能体返回了空结果，未按 FEISHU_TASK_RESULT_JSON 协议收尾。',
  }
}

function getTaskCreateIgnoreReason(eventKind: FeishuTaskEventKind, task: FeishuTaskDetails): FeishuTaskEventIgnoreReason | undefined {
  if (eventKind !== 'task_create') return undefined
  if (task.parentGuid) return 'subtask_create_context_only'
  if (task.reminders?.length) return 'task_create_deferred_to_reminder'
  if (task.rrule) return 'recurring_task_create_deferred'
  return undefined
}

function normalizeStepText(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase()
}

const IGNORED_STREAM_STEP_TEXTS = new Set([
  'ACP task started',
  'Prompt sent to ACP agent',
  'ACP agent is thinking',
  'ACP agent is composing the reply',
  'ACP response received',
].map(normalizeStepText))

function getPayloadText(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getString(payload[key])
    if (value) return value
  }
  return undefined
}

function getTodoItemText(value: unknown): string | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  return getPayloadText(item, ['content', 'text', 'title', 'label', 'summary'])
}

function uniqueStepContents(contents: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const content of contents) {
    if (!content) continue
    const normalized = normalizeStepText(content)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(content)
  }
  return result
}

function streamEventToTaskSteps(event: AampStreamEvent): string[] {
  const eventType = String(event.type)
  if (eventType === 'status') {
    return uniqueStepContents([getPayloadText(event.payload, ['label', 'stage', 'status', 'message', 'text'])])
  }
  if (eventType === 'progress') {
    return uniqueStepContents([getPayloadText(event.payload, ['label', 'stage', 'message', 'text'])])
  }
  if (eventType === 'todo') {
    const itemTexts = Array.isArray(event.payload.items)
      ? event.payload.items.map(getTodoItemText)
      : []
    return uniqueStepContents([
      ...itemTexts,
      itemTexts.length === 0 ? getPayloadText(event.payload, ['summary', 'label', 'message', 'text']) : undefined,
    ])
  }
  if (eventType === 'tool_call') {
    return uniqueStepContents([getPayloadText(event.payload, ['label', 'summary', 'message', 'text'])])
  }
  if (eventType === 'error') {
    const message = getPayloadText(event.payload, ['message', 'error', 'reason'])
    return [message ? `执行遇到错误：${message}` : '执行遇到错误。']
  }
  return []
}

interface AampClientLike {
  on(event: 'connected', handler: () => void): unknown
  on(event: 'disconnected', handler: (reason?: string) => void): unknown
  on(event: 'error', handler: (error: Error) => void): unknown
  on(event: 'task.ack', handler: (ack: TaskAck) => void): unknown
  on(event: 'task.stream.opened', handler: (stream: TaskStreamOpened) => void): unknown
  on(event: 'task.help_needed', handler: (help: TaskHelp) => void): unknown
  on(event: 'task.result', handler: (result: TaskResult) => void): unknown
  connect(): Promise<void>
  disconnect(): void
  sendTask(opts: SendTaskOptions): Promise<{ taskId: string; messageId: string }>
  subscribeStream?(
    streamId: string,
    handlers: { onEvent: (event: AampStreamEvent) => void; onError?: (err: Error) => void; onOpen?: () => void },
    opts?: { lastEventId?: string; signal?: AbortSignal },
  ): Promise<StreamSubscription>
  updateDirectoryProfile?(opts: { summary: string; cardText: string }): Promise<unknown>
}

export interface FeishuTaskBridgeRuntimeOptions {
  configDir?: string
  logger?: Logger
  feishuClient?: FeishuTaskClient
  aampClient?: AampClientLike
  forceRegisterAgent?: boolean
  streamStepFlushIntervalMs?: number
}

export class FeishuTaskBridgeRuntime {
  private readonly config: BridgeConfig
  private readonly configDir?: string
  private readonly logger: Logger
  private readonly aamp: AampClientLike
  private readonly feishu: FeishuTaskClient
  private readonly forceRegisterAgent: boolean
  private readonly streamStepFlushIntervalMs: number
  private state: BridgeState = createDefaultBridgeState()
  private readonly ackCommentInFlight = new Set<string>()
  private readonly helpCommentInFlight = new Set<string>()
  private readonly resultInFlight = new Set<string>()
  private readonly feishuCompleteInFlight = new Set<string>()
  private readonly feishuBlockInFlight = new Set<string>()
  private readonly activeStreamSubscriptions = new Map<string, StreamSubscription>()
  private readonly streamEventQueues = new Map<string, Promise<void>>()
  private readonly streamStepBuffers = new Map<string, StreamStepBuffer>()
  private readonly streamStepFlushQueues = new Map<string, Promise<void>>()
  private stopping = false

  constructor(config: BridgeConfig, options: FeishuTaskBridgeRuntimeOptions = {}) {
    this.config = config
    this.configDir = options.configDir
    this.logger = options.logger ?? console
    this.forceRegisterAgent = Boolean(options.forceRegisterAgent)
    this.streamStepFlushIntervalMs = options.streamStepFlushIntervalMs ?? STREAM_STEP_FLUSH_INTERVAL_MS
    this.aamp = options.aampClient ?? new AampClient({
      email: config.mailbox.email,
      mailboxToken: config.mailbox.mailboxToken,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    this.feishu = options.feishuClient ?? new OapiFeishuTaskClient(config.feishu, {
      logger: createDebugLogger(this.logger, Boolean(config.behavior.debug)),
    })
  }

  async start(): Promise<void> {
    this.state = await loadBridgeState(this.configDir)
    this.state.lastStartedAt = new Date().toISOString()
    this.state.lastError = undefined
    this.setConnectivity('aamp', 'connecting')
    this.setConnectivity('feishu', 'connecting')
    this.logger.log([
      '[bridge] starting',
      `target=${this.config.targetAgentEmail}`,
      `mailbox=${this.config.mailbox.email}`,
      `events=${this.config.feishu.eventNames.join(',')}`,
      `taskApi=${this.config.feishu.taskApiVersion}`,
      `ackComment=${this.config.behavior.ackComment ? 'on' : 'off'}`,
      `debug=${this.config.behavior.debug ? 'on' : 'off'}`,
    ].join(' '))

    await this.ensureFeishuAgentRegistered()
    await this.ensureFeishuTaskEventsSubscribed()

    this.registerAampHandlers()

    await this.aamp.connect()
    this.setConnectivity('aamp', 'connected')

    await this.feishu.start(async (event) => {
      await this.handleFeishuTaskEvent(event)
    })
    this.setConnectivity('feishu', 'connected')
    this.logger.log(`[feishu] listener started events=${this.config.feishu.eventNames.join(',')}`)

    await this.aamp.updateDirectoryProfile?.({
      summary: `Feishu task bridge mailbox for ${this.config.targetAgentEmail}`,
      cardText: [
        'This mailbox belongs to a local Feishu task bridge.',
        `Target AAMP Agent: ${this.config.targetAgentEmail}`,
        'Dispatch source: feishu-task',
      ].join('\n'),
    }).catch(() => {})

    await this.persistState()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const subscription of this.activeStreamSubscriptions.values()) {
      subscription.close()
    }
    this.activeStreamSubscriptions.clear()
    await Promise.allSettled([...this.streamEventQueues.values()])
    this.streamEventQueues.clear()
    await this.flushAllStreamStepBuffers()
    await Promise.allSettled([...this.streamStepFlushQueues.values()])
    this.clearAllStreamStepFlushTimers()
    await this.feishu.stop().catch(() => {})
    this.aamp.disconnect()
    this.state.lastStoppedAt = new Date().toISOString()
    this.setConnectivity('aamp', 'disconnected')
    this.setConnectivity('feishu', 'disconnected')
    await this.persistState()
  }

  getStateSnapshot(): BridgeState {
    return structuredClone(this.state)
  }

  private async ensureFeishuAgentRegistered(): Promise<void> {
    const expected = buildFeishuAgentRegistrationIdentity(this.config)
    if (!this.forceRegisterAgent && hasMatchingFeishuAgentRegistration(this.state.agentRegistration, expected)) {
      this.logger.log(`[feishu agent] registration cached ${describeFeishuAgentRegistration(expected)}`)
      return
    }

    this.logger.log(`[feishu agent] registering ${describeFeishuAgentRegistration(expected)}`)
    await this.feishu.registerAgent()
    this.state.agentRegistration = {
      ...expected,
      registeredAt: new Date().toISOString(),
    }
    await this.persistState()
    this.logger.log(`[feishu agent] registered ${describeFeishuAgentRegistration(expected)}`)
  }

  private async ensureFeishuTaskEventsSubscribed(): Promise<void> {
    const expected = buildFeishuTaskSubscriptionIdentity(this.config)
    if (hasMatchingFeishuTaskSubscription(this.state.taskSubscription, expected)) {
      this.logger.log(`[feishu task subscription] cached ${describeFeishuTaskSubscription(expected)}`)
      return
    }

    this.logger.log(`[feishu task subscription] subscribing ${describeFeishuTaskSubscription(expected)}`)
    await this.feishu.subscribeTaskEvents()
    this.state.taskSubscription = {
      ...expected,
      subscribedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.logger.log(`[feishu task subscription] subscribed ${describeFeishuTaskSubscription(expected)}`)
  }

  private registerAampHandlers(): void {
    this.aamp.on('connected', () => {
      this.setConnectivity('aamp', 'connected')
      this.logger.log('[aamp] connected')
      this.debugLog(`[aamp] connected mailbox=${this.config.mailbox.email}`)
      void this.persistState()
    })
    this.aamp.on('disconnected', (reason) => {
      this.setConnectivity('aamp', 'disconnected')
      this.logger.log(`[aamp] disconnected${reason ? ` reason=${reason}` : ''}`)
      void this.persistState()
    })
    this.aamp.on('error', (error) => {
      this.state.lastError = error.message
      this.logger.error(`[aamp] ${error.message}`)
      void this.persistState()
    })
    this.aamp.on('task.ack', (ack) => {
      this.state.lastAampAckAt = new Date().toISOString()
      this.state.lastAampAckTaskId = ack.taskId
      this.logger.log(`[aamp ack] received task=${ack.taskId}`)
      this.debugLog(`[aamp ack ${ack.taskId}] received from=${ack.from}`)
      void this.handleTaskAck(ack).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp ack ${ack.taskId}] ${error.message}`)
        void this.persistState()
      })
    })
    this.aamp.on('task.stream.opened', (stream) => {
      this.logger.log(`[aamp stream] opened task=${stream.taskId} stream=${stream.streamId}`)
      this.debugLog(`[aamp stream ${stream.taskId}] opened stream=${stream.streamId} from=${stream.from}`)
      void this.handleTaskStreamOpened(stream).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${stream.taskId}] ${error.message}`)
        void this.persistState()
      })
    })
    this.aamp.on('task.help_needed', (help) => {
      this.state.lastAampHelpAt = new Date().toISOString()
      this.state.lastAampHelpTaskId = help.taskId
      this.logger.log(`[aamp help] received task=${help.taskId}`)
      this.debugLog(`[aamp help ${help.taskId}] received from=${help.from}`)
      void this.handleTaskHelp(help).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp help ${help.taskId}] ${error.message}`)
        void this.persistState()
      })
    })
    this.aamp.on('task.result', (result) => {
      this.state.lastAampResultAt = new Date().toISOString()
      this.state.lastAampResultTaskId = result.taskId
      this.logger.log(`[aamp result] received task=${result.taskId} status=${result.status}`)
      this.debugLog(`[aamp result ${result.taskId}] received from=${result.from} status=${result.status}`)
      void this.handleTaskResult(result).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp result ${result.taskId}] ${error.message}`)
        void this.persistState()
      })
    })
  }

  private async ignoreFeishuTaskEvent(event: FeishuTaskEvent, reason: FeishuTaskEventIgnoreReason): Promise<void> {
    this.logger.log(`[feishu event] ignored task=${event.taskGuid} types=${event.eventTypes.join(',') || '(unknown)'} reason=${reason}`)
    this.debugLog(`[feishu event ${event.eventId}] ignored reason=${reason}`)
    this.state.lastIgnoredFeishuEventAt = new Date().toISOString()
    this.state.lastIgnoredFeishuEventId = event.eventId
    this.state.lastIgnoredFeishuEventTaskGuid = event.taskGuid
    this.state.lastIgnoredFeishuEventTypes = event.eventTypes
    this.state.lastIgnoredFeishuEventReason = reason
    await this.persistState()
  }

  private async handleFeishuTaskEvent(event: FeishuTaskEvent): Promise<void> {
    this.state.lastFeishuEventAt = new Date().toISOString()
    this.state.lastFeishuEventId = event.eventId
    this.state.lastFeishuEventTaskGuid = event.taskGuid
    this.logger.log(`[feishu event] received task=${event.taskGuid}`)
    this.debugLog(`[feishu event ${event.eventId}] received task=${event.taskGuid} types=${event.eventTypes.join(',') || '(unknown)'}`)
    if (!this.rememberEvent(event)) {
      this.debugLog(`[feishu event ${event.eventId}] duplicate ignored`)
      await this.persistState()
      return
    }

    const eventKind = classifyFeishuTaskEvent(event.eventTypes)
    if (!eventKind) {
      await this.ignoreFeishuTaskEvent(event, 'event_type_not_allowlisted')
      return
    }

    let taskState: BridgeTaskState | undefined
    try {
      this.debugLog(`[feishu task ${event.taskGuid}] loading details`)
      const task = await this.feishu.getTask(event.taskGuid)
      this.debugLog(`[feishu task ${task.guid}] loaded summary="${task.summary}" children=${task.subtasks?.length ?? 0}`)
      const ignoreReason = getTaskCreateIgnoreReason(eventKind, task)
      if (ignoreReason) {
        await this.ignoreFeishuTaskEvent(event, ignoreReason)
        return
      }
      const dispatch = buildFeishuTaskDispatch(event, task, eventKind, {
        ...buildFeishuTaskDispatchOptions(this.config),
      })
      const now = new Date().toISOString()
      taskState = {
        taskGuid: task.guid,
        aampTaskId: dispatch.taskId,
        feishuEventId: event.eventId,
        feishuEventKind: eventKind,
        ...(task.taskId ? { feishuTaskId: task.taskId } : {}),
        ...(task.subtasks?.length ? { childTaskGuids: task.subtasks.map((subtask) => subtask.guid) } : {}),
        status: 'dispatching',
        createdAt: now,
        updatedAt: now,
      }
      this.state.tasks[dispatch.taskId] = taskState
      await this.persistState()
      this.debugLog([
        `[aamp dispatch ${dispatch.taskId}] sending`,
        `to=${this.config.targetAgentEmail}`,
        `session=${dispatch.sessionKey}`,
        `source=${dispatch.dispatchContext.source ?? '(none)'}`,
        `event_kind=${dispatch.dispatchContext.feishu_event_kind ?? '(none)'}`,
        `event_types=${dispatch.dispatchContext.feishu_task_event_types ?? '(none)'}`,
      ].join(' '))

      const result = await this.aamp.sendTask({
        to: this.config.targetAgentEmail,
        taskId: dispatch.taskId,
        sessionKey: dispatch.sessionKey,
        title: dispatch.title,
        bodyText: dispatch.bodyText,
        rawBodyText: dispatch.bodyText,
        dispatchContext: dispatch.dispatchContext,
        promptRules: dispatch.promptRules,
      })

      this.state.tasks[dispatch.taskId] = {
        ...taskState,
        aampMessageId: result.messageId,
        status: 'dispatched',
        updatedAt: new Date().toISOString(),
      }
      this.state.lastAampDispatchAt = new Date().toISOString()
      this.state.lastAampDispatchTaskId = dispatch.taskId
      await this.persistState()
      this.logger.log(`[aamp dispatch] sent task=${dispatch.taskId}`)
      this.debugLog(`[aamp dispatch ${dispatch.taskId}] sent message=${result.messageId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state.lastError = message
      if (taskState) {
        this.state.tasks[taskState.aampTaskId] = {
          ...taskState,
          status: 'failed',
          lastError: message,
          updatedAt: new Date().toISOString(),
        }
      }
      await this.persistState()
      throw error
    }
  }

  private async handleTaskStreamOpened(stream: TaskStreamOpened): Promise<void> {
    const taskState = this.state.tasks[stream.taskId]
    if (!taskState) return

    this.state.tasks[stream.taskId] = {
      ...taskState,
      streamId: stream.streamId,
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    await this.subscribeToTaskStream(stream.taskId, stream.streamId)
  }

  private async subscribeToTaskStream(aampTaskId: string, streamId: string): Promise<void> {
    if (!this.aamp.subscribeStream) {
      this.debugLog(`[aamp stream ${aampTaskId}] subscribeStream unavailable`)
      return
    }
    if (this.activeStreamSubscriptions.has(aampTaskId)) return

    const latestTaskState = this.state.tasks[aampTaskId]
    const subscription = await this.aamp.subscribeStream(
      streamId,
      {
        onEvent: (event) => {
          this.enqueueStreamEvent(aampTaskId, event)
        },
        onError: (error) => {
          this.state.lastError = error.message
          this.logger.error(`[aamp stream ${aampTaskId}] ${error.message}`)
          void this.persistState()
        },
      },
      latestTaskState?.lastStreamEventId ? { lastEventId: latestTaskState.lastStreamEventId } : {},
    )
    this.activeStreamSubscriptions.set(aampTaskId, subscription)
  }

  private enqueueStreamEvent(aampTaskId: string, event: AampStreamEvent): void {
    const previous = this.streamEventQueues.get(aampTaskId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.handleStreamEvent(aampTaskId, event))
      .catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${aampTaskId}] ${error.message}`)
        void this.persistState()
      })
    this.streamEventQueues.set(aampTaskId, next)
    void next.finally(() => {
      if (this.streamEventQueues.get(aampTaskId) === next) {
        this.streamEventQueues.delete(aampTaskId)
      }
    })
  }

  private async handleStreamEvent(aampTaskId: string, event: AampStreamEvent): Promise<void> {
    const taskState = this.state.tasks[aampTaskId]
    if (!taskState) return

    const baseState: BridgeTaskState = {
      ...taskState,
      ...(event.id ? { lastStreamEventId: event.id } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.state.tasks[aampTaskId] = baseState

    const stepContents = streamEventToTaskSteps(event)
    if (stepContents.length === 0) {
      await this.persistState()
      return
    }

    const streamStepTexts = new Set(baseState.streamStepTexts ?? [])
    const buffer = this.getStreamStepBuffer(aampTaskId)
    let addedStep = false
    for (const stepContent of stepContents) {
      const normalized = normalizeStepText(stepContent)
      const pendingStepCount = buffer.steps.length
      if (
        IGNORED_STREAM_STEP_TEXTS.has(normalized)
        || streamStepTexts.has(normalized)
        || buffer.steps.some((step) => step.normalized === normalized)
        || (baseState.streamStepCount ?? 0) + pendingStepCount >= MAX_STREAM_STEPS_PER_TASK
      ) {
        continue
      }

      buffer.steps.push({ content: stepContent, normalized })
      addedStep = true
    }

    if (!addedStep) {
      await this.persistState()
      return
    }

    if (buffer.steps.length >= STREAM_STEP_FLUSH_BATCH_SIZE) {
      await this.enqueueStreamStepFlush(aampTaskId)
      return
    }

    this.scheduleStreamStepFlush(aampTaskId)
    await this.persistState()
  }

  private getStreamStepBuffer(aampTaskId: string): StreamStepBuffer {
    const existing = this.streamStepBuffers.get(aampTaskId)
    if (existing) return existing
    const buffer: StreamStepBuffer = { steps: [] }
    this.streamStepBuffers.set(aampTaskId, buffer)
    return buffer
  }

  private scheduleStreamStepFlush(aampTaskId: string): void {
    if (this.stopping) return
    const buffer = this.streamStepBuffers.get(aampTaskId)
    if (!buffer || buffer.steps.length === 0 || buffer.timer) return

    buffer.timer = setTimeout(() => {
      const latestBuffer = this.streamStepBuffers.get(aampTaskId)
      if (latestBuffer) delete latestBuffer.timer
      void this.enqueueStreamStepFlush(aampTaskId)
    }, this.streamStepFlushIntervalMs)
    buffer.timer.unref?.()
  }

  private clearStreamStepFlushTimer(aampTaskId: string): void {
    const buffer = this.streamStepBuffers.get(aampTaskId)
    if (!buffer?.timer) return
    clearTimeout(buffer.timer)
    delete buffer.timer
  }

  private clearAllStreamStepFlushTimers(): void {
    for (const aampTaskId of this.streamStepBuffers.keys()) {
      this.clearStreamStepFlushTimer(aampTaskId)
    }
  }

  private async enqueueStreamStepFlush(aampTaskId: string): Promise<void> {
    this.clearStreamStepFlushTimer(aampTaskId)
    const previous = this.streamStepFlushQueues.get(aampTaskId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.flushStreamStepBuffer(aampTaskId))
      .catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${aampTaskId}] ${error.message}`)
        this.scheduleStreamStepFlush(aampTaskId)
        void this.persistState()
      })
    this.streamStepFlushQueues.set(aampTaskId, next)
    void next.finally(() => {
      if (this.streamStepFlushQueues.get(aampTaskId) === next) {
        this.streamStepFlushQueues.delete(aampTaskId)
      }
    })
    await next
  }

  private async flushAllStreamStepBuffers(): Promise<void> {
    await Promise.all([...this.streamStepBuffers.keys()].map((aampTaskId) => this.enqueueStreamStepFlush(aampTaskId)))
  }

  private async flushStreamStepBuffer(aampTaskId: string): Promise<void> {
    const buffer = this.streamStepBuffers.get(aampTaskId)
    if (!buffer || buffer.steps.length === 0) {
      this.streamStepBuffers.delete(aampTaskId)
      return
    }

    const taskState = this.state.tasks[aampTaskId]
    if (!taskState) {
      this.streamStepBuffers.delete(aampTaskId)
      return
    }

    const stepsToFlush = buffer.steps.slice()
    await this.feishu.appendTaskSteps(taskState.taskGuid, stepsToFlush.map((step) => step.content))

    const latestBuffer = this.streamStepBuffers.get(aampTaskId)
    if (latestBuffer) {
      latestBuffer.steps = latestBuffer.steps.slice(stepsToFlush.length)
      if (latestBuffer.steps.length === 0) {
        this.streamStepBuffers.delete(aampTaskId)
      } else {
        this.scheduleStreamStepFlush(aampTaskId)
      }
    }

    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    const latestStreamStepTexts = new Set(latestTaskState.streamStepTexts ?? [])
    for (const step of stepsToFlush) {
      latestStreamStepTexts.add(step.normalized)
    }
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      streamStepCount: (latestTaskState.streamStepCount ?? 0) + stepsToFlush.length,
      streamStepTexts: [...latestStreamStepTexts],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[aamp stream ${aampTaskId}] appended ${stepsToFlush.length} Feishu step(s)`)
  }

  private async handleTaskAck(ack: TaskAck): Promise<void> {
    if (this.ackCommentInFlight.has(ack.taskId)) return
    const taskState = this.state.tasks[ack.taskId]
    if (!taskState) return

    if (!this.config.behavior.ackComment) {
      this.logger.log(`[aamp ack ${ack.taskId}] ack comment disabled`)
      this.state.tasks[ack.taskId] = {
        ...taskState,
        status: 'acknowledged',
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      return
    }

    if (!shouldCommentAck(taskState, ack.taskId)) {
      this.logger.log(`[aamp ack ${ack.taskId}] comment already recorded`)
      return
    }

    this.ackCommentInFlight.add(ack.taskId)
    try {
      this.debugLog(`[aamp ack ${ack.taskId}] commenting on Feishu task ${taskState.taskGuid}`)
      await this.feishu.commentTask(taskState.taskGuid, buildAckComment({
        aampTaskId: ack.taskId,
        bridgeName: this.config.slug,
        eventKind: taskState.feishuEventKind,
        debug: this.config.behavior.debug,
      }))

      this.state.tasks[ack.taskId] = markAckCommented(taskState, ack.taskId)
      await this.persistState()
      this.logger.log(`[aamp ack] commented task=${ack.taskId}`)
      this.debugLog(`[aamp ack ${ack.taskId}] commented on Feishu task ${taskState.taskGuid}`)
    } finally {
      this.ackCommentInFlight.delete(ack.taskId)
    }
  }

  private async handleTaskHelp(help: TaskHelp): Promise<void> {
    if (this.helpCommentInFlight.has(help.taskId)) return
    const taskState = this.state.tasks[help.taskId]
    if (!taskState) return

    this.helpCommentInFlight.add(help.taskId)
    try {
      await this.enqueueStreamStepFlush(help.taskId)
      const latestTaskState = this.state.tasks[help.taskId] ?? taskState

      if ((latestTaskState.helpCommentedTaskIds ?? []).includes(help.taskId)) {
        this.logger.log(`[aamp help ${help.taskId}] comment already recorded`)
        await this.markFeishuTaskBlockedOnce(help.taskId, latestTaskState)
        return
      }

      const comment = (help.question ?? '').trim()
        || (help.blockedReason ?? '').trim()
        || '智能体需要更多信息才能继续处理该任务。'
      this.debugLog(`[aamp help ${help.taskId}] commenting on Feishu task ${latestTaskState.taskGuid}`)
      await this.feishu.commentTask(latestTaskState.taskGuid, comment)

      const helpCommentedTaskIds = new Set(latestTaskState.helpCommentedTaskIds ?? [])
      helpCommentedTaskIds.add(help.taskId)
      const updatedState: BridgeTaskState = {
        ...latestTaskState,
        status: 'help_needed',
        helpCommentedTaskIds: [...helpCommentedTaskIds],
        updatedAt: new Date().toISOString(),
      }
      this.state.tasks[help.taskId] = updatedState
      await this.markFeishuTaskBlockedOnce(help.taskId, updatedState)
      this.state.tasks[help.taskId] = {
        ...(this.state.tasks[help.taskId] ?? updatedState),
        status: 'help_needed',
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      this.logger.log(`[aamp help] commented task=${help.taskId}`)
      this.debugLog(`[aamp help ${help.taskId}] commented on Feishu task ${latestTaskState.taskGuid}`)
    } finally {
      this.helpCommentInFlight.delete(help.taskId)
    }
  }

  private async handleTaskResult(result: TaskResult): Promise<void> {
    if (this.resultInFlight.has(result.taskId)) return
    const taskState = this.state.tasks[result.taskId]
    if (!taskState) return

    this.resultInFlight.add(result.taskId)
    try {
      await this.enqueueStreamStepFlush(result.taskId)
      const flushedTaskState = this.state.tasks[result.taskId] ?? taskState

      if ((flushedTaskState.resultHandledTaskIds ?? []).includes(result.taskId)) {
        this.logger.log(`[aamp result ${result.taskId}] result already handled`)
        return
      }

      const disposition = classifyTaskResult(result)
      if (disposition.kind === 'answered') {
        const shouldCompleteFeishuTask = flushedTaskState.feishuEventKind !== 'task_comment' || disposition.taskFlowIntent === 'complete_task'
        if (shouldCompleteFeishuTask) {
          await this.completeFeishuTasksOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)
        }

        const latestTaskState = this.state.tasks[result.taskId] ?? flushedTaskState
        const resultHandledTaskIds = new Set(latestTaskState.resultHandledTaskIds ?? [])
        resultHandledTaskIds.add(result.taskId)
        this.state.tasks[result.taskId] = {
          ...latestTaskState,
          status: 'completed',
          resultHandledTaskIds: [...resultHandledTaskIds],
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        }
        await this.persistState()
        this.logger.log(`[aamp result] answered task=${result.taskId}`)
        return
      }

      if (disposition.kind === 'help_needed') {
        await this.commentHelpNeededOnce(result.taskId, flushedTaskState, disposition.message)
        await this.markFeishuTaskBlockedOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)
        const latestTaskState = this.state.tasks[result.taskId] ?? flushedTaskState
        const resultHandledTaskIds = new Set(latestTaskState.resultHandledTaskIds ?? [])
        resultHandledTaskIds.add(result.taskId)
        this.state.tasks[result.taskId] = {
          ...latestTaskState,
          status: 'help_needed',
          resultHandledTaskIds: [...resultHandledTaskIds],
          updatedAt: new Date().toISOString(),
        }
        await this.persistState()
        this.logger.log(`[aamp result] help-needed task=${result.taskId}`)
        return
      }

      await this.commentTaskResultOnce(result.taskId, flushedTaskState, disposition)
      await this.completeFeishuTasksOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)

      const latestTaskState = this.state.tasks[result.taskId] ?? flushedTaskState
      const resultHandledTaskIds = new Set(latestTaskState.resultHandledTaskIds ?? [])
      resultHandledTaskIds.add(result.taskId)
      this.state.tasks[result.taskId] = {
        ...latestTaskState,
        status: disposition.kind === 'success' ? 'completed' : 'failed',
        resultHandledTaskIds: [...resultHandledTaskIds],
        ...(disposition.kind === 'failure' ? { lastError: disposition.message } : { lastError: undefined }),
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      this.logger.log(`[aamp result] closed task=${result.taskId} status=${disposition.kind}`)
    } finally {
      this.resultInFlight.delete(result.taskId)
    }
  }

  private async commentHelpNeededOnce(aampTaskId: string, taskState: BridgeTaskState, message: string): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.resultCommentedTaskIds ?? []).includes(aampTaskId)) {
      this.logger.log(`[aamp result ${aampTaskId}] result comment already recorded`)
      return
    }

    const comment = [
      '智能体需要更多信息才能继续处理该任务。',
      '',
      message,
    ].join('\n')
    this.debugLog(`[aamp result ${aampTaskId}] commenting help-needed on Feishu task ${latestTaskState.taskGuid}`)
    await this.feishu.commentTask(latestTaskState.taskGuid, comment)

    const resultCommentedTaskIds = new Set(latestTaskState.resultCommentedTaskIds ?? [])
    resultCommentedTaskIds.add(aampTaskId)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      resultCommentedTaskIds: [...resultCommentedTaskIds],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[aamp result ${aampTaskId}] commented help-needed on Feishu task ${latestTaskState.taskGuid}`)
  }

  private async commentTaskResultOnce(
    aampTaskId: string,
    taskState: BridgeTaskState,
    disposition: Extract<TaskResultDisposition, { kind: 'success' | 'failure' }>,
  ): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.resultCommentedTaskIds ?? []).includes(aampTaskId)) {
      this.logger.log(`[aamp result ${aampTaskId}] result comment already recorded`)
      return
    }

    const comment = disposition.kind === 'success'
      ? [
          disposition.summary,
          ...(disposition.deliverableSummary ? ['', `交付物：${disposition.deliverableSummary}`] : []),
        ].join('\n')
      : [
          ...(disposition.summary ? [disposition.summary, ''] : []),
          `失败原因：${disposition.message}`,
        ].join('\n')

    this.debugLog(`[aamp result ${aampTaskId}] commenting result on Feishu task ${latestTaskState.taskGuid}`)
    await this.feishu.commentTask(latestTaskState.taskGuid, comment)

    const resultCommentedTaskIds = new Set(latestTaskState.resultCommentedTaskIds ?? [])
    resultCommentedTaskIds.add(aampTaskId)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      resultCommentedTaskIds: [...resultCommentedTaskIds],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[aamp result ${aampTaskId}] commented result on Feishu task ${latestTaskState.taskGuid}`)
  }

  private async completeFeishuTasksOnce(aampTaskId: string, taskState: BridgeTaskState): Promise<void> {
    const taskGuids = [...new Set([...(taskState.childTaskGuids ?? []), taskState.taskGuid])]
    for (const taskGuid of taskGuids) {
      await this.completeFeishuTaskOnce(aampTaskId, taskState, taskGuid)
    }
  }

  private async completeFeishuTaskOnce(aampTaskId: string, taskState: BridgeTaskState, taskGuid: string): Promise<void> {
    const inFlightKey = `${aampTaskId}:${taskGuid}`
    if (this.feishuCompleteInFlight.has(inFlightKey)) return
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.feishuCompletedTaskIds ?? []).includes(taskGuid)) {
      this.logger.log(`[feishu task ${taskGuid}] completion already recorded for ${aampTaskId}`)
      return
    }

    this.feishuCompleteInFlight.add(inFlightKey)
    try {
      this.debugLog(`[feishu task ${taskGuid}] completing for ${aampTaskId}`)
      await this.feishu.completeTask(taskGuid)

      const feishuCompletedTaskIds = new Set(latestTaskState.feishuCompletedTaskIds ?? [])
      feishuCompletedTaskIds.add(taskGuid)
      this.state.tasks[aampTaskId] = {
        ...latestTaskState,
        feishuCompletedTaskIds: [...feishuCompletedTaskIds],
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      this.logger.log(`[feishu task] completed task=${taskGuid}`)
      this.debugLog(`[feishu task ${taskGuid}] completed for ${aampTaskId}`)
    } finally {
      this.feishuCompleteInFlight.delete(inFlightKey)
    }
  }

  private async markFeishuTaskBlockedOnce(aampTaskId: string, taskState: BridgeTaskState): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    const taskGuid = latestTaskState.taskGuid
    const inFlightKey = `${aampTaskId}:${taskGuid}`
    if (this.feishuBlockInFlight.has(inFlightKey)) return
    if ((latestTaskState.feishuBlockedTaskIds ?? []).includes(taskGuid)) {
      this.logger.log(`[feishu task ${taskGuid}] blocked state already recorded for ${aampTaskId}`)
      return
    }

    this.feishuBlockInFlight.add(inFlightKey)
    try {
      this.debugLog(`[feishu task ${taskGuid}] marking blocked for ${aampTaskId}`)
      await this.feishu.markTaskWaitingForHuman(taskGuid)

      const feishuBlockedTaskIds = new Set(latestTaskState.feishuBlockedTaskIds ?? [])
      feishuBlockedTaskIds.add(taskGuid)
      this.state.tasks[aampTaskId] = {
        ...latestTaskState,
        feishuBlockedTaskIds: [...feishuBlockedTaskIds],
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      this.logger.log(`[feishu task] blocked task=${taskGuid}`)
      this.debugLog(`[feishu task ${taskGuid}] marked blocked for ${aampTaskId}`)
    } finally {
      this.feishuBlockInFlight.delete(inFlightKey)
    }
  }

  private rememberEvent(event: FeishuTaskEvent): boolean {
    if (this.state.dedupEventIds[event.eventId]) return false
    this.state.dedupEventIds[event.eventId] = new Date().toISOString()
    this.pruneDedupEvents()
    return true
  }

  private pruneDedupEvents(): void {
    const entries = Object.entries(this.state.dedupEventIds)
    if (entries.length <= 1000) return
    entries
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, entries.length - 1000)
      .forEach(([eventId]) => {
        delete this.state.dedupEventIds[eventId]
      })
  }

  private setConnectivity(kind: ConnectivityKind, value: BridgeState['connectivity'][ConnectivityKind]): void {
    this.state.connectivity[kind] = value
  }

  private debugLog(message: string): void {
    if (this.config.behavior.debug) this.logger.log(message)
  }

  private async persistState(): Promise<void> {
    await saveBridgeState(this.state, this.configDir)
  }
}
