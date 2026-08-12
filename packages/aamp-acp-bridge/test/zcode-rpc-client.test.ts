import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  assertZcodeProtocolV1,
  parseZcodeEnvelope,
} from '../src/zcode-acp/protocol.js'
import { ZCodeRpcClient } from '../src/zcode-acp/rpc-client.js'

const fakeZcodePath = fileURLToPath(new URL('fixtures/fake-zcode.mjs', import.meta.url))

interface FakeClient {
  client: ZCodeRpcClient
  recordPath: string
  exitPath: string
}

async function startFakeZcode(
  scenario: string,
  options: { requestTimeoutMs?: number; maxFrameBytes?: number } = {},
): Promise<FakeClient> {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-zcode-rpc-'))
  const recordPath = join(directory, 'requests.ndjson')
  const exitPath = join(directory, 'exit.txt')
  const client = new ZCodeRpcClient({
    cliPath: fakeZcodePath,
    env: {
      ...process.env,
      FAKE_ZCODE_SCENARIO: scenario,
      FAKE_ZCODE_RECORD_PATH: recordPath,
      FAKE_ZCODE_EXIT_PATH: exitPath,
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    maxFrameBytes: options.maxFrameBytes,
  })
  await client.start()
  return { client, recordPath, exitPath }
}

function readRecordedMessages(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return
    await delay(10)
  }
  assert.fail(`Timed out waiting for ${path}`)
}

test('exports a validated ZCode envelope parser and child client', async () => {
  const protocol = await import('../src/zcode-acp/protocol.js').catch(() => ({})) as {
    parseZcodeEnvelope?: unknown
  }
  const transport = await import('../src/zcode-acp/rpc-client.js').catch(() => ({})) as {
    ZCodeRpcClient?: unknown
  }

  assert.equal(typeof protocol.parseZcodeEnvelope, 'function')
  assert.equal(typeof transport.ZCodeRpcClient, 'function')
})

test('parses strict ZCode request, notification, success, and error envelopes', () => {
  assert.deepEqual(
    parseZcodeEnvelope({ id: 'server-1', method: 'session/read', params: { sessionId: 'sess_a' } }),
    { id: 'server-1', method: 'session/read', params: { sessionId: 'sess_a' } },
  )
  assert.deepEqual(
    parseZcodeEnvelope({ method: 'session/event', params: { seq: 1 } }),
    { method: 'session/event', params: { seq: 1 } },
  )
  assert.deepEqual(
    parseZcodeEnvelope({ id: 'client-1', result: { ok: true } }),
    { id: 'client-1', result: { ok: true } },
  )
  assert.deepEqual(
    parseZcodeEnvelope({ id: 'client-2', error: { code: -32603, message: 'failed' } }),
    { id: 'client-2', error: { code: -32603, message: 'failed' } },
  )
  assert.deepEqual(
    parseZcodeEnvelope({ id: 42, method: 'session/ping' }),
    { id: 42, method: 'session/ping' },
  )
  assert.deepEqual(
    parseZcodeEnvelope({ method: 'session/ready' }),
    { method: 'session/ready' },
  )
})

test('rejects JSON-RPC and ambiguous ZCode envelopes', () => {
  assert.throws(
    () => parseZcodeEnvelope({
      jsonrpc: '2.0',
      id: 'client-1',
      method: 'session/list',
      params: {},
    }),
    /must not contain jsonrpc/,
  )
  assert.throws(
    () => parseZcodeEnvelope({ id: 'client-1', result: {}, error: { message: 'failed' } }),
    /Invalid ZCode Protocol envelope/,
  )
  assert.throws(
    () => parseZcodeEnvelope({ method: '', params: {} }),
    /Invalid ZCode Protocol envelope/,
  )
  assert.throws(
    () => parseZcodeEnvelope({
      id: 'client-2',
      error: { code: 'model_config_missing', message: 'failed' },
    }),
    /Invalid ZCode Protocol envelope/,
  )
  assert.throws(
    () => parseZcodeEnvelope({
      id: 'client-2',
      error: { code: -32603, message: 'failed', stack: 'not allowed' },
    }),
    /Invalid ZCode Protocol envelope/,
  )
})

test('accepts only the confirmed ZCode Protocol v1 marker', () => {
  assert.doesNotThrow(() => assertZcodeProtocolV1({
    protocol: { name: 'ZCode Protocol', version: 1 },
  }, '0.16.1'))
  assert.throws(
    () => assertZcodeProtocolV1({
      protocol: { name: 'ZCode Protocol', version: 2 },
    }, '0.16.1'),
    /expected ZCode Protocol v1.*version 2.*CLI 0\.16\.1/,
  )
})

test('exposes the bounded child-client lifecycle', () => {
  const client = new ZCodeRpcClient({
    cliPath: new URL('fixtures/fake-zcode.mjs', import.meta.url).pathname,
  } as never) as unknown as Record<string, unknown>

  assert.equal(typeof client.start, 'function')
  assert.equal(typeof client.request, 'function')
  assert.equal(typeof client.notify, 'function')
  assert.equal(typeof client.onNotification, 'function')
  assert.equal(typeof client.onRequest, 'function')
  assert.equal(typeof client.onClose, 'function')
  assert.equal(typeof client.close, 'function')
})

test('notifies close listeners once when the child exits unexpectedly', async () => {
  const { client } = await startFakeZcode('crash')
  const errors: Error[] = []
  const unsubscribe = client.onClose((error) => errors.push(error))

  await assert.rejects(client.request('session/list', {}), /code 17/)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].name, 'ZCodeChildExitedError')
  assert.doesNotMatch(errors[0].message, /quoted-secret|json-secret/)
  unsubscribe()
  await client.close()
})

test('sends strict envelopes and correlates coalesced out-of-order responses', async (t) => {
  const { client, recordPath } = await startFakeZcode('coalesced-frames')
  t.after(() => client.close())

  const first = client.request<{ sessions: Array<{ sessionId: string }> }>('session/list', {})
  const second = client.request<{ sessions: Array<{ sessionId: string }> }>(
    'session/list',
    { limit: 1 },
  )

  assert.deepEqual(await Promise.all([first, second]), [
    { sessions: [{ sessionId: 'sess_first' }] },
    { sessions: [{ sessionId: 'sess_second' }] },
  ])
  assert.deepEqual(readRecordedMessages(recordPath), [
    { id: 'client-1', method: 'session/list', params: {} },
    { id: 'client-2', method: 'session/list', params: { limit: 1 } },
  ])
  assert.equal(readRecordedMessages(recordPath).some((message) => 'jsonrpc' in message), false)
})

test('parses a response split across stdout chunks', async (t) => {
  const { client } = await startFakeZcode('split-frames')
  t.after(() => client.close())

  assert.deepEqual(await client.request('session/list', {}), { sessions: [] })
})

test('dispatches notifications without confusing request correlation', async (t) => {
  const { client } = await startFakeZcode('notification')
  t.after(() => client.close())
  const event = new Promise<Record<string, unknown>>((resolve) => {
    client.onNotification((notification) => resolve(notification as unknown as Record<string, unknown>))
  })

  assert.deepEqual(await client.request('session/list', {}), { sessions: [] })
  assert.deepEqual(await event, {
    method: 'session/event',
    params: { sessionId: 'sess_fake', seq: 1, type: 'session.updated' },
  })
})

test('answers inbound runtime-preference requests with the original server ID', async (t) => {
  const { client, recordPath } = await startFakeZcode('runtime-preferences')
  t.after(() => client.close())
  client.onRequest(async (request) => {
    assert.equal(request.method, 'session/requestRuntimePreferences')
    await request.respond({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: 'preflight-v1',
    })
  })

  const result = await client.request('session/create', { persistence: 'deferred' })
  assert.deepEqual(result, {
    protocol: { name: 'ZCode Protocol', version: 1 },
    session: { sessionId: 'sess_fake' },
  })
  assert.deepEqual(readRecordedMessages(recordPath)[1], {
    id: 'server-1',
    result: {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: 'preflight-v1',
    },
  })
})

test('records notifications without adding a request ID', async (t) => {
  const { client, recordPath } = await startFakeZcode('happy')
  t.after(() => client.close())

  await client.notify('session/stop', { sessionId: 'sess_fake' })
  await waitForFile(recordPath)
  assert.deepEqual(readRecordedMessages(recordPath), [
    { method: 'session/stop', params: { sessionId: 'sess_fake' } },
  ])
})

test('rejects a timed-out request with operation context', async (t) => {
  const { client } = await startFakeZcode('timeout', { requestTimeoutMs: 30 })
  t.after(() => client.close())

  await assert.rejects(
    client.request('session/read', { sessionId: 'sess_timeout' }),
    (error: Error) => {
      assert.equal(error.name, 'ZCodeRequestTimeoutError')
      assert.match(error.message, /session\/read.*30ms/)
      return true
    },
  )
})

test('maps a ZCode error response into a typed request error', async (t) => {
  const { client } = await startFakeZcode('protocol-error')
  t.after(() => client.close())

  await assert.rejects(
    client.request('session/create', {}),
    (error: Error & { code?: unknown; data?: unknown }) => {
      assert.equal(error.name, 'ZCodeRpcError')
      assert.equal(error.code, -32603)
      assert.deepEqual(error.data, {
        code: 'model_config_missing',
        authorization: 'super-secret',
      })
      return true
    },
  )
})

test('rejects malformed and oversized frames', async (t) => {
  const malformed = await startFakeZcode('malformed')
  t.after(() => malformed.client.close())
  await assert.rejects(
    malformed.client.request('session/list', {}),
    /Invalid JSON from ZCode app-server/,
  )

  const oversized = await startFakeZcode('oversized', { maxFrameBytes: 256 })
  t.after(() => oversized.client.close())
  await assert.rejects(
    oversized.client.request('session/list', {}),
    /exceeded 256 bytes/,
  )
})

test('redacts bounded child stderr when the child crashes', async (t) => {
  const { client } = await startFakeZcode('crash')
  t.after(() => client.close())

  await assert.rejects(
    client.request('session/list', {}),
    (error: Error) => {
      assert.equal(error.name, 'ZCodeChildExitedError')
      assert.match(error.message, /code 17/)
      assert.doesNotMatch(error.message, /quoted-secret|json-secret/)
      assert.match(error.message, /\[REDACTED\]/)
      return true
    },
  )
})

test('close is idempotent and rejects a pending request exactly once', async () => {
  const { client, exitPath } = await startFakeZcode('timeout')
  let rejectionCount = 0
  const pending = client.request('session/list', {}).catch((error: unknown) => {
    rejectionCount += 1
    throw error
  })
  const rejected = assert.rejects(pending, /closed/)

  await Promise.all([client.close(), client.close(), rejected])
  assert.equal(rejectionCount, 1)
  await waitForFile(exitPath)
})
