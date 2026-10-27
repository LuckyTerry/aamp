import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type {
  AampStreamEvent,
  SendTaskOptions,
  StreamSubscription,
  TaskAck,
  TaskHelp,
  TaskResult,
  TaskStreamOpened,
} from 'aamp-sdk'
import {
  classifyFeishuTaskResult,
  FeishuTaskBridgeRuntime,
  sanitizeTaskVisibleFailureReason,
} from './runtime.js'
import type { ControlledTaskFeedbackTransport, ReportAgentTaskCommandResultBody, ReportAgentTaskExecutionStateBody } from './controlled-feedback.js'
import { normalizeFeishuTaskEvent, OapiFeishuTaskClient } from './feishu.js'
import { createDefaultBridgeState, loadBridgeState, saveBridgeState } from './config.js'
import type {
  BridgeConfig,
  FeishuDownloadedAttachment,
  FeishuTaskAttachment,
  FeishuTaskClient,
  FeishuTaskComment,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskStepInput,
  FeishuTaskWriteContext,
} from './types.js'

type AckHandler = (ack: TaskAck) => void
type HelpHandler = (help: TaskHelp) => void
type ResultHandler = (result: TaskResult) => void
type StreamOpenedHandler = (stream: TaskStreamOpened) => void
type ErrorHandler = (error: Error) => void

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (lastError) throw lastError
  assertion()
}

class FakeAampClient {
  ackHandler?: AckHandler
  helpHandler?: HelpHandler
  resultHandler?: ResultHandler
  streamOpenedHandler?: StreamOpenedHandler
  errorHandler?: ErrorHandler
  streamHandlers: Record<string, { onEvent: (event: AampStreamEvent) => void; onError?: (error: Error) => void }> = {}
  sentTasks: SendTaskOptions[] = []
  cancelRequests: Array<{ to: string; taskId: string; inReplyTo?: string }> = []
  sendCancelHold?: Promise<void>
  sendCancelError?: Error
  sendTaskError?: Error
  sendTaskHold?: Promise<void>

  on(event: 'connected', handler: () => void): void
  on(event: 'disconnected', handler: (reason?: string) => void): void
  on(event: 'error', handler: ErrorHandler): void
  on(event: 'task.ack', handler: AckHandler): void
  on(event: 'task.help_needed', handler: HelpHandler): void
  on(event: 'task.result', handler: ResultHandler): void
  on(event: 'task.stream.opened', handler: StreamOpenedHandler): void
  on(event: string, handler: unknown): void {
    if (event === 'task.ack') {
      this.ackHandler = handler as AckHandler
    } else if (event === 'task.help_needed') {
      this.helpHandler = handler as HelpHandler
    } else if (event === 'task.result') {
      this.resultHandler = handler as ResultHandler
    } else if (event === 'task.stream.opened') {
      this.streamOpenedHandler = handler as StreamOpenedHandler
    } else if (event === 'error') {
      this.errorHandler = handler as ErrorHandler
    }
  }

  async connect(): Promise<void> {}

  disconnect(): void {}

  async sendTask(opts: SendTaskOptions): Promise<{ taskId: string; messageId: string }> {
    if (this.sendTaskError) throw this.sendTaskError
    await this.sendTaskHold
    this.sentTasks.push(opts)
    return { taskId: opts.taskId ?? 'generated-task-id', messageId: 'aamp_message_1' }
  }

  async sendCancel(opts: { to: string; taskId: string; inReplyTo?: string }): Promise<void> {
    this.cancelRequests.push(opts)
    await this.sendCancelHold
    if (this.sendCancelError) throw this.sendCancelError
  }

  async updateDirectoryProfile(): Promise<void> {}

  async subscribeStream(
    streamId: string,
    handlers: { onEvent: (event: AampStreamEvent) => void; onError?: (error: Error) => void },
  ): Promise<StreamSubscription> {
    this.streamHandlers[streamId] = handlers
    return { close: () => {} }
  }

  emitAck(taskId: string, from = 'agent@meshmail.ai'): void {
    this.ackHandler?.({
      protocolVersion: '1.1',
      intent: 'task.ack',
      taskId,
      from,
      to: 'bridge@meshmail.ai',
    })
  }

  emitResult(taskId: string, result: Partial<TaskResult>): void {
    this.resultHandler?.({
      protocolVersion: '1.1',
      intent: 'task.result',
      taskId,
      status: result.status ?? 'completed',
      output: result.output ?? '',
      ...(result.errorMsg ? { errorMsg: result.errorMsg } : {}),
      from: 'agent@meshmail.ai',
      to: 'bridge@meshmail.ai',
    })
  }

  emitHelp(taskId: string, help: Partial<TaskHelp> = {}): void {
    this.helpHandler?.({
      protocolVersion: '1.1',
      intent: 'task.help_needed',
      taskId,
      question: help.question ?? '',
      blockedReason: help.blockedReason ?? '',
      suggestedOptions: help.suggestedOptions ?? [],
      from: help.from ?? 'agent@meshmail.ai',
      to: help.to ?? 'bridge@meshmail.ai',
      ...(help.messageId ? { messageId: help.messageId } : {}),
    })
  }

  emitStreamOpened(taskId: string, streamId = 'stream_1'): void {
    this.streamOpenedHandler?.({
      protocolVersion: '1.1',
      intent: 'task.stream.opened',
      taskId,
      streamId,
      from: 'agent@meshmail.ai',
      to: 'bridge@meshmail.ai',
    })
  }

  emitStreamEvent(streamId: string, event: Omit<AampStreamEvent, 'streamId' | 'timestamp'> & { timestamp?: string }): void {
    const handler = this.streamHandlers[streamId]
    assert.ok(handler)
    handler.onEvent({
      ...event,
      streamId,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })
  }
}

class FakeFeishuTaskClient implements FeishuTaskClient {
  eventHandler?: (event: FeishuTaskEvent) => Promise<void>
  registerAgentCalls = 0
  registerAgentError?: Error
  subscribeTaskEventsCalls = 0
  comments: Array<{ taskGuid: string; content: string }> = []
  steps: Array<{ taskGuid: string; step: FeishuTaskStepInput }> = []
  uploadedDeliveries: Array<{ taskGuid: string; filePath: string }> = []
  uploadedDeliveryContents: string[] = []
  textDeliveries: Array<{ taskGuid: string; urls: string[] }> = []
  downloadedAttachmentGuids: string[] = []
  completedTaskGuids: string[] = []
  blockedTaskGuids: string[] = []
  commentFailures = 0
  commentErrors: Error[] = []
  commentTaskHold?: Promise<void>
  completeTaskErrors: Error[] = []
  blockTaskErrors: Record<string, Error[]> = {}
  blockTaskAttempts: string[] = []
  progressWrites: Array<{ taskGuid: string; progress: string; executionId?: string }> = []
  progressErrors: Error[] = []
  progressHold?: Promise<void>
  getTaskBaseError?: Error
  getCommentError?: Error
  tasks: Record<string, FeishuTaskDetails> = {}
  appOwner = { ownerId: 'ou_human' }
  writes: Array<{ method: string; taskGuid: string; executionId?: string }> = []

  private recordWrite(method: string, taskGuid: string, context?: FeishuTaskWriteContext): void {
    this.writes.push({ method, taskGuid, executionId: context?.executionId })
  }

  async registerAgent(): Promise<void> {
    this.registerAgentCalls += 1
    if (this.registerAgentError) throw this.registerAgentError
  }

  async subscribeTaskEvents(): Promise<void> { this.subscribeTaskEventsCalls += 1 }

  registerEventHandlers(
    register: (handlers: Record<string, (data: unknown) => void>) => void,
    onEvent: (event: FeishuTaskEvent) => Promise<void>,
  ): void {
    this.eventHandler = onEvent
    register({})
  }

  async start(onEvent: (event: FeishuTaskEvent) => Promise<void>): Promise<void> {
    this.eventHandler = onEvent
  }

  async stop(): Promise<void> {}

  async getTask(taskGuid: string): Promise<FeishuTaskDetails> {
    return {
      members: [{ id: 'cli_xxx', type: 'app', role: 'assignee' }],
      ...(this.tasks[taskGuid] ?? {
      guid: taskGuid,
      taskId: 't456',
      summary: '整理上线方案',
      status: 'todo',
      }),
    }
  }

  async getTaskBase(taskGuid: string): Promise<FeishuTaskDetails> {
    if (this.getTaskBaseError) throw this.getTaskBaseError
    const task = await this.getTask(taskGuid)
    const { comments: _comments, subtasks: _subtasks, ...baseTask } = task
    return baseTask
  }

  async listSubtasks(taskGuid: string): Promise<NonNullable<FeishuTaskDetails['subtasks']>> {
    return this.tasks[taskGuid]?.subtasks ?? []
  }

  async listComments(taskGuid: string): Promise<FeishuTaskComment[]> {
    return this.tasks[taskGuid]?.comments ?? []
  }

  async getComment(_commentId: string): Promise<FeishuTaskComment | null> {
    if (this.getCommentError) throw this.getCommentError
    return null
  }

  async getAppOwner(): Promise<{ ownerId: string }> {
    return this.appOwner
  }

  async downloadAttachment(attachment: FeishuTaskAttachment): Promise<FeishuDownloadedAttachment> {
    this.downloadedAttachmentGuids.push(attachment.guid)
    return { attachment, content: Buffer.from('') }
  }

  async commentTask(taskGuid: string, content: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('commentTask', taskGuid, context)
    await this.commentTaskHold
    const error = this.commentErrors.shift()
    if (error) throw error
    if (this.commentFailures > 0) {
      this.commentFailures -= 1
      throw Object.assign(new Error('temporary comment failure'), { code: 'ECONNRESET' })
    }
    this.comments.push({ taskGuid, content })
  }

  async appendTaskStep(taskGuid: string, step: string | FeishuTaskStepInput): Promise<void> {
    this.steps.push({
      taskGuid,
      step: typeof step === 'string' ? { content: step } : step,
    })
  }

  async appendTaskSteps(taskGuid: string, steps: Array<string | FeishuTaskStepInput>, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('appendTaskSteps', taskGuid, context)
    for (const step of steps) {
      await this.appendTaskStep(taskGuid, step)
    }
  }

  async appendTextDeliveries(taskGuid: string, urls: string[], context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('appendTextDeliveries', taskGuid, context)
    this.textDeliveries.push({ taskGuid, urls })
  }

  async uploadTaskDelivery(taskGuid: string, filePath: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('uploadTaskDelivery', taskGuid, context)
    this.uploadedDeliveries.push({ taskGuid, filePath })
    this.uploadedDeliveryContents.push(await readFile(filePath, 'utf8'))
  }

  async markTaskInProgress(taskGuid: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('markTaskInProgress', taskGuid, context)
  }

  async updateTaskProgress(taskGuid: string, progress: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('updateTaskProgress', taskGuid, context)
    this.progressWrites.push({ taskGuid, progress, executionId: context?.executionId })
    await this.progressHold
    const error = this.progressErrors.shift()
    if (error) throw error
  }

  async completeTask(taskGuid: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('completeTask', taskGuid, context)
    const error = this.completeTaskErrors.shift()
    if (error) throw error
    this.completedTaskGuids.push(taskGuid)
  }

  async markTaskWaitingForHuman(taskGuid: string, context?: FeishuTaskWriteContext): Promise<void> {
    this.recordWrite('markTaskWaitingForHuman', taskGuid, context)
    this.blockTaskAttempts.push(taskGuid)
    const error = this.blockTaskErrors[taskGuid]?.shift()
    if (error) throw error
    this.blockedTaskGuids.push(taskGuid)
  }

  async emit(event: FeishuTaskEvent): Promise<void> {
    assert.ok(this.eventHandler)
    await this.eventHandler(event)
  }
}

function buildConfig(): BridgeConfig {
  return {
    version: 1,
    aampHost: 'https://meshmail.ai',
    targetAgentEmail: 'agent@meshmail.ai',
    slug: 'aamp-feishu-task-bridge',
    feishu: {
      appId: 'cli_xxx',
      appSecret: 'secret',
      userIdType: 'open_id',
      eventNames: ['task.task.updated_v1'],
    },
    mailbox: {
      email: 'bridge@meshmail.ai',
      mailboxToken: Buffer.from('bridge@meshmail.ai:password').toString('base64'),
      smtpPassword: 'password',
      baseUrl: 'https://meshmail.ai',
    },
    behavior: {
      ackComment: true,
    },
  }
}

function buildRemoteConfig(): BridgeConfig {
  return {
    ...buildConfig(),
    agent: { type: 'aime', executionLocation: 'remote' },
  }
}

test('every bridge startup refreshes registration even after a cached registration', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-agent-upgrade-'))
  const state = createDefaultBridgeState()
  state.agentRegistration = {
    appId: 'cli_xxx',
    domain: 'default',
    registeredAt: '2026-09-01T00:00:00.000Z',
  }
  await saveBridgeState(state, configDir)
  const firstFeishu = new FakeFeishuTaskClient()
  const firstFeedback = controlledFeedbackRecords()
  const firstRuntime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: new FakeAampClient(), feishuClient: firstFeishu,
    controlledFeedbackTransport: firstFeedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const secondFeishu = new FakeFeishuTaskClient()
  const secondFeedback = controlledFeedbackRecords()
  const secondRuntime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: new FakeAampClient(), feishuClient: secondFeishu,
    controlledFeedbackTransport: secondFeedback.transport,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await firstRuntime.start()
    assert.equal(firstFeishu.registerAgentCalls, 1)
    assert.equal(firstFeishu.subscribeTaskEventsCalls, 1)
    assert.equal((await loadBridgeState(configDir)).agentRegistration?.appId, 'cli_xxx')
    await firstRuntime.stop()

    await secondRuntime.start()
    assert.equal(secondFeishu.registerAgentCalls, 1)
    assert.equal(secondFeishu.subscribeTaskEventsCalls, 0)
  } finally {
    await firstRuntime.stop()
    await secondRuntime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('Task subscription business failures block startup without persisting success and allow a later retry', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-subscription-failure-'))
  const config = buildConfig()
  const logs: string[] = []
  const logger = { log: (message?: unknown) => { logs.push(String(message)) }, error: (message?: unknown) => { logs.push(String(message)) } }
  const feishu = new OapiFeishuTaskClient(config.feishu, { logger })
  let subscriptionResponse: unknown = { code: 1254301, msg: 'private subscription-test-secret' }
  let subscriptionRequests = 0
  let listenerStarted = false
  feishu.start = async () => { listenerStarted = true }
  feishu.stop = async () => {}
  ;(feishu as unknown as { client: unknown }).client = {
    domain: 'https://open.feishu.cn',
    formatPayload: async (payload: { params: unknown; data: unknown }) => ({ ...payload, headers: { Authorization: 'Bearer subscription-test-token' } }),
    httpInstance: { request: async (request: { url: string }) => {
      if (!request.url.endsWith('/task_subscription')) return { code: 0 }
      subscriptionRequests += 1
      return subscriptionResponse
    } },
  }
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir, aampClient: new FakeAampClient(), feishuClient: feishu, logger,
  })
  try {
    for (const [response, expected] of [
      [{ code: 1254301, msg: 'private subscription-test-secret' }, /API code 1254301/],
      [{ data: {} }, /missing API code/],
    ] as const) {
      subscriptionResponse = response
      await assert.rejects(runtime.start(), expected)
      assert.equal(runtime.getStateSnapshot().taskSubscription, undefined)
      assert.equal((await loadBridgeState(configDir)).taskSubscription, undefined)
      assert.equal(listenerStarted, false)
      assert.equal(logs.some((message) => message.startsWith('[feishu task subscription] subscribed ')), false)
      assert.doesNotMatch(logs.join('\n'), /private|subscription-test-secret|subscription-test-token/)
    }
    assert.equal(subscriptionRequests, 2)
    subscriptionResponse = { code: 0 }
    await runtime.start()
    assert.equal(subscriptionRequests, 3)
    assert.equal(listenerStarted, true)
    assert.equal((await loadBridgeState(configDir)).taskSubscription?.appId, 'cli_xxx')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('bridge without controlled feedback still registers on startup', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-agent-legacy-'))
  const feishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: new FakeAampClient(), feishuClient: feishu,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.equal(feishu.registerAgentCalls, 1)
    assert.equal((await loadBridgeState(configDir)).agentRegistration?.appId, 'cli_xxx')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('registration refresh failure retains a matching cached registration', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-agent-refresh-'))
  const state = createDefaultBridgeState()
  state.agentRegistration = { appId: 'cli_xxx', domain: 'default', registeredAt: '2026-09-01T00:00:00.000Z' }
  await saveBridgeState(state, configDir)
  const feishu = new FakeFeishuTaskClient()
  feishu.registerAgentError = new Error('temporary registration failure')
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: new FakeAampClient(), feishuClient: feishu,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.equal(feishu.registerAgentCalls, 1)
    assert.equal((await loadBridgeState(configDir)).agentRegistration?.appId, 'cli_xxx')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('registration failure without a matching cached identity still blocks startup', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-agent-refresh-'))
  const feishu = new FakeFeishuTaskClient()
  feishu.registerAgentError = new Error('registration denied')
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: new FakeAampClient(), feishuClient: feishu,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await assert.rejects(runtime.start(), /registration denied/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

function controlledFeedbackRecords(): {
  transport: ControlledTaskFeedbackTransport
  commands: ReportAgentTaskCommandResultBody[]
  states: ReportAgentTaskExecutionStateBody[]
} {
  const commands: ReportAgentTaskCommandResultBody[] = []
  const states: ReportAgentTaskExecutionStateBody[] = []
  return {
    commands,
    states,
    transport: {
      async reportCommandResult(body) { commands.push(body) },
      async reportExecutionState(body) { states.push(body) },
    },
  }
}

async function seedControlledExecution(configDir: string, taskGuid: string, executionId: string): Promise<string> {
  const aampTaskId = `feishu-task-${taskGuid}-${executionId}`
  const now = new Date().toISOString()
  const state = createDefaultBridgeState()
  state.tasks[aampTaskId] = {
    taskGuid,
    aampTaskId,
    executionId,
    aampMessageId: 'aamp_message_1',
    status: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }
  await saveBridgeState(state, configDir)
  return aampTaskId
}

async function controlledReplyFixture() {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-reply-'))
  const taskGuid = 'task_controlled_reply'
  const executionId = 'execution_reply'
  const rootId = await seedControlledExecution(configDir, taskGuid, executionId)
  const persisted = await loadBridgeState(configDir)
  // Reproduce successful Task BLOCKED write followed by failed feedback response: local state is stale.
  persisted.tasks[rootId]!.status = 'acknowledged'
  persisted.tasks[rootId]!.startAccepted = true
  await saveBridgeState(persisted, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const humanComment: FeishuTaskComment = { id: 'reply_comment_1', authorType: 'user', authorId: 'ou_human', content: '成都' }
  feishu.tasks[taskGuid] = { guid: taskGuid, summary: '今天天气如何', status: 'todo', agentTaskStatus: 3, comments: [humanComment] }
  feishu.getComment = async () => humanComment
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    streamStepFlushIntervalMs: 20, logger: { log: () => {}, error: () => {} },
  })
  await runtime.start()
  const event: FeishuTaskEvent = { eventId: 'evt_reply_1', taskGuid, eventTypes: ['task_comment_create'], commentId: humanComment.id }
  const childId = `feishu-task-${taskGuid}-${event.eventId}`
  return { configDir, taskGuid, executionId, rootId, childId, humanComment, aamp, feishu, feedback, runtime, event,
    cleanup: async () => { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) } }
}

test('controlled human reply reuses execution and session with a fresh AAMP task and reports progress', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    assert.equal(f.aamp.sentTasks.length, 1)
    const sent = f.aamp.sentTasks[0]!
    assert.equal(sent.taskId, f.childId)
    assert.notEqual(sent.taskId, f.rootId)
    assert.equal(sent.sessionKey, `feishu-task:${f.taskGuid}`)
    assert.equal(sent.dispatchContext?.execution_id, f.executionId)
    assert.equal(sent.dispatchContext?.sender_open_id, 'ou_human')
    assert.match(sent.bodyText ?? '', /成都/)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, f.childId)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.startAccepted, true)
    f.aamp.emitStreamOpened(f.childId, 'reply_progress')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.reply_progress))
    f.aamp.emitStreamEvent('reply_progress', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: '正在查询成都的天气' } })
    await waitFor(() => assert.deepEqual(f.feedback.states.map(({ state }) => state), [1]))
    await waitFor(() => assert.ok(f.feishu.steps.length > 0))
    assert.deepEqual(f.feishu.progressWrites, [{ taskGuid: f.taskGuid, progress: '正在执行', executionId: f.executionId }])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.reportedExecutionState, 'RUNNING')
    assert.equal(f.feedback.commands.length, 0)
    assert.ok(f.feishu.writes.every(({ executionId }) => executionId === f.executionId))
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"成都今天晴。","reply_written":false}' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'completed'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [1, 3])
    assert.ok(f.feedback.states.every(({ execution_id }) => execution_id === f.executionId))
  } finally { await f.cleanup() }
})

test('each controlled reply reports a fresh BLOCKED result without RUNNING and duplicate feedback stays deduplicated', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    assert.equal(f.feedback.states.length, 0)
    f.aamp.emitAck(f.childId)
    f.aamp.emitStreamOpened(f.childId, 'reply_ignored_start')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.reply_ignored_start))
    f.aamp.emitStreamEvent('reply_ignored_start', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: 'ACP task started' } })
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"具体是哪个日期？"}' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.reportedExecutionState, 'BLOCKED'))
    assert.deepEqual(f.feedback.states, [{ task_guid: f.taskGuid, execution_id: f.executionId, state: 2 }])
    assert.equal(f.feedback.commands.length, 0)

    const secondComment = { ...f.humanComment, id: 'reply_comment_2', content: '今天' }
    f.feishu.getComment = async () => secondComment
    await f.feishu.emit({ ...f.event, eventId: 'evt_fast_reply_2', commentId: secondComment.id })
    const secondId = `feishu-task-${f.taskGuid}-evt_fast_reply_2`
    // Late callbacks from the previous reply cannot acknowledge or finish this new reply.
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"旧回复","reply_written":false}' })
    f.aamp.emitHelp(secondId, { question: '还需要几点？' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[secondId]?.reportedExecutionState, 'BLOCKED'))
    assert.deepEqual(f.feedback.states, [
      { task_guid: f.taskGuid, execution_id: f.executionId, state: 2 },
      { task_guid: f.taskGuid, execution_id: f.executionId, state: 2 },
    ])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'help_needed')
    f.aamp.emitResult(secondId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"还需要几点？"}' })
    await waitFor(() => assert.ok(f.runtime.getStateSnapshot().tasks[secondId]?.resultHandledTaskIds?.includes(secondId)))
    assert.equal(f.feedback.states.length, 2)
  } finally { await f.cleanup() }
})

test('controlled STOP after a reply cancels the latest child and ignores late root feedback', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    f.aamp.emitStreamOpened(f.rootId, 'stale_root_stream')
    f.aamp.emitHelp(f.rootId, { question: '旧问题不能再写回' })
    f.aamp.emitResult(f.rootId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"旧答案不能再写回","reply_written":false}' })
    await f.feishu.emit({ eventId: 'evt_stop_reply', taskGuid: f.taskGuid, eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
    assert.deepEqual(f.aamp.cancelRequests.map(({ taskId }) => taskId), [f.childId])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.stopRequested, true)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.stopRequested, true)
    assert.deepEqual(f.feishu.comments, [])
    assert.equal(f.feedback.states.length, 0)
    assert.equal(f.aamp.streamHandlers.stale_root_stream, undefined)
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'comment_after_stop' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_comment_after_stop', commentId: 'comment_after_stop', action: 'START', executionId: f.executionId })
    assert.equal(f.aamp.sentTasks.length, 1)
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'controlled_task_uses_commands')
    f.aamp.emitResult(f.childId, { status: 'cancelled' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'cancelled'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [4])
    assert.equal(f.feedback.states[0]?.execution_id, f.executionId)
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'comment_after_cancel' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_comment_after_cancel', commentId: 'comment_after_cancel', action: 'START', executionId: f.executionId })
    assert.equal(f.aamp.sentTasks.length, 1)
  } finally { await f.cleanup() }
})

test('controlled reply deduplicates comments and ignores its own comments, other humans and create events', async () => {
  const f = await controlledReplyFixture()
  try {
    let getCommentCalls = 0
    let listCommentCalls = 0
    const listComments = f.feishu.listComments.bind(f.feishu)
    f.feishu.getComment = async () => {
      getCommentCalls += 1
      throw new Error('a comment event without comment_id must use listComments')
    }
    f.feishu.listComments = async (taskGuid) => {
      listCommentCalls += 1
      return listComments(taskGuid)
    }
    for (const [eventName, eventId] of [
      ['task.task.update_user_access_v2', 'evt_user_comment'],
      ['task.task.updated_v1', 'evt_app_comment_copy'],
    ]) {
      const event = normalizeFeishuTaskEvent({ event_id: eventId, task_guid: f.taskGuid,
        event_types: ['task_comment_create'] }, eventName)
      assert.ok(event)
      await f.feishu.emit(event)
    }
    assert.equal(getCommentCalls, 0)
    assert.equal(listCommentCalls, 2)
    assert.equal(f.aamp.sentTasks.length, 1)
    assert.match(f.aamp.sentTasks[0]?.bodyText ?? '', /成都/)
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'duplicate_task_event')
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'self_comment', authorType: 'app', authorId: 'cli_xxx' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_app_comment', commentId: 'self_comment' })
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_authored_by_current_app')
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'other_comment', authorId: 'ou_other' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_other_comment', commentId: 'other_comment' })
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_author_not_app_owner')
    await f.feishu.emit({ eventId: 'evt_legacy_create_reply', taskGuid: f.taskGuid, eventTypes: ['task_create'] })
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'controlled_task_uses_commands')
    assert.equal(f.aamp.sentTasks.length, 1)
  } finally { await f.cleanup() }
})

test('controlled reply is allowed only while Task is BLOCKED and a continuation has paused again', async () => {
  const f = await controlledReplyFixture()
  try {
    f.feishu.tasks[f.taskGuid]!.agentTaskStatus = 2
    await f.feishu.emit(f.event)
    assert.equal(f.aamp.sentTasks.length, 0)
    f.feishu.tasks[f.taskGuid]!.agentTaskStatus = 3
    await f.feishu.emit({ ...f.event, eventId: 'evt_blocked_reply' })
    assert.equal(f.aamp.sentTasks.length, 1)
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'reply_comment_2', content: '顺便查明天' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_parallel_reply', commentId: 'reply_comment_2' })
    assert.equal(f.aamp.sentTasks.length, 1)
  } finally { await f.cleanup() }
})

test('a later controlled reply replaces the paused child and late child results cannot finish the execution', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"具体是哪个日期？"}' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.status, 'help_needed'))
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'reply_comment_2', content: '今天' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_reply_2', commentId: 'reply_comment_2' })
    const secondId = `feishu-task-${f.taskGuid}-evt_reply_2`
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, secondId)
    assert.equal(f.aamp.sentTasks.length, 2)
    const commentCount = f.feishu.comments.length
    f.aamp.emitHelp(f.childId, { question: '旧回复又问了一遍' })
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"迟到的旧回复","reply_written":false}' })
    await f.feishu.emit({ eventId: 'evt_stop_second_reply', taskGuid: f.taskGuid, eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
    assert.deepEqual(f.aamp.cancelRequests.map(({ taskId }) => taskId), [secondId])
    assert.equal(f.feishu.comments.length, commentCount)
    assert.equal(f.feedback.states.filter(({ state }) => state === 3).length, 0)
    assert.ok(f.feishu.writes.every(({ executionId }) => executionId === f.executionId))
  } finally { await f.cleanup() }
})

test('a new controlled execution supersedes old feedback without reporting its cancellation', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit({ eventId: 'evt_replace', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_new', action: 'START', timestamp: '1792138000000' })
    const next = `feishu-task-${f.taskGuid}-execution_new`
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.supersededByExecutionId, 'execution_new')
    assert.equal(f.aamp.sentTasks[0]?.dispatchContext?.task_execution_policy, 'replace_previous')
    assert.equal(f.aamp.sentTasks[0]?.dispatchContext?.task_execution_created_at, '1792138000000')
    const writes = f.feishu.writes.length
    f.aamp.emitAck(f.rootId)
    f.aamp.emitHelp(f.rootId, { question: '旧轮问题' })
    f.aamp.emitResult(f.rootId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"旧轮结果","reply_written":false}' })
    // A same-Task command is a barrier for all callbacks enqueued above.
    await f.feishu.emit({ eventId: 'evt_replace_retry', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_new', action: 'START', timestamp: '1792138000001' })
    assert.equal(f.feishu.writes.length, writes)
    assert.deepEqual(f.feedback.states, [])
    assert.deepEqual(f.feedback.commands, [])
    await f.feishu.emit({ eventId: 'evt_old_stop', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
    assert.deepEqual(f.aamp.cancelRequests, [])
    f.aamp.emitAck(next)
    await waitFor(() => assert.equal(f.feedback.commands.length, 1))
    assert.equal((f.feedback.commands as ReportAgentTaskCommandResultBody[])[0]?.execution_id, 'execution_new')
    assert.equal(f.aamp.sentTasks.length, 1)
  } finally { await f.cleanup() }
})

test('an older, undated or same-time START cannot supersede a newer controlled execution', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit({ eventId: 'evt_current', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_current', action: 'START', timestamp: '1792138000000' })
    for (const [eventId, timestamp] of [['evt_older', '1792137999999'], ['evt_undated', undefined], ['evt_equal', '1792138000000']]) {
      await f.feishu.emit({ eventId: eventId!, taskGuid: f.taskGuid, eventTypes: ['task_agent_start'],
        executionId: `execution_${eventId}`, action: 'START', ...(timestamp ? { timestamp } : {}) })
      assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'stale_controlled_execution')
    }
    assert.equal(f.aamp.sentTasks.length, 1)
    assert.equal(f.runtime.getStateSnapshot().tasks[`feishu-task-${f.taskGuid}-execution_current`]?.supersededByExecutionId, undefined)
    await f.feishu.emit({ eventId: 'evt_later', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_later', action: 'START', timestamp: '1792138000001' })
    assert.equal(f.aamp.sentTasks.length, 2)
    assert.equal(f.runtime.getStateSnapshot().tasks[`feishu-task-${f.taskGuid}-execution_current`]?.supersededByExecutionId, 'execution_later')
  } finally { await f.cleanup() }
})

test('superseded controlled callbacks remain ignored after bridge restart', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit({ eventId: 'evt_new_round', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_new', action: 'START', timestamp: '1792138000000' })
    await f.runtime.stop()
    await f.runtime.start()
    const writes = f.feishu.writes.length
    f.aamp.emitHelp(f.rootId, { question: '重启后的旧问题' })
    f.aamp.emitResult(f.rootId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"旧结果","reply_written":false}' })
    await f.feishu.emit({ eventId: 'evt_new_round_retry', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_new', action: 'START', timestamp: '1792138000001' })
    assert.equal(f.feishu.writes.length, writes)
    assert.deepEqual(f.feedback.states, [])
  } finally { await f.cleanup() }
})

test('a new execution passes a pending old ACK and its late response cannot restore old ownership', async () => {
  const f = await controlledReplyFixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  try {
    await f.feishu.emit({ eventId: 'evt_pending_ack_start', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_pending_ack', action: 'START', timestamp: '1792138000000' })
    const oldId = `feishu-task-${f.taskGuid}-execution_pending_ack`
    const report = f.feedback.transport.reportCommandResult
    let entered = false
    f.feedback.transport.reportCommandResult = async (body) => {
      if (body.execution_id === 'execution_pending_ack') { entered = true; await pending }
      await report(body)
    }
    f.aamp.emitAck(oldId)
    await waitFor(() => assert.equal(entered, true))
    const replacement = f.feishu.emit({ eventId: 'evt_after_pending_ack', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_after_ack', action: 'START', timestamp: '1792138000001' })
    await waitFor(() => assert.equal(f.aamp.sentTasks.length, 2))
    await replacement
    release()
    await new Promise((resolve) => setImmediate(resolve))
    const old = f.runtime.getStateSnapshot().tasks[oldId]!
    assert.equal(old.supersededByExecutionId, 'execution_after_ack')
    assert.equal(old.startAccepted, undefined)
    assert.equal((await loadBridgeState(f.configDir)).tasks[oldId]?.supersededByExecutionId, 'execution_after_ack')
  } finally { release(); await f.cleanup() }
})

test('replacement interrupts an old result delivery before further outputs or terminal feedback', async () => {
  const f = await controlledReplyFixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  try {
    const comment = f.feishu.commentTask.bind(f.feishu)
    let entered = false
    f.feishu.commentTask = async (...args) => { entered = true; await pending; return await comment(...args) }
    f.aamp.emitResult(f.rootId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"旧结果","reply_written":false}' })
    await waitFor(() => assert.equal(entered, true))
    const replacement = f.feishu.emit({ eventId: 'evt_after_pending_result', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_after_result', action: 'START', timestamp: '1792138000000' })
    await waitFor(() => assert.equal(f.aamp.sentTasks.length, 1))
    await replacement
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(f.feedback.states, [])
    const old = f.runtime.getStateSnapshot().tasks[f.rootId]!
    assert.equal(old.supersededByExecutionId, 'execution_after_result')
    assert.equal(old.resultHandledTaskIds, undefined)
    assert.equal(old.resultCommentedTaskIds, undefined)
  } finally { release(); await f.cleanup() }
})

test('long-lived stream errors enter a fresh callback scope and ignore a superseded stream', async () => {
  const f = await controlledReplyFixture()
  let reportError!: (error: Error) => void
  const subscribe = f.aamp.subscribeStream.bind(f.aamp)
  f.aamp.subscribeStream = async (streamId, handlers) => {
    // These continuations inherit the stream-open callback context, as an SSE read loop does.
    let release!: (error: Error) => void
    const nextError = new Promise<Error>((resolve) => { release = resolve })
    void nextError.then((error) => handlers.onError?.(error))
    reportError = release
    return await subscribe(streamId, handlers)
  }
  try {
    f.aamp.emitStreamOpened(f.rootId, 'scope_error_stream')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.scope_error_stream))
    await new Promise((resolve) => setImmediate(resolve))
    reportError(new Error('current stream failed'))
    await waitFor(() => assert.match(f.runtime.getStateSnapshot().lastError ?? '', /current stream failed/))
    await f.feishu.emit({ eventId: 'evt_after_stream_error', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_after_stream_error', action: 'START', timestamp: '1792138000000' })
    const lastError = f.runtime.getStateSnapshot().lastError
    f.aamp.streamHandlers.scope_error_stream!.onError?.(new Error('stale stream failed'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.runtime.getStateSnapshot().lastError, lastError)
  } finally { await f.cleanup() }
})

test('a comment waiting for an old stream flush leaves the command queue available to replacement', async () => {
  const f = await controlledReplyFixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let replying: Promise<void> | undefined
  try {
    let flushing = false
    f.feishu.appendTaskSteps = async () => { flushing = true; await pending }
    f.aamp.emitStreamOpened(f.rootId, 'pending_comment_flush')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.pending_comment_flush))
    f.aamp.emitStreamEvent('pending_comment_flush', { taskId: f.rootId, seq: 1,
      type: 'text.delta', payload: { text: '旧轮待写步骤' } })
    await waitFor(() => assert.equal(flushing, true))
    replying = f.feishu.emit(f.event)
    f.feishu.tasks[f.taskGuid]!.agentTaskStatus = 0
    const replacement = f.feishu.emit({ eventId: 'evt_replace_pending_comment', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_after_comment_flush', action: 'START', timestamp: '1792138000000' })
    await waitFor(() => assert.equal(f.aamp.sentTasks[0]?.dispatchContext?.execution_id, 'execution_after_comment_flush'))
    await replacement
    release()
    await replying
    assert.equal(f.aamp.sentTasks.length, 1)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.supersededByExecutionId, 'execution_after_comment_flush')
  } finally { release(); await replying?.catch(() => {}); await f.cleanup() }
})

test('stale START does not interrupt the current callback and stop does not wait for its network forever', async () => {
  const f = await controlledReplyFixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let releaseHelp!: () => void
  const pendingHelp = new Promise<void>((resolve) => { releaseHelp = resolve })
  try {
    await f.feishu.emit({ eventId: 'evt_callback_owner', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_callback_owner', action: 'START', timestamp: '1792138000000' })
    const ownerId = `feishu-task-${f.taskGuid}-execution_callback_owner`
    let entered = false
    f.feedback.transport.reportCommandResult = async () => { entered = true; await pending }
    f.aamp.emitAck(ownerId)
    await waitFor(() => assert.equal(entered, true))
    await f.feishu.emit({ eventId: 'evt_stale_while_callback', taskGuid: f.taskGuid,
      eventTypes: ['task_agent_start'], executionId: 'execution_stale_callback', action: 'START', timestamp: '1792137999999' })
    assert.equal(f.runtime.getStateSnapshot().tasks[ownerId]?.supersededByExecutionId, undefined)
    release()
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[ownerId]?.startAccepted, true))
    let helpEntered = false
    f.feishu.commentTask = async () => { helpEntered = true; await pendingHelp }
    f.aamp.emitHelp(ownerId, { question: '等待中的旧问题' })
    await waitFor(() => assert.equal(helpEntered, true))
    let stopped = false
    const stopping = f.runtime.stop().then(() => { stopped = true })
    await waitFor(() => assert.equal(stopped, true))
    await stopping
    releaseHelp()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.runtime.getStateSnapshot().tasks[ownerId]?.helpCommentedTaskIds, undefined)
  } finally { release(); releaseHelp(); await f.cleanup() }
})

test('a finished newest controlled execution never resumes an older root or falls back to legacy comments', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit({ eventId: 'evt_start_newer', taskGuid: f.taskGuid, eventTypes: ['task_agent_start'], executionId: 'execution_newer', action: 'START' })
    const newerId = `feishu-task-${f.taskGuid}-execution_newer`
    f.aamp.emitResult(newerId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"完成","reply_written":false}' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[newerId]?.status, 'completed'))
    const dispatched = f.aamp.sentTasks.length
    // Stale Task read must not resurrect the older waiting root or dispatch an uncontrolled comment turn.
    f.feishu.tasks[f.taskGuid]!.agentTaskStatus = 3
    await f.feishu.emit({ ...f.event, executionId: 'execution_newer', action: 'START' })
    assert.equal(f.aamp.sentTasks.length, dispatched)
    assert.equal(f.runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'controlled_task_uses_commands')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, undefined)
  } finally { await f.cleanup() }
})

test('STOP queued during reply delivery cancels that reply child after dispatch finishes', async () => {
  const f = await controlledReplyFixture()
  let releaseSend!: () => void
  f.aamp.sendTaskHold = new Promise<void>((resolve) => { releaseSend = resolve })
  try {
    const reply = f.feishu.emit(f.event)
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, f.childId))
    const stop = f.feishu.emit({ eventId: 'evt_stop_during_reply', taskGuid: f.taskGuid, eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
    assert.equal(f.aamp.cancelRequests.length, 0)
    releaseSend()
    await reply
    await stop
    assert.deepEqual(f.aamp.cancelRequests.map(({ taskId }) => taskId), [f.childId])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.stopRequested, true)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.stopRequested, true)
  } finally { releaseSend(); await f.cleanup() }
})

test('a child paused by the Agent stays resumable when BLOCKED is applied but its response fails', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    f.aamp.emitStreamOpened(f.childId, 'reply_before_blocked_failure')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.reply_before_blocked_failure))
    f.aamp.emitStreamEvent('reply_before_blocked_failure', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: '查询进行中' } })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.reportedExecutionState, 'RUNNING'))
    const originalReport = f.feedback.transport.reportExecutionState
    f.feedback.transport.reportExecutionState = async (body) => {
      await originalReport(body)
      if (body.state === 2) {
        f.feishu.tasks[f.taskGuid]!.agentTaskStatus = 3
        throw new Error('BLOCKED applied but response failed')
      }
    }
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"还需要哪个日期？"}' })
    await waitFor(() => assert.ok(f.feedback.states.some(({ state }) => state === 2)))
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.status, 'help_needed')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'help_needed')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.reportedExecutionState, 'RUNNING')
    f.feishu.getComment = async () => ({ ...f.humanComment, id: 'reply_after_failed_blocked', content: '明天' })
    await f.feishu.emit({ ...f.event, eventId: 'evt_reply_after_failed_blocked', commentId: 'reply_after_failed_blocked' })
    const nextId = `feishu-task-${f.taskGuid}-evt_reply_after_failed_blocked`
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, nextId)
    assert.equal(f.runtime.getStateSnapshot().tasks[nextId]?.executionId, f.executionId)
    assert.equal(f.aamp.sentTasks.length, 2)
    assert.equal(f.feedback.states.filter(({ state }) => state === 5).length, 0)
  } finally { await f.cleanup() }
})

test('failed STOP waits for its directly running help writer before dispatching a queued reply', async () => {
  const f = await controlledReplyFixture()
  let releaseCancel!: () => void
  let releaseComment!: () => void
  f.aamp.sendCancelHold = new Promise<void>((resolve) => { releaseCancel = resolve })
  f.aamp.sendCancelError = new Error('cancel transport failed')
  f.feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
  let stopFinished = false
  try {
    const stop = f.feishu.emit({ eventId: 'evt_failed_stop_with_help', taskGuid: f.taskGuid, eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
      .then(() => { stopFinished = true })
    await waitFor(() => assert.equal(f.aamp.cancelRequests.length, 1))
    f.aamp.emitResult(f.rootId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"你想查询哪个城市？"}' })
    await waitFor(() => assert.ok(f.feishu.writes.some(({ method }) => method === 'commentTask')))
    const reply = f.feishu.emit(f.event)
    releaseCancel()
    await waitFor(() => assert.deepEqual(f.feedback.commands.map(({ action, result }) => [action, result]), [[2, 2]]))
    assert.equal(stopFinished, false)
    assert.equal(f.aamp.sentTasks.length, 0)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, undefined)
    releaseComment()
    await stop
    await reply
    assert.equal(f.aamp.sentTasks.length, 1)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, f.childId)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.executionId, f.executionId)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'dispatched')
  } finally { releaseCancel(); releaseComment(); await f.cleanup() }
})

test('controlled reply dispatch failure restores the waiting execution without START rejection', async () => {
  const f = await controlledReplyFixture()
  try {
    f.aamp.sendTaskError = new Error('mailbox unavailable')
    await assert.rejects(f.feishu.emit(f.event), /mailbox unavailable/)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.activeContinuationTaskId, undefined)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.status, 'acknowledged')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.rootId]?.executionId, f.executionId)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId], undefined)
    assert.equal(f.feedback.commands.length, 0)
    assert.equal(f.feedback.states.length, 0)
    f.aamp.sendTaskError = undefined
    await f.feishu.emit(f.event)
    assert.equal(f.aamp.sentTasks.length, 1)
  } finally { await f.cleanup() }
})

test('controlled BLOCKED ownership survives 30-day pruning and STOP after restart cancels the same execution', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-blocked-'))
  const taskGuid = 'task_controlled_blocked'
  const executionId = 'execution_1'
  const aampTaskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  const oldTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
  state.tasks[aampTaskId]!.status = 'help_needed'
  state.tasks[aampTaskId]!.reportedExecutionState = 'BLOCKED'
  state.tasks[aampTaskId]!.updatedAt = oldTimestamp
  state.tasks.legacy_help = {
    taskGuid: 'legacy_task', aampTaskId: 'legacy_help', status: 'help_needed',
    createdAt: oldTimestamp, updatedAt: oldTimestamp,
  }
  await saveBridgeState(state, configDir)

  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'help_needed')
    assert.equal(runtime.getStateSnapshot().tasks.legacy_help, undefined)

    await feishu.emit({ eventId: 'evt_stop_old_blocked', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(aamp.cancelRequests, [{ to: 'agent@meshmail.ai', taskId: aampTaskId, inReplyTo: 'aamp_message_1' }])
    assert.deepEqual(feedback.commands, [{ task_guid: taskGuid, execution_id: executionId, action: 2, result: 1 }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('STOP after a retained BLOCKED restart reports rejection when cancellation cannot be sent', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-blocked-'))
  const taskGuid = 'task_controlled_blocked_unavailable'
  const executionId = 'execution_1'
  const aampTaskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  state.tasks[aampTaskId]!.status = 'help_needed'
  state.tasks[aampTaskId]!.updatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
  await saveBridgeState(state, configDir)

  const aamp = new FakeAampClient()
  aamp.sendCancelError = new Error('AAMP cancellation unavailable')
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_old_blocked_failed', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(aamp.cancelRequests.map(({ taskId }) => taskId), [aampTaskId])
    assert.deepEqual(feedback.commands, [{ task_guid: taskGuid, execution_id: executionId, action: 2, result: 2, reason: 'AAMP cancellation unavailable' }])
    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.stopRequested, undefined)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled START dispatches once by execution ID and reports acceptance without setting RUNNING', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: aamp,
    feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    for (const eventId of ['evt_start_1', 'evt_start_retry']) {
      await feishu.emit({
        eventId,
        taskGuid: 'task_controlled_1',
        eventTypes: ['task_agent_start'],
        executionId: 'execution_1',
        action: 'START',
      })
    }
    assert.deepEqual(aamp.sentTasks.map(({ taskId }) => taskId), ['feishu-task-task_controlled_1-execution_1'])
    assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_controlled_1-execution_1']?.executionId, 'execution_1')
    assert.deepEqual(feedback.commands, [])
    aamp.emitAck('feishu-task-task_controlled_1-execution_1')
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    assert.deepEqual(feedback.commands, [
      { task_guid: 'task_controlled_1', execution_id: 'execution_1', action: 1, result: 1 },
    ])
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(feishu.writes, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled START dispatches a completed task while legacy create still ignores it', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const taskGuid = 'task_completed_restart'
  feishu.tasks[taskGuid] = { guid: taskGuid, summary: '重新执行', status: 'done', agentTaskStatus: 4 }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_done_create', taskGuid, eventTypes: ['task_create'] })
    assert.deepEqual(aamp.sentTasks, [])

    await feishu.emit({
      eventId: 'evt_done_start', taskGuid, eventTypes: ['task_agent_start'],
      executionId: 'execution_new', action: 'START',
    })
    assert.deepEqual(aamp.sentTasks.map(({ taskId }) => taskId), [`feishu-task-${taskGuid}-execution_new`])
    assert.deepEqual(feedback.commands, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled STOP cancels only its execution and does not use legacy completion writes', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: aamp,
    feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_1', taskGuid: 'task_controlled_1', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitAck('feishu-task-task_controlled_1-execution_1')
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    await feishu.emit({ eventId: 'evt_stop_other', taskGuid: 'task_controlled_1', eventTypes: ['task_agent_stop'], executionId: 'execution_other', action: 'STOP' })
    await feishu.emit({ eventId: 'evt_stop_1', taskGuid: 'task_controlled_1', eventTypes: ['task_agent_stop'], executionId: 'execution_1', action: 'STOP' })
    assert.deepEqual(aamp.cancelRequests, [{
      to: 'agent@meshmail.ai',
      taskId: 'feishu-task-task_controlled_1-execution_1',
      inReplyTo: 'aamp_message_1',
    }])
    assert.deepEqual(feedback.commands.map(({ action, result }) => [action, result]), [[1, 1], [2, 1]])
    assert.deepEqual(feishu.writes, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled STOP received first prevents a late START of the same execution', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: aamp,
    feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_first', taskGuid: 'task_controlled_1', eventTypes: ['task_agent_stop'], executionId: 'execution_1', action: 'STOP' })
    await feishu.emit({ eventId: 'evt_start_late', taskGuid: 'task_controlled_1', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    assert.deepEqual(aamp.sentTasks, [])
    assert.deepEqual(aamp.cancelRequests, [])
    assert.deepEqual(feedback.commands, [])
    assert.deepEqual(feedback.states, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('only the bridge holding an execution reports STOP across two instances', async () => {
  const ownerDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-owner-'))
  const otherDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-other-'))
  const ownerAamp = new FakeAampClient()
  const otherAamp = new FakeAampClient()
  const ownerFeishu = new FakeFeishuTaskClient()
  const otherFeishu = new FakeFeishuTaskClient()
  const ownerFeedback = controlledFeedbackRecords()
  const otherFeedback = controlledFeedbackRecords()
  const owner = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir: ownerDir, aampClient: ownerAamp, feishuClient: ownerFeishu,
    controlledFeedbackTransport: ownerFeedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const other = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir: otherDir, aampClient: otherAamp, feishuClient: otherFeishu,
    controlledFeedbackTransport: otherFeedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskGuid = 'task_controlled_two_bridges'
  const executionId = 'execution_1'
  const taskId = `feishu-task-${taskGuid}-${executionId}`
  try {
    await owner.start()
    await other.start()
    await ownerFeishu.emit({ eventId: 'evt_owner_start', taskGuid, eventTypes: ['task_agent_start'], executionId, action: 'START' })
    ownerAamp.emitAck(taskId)
    await waitFor(() => assert.equal(ownerFeedback.commands.length, 1))

    const stopEvent: FeishuTaskEvent = { eventId: 'evt_both_stop', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' }
    await otherFeishu.emit(stopEvent)
    await ownerFeishu.emit(stopEvent)
    assert.deepEqual(otherFeedback.commands, [])
    assert.deepEqual(otherFeedback.states, [])
    assert.deepEqual(otherAamp.cancelRequests, [])
    assert.deepEqual(ownerFeedback.commands.map(({ action, result }) => [action, result]), [[1, 1], [2, 1]])
    assert.deepEqual(ownerAamp.cancelRequests.map(({ taskId: cancelledTaskId }) => cancelledTaskId), [taskId])

    await ownerFeishu.emit({ ...stopEvent, eventId: 'evt_owner_stop_again' })
    assert.deepEqual(ownerFeedback.commands.map(({ action, result }) => [action, result]), [[1, 1], [2, 1], [2, 1]])
    assert.equal(ownerAamp.cancelRequests.length, 1)

    ownerAamp.emitResult(taskId, { status: 'cancelled' })
    await waitFor(() => assert.deepEqual(ownerFeedback.states.map(({ state }) => state), [4]))
    await waitFor(() => assert.equal(owner.getStateSnapshot().tasks[taskId]?.status, 'cancelled'))
    await ownerFeishu.emit({ ...stopEvent, eventId: 'evt_owner_stop_after_terminal' })
    assert.deepEqual(ownerFeedback.commands.map(({ action, result }) => [action, result]), [[1, 1], [2, 1], [2, 1]])
    assert.deepEqual(ownerFeedback.states.map(({ state }) => state), [4, 4])
    assert.equal(ownerAamp.cancelRequests.length, 1)
  } finally {
    await owner.stop()
    await other.stop()
    await rm(ownerDir, { recursive: true, force: true })
    await rm(otherDir, { recursive: true, force: true })
  }
})

test('a local task ID with another execution does not report STOP for this execution', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-mismatch-'))
  const taskGuid = 'task_controlled_mismatch'
  const executionId = 'execution_1'
  const taskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  state.tasks[taskId]!.executionId = 'another_execution'
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_mismatch', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(feedback.commands, [])
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(aamp.cancelRequests, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('terminal local task without a recorded outcome does not invent STOP feedback', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-terminal-'))
  const taskGuid = 'task_controlled_failed_start'
  const executionId = 'execution_1'
  const taskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  state.tasks[taskId]!.status = 'failed'
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_failed_start', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(feedback.commands, [])
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(aamp.cancelRequests, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('malformed controlled events cannot fall through to legacy dispatch', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: aamp,
    feishuClient: feishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_bad', taskGuid: 'task_controlled_1', eventTypes: ['task_create', 'task_agent_start'], action: 'START' })
    assert.deepEqual(aamp.sentTasks, [])
    assert.deepEqual(feedback.commands, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled stream progress reports RUNNING without using the legacy status patch', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} }, streamStepFlushIntervalMs: 1,
  })
  const taskId = 'feishu-task-task_controlled_progress-execution_1'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_progress', taskGuid: 'task_controlled_progress', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    aamp.emitStreamOpened(taskId, 'stream_progress')
    await waitFor(() => assert.ok(aamp.streamHandlers.stream_progress))
    aamp.emitStreamEvent('stream_progress', { id: 'stream_event_1', taskId, seq: 1, type: 'text.delta', payload: { text: '已经开始执行' } })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [1]))
    await waitFor(() => assert.deepEqual(feishu.progressWrites, [{ taskGuid: 'task_controlled_progress', progress: '正在执行', executionId: 'execution_1' }]))
    aamp.emitStreamEvent('stream_progress', { id: 'stream_event_2', taskId, seq: 2, type: 'text.delta', payload: { text: '正在查询资料' } })
    await waitFor(() => assert.ok(feishu.steps.some(({ step }) => step.content.includes('正在查询资料'))))
    assert.equal(feishu.progressWrites.length, 1)
    await runtime.stop()
    assert.equal(feishu.progressWrites.length, 1)
    assert.equal(feishu.writes.some(({ method }) => method === 'markTaskInProgress'), false)
    assert.ok(feishu.writes.filter(({ method }) => method === 'appendTaskSteps').every(({ executionId }) => executionId === 'execution_1'))
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled help reports BLOCKED and keeps Task status changes on the feedback API', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskId = 'feishu-task-task_controlled_help-execution_1'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_help', taskGuid: 'task_controlled_help', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    aamp.emitHelp(taskId, { question: '请确认参数' })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [2]))
    assert.equal(feishu.writes.some(({ method }) => method === 'markTaskWaitingForHuman'), false)
    assert.deepEqual(feishu.comments.map(({ content }) => content), ['请确认参数'])
    assert.deepEqual(feishu.writes.filter(({ method }) => method === 'commentTask').map(({ executionId }) => executionId), ['execution_1'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled running progress failure retries on the next stream without failing execution', async () => {
  const f = await controlledReplyFixture()
  try {
    f.feishu.progressErrors.push(new Error('temporary progress write failure'))
    await f.feishu.emit(f.event)
    f.aamp.emitStreamOpened(f.childId, 'retry_progress')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.retry_progress))
    f.aamp.emitStreamEvent('retry_progress', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: '查询天气' } })
    await waitFor(() => assert.equal(f.feishu.progressWrites.length, 1))
    await waitFor(() => assert.ok(f.feishu.steps.length > 0))
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.reportedExecutionState, 'RUNNING')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.feishuInProgressTaskIds, undefined)
    assert.notEqual(f.runtime.getStateSnapshot().tasks[f.childId]?.status, 'failed')
    f.aamp.emitStreamEvent('retry_progress', { taskId: f.childId, seq: 2, type: 'text.delta', payload: { text: '继续查询天气' } })
    await waitFor(() => assert.deepEqual(f.runtime.getStateSnapshot().tasks[f.childId]?.feishuInProgressTaskIds, [f.taskGuid]))
    assert.deepEqual(f.feishu.progressWrites, [
      { taskGuid: f.taskGuid, progress: '正在执行', executionId: f.executionId },
      { taskGuid: f.taskGuid, progress: '正在执行', executionId: f.executionId },
    ])
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [1])
    assert.equal(f.feishu.writes.some(({ method }) => method === 'markTaskInProgress'), false)
  } finally { await f.cleanup() }
})

for (const change of ['stop', 'replace'] as const) {
  test(`controlled running progress response cannot overwrite a newer ${change}`, async () => {
    const f = await controlledReplyFixture()
    let release!: () => void
    f.feishu.progressHold = new Promise<void>((resolve) => { release = resolve })
    try {
      await f.feishu.emit(f.event)
      f.aamp.emitStreamOpened(f.childId, 'pending_progress')
      await waitFor(() => assert.ok(f.aamp.streamHandlers.pending_progress))
      const lateStream = f.aamp.streamHandlers.pending_progress!.onEvent
      f.aamp.emitStreamEvent('pending_progress', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: '正在执行查询' } })
      await waitFor(() => assert.equal(f.feishu.progressWrites.length, 1))
      if (change === 'stop') {
        await f.feishu.emit({ eventId: 'evt_stop_pending_progress', taskGuid: f.taskGuid,
          eventTypes: ['task_agent_stop'], executionId: f.executionId, action: 'STOP' })
      } else {
        await f.feishu.emit({ eventId: 'evt_replace_pending_progress', taskGuid: f.taskGuid,
          eventTypes: ['task_agent_start'], executionId: 'execution_new', action: 'START', timestamp: '1792138000000' })
      }
      release()
      lateStream({ streamId: 'pending_progress', timestamp: new Date().toISOString(), taskId: f.childId,
        seq: 2, type: 'text.delta', payload: { text: '迟到的执行进度' } })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(f.feishu.progressWrites.length, 1)
      await f.runtime.stop()
      const saved = f.runtime.getStateSnapshot().tasks[f.childId]!
      assert.equal(saved.feishuInProgressTaskIds, undefined)
      assert.equal(f.feishu.progressWrites.length, 1)
      if (change === 'stop') assert.equal(saved.stopRequested, true)
      else assert.equal(saved.supersededByExecutionId, 'execution_new')
      assert.deepEqual((await loadBridgeState(f.configDir)).tasks[f.childId], saved)
    } finally { release(); await f.cleanup() }
  })
}

test('controlled running progress ignores stream callbacks after completion', async () => {
  const f = await controlledReplyFixture()
  try {
    await f.feishu.emit(f.event)
    f.aamp.emitStreamOpened(f.childId, 'terminal_progress')
    await waitFor(() => assert.ok(f.aamp.streamHandlers.terminal_progress))
    f.aamp.emitResult(f.childId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"完成","reply_written":false}' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.status, 'completed'))
    f.aamp.emitStreamEvent('terminal_progress', { taskId: f.childId, seq: 1, type: 'text.delta', payload: { text: '迟到执行进度' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(f.feishu.progressWrites, [])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.childId]?.status, 'completed')
  } finally { await f.cleanup() }
})

test('legacy stream progress still uses the legacy status patch once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-legacy-progress-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    logger: { log: () => {}, error: () => {} }, streamStepFlushIntervalMs: 1,
  })
  const taskId = 'feishu-task-legacy_progress-evt_legacy_progress'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_legacy_progress', taskGuid: 'legacy_progress', eventTypes: ['task_create'] })
    aamp.emitStreamOpened(taskId, 'legacy_progress')
    await waitFor(() => assert.ok(aamp.streamHandlers.legacy_progress))
    for (const seq of [1, 2]) aamp.emitStreamEvent('legacy_progress', {
      taskId, seq, type: 'text.delta', payload: { text: `执行进度 ${seq}` },
    })
    await waitFor(() => assert.ok(feishu.steps.some(({ step }) => step.content.includes('执行进度 2'))))
    await runtime.stop()
    assert.deepEqual(feishu.writes.filter(({ method }) => method === 'markTaskInProgress'), [
      { method: 'markTaskInProgress', taskGuid: 'legacy_progress', executionId: undefined },
    ])
    assert.deepEqual(feishu.progressWrites, [])
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('controlled completed and cancelled results report terminal state without legacy status completion', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    for (const [taskGuid, executionId, eventId] of [
      ['task_controlled_done', 'execution_1', 'evt_start_done'],
      ['task_controlled_cancel', 'execution_2', 'evt_start_cancel'],
    ]) {
      await feishu.emit({ eventId, taskGuid, eventTypes: ['task_agent_start'], executionId, action: 'START' })
      aamp.emitAck(`feishu-task-${taskGuid}-${executionId}`)
    }
    await waitFor(() => assert.equal(feedback.commands.length, 2))
    aamp.emitResult('feishu-task-task_controlled_done-execution_1', {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"处理完成","reply_written":false}',
    })
    await feishu.emit({ eventId: 'evt_stop_cancel', taskGuid: 'task_controlled_cancel', eventTypes: ['task_agent_stop'], executionId: 'execution_2', action: 'STOP' })
    aamp.emitResult('feishu-task-task_controlled_cancel-execution_2', { status: 'cancelled' })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state).sort(), [3, 4]))
    assert.deepEqual(feishu.completedTaskGuids, [])
    assert.deepEqual(feishu.comments.map(({ content }) => content), ['处理完成'])
    assert.deepEqual(feishu.writes.filter(({ method }) => method === 'commentTask').map(({ executionId }) => executionId), ['execution_1'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a completed result after controlled STOP keeps the same-round outputs and reports COMPLETED', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskGuid = 'task_controlled_stop_race'
  const executionId = 'execution_1'
  const taskId = `feishu-task-${taskGuid}-${executionId}`
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_stop_race', taskGuid, eventTypes: ['task_agent_start'], executionId, action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    await feishu.emit({ eventId: 'evt_stop_race', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    aamp.emitResult(taskId, {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"succeeded","summary":"已完成","outputs":[{"kind":"link_delivery","url":"https://example.com/result"},{"kind":"reply_comment","content":"结果已生成"}]}',
    })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [3]))
    assert.deepEqual(feishu.textDeliveries, [{ taskGuid, urls: ['https://example.com/result'] }])
    assert.deepEqual(feishu.comments, [{ taskGuid, content: '结果已生成' }])
    assert.deepEqual(feishu.writes.map(({ method, executionId: writtenExecutionId }) => [method, writtenExecutionId]), [
      ['appendTextDeliveries', executionId], ['commentTask', executionId],
    ])
    assert.deepEqual(feishu.completedTaskGuids, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a result completed while STOP is being sent keeps the terminal state', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  let releaseCancel!: () => void
  aamp.sendCancelHold = new Promise<void>((resolve) => { releaseCancel = resolve })
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskGuid = 'task_controlled_finish_during_stop'
  const executionId = 'execution_1'
  const taskId = `feishu-task-${taskGuid}-${executionId}`
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_finish_during_stop', taskGuid, eventTypes: ['task_agent_start'], executionId, action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    const stop = feishu.emit({ eventId: 'evt_stop_finish_during_stop', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    await waitFor(() => assert.equal(aamp.cancelRequests.length, 1))
    aamp.emitResult(taskId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"已完成","reply_written":false}' })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [3]))
    releaseCancel()
    await stop
    assert.deepEqual(feedback.commands.map(({ action, result }) => [action, result]), [[1, 1], [2, 2]])
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'completed')
    assert.deepEqual(feishu.comments, [{ taskGuid, content: '已完成' }])
  } finally {
    releaseCancel()
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled STOP ignores late progress, help and ACK while awaiting cancellation result', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} }, streamStepFlushIntervalMs: 1,
  })
  const taskId = 'feishu-task-task_controlled_late-execution_1'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_late', taskGuid: 'task_controlled_late', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitStreamOpened(taskId, 'stream_late')
    await waitFor(() => assert.ok(aamp.streamHandlers.stream_late))
    await feishu.emit({ eventId: 'evt_stop_late', taskGuid: 'task_controlled_late', eventTypes: ['task_agent_stop'], executionId: 'execution_1', action: 'STOP' })
    aamp.emitAck(taskId)
    aamp.emitStreamEvent('stream_late', { id: 'stream_event_late', taskId, seq: 1, type: 'text.delta', payload: { text: 'too late' } })
    aamp.emitHelp(taskId, { question: 'too late' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(feishu.writes, [])
    aamp.emitResult(taskId, { status: 'cancelled' })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [4]))
    assert.deepEqual(feedback.commands.map(({ action, result }) => [action, result]), [[2, 1]])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled rejected AAMP result before ACK reports START rejected without legacy writes', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_rejected', taskGuid: 'task_controlled_rejected', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitResult('feishu-task-task_controlled_rejected-execution_1', { status: 'rejected', errorMsg: 'agent refused' })
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    assert.deepEqual(feedback.commands, [{ task_guid: 'task_controlled_rejected', execution_id: 'execution_1', action: 1, result: 2, reason: 'agent refused' }])
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(feishu.writes, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled rejected result after ACK reports FAILED without promising legacy completion', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskGuid = 'task_controlled_failed'
  const executionId = 'execution_failed'
  const taskId = `feishu-task-${taskGuid}-${executionId}`
  const reason = 'ACP agent error: AAMP stream append failed: 429 Too Many Requests'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_failed', taskGuid, eventTypes: ['task_agent_start'], executionId, action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))

    aamp.emitResult(taskId, { status: 'rejected', errorMsg: reason })

    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'failed'))
    assert.deepEqual(feedback.states, [{ task_guid: taskGuid, execution_id: executionId, state: 5, reason }])
    assert.deepEqual(feishu.completedTaskGuids, [])
    assert.equal(feishu.comments.length, 1)
    assert.match(feishu.comments[0]?.content ?? '', /^本次执行失败。原因：/)
    assert.doesNotMatch(feishu.comments[0]?.content ?? '', /已完成/)
    assert.match(feishu.comments[0]?.content ?? '', /stream append failed: 429/)
    assert.deepEqual(feishu.writes.map(({ method, executionId: writtenExecutionId }) => [method, writtenExecutionId]), [
      ['commentTask', executionId],
    ])

    aamp.emitResult(taskId, { status: 'rejected', errorMsg: reason })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(feishu.comments.length, 1)
    assert.equal(feedback.states.length, 1)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled START without feedback transport never sends work to AAMP', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await assert.rejects(feishu.emit({ eventId: 'evt_start_no_transport', taskGuid: 'task_controlled_no_transport', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' }), /feedback transport is not configured/)
    assert.deepEqual(aamp.sentTasks, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('configured Task OpenAPI feedback is used by the real runtime without a test transport', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-http-'))
  const taskId = await seedControlledExecution(configDir, 'task_1', 'run_1')
  const config = buildConfig()
  config.feishu.domain = 'https://open.feishu-pre.cn'
  config.feishu.controlledFeedback = {
    commandResultPath: '/open-apis/task/v2/agent_task_execution/report_command_result',
    executionStatePath: '/open-apis/task/v2/agent_task_execution/report_execution_state',
  }
  const requests: Array<{ url: string; data: Record<string, unknown> }> = []
  const feishu = new OapiFeishuTaskClient(config.feishu, { logger: { log: () => {}, error: () => {} } })
  let onEvent: ((event: FeishuTaskEvent) => Promise<void>) | undefined
  feishu.registerAgent = async () => {}
  feishu.subscribeTaskEvents = async () => {}
  feishu.start = async (handler) => { onEvent = handler }
  feishu.stop = async () => {}
  ;(feishu as unknown as { client: unknown }).client = {
    domain: config.feishu.domain,
    formatPayload: async (payload: { data: Record<string, unknown> }) => ({ params: {}, data: payload.data, headers: { Authorization: 'Bearer app-token' } }),
    httpInstance: { request: async (request: { url: string; data: Record<string, unknown> }) => {
      requests.push(request)
      return { code: 0, msg: 'success' }
    } },
  }
  const aamp = new FakeAampClient()
  const runtime = new FeishuTaskBridgeRuntime(config, { configDir, aampClient: aamp, feishuClient: feishu, logger: { log: () => {}, error: () => {} } })
  try {
    await runtime.start()
    assert.ok(onEvent)
    await onEvent({ eventId: 'evt_stop_http', taskGuid: 'task_1', eventTypes: ['task_agent_stop'], executionId: 'run_1', action: 'STOP' })
    assert.deepEqual(requests.map(({ url, data }) => [url, data]), [
      ['https://open.feishu-pre.cn/open-apis/task/v2/agent_task_execution/report_command_result', { task_guid: 'task_1', execution_id: 'run_1', action: 2, result: 1 }],
    ])
    aamp.emitResult(taskId, { status: 'cancelled' })
    await waitFor(() => assert.equal(requests.length, 2))
    assert.deepEqual(requests.map(({ url, data }) => [url, data]), [
      ['https://open.feishu-pre.cn/open-apis/task/v2/agent_task_execution/report_command_result', { task_guid: 'task_1', execution_id: 'run_1', action: 2, result: 1 }],
      ['https://open.feishu-pre.cn/open-apis/task/v2/agent_task_execution/report_execution_state', { task_guid: 'task_1', execution_id: 'run_1', state: 4 }],
    ])
    assert.deepEqual(aamp.cancelRequests.map(({ taskId: cancelledTaskId }) => cancelledTaskId), [taskId])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('legacy task_create cannot start a second execution while a controlled round is active', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_1', taskGuid: 'task_controlled_legacy', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    await feishu.emit({ eventId: 'evt_legacy_create', taskGuid: 'task_controlled_legacy', eventTypes: ['task_create'] })
    assert.deepEqual(aamp.sentTasks.map(({ taskId }) => taskId), ['feishu-task-task_controlled_legacy-execution_1'])
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'controlled_task_uses_commands')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('legacy create requires the current app assignee and keeps valid old Agent events working', async () => {
  const cases: Array<{ members: FeishuTaskDetails['members']; dispatches: number; reason?: string }> = [
    { members: [{ id: 'cli_xxx', type: 'app', role: 'assignee' }], dispatches: 1 },
    { members: [{ id: 'ou_human', type: 'user', role: 'assignee' }], dispatches: 0, reason: 'agent_not_current_assignee' },
    { members: [{ id: 'cli_xxx', type: 'app', role: 'follower' }], dispatches: 0, reason: 'agent_not_current_assignee' },
    { members: [{ id: 'cli_other', type: 'app', role: 'assignee' }], dispatches: 0, reason: 'agent_not_current_assignee' },
    { members: undefined, dispatches: 0, reason: 'task_members_unavailable' },
  ]
  for (const [index, item] of cases.entries()) {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-assignee-'))
    const aamp = new FakeAampClient()
    const feishu = new FakeFeishuTaskClient()
    const taskGuid = `task_assignee_${index}`
    feishu.tasks[taskGuid] = { guid: taskGuid, summary: 'test', status: 'todo', members: item.members }
    const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
      configDir, aampClient: aamp, feishuClient: feishu, logger: { log: () => {}, error: () => {} },
    })
    try {
      await runtime.start()
      await feishu.emit({ eventId: `evt_assignee_${index}`, taskGuid, eventTypes: ['task_create'] })
      assert.equal(aamp.sentTasks.length, item.dispatches)
      if (item.reason) assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, item.reason)
    } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
  }
})

test('legacy dispatch rechecks an Agent removed while the input context is being prepared', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-assignee-race-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const readBase = feishu.getTaskBase.bind(feishu)
  let reads = 0
  feishu.getTaskBase = async (guid) => {
    const task = await readBase(guid)
    return ++reads === 1 ? task : { ...task, members: [{ id: 'ou_human', type: 'user', role: 'assignee' }] }
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_removed_during_prepare', taskGuid: 'task_removed', eventTypes: ['task_create'] })
    assert.equal(aamp.sentTasks.length, 0)
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'agent_not_current_assignee')
    assert.equal(Object.keys(runtime.getStateSnapshot().tasks).length, 0)
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('legacy create preparing before START does not dispatch after the controlled owner appears', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-owner-race-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const readBase = feishu.getTaskBase.bind(feishu)
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  feishu.getTaskBase = async (guid) => {
    if (++reads === 1) await hold
    return readBase(guid)
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    const create = feishu.emit({ eventId: 'evt_create_race', taskGuid: 'task_create_race', eventTypes: ['task_create'] })
    await waitFor(() => assert.equal(reads, 1))
    await feishu.emit({ eventId: 'evt_start_race', taskGuid: 'task_create_race', eventTypes: ['task_agent_start'], executionId: 'run_race', action: 'START' })
    release()
    await create
    assert.deepEqual(aamp.sentTasks.map(({ taskId }) => taskId), ['feishu-task-task_create_race-run_race'])
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'controlled_task_uses_commands')
  } finally { release(); await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('STOP closes a completed need_help turn without waiting for a second ACP result', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-stop-settled-help-'))
  const taskGuid = 'task_settled_help'
  const executionId = 'run_help'
  const taskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[taskId]!, {
    status: 'help_needed', reportedExecutionState: 'BLOCKED', startAccepted: true, resultHandledTaskIds: [taskId],
  })
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_settled_help', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(feedback.states, [{ task_guid: taskGuid, execution_id: executionId, state: 4 }])
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'cancelled')
    assert.deepEqual(aamp.cancelRequests.map(({ taskId }) => taskId), [taskId])
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('startup reports STOPPED once for an already requested STOP on a completed need_help turn', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-restore-stopped-help-'))
  const taskGuid = 'task_restore_stopped_help'
  const executionId = 'run_stopped_help'
  const taskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[taskId]!, {
    status: 'help_needed', reportedExecutionState: 'BLOCKED', startAccepted: true,
    stopRequested: true, resultHandledTaskIds: [taskId],
  })
  state.dedupEventIds.evt_old_stop = new Date().toISOString()
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.deepEqual(feedback.states, [{ task_guid: taskGuid, execution_id: executionId, state: 4 }])
    assert.deepEqual(feedback.commands, [])
    assert.deepEqual(aamp.sentTasks, [])
    assert.deepEqual(aamp.cancelRequests, [])
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'cancelled')
    assert.ok(runtime.getStateSnapshot().dedupEventIds.evt_old_stop)
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('startup leaves a completed help turn waiting when no STOP was requested', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-restore-no-stop-'))
  const taskGuid = 'task_wait_without_stop'
  const taskId = await seedControlledExecution(configDir, taskGuid, 'run_no_stop')
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[taskId]!, {
    status: 'help_needed', reportedExecutionState: 'BLOCKED', startAccepted: true, resultHandledTaskIds: [taskId],
  })
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: new FakeFeishuTaskClient(), controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(aamp.sentTasks, [])
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed')
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('startup keeps STOP pending when the current continuation has not returned its own final result', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-restore-live-reply-'))
  const taskGuid = 'task_restore_live_reply'
  const rootId = await seedControlledExecution(configDir, taskGuid, 'run_restore_reply')
  const childId = `feishu-task-${taskGuid}-reply`
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[rootId]!, {
    status: 'help_needed', reportedExecutionState: 'BLOCKED', startAccepted: true, stopRequested: true,
    resultHandledTaskIds: [rootId], activeContinuationTaskId: childId,
  })
  state.tasks[childId] = { ...state.tasks[rootId]!, aampTaskId: childId, resultHandledTaskIds: [rootId] }
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: new FakeFeishuTaskClient(), controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(aamp.sentTasks, [])
    assert.deepEqual(aamp.cancelRequests, [])
    assert.equal(runtime.getStateSnapshot().tasks[childId]?.stopRequested, true)
    assert.equal(runtime.getStateSnapshot().tasks[childId]?.status, 'help_needed')
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('startup retains a completed-help STOP marker and logs failure when feedback cannot be reported', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-restore-stop-failure-'))
  const taskGuid = 'task_restore_stop_failure'
  const taskId = await seedControlledExecution(configDir, taskGuid, 'run_stop_failure')
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[taskId]!, {
    status: 'help_needed', reportedExecutionState: 'BLOCKED', startAccepted: true,
    stopRequested: true, resultHandledTaskIds: [taskId],
  })
  await saveBridgeState(state, configDir)
  const errors: string[] = []
  const aamp = new FakeAampClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: new FakeFeishuTaskClient(),
    controlledFeedbackTransport: {
      async reportCommandResult() { throw new Error('unexpected command replay') },
      async reportExecutionState() { throw new Error('feedback temporarily unavailable') },
    },
    logger: { log: () => {}, error: (message) => { errors.push(String(message)) } },
  })
  try {
    await runtime.start()
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.stopRequested, true)
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed')
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.reportedExecutionState, 'BLOCKED')
    assert.deepEqual(aamp.sentTasks, [])
    assert.ok(errors.some((message) => message.includes('completed help STOP feedback failed')))
    assert.equal((await loadBridgeState(configDir)).tasks[taskId]?.stopRequested, true)
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('an old BLOCKED marker does not close a newly dispatched continuation on STOP', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-stop-live-reply-'))
  const taskGuid = 'task_live_reply'
  const executionId = 'run_live_reply'
  const rootId = await seedControlledExecution(configDir, taskGuid, executionId)
  const childId = `feishu-task-${taskGuid}-reply`
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[rootId]!, {
    status: 'dispatched', reportedExecutionState: 'BLOCKED', startAccepted: true,
    resultHandledTaskIds: [rootId], activeContinuationTaskId: childId,
  })
  state.tasks[childId] = { ...state.tasks[rootId]!, aampTaskId: childId, resultHandledTaskIds: [rootId] }
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_stop_live_reply', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' })
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(aamp.cancelRequests.map(({ taskId }) => taskId), [childId])
    aamp.emitResult(childId, { status: 'cancelled' })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [4]))
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('controlled STOP retries the same event when feedback submission fails', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const taskId = await seedControlledExecution(configDir, 'task_controlled_retry', 'execution_1')
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  let commandAttempts = 0
  const commands: ReportAgentTaskCommandResultBody[] = []
  const states: ReportAgentTaskExecutionStateBody[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu,
    controlledFeedbackTransport: {
      async reportCommandResult(body) {
        commandAttempts += 1
        if (commandAttempts === 1) throw new Error('temporary feedback outage')
        commands.push(body)
      },
      async reportExecutionState(body) { states.push(body) },
    },
    logger: { log: () => {}, error: () => {} },
  })
  const event: FeishuTaskEvent = { eventId: 'evt_stop_retry', taskGuid: 'task_controlled_retry', eventTypes: ['task_agent_stop'], executionId: 'execution_1', action: 'STOP' }
  try {
    await runtime.start()
    await assert.rejects(feishu.emit(event), /temporary feedback outage/)
    await feishu.emit(event)
    assert.equal(commandAttempts, 2)
    assert.deepEqual(commands, [{ task_guid: 'task_controlled_retry', execution_id: 'execution_1', action: 2, result: 1 }])
    assert.deepEqual(states, [])
    assert.deepEqual(aamp.cancelRequests.map(({ taskId: cancelledTaskId }) => cancelledTaskId), [taskId])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a help result after controlled STOP still closes the execution', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskId = 'feishu-task-task_controlled_stop_help-execution_1'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_stop_help', taskGuid: 'task_controlled_stop_help', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    await feishu.emit({ eventId: 'evt_stop_help', taskGuid: 'task_controlled_stop_help', eventTypes: ['task_agent_stop'], executionId: 'execution_1', action: 'STOP' })
    aamp.emitResult(taskId, {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","summary":"需要确认","question":"请确认参数"}',
    })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [4]))
    assert.deepEqual(feishu.comments, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('repeated controlled help events write one question and one BLOCKED state', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-controlled-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  let releaseComment!: () => void
  feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  const taskId = 'feishu-task-task_controlled_repeat_help-execution_1'
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_start_repeat_help', taskGuid: 'task_controlled_repeat_help', eventTypes: ['task_agent_start'], executionId: 'execution_1', action: 'START' })
    aamp.emitAck(taskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))
    aamp.emitHelp(taskId, { question: '请确认参数' })
    aamp.emitHelp(taskId, { question: '请确认参数' })
    await waitFor(() => assert.ok(feishu.writes.some(({ method }) => method === 'commentTask')))
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseComment()
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [2]))
    await runtime.stop()
    assert.equal(feishu.writes.filter(({ method }) => method === 'commentTask').length, 1)
    assert.deepEqual(feishu.comments.map(({ content }) => content), ['请确认参数'])
  } finally {
    releaseComment()
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

async function controlledHelpStopFixture() {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-help-stop-race-'))
  const taskGuid = 'task_help_stop_race'
  const executionId = 'run_help_stop_race'
  const taskId = await seedControlledExecution(configDir, taskGuid, executionId)
  const state = await loadBridgeState(configDir)
  Object.assign(state.tasks[taskId]!, { status: 'acknowledged', startAccepted: true, reportedExecutionState: 'RUNNING' })
  await saveBridgeState(state, configDir)
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const errors: string[] = []
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { errors.push(String(message)) } },
  })
  await runtime.start()
  const helpResult = { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"请提供城市"}' }
  const stopEvent: FeishuTaskEvent = { eventId: 'evt_stop_help_race', taskGuid, eventTypes: ['task_agent_stop'], executionId, action: 'STOP' }
  return { configDir, taskGuid, executionId, taskId, aamp, feishu, feedback, errors, logs, runtime, helpResult, stopEvent,
    cleanup: async () => { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) } }
}

test('a final need_help result closes a STOP received during its comment write without another ACP result', async () => {
  for (const commentFails of [false, true]) {
    const f = await controlledHelpStopFixture()
    let releaseComment!: () => void
    f.feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
    if (commentFails) f.feishu.commentErrors.push(new Error('question comment denied'))
    try {
      f.aamp.emitResult(f.taskId, f.helpResult)
      await waitFor(() => assert.ok(f.feishu.writes.some(({ method }) => method === 'commentTask')))
      await f.feishu.emit(f.stopEvent)
      assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.stopRequested, true)
      releaseComment()
      await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled'))
      assert.deepEqual(f.feedback.states.map(({ state }) => state), [4])
      assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.reportedExecutionState, 'STOPPED')
      assert.ok(f.runtime.getStateSnapshot().tasks[f.taskId]?.resultHandledTaskIds?.includes(f.taskId))
      if (commentFails) assert.match(f.runtime.getStateSnapshot().tasks[f.taskId]?.lastError ?? '', /question comment denied/)
    } finally { releaseComment(); await f.cleanup() }
  }
})

test('controlled final need_help reports BLOCKED even when the question comment fails', async () => {
  const f = await controlledHelpStopFixture()
  f.feishu.commentErrors.push(new Error('question comment denied'))
  try {
    f.aamp.emitResult(f.taskId, f.helpResult)
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.reportedExecutionState, 'BLOCKED'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'help_needed')
    assert.match(f.runtime.getStateSnapshot().tasks[f.taskId]?.lastError ?? '', /question comment denied/)
    assert.ok(f.errors.some((message) => message.includes('help comment failed')))
  } finally { await f.cleanup() }
})

test('controlled help reports BLOCKED when uploading an oversized question fails', async () => {
  for (const source of ['help_event', 'final_result']) {
    const f = await controlledHelpStopFixture()
    f.feishu.uploadTaskDelivery = async () => { throw new Error('question attachment denied') }
    try {
      const question = '请确认'.repeat(1100)
      if (source === 'help_event') f.aamp.emitHelp(f.taskId, { question })
      else f.aamp.emitResult(f.taskId, { output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({ schema: 'feishu_task_result.v2', status: 'need_help', question })}` })
      await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.reportedExecutionState, 'BLOCKED'))
      assert.deepEqual(f.feedback.states.map(({ state }) => state), [2])
      assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'help_needed')
      assert.match(f.runtime.getStateSnapshot().tasks[f.taskId]?.lastError ?? '', /question attachment denied/)
      assert.deepEqual(f.feishu.completedTaskGuids, [])
    } finally { await f.cleanup() }
  }
})

test('final need_help rechecks STOP after BLOCKED feedback finishes', async () => {
  const f = await controlledHelpStopFixture()
  let releaseBlocked!: () => void
  const holdBlocked = new Promise<void>((resolve) => { releaseBlocked = resolve })
  const reportState = f.feedback.transport.reportExecutionState
  f.feedback.transport.reportExecutionState = async (body) => {
    await reportState(body)
    if (body.state === 2) await holdBlocked
  }
  try {
    f.aamp.emitResult(f.taskId, f.helpResult)
    await waitFor(() => assert.deepEqual(f.feedback.states.map(({ state }) => state), [2]))
    await f.feishu.emit(f.stopEvent)
    releaseBlocked()
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2, 4])
  } finally { releaseBlocked(); await f.cleanup() }
})

test('a help event reports BLOCKED after a failed comment but does not prove that STOP has completed', async () => {
  const f = await controlledHelpStopFixture()
  f.feishu.commentErrors.push(new Error('question comment denied'))
  try {
    f.aamp.emitHelp(f.taskId, { question: '请提供城市' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.reportedExecutionState, 'BLOCKED'))
    await f.feishu.emit(f.stopEvent)
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'help_needed')
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.stopRequested, true)
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.resultHandledTaskIds?.includes(f.taskId) ?? false, false)
    f.aamp.emitResult(f.taskId, { status: 'cancelled' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2, 4])
  } finally { await f.cleanup() }
})

test('a help event interrupted by STOP keeps the STOP marker even when its question write fails', async () => {
  const f = await controlledHelpStopFixture()
  let releaseComment!: () => void
  f.feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
  f.feishu.commentErrors.push(new Error('question comment denied'))
  try {
    f.aamp.emitHelp(f.taskId, { question: '请提供城市' })
    await waitFor(() => assert.ok(f.feishu.writes.some(({ method }) => method === 'commentTask')))
    await f.feishu.emit(f.stopEvent)
    releaseComment()
    await waitFor(() => assert.ok(f.errors.some((message) => message.includes('help comment failed'))))
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.stopRequested, true)
    assert.deepEqual(f.feedback.states, [])
    f.aamp.emitResult(f.taskId, { status: 'cancelled' })
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [4])
  } finally { releaseComment(); await f.cleanup() }
})

test('a cancelled result arriving while final need_help is being written is queued instead of dropped', async () => {
  const f = await controlledHelpStopFixture()
  let releaseComment!: () => void
  let releaseCancel!: () => void
  f.feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
  f.aamp.sendCancelHold = new Promise<void>((resolve) => { releaseCancel = resolve })
  try {
    f.aamp.emitResult(f.taskId, f.helpResult)
    await waitFor(() => assert.ok(f.feishu.writes.some(({ method }) => method === 'commentTask')))
    const stop = f.feishu.emit(f.stopEvent)
    await waitFor(() => assert.equal(f.aamp.cancelRequests.length, 1))
    f.aamp.emitResult(f.taskId, { status: 'cancelled' })
    releaseComment()
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled'))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2, 4])
    releaseCancel()
    await stop
    assert.equal(f.feedback.states.filter(({ state }) => state === 4).length, 1)
  } finally { releaseComment(); releaseCancel(); await f.cleanup() }
})

test('a late cancelled result does not repeat STOPPED after a completed need_help turn was stopped', async () => {
  const f = await controlledHelpStopFixture()
  try {
    f.aamp.emitResult(f.taskId, f.helpResult)
    await waitFor(() => assert.ok(f.runtime.getStateSnapshot().tasks[f.taskId]?.resultHandledTaskIds?.includes(f.taskId)))
    await f.feishu.emit(f.stopEvent)
    f.aamp.emitResult(f.taskId, { status: 'cancelled' })
    await waitFor(() => assert.ok(f.logs.some((message) => message.includes('result already handled'))))
    assert.deepEqual(f.feedback.states.map(({ state }) => state), [2, 4])
    assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.status, 'cancelled')
  } finally { await f.cleanup() }
})

test('replacing an execution during a failed help comment never reports or logs the old callback failure', async () => {
  const f = await controlledHelpStopFixture()
  let releaseComment!: () => void
  f.feishu.commentTaskHold = new Promise<void>((resolve) => { releaseComment = resolve })
  f.feishu.commentErrors.push(new Error('old question failed'))
  try {
    f.aamp.emitResult(f.taskId, f.helpResult)
    await waitFor(() => assert.ok(f.feishu.writes.some(({ method }) => method === 'commentTask')))
    await f.feishu.emit({ eventId: 'evt_replace_help', taskGuid: f.taskGuid, eventTypes: ['task_agent_start'], executionId: 'run_new_help', action: 'START', timestamp: '200' })
    releaseComment()
    await waitFor(() => assert.equal(f.runtime.getStateSnapshot().tasks[f.taskId]?.supersededByExecutionId, 'run_new_help'))
    await f.runtime.stop()
    assert.deepEqual(f.feedback.states, [])
    assert.equal(f.runtime.getStateSnapshot().tasks[`feishu-task-${f.taskGuid}-run_new_help`]?.lastError, undefined)
    assert.equal(f.errors.some((message) => message.includes('old question failed')), false)
  } finally { releaseComment(); await f.cleanup() }
})

test('legacy need_help results still use the legacy task status write without controlled feedback', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-legacy-help-'))
  const aamp = new FakeAampClient()
  const feishu = new FakeFeishuTaskClient()
  const feedback = controlledFeedbackRecords()
  const taskGuid = 'task_legacy_help'
  const taskId = `feishu-task-${taskGuid}-evt_legacy_help`
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir, aampClient: aamp, feishuClient: feishu, controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
  })
  try {
    await runtime.start()
    await feishu.emit({ eventId: 'evt_legacy_help', taskGuid, eventTypes: ['task_create'] })
    aamp.emitResult(taskId, { output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"need_help","question":"请提供城市"}' })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed'))
    assert.deepEqual(feishu.blockedTaskGuids, [taskGuid])
    assert.match(feishu.comments[0]?.content ?? '', /请提供城市/)
    assert.deepEqual(feedback.states, [])
    assert.deepEqual(feedback.commands, [])
  } finally { await runtime.stop(); await rm(configDir, { recursive: true, force: true }) }
})

test('runtime pads info log prefix for scan-friendly terminal output', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: new FakeFeishuTaskClient(),
    logger: {
      log: (message) => { logs.push(String(message)) },
      error: (message) => { logs.push(String(message)) },
    },
  })

  try {
    await runtime.start()
    assert.ok(logs.some((line) => line.startsWith('[info ] [bridge] starting')), logs.join('\n'))
    assert.equal(logs.some((line) => line.startsWith('[info] ')), false)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime leaves task unchanged and comments when task details cannot be read before dispatch', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.getTaskBaseError = Object.assign(new Error('task api timeout'), { code: 'ETIMEDOUT' })
  const config = buildConfig()
  config.behavior.debug = true
  const logs: Array<{ message: string; metadata?: Record<string, unknown> }> = []
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: {
      log: (message, metadata) => { logs.push({ message: String(message), metadata }) },
      error: (message, metadata) => { logs.push({ message: String(message), metadata }) },
    },
  })
  const aampTaskId = 'feishu-task-task_guid_read_failure-evt_task_read_failure'

  try {
    await runtime.start()
    await assert.rejects(
      fakeFeishu.emit({
        eventId: 'evt_task_read_failure',
        taskGuid: 'task_guid_read_failure',
        eventTypes: ['task_create'],
        timestamp: '1775793266155',
      }),
      /task api timeout/,
    )

    assert.deepEqual(fakeAamp.sentTasks, [])
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_read_failure',
      content: [
        '已收到任务派发请求，但暂时无法转交智能体处理。桥接器读取任务详情失败。原因：task api timeout',
        `Task ID: ${aampTaskId}`,
        `日志收集命令：~/.aamp/bin/aamp-logs collect --task-id ${aampTaskId}`,
      ].join('\n'),
    }])
    assert.deepEqual(
      logs.find((entry) => entry.message.includes('[feishu task task_guid_read_failure] loading base details'))?.metadata,
      { taskId: aampTaskId },
    )
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime writes debug ack comment with Feishu bridge email and log commands', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const config = buildConfig()
  config.behavior.debug = true
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_ack-evt_ack'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_ack',
      taskGuid: 'task_guid_ack',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitAck(aampTaskId, 'codex@meshmail.ai')

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
    })

    const content = fakeFeishu.comments[0]?.content ?? ''
    assert.equal(fakeFeishu.comments[0]?.taskGuid, 'task_guid_ack')
    assert.match(content, /^已收到任务派发请求/)
    assert.match(content, /- Task ID: feishu-task-task_guid_ack-evt_ack/)
    assert.match(content, /- Bridge: bridge@meshmail\.ai/)
    assert.doesNotMatch(content, /Bridge: codex@meshmail\.ai/)
    assert.doesNotMatch(content, /Bridge: aamp-feishu-task-bridge/)
    assert.match(content, /- 事件场景: task_create/)
    assert.match(content, /- 收到时间: /)
    assert.match(content, /- 查看日志: \/Users\/bytedance\/\.aamp\/bin\/aamp-logs tail --task-id feishu-task-task_guid_ack-evt_ack/)
    assert.match(content, /- 导出日志: \/Users\/bytedance\/\.aamp\/bin\/aamp-logs collect --task-id feishu-task-task_guid_ack-evt_ack/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime does not write standalone tool calls as task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 1,
  })
  const aampTaskId = 'feishu-task-task_guid_stream-evt_stream'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream',
      taskGuid: 'task_guid_stream',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_tool')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_tool)
    })

    fakeAamp.emitStreamEvent('stream_tool', {
      id: 'stream_event_tool_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'tool_call' as AampStreamEvent['type'],
      payload: {
        label: "Tool completed: Read file '/Users/bytedance/.agents/skills/lark-im/SKILL.md'",
        output: '{"title":"Read file","kind":"read","locations":[{"path":"/Users/bytedance/.agents/skills/lark-im/SKILL.md"}]}',
        locations: [{ path: '/Users/bytedance/.agents/skills/lark-im/SKILL.md' }],
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(fakeFeishu.steps, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime does not write adjacent tool calls as task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_tool_group-evt_tool_group'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_tool_group',
      taskGuid: 'task_guid_tool_group',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_tool_group')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_tool_group)
    })

    for (const [seq, label] of [
      'Tool completed: Web search: weather: China, Sichuan, Chengdu',
      'Tool completed: Web search: 成都 明天 天气',
      'Tool completed: Open page: https://weather.com/weather/tomorrow/l/Chengdu+Sichuan+China',
    ].entries()) {
      fakeAamp.emitStreamEvent('stream_tool_group', {
        id: `stream_event_tool_group_${seq + 1}`,
        taskId: aampTaskId,
        seq: seq + 1,
        type: 'tool_call' as AampStreamEvent['type'],
        payload: {
          label,
          status: 'completed',
          output: `{"title":${JSON.stringify(label)}}`,
        },
      })
    }

    await runtime.stop()

    assert.deepEqual(fakeFeishu.steps, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime writes content-bearing text deltas as task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_text_stream-evt_text_stream'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_text_stream',
      taskGuid: 'task_guid_text_stream',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_text')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_text)
    })

    fakeAamp.emitStreamEvent('stream_text', {
      id: 'stream_event_text_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: { text: '我会按当前任务先确认上下文，' },
    })
    fakeAamp.emitStreamEvent('stream_text', {
      id: 'stream_event_text_2',
      taskId: aampTaskId,
      seq: 2,
      type: 'text.delta',
      payload: { text: '再检查可用工具和授权范围。' },
    })
    fakeAamp.emitStreamEvent('stream_text', {
      id: 'stream_event_tool_between_text',
      taskId: aampTaskId,
      seq: 3,
      type: 'tool_call' as AampStreamEvent['type'],
      payload: {
        label: "Tool completed: Read file '/Users/bytedance/.agents/skills/lark-im/SKILL.md'",
        status: 'completed',
        output: '{"title":"Read file"}',
      },
    })
    fakeAamp.emitStreamEvent('stream_text', {
      id: 'stream_event_text_3',
      taskId: aampTaskId,
      seq: 4,
      type: 'text.delta',
      payload: { text: '我已经确认任务需要参考 IM 的过程展示策略。' },
    })

    await runtime.stop()

    assert.equal(fakeFeishu.steps.length, 2)
    assert.deepEqual(fakeFeishu.steps.map(({ taskGuid, step }) => ({ taskGuid, content: step.content })), [
      {
        taskGuid: 'task_guid_text_stream',
        content: '我会按当前任务先确认上下文，再检查可用工具和授权范围。',
      },
      {
        taskGuid: 'task_guid_text_stream',
        content: '我已经确认任务需要参考 IM 的过程展示策略。',
      },
    ])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime splits text steps at message boundaries and drops standalone AIME progress', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_msg_boundary-evt_msg_boundary'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_msg_boundary',
      taskGuid: 'task_guid_msg_boundary',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_msg_boundary')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_msg_boundary)
    })

    fakeAamp.emitStreamEvent('stream_msg_boundary', {
      id: 'stream_event_boundary_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: { text: '收到，我会继续处理该任务。', messageId: 'assistant-ack' },
    })
    fakeAamp.emitStreamEvent('stream_msg_boundary', {
      id: 'stream_event_boundary_2',
      taskId: aampTaskId,
      seq: 2,
      type: 'text.delta',
      payload: { text: '开始分析任务，简单问题将快速给出结果', messageId: 'thought-1' },
    })
    fakeAamp.emitStreamEvent('stream_msg_boundary', {
      id: 'stream_event_boundary_3',
      taskId: aampTaskId,
      seq: 3,
      type: 'text.delta',
      payload: { text: 'AIME is executing.', messageId: 'progress-1' },
    })
    fakeAamp.emitStreamEvent('stream_msg_boundary', {
      id: 'stream_event_boundary_4',
      taskId: aampTaskId,
      seq: 4,
      type: 'text.delta',
      payload: { text: '[thinking] AIME is preparing.', messageId: 'progress-2' },
    })
    fakeAamp.emitStreamEvent('stream_msg_boundary', {
      id: 'stream_event_boundary_5',
      taskId: aampTaskId,
      seq: 5,
      type: 'text.delta',
      payload: { text: ' 正在理解任务的真实意图', messageId: 'thought-1' },
    })

    await runtime.stop()

    assert.deepEqual(fakeFeishu.steps.map(({ step }) => step.content), [
      '收到，我会继续处理该任务。',
      '开始分析任务，简单问题将快速给出结果 正在理解任务的真实意图',
    ])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores AIME progress notices as task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_aime_progress-evt_aime_progress'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_aime_progress',
      taskGuid: 'task_guid_aime_progress',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_aime_progress')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_aime_progress)
    })

    fakeAamp.emitStreamEvent('stream_aime_progress', {
      id: 'stream_event_progress_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: { text: 'AIME is executing.' },
    })
    fakeAamp.emitStreamEvent('stream_aime_progress', {
      id: 'stream_event_progress_2',
      taskId: aampTaskId,
      seq: 2,
      type: 'text.delta',
      payload: { text: 'AIME is thinking.' },
    })
    fakeAamp.emitStreamEvent('stream_aime_progress', {
      id: 'stream_event_progress_3',
      taskId: aampTaskId,
      seq: 3,
      type: 'todo' as AampStreamEvent['type'],
      payload: { items: [{ content: '定位目标群聊', status: 'in_progress' }] },
    })

    await runtime.stop()

    assert.deepEqual(fakeFeishu.steps.map(({ step }) => step.content), ['定位目标群聊'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime writes semantic todo stream items and ignores lifecycle labels', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_todo_stream-evt_todo_stream'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_todo_stream',
      taskGuid: 'task_guid_todo_stream',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_todo')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_todo)
    })

    fakeAamp.emitStreamEvent('stream_todo', {
      id: 'stream_event_todo_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'todo' as AampStreamEvent['type'],
      payload: {
        items: [
          { id: 'prompt', content: 'Prompt sent to ACP agent', status: 'completed' },
          { id: 'plan', content: '正在生成 AI 测试工程师 JD 文档', status: 'completed' },
          { id: 'reply', content: 'ACP agent is composing the reply', status: 'in_progress' },
          { id: 'usage', content: 'Token usage updated', status: 'in_progress' },
        ],
        summary: 'Agent is working',
      },
    })

    await runtime.stop()

    assert.deepEqual(fakeFeishu.steps, [
      {
        taskGuid: 'task_guid_todo_stream',
        step: { content: '正在生成 AI 测试工程师 JD 文档' },
      },
    ])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime cleans task text delta markup before writing task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_clean_text-evt_clean_text'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_clean_text',
      taskGuid: 'task_guid_clean_text',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_clean_text')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_clean_text)
    })

    fakeAamp.emitStreamEvent('stream_clean_text', {
      id: 'stream_event_clean_text_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: {
        text: '[thinking] **Planning weather query for Chengdu** <!-- -->\n\n',
      },
    })
    fakeAamp.emitStreamEvent('stream_clean_text', {
      id: 'stream_event_clean_text_2',
      taskId: aampTaskId,
      seq: 2,
      type: 'text.delta',
      payload: {
        text: '**Requesting Chengdu weather forecast** <!-- -->',
      },
    })
    fakeAamp.emitStreamEvent('stream_clean_text', {
      id: 'stream_event_clean_text_3',
      taskId: aampTaskId,
      seq: 3,
      type: 'tool_call' as AampStreamEvent['type'],
      payload: {
        label: 'Tool completed: Web search: weather Chengdu',
        status: 'completed',
        output: '{"title":"Web search: weather Chengdu"}',
      },
    })
    fakeAamp.emitStreamEvent('stream_clean_text', {
      id: 'stream_event_clean_text_4',
      taskId: aampTaskId,
      seq: 4,
      type: 'text.delta',
      payload: {
        text: 'Clarifying JSON output formatting Confirming escaped newline formatting in JSON AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\"}"}',
      },
    })

    await runtime.stop()

    assert.equal(fakeFeishu.steps.length, 2)
    assert.deepEqual(fakeFeishu.steps, [
      {
        taskGuid: 'task_guid_clean_text',
        step: {
          content: 'Planning weather query for Chengdu\nRequesting Chengdu weather forecast',
        },
      },
      {
        taskGuid: 'task_guid_clean_text',
        step: {
          content: 'Clarifying JSON output formatting Confirming escaped newline formatting in JSON AAMP_RESULT_JSON',
        },
      },
    ])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime drops bare AAMP_RESULT_JSON task text after cleaning', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 60_000,
  })
  const aampTaskId = 'feishu-task-task_guid_drop_marker-evt_drop_marker'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_drop_marker',
      taskGuid: 'task_guid_drop_marker',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_drop_marker')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_drop_marker)
    })

    fakeAamp.emitStreamEvent('stream_drop_marker', {
      id: 'stream_event_drop_marker',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: {
        text: 'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\"}"}',
      },
    })

    await runtime.stop()

    assert.deepEqual(fakeFeishu.steps, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime does not write ACP task started as task step', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 1,
  })
  const aampTaskId = 'feishu-task-task_guid_acp_started-evt_acp_started'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_acp_started',
      taskGuid: 'task_guid_acp_started',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_acp_started')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_acp_started)
    })

    fakeAamp.emitStreamEvent('stream_acp_started', {
      id: 'stream_event_acp_started',
      taskId: aampTaskId,
      seq: 1,
      // The legacy bridge can still receive this event from older AAMP nodes.
      type: 'status' as AampStreamEvent['type'],
      payload: { label: 'ACP task started' },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(fakeFeishu.steps, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime leaves task unchanged and comments when prompt dispatch fails', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeAamp.sendTaskError = new Error('mailbox unavailable')
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_dispatch_failure-evt_dispatch_failure'

  try {
    await runtime.start()
    await assert.rejects(
      fakeFeishu.emit({
        eventId: 'evt_dispatch_failure',
        taskGuid: 'task_guid_dispatch_failure',
        eventTypes: ['task_create'],
        timestamp: '1775793266155',
      }),
      /mailbox unavailable/,
    )

    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_dispatch_failure',
      content: [
        '已收到任务派发请求，但暂时无法转交智能体处理。桥接器派发智能体失败，本次处理尚未开始。原因：mailbox unavailable',
        'Task ID: feishu-task-task_guid_dispatch_failure-evt_dispatch_failure',
        '日志收集命令：~/.aamp/bin/aamp-logs collect --task-id feishu-task-task_guid_dispatch_failure-evt_dispatch_failure',
      ].join('\n'),
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime uses reply wording when comment content cannot be read before dispatch', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.getCommentError = Object.assign(new Error('comment api timeout'), { code: 'ETIMEDOUT' })
  const aampTaskId = 'feishu-task-task_guid_comment_read_failure-evt_comment_read_failure'
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await assert.rejects(
      fakeFeishu.emit({
        eventId: 'evt_comment_read_failure',
        taskGuid: 'task_guid_comment_read_failure',
        eventTypes: ['task_comment_create'],
        commentId: 'comment_read_failure',
        timestamp: '1775793266155',
      }),
      /comment api timeout/,
    )

    assert.deepEqual(fakeAamp.sentTasks, [])
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_comment_read_failure',
      content: [
        '已收到您的回复，但暂时无法转交智能体处理。桥接器读取回复内容失败。原因：comment api timeout',
        `Task ID: ${aampTaskId}`,
        `日志收集命令：~/.aamp/bin/aamp-logs collect --task-id ${aampTaskId}`,
      ].join('\n'),
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes comment-triggered answered results when bridge writes the reply', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_answered_comment = {
    guid: 'task_guid_answered_comment',
    taskId: 't_answered_comment',
    summary: '继续回答日期问题',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_answered', authorType: 'user', authorId: 'ou_human', content: '请直接回复答案。', createdAt: '1775793266100' },
    ],
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_answered_comment',
      taskGuid: 'task_guid_answered_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_answered_comment-evt_answered_comment', {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"今天是 2026-07-03。","reply_written":false}',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_answered_comment'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered_comment-evt_answered_comment']?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_answered_comment',
      content: '今天是 2026-07-03。',
    }])
    assert.deepEqual(
      runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered_comment-evt_answered_comment']?.resultCommentedTaskIds,
      ['feishu-task-task_guid_answered_comment-evt_answered_comment'],
    )
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime parses AAMP_RESULT_JSON wrappers after natural language output', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_wrapped_result-evt_wrapped_result'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_wrapped_result',
      taskGuid: 'task_guid_wrapped_result',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: [
        '任务意图明确：用户问"今天天气咋样？"，需要回答天气情况。',
        '',
        `AAMP_RESULT_JSON: ${JSON.stringify({
          output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
            schema: 'feishu_task_result.v2',
            status: 'succeeded',
            summary: '已回复今天北京天气情况。',
            outputs: [
              {
                kind: 'reply_comment',
                content: '北京今天多云，28°C。\n下午可能有雷阵雨。',
              },
            ],
          })}`,
        })}`,
      ].join('\n'),
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_wrapped_result'])
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_wrapped_result',
      content: '北京今天多云，28°C。\n下午可能有雷阵雨。',
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime parses trailing FEISHU_TASK_RESULT_JSON markers after natural language output', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_trailing_marker-evt_trailing_marker'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_trailing_marker',
      taskGuid: 'task_guid_trailing_marker',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: [
        '我先说明一下处理思路。',
        `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
          schema: 'feishu_task_result.v2',
          status: 'succeeded',
          summary: '已回复。',
          outputs: [
            {
              kind: 'reply_comment',
              content: '结果里可以包含花括号：{ok: true}。',
            },
          ],
        })}`,
        '这句尾随文本不属于 JSON。',
      ].join('\n'),
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_trailing_marker'])
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_trailing_marker',
      content: '结果里可以包含花括号：{ok: true}。',
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime uploads oversized reply comments as markdown delivery attachments', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_long_reply = {
    guid: 'task_guid_long_reply',
    taskId: 't_long_reply',
    summary: '继续输出长回复',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_long', authorType: 'user', authorId: 'ou_human', content: '请给完整长回复。', createdAt: '1775793266100' },
    ],
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const longReply = `# 长回复\n\n${'很长的内容。'.repeat(800)}`

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_long_reply',
      taskGuid: 'task_guid_long_reply',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_long_reply-evt_long_reply', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已生成长回复。',
        outputs: [
          { kind: 'reply_comment', content: longReply },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_long_reply'])
      assert.equal(fakeFeishu.uploadedDeliveries.length, 1)
      assert.equal(fakeFeishu.comments.length, 1)
    })

    assert.equal(fakeFeishu.uploadedDeliveryContents[0], longReply)
    assert.match(path.basename(fakeFeishu.uploadedDeliveries[0]?.filePath ?? ''), /^reply-comment.*\.md$/)
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_long_reply',
      content: '评论内容超过飞书限制（4807 characters / 14413 bytes，限制为 3000 characters / 10000 bytes），已作为 Markdown 附件上传。',
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes result once when a Feishu comment write fails transiently', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.commentFailures = 1
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_comment_failure-evt_comment_failure'
  const resultOutput = `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: '已生成回复。',
    outputs: [
      { kind: 'reply_comment', content: '这是原始回复。' },
    ],
  })}`

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_comment_failure',
      taskGuid: 'task_guid_comment_failure',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: resultOutput,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_comment_failure'])
      assert.equal(fakeFeishu.comments.length, 1)
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /桥接器写入结果评论失败/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /任务将流转为已完成/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /temporary comment failure/)
    assert.deepEqual(runtime.getStateSnapshot().tasks[aampTaskId]?.resultHandledTaskIds, [aampTaskId])

    fakeAamp.emitResult(aampTaskId, {
      output: resultOutput,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_comment_failure'])
    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.equal(fakeFeishu.comments.length, 1)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes and comments briefly when agent result violates the final contract', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_bad_contract-evt_bad_contract'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_bad_contract',
      taskGuid: 'task_guid_bad_contract',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: '我已经完成了，但没有按协议返回 JSON。',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_bad_contract'])
      assert.equal(fakeFeishu.comments.length, 1)
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
    })
    assert.match(fakeFeishu.comments[0]?.content ?? '', /^智能体返回的结果格式不符合任务协议，本次处理已结束。任务将流转为已完成。原因：/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /未按 FEISHU_TASK_RESULT_JSON 协议收尾/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /Task ID: feishu-task-task_guid_bad_contract-evt_bad_contract/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /aamp-logs collect --task-id feishu-task-task_guid_bad_contract-evt_bad_contract/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /AAMP Task ID/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime logs sanitized FEISHU_TASK_RESULT_JSON snippet when inner JSON cannot parse', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const errors: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: (message: unknown) => { errors.push(String(message)) } },
  })
  const aampTaskId = 'feishu-task-task_guid_bad_inner_json-evt_bad_inner_json'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_bad_inner_json',
      taskGuid: 'task_guid_bad_inner_json',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: 'FEISHU_TASK_RESULT_JSON: {schema:"feishu_task_result.v2",status:"answered",summary:"done"}',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_bad_inner_json'])
      assert.equal(fakeFeishu.comments.length, 1)
      assert.ok(errors.some((message) => message.includes('result invalid FEISHU_TASK_RESULT_JSON snippet=')))
    })

    const diagnostic = errors.find((message) => message.includes('result invalid FEISHU_TASK_RESULT_JSON snippet=')) ?? ''
    assert.match(diagnostic, /snippet="\{schema:/)
    assert.match(diagnostic, /status:/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /snippet=/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /{schema:/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime keeps lark-cli profile out of dispatch context and puts it in prompt rules', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const config = buildConfig()
  config.feishu.cliProfile = 'custom-feishu-profile'
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_profile_context',
      taskGuid: 'task_guid_profile_context',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_lark_cli_profile, undefined)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /Feishu lark-cli profile rules:/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', process.platform === 'win32' ? /--profile 'custom-feishu-profile'/ : /--profile custom-feishu-profile/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects remote file_delivery before filesystem access and persists a safe failure', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const aampTaskId = 'feishu-task-task_guid_remote_file-evt_remote_file'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_remote_file',
      taskGuid: 'task_guid_remote_file',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })
    fakeAamp.emitResult(aampTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已生成文件。',
        outputs: [{ kind: 'file_delivery', path: '/Users/private/SECRET_FILE' }],
      })}`,
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_remote_file'])
    })
    const evidence = [
      fakeFeishu.comments.map((entry) => entry.content).join('\n'),
      runtime.getStateSnapshot().lastError ?? '',
      runtime.getStateSnapshot().tasks[aampTaskId]?.lastError ?? '',
      logs.join('\n'),
    ].join('\n')
    assert.match(evidence, /REMOTE_ARTIFACT_UNSUPPORTED/)
    assert.doesNotMatch(evidence, /\/Users\/private/)
    assert.doesNotMatch(evidence, /SECRET_FILE/)
    assert.deepEqual(fakeFeishu.uploadedDeliveries, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime surfaces remote result failure diagnostics verbatim', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const rejectedTaskId = 'feishu-task-task_guid_remote_rejected-evt_remote_rejected'
  const safeFailedTaskId = 'feishu-task-task_guid_remote_safe_failed-evt_remote_safe_failed'
  const rawFailure = 'ACP agent error: acpx --cwd /Users/private --agent /secret/aime-acp prompt ## AAMP Task SECRET_PROMPT'
  const permissionError = '没有权限读取指定群聊，请确认远端 Aime 账号权限。'

  try {
    await runtime.start()
    await fakeFeishu.emit({ eventId: 'evt_remote_rejected', taskGuid: 'task_guid_remote_rejected', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(rejectedTaskId, { status: 'rejected', errorMsg: rawFailure })
    await fakeFeishu.emit({ eventId: 'evt_remote_safe_failed', taskGuid: 'task_guid_remote_safe_failed', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(safeFailedTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'failed',
        summary: '无法读取指定群聊。',
        error: permissionError,
      })}`,
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[rejectedTaskId]?.status, 'failed')
      assert.equal(runtime.getStateSnapshot().tasks[rejectedTaskId]?.lastError, rawFailure)
      assert.equal(runtime.getStateSnapshot().tasks[safeFailedTaskId]?.status, 'failed')
      assert.equal(runtime.getStateSnapshot().tasks[safeFailedTaskId]?.lastError, permissionError)
    })
    const evidence = [
      fakeFeishu.comments.map((entry) => entry.content).join('\n'),
      runtime.getStateSnapshot().lastError ?? '',
      runtime.getStateSnapshot().tasks[rejectedTaskId]?.lastError ?? '',
      logs.join('\n'),
    ].join('\n')
    assert.equal(evidence.includes('REMOTE_AGENT_FAILED'), false)
    assert.equal(evidence.includes(rawFailure), true)
    assert.equal(fakeFeishu.comments.map((entry) => entry.content).join('\n').includes(permissionError), true)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime suppresses malformed remote result snippets from task logs', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const errors: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: (message) => { errors.push(String(message)) } },
  })
  const aampTaskId = 'feishu-task-task_guid_remote_bad_json-evt_remote_bad_json'
  const sentinels = 'acpx --cwd /Users/private --agent /secret/aime-acp ## AAMP Task SECRET_PROMPT access_token=SECRET_TOKEN'

  try {
    await runtime.start()
    await fakeFeishu.emit({ eventId: 'evt_remote_bad_json', taskGuid: 'task_guid_remote_bad_json', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(aampTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"${sentinels}",}`,
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
      assert.ok(errors.some((message) => message.includes('result invalid FEISHU_TASK_RESULT_JSON')))
    })
    const evidence = [
      errors.join('\n'),
      runtime.getStateSnapshot().lastError ?? '',
      runtime.getStateSnapshot().tasks[aampTaskId]?.lastError ?? '',
      fakeFeishu.comments.map((entry) => entry.content).join('\n'),
    ].join('\n')
    assert.doesNotMatch(evidence, /acpx|--cwd|--agent|\/Users\/private|SECRET_PROMPT|access_token|SECRET_TOKEN|## AAMP Task/i)
    assert.match(errors.join('\n'), /category=final_contract/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime surfaces remote post-prompt Feishu write failure details verbatim', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const aampTaskId = 'feishu-task-task_guid_remote_write_failure-evt_remote_write_failure'
  const sentinels = 'acpx --cwd /Users/private --agent /secret/aime-acp ## AAMP Task SECRET_PROMPT access_token=SECRET_TOKEN'

  fakeFeishu.commentErrors.push(new Error(sentinels))
  fakeFeishu.completeTaskErrors.push(new Error(sentinels))
  try {
    await runtime.start()
    await fakeFeishu.emit({ eventId: 'evt_remote_write_failure', taskGuid: 'task_guid_remote_write_failure', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(aampTaskId, {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"已完成。","reply_written":false}',
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'completed')
      assert.equal(fakeFeishu.comments.length, 1)
    })
    const evidence = [
      fakeFeishu.comments.map((entry) => entry.content).join('\n'),
      runtime.getStateSnapshot().lastError ?? '',
      runtime.getStateSnapshot().tasks[aampTaskId]?.lastError ?? '',
      logs.join('\n'),
    ].join('\n')
    assert.equal(evidence.includes('REMOTE_AGENT_FAILED'), false)
    assert.equal(evidence.includes(sentinels), true)
    assert.match(logs.join('\n'), /action=result_comment/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime blocks remote tasks with any attachment metadata before download or AAMP dispatch', async () => {
  const sources = ['parent_attachment', 'parent_delivery', 'child_attachment', 'child_delivery'] as const

  for (const [index, source] of sources.entries()) {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
    const fakeAamp = new FakeAampClient()
    const fakeFeishu = new FakeFeishuTaskClient()
    const logs: string[] = []
    const taskGuid = `task_guid_remote_attachments_${index}`
    const childGuid = `child_guid_remote_attachments_${index}`
    const eventId = `evt_remote_attachments_${index}`
    const aampTaskId = `feishu-task-${taskGuid}-${eventId}`
    const attachment: FeishuTaskAttachment = {
      guid: `${source}_guid`,
      kind: source.endsWith('delivery') ? 'task_delivery' : 'task_attachment',
      name: '/opt/private/SECRET_ATTACHMENT client_secret=SECRET_CLIENT',
      url: '\\\\private-server\\secret\\attachment',
    }
    fakeFeishu.tasks[taskGuid] = {
      guid: taskGuid,
      taskId: `t_remote_attachments_${index}`,
      summary: '处理附件',
      status: 'todo',
      attachments: source === 'parent_attachment' ? [attachment] : [],
      attachmentDeliveries: source === 'parent_delivery' ? [attachment] : [],
      subtasks: [{
        guid: childGuid,
        summary: '子任务附件',
        status: 'todo',
        attachments: source === 'child_attachment' ? [attachment] : [],
        attachmentDeliveries: source === 'child_delivery' ? [attachment] : [],
      }],
    }
    const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
      configDir,
      aampClient: fakeAamp,
      feishuClient: fakeFeishu,
      logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
    })

    try {
      await runtime.start()
      await fakeFeishu.emit({ eventId, taskGuid, eventTypes: ['task_create'], timestamp: '1775793266155' })

      const state = runtime.getStateSnapshot()
      const evidence = [
        fakeFeishu.comments.map((entry) => entry.content).join('\n'),
        state.lastError ?? '',
        state.tasks[aampTaskId]?.lastError ?? '',
        logs.join('\n'),
      ].join('\n')
      assert.equal(state.tasks[aampTaskId]?.status, 'help_needed', source)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, [childGuid, taskGuid], source)
      assert.match(fakeFeishu.comments[0]?.content ?? '', /REMOTE_ATTACHMENTS_UNSUPPORTED/, source)
      assert.deepEqual(fakeFeishu.downloadedAttachmentGuids, [], source)
      assert.deepEqual(fakeAamp.sentTasks, [], source)
      assert.deepEqual(fakeAamp.streamHandlers, {}, source)
      assert.deepEqual(fakeFeishu.uploadedDeliveries, [], source)
      assert.doesNotMatch(evidence, /SECRET_ATTACHMENT|SECRET_CLIENT|client_secret|\/opt\/private|private-server/i, source)
    } finally {
      await runtime.stop()
      await rm(configDir, { recursive: true, force: true })
    }
  }
})

test('remote attachment rejection resumes partial waiting transitions without duplicate help comments', async () => {
  for (const failureTarget of ['child', 'parent'] as const) {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
    const fakeAamp = new FakeAampClient()
    const fakeFeishu = new FakeFeishuTaskClient()
    const taskGuid = `task_guid_attachment_retry_${failureTarget}`
    const childGuid = `child_guid_attachment_retry_${failureTarget}`
    const eventId = `evt_attachment_retry_${failureTarget}`
    const aampTaskId = `feishu-task-${taskGuid}-${eventId}`
    const attachment: FeishuTaskAttachment = {
      guid: `attachment_retry_${failureTarget}`,
      kind: 'task_attachment',
      name: '/opt/private/SECRET_ATTACHMENT refreshToken=SECRET_REFRESH',
    }
    fakeFeishu.tasks[taskGuid] = {
      guid: taskGuid,
      taskId: `t_attachment_retry_${failureTarget}`,
      summary: '处理附件',
      status: 'todo',
      attachments: [attachment],
      subtasks: [{ guid: childGuid, summary: '子任务', status: 'todo' }],
    }
    const failedGuid = failureTarget === 'child' ? childGuid : taskGuid
    fakeFeishu.blockTaskErrors[failedGuid] = [new Error(`${failureTarget} waiting transition failed`)]
    const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
      configDir,
      aampClient: fakeAamp,
      feishuClient: fakeFeishu,
      logger: { log: () => {}, error: () => {} },
    })
    const event: FeishuTaskEvent = {
      eventId,
      taskGuid,
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    }

    try {
      await runtime.start()
      await assert.rejects(fakeFeishu.emit(event), new RegExp(`${failureTarget} waiting transition failed`))

      let state = runtime.getStateSnapshot()
      assert.equal(fakeFeishu.comments.length, 1, failureTarget)
      assert.deepEqual(state.tasks[aampTaskId]?.helpCommentedTaskIds, [aampTaskId], failureTarget)
      assert.equal(state.dedupEventIds[eventId], undefined, failureTarget)

      await fakeFeishu.emit(event)
      state = runtime.getStateSnapshot()
      assert.equal(fakeFeishu.comments.length, 1, failureTarget)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, [childGuid, taskGuid], failureTarget)
      assert.deepEqual(
        fakeFeishu.blockTaskAttempts,
        failureTarget === 'child' ? [childGuid, childGuid, taskGuid] : [childGuid, taskGuid, taskGuid],
        failureTarget,
      )
      assert.equal(state.tasks[aampTaskId]?.status, 'help_needed', failureTarget)
      assert.deepEqual(state.tasks[aampTaskId]?.feishuBlockedTaskIds, [childGuid, taskGuid], failureTarget)
      assert.ok(state.dedupEventIds[eventId], failureTarget)
      assert.deepEqual(fakeFeishu.downloadedAttachmentGuids, [], failureTarget)
      assert.deepEqual(fakeAamp.sentTasks, [], failureTarget)
      assert.deepEqual(fakeAamp.streamHandlers, {}, failureTarget)
      assert.deepEqual(fakeFeishu.uploadedDeliveries, [], failureTarget)
    } finally {
      await runtime.stop()
      await rm(configDir, { recursive: true, force: true })
    }
  }
})

test('exported result classifier enforces required remote human-visible fields', () => {
  const makeResult = (payload: Record<string, unknown>): TaskResult => ({
    protocolVersion: '1.1',
    intent: 'task.result',
    taskId: 'remote-contract-task',
    status: 'completed',
    output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({ schema: 'feishu_task_result.v2', ...payload })}`,
    from: 'agent@meshmail.ai',
    to: 'bridge@meshmail.ai',
  })
  const invalidPayloads: Record<string, unknown>[] = [
    { status: 'answered', reply_written: false },
    { status: 'answered', summary: '已回答。', reply_written: true },
    { status: 'succeeded', outputs: [{ kind: 'reply_comment', content: '结果' }] },
    { status: 'need_help', summary: '需要输入。' },
    { status: 'failed', summary: '执行失败。' },
  ]

  for (const payload of invalidPayloads) {
    const disposition = classifyFeishuTaskResult(makeResult(payload), 'remote')
    assert.equal(disposition.kind, 'failure')
    assert.equal(disposition.kind === 'failure' ? disposition.reason : '', 'final_contract')
    assert.match(disposition.kind === 'failure' ? disposition.message : '', /不能为空|必须|不允许/)
  }
  assert.equal(classifyFeishuTaskResult(makeResult({ status: 'answered', summary: '已回答。', reply_written: false }), 'remote').kind, 'answered')
  assert.equal(classifyFeishuTaskResult(makeResult({
    status: 'succeeded',
    summary: '文本已生成。',
    outputs: [{ kind: 'text_delivery', format: 'plain_text', content: '结果' }],
  }), 'remote').kind, 'succeeded')
  assert.equal(classifyFeishuTaskResult(makeResult({ status: 'need_help', summary: '需要输入。', question: '请提供群 ID。' }), 'remote').kind, 'help_needed')
  const failed = classifyFeishuTaskResult(makeResult({ status: 'failed', summary: '执行失败。', error: '没有权限读取指定群聊。' }), 'remote')
  assert.equal(failed.kind, 'failure')
  assert.equal(failed.reason, 'agent_failed')

  const remoteFile = classifyFeishuTaskResult(makeResult({
    status: 'succeeded',
    summary: '生成了远端文件。',
    outputs: [{ kind: 'file_delivery', path: 'relative/SECRET_FILE' }],
  }), 'remote')
  assert.equal(remoteFile.kind, 'failure')
  assert.equal(remoteFile.kind === 'failure' ? remoteFile.reason : '', 'agent_failed')
  assert.equal(
    remoteFile.kind === 'failure' ? remoteFile.message : '',
    'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
  )

  const malformed = classifyFeishuTaskResult({
    ...makeResult({ status: 'answered', summary: '不会使用。', reply_written: false }),
    output: 'FEISHU_TASK_RESULT_JSON: {"summary":"/opt/private/SECRET_PROMPT",}',
  }, 'remote')
  assert.equal(malformed.kind, 'failure')
  assert.equal(malformed.kind === 'failure' ? malformed.diagnosticCategory : undefined, 'malformed_result_json')
  assert.equal(malformed.kind === 'failure' ? malformed.diagnosticSnippet : undefined, undefined)
})

test('remote failure sanitizer passes remote error text through verbatim', () => {
  const failures = [
    'Authorization: Bearer SECRET_BEARER',
    'client_secret=SECRET_CLIENT app_secret=SECRET_APP access_token=SECRET_ACCESS',
    'clientSecret=SECRET_CLIENT appSecret=SECRET_APP accessToken=SECRET_ACCESS resumeToken=SECRET_RESUME',
    'resume-token=SECRET_RESUME mailboxToken=SECRET_MAILBOX',
    'refresh_token=SECRET_REFRESH refreshToken=SECRET_REFRESH_CAMEL',
    'id_token=SECRET_ID idToken=SECRET_ID_CAMEL',
    'session_token=SECRET_SESSION sessionToken=SECRET_SESSION_CAMEL',
    'signing_secret=SECRET_SIGNING signingSecret=SECRET_SIGNING_CAMEL',
    'database_password=SECRET_PASSWORD databasePassword=SECRET_PASSWORD_CAMEL',
    'x_api_key=SECRET_API xApiKey=SECRET_API_CAMEL X-API-KEY=SECRET_API_DASH',
    '--refresh-token SECRET_OPTION --servicePassword=SECRET_OPTION_PASSWORD',
    'open /opt/aime/private/config.json failed',
    'open,/opt/aime/private/config.json failed',
    'open ~/aime/private/config.json failed',
    String.raw`open C:\Users\private\secret.txt failed`,
    'open C:/Users/private/secret.txt failed',
    String.raw`open \\private-server\secret\payload failed`,
    'api_key=SECRET_KEY password=SECRET_PASSWORD',
    'argv=["acpx","--cwd","/workspace"] prompt=## AAMP Task SECRET_PROMPT',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature',
    'sk-proj-ABCDEF1234567890',
    'SECRET_SENTINEL',
    'AIME_SECRET_SENTINEL',
    'vF8kQ2mN7pR4sT9wX6yZ3aB1cD5eG0hJ',
    '没有权限读取指定群聊，请确认远端 Aime 账号权限。',
  ]

  for (const failure of failures) {
    assert.equal(sanitizeTaskVisibleFailureReason(new Error(failure), 'remote'), failure)
  }
  assert.equal(
    sanitizeTaskVisibleFailureReason(new Error('AUTH_REQUIRED Authorization: Bearer SECRET'), 'remote'),
    'AUTH_REQUIRED Authorization: Bearer SECRET',
  )
  assert.equal(
    sanitizeTaskVisibleFailureReason(new Error('AUTH_IDENTITY_CHANGED client_secret=SECRET'), 'remote'),
    'AUTH_IDENTITY_CHANGED client_secret=SECRET',
  )
  assert.equal(
    sanitizeTaskVisibleFailureReason(new Error('REMOTE_ARTIFACT_UNSUPPORTED /opt/private/file'), 'remote'),
    'REMOTE_ARTIFACT_UNSUPPORTED /opt/private/file',
  )
  assert.equal(sanitizeTaskVisibleFailureReason(new Error('SECRET_SENTINEL'), 'local'), 'SECRET_SENTINEL')
})

test('runtime surfaces remote help and failure text verbatim in comments state and logs', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature'
  const providerToken = 'sk-proj-ABCDEF1234567890'
  const secretMarker = 'SECRET_SENTINEL'
  const highEntropyToken = 'vF8kQ2mN7pR4sT9wX6yZ3aB1cD5eG0hJ'
  const rejectedTaskId = 'feishu-task-task_guid_remote_bare_rejected-evt_remote_bare_rejected'
  const failedTaskId = 'feishu-task-task_guid_remote_bare_failed-evt_remote_bare_failed'
  const safeHelpTaskId = 'feishu-task-task_guid_remote_safe_help-evt_remote_safe_help'

  try {
    await runtime.start()

    await fakeFeishu.emit({ eventId: 'evt_remote_bare_rejected', taskGuid: 'task_guid_remote_bare_rejected', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(rejectedTaskId, { status: 'rejected', errorMsg: jwt })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[rejectedTaskId]?.lastError, jwt))

    await fakeFeishu.emit({ eventId: 'evt_remote_bare_failed', taskGuid: 'task_guid_remote_bare_failed', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(failedTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'failed',
        summary: '远程执行失败。',
        error: providerToken,
      })}`,
    })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[failedTaskId]?.lastError, providerToken))

    for (const [index, probe] of [jwt, providerToken, secretMarker, highEntropyToken].entries()) {
      const taskGuid = `task_guid_remote_bare_help_${index}`
      const eventId = `evt_remote_bare_help_${index}`
      const taskId = `feishu-task-${taskGuid}-${eventId}`
      await fakeFeishu.emit({ eventId, taskGuid, eventTypes: ['task_create'], timestamp: '1775793266155' })
      fakeAamp.emitHelp(taskId, { question: probe })
      await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed'))
    }

    const safeQuestion = '请提供目标群 ID，我会继续处理。'
    await fakeFeishu.emit({ eventId: 'evt_remote_safe_help', taskGuid: 'task_guid_remote_safe_help', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitHelp(safeHelpTaskId, { question: safeQuestion })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[safeHelpTaskId]?.status, 'help_needed'))

    const combinedProbes = `${jwt} ${providerToken} ${secretMarker} ${highEntropyToken}`
    fakeAamp.errorHandler?.(new Error(combinedProbes))
    await waitFor(() => assert.equal(runtime.getStateSnapshot().lastError, combinedProbes))

    const comments = fakeFeishu.comments.map((entry) => entry.content)
    for (const probe of [jwt, providerToken, secretMarker, highEntropyToken]) {
      assert.equal(comments.filter((entry) => entry === probe).length, 1, probe)
    }
    assert.equal(comments.filter((entry) => entry === safeQuestion).length, 1)
    assert.equal(comments.filter((entry) => entry.includes('REMOTE_AGENT_FAILED')).length, 0)

    await runtime.stop()
    const persistedState = await readFile(path.join(configDir, 'state.json'), 'utf8')
    const evidence = [
      comments.join('\n'),
      persistedState,
      logs.join('\n'),
    ].join('\n')
    for (const probe of [jwt, providerToken, secretMarker, highEntropyToken, combinedProbes]) {
      assert.equal(evidence.includes(probe), true, probe)
    }
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime surfaces remote help questions verbatim including timezone and path-like text', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const questions = [
    '0123456789abcdef0123456789abcdef',
    '请提供 0123456789abcdef 0123456789abcdef',
    '请提供 g123456789abcdef h123456789abcdef',
    '请读取 relative/private.json',
    '请提供 ｓｋ－ｐｒｏｊ－ＡＢＣＤＥＦ１２３４５６７８９０',
    '请读取 ./private.json',
    '请读取 ../private.json',
    '请读取 ~/private.json',
    String.raw`请读取 C:\Users\private\secret.txt`,
    String.raw`请读取 \\private-server\secret\payload.txt`,
    '请读取「relative/private.json」。',
    '请查看 https://bytedance.larkoffice.com/docx/E6bddi2EAoZzKcx9irBcILi1nCc 并提供 SECRET_SENTINEL',
    '请查看 https://user:password@example.com/task/0123456789abcdef',
    '请查看 https://example.com/task/0123456789abcdef?access_token=public-value',
    '请查看 https://example.com/task/0123456789abcdef?ａｃｃｅｓｓ＿ｔｏｋｅｎ=ｐｕｂｌｉｃ',
    '请查看 https://example.com/task/0123456789abcdef#sk-proj-ABCDEF1234567890',
    '请查看 https://example.com/task/sk-proj-ABCDEF1234567890',
    '请查看 https://0123456789abcdef0123456789abcdef.example.com/task',
    '请查看 https:/example.com/task/0123456789abcdef',
    '请提供目标群 ID，我会继续处理。',
    '请查看 https://example.com/docs/guide.html 并确认是否继续。',
    '请查看 https://example.com/docs/guide.html?page=2#usage 并确认是否继续。',
    'https://bytedance.larkoffice.com/docx/E6bddi2EAoZzKcx9irBcILi1nCc',
    'https://example.com/task/0123456789abcdef',
    // Regression: IANA timezone hints must be shown verbatim, not treated as a leaked relative path.
    '请提供你所在的时区，例如 Asia/Shanghai，我再继续查询今天的日程。',
    '请提供你所在的时区，例如 America/New_York。',
    '请提供你所在的时区，例如 Europe/Berlin 或 Etc/GMT+8。',
  ]

  try {
    await runtime.start()

    for (const [index, question] of questions.entries()) {
      const taskGuid = `task_guid_remote_obfuscated_help_${index}`
      const eventId = `evt_remote_obfuscated_help_${index}`
      const taskId = `feishu-task-${taskGuid}-${eventId}`
      await fakeFeishu.emit({ eventId, taskGuid, eventTypes: ['task_create'], timestamp: '1775793266155' })
      fakeAamp.emitHelp(taskId, { question })
      await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed'))
    }

    for (const question of questions) {
      assert.equal(fakeFeishu.comments.filter((entry) => entry.content === question).length, 1, question)
    }

    await runtime.stop()
    const persistedState = await readFile(path.join(configDir, 'state.json'), 'utf8')
    const evidence = [
      fakeFeishu.comments.map((entry) => entry.content).join('\n'),
      persistedState,
      logs.join('\n'),
    ].join('\n')
    assert.equal(evidence.includes('REMOTE_AGENT_FAILED'), false)
    for (const question of questions) {
      assert.equal(evidence.includes(question), true, question)
    }
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime preserves credential-like local help text', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const taskGuid = 'task_guid_local_opaque_help'
  const eventId = 'evt_local_opaque_help'
  const taskId = `feishu-task-${taskGuid}-${eventId}`
  const question = '请提供 ｓｋ－ｐｒｏｊ－ＡＢＣＤＥＦ１２３４５６７８９０ 并读取 relative/private.json'

  try {
    await runtime.start()
    await fakeFeishu.emit({ eventId, taskGuid, eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitHelp(taskId, { question })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'help_needed'))
    assert.equal(fakeFeishu.comments.filter((entry) => entry.content === question).length, 1)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime surfaces remote AAMP and result help questions verbatim', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  let index = 0
  const dispatch = async (): Promise<string> => {
    const current = index
    index += 1
    const taskGuid = `task_guid_remote_help_${current}`
    const eventId = `evt_remote_help_${current}`
    await fakeFeishu.emit({ eventId, taskGuid, eventTypes: ['task_create'], timestamp: '1775793266155' })
    return `feishu-task-${taskGuid}-${eventId}`
  }

  try {
    await runtime.start()

    const questionTaskId = await dispatch()
    fakeAamp.emitHelp(questionTaskId, {
      question: '请提供 refreshToken=SECRET_REFRESH 和 /opt/private/config.json。',
      blockedReason: '等待凭证',
    })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[questionTaskId]?.status, 'help_needed'))

    const bodyTaskId = await dispatch()
    fakeAamp.emitHelp(bodyTaskId, {
      question: '',
      blockedReason: String.raw`请读取 \\private-server\secret\payload 和 C:\Users\private\token.txt`,
    })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[bodyTaskId]?.status, 'help_needed'))

    const resultTaskId = await dispatch()
    fakeAamp.emitResult(resultTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'need_help',
        summary: '需要凭证。',
        question: '请提供 session_token=SECRET_SESSION。',
      })}`,
    })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[resultTaskId]?.status, 'help_needed'))

    const safeQuestion = '请提供目标群 ID，我会继续处理。'
    const safeTaskId = await dispatch()
    fakeAamp.emitHelp(safeTaskId, { question: safeQuestion })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[safeTaskId]?.status, 'help_needed'))

    const safeResultQuestion = '请确认是否继续处理下一批任务。'
    const safeResultTaskId = await dispatch()
    fakeAamp.emitResult(safeResultTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'need_help',
        summary: '等待用户确认。',
        question: safeResultQuestion,
      })}`,
    })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[safeResultTaskId]?.status, 'help_needed'))

    const comments = fakeFeishu.comments.map((entry) => entry.content)
    assert.equal(comments.filter((comment) => comment === '请提供 refreshToken=SECRET_REFRESH 和 /opt/private/config.json。').length, 1)
    assert.equal(comments.filter((comment) => comment === String.raw`请读取 \\private-server\secret\payload 和 C:\Users\private\token.txt`).length, 1)
    assert.equal(comments.filter((comment) => comment.endsWith('请提供 session_token=SECRET_SESSION。')).length, 1)
    assert.equal(comments.filter((comment) => comment === safeQuestion).length, 1)
    assert.equal(comments.filter((comment) => comment.endsWith(safeResultQuestion)).length, 1)
    assert.equal(comments.filter((comment) => comment.includes('REMOTE_AGENT_FAILED')).length, 0)
    const evidence = [comments.join('\n'), runtime.getStateSnapshot().lastError ?? '', logs.join('\n')].join('\n')
    for (const sentinel of ['refreshToken=SECRET_REFRESH', '/opt/private', 'private-server', 'C:\\Users', 'session_token=SECRET_SESSION']) {
      assert.equal(evidence.includes(sentinel), true, sentinel)
    }
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime persists remote asynchronous AAMP failure messages verbatim', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const logs: string[] = []
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: (message) => { logs.push(String(message)) }, error: (message) => { logs.push(String(message)) } },
  })
  const sentinels = 'Authorization: Bearer SECRET_BEARER argv=["acpx","--cwd","/opt/private"]'

  try {
    await runtime.start()
    fakeAamp.errorHandler?.(new Error(sentinels))
    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().lastError, sentinels)
    })
    const evidence = [runtime.getStateSnapshot().lastError ?? '', logs.join('\n')].join('\n')
    assert.equal(evidence.includes(sentinels), true)
    assert.equal(evidence.includes('REMOTE_AGENT_FAILED'), false)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('exported result classifier accepts only credential-free HTTP(S) link outputs', () => {
  const makeResult = (url: string): TaskResult => ({
    protocolVersion: '1.1',
    intent: 'task.result',
    taskId: 'link-contract-task',
    status: 'completed',
    output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
      schema: 'feishu_task_result.v2',
      status: 'succeeded',
      summary: '链接已生成。',
      outputs: [{ kind: 'link_delivery', url }],
    })}`,
    from: 'agent@meshmail.ai',
    to: 'bridge@meshmail.ai',
  })

  for (const url of ['file:///opt/private', 'javascript:alert(1)', 'not a url', 'https://user:password@example.com/private']) {
    const disposition = classifyFeishuTaskResult(makeResult(url), 'remote')
    assert.equal(disposition.kind, 'failure')
    assert.equal(disposition.kind === 'failure' ? disposition.reason : '', 'final_contract')
    assert.doesNotMatch(disposition.kind === 'failure' ? disposition.message : '', /user:password|\/opt\/private/)
  }
  for (const url of ['https://example.com/result', 'http://example.com/result?q=1']) {
    assert.equal(classifyFeishuTaskResult(makeResult(url), 'remote').kind, 'succeeded')
  }
})

test('runtime rejects an unsafe link before writing a Task delivery', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildRemoteConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_unsafe_link-evt_unsafe_link'

  try {
    await runtime.start()
    await fakeFeishu.emit({ eventId: 'evt_unsafe_link', taskGuid: 'task_guid_unsafe_link', eventTypes: ['task_create'], timestamp: '1775793266155' })
    fakeAamp.emitResult(aampTaskId, {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"succeeded","summary":"链接已生成。","outputs":[{"kind":"link_delivery","url":"https://user:password@example.com/private"}]}',
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
    })
    assert.deepEqual(fakeFeishu.textDeliveries, [])
    assert.doesNotMatch(fakeFeishu.comments.map((entry) => entry.content).join('\n'), /user:password/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

for (const size of [50 * 1024 * 1024 - 1, 50 * 1024 * 1024, 50 * 1024 * 1024 + 1]) {
  test(`native Windows file delivery enforces 50 MiB boundary at ${size} bytes`, {
    skip: process.platform !== 'win32' && 'requires native Windows filesystem',
  }, async () => {
    const { open, mkdir } = await import('node:fs/promises')
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-delivery-boundary-'))
    const fakeAamp = new FakeAampClient()
    const fakeFeishu = new FakeFeishuTaskClient()
    const taskGuid = `boundary_${size}`
    const eventId = `boundary_event_${size}`
    const directory = path.join(configDir, '验收 产物')
    await mkdir(directory)
    const filePath = path.join(directory, '结果 report.csv')
    const file = await open(filePath, 'w')
    await file.truncate(size)
    await file.close()
    fakeFeishu.tasks[taskGuid] = {
      guid: taskGuid, summary: 'Windows delivery boundary', status: 'todo', agentTaskStatus: 3,
      comments: [{ id: eventId, authorType: 'user', authorId: 'ou_human', content: 'Deliver the generated file', createdAt: '1775793266100' }],
    }
    const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
      configDir, aampClient: fakeAamp, feishuClient: fakeFeishu,
      logger: { log: () => {}, error: () => {} },
    })
    try {
      await runtime.start()
      await fakeFeishu.emit({eventId, taskGuid, eventTypes: ['task_comment_create'], timestamp: '1775793266155'})
      assert.equal(fakeAamp.sentTasks.length, 1)
      fakeAamp.emitResult(`feishu-task-${taskGuid}-${eventId}`, {
        output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({schema: 'feishu_task_result.v2', status: 'succeeded', outputs: [{kind: 'file_delivery', path: filePath}]})}`,
      })
      if (size <= 50 * 1024 * 1024) {
        await waitFor(() => assert.deepEqual(fakeFeishu.completedTaskGuids, [taskGuid]), 10000)
        assert.deepEqual(fakeFeishu.uploadedDeliveries, [{taskGuid, filePath}])
        assert.equal(fakeFeishu.uploadedDeliveryContents[0].length, size)
      } else {
        await waitFor(() => assert.ok(fakeFeishu.comments.some(comment => /exceeds 50 MB/.test(comment.content))), 10000)
        assert.equal(fakeFeishu.uploadedDeliveries.length, 0)
      }
    } finally {
      await runtime.stop()
      await rm(configDir, {recursive: true, force: true})
    }
  })
}

test('runtime records cancelled result as stopped without completing or commenting on the Feishu task', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const taskId = 'feishu-task-task_guid_cancelled-evt_cancelled'

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_cancelled',
      taskGuid: 'task_guid_cancelled',
      eventTypes: ['task_create'],
      timestamp: '1775793266157',
    })

    fakeAamp.emitResult(taskId, { status: 'cancelled' })
    await waitFor(() => assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'cancelled'))
    assert.deepEqual(runtime.getStateSnapshot().tasks[taskId]?.resultHandledTaskIds, [taskId])
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.lastError, undefined)
    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])

    fakeAamp.emitResult(taskId, { status: 'completed', output: 'late result' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(runtime.getStateSnapshot().tasks[taskId]?.status, 'cancelled')
    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('controlled execution tags parent output writes and avoids legacy parent or child status writes', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const taskGuid = 'task_guid_controlled_writes'
  const childTaskGuid = 'child_guid_controlled_writes'
  fakeFeishu.tasks[taskGuid] = {
    guid: taskGuid,
    taskId: 't_controlled_writes',
    summary: '整理交付物',
    status: 'todo',
    subtasks: [{ guid: childTaskGuid, summary: '检查交付物', status: 'todo' }],
  }
  const feedback = controlledFeedbackRecords()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    controlledFeedbackTransport: feedback.transport,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 1,
  })
  const aampTaskId = `feishu-task-${taskGuid}-execution_1`

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_controlled_writes',
      taskGuid,
      eventTypes: ['task_agent_start'],
      executionId: 'execution_1',
      action: 'START',
      timestamp: '1775793266157',
    })

    fakeAamp.emitAck(aampTaskId)
    await waitFor(() => assert.equal(feedback.commands.length, 1))

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_controlled_writes')
    await waitFor(() => assert.ok(fakeAamp.streamHandlers.stream_controlled_writes))
    fakeAamp.emitStreamEvent('stream_controlled_writes', {
      id: 'controlled_step_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'todo' as AampStreamEvent['type'],
      payload: { items: [{ id: 'step_1', content: '正在整理交付物', status: 'completed' }] },
    })
    await waitFor(() => assert.deepEqual(feedback.states.map(({ state }) => state), [1]))
    await waitFor(() => assert.ok(fakeFeishu.writes.some((write) => write.method === 'appendTaskSteps')))

    fakeAamp.emitResult(aampTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已完成交付。',
        outputs: [
          { kind: 'reply_comment', content: '交付物已完成。' },
          { kind: 'link_delivery', url: 'https://example.com/result' },
          { kind: 'text_delivery', title: '报告', format: 'markdown', content: '# 报告' },
        ],
      })}`,
    })
    await waitFor(() => assert.ok(feedback.states.some(({ state }) => state === 3)))

    const parentWrites = fakeFeishu.writes.filter((write) => write.taskGuid === taskGuid)
    for (const method of ['commentTask', 'appendTaskSteps', 'appendTextDeliveries', 'uploadTaskDelivery']) {
      assert.ok(parentWrites.some((write) => write.method === method), `missing ${method}`)
    }
    assert.ok(parentWrites.every((write) => write.executionId === 'execution_1'))
    const childWrites = fakeFeishu.writes.filter((write) => write.taskGuid === childTaskGuid)
    assert.deepEqual(childWrites, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})
