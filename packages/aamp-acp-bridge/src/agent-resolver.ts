import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex'
const CODEX_APP_ACP_COMMAND = `env CODEX_PATH=${CODEX_APP_CLI} npx -y @agentclientprotocol/codex-acp`

export interface AgentResolution {
  command: string
  acpCommand: string
  version: string
}

function baseAcpCommand(name: string): string {
  return name === 'hermes' ? 'hermes acp' : name
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

export function detectKnownAgent(name: string): AgentResolution | undefined {
  if (findOnPath(name)) {
    return {
      command: name,
      acpCommand: baseAcpCommand(name),
      version: detectVersion(name),
    }
  }

  if (name === 'codex' && process.platform === 'darwin' && existsSync(CODEX_APP_CLI)) {
    return {
      command: CODEX_APP_CLI,
      acpCommand: CODEX_APP_ACP_COMMAND,
      version: detectVersion(CODEX_APP_CLI),
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

export function missingAgentWarning(name: string): string {
  if (name === 'codex' && process.platform === 'darwin') {
    return `codex was not found on PATH or at ${CODEX_APP_CLI}.`
  }
  return `${name} was not found on PATH.`
}
