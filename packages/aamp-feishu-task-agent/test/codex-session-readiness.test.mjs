import {test} from 'node:test'
import assert from 'node:assert/strict'
import {codexSessionFailure} from '../bin/runtime-network.mjs'
import * as readiness from '../bin/runtime-network.mjs'

test('local CodeBuddy deferred session cannot be accepted as running', () => {
  const events = [{type:'agent.session.deferred', agent:'codebuddy', message:'ERR_MODULE_NOT_FOUND: zod'}, {type:'agent.started',agent:'codebuddy'}]
  assert.match(readiness.localAgentSessionFailure(events, 'codebuddy'), /zod/)
  assert.equal(readiness.localAgentSessionFailure([...events, {type:'agent.session.ready',agent:'codebuddy'}], 'codebuddy'), undefined)
  assert.equal(readiness.localAgentSessionFailure([], 'traex'), undefined)
})
test('Codex deferred initialization cannot be hidden by agent.started',()=>{
  const events=[{type:'agent.session.deferred',agent:'codex',message:'npm ENOENT'}, {type:'agent.started',agent:'codex'}]
  assert.match(codexSessionFailure(events),/npm ENOENT/)
  assert.equal(codexSessionFailure([...events,{type:'agent.session.ready',agent:'codex'}]),undefined)
  assert.match(codexSessionFailure([{type:'agent.session.deferred',agent:'aime'}]),/未收到/)
})
