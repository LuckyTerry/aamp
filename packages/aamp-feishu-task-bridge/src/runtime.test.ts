import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
import type { BridgeConfig, FeishuTaskClient, FeishuTaskDetails, FeishuTaskEvent } from './types.js'

type AckHandler = (ack: TaskAck) => void
type HelpHandler = (help: TaskHelp) => void
type ResultHandler = (result: TaskResult) => void
type StreamOpenedHandler = (stream: TaskStreamOpened) => void

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

  emitAck(taskId: string): void {
    this.ackHandler?.({
      protocolVersion: '1.1',
      intent: 'task.ack',
      taskId,
      from: 'agent@meshmail.ai',
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
}

class FakeFeishuTaskClient implements FeishuTaskClient {
  eventHandler?: (event: FeishuTaskEvent) => Promise<void>
  lifecycle: string[] = []
  registerAgentCalls = 0
  subscribeTaskEventsCalls = 0
  comments: Array<{ taskGuid: string; content: string }> = []
  steps: Array<{ taskGuid: string; content: string }> = []
  stepBatches: Array<{ taskGuid: string; contents: string[] }> = []
  completedTaskGuids: string[] = []
  blockedTaskGuids: string[] = []
  stepFailures = 0
  completeFailures = 0
  blockFailures = 0
  getTaskCalls: string[] = []
  tasks: Record<string, FeishuTaskDetails> = {}

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

  async commentTask(taskGuid: string, content: string): Promise<void> {
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
      taskApiVersion: 'v2',
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
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /^Feishu Task:/)
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

    assert.deepEqual(fakeFeishu.getTaskCalls, ['task_guid_subtask_create'])
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

    assert.deepEqual(fakeFeishu.getTaskCalls, ['task_guid_reminder_create'])
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

    assert.deepEqual(fakeFeishu.getTaskCalls, ['task_guid_rrule_create'])
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
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, 'task_reminder_fire')
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_task_event_types, 'task_reminder_fire')
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

test('runtime dispatches comment events and writes reply ack comments', async () => {
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
      eventId: 'evt_comment',
      taskGuid: 'task_guid_comment',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266153',
    })

    assert.equal(fakeAamp.sentTasks.length, 1)
    assert.equal(fakeAamp.sentTasks[0]?.dispatchContext?.feishu_event_kind, 'task_comment')
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
    for (let i = 0; i < 20; i += 1) {
      fakeAamp.emitStreamEvent('stream_1', {
        id: `s_cap_${i}`,
        taskId: aampTaskId,
        seq: 10 + i,
        type: 'status',
        payload: { label: `额外进展 ${i + 1}` },
      })
    }

    await waitFor(() => {
      assert.equal(fakeFeishu.steps.length, 16)
      assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.lastStreamEventId, 's_cap_19')
    })

    assert.deepEqual(fakeFeishu.steps.map((step) => step.content), [
      '正在分析需求',
      '正在更新飞书任务',
      '执行遇到错误：工具调用失败',
      ...Array.from({ length: 13 }, (_, index) => `额外进展 ${index + 1}`),
    ])
    assert.ok(fakeFeishu.steps.every((step) => step.taskGuid === 'task_guid_stream'))

    const taskState = runtime.getStateSnapshot().tasks[aampTaskId]
    assert.equal(taskState?.streamId, 'stream_1')
    assert.equal(taskState?.lastStreamEventId, 's_cap_19')
    assert.equal(taskState?.streamStepCount, 16)
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
    fakeAamp.emitStreamEvent('stream_acp_contract', {
      id: 'tool_1',
      taskId: aampTaskId,
      seq: 12,
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

test('runtime comments deliverable success summary and completes child tasks before parent once', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_success = {
    guid: 'task_guid_success',
    taskId: 't_success',
    summary: '整理上线方案',
    status: 'todo',
    subtasks: [
      { guid: 'child_1', taskId: 't_child_1', summary: '需求确认', status: 'todo' },
      { guid: 'child_2', taskId: 't_child_2', summary: '测试验收', status: 'todo' },
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
      eventId: 'evt_success',
      taskGuid: 'task_guid_success',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_success-evt_success', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"success","summary":"已完成上线方案整理。\\\\n\\\\n交付物见任务交付物。","deliverable_written":true,"deliverable_summary":"交付物已上传为父任务 task_delivery 附件。"}',
    })
    fakeAamp.emitResult('feishu-task-task_guid_success-evt_success', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"success","summary":"已完成上线方案整理。\\\\n\\\\n交付物见任务交付物。","deliverable_written":true,"deliverable_summary":"交付物已上传为父任务 task_delivery 附件。"}',
    })
    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['child_1', 'child_2', 'task_guid_success'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_success-evt_success']?.status, 'completed')
    })

    assert.equal(fakeFeishu.comments.length, 1)
    assert.equal(fakeFeishu.comments[0]?.taskGuid, 'task_guid_success')
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /智能体执行完成/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /已结束本次任务处理/)
    assert.doesNotMatch(fakeFeishu.comments[0]?.content ?? '', /\\n/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /已完成上线方案整理/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /已完成上线方案整理。\n\n交付物见任务交付物。/)
    assert.match(fakeFeishu.comments[0]?.content ?? '', /交付物：交付物已上传为父任务 task_delivery 附件。/)
    assert.deepEqual(fakeFeishu.completedTaskGuids, ['child_1', 'child_2', 'task_guid_success'])

    const state = runtime.getStateSnapshot()
    assert.equal(state.lastAampResultTaskId, 'feishu-task-task_guid_success-evt_success')
    assert.equal(state.tasks['feishu-task-task_guid_success-evt_success']?.status, 'completed')
    assert.deepEqual(state.tasks['feishu-task-task_guid_success-evt_success']?.childTaskGuids, ['child_1', 'child_2'])
    assert.deepEqual(state.tasks['feishu-task-task_guid_success-evt_success']?.resultHandledTaskIds, ['feishu-task-task_guid_success-evt_success'])
    assert.deepEqual(state.tasks['feishu-task-task_guid_success-evt_success']?.resultCommentedTaskIds, ['feishu-task-task_guid_success-evt_success'])
    assert.deepEqual(state.tasks['feishu-task-task_guid_success-evt_success']?.feishuCompletedTaskIds, ['child_1', 'child_2', 'task_guid_success'])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime does not comment answered result and completes task-create tasks', async () => {
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
      eventId: 'evt_answered',
      taskGuid: 'task_guid_answered',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_answered-evt_answered', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"answered","summary":"已直接评论回复用户。","reply_written":true}',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_answered'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered-evt_answered']?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(runtime.getStateSnapshot().tasks['feishu-task-task_guid_answered-evt_answered']?.resultCommentedTaskIds, undefined)
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime does not complete or comment comment_reply answered comment events', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_reply_only = {
    guid: 'task_guid_reply_only',
    taskId: 't_reply_only',
    summary: '今天是周几？',
    status: 'completed',
    comments: [
      { id: 'comment_question', authorType: 'human', content: '我请求执行了几次？', createdAt: '1775793266100' },
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
      eventId: 'evt_reply_only',
      taskGuid: 'task_guid_reply_only',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /normalized_kind: task_comment/)
    assert.match(fakeAamp.sentTasks[0]?.bodyText ?? '', /我请求执行了几次？/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /comment_reply/)
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /do not change task status/i)
    assert.doesNotMatch(fakeAamp.sentTasks[0]?.bodyText ?? '', /comment_reply/)

    fakeAamp.emitResult('feishu-task-task_guid_reply_only-evt_reply_only', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"answered","task_flow_intent":"comment_reply","summary":"已直接评论回复用户。","reply_written":true}',
    })

    await waitFor(() => {
      assert.deepEqual(runtime.getStateSnapshot().tasks['feishu-task-task_guid_reply_only-evt_reply_only']?.resultHandledTaskIds, ['feishu-task-task_guid_reply_only-evt_reply_only'])
    })

    assert.deepEqual(fakeFeishu.comments, [])
    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
    assert.deepEqual(fakeFeishu.blockedTaskGuids, [])
    assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_reply_only-evt_reply_only']?.status, 'completed')
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime completes complete_task answered comment events', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_complete_task = {
    guid: 'task_guid_complete_task',
    taskId: 't_complete_task',
    summary: '整理恢复执行方案',
    status: 'todo',
    comments: [
      { id: 'comment_continue', authorType: 'human', content: '继续执行这个任务', createdAt: '1775793266100' },
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
      eventId: 'evt_complete_task',
      taskGuid: 'task_guid_complete_task',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_complete_task-evt_complete_task', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"answered","task_flow_intent":"complete_task","summary":"已完成并评论回复。","reply_written":true}',
    })

    await waitFor(() => {
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_complete_task'])
      assert.equal(runtime.getStateSnapshot().tasks['feishu-task-task_guid_complete_task-evt_complete_task']?.status, 'completed')
    })

    assert.deepEqual(fakeFeishu.comments, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime still treats legacy reply_only comment_intent as comment_reply', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-bridge-'))
  const fakeAamp = new FakeAampClient()
  const fakeFeishu = new FakeFeishuTaskClient()
  fakeFeishu.tasks.task_guid_legacy_reply_only = {
    guid: 'task_guid_legacy_reply_only',
    taskId: 't_legacy_reply_only',
    summary: '查询执行次数',
    status: 'completed',
    comments: [
      { id: 'comment_question', authorType: 'human', content: '我请求执行了几次？', createdAt: '1775793266100' },
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
      eventId: 'evt_legacy_reply_only',
      taskGuid: 'task_guid_legacy_reply_only',
      eventTypes: ['task_comment_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_legacy_reply_only-evt_legacy_reply_only', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"answered","comment_intent":"reply_only","summary":"已直接评论回复用户。","reply_written":true}',
    })

    await waitFor(() => {
      assert.deepEqual(runtime.getStateSnapshot().tasks['feishu-task-task_guid_legacy_reply_only-evt_legacy_reply_only']?.resultHandledTaskIds, ['feishu-task-task_guid_legacy_reply_only-evt_legacy_reply_only'])
    })

    assert.deepEqual(fakeFeishu.completedTaskGuids, [])
  } finally {
    await runtime.stop()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('runtime handles need_help FEISHU_TASK_RESULT_JSON and blocks the Feishu task once', async () => {
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
      eventId: 'evt_need_help',
      taskGuid: 'task_guid_need_help',
      eventTypes: ['task_create'],
      timestamp: '1775793266155',
    })

    fakeAamp.emitResult('feishu-task-task_guid_need_help-evt_need_help', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"need_help","summary":"需要确认目标文档范围。","question":"请确认要整理的是哪个文档？\\\\n\\\\n请补充文档链接。"}',
    })

    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.blockedTaskGuids, ['task_guid_need_help'])
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
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"failed","summary":"已尝试处理任务。","error":"runtime 无法加载飞书任务。"}',
    })
    fakeAamp.emitResult('feishu-task-task_guid_error-evt_error', {
      output: 'FEISHU_TASK_RESULT_JSON: {"status":"failed","summary":"已尝试处理任务。","error":"runtime 无法加载飞书任务。"}',
    })
    await waitFor(() => {
      assert.equal(fakeFeishu.comments.length, 1)
      assert.deepEqual(fakeFeishu.completedTaskGuids, ['task_guid_error'])
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
