import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient, isPairingUrl, parsePairingUrl } from 'aamp-sdk'
import type { BridgeConfig, BridgeState } from './types.js'
import { resolveFeishuCliCredentials } from './feishu-cli.js'

const CONFIG_FILENAME = 'config.json'
const STATE_FILENAME = 'state.json'
const INSTANCES_DIRNAME = 'instances'
const DEFAULT_BRIDGE_SLUG = 'feishu-bridge'

export interface BridgeConfigEntry {
  config: BridgeConfig
  configDir: string
  configPath: string
  legacy: boolean
}

export function getBridgeHomeDir(customDir?: string): string {
  return customDir
    ? path.resolve(customDir)
    : path.join(os.homedir(), '.aamp', 'feishu-bridge')
}

export function getConfigPath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), CONFIG_FILENAME)
}

export function getStatePath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), STATE_FILENAME)
}

export function getBridgeInstancesDir(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), INSTANCES_DIRNAME)
}

export function getBridgeInstanceDir(instanceSlug: string, customDir?: string): string {
  return path.join(getBridgeInstancesDir(customDir), instanceSlug)
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
  return JSON.parse(raw) as BridgeConfig
}

export async function saveBridgeConfig(config: BridgeConfig, customDir?: string): Promise<void> {
  await writeJsonAtomic(getConfigPath(customDir), config)
}

async function loadBridgeConfigFromDir(configDir: string, legacy = false): Promise<BridgeConfigEntry | null> {
  const configPath = path.join(configDir, CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  const raw = await readFile(configPath, 'utf8')
  return {
    config: JSON.parse(raw) as BridgeConfig,
    configDir,
    configPath,
    legacy,
  }
}

async function saveBridgeConfigToDir(config: BridgeConfig, configDir: string): Promise<void> {
  await writeJsonAtomic(path.join(configDir, CONFIG_FILENAME), config)
}

export async function loadBridgeConfigEntries(customDir?: string): Promise<BridgeConfigEntry[]> {
  const entries: BridgeConfigEntry[] = []
  const instancesDir = getBridgeInstancesDir(customDir)
  if (existsSync(instancesDir)) {
    const children = await readdir(instancesDir, { withFileTypes: true })
    for (const child of children) {
      if (!child.isDirectory()) continue
      const entry = await loadBridgeConfigFromDir(path.join(instancesDir, child.name))
      if (entry) entries.push(entry)
    }
  }

  const legacyEntry = await loadBridgeConfigFromDir(getBridgeHomeDir(customDir), true)
  if (legacyEntry && !entries.some((entry) => entry.config.targetAgentEmail === legacyEntry.config.targetAgentEmail)) {
    entries.push(legacyEntry)
  }

  return entries.sort((left, right) => left.config.slug.localeCompare(right.config.slug))
}

export function createDefaultBridgeState(): BridgeState {
  return {
    version: 1,
    connectivity: {
      feishu: 'disconnected',
      aamp: 'disconnected',
    },
    conversations: {},
    tasks: {},
    dedupMessageIds: {},
  }
}

export async function loadBridgeState(customDir?: string): Promise<BridgeState> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) {
    return createDefaultBridgeState()
  }
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<BridgeState>
  return {
    ...createDefaultBridgeState(),
    ...parsed,
    connectivity: {
      ...createDefaultBridgeState().connectivity,
      ...(parsed.connectivity ?? {}),
    },
    conversations: parsed.conversations ?? {},
    tasks: parsed.tasks ?? {},
    dedupMessageIds: parsed.dedupMessageIds ?? {},
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

export interface RemoveBridgeConfigOptions {
  configDir?: string
  targetAgentEmail?: string
  slug?: string
}

export async function removeBridgeConfigEntry(options: RemoveBridgeConfigOptions): Promise<BridgeConfigEntry | null> {
  const targetAgentEmail = options.targetAgentEmail?.trim()
  const slug = options.slug?.trim()
  if (!targetAgentEmail && !slug) {
    throw new Error('Target agent email or slug is required.')
  }

  const entries = await loadBridgeConfigEntries(options.configDir)
  const matched = entries.find((entry) => (
    (targetAgentEmail && entry.config.targetAgentEmail === targetAgentEmail)
      || (slug && entry.config.slug === slug)
  ))
  if (!matched) return null

  if (matched.legacy) {
    await rm(matched.configPath, { force: true })
    await rm(path.join(matched.configDir, STATE_FILENAME), { force: true })
  } else {
    await rm(matched.configDir, { recursive: true, force: true })
  }
  return matched
}

export interface InitBridgeOptions {
  configDir?: string
  aampHost?: string
  targetAgentEmail?: string
  pairingUrl?: string
  slug?: string
  appId?: string
  appSecret?: string
  useFeishuCli?: boolean
  feishuCliNew?: boolean
  feishuCliProfile?: string
  feishuCliBin?: string
  feishuCliAppName?: string
  feishuCliOpen?: boolean
  domain?: string
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output })
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue)
    })
  })
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

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function defaultSlugForTarget(targetAgentEmail: string): string {
  const localPart = targetAgentEmail.split('@')[0] || DEFAULT_BRIDGE_SLUG
  return normalizeSlug(`${localPart}-${shortHash(targetAgentEmail)}`)
}

export async function initializeBridgeConfig(options: InitBridgeOptions): Promise<BridgeConfig> {
  const entries = await loadBridgeConfigEntries(options.configDir)
  const defaultExisting = entries[0]?.config

  const aampHost = (options.aampHost ?? defaultExisting?.aampHost ?? await prompt('AAMP host', 'https://meshmail.ai')).trim()
  const targetInput = (options.pairingUrl ?? options.targetAgentEmail ?? defaultExisting?.targetAgentEmail ?? await prompt('Target AAMP agent email or pairing URL')).trim()
  const pairing = isPairingUrl(targetInput)
    ? parsePairingUrl(targetInput)
    : undefined
  const targetAgentEmail = pairing?.mailbox ?? targetInput
  const matchedEntry = entries.find((entry) => entry.config.targetAgentEmail === targetAgentEmail)
  const existing = matchedEntry?.config
  const feishuCliCredentials = (options.useFeishuCli || options.feishuCliNew) && (!options.appId || !options.appSecret)
    ? await resolveFeishuCliCredentials({
      cliBin: options.feishuCliBin,
      createNew: options.feishuCliNew,
      profile: options.feishuCliProfile,
      appName: options.feishuCliAppName ?? options.slug,
      brand: options.domain === 'lark' ? 'lark' : 'feishu',
      openSetupUrl: options.feishuCliOpen,
    })
    : undefined
  const useCliAuth = Boolean(options.useFeishuCli || options.feishuCliNew)
  const appId = (options.appId ?? feishuCliCredentials?.appId ?? existing?.feishu.appId ?? await prompt('Feishu App ID')).trim()
  const appSecret = (options.appSecret ?? feishuCliCredentials?.appSecret ?? existing?.feishu.appSecret ?? (useCliAuth ? '' : await prompt('Feishu App Secret'))).trim()
  const slug = normalizeSlug(options.slug ?? existing?.slug ?? defaultSlugForTarget(targetAgentEmail))
  const domain = (options.domain ?? existing?.feishu.domain ?? '').trim() || undefined

  if (!targetAgentEmail) throw new Error('Target AAMP agent email is required.')
  if (!appId) throw new Error('Feishu App ID is required.')
  if (!useCliAuth && !appSecret) throw new Error('Feishu App ID and App Secret are required.')
  const instanceDir = matchedEntry && !matchedEntry.legacy
    ? matchedEntry.configDir
    : getBridgeInstanceDir(slug, options.configDir)

  const mailbox = existing?.mailbox ?? await AampClient.registerMailbox({
    aampHost,
    slug,
    description: `Feishu bridge for ${targetAgentEmail}`,
  })

  const config: BridgeConfig = {
    version: 1,
    aampHost,
    targetAgentEmail,
    slug,
    feishu: {
      appId,
      ...(appSecret ? { appSecret } : {}),
      ...(domain ? { domain } : {}),
      authMode: useCliAuth ? 'lark-cli' : 'app-secret',
      ...(useCliAuth ? { cliProfile: feishuCliCredentials?.profile ?? options.feishuCliProfile ?? options.feishuCliAppName ?? slug } : {}),
      ...(useCliAuth && options.feishuCliBin ? { cliBin: options.feishuCliBin } : {}),
    },
    mailbox: {
      email: mailbox.email,
      mailboxToken: mailbox.mailboxToken,
      smtpPassword: mailbox.smtpPassword,
      baseUrl: mailbox.baseUrl,
    },
    behavior: {
      streamThrottleMs: existing?.behavior.streamThrottleMs ?? 700,
      streamThrottleChars: existing?.behavior.streamThrottleChars ?? 40,
    },
  }

  await ensureBridgeHomeDir(options.configDir)
  await mkdir(instanceDir, { recursive: true })
  await saveBridgeConfigToDir(config, instanceDir)
  if (pairing) {
    const client = AampClient.fromMailboxIdentity({
      email: config.mailbox.email,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    await client.sendPairRequest({
      to: pairing.mailbox,
      pairCode: pairing.pairCode,
      dispatchContextRules: pairing.dispatchContextRules ?? { source: ['feishu'] },
    })
  }
  return config
}
