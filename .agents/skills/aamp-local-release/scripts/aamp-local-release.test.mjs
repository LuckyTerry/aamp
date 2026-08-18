import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyBin } from './aamp-local-release.mjs'
import { acquireReleaseLock } from '../../shared/release-lock.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.join(scriptDir, 'aamp-local-release.mjs')
const sharedLockPath = path.resolve(scriptDir, '..', '..', 'shared', 'release-lock.mjs')
const skillPath = path.resolve(scriptDir, '..', 'SKILL.md')
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..')
const realNpmPath = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim()

function runHelper(args, options = {}) {
  const selectedHelperPath = options.helperPath || options.env?.AAMP_LOCAL_RELEASE_TEST_HELPER || helperPath
  const { helperPath: _helperPath, ...spawnOptions } = options
  return spawnSync(process.execPath, [selectedHelperPath, ...args], {
    encoding: 'utf8',
    ...spawnOptions,
  })
}

function writeFixturePackage(root, relativeDir, manifest) {
  const packageDir = path.join(root, relativeDir)
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const bins = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : manifest.bin
  for (const relativeBin of Object.values(bins || {})) {
    const binPath = path.join(packageDir, relativeBin)
    fs.mkdirSync(path.dirname(binPath), { recursive: true })
    fs.writeFileSync(binPath, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 })
  }
}

function writeTaskAgentPinSources(root, overrides = {}) {
  const {
    publicRegistry = 'https://registry.npmjs.org/',
    acpBridgePin = '@zengxingyuan/aamp-acp-bridge@0.1.28-dev.36',
    feishuBridgePin = '@zengxingyuan/aamp-feishu-bridge@0.1.51',
    aimeAcpPin = '@tengchengwei/aime-acp@0.1.1-dev.1',
    aimeRegistry = 'https://bnpm.byted.org',
    taskAgentDefaultName = '@luckyterry/aamp-feishu-task-agent',
    controllerAcpBridgePin = acpBridgePin,
    controllerFeishuBridgePin = feishuBridgePin,
  } = overrides

  const bootstrapPath = path.join(
    root,
    'packages',
    'aamp-feishu-task-agent',
    'bootstrap',
    'aamp-feishu-task-agent-bootstrap.sh',
  )
  const controllerPath = path.join(
    root,
    'packages',
    'aamp-feishu-task-agent',
    'bin',
    'feishu-task-agent-controller.mjs',
  )

  fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true })
  fs.mkdirSync(path.dirname(controllerPath), { recursive: true })
  fs.writeFileSync(bootstrapPath, `#!/usr/bin/env bash
NPM_REGISTRY="\${NPM_REGISTRY:-${publicRegistry}}"
ACP_BRIDGE_PKG="\${ACP_BRIDGE_PKG:-${acpBridgePin}}"
AIME_ACP_PKG="\${AIME_ACP_PKG:-${aimeAcpPin}}"
AIME_ACP_REGISTRY="\${AIME_ACP_REGISTRY:-${aimeRegistry}}"
FEISHU_BRIDGE_PKG="\${FEISHU_BRIDGE_PKG:-${feishuBridgePin}}"
AAMP_TASK_DEFAULT_ACP_BRIDGE_PKG="$ACP_BRIDGE_PKG"
AAMP_TASK_DEFAULT_FEISHU_BRIDGE_PKG="$FEISHU_BRIDGE_PKG"
AAMP_TASK_DEFAULT_AIME_ACP_PKG="$AIME_ACP_PKG"
AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-${taskAgentDefaultName}}"
aime_acp_registry() {
  printf '%s\\n' '${aimeRegistry}'
}
`, { mode: 0o755 })
  fs.writeFileSync(controllerPath, `const NPM_REGISTRY = process.env.AAMP_TASK_NPM_REGISTRY || '${publicRegistry}';
const ACP_PACKAGE = process.env.AAMP_TASK_ACP_BRIDGE_PKG || '${controllerAcpBridgePin}';
const FEISHU_PACKAGE = process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '${controllerFeishuBridgePin}';
export { NPM_REGISTRY, ACP_PACKAGE, FEISHU_PACKAGE };
`)
}

function createFakeNpm(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-local-release-test-'))
  const fixtureRepo = path.join(root, 'repo')
  const fakeNpm = path.join(root, 'npm')
  const log = path.join(root, 'npm-calls.jsonl')
  const taskAgentLog = path.join(root, 'task-agent-calls.jsonl')
  writeFixturePackage(fixtureRepo, 'packages/aime-acp', {
    name: '@fixture/aime-acp',
    version: '1.2.3-test.4',
    bin: { 'aime-acp': 'dist/bin.js' },
  })
  writeFixturePackage(fixtureRepo, 'packages/aamp-acp-bridge', {
    name: '@fixture/aamp-acp-bridge',
    version: '2.3.4-test.5',
    bin: { 'aamp-acp-bridge': 'dist/index.js' },
  })
  writeFixturePackage(fixtureRepo, 'packages/aamp-feishu-bridge', {
    name: '@fixture/aamp-feishu-bridge',
    version: '3.4.5-test.6',
    bin: { 'aamp-feishu-bridge': 'dist/index.js' },
  })
  writeFixturePackage(fixtureRepo, 'packages/aamp-feishu-task-agent', {
    name: '@fixture/aamp-feishu-task-agent',
    version: '4.5.6-test.7',
    bin: { 'feishu-task-agent': 'bootstrap/aamp-feishu-task-agent-bootstrap.sh' },
  })
  writeTaskAgentPinSources(fixtureRepo)
  const fixtureHelperPath = path.join(
    fixtureRepo,
    '.agents',
    'skills',
    'aamp-local-release',
    'scripts',
    'aamp-local-release.mjs',
  )
  const fixtureSharedLockPath = path.join(fixtureRepo, '.agents', 'skills', 'shared', 'release-lock.mjs')
  fs.mkdirSync(path.dirname(fixtureHelperPath), { recursive: true })
  fs.mkdirSync(path.dirname(fixtureSharedLockPath), { recursive: true })
  fs.copyFileSync(helperPath, fixtureHelperPath)
  fs.copyFileSync(sharedLockPath, fixtureSharedLockPath)
  const source = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const log = process.env.FAKE_NPM_LOG
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    args,
    cwd: process.cwd(),
    cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || (args.includes('--cache') ? args[args.indexOf('--cache') + 1] : ''),
  }) + '\n')
}
if (args[0] === 'run' && args[1] === 'build') {
  if (process.env.FAKE_BUILD_FAIL === '1') process.exit(41)
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  const bins = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : manifest.bin
  for (const relativeBin of Object.values(bins || {})) {
    const binPath = path.join(process.cwd(), relativeBin)
    fs.mkdirSync(path.dirname(binPath), { recursive: true })
    fs.writeFileSync(binPath, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 })
  }
  fs.mkdirSync(path.join(process.cwd(), 'dist'), { recursive: true })
  fs.writeFileSync(path.join(process.cwd(), 'dist', 'fake-build-marker.txt'), process.env.FAKE_BUILD_VARIANT || 'built')
  process.exit(0)
}
if (args[0] === 'pack') {
  if (process.env.FAKE_PACK_FAIL === '1') process.exit(42)
  const destination = args[args.indexOf('--pack-destination') + 1]
  fs.writeFileSync(path.join(process.cwd(), 'pack-variant.txt'), process.env.FAKE_PACK_VARIANT || 'stable')
  const packed = spawnSync(process.env.REAL_NPM_BIN, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  })
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr || packed.stdout || '')
    process.exit(packed.status || 1)
  }
  const artifacts = fs.readdirSync(destination).filter((name) => name.endsWith('.tgz'))
  if (process.env.FAKE_PACK_RENAME === '1' && artifacts.length === 1) {
    fs.renameSync(path.join(destination, artifacts[0]), path.join(destination, 'npm-output-was-renamed.tgz'))
  }
  if (process.env.FAKE_PACK_EXTRA_TGZ === '1') {
    fs.writeFileSync(path.join(destination, 'unexpected-extra.tgz'), 'extra')
  }
  if (process.env.FAKE_PACK_SILENT !== '1') process.stdout.write(packed.stdout || '')
  process.exit(0)
}
if (args[0] === 'install') {
  const prefix = args[args.indexOf('--prefix') + 1]
  const target = path.join(prefix, 'bin', 'feishu-task-agent')
  const launcher = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const action = process.argv[2] || ''",
    "const log = process.env.FAKE_TASK_AGENT_LOG",
    "if (log) fs.appendFileSync(log, JSON.stringify({ action, executable: process.argv[1], autoUpdate: process.env.AAMP_TASK_AUTO_UPDATE || '', allowOverrides: process.env.AAMP_TASK_ALLOW_PACKAGE_OVERRIDES || '', acp: process.env.ACP_BRIDGE_PKG || '', feishu: process.env.FEISHU_BRIDGE_PKG || '', aime: process.env.AIME_ACP_PKG || '', cache: process.env.NPM_CONFIG_CACHE || '', globalPrefix: process.env.NPM_GLOBAL_PREFIX || '', binDir: process.env.AAMP_BIN_DIR || '', commandName: process.env.AAMP_TASK_COMMAND_NAME || '', commandPath: process.env.AAMP_TASK_COMMAND_PATH || '', shimDir: process.env.AAMP_TASK_SHIM_DIR || '', agentName: process.env.AAMP_TASK_AGENT_NAME || '', agentLegacyName: process.env.AAMP_TASK_AGENT_LEGACY_NAME || '', agentChannel: process.env.AAMP_TASK_AGENT_CHANNEL || '', npmRegistry: process.env.NPM_REGISTRY || '', taskNpmRegistry: process.env.AAMP_TASK_NPM_REGISTRY || '', installCommand: process.env.AAMP_TASK_INSTALL_COMMAND || '', internal: process.env.AAMP_TASK_INTERNAL || '', overridesResolved: process.env.AAMP_TASK_PACKAGE_OVERRIDES_RESOLVED || '' }) + '\\n')",
    "if (action === 'update' && process.env.FAKE_TASK_AGENT_UPDATE_EXIT) process.exit(Number(process.env.FAKE_TASK_AGENT_UPDATE_EXIT))",
    "if (action === 'update' || action === 'start') { const shortCommand = path.join(process.env.HOME, '.aamp', 'bin', 'feishu-task-agent'); fs.mkdirSync(path.dirname(shortCommand), { recursive: true }); fs.copyFileSync(process.argv[1], shortCommand); fs.chmodSync(shortCommand, 0o755) }",
  ].join('\n') + '\n'
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, launcher, { mode: 0o755 })
  process.exit(0)
}
if (args[0] === 'exec') {
  const packageIndex = args.indexOf('--package')
  const separatorIndex = args.indexOf('--')
  const packagePath = packageIndex >= 0 ? args[packageIndex + 1] : ''
  const requestedBin = separatorIndex >= 0 ? args[separatorIndex + 1] : ''
  if (!path.isAbsolute(packagePath) || !packagePath.endsWith('.tgz') || !fs.existsSync(packagePath) || !requestedBin) {
    process.stderr.write('invalid fake npm exec package boundary\n')
    process.exit(64)
  }
  if (process.env.FAKE_VERIFY_FAIL === '1') process.exit(43)
  const verified = spawnSync(process.env.REAL_NPM_BIN, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  })
  process.stdout.write(verified.stdout || '')
  process.stderr.write(verified.stderr || '')
  process.exit(verified.status ?? 1)
}
if (args[0] === 'view') {
  const packageSpec = args[1] || ''
  const registryIndex = args.indexOf('--registry')
  const registry = registryIndex >= 0 ? args[registryIndex + 1] : ''
  const failures = String(process.env.FAKE_VIEW_FAIL_SPECS || '').split(',').filter(Boolean)
  if (failures.includes(packageSpec) || failures.includes(packageSpec + '|' + registry)) {
    process.stderr.write('missing package: ' + packageSpec + '\n')
    process.exit(44)
  }
  const versionIndex = packageSpec.lastIndexOf('@')
  const version = versionIndex > 0 ? packageSpec.slice(versionIndex + 1) : ''
  process.stdout.write(JSON.stringify(version) + '\n')
  process.exit(0)
}
process.exit(0)
`
  fs.writeFileSync(fakeNpm, source, { mode: 0o755 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, fixtureRepo, helperPath: fixtureHelperPath, fakeNpm, log, taskAgentLog }
}

function fakeNpmEnv(fake, extra = {}) {
  return {
    ...process.env,
    PATH: `${fake.root}${path.delimiter}${process.env.PATH}`,
    AAMP_LOCAL_RELEASE_TEST_HELPER: fake.helperPath,
    FAKE_NPM_LOG: fake.log,
    FAKE_TASK_AGENT_LOG: fake.taskAgentLog,
    REAL_NPM_BIN: realNpmPath,
    ...extra,
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function artifactStem(fixtureRepo, relativeDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRepo, relativeDir, 'package.json'), 'utf8'))
  return `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}`
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

test('local release helper never exposes a publish flag', () => {
  const help = execFileSync(process.execPath, [helperPath, '--help'], { encoding: 'utf8' })
  const source = fs.readFileSync(helperPath, 'utf8')

  assert.match(help, /--mode file\|tgz/)
  assert.match(help, /--pack/)
  assert.match(help, /Without publishing/i)
  assert.match(help, /never publishes/i)
  assert.doesNotMatch(source, /--publish/)
})

test('local release helper rejects unknown package keys', () => {
  const result = runHelper(['--package', 'bogus', '--plan-only'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown package key: bogus/)
})

test('local release plan-only prints a file: startup command for the selected bridge', () => {
  const result = runHelper(['--package', 'feishuBridge', '--plan-only'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /feishuBridge@/)
  assert.match(result.stdout, /FEISHU_BRIDGE_PKG="file:\$PWD\/packages\/aamp-feishu-bridge"/)
  assert.match(result.stdout, /\(\n  set -e/)
  assert.match(result.stdout, /unset ACP_BRIDGE_PKG.*FEISHU_BRIDGE_PKG/)
  assert.match(result.stdout, /AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true/)
  assert.match(result.stdout, /feishu-task-agent start/)
  assert.match(result.stdout, /aamp-local-runtime-npm-cache\.XXXXXX/)
  assert.match(result.stdout, /NPM_CONFIG_CACHE=/)
  assert.doesNotMatch(result.stdout, /export ACP_BRIDGE_PKG/)
})

test('local release plan-only prints both explicitly selected bridge overrides', () => {
  const result = runHelper(['--package', 'acpBridge,feishuBridge', '--plan-only'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ACP_BRIDGE_PKG="file:\$PWD\/packages\/aamp-acp-bridge"/)
  assert.match(result.stdout, /FEISHU_BRIDGE_PKG="file:\$PWD\/packages\/aamp-feishu-bridge"/)
})

test('local release tgz plan-only does not invent a content-addressed artifact path', () => {
  const result = runHelper(['--package', 'feishuBridge', '--mode', 'tgz', '--plan-only'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /startup command unavailable/i)
  assert.match(result.stdout, /run without --plan-only/i)
  assert.doesNotMatch(result.stdout, /aamp-feishu-bridge-[^\s]*\.tgz/)
  assert.doesNotMatch(result.stdout, /tgz=/)
})

test('local release json output is parseable and carries the startup command', () => {
  const result = runHelper(['--package', 'feishuBridge', '--plan-only', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.packages[0].key, 'feishuBridge')
  assert.match(parsed.startupCommand, /FEISHU_BRIDGE_PKG="file:\$PWD\/packages\/aamp-feishu-bridge"/)
  assert.match(parsed.startupCommand, /AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true/)
  assert.equal(parsed.startupCommandRunnable, true)
  assert.ok(Array.isArray(parsed.notes))
})

test('selecting AIME ACP auto-includes Task Agent but plan-only stays non-runnable', () => {
  const result = runHelper(['--package', 'aimeAcp', '--plan-only', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)

  assert.deepEqual(parsed.packages.map(({ key }) => key), ['aimeAcp', 'taskAgent'])
  assert.equal(parsed.startupCommandRunnable, false)
  assert.match(parsed.startupCommand, /startup command unavailable/i)
  assert.match(parsed.startupCommand, /run without --plan-only/i)
  assert.doesNotMatch(parsed.startupCommand, /\.tgz/)
  assert.equal(parsed.packages.some(({ key }) => key === 'acpBridge'), false)
  assert.match(parsed.notes.join('\n'), /preflight/i)
  assert.match(parsed.notes.join('\n'), /plan-only|non-runnable|unchecked/i)
})

test('taskAgent plus local Feishu bridge fails early on an unresolved unselected ACP default pin', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'missing-default-pin-artifacts')
  const result = runHelper([
    '--package', 'taskAgent',
    '--package', 'feishuBridge',
    '--out-dir', outDir,
    '--json',
  ], {
    env: fakeNpmEnv(fake, {
      FAKE_VIEW_FAIL_SPECS: '@zengxingyuan/aamp-acp-bridge@0.1.28-dev.36',
    }),
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /@zengxingyuan\/aamp-acp-bridge@0\.1\.28-dev\.36/)
  assert.match(result.stderr, /--package acpBridge/)
  const calls = readJsonLines(fake.log)
  assert.equal(calls.some(({ args }) => args[0] === 'view' && args[1] === '@zengxingyuan/aamp-acp-bridge@0.1.28-dev.36'), true)
  assert.equal(calls.some(({ args }) => args[0] === 'view' && args[1] === '@zengxingyuan/aamp-feishu-bridge@0.1.51'), false)
  assert.equal(calls.some(({ args }) => args[0] === 'run' && args[1] === 'build'), false)
  assert.equal(calls.some(({ args }) => args[0] === 'pack'), false)
})

test('taskAgent with all relevant local overrides skips default-pin registry preflight', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'all-local-artifacts')
  const result = runHelper([
    '--package', 'taskAgent',
    '--package', 'acpBridge',
    '--package', 'feishuBridge',
    '--package', 'aimeAcp',
    '--out-dir', outDir,
    '--json',
  ], { env: fakeNpmEnv(fake) })

  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.startupCommandRunnable, true)
  assert.deepEqual(parsed.packages.map(({ key }) => key), ['aimeAcp', 'acpBridge', 'feishuBridge', 'taskAgent'])
  assert.equal(readJsonLines(fake.log).some(({ args }) => args[0] === 'view'), false)
})

test('bridge-only local Feishu run stays runnable without unrelated default-pin preflight', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'feishu-only-artifacts')
  const result = runHelper([
    '--package', 'feishuBridge',
    '--out-dir', outDir,
    '--json',
  ], { env: fakeNpmEnv(fake) })

  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.startupCommandRunnable, true)
  assert.match(parsed.startupCommand, /FEISHU_BRIDGE_PKG="file:\$PWD\/packages\/aamp-feishu-bridge"/)
  assert.equal(readJsonLines(fake.log).some(({ args }) => args[0] === 'view'), false)
})

test('taskAgent preflight fails closed when bootstrap and controller ACP defaults disagree', (t) => {
  const fake = createFakeNpm(t)
  writeTaskAgentPinSources(fake.fixtureRepo, {
    controllerAcpBridgePin: '@zengxingyuan/aamp-acp-bridge@9.9.9-dev.9',
  })

  const result = runHelper([
    '--package', 'taskAgent',
    '--out-dir', path.join(fake.root, 'inconsistent-pin-artifacts'),
    '--json',
  ], { env: fakeNpmEnv(fake) })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /ACP/i)
  assert.match(result.stderr, /inconsistent|mismatch/i)
  assert.equal(readJsonLines(fake.log).length, 0)
})

test('taskAgent startup command exports the packed local manifest name before direct start', (t) => {
  const fake = createFakeNpm(t)
  writeTaskAgentPinSources(fake.fixtureRepo, {
    taskAgentDefaultName: '@luckyterry/aamp-feishu-task-agent',
  })

  const result = runHelper([
    '--package', 'taskAgent',
    '--out-dir', path.join(fake.root, 'task-name-artifacts'),
    '--json',
  ], { env: fakeNpmEnv(fake) })

  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const command = parsed.startupCommand
  const localTaskAgentName = '@fixture/aamp-feishu-task-agent'

  assert.match(command, new RegExp(`export AAMP_TASK_AGENT_NAME=${localTaskAgentName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`))
  assert.ok(
    command.indexOf(`export AAMP_TASK_AGENT_NAME=${localTaskAgentName}`) < command.indexOf('"$HOME/.aamp/npm-global/bin/feishu-task-agent" start'),
    'local task-agent name must be exported before direct start',
  )
  assert.doesNotMatch(command, /feishu-task-agent" update/)
  assert.doesNotMatch(command, /"\$HOME\/\.aamp\/bin\/feishu-task-agent" start/)
})

test('AIME ACP builds and packs with Task Agent using tgz overrides even in file mode', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'artifacts')
  const result = runHelper(['--package', 'aimeAcp', '--out-dir', outDir, '--json'], {
    env: fakeNpmEnv(fake),
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const aime = parsed.packages.find(({ key }) => key === 'aimeAcp')
  const taskAgent = parsed.packages.find(({ key }) => key === 'taskAgent')

  assert.equal(parsed.startupCommandRunnable, true)
  assert.equal(aime.built, true)
  const aimeStem = artifactStem(fake.fixtureRepo, 'packages/aime-acp')
  const taskAgentStem = artifactStem(fake.fixtureRepo, 'packages/aamp-feishu-task-agent')
  assert.equal(fs.existsSync(aime.tgz), true)
  assert.equal(fs.existsSync(taskAgent.tgz), true)
  assert.equal(path.basename(aime.tgz), `${aimeStem}-${sha256(fs.readFileSync(aime.tgz))}.tgz`)
  assert.equal(path.basename(taskAgent.tgz), `${taskAgentStem}-${sha256(fs.readFileSync(taskAgent.tgz))}.tgz`)
  assert.equal(execFileSync('tar', ['-xOzf', aime.tgz, 'package/dist/fake-build-marker.txt'], { encoding: 'utf8' }), 'built')
  assert.match(parsed.startupCommand, new RegExp(`AIME_ACP_PKG=${aime.tgz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(parsed.startupCommand, /AIME_ACP_PKG=.*file:/)
  assert.match(parsed.startupCommand, /AAMP_TASK_AUTO_UPDATE=false/)
  assert.match(parsed.startupCommand, /npm install -g --prefix "\$HOME\/\.aamp\/npm-global" --force/)
  assert.match(parsed.startupCommand, /npm-global\/bin\/feishu-task-agent" start/)
  assert.doesNotMatch(parsed.startupCommand, /feishu-task-agent" update/)
  assert.doesNotMatch(parsed.startupCommand, /\.aamp\/bin\/feishu-task-agent" start/)

  const calls = readJsonLines(fake.log)
  assert.equal(calls.some(({ args, cwd }) => args[0] === 'run' && args[1] === 'build' && cwd.endsWith('/packages/aime-acp')), true)
  assert.equal(calls.filter(({ args }) => args[0] === 'pack').length, 2)
  for (const cache of new Set(calls.map(({ cache }) => cache).filter(Boolean))) {
    assert.equal(fs.existsSync(cache), false, `helper npm cache must be removed: ${cache}`)
  }
})

test('AIME verification resolves the packed tgz rather than the source folder', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'verify-artifacts')
  const result = runHelper([
    '--package', 'aimeAcp',
    '--skip-build',
    '--verify',
    '--out-dir', outDir,
    '--json',
  ], { env: fakeNpmEnv(fake) })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const aime = parsed.packages.find(({ key }) => key === 'aimeAcp')
  const execCall = readJsonLines(fake.log).find(({ args }) => args[0] === 'exec')

  assert.equal(aime.verified, true)
  assert.ok(execCall)
  assert.equal(execCall.args[execCall.args.indexOf('--package') + 1], aime.tgz)
  assert.doesNotMatch(execCall.args.join(' '), /file:.*packages\/aime-acp/)
})

test('failed AIME tgz resolution produces verified=false and a nonzero exit', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'failed-verify-artifacts')
  const result = runHelper([
    '--package', 'aimeAcp',
    '--skip-build',
    '--verify',
    '--out-dir', outDir,
    '--json',
  ], { env: fakeNpmEnv(fake, { FAKE_VERIFY_FAIL: '1' }) })
  assert.equal(result.status, 1, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.packages.find(({ key }) => key === 'aimeAcp').verified, false)
  assert.equal(parsed.verified.aimeAcp, false)
  const execCall = readJsonLines(fake.log).find(({ args }) => args[0] === 'exec')
  assert.ok(execCall)
  assert.equal(fs.existsSync(execCall.args[execCall.args.indexOf('--package') + 1]), true)
  assert.equal(fs.existsSync(execCall.cache), false)
})

test('helper removes its temporary npm cache after a build failure', (t) => {
  const fake = createFakeNpm(t)
  const result = runHelper(['--package', 'aimeAcp', '--json'], {
    env: fakeNpmEnv(fake, { FAKE_BUILD_FAIL: '1' }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /npm run build failed for aimeAcp/)
  const buildCall = readJsonLines(fake.log).find(({ args }) => args[0] === 'run' && args[1] === 'build')
  assert.ok(buildCall?.cache)
  assert.equal(fs.existsSync(buildCall.cache), false)
})

test('local mutations fail before npm while npm release owns the shared lock, but plan-only remains available', (t) => {
  const fake = createFakeNpm(t)
  const lock = acquireReleaseLock({
    repoRoot: fake.fixtureRepo,
    helper: 'aamp-npm-release',
    operation: 'pack',
    argv: ['--package', 'taskAgent'],
    handleSignals: false,
  })
  t.after(() => {
    try { lock.release() } catch {}
  })

  const mutation = runHelper(['--package', 'acpBridge', '--json'], {
    env: fakeNpmEnv(fake),
  })
  const plan = runHelper(['--package', 'acpBridge', '--plan-only', '--json'], {
    env: fakeNpmEnv(fake),
  })

  assert.equal(mutation.status, 1, mutation.stderr)
  assert.match(mutation.stderr, /another AAMP release operation is already running/i)
  assert.match(mutation.stderr, /helper: aamp-npm-release/)
  assert.equal(readJsonLines(fake.log).length, 0, 'contended local release must fail before npm')
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).startupCommandRunnable, true)
})

test('packing discovers the sole generated tgz when npm emits no filename', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'silent-pack-artifacts')
  const result = runHelper(['--package', 'taskAgent', '--out-dir', outDir, '--json'], {
    env: fakeNpmEnv(fake, { FAKE_PACK_SILENT: '1' }),
  })
  assert.equal(result.status, 0, result.stderr)
  const tgz = JSON.parse(result.stdout).packages.find(({ key }) => key === 'taskAgent').tgz
  assert.equal(fs.existsSync(tgz), true)
  assert.equal(fs.readdirSync(outDir).filter((name) => name.endsWith('.tgz')).length, 1)
})

test('packing rejects ambiguous generated tgz output and cleans its staging directory', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'ambiguous-pack-artifacts')
  const result = runHelper(['--package', 'taskAgent', '--out-dir', outDir, '--json'], {
    env: fakeNpmEnv(fake, { FAKE_PACK_EXTRA_TGZ: '1' }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must produce exactly one tgz.*found 2/)
  assert.equal(fs.readdirSync(outDir).some((name) => name.startsWith('.aamp-local-pack-')), false)
})

test('repacking identical content reuses its immutable artifact without rewriting it', (t) => {
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'collision-artifacts')
  const args = ['--package', 'taskAgent', '--out-dir', outDir, '--json']
  const first = runHelper(args, { env: fakeNpmEnv(fake, { FAKE_PACK_VARIANT: 'same' }) })
  assert.equal(first.status, 0, first.stderr)
  const firstPath = JSON.parse(first.stdout).packages.find(({ key }) => key === 'taskAgent').tgz
  const firstContent = fs.readFileSync(firstPath)
  const oldMtime = new Date(946684800000)
  fs.utimesSync(firstPath, oldMtime, oldMtime)

  const second = runHelper(args, { env: fakeNpmEnv(fake, { FAKE_PACK_VARIANT: 'same' }) })
  assert.equal(second.status, 0, second.stderr)
  const secondPath = JSON.parse(second.stdout).packages.find(({ key }) => key === 'taskAgent').tgz

  assert.equal(secondPath, firstPath)
  assert.deepEqual(fs.readFileSync(firstPath), firstContent)
  assert.match(firstPath, /-[a-f0-9]{64}\.tgz$/)
  assert.equal(fs.statSync(firstPath).mtimeMs, oldMtime.getTime())
})

test('packing fails closed on a conflicting preexisting content-addressed target', (t) => {
  const fake = createFakeNpm(t)
  const probeOutDir = path.join(fake.root, 'probe-artifacts')
  const collisionOutDir = path.join(fake.root, 'preexisting-collision-artifacts')
  const args = ['--package', 'taskAgent', '--out-dir', probeOutDir, '--json']
  const probe = runHelper(args, { env: fakeNpmEnv(fake, { FAKE_PACK_VARIANT: 'collision' }) })
  assert.equal(probe.status, 0, probe.stderr)
  const probeTgz = JSON.parse(probe.stdout).packages.find(({ key }) => key === 'taskAgent').tgz
  fs.mkdirSync(collisionOutDir, { recursive: true })
  const collisionPath = path.join(collisionOutDir, path.basename(probeTgz))
  fs.writeFileSync(collisionPath, 'preexisting-conflicting-bytes')

  const result = runHelper(['--package', 'taskAgent', '--out-dir', collisionOutDir, '--json'], {
    env: fakeNpmEnv(fake, { FAKE_PACK_VARIANT: 'collision' }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Content-addressed artifact collision/)
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'preexisting-conflicting-bytes')
})

test('packing rejects a symlink at the content-addressed artifact path even when its target bytes match', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink fixture requires POSIX semantics')
    return
  }
  const fake = createFakeNpm(t)
  const outDir = path.join(fake.root, 'symlink-collision-artifacts')
  const args = ['--package', 'taskAgent', '--out-dir', outDir, '--json']
  const first = runHelper(args, { env: fakeNpmEnv(fake) })
  assert.equal(first.status, 0, first.stderr)
  const artifact = JSON.parse(first.stdout).packages.find(({ key }) => key === 'taskAgent').tgz
  const target = `${artifact}.target`
  fs.renameSync(artifact, target)
  fs.symlinkSync(target, artifact)

  const second = runHelper(args, { env: fakeNpmEnv(fake) })

  assert.equal(second.status, 1, second.stderr)
  assert.match(second.stderr, /artifact collision|regular non-symlink/i)
  assert.equal(fs.lstatSync(artifact).isSymbolicLink(), true)
  assert.equal(fs.existsSync(target), true)
})

test('ACP-only startup clears stale unselected overrides and does not leak new exports', (t) => {
  const fake = createFakeNpm(t)
  const binDir = path.join(fake.root, 'runtime-bin')
  const runtimeLog = path.join(fake.root, 'runtime-env.json')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'feishu-task-agent'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.RUNTIME_ENV_LOG, JSON.stringify({
  acp: process.env.ACP_BRIDGE_PKG || '',
  taskAcp: process.env.AAMP_TASK_ACP_BRIDGE_PKG || '',
  feishu: process.env.FEISHU_BRIDGE_PKG || '',
  taskFeishu: process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '',
  aime: process.env.AIME_ACP_PKG || '',
  taskAime: process.env.AAMP_TASK_AIME_ACP_PKG || '',
  aimeRegistry: process.env.AIME_ACP_REGISTRY || '',
  cache: process.env.NPM_CONFIG_CACHE || '',
  allowOverrides: process.env.AAMP_TASK_ALLOW_PACKAGE_OVERRIDES || '',
}))
`, { mode: 0o755 })

  const planned = runHelper(['--package', 'acpBridge', '--plan-only', '--json'])
  assert.equal(planned.status, 0, planned.stderr)
  const command = JSON.parse(planned.stdout).startupCommand
  assert.ok(command.indexOf('unset ACP_BRIDGE_PKG') < command.indexOf('ACP_BRIDGE_PKG="file:'))
  const shell = spawnSync('bash', ['-c', `${command}
printf 'after|%s|%s|%s|%s|%s\n' "\${ACP_BRIDGE_PKG-}" "\${FEISHU_BRIDGE_PKG-}" "\${AIME_ACP_PKG-}" "\${NPM_CONFIG_CACHE-}" "\${AAMP_TASK_ALLOW_PACKAGE_OVERRIDES-}"`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      RUNTIME_ENV_LOG: runtimeLog,
      ACP_BRIDGE_PKG: 'caller-acp',
      FEISHU_BRIDGE_PKG: 'stale-feishu',
      AAMP_TASK_FEISHU_BRIDGE_PKG: 'stale-task-feishu',
      AIME_ACP_PKG: 'stale-aime',
      AAMP_TASK_AIME_ACP_PKG: 'stale-task-aime',
      AIME_ACP_REGISTRY: 'https://stale.invalid',
      NPM_CONFIG_CACHE: 'caller-cache',
      AAMP_TASK_ALLOW_PACKAGE_OVERRIDES: 'caller-allow',
    },
  })
  assert.equal(shell.status, 0, shell.stderr)
  const inside = JSON.parse(fs.readFileSync(runtimeLog, 'utf8'))

  assert.match(inside.acp, /^file:.*packages\/aamp-acp-bridge$/)
  assert.equal(inside.taskAcp, '')
  assert.equal(inside.feishu, '')
  assert.equal(inside.taskFeishu, '')
  assert.equal(inside.aime, '')
  assert.equal(inside.taskAime, '')
  assert.equal(inside.aimeRegistry, '')
  assert.equal(inside.allowOverrides, 'true')
  assert.match(inside.cache, /aamp-local-runtime-npm-cache\./)
  assert.equal(fs.existsSync(inside.cache), false)
  assert.equal(shell.stdout.trim(), 'after|caller-acp|stale-feishu|stale-aime|caller-cache|caller-allow')
})

test('Task Agent startup installs and directly starts the packed local launcher even if update would fail', (t) => {
  const fake = createFakeNpm(t)
  writeTaskAgentPinSources(fake.fixtureRepo, {
    taskAgentDefaultName: '@luckyterry/aamp-feishu-task-agent',
  })
  const home = path.join(fake.root, 'home')
  const outDir = path.join(fake.root, 'task-artifacts')
  fs.mkdirSync(home, { recursive: true })
  const packed = runHelper(['--package', 'taskAgent', '--out-dir', outDir, '--json'], {
    env: fakeNpmEnv(fake),
  })
  assert.equal(packed.status, 0, packed.stderr)
  const parsed = JSON.parse(packed.stdout)
  const taskAgent = parsed.packages.find(({ key }) => key === 'taskAgent')
  const started = spawnSync('bash', ['-c', parsed.startupCommand], {
    encoding: 'utf8',
    env: fakeNpmEnv(fake, {
      HOME: home,
      NPM_GLOBAL_PREFIX: '/tmp/stale-prefix',
      AAMP_BIN_DIR: '/tmp/stale-bin',
      AAMP_TASK_COMMAND_PATH: '/tmp/stale-command',
      AAMP_TASK_SHIM_DIR: '/tmp/stale-shim',
      AAMP_TASK_COMMAND_NAME: 'stale-task-command',
      AAMP_TASK_AGENT_NAME: '@stale/task-agent',
      AAMP_TASK_AGENT_LEGACY_NAME: '@stale/legacy-task-agent',
      AAMP_TASK_AGENT_CHANNEL: 'stale-channel',
      NPM_REGISTRY: 'https://stale.invalid',
      AAMP_TASK_NPM_REGISTRY: 'https://stale-controller.invalid',
      AAMP_TASK_INSTALL_COMMAND: 'stale install command',
      AAMP_TASK_INTERNAL: 'true',
      AAMP_TASK_PACKAGE_OVERRIDES_RESOLVED: 'true',
      FAKE_TASK_AGENT_UPDATE_EXIT: '23',
    }),
  })
  assert.equal(started.status, 0, started.stderr)

  const npmInstall = readJsonLines(fake.log).find(({ args }) => args[0] === 'install')
  assert.ok(npmInstall)
  assert.equal(npmInstall.args.at(-1), taskAgent.tgz)
  const actions = readJsonLines(fake.taskAgentLog)
  assert.deepEqual(actions.map(({ action }) => action), ['start'])
  assert.match(actions[0].executable, /\.aamp\/npm-global\/bin\/feishu-task-agent$/)
  assert.equal(actions.every(({ autoUpdate }) => autoUpdate === 'false'), true)
  assert.equal(actions.every(({ allowOverrides }) => allowOverrides === 'true'), true)
  assert.equal(actions.every(({ agentName }) => agentName === '@fixture/aamp-feishu-task-agent'), true)
  assert.equal(actions.every(({ globalPrefix, binDir, commandName, commandPath, shimDir }) => !globalPrefix && !binDir && !commandName && !commandPath && !shimDir), true)
  assert.equal(actions.every(({ agentName, agentLegacyName, agentChannel, npmRegistry, taskNpmRegistry, installCommand, internal, overridesResolved }) => (
    !agentLegacyName && !agentChannel && !npmRegistry && !taskNpmRegistry
      && !installCommand && !internal && !overridesResolved
  )), true)
  assert.equal(fs.existsSync(path.join(home, '.aamp', 'bin', 'feishu-task-agent')), true)
  assert.equal(fs.existsSync(actions[0].cache), false)

  const after = spawnSync('bash', ['-lc', 'printf %s "${AAMP_TASK_AGENT_NAME-}"'], {
    encoding: 'utf8',
    env: fakeNpmEnv(fake, { HOME: home }),
  })
  assert.equal(after.status, 0, after.stderr)
  assert.equal(after.stdout, '')
})

test('startup subshell removes its runtime cache when direct Task Agent start fails', (t) => {
  const fake = createFakeNpm(t)
  const home = path.join(fake.root, 'failed-start-home')
  const outDir = path.join(fake.root, 'failed-start-artifacts')
  const failureCacheLog = path.join(fake.root, 'failed-runtime-cache.txt')
  fs.mkdirSync(home, { recursive: true })
  const packed = runHelper(['--package', 'taskAgent', '--out-dir', outDir, '--json'], {
    env: fakeNpmEnv(fake),
  })
  assert.equal(packed.status, 0, packed.stderr)
  const command = JSON.parse(packed.stdout).startupCommand
    .replace(
      '"$HOME/.aamp/npm-global/bin/feishu-task-agent" start',
      `printf '%s' "$NPM_CONFIG_CACHE" > ${JSON.stringify(failureCacheLog)}; false`,
    )
  const started = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: fakeNpmEnv(fake, {
      HOME: home,
      NPM_GLOBAL_PREFIX: '/tmp/stale-prefix',
      AAMP_BIN_DIR: '/tmp/stale-bin',
      AAMP_TASK_COMMAND_PATH: '/tmp/stale-command',
      AAMP_TASK_SHIM_DIR: '/tmp/stale-shim',
    }),
  })
  assert.notEqual(started.status, 0)
  const runtimeCache = fs.readFileSync(failureCacheLog, 'utf8')
  assert.match(runtimeCache, /aamp-local-runtime-npm-cache\./)
  assert.equal(fs.existsSync(runtimeCache), false)
})

test('local release skill documents restart-before-start and no-publish', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /stop the current Task Agent/i)
  assert.match(skill, /never publishes/i)
  assert.match(skill, /ACP_BRIDGE_PKG|FEISHU_BRIDGE_PKG/)
  assert.match(skill, /AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true/)
  assert.match(skill, /Do not replace it with a persistent `export`/)
})

test('local release skill documents AIME and Task Agent local artifact contracts', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /aimeAcp/)
  assert.match(skill, /AIME[^\n]*(?:tgz-only|tgz only)|(?:tgz-only|tgz only)[^\n]*AIME/i)
  assert.match(skill, /taskAgent[^\n]*(?:auto-pack|automatically pack)|(?:auto-pack|automatically pack)[^\n]*taskAgent/i)
  assert.match(skill, /install[^\n]*task.agent|task.agent[^\n]*install/i)
  assert.match(skill, /sync[^\n]*~\/\.aamp\/bin|~\/\.aamp\/bin[^\n]*sync/i)
  assert.match(skill, /AAMP_TASK_AUTO_UPDATE=false/)
})

test('local release skill documents scoped environment and concurrency safety', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /caller shell|calling shell/i)
  assert.match(skill, /does not[^\n]*(?:export|pollut|leak)|no persistent exports?/i)
  assert.match(skill, /shared release lock/i)
  assert.match(skill, /concurren/i)
  assert.match(skill, /content-addressed/i)
  assert.match(skill, /never overwrite|non-overwrit|does not overwrite/i)
})

test('local release helper discovers the repo root from its own location', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages', 'aamp-feishu-bridge', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(repoRoot, '.agents', 'skills', 'aamp-local-release', 'SKILL.md')), true)
})

test('local release helper rejects a non-executable isolated bridge fixture', (t) => {
  if (process.platform === 'win32') {
    t.skip('execute bits are not used on Windows')
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-local-bin-fixture-'))
  const binPath = path.join(root, 'bridge-bin.js')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', { mode: 0o644 })

  assert.throws(
    () => verifyBin({ key: 'fixtureBridge', dir: 'fixture' }, { binPath }),
    (error) => /not executable/.test(error.message) && /prepare-bin/.test(error.message),
  )
  assert.equal(fs.statSync(binPath).mode & 0o777, 0o644)
})

test('bridge builds declare postbuild bin preparation', () => {
  for (const packageDir of ['packages/aamp-feishu-bridge', 'packages/aamp-acp-bridge']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, packageDir, 'package.json'), 'utf8'))
    assert.equal(manifest.scripts.postbuild, 'npm run prepare-bin')
  }
})
