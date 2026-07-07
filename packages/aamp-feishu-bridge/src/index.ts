#!/usr/bin/env node

import { inspect } from 'node:util'
import {
  ensureBridgeHomeDir,
  getBridgeHomeDir,
  getBridgeInstanceDir,
  initializeBridgeConfig,
  loadBridgeConfigEntries,
  loadBridgeState,
  removeBridgeConfigEntry,
} from './config.js'
import { FeishuBridgeRuntime } from './runtime.js'
import { runTaskEnabledBridge } from './task-runtime.js'

type CommandName = 'init' | 'start' | 'run' | 'status' | 'remove' | 'unbind' | 'help' | 'unknown'

interface ParsedArgs {
  command: CommandName
  values: Record<string, string[]>
  booleans: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...tail] = argv
  const hasCommand = rawCommand !== undefined && !rawCommand.startsWith('-')
  const command = (hasCommand ? rawCommand : 'start') as CommandName
  const rest = hasCommand ? tail : argv
  const values: Record<string, string[]> = {}
  const booleans = new Set<string>()

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '-h') {
      booleans.add('help')
      continue
    }
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 2) {
      const key = token.slice(2, eq)
      const value = token.slice(eq + 1)
      values[key] = [...(values[key] ?? []), value]
      continue
    }
    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      booleans.add(key)
      continue
    }
    values[key] = [...(values[key] ?? []), next]
    index += 1
  }

  return { command, values, booleans }
}

function firstArg(args: ParsedArgs, key: string): string | undefined {
  return args.values[key]?.[0]
}

function jsonOutput(args: ParsedArgs): boolean {
  return args.booleans.has('json') || firstArg(args, 'output') === 'json'
}

function writeJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  })}\n`)
}

function bridgeConfigSummary(config: Awaited<ReturnType<typeof initializeBridgeConfig>>) {
  const applinkHost = config.feishu.domain === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn'
  const botOpenUrl = `https://${applinkHost}/client/bot/open?appId=${encodeURIComponent(config.feishu.appId)}`
  return {
    version: config.version,
    aampHost: config.aampHost,
    targetAgentEmail: config.targetAgentEmail,
    slug: config.slug,
    feishu: {
      appId: config.feishu.appId,
      domain: config.feishu.domain,
      authMode: config.feishu.authMode ?? (config.feishu.appSecret ? 'app-secret' : 'lark-cli'),
      cliProfile: config.feishu.cliProfile,
      botOpenUrl,
    },
    mailbox: {
      email: config.mailbox.email,
      baseUrl: config.mailbox.baseUrl,
    },
  }
}

function printUsage(): void {
  console.log(`AAMP Feishu Bridge

Usage:
  aamp-feishu-bridge init [--config-dir DIR] [--aamp-host URL] [--target-agent EMAIL|--pairing-url URL] [--app-id ID] [--app-secret SECRET] [--use-feishu-cli] [--feishu-cli-new] [--feishu-cli-open] [--feishu-cli-profile NAME] [--slug NAME] [--domain DOMAIN] [--no-start] [--json]
  aamp-feishu-bridge start [--config-dir DIR] [--json]
  aamp-feishu-bridge start --enable-task [--config-dir DIR] [--aamp-host URL] [--agent NAME] [--target-agent EMAIL|--pairing-url URL] [--app-id ID] [--use-feishu-cli] [--feishu-cli-profile NAME] [--feishu-cli-bin PATH] [--domain DOMAIN] [--boe|--pre] [--env NAME] [--debug] [--json]
  aamp-feishu-bridge status [--config-dir DIR] [--json]
  aamp-feishu-bridge remove [--config-dir DIR] (--target-agent EMAIL|--slug NAME) [--json]

Aliases:
  run    Alias for start
  unbind Alias for remove
`)
}

async function runInit(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  await ensureBridgeHomeDir(configDir)
  const config = await initializeBridgeConfig({
    configDir,
    aampHost: firstArg(args, 'aamp-host'),
    targetAgentEmail: firstArg(args, 'target-agent'),
    pairingUrl: firstArg(args, 'pairing-url'),
    appId: firstArg(args, 'app-id'),
    appSecret: firstArg(args, 'app-secret'),
    useFeishuCli: args.booleans.has('use-feishu-cli') || args.booleans.has('feishu-cli'),
    feishuCliNew: args.booleans.has('feishu-cli-new'),
    feishuCliProfile: firstArg(args, 'feishu-cli-profile'),
    feishuCliBin: firstArg(args, 'feishu-cli-bin'),
    feishuCliAppName: firstArg(args, 'feishu-cli-app-name'),
    feishuCliOpen: args.booleans.has('feishu-cli-open'),
    slug: firstArg(args, 'slug'),
    domain: firstArg(args, 'domain'),
  })

  if (jsonOutput(args)) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      type: 'init.completed',
      bridge: 'feishu-bridge',
      configDir: getBridgeInstanceDir(config.slug, configDir),
      config: bridgeConfigSummary(config),
    }, null, 2))
    return
  }

  console.log(`Initialized bridge in ${getBridgeHomeDir(configDir)}`)
  console.log(`AAMP mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
  if (args.booleans.has('no-start')) {
    console.log('Bridge not started because --no-start was provided.')
    return
  }
  await runBridge(args)
}

async function runStatus(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const entries = await loadBridgeConfigEntries(configDir)
  const agents = await Promise.all(entries.map(async (entry) => ({
    configDir: entry.configDir,
    configPath: entry.configPath,
    legacy: entry.legacy,
    config: bridgeConfigSummary(entry.config),
    state: await loadBridgeState(entry.configDir),
  })))
  if (args.booleans.has('json')) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      type: 'status',
      bridge: 'feishu-bridge',
      configDir: getBridgeHomeDir(configDir),
      agents,
      config: agents[0]?.config ?? null,
      state: agents[0]?.state ?? null,
    }, null, 2))
    return
  }
  if (agents.length === 0) {
    console.log(`No bridge config found in ${getBridgeHomeDir(configDir)}.`)
    return
  }

  console.log(`Bridge home: ${getBridgeHomeDir(configDir)}`)
  for (const agent of agents) {
    console.log(`\n[${agent.config.slug}]`)
    console.log(`Config: ${agent.configPath}`)
    console.log(`AAMP mailbox: ${agent.config.mailbox.email}`)
    console.log(`Target agent: ${agent.config.targetAgentEmail}`)
    console.log(`Feishu app: ${agent.config.feishu.appId}`)
    console.log(`Connectivity: feishu=${agent.state.connectivity.feishu} aamp=${agent.state.connectivity.aamp}`)
    console.log(`Active conversations: ${Object.keys(agent.state.conversations).length}`)
    console.log(`Tracked tasks: ${Object.keys(agent.state.tasks).length}`)
    if (agent.state.bot?.name || agent.state.bot?.openId) {
      console.log(`Bot identity: ${agent.state.bot.name || '(unknown)'} ${agent.state.bot.openId ? `(${agent.state.bot.openId})` : ''}`.trim())
    }
    if (agent.state.lastError) {
      console.log(`Last error: ${agent.state.lastError}`)
    }
  }
}

async function runRemove(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const removed = await removeBridgeConfigEntry({
    configDir,
    targetAgentEmail: firstArg(args, 'target-agent'),
    slug: firstArg(args, 'slug'),
  })
  if (!removed) {
    throw new Error(`No Feishu access config matched in ${getBridgeHomeDir(configDir)}.`)
  }

  if (jsonOutput(args)) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      type: 'access.removed',
      bridge: 'feishu-bridge',
      configDir: removed.configDir,
      config: bridgeConfigSummary(removed.config),
    }, null, 2))
    return
  }

  console.log(`Removed Feishu access for ${removed.config.targetAgentEmail}.`)
  console.log(`Bridge mailbox: ${removed.config.mailbox.email}`)
}

async function runBridge(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  if (args.booleans.has('enable-task')) {
    await runTaskEnabledBridge({
      configDir,
      aampHost: firstArg(args, 'aamp-host'),
      agent: firstArg(args, 'agent'),
      targetAgentEmail: firstArg(args, 'target-agent'),
      pairingUrl: firstArg(args, 'pairing-url'),
      appId: firstArg(args, 'app-id'),
      appSecret: firstArg(args, 'app-secret'),
      botName: firstArg(args, 'bot-name'),
      useFeishuCli: args.booleans.has('use-feishu-cli') || args.booleans.has('feishu-cli'),
      feishuCliProfile: firstArg(args, 'feishu-cli-profile'),
      feishuCliBin: firstArg(args, 'feishu-cli-bin'),
      domain: firstArg(args, 'domain'),
      boe: args.booleans.has('boe'),
      pre: args.booleans.has('pre'),
      env: firstArg(args, 'env'),
      debug: args.booleans.has('debug'),
      json: jsonOutput(args),
    })
    return
  }
  const entries = await loadBridgeConfigEntries(configDir)
  if (entries.length === 0) {
    throw new Error(`No bridge config found in ${getBridgeHomeDir(configDir)}. Run "aamp-feishu-bridge init" first.`)
  }

  const runtimes = entries.map((entry) => ({
    entry,
    runtime: new FeishuBridgeRuntime(entry.config, { configDir: entry.configDir }),
  }))
  if (jsonOutput(args)) {
    for (const { entry } of runtimes) {
      writeJsonEvent({
        type: 'bridge.starting',
        bridge: 'feishu-bridge',
        targetAgentEmail: entry.config.targetAgentEmail,
        mailbox: entry.config.mailbox.email,
        configDir: entry.configDir,
      })
    }
  }
  const started: FeishuBridgeRuntime[] = []
  const failed: Array<{ targetAgentEmail: string; error: string }> = []
  for (const { entry, runtime } of runtimes) {
    try {
      await runtime.start()
      started.push(runtime)
    } catch (error) {
      const message = error instanceof Error ? error.message : inspect(error)
      failed.push({ targetAgentEmail: entry.config.targetAgentEmail, error: message })
      if (jsonOutput(args)) {
        writeJsonEvent({
          type: 'bridge.failed',
          bridge: 'feishu-bridge',
          targetAgentEmail: entry.config.targetAgentEmail,
          mailbox: entry.config.mailbox.email,
          configDir: entry.configDir,
          error: message,
        })
      } else {
        console.error(`Failed to start ${entry.config.targetAgentEmail}: ${message}`)
      }
    }
  }
  if (started.length === 0) {
    throw new Error(`No Feishu bridge instance started. ${failed.map((item) => `${item.targetAgentEmail}: ${item.error}`).join('; ')}`)
  }
  if (jsonOutput(args)) {
    for (const { entry } of runtimes.filter(({ runtime }) => started.includes(runtime))) {
      writeJsonEvent({
        type: 'bridge.running',
        bridge: 'feishu-bridge',
        targetAgentEmail: entry.config.targetAgentEmail,
        mailbox: entry.config.mailbox.email,
        configDir: entry.configDir,
      })
    }
    writeJsonEvent({
      type: 'bridge.supervisor.running',
      bridge: 'feishu-bridge',
      agents: started.length,
      failedAgents: failed.length,
    })
  } else {
    console.log(`Feishu bridge is running for ${started.length} Agent(s).`)
    for (const { entry } of runtimes.filter(({ runtime }) => started.includes(runtime))) {
      console.log(`- ${entry.config.targetAgentEmail}: ${entry.config.mailbox.email}`)
    }
  }

  const shutdown = async (signal: string) => {
    if (jsonOutput(args)) {
      writeJsonEvent({ type: 'bridge.shutdown', bridge: 'feishu-bridge', reason: signal })
    } else {
      console.log(`Received ${signal}, shutting down...`)
    }
    await Promise.all(started.map((runtime) => runtime.stop().catch(() => {})))
    if (jsonOutput(args)) {
      writeJsonEvent({ type: 'bridge.stopped', bridge: 'feishu-bridge' })
    }
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.booleans.has('help')) {
    printUsage()
    return
  }
  switch (args.command) {
    case 'init':
      await runInit(args)
      return
    case 'start':
    case 'run':
      await runBridge(args)
      return
    case 'status':
      await runStatus(args)
      return
    case 'remove':
    case 'unbind':
      await runRemove(args)
      return
    case 'help':
      printUsage()
      return
    default:
      printUsage()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : inspect(error))
  process.exitCode = 1
})
