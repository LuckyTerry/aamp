import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex'
const CODEX_APP_ACP_COMMAND = `env CODEX_PATH=${CODEX_APP_CLI} npx -y @agentclientprotocol/codex-acp`
export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_APP_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`

export const KNOWN_AGENTS: readonly string[] = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'traex', 'workbuddy',
]

export interface AgentResolution {
  command: string
  acpCommand: string
  version: string
}

export interface AgentDetectionOptions {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  versionFor?: (command: string) => string
}

function baseAcpCommand(name: string): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex') return 'traex acp serve'
  return name
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

function findOnPath(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe', timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

export function detectKnownAgent(
  name: string,
  options: AgentDetectionOptions = {},
): AgentResolution | undefined {
  const platform = options.platform ?? process.platform
  const pathExists = options.pathExists ?? existsSync
  const versionFor = options.versionFor ?? detectVersion

  if (name === 'workbuddy') {
    if (platform !== 'darwin' || !pathExists(WORKBUDDY_APP_CLI)) return undefined
    return {
      command: WORKBUDDY_APP_CLI,
      acpCommand: WORKBUDDY_APP_ACP_COMMAND,
      version: versionFor(WORKBUDDY_APP_CLI),
    }
  }

  if (findOnPath(name)) {
    return {
      command: name,
      acpCommand: baseAcpCommand(name),
      version: versionFor(name),
    }
  }

  if (name === 'codex' && platform === 'darwin' && pathExists(CODEX_APP_CLI)) {
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
  if (previousCommand && previousCommand !== baseCommand) {
    if (name !== 'codex' || previousCommand !== CODEX_APP_CLI) return previousCommand
  }
  return detectKnownAgent(name)?.acpCommand ?? baseCommand
}

export function missingAgentWarning(
  name: string,
  options: Pick<AgentDetectionOptions, 'platform'> = {},
): string {
  const platform = options.platform ?? process.platform
  if (name === 'workbuddy' && platform === 'darwin') {
    return `WorkBuddy was not found at ${WORKBUDDY_APP_CLI}.`
  }
  if (name === 'workbuddy') {
    return 'WorkBuddy auto-detection is only supported on macOS; configure acpCommand explicitly.'
  }
  if (name === 'codex' && platform === 'darwin') {
    return `codex was not found on PATH or at ${CODEX_APP_CLI}.`
  }
  return `${name} was not found on PATH.`
}
