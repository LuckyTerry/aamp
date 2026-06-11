import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentConfig, BridgeConfig, SenderPolicy } from './config.js'
import { loadSenderPolicies, resolveSenderPoliciesFile } from './pairing.js'

type PolicyLike = {
  sender: string
  dispatchContextRules?: Record<string, string[]>
}

export function policyTextFromSenderPolicies(senderPolicies: PolicyLike[] | undefined): string {
  const policies = senderPolicies ?? []
  const lines: string[] = []
  for (const policy of policies) {
    const sender = policy.sender.trim()
    if (!sender) continue
    lines.push(`allow_from: ${sender}`)
    const contextRules: string[] = []
    for (const [key, values] of Object.entries(policy.dispatchContextRules ?? {})) {
      const normalizedKey = key.trim()
      if (!normalizedKey) continue
      for (const value of values ?? []) {
        const normalizedValue = value.trim()
        if (normalizedValue) contextRules.push(`${normalizedKey}=${normalizedValue}`)
      }
    }
    if (contextRules.length > 0) {
      lines.push(`context_equals: ${contextRules.join(', ')}`)
    }
  }
  return lines.join('\n')
}

export function senderPoliciesFromPolicyText(policyText: string): SenderPolicy[] | undefined {
  const policies: SenderPolicy[] = []
  let activeIndexes: number[] = []

  for (const rawLine of policyText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([a-z_]+)\s*:\s*(.+)$/i.exec(line)
    if (!match?.[1] || !match[2]) continue

    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'allow_from') {
      activeIndexes = []
      for (const sender of value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
        const existingIndex = policies.findIndex((policy) => policy.sender === sender)
        if (existingIndex >= 0) {
          activeIndexes.push(existingIndex)
        } else {
          activeIndexes.push(policies.push({ sender }) - 1)
        }
      }
      continue
    }

    if (key === 'context_equals') {
      if (activeIndexes.length === 0) continue
      for (const entry of value.split(',')) {
        const [rawContextKey, ...rawContextValueParts] = entry.split('=')
        const contextKey = rawContextKey?.trim().toLowerCase()
        const contextValue = rawContextValueParts.join('=').trim()
        if (!contextKey || !contextValue) continue
        for (const index of activeIndexes) {
          const policy = policies[index]
          if (!policy) continue
          policy.dispatchContextRules = {
            ...(policy.dispatchContextRules ?? {}),
            [contextKey]: [
              ...(policy.dispatchContextRules?.[contextKey] ?? []),
              contextValue,
            ],
          }
        }
      }
    }
  }

  return policies.length > 0 ? policies : undefined
}

export function getAgentSenderPolicy(config: BridgeConfig, agentName: string) {
  const agent = getAgent(config, agentName)
  const pairedPolicies = loadSenderPolicies(resolveSenderPoliciesFile(agent.senderPoliciesFile, agent.name))
  const senderPolicies = mergeSenderPolicies([
    ...(agent.senderPolicies ?? []),
    ...pairedPolicies,
  ])
  return {
    schemaVersion: 1,
    type: 'sender-policy.loaded',
    bridge: 'acp-bridge',
    agent: agent.name,
    senderPolicy: policyTextFromSenderPolicies(senderPolicies),
    senderPolicies,
  }
}

export function setAgentSenderPolicy(config: BridgeConfig, configPath: string, agentName: string, policyText: string) {
  const nextAgents = config.agents.map((agent): AgentConfig => {
    if (agent.name !== agentName) return agent
    const senderPolicies = senderPoliciesFromPolicyText(policyText)
    const nextAgent: AgentConfig = {
      ...agent,
      ...(senderPolicies ? { senderPolicies } : {}),
    }
    if (!senderPolicies) delete nextAgent.senderPolicies
    delete nextAgent.senderWhitelist
    return nextAgent
  })

  if (!config.agents.some((agent) => agent.name === agentName)) {
    throw new Error(`Agent "${agentName}" not found in config`)
  }

  const nextConfig: BridgeConfig = {
    ...config,
    agents: nextAgents,
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`)

  return {
    schemaVersion: 1,
    type: 'sender-policy.updated',
    bridge: 'acp-bridge',
    agent: agentName,
    senderPolicy: policyText,
    senderPolicies: senderPoliciesFromPolicyText(policyText) ?? [],
  }
}

function mergeSenderPolicies(policies: PolicyLike[]): PolicyLike[] {
  const merged = new Map<string, PolicyLike>()
  for (const policy of policies) {
    const sender = policy.sender.trim().toLowerCase()
    if (!sender) continue
    const current = merged.get(sender) ?? { sender }
    for (const [key, values] of Object.entries(policy.dispatchContextRules ?? {})) {
      const normalizedKey = key.trim().toLowerCase()
      if (!normalizedKey) continue
      const currentValues = new Set(current.dispatchContextRules?.[normalizedKey] ?? [])
      for (const value of values ?? []) {
        const normalizedValue = value.trim()
        if (normalizedValue) currentValues.add(normalizedValue)
      }
      current.dispatchContextRules = {
        ...(current.dispatchContextRules ?? {}),
        [normalizedKey]: [...currentValues],
      }
    }
    merged.set(sender, current)
  }
  return [...merged.values()]
}

function getAgent(config: BridgeConfig, agentName: string): AgentConfig {
  const agent = config.agents.find((item) => item.name === agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in config`)
  }
  return agent
}
