import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FeishuCliCredentialOptions {
  cliBin?: string
  createNew?: boolean
  profile?: string
  appName?: string
  brand?: string
  openSetupUrl?: boolean
}

export interface FeishuCliCredentials {
  appId: string
  appSecret?: string
  profile?: string
  created: boolean
}

interface LarkCliProfile {
  name?: string
  appId?: string
  active?: boolean
}

interface LarkCliConfig {
  apps?: Array<{
    appId?: string
    appSecret?: unknown
    brand?: string
    name?: string
    profile?: string
  }>
}

function larkCliConfigPath(): string {
  return path.join(os.homedir(), '.lark-cli', 'config.json')
}

async function runLarkCli(cliBin: string, args: string[], options: { openSetupUrl?: boolean } = {}): Promise<string> {
  if (!options.openSetupUrl) {
    const { stdout } = await execFileAsync(cliBin, args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return stdout.toString()
  }

  return runLarkCliStreaming(cliBin, args, options)
}

async function runLarkCliStreaming(
  cliBin: string,
  args: string[],
  options: { openSetupUrl?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let openedSetupUrl = false
    let timeout: NodeJS.Timeout | undefined

    const observeOutput = (chunk: Buffer): void => {
      const text = chunk.toString()
      const setupUrl = findSetupUrl(text)
      if (setupUrl && options.openSetupUrl && !openedSetupUrl) {
        openedSetupUrl = true
        process.stderr.write(`Open Feishu setup URL: ${setupUrl}\n`)
        openExternalUrl(setupUrl)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      observeOutput(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      observeOutput(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${cliBin} exited with ${code ?? 'unknown status'}`))
    })

    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${cliBin} did not finish within 600 seconds.`))
    }, 10 * 60 * 1000)
  })
}

function findSetupUrl(text: string): string | undefined {
  return /https:\/\/[^\s]+\/page\/cli\?[^\s]+/.exec(text)?.[0]
}

function openExternalUrl(url: string): void {
  const opener = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url]
  const child = spawn(opener, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function runLarkCliJson(cliBin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cliBin, args, {
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout.toString()
}

function parseCredentialText(value: string): Partial<Pick<FeishuCliCredentials, 'appId' | 'appSecret'>> {
  const appId = /(?:app[_\s-]*id|App ID)\s*[:=]\s*([a-zA-Z0-9_]+)/i.exec(value)?.[1]
  const appSecret = /(?:app[_\s-]*secret|App Secret)\s*[:=]\s*([^\s]+)/i.exec(value)?.[1]
  return {
    ...(appId ? { appId } : {}),
    ...(appSecret && appSecret !== '****' ? { appSecret } : {}),
  }
}

async function createLarkCliApp(
  options: FeishuCliCredentialOptions,
  cliBin: string,
): Promise<Partial<Pick<FeishuCliCredentials, 'appId' | 'appSecret'>>> {
  const args = [
    'config',
    'init',
    '--new',
    '--brand',
    options.brand ?? 'feishu',
  ]
  const profile = options.profile ?? options.appName
  if (profile) {
    args.push('--name', profile)
  }
  const stdout = await runLarkCli(cliBin, args, { openSetupUrl: options.openSetupUrl })
  return parseCredentialText(stdout)
}

async function listProfiles(cliBin: string): Promise<LarkCliProfile[]> {
  try {
    const stdout = await runLarkCliJson(cliBin, ['profile', 'list'])
    const parsed = JSON.parse(stdout) as unknown
    return Array.isArray(parsed) ? parsed as LarkCliProfile[] : []
  } catch {
    return []
  }
}

async function readLarkCliConfig(): Promise<LarkCliConfig> {
  const raw = await readFile(larkCliConfigPath(), 'utf8')
  return JSON.parse(raw) as LarkCliConfig
}

function chooseProfile(profiles: LarkCliProfile[], requested?: string): LarkCliProfile | undefined {
  if (requested) {
    return profiles.find((profile) => profile.name === requested || profile.appId === requested)
  }
  return profiles.find((profile) => profile.active) ?? profiles[0]
}

function resolveAppSecret(value: unknown, appId: string): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.value === 'string') return record.value.trim() || undefined
  if (record.source === 'env') {
    const key = typeof record.name === 'string'
      ? record.name
      : typeof record.id === 'string'
        ? record.id
        : undefined
    return key ? process.env[key]?.trim() : undefined
  }
  if (record.source === 'keychain') {
    return undefined
  }
  return undefined
}

export async function resolveFeishuCliCredentials(
  options: FeishuCliCredentialOptions = {},
): Promise<FeishuCliCredentials> {
  const cliBin = options.cliBin?.trim() || 'lark-cli'
  let createdCredentials: Partial<Pick<FeishuCliCredentials, 'appId' | 'appSecret'>> = {}
  if (options.createNew) {
    createdCredentials = await createLarkCliApp(options, cliBin)
  }

  const requestedProfile = options.profile ?? options.appName
  const profiles = await listProfiles(cliBin)
  const selectedProfile = chooseProfile(profiles, requestedProfile)
  const config = await readLarkCliConfig()
  const appId = selectedProfile?.appId ?? options.profile
  const app = config.apps?.find((candidate) => {
    if (appId && candidate.appId === appId) return true
    if (requestedProfile && (candidate.name === requestedProfile || candidate.profile === requestedProfile)) return true
    return !appId && candidate.appId === selectedProfile?.appId
  }) ?? config.apps?.[0]

  const resolvedAppId = createdCredentials.appId ?? app?.appId?.trim()
  const appSecret = createdCredentials.appSecret ?? (resolvedAppId ? resolveAppSecret(app?.appSecret, resolvedAppId) : undefined)
  if (!resolvedAppId) {
    throw new Error(
      'Could not read Feishu App ID from lark-cli. Run "lark-cli config init --new" or pass --app-id/--app-secret.',
    )
  }

  return {
    appId: resolvedAppId,
    ...(appSecret && appSecret !== '****' ? { appSecret } : {}),
    profile: selectedProfile?.name ?? resolvedAppId,
    created: Boolean(options.createNew),
  }
}
