import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
} from '@larksuiteoapi/node-sdk'
import { createReadStream } from 'node:fs'
import type {
  BridgeConfig,
  FeishuAppOwner,
  FeishuDownloadedAttachment,
  FeishuTaskAttachment,
  FeishuTaskClient,
  FeishuTaskComment,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskStatus,
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
  retryBaseDelayMs?: number
  retryMaxAttempts?: number
}

interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
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

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
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

function contentTypeFromHeaders(headers: unknown): string | undefined {
  const value = typeof (headers as { get?: (name: string) => unknown } | undefined)?.get === 'function'
    ? (headers as { get(name: string): unknown }).get('content-type')
    : (headers as Record<string, unknown> | undefined)?.['content-type']
      ?? (headers as Record<string, unknown> | undefined)?.['Content-Type']
  return typeof value === 'string' && value.trim() ? value.split(';')[0]!.trim() : undefined
}

function bufferFromHttpBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof body === 'string') return Buffer.from(body)
  throw new Error('Feishu attachment download returned unsupported body type.')
}

function bufferFromHttpResponse(response: unknown): Buffer {
  const data = asRecord(response)?.data
  return bufferFromHttpBody(data ?? response)
}

function getErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error)
  const response = asRecord(record?.response)
  const status = getNumber(response?.status) ?? getNumber(record?.status) ?? getNumber(record?.statusCode)
  return status && status > 0 ? status : undefined
}

function getErrorCode(error: unknown): string | undefined {
  const record = asRecord(error)
  return getString(record?.code)
}

export function isRetryableFeishuError(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500
  }

  const code = getErrorCode(error)
  return Boolean(code && [
    'ECONNABORTED',
    'ECONNRESET',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
  ].includes(code))
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  logger: Logger,
  label: string,
): Promise<T> {
  let attempt = 0
  let lastError: unknown
  while (attempt < options.maxAttempts) {
    attempt += 1
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= options.maxAttempts || !isRetryableFeishuError(error)) {
        throw error
      }
      const delayMs = options.baseDelayMs * 2 ** (attempt - 1)
      logger.log(`[feishu retry] ${label} attempt=${attempt} next_delay_ms=${delayMs} error=${error instanceof Error ? error.message : String(error)}`)
      await sleep(delayMs)
    }
  }
  throw lastError
}

export function normalizeFeishuTaskEvent(raw: unknown, _eventName?: string): FeishuTaskEvent | null {
  const record = asRecord(raw)
  const eventId = getString(record?.event_id)
  const taskGuid = getString(record?.task_guid)
  if (!eventId) return null
  if (!taskGuid) return null

  const timestamp = getString(record?.create_time)
  const eventTypes = getStringArray(record?.event_types) ?? []
  const commentId = getString(record?.comment_id) ?? getString(record?.commentId)

  return {
    eventId,
    taskGuid,
    eventTypes: [...new Set(eventTypes)],
    ...(commentId ? { commentId } : {}),
    ...(timestamp ? { timestamp } : {}),
    raw,
  }
}

function readCommentRecord(record: JsonRecord): JsonRecord {
  return asRecord(asRecord(record.data)?.comment)
    ?? record
}

function readCommentCreator(record: JsonRecord): JsonRecord | undefined {
  return asRecord(readCommentRecord(record).creator)
}

function normalizeTaskStatus(value: unknown): FeishuTaskStatus | undefined {
  const status = getString(value)
  if (status === 'todo' || status === 'done') return status
  return undefined
}

function mapV2Attachment(
  record: JsonRecord,
  kind: FeishuTaskAttachment['kind'],
): FeishuTaskAttachment | null {
  const guid = getString(record.guid)
  if (!guid) return null

  const resource = asRecord(record.resource)
  const uploader = asRecord(record.uploader)
  const size = getNumber(record.size)

  return {
    guid,
    kind,
    ...(getString(record.file_token) ? { fileToken: getString(record.file_token) } : {}),
    ...(getString(record.name) ? { name: getString(record.name) } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(getString(resource?.type) ? { resourceType: getString(resource?.type) } : {}),
    ...(getString(resource?.id) ? { resourceId: getString(resource?.id) } : {}),
    ...(getString(uploader?.id) ? { uploaderId: getString(uploader?.id) } : {}),
    ...(getString(uploader?.type) ? { uploaderType: getString(uploader?.type) } : {}),
    ...(typeof record.is_cover === 'boolean' ? { isCover: record.is_cover } : {}),
    ...(getString(record.uploaded_at) ? { uploadedAt: getString(record.uploaded_at) } : {}),
    ...(getString(record.url) ? { url: getString(record.url) } : {}),
  }
}

function mapV2Attachments(value: unknown, kind: FeishuTaskAttachment['kind']): FeishuTaskAttachment[] | undefined {
  const attachments = getArray(value)
    ?.map((item) => asRecord(item))
    .filter((item): item is JsonRecord => Boolean(item))
    .map((item) => mapV2Attachment(item, kind))
    .filter((item): item is FeishuTaskAttachment => Boolean(item))
  return attachments?.length ? attachments : undefined
}

function mergeAttachmentMetadata(
  base: FeishuTaskAttachment,
  detail: FeishuTaskAttachment,
): FeishuTaskAttachment {
  return {
    ...detail,
    ...base,
    url: detail.url ?? base.url,
    name: detail.name ?? base.name,
    size: detail.size ?? base.size,
    fileToken: detail.fileToken ?? base.fileToken,
    resourceType: base.resourceType ?? detail.resourceType,
    resourceId: base.resourceId ?? detail.resourceId,
    uploaderId: detail.uploaderId ?? base.uploaderId,
    uploaderType: detail.uploaderType ?? base.uploaderType,
    isCover: detail.isCover ?? base.isCover,
    uploadedAt: detail.uploadedAt ?? base.uploadedAt,
    kind: base.kind,
  }
}

function mapV2Task(record: JsonRecord, fallbackGuid: string): FeishuTaskDetails {
  const agentTaskStatus = getNumber(record.agent_task_status)
  const rrule = getString(record.repeat_rule)
  const status = normalizeTaskStatus(record.status)
  const attachments = mapV2Attachments(record.attachments, 'task_attachment')
  const attachmentDeliveries = mapV2Attachments(record.attachment_deliveries, 'task_delivery')

  return {
    guid: getString(record.guid) ?? fallbackGuid,
    ...(getString(record.task_id) ? { taskId: getString(record.task_id) } : {}),
    summary: getString(record.summary) ?? '(untitled)',
    ...(getString(record.description) ? { description: getString(record.description) } : {}),
    ...(getString(record.url) ? { url: getString(record.url) } : {}),
    ...(status ? { status } : {}),
    ...(agentTaskStatus !== undefined ? { agentTaskStatus } : {}),
    ...(getString(record.parent_task_guid) ? { parentGuid: getString(record.parent_task_guid) } : {}),
    ...(rrule ? { rrule } : {}),
    ...(getArray(record.reminders) ? { reminders: getArray(record.reminders) } : {}),
    ...(attachments ? { attachments } : {}),
    ...(attachmentDeliveries ? { attachmentDeliveries } : {}),
  }
}

function mapV2Subtask(record: JsonRecord): FeishuTaskSubtask | null {
  const guid = getString(record.guid)
  if (!guid) return null
  return mapV2Task(record, guid)
}

function normalizeCommentAuthorType(value: string | undefined): 'app' | 'user' | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'app' || normalized === 'user') return normalized
  return undefined
}

function mapV2Comment(record: JsonRecord): FeishuTaskComment | null {
  const commentRecord = readCommentRecord(record)
  const creator = readCommentCreator(record)
  const authorType = normalizeCommentAuthorType(getString(creator?.type))
  const creatorId = getString(creator?.id)
  const id = getString(commentRecord.id)
  const createdAt = getString(commentRecord.created_at)
  const updatedAt = getString(commentRecord.updated_at)
  const content = getString(commentRecord.content)
  if (!content || !authorType || !creatorId) return null
  return {
    ...(id ? { id } : {}),
    authorType,
    authorId: creatorId,
    content,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function mapV6AppOwner(record: JsonRecord): FeishuAppOwner | null {
  const app = asRecord(asRecord(record.data)?.app)
  const owner = asRecord(app?.owner)
  const ownerId = getString(owner?.owner_id)
  return ownerId ? { ownerId } : null
}

export class OapiFeishuTaskClient implements FeishuTaskClient {
  private readonly client: Client
  private readonly config: FeishuConfig
  private readonly httpInstance?: HttpInstance
  private readonly logger: Logger
  private readonly retry: RetryOptions
  private wsClient?: WSClient

  constructor(config: FeishuConfig, options: OapiFeishuTaskClientOptions = {}) {
    this.config = config
    this.logger = options.logger ?? console
    this.retry = {
      maxAttempts: options.retryMaxAttempts ?? 3,
      baseDelayMs: options.retryBaseDelayMs ?? 300,
    }
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

  registerEventHandlers(
    register: (handlers: Record<string, (data: unknown) => void>) => void,
    onEvent: (event: FeishuTaskEvent) => Promise<void>,
  ): void {
    register(this.buildEventHandlers(onEvent))
  }

  private buildEventHandlers(onEvent: (event: FeishuTaskEvent) => Promise<void>): Record<string, (data: unknown) => void> {
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
    return handlers
  }

  async start(onEvent: (event: FeishuTaskEvent) => Promise<void>): Promise<void> {
    const handlers = this.buildEventHandlers(onEvent)
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
    this.logger.log(`[feishu task ${taskGuid}] get via v2`)
    return this.getV2Task(taskGuid)
  }

  async getTaskBase(taskGuid: string): Promise<FeishuTaskDetails> {
    this.logger.log(`[feishu task ${taskGuid}] get base via v2`)
    return this.getV2TaskBase(taskGuid)
  }

  async listSubtasks(taskGuid: string): Promise<FeishuTaskSubtask[]> {
    this.logger.log(`[feishu task ${taskGuid}] list subtasks via v2`)
    return this.listV2Subtasks(taskGuid)
  }

  async listComments(taskGuid: string): Promise<FeishuTaskComment[]> {
    this.logger.log(`[feishu task ${taskGuid}] list comments via v2`)
    return this.listV2Comments(taskGuid)
  }

  async getComment(commentId: string): Promise<FeishuTaskComment | null> {
    this.logger.log(`[feishu comment ${commentId}] get via v2`)
    return this.getV2Comment(commentId)
  }

  async getAppOwner(): Promise<FeishuAppOwner> {
    this.logger.log(`[feishu app ${this.config.appId}] get owner via v6`)
    return this.getV6AppOwner()
  }

  async downloadAttachment(attachment: FeishuTaskAttachment): Promise<FeishuDownloadedAttachment> {
    this.logger.log(`[feishu attachment ${attachment.guid}] download via v2 temporary url`)
    const detail = await this.getV2Attachment(attachment.guid)
    const resolvedAttachment = mergeAttachmentMetadata(attachment, detail)
    const url = resolvedAttachment.url
    if (!url) {
      throw new Error(`Feishu attachment ${attachment.guid} has no temporary download url.`)
    }

    const http = this.httpInstance ?? defaultHttpInstance
    const response = await withRetry(() => http.request({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      $return_headers: true,
    }), this.retry, this.logger, `attachment.download attachment=${attachment.guid}`)

    return {
      attachment: resolvedAttachment,
      content: bufferFromHttpResponse(response),
      contentType: contentTypeFromHeaders(asRecord(response)?.headers),
    }
  }

  async commentTask(taskGuid: string, content: string): Promise<void> {
    const normalizedContent = normalizeFeishuWriteText(content)
    this.logger.log(`[feishu task ${taskGuid}] comment via v2`)
    await this.commentV2Task(taskGuid, normalizedContent)
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

  async markTaskInProgress(taskGuid: string): Promise<void> {
    this.logger.log(`[feishu task ${taskGuid}] mark in progress via v2 agent_task_status`)
    await this.patchV2AgentTaskStatus(taskGuid, 2, '正在执行')
  }

  async markTaskWaitingForHuman(taskGuid: string): Promise<void> {
    this.logger.log(`[feishu task ${taskGuid}] block via v2 agent_task_status`)
    await this.patchV2AgentTaskStatus(taskGuid, 3, '待确认')
  }

  async appendTextDeliveries(taskGuid: string, urls: string[]): Promise<void> {
    const textDeliveries = urls
      .map((url) => normalizeFeishuWriteText(url).trim())
      .filter(Boolean)
    if (textDeliveries.length === 0) return
    this.logger.log(`[feishu task ${taskGuid}] append ${textDeliveries.length} text deliverie(s) via v2 task patch`)
    await withRetry(() => this.client.task.v2.task.patch({
      path: { task_guid: taskGuid },
      params: { user_id_type: this.config.userIdType },
      data: {
        task: { text_deliveries: textDeliveries },
        update_fields: ['text_deliveries'],
      } as never,
    }), this.retry, this.logger, `task.patch text_deliveries task=${taskGuid}`)
  }

  async uploadTaskDelivery(taskGuid: string, filePath: string): Promise<void> {
    this.logger.log(`[feishu task ${taskGuid}] upload task delivery via v2 attachment`)
    await withRetry(() => this.client.task.v2.attachment.upload({
      params: { user_id_type: this.config.userIdType },
      data: {
        resource_type: 'task_delivery',
        resource_id: taskGuid,
        file: createReadStream(filePath),
      },
    }), this.retry, this.logger, `attachment.upload task=${taskGuid}`)
  }

  private async getV2Task(taskGuid: string): Promise<FeishuTaskDetails> {
    const details = await this.getV2TaskBase(taskGuid)
    details.subtasks = await this.listV2Subtasks(details.guid)
    details.comments = await this.listV2Comments(details.guid)
    return details
  }

  private async getV2TaskBase(taskGuid: string): Promise<FeishuTaskDetails> {
    const response = await withRetry(() => this.client.task.v2.task.get({
      path: { task_guid: taskGuid },
      params: { user_id_type: this.config.userIdType },
    }), this.retry, this.logger, `task.get task=${taskGuid}`)
    const task = asRecord(response.data?.task)
    if (!task) throw new Error(`Feishu task ${taskGuid} not found`)
    return mapV2Task(task, taskGuid)
  }

  private async getV6AppOwner(): Promise<FeishuAppOwner> {
    const userIdType = this.config.userIdType ?? 'open_id'
    const response = await withRetry(() => this.client.application.application.get({
      path: { app_id: this.config.appId },
      params: { lang: 'zh_cn', user_id_type: userIdType },
    }), this.retry, this.logger, `application.get app=${this.config.appId}`)
    const owner = mapV6AppOwner(response as JsonRecord)
    if (!owner) throw new Error(`Feishu app ${this.config.appId} owner not found`)
    return owner
  }

  private async getV2Attachment(attachmentGuid: string): Promise<FeishuTaskAttachment> {
    const response = await withRetry(() => this.client.task.v2.attachment.get({
      path: { attachment_guid: attachmentGuid },
      params: { user_id_type: this.config.userIdType },
    }), this.retry, this.logger, `attachment.get attachment=${attachmentGuid}`)
    const attachment = asRecord(response.data?.attachment)
    if (!attachment) throw new Error(`Feishu attachment ${attachmentGuid} not found`)
    const mapped = mapV2Attachment(attachment, 'task_attachment')
    if (!mapped) throw new Error(`Feishu attachment ${attachmentGuid} not found`)
    return mapped
  }

  private async commentV2Task(taskGuid: string, content: string): Promise<void> {
    await withRetry(() => this.client.task.v2.comment.create({
      params: { user_id_type: this.config.userIdType },
      data: {
        content,
        resource_type: 'task',
        resource_id: taskGuid,
      },
    }), this.retry, this.logger, `comment.create task=${taskGuid}`)
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
    await withRetry(() => rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/agent_task_step_info/append_task_steps`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    }), this.retry, this.logger, `append_task_steps task=${taskGuid}`)
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
    await withRetry(() => rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/agent/register_agent`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    }), this.retry, this.logger, 'agent.register_agent')
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
    await withRetry(() => rawClient.httpInstance.request({
      method: 'POST',
      url: `${rawClient.domain}/open-apis/task/v2/task_v2/task_subscription`,
      params: formatted.params,
      data: formatted.data,
      headers: formatted.headers,
    }), this.retry, this.logger, 'task_subscription')
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
    await withRetry(() => this.client.task.v2.task.patch({
      path: { task_guid: taskGuid },
      params: { user_id_type: this.config.userIdType },
      data: {
        task,
        update_fields: updateFields,
      } as never,
    }), this.retry, this.logger, `task.patch agent_task_status task=${taskGuid}`)
  }

  private async listV2Subtasks(taskGuid: string): Promise<FeishuTaskSubtask[]> {
    const subtasks: FeishuTaskSubtask[] = []
    let pageToken: string | undefined
    do {
      const response = await withRetry(() => this.client.task.v2.taskSubtask.list({
        path: { task_guid: taskGuid },
        params: {
          user_id_type: this.config.userIdType,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), this.retry, this.logger, `taskSubtask.list task=${taskGuid}`)
      const items = response.data?.items ?? []
      subtasks.push(...items
        .map((item) => mapV2Subtask(item as JsonRecord))
        .filter((item): item is FeishuTaskSubtask => Boolean(item)))
      pageToken = response.data?.has_more ? getString(response.data.page_token) : undefined
    } while (pageToken)
    return subtasks
  }

  private async listV2Comments(taskGuid: string): Promise<FeishuTaskComment[]> {
    const comments: FeishuTaskComment[] = []
    let pageToken: string | undefined
    do {
      const response = await withRetry(() => this.client.task.v2.comment.list({
        params: {
          user_id_type: this.config.userIdType,
          resource_type: 'task',
          resource_id: taskGuid,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), this.retry, this.logger, `comment.list task=${taskGuid}`)
      const items = response.data?.items ?? []
      comments.push(...items
        .map((item) => mapV2Comment(item as JsonRecord))
        .filter((item): item is FeishuTaskComment => Boolean(item)))
      pageToken = response.data?.has_more ? getString(response.data.page_token) : undefined
    } while (pageToken)
    return comments
  }

  private async getV2Comment(commentId: string): Promise<FeishuTaskComment | null> {
    const response = await withRetry(() => this.client.task.v2.comment.get({
      path: { comment_id: commentId },
      params: { user_id_type: this.config.userIdType },
    }), this.retry, this.logger, `comment.get comment=${commentId}`)
    const comment = asRecord(response.data?.comment)
    return comment ? mapV2Comment(comment) : null
  }
}
