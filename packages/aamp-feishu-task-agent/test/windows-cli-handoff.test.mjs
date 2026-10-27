import assert from 'node:assert/strict'
import {test} from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {runWindowsHelper} from '../bootstrap/windows-helper.mjs'
import {createWindowsServiceManager} from '../bin/windows-service.mjs'
import {resolveWindowsNpmPrefix} from '../bootstrap/windows-runtime-paths.mjs'

test('Windows npm prefix preserves default and explicit precedence',()=>{
  const home=path.join(os.tmpdir(),'fixture-home')
  assert.equal(resolveWindowsNpmPrefix({},home),path.join(home,'.aamp','feishu-task-agent','npm-global'))
  assert.equal(resolveWindowsNpmPrefix({AAMP_TASK_RUNTIME_HOME:'custom'},home),path.join('custom','npm-global'))
  assert.equal(resolveWindowsNpmPrefix({AAMP_TASK_NPM_GLOBAL_PREFIX:'aamp',NPM_GLOBAL_PREFIX:'npm'},home),'npm')
  assert.equal(resolveWindowsNpmPrefix({AAMP_TASK_NPM_GLOBAL_PREFIX:'aamp'},home),'aamp')
})

for(const mode of ['runtime-default','npm-prefix','aamp-prefix','both-prefixes','explicit-cli','path-cli']) {
test(`background reuses foreground CLI with ${mode}`, {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'aamp-cli-handoff-')))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const preparationHome=path.join(root,'preparation')
  const prefix=mode==='runtime-default' ? path.join(preparationHome,'npm-global') : path.join(root,'custom-prefix')
  const bin=path.join(prefix,'node_modules','fixture','cli.mjs')
  await fs.mkdir(path.dirname(bin),{recursive:true})
  await fs.writeFile(bin,`const args=process.argv.slice(2);if(args[0]==='--version')console.log('lark-cli version 1.0.64');else if(args.join(' ')==='profile list')console.log('["fixture-profile"]');else if(args.includes('status'))console.log('{}');else {console.error('unexpected mutation');process.exitCode=1}`)
  await fs.writeFile(path.join(prefix,'lark-cli.cmd'),'@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\fixture\\cli.mjs" %*\r\n')
  const environment={AAMP_TASK_RUNTIME_HOME:preparationHome,AAMP_LARK_CLI_BIN:'',AAMP_LARK_CLI_CONFIG_DIR:path.join(root,'config'),AAMP_FEISHU_AUTH_STATE_DIR:path.join(root,'auth'),FEISHU_USER_AUTH_MODE:'disabled',PATH:path.dirname(process.execPath)+';'+path.join(process.env.SystemRoot,'System32'),PATHEXT:'.EXE;.CMD'}
  if(mode==='npm-prefix'||mode==='both-prefixes') environment.NPM_GLOBAL_PREFIX=prefix
  if(mode==='aamp-prefix') environment.AAMP_TASK_NPM_GLOBAL_PREFIX=prefix
  if(mode==='both-prefixes') environment.AAMP_TASK_NPM_GLOBAL_PREFIX=path.join(root,'unused-prefix')
  if(mode==='explicit-cli') environment.AAMP_LARK_CLI_BIN=bin
  if(mode==='path-cli') environment.PATH=prefix+';'+environment.PATH
  const binding={agent_type:'codex',bot:{app_id:'cli_fixture',lark_cli_profile:'fixture-profile'}}
  const foreground=await runWindowsHelper('__probe-profile',binding,environment)
  assert.equal(foreground.ready,true,'foreground must find the installed fixture CLI')
  const manager=createWindowsServiceManager({runtimeHome:path.join(preparationHome,'runtime-v1'),environment,controllerPath:'controller',workerPath:'worker',currentSid:async()=>'S-1-5-21-1',ensurePrivateDirectory:dir=>fs.mkdir(dir,{recursive:true}),scheduler:async()=>({loaded:false,state:'Ready'}),startupAttempts:0})
  await assert.rejects(manager.start(['fixture-binding']),/尚未就绪/)
  const config=JSON.parse(await fs.readFile(manager.paths.configFile,'utf8'))
  const background=await runWindowsHelper('__probe-profile',binding,config.env)
  assert.equal(background.ready,true,'background must find the same CLI despite runtime home change')
  assert.equal(background.lark_cli_bin,foreground.lark_cli_bin)
})
}
