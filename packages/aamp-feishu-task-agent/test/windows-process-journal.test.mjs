import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stopOwnedWindowsTree } from '../bin/windows-platform.mjs'

import {
  createWindowsProcessJournal,
  confirmWindowsProcessRecovery,
  recoverWindowsProcessJournals,
  requestWindowsControllerStop,
} from '../bin/windows-process-journal.mjs'

const controller = { pid: 100, startedAt: '2026-09-07T01:00:00.000Z', command: 'node controller', executablePath: 'C:\\node.exe', ownerSid: 'S-1-5-21-1' }
const child = { ...controller, pid: 101, startedAt: '2026-09-07T01:00:01.000Z' }

test('journal atomically persists controller and verified descendant identities', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-'))
  try {
    const journal = await createWindowsProcessJournal(root, controller, {
      ensurePrivateDirectory: async (directory) => fsp.mkdir(directory, { recursive: true }),
      atomicReplace: fsp.rename,
    })
    await journal.record([controller, child])
    const value = JSON.parse(await fsp.readFile(journal.file, 'utf8'))
    assert.deepEqual(value, { version: 1, controller, descendants: [child] })
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})

test('recovery cleans exact descendants only after the recorded controller is gone', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-recover-'))
  const journal = await createWindowsProcessJournal(root, controller, {
    ensurePrivateDirectory: async (directory) => fsp.mkdir(directory, { recursive: true }), atomicReplace: fsp.rename,
  })
  await journal.record([child])
  const killed = []
  await recoverWindowsProcessJournals(root, {
    readIdentity: async () => undefined,
    stopTree: async (identity) => killed.push(identity.pid),
  })
  assert.deepEqual(killed, [101])
  assert.equal(await fsp.stat(journal.file).then(() => true, () => false), false)
  await fsp.rm(root, { recursive: true, force: true })
})

test('recovery preserves journal and surfaces descendant cleanup failure', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-fail-'))
  const journal = await createWindowsProcessJournal(root, controller, {
    ensurePrivateDirectory: async (directory) => fsp.mkdir(directory, { recursive: true }), atomicReplace: fsp.rename,
  })
  await journal.record([child])
  await assert.rejects(recoverWindowsProcessJournals(root, {
    readIdentity: async () => undefined,
    stopTree: async () => { throw new Error('identity unavailable') },
  }), /identity unavailable/)
  assert.equal((await fsp.stat(journal.file)).isFile(), true)
  await fsp.rm(root, { recursive: true, force: true })
})

test('identity-specific stop request is written only for an exact live controller', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-stop-'))
  const journal = await createWindowsProcessJournal(root, controller, {
    ensurePrivateDirectory: async (directory) => fsp.mkdir(directory, { recursive: true }), atomicReplace: fsp.rename,
  })
  assert.equal(await requestWindowsControllerStop(root, controller.pid, {
    readIdentity: async () => controller,
    atomicReplace: fsp.rename,
  }), true)
  assert.deepEqual(JSON.parse(await fsp.readFile(journal.stopFile, 'utf8')), {
    pid: controller.pid, startedAt: controller.startedAt,
  })
  await assert.rejects(requestWindowsControllerStop(root, controller.pid, {
    readIdentity: async () => ({ ...controller, startedAt: '2026-09-07T02:00:00.000Z' }), atomicReplace: fsp.rename,
  }), /identity changed/)
  await fsp.rm(root, { recursive: true, force: true })
})

for (const [name, live, error] of [
  ['newer PID generation', { ...child, startedAt: '2026-09-07T02:00:00.000Z', ownerSid: 'S-1-5-21-other' }, undefined],
  ['same creation time changed owner', { ...child, ownerSid: 'S-1-5-21-other' }, /identity changed/],
  ['same creation time changed executable', { ...child, executablePath: 'C:/other.exe' }, /identity changed/],
  ['older creation time', { ...child, startedAt: controller.startedAt }, /identity changed/],
  ['invalid creation time', { ...child, startedAt: 'invalid' }, /identity changed/],
  ['different PID', { ...child, pid: 999, startedAt: '2026-09-07T02:00:00.000Z' }, /identity changed/],
  ['identity query failure', new Error('CIM access denied'), /CIM access denied/],
]) {
  test(`journal recovery handles ${name} without killing an unverified process`, async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-generation-'))
    t.after(() => fsp.rm(root, { recursive: true, force: true }))
    const journal = await createWindowsProcessJournal(root, controller, {
      ensurePrivateDirectory: async () => {}, atomicReplace: fsp.rename,
    })
    await journal.record([child])
    let kills = 0
    const recovery = recoverWindowsProcessJournals(root, {
      readIdentity: async () => undefined,
      stopTree: (identity, options) => stopOwnedWindowsTree(identity, {
        ...options, platform: 'win32', getCurrentSid: async () => child.ownerSid,
        readIdentity: async () => { if (live instanceof Error) throw live; return live },
        runTaskkill: async () => { kills++ },
      }),
    })
    if (error) await assert.rejects(recovery, error)
    else await recovery
    assert.equal(kills, 0)
    assert.equal(await fsp.stat(journal.file).then(() => true, () => false), Boolean(error))
  })
}

for (const state of ['reused', 'live', 'inaccessible']) {
  test(`controller recovery ${state} preserves process ownership boundaries`, async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-controller-recovery-'))
    t.after(() => fsp.rm(root, {recursive:true,force:true}))
    const journal = await createWindowsProcessJournal(root, controller, {
      ensurePrivateDirectory: async () => {}, atomicReplace: fsp.rename,
    })
    await journal.record([child])
    const stopped = []
    const recovery = recoverWindowsProcessJournals(root, {
      readIdentity: async (pid, options) => {
        assert.equal(pid, controller.pid)
        // A later generation can be excluded before its inaccessible owner is read.
        if (state === 'reused' && options?.exitedBefore === controller.startedAt) return undefined
        if (state === 'live') return controller
        throw new Error('controller owner access denied')
      },
      stopTree: async (identity, options) => {
        assert.deepEqual(options, {allowExitedIdentity:true})
        stopped.push(identity)
      },
    })
    if (state === 'inaccessible') await assert.rejects(recovery, /controller owner access denied/)
    else await recovery
    assert.deepEqual(stopped, state === 'reused' ? [child] : [])
    assert.equal(await fsp.stat(journal.file).then(() => true, () => false), state !== 'reused')
  })
}

test('journal skips unchanged identities and recovers after a failed write', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-journal-retry-'))
  t.after(() => fsp.rm(root, {recursive:true,force:true}))
  let writes=0,fail=false
  const journal=await createWindowsProcessJournal(root,controller,{
    ensurePrivateDirectory:async()=>{},atomicReplace:async(a,b)=>{writes++;if(fail)throw Error('temporary write failure');await fsp.rename(a,b)},
  })
  await journal.record([child]);const baseline=writes
  await journal.record([child]);assert.equal(writes,baseline)
  fail=true;await assert.rejects(journal.record([{...child,pid:102}]),/temporary write failure/)
  fail=false;await journal.record([{...child,pid:102}])
  const value=JSON.parse(await fsp.readFile(journal.file,'utf8'))
  assert.equal(value.descendants.length,2)
})

async function recoveryFixture(t) {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'aamp-recovery-receipt-'))
  t.after(()=>fsp.rm(root,{recursive:true,force:true}))
  const journal=await createWindowsProcessJournal(root,controller,{ensurePrivateDirectory:async()=>{},atomicReplace:fsp.rename})
  await journal.record([child])
  const options={readIdentity:async()=>undefined,stopTree:async()=>{},atomicReplace:fsp.rename}
  return {root,journal,options}
}

test('recovery receipt survives until acknowledgement is persisted',async t=>{
  const {root,options}=await recoveryFixture(t)
  await recoverWindowsProcessJournals(root,options)
  await assert.rejects(confirmWindowsProcessRecovery(root,controller,async()=>{throw new Error('disk failure')}),/disk failure/)
  let acknowledgements=0
  assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{acknowledgements++}),true)
  assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{acknowledgements++}),false)
  assert.equal(acknowledgements,1)
})

for(const [field,value] of [['pid',999],['startedAt','2026-09-08T01:00:00.000Z'],['executablePath','C:\\other.exe'],['ownerSid','S-other']]) {
 test(`recovery receipt rejects a different controller ${field}`,async t=>{
  const {root,options}=await recoveryFixture(t)
  await recoverWindowsProcessJournals(root,options)
  assert.equal(await confirmWindowsProcessRecovery(root,{...controller,[field]:value},async()=>assert.fail('must not acknowledge')),false)
  assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{}),true)
 })
}

test('failed receipt write preserves pending journal and refuses confirmation',async t=>{
 const {root,journal,options}=await recoveryFixture(t)
 await assert.rejects(recoverWindowsProcessJournals(root,{...options,atomicReplace:async()=>{throw new Error('disk failure')}}),/disk failure/)
 assert.equal((await fsp.stat(journal.file)).isFile(),true)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>assert.fail('must not acknowledge')),false)
 await recoverWindowsProcessJournals(root,options)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{}),true)
})

test('interruption after receipt commit leaves journal pending until recovery finishes',async t=>{
 const {root,journal,options}=await recoveryFixture(t)
 const abort=new AbortController()
 await assert.rejects(recoverWindowsProcessJournals(root,{...options,signal:abort.signal,atomicReplace:async(a,b)=>{
  await fsp.rename(a,b);abort.abort(new Error('interrupted'))
 }}),/interrupted/)
 assert.equal((await fsp.stat(journal.file)).isFile(),true)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>assert.fail('pending journal')),false)
 await recoverWindowsProcessJournals(root,options)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{}),true)
})

test('concurrent recovery callers clean once and retain a consumable receipt',async t=>{
 const {root,options}=await recoveryFixture(t)
 let kills=0
 const recover=()=>recoverWindowsProcessJournals(root,{...options,stopTree:async()=>{
  kills++;await new Promise(resolve=>setTimeout(resolve,30))
 }})
 const results=await Promise.all([recover(),recover()])
 assert.equal(results.reduce((a,b)=>a+b,0),1)
 assert.equal(kills,1)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{}),true)
})

test('live controller and failed child cleanup never produce usable success evidence',async t=>{
 const {root,options}=await recoveryFixture(t)
 assert.equal(await recoverWindowsProcessJournals(root,{...options,readIdentity:async()=>controller,stopTree:async()=>assert.fail('live controller')}),0)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>assert.fail('live')),false)
 await assert.rejects(recoverWindowsProcessJournals(root,{...options,stopTree:async()=>{throw new Error('CIM denied')}}),/CIM denied/)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>assert.fail('failed cleanup')),false)
})

test('interruption after service acknowledgement keeps evidence available for retry',async t=>{
 const {root,options}=await recoveryFixture(t)
 await recoverWindowsProcessJournals(root,options)
 const abort=new AbortController()
 await assert.rejects(confirmWindowsProcessRecovery(root,controller,async()=>{
  abort.abort(new Error('acknowledgement committed then interrupted'))
 },{signal:abort.signal}),/interrupted/)
 assert.equal(await confirmWindowsProcessRecovery(root,controller,async()=>{}),true)
})

test('native recovery cleans an orphaned fixture child after controller exit', {skip:process.platform!=='win32'}, async t=>{
 const {spawn}=await import('node:child_process')
 const {readWindowsProcessIdentity,stopOwnedWindowsTree}=await import('../bin/windows-platform.mjs')
 assert.ok(await readWindowsProcessIdentity(process.pid))
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'aamp-native-recovery-'))
 const fixture=spawn(process.execPath,['-e',`
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});
  child.unref();
  process.on('message',message=>{if(message==='stop'){child.kill();process.exit(0)}});
  process.send({pid:child.pid});setInterval(()=>{},1000);
 `],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true})
 let owner,descendant
 t.after(async()=>{
  for(const identity of [descendant,owner]) if(identity) await stopOwnedWindowsTree(identity,{allowExitedIdentity:true})
  // The fixture is our own ChildProcess handle, not an arbitrary PID.
  if(fixture.exitCode===null && fixture.connected) {
   const exited=new Promise(resolve=>fixture.once('exit',resolve));fixture.send('stop');await exited
  }
  await fsp.rm(root,{recursive:true,force:true})
 })
 const childPid=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('fixture did not report child')),10000)
  fixture.once('message',message=>{clearTimeout(timer);resolve(message.pid)})
  fixture.once('error',error=>{clearTimeout(timer);reject(error)})
 })
 owner=await readWindowsProcessIdentity(fixture.pid)
 descendant=await readWindowsProcessIdentity(childPid)
 assert.ok(owner);assert.ok(descendant)
 const journal=await createWindowsProcessJournal(root,owner)
 await journal.record([descendant])
 const exited=new Promise(resolve=>fixture.once('exit',resolve))
 fixture.kill();await exited
 assert.equal(await readWindowsProcessIdentity(owner.pid),undefined)
 assert.ok(await readWindowsProcessIdentity(descendant.pid))
 assert.equal(await recoverWindowsProcessJournals(root),1)
 assert.equal(await readWindowsProcessIdentity(descendant.pid),undefined)
 let committed=false
 assert.equal(await confirmWindowsProcessRecovery(root,owner,async()=>{committed=true}),true)
 assert.equal(committed,true)
 assert.equal(await recoverWindowsProcessJournals(root),0)
})
