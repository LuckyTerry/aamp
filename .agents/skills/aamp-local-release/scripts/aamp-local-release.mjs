#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireReleaseLock } from '../../shared/release-lock.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(scriptDir, '..', '..', '..', '..')
const DEFAULT_OUT_DIR = '.aamp-local-release'
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/'
const TASK_AGENT_BOOTSTRAP_PATH = path.join(
  REPO_ROOT,
  'packages',
  'aamp-feishu-task-agent',
  'bootstrap',
  'aamp-feishu-task-agent-bootstrap.sh',
)
const TASK_AGENT_CONTROLLER_PATH = path.join(
  REPO_ROOT,
  'packages',
  'aamp-feishu-task-agent',
  'bin',
  'feishu-task-agent-controller.mjs',
)
let localReleaseCacheDir
const LOCAL_CACHE_PREFIX = 'aamp-local-release-npm-cache-'

function tempCacheDir() {
  if (!localReleaseCacheDir) {
    localReleaseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), LOCAL_CACHE_PREFIX))
  }
  return localReleaseCacheDir
}

function cleanupTempCacheDir() {
  if (!localReleaseCacheDir) return
  const cacheDir = localReleaseCacheDir
  localReleaseCacheDir = undefined
  if (path.dirname(cacheDir) !== path.resolve(os.tmpdir()) || !path.basename(cacheDir).startsWith(LOCAL_CACHE_PREFIX)) {
    return
  }
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

process.once('exit', cleanupTempCacheDir)

const PACKAGE_SPECS = [
  {
    key: 'aimeAcp',
    dir: 'packages/aime-acp',
    unscopedName: 'aime-acp',
    build: true,
    bin: 'aime-acp',
    envName: 'AIME_ACP_PKG',
    tgzOnly: true,
  },
  {
    key: 'acpBridge',
    dir: 'packages/aamp-acp-bridge',
    unscopedName: 'aamp-acp-bridge',
    build: true,
    bin: 'aamp-acp-bridge',
    envName: 'ACP_BRIDGE_PKG',
  },
  {
    key: 'feishuBridge',
    dir: 'packages/aamp-feishu-bridge',
    unscopedName: 'aamp-feishu-bridge',
    build: true,
    bin: 'aamp-feishu-bridge',
    envName: 'FEISHU_BRIDGE_PKG',
  },
  {
    key: 'taskAgent',
    dir: 'packages/aamp-feishu-task-agent',
    unscopedName: 'aamp-feishu-task-agent',
    build: false,
    bin: 'feishu-task-agent',
    envName: '',
    tgzOnly: true,
  },
]

const PACKAGE_KEY_ALIASES = new Map([
  ['all', 'all'],
  ['aime', 'aimeAcp'],
  ['aimeacp', 'aimeAcp'],
  ['aime-acp', 'aimeAcp'],
  ['acp', 'acpBridge'],
  ['acpbridge', 'acpBridge'],
  ['acp-bridge', 'acpBridge'],
  ['aamp-acp-bridge', 'acpBridge'],
  ['feishu', 'feishuBridge'],
  ['feishubridge', 'feishuBridge'],
  ['feishu-bridge', 'feishuBridge'],
  ['aamp-feishu-bridge', 'feishuBridge'],
  ['task', 'taskAgent'],
  ['taskagent', 'taskAgent'],
  ['task-agent', 'taskAgent'],
  ['feishu-task-agent', 'taskAgent'],
  ['aamp-feishu-task-agent', 'taskAgent'],
])

function normalizePackageSelection(value) {
  if (!value) return ''
  const compact = value.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9-]/g, '').toLowerCase()
  const key = PACKAGE_KEY_ALIASES.get(compact)
  if (!key) throw new Error(`Unknown package key: ${value}. Use aimeAcp, acpBridge, feishuBridge, taskAgent, or all.`)
  return key
}

function selectedPackageSpecs(keys) {
  return PACKAGE_SPECS.filter((spec) => keys.has(spec.key))
}

function allPackageKeys() {
  return PACKAGE_SPECS.map((spec) => spec.key)
}

function resolvePackageDependencies(keys) {
  if (keys.has('aimeAcp')) keys.add('taskAgent')
  return keys
}

function usage() {
  return `Usage:
  node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs [options]

Build AAMP packages locally, optionally pack tgz artifacts, and print the
startup command for testing the local build WITHOUT publishing.

Options:
  --package KEY          Package to build. Repeatable or comma-separated.
                         Keys: aimeAcp, acpBridge, feishuBridge, taskAgent, all.
                         aimeAcp automatically includes taskAgent. Default: all
  --build / --skip-build Build dist before printing. Default: build
  --pack                 Also create local tgz artifacts under --out-dir
  --out-dir DIR          tgz output directory. Default: .aamp-local-release (repo root)
  --mode file|tgz        Startup command flavor. file uses file:<dir> overrides
                         (recommended: npm symlinks the live dist folder); tgz
                         uses packed tgz paths and implies --pack. Default: file
  --verify               Sanity-check that npm exec resolves each bridge bin
                         (downloads public dependencies; slower). Default: off
  --plan-only            Print the plan without building or packing. A startup
                         command is printed only when no packed artifact is needed
  --json                 Print a JSON summary to stdout (no human sections)
  --help                 Show this help

Local testing only. This script never publishes and never touches the remote
npm registry with our packages; npm may still fetch public dependencies of the
selected packages when resolving them.
`
}

function parseArgs(argv) {
  const options = {
    packages: new Set(),
    build: true,
    pack: false,
    outDir: DEFAULT_OUT_DIR,
    mode: 'file',
    verify: false,
    planOnly: false,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--package' || arg === '--packages') {
      for (const value of next().split(',')) {
        if (value.trim()) options.packages.add(normalizePackageSelection(value.trim()))
      }
    } else if (arg === '--build') {
      options.build = true
    } else if (arg === '--skip-build') {
      options.build = false
    } else if (arg === '--pack') {
      options.pack = true
    } else if (arg === '--out-dir') {
      options.outDir = next()
    } else if (arg === '--mode') {
      options.mode = next()
    } else if (arg === '--verify') {
      options.verify = true
    } else if (arg === '--plan-only') {
      options.planOnly = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }

  if (options.mode !== 'file' && options.mode !== 'tgz') {
    throw new Error('--mode must be file or tgz')
  }
  if (options.mode === 'tgz') options.pack = true
  if (options.packages.size === 0 || options.packages.has('all')) {
    options.packages = new Set(allPackageKeys())
  }
  resolvePackageDependencies(options.packages)
  return options
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function packageInfo(spec) {
  const pkgPath = path.join(REPO_ROOT, spec.dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read package manifest at ${pkgPath}: ${error.message}`)
  }
  const name = String(manifest.name || spec.unscopedName)
  const version = String(manifest.version || '')
  const binValue = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[spec.bin]
  const binPath = typeof binValue === 'string' ? path.resolve(REPO_ROOT, spec.dir, binValue) : ''
  return { name, version, binPath }
}

function packFileName(info, digest = '') {
  const stem = `${info.name.replace(/^@/, '').replace('/', '-')}-${info.version}`
  return `${stem}${digest ? `-${digest}` : ''}.tgz`
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function npmEnv() {
  return { ...process.env, npm_config_cache: tempCacheDir() }
}

function runBuild(spec, info) {
  const pkgDir = path.join(REPO_ROOT, spec.dir)
  fs.mkdirSync(tempCacheDir(), { recursive: true })
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: pkgDir,
    env: npmEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-8).join('\n')
    throw new Error(`npm run build failed for ${spec.key} (${spec.dir}):\n${detail}`)
  }
}

function verifyBin(spec, info) {
  if (!info.binPath || !fs.existsSync(info.binPath)) {
    throw new Error(
      `${spec.key} (${spec.dir}) binary target missing: ${info.binPath || '(no bin entry)'}. `
      + 'Build the package first or pass --skip-build only after a successful build.',
    )
  }
  if (process.platform !== 'win32' && (fs.statSync(info.binPath).mode & 0o111) === 0) {
    throw new Error(
      `${spec.key} (${spec.dir}) binary target is not executable: ${info.binPath}. `
      + 'Run "npm run prepare-bin" or rebuild the package.',
    )
  }
  return info.binPath
}

function runPack(spec, info, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(tempCacheDir(), { recursive: true })
  const pkgDir = path.join(REPO_ROOT, spec.dir)
  const stagingDir = fs.mkdtempSync(path.join(outDir, '.aamp-local-pack-'))
  try {
    const result = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', stagingDir], {
      cwd: pkgDir,
      env: npmEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-8).join('\n')
      throw new Error(`npm pack failed for ${spec.key} (${spec.dir}):\n${detail}`)
    }
    const printedName = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.tgz'))
      .at(-1)
    const generatedTgzs = fs.readdirSync(stagingDir).filter((name) => name.endsWith('.tgz'))
    if (generatedTgzs.length !== 1) {
      throw new Error(`npm pack must produce exactly one tgz for ${spec.key}; found ${generatedTgzs.length}`)
    }
    const stagedTgz = path.join(stagingDir, generatedTgzs[0])
    if (printedName && path.basename(printedName) !== generatedTgzs[0]) {
      throw new Error(`npm pack reported ${path.basename(printedName)} but produced ${generatedTgzs[0]}`)
    }

    const digest = sha256(stagedTgz)
    const tgzPath = path.join(outDir, packFileName(info, digest))
    try {
      fs.copyFileSync(stagedTgz, tgzPath, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existingStat = fs.lstatSync(tgzPath)
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw new Error(`Content-addressed artifact collision at ${tgzPath}: expected a regular non-symlink file`)
      }
      if (sha256(tgzPath) !== digest) {
        throw new Error(`Content-addressed artifact collision at ${tgzPath}`)
      }
    }
    return tgzPath
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}

function verifyResolvable(spec, pkgSpec) {
  fs.mkdirSync(tempCacheDir(), { recursive: true })
  const result = spawnSync(
    'npm',
    ['exec', '--yes', '--cache', tempCacheDir(), '--package', pkgSpec, '--', spec.bin, '--help'],
    { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  )
  return result.status === 0
}

function readSourceFile(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`)
  }
}

function extractRequiredMatch(source, pattern, label, filePath) {
  const match = pattern.exec(source)
  const value = match?.[1]?.trim()
  if (!value) {
    throw new Error(`Cannot parse ${label} from ${filePath}`)
  }
  return value
}

function parsePinnedPackageSpec(spec, label) {
  const value = String(spec || '').trim()
  if (!value) throw new Error(`${label} is missing`)
  if (/^(?:file:|https?:\/\/|-)/.test(value) || value.endsWith('.tgz')) {
    throw new Error(`${label} must be an npm package pin like @scope/name@version, found ${value}`)
  }
  const match = /^(?:@[^/\s]+\/)?[^@\s]+@[^@\s][^\s]*$/.exec(value)
  if (!match) {
    throw new Error(`${label} must be an npm package pin like @scope/name@version, found ${value}`)
  }
  const splitAt = value.lastIndexOf('@')
  return {
    packageSpec: value,
    version: value.slice(splitAt + 1),
  }
}

function normalizeRegistryUrl(value, label) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error(`${label} must be an absolute registry URL, found ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https, found ${value}`)
  }
  return url.toString()
}

function ensureSameTaskAgentPin(kind, bootstrapValue, controllerValue) {
  if (bootstrapValue.packageSpec !== controllerValue.packageSpec) {
    throw new Error(
      `Task Agent default ${kind} pin mismatch between bootstrap and controller: `
      + `${bootstrapValue.packageSpec} vs ${controllerValue.packageSpec}`,
    )
  }
  return bootstrapValue
}

function taskAgentDefaultPins() {
  const bootstrapSource = readSourceFile(TASK_AGENT_BOOTSTRAP_PATH, 'Task Agent bootstrap')
  const controllerSource = readSourceFile(TASK_AGENT_CONTROLLER_PATH, 'Task Agent controller')

  const bootstrapAcp = parsePinnedPackageSpec(
    extractRequiredMatch(
      bootstrapSource,
      /\bACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-([^"\r\n]+)\}"/,
      'Task Agent ACP bridge default pin',
      TASK_AGENT_BOOTSTRAP_PATH,
    ),
    'Task Agent ACP bridge default pin',
  )
  const controllerAcp = parsePinnedPackageSpec(
    extractRequiredMatch(
      controllerSource,
      /\bconst ACP_PACKAGE = process\.env\.AAMP_TASK_ACP_BRIDGE_PKG \|\| ['"]([^'"\r\n]+)['"];/,
      'Task Agent ACP bridge controller pin',
      TASK_AGENT_CONTROLLER_PATH,
    ),
    'Task Agent ACP bridge controller pin',
  )
  const bootstrapFeishu = parsePinnedPackageSpec(
    extractRequiredMatch(
      bootstrapSource,
      /\bFEISHU_BRIDGE_PKG="\$\{FEISHU_BRIDGE_PKG:-([^"\r\n]+)\}"/,
      'Task Agent Feishu bridge default pin',
      TASK_AGENT_BOOTSTRAP_PATH,
    ),
    'Task Agent Feishu bridge default pin',
  )
  const controllerFeishu = parsePinnedPackageSpec(
    extractRequiredMatch(
      controllerSource,
      /\bconst FEISHU_PACKAGE = process\.env\.AAMP_TASK_FEISHU_BRIDGE_PKG \|\| ['"]([^'"\r\n]+)['"];/,
      'Task Agent Feishu bridge controller pin',
      TASK_AGENT_CONTROLLER_PATH,
    ),
    'Task Agent Feishu bridge controller pin',
  )
  const aimePackage = parsePinnedPackageSpec(
    extractRequiredMatch(
      bootstrapSource,
      /\bAIME_ACP_PKG="\$\{AIME_ACP_PKG:-([^"\r\n]+)\}"/,
      'Task Agent AIME ACP default pin',
      TASK_AGENT_BOOTSTRAP_PATH,
    ),
    'Task Agent AIME ACP default pin',
  )
  const aimeRegistryDefault = normalizeRegistryUrl(
    extractRequiredMatch(
      bootstrapSource,
      /\bAIME_ACP_REGISTRY="\$\{AIME_ACP_REGISTRY:-([^"\r\n]+)\}"/,
      'Task Agent AIME ACP registry default',
      TASK_AGENT_BOOTSTRAP_PATH,
    ),
    'Task Agent AIME ACP registry default',
  )
  const aimeRegistryFunction = normalizeRegistryUrl(
    extractRequiredMatch(
      bootstrapSource,
      /aime_acp_registry\(\)\s*\{[\s\S]*?printf '%s\\n' '([^'\r\n]+)'/m,
      'Task Agent AIME ACP registry function',
      TASK_AGENT_BOOTSTRAP_PATH,
    ),
    'Task Agent AIME ACP registry function',
  )
  if (aimeRegistryDefault !== aimeRegistryFunction) {
    throw new Error(
      `Task Agent default AIME registry mismatch in bootstrap: ${aimeRegistryDefault} vs ${aimeRegistryFunction}`,
    )
  }

  return {
    acpBridge: {
      key: 'acpBridge',
      label: 'ACP bridge',
      overrideFlag: '--package acpBridge',
      registry: PUBLIC_NPM_REGISTRY,
      ...ensureSameTaskAgentPin('ACP bridge', bootstrapAcp, controllerAcp),
    },
    feishuBridge: {
      key: 'feishuBridge',
      label: 'Feishu bridge',
      overrideFlag: '--package feishuBridge',
      registry: PUBLIC_NPM_REGISTRY,
      ...ensureSameTaskAgentPin('Feishu bridge', bootstrapFeishu, controllerFeishu),
    },
    aimeAcp: {
      key: 'aimeAcp',
      label: 'AIME ACP',
      overrideFlag: '--package aimeAcp',
      registry: aimeRegistryDefault,
      ...aimePackage,
    },
  }
}

function checkRemotePinnedPackage(pin) {
  fs.mkdirSync(tempCacheDir(), { recursive: true })
  const result = spawnSync(
    'npm',
    ['view', pin.packageSpec, 'version', '--json', '--registry', pin.registry, '--cache', tempCacheDir()],
    { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  )
  if (result.status !== 0) {
    throw new Error(
      `Task Agent default ${pin.label} pin ${pin.packageSpec} is unresolved on ${pin.registry}. `
      + `Add ${pin.overrideFlag} to use your local override.`,
    )
  }
  let resolvedVersion
  try {
    resolvedVersion = JSON.parse(String(result.stdout || '').trim())
  } catch {
    throw new Error(
      `Task Agent default ${pin.label} pin ${pin.packageSpec} returned malformed npm view output. `
      + `Add ${pin.overrideFlag} to use your local override.`,
    )
  }
  if (resolvedVersion !== pin.version) {
    throw new Error(
      `Task Agent default ${pin.label} pin ${pin.packageSpec} resolved unexpected version ${JSON.stringify(resolvedVersion)} `
      + `from ${pin.registry}. Add ${pin.overrideFlag} to use your local override.`,
    )
  }
}

function preflightTaskAgentDefaultPins(selectedKeys, options) {
  const withTaskAgent = selectedKeys.has('taskAgent')
  if (!withTaskAgent) {
    return { skipped: false, checked: [] }
  }
  if (options.planOnly) {
    return { skipped: true, checked: [] }
  }
  const defaults = taskAgentDefaultPins()
  const checked = []
  for (const key of ['acpBridge', 'feishuBridge', 'aimeAcp']) {
    if (selectedKeys.has(key)) continue
    checkRemotePinnedPackage(defaults[key])
    checked.push(key)
  }
  return { skipped: false, checked }
}

function needsPackedArtifact(spec, options) {
  return spec.tgzOnly === true || options.mode === 'tgz' || options.pack
}

function startupNeedsPackedArtifact(selectedSpecs, options) {
  return options.mode === 'tgz' || selectedSpecs.some((spec) => spec.tgzOnly === true)
}

function buildStartupCommand(selectedSpecs, options, state) {
  if (!state.startupCommandRunnable) {
    return [
      '# Startup command unavailable in --plan-only: packed artifacts are content-addressed.',
      '# Run without --plan-only to build/pack them and print a runnable command.',
    ].join('\n')
  }

  const lines = [
    'set -e',
    `cd ${shellQuote(REPO_ROOT)}`,
    'unset ACP_BRIDGE_PKG AAMP_TASK_ACP_BRIDGE_PKG FEISHU_BRIDGE_PKG AAMP_TASK_FEISHU_BRIDGE_PKG',
    'unset AIME_ACP_PKG AAMP_TASK_AIME_ACP_PKG AIME_ACP_REGISTRY AAMP_TASK_AIME_ACP_REGISTRY',
    'unset AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG AAMP_TASK_REQUESTED_AIME_ACP_PKG',
    'unset AAMP_TASK_ALLOW_PACKAGE_OVERRIDES NPM_CONFIG_CACHE npm_config_cache',
    'unset NPM_REGISTRY NPM_CONFIG_REGISTRY npm_config_registry NPM_GLOBAL_PREFIX AAMP_BIN_DIR',
    'unset AAMP_TASK_AGENT_NAME AAMP_TASK_AGENT_LEGACY_NAME AAMP_TASK_AGENT_CHANNEL',
    'unset AAMP_TASK_COMMAND_NAME AAMP_TASK_COMMAND_PATH AAMP_TASK_SHIM_DIR AAMP_TASK_ENTRY',
    'unset AAMP_TASK_INTERNAL AAMP_TASK_INTERNAL_RESULT_FD AAMP_TASK_INTERNAL_INPUT_FD AAMP_TASK_INTERNAL_EXECUTION_LOCATION',
    'unset AAMP_TASK_PACKAGE_OVERRIDES_RESOLVED AAMP_TASK_NPM_REGISTRY AAMP_TASK_NPM_GLOBAL_PREFIX',
    'unset AAMP_TASK_NPM_CACHE_DIR AAMP_TASK_NPM_BIN AAMP_TASK_NPX_BIN AAMP_TASK_INSTALL_COMMAND',
    '_aamp_local_runtime_cache="$(mktemp -d "${TMPDIR:-/tmp}/aamp-local-runtime-npm-cache.XXXXXX")"',
    `trap 'rm -rf -- "$_aamp_local_runtime_cache"' EXIT`,
    'export NPM_CONFIG_CACHE="$_aamp_local_runtime_cache"',
    'export AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
  ]
  for (const spec of selectedSpecs) {
    if (!spec.envName) continue
    if (spec.tgzOnly || options.mode === 'tgz') {
      const tgzPath = state.tgzPaths[spec.key]
      if (!tgzPath) throw new Error(`Packed artifact is unavailable for ${spec.key}`)
      lines.push(`export ${spec.envName}=${shellQuote(tgzPath)}`)
    } else {
      lines.push(`export ${spec.envName}="file:$PWD/${spec.dir}"`)
    }
  }

  const withTaskAgent = selectedSpecs.some((spec) => spec.key === 'taskAgent')
  if (withTaskAgent) {
    const taskAgentTgz = state.tgzPaths.taskAgent
    if (!taskAgentTgz) throw new Error('Packed artifact is unavailable for taskAgent')
    const taskAgentInfo = packageInfo(PACKAGE_SPECS.find((spec) => spec.key === 'taskAgent'))
    lines.push(`export AAMP_TASK_AGENT_NAME=${shellQuote(taskAgentInfo.name)}`)
    lines.push('export AAMP_TASK_AUTO_UPDATE=false')
    lines.push(`npm install -g --prefix "$HOME/.aamp/npm-global" --force ${shellQuote(taskAgentTgz)}`)
    lines.push('"$HOME/.aamp/npm-global/bin/feishu-task-agent" start')
  } else {
    lines.push('if command -v feishu-task-agent >/dev/null 2>&1; then')
    lines.push('  feishu-task-agent start')
    lines.push('else')
    lines.push('  "$HOME/.aamp/bin/feishu-task-agent" start')
    lines.push('fi')
  }
  return ['(', ...lines.map((line) => `  ${line}`), ')'].join('\n')
}

function buildNotes(selectedSpecs, options, state) {
  const notes = []
  notes.push('Stop the currently running task-agent first (Ctrl+C in its terminal), then run the startup command.')
  if (options.mode === 'file') {
    notes.push('file:<dir> overrides make npm symlink the live package folder; after editing source, rebuild with npm run build and restart. No repack needed.')
  } else {
    notes.push('tgz mode uses packed artifacts; after editing source, rebuild and re-run with --pack, then restart.')
  }
  notes.push('npm may fetch public dependencies of the selected packages from the registry when resolving them; this skill never publishes our packages.')
  notes.push('Verify locally: send the agent a task that exercises the changed path and confirm the Feishu comment shows the real text.')
  const withTaskAgent = selectedSpecs.some((spec) => spec.key === 'taskAgent')
  if (withTaskAgent) {
    notes.push('The startup command installs the packed local task-agent, disables auto-update, and starts that exact npm-global launcher directly; normal startup synchronizes ~/.aamp/bin before opening the interactive selector.')
  }
  if (selectedSpecs.some((spec) => spec.key === 'aimeAcp')) {
    notes.push('AIME ACP local overrides are always packed tgz snapshots, including in file mode.')
  }
  if (state.taskAgentDefaultPreflight?.skipped) {
    notes.push('Task Agent default-pin preflight is skipped in --plan-only; this output is unchecked and not runnable.')
  }
  if (!state.startupCommandRunnable) {
    notes.push('This plan needs packed content-addressed artifacts; re-run without --plan-only before starting.')
  }
  return notes
}

function run(options) {
  const selectedSpecs = selectedPackageSpecs(options.packages)
  const taskAgentDefaultPreflight = preflightTaskAgentDefaultPins(options.packages, options)
  const state = {
    packages: [],
    tgzPaths: {},
    verified: {},
    startupCommand: '',
    notes: [],
    plan: options.planOnly,
    startupCommandRunnable: !(options.planOnly && startupNeedsPackedArtifact(selectedSpecs, options)),
    taskAgentDefaultPreflight,
  }

  for (const spec of selectedSpecs) {
    const info = packageInfo(spec)
    const entry = {
      key: spec.key,
      dir: spec.dir,
      version: info.version,
      bin: info.binPath,
      binExists: Boolean(info.binPath) && fs.existsSync(info.binPath),
    }
    if (!options.planOnly) {
      if (options.build && spec.build) {
        runBuild(spec, info)
        entry.built = true
      }
      verifyBin(spec, info)
      if (needsPackedArtifact(spec, options)) {
        const tgzPath = runPack(spec, info, path.resolve(REPO_ROOT, options.outDir))
        entry.tgz = tgzPath
        state.tgzPaths[spec.key] = tgzPath
      }
      if (options.verify && spec.envName) {
        const pkgSpec = spec.tgzOnly || options.mode === 'tgz'
          ? state.tgzPaths[spec.key]
          : `file:${path.join(REPO_ROOT, spec.dir)}`
        state.verified[spec.key] = verifyResolvable(spec, pkgSpec)
        entry.verified = state.verified[spec.key]
      }
    }
    state.packages.push(entry)
  }

  state.startupCommand = buildStartupCommand(selectedSpecs, options, state)
  state.notes = buildNotes(selectedSpecs, options, state)
  return state
}

function printHuman(options, state) {
  console.log('aamp-local-release plan:')
  console.log(`- repo root: ${REPO_ROOT}`)
  console.log(`- mode: ${options.mode}${options.planOnly ? ' (plan only)' : ''}${options.pack ? ' (pack)' : ''}${options.verify ? ' (verify)' : ''}`)
  console.log('- packages:')
  for (const entry of state.packages) {
    const built = entry.built === true ? 'built' : (entry.binExists ? 'bin ok' : 'bin MISSING')
    const tgz = entry.tgz ? ` tgz=${entry.tgz}` : ''
    const verified = entry.verified === true ? ' verify=ok' : entry.verified === false ? ' verify=FAILED' : ''
    console.log(`  - ${entry.key}@${entry.version} (${entry.dir}) ${built}${tgz}${verified}`)
  }
  console.log()
  console.log('startup command for local testing:')
  console.log(state.startupCommand)
  console.log()
  console.log('notes:')
  for (const note of state.notes) console.log(`- ${note}`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n`)
    process.stderr.write(usage())
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(usage())
    process.exit(0)
  }
  let releaseLock
  try {
    const selectedSpecs = selectedPackageSpecs(options.packages)
    const mutatesReleaseState = !options.planOnly && (
      options.build
      || options.pack
      || options.verify
      || selectedSpecs.some((spec) => spec.tgzOnly === true)
    )
    if (mutatesReleaseState) {
      releaseLock = acquireReleaseLock({
        repoRoot: REPO_ROOT,
        helper: 'aamp-local-release',
        operation: 'build-pack-verify',
      })
    }
    const state = run(options)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...state, repoRoot: REPO_ROOT }, null, 2)}\n`)
    } else {
      printHuman(options, state)
    }
    const failedVerifications = Object.values(state.verified).filter((value) => value === false)
    process.exitCode = failedVerifications.length ? 1 : 0
  } catch (error) {
    process.stderr.write(`aamp-local-release failed: ${error.message}\n`)
    process.exitCode = 1
  } finally {
    cleanupTempCacheDir()
    releaseLock?.release()
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main()
}

export { verifyBin }
