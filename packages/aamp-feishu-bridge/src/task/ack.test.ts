import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAckComment } from './ack.js'

test('debug ack comment uses user-facing Task ID wording', () => {
  const comment = buildAckComment({
    aampTaskId: 'feishu-task-task_guid_ack-evt_ack',
    bridgeName: 'feishu',
    eventKind: 'task_create',
    receivedAt: new Date('2026-07-08T12:00:00.000Z'),
    debug: true,
  })

  assert.match(comment, /Task ID: feishu-task-task_guid_ack-evt_ack/)
  assert.doesNotMatch(comment, /AAMP Task ID/)
})
