#!/usr/bin/env node
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {recoverWindowsProcessJournals} from './windows-process-journal.mjs';
import {appendLifecycleDiagnostic} from './windows-lifecycle-diagnostics.mjs';
import {randomUUID} from 'node:crypto';
function diagnostic(config,fields) {
  if(config.paths?.logFile) appendLifecycleDiagnostic(path.join(path.dirname(config.paths.logFile),'worker-diagnostic.jsonl'),{generation:config.generation,...fields});
}

async function runWindowsServiceWorkerOnce(config) {
  const selected=JSON.parse(await fs.readFile(config.paths.selectionFile,'utf8'));
  if(config.version!==1 || !config.generation || selected.generation!==config.generation) throw new Error('Windows service generation changed');
  const stopRequested=async()=>{try{return JSON.parse(await fs.readFile(config.paths.stopFile,'utf8')).generation===config.generation;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
  if(await stopRequested()) return 0;
  const {readWindowsProcessIdentity,ensurePrivateWindowsDirectory,stopOwnedWindowsTree,atomicReplaceWindows}=await import('./windows-platform.mjs');
  await ensurePrivateWindowsDirectory(config.paths.serviceHome);
  const log=await fs.open(config.paths.logFile,'a',0o600);
  let child,controllerIdentity;
  try {
    const self=await readWindowsProcessIdentity(process.pid);
    if(!self) throw new Error('Cannot identify Windows service worker');
    if(await stopRequested()) return 0;
    child=spawn(process.execPath,[config.controllerPath,'__service-run'],{
      env:{...process.env,...config.env,AAMP_TASK_NON_INTERACTIVE:'true',AAMP_WINDOWS_SERVICE_GENERATION:config.generation,AAMP_WINDOWS_SERVICE_STOP_FILE:config.paths.stopFile},
      stdio:['ignore',log.fd,log.fd],shell:false,windowsHide:true,
    });
    diagnostic(config,{event:'controller.spawned',childPid:child.pid});
    const closed=new Promise((resolve,reject)=>{child.once('error',error=>{diagnostic(config,{event:'controller.spawn.error',errorCode:error.code});reject(error)});child.once('close',(code,signal)=>{diagnostic(config,{event:'controller.closed',childPid:child.pid,code,signal});resolve(code ?? 1)});});
    // Attach rejection handling before awaiting CIM so immediate spawn failure cannot escape.
    closed.catch(()=>{});
    controllerIdentity=child.pid ? await readWindowsProcessIdentity(child.pid) : undefined;
    const finishController=async()=>{
      const code=await closed;
      const stop=await fs.readFile(config.paths.stopFile,'utf8').then(JSON.parse).catch(()=>undefined);
      if(stop?.generation===config.generation) return 0;
      // A failed controller can leave a Bridge alive. Clean verified journal entries
      // before returning failure so Task Scheduler can finish and restart the task.
      const runtimeHome=config.env?.AAMP_TASK_RUNTIME_HOME || path.dirname(config.paths.serviceHome);
      diagnostic(config,{event:'recovery.started'});
      await recoverWindowsProcessJournals(path.join(runtimeHome,'windows-process-journals-v1'));
      diagnostic(config,{event:'recovery.finished'});
      return code;
    };
    if(!controllerIdentity) {return await finishController();}
    const temporary=`${config.paths.ownerFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary,JSON.stringify({generation:config.generation,worker:self,controller:controllerIdentity})+'\n',{mode:0o600});
    await atomicReplaceWindows(temporary,config.paths.ownerFile);
    return await finishController();
  } catch(error) {
    if(controllerIdentity) await stopOwnedWindowsTree(controllerIdentity).catch(()=>{});
    throw error;
  } finally {await log.close();}
}
// Task Scheduler can report a nonzero action result without restarting an
// on-demand interactive task. Keep controller recovery inside the owned worker.
export async function runWindowsServiceWorker(config, {
  runOnce=runWindowsServiceWorkerOnce,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  maxRestarts=Infinity,
  restartDelayMs=10000,
}={}) {
  const publish = async (state, fields={}) => {
    if (!config.paths.stateFile) return; // Compatibility with existing worker configs.
    const temporary=`${config.paths.stateFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary,JSON.stringify({version:1,generation:config.generation,pid:process.pid,state,...fields})+'\n',{mode:0o600,flag:'wx'});
      if(process.platform==='win32') await (await import('./windows-platform.mjs')).atomicReplaceWindows(temporary,config.paths.stateFile);
      else await fs.rename(temporary,config.paths.stateFile);
    } finally {await fs.rm(temporary,{force:true});}
  };
  try {
  const cancelled=async()=>{
    const selected=JSON.parse(await fs.readFile(config.paths.selectionFile,'utf8'));
    if(selected.generation!==config.generation) throw new Error('Windows service generation changed');
    const stop=await fs.readFile(config.paths.stopFile,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    return stop?.generation===config.generation;
  };
  for(let attempt=0;;attempt++) {
    if(await cancelled()) {await publish('stopped');return 0;}
    await publish('starting',{attempt:attempt+1});
    diagnostic(config,{event:'controller.attempt',attempt});
    const code=await runOnce(config);
    if(code===0 || attempt>=maxRestarts) {await publish(code===0?'stopped':'failed',{code});return code;}
    await publish('retrying',{code,attempt:attempt+2});
    diagnostic(config,{event:'controller.retry',code,attempt:attempt+1});
    const retryLimit=Number.isFinite(maxRestarts)?`/${maxRestarts}`:'';
    await fs.appendFile(config.paths.logFile,`[windows-service] controller exited ${code}; retry ${attempt+1}${retryLimit} after ${restartDelayMs}ms\n`);
    for(let elapsed=0;elapsed<restartDelayMs;) {
      if(await cancelled()) {await publish('stopped');return 0;}
      const duration=Math.min(200,restartDelayMs-elapsed);
      await wait(duration);elapsed+=duration;
    }
  }
  } catch(error) {
    const errorCode=/^[A-Za-z0-9_-]{1,80}$/.test(String(error.code||error.name)) ? String(error.code||error.name) : 'WORKER_FAILED';
    const reason=/process.*(identity|executable)|QueryFullProcessImageName|GetProcessTimes|OpenProcess/i.test(error.message||'') ? 'Windows 进程身份查询失败' : '后台进程启动或恢复失败';
    await publish('failed',{errorCode,reason}).catch(()=>{});
    throw error;
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let config;
  try {
    config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
    diagnostic(config,{event:'worker.started'});
    process.once('exit',code=>diagnostic(config,{event:'worker.exit',code}));
    process.on('uncaughtExceptionMonitor',error=>diagnostic(config,{event:'worker.uncaught',errorCode:error.code || error.name}));
    process.exitCode=await runWindowsServiceWorker(config);
  } catch(error) {if(config)diagnostic(config,{event:'worker.failed',errorCode:error.code || error.name});console.error(error.message);process.exitCode=1;}
}
