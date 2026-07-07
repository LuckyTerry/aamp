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
  sentTasks: SendTaskOptions[] = []

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
    this.sentTasks.push(opts)
    return { taskId: opts.taskId ?? 'generated-task-id', messageId: 'aamp_message_1' }
  }

  async updateDirectoryProfile(): Promise<void> {}

  async subscribeStream(
    _streamId: string,
    _handlers: { onEvent: (event: AampStreamEvent) => void; onError?: (error: Error) => void },
  ): Promise<StreamSubscription> {
    return { close: () => {} }
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
}

class FakeFeishuTaskClient implements FeishuTaskClient {
  eventHandler?: (event: FeishuTaskEvent) => Promise<void>
  comments: Array<{ taskGuid: string; content: string }> = []
  uploadedDeliveries: Array<{ taskGuid: string; filePath: string }> = []
  uploadedDeliveryContents: string[] = []
  completedTaskGuids: string[] = []
  blockedTaskGuids: string[] = []
  commentFailures = 0
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

  async appendTaskStep(_taskGuid: string, _content: string): Promise<void> {}

  async appendTaskSteps(_taskGuid: string, _contents: string[]): Promise<void> {}

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
