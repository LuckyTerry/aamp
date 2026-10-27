import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {runWindowsHelper} from '../bootstrap/windows-helper.mjs'
import {createDraft} from '../bin/feishu-task-agent-controller.mjs'
import {ensureWindowsCodexUpdated, ensureWindowsAgentLogin, prepareWindowsNativeAgent} from '../bootstrap/windows-agents.mjs'
import {versionAtLeast} from '../bootstrap/windows-helper.mjs'

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'aamp-agent-selection-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const coco=path.join(root,'coco.mjs')
  await writeFile(coco,`if(process.argv.includes('--help'))console.log('Usage: coco acp serve; Start the ACP server');else console.log(JSON.stringify({args:process.argv.slice(2),proxy:process.env.HTTPS_PROXY}));`)
  return {root,coco,env:{PATH:'',Path:'',ProgramFiles:root,ProgramW6432:root,'ProgramFiles(x86)':root,LOCALAPPDATA:root,AAMP_COCO_CLI_BIN:coco,AAMP_CODEX_CLI_BIN:process.execPath,AAMP_TASK_RUNTIME_HOME:root,AAMP_LARK_CLI_CONFIG_DIR:path.join(root,'lark'),CODEX_AUTO_UPDATE:'false',AAMP_TASK_SKIP_LOGIN_CHECK:'true',HTTPS_PROXY:'http://proxy.example.test:8080'}}
}

test('AIME background preparation reuses the foreground adapter installation',async t=>{
  const {root,env}=await fixture(t)
  const installHome=path.join(root,'foreground','aime-acp')
  const file=path.join(installHome,'node_modules','@tengchengwei','aime-acp','dist','bin.js')
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'// fixture')
  const result=await prepareWindowsNativeAgent('aime',{
    ...env,AAMP_TASK_RUNTIME_HOME:path.join(root,'runtime-v1'),
    AAMP_TASK_AIME_ACP_HOME:installHome,AAMP_TASK_NON_INTERACTIVE:'true',
  },{
    npmLaunch:async()=>assert.fail('must not reinstall'),
    run:async(command,args,options)=>{
      assert.deepEqual(command.argsPrefix,[file])
      if(options.timeout < 45000) throw Object.assign(new Error('slow remote probe'),{code:'ETIMEDOUT'})
      return {stdout:JSON.stringify({ok:true,status:'authenticated'}),stderr:''}
    },
  })
  assert.equal(result.args[0],file)
  for(const step of ['auth','doctor']) {
    await assert.rejects(prepareWindowsNativeAgent('aime',{
      ...env,AAMP_TASK_AIME_ACP_HOME:installHome,
    },{
      run:async(command,args)=>{
        if(args[0]===step)throw Object.assign(new Error('command timed out'),{code:'ETIMEDOUT'})
        return {stdout:JSON.stringify({ok:true,status:'authenticated'}),stderr:''}
      },
    }),new RegExp(`AIME ${step}.*60000`))
  }
})

test('scan offers installed Agents, user chooses Coco, and the wrapper actually executes Coco',async t=>{
  const {root,env}=await fixture(t)
  let chosen=false
  const binding=await createDraft(new Set(),{
    registerBinding:async()=>({app_id:'cli_selected',app_secret:'test-secret',lark_cli_profile:'aamp-test',tenant_brand:'feishu'}),
    discoverAgents:async()=> (await runWindowsHelper('__discover-agents',{},env)).agents,
    defaultAgent:'',
    chooseAgent:async agents=>{assert.deepEqual(agents,['codex','coco']);chosen=true;return 'coco'},
  })
  assert.equal(chosen,true)
  assert.equal(binding.agent_type,'coco')
  const result=await runWindowsHelper('__prepare-agent',binding,env)
  assert.equal(result.agent_type,'coco')
  assert.equal(result.lark_cli_config_dir,env.AAMP_LARK_CLI_CONFIG_DIR)
  const config=JSON.parse(await readFile(path.join(root,'windows-coco-agent.json'),'utf8'))
  assert.deepEqual(config.args,[env.AAMP_COCO_CLI_BIN,'acp','serve'])
  assert.equal('CODEX_PATH' in (config.env || {}),false)
  const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/windows-agent-wrapper.mjs',import.meta.url)),path.join(root,'windows-coco-agent.json')],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c)
  const code=await new Promise(resolve=>child.once('close',resolve))
  assert.equal(code,0,errors)
  assert.deepEqual(JSON.parse(output),{args:['acp','serve'],proxy:env.HTTPS_PROXY})
})

test('Trae family discovery follows macOS priority and AIME retains its tenant gate',async t=>{
  const {env,root}=await fixture(t)
  for(const [key,name] of [['AAMP_CURSOR_CLI_BIN','cursor'],['AAMP_TRAEX_CLI_BIN','traex'],['AAMP_TRAECODE_CLI_BIN','traecli'],['AAMP_WORKBUDDY_CLI_BIN','workbuddy'],['AAMP_WORKBUDDY_AI_CLI_BIN','workbuddy-ai']]){
    env[key]=path.join(root,`${name}.mjs`);await writeFile(env[key],'')
  }
  assert.deepEqual((await runWindowsHelper('__discover-agents',{},env)).agents,['codex','cursor','traex','workbuddy','workbuddy_ai'])
  env.AAMP_TRAEX_CLI_BIN=path.join(root,'missing-traex')
  assert.deepEqual((await runWindowsHelper('__discover-agents',{},env)).agents,['codex','cursor','coco','workbuddy','workbuddy_ai'])
  env.AAMP_COCO_CLI_BIN=path.join(root,'missing-coco')
  assert.deepEqual((await runWindowsHelper('__discover-agents',{},env)).agents,['codex','cursor','traecli','workbuddy','workbuddy_ai'])
  assert.equal((await runWindowsHelper('__discover-agents',{}, {...env,AAMP_TASK_USER_TENANT_KEY:'other'})).agents.includes('aime'),false)
  assert.equal((await runWindowsHelper('__discover-agents',{}, {...env,AAMP_TASK_USER_TENANT_KEY:'736588c9260f175d'})).agents.includes('aime'),true)
})

test('Cursor missing login still opens login and rechecks; noninteractive worker refuses recovery',async()=>{
  const calls=[]
  const run=async(_command,args)=>{calls.push(args);if(calls.length===1)throw new Error('not logged in');return {stdout:'',stderr:''}}
  await ensureWindowsAgentLogin('cursor','cursor.exe',{},run)
  assert.deepEqual(calls,[['status'],['login'],['status']])
  const worker=[]
  await assert.rejects(ensureWindowsAgentLogin('cursor','cursor.exe',{AAMP_TASK_NON_INTERACTIVE:'true'},async(_command,args)=>{worker.push(args);throw new Error('not logged in')}),/后台/)
  assert.deepEqual(worker,[['status']])
})

test('Codex newer version asks permission, remembers the probe, and honors skip/no decisions',async t=>{
  const {root}=await fixture(t)
  const env={CODEX_UPDATE_CACHE_FILE:path.join(root,'codex-update.json'),CODEX_UPDATE_LOCK_DIR:path.join(root,'update.lock')}
  const calls=[];let confirmations=0
  const run=async(_command,args)=>{calls.push(args);return {stdout:args[0]==='--version'?'codex 1.0.0':args[0]==='view'?'1.1.0':'',stderr:''}}
  const operations={run,npmLaunch:async()=>({command:'npm',args:[]}),versionAtLeast,confirm:async()=>{confirmations++;return false}}
  await ensureWindowsCodexUpdated('codex.exe',env,operations)
  await ensureWindowsCodexUpdated('codex.exe',env,{...operations,confirm:async()=>{confirmations++;return true}})
  assert.equal(confirmations,2)
  assert.equal(calls.filter(args=>args[0]==='view').length,1)
  assert.equal(calls.filter(args=>args[0]==='update').length,1)
  await ensureWindowsCodexUpdated('codex.exe',{...env,CODEX_AUTO_UPDATE:'false'},operations)
  await ensureWindowsCodexUpdated('codex.exe',{...env,AAMP_TASK_NON_INTERACTIVE:'true'},operations)
  assert.equal(confirmations,2)
})

test('PATH discovery excludes opaque batch Agents instead of advertising an unlaunchable choice',async t=>{
  const {root}=await fixture(t)
  await writeFile(path.join(root,'coco.BAT'),'@echo off\r\nexit /b 0\r\n')
  const result=await runWindowsHelper('__discover-agents',{}, {PATH:root,Path:root,PATHEXT:'.BAT',AAMP_WINDOWS_TEST_PLATFORM:'win32',AAMP_CODEX_CLI_BIN:path.join(root,'missing')})
  assert.equal(result.agents.includes('coco'),false)
})

test('Codex prerelease-to-stable upgrade retains semantic version ordering',async t=>{
  const {root}=await fixture(t);let confirmed=false
  await ensureWindowsCodexUpdated('codex.exe',{CODEX_UPDATE_CACHE_FILE:path.join(root,'pre.json')},{npmLaunch:async()=>({command:'npm',args:[]}),run:async(_cmd,args)=>({stdout:args[0]==='--version'?'codex 1.0.0-rc.1':'1.0.0',stderr:''}),confirm:async()=>{confirmed=true;return false}})
  assert.equal(confirmed,true)
})


test('generic agent npm shim must identify itself as Cursor before discovery or preparation',async t=>{
  const {root,env}=await fixture(t)
  const entry=path.join(root,'generic.mjs')
  await writeFile(path.join(root,'agent.CMD'),'@SET "dp0=%~dp0"\r\n@"node" "%dp0%/generic.mjs" %*\r\n')
  const scanEnv={...env,PATH:root,Path:root,PATHEXT:'.CMD'}
  for(const [body,expected] of [
    ["console.log('Unrelated Agent')",false],
    ["console.log('Authenticate with Cursor')",true],
    ["console.error('Authenticate with Cursor')",true],
    ["console.log('Authenticate with Cursor');process.exitCode=1",false],
  ]){
    await writeFile(entry,`if(process.argv.slice(2).join(' ')!=='login --help')throw new Error('unexpected probe');${body}`)
    assert.equal((await runWindowsHelper('__discover-agents',{},scanEnv)).agents.includes('cursor'),expected)
  }
  await writeFile(entry,"console.log('Unrelated Agent')")
  await assert.rejects(runWindowsHelper('__prepare-agent',{agent_type:'cursor'},scanEnv),/未检测到 cursor/)
  // A dedicated cursor-agent name remains trusted, just as on macOS.
  await writeFile(path.join(root,'cursor-agent.CMD'),'@SET "dp0=%~dp0"\r\n@"node" "%dp0%/generic.mjs" %*\r\n')
  assert.equal((await runWindowsHelper('__discover-agents',{},scanEnv)).agents.includes('cursor'),true)
})
