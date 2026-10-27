import { spawn } from 'node:child_process'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import {recoverPackageCache} from './runtime-recovery-cache.mjs'

export async function withExecutableProbeDeadline(promise, {timeoutMs, label, onTimeout}) {
  if (!timeoutMs) return promise
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} 健康检查超时（${timeoutMs / 1000} 秒）`))
        // Cleanup can require identity checks or fail; neither may extend the
        // probe's deadline. The controller retains the process for cleanup.
        Promise.resolve().then(onTimeout).catch(() => {})
      }, timeoutMs)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function canonicalCachePath(value, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  let candidate = paths.resolve(value)
  if (platform !== process.platform) return candidate
  const suffix = []
  for (;;) {
    try { return paths.join(realpathSync.native(candidate), ...suffix) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined
      const parent = paths.dirname(candidate)
      if (parent === candidate) return paths.resolve(value)
      suffix.unshift(paths.basename(candidate))
      candidate = parent
    }
  }
}

export function isMissingCachedModule(error, cacheDir, platform = process.platform) {
  if (!cacheDir) return false
  const text = String(error?.stderr || '')
  if (!/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(text)) return false
  const missing = /Cannot find (?:module|package) ['"]([^'"\r\n]+)['"]/.exec(text)?.[1]
  if (!missing) return false
  const paths = platform === 'win32' ? path.win32 : path.posix
  const owned = value => {
    const root = canonicalCachePath(cacheDir, platform)
    const target = canonicalCachePath(value, platform)
    if (!root || !target) return false
    const relative = paths.relative(root, target).replaceAll('\\', '/')
    return /^(?:_npx|_aamp-recovery-v1)\//.test(relative)
  }
  if (paths.isAbsolute(missing)) return owned(missing)
  // A bare missing dependency must have an importer inside our managed cache.
  // Never classify a missing user-project module as a cache repair request.
  if (missing.startsWith('.')) return false
  const importer = /(?:imported from |^- )([^\r\n]+)/m.exec(text)?.[1]
  return Boolean(importer && paths.isAbsolute(importer) && owned(importer))
}

const NPM_EXEC_ENVIRONMENT_KEYS = [
  'npm_lifecycle_event',
  'npm_package_json',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'INIT_CWD',
]

const RESOLVE_EXECUTABLE_SOURCE = String.raw`
import fs from 'node:fs'
import path from 'node:path'

const executable = process.argv[1]
const environmentKeys = ${JSON.stringify(NPM_EXEC_ENVIRONMENT_KEYS)}

function environmentValue(name) {
  return Object.entries(process.env)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || ''
}

const pathValue = environmentValue('PATH')
const pathEntries = pathValue.split(path.delimiter).filter(Boolean)
const environment = {}
for (const key of environmentKeys) {
  if (Object.hasOwn(process.env, key) && typeof process.env[key] === 'string') {
    environment[key] = process.env[key]
  }
}
const windowsExtensions = (environmentValue('PATHEXT') || '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .map((extension) => extension.trim())
  .filter(Boolean)

function executableCandidates(binDir) {
  const candidate = path.join(binDir, executable)
  if (process.platform !== 'win32') return [candidate]
  if (windowsExtensions.some((extension) => executable.toLowerCase().endsWith(extension.toLowerCase()))) {
    return [candidate]
  }
  return windowsExtensions.map((extension) => candidate + extension.toLowerCase())
}

for (const binDir of pathEntries) {
  for (const candidate of executableCandidates(binDir)) {
    try {
      const stat = fs.statSync(candidate)
      if (!stat.isFile()) continue
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
      const extension = path.extname(candidate).toLowerCase()
      const kind = process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')
        ? 'cmd'
        : 'direct'
      if (kind === 'cmd') {
        let shim = fs.readFileSync(candidate, 'utf8')
        if (/^\s*@?SET\s+"?dp0=%~dp0"?\s*$/im.test(shim)) shim = shim.replace(/%dp0%/gi, '%~dp0')
        // Check only the standard npm Node shim form; never evaluate batch text.
        const entry = /(?:\bnode(?:\.exe)?|"%_prog%"|"%~dp0[\\/]node\.exe")\s+"%~dp0[\\/]([^"\r\n]+)"\s+%\*/i.exec(shim)
        if (entry && !fs.statSync(path.resolve(binDir, entry[1])).isFile()) continue
      }
      process.stdout.write(JSON.stringify({
        executable,
        kind,
        command: candidate,
        pathValue,
        environment,
      }))
      process.exit(0)
    } catch {
      // Keep following npm's PATH order until its executable shim is found.
    }
  }
}

process.stderr.write('unable to resolve npm executable shim: ' + executable + '\n')
process.exit(78)
`

// npm treats its executable as shell command text on Windows. Preserve the
// absolute Node path so spaces cannot split it or select a package-local node.
export function npmExecutableResolverCommand({ platform = process.platform, execPath = process.execPath } = {}) {
  return platform === 'win32' ? '""' + execPath + '""' : execPath
}

export function npmExecutableResolverArgs(executable, { platform = process.platform } = {}) {
  // npm exec crosses cmd.exe on Windows, where a multiline --eval argument is
  // truncated even when npm exits successfully. Keep the fixed module in one
  // base64 data URL; the requested executable remains a separate argument.
  const source = platform === 'win32'
    ? `import('data:text/javascript;base64,${Buffer.from(RESOLVE_EXECUTABLE_SOURCE, 'utf8').toString('base64')}')`
    : RESOLVE_EXECUTABLE_SOURCE
  return ['--input-type=module', '--eval', source, executable]
}

function validatePreparedExecutable(value, executable = value?.executable) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${executable || 'package'} resolved an invalid npm executable descriptor`)
  }
  if (value.executable !== executable || !['direct', 'cmd'].includes(value.kind)) {
    throw new Error(`${executable} resolved an invalid npm executable descriptor`)
  }
  if (typeof value.command !== 'string' || !value.command) {
    throw new Error(`${executable} resolved an invalid npm executable command`)
  }
  if (typeof value.pathValue !== 'string' || !value.pathValue) {
    throw new Error(`${executable} resolved an invalid npm executable PATH`)
  }
  if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)) {
    throw new Error(`${executable} resolved an invalid npm executable environment`)
  }
  const environment = {}
  for (const [key, environmentValue] of Object.entries(value.environment)) {
    if (!NPM_EXEC_ENVIRONMENT_KEYS.includes(key) || typeof environmentValue !== 'string') {
      throw new Error(`${executable} resolved an invalid npm executable environment`)
    }
    environment[key] = environmentValue
  }
  return {
    executable: value.executable,
    kind: value.kind,
    command: value.command,
    pathValue: value.pathValue,
    environment,
  }
}

export function parseResolvedPackageExecutable(stdout, executable) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines.reverse()) {
    try {
      const result = JSON.parse(line)
      if (result?.executable === executable) return validatePreparedExecutable(result, executable)
    } catch {
      // npm can print unrelated output; continue looking for the resolver record.
    }
  }
  throw new Error(`${executable} package did not expose a runnable npm executable shim`)
}

function replacePath(environment, pathValue, platform) {
  const next = { ...(environment || process.env) }
  const existingKeys = Object.keys(next).filter((key) => key.toLowerCase() === 'path')
  const pathKey = existingKeys[0] || (platform === 'win32' ? 'Path' : 'PATH')
  for (const key of existingKeys) {
    if (key !== pathKey) delete next[key]
  }
  next[pathKey] = pathValue
  return next
}

export async function prepareRuntimeExecutableEnvironment({
  executable, packageSpec = executable, environment = process.env,
  find, resolve, probe, cacheDir, platform = process.platform,
}) {
  let descriptor
  try {
    descriptor = await find(executable, environment)
    await probe(descriptor, environment)
  } catch (error) {
    const missingEntry = error.code === 78 && String(error.stderr || '').split(/\r?\n/)
      .includes(`unable to resolve npm executable shim: ${executable}`)
    if (!missingEntry && !isMissingCachedModule(error, cacheDir, platform)) throw error
    descriptor = await resolve(packageSpec, executable, { env: environment })
  }
  return replacePath(environment, descriptor.pathValue, platform)
}

function mergePreparedEnvironment(environment, descriptor, platform) {
  const next = replacePath(environment, descriptor.pathValue, platform)
  for (const [key, value] of Object.entries(descriptor.environment)) {
    for (const existingKey of Object.keys(next)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) delete next[existingKey]
    }
    next[key] = value
  }
  return next
}

// Adapted from the escaping used by @npmcli/promise-spawn for cmd.exe. User
// arguments need two escaping passes because a generated .cmd shim adds a
// second cmd.exe parsing layer.
function escapeCmdArgument(input, doubleEscape = false) {
  const value = String(input)
  if (!value.length) return '""'
  let result
  if (!/[ \t\n\v"]/.test(value)) {
    result = value
  } else {
    result = '"'
    for (let index = 0; index <= value.length; index += 1) {
      let slashCount = 0
      while (value[index] === '\\') {
        index += 1
        slashCount += 1
      }
      if (index === value.length) {
        result += '\\'.repeat(slashCount * 2)
        break
      }
      if (value[index] === '"') {
        result += '\\'.repeat(slashCount * 2 + 1)
        result += value[index]
      } else {
        result += '\\'.repeat(slashCount)
        result += value[index]
      }
    }
    result += '"'
  }
  result = result.replace(/[ !%^&()<>|"]/g, '^$&')
  if (doubleEscape) result = result.replace(/[ !%^&()<>|"]/g, '^$&')
  return result
}

export function createPackageExecutableLauncher({
  materialize,
  spawnProcess = spawn,
  platform = process.platform,
  cacheDir,
  onCacheRecovery = () => {},
  checkCancelled = () => {},
  validate = async () => {},
} = {}) {
  if (typeof materialize !== 'function') throw new Error('materialize must be a function')
  const resolved = new Map()
  const packageTails = new Map()

  function resolve(packageSpec, executable, context = {}) {
    const key = JSON.stringify([packageSpec, executable])
    const existing = resolved.get(key)
    if (existing) return existing

    const previous = packageTails.get(packageSpec) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const prepare = async options => {
        const descriptor = validatePreparedExecutable(await materialize(packageSpec, executable, options), executable)
        await validate(descriptor, options)
        return descriptor
      }
      let value
      const isDamaged = (error, directory) => {
        const missingEntry = String(error.stderr || '').split(/\r?\n/)
          .includes(`unable to resolve npm executable shim: ${executable}`)
        return (error.code === 78 && missingEntry) || isMissingCachedModule(error, directory, platform)
      }
      try {
        value = await prepare(context)
      } catch (error) {
        // Only our resolver's explicit missing-entry result permits recovery.
        // Do not retry npm download/auth failures, cancellation, or business code.
        if (!cacheDir || !isDamaged(error, cacheDir)) throw error
        value = await recoverPackageCache({cacheDir,packageSpec,signal:context.signal,isDamaged,checkCancelled,
          prepare:npmCacheDir=>prepare({...context,npmCacheDir}),
          onRecovery:npmCacheDir=>onCacheRecovery({packageSpec,executable,npmCacheDir}),
        })
      }
      return validatePreparedExecutable(value, executable)
    })
    packageTails.set(packageSpec, pending)
    resolved.set(key, pending)
    pending.then(
      () => {
        if (packageTails.get(packageSpec) === pending) packageTails.delete(packageSpec)
      },
      () => {
        if (resolved.get(key) === pending) resolved.delete(key)
        if (packageTails.get(packageSpec) === pending) packageTails.delete(packageSpec)
      },
    )
    return pending
  }

  function launchPrepared({ preparedExecutable, args = [], spawnOptions = {} }) {
    const descriptor = validatePreparedExecutable(preparedExecutable)
    const options = {
      ...spawnOptions,
      env: mergePreparedEnvironment(spawnOptions.env, descriptor, platform),
      shell: false,
    }
    if (descriptor.kind === 'direct') {
      return spawnProcess(descriptor.command, args, options)
    }
    if (platform !== 'win32') {
      throw new Error(`${descriptor.executable} resolved a Windows command shim on ${platform}`)
    }
    const commandShell = Object.entries(options.env)
      .find(([key]) => key.toLowerCase() === 'comspec')?.[1] || 'cmd.exe'
    const script = [
      escapeCmdArgument(descriptor.command),
      ...args.map((argument) => escapeCmdArgument(argument, true)),
    ].join(' ')
    return spawnProcess(commandShell, ['/d', '/s', '/c', script], {
      ...options,
      windowsVerbatimArguments: true,
    })
  }

  async function launch({
    packageSpec,
    executable,
    args = [],
    context = {},
    spawnOptions = {},
    preparedExecutable,
  }) {
    const descriptor = preparedExecutable || await resolve(packageSpec, executable, context)
    return launchPrepared({ preparedExecutable: descriptor, args, spawnOptions })
  }

  return { launch, launchPrepared, resolve }
}
