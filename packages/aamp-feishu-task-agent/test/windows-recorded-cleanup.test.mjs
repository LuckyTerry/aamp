import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createWindowsServiceManager} from '../bin/windows-service.mjs'
import {createWindowsProcessJournal} from '../bin/windows-process-journal.mjs'
import {readWindowsProcessIdentity, getCurrentWindowsSid} from '../bin/windows-platform.mjs'

test('native recorded cleanup retires stale state and leaves unregistered Node alive',{skip:process.platform!=='win32',timeout:120000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-recorded-native-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const children=[]
 t.after(async()=>{for(const child of children)if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited}})
 const launch=async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});children.push(child);await once(child,'spawn');return child}
 const controller=await launch(),registered=await launch(),unregistered=await launch()
 const identity=await readWindowsProcessIdentity(controller.pid)
 const descendant=await readWindowsProcessIdentity(registered.pid)
 const journal=await createWindowsProcessJournal(path.join(root,'windows-process-journals-v1'),identity)
 await journal.record([descendant])
 const exited=once(controller,'exit');controller.kill();await exited
 let disabled=false
 const manager=createWindowsServiceManager({runtimeHome:root,controllerPath:'fixture-controller',workerPath:'fixture-worker',currentSid:getCurrentWindowsSid,
 scheduler:async action=>{if(action==='disable')disabled=true;return {loaded:!disabled,enabled:!disabled,state:disabled?'Disabled':'Ready'}},stopGraceMs:0,stopTimeoutMs:90000})
 await fs.mkdir(manager.paths.serviceHome,{recursive:true})
 await fs.writeFile(manager.paths.selectionFile,JSON.stringify({generation:'new',binding_ids:['fixture']}))
 await fs.writeFile(manager.paths.ownerFile,JSON.stringify({generation:'old',controller:identity}))
 assert.equal((await manager.stop()).stopped,true)
 assert.equal(await readWindowsProcessIdentity(registered.pid),undefined)
 assert.ok(await readWindowsProcessIdentity(unregistered.pid))
 assert.equal(await fs.stat(manager.paths.ownerFile).then(()=>true,()=>false),false)
 const audit=JSON.parse(await fs.readFile(path.join(manager.paths.serviceHome,'stale-recovery-result.json')))
 assert.equal(audit.unregisteredProcessesChecked,false)
 assert.equal((await manager.stop()).stopped,true)
})
