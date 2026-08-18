import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'

export const agentExecutionLocationSchema = z.enum(['local', 'remote'])
export type AgentExecutionLocation = z.infer<typeof agentExecutionLocationSchema>

const senderPolicySchema = z.object({
  sender: z.string().min(1),
  dispatchContextRules: z.record(z.array(z.string().min(1))).optional(),
})

const acpCommandSchema = z.string().min(1).refine(
  (command) => command.trim().length > 0,
  { message: 'ACP command must contain a non-whitespace character' },
)

const agentConfigSchema = z.object({
  name: z.string().min(1),
  acpCommand: acpCommandSchema,
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  cardText: z.string().optional(),
  cardFile: z.string().optional(),
  credentialsFile: z.string().optional(),
  pairingFile: z.string().optional(),
  senderPoliciesFile: z.string().optional(),
  senderWhitelist: z.array(z.string().email()).optional(),
  senderPolicies: z.array(senderPolicySchema).optional(),
  taskDispatchConcurrency: z.number().int().positive().optional(),
  attachmentPolicy: z.enum(['allow', 'reject']).default('allow'),
  executionLocation: agentExecutionLocationSchema.default('local'),
}).superRefine((agent, context) => {
  if (agent.executionLocation === 'remote' && agent.attachmentPolicy !== 'reject') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attachmentPolicy'],
      message: 'remote Agent requires attachmentPolicy=reject',
    })
  }
})

const bridgeConfigSchema = z.object({
  aampHost: z.string().url(),
  rejectUnauthorized: z.boolean().default(false),
  agents: z.array(agentConfigSchema).min(1),
})

export type SenderPolicy = z.infer<typeof senderPolicySchema>
export type AgentConfigInput = z.input<typeof agentConfigSchema>
export type AgentConfig = z.output<typeof agentConfigSchema>
export type BridgeConfigInput = z.input<typeof bridgeConfigSchema>
export type BridgeConfig = z.output<typeof bridgeConfigSchema>

export function defaultAgentSlug(agentName: string): string {
  const normalizedName = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalizedName) {
    throw new Error(`Cannot derive a valid default Agent slug from name: ${JSON.stringify(agentName)}`)
  }
  return `${normalizedName}-bridge`
}

function normalizeSenderPolicies(
  senderPolicies: SenderPolicy[] | undefined,
  senderWhitelist: string[] | undefined,
): SenderPolicy[] | undefined {
  const sourcePolicies: SenderPolicy[] | undefined = senderPolicies?.length
    ? senderPolicies
    : senderWhitelist?.length
      ? senderWhitelist.map((sender): SenderPolicy => ({ sender }))
      : undefined

  if (!sourcePolicies?.length) return undefined

  const normalized = sourcePolicies
    .map((policy) => {
      let dispatchContextRules: Record<string, string[]> | undefined
      if (policy.dispatchContextRules) {
        dispatchContextRules = Object.fromEntries(
          Object.entries(policy.dispatchContextRules as Record<string, string[]>)
            .map(([key, values]) => [
              key.trim().toLowerCase(),
              values.map((value) => value.trim()).filter(Boolean),
            ])
            .filter(([key, values]) => Boolean(key) && values.length > 0),
        )
      }

      return {
        sender: policy.sender.trim().toLowerCase(),
        ...(dispatchContextRules && Object.keys(dispatchContextRules).length > 0
          ? { dispatchContextRules }
          : {}),
      }
    })
    .filter((policy) => Boolean(policy.sender))

  return normalized.length > 0 ? normalized : undefined
}

export function normalizeAgentConfig(agent: AgentConfigInput): AgentConfig {
  const parsed = agentConfigSchema.parse(agent)
  return {
    ...parsed,
    attachmentPolicy: parsed.attachmentPolicy,
    senderPolicies: normalizeSenderPolicies(parsed.senderPolicies, parsed.senderWhitelist),
  }
}

export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Run 'aamp-acp-bridge init' first.`)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  const parsed = bridgeConfigSchema.parse(raw)
  return {
    ...parsed,
    agents: parsed.agents.map(normalizeAgentConfig),
  }
}
