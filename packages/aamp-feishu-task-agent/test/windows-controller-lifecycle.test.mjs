import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createWindowsRestartService,
  sampleWindowsProcessTree,
  runServiceLifecycleCommand,
  stopWindowsForegroundControllers,
  windowsProcessJournalMode,
} from '../bin/feishu-task-agent-controller.mjs'

const identity = {
  pid: 4321,
  startedAt: '2026-09-07T01:00:00.000Z',
  command: 'node controller.mjs',
  executablePath: 'C:\\node.exe',
  ownerSid: 'S-1-5-21-1',
}

test('production Windows restart wrapper forwards the locked beforeStart callback', async () => {
  const beforeStart = async () => {}
  const calls = []
  const restart = createWindowsRestartService({
    restart: async (ids, options) => { calls.push({ ids, options }); return { pid: 99 } },
  })
  assert.deepEqual(await restart(['binding-a'], { beforeStart }), { pid: 99 })
  assert.deepEqual(calls, [{ ids: ['binding-a'], options: { beforeStart } }])
})

test('read-only and stop commands never recover or create Windows process journals', () => {
  for (const command of ['status', 'list', 'logs', 'remove', 'stop']) {
    assert.deepEqual(windowsProcessJournalMode(command), { recover: false, create: false })
  }
  assert.deepEqual(windowsProcessJournalMode('add'), { recover: false, create: true })
  for (const command of ['install', 'start', 'restart', '__service-run']) {
    assert.deepEqual(windowsProcessJournalMode(command), { recover: true, create: true })
  }
})

test('Windows sampling persists the verified root before a descendant snapshot failure', async () => {
  const recorded = []
  const record = {
    windowsIdentity: Promise.resolve(identity),
    windowsDescendants: new Map(),
  }
  await assert.rejects(sampleWindowsProcessTree(record, {
    record: async (items) => recorded.push([...items]),
  }, {
    snapshotTree: async () => { throw new Error('CIM snapshot denied') },
  }), /CIM snapshot denied/)
  assert.deepEqual(recorded, [[identity]])
})

test('restart transaction stops foreground owners under the service lifecycle lock before background start', async () => {
  const calls = []
  const result = await runServiceLifecycleCommand('restart', {
    readSelection: async () => ['binding-a'],
    loadBindings: async () => [{ binding_id: 'binding-a' }],
    stopRuntime: async (options) => {
      calls.push('foreground-stop')
      assert.deepEqual(await options.stopLaunchd(), { stopped: true, wasLoaded: false })
      return { launchd: false, stoppedPids: [4321] }
    },
    startService: async () => assert.fail('transactional restart must own start'),
    restartService: async (ids, { beforeStart }) => {
      calls.push('manager-lock-held')
      await beforeStart()
      calls.push('background-start')
      assert.deepEqual(ids, ['binding-a'])
      return { state: 'running', pid: 99 }
    },
    log: () => {},
  })
  assert.deepEqual(calls, ['manager-lock-held', 'foreground-stop', 'background-start'])
  assert.equal(result.pid, 99)
})

test('Windows foreground stop requests cooperative shutdown before any taskkill fallback', async () => {
  const calls = []
  let reads = 0
  const result = await stopWindowsForegroundControllers([identity.pid], {
    discoverOwnedControllerPids: async () => [identity.pid],
    currentSid: async () => identity.ownerSid,
    readIdentity: async () => (++reads === 1 ? identity : undefined),
    requestStop: async () => { calls.push('request'); return true },
    wait: async () => calls.push('wait'),
    stopTree: async () => calls.push('taskkill'),
    attempts: 2,
  })
  assert.deepEqual(calls, ['request', 'wait'])
  assert.deepEqual(result, { stopped: [identity.pid], remaining: [] })
})

test('Windows foreground stop taskkills only the original identity after bounded cooperative wait', async () => {
  const calls = []
  let killed = false
  const result = await stopWindowsForegroundControllers([identity.pid], {
    discoverOwnedControllerPids: async () => [identity.pid],
    currentSid: async () => identity.ownerSid,
    readIdentity: async () => killed ? undefined : identity,
    requestStop: async () => { calls.push('request'); return true },
    wait: async () => calls.push('wait'),
    stopTree: async (recorded) => { assert.deepEqual(recorded, identity); killed = true; calls.push('taskkill') },
    attempts: 2,
  })
  assert.deepEqual(calls, ['request', 'wait', 'wait', 'taskkill'])
  assert.deepEqual(result.stopped, [identity.pid])
})

test('Windows foreground stop refuses fallback when the PID identity changes', async () => {
  let reads = 0
  let killed = false
  await stopWindowsForegroundControllers([identity.pid], {
    discoverOwnedControllerPids: async () => [identity.pid],
    currentSid: async () => identity.ownerSid,
    readIdentity: async () => (++reads === 1 ? identity : { ...identity, startedAt: '2026-09-07T02:00:00.000Z' }),
    requestStop: async () => true,
    wait: async () => {},
    stopTree: async () => { killed = true },
    attempts: 2,
  })
  assert.equal(killed, false)
})

test('Windows sampling rejects an unverified live process instead of silently skipping it', async () => {
  const record = { child: { pid: 4321 }, exited: false, windowsIdentity: Promise.resolve(undefined), windowsDescendants: new Map() }
  await assert.rejects(sampleWindowsProcessTree(record, {
    record: async () => assert.fail('unverified identity must never enter a journal'),
  }, {
    snapshotTree: async () => assert.fail('unverified process must never be traversed'),
  }), /Cannot verify Windows process 4321/)
})

test('Windows sampling may ignore an exited process with no identity', async () => {
  await sampleWindowsProcessTree({ child: { pid: 4321 }, exited: true, windowsIdentity: Promise.resolve(undefined), windowsDescendants: new Map() }, {
    record: async () => assert.fail('missing identity cannot enter a journal'),
  })
})

test('Windows sampling reports the original identity query failure', async () => {
  const error = new Error('CIM identity query timed out')
  const record = { child: { pid: 4321 }, exited: false, windowsIdentity: Promise.resolve(undefined), windowsIdentityError: error, windowsDescendants: new Map() }
  await assert.rejects(sampleWindowsProcessTree(record, { record: async () => assert.fail('unverified identity') }), received => received === error)
})
