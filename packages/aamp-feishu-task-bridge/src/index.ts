#!/usr/bin/env node

import { inspect } from 'node:util'
import {
  applyFeishuRuntimeOverrides,
  ensureBridgeHomeDir,
  getBridgeHomeDir,
  initializeBridgeConfig,
  loadBridgeConfig,
  loadBridgeState,
} from './config.js'
import { FeishuTaskBridgeRuntime } from './runtime.js'

type CommandName = 'init' | 'start' | 'run' | 'status' | 'help' | 'unknown'

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

function allArgs(args: ParsedArgs, key: string): string[] | undefined {
  return args.values[key]
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return inspect(error)
  const lines = [error.stack || error.message]
  let cause: unknown = error.cause
  while (cause) {
    if (cause instanceof Error) {
      lines.push(`Caused by: ${cause.stack || cause.message}`)
      cause = cause.cause
    } else {
      lines.push(`Caused by: ${inspect(cause)}`)
      break
    }
  }
  return lines.join('\n')
}

function printUsage(): void {
  console.log(`AAMP Feishu Task Bridge

Usage:
  aamp-feishu-task-bridge init [--config-dir DIR] [--aamp-host URL] [--target-agent EMAIL|--pairing-url URL] [--app-id ID] [--app-secret SECRET] [--slug NAME] [--domain DOMAIN] [--boe|--pre] [--env NAME] [--debug] [--event-name NAME] [--no-ack-comment] [--no-start]
  aamp-feishu-task-bridge start [--config-dir DIR] [--domain DOMAIN] [--boe|--pre] [--env NAME] [--debug] [--force-register-agent]
  aamp-feishu-task-bridge status [--config-dir DIR] [--json]

Aliases:
  run    Alias for start

Modes:
  --boe        Use https://open.feishu-boe.cn as Feishu OpenAPI domain.
  --pre        Use https://open.feishu-pre.cn as Feishu OpenAPI domain.
  --env NAME   Add x-tt-env: NAME. With --pre or without --boe, also add x-use-ppe: 1.
              Domain/env mode flags are runtime-only and are not persisted in config.json.
  --debug      Print detailed logs and write detailed ACK comments.
  --force-register-agent
               Register the Feishu app as a task agent even when local state says it was already registered.

Defaults:
  task.dispatch source: feishu-task
  task.ack: writes one default Feishu task comment
  task.help_needed: writes the help question as one Feishu task comment, then marks the Feishu task flow blocked
  task.stream.opened: marks tasks in progress on the first effective stream event; selected status/progress/error events are throttled into Feishu task steps
  task.result: applies v2 FEISHU_TASK_RESULT_JSON outputs, then completes or blocks the Feishu task flow; rejected/malformed results close as failures
  card.*: not consumed by this bridge
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
    slug: firstArg(args, 'slug'),
    domain: firstArg(args, 'domain'),
    boe: args.booleans.has('boe'),
    pre: args.booleans.has('pre'),
    env: firstArg(args, 'env'),
    debug: args.booleans.has('debug') ? true : undefined,
    eventNames: allArgs(args, 'event-name'),
    ackComment: args.booleans.has('no-ack-comment') ? false : undefined,
  })
  const runtimeConfig = applyFeishuRuntimeOverrides(config, {
    domain: firstArg(args, 'domain'),
    boe: args.booleans.has('boe'),
    pre: args.booleans.has('pre'),
    env: firstArg(args, 'env'),
    debug: args.booleans.has('debug') ? true : undefined,
  })

  console.log(`Initialized bridge in ${getBridgeHomeDir(configDir)}`)
  console.log(`AAMP mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
  console.log(`Feishu runtime domain: ${runtimeConfig.feishu.domain ?? 'default'}`)
  console.log(`Feishu runtime env: ${runtimeConfig.feishu.headers?.['x-tt-env'] ?? '(none)'}`)
  console.log(`Debug: ${runtimeConfig.behavior.debug ? 'enabled' : 'disabled'}`)
  console.log(`Feishu events: ${config.feishu.eventNames.join(', ')}`)
  console.log(`ACK comment: ${config.behavior.ackComment ? 'enabled' : 'disabled'}`)
  if (args.booleans.has('no-start')) {
    console.log('Bridge not started because --no-start was provided.')
    return
  }
  await runBridge(args)
}

async function runStatus(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const config = await loadBridgeConfig(configDir)
  const state = await loadBridgeState(configDir)
  if (args.booleans.has('json')) {
    console.log(JSON.stringify({ config, state }, null, 2))
    return
  }
  if (!config) {
    console.log(`No bridge config found in ${getBridgeHomeDir(configDir)}.`)
    return
  }

  console.log(`Bridge home: ${getBridgeHomeDir(configDir)}`)
  console.log(`AAMP mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
  console.log(`Feishu app: ${config.feishu.appId}`)
  console.log(`Feishu domain: ${config.feishu.domain ?? 'default'}`)
  console.log(`Feishu env: ${config.feishu.headers?.['x-tt-env'] ?? '(none)'}`)
  console.log(`Debug: ${config.behavior.debug ? 'enabled' : 'disabled'}`)
  console.log(`Feishu events: ${config.feishu.eventNames.join(', ')}`)
  console.log(`ACK comment: ${config.behavior.ackComment ? 'enabled' : 'disabled'}`)
  console.log(`Connectivity: feishu=${state.connectivity.feishu} aamp=${state.connectivity.aamp}`)
  console.log(`Tracked AAMP tasks: ${Object.keys(state.tasks).length}`)
  console.log(`Deduped Feishu events: ${Object.keys(state.dedupEventIds).length}`)
  if (state.taskSubscription?.subscribedAt) {
    console.log([
      `Feishu task subscription: ${state.taskSubscription.subscribedAt}`,
      `app=${state.taskSubscription.appId}`,
      `domain=${state.taskSubscription.domain}`,
      `env=${state.taskSubscription.env ?? '(none)'}`,
      `userIdType=${state.taskSubscription.userIdType}`,
    ].join(' '))
  }
  if (state.lastFeishuEventAt) {
    console.log(`Last Feishu event: ${state.lastFeishuEventAt} ${state.lastFeishuEventId ?? ''} task=${state.lastFeishuEventTaskGuid ?? ''}`.trim())
  }
  if (state.lastIgnoredFeishuEventAt) {
    console.log([
      `Last ignored Feishu event: ${state.lastIgnoredFeishuEventAt}`,
      state.lastIgnoredFeishuEventId ?? '',
      `task=${state.lastIgnoredFeishuEventTaskGuid ?? ''}`,
      `types=${state.lastIgnoredFeishuEventTypes?.join(',') || '(unknown)'}`,
      `reason=${state.lastIgnoredFeishuEventReason ?? '(unknown)'}`,
    ].join(' ').trim())
  }
  if (state.lastAampDispatchAt) {
    console.log(`Last AAMP dispatch: ${state.lastAampDispatchAt} ${state.lastAampDispatchTaskId ?? ''}`.trim())
  }
  if (state.lastAampAckAt) {
    console.log(`Last AAMP ack: ${state.lastAampAckAt} ${state.lastAampAckTaskId ?? ''}`.trim())
  }
  if (state.lastAampHelpAt) {
    console.log(`Last AAMP help: ${state.lastAampHelpAt} ${state.lastAampHelpTaskId ?? ''}`.trim())
  }
  if (state.lastAampResultAt) {
    console.log(`Last AAMP result: ${state.lastAampResultAt} ${state.lastAampResultTaskId ?? ''}`.trim())
  }
  if (state.lastError) {
    console.log(`Last error: ${state.lastError}`)
  }
}

async function runBridge(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const config = await loadBridgeConfig(configDir)
  if (!config) {
    throw new Error(`No bridge config found in ${getBridgeHomeDir(configDir)}. Run "aamp-feishu-task-bridge init" first.`)
  }

  const runtimeConfig = applyFeishuRuntimeOverrides(config, {
    domain: firstArg(args, 'domain'),
    boe: args.booleans.has('boe'),
    pre: args.booleans.has('pre'),
    env: firstArg(args, 'env'),
    debug: args.booleans.has('debug') ? true : undefined,
  })
  const runtime = new FeishuTaskBridgeRuntime(runtimeConfig, {
    configDir,
    forceRegisterAgent: args.booleans.has('force-register-agent'),
  })
  await runtime.start()
  console.log(`Feishu task bridge is running for ${runtimeConfig.targetAgentEmail}`)
  console.log(`Mailbox: ${runtimeConfig.mailbox.email}`)
  console.log(`Feishu domain: ${runtimeConfig.feishu.domain ?? 'default'}`)
  console.log(`Feishu env: ${runtimeConfig.feishu.headers?.['x-tt-env'] ?? '(none)'}`)
  console.log(`Debug: ${runtimeConfig.behavior.debug ? 'enabled' : 'disabled'}`)

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`)
    await runtime.stop()
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
    case 'help':
      printUsage()
      return
    default:
      printUsage()
  }
}

main().catch((error: unknown) => {
  console.error(formatError(error))
  process.exitCode = 1
})
