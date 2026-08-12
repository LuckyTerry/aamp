import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(testDirectory, '..')
const cliPath = resolve(packageDirectory, 'src/zcode-acp-cli.ts')
const fakeZcodePath = resolve(testDirectory, 'fixtures/fake-zcode.mjs')

interface CapturedProcess {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): CapturedProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      AAMP_ZCODE_CLI_PATH: fakeZcodePath,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const captured: CapturedProcess = {
    child,
    stdout: '',
    stderr: '',
    closed: new Promise((resolveClosed, rejectClosed) => {
      child.once('error', rejectClosed)
      child.once('close', (code, signal) => resolveClosed({ code, signal }))
    }),
  }
  child.stdout.on('data', (chunk: Buffer) => {
    captured.stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    captured.stderr += chunk.toString()
  })
  return captured
}

async function waitForExit(
  captured: CapturedProcess,
  timeoutMs = 3000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    captured.closed,
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      captured.child.kill('SIGKILL')
      throw new Error(`CLI did not exit within ${timeoutMs}ms`)
    }),
  ])
}

async function waitFor(
  predicate: () => boolean,
  captured: CapturedProcess,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    if (captured.child.exitCode !== null || captured.child.signalCode !== null) {
      assert.fail(`${description}; process exited with stderr: ${captured.stderr}`)
    }
    await delay(5)
  }
  assert.fail(`Timed out waiting for ${description}`)
}

function jsonLines(output: string): Array<Record<string, unknown>> {
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function initializeRequest(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    },
  })
}

test('prints the packaged ZCode ACP version and help', async () => {
  const version = spawnCli(['--version'])
  assert.deepEqual(await waitForExit(version), { code: 0, signal: null })
  assert.equal(version.stdout, '0.1.29\n')
  assert.equal(version.stderr, '')

  const help = spawnCli(['--help'])
  assert.deepEqual(await waitForExit(help), { code: 0, signal: null })
  assert.match(help.stdout, /aamp-zcode-acp serve/)
  assert.match(help.stdout, /AAMP_ZCODE_CLI_PATH/)
  assert.equal(help.stderr, '')
})

test('rejects an unknown command with stderr only', async () => {
  const captured = spawnCli(['unknown'])
  assert.deepEqual(await waitForExit(captured), { code: 2, signal: null })
  assert.equal(captured.stdout, '')
  assert.match(captured.stderr, /Unknown command: unknown/)
})

test('serves split ACP input on clean stdout and closes the child on EOF', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-cli-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const exitPath = join(temporaryDirectory, 'child-exit')
  const captured = spawnCli(['serve'], {
    FAKE_ZCODE_DIAGNOSTIC: '1',
    FAKE_ZCODE_EXIT_PATH: exitPath,
  })
  const input = `${initializeRequest()}\n`
  const split = Math.floor(input.length / 2)
  captured.child.stdin.write(input.slice(0, split))
  await delay(5)
  captured.child.stdin.write(input.slice(split))
  await waitFor(
    () => captured.stdout.includes('\n'),
    captured,
    'ACP initialize response',
  )
  captured.child.stdin.end()

  assert.deepEqual(await waitForExit(captured), { code: 0, signal: null })
  const messages = jsonLines(captured.stdout)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].jsonrpc, '2.0')
  assert.equal(messages[0].id, 1)
  assert.deepEqual(
    (messages[0].result as Record<string, unknown>).agentInfo,
    { name: 'aamp-zcode-acp', version: '0.1.29' },
  )
  assert.doesNotMatch(captured.stdout, /fake ZCode diagnostic/)
  assert.equal(existsSync(exitPath), true)
})

test('SIGTERM closes the ZCode child and exits within the bound', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-signal-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const startPath = join(temporaryDirectory, 'child-start')
  const exitPath = join(temporaryDirectory, 'child-exit')
  const captured = spawnCli(['serve'], {
    FAKE_ZCODE_START_PATH: startPath,
    FAKE_ZCODE_EXIT_PATH: exitPath,
  })
  await waitFor(
    () => existsSync(startPath),
    captured,
    'fake ZCode startup',
  )
  captured.child.kill('SIGTERM')

  assert.deepEqual(await waitForExit(captured, 2000), { code: 0, signal: null })
  assert.equal(existsSync(exitPath), true)
  assert.equal(readFileSync(exitPath, 'utf8'), readFileSync(startPath, 'utf8'))
})

test('malformed ZCode output closes ACP with an error and no child remains', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-bad-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const exitPath = join(temporaryDirectory, 'child-exit')
  const captured = spawnCli(['serve'], {
    FAKE_ZCODE_SCENARIO: 'malformed',
    FAKE_ZCODE_EXIT_PATH: exitPath,
  })
  captured.child.stdin.write(`${initializeRequest()}\n`)
  await waitFor(
    () => captured.stdout.includes('\n'),
    captured,
    'ACP initialize response',
  )
  captured.child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/list',
    params: {},
  })}\n`)

  assert.deepEqual(await waitForExit(captured), { code: 1, signal: null })
  assert.match(captured.stderr, /Invalid JSON from ZCode app-server/)
  assert.equal(captured.stdout.includes('not-json'), false)
  assert.doesNotThrow(() => jsonLines(captured.stdout))
  assert.equal(existsSync(exitPath), true)
})
