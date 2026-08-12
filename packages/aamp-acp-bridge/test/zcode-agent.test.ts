import assert from 'node:assert/strict'
import test from 'node:test'
import {
  client,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type CloseSessionRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ResumeSessionRequest,
  type SetSessionConfigOptionRequest,
  type SetSessionModeRequest,
} from '@agentclientprotocol/sdk'
import { createZcodeAcpAgent } from '../src/zcode-acp/agent.js'
import type { ZCodeAcpRuntime } from '../src/zcode-acp/runtime.js'
import {
  rewriteZcodeError,
  toZcodePrompt,
  toZcodeWorkspace,
} from '../src/zcode-acp/translator.js'

interface RuntimeCall {
  method: string
  params: unknown
}

class RecordingRuntime {
  readonly calls: RuntimeCall[] = []
  client?: AgentContext

  attachClient(clientContext: AgentContext): void {
    this.client = clientContext
  }

  async newSession(params: NewSessionRequest) {
    toZcodeWorkspace(params.cwd, params.additionalDirectories)
    this.calls.push({ method: 'newSession', params })
    return { sessionId: 'sess_agent' }
  }

  async loadSession(params: LoadSessionRequest) {
    this.calls.push({ method: 'loadSession', params })
    return {}
  }

  async resumeSession(params: ResumeSessionRequest) {
    this.calls.push({ method: 'resumeSession', params })
    return {}
  }

  async listSessions(params: ListSessionsRequest) {
    if (params.cursor === 'explode') throw new Error('unexpected backend failure')
    if (params.cursor === 'model-missing') {
      const source = Object.assign(new Error('Internal error'), {
        code: -32603,
        data: {
          name: 'ModelProtocolError',
          code: 'model_config_missing',
          stack: 'Authorization: Bearer do-not-expose',
          authorization: 'do-not-expose',
        },
      })
      throw rewriteZcodeError(
        source,
        '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      )
    }
    this.calls.push({ method: 'listSessions', params })
    return { sessions: [] }
  }

  async closeSession(params: CloseSessionRequest) {
    this.calls.push({ method: 'closeSession', params })
    return {}
  }

  async prompt(params: PromptRequest) {
    if (params.sessionId === 'sess_explode') {
      throw Object.assign(
        new Error('Authorization: Bearer do-not-expose'),
        {
          code: -32000,
          data: { password: 'do-not-expose' },
        },
      )
    }
    toZcodePrompt(params.prompt)
    this.calls.push({ method: 'prompt', params })
    return { stopReason: 'end_turn' as const }
  }

  async setMode(params: SetSessionModeRequest) {
    this.calls.push({ method: 'setMode', params })
    return {}
  }

  async setConfigOption(params: SetSessionConfigOptionRequest) {
    this.calls.push({ method: 'setConfigOption', params })
    return { configOptions: [] }
  }

  async cancel(sessionId: string) {
    this.calls.push({ method: 'cancel', params: { sessionId } })
  }
}

function asRuntime(runtime: RecordingRuntime): ZCodeAcpRuntime {
  return runtime as unknown as ZCodeAcpRuntime
}

function assertRequestError(error: unknown, code: number): boolean {
  assert.ok(error instanceof RequestError)
  assert.equal(error.code, code)
  return true
}

test('exports the typed ZCode ACP agent factory', async () => {
  const module = await import('../src/zcode-acp/agent.js').catch(() => ({})) as
    Record<string, unknown>

  assert.equal(typeof module.createZcodeAcpAgent, 'function')
})

test('advertises only the approved ZCode capabilities and routes every handler', async () => {
  const runtime = new RecordingRuntime()
  const updates: unknown[] = []
  const app = createZcodeAcpAgent(asRuntime(runtime), '0.1.29')
  const appClient = client({ name: 'zcode-agent-contract-test' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))

  await appClient.connectWith(app, async (agentContext) => {
    const initialized = await agentContext.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    assert.deepEqual(initialized, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: 'aamp-zcode-acp',
        version: '0.1.29',
      },
    })

    const created = await agentContext.request(methods.agent.session.new, {
      cwd: '/tmp/zcode-agent',
      mcpServers: [],
    })
    await agentContext.request(methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: '/tmp/zcode-agent',
      mcpServers: [],
    })
    await agentContext.request(methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: '/tmp/zcode-agent',
      mcpServers: [],
    })
    await agentContext.request(methods.agent.session.list, {})
    await agentContext.request(methods.agent.session.close, {
      sessionId: created.sessionId,
    })
    await agentContext.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Hello' }],
    })
    await agentContext.request(methods.agent.session.setMode, {
      sessionId: created.sessionId,
      modeId: 'plan',
    })
    await agentContext.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'model',
      value: 'provider/model',
    })
    await agentContext.notify(methods.agent.session.cancel, {
      sessionId: created.sessionId,
    })
  })

  assert.ok(runtime.client)
  assert.deepEqual(runtime.calls.map((call) => call.method), [
    'newSession',
    'loadSession',
    'resumeSession',
    'listSessions',
    'closeSession',
    'prompt',
    'setMode',
    'setConfigOption',
    'cancel',
  ])
  assert.deepEqual(updates, [])
})

test('maps adapter validation failures to invalid params before mutation', async () => {
  const runtime = new RecordingRuntime()
  const app = createZcodeAcpAgent(asRuntime(runtime), '0.1.29')

  await client({ name: 'zcode-validation-test' }).connectWith(
    app,
    async (agentContext) => {
      await assert.rejects(
        agentContext.request(methods.agent.session.new, {
          cwd: '/tmp/zcode-agent',
          additionalDirectories: ['/tmp/zcode-extra'],
          mcpServers: [],
        }),
        (error) => assertRequestError(error, -32602),
      )
      await assert.rejects(
        agentContext.request(methods.agent.session.prompt, {
          sessionId: 'sess_agent',
          prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
        }),
        (error) => assertRequestError(error, -32602),
      )
    },
  )

  assert.deepEqual(runtime.calls, [])
})

test('maps unexpected runtime failures to internal errors', async () => {
  const runtime = new RecordingRuntime()
  const app = createZcodeAcpAgent(asRuntime(runtime), '0.1.29')

  await client({ name: 'zcode-internal-error-test' }).connectWith(
    app,
    async (agentContext) => {
      await assert.rejects(
        agentContext.request(methods.agent.session.list, { cursor: 'explode' }),
        (error) => assertRequestError(error, -32603),
      )
    },
  )
})

test('adds stable operation and session context without exposing raw failures', async () => {
  const runtime = new RecordingRuntime()
  const app = createZcodeAcpAgent(asRuntime(runtime), '0.1.29')

  await client({ name: 'zcode-context-error-test' }).connectWith(
    app,
    async (agentContext) => {
      await assert.rejects(
        agentContext.request(methods.agent.session.prompt, {
          sessionId: 'sess_explode',
          prompt: [{ type: 'text', text: 'Hello' }],
        }),
        (error) => {
          assert.ok(error instanceof RequestError)
          assert.equal(error.code, -32603)
          assert.match(
            error.message,
            /session\/prompt failed for session sess_explode: unexpected runtime error/,
          )
          const serialized = JSON.stringify(error)
          assert.doesNotMatch(serialized, /do-not-expose|Bearer/)
          return true
        },
      )
    },
  )
})

test('surfaces model setup guidance without exposing backend stacks', async () => {
  const runtime = new RecordingRuntime()
  const app = createZcodeAcpAgent(asRuntime(runtime), '0.1.29')

  await client({ name: 'zcode-model-error-test' }).connectWith(
    app,
    async (agentContext) => {
      await assert.rejects(
        agentContext.request(methods.agent.session.list, {
          cursor: 'model-missing',
        }),
        (error) => {
          assert.ok(error instanceof RequestError)
          assert.equal(error.code, -32603)
          assert.match(
            error.message,
            /node "\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs" login/,
          )
          const serializedData = JSON.stringify(error.data)
          assert.match(serializedData, /model_config_missing/)
          assert.doesNotMatch(serializedData, /do-not-expose|stack|Bearer/)
          return true
        },
      )
    },
  )
})
