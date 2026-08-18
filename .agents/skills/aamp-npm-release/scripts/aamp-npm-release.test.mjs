import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.join(scriptDir, 'aamp-npm-release.mjs')
const skillPath = path.resolve(scriptDir, '..', 'SKILL.md')
const releaseLockModuleUrl = pathToFileURL(path.resolve(scriptDir, '..', '..', 'shared', 'release-lock.mjs')).href

function releaseLockPath(repo) {
  const canonicalRepo = fs.realpathSync(repo)
  const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: canonicalRepo, encoding: 'utf8' }).trim()
  return path.join(fs.realpathSync(path.resolve(canonicalRepo, gitCommonDir)), 'aamp-release.lock')
}

function releaseLockQuarantines(lockPath) {
  const prefix = `${path.basename(lockPath)}.quarantine-`
  return fs.readdirSync(path.dirname(lockPath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(lockPath), entry))
}

function releaseLockOwner(repo, overrides = {}) {
  const lockPath = releaseLockPath(repo)
  return {
    schemaVersion: 1,
    kind: 'aamp-shared-release-lock',
    lockPath,
    token: '00000000-0000-4000-8000-000000000001',
    pid: process.pid,
    hostname: os.hostname(),
    helper: 'aamp-local-release',
    operation: 'build',
    repoRoot: fs.realpathSync(repo),
    cwd: repo,
    argv: ['--package', 'acpBridge'],
    startedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  }
}

function writeReleaseLock(repo, overrides = {}) {
  const lockPath = releaseLockPath(repo)
  fs.writeFileSync(lockPath, `${JSON.stringify(releaseLockOwner(repo, overrides), null, 2)}\n`, { mode: 0o600 })
  return lockPath
}

async function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.stderr.off('data', onError)
      child.off('exit', onExit)
    }
    const onData = (chunk) => {
      output += chunk
      if (!pattern.test(output)) return
      cleanup()
      resolve(output)
    }
    const onError = (chunk) => {
      errors += chunk
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`child exited (${code ?? signal}) before producing ${pattern}: ${output}${errors}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for ${pattern}: ${output}${errors}`))
    }, timeoutMs)
    child.stdout.on('data', onData)
    child.stderr.on('data', onError)
    child.on('exit', onExit)
  })
}

async function startReleaseLockHolder(t, repo, { extraSignalListener = false } = {}) {
  const source = [
    `import { acquireReleaseLock } from ${JSON.stringify(releaseLockModuleUrl)}`,
    extraSignalListener ? "process.on('SIGTERM', () => {})" : '',
    'const lock = acquireReleaseLock({',
    `  repoRoot: ${JSON.stringify(repo)},`,
    "  helper: 'aamp-local-release',",
    "  operation: 'build',",
    "  argv: ['--package', 'acpBridge'],",
    '})',
    "console.log(`LOCK_READY ${JSON.stringify({ lockPath: lock.lockPath, owner: lock.owner })}`)",
    'setInterval(() => {}, 1000)',
  ].filter(Boolean).join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  })
  await waitForOutput(child, /LOCK_READY /)
  return child
}

function createFakeNpm(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-pm-'))
  const fakeNpm = path.join(root, 'npm')
  const publicWhoami = options.publicWhoami ?? 'luckyterry'
  const bnpmWhoami = options.bnpmWhoami ?? publicWhoami
  const defaultView = options.defaultView ?? '["0.1.0-dev.0"]'
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "10.0.0\\n" ;;',
    '  whoami)',
    '    registry=""',
    '    while [ "$#" -gt 0 ]; do',
    '      if [ "$1" = "--registry" ]; then',
    '        registry="$2"',
    '        break',
    '      fi',
    '      shift',
    '    done',
    `    if [ "$registry" = "https://bnpm.byted.org" ]; then printf "${bnpmWhoami}\\n"; else printf "${publicWhoami}\\n"; fi ;;`,
    `  view) printf '${defaultView}\\n' ;;`,
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'))
  fs.chmodSync(fakeNpm, 0o755)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return fakeNpm
}

function createRegistryAwareFakeNpm(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-registry-pm-'))
  const fakeNpm = path.join(root, 'npm')
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env bash',
    'printf "%s\n" "$*" >> "$AAMP_FAKE_NPM_LOG"',
    'case "$1" in',
    '  --version) printf "%s\n" "10.0.0" ;;',
    '  whoami) printf "%s\n" "luckyterry" ;;',
    "  view) printf '[\"0.1.0-dev.7\"]\\n' ;;",
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'))
  fs.chmodSync(fakeNpm, 0o755)
  const log = path.join(root, 'calls.log')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { fakeNpm, log }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function createSourcePackage(repo, relativeDir, name, version) {
  const packageDir = path.join(repo, relativeDir)
  writeJson(path.join(packageDir, 'package.json'), { name, version })
  writeJson(path.join(packageDir, 'package-lock.json'), {
    name,
    version,
    lockfileVersion: 3,
    packages: { '': { name, version } },
  })
}

function createReleaseRepo(t, versions = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-repo-'))
  const packageVersions = {
    aimeAcp: '0.1.0',
    acpBridge: '1.2.3',
    feishuBridge: '3.4.5',
    taskAgent: '2.4.6',
    ...versions,
  }
  createSourcePackage(repo, 'packages/aime-acp', '@tengchengwei/aime-acp', packageVersions.aimeAcp)
  createSourcePackage(repo, 'packages/aamp-acp-bridge', '@canonical/aamp-acp-bridge', packageVersions.acpBridge)
  createSourcePackage(repo, 'packages/aamp-feishu-bridge', '@canonical/aamp-feishu-bridge', packageVersions.feishuBridge)
  createSourcePackage(repo, 'packages/aamp-feishu-task-agent', '@larktask/aamp-feishu-task-agent', packageVersions.taskAgent)

  const taskDir = path.join(repo, 'packages/aamp-feishu-task-agent')
  fs.mkdirSync(path.join(taskDir, 'bootstrap'), { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), [
    'ACP_BRIDGE_PKG="${ACP_BRIDGE_PKG:-@canonical/aamp-acp-bridge@1.2.3}"',
    'AIME_ACP_PKG="${AIME_ACP_PKG:-@tengchengwei/aime-acp@0.1.0-dev.3}"',
    'AIME_ACP_REGISTRY="${AIME_ACP_REGISTRY:-https://bnpm.byted.org}"',
    'FEISHU_BRIDGE_PKG="${FEISHU_BRIDGE_PKG:-@canonical/aamp-feishu-bridge@3.4.5}"',
    'AAMP_TASK_AGENT_NAME="${AAMP_TASK_AGENT_NAME:-@larktask/aamp-feishu-task-agent}"',
    'AAMP_TASK_AGENT_CHANNEL="${AAMP_TASK_AGENT_CHANNEL:-dev}"',
    `AAMP_TASK_AGENT_VERSION="${packageVersions.taskAgent}"`,
    "aime_fallback() { printf '%s\\n' \"${AIME_ACP_PKG:-@tengchengwei/aime-acp@0.1.0-dev.3}\"; }",
    "aime_registry_fallback() { printf '%s\\n' \"${AIME_ACP_REGISTRY:-https://bnpm.byted.org}\"; }",
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(taskDir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), [
    "const ACP_PACKAGE = process.env.AAMP_TASK_ACP_BRIDGE_PKG || '@canonical/aamp-acp-bridge@1.2.3';",
    "const FEISHU_PACKAGE = process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '@canonical/aamp-feishu-bridge@3.4.5';",
    "const INSTALL_COMMAND = 'npx -y --package @larktask/aamp-feishu-task-agent@dev feishu-task-agent install';",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(taskDir, 'README.md'), [
    'Task Agent fixture',
    'One-click: npx -y --package @larktask/aamp-feishu-task-agent@dev feishu-task-agent install',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(repo, 'existing-user-change.txt'), 'before\n')

  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo })
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  return repo
}

function writeTaskAgentSourcePins(repo, {
  publicScope = '@release-test',
  acpPin = '@canonical/aamp-acp-bridge@1.2.3',
  feishuPin = '@canonical/aamp-feishu-bridge@3.4.5',
  aimePin = '@tengchengwei/aime-acp@0.1.0-dev.3',
  aimeRegistry = 'https://bnpm.byted.org',
  taskAgentVersion = readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version,
  taskAgentName = `${publicScope}/aamp-feishu-task-agent`,
  taskAgentChannel = 'dev',
} = {}) {
  const bootstrapFile = path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh')
  const controllerFile = path.join(repo, 'packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs')
  const readmeFile = path.join(repo, 'packages/aamp-feishu-task-agent/README.md')
  fs.writeFileSync(bootstrapFile, [
    `ACP_BRIDGE_PKG="\${ACP_BRIDGE_PKG:-${acpPin}}"`,
    `AIME_ACP_PKG="\${AIME_ACP_PKG:-${aimePin}}"`,
    `AIME_ACP_REGISTRY="\${AIME_ACP_REGISTRY:-${aimeRegistry}}"`,
    `FEISHU_BRIDGE_PKG="\${FEISHU_BRIDGE_PKG:-${feishuPin}}"`,
    `AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-${taskAgentName}}"`,
    `AAMP_TASK_AGENT_CHANNEL="\${AAMP_TASK_AGENT_CHANNEL:-${taskAgentChannel}}"`,
    `AAMP_TASK_AGENT_VERSION="${taskAgentVersion}"`,
    `aime_fallback() { printf '%s\\n' "\${AIME_ACP_PKG:-${aimePin}}"; }`,
    `aime_registry_fallback() { printf '%s\\n' "\${AIME_ACP_REGISTRY:-${aimeRegistry}}"; }`,
    '',
  ].join('\n'))
  fs.writeFileSync(controllerFile, [
    `const ACP_PACKAGE = process.env.AAMP_TASK_ACP_BRIDGE_PKG || '${acpPin}';`,
    `const FEISHU_PACKAGE = process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '${feishuPin}';`,
    `const INSTALL_COMMAND = 'npx -y --package ${taskAgentName}@${taskAgentChannel} feishu-task-agent install';`,
    '',
  ].join('\n'))
  fs.writeFileSync(readmeFile, [
    'Task Agent fixture',
    `One-click: npx -y --package ${taskAgentName}@${taskAgentChannel} feishu-task-agent install`,
    '',
  ].join('\n'))
}

function createStatefulFakeNpm(t, registryVersions = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-stateful-pm-'))
  const fakeNpm = path.join(root, 'npm')
  const registryFile = path.join(root, 'registry.json')
  const log = path.join(root, 'calls.ndjson')
  const publicWhoami = options.publicWhoami ?? 'release-test'
  const bnpmWhoami = options.bnpmWhoami ?? publicWhoami
  writeJson(registryFile, registryVersions)
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env node',
    "const crypto = require('node:crypto')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "fs.appendFileSync(process.env.AAMP_FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n')",
    "if (args[0] === '--version') { console.log('10.0.0'); process.exit(0) }",
    `if (args[0] === 'whoami') { const registry = args[args.indexOf('--registry') + 1] || 'https://registry.npmjs.org/'; console.log(registry === 'https://bnpm.byted.org' ? ${JSON.stringify(bnpmWhoami)} : ${JSON.stringify(publicWhoami)}); process.exit(0) }`,
    "const registry = args[args.indexOf('--registry') + 1] || 'https://registry.npmjs.org/'",
    "const state = JSON.parse(fs.readFileSync(process.env.AAMP_FAKE_NPM_REGISTRY, 'utf8'))",
    'const registryKey = `${registry}|${args[1]}`',
    "if (args[0] === 'view') {",
    "  const exact = /^(.*)@(\\d+\\.\\d+\\.\\d+(?:-dev\\.\\d+)?)$/.exec(args[1])",
    "  if (exact) {",
    "    const key = `${registry}|${exact[1]}|${exact[2]}`",
    "    const artifact = state[key]",
    "    if (artifact?.missingViews > 0) { artifact.missingViews -= 1; state[key] = artifact; fs.writeFileSync(process.env.AAMP_FAKE_NPM_REGISTRY, `${JSON.stringify(state, null, 2)}\n`); console.log('{}'); process.exit(0) }",
    "    console.log(JSON.stringify(artifact || {})); process.exit(0)",
    "  }",
    "  console.log(JSON.stringify(state[registryKey] || state[args[1]] || [])); process.exit(0)",
    "}",
    "if (args[0] === 'pack') {",
    "  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))",
    "  const destination = args[args.indexOf('--pack-destination') + 1]",
    "  fs.mkdirSync(destination, { recursive: true })",
    "  const archive = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`",
    "  const payload = {",
    "    name: pkg.name,",
    "    version: pkg.version,",
    "    bootstrap: fs.existsSync(path.join(process.cwd(), 'bootstrap/aamp-feishu-task-agent-bootstrap.sh')) ? fs.readFileSync(path.join(process.cwd(), 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8') : null,",
    "    controller: fs.existsSync(path.join(process.cwd(), 'bin/feishu-task-agent-controller.mjs')) ? fs.readFileSync(path.join(process.cwd(), 'bin/feishu-task-agent-controller.mjs'), 'utf8') : null,",
    "  }",
    "  fs.writeFileSync(path.join(destination, archive), `${JSON.stringify(payload, null, 2)}\\n`)",
    '  console.log(archive)',
    '  process.exit(0)',
    '}',
    "if (args[0] === 'publish') {",
    "  const published = args.find((value, index) => index > 0 && !value.startsWith('-'))",
    "  if (!published || !published.endsWith('.tgz')) { console.error('publish requires packed tgz'); process.exit(2) }",
    "  const packedIdentity = fs.readFileSync(published, 'utf8').trim()",
    "  let pkg",
    "  try {",
    "    const payload = JSON.parse(packedIdentity)",
    "    pkg = { name: payload.name, version: payload.version }",
    "  } catch {",
    "    const at = packedIdentity.lastIndexOf('@')",
    "    if (at <= 0) { console.error('invalid packed tgz identity'); process.exit(2) }",
    "    pkg = { name: packedIdentity.slice(0, at), version: packedIdentity.slice(at + 1) }",
    "  }",
    '  const key = `${registry}|${pkg.name}`',
    '  state[key] = [...new Set([...(state[key] || []), pkg.version])]',
    "  const bytes = fs.readFileSync(published)",
    "  state[`${registry}|${pkg.name}|${pkg.version}`] = { version: pkg.version, missingViews: Number(process.env.AAMP_FAKE_NPM_METADATA_DELAY || 0), dist: { shasum: crypto.createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-fake-integrity', tarball: `https://registry.test/${path.basename(published)}` } }",
    "  fs.writeFileSync(process.env.AAMP_FAKE_NPM_REGISTRY, `${JSON.stringify(state, null, 2)}\\n`)",
    '  process.exit(0)',
    '}',
    'process.exit(0)',
    '',
  ].join('\n'))
  fs.chmodSync(fakeNpm, 0o755)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    fakeNpm,
    log,
    registryFile,
    env: {
      ...process.env,
      AAMP_FAKE_NPM_LOG: log,
      AAMP_FAKE_NPM_REGISTRY: registryFile,
    },
  }
}

function fakeNpmCalls(log) {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function runRelease(repo, fakeNpm, env, args) {
  return spawnSync(process.execPath, [helperPath, '--pm', fakeNpm, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
  })
}

function snapshotFiles(files) {
  return new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]))
}

function assertFilesMatchSnapshot(snapshot) {
  for (const [file, content] of snapshot) {
    if (content === null) {
      assert.equal(fs.existsSync(file), false, `${file} should remain absent`)
    } else {
      assert.deepEqual(fs.readFileSync(file), content, `${file} should be restored byte-for-byte`)
    }
  }
}

test('mutating npm release fails fast with the live cross-helper lock owner and makes no source writes', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  const lockPath = writeReleaseLock(repo)
  const before = snapshotFiles([
    path.join(repo, 'packages/aamp-acp-bridge/package.json'),
    path.join(repo, 'packages/aamp-feishu-task-agent/package.json'),
  ])

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /another AAMP release operation is already running/i)
  assert.match(result.stderr, new RegExp(`pid: ${process.pid}\\b`))
  assert.match(result.stderr, /helper: aamp-local-release/)
  assert.match(result.stderr, /operation: build/)
  assert.match(result.stderr, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assertFilesMatchSnapshot(before)
  assert.equal(fakeNpmCalls(log).length, 0)
  assert.equal(fs.existsSync(lockPath), true)
})

test('help and plan-only do not contend with a live release lock', (t) => {
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  const { fakeNpm, env } = createStatefulFakeNpm(t)
  const lockPath = writeReleaseLock(repo)

  const help = spawnSync(process.execPath, [helperPath, '--help'], { cwd: repo, encoding: 'utf8' })
  const plan = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--plan-only',
    '--scope', '@release-test',
    '--package', 'taskAgent',
  ])

  assert.equal(help.status, 0, help.stderr)
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /version plan:/)
  assert.deepEqual(readJson(lockPath), releaseLockOwner(repo))
})

test('mutating npm release safely recovers a validated lock whose local PID no longer exists', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t)
  const lockPath = writeReleaseLock(repo, {
    pid: 2_147_483_647,
    helper: 'aamp-npm-release',
    operation: 'pack',
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
  assert.equal(fs.existsSync(lockPath), false, 'normal exit should release the recovered lock')
})

test('dead-PID lock with a mismatched lock identity fails closed and is preserved', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t)
  const lockPath = writeReleaseLock(repo, {
    pid: 2_147_483_647,
    lockPath: path.join(repo, '.not-the-shared-release-lock'),
  })
  const before = fs.readFileSync(lockPath)

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /invalid release lock owner metadata/i)
  assert.deepEqual(fs.readFileSync(lockPath), before)
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.6')
})

test('shared release lock resolves linked worktrees to one git-common lock path', async (t) => {
  const repo = createReleaseRepo(t)
  const worktreeContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-worktree-'))
  const linkedWorktree = path.join(worktreeContainer, 'linked')
  execFileSync('git', ['worktree', 'add', '--detach', '-q', linkedWorktree, 'HEAD'], { cwd: repo })
  t.after(() => {
    spawnSync('git', ['worktree', 'remove', '--force', linkedWorktree], { cwd: repo })
    fs.rmSync(worktreeContainer, { recursive: true, force: true })
  })
  const { acquireReleaseLock, resolveReleaseLockPath, ReleaseLockError } = await import(releaseLockModuleUrl)

  assert.equal(resolveReleaseLockPath(repo), releaseLockPath(repo))
  assert.equal(resolveReleaseLockPath(linkedWorktree), releaseLockPath(repo))
  const first = acquireReleaseLock({ repoRoot: repo, helper: 'aamp-npm-release', operation: 'pack' })
  try {
    assert.throws(
      () => acquireReleaseLock({ repoRoot: linkedWorktree, helper: 'aamp-local-release', operation: 'build' }),
      (error) => error instanceof ReleaseLockError && error.owner?.token === first.owner.token,
    )
  } finally {
    first.release()
  }
})

test('shared release lock removes its exact owner file when the holder receives SIGTERM', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX signal cleanup assertion')
    return
  }
  const repo = createReleaseRepo(t)
  const child = await startReleaseLockHolder(t, repo)
  const lockPath = releaseLockPath(repo)
  assert.equal(fs.existsSync(lockPath), true)
  const lockStat = fs.lstatSync(lockPath)
  assert.equal(lockStat.isFile(), true)
  assert.equal(lockStat.isSymbolicLink(), false)
  assert.equal(lockStat.mode & 0o777, 0o600)

  child.kill('SIGTERM')
  await once(child, 'exit')

  assert.equal(fs.existsSync(lockPath), false)
})

test('signal cleanup errors still re-deliver SIGTERM instead of leaving the holder running', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX signal cleanup assertion')
    return
  }
  const repo = createReleaseRepo(t)
  const child = await startReleaseLockHolder(t, repo)
  const lockPath = releaseLockPath(repo)
  fs.appendFileSync(lockPath, '{corrupt')
  const corruptedBytes = fs.readFileSync(lockPath)

  child.kill('SIGTERM')
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
  const [code, signal] = await exited
  clearTimeout(timeout)

  assert.equal(code, null)
  assert.equal(signal, 'SIGTERM')
  assert.equal(fs.existsSync(lockPath), false)
  const quarantines = releaseLockQuarantines(lockPath)
  assert.equal(quarantines.length, 1)
  assert.deepEqual(fs.readFileSync(quarantines[0]), corruptedBytes)
})

test('shared release lock removes its exit listener after explicit release without signal handling', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock } = await import(releaseLockModuleUrl)
  const exitListenersBefore = process.listenerCount('exit')
  const lock = acquireReleaseLock({
    repoRoot: repo,
    helper: 'aamp-npm-release',
    operation: 'pack',
    handleSignals: false,
  })
  assert.equal(process.listenerCount('exit'), exitListenersBefore + 1)

  lock.release()

  assert.equal(process.listenerCount('exit'), exitListenersBefore)
})

test('explicit release preserves a preexisting signal listener owned by the host process', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock } = await import(releaseLockModuleUrl)
  const sentinel = () => {}
  process.on('SIGTERM', sentinel)
  const lock = acquireReleaseLock({
    repoRoot: repo,
    helper: 'aamp-npm-release',
    operation: 'pack',
  })
  try {
    lock.release()
    assert.equal(process.listeners('SIGTERM').includes(sentinel), true)
  } finally {
    process.removeListener('SIGTERM', sentinel)
  }
})

test('shared release lock preserves a directory at the lock path as invalid metadata', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock, ReleaseLockError } = await import(releaseLockModuleUrl)
  const lockPath = releaseLockPath(repo)
  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, 'preserve.txt'), 'preserve me\n')

  assert.throws(
    () => acquireReleaseLock({ repoRoot: repo, helper: 'aamp-npm-release', operation: 'pack' }),
    (error) => error instanceof ReleaseLockError && error.code === 'AAMP_RELEASE_LOCK_INVALID',
  )

  assert.equal(fs.readFileSync(path.join(lockPath, 'preserve.txt'), 'utf8'), 'preserve me\n')
})

test('shared release lock preserves malformed regular-file metadata and fails closed', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock, ReleaseLockError } = await import(releaseLockModuleUrl)
  const lockPath = releaseLockPath(repo)
  const malformed = Buffer.from('{not-json\n')
  fs.writeFileSync(lockPath, malformed, { mode: 0o600 })

  assert.throws(
    () => acquireReleaseLock({ repoRoot: repo, helper: 'aamp-npm-release', operation: 'pack' }),
    (error) => error instanceof ReleaseLockError && error.code === 'AAMP_RELEASE_LOCK_INVALID',
  )

  assert.deepEqual(fs.readFileSync(lockPath), malformed)
  assert.deepEqual(releaseLockQuarantines(lockPath), [])
})

test('shared release lock never follows a quarantined file replaced by a symlink after validation', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock, ReleaseLockError } = await import(releaseLockModuleUrl)
  const lock = acquireReleaseLock({
    repoRoot: repo,
    helper: 'aamp-npm-release',
    operation: 'pack',
    handleSignals: false,
  })
  const ownerBefore = fs.readFileSync(lock.lockPath)
  const displacedLock = `${lock.lockPath}.attacker-displaced`
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-lock-victim-'))
  const victimOwner = path.join(victim, 'victim.txt')
  fs.writeFileSync(victimOwner, 'unrelated owner metadata\n')
  const originalUnlinkSync = fs.unlinkSync
  const originalRenameSync = fs.renameSync
  let injected = false
  let releaseError

  fs.unlinkSync = function injectedUnlinkSync(target) {
    const targetPath = path.resolve(String(target))
    if (!injected && path.basename(targetPath).startsWith(`${path.basename(lock.lockPath)}.quarantine-`)) {
      injected = true
      originalRenameSync(targetPath, displacedLock)
      fs.symlinkSync(victimOwner, targetPath, 'file')
    }
    return originalUnlinkSync.call(this, target)
  }
  try {
    try {
      lock.release()
    } catch (error) {
      releaseError = error
    }
  } finally {
    fs.unlinkSync = originalUnlinkSync
  }
  try {
    assert.equal(injected, true, 'the test must substitute the quarantine after its final validation')
    assert.equal(fs.readFileSync(victimOwner, 'utf8'), 'unrelated owner metadata\n')
    assert.deepEqual(fs.readFileSync(displacedLock), ownerBefore)
    assert.equal(releaseError, undefined, 'leaf unlink must safely remove only the substituted symlink')
  } finally {
    fs.rmSync(displacedLock, { force: true })
    fs.rmSync(victim, { recursive: true, force: true })
  }
})

test('stale recovery rejects a copied owner file substituted at the rename boundary', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock, ReleaseLockError } = await import(releaseLockModuleUrl)
  const lockPath = writeReleaseLock(repo, {
    pid: 2_147_483_647,
    helper: 'aamp-npm-release',
    operation: 'pack',
  })
  const ownerBefore = fs.readFileSync(lockPath)
  const displacedLock = `${lockPath}.original-stale-owner`
  const originalRenameSync = fs.renameSync
  let injected = false
  let acquisitionError

  fs.renameSync = function injectedRenameSync(source, destination) {
    if (!injected && path.resolve(String(source)) === path.resolve(lockPath)) {
      injected = true
      originalRenameSync.call(this, lockPath, displacedLock)
      fs.writeFileSync(lockPath, ownerBefore, { mode: 0o600 })
    }
    return originalRenameSync.call(this, source, destination)
  }
  try {
    try {
      const acquired = acquireReleaseLock({
        repoRoot: repo,
        helper: 'aamp-npm-release',
        operation: 'prepare-source',
        handleSignals: false,
      })
      acquired.release()
    } catch (error) {
      acquisitionError = error
    }
  } finally {
    fs.renameSync = originalRenameSync
  }
  try {
    assert.equal(injected, true)
    assert.ok(acquisitionError instanceof ReleaseLockError)
    assert.equal(acquisitionError.code, 'AAMP_RELEASE_LOCK_INVALID')
    assert.deepEqual(fs.readFileSync(displacedLock), ownerBefore)
    const quarantines = releaseLockQuarantines(lockPath)
    assert.equal(quarantines.length, 1)
    assert.deepEqual(fs.readFileSync(quarantines[0]), ownerBefore)
  } finally {
    fs.rmSync(displacedLock, { force: true })
    for (const quarantine of releaseLockQuarantines(lockPath)) {
      fs.rmSync(quarantine, { force: true })
    }
  }
})

test('acquisition rejects a copied owner file substituted before first validation', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock, ReleaseLockError } = await import(releaseLockModuleUrl)
  const lockPath = releaseLockPath(repo)
  const displacedLock = `${lockPath}.original-acquired-owner`
  const originalLstatSync = fs.lstatSync
  const originalRenameSync = fs.renameSync
  let injected = false
  let acquisitionError

  fs.lstatSync = function injectedLstatSync(target, ...args) {
    const targetPath = path.resolve(String(target))
    if (!injected && targetPath === path.resolve(lockPath) && fs.existsSync(lockPath)) {
      const currentStat = originalLstatSync.call(this, target, ...args)
      if (currentStat.isFile()) {
        injected = true
        const ownerBytes = fs.readFileSync(lockPath)
        originalRenameSync.call(this, lockPath, displacedLock)
        fs.writeFileSync(lockPath, ownerBytes, { mode: 0o600 })
      }
    }
    return originalLstatSync.call(this, target, ...args)
  }
  try {
    try {
      const acquired = acquireReleaseLock({
        repoRoot: repo,
        helper: 'aamp-npm-release',
        operation: 'pack',
        handleSignals: false,
      })
      acquired.release()
    } catch (error) {
      acquisitionError = error
    }
  } finally {
    fs.lstatSync = originalLstatSync
  }
  try {
    assert.equal(injected, true)
    assert.ok(acquisitionError instanceof ReleaseLockError)
    assert.equal(acquisitionError.code, 'AAMP_RELEASE_LOCK_INVALID')
    assert.equal(fs.existsSync(displacedLock), true)
  } finally {
    fs.rmSync(lockPath, { force: true })
    fs.rmSync(displacedLock, { force: true })
    for (const quarantine of releaseLockQuarantines(lockPath)) fs.rmSync(quarantine, { force: true })
  }
})

test('failed owner write removes only the exact exclusively created lock file', async (t) => {
  const repo = createReleaseRepo(t)
  const { acquireReleaseLock } = await import(releaseLockModuleUrl)
  const lockPath = releaseLockPath(repo)
  const originalWriteFileSync = fs.writeFileSync
  let injected = false

  fs.writeFileSync = function injectedWriteFileSync(target, ...args) {
    if (!injected && typeof target === 'number') {
      injected = true
      const error = new Error('injected owner write failure')
      error.code = 'EIO'
      throw error
    }
    return originalWriteFileSync.call(this, target, ...args)
  }
  let acquisitionError
  try {
    try {
      acquireReleaseLock({
        repoRoot: repo,
        helper: 'aamp-npm-release',
        operation: 'pack',
        handleSignals: false,
      })
    } catch (error) {
      acquisitionError = error
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync
  }

  assert.equal(injected, true)
  assert.equal(acquisitionError?.code, 'EIO')
  assert.equal(fs.existsSync(lockPath), false)
  assert.deepEqual(releaseLockQuarantines(lockPath), [])
})

test('local tgz command clears every inherited package override before enabling selected artifacts', (t) => {
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: '@release-test/aamp-feishu-task-agent',
  })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-acp-bridge': ['1.2.3'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--package', 'taskAgent',
    '--pack',
    '--skip-build',
    '--out-dir', '.isolated-command-output',
  ])

  assert.equal(result.status, 0, result.stderr)
  const command = result.stdout.slice(result.stdout.indexOf('local tgz test command:'))
  const cleared = [
    'ACP_BRIDGE_PKG',
    'AAMP_TASK_ACP_BRIDGE_PKG',
    'FEISHU_BRIDGE_PKG',
    'AAMP_TASK_FEISHU_BRIDGE_PKG',
    'AIME_ACP_PKG',
    'AAMP_TASK_AIME_ACP_PKG',
    'AIME_ACP_REGISTRY',
    'AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG',
    'AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG',
    'AAMP_TASK_REQUESTED_AIME_ACP_PKG',
    'AAMP_TASK_AGENT_NAME',
    'AAMP_TASK_AGENT_LEGACY_NAME',
    'AAMP_TASK_AGENT_CHANNEL',
    'AAMP_TASK_COMMAND_NAME',
    'AAMP_TASK_COMMAND_PATH',
    'AAMP_TASK_SHIM_DIR',
    'AAMP_TASK_ENTRY',
    'AAMP_TASK_INTERNAL',
    'AAMP_TASK_INTERNAL_RESULT_FD',
    'AAMP_TASK_INTERNAL_INPUT_FD',
    'AAMP_TASK_INTERNAL_EXECUTION_LOCATION',
    'AAMP_TASK_PACKAGE_OVERRIDES_RESOLVED',
    'AAMP_TASK_NPM_REGISTRY',
    'AAMP_TASK_NPM_GLOBAL_PREFIX',
    'AAMP_TASK_NPM_CACHE_DIR',
    'AAMP_TASK_NPM_BIN',
    'AAMP_TASK_NPX_BIN',
    'AAMP_TASK_INSTALL_COMMAND',
    'NPM_REGISTRY',
    'NPM_CONFIG_REGISTRY',
    'npm_config_registry',
    'NPM_GLOBAL_PREFIX',
    'AAMP_BIN_DIR',
    'AAMP_TASK_COMMAND_PATH',
    'AAMP_TASK_SHIM_DIR',
  ]
  for (const variable of cleared) {
    assert.match(command, new RegExp(`(?:^|\\s)-u ${variable}(?:\\s|$)`), `${variable} must be cleared`)
  }
  assert.ok(command.indexOf('-u AIME_ACP_REGISTRY') < command.indexOf('AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true'))
  assert.doesNotMatch(command, /(?:^|\s)(?:ACP_BRIDGE_PKG|FEISHU_BRIDGE_PKG|AIME_ACP_PKG)=/)
})

test('release helper keeps --agent only as a deprecated compatibility option', () => {
  const help = execFileSync(process.execPath, [helperPath, '--help'], { encoding: 'utf8' })
  const source = fs.readFileSync(helperPath, 'utf8')

  assert.match(help, /--agent NAME\s+Deprecated compatibility option; printed startup commands omit --agent/)
  assert.doesNotMatch(help, /Default: coco/)
  assert.doesNotMatch(source, /bash -s -- install --agent/)
})

test('local tgz startup command explicitly opts in to package overrides', () => {
  const source = fs.readFileSync(helperPath, 'utf8')
  assert.match(source, /AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true/)
})

test('release skill documents interactive agent selection without a startup flag', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /one-click startup commands omit `--agent`/i)
  assert.match(skill, /interactive multi-select/i)
  assert.doesNotMatch(skill, /defaults?\s+generated startup commands to `--agent coco`/i)
})

test('release skill documents the shared cross-helper concurrency lock', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /shared release lock/i)
  assert.match(skill, /aamp-local-release/)
  assert.match(skill, /concurren/i)
  assert.match(skill, /fail fast|fail-fast/i)
})

test('release skill uses registry identities by default and keeps scope flags assertion-only', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /`--scope` is assertion-only/i)
  assert.match(skill, /`--aime-scope` is assertion-only/i)
  assert.doesNotMatch(skill, /--aime-scope @<bnpm-whoami>/)
  assert.doesNotMatch(skill, /--scope @luckyterry/)
  assert.doesNotMatch(skill, /--scope @larktask/)
})

test('release helper rejects the removed trae agent type', () => {
  const result = spawnSync(process.execPath, [helperPath, '--agent', 'trae', '--help'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--agent must be one of: codex, cursor, coco, traex, traecli, workbuddy/)
})

test('trial --prepare-source bumps stable packages to the next patch dev.0 and only writes source metadata', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  fs.writeFileSync(path.join(repo, 'existing-user-change.txt'), 'preserve me\n')

  const result = spawnSync(
    process.execPath,
    [
      helperPath,
      '--mode', 'trial',
      '--prepare-source',
      '--bump', 'patch',
      '--pm', fakeNpm,
      '--scope', '@release-test',
      '--package', 'acpBridge',
    ],
    { cwd: repo, encoding: 'utf8', env },
  )

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /selected packages: acpBridge, taskAgent/)
  assert.match(result.stdout, /@canonical\/aamp-acp-bridge@1\.2\.3 -> @release-test\/aamp-acp-bridge@1\.2\.4-dev\.0/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')).version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')).packages[''].version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package-lock.json')).packages[''].version, '2.4.7-dev.0')
  const bootstrap = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  assert.match(bootstrap, /AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-@release-test\/aamp-feishu-task-agent\}"/)
  assert.match(bootstrap, /AAMP_TASK_AGENT_VERSION="2\.4\.7-dev\.0"/)
  assert.match(bootstrap, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@release-test\/aamp-acp-bridge@1\.2\.4-dev\.0\}"/)
  assert.equal(fs.readFileSync(path.join(repo, 'existing-user-change.txt'), 'utf8'), 'preserve me\n')
  const calls = fakeNpmCalls(log)
  assert.equal(calls.some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
  assert.equal(calls.some(({ args }) => args.includes('https://bnpm.byted.org')), false)
})

test('trial --prepare-source accepts explicit source versions and lets an existing dependency be adopted without publishing it', (t) => {
  const repo = createReleaseRepo(t, {
    acpBridge: '1.2.3-dev.7',
    feishuBridge: '3.4.5',
    taskAgent: '2.4.6-dev.9',
  })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@release-test/aamp-feishu-bridge': ['3.4.5-dev.3'],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
    '--package', 'feishuBridge',
    '--package', 'taskAgent',
    '--version', 'acpBridge=1.3.0-dev.0',
    '--version', 'feishuBridge=3.4.5-dev.3',
    '--version', 'taskAgent=2.5.0-dev.0',
  ])

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /@canonical\/aamp-acp-bridge@1\.2\.3-dev\.7 -> @release-test\/aamp-acp-bridge@1\.3\.0-dev\.0/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.3.0-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-bridge/package.json')).version, '3.4.5-dev.3')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.5.0-dev.0')
  const bootstrap = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  assert.match(bootstrap, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@release-test\/aamp-acp-bridge@1\.3\.0-dev\.0\}"/)
  assert.match(bootstrap, /FEISHU_BRIDGE_PKG="\$\{FEISHU_BRIDGE_PKG:-@release-test\/aamp-feishu-bridge@3\.4\.5-dev\.3\}"/)
  assert.match(bootstrap, /AAMP_TASK_AGENT_VERSION="2\.5\.0-dev\.0"/)
})

test('explicit --version is rejected outside source preparation and validates the release mode', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t)

  const outsidePrepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial', '--plan-only', '--scope', '@release-test', '--package', 'acpBridge', '--version', 'acpBridge=1.3.0-dev.0',
  ])
  assert.equal(outsidePrepare.status, 1)
  assert.match(outsidePrepare.stderr, /only supported with --prepare-source/i)

  const invalidTrialVersion = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial', '--prepare-source', '--scope', '@release-test', '--package', 'acpBridge', '--version', 'acpBridge=1.3.0',
  ])
  assert.equal(invalidTrialVersion.status, 1)
  assert.match(invalidTrialVersion.stderr, /must be x\.y\.z-dev\.N/i)
})

test('trial --prepare-source bumps stable packages to dev.0 from source versions only', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@release-test/aamp-acp-bridge': ['9.9.9-dev.999'],
    'https://registry.npmjs.org/|@release-test/aamp-feishu-task-agent': ['8.8.8-dev.888'],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--bump', 'patch',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /@canonical\/aamp-acp-bridge@1\.2\.3 -> @release-test\/aamp-acp-bridge@1\.2\.4-dev\.0/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')).packages[''].version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
  assert.match(
    fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8'),
    /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@release-test\/aamp-acp-bridge@1\.2\.4-dev\.0\}"/,
  )
})

test('trial --prepare-source advances dev versions above the source and same-base registry maximum', (t) => {
  const repo = createReleaseRepo(t, {
    acpBridge: '1.2.3-dev.7',
    taskAgent: '2.4.6-dev.4',
  })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@release-test/aamp-acp-bridge': [
      '1.2.3-dev.12',
      '1.2.4-dev.999',
      '1.2.3-dev.5',
      '1.2.3-beta.100',
    ],
    'https://registry.npmjs.org/|@release-test/aamp-feishu-task-agent': [
      '2.4.6-dev.2',
      '2.4.6-dev.9',
    ],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.3-dev.8')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')).packages[''].version, '1.2.3-dev.8')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.6-dev.5')
  assert.match(
    fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8'),
    /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@release-test\/aamp-acp-bridge@1\.2\.3-dev\.8\}"/,
  )
})

test('ordinary trial plan and pack reuse prepared source versions and only rename packages in staging', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })
  const prepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])
  assert.equal(prepare.status, 0, prepare.stderr)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare source'], { cwd: repo })

  const plan = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--plan-only',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /@canonical\/aamp-acp-bridge@1\.2\.4-dev\.0 -> @release-test\/aamp-acp-bridge@1\.2\.4-dev\.0/)
  assert.match(plan.stdout, /@larktask\/aamp-feishu-task-agent@2\.4\.7-dev\.0 -> @release-test\/aamp-feishu-task-agent@2\.4\.7-dev\.0/)

  const packed = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--pack',
    '--skip-build',
    '--out-dir', '.release-output',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])
  assert.equal(packed.status, 0, packed.stderr)
  const stageName = fs.readdirSync(path.join(repo, '.release-output')).find((name) => name.startsWith('stage-trial-release-test-'))
  assert.ok(stageName)
  const stageRoot = path.join(repo, '.release-output', stageName)
  const stagedAcp = readJson(path.join(stageRoot, 'aamp-acp-bridge/package.json'))
  const stagedTask = readJson(path.join(stageRoot, 'aamp-feishu-task-agent/package.json'))
  assert.deepEqual({ name: stagedAcp.name, version: stagedAcp.version }, {
    name: '@release-test/aamp-acp-bridge',
    version: '1.2.4-dev.0',
  })
  assert.deepEqual({ name: stagedTask.name, version: stagedTask.version }, {
    name: '@release-test/aamp-feishu-task-agent',
    version: '2.4.7-dev.0',
  })
  const stagedBootstrap = fs.readFileSync(path.join(stageRoot, 'aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  assert.match(stagedBootstrap, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@release-test\/aamp-acp-bridge@1\.2\.4-dev\.0\}"/)
  assert.match(stagedBootstrap, /FEISHU_BRIDGE_PKG="\$\{FEISHU_BRIDGE_PKG:-@canonical\/aamp-feishu-bridge@3\.4\.5\}"/)
  assert.match(stagedBootstrap, /AIME_ACP_PKG="\$\{AIME_ACP_PKG:-@tengchengwei\/aime-acp@0\.1\.0-dev\.3\}"/)
  assert.match(stagedBootstrap, /AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-@release-test\/aamp-feishu-task-agent\}"/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).name, '@canonical/aamp-acp-bridge')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).name, '@larktask/aamp-feishu-task-agent')
  const packCalls = fakeNpmCalls(log).filter(({ args }) => args[0] === 'pack')
  assert.equal(packCalls.length, 2)
  assert.equal(fakeNpmCalls(log).some(({ args }) => args[0] === 'publish'), false)
})

test('ordinary pack rejects a prepared package lock that drifted after source preparation', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  const prepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])
  assert.equal(prepare.status, 0, prepare.stderr)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare source'], { cwd: repo })

  const lockFile = path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')
  const lock = readJson(lockFile)
  lock.packages[''].version = '9.9.9-dev.9'
  writeJson(lockFile, lock)

  const packed = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@release-test',
    '--package', 'acpBridge',
    '--pack',
    '--skip-build',
  ])

  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /Package lock validation failed/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['pack', 'publish'].includes(args[0])), false)
})

test('ordinary pack rejects prepared Task Agent pins that drifted after source preparation', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })
  const prepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'acpBridge',
  ])
  assert.equal(prepare.status, 0, prepare.stderr)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare source'], { cwd: repo })

  const controllerFile = path.join(repo, 'packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs')
  fs.writeFileSync(
    controllerFile,
    fs.readFileSync(controllerFile, 'utf8').replace(
      '@release-test/aamp-acp-bridge@1.2.4-dev.0',
      '@release-test/aamp-acp-bridge@1.2.4-dev.999',
    ),
  )

  const packed = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@release-test',
    '--package', 'acpBridge',
    '--pack',
    '--skip-build',
  ])

  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /ACP bridge prepared source pin validation failed/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['pack', 'publish'].includes(args[0])), false)
})

test('ordinary trial publish rejects a stable source as unprepared before TTY, build, pack, or publish', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@release-test',
    '--package', 'acpBridge',
    '--publish',
    '--confirm-publish',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /trial release requires a prepared source version.*--prepare-source/i)
  assert.doesNotMatch(result.stderr, /requires a TTY/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
})

test('ordinary trial rejects an exact source version already present in the target registry', (t) => {
  const repo = createReleaseRepo(t, {
    acpBridge: '1.2.4-dev.0',
    taskAgent: '2.4.7-dev.0',
  })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: '@release-test/aamp-feishu-task-agent',
    acpPin: '@release-test/aamp-acp-bridge@1.2.4-dev.0',
  })
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@release-test/aamp-acp-bridge': ['1.2.4-dev.0'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@release-test',
    '--package', 'acpBridge',
    '--pack',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Source version 1\.2\.4-dev\.0 already exists.*--prepare-source/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
})

test('publish uses the exact packed tgz artifact instead of repacking the staging directory', (t) => {
  if (process.platform === 'win32') {
    t.skip('PTY-backed publish assertion requires POSIX script(1)')
    return
  }
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-acp-bridge': ['1.2.3'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })
  writeJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json'), {
    name: '@larktask/aamp-feishu-task-agent',
    version: '2.4.7-dev.0',
  })
  writeJson(path.join(repo, 'packages/aamp-feishu-task-agent/package-lock.json'), {
    name: '@larktask/aamp-feishu-task-agent',
    version: '2.4.7-dev.0',
    lockfileVersion: 3,
    packages: { '': { name: '@larktask/aamp-feishu-task-agent', version: '2.4.7-dev.0' } },
  })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: '@release-test/aamp-feishu-task-agent',
  })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare publish fixture'], { cwd: repo })
  const expectScript = path.join(path.dirname(fakeNpm), 'publish.exp')
  fs.writeFileSync(expectScript, [
    'set timeout 30',
    `spawn ${[process.execPath, helperPath, '--pm', fakeNpm, '--mode', 'trial', '--package', 'taskAgent', '--publish', '--confirm-publish', '--allow-dirty', '--skip-build', '--out-dir', '.publish-output'].map((value) => `{${value}}`).join(' ')}`,
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
    '',
  ].join('\n'))
  const result = spawnSync('/usr/bin/expect', [expectScript], { cwd: repo, encoding: 'utf8', env })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const publishCall = fakeNpmCalls(log).find(({ args }) => args[0] === 'publish')
  assert.ok(publishCall)
  assert.match(publishCall.args[1], /release-test-aamp-feishu-task-agent-2\.4\.7-dev\.0\.tgz$/)
  assert.equal(publishCall.args[1].includes('stage-trial'), false)

  const verified = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--package', 'taskAgent',
    '--verify-published',
    '--skip-build',
    '--out-dir', '.verify-output',
  ])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /visible, packed shasum verified/)
  assert.equal(fakeNpmCalls(log).filter(({ args }) => args[0] === 'publish').length, 1)

  const resumeScript = path.join(path.dirname(fakeNpm), 'resume.exp')
  fs.writeFileSync(resumeScript, [
    'set timeout 30',
    `spawn ${[process.execPath, helperPath, '--pm', fakeNpm, '--mode', 'trial', '--package', 'taskAgent', '--resume-publish', '--confirm-publish', '--allow-dirty', '--skip-build', '--out-dir', '.resume-output'].map((value) => `{${value}}`).join(' ')}`,
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
    '',
  ].join('\n'))
  const resumed = spawnSync('/usr/bin/expect', [resumeScript], { cwd: repo, encoding: 'utf8', env })
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`)
  assert.match(resumed.stdout, /resume verify: @release-test\/aamp-feishu-task-agent@2\.4\.7-dev\.0/)
  assert.equal(fakeNpmCalls(log).filter(({ args }) => args[0] === 'publish').length, 1)
})

test('publish retries temporarily incomplete registry artifact metadata', (t) => {
  if (process.platform === 'win32') {
    t.skip('PTY-backed publish assertion requires POSIX expect(1)')
    return
  }
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-acp-bridge': ['1.2.3'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: '@release-test/aamp-feishu-task-agent',
  })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare delayed publish fixture'], { cwd: repo })
  const expectScript = path.join(path.dirname(fakeNpm), 'publish-delay.exp')
  fs.writeFileSync(expectScript, [
    'set timeout 30',
    `spawn ${[process.execPath, helperPath, '--pm', fakeNpm, '--mode', 'trial', '--package', 'taskAgent', '--publish', '--confirm-publish', '--allow-dirty', '--skip-build', '--out-dir', '.publish-delay-output'].map((value) => `{${value}}`).join(' ')}`,
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
    '',
  ].join('\n'))

  const result = spawnSync('/usr/bin/expect', [expectScript], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, AAMP_FAKE_NPM_METADATA_DELAY: '1' },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const exactViews = fakeNpmCalls(log).filter(({ args }) =>
    args[0] === 'view' && args[1] === '@release-test/aamp-feishu-task-agent@2.4.7-dev.0')
  assert.equal(exactViews.length, 2)
})

test('resume publish needs no TTY when every public target is already published', (t) => {
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  const taskName = '@release-test/aamp-feishu-task-agent'
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    [`https://registry.npmjs.org/|${taskName}`]: ['2.4.7-dev.0'],
  })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: taskName,
  })
  const artifact = path.join(path.dirname(fakeNpm), 'task-agent.tgz')
  fs.writeFileSync(artifact, `${taskName}@2.4.7-dev.0\n`)
  const bytes = fs.readFileSync(artifact)
  const registryState = readJson(path.join(path.dirname(fakeNpm), 'registry.json'))
  registryState[`https://registry.npmjs.org/|${taskName}|2.4.7-dev.0`] = {
    version: '2.4.7-dev.0',
    dist: {
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: 'sha512-fake-integrity',
      tarball: 'https://registry.test/task-agent.tgz',
    },
  }
  writeJson(path.join(path.dirname(fakeNpm), 'registry.json'), registryState)

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--package', 'taskAgent',
    '--resume-publish', '--confirm-publish',
    '--skip-build',
    '--out-dir', '.resume-no-tty',
  ])

  assert.doesNotMatch(result.stderr, /requires a TTY/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => args[0] === 'publish'), false)
})

test('final --prepare-source requires --bump and rejects --version overrides', (t) => {
  const repo = createReleaseRepo(t, { acpBridge: '1.2.3-dev.7', taskAgent: '2.4.6-dev.9' })
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {}, { publicWhoami: 'larktask' })
  const acpBefore = fs.readFileSync(path.join(repo, 'packages/aamp-acp-bridge/package.json'), 'utf8')
  const taskBefore = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/package.json'), 'utf8')

  const invalid = runRelease(repo, fakeNpm, env, [
    '--mode', 'final',
    '--prepare-source',
    '--scope', '@larktask',
    '--package', 'acpBridge',
    '--version', 'acpBridge=2.0.0',
  ])

  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /--version.*no longer supported/i)
  assert.equal(fs.readFileSync(path.join(repo, 'packages/aamp-acp-bridge/package.json'), 'utf8'), acpBefore)
  assert.equal(fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/package.json'), 'utf8'), taskBefore)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
})

test('final --prepare-source uses deterministic bumps from source versions and ordinary final pack reuses them exactly', (t) => {
  const repo = createReleaseRepo(t, { acpBridge: '1.2.3-dev.7', taskAgent: '2.4.6-dev.9' })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@larktask/aamp-acp-bridge': ['99.0.0'],
    'https://registry.npmjs.org/|@larktask/aamp-feishu-task-agent': ['88.0.0'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  }, { publicWhoami: 'larktask' })

  const prepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'final',
    '--prepare-source',
    '--scope', '@larktask',
    '--bump', 'patch',
    '--package', 'acpBridge',
  ])
  assert.equal(prepare.status, 0, prepare.stderr)
  assert.match(prepare.stdout, /dist-tag: latest/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.3')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package-lock.json')).packages[''].version, '1.2.3')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.6')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package-lock.json')).version, '2.4.6')
  const sourceBootstrap = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  assert.match(sourceBootstrap, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@larktask\/aamp-acp-bridge@1\.2\.3\}"/)
  assert.match(sourceBootstrap, /AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-@larktask\/aamp-feishu-task-agent\}"/)
  assert.match(sourceBootstrap, /AAMP_TASK_AGENT_VERSION="2\.4\.6"/)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare final source'], { cwd: repo })

  const packed = runRelease(repo, fakeNpm, env, [
    '--mode', 'final',
    '--scope', '@larktask',
    '--package', 'acpBridge',
    '--pack',
    '--skip-build',
    '--out-dir', '.final-output',
  ])
  assert.equal(packed.status, 0, packed.stderr)
  assert.match(packed.stdout, /@canonical\/aamp-acp-bridge@1\.2\.3 -> @larktask\/aamp-acp-bridge@1\.2\.3/)
  assert.match(packed.stdout, /@larktask\/aamp-feishu-task-agent@2\.4\.6 -> @larktask\/aamp-feishu-task-agent@2\.4\.6/)
})

test('ordinary final rejects prerelease sources and stable versions already in the registry', (t) => {
  const prereleaseRepo = createReleaseRepo(t, { acpBridge: '2.0.0-dev.3', taskAgent: '3.0.0-dev.4' })
  const firstNpm = createStatefulFakeNpm(t, {}, { publicWhoami: 'larktask' })
  const prerelease = runRelease(prereleaseRepo, firstNpm.fakeNpm, firstNpm.env, [
    '--mode', 'final',
    '--scope', '@larktask',
    '--package', 'acpBridge',
    '--plan-only',
  ])
  assert.equal(prerelease.status, 1)
  assert.match(prerelease.stderr, /requires a stable source version/)

  const stableRepo = createReleaseRepo(t, { acpBridge: '2.0.0', taskAgent: '3.0.0' })
  writeTaskAgentSourcePins(stableRepo, {
    publicScope: '@larktask',
    acpPin: '@larktask/aamp-acp-bridge@2.0.0',
    taskAgentVersion: '3.0.0',
    taskAgentName: '@larktask/aamp-feishu-task-agent',
    taskAgentChannel: 'latest',
  })
  const secondNpm = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@larktask/aamp-acp-bridge': ['2.0.0'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  }, { publicWhoami: 'larktask' })
  const existing = runRelease(stableRepo, secondNpm.fakeNpm, secondNpm.env, [
    '--mode', 'final',
    '--scope', '@larktask',
    '--package', 'acpBridge',
    '--pack',
  ])
  assert.equal(existing.status, 1)
  assert.match(existing.stderr, /Final version 2\.0\.0 already exists.*--prepare-source/)
  assert.equal(fakeNpmCalls(secondNpm.log).some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
})

test('release helper prepares AIME, ACP bridge, and Task Agent source versions and actual target pins', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://bnpm.byted.org|@bnpm-user/aime-acp': ['0.1.0-dev.9'],
  }, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-user',
  })
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--aime-scope', '@bnpm-user',
    '--package', 'aimeAcp',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /selected packages: aimeAcp, acpBridge, taskAgent/)
  assert.match(result.stdout, /@tengchengwei\/aime-acp@0\.1\.0 -> @bnpm-user\/aime-acp@0\.1\.1-dev\.0/)
  assert.match(result.stdout, /@canonical\/aamp-acp-bridge@1\.2\.3 -> @public-owner\/aamp-acp-bridge@1\.2\.4-dev\.0/)
  assert.equal(readJson(path.join(repo, 'packages/aime-acp/package.json')).version, '0.1.1-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aime-acp/package-lock.json')).packages[''].version, '0.1.1-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
  const bootstrap = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  assert.equal(bootstrap.match(/@bnpm-user\/aime-acp@0\.1\.1-dev\.0/g)?.length, 2)
  assert.match(bootstrap, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@public-owner\/aamp-acp-bridge@1\.2\.4-dev\.0\}"/)
  assert.match(bootstrap, /FEISHU_BRIDGE_PKG="\$\{FEISHU_BRIDGE_PKG:-@canonical\/aamp-feishu-bridge@3\.4\.5\}"/)
  assert.match(bootstrap, /AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-@public-owner\/aamp-feishu-task-agent\}"/)
  assert.match(bootstrap, /AAMP_TASK_AGENT_VERSION="2\.4\.7-dev\.0"/)
  assert.equal(readJson(path.join(repo, 'packages/aime-acp/package.json')).name, '@tengchengwei/aime-acp')
  assert.match(fakeNpmCalls(log).find(({ args }) => args[0] === 'view' && args[1] === '@bnpm-user/aime-acp').args.join(' '), /bnpm\.byted\.org/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['run', 'pack', 'publish'].includes(args[0])), false)
})

test('prepare-source rewrites Task Agent target scope consistently in bootstrap, controller, and README while source package name stays canonical', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t, {}, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-owner',
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 0, result.stderr)
  const taskDir = path.join(repo, 'packages/aamp-feishu-task-agent')
  const bootstrap = fs.readFileSync(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  const controller = fs.readFileSync(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), 'utf8')
  const readme = fs.readFileSync(path.join(taskDir, 'README.md'), 'utf8')
  assert.match(bootstrap, /AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-@public-owner\/aamp-feishu-task-agent\}"/)
  assert.match(controller, /@public-owner\/aamp-feishu-task-agent@dev/)
  assert.match(readme, /@public-owner\/aamp-feishu-task-agent@dev/)
  assert.equal(readJson(path.join(taskDir, 'package.json')).name, '@larktask/aamp-feishu-task-agent')
})

test('trial prepare-source freezes Task Agent channel dev and self-install refs at @dev', (t) => {
  const repo = createReleaseRepo(t)
  const taskDir = path.join(repo, 'packages/aamp-feishu-task-agent')
  writeTaskAgentSourcePins(repo, {
    taskAgentName: '@public-owner/aamp-feishu-task-agent',
    taskAgentVersion: '2.4.6',
    taskAgentChannel: 'latest',
  })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {}, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-owner',
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 0, result.stderr)
  const bootstrap = fs.readFileSync(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  const controller = fs.readFileSync(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), 'utf8')
  const readme = fs.readFileSync(path.join(taskDir, 'README.md'), 'utf8')
  assert.match(bootstrap, /AAMP_TASK_AGENT_CHANNEL="\$\{AAMP_TASK_AGENT_CHANNEL:-dev\}"/)
  assert.match(controller, /@public-owner\/aamp-feishu-task-agent@dev/)
  assert.match(readme, /@public-owner\/aamp-feishu-task-agent@dev/)
  assert.doesNotMatch(controller, /@public-owner\/aamp-feishu-task-agent@latest/)
  assert.doesNotMatch(readme, /@public-owner\/aamp-feishu-task-agent@latest/)
})

test('final prepare-source freezes Task Agent channel latest and self-install refs at @latest', (t) => {
  const repo = createReleaseRepo(t, { taskAgent: '2.4.6-dev.9' })
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@larktask/aamp-feishu-task-agent': ['88.0.0'],
    'https://registry.npmjs.org/|@canonical/aamp-acp-bridge': ['1.2.3'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  }, { publicWhoami: 'larktask' })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'final',
    '--prepare-source',
    '--scope', '@larktask',
    '--bump', 'patch',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 0, result.stderr)
  const taskDir = path.join(repo, 'packages/aamp-feishu-task-agent')
  const bootstrap = fs.readFileSync(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  const controller = fs.readFileSync(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), 'utf8')
  const readme = fs.readFileSync(path.join(taskDir, 'README.md'), 'utf8')
  assert.match(bootstrap, /AAMP_TASK_AGENT_CHANNEL="\$\{AAMP_TASK_AGENT_CHANNEL:-latest\}"/)
  assert.match(controller, /@larktask\/aamp-feishu-task-agent@latest/)
  assert.match(readme, /@larktask\/aamp-feishu-task-agent@latest/)
  assert.doesNotMatch(controller, /@larktask\/aamp-feishu-task-agent@dev/)
  assert.doesNotMatch(readme, /@larktask\/aamp-feishu-task-agent@dev/)
})

test('release helper rejects AIME scope assertions that do not match the BNPM identity', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {}, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-user',
  })
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--aime-scope', '@another-owner',
    '--package', 'aimeAcp',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--aime-scope .*must equal @bnpm-user/i)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['view', 'run', 'pack', 'publish'].includes(args[0])), false)
  assert.equal(readJson(path.join(repo, 'packages/aime-acp/package.json')).version, '0.1.0')
})

test('release helper rejects routing AIME to the public npm registry', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--aime-registry', 'https://registry.npmjs.org/',
    '--package', 'aimeAcp',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /AIME registry is fixed to https:\/\/bnpm\.byted\.org/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['whoami', 'view', 'pack', 'publish'].includes(args[0])), false)
})

test('release helper rejects routing public AAMP packages to BNPM', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--registry', 'https://bnpm.byted.org',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /public AAMP registry is fixed to https:\/\/registry\.npmjs\.org/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['whoami', 'view', 'pack', 'publish'].includes(args[0])), false)
})

test('release helper fixes trial packages to the authenticated personal scope', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@release-test/aamp-acp-bridge': ['9.9.9-dev.999'],
  })
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /target scope: @release-test/)
  assert.match(result.stdout, /@release-test\/aamp-acp-bridge@1\.2\.4-dev\.0/)
  assert.equal(fakeNpmCalls(log).some(({ args }) => args.includes('@someone-else/aamp-acp-bridge')), false)
})

test('release helper requires the public npm identity to be larktask for final releases', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t)
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'final',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'taskAgent',
    '--bump', 'patch',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /public npm identity must be exactly larktask/i)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['view', 'pack', 'publish'].includes(args[0])), false)
})

test('release helper accepts trial scope and AIME scope flags only as matching identity assertions', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t, {}, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-owner',
  })

  const ok = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--aime-scope', '@bnpm-owner',
    '--package', 'aimeAcp',
  ])
  assert.equal(ok.status, 0, ok.stderr)

  const publicMismatch = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@someone-else',
    '--package', 'taskAgent',
  ])
  assert.equal(publicMismatch.status, 1)
  assert.match(publicMismatch.stderr, /--scope .*must equal @public-owner/i)
})

test('release helper keeps non-AIME planning independent from the AIME registry', (t) => {
  const { fakeNpm, log } = createRegistryAwareFakeNpm(t)
  const result = spawnSync(
    process.execPath,
    [
      helperPath,
      '--mode', 'trial',
      '--pm', fakeNpm,
      '--scope', '@luckyterry',
      '--package', 'acpBridge',
      '--plan-only',
    ],
    { encoding: 'utf8', env: { ...process.env, AAMP_FAKE_NPM_LOG: log } },
  )

  assert.equal(result.status, 0, result.stderr)
  const calls = fs.readFileSync(log, 'utf8')
  assert.doesNotMatch(calls, /view @tengchengwei\/aime-acp .*bnpm\.byted\.org/)
  assert.match(result.stdout, /selected packages: acpBridge, taskAgent/)
})

test('Task Agent-only prepare stays isolated from BNPM and preserves the AIME source pin', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.99'],
  })
  const bootstrapFile = path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh')
  const aimePinsBefore = fs.readFileSync(bootstrapFile, 'utf8').match(/@tengchengwei\/aime-acp@[0-9A-Za-z.-]+/g)
  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'taskAgent',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /selected packages: taskAgent/)
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
  assert.deepEqual(
    fs.readFileSync(bootstrapFile, 'utf8').match(/@tengchengwei\/aime-acp@[0-9A-Za-z.-]+/g),
    aimePinsBefore,
  )
  assert.equal(fakeNpmCalls(log).some(({ args }) => args.includes('https://bnpm.byted.org')), false)
})

test('pack validates all default Task Agent pins and tells the user which missing package to include', (t) => {
  const repo = createReleaseRepo(t, { taskAgent: '2.4.7-dev.0' })
  writeTaskAgentSourcePins(repo, {
    taskAgentVersion: '2.4.7-dev.0',
    taskAgentName: '@release-test/aamp-feishu-task-agent',
  })
  const { fakeNpm, log, env } = createStatefulFakeNpm(t, {
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
    'https://bnpm.byted.org|@tengchengwei/aime-acp': ['0.1.0-dev.3'],
  })

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@release-test',
    '--package', 'taskAgent',
    '--pack',
    '--skip-build',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Include --package acpBridge/i)
  assert.equal(fakeNpmCalls(log).some(({ args }) => ['pack', 'publish'].includes(args[0])), false)
})

test('staging preserves prepared Task Agent pins byte-for-byte while renaming only the staged package identity', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t, {
    'https://bnpm.byted.org|@bnpm-owner/aime-acp': ['0.1.0-dev.1'],
    'https://registry.npmjs.org/|@canonical/aamp-acp-bridge': ['1.2.3'],
    'https://registry.npmjs.org/|@canonical/aamp-feishu-bridge': ['3.4.5'],
  }, {
    publicWhoami: 'public-owner',
    bnpmWhoami: 'bnpm-owner',
  })

  const prepare = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@public-owner',
    '--aime-scope', '@bnpm-owner',
    '--package', 'aimeAcp',
    '--package', 'taskAgent',
  ])
  assert.equal(prepare.status, 0, prepare.stderr)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'prepare staged pin invariants'], { cwd: repo })

  const sourceBootstrap = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')
  const sourceController = fs.readFileSync(path.join(repo, 'packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs'), 'utf8')

  const packed = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--scope', '@public-owner',
    '--aime-scope', '@bnpm-owner',
    '--package', 'aimeAcp',
    '--package', 'taskAgent',
    '--pack',
    '--skip-build',
    '--out-dir', '.pin-output',
  ])
  assert.equal(packed.status, 0, packed.stderr)
  const tgzFile = fs.readdirSync(path.join(repo, '.pin-output', 'artifacts')).find((entry) => /aamp-feishu-task-agent-.*\.tgz$/.test(entry))
  assert.ok(tgzFile)
  const tgzPayload = JSON.parse(fs.readFileSync(path.join(repo, '.pin-output', 'artifacts', tgzFile), 'utf8'))
  assert.equal(tgzPayload.name, '@public-owner/aamp-feishu-task-agent')
  assert.equal(tgzPayload.bootstrap, sourceBootstrap)
  assert.equal(tgzPayload.controller, sourceController)
})

test('a second --prepare-source fails before writes when an actual release version differs from HEAD', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t)
  const args = ['--mode', 'trial', '--prepare-source', '--scope', '@release-test', '--package', 'acpBridge']
  const first = runRelease(repo, fakeNpm, env, args)
  assert.equal(first.status, 0, first.stderr)
  const firstDiff = execFileSync('git', ['diff', '--binary'], { cwd: repo })

  const second = runRelease(repo, fakeNpm, env, args)

  assert.equal(second.status, 1)
  assert.match(second.stderr, /already prepared.*commit/i)
  assert.deepEqual(execFileSync('git', ['diff', '--binary'], { cwd: repo }), firstDiff)
  assert.equal(readJson(path.join(repo, 'packages/aamp-acp-bridge/package.json')).version, '1.2.4-dev.0')
  assert.equal(readJson(path.join(repo, 'packages/aamp-feishu-task-agent/package.json')).version, '2.4.7-dev.0')
})

test('failed strict pin validation rolls back every prepare-source file byte-for-byte', (t) => {
  const repo = createReleaseRepo(t)
  const { fakeNpm, env } = createStatefulFakeNpm(t)
  const taskDir = path.join(repo, 'packages/aamp-feishu-task-agent')
  const bootstrapFile = path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh')
  fs.writeFileSync(
    bootstrapFile,
    fs.readFileSync(bootstrapFile, 'utf8').replace(
      /aime_fallback\(\).*\n/,
      "aime_fallback() { printf '%s\\n' \"missing canonical AIME fallback\"; }\n",
    ),
  )
  const files = [
    'packages/aime-acp/package.json',
    'packages/aime-acp/package-lock.json',
    'packages/aamp-acp-bridge/package.json',
    'packages/aamp-acp-bridge/package-lock.json',
    'packages/aamp-feishu-task-agent/package.json',
    'packages/aamp-feishu-task-agent/package-lock.json',
    'packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh',
    'packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs',
    'packages/aamp-feishu-task-agent/README.md',
  ].map((file) => path.join(repo, file))
  const before = snapshotFiles(files)

  const result = runRelease(repo, fakeNpm, env, [
    '--mode', 'trial',
    '--prepare-source',
    '--scope', '@release-test',
    '--package', 'aimeAcp',
    '--package', 'acpBridge',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /AIME ACP prepared source pin validation failed.*expected 2/i)
  assertFilesMatchSnapshot(before)
})

test('release wizard omits agent prompts and flags from local and remote one-click commands', (t) => {
  const repo = createReleaseRepo(t, {
    aimeAcp: '0.1.1-dev.0',
    acpBridge: '1.2.4-dev.0',
    feishuBridge: '3.4.6-dev.0',
    taskAgent: '2.4.7-dev.0',
  })
  const fakeNpm = createFakeNpm(t)

  for (const choice of ['1', '2']) {
    const result = spawnSync(
      process.execPath,
      [helperPath, '--wizard', '--pm', fakeNpm, '--agent', 'cursor'],
      { cwd: repo, encoding: 'utf8', input: `${choice}\nall\n` },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /启动命令使用哪个 agent/)
    if (choice === '2') assert.match(result.stdout, /bash -s -- install(?:\n|$)/)
    assert.doesNotMatch(result.stdout, /tar -xZO package\/bootstrap\/aamp-feishu-task-agent-bootstrap\.sh/)
    if (choice === '2') assert.match(result.stdout, /tar -xOzf - package\/bootstrap\/aamp-feishu-task-agent-bootstrap\.sh/)
    assert.doesNotMatch(result.stdout, /--agent(?:\s|$)/)
  }
})

test('official stable wizard emits only the source preparation phase', (t) => {
  const repo = createReleaseRepo(t, {
    aimeAcp: '0.1.1-dev.0',
    acpBridge: '1.2.4-dev.0',
    feishuBridge: '3.4.6-dev.0',
    taskAgent: '2.4.7-dev.0',
  })
  const fakeNpm = createFakeNpm(t, { publicWhoami: 'larktask', bnpmWhoami: 'bnpm-owner' })
  const input = [
    '3',
    'patch',
    'all',
    '',
  ].join('\n')

  const result = spawnSync(
    process.execPath,
    [helperPath, '--wizard', '--pm', fakeNpm],
    { cwd: repo, encoding: 'utf8', input },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /prepare-source command:/)
  assert.match(result.stdout, /--prepare-source/)
  assert.match(result.stdout, /--bump patch/)
  assert.doesNotMatch(result.stdout, /--publish/)
  assert.doesNotMatch(result.stdout, /--confirm-publish/)
  assert.match(result.stdout, /review.*commit.*publish/is)
})
