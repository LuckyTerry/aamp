import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findWindowsAgent, discoverWindowsAgents, prepareWindowsNativeAgent} from '../bootstrap/windows-agents.mjs'
import {createDraft} from '../bin/feishu-task-agent-controller.mjs'

async function fixture(t) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),"aamp codebuddy's ")))
  t.after(()=>rm(root,{recursive:true,force:true}))
  return {root,env:{PATH:root,Path:root,ProgramFiles:root,LOCALAPPDATA:root}}
}
const noRun=()=>assert.fail('discovery/preparation must not invoke login or a model')

test('Windows independent CodeBuddy npm shims resolve to Node with ACP args and no desktop config',async t=>{
  const {root,env}=await fixture(t)
  const entry=path.join(root,'bin','codebuddy')
  await mkdir(path.dirname(entry));await writeFile(entry,'#!/usr/bin/env node\n')
  const shim='@echo off\r\nnode "%~dp0\\bin\\codebuddy" %*\r\n'
  await writeFile(path.join(root,'cbc.cmd'),shim)
  assert.deepEqual(await findWindowsAgent('codebuddy',env,noRun),{command:process.execPath,argsPrefix:[entry]})
  assert.deepEqual(await discoverWindowsAgents(env,async()=>undefined,noRun),['codebuddy'])
  assert.deepEqual(await prepareWindowsNativeAgent('codebuddy',env,{run:noRun}),{command:process.execPath,args:[entry,'--acp']})
  await writeFile(path.join(root,'codebuddy.cmd'),shim)
  assert.deepEqual(await discoverWindowsAgents(env,async()=>undefined,noRun),['codebuddy'])
  const desktop=path.join(root,'WorkBuddy','resources','app.asar.unpacked','cli','bin','codebuddy')
  await mkdir(path.dirname(desktop),{recursive:true});await writeFile(desktop,'#!/usr/bin/env node\n')
  assert.deepEqual(await discoverWindowsAgents(env,async()=>undefined,noRun),['workbuddy','codebuddy'])
  let selected=false
  const binding=await createDraft(new Set(),{
    registerBinding:async()=>({app_id:'cli_codebuddy_test',app_secret:'test-only',lark_cli_profile:'test'}),
    discoverAgents:()=>discoverWindowsAgents(env,async()=>undefined,noRun),defaultAgent:'',
    chooseAgent:async agents=>{assert.ok(agents.includes('codebuddy'));selected=true;return 'codebuddy'},
  })
  assert.equal(selected,true);assert.equal(binding.agent_type,'codebuddy')
})

test('Windows CodeBuddy prefers its canonical command and rejects missing/unsupported entries',async t=>{
  const {root,env}=await fixture(t)
  assert.equal(await findWindowsAgent('codebuddy',env,noRun),undefined)
  await assert.rejects(prepareWindowsNativeAgent('codebuddy',env,{run:noRun}),/未检测到 codebuddy/)
  for(const name of ['codebuddy','cbc']) {
    await writeFile(path.join(root,`${name}.exe`),'fixture');await chmod(path.join(root,`${name}.exe`),0o755)
  }
  assert.equal((await findWindowsAgent('codebuddy',env,noRun)).command,path.join(root,'codebuddy.exe'))
})

test('POSIX CodeBuddy discovery and launch support aliases, quoted paths, and missing CLI', {skip:process.platform==='win32'},async t=>{
  const {root}=await fixture(t)
  const source=await readFile(new URL('../bootstrap/aamp-feishu-task-agent-bootstrap.sh',import.meta.url),'utf8')
  const fn=(start,end)=>source.slice(source.indexOf(`${start}()`),source.indexOf(`\n${end}()`,source.indexOf(`${start}()`)))
  const helpers=[fn('find_codebuddy_cli','find_workbuddy_cli'),fn('validate_agent_name','read_tty_line'),fn('agent_cli_detected','move_agent_menu_cursor_up'),fn('ensure_agent_cli','clear_quarantine_path'),fn('ensure_agent_login','run_acp_bridge'),fn('acp_command_word','validate_codex_acp_command')].join('\n')
  const script=`set -eu\n${helpers}\nPATH="$1"\nAGENT=codebuddy\nagent_fail(){ echo "$*" >&2; exit 64; }\nagent_detail(){ :; }\nresolve_codex_cli_for_acp(){ return 1; }\nfind_cursor_agent_cli(){ return 1; }\nfind_traex_cli(){ return 1; }\nfind_legacy_trae_cli(){ return 1; }\nfind_traecode_cli(){ return 1; }\nfind_workbuddy_cli(){ return 1; }\nfind_workbuddy_ai_cli(){ return 1; }\naime_tenant_available(){ return 1; }\nvalidate_agent_name codebuddy\nensure_agent_cli\nensure_agent_login\ndiscover_interactive_agents\nprintf '%s\\n' "\${DETECTED_AGENTS[*]}"\nbuild_acp_agent_command\neval "$ACP_AGENT_COMMAND"`
  const run=()=>spawnSync('/bin/bash',['-c',script,'bash',root],{encoding:'utf8'})
  assert.equal(run().status,64)
  for(const name of ['cbc','codebuddy']) {
    await writeFile(path.join(root,name),`#!/bin/sh\nprintf '${name}:%s\\n' "$*"\n`);await chmod(path.join(root,name),0o755)
    const result=run();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,`codebuddy\n${name}:--acp\n`)
  }
})


test('Windows extensionless npm entry requires a Node shebang',async t=>{
  const {root,env}=await fixture(t)
  const entry=path.join(root,'entry')
  await writeFile(entry,'#!/bin/sh\necho unsafe\n')
  await writeFile(path.join(root,'codebuddy.cmd'),'@echo off\r\nnode "%~dp0\\entry" %*\r\n')
  assert.equal(await findWindowsAgent('codebuddy',env,noRun),undefined)
  await writeFile(entry,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n')
  const standard=await readFile(new URL('./fixtures/npm-cmd-shim.cmd',import.meta.url),'utf8')
  await writeFile(path.join(root,'codebuddy.cmd'),standard.replaceAll('bin\\cli.js','entry'))
  const launch=await prepareWindowsNativeAgent('codebuddy',env,{run:noRun})
  const result=spawnSync(launch.command,launch.args,{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(result.stdout),['--acp'])
})
