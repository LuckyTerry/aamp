import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findWindowsAgent,prepareWindowsNativeAgent,discoverWindowsAgents} from '../bootstrap/windows-agents.mjs'

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'aamp-workbuddy-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const env={PATH:'',Path:'',ProgramFiles:path.join(root,'Program Files'),LOCALAPPDATA:path.join(root,'Local')}
  async function app(name,base=env.ProgramFiles,content='#!/usr/bin/env node\n') {
    const file=path.join(base,name,'resources','app.asar.unpacked','cli','bin','codebuddy')
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);return file
  }
  return {root,env,app}
}

test('Windows WorkBuddy discovers bundled Node entry and prepares isolated ACP configuration',async t=>{
  const {env,app}=await fixture(t);const file=await app('WorkBuddy')
  assert.deepEqual(await findWindowsAgent('workbuddy',env),{command:process.execPath,argsPrefix:[file]})
  const launch=await prepareWindowsNativeAgent('workbuddy',env,{run:()=>{throw Error('must not run a login command')}})
  assert.deepEqual(launch.args,[file,'--acp'])
  assert.equal(path.basename(launch.env.CODEBUDDY_CONFIG_DIR),'.workbuddy')
  assert.equal(launch.env.CODEBUDDY_SKIP_BUILTIN_MARKETPLACE,'1')
  assert.equal(await findWindowsAgent('workbuddy_ai',env),undefined)
})

test('WorkBuddy AI uses its own user installation and case insensitive Windows environment names',async t=>{
  const {env,app}=await fixture(t);const file=await app('WorkBuddy AI',path.join(env.LOCALAPPDATA,'Programs'))
  const mixed={PATH:'',localappdata:env.LOCALAPPDATA,programfiles:env.ProgramFiles}
  assert.deepEqual(await findWindowsAgent('workbuddy_ai',mixed),{command:process.execPath,argsPrefix:[file]})
  assert.equal(await findWindowsAgent('workbuddy',mixed),undefined)
})

test('explicit WorkBuddy path takes precedence and an invalid override does not fall back',async t=>{
  const {env,app,root}=await fixture(t);await app('WorkBuddy')
  const explicit=path.join(root,'codebuddy');await writeFile(explicit,'#!/usr/bin/env node\n')
  assert.deepEqual(await findWindowsAgent('workbuddy',{...env,AAMP_WORKBUDDY_CLI_BIN:explicit}),{command:process.execPath,argsPrefix:[explicit]})
  assert.equal(await findWindowsAgent('workbuddy',{...env,AAMP_WORKBUDDY_CLI_BIN:path.join(root,'missing')}),undefined)
})

test('both desktop editions appear independently and user installation precedes system installation',async t=>{
  const {env,app}=await fixture(t)
  await app('WorkBuddy');await app('WorkBuddy AI')
  const user=await app('WorkBuddy',path.join(env.LOCALAPPDATA,'Programs'))
  assert.deepEqual(await discoverWindowsAgents(env,async()=>undefined),['workbuddy','workbuddy_ai'])
  assert.equal((await findWindowsAgent('workbuddy',env)).argsPrefix[0],user)
  const launch=await prepareWindowsNativeAgent('workbuddy_ai',env,{})
  assert.equal(path.basename(launch.env.CODEBUDDY_CONFIG_DIR),'.workbuddy-ai')
})

test('unrecognized bundled files are rejected and existing PATH shim remains supported',async t=>{
  const {env,app,root}=await fixture(t);await app('WorkBuddy',env.ProgramFiles,'not a Node CLI')
  assert.equal(await findWindowsAgent('workbuddy',env),undefined)
  const js=path.join(root,'entry.js');await writeFile(js,'')
  await writeFile(path.join(root,'workbuddy.cmd'),'@echo off\r\nnode "%~dp0\\entry.js" %*\r\n')
  assert.deepEqual(await findWindowsAgent('workbuddy',{...env,PATH:root,Path:root}),{command:process.execPath,argsPrefix:[await realpath(js)]})
})

test('native and x86 Program Files roots are supported without changing product identity',async t=>{
  const {env,app,root}=await fixture(t)
  for (const key of ['ProgramW6432','ProgramFiles(x86)']) {
    const base=path.join(root,key)
    const file=await app('WorkBuddy',base)
    assert.deepEqual(await findWindowsAgent('workbuddy',{...env,[key]:base}),{command:process.execPath,argsPrefix:[file]})
  }
})
