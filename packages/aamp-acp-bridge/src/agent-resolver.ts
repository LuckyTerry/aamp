import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value)
}

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex'
const CODEX_APP_ACP_COMMAND = `env CODEX_PATH=${CODEX_APP_CLI} npx -y @agentclientprotocol/codex-acp`
export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
export const WORKBUDDY_AI_APP_CLI = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_APP_CONFIG_DIR = join(homedir(), '.workbuddy')
const WORKBUDDY_AI_APP_CONFIG_DIR = join(homedir(), '.workbuddy-ai')
const WORKBUDDY_APP_LEGACY_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`
const WORKBUDDY_AI_APP_LEGACY_ACP_COMMAND = `'${WORKBUDDY_AI_APP_CLI}' --acp`
const WORKBUDDY_APP_PRE_MARKETPLACE_BYPASS_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_APP_CONFIG_DIR)}`,
  shellWord(WORKBUDDY_APP_CLI),
  '--acp',
].join(' ')
const WORKBUDDY_AI_APP_PRE_MARKETPLACE_BYPASS_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_AI_APP_CONFIG_DIR)}`,
  shellWord(WORKBUDDY_AI_APP_CLI),
  '--acp',
].join(' ')
const WORKBUDDY_APP_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_APP_CONFIG_DIR)}`,
  'CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1',
  shellWord(WORKBUDDY_APP_CLI),
  '--acp',
].join(' ')
const WORKBUDDY_AI_APP_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_AI_APP_CONFIG_DIR)}`,
  'CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1',
  shellWord(WORKBUDDY_AI_APP_CLI),
  '--acp',
].join(' ')

export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'traecli',
  'hermes', 'traex', 'workbuddy', 'workbuddy_ai',
] as const

export interface AgentResolution {
  command: string
  acpCommand: string
  version: string
}

function workbuddyApp(name: string): {
  cli: string
  acpCommand: string
  migratableAcpCommands: readonly string[]
  displayName: string
} | undefined {
  if (name === 'workbuddy') {
    return {
      cli: WORKBUDDY_APP_CLI,
      acpCommand: WORKBUDDY_APP_ACP_COMMAND,
      migratableAcpCommands: [
        WORKBUDDY_APP_LEGACY_ACP_COMMAND,
        WORKBUDDY_APP_PRE_MARKETPLACE_BYPASS_ACP_COMMAND,
      ],
      displayName: 'WorkBuddy',
    }
  }
  if (name === 'workbuddy_ai') {
    return {
      cli: WORKBUDDY_AI_APP_CLI,
      acpCommand: WORKBUDDY_AI_APP_ACP_COMMAND,
      migratableAcpCommands: [
        WORKBUDDY_AI_APP_LEGACY_ACP_COMMAND,
        WORKBUDDY_AI_APP_PRE_MARKETPLACE_BYPASS_ACP_COMMAND,
      ],
      displayName: 'WorkBuddy AI',
    }
  }
  return undefined
}

export function defaultAgentCommand(name: string): string {
  return workbuddyApp(name)?.cli ?? name
}

function baseAcpCommand(name: string, command = defaultAgentCommand(name)): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex' || name === 'traecli') return `${command} acp serve`
  return workbuddyApp(name)?.acpCommand ?? name
}

function detectVersion(command: string): string {
  try {
    return execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5_000 })
      .toString()
      .trim()
      .split('\n')[0] || 'installed'
  } catch {
    return 'installed'
  }
}

export interface ExecutableLookupOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export interface AgentDetectionOptions extends ExecutableLookupOptions {
  pathIsExecutable?: (candidate: string) => boolean
  versionFor?: (command: string) => string
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name]
  if (exact !== undefined) return exact
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findExecutableOnPath(
  command: string,
  options: ExecutableLookupOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathValue = environmentValue(env, 'PATH')
  if (!pathValue) return undefined

  let candidates = [command]
  if (platform === 'win32') {
    const pathExt = environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
    const extensions = pathExt
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean)
      .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
    const commandExtension = extname(command)
    candidates = commandExtension
      ? extensions.some((extension) => extension.toLowerCase() === commandExtension.toLowerCase())
        ? [command]
        : []
      : extensions.map((extension) => `${command}${extension}`)
  }

  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, '')
    if (!directory) continue
    for (const candidate of candidates) {
      const resolved = join(directory, candidate)
      if (isExecutableFile(resolved, platform)) return resolved
    }
  }

  return undefined
}

export function detectKnownAgent(
  name: string,
  options: AgentDetectionOptions = {},
): AgentResolution | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathIsExecutable = options.pathIsExecutable
    ?? ((candidate: string) => isExecutableFile(candidate, platform))
  const versionFor = options.versionFor ?? detectVersion

  const workbuddy = workbuddyApp(name)
  if (workbuddy) {
    if (platform !== 'darwin' || !pathIsExecutable(workbuddy.cli)) return undefined
    return {
      command: workbuddy.cli,
      acpCommand: workbuddy.acpCommand,
      version: versionFor(workbuddy.cli),
    }
  }

  const command = defaultAgentCommand(name)
  if (findExecutableOnPath(command, { env, platform })) {
    return {
      command,
      acpCommand: baseAcpCommand(name, command),
      version: versionFor(command),
    }
  }

  if (name === 'codex' && platform === 'darwin' && existsSync(CODEX_APP_CLI)) {
    return {
      command: CODEX_APP_CLI,
      acpCommand: CODEX_APP_ACP_COMMAND,
      version: versionFor(CODEX_APP_CLI),
    }
  }

  return undefined
}

export function defaultAcpCommand(name: string, previousCommand?: string): string {
  const baseCommand = baseAcpCommand(name)
  const nonblankPreviousCommand = typeof previousCommand === 'string'
    && previousCommand.trim().length > 0
    ? previousCommand
    : undefined
  const migratableWorkbuddyCommands = workbuddyApp(name)?.migratableAcpCommands ?? []
  if (nonblankPreviousCommand && nonblankPreviousCommand !== baseCommand) {
    const isMigratableDefault = migratableWorkbuddyCommands.includes(nonblankPreviousCommand)
      || (name === 'codex' && nonblankPreviousCommand === CODEX_APP_CLI)
    if (!isMigratableDefault) return nonblankPreviousCommand
  }
  return detectKnownAgent(name)?.acpCommand ?? baseCommand
}

export function missingAgentWarning(
  name: string,
  options: Pick<AgentDetectionOptions, 'platform'> = {},
): string {
  const platform = options.platform ?? process.platform
  const workbuddy = workbuddyApp(name)
  if (workbuddy && platform === 'darwin') {
    return `${workbuddy.displayName} was not found at ${workbuddy.cli}.`
  }
  if (workbuddy) {
    return `${workbuddy.displayName} auto-detection is only supported on macOS; configure acpCommand explicitly.`
  }
  if (name === 'codex' && platform === 'darwin') {
    return `codex was not found on PATH or at ${CODEX_APP_CLI}.`
  }
  return `${name} was not found on PATH.`
}
