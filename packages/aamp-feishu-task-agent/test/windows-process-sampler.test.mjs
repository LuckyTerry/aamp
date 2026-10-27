import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createWindowsProcessSampler} from '../bin/windows-process-sampler.mjs'
const identity={pid:42,startedAt:'2026-01-01T00:00:00.000Z',executablePath:'C:/node.exe',ownerSid:'S-1-5-21-1'}
test('periodic failure preserves roots and recovers without terminating work',async()=>{
 let fail=true, calls=0; const events=[],saved=[]
 const sampler=createWindowsProcessSampler({snapshot:async()=>{calls++;if(fail)throw Error('query timed out');return new Map([[42,[identity]]])},persist:async items=>saved.push([...items]),onState:s=>events.push(s),intervalMs:100000})
 const record={windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map()}
 await sampler.register(record)
 await sampler.sample()
 assert.equal(events.at(-1).state,'degraded');assert.equal(record.windowsDescendants.size,1)
 fail=false;await sampler.sample();assert.equal(events.at(-1).state,'healthy');assert.equal(calls,2)
 await sampler.stop();assert.equal(sampler.pending,false)
})
test('sampling coalesces concurrent requests and stop cancels the active query',async()=>{
 let calls=0,aborted=false
 const sampler=createWindowsProcessSampler({snapshot:async(roots,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}))},persist:async()=>{},intervalMs:100000})
 await sampler.register({windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map()})
 const first=sampler.sample();const second=sampler.sample();await new Promise(r=>setImmediate(r))
 await sampler.stop();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(aborted,true);assert.equal(sampler.pending,false)
})
test('initial identity persistence failures reject registration',async()=>{
 const sampler=createWindowsProcessSampler({snapshot:async()=>new Map(),persist:async()=>{throw Error('disk unavailable')},intervalMs:100000})
 await assert.rejects(sampler.register({windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map()}),/disk unavailable/)
 await sampler.stop()
})

test('failed persistence is retried even after its root exits',async()=>{
 let fail=false;const saved=[];const child={...identity,pid:43}
 const record={windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map()}
 const sampler=createWindowsProcessSampler({snapshot:async()=>new Map([[42,[identity,child]]]),persist:async items=>{if(fail)throw Error('disk failure');saved.push([...items])},intervalMs:100000})
 await sampler.register(record);fail=true;await sampler.sample();record.exited=true
 fail=false;await sampler.sample();await sampler.stop()
 assert.ok(saved.at(-1).some(i=>i.pid===43))
})

test('two local task processes return results while tracking is degraded',async t=>{
 const {spawn}=await import('node:child_process')
 const children=[1,2].map(()=>spawn(process.execPath,['-e',"process.on('message',m=>process.send({result:m.a*m.b}))"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}))
 const sampler=createWindowsProcessSampler({snapshot:async()=>{throw Error('injected CIM timeout')},persist:async()=>{},intervalMs:100000})
 t.after(async()=>{await sampler.stop();for(const child of children){child.disconnect();child.kill()}})
 for(const child of children)await sampler.register({windowsIdentity:Promise.resolve({...identity,pid:child.pid}),windowsDescendants:new Map()})
 await sampler.sample()
 const results=await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('task reply interrupted')),3000)
   child.once('message',value=>{clearTimeout(timeout);resolve(value.result)})
   child.send({a:47,b:19})
 })))
 assert.deepEqual(results,[893,893])
})
