import { existsSync, readFileSync } from 'node:fs'
import type { AgentConfig, BridgeConfig } from './config.js'
import { resolveCredentialsFile } from './storage.js'
import { defaultAcpCommand, detectKnownAgent, missingAgentWarning } from './agent-resolver.js'

export interface AcpBridgeAgentCandidate {
  id: string
  displayName: string
  connection: 'acp_bridge'
  detected: boolean
  configured: boolean
  confidence: 'high' | 'medium' | 'low'
  command: string
  acpCommand: string
  version?: string
  email?: string
  warnings: string[]
}

export interface AcpBridgeDiscovery {
  schemaVersion: 1
  bridge: 'acp-bridge'
  candidates: AcpBridgeAgentCandidate[]
}

const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes',
]

function loadPreviousConfig(configPath: string): BridgeConfig | undefined {
  if (!existsSync(configPath)) return undefined

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<BridgeConfig>
    if (!raw || !Array.isArray(raw.agents)) return undefined

    return {
      aampHost: typeof raw.aampHost === 'string' ? raw.aampHost : 'https://meshmail.ai',
      rejectUnauthorized: raw.rejectUnauthorized === true,
      agents: raw.agents,
    } as BridgeConfig
  } catch {
    return undefined
  }
}

function loadConfiguredEmail(agent: AgentConfig): string | undefined {
  try {
    const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
    const creds = JSON.parse(readFileSync(credFile, 'utf-8')) as { email?: string }
    return creds.email
  } catch {
    return undefined
  }
}

export function discoverAcpBridgeAgents(configPath: string): AcpBridgeDiscovery {
  const previousConfig = loadPreviousConfig(configPath)
  const previousAgents = new Map((previousConfig?.agents ?? []).map((agent) => [agent.name, agent]))
  const names = [...new Set([
    ...KNOWN_AGENTS,
    ...(previousConfig?.agents ?? []).map((agent) => agent.name),
  ])].sort()

  const candidates = names.map((name): AcpBridgeAgentCandidate => {
    const existingAgent = previousAgents.get(name)
    const resolution = detectKnownAgent(name)
    const command = resolution?.command ?? name
    const detected = Boolean(resolution)
    const configured = Boolean(existingAgent)
    const warnings = detected ? [] : [missingAgentWarning(name)]

    return {
      id: name,
      displayName: name,
      connection: 'acp_bridge',
      detected,
      configured,
      confidence: detected ? 'high' : configured ? 'medium' : 'low',
      command,
      acpCommand: defaultAcpCommand(name, existingAgent?.acpCommand),
      ...(resolution?.version ? { version: resolution.version } : {}),
      ...(existingAgent ? { email: loadConfiguredEmail(existingAgent) } : {}),
      warnings,
    }
  })

  return {
    schemaVersion: 1,
    bridge: 'acp-bridge',
    candidates,
  }
}
