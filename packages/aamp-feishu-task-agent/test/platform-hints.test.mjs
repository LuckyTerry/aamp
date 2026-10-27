import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {taskCommand, displayAction, logCommand, existingRuntimeHint, globalInstallHint, powershellQuote} from '../bin/platform-hints.mjs'

test('Windows commands are complete while POSIX commands retain their spelling',()=>{
 for(const action of ['install','start','stop','restart','status','logs','add','remove']) {
  assert.equal(taskCommand(action,'win32'),`feishu-task-agent.cmd ${action}`)
  assert.equal(taskCommand(action,'darwin'),`feishu-task-agent ${action}`)
  assert.equal(displayAction(action,'darwin'),action)
  assert.equal(displayAction(action,'win32'),taskCommand(action,'win32'))
 }
 assert.match(globalInstallHint({platform:'win32',version:'1.2.3-dev.4'}),/^npm.cmd install --global @larktask\/aamp-feishu-task-agent@1.2.3-dev.4 --registry=https:\/\/registry.npmjs.org\/$/)
})
test('Windows log commands quote Node, packaged entry and every argument literally',()=>{
 const command=logCommand(['collect','--run-dir',"C:\\Users\\O'Brien $test\\日志"],{
  platform:'win32',execPath:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\AAMP files\\bin\\aamp-logs.mjs',override:''})
 assert.equal(command,"& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\AAMP files\\bin\\aamp-logs.mjs' 'collect' '--run-dir' 'C:\\Users\\O''Brien $test\\日志'")
 assert.equal(logCommand(['collect','--latest'],{platform:'win32',override:"D:\\Tools O'Brien\\logs.cmd"}),"& 'D:\\Tools O''Brien\\logs.cmd' 'collect' '--latest'")
 assert.equal(powershellQuote('$(not-executed)'),"'$(not-executed)'")
})
test('POSIX log and existing-runtime hints remain identical',()=>{
 assert.equal(logCommand(['collect','--run-dir','/tmp/run'],{platform:'darwin',home:'/Users/test',override:''}),'/Users/test/.aamp/bin/aamp-logs collect --run-dir /tmp/run')
 assert.equal(existingRuntimeHint('install','darwin'),'检测到已有 feishu-task-agent 正在运行。请先执行 feishu-task-agent status 查看状态；如需重启，执行 feishu-task-agent stop 后再运行 feishu-task-agent install')
 assert.match(existingRuntimeHint('install','win32'),/feishu-task-agent.cmd restart.*feishu-task-agent.cmd stop.*feishu-task-agent.cmd install/)
})
test('Windows entry and log help display Windows commands without launching services',()=>{
 const entry=new URL('../bootstrap/windows-entry.mjs',import.meta.url).href
 const help=execFileSync(process.execPath,['--input-type=module','-e',`const {runWindowsEntry}=await import(${JSON.stringify(entry)});await runWindowsEntry(['--help']);`],{encoding:'utf8'})
 assert.match(help,/feishu-task-agent\.cmd <install/)
 const log=fileURLToPath(new URL('../bin/aamp-logs.mjs',import.meta.url))
 const output=execFileSync(process.execPath,['--input-type=module','-e',`Object.defineProperty(process,'platform',{value:'win32'});process.argv=['node',${JSON.stringify(log)},'--help'];await import(${JSON.stringify(new URL('../bin/aamp-logs.mjs',import.meta.url).href)});`],{encoding:'utf8'})
 assert.match(output,/aamp-logs\.cmd collect/)
 assert.doesNotMatch(output,/~\/\.aamp/)
})

test('no-binding and status guidance uses Windows commands without changing results',()=>{
 const url=new URL('../bin/feishu-task-agent-controller.mjs',import.meta.url).href
 // Stub platform only for formatting; injected operations avoid Windows system calls.
 const script=`Object.defineProperty(process,'platform',{value:'win32'});
 const c=await import(${JSON.stringify(url)});
 await c.runServiceLifecycleCommand('status',{getStatus:async()=>({mode:'background',state:'starting'})});
 await c.runStart({loadBindings:async()=>[],background:true});`
 const {status,stdout,stderr}=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,AAMP_TASK_INSTALL_COMMAND:''}})
 assert.equal(status,1)
 assert.match(stdout,/feishu-task-agent\.cmd logs/)
 assert.match(stderr,/feishu-task-agent\.cmd install/)
 assert.doesNotMatch(stderr,/npx/)
})
