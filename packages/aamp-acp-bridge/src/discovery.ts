import { existsSync, readFileSync } from 'node:fs'
import type { AgentConfigInput, BridgeConfigInput } from './config.js'
import { resolveCredentialsFile } from './storage.js'
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  defaultAgentCommand,
  detectKnownAgent,
  missingAgentWarning,
} from './agent-resolver.js'

interface AcpBridgeAgentCandidateBase {
  id: string
  displayName: string
  connection: 'acp_bridge'
  detected: boolean
  configured: boolean
  confidence: 'high' | 'medium' | 'low'
  email?: string
  warnings: string[]
}

export interface AcpBridgeLocalAgentCandidate extends AcpBridgeAgentCandidateBase {
  command: string
  acpCommand: string
  version?: string
}

export interface AcpBridgeRemoteAgentCandidate extends AcpBridgeAgentCandidateBase {
  executionLocation: 'remote'
  commandConfigured: true
  acpCommandConfigured: true
  versionDetected?: true
}

export type AcpBridgeAgentCandidate =
  | AcpBridgeLocalAgentCandidate
  | AcpBridgeRemoteAgentCandidate

export interface AcpBridgeDiscovery {
  schemaVersion: 1
  bridge: 'acp-bridge'
  candidates: AcpBridgeAgentCandidate[]
}

function loadPreviousConfig(configPath: string): BridgeConfigInput | undefined {
  if (!existsSync(configPath)) return undefined

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<BridgeConfigInput>
    if (!raw || !Array.isArray(raw.agents)) return undefined

    return {
      aampHost: typeof raw.aampHost === 'string' ? raw.aampHost : 'https://meshmail.ai',
      rejectUnauthorized: raw.rejectUnauthorized === true,
      agents: raw.agents,
    } as BridgeConfigInput
  } catch {
    return undefined
  }
}

function loadConfiguredEmail(agent: AgentConfigInput): string | undefined {
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
    const command = resolution?.command ?? defaultAgentCommand(name)
    const detected = Boolean(resolution)
    const configured = Boolean(existingAgent)
    const remote = existingAgent?.executionLocation === 'remote'
    const warnings = detected
      ? []
      : remote
        ? ['Remote Agent adapter was not detected.']
        : [missingAgentWarning(name)]

    const common: AcpBridgeAgentCandidateBase = {
      id: name,
      displayName: name,
      connection: 'acp_bridge',
      detected,
      configured,
      confidence: detected ? 'high' : configured ? 'medium' : 'low',
      ...(existingAgent ? { email: loadConfiguredEmail(existingAgent) } : {}),
      warnings,
    }

    if (remote) {
      return {
        ...common,
        executionLocation: 'remote',
        commandConfigured: true,
        acpCommandConfigured: true,
        ...(resolution?.version ? { versionDetected: true as const } : {}),
      }
    }

    return {
      ...common,
      command,
      acpCommand: defaultAcpCommand(name, existingAgent?.acpCommand),
      ...(resolution?.version ? { version: resolution.version } : {}),
    }
  })

  return {
    schemaVersion: 1,
    bridge: 'acp-bridge',
    candidates,
  }
}
