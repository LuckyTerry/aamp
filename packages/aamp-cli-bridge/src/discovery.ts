import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentConfig, BridgeConfig, CliProfileDefinition } from './config.js'
import { BUILTIN_CLI_PROFILES, getBuiltinCliProfileNames, listUserCliProfiles } from './cli-profiles.js'
import { resolveCredentialsFile } from './storage.js'

export interface CliBridgeAgentCandidate {
  id: string
  displayName: string
  source: 'built-in' | 'user' | 'config' | 'configured'
  connection: 'cli_bridge'
  detected: boolean
  configured: boolean
  confidence: 'high' | 'medium' | 'low'
  command?: string
  version?: string
  profile: string
  email?: string
  warnings: string[]
}

export interface CliBridgeDiscovery {
  schemaVersion: 1
  bridge: 'cli-bridge'
  candidates: CliBridgeAgentCandidate[]
}

interface ProfileCandidate {
  name: string
  cliProfile: AgentConfig['cliProfile']
  profile?: CliProfileDefinition
  source: CliBridgeAgentCandidate['source']
  existingAgent?: AgentConfig
}

function loadPreviousConfig(configPath: string): BridgeConfig | undefined {
  if (!existsSync(configPath)) return undefined

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<BridgeConfig>
    if (!raw || !Array.isArray(raw.agents)) return undefined

    return {
      aampHost: typeof raw.aampHost === 'string' ? raw.aampHost : 'https://meshmail.ai',
      rejectUnauthorized: raw.rejectUnauthorized === true,
      ...(raw.profiles ? { profiles: raw.profiles } : {}),
      agents: raw.agents,
    } as BridgeConfig
  } catch {
    return undefined
  }
}

function profileLabel(profileRef: AgentConfig['cliProfile']): string {
  if (typeof profileRef === 'string') return profileRef
  return profileRef.name ?? 'inline'
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function profilesEquivalent(left: CliProfileDefinition | undefined, right: CliProfileDefinition | undefined): boolean {
  if (!left || !right) return false
  return stableStringify(left) === stableStringify(right)
}

function resolveProfileForExistingAgent(
  agent: AgentConfig,
  customProfiles: BridgeConfig['profiles'] | undefined,
): CliProfileDefinition | undefined {
  if (typeof agent.cliProfile !== 'string') return agent.cliProfile
  return customProfiles?.[agent.cliProfile]
    ?? BUILTIN_CLI_PROFILES[agent.cliProfile]
    ?? listUserCliProfiles().find((item) => item.name === agent.cliProfile)?.profile
}

function collectProfileCandidates(previousConfig?: BridgeConfig): ProfileCandidate[] {
  const profiles = new Map<string, ProfileCandidate>()

  for (const name of getBuiltinCliProfileNames()) {
    profiles.set(name, {
      name,
      cliProfile: name,
      profile: BUILTIN_CLI_PROFILES[name],
      source: 'built-in',
    })
  }

  for (const [name, profile] of Object.entries(previousConfig?.profiles ?? {})) {
    profiles.set(name, {
      name,
      cliProfile: name,
      profile,
      source: 'config',
    })
  }

  for (const { name, profile } of listUserCliProfiles()) {
    const existing = profiles.get(name)
    if (existing?.source === 'built-in' && profilesEquivalent(existing.profile, profile)) continue

    profiles.set(name, {
      name,
      cliProfile: name,
      profile,
      source: 'user',
    })
  }

  for (const agent of previousConfig?.agents ?? []) {
    const existing = profiles.get(agent.name)
    const profile = resolveProfileForExistingAgent(agent, previousConfig?.profiles)
    if (existing) {
      profiles.set(agent.name, {
        ...existing,
        existingAgent: agent,
        cliProfile: agent.cliProfile,
        profile: profile ?? existing.profile,
      })
      continue
    }

    profiles.set(agent.name, {
      name: agent.name,
      cliProfile: agent.cliProfile,
      ...(profile ? { profile } : {}),
      source: 'configured',
      existingAgent: agent,
    })
  }

  return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function renderCommandForDetection(command: string, profileName: string): string | undefined {
  const rendered = command.replace(/\{\{\s*agentName\s*\}\}/g, profileName)
  if (/\{\{/.test(rendered)) return undefined
  if (/\s/.test(rendered.trim())) return undefined
  return rendered.trim() || undefined
}

function detectCommand(command: string): string | undefined {
  try {
    execFileSync('which', [command], { stdio: 'pipe', timeout: 3_000 })
    try {
      return execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5_000 })
        .toString()
        .trim()
        .split('\n')[0] || 'installed'
    } catch {
      return 'installed'
    }
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

export function discoverCliBridgeAgents(configPath: string): CliBridgeDiscovery {
  const previousConfig = loadPreviousConfig(configPath)
  const candidates = collectProfileCandidates(previousConfig).map((candidate): CliBridgeAgentCandidate => {
    const command = candidate.profile
      ? renderCommandForDetection(candidate.profile.command, candidate.name)
      : undefined
    const version = command ? detectCommand(command) : undefined
    const configured = Boolean(candidate.existingAgent)
    const detected = Boolean(version)
    const warnings: string[] = []

    if (!command) warnings.push('Profile command cannot be detected automatically.')
    else if (!detected) warnings.push(`${command} was not found on PATH.`)

    return {
      id: candidate.name,
      displayName: candidate.name,
      source: candidate.source,
      connection: 'cli_bridge',
      detected,
      configured,
      confidence: detected ? 'high' : configured ? 'medium' : 'low',
      ...(command ? { command } : {}),
      ...(version ? { version } : {}),
      profile: profileLabel(candidate.cliProfile),
      ...(candidate.existingAgent ? { email: loadConfiguredEmail(candidate.existingAgent) } : {}),
      warnings,
    }
  })

  return {
    schemaVersion: 1,
    bridge: 'cli-bridge',
    candidates,
  }
}
