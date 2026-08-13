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
import {
  TASK_PROFILE_FILENAME,
  buildTaskProfileFeishuConfig,
  buildTaskProfileTaskFeishuConfig,
  dedupeTaskProfiles,
  normalizeTaskProfile,
  resolveTaskProfileSelection,
  resolveTaskProfileName,
  type TaskProfileConfig,
  type TaskProfileStore,
} from './task-runtime-profile.js'
import { describeError, isRetryableAampNetworkError, isSmtpAuthError } from './task-runtime-errors.js'

const TASK_RUNTIME_DIRNAME = 'task-runtime'
const AGENTS_FILENAME = 'agents.json'
const CURRENT_RUN_FILENAME = 'current.json'
const ACTIVE_RUNS_FILENAME = 'active.json'
const CONFIG_FILENAME = 'config.json'
const SUPPORTED_AGENT_TYPES = ['codex', 'cursor', 'codem'] as const
const PAIR_REQUEST_AUTH_RETRY_COUNT = 8
const PAIR_REQUEST_AUTH_RETRY_DELAY_MS = 1_000

type AgentType = typeof SUPPORTED_AGENT_TYPES[number]

export type TaskRuntimeBotConfig = TaskProfileConfig

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

interface TaskRuntimeAgentStore {
  agents: TaskRuntimeAgentConfig[]
}

interface TaskRuntimeRunStore {
  run_id: string
  pairs: TaskRuntimePair[]
  updated_at: string
}

interface TaskRuntimeActiveRunStore {
  version: 1
  runs: TaskRuntimeRunStore[]
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
  useFeishuCli?: boolean
  feishuCliProfile?: string
  feishuCliBin?: string
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
  return path.join(taskRuntimeHome(customDir), TASK_PROFILE_FILENAME)
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

function activeRunsPath(customDir?: string): string {
  return path.join(runsDir(customDir), ACTIVE_RUNS_FILENAME)
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
  const store = await readJsonFile<TaskProfileStore>(botsPath(customDir), { version: 1, profiles: [] })
  return dedupeTaskProfiles(store.profiles ?? [])
}

async function saveBots(bots: TaskRuntimeBotConfig[], customDir?: string): Promise<void> {
  await writeJsonAtomic(botsPath(customDir), { version: 1, profiles: dedupeTaskProfiles(bots) } satisfies TaskProfileStore)
}

async function loadAgents(customDir?: string): Promise<TaskRuntimeAgentConfig[]> {
  const store = await readJsonFile<TaskRuntimeAgentStore>(agentsPath(customDir), { agents: [] })
  return dedupeAgents(store.agents ?? [])
}

async function saveAgents(agents: TaskRuntimeAgentConfig[], customDir?: string): Promise<void> {
  await writeJsonAtomic(agentsPath(customDir), { agents: dedupeAgents(agents) })
}

function isPidAliveFromRunId(runId: string): boolean {
  const pid = Number(/-(\d+)$/.exec(runId)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function upsertActiveRun(run: TaskRuntimeRunStore, customDir?: string): Promise<void> {
  const store = await readJsonFile<TaskRuntimeActiveRunStore>(activeRunsPath(customDir), { version: 1, runs: [] })
  const runs = [
    ...store.runs.filter((item) => item.run_id !== run.run_id && isPidAliveFromRunId(item.run_id)),
    run,
  ]
  await writeJsonAtomic(activeRunsPath(customDir), { version: 1, runs } satisfies TaskRuntimeActiveRunStore)
}

async function removeActiveRun(runId: string, customDir?: string): Promise<void> {
  const store = await readJsonFile<TaskRuntimeActiveRunStore>(activeRunsPath(customDir), { version: 1, runs: [] })
  const runs = store.runs.filter((item) => item.run_id !== runId && isPidAliveFromRunId(item.run_id))
  await writeJsonAtomic(activeRunsPath(customDir), { version: 1, runs } satisfies TaskRuntimeActiveRunStore)
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

export function resolveTaskRuntimeFeishuDomain(options: Pick<TaskEnabledRunOptions, 'boe' | 'domain' | 'pre'>): string | undefined {
  return (options.domain ?? (options.boe ? FEISHU_BOE_DOMAIN : options.pre ? FEISHU_PRE_DOMAIN : undefined) ?? '').trim() || undefined
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

async function selectBot(
  customDir: string | undefined,
  usedAppIds: Set<string>,
  appId?: string,
  cliProfile?: string,
  botName?: string,
): Promise<TaskRuntimeBotConfig> {
  const bots = await loadBots(customDir)
  const now = new Date().toISOString()
  if (appId || cliProfile || botName) {
    if (!appId) throw new Error('Feishu App ID is required for --enable-task profile mode.')
    const bot = resolveTaskProfileSelection(bots, {
      app_id: appId,
      profile: cliProfile,
      display_name: botName,
      updated_at: now,
    })
    await saveBots([...bots, bot], customDir)
    return bot
  }

  const availableBots = bots.filter((bot) => !usedAppIds.has(bot.app_id))
  const createOption = normalizeTaskProfile({
    app_id: '__create__',
    profile: '__create__',
    display_name: '新建应用/选择其他应用',
    updated_at: now,
  })
  const selected = await chooseFromList('请选择飞书 Bot 应用:', [...availableBots, createOption], (bot) => (
    bot.app_id !== '__create__' ? `${bot.display_name ?? bot.app_id} (${bot.app_id}) profile=${bot.profile}` : bot.display_name ?? '新建应用/选择其他应用'
  ))
  if (!selected) throw new Error('No Feishu bot selected.')
  if (selected.app_id !== '__create__') return selected

  const newAppId = await prompt('请输入 Feishu App ID')
  const displayName = await prompt('请输入本地展示的 Bot 名称', '飞书 CLI')
  const bot = normalizeTaskProfile({
    app_id: newAppId,
    display_name: displayName,
    updated_at: now,
  })
  await saveBots([...bots, bot], customDir)
  return bot
}

function validatePairs(selections: PairSelection[]): TaskRuntimePair[] {
  const appToAgent = new Map<string, string>()
  const pairMap = new Map<string, TaskRuntimePair>()
  for (const selection of selections) {
    const existingAgent = appToAgent.get(selection.bot.app_id)
    if (existingAgent && existingAgent !== selection.agent.target_agent_email) {
      throw new Error(`Feishu bot ${selection.bot.app_id} is selected for multiple agents in this run.`)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendPairRequestIfNeeded(
  mailbox: ImBridgeConfig['mailbox'],
  pairingUrl: string | undefined,
  options: { retrySmtpAuth?: boolean } = {},
): Promise<void> {
  if (!pairingUrl || !isPairingUrl(pairingUrl)) return
  const retrySmtpAuth = options.retrySmtpAuth ?? true
  const pairing = parsePairingUrl(pairingUrl)
  const client = AampClient.fromMailboxIdentity({
    email: mailbox.email,
    smtpPassword: mailbox.smtpPassword,
    baseUrl: mailbox.baseUrl,
  })
  for (let attempt = 1; attempt <= PAIR_REQUEST_AUTH_RETRY_COUNT; attempt += 1) {
    try {
      await client.sendPairRequest({
        to: pairing.mailbox,
        pairCode: pairing.pairCode,
        dispatchContextRules: pairing.dispatchContextRules ?? { source: ['feishu', 'feishu-task'] },
      })
      return
    } catch (error) {
      const canRetrySmtpAuth = retrySmtpAuth && isSmtpAuthError(error)
      if (attempt < PAIR_REQUEST_AUTH_RETRY_COUNT && (canRetrySmtpAuth || isRetryableAampNetworkError(error))) {
        const reason = canRetrySmtpAuth ? 'SMTP auth not ready' : 'network temporarily unavailable'
        console.warn(`[feishu task-runtime] AAMP pair request ${reason} from=${mailbox.email} attempt=${attempt}/${PAIR_REQUEST_AUTH_RETRY_COUNT}; retrying in ${PAIR_REQUEST_AUTH_RETRY_DELAY_MS}ms: ${describeError(error)}`)
        await sleep(PAIR_REQUEST_AUTH_RETRY_DELAY_MS)
        continue
      }
      console.error(`[feishu task-runtime] AAMP pair request failed from=${mailbox.email} to=${pairing.mailbox} host=${mailbox.baseUrl}: ${describeError(error)}`)
      throw error
    }
  }
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
  let mailbox: Awaited<ReturnType<typeof AampClient.registerMailbox>>
  try {
    mailbox = await AampClient.registerMailbox({
      aampHost: options.aampHost,
      slug: options.slug,
      description: options.description,
    })
  } catch (error) {
    console.error(`[feishu task-runtime] AAMP mailbox registration failed host=${options.aampHost} slug=${options.slug}: ${describeError(error)}`)
    throw error
  }
  return {
    email: mailbox.email,
    mailboxToken: mailbox.mailboxToken,
    smtpPassword: mailbox.smtpPassword,
    baseUrl: mailbox.baseUrl,
  }
}

export function resolveTaskRuntimeBehavior(
  options: Pick<TaskEnabledRunOptions, 'debug'>,
  existingBehavior?: TaskBridgeConfig['behavior'],
): TaskBridgeConfig['behavior'] {
  return {
    ackComment: existingBehavior?.ackComment ?? true,
    debug: options.debug === true,
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
  const feishuDomain = resolveTaskRuntimeFeishuDomain(options)
  const feishuHeaders = resolveFeishuHeaders(options, existingTask?.feishu.headers)
  const taskAppSecret = options.appSecret?.trim()
    || existingTask?.feishu.appSecret?.trim()
    || existingIm?.feishu.appSecret?.trim()
    || selection.bot.app_secret?.trim()
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
      ...buildTaskProfileFeishuConfig(selection.bot, { appSecret: taskAppSecret }),
      ...(feishuDomain ? { domain: feishuDomain } : {}),
      ...(options.feishuCliBin ? { cliBin: options.feishuCliBin } : {}),
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
      ...buildTaskProfileTaskFeishuConfig(selection.bot, { appSecret: taskAppSecret }),
      ...(options.feishuCliBin ? { cliBin: options.feishuCliBin } : {}),
      ...(feishuDomain ? { domain: feishuDomain } : {}),
      ...(feishuHeaders ? { headers: feishuHeaders } : {}),
      userIdType: existingTask?.feishu.userIdType ?? 'open_id',
      eventNames: existingTask?.feishu.eventNames ?? ['task.task.update_user_access_v2'],
    },
    mailbox: sharedMailbox,
    behavior: resolveTaskRuntimeBehavior(options, existingTask?.behavior),
  }

  await writeJsonAtomic(imConfigPath, imConfig)
  await writeJsonAtomic(taskConfigPath, taskConfig)
  try {
    await sendPairRequestIfNeeded(sharedMailbox, selection.pairingUrl, { retrySmtpAuth: !existingMailbox })
  } catch (error) {
    if (!existingMailbox || !isSmtpAuthError(error)) throw error
    console.warn(`[feishu task-runtime] existing AAMP mailbox SMTP credentials are invalid; re-registering mailbox slug=${slugBase} email=${existingMailbox.email}`)
    const refreshedMailbox = await ensureMailboxConfig({
      aampHost,
      slug: slugBase,
      description: `Feishu bridge runtime for ${selection.agent.target_agent_email}`,
    })
    imConfig.mailbox = refreshedMailbox
    taskConfig.mailbox = refreshedMailbox
    await writeJsonAtomic(imConfigPath, imConfig)
    await writeJsonAtomic(taskConfigPath, taskConfig)
    await sendPairRequestIfNeeded(refreshedMailbox, selection.pairingUrl)
  }
  return { imConfig, taskConfig, imDir, taskDir }
}

async function collectSelections(options: TaskEnabledRunOptions): Promise<PairSelection[]> {
  const selections: PairSelection[] = []
  const usedAppIds = new Set<string>()
  const nonInteractive = Boolean(options.agent || options.targetAgentEmail || options.pairingUrl || options.appId || options.feishuCliProfile)
  while (true) {
    const { agent, pairingUrl } = await selectAgent(options.configDir, options.agent, options.pairingUrl ?? options.targetAgentEmail)
    const bot = await selectBot(options.configDir, usedAppIds, options.appId, options.feishuCliProfile, options.botName)
    if (usedAppIds.has(bot.app_id)) throw new Error(`Feishu bot ${bot.app_id} was already selected in this run.`)
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
  const run: TaskRuntimeRunStore = {
    run_id: `${Date.now()}-${process.pid}`,
    pairs,
    updated_at: new Date().toISOString(),
  }
  await writeJsonAtomic(currentRunPath(options.configDir), run)
  await upsertActiveRun(run, options.configDir)

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
        console.log(`Starting IM + Task for ${item.selection.agent.display_name} using ${item.selection.bot.app_id}`)
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
      await removeActiveRun(run.run_id, options.configDir).catch(() => {})
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
    await removeActiveRun(run.run_id, options.configDir).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  if (started.length === 0) throw new Error('No Feishu bridge task runtime instance started.')
}

export function getTaskRuntimeHome(customDir?: string): string {
  return taskRuntimeHome(customDir)
}
