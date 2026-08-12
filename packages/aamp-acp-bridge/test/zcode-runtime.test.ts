import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  methods,
  type AgentContext,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  ZCodeAcpRuntime,
  type ZCodeBackend,
} from '../src/zcode-acp/runtime.js'
import {
  ZCodeRpcError,
  type ZCodeInboundRequestContext,
} from '../src/zcode-acp/rpc-client.js'
import type { ZCodeNotification } from '../src/zcode-acp/protocol.js'

test('exports the ZCode ACP runtime and backend contract', async () => {
  const module = await import('../src/zcode-acp/runtime.js').catch(() => ({})) as
    Record<string, unknown>

  assert.equal(typeof module.ZCodeAcpRuntime, 'function')
})

interface BackendCall {
  method: string
  params: unknown
}

type BackendHandler = (
  params: unknown,
  call: BackendCall,
) => unknown | Promise<unknown>

class RecordingBackend implements ZCodeBackend {
  readonly calls: BackendCall[] = []
  readonly handlers = new Map<string, BackendHandler>()
  readonly notificationListeners = new Set<(notification: ZCodeNotification) => void>()
  readonly requestListeners = new Set<
    (request: ZCodeInboundRequestContext) => void | Promise<void>
  >()
  readonly closeListeners = new Set<(error: Error) => void>()
  closed = false

  async request<Result>(method: string, params: unknown): Promise<Result> {
    const call = { method, params }
    this.calls.push(call)
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`Unexpected backend request: ${method}`)
    return await handler(params, call) as Result
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.calls.push({ method, params })
  }

  onNotification(listener: (notification: ZCodeNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onRequest(
    listener: (request: ZCodeInboundRequestContext) => void | Promise<void>,
  ): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  emitNotification(notification: ZCodeNotification): void {
    for (const listener of this.notificationListeners) listener(notification)
  }

  async emitRequest(
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: unknown }> {
    return await new Promise((resolve) => {
      const listener = this.requestListeners.values().next().value
      assert.ok(listener)
      void listener({
        method,
        params,
        respond: async (result) => resolve({ result }),
        reject: async (error) => resolve({ error }),
      })
    })
  }

  emitClose(error: Error): void {
    for (const listener of this.closeListeners) listener(error)
  }
}

function sessionSnapshot(
  sessionId: string,
  cwd = '/tmp/zcode-project',
  protocolVersion = 1,
) {
  return {
    protocol: { name: 'ZCode Protocol', version: protocolVersion },
    session: {
      sessionId,
      workspace: { workspacePath: cwd },
    },
    settings: {
      mode: { current: 'build' },
      model: {
        current: { providerId: 'zai', modelId: 'glm-4.5' },
        available: [{
          ref: { providerId: 'zai', modelId: 'glm-4.5' },
          label: 'GLM 4.5',
        }],
      },
    },
  }
}

function controlSnapshot(
  mode = 'build',
  model = { providerId: 'zai', modelId: 'glm-4.5' },
  stateRevision = 7,
) {
  const snapshot = sessionSnapshot('sess_1')
  return {
    ...snapshot,
    runtime: { stateRevision },
    settings: {
      mode: { current: mode },
      model: {
        current: model,
        available: [
          {
            ref: { providerId: 'zai', modelId: 'glm-4.5' },
            label: 'GLM 4.5',
          },
          {
            ref: {
              providerId: 'anthropic',
              modelId: 'claude-sonnet',
              variant: 'fast',
            },
            label: 'Claude Sonnet Fast',
          },
        ],
      },
    },
  }
}

function configureLifecycle(
  backend: RecordingBackend,
  sessionId = 'sess_1',
  cwd = '/tmp/zcode-project',
): void {
  backend.handlers.set('session/create', () => sessionSnapshot(sessionId, cwd))
  backend.handlers.set('session/resume', () => sessionSnapshot(sessionId, cwd))
  backend.handlers.set('session/subscribe', () => ({
    sessionId,
    eventSeq: 0,
    events: [],
    snapshot: sessionSnapshot(sessionId, cwd),
  }))
  backend.handlers.set('session/close', () => ({}))
}

function createRuntime(
  backend: RecordingBackend,
  options: {
    request?: (method: string, params: unknown) => Promise<unknown>
    requestTimeoutMs?: number
  } = {},
) {
  const notifications: SessionNotification[] = []
  const client = {
    notify: async (method: string, params: SessionNotification) => {
      assert.equal(method, methods.client.session.update)
      notifications.push(params)
    },
    request: options.request ?? (async () => {
      throw new Error('Unexpected ACP client request')
    }),
  } as unknown as AgentContext
  const runtime = new ZCodeAcpRuntime({
    backend,
    cliPath: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    cliVersion: '0.16.1',
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
  })
  runtime.attachClient(client)
  return { runtime, notifications }
}

function zcodeEvent(
  sessionId: string,
  seq: number,
  type: string,
  payload: unknown,
): ZCodeNotification {
  return {
    method: 'session/event',
    params: {
      eventId: `${sessionId}_evt_${seq}`,
      sessionId,
      seq,
      timestamp: '2026-08-11T00:00:00.000Z',
      type,
      payload,
    },
  }
}

async function waitForCall(
  backend: RecordingBackend,
  method: string,
  count = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (backend.calls.filter((call) => call.method === method).length >= count) return
    await delay(5)
  }
  assert.fail(`Timed out waiting for backend call ${method}`)
}

test('requires an ACP client before creating a ZCode session', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const runtime = new ZCodeAcpRuntime({
    backend,
    cliPath: '/tmp/zcode.cjs',
    cliVersion: '0.16.1',
  })

  await assert.rejects(
    runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] }),
    /ACP client is not attached/,
  )
  assert.equal(backend.calls.length, 0)
})

test('creates and subscribes a session without overriding ZCode mode or model', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const { runtime } = createRuntime(backend)

  assert.deepEqual(await runtime.newSession({
    cwd: '/tmp/zcode-project',
    mcpServers: [],
  }), {
    sessionId: 'sess_1',
    modes: {
      currentModeId: 'build',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'build', name: 'Build' },
        { id: 'edit', name: 'Edit' },
        { id: 'yolo', name: 'Yolo' },
        { id: 'auto', name: 'Auto' },
      ],
    },
    configOptions: [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'zai/glm-4.5',
      options: [{ value: 'zai/glm-4.5', name: 'GLM 4.5' }],
    }],
  })
  assert.deepEqual(backend.calls, [
    {
      method: 'session/create',
      params: {
        workspace: {
          workspacePath: '/tmp/zcode-project',
          workspaceKey: '/tmp/zcode-project',
        },
        mcpServers: [],
        persistence: 'immediate',
      },
    },
    {
      method: 'session/subscribe',
      params: {
        sessionId: 'sess_1',
        deliveryKind: 'desktop-continuous',
        includeSnapshot: true,
      },
    },
  ])
  assert.equal('mode' in (backend.calls[0].params as Record<string, unknown>), false)
  assert.equal('model' in (backend.calls[0].params as Record<string, unknown>), false)
})

test('closes a newly created ZCode session when subscription fails', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/subscribe', () => {
    throw new Error('subscription rejected')
  })
  const { runtime } = createRuntime(backend)

  await assert.rejects(
    runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] }),
    /subscription rejected/,
  )
  assert.deepEqual(backend.calls.at(-1), {
    method: 'session/close',
    params: { sessionId: 'sess_1' },
  })
})

test('rejects unsupported roots and protocol versions before session registration', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const { runtime } = createRuntime(backend)
  await assert.rejects(
    runtime.newSession({
      cwd: '/tmp/zcode-project',
      additionalDirectories: ['/tmp/other'],
      mcpServers: [],
    }),
    /additionalDirectories/,
  )
  assert.equal(backend.calls.length, 0)

  backend.handlers.set('session/create', () => sessionSnapshot(
    'sess_bad',
    '/tmp/zcode-project',
    2,
  ))
  await assert.rejects(
    runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] }),
    /expected ZCode Protocol v1.*version 2/,
  )
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/subscribe').length,
    0,
  )
})

test('answers the ZCode runtime-preference request with safe defaults', async () => {
  const backend = new RecordingBackend()
  createRuntime(backend)

  assert.deepEqual(await backend.emitRequest(
    'session/requestRuntimePreferences',
    { sessionId: 'sess_1', scope: 'session' },
  ), {
    result: {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: 'preflight-v1',
    },
  })
})

test('resumes without replaying historical messages', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const { runtime, notifications } = createRuntime(backend)

  assert.deepEqual(await runtime.resumeSession({
    sessionId: 'sess_1',
    cwd: '/tmp/zcode-project',
    mcpServers: [],
  }), {
    modes: {
      currentModeId: 'build',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'build', name: 'Build' },
        { id: 'edit', name: 'Edit' },
        { id: 'yolo', name: 'Yolo' },
        { id: 'auto', name: 'Auto' },
      ],
    },
    configOptions: [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'zai/glm-4.5',
      options: [{ value: 'zai/glm-4.5', name: 'GLM 4.5' }],
    }],
  })
  assert.equal(backend.calls.some((call) => call.method === 'session/messages'), false)
  assert.deepEqual(notifications, [])
})

test('loads history before flushing live events newer than the replay boundary', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/subscribe', () => ({
    sessionId: 'sess_1',
    eventSeq: 5,
    events: [],
    snapshot: sessionSnapshot('sess_1'),
  }))
  let resolveMessages!: (value: unknown) => void
  backend.handlers.set('session/messages', () => new Promise((resolve) => {
    resolveMessages = resolve
  }))
  const { runtime, notifications } = createRuntime(backend)

  const loading = runtime.loadSession({
    sessionId: 'sess_1',
    cwd: '/tmp/zcode-project',
    mcpServers: [],
  })
  await waitForCall(backend, 'session/messages')
  backend.emitNotification(zcodeEvent('sess_1', 5, 'model.streaming', {
    kind: 'text_delta',
    assistantMessageId: 'msg_live',
    partId: 'part_live',
    delta: 'old-boundary',
  }))
  backend.emitNotification(zcodeEvent('sess_1', 6, 'model.streaming', {
    kind: 'text_delta',
    assistantMessageId: 'msg_live',
    partId: 'part_live',
    delta: 'live-after-replay',
  }))
  resolveMessages({
    messages: [
      {
        info: { role: 'user', messageId: 'msg_user' },
        parts: [{ type: 'text', text: 'old user' }],
      },
      {
        info: { role: 'assistant', messageId: 'msg_agent' },
        parts: [{ type: 'text', text: 'old agent' }],
      },
    ],
  })

  await loading
  assert.deepEqual(
    backend.calls.find((call) => call.method === 'session/messages'),
    {
      method: 'session/messages',
      params: { sessionId: 'sess_1' },
    },
  )
  assert.deepEqual(notifications.map((item) => item.update), [
    {
      sessionUpdate: 'user_message_chunk',
      messageId: 'msg_user',
      content: { type: 'text', text: 'old user' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_agent',
      content: { type: 'text', text: 'old agent' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_live',
      content: { type: 'text', text: 'live-after-replay' },
    },
  ])
})

test('lists and closes sessions without inventing pagination', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/list', () => ({
    sessions: [{
      sessionId: 'sess_1',
      workspace: { workspacePath: '/tmp/zcode-project' },
      title: 'Existing',
      updatedAt: '2026-08-11T00:00:00.000Z',
    }],
  }))
  const { runtime } = createRuntime(backend)
  await runtime.resumeSession({
    sessionId: 'sess_1',
    cwd: '/tmp/zcode-project',
    mcpServers: [],
  })

  assert.deepEqual(await runtime.listSessions({ cwd: '/tmp/zcode-project' }), {
    sessions: [{
      sessionId: 'sess_1',
      cwd: '/tmp/zcode-project',
      title: 'Existing',
      updatedAt: '2026-08-11T00:00:00.000Z',
    }],
  })
  assert.deepEqual(await runtime.closeSession({ sessionId: 'sess_1' }), {})
  assert.deepEqual(backend.calls.at(-1), {
    method: 'session/close',
    params: { sessionId: 'sess_1' },
  })
})

test('streams one prompt and adds usage before resolving completion', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => ({
    sessionId: 'sess_1',
    accepted: true,
    stateRevision: 8,
  }))
  backend.handlers.set('session/usage', () => ({
    totalTokens: 10,
    inputTokens: 4,
    outputTokens: 6,
    thoughtTokens: 1,
    contextWindowSize: 8192,
  }))
  const { runtime, notifications } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })

  const prompting = runtime.prompt({
    sessionId: 'sess_1',
    prompt: [{ type: 'text', text: 'Hello' }],
  })
  await waitForCall(backend, 'session/send')
  const sent = backend.calls.find((call) => call.method === 'session/send')
    ?.params as Record<string, unknown>
  assert.match(String(sent.inputId), /^acp-input-/)
  assert.match(String(sent.queryId), /^acp-query-/)
  backend.emitNotification(zcodeEvent('sess_1', 1, 'model.streaming', {
    kind: 'text_delta',
    assistantMessageId: 'msg_1',
    partId: 'part_1',
    delta: 'Hi',
  }))
  backend.emitNotification(zcodeEvent('sess_1', 2, 'turn.completed', {
    resultType: 'success',
    inputId: sent.inputId,
    queryId: sent.queryId,
  }))

  assert.deepEqual(await prompting, {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 10,
      inputTokens: 4,
      outputTokens: 6,
      thoughtTokens: 1,
    },
  })
  assert.deepEqual(notifications.map((item) => item.update), [
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_1',
      content: { type: 'text', text: 'Hi' },
    },
    {
      sessionUpdate: 'usage_update',
      used: 10,
      size: 8192,
    },
  ])
})

test('allows concurrent sessions but rejects a second prompt in one session', async () => {
  const backend = new RecordingBackend()
  backend.handlers.set('session/create', (params) => {
    const workspace = (params as { workspace: { workspacePath: string } }).workspace
    const sessionId = workspace.workspacePath.endsWith('/a') ? 'sess_a' : 'sess_b'
    return sessionSnapshot(sessionId, workspace.workspacePath)
  })
  backend.handlers.set('session/subscribe', (params) => {
    const sessionId = (params as { sessionId: string }).sessionId
    return {
      sessionId,
      eventSeq: 0,
      events: [],
      snapshot: sessionSnapshot(
        sessionId,
        sessionId === 'sess_a' ? '/tmp/a' : '/tmp/b',
      ),
    }
  })
  backend.handlers.set('session/send', (params) => ({
    sessionId: (params as { sessionId: string }).sessionId,
    accepted: true,
    stateRevision: 1,
  }))
  backend.handlers.set('session/usage', () => ({
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  }))
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/a', mcpServers: [] })
  await runtime.newSession({ cwd: '/tmp/b', mcpServers: [] })

  const promptA = runtime.prompt({
    sessionId: 'sess_a',
    prompt: [{ type: 'text', text: 'A' }],
  })
  const promptB = runtime.prompt({
    sessionId: 'sess_b',
    prompt: [{ type: 'text', text: 'B' }],
  })
  await waitForCall(backend, 'session/send', 2)
  const sends = backend.calls
    .filter((call) => call.method === 'session/send')
    .map((call) => call.params as Record<string, unknown>)
  const sentA = sends.find((params) => params.sessionId === 'sess_a')
  const sentB = sends.find((params) => params.sessionId === 'sess_b')
  assert.ok(sentA)
  assert.ok(sentB)
  await assert.rejects(
    runtime.prompt({
      sessionId: 'sess_a',
      prompt: [{ type: 'text', text: 'A2' }],
    }),
    /already has an active prompt/,
  )

  backend.emitNotification(zcodeEvent('sess_b', 1, 'turn.completed', {
    resultType: 'success',
    inputId: sentB.inputId,
    queryId: sentB.queryId,
  }))
  backend.emitNotification(zcodeEvent('sess_a', 1, 'turn.completed', {
    resultType: 'cancelled',
    inputId: sentA.inputId,
    queryId: sentA.queryId,
  }))
  assert.equal((await promptB).stopReason, 'end_turn')
  assert.equal((await promptA).stopReason, 'cancelled')
})

test('does not complete a prompt from a stale query identifier', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => ({
    sessionId: 'sess_1',
    accepted: true,
    stateRevision: 1,
  }))
  backend.handlers.set('session/usage', () => ({
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  }))
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })
  const prompting = runtime.prompt({
    sessionId: 'sess_1',
    prompt: [{ type: 'text', text: 'Hello' }],
  })
  await waitForCall(backend, 'session/send')
  const sent = backend.calls.find((call) => call.method === 'session/send')
    ?.params as Record<string, unknown>

  backend.emitNotification(zcodeEvent('sess_1', 1, 'turn.completed', {
    resultType: 'success',
    queryId: 'query_stale',
  }))
  await delay(10)
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/usage').length,
    0,
  )

  backend.emitNotification(zcodeEvent('sess_1', 2, 'turn.completed', {
    resultType: 'success',
    queryId: sent.queryId,
  }))
  assert.equal((await prompting).stopReason, 'end_turn')
})

test('stops active prompts before bounded runtime shutdown', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => ({
    sessionId: 'sess_1',
    accepted: true,
    stateRevision: 1,
  }))
  backend.handlers.set('session/stop', () => ({ stopped: true }))
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })
  const prompting = runtime.prompt({
    sessionId: 'sess_1',
    prompt: [{ type: 'text', text: 'Still running' }],
  })
  await waitForCall(backend, 'session/send')
  const rejected = assert.rejects(prompting, /runtime closed/)

  await runtime.close()
  await rejected
  assert.deepEqual(
    backend.calls.filter((call) => call.method === 'session/stop'),
    [{ method: 'session/stop', params: { sessionId: 'sess_1' } }],
  )
  assert.equal(backend.closed, true)
})

test('does not send unsupported prompt content and rewrites model setup errors', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => {
    throw new ZCodeRpcError('session/send', {
      code: -32603,
      message: 'No model provider configured',
      data: { code: 'model_config_missing' },
    })
  })
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })
  const sendCount = backend.calls.filter((call) => call.method === 'session/send').length

  await assert.rejects(
    runtime.prompt({
      sessionId: 'sess_1',
      prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
    }),
    /Unsupported ACP prompt content type: image/,
  )
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/send').length,
    sendCount,
  )
  await assert.rejects(
    runtime.prompt({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'Hello' }],
    }),
    /No model provider configured.*node "\/Applications\/ZCode\.app.*zcode\.cjs" login/s,
  )
})

test('rejects active prompts when the backend closes', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => ({ inputId: 'input_1' }))
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })
  const prompting = runtime.prompt({
    sessionId: 'sess_1',
    prompt: [{ type: 'text', text: 'Hello' }],
  })
  await waitForCall(backend, 'session/send')
  const rejected = assert.rejects(prompting, /child crashed/)

  backend.emitClose(new Error('child crashed'))
  await rejected
})

function permissionParams(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'perm_1',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    toolCallId: 'tool_1',
    toolName: 'write_file',
    reason: 'Modify source',
    riskLevel: 'medium',
    input: { path: '/tmp/a.ts', apiKey: 'do-not-expose' },
    options: [
      {
        optionId: 'once',
        kind: 'allowOnce',
        name: 'Allow once',
        response: { decision: 'allow', reason: 'user allowed' },
      },
      {
        optionId: 'always',
        kind: 'allowAlways',
        name: 'Always allow',
        response: { decision: 'allow', reason: 'user always allowed' },
      },
      {
        optionId: 'deny',
        kind: 'deny',
        name: 'Deny',
        response: { decision: 'deny', reason: 'user denied' },
      },
      {
        optionId: 'custom',
        kind: 'custom',
        name: 'Allow modified input',
        response: { decision: 'modify', modifiedInput: { path: '/tmp/safe.ts' } },
      },
    ],
    ...overrides,
  }
}

test('maps a selected ACP permission to the exact ZCode option response', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const clientRequests: Array<{ method: string; params: unknown }> = []
  const { runtime } = createRuntime(backend, {
    request: async (method, params) => {
      clientRequests.push({ method, params })
      return { outcome: { outcome: 'selected', optionId: 'once' } }
    },
  })
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })

  assert.deepEqual(await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams(),
  ), {
    result: { decision: 'allow', reason: 'user allowed' },
  })
  assert.deepEqual(clientRequests, [{
    method: methods.client.session.requestPermission,
    params: {
      sessionId: 'sess_1',
      toolCall: {
        toolCallId: 'tool_1',
        title: 'Modify source',
        kind: 'edit',
        status: 'pending',
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: '{"path":"/tmp/a.ts","apiKey":"[REDACTED]"}',
          },
        }],
      },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
        { optionId: 'custom', kind: 'allow_once', name: 'Allow modified input' },
      ],
    },
  }])
})

test('denies cancelled permissions and never defaults permission failures to allow', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  let outcome: unknown = { outcome: { outcome: 'cancelled' } }
  const { runtime } = createRuntime(backend, {
    request: async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  })
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })

  assert.deepEqual(await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams(),
  ), {
    result: {
      decision: 'deny',
      reason: 'ACP permission request cancelled',
    },
  })

  outcome = { outcome: { outcome: 'selected', optionId: 'missing' } }
  const unknownOption = await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams(),
  )
  assert.deepEqual(unknownOption, {
    result: {
      decision: 'deny',
      reason: 'Unknown ACP permission option: missing',
    },
  })

  assert.deepEqual(await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams({ sessionId: 'sess_missing' }),
  ), {
    error: {
      code: -32602,
      message: 'Unknown ZCode permission session: sess_missing',
    },
  })

  outcome = new Error('ACP client disconnected')
  const disconnected = await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams(),
  )
  assert.deepEqual(disconnected, {
    result: {
      decision: 'deny',
      reason: 'ACP permission request failed',
    },
  })
  for (const response of [unknownOption, disconnected]) {
    assert.notDeepEqual(response.result, { decision: 'allow' })
  }
})

test('bounds an unanswered ACP permission request', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  const { runtime } = createRuntime(backend, {
    request: async () => await new Promise(() => {}),
    requestTimeoutMs: 20,
  })
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })

  const response = await backend.emitRequest(
    'interaction/requestPermission',
    permissionParams(),
  )
  assert.deepEqual(response, {
    result: {
      decision: 'deny',
      reason: 'ACP permission request timed out after 20ms',
    },
  })
})

test('cancels an active prompt once and resolves it from the cancelled turn', async () => {
  const backend = new RecordingBackend()
  configureLifecycle(backend)
  backend.handlers.set('session/send', () => ({
    sessionId: 'sess_1',
    accepted: true,
    stateRevision: 1,
  }))
  backend.handlers.set('session/stop', () => ({ stopped: true }))
  backend.handlers.set('session/usage', () => ({
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  }))
  const { runtime } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })
  const prompting = runtime.prompt({
    sessionId: 'sess_1',
    prompt: [{ type: 'text', text: 'Stop me' }],
  })
  await waitForCall(backend, 'session/send')
  const sent = backend.calls.find((call) => call.method === 'session/send')
    ?.params as Record<string, unknown>

  await Promise.all([runtime.cancel('sess_1'), runtime.cancel('sess_1')])
  await runtime.cancel('sess_missing')
  assert.deepEqual(
    backend.calls.filter((call) => call.method === 'session/stop'),
    [{ method: 'session/stop', params: { sessionId: 'sess_1' } }],
  )

  backend.emitNotification(zcodeEvent('sess_1', 1, 'turn.completed', {
    resultType: 'cancelled',
    inputId: sent.inputId,
    queryId: sent.queryId,
  }))
  assert.deepEqual(await prompting, {
    stopReason: 'cancelled',
    usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
  })
  await runtime.cancel('sess_1')
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/stop').length,
    1,
  )
})

test('validates and confirms ZCode mode and model changes', async () => {
  const backend = new RecordingBackend()
  backend.handlers.set('session/create', () => controlSnapshot())
  backend.handlers.set('session/subscribe', () => ({
    sessionId: 'sess_1',
    eventSeq: 0,
    events: [],
    snapshot: controlSnapshot(),
  }))
  backend.handlers.set('session/setMode', () => ({
    snapshot: controlSnapshot('plan', undefined, 8),
  }))
  backend.handlers.set('session/setModel', () => ({
    snapshot: controlSnapshot(
      'plan',
      {
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
        variant: 'fast',
      },
      9,
    ),
  }))
  const { runtime, notifications } = createRuntime(backend)
  await runtime.newSession({ cwd: '/tmp/zcode-project', mcpServers: [] })

  await assert.rejects(
    runtime.setMode({ sessionId: 'sess_1', modeId: 'danger' }),
    /Unknown ZCode mode: danger/,
  )
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/setMode').length,
    0,
  )
  assert.deepEqual(await runtime.setMode({
    sessionId: 'sess_1',
    modeId: 'plan',
  }), {})

  await assert.rejects(
    runtime.setConfigOption({
      sessionId: 'sess_1',
      configId: 'thought-level',
      value: 'high',
    }),
    /Unknown ZCode config option: thought-level/,
  )
  await assert.rejects(
    runtime.setConfigOption({
      sessionId: 'sess_1',
      configId: 'model',
      value: 'openai/unknown',
    }),
    /Unknown ZCode model: openai\/unknown/,
  )
  assert.equal(
    backend.calls.filter((call) => call.method === 'session/setModel').length,
    0,
  )

  assert.deepEqual(await runtime.setConfigOption({
    sessionId: 'sess_1',
    configId: 'model',
    value: 'anthropic/claude-sonnet/fast',
  }), {
    configOptions: [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'anthropic/claude-sonnet/fast',
      options: [
        { value: 'zai/glm-4.5', name: 'GLM 4.5' },
        {
          value: 'anthropic/claude-sonnet/fast',
          name: 'Claude Sonnet Fast',
        },
      ],
    }],
  })

  assert.deepEqual(
    backend.calls.filter((call) =>
      call.method === 'session/setMode' || call.method === 'session/setModel'),
    [
      {
        method: 'session/setMode',
        params: {
          sessionId: 'sess_1',
          mode: 'plan',
          expectedRevision: 7,
        },
      },
      {
        method: 'session/setModel',
        params: {
          sessionId: 'sess_1',
          model: {
            providerId: 'anthropic',
            modelId: 'claude-sonnet',
            variant: 'fast',
          },
          expectedRevision: 8,
        },
      },
    ],
  )
  assert.deepEqual(notifications.map((item) => item.update), [
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    {
      sessionUpdate: 'config_option_update',
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'anthropic/claude-sonnet/fast',
        options: [
          { value: 'zai/glm-4.5', name: 'GLM 4.5' },
          {
            value: 'anthropic/claude-sonnet/fast',
            name: 'Claude Sonnet Fast',
          },
        ],
      }],
    },
  ])
})
