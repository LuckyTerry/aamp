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
    target.log('[bridge] starting')
    target.log('[feishu agent] registered app=cli_aac')
    target.log('[feishu event evt1] duplicate ignored')
    target.log('[feishu task guid1] loaded base summary="hello"')
    target.log('[task e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e event 6143acfa57735389321c635927ad1ae6] result received aamp_task=feishu-task-e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e-6143acfa57735389321c635927ad1ae6')
    target.log('[aamp ack feishu-task-ack] received from=agent@meshmail.ai', { taskId: 'feishu-task-ack' })
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

    assert.equal(records.length, 9)
    assert.equal(records[0]?.bridge, 'feishu-bridge')
    assert.equal(records[0]?.stream, 'stdout')
    assert.equal(records[0]?.stage, 'bridge.init')
    assert.equal(records[0]?.message, 'starting')
    assert.equal(records[1]?.stage, 'feishu.init')
    assert.equal(records[1]?.message, 'registered app=cli_aac')
    assert.equal(records[2]?.stage, 'feishu.event')
    assert.equal(records[3]?.stage, 'aamp.load')
    assert.equal(records[4]?.stage, 'aamp.result')
    assert.equal(records[4]?.taskId, 'feishu-task-e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e-6143acfa57735389321c635927ad1ae6')
    assert.equal(records[4]?.message, 'result received')
    assert.doesNotMatch(String(records[4]?.message), /feishu-task-e4cb9d08-22c7-46b2-9b61-e2eefd0f9e7e-6143acfa57735389321c635927ad1ae6/)
    assert.doesNotMatch(String(records[4]?.message), /aamp_task=/)
    assert.equal(records[4]?.task_guid, undefined)
    assert.equal(records[4]?.event_id, undefined)
    assert.equal(records[5]?.stage, 'aamp.ack')
    assert.equal(records[5]?.taskId, 'feishu-task-ack')
    assert.equal(records[5]?.message, 'received from=agent@meshmail.ai')
    assert.equal(records[6]?.taskId, 'feishu-task-explicit-guid-event')
    assert.equal(records[6]?.message, 'explicit task log')
    assert.equal(records[7]?.message, 'plain log')
    assert.equal(records[7]?.taskId, undefined)
    assert.equal(records[8]?.event_type, 'task.result')
    assert.equal(records[8]?.stage, 'aamp.result')
    assert.equal(records[8]?.taskId, 'feishu-task-guid-event')
  } finally {
    installed.restore()
    await rm(dir, { recursive: true, force: true })
  }

  target.log('after-restore')
  assert.deepEqual(mirrored, [['log', 'after-restore']])
})

test('local bridge logger normalizes real Feishu bridge task log prefixes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aamp-local-logger-'))
  const logFile = path.join(dir, 'feishu-bridge.jsonl')
  const target = {
    log: (..._values: unknown[]) => {},
    warn: (..._values: unknown[]) => {},
    error: (..._values: unknown[]) => {},
  }
  const taskId = 'feishu-task-4f8b9715-a5dc-4913-8a90-4880a34c485f-f7f06f3fd3b32a1995f15b3de8512edb'
  const taskGuid = '4f8b9715-a5dc-4913-8a90-4880a34c485f'

  const installed = installLocalBridgeConsoleLogger({
    bridge: 'feishu-bridge',
    logFile,
    env: {},
  }, target)

  try {
    target.log(`[debug] [aamp dispatch ${taskId}] sending to=codex-bridge@meshmail.ai`, { taskId })
    target.log(`[debug] [aamp ack ${taskId}] commenting on Feishu task ${taskGuid}`, { taskId })
    target.log(`[debug] [feishu task ${taskGuid}] marking in progress for ${taskId}`, { taskId })
    target.log(`[debug] [feishu task ${taskGuid}] completed for ${taskId}`, { taskId })
    target.log(`[info ] [task ${taskGuid}] marked in_progress parent=1 children=0`, { taskId })
    target.log(`[info ] [task ${taskGuid}] completed parent=1 children=0`, { taskId })
    target.log(`[info ] [aamp result ${taskId}] answered`, { taskId })
    target.log(`[warn ] [aamp help ${taskId}] help-needed waiting for human`, { taskId })
    installed.flush()

    const records = (await readFile(logFile, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.equal(records[0]?.stage, 'aamp.dispatch')
    assert.equal(records[0]?.level, 20)
    assert.equal(records[0]?.message, '[debug] sending to=codex-bridge@meshmail.ai')
    assert.equal(records[1]?.stage, 'aamp.ack')
    assert.equal(records[1]?.level, 20)
    assert.equal(records[1]?.message, `[debug] commenting on Feishu task ${taskGuid}`)
    assert.equal(records[2]?.stage, 'aamp.ack')
    assert.equal(records[2]?.level, 20)
    assert.equal(records[2]?.message, '[debug] marking in progress for <task>')
    assert.equal(records[3]?.stage, 'aamp.result')
    assert.equal(records[3]?.level, 20)
    assert.equal(records[3]?.message, '[debug] completed for <task>')
    assert.equal(records[4]?.stage, 'aamp.ack')
    assert.equal(records[4]?.level, 30)
    assert.equal(records[4]?.message, '[info ] marked in_progress parent=1 children=0')
    assert.equal(records[5]?.stage, 'aamp.result')
    assert.equal(records[5]?.level, 30)
    assert.equal(records[5]?.message, '[info ] completed parent=1 children=0')
    assert.equal(records[6]?.stage, 'aamp.result')
    assert.equal(records[6]?.level, 30)
    assert.equal(records[6]?.message, '[info ] answered')
    assert.equal(records[7]?.stage, 'aamp.help')
    assert.equal(records[7]?.level, 40)
    assert.equal(records[7]?.message, '[warn ] help-needed waiting for human')
  } finally {
    installed.restore()
    await rm(dir, { recursive: true, force: true })
  }
})
