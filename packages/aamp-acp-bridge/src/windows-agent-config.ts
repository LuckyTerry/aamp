import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Parse Windows command-line quoting, not a shell language. Backslashes before
// ordinary characters and shell metacharacters remain literal argv contents.
export function parseWindowsAgentArgv(command: string): string[] {
  if (/[\0\r\n]/.test(command)) throw new Error('Windows agent command contains unsupported control characters')
  const argv: string[] = []
  let index = 0
  while (index < command.length) {
    while (/[ \t]/.test(command[index] ?? '') && index < command.length) index += 1
    if (index === command.length) break
    let value = ''
    let quoted = false
    while (index < command.length) {
      if (!quoted && /[ \t]/.test(command[index])) break
      let slashes = 0
      while (command[index] === '\\') { slashes += 1; index += 1 }
      if (command[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) value += '"'
        else if (quoted && command[index + 1] === '"') { value += '"'; index += 1 }
        else quoted = !quoted
        index += 1
      } else {
        value += '\\'.repeat(slashes)
        if (!quoted && /[ \t]/.test(command[index] ?? '')) break
        if (index < command.length) value += command[index++]
      }
    }
    if (quoted) throw new Error('Windows agent command has an unterminated double quote')
    argv.push(value)
  }
  if (!argv[0]) throw new Error('Windows agent command requires an executable')
  return argv
}

export function windowsAgentAlias(argv: string[]): string {
  return `aamp-windows-${createHash('sha256').update(JSON.stringify(argv)).digest('hex').slice(0, 24)}`
}


export const WINDOWS_CONFIG_ACL_COMPARISON_SCRIPT = String.raw`
function Get-ComparableConfigSddl([string]$sddl) {
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  # Windows may set this bookkeeping flag during Set-Acl. Preserve every ACE,
  # owner/group and protection flag; normalize only DACL auto-inherited status.
  $mask = -bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
  $descriptor.SetFlags([Security.AccessControl.ControlFlags]([int]$descriptor.ControlFlags -band $mask))
  return $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]'Access, Owner, Group')
}
`
export const WINDOWS_CONFIG_ACL_SCRIPT = WINDOWS_CONFIG_ACL_COMPARISON_SCRIPT + String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AAMP_ACPX_CONFIG_ACL)) | ConvertFrom-Json
if ($config.source) {
  $acl = Get-Acl -LiteralPath $config.source
} else {
  $acl = Get-Acl -LiteralPath $config.target
  $acl.SetAccessRuleProtection($true, $false)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($sid)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  foreach ($value in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $principal = [Security.Principal.SecurityIdentifier]::new($value)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow')
    [void]$acl.AddAccessRule($rule)
  }
}
Set-Acl -LiteralPath $config.target -AclObject $acl
$verified = Get-Acl -LiteralPath $config.target
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner, Group'
if ((Get-ComparableConfigSddl $verified.GetSecurityDescriptorSddlForm($sections)) -ne (Get-ComparableConfigSddl $acl.GetSecurityDescriptorSddlForm($sections))) {
  throw ('Windows ACP config temporary file ACL could not be preserved; expected='+$acl.GetSecurityDescriptorSddlForm($sections)+'; actual='+$verified.GetSecurityDescriptorSddlForm($sections))
}
`

function protectConfigTemp(target: string, source?: string): void {
  if (process.platform !== 'win32') return
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_CONFIG_ACL_SCRIPT, 'utf16le').toString('base64')], {
    timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AAMP_ACPX_CONFIG_ACL: Buffer.from(JSON.stringify({ target, source })).toString('base64') },
  })
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function ensureWindowsAgentConfig(cwd: string, argv: string[], options: { wait?: (milliseconds: number) => void } = {}): string {
  const alias = windowsAgentAlias(argv)
  const configPath = join(cwd, '.acpxrc.json')
  const lockPath = join(cwd, '.aamp-acpx-config.lock')
  const token = randomUUID()
  const wait = options.wait ?? pause
  let lock: number | undefined
  for (let attempt = 0; ; attempt += 1) {
    try { lock = openSync(lockPath, 'wx', 0o600); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt >= 20) throw new Error('Windows ACP config is busy; retry after the current config writer finishes')
      wait(50)
    }
  }
  let tempPath: string | undefined
  try {
    writeFileSync(lock, token)
    if (existsSync(configPath) && !lstatSync(configPath).isFile()) throw new Error('Windows ACP config must be a regular file')
    const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined
    const config = original === undefined ? {} : JSON.parse(original)
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || (config.agents !== undefined && (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)))) {
      throw new Error('Windows ACP config must contain an object and an optional agents object')
    }
    const entry = { argv }
    if (Object.hasOwn(config.agents ?? {}, alias)) {
      if (JSON.stringify(config.agents[alias]) !== JSON.stringify(entry)) throw new Error('Windows ACP reserved agent alias conflicts with an existing config entry')
      return alias
    }
    const next = { ...config, agents: { ...config.agents, [alias]: entry } }
    tempPath = join(cwd, `.acpxrc.${token}.tmp`)
    const file = openSync(tempPath, 'wx', 0o600)
    try {
      protectConfigTemp(tempPath, original === undefined ? undefined : configPath)
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
      fsyncSync(file)
    } finally { closeSync(file) }
    for (let attempt = 0; ; attempt += 1) {
      const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined
      if (current !== original) throw new Error('Windows ACP config changed while preparing its agent; retry without overwriting the external edit')
      try { renameSync(tempPath!, configPath); tempPath = undefined; break } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        wait(100 * (2 ** attempt))
      }
    }
    return alias
  } finally {
    if (tempPath) { try { unlinkSync(tempPath) } catch {} }
    closeSync(lock)
    if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
  }
}
