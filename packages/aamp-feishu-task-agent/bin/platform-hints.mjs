// Display-only command formatting. Never use these strings to launch a process.
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {readFileSync} from 'node:fs'

export function powershellQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}
export function cliName(name, platform = process.platform) {
  return name + (platform === 'win32' ? '.cmd' : '')
}
export function taskCommand(action = '', platform = process.platform) {
  return `${cliName('feishu-task-agent', platform)}${action ? ' ' + action : ''}`
}
export function displayAction(action, platform = process.platform) {
  return platform === 'win32' ? taskCommand(action, platform) : action
}
export function globalInstallHint({version, platform = process.platform} = {}) {
  version ||= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  return `npm${platform === 'win32' ? '.cmd' : ''} install --global @larktask/aamp-feishu-task-agent@${version} --registry=https://registry.npmjs.org/`
}
export function logCommand(args, {platform = process.platform, execPath = process.execPath,
  script = fileURLToPath(new URL('./aamp-logs.mjs', import.meta.url)),
  override = process.env.AAMP_LOGS_BIN, home = os.homedir()} = {}) {
  if (platform !== 'win32') return `${override || path.posix.join(home, '.aamp', 'bin', 'aamp-logs')} ${args.join(' ')}`
  // Invoke the shipped JS entry with the running Node, independent of npm PATH/shims.
  const argv = override ? [override, ...args] : [execPath, script, ...args]
  return '& ' + argv.map(powershellQuote).join(' ')
}
export function existingRuntimeHint(action, platform = process.platform) {
  if (platform !== 'win32') return `检测到已有 feishu-task-agent 正在运行。请先执行 feishu-task-agent status 查看状态；如需重启，执行 feishu-task-agent stop 后再运行 feishu-task-agent ${action}`
  return `检测到已有 feishu-task-agent 正在运行。请先执行 ${taskCommand('status', platform)} 查看状态；如需重启已有绑定，执行 ${taskCommand('restart', platform)}；如需重新执行本次配置，先执行 ${taskCommand('stop', platform)}，再执行 ${taskCommand(action, platform)}`
}
