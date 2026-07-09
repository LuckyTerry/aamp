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
import { FeishuTaskBridgeRuntime } from './runtime.js'
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
  completedTaskGuids: string[] = []
  blockedTaskGuids: string[] = []
  commentFailures = 0
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
    return { attachment, content: Buffer.from('') }
  }

  async commentTask(taskGuid: string, content: string): Promise<void> {
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

  async appendTextDeliveries(_taskGuid: string, _urls: string[]): Promise<void> {}

  async uploadTaskDelivery(taskGuid: string, filePath: string): Promise<void> {
    this.uploadedDeliveries.push({ taskGuid, filePath })
    this.uploadedDeliveryContents.push(await readFile(filePath, 'utf8'))
  }

  async markTaskInProgress(_taskGuid: string): Promise<void> {}

  async completeTask(taskGuid: string): Promise<void> {
    this.completedTaskGuids.push(taskGuid)
  }

  async markTaskWaitingForHuman(taskGuid: string): Promise<void> {
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

test('runtime writes adjacent text deltas as human task steps', async () => {
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
