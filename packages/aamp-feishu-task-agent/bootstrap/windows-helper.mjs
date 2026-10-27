import {taskCommand} from '../bin/platform-hints.mjs'
import {runWindowsAuthLogin} from './windows-auth-login.mjs'
import {
  access,
  mkdir,
  rm,
  writeFile,
  readFile,
  realpath,
  rename,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import defaults from './task-agent-defaults.json' with { type: 'json' }
import { resolveTaskAgentMetadata } from '../bin/agent-metadata.mjs'
import {discoverWindowsAgents, prepareWindowsNativeAgent, ensureWindowsAgentLogin, ensureWindowsCodexUpdated} from './windows-agents.mjs'
import {warnInvalidAgentPath} from './windows-agent-path-warning.mjs'
import {findUserCodexCli} from './windows-codex-discovery.mjs'
import {ensureCodexAdapter} from './windows-codex-adapter.mjs'
import {startupProgress} from '../bin/startup-progress.mjs'
import {resolveWindowsNpmPrefix} from './windows-runtime-paths.mjs'
import { registerFeishuApp, defaultOpenUrl } from './register-feishu-app.mjs'
import { withWindowsOperationLock } from '../bin/windows-operation-lock.mjs'
import {
  resolveNativeCommand,
  ensurePrivateWindowsDirectory,
  atomicReplaceWindows,
} from '../bin/windows-platform.mjs'

const wrapperPath = fileURLToPath(
  new URL('../bin/windows-agent-wrapper.mjs', import.meta.url),
)
const supportedActions = new Set([
  '__discover-agents',
  '__register-binding',
  '__prepare-agent',
  '__probe-profile',
  '__ensure-profile',
])
const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`
const envValue = (env, key, fallback = '') =>
  env[key] ?? process.env[key] ?? fallback

export function mergeHelperEnvironment(overrides = {}, inherited = process.env) {
  const windows = process.platform === 'win32' || overrides.AAMP_WINDOWS_TEST_PLATFORM === 'win32'
  const result = {}
  for (const [key, value] of [...Object.entries(inherited), ...Object.entries(overrides)]) {
    if (windows) {
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete result[existing]
      }
    }
    result[key] = value
  }
  return result
}
async function exists(file) {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
async function readable(file) {
  try {
    await access(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}
function command(env, key, name) {
  return envValue(env, key) || name
}
function run(commandName, args, { env, input, stdio = 'pipe', timeout, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const descriptor =
      typeof commandName === 'string'
        ? { command: commandName, argsPrefix: [] }
        : commandName
    const child = spawn(
      descriptor.command,
      [...(descriptor.argsPrefix || []), ...args],
      {
        env: mergeHelperEnvironment(env),
        stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    )
    let timedOut = false
    const timer = timeout ? setTimeout(() => {timedOut = true; child.kill('SIGKILL')}, timeout) : undefined
    child.once('error', () => clearTimeout(timer))
    child.once('close', () => clearTimeout(timer))
    let stdout = '',
      stderr = ''
    if (stdio !== 'inherit') {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c) => (stdout += c))
      child.stderr.on('data', (c) => (stderr += c))
      if (input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    }
    child.once('error', reject)
    child.once('close', (code) =>
      !timedOut && allowedExitCodes.includes(code)
        ? resolve({ stdout, stderr })
        : reject(Object.assign(new Error(timedOut ? 'command timed out' : `command failed (${code}): ${stderr.trim()}`), {code: timedOut ? 'ETIMEDOUT' : code})),
    )
  })
}
function validateBinding(binding, secret = false) {
  const metadata = resolveTaskAgentMetadata(binding?.agent_type)
  const bot = binding?.bot || {}
  if (
    metadata.executionLocation === 'remote' ||
    binding.execution_location === 'remote'
  )
    throw new Error('remote bindings do not use lark-cli profiles')
  if (!bot.app_id || !bot.lark_cli_profile || (secret && !bot.app_secret))
    throw new Error('binding is missing Feishu credentials or profile')
  return bot
}
function authSettings(env) {
  const mode = envValue(env, 'FEISHU_USER_AUTH_MODE', defaults.userAuth.mode)
  if (!['optional', 'required', 'disabled'].includes(mode))
    throw new Error(
      'FEISHU_USER_AUTH_MODE must be optional, required, or disabled',
    )
  const explicitRequired = envValue(env, 'FEISHU_USER_AUTH_REQUIRED_SCOPES')
  const core =
    explicitRequired ||
    envValue(
      env,
      'FEISHU_USER_AUTH_CORE_SCOPES',
      defaults.scopeManifest.userAuth.core.join(' '),
    )
  const optional = envValue(
    env,
    'FEISHU_USER_AUTH_OPTIONAL_SCOPES',
    defaults.scopeManifest.userAuth.optional.join(' '),
  )
  const requested = envValue(
    env,
    'FEISHU_USER_AUTH_REQUESTED_SCOPES',
    explicitRequired || `${core} ${optional}`.trim(),
  )
  const excludes = envValue(
    env,
    'FEISHU_USER_AUTH_EXCLUDES',
    defaults.userAuth.excludes.join(' '),
  )
  return {
    mode,
    core,
    optional,
    requested,
    excludes: splitScopes(excludes)
      .filter((scope) => splitScopes(requested).includes(scope))
      .join(','),
  }
}
const splitScopes = (value) => [
  ...new Set(
    String(value || '')
      .split(/[\s,]+/)
      .filter(Boolean),
  ),
]
function hasScopes(status, requested) {
  const needed = String(requested)
    .split(/[\s,]+/)
    .filter(Boolean)
  const identity = status?.identities?.user
  if (
    !identity?.available ||
    !['valid', 'needs_refresh'].includes(identity.tokenStatus)
  )
    return false
  const actual = new Set(
    String(identity.scope || '')
      .split(/[\s,]+/)
      .filter(Boolean),
  )
  return needed.every((scope) => actual.has(scope))
}
async function profileReady(cli, profile, env) {
  const list = JSON.parse(
    (await run(cli, ['profile', 'list'], { env })).stdout || '[]',
  )
  if (
    !Array.isArray(list) ||
    !list.some((entry) =>
      typeof entry === 'string' ? entry === profile : entry?.name === profile,
    )
  ) return false
  const auth = authSettings(env)
  if (auth.mode === 'disabled') return true
  const excluded = new Set(splitScopes(auth.excludes))
  const required = splitScopes(auth.mode === 'required' ? auth.requested : auth.core)
  if (!required.length) return true
  const scopes = required.filter((scope) => !excluded.has(scope)).join(' ')
  try {
    return hasScopes(
      parseJsonOutput(
        (
          await run(cli, ['--profile', profile, 'auth', 'status', '--json'], {
            env,
          })
        ).stdout,
      ),
      scopes,
    )
  } catch {
    return false
  }
}
async function npxLaunch(extraEnv) {
  const explicitJs = envValue(extraEnv, 'AAMP_NPX_CLI_JS')
  if (explicitJs && (await readable(explicitJs)))
    return { command: process.execPath, args: [explicitJs] }
  const installed = path.resolve(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js',
  )
  if (await readable(installed))
    return { command: process.execPath, args: [installed] }
  const explicitBin = envValue(extraEnv, 'AAMP_NPX_CLI_BIN')
  if (explicitBin) return { command: explicitBin, args: [] }
  if (
    process.platform === 'win32' ||
    extraEnv.AAMP_WINDOWS_TEST_PLATFORM === 'win32'
  ) {
    const resolved = await resolveNativeCommand('npx', {
      platform: 'win32',
      env: mergeHelperEnvironment(extraEnv),
    })
    return { command: resolved.command, args: resolved.argsPrefix }
  }
  return { command: 'npx', args: [] }
}
async function npmLaunch(extraEnv) {
  const explicitJs = envValue(extraEnv, 'AAMP_NPM_CLI_JS')
  if (explicitJs && (await readable(explicitJs)))
    return { command: process.execPath, args: [explicitJs] }
  const installed = path.resolve(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  if (await readable(installed))
    return { command: process.execPath, args: [installed] }
  if (
    process.platform === 'win32' ||
    extraEnv.AAMP_WINDOWS_TEST_PLATFORM === 'win32'
  ) {
    const resolved = await resolveNativeCommand('npm', {
      platform: 'win32',
      env: mergeHelperEnvironment(extraEnv),
    })
    return { command: resolved.command, args: resolved.argsPrefix }
  }
  return { command: 'npm', args: [] }
}
async function nativeExecutable(name, explicit, env) {
  const windows =
    process.platform === 'win32' || env.AAMP_WINDOWS_TEST_PLATFORM === 'win32'
  let descriptor
  if (explicit) {
    if (!(await readable(explicit))) return ''
    if (/\.(?:c?js|mjs)$/i.test(explicit))
      descriptor = { command: process.execPath, argsPrefix: [explicit] }
    else if (/\.cmd$/i.test(explicit)) {
      try {
        descriptor = await resolveNativeCommand(path.basename(explicit), {
          platform: 'win32',
          env: { PATH: path.dirname(explicit) },
        })
      } catch {
        return ''
      }
    } else if (!/\.(?:bat|ps1)$/i.test(explicit) && (await exists(explicit)))
      return explicit
  } else if (windows) {
    try {
      descriptor = await resolveNativeCommand(name, { platform: 'win32', env })
    } catch {
      return ''
    }
  }
  if (!descriptor) return ''
  if (!descriptor.argsPrefix.length)
    return /\.(?:bat|cmd|ps1)$/i.test(descriptor.command)
      ? ''
      : descriptor.command
  if (name !== 'codex') return ''
  // CODEX_PATH is consumed by the pinned ACP adapter as an executable, not a command descriptor.
  // Follow the installed @openai/codex package and its declared platform dependency.
  const entry = await realpath(descriptor.argsPrefix[0])
  let directory = path.dirname(entry)
  while (directory !== path.dirname(directory)) {
    let metadata
    try {
      metadata = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      )
    } catch {}
    if (metadata?.name === '@openai/codex') {
      const bin =
        typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.codex
      if (
        !bin ||
        (await realpath(path.resolve(directory, bin)).catch(() => '')) !== entry
      )
        return ''
      const architecture = env.AAMP_WINDOWS_TEST_ARCH || process.arch
      const triple =
        architecture === 'x64'
          ? 'x86_64-pc-windows-msvc'
          : architecture === 'arm64'
            ? 'aarch64-pc-windows-msvc'
            : ''
      if (!triple) return ''
      const packageName = `@openai/codex-win32-${architecture}`
      const roots = [directory]
      if (metadata.optionalDependencies?.[packageName]) {
        try {
          roots.unshift(
            path.dirname(
              createRequire(path.join(directory, 'package.json')).resolve(
                `${packageName}/package.json`,
              ),
            ),
          )
        } catch {}
      }
      for (const root of roots) {
        // Current npm layout uses bin; older bundled vendor distributions use codex.
        for (const subdirectory of ['bin', 'codex']) {
          const executable = path.join(
            root,
            'vendor',
            triple,
            subdirectory,
            'codex.exe',
          )
          if (await exists(executable)) return executable
        }
      }
      return ''
    }
    directory = path.dirname(directory)
  }
  return ''
}
export function versionAtLeast(actual, minimum) {
  const parsed = String(actual).match(/\d+(?:\.\d+){0,2}/)?.[0]
  if (!parsed) return false
  const left = parsed.split('.').map(Number)
  const right = minimum.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] || 0) !== (right[index] || 0))
      return (left[index] || 0) > (right[index] || 0)
  }
  return true
}

export async function resolveWindowsCodexCli(env, {findUserCodex = findUserCodexCli} = {}) {
  const explicit = env.AAMP_CODEX_CLI_BIN || ''
  const resolved = await nativeExecutable('codex', explicit, env)
  if (explicit && !resolved) await warnInvalidAgentPath('AAMP_CODEX_CLI_BIN',explicit)
  if (resolved || explicit) return resolved
  return findUserCodex(env)
}

async function resolveLarkCli(extraEnv, env, { install = false } = {}) {
  const explicit = envValue(extraEnv, 'AAMP_LARK_CLI_BIN')
  const prefix = resolveWindowsNpmPrefix({
    NPM_GLOBAL_PREFIX: envValue(extraEnv,'NPM_GLOBAL_PREFIX',null),
    AAMP_TASK_NPM_GLOBAL_PREFIX: envValue(extraEnv,'AAMP_TASK_NPM_GLOBAL_PREFIX',null),
    AAMP_TASK_RUNTIME_HOME: envValue(extraEnv,'AAMP_TASK_RUNTIME_HOME',null),
  })
  const minimum = envValue(extraEnv, 'LARK_CLI_MIN_VERSION', defaults.larkCli.minVersion)
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const searchEnv = {
    ...env,
    [pathKey]: `${prefix};${path.join(prefix, 'bin')};${env[pathKey] || ''}`,
  }
  let descriptor
  if (
    explicit &&
    (await (/\.(?:c?js|mjs)$/i.test(explicit)
      ? readable(explicit)
      : exists(explicit)))
  )
    descriptor = /\.(?:c?js|mjs)$/i.test(explicit)
      ? {
          command: process.execPath,
          argsPrefix: [explicit],
          reported: explicit,
        }
      : { command: explicit, argsPrefix: [], reported: explicit }
  else if (
    process.platform === 'win32' ||
    extraEnv.AAMP_WINDOWS_TEST_PLATFORM === 'win32'
  ) {
    try {
      const value = await resolveNativeCommand('lark-cli', {
        platform: 'win32',
        env: searchEnv,
      })
      descriptor = { ...value, reported: value.argsPrefix[0] || value.command }
    } catch {}
  }
  if (descriptor) {
    try {
      const version = (await run(descriptor, ['--version'], { env })).stdout
      if (versionAtLeast(version, minimum))
        return descriptor
    } catch {}
  }
  if (!install) return undefined
  if (envValue(extraEnv, 'AAMP_TASK_NON_INTERACTIVE') === 'true')
    throw new Error(
      `后台服务无法安装缺失的 lark-cli（查找目录：${prefix}，同时检查 PATH）；请在终端执行 ${taskCommand('start', 'win32')} 完成准备。`,
    )
  if (explicit)
    throw new Error(
      `AAMP_LARK_CLI_BIN does not point to lark-cli >= ${minimum}: ${explicit}`,
    )
  await mkdir(prefix, { recursive: true })
  const npm = await npmLaunch(extraEnv)
  await run(
    npm.command,
    [
      ...npm.args,
      'install',
      '--global',
      '--prefix',
      prefix,
      defaults.larkCli.package,
    ],
    { env, stdio: 'inherit' },
  )
  const nextEnv = searchEnv
  const value = await resolveNativeCommand('lark-cli', {
    platform: 'win32',
    env: nextEnv,
  })
  const ready = { ...value, reported: value.argsPrefix[0] || value.command }
  const version = (await run(ready, ['--version'], { env: nextEnv })).stdout
  if (!versionAtLeast(version, minimum))
    throw new Error(
      `failed to select lark-cli >= ${minimum} after isolated install`,
    )
  return ready
}
async function materializeRegisterSdk(extraEnv) {
  const explicit = envValue(extraEnv, 'AAMP_REGISTER_APP_SDK_MODULE')
  if (explicit) return import(pathToFileURL(explicit))
  const runtime = envValue(
    extraEnv,
    'AAMP_TASK_RUNTIME_HOME',
    path.join(homedir(), '.aamp', 'feishu-task-agent'),
  )
  const sdkPackage = envValue(extraEnv, 'LARK_REGISTER_APP_SDK', defaults.packages.registerAppSdk)
  const prefix = path.join(runtime, 'register-sdk', Buffer.from(sdkPackage).toString('base64url'))
  const require = createRequire(path.join(prefix, 'package.json'))
  try {
    return await import(
      pathToFileURL(require.resolve('@larksuiteoapi/node-sdk'))
    )
  } catch {}
  if (envValue(extraEnv, 'AAMP_TASK_NON_INTERACTIVE') === 'true')
    throw new Error(`后台服务无法安装注册 SDK；请在终端执行 ${taskCommand('start', 'win32')} 完成准备。`)
  await mkdir(prefix, { recursive: true })
  const launcher = await npmLaunch(extraEnv)
  await run(
    launcher.command,
    [
      ...launcher.args,
      'install',
      '--no-save',
      '--ignore-scripts',
      '--prefix',
      prefix,
      sdkPackage,
    ],
    { env: extraEnv, stdio: 'inherit' },
  )
  return import(pathToFileURL(require.resolve('@larksuiteoapi/node-sdk')))
}
async function readRequiredTenantKey(cli, profile, env) {
  const args = [
    '--profile',
    profile,
    'api',
    'GET',
    '/open-apis/authen/v1/user_info',
    '--as',
    'user',
    '--format',
    'json',
  ]
  const parse = (output) => {
    const start = output.indexOf('{')
    const value =
      start < 0 ? undefined : JSON.parse(output.slice(start))?.data?.tenant_key
    if (typeof value !== 'string' || !value.trim())
      throw new Error('lark-cli user identity did not return a tenant key')
    return value.trim()
  }
  try {
    return parse((await run(cli, args, { env })).stdout)
  } catch {}
  if (envValue(env, 'AAMP_TASK_NON_INTERACTIVE') === 'true')
    throw new Error(
      `后台服务无法完成交互式准备。请在终端执行 ${taskCommand('start', 'win32')} 完成登录后重试。`,
    )
  const auth = authSettings(env)
  const loginArgs = [
    '--profile',
    profile,
    'auth',
    'login',
    '--scope',
    auth.requested,
  ]
  if (auth.excludes) loginArgs.push('--exclude', auth.excludes)
  await runWindowsAuthLogin(cli, loginArgs, { env: mergeHelperEnvironment(env) })
  return parse((await run(cli, args, { env })).stdout)
}
async function withProfileLock(env, operation) {
  const lock = envValue(
    env,
    'LARK_CLI_CONFIG_LOCK_DIR',
    path.join(env.LARKSUITE_CLI_CONFIG_DIR, '.aamp-profile.lock'),
  )
  return withWindowsOperationLock(lock, operation)
}

function parseJsonOutput(output) {
  const start = String(output).indexOf('{')
  if (start < 0) throw new Error('CLI response did not contain JSON')
  return JSON.parse(output.slice(start))
}

async function persistCapabilitySnapshot(cli, profile, env) {
  try {
    let status = {}
    try {
      status = parseJsonOutput(
        (
          await run(cli, ['--profile', profile, 'auth', 'status', '--json'], {
            env,
          })
        ).stdout,
      )
    } catch {}
    const auth = authSettings(env)
    const user = status?.identities?.user
    const granted = new Set(splitScopes(user?.scope))
    const missingCoreScopes = splitScopes(auth.core).filter(
      (scope) => !granted.has(scope),
    )
    const missingOptionalScopes = splitScopes(auth.optional).filter(
      (scope) => !granted.has(scope),
    )
    const usable =
      Boolean(user?.available) &&
      ['valid', 'needs_refresh'].includes(user?.tokenStatus)
    const snapshot = {
      schemaVersion: 1,
      manifestVersion: Number(
        envValue(
          env,
          'FEISHU_SCOPE_MANIFEST_VERSION',
          defaults.scopeManifest.version,
        ),
      ),
      profile,
      tokenStatus: user?.tokenStatus || 'missing',
      grantedScopes: [...granted],
      missingCoreScopes,
      missingOptionalScopes,
      capabilities: { task_user: usable && missingOptionalScopes.length === 0 },
      checkedAt: new Date().toISOString(),
    }
    const directory = envValue(
      env,
      'AAMP_FEISHU_AUTH_STATE_DIR',
      path.join(homedir(), '.aamp', 'feishu-bridge', 'auth-capabilities'),
    )
    if (process.platform === 'win32')
      await ensurePrivateWindowsDirectory(directory)
    else await mkdir(directory, { recursive: true })
    const destination = path.join(
      directory,
      `${String(profile || 'profile').replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
    )
    const temporary = `${destination}.${process.pid}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), {
        mode: 0o600,
      })
      if (process.platform === 'win32')
        await atomicReplaceWindows(temporary, destination)
      else await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  } catch {
    process.stderr.write(
      `warning: unable to persist optional user capability snapshot for profile: ${profile}\n`,
    )
  }
}

export async function runWindowsHelper(
  action,
  payload = {},
  extraEnv = {},
  options = {},
) {
  if (!supportedActions.has(action))
    throw new Error(`unknown Windows helper action: ${action}`)
  const env = {
    ...mergeHelperEnvironment(extraEnv),
    LARKSUITE_CLI_CONFIG_DIR: envValue(
      extraEnv,
      'AAMP_LARK_CLI_CONFIG_DIR',
      path.join(homedir(), defaults.larkCli.configDirName),
    ),
  }
  if (action === '__discover-agents') {
    return {agents: await discoverWindowsAgents(env, () => resolveWindowsCodexCli(env), run)}
  }
  if (action === '__register-binding') {
    if (envValue(extraEnv, 'AAMP_TASK_NON_INTERACTIVE') === 'true')
      throw new Error(`后台服务无法注册绑定；请在终端执行 ${taskCommand('start', 'win32')} 完成准备。`)
    const sdk = await materializeRegisterSdk(extraEnv)
    const registered = await registerFeishuApp({
      sdk,
      appName: payload.display_name || 'AAMP 飞书 CLI',
      tenantScopes: envValue(extraEnv, 'FEISHU_APP_SCOPES_TENANT') || defaults.scopeManifest.app.tenant,
      userScopes: envValue(extraEnv, 'FEISHU_APP_SCOPES_USER') || defaults.scopeManifest.app.user,
      tenantEvents: envValue(extraEnv, 'FEISHU_APP_EVENTS_TENANT') || defaults.events.tenant,
      userEvents: envValue(extraEnv, 'FEISHU_APP_EVENTS_USER') || defaults.events.user,
      openUrl:
        envValue(extraEnv, 'AAMP_TASK_TEST_NO_BROWSER') === 'true'
          ? undefined
          : defaultOpenUrl,
    })
    const profile =
      registered.tenant_brand === 'lark'
        ? `aamp-feishu-task-${registered.app_id}-lark`
        : `aamp-feishu-task-${registered.app_id}`
    const binding = {
      agent_type: 'codex',
      bot: {
        app_id: registered.app_id,
        app_secret: registered.app_secret,
        display_name: registered.app_name,
        tenant_brand: registered.tenant_brand,
        lark_cli_profile: profile,
      },
    }
    await runWindowsHelper('__ensure-profile', binding, extraEnv)
    const cli = await resolveLarkCli(extraEnv, env)
    const tenantKey = await readRequiredTenantKey(cli, profile, env)
    return {
      app_id: registered.app_id,
      app_secret: registered.app_secret,
      display_name: registered.app_name,
      tenant_brand: registered.tenant_brand,
      tenant_key: tenantKey,
      lark_cli_profile: profile,
      auth_mode: 'lark-cli',
    }
  }
  if (action === '__prepare-agent') {
    const type = String(
      (typeof payload === 'string' ? payload : payload.agent_type) || '',
    )
    const metadata = resolveTaskAgentMetadata(type)
    const runtime = envValue(extraEnv, 'AAMP_TASK_RUNTIME_HOME', path.join(homedir(), '.aamp', 'feishu-task-agent'))
    let config
    if (type === 'codex') {
      const progress = options.progress || (message => console.error(`[aamp-one-click] ${message}`))
      progress('Codex：正在查找 CLI 并检查版本...')
      let codex = await resolveWindowsCodexCli(env)
      if (!codex) throw new Error('codex CLI is unavailable')
      await ensureWindowsCodexUpdated(codex, env, {run, npmLaunch, ...options})
      codex = await resolveWindowsCodexCli(env)
      if (!codex) throw new Error('升级后未找到 Codex CLI')
      progress('Codex：正在检查登录状态...')
      await ensureWindowsAgentLogin(type, codex, env, run)
      const spec = envValue(extraEnv, 'AAMP_TASK_CODEX_ACP_PKG', defaults.packages.codexAcp)
      const entry = await (options.ensureCodexAdapter || ensureCodexAdapter)({
        root: envValue(extraEnv, 'AAMP_TASK_CODEX_ACP_HOME', path.join(runtime, 'codex-acp')), spec,
        install: async directory => {
          progress(`Codex：正在安装或重建适配器 ${spec}，最长等待 300 秒...`)
          const npm = await npmLaunch(extraEnv)
          const finishProgress=startupProgress('Codex：适配器安装中')
          try {
            await run(npm.command, [...npm.args, 'install', '--prefix', directory,
              '--no-audit', '--no-fund', '--ignore-scripts', spec], {env, timeout:300_000})
          } finally {finishProgress()}
        },
      })
      progress('Codex：适配器文件已就绪，接下来初始化 ACP 会话。')
      config = {command:process.execPath, args:[entry],env:{CODEX_PATH:codex}}
    } else {
      config = await prepareWindowsNativeAgent(type,env,{run,npmLaunch,...options})
      if (config.cancelled) return config
    }
    if (process.platform === 'win32') await ensurePrivateWindowsDirectory(runtime)
    else await mkdir(runtime, {recursive:true})
    const configPath = path.join(runtime, `windows-${type}-agent.json`)
    const temporary = `${configPath}.${process.pid}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(config), {mode:0o600})
      if (process.platform === 'win32') await atomicReplaceWindows(temporary,configPath)
      else await rename(temporary,configPath)
    } finally {await rm(temporary,{force:true})}
    const result = {
      agent_type: type,
      acp_command: `${quote(process.execPath)} ${quote(wrapperPath)} ${quote(configPath)}`,
    }
    if (metadata.executionLocation === 'local')
      result.lark_cli_config_dir = env.LARKSUITE_CLI_CONFIG_DIR
    return result
  }
  const bot = validateBinding(payload, action === '__ensure-profile')
  const protect =
    options.ensurePrivateDirectory ||
    (process.platform === 'win32' ? ensurePrivateWindowsDirectory : undefined)
  if (protect) await protect(env.LARKSUITE_CLI_CONFIG_DIR)
  const cli = await resolveLarkCli(extraEnv, env, {
    install: action === '__ensure-profile',
  })
  if (!cli) {
    if (action === '__probe-profile') return { ready: false }
    throw new Error(`lark-cli >= ${defaults.larkCli.minVersion} is unavailable`)
  }
  if (action === '__probe-profile') {
    const ready = await withProfileLock(env, () =>
      profileReady(cli, bot.lark_cli_profile, env),
    )
    if (ready) await persistCapabilitySnapshot(cli, bot.lark_cli_profile, env)
    return ready
      ? {
          ready: true,
          lark_cli_bin: cli.reported || cli.command,
          lark_cli_config_dir: env.LARKSUITE_CLI_CONFIG_DIR,
        }
      : { ready: false }
  }
  return withProfileLock(env, async () => {
    if (
      !(await profileReady(cli, bot.lark_cli_profile, {
        ...env,
        FEISHU_USER_AUTH_MODE: 'disabled',
      }))
    )
      await run(
        cli,
        [
          'profile',
          'add',
          '--name',
          bot.lark_cli_profile,
          '--app-id',
          bot.app_id,
          '--brand',
          bot.tenant_brand || 'feishu',
          '--app-secret-stdin',
        ],
        { env, input: `${bot.app_secret}\n` },
      )
    const auth = authSettings(env)
    if (auth.mode !== 'disabled') {
      const required = auth.mode === 'required' ? auth.requested : auth.core
      if (
        required &&
        !(await profileReady(cli, bot.lark_cli_profile, {
          ...env,
          FEISHU_USER_AUTH_MODE: 'required',
          FEISHU_USER_AUTH_REQUESTED_SCOPES: required,
        }))
      ) {
        if (envValue(extraEnv, 'AAMP_TASK_NON_INTERACTIVE') === 'true')
          throw new Error(
            `后台服务无法完成交互式准备。请在终端执行 ${taskCommand('start', 'win32')} 完成授权后重试。`,
          )
        const loginArgs = [
          '--profile',
          bot.lark_cli_profile,
          'auth',
          'login',
          '--scope',
          auth.requested,
        ]
        if (auth.excludes) loginArgs.push('--exclude', auth.excludes)
        await runWindowsAuthLogin(cli, loginArgs, { env: mergeHelperEnvironment(env) })
        if (
          !(await profileReady(cli, bot.lark_cli_profile, {
            ...env,
            FEISHU_USER_AUTH_MODE: 'required',
            FEISHU_USER_AUTH_REQUESTED_SCOPES: required,
          }))
        )
          throw new Error(
            'lark-cli user authorization did not grant the required scopes',
          )
      }
    }
    await persistCapabilitySnapshot(cli, bot.lark_cli_profile, env)
    return {
      lark_cli_bin: cli.reported || cli.command,
      lark_cli_config_dir: env.LARKSUITE_CLI_CONFIG_DIR,
    }
  })
}

if (process.send) {
  let handled = false
  process.on('message', async (message) => {
    if (handled) return
    handled = true
    try {
      if (message?.kind !== 'request')
        throw new Error('invalid Windows helper IPC request')
      process.send(
        {
          kind: 'result',
          payload: await runWindowsHelper(
            message.action,
            message.payload ?? {},
            process.env,
          ),
        },
        () => process.disconnect(),
      )
    } catch (error) {
      process.send(
        {
          kind: 'error',
          message:
            error instanceof Error ? error.message : 'Windows helper failed',
        },
        () => process.disconnect(),
      )
    }
  })
}
