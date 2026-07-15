import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient, isPairingUrl, parsePairingUrl } from 'aamp-sdk'
import type { BridgeConfig, BridgeState } from './types.js'

const CONFIG_FILENAME = 'config.json'
const STATE_FILENAME = 'state.json'
const DEFAULT_BRIDGE_SLUG = 'feishu-task-bridge'
export const FEISHU_BOE_DOMAIN = 'https://open.feishu-boe.cn'
export const FEISHU_PRE_DOMAIN = 'https://open.feishu-pre.cn'
const X_TT_ENV_HEADER = 'x-tt-env'
const X_USE_PPE_HEADER = 'x-use-ppe'
const DEFAULT_EVENT_NAMES = [
  'task.task.update_user_access_v2',
]
const LEGACY_DEFAULT_EVENT_NAMES = [
  'task.task.updated_v1',
  'task.task.update_tenant_v1',
]

export function getBridgeHomeDir(customDir?: string): string {
  return customDir
    ? path.resolve(customDir)
    : path.join(os.homedir(), '.aamp', 'feishu-task-bridge')
}

export function getConfigPath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), CONFIG_FILENAME)
}

export function getStatePath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), STATE_FILENAME)
}

export async function ensureBridgeHomeDir(customDir?: string): Promise<string> {
  const dir = getBridgeHomeDir(customDir)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const parentDir = path.dirname(filePath)
  await mkdir(parentDir, { recursive: true })
  const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, filePath)
}

export async function loadBridgeConfig(customDir?: string): Promise<BridgeConfig | null> {
  const filePath = getConfigPath(customDir)
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf8')
  return normalizeBridgeConfig(JSON.parse(raw) as Partial<BridgeConfig>)
}

export async function saveBridgeConfig(config: BridgeConfig, customDir?: string): Promise<void> {
  await writeJsonAtomic(getConfigPath(customDir), config)
}

export function createDefaultBridgeState(): BridgeState {
  return {
    version: 1,
    connectivity: {
      feishu: 'disconnected',
      aamp: 'disconnected',
    },
    tasks: {},
    dedupEventIds: {},
    dedupSemanticEventKeys: {},
    ackCommentedEventKeys: {},
    permissionDeniedCommentNoticeKeys: {},
  }
}

export async function loadBridgeState(customDir?: string): Promise<BridgeState> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) return createDefaultBridgeState()
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<BridgeState>
  const defaults = createDefaultBridgeState()
  return {
    ...defaults,
    ...parsed,
    connectivity: {
      ...defaults.connectivity,
      ...(parsed.connectivity ?? {}),
    },
    tasks: parsed.tasks ?? {},
    dedupEventIds: parsed.dedupEventIds ?? {},
    dedupSemanticEventKeys: parsed.dedupSemanticEventKeys ?? {},
    ackCommentedEventKeys: parsed.ackCommentedEventKeys ?? {},
    permissionDeniedCommentNoticeKeys: parsed.permissionDeniedCommentNoticeKeys ?? {},
  }
}

export async function saveBridgeState(state: BridgeState, customDir?: string): Promise<void> {
  await writeJsonAtomic(getStatePath(customDir), state)
}

export async function resetBridgeState(customDir?: string): Promise<void> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) return
  await rm(filePath, { force: true })
}

export interface InitBridgeOptions {
  configDir?: string
  aampHost?: string
  targetAgentEmail?: string
  pairingUrl?: string
  slug?: string
  appId?: string
  appSecret?: string
  domain?: string
  boe?: boolean
  pre?: boolean
  env?: string
  eventNames?: string[]
  userIdType?: 'open_id' | 'user_id' | 'union_id'
  ackComment?: boolean
  debug?: boolean
}

export interface FeishuRuntimeOverrides {
  domain?: string
  boe?: boolean
  pre?: boolean
  env?: string
  debug?: boolean
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    const answer = await rl.question(`${question}${suffix}: `)
    return answer.trim() || defaultValue
  } finally {
    rl.close()
  }
}

function normalizeSlug(rawValue: string): string {
  return rawValue
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || DEFAULT_BRIDGE_SLUG
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers ?? {})
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => Boolean(key) && Boolean(value)),
  )
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

type FeishuHeaderMode = 'boe' | 'pre' | 'ppe'

function withoutManagedEnvHeaders(
  headers: Record<string, string> | undefined,
  removePpeHeader: boolean,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => {
      const normalizedKey = key.trim().toLowerCase()
      return normalizedKey !== X_TT_ENV_HEADER && (!removePpeHeader || normalizedKey !== X_USE_PPE_HEADER)
    }),
  )
}

function resolveFeishuHeaderMode(
  boe: boolean | undefined,
  pre: boolean | undefined,
  env: string | undefined,
): FeishuHeaderMode | undefined {
  if (boe) return 'boe'
  if (pre) return 'pre'
  return normalizeEnv(env) ? 'ppe' : undefined
}

function normalizeFeishuHeaders(
  headers: Record<string, string> | undefined,
  env?: string | undefined,
  mode?: FeishuHeaderMode | undefined,
): Record<string, string> | undefined {
  const normalizedEnv = normalizeEnv(env)
  const removePpeHeader = mode === 'boe' || mode === 'pre' || mode === 'ppe'
  const unmanagedHeaders = withoutManagedEnvHeaders(headers, removePpeHeader)
  return normalizeHeaders({
    ...unmanagedHeaders,
    ...(normalizedEnv && (mode === 'pre' || mode === 'ppe') ? { [X_USE_PPE_HEADER]: '1' } : {}),
    ...(normalizedEnv ? { [X_TT_ENV_HEADER]: normalizedEnv } : {}),
  })
}

function resolveFeishuDomain(
  existingDomain: string | undefined,
  overrideDomain: string | undefined,
  boe: boolean | undefined,
  pre: boolean | undefined,
): string | undefined {
  return (overrideDomain ?? (boe ? FEISHU_BOE_DOMAIN : pre ? FEISHU_PRE_DOMAIN : existingDomain) ?? '').trim() || undefined
}

function normalizeEventNames(values: string[] | undefined): string[] {
  const normalized = (values ?? DEFAULT_EVENT_NAMES)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return normalized.length ? [...new Set(normalized)] : DEFAULT_EVENT_NAMES
}

function hasSameEventNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightValues = new Set(right)
  return left.every((value) => rightValues.has(value))
}

function normalizeConfiguredEventNames(values: string[] | undefined): string[] {
  const normalized = normalizeEventNames(values)
  return hasSameEventNames(normalized, LEGACY_DEFAULT_EVENT_NAMES)
    ? DEFAULT_EVENT_NAMES
    : normalized
}

function normalizeBridgeConfig(config: Partial<BridgeConfig>): BridgeConfig {
  if (!config.aampHost || !config.targetAgentEmail || !config.slug || !config.feishu || !config.mailbox) {
    throw new Error('Bridge config is incomplete. Run "aamp-feishu-task-bridge init" again.')
  }
  return {
    version: 1,
    aampHost: config.aampHost,
    targetAgentEmail: config.targetAgentEmail,
    slug: config.slug,
    feishu: {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      userIdType: config.feishu.userIdType ?? 'open_id',
      eventNames: normalizeConfiguredEventNames(config.feishu.eventNames),
    },
    mailbox: config.mailbox,
    behavior: {
      ackComment: config.behavior?.ackComment ?? true,
      debug: false,
    },
  }
}

export function applyFeishuRuntimeOverrides(
  config: BridgeConfig,
  overrides: FeishuRuntimeOverrides,
): BridgeConfig {
  const domain = resolveFeishuDomain(undefined, overrides.domain, overrides.boe, overrides.pre)
  const headerMode = resolveFeishuHeaderMode(overrides.boe, overrides.pre, overrides.env)
  const headers = normalizeFeishuHeaders(undefined, overrides.env, headerMode)
  const feishu: BridgeConfig['feishu'] = { ...config.feishu }
  if (domain) feishu.domain = domain
  else delete feishu.domain
  if (headers) feishu.headers = headers
  else delete feishu.headers
  const behavior: BridgeConfig['behavior'] = {
    ...config.behavior,
    debug: overrides.debug === true,
  }

  return {
    ...config,
    feishu,
    behavior,
  }
}

export async function initializeBridgeConfig(options: InitBridgeOptions): Promise<BridgeConfig> {
  const existing = await loadBridgeConfig(options.configDir).catch(() => null)

  const aampHost = (options.aampHost ?? existing?.aampHost ?? await prompt('AAMP host', 'https://meshmail.ai')).trim()
  const targetInput = (options.pairingUrl ?? options.targetAgentEmail ?? existing?.targetAgentEmail ?? await prompt('Target AAMP agent email or pairing URL')).trim()
  const pairing = isPairingUrl(targetInput)
    ? parsePairingUrl(targetInput)
    : undefined
  const targetAgentEmail = pairing?.mailbox ?? targetInput
  const appId = (options.appId ?? existing?.feishu.appId ?? await prompt('Feishu App ID')).trim()
  const appSecret = (options.appSecret ?? existing?.feishu.appSecret ?? await prompt('Feishu App Secret')).trim()
  const slug = normalizeSlug(options.slug ?? existing?.slug ?? DEFAULT_BRIDGE_SLUG)
  const eventNames = options.eventNames
    ? normalizeEventNames(options.eventNames)
    : normalizeConfiguredEventNames(existing?.feishu.eventNames)
  const userIdType = options.userIdType ?? existing?.feishu.userIdType ?? 'open_id'
  const ackComment = options.ackComment ?? existing?.behavior.ackComment ?? true
  const debug = false

  if (!targetAgentEmail) throw new Error('Target AAMP agent email is required.')
  if (!appId || !appSecret) throw new Error('Feishu App ID and App Secret are required.')

  const mailbox = existing?.mailbox ?? await AampClient.registerMailbox({
    aampHost,
    slug,
    description: `Feishu task bridge for ${targetAgentEmail}`,
  })

  const config: BridgeConfig = {
    version: 1,
    aampHost,
    targetAgentEmail,
    slug,
    feishu: {
      appId,
      appSecret,
      userIdType,
      eventNames,
    },
    mailbox: {
      email: mailbox.email,
      mailboxToken: mailbox.mailboxToken,
      smtpPassword: mailbox.smtpPassword,
      baseUrl: mailbox.baseUrl,
    },
    behavior: {
      ackComment,
      debug,
    },
  }

  await ensureBridgeHomeDir(options.configDir)
  await saveBridgeConfig(config, options.configDir)

  if (pairing) {
    const client = AampClient.fromMailboxIdentity({
      email: config.mailbox.email,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    try {
      await client.sendPairRequest({
        to: pairing.mailbox,
        pairCode: pairing.pairCode,
        dispatchContextRules: pairing.dispatchContextRules ?? { source: ['feishu-task'] },
      })
    } catch (error) {
      throw new Error(`AAMP pair request failed for ${pairing.mailbox}: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  return config
}
