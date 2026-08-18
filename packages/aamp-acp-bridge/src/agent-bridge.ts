import {
  AampClient,
  type TaskDispatch,
  type AampAttachment,
  type ReceivedAttachment,
  type StructuredResultField,
  type TaskCancel,
  type AampThreadEvent,
  type PairRequest,
} from 'aamp-sdk'
import {
  AcpxClient,
  type AcpPlanEntry,
  type AcpTextChunk,
  type AcpToolUpdate,
} from './acpx-client.js'
import { buildPrompt, parseResponse, type ResultAttachmentRef } from './prompt-builder.js'
import {
  defaultAgentSlug,
  normalizeAgentConfig,
  type AgentConfig,
  type AgentConfigInput,
  type AgentExecutionLocation,
} from './config.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getBridgeHomeDir, resolveCredentialsFile } from './storage.js'
import {
  addSenderPolicy,
  consumePairingCode,
  loadSenderPolicies,
  resolvePairingFile,
  resolveSenderPoliciesFile,
  rulesMatch,
  validatePairingCode,
  type SenderPolicy,
} from './pairing.js'
import type { BridgeRuntimeEvent } from './bridge.js'
import { UserFacingBridgeError } from './errors.js'

const TEXT_DELTA_FLUSH_MS = 5_000
const TEXT_DELTA_FLUSH_CHARS = 120
const TEXT_DELTA_BOUNDARY_CHARS = 32
const IDENTITY_AUTH_RETRY_COUNT = 5
const IDENTITY_AUTH_RETRY_DELAY_MS = 1_000
const SESSION_KEY_DISPATCH_CONTEXT_KEY = 'aamp_session_key'
const ACP_AUTH_FAILURE_PATTERN = /authentication (?:required|failed)/i
const TASK_LIFECYCLE_HISTORY_LIMIT = 256

export interface AgentIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
}

type AgentBridgeAcpxClient = Pick<
  AcpxClient,
  'probeAgent' | 'ensureSession' | 'prompt' | 'cancel' | 'close' | 'stop'
>

type TaskTerminalOutcome = 'completed' | 'help_needed' | 'rejected'

interface ActiveTaskSession {
  readonly agent: string
  readonly sessionName: string
  readonly sessionWaitController: AbortController
  phase: 'active' | 'cancelled' | 'terminal'
  terminalOutcome?: TaskTerminalOutcome
  promptStarted: boolean
  cancelForwarded: boolean
  clearPendingText?: () => void
}

class BoundedStringMap<Value> {
  private readonly values = new Map<string, Value>()

  constructor(private readonly limit: number) {}

  get(key: string): Value | undefined {
    const value = this.values.get(key)
    if (value === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  take(key: string): Value | undefined {
    const value = this.values.get(key)
    if (value !== undefined) this.values.delete(key)
    return value
  }

  set(key: string, value: Value): void {
    this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next()
      if (oldest.done) return
      this.values.delete(oldest.value)
    }
  }
}

type SessionMutexRelease = () => void
interface SessionMutexWaiter {
  readonly resolve: (release: SessionMutexRelease | null) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

class FairKeyedMutex {
  private readonly waiters = new Map<string, SessionMutexWaiter[]>()

  acquire(key: string, signal: AbortSignal): Promise<SessionMutexRelease | null> {
    if (signal.aborted) return Promise.resolve(null)

    return new Promise((resolve) => {
      const queue = this.waiters.get(key)
      if (queue) {
        const waiter = {
          resolve,
          signal,
          onAbort: () => {
            const currentQueue = this.waiters.get(key)
            const index = currentQueue?.indexOf(waiter) ?? -1
            if (index >= 0) currentQueue?.splice(index, 1)
            signal.removeEventListener('abort', waiter.onAbort)
            resolve(null)
          },
        } satisfies SessionMutexWaiter
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        queue.push(waiter)
        return
      }

      this.waiters.set(key, [])
      resolve(this.createRelease(key))
    })
  }

  private createRelease(key: string): SessionMutexRelease {
    let released = false
    return () => {
      if (released) return
      released = true

      const queue = this.waiters.get(key)
      const next = queue?.shift()
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort)
        next.resolve(this.createRelease(key))
        return
      }
      this.waiters.delete(key)
    }
  }
}

export interface AgentBridgeDependencies {
  readonly createClient: typeof AampClient.fromMailboxIdentity
  readonly createAcpx: () => AgentBridgeAcpxClient
  readonly resolveIdentity?: () => Promise<AgentIdentity>
}

const defaultDependencies: AgentBridgeDependencies = {
  createClient: (config) => AampClient.fromMailboxIdentity(config),
  createAcpx: () => new AcpxClient(),
}

function matchSenderPolicy(
  task: TaskDispatch,
  senderPolicies: AgentConfig['senderPolicies'],
): { allowed: boolean; reason?: string } {
  if (!senderPolicies?.length) return { allowed: false, reason: 'no configured senderPolicies' }

  const sender = task.from.toLowerCase()
  const policy = senderPolicies.find((item) => matchesSenderPattern(sender, item.sender))
  if (!policy) {
    return { allowed: false, reason: `sender ${task.from} is not allowed by senderPolicies` }
  }

  const rules = policy.dispatchContextRules
  if (!rules || Object.keys(rules).length === 0) {
    return { allowed: true }
  }

  const context = task.dispatchContext ?? {}
  const effectiveRules = Object.entries(rules)
    .map(([key, allowedValues]) => [
      key,
      (allowedValues ?? []).map((value) => value.trim()).filter(Boolean),
    ] as const)
    .filter(([, allowedValues]) => allowedValues.length > 0)

  if (effectiveRules.length === 0) {
    return { allowed: true }
  }

  for (const [key, allowedValues] of effectiveRules) {
    const contextValue = context[key]
    if (!contextValue) {
      return { allowed: false, reason: `dispatchContext missing required key "${key}"` }
    }
    if (!allowedValues.includes(contextValue)) {
      return { allowed: false, reason: `dispatchContext ${key}=${contextValue} is not allowed` }
    }
  }

  return { allowed: true }
}

function matchesSenderPattern(senderEmail: string, pattern: string): boolean {
  const normalizedSender = senderEmail.trim().toLowerCase()
  const normalizedPattern = pattern.trim().toLowerCase()
  if (!normalizedSender || !normalizedPattern) return false
  const canonicalPattern = normalizedPattern.startsWith('@')
    ? `*${normalizedPattern}`
    : normalizedPattern
  const escaped = canonicalPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(normalizedSender)
}

function matchPairedSenderPolicy(
  task: TaskDispatch,
  senderPolicies: SenderPolicy[],
): { allowed: boolean; reason?: string } {
  if (senderPolicies.length === 0) return { allowed: false, reason: 'no paired sender policies configured' }

  const sender = task.from.toLowerCase()
  const policy = senderPolicies.find((item) => item.sender.trim().toLowerCase() === sender)
  if (!policy) {
    return { allowed: false, reason: `sender ${task.from} is not paired` }
  }

  if (!rulesMatch(policy.dispatchContextRules, task.dispatchContext)) {
    return { allowed: false, reason: `dispatchContext does not match paired sender policy for ${task.from}` }
  }

  return { allowed: true }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toBasicAuth(email: string, password: string): string {
  return `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`
}

function matchCombinedSenderPolicy(
  task: TaskDispatch,
  configuredPolicies: AgentConfig['senderPolicies'],
  pairedPolicies: SenderPolicy[],
): { allowed: boolean; reason?: string } {
  const hasConfiguredPolicies = Boolean(configuredPolicies?.length)
  const hasPairedPolicies = pairedPolicies.length > 0
  if (!hasConfiguredPolicies && !hasPairedPolicies) {
    return { allowed: false, reason: 'no sender policy configured' }
  }

  const configuredDecision = hasConfiguredPolicies
    ? matchSenderPolicy(task, configuredPolicies)
    : { allowed: false, reason: undefined }
  if (configuredDecision.allowed) return configuredDecision

  const pairedDecision = hasPairedPolicies
    ? matchPairedSenderPolicy(task, pairedPolicies)
    : { allowed: false, reason: undefined }
  if (pairedDecision.allowed) return pairedDecision

  return configuredDecision.reason ? configuredDecision : pairedDecision
}

export interface AgentBridgeStartOptions {
  quiet?: boolean
  onEvent?: (event: BridgeRuntimeEvent) => void
  debug?: boolean
}

function workbuddyProductName(agentName: string): string | undefined {
  const normalized = agentName.trim().toLowerCase()
  if (normalized === 'workbuddy') return 'WorkBuddy'
  if (normalized === 'workbuddy_ai') return 'WorkBuddy AI'
  return undefined
}

export function requiresStartupReadinessProbe(agent: Pick<AgentConfig, 'name'>): boolean {
  return workbuddyProductName(agent.name) !== undefined
}

export function formatAgentReadinessError(agentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const productName = workbuddyProductName(agentName)
  if (productName) {
    if (ACP_AUTH_FAILURE_PATTERN.test(message)) {
      return `${productName} is not logged in. Open ${productName} and sign in, then retry.`
    }
    return `${productName} ACP readiness check failed: ${message}`
  }
  return message
}

export function formatTaskAgentError(
  agentName: string,
  error: unknown,
  executionLocation: AgentExecutionLocation = 'local',
): string {
  const message = error instanceof Error ? error.message : String(error)
  if (executionLocation === 'remote') {
    const diagnostic = redactRemoteDiagnostic(message)
    const safeCode = /\b(?:REMOTE_ARTIFACT_UNSUPPORTED|(?:AIME|AUTH)_[A-Z0-9_]+)\b/.exec(message)?.[0]
    if (safeCode === 'REMOTE_ARTIFACT_UNSUPPORTED') {
      return 'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.'
    }
    if (safeCode === 'AUTH_REQUIRED') {
      const site = /\baime-acp auth login --site (cn|i18n-tt)\b/.exec(diagnostic)?.[1]
      return 'AUTH_REQUIRED: Remote Agent authentication is required.'
        + (site ? ' Run `aime-acp auth login --site ' + site + '`.' : '')
    }
    if (safeCode === 'AUTH_IDENTITY_CHANGED') {
      return 'AUTH_IDENTITY_CHANGED: Restart the binding after verifying the remote account.'
    }
    if (diagnostic.trim()) return diagnostic
    return safeCode ? `${safeCode}: Remote Agent execution failed.` : 'REMOTE_AGENT_FAILED: Remote Agent execution failed.'
  }
  const productName = workbuddyProductName(agentName)
  if (productName && ACP_AUTH_FAILURE_PATTERN.test(message)) {
    return `${productName} login expired. Open ${productName} and sign in, then retry the task.`
  }
  return message
}

function redactRemoteDiagnostic(message: string): string {
  return message
    .replace(/\b(Bearer|Basic)\s+[^\s,}]+/gi, '$1 [REDACTED]')
    .replace(/(\b(?:Authorization|Proxy-Authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\s,}]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:app_secret|appSecret|smtpPassword|mailboxToken|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|session_token|sessionToken|device_code|pairCode|api_key|apiKey|private_key|privateKey|password|authorization|cookie|credential|secret|token)\b\s*[:=]\s*"?)(?:(?:Bearer|Basic)\s+)?[^,\s}"]+/gi, '$1[REDACTED]')
    .replace(/(--(?:app-secret|password|secret-token|token)\s+)\S+/gi, '$1[REDACTED]')
}

export function formatDebugPromptLog(options: {
  agentName: string
  taskId: string
  sessionName: string
  prompt: string
}): string {
  const digest = createHash('sha256').update(options.prompt).digest('hex')
  return `[${options.agentName}] ACP prompt debug task=${options.taskId} session=${options.sessionName} prompt_chars=${options.prompt.length} prompt_sha256=${digest} content_logged=false`
}

export function assertSupportedResultArtifacts(
  parsed: ReturnType<typeof parseResponse>,
  executionLocation: AgentExecutionLocation,
): void {
  const hasArtifact = parsed.files.length > 0
    || Boolean(parsed.attachments?.length)
    || Boolean(parsed.structuredResult?.some(isRemoteStructuredArtifactField))
  if (executionLocation === 'remote' && hasArtifact) {
    throw new UserFacingBridgeError(
      'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
    )
  }
}

interface HandleEventOptions {
  historical?: boolean
}

interface StreamTextRenderState {
  currentChannel?: AcpTextChunk['channel']
  currentMessageId?: string
  hasContent: boolean
}

interface MaterializedIncomingAttachments {
  promptLines: string[]
  directory?: string
}

function buildPhaseStatusLabel(channel: AcpTextChunk['channel']): string {
  return channel === 'thought'
    ? 'ACP agent is thinking'
    : 'ACP agent is composing the reply'
}

function buildToolProgressLabel(update: AcpToolUpdate): string {
  const target = update.title?.trim()
    || update.locations?.[0]?.path
    || update.kind?.trim()
    || 'tool'

  switch (update.status) {
    case 'completed':
      return `Tool completed: ${target}`
    case 'failed':
      return `Tool failed: ${target}`
    case 'pending':
      return `Tool pending: ${target}`
    case 'in_progress':
    default:
      return `Tool running: ${target}`
  }
}

function buildToolProgressDetail(update: AcpToolUpdate): string | undefined {
  if (typeof update.text === 'string' && update.text.trim()) return update.text.trim()

  const detail = {
    ...(update.title?.trim() ? { title: update.title.trim() } : {}),
    ...(update.kind?.trim() ? { kind: update.kind.trim() } : {}),
    ...(update.locations?.length ? { locations: update.locations } : {}),
  }
  return Object.keys(detail).length ? JSON.stringify(detail, null, 2) : undefined
}

function formatPlanUpdate(entries: AcpPlanEntry[]): string {
  const lines = entries.map((entry) => {
    const prefix = entry.status ? `[${entry.status}] ` : ''
    return `- ${prefix}${entry.content}`
  })
  return `[plan]\n${lines.join('\n')}`
}

function normalizePlanStatus(status?: string): string {
  const value = status?.toLowerCase()
  if (value === 'completed' || value === 'done' || value === 'success') return 'completed'
  if (value === 'in_progress' || value === 'running' || value === 'active') return 'in_progress'
  return 'pending'
}

function buildTodoPayloadFromPlan(entries: AcpPlanEntry[]) {
  return {
    items: entries.map((entry, index) => ({
      id: `plan-${index + 1}`,
      content: entry.content,
      status: normalizePlanStatus(entry.status),
    })),
  }
}

function normalizeToolCallStatus(status?: string): 'pending' | 'running' | 'completed' | 'failed' {
  const value = status?.toLowerCase()
  if (value === 'completed' || value === 'done' || value === 'success') return 'completed'
  if (value === 'failed' || value === 'error' || value === 'rejected') return 'failed'
  if (value === 'pending') return 'pending'
  return 'running'
}

function renderTextChunk(chunk: AcpTextChunk, state: StreamTextRenderState): string {
  if (!chunk.text) return ''

  const sameChannel = state.currentChannel === chunk.channel
  const sameMessage = sameChannel && (
    chunk.messageId && state.currentMessageId
      ? chunk.messageId === state.currentMessageId
      : !chunk.messageId && !state.currentMessageId
  )

  if (sameMessage) {
    return chunk.text
  }

  const prefix = state.hasContent ? '\n\n' : ''
  state.currentChannel = chunk.channel
  state.currentMessageId = chunk.messageId
  state.hasContent = true

  if (chunk.channel === 'thought') {
    return `${prefix}[thinking] ${chunk.text}`
  }

  return `${prefix}${chunk.text}`
}

export function threadAlreadyTerminal(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) =>
    event.intent === 'task.result'
    || event.intent === 'task.cancel'
    || event.intent === 'task.help_needed',
  )
}

function normalizeSessionKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function resolveTaskSessionKey(
  task: Pick<TaskDispatch, 'sessionKey' | 'dispatchContext'>,
): string | undefined {
  return normalizeSessionKey(task.sessionKey)
    ?? normalizeSessionKey(task.dispatchContext?.[SESSION_KEY_DISPATCH_CONTEXT_KEY])
}

export function stripAampInternalDispatchContext<T extends { dispatchContext?: Record<string, string> }>(
  task: T,
): T {
  const context = task.dispatchContext
  if (!context || !(SESSION_KEY_DISPATCH_CONTEXT_KEY in context)) return task
  const { [SESSION_KEY_DISPATCH_CONTEXT_KEY]: _sessionKey, ...publicContext } = context
  const stripped = { ...task }
  if (Object.keys(publicContext).length > 0) {
    stripped.dispatchContext = publicContext
  } else {
    delete stripped.dispatchContext
  }
  return stripped
}

function threadAlreadyPairResponded(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) => event.intent === 'pair.respond')
}

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Thread history fetch failed: 404')
    || message.includes('"Task not found"')
}

function isClosedStreamAppendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('AAMP stream append failed: 409')
    && message.includes('Task stream is already closed')
}

function isStreamServiceUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('AAMP stream create failed: 503')
    || message.includes('Stream service unavailable')
}

function firstDispatchContextValue(
  context: Record<string, string> | undefined,
  keys: string[],
): string | undefined {
  if (!context) return undefined
  for (const key of keys) {
    const value = context[key]?.trim()
    if (value) return value
  }
  return undefined
}

function sanitizeAttachmentFilename(value: string | undefined, path: string): string {
  const fallback = basename(path).replace(/[\r\n]/g, ' ').trim()
  const fromValue = value?.replace(/[\r\n]/g, ' ').trim()
  if (!fromValue) return fallback
  return basename(fromValue) || fallback
}

function sanitizeContentType(value: string | undefined): string {
  const normalized = value?.replace(/[\r\n]/g, '').trim()
  return normalized || 'application/octet-stream'
}

function endsAtTextBoundary(value: string): boolean {
  return /(?:\n|[。！？!?．.]\s*)$/.test(value)
}

function sanitizeIncomingAttachmentFilename(value: string | undefined, index: number): string {
  const fallback = `attachment-${index + 1}`
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  const base = basename((normalized || fallback).split(/[\\/]+/).filter(Boolean).pop() ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base && base !== '.' && base !== '..' ? base : fallback
}

function sanitizePathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'task'
}

function describeIncomingAttachment(attachment: ReceivedAttachment): string {
  const parts = [
    attachment.filename,
    attachment.contentType,
    Number.isFinite(attachment.size) ? `${attachment.size} bytes` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

function mergeAttachmentRefs(files: string[], attachmentRefs?: ResultAttachmentRef[]): ResultAttachmentRef[] {
  const byKey = new Map<string, ResultAttachmentRef>()

  for (const file of files) {
    byKey.set(file, { path: file })
  }

  for (const attachment of attachmentRefs ?? []) {
    byKey.set(attachment.path, attachment)
  }

  return [...byKey.values()]
}

function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function hasArtifactIdentifierToken(value: string): boolean {
  return identifierTokens(value).some((token) => (
    token === 'attachment'
    || token === 'attachments'
    || token === 'file'
    || token === 'files'
  ))
}

function isAttachmentStructuredField(field: { fieldTypeKey?: string }): boolean {
  return hasArtifactIdentifierToken(field.fieldTypeKey ?? '')
}

function isFileReferenceString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return /^file\s*:/i.test(trimmed)
    || /^~(?:[\\/]|$)/.test(trimmed)
    || /^[a-z]:[\\/].+/i.test(trimmed)
    || /^\\\\[^\\/\s]+[\\/].+/.test(trimmed)
    || /^\/(?!\/).+/.test(trimmed)
}

function containsStructuredFileReference(value: unknown): boolean {
  if (typeof value === 'string') return isFileReferenceString(value)
  if (Array.isArray(value)) return value.some(containsStructuredFileReference)
  if (!value || typeof value !== 'object') return false

  return Object.entries(value as Record<string, unknown>).some(([key, nestedValue]) => (
    identifierTokens(key).some((token) => (
      token === 'path'
      || token === 'file'
      || token === 'files'
      || token === 'attachment'
      || token === 'attachments'
    ))
    || containsStructuredFileReference(nestedValue)
  ))
}

function isRemoteStructuredArtifactField(field: StructuredResultField): boolean {
  return isAttachmentStructuredField(field)
    || Object.prototype.hasOwnProperty.call(field, 'attachmentFilenames')
    || containsStructuredFileReference(field.value)
}

function fillStructuredResultAttachmentFilenames(
  structuredResult: StructuredResultField[] | undefined,
  attachments: AampAttachment[],
): StructuredResultField[] | undefined {
  if (!structuredResult?.length || !attachments.length) return structuredResult
  const filenames = attachments.map((attachment) => attachment.filename)
  return structuredResult.map((field) => {
    if (!isAttachmentStructuredField(field) || field.attachmentFilenames?.length) return field
    return {
      ...field,
      attachmentFilenames: filenames,
    }
  })
}

function taskLockName(taskId: string): string {
  return taskId
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128) || 'task'
}

function acquireTaskExecutionLock(taskId: string): string | null {
  const locksDir = join(getBridgeHomeDir(), 'task-locks')
  const lockDir = join(locksDir, `${taskLockName(taskId)}.lock`)
  mkdirSync(locksDir, { recursive: true })
  try {
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      taskId,
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`)
    return lockDir
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return null
    throw error
  }
}

function releaseTaskExecutionLock(lockDir: string | null): void {
  if (!lockDir) return
  rmSync(lockDir, { recursive: true, force: true })
}

/**
 * Bridges a single ACP agent to the AAMP network.
 * Manages AAMP identity, ACP session, and task routing.
 */
export class AgentBridge {
  private readonly agentConfig: AgentConfig
  private client: AampClient | null = null
  private acpx: AgentBridgeAcpxClient
  private identity: AgentIdentity | null = null
  private sessionName: string
  private sessionNames = new Set<string>()
  private readonly sessionEstablishments = new Set<Promise<void>>()
  private stopPromise: Promise<void> | undefined
  private activeTaskCount = 0
  private pollingFallback = false
  private transportMode: 'connecting' | 'websocket' | 'polling' | 'disconnected' = 'connecting'
  private senderPolicies: SenderPolicy[] = []
  private readonly activeTaskSessions = new Map<string, ActiveTaskSession>()
  private readonly earlyCancelledTaskIds = new BoundedStringMap<true>(TASK_LIFECYCLE_HISTORY_LIMIT)
  private readonly settledTaskLifecycles = new BoundedStringMap<string>(TASK_LIFECYCLE_HISTORY_LIMIT)
  private readonly sessionMutex = new FairKeyedMutex()
  private stopping = false
  private stopped = false
  private isHistoricalReconcile = false
  private onEvent: ((event: BridgeRuntimeEvent) => void) | undefined
  private debugPrompt = false

  constructor(
    agentConfig: AgentConfigInput,
    private readonly aampHost: string,
    private readonly rejectUnauthorized: boolean,
    private readonly dependencies: AgentBridgeDependencies = defaultDependencies,
  ) {
    this.agentConfig = normalizeAgentConfig(agentConfig)
    this.acpx = this.dependencies.createAcpx()
    this.sessionName = `aamp-${this.agentConfig.name}`
  }

  get name(): string { return this.agentConfig.name }
  get email(): string { return this.identity?.email ?? '(not registered)' }
  get isConnected(): boolean { return this.client?.isConnected() ?? false }
  get isUsingPollingFallback(): boolean { return this.pollingFallback || (this.client?.isUsingPollingFallback() ?? false) }
  get isBusy(): boolean { return this.activeTaskCount > 0 }

  private emit(event: BridgeRuntimeEvent): void {
    this.onEvent?.(event)
  }

  private sanitizeSessionSuffix(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 96)
  }

  private resolveTaskSessionName(task: TaskDispatch): string {
    const stickyValue = resolveTaskSessionKey(task)
    if (!stickyValue) return this.sessionName
    const suffix = this.sanitizeSessionSuffix(stickyValue)
    return suffix ? `${this.sessionName}-${suffix}` : this.sessionName
  }

  private getConfiguredCardText(): string | undefined {
    const inline = this.agentConfig.cardText?.trim()
    if (inline) return inline

    const file = this.agentConfig.cardFile?.trim()
    if (!file) return undefined

    const fromFile = readFileSync(file, 'utf-8').trim()
    return fromFile || undefined
  }

  private async syncDirectoryProfile(options: { quiet?: boolean } = {}): Promise<void> {
    if (!this.client) return

    const summary = this.agentConfig.summary?.trim() || this.agentConfig.description?.trim()
    const cardText = this.getConfiguredCardText()

    if (!summary && !cardText) return

    await this.client.updateDirectoryProfile({
      ...(summary ? { summary } : {}),
      ...(cardText ? { cardText } : {}),
    })

    if (!options.quiet) {
      console.log(
        `[${this.name}] Directory profile synced${cardText ? ' (card text registered)' : ''}`,
      )
    }
  }

  /**
   * Start the bridge: resolve identity → connect AAMP → ensure ACP session.
   */
  async start(options: AgentBridgeStartOptions = {}): Promise<void> {
    if (this.stopped) {
      throw new Error('AgentBridge cannot be restarted after stop; create a new bridge instance')
    }
    this.stopping = false
    this.onEvent = options.onEvent
    let quietStartup = options.quiet === true
    this.debugPrompt = options.debug === true

    if (requiresStartupReadinessProbe(this.agentConfig)) {
      try {
        await this.acpx.probeAgent(this.agentConfig.acpCommand)
      } catch (err) {
        throw new UserFacingBridgeError(formatAgentReadinessError(this.name, err), { cause: err })
      }
    }

    // 1. Resolve AAMP identity
    this.identity = this.dependencies.resolveIdentity
      ? await this.dependencies.resolveIdentity()
      : await this.resolveIdentity()
    if (!quietStartup) {
      console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)
    }
    this.emit({
      type: 'agent.identity',
      bridge: 'acp-bridge',
      agent: this.name,
      email: this.identity.email,
      ...(this.agentConfig.executionLocation === 'remote'
        ? {
            executionLocation: 'remote' as const,
            acpCommandConfigured: true as const,
          }
        : { acpCommand: this.agentConfig.acpCommand }),
    })

    // 2. Create AAMP client
    this.client = this.dependencies.createClient({
      email: this.identity.email,
      smtpPassword: this.identity.smtpPassword,
      baseUrl: this.aampHost,
      rejectUnauthorized: this.rejectUnauthorized,
      taskDispatchConcurrency: this.agentConfig.taskDispatchConcurrency,
    })
    const client = this.client
    this.senderPolicies = loadSenderPolicies(
      resolveSenderPoliciesFile(this.agentConfig.senderPoliciesFile, this.agentConfig.name),
    )

    // 3. Wire up task handler
    client.on('task.dispatch', (task: TaskDispatch) => {
      const historical = this.isHistoricalReconcile
      return this.handleTask(task, { historical }).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    client.on('task.cancel', (task: TaskCancel) => this.handleCancel(task).catch((err) => {
      console.warn(
        `[${this.name}] Failed to forward task.cancel ${task.taskId}: ${(err as Error).message}`,
      )
    }))

    ;(client as unknown as {
      on(event: 'pair.request', handler: (request: PairRequest) => void): void
    }).on('pair.request', (request) => {
      const historical = this.isHistoricalReconcile
      void this.handlePairRequest(request, { historical }).catch((err) => {
        console.warn(`[${this.name}] Failed to handle pair.request: ${(err as Error).message}`)
      })
    })

    client.on('connected', () => {
      const usingPollingFallback = client.isUsingPollingFallback()
      this.pollingFallback = usingPollingFallback
      this.emit({
        type: 'agent.connected',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        pollingFallback: usingPollingFallback,
      })
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] AAMP connected (polling fallback active)`)
          }
        }
        this.transportMode = 'polling'
      } else {
        const previousMode = this.transportMode
        this.transportMode = 'websocket'
        if (quietStartup) {
          return
        }
        if (previousMode === 'polling') {
          console.log(`[${this.name}] AAMP WebSocket restored`)
        } else {
          console.log(`[${this.name}] AAMP connected`)
        }
      }
    })

    client.on('disconnected', (reason: string) => {
      const usingPollingFallback = client.isUsingPollingFallback()
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] AAMP WebSocket unavailable, using polling fallback: ${reason}`)
          }
        }
        this.transportMode = 'polling'
      } else {
        this.transportMode = 'disconnected'
        this.emit({
          type: 'agent.disconnected',
          bridge: 'acp-bridge',
          agent: this.name,
          email: this.email,
          reason: formatTaskAgentError(
            this.name,
            reason,
            this.agentConfig.executionLocation,
          ),
          pollingFallback: false,
        })
        console.warn(`[${this.name}] AAMP disconnected: ${reason}`)
      }
    })

    client.on('error', (err: Error) => {
      if (err.message.includes('falling back to polling')) {
        this.pollingFallback = true
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] ${err.message}`)
          }
          this.transportMode = 'polling'
        }
        this.emit({
          type: 'agent.error',
          bridge: 'acp-bridge',
          agent: this.name,
          email: this.email,
          message: formatTaskAgentError(
            this.name,
            err,
            this.agentConfig.executionLocation,
          ),
        })
        return
      }
      if (this.transportMode === 'polling' && (
        err.message.includes('JMAP WebSocket handshake failed')
        || err.message.includes('Failed to get JMAP session')
        || err.message.includes('Polling fallback failed')
      )) {
        return
      }
      this.emit({
        type: 'agent.error',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        message: formatTaskAgentError(
          this.name,
          err,
          this.agentConfig.executionLocation,
        ),
      })
      console.error(`[${this.name}] AAMP error: ${err.message}`)
    })

    // 4. Connect to AAMP
    await client.connect()
    this.isHistoricalReconcile = true
    const reconciled = await client.reconcileRecentEmails(50, { includeHistorical: true })
      .catch((err) => {
        if (!quietStartup) {
          console.warn(`[${this.name}] Recent email reconcile failed: ${(err as Error).message}`)
        }
        return 0
      })
      .finally(() => {
        this.isHistoricalReconcile = false
      })
    if (!quietStartup) {
      console.log(`[${this.name}] Reconciled ${reconciled} recent email(s)`)
    }
    this.emit({
      type: 'agent.reconciled',
      bridge: 'acp-bridge',
      agent: this.name,
      email: this.email,
      count: reconciled,
    })
    await this.syncDirectoryProfile({ quiet: quietStartup }).catch((err) => {
      if (!quietStartup) {
        console.warn(`[${this.name}] Directory profile sync failed: ${(err as Error).message}`)
      }
    })

    // 5. Ensure ACP session
    try {
      await this.ensureAcpSession(this.sessionName)
      if (this.stopping) return
      if (!quietStartup) {
        console.log(`[${this.name}] ACP session ready: ${this.sessionName}`)
      }
      this.emit({
        type: 'agent.session.ready',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        sessionName: this.sessionName,
      })
    } catch (err) {
      if (this.stopping) return
      if (!quietStartup) {
        console.warn(`[${this.name}] ACP session setup deferred: ${(err as Error).message}`)
      }
      this.emit({
        type: 'agent.session.deferred',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        message: formatTaskAgentError(
          this.name,
          err,
          this.agentConfig.executionLocation,
        ),
      })
    }
    quietStartup = false
  }

  /**
   * Stop the bridge.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopped = true
    for (const active of this.activeTaskSessions.values()) {
      if (active.phase === 'active') {
        active.phase = 'cancelled'
      }
      active.clearPendingText?.()
      active.sessionWaitController.abort()
    }
    this.client?.disconnect()
    this.client = null

    let retained!: Promise<void>
    retained = this.performStop().catch((error) => {
      if (this.stopPromise === retained) this.stopPromise = undefined
      throw error
    })
    this.stopPromise = retained
    return retained
  }

  private async performStop(): Promise<void> {
    await this.acpx.stop()
    await this.waitForSessionEstablishments()

    await Promise.all([...this.sessionNames].reverse().map(async (sessionName) => {
      try {
        await this.closeAcpSession(sessionName)
      } finally {
        this.sessionNames.delete(sessionName)
      }
    }))

    await this.acpx.stop()
  }

  private async ensureAcpSession(sessionName: string): Promise<string> {
    if (this.stopping) throw new Error('AgentBridge is stopping')

    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
    this.sessionEstablishments.add(settled)
    try {
      const sessionId = await this.acpx.ensureSession(this.agentConfig.acpCommand, sessionName)
      this.sessionNames.add(sessionName)
      return sessionId
    } finally {
      this.sessionEstablishments.delete(settled)
      resolveSettled()
    }
  }

  private async waitForSessionEstablishments(): Promise<void> {
    while (this.sessionEstablishments.size > 0) {
      await Promise.all([...this.sessionEstablishments])
    }
  }

  private async closeAcpSession(sessionName: string): Promise<void> {
    try {
      await Promise.race([
        this.acpx.close(this.agentConfig.acpCommand, sessionName),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timed out')), 2_500)
        }),
      ])
    } catch (err) {
      console.warn(`[${this.name}] Failed to close ACP session ${sessionName}: ${(err as Error).message}`)
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
  }

  /**
   * Handle an incoming AAMP task by forwarding to the ACP agent.
   */
  private async handleTask(task: TaskDispatch, options: HandleEventOptions = {}): Promise<void> {
    if (!this.client || this.stopping) return

    const settledMessageId = this.settledTaskLifecycles.get(task.taskId)
    if (settledMessageId !== undefined) {
      const duplicateKind = settledMessageId === task.messageId ? 'exact replay' : 'reused task id'
      console.warn(`[${this.name}] Ignoring ${duplicateKind} for settled task ${task.taskId}`)
      return
    }

    if (this.activeTaskSessions.has(task.taskId)) {
      console.warn(`[${this.name}] Ignoring duplicate active task ${task.taskId}`)
      return
    }

    if (this.earlyCancelledTaskIds.take(task.taskId)) {
      this.settledTaskLifecycles.set(task.taskId, task.messageId)
      console.warn(`[${this.name}] Dropping first delivery for early-cancelled task ${task.taskId}`)
      return
    }

    if (task.expiresAt && new Date(task.expiresAt).getTime() <= Date.now()) {
      this.settledTaskLifecycles.set(task.taskId, task.messageId)
      console.warn(`[${this.name}] Skipping expired task ${task.taskId}`)
      return
    }

    const shouldLogTask = !options.historical
    if (shouldLogTask) {
      console.log(`[${this.name}] <- task.dispatch  ${task.taskId}  "${task.title}"  from=${task.from}`)
      this.emit({
        type: 'task.received',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        taskId: task.taskId,
        title: task.title,
        from: task.from,
      })
    }

    const taskSessionName = this.resolveTaskSessionName(task)
    const activeTaskSession: ActiveTaskSession = {
      agent: this.agentConfig.acpCommand,
      sessionName: taskSessionName,
      sessionWaitController: new AbortController(),
      phase: 'active',
      promptStarted: false,
      cancelForwarded: false,
    }
    this.activeTaskSessions.set(task.taskId, activeTaskSession)
    const claimTerminal = (outcome: TaskTerminalOutcome): boolean => {
      if (activeTaskSession.phase !== 'active') return false
      activeTaskSession.phase = 'terminal'
      activeTaskSession.terminalOutcome = outcome
      activeTaskSession.promptStarted = false
      return true
    }
    const isCancelled = (): boolean => activeTaskSession.phase === 'cancelled'
    const isBridgeStopping = (): boolean => this.stopping || this.client === null
    const shouldStopTask = (): boolean => isBridgeStopping() || isCancelled()
    let taskLockDir: string | null = null
    let releaseSessionMutex: SessionMutexRelease | undefined
    let activeTaskCounted = false
    let incomingAttachmentDirectory: string | undefined

    try {
      const hydratedTask = await this.client.hydrateTaskDispatch(task).catch((err) => {
        if (!options.historical) {
          console.warn(`[${this.name}] Failed to load thread history for ${task.taskId}: ${(err as Error).message}`)
        }
        if (options.historical) return null
        return {
          ...task,
          threadHistory: [],
          threadContextText: '',
        }
      })

      if (!hydratedTask || shouldStopTask()) {
        return
      }

      if (threadAlreadyTerminal(hydratedTask.threadHistory)) {
        if (shouldLogTask) {
          console.log(`[${this.name}] Skipping task ${task.taskId} because the thread already reached a terminal state`)
        }
        return
      }
      const publicTask = stripAampInternalDispatchContext(task)
      const publicHydratedTask = stripAampInternalDispatchContext(hydratedTask)

      this.senderPolicies = loadSenderPolicies(resolveSenderPoliciesFile(
        this.agentConfig.senderPoliciesFile,
        this.agentConfig.name,
      ))
      const senderDecision = matchCombinedSenderPolicy(
        publicTask,
        this.agentConfig.senderPolicies,
        this.senderPolicies,
      )
      if (!senderDecision.allowed) {
        if (options.historical || !claimTerminal('rejected')) return
        console.warn(
          `[${this.name}] Rejecting task ${task.taskId}: ${senderDecision.reason ?? 'sender policy rejected the task'}`,
        )
        this.emit({
          type: 'task.rejected',
          bridge: 'acp-bridge',
          agent: this.name,
          email: this.email,
          taskId: task.taskId,
          reason: senderDecision.reason ?? 'sender policy rejected the task',
        })
        await this.client.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'rejected',
          output: '',
          errorMsg: `Unauthorized sender policy: ${senderDecision.reason ?? 'task does not match senderPolicies.'}`,
          inReplyTo: task.messageId,
        })
        return
      }

      const shouldRejectAttachments = this.agentConfig.attachmentPolicy === 'reject'
        && Boolean(publicHydratedTask.attachments?.length)
      if (shouldRejectAttachments) {
        if (!claimTerminal('help_needed')) return
        await this.rejectAttachmentsIfRequired(publicHydratedTask)
        return
      }

      taskLockDir = acquireTaskExecutionLock(task.taskId)
      if (!taskLockDir) {
        console.warn(`[${this.name}] Ignoring duplicate locked task ${task.taskId}`)
        return
      }

      releaseSessionMutex = await this.sessionMutex.acquire(
        taskSessionName,
        activeTaskSession.sessionWaitController.signal,
      ) ?? undefined
      if (!releaseSessionMutex || shouldStopTask()) return

      this.activeTaskCount += 1
      activeTaskCounted = true
    let activeStream: Awaited<ReturnType<AampClient['createStream']>> | null = null
    const pendingStreamWrites = new Set<Promise<void>>()
    let streamClosed = false
    const streamTextState: StreamTextRenderState = { hasContent: false }
    let currentPhase: AcpTextChunk['channel'] | null = null
    let pendingTextDelta: {
      text: string
      channel?: unknown
      messageId?: unknown
      timer?: ReturnType<typeof setTimeout>
    } | null = null

    const queueStreamAppend = (
      type: 'text.delta' | 'todo' | 'tool_call' | 'artifact' | 'status',
      payload: Record<string, unknown>,
    ) => {
      const client = this.client
      if (!client || this.stopping || !activeStream || streamClosed) return
      const streamId = activeStream.streamId

      let write: Promise<void>
      write = client.appendStreamEvent({
        streamId,
        type: type as never,
        payload,
      })
        .then(() => undefined)
        .catch((err) => {
          if (isClosedStreamAppendError(err)) {
            streamClosed = true
            return
          }
          console.warn(
            `[${this.name}] Failed to append ${type} stream event for ${task.taskId}: ${(err as Error).message}`,
          )
        })
        .finally(() => {
          pendingStreamWrites.delete(write)
        })
      pendingStreamWrites.add(write)
    }

    const clearPendingTextDeltaTimer = () => {
      if (pendingTextDelta?.timer) {
        clearTimeout(pendingTextDelta.timer)
        pendingTextDelta.timer = undefined
      }
    }

    activeTaskSession.clearPendingText = () => {
      clearPendingTextDeltaTimer()
      pendingTextDelta = null
    }

    const flushPendingTextDelta = () => {
      if (isBridgeStopping()) {
        activeTaskSession.clearPendingText?.()
        return
      }
      if (!pendingTextDelta?.text) {
        clearPendingTextDeltaTimer()
        pendingTextDelta = null
        return
      }

      const payload: Record<string, unknown> = {
        text: pendingTextDelta.text,
        ...(typeof pendingTextDelta.messageId === 'string' ? { messageId: pendingTextDelta.messageId } : {}),
      }
      clearPendingTextDeltaTimer()
      pendingTextDelta = null
      queueStreamAppend('text.delta', payload)
    }

    const schedulePendingTextDeltaFlush = () => {
      if (isBridgeStopping() || !pendingTextDelta || pendingTextDelta.timer) return
      pendingTextDelta.timer = setTimeout(() => {
        flushPendingTextDelta()
      }, TEXT_DELTA_FLUSH_MS)
    }

    const queueTextDelta = (payload: Record<string, unknown>) => {
      if (isBridgeStopping()) return
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) return

      const channel = payload.channel
      const messageId = payload.messageId
      const canMerge = pendingTextDelta
        && pendingTextDelta.channel === channel
        && pendingTextDelta.messageId === messageId

      if (!canMerge) {
        flushPendingTextDelta()
        pendingTextDelta = {
          text: '',
          channel,
          messageId,
        }
      }

      pendingTextDelta!.text += text
      const pendingText = pendingTextDelta!.text
      if (
        pendingText.length >= TEXT_DELTA_FLUSH_CHARS
        || (
          pendingText.length >= TEXT_DELTA_BOUNDARY_CHARS
          && endsAtTextBoundary(pendingText)
        )
      ) {
        flushPendingTextDelta()
        return
      }

      schedulePendingTextDeltaFlush()
    }

    const flushStreamWrites = async () => {
      flushPendingTextDelta()
      while (pendingStreamWrites.size > 0) {
        await Promise.allSettled([...pendingStreamWrites])
      }
    }

    const appendStreamEvent = async (
      type: 'text.delta' | 'todo' | 'tool_call' | 'artifact' | 'status',
      payload: Record<string, unknown>,
    ) => {
      if (shouldStopTask() || !activeStream || streamClosed) return
      flushPendingTextDelta()
      await flushStreamWrites()
      const client = this.client
      if (!client || shouldStopTask() || !activeStream || streamClosed) return
      try {
        await client.appendStreamEvent({
          streamId: activeStream.streamId,
          type: type as never,
          payload,
        })
      } catch (err) {
        if (isClosedStreamAppendError(err)) {
          streamClosed = true
          return
        }
        throw err
      }
    }

    const closeStream = async (payload: Record<string, unknown>) => {
      if (isBridgeStopping() || !activeStream || streamClosed) return
      await flushStreamWrites()
      const client = this.client
      if (!client || isBridgeStopping() || !activeStream || streamClosed) return
      await client.closeStream({
        streamId: activeStream.streamId,
        payload,
      })
      streamClosed = true
    }

    const finishCancelledTask = (): Promise<void> | null => {
      if (!shouldStopTask()) return null
      if (isBridgeStopping()) {
        console.warn(`[${this.name}] Dropping task ${task.taskId} because the bridge is stopping`)
        return Promise.resolve()
      }
      console.warn(`[${this.name}] Dropping task ${task.taskId} because the task was cancelled`)
      return closeStream({ reason: 'task.cancelled', status: 'cancelled' }).catch((err) => {
        console.warn(
          `[${this.name}] Failed to close cancelled stream for ${task.taskId}: ${(err as Error).message}`,
        )
      })
    }

    const queuePhaseStatus = (channel: AcpTextChunk['channel']) => {
      if (currentPhase === channel) return
      flushPendingTextDelta()
      currentPhase = channel
      queueStreamAppend('todo', {
        items: [{ id: 'acp-phase', content: buildPhaseStatusLabel(channel), status: 'in_progress' }],
        summary: buildPhaseStatusLabel(channel),
      })
    }

    try {
      try {
        const streamClient = this.client
        if (!streamClient || shouldStopTask()) return
        activeStream = await streamClient.createStream({
          taskId: task.taskId,
          peerEmail: task.from,
        })
        const cancellationAfterStreamCreate = finishCancelledTask()
        if (cancellationAfterStreamCreate) {
          await cancellationAfterStreamCreate
          return
        }
        const openedClient = this.client
        if (!openedClient) return
        await openedClient.sendStreamOpened({
          to: task.from,
          taskId: task.taskId,
          streamId: activeStream.streamId,
          inReplyTo: task.messageId,
        })
        const cancellationAfterStreamOpened = finishCancelledTask()
        if (cancellationAfterStreamOpened) {
          await cancellationAfterStreamOpened
          return
        }
        await appendStreamEvent('status', { state: 'running', label: 'ACP task started' })
        const cancellationAfterStreamStatus = finishCancelledTask()
        if (cancellationAfterStreamStatus) {
          await cancellationAfterStreamStatus
          return
        }
      } catch (err) {
        if (!isStreamServiceUnavailableError(err)) throw err
        activeStream = null
        streamClosed = true
        console.warn(
          `[${this.name}] AAMP stream unavailable for ${task.taskId}; continuing without realtime stream: ${(err as Error).message}`,
        )
      }

      const cancellationBeforeAttachments = finishCancelledTask()
      if (cancellationBeforeAttachments) {
        await cancellationBeforeAttachments
        return
      }
      const materializedAttachments = await this.materializeIncomingAttachments(
        publicHydratedTask,
        shouldStopTask,
      )
      const attachmentPromptLines = materializedAttachments.promptLines
      incomingAttachmentDirectory = materializedAttachments.directory
      const cancellationAfterAttachments = finishCancelledTask()
      if (cancellationAfterAttachments) {
        await cancellationAfterAttachments
        return
      }
      const promptTask = attachmentPromptLines.length > 0
        ? {
            ...publicHydratedTask,
            bodyText: [
              publicHydratedTask.bodyText,
              '',
              'Downloaded attachments:',
              ...attachmentPromptLines,
              '',
              'Use these local file paths when the user asks about attached images or files.',
            ].filter((line) => line != null).join('\n'),
          }
        : publicHydratedTask
      const prompt = buildPrompt(promptTask, publicHydratedTask.threadContextText, {
        agentName: this.name,
        executionLocation: this.agentConfig.executionLocation,
      })
      if (this.debugPrompt) {
        console.log(formatDebugPromptLog({
          agentName: this.name,
          taskId: task.taskId,
          sessionName: taskSessionName,
          prompt,
        }))
      }
      const cancellationBeforeSession = finishCancelledTask()
      if (cancellationBeforeSession) {
        await cancellationBeforeSession
        return
      }
      await this.ensureAcpSession(taskSessionName)
      const cancellationAfterSession = finishCancelledTask()
      if (cancellationAfterSession) {
        await cancellationAfterSession
        return
      }
      await appendStreamEvent('todo', {
        items: [{ id: 'acp-prompt', content: 'Prompt sent to ACP agent', status: 'completed' }],
        summary: 'Prompt sent to ACP agent',
      })
      const cancellationBeforePrompt = finishCancelledTask()
      if (cancellationBeforePrompt) {
        await cancellationBeforePrompt
        return
      }
      let result: Awaited<ReturnType<AgentBridgeAcpxClient['prompt']>>
      activeTaskSession.promptStarted = true
      try {
        result = await this.acpx.prompt(this.agentConfig.acpCommand, taskSessionName, prompt, {
          onTextChunk: (chunk) => {
            queuePhaseStatus(chunk.channel)
            const rendered = renderTextChunk(chunk, streamTextState)
            if (!rendered) return
            queueTextDelta({
              text: rendered,
              ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
            })
          },
          onToolUpdate: (update) => {
            flushPendingTextDelta()
            queueStreamAppend('tool_call', {
              toolCallId: update.toolCallId ?? update.title ?? buildToolProgressLabel(update),
              label: buildToolProgressLabel(update),
              status: normalizeToolCallStatus(update.status),
              ...(buildToolProgressDetail(update) ? { output: buildToolProgressDetail(update) } : {}),
            })
          },
          onPlanUpdate: (entries) => {
            flushPendingTextDelta()
            queueStreamAppend('todo', buildTodoPayloadFromPlan(entries))
          },
        })
      } finally {
        activeTaskSession.promptStarted = false
      }
      const cancellationAfterPrompt = finishCancelledTask()
      if (cancellationAfterPrompt) {
        await cancellationAfterPrompt
        return
      }
      await flushStreamWrites()
      const cancellationAfterResponseFlush = finishCancelledTask()
      if (cancellationAfterResponseFlush) {
        await cancellationAfterResponseFlush
        return
      }
      await appendStreamEvent('todo', {
        items: [{ id: 'acp-response', content: 'ACP response received', status: 'completed' }],
        summary: 'ACP response received',
      })
      const cancellationBeforeTerminalResult = finishCancelledTask()
      if (cancellationBeforeTerminalResult) {
        await cancellationBeforeTerminalResult
        return
      }
      const parsed = parseResponse(result.output)
      assertSupportedResultArtifacts(parsed, this.agentConfig.executionLocation)
      if (!parsed.isHelp
        && !parsed.output
        && parsed.files.length === 0
        && !parsed.structuredResult?.length
        && !parsed.attachments?.length) {
        throw new Error('ACP agent completed without a final response')
      }

      if (parsed.isHelp) {
        // Agent needs help
        if (!result.streamedAssistantText && parsed.question) {
          queuePhaseStatus('assistant')
          queueTextDelta({
            text: renderTextChunk(
              { channel: 'assistant', text: parsed.question },
              streamTextState,
            ),
          })
          await flushStreamWrites()
          const cancellationAfterHelpFlush = finishCancelledTask()
          if (cancellationAfterHelpFlush) {
            await cancellationAfterHelpFlush
            return
          }
        }
        if (!claimTerminal('help_needed')) {
          const cancellationBeforeHelpClose = finishCancelledTask()
          if (cancellationBeforeHelpClose) await cancellationBeforeHelpClose
          return
        }
        await closeStream({ reason: 'task.help_needed' })
        const cancellationAfterHelpClose = finishCancelledTask()
        if (cancellationAfterHelpClose) {
          await cancellationAfterHelpClose
          return
        }
        const helpClient = this.client
        if (!helpClient) return
        await helpClient.sendHelp({
          to: task.from,
          taskId: task.taskId,
          question: parsed.question ?? 'Agent needs more information',
          blockedReason: 'ACP agent requested clarification',
          suggestedOptions: [],
          inReplyTo: task.messageId,
        })
        console.log(`[${this.name}] -> task.help_needed  ${task.taskId}`)
        this.emit({
          type: 'task.completed',
          bridge: 'acp-bridge',
          agent: this.name,
          email: this.email,
          taskId: task.taskId,
          status: 'help_needed',
        })
      } else {
        // Collect file attachments referenced by the agent
        const attachments: AampAttachment[] = []
        for (const attachmentRef of mergeAttachmentRefs(parsed.files, parsed.attachments)) {
          const filepath = attachmentRef.path
          if (existsSync(filepath)) {
            try {
              attachments.push({
                filename: sanitizeAttachmentFilename(attachmentRef.filename, filepath),
                contentType: sanitizeContentType(attachmentRef.contentType),
                content: readFileSync(filepath),
              })
              console.log(`[${this.name}] Attaching file: ${filepath}`)
            } catch (err) {
              console.warn(`[${this.name}] Failed to read file ${filepath}: ${(err as Error).message}`)
            }
          } else {
            console.warn(`[${this.name}] Attachment file not found: ${filepath}`)
          }
        }
        const structuredResult = fillStructuredResultAttachmentFilenames(
          parsed.structuredResult,
          attachments,
        )

        // Task completed
        if (parsed.output && !result.streamedAssistantText) {
          queuePhaseStatus('assistant')
          queueTextDelta({
            text: renderTextChunk(
              { channel: 'assistant', text: parsed.output },
              streamTextState,
            ),
          })
          await flushStreamWrites()
          const cancellationAfterResultFlush = finishCancelledTask()
          if (cancellationAfterResultFlush) {
            await cancellationAfterResultFlush
            return
          }
        }
        if (!claimTerminal('completed')) {
          const cancellationBeforeResultClose = finishCancelledTask()
          if (cancellationBeforeResultClose) await cancellationBeforeResultClose
          return
        }
        await closeStream({ reason: 'task.result', status: 'completed' })
        const cancellationAfterResultClose = finishCancelledTask()
        if (cancellationAfterResultClose) {
          await cancellationAfterResultClose
          return
        }
        const resultClient = this.client
        if (!resultClient) return
        await resultClient.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'completed',
          output: parsed.output,
          structuredResult,
          inReplyTo: task.messageId,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
        console.log(`[${this.name}] -> task.result  ${task.taskId}  completed${structuredResult?.length ? ` (${structuredResult.length} structured field(s))` : ''}${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`)
        this.emit({
          type: 'task.completed',
          bridge: 'acp-bridge',
          agent: this.name,
          email: this.email,
          taskId: task.taskId,
          status: 'completed',
        })
      }
    } catch (err) {
      if (activeTaskSession.phase === 'terminal') {
        console.error(
          `[${this.name}] Task ${task.taskId} ${activeTaskSession.terminalOutcome ?? 'terminal'} delivery failed: ${(err as Error).message}`,
        )
        return
      }
      const cancellationAfterError = finishCancelledTask()
      if (cancellationAfterError) {
        await cancellationAfterError
        return
      }
      const errorMsg = formatTaskAgentError(this.name, err, this.agentConfig.executionLocation)
      console.error(`[${this.name}] Task ${task.taskId} error: ${errorMsg}`)
      if (!claimTerminal('rejected')) return
      try {
        await flushStreamWrites()
        const cancellationAfterRejectedFlush = finishCancelledTask()
        if (cancellationAfterRejectedFlush) {
          await cancellationAfterRejectedFlush
          return
        }
        if (activeStream) {
          await closeStream({ reason: 'task.result', status: 'rejected', error: errorMsg })
          const cancellationAfterRejectedClose = finishCancelledTask()
          if (cancellationAfterRejectedClose) {
            await cancellationAfterRejectedClose
            return
          }
        }
        const rejectedClient = this.client
        if (!rejectedClient) return
        await rejectedClient.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'rejected',
          output: '',
          errorMsg: `ACP agent error: ${errorMsg}`,
          inReplyTo: task.messageId,
        })
      } catch (deliveryError) {
        console.error(
          `[${this.name}] Task ${task.taskId} rejected delivery failed: ${(deliveryError as Error).message}`,
        )
        return
      }
      this.emit({
        type: 'task.completed',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        taskId: task.taskId,
        status: 'rejected',
      })
    } finally {
      activeTaskSession.clearPendingText?.()
      activeTaskSession.clearPendingText = undefined
    }
    } finally {
      if (activeTaskCounted) {
        this.activeTaskCount = Math.max(0, this.activeTaskCount - 1)
      }
      this.activeTaskSessions.delete(task.taskId)
      this.settledTaskLifecycles.set(task.taskId, task.messageId)
      try {
        if (incomingAttachmentDirectory) {
          rmSync(incomingAttachmentDirectory, { recursive: true, force: true })
        }
      } finally {
        try {
          releaseTaskExecutionLock(taskLockDir)
        } finally {
          releaseSessionMutex?.()
        }
      }
    }
  }

  private async handleCancel(task: TaskCancel): Promise<void> {
    const active = this.activeTaskSessions.get(task.taskId)
    if (active?.phase === 'terminal') return

    console.warn(`[${this.name}] <- task.cancel  ${task.taskId}  from=${task.from}`)
    if (active) {
      if (active.phase === 'cancelled') return
      active.phase = 'cancelled'
      active.sessionWaitController.abort()
      if (!active.promptStarted || active.cancelForwarded) return
      active.cancelForwarded = true
      await this.acpx.cancel(active.agent, active.sessionName)
      return
    }

    if (this.settledTaskLifecycles.get(task.taskId) !== undefined) return
    this.earlyCancelledTaskIds.set(task.taskId, true)
  }

  private async rejectAttachmentsIfRequired(task: TaskDispatch): Promise<boolean> {
    if (this.agentConfig.attachmentPolicy !== 'reject' || !task.attachments?.length || !this.client) {
      return false
    }

    await this.client.sendHelp({
      to: task.from,
      taskId: task.taskId,
      question: 'The attachment was not downloaded. Please paste the relevant text into the task or share an HTTP(S) URL that the agent can access.',
      blockedReason: 'This ACP agent does not accept attachments',
      suggestedOptions: [
        'Paste the relevant text into the task',
        'Share an HTTP(S) link that AIME can access',
      ],
      inReplyTo: task.messageId,
    })
    console.log(`[${this.name}] -> task.help_needed  ${task.taskId}`)
    this.emit({
      type: 'task.completed',
      bridge: 'acp-bridge',
      agent: this.name,
      email: this.email,
      taskId: task.taskId,
      status: 'help_needed',
    })
    return true
  }

  private async materializeIncomingAttachments(
    task: TaskDispatch,
    shouldStop: () => boolean = () => false,
  ): Promise<MaterializedIncomingAttachments> {
    const attachments = task.attachments ?? []
    const client = this.client
    if (!attachments.length || !client || shouldStop()) return { promptLines: [] }

    const attachmentDir = mkdtempSync(join(tmpdir(), `aamp-acp-${sanitizePathToken(task.taskId)}-`))
    const usedNames = new Set<string>()
    const lines: string[] = []

    for (const [index, attachment] of attachments.entries()) {
      if (shouldStop()) break
      const baseName = sanitizeIncomingAttachmentFilename(attachment.filename, index)
      const filename = usedNames.has(baseName) ? `${index + 1}-${baseName}` : baseName
      usedNames.add(filename)
      const filePath = join(attachmentDir, filename)

      try {
        const content = await client.downloadBlob(attachment.blobId, attachment.filename)
        if (shouldStop()) break
        writeFileSync(filePath, content)
        lines.push(`- ${describeIncomingAttachment(attachment)}: ${filePath}`)
      } catch (err) {
        if (shouldStop()) break
        const message = err instanceof Error ? err.message : String(err)
        lines.push(`- ${describeIncomingAttachment(attachment)}: download failed: ${message}`)
      }
    }

    return { promptLines: lines, directory: attachmentDir }
  }

  private async sendPairResponse(request: PairRequest, success: boolean, reason?: string): Promise<boolean> {
    if (!this.client) return false
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.sendPairRespond({
          to: request.from,
          taskId: request.taskId,
          success,
          reason,
          inReplyTo: request.messageId,
        })
        return true
      } catch (err) {
        lastError = err
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
        }
      }
    }
    console.warn(`[${this.name}] Failed to send pair.respond to ${request.from}: ${(lastError as Error)?.message ?? String(lastError)}`)
    return false
  }

  private async handlePairRequest(request: PairRequest, options: HandleEventOptions = {}): Promise<void> {
    if (!this.identity || !this.client) return
    const shouldLogRequest = !options.historical
    if (shouldLogRequest) {
      console.log(`[${this.name}] <- pair.request  ${request.taskId}  from=${request.from}`)
      this.emit({
        type: 'pair.request',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        taskId: request.taskId,
        from: request.from,
      })
    }
    const requestTo = this.normalizeEmail(request.to)
    if (requestTo && requestTo !== this.normalizeEmail(this.identity.email)) {
      console.warn(`[${this.name}] Ignoring pair.request ${request.taskId}: addressed to ${request.to}`)
      return
    }
    const history = await this.client.getThreadHistory(request.taskId).catch((err) => {
      if (isThreadNotFoundError(err) && options.historical) {
        return null
      }
      if (!isThreadNotFoundError(err)) {
        console.warn(`[${this.name}] Failed to load pair thread ${request.taskId}: ${(err as Error).message}`)
      }
      return { taskId: request.taskId, events: [] }
    })
    if (!history) return
    const priorEvents = history.events.filter((event) => event.messageId !== request.messageId)
    if (threadAlreadyPairResponded(priorEvents)) {
      if (shouldLogRequest) {
        console.log(`[${this.name}] Skipping pair.request ${request.taskId} because it already has pair.respond`)
      }
      return
    }

    const pairingFile = resolvePairingFile(this.agentConfig.pairingFile, this.agentConfig.name)
    const senderPoliciesFile = resolveSenderPoliciesFile(
      this.agentConfig.senderPoliciesFile,
      this.agentConfig.name,
    )
    const pairParams = {
      file: pairingFile,
      mailbox: this.identity.email,
      pairCode: request.pairCode,
    }
    const validPairing = validatePairingCode(pairParams)
    if (!validPairing) {
      const reason = 'invalid or expired pair code'
      if (options.historical) {
        return
      }
      console.warn(`[${this.name}] Rejected pair.request from ${request.from}: ${reason}`)
      await this.sendPairResponse(request, false, reason)
      this.emit({
        type: 'pair.completed',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        taskId: request.taskId,
        sender: request.from,
        success: false,
        reason,
      })
      return
    }

    this.senderPolicies = addSenderPolicy(senderPoliciesFile, {
      sender: this.normalizeEmail(request.from),
      dispatchContextRules: request.dispatchContextRules ?? {},
      pairedAt: new Date().toISOString(),
    })

    console.log(`[${this.name}] Paired sender ${request.from}; policy saved to ${senderPoliciesFile}`)
    if (await this.sendPairResponse(request, true)) {
      this.emit({
        type: 'pair.completed',
        bridge: 'acp-bridge',
        agent: this.name,
        email: this.email,
        taskId: request.taskId,
        sender: request.from,
        success: true,
      })
      consumePairingCode(pairParams)
    } else {
      console.warn(`[${this.name}] Pairing code left active so ${request.from} can retry before it expires`)
    }
  }

  /**
   * Resolve AAMP identity: load from credentials file or register new.
   */
  private async resolveIdentity(): Promise<AgentIdentity> {
    const credFile = resolveCredentialsFile(this.agentConfig.credentialsFile, this.agentConfig.name)

    // Try loading existing credentials
    if (existsSync(credFile)) {
      try {
        const data = JSON.parse(readFileSync(credFile, 'utf-8'))
        if (data.email && data.mailboxToken && data.smtpPassword) {
          const identity = {
            email: data.email,
            mailboxToken: data.mailboxToken,
            smtpPassword: data.smtpPassword,
          }
          const authState = await this.checkIdentityAuthorization(identity)
          if (authState === 'authorized' || authState === 'unknown') {
            return identity
          }
          console.warn(`[${this.name}] Stored AAMP credentials are unauthorized; re-registering mailbox`)
        }
      } catch { /* re-register */ }
    }

    return this.registerIdentity(credFile)
  }

  private async registerIdentity(credFile: string): Promise<AgentIdentity> {
    // Self-register
    const slug = this.agentConfig.slug ?? defaultAgentSlug(this.agentConfig.name)
    const description = this.agentConfig.description ?? `${this.agentConfig.name} via ACP bridge`

    const creds = await AampClient.registerMailbox({
      aampHost: this.aampHost,
      slug,
      description,
    })

    const identity: AgentIdentity = {
      email: creds.email,
      mailboxToken: creds.mailboxToken,
      smtpPassword: creds.smtpPassword,
    }

    // Persist credentials
    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify(identity, null, 2))
    console.log(`[${this.name}] Registered: ${identity.email} (credentials saved to ${credFile})`)

    await this.waitForIdentityAuthorization(identity)
    return identity
  }

  private async checkIdentityAuthorization(identity: AgentIdentity): Promise<'authorized' | 'unauthorized' | 'unknown'> {
    try {
      const base = this.aampHost.replace(/\/$/, '')
      const res = await fetch(`${base}/.well-known/jmap`, {
        headers: { Authorization: toBasicAuth(identity.email, identity.smtpPassword) },
      })
      if (res.ok) return 'authorized'
      if (res.status === 401 || res.status === 403) return 'unauthorized'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async waitForIdentityAuthorization(identity: AgentIdentity): Promise<void> {
    for (let attempt = 1; attempt <= IDENTITY_AUTH_RETRY_COUNT; attempt += 1) {
      const authState = await this.checkIdentityAuthorization(identity)
      if (authState === 'authorized' || authState === 'unknown') return
      if (attempt < IDENTITY_AUTH_RETRY_COUNT) {
        await sleep(IDENTITY_AUTH_RETRY_DELAY_MS)
      }
    }

    throw new Error(`Registered AAMP credentials for ${identity.email} are not authorized by JMAP`)
  }
}
