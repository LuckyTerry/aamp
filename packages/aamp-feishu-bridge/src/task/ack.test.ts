import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAckComment } from './ack.js'

test('debug ack comment uses user-facing Task ID wording', () => {
  const comment = buildAckComment({
    aampTaskId: 'feishu-task-task_guid_ack-evt_ack',
    bridgeName: 'feishu@meshmail.ai',
    eventKind: 'task_create',
    receivedAt: new Date('2026-07-08T12:00:00.000Z'),
    debug: true,
  })

  assert.match(comment, /- Task ID: feishu-task-task_guid_ack-evt_ack/)
  assert.match(comment, /- Bridge: feishu@meshmail\.ai/)
  assert.match(comment, /- 事件场景: task_create/)
  assert.match(comment, /- 收到时间: 2026-07-08T12:00:00\.000Z/)
  assert.match(comment, /- 查看日志: \/Users\/bytedance\/\.aamp\/bin\/aamp-logs tail --task-id feishu-task-task_guid_ack-evt_ack/)
  assert.match(comment, /- 导出日志: \/Users\/bytedance\/\.aamp\/bin\/aamp-logs collect --task-id feishu-task-task_guid_ack-evt_ack/)
  assert.doesNotMatch(comment, /AAMP Task ID/)
})
