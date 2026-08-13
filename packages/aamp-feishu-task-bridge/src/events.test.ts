import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFeishuTaskEvent } from './events.js'

test('classifyFeishuTaskEvent ignores unrelated task updates', () => {
  assert.equal(classifyFeishuTaskEvent(['task_summary_update']), null)
})

test('classifyFeishuTaskEvent recognizes task create events', () => {
  assert.equal(classifyFeishuTaskEvent(['task_create']), 'task_create')
})

test('classifyFeishuTaskEvent recognizes task comment events', () => {
  assert.equal(classifyFeishuTaskEvent(['task_comment_create']), 'task_comment')
  assert.equal(classifyFeishuTaskEvent(['task_comment_reply']), 'task_comment')
  assert.equal(classifyFeishuTaskEvent(['task_comment_update']), 'task_comment')
})

test('classifyFeishuTaskEvent recognizes reminder fire events', () => {
  assert.equal(classifyFeishuTaskEvent(['task_reminder_fire']), 'task_reminder_fire')
})

test('classifyFeishuTaskEvent prefers comment events over task create', () => {
  assert.equal(classifyFeishuTaskEvent(['task_create', 'task_comment_reply']), 'task_comment')
})
