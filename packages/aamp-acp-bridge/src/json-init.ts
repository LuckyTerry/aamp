import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AampClient } from 'aamp-sdk'
import { z } from 'zod'
import type { AgentConfig, BridgeConfig, SenderPolicy } from './config.js'
import { defaultAcpCommand } from './agent-resolver.js'
import { createPairingCode, defaultPairingFile, defaultSenderPoliciesFile, pairingUrlToWebUrl, resolvePairingFile } from './pairing.js'
import { getDefaultCredentialsPath, resolveCredentialsFile } from './storage.js'

const senderPolicySchema = z.object({
  sender: z.string().min(1),
  dispatchContextRules: z.record(z.array(z.string().min(1))).optional(),
})

const jsonInitAgentSchema = z.object({
  name: z.string().min(1),
  acpCommand: z.string().min(1).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  cardText: z.string().optional(),
  credentialsFile: z.string().optional(),
  pairingFile: z.string().optional(),
  senderPoliciesFile: z.string().optional(),
  senderPolicies: z.array(senderPolicySchema).optional(),
  taskDispatchConcurrency: z.number().int().positive().optional(),
  createPairing: z.boolean().optional(),
})

const jsonInitInputSchema = z.object({
  aampHost: z.string().url().optional(),
  rejectUnauthorized: z.boolean().optional(),
  agents: z.array(jsonInitAgentSchema).min(1),
})

interface MailboxCredentials {
  email: string
  mailboxToken?: string
  smtpPassword: string
}

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

function loadCredentials(path: string): MailboxCredentials | undefined {
  if (!existsSync(path)) return undefined

  const creds = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MailboxCredentials>
  if (!creds.email || !creds.smtpPassword) return undefined
  return {
    email: creds.email,
    ...(creds.mailboxToken ? { mailboxToken: creds.mailboxToken } : {}),
    smtpPassword: creds.smtpPassword,
  }
}

function normalizeSenderPolicies(policies: SenderPolicy[] | undefined): SenderPolicy[] | undefined {
  const normalized = policies
    ?.map((policy) => ({
      sender: policy.sender.trim().toLowerCase(),
      ...(policy.dispatchContextRules ? { dispatchContextRules: policy.dispatchContextRules } : {}),
    }))
    .filter((policy) => Boolean(policy.sender))
  return normalized?.length ? normalized : undefined
}

export async function runJsonInit(configPath: string, rawInput: unknown) {
  const input = jsonInitInputSchema.parse(rawInput)
  const previousConfig = loadPreviousConfig(configPath)
  const previousAgents = new Map((previousConfig?.agents ?? []).map((agent) => [agent.name, agent]))
  const aampHost = input.aampHost ?? previousConfig?.aampHost ?? 'https://meshmail.ai'
  const rejectUnauthorized = input.rejectUnauthorized ?? previousConfig?.rejectUnauthorized ?? false
  const nextAgents = new Map((previousConfig?.agents ?? []).map((agent) => [agent.name, agent]))
  const results = []

  for (const requestedAgent of input.agents) {
    const previousAgent = previousAgents.get(requestedAgent.name)
    const acpCommand = requestedAgent.acpCommand
      ?? defaultAcpCommand(requestedAgent.name, previousAgent?.acpCommand)
    const credentialsFile = requestedAgent.credentialsFile
      ?? previousAgent?.credentialsFile
      ?? getDefaultCredentialsPath(requestedAgent.name)
    const resolvedCredentialsFile = resolveCredentialsFile(credentialsFile, requestedAgent.name)
    const pairingFile = requestedAgent.pairingFile
      ?? previousAgent?.pairingFile
      ?? defaultPairingFile(requestedAgent.name)
    const resolvedPairingFile = resolvePairingFile(pairingFile, requestedAgent.name)
    const senderPoliciesFile = requestedAgent.senderPoliciesFile
      ?? previousAgent?.senderPoliciesFile
      ?? defaultSenderPoliciesFile(requestedAgent.name)
    const slug = requestedAgent.slug
      ?? previousAgent?.slug
      ?? `${requestedAgent.name}-bridge`
    const description = requestedAgent.description
      ?? previousAgent?.description
      ?? `${requestedAgent.name} via ACP bridge`
    const senderPolicies = normalizeSenderPolicies(requestedAgent.senderPolicies as SenderPolicy[] | undefined)
      ?? previousAgent?.senderPolicies

    let credentials = loadCredentials(resolvedCredentialsFile)
    let registered = false
    if (!credentials) {
      const created = await AampClient.registerMailbox({
        aampHost,
        slug,
        description,
      })
      credentials = {
        email: created.email,
        mailboxToken: created.mailboxToken,
        smtpPassword: created.smtpPassword,
      }
      mkdirSync(dirname(resolvedCredentialsFile), { recursive: true })
      writeFileSync(resolvedCredentialsFile, `${JSON.stringify(credentials, null, 2)}\n`)
      registered = true
    }

    const agent: AgentConfig = {
      ...(previousAgent ?? {}),
      name: requestedAgent.name,
      acpCommand,
      slug,
      description,
      ...(requestedAgent.summary ?? previousAgent?.summary ? { summary: requestedAgent.summary ?? previousAgent?.summary } : {}),
      ...(requestedAgent.cardText ?? previousAgent?.cardText ? { cardText: requestedAgent.cardText ?? previousAgent?.cardText } : {}),
      credentialsFile,
      pairingFile,
      senderPoliciesFile,
      ...(senderPolicies ? { senderPolicies } : {}),
      ...(requestedAgent.taskDispatchConcurrency ?? previousAgent?.taskDispatchConcurrency
        ? { taskDispatchConcurrency: requestedAgent.taskDispatchConcurrency ?? previousAgent?.taskDispatchConcurrency }
        : {}),
    }
    delete agent.senderWhitelist
    nextAgents.set(requestedAgent.name, agent)

    const pairing = requestedAgent.createPairing
      ? createPairingCode({ mailbox: credentials.email, file: resolvedPairingFile })
      : undefined

    results.push({
      name: requestedAgent.name,
      bridge: 'acp-bridge',
      connection: 'acp_bridge',
      email: credentials.email,
      registered,
      credentialsFile: resolvedCredentialsFile,
      acpCommand,
      ...(pairing ? {
        pairing: {
          mailbox: pairing.mailbox,
          pairCode: pairing.pairCode,
          expiresAt: pairing.expiresAt,
          connectUrl: pairing.connectUrl,
          webUrl: pairingUrlToWebUrl(pairing.connectUrl),
          pairingFile: resolvedPairingFile,
        },
      } : {}),
    })
  }

  const config: BridgeConfig = {
    aampHost,
    rejectUnauthorized,
    agents: [...nextAgents.values()],
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  return {
    schemaVersion: 1,
    type: 'init.completed',
    bridge: 'acp-bridge',
    configPath,
    aampHost,
    agents: results,
  }
}
