import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'

export const DEFAULT_ZCODE_CLI_PATH =
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
export const ZCODE_ACP_COMMAND = 'aamp-zcode-acp serve'
export const ZCODE_CLI_OVERRIDE = 'AAMP_ZCODE_CLI_PATH'

export interface ZCodeInstallation {
  command: string
  acpCommand: typeof ZCODE_ACP_COMMAND
  version: string
}

export interface ZCodeLocatorOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  defaultPath?: string
  runVersion?: (cliPath: string) => string
}

function isReadableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function defaultVersionRunner(cliPath: string): string {
  return execFileSync(process.execPath, [cliPath, '--version'], {
    stdio: 'pipe',
    timeout: 5_000,
  }).toString().trim().split('\n')[0] || 'installed'
}

export function detectZcodeInstallation(
  options: ZCodeLocatorOptions = {},
): ZCodeInstallation | undefined {
  if ((options.platform ?? process.platform) !== 'darwin') return undefined

  const cliPath = resolveZcodeCliPath(options)
  if (!cliPath) return undefined

  try {
    return {
      command: cliPath,
      acpCommand: ZCODE_ACP_COMMAND,
      version: (options.runVersion ?? defaultVersionRunner)(cliPath),
    }
  } catch {
    return undefined
  }
}

export function resolveZcodeCliPath(
  options: ZCodeLocatorOptions = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== 'darwin') return undefined

  const env = options.env ?? process.env
  const cliPath = env[ZCODE_CLI_OVERRIDE] || options.defaultPath || DEFAULT_ZCODE_CLI_PATH
  if (!isReadableFile(cliPath)) return undefined
  return cliPath
}

export function renderZcodeLoginCommand(cliPath: string): string {
  return `node ${JSON.stringify(cliPath)} login`
}
