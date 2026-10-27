import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  AampClient,
  AAMP_CANCEL_RESULT_CONTEXT_KEY,
  type AampStreamEvent,
  type AampThreadEvent,
  type CreateStreamResult,
  type HydratedTaskDispatch,
  type SendResultOptions,
  type SendHelpOptions,
  type TaskCancel,
  type TaskDispatch,
  type TaskStreamState,
} from 'aamp-sdk'
import {
  AgentBridge,
  type AgentBridgeDependencies,
  formatDebugPromptLog,
  formatAgentReadinessError,
  formatTaskAgentError,
  requiresStartupReadinessProbe,
  resolveTaskSessionKey,
  stripAampInternalDispatchContext,
  threadAlreadyTerminal,
} from './agent-bridge.js'
import type { AcpPromptHandlers, AcpResult } from './acpx-client.js'
import { UserFacingBridgeError } from './errors.js'

const homeEnvironmentKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'

type StoredHandler = (...args: never[]) => unknown

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<boolean> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

class FakeAampClient {
  readonly results: SendResultOptions[] = []
  readonly helps: SendHelpOptions[] = []
  readonly hydratedDispatches: Array<{ taskId: string; messageId: string }> = []
  readonly downloadedBlobs: Array<{ blobId: string; filename?: string }> = []
  readonly createdStreams: Array<{ taskId: string; peerEmail: string }> = []
  readonly helpGate = deferred<void>()
  readonly streamEvents: AampStreamEvent[] = []
  readonly streamCloses: Array<{
    streamId: string
    payload?: Record<string, unknown>
  }> = []
  readonly streamCloseStarted = deferred<void>()
  readonly streamCloseGate = deferred<void>()
  readonly promptAppendStarted = deferred<void>()
  readonly promptAppendGate = deferred<void>()
  readonly responseAppendStarted = deferred<void>()
  readonly responseAppendGate = deferred<void>()
  readonly hydrateStarted = deferred<void>()
  readonly hydrateGate = deferred<void>()
  readonly downloadStarted = deferred<void>()
  readonly downloadGate = deferred<void>()
  readonly resultStarted = deferred<void>()
  readonly resultGate = deferred<void>()
  gateResponseAppend = false
  gatePromptAppend = false
  gateHydrate = false
  gateDownload = false
  appendFailure: Error | undefined
  appendFailureSummary: string | undefined
  closeFailure: Error | undefined
  resultFailure: Error | undefined
  helpFailure: Error | undefined
  threadHistory: AampThreadEvent[] = []
  private readonly handlers = new Map<string, StoredHandler[]>()
  private connected = false
  private readonly streams = new Map<string, CreateStreamResult>()

  on(event: string, handler: StoredHandler): this {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  async emitTaskDispatch(task: TaskDispatch): Promise<void> {
    const handlers = this.handlers.get('task.dispatch') ?? []
    await Promise.all(handlers.map((handler) => Promise.resolve(
      (handler as (task: TaskDispatch) => unknown)(task),
    )))
  }

  async emitTaskCancel(task: TaskCancel): Promise<void> {
    const handlers = this.handlers.get('task.cancel') ?? []
    await Promise.all(handlers.map((handler) => Promise.resolve(
      (handler as (task: TaskCancel) => unknown)(task),
    )))
  }

  async emitDisconnected(reason: string): Promise<void> {
    const handlers = this.handlers.get('disconnected') ?? []
    await Promise.all(handlers.map((handler) => Promise.resolve(
      (handler as (reason: string) => unknown)(reason),
    )))
  }

  async emitError(error: Error): Promise<void> {
    const handlers = this.handlers.get('error') ?? []
    await Promise.all(handlers.map((handler) => Promise.resolve(
      (handler as (error: Error) => unknown)(error),
    )))
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  disconnect(): void {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  isUsingPollingFallback(): boolean {
    return false
  }

  async reconcileRecentEmails(): Promise<number> {
    return 0
  }

  async updateDirectoryProfile(): Promise<never> {
    throw new Error('directory profile update was not expected')
  }

  async hydrateTaskDispatch(task: TaskDispatch): Promise<HydratedTaskDispatch> {
    this.hydratedDispatches.push({ taskId: task.taskId, messageId: task.messageId })
    this.hydrateStarted.resolve()
    if (this.gateHydrate) await this.hydrateGate.promise
    return {
      ...task,
      threadHistory: this.threadHistory,
      threadContextText: '',
    }
  }

  async createStream(options: { taskId: string; peerEmail: string }): Promise<CreateStreamResult> {
    this.createdStreams.push(options)
    const stream = {
      streamId: `stream-${options.taskId}`,
      taskId: options.taskId,
      status: 'created',
      ownerEmail: 'agent@meshmail.test',
      peerEmail: options.peerEmail,
      createdAt: '2026-08-13T00:00:00.000Z',
    } satisfies CreateStreamResult
    this.streams.set(stream.streamId, stream)
    return stream
  }

  async sendStreamOpened(): Promise<void> {}

  async appendStreamEvent(options: {
    streamId: string
    type: AampStreamEvent['type']
    payload: Record<string, unknown>
  }): Promise<AampStreamEvent> {
    const event: AampStreamEvent = {
      streamId: options.streamId,
      taskId: this.streams.get(options.streamId)?.taskId ?? '',
      seq: this.streamEvents.length + 1,
      timestamp: '2026-08-13T00:00:00.000Z',
      type: options.type,
      payload: options.payload,
    }
    this.streamEvents.push(event)
    if (this.appendFailure && (this.appendFailureSummary === undefined || options.payload.summary === this.appendFailureSummary)) {
      throw this.appendFailure
    }
    if (this.gatePromptAppend && options.payload.summary === 'Prompt sent to ACP agent') {
      this.promptAppendStarted.resolve()
      await this.promptAppendGate.promise
    }
    if (this.gateResponseAppend && options.payload.summary === 'ACP response received') {
      this.responseAppendStarted.resolve()
      await this.responseAppendGate.promise
    }
    return event
  }

  async closeStream(options: {
    streamId: string
    payload?: Record<string, unknown>
  }): Promise<TaskStreamState> {
    const stream = this.streams.get(options.streamId)
    assert.ok(stream)
    this.streamCloses.push(options)
    this.streamCloseStarted.resolve()
    await this.streamCloseGate.promise
    if (this.closeFailure) throw this.closeFailure
    return {
      ...stream,
      status: 'closed',
      closedAt: '2026-08-13T00:00:01.000Z',
      latestEvent: this.streamEvents.at(-1),
    }
  }

  async sendResult(options: SendResultOptions): Promise<void> {
    this.results.push(options)
    this.resultStarted.resolve()
    await this.resultGate.promise
    if (this.resultFailure) throw this.resultFailure
  }

  async sendHelp(options: SendHelpOptions): Promise<void> {
    this.helps.push(options)
    await this.helpGate.promise
    if (this.helpFailure) throw this.helpFailure
  }

  async downloadBlob(blobId: string, filename?: string): Promise<Buffer> {
    this.downloadedBlobs.push({ blobId, filename })
    this.downloadStarted.resolve()
    if (this.gateDownload) await this.downloadGate.promise
    return Buffer.from('fixture attachment bytes')
  }

  async sendPairRespond(): Promise<never> {
    throw new Error('pair response was not expected')
  }

  async getThreadHistory(): Promise<{ taskId: string; events: [] }> {
    throw new Error('pair history was not expected')
  }
}

class FakeAcpxClient {
  readonly calls: Array<{ method: string; agent: string; sessionName: string }> = []
  readonly closeCalls: Array<{ agent: string; sessionName: string }> = []
  readonly prompts: string[] = []
  readonly promptLocalPaths: Array<{ path: string; existed: boolean }> = []
  readonly ensureSessionGate = deferred<void>()
  readonly promptStarted = deferred<void>()
  readonly promptGate = deferred<AcpResult>()
  readonly cancelGate = deferred<void>()
  gateEnsureSession = false
  gatePrompt = false
  gateCancel = false
  cancelFailure: Error | undefined
  closeFailureSession: string | undefined
  ensureSessionFailure: Error | undefined
  promptFailure: Error | undefined
  promptResult: AcpResult = {
    output: 'remote agent response',
    events: [],
    streamedAssistantText: false,
  }

  async probeAgent(): Promise<void> {}

  async ensureSession(agent: string, sessionName: string): Promise<string> {
    this.calls.push({ method: 'ensureSession', agent, sessionName })
    if (this.gateEnsureSession) await this.ensureSessionGate.promise
    if (this.ensureSessionFailure) throw this.ensureSessionFailure
    return sessionName
  }

  async prompt(
    agent: string,
    sessionName: string,
    _text: string,
    _handlers?: AcpPromptHandlers,
  ): Promise<AcpResult> {
    this.calls.push({ method: 'prompt', agent, sessionName })
    this.prompts.push(_text)
    this.promptStarted.resolve()
    for (const line of _text.split('\n')) {
      const pathSeparator = line.lastIndexOf(': ')
      if (pathSeparator < 0) continue
      const path = line.slice(pathSeparator + 2)
      if (isAbsolute(path)) this.promptLocalPaths.push({ path, existed: existsSync(path) })
    }
    if (this.gatePrompt) return this.promptGate.promise
    if (this.promptFailure) throw this.promptFailure
    return this.promptResult
  }

  async cancel(agent: string, sessionName: string): Promise<void> {
    this.calls.push({ method: 'cancel', agent, sessionName })
    if (this.gateCancel) await this.cancelGate.promise
    if (this.cancelFailure) throw this.cancelFailure
  }

  async close(agent: string, sessionName: string): Promise<void> {
    this.closeCalls.push({ agent, sessionName })
    if (sessionName === this.closeFailureSession) {
      throw new Error('CLOSE_PATH_SENTINEL')
    }
  }

  async stop(): Promise<void> {}
}

test('formatDebugPromptLog emits prompt diagnostics without prompt content', () => {
  const prompt = '## AAMP Task SECRET_PROMPT'

  const log = formatDebugPromptLog({
    agentName: 'codex',
    taskId: 'task-123',
    sessionName: 'feishu-task:task-123',
    prompt,
  })

  assert.match(log, /^\[codex\] ACP prompt debug task=task-123 session=feishu-task:task-123 /)
  assert.match(log, new RegExp(`prompt_chars=${prompt.length}`))
  assert.match(log, /prompt_sha256=[0-9a-f]{64}/)
  assert.match(log, /content_logged=false$/)
  assert.doesNotMatch(log, /SECRET_PROMPT/)
})

test('remote Agent result files are rejected without exposing remote artifact paths', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-artifact-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: 'aime-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })
  await bridge.start({ quiet: true })
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  fakeAcpx.promptResult = {
    output: 'Completed the requested work.\nFILE:/remote/sandbox/private.txt',
    events: [],
    streamedAssistantText: false,
  }

  await fakeClient.emitTaskDispatch(cancellationTask('remote-artifact'))

  assert.equal(fakeClient.results.length, 1)
  assert.equal(fakeClient.results[0]?.status, 'rejected')
  assert.match(fakeClient.results[0]?.errorMsg ?? '', /REMOTE_ARTIFACT_UNSUPPORTED/)
  assert.doesNotMatch(fakeClient.results[0]?.errorMsg ?? '', /remote\/sandbox/)
  assert.equal(fakeClient.results[0]?.attachments, undefined)
  await bridge.stop()
})

test('remote structured result attachments are rejected before filesystem diagnostics', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-structured-artifact-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: 'aime-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })
  await bridge.start({ quiet: true })
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  fakeAcpx.promptResult = {
    output: [
      'AAMP_RESULT_JSON:',
      '{"output":"Completed the requested work.","attachments":[{"filename":"private.txt","contentType":"text/plain","path":"/remote/sandbox/STRUCTURED_PRIVATE_SENTINEL.txt"}]}',
    ].join('\n'),
    events: [],
    streamedAssistantText: false,
  }
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')) }
  try {
    await fakeClient.emitTaskDispatch(cancellationTask('remote-structured-artifact'))
  } finally {
    console.warn = originalWarn
  }

  assert.equal(fakeClient.results.length, 1)
  assert.equal(fakeClient.results[0]?.status, 'rejected')
  assert.match(fakeClient.results[0]?.errorMsg ?? '', /REMOTE_ARTIFACT_UNSUPPORTED/)
  assert.doesNotMatch(fakeClient.results[0]?.errorMsg ?? '', /STRUCTURED_PRIVATE_SENTINEL|remote\/sandbox/)
  assert.equal(fakeClient.results[0]?.attachments, undefined)
  assert.doesNotMatch(warnings.join('\n'), /STRUCTURED_PRIVATE_SENTINEL|remote\/sandbox/)
  await bridge.stop()
})

test('remote structured result file references fail closed before a successful terminal result', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-structured-file-ref-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: 'aime-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })
  await bridge.start({ quiet: true })
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  const artifactFields: Array<{ label: string; field: Record<string, unknown> }> = [
    {
      label: 'review payload',
      field: {
        fieldKey: 'proof',
        fieldTypeKey: 'attachment',
        value: '/remote/sandbox/REVIEW_PRIVATE_SENTINEL.txt',
        attachmentFilenames: ['private.txt'],
      },
    },
    { label: 'file field type', field: { fieldKey: 'proof', fieldTypeKey: 'file', value: 'opaque-id' } },
    { label: 'camel-case file field type', field: { fieldKey: 'proof', fieldTypeKey: 'multiFile', value: 'opaque-id' } },
    { label: 'separated attachment field type', field: { fieldKey: 'proof', fieldTypeKey: 'multi_attachment', value: 'opaque-id' } },
    { label: 'attachment filenames on a text field', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: 'done', attachmentFilenames: ['private.txt'] } },
    { label: 'nested path key', field: { fieldKey: 'proof', fieldTypeKey: 'json', value: { result: { path: 'PRIVATE_PATH_SENTINEL' } } } },
    { label: 'nested file key', field: { fieldKey: 'proof', fieldTypeKey: 'json', value: { result: [{ file: 'PRIVATE_FILE_SENTINEL' }] } } },
    { label: 'nested attachment key', field: { fieldKey: 'proof', fieldTypeKey: 'json', value: { result: { attachment: 'PRIVATE_ATTACHMENT_SENTINEL' } } } },
    { label: 'Unix path value', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: '/remote/sandbox/UNIX_PRIVATE_SENTINEL.txt' } },
    { label: 'Windows path value', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: 'C:\\remote\\WINDOWS_PRIVATE_SENTINEL.txt' } },
    { label: 'UNC path value', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: '\\\\server\\share\\UNC_PRIVATE_SENTINEL.txt' } },
    { label: 'home-relative path value', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: '~/HOME_PRIVATE_SENTINEL.txt' } },
    { label: 'FILE reference value', field: { fieldKey: 'proof', fieldTypeKey: 'text', value: 'FILE:/remote/sandbox/FILE_PRIVATE_SENTINEL.txt' } },
  ]

  const errors: string[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')) }
  try {
    for (const [index, artifact] of artifactFields.entries()) {
      const taskId = `remote-structured-file-ref-${index}`
      fakeAcpx.promptResult = {
        output: `AAMP_RESULT_JSON: ${JSON.stringify({
          output: 'done',
          structuredResult: [artifact.field],
        })}`,
        events: [],
        streamedAssistantText: false,
      }

      await fakeClient.emitTaskDispatch(cancellationTask(taskId))

      const taskResults = fakeClient.results.filter((result) => result.taskId === taskId)
      assert.equal(taskResults.length, 1, `${artifact.label} must produce one terminal result`)
      assert.equal(taskResults[0]?.status, 'rejected', `${artifact.label} must fail closed`)
      assert.equal(
        taskResults[0]?.errorMsg,
        'ACP agent error: REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
      )
      assert.equal(fakeClient.helps.some((help) => help.taskId === taskId), false)
      assert.deepEqual(
        fakeClient.streamCloses.filter((close) => close.streamId === `stream-${taskId}`),
        [{
          streamId: `stream-${taskId}`,
          payload: {
            reason: 'task.result',
            status: 'rejected',
            error: 'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
          },
        }],
        `${artifact.label} must not close the stream as completed`,
      )
    }
  } finally {
    console.error = originalError
  }

  const publicSurfaces = JSON.stringify({
    results: fakeClient.results,
    helps: fakeClient.helps,
    streamCloses: fakeClient.streamCloses,
    streamEvents: fakeClient.streamEvents,
    errors,
  })
  assert.doesNotMatch(
    publicSurfaces,
    /REVIEW_PRIVATE_SENTINEL|PRIVATE_PATH_SENTINEL|PRIVATE_FILE_SENTINEL|PRIVATE_ATTACHMENT_SENTINEL|UNIX_PRIVATE_SENTINEL|WINDOWS_PRIVATE_SENTINEL|UNC_PRIVATE_SENTINEL|HOME_PRIVATE_SENTINEL|FILE_PRIVATE_SENTINEL/,
  )
  await bridge.stop()
})

test('remote structured results preserve non-file values and credential-free HTTP(S) links', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-structured-safe-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: 'aime-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })
  await bridge.start({ quiet: true })
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const structuredResult = [
    { fieldKey: 'summary', fieldTypeKey: 'text', value: 'Analysis complete' },
    { fieldKey: 'ownerProfile', fieldTypeKey: 'profile', value: { name: 'Aime' } },
    { fieldKey: 'source', fieldTypeKey: 'url', value: 'https://example.com/report?id=42' },
    {
      fieldKey: 'references',
      fieldTypeKey: 'json',
      value: { primaryUrl: 'http://example.com/a/b', labels: ['Public report'] },
    },
  ]
  fakeAcpx.promptResult = {
    output: `AAMP_RESULT_JSON: ${JSON.stringify({ output: 'done', structuredResult })}`,
    events: [],
    streamedAssistantText: false,
  }

  await fakeClient.emitTaskDispatch(cancellationTask('remote-structured-safe'))

  assert.deepEqual(fakeClient.results, [{
    to: 'sender@example.com',
    taskId: 'remote-structured-safe',
    status: 'completed',
    output: 'done',
    structuredResult,
    inReplyTo: '<remote-structured-safe@example.com>',
    attachments: undefined,
  }])
  assert.deepEqual(fakeClient.streamCloses, [{
    streamId: 'stream-remote-structured-safe',
    payload: { reason: 'task.result', status: 'completed' },
  }])
  await bridge.stop()
})

test('local Agents retain structured attachment-field behavior', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-local-structured-file-ref-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const bridge = new AgentBridge({
    name: 'local-agent',
    acpCommand: 'local-agent-acp',
    executionLocation: 'local',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })
  await bridge.start({ quiet: true })
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const structuredResult = [{
    fieldKey: 'proof',
    fieldTypeKey: 'attachment',
    value: '/local/workspace/proof.txt',
    attachmentFilenames: ['proof.txt'],
  }]
  fakeAcpx.promptResult = {
    output: `AAMP_RESULT_JSON: ${JSON.stringify({ output: 'done', structuredResult })}`,
    events: [],
    streamedAssistantText: false,
  }

  await fakeClient.emitTaskDispatch(cancellationTask('local-structured-file-ref'))

  assert.equal(fakeClient.results[0]?.status, 'completed')
  assert.deepEqual(fakeClient.results[0]?.structuredResult, structuredResult)
  assert.deepEqual(fakeClient.streamCloses[0]?.payload, { reason: 'task.result', status: 'completed' })
  await bridge.stop()
})

test('remote task error formatting redacts unsafe diagnostics', () => {
  const unsafe = new Error("acpx --cwd /Users/private --agent '/secret/aime-acp' prompt token=SECRET_PROMPT")
  assert.equal(
    formatTaskAgentError('aime', unsafe, 'remote'),
    "acpx --cwd /Users/private --agent '/secret/aime-acp' prompt token=[REDACTED]",
  )
  assert.equal(
    formatTaskAgentError('aime', new Error('AUTH_REQUIRED raw-private-detail'), 'remote'),
    'AUTH_REQUIRED: Remote Agent authentication is required.',
  )
  assert.equal(
    formatTaskAgentError('aime', new Error('AUTH_IDENTITY_CHANGED raw-private-detail'), 'remote'),
    'AUTH_IDENTITY_CHANGED: Restart the binding after verifying the remote account.',
  )
})

test('remote AIME auth failures preserve safe login guidance', () => {
  assert.equal(
    formatTaskAgentError(
      'aime',
      new Error(
        'AUTH_REQUIRED: Managed user authentication is required. Run `aime-acp auth login --site cn`.',
      ),
      'remote',
    ),
    'AUTH_REQUIRED: Remote Agent authentication is required. Run `aime-acp auth login --site cn`.',
  )
})

test('remote task error formatting treats UserFacingBridgeError text as untrusted', () => {
  const cases: Array<[UserFacingBridgeError, string]> = [
    [
      new UserFacingBridgeError(
        'WorkBuddy ACP readiness check failed: /Users/private/USER_FACING_SENTINEL --secret-token',
      ),
      'WorkBuddy ACP readiness check failed: /Users/private/USER_FACING_SENTINEL --secret-token',
    ],
    [
      new UserFacingBridgeError(
        'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported. /remote/PRIVATE_ARTIFACT_SENTINEL',
      ),
      'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
    ],
    [
      new UserFacingBridgeError('AUTH_REQUIRED /Users/private/AUTH_REQUIRED_SENTINEL'),
      'AUTH_REQUIRED: Remote Agent authentication is required.',
    ],
    [
      new UserFacingBridgeError('AUTH_IDENTITY_CHANGED /Users/private/AUTH_IDENTITY_SENTINEL'),
      'AUTH_IDENTITY_CHANGED: Restart the binding after verifying the remote account.',
    ],
    [
      new UserFacingBridgeError('AIME_ACCESS_DENIED /Users/private/AIME_CODE_SENTINEL'),
      'AIME_ACCESS_DENIED /Users/private/AIME_CODE_SENTINEL',
    ],
  ]

  const formatted = cases.map(([error, expected]) => {
    const actual = formatTaskAgentError('aime', error, 'remote')
    assert.equal(actual, expected)
    return actual
  })
  assert.match(formatted.join('\n'), /AIME_CODE_SENTINEL/)

  const local = new UserFacingBridgeError('LOCAL_USER_FACING_SENTINEL remains compatible')
  assert.equal(
    formatTaskAgentError('workbuddy', local, 'local'),
    'LOCAL_USER_FACING_SENTINEL remains compatible',
  )
})

test('remote Agent identity event exposes only structural command configuration', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-identity-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const events: Array<Record<string, unknown>> = []
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: "'/Users/private/AIME_RUNTIME_COMMAND_SENTINEL' --acp",
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })

  const identity = events.find((event) => event.type === 'agent.identity')
  assert.deepEqual(identity, {
    type: 'agent.identity',
    bridge: 'acp-bridge',
    agent: 'aime',
    email: 'agent@meshmail.test',
    executionLocation: 'remote',
    acpCommandConfigured: true,
  })
  assert.doesNotMatch(JSON.stringify(identity), /AIME_RUNTIME_COMMAND_SENTINEL|Users\/private/)
  await bridge.stop()
})

test('remote runtime error events use fixed safe messages without raw ACP or transport details', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-remote-runtime-events-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  fakeAcpx.ensureSessionFailure = new Error(
    'AUTH_IDENTITY_CHANGED /Users/private/REMOTE_SESSION_ERROR_SENTINEL',
  )
  const events: Array<Record<string, unknown>> = []
  const bridge = new AgentBridge({
    name: 'aime',
    acpCommand: "'/Users/private/REMOTE_RUNTIME_COMMAND_SENTINEL' --acp",
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
  }, 'https://meshmail.test', true, {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const originalError = console.error
  const originalWarn = console.warn
  console.error = () => undefined
  console.warn = () => undefined
  try {
    await fakeClient.emitError(new Error(
      'AUTH_REQUIRED /Users/private/REMOTE_TRANSPORT_ERROR_SENTINEL',
    ))
    await fakeClient.emitDisconnected(
      'socket failed at /Users/private/REMOTE_DISCONNECT_ERROR_SENTINEL',
    )
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }

  assert.deepEqual(events.find((event) => event.type === 'agent.session.deferred'), {
    type: 'agent.session.deferred',
    bridge: 'acp-bridge',
    agent: 'aime',
    email: 'agent@meshmail.test',
    message: 'AUTH_IDENTITY_CHANGED: Restart the binding after verifying the remote account.',
  })
  assert.deepEqual(events.find((event) => event.type === 'agent.error'), {
    type: 'agent.error',
    bridge: 'acp-bridge',
    agent: 'aime',
    email: 'agent@meshmail.test',
    message: 'AUTH_REQUIRED: Remote Agent authentication is required.',
  })
  assert.deepEqual(events.find((event) => event.type === 'agent.disconnected'), {
    type: 'agent.disconnected',
    bridge: 'acp-bridge',
    agent: 'aime',
    email: 'agent@meshmail.test',
    reason: 'socket failed at /Users/private/REMOTE_DISCONNECT_ERROR_SENTINEL',
    pollingFallback: false,
  })
  assert.match(JSON.stringify(events), /REMOTE_DISCONNECT_ERROR_SENTINEL/)
  await bridge.stop()
})

test('threadAlreadyTerminal treats help-needed threads as closed for historical reconcile', () => {
  assert.equal(threadAlreadyTerminal([
    {
      intent: 'task.help_needed',
      from: 'agent@meshmail.ai',
      to: 'bridge@meshmail.ai',
      createdAt: '2026-07-06T00:00:00.000Z',
    },
  ]), true)
})

test('resolveTaskSessionKey falls back to dispatch context compatibility field', () => {
  assert.equal(resolveTaskSessionKey({
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:task-guid-123',
    },
  }), 'feishu-task:task-guid-123')
  assert.equal(resolveTaskSessionKey({
    sessionKey: 'feishu-task:canonical-guid',
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:shadow-guid',
    },
  }), 'feishu-task:canonical-guid')
})

test('stripAampInternalDispatchContext removes session compatibility field without mutating task', () => {
  const task = {
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:task-guid-123',
      [AAMP_CANCEL_RESULT_CONTEXT_KEY]: 'cancelled',
    },
  }

  const stripped = stripAampInternalDispatchContext(task)

  assert.deepEqual(stripped.dispatchContext, { source: 'feishu-task' })
  assert.deepEqual(task.dispatchContext, {
    source: 'feishu-task',
    aamp_session_key: 'feishu-task:task-guid-123',
    [AAMP_CANCEL_RESULT_CONTEXT_KEY]: 'cancelled',
  })
})

test('both WorkBuddy products require the startup ACP readiness probe', () => {
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy_ai' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'traex' }), false)
  assert.equal(requiresStartupReadinessProbe({ name: 'codex' }), false)
})

test('WorkBuddy authentication failures have actionable startup and task messages', () => {
  const failure = new Error('acpx failed (1): stderr: Authentication required')

  assert.equal(
    formatAgentReadinessError('workbuddy', failure),
    'WorkBuddy is not logged in. Open WorkBuddy and sign in, then retry.',
  )
  assert.equal(
    formatTaskAgentError('workbuddy', failure),
    'WorkBuddy login expired. Open WorkBuddy and sign in, then retry the task.',
  )
})

test('WorkBuddy AI authentication failures name the international app', () => {
  const failure = new Error('acpx failed (1): stderr: Authentication required')
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', failure),
    'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
  )
  assert.equal(
    formatTaskAgentError('workbuddy_ai', failure),
    'WorkBuddy AI login expired. Open WorkBuddy AI and sign in, then retry the task.',
  )
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', new Error('ACP readiness probe timed out after 15000ms')),
    'WorkBuddy AI ACP readiness check failed: ACP readiness probe timed out after 15000ms',
  )
})

test('other readiness failures retain their diagnostic details', () => {
  assert.equal(
    formatAgentReadinessError('workbuddy', new Error('ACP readiness probe timed out after 15000ms')),
    'WorkBuddy ACP readiness check failed: ACP readiness probe timed out after 15000ms',
  )
  assert.equal(
    formatTaskAgentError('traex', new Error('transport closed')),
    'transport closed',
  )
})

test('WorkBuddy readiness failure aborts startup before AAMP identity resolution', async () => {
  const bridge = new AgentBridge({
    name: 'workbuddy',
    acpCommand: 'fake-codebuddy --acp',
    credentialsFile: '/path/that/must/not/be/read.json',
  }, 'https://meshmail.ai', false)
  ;(bridge as unknown as { acpx: { probeAgent: () => Promise<void> } }).acpx = {
    probeAgent: async () => {
      throw new Error('Authentication required')
    },
  }

  await assert.rejects(
    bridge.start({ quiet: true }),
    /WorkBuddy is not logged in\. Open WorkBuddy and sign in, then retry\./,
  )
})

async function captureStartedClientConfig(taskDispatchConcurrency?: number) {
  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const clientConfigs: Parameters<typeof AampClient.fromMailboxIdentity>[0][] = []
  const dependencies: AgentBridgeDependencies = {
    createClient: (config) => {
      clientConfigs.push(config)
      return fakeClient as unknown as AampClient
    },
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  }
  const bridge = new AgentBridge({
    name: 'remote-agent',
    acpCommand: 'remote-agent --acp',
    ...(taskDispatchConcurrency === undefined ? {} : { taskDispatchConcurrency }),
  }, 'https://meshmail.test', true, dependencies)

  await bridge.start({ quiet: true })

  assert.equal(clientConfigs.length, 1)
  return clientConfigs[0]!
}

test('configured task dispatch concurrency is forwarded to the AAMP client', async () => {
  const clientConfig = await captureStartedClientConfig(3)

  assert.equal(clientConfig.taskDispatchConcurrency, 3)
})

test('omitted task dispatch concurrency leaves the AAMP client default unchanged', async () => {
  const clientConfig = await captureStartedClientConfig()

  assert.equal(clientConfig.taskDispatchConcurrency, undefined)
})

test('injected bridge harness awaits a text task through the resolved ACP session', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-harness-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const clientConfigs: Parameters<typeof AampClient.fromMailboxIdentity>[0][] = []
  const dependencies: AgentBridgeDependencies = {
    createClient: (config) => {
      clientConfigs.push(config)
      return fakeClient as unknown as AampClient
    },
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  }
  const bridge = new AgentBridge({
    name: 'remote-agent',
    acpCommand: 'remote-agent --acp',
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, dependencies)

  await bridge.start({ quiet: true })
  assert.equal(clientConfigs.length, 1)
  fakeAcpx.calls.length = 0

  const task: TaskDispatch = {
    protocolVersion: '1.1',
    intent: 'task.dispatch',
    taskId: 'task-harness-001',
    sessionKey: 'conversation:remote-001',
    title: 'Answer a remote question',
    priority: 'normal',
    from: 'sender@example.com',
    to: 'agent@meshmail.test',
    messageId: '<task-harness-001@example.com>',
    subject: 'AAMP task',
    bodyText: 'What is the answer?',
  }

  let dispatchSettled = false
  const dispatch = fakeClient.emitTaskDispatch(task).finally(() => {
    dispatchSettled = true
  })
  try {
    await fakeClient.streamCloseStarted.promise

    assert.equal(dispatchSettled, false, 'emitTaskDispatch must await stream close')
    assert.equal(fakeClient.results.length, 0, 'sendResult must not start before stream close completes')
    assert.deepEqual(fakeAcpx.calls.map((call) => call.method), ['ensureSession', 'prompt'])
    assert.equal(fakeAcpx.calls[0]?.sessionName, 'aamp-remote-agent-conversation:remote-001')
    assert.equal(fakeAcpx.calls[1]?.sessionName, fakeAcpx.calls[0]?.sessionName)

    fakeClient.streamCloseGate.resolve()
    await fakeClient.resultStarted.promise

    assert.equal(dispatchSettled, false, 'emitTaskDispatch must await the final result send')
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-task-harness-001',
      payload: { reason: 'task.result', status: 'completed' },
    }])
    assert.equal(fakeClient.results[0]?.status, 'completed')

    fakeClient.resultGate.resolve()
    await dispatch
    assert.equal(dispatchSettled, true)
  } finally {
    fakeClient.streamCloseGate.resolve()
    fakeClient.resultGate.resolve()
    fakeClient.helpGate.resolve()
    await dispatch.catch(() => undefined)
  }
})

function taskWithAttachment(taskId: string, from = 'sender@example.com'): TaskDispatch {
  return {
    protocolVersion: '1.1',
    intent: 'task.dispatch',
    taskId,
    sessionKey: `conversation:${taskId}`,
    title: 'Inspect an attachment',
    priority: 'normal',
    from,
    to: 'agent@meshmail.test',
    messageId: `<${taskId}@example.com>`,
    subject: 'AAMP task with attachment',
    bodyText: 'Please inspect the attached requirements.',
    attachments: [{
      filename: 'requirements.txt',
      contentType: 'text/plain',
      size: 24,
      blobId: `blob-${taskId}`,
    }],
  }
}

function bridgeHarness(options: {
  testHome: string
  attachmentPolicy?: 'allow' | 'reject'
  from?: string
}) {
  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const dependencies: AgentBridgeDependencies = {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  }
  const bridge = new AgentBridge({
    name: 'remote-agent',
    acpCommand: 'remote-agent --acp',
    ...(options.attachmentPolicy ? { attachmentPolicy: options.attachmentPolicy } : {}),
    senderPoliciesFile: join(options.testHome, 'sender-policies.json'),
    senderPolicies: [{ sender: options.from ?? 'sender@example.com' }],
  }, 'https://meshmail.test', true, dependencies)
  return { bridge, fakeClient, fakeAcpx }
}

function cancellationTask(taskId: string, overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    protocolVersion: '1.1',
    intent: 'task.dispatch',
    taskId,
    sessionKey: `conversation:${taskId}`,
    title: 'Run a cancellable task',
    priority: 'normal',
    from: 'sender@example.com',
    to: 'agent@meshmail.test',
    messageId: `<${taskId}@example.com>`,
    subject: 'AAMP cancellable task',
    bodyText: 'Wait until this task is cancelled.',
    ...overrides,
  }
}

function controlledCancellationTask(taskId: string): TaskDispatch {
  return cancellationTask(taskId, {
    dispatchContext: { source: 'feishu-task', [AAMP_CANCEL_RESULT_CONTEXT_KEY]: 'cancelled' },
  })
}

function historyEvent(intent: AampThreadEvent['intent'], from = 'sender@example.com', to = 'agent@meshmail.test'): AampThreadEvent {
  return { intent, from, to, createdAt: '2026-10-16T09:32:59.863Z', messageId: `<history-${intent}@example.com>` }
}

function cancellationEvent(taskId: string): TaskCancel {
  return {
    protocolVersion: '1.1',
    intent: 'task.cancel',
    taskId,
    from: 'sender@example.com',
    to: 'agent@meshmail.test',
    messageId: `<cancel-${taskId}@example.com>`,
    subject: 'Cancel AAMP task',
    bodyText: 'Stop the active task.',
  }
}

async function cancellationHarness(
  context: TestContext,
  taskId: string,
  options: {
    attachmentPolicy?: 'allow' | 'reject'
    senderPolicies?: Array<{ sender: string }>
  } = {},
) {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), `aamp-acp-bridge-cancel-${taskId}-`))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const events: Array<Record<string, unknown>> = []
  const fakeClient = new FakeAampClient()
  const fakeAcpx = new FakeAcpxClient()
  const dependencies: AgentBridgeDependencies = {
    createClient: () => fakeClient as unknown as AampClient,
    createAcpx: () => fakeAcpx,
    resolveIdentity: async () => ({
      email: 'agent@meshmail.test',
      mailboxToken: 'managed-by-aamp-client',
      smtpPassword: 'test-password',
    }),
  }
  const bridge = new AgentBridge({
    name: 'remote-agent',
    acpCommand: 'remote-agent --acp',
    ...(options.attachmentPolicy ? { attachmentPolicy: options.attachmentPolicy } : {}),
    senderPoliciesFile: join(testHome, 'sender-policies.json'),
    senderPolicies: options.senderPolicies ?? [{ sender: 'sender@example.com' }],
  }, 'https://meshmail.test', true, dependencies)

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  fakeAcpx.calls.length = 0
  return { bridge, events, fakeClient, fakeAcpx, testHome }
}

function releaseCancellationGates(fakeClient: FakeAampClient, fakeAcpx: FakeAcpxClient): void {
  fakeAcpx.ensureSessionGate.resolve()
  fakeAcpx.cancelGate.resolve()
  fakeAcpx.promptGate.resolve({
    output: 'remote agent response',
    events: [],
    streamedAssistantText: false,
  })
  fakeClient.hydrateGate.resolve()
  fakeClient.downloadGate.resolve()
  fakeClient.promptAppendGate.resolve()
  fakeClient.responseAppendGate.resolve()
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  fakeClient.helpGate.resolve()
}

function failTaskOwnerWrite(context: TestContext, ownerFile: string, error: Error, onFailure?: () => void): () => void {
  const originalWrite = fs.writeFileSync
  const mocked = context.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    const [file] = args
    if (String(file) === ownerFile) {
      onFailure?.()
      throw error
    }
    return originalWrite(...args)
  })
  syncBuiltinESMExports()
  return () => { mocked.mock.restore(); syncBuiltinESMExports() }
}

function sessionMutexQueues(bridge: AgentBridge): Map<string, unknown[]> {
  return (bridge as unknown as {
    sessionMutex: { waiters: Map<string, unknown[]> }
  }).sessionMutex.waiters
}

function activeTaskSessionCount(bridge: AgentBridge): number {
  return (bridge as unknown as {
    activeTaskSessions: Map<string, unknown>
  }).activeTaskSessions.size
}

function trackedSessionNames(bridge: AgentBridge): Set<string> {
  return (bridge as unknown as {
    sessionNames: Set<string>
  }).sessionNames
}

test('controlled lock preparation failure returns one rejected receipt before stream or ACP startup', async (context) => {
  const taskId = 'controlled-lock-parent-failure'
  const { bridge, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  const bridgeHome = join(testHome, '.aamp', 'acp-bridge')
  mkdirSync(bridgeHome, { recursive: true })
  writeFileSync(join(bridgeHome, 'task-locks'), 'not a directory')
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  assert.deepEqual(fakeClient.results.map(({ status }) => status), ['rejected'])
  assert.match(fakeClient.results[0]!.errorMsg ?? '', /ACP task preparation failed/)
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt' || call.method === 'cancel'), false)
  assert.equal(activeTaskSessionCount(bridge), 0)
})

test('failed task-lock owner initialization removes only the newly created lock', async (context) => {
  const taskId = 'controlled-lock-owner-failure'
  const { fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  const lockDir = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`)
  const originalError = new Error('ORIGINAL_OWNER_WRITE_FAILURE')
  const restore = failTaskOwnerWrite(context, join(lockDir, 'owner.json'), originalError)
  try {
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    assert.equal(existsSync(lockDir), false)
    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['rejected'])
    assert.match(fakeClient.results[0]!.errorMsg ?? '', /ORIGINAL_OWNER_WRITE_FAILURE/)
    assert.deepEqual(fakeClient.createdStreams, [])
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
  } finally { restore() }
})

test('task-lock cleanup failure is logged without replacing the original preparation error', async (context) => {
  const taskId = 'controlled-lock-cleanup-failure'
  const { fakeClient, testHome } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  const lockDir = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`)
  const restoreWrite = failTaskOwnerWrite(context, join(lockDir, 'owner.json'), new Error('ORIGINAL_OWNER_FAILURE'))
  const originalRm = fs.rmSync
  const mockedRm = context.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    const [target] = args
    if (String(target) === lockDir) throw new Error('PARTIAL_LOCK_CLEANUP_FAILURE')
    return originalRm(...args)
  })
  const warnings: string[] = []
  const mockedWarn = context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  syncBuiltinESMExports()
  try {
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    assert.equal(existsSync(lockDir), true)
    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['rejected'])
    assert.match(fakeClient.results[0]!.errorMsg ?? '', /ORIGINAL_OWNER_FAILURE/)
    assert.doesNotMatch(fakeClient.results[0]!.errorMsg ?? '', /PARTIAL_LOCK_CLEANUP_FAILURE/)
    assert.ok(warnings.some((warning) => warning.includes('PARTIAL_LOCK_CLEANUP_FAILURE')))
  } finally {
    mockedRm.mock.restore()
    mockedWarn.mock.restore()
    restoreWrite()
    rmSync(lockDir, { recursive: true, force: true })
  }
})

test('an existing task lock and its owner are preserved when acquisition reports EEXIST', async (context) => {
  const taskId = 'controlled-lock-already-owned'
  const { fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId)
  const lockDir = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`)
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'owner.json'), 'existing owner sentinel')
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  assert.equal(readFileSync(join(lockDir, 'owner.json'), 'utf8'), 'existing owner sentinel')
  assert.deepEqual(fakeClient.results, [])
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
})

for (const historical of [false, true]) {
  test(`${historical ? 'nonterminal historical controlled' : 'legacy'} preparation failures ${historical ? 'return rejection' : 'retain no-rejection behavior'}`, async (context) => {
    const taskId = historical ? 'historical-lock-failure' : 'legacy-lock-failure'
    const { bridge, fakeClient, testHome } = await cancellationHarness(context, taskId)
    fakeClient.resultGate.resolve()
    const ownerFile = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`, 'owner.json')
    const restore = failTaskOwnerWrite(context, ownerFile, new Error('LOCAL_PREPARATION_FAILURE'))
    bridge['isHistoricalReconcile'] = historical
    try {
      await fakeClient.emitTaskDispatch(historical ? controlledCancellationTask(taskId) : cancellationTask(taskId))
      assert.deepEqual(fakeClient.results.map(({ status }) => status), historical ? ['rejected'] : [])
      assert.equal(activeTaskSessionCount(bridge), 0)
    } finally { restore() }
  })
}

test('a trusted cancellation winning during failed lock preparation returns cancellation instead of rejection', async (context) => {
  const taskId = 'controlled-lock-cancel-wins'
  const { fakeClient, testHome } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  const ownerFile = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`, 'owner.json')
  let cancel: Promise<void> | undefined
  const restore = failTaskOwnerWrite(context, ownerFile, new Error('LOCAL_PREPARATION_FAILURE'), () => {
    cancel = fakeClient.emitTaskCancel(cancellationEvent(taskId))
  })
  try {
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    await cancel
    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['cancelled'])
  } finally { restore() }
})

test('an uncertain preparation-rejection delivery is not followed by a different terminal result', async (context) => {
  const taskId = 'controlled-lock-rejected-delivery-failure'
  const { fakeClient, testHome } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  fakeClient.resultFailure = new Error('uncertain rejected result delivery')
  const ownerFile = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`, 'owner.json')
  const restore = failTaskOwnerWrite(context, ownerFile, new Error('LOCAL_PREPARATION_FAILURE'))
  try {
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['rejected'])
  } finally { restore() }
})

function replacementTask(taskId: string, executionId: string, createdAt = '1792134000000', sessionKey = 'feishu-task:replacement'): TaskDispatch {
  return cancellationTask(taskId, {
    sessionKey,
    dispatchContext: {
      source: 'feishu-task', execution_id: executionId,
      task_execution_policy: 'replace_previous', task_execution_created_at: createdAt,
      [AAMP_CANCEL_RESULT_CONTEXT_KEY]: 'cancelled',
    },
  })
}

function controlledPromptHarness(fake: FakeAcpxClient) {
  const turns: Array<{
    sessionName: string
    handlers?: AcpPromptHandlers
    result: ReturnType<typeof deferred<AcpResult>>
    cancelled: ReturnType<typeof deferred<{ forced: boolean }>>
    cancelCalls: number
  }> = []
  fake.prompt = async (agent, sessionName, _text, handlers) => {
    fake.calls.push({ method: 'prompt', agent, sessionName })
    const turn = { sessionName, handlers, result: deferred<AcpResult>(), cancelled: deferred<{ forced: boolean }>(), cancelCalls: 0 }
    turns.push(turn)
    handlers?.onControl?.({ cancelAndWait: async () => {
      turn.cancelCalls += 1
      const outcome = await turn.cancelled.promise
      turn.result.resolve({ output: 'stale old result', events: [], streamedAssistantText: false })
      return outcome
    } })
    return await turn.result.promise
  }
  return turns
}

test('controlled new execution waits for targeted cleanup and suppresses the old turn outputs', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-cleanup')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const old = fakeClient.emitTaskDispatch(replacementTask('replace-old', 'execution-old'))
  await until(() => turns.length === 1, 'old prompt must start')
  const replacement = fakeClient.emitTaskDispatch(replacementTask('replace-new', 'execution-new', '1792134001000'))
  await until(() => turns[0]!.cancelCalls === 1, 'new round must cancel the exact old prompt')
  const eventsBefore = fakeClient.streamEvents.length
  turns[0]!.handlers?.onTextChunk?.({ channel: 'assistant', text: 'stale text '.repeat(30) })
  turns[0]!.handlers?.onToolUpdate?.({ title: 'stale tool', status: 'completed' })
  assert.equal(fakeClient.streamEvents.length, eventsBefore)
  assert.equal(turns.length, 1, 'new prompt cannot start while cancel is still pending')
  await fakeClient.emitTaskCancel(cancellationEvent('replace-old'))
  assert.equal(turns[0]!.cancelCalls, 1, 'late task.cancel must not start another session cancel')
  turns[0]!.cancelled.resolve({ forced: false })
  await until(() => turns.length === 2, 'replacement should start after cleanup')
  turns[1]!.result.resolve({ output: 'new result', events: [], streamedAssistantText: false })
  await Promise.all([old, replacement])
  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['replace-new'])
  assert.equal(fakeClient.streamCloses.some((close) => close.streamId === 'stream-replace-old'), false)
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)
})

test('marked new execution can replace an older controlled turn without the new policy field', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-upgrade')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const oldTask = replacementTask('upgrade-old', 'execution-old', '')
  delete oldTask.dispatchContext!.task_execution_policy
  const old = fakeClient.emitTaskDispatch(oldTask)
  await until(() => turns.length === 1, 'old controlled prompt should start')
  const next = fakeClient.emitTaskDispatch(replacementTask('upgrade-next', 'execution-next', '1792134001000'))
  await until(() => turns[0]!.cancelCalls === 1, 'upgrade must identify the old controlled execution')
  turns[0]!.cancelled.resolve({ forced: false })
  await until(() => turns.length === 2, 'replacement should start after cleanup')
  turns[1]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([old, next])
  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['upgrade-next'])
})

test('a superseded turn does not wait for its old in-flight progress request before releasing the session', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-stream-hung')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const oldWrite = deferred<void>()
  let oldWriteStarted = false
  const append = fakeClient.appendStreamEvent.bind(fakeClient)
  fakeClient.appendStreamEvent = async (options) => {
    const event = await append(options)
    if (options.streamId === 'stream-stream-old' && options.type === 'text.delta') {
      oldWriteStarted = true
      await oldWrite.promise
    }
    return event
  }
  const old = fakeClient.emitTaskDispatch(replacementTask('stream-old', 'execution-old'))
  await until(() => turns.length === 1, 'old prompt should start')
  turns[0]!.handlers?.onTextChunk?.({ channel: 'assistant', text: 'old progress '.repeat(20) })
  await until(() => oldWriteStarted, 'old progress request should be in flight')
  // Finish the prompt, leaving the old handler blocked in flushStreamWrites.
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await new Promise((resolve) => setImmediate(resolve))
  const next = fakeClient.emitTaskDispatch(replacementTask('stream-next', 'execution-next', '1792134001000'))
  await until(() => turns.length === 2, 'old network request must not block replacement startup')
  assert.equal(turns[0]!.cancelCalls, 0, 'an already-exited prompt needs no late session cancel')
  turns[1]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([old, next])
  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['stream-next'])
  oldWrite.resolve()
})

test('replacement abandons a superseded hydration request before any ACP prompt starts', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-hydrate-hung')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  fakeClient.gateHydrate = true
  const turns = controlledPromptHarness(fakeAcpx)
  const old = fakeClient.emitTaskDispatch(replacementTask('hydrate-old', 'execution-old'))
  await fakeClient.hydrateStarted.promise
  fakeClient.gateHydrate = false
  const next = fakeClient.emitTaskDispatch(replacementTask('hydrate-next', 'execution-next', '1792134001000'))
  await until(() => turns.length === 1, 'old hydration must not block replacement')
  assert.equal(turns[0]!.cancelCalls, 0)
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([old, next])
  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['hydrate-next'])
  fakeClient.hydrateGate.resolve()
})

test('an unmarked new dispatch or a legacy turn without execution ID is never cancelled by replacement logic', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-no-authority')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const legacyTask = replacementTask('legacy-no-id', 'unused')
  delete legacyTask.dispatchContext!.execution_id
  const legacy = fakeClient.emitTaskDispatch(legacyTask)
  await until(() => turns.length === 1, 'legacy prompt should start')
  const nextTask = replacementTask('no-policy', 'execution-next', '1792134001000')
  delete nextTask.dispatchContext!.task_execution_policy
  const next = fakeClient.emitTaskDispatch(nextTask)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.cancelCalls, 0)
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await until(() => turns.length === 2, 'ordinary session serialization remains')
  turns[1]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([legacy, next])
})

test('same execution comments queue without cancellation and another Task can run independently', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-same-round')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const first = fakeClient.emitTaskDispatch(replacementTask('same-first', 'execution-same'))
  await until(() => turns.length === 1, 'first prompt should start')
  const comment = fakeClient.emitTaskDispatch(replacementTask('same-comment', 'execution-same'))
  const other = fakeClient.emitTaskDispatch(replacementTask('other-task', 'execution-other', '1792134001000', 'feishu-task:other'))
  await until(() => turns.length === 2, 'different Task should start without waiting')
  assert.equal(turns[0]!.cancelCalls, 0)
  assert.notEqual(turns[0]!.sessionName, turns[1]!.sessionName)
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  turns[1]!.result.resolve(fakeAcpx.promptResult)
  await until(() => turns.length === 3, 'same execution comment should start after first prompt')
  assert.equal(turns[2]!.sessionName, turns[0]!.sessionName)
  assert.equal(turns[2]!.cancelCalls, 0)
  turns[2]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([first, comment, other])
})

test('older or undated different executions cannot replace the latest timestamped round', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-stale')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const newest = fakeClient.emitTaskDispatch(replacementTask('latest-round', 'execution-latest', '1792134002000'))
  await until(() => turns.length === 1, 'latest prompt should start')
  await fakeClient.emitTaskDispatch(replacementTask('older-round', 'execution-older', '1792134001000'))
  await fakeClient.emitTaskDispatch(replacementTask('undated-round', 'execution-undated', ''))
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.cancelCalls, 0)
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await newest
})

test('bounded execution history eviction cannot let a stale dispatch replace a live newer round', async (context) => {
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-live-history')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const live = fakeClient.emitTaskDispatch(replacementTask('history-live', 'execution-newest', '1792134002000'))
  await until(() => turns.length === 1, 'live newest execution should start')
  for (let index = 0; index < 257; index += 1) {
    const key = `other-dispatcher\nfeishu-task:evict-${index}`
    bridge['latestControlledExecutions'].set(key, { key, executionId: `evict-${index}`, replacePrevious: true })
  }
  await fakeClient.emitTaskDispatch(replacementTask('history-stale', 'execution-stale', '1792134001000'))
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.cancelCalls, 0)
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await live
})

test('forced replacement retains the fresh ACP session for same-execution continuation', async (context) => {
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-fresh-session')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const old = fakeClient.emitTaskDispatch(replacementTask('force-old', 'execution-old'))
  await until(() => turns.length === 1, 'old prompt should start')
  const next = fakeClient.emitTaskDispatch(replacementTask('force-next', 'execution-next', '1792134001000'))
  await until(() => turns[0]!.cancelCalls === 1, 'old prompt should be cancelled')
  turns[0]!.cancelled.resolve({ forced: true })
  await until(() => turns.length === 2, 'new prompt should start in a fresh session')
  assert.notEqual(turns[1]!.sessionName, turns[0]!.sessionName)
  turns[1]!.result.resolve(fakeAcpx.promptResult)
  await Promise.all([old, next])
  for (let index = 0; index < 257; index += 1) {
    bridge['replacementSessionNames'].set(`another-task-${index}`, `another-session-${index}`)
  }
  const comment = fakeClient.emitTaskDispatch(replacementTask('force-comment', 'execution-next', '1792134001000'))
  await until(() => turns.length === 3, 'comment should continue')
  assert.equal(turns[2]!.sessionName, turns[1]!.sessionName)
  turns[2]!.result.resolve(fakeAcpx.promptResult)
  await comment
})

test('failed targeted termination rejects the replacement instead of starting concurrently', async (context) => {
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, 'replace-failure')
  releaseCancellationGates(fakeClient, fakeAcpx)
  const turns = controlledPromptHarness(fakeAcpx)
  const old = fakeClient.emitTaskDispatch(replacementTask('failure-old', 'execution-old'))
  await until(() => turns.length === 1, 'old prompt should start')
  const next = fakeClient.emitTaskDispatch(replacementTask('failure-next', 'execution-next', '1792134001000'))
  await until(() => turns[0]!.cancelCalls === 1, 'old prompt should be cancelled')
  turns[0]!.cancelled.reject(new Error('targeted process did not exit'))
  await next
  assert.equal(turns.length, 1, 'unsafe session must not run a new prompt')
  assert.equal(fakeClient.results[0]?.taskId, 'failure-next')
  assert.equal(fakeClient.results[0]?.status, 'rejected')
  turns[0]!.result.resolve(fakeAcpx.promptResult)
  await old.catch(() => {})
  await fakeClient.emitTaskDispatch(replacementTask('failure-retry', 'execution-retry', '1792134002000'))
  assert.equal(turns.length, 1)
})

test('cancel during hydration wins before unauthorized rejection side effects', async (context) => {
  const taskId = 'cancel-during-hydrate-unauthorized'
  const { bridge, events, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId, {
    senderPolicies: [{ sender: 'allowed@example.com' }],
  })
  fakeClient.gateHydrate = true
  fakeClient.resultGate.resolve()
  fakeClient.helpGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId, {
    from: 'intruder@example.com',
  }))

  try {
    await fakeClient.hydrateStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeClient.hydrateGate.resolve()
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(fakeClient.createdStreams, [])
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
    assert.equal(bridge.isBusy, false)
    assert.equal(existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks')), false)
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('cancel during hydration wins before attachment rejection side effects', async (context) => {
  const taskId = 'cancel-during-hydrate-attachment'
  const { bridge, events, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId, {
    attachmentPolicy: 'reject',
  })
  fakeClient.gateHydrate = true
  fakeClient.resultGate.resolve()
  fakeClient.helpGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId, {
    attachments: [{
      filename: 'requirements.txt',
      contentType: 'text/plain',
      size: 24,
      blobId: `blob-${taskId}`,
    }],
  }))

  try {
    await fakeClient.hydrateStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeClient.hydrateGate.resolve()
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(fakeClient.downloadedBlobs, [])
    assert.deepEqual(fakeClient.createdStreams, [])
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
    assert.equal(bridge.isBusy, false)
    assert.equal(existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks')), false)
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

type TerminalOutcome = 'completed' | 'help_needed' | 'rejected'

async function assertTerminalClaimBeatsCancel(
  context: TestContext,
  outcome: TerminalOutcome,
  gate: 'close' | 'send',
  closeFailure?: Error,
): Promise<void> {
  const taskId = `terminal-${outcome}-${gate}`
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.closeFailure = closeFailure
  if (outcome === 'help_needed') {
    fakeAcpx.promptResult = {
      output: 'HELP: Please provide the missing decision.',
      events: [],
      streamedAssistantText: false,
    }
  } else if (outcome === 'rejected') {
    fakeAcpx.promptFailure = new Error('ACP terminal failure')
  }

  if (gate === 'close') {
    if (outcome === 'help_needed') fakeClient.helpGate.resolve()
    else fakeClient.resultGate.resolve()
  } else {
    fakeClient.streamCloseGate.resolve()
  }

  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))
  try {
    if (gate === 'close') {
      await fakeClient.streamCloseStarted.promise
    } else if (outcome === 'help_needed') {
      await until(() => fakeClient.helps.length === 1, 'help send must reach its gate')
    } else {
      await fakeClient.resultStarted.promise
    }

    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.deepEqual(
      fakeAcpx.calls.filter((call) => call.method === 'cancel'),
      [],
      'a terminal-claimed task must ignore later cancellation',
    )

    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch

    const expectedClosePayload = outcome === 'completed'
      ? { reason: 'task.result', status: 'completed' }
      : outcome === 'help_needed'
        ? { reason: 'task.help_needed' }
        : { reason: 'task.result', status: 'rejected', error: 'ACP terminal failure' }
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: expectedClosePayload,
    }])
    if (outcome === 'help_needed') {
      assert.equal(fakeClient.helps.length, 1)
      assert.deepEqual(fakeClient.results, [])
    } else {
      assert.equal(fakeClient.results.length, 1)
      assert.equal(fakeClient.results[0]?.status, outcome)
      assert.deepEqual(fakeClient.helps, [])
    }
    assert.deepEqual(events.filter((event) => event.type === 'task.completed'), [{
      type: 'task.completed',
      bridge: 'acp-bridge',
      agent: 'remote-agent',
      email: 'agent@meshmail.test',
      taskId,
      status: outcome,
    }])
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
}

test('completed close uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'completed', 'close')
})

test('completed send uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'completed', 'send')
})

test('help close uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'help_needed', 'close')
})

test('help send uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'help_needed', 'send')
})

test('rejected close uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'rejected', 'close')
})

test('rejected send uses an atomic terminal claim against cancellation', async (context) => {
  await assertTerminalClaimBeatsCancel(context, 'rejected', 'send')
})

for (const outcome of ['completed', 'help_needed', 'rejected'] as const) {
  test(`${outcome} is delivered once after stream close 429 despite a late cancel`, async (context) => {
    await assertTerminalClaimBeatsCancel(context, outcome, 'close', new Error('AAMP stream close failed: 429 Too Many Requests'))
  })
}

for (const phase of [
  { name: 'startup', summary: undefined },
  { name: 'before-prompt', summary: 'Prompt sent to ACP agent' },
  { name: 'after-response', summary: 'ACP response received' },
]) {
  test(`stream append 429 ${phase.name} does not prevent the final result`, async (context) => {
    const taskId = `append-rate-limited-${phase.name}`
    const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
    fakeClient.appendFailure = new Error('AAMP stream append failed: 429 Too Many Requests')
    fakeClient.appendFailureSummary = phase.summary
    fakeClient.streamCloseGate.resolve()
    fakeClient.resultGate.resolve()

    await fakeClient.emitTaskDispatch(cancellationTask(taskId))

    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
    assert.equal(fakeClient.results.length, 1)
    assert.equal(fakeClient.results[0]?.status, 'completed')
    assert.equal(fakeClient.results[0]?.output, 'remote agent response')
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(fakeClient.streamCloses, [])
    if (phase.summary) assert.equal(fakeClient.streamEvents.at(-1)?.payload.summary, phase.summary)
    else assert.equal(fakeClient.streamEvents.length, 1)
    assert.deepEqual(events.filter((event) => event.type === 'task.completed').map((event) => event.status), ['completed'])
  })
}

for (const code of [401, 403, 500]) {
  test(`stream append ${code} retains the rejected outcome`, async (context) => {
    const taskId = `append-failed-${code}`
    const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
    fakeClient.appendFailure = new Error(`AAMP stream append failed: ${code} failure`)
    fakeClient.streamCloseGate.resolve()
    fakeClient.resultGate.resolve()

    await fakeClient.emitTaskDispatch(cancellationTask(taskId))

    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
    assert.equal(fakeClient.results.length, 1)
    assert.equal(fakeClient.results[0]?.status, 'rejected')
    assert.match(fakeClient.results[0]?.errorMsg ?? '', new RegExp(`stream append failed: ${code}`))
    assert.deepEqual(events.filter((event) => event.type === 'task.completed').map((event) => event.status), ['rejected'])
  })
}

test('queued progress append 429 disables later progress without losing the result', async (context) => {
  const taskId = 'queued-append-rate-limited'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const prompt = fakeAcpx.prompt.bind(fakeAcpx)
  fakeAcpx.prompt = async (agent, sessionName, text, handlers) => {
    fakeClient.appendFailure = new Error('AAMP stream append failed: 429 Too Many Requests')
    handlers?.onPlanUpdate?.([{ content: 'working', status: 'in_progress', priority: 'medium' }])
    return prompt(agent, sessionName, text, handlers)
  }

  await fakeClient.emitTaskDispatch(cancellationTask(taskId))

  assert.equal(fakeClient.results.length, 1)
  assert.equal(fakeClient.results[0]?.status, 'completed')
  assert.deepEqual(fakeClient.streamEvents.at(-1)?.payload, {
    items: [{ id: 'plan-1', content: 'working', status: 'in_progress' }],
  })
  assert.deepEqual(fakeClient.streamCloses, [])
  assert.deepEqual(events.filter((event) => event.type === 'task.completed').map((event) => event.status), ['completed'])
})

test('failed claimed completed send does not fall back to a rejected outcome', async (context) => {
  const taskId = 'terminal-send-failure'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  fakeClient.resultFailure = new Error('result transport failed')
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await dispatch

    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: { reason: 'task.result', status: 'completed' },
    }])
    assert.equal(fakeClient.results.length, 1)
    assert.equal(fakeClient.results[0]?.status, 'completed')
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(events.filter((event) => event.type === 'task.completed'), [])
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('failed claimed completed close still sends the claimed result without a fallback outcome', async (context) => {
  const taskId = 'terminal-close-failure'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.closeFailure = new Error('stream close transport failed')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await dispatch

    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: { reason: 'task.result', status: 'completed' },
    }])
    assert.equal(fakeClient.results.length, 1)
    assert.equal(fakeClient.results[0]?.status, 'completed')
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(events.filter((event) => event.type === 'task.completed').map((event) => event.status), ['completed'])
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('failed claimed help send does not retry or fall back to a result', async (context) => {
  const taskId = 'terminal-help-send-failure'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.promptResult = {
    output: 'HELP: Please provide the missing decision.',
    events: [],
    streamedAssistantText: false,
  }
  fakeClient.helpFailure = new Error('help transport failed')
  fakeClient.streamCloseGate.resolve()
  fakeClient.helpGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await dispatch

    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: { reason: 'task.help_needed' },
    }])
    assert.equal(fakeClient.helps.length, 1)
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(events.filter((event) => event.type === 'task.completed'), [])
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('failed claimed rejected send does not retry or emit a terminal event', async (context) => {
  const taskId = 'terminal-rejected-send-failure'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.promptFailure = new Error('ACP terminal failure')
  fakeClient.resultFailure = new Error('result transport failed')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await dispatch

    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: { reason: 'task.result', status: 'rejected', error: 'ACP terminal failure' },
    }])
    assert.equal(fakeClient.results.length, 1)
    assert.equal(fakeClient.results[0]?.status, 'rejected')
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(events.filter((event) => event.type === 'task.completed'), [])
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('active task cancellation forwards the exact ACP session and drops a later success', async (context) => {
  const taskId = 'active-success'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))

    assert.deepEqual(fakeAcpx.calls.filter((call) => call.method === 'cancel'), [{
      method: 'cancel',
      agent: 'remote-agent --acp',
      sessionName: 'aamp-remote-agent-conversation:active-success',
    }])

    fakeAcpx.promptGate.resolve({
      output: 'success that must be dropped',
      events: [],
      streamedAssistantText: false,
    })
    await dispatch

    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-active-success',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.helps, [])
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('controlled cancellation reports one terminal result after ACP settles and the stream closes', async (context) => {
  const taskId = 'controlled-active-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeAcpx.gateCancel = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    const cancel = fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeAcpx.promptGate.resolve({ output: 'late success must be suppressed', events: [], streamedAssistantText: false })
    assert.deepEqual(fakeClient.results, [], 'cancel forwarding has not completed')
    fakeAcpx.cancelGate.resolve()
    await cancel
    await dispatch

    assert.deepEqual(fakeClient.results, [{
      to: 'sender@example.com',
      taskId,
      status: 'cancelled',
      output: '',
      inReplyTo: `<${taskId}@example.com>`,
    }])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('controlled cancellation still delivers only cancelled when stream close is rate limited', async (context) => {
  const taskId = 'controlled-cancel-close-rate-limited'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeClient.closeFailure = new Error('AAMP stream close failed: 429 Too Many Requests')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeAcpx.promptGate.resolve({ output: 'late success must be suppressed', events: [], streamedAssistantText: false })
    await dispatch

    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['cancelled'])
    assert.equal(fakeClient.results[0]?.output, '')
    assert.deepEqual(fakeClient.helps, [])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('controlled STOP before START reports cancellation without starting ACP', async (context) => {
  const taskId = 'controlled-early-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))

  assert.deepEqual(fakeClient.results.map((result) => result.status), ['cancelled'])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
})

test('controlled cancel already in the current dispatch history returns cancelled once without ACP startup', async (context) => {
  const taskId = 'controlled-history-cancel'
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  fakeClient.threadHistory = [historyEvent('task.cancel', ' SENDER@example.com ', 'AGENT@meshmail.test')]
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  assert.deepEqual(fakeClient.results.map(({ status, taskId }) => ({ status, taskId })), [{ status: 'cancelled', taskId }])
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt' || call.method === 'cancel'), false)
  assert.equal(activeTaskSessionCount(bridge), 0)
})

test('controlled cancel during hydration still returns one cancelled receipt on the early return', async (context) => {
  const taskId = 'controlled-hydration-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.gateHydrate = true
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.hydrateStarted.promise
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  fakeClient.hydrateGate.resolve()
  await dispatch
  assert.deepEqual(fakeClient.results.map(({ status }) => status), ['cancelled'])
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt' || call.method === 'cancel'), false)
})

test('controlled cancellation while waiting for the session mutex reports only the queued turn cancelled', async (context) => {
  const firstId = 'controlled-mutex-owner'
  const nextId = 'controlled-mutex-queued'
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, firstId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const first = fakeClient.emitTaskDispatch(controlledCancellationTask(firstId))
  await fakeAcpx.promptStarted.promise
  const queuedTask = controlledCancellationTask(nextId)
  queuedTask.sessionKey = `conversation:${firstId}`
  const queued = fakeClient.emitTaskDispatch(queuedTask)
  await until(() => [...sessionMutexQueues(bridge).values()].some((queue) => queue.length === 1), 'second turn should wait for the session mutex')
  await fakeClient.emitTaskCancel(cancellationEvent(nextId))
  await queued
  assert.deepEqual(fakeClient.results.map(({ taskId, status }) => ({ taskId, status })), [{ taskId: nextId, status: 'cancelled' }])
  assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)
  fakeAcpx.promptGate.resolve(fakeAcpx.promptResult)
  await first
})

for (const intent of ['task.result', 'task.help_needed'] as const) {
  test(`a historical ${intent} prevents a later cancel from producing a conflicting receipt`, async (context) => {
    const taskId = `controlled-history-${intent}`
    const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
    fakeClient.resultGate.resolve()
    fakeClient.threadHistory = [historyEvent(intent, 'agent@meshmail.test', 'sender@example.com'), historyEvent('task.cancel')]
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.deepEqual(fakeClient.results, [])
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt' || call.method === 'cancel'), false)
  })
}

for (const [name, from, to] of [
  ['foreign-sender', 'intruder@example.com', 'agent@meshmail.test'],
  ['foreign-recipient', 'sender@example.com', 'different-agent@meshmail.test'],
] as const) {
  test(`controlled history cancel from ${name} cannot suppress the dispatch or return cancellation`, async (context) => {
    const taskId = `controlled-history-${name}`
    const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
    fakeClient.streamCloseGate.resolve()
    fakeClient.resultGate.resolve()
    fakeClient.threadHistory = [historyEvent('task.cancel', from, to)]
    await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
    assert.deepEqual(fakeClient.results.map(({ status }) => status), ['completed'])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
  })
}

test('failed controlled cancel result delivery is attempted once and still releases local registration', async (context) => {
  const taskId = 'controlled-history-cancel-delivery-failure'
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.resultGate.resolve()
  fakeClient.resultFailure = new Error('uncertain cancellation result delivery')
  fakeClient.threadHistory = [historyEvent('task.cancel')]
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  assert.deepEqual(fakeClient.results.map(({ status }) => status), ['cancelled'])
  assert.equal(activeTaskSessionCount(bridge), 0)
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
})

test('controlled task ignores an early cancellation from another sender', async (context) => {
  const taskId = 'controlled-unrelated-early-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  releaseCancellationGates(fakeClient, fakeAcpx)

  await fakeClient.emitTaskCancel({ ...cancellationEvent(taskId), from: 'other@example.com' })
  await fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))

  assert.deepEqual(fakeClient.results.map((result) => result.status), ['completed'])
  assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
})

test('controlled active task ignores a cancellation from another sender', async (context) => {
  const taskId = 'controlled-unrelated-active-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel({ ...cancellationEvent(taskId), from: 'other@example.com' })
    fakeAcpx.promptGate.resolve({ output: 'normal completion', events: [], streamedAssistantText: false })
    await dispatch

    assert.deepEqual(fakeClient.results.map((result) => result.status), ['completed'])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 0)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('controlled cancellation does not claim a terminal result if ACP cancellation fails', async (context) => {
  const taskId = 'controlled-cancel-forward-failure'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeAcpx.cancelFailure = new Error('cancel transport unavailable')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(controlledCancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeAcpx.promptGate.resolve({
      output: 'late success after failed cancellation',
      events: [],
      streamedAssistantText: false,
    })
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: `stream-${taskId}`,
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('last cancellation check and prompt start form one synchronous cancellation boundary', async (context) => {
  const taskId = 'cancel-at-prompt-boundary'
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.gatePromptAppend = true
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  let scheduledCancel: Promise<void> | undefined
  let cancelScheduled = false
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await fakeClient.promptAppendStarted.promise
    const active = (bridge as unknown as {
      activeTaskSessions: Map<string, { phase: 'active' | 'cancelled' | 'terminal' }>
    }).activeTaskSessions.get(taskId)
    assert.ok(active)
    let phase = active.phase
    Object.defineProperty(active, 'phase', {
      configurable: true,
      get: () => {
        if (!cancelScheduled) {
          cancelScheduled = true
          queueMicrotask(() => {
            scheduledCancel = fakeClient.emitTaskCancel(cancellationEvent(taskId))
          })
        }
        return phase
      },
      set: (value: typeof phase) => {
        phase = value
      },
    })
    fakeClient.promptAppendGate.resolve()
    await fakeAcpx.promptStarted.promise
    await until(() => scheduledCancel !== undefined, 'the injected boundary cancellation must run')
    await scheduledCancel

    assert.deepEqual(fakeAcpx.calls.filter((call) => call.method === 'cancel'), [{
      method: 'cancel',
      agent: 'remote-agent --acp',
      sessionName: 'aamp-remote-agent-conversation:cancel-at-prompt-boundary',
    }])

    fakeAcpx.promptGate.resolve({
      output: 'late success after boundary cancellation',
      events: [],
      streamedAssistantText: false,
    })
    await dispatch
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-cancel-at-prompt-boundary',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await scheduledCancel?.catch(() => undefined)
    await dispatch.catch(() => undefined)
  }
})

test('duplicate active cancel events forward at most once while cancellation is pending', async (context) => {
  const taskId = 'duplicate-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeAcpx.gateCancel = true
  fakeClient.streamCloseGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))
  let firstCancelSettled = false
  let firstCancel: Promise<void> | undefined

  try {
    await fakeAcpx.promptStarted.promise
    firstCancel = fakeClient.emitTaskCancel(cancellationEvent(taskId)).finally(() => {
      firstCancelSettled = true
    })
    await until(
      () => fakeAcpx.calls.filter((call) => call.method === 'cancel').length === 1,
      'the first active cancellation must reach acpx.cancel',
    )
    assert.equal(firstCancelSettled, false, 'the test emitter must await cancellation forwarding')

    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)

    fakeAcpx.cancelGate.resolve()
    await firstCancel
    fakeAcpx.promptGate.resolve({
      output: 'late success',
      events: [],
      streamedAssistantText: false,
    })
    await dispatch
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await firstCancel?.catch(() => undefined)
    await dispatch.catch(() => undefined)
  }
})

test('cancellation before prompt start skips prompt and closes an opened stream as cancelled', async (context) => {
  const taskId = 'cancel-before-prompt'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gateEnsureSession = true
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await until(
      () => fakeAcpx.calls.some((call) => call.method === 'ensureSession'),
      'the task must reach its gated ensureSession call',
    )
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)

    fakeAcpx.ensureSessionGate.resolve()
    await until(
      () => fakeClient.streamCloses.length > 0 || fakeAcpx.calls.some((call) => call.method === 'prompt'),
      'the task must either close its stream or incorrectly start prompt',
    )

    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
    await dispatch
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-cancel-before-prompt',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
    assert.deepEqual(fakeClient.results, [])
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('cancel after task cleanup does not target a stale ACP session', async (context) => {
  const taskId = 'cancel-after-cleanup'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskDispatch(cancellationTask(taskId))
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))

  assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)
  assert.equal(fakeClient.results[0]?.status, 'completed')
})

test('late cancel after cleanup keeps the unique task lifecycle tombstoned', async (context) => {
  const taskId = 'late-cancel-settled-task-id'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskDispatch(cancellationTask(taskId))
  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  await fakeClient.emitTaskDispatch(cancellationTask(taskId, {
    messageId: `<${taskId}-second@example.com>`,
    bodyText: 'This invalid dispatch attempts to reuse a completed task id.',
  }))

  assert.deepEqual(fakeClient.results.map((result) => result.status), ['completed'])
  assert.equal(fakeClient.hydratedDispatches.length, 1)
  assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)
})

test('settled task id drops a different message and then the original replay before hydration', async (context) => {
  const taskId = 'settled-task-lifecycle'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const original = cancellationTask(taskId)
  const reused = cancellationTask(taskId, {
    messageId: `<${taskId}-different@example.com>`,
    bodyText: 'A task id is unique even when a later email has different content.',
  })

  await fakeClient.emitTaskDispatch(original)
  await fakeClient.emitTaskDispatch(reused)
  await fakeClient.emitTaskDispatch(original)

  assert.equal(fakeClient.results.length, 1)
  assert.deepEqual(fakeClient.hydratedDispatches, [{
    taskId,
    messageId: original.messageId,
  }])
  assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
})

test('unknown early cancel consumes one lifecycle and tombstones all later messages for its task id', async (context) => {
  const taskId = 'unknown-early-cancel'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const firstDelivery = cancellationTask(taskId)

  await fakeClient.emitTaskCancel(cancellationEvent(taskId))
  await fakeClient.emitTaskDispatch(firstDelivery)
  await fakeClient.emitTaskDispatch(firstDelivery)
  assert.equal(fakeClient.results.length, 0)
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)

  await fakeClient.emitTaskDispatch(cancellationTask(taskId, {
    messageId: `<${taskId}-new@example.com>`,
  }))
  assert.deepEqual(fakeClient.results, [])
  assert.deepEqual(fakeClient.hydratedDispatches, [])
  assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
})

test('active duplicate and delayed cancel cannot affect a new task id in the same session', async (context) => {
  const activeTaskId = 'active-unique-lifecycle'
  const nextTaskId = 'next-unique-lifecycle'
  const sharedSessionKey = 'conversation:shared-lifecycle-session'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, activeTaskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const activeDispatch = fakeClient.emitTaskDispatch(cancellationTask(activeTaskId, {
    sessionKey: sharedSessionKey,
  }))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskDispatch(cancellationTask(activeTaskId, {
      sessionKey: sharedSessionKey,
      messageId: `<${activeTaskId}-invalid-reuse@example.com>`,
    }))
    assert.deepEqual(fakeClient.hydratedDispatches.map((task) => task.taskId), [activeTaskId])

    fakeAcpx.promptGate.resolve({
      output: 'first lifecycle completed',
      events: [],
      streamedAssistantText: false,
    })
    await activeDispatch
    await fakeClient.emitTaskCancel(cancellationEvent(activeTaskId))

    fakeAcpx.gatePrompt = false
    await fakeClient.emitTaskDispatch(cancellationTask(nextTaskId, {
      sessionKey: sharedSessionKey,
      messageId: `<${nextTaskId}@example.com>`,
    }))

    assert.deepEqual(fakeClient.results.map((result) => result.taskId), [activeTaskId, nextTaskId])
    assert.deepEqual(fakeClient.hydratedDispatches.map((task) => task.taskId), [activeTaskId, nextTaskId])
    assert.deepEqual(fakeAcpx.calls.filter((call) => call.method === 'cancel'), [])
    assert.deepEqual(
      fakeAcpx.calls.filter((call) => call.method === 'prompt').map((call) => call.sessionName),
      [
        'aamp-remote-agent-conversation:shared-lifecycle-session',
        'aamp-remote-agent-conversation:shared-lifecycle-session',
      ],
    )
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await activeDispatch.catch(() => undefined)
  }
})

test('different task ids sharing one ACP session wait before stream and session mutation', async (context) => {
  const firstTaskId = 'shared-session-first'
  const secondTaskId = 'shared-session-second'
  const sharedSessionKey = 'conversation:serialized-acp-session'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, firstTaskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const firstDispatch = fakeClient.emitTaskDispatch(cancellationTask(firstTaskId, {
    sessionKey: sharedSessionKey,
  }))
  let secondDispatch: Promise<void> | undefined

  try {
    await fakeAcpx.promptStarted.promise
    secondDispatch = fakeClient.emitTaskDispatch(cancellationTask(secondTaskId, {
      sessionKey: sharedSessionKey,
    }))
    await until(
      () => fakeClient.hydratedDispatches.some((dispatch) => dispatch.taskId === secondTaskId),
      'the second lifecycle must finish hydration before waiting for the shared ACP session',
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(fakeClient.createdStreams.map((stream) => stream.taskId), [firstTaskId])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'ensureSession').length, 1)
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)

    fakeAcpx.gatePrompt = false
    fakeAcpx.promptGate.resolve({
      output: 'first shared-session lifecycle completed',
      events: [],
      streamedAssistantText: false,
    })
    await firstDispatch
    await secondDispatch

    assert.deepEqual(fakeClient.results.map((result) => result.taskId), [firstTaskId, secondTaskId])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'ensureSession').length, 2)
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 2)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await firstDispatch.catch(() => undefined)
    await secondDispatch?.catch(() => undefined)
  }
})

test('cancelled waiter never cancels or enters its shared ACP session', async (context) => {
  const activeTaskId = 'shared-session-active-for-waiter-cancel'
  const waitingTaskId = 'shared-session-cancelled-waiter'
  const sharedSessionKey = 'conversation:cancelled-waiter-session'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, activeTaskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const activeDispatch = fakeClient.emitTaskDispatch(cancellationTask(activeTaskId, {
    sessionKey: sharedSessionKey,
  }))
  let waitingDispatch: Promise<void> | undefined

  try {
    await fakeAcpx.promptStarted.promise
    waitingDispatch = fakeClient.emitTaskDispatch(cancellationTask(waitingTaskId, {
      sessionKey: sharedSessionKey,
    }))
    await until(
      () => fakeClient.hydratedDispatches.some((dispatch) => dispatch.taskId === waitingTaskId),
      'the waiting lifecycle must finish hydration before cancellation',
    )
    await new Promise((resolve) => setImmediate(resolve))
    await fakeClient.emitTaskCancel(cancellationEvent(waitingTaskId))

    assert.deepEqual(fakeAcpx.calls.filter((call) => call.method === 'cancel'), [])

    fakeAcpx.gatePrompt = false
    fakeAcpx.promptGate.resolve({
      output: 'active lifecycle remains unaffected',
      events: [],
      streamedAssistantText: false,
    })
    await activeDispatch
    await waitingDispatch

    assert.deepEqual(fakeClient.createdStreams.map((stream) => stream.taskId), [activeTaskId])
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'ensureSession').length, 1)
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
    assert.deepEqual(fakeClient.results.map((result) => result.taskId), [activeTaskId])
    assert.equal(events.some((event) => (
      (event.type === 'task.completed' || event.type === 'task.rejected')
      && event.taskId === waitingTaskId
    )), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await activeDispatch.catch(() => undefined)
    await waitingDispatch?.catch(() => undefined)
  }
})

test('active cancel releases its shared ACP session only after cancelled cleanup', async (context) => {
  const activeTaskId = 'shared-session-active-cancel'
  const waitingTaskId = 'shared-session-wait-after-cancel'
  const sharedSessionKey = 'conversation:active-cancel-session'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, activeTaskId)
  fakeAcpx.gatePrompt = true
  fakeClient.resultGate.resolve()
  const activeDispatch = fakeClient.emitTaskDispatch(cancellationTask(activeTaskId, {
    sessionKey: sharedSessionKey,
  }))
  let waitingDispatch: Promise<void> | undefined

  try {
    await fakeAcpx.promptStarted.promise
    waitingDispatch = fakeClient.emitTaskDispatch(cancellationTask(waitingTaskId, {
      sessionKey: sharedSessionKey,
    }))
    await until(
      () => fakeClient.hydratedDispatches.some((dispatch) => dispatch.taskId === waitingTaskId),
      'the second lifecycle must wait on the active shared session',
    )
    await new Promise((resolve) => setImmediate(resolve))
    await fakeClient.emitTaskCancel(cancellationEvent(activeTaskId))

    assert.deepEqual(fakeAcpx.calls.filter((call) => call.method === 'cancel'), [{
      method: 'cancel',
      agent: 'remote-agent --acp',
      sessionName: 'aamp-remote-agent-conversation:active-cancel-session',
    }])

    fakeAcpx.promptGate.resolve({
      output: 'late active result must be dropped',
      events: [],
      streamedAssistantText: false,
    })
    await until(
      () => fakeClient.streamCloses.some((close) => (
        close.streamId === `stream-${activeTaskId}`
        && close.payload?.reason === 'task.cancelled'
      )),
      'the active lifecycle must reach its gated cancelled stream close',
    )

    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 1)
    assert.deepEqual(fakeClient.createdStreams.map((stream) => stream.taskId), [activeTaskId])

    fakeAcpx.gatePrompt = false
    fakeClient.streamCloseGate.resolve()
    await activeDispatch
    await waitingDispatch

    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'prompt').length, 2)
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)
    assert.deepEqual(fakeClient.results.map((result) => result.taskId), [waitingTaskId])
    assert.equal(events.some((event) => (
      (event.type === 'task.completed' || event.type === 'task.rejected')
      && event.taskId === activeTaskId
    )), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await activeDispatch.catch(() => undefined)
    await waitingDispatch?.catch(() => undefined)
  }
})

test('different ACP sessions can enter prompt concurrently', async (context) => {
  const firstTaskId = 'parallel-session-first'
  const secondTaskId = 'parallel-session-second'
  const { fakeClient, fakeAcpx } = await cancellationHarness(context, firstTaskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const firstDispatch = fakeClient.emitTaskDispatch(cancellationTask(firstTaskId, {
    sessionKey: 'conversation:parallel-session-one',
  }))
  const secondDispatch = fakeClient.emitTaskDispatch(cancellationTask(secondTaskId, {
    sessionKey: 'conversation:parallel-session-two',
  }))

  try {
    await until(
      () => fakeAcpx.calls.filter((call) => call.method === 'prompt').length === 2,
      'different ACP sessions must both enter prompt while the first is gated',
    )
    assert.equal(new Set(
      fakeAcpx.calls.filter((call) => call.method === 'prompt').map((call) => call.sessionName),
    ).size, 2)
    assert.deepEqual(
      new Set(fakeClient.createdStreams.map((stream) => stream.taskId)),
      new Set([firstTaskId, secondTaskId]),
    )

    fakeAcpx.gatePrompt = false
    fakeAcpx.promptGate.resolve({
      output: 'parallel session result',
      events: [],
      streamedAssistantText: false,
    })
    await Promise.all([firstDispatch, secondDispatch])
    assert.deepEqual(
      new Set(fakeClient.results.map((result) => result.taskId)),
      new Set([firstTaskId, secondTaskId]),
    )
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await Promise.all([firstDispatch.catch(() => undefined), secondDispatch.catch(() => undefined)])
  }
})

test('stop aborts a queued shared-session waiter without waiting for the holder', async (context) => {
  const holderTaskId = 'stop-session-holder'
  const waiterTaskId = 'stop-session-waiter'
  const sharedSessionKey = 'conversation:stop-shared-session'
  const { bridge, events, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, holderTaskId)
  fakeClient.resultGate.resolve()
  const holderDispatch = fakeClient.emitTaskDispatch(cancellationTask(holderTaskId, {
    sessionKey: sharedSessionKey,
  }))
  let waiterDispatch: Promise<void> | undefined
  let waiterSettledBeforeHolderRelease = false
  let waiterLockBeforeHolderRelease = true
  let queuedWaitersBeforeHolderRelease = -1
  let callsBeforeHolderRelease: typeof fakeAcpx.calls = []
  let streamsBeforeHolderRelease: typeof fakeClient.createdStreams = []

  try {
    await fakeClient.streamCloseStarted.promise
    waiterDispatch = fakeClient.emitTaskDispatch(cancellationTask(waiterTaskId, {
      sessionKey: sharedSessionKey,
    }))
    const waiterLock = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${waiterTaskId}.lock`)
    await until(
      () => existsSync(waiterLock) && [...sessionMutexQueues(bridge).values()].some((queue) => queue.length === 1),
      'the second lifecycle must hold its task lock while queued on the shared session',
    )

    const stop = bridge.stop()
    assert.equal(await settlesWithin(stop), true, 'stop must not wait for the terminal stream holder')
    await stop
    waiterSettledBeforeHolderRelease = await settlesWithin(waiterDispatch)
    waiterLockBeforeHolderRelease = existsSync(waiterLock)
    queuedWaitersBeforeHolderRelease = [...sessionMutexQueues(bridge).values()]
      .reduce((total, queue) => total + queue.length, 0)
    callsBeforeHolderRelease = [...fakeAcpx.calls]
    streamsBeforeHolderRelease = [...fakeClient.createdStreams]
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await holderDispatch.catch(() => undefined)
    await waiterDispatch?.catch(() => undefined)
  }

  assert.equal(waiterSettledBeforeHolderRelease, true)
  assert.equal(waiterLockBeforeHolderRelease, false)
  assert.equal(queuedWaitersBeforeHolderRelease, 0)
  assert.deepEqual(streamsBeforeHolderRelease.map((stream) => stream.taskId), [holderTaskId])
  assert.equal(callsBeforeHolderRelease.filter((call) => call.method === 'ensureSession').length, 1)
  assert.equal(callsBeforeHolderRelease.filter((call) => call.method === 'prompt').length, 1)
  assert.deepEqual(fakeClient.createdStreams, streamsBeforeHolderRelease)
  assert.deepEqual(fakeAcpx.calls, callsBeforeHolderRelease)
  assert.equal(fakeClient.results.some((result) => result.taskId === waiterTaskId), false)
  assert.equal(events.some((event) => (
    (event.type === 'task.completed' || event.type === 'task.rejected')
    && event.taskId === waiterTaskId
  )), false)
  assert.equal(sessionMutexQueues(bridge).size, 0)
})

test('stop before shared-session acquire prevents a hydrated task from joining the queue', async (context) => {
  const holderTaskId = 'stop-before-acquire-holder'
  const waitingTaskId = 'stop-before-acquire-task'
  const sharedSessionKey = 'conversation:stop-before-acquire-session'
  const { bridge, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, holderTaskId)
  fakeClient.resultGate.resolve()
  const holderDispatch = fakeClient.emitTaskDispatch(cancellationTask(holderTaskId, {
    sessionKey: sharedSessionKey,
  }))
  let waitingDispatch: Promise<void> | undefined
  let waitingSettledBeforeHolderRelease = false
  let callsBeforeHolderRelease: typeof fakeAcpx.calls = []
  let streamsBeforeHolderRelease: typeof fakeClient.createdStreams = []

  try {
    await fakeClient.streamCloseStarted.promise
    fakeClient.gateHydrate = true
    waitingDispatch = fakeClient.emitTaskDispatch(cancellationTask(waitingTaskId, {
      sessionKey: sharedSessionKey,
    }))
    await until(
      () => fakeClient.hydratedDispatches.some((dispatch) => dispatch.taskId === waitingTaskId),
      'the second lifecycle must be gated in hydration before stop',
    )

    await bridge.stop()
    fakeClient.hydrateGate.resolve()
    waitingSettledBeforeHolderRelease = await settlesWithin(waitingDispatch)
    callsBeforeHolderRelease = [...fakeAcpx.calls]
    streamsBeforeHolderRelease = [...fakeClient.createdStreams]

    assert.equal(
      existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${waitingTaskId}.lock`)),
      false,
    )
    assert.equal([...sessionMutexQueues(bridge).values()].some((queue) => queue.length > 0), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await holderDispatch.catch(() => undefined)
    await waitingDispatch?.catch(() => undefined)
  }

  assert.equal(waitingSettledBeforeHolderRelease, true)
  assert.deepEqual(fakeAcpx.calls, callsBeforeHolderRelease)
  assert.deepEqual(fakeClient.createdStreams, streamsBeforeHolderRelease)
  assert.equal(fakeClient.results.some((result) => result.taskId === waitingTaskId), false)
  assert.equal(sessionMutexQueues(bridge).size, 0)
})

test('stop during attachment download prevents an acquired lifecycle from reviving', async (context) => {
  const taskId = 'stop-active-download'
  const tempPrefix = `aamp-acp-${taskId}-`
  const tempBefore = readdirSync(tmpdir()).filter((entry) => entry.startsWith(tempPrefix))
  const { bridge, events, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId, {
    attachmentPolicy: 'allow',
  })
  fakeClient.gateDownload = true
  const taskLock = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`)
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId, {
    attachments: [{
      filename: 'shutdown.txt',
      contentType: 'text/plain',
      size: 17,
      blobId: `blob-${taskId}`,
    }],
  }))

  try {
    await fakeClient.downloadStarted.promise
    assert.equal(existsSync(taskLock), true)
    assert.equal(sessionMutexQueues(bridge).size, 1)
    assert.deepEqual(fakeAcpx.calls, [])
    const streamEventsAtStop = [...fakeClient.streamEvents]

    await bridge.stop()
    fakeClient.downloadGate.resolve()
    assert.equal(await settlesWithin(dispatch), true, 'stopped attachment holder must settle after download releases')
    await dispatch

    assert.deepEqual(fakeAcpx.calls, [])
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(fakeClient.streamCloses, [])
    assert.deepEqual(fakeClient.streamEvents, streamEventsAtStop)
    assert.equal(events.some((event) => (
      (event.type === 'task.completed' || event.type === 'task.rejected')
      && event.taskId === taskId
    )), false)
    assert.equal(existsSync(taskLock), false)
    assert.equal(bridge.isBusy, false)
    assert.equal(activeTaskSessionCount(bridge), 0)
    assert.equal(sessionMutexQueues(bridge).size, 0)
    assert.deepEqual(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith(tempPrefix)),
      tempBefore,
    )
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('stop during ensureSession prevents an acquired lifecycle from entering prompt', async (context) => {
  const taskId = 'stop-active-ensure'
  const { bridge, events, fakeClient, fakeAcpx, testHome } = await cancellationHarness(context, taskId)
  fakeAcpx.gateEnsureSession = true
  const taskLock = join(testHome, '.aamp', 'acp-bridge', 'task-locks', `${taskId}.lock`)
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await until(
      () => fakeAcpx.calls.filter((call) => call.method === 'ensureSession').length === 1,
      'active holder must enter its gated ensureSession before stop',
    )
    assert.equal(existsSync(taskLock), true)
    assert.equal(sessionMutexQueues(bridge).size, 1)
    const streamEventsAtStop = [...fakeClient.streamEvents]

    const stopping = bridge.stop()
    assert.equal(
      await settlesWithin(stopping),
      false,
      'stop must wait for the in-flight session establishment to settle',
    )
    fakeAcpx.ensureSessionGate.resolve()
    await Promise.all([stopping, dispatch])

    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'ensureSession').length, 1)
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'prompt'), false)
    assert.equal(fakeAcpx.calls.some((call) => call.method === 'cancel'), false)
    assert.deepEqual(fakeClient.streamEvents, streamEventsAtStop)
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.helps, [])
    assert.deepEqual(fakeClient.streamCloses, [])
    assert.equal(events.some((event) => (
      (event.type === 'task.completed' || event.type === 'task.rejected')
      && event.taskId === taskId
    )), false)
    assert.equal(existsSync(taskLock), false)
    assert.equal(bridge.isBusy, false)
    assert.equal(activeTaskSessionCount(bridge), 0)
    assert.equal(sessionMutexQueues(bridge).size, 0)
    const taskSessionName = 'aamp-remote-agent-conversation:stop-active-ensure'
    assert.equal(
      fakeAcpx.closeCalls.filter((call) => call.sessionName === taskSessionName).length,
      1,
      'a session established during stop must close exactly once',
    )
    assert.equal(trackedSessionNames(bridge).size, 0)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('stop suppresses startup ready after a gated ensure succeeds late and closes once', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-startup-stop-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const { bridge, fakeAcpx } = bridgeHarness({ testHome })
  fakeAcpx.gateEnsureSession = true
  let stopBegan = false
  const events: Array<{ type: string; afterStopBegan: boolean }> = []
  const order: string[] = []
  const starting = bridge.start({
    quiet: true,
    onEvent: (event) => {
      events.push({ type: event.type, afterStopBegan: stopBegan })
      order.push(`event:${event.type}`)
    },
  }).then(() => {
    order.push('start:settled')
  })
  await until(
    () => fakeAcpx.calls.some((call) => call.method === 'ensureSession'),
    'startup must enter its gated ensureSession',
  )
  stopBegan = true
  order.push('stop:began')
  const stopping = bridge.stop().then(() => {
    order.push('stop:settled')
  })

  try {
    assert.equal(
      await settlesWithin(stopping),
      false,
      'stop must not settle before gated startup establishment',
    )
    fakeAcpx.ensureSessionGate.resolve()
    assert.equal(await settlesWithin(starting), true, 'start must settle after the gate opens')
    await starting
    assert.equal(await settlesWithin(stopping), true, 'stop must settle after startup cleanup')
    await stopping
  } finally {
    fakeAcpx.ensureSessionGate.resolve()
    await starting.catch(() => undefined)
    await stopping.catch(() => undefined)
  }

  assert.deepEqual(
    events.filter((event) => (
      event.afterStopBegan
      && (event.type === 'agent.session.ready' || event.type === 'agent.session.deferred')
    )),
    [],
    `startup emitted a terminal session event after stop began: ${order.join(' -> ')}`,
  )
  assert.ok(order.indexOf('stop:began') < order.indexOf('start:settled'))
  assert.ok(order.indexOf('stop:began') < order.indexOf('stop:settled'))
  assert.equal(
    fakeAcpx.closeCalls.filter((call) => call.sessionName === 'aamp-remote-agent').length,
    1,
  )
  assert.equal(trackedSessionNames(bridge).size, 0)
})

test('stop suppresses startup deferred after a gated ensure fails late without closing', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-startup-failure-stop-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const { bridge, fakeAcpx } = bridgeHarness({ testHome })
  fakeAcpx.gateEnsureSession = true
  fakeAcpx.ensureSessionFailure = new Error('synthetic gated startup failure')
  let stopBegan = false
  const events: Array<{ type: string; afterStopBegan: boolean }> = []
  const order: string[] = []
  const starting = bridge.start({
    quiet: true,
    onEvent: (event) => {
      events.push({ type: event.type, afterStopBegan: stopBegan })
      order.push(`event:${event.type}`)
    },
  }).then(() => {
    order.push('start:settled')
  })
  await until(
    () => fakeAcpx.calls.some((call) => call.method === 'ensureSession'),
    'startup must enter its gated failing ensureSession',
  )
  stopBegan = true
  order.push('stop:began')
  const stopping = bridge.stop().then(() => {
    order.push('stop:settled')
  })

  try {
    assert.equal(
      await settlesWithin(stopping),
      false,
      'stop must not settle before the failing startup establishment settles',
    )
    fakeAcpx.ensureSessionGate.resolve()
    assert.equal(await settlesWithin(starting), true, 'start must settle after the failure arrives')
    await starting
    assert.equal(await settlesWithin(stopping), true, 'stop must settle after failed establishment cleanup')
    await stopping
  } finally {
    fakeAcpx.ensureSessionGate.resolve()
    await starting.catch(() => undefined)
    await stopping.catch(() => undefined)
  }

  assert.deepEqual(
    events.filter((event) => (
      event.afterStopBegan
      && (event.type === 'agent.session.ready' || event.type === 'agent.session.deferred')
    )),
    [],
    `startup emitted a terminal session event after stop began: ${order.join(' -> ')}`,
  )
  assert.ok(order.indexOf('stop:began') < order.indexOf('start:settled'))
  assert.ok(order.indexOf('stop:began') < order.indexOf('stop:settled'))
  assert.deepEqual(fakeAcpx.closeCalls, [])
  assert.equal(trackedSessionNames(bridge).size, 0)
})

test('ordinary stop remains bounded and ignores later dispatch delivery', async (context) => {
  const taskId = 'ordinary-stop-post-dispatch'
  const { bridge, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)

  const firstStop = bridge.stop()
  assert.equal(await settlesWithin(firstStop), true)
  await firstStop
  const secondStop = bridge.stop()
  assert.equal(await settlesWithin(secondStop), true)
  await secondStop

  const postStopDispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))
  assert.equal(await settlesWithin(postStopDispatch), true)
  await postStopDispatch

  assert.equal(fakeClient.isConnected(), false)
  assert.deepEqual(fakeClient.hydratedDispatches, [])
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.deepEqual(fakeClient.results, [])
  assert.deepEqual(fakeAcpx.calls, [])
  assert.equal(sessionMutexQueues(bridge).size, 0)
  await assert.rejects(
    bridge.start({ quiet: true }),
    /cannot be restarted after stop; create a new bridge instance/,
  )
})

async function withoutConsoleNoise<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => undefined
  console.warn = () => undefined
  try {
    return await run()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

test('bounded early-cancel history evicts the oldest task behaviorally', async (context) => {
  const historyLimit = 256
  const { fakeClient } = await cancellationHarness(context, 'early-cancel-capacity')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await withoutConsoleNoise(async () => {
    for (let index = 0; index <= historyLimit; index += 1) {
      await fakeClient.emitTaskCancel(cancellationEvent(`early-capacity-${index}`))
    }
    await fakeClient.emitTaskDispatch(cancellationTask('early-capacity-0'))
    await fakeClient.emitTaskDispatch(cancellationTask(`early-capacity-${historyLimit}`))
  })

  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['early-capacity-0'])
})

test('bounded settled task-id history evicts only the oldest lifecycle identity', async (context) => {
  const historyLimit = 256
  const { fakeClient } = await cancellationHarness(context, 'settled-capacity')
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await withoutConsoleNoise(async () => {
    for (let index = 0; index <= historyLimit; index += 1) {
      const taskId = `settled-capacity-${index}`
      await fakeClient.emitTaskCancel(cancellationEvent(taskId))
      await fakeClient.emitTaskDispatch(cancellationTask(taskId))
    }
    await fakeClient.emitTaskDispatch(cancellationTask('settled-capacity-0', {
      messageId: '<settled-capacity-0-after-eviction@example.com>',
    }))
    await fakeClient.emitTaskDispatch(cancellationTask(`settled-capacity-${historyLimit}`, {
      messageId: `<settled-capacity-${historyLimit}-different@example.com>`,
    }))
  })

  assert.deepEqual(fakeClient.results.map((result) => result.taskId), ['settled-capacity-0'])
})

test('cancel-induced prompt rejection closes cancelled without a rejected result', async (context) => {
  const taskId = 'cancel-rejection'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    fakeAcpx.promptGate.reject(new Error('ACP prompt cancelled'))
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-cancel-rejection',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('cancel gated after prompt resolution wins before terminal result send', async (context) => {
  const taskId = 'cancel-before-terminal-send'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeClient.gateResponseAppend = true
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await fakeClient.responseAppendStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 0)

    fakeClient.responseAppendGate.resolve()
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-cancel-before-terminal-send',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('cancel forwarding failure is caught while the cancelled task still drops its result', async (context) => {
  const taskId = 'cancel-forward-failure'
  const { events, fakeClient, fakeAcpx } = await cancellationHarness(context, taskId)
  fakeAcpx.gatePrompt = true
  fakeAcpx.cancelFailure = new Error('cancel transport unavailable')
  fakeClient.streamCloseGate.resolve()
  const dispatch = fakeClient.emitTaskDispatch(cancellationTask(taskId))

  try {
    await fakeAcpx.promptStarted.promise
    await fakeClient.emitTaskCancel(cancellationEvent(taskId))
    assert.equal(fakeAcpx.calls.filter((call) => call.method === 'cancel').length, 1)

    fakeAcpx.promptGate.resolve({
      output: 'late success after failed cancellation',
      events: [],
      streamedAssistantText: false,
    })
    await dispatch

    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(fakeClient.streamCloses, [{
      streamId: 'stream-cancel-forward-failure',
      payload: { reason: 'task.cancelled', status: 'cancelled' },
    }])
    assert.equal(events.some((event) => event.type === 'task.completed'), false)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
  } finally {
    releaseCancellationGates(fakeClient, fakeAcpx)
    await dispatch.catch(() => undefined)
  }
})

test('reject attachment policy awaits one help response before any lock, stream, download, or ACP call', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-reject-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const events: Array<Record<string, unknown>> = []
  const rejectedTempPrefix = 'aamp-acp-task-with-file-'
  const rejectedTempBefore = readdirSync(tmpdir()).filter((entry) => entry.startsWith(rejectedTempPrefix))
  const { bridge, fakeClient, fakeAcpx } = bridgeHarness({
    testHome,
    attachmentPolicy: 'reject',
  })
  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  fakeAcpx.calls.length = 0
  const rejectedSessionName = 'aamp-remote-agent-conversation:task-with-file'
  fakeAcpx.closeFailureSession = rejectedSessionName
  let bridgeStopped = false

  let dispatchSettled = false
  const dispatch = fakeClient.emitTaskDispatch(taskWithAttachment('task-with-file')).finally(() => {
    dispatchSettled = true
  })
  try {
    await until(() => fakeClient.helps.length === 1, 'attachment rejection must send help')

    assert.equal(dispatchSettled, false, 'dispatch must await sendHelp')
    assert.deepEqual(fakeClient.helps, [{
      to: 'sender@example.com',
      taskId: 'task-with-file',
      question: 'The attachment was not downloaded. Please paste the relevant text into the task or share an HTTP(S) URL that the agent can access.',
      blockedReason: 'This ACP agent does not accept attachments',
      suggestedOptions: [
        'Paste the relevant text into the task',
        'Share an HTTP(S) link that AIME can access',
      ],
      inReplyTo: '<task-with-file@example.com>',
    }])
    assert.deepEqual(fakeClient.downloadedBlobs, [])
    assert.deepEqual(fakeClient.createdStreams, [])
    assert.deepEqual(fakeAcpx.calls, [])
    assert.equal(existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks')), false)
    assert.equal(events.filter((event) => event.type === 'task.completed').length, 0)
    assert.equal(events.some((event) => event.type === 'task.rejected'), false)
    assert.deepEqual(fakeClient.results, [])
    assert.deepEqual(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith(rejectedTempPrefix)),
      rejectedTempBefore,
    )

    fakeClient.helpGate.resolve()
    await dispatch
    assert.equal(dispatchSettled, true)
    assert.deepEqual(events.filter((event) => event.type === 'task.completed'), [{
      type: 'task.completed',
      bridge: 'acp-bridge',
      agent: 'remote-agent',
      email: 'agent@meshmail.test',
      taskId: 'task-with-file',
      status: 'help_needed',
    }])
    assert.equal(existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks')), false)

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      await bridge.stop()
      bridgeStopped = true
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(fakeAcpx.closeCalls, [{
      agent: 'remote-agent --acp',
      sessionName: 'aamp-remote-agent',
    }])
    assert.equal(warnings.some((warning) => warning.includes('CLOSE_PATH_SENTINEL')), false)
  } finally {
    fakeClient.helpGate.resolve()
    fakeClient.streamCloseGate.resolve()
    fakeClient.resultGate.resolve()
    await dispatch.catch(() => undefined)
    if (!bridgeStopped) await bridge.stop()
  }
})

test('failed ensureSession is not tracked as a closable task session', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-ensure-failure-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const { bridge, fakeClient, fakeAcpx } = bridgeHarness({ testHome })
  await bridge.start({ quiet: true })
  fakeAcpx.calls.length = 0
  fakeAcpx.closeCalls.length = 0
  fakeAcpx.ensureSessionFailure = new Error('synthetic ensure failure')
  const failedSessionName = 'aamp-remote-agent-conversation:ensure-failure'
  fakeAcpx.closeFailureSession = failedSessionName
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskDispatch(cancellationTask('ensure-failure'))
  assert.deepEqual(fakeAcpx.calls, [{
    method: 'ensureSession',
    agent: 'remote-agent --acp',
    sessionName: failedSessionName,
  }])

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    await bridge.stop()
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(fakeAcpx.closeCalls, [{
    agent: 'remote-agent --acp',
    sessionName: 'aamp-remote-agent',
  }])
  assert.equal(warnings.some((warning) => warning.includes('CLOSE_PATH_SENTINEL')), false)
})

test('reject attachment policy is hidden from unauthorized senders', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-unauthorized-'))
  process.env[homeEnvironmentKey] = testHome
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    rmSync(testHome, { recursive: true, force: true })
  })

  const { bridge, fakeClient, fakeAcpx } = bridgeHarness({
    testHome,
    attachmentPolicy: 'reject',
    from: 'allowed@example.com',
  })
  await bridge.start({ quiet: true })
  fakeAcpx.calls.length = 0
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskDispatch(taskWithAttachment('task-unauthorized', 'intruder@example.com'))

  assert.equal(fakeClient.results.length, 1)
  assert.match(fakeClient.results[0]?.errorMsg ?? '', /Unauthorized sender policy/)
  assert.deepEqual(fakeClient.helps, [])
  assert.deepEqual(fakeClient.downloadedBlobs, [])
  assert.deepEqual(fakeClient.createdStreams, [])
  assert.deepEqual(fakeAcpx.calls, [])
})

test('omitted attachment policy defaults to allow, downloads once, and cleans its temporary file path', async (context) => {
  const originalHome = process.env[homeEnvironmentKey]
  const testHome = mkdtempSync(join(tmpdir(), 'aamp-acp-bridge-allow-'))
  process.env[homeEnvironmentKey] = testHome
  let materializedDirectory: string | undefined
  context.after(() => {
    if (originalHome === undefined) delete process.env[homeEnvironmentKey]
    else process.env[homeEnvironmentKey] = originalHome
    if (materializedDirectory) rmSync(materializedDirectory, { recursive: true, force: true })
    rmSync(testHome, { recursive: true, force: true })
  })

  const { bridge, fakeClient, fakeAcpx } = bridgeHarness({
    testHome,
  })
  await bridge.start({ quiet: true })
  fakeAcpx.calls.length = 0
  fakeClient.streamCloseGate.resolve()
  fakeClient.resultGate.resolve()

  await fakeClient.emitTaskDispatch(taskWithAttachment('task-allowed-file'))

  assert.deepEqual(fakeClient.downloadedBlobs, [{
    blobId: 'blob-task-allowed-file',
    filename: 'requirements.txt',
  }])
  assert.equal(fakeAcpx.prompts.length, 1)
  const prompt = fakeAcpx.prompts[0]
  assert.match(prompt, /Downloaded attachments:/)
  assert.match(prompt, /requirements\.txt, text\/plain, 24 bytes:/)
  const attachmentLine = prompt.split('\n').find((line) => line.includes('aamp-acp-task-allowed-file-'))
  const localPath = attachmentLine?.slice(attachmentLine.lastIndexOf(': ') + 2)
  assert.ok(localPath, 'prompt must contain the local attachment path')
  assert.deepEqual(fakeAcpx.promptLocalPaths, [{ path: localPath, existed: true }])
  materializedDirectory = join(localPath, '..')
  assert.equal(existsSync(materializedDirectory), false)
  assert.equal(existsSync(join(testHome, '.aamp', 'acp-bridge', 'task-locks', 'task-allowed-file.lock')), false)
})
