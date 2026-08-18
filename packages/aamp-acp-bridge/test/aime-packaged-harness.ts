import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { AampClient, type AampStreamEvent, type CreateStreamResult, type HydratedTaskDispatch, type SendHelpOptions, type SendResultOptions, type TaskCancel, type TaskDispatch, type TaskResult, type TaskStreamState } from 'aamp-sdk'
import type { AgentBridgeDependencies } from '../src/agent-bridge.js'
import type { AcpxClient as SourceAcpxClient } from '../src/acpx-client.js'
// Test-only cross-package seam: use the merged Feishu Bridge's exported production
// prompt and result contracts without adding a generic-bridge runtime dependency.
import { buildFeishuTaskPromptRules } from '../../aamp-feishu-bridge/src/task/dispatch.js'
import { classifyFeishuTaskResult } from '../../aamp-feishu-bridge/src/task/runtime.js'

const REGISTRY = 'https://bnpm.byted.org'
const ACPX_VERSION = '0.11.2'
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const BRIDGE_PACKAGE_ROOT = resolve(TEST_DIRECTORY, '..')
const REPOSITORY_ROOT = resolve(BRIDGE_PACKAGE_ROOT, '../..')
const AIME_PACKAGE_ROOT = join(REPOSITORY_ROOT, 'packages/aime-acp')
export const FINAL_PACKAGED_AIME_IDENTITY = {
  packageVersion: '0.1.0',
  filename: 'tengchengwei-aime-acp-0.1.0.tgz',
  productionBridgeCommit: 'b3c43ae9e2c3a8d8fa14ef4ef207e09cb079305d',
  coreCommit: '17119558e9df225707e288320b2fea2a1baaa5bf',
  tarballSha256: '723c15fa63e28d68c2621b859af7f25b2b7115c2aad01d01843c7b30105cf8b1',
  npmShasum: 'fdfb89fa5abf7ffadbcd78a9225e2a5dfed5a89f',
  npmIntegrity: 'sha512-pQUImtXGIdYiO6hi1+KrOtJRBC1Kn4M46pDd3+oVgWrzkK/2C1sWKz6OwnAVARBHtVAglfjJTrKHyMZ9LotSZQ==',
  entryCount: 66,
  packedSize: 60421,
  unpackedSize: 286665,
} as const
const SENTINELS = [
  'CREDENTIAL_SENTINEL_VALUE',
  'RAW_TOOL_SENTINEL_VALUE',
  'CWD_SENTINEL_VALUE',
]

export interface PackagedAimeBridgeEvidence {
  readonly scenarios: readonly string[]
  readonly packageVersion: string
  readonly acpxVersion: string
  readonly bytedcliVersion: string
  readonly tarballSha256: string
  readonly npmShasum: string
  readonly npmIntegrity: string
  readonly entryCount: number
  readonly packedSize: number
  readonly unpackedSize: number
  readonly productionBridgeCommit: string
  readonly coreCommit: string
  readonly counts: {
    readonly streams: number
    readonly results: number
    readonly helps: number
    readonly remoteCreates: number
    readonly remoteSends: number
    readonly remoteCancels: number
  }
  readonly stopReasons: readonly string[]
  readonly installedBridge: {
    readonly packageVersion: string
    readonly jsonInitExecutionLocation: string
    readonly runtime: 'installed-package'
  }
  readonly completedResultContract: {
    readonly turns: number
    readonly visibleOuterEnvelopes: boolean
    readonly forwardedInnerMarkers: boolean
    readonly schemaV2: boolean
    readonly dispositionKinds: readonly string[]
    readonly summaries: readonly string[]
    readonly replyWritten: readonly boolean[]
    readonly commentRequired: readonly boolean[]
    readonly completionRequired: readonly boolean[]
  }
  readonly completedTurnContract: {
    readonly turns: number
    readonly reusedRemoteSession: boolean
    readonly bothCompleted: boolean
    readonly remoteSandbox: boolean
    readonly remoteNativeCapabilities: boolean
    readonly invariantAampResultJson: boolean
    readonly invariantFeishuTaskResultJson: boolean
    readonly localLarkCliProfileRules: boolean
    readonly localEnvironmentSource: boolean
    readonly localFileMarker: boolean
    readonly localFilePathGuidance: boolean
    readonly secretEvidence: boolean
    readonly callerCwdEvidence: boolean
    readonly rawAcpCommandEvidence: boolean
    readonly localProfileEvidence: boolean
  }
  readonly promptContract: {
    readonly turns: number
    readonly reusedRemoteSession: boolean
    readonly remoteSandbox: boolean
    readonly remoteNativeCapabilities: boolean
    readonly invariantAampResultJson: boolean
    readonly invariantFeishuTaskResultJson: boolean
    readonly localLarkCliProfileRules: boolean
    readonly localEnvironmentSource: boolean
    readonly localFileMarker: boolean
    readonly localFilePathGuidance: boolean
    readonly secretEvidence: boolean
    readonly callerCwdEvidence: boolean
    readonly rawAcpCommandEvidence: boolean
    readonly localProfileEvidence: boolean
  }
  readonly promptFingerprints: readonly string[]
  readonly cleanup: {
    readonly ownedProcesses: number
    readonly tempRootRemoved: boolean
  }
}

interface FakeScenario {
  readonly auth: {
    readonly authenticated: boolean
    readonly identity: { readonly field: string; readonly value: string }
  }
  readonly space: { readonly id: string }
  readonly newSessionId: string
  readonly prompts: unknown[]
}

interface ProcessResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

type ProcessLifecycle =
  | { readonly kind: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'error'; readonly error: Error }

function npmInvocation(args: readonly string[]): { file: string; args: string[] } {
  return process.env.npm_execpath
    ? { file: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { file: 'npm', args: [...args] }
}

export async function runBounded(
  file: string,
  args: readonly string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    onChildCloseObserved?: () => void
  },
): Promise<ProcessResult> {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const retainedClose = new Promise<void>((resolveClose) => {
    child.once('close', (code, signal) => {
      try { options.onChildCloseObserved?.() } catch { /* observation cannot alter cleanup */ }
      resolveClose()
    })
  })
  const lifecycle = new Promise<ProcessLifecycle>((resolveLifecycle) => {
    child.once('error', (error) => resolveLifecycle({ kind: 'error', error }))
    child.once('close', (code, signal) => resolveLifecycle({ kind: 'close', code, signal }))
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([
      lifecycle.then((outcome) => ({ kind: 'lifecycle' as const, outcome })),
      new Promise<{ readonly kind: 'timeout' }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), options.timeoutMs ?? 120_000)
      }),
    ])
    if (first.kind === 'lifecycle') {
      if (first.outcome.kind === 'error') throw first.outcome.error
      return { ...first.outcome, stdout, stderr }
    }

    await terminateTimedOutChild(child, retainedClose)
    throw new Error(`bounded child timed out: ${basename(file)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function terminateTimedOutChild(child: ChildProcess, retainedClose: Promise<void>): Promise<void> {
  terminateOwnedChild(child, 'SIGTERM')
  if (await waitForRetainedClose(retainedClose, 2_000)) return
  terminateOwnedChild(child, 'SIGKILL')
  if (!(await waitForRetainedClose(retainedClose, 2_000))) {
    throw new Error('timed-out child did not close after SIGKILL')
  }
}

async function waitForRetainedClose(retainedClose: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      retainedClose.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function terminateOwnedChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  try { child.kill(signal) } catch { /* owned best-effort cleanup */ }
}

function requireSuccess(result: ProcessResult, label: string): void {
  if (result.code === 0 && result.signal === null) return
  throw new Error(`${label} failed (${String(result.code)}): ${`${result.stdout}\n${result.stderr}`.slice(-8_000)}`)
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const starts = [0, ...stdout.split('').flatMap((value, index) => value === '\n' ? [index + 1] : [])]
  for (const start of starts.reverse()) {
    const candidate = stdout.slice(start).trim()
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    try {
      const parsed = JSON.parse(candidate)
      return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>
    } catch { /* npm lifecycle output can precede JSON */ }
  }
  throw new Error('npm did not emit final JSON')
}

function event(type: string, offset: number, data: Record<string, unknown>): unknown {
  return {
    type,
    data: {
      event_id: `event-${offset}`,
      event_offset: offset,
      timestamp: 2_000_000_000 + offset,
      event_key: type,
      ...data,
    },
  }
}

function textEvents(startOffset: number, userId: string, assistantId: string, output: string): unknown[] {
  const split = Math.max(1, Math.floor(output.length / 2))
  return [
    event('session.message.create', startOffset, {
      message: { message_id: userId, role: 'user', content: 'redacted-user-content' },
    }),
    event('session.think.tips', startOffset + 1, { tips: ['Synthetic thought'] }),
    event('session.plan.update', startOffset + 2, { plan_id: 'safe-plan', status: 'running' }),
    event('session.step.update', startOffset + 3, {
      agent_step_id: `safe-step-${startOffset}`,
      title: 'Synthetic remote step',
      status: 'in_progress',
    }),
    event('session.action.use_tool', startOffset + 4, {
      agent_step_id: `safe-tool-${startOffset}`,
      tool_name: 'safe_lookup',
      status: 'in_progress',
      summary: 'Synthetic lookup running',
      raw_payload: SENTINELS[1],
    }),
    event('session.action.use_tool', startOffset + 5, {
      agent_step_id: `safe-tool-${startOffset}`,
      tool_name: 'safe_lookup',
      status: 'completed',
      summary: 'Synthetic lookup completed',
      raw_payload: SENTINELS[1],
    }),
    event('session.message.create', startOffset + 6, {
      reply_message_id: userId,
      message: { message_id: assistantId, role: 'assistant', content: output.slice(0, split) },
    }),
    event('session.message.delta', startOffset + 7, {
      message_id: assistantId,
      content: output.slice(split),
      is_finished: true,
    }),
    event('session.reference', startOffset + 8, {
      references: [{
        id: `safe-reference-${startOffset}`,
        title: 'Synthetic source',
        uri: `https://example.test/source-${startOffset}`,
        snippet: 'Synthetic source snippet',
      }],
    }),
    event('session.progress_notice', startOffset + 9, { status: 'waiting_for_next' }),
  ]
}

function answeredEnvelope(summary: string): { readonly visible: string; readonly inner: string } {
  const inner = `FEISHU_TASK_RESULT_JSON: ${JSON.stringify({
    schema: 'feishu_task_result.v2',
    status: 'answered',
    summary,
    reply_written: false,
  })}`
  return {
    visible: `AAMP_RESULT_JSON: ${JSON.stringify({ output: inner })}`,
    inner,
  }
}

function isVisibleNestedAnsweredEnvelope(value: string, expectedSummary: string): boolean {
  const outerMarker = 'AAMP_RESULT_JSON: '
  const innerMarker = 'FEISHU_TASK_RESULT_JSON: '
  if (!value.startsWith(outerMarker)) return false
  try {
    const outer = JSON.parse(value.slice(outerMarker.length)) as Record<string, unknown>
    if (Object.keys(outer).length !== 1 || typeof outer.output !== 'string' || !outer.output.startsWith(innerMarker)) {
      return false
    }
    const inner = JSON.parse(outer.output.slice(innerMarker.length)) as Record<string, unknown>
    return inner.schema === 'feishu_task_result.v2'
      && inner.status === 'answered'
      && inner.summary === expectedSummary
      && inner.reply_written === false
  } catch {
    return false
  }
}

function helpEvent(offset: number, userId: string): unknown[] {
  return [
    event('session.message.create', offset, {
      message: { message_id: userId, role: 'user', content: 'redacted-user-content' },
    }),
    {
      type: 'unknown',
      data: {
        eventType: 'session.action.tool_call_required',
        raw: {
          event_id: `event-${offset + 1}`,
          event_offset: offset + 1,
          timestamp: 2_000_000_000 + offset + 1,
          event_key: 'session.action.tool_call_required',
          question: 'Choose a safe option.',
          options: ['Option A', 'Option B'],
        },
      },
    },
  ]
}

function task(taskId: string, sessionKey: string, overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    protocolVersion: '1.1',
    intent: 'task.dispatch',
    taskId,
    sessionKey,
    title: 'Synthetic packaged AIME bridge proof',
    priority: 'normal',
    from: 'sender@example.com',
    to: 'agent@meshmail.test',
    messageId: `<${taskId}@example.com>`,
    subject: 'Synthetic AAMP task',
    bodyText: 'Synthetic remote-only request.',
    promptRules: buildFeishuTaskPromptRules({ agentExecutionLocation: 'remote' }),
    ...overrides,
  }
}

function cancellation(taskId: string): TaskCancel {
  return {
    protocolVersion: '1.1',
    intent: 'task.cancel',
    taskId,
    from: 'sender@example.com',
    to: 'agent@meshmail.test',
    messageId: `<cancel-${taskId}@example.com>`,
    subject: 'Synthetic cancellation',
    bodyText: 'Cancel the synthetic task.',
  }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

class ArtifactAampClient {
  readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  readonly results: TaskResult[] = []
  readonly helps: SendHelpOptions[] = []
  readonly streamEvents: AampStreamEvent[] = []
  readonly streamCloses: Array<{ taskId: string; payload?: Record<string, unknown>; order: number }> = []
  readonly createdStreams: Array<{ taskId: string; order: number }> = []
  readonly helpOrders: number[] = []
  readonly resultOrders: number[] = []
  readonly hydrationOrders: Array<{ taskId: string; order: number }> = []
  readonly downloadCalls: string[] = []
  private readonly streams = new Map<string, CreateStreamResult>()
  private order = 0
  private connected = false

  nextOrder(): number { return ++this.order }

  on(eventName: string, handler: (...args: never[]) => unknown): this {
    const handlers = this.handlers.get(eventName) ?? []
    handlers.push(handler)
    this.handlers.set(eventName, handlers)
    return this
  }

  async emitDispatch(value: TaskDispatch): Promise<void> {
    await Promise.all((this.handlers.get('task.dispatch') ?? []).map((handler) =>
      Promise.resolve((handler as (task: TaskDispatch) => unknown)(value))))
  }

  async emitCancel(value: TaskCancel): Promise<void> {
    await Promise.all((this.handlers.get('task.cancel') ?? []).map((handler) =>
      Promise.resolve((handler as (task: TaskCancel) => unknown)(value))))
  }

  async connect(): Promise<void> { this.connected = true }
  disconnect(): void { this.connected = false }
  isConnected(): boolean { return this.connected }
  isUsingPollingFallback(): boolean { return false }
  async reconcileRecentEmails(): Promise<number> { return 0 }
  async updateDirectoryProfile(): Promise<never> { throw new Error('unexpected directory profile update') }
  async hydrateTaskDispatch(value: TaskDispatch): Promise<HydratedTaskDispatch> {
    this.hydrationOrders.push({ taskId: value.taskId, order: this.nextOrder() })
    return { ...value, threadHistory: [], threadContextText: '' }
  }
  async createStream(options: { taskId: string; peerEmail: string }): Promise<CreateStreamResult> {
    this.createdStreams.push({ taskId: options.taskId, order: this.nextOrder() })
    const stream = {
      streamId: `stream-${options.taskId}`,
      taskId: options.taskId,
      status: 'created',
      ownerEmail: 'agent@meshmail.test',
      peerEmail: options.peerEmail,
      createdAt: '2035-01-01T00:00:00.000Z',
    } satisfies CreateStreamResult
    this.streams.set(stream.streamId, stream)
    return stream
  }
  async sendStreamOpened(): Promise<void> {}
  async appendStreamEvent(options: { streamId: string; type: AampStreamEvent['type']; payload: Record<string, unknown> }): Promise<AampStreamEvent> {
    const eventValue = {
      streamId: options.streamId,
      taskId: this.streams.get(options.streamId)?.taskId ?? '',
      seq: this.streamEvents.length + 1,
      timestamp: '2035-01-01T00:00:00.000Z',
      type: options.type,
      payload: options.payload,
    } satisfies AampStreamEvent
    this.nextOrder()
    this.streamEvents.push(eventValue)
    return eventValue
  }
  async closeStream(options: { streamId: string; payload?: Record<string, unknown> }): Promise<TaskStreamState> {
    const stream = this.streams.get(options.streamId)
    assert.ok(stream)
    this.streamCloses.push({ taskId: stream.taskId, payload: options.payload, order: this.nextOrder() })
    return { ...stream, status: 'closed', closedAt: '2035-01-01T00:00:01.000Z' }
  }
  async sendResult(options: SendResultOptions): Promise<void> {
    this.results.push({
      protocolVersion: '1.1',
      intent: 'task.result',
      taskId: options.taskId,
      status: options.status,
      output: options.output,
      ...(options.errorMsg !== undefined ? { errorMsg: options.errorMsg } : {}),
      ...(options.structuredResult !== undefined ? { structuredResult: options.structuredResult } : {}),
      from: 'agent@meshmail.test',
      to: options.to,
    })
    this.resultOrders.push(this.nextOrder())
  }
  async sendHelp(options: SendHelpOptions): Promise<void> {
    this.helps.push(options)
    this.helpOrders.push(this.nextOrder())
  }
  async downloadBlob(blobId: string): Promise<Buffer> {
    this.downloadCalls.push(blobId)
    return Buffer.from('unexpected')
  }
  async sendPairRespond(): Promise<never> { throw new Error('unexpected pair response') }
  async getThreadHistory(): Promise<never> { throw new Error('unexpected pair history') }
}

interface PromptEvidence {
  readonly sessionName: string
  readonly fingerprint: string
  readonly remoteSandbox: boolean
  readonly remoteNativeCapabilities: boolean
  readonly invariantAampResultJson: boolean
  readonly invariantFeishuTaskResultJson: boolean
  readonly localLarkCliProfileRules: boolean
  readonly localEnvironmentSource: boolean
  readonly localFileMarker: boolean
  readonly localFilePathGuidance: boolean
  readonly secretEvidence: boolean
  readonly callerCwdEvidence: boolean
  readonly rawAcpCommandEvidence: boolean
  readonly localProfileEvidence: boolean
}

type AcpxClientConstructor = new (cwd?: string) => SourceAcpxClient
type AgentBridgeRuntime = {
  start(options?: { quiet?: boolean }): Promise<void>
  stop(): Promise<void>
}
type AgentBridgeConstructor = new (
  agentConfig: unknown,
  aampHost: string,
  rejectUnauthorized: boolean,
  dependencies?: AgentBridgeDependencies,
) => AgentBridgeRuntime
type ObservedAcpxClient = SourceAcpxClient & {
  readonly calls: Array<{ method: string; agent: string; sessionName: string; order: number }>
  readonly promptEvidence: PromptEvidence[]
}

function createObservedAcpxClient(
  BaseAcpxClient: AcpxClientConstructor,
  ownedRoot: string,
  order: () => number,
  forbiddenPromptValues: {
    readonly secret: string
    readonly callerCwd: string
    readonly rawAcpCommand: string
  },
): ObservedAcpxClient {
  class Observed extends BaseAcpxClient {
    readonly calls: Array<{ method: string; agent: string; sessionName: string; order: number }> = []
    readonly promptEvidence: PromptEvidence[] = []

    private async bounded<T>(operation: Promise<T>, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void this.stop().then(
                () => terminateOwnedTempProcesses(ownedRoot),
              ).then(
                () => reject(new Error(`real acpx child timed out: ${label}`)),
                reject,
              )
            }, 120_000)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    override async ensureSession(agent: string, sessionName: string): Promise<string> {
      this.calls.push({ method: 'ensureSession', agent, sessionName, order: order() })
      return this.bounded(super.ensureSession(agent, sessionName), `ensure:${sessionName}`)
    }
    override async prompt(agent: string, sessionName: string, text: string, handlers?: Parameters<SourceAcpxClient['prompt']>[3]) {
      this.calls.push({ method: 'prompt', agent, sessionName, order: order() })
      this.promptEvidence.push({
        sessionName,
        fingerprint: createHash('sha256').update(text).digest('hex'),
        remoteSandbox: text.includes('remote sandbox'),
        remoteNativeCapabilities: text.includes('own remote-native Feishu/Lark capabilities'),
        invariantAampResultJson: text.includes('AAMP_RESULT_JSON'),
        invariantFeishuTaskResultJson: text.includes('FEISHU_TASK_RESULT_JSON'),
        localLarkCliProfileRules: text.includes('Feishu lark-cli profile rules:'),
        localEnvironmentSource: text.includes('source ~/lark-env.sh'),
        localFileMarker: text.includes('FILE:/absolute/path/to/file'),
        localFilePathGuidance: text.includes('Use these local file paths'),
        secretEvidence: text.includes(forbiddenPromptValues.secret),
        callerCwdEvidence: text.includes(forbiddenPromptValues.callerCwd),
        rawAcpCommandEvidence: text.includes(forbiddenPromptValues.rawAcpCommand),
        localProfileEvidence: text.includes('--profile ') || text.includes('Feishu lark-cli profile rules:'),
      })
      return this.bounded(super.prompt(agent, sessionName, text, handlers), `prompt:${sessionName}`)
    }
    override async cancel(agent: string, sessionName: string): Promise<void> {
      this.calls.push({ method: 'cancel', agent, sessionName, order: order() })
      return this.bounded(super.cancel(agent, sessionName), `cancel:${sessionName}`)
    }
    override async close(agent: string, sessionName: string): Promise<void> {
      return this.bounded(super.close(agent, sessionName), `close:${sessionName}`)
    }
  }
  return new Observed(ownedRoot)
}

function safeEvidenceJson(client: ArtifactAampClient, logs: readonly string[]): string {
  return JSON.stringify({
    results: client.results,
    helps: client.helps,
    streamEvents: client.streamEvents,
    streamCloses: client.streamCloses,
    logs,
  })
}

async function processExists(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function recordedAcpxPids(root: string): Promise<number[]> {
  const canonicalRoot = await realpath(root)
  const pids = new Set<number>()
  for (const directory of [join(root, '.acpx/queues'), join(root, '.acpx/sessions')]) {
    for (const name of await readdir(directory).catch(() => [])) {
      if (!name.endsWith('.json') && !name.endsWith('.lock')) continue
      try {
        const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as { pid?: unknown }
        if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) continue
        const pid = value.pid as number
        if (!(await processExists(pid))) continue
        const command = await runBounded('/bin/ps', ['-p', String(pid), '-o', 'command='], {
          cwd: '/',
          env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
          timeoutMs: 5_000,
        })
        requireSuccess(command, 'owned process inspection')
        if (!command.stdout.includes(root) && !command.stdout.includes(canonicalRoot)) {
          throw new Error('refusing to classify an unrelated acpx owner as owned')
        }
        pids.add(pid)
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
  return [...pids]
}

async function ownedTempPids(root: string): Promise<number[]> {
  const canonicalRoot = await realpath(root)
  const listed = await runBounded('/bin/ps', ['-axo', 'pid=,command='], {
    cwd: '/',
    env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 5_000,
  })
  requireSuccess(listed, 'owned temp process inspection')
  const pids = new Set(await recordedAcpxPids(root))
  for (const line of listed.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]!
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
    if (command.includes(root) || command.includes(canonicalRoot)) pids.add(pid)
  }
  return [...pids].filter((pid) => pid !== process.pid && pid > 1)
}

async function pidOwnedByRoot(root: string, pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
  const canonicalRoot = await realpath(root)
  const inspected = await runBounded('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    cwd: '/',
    env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 5_000,
  })
  if (inspected.code !== 0 || inspected.signal !== null) return false
  return inspected.stdout.includes(root) || inspected.stdout.includes(canonicalRoot)
}

async function signalOwnedProcess(root: string, pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!(await pidOwnedByRoot(root, pid))) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  try { process.kill(pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForProcessExit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  const alivePids = async (candidates: readonly number[]): Promise<number[]> => {
    const checks = await Promise.all(candidates.map(async (pid) => ({ pid, alive: await processExists(pid) })))
    return checks.flatMap((value) => value.alive ? [value.pid] : [])
  }
  let alive = await alivePids(pids)
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 20))
    alive = await alivePids(alive)
  }
  return alive
}

async function terminateOwnedTempProcesses(root: string): Promise<void> {
  const initial = await ownedTempPids(root)
  for (const pid of initial) await signalOwnedProcess(root, pid, 'SIGTERM')
  const afterTerm = await waitForProcessExit(initial, 2_000)
  for (const pid of afterTerm) await signalOwnedProcess(root, pid, 'SIGKILL')
  const afterKill = await waitForProcessExit(afterTerm, 2_000)
  if (afterKill.length > 0) throw new Error('owned temp process survived SIGKILL')
  const untrackedSurvivors = await ownedTempPids(root)
  if (untrackedSurvivors.length > 0) {
    for (const pid of untrackedSurvivors) await signalOwnedProcess(root, pid, 'SIGKILL')
    const finalSurvivors = await waitForProcessExit(untrackedSurvivors, 2_000)
    if (finalSurvivors.length > 0) throw new Error('owned temp process cleanup incomplete')
  }
}

export async function runPackagedAimeBridgeProof(): Promise<PackagedAimeBridgeEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'aamp-aime-packaged-'))
  const originalEnvironment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    AIME_ACP_LOG_LEVEL: process.env.AIME_ACP_LOG_LEVEL,
    AIME_ACP_FAKE_SCENARIO: process.env.AIME_ACP_FAKE_SCENARIO,
    AIME_ACP_FAKE_TRACE: process.env.AIME_ACP_FAKE_TRACE,
    CREDENTIAL_SENTINEL: process.env.CREDENTIAL_SENTINEL,
    CWD_SENTINEL: process.env.CWD_SENTINEL,
    RAW_TOOL_SENTINEL: process.env.RAW_TOOL_SENTINEL,
  }
  const logs: string[] = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  let bridge: AgentBridgeRuntime | undefined
  let acpx: ObservedAcpxClient | undefined
  let packageVersion = ''
  let bytedcliVersion = ''
  let tarballSha256 = ''
  let npmShasum = ''
  let npmIntegrity = ''
  let entryCount = 0
  let packedSize = 0
  let unpackedSize = 0
  let ownedProcessesAfterCleanup = -1
  const stopReasons: string[] = []
  let evidence: PackagedAimeBridgeEvidence | undefined
  let privacyEvidence = ''
  try {
    const scenarioPath = join(root, 'scenario.json')
    const tracePath = join(root, 'trace.jsonl')
    const textResponse = answeredEnvelope('Synthetic streamed answer.')
    const scenario: FakeScenario = {
      auth: { authenticated: true, identity: { field: 'employeeId', value: 'safe-fake-user' } },
      space: { id: 'safe-remote-space' },
      newSessionId: 'safe-remote-session',
      prompts: [{ messageId: 'text-user', createdAt: '2033-05-18T03:33:20.000Z', events: textEvents(0, 'text-user', 'text-assistant', textResponse.visible) }],
    }
    await writeFile(scenarioPath, `${JSON.stringify(scenario)}\n`, { mode: 0o600 })
    await writeFile(tracePath, '', { mode: 0o600 })

    const npmEnv = {
      ...process.env,
      npm_config_registry: REGISTRY,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    }
    const pack = npmInvocation(['pack', '--json', `--registry=${REGISTRY}`, '--pack-destination', root])
    const packed = await runBounded(pack.file, pack.args, { cwd: AIME_PACKAGE_ROOT, env: npmEnv, timeoutMs: 120_000 })
    requireSuccess(packed, 'aime-acp npm pack')
    const artifact = parseLastJson(packed.stdout)
    assert.equal(artifact.filename, FINAL_PACKAGED_AIME_IDENTITY.filename)
    assert.equal(artifact.shasum, FINAL_PACKAGED_AIME_IDENTITY.npmShasum)
    assert.equal(artifact.integrity, FINAL_PACKAGED_AIME_IDENTITY.npmIntegrity)
    assert.equal(artifact.entryCount, FINAL_PACKAGED_AIME_IDENTITY.entryCount)
    assert.equal(artifact.size, FINAL_PACKAGED_AIME_IDENTITY.packedSize)
    assert.equal(artifact.unpackedSize, FINAL_PACKAGED_AIME_IDENTITY.unpackedSize)
    npmShasum = artifact.shasum as string
    npmIntegrity = artifact.integrity as string
    entryCount = artifact.entryCount as number
    packedSize = artifact.size as number
    unpackedSize = artifact.unpackedSize as number
    const tarball = join(root, artifact.filename as string)
    tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
    assert.equal(tarballSha256, FINAL_PACKAGED_AIME_IDENTITY.tarballSha256)

    const bridgePack = npmInvocation(['pack', '--json', `--registry=${REGISTRY}`, '--pack-destination', root])
    const packedBridge = await runBounded(bridgePack.file, bridgePack.args, { cwd: BRIDGE_PACKAGE_ROOT, env: npmEnv, timeoutMs: 120_000 })
    requireSuccess(packedBridge, 'aamp-acp-bridge npm pack')
    const bridgeArtifact = parseLastJson(packedBridge.stdout)
    const bridgeTarball = join(root, bridgeArtifact.filename as string)
    assert.equal((await readFile(bridgeTarball)).byteLength > 0, true)

    await writeFile(join(root, 'package.json'), `${JSON.stringify({ private: true, type: 'module' })}\n`)
    const install = npmInvocation(['install', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`, tarball, bridgeTarball, `acpx@${ACPX_VERSION}`])
    const installed = await runBounded(install.file, install.args, { cwd: root, env: npmEnv, timeoutMs: 120_000 })
    requireSuccess(installed, 'packaged bridge clean install')
    const installedPackage = JSON.parse(await readFile(join(root, 'node_modules/@tengchengwei/aime-acp/package.json'), 'utf8')) as { version: string }
    const installedAcpx = JSON.parse(await readFile(join(root, 'node_modules/acpx/package.json'), 'utf8')) as { version: string }
    const installedBytedcli = JSON.parse(await readFile(join(root, 'node_modules/@bytedance-dev/bytedcli/package.json'), 'utf8')) as { version: string }
    const installedBridgePackage = JSON.parse(await readFile(join(root, 'node_modules/@zengxingyuan/aamp-acp-bridge/package.json'), 'utf8')) as { version: string }
    packageVersion = installedPackage.version
    bytedcliVersion = installedBytedcli.version
    assert.equal(packageVersion, FINAL_PACKAGED_AIME_IDENTITY.packageVersion)
    assert.equal(installedAcpx.version, ACPX_VERSION)
    assert.equal(bytedcliVersion, '0.123.0')
    assert.equal(installedBridgePackage.version, '0.1.28-dev.21')
    const installedRequire = createRequire(join(root, 'package.json'))
    const resolvedBytedcliEntry = await realpath(installedRequire.resolve('@bytedance-dev/bytedcli'))
    const installedBytedcliRoot = await realpath(join(root, 'node_modules/@bytedance-dev/bytedcli'))
    assert.equal(
      resolvedBytedcliEntry.startsWith(`${installedBytedcliRoot}/`),
      true,
      'CJS require.resolve must use the exact real bytedcli from the clean install',
    )

    const helperDirectory = join(root, 'test-only-loader')
    await mkdir(helperDirectory)
    for (const name of ['aime-packaged-register.mjs', 'aime-packaged-loader.mjs', 'aime-packaged-fake-bytedcli.mjs', 'aime-packaged-fake-support.mjs']) {
      await copyFile(join(TEST_DIRECTORY, name), join(helperDirectory, name))
    }
    const safeBin = join(root, 'safe-bin')
    await mkdir(safeBin)
    await symlink(process.execPath, join(safeBin, 'node'))
    await symlink(join(root, 'node_modules/.bin/acpx'), join(safeBin, 'acpx'))
    const installedAgent = join(root, 'node_modules/.bin/aime-acp')
    const installedBridgeExecutable = join(root, 'node_modules/.bin/aamp-acp-bridge')
    const installedBridgeRoot = join(root, 'node_modules/@zengxingyuan/aamp-acp-bridge')
    assert.equal(resolve(installedAgent).startsWith(resolve(root)), true)
    assert.equal(resolve(installedBridgeExecutable).startsWith(resolve(root)), true)

    process.env.HOME = root
    process.env.USERPROFILE = root
    process.env.PATH = safeBin
    process.env.NODE_OPTIONS = `--import=${join(helperDirectory, 'aime-packaged-register.mjs')}`
    process.env.AIME_ACP_LOG_LEVEL = 'error'
    process.env.AIME_ACP_FAKE_SCENARIO = scenarioPath
    process.env.AIME_ACP_FAKE_TRACE = tracePath
    process.env.CREDENTIAL_SENTINEL = SENTINELS[0]
    process.env.CWD_SENTINEL = SENTINELS[2]
    process.env.RAW_TOOL_SENTINEL = SENTINELS[1]
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }

    const client = new ArtifactAampClient()
    let receivedClientConfig: Parameters<typeof AampClient.fromMailboxIdentity>[0] | undefined
    const { AcpxClient: InstalledAcpxClient } = await import(fileURLToPath(new URL(`file://${join(installedBridgeRoot, 'dist/acpx-client.js')}`))) as { AcpxClient: AcpxClientConstructor }
    const { AgentBridge: InstalledAgentBridge } = await import(fileURLToPath(new URL(`file://${join(installedBridgeRoot, 'dist/agent-bridge.js')}`))) as { AgentBridge: AgentBridgeConstructor }
    const { loadConfig: loadInstalledConfig } = await import(fileURLToPath(new URL(`file://${join(installedBridgeRoot, 'dist/config.js')}`))) as { loadConfig: (path: string) => { agents: unknown[] } }
    acpx = createObservedAcpxClient(InstalledAcpxClient, root, () => client.nextOrder(), {
      secret: SENTINELS[0],
      callerCwd: process.cwd(),
      rawAcpCommand: installedAgent,
    })
    const dependencies: AgentBridgeDependencies = {
      createClient: (config) => {
        receivedClientConfig = config
        return client as unknown as AampClient
      },
      createAcpx: () => acpx!,
      resolveIdentity: async () => ({
        email: 'agent@meshmail.test',
        mailboxToken: SENTINELS[0],
        smtpPassword: SENTINELS[0],
      }),
    }
    const credentialsFile = join(root, 'aime-credentials.json')
    const configPath = join(root, 'aamp-acp-bridge.json')
    const initInputPath = join(root, 'aamp-acp-bridge-init.json')
    await writeFile(credentialsFile, `${JSON.stringify({
      email: 'agent@meshmail.test',
      mailboxToken: SENTINELS[0],
      smtpPassword: SENTINELS[0],
    })}\n`, { mode: 0o600 })
    await writeFile(initInputPath, `${JSON.stringify({
      aampHost: 'https://meshmail.test',
      agents: [{
        name: 'aime',
        acpCommand: installedAgent,
        executionLocation: 'remote',
        attachmentPolicy: 'reject',
        taskDispatchConcurrency: 1,
        credentialsFile,
        senderPoliciesFile: join(root, 'sender-policies.json'),
        senderPolicies: [{ sender: 'sender@example.com' }],
      }],
    })}\n`, { mode: 0o600 })
    const installedInit = await runBounded(process.execPath, [
      join(installedBridgeRoot, 'dist/index.js'),
      'init', '--json', '--input', initInputPath, '--config', configPath,
    ], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      timeoutMs: 120_000,
    })
    requireSuccess(installedInit, 'installed aamp-acp-bridge JSON init')
    const initialized = parseLastJson(installedInit.stdout) as { agents?: Array<{ executionLocation?: unknown }> }
    assert.equal(initialized.agents?.[0]?.executionLocation, 'remote')
    const initializedAgent = loadInstalledConfig(configPath).agents[0]
    assert.ok(initializedAgent)
    assert.equal((initializedAgent as { executionLocation?: unknown }).executionLocation, 'remote')
    assert.equal((initializedAgent as { attachmentPolicy?: unknown }).attachmentPolicy, 'reject')
    bridge = new InstalledAgentBridge(initializedAgent, 'https://meshmail.test', true, dependencies)
    await bridge.start({ quiet: true })
    assert.equal(receivedClientConfig?.taskDispatchConcurrency, 1)
    acpx.calls.length = 0
    client.createdStreams.length = 0
    client.hydrationOrders.length = 0

    const textSessionKey = 'packaged:text'
    const helpSessionKey = 'packaged:help'
    const cancelSessionKey = 'packaged:cancel'
    const concurrencySessionKey = 'packaged:concurrency'
    await client.emitDispatch(task('text-task', textSessionKey))
    assert.deepEqual(client.results.map((value) => [value.taskId, value.status, value.output]), [['text-task', 'completed', textResponse.inner]])
    const textTaskEvents = client.streamEvents.filter((value) => value.taskId === 'text-task')
    const protocolTypes = textTaskEvents.map((value) => String(value.type))
    assert.ok(protocolTypes.includes('text.delta'))
    assert.ok(protocolTypes.includes('todo'))
    assert.ok(protocolTypes.includes('tool_call'))
    const thoughtIndex = textTaskEvents.findIndex((value) =>
      String(value.type) === 'text.delta'
      && typeof value.payload.text === 'string'
      && value.payload.text.includes('[thinking] Synthetic thought'))
    const planIndex = textTaskEvents.findIndex((value) =>
      String(value.type) === 'todo'
      && Array.isArray(value.payload.items)
      && value.payload.items.some((item: unknown) =>
        typeof item === 'object' && item !== null && (item as { id?: unknown }).id === 'plan-1'))
    const runningToolIndex = textTaskEvents.findIndex((value) =>
      String(value.type) === 'tool_call' && value.payload.status === 'running')
    const completedToolIndex = textTaskEvents.findIndex((value) =>
      String(value.type) === 'tool_call' && value.payload.status === 'completed')
    const assistantIndex = textTaskEvents.findIndex((value) =>
      String(value.type) === 'text.delta'
      && typeof value.payload.text === 'string'
      && value.payload.text.includes('Synthetic streamed answer.'))
    assert.ok(thoughtIndex >= 0)
    assert.ok(thoughtIndex < planIndex)
    assert.ok(planIndex < runningToolIndex)
    assert.ok(runningToolIndex < completedToolIndex)
    assert.ok(completedToolIndex < assistantIndex)

    const completedSessionKey = 'packaged:completed'
    const completedFirstResponse = answeredEnvelope('Synthetic first-turn answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'completed-first-user',
      createdAt: '2033-05-18T03:33:20.100Z',
      events: textEvents(0, 'completed-first-user', 'completed-first-assistant', completedFirstResponse.visible),
    })
    const remoteCreatesBeforeCompletedFollowUp = requireTrace(tracePath).filter((value) => value.method === 'createSession').length
    await client.emitDispatch(task('completed-first-task', completedSessionKey))
    const completedFirstResult = client.results.find((value) => value.taskId === 'completed-first-task')
    assert.equal(completedFirstResult?.status, 'completed')
    assert.equal(completedFirstResult?.output, completedFirstResponse.inner)
    const completedSessionPath = await findSessionRecordPath(root, 'aamp-aime-packaged:completed')
    const completedSessionBeforeFollowUp = JSON.parse(await readFile(completedSessionPath, 'utf8')) as Record<string, unknown>
    const completedFollowUpResponse = answeredEnvelope('Synthetic follow-up answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'completed-follow-up-user',
      createdAt: '2033-05-18T03:33:20.200Z',
      events: textEvents(10, 'completed-follow-up-user', 'completed-follow-up-assistant', completedFollowUpResponse.visible),
    })
    await client.emitDispatch(task('completed-follow-up-task', completedSessionKey))
    const completedSessionAfterFollowUp = JSON.parse(await readFile(completedSessionPath, 'utf8')) as Record<string, unknown>
    assert.equal(completedSessionAfterFollowUp.pid, completedSessionBeforeFollowUp.pid)
    assert.equal(completedSessionAfterFollowUp.acp_session_id, completedSessionBeforeFollowUp.acp_session_id)
    assert.equal(requireTrace(tracePath).filter((value) => value.method === 'createSession').length, remoteCreatesBeforeCompletedFollowUp + 1)
    const completedFollowUpResult = client.results.find((value) => value.taskId === 'completed-follow-up-task')
    assert.equal(completedFollowUpResult?.status, 'completed')
    assert.equal(completedFollowUpResult?.output, completedFollowUpResponse.inner)

    await appendScenarioPrompt(scenarioPath, {
      messageId: 'help-user',
      createdAt: '2033-05-18T03:33:21.000Z',
      events: helpEvent(0, 'help-user'),
    })
    const remoteCreatesBeforeHelp = requireTrace(tracePath).filter((value) => value.method === 'createSession').length
    const helpStartResultCount = client.results.length
    await client.emitDispatch(task('help-task', helpSessionKey))
    assert.equal(client.helps.filter((value) => value.taskId === 'help-task').length, 1, JSON.stringify({
      results: client.results.filter((value) => value.taskId === 'help-task'),
      closes: client.streamCloses.filter((value) => value.taskId === 'help-task'),
      calls: acpx.calls.filter((value) => value.sessionName.includes('stable:packaged-aime')),
      trace: requireTrace(tracePath).slice(-12),
      logs: logs.slice(-12),
    }))
    const remoteCreatesAfterHelp = requireTrace(tracePath).filter((value) => value.method === 'createSession').length
    assert.equal(remoteCreatesAfterHelp, remoteCreatesBeforeHelp + 1)
    assert.equal(client.results.length, helpStartResultCount)
    const helpClose = client.streamCloses.find((value) => value.taskId === 'help-task')
    assert.ok(helpClose)
    const helpIndex = client.helps.findIndex((value) => value.taskId === 'help-task')
    assert.ok(helpClose.order < client.helpOrders[helpIndex]!)
    const resumedResponse = answeredEnvelope('Synthetic resumed answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'resume-user',
      createdAt: '2033-05-18T03:33:22.000Z',
      events: textEvents(2, 'resume-user', 'resume-assistant', resumedResponse.visible),
    })
    const helpSessionPath = await findSessionRecordPath(root, 'aamp-aime-packaged:help')
    const helpSessionBeforeResume = JSON.parse(await readFile(helpSessionPath, 'utf8')) as Record<string, unknown>
    await client.emitDispatch(task('resume-task', helpSessionKey))
    const helpSessionAfterResume = JSON.parse(await readFile(helpSessionPath, 'utf8')) as Record<string, unknown>
    assert.equal(helpSessionAfterResume.pid, helpSessionBeforeResume.pid)
    assert.equal(helpSessionAfterResume.acp_session_id, helpSessionBeforeResume.acp_session_id)
    assert.equal(requireTrace(tracePath).filter((value) => value.method === 'createSession').length, remoteCreatesAfterHelp)
    const resumeResult = client.results.find((value) => value.taskId === 'resume-task')
    assert.equal(resumeResult?.status, 'completed')
    assert.equal(resumeResult?.output, resumedResponse.inner)

    const attachmentTraceBefore = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).length
    const attachmentCallsBefore = acpx.calls.length
    const attachmentStreamsBefore = client.createdStreams.length
    const attachmentSessionStateBefore = await acpxSessionStateFiles(root)
    const attachmentResultsBefore = client.results.length
    await client.emitDispatch(task('attachment-task', 'stable:attachment', {
      attachments: [{ filename: 'remote.txt', contentType: 'text/plain', size: 5, blobId: 'blob-attachment' }],
    }))
    assert.equal(client.helps.filter((value) => value.taskId === 'attachment-task').length, 1)
    assert.equal(client.downloadCalls.length, 0)
    assert.equal(acpx.calls.length, attachmentCallsBefore)
    assert.equal(client.createdStreams.length, attachmentStreamsBefore)
    assert.equal(client.results.length, attachmentResultsBefore)
    assert.equal(client.results.some((value) => value.taskId === 'attachment-task'), false)
    assert.deepEqual(await acpxSessionStateFiles(root), attachmentSessionStateBefore)
    assert.equal((await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).length, attachmentTraceBefore)

    await appendScenarioPrompt(scenarioPath, {
      messageId: 'cancel-user',
      createdAt: '2033-05-18T03:33:23.000Z',
      gateAfterOffset: 1,
      events: [
        event('session.message.create', 0, { message: { message_id: 'cancel-user', role: 'user', content: 'redacted-user-content' } }),
        event('session.message.create', 1, { reply_message_id: 'cancel-user', message: { message_id: 'cancel-assistant', role: 'assistant', content: 'CANCEL_STARTED' } }),
        event('session.progress_notice', 2, { status: 'waiting_for_next' }),
      ],
    })
    const cancelDispatch = client.emitDispatch(task('cancel-task', cancelSessionKey))
    await until(() => client.streamEvents.some((value) => value.taskId === 'cancel-task' && JSON.stringify(value.payload).includes('CANCEL_STARTED')), 'cancel stream start')
    await client.emitCancel(cancellation('cancel-task'))
    await cancelDispatch
    assert.equal(acpx.calls.filter((value) => value.method === 'cancel' && value.sessionName === 'aamp-aime-packaged:cancel').length, 1)
    assert.deepEqual(client.streamCloses.find((value) => value.taskId === 'cancel-task')?.payload, { reason: 'task.cancelled', status: 'cancelled' })
    assert.equal(client.results.some((value) => value.taskId === 'cancel-task'), false)
    stopReasons.push('cancelled')
    await until(() => (existsSync(tracePath) && requireTrace(tracePath).some((value) => value.method === 'drain.waiting_for_next')), 'cancel drain')
    const afterCancelResponse = answeredEnvelope('Synthetic post-cancel answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'after-cancel-user',
      createdAt: '2033-05-18T03:33:24.000Z',
      events: textEvents(3, 'after-cancel-user', 'after-cancel-assistant', afterCancelResponse.visible),
    })
    await client.emitDispatch(task('after-cancel-task', cancelSessionKey))
    const afterCancelResult = client.results.find((value) => value.taskId === 'after-cancel-task')
    assert.equal(afterCancelResult?.status, 'completed')
    assert.equal(afterCancelResult?.output, afterCancelResponse.inner)

    const concurrencyFirstResponse = answeredEnvelope('Synthetic first concurrent answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'concurrency-first-user',
      createdAt: '2033-05-18T03:33:25.000Z',
      gateAfterOffset: 0,
      gateFile: join(root, 'release-concurrency-first'),
      events: textEvents(0, 'concurrency-first-user', 'concurrency-first-assistant', concurrencyFirstResponse.visible),
    })
    const firstDispatch = client.emitDispatch(task('concurrency-first-task', concurrencySessionKey))
    await until(() => requireTrace(tracePath).some((value) => value.method === 'sendMessage' && value.messageId === 'concurrency-first-user'), 'first concurrency send')
    const concurrencySessionName = 'aamp-aime-packaged:concurrency'
    const firstPromptCall = acpx.calls.find((value) => value.method === 'prompt' && value.sessionName === concurrencySessionName)
    assert.ok(firstPromptCall)
    const concurrencySecondResponse = answeredEnvelope('Synthetic second concurrent answer.')
    await appendScenarioPrompt(scenarioPath, {
      messageId: 'concurrency-second-user',
      createdAt: '2033-05-18T03:33:26.000Z',
      events: textEvents(10, 'concurrency-second-user', 'concurrency-second-assistant', concurrencySecondResponse.visible),
    })
    const secondDispatch = client.emitDispatch(task('concurrency-second-task', concurrencySessionKey))
    await until(() => client.hydrationOrders.some((value) => value.taskId === 'concurrency-second-task'), 'second concurrency hydration')
    assert.equal(client.createdStreams.some((value) => value.taskId === 'concurrency-second-task'), false)
    assert.deepEqual(
      acpx.calls.filter((value) => value.sessionName === concurrencySessionName).map((value) => value.method),
      ['ensureSession', 'prompt'],
    )
    assert.equal(requireTrace(tracePath).some((value) => value.method === 'sendMessage' && value.messageId === 'concurrency-second-user'), false)
    await writeFile(join(root, 'release-concurrency-first'), 'release\n')
    await Promise.all([firstDispatch, secondDispatch])
    assert.equal(client.results.find((value) => value.taskId === 'concurrency-first-task')?.output, concurrencyFirstResponse.inner)
    assert.equal(client.results.find((value) => value.taskId === 'concurrency-second-task')?.output, concurrencySecondResponse.inner)
    const firstResultOrder = client.resultOrders[client.results.findIndex((value) => value.taskId === 'concurrency-first-task')]!
    const secondStreamOrder = client.createdStreams.find((value) => value.taskId === 'concurrency-second-task')!.order
    assert.ok(firstResultOrder < secondStreamOrder)
    assert.deepEqual(
      acpx.calls.filter((value) => value.sessionName === concurrencySessionName).map((value) => value.method),
      ['ensureSession', 'prompt', 'ensureSession', 'prompt'],
    )

    const traces = requireTrace(tracePath)
    const createTraces = traces.filter((value) => value.method === 'createSession')
    const createIds = createTraces.map((value) => value.sessionId)
    assert.equal(createTraces.length, 6)
    assert.equal(new Set(createIds).size, createIds.length)
    const sessionForMessage = (messageId: string): string => {
      const value = traces.find((trace) => trace.method === 'sendMessage' && trace.messageId === messageId)?.sessionId
      assert.equal(typeof value, 'string')
      return value as string
    }
    const textRemoteSession = sessionForMessage('text-user')
    const completedRemoteSession = sessionForMessage('completed-first-user')
    const helpRemoteSession = sessionForMessage('help-user')
    const cancelRemoteSession = sessionForMessage('cancel-user')
    const concurrencyRemoteSession = sessionForMessage('concurrency-first-user')
    assert.equal(sessionForMessage('resume-user'), helpRemoteSession)
    assert.equal(sessionForMessage('completed-follow-up-user'), completedRemoteSession)
    assert.equal(sessionForMessage('after-cancel-user'), cancelRemoteSession)
    assert.equal(sessionForMessage('concurrency-second-user'), concurrencyRemoteSession)
    assert.equal(new Set([
      textRemoteSession,
      completedRemoteSession,
      helpRemoteSession,
      cancelRemoteSession,
      concurrencyRemoteSession,
    ]).size, 5)
    for (const sessionId of [textRemoteSession, completedRemoteSession, helpRemoteSession, cancelRemoteSession, concurrencyRemoteSession]) {
      assert.equal(createIds.filter((value) => value === sessionId).length, 1)
    }
    const cancelTraces = traces.filter((value) => value.method === 'cancel')
    assert.equal(cancelTraces.length, 1)
    assert.equal(cancelTraces[0]?.sessionId, cancelRemoteSession)
    assert.equal(traces.some((value) => value.method === 'drain.waiting_for_next' && value.sessionId === cancelRemoteSession), true)
    assert.ok(completedFirstResult)
    assert.ok(completedFollowUpResult)
    const completedResults = [completedFirstResult, completedFollowUpResult]
    const completedResponses = [completedFirstResponse, completedFollowUpResponse]
    const completedSummaries = ['Synthetic first-turn answer.', 'Synthetic follow-up answer.']
    const completedDispositions = completedResults.map((result) => classifyFeishuTaskResult(result, 'remote'))
    assert.deepEqual(completedDispositions, [
      { kind: 'answered', summary: 'Synthetic first-turn answer.', replyWritten: false },
      { kind: 'answered', summary: 'Synthetic follow-up answer.', replyWritten: false },
    ])
    const completedResultContract = {
      turns: completedResults.length,
      visibleOuterEnvelopes: completedResponses.every((response, index) =>
        isVisibleNestedAnsweredEnvelope(response.visible, completedSummaries[index]!)),
      forwardedInnerMarkers: completedResults.every((result, index) =>
        result.output === completedResponses[index]!.inner
        && result.output.startsWith('FEISHU_TASK_RESULT_JSON: ')
        && !result.output.includes('AAMP_RESULT_JSON:')),
      schemaV2: completedDispositions.every((disposition) => disposition.kind === 'answered'),
      dispositionKinds: completedDispositions.map((disposition) => disposition.kind),
      summaries: completedDispositions.map((disposition) => 'summary' in disposition ? disposition.summary ?? '' : ''),
      replyWritten: completedDispositions.map((disposition) => disposition.kind === 'answered' ? disposition.replyWritten ?? true : true),
      commentRequired: completedDispositions.map((disposition) =>
        disposition.kind === 'answered' && disposition.replyWritten === false && Boolean(disposition.summary)),
      completionRequired: completedDispositions.map((disposition) => disposition.kind === 'answered'),
    } as const
    assert.deepEqual(completedResultContract, {
      turns: 2,
      visibleOuterEnvelopes: true,
      forwardedInnerMarkers: true,
      schemaV2: true,
      dispositionKinds: ['answered', 'answered'],
      summaries: ['Synthetic first-turn answer.', 'Synthetic follow-up answer.'],
      replyWritten: [false, false],
      commentRequired: [true, true],
      completionRequired: [true, true],
    })
    const completedTurnPrompts = acpx.promptEvidence.filter((value) => value.sessionName === 'aamp-aime-packaged:completed')
    assert.equal(completedTurnPrompts.length, 2)
    const completedTurnContract = {
      turns: completedTurnPrompts.length,
      reusedRemoteSession: sessionForMessage('completed-follow-up-user') === completedRemoteSession,
      bothCompleted: completedFirstResult?.status === 'completed' && completedFollowUpResult?.status === 'completed',
      remoteSandbox: completedTurnPrompts.every((value) => value.remoteSandbox),
      remoteNativeCapabilities: completedTurnPrompts.every((value) => value.remoteNativeCapabilities),
      invariantAampResultJson: completedTurnPrompts.every((value) => value.invariantAampResultJson),
      invariantFeishuTaskResultJson: completedTurnPrompts.every((value) => value.invariantFeishuTaskResultJson),
      localLarkCliProfileRules: completedTurnPrompts.some((value) => value.localLarkCliProfileRules),
      localEnvironmentSource: completedTurnPrompts.some((value) => value.localEnvironmentSource),
      localFileMarker: completedTurnPrompts.some((value) => value.localFileMarker),
      localFilePathGuidance: completedTurnPrompts.some((value) => value.localFilePathGuidance),
      secretEvidence: completedTurnPrompts.some((value) => value.secretEvidence),
      callerCwdEvidence: completedTurnPrompts.some((value) => value.callerCwdEvidence),
      rawAcpCommandEvidence: completedTurnPrompts.some((value) => value.rawAcpCommandEvidence),
      localProfileEvidence: completedTurnPrompts.some((value) => value.localProfileEvidence),
    } as const
    assert.deepEqual(completedTurnContract, {
      turns: 2,
      reusedRemoteSession: true,
      bothCompleted: true,
      remoteSandbox: true,
      remoteNativeCapabilities: true,
      invariantAampResultJson: true,
      invariantFeishuTaskResultJson: true,
      localLarkCliProfileRules: false,
      localEnvironmentSource: false,
      localFileMarker: false,
      localFilePathGuidance: false,
      secretEvidence: false,
      callerCwdEvidence: false,
      rawAcpCommandEvidence: false,
      localProfileEvidence: false,
    })
    const followUpPrompts = acpx.promptEvidence.filter((value) => value.sessionName === 'aamp-aime-packaged:help')
    assert.equal(followUpPrompts.length, 2)
    const promptContract = {
      turns: followUpPrompts.length,
      reusedRemoteSession: sessionForMessage('resume-user') === helpRemoteSession,
      remoteSandbox: followUpPrompts.every((value) => value.remoteSandbox),
      remoteNativeCapabilities: followUpPrompts.every((value) => value.remoteNativeCapabilities),
      invariantAampResultJson: followUpPrompts.every((value) => value.invariantAampResultJson),
      invariantFeishuTaskResultJson: followUpPrompts.every((value) => value.invariantFeishuTaskResultJson),
      localLarkCliProfileRules: followUpPrompts.some((value) => value.localLarkCliProfileRules),
      localEnvironmentSource: followUpPrompts.some((value) => value.localEnvironmentSource),
      localFileMarker: followUpPrompts.some((value) => value.localFileMarker),
      localFilePathGuidance: followUpPrompts.some((value) => value.localFilePathGuidance),
      secretEvidence: followUpPrompts.some((value) => value.secretEvidence),
      callerCwdEvidence: followUpPrompts.some((value) => value.callerCwdEvidence),
      rawAcpCommandEvidence: followUpPrompts.some((value) => value.rawAcpCommandEvidence),
      localProfileEvidence: followUpPrompts.some((value) => value.localProfileEvidence),
    } as const
    assert.deepEqual(promptContract, {
      turns: 2,
      reusedRemoteSession: true,
      remoteSandbox: true,
      remoteNativeCapabilities: true,
      invariantAampResultJson: true,
      invariantFeishuTaskResultJson: true,
      localLarkCliProfileRules: false,
      localEnvironmentSource: false,
      localFileMarker: false,
      localFilePathGuidance: false,
      secretEvidence: false,
      callerCwdEvidence: false,
      rawAcpCommandEvidence: false,
      localProfileEvidence: false,
    })
    privacyEvidence = `${safeEvidenceJson(client, logs)}\n${JSON.stringify(traces)}\n${JSON.stringify(completedTurnPrompts)}\n${JSON.stringify(followUpPrompts)}`
    stopReasons.push('end_turn', 'help_needed')

    evidence = {
      scenarios: ['text-streaming', 'completed-continuation', 'help-continuation', 'attachment-reject', 'cancel-drain-follow-up', 'same-session-concurrency'],
      packageVersion,
      acpxVersion: ACPX_VERSION,
      bytedcliVersion,
      tarballSha256,
      npmShasum,
      npmIntegrity,
      entryCount,
      packedSize,
      unpackedSize,
      productionBridgeCommit: FINAL_PACKAGED_AIME_IDENTITY.productionBridgeCommit,
      coreCommit: FINAL_PACKAGED_AIME_IDENTITY.coreCommit,
      counts: {
        streams: client.createdStreams.length,
        results: client.results.length,
        helps: client.helps.length,
        remoteCreates: traces.filter((value) => value.method === 'createSession').length,
        remoteSends: traces.filter((value) => value.method === 'sendMessage').length,
        remoteCancels: traces.filter((value) => value.method === 'cancel').length,
      },
      stopReasons,
      installedBridge: {
        packageVersion: installedBridgePackage.version,
        jsonInitExecutionLocation: String(initialized.agents?.[0]?.executionLocation),
        runtime: 'installed-package',
      },
      completedResultContract,
      completedTurnContract,
      promptContract,
      promptFingerprints: [...completedTurnPrompts, ...followUpPrompts].map((value) => value.fingerprint),
      cleanup: { ownedProcesses: -1, tempRootRemoved: false },
    }
  } finally {
    let cleanupFailure: unknown
    try {
      try { await bridge?.stop() } catch (error) { cleanupFailure = error }
      try { await acpx?.stop() } catch (error) { cleanupFailure ??= error }
      await terminateOwnedTempProcesses(root)
      ownedProcessesAfterCleanup = (await ownedTempPids(root)).length
    } catch (error) {
      cleanupFailure ??= error
    } finally {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
    if (cleanupFailure !== undefined) throw cleanupFailure
  }
  assert.ok(evidence)
  assert.equal(ownedProcessesAfterCleanup, 0)
  assert.equal(existsSync(root), false)
  privacyEvidence = `${privacyEvidence}\n${JSON.stringify(logs)}`
  for (const forbidden of [...SENTINELS, root, process.cwd()]) {
    const safeDiagnostic = logs
      .filter((line) => line.includes(forbidden))
      .map((line) => line
        .replaceAll(root, '<temp-root>')
        .replaceAll(process.cwd(), '<workspace>')
        .replaceAll(SENTINELS[0], '<credential>')
        .replaceAll(SENTINELS[1], '<raw-tool>')
        .replaceAll(SENTINELS[2], '<cwd-sentinel>'))
    assert.equal(
      privacyEvidence.includes(forbidden),
      false,
      `forbidden evidence leaked (${basename(forbidden)}): ${JSON.stringify(safeDiagnostic)}`,
    )
  }
  return {
    ...evidence,
    cleanup: { ownedProcesses: ownedProcessesAfterCleanup, tempRootRemoved: true },
  }
}

function requireTrace(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function appendScenarioPrompt(path: string, prompt: unknown): Promise<void> {
  const scenario = JSON.parse(await readFile(path, 'utf8')) as FakeScenario
  await writeFile(path, `${JSON.stringify({
    ...scenario,
    prompts: [prompt],
  })}\n`, { mode: 0o600 })
}

async function findSessionRecordPath(root: string, name: string): Promise<string> {
  for (const entry of await readdir(join(root, '.acpx/sessions'))) {
    if (!entry.endsWith('.json') || entry === 'index.json') continue
    const path = join(root, '.acpx/sessions', entry)
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (value.name === name) return path
  }
  throw new Error('named acpx session record missing')
}

async function acpxSessionStateFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, '.acpx/sessions'))).sort()
}
