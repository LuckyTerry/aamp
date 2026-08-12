import assert from 'node:assert/strict'
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { missingAgentWarning } from '../src/agent-resolver.js'
import { discoverAcpBridgeAgents } from '../src/discovery.js'
import { runJsonInit } from '../src/json-init.js'
import { ZCODE_CLI_OVERRIDE } from '../src/zcode-acp/app-locator.js'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(testDirectory, '..')
const indexPath = resolve(packageDirectory, 'src/index.ts')
const fakeZcodePath = resolve(testDirectory, 'fixtures/fake-zcode.mjs')

interface CapturedProcess {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function captureProcess(child: ChildProcessWithoutNullStreams): CapturedProcess {
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

async function waitForOutput(
  captured: CapturedProcess,
  value: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (captured.stdout.includes(value)) return
    if (captured.child.exitCode !== null || captured.child.signalCode !== null) {
      assert.fail(`Process exited before ${JSON.stringify(value)}: ${captured.stderr}`)
    }
    await delay(5)
  }
  assert.fail(`Timed out waiting for ${JSON.stringify(value)}`)
}

async function waitForExit(
  captured: CapturedProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    captured.closed,
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      captured.child.kill('SIGKILL')
      throw new Error(`Process did not exit within ${timeoutMs}ms`)
    }),
  ])
}

function writeCredentials(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    email: 'zcode-test@example.com',
    smtpPassword: 'test-password',
  }))
}

test('discovers embedded ZCode and preserves an existing custom command', (t) => {
  const previousOverride = process.env[ZCODE_CLI_OVERRIDE]
  process.env[ZCODE_CLI_OVERRIDE] = fakeZcodePath
  t.after(() => {
    if (previousOverride === undefined) delete process.env[ZCODE_CLI_OVERRIDE]
    else process.env[ZCODE_CLI_OVERRIDE] = previousOverride
  })
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-discover-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const configPath = join(temporaryDirectory, 'config.json')

  const discovered = discoverAcpBridgeAgents(configPath)
  const zcode = discovered.candidates.find((candidate) => candidate.id === 'zcode')
  assert.deepEqual(zcode, {
    id: 'zcode',
    displayName: 'zcode',
    connection: 'acp_bridge',
    detected: true,
    configured: false,
    confidence: 'high',
    command: fakeZcodePath,
    acpCommand: 'aamp-zcode-acp serve',
    version: '0.16.1',
    warnings: [],
  })

  writeFileSync(configPath, JSON.stringify({
    aampHost: 'http://127.0.0.1:1',
    rejectUnauthorized: false,
    agents: [{
      name: 'zcode',
      acpCommand: fakeZcodePath,
      credentialsFile: join(temporaryDirectory, 'credentials.json'),
    }],
  }))
  assert.equal(
    discoverAcpBridgeAgents(configPath).candidates
      .find((candidate) => candidate.id === 'zcode')?.acpCommand,
    fakeZcodePath,
  )
})

test('JSON init creates ZCode with the sibling command without registration', async (t) => {
  const previousOverride = process.env[ZCODE_CLI_OVERRIDE]
  process.env[ZCODE_CLI_OVERRIDE] = fakeZcodePath
  t.after(() => {
    if (previousOverride === undefined) delete process.env[ZCODE_CLI_OVERRIDE]
    else process.env[ZCODE_CLI_OVERRIDE] = previousOverride
  })
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-json-init-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const configPath = join(temporaryDirectory, 'config.json')
  const credentialsPath = join(temporaryDirectory, 'zcode-credentials.json')
  writeCredentials(credentialsPath)

  const result = await runJsonInit(configPath, {
    aampHost: 'http://127.0.0.1:1',
    agents: [{ name: 'zcode', credentialsFile: credentialsPath }],
  })
  assert.deepEqual(result.agents.map((agent) => ({
    name: agent.name,
    registered: agent.registered,
    acpCommand: agent.acpCommand,
  })), [{
    name: 'zcode',
    registered: false,
    acpCommand: 'aamp-zcode-acp serve',
  }])
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    agents: Array<{ acpCommand: string }>
  }
  assert.equal(config.agents[0].acpCommand, 'aamp-zcode-acp serve')
})

test('interactive init --agent zcode --no-start writes the sibling command', async (t) => {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'aamp-zcode-home-'))
  t.after(() => rmSync(temporaryHome, { recursive: true, force: true }))
  const configPath = join(temporaryHome, 'config.json')
  writeCredentials(join(
    temporaryHome,
    '.aamp',
    'acp-bridge',
    'credentials',
    'zcode.json',
  ))
  const captured = captureProcess(spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      indexPath,
      'init',
      '--agent',
      'zcode',
      '--no-start',
      '--config',
      configPath,
    ],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        HOME: temporaryHome,
        AAMP_ZCODE_CLI_PATH: fakeZcodePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ))
  await waitForOutput(captured, 'AAMP Service URL')
  captured.child.stdin.write('http://127.0.0.1:1\n')
  await waitForOutput(captured, 'How should zcode authorize senders?')
  captured.child.stdin.end('3\n')

  assert.deepEqual(await waitForExit(captured), { code: 0, signal: null })
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    agents: Array<{ name: string; acpCommand: string }>
  }
  assert.deepEqual(config.agents.map(({ name, acpCommand }) => ({
    name,
    acpCommand,
  })), [{ name: 'zcode', acpCommand: 'aamp-zcode-acp serve' }])
  assert.match(captured.stdout, /Bridge not started because --no-start was provided/)
})

test('help, missing-app guidance, and README expose the one-step contract', async () => {
  const warning = missingAgentWarning('zcode')
  assert.match(
    warning,
    /\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs/,
  )
  assert.match(warning, /AAMP_ZCODE_CLI_PATH/)

  const help = captureProcess(spawn(
    process.execPath,
    ['--import', 'tsx', indexPath, 'help'],
    { cwd: packageDirectory, stdio: ['pipe', 'pipe', 'pipe'] },
  ))
  help.child.stdin.end()
  assert.deepEqual(await waitForExit(help), { code: 0, signal: null })
  assert.match(help.stdout, /npx aamp-acp-bridge init --agent zcode/)

  const readme = readFileSync(resolve(packageDirectory, 'README.md'), 'utf8')
  for (const expected of [
    'npx aamp-acp-bridge init --agent zcode',
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    'AAMP_ZCODE_CLI_PATH',
    'aamp-zcode-acp serve',
    'model_config_missing',
    'additionalDirectories',
    'stderr',
  ]) {
    assert.ok(readme.includes(expected), `README is missing ${expected}`)
  }
})

test('npm tarball clean-installs both bins and serves ACP initialize', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aamp-zcode-pack-'))
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: packageDirectory, encoding: 'utf8', timeout: 60_000 },
  )
  const packed = JSON.parse(packOutput) as Array<{
    filename: string
    files: Array<{ path: string }>
  }>
  assert.equal(packed.length, 1)
  assert.ok(packed[0].files.some((file) => file.path === 'dist/zcode-acp-cli.js'))
  const tarballPath = join(temporaryDirectory, packed[0].filename)
  const packedManifest = JSON.parse(execFileSync(
    'tar',
    ['-xOf', tarballPath, 'package/package.json'],
    { encoding: 'utf8' },
  )) as { bin: Record<string, string> }
  assert.deepEqual(packedManifest.bin, {
    'aamp-acp-bridge': 'dist/index.js',
    'aamp-zcode-acp': 'dist/zcode-acp-cli.js',
  })

  const installDirectory = join(temporaryDirectory, 'install')
  mkdirSync(installDirectory)
  writeFileSync(join(installDirectory, 'package.json'), JSON.stringify({
    name: 'zcode-clean-install-test',
    version: '1.0.0',
    private: true,
  }))
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: installDirectory, stdio: 'pipe', timeout: 120_000 },
  )
  const bridgeBin = join(installDirectory, 'node_modules/.bin/aamp-acp-bridge')
  const zcodeBin = join(installDirectory, 'node_modules/.bin/aamp-zcode-acp')
  assert.equal(existsSync(bridgeBin), true)
  assert.equal(existsSync(zcodeBin), true)
  assert.equal(execFileSync(zcodeBin, ['--version'], {
    cwd: installDirectory,
    encoding: 'utf8',
  }), '0.1.29\n')

  const served = captureProcess(spawn(zcodeBin, ['serve'], {
    cwd: installDirectory,
    env: { ...process.env, AAMP_ZCODE_CLI_PATH: fakeZcodePath },
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  served.child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
  })}\n`)
  assert.deepEqual(await waitForExit(served), { code: 0, signal: null })
  const response = JSON.parse(served.stdout.trim()) as {
    result: { agentInfo: { name: string; version: string } }
  }
  assert.deepEqual(response.result.agentInfo, {
    name: 'aamp-zcode-acp',
    version: '0.1.29',
  })
})
