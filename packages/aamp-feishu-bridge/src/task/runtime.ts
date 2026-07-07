import {
  AampClient,
  type AampAttachment,
  type AampStreamEvent,
  type SendTaskOptions,
  type StreamSubscription,
  type TaskAck,
  type TaskHelp,
  type TaskResult,
  type TaskStreamOpened,
} from 'aamp-sdk'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
import { isRetryableFeishuError, OapiFeishuTaskClient } from './feishu.js'
import type {
  BridgeConfig,
  FeishuAgentRegistrationState,
  FeishuAppOwnerState,
  BridgeState,
  BridgeTaskState,
  FeishuTaskAttachment,
  FeishuTaskClient,
  FeishuTaskComment,
  FeishuTaskDetails,
  FeishuTaskEvent,
  FeishuTaskEventKind,
  FeishuTaskSubscriptionState,
} from './types.js'

type Logger = Pick<Console, 'error' | 'log'>
type LogLevel = 'debug' | 'error' | 'info'
type BridgeLogger = Logger & { debug: (message?: unknown) => void }
type ConnectivityKind = keyof BridgeState['connectivity']
type FeishuTaskEventIgnoreReason =
  | 'event_type_not_allowlisted'
  | 'subtask_create_context_only'
  | 'task_create_deferred_to_reminder'
  | 'recurring_task_create_deferred'
  | 'task_not_active'
  | 'comment_authored_by_current_app'
  | 'comment_author_not_app_owner'
  | 'comment_without_effective_comment'
  | 'agent_task_status_not_dispatchable'
  | 'duplicate_task_event'
const MAX_STREAM_STEPS_PER_TASK = 32
const STREAM_STEP_FLUSH_BATCH_SIZE = 4
const STREAM_STEP_FLUSH_INTERVAL_MS = 5000
const MAX_DELIVERY_FILE_SIZE_BYTES = 50 * 1024 * 1024
const MAX_FEISHU_COMMENT_CHARACTERS = 3000
const MAX_FEISHU_COMMENT_BYTES = 10000
const MAX_INCOMING_FEISHU_ATTACHMENTS = 20
const MAX_INCOMING_FEISHU_ATTACHMENT_SIZE_BYTES = MAX_DELIVERY_FILE_SIZE_BYTES
const COMMENT_DISPATCHABLE_AGENT_TASK_STATUSES = new Set([1, 2, 3, 4])
const TERMINAL_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const HELP_NEEDED_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RETAINED_TERMINAL_TASKS = 2000
const APP_OWNER_CACHE_TTL_MS = 60 * 60 * 1000
const PERMISSION_DENIED_COMMENT_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PERMISSION_DENIED_COMMENT_NOTICE_KEYS = 1000
const PERMISSION_DENIED_COMMENT_REPLY = '你没有权限通过评论触发此任务继续执行。当前仅应用 Owner 可以触发任务流转，请联系应用 Owner 处理。'
function getFeishuLarkCliProfile(profile: string | undefined): string | undefined {
  return profile?.trim() || undefined
}

interface PendingStreamStep {
  content: string
  normalized: string
}

interface StreamStepBuffer {
  steps: PendingStreamStep[]
  timer?: ReturnType<typeof setTimeout>
}

interface FeishuTaskAttachmentRef {
  attachment: FeishuTaskAttachment
  sourceLabel: string
  filenamePrefix: string
}

interface PreparedFeishuTaskAttachments {
  attachments: AampAttachment[]
  notes: string[]
}

function formatLogMessage(level: LogLevel, message?: unknown): string {
  return `[${level}] ${String(message)}`
}

function createBridgeLogger(logger: Logger, debugEnabled: boolean): BridgeLogger {
  return {
    log: (message) => {
      logger.log(formatLogMessage('info', message))
    },
    debug: (message) => {
      if (debugEnabled) logger.log(formatLogMessage('debug', message))
    },
    error: (message) => {
      logger.error(formatLogMessage('error', message))
    },
  }
}

function createDebugLogger(logger: BridgeLogger): Logger {
  return {
    log: (message) => {
      logger.debug(message)
    },
    error: (message) => {
      logger.error(message)
    },
  }
}

function formatTaskLogPrefix(taskGuid: string, eventId?: string): string {
  return eventId ? `[task ${taskGuid} event ${eventId}]` : `[task ${taskGuid}]`
}

function formatOutputCounts(outputs: FeishuTaskResultOutput[]): string {
  const counts: Record<FeishuTaskResultOutput['kind'], number> = {
    reply_comment: 0,
    link_delivery: 0,
    file_delivery: 0,
    text_delivery: 0,
  }
  for (const output of outputs) {
    counts[output.kind] += 1
  }
  return [
    `reply_comment=${counts.reply_comment}`,
    `link_delivery=${counts.link_delivery}`,
    `file_delivery=${counts.file_delivery}`,
    `text_delivery=${counts.text_delivery}`,
  ].join(' ')
}

function countFeishuCommentCharacters(content: string): number {
  return Array.from(content).length
}

function getFeishuCommentByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8')
}

function isFeishuCommentWithinLimit(content: string): boolean {
  return countFeishuCommentCharacters(content) <= MAX_FEISHU_COMMENT_CHARACTERS
    && getFeishuCommentByteLength(content) <= MAX_FEISHU_COMMENT_BYTES
}

function buildOversizedCommentDeliveryNotice(content: string): string {
  return [
    '评论内容超过飞书限制',
    `（${countFeishuCommentCharacters(content)} characters / ${getFeishuCommentByteLength(content)} bytes，`,
    `限制为 ${MAX_FEISHU_COMMENT_CHARACTERS} characters / ${MAX_FEISHU_COMMENT_BYTES} bytes），`,
    '已作为 Markdown 附件上传。',
  ].join('')
}

function describeFeishuAttachment(attachment: FeishuTaskAttachment): string {
  return [
    attachment.name?.trim() || attachment.guid,
    `guid=${attachment.guid}`,
    `kind=${attachment.kind}`,
    attachment.size !== undefined ? `${attachment.size} bytes` : '',
  ].filter(Boolean).join(' ')
}

function extensionForContentType(contentType?: string): string | undefined {
  const normalized = contentType?.toLowerCase()
  const byContentType: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  }
  return normalized ? byContentType[normalized] : undefined
}

function resolveAttachmentContentType(filename: string, downloadedContentType?: string): string {
  if (downloadedContentType?.trim()) return downloadedContentType.trim()
  const ext = path.extname(filename).toLowerCase()
  const byExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
  }
  return byExtension[ext] ?? 'application/octet-stream'
}

function sanitizeAampAttachmentFilename(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  const lastSegment = (normalized || fallback).split(/[\\/]+/).filter(Boolean).pop() ?? fallback
  const filename = lastSegment
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return filename && filename !== '.' && filename !== '..' ? filename : fallback
}

function resolveAampAttachmentFilename(
  ref: FeishuTaskAttachmentRef,
  downloadedContentType?: string,
): string {
  const baseName = sanitizeAampAttachmentFilename(ref.attachment.name, `feishu-attachment-${ref.attachment.guid}`)
  const withExtension = path.extname(baseName)
    ? baseName
    : `${baseName}${extensionForContentType(downloadedContentType) ?? ''}`
  return sanitizeAampAttachmentFilename(`${ref.filenamePrefix}${withExtension}`, `feishu-attachment-${ref.attachment.guid}`)
}

function appendAttachmentNotes(bodyText: string, notes: string[]): string {
  if (notes.length === 0) return bodyText
  return [
    bodyText,
    'Attachment notes:',
    ...notes.map((note) => `- ${note}`),
  ].join('\n')
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

function isSameMailboxAddress(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.trim().toLowerCase() === right.trim().toLowerCase())
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
    ...(getFeishuLarkCliProfile(config.feishu.cliProfile) ? { feishuLarkCliProfile: getFeishuLarkCliProfile(config.feishu.cliProfile) } : {}),
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

function buildFeishuAppOwnerIdentity(
  config: BridgeConfig,
): Omit<FeishuAppOwnerState, 'fetchedAt' | 'ownerId'> {
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

function hasMatchingFeishuAppOwner(
  current: FeishuAppOwnerState | undefined,
  expected: Omit<FeishuAppOwnerState, 'fetchedAt' | 'ownerId'>,
): boolean {
  return Boolean(current?.ownerId)
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
  | { kind: 'succeeded'; summary: string; outputs: FeishuTaskResultOutput[] }
  | { kind: 'answered'; summary?: string; replyWritten?: boolean }
  | { kind: 'failure'; summary?: string; message: string }
  | { kind: 'help_needed'; message: string }

type FeishuTaskResultOutput =
  | { kind: 'reply_comment'; content: string }
  | { kind: 'link_delivery'; url: string }
  | { kind: 'file_delivery'; path: string }
  | { kind: 'text_delivery'; title?: string; format: 'markdown' | 'plain_text'; content: string }

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

function sanitizeDeliveryFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
    || 'text-delivery'
}

function parseResultOutput(value: unknown, index: number): FeishuTaskResultOutput | string {
  const output = asRecord(value)
  if (!output) return `outputs[${index}] 必须是对象。`

  const kind = getString(output.kind) ?? getString(output.mode)
  if (kind === 'reply_comment') {
    const content = getString(output.content)
    return content ? { kind, content } : `outputs[${index}].content 不能为空。`
  }
  if (kind === 'link_delivery') {
    const url = getString(output.url) ?? getString(output.doc_url)
    return url ? { kind, url } : `outputs[${index}].url 不能为空。`
  }
  if (kind === 'file_delivery') {
    const filePath = getString(output.path)
    if (filePath && !path.isAbsolute(filePath)) {
      return `outputs[${index}].path 必须是绝对路径。`
    }
    return filePath ? { kind, path: filePath } : `outputs[${index}].path 不能为空。`
  }
  if (kind === 'text_delivery') {
    const content = getString(output.content)
    const title = getString(output.title)
    const format = getString(output.format)
    if (format !== 'markdown' && format !== 'plain_text') {
      return `outputs[${index}].format 必须是 markdown 或 plain_text。`
    }
    return content ? { kind, content, format, ...(title ? { title } : {}) } : `outputs[${index}].content 不能为空。`
  }
  return `outputs[${index}].kind 不支持：${kind ?? '(missing)'}。`
}

function parseResultOutputs(value: unknown, fieldName = 'outputs'): FeishuTaskResultOutput[] | string {
  if (!Array.isArray(value)) return `status=succeeded 时 ${fieldName} 必须是数组。`
  if (value.length === 0) return 'status=succeeded 时 outputs 至少包含一项。'
  if (value.length > 10) return 'outputs 最多支持 10 项。'

  const outputs: FeishuTaskResultOutput[] = []
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseResultOutput(value[index], index)
    if (typeof parsed === 'string') return parsed
    outputs.push(parsed)
  }
  return outputs
}

function parsePayloadDeliveryOutputs(payload: Record<string, unknown>): FeishuTaskResultOutput[] | string | undefined {
  if (payload.outputs != null) return parseResultOutputs(payload.outputs, 'outputs')
  if (payload.deliverables != null) return parseResultOutputs(payload.deliverables, 'deliverables')
  return undefined
}

function getFirstQuestionText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    const question = getString(asRecord(item)?.question)
    if (question) return question
  }
  return undefined
}

function parseFeishuResultPayload(output: string): Record<string, unknown> | undefined {
  const trimmedOutput = output.trimStart()
  if (!trimmedOutput.startsWith(FEISHU_RESULT_MARKER)) return undefined
  const jsonText = trimmedOutput.slice(FEISHU_RESULT_MARKER.length).trim()
  if (!jsonText) return undefined
  const parsed = JSON.parse(jsonText) as unknown
  return asRecord(parsed)
}

function formatFeishuResultParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/bad control character/i.test(message)) {
    return [
      message,
      'FEISHU_TASK_RESULT_JSON contains a literal LF newline or another control character inside a JSON string.',
      'Because FEISHU_TASK_RESULT_JSON is embedded inside AAMP_RESULT_JSON.output, multiline user-visible fields must be written as \\\\n in the final visible AAMP_RESULT_JSON text.',
    ].join(' ')
  }
  return message
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const nestedValue = record[key]
      if (nestedValue !== undefined) {
        result[key] = canonicalizeJson(nestedValue)
      }
    }
    return result
  }
  return value
}

function hashResultOutput(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest('hex')
}

function getResultOutputApplyKey(index: number, output: FeishuTaskResultOutput): string {
  return `output:${index}:${output.kind}:${hashResultOutput(output)}`
}

function getReplyCommentOutputApplyKey(outputs: Extract<FeishuTaskResultOutput, { kind: 'reply_comment' }>[]): string {
  return `reply_comment:${hashResultOutput(outputs)}`
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
      message: `智能体返回了无法解析的 FEISHU_TASK_RESULT_JSON：${formatFeishuResultParseError(error)}`,
    }
  }

  if (payload) {
    const schema = getString(payload.schema)
    const status = getString(payload.status)
    const summary = getString(payload.summary)
    const error = getString(payload.error)
    const question = getString(payload.question)
    const firstQuestion = getFirstQuestionText(payload.questions)
    if (schema !== 'feishu_task_result.v2') {
      return { kind: 'failure', message: `FEISHU_TASK_RESULT_JSON.schema 必须是 feishu_task_result.v2，实际为：${schema ?? '(missing)'}` }
    }

    const replyWritten = getBoolean(payload.reply_written)
    if (status === 'answered') {
      const outputs = parsePayloadDeliveryOutputs(payload)
      if (outputs) {
        if (typeof outputs === 'string') return { kind: 'failure', message: outputs }
        return { kind: 'succeeded', summary: summary ?? '已完成任务。', outputs }
      }
      return {
        kind: 'answered',
        ...(summary ? { summary } : {}),
        ...(replyWritten != null ? { replyWritten } : {}),
      }
    }

    if (status === 'succeeded') {
      const outputs = parsePayloadDeliveryOutputs(payload)
      if (!outputs) return { kind: 'failure', message: 'status=succeeded 时 outputs 必须是数组。' }
      if (typeof outputs === 'string') return { kind: 'failure', message: outputs }
      return { kind: 'succeeded', summary: summary ?? '已完成任务。', outputs }
    }
    if (status === 'need_help' || status === 'needs_input') {
      return { kind: 'help_needed', message: question ?? firstQuestion ?? summary ?? error ?? '智能体需要更多信息才能继续处理该任务。' }
    }
    if (status === 'failed') {
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

function isTaskActiveForExecution(task: FeishuTaskDetails): boolean {
  return task.status !== 'done'
}

function isCommentByCurrentApp(comment: FeishuTaskComment, appId: string): boolean {
  const normalizedAppId = appId.trim()
  if (!normalizedAppId) return false
  const authorType = comment.authorType.trim().toLowerCase()
  const authorId = comment.authorId?.trim()
  return authorType === 'app' && authorId === normalizedAppId
}

function getLatestNonEmptyComment(task: FeishuTaskDetails): FeishuTaskComment | undefined {
  return [...(task.comments ?? [])]
    .filter((comment) => Boolean(comment.content.trim()))
    .sort((a, b) => (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? ''))
    .at(-1)
}

function getEventCommentId(event: FeishuTaskEvent): string | undefined {
  const raw = asRecord(event.raw)
  const rawComment = asRecord(raw?.comment)
  return getString(raw?.comment_id)
    ?? getString(raw?.commentId)
    ?? getString(rawComment?.id)
}

function getPermissionDeniedCommentNoticeKey(event: FeishuTaskEvent, comment: FeishuTaskComment): string {
  const commentId = comment.id?.trim()
  return commentId ? `comment:${event.taskGuid}:${commentId}` : `event:${event.eventId}`
}

function getSemanticEventKey(event: FeishuTaskEvent, eventKind: FeishuTaskEventKind): string | undefined {
  if (eventKind === 'task_create') return `task_create:${event.taskGuid}`
  if (eventKind === 'task_comment') {
    const commentId = event.commentId ?? getEventCommentId(event)
    return commentId ? `task_comment:${event.taskGuid}:${commentId}` : undefined
  }
  return undefined
}

function getAckCommentEventKey(taskState: BridgeTaskState): string | undefined {
  if (taskState.feishuEventKind === 'task_create') {
    return `task_create:${taskState.taskGuid}`
  }
  if (taskState.feishuEventKind === 'task_comment' && taskState.feishuEventId) {
    return `task_comment:${taskState.taskGuid}:${taskState.feishuEventId}`
  }
  return undefined
}

function mergeComments(
  comments: FeishuTaskComment[],
  comment: FeishuTaskComment | undefined,
): FeishuTaskComment[] {
  if (!comment) return comments
  const result = [...comments]
  const index = comment.id ? result.findIndex((item) => item.id === comment.id) : -1
  if (index >= 0) {
    result[index] = comment
  } else {
    result.push(comment)
  }
  return result
}

function getNonCommentExecutionIgnoreReason(
  eventKind: FeishuTaskEventKind,
  task: FeishuTaskDetails,
): FeishuTaskEventIgnoreReason | undefined {
  if (eventKind !== 'task_comment' && !isTaskActiveForExecution(task)) {
    return 'task_not_active'
  }

  if (eventKind !== 'task_comment') return undefined
  return undefined
}

function getCommentExecutionIgnoreReason(
  task: FeishuTaskDetails,
  latestComment: FeishuTaskComment | undefined,
  appId: string,
): FeishuTaskEventIgnoreReason | undefined {
  if (
    task.agentTaskStatus === undefined
    || !COMMENT_DISPATCHABLE_AGENT_TASK_STATUSES.has(task.agentTaskStatus)
  ) {
    return 'agent_task_status_not_dispatchable'
  }

  if (!latestComment) return 'comment_without_effective_comment'
  if (isCommentByCurrentApp(latestComment, appId)) return 'comment_authored_by_current_app'
  return undefined
}

function isFreshTimestamp(value: string | undefined, ttlMs: number): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ttlMs
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
  'Tool running: Read file',
  'Tool running: tool',
  'Tool completed: tool',
  'Tool running: Editing files',
  'Tool failed: tool',
].map(normalizeStepText))

const STREAM_EXECUTION_START_IGNORED_TEXTS = new Set([
  'ACP task started',
  'Prompt sent to ACP agent',
].map(normalizeStepText))

function isStreamExecutionSignal(stepContents: string[]): boolean {
  return stepContents.some((content) => !STREAM_EXECUTION_START_IGNORED_TEXTS.has(normalizeStepText(content)))
}

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

export interface FeishuTaskBridgeStartOptions {
  registerFeishuEventHandlers?: (handlers: Record<string, (data: unknown) => void>) => void
}

export class FeishuTaskBridgeRuntime {
  private readonly config: BridgeConfig
  private readonly configDir?: string
  private readonly logger: BridgeLogger
  private readonly aamp: AampClientLike
  private readonly feishu: FeishuTaskClient
  private readonly forceRegisterAgent: boolean
  private readonly streamStepFlushIntervalMs: number
  private state: BridgeState = createDefaultBridgeState()
  private readonly ackCommentInFlight = new Set<string>()
  private readonly helpCommentInFlight = new Set<string>()
  private readonly resultInFlight = new Set<string>()
  private readonly feishuInProgressInFlight = new Set<string>()
  private readonly feishuCompleteInFlight = new Set<string>()
  private readonly feishuBlockInFlight = new Set<string>()
  private readonly permissionDeniedCommentNoticeInFlight = new Map<string, Promise<void>>()
  private readonly activeStreamSubscriptions = new Map<string, StreamSubscription>()
  private readonly streamEventQueues = new Map<string, Promise<void>>()
  private readonly streamStepBuffers = new Map<string, StreamStepBuffer>()
  private readonly streamStepFlushQueues = new Map<string, Promise<void>>()
  private readonly backgroundTasks = new Set<Promise<void>>()
  private stopping = false

  constructor(config: BridgeConfig, options: FeishuTaskBridgeRuntimeOptions = {}) {
    this.config = config
    this.configDir = options.configDir
    this.logger = createBridgeLogger(options.logger ?? console, Boolean(config.behavior.debug))
    this.forceRegisterAgent = Boolean(options.forceRegisterAgent)
    this.streamStepFlushIntervalMs = options.streamStepFlushIntervalMs ?? STREAM_STEP_FLUSH_INTERVAL_MS
    this.aamp = options.aampClient ?? new AampClient({
      email: config.mailbox.email,
      mailboxToken: config.mailbox.mailboxToken,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    this.feishu = options.feishuClient ?? new OapiFeishuTaskClient(config.feishu, {
      logger: createDebugLogger(this.logger),
    })
  }

  async start(options: FeishuTaskBridgeStartOptions = {}): Promise<void> {
    this.state = await loadBridgeState(this.configDir)
    const prunedTaskCount = this.pruneTaskState()
    this.prunePermissionDeniedCommentNotices()
    this.state.lastStartedAt = new Date().toISOString()
    this.state.lastError = undefined
    this.setConnectivity('aamp', 'connecting')
    this.setConnectivity('feishu', 'connecting')
    this.logger.log([
      '[bridge] starting',
      `target=${this.config.targetAgentEmail}`,
      `mailbox=${this.config.mailbox.email}`,
      `events=${this.config.feishu.eventNames.join(',')}`,
      `ackComment=${this.config.behavior.ackComment ? 'on' : 'off'}`,
      `debug=${this.config.behavior.debug ? 'on' : 'off'}`,
    ].join(' '))
    if (prunedTaskCount > 0) {
      this.logger.log(`[state] pruned old terminal tasks count=${prunedTaskCount}`)
    }

    await this.ensureFeishuAgentRegistered()
    await this.ensureFeishuTaskEventsSubscribed()

    this.registerAampHandlers()

    await this.aamp.connect()
    this.setConnectivity('aamp', 'connected')

    const onFeishuTaskEvent = async (event: FeishuTaskEvent) => {
      await this.handleFeishuTaskEvent(event)
    }
    if (options.registerFeishuEventHandlers) {
      this.feishu.registerEventHandlers(options.registerFeishuEventHandlers, onFeishuTaskEvent)
      this.logger.log(`[feishu] listener attached to shared event dispatcher events=${this.config.feishu.eventNames.join(',')}`)
    } else {
      await this.feishu.start(onFeishuTaskEvent)
    }
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
    await this.drainBackgroundTasks()
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
      this.trackBackgroundTask(this.persistState())
    })
    this.aamp.on('disconnected', (reason) => {
      this.setConnectivity('aamp', 'disconnected')
      this.logger.log(`[aamp] disconnected${reason ? ` reason=${reason}` : ''}`)
      this.trackBackgroundTask(this.persistState())
    })
    this.aamp.on('error', (error) => {
      this.state.lastError = error.message
      this.logger.error(`[aamp] ${error.message}`)
      this.trackBackgroundTask(this.persistState())
    })
    this.aamp.on('task.ack', (ack) => {
      const taskState = this.state.tasks[ack.taskId]
      if (!taskState) {
        const reason = isSameMailboxAddress(ack.from, this.config.mailbox.email)
          ? 'self_echo_unknown_task'
          : 'unknown_task'
        const message = `[aamp ack] ignored reason=${reason} task=${ack.taskId} from=${ack.from}`
        if (reason === 'self_echo_unknown_task') {
          this.debugLog(message)
        } else {
          this.logger.log(message)
        }
        return
      }
      this.state.lastAampAckAt = new Date().toISOString()
      this.state.lastAampAckTaskId = ack.taskId
      this.debugLog(`${formatTaskLogPrefix(taskState.taskGuid)} ack received aamp_task=${ack.taskId} from=${ack.from}`)
      this.debugLog(`[aamp ack ${ack.taskId}] received from=${ack.from}`)
      this.trackBackgroundTask(this.handleTaskAck(ack).catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp ack ${ack.taskId}] ${error.message}`)
        await this.persistState()
      }))
    })
    this.aamp.on('task.stream.opened', (stream) => {
      const taskState = this.state.tasks[stream.taskId]
      if (taskState) {
        this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} stream opened aamp_task=${stream.taskId} stream=${stream.streamId}`)
      } else {
        this.logger.log(`[aamp stream] ignored reason=unknown_task task=${stream.taskId} stream=${stream.streamId}`)
      }
      this.debugLog(`[aamp stream ${stream.taskId}] opened stream=${stream.streamId} from=${stream.from}`)
      this.trackBackgroundTask(this.handleTaskStreamOpened(stream).catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${stream.taskId}] ${error.message}`)
        await this.persistState()
      }))
    })
    this.aamp.on('task.help_needed', (help) => {
      this.state.lastAampHelpAt = new Date().toISOString()
      this.state.lastAampHelpTaskId = help.taskId
      this.logger.log(`[aamp help] received task=${help.taskId}`)
      this.debugLog(`[aamp help ${help.taskId}] received from=${help.from}`)
      this.trackBackgroundTask(this.handleTaskHelp(help).catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp help ${help.taskId}] ${error.message}`)
        await this.persistState()
      }))
    })
    this.aamp.on('task.result', (result) => {
      const taskState = this.state.tasks[result.taskId]
      if (!taskState) {
        this.logger.log(`[aamp result] ignored reason=unknown_task task=${result.taskId} status=${result.status}`)
        return
      }
      this.state.lastAampResultAt = new Date().toISOString()
      this.state.lastAampResultTaskId = result.taskId
      this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} result received aamp_task=${result.taskId} status=${result.status}`)
      this.debugLog(`[aamp result ${result.taskId}] received from=${result.from} status=${result.status}`)
      this.trackBackgroundTask(this.handleTaskResult(result).catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp result ${result.taskId}] ${error.message}`)
        await this.persistState()
      }))
    })
  }

  private trackBackgroundTask(task: Promise<void>): void {
    const tracked = task
      .catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[bridge] ${error.message}`)
      })
      .finally(() => {
        this.backgroundTasks.delete(tracked)
      })
    this.backgroundTasks.add(tracked)
  }

  private async drainBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks])
    }
  }

  private async ignoreFeishuTaskEvent(event: FeishuTaskEvent, reason: FeishuTaskEventIgnoreReason): Promise<void> {
    this.logger.log(`${formatTaskLogPrefix(event.taskGuid, event.eventId)} ignored reason=${reason} types=${event.eventTypes.join(',') || '(unknown)'}`)
    this.debugLog(`[feishu event ${event.eventId}] ignored reason=${reason}`)
    this.rememberEvent(event)
    this.state.lastIgnoredFeishuEventAt = new Date().toISOString()
    this.state.lastIgnoredFeishuEventId = event.eventId
    this.state.lastIgnoredFeishuEventTaskGuid = event.taskGuid
    this.state.lastIgnoredFeishuEventTypes = event.eventTypes
    this.state.lastIgnoredFeishuEventReason = reason
    await this.persistState()
  }

  private async loadTaskForDispatchEvent(
    event: FeishuTaskEvent,
    eventKind: FeishuTaskEventKind,
  ): Promise<{ task?: FeishuTaskDetails; ignoreReason?: FeishuTaskEventIgnoreReason }> {
    if (eventKind === 'task_comment') {
      return this.loadTaskForCommentEvent(event)
    }

    this.debugLog(`[feishu task ${event.taskGuid}] loading base details`)
    const baseTask = await this.feishu.getTaskBase(event.taskGuid)
    this.debugLog(`[feishu task ${baseTask.guid}] loaded base summary="${baseTask.summary}"`)

    const createIgnoreReason = getTaskCreateIgnoreReason(eventKind, baseTask)
    if (createIgnoreReason) return { ignoreReason: createIgnoreReason }

    const executionIgnoreReason = getNonCommentExecutionIgnoreReason(eventKind, baseTask)
    if (executionIgnoreReason) return { ignoreReason: executionIgnoreReason }

    return { task: await this.hydrateTaskContext(baseTask) }
  }

  private async loadTaskForCommentEvent(
    event: FeishuTaskEvent,
  ): Promise<{ task?: FeishuTaskDetails; ignoreReason?: FeishuTaskEventIgnoreReason }> {
    const commentId = event.commentId ?? getEventCommentId(event)
    let changedComment: FeishuTaskComment | undefined
    let loadedComments: FeishuTaskComment[] | undefined

    if (commentId) {
      changedComment = await this.feishu.getComment(commentId) ?? undefined
      if (!changedComment) return { ignoreReason: 'comment_without_effective_comment' }
      if (isCommentByCurrentApp(changedComment, this.config.feishu.appId)) {
        return { ignoreReason: 'comment_authored_by_current_app' }
      }
      const ownerIgnoreReason = await this.getHumanCommentOwnerIgnoreReason(changedComment)
      if (ownerIgnoreReason) {
        await this.commentPermissionDeniedOnce(event, changedComment)
        return { ignoreReason: ownerIgnoreReason }
      }
    } else {
      this.debugLog(`[feishu event ${event.eventId}] comment_id missing fallback=list_comments task=${event.taskGuid}`)
      loadedComments = await this.feishu.listComments(event.taskGuid)
      changedComment = getLatestNonEmptyComment({
        guid: event.taskGuid,
        summary: '(comment event)',
        comments: loadedComments,
      })
      if (!changedComment) return { ignoreReason: 'comment_without_effective_comment' }
      if (isCommentByCurrentApp(changedComment, this.config.feishu.appId)) {
        return { ignoreReason: 'comment_authored_by_current_app' }
      }
      const ownerIgnoreReason = await this.getHumanCommentOwnerIgnoreReason(changedComment)
      if (ownerIgnoreReason) {
        await this.commentPermissionDeniedOnce(event, changedComment)
        return { ignoreReason: ownerIgnoreReason }
      }
    }

    this.debugLog(`[feishu task ${event.taskGuid}] loading base details`)
    const baseTask = await this.feishu.getTaskBase(event.taskGuid)
    this.debugLog(`[feishu task ${baseTask.guid}] loaded base summary="${baseTask.summary}"`)
    const executionIgnoreReason = getCommentExecutionIgnoreReason(baseTask, changedComment, this.config.feishu.appId)
    if (executionIgnoreReason) return { ignoreReason: executionIgnoreReason }

    return {
      task: await this.hydrateTaskContext(baseTask, {
        comments: loadedComments,
        changedComment,
      }),
    }
  }

  private async getHumanCommentOwnerIgnoreReason(
    comment: FeishuTaskComment,
  ): Promise<FeishuTaskEventIgnoreReason | undefined> {
    if (comment.authorType !== 'user') return undefined

    const commentAuthorId = comment.authorId?.trim()
    if (!commentAuthorId) return 'comment_author_not_app_owner'

    const appOwnerId = await this.getAppOwnerId()
    return commentAuthorId === appOwnerId ? undefined : 'comment_author_not_app_owner'
  }

  private async commentPermissionDeniedOnce(event: FeishuTaskEvent, comment: FeishuTaskComment): Promise<void> {
    const noticeKey = getPermissionDeniedCommentNoticeKey(event, comment)
    if (this.state.permissionDeniedCommentNoticeKeys[noticeKey]) {
      this.debugLog(`[feishu event ${event.eventId}] permission denied notice already commented key=${noticeKey}`)
      return
    }

    const inFlight = this.permissionDeniedCommentNoticeInFlight.get(noticeKey)
    if (inFlight) {
      await inFlight
      return
    }

    const task = this.writePermissionDeniedCommentNotice(event, noticeKey)
    this.permissionDeniedCommentNoticeInFlight.set(noticeKey, task)
    try {
      await task
    } finally {
      if (this.permissionDeniedCommentNoticeInFlight.get(noticeKey) === task) {
        this.permissionDeniedCommentNoticeInFlight.delete(noticeKey)
      }
    }
  }

  private async writePermissionDeniedCommentNotice(event: FeishuTaskEvent, noticeKey: string): Promise<void> {
    if (this.state.permissionDeniedCommentNoticeKeys[noticeKey]) return
    await this.commentTaskOrUploadFallback(event.taskGuid, PERMISSION_DENIED_COMMENT_REPLY, 'permission-denied-comment')
    this.state.permissionDeniedCommentNoticeKeys[noticeKey] = new Date().toISOString()
    this.prunePermissionDeniedCommentNotices()
    await this.persistState()
    this.debugLog(`[feishu event ${event.eventId}] permission denied notice commented key=${noticeKey}`)
  }

  private async getAppOwnerId(): Promise<string> {
    const expected = buildFeishuAppOwnerIdentity(this.config)
    const cached = this.state.appOwner
    if (
      cached
      && hasMatchingFeishuAppOwner(cached, expected)
      && isFreshTimestamp(cached.fetchedAt, APP_OWNER_CACHE_TTL_MS)
    ) {
      return cached.ownerId
    }

    this.debugLog(`[feishu app ${expected.appId}] loading owner user_id_type=${expected.userIdType}`)
    const owner = await this.feishu.getAppOwner()
    const ownerId = owner.ownerId.trim()
    if (!ownerId) {
      throw new Error(`Feishu app ${expected.appId} owner id is empty.`)
    }

    this.state.appOwner = {
      ...expected,
      ownerId,
      fetchedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[feishu app ${expected.appId}] owner cached user_id_type=${expected.userIdType}`)
    return ownerId
  }

  private async hydrateTaskContext(
    baseTask: FeishuTaskDetails,
    options: {
      comments?: FeishuTaskComment[]
      changedComment?: FeishuTaskComment
    } = {},
  ): Promise<FeishuTaskDetails> {
    const [subtasks, comments] = await Promise.all([
      this.feishu.listSubtasks(baseTask.guid),
      options.comments ? Promise.resolve(options.comments) : this.feishu.listComments(baseTask.guid),
    ])
    const hydratedTask = {
      ...baseTask,
      subtasks,
      comments: mergeComments(comments, options.changedComment),
    }
    this.debugLog(`[feishu task ${hydratedTask.guid}] hydrated children=${hydratedTask.subtasks.length} comments=${hydratedTask.comments.length}`)
    return hydratedTask
  }

  private collectFeishuTaskAttachmentRefs(task: FeishuTaskDetails): FeishuTaskAttachmentRef[] {
    const refs: FeishuTaskAttachmentRef[] = []
    const taskPrefix = `task-${task.guid.slice(0, 8)}-`

    for (const attachment of task.attachments ?? []) {
      refs.push({
        attachment,
        sourceLabel: `task:${task.guid}`,
        filenamePrefix: taskPrefix,
      })
    }

    for (const attachment of task.attachmentDeliveries ?? []) {
      refs.push({
        attachment,
        sourceLabel: `task_delivery:${task.guid}`,
        filenamePrefix: `delivery-${task.guid.slice(0, 8)}-`,
      })
    }

    for (const [index, subtask] of (task.subtasks ?? []).entries()) {
      const childPrefix = `child-${index + 1}-${subtask.guid.slice(0, 8)}-`
      for (const attachment of subtask.attachments ?? []) {
        refs.push({
          attachment,
          sourceLabel: `child:${subtask.guid}`,
          filenamePrefix: childPrefix,
        })
      }
      for (const attachment of subtask.attachmentDeliveries ?? []) {
        refs.push({
          attachment,
          sourceLabel: `child_delivery:${subtask.guid}`,
          filenamePrefix: `${childPrefix}delivery-`,
        })
      }
    }

    return refs
  }

  private async prepareFeishuTaskAttachments(task: FeishuTaskDetails): Promise<PreparedFeishuTaskAttachments> {
    const attachments: AampAttachment[] = []
    const notes: string[] = []
    const seenGuids = new Set<string>()

    for (const ref of this.collectFeishuTaskAttachmentRefs(task)) {
      if (seenGuids.has(ref.attachment.guid)) continue
      seenGuids.add(ref.attachment.guid)

      if (attachments.length >= MAX_INCOMING_FEISHU_ATTACHMENTS) {
        notes.push(`Skipped ${describeFeishuAttachment(ref.attachment)} from ${ref.sourceLabel}: reached ${MAX_INCOMING_FEISHU_ATTACHMENTS} attachment limit.`)
        continue
      }

      if (
        ref.attachment.size !== undefined
        && ref.attachment.size > MAX_INCOMING_FEISHU_ATTACHMENT_SIZE_BYTES
      ) {
        notes.push(`Skipped ${describeFeishuAttachment(ref.attachment)} from ${ref.sourceLabel}: larger than ${MAX_INCOMING_FEISHU_ATTACHMENT_SIZE_BYTES} bytes.`)
        continue
      }

      try {
        const downloaded = await this.feishu.downloadAttachment(ref.attachment)
        if (downloaded.content.byteLength > MAX_INCOMING_FEISHU_ATTACHMENT_SIZE_BYTES) {
          notes.push(`Skipped ${describeFeishuAttachment(downloaded.attachment)} from ${ref.sourceLabel}: downloaded file is larger than ${MAX_INCOMING_FEISHU_ATTACHMENT_SIZE_BYTES} bytes.`)
          continue
        }

        const filename = resolveAampAttachmentFilename(ref, downloaded.contentType)
        attachments.push({
          filename,
          contentType: resolveAttachmentContentType(filename, downloaded.contentType),
          content: downloaded.content,
          size: downloaded.content.byteLength,
        })
      } catch (error) {
        notes.push(`Failed to download ${describeFeishuAttachment(ref.attachment)} from ${ref.sourceLabel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (attachments.length > 0 || notes.length > 0) {
      this.debugLog(`[feishu task ${task.guid}] prepared attachments downloaded=${attachments.length} notes=${notes.length}`)
    }

    return { attachments, notes }
  }

  private async handleFeishuTaskEvent(event: FeishuTaskEvent): Promise<void> {
    this.state.lastFeishuEventAt = new Date().toISOString()
    this.state.lastFeishuEventId = event.eventId
    this.state.lastFeishuEventTaskGuid = event.taskGuid
    this.debugLog(`[feishu event ${event.eventId}] received task=${event.taskGuid} types=${event.eventTypes.join(',') || '(unknown)'}`)
    if (this.state.dedupEventIds[event.eventId]) {
      this.debugLog(`[feishu event ${event.eventId}] duplicate ignored`)
      await this.persistState()
      return
    }

    const eventKind = classifyFeishuTaskEvent(event.eventTypes)
    if (!eventKind) {
      await this.ignoreFeishuTaskEvent(event, 'event_type_not_allowlisted')
      return
    }
    const semanticEventKey = getSemanticEventKey(event, eventKind)
    if (semanticEventKey && this.state.dedupSemanticEventKeys[semanticEventKey]) {
      await this.ignoreFeishuTaskEvent(event, 'duplicate_task_event')
      return
    }
    this.logger.log(`${formatTaskLogPrefix(event.taskGuid, event.eventId)} received kind=${eventKind} types=${event.eventTypes.join(',') || '(unknown)'}`)

    let taskState: BridgeTaskState | undefined
    try {
      const { task, ignoreReason } = await this.loadTaskForDispatchEvent(event, eventKind)
      if (ignoreReason || !task) {
        await this.ignoreFeishuTaskEvent(event, ignoreReason ?? 'event_type_not_allowlisted')
        return
      }
      const preparedAttachments = await this.prepareFeishuTaskAttachments(task)
      const dispatch = buildFeishuTaskDispatch(event, task, eventKind, {
        feishuAppId: this.config.feishu.appId,
        ...buildFeishuTaskDispatchOptions(this.config),
      })
      const bodyText = appendAttachmentNotes(dispatch.bodyText, preparedAttachments.notes)
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
      const feishuCliProfile = this.config.feishu.cliProfile?.trim()
      this.debugLog([
        `[aamp dispatch ${dispatch.taskId}] sending`,
        `to=${this.config.targetAgentEmail}`,
        `session=${dispatch.sessionKey}`,
        `source=${dispatch.dispatchContext.source ?? '(none)'}`,
        `event_kind=${eventKind}`,
        `event_types=${event.eventTypes.join(',') || '(unknown)'}`,
        `feishu_auth_mode=${this.config.feishu.authMode ?? '(none)'}`,
        `feishu_cli_profile=${feishuCliProfile || '(none)'}`,
        `attachments=${preparedAttachments.attachments.length}`,
      ].join(' '))

      const result = await this.aamp.sendTask({
        to: this.config.targetAgentEmail,
        taskId: dispatch.taskId,
        sessionKey: dispatch.sessionKey,
        title: dispatch.title,
        bodyText,
        rawBodyText: bodyText,
        dispatchContext: dispatch.dispatchContext,
        promptRules: dispatch.promptRules,
        attachments: preparedAttachments.attachments.length ? preparedAttachments.attachments : undefined,
      })

      this.state.tasks[dispatch.taskId] = {
        ...taskState,
        aampMessageId: result.messageId,
        status: 'dispatched',
        updatedAt: new Date().toISOString(),
      }
      this.state.lastAampDispatchAt = new Date().toISOString()
      this.state.lastAampDispatchTaskId = dispatch.taskId
      this.rememberEvent(event, semanticEventKey)
      await this.persistState()
      this.logger.log(`${formatTaskLogPrefix(task.guid, event.eventId)} dispatch sent aamp_task=${dispatch.taskId} to=${this.config.targetAgentEmail} attachments=${preparedAttachments.attachments.length} attachment_notes=${preparedAttachments.notes.length}`)
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
      .catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${aampTaskId}] ${error.message}`)
        await this.persistState()
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

    if (isStreamExecutionSignal(stepContents)) {
      await this.markFeishuTasksInProgressOnce(aampTaskId, baseState)
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
      .catch(async (error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp stream ${aampTaskId}] ${error.message}`)
        this.scheduleStreamStepFlush(aampTaskId)
        await this.persistState()
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
    const nextStepCount = (latestTaskState.streamStepCount ?? 0) + stepsToFlush.length
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      streamStepCount: nextStepCount,
      streamStepTexts: [...latestStreamStepTexts],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.logger.log(`${formatTaskLogPrefix(latestTaskState.taskGuid)} steps flushed count=${stepsToFlush.length} total=${nextStepCount}`)
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

    const ackCommentEventKey = getAckCommentEventKey(taskState)
    if (ackCommentEventKey && this.state.ackCommentedEventKeys[ackCommentEventKey]) {
      this.logger.log(`[aamp ack ${ack.taskId}] semantic comment already recorded key=${ackCommentEventKey}`)
      this.state.tasks[ack.taskId] = {
        ...taskState,
        status: 'acknowledged',
        ackCommentedEventKeys: [...new Set([...(taskState.ackCommentedEventKeys ?? []), ackCommentEventKey])],
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

      const updatedTaskState = markAckCommented(taskState, ack.taskId)
      this.state.tasks[ack.taskId] = ackCommentEventKey
        ? {
          ...updatedTaskState,
          ackCommentedEventKeys: [...new Set([...(updatedTaskState.ackCommentedEventKeys ?? []), ackCommentEventKey])],
        }
        : updatedTaskState
      if (ackCommentEventKey) {
        this.state.ackCommentedEventKeys[ackCommentEventKey] = new Date().toISOString()
        this.pruneAckCommentedEvents()
      }
      await this.persistState()
      this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} ack commented aamp_task=${ack.taskId}`)
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
        await this.markFeishuTasksBlockedOnce(help.taskId, latestTaskState)
        return
      }

      const comment = (help.question ?? '').trim()
        || (help.blockedReason ?? '').trim()
        || '智能体需要更多信息才能继续处理该任务。'
      this.debugLog(`[aamp help ${help.taskId}] commenting on Feishu task ${latestTaskState.taskGuid}`)
      await this.commentTaskOrUploadFallback(latestTaskState.taskGuid, comment, 'help-needed-comment')

      const helpCommentedTaskIds = new Set(latestTaskState.helpCommentedTaskIds ?? [])
      helpCommentedTaskIds.add(help.taskId)
      const updatedState: BridgeTaskState = {
        ...latestTaskState,
        status: 'help_needed',
        helpCommentedTaskIds: [...helpCommentedTaskIds],
        updatedAt: new Date().toISOString(),
      }
      this.state.tasks[help.taskId] = updatedState
      await this.markFeishuTasksBlockedOnce(help.taskId, updatedState)
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
        if (disposition.replyWritten === false && disposition.summary) {
          await this.commentAnsweredResultOnce(result.taskId, flushedTaskState, disposition.summary)
        }

        await this.completeFeishuTasksOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)

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
        await this.markFeishuTasksBlockedOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)
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

      if (disposition.kind === 'succeeded') {
        this.logger.log(`${formatTaskLogPrefix(flushedTaskState.taskGuid)} result outputs ${formatOutputCounts(disposition.outputs)}`)
        try {
          await this.applyTaskResultOutputs(result.taskId, flushedTaskState, disposition.outputs)
        } catch (error) {
          if (isRetryableFeishuError(error)) {
            await this.recordRetryableTaskResultError(
              result.taskId,
              this.state.tasks[result.taskId] ?? flushedTaskState,
              error,
            )
            return
          }
          await this.closeTaskResultAsFailure(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState, {
            kind: 'failure',
            summary: disposition.summary,
            message: error instanceof Error ? error.message : String(error),
          })
          return
        }
        await this.completeFeishuTasksOnce(result.taskId, this.state.tasks[result.taskId] ?? flushedTaskState)

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
        this.logger.log(`${formatTaskLogPrefix(latestTaskState.taskGuid)} result closed aamp_task=${result.taskId} status=succeeded`)
        return
      }

      await this.closeTaskResultAsFailure(result.taskId, flushedTaskState, disposition)
    } finally {
      this.resultInFlight.delete(result.taskId)
    }
  }

  private async recordRetryableTaskResultError(
    aampTaskId: string,
    taskState: BridgeTaskState,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    this.state.lastError = message
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      lastError: message,
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.logger.error(`${formatTaskLogPrefix(latestTaskState.taskGuid)} result output write retryable_error aamp_task=${aampTaskId} error=${message}`)
  }

  private async closeTaskResultAsFailure(
    aampTaskId: string,
    taskState: BridgeTaskState,
    disposition: Extract<TaskResultDisposition, { kind: 'failure' }>,
  ): Promise<void> {
    await this.commentTaskResultOnce(aampTaskId, taskState, disposition)
    await this.completeFeishuTasksOnce(aampTaskId, this.state.tasks[aampTaskId] ?? taskState)

    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    const resultHandledTaskIds = new Set(latestTaskState.resultHandledTaskIds ?? [])
    resultHandledTaskIds.add(aampTaskId)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      status: 'failed',
      resultHandledTaskIds: [...resultHandledTaskIds],
      lastError: disposition.message,
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.logger.log(`${formatTaskLogPrefix(latestTaskState.taskGuid)} result closed aamp_task=${aampTaskId} status=failure`)
  }

  private async applyTaskResultOutputs(
    aampTaskId: string,
    taskState: BridgeTaskState,
    outputs: FeishuTaskResultOutput[],
  ): Promise<void> {
    if (outputs.length === 0) return

    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index]
      if (output.kind === 'file_delivery' && !this.hasResultOutputApplied(aampTaskId, getResultOutputApplyKey(index, output))) {
        await this.validateFileDeliveryPath(output.path)
      }
    }

    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index]
      if (output.kind === 'reply_comment') continue
      await this.applyTaskResultDeliveryOutputOnce(aampTaskId, taskState, index, output)
    }

    const replyOutputs = outputs
      .filter((output): output is Extract<FeishuTaskResultOutput, { kind: 'reply_comment' }> => output.kind === 'reply_comment')
    const replyContent = replyOutputs
      .map((output) => output.content)
      .join('\n\n')
    if (replyContent) {
      await this.commentReplyOutputOnce(aampTaskId, taskState, replyContent, getReplyCommentOutputApplyKey(replyOutputs))
    }
  }

  private async applyTaskResultDeliveryOutputOnce(
    aampTaskId: string,
    taskState: BridgeTaskState,
    index: number,
    output: Exclude<FeishuTaskResultOutput, { kind: 'reply_comment' }>,
  ): Promise<void> {
    const outputKey = getResultOutputApplyKey(index, output)
    if (this.hasResultOutputApplied(aampTaskId, outputKey)) {
      this.debugLog(`[aamp result ${aampTaskId}] output already applied key=${outputKey}`)
      return
    }

    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if (output.kind === 'link_delivery') {
      await this.feishu.appendTextDeliveries(latestTaskState.taskGuid, [output.url])
    } else if (output.kind === 'file_delivery') {
      await this.uploadFileDelivery(latestTaskState.taskGuid, output.path)
    } else {
      await this.uploadTextDelivery(latestTaskState.taskGuid, output)
    }
    await this.markResultOutputApplied(aampTaskId, latestTaskState, outputKey)
  }

  private hasResultOutputApplied(aampTaskId: string, outputKey: string): boolean {
    return Boolean(this.state.tasks[aampTaskId]?.resultAppliedOutputKeys?.includes(outputKey))
  }

  private async markResultOutputApplied(
    aampTaskId: string,
    taskState: BridgeTaskState,
    outputKey: string,
  ): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.resultAppliedOutputKeys ?? []).includes(outputKey)) return
    const resultAppliedOutputKeys = new Set(latestTaskState.resultAppliedOutputKeys ?? [])
    resultAppliedOutputKeys.add(outputKey)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      resultAppliedOutputKeys: [...resultAppliedOutputKeys],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
  }

  private async commentReplyOutputOnce(
    aampTaskId: string,
    taskState: BridgeTaskState,
    content: string,
    outputKey?: string,
  ): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if (outputKey && this.hasResultOutputApplied(aampTaskId, outputKey)) {
      this.debugLog(`[aamp result ${aampTaskId}] reply output already applied key=${outputKey}`)
      return
    }
    if ((latestTaskState.resultCommentedTaskIds ?? []).includes(aampTaskId)) {
      this.logger.log(`[aamp result ${aampTaskId}] reply comment already recorded`)
      if (outputKey) {
        await this.markResultOutputApplied(aampTaskId, latestTaskState, outputKey)
      }
      return
    }

    this.debugLog(`[aamp result ${aampTaskId}] commenting reply output on Feishu task ${latestTaskState.taskGuid}`)
    await this.commentTaskOrUploadFallback(latestTaskState.taskGuid, content, 'reply-comment')

    const resultCommentedTaskIds = new Set(latestTaskState.resultCommentedTaskIds ?? [])
    resultCommentedTaskIds.add(aampTaskId)
    const resultAppliedOutputKeys = new Set(latestTaskState.resultAppliedOutputKeys ?? [])
    if (outputKey) resultAppliedOutputKeys.add(outputKey)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      resultCommentedTaskIds: [...resultCommentedTaskIds],
      resultAppliedOutputKeys: [...resultAppliedOutputKeys],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[aamp result ${aampTaskId}] commented reply output on Feishu task ${latestTaskState.taskGuid}`)
  }

  private async uploadFileDelivery(taskGuid: string, filePath: string): Promise<void> {
    await this.validateFileDeliveryPath(filePath)
    await this.feishu.uploadTaskDelivery(taskGuid, filePath)
  }

  private async validateFileDeliveryPath(filePath: string): Promise<void> {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`file_delivery.path must be an absolute path: ${filePath}`)
    }
    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch (error) {
      throw new Error(`file_delivery.path 不存在或不可读取：${filePath}${error instanceof Error ? ` (${error.message})` : ''}`)
    }
    if (!fileStat.isFile()) {
      throw new Error(`file_delivery.path is not a regular file: ${filePath}`)
    }
    if (fileStat.size > MAX_DELIVERY_FILE_SIZE_BYTES) {
      throw new Error(`file_delivery.path exceeds 50 MB: ${filePath}`)
    }
  }

  private async uploadTextDelivery(
    taskGuid: string,
    output: Extract<FeishuTaskResultOutput, { kind: 'text_delivery' }>,
  ): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-task-delivery-'))
    const extension = output.format === 'plain_text' ? '.txt' : '.md'
    const fileName = `${sanitizeDeliveryFileName(output.title ?? 'text-delivery')}${extension}`
    const filePath = path.join(tempDir, fileName)
    try {
      await writeFile(filePath, output.content, 'utf8')
      await this.feishu.uploadTaskDelivery(taskGuid, filePath)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async commentTaskOrUploadFallback(taskGuid: string, content: string, fallbackTitle: string): Promise<void> {
    if (isFeishuCommentWithinLimit(content)) {
      await this.feishu.commentTask(taskGuid, content)
      return
    }

    await this.uploadTextDelivery(taskGuid, {
      kind: 'text_delivery',
      title: fallbackTitle,
      format: 'markdown',
      content,
    })
    await this.feishu.commentTask(taskGuid, buildOversizedCommentDeliveryNotice(content))
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
    await this.commentTaskOrUploadFallback(latestTaskState.taskGuid, comment, 'help-needed-result')

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

  private async commentAnsweredResultOnce(aampTaskId: string, taskState: BridgeTaskState, summary: string): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.resultCommentedTaskIds ?? []).includes(aampTaskId)) {
      this.logger.log(`[aamp result ${aampTaskId}] answered comment already recorded`)
      return
    }

    this.debugLog(`[aamp result ${aampTaskId}] commenting answered result on Feishu task ${latestTaskState.taskGuid}`)
    await this.commentTaskOrUploadFallback(latestTaskState.taskGuid, summary, 'answered-result')

    const resultCommentedTaskIds = new Set(latestTaskState.resultCommentedTaskIds ?? [])
    resultCommentedTaskIds.add(aampTaskId)
    this.state.tasks[aampTaskId] = {
      ...latestTaskState,
      resultCommentedTaskIds: [...resultCommentedTaskIds],
      updatedAt: new Date().toISOString(),
    }
    await this.persistState()
    this.debugLog(`[aamp result ${aampTaskId}] commented answered result on Feishu task ${latestTaskState.taskGuid}`)
  }

  private async commentTaskResultOnce(
    aampTaskId: string,
    taskState: BridgeTaskState,
    disposition: Extract<TaskResultDisposition, { kind: 'failure' }>,
  ): Promise<void> {
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.resultCommentedTaskIds ?? []).includes(aampTaskId)) {
      this.logger.log(`[aamp result ${aampTaskId}] result comment already recorded`)
      return
    }

    const comment = [
      ...(disposition.summary ? [disposition.summary, ''] : []),
      `失败原因：${disposition.message}`,
    ].join('\n')

    this.debugLog(`[aamp result ${aampTaskId}] commenting result on Feishu task ${latestTaskState.taskGuid}`)
    await this.commentTaskOrUploadFallback(latestTaskState.taskGuid, comment, 'failed-result')

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

  private getTaskGuids(taskState: BridgeTaskState, order: 'parent-first' | 'children-first'): string[] {
    const taskGuids = order === 'parent-first'
      ? [taskState.taskGuid, ...(taskState.childTaskGuids ?? [])]
      : [...(taskState.childTaskGuids ?? []), taskState.taskGuid]
    return [...new Set(taskGuids)]
  }

  private async markFeishuTasksInProgressOnce(aampTaskId: string, taskState: BridgeTaskState): Promise<void> {
    const markedTaskGuids: string[] = []
    for (const taskGuid of this.getTaskGuids(taskState, 'parent-first')) {
      if (await this.markFeishuTaskInProgressOnce(aampTaskId, taskState, taskGuid)) {
        markedTaskGuids.push(taskGuid)
      }
    }
    if (markedTaskGuids.length > 0) {
      this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} marked in_progress parent=${markedTaskGuids.includes(taskState.taskGuid) ? 1 : 0} children=${markedTaskGuids.filter((taskGuid) => taskGuid !== taskState.taskGuid).length}`)
    }
  }

  private async markFeishuTaskInProgressOnce(aampTaskId: string, taskState: BridgeTaskState, taskGuid: string): Promise<boolean> {
    const inFlightKey = `${aampTaskId}:${taskGuid}`
    if (this.feishuInProgressInFlight.has(inFlightKey)) return false
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.feishuInProgressTaskIds ?? []).includes(taskGuid)) {
      return false
    }

    this.feishuInProgressInFlight.add(inFlightKey)
    try {
      this.debugLog(`[feishu task ${taskGuid}] marking in progress for ${aampTaskId}`)
      await this.feishu.markTaskInProgress(taskGuid)

      const feishuInProgressTaskIds = new Set(latestTaskState.feishuInProgressTaskIds ?? [])
      feishuInProgressTaskIds.add(taskGuid)
      this.state.tasks[aampTaskId] = {
        ...latestTaskState,
        feishuInProgressTaskIds: [...feishuInProgressTaskIds],
        updatedAt: new Date().toISOString(),
      }
      await this.persistState()
      this.debugLog(`[feishu task ${taskGuid}] marked in progress for ${aampTaskId}`)
      return true
    } finally {
      this.feishuInProgressInFlight.delete(inFlightKey)
    }
  }

  private async completeFeishuTasksOnce(aampTaskId: string, taskState: BridgeTaskState): Promise<void> {
    const completedTaskGuids: string[] = []
    for (const taskGuid of this.getTaskGuids(taskState, 'children-first')) {
      if (await this.completeFeishuTaskOnce(aampTaskId, taskState, taskGuid)) {
        completedTaskGuids.push(taskGuid)
      }
    }
    if (completedTaskGuids.length > 0) {
      this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} completed parent=${completedTaskGuids.includes(taskState.taskGuid) ? 1 : 0} children=${completedTaskGuids.filter((taskGuid) => taskGuid !== taskState.taskGuid).length}`)
    }
  }

  private async completeFeishuTaskOnce(aampTaskId: string, taskState: BridgeTaskState, taskGuid: string): Promise<boolean> {
    const inFlightKey = `${aampTaskId}:${taskGuid}`
    if (this.feishuCompleteInFlight.has(inFlightKey)) return false
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.feishuCompletedTaskIds ?? []).includes(taskGuid)) {
      this.debugLog(`[feishu task ${taskGuid}] completion already recorded for ${aampTaskId}`)
      return false
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
      this.debugLog(`[feishu task ${taskGuid}] completed for ${aampTaskId}`)
      return true
    } finally {
      this.feishuCompleteInFlight.delete(inFlightKey)
    }
  }

  private async markFeishuTasksBlockedOnce(aampTaskId: string, taskState: BridgeTaskState): Promise<void> {
    const blockedTaskGuids: string[] = []
    for (const taskGuid of this.getTaskGuids(taskState, 'children-first')) {
      if (await this.markFeishuTaskBlockedOnce(aampTaskId, taskState, taskGuid)) {
        blockedTaskGuids.push(taskGuid)
      }
    }
    if (blockedTaskGuids.length > 0) {
      this.logger.log(`${formatTaskLogPrefix(taskState.taskGuid)} blocked parent=${blockedTaskGuids.includes(taskState.taskGuid) ? 1 : 0} children=${blockedTaskGuids.filter((taskGuid) => taskGuid !== taskState.taskGuid).length}`)
    }
  }

  private async markFeishuTaskBlockedOnce(aampTaskId: string, taskState: BridgeTaskState, taskGuid: string): Promise<boolean> {
    const inFlightKey = `${aampTaskId}:${taskGuid}`
    if (this.feishuBlockInFlight.has(inFlightKey)) return false
    const latestTaskState = this.state.tasks[aampTaskId] ?? taskState
    if ((latestTaskState.feishuBlockedTaskIds ?? []).includes(taskGuid)) {
      this.debugLog(`[feishu task ${taskGuid}] blocked state already recorded for ${aampTaskId}`)
      return false
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
      this.debugLog(`[feishu task ${taskGuid}] marked blocked for ${aampTaskId}`)
      return true
    } finally {
      this.feishuBlockInFlight.delete(inFlightKey)
    }
  }

  private pruneTaskState(): number {
    const now = Date.now()
    let prunedCount = 0
    const terminalTasks = Object.entries(this.state.tasks)
      .filter(([, taskState]) => taskState.status === 'completed' || taskState.status === 'failed' || taskState.status === 'help_needed')

    for (const [aampTaskId, taskState] of terminalTasks) {
      const updatedAt = Date.parse(taskState.updatedAt)
      if (!Number.isFinite(updatedAt)) continue
      const retentionMs = taskState.status === 'help_needed'
        ? HELP_NEEDED_TASK_RETENTION_MS
        : TERMINAL_TASK_RETENTION_MS
      if (now - updatedAt > retentionMs) {
        delete this.state.tasks[aampTaskId]
        prunedCount += 1
      }
    }

    const remainingTerminalTasks = Object.entries(this.state.tasks)
      .filter(([, taskState]) => taskState.status === 'completed' || taskState.status === 'failed' || taskState.status === 'help_needed')
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
    const overflow = remainingTerminalTasks.length - MAX_RETAINED_TERMINAL_TASKS
    if (overflow > 0) {
      for (const [aampTaskId] of remainingTerminalTasks.slice(0, overflow)) {
        delete this.state.tasks[aampTaskId]
        prunedCount += 1
      }
    }

    return prunedCount
  }

  private rememberEvent(event: FeishuTaskEvent, semanticEventKey?: string): boolean {
    if (this.state.dedupEventIds[event.eventId]) return false
    this.state.dedupEventIds[event.eventId] = new Date().toISOString()
    if (semanticEventKey) {
      this.state.dedupSemanticEventKeys[semanticEventKey] = new Date().toISOString()
      this.pruneSemanticDedupEvents()
    }
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

  private pruneSemanticDedupEvents(): void {
    const entries = Object.entries(this.state.dedupSemanticEventKeys)
    if (entries.length <= 1000) return
    entries
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, entries.length - 1000)
      .forEach(([eventKey]) => {
        delete this.state.dedupSemanticEventKeys[eventKey]
      })
  }

  private pruneAckCommentedEvents(): void {
    const entries = Object.entries(this.state.ackCommentedEventKeys)
    if (entries.length <= 1000) return
    entries
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, entries.length - 1000)
      .forEach(([eventKey]) => {
        delete this.state.ackCommentedEventKeys[eventKey]
      })
  }

  private prunePermissionDeniedCommentNotices(): void {
    const now = Date.now()
    const notices = this.state.permissionDeniedCommentNoticeKeys
    for (const [noticeKey, createdAt] of Object.entries(notices)) {
      const timestamp = Date.parse(createdAt)
      if (Number.isFinite(timestamp) && now - timestamp > PERMISSION_DENIED_COMMENT_NOTICE_RETENTION_MS) {
        delete notices[noticeKey]
      }
    }

    const entries = Object.entries(notices)
    if (entries.length <= MAX_PERMISSION_DENIED_COMMENT_NOTICE_KEYS) return
    entries
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, entries.length - MAX_PERMISSION_DENIED_COMMENT_NOTICE_KEYS)
      .forEach(([noticeKey]) => {
        delete notices[noticeKey]
      })
  }

  private setConnectivity(kind: ConnectivityKind, value: BridgeState['connectivity'][ConnectivityKind]): void {
    this.state.connectivity[kind] = value
  }

  private debugLog(message: string): void {
    this.logger.debug(message)
  }

  private async persistState(): Promise<void> {
    await saveBridgeState(this.state, this.configDir)
  }
}
