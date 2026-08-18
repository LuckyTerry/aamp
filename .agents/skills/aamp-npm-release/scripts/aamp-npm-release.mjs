#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process, { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireReleaseLock } from '../../shared/release-lock.mjs'

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org'
const AIME_BNPM_REGISTRY = 'https://bnpm.byted.org'

const PACKAGE_SPECS = [
  {
    key: 'aimeAcp',
    dir: 'packages/aime-acp',
    unscopedName: 'aime-acp',
    build: true,
    registryOption: 'aimeRegistry',
  },
  {
    key: 'acpBridge',
    dir: 'packages/aamp-acp-bridge',
    unscopedName: 'aamp-acp-bridge',
    build: true,
  },
  {
    key: 'feishuBridge',
    dir: 'packages/aamp-feishu-bridge',
    unscopedName: 'aamp-feishu-bridge',
    build: true,
  },
  {
    key: 'taskAgent',
    dir: 'packages/aamp-feishu-task-agent',
    unscopedName: 'aamp-feishu-task-agent',
    build: false,
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

const AGENT_TYPES = ['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy']

function normalizePackageSelection(value) {
  if (!value) return ''
  const compact = value.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9-]/g, '').toLowerCase()
  const key = PACKAGE_KEY_ALIASES.get(compact)
  if (!key) throw new Error(`Unknown package key: ${value}. Use aimeAcp, acpBridge, feishuBridge, taskAgent, or all.`)
  return key
}

function allPackageKeys() {
  return PACKAGE_SPECS.map((spec) => spec.key)
}

function resolveSelectedPackageKeys(options) {
  const selected = new Set(options.packages.size === 0 || options.packages.has('all') ? allPackageKeys() : options.packages)
  for (const key of options.versions.keys()) selected.add(key)
  if (selected.has('acpBridge') || selected.has('feishuBridge')) {
    selected.add('taskAgent')
  }
  if (selected.has('aimeAcp')) {
    selected.add('taskAgent')
  }
  return selected
}

function selectedPackageSpecs(selectedKeys) {
  return PACKAGE_SPECS.filter((spec) => selectedKeys.has(spec.key))
}

function describePackageKeys(selectedKeys) {
  return selectedPackageSpecs(selectedKeys).map((spec) => spec.key).join(', ')
}

function usage() {
  return `Usage:
  node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs [options]

Options:
  --wizard                  Manual/debug planning helper; agents should prefer non-interactive flags
  --mode trial|final        Release mode. Default: trial
  --scope @name             Assertion only. Trial must equal @<public npm whoami>; final must equal @larktask
  --registry URL            Public AAMP registry, fixed to https://registry.npmjs.org/
  --tag NAME                Trial is fixed to dev; final is fixed to latest
  --pack                    Build staged packages and create tgz artifacts. Default unless --plan-only is used
  --plan-only               Only inspect identity and compute versions
  --prepare-source          Advance and write source versions/pins, print the plan, then exit without build/pack/publish
  --bump patch|minor|major  Stable-to-trial bump used by --prepare-source. Default: patch
  --package KEY             Package to release. Repeatable or comma-separated. Keys: aimeAcp, acpBridge, feishuBridge, taskAgent, all.
                            Selecting a bridge automatically includes taskAgent so startup pins are updated
                            Required for --pack/--publish; optional for --plan-only
  --publish                 Publish staged packages with the selected package manager
  --confirm-publish         Required with --publish
  --resume-publish          Verify already-published selected versions and publish only missing ones
  --verify-published        Verify already-published selected source versions against local packed tgz artifacts
  --allow-dirty             Allow publishing when tracked files are dirty
  --skip-build              Do not run package build scripts before staging
  --out-dir DIR             Output directory. Default: .aamp-npm-release
  --pm PATH                 npm-compatible package manager. Publish defaults to npm; local work prefers pnpm, then npm
  --pnpm PATH               Backward-compatible alias for --pm
  --otp CODE                Unsupported. Public npm publish uses browser auth; BNPM uses existing internal auth
  --agent NAME              Deprecated compatibility option; printed startup commands omit --agent
  --version key=version     Exact source version for --prepare-source only. Use only to align an explicit release line
  --aime-scope @name        Assertion only. Must equal @<BNPM whoami> when used
  --aime-registry URL       AIME registry, fixed to https://bnpm.byted.org
  --help                    Show this help
`
}

function validateAgentType(agent) {
  if (!AGENT_TYPES.includes(agent)) {
    throw new Error(`--agent must be one of: ${AGENT_TYPES.join(', ')}`)
  }
  return agent
}

function parseArgs(argv) {
  const options = {
    mode: 'trial',
    scope: '',
    registry: 'https://registry.npmjs.org/',
    aimeRegistry: AIME_BNPM_REGISTRY,
    tag: '',
    aimeScope: '',
    bumpExplicit: false,
    pack: true,
    planOnly: false,
    prepareSource: false,
    bump: 'patch',
    publish: false,
    resumePublish: false,
    verifyPublished: false,
    confirmPublish: false,
    allowDirty: false,
    skipBuild: false,
    outDir: '.aamp-npm-release',
    packageManager: '',
    agent: 'coco',
    wizard: false,
    versions: new Map(),
    packages: new Set(),
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
    } else if (arg === '--wizard' || arg === '--interactive') {
      options.wizard = true
    } else if (arg === '--mode') {
      options.mode = next()
    } else if (arg === '--scope') {
      options.scope = next()
    } else if (arg === '--registry') {
      options.registry = next()
    } else if (arg === '--aime-registry') {
      options.aimeRegistry = next()
    } else if (arg === '--aime-scope') {
      options.aimeScope = next()
    } else if (arg === '--tag') {
      options.tag = next()
    } else if (arg === '--pack') {
      options.pack = true
    } else if (arg === '--plan-only') {
      options.planOnly = true
      options.pack = false
    } else if (arg === '--prepare-source') {
      options.prepareSource = true
      options.pack = false
    } else if (arg === '--bump') {
      options.bump = next()
      options.bumpExplicit = true
    } else if (arg === '--package' || arg === '--packages') {
      for (const value of next().split(',')) {
        const key = normalizePackageSelection(value.trim())
        if (key) options.packages.add(key)
      }
    } else if (arg === '--publish') {
      options.publish = true
      options.pack = true
    } else if (arg === '--confirm-publish') {
      options.confirmPublish = true
    } else if (arg === '--resume-publish') {
      options.resumePublish = true
      options.publish = true
      options.pack = true
    } else if (arg === '--verify-published') {
      options.verifyPublished = true
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true
    } else if (arg === '--skip-build') {
      options.skipBuild = true
    } else if (arg === '--out-dir') {
      options.outDir = next()
    } else if (arg === '--pm' || arg === '--package-manager') {
      options.packageManager = next()
    } else if (arg === '--pnpm') {
      options.packageManager = next()
    } else if (arg === '--otp') {
      next()
      throw new Error('--otp is not supported. Public npm publish uses browser authentication; BNPM uses existing internal authentication.')
    } else if (arg === '--agent') {
      options.agent = next()
    } else if (arg === '--version') {
      const raw = next()
      const eq = raw.indexOf('=')
      if (eq === -1) throw new Error('--version must be key=version')
      const key = normalizePackageSelection(raw.slice(0, eq))
      if (key === 'all') throw new Error('--version key must be aimeAcp, acpBridge, feishuBridge, or taskAgent')
      options.versions.set(key, raw.slice(eq + 1))
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!['trial', 'final'].includes(options.mode)) {
    throw new Error('--mode must be trial or final')
  }
  if (!['patch', 'minor', 'major'].includes(options.bump)) {
    throw new Error('--bump must be patch, minor, or major')
  }
  if (normalizeRegistry(options.aimeRegistry) !== AIME_BNPM_REGISTRY) {
    throw new Error('AIME registry is fixed to ' + AIME_BNPM_REGISTRY)
  }
  if (normalizeRegistry(options.registry) !== PUBLIC_NPM_REGISTRY) {
    throw new Error('The public AAMP registry is fixed to ' + PUBLIC_NPM_REGISTRY)
  }
  if (options.mode === 'trial' && options.tag && options.tag !== 'dev') {
    throw new Error('Trial dist-tag is fixed to dev')
  }
  if (options.mode === 'final' && options.tag && options.tag !== 'latest') {
    throw new Error('Final dist-tag is fixed to latest')
  }
  if (options.prepareSource && options.publish) {
    throw new Error('--prepare-source cannot be combined with --publish')
  }
  if (options.verifyPublished && options.publish) {
    throw new Error('--verify-published cannot be combined with --publish')
  }
  if (options.verifyPublished && (options.prepareSource || options.planOnly)) {
    throw new Error('--verify-published cannot be combined with --prepare-source or --plan-only')
  }
  if (options.prepareSource && options.planOnly) {
    throw new Error('--prepare-source cannot be combined with --plan-only')
  }
  if (options.publish && !options.confirmPublish) {
    throw new Error('--publish requires --confirm-publish')
  }
  validateAgentType(options.agent)
  if (options.packages.has('all') && options.packages.size > 1) {
    throw new Error('--package all cannot be combined with other --package values')
  }
  if (options.versions.size > 0 && !options.prepareSource) {
    throw new Error('--version is only supported with --prepare-source; pack and publish always reuse committed source versions.')
  }
  if (options.mode === 'final' && options.prepareSource && !options.bumpExplicit) {
    throw new Error('Final --prepare-source requires --bump patch, minor, or major')
  }
  return options
}

function assertExplicitPackageSelection(options) {
  if (options.planOnly || options.wizard || options.packages.size > 0) return
  throw new Error('Packing or publishing requires an explicit package selection. Pass --package aimeAcp, --package acpBridge, --package feishuBridge, --package taskAgent, or --package all.')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`)
  }
  return result.stdout || ''
}

function optionalRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  }
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  return result.status === 0
}

function resolvePackageManager(preferred) {
  const candidates = preferred ? [preferred] : ['pnpm', 'npm']
  for (const command of candidates) {
    if (commandExists(command)) {
      const name = path.basename(command)
      return { command, name: name.includes('pnpm') ? 'pnpm' : 'npm' }
    }
  }
  throw new Error(
    preferred
      ? `Package manager not found: ${preferred}`
      : 'No package manager found. Install pnpm or ensure npm is available in PATH.',
  )
}

function resolveAuthenticatedPackageManager(preferred, registry, preferNpm = false) {
  const candidates = preferred ? [preferred] : (preferNpm ? ['npm', 'pnpm'] : ['pnpm', 'npm'])
  const errors = []
  for (const candidate of candidates) {
    if (!commandExists(candidate)) {
      errors.push(`${candidate}: not found`)
      continue
    }
    const name = path.basename(candidate)
    const packageManager = { command: candidate, name: name.includes('pnpm') ? 'pnpm' : 'npm' }
    try {
      return { packageManager, whoami: npmWhoami(packageManager, registry) }
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`)
      if (preferred) break
    }
  }
  throw new Error(`No authenticated npm-compatible package manager found for ${registry}. Run npm login or pnpm login first.\n${errors.join('\n')}`)
}

function findRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    let current = path.dirname(fileURLToPath(import.meta.url))
    while (current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, 'packages/aamp-feishu-task-agent/package.json'))) {
        return current
      }
      current = path.dirname(current)
    }
    throw new Error('Could not locate repository root')
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeScope(scope) {
  if (!scope) return ''
  return scope.startsWith('@') ? scope : `@${scope}`
}

function normalizeRegistry(registry) {
  return String(registry).replace(/\/+$/, '')
}

function packageName(scope, unscopedName) {
  return `${normalizeScope(scope)}/${unscopedName}`
}

function targetPackageName(spec, scopes, sourceName) {
  if (spec.key === 'aimeAcp') {
    return scopes.aimeScope ? packageName(scopes.aimeScope, spec.unscopedName) : sourceName
  }
  return packageName(scopes.publicScope, spec.unscopedName)
}

function tarballUrl(registry, scopedPackageName, version) {
  const cleanRegistry = registry.endsWith('/') ? registry.slice(0, -1) : registry
  const unscoped = scopedPackageName.split('/').pop()
  return `${cleanRegistry}/${scopedPackageName}/-/${unscoped}-${version}.tgz`
}

function parseDevVersion(version) {
  const match = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/.exec(version)
  if (!match) return null
  return { base: match[1], number: Number(match[2]) }
}

function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function bumpStableVersion(version, bump = 'patch') {
  const parsed = parseStableVersion(version)
  if (!parsed) return null
  if (bump === 'major') return `${parsed.major + 1}.0.0`
  if (bump === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

function nextPreparedTrialVersion(sourceVersion, remoteVersions, bump) {
  void remoteVersions
  const sourceDev = parseDevVersion(sourceVersion)
  if (!sourceDev) {
    const nextStable = bumpStableVersion(sourceVersion, bump)
    if (!nextStable) {
      throw new Error(`Trial source version must be stable x.y.z or x.y.z-dev.N: ${sourceVersion}`)
    }
    return `${nextStable}-dev.0`
  }
  return `${sourceDev.base}-dev.${sourceDev.number + 1}`
}

function nextPreparedFinalVersion(sourceVersion, bump) {
  const sourceDev = parseDevVersion(sourceVersion)
  if (sourceDev) {
    if (bump === 'patch') return sourceDev.base
    return bumpStableVersion(sourceDev.base, bump)
  }
  const stable = bumpStableVersion(sourceVersion, bump)
  if (!stable) {
    throw new Error(`Final source version must be stable x.y.z or x.y.z-dev.N: ${sourceVersion}`)
  }
  return stable
}

function assertExplicitPreparedVersion(mode, key, version) {
  if (mode === 'trial' && !parseDevVersion(version)) {
    throw new Error(`Trial --version ${key} must be x.y.z-dev.N, got ${version}`)
  }
  if (mode === 'final' && !parseStableVersion(version)) {
    throw new Error(`Final --version ${key} must be stable x.y.z, got ${version}`)
  }
}

function decideVersion({ mode, sourceVersion, remoteVersions, override, prepareSource, verifyPublished, resumePublish, bump, key }) {
  if (prepareSource) {
    if (override) {
      assertExplicitPreparedVersion(mode, key, override)
      return override
    }
    if (mode === 'final') return nextPreparedFinalVersion(sourceVersion, bump)
    return nextPreparedTrialVersion(sourceVersion, remoteVersions, bump)
  }

  if (override) {
    throw new Error('--version is only supported with --prepare-source; pack and publish always reuse committed source versions.')
  }
  if (verifyPublished || resumePublish) {
    if (verifyPublished && !remoteVersions.includes(sourceVersion)) {
      throw new Error(`Cannot verify missing published version ${sourceVersion}`)
    }
    return sourceVersion
  }
  if (mode === 'trial' && !parseDevVersion(sourceVersion)) {
    throw new Error(`Trial release requires a prepared source version x.y.z-dev.N, got ${sourceVersion}. Run --prepare-source first.`)
  }
  if (mode === 'final' && !parseStableVersion(sourceVersion)) {
    throw new Error(`Final release requires a stable source version x.y.z, got ${sourceVersion}. Run --mode final --prepare-source with --bump first.`)
  }
  return sourceVersion
}

function npmWhoami(packageManager, registry) {
  const result = optionalRun(packageManager.command, ['whoami', '--registry', registry])
  if (!result.ok) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${packageManager.command} whoami is unauthorized for ${registry}. Run ${packageManager.command} login first.${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function remoteVersions(packageManager, registry, name) {
  const result = optionalRun(packageManager.command, ['view', name, 'versions', '--json', '--registry', registry])
  if (!result.ok) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    if (/\bE404\b|404 Not Found|is not in this registry|No match found/i.test(detail)) return []
    throw new Error(`Failed to inspect ${name} on ${registry}:${detail ? `\n${detail}` : ''}`)
  }
  const raw = result.stdout.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'string') return [parsed]
    throw new Error('expected a version string or array')
  } catch {
    throw new Error(`Failed to parse version metadata for ${name} on ${registry}`)
  }
}

function remotePackageMetadata(packageManager, registry, name, version) {
  const result = optionalRun(packageManager.command, [
    'view', `${name}@${version}`, '--json', '--registry', registry,
  ])
  if (!result.ok) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`Failed to inspect published artifact ${name}@${version} on ${registry}:${detail ? `\n${detail}` : ''}`)
  }
  try {
    const parsed = JSON.parse(result.stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid metadata')
    return parsed
  } catch {
    throw new Error(`Failed to parse published artifact metadata for ${name}@${version} on ${registry}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForRemoteArtifact(packageManager, registry, target, attempts = 6) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = remotePackageMetadata(packageManager, registry, target.name, target.version)
      if (metadata.version !== target.version) {
        throw new Error(`Published artifact version mismatch: expected ${target.version}, got ${metadata.version}`)
      }
      const dist = metadata.dist
      if (!dist || typeof dist !== 'object' || Array.isArray(dist)) {
        throw new Error(`Published artifact dist metadata is missing for ${target.name}@${target.version}`)
      }
      if (typeof dist.shasum !== 'string' || dist.shasum !== target.sha1) {
        throw new Error(`Published artifact shasum mismatch for ${target.name}@${target.version}`)
      }
      if (typeof dist.integrity !== 'string' || dist.integrity.length === 0) {
        throw new Error(`Published artifact integrity is missing for ${target.name}@${target.version}`)
      }
      if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
        throw new Error(`Published artifact tarball URL is missing for ${target.name}@${target.version}`)
      }
      target.remoteVerified = true
      target.remoteIntegrity = dist.integrity
      target.remoteTarball = dist.tarball
      return
    } catch (error) {
      lastError = error
      if (/shasum mismatch/.test(error.message)) throw error
      if (attempt === attempts) throw error
    }
    await sleep(2_000)
  }
  throw lastError ?? new Error(`Published artifact metadata was not visible for ${target.name}@${target.version}`)
}

function trackedDirty(repoRoot) {
  const status = run('git', ['status', '--short'], { cwd: repoRoot })
  const tracked = []
  for (const line of status.split('\n')) {
    if (!line.trim()) continue
    if (!line.startsWith('?? ')) tracked.push(line)
  }
  return tracked
}

function headJson(repoRoot, file) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/')
  const result = optionalRun('git', ['show', `HEAD:${relative}`], { cwd: repoRoot })
  if (!result.ok) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`Could not read ${relative} from HEAD${detail ? `:\n${detail}` : ''}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`Could not parse ${relative} from HEAD`)
  }
}

function assertReleaseVersionsMatchHead(repoRoot, releaseSpecs) {
  for (const spec of releaseSpecs) {
    const packageFile = path.join(repoRoot, spec.dir, 'package.json')
    const sourcePackage = readJson(packageFile)
    const headPackage = headJson(repoRoot, packageFile)
    if (sourcePackage.version !== headPackage.version) {
      throw new Error(
        `${spec.key} source version is already prepared (HEAD ${headPackage.version}, working tree ${sourcePackage.version}); commit or revert the prior preparation before running --prepare-source again`,
      )
    }
  }
}

function packageRegistry(spec, options) {
  return spec.registryOption ? options[spec.registryOption] : options.registry
}

function buildReleasePlan(repoRoot, packageManager, options, scopes, selectedKeys) {
  const sources = new Map()
  const targets = {}
  const resolveRemote = (key) => selectedKeys.has(key)
  for (const spec of PACKAGE_SPECS) {
    const sourceDir = path.join(repoRoot, spec.dir)
    const sourcePackage = readJson(path.join(sourceDir, 'package.json'))
    const registry = packageRegistry(spec, options)
    const targetName = targetPackageName(spec, scopes, sourcePackage.name)
    const versions = resolveRemote(spec.key) ? remoteVersions(packageManager, registry, targetName) : []
    const remoteLatest = versions.at(-1) || null
    const selected = selectedKeys.has(spec.key)
    const targetVersion = selected
      ? decideVersion({
        mode: options.mode,
        sourceVersion: sourcePackage.version,
        remoteVersions: versions,
        override: options.versions.get(spec.key),
        prepareSource: options.prepareSource,
        verifyPublished: options.verifyPublished,
        resumePublish: options.resumePublish,
        bump: options.bump,
        key: spec.key,
      })
      : remoteLatest
    if (resolveRemote(spec.key) && !selected && !targetVersion) {
      throw new Error(
        `${targetName} is needed for task-agent pins but has no published version in ${registry}. Include --package ${spec.key}.`,
      )
    }
    sources.set(spec.key, { ...spec, sourceDir, sourceName: sourcePackage.name, sourceVersion: sourcePackage.version, registry })
    targets[spec.key] = {
      name: targetName,
      version: targetVersion,
      selected,
      remoteLatest,
      remoteCount: versions.length,
      alreadyPublished: selected && versions.includes(targetVersion),
      resolved: resolveRemote(spec.key),
      registry,
    }
  }
  return {
    sources,
    targets,
    tag: options.tag || defaultTag(options.mode, targets),
  }
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function copyPackageForStaging(srcDir, destDir) {
  removeIfExists(destDir)
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source)
      if (base === 'node_modules') return false
      if (base.endsWith('.tgz')) return false
      return true
    },
  })
}

function patchPackageMetadata(pkgDir, name, version) {
  const packageJsonFile = path.join(pkgDir, 'package.json')
  const packageJson = readJson(packageJsonFile)
  packageJson.name = name
  packageJson.version = version
  writeJson(packageJsonFile, packageJson)

  const lockFile = path.join(pkgDir, 'package-lock.json')
  if (fs.existsSync(lockFile)) {
    const lock = readJson(lockFile)
    lock.name = name
    lock.version = version
    if (lock.packages && lock.packages['']) {
      lock.packages[''].name = name
      lock.packages[''].version = version
    }
    writeJson(lockFile, lock)
  }
}

function replaceInFile(file, replacements) {
  if (!fs.existsSync(file)) return
  let content = fs.readFileSync(file, 'utf8')
  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement)
  }
  fs.writeFileSync(file, content)
}

function preparedTaskAgentChannel(mode) {
  return mode === 'final' ? 'latest' : 'dev'
}

function patchPreparedSourceTaskAgentPins(taskDir, targets, taskAgentChannel) {
  const replacements = [
    [/^AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-[^}"]+}"$/m, `AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-${targets.taskAgent.name}}"`],
    [/^AAMP_TASK_AGENT_CHANNEL="\$\{AAMP_TASK_AGENT_CHANNEL:-[^}"]+}"$/m, `AAMP_TASK_AGENT_CHANNEL="\${AAMP_TASK_AGENT_CHANNEL:-${taskAgentChannel}}"`],
    [/^AAMP_TASK_AGENT_VERSION="[^"]*"$/m, `AAMP_TASK_AGENT_VERSION="${targets.taskAgent.version}"`],
    [/@[^/\s"']+\/aamp-feishu-task-agent@(dev|latest)/g, `${targets.taskAgent.name}@${taskAgentChannel}`],
  ]
  if (targets.acpBridge?.selected) {
    replacements.push([
      /@[^/\s"']+\/aamp-acp-bridge@[0-9A-Za-z.-]+/g,
      `${targets.acpBridge.name}@${targets.acpBridge.version}`,
    ])
  }
  if (targets.feishuBridge?.selected) {
    replacements.push([
      /@[^/\s"']+\/aamp-feishu-bridge@[0-9A-Za-z.-]+/g,
      `${targets.feishuBridge.name}@${targets.feishuBridge.version}`,
    ])
  }
  if (targets.aimeAcp?.selected) {
    replacements.push(
      [/@[^/\s"']+\/aime-acp@[0-9A-Za-z.-]+/g, `${targets.aimeAcp.name}@${targets.aimeAcp.version}`],
      [/^AIME_ACP_REGISTRY="\$\{AIME_ACP_REGISTRY:-[^"]+}"$/m, `AIME_ACP_REGISTRY="\${AIME_ACP_REGISTRY:-${targets.aimeAcp.registry}}"`],
    )
  }

  replaceInFile(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), replacements)
  replaceInFile(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), replacements)
  replaceInFile(path.join(taskDir, 'README.md'), replacements)
}

function preparedSourceFiles(sources, releaseSpecs, includesTaskAgent) {
  const files = []
  for (const spec of releaseSpecs) {
    const sourceDir = sources.get(spec.key).sourceDir
    files.push(path.join(sourceDir, 'package.json'), path.join(sourceDir, 'package-lock.json'))
  }
  if (includesTaskAgent) {
    const taskDir = sources.get('taskAgent').sourceDir
    files.push(
      path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'),
      path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'),
      path.join(taskDir, 'README.md'),
    )
  }
  return [...new Set(files)]
}

function snapshotSourceFiles(files) {
  return new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]))
}

function restoreSourceFiles(snapshot) {
  for (const [file, content] of snapshot) {
    if (content === null) {
      fs.rmSync(file, { force: true })
    } else {
      fs.writeFileSync(file, content)
    }
  }
}

function assertPackageMetadata(pkgDir, expectedName, expectedVersion) {
  const packageFile = path.join(pkgDir, 'package.json')
  const packageJson = readJson(packageFile)
  if (packageJson.name !== expectedName || packageJson.version !== expectedVersion) {
    throw new Error(`Package metadata validation failed: ${packageFile} expected ${expectedName}@${expectedVersion}`)
  }
  const lockFile = path.join(pkgDir, 'package-lock.json')
  if (!fs.existsSync(lockFile)) throw new Error(`Package lock validation failed: missing ${lockFile}`)
  const lock = readJson(lockFile)
  const root = lock.packages?.['']
  if (lock.name !== expectedName || lock.version !== expectedVersion || root?.name !== expectedName || root?.version !== expectedVersion) {
    throw new Error(`Package lock validation failed: ${lockFile} expected ${expectedName}@${expectedVersion}`)
  }
}

function exactMatches(content, pattern) {
  return content.match(pattern) || []
}

function readTaskAgentPinFiles(taskDir) {
  return {
    bootstrapFile: path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'),
    controllerFile: path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'),
    readmeFile: path.join(taskDir, 'README.md'),
    bootstrap: fs.readFileSync(path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8'),
    controller: fs.readFileSync(path.join(taskDir, 'bin/feishu-task-agent-controller.mjs'), 'utf8'),
    readme: fs.readFileSync(path.join(taskDir, 'README.md'), 'utf8'),
  }
}

function parsePinnedPackage(pin) {
  const at = pin.lastIndexOf('@')
  if (at <= 0) {
    throw new Error(`Invalid pinned package identity: ${pin}`)
  }
  return {
    name: pin.slice(0, at),
    version: pin.slice(at + 1),
  }
}

function assertTaskAgentNamePin(bootstrap, expectedName) {
  const match = /^AAMP_TASK_AGENT_NAME="\$\{AAMP_TASK_AGENT_NAME:-([^}"]+)\}"$/m.exec(bootstrap)
  if (!match) return
  if (match[1] !== expectedName) {
    throw new Error(`Task Agent name pin validation failed: expected ${expectedName}, got ${match[1]}`)
  }
}

function assertTaskAgentChannelPin(bootstrap, expectedChannel) {
  const match = /^AAMP_TASK_AGENT_CHANNEL="\$\{AAMP_TASK_AGENT_CHANNEL:-([^}"]+)\}"$/m.exec(bootstrap)
  if (!match) {
    throw new Error(`Task Agent prepared source channel validation failed: expected ${expectedChannel}, but AAMP_TASK_AGENT_CHANNEL is missing`)
  }
  if (match[1] !== expectedChannel) {
    throw new Error(`Task Agent prepared source channel validation failed: expected ${expectedChannel}, got ${match[1]}`)
  }
}

function readPinnedPackageGroup(content, pattern, label) {
  const pins = exactMatches(content, pattern)
  if (pins.length !== 2) {
    throw new Error(`${label} pin validation failed: expected 2 occurrences`)
  }
  const unique = [...new Set(pins)]
  if (unique.length !== 1) {
    throw new Error(`${label} pin validation failed: expected 2 matching occurrences`)
  }
  return parsePinnedPackage(unique[0])
}

function readAimeRegistry(bootstrap) {
  const matches = [...bootstrap.matchAll(/AIME_ACP_REGISTRY:-([^}"]+)/g)].map((match) => match[1])
  if (matches.length !== 2 || matches.some((entry) => entry !== matches[0])) {
    throw new Error('AIME ACP registry validation failed: expected 2 matching occurrences')
  }
  return matches[0]
}

function assertPreparedTaskAgentPins(taskDir, sources, targets, taskAgentChannel) {
  assertTaskAgentBootstrapVersion(taskDir, targets.taskAgent.version)
  const { bootstrap, controller, readme } = readTaskAgentPinFiles(taskDir)
  assertTaskAgentNamePin(bootstrap, targets.taskAgent.name)
  assertTaskAgentChannelPin(bootstrap, taskAgentChannel)
  const taskAgentScopePins = exactMatches(`${controller}\n${readme}`, /@[^/\s"']+\/aamp-feishu-task-agent@(dev|latest)/g)
  if (taskAgentScopePins.length !== 2 || taskAgentScopePins.some((pin) => pin !== `${targets.taskAgent.name}@${taskAgentChannel}`)) {
    throw new Error(`Task Agent prepared source pin validation failed: expected 2 occurrences of ${targets.taskAgent.name}@${taskAgentChannel}`)
  }
  if (targets.acpBridge?.selected) {
    const expected = `${targets.acpBridge.name}@${targets.acpBridge.version}`
    const pins = exactMatches(`${bootstrap}\n${controller}`, /@[^/\s"']+\/aamp-acp-bridge@[0-9A-Za-z.-]+/g)
    if (pins.length !== 2 || pins.some((pin) => pin !== expected)) {
      throw new Error(`ACP bridge prepared source pin validation failed: expected 2 occurrences of ${expected}`)
    }
  }
  if (targets.feishuBridge?.selected) {
    const expected = `${targets.feishuBridge.name}@${targets.feishuBridge.version}`
    const pins = exactMatches(`${bootstrap}\n${controller}`, /@[^/\s"']+\/aamp-feishu-bridge@[0-9A-Za-z.-]+/g)
    if (pins.length !== 2 || pins.some((pin) => pin !== expected)) {
      throw new Error(`Feishu bridge prepared source pin validation failed: expected 2 occurrences of ${expected}`)
    }
  }
  if (targets.aimeAcp?.selected) {
    const expected = `${targets.aimeAcp.name}@${targets.aimeAcp.version}`
    const pins = exactMatches(bootstrap, /@[^/\s"']+\/aime-acp@[0-9A-Za-z.-]+/g)
    if (pins.length !== 2 || pins.some((pin) => pin !== expected)) {
      throw new Error(`AIME ACP prepared source pin validation failed: expected 2 occurrences of ${expected}`)
    }
    const registries = exactMatches(bootstrap, /AIME_ACP_REGISTRY:-([^}"]+)/g)
    if (registries.length !== 2 || registries.some((entry) => entry !== `AIME_ACP_REGISTRY:-${targets.aimeAcp.registry}`)) {
      throw new Error(`AIME ACP registry validation failed: expected 2 occurrences of ${targets.aimeAcp.registry}`)
    }
  }
}

function assertStagedTaskAgentPins(taskDir, sourceTaskDir) {
  const staged = readTaskAgentPinFiles(taskDir)
  const source = readTaskAgentPinFiles(sourceTaskDir)
  if (staged.bootstrap !== source.bootstrap) {
    throw new Error('Staged Task Agent bootstrap pins must match prepared source pins exactly')
  }
  if (staged.controller !== source.controller) {
    throw new Error('Staged Task Agent controller pins must match prepared source pins exactly')
  }
  if (staged.readme !== source.readme) {
    throw new Error('Staged Task Agent README pins must match prepared source pins exactly')
  }
}

function assertPreparedSourceMetadata(sources, targets, releaseSpecs, options) {
  for (const spec of releaseSpecs) {
    const source = sources.get(spec.key)
    assertPackageMetadata(source.sourceDir, source.sourceName, targets[spec.key].version)
  }
  if (targets.taskAgent?.selected) {
    assertPreparedTaskAgentPins(
      sources.get('taskAgent').sourceDir,
      sources,
      targets,
      preparedTaskAgentChannel(options.mode),
    )
  }
}

function prepareSourceMetadata(sources, targets, releaseSpecs, options) {
  const includesTaskAgent = targets.taskAgent?.selected
  const snapshot = snapshotSourceFiles(preparedSourceFiles(sources, releaseSpecs, includesTaskAgent))
  try {
    for (const spec of releaseSpecs) {
      const source = sources.get(spec.key)
      patchPackageMetadata(source.sourceDir, source.sourceName, targets[spec.key].version)
    }
    if (includesTaskAgent) {
      patchPreparedSourceTaskAgentPins(
        sources.get('taskAgent').sourceDir,
        targets,
        preparedTaskAgentChannel(options.mode),
      )
    }
    assertPreparedSourceMetadata(sources, targets, releaseSpecs, options)
  } catch (error) {
    restoreSourceFiles(snapshot)
    throw error
  }
}

function assertSelectedVersionsNotAlreadyPublished(targets, selectedKeys, options) {
  if (options.prepareSource || options.verifyPublished || options.resumePublish) return
  for (const spec of selectedPackageSpecs(selectedKeys)) {
    const target = targets[spec.key]
    if (!target.alreadyPublished) continue
    if (options.mode === 'trial') {
      throw new Error(`Source version ${target.version} already exists in the target registry. Run --prepare-source before packing or publishing.`)
    }
    throw new Error(`Final version ${target.version} already exists. Run --mode final --prepare-source with --bump.`)
  }
}

function validatePinnedDependency(packageManager, pin, registry, spec, selected, expectedTarget) {
  if (selected) {
    if (pin.name !== expectedTarget.name || pin.version !== expectedTarget.version) {
      throw new Error(`${spec.key} selected pin validation failed: expected ${expectedTarget.name}@${expectedTarget.version}, got ${pin.name}@${pin.version}`)
    }
    return
  }
  const versions = remoteVersions(packageManager, registry, pin.name)
  if (!versions.includes(pin.version)) {
    throw new Error(`Task Agent default ${spec.unscopedName} pin ${pin.name}@${pin.version} is not published on ${registry}. Include --package ${spec.key} to publish it, or update the source Task Agent pin before packing/publishing.`)
  }
}

function assertAllTaskAgentDefaultPinsValid(taskDir, packageManager, targets) {
  const { bootstrap, controller } = readTaskAgentPinFiles(taskDir)
  const acpPin = readPinnedPackageGroup(`${bootstrap}\n${controller}`, /@[^/\s"']+\/aamp-acp-bridge@[0-9A-Za-z.-]+/g, 'ACP bridge')
  const feishuPin = readPinnedPackageGroup(`${bootstrap}\n${controller}`, /@[^/\s"']+\/aamp-feishu-bridge@[0-9A-Za-z.-]+/g, 'Feishu bridge')
  const aimePin = readPinnedPackageGroup(bootstrap, /@[^/\s"']+\/aime-acp@[0-9A-Za-z.-]+/g, 'AIME ACP')
  const aimeRegistry = readAimeRegistry(bootstrap)

  validatePinnedDependency(packageManager, acpPin, targets.acpBridge.registry, PACKAGE_SPECS.find((spec) => spec.key === 'acpBridge'), targets.acpBridge.selected, targets.acpBridge)
  validatePinnedDependency(packageManager, feishuPin, targets.feishuBridge.registry, PACKAGE_SPECS.find((spec) => spec.key === 'feishuBridge'), targets.feishuBridge.selected, targets.feishuBridge)
  validatePinnedDependency(packageManager, aimePin, aimeRegistry, PACKAGE_SPECS.find((spec) => spec.key === 'aimeAcp'), targets.aimeAcp.selected, targets.aimeAcp)
}

function assertTaskAgentBootstrapVersion(taskDir, expectedVersion) {
  const bootstrapFile = path.join(taskDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh')
  const content = fs.readFileSync(bootstrapFile, 'utf8')
  const match = /^AAMP_TASK_AGENT_VERSION="([^"]+)"$/m.exec(content)
  if (!match) {
    throw new Error(`Task Agent bootstrap is missing AAMP_TASK_AGENT_VERSION: ${bootstrapFile}`)
  }
  if (match[1] !== expectedVersion) {
    throw new Error(`Task Agent bootstrap version mismatch: package=${expectedVersion} bootstrap=${match[1]}`)
  }
}

function chmodBins(pkgDir) {
  const packageJson = readJson(path.join(pkgDir, 'package.json'))
  if (!packageJson.bin) return
  for (const rel of Object.values(packageJson.bin)) {
    const file = path.join(pkgDir, rel)
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755)
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

function packPackage(packageManager, pkgDir, artifactsDir) {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const stdout = run(packageManager.command, ['pack', '--ignore-scripts', '--pack-destination', artifactsDir], { cwd: pkgDir })
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
  const packed = candidates.at(-1)
  if (!packed) throw new Error(`Could not determine packed tgz from ${packageManager.command} pack output:\n${stdout}`)
  return path.isAbsolute(packed) ? packed : path.join(artifactsDir, path.basename(packed))
}

function assertBrowserPublishReady(packageManager) {
  if (packageManager.name !== 'npm') {
    throw new Error('Remote publish requires npm. Public npm uses browser authentication; BNPM uses existing internal authentication.')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Remote publish requires a TTY so public npm can print/open its browser auth URL. Rerun this helper in a TTY without --otp.')
  }
}

function browserAuthEnv() {
  return {
    ...process.env,
    npm_config_auth_type: 'web',
    NPM_CONFIG_AUTH_TYPE: 'web',
  }
}

function publishPackage(packageManager, tgz, registry, tag) {
  const args = ['publish', tgz, '--ignore-scripts', '--access', 'public', '--registry', registry, '--tag', tag]
  if (packageManager.name === 'pnpm') args.splice(2, 0, '--no-git-checks')
  run(packageManager.command, args, {
    cwd: path.dirname(tgz),
    stdio: 'inherit',
    env: normalizeRegistry(registry) === PUBLIC_NPM_REGISTRY ? browserAuthEnv() : process.env,
  })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function shellWord(value) {
  const text = String(value)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : shellQuote(text)
}

function packFileName(target) {
  return `${target.name.replace(/^@/, '').replace('/', '-')}-${target.version}.tgz`
}

function targetTgzPath(target, artifactsDir) {
  return target.tgz || path.join(artifactsDir, packFileName(target))
}

function buildLocalTestCommand(packageManager, targets, artifactsDir) {
  if (!targets.taskAgent?.tgz) return null
  const taskAgentTgz = targetTgzPath(targets.taskAgent, artifactsDir)
  const envLines = [
    'env',
    '-u ACP_BRIDGE_PKG',
    '-u AAMP_TASK_ACP_BRIDGE_PKG',
    '-u FEISHU_BRIDGE_PKG',
    '-u AAMP_TASK_FEISHU_BRIDGE_PKG',
    '-u AIME_ACP_PKG',
    '-u AAMP_TASK_AIME_ACP_PKG',
    '-u AIME_ACP_REGISTRY',
    '-u AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG',
    '-u AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG',
    '-u AAMP_TASK_REQUESTED_AIME_ACP_PKG',
    '-u AAMP_TASK_AGENT_NAME',
    '-u AAMP_TASK_AGENT_LEGACY_NAME',
    '-u AAMP_TASK_AGENT_CHANNEL',
    '-u AAMP_TASK_COMMAND_NAME',
    '-u AAMP_TASK_COMMAND_PATH',
    '-u AAMP_TASK_SHIM_DIR',
    '-u AAMP_TASK_ENTRY',
    '-u AAMP_TASK_INTERNAL',
    '-u AAMP_TASK_INTERNAL_RESULT_FD',
    '-u AAMP_TASK_INTERNAL_INPUT_FD',
    '-u AAMP_TASK_INTERNAL_EXECUTION_LOCATION',
    '-u AAMP_TASK_PACKAGE_OVERRIDES_RESOLVED',
    '-u AAMP_TASK_NPM_REGISTRY',
    '-u AAMP_TASK_NPM_GLOBAL_PREFIX',
    '-u AAMP_TASK_NPM_CACHE_DIR',
    '-u AAMP_TASK_NPM_BIN',
    '-u AAMP_TASK_NPX_BIN',
    '-u AAMP_TASK_INSTALL_COMMAND',
    '-u NPM_REGISTRY',
    '-u NPM_CONFIG_REGISTRY',
    '-u npm_config_registry',
    '-u NPM_GLOBAL_PREFIX',
    '-u AAMP_BIN_DIR',
    '-u AAMP_TASK_COMMAND_PATH',
    '-u AAMP_TASK_SHIM_DIR',
    'AAMP_TASK_AUTO_UPDATE=false',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
  ]
  if (targets.acpBridge?.tgz) {
    envLines.push(`ACP_BRIDGE_PKG=${shellQuote(targetTgzPath(targets.acpBridge, artifactsDir))}`)
  }
  if (targets.feishuBridge?.tgz) {
    envLines.push(`FEISHU_BRIDGE_PKG=${shellQuote(targetTgzPath(targets.feishuBridge, artifactsDir))}`)
  }
  if (targets.aimeAcp?.tgz) {
    envLines.push(`AIME_ACP_PKG=${shellQuote(targetTgzPath(targets.aimeAcp, artifactsDir))}`)
    envLines.push(`AIME_ACP_REGISTRY=${shellQuote(targets.aimeAcp.registry)}`)
  }
  envLines.push(`bash -c 'tar -xOzf "$1" package/bootstrap/aamp-feishu-task-agent-bootstrap.sh | bash -s -- install' _ ${shellQuote(taskAgentTgz)}`)
  return [
    `${packageManager.command} install -g --prefix "$HOME/.aamp/npm-global" --force ${shellQuote(taskAgentTgz)}`,
    envLines.join(' \\\n  '),
  ].join('\n')
}

function buildFollowUpStartCommand() {
  return [
    'feishu-task-agent start',
    '# 如果当前 shell 还没加载 ~/.aamp/bin 到 PATH：',
    '"$HOME/.aamp/bin/feishu-task-agent" start',
  ].join('\n')
}

function defaultTag(mode, targets) {
  if (mode === 'trial') return 'dev'
  return Object.values(targets).some((target) => target.version?.includes('-')) ? 'dev' : 'latest'
}

function printReleasePlan(sources, targets, selectedKeys) {
  console.log('version plan:')
  for (const spec of selectedPackageSpecs(selectedKeys)) {
    const source = sources.get(spec.key)
    const target = targets[spec.key]
    console.log(`- ${source.sourceName}@${source.sourceVersion} -> ${target.name}@${target.version}${target.remoteLatest ? ` (remote latest ${target.remoteLatest})` : ' (new package)'} [${target.registry}]`)
  }
}

function scriptCommand(args) {
  return ['node', '.agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs', ...args].map(shellWord).join(' ')
}

function commandArgsForOptions(options, scopes, packageManager, publish) {
  const args = [
    '--mode', options.mode,
    '--scope', scopes.publicScope,
    '--registry', options.registry,
    '--aime-registry', options.aimeRegistry,
    '--pm', packageManager.command,
  ]
  if (scopes.aimeScope) args.push('--aime-scope', scopes.aimeScope)
  for (const key of options.packages) args.push('--package', key)
  if (options.tag) args.push('--tag', options.tag)
  if (options.prepareSource) {
    args.push('--prepare-source')
    if (options.bumpExplicit || options.mode === 'final') args.push('--bump', options.bump)
    for (const [key, version] of options.versions) args.push('--version', `${key}=${version}`)
  } else if (publish) {
    args.push('--publish', '--confirm-publish')
    if (options.allowDirty) args.push('--allow-dirty')
  } else {
    args.push('--pack')
  }
  return args
}

function createPrompter() {
  if (process.stdin.isTTY) {
    return createInterface({ input, output })
  }
  const lines = fs.readFileSync(0, 'utf8').split(/\r?\n/)
  let index = 0
  return {
    async question(prompt) {
      output.write(prompt)
      const answer = index < lines.length ? lines[index] : ''
      index += 1
      output.write(`${answer}\n`)
      return answer
    },
    close() {},
  }
}

async function questionWithDefault(prompter, question, defaultValue) {
  const answer = (await prompter.question(`${question} [${defaultValue}]: `)).trim()
  return answer || defaultValue
}

async function runWizard(baseOptions) {
  const repoRoot = findRepoRoot()
  let { packageManager, whoami: publicWhoami } = resolveAuthenticatedPackageManager(baseOptions.packageManager, baseOptions.registry)
  const dirty = trackedDirty(repoRoot)
  const prompter = createPrompter()

  try {
    console.log(`npm identity: ${publicWhoami}`)
    console.log(`package manager: ${packageManager.command}`)
    console.log('')
    console.log('选择要准备哪种包：')
    console.log('1) 个人试用本地包：只 pack tgz，不发布 npm')
    console.log('2) 个人试用远程包：发布到当前用户 scope，例如 @luckyterry，tag=dev')
    console.log('3) @larktask 官方稳定包：按源码版本和 bump 准备 stable 版本，tag=latest')
    const choice = (await questionWithDefault(prompter, '输入序号', '1')).trim()

    const options = {
      ...baseOptions,
      publish: false,
      confirmPublish: false,
      allowDirty: dirty.length > 0,
      prepareSource: false,
      aimeScope: '',
    }
    let scopes = { publicScope: '', aimeScope: '' }
    let publish = false
    let releaseLabel = ''

    if (choice === '1') {
      releaseLabel = '个人试用本地包'
      options.mode = 'trial'
      options.tag = baseOptions.tag || 'dev'
      scopes.publicScope = normalizeScope(`@${publicWhoami}`)
      publish = false
    } else if (choice === '2') {
      releaseLabel = '个人试用远程包'
      options.mode = 'trial'
      options.tag = baseOptions.tag || 'dev'
      scopes.publicScope = normalizeScope(`@${publicWhoami}`)
      publish = true
    } else if (choice === '3') {
      if (publicWhoami !== 'larktask') {
        throw new Error(`Final release requires public npm identity must be exactly larktask, got ${publicWhoami}`)
      }
      releaseLabel = '@larktask 官方稳定包源码准备'
      options.mode = 'final'
      options.tag = baseOptions.tag || 'latest'
      options.prepareSource = true
      options.bump = await questionWithDefault(prompter, 'stable prepare 使用哪个 bump（patch/minor/major）', 'patch')
      options.bumpExplicit = true
      scopes.publicScope = '@larktask'
      publish = false
    } else {
      throw new Error(`Unsupported choice: ${choice}`)
    }

    if (publish && packageManager.name !== 'npm') {
      const resolved = resolveAuthenticatedPackageManager('npm', baseOptions.registry, true)
      packageManager = resolved.packageManager
      publicWhoami = resolved.whoami
      scopes.publicScope = normalizeScope(`@${publicWhoami}`)
      console.log(`remote publish uses npm browser auth; switching package manager to ${packageManager.command}`)
    }

    const packageChoice = await questionWithDefault(
      prompter,
      '要打哪些包（all/aimeAcp/acpBridge/feishuBridge/taskAgent，可逗号分隔；依赖包会自动带 taskAgent）',
      options.packages.size > 0 ? [...options.packages].join(',') : 'all',
    )
    options.packages = new Set()
    for (const value of packageChoice.split(',')) {
      const key = normalizePackageSelection(value.trim())
      if (key) options.packages.add(key)
    }
    const selectedKeys = resolveSelectedPackageKeys(options)
    if (selectedKeys.has('aimeAcp')) {
      const bnpmWhoami = npmWhoami(packageManager, options.aimeRegistry)
      scopes.aimeScope = normalizeScope(`@${bnpmWhoami}`)
      options.aimeScope = scopes.aimeScope
      console.log(`npm identity (${options.aimeRegistry}): ${bnpmWhoami}`)
    }
    const { sources, targets, tag } = buildReleasePlan(repoRoot, packageManager, options, scopes, selectedKeys)
    const outDir = path.resolve(repoRoot, options.outDir)
    const artifactsDir = path.join(outDir, 'artifacts')
    const remoteOneClickUrl = tarballUrl(options.registry, targets.taskAgent.name, targets.taskAgent.version)
    const remoteOneClickCommand = `curl -fsSL ${remoteOneClickUrl} | tar -xOzf - package/bootstrap/aamp-feishu-task-agent-bootstrap.sh | bash -s -- install`
    const localTestCommand = buildLocalTestCommand(packageManager, targets, artifactsDir)
    const followUpStartCommand = buildFollowUpStartCommand()
    const executionArgs = commandArgsForOptions(options, scopes, packageManager, publish)

    console.log('')
    console.log(`release type: ${releaseLabel}`)
    console.log(`target scope: ${scopes.publicScope}`)
    console.log(`dist-tag: ${tag}`)
    console.log(`selected packages: ${describePackageKeys(selectedKeys)}`)
    if (dirty.length > 0 && publish) {
      console.log('tracked worktree is dirty; generated publish command includes --allow-dirty:')
      for (const line of dirty) console.log(`- ${line}`)
    }
    console.log('')
    printReleasePlan(sources, targets, selectedKeys)
    console.log('')
    console.log(options.prepareSource ? 'prepare-source command:' : publish ? 'publish command:' : 'pack command:')
    console.log(scriptCommand(executionArgs))
    console.log('')
    if (options.prepareSource) {
      console.log('Review and test the prepared source changes, commit them, then run the publish phase separately.')
    } else if (publish) {
      console.log('remote one-click startup command after publish succeeds and npm metadata is visible:')
      console.log(remoteOneClickCommand)
      console.log('')
      console.log('follow-up start command after first install has saved bindings:')
      console.log(followUpStartCommand)
      console.log('')
      console.log('Public npm publish uses browser auth in this TTY; BNPM uses existing internal npm authentication. Let the script verify registry artifact metadata before treating a package as usable.')
    } else {
      console.log('startup command after local pack succeeds:')
      console.log(localTestCommand)
      console.log('')
      console.log('follow-up start command after first install has saved bindings:')
      console.log(followUpStartCommand)
    }
  } finally {
    prompter.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.wizard) {
    await runWizard(options)
    return
  }
  assertExplicitPackageSelection(options)

  const repoRoot = findRepoRoot()
  const mutating = !options.planOnly
  const operation = options.prepareSource
    ? 'prepare-source'
    : options.publish
      ? 'publish'
      : options.verifyPublished
        ? 'verify-published'
        : 'pack'
  const releaseLock = mutating
    ? acquireReleaseLock({
        repoRoot,
        helper: 'aamp-npm-release',
        operation,
        argv: process.argv.slice(2),
      })
    : null
  try {
    const { packageManager, whoami: publicWhoami } = resolveAuthenticatedPackageManager(
      options.packageManager,
      options.registry,
      options.publish,
    )
    if (options.mode === 'final' && publicWhoami !== 'larktask') {
      throw new Error(`Final release requires public npm identity must be exactly larktask, got ${publicWhoami}`)
    }
    const canonicalScope = options.mode === 'trial' ? normalizeScope(`@${publicWhoami}`) : '@larktask'
    const requestedScope = normalizeScope(options.scope)
    if (options.mode === 'trial' && requestedScope && requestedScope !== canonicalScope) {
      throw new Error(`--scope assertion must equal ${canonicalScope}`)
    }
    if (options.mode === 'final' && requestedScope && requestedScope !== canonicalScope) {
      throw new Error('Final scope is fixed to @larktask')
    }
    const scopes = { publicScope: canonicalScope, aimeScope: '' }

    const dirty = trackedDirty(repoRoot)
    if (dirty.length > 0 && options.publish && !options.allowDirty) {
      throw new Error(`Tracked worktree files are dirty. Commit/stash them or pass --allow-dirty:\n${dirty.join('\n')}`)
    }

    const selectedKeys = resolveSelectedPackageKeys(options)
    const releaseSpecs = selectedPackageSpecs(selectedKeys)
    if (selectedKeys.has('aimeAcp') || options.aimeScope) {
      const bnpmWhoami = npmWhoami(packageManager, options.aimeRegistry)
      console.log(`npm identity (${options.aimeRegistry}): ${bnpmWhoami}`)
      scopes.aimeScope = normalizeScope(`@${bnpmWhoami}`)
      if (options.aimeScope && normalizeScope(options.aimeScope) !== scopes.aimeScope) {
        throw new Error(`--aime-scope assertion must equal ${scopes.aimeScope}`)
      }
    }
    if (options.prepareSource) assertReleaseVersionsMatchHead(repoRoot, releaseSpecs)
    const requiredRegistries = new Set(releaseSpecs.map((spec) => packageRegistry(spec, options)))
    for (const registry of requiredRegistries) {
      if (registry === options.registry || registry === options.aimeRegistry) continue
      const identity = npmWhoami(packageManager, registry)
      console.log(`npm identity (${registry}): ${identity}`)
    }
    const { sources, targets, tag } = buildReleasePlan(repoRoot, packageManager, options, scopes, selectedKeys)
    const hasPublicRegistryTarget = releaseSpecs.some((spec) => {
      const target = targets[spec.key]
      return normalizeRegistry(target.registry) === PUBLIC_NPM_REGISTRY
        && !(options.resumePublish && target.alreadyPublished)
    })
    if (options.publish && hasPublicRegistryTarget) assertBrowserPublishReady(packageManager)
    const outDir = path.resolve(repoRoot, options.outDir)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
    const stageRoot = path.join(outDir, `stage-${options.mode}-${scopes.publicScope.slice(1)}-${stamp}`)
    const artifactsDir = path.join(outDir, 'artifacts')

    console.log(`npm identity: ${publicWhoami}`)
    console.log(`package manager: ${packageManager.command}`)
    console.log(`mode: ${options.mode}`)
    console.log(`target scope: ${scopes.publicScope}`)
    console.log(`registry: ${options.registry}`)
    console.log(`dist-tag: ${tag}`)
    console.log(`selected packages: ${describePackageKeys(selectedKeys)}`)
    console.log('')
    printReleasePlan(sources, targets, selectedKeys)

    if (options.prepareSource) {
      prepareSourceMetadata(sources, targets, releaseSpecs, options)
      console.log('')
      console.log('source metadata prepared; review and commit the changes before publishing')
      return
    }

    if (options.planOnly) return

    assertPreparedSourceMetadata(sources, targets, releaseSpecs, options)
    assertAllTaskAgentDefaultPinsValid(sources.get('taskAgent').sourceDir, packageManager, targets)
    assertSelectedVersionsNotAlreadyPublished(targets, selectedKeys, options)

    if (!options.skipBuild) {
      for (const spec of releaseSpecs.filter((item) => item.build)) {
        const source = sources.get(spec.key)
        console.log(`\nbuild: ${source.sourceDir}`)
        run(packageManager.command, ['run', 'build'], { cwd: source.sourceDir, stdio: 'inherit' })
      }
    }

    removeIfExists(stageRoot)
    fs.mkdirSync(stageRoot, { recursive: true })

    for (const spec of releaseSpecs) {
      const source = sources.get(spec.key)
      const stagedDir = path.join(stageRoot, spec.unscopedName)
      copyPackageForStaging(source.sourceDir, stagedDir)
      patchPackageMetadata(stagedDir, targets[spec.key].name, targets[spec.key].version)
      chmodBins(stagedDir)
      targets[spec.key].stagedDir = stagedDir
    }
    if (selectedKeys.has('taskAgent')) {
      assertStagedTaskAgentPins(targets.taskAgent.stagedDir, sources.get('taskAgent').sourceDir)
    }

    const packed = []
    if (options.pack) {
      for (const spec of releaseSpecs) {
        const target = targets[spec.key]
        console.log(`\npack: ${target.name}@${target.version}`)
        const tgz = packPackage(packageManager, target.stagedDir, artifactsDir)
        target.tgz = tgz
        target.sha256 = sha256(tgz)
        target.sha1 = sha1(tgz)
        packed.push({ key: spec.key, name: target.name, version: target.version, tgz, sha256: target.sha256 })
        console.log(`artifact: ${tgz}`)
        console.log(`sha256: ${target.sha256}`)
      }
    }

    if (options.publish) {
      console.log('\nauth: public npm uses browser auth in this TTY; BNPM uses existing internal npm authentication.')
      for (const spec of releaseSpecs) {
        const target = targets[spec.key]
        if (options.resumePublish && target.alreadyPublished) {
          console.log(`\nresume verify: ${target.name}@${target.version} [${target.registry}]`)
          await waitForRemoteArtifact(packageManager, target.registry, target)
          continue
        }
        console.log(`\npublish: ${target.name}@${target.version} [${target.registry}]`)
        publishPackage(packageManager, target.tgz, target.registry, tag)
      }
      console.log('\nverify published package metadata:')
      for (const spec of releaseSpecs) {
        const target = targets[spec.key]
        await waitForRemoteArtifact(packageManager, target.registry, target)
        console.log(`- ${target.name}@${target.version}: visible, packed shasum verified`)
      }
    }

    if (options.verifyPublished) {
      console.log('\nverify existing published package artifacts:')
      for (const spec of releaseSpecs) {
        const target = targets[spec.key]
        await waitForRemoteArtifact(packageManager, target.registry, target)
        console.log(`- ${target.name}@${target.version}: visible, packed shasum verified`)
      }
    }

    const oneClickUrl = targets.taskAgent?.selected
      ? tarballUrl(options.registry, targets.taskAgent.name, targets.taskAgent.version)
      : null
    const oneClickCommand = oneClickUrl
      ? `curl -fsSL ${oneClickUrl} | tar -xOzf - package/bootstrap/aamp-feishu-task-agent-bootstrap.sh | bash -s -- install`
      : null
    const remoteOneClickCommand = options.publish || options.verifyPublished ? oneClickCommand : null
    const localTestCommand = buildLocalTestCommand(packageManager, targets, artifactsDir)
    const followUpStartCommand = buildFollowUpStartCommand()
    const manifest = {
      generatedAt: new Date().toISOString(),
      repoRoot,
      mode: options.mode,
      npmIdentity: publicWhoami,
      packageManager: packageManager.command,
      scope: scopes.publicScope,
      registry: options.registry,
      tag,
      selectedPackages: releaseSpecs.map((spec) => spec.key),
      stageRoot,
      artifactsDir,
      packages: PACKAGE_SPECS.map((spec) => ({
        key: spec.key,
        selected: selectedKeys.has(spec.key),
        sourceName: sources.get(spec.key).sourceName,
        sourceVersion: sources.get(spec.key).sourceVersion,
        targetName: targets[spec.key].name,
        targetVersion: targets[spec.key].version,
        remoteLatest: targets[spec.key].remoteLatest,
        registry: targets[spec.key].registry,
        stagedDir: targets[spec.key].stagedDir,
        tgz: targets[spec.key].tgz || null,
        sha256: targets[spec.key].sha256 || null,
        sha1: targets[spec.key].sha1 || null,
        remoteIntegrity: targets[spec.key].remoteIntegrity || null,
        remoteTarball: targets[spec.key].remoteTarball || null,
      })),
      remoteOneClickUrl: options.publish || options.verifyPublished ? oneClickUrl : null,
      remoteOneClickCommand,
      localTestCommand,
      followUpStartCommand,
    }
    const manifestFile = path.join(stageRoot, 'release-manifest.json')
    writeJson(manifestFile, manifest)

    console.log('')
    console.log(`manifest: ${manifestFile}`)
    if (packed.length > 0) {
      console.log('')
      console.log('artifacts:')
      for (const item of packed) {
        console.log(`- ${item.name}@${item.version}`)
        console.log(`  ${item.tgz}`)
        console.log(`  sha256 ${item.sha256}`)
      }
    }
    if (localTestCommand) {
      console.log('')
      console.log('local tgz test command:')
      console.log(localTestCommand)
    }
    if (remoteOneClickCommand) {
      console.log('')
      console.log('remote one-click startup command:')
      console.log(remoteOneClickCommand)
    } else {
      console.log('')
      console.log('remote one-click startup command: not printed because packages were packed locally but not published/verified')
    }
    console.log('')
    console.log('follow-up start command:')
    console.log(followUpStartCommand)
  } finally {
    releaseLock?.release()
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`)
  process.exit(1)
})
