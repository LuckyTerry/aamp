import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'

export interface NativeCommand { command: string; argsPrefix: string[] }
export interface NativeCommandOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

function findWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? command : undefined
  const pathValue = environmentValue(env, 'PATH')
  if (!pathValue) return undefined
  const extensions = (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((value) => value.trim()).filter(Boolean)
  const names = extname(command)
    ? [command]
    : [...new Set(extensions.flatMap((extension) => [
        `${command}${extension}`,
        `${command}${extension.toLowerCase()}`,
      ]))]
  for (const directory of pathValue.split(';').map((value) => value.replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* keep searching */ }
    }
  }
  return undefined
}

function resolveNpmNodeShim(command: string): string | undefined {
  const source = readFileSync(command, 'utf8')
  const npxVariable = /SET\s+"NPX_CLI_JS=%(?:~dp0|dp0%)[\\/]([^"\r\n]+?\.(?:[cm]?js))"/i.exec(source)?.[1]
  if (npxVariable && /"%NODE_EXE%"\s+"%NPX_CLI_JS%"\s+%\*/i.test(source)) {
    const entry = resolve(command, '..', ...npxVariable.split(/[\\/]/).filter(Boolean))
    return existsSync(entry) ? entry : undefined
  }
  const matches = [...source.matchAll(/["']%(?:~dp0|dp0%)[\\/]([^"'\r\n]+?\.(?:[cm]?js))["']/gi)]
  const relativeEntry = matches.at(-1)?.[1]
  if (!relativeEntry) return undefined
  const entry = resolve(command, '..', ...relativeEntry.split(/[\\/]/).filter(Boolean))
  return existsSync(entry) ? entry : undefined
}

export function resolveNativeCommand(command: string, options: NativeCommandOptions = {}): NativeCommand {
  if ((options.platform ?? process.platform) !== 'win32') return { command, argsPrefix: [] }
  const resolved = findWindowsCommand(command, options.env ?? process.env)
  if (!resolved) return { command, argsPrefix: [] }
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, argsPrefix: [] }
  const nodeEntry = resolveNpmNodeShim(resolved)
  if (!nodeEntry) throw new Error(`${resolved} is not a verified npm-generated Node shim`)
  return { command: process.execPath, argsPrefix: [nodeEntry] }
}
