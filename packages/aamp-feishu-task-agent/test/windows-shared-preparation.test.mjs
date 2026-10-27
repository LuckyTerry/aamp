import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as controller from '../bin/feishu-task-agent-controller.mjs'

const old={binding_id:'old'},added={binding_id:'new'}
test('Windows install saves without foreground launches then uses the prepared background start path',async()=>{
 const calls=[]
 await controller.runInstall({platform:'win32',background:true,
   withMutationLock:async(_,fn)=>fn(),
   runBindingSession:async(mode,options)=>{
     assert.equal(mode,'install');assert.equal(options.deferLaunch,true);calls.push('save')
     return {acceptedBindings:[added],cancelled:[],selectionFailures:[],selectedCount:1}
   },
   startBindings:async(bindings,groups,options)=>{
     assert.deepEqual(bindings,[added]);assert.equal(groups,undefined);assert.equal(options.background,true);calls.push('prepared-start')
   },
 })
 assert.deepEqual(calls,['save','prepared-start'])
})

test('Windows install startup failure reports saved bindings for a later start',async()=>{
 await assert.rejects(controller.runInstall({platform:'win32',background:true,
   withMutationLock:async(_,fn)=>fn(),
   runBindingSession:async()=>({acceptedBindings:[added],cancelled:[],selectionFailures:[],selectedCount:1}),
   startBindings:async()=>{throw new Error('fixture readiness failed')},
 }),/配置已保存.*start.*fixture readiness failed/)
})

test('Windows install with only cancelled selections never starts a service',async t=>{
 t.mock.method(console,'log',()=>{})
 await controller.runInstall({platform:'win32',background:true,
   withMutationLock:async(_,fn)=>fn(),
   runBindingSession:async()=>({acceptedBindings:[],cancelled:[{binding:added,reason:'cancel'}],selectionFailures:[],selectedCount:1}),
   startBindings:()=>assert.fail('no accepted bindings'),
 })
})

function activation(overrides={}) {
 return {platform:'win32',withControlLock:async fn=>fn(),
   getRuntimeStatus:async()=>({mode:'background',pid:123,pids:[]}),
   loadBindings:async()=>[old,added],readSelection:async()=>['old'],
   ...overrides}
}
test('Windows add prepares new bindings before restarting the merged selection',async()=>{
 const calls=[]
 await controller.activateAddedBindings([added],activation({
   prepareBackground:async bindings=>{assert.deepEqual(bindings,[added]);calls.push('prepare');return {prepared:bindings,failed:[],cancelled:[]}},
   startService:async ids=>{assert.deepEqual(ids,['old','new']);calls.push('activate');return {pid:124}},
 }))
 assert.deepEqual(calls,['prepare','activate'])
})
test('add preparation failure or cancellation restores replacement config without touching the old service',async()=>{
 for(const kind of ['failed','cancelled']) {
   let restored=0
   await assert.rejects(controller.activateAddedBindings([added],activation({
     prepareBackground:async()=>({prepared:[],failed:[],cancelled:[],[kind]:[{binding:added,reason:'fixture reason'}]}),
     beforeRollback:async()=>{restored++;return [old]},
     startService:()=>assert.fail('must not restart old service'),stopService:()=>assert.fail('must not stop old service'),
   })),/fixture reason/)
   assert.equal(restored,1)
 }
})
test('macOS add and Windows legacy foreground add do not use the new preparation path',async()=>{
 await controller.activateAddedBindings([added],activation({platform:'darwin',
   prepareBackground:()=>assert.fail('macOS unchanged'),startService:async()=>({pid:124})}))
 const result=await controller.activateAddedBindings([added],activation({
   getRuntimeStatus:async()=>({mode:'foreground',pid:123}),
   prepareBackground:()=>assert.fail('manual activation must not prepare'),
 }))
 assert.equal(result.mode,'manual')
})
