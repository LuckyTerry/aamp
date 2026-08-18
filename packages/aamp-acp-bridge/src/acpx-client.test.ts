import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpxClient, selectFinalAssistantOutput } from './acpx-client.js'

const tempDirectories: string[] = []
const testDirectory = dirname(fileURLToPath(import.meta.url))

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createFakeAcpx(mode: 'success' | 'auth-failure' | 'auth-with-output' | 'json-auth-failure' | 'json-aime-auth-failure' | 'json-aime-sources' | 'auth-discussion' | 'timeout' | 'close-retry'): { cwd: string; logFile: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'aamp-acpx-readiness-test-'))
  tempDirectories.push(cwd)
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const logFile = join(cwd, 'acpx.log')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'acpx'), `#!/bin/sh
printf '%s\\n' "$*" >> "${logFile}"
case "${mode}:$*" in
  auth-failure:*" prompt "*)
    printf '%s\\n' 'Authentication required. Please use /login command to sign in to your account' >&2
    exit 0
    ;;
  auth-with-output:*" prompt "*)
    printf '%s\\n' 'partial assistant reply'
    printf '%s\\n' 'warning: session disconnected' >&2
    printf '%s\\n' '[error] Authentication required' >&2
    exit 0
    ;;
  json-auth-failure:*" prompt "*)
    printf '%s\\n' 'partial assistant reply'
    printf '%s\\n' '{"jsonrpc":"2.0","id":"1","error":{"message":"Authentication required"}}'
    exit 0
    ;;
  json-aime-auth-failure:*" prompt "*)
    printf '%s\\n' '{"jsonrpc":"2.0","id":"1","error":{"code":-32001,"message":"Managed user authentication is required. Run \`aime-acp auth login --site cn\`.","data":{"code":"AUTH_REQUIRED","retryable":false}}}'
    exit 0
    ;;
  json-aime-sources:*" prompt "*)
    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"aamp-aime","update":{"sessionUpdate":"agent_message_chunk","messageId":"aime-sources","content":{"type":"text","text":"AAMP_RESULT_JSON: {\\"output\\":\\"FEISHU_TASK_RESULT_JSON: {\\\\\\"schema\\\\\\":\\\\\\"feishu_task_result.v2\\\\\\",\\\\\\"status\\\\\\":\\\\\\"answered\\\\\\",\\\\\\"summary\\\\\\":\\\\\\"成都天气\\\\\\",\\\\\\"reply_written\\\\\\":false}\\"}"}}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"aamp-aime","update":{"sessionUpdate":"agent_message_chunk","messageId":"aime-sources","_meta":{"aime.acp.message_kind":"sources"},"content":{"type":"text","text":"Sources:\\n- [Guide](https://example.test/guide)"}}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":"1","result":{"stopReason":"end_turn"}}'
    exit 0
    ;;
  auth-discussion:*" prompt "*)
    printf '%s\\n' 'The phrase authentication required may appear in diagnostic logs.'
    exit 0
    ;;
  auth-failure:*"sessions new"*)
    printf '%s\\n' 'Authentication required' >&2
    exit 1
    ;;
  timeout:*"sessions new"*)
    sleep 5
    exit 0
    ;;
  close-retry:*"sessions close"*)
    close_count_file="${cwd}/close-count"
    close_count=0
    if [ -f "$close_count_file" ]; then close_count=$(cat "$close_count_file"); fi
    close_count=$((close_count + 1))
    printf '%s\\n' "$close_count" > "$close_count_file"
    if [ "$close_count" -eq 1 ]; then
      printf '%s\\n' 'temporary cleanup failure' >&2
      exit 1
    fi
    printf '%s\\n' 'probe-session-id'
    exit 0
    ;;
  *"sessions new"*)
    printf '%s\\n' 'probe-session-id'
    exit 0
    ;;
  *"sessions close"*)
    printf '%s\\n' 'probe-session-id'
    exit 0
    ;;
esac
exit 0
`)
  chmodSync(join(binDirectory, 'acpx'), 0o755)
  return { cwd, logFile }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForState(statePath: string, state: string): Promise<number> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      const record = readFileSync(statePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid?: unknown; state?: unknown })
        .find((entry) => entry.state === state)
      if (record && Number.isSafeInteger(record.pid) && (record.pid as number) > 1) {
        return record.pid as number
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for child state ${state}`)
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (processExists(pid)) throw new Error('owned fixture process did not exit')
}

function createTermResistantAcpx(): { cwd: string; statePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'aamp-acpx-stop-test-'))
  tempDirectories.push(cwd)
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const statePath = join(cwd, 'child-state.jsonl')
  const fixturePath = join(testDirectory, '..', 'test', 'acpx-stop-ignore-term-child.mjs')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'acpx'), [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} ${shellQuote(statePath)}`,
    '',
  ].join('\n'))
  chmodSync(join(binDirectory, 'acpx'), 0o755)
  return { cwd, statePath }
}

test('stop waits for a TERM-resistant owned child to close after SIGKILL', { timeout: 10_000 }, async () => {
  const { cwd, statePath } = createTermResistantAcpx()
  const client = new AcpxClient(cwd)
  const execution = client.ensureSession('fake-agent --acp', 'stop-owned-child')
  const executionOutcome = execution.then(
    () => ({ kind: 'fulfilled' as const }),
    () => ({ kind: 'rejected' as const }),
  )
  let pid = 0

  try {
    pid = await waitForState(statePath, 'ready')
    let stopSettled = false
    const stopping = Promise.resolve(client.stop()).finally(() => {
      stopSettled = true
    })
    await waitForState(statePath, 'sigterm-ignored')

    assert.equal(stopSettled, false, 'stop must retain ownership until child close')
    assert.equal(processExists(pid), true, 'TERM-resistant fixture must still be alive before KILL')
    await stopping
    assert.equal(processExists(pid), false, 'stop must settle only after the owned PID is gone')
    assert.equal((await executionOutcome).kind, 'rejected')
  } finally {
    if (pid > 1 && processExists(pid)) {
      try { process.kill(-pid, 'SIGKILL') } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* exact owned fixture cleanup */ }
      }
      await waitForProcessExit(pid)
    }
    await executionOutcome
  }
})

test('stop is safe after a child has already closed normally', async () => {
  const { cwd } = createFakeAcpx('success')
  const client = new AcpxClient(cwd)

  await client.ensureSession('fake-agent --acp', 'normally-closed-child')
  await Promise.resolve(client.stop())
})

test('probeAgent creates a fresh ACP session and closes it after success', async () => {
  const { cwd, logFile } = createFakeAcpx('success')
  const client = new AcpxClient(cwd)

  await client.probeAgent('fake-agent --acp', {
    sessionName: 'aamp-readiness-probe-test',
    timeoutMs: 5_000,
  })

  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
    `--approve-all --cwd ${cwd} --agent fake-agent --acp sessions new --name aamp-readiness-probe-test`,
    `--approve-all --cwd ${cwd} --agent fake-agent --acp sessions close aamp-readiness-probe-test`,
  ])
})

test('probeAgent preserves authentication failures and does not close a session that was not created', async () => {
  const { cwd, logFile } = createFakeAcpx('auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.probeAgent('fake-agent --acp', {
      sessionName: 'aamp-readiness-auth-failure',
      timeoutMs: 5_000,
    }),
    /Authentication required/,
  )

  const commands = readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(commands.length, 1)
  assert.match(commands[0], /sessions new --name aamp-readiness-auth-failure$/)
})

test('probeAgent times out instead of hanging bridge startup', async () => {
  const { cwd, logFile } = createFakeAcpx('timeout')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.probeAgent('fake-agent --acp', {
      sessionName: 'aamp-readiness-timeout',
      timeoutMs: 1_000,
    }),
    /timed out after 1000ms/,
  )

  assert.match(
    readFileSync(logFile, 'utf8'),
    /sessions close aamp-readiness-timeout/,
  )
})

test('probeAgent retries cleanup after a temporary close failure', async () => {
  const { cwd, logFile } = createFakeAcpx('close-retry')
  const client = new AcpxClient(cwd)

  await client.probeAgent('fake-agent --acp', {
    sessionName: 'aamp-readiness-close-retry',
    timeoutMs: 5_000,
  })

  const closeCommands = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((command) => command.includes('sessions close'))
  assert.equal(closeCommands.length, 2)
})

test('prompt rejects an authentication message even when the agent exits successfully', async () => {
  const { cwd } = createFakeAcpx('auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /Authentication required/,
  )
})

test('prompt rejects a stderr authentication line even after partial stdout and warnings', async () => {
  const { cwd } = createFakeAcpx('auth-with-output')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /^Error: Authentication required$/,
  )
})

test('prompt rejects a bare authentication message from a JSON-RPC error', async () => {
  const { cwd } = createFakeAcpx('json-auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /^Error: Authentication required$/,
  )
})

test('prompt rejects a structured AIME AUTH_REQUIRED response with safe login guidance', async () => {
  const { cwd } = createFakeAcpx('json-aime-auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-aime', 'hello'),
    {
      message: 'AUTH_REQUIRED: Managed user authentication is required. Run `aime-acp auth login --site cn`.',
    },
  )
})

test('prompt preserves normal replies that merely discuss authentication errors', async () => {
  const { cwd } = createFakeAcpx('auth-discussion')
  const client = new AcpxClient(cwd)

  const result = await client.prompt('fake-agent --acp', 'aamp-workbuddy', 'explain auth errors')

  assert.equal(result.output, 'The phrase authentication required may appear in diagnostic logs.')
})

test('final assistant selection does not reserve the AIME Sources message id by itself', () => {
  const messages = new Map([
    ['aime-sources', 'AAMP_RESULT_JSON: legitimate final answer'],
  ])

  assert.equal(
    selectFinalAssistantOutput(messages, ['aime-sources']),
    'AAMP_RESULT_JSON: legitimate final answer',
  )
})

test('prompt excludes only meta-marked AIME Sources while preserving the original protocol result', async () => {
  const { cwd } = createFakeAcpx('json-aime-sources')
  const client = new AcpxClient(cwd)
  const chunks: string[] = []

  const result = await client.prompt('fake-agent --acp', 'aamp-aime', 'weather', {
    onTextChunk: ({ text }) => chunks.push(text),
  })

  assert.equal(
    result.output,
    'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\",\\"summary\\":\\"成都天气\\",\\"reply_written\\":false}"}',
  )
  assert.equal(JSON.parse(result.output.slice('AAMP_RESULT_JSON: '.length)).output.startsWith('FEISHU_TASK_RESULT_JSON: '), true)
  assert.deepEqual(chunks, [
    result.output,
    'Sources:\n- [Guide](https://example.test/guide)',
  ])
})
