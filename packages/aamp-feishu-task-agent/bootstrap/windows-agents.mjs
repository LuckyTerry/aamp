import {taskCommand} from '../bin/platform-hints.mjs'
// Native launch descriptors preserve the Agent selected by the user.
import {access, readFile, mkdir, writeFile, realpath} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
import {homedir} from 'node:os'
import {createInterface} from 'node:readline/promises'
import defaults from './task-agent-defaults.json' with {type:'json'}
import {TASK_AGENT_TYPES} from '../bin/agent-metadata.mjs'
import {resolveNativeCommand, atomicReplaceWindows} from '../bin/windows-platform.mjs'
import {taskAgentVersionIsNewer} from './windows-update.mjs'
import {withWindowsOperationLock} from '../bin/windows-operation-lock.mjs'
import {parseTraeCodeDoctor, supportsTraeCodeAcpHelp} from '../bin/traecode-readiness.mjs'
import {warnInvalidAgentPath} from './windows-agent-path-warning.mjs'
import {probeCodex} from '../bin/codex-readiness.mjs'

const agents = {
  cursor: {names:['cursor-agent','agent'], variables:['AAMP_CURSOR_CLI_BIN'], args:['acp']},
  coco: {names:['coco'], variables:['AAMP_COCO_CLI_BIN','AAMP_TRAE_CLI_BIN','TRAE_CLI_BIN'], args:['acp','serve']},
  traex: {names:['traex'], variables:['AAMP_TRAEX_CLI_BIN','AAMP_TRAE_CLI_BIN','TRAE_CLI_BIN'], args:['acp','serve']},
  traecli: {names:['traecli'], variables:['AAMP_TRAECODE_CLI_BIN','TRAECODE_CLI_BIN'], args:['acp','serve']},
  workbuddy: {names:['workbuddy'], variables:['AAMP_WORKBUDDY_CLI_BIN'], args:['--acp'], config:'.workbuddy', app:'WorkBuddy'},
  workbuddy_ai: {names:['workbuddy-ai'], variables:['AAMP_WORKBUDDY_AI_CLI_BIN'], args:['--acp'], config:'.workbuddy-ai', app:'WorkBuddy AI'},
  codebuddy: {names:['codebuddy','cbc'], variables:[], args:['--acp']},
  aime: {names:['aime-acp'], variables:['AAMP_AIME_ACP_BIN'], args:['--site','cn']},
}

async function descriptor(candidate, env) {
  if (!candidate) return undefined
  try {
    if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
      await access(candidate, constants.R_OK)
      if (/\.(?:c?js|mjs)$/i.test(candidate)) return {command:process.execPath,argsPrefix:[candidate]}
      if (/\.(?:bat|ps1)$/i.test(candidate)) return undefined
      if (!/\.cmd$/i.test(candidate)) {
        await access(candidate, constants.X_OK)
        return {command:candidate,argsPrefix:[]}
      }
      return await resolveNativeCommand(path.basename(candidate), {platform:'win32',env:{PATH:path.dirname(candidate)}})
    }
    const resolved = await resolveNativeCommand(candidate, {platform:'win32',env})
    return /\.(?:bat|cmd|ps1)$/i.test(resolved.command) ? undefined : resolved
  } catch {return undefined}
}

async function workbuddyNodeEntry(file) {
  try {
    const source = await readFile(file, 'utf8')
    if (/^#![^\r\n]*\bnode(?:\s|$)/.test(source)) return {command:process.execPath,argsPrefix:[file]}
  } catch {}
}

async function findWorkbuddyApp(app, env) {
  const value = name => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const local = value('LOCALAPPDATA')
  const roots = [local && path.isAbsolute(local) && path.join(local,'Programs'), value('ProgramW6432'), value('ProgramFiles'), value('ProgramFiles(x86)')]
  for (const root of new Set(roots)) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue
    const found = await workbuddyNodeEntry(path.join(root,app,'resources','app.asar.unpacked','cli','bin','codebuddy'))
    if (found) return found
  }
}

export async function findWindowsAgent(type, env, run) {
  const definition = agents[type]
  if (!definition) return undefined
  let rejectionReason
  const resolveCandidate = async candidate => {
    // App-bundled codebuddy has a Node shebang but no extension on Windows.
    if (definition.app && !path.extname(candidate) && (path.isAbsolute(candidate) || /[\\/]/.test(candidate))) {
      return workbuddyNodeEntry(candidate)
    }
    const found = await descriptor(candidate, env)
    if (found && type === 'traecli') {
      const coco = await findWindowsAgent('coco', env, run)
      if (coco) {
        // npm shims share node.exe; their JavaScript entry is the CLI identity.
        const entry = command => command.argsPrefix?.[0] || command.command
        const [traePath, cocoPath] = await Promise.all([
          realpath(entry(found)).catch(() => undefined),
          realpath(entry(coco)).catch(() => undefined),
        ])
        if (traePath && traePath === cocoPath) {
          rejectionReason = 'TraeCode CLI 与 Coco 指向同一实际入口，不能作为 TraeCode 使用'
          return undefined
        }
      }
    }
    if (!found || type !== 'cursor' || path.basename(candidate).replace(/\.(exe|com|cmd|mjs|cjs|js)$/i,'').toLowerCase() !== 'agent') return found
    // The generic name may belong to another product; match the macOS identity probe.
    try {
      const result = await run(found, ['login','--help'], {env,timeout:10000})
      if (`${result.stdout}\n${result.stderr}`.includes('Authenticate with Cursor')) return found
      rejectionReason = '通用 agent 命令未通过 Cursor 身份检查'
      return undefined
    } catch (error) {
      rejectionReason = error.code === 'ETIMEDOUT' ? 'Cursor 身份检查超时' : 'Cursor 身份检查执行失败'
      return undefined
    }
  }
  for (const key of definition.variables) {
    const value = env[key]
    if (!value) continue
    // Legacy TRAE_CLI_BIN is shared; do not advertise another binary as Coco.
    if (['AAMP_TRAE_CLI_BIN','TRAE_CLI_BIN'].includes(key) && path.basename(value).replace(/\.(exe|cmd|mjs|cjs|js)$/i,'') !== type) continue
    if (type === 'traecli' && /^(coco|traex)$/i.test(path.basename(value).replace(/\.(exe|com|cmd|bat|ps1|mjs|cjs|js)$/i,''))) {
      await warnInvalidAgentPath(key,value,{reason:'TraeCode CLI 路径不能指向 coco 或 traex；请指定 traecli 的启动入口'})
      return undefined
    }
    const found = await resolveCandidate(value)
    if (!found) await warnInvalidAgentPath(key,value,{reason:rejectionReason,fallback:type === 'aime'})
    return found
  }
  if (definition.app) {
    const found = await findWorkbuddyApp(definition.app, env)
    if (found) return found
  }
  if (type === 'cursor') {
    const dedicated = await resolveCandidate('cursor-agent')
    if (dedicated) return dedicated
    const localAppData = env.LOCALAPPDATA || Object.entries(env)
      .find(([key, value]) => key.toLowerCase() === 'localappdata' && value)?.[1]
    // Mirror macOS: dedicated PATH command, official user installation, then
    // the generic PATH alias. Keep the existing strict explicit-path behavior.
    if (typeof localAppData === 'string' && path.isAbsolute(localAppData)) {
      for (const name of ['cursor-agent.exe', 'cursor-agent.cmd', 'agent.exe', 'agent.cmd']) {
        const found = await resolveCandidate(path.join(localAppData, 'cursor-agent', name))
        if (found) return found
      }
    }
    return resolveCandidate('agent')
  }
  for (const name of definition.names) {
    const found = await resolveCandidate(name)
    if (found) return found
    if (type === 'traecli' && rejectionReason) console.error(`[aamp-one-click] ${rejectionReason}。请检查 traecli 的安装入口或配置 AAMP_TRAECODE_CLI_BIN。`)
  }
}

export async function discoverWindowsAgents(env, resolveCodex, run) {
  const found = new Map()
  for (const type of TASK_AGENT_TYPES) {
    if (type === 'aime') {
      if (env.AAMP_TASK_USER_TENANT_KEY === defaults.aime.allowedTenantKey) found.set(type, null)
    } else if (type === 'codex') {
      if (await resolveCodex()) found.set(type, null)
    } else {
      const command = await findWindowsAgent(type,env,run)
      if (command) found.set(type,command)
    }
  }
  // Preserve the macOS menu: offer only the first installed member of this family.
  const traeFamily = ['traex','coco','traecli']
  const preferred = traeFamily.find(type => found.has(type))
  for (const type of traeFamily) {
    if (type !== preferred) found.delete(type)
  }
  return [...found.keys()]
}

export async function confirmWindowsAgentAction(question) {
  if (!process.stdin.isTTY) return false
  const reader = createInterface({input:process.stdin,output:process.stdout})
  try {return /^(y|yes)$/i.test((await reader.question(`${question} [y/N] `)).trim())}
  finally {reader.close()}
}

function interactive(env) {
  if (env.AAMP_TASK_NON_INTERACTIVE === 'true') throw new Error(`后台服务无法完成交互式准备；请在终端执行 ${taskCommand('start', 'win32')} 完成登录或升级。`)
}

export async function ensureWindowsAgentLogin(type, command, env, run) {
  if (env.AAMP_TASK_SKIP_LOGIN_CHECK === 'true') return
  const check = async () => {
    const result = await run(command, type === 'cursor' ? ['status'] : ['login','status'], {env,timeout:10000})
    if (type === 'cursor' && /not logged in|logged out/i.test(result.stdout)) throw new Error('Cursor 未登录')
  }
  try {await check()} catch (error) {
    if (type === 'codex') {
      if ([130, 143].includes(error.code)) throw new Error('Codex 启动检查已取消。', {cause: error})
      console.log('Codex 登录状态未通过，正在验证当前模型配置（最多 45 秒，可能消耗少量模型额度）...')
      await probeCodex(command, {env})
      console.log('Codex 当前模型配置可用，继续启动。')
      return
    }
    if (error.code === 'ETIMEDOUT') throw error
    interactive(env)
    console.log(`${type} 尚未登录，正在启动登录流程。`)
    await run(command,['login'],{env,stdio:'inherit'})
    await check()
  }
}

export async function prepareWindowsNativeAgent(type, env, {run, npmLaunch, confirm = confirmWindowsAgentAction}) {
  const definition = agents[type]
  if (!definition) throw new Error(`Unknown native Agent: ${type}`)
  let command = await findWindowsAgent(type,env,run)
  if (type === 'aime' && !command) {
    // AIME is a tenant-gated remote Agent, not a local desktop installation.
    const root = env.AAMP_TASK_AIME_ACP_HOME
      || path.join(env.AAMP_TASK_RUNTIME_HOME || path.join(homedir(),'.aamp','feishu-task-agent'),'aime-acp')
    const file = path.join(root,'node_modules','@tengchengwei','aime-acp','dist','bin.js')
    command = await descriptor(file,env)
    if (!command) {
      interactive(env)
      const npm = await npmLaunch(env)
      await run(npm.command,[...npm.args,'install','--prefix',root,'--registry','https://bnpm.byted.org',env.AAMP_TASK_AIME_ACP_PKG || defaults.packages.aimeAcp],{env,stdio:'inherit'})
      command = await descriptor(file,env)
    }
  }
  if (!command) throw new Error(`未检测到 ${type} 原生 CLI；请先安装或配置其 CLI 路径。`)
  if (type === 'cursor' || type === 'traex') await ensureWindowsAgentLogin(type,command,env,run)
  if (type === 'coco' || type === 'traex' || type === 'traecli') {
    const probe = async () => {
      const result = await run(command,['acp','serve','--help'],{env,timeout:10000})
      if (!supportsTraeCodeAcpHelp(result.stdout + '\n' + result.stderr)) throw new Error(`${type} 尚不支持 acp serve`)
    }
    try {await probe()} catch (error) {
      if (error.code === 'ETIMEDOUT') throw error
      interactive(env)
      if (!await confirm(`${type} 当前版本不支持 ACP，是否执行 ${type} update？`)) return {cancelled:true,agent_type:type,reason:'用户取消升级，本次未启动飞书任务连接。'}
      await run(command,['update'],{env,stdio:'inherit'})
      command = await findWindowsAgent(type,env,run)
      if (!command) throw new Error(`升级后未找到 ${type}；请检查 CLI 路径。`)
      await probe()
    }
    if (type === 'traecli' && env.AAMP_TASK_SKIP_LOGIN_CHECK !== 'true') {
      const result = await run(command,['doctor','--json'],{env,timeout:10000,allowedExitCodes:[0,1,2]})
      const doctor = parseTraeCodeDoctor(result.stdout,homedir())
      if (doctor.status !== 'ready') throw new Error('TraeCode CLI 尚未准备好；请打开 CLI 完成登录和模型配置后重试。')
      for (const warning of doctor.warnings) console.log(`TraeCode CLI: ${warning.message}`)
    }
  }
  if (type === 'aime') {
    const probe = async (args, options = {}) => {
      try { return await run(command,args,{env,timeout:60000,...options}) }
      catch (error) {
        if(error.code === 'ETIMEDOUT') throw Object.assign(new Error(`AIME ${args[0]} 检查超时（60000ms），请检查网络后重试。`),{code:'ETIMEDOUT'})
        throw error
      }
    }
    const result = await probe(['auth','status','--site','cn','--json'],{allowedExitCodes:[0,1]})
    const status = JSON.parse(result.stdout)
    if (!status.ok || !['authenticated','unauthenticated'].includes(status.status)) throw new Error('AIME 认证状态检查失败')
    if (status.status === 'unauthenticated') {
      interactive(env)
      await run(command,['auth','login','--site','cn'],{env,stdio:'inherit'})
    }
    await probe(['doctor','--site','cn','--json'])
  }
  return {command:command.command,args:[...(command.argsPrefix || []),...definition.args],
    ...(definition.config ? {env:{CODEBUDDY_CONFIG_DIR:path.join(homedir(),definition.config),CODEBUDDY_SKIP_BUILTIN_MARKETPLACE:'1'}} : {})}
}

export async function ensureWindowsCodexUpdated(codex, env, {run,npmLaunch,confirm = confirmWindowsAgentAction}) {
  if ((env.CODEX_AUTO_UPDATE || 'true') !== 'true' || env.AAMP_TASK_NON_INTERACTIVE === 'true') return
  const packageName = env.CODEX_NPM_PACKAGE || defaults.packages.codexCli
  const registry = env.NPM_REGISTRY || env.AAMP_TASK_NPM_REGISTRY || 'https://registry.npmjs.org/'
  const file = env.CODEX_UPDATE_CACHE_FILE || path.join(homedir(),'.aamp','feishu-task-agent','codex-update-cache.json')
  const version = value => String(value).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
  try {
    const current = version((await run(codex,['--version'],{env,timeout:10000})).stdout)
    if (!current) return
    let cache
    try {cache = JSON.parse(await readFile(file,'utf8'))} catch {}
    const age = Date.now()/1000 - cache?.checked_at
    const ttl = Number(env.CODEX_UPDATE_CACHE_TTL_SECONDS || 86400)
    let latest = cache?.version === 1 && cache.current_version === current && cache.package === packageName && cache.registry === registry && age >= 0 && age < ttl ? version(cache.latest_version) : undefined
    if (!latest) {
      const npm = await npmLaunch(env)
      latest = version((await run(npm.command,[...npm.args,'view',packageName,'version','--registry',registry],{env,timeout:10000})).stdout)
      if (!latest) return
      await mkdir(path.dirname(file),{recursive:true})
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary,JSON.stringify({version:1,checked_at:Math.floor(Date.now()/1000),current_version:current,latest_version:latest,package:packageName,registry}),{mode:0o600})
      if (process.platform === 'win32') await atomicReplaceWindows(temporary,file)
      else await (await import('node:fs/promises')).rename(temporary,file)
    }
    if (!taskAgentVersionIsNewer(current,latest)) return
    console.log(`当前 Codex CLI 版本是：${current}，最新版本是：${latest}`)
    if (!await confirm('是否现在升级 Codex CLI？')) return
    const lock = env.CODEX_UPDATE_LOCK_DIR || path.join(path.dirname(file),'codex-cli-update.lock')
    await withWindowsOperationLock(lock,()=>run(codex,['update'],{env,stdio:'inherit'}))
  } catch (error) {console.warn(`Codex 升级检查或升级失败，继续使用当前版本：${error.message}`)}
}
