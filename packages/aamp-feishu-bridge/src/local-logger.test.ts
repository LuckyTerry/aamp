import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { installLocalBridgeConsoleLogger } from './local-logger.js'

test('local bridge logger writes console lines and task events to JSONL without mirroring', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aamp-local-logger-'))
  const logFile = path.join(dir, 'feishu-bridge.jsonl')
  const mirrored: unknown[][] = []
  const target = {
    log: (...values: unknown[]) => { mirrored.push(['log', ...values]) },
    warn: (...values: unknown[]) => { mirrored.push(['warn', ...values]) },
    error: (...values: unknown[]) => { mirrored.push(['error', ...values]) },
  }

  const installed = installLocalBridgeConsoleLogger({
    bridge: 'feishu-bridge',
    logFile,
    env: {},
  }, target)

  try {
    target.log('[task e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e event 6143acfa57735389321c635927ad1ae6] result received aamp_task=feishu-task-e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e-6143acfa57735389321c635927ad1ae6')
    target.log('explicit task log', { taskId: 'feishu-task-explicit-guid-event' })
    target.log('plain log', undefined)
    installed.event({
      type: 'task.result',
      bridge: 'feishu-bridge',
      taskId: 'feishu-task-guid-event',
    })
    installed.flush()

    assert.deepEqual(mirrored, [])
    const records = (await readFile(logFile, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.equal(records.length, 4)
    assert.equal(records[0]?.bridge, 'feishu-bridge')
    assert.equal(records[0]?.stream, 'stdout')
    assert.equal(records[0]?.taskId, 'feishu-task-e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e-6143acfa57735389321c635927ad1ae6')
    assert.equal(records[0]?.task_guid, undefined)
    assert.equal(records[0]?.event_id, undefined)
    assert.equal(records[1]?.taskId, 'feishu-task-explicit-guid-event')
    assert.equal(records[1]?.message, 'explicit task log')
    assert.equal(records[2]?.message, 'plain log')
    assert.equal(records[2]?.taskId, undefined)
    assert.equal(records[3]?.event_type, 'task.result')
    assert.equal(records[3]?.taskId, 'feishu-task-guid-event')
  } finally {
    installed.restore()
    await rm(dir, { recursive: true, force: true })
  }

  target.log('after-restore')
  assert.deepEqual(mirrored, [['log', 'after-restore']])
})
