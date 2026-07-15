import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeNetworkUrl = pathToFileURL(path.resolve(__dirname, '../bin/runtime-network.mjs')).href
const controller = readFileSync(path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs'), 'utf8')

let runtimeNetwork
try {
  runtimeNetwork = await import(runtimeNetworkUrl)
} catch {
  runtimeNetwork = undefined
}

test('network errors retain nested DNS and socket causes', () => {
  assert.equal(typeof runtimeNetwork?.describeNetworkError, 'function')

  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND meshmail.ai'), {
    code: 'ENOTFOUND',
    errno: -3008,
    syscall: 'getaddrinfo',
    hostname: 'meshmail.ai',
  })
  const error = new Error('fetch failed', { cause })

  assert.equal(
    runtimeNetwork.describeNetworkError(error),
    'fetch failed | cause=getaddrinfo ENOTFOUND meshmail.ai | code=ENOTFOUND | errno=-3008 | syscall=getaddrinfo | hostname=meshmail.ai',
  )
})

test('network errors are classified for DNS, timeout, reset, TLS, and HTTP failures', () => {
  assert.equal(typeof runtimeNetwork?.classifyNetworkError, 'function')

  const cases = [
    [Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), 'dns', true],
    [Object.assign(new Error('dns temporary'), { code: 'EAI_AGAIN' }), 'dns', true],
    [Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), 'connect_timeout', true],
    [Object.assign(new Error('read timeout'), { code: 'ETIMEDOUT' }), 'timeout', true],
    [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 'connection_reset', true],
    [new Error('aamp-acp-bridge failed: fetch failed | cause=connect ETIMEDOUT | code=ETIMEDOUT'), 'timeout', true],
    [new Error('aamp-acp-bridge failed: fetch failed | cause=socket closed | code=UND_ERR_SOCKET'), 'connection_reset', true],
    [Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }), 'tls', false],
    [Object.assign(new Error('service unavailable'), { status: 503 }), 'http_5xx', true],
    [new Error('aamp-acp-bridge failed: upstream request failed | status=503'), 'http_5xx', true],
    [new Error('aamp-feishu-bridge failed: HTTP 429 Too Many Requests'), 'http_4xx', true],
    [Object.assign(new Error('unauthorized'), { status: 401 }), 'http_4xx', false],
  ]

  for (const [error, category, retryable] of cases) {
    assert.equal(runtimeNetwork.classifyNetworkError(error), category)
    assert.equal(runtimeNetwork.isRetryableNetworkError(error), retryable)
  }
})

test('retry helper retries transient failures and reports every attempt', async () => {
  assert.equal(typeof runtimeNetwork?.withNetworkRetry, 'function')

  let calls = 0
  const retries = []
  const value = await runtimeNetwork.withNetworkRetry(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('fetch failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    return 'ok'
  }, {
    maxAttempts: 3,
    baseDelayMs: 0,
    onRetry: (event) => retries.push(event),
  })

  assert.equal(value, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(retries.map(({ attempt, nextDelayMs, category }) => ({ attempt, nextDelayMs, category })), [
    { attempt: 1, nextDelayMs: 0, category: 'connect_timeout' },
    { attempt: 2, nextDelayMs: 0, category: 'connect_timeout' },
  ])
})

test('retry helper does not retry permanent failures', async () => {
  assert.equal(typeof runtimeNetwork?.withNetworkRetry, 'function')

  let calls = 0
  await assert.rejects(
    runtimeNetwork.withNetworkRetry(async () => {
      calls += 1
      throw Object.assign(new Error('unauthorized'), { status: 401 })
    }, { maxAttempts: 3, baseDelayMs: 0 }),
    /unauthorized/,
  )
  assert.equal(calls, 1)
})

test('retry helper honors flattened Bridge HTTP statuses', async () => {
  let transientCalls = 0
  const result = await runtimeNetwork.withNetworkRetry(async () => {
    transientCalls += 1
    if (transientCalls < 3) throw new Error('aamp-acp-bridge failed: HTTP 503 Service Unavailable')
    return 'ok'
  }, { maxAttempts: 3, baseDelayMs: 0 })
  assert.equal(result, 'ok')
  assert.equal(transientCalls, 3)

  let permanentCalls = 0
  await assert.rejects(
    runtimeNetwork.withNetworkRetry(async () => {
      permanentCalls += 1
      throw new Error('aamp-acp-bridge failed: status=401')
    }, { maxAttempts: 3, baseDelayMs: 0 }),
    /status=401/,
  )
  assert.equal(permanentCalls, 1)
})

test('detached diagnostics cannot delay or cancel a real retry', async () => {
  assert.equal(typeof runtimeNetwork?.launchDetachedDiagnostic, 'function')

  let calls = 0
  const result = await runtimeNetwork.withNetworkRetry(async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    return 'ok'
  }, {
    maxAttempts: 2,
    baseDelayMs: 0,
    onRetry: () => {
      runtimeNetwork.launchDetachedDiagnostic(() => new Promise(() => {}))
    },
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 2)

  runtimeNetwork.launchDetachedDiagnostic(
    async () => { throw new Error('diagnostic failed') },
    async () => { throw new Error('diagnostic error logging failed') },
  )
  await new Promise((resolve) => setImmediate(resolve))
})

test('partial ACP agent network failures retry before accepting partial success', () => {
  assert.equal(typeof runtimeNetwork?.agentStartRetryError, 'function')

  const transientEvents = [
    { type: 'agent.started', agent: 'codex' },
    { type: 'agent.failed', agent: 'cursor', message: 'fetch failed | cause=getaddrinfo ENOTFOUND meshmail.ai | code=ENOTFOUND' },
    { type: 'bridge.running', agents: [{ name: 'codex' }] },
  ]
  assert.match(
    runtimeNetwork.agentStartRetryError(transientEvents, ['codex', 'cursor'], 1, 3)?.message || '',
    /ENOTFOUND/,
  )
  assert.equal(runtimeNetwork.agentStartRetryError(transientEvents, ['codex', 'cursor'], 3, 3), undefined)

  const permanentEvents = [
    { type: 'agent.failed', agent: 'cursor', message: 'certificate expired | code=CERT_HAS_EXPIRED' },
  ]
  assert.equal(runtimeNetwork.agentStartRetryError(permanentEvents, ['cursor'], 1, 3), undefined)
})

test('endpoint probe records DNS, proxy presence, HTTP status, and retries', async () => {
  assert.equal(typeof runtimeNetwork?.probeEndpoint, 'function')

  let fetchCalls = 0
  const attempts = []
  const result = await runtimeNetwork.probeEndpoint('https://user:secret@meshmail.ai/.well-known/aamp?token=secret', {
    maxAttempts: 3,
    baseDelayMs: 0,
    timeoutMs: 50,
    environment: {
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
    },
    lookup: async () => [
      { address: '23.49.104.211', family: 4 },
      { address: '2600:1406:bc00::1', family: 6 },
    ],
    fetchImpl: async () => {
      fetchCalls += 1
      return { ok: fetchCalls > 1, status: fetchCalls > 1 ? 200 : 503, statusText: fetchCalls > 1 ? 'OK' : 'Unavailable' }
    },
    onAttempt: (event) => attempts.push(event),
  })

  assert.equal(fetchCalls, 2)
  assert.equal(result.status, 200)
  assert.equal(result.url, 'https://meshmail.ai/.well-known/aamp')
  assert.deepEqual(result.dns, [
    { address: '23.49.104.211', family: 4 },
    { address: '2600:1406:bc00::1', family: 6 },
  ])
  assert.deepEqual(result.proxyEnvPresent, ['HTTPS_PROXY', 'NO_PROXY'])
  assert.equal(JSON.stringify(attempts).includes('proxy.example'), false)
  assert.deepEqual(attempts.map(({ attempt, status, category }) => ({ attempt, status, category })), [
    { attempt: 1, status: 503, category: 'http_5xx' },
    { attempt: 2, status: 200, category: 'ok' },
  ])
})

test('endpoint probe bounds DNS diagnostics and releases response bodies', { timeout: 500 }, async () => {
  assert.equal(typeof runtimeNetwork?.probeEndpoint, 'function')

  await assert.rejects(
    runtimeNetwork.probeEndpoint('https://meshmail.ai/.well-known/aamp', {
      maxAttempts: 1,
      timeoutMs: 10,
      lookup: async () => new Promise(() => {}),
      fetchImpl: async () => assert.fail('fetch must not run while DNS lookup is stuck'),
    }),
    (error) => error?.code === 'ETIMEDOUT' && error?.syscall === 'dns.lookup',
  )

  let cancelled = 0
  await runtimeNetwork.probeEndpoint('https://meshmail.ai/.well-known/aamp', {
    maxAttempts: 1,
    timeoutMs: 50,
    lookup: async () => [{ address: '23.49.104.211', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: { cancel: async () => { cancelled += 1 } },
    }),
  })
  assert.equal(cancelled, 1)
})

test('serialized line writer flushes fast child output in order', async () => {
  assert.equal(typeof runtimeNetwork?.createSerializedLineWriter, 'function')

  const written = []
  const writer = runtimeNetwork.createSerializedLineWriter(async (line) => {
    await new Promise((resolve) => setTimeout(resolve, line === 'first' ? 5 : 0))
    written.push(line)
  })
  writer.write('first')
  writer.write('second')
  await writer.flush()

  assert.deepEqual(written, ['first', 'second'])
})

test('controller retries real bridge stages without an independent AAMP preflight gate', () => {
  assert.match(controller, /probeEndpoint/)
  assert.doesNotMatch(controller, /probeAampNetwork/)
  assert.doesNotMatch(controller, /aamp-preflight/)
  assert.doesNotMatch(controller, /await probeFailureEndpoints/)
  assert.match(controller, /launchDetachedDiagnostic\(\(\) => probeFailureEndpoints/)
  assert.match(controller, /stage: 'acp-init'/)
  assert.match(controller, /stage: 'acp-start'/)
  assert.match(controller, /agentStartRetryError/)
  assert.match(controller, /stage: 'feishu-start'/)
  assert.match(controller, /https:\/\/open\.feishu\.cn\//)
  assert.match(controller, /type: 'bridge\.process'/)
  assert.match(controller, /withNetworkRetry/)
  assert.match(controller, /createSerializedLineWriter/)
})

test('install output keeps the final summary without redundant per-binding success lines', () => {
  assert.doesNotMatch(controller, /已完成绑定并启动：/)
  assert.doesNotMatch(controller, /已写入 \$\{result\.succeeded\.length\} 个绑定配置/)
  assert.match(controller, /已成功建立绑定并启动 \$\{result\.running\.length\}\/\$\{result\.selectedCount\} 个配置/)
  assert.match(controller, /保持终端打开，你可以给 agent 派发飞书任务/)
  assert.match(controller, /另有 \$\{failureCount\} 次选择或绑定失败/)
})
