import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient, isPairingUrl, parsePairingUrl } from 'aamp-sdk'
import { getBridgeHomeDir } from './config.js'
import { FeishuBridgeRuntime } from './runtime.js'
import type { BridgeConfig as ImBridgeConfig } from './types.js'
import { FEISHU_BOE_DOMAIN, FEISHU_PRE_DOMAIN } from './task/config.js'
import { FeishuTaskBridgeRuntime } from './task/runtime.js'
import type { BridgeConfig as TaskBridgeConfig } from './task/types.js'

const TASK_RUNTIME_DIRNAME = 'task-runtime'
const BOTS_FILENAME = 'bots-v2.json'
const AGENTS_FILENAME = 'agents.json'
const CURRENT_RUN_FILENAME = 'current.json'
const CONFIG_FILENAME = 'config.json'
const SUPPORTED_AGENT_TYPES = ['codex', 'cursor', 'codem'] as const

type AgentType = typeof SUPPORTED_AGENT_TYPES[number]

export interface TaskRuntimeBotConfig {
  name: string
  app_id: string
  app_secret: string
  capabilities: Array<'im' | 'task'>
  updated_at: string
}

export interface TaskRuntimeAgentConfig {
  type: AgentType | string
  display_name: string
  target_agent_email: string
  updated_at: string
}

export interface TaskRuntimePair {
  agent: string
  app_id: string
  instance_id: string
}

interface TaskRuntimeBotStore {
  bots: TaskRuntimeBotConfig[]
}

interface TaskRuntimeAgentStore {
  agents: TaskRuntimeAgentConfig[]
}

interface TaskRuntimeRunStore {
  run_id: string
  pairs: TaskRuntimePair[]
  updated_at: string
}

interface PairSelection {
  agent: TaskRuntimeAgentConfig
  bot: TaskRuntimeBotConfig
  pairingUrl?: string
}

export interface TaskEnabledRunOptions {
  configDir?: string
  aampHost?: string
  agent?: string
  targetAgentEmail?: string
  pairingUrl?: string
  appId?: string
  appSecret?: string
  botName?: string
  domain?: string
  boe?: boolean
  pre?: boolean
  env?: string
  debug?: boolean
  json?: boolean
}

function taskRuntimeHome(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), TASK_RUNTIME_DIRNAME)
}

function botsPath(customDir?: string): string {
  return path.join(taskRuntimeHome(customDir), BOTS_FILENAME)
}

function agentsPath(customDir?: string): string {
  return path.join(taskRuntimeHome(customDir), AGENTS_FILENAME)
}

function runsDir(customDir?: string): string {
  return path.join(taskRuntimeHome(customDir), 'runs')
}

function currentRunPath(customDir?: string): string {
  return path.join(runsDir(customDir), CURRENT_RUN_FILENAME)
}

function instanceRoot(instanceId: string, customDir?: string): string {
  return path.join(taskRuntimeHome(customDir), 'instances', instanceId)
}

function imInstanceDir(instanceId: string, customDir?: string): string {
  return path.join(instanceRoot(instanceId, customDir), 'im')
}

function taskInstanceDir(instanceId: string, customDir?: string): string {
  return path.join(instanceRoot(instanceId, customDir), 'task')
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const parentDir = path.dirname(filePath)
  await mkdir(parentDir, { recursive: true })
  const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, filePath)
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function loadBots(customDir?: string): Promise<TaskRuntimeBotConfig[]> {
  const store = await readJsonFile<TaskRuntimeBotStore>(botsPath(customDir), { bots: [] })
  return dedupeBots(store.bots ?? [])
}

async function saveBots(bots: TaskRuntimeBotConfig[], customDir?: string): Promise<void> {
  await writeJsonAtomic(botsPath(customDir), { bots: dedupeBots(bots) })
}

async function loadAgents(customDir?: string): Promise<TaskRuntimeAgentConfig[]> {
  const store = await readJsonFile<TaskRuntimeAgentStore>(agentsPath(customDir), { agents: [] })
  return dedupeAgents(store.agents ?? [])
}

async function saveAgents(agents: TaskRuntimeAgentConfig[], customDir?: string): Promise<void> {
  await writeJsonAtomic(agentsPath(customDir), { agents: dedupeAgents(agents) })
}

function dedupeBots(bots: TaskRuntimeBotConfig[]): TaskRuntimeBotConfig[] {
  const byAppId = new Map<string, TaskRuntimeBotConfig>()
  for (const bot of bots) {
    const appId = bot.app_id.trim()
    if (!appId) continue
    byAppId.set(appId, {
      ...bot,
      app_id: appId,
      name: bot.name.trim() || appId,
      app_secret: bot.app_secret.trim(),
      capabilities: [...new Set([...(bot.capabilities ?? []), 'im', 'task'])] as Array<'im' | 'task'>,
      updated_at: bot.updated_at || new Date().toISOString(),
    })
  }
  return [...byAppId.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function dedupeAgents(agents: TaskRuntimeAgentConfig[]): TaskRuntimeAgentConfig[] {
  const byTarget = new Map<string, TaskRuntimeAgentConfig>()
  for (const agent of agents) {
    const target = agent.target_agent_email.trim()
    if (!target) continue
    byTarget.set(`${agent.type}:${target}`, {
      ...agent,
      type: agent.type.trim() || 'agent',
      display_name: agent.display_name.trim() || String(agent.type || target),
      target_agent_email: target,
      updated_at: agent.updated_at || new Date().toISOString(),
    })
  }
  return [...byTarget.values()].sort((left, right) => left.display_name.localeCompare(right.display_name))
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'instance'
}

function resolveInstanceId(agent: TaskRuntimeAgentConfig, bot: TaskRuntimeBotConfig): string {
  return normalizeId(`${agent.type}-${shortHash(agent.target_agent_email)}-${bot.app_id}`)
}

function resolveFeishuDomain(options: TaskEnabledRunOptions, existing?: string): string | undefined {
  return (options.domain ?? (options.boe ? FEISHU_BOE_DOMAIN : options.pre ? FEISHU_PRE_DOMAIN : existing) ?? '').trim() || undefined
}

function resolveFeishuHeaders(options: TaskEnabledRunOptions, existing?: Record<string, string>): Record<string, string> | undefined {
  const env = options.env?.trim()
  const headers = { ...(existing ?? {}) }
  delete headers['x-tt-env']
  delete headers['x-use-ppe']
  if (env) {
    headers['x-tt-env'] = env
    if (!options.boe) headers['x-use-ppe'] = '1'
  }
  return Object.keys(headers).length ? headers : undefined
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = await rl.question(`${question}${suffix}: `)
    return answer.trim() || defaultValue
  } finally {
    rl.close()
  }
}

async function promptYesNo(question: string, defaultValue = false): Promise<boolean> {
  const answer = (await prompt(question, defaultValue ? 'y' : 'n')).toLowerCase()
  return answer === 'y' || answer === 'yes'
}

async function chooseFromList<T>(
  title: string,
  items: T[],
  render: (item: T) => string,
): Promise<T | undefined> {
  if (!items.length) return undefined
  console.log(`\n${title}`)
  items.forEach((item, index) => {
    console.log(`  ${index + 1}) ${render(item)}`)
  })
  while (true) {
    const answer = await prompt('输入序号')
    const index = Number.parseInt(answer, 10)
    if (Number.isInteger(index) && index >= 1 && index <= items.length) {
      return items[index - 1]
    }
    console.log('请输入有效序号。')
  }
}

function agentDisplayName(type: string): string {
  return type === 'codex' ? 'Codex'
    : type === 'cursor' ? 'Cursor'
      : type === 'codem' ? 'CodeM'
        : type
}

async function selectAgent(customDir?: string, requested?: string, targetInput?: string): Promise<{ agent: TaskRuntimeAgentConfig, pairingUrl?: string }> {
  const agents = await loadAgents(customDir)
  const now = new Date().toISOString()
  if (requested || targetInput) {
    const agentType = (requested || 'agent').trim()
    const pairing = targetInput && isPairingUrl(targetInput) ? parsePairingUrl(targetInput) : undefined
    const targetAgentEmail = pairing?.mailbox ?? targetInput?.trim()
    if (!targetAgentEmail) throw new Error('Target AAMP agent email or pairing URL is required for --enable-task non-interactive mode.')
    const agent: TaskRuntimeAgentConfig = {
      type: agentType,
      display_name: agentDisplayName(agentType),
      target_agent_email: targetAgentEmail,
      updated_at: now,
    }
    await saveAgents([...agents, agent], customDir)
    return { agent, pairingUrl: pairing ? targetInput : undefined }
  }

  const options: Array<TaskRuntimeAgentConfig | { type: AgentType, create: true }> = [
    ...agents,
    ...SUPPORTED_AGENT_TYPES
      .filter((type) => !agents.some((agent) => agent.type === type))
      .map((type) => ({ type, create: true as const })),
  ]
  const selected = await chooseFromList('请选择 Agent:', options, (item) => {
    if ('create' in item) return `${agentDisplayName(item.type)} (新建本次目标)`
    return `${item.display_name} (${item.target_agent_email})`
  })
  if (!selected) throw new Error('No agent selected.')
  if (!('create' in selected)) return { agent: selected }

  const target = await prompt(`${agentDisplayName(selected.type)} pairing URL 或 target agent email`)
  const pairing = isPairingUrl(target) ? parsePairingUrl(target) : undefined
  const targetAgentEmail = pairing?.mailbox ?? target.trim()
  if (!targetAgentEmail) throw new Error('Target AAMP agent email is required.')
  const agent: TaskRuntimeAgentConfig = {
    type: selected.type,
    display_name: agentDisplayName(selected.type),
    target_agent_email: targetAgentEmail,
    updated_at: now,
  }
  await saveAgents([...agents, agent], customDir)
  return { agent, pairingUrl: pairing ? target : undefined }
}

async function selectBot(customDir: string | undefined, usedAppIds: Set<string>, appId?: string, appSecret?: string, botName?: string): Promise<TaskRuntimeBotConfig> {
  const bots = await loadBots(customDir)
  const now = new Date().toISOString()
  if (appId || appSecret || botName) {
    if (!appId || !appSecret) throw new Error('Both --app-id and --app-secret are required for --enable-task non-interactive mode.')
    const bot: TaskRuntimeBotConfig = {
      name: botName?.trim() || appId,
      app_id: appId.trim(),
      app_secret: appSecret.trim(),
      capabilities: ['im', 'task'],
      updated_at: now,
    }
    await saveBots([...bots, bot], customDir)
    return bot
  }

  const availableBots = bots.filter((bot) => !usedAppIds.has(bot.app_id))
  const createOption = { app_id: '', app_secret: '', name: '新建应用/选择其他应用', capabilities: ['im', 'task'] as Array<'im' | 'task'>, updated_at: now }
  const selected = await chooseFromList('请选择飞书 Bot 应用:', [...availableBots, createOption], (bot) => (
    bot.app_id ? `${bot.name} (${bot.app_id})` : bot.name
  ))
  if (!selected) throw new Error('No Feishu bot selected.')
  if (selected.app_id) return selected

  const name = await prompt('请输入本地展示的 Bot 名称', '飞书 CLI')
  const newAppId = await prompt('请输入 Feishu App ID')
  const newAppSecret = await prompt('请输入 Feishu App Secret')
  if (!newAppId || !newAppSecret) throw new Error('Feishu App ID and App Secret are required.')
  const bot: TaskRuntimeBotConfig = {
    name,
    app_id: newAppId.trim(),
    app_secret: newAppSecret.trim(),
    capabilities: ['im', 'task'],
    updated_at: now,
  }
  await saveBots([...bots, bot], customDir)
  return bot
}

function validatePairs(selections: PairSelection[]): TaskRuntimePair[] {
  const appToAgent = new Map<string, string>()
  const pairMap = new Map<string, TaskRuntimePair>()
  for (const selection of selections) {
    const existingAgent = appToAgent.get(selection.bot.app_id)
    if (existingAgent && existingAgent !== selection.agent.target_agent_email) {
      throw new Error(`Feishu bot ${selection.bot.name} (${selection.bot.app_id}) is selected for multiple agents in this run.`)
    }
    appToAgent.set(selection.bot.app_id, selection.agent.target_agent_email)
    const instanceId = resolveInstanceId(selection.agent, selection.bot)
    pairMap.set(`${selection.agent.target_agent_email}:${selection.bot.app_id}`, {
      agent: selection.agent.type,
      app_id: selection.bot.app_id,
      instance_id: instanceId,
    })
  }
  return [...pairMap.values()]
}

async function loadConfigIfExists<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(filePath)) return undefined
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function sendPairRequestIfNeeded(
  mailbox: ImBridgeConfig['mailbox'],
  pairingUrl: string | undefined,
): Promise<void> {
  if (!pairingUrl || !isPairingUrl(pairingUrl)) return
  const pairing = parsePairingUrl(pairingUrl)
  const client = AampClient.fromMailboxIdentity({
    email: mailbox.email,
    smtpPassword: mailbox.smtpPassword,
    baseUrl: mailbox.baseUrl,
  })
  await client.sendPairRequest({
    to: pairing.mailbox,
    pairCode: pairing.pairCode,
    dispatchContextRules: pairing.dispatchContextRules ?? { source: ['feishu', 'feishu-task'] },
  })
}

async function ensureMailboxConfig(
  options: {
    aampHost: string
    slug: string
    description: string
    existing?: ImBridgeConfig['mailbox']
  },
): Promise<ImBridgeConfig['mailbox']> {
  if (options.existing) {
    console.log(`[feishu task-runtime] using existing AAMP mailbox slug=${options.slug} email=${options.existing.email}`)
    return options.existing
  }
  console.log(`[feishu task-runtime] registering AAMP mailbox host=${options.aampHost} slug=${options.slug} slugLength=${options.slug.length}`)
  const mailbox = await AampClient.registerMailbox({
    aampHost: options.aampHost,
    slug: options.slug,
    description: options.description,
  })
  return {
    email: mailbox.email,
    mailboxToken: mailbox.mailboxToken,
    smtpPassword: mailbox.smtpPassword,
    baseUrl: mailbox.baseUrl,
  }
}

async function ensureInstanceConfigs(
  selection: PairSelection,
  options: TaskEnabledRunOptions,
): Promise<{ imConfig: ImBridgeConfig, taskConfig: TaskBridgeConfig, imDir: string, taskDir: string }> {
  const instanceId = resolveInstanceId(selection.agent, selection.bot)
  const imDir = imInstanceDir(instanceId, options.configDir)
  const taskDir = taskInstanceDir(instanceId, options.configDir)
  const imConfigPath = path.join(imDir, CONFIG_FILENAME)
  const taskConfigPath = path.join(taskDir, CONFIG_FILENAME)
  const existingIm = await loadConfigIfExists<ImBridgeConfig>(imConfigPath)
  const existingTask = await loadConfigIfExists<TaskBridgeConfig>(taskConfigPath)
  const aampHost = options.aampHost?.trim() || existingIm?.aampHost || existingTask?.aampHost || 'https://meshmail.ai'
  const feishuDomain = resolveFeishuDomain(options, existingIm?.feishu.domain ?? existingTask?.feishu.domain)
  const feishuHeaders = resolveFeishuHeaders(options, existingTask?.feishu.headers)
  const slugBase = instanceId
  const existingMailbox = existingIm?.mailbox ?? existingTask?.mailbox
  const sharedMailbox = await ensureMailboxConfig({
    aampHost,
    slug: slugBase,
    description: `Feishu bridge runtime for ${selection.agent.target_agent_email}`,
    existing: existingMailbox,
  })

  const imConfig: ImBridgeConfig = {
    version: 1,
    aampHost,
    targetAgentEmail: selection.agent.target_agent_email,
    slug: slugBase,
    feishu: {
      appId: selection.bot.app_id,
      appSecret: selection.bot.app_secret,
      ...(feishuDomain ? { domain: feishuDomain } : {}),
      authMode: 'app-secret',
    },
    mailbox: sharedMailbox,
    behavior: existingIm?.behavior ?? {
      streamThrottleMs: 700,
      streamThrottleChars: 40,
    },
  }
  const taskConfig: TaskBridgeConfig = {
    version: 1,
    aampHost,
    targetAgentEmail: selection.agent.target_agent_email,
    slug: slugBase,
    feishu: {
      appId: selection.bot.app_id,
      appSecret: selection.bot.app_secret,
      ...(feishuDomain ? { domain: feishuDomain } : {}),
      ...(feishuHeaders ? { headers: feishuHeaders } : {}),
      userIdType: existingTask?.feishu.userIdType ?? 'open_id',
      eventNames: existingTask?.feishu.eventNames ?? ['task.task.update_user_access_v2'],
    },
    mailbox: sharedMailbox,
    behavior: {
      ackComment: existingTask?.behavior.ackComment ?? true,
      debug: options.debug ? true : (existingTask?.behavior.debug ?? false),
    },
  }

  await writeJsonAtomic(imConfigPath, imConfig)
  await writeJsonAtomic(taskConfigPath, taskConfig)
  await sendPairRequestIfNeeded(sharedMailbox, selection.pairingUrl)
  return { imConfig, taskConfig, imDir, taskDir }
}

async function collectSelections(options: TaskEnabledRunOptions): Promise<PairSelection[]> {
  const selections: PairSelection[] = []
  const usedAppIds = new Set<string>()
  const nonInteractive = Boolean(options.agent || options.targetAgentEmail || options.pairingUrl || options.appId || options.appSecret)
  while (true) {
    const { agent, pairingUrl } = await selectAgent(options.configDir, options.agent, options.pairingUrl ?? options.targetAgentEmail)
    const bot = await selectBot(options.configDir, usedAppIds, options.appId, options.appSecret, options.botName)
    if (usedAppIds.has(bot.app_id)) throw new Error(`Feishu bot ${bot.name} (${bot.app_id}) was already selected in this run.`)
    selections.push({ agent, bot, pairingUrl })
    usedAppIds.add(bot.app_id)
    if (nonInteractive) break
    if (!await promptYesNo('是否继续添加实例？')) break
  }
  return selections
}

export async function runTaskEnabledBridge(options: TaskEnabledRunOptions): Promise<void> {
  await mkdir(taskRuntimeHome(options.configDir), { recursive: true })
  const selections = await collectSelections(options)
  const pairs = validatePairs(selections)
  await writeJsonAtomic(currentRunPath(options.configDir), {
    run_id: `${Date.now()}-${process.pid}`,
    pairs,
    updated_at: new Date().toISOString(),
  } satisfies TaskRuntimeRunStore)

  const runtimePairs = await Promise.all(selections.map(async (selection) => ({
    selection,
    ...(await ensureInstanceConfigs(selection, options)),
  })))

  const started: Array<{ im: FeishuBridgeRuntime, task: FeishuTaskBridgeRuntime }> = []
  for (const item of runtimePairs) {
    const im = new FeishuBridgeRuntime(item.imConfig, { configDir: item.imDir })
    const task = new FeishuTaskBridgeRuntime(item.taskConfig, { configDir: item.taskDir })
    try {
      if (options.json) {
        console.log(JSON.stringify({
          type: 'bridge.task_runtime.starting',
          agent: item.selection.agent.target_agent_email,
          appId: item.selection.bot.app_id,
          imConfigDir: item.imDir,
          taskConfigDir: item.taskDir,
        }))
      } else {
        console.log(`Starting IM + Task for ${item.selection.agent.display_name} using ${item.selection.bot.name}`)
      }
      await im.start()
      await task.start({
        registerFeishuEventHandlers: (handlers) => {
          im.registerRawFeishuEventHandlers(handlers)
        },
      })
      started.push({ im, task })
    } catch (error) {
      await im.stop().catch(() => {})
      await task.stop().catch(() => {})
      throw error
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      type: 'bridge.task_runtime.running',
      pairs,
      instances: started.length,
    }))
  } else {
    console.log(`Feishu bridge IM + Task is running for ${started.length} instance(s).`)
  }

  const shutdown = async (signal: string) => {
    if (!options.json) console.log(`Received ${signal}, shutting down...`)
    await Promise.all(started.flatMap(({ im, task }) => [
      im.stop().catch(() => {}),
      task.stop().catch(() => {}),
    ]))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  if (started.length === 0) throw new Error('No Feishu bridge task runtime instance started.')
}

export function getTaskRuntimeHome(customDir?: string): string {
  return taskRuntimeHome(customDir)
}
