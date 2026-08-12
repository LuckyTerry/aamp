import { randomUUID } from 'node:crypto'
import {
  methods,
  type AgentContext,
  type CloseSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PermissionOptionKind,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SessionUpdate,
  type Usage,
} from '@agentclientprotocol/sdk'
import {
  createZcodeEventTranslator,
  type ZCodeEventTranslator,
} from './event-translator.js'
import {
  type ZCodeInboundRequestContext,
} from './rpc-client.js'
import {
  assertZcodeProtocolV1,
  type ZCodeNotification,
} from './protocol.js'
import {
  decodeModelRef,
  inferToolKind,
  replaySnapshot,
  rewriteZcodeError,
  summarizePermissionInput,
  toAcpConfigOptions,
  toAcpModes,
  toAcpSessionInfo,
  toZcodeMcpServers,
  toZcodePrompt,
  toZcodeWorkspace,
  ZCodeValidationError,
} from './translator.js'

export interface ZCodeBackend {
  request<Result>(method: string, params: unknown, timeoutMs?: number): Promise<Result>
  notify(method: string, params: unknown): Promise<void>
  onNotification(listener: (notification: ZCodeNotification) => void): () => void
  onRequest(listener: (request: ZCodeInboundRequestContext) => void | Promise<void>): () => void
  onClose(listener: (error: Error) => void): () => void
  close(): Promise<void>
}

export interface ZCodeAcpRuntimeOptions {
  backend: ZCodeBackend
  cliPath: string
  cliVersion: string
  requestTimeoutMs?: number
}

interface ActivePrompt {
  inputId: string
  queryId: string
  accepted: Promise<void>
  markAccepted: () => void
  settled: boolean
  stopRequested: boolean
  promise: Promise<PromptResponse>
  resolve: (response: PromptResponse) => void
  reject: (error: Error) => void
}

interface RuntimeSession {
  sessionId: string
  cwd: string
  snapshot: Record<string, unknown>
  translator: ZCodeEventTranslator
  eventFloor: number
  replaying: boolean
  bufferedEvents: Array<Record<string, unknown>>
  eventQueue: Promise<void>
  activePrompt?: ActivePrompt
}

interface SubscriptionResult {
  eventSeq?: number
  events?: unknown[]
  snapshot?: unknown
}

interface MessagesResult {
  messages?: unknown[]
}

interface ZCodePermissionOption {
  optionId: string
  kind: string
  acpKind: PermissionOptionKind
  name: string
  response: unknown
}

class PermissionTimeoutError extends Error {
  override readonly name = 'PermissionTimeoutError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function snapshotRevision(snapshot: Record<string, unknown>): number | undefined {
  const runtime = isRecord(snapshot.runtime) ? snapshot.runtime : {}
  const session = isRecord(snapshot.session) ? snapshot.session : {}
  return numberValue(runtime.stateRevision)
    ?? numberValue(snapshot.stateRevision)
    ?? numberValue(snapshot.revision)
    ?? numberValue(session.revision)
}

function parsePermissionOption(value: unknown): ZCodePermissionOption {
  if (!isRecord(value)) {
    throw new ZCodeValidationError('Invalid ZCode permission option')
  }
  const optionId = nonEmptyString(value.optionId)
  const kind = nonEmptyString(value.kind)
  const name = nonEmptyString(value.name)
  if (!optionId || !kind || !name || !('response' in value)) {
    throw new ZCodeValidationError('Invalid ZCode permission option')
  }
  return {
    optionId,
    kind,
    acpKind: toAcpPermissionKind(kind, value.response),
    name,
    response: value.response,
  }
}

function toAcpPermissionKind(
  kind: string,
  response: unknown,
): PermissionOptionKind {
  switch (kind) {
    case 'allowOnce':
    case 'allow_once':
      return 'allow_once'
    case 'allowAlways':
    case 'allow_always':
      return 'allow_always'
    case 'deny':
    case 'reject_once':
      return 'reject_once'
    case 'reject_always':
      return 'reject_always'
    case 'custom': {
      const decision = isRecord(response) ? nonEmptyString(response.decision) : undefined
      return decision === 'deny' || decision === 'escalate'
        ? 'reject_once'
        : 'allow_once'
    }
    default:
      throw new ZCodeValidationError(
        `Unsupported ZCode permission option kind: ${kind}`,
      )
  }
}

function toAcpPermissionOption(option: ZCodePermissionOption): PermissionOption {
  return {
    optionId: option.optionId,
    kind: option.acpKind,
    name: option.name,
  }
}

function withTimeout<Result>(
  promise: Promise<Result>,
  timeoutMs: number,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PermissionTimeoutError(
        `ACP permission request timed out after ${timeoutMs}ms`,
      ))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function snapshotFrom(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid ZCode session response')
  return isRecord(value.snapshot) ? value.snapshot : value
}

function sessionIdFrom(value: unknown): string {
  if (!isRecord(value)) throw new Error('Invalid ZCode session response')
  const session = isRecord(value.session) ? value.session : {}
  const sessionId = nonEmptyString(value.sessionId)
    ?? nonEmptyString(session.sessionId)
    ?? nonEmptyString(session.id)
  if (!sessionId) throw new Error('ZCode session response is missing a session ID')
  return sessionId
}

function createActivePrompt(inputId: string, queryId: string): ActivePrompt {
  let resolve!: (response: PromptResponse) => void
  let reject!: (error: Error) => void
  let markAccepted!: () => void
  const promise = new Promise<PromptResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  const accepted = new Promise<void>((resolveAccepted) => {
    markAccepted = resolveAccepted
  })
  return {
    inputId,
    queryId,
    accepted,
    markAccepted,
    settled: false,
    stopRequested: false,
    promise,
    resolve,
    reject,
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref()
    promise.then(finish, finish)
  })
}

function mapUsage(value: unknown): {
  usage?: Usage
  update?: { used: number; size: number }
} {
  if (!isRecord(value)) return {}
  const inputTokens = numberValue(value.inputTokens)
  const outputTokens = numberValue(value.outputTokens)
  const totalTokens = numberValue(value.totalTokens)
    ?? (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined)
  const usage = totalTokens !== undefined
    && inputTokens !== undefined
    && outputTokens !== undefined
    ? {
        totalTokens,
        inputTokens,
        outputTokens,
        ...(numberValue(value.thoughtTokens) !== undefined
          ? { thoughtTokens: numberValue(value.thoughtTokens) }
          : {}),
        ...(numberValue(value.cachedReadTokens) !== undefined
          ? { cachedReadTokens: numberValue(value.cachedReadTokens) }
          : {}),
        ...(numberValue(value.cachedWriteTokens) !== undefined
          ? { cachedWriteTokens: numberValue(value.cachedWriteTokens) }
          : {}),
      }
    : undefined
  const used = numberValue(value.used) ?? totalTokens
  const size = numberValue(value.size)
    ?? numberValue(value.contextWindowSize)
    ?? numberValue(value.contextSize)
  return {
    ...(usage ? { usage } : {}),
    ...(used !== undefined && size !== undefined
      ? { update: { used, size } }
      : {}),
  }
}

export class ZCodeAcpRuntime {
  private readonly backend: ZCodeBackend
  private readonly cliPath: string
  private readonly cliVersion: string
  private readonly requestTimeoutMs?: number
  private readonly sessions = new Map<string, RuntimeSession>()
  private client?: AgentContext
  private closed = false
  private backendFailure?: Error
  private readonly unsubscribeNotification: () => void
  private readonly unsubscribeRequest: () => void
  private readonly unsubscribeClose: () => void

  constructor(options: ZCodeAcpRuntimeOptions) {
    this.backend = options.backend
    this.cliPath = options.cliPath
    this.cliVersion = options.cliVersion
    this.requestTimeoutMs = options.requestTimeoutMs
    this.unsubscribeNotification = this.backend.onNotification(
      (notification) => this.handleNotification(notification),
    )
    this.unsubscribeRequest = this.backend.onRequest(
      (request) => this.handleInboundRequest(request),
    )
    this.unsubscribeClose = this.backend.onClose(
      (error) => this.handleBackendClose(error),
    )
  }

  attachClient(client: AgentContext): void {
    this.client = client
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.requireClient()
    const workspace = toZcodeWorkspace(params.cwd, params.additionalDirectories)
    const mcpServers = toZcodeMcpServers(params.mcpServers)
    const created = await this.backendRequest<unknown>('session/create', {
      workspace,
      mcpServers,
      persistence: 'immediate',
    })
    const snapshot = snapshotFrom(created)
    assertZcodeProtocolV1(snapshot, this.cliVersion)
    const sessionId = sessionIdFrom(created)
    const state = this.createSessionState(sessionId, params.cwd, snapshot)
    this.sessions.set(sessionId, state)

    try {
      await this.subscribe(state)
      await this.finishReplay(state)
      return {
        sessionId,
        modes: toAcpModes(state.snapshot),
        configOptions: toAcpConfigOptions(state.snapshot),
      }
    } catch (error) {
      this.sessions.delete(sessionId)
      await this.bestEffortBackendRequest('session/close', { sessionId })
      throw error
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const state = await this.resumeAndSubscribe(
      params.sessionId,
      params.cwd,
      params.additionalDirectories,
      params.mcpServers,
    )
    await this.replayMessages(state)
    await this.finishReplay(state)
    return {
      modes: toAcpModes(state.snapshot),
      configOptions: toAcpConfigOptions(state.snapshot),
    }
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const state = await this.resumeAndSubscribe(
      params.sessionId,
      params.cwd,
      params.additionalDirectories,
      params.mcpServers ?? [],
    )
    await this.finishReplay(state)
    return {
      modes: toAcpModes(state.snapshot),
      configOptions: toAcpConfigOptions(state.snapshot),
    }
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.requireClient()
    if (params.cursor) {
      throw new ZCodeValidationError(
        'ZCode session/list does not support an ACP cursor',
      )
    }
    const workspace = params.cwd
      ? toZcodeWorkspace(params.cwd)
      : undefined
    const response = await this.backendRequest<unknown>('session/list', {
      ...(workspace ? { workspace } : {}),
      includeArchived: false,
      limit: 100,
    })
    if (!isRecord(response) || !Array.isArray(response.sessions)) {
      throw new Error('Invalid ZCode session/list response')
    }
    const nextCursor = nonEmptyString(response.nextCursor)
    return {
      sessions: response.sessions.map(toAcpSessionInfo),
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  async closeSession(params: CloseSessionRequest): Promise<Record<string, never>> {
    this.requireClient()
    const state = this.sessions.get(params.sessionId)
    if (state?.activePrompt && !state.activePrompt.settled) {
      await this.stopActivePromptBestEffort(state)
      this.rejectActivePrompt(
        state,
        new Error(`ZCode session ${params.sessionId} closed`),
      )
    }
    await this.backendRequest('session/close', { sessionId: params.sessionId })
    this.sessions.delete(params.sessionId)
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.requireClient()
    const state = this.sessions.get(params.sessionId)
    if (!state) {
      throw new ZCodeValidationError(
        `Unknown ZCode session: ${params.sessionId}`,
      )
    }
    if (state.activePrompt && !state.activePrompt.settled) {
      throw new ZCodeValidationError(
        `ZCode session ${params.sessionId} already has an active prompt`,
      )
    }

    const content = toZcodePrompt(params.prompt)
    const inputId = `acp-input-${randomUUID()}`
    const queryId = `acp-query-${randomUUID()}`
    const active = createActivePrompt(inputId, queryId)
    state.activePrompt = active
    try {
      await this.backendRequest<unknown>('session/send', {
        sessionId: params.sessionId,
        inputId,
        queryId,
        content,
      })
    } catch (error) {
      state.activePrompt = undefined
      throw error
    } finally {
      active.markAccepted()
    }
    return await active.promise
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state?.activePrompt || state.activePrompt.settled
      || state.activePrompt.stopRequested) return
    const active = state.activePrompt
    active.stopRequested = true
    try {
      await this.backendRequest('session/stop', { sessionId })
    } catch (error) {
      if (!active.settled) active.stopRequested = false
      throw error
    }
  }

  async setMode(params: SetSessionModeRequest): Promise<Record<string, never>> {
    const state = this.requireSession(params.sessionId)
    const modes = toAcpModes(state.snapshot)
    if (!modes.availableModes.some((mode) => mode.id === params.modeId)) {
      throw new ZCodeValidationError(`Unknown ZCode mode: ${params.modeId}`)
    }
    const expectedRevision = snapshotRevision(state.snapshot)
    const response = await this.backendRequest<unknown>('session/setMode', {
      sessionId: params.sessionId,
      mode: params.modeId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    const snapshot = snapshotFrom(response)
    assertZcodeProtocolV1(snapshot, this.cliVersion)
    const confirmedMode = toAcpModes(snapshot).currentModeId
    if (confirmedMode !== params.modeId) {
      throw new Error(
        `ZCode confirmed mode ${confirmedMode}, expected ${params.modeId}`,
      )
    }
    state.snapshot = snapshot
    await this.notifyUpdate(params.sessionId, {
      sessionUpdate: 'current_mode_update',
      currentModeId: confirmedMode,
    })
    return {}
  }

  async setConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const state = this.requireSession(params.sessionId)
    if (params.configId !== 'model') {
      throw new ZCodeValidationError(
        `Unknown ZCode config option: ${params.configId}`,
      )
    }
    if (typeof params.value !== 'string') {
      throw new ZCodeValidationError('ZCode model must be a model option ID')
    }
    const currentOptions = toAcpConfigOptions(state.snapshot)
    const modelOption = currentOptions.find((option) => option.id === 'model')
    if (!modelOption || modelOption.type !== 'select'
      || !modelOption.options.some((option) =>
        'value' in option && option.value === params.value)) {
      throw new ZCodeValidationError(`Unknown ZCode model: ${params.value}`)
    }

    const model = decodeModelRef(params.value)
    const expectedRevision = snapshotRevision(state.snapshot)
    const response = await this.backendRequest<unknown>('session/setModel', {
      sessionId: params.sessionId,
      model,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    const snapshot = snapshotFrom(response)
    assertZcodeProtocolV1(snapshot, this.cliVersion)
    const configOptions = toAcpConfigOptions(snapshot)
    const confirmedModel = configOptions.find((option) => option.id === 'model')
    if (!confirmedModel || confirmedModel.type !== 'select'
      || confirmedModel.currentValue !== params.value) {
      throw new Error(`ZCode did not confirm model ${params.value}`)
    }
    state.snapshot = snapshot
    await this.notifyUpdate(params.sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions,
    })
    return { configOptions }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = new Error('ZCode ACP runtime closed')
    const states = [...this.sessions.values()]
    await Promise.all(states.map((state) => this.stopActivePromptBestEffort(state)))
    for (const state of states) {
      this.rejectActivePrompt(state, error)
    }
    this.sessions.clear()
    this.unsubscribeNotification()
    this.unsubscribeRequest()
    this.unsubscribeClose()
    await this.backend.close()
  }

  private async resumeAndSubscribe(
    sessionId: string,
    cwd: string,
    additionalDirectories: string[] | undefined,
    mcpServers: McpServer[],
  ): Promise<RuntimeSession> {
    this.requireClient()
    const workspace = toZcodeWorkspace(cwd, additionalDirectories)
    const resumed = await this.backendRequest<unknown>('session/resume', {
      sessionId,
      workspace,
      mcpServers: toZcodeMcpServers(mcpServers),
    })
    const snapshot = snapshotFrom(resumed)
    assertZcodeProtocolV1(snapshot, this.cliVersion)
    const returnedSessionId = sessionIdFrom(resumed)
    if (returnedSessionId !== sessionId) {
      throw new Error(
        `ZCode resumed session ${returnedSessionId}, expected ${sessionId}`,
      )
    }
    const state = this.createSessionState(sessionId, cwd, snapshot)
    this.sessions.set(sessionId, state)
    try {
      await this.subscribe(state)
      return state
    } catch (error) {
      this.sessions.delete(sessionId)
      throw error
    }
  }

  private createSessionState(
    sessionId: string,
    cwd: string,
    snapshot: Record<string, unknown>,
  ): RuntimeSession {
    return {
      sessionId,
      cwd,
      snapshot,
      translator: createZcodeEventTranslator(sessionId),
      eventFloor: 0,
      replaying: true,
      bufferedEvents: [],
      eventQueue: Promise.resolve(),
    }
  }

  private async subscribe(state: RuntimeSession): Promise<void> {
    const response = await this.backendRequest<SubscriptionResult>(
      'session/subscribe',
      {
        sessionId: state.sessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: true,
      },
    )
    state.eventFloor = numberValue(response.eventSeq) ?? 0
    if (response.snapshot !== undefined) {
      const subscribedSnapshot = snapshotFrom(response.snapshot)
      assertZcodeProtocolV1(subscribedSnapshot, this.cliVersion)
      state.snapshot = subscribedSnapshot
    }
    if (Array.isArray(response.events)) {
      for (const event of response.events) {
        if (isRecord(event)) state.bufferedEvents.push(event)
      }
    }
  }

  private async replayMessages(state: RuntimeSession): Promise<void> {
    const response = await this.backendRequest<MessagesResult>(
      'session/messages',
      { sessionId: state.sessionId },
    )
    const messages = response.messages ?? []
    if (!Array.isArray(messages)) {
      throw new Error('Invalid ZCode session/messages response')
    }
    for (const update of replaySnapshot({ messages })) {
      await this.notifyUpdate(state.sessionId, update)
    }
  }

  private async finishReplay(state: RuntimeSession): Promise<void> {
    while (state.bufferedEvents.length > 0) {
      const events = state.bufferedEvents
        .splice(0)
        .sort((left, right) => (numberValue(left.seq) ?? 0) - (numberValue(right.seq) ?? 0))
      for (const event of events) {
        await this.processEvent(state, event)
      }
    }
    state.replaying = false
    await state.eventQueue
  }

  private handleNotification(notification: ZCodeNotification): void {
    if (notification.method !== 'session/event' || !isRecord(notification.params)) return
    const sessionId = nonEmptyString(notification.params.sessionId)
    if (!sessionId) return
    const state = this.sessions.get(sessionId)
    if (!state) return

    if (state.replaying) {
      state.bufferedEvents.push(notification.params)
      return
    }
    state.eventQueue = state.eventQueue
      .then(() => this.processEvent(state, notification.params as Record<string, unknown>))
      .catch((error: Error) => this.rejectActivePrompt(state, error))
  }

  private async processEvent(
    state: RuntimeSession,
    event: Record<string, unknown>,
  ): Promise<void> {
    const seq = numberValue(event.seq)
    if (seq !== undefined && seq <= state.eventFloor) return
    const payload = isRecord(event.payload) ? event.payload : {}
    const eventInputId = nonEmptyString(payload.inputId)
    const eventQueryId = nonEmptyString(payload.queryId)
    const turnEvent = event.type === 'turn.completed' || event.type === 'turn.failed'
    const active = state.activePrompt
    if (turnEvent && active) {
      await active.accepted
      if (state.activePrompt !== active) return
    }
    const promptMatches = !state.activePrompt || (
      (eventInputId !== undefined && state.activePrompt.inputId === eventInputId)
      || (eventQueryId !== undefined && state.activePrompt.queryId === eventQueryId)
    )
    if (turnEvent && !promptMatches) {
      if (seq !== undefined) state.eventFloor = Math.max(state.eventFloor, seq)
      return
    }

    const translation = state.translator.translate(event)
    if (seq !== undefined) state.eventFloor = Math.max(state.eventFloor, seq)
    for (const update of translation.updates) {
      await this.notifyUpdate(state.sessionId, update)
    }
    if (translation.failure) {
      this.rejectActivePrompt(
        state,
        rewriteZcodeError(translation.failure, this.cliPath),
      )
      return
    }
    if (translation.completion) {
      await this.completeActivePrompt(
        state,
        translation.completion.stopReason,
      )
    }
  }

  private async completeActivePrompt(
    state: RuntimeSession,
    stopReason: PromptResponse['stopReason'],
  ): Promise<void> {
    const active = state.activePrompt
    if (!active || active.settled) return

    let usage: Usage | undefined
    try {
      const response = await this.backendRequest<unknown>(
        'session/usage',
        { sessionId: state.sessionId },
      )
      const mapped = mapUsage(response)
      usage = mapped.usage
      if (mapped.update) {
        await this.notifyUpdate(state.sessionId, {
          sessionUpdate: 'usage_update',
          ...mapped.update,
        })
      }
    } catch {
      // Usage is supplemental; turn completion remains authoritative.
    }

    if (active.settled) return
    active.settled = true
    state.activePrompt = undefined
    active.resolve({
      stopReason,
      ...(usage ? { usage } : {}),
    })
  }

  private rejectActivePrompt(state: RuntimeSession, error: Error): void {
    const active = state.activePrompt
    if (!active || active.settled) return
    active.settled = true
    state.activePrompt = undefined
    active.reject(error)
  }

  private async notifyUpdate(
    sessionId: string,
    update: SessionUpdate,
  ): Promise<void> {
    const client = this.requireClient()
    await client.notify(methods.client.session.update, {
      sessionId,
      update,
    })
  }

  private async handleInboundRequest(
    request: ZCodeInboundRequestContext,
  ): Promise<void> {
    if (request.method === 'session/requestRuntimePreferences') {
      await request.respond({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      })
      return
    }
    if (request.method === 'interaction/requestPermission') {
      await this.handlePermissionRequest(request)
      return
    }
    await request.reject({
      code: -32601,
      message: `No handler for ZCode request ${request.method}`,
    })
  }

  private async handlePermissionRequest(
    request: ZCodeInboundRequestContext,
  ): Promise<void> {
    if (!isRecord(request.params)) {
      await request.reject({
        code: -32602,
        message: 'Invalid ZCode permission request',
      })
      return
    }
    const params = request.params
    const sessionId = nonEmptyString(params.sessionId)
    const toolCallId = nonEmptyString(params.toolCallId)
    const toolName = nonEmptyString(params.toolName)
    const reason = nonEmptyString(params.reason)
    if (!sessionId || !toolCallId || !toolName || !Array.isArray(params.options)
      || params.options.length === 0) {
      await request.reject({
        code: -32602,
        message: 'Invalid ZCode permission request',
      })
      return
    }
    if (!this.sessions.has(sessionId)) {
      await request.reject({
        code: -32602,
        message: `Unknown ZCode permission session: ${sessionId}`,
      })
      return
    }

    let options: ZCodePermissionOption[]
    try {
      options = params.options.map(parsePermissionOption)
    } catch (error) {
      await request.reject({
        code: -32602,
        message: error instanceof Error
          ? error.message
          : 'Invalid ZCode permission option',
      })
      return
    }

    let response: RequestPermissionResponse
    try {
      const client = this.requireClient()
      response = await withTimeout(
        client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId,
            title: reason ?? toolName,
            kind: inferToolKind(toolName),
            status: 'pending',
            content: [{
              type: 'content',
              content: {
                type: 'text',
                text: summarizePermissionInput(params.input),
              },
            }],
          },
          options: options.map(toAcpPermissionOption),
        }),
        this.requestTimeoutMs ?? 30_000,
      )
    } catch (error) {
      await request.respond({
        decision: 'deny',
        reason: error instanceof PermissionTimeoutError
          ? error.message
          : 'ACP permission request failed',
      })
      return
    }

    const outcome = response.outcome
    if (outcome.outcome === 'cancelled') {
      await request.respond({
        decision: 'deny',
        reason: 'ACP permission request cancelled',
      })
      return
    }
    const selected = options.find(
      (option) => option.optionId === outcome.optionId,
    )
    if (!selected) {
      await request.respond({
        decision: 'deny',
        reason: `Unknown ACP permission option: ${outcome.optionId}`,
      })
      return
    }
    await request.respond(selected.response)
  }

  private handleBackendClose(error: Error): void {
    if (this.closed) return
    this.backendFailure = error
    for (const state of this.sessions.values()) {
      this.rejectActivePrompt(state, error)
    }
  }

  private async stopActivePromptBestEffort(state: RuntimeSession): Promise<void> {
    const active = state.activePrompt
    if (!active || active.settled || active.stopRequested) return
    active.stopRequested = true
    await this.bestEffortBackendRequest('session/stop', {
      sessionId: state.sessionId,
    })
  }

  private async bestEffortBackendRequest(
    method: string,
    params: unknown,
  ): Promise<void> {
    const timeoutMs = Math.min(this.requestTimeoutMs ?? 1_000, 1_000)
    const request = this.backend.request(method, params, timeoutMs)
    await settleWithin(request, timeoutMs)
  }

  private requireSession(sessionId: string): RuntimeSession {
    this.requireClient()
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new ZCodeValidationError(`Unknown ZCode session: ${sessionId}`)
    }
    return state
  }

  private requireClient(): AgentContext {
    if (this.closed) throw new Error('ZCode ACP runtime is closed')
    if (this.backendFailure) throw this.backendFailure
    if (!this.client) throw new Error('ACP client is not attached')
    return this.client
  }

  private async backendRequest<Result>(
    method: string,
    params: unknown,
  ): Promise<Result> {
    this.requireClient()
    try {
      return await this.backend.request<Result>(
        method,
        params,
        this.requestTimeoutMs,
      )
    } catch (error) {
      throw rewriteZcodeError(error, this.cliPath)
    }
  }
}
