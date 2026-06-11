import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAckComment, shouldCommentAck } from './ack.js'
import type { BridgeTaskState } from './types.js'

test('buildAckComment is concise by default', () => {
  const comment = buildAckComment({
    aampTaskId: 'aamp_task_1',
    bridgeName: 'aamp-feishu-task-bridge',
    eventKind: 'task_create',
  })

  assert.equal(comment, '已收到任务派发请求，正在转交智能体处理。')
  assert.doesNotMatch(comment, /AAMP Task ID/)
  assert.doesNotMatch(comment, /Bridge/)
  assert.doesNotMatch(comment, /收到时间/)
})

test('buildAckComment uses reply wording for comment-triggered tasks', () => {
  const comment = buildAckComment({
    aampTaskId: 'aamp_task_1',
    bridgeName: 'aamp-feishu-task-bridge',
    eventKind: 'task_comment',
  })

  assert.equal(comment, '已收到您的回复，正在转交智能体处理。')
})

test('buildAckComment uses reminder wording for reminder-fired tasks', () => {
  const comment = buildAckComment({
    aampTaskId: 'aamp_task_1',
    bridgeName: 'aamp-feishu-task-bridge',
    eventKind: 'task_reminder_fire',
  })

  assert.equal(comment, '任务提醒已到期，正在转交智能体处理。')
})

test('buildAckComment includes diagnostics in debug mode', () => {
  const comment = buildAckComment({
    aampTaskId: 'aamp_task_1',
    bridgeName: 'aamp-feishu-task-bridge',
    receivedAt: new Date('2026-06-05T09:37:20.866Z'),
    eventKind: 'task_comment',
    debug: true,
  })

  assert.match(comment, /^已收到您的回复，正在转交智能体处理。/)
  assert.match(comment, /AAMP Task ID: aamp_task_1/)
  assert.match(comment, /Bridge: aamp-feishu-task-bridge/)
  assert.match(comment, /事件场景: task_comment/)
  assert.match(comment, /收到时间: 2026-06-05T09:37:20.866Z/)
})

test('buildAckComment keeps task-create lead text in debug mode', () => {
  const comment = buildAckComment({
    aampTaskId: 'aamp_task_1',
    bridgeName: 'aamp-feishu-task-bridge',
    eventKind: 'task_create',
    debug: true,
  })

  assert.match(comment, /^已收到任务派发请求，正在转交智能体处理。/)
  assert.match(comment, /AAMP Task ID: aamp_task_1/)
})

test('shouldCommentAck returns true once per AAMP task id', () => {
  const state: BridgeTaskState = {
    taskGuid: 'task_guid_123',
    aampTaskId: 'aamp_task_1',
    status: 'dispatched',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  }

  assert.equal(shouldCommentAck(state, 'aamp_task_1'), true)
  state.ackCommentedTaskIds = ['aamp_task_1']
  assert.equal(shouldCommentAck(state, 'aamp_task_1'), false)
  assert.equal(shouldCommentAck(state, 'aamp_task_2'), true)
})
