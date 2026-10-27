import {recoverWindowsProcessJournals, confirmWindowsProcessRecovery, hasPendingWindowsProcessJournal} from './windows-process-journal.mjs'
import {withWindowsCleanupDeadline} from './windows-process-cleanup.mjs'
import {taskCommand, globalInstallHint} from './platform-hints.mjs'
import { withWindowsOperationLock } from './windows-operation-lock.mjs'
import {startupProgress} from './startup-progress.mjs'
import {resolveWindowsNpmPrefix} from '../bootstrap/windows-runtime-paths.mjs'
import {StringDecoder} from 'node:string_decoder'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const execFileAsync = promisify(execFile)
const platform = () => import('./windows-platform.mjs')

const schedulerScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$c=$env:AAMP_SCHEDULER_INPUT | ConvertFrom-Json
function Resolve-TaskPrincipalSid([string]$userId) {
  if ([string]::IsNullOrWhiteSpace($userId)) { throw 'Cannot verify scheduled task principal SID' }
  try {
    if ($userId -match '^S-\d(?:-\d+)+$') {
      return ([System.Security.Principal.SecurityIdentifier]::new($userId)).Value
    }
    $account=[System.Security.Principal.NTAccount]::new($userId)
    return ($account.Translate([System.Security.Principal.SecurityIdentifier])).Value
  } catch { throw 'Cannot verify scheduled task principal SID' }
}
$t=Get-ScheduledTask -TaskName $c.name -ErrorAction SilentlyContinue
$ownerSid=$c.sid
if ($t) {
  $ownerSid=Resolve-TaskPrincipalSid ([string]$t.Principal.UserId)
  if ($ownerSid -ne $c.sid) { throw 'Scheduled task belongs to another identity' }
}
function Grant-TaskUserControl {
  $service=New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $registered=$service.GetFolder('\').GetTask($c.name)
  $definition=$registered.Definition
  if ((Resolve-TaskPrincipalSid ([string]$definition.Principal.UserId)) -ne $c.sid -or
      [int]$definition.Principal.RunLevel -ne 0 -or [int]$definition.Principal.LogonType -ne 3) {
    throw 'Refusing permission repair for a foreign or elevated scheduled task'
  }
  $descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($registered.GetSecurityDescriptor(4))
  $sid=[System.Security.Principal.SecurityIdentifier]::new($c.sid)
  $fullControl=0x1f01ff
  $hasFullControl=$false
  if ($null -eq $descriptor.DiscretionaryAcl) { throw 'Cannot verify scheduled task DACL' }
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -is [System.Security.AccessControl.CommonAce] -and $ace.SecurityIdentifier -eq $sid) {
      if ($ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessDenied) { throw 'Scheduled task has an explicit deny for its user' }
      if ($ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed -and
          ($ace.AccessMask -band $fullControl) -eq $fullControl -and
          ([int]$ace.AceFlags -band [int][System.Security.AccessControl.AceFlags]::InheritOnly) -eq 0) { $hasFullControl=$true }
    }
  }
  if ($hasFullControl) { return }
  $rule=[System.Security.AccessControl.CommonAce]::new([System.Security.AccessControl.AceFlags]::None,[System.Security.AccessControl.AceQualifier]::AccessAllowed,$fullControl,$sid,$false,$null)
  $insert=0
  while ($insert -lt $descriptor.DiscretionaryAcl.Count -and $descriptor.DiscretionaryAcl[$insert].AceType -eq [System.Security.AccessControl.AceType]::AccessDenied) { $insert++ }
  $descriptor.DiscretionaryAcl.InsertAce($insert,$rule)
  $registered.SetSecurityDescriptor($descriptor.GetSddlForm([System.Security.AccessControl.AccessControlSections]::Access),0)
}
switch ($c.operation) {
 'status' {
  if ($t) { @{loaded=($t.State -ne 'Disabled');state=[string]$t.State;enabled=[bool]$t.Settings.Enabled;ownerSid=$ownerSid} | ConvertTo-Json -Compress }
  else { @{loaded=$false;state='Stopped';ownerSid=$c.sid} | ConvertTo-Json -Compress }
 }
 'disable' { if ($t -and $t.State -ne 'Disabled') { Disable-ScheduledTask -TaskName $c.name | Out-Null } }
 'repair-permissions' {
  $currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedName='AAMP-FeishuTask-'+$currentSid
  if ($c.sid -ne $currentSid -or ($c.name -ne $expectedName -and $c.name -notmatch ('^'+[regex]::Escape($expectedName)+'-test-[a-zA-Z0-9-]+$'))) { throw 'Refusing permission repair for an unrelated task' }
  if (!$t) { throw 'Scheduled task disappeared before permission repair' }
  Grant-TaskUserControl
 }
 'start' {
  $p=New-ScheduledTaskPrincipal -UserId $c.sid -LogonType Interactive -RunLevel Limited
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $c.sid
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $hostPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (!(Test-Path -LiteralPath $hostPath) -or !(Test-Path -LiteralPath $c.launcher)) { throw 'Windows background launcher is unavailable' }
  $a=New-ScheduledTaskAction -Execute $hostPath -Argument ('//B //Nologo "'+$c.launcher+'" "'+$c.node+'" "'+$c.worker+'" "'+$c.config+'"') -WorkingDirectory $c.directory
  Register-ScheduledTask -TaskName $c.name -Action $a -Principal $p -Trigger $trigger -Settings $settings -Force | Out-Null
  Grant-TaskUserControl
  Start-ScheduledTask -TaskName $c.name
 }
 'unregister' { if ($t) { Unregister-ScheduledTask -TaskName $c.name -Confirm:$false } }
 default { throw 'Unknown scheduler operation' }
}
`
async function repairWindowsTaskPermissions(config, {execute=execFileAsync}={}) {
  // Elevate only this fixed ACL operation. Never execute a worker or load scripts
  // from the user's runtime directory in the elevated helper.
  const input=Buffer.from(JSON.stringify({name:config.name,sid:config.sid,operation:'repair-permissions'}),'utf8').toString('base64')
  const repair=schedulerScript.replace('$c=$env:AAMP_SCHEDULER_INPUT | ConvertFrom-Json',`$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json`)
  const encoded=Buffer.from(`try { ${repair}\nexit 0 } catch { exit 1 }`,'utf16le').toString('base64')
  const script=String.raw`
$ErrorActionPreference='Stop'
try {
  $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $p=Start-Process -FilePath $exe -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoLogo -NoProfile -NonInteractive -EncodedCommand '+$env:AAMP_TASK_ACL_REPAIR) -PassThru
  $null=$p.Handle
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw 'AAMP_TASK_ACL_REPAIR_FAILED' }
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223) { throw 'AAMP_TASK_ACL_REPAIR_CANCELLED' }
  throw
}`
  try {
    await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,AAMP_TASK_ACL_REPAIR:encoded},windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:65536})
  } catch(error) {
    if(String(error.stderr||error.message).includes('AAMP_TASK_ACL_REPAIR_CANCELLED')) throw new Error('已取消计划任务权限修复；后台未启动。')
    throw new Error('计划任务权限修复未完成；请使用同一账号确认管理员授权后重试。',{cause:error})
  }
}
async function nativeScheduler(operation, config, {execute=execFileAsync,repair=repairWindowsTaskPermissions,onProgress=()=>{},signal,timeoutMs=30000}={}) {
  const run=async()=>{
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', schedulerScript],
    {
      env: {
        ...process.env,
        AAMP_SCHEDULER_INPUT: JSON.stringify({ ...config, operation }),
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      signal,
      maxBuffer: 1024 * 1024,
    },
  )
  return stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : {}
  }
  try {return await run()} catch(error) {
    const denied=/0x80070005|Access is denied|拒绝访问/i.test(String(error.stderr||error.message))
    if(!denied || !['start','disable','unregister'].includes(operation)) throw error
    if(!config.allowPermissionRepair) throw new Error('当前用户无权管理旧计划任务；请在交互终端执行 start 或 stop，确认一次管理员权限修复。',{cause:error})
    onProgress('旧计划任务权限不足，正在请求一次管理员授权以修复当前用户的管理权限...')
    await repair(config)
    try {return await run()} catch(retryError) {throw new Error('计划任务权限修复后操作仍失败，请查看日志。',{cause:retryError})}
  }
}
async function currentSid() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  )
  const sid = stdout.trim()
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid))
    throw new Error('Cannot determine Windows user SID')
  return sid
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError)
      return undefined
    throw error
  }
}
function sameIds(a = [], b = []) {
  return (
    JSON.stringify([...new Set(a)].sort()) ===
    JSON.stringify([...new Set(b)].sort())
  )
}
function sameIdentity(a, b, sid) {
  return Boolean(
    a &&
      b &&
      a.pid === b.pid &&
      a.startedAt === b.startedAt &&
      a.executablePath === b.executablePath &&
      a.ownerSid === sid &&
      b.ownerSid === sid,
  )
}

export function createWindowsServiceManager({
  runtimeHome,
  controllerPath = fileURLToPath(
    new URL('./feishu-task-agent-controller.mjs', import.meta.url),
  ),
  workerPath = fileURLToPath(
    new URL('./windows-service-worker.mjs', import.meta.url),
  ),
  environment = process.env,
  currentSid: getSid = currentSid,
  scheduler = (operation, config, options) => nativeScheduler(operation, config, {onProgress,...options}),
  readIdentity = async (pid, options) =>
    (await platform()).readWindowsProcessIdentity(pid, options),
  ensurePrivateDirectory = async (dir) =>
    (await platform()).ensurePrivateWindowsDirectory(dir),
  stopTree = async (identity, options) =>
    (await platform()).stopOwnedWindowsTree(identity, options),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startupAttempts = 600,
  onProgress = () => {},
  stopAttempts = 600,
  stopTimeoutMs = 75000,
  stopGraceMs = 60000,
} = {}) {
  if (!runtimeHome) throw new Error('Windows service runtimeHome is required')
  const serviceHome = path.join(runtimeHome, 'windows-service-v1')
  const paths = {
    serviceHome,
    selectionFile: path.join(serviceHome, 'selection.json'),
    readinessFile: path.join(serviceHome, 'readiness.json'),
    stateFile: path.join(serviceHome, 'worker-state.json'),
    ownerFile: path.join(serviceHome, 'owner.json'),
    stopFile: path.join(serviceHome, 'stop.json'),
    configFile: path.join(serviceHome, 'worker.json'),
    logFile: path.join(serviceHome, 'service.log'),
  }
  const config = async () => {
    const sid = await getSid()
    return {
      sid,
      name: `AAMP-FeishuTask-${sid}`,
      node: process.execPath,
      launcher: fileURLToPath(new URL('./windows-service-launcher.vbs', import.meta.url)),
      worker: workerPath,
      config: paths.configFile,
      directory: path.dirname(workerPath),
      allowPermissionRepair: environment.AAMP_TASK_NON_INTERACTIVE !== 'true' && Boolean(process.stdin.isTTY),
    }
  }
  async function writeJson(file, data) {
    await ensurePrivateDirectory(path.dirname(file))
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(data) + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
      if (process.platform === 'win32')
        await (await platform()).atomicReplaceWindows(temp, file)
      else await fs.rename(temp, file)
    } finally {
      await fs.rm(temp, { force: true })
    }
  }
  async function status() {
    const c = await config()
    const task = await scheduler('status', c)
    if (task.ownerSid && task.ownerSid !== c.sid)
      throw new Error('Windows task identity mismatch')
    const base = {
      loaded: Boolean(task.loaded),
      state: 'stopped',
      pid: null,
      ready: false,
    }
    if (!task.loaded) return base
    base.state = 'starting'
    const selected = await readJson(paths.selectionFile),
      owner = await readJson(paths.ownerFile),
      ready = await readJson(paths.readinessFile)
    if (!selected?.generation || owner?.generation !== selected.generation)
      return base
    const worker = owner.worker && (await readIdentity(owner.worker.pid))
    const controller =
      owner.controller && (await readIdentity(owner.controller.pid))
    if (
      !sameIdentity(worker, owner.worker, c.sid) ||
      !sameIdentity(controller, owner.controller, c.sid)
    )
      return { ...base, state: 'stopped' }
    base.pid = controller.pid
    const tracking=await readJson(path.join(serviceHome,'process-tracking.json'))
    if(tracking?.generation===selected.generation && tracking?.pid===controller.pid) base.processTracking=tracking
    if (
      ready?.version === 1 &&
      ready.state === 'ready' &&
      ready.generation === selected.generation &&
      ready.pid === controller.pid &&
      sameIds(ready.binding_ids, selected.binding_ids)
    )
      return { ...base, state: 'running', ready: true }
    return base
  }
  async function selectionSnapshot() {
    const p = await readJson(paths.selectionFile)
    return {
      generation: p?.generation || '',
      bindingIds: Array.isArray(p?.binding_ids) ? p.binding_ids : [],
    }
  }
  const selection = async () => (await selectionSnapshot()).bindingIds
  async function markReady(bindingIds, generation) {
    const selected = await selectionSnapshot()
    if (
      !generation ||
      generation !== selected.generation ||
      !sameIds(bindingIds, selected.bindingIds)
    )
      throw new Error('后台服务启动代次或绑定已变化')
    await writeJson(paths.readinessFile, {
      version: 1,
      state: 'ready',
      generation,
      pid: process.pid,
      binding_ids: bindingIds,
    })
  }
  async function stopUnlocked() {
    const cleanupFile=path.join(serviceHome,'cleanup-result.json')
    const cleanupStamp=async()=>fs.stat(cleanupFile,{bigint:true}).then(stat=>`${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`,error=>{if(error.code==='ENOENT')return '';throw error})
    const initialCleanupStamp=await cleanupStamp()
    const c = await config()
    const task = await scheduler('status', c)
    await scheduler('disable', c)
    const snapshot={selection:await readJson(paths.selectionFile),owner:await readJson(paths.ownerFile),worker:await readJson(paths.configFile)}
    const verifySnapshot=async (budget,requireStopped=false)=>{
      budget.signal.throwIfAborted()
      for(const [key,file] of [['selection',paths.selectionFile],['owner',paths.ownerFile],['worker',paths.configFile]]) {
        if(JSON.stringify(await readJson(file))!==JSON.stringify(snapshot[key]))throw new Error('Windows background state changed during recovery')
      }
      const state=await scheduler('status',c,budget.options())
      if((state.enabled ?? state.loaded) || (requireStopped && String(state.state).toLowerCase()==='running'))throw new Error('Windows background task is still active during recovery')
    }
    const clearHistoricalState=async(budget)=>{
      await verifySnapshot(budget,true)
      const backup=path.join(serviceHome,'recovery-backups',randomUUID(),'state.json')
      await writeJson(backup,{...snapshot,cleanup:await readJson(cleanupFile),readiness:await readJson(paths.readinessFile),workerState:await readJson(paths.stateFile)})
      await verifySnapshot(budget,true)
      await writeJson(path.join(serviceHome,'stale-recovery-result.json'),{version:1,generation:snapshot.selection?.generation || '',
        controller:snapshot.owner?.controller,method:'registered-processes-only',unregisteredProcessesChecked:false,backup,completedAt:new Date().toISOString()})
      for(const file of [paths.ownerFile,paths.readinessFile,paths.stateFile,cleanupFile]) {
        budget.signal.throwIfAborted()
        await fs.rm(file,{force:true})
      }
      onProgress('已清除旧后台状态；未检查未登记的残留进程，继续执行当前命令。')
      return {stopped:true,wasLoaded:Boolean(task.loaded),recovered:true}
    }
    return withWindowsCleanupDeadline(async budget => {
    const selected = await selectionSnapshot()
    let owner = await readJson(paths.ownerFile)
    budget.signal.throwIfAborted()
    await writeJson(paths.stopFile, { generation: owner?.generation || selected.generation })
    // A scheduled worker may not have published owner.json yet. Do not report a successful stop during that gap.
    const acknowledged = async () =>
      owner?.worker &&
      sameIdentity(await readIdentity(owner.worker.pid, budget.options()), owner.worker, c.sid)
    for (let i = 0; !(await acknowledged()) && i < stopAttempts; i++) {
      const state = await scheduler('status', c, budget.options())
      if (String(state.state).toLowerCase() !== 'running') break
      await wait(100)
      owner = await readJson(paths.ownerFile)
    }
    if (!(await acknowledged())) {
      const state = await scheduler('status', c, budget.options())
      if (String(state.state).toLowerCase() === 'running')
        throw new Error(
          `后台进程尚未确认停止；请执行 ${taskCommand('status', 'win32')} 检查状态后重试。`,
        )
    }
    if (owner) {
      const graceDeadline=Date.now()+Math.min(stopGraceMs,Math.max(0,stopTimeoutMs-15000))
      for (let i = 0; i < stopAttempts && Date.now()<graceDeadline; i++) {
        if (!owner.controller || !(await readIdentity(owner.controller.pid, budget.options())))
          break
        await wait(100)
      }
      for (const recorded of [owner.controller, owner.worker]) {
        if (!recorded) continue
        const live = await readIdentity(recorded.pid, budget.options())
        if (!live) continue
        if (!sameIdentity(live, recorded, c.sid))
          throw new Error('Refusing to stop a changed Windows process identity')
        await stopTree(recorded, budget.options())
      }
    }
    let after = await scheduler('status', c, budget.options())
    for (
      let i = 0;
      String(after.state).toLowerCase() === 'running' && i < stopAttempts;
      i++
    ) {
      await wait(100)
      after = await scheduler('status', c, budget.options())
    }
    if (String(after.state).toLowerCase() === 'running')
      throw new Error(
        `后台进程尚未确认停止；请执行 ${taskCommand('status', 'win32')} 检查状态后重试。`,
      )
    budget.signal.throwIfAborted()
    const cleanup=await readJson(cleanupFile)
    const acknowledgedCleanup=Boolean(cleanup && owner?.controller && cleanup.generation===owner.generation && cleanup.pid===owner.controller.pid)
    if(acknowledgedCleanup && cleanup.ok===false && await cleanupStamp()!==initialCleanupStamp)
      throw new Error('后台停止未完成：控制器未能清理全部进程，请查看日志。')
    const staleOwner=Boolean((task.loaded || snapshot.owner || snapshot.selection) && (!owner?.controller || owner.generation!==selected.generation))
    if(owner?.controller && !(acknowledgedCleanup && cleanup.ok===true)) {
      const directory=path.join(runtimeHome,'windows-process-journals-v1')
      await recoverWindowsProcessJournals(directory,{
        controllerIdentity:owner.controller,signal:budget.signal,
        readIdentity:(pid,options)=>readIdentity(pid,{...options,...budget.options()}),
        stopTree:(identity,options)=>stopTree(identity,{...options,...budget.options()}),
      })
      const confirmed=await confirmWindowsProcessRecovery(directory,owner.controller,
        ()=>writeJson(cleanupFile,{generation:owner.generation,pid:owner.controller.pid,ok:true}),{signal:budget.signal})
      if(!confirmed) {
        if(await hasPendingWindowsProcessJournal(directory,owner.controller,{signal:budget.signal}))
          throw new Error('后台停止未完成：已登记的进程记录尚未完成清理。')
        return clearHistoricalState(budget)
      }
    }
    if(staleOwner)return clearHistoricalState(budget)
    budget.signal.throwIfAborted()
    await fs.rm(paths.readinessFile, { force: true })
    return { stopped: true, wasLoaded: Boolean(task.loaded) }
    }, {timeoutMs:stopTimeoutMs})
  }
  async function startUnlocked(bindingIds = [], options = {}) {
    const finish = startupProgress('正在启动后台服务')
    try {return await startPrepared(bindingIds, options)} finally {finish()}
  }
  async function startPrepared(bindingIds = [], { stopped = false } = {}) {
    const ids = [...new Set(bindingIds.map(String).filter(Boolean))]
    if (!ids.length) throw new Error('No selected bindings')
    if (workerPath.split(/[\\/]/).includes('_npx'))
      throw new Error(
        `请先执行 ${globalInstallHint({platform:'win32'})}，再执行 ${taskCommand('install', 'win32')}。`,
      )
    onProgress('正在检查现有后台服务状态...')
    const current = await status()
    const selected = await selectionSnapshot()
    if (current.ready && sameIds(ids, selected.bindingIds))
      return { ...current, alreadyRunning: true }
    if (!stopped && (current.loaded || (await readJson(paths.ownerFile)))) {
      onProgress('正在检查并清理旧后台状态...')
      await stopUnlocked()
    }
    const generation = randomUUID()
    const env = {}
    for (const [key, value] of Object.entries(environment)) {
      if (
        /^(AAMP_|LARKSUITE_CLI_CONFIG_DIR$|FEISHU_(?:USER_AUTH_[A-Z_]+|APP_(?:SCOPES|EVENTS)_(?:TENANT|USER)|SCOPE_MANIFEST_VERSION|TASK_PROFILE_DOMAINS)$|LARK_(?:CLI_MIN_VERSION|REGISTER_APP_SDK|CLI_CONFIG_LOCK_DIR|CLI_INSTALL_LOCK_DIR)$|CODEX_(?:PATH|AUTO_UPDATE|NPM_PACKAGE|UPDATE_CACHE_FILE|UPDATE_CACHE_TTL_SECONDS|UPDATE_LOCK_DIR)$|NPM_(?:REGISTRY|GLOBAL_PREFIX|CONFIG_[A-Z_]+)$|TRAE(?:CODE)?_CLI_BIN$|NODE_EXTRA_CA_CERTS$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|PATH$|SYSTEMROOT$|COMSPEC$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$)/i.test(
          key,
        )
      )
        env[key] = value
    }
    env.AAMP_TASK_NON_INTERACTIVE = 'true'
    // Keep the foreground adapter install location when pinning the worker runtime.
    env.AAMP_TASK_AIME_ACP_HOME = environment.AAMP_TASK_AIME_ACP_HOME
      || path.join(environment.AAMP_TASK_RUNTIME_HOME || path.join(homedir(), '.aamp', 'feishu-task-agent'), 'aime-acp')
    env.AAMP_TASK_CODEX_ACP_HOME = environment.AAMP_TASK_CODEX_ACP_HOME
      || path.join(environment.AAMP_TASK_RUNTIME_HOME || path.join(homedir(), '.aamp', 'feishu-task-agent'), 'codex-acp')
    env.NPM_GLOBAL_PREFIX = resolveWindowsNpmPrefix(environment)
    env.AAMP_TASK_RUNTIME_HOME = runtimeHome
    await writeJson(paths.selectionFile, {
      version: 1,
      generation,
      binding_ids: ids,
    })
    await writeJson(paths.configFile, {
      version: 1,
      generation,
      controllerPath,
      paths,
      env,
    })
    await fs.rm(paths.readinessFile, { force: true })
    await fs.rm(paths.stopFile, { force: true })
    await fs.rm(paths.stateFile, { force: true })
    onProgress('正在创建并启动 Windows 后台任务...')
    let logOffset=await fs.stat(paths.logFile).then(value=>value.size).catch(()=>0)
    let pendingLog=''
    const decoder=new StringDecoder('utf8')
    await scheduler('start', await config())
    onProgress('后台进程已派发，正在等待智能体和飞书连接就绪...')
    let lastRetry=0
    for (let i = 0; i < startupAttempts; i++) {
      const s = await status()
      // Forward only newly written stage lines; never replay historical logs or
      // write waiting heartbeats to the worker's persistent log.
      let log
      try {
        log=await fs.open(paths.logFile,'r')
        const chunk=Buffer.alloc(65536)
        const {bytesRead}=await log.read(chunk,0,chunk.length,logOffset)
        logOffset+=bytesRead
        pendingLog+=decoder.write(chunk.subarray(0,bytesRead))
        const lines=pendingLog.split(/\r?\n/)
        pendingLog=lines.pop().slice(-65536)
        for(const line of lines) if(line.startsWith('[aamp-one-click]') || line.startsWith('🔴')) onProgress(line)
      } catch(error) {if(error.code!=='ENOENT') onProgress('暂时无法读取后台进度日志')} finally {await log?.close()}
      const workerState=await readJson(paths.stateFile)
      if(workerState?.version===1 && workerState.generation===generation) {
        if(workerState.state==='failed' || workerState.state==='stopped') {
          const reason=workerState.reason || '后台进程在就绪前退出'
          throw new Error(`后台启动失败：${reason}（${workerState.errorCode || workerState.code || workerState.state}）；请执行 ${taskCommand('logs','win32')} 查看详情`)
        }
        if(workerState.state==='retrying' && workerState.attempt!==lastRetry) {
          lastRetry=workerState.attempt
          onProgress(`后台智能体退出，正在准备第 ${lastRetry} 次启动...`)
        }
      }
      if (s.ready) return { ...s, alreadyRunning: false }
      await wait(500)
    }
    throw new Error(`后台进程尚未就绪，请执行 ${taskCommand('logs', 'win32')} 查看原因`)
  }
  async function recentLogs(count = 100) {
    try {
      return (await fs.readFile(paths.logFile, 'utf8'))
        .trimEnd()
        .split(/\r?\n/)
        .slice(-Math.max(1, Math.min(1000, count)))
        .join('\n')
    } catch (e) {
      if (e.code === 'ENOENT') return ''
      throw e
    }
  }
  const locked = (operation) =>
    withWindowsOperationLock(
      path.join(serviceHome, '.lifecycle.lock'),
      operation,
    )
  return {
    paths,
    status,
    markReady,
    selection,
    selectionSnapshot,
    recentLogs,
    start: (ids) => locked(() => startUnlocked(ids)),
    stop: () => locked(stopUnlocked),
    restart: (ids, {beforeStart} = {}) =>
      locked(async () => {
        const next = ids || (await selection())
        await stopUnlocked()
        if (beforeStart) await beforeStart()
        return startUnlocked(next, { stopped: true })
      }),
  }
}

export const __test = Object.freeze({ schedulerScript, nativeScheduler, repairWindowsTaskPermissions })
