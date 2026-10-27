import {test} from 'node:test'
import assert from 'node:assert/strict'
import {startupProgress} from '../bin/startup-progress.mjs'
test('interactive refresh stops after success and failure cleanup',async t=>{
  t.mock.timers.enable({apis:['setInterval']})
  for(const fail of [false,true]) {
    const output=[]
    const finish=startupProgress('fixture',{stream:{isTTY:true,write:line=>output.push(line)},interval:15})
    try {t.mock.timers.tick(30);if(fail)throw Error('fixture')}catch{}finally{finish()}
    const count=output.length
    t.mock.timers.tick(60000)
    assert.equal(output.length,count)
    assert.ok(output.some(line=>line.includes('fixture')))
  }
})
test('redirected output has no periodic log writes',t=>{
  t.mock.timers.enable({apis:['setInterval']})
  const output=[]
  const finish=startupProgress('fixture',{stream:{isTTY:false,write:line=>output.push(line)}})
  t.mock.timers.tick(3600000)
  finish()
  assert.deepEqual(output,[])
})
