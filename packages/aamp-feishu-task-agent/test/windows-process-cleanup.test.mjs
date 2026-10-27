import assert from 'node:assert/strict'
import {test} from 'node:test'
import {cleanupWindowsProcesses} from '../bin/windows-process-cleanup.mjs'
const identity={pid:42,startedAt:'2026-01-01',executablePath:'C:/node.exe',ownerSid:'S-1-5-21-1'}
test('cleanup has one deadline and aborts the underlying operation',async()=>{
 let aborted=false;const start=Date.now()
 const result=await cleanupWindowsProcesses([{windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map([[42,identity]])}],{
 timeoutMs:25,stopTree:async(i,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true})),
 })
 assert.equal(result.ok,false);assert.equal(aborted,true);assert.ok(Date.now()-start<500)
})
test('cleanup deduplicates identities and reports failures rather than success',async()=>{
 let calls=0
 const record={windowsIdentity:Promise.resolve(identity),windowsDescendants:new Map([[42,identity]])}
 const result=await cleanupWindowsProcesses([record,record],{stopTree:async()=>{calls++;throw Error('identity changed')}})
 assert.equal(calls,1);assert.equal(result.ok,false);assert.match(result.errors[0],/identity changed/)
})
