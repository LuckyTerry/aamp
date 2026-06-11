import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
} from '@larksuiteoapi/node-sdk'
import type {
  BridgeConfig,
  FeishuTaskClient,
  FeishuTaskComment,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskSubtask,
} from './types.js'

type FeishuConfig = BridgeConfig['feishu']
type Logger = Pick<Console, 'error' | 'log'>
type JsonRecord = Record<string, unknown>
type TaskStepPayload = {
  params: { user_id_type?: BridgeConfig['feishu']['userIdType'] }
  data: {
    task_guid: string
    task_steps: Array<{ quote: string; content: string; timestamp: number }>
  }
}
type RegisterAgentPayload = {
  params: Record<string, never>
  data: Record<string, never>
}
type TaskSubscriptionPayload = {
  params: { user_id_type: NonNullable<BridgeConfig['feishu']['userIdType']> }
  data: Record<string, never>
}

type RawClient = Client & {
  domain?: string
  httpInstance?: HttpInstance
  formatPayload?: (payload: {
    params?: Record<string, unknown>
    data?: Record<string, unknown>
  }) => Promise<{
    params?: Record<string, unknown>
    data?: Record<string, unknown>
    headers?: Record<string, string>
  }>
}

interface OapiFeishuTaskClientOptions {
  logger?: Logger
}

function mergeHeaders<D>(
  opts: HttpRequestOptions<D> | undefined,
  headers: Record<string, string>,
): HttpRequestOptions<D> {
  return {
    ...(opts ?? {}),
    headers: {
      ...headers,
      ...(opts?.headers ?? {}),
    },
  }
}

export function createFeishuHttpInstance(headers: Record<string, string> | undefined): HttpInstance | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined
  return {
    request: (opts) => defaultHttpInstance.request(mergeHeaders(opts, headers)),
    get: (url, opts) => defaultHttpInstance.get(url, mergeHeaders(opts, headers)),
    delete: (url, opts) => defaultHttpInstance.delete(url, mergeHeaders(opts, headers)),
    head: (url, opts) => defaultHttpInstance.head(url, mergeHeaders(opts, headers)),
    options: (url, opts) => defaultHttpInstance.options(url, mergeHeaders(opts, headers)),
    post: (url, data, opts) => defaultHttpInstance.post(url, data, mergeHeaders(opts, headers)),
    put: (url, data, opts) => defaultHttpInstance.put(url, data, mergeHeaders(opts, headers)),
    patch: (url, data, opts) => defaultHttpInstance.patch(url, data, mergeHeaders(opts, headers)),
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeFeishuWriteText(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value
    .map((item) => getString(item))
    .filter((item): item is string => Boolean(item))
  return values.length ? values : undefined
}

function getArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined
}

function findStringByKeys(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5) return undefined
  const record = asRecord(value)
  if (!record) return undefined

  for (const key of keys) {
    const found = getString(record[key])
    if (found) return found
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== 'object') continue
    const found = findStringByKeys(nested, keys, depth + 1)
    if (found) return found
  }

  return undefined
}

function findStringArrayByKeys(value: unknown, keys: string[], depth = 0): string[] | undefined {
  if (depth > 5) return undefined
  const record = asRecord(value)
  if (!record) return undefined

  for (const key of keys) {
    const found = getStringArray(record[key])
    if (found) return found
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== 'object') continue
    const found = findStringArrayByKeys(nested, keys, depth + 1)
    if (found) return found
  }

  return undefined
}

function collectEventTypes(raw: unknown, fallbackEventName: string): string[] {
  const eventTypes = findStringArrayByKeys(raw, ['event_types'])
  if (eventTypes?.length) return [...new Set(eventTypes)]

  const eventType = findStringByKeys(raw, ['event_type'])
  const type = findStringByKeys(raw, ['type'])
  const values = [eventType, fallbackEventName, type]
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== 'event_callback')
  return [...new Set(values)]
}

export function normalizeFeishuTaskEvent(raw: unknown, fallbackEventName: string): FeishuTaskEvent | null {
  const taskGuid = findStringByKeys(raw, ['task_guid', 'guid', 'task_id', 'resource_id', 'object_id'])
  if (!taskGuid) return null

  const timestamp = findStringByKeys(raw, ['create_time', 'ts', 'timestamp'])
  const eventId = findStringByKeys(raw, ['event_id'])
  if (!eventId) return null

  return {
    eventId,
    taskGuid,
    eventTypes: collectEventTypes(raw, fallbackEventName),
    ...(timestamp ? { timestamp } : {}),
    raw,
  }
}

function readOriginUrl(record: JsonRecord): string | undefined {
  const origin = asRecord(record.origin)
  const href = asRecord(origin?.href)
  return getString(href?.url)
}

function mapV2Task(record: JsonRecord, fallbackGuid: string): FeishuTaskDetails {
  return {
    guid: getString(record.guid) ?? fallbackGuid,
    ...(getString(record.task_id) ? { taskId: getString(record.task_id) } : {}),
    summary: getString(record.summary) ?? '(untitled)',
    ...(getString(record.description) ? { description: getString(record.description) } : {}),
    ...(getString(record.url) ?? readOriginUrl(record) ? { url: getString(record.url) ?? readOriginUrl(record) } : {}),
    ...(getString(record.status) ? { status: getString(record.status) } : {}),
    ...(getString(record.parent_task_guid) ? { parentGuid: getString(record.parent_task_guid) } : {}),
    ...(getString(record.rrule) ? { rrule: getString(record.rrule) } : {}),
    ...(getArray(record.reminders) ? { reminders: getArray(record.reminders) } : {}),
  }
}

function mapV2Subtask(record: JsonRecord): FeishuTaskSubtask | null {
  const guid = getString(record.guid)
  if (!guid) return null
  return {
    guid,
    ...(getString(record.task_id) ? { taskId: getString(record.task_id) } : {}),
    summary: getString(record.summary) ?? '(untitled)',
    ...(getString(record.description) ? { description: getString(record.description) } : {}),
    ...(getString(record.status) ? { status: getString(record.status) } : {}),
    ...(getString(record.url) ?? readOriginUrl(record) ? { url: getString(record.url) ?? readOriginUrl(record) } : {}),
  }
}

function inferCommentAuthorType(record: JsonRecord, content: string): string {
  const authorType = getString(record.author_type)
    ?? getString(record.creator_type)
    ?? getString(record.operator_type)
  if (authorType) return authorType
  const agentCommentMarkers = [
    '已收到任务派发请求',
    '已收到您的回复',
    '智能体执行完成',
    '智能体执行失败',
    '智能体需要更多信息',
    '\n\n交付物：',
    '失败原因：',
  ]
  if (agentCommentMarkers.some((marker) => content.includes(marker))) return 'agent'
  return 'human'
}

function mapV2Comment(record: JsonRecord): FeishuTaskComment | null {
  const content = getString(record.content)
    ?? getString(record.text)
    ?? getString(record.plain_text)
    ?? getString(asRecord(record.message)?.content)
  if (!content) return null
  return {
    ...(getString(record.comment_id) ?? getString(record.id) ? { id: getString(record.comment_id) ?? getString(record.id) } : {}),
    authorType: inferCommentAuthorType(record, content),
    content,
    ...(getString(record.create_time) ?? getString(record.created_at) ? { createdAt: getString(record.create_time) ?? getString(record.created_at) } : {}),
    ...(getString(record.update_time) ?? getString(record.updated_at) ? { updatedAt: getString(record.update_time) ?? getString(record.updated_at) } : {}),
  }
}

function mapV1Task(record: JsonRecord, fallbackTaskId: string): FeishuTaskDetails {
  const taskId = getString(record.id) ?? fallbackTaskId
  return {
    guid: taskId,
    taskId,
    summary: getString(record.summary) ?? '(untitled)',
    ...(getString(record.description) ? { description: getString(record.description) } : {}),
    ...(readOriginUrl(record) ? { url: readOriginUrl(record) } : {}),
    status: getString(record.complete_time) ? 'completed' : 'todo',
  }
}

export class OapiFeishuTaskClient implements FeishuTaskClient {
  private readonly client: Client
  private readonly config: FeishuConfig
  private readonly httpInstance?: HttpInstance
  private readonly logger: Logger
  private wsClient?: WSClient

  constructor(config: FeishuConfig, options: OapiFeishuTaskClientOptions = {}) {
    this.config = config
    this.logger = options.logger ?? console
    this.httpInstance = createFeishuHttpInstance(config.headers)
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.domain ? { domain: config.domain } : {}),
      ...(this.httpInstance ? { httpInstance: this.httpInstance } : {}),
      loggerLevel: LoggerLevel.info,
      source: 'aamp-feishu-task-bridge',
    })
  }

  async registerAgent(): Promise<void> {
    this.logger.log('[feishu agent] register via v2')
    await this.registerV2AgentWithRawRequest({
      params: {},
      data: {},
    })
  }

  async subscribeTaskEvents(): Promise<void> {
    const userIdType = this.config.userIdType ?? 'open_id'
    this.logger.log(`[feishu task subscription] subscribe via v2 user_id_type=${userIdType}`)
    await this.subscribeV2TaskEventsWithRawRequest({
      params: { user_id_type: userIdType },
      data: {},
    })
  }

  async start(onEvent: (event: FeishuTaskEvent) => Promise<void>): Promise<void> {
    const handlers: Record<string, (data: unknown) => void> = {}
    for (const eventName of this.config.eventNames) {
      handlers[eventName] = (data: unknown) => {
        this.logger.log(`[feishu ws] event received name=${eventName}`)
        const event = normalizeFeishuTaskEvent(data, eventName)
        if (!event) {
          this.logger.log(`[feishu] ignored ${eventName}: missing task identifier or event_id`)
          return
        }
        this.logger.log(`[feishu ws] normalized event=${event.eventId} task=${event.taskGuid}`)
        void onEvent(event).catch((error: Error) => {
          this.logger.error(`[feishu event ${event.eventId}] ${error.message}`)
        })
      }
    }

    this.logger.log(`[feishu ws] starting app=${this.config.appId} events=${this.config.eventNames.join(',')}`)
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      ...(this.config.domain ? { domain: this.config.domain } : {}),
      ...(this.httpInstance ? { httpInstance: this.httpInstance } : {}),
      loggerLevel: LoggerLevel.info,
      source: 'aamp-feishu-task-bridge',
      onReady: () => {
        this.logger.log('[feishu ws] connected')
      },
      onError: (error: Error) => {
        this.logger.error(`[feishu ws] ${error.message}`)
      },
      onReconnecting: () => {
        this.logger.log('[feishu ws] reconnecting')
      },
      onReconnected: () => {
        this.logger.log('[feishu ws] reconnected')
      },
    })

    await this.wsClient.start({
      eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.info }).register(handlers),
    })
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true })
    this.wsClient = undefined
    this.logger.log('[feishu ws] stopped')
  }

  async getTask(taskGuid: string): Promise<FeishuTaskDetails> {
    if (this.config.taskApiVersion === 'v1') {
      this.logger.log(`[feishu task ${taskGuid}] get via v1`)
      return this.getV1Task(taskGuid)
    }

    this.logger.log(`[feishu task ${taskGuid}] get via v2`)
    return this.getV2Task(taskGuid).catch(async (error: Error) => {
      this.logger.log(`[feishu task ${taskGuid}] v2 get failed, trying v1 fallback: ${error.message}`)
      return this.getV1Task(taskGuid)
    })
  }

  async commentTask(taskGuid: string, content: string): Promise<void> {
    const normalizedContent = normalizeFeishuWriteText(content)
    if (this.config.taskApiVersion === 'v1') {
      this.logger.log(`[feishu task ${taskGuid}] comment via v1`)
      await this.commentV1Task(taskGuid, normalizedContent)
      return
    }

    this.logger.log(`[feishu task ${taskGuid}] comment via v2`)
    await this.commentV2Task(taskGuid, normalizedContent).catch(async (error: Error) => {
      this.logger.log(`[feishu task ${taskGuid}] v2 comment failed, trying v1 fallback: ${error.message}`)
      await this.commentV1Task(taskGuid, normalizedContent)
    })
  }

  async appendTaskStep(taskGuid: string, content: string): Promise<void> {
    if (!content.trim()) return
    this.logger.log(`[feishu task ${taskGuid}] append step via v2`)
    await this.appendV2TaskSteps(taskGuid, [content])
  }

  async appendTaskSteps(taskGuid: string, contents: string[]): Promise<void> {
    const stepContents = contents.filter((content) => content.trim())
    if (stepContents.length === 0) return
    this.logger.log(`[feishu task ${taskGuid}] append ${stepContents.length} step(s) via v2`)
    await this.appendV2TaskSteps(taskGuid, stepContents)
  }

  async completeTask(taskGuid: string): Promise<void> {
    this.logger.log(`[feishu task ${taskGuid}] complete via v2 agent_task_status`)
    await this.completeV2AgentTask(taskGuid)
  }

  async markTaskWaitingForHuman(taskGuid: string): Promise<void> {
    this.logger.log(`[feishu task ${taskGuid}] block via v2 agent_task_status`)
    await this.patchV2AgentTaskStatus(taskGuid, 3, '待确认')
  }

  private async getV1Task(taskGuid: string): Promise<FeishuTaskDetails> {
    const response = await this.client.task.task.get({
      path: { task_id: taskGuid },
      params: { user_id_type: this.config.userIdType },
    })
    const task = asRecord(response.data?.task)
    if (!task) throw new Error(`Feishu task ${taskGuid} not found`)
    return mapV1Task(task, taskGuid)
  }

  private async getV2Task(taskGuid: string): Promise<FeishuTaskDetails> {
    const response = await this.client.task.v2.task.get({
      path: { task_guid: taskGuid },
      params: { user_id_type: this.config.userIdType },
    })
    const task = asRecord(response.data?.task)
    if (!task) throw new Error(`Feishu task ${taskGuid} not found`)

    const details = mapV2Task(task, taskGuid)
    details.subtasks = await this.listV2Subtasks(details.guid)
    details.comments = await this.listV2Comments(details.guid).catch((error: Error) => {
      this.logger.log(`[feishu task ${taskGuid}] list comments failed: ${error.message}`)
      return []
    })
    return details
  }

  private async commentV1Task(taskGuid: string, content: string): Promise<void> {
    await this.client.task.taskComment.create({
      path: { task_id: taskGuid },
      params: { user_id_type: this.config.userIdType },
      data: {
        content,
        parent_id: '0',
        create_milli_time: String(Date.now()),
      },
    })
  }

  private async commentV2Task(taskGuid: string, content: string): Promise<void> {
    await this.client.task.v2.comment.create({
      params: { user_id_type: this.config.userIdType },
      data: {
        content,
        resource_type: 'task',
        resource_id: taskGuid,
      },
    })
  }

  private async appendV2TaskSteps(taskGuid: string, contents: string[]): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000)
    const payload: TaskStepPayload = {
      params: { user_id_type: this.config.userIdType },
      data: {
        task_guid: taskGuid,
        task_steps: contents.map((content) => ({ quote: '', content, timestamp })),
      },
    }

    await this.appendV2TaskStepsWithRawRequest(payload)
  }

  private async appendV2TaskStepsWithRawRequest(payload: TaskStepPayload): Promise<void> {
    const taskGuid = payload.data.task_guid
    if (!taskGuid) throw new Error('Feishu task step append requires task_guid.')

    const rawClient = this.client as RawClient
    if (!rawClient.formatPayload || !rawClient.httpInstance || !rawClient.domain) {
      throw new Error('Feishu task step raw REST append is unavailable in this @larksuiteoapi/node-sdk version.')
    }

    const formatted = await rawClient.formatPayload({
      params: payload.params,
      data: payload.data,
    })
    await rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/agent_task_step_info/append_task_steps`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    })
  }

  private async registerV2AgentWithRawRequest(payload: RegisterAgentPayload): Promise<void> {
    const rawClient = this.client as RawClient
    if (!rawClient.formatPayload || !rawClient.httpInstance || !rawClient.domain) {
      throw new Error('Feishu task agent raw REST registration is unavailable in this @larksuiteoapi/node-sdk version.')
    }

    const formatted = await rawClient.formatPayload({
      params: payload.params,
      data: payload.data,
    })
    await rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/agent/register_agent`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    })
  }

  private async subscribeV2TaskEventsWithRawRequest(payload: TaskSubscriptionPayload): Promise<void> {
    const rawClient = this.client as RawClient
    if (!rawClient.formatPayload || !rawClient.httpInstance || !rawClient.domain) {
      throw new Error('Feishu task event raw REST subscription is unavailable in this @larksuiteoapi/node-sdk version.')
    }

    const formatted = await rawClient.formatPayload({
      params: payload.params,
      data: payload.data,
    })
    await rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/task_v2/task_subscription`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    })
  }

  private async completeV2AgentTask(taskGuid: string): Promise<void> {
    await this.patchV2AgentTaskStatus(taskGuid, 4, '执行完成')
  }

  private async patchV2AgentTaskStatus(taskGuid: string, agentTaskStatus: number, agentTaskProgress?: string): Promise<void> {
    const task = {
      agent_task_status: agentTaskStatus,
      ...(agentTaskProgress ? { agent_task_progress: agentTaskProgress } : {}),
    }
    const updateFields = [
      'agent_task_status',
      ...(agentTaskProgress ? ['agent_task_progress'] : []),
    ]
    await this.client.task.v2.task.patch({
      path: { task_guid: taskGuid },
      params: { user_id_type: this.config.userIdType },
      data: {
        task,
        update_fields: updateFields,
      },
    })
  }

  private async listV2Subtasks(taskGuid: string): Promise<FeishuTaskSubtask[]> {
    const response = await this.client.task.v2.taskSubtask.list({
      path: { task_guid: taskGuid },
      params: {
        user_id_type: this.config.userIdType,
        page_size: 50,
      },
    })
    const items = response.data?.items ?? []
    return items
      .map((item) => mapV2Subtask(item as JsonRecord))
      .filter((item): item is FeishuTaskSubtask => Boolean(item))
  }

  private async listV2Comments(taskGuid: string): Promise<FeishuTaskComment[]> {
    const response = await this.client.task.v2.comment.list({
      params: {
        user_id_type: this.config.userIdType,
        resource_type: 'task',
        resource_id: taskGuid,
        page_size: 50,
      },
    })
    const items = response.data?.items ?? []
    return items
      .map((item) => mapV2Comment(item as JsonRecord))
      .filter((item): item is FeishuTaskComment => Boolean(item))
  }
}
