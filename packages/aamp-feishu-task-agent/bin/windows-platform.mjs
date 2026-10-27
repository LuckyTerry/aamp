import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const POWERSHELL_INPUT_KEY = 'AAMP_WINDOWS_PLATFORM_INPUT_BASE64'

const POWERSHELL_PREAMBLE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputJson = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:AAMP_WINDOWS_PLATFORM_INPUT_BASE64)
)
$config = $inputJson | ConvertFrom-Json
`

// GetOwnerSid can race with process exit or PID reuse after a CIM snapshot.
// Never attribute its result (or suppress its failure) without a fresh identity check.
const POWERSHELL_SNAPSHOT_OWNER = String.raw`
function Read-LimitedProcessImage([int]$processId) {
  if (-not ('AampLimitedProcessImage' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class AampLimitedProcessImage {
  public DateTime StartTime;
  public string ImagePath;
  public bool HasExited;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder image, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Failure(string stage) {
    int code = Marshal.GetLastWin32Error();
    return new Win32Exception(code, stage + " failed (Windows error " + code + ")");
  }
  public static AampLimitedProcessImage Read(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) throw Failure("OpenProcess for identity query");
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw Failure("GetProcessTimes");
      var result = new AampLimitedProcessImage { StartTime=DateTime.FromFileTimeUtc(created), HasExited=exited != 0 };
      if (result.HasExited) return result;
      uint size=32768;
      var image=new StringBuilder((int)size);
      if (!QueryFullProcessImageNameW(handle, 0, image, ref size)) throw Failure("QueryFullProcessImageNameW");
      result.ImagePath=image.ToString();
      return result;
    } finally { CloseHandle(handle); }
  }
}
'@
  }
  return [AampLimitedProcessImage]::Read($processId)
}
function Test-SnapshotProcessStillCurrent($snapshot) {
  $current = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$snapshot.ProcessId)
  if ($null -eq $current) { return $false }
  if ($null -eq $snapshot.CreationDate -or $null -eq $current.CreationDate) {
    throw 'unable to verify process creation identity'
  }
  return ([int]$current.ProcessId -eq [int]$snapshot.ProcessId -and
    $current.CreationDate.ToUniversalTime().Ticks -eq $snapshot.CreationDate.ToUniversalTime().Ticks)
}
function Read-VerifiedSnapshotOwner($snapshot) {
  try {
    $owner = Invoke-CimMethod -InputObject $snapshot -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
      throw ('unable to read process owner SID; return value ' + $owner.ReturnValue)
    }
  } catch {
    $ownerFailure = $_
    if (-not (Test-SnapshotProcessStillCurrent $snapshot)) { return $null }
    throw $ownerFailure
  }
  if (-not (Test-SnapshotProcessStillCurrent $snapshot)) { return $null }
  return $owner
}
function Read-VerifiedSnapshot($snapshot) {
  $owner = Read-VerifiedSnapshotOwner $snapshot
  if ($null -eq $owner) { return $null }
  # CIM may retain incomplete metadata briefly while a process starts or exits.
  # Retry only this missing field, and recheck identity on every bounded attempt.
  for ($attempt = 0; [string]::IsNullOrWhiteSpace($snapshot.ExecutablePath) -and $attempt -lt 5; $attempt++) {
    if ($attempt -gt 0) { Start-Sleep -Milliseconds 100 }
    $current = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$snapshot.ProcessId)
    if ($null -eq $current) { return $null }
    if ($null -eq $current.CreationDate -or $null -eq $snapshot.CreationDate) {
      throw 'unable to verify process creation identity'
    }
    if ([int]$current.ProcessId -ne [int]$snapshot.ProcessId -or
      $current.CreationDate.ToUniversalTime().Ticks -ne $snapshot.CreationDate.ToUniversalTime().Ticks) { return $null }
    $snapshot = $current
  }
  $executablePath = [string]$snapshot.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executablePath)) {
    try {
      # Read creation time and image from one limited-query handle. Reading
      # MainModule requires more access and fails for an elevated foreground.
      $native = Read-LimitedProcessImage ([int]$snapshot.ProcessId)
      if ($native.HasExited) { return $null }
      $nativeTicks = $native.StartTime.ToUniversalTime().Ticks
      # CIM timestamps have microsecond precision; native FILETIME has 100ns precision.
      if (($nativeTicks - ($nativeTicks % 10)) -ne $snapshot.CreationDate.ToUniversalTime().Ticks) { return $null }
      $executablePath = [string]$native.ImagePath
      if (-not (Test-SnapshotProcessStillCurrent $snapshot)) { return $null }
      if ([string]::IsNullOrWhiteSpace($executablePath)) {
        throw 'unable to read process executable path for a verified live process'
      }
    } catch {
      if (-not (Test-SnapshotProcessStillCurrent $snapshot)) { return $null }
      throw
    }
  }
  return @{ process = $snapshot; owner = $owner; executablePath = $executablePath }
}
`

const POWERSHELL_SCRIPTS = Object.freeze({
  'current-user-sid': POWERSHELL_PREAMBLE + String.raw`
@{ ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress
`,
  'protect-directory': POWERSHELL_PREAMBLE + String.raw`
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$allowedSids = @($currentSid.Value, $systemSid.Value, $administratorsSid.Value)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$sections = [System.Security.AccessControl.AccessControlSections]'Access, Owner'
$directory = New-Object System.IO.DirectoryInfo($config.path)
function Test-PrivateDirectoryAcl($acl) {
  if (-not $acl.AreAccessRulesProtected) { return $false }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { return $false }
  $hasCurrentUserFullControl = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne $allow -or $allowedSids -notcontains $sid -or $rule.IsInherited) { return $false }
    # InheritOnly does not grant access to this directory; NoPropagate cannot
    # protect nested private files. Require effective, propagating FullControl.
    if ($sid -eq $currentSid.Value -and ($rule.FileSystemRights -band $fullControl) -eq $fullControl -and
      $rule.InheritanceFlags -eq $inheritance -and $rule.PropagationFlags -eq $propagation) {
      $hasCurrentUserFullControl = $true
    }
  }
  return $hasCurrentUserFullControl
}
# Read only owner and DACL: standard users must never need SACL privileges.
$acl = $directory.GetAccessControl($sections)
if (-not (Test-PrivateDirectoryAcl $acl)) {
  # A fresh descriptor tracks only the sections changed below. Do not persist
  # an unchanged owner or an audit section through the PowerShell ACL provider.
  $replacement = New-Object System.Security.AccessControl.DirectorySecurity
  $replacement.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $fullControl, $inheritance, $propagation, $allow)
    [void]$replacement.AddAccessRule($rule)
  }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { $replacement.SetOwner($currentSid) }
  $directory.SetAccessControl($replacement)
  if (-not (Test-PrivateDirectoryAcl ($directory.GetAccessControl($sections)))) { throw 'private directory ACL verification failed' }
}
@{ path = $config.path; ownerSid = $currentSid.Value } | ConvertTo-Json -Compress
`,
  'read-process-identity': POWERSHELL_PREAMBLE + POWERSHELL_SNAPSHOT_OWNER + String.raw`
$process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$config.pid)
if ($null -eq $process) {
  @{ found = $false } | ConvertTo-Json -Compress
  exit 0
}
# Recovery can encounter a protected process that reused an old journal PID.
# Compare creation time before querying its owner; journal times have millisecond precision.
if ($config.exitedBefore -and $null -ne $process.CreationDate) {
  $createdTicks = $process.CreationDate.ToUniversalTime().Ticks
  $createdMillis = $createdTicks - ($createdTicks % [TimeSpan]::TicksPerMillisecond)
  $recordedTicks = [DateTimeOffset]::Parse($config.exitedBefore).UtcDateTime.Ticks
  if ($createdMillis -gt $recordedTicks) {
    @{ found = $false } | ConvertTo-Json -Compress
    exit 0
  }
}
$verified = Read-VerifiedSnapshot $process
if ($null -eq $verified) {
  @{ found = $false } | ConvertTo-Json -Compress
  exit 0
}
$process = $verified.process
$owner = $verified.owner
@{
  found = $true
  pid = [int]$process.ProcessId
  creationDate = $process.CreationDate.ToString('o')
  commandLine = [string]$process.CommandLine
  executablePath = [string]$verified.executablePath
  ownerSid = [string]$owner.Sid
} | ConvertTo-Json -Compress
`,
  'list-process-tree': POWERSHELL_PREAMBLE + POWERSHELL_SNAPSHOT_OWNER + String.raw`
$rootPid = [int]$config.pid
Write-Output 'AAMP_STAGE:enumerate-processes'
$all = @(Get-CimInstance -ClassName Win32_Process)
$selected = New-Object 'System.Collections.Generic.HashSet[int]'
if ($config.pids) { foreach ($id in $config.pids) { [void]$selected.Add([int]$id) } } else { [void]$selected.Add($rootPid) }
do {
  $changed = $false
  foreach ($process in $all) {
    if ($selected.Contains([int]$process.ParentProcessId) -and $selected.Add([int]$process.ProcessId)) {
      $changed = $true
    }
  }
} while ($changed)
$identities = @()
Write-Output 'AAMP_STAGE:verify-process-identities'
foreach ($process in $all) {
  if (-not $selected.Contains([int]$process.ProcessId)) { continue }
  $verified = Read-VerifiedSnapshot $process
  if ($null -eq $verified) { continue }
  $process = $verified.process
  $owner = $verified.owner
  $identities += @{
    pid = [int]$process.ProcessId
    parentPid = [int]$process.ParentProcessId
    creationDate = $process.CreationDate.ToString('o')
    commandLine = [string]$process.CommandLine
    executablePath = [string]$verified.executablePath
    ownerSid = [string]$owner.Sid
  }
}
@{ processes = $identities } | ConvertTo-Json -Compress -Depth 4
`,
})

function collectProcess(child, { timeoutMs = 30_000, maxOutputBytes = 1024 * 1024, signal, operation = 'Windows process' } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      callback(value)
    }
    const cancel = () => {
      child.kill?.()
      child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.()
      finish(reject, new Error(operation + ': ' + (signal?.reason?.message || 'cancelled')))
    }
    const timeout = setTimeout(() => {
      child.kill?.()
      child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.()
      const stage = [...stdout.matchAll(/^AAMP_STAGE:([a-z-]+)\r?$/gm)].at(-1)?.[1]
      finish(reject, new Error(operation + (stage ? '/' + stage : '') + ': Windows process timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    timeout.unref?.()
    const append = (stream, chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) {
        child.kill?.()
        finish(reject, new Error(`Windows process exceeded ${maxOutputBytes} byte output limit`))
        return stream
      }
      return stream + chunk
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => finish(reject, error))
    child.once('close', (code) => finish(resolve, { code, stdout, stderr }))
    signal?.addEventListener('abort', cancel, {once:true})
    if (signal?.aborted) cancel()
  })
}

export async function runWindowsPowerShell(script, input, {
  spawnProcess = spawn,
  environment = process.env,
  executable = 'powershell.exe',
  timeoutMs = 30_000,
  maxOutputBytes = 1024 * 1024,
  signal, operation,
} = {}) {
  signal?.throwIfAborted()
  const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64')
  const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...environment, [POWERSHELL_INPUT_KEY]: payload },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await collectProcess(child, { timeoutMs, maxOutputBytes, signal, operation })
  if (result.code !== 0) {
    throw new Error(`Windows PowerShell operation failed: ${result.stderr.trim() || `PowerShell exited ${result.code}`}`)
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error('Windows PowerShell operation returned no result')
  try {
    return JSON.parse(lines.at(-1))
  } catch (error) {
    throw new Error('Windows PowerShell operation returned invalid JSON', { cause: error })
  }
}

async function runFixedPowerShell(operation, input, options) {
  const script = POWERSHELL_SCRIPTS[operation]
  if (!script) throw new Error(`unsupported Windows platform operation: ${operation}`)
  return runWindowsPowerShell(script, input, {...options, operation})
}

export async function ensurePrivateWindowsDirectory(directory, {
  platform = process.platform,
  runPowerShell = runFixedPowerShell,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows private directories require Windows')
  if (typeof directory !== 'string' || !directory) throw new Error('private directory path is required')
  await fsp.mkdir(directory, { recursive: true })
  await runPowerShell('protect-directory', { path: directory })
}

const WINDOWS_REPLACE_RETRY_DELAYS_MS = Object.freeze([100, 200, 400, 800, 1600])
const WINDOWS_SHARED_FILE_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function atomicReplaceWindows(temporaryPath, destinationPath, {
  platform = process.platform,
  rename = fsp.rename,
  wait = delay,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows atomic replacement requires Windows')
  if (typeof temporaryPath !== 'string' || !temporaryPath
    || typeof destinationPath !== 'string' || !destinationPath) {
    throw new Error('temporary and destination paths are required')
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, destinationPath)
      return
    } catch (error) {
      const retryDelay = WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]
      if (!WINDOWS_SHARED_FILE_ERROR_CODES.has(error?.code) || retryDelay === undefined) throw error
      await wait(retryDelay)
    }
  }
}

export async function readWindowsProcessIdentity(pid, {
  platform = process.platform,
  runPowerShell = runFixedPowerShell,
  exitedBefore,
  signal, timeoutMs,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows process identity requires Windows')
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('process pid must be a positive integer')
  if (exitedBefore !== undefined && !Number.isFinite(Date.parse(exitedBefore))) {
    throw new Error('valid recorded process creation time is required')
  }
  const value = await runPowerShell('read-process-identity', {
    pid, ...(exitedBefore === undefined ? {} : {exitedBefore:new Date(exitedBefore).toISOString()}),
  }, {signal,timeoutMs})
  if (value?.found === false) return undefined
  const startedAt = new Date(value?.creationDate)
  if (value?.found !== true || value.pid !== pid || !Number.isFinite(startedAt.getTime())
    || typeof value.commandLine !== 'string' || typeof value.executablePath !== 'string'
    || !value.executablePath || typeof value.ownerSid !== 'string' || !value.ownerSid) {
    throw new Error(`CIM returned an invalid identity for process ${pid}`)
  }
  return {
    pid,
    startedAt: startedAt.toISOString(),
    command: value.commandLine,
    executablePath: value.executablePath,
    ownerSid: value.ownerSid,
  }
}

export async function getCurrentWindowsSid({
  signal, timeoutMs,
  platform = process.platform,
  runPowerShell = runFixedPowerShell,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows user identity requires Windows')
  const value = await runPowerShell('current-user-sid', {}, {signal,timeoutMs})
  if (typeof value?.ownerSid !== 'string' || !/^S-\d(?:-\d+)+$/i.test(value.ownerSid)) {
    throw new Error('PowerShell returned an invalid current user SID')
  }
  return value.ownerSid
}

function environmentValue(environment, name) {
  return Object.entries(environment || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || ''
}

async function isFile(candidate) {
  return fsp.stat(candidate).then((stat) => stat.isFile(), () => false)
}

async function npmJavaScriptBin(shim, shimPath) {
  // npm cmd-shim initializes dp0 in its standard prologue. Never evaluate batch.
  if (/^\s*(?:@?SET|SET)\s+"?dp0=%~dp0"?\s*$/im.test(shim)) {
    shim = shim.replace(/%dp0%/gi, "%~dp0")
  }
  const cliAssignment = /^\s*SET\s+"[A-Z0-9_]*CLI_JS=%~dp0[\\/]([^"\r\n]+?\.(?:c?js|mjs))"\s*$/gim.exec(shim)
  if (cliAssignment) {
    return path.resolve(path.dirname(shimPath), cliAssignment[1].replace(/[\\/]+/g, path.sep))
  }
  const matches = shim.matchAll(/%~dp0[\\/]([^"\r\n]+?\.(?:c?js|mjs))(?=["\s])/gi)
  for (const match of matches) {
    const relative = match[1].replace(/[\\/]+/g, path.sep)
    if (!relative.toLowerCase().endsWith('node.exe')) return path.resolve(path.dirname(shimPath), relative)
  }
  // Some npm packages (CodeBuddy included) expose an extensionless Node bin.
  // Accept only an argument immediately following a Node launcher, and verify
  // its shebang. Never execute the batch shim or infer arbitrary batch logic.
  const nodeEntries = shim.matchAll(/(?:\bnode(?:\.exe)?|"%_prog%"|"%~dp0[\\/]node\.exe")\s+"%~dp0[\\/]([^"\r\n]+)"\s+%\*/gi)
  for (const match of nodeEntries) {
    const entry = path.resolve(path.dirname(shimPath), match[1].replace(/[\\/]+/g, path.sep))
    if (path.extname(entry)) continue
    try {
      const source = await fsp.readFile(entry, 'utf8')
      if (/^#![^\r\n]*\bnode(?:\s|$)/.test(source)) return entry
    } catch {}
  }
  return undefined
}

export async function resolveNativeCommand(name, options = {}) {
  const isOptions = Object.hasOwn(options, 'platform')
    || Object.hasOwn(options, 'env') || Object.hasOwn(options, 'nodeExecutable')
  const platform = isOptions ? (options.platform || process.platform) : 'win32'
  const env = isOptions ? (options.env || process.env) : options
  const nodeExecutable = isOptions ? (options.nodeExecutable || process.execPath) : process.execPath
  if (typeof name !== 'string' || !name.trim()) throw new Error('command name is required')
  const pathValue = environmentValue(env, 'PATH')
  const delimiter = platform === 'win32' ? ';' : path.delimiter
  const directories = pathValue.split(delimiter).filter(Boolean)
  const hasExtension = path.extname(name) !== ''
  const extensions = platform === 'win32' && !hasExtension
    ? (environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const unresolvedCandidate = path.resolve(directory, name + extension)
      if (!await isFile(unresolvedCandidate)) continue
      const candidate = await fsp.realpath(unresolvedCandidate)
      const candidateExtension = path.extname(candidate).toLowerCase()
      if (platform === 'win32' && candidateExtension === '.cmd') {
        const shim = await fsp.readFile(candidate, 'utf8')
        const javascriptBin = await npmJavaScriptBin(shim, candidate)
        if (javascriptBin && await isFile(javascriptBin)) {
          return { command: nodeExecutable, argsPrefix: [javascriptBin] }
        }
        throw new Error(`cannot safely launch opaque Windows command shim: ${candidate}`)
      }
      return { command: candidate, argsPrefix: [] }
    }
  }
  throw new Error(`unable to resolve native command: ${name}`)
}

export function openWindowsTerminal(processLike = process) {
  return { input: processLike.stdin, output: processLike.stdout }
}

function sameWindowsIdentity(expected, actual) {
  const expectedTime = Date.parse(expected.startedAt)
  const actualTime = Date.parse(actual.startedAt)
  return expected.pid === actual.pid
    && Number.isFinite(expectedTime) && expectedTime === actualTime
    && expected.executablePath.toLowerCase() === actual.executablePath.toLowerCase()
    && expected.ownerSid.toLowerCase() === actual.ownerSid.toLowerCase()
}

function normalizeListedIdentity(value) {
  const startedAt = new Date(value?.creationDate ?? value?.startedAt)
  const command = value?.commandLine ?? value?.command
  const invalidFields = []
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) invalidFields.push('pid')
  if (!Number.isSafeInteger(value?.parentPid) || value.parentPid < 0) invalidFields.push('parentPid')
  if (!Number.isFinite(startedAt.getTime())) invalidFields.push('creationDate/startedAt')
  if (typeof command !== 'string') invalidFields.push('commandLine/command')
  if (typeof value?.executablePath !== 'string' || !value.executablePath) invalidFields.push('executablePath')
  if (typeof value?.ownerSid !== 'string' || !value.ownerSid) invalidFields.push('ownerSid')
  if (invalidFields.length) {
    // CIM command/path fields can contain credentials. Emit only numeric IDs and
    // fixed field names; malformed ID values must not be interpolated either.
    const pid = Number.isSafeInteger(value?.pid) ? value.pid : 'invalid'
    const parentPid = Number.isSafeInteger(value?.parentPid) ? value.parentPid : 'invalid'
    throw new Error(`CIM returned an invalid Windows process tree identity (pid=${pid}, parentPid=${parentPid}, invalidFields=${invalidFields.join(',')})`)
  }
  return {
    pid: value.pid,
    parentPid: value.parentPid,
    startedAt: startedAt.toISOString(),
    command,
    executablePath: value.executablePath,
    ownerSid: value.ownerSid,
  }
}

async function listWindowsProcessTree(rootPid) {
  const value = await runFixedPowerShell('list-process-tree', { pid: rootPid })
  if (!Array.isArray(value?.processes)) throw new Error('CIM returned an invalid Windows process tree')
  return value.processes.map(normalizeListedIdentity)
}

export async function snapshotOwnedWindowsTree(rootIdentity, {
  platform = process.platform,
  getCurrentSid = getCurrentWindowsSid,
  listIdentities = listWindowsProcessTree,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows process tree snapshots require Windows')
  if (!rootIdentity || !Number.isSafeInteger(rootIdentity.pid) || rootIdentity.pid <= 0
    || !Number.isFinite(Date.parse(rootIdentity.startedAt))
    || typeof rootIdentity.executablePath !== 'string' || !rootIdentity.executablePath
    || typeof rootIdentity.ownerSid !== 'string' || !rootIdentity.ownerSid) {
    throw new Error('verified Windows root process identity is required')
  }
  const currentSid = await getCurrentSid()
  if (currentSid.toLowerCase() !== rootIdentity.ownerSid.toLowerCase()) return []
  const listed = (await listIdentities(rootIdentity.pid)).map((identity) => (
    Object.hasOwn(identity, 'creationDate') ? normalizeListedIdentity(identity) : identity
  ))
  const liveRoot = listed.find(({ pid }) => pid === rootIdentity.pid)
  if (!liveRoot || !sameWindowsIdentity(rootIdentity, liveRoot)) return []
  const rootStartedAt = Date.parse(rootIdentity.startedAt)
  const selected = new Map([[rootIdentity.pid, rootIdentity]])
  let changed
  do {
    changed = false
    for (const identity of listed) {
      const parentIdentity = selected.get(identity.parentPid)
      if (selected.has(identity.pid) || !parentIdentity) continue
      if (identity.ownerSid.toLowerCase() !== currentSid.toLowerCase()
        || Date.parse(identity.startedAt) < rootStartedAt
        || Date.parse(identity.startedAt) < Date.parse(parentIdentity.startedAt)) continue
      selected.set(identity.pid, identity)
      changed = true
    }
  } while (changed)
  return [...selected.values()]
}

async function defaultTaskkill(args, options) {
  const child = spawn('taskkill.exe', args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await collectProcess(child, {...options,operation:'taskkill'})
  if (result.code !== 0) throw new Error(`taskkill failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

export async function stopOwnedWindowsTree(identity, {
  platform = process.platform,
  getCurrentSid = getCurrentWindowsSid,
  readIdentity = readWindowsProcessIdentity,
  runTaskkill = defaultTaskkill,
  allowExitedIdentity = false,
  signal, timeoutMs,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows process tree cleanup requires Windows')
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || !Number.isFinite(Date.parse(identity.startedAt))
    || typeof identity.executablePath !== 'string' || !identity.executablePath
    || typeof identity.ownerSid !== 'string' || !identity.ownerSid) {
    throw new Error('verified Windows process identity is required')
  }
  const currentSid = await getCurrentSid({signal,timeoutMs})
  if (currentSid.toLowerCase() !== identity.ownerSid.toLowerCase()) {
    throw new Error(`process ${identity.pid} belongs to another Windows user; refusing taskkill`)
  }
  signal?.throwIfAborted()
  const current = await readIdentity(identity.pid, {signal,timeoutMs,...(allowExitedIdentity ? {exitedBefore:identity.startedAt} : {})})
  if (!current) return
  if (!sameWindowsIdentity(identity, current)) {
    // Recovery journals retain exited descendants. A newer creation time for
    // the same PID proves that generation has ended; never signal its successor.
    // Other mismatches and failed identity queries remain hard errors.
    if (allowExitedIdentity && current.pid === identity.pid
      && Number.isFinite(Date.parse(current.startedAt))
      && Date.parse(current.startedAt) > Date.parse(identity.startedAt)) return
    throw new Error(`process ${identity.pid} identity changed; refusing taskkill`)
  }
  signal?.throwIfAborted()
  await runTaskkill(['/PID', String(identity.pid), '/T', '/F'], {signal,timeoutMs})
  const remaining = await readIdentity(identity.pid, {signal,timeoutMs})
  if (remaining && sameWindowsIdentity(identity, remaining)) {
    throw new Error(`process ${identity.pid} remained after taskkill`)
  }
}

export const __test = Object.freeze({ runFixedPowerShell, powershellScripts: POWERSHELL_SCRIPTS })

// A single system enumeration supplies all roots in a controller sampling round.
export async function snapshotOwnedWindowsTrees(roots, {
  signal, timeoutMs=30000, currentSid, runPowerShell=runFixedPowerShell,
}={}) {
  signal?.throwIfAborted()
  const sid=currentSid || await getCurrentWindowsSid({signal,timeoutMs})
  const value=await runPowerShell('list-process-tree',{pids:roots.map(r=>r.pid)},{signal,timeoutMs})
  if(!Array.isArray(value?.processes))throw Error('CIM returned an invalid Windows process tree')
  const listed=value.processes.map(normalizeListedIdentity)
  const result=new Map()
  for(const root of roots)result.set(root.pid,await snapshotOwnedWindowsTree(root,{
    getCurrentSid:async()=>sid,listIdentities:async()=>listed,
  }))
  return result
}
