import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as controller from '../bin/feishu-task-agent-controller.mjs'

test('Windows background start prepares then waits for background readiness without foreground orchestration',async t=>{
  const output=[],calls=[],bindings=[{binding_id:'one'}]
  t.mock.method(console,'log',line=>output.push(line))
  await controller.startSelectedBindings(bindings,undefined,{
    platform:'win32',background:true,
    orchestrate:()=>assert.fail('must not start foreground bridges'),
    prepareBackground:async selected=>{calls.push('prepare');return {prepared:selected,failed:[],cancelled:[]}},
    runtimeOperations:{handoff:async selected=>{
      assert.deepEqual(selected,bindings)
      assert.equal(output.some(x=>x.includes('启动成功')||x.includes('已成功启动')),false)
      calls.push('background-ready');return {state:'running',ready:true,pid:123}
    }},
  })
  assert.deepEqual(calls,['prepare','background-ready'])
  assert.ok(output.some(x=>x.includes('现在可以关闭终端')))
})

test('background readiness failure never prints success',async t=>{
  const output=[]
  t.mock.method(console,'log',line=>output.push(line))
  await assert.rejects(controller.startSelectedBindings([{binding_id:'one'}],undefined,{
    platform:'win32',background:true,
    orchestrate:()=>assert.fail('must not start foreground bridges'),
    prepareBackground:async selected=>({prepared:selected,failed:[],cancelled:[]}),
    runtimeOperations:{handoff:async()=>{throw new Error('readiness failed')}},
  }),/readiness failed/)
  assert.equal(output.some(x=>x.includes('启动成功')||x.includes('已成功启动')||x.includes('可以关闭')),false)
})

test('preflight prepares each agent once, preserves cancellation and excludes failed profiles',async()=>{
  const bindings=['a','b','c','d'].map((binding_id,i)=>({binding_id,aamp_host:'host',agent_type:i<2?'codex':i===2?'cursor':'aime'}))
  const calls=[]
  const result=await controller.prepareWindowsBackgroundBindings(bindings,{
    validate:()=>{},checkStopping:()=>{},
    prepareAgent:async b=>{calls.push(b.agent_type);return b.agent_type==='cursor'?{cancelled:true,reason:'cancel'}:{}},
    prepareBinding:async b=>{if(b.binding_id==='b')throw new Error('profile invalid')},
    recordFailure:async()=>{},recordCancellation:async()=>{},
  })
  assert.deepEqual(calls,['codex','cursor','aime'])
  assert.deepEqual(result.prepared.map(b=>b.binding_id),['a','d'])
  assert.deepEqual(result.failed.map(x=>x.binding.binding_id),['b'])
  assert.deepEqual(result.cancelled.map(x=>x.binding.binding_id),['c'])
})

test('empty preflight selection cleans up without launching and failed preparation rejects',async t=>{
  t.mock.method(console,'log',()=>{})
  for (const failed of [[],[{binding:{binding_id:'bad'},reason:'bad profile'}]]) {
    let cleaned=0
    const action=controller.startSelectedBindings([],undefined,{
      platform:'win32',background:true,
      prepareBackground:async()=>({prepared:[],failed,cancelled:[]}),
      cleanup:async()=>{cleaned++},
      runtimeOperations:{handoff:()=>assert.fail('no eligible bindings')},
    })
    if(failed.length)await assert.rejects(action,/未完成启动准备/)
    else await action
    assert.equal(cleaned,1)
  }
})

test('a dispatched background process without readiness is not reported as successful',async t=>{
  const output=[]
  t.mock.method(console,'log',line=>output.push(line))
  await assert.rejects(controller.startSelectedBindings([{binding_id:'one'}],undefined,{
    platform:'win32',background:true,
    prepareBackground:async selected=>({prepared:selected,failed:[],cancelled:[]}),
    runtimeOperations:{handoff:async()=>({pid:123,ready:false})},
  }),/尚未确认就绪/)
  assert.equal(output.some(x=>x.includes('已成功启动')||x.includes('可以关闭')),false)
})
