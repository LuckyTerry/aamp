import readline from 'node:readline/promises'
import { stdin as input, stdout as output, argv, exit } from 'node:process'
import qrcodeTerminal from 'qrcode-terminal'
import {
  getBridgeHomeDir,
  initializeBridgeConfig,
  loadBridgeConfig,
  loadBridgeState,
  saveBridgeState,
} from './config.js'
import {
  pollQrStatus,
  startQrLogin,
  type WechatQrStatus,
} from './wechat-api.js'
import { WechatBridgeRuntime } from './runtime.js'
import type { BridgeConfig, BridgeState } from './types.js'

interface ParsedCliArgs {
  command: string
  configDir?: string
  options: Record<string, string | boolean>
}

function printUsage(): void {
  console.log([
    'Usage: aamp-wechat-bridge <command> [options]',
    '',
    'Commands:',
    '  init      Create or update local bridge config, login with QR code, then start',
    '  login     Start QR login and persist the WeChat bot token locally',
    '  start     Start the local WeChat bridge daemon',
    '  run       Alias for start',
    '  status    Show local config, login state, and target agent information',
    '',
    'Options:',
    '  --config-dir <path>   Override bridge config directory',
    '  --pairing-url <url>   Pair with an AAMP Agent URL during init',
    '  --no-start            Only write config; skip QR login and start',
    '  --json                Emit machine-readable JSON / JSONL',
    '',
    'Examples:',
    '  aamp-wechat-bridge init',
    '  aamp-wechat-bridge login',
    '  aamp-wechat-bridge start',
  ].join('\n'))
}

function jsonOutput(options: Record<string, string | boolean>): boolean {
  return options.json === true || options.output === 'json'
}

function writeJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  })}\n`)
}

function bridgeConfigSummary(config: BridgeConfig) {
  return {
    version: config.version,
    aampHost: config.aampHost,
    targetAgentEmail: config.targetAgentEmail,
    slug: config.slug,
    summary: config.summary,
    mailbox: {
      email: config.mailbox.email,
      baseUrl: config.mailbox.baseUrl,
    },
    wechat: config.wechat,
    behavior: config.behavior,
  }
}

function parseCliArgs(rawArgs: string[]): ParsedCliArgs {
  let command = 'start'
  let commandAssigned = false
  let configDir: string | undefined
  const options: Record<string, string | boolean> = {}

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]
    if (!commandAssigned && !token.startsWith('-')) {
      command = token
      commandAssigned = true
      continue
    }

    if (token === '-h') {
      options.help = true
      continue
    }

    if (token === '--config-dir') {
      const value = rawArgs[index + 1]
      if (!value) throw new Error('--config-dir requires a value')
      configDir = value
      index += 1
      continue
    }

    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = rawArgs[index + 1]
      if (!next || next.startsWith('--')) {
        options[key] = true
        continue
      }
      options[key] = next
      index += 1
      continue
    }
  }

  return { command, configDir, options }
}

async function requireConfig(configDir?: string): Promise<BridgeConfig> {
  const config = await loadBridgeConfig(configDir)
  if (!config) {
    throw new Error(`Bridge config not found at ${getBridgeHomeDir(configDir)}/config.json. Run \`aamp-wechat-bridge init\` first.`)
  }
  return config
}

function printQrCode(url: string): void {
  qrcodeTerminal.generate(url, { small: true })
  console.log(`扫码链接: ${url}`)
}

async function promptVerifyCode(): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const value = await rl.question('请输入微信返回的验证码: ')
    return value.trim()
  } finally {
    rl.close()
  }
}

async function waitForQrLogin(config: BridgeConfig, state: BridgeState): Promise<BridgeState> {
  const started = await startQrLogin({
    apiBaseUrl: config.wechat.apiBaseUrl,
    botType: config.wechat.botType,
    botAgent: config.wechat.botAgent,
  })

  console.log('请使用微信扫码登录。')
  printQrCode(started.qrCodeUrl)

  let currentBaseUrl = config.wechat.apiBaseUrl
  let pendingVerifyCode: string | undefined

  for (;;) {
    const status = await pollQrStatus({
      apiBaseUrl: currentBaseUrl,
      qrCode: started.qrCode,
      botAgent: config.wechat.botAgent,
      ...(pendingVerifyCode ? { verifyCode: pendingVerifyCode } : {}),
    })
    pendingVerifyCode = undefined

    if (status.status === 'wait') {
      continue
    }

    if (status.status === 'scaned') {
      console.log('二维码已扫描，请在手机上确认登录。')
      continue
    }

    if (status.status === 'scaned_but_redirect') {
      if (status.redirectHost) {
        currentBaseUrl = `https://${status.redirectHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
      }
      continue
    }

    if (status.status === 'need_verifycode') {
      pendingVerifyCode = await promptVerifyCode()
      continue
    }

    if (status.status === 'verify_code_blocked') {
      throw new Error('微信登录验证失败次数过多，请重新执行 `aamp-wechat-bridge login`。')
    }

    if (status.status === 'expired') {
      throw new Error('二维码已过期，请重新执行 `aamp-wechat-bridge login`。')
    }

    if (status.status === 'binded_redirect') {
      console.log('该微信账号已经绑定到当前本地 bridge，继续复用现有登录态。')
      return state
    }

    if (status.status === 'confirmed') {
      if (!status.botToken) {
        throw new Error('微信登录已确认，但没有返回 bot token。')
      }
      const accountId = status.ilinkUserId?.trim() || 'default'
      state.account = {
        accountId,
        token: status.botToken,
        baseUrl: status.baseUrl?.trim() || currentBaseUrl,
        ilinkUserId: status.ilinkUserId?.trim() || undefined,
        connectedAt: new Date().toISOString(),
      }
      state.lastLoginAt = new Date().toISOString()
      return state
    }

    const exhaustive: never = status.status
    throw new Error(`Unexpected QR login state: ${exhaustive}`)
  }
}

async function waitForQrLoginJson(config: BridgeConfig, state: BridgeState): Promise<BridgeState> {
  const started = await startQrLogin({
    apiBaseUrl: config.wechat.apiBaseUrl,
    botType: config.wechat.botType,
    botAgent: config.wechat.botAgent,
  })

  writeJsonEvent({
    type: 'wechat.qr.created',
    bridge: 'wechat-bridge',
    qrCode: started.qrCode,
    qrCodeUrl: started.qrCodeUrl,
  })

  let currentBaseUrl = config.wechat.apiBaseUrl
  for (;;) {
    const status = await pollQrStatus({
      apiBaseUrl: currentBaseUrl,
      qrCode: started.qrCode,
      botAgent: config.wechat.botAgent,
    })

    writeJsonEvent({
      type: 'wechat.qr.status',
      bridge: 'wechat-bridge',
      status: status.status,
      ...(status.redirectHost ? { redirectHost: status.redirectHost } : {}),
      ...(status.baseUrl ? { baseUrl: status.baseUrl } : {}),
      ...(status.ilinkUserId ? { accountId: status.ilinkUserId } : {}),
    })

    if (status.status === 'wait' || status.status === 'scaned') {
      continue
    }

    if (status.status === 'scaned_but_redirect') {
      if (status.redirectHost) {
        currentBaseUrl = `https://${status.redirectHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
      }
      continue
    }

    if (status.status === 'need_verifycode') {
      throw new Error('微信登录需要验证码，请暂时使用 `aamp-wechat-bridge login` 完成。')
    }

    if (status.status === 'verify_code_blocked') {
      throw new Error('微信登录验证失败次数过多，请重新开始登录。')
    }

    if (status.status === 'expired') {
      throw new Error('二维码已过期，请重新开始登录。')
    }

    if (status.status === 'binded_redirect') {
      writeJsonEvent({
        type: 'wechat.login.completed',
        bridge: 'wechat-bridge',
        reused: true,
      })
      return state
    }

    if (status.status === 'confirmed') {
      if (!status.botToken) {
        throw new Error('微信登录已确认，但没有返回 bot token。')
      }
      const accountId = status.ilinkUserId?.trim() || 'default'
      state.account = {
        accountId,
        token: status.botToken,
        baseUrl: status.baseUrl?.trim() || currentBaseUrl,
        ilinkUserId: status.ilinkUserId?.trim() || undefined,
        connectedAt: new Date().toISOString(),
      }
      state.lastLoginAt = new Date().toISOString()
      writeJsonEvent({
        type: 'wechat.login.completed',
        bridge: 'wechat-bridge',
        accountId,
        baseUrl: state.account.baseUrl,
      })
      return state
    }

    const exhaustive: never = status.status
    throw new Error(`Unexpected QR login state: ${exhaustive}`)
  }
}

async function handleInit(configDir?: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const config = await initializeBridgeConfig({
    configDir,
    aampHost: typeof options.aampHost === 'string' ? options.aampHost : undefined,
    targetAgentEmail: typeof options.targetAgentEmail === 'string'
      ? options.targetAgentEmail
      : typeof options['target-agent'] === 'string'
        ? options['target-agent']
        : undefined,
    pairingUrl: typeof options.pairingUrl === 'string'
      ? options.pairingUrl
      : typeof options['pairing-url'] === 'string'
        ? options['pairing-url']
        : undefined,
    slug: typeof options.slug === 'string' ? options.slug : undefined,
    summary: typeof options.summary === 'string' ? options.summary : undefined,
    botAgent: typeof options.botAgent === 'string' ? options.botAgent : undefined,
    dispatchTimeoutMs: typeof options.dispatchTimeoutMs === 'string' ? Number(options.dispatchTimeoutMs) : undefined,
    pollTimeoutMs: typeof options.pollTimeoutMs === 'string' ? Number(options.pollTimeoutMs) : undefined,
  })

  if (jsonOutput(options)) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      type: 'init.completed',
      bridge: 'wechat-bridge',
      configDir: getBridgeHomeDir(configDir),
      config: bridgeConfigSummary(config),
      loginRequired: true,
    }, null, 2))
    return
  }
  console.log(`Bridge config saved to ${getBridgeHomeDir(configDir)}/config.json`)
  console.log(`Mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
  if (options['no-start'] === true) {
    console.log('Bridge not started because --no-start was provided.')
    return
  }

  const state = await loadBridgeState(configDir)
  const nextState = await waitForQrLogin(config, state)
  await saveBridgeState(nextState, configDir)
  console.log(`微信登录成功，账号标识: ${nextState.account?.accountId ?? 'default'}`)
  await handleRun(configDir)
}

async function handleLogin(configDir?: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const config = await requireConfig(configDir)
  const state = await loadBridgeState(configDir)
  const nextState = jsonOutput(options)
    ? await waitForQrLoginJson(config, state)
    : await waitForQrLogin(config, state)
  await saveBridgeState(nextState, configDir)
  if (jsonOutput(options)) return
  console.log(`微信登录成功，账号标识: ${nextState.account?.accountId ?? 'default'}`)
}

async function handleRun(configDir?: string): Promise<void> {
  const config = await requireConfig(configDir)
  const state = await loadBridgeState(configDir)
  if (!state.account?.token) {
    throw new Error('尚未登录微信，请先执行 `aamp-wechat-bridge login`。')
  }

  const runtime = new WechatBridgeRuntime(config, {
    configDir,
    logger: console,
  })

  const shutdown = async () => {
    await runtime.stop().catch(() => {})
    exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })

  console.log(`WeChat bridge is running for ${config.targetAgentEmail}`)
  console.log(`Mailbox: ${config.mailbox.email}`)
  await runtime.start()
}

async function handleRunWithOptions(configDir: string | undefined, options: Record<string, string | boolean>): Promise<void> {
  if (!jsonOutput(options)) {
    await handleRun(configDir)
    return
  }

  const config = await requireConfig(configDir)
  const state = await loadBridgeState(configDir)
  if (!state.account?.token) {
    writeJsonEvent({
      type: 'bridge.blocked',
      bridge: 'wechat-bridge',
      reason: 'login_required',
      targetAgentEmail: config.targetAgentEmail,
      mailbox: config.mailbox.email,
    })
    throw new Error('尚未登录微信，请先执行 `aamp-wechat-bridge login`。')
  }

  const runtime = new WechatBridgeRuntime(config, {
    configDir,
    logger: console,
  })

  const shutdown = async () => {
    writeJsonEvent({ type: 'bridge.shutdown', bridge: 'wechat-bridge', reason: 'signal' })
    await runtime.stop().catch(() => {})
    writeJsonEvent({ type: 'bridge.stopped', bridge: 'wechat-bridge' })
    exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })

  writeJsonEvent({
    type: 'bridge.starting',
    bridge: 'wechat-bridge',
    targetAgentEmail: config.targetAgentEmail,
    mailbox: config.mailbox.email,
  })
  await runtime.start()
  writeJsonEvent({
    type: 'bridge.running',
    bridge: 'wechat-bridge',
    targetAgentEmail: config.targetAgentEmail,
    mailbox: config.mailbox.email,
  })
}

async function handleStatus(configDir?: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const config = jsonOutput(options) ? await loadBridgeConfig(configDir) : await requireConfig(configDir)
  const state = await loadBridgeState(configDir)
  if (jsonOutput(options)) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      bridge: 'wechat-bridge',
      configDir: getBridgeHomeDir(configDir),
      config: config ? bridgeConfigSummary(config) : null,
      state: {
        loggedIn: Boolean(state.account?.token),
        accountId: state.account?.accountId,
        lastLoginAt: state.lastLoginAt ?? state.account?.connectedAt,
        lastStartedAt: state.lastStartedAt,
        lastStoppedAt: state.lastStoppedAt,
        lastError: state.lastError,
        conversations: Object.keys(state.conversations).length,
        tasks: Object.keys(state.tasks).length,
      },
    }, null, 2))
    return
  }
  if (!config) return
  console.log([
    `Bridge home: ${getBridgeHomeDir(configDir)}`,
    `AAMP host: ${config.aampHost}`,
    `Target agent: ${config.targetAgentEmail}`,
    `Mailbox: ${config.mailbox.email}`,
    `WeChat API base: ${config.wechat.apiBaseUrl}`,
    `Bot agent: ${config.wechat.botAgent}`,
    `Logged in: ${state.account?.token ? 'yes' : 'no'}`,
    ...(state.account?.token ? [
      `WeChat account: ${state.account.accountId}`,
      `Login base URL: ${state.account.baseUrl}`,
      `Last login: ${state.lastLoginAt ?? state.account.connectedAt}`,
    ] : []),
  ].join('\n'))
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(argv.slice(2))
  if (parsed.options.help) {
    printUsage()
    return
  }
  switch (parsed.command) {
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      return
    case 'init':
      await handleInit(parsed.configDir, parsed.options)
      return
    case 'login':
      await handleLogin(parsed.configDir, parsed.options)
      return
    case 'start':
    case 'run':
      await handleRunWithOptions(parsed.configDir, parsed.options)
      return
    case 'status':
      await handleStatus(parsed.configDir, parsed.options)
      return
    default:
      throw new Error(`Unknown command: ${parsed.command}`)
  }
}

main().catch((error: Error) => {
  const parsed = parseCliArgs(argv.slice(2))
  if (jsonOutput(parsed.options)) {
    writeJsonEvent({
      type: 'error',
      bridge: 'wechat-bridge',
      message: error.message,
    })
  } else {
    console.error(error.message)
  }
  exit(1)
})
