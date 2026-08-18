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
import type {
  BridgeConfig,
  FeishuDownloadedAttachment,
  FeishuTaskAttachment,
  FeishuTaskClient,
  FeishuTaskComment,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskStepInput,
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
  sendTaskError?: Error

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
    this.sentTasks.push(opts)
    return { taskId: opts.taskId ?? 'generated-task-id', messageId: 'aamp_message_1' }
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
  completeTaskErrors: Error[] = []
  blockTaskErrors: Record<string, Error[]> = {}
  blockTaskAttempts: string[] = []
  getTaskBaseError?: Error
  getCommentError?: Error
  tasks: Record<string, FeishuTaskDetails> = {}
  appOwner = { ownerId: 'ou_human' }

  async registerAgent(): Promise<void> {}

  async subscribeTaskEvents(): Promise<void> {}

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
    return this.tasks[taskGuid] ?? {
      guid: taskGuid,
      taskId: 't456',
      summary: '整理上线方案',
      status: 'todo',
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

  async commentTask(taskGuid: string, content: string): Promise<void> {
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

  async appendTaskSteps(taskGuid: string, steps: Array<string | FeishuTaskStepInput>): Promise<void> {
    for (const step of steps) {
      await this.appendTaskStep(taskGuid, step)
    }
  }

  async appendTextDeliveries(taskGuid: string, urls: string[]): Promise<void> {
    this.textDeliveries.push({ taskGuid, urls })
  }

  async uploadTaskDelivery(taskGuid: string, filePath: string): Promise<void> {
    this.uploadedDeliveries.push({ taskGuid, filePath })
    this.uploadedDeliveryContents.push(await readFile(filePath, 'utf8'))
  }

  async markTaskInProgress(_taskGuid: string): Promise<void> {}

  async completeTask(taskGuid: string): Promise<void> {
    const error = this.completeTaskErrors.shift()
    if (error) throw error
    this.completedTaskGuids.push(taskGuid)
  }

  async markTaskWaitingForHuman(taskGuid: string): Promise<void> {
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
      type: 'status',
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
    })

    assert.equal(runtime.getStateSnapshot().tasks[aampTaskId]?.status, 'failed')
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
    assert.match(fakeAamp.sentTasks[0]?.promptRules ?? '', /--profile custom-feishu-profile/)
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
