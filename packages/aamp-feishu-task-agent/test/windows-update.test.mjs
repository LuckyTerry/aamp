import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {taskAgentVersionIsNewer,installPreservingService,runWindowsUpdate} from '../bootstrap/windows-update.mjs';
import {windowsEntryKind,windowsNpmEnvironment,parseWindowsArguments} from '../bootstrap/windows-entry.mjs';
test('Windows aliases survive npm target-path dispatch via distinct long shim',()=>{
  assert.equal(windowsEntryKind('C:\\npm\\feishu-task-agent.cmd',{}),'short');
  assert.equal(windowsEntryKind('C:\\npm\\aamp-feishu-task-agent.cmd',{}),'long');
  assert.equal(parseWindowsArguments([],windowsEntryKind('C:\\package\\bin\\feishu-task-agent.mjs',{AAMP_TASK_ENTRY:'long'})).command,'install');
  assert.equal(parseWindowsArguments(['status'],'long').command,'status');
});
test('npm environment preserves explicit mappings and proxy',()=>{
  const env=windowsNpmEnvironment({NPM_REGISTRY:'public-custom',NPM_CONFIG_CACHE:'upper',npm_config_cache:'lower',NPM_GLOBAL_PREFIX:'prefix',HTTPS_PROXY:'proxy'});
  assert.equal(env.npm_config_registry,'public-custom');assert.equal(env.AAMP_TASK_NPM_CACHE_DIR,'upper');assert.equal(env.npm_config_prefix,'prefix');assert.equal(env.HTTPS_PROXY,'proxy');
  assert.equal(windowsNpmEnvironment({AAMP_TASK_NPM_REGISTRY:'internal',NPM_REGISTRY:'external'}).npm_config_registry,'internal');
  assert.equal(windowsNpmEnvironment({}).npm_config_registry,'https://registry.npmjs.org/');
});
test('version ordering matches stable and dev bootstrap rules',()=>{
  for(const [a,b,want] of [['1.0.0','1.0.1',true],['1.0.1','1.0.0',false],['1.0.1','1.0.1',false],['1.0.0-dev.9','1.0.0',true],['1.0.0','1.0.0-dev.10',false],['custom','next',false]])assert.equal(taskAgentVersionIsNewer(a,b),want);
});
for(const running of [false,true])for(const fails of [false,true])test(`update restores only background selection running=${running} failure=${fails}`,async()=>{
 const calls=[];
 const operation=installPreservingService({stage:async()=>{calls.push('stage');return 'archive'},snapshot:async()=>({running,bindingIds:['chosen'],controllerPath:'old'}),stop:async()=>calls.push('stop'),install:async()=>{calls.push('install');if(fails)throw Error('install failed')},resume:async(p,success)=>{assert.deepEqual(p.bindingIds,['chosen']);assert.equal(success,!fails);calls.push('resume')}});
 if(fails)await assert.rejects(operation,/install failed/);else await operation;
 assert.deepEqual(calls,running?['stage','stop','install','resume']:['stage','install']);
});
test('staging failure never stops service',async()=>{
 await assert.rejects(installPreservingService({stage:async()=>{throw Error('stage')},stop:()=>assert.fail()}),/stage/);
});
test('auto policy probes, caches, and reruns exact args once without network',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'aamp-update-test-'));
 try{
  for(const latest of ['1.0.0','0.9.0','1.0.1','fetch-fail','install-fail']) {
   const calls=[];const argv=['start','--agent','agent with spaces','--foreground'];
   const context={argv,command:'start',metadata:{name:'@test/agent',version:'1.0.0'},env:{AAMP_TASK_UPDATE_CACHE_FILE:path.join(temp,latest)},runChild:async(cmd,args,env)=>{assert.deepEqual(args.slice(1),argv);assert.equal(env.AAMP_TASK_AUTO_UPDATE_DONE,'true');calls.push('rerun');return 7}};
   const injected={capture:async args=>{calls.push(args[0]);if(latest==='fetch-fail')throw Error('fetch');return args[0]==='root'?temp:latest==='install-fail'?'1.0.1':latest},install:async()=>{calls.push('install');if(latest==='install-fail')throw Error('install')}};
   const result=await runWindowsUpdate(context,injected);
   assert.equal(result.handled,latest==='1.0.1');
   assert.equal(calls.includes('rerun'),latest==='1.0.1');
   if(latest==='1.0.1')assert.equal(result.code,7);
   const prior=calls.length;
   await runWindowsUpdate({...context,env:{...context.env,AAMP_TASK_AUTO_UPDATE_DONE:'true'}},injected);assert.equal(calls.length,prior);
   await runWindowsUpdate({...context,command:'update',env:{...context.env,AAMP_TASK_AUTO_UPDATE:'false'}},injected);assert.equal(calls.length,prior);
   if(latest==='1.0.0'){await runWindowsUpdate(context,injected);assert.equal(calls.length,prior);}
  }
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('update reports restoration failure instead of claiming recovery',async()=>{
 await assert.rejects(installPreservingService({stage:async()=>'',snapshot:async()=>({running:true,bindingIds:['selected']}),stop:async()=>{},install:async()=>{throw Error('install failed')},resume:async()=>{throw Error('old controller missing')}}),/更新失败.*后台恢复失败/);
});
test('service workers never probe for updates',async()=>{
 for(const extra of [{command:'__service-run'},{command:'start',env:{AAMP_TASK_NON_INTERACTIVE:'true'}}]) {
  const result=await runWindowsUpdate({command:'start',metadata:{version:'1.0.0'},env:{},...extra},{capture:()=>assert.fail('worker must not probe')});
  assert.equal(result.handled,false);
 }
});
test('npm long alias has a distinct wrapper in both manifests',async()=>{
 const {readFile}=await import('node:fs/promises');
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(manifest.bin['aamp-feishu-task-agent'],'bin/aamp-feishu-task-agent.mjs');
 assert.equal(lock.packages[''].bin['aamp-feishu-task-agent'],manifest.bin['aamp-feishu-task-agent']);
 assert.match(await readFile(new URL('../bin/aamp-feishu-task-agent.mjs',import.meta.url),'utf8'),/AAMP_TASK_ENTRY='long'/);
});

test('SemVer prereleases cannot downgrade a newer core version',()=>{
  for(const [current,latest,newer] of [
    ['2.0.0-rc.1','1.0.0',false],['2.0.0-beta.1','1.9.9',false],
    ['1.0.0-beta.2','1.0.0-rc.1',true],['1.0.0-rc.9','1.0.0-rc.10',true],
    ['1.0.0-rc.1','1.0.0',true],['1.0.0','1.0.0-rc.1',false],
    ['1.0.0-dev.2','1.0.0-dev.10',true],['1.0.0-1','1.0.0-beta',true],
    ['1.0.0-beta','1.0.0-beta.1',true],['1.0.0+one','1.0.0+two',false],
    ['garbage','1.0.0',false],['1.0.0','garbage',false],
    ['1.0.0-rc.01','1.0.0',false],['01.0.0','2.0.0',false],
  ])assert.equal(taskAgentVersionIsNewer(current,latest),newer,`${current} -> ${latest}`);
});
test('auto update does not install an older stable channel over newer rc',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'aamp-rc-update-'));
 try {
  const result=await runWindowsUpdate({argv:['start'],command:'start',metadata:{name:'@test/agent',version:'2.0.0-rc.1'},env:{AAMP_TASK_UPDATE_CACHE_FILE:path.join(temp,'cache')},runChild:()=>assert.fail('must not rerun')},{capture:async args=>{assert.equal(args[0],'view');return '1.0.0'},install:()=>assert.fail('must not downgrade')});
  assert.equal(result.handled,false);
 }finally{await rm(temp,{recursive:true,force:true});}
});
