import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const worker=await import('../bin/windows-service-worker.mjs').catch(()=>({}));

test('worker publishes a terminal failure if recovery throws before readiness',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-state-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const paths={selectionFile:path.join(root,'selection.json'),stopFile:path.join(root,'stop.json'),stateFile:path.join(root,'worker-state.json')};
 await fs.writeFile(paths.selectionFile,JSON.stringify({generation:'failed-run'}));
 await assert.rejects(worker.runWindowsServiceWorker({version:1,generation:'failed-run',paths},{runOnce:async()=>{throw Object.assign(new Error('query failed'),{code:'EACCES'})}}),/query failed/);
 const state=JSON.parse(await fs.readFile(paths.stateFile,'utf8'));
 assert.equal(state.generation,'failed-run');assert.equal(state.state,'failed');assert.equal(state.errorCode,'EACCES');
});
test('worker refuses a stale configuration before spawning a controller',async t=>{
 assert.equal(typeof worker.runWindowsServiceWorker,'function');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json');await fs.writeFile(selectionFile,JSON.stringify({generation:'new'}));
 await assert.rejects(worker.runWindowsServiceWorker({version:1,generation:'old',paths:{selectionFile}}),/generation|代次/);
});

test('worker respects a stop request before loading platform primitives or spawning',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-stopped-worker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'g1'}));await fs.writeFile(stopFile,JSON.stringify({generation:'g1'}));
 assert.equal(await worker.runWindowsServiceWorker({version:1,generation:'g1',paths:{selectionFile,stopFile}}),0);
});

test('native worker cleans journaled descendants before returning a controller failure', {skip:process.platform!=='win32' && 'requires native Windows process identities',timeout:60000}, async t=>{
 const {pathToFileURL}=await import('node:url');
 const platform=await import('../bin/windows-platform.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-crash-'));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 const childFile=path.join(root,'child.json'),controllerPath=path.join(root,'controller.mjs');
 const {spawn}=await import('node:child_process');
 const retained=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 const retainedIdentity=await platform.readWindowsProcessIdentity(retained.pid);
 t.after(()=>platform.stopOwnedWindowsTree(retainedIdentity,{allowExitedIdentity:true}));
 const journalModule=pathToFileURL(path.resolve(import.meta.dirname,'../bin/windows-process-journal.mjs')).href;
 const platformModule=pathToFileURL(path.resolve(import.meta.dirname,'../bin/windows-platform.mjs')).href;
 t.after(async()=>{const identity=await fs.readFile(childFile,'utf8').then(JSON.parse).catch(()=>undefined);if(identity)await platform.stopOwnedWindowsTree(identity,{allowExitedIdentity:true});await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(selectionFile,JSON.stringify({generation:'crash-test'}));
 await fs.writeFile(controllerPath,`
 import {spawn} from 'node:child_process';
 import fs from 'node:fs/promises';
 import {createWindowsProcessJournal} from ${JSON.stringify(journalModule)};
 import {readWindowsProcessIdentity} from ${JSON.stringify(platformModule)};
 const self=await readWindowsProcessIdentity(process.pid);
 const journal=await createWindowsProcessJournal(${JSON.stringify(path.join(root,'windows-process-journals-v1'))},self);
 // A journaled survivor is independent of this fixture controller's console lifetime.
 const identity=${JSON.stringify(retainedIdentity)};
 await journal.record([identity]);
 await fs.writeFile(${JSON.stringify(childFile)},JSON.stringify({...identity,controllerPid:process.pid}));
 setInterval(()=>{},1000);
 `);
 const pending=worker.runWindowsServiceWorker({version:1,generation:'crash-test',controllerPath,
 env:{AAMP_TASK_RUNTIME_HOME:root},paths:{serviceHome:root,selectionFile,stopFile,logFile:path.join(root,'service.log'),ownerFile:path.join(root,'owner.json')}},{maxRestarts:0});
 const deadline=Date.now()+20000;
 while(!await fs.access(childFile).then(()=>true,()=>false)){if(Date.now()>deadline)throw Error('fixture startup timed out');await new Promise(r=>setTimeout(r,100));}
 const identity=JSON.parse(await fs.readFile(childFile,'utf8'));
 process.kill(identity.controllerPid,'SIGKILL');
 assert.notEqual(await pending,0);
 assert.equal(await platform.readWindowsProcessIdentity(identity.pid),undefined,'orphan descendant must be gone before scheduler observes the worker failure');
});

test('worker retries a failed controller and keeps the same selection',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-retry-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'retry'}));
 const config={version:1,generation:'retry',paths:{selectionFile,stopFile,logFile:path.join(root,'log')}};
 let attempts=0;
 const result=await worker.runWindowsServiceWorker(config,{runOnce:async received=>{assert.equal(received,config);return ++attempts===1?23:0;},wait:async()=>{},restartDelayMs:0});
 assert.equal(result,0);assert.equal(attempts,2);
});

test('worker does not restart after stop is requested during recovery delay',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-retry-stop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'retry'}));
 let attempts=0;
 const result=await worker.runWindowsServiceWorker({version:1,generation:'retry',paths:{selectionFile,stopFile,logFile:path.join(root,'log')}},{runOnce:async()=>{attempts++;return 23;},wait:async()=>fs.writeFile(stopFile,JSON.stringify({generation:'retry'})),restartDelayMs:1});
 assert.equal(result,0);assert.equal(attempts,1);
});

test('worker keeps an explicit retry limit for bounded callers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-retry-limit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'retry'}));
 let attempts=0;
 const code=await worker.runWindowsServiceWorker({version:1,generation:'retry',paths:{selectionFile,stopFile,logFile:path.join(root,'log')}},{runOnce:async()=>{attempts++;return 23;},restartDelayMs:0,maxRestarts:3});
 assert.equal(code,23);assert.equal(attempts,4);
});

test('default recovery survives more than three failures with ten-second delays and ends on success',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-persistent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json'),logFile=path.join(root,'log');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'retry'}));
 let attempts=0,waited=0;
 const code=await worker.runWindowsServiceWorker({version:1,generation:'retry',paths:{selectionFile,stopFile,logFile}},{
   runOnce:async()=>++attempts<=5?23:0,
   wait:async ms=>{waited+=ms},
 });
 assert.equal(code,0);assert.equal(attempts,6);assert.equal(waited,50000);
 const logs=await fs.readFile(logFile,'utf8');
 assert.match(logs,/retry 5 after 10000ms/);
 assert.doesNotMatch(logs,/Infinity/);
});

test('default recovery stops promptly during its ten-second delay',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-worker-default-stop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const selectionFile=path.join(root,'selection.json'),stopFile=path.join(root,'stop.json');
 await fs.writeFile(selectionFile,JSON.stringify({generation:'retry'}));
 let attempts=0,waited=0;
 const code=await worker.runWindowsServiceWorker({version:1,generation:'retry',paths:{selectionFile,stopFile,logFile:path.join(root,'log')}},{
   runOnce:async()=>{attempts++;return 23},
   wait:async ms=>{waited+=ms;await fs.writeFile(stopFile,JSON.stringify({generation:'retry'}))},
 });
 assert.equal(code,0);assert.equal(attempts,1);assert.equal(waited,200);
});
