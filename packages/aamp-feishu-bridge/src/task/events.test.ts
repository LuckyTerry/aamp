import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFeishuTaskEvent } from './events.js'

test('controlled commands take priority over legacy event types', () => {
  assert.equal(classifyFeishuTaskEvent(['task_create', 'task_agent_start']), 'task_agent_start')
  assert.equal(classifyFeishuTaskEvent(['task_comment_create', 'task_agent_stop']), 'task_agent_stop')
  assert.equal(classifyFeishuTaskEvent(['task_agent_start', 'task_agent_stop']), null)
})
