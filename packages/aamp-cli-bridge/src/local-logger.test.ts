import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { installLocalBridgeConsoleLogger } from './local-logger.js'

test('local bridge logger writes console lines and task events to JSONL without mirroring', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aamp-local-logger-'))
  const logFile = path.join(dir, 'cli-bridge.jsonl')
  const mirrored: unknown[][] = []
  const target = {
    log: (...values: unknown[]) => { mirrored.push(['log', ...values]) },
    warn: (...values: unknown[]) => { mirrored.push(['warn', ...values]) },
    error: (...values: unknown[]) => { mirrored.push(['error', ...values]) },
  }

  const installed = installLocalBridgeConsoleLogger({
    bridge: 'cli-bridge',
    logFile,
    env: {},
  }, target)

  try {
    target.log('[task feishu-task-guid-event] received')
    target.log('[debug] [aamp stream feishu-task-guid-event] opened stream=str_1', { taskId: 'feishu-task-guid-event' })
    target.log('[warn ] [aamp help feishu-task-guid-event] help-needed waiting', { taskId: 'feishu-task-guid-event' })
    target.log('explicit task log', { taskId: 'feishu-task-explicit-guid-event' })
    target.log('plain log', undefined)
    installed.event({
      type: 'task.received',
      bridge: 'cli-bridge',
      taskId: 'feishu-task-guid-event',
    })
    installed.flush()

    assert.deepEqual(mirrored, [])
    const records = (await readFile(logFile, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.equal(records.length, 6)
    assert.equal(records[0]?.bridge, 'cli-bridge')
    assert.equal(records[0]?.stream, 'stdout')
    assert.equal(records[0]?.stage, 'aamp.dispatch')
    assert.equal(records[0]?.level, 30)
    assert.equal(records[0]?.message, 'received')
    assert.doesNotMatch(String(records[0]?.message), /feishu-task-guid-event/)
    assert.equal(records[0]?.taskId, 'feishu-task-guid-event')
    assert.equal(records[1]?.stage, 'aamp.stream')
    assert.equal(records[1]?.level, 20)
    assert.equal(records[1]?.message, '[debug] opened stream=str_1')
    assert.equal(records[2]?.stage, 'aamp.help')
    assert.equal(records[2]?.level, 40)
    assert.equal(records[2]?.message, '[warn ] help-needed waiting')
    assert.equal(records[3]?.taskId, 'feishu-task-explicit-guid-event')
    assert.equal(records[3]?.message, 'explicit task log')
    assert.equal(records[4]?.message, 'plain log')
    assert.equal(records[4]?.taskId, undefined)
    assert.equal(records[5]?.event_type, 'task.received')
    assert.equal(records[5]?.stage, 'aamp.dispatch')
    assert.equal(records[5]?.taskId, 'feishu-task-guid-event')
  } finally {
    installed.restore()
    await rm(dir, { recursive: true, force: true })
  }

  target.log('after-restore')
  assert.deepEqual(mirrored, [['log', 'after-restore']])
})
