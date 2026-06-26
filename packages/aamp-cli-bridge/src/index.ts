#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { AampClient } from 'aamp-sdk'
import { AampCliBridge } from './bridge.js'
import { BUILTIN_CLI_PROFILES, getBuiltinCliProfileNames } from './cli-profiles.js'
import { renderPairingCode, runInit } from './cli/init.js'
import { runProfileMaker } from './cli/profile-maker.js'
import { loadConfig, type AgentConfig, type BridgeConfig } from './config.js'
import { discoverCliBridgeAgents } from './discovery.js'
import { runJsonInit } from './json-init.js'
import { createPairingCode, pairingUrlToWebUrl, resolvePairingFile } from './pairing.js'
import { getAgentSenderPolicy, setAgentSenderPolicy } from './sender-policy.js'
import { getDefaultProfilesDir, resolveConfigPath, resolveCredentialsFile } from './storage.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'start'
const jsonOutput = args.includes('--json') || getOptionValue('--output') === 'json'
const configPath = resolveConfigPath(
  args.includes('--config') ? (args[args.indexOf('--config') + 1] ?? '') : undefined,
)

function getOptionValue(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : undefined
}

function writeJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  })}\n`)
}

function redirectConsoleToStderr(): void {
  console.log = (...values: unknown[]) => {
    process.stderr.write(`${values.map(String).join(' ')}\n`)
  }
  console.warn = (...values: unknown[]) => {
    process.stderr.write(`${values.map(String).join(' ')}\n`)
  }
  console.error = (...values: unknown[]) => {
    process.stderr.write(`${values.map(String).join(' ')}\n`)
  }
}

async function readJsonInput(): Promise<unknown> {
  const inputPath = getOptionValue('--input')
  const raw = inputPath && inputPath !== '-'
    ? readFileSync(inputPath, 'utf-8')
    : await new Promise<string>((resolve, reject) => {
        let data = ''
        process.stdin.setEncoding('utf-8')
        process.stdin.on('data', (chunk) => { data += chunk })
        process.stdin.on('end', () => resolve(data))
        process.stdin.on('error', reject)
      })

  if (!raw.trim()) {
    throw new Error('Missing JSON input. Pass --input FILE or pipe JSON on stdin.')
  }

  return JSON.parse(raw)
}

function getAgent(config: BridgeConfig, agentName: string): AgentConfig {
  const agent = config.agents.find((item) => item.name === agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in config`)
  }
  return agent
}

function getConnectionSetupOption(): 'pairing-code' | 'manual-sender-policy' | 'reuse-sender-policy' | 'later' | undefined {
  const value = getOptionValue('--connection-setup')
  if (!value) return undefined
  if (
    value === 'pairing-code'
    || value === 'manual-sender-policy'
    || value === 'reuse-sender-policy'
    || value === 'later'
  ) {
    return value
  }
  throw new Error('--connection-setup must be one of pairing-code, manual-sender-policy, reuse-sender-policy, later')
}

function loadAgentCredentials(agent: AgentConfig): { email: string; smtpPassword: string } {
  const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
  const creds = JSON.parse(readFileSync(credFile, 'utf-8')) as {
    email?: string
    smtpPassword?: string
  }

  if (!creds.email || !creds.smtpPassword) {
    throw new Error(`Credentials file is incomplete: ${credFile}`)
  }

  return {
    email: creds.email,
    smtpPassword: creds.smtpPassword,
  }
}

function createDirectoryClient(configPathValue: string, agentName: string): AampClient {
  const config = loadConfig(configPathValue)
  const agent = config.agents.find((item) => item.name === agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in ${configPathValue}`)
  }

  const creds = loadAgentCredentials(agent)

  return AampClient.fromMailboxIdentity({
    email: creds.email,
    smtpPassword: creds.smtpPassword,
    baseUrl: config.aampHost,
    rejectUnauthorized: config.rejectUnauthorized,
  })
}

function renderPairingForAgent(configPathValue: string, agentName: string): void {
  const config = loadConfig(configPathValue)
  const agent = getAgent(config, agentName)
  const creds = loadAgentCredentials(agent)
  renderPairingCode(
    agent.name,
    creds.email,
    resolvePairingFile(agent.pairingFile, agent.name),
  )
}

function createPairingForAgent(configPathValue: string, agentName: string) {
  const config = loadConfig(configPathValue)
  const agent = getAgent(config, agentName)
  const creds = loadAgentCredentials(agent)
  const pairingFile = resolvePairingFile(agent.pairingFile, agent.name)
  const pairing = createPairingCode({
    mailbox: creds.email,
    file: pairingFile,
  })

  return {
    type: 'pairing.created',
    bridge: 'cli-bridge',
    agent: agent.name,
    mailbox: pairing.mailbox,
    pairCode: pairing.pairCode,
    expiresAt: pairing.expiresAt,
    connectUrl: pairing.connectUrl,
    webUrl: pairingUrlToWebUrl(pairing.connectUrl),
    pairingFile,
  }
}

async function startBridge(
  configPathValue: string,
  options: { quiet?: boolean; agent?: string; json?: boolean } = {},
): Promise<void> {
  if (options.json) {
    redirectConsoleToStderr()
  }
  const config = loadConfig(configPathValue)
  const agents = options.agent ? [getAgent(config, options.agent)] : config.agents
  const bridge = new AampCliBridge({
    ...config,
    agents,
  })

  const shutdown = () => {
    if (options.json) {
      writeJsonEvent({ type: 'bridge.shutdown', bridge: 'cli-bridge', reason: 'signal' })
    } else {
      console.log('\nShutting down...')
    }
    bridge.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await bridge.start({
    quiet: options.quiet || options.json,
    onEvent: options.json ? writeJsonEvent : undefined,
  })
  setInterval(() => {}, 60_000)
}

async function main() {
  switch (command) {
    case 'init': {
      if (jsonOutput) {
        const result = await runJsonInit(configPath, await readJsonInput())
        console.log(JSON.stringify(result, null, 2))
        break
      }
      const initialized = await runInit(configPath, {
        agent: getOptionValue('--agent'),
        aampHost: getOptionValue('--aamp-host'),
        connectionSetup: getConnectionSetupOption(),
      })
      if (!initialized) break
      if (args.includes('--no-start')) {
        console.log(`CLI bridge not started because --no-start was provided.`)
        console.log(`Run: npx aamp-cli-bridge start\n`)
        break
      }
      await startBridge(configPath, { quiet: true, agent: getOptionValue('--agent') })
      break
    }

    case 'start': {
      await startBridge(configPath, { json: jsonOutput, agent: getOptionValue('--agent') })
      break
    }

    case 'pair': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      if (jsonOutput) {
        console.log(JSON.stringify(createPairingForAgent(configPath, agentName), null, 2))
        if (args.includes('--no-start')) break
        await startBridge(configPath, { quiet: true, agent: agentName, json: true })
        break
      }
      renderPairingForAgent(configPath, agentName)
      if (args.includes('--no-start')) break
      await startBridge(configPath, { quiet: true, agent: agentName })
      break
    }

    case 'list': {
      const config = loadConfig(configPath)
      if (jsonOutput) {
        const agents = config.agents.map((agent) => {
          const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
          let email: string | undefined
          try {
            const creds = JSON.parse(readFileSync(credFile, 'utf-8')) as { email?: string }
            email = creds.email
          } catch { /* no credentials yet */ }
          return {
            name: agent.name,
            bridge: 'cli-bridge',
            connection: 'cli_bridge',
            email,
            profile: typeof agent.cliProfile === 'string'
              ? agent.cliProfile
              : (agent.cliProfile.name ?? 'inline'),
            credentialsFile: credFile,
            configured: true,
          }
        })
        console.log(JSON.stringify({
          schemaVersion: 1,
          bridge: 'cli-bridge',
          configPath,
          aampHost: config.aampHost,
          agents,
        }, null, 2))
        break
      }
      console.log(`\nConfigured CLI agents (${config.agents.length}):`)
      for (const agent of config.agents) {
        const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
        let email = '(not registered)'
        try {
          const creds = JSON.parse(readFileSync(credFile, 'utf-8'))
          email = creds.email ?? email
        } catch { /* no credentials yet */ }
        const profile = typeof agent.cliProfile === 'string'
          ? agent.cliProfile
          : (agent.cliProfile.name ?? 'inline')
        console.log(`  ${agent.name}: ${email} (profile:${profile})`)
      }
      console.log()
      break
    }

    case 'discover': {
      console.log(JSON.stringify(discoverCliBridgeAgents(configPath), null, 2))
      break
    }

    case 'sender-policy': {
      const action = args[1]
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      const config = loadConfig(configPath)

      if (action === 'get') {
        console.log(JSON.stringify(getAgentSenderPolicy(config, agentName), null, 2))
        break
      }

      if (action === 'set') {
        const input = await readJsonInput() as { senderPolicy?: string }
        console.log(JSON.stringify(setAgentSenderPolicy(config, configPath, agentName, input.senderPolicy ?? ''), null, 2))
        break
      }

      throw new Error('Usage: sender-policy get|set --agent NAME --json [--input -]')
    }

    case 'status': {
      const config = loadConfig(configPath)
      const bridge = new AampCliBridge(config)
      await bridge.start()
      bridge.list()
      bridge.stop()
      break
    }

    case 'profile-list': {
      console.log('\nBuilt-in CLI profiles:')
      for (const name of getBuiltinCliProfileNames()) {
        const profile = BUILTIN_CLI_PROFILES[name]
        console.log(`  ${name}: ${profile.description ?? profile.command}`)
      }

      const profilesDir = getDefaultProfilesDir()
      console.log(`\nUser CLI profiles (${profilesDir}):`)
      if (!existsSync(profilesDir)) {
        console.log('  (none)')
      } else {
        const names = readdirSync(profilesDir)
          .filter((item) => item.endsWith('.json'))
          .map((item) => item.replace(/\.json$/, ''))
          .sort()
        if (names.length === 0) {
          console.log('  (none)')
        } else {
          for (const name of names) console.log(`  ${name}`)
        }
      }
      console.log()
      break
    }

    case 'profile-maker': {
      await runProfileMaker()
      break
    }

    case 'directory-list': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      const client = createDirectoryClient(configPath, agentName)
      const agents = await client.listDirectory({
        includeSelf: args.includes('--include-self'),
        limit: getOptionValue('--limit') ? Number(getOptionValue('--limit')) : undefined,
      })
      console.log(JSON.stringify({ agents }, null, 2))
      break
    }

    case 'directory-search': {
      const agentName = getOptionValue('--agent')
      const query = getOptionValue('--query')
      if (!agentName) throw new Error('Missing required --agent')
      if (!query) throw new Error('Missing required --query')
      const client = createDirectoryClient(configPath, agentName)
      const agents = await client.searchDirectory({
        query,
        includeSelf: args.includes('--include-self'),
        limit: getOptionValue('--limit') ? Number(getOptionValue('--limit')) : undefined,
      })
      console.log(JSON.stringify({ agents }, null, 2))
      break
    }

    case 'directory-update': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      const summary = getOptionValue('--summary')
      const cardText = getOptionValue('--card-text')
      const cardFile = getOptionValue('--card-file')
      const resolvedCardText = cardText ?? (cardFile ? readFileSync(cardFile, 'utf-8') : undefined)

      if (!summary && !resolvedCardText) {
        throw new Error('Provide at least one of --summary, --card-text, or --card-file')
      }

      const client = createDirectoryClient(configPath, agentName)
      const profile = await client.updateDirectoryProfile({
        ...(summary ? { summary } : {}),
        ...(resolvedCardText ? { cardText: resolvedCardText } : {}),
      })
      console.log(JSON.stringify({ profile }, null, 2))
      break
    }

    case 'help':
    default:
      console.log(`
AAMP CLI Bridge -- Connect direct CLI agents to the AAMP email network

Usage:
  aamp-cli-bridge init [--agent NAME] [--aamp-host URL] [--connection-setup METHOD] [--no-start]
  aamp-cli-bridge init --json --input -  Non-interactive setup for desktop clients
  aamp-cli-bridge start [--agent NAME] [--config X] [--json]  Start the bridge (default: ~/.aamp/cli-bridge/config.json)
  aamp-cli-bridge pair --agent NAME [--config X] [--no-start]  Show a pairing QR code, then start that agent
  aamp-cli-bridge list  [--config X]   List configured agents
  aamp-cli-bridge discover [--config X] [--json]  Discover local CLI agent candidates
  aamp-cli-bridge status               Show live connection status
  aamp-cli-bridge profile-list         List built-in and user CLI profiles
  aamp-cli-bridge profile-maker        Interactive profile maker for custom CLI agents
  aamp-cli-bridge directory-list --agent NAME [--config X] [--include-self] [--limit N]
  aamp-cli-bridge directory-search --agent NAME --query TEXT [--config X] [--include-self] [--limit N]
  aamp-cli-bridge directory-update --agent NAME [--config X] [--summary TEXT] [--card-text TEXT] [--card-file PATH]
  aamp-cli-bridge sender-policy get --agent NAME [--config X] --json
  aamp-cli-bridge sender-policy set --agent NAME [--config X] --json --input -
  aamp-cli-bridge help                 Show this help

Examples:
  npx aamp-cli-bridge profile-maker
  npx aamp-cli-bridge init
  npx aamp-cli-bridge init --agent codem --aamp-host https://meshmail.ai --connection-setup pairing-code
  npx aamp-cli-bridge init --no-start
  npx aamp-cli-bridge pair --agent codex
  npx aamp-cli-bridge start
  npx aamp-cli-bridge start --config production.json
`)
      break
  }
}

main().catch((err) => {
  if (jsonOutput) {
    console.error(JSON.stringify({
      type: 'error',
      bridge: 'cli-bridge',
      message: (err as Error).message,
    }))
  } else {
    console.error(`Error: ${(err as Error).message}`)
  }
  process.exit(1)
})
