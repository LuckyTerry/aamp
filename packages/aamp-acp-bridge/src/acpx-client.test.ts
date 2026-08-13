import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { AcpxClient } from './acpx-client.js'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createFakeAcpx(mode: 'success' | 'auth-failure' | 'auth-with-output' | 'json-auth-failure' | 'auth-discussion' | 'timeout' | 'close-retry'): { cwd: string; logFile: string } {
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

test('prompt preserves normal replies that merely discuss authentication errors', async () => {
  const { cwd } = createFakeAcpx('auth-discussion')
  const client = new AcpxClient(cwd)

  const result = await client.prompt('fake-agent --acp', 'aamp-workbuddy', 'explain auth errors')

  assert.equal(result.output, 'The phrase authentication required may appear in diagnostic logs.')
})
