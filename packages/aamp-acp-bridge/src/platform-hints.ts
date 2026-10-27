// Display-only commands. These strings are never passed to process launchers.
import {readFileSync} from 'node:fs'
export function cliName(name: string, platform: NodeJS.Platform = process.platform): string {
  return name + (platform === 'win32' ? '.cmd' : '')
}
export function npxBridgeHint(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'npx aamp-acp-bridge'
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {name: string; version: string}
  return `npx.cmd --yes --package ${pkg.name}@${pkg.version} aamp-acp-bridge`
}
export function missingConfigHint(configPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return `Config file not found: ${configPath}. Run 'aamp-acp-bridge init' first.`
  const quotedPath = "'" + configPath.replaceAll("'", "''") + "'"
  return `Config file not found: ${configPath}. Run "${cliName('aamp-acp-bridge', platform)} init --config ${quotedPath}" first.`
}
