import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { loadBridgeState, saveBridgeState } from './config.js'
import { buildFeishuTaskPromptRules } from './dispatch.js'
import { FeishuTaskBridgeRuntime } from './runtime.js'
import type {
  BridgeConfig,
  FeishuDownloadedAttachment,
  FeishuTaskAttachment,
  FeishuTaskClient,
  FeishuTaskDetails,
  FeishuTaskEvent,
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

  on(event: 'connected', handler: () => void): void
  on(event: 'disconnected', handler: (reason?: string) => void): void
  on(event: 'error', handler: (error: Error) => void): void
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
    this.sentTasks.push(opts)
    return { taskId: opts.taskId ?? 'generated-task-id', messageId: 'aamp_message_1' }
  }

  async updateDirectoryProfile(): Promise<void> {}

  async subscribeStream(
    streamId: string,
    handlers: { onEvent: (event: AampStreamEvent) => void; onError?: (error: Error) => void },
  ): Promise<StreamSubscription> {
    this.streamHandlers[streamId] = handlers
    return {
      close: () => {
        delete this.streamHandlers[streamId]
      },
    }
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

  emitHelp(taskId: string, question: string): void {
    this.helpHandler?.({
      protocolVersion: '1.1',
      intent: 'task.help_needed',
      taskId,
      question,
      blockedReason: 'ACP agent requested clarification',
      suggestedOptions: [],
      from: 'agent@meshmail.ai',
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

  emitStreamOpened(taskId: string, streamId: string): void {
    this.streamOpenedHandler?.({
      protocolVersion: '1.1',
      intent: 'task.stream.opened',
      taskId,
      streamId,
      from: 'agent@meshmail.ai',
      to: 'bridge@meshmail.ai',
    })
  }

  emitStreamEvent(streamId: string, event: Partial<AampStreamEvent> & { type: AampStreamEvent['type']; payload: Record<string, unknown> }): void {
    this.streamHandlers[streamId]?.onEvent({
      streamId,
      taskId: event.taskId ?? 'unknown-task',
      seq: event.seq ?? 1,
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: event.type,
      payload: event.payload,
      ...(event.id ? { id: event.id } : {}),
    })
  }

  emitError(error: Error): void {
    this.errorHandler?.(error)
  }
}

class FakeFeishuTaskClient implements FeishuTaskClient {
  eventHandler?: (event: FeishuTaskEvent) => Promise<void>
  lifecycle: string[] = []
  registerAgentCalls = 0
  subscribeTaskEventsCalls = 0
  comments: Array<{ taskGuid: string; content: string }> = []
  steps: Array<{ taskGuid: string; content: string }> = []
  stepBatches: Array<{ taskGuid: string; contents: string[] }> = []
  inProgressTaskGuids: string[] = []
  textDeliveries: Array<{ taskGuid: string; urls: string[] }> = []
  uploadedDeliveries: Array<{ taskGuid: string; filePath: string }> = []
  uploadedDeliveryContents: string[] = []
  completedTaskGuids: string[] = []
  blockedTaskGuids: string[] = []
  getTaskBaseCalls: string[] = []
  stepFailures = 0
  textDeliveryFailures = 0
  completeFailures = 0
  blockFailures = 0
  commentFailures = 0
  commentTaskDelayMs = 0
  getTaskCalls: string[] = []
  listSubtaskCalls: string[] = []
  listCommentCalls: string[] = []
  getCommentCalls: string[] = []
  getAppOwnerCalls: string[] = []
  downloadAttachmentCalls: string[] = []
  tasks: Record<string, FeishuTaskDetails> = {}
  pointComments: Record<string, NonNullable<FeishuTaskDetails['comments']>[number]> = {}
  downloadedAttachments: Record<string, { content: Buffer; contentType?: string; attachment?: Partial<FeishuTaskAttachment> }> = {}
  appOwner: { ownerId: string } | null = { ownerId: 'ou_human' }

  async start(onEvent: (event: FeishuTaskEvent) => Promise<void>): Promise<void> {
    this.lifecycle.push('start')
    this.eventHandler = onEvent
  }

  async stop(): Promise<void> {}

  async registerAgent(): Promise<void> {
    this.lifecycle.push('registerAgent')
    this.registerAgentCalls += 1
  }

  async subscribeTaskEvents(): Promise<void> {
    this.lifecycle.push('subscribeTaskEvents')
    this.subscribeTaskEventsCalls += 1
  }

  async getTask(taskGuid: string): Promise<FeishuTaskDetails> {
    this.getTaskCalls.push(taskGuid)
    if (this.tasks[taskGuid]) return this.tasks[taskGuid]
    return {
      guid: taskGuid,
      taskId: 't456',
      summary: '整理上线方案',
      status: 'todo',
    }
  }

  async getTaskBase(taskGuid: string): Promise<FeishuTaskDetails> {
    this.getTaskBaseCalls.push(taskGuid)
    const task = this.tasks[taskGuid] ?? {
      guid: taskGuid,
      taskId: 't456',
      summary: '整理上线方案',
      status: 'todo' as const,
    }
    const { comments: _comments, subtasks: _subtasks, ...baseTask } = task
    return baseTask
  }

  async listSubtasks(taskGuid: string): Promise<NonNullable<FeishuTaskDetails['subtasks']>> {
    this.listSubtaskCalls.push(taskGuid)
    return this.tasks[taskGuid]?.subtasks ?? []
  }

  async listComments(taskGuid: string): Promise<NonNullable<FeishuTaskDetails['comments']>> {
    this.listCommentCalls.push(taskGuid)
    return this.tasks[taskGuid]?.comments ?? []
  }

  async getComment(commentId: string): Promise<NonNullable<FeishuTaskDetails['comments']>[number] | null> {
    this.getCommentCalls.push(commentId)
    return this.pointComments[commentId] ?? null
  }

  async getAppOwner(): Promise<{ ownerId: string }> {
    this.getAppOwnerCalls.push('cli_xxx')
    if (!this.appOwner) throw new Error('app owner unavailable')
    return this.appOwner
  }

  async downloadAttachment(attachment: FeishuTaskAttachment): Promise<FeishuDownloadedAttachment> {
    this.downloadAttachmentCalls.push(attachment.guid)
    const downloaded = this.downloadedAttachments[attachment.guid]
    if (!downloaded) throw new Error(`missing fake attachment ${attachment.guid}`)
    return {
      attachment: {
        ...attachment,
        ...downloaded.attachment,
      },
      content: downloaded.content,
      ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
    }
  }

  async commentTask(taskGuid: string, content: string): Promise<void> {
    if (this.commentTaskDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.commentTaskDelayMs))
    }
    if (this.commentFailures > 0) {
      this.commentFailures -= 1
      throw Object.assign(new Error('temporary comment failure'), { code: 'ECONNRESET' })
    }
    this.comments.push({ taskGuid, content })
  }

  async completeTask(taskGuid: string): Promise<void> {
    if (this.completeFailures > 0) {
      this.completeFailures -= 1
      throw new Error('complete failed')
    }
    this.completedTaskGuids.push(taskGuid)
  }

  async markTaskWaitingForHuman(taskGuid: string): Promise<void> {
    if (this.blockFailures > 0) {
      this.blockFailures -= 1
      throw new Error('block failed')
    }
    this.blockedTaskGuids.push(taskGuid)
  }

  async appendTaskStep(taskGuid: string, content: string): Promise<void> {
    await this.appendTaskSteps(taskGuid, [content])
  }

  async appendTaskSteps(taskGuid: string, contents: string[]): Promise<void> {
    if (this.stepFailures > 0) {
      this.stepFailures -= 1
      throw new Error('append step failed')
    }
    this.stepBatches.push({ taskGuid, contents })
    this.steps.push(...contents.map((content) => ({ taskGuid, content })))
  }

  async appendTextDeliveries(taskGuid: string, urls: string[]): Promise<void> {
    if (this.textDeliveryFailures > 0) {
      this.textDeliveryFailures -= 1
      throw Object.assign(new Error('temporary text delivery failure'), { response: { status: 500 } })
    }
    this.textDeliveries.push({ taskGuid, urls })
  }

  async uploadTaskDelivery(taskGuid: string, filePath: string): Promise<void> {
    this.uploadedDeliveries.push({ taskGuid, filePath })
    this.uploadedDeliveryContents.push(await readFile(filePath, 'utf8'))
  }

  async markTaskInProgress(taskGuid: string): Promise<void> {
    this.inProgressTaskGuids.push(taskGuid)
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

function buildBoeConfig(): BridgeConfig {
  const config = buildConfig()
  config.feishu.domain = 'https://open.feishu-boe.cn'
  config.feishu.headers = { 'x-tt-env': 'boe_task_event' }
  return config
}

function captureLogger(): { logs: string[]; errors: string[]; logger: Pick<Console, 'error' | 'log'> } {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    logger: {
      log: (message?: unknown) => {
        logs.push(String(message))
      },
      error: (message?: unknown) => {
        errors.push(String(message))
      },
    },
  }
}

test('runtime registers Feishu task agent before starting listener and records local state', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildBoeConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()

    assert.deepEqual(fakeFeishu.lifecycle, ['registerAgent', 'subscribeTaskEvents', 'start'])
    const state = await loadBridgeState(configDir)
    assert.equal(state.agentRegistration?.appId, 'cli_xxx')
    assert.equal(state.agentRegistration?.domain, 'https://open.feishu-boe.cn')
    assert.equal(state.agentRegistration?.env, 'boe_task_event')
    assert.ok(state.agentRegistration?.registeredAt)
    assert.equal(state.taskSubscription?.appId, 'cli_xxx')
    assert.equal(state.taskSubscription?.domain, 'https://open.feishu-boe.cn')
    assert.equal(state.taskSubscription?.env, 'boe_task_event')
    assert.equal(state.taskSubscription?.userIdType, 'open_id')
    assert.ok(state.taskSubscription?.subscribedAt)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime skips Feishu task agent registration when local state matches current app and environment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const config = buildBoeConfig()
  const firstFeishu = new FakeFeishuTaskClient()
  const firstRuntime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: firstFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const secondFeishu = new FakeFeishuTaskClient()
  const secondRuntime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: secondFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await firstRuntime.start()
    await firstRuntime.stop()

    await secondRuntime.start()

    assert.equal(firstFeishu.registerAgentCalls, 1)
    assert.equal(firstFeishu.subscribeTaskEventsCalls, 1)
    assert.equal(secondFeishu.registerAgentCalls, 0)
    assert.equal(secondFeishu.subscribeTaskEventsCalls, 0)
    assert.deepEqual(secondFeishu.lifecycle, ['start'])
  } finally {
    await secondRuntime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime subscribes task events when upgrading from registration-only local state', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const config = buildBoeConfig()
  await saveBridgeState({
    version: 1,
    connectivity: {
      feishu: 'disconnected',
      aamp: 'disconnected',
    },
    agentRegistration: {
      appId: 'cli_xxx',
      domain: 'https://open.feishu-boe.cn',
      env: 'boe_task_event',
      registeredAt: '2026-06-09T00:00:00.000Z',
    },
    tasks: {},
    dedupEventIds: {},
    dedupSemanticEventKeys: {},
    ackCommentedEventKeys: {},
    permissionDeniedCommentNoticeKeys: {},
  }, configDir)

  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()

    assert.equal(fakeFeishu.registerAgentCalls, 0)
    assert.equal(fakeFeishu.subscribeTaskEventsCalls, 1)
    assert.deepEqual(fakeFeishu.lifecycle, ['subscribeTaskEvents', 'start'])

    const state = await loadBridgeState(configDir)
    assert.equal(state.taskSubscription?.appId, 'cli_xxx')
    assert.equal(state.taskSubscription?.domain, 'https://open.feishu-boe.cn')
    assert.equal(state.taskSubscription?.env, 'boe_task_event')
    assert.equal(state.taskSubscription?.userIdType, 'open_id')
    assert.ok(state.taskSubscription?.subscribedAt)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime force-registers Feishu task agent even when local state matches', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const config = buildBoeConfig()
  const firstFeishu = new FakeFeishuTaskClient()
  const firstRuntime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: firstFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const secondFeishu = new FakeFeishuTaskClient()
  const secondRuntime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: secondFeishu,
    forceRegisterAgent: true,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await firstRuntime.start()
    await firstRuntime.stop()

    await secondRuntime.start()

    assert.equal(secondFeishu.registerAgentCalls, 1)
    assert.equal(secondFeishu.subscribeTaskEventsCalls, 0)
    assert.deepEqual(secondFeishu.lifecycle, ['registerAgent', 'start'])
  } finally {
    await secondRuntime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime prunes old terminal task state while retaining active and recent tasks', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const now = Date.now()
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
  await saveBridgeState({
    version: 1,
    connectivity: {
      feishu: 'disconnected',
      aamp: 'disconnected',
    },
    tasks: {
      old_completed: {
        taskGuid: 'task_old_completed',
        aampTaskId: 'old_completed',
        status: 'completed',
        resultAppliedOutputKeys: ['output:0:link_delivery:abc'],
        createdAt: daysAgo(12),
        updatedAt: daysAgo(8),
      },
      old_help_needed: {
        taskGuid: 'task_old_help_needed',
        aampTaskId: 'old_help_needed',
        status: 'help_needed',
        createdAt: daysAgo(35),
        updatedAt: daysAgo(31),
      },
      recent_failed: {
        taskGuid: 'task_recent_failed',
        aampTaskId: 'recent_failed',
        status: 'failed',
        createdAt: daysAgo(3),
        updatedAt: daysAgo(2),
      },
      active_dispatched: {
        taskGuid: 'task_active_dispatched',
        aampTaskId: 'active_dispatched',
        status: 'dispatched',
        createdAt: daysAgo(60),
        updatedAt: daysAgo(60),
      },
    },
    dedupEventIds: {},
    dedupSemanticEventKeys: {},
    ackCommentedEventKeys: {},
    permissionDeniedCommentNoticeKeys: {},
  }, configDir)
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: new FakeAampClient(),
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()

    const tasks = runtime.getStateSnapshot().tasks
    assert.equal(tasks.old_completed, undefined)
    assert.equal(tasks.old_help_needed, undefined)
    assert.ok(tasks.recent_failed)
    assert.ok(tasks.active_dispatched)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches Feishu task events and comments on task.ack once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_456',
      taskGuid: 'task_guid_456',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.taskId, 'feishu-task-task_guid_456-evt_456')
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.required_skill, undefined)
    assert.equal(fakeAamp.sentTasks[0]?.promptRules, buildFeishuTaskPromptRules())
    assert.equal(fakeAamp.sentTasks[0]?.rawBodyText, fakeAamp.sentTasks[0]?.bodyText)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /^Critical final-response protocol:/)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /Execution Ownership Contract:[\s\S]*\n\nFeishu Event:[\s\S]*\n\nFeishu Task:/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /existing Feishu task delegation/)
    assert.doesNotMatch(fakeAamp.sentTasks[0]?.bodyText ?? '', /existing Feishu task delegation/)
    assert.doesNotMatch(fakeAamp.sentTasks[0]?.rawBodyText ?? '', /This email was sent by AAMP/)

    fakeAamp.emitAck('feishu-task-task_guid_456-evt_456')
    fakeAamp.emitAck('feishu-task-task_guid_456-evt_456')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(fakeFeishu.comments.length, 1)
    assert.equal(fakeFeishu.comments[0]?.taskGuid, 'task_guid_456')
    assert.match(fakeFeishu.comments[0]?.content ?? '', /已收到任务派发请求/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime keeps configured Feishu lark-cli profile out of dispatch context and puts it in prompt rules', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const config = buildConfig()
  config.feishu.authMode = 'lark-cli'
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
      timestamp: '1775793266152',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_lark_cli_profile, undefined)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /Feishu lark-cli profile rules:/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /--profile custom-feishu-profile/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /unset -f git 2>\/dev\/null \|\| true; env -u 'BASH_FUNC_git%%' lark-cli --profile custom-feishu-profile/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores duplicate task_create events for the same Feishu task even when event id changes', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_first_create',
      taskGuid: 'task_guid_replayed_create',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })
    fakeAamp.emitAck('feishu-task-task_guid_replayed_create-evt_first_create')
    await new Promise((resolve) => setTimeout(resolve, 0))

    await fakeFeishu.emit({
      eventId: 'evt_second_create',
      taskGuid: 'task_guid_replayed_create',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeFeishu.comments.length, 1)
    const state = await loadBridgeState(configDir)
    assert.equal(state.lastIgnoredFeishuEventId, 'evt_second_create')
    assert.equal(state.lastIgnoredFeishuEventReason, 'duplicate_task_event')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime forwards Feishu task attachments to AAMP dispatch', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_with_attachments = {
    guid: 'task_with_attachments',
    taskId: 't_attach',
    summary: '分析附件',
    status: 'todo',
    attachments: [
      {
        guid: 'att_parent',
        kind: 'task_attachment',
        name: 'input.png',
        size: 4,
        resourceType: 'task',
        resourceId: 'task_with_attachments',
      },
    ],
    attachmentDeliveries: [
      {
        guid: 'att_delivery',
        kind: 'task_delivery',
        name: 'previous.txt',
        size: 8,
        resourceType: 'task_delivery',
        resourceId: 'task_with_attachments',
      },
    ],
    subtasks: [
      {
        guid: 'child_attach',
        taskId: 't_child_attach',
        summary: '子任务附件',
        status: 'todo',
        attachments: [
          {
            guid: 'att_child',
            kind: 'task_attachment',
            name: 'child.csv',
            size: 6,
            resourceType: 'task',
            resourceId: 'child_attach',
          },
        ],
      },
    ],
  }
  fakeFeishu.downloadedAttachments.att_parent = { content: Buffer.from('png\n'), contentType: 'image/png' }
  fakeFeishu.downloadedAttachments.att_delivery = { content: Buffer.from('previous'), contentType: 'text/plain' }
  fakeFeishu.downloadedAttachments.att_child = { content: Buffer.from('a,b\n1,2'), contentType: 'text/csv' }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_attach',
      taskGuid: 'task_with_attachments',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    const sent = fakeAamp.sentTasks[0]
    assert.ok(sent)
    assert.deepEqual(fakeFeishu.downloadAttachmentCalls, ['att_parent', 'att_delivery', 'att_child'])
    assert.equal(sent.attachments?.length, 3)
    assert.deepEqual(sent.attachments?.map((attachment) => attachment.filename), [
      'task-task_wit-input.png',
      'delivery-task_wit-previous.txt',
      'child-1-child_at-child.csv',
    ])
    assert.equal(sent.attachments?.[0]?.contentType, 'image/png')
    assert.equal(sent.attachments?.[1]?.contentType, 'text/plain')
    assert.equal(sent.attachments?.[2]?.contentType, 'text/csv')
    assert.match(sent.bodyText ?? '', /Task attachments:/)
    assert.match(sent.bodyText ?? '', /input\.png \| guid=att_parent \| kind=task_attachment/)
    assert.match(sent.bodyText ?? '', /Task delivery attachments:/)
    assert.match(sent.bodyText ?? '', /previous\.txt \| guid=att_delivery \| kind=task_delivery/)
    assert.match(sent.bodyText ?? '', /Child task attachments:/)
    assert.match(sent.bodyText ?? '', /child\.csv \| guid=att_child \| kind=task_attachment/)
    assert.doesNotMatch(sent.bodyText ?? '', /Attachment notes:/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime keeps dispatching when Feishu attachment download fails', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_with_bad_attachment = {
    guid: 'task_with_bad_attachment',
    taskId: 't_bad_attach',
    summary: '分析缺失附件',
    status: 'todo',
    attachments: [
      {
        guid: 'att_missing',
        kind: 'task_attachment',
        name: 'missing.pdf',
        size: 1024,
      },
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
      eventId: 'evt_bad_attach',
      taskGuid: 'task_with_bad_attachment',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    const sent = fakeAamp.sentTasks[0]
    assert.ok(sent)
    assert.equal(sent.attachments, undefined)
    assert.match(sent.bodyText ?? '', /Attachment notes:/)
    assert.match(sent.bodyText ?? '', /Failed to download missing\.pdf guid=att_missing kind=task_attachment 1024 bytes from task:task_with_bad_attachment/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime logs concise task lifecycle without repeated internal status noise', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const { logs, logger } = captureLogger()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger,
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_log',
      taskGuid: 'task_log',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    const aampTaskId = 'feishu-task-task_log-evt_log'
    fakeAamp.emitAck(aampTaskId)
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
    })

    fakeAamp.emitStreamOpened(aampTaskId, 'stream_log')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_log)
    })
    ;['正在分析需求', '正在查询天气', '正在生成 Markdown', '正在整理交付物'].forEach((label, index) => {
      fakeAamp.emitStreamEvent('stream_log', {
        id: `log_step_${index}`,
        taskId: aampTaskId,
        seq: index + 1,
        type: 'status',
        payload: { label },
      })
    })
    await waitFor(() => {
      assert.equal(fakeFeishu.stepBatches.length, 1)
    })

    fakeAamp.emitResult(aampTaskId, {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已回复。',
        outputs: [
          { kind: 'reply_comment', content: '深圳今天多云，适合出行。' },
        ],
      })}`,
    })
    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_log'])
      assert.match(logs.join('\n'), /\[task task_log\] completed parent=1 children=0/)
    })

    const text = logs.join('\n')
    assert.ok(logs.every((line) => line.startsWith('[info] ')), text)
    assert.match(text, /\[info\] \[task task_log event evt_log\] received kind=task_create types=task_create/)
    assert.match(text, /\[info\] \[task task_log event evt_log\] dispatch sent aamp_task=feishu-task-task_log-evt_log to=agent@meshmail\.ai/)
    assert.match(text, /\[info\] \[task task_log\] ack commented aamp_task=feishu-task-task_log-evt_log/)
    assert.match(text, /\[info\] \[task task_log\] marked in_progress parent=1 children=0/)
    assert.match(text, /\[info\] \[task task_log\] steps flushed count=4 total=4/)
    assert.match(text, /\[info\] \[task task_log\] result received aamp_task=feishu-task-task_log-evt_log status=completed/)
    assert.match(text, /\[info\] \[task task_log\] result outputs reply_comment=1 link_delivery=0 file_delivery=0 text_delivery=0/)
    assert.match(text, /\[info\] \[task task_log\] completed parent=1 children=0/)
    assert.doesNotMatch(text, /in-progress state already recorded/)
    assert.doesNotMatch(text, /get via v2/)
    assert.doesNotMatch(text, /comment via v2/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime logs and ignores ack events for unknown tasks without updating ack state', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const { logs, logger } = captureLogger()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger,
  })

  try {
    await runtime.start()
    fakeAamp.emitAck('unknown-task')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(runtime.getStateSnapshot().lastAampAckTaskId, undefined)
    assert.deepEqual(fakeFeishu.comments, [])
    assert.match(logs.join('\n'), /\[info\] \[aamp ack\] ignored reason=unknown_task task=unknown-task from=agent@meshmail\.ai/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime downgrades self-echo unknown ack logs to debug', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const { logs, logger } = captureLogger()
  const config = buildConfig()
  config.behavior.debug = true
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger,
  })

  try {
    await runtime.start()
    fakeAamp.emitAck('encoded-self-echo-task', 'bridge@meshmail.ai')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = logs.join('\n')
    assert.equal(runtime.getStateSnapshot().lastAampAckTaskId, undefined)
    assert.match(text, /\[debug\] \[aamp ack\] ignored reason=self_echo_unknown_task task=encoded-self-echo-task from=bridge@meshmail\.ai/)
    assert.doesNotMatch(text, /\[info\] \[aamp ack\] ignored reason=self_echo_unknown_task/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime prefixes debug and error logs with levels', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const { logs, errors, logger } = captureLogger()
  const config = buildConfig()
  config.behavior.debug = true
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger,
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_debug',
      taskGuid: 'task_debug',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })
    fakeAamp.emitAck('feishu-task-task_debug-evt_debug')
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
    })
    fakeAamp.emitError(new Error('mailbox unavailable'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(logs.some((line) => line.startsWith('[debug] ')), logs.join('\n'))
    assert.match(logs.join('\n'), /\[debug\] \[task task_debug\] ack received aamp_task=feishu-task-task_debug-evt_debug from=agent@meshmail\.ai/)
    assert.deepEqual(errors, ['[error] [aamp] mailbox unavailable'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores non-allowlisted Feishu task events before loading task details', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_summary',
      taskGuid: 'task_guid_summary',
      eventTypes: ['task_summary_update'],
      timestamp: '1775793266152',
    })

    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.equal(fakeAamp.sentTasks.length, 0)
    const state = runtime.getStateSnapshot()
    assert.equal(state.lastIgnoredFeishuEventId, 'evt_summary')
    assert.equal(state.lastIgnoredFeishuEventTaskGuid, 'task_guid_summary')
    assert.deepEqual(state.lastIgnoredFeishuEventTypes, ['task_summary_update'])
    assert.equal(state.lastIgnoredFeishuEventReason, 'event_type_not_allowlisted')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores subtask create events after loading task details', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_subtask_create = {
    guid: 'task_guid_subtask_create',
    taskId: 't_subtask',
    summary: '子任务上下文',
    status: 'todo',
    parentGuid: 'task_guid_parent',
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
      eventId: 'evt_subtask_create',
      taskGuid: 'task_guid_subtask_create',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    assert.deepEqual(fakeFeishu.getTaskBaseCalls, ['task_guid_subtask_create'])
    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(fakeAamp.sentTasks.length, 0)
    const state = runtime.getStateSnapshot()
    assert.equal(state.lastIgnoredFeishuEventId, 'evt_subtask_create')
    assert.equal(state.lastIgnoredFeishuEventTaskGuid, 'task_guid_subtask_create')
    assert.deepEqual(state.lastIgnoredFeishuEventTypes, ['task_create'])
    assert.equal(state.lastIgnoredFeishuEventReason, 'subtask_create_context_only')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores task create events with reminders until reminder fire', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_reminder_create = {
    guid: 'task_guid_reminder_create',
    taskId: 't_reminder_create',
    summary: '明天提醒我写周报',
    status: 'todo',
    reminders: [{ timestamp: 1775793266 }],
  } as FeishuTaskDetails
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_reminder_create',
      taskGuid: 'task_guid_reminder_create',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    assert.deepEqual(fakeFeishu.getTaskBaseCalls, ['task_guid_reminder_create'])
    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(fakeAamp.sentTasks.length, 0)
    const state = runtime.getStateSnapshot()
    assert.equal(state.lastIgnoredFeishuEventId, 'evt_reminder_create')
    assert.equal(state.lastIgnoredFeishuEventTaskGuid, 'task_guid_reminder_create')
    assert.deepEqual(state.lastIgnoredFeishuEventTypes, ['task_create'])
    assert.equal(state.lastIgnoredFeishuEventReason, 'task_create_deferred_to_reminder')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores recurring task create events', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_rrule_create = {
    guid: 'task_guid_rrule_create',
    taskId: 't_rrule_create',
    summary: '每天发日报',
    status: 'todo',
    rrule: 'FREQ=DAILY',
  } as FeishuTaskDetails
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_rrule_create',
      taskGuid: 'task_guid_rrule_create',
      eventTypes: ['task_create'],
      timestamp: '1775793266152',
    })

    assert.deepEqual(fakeFeishu.getTaskBaseCalls, ['task_guid_rrule_create'])
    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(fakeAamp.sentTasks.length, 0)
    const state = runtime.getStateSnapshot()
    assert.equal(state.lastIgnoredFeishuEventId, 'evt_rrule_create')
    assert.equal(state.lastIgnoredFeishuEventTaskGuid, 'task_guid_rrule_create')
    assert.deepEqual(state.lastIgnoredFeishuEventTypes, ['task_create'])
    assert.equal(state.lastIgnoredFeishuEventReason, 'recurring_task_create_deferred')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches reminder fire Feishu task events', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_reminder_fire',
      taskGuid: 'task_guid_reminder_fire',
      eventTypes: ['task_reminder_fire'],
      timestamp: '1775793266154',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, undefined)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_task_event_types, undefined)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_reminder_fire/)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /raw_event_types: task_reminder_fire/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /task_reminder_fire/)
    assert.doesNotMatch(fakeAamp.sentTasks[0]?.bodyText ?? '', /reminder-fired Feishu task event/i)

    fakeAamp.emitAck('feishu-task-task_guid_reminder_fire-evt_reminder_fire')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(fakeFeishu.comments.length, 1)
    assert.equal(fakeFeishu.comments[0]?.content, '任务提醒已到期，正在转交智能体处理。')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches task execution events without assignment gating', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_other_app = {
    guid: 'task_guid_other_app',
    taskId: 't_other_app',
    summary: '整理上线方案',
    status: 'todo',
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
      eventId: 'evt_other_app',
      taskGuid: 'task_guid_other_app',
      eventTypes: ['task_reminder_fire'],
      timestamp: '1775793266154',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, undefined)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_reminder_fire/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches task execution events for active todo tasks', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_done_event = {
    guid: 'task_guid_done_event',
    taskId: 't_done_event',
    summary: '待执行任务',
    status: 'todo',
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
      eventId: 'evt_done_event',
      taskGuid: 'task_guid_done_event',
      eventTypes: ['task_reminder_fire'],
      timestamp: '1775793266154',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, undefined)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_reminder_fire/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime filters completed task events after loading only the base task', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_done_base = {
    guid: 'task_guid_done_base',
    taskId: 't_done_base',
    summary: '已完成事项',
    status: 'done',
    comments: [
      { id: 'comment_should_not_load', authorType: 'user', content: '不需要加载评论。' },
    ],
    subtasks: [
      { guid: 'child_should_not_load', summary: '不需要加载子任务。' },
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
      eventId: 'evt_done_base',
      taskGuid: 'task_guid_done_base',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.deepEqual(fakeFeishu.getTaskBaseCalls, ['task_guid_done_base'])
    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'task_not_active')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches comment events and writes reply ack comments', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_comment = {
    guid: 'task_guid_comment',
    taskId: 't_comment',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_user', authorType: 'user', authorId: 'ou_human', content: '请继续执行这个任务', createdAt: '1775793266100' },
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
      eventId: 'evt_comment',
      taskGuid: 'task_guid_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, undefined)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_comment/)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.skill_trigger_type, undefined)

    fakeAamp.emitAck('feishu-task-task_guid_comment-evt_comment')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(fakeFeishu.comments.length, 1)
    assert.equal(fakeFeishu.comments[0]?.content, '已收到您的回复，正在转交智能体处理。')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime logs list-comment fallback when comment events omit comment id', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const { logs, logger } = captureLogger()
  fakeFeishu.tasks.task_guid_comment_fallback = {
    guid: 'task_guid_comment_fallback',
    taskId: 't_comment_fallback',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_user_fallback', authorType: 'user', authorId: 'ou_human', content: '请继续执行这个任务', createdAt: '1775793266100' },
    ],
  }
  const config = buildConfig()
  config.behavior.debug = true
  const runtime = new FeishuTaskBridgeRuntime(config, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger,
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_comment_fallback',
      taskGuid: 'task_guid_comment_fallback',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.deepEqual(fakeFeishu.getCommentCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, ['task_guid_comment_fallback'])
    assert.match(
      logs.join('\n'),
      /\[debug\] \[feishu event evt_comment_fallback\] comment_id missing fallback=list_comments task=task_guid_comment_fallback/,
    )
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime filters current-app comment events after point-loading only the changed comment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.pointComments.comment_self_point = {
    id: 'comment_self_point',
    authorType: 'app',
    authorId: 'cli_xxx',
    content: '已收到您的回复，正在转交智能体处理。',
    createdAt: '1775793266100',
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
      eventId: 'evt_self_point_comment',
      taskGuid: 'task_guid_self_point_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
      raw: { comment_id: 'comment_self_point' },
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.deepEqual(fakeFeishu.getCommentCalls, ['comment_self_point'])
    assert.deepEqual(fakeFeishu.getTaskBaseCalls, [])
    assert.deepEqual(fakeFeishu.getTaskCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_authored_by_current_app')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime hydrates full task context only after a point-loaded comment is dispatchable', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.pointComments.comment_human_point = {
    id: 'comment_human_point',
    authorType: 'user',
    authorId: 'ou_human',
    content: '请继续执行这个任务',
    createdAt: '1775793266100',
  }
  fakeFeishu.tasks.task_guid_point_comment = {
    guid: 'task_guid_point_comment',
    taskId: 't_point_comment',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_human_point', authorType: 'user', authorId: 'ou_human', content: '请继续执行这个任务', createdAt: '1775793266100' },
    ],
    subtasks: [
      { guid: 'child_point_comment', taskId: 't_child_point_comment', summary: '检查灰度发布', status: 'todo' },
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
      eventId: 'evt_human_point_comment',
      taskGuid: 'task_guid_point_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
      raw: { comment_id: 'comment_human_point' },
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.deepEqual(fakeFeishu.getCommentCalls, ['comment_human_point'])
    assert.deepEqual(fakeFeishu.getTaskBaseCalls, ['task_guid_point_comment'])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, ['task_guid_point_comment'])
    assert.deepEqual(fakeFeishu.listCommentCalls, ['task_guid_point_comment'])
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /child_point_comment/)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /请继续执行这个任务/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores point-loaded human comments not authored by the app owner before loading task details', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.appOwner = { ownerId: 'ou_owner' }
  fakeFeishu.pointComments.comment_non_owner = {
    id: 'comment_non_owner',
    authorType: 'user',
    authorId: 'ou_other',
    content: '请继续执行这个任务',
    createdAt: '1775793266100',
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
      eventId: 'evt_non_owner_comment',
      taskGuid: 'task_guid_non_owner_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
      raw: { comment_id: 'comment_non_owner' },
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_non_owner_comment',
      content: '你没有权限通过评论触发此任务继续执行。当前仅应用 Owner 可以触发任务流转，请联系应用 Owner 处理。',
    }])
    assert.deepEqual(fakeFeishu.getCommentCalls, ['comment_non_owner'])
    assert.deepEqual(fakeFeishu.getAppOwnerCalls, ['cli_xxx'])
    assert.deepEqual(fakeFeishu.getTaskBaseCalls, [])
    assert.deepEqual(fakeFeishu.listSubtaskCalls, [])
    assert.deepEqual(fakeFeishu.listCommentCalls, [])
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_author_not_app_owner')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime comments permission denial only once for the same non-owner human comment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.appOwner = { ownerId: 'ou_owner' }
  fakeFeishu.pointComments.comment_non_owner_repeat = {
    id: 'comment_non_owner_repeat',
    authorType: 'user',
    authorId: 'ou_other',
    content: '继续执行',
    createdAt: '1775793266100',
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
      eventId: 'evt_non_owner_comment_repeat_one',
      taskGuid: 'task_guid_non_owner_repeat',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
      raw: { comment_id: 'comment_non_owner_repeat' },
    })
    await fakeFeishu.emit({
      eventId: 'evt_non_owner_comment_repeat_two',
      taskGuid: 'task_guid_non_owner_repeat',
      eventTypes: ['task_comment_update'],
      timestamp: '1775793267153',
      raw: { comment_id: 'comment_non_owner_repeat' },
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_non_owner_repeat',
      content: '你没有权限通过评论触发此任务继续执行。当前仅应用 Owner 可以触发任务流转，请联系应用 Owner 处理。',
    }])
    assert.deepEqual(fakeFeishu.getCommentCalls, ['comment_non_owner_repeat', 'comment_non_owner_repeat'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime serializes concurrent permission denial comments for the same non-owner human comment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.appOwner = { ownerId: 'ou_owner' }
  fakeFeishu.commentTaskDelayMs = 10
  fakeFeishu.pointComments.comment_non_owner_concurrent = {
    id: 'comment_non_owner_concurrent',
    authorType: 'user',
    authorId: 'ou_other',
    content: '继续执行',
    createdAt: '1775793266100',
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await Promise.all([
      fakeFeishu.emit({
        eventId: 'evt_non_owner_comment_concurrent_one',
        taskGuid: 'task_guid_non_owner_concurrent',
        eventTypes: ['task_comment_create'],
        timestamp: '1775793266153',
        raw: { comment_id: 'comment_non_owner_concurrent' },
      }),
      fakeFeishu.emit({
        eventId: 'evt_non_owner_comment_concurrent_two',
        taskGuid: 'task_guid_non_owner_concurrent',
        eventTypes: ['task_comment_update'],
        timestamp: '1775793267153',
        raw: { comment_id: 'comment_non_owner_concurrent' },
      }),
    ])

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_non_owner_concurrent',
      content: '你没有权限通过评论触发此任务继续执行。当前仅应用 Owner 可以触发任务流转，请联系应用 Owner 处理。',
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime caches app owner lookups for human comment filtering', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.appOwner = { ownerId: 'ou_owner' }
  fakeFeishu.pointComments.comment_owner_one = {
    id: 'comment_owner_one',
    authorType: 'user',
    authorId: 'ou_owner',
    content: '第一次继续',
    createdAt: '1775793266100',
  }
  fakeFeishu.pointComments.comment_owner_two = {
    id: 'comment_owner_two',
    authorType: 'user',
    authorId: 'ou_owner',
    content: '第二次继续',
    createdAt: '1775793266200',
  }
  fakeFeishu.tasks.task_guid_owner_one = {
    guid: 'task_guid_owner_one',
    taskId: 't_owner_one',
    summary: '整理上线方案 1',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [fakeFeishu.pointComments.comment_owner_one],
  }
  fakeFeishu.tasks.task_guid_owner_two = {
    guid: 'task_guid_owner_two',
    taskId: 't_owner_two',
    summary: '整理上线方案 2',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [fakeFeishu.pointComments.comment_owner_two],
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
      eventId: 'evt_owner_comment_one',
      taskGuid: 'task_guid_owner_one',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
      raw: { comment_id: 'comment_owner_one' },
    })
    await fakeFeishu.emit({
      eventId: 'evt_owner_comment_two',
      taskGuid: 'task_guid_owner_two',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793267153',
      raw: { comment_id: 'comment_owner_two' },
    })

    assert.equal(fakeAamp.sentTasks.length, 2)
    assert.deepEqual(fakeFeishu.getAppOwnerCalls, ['cli_xxx'])
    assert.equal((runtime.getStateSnapshot() as { appOwner?: { ownerId?: string } }).appOwner?.ownerId, 'ou_owner')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime dispatches comment events from non-current app authors', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_agent_author_comment = {
    guid: 'task_guid_agent_author_comment',
    taskId: 't_agent_author_comment',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      {
        id: 'comment_agent_author',
        authorType: 'app',
        authorId: 'cli_other',
        content: '请继续执行这个任务',
        createdAt: '1775793266100',
      },
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
      eventId: 'evt_agent_author_comment',
      taskGuid: 'task_guid_agent_author_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, undefined)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_comment/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores comment events when latest comment is authored by the current app', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_self_comment = {
    guid: 'task_guid_self_comment',
    taskId: 't_self_comment',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      {
        id: 'comment_self',
        authorType: 'app',
        authorId: 'cli_xxx',
        content: '已收到任务派发请求，正在转交智能体处理。',
        createdAt: '1775793266100',
      },
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
      eventId: 'evt_self_comment',
      taskGuid: 'task_guid_self_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_authored_by_current_app')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores comment events without an effective comment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_no_comment = {
    guid: 'task_guid_no_comment',
    taskId: 't_no_comment',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [],
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
      eventId: 'evt_no_comment',
      taskGuid: 'task_guid_no_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'comment_without_effective_comment')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores comment events without agent task status', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_missing_agent_status = {
    guid: 'task_guid_missing_agent_status',
    taskId: 't_missing_agent_status',
    summary: '整理上线方案',
    status: 'todo',
    comments: [
      { id: 'comment_user', authorType: 'user', authorId: 'ou_human', content: '继续执行这个任务', createdAt: '1775793266100' },
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
      eventId: 'evt_missing_agent_status',
      taskGuid: 'task_guid_missing_agent_status',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'agent_task_status_not_dispatchable')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime ignores comment events with unsupported agent task status', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_invalid_agent_status = {
    guid: 'task_guid_invalid_agent_status',
    taskId: 't_invalid_agent_status',
    summary: '整理上线方案',
    status: 'todo',
    agentTaskStatus: 99,
    comments: [
      { id: 'comment_user', authorType: 'user', authorId: 'ou_human', content: '继续执行这个任务', createdAt: '1775793266100' },
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
      eventId: 'evt_invalid_agent_status',
      taskGuid: 'task_guid_invalid_agent_status',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 0)
    assert.equal(runtime.getStateSnapshot().lastIgnoredFeishuEventReason, 'agent_task_status_not_dispatchable')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime includes BOE shell setup guidance when Feishu domain is BOE', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime({
    ...buildConfig(),
	    feishu: {
	      ...buildConfig().feishu,
	      domain: 'https://open.feishu-boe.cn/',
	      headers: { 'x-tt-env': 'boe_task_event' },
	    },
	  }, {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_boe',
      taskGuid: 'task_guid_boe',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.promptRules, buildFeishuTaskPromptRules({
      feishuEnvMode: 'boe',
      feishuEnv: 'boe_task_event',
    }))
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
    assert.doesNotMatch(fakeAamp.sentTasks[0]?.bodyText ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime includes PRE and PPE shell setup guidance from Feishu headers', async () => {
  for (const tc of [
    {
      name: 'pre',
      feishu: {
        ...buildConfig().feishu,
        domain: 'https://open.feishu-pre.cn',
        headers: { 'x-use-ppe': '1', 'x-tt-env': 'ppe_task_event' },
      },
      expected: /source ~\/lark-env\.sh pre --ppe-env-name ppe_task_event/,
    },
    {
      name: 'ppe',
      feishu: {
        ...buildConfig().feishu,
        headers: { 'x-use-ppe': '1', 'x-tt-env': 'ppe_task_event' },
      },
      expected: /source ~\/lark-env\.sh --ppe-env-name ppe_task_event/,
    },
  ]) {
    const configDir = await mkdtemp(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${tc.name}-`))
    const fakeAamp = new FakeAampClient()
    const fakeFeishu = new FakeFeishuTaskClient()
    const runtime = new FeishuTaskBridgeRuntime({
      ...buildConfig(),
      feishu: tc.feishu,
    }, {
      configDir,
      aampClient: fakeAamp,
      feishuClient: fakeFeishu,
      logger: { log: () => {}, error: () => {} },
    })

    try {
      await runtime.start()
      await fakeFeishu.emit({
        eventId: `evt_${tc.name}`,
        taskGuid: `task_guid_${tc.name}`,
        eventTypes: ['task_create'],
        timestamp: '1775793266154',
      })

      assert.equal(fakeAamp.sentTasks.length, 1)
      assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', tc.expected)
      assert.doesNotMatch(fakeAamp.sentTasks[0]?.bodyText ?? '', tc.expected)
    } finally {
      await runtime.stop()
      await rm(configDir, { recursive: true, force: true })
    }
  }
})

test('runtime converts selected stream events into throttled Feishu task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream',
      taskGuid: 'task_guid_stream',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream-evt_stream'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_1')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_1)
    })

    fakeAamp.emitStreamEvent('stream_1', {
      id: 's1',
      taskId: aampTaskId,
      seq: 1,
      type: 'text.delta',
      payload: { text: '这类 token 不应成为飞书 step' },
    })
    ;[
      'ACP task started',
      'Prompt sent to ACP agent',
      'ACP agent is composing the reply',
      'ACP response received',
    ].forEach((label, index) => {
      fakeAamp.emitStreamEvent('stream_1', {
        id: `s_internal_${index}`,
        taskId: aampTaskId,
        seq: 2 + index,
        type: 'status',
        payload: { label },
      })
    })
    fakeAamp.emitStreamEvent('stream_1', {
      id: 's2',
      taskId: aampTaskId,
      seq: 2,
      type: 'status',
      payload: { label: '正在分析需求' },
    })
    fakeAamp.emitStreamEvent('stream_1', {
      id: 's3',
      taskId: aampTaskId,
      seq: 3,
      type: 'status',
      payload: { label: '正在分析需求' },
    })
    fakeAamp.emitStreamEvent('stream_1', {
      id: 's4',
      taskId: aampTaskId,
      seq: 4,
      type: 'progress',
      payload: { label: '正在更新飞书任务' },
    })
    fakeAamp.emitStreamEvent('stream_1', {
      id: 's5',
      taskId: aampTaskId,
      seq: 5,
      type: 'artifact',
      payload: { url: 'https://example.invalid/file' },
    })
    fakeAamp.emitStreamEvent('stream_1', {
      id: 's6',
      taskId: aampTaskId,
      seq: 6,
      type: 'error',
      payload: { message: '工具调用失败' },
    })
    for (let i = 0; i < 40; i += 1) {
      fakeAamp.emitStreamEvent('stream_1', {
        id: `s_cap_${i}`,
        taskId: aampTaskId,
        seq: 10 + i,
        type: 'status',
        payload: { label: `额外进展 ${i + 1}` },
      })
    }

    await waitFor(() => {
      assert.equal(fakeFeishu.steps.length, 32)
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.lastStreamEventId, 's_cap_39')
    })

    assert.deepEqual(fakeFeishu.steps.map((step) => step.content), [
      '正在分析需求',
      '正在更新飞书任务',
      '执行遇到错误：工具调用失败',
      ...Array.from({ length: 29 }, (_, index) => `额外进展 ${index + 1}`),
    ])
    assert.ok(fakeFeishu.steps.every((step) => step.taskGuid === 'task_guid_stream'))

    const taskState = runtime.getStateSnapshot().tasks[aampTaskId]
    assert.equal(taskState?.streamId, 'stream_1')
    assert.equal(taskState?.lastStreamEventId, 's_cap_39')
    assert.equal(taskState?.streamStepCount, 32)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime batches selected stream events until the batch threshold', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream_batch',
      taskGuid: 'task_guid_stream_batch',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream_batch-evt_stream_batch'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_batch')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_batch)
    })

    for (let i = 0; i < 4; i += 1) {
      fakeAamp.emitStreamEvent('stream_batch', {
        id: `batch_${i + 1}`,
        taskId: aampTaskId,
        seq: i + 1,
        type: 'status',
        payload: { label: `批量进展 ${i + 1}` },
      })
    }

    await waitFor(() => {
      assert.equal(fakeFeishu.stepBatches.length, 1)
    })
    assert.deepEqual(fakeFeishu.stepBatches[0], {
      taskGuid: 'task_guid_stream_batch',
      contents: ['批量进展 1', '批量进展 2', '批量进展 3', '批量进展 4'],
    })
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime converts ACP todo and tool_call stream events into Feishu task steps', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream_acp_contract',
      taskGuid: 'task_guid_stream_acp_contract',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream_acp_contract-evt_stream_acp_contract'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_acp_contract')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_acp_contract)
    })

    ;[
      'ACP task started',
      'Prompt sent to ACP agent',
      'ACP agent is thinking',
      'ACP agent is composing the reply',
      'ACP response received',
    ].forEach((content, index) => {
      fakeAamp.emitStreamEvent('stream_acp_contract', {
        id: `internal_todo_${index}`,
        taskId: aampTaskId,
        seq: index + 1,
        type: 'todo',
        payload: {
          items: [{ id: `internal-${index}`, content, status: 'completed' }],
          summary: content,
        },
      })
    })

    fakeAamp.emitStreamEvent('stream_acp_contract', {
      id: 'todo_1',
      taskId: aampTaskId,
      seq: 10,
      type: 'todo',
      payload: {
        items: [
          { id: 'plan-1', content: '正在拆解任务', status: 'in_progress' },
          { id: 'plan-2', content: '正在查询上下文', status: 'pending' },
        ],
      },
    })
    fakeAamp.emitStreamEvent('stream_acp_contract', {
      id: 'todo_2',
      taskId: aampTaskId,
      seq: 11,
      type: 'todo',
      payload: { summary: '正在整理回复' },
    })
    ;[
      'Tool running: Read file',
      'Tool running: tool',
      'Tool completed: tool',
      'Tool running: Editing files',
      'Tool failed: tool',
    ].forEach((label, index) => {
      fakeAamp.emitStreamEvent('stream_acp_contract', {
        id: `ignored_tool_${index}`,
        taskId: aampTaskId,
        seq: 12 + index,
        type: 'tool_call',
        payload: {
          label,
          status: label.includes('failed') ? 'failed' : 'running',
        },
      })
    })
    fakeAamp.emitStreamEvent('stream_acp_contract', {
      id: 'tool_1',
      taskId: aampTaskId,
      seq: 20,
      type: 'tool_call',
      payload: {
        label: 'Tool completed: lark-cli task +update',
        status: 'completed',
      },
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.stepBatches[0], {
        taskGuid: 'task_guid_stream_acp_contract',
        contents: [
          '正在拆解任务',
          '正在查询上下文',
          '正在整理回复',
          'Tool completed: lark-cli task +update',
        ],
      })
    })
    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.streamStepCount, 4)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime marks parent and child tasks in progress on the first effective stream event', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_stream_start = {
    guid: 'task_guid_stream_start',
    taskId: 't_stream_start',
    summary: '整理执行计划',
    status: 'todo',
    subtasks: [
      { guid: 'child_stream_1', taskId: 't_child_stream_1', summary: '需求确认', status: 'todo' },
      { guid: 'child_stream_2', taskId: 't_child_stream_2', summary: '测试验收', status: 'todo' },
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
      eventId: 'evt_stream_start',
      taskGuid: 'task_guid_stream_start',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream_start-evt_stream_start'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_start')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_start)
    })

    fakeAamp.emitStreamEvent('stream_start', {
      id: 'start_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'status',
      payload: { label: 'ACP task started' },
    })
    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.lastStreamEventId, 'start_1')
    })
    assert.deepEqual(fakeFeishu.inProgressTaskGuids, [])

    fakeAamp.emitStreamEvent('stream_start', {
      id: 'start_2',
      taskId: aampTaskId,
      seq: 2,
      type: 'status',
      payload: { label: 'Prompt sent to ACP agent' },
    })
    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.lastStreamEventId, 'start_2')
    })
    assert.deepEqual(fakeFeishu.inProgressTaskGuids, [])

    fakeAamp.emitStreamEvent('stream_start', {
      id: 'start_3',
      taskId: aampTaskId,
      seq: 3,
      type: 'status',
      payload: { label: 'ACP agent is thinking' },
    })
    fakeAamp.emitStreamEvent('stream_start', {
      id: 'start_4',
      taskId: aampTaskId,
      seq: 4,
      type: 'status',
      payload: { label: '正在分析需求' },
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.inProgressTaskGuids, ['task_guid_stream_start', 'child_stream_1', 'child_stream_2'])
    })
    assert.deepEqual(runtime.getStateSnapshot().tasks[aampTaskId]?.feishuInProgressTaskIds, [
      'task_guid_stream_start',
      'child_stream_1',
      'child_stream_2',
    ])
    assert.equal(fakeFeishu.inProgressTaskGuids.filter((taskGuid) => taskGuid === 'task_guid_stream_start').length, 1)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime flushes pending stream steps after the flush interval', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 20,
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream_timer',
      taskGuid: 'task_guid_stream_timer',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream_timer-evt_stream_timer'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_timer')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_timer)
    })

    fakeAamp.emitStreamEvent('stream_timer', {
      id: 'timer_1',
      taskId: aampTaskId,
      seq: 1,
      type: 'status',
      payload: { label: '等待计时 flush' },
    })
    assert.equal(fakeFeishu.stepBatches.length, 0)

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.stepBatches[0], {
        taskGuid: 'task_guid_stream_timer',
        contents: ['等待计时 flush'],
      })
    })
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime keeps pending stream steps after a failed flush and retries on the flush interval', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.stepFailures = 1
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
    streamStepFlushIntervalMs: 20,
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_stream_retry',
      taskGuid: 'task_guid_stream_retry',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    const aampTaskId = 'feishu-task-task_guid_stream_retry-evt_stream_retry'
    fakeAamp.emitStreamOpened(aampTaskId, 'stream_retry')
    await waitFor(() => {
      assert.ok(fakeAamp.streamHandlers.stream_retry)
    })

    for (let i = 0; i < 4; i += 1) {
      fakeAamp.emitStreamEvent('stream_retry', {
        id: `retry_${i + 1}`,
        taskId: aampTaskId,
        seq: i + 1,
        type: 'status',
        payload: { label: `重试进展 ${i + 1}` },
      })
    }

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.stepBatches[0], {
        taskGuid: 'task_guid_stream_retry',
        contents: ['重试进展 1', '重试进展 2', '重试进展 3', '重试进展 4'],
      })
    })
    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.streamStepCount, 4)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime comments task.help_needed question and blocks the Feishu task once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_help',
      taskGuid: 'task_guid_help',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    fakeAamp.emitHelp(
      'feishu-task-task_guid_help-evt_help',
      'runtime 无法加载飞书任务，bot 身份读取 task_guid=task_guid_help 返回 not_found。',
    )
    fakeAamp.emitHelp(
      'feishu-task-task_guid_help-evt_help',
      'runtime 无法加载飞书任务，bot 身份读取 task_guid=task_guid_help 返回 not_found。',
    )
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, ['task_guid_help'])
    })

    assert.equal(fakeFeishu.comments.length, 1)
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.blockedTaskGuids, ['task_guid_help'])
    assert.deepEqual(fakeFeishu.comments[0], {
      taskGuid: 'task_guid_help',
      content: 'runtime 无法加载飞书任务，bot 身份读取 task_guid=task_guid_help 返回 not_found。',
    })

    const state = runtime.getStateSnapshot()
    assert.equal(state.lastAampHelpTaskId, 'feishu-task-task_guid_help-evt_help')
    assert.equal(state.tasks['feishu-task-task_guid_help-evt_help']?.status, 'help_needed')
    assert.deepEqual(state.tasks['feishu-task-task_guid_help-evt_help']?.helpCommentedTaskIds, ['feishu-task-task_guid_help-evt_help'])
    assert.deepEqual(state.tasks['feishu-task-task_guid_help-evt_help']?.feishuBlockedTaskIds, ['task_guid_help'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime treats needs_input questions as help-needed result', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_needs_input',
      taskGuid: 'task_guid_needs_input',
      eventTypes: ['task_create'],
      timestamp: '1775793266154',
    })

    fakeAamp.emitResult('feishu-task-task_guid_needs_input-evt_needs_input', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'needs_input',
        summary: '需要更多信息才能继续。',
        questions: [
          { question: '请提供 svc_core 仓库地址和 RocketMQ ConsumerGroup。', blocking: true },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, ['task_guid_needs_input'])
    })

    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_needs_input',
      content: '智能体需要更多信息才能继续处理该任务。\n\n请提供 svc_core 仓库地址和 RocketMQ ConsumerGroup。',
    }])
    assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_needs_input-evt_needs_input']?.status, 'help_needed')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime handles v2 reply_comment output and completes comment-triggered tasks', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_v2_reply = {
    guid: 'task_guid_v2_reply',
    taskId: 't_v2_reply',
    summary: '继续分析接口变更',
    status: 'todo',
    agentTaskStatus: 3,
    comments: [
      { id: 'comment_continue', authorType: 'user', authorId: 'ou_human', content: '请继续，并说明结论。', createdAt: '1775793266100' },
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
      eventId: 'evt_v2_reply',
      taskGuid: 'task_guid_v2_reply',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_v2_reply-evt_v2_reply', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已回复用户问题。',
        outputs: [
          { kind: 'reply_comment', content: '接口变更影响面已经确认，主要风险在鉴权字段。' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_v2_reply'])
      assert.equal(fakeFeishu.comments.length, 1)
    })

    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_v2_reply',
      content: '接口变更影响面已经确认，主要风险在鉴权字段。',
    }])
    assert.deepEqual(runtime.getStateSnapshot().tasks['feishu-task-task_guid_v2_reply-evt_v2_reply']?.resultCommentedTaskIds, [
      'feishu-task-task_guid_v2_reply-evt_v2_reply',
    ])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime uploads oversized reply comments as markdown delivery attachments', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
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
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
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
    assert.match(fakeFeishu.comments[0]?.content ?? '', /桥接器写入飞书失败/)
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

test('runtime handles v2 delivery outputs and completes child tasks before parent', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const deliveryFilePath = path.join(configDir, 'report.md')
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_v2_delivery = {
    guid: 'task_guid_v2_delivery',
    taskId: 't_v2_delivery',
    summary: '整理交付报告',
    status: 'todo',
    subtasks: [
      { guid: 'child_delivery_1', taskId: 't_child_delivery_1', summary: '写报告', status: 'todo' },
      { guid: 'child_delivery_2', taskId: 't_child_delivery_2', summary: '检查链接', status: 'todo' },
    ],
  }
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await writeFile(deliveryFilePath, '# 分析报告\n')
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_v2_delivery',
      taskGuid: 'task_guid_v2_delivery',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_v2_delivery-evt_v2_delivery', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '已完成交付。',
        outputs: [
          { kind: 'link_delivery', url: 'https://example.com/dashboard', title: '结果看板' },
          { kind: 'file_delivery', path: deliveryFilePath, title: '分析报告' },
          { kind: 'text_delivery', title: '补充结论', format: 'markdown', content: '# 补充结论\n\n风险可控。' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['child_delivery_1', 'child_delivery_2', 'task_guid_v2_delivery'])
      assert.equal(fakeFeishu.uploadedDeliveries.length, 2)
    })

    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(fakeFeishu.textDeliveries, [{
      taskGuid: 'task_guid_v2_delivery',
      urls: ['https://example.com/dashboard'],
    }])
    assert.equal(fakeFeishu.uploadedDeliveries[0]?.taskGuid, 'task_guid_v2_delivery')
    assert.equal(fakeFeishu.uploadedDeliveries[0]?.filePath, deliveryFilePath)
    assert.equal(fakeFeishu.uploadedDeliveries[1]?.taskGuid, 'task_guid_v2_delivery')
    assert.match(path.basename(fakeFeishu.uploadedDeliveries[1]?.filePath ?? ''), /^补充结论.*\.md$/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime treats answered result with link deliverables as task delivery output', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_answered_delivery',
      taskGuid: 'task_guid_answered_delivery',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_answered_delivery-evt_answered_delivery', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'answered',
        summary: '已创建测试工程师 JD 飞书文档。',
        reply_written: false,
        deliverables: [
          {
            mode: 'link_delivery',
            doc_type: 'docx',
            doc_token: 'Rfv1dGbsKoljlaxTJtOciGvZnsd',
            doc_url: 'https://bytedance.larkoffice.com/docx/Rfv1dGbsKoljlaxTJtOciGvZnsd',
            summary: '测试工程师 JD',
          },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_answered_delivery'])
      assert.equal(fakeFeishu.textDeliveries.length, 1)
    })

    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(fakeFeishu.textDeliveries, [{
      taskGuid: 'task_guid_answered_delivery',
      urls: ['https://bytedance.larkoffice.com/docx/Rfv1dGbsKoljlaxTJtOciGvZnsd'],
    }])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime comments answered result when reply was not written by agent', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_answered_bridge_comment',
      taskGuid: 'task_guid_answered_bridge_comment',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_answered_bridge_comment-evt_answered_bridge_comment', {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"明天是 2026-06-26。","reply_written":false}',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_answered_bridge_comment'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered_bridge_comment-evt_answered_bridge_comment']?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [{
      taskGuid: 'task_guid_answered_bridge_comment',
      content: '明天是 2026-06-26。',
    }])
    assert.deepEqual(
      runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered_bridge_comment-evt_answered_bridge_comment']?.resultCommentedTaskIds,
      ['feishu-task-task_guid_answered_bridge_comment-evt_answered_bridge_comment'],
    )
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes comment-triggered answered results when bridge writes the reply', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
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

test('runtime retries completion without duplicating already applied v2 delivery outputs', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const deliveryFilePath = path.join(configDir, 'retry-report.md')
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.completeFailures = 1
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const resultOutput = `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: '已完成交付。',
    outputs: [
      { kind: 'link_delivery', url: 'https://example.com/retry-dashboard' },
      { kind: 'file_delivery', path: deliveryFilePath },
      { kind: 'text_delivery', title: '补充结论', format: 'plain_text', content: '第一次完成状态写入失败后不应重复上传。' },
    ],
  })}`

  try {
    await writeFile(deliveryFilePath, '# 重试报告\n')
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_v2_delivery_retry',
      taskGuid: 'task_guid_v2_delivery_retry',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_v2_delivery_retry-evt_v2_delivery_retry', {
      output: resultOutput,
    })

    await waitFor(() => {
      assert.equal(runtime.getStateSnapshot().lastError, 'complete failed')
      assert.equal(fakeFeishu.textDeliveries.length, 1)
      assert.equal(fakeFeishu.uploadedDeliveries.length, 2)
    })

    fakeAamp.emitResult('feishu-task-task_guid_v2_delivery_retry-evt_v2_delivery_retry', {
      output: resultOutput,
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_v2_delivery_retry'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_v2_delivery_retry-evt_v2_delivery_retry']?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.textDeliveries, [{
      taskGuid: 'task_guid_v2_delivery_retry',
      urls: ['https://example.com/retry-dashboard'],
    }])
    assert.equal(fakeFeishu.uploadedDeliveries.length, 2)
    assert.equal(fakeFeishu.uploadedDeliveries[0]?.filePath, deliveryFilePath)
    assert.match(path.basename(fakeFeishu.uploadedDeliveries[1]?.filePath ?? ''), /^补充结论.*\.txt$/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes succeeded results when a Feishu output write fails transiently', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.textDeliveryFailures = 1
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })
  const aampTaskId = 'feishu-task-task_guid_transient_delivery-evt_transient_delivery'
  const resultOutput = `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: '已完成链接交付。',
    outputs: [
      { kind: 'link_delivery', url: 'https://example.com/transient-report' },
    ],
  })}`

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_transient_delivery',
      taskGuid: 'task_guid_transient_delivery',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult(aampTaskId, {
      output: resultOutput,
    })

    await waitFor(() => {
      assert.match(runtime.getStateSnapshot().lastError ?? '', /temporary text delivery failure/)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_transient_delivery'])
      assert.equal(fakeFeishu.comments.length, 1)
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.deepEqual(fakeFeishu.textDeliveries, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /桥接器写入飞书失败/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /temporary text delivery failure/)
    assert.deepEqual(runtime.getStateSnapshot().tasks[aampTaskId]?.resultHandledTaskIds, [aampTaskId])

    fakeAamp.emitResult(aampTaskId, {
      output: resultOutput,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_transient_delivery'])
    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.equal(fakeFeishu.comments.length, 1)
    assert.deepEqual(fakeFeishu.textDeliveries, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects result payloads without the v2 schema', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_legacy_schema',
      taskGuid: 'task_guid_legacy_schema',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_legacy_schema-evt_legacy_schema', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"success","summary":"旧 schema 不再兼容。"}',
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_legacy_schema'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_legacy_schema-evt_legacy_schema']?.status, 'failed')
    })

    assert.match(fakeFeishu.comments[0]?.content ?? '', /schema 必须是 feishu_task_result\.v2/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects FEISHU_TASK_RESULT_JSON when it does not start the output value', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_marker_prefix',
      taskGuid: 'task_guid_marker_prefix',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_marker_prefix-evt_marker_prefix', {
      output: `我已经完成了。\nFEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '前面带了非协议文本。',
        outputs: [
          { kind: 'reply_comment', content: '这条评论不应该被写入。' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_marker_prefix'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_marker_prefix-evt_marker_prefix']?.status, 'failed')
    })

    assert.match(fakeFeishu.comments[0]?.content ?? '', /未按 FEISHU_TASK_RESULT_JSON 协议收尾/)
    assert.notEqual(fakeFeishu.comments[0]?.content, '这条评论不应该被写入。')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime explains nested JSON newline escaping when FEISHU_TASK_RESULT_JSON contains literal LF', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_literal_lf',
      taskGuid: 'task_guid_literal_lf',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_literal_lf-evt_literal_lf', {
      output: 'FEISHU_TASK_RESULT_JSON: {"schema":"feishu_task_result.v2","status":"answered","summary":"第一行\n第二行","reply_written":false}',
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_literal_lf-evt_literal_lf']?.status, 'failed')
    })

    assert.match(fakeFeishu.comments[0]?.content ?? '', /literal LF newline/i)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /embedded inside AAMP_RESULT_JSON\.output/i)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /\\\\n in the final visible AAMP_RESULT_JSON text/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects legacy v2 status aliases instead of treating them as need_help', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_legacy_status_alias',
      taskGuid: 'task_guid_legacy_status_alias',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_legacy_status_alias-evt_legacy_status_alias', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'help_needed',
        summary: '旧 status 别名不再兼容。',
        question: '需要补充信息。',
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_legacy_status_alias'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_legacy_status_alias-evt_legacy_status_alias']?.status, 'failed')
    })

    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /未知 FEISHU_TASK_RESULT_JSON.status：help_needed/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects text_delivery outputs without an explicit supported format', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_invalid_text_delivery_format',
      taskGuid: 'task_guid_invalid_text_delivery_format',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_invalid_text_delivery_format-evt_invalid_text_delivery_format', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '尝试写文本交付物。',
        outputs: [
          { kind: 'text_delivery', title: '结论', content: '缺少 format。' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_invalid_text_delivery_format'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_invalid_text_delivery_format-evt_invalid_text_delivery_format']?.status, 'failed')
    })

    assert.deepEqual(fakeFeishu.uploadedDeliveries, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /outputs\[0\]\.format 必须是 markdown 或 plain_text/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime rejects file_delivery outputs without an absolute path', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_relative_file_delivery',
      taskGuid: 'task_guid_relative_file_delivery',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_relative_file_delivery-evt_relative_file_delivery', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '尝试上传交付物。',
        outputs: [
          { kind: 'file_delivery', path: './report.md', title: '报告' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_relative_file_delivery'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_relative_file_delivery-evt_relative_file_delivery']?.status, 'failed')
    })

    assert.deepEqual(fakeFeishu.uploadedDeliveries, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /outputs\[0\]\.path 必须是绝对路径/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime reports missing file_delivery files as failed task results', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const missingFilePath = path.join(configDir, 'missing-report.md')
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_missing_file_delivery',
      taskGuid: 'task_guid_missing_file_delivery',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_missing_file_delivery-evt_missing_file_delivery', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'succeeded',
        summary: '尝试上传交付物。',
        outputs: [
          { kind: 'file_delivery', path: missingFilePath, title: '报告' },
        ],
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_missing_file_delivery'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_missing_file_delivery-evt_missing_file_delivery']?.status, 'failed')
    })

    assert.deepEqual(fakeFeishu.uploadedDeliveries, [])
    assert.match(fakeFeishu.comments[0]?.content ?? '', /file_delivery\.path 不存在或不可读取/)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime handles need_help FEISHU_TASK_RESULT_JSON and blocks the Feishu task once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_need_help = {
    guid: 'task_guid_need_help',
    taskId: 't_need_help',
    summary: '整理文档',
    status: 'todo',
    subtasks: [
      { guid: 'child_help_1', taskId: 't_child_help_1', summary: '确认范围', status: 'todo' },
      { guid: 'child_help_2', taskId: 't_child_help_2', summary: '整理内容', status: 'todo' },
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
      eventId: 'evt_need_help',
      taskGuid: 'task_guid_need_help',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_need_help-evt_need_help', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'need_help',
        summary: '需要确认目标文档范围。',
        question: '请确认要整理的是哪个文档？\n\n请补充文档链接。',
      })}`,
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, ['child_help_1', 'child_help_2', 'task_guid_need_help'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_need_help-evt_need_help']?.status, 'help_needed')
    })

    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /\\n/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /请确认要整理的是哪个文档？\n\n请补充文档链接。/)
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime retries help_needed block without duplicating the help comment', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.blockFailures = 1
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_help_retry',
      taskGuid: 'task_guid_help_retry',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitHelp('feishu-task-task_guid_help_retry-evt_help_retry', '需要补充信息。')
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.equal(runtime.getStateSnapshot().lastError, 'block failed')
    })

    fakeAamp.emitHelp('feishu-task-task_guid_help_retry-evt_help_retry', '需要补充信息。')
    await waitFor(() => {
      assert.deepEqual(fakeFeishu.blockedTaskGuids, ['task_guid_help_retry'])
    })

    assert.equal(fakeFeishu.comments.length, 1)
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime comments failed FEISHU_TASK_RESULT_JSON without fixed completion wording and completes the Feishu task once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_error',
      taskGuid: 'task_guid_error',
      eventTypes: ['task_create'],
      timestamp: '1775793266156',
    })

    fakeAamp.emitResult('feishu-task-task_guid_error-evt_error', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'failed',
        summary: '已尝试处理任务。',
        error: 'runtime 无法加载飞书任务。',
      })}`,
    })
    fakeAamp.emitResult('feishu-task-task_guid_error-evt_error', {
      output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
        schema: 'feishu_task_result.v2',
        status: 'failed',
        summary: '已尝试处理任务。',
        error: 'runtime 无法加载飞书任务。',
      })}`,
    })
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_error'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_error-evt_error']?.status, 'failed')
    })

    assert.equal(fakeFeishu.comments.length, 1)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /智能体执行失败/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /已结束本次任务处理/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /已尝试处理任务/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /失败原因：runtime 无法加载飞书任务。/)
    assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_error'])

    const state = runtime.getStateSnapshot()
    assert.equal(state.tasks['feishu-task-task_guid_error-evt_error']?.status, 'failed')
    assert.deepEqual(state.tasks['feishu-task-task_guid_error-evt_error']?.resultCommentedTaskIds, ['feishu-task-task_guid_error-evt_error'])
    assert.deepEqual(state.tasks['feishu-task-task_guid_error-evt_error']?.feishuCompletedTaskIds, ['task_guid_error'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime comments rejected task.result error and completes the Feishu task', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  const runtime = new FeishuTaskBridgeRuntime(buildConfig(), {
    configDir,
    aampClient: fakeAamp,
    feishuClient: fakeFeishu,
    logger: { log: () => {}, error: () => {} },
  })

  try {
    await runtime.start()
    await fakeFeishu.emit({
      eventId: 'evt_rejected',
      taskGuid: 'task_guid_rejected',
      eventTypes: ['task_create'],
      timestamp: '1775793266157',
    })

    fakeAamp.emitResult('feishu-task-task_guid_rejected-evt_rejected', {
      status: 'rejected',
      errorMsg: 'ACP agent error: Internal error',
    })
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_rejected'])
    })

    assert.equal(fakeFeishu.comments.length, 1)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /ACP agent error: Internal error/)
    assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_rejected'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})
