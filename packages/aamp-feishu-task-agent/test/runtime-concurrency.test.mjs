import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createKeyedSerialExecutor,
  createSerializedRunner,
  runLayeredStarts,
  settleWithConcurrency,
} from '../bin/runtime-concurrency.mjs'
import * as controller from '../bin/feishu-task-agent-controller.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('settleWithConcurrency caps active work and preserves input order', async () => {
  let active = 0
  let peak = 0
  const result = await settleWithConcurrency([30, 5, 15, 1, 10], 2, async (delay) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    if (delay === 15) throw new Error('fifteen')
    return delay
  })
  assert.equal(peak, 2)
  assert.deepEqual(result.map(({ status }) => status), [
    'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled',
  ])
  assert.deepEqual(result.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []), [30, 5, 1, 10])
})

test('settleWithConcurrency rejects invalid limits and skips worker for empty input', async () => {
  for (const limit of [0, -1, 1.5]) {
    await assert.rejects(
      settleWithConcurrency([], limit, async () => {}),
      /concurrency limit must be a positive integer/,
    )
  }
  let calls = 0
  const outcomes = await settleWithConcurrency([], 1, async () => {
    calls += 1
  })
  assert.deepEqual(outcomes, [])
  assert.equal(calls, 0)
})

test('runLayeredStarts finishes serial preparation before concurrent starts', async () => {
  const events = []
  let activePrepare = 0
  let activeStart = 0
  let peakStart = 0
  const outcomes = await runLayeredStarts(['a', 'bad', 'b', 'c'], {
    concurrency: 2,
    async prepare(item) {
      activePrepare += 1
      assert.equal(activePrepare, 1)
      events.push(`prepare:${item}`)
      await new Promise((resolve) => setImmediate(resolve))
      activePrepare -= 1
      if (item === 'bad') throw new Error('prepare bad')
      return item.toUpperCase()
    },
    async start(prepared) {
      assert.equal(events.filter((event) => event.startsWith('prepare:')).length, 4)
      activeStart += 1
      peakStart = Math.max(peakStart, activeStart)
      await new Promise((resolve) => setImmediate(resolve))
      activeStart -= 1
      return prepared
    },
  })
  assert.equal(peakStart, 2)
  assert.deepEqual(outcomes.map(({ status, phase }) => [status, phase]), [
    ['fulfilled', 'start'],
    ['rejected', 'prepare'],
    ['fulfilled', 'start'],
    ['fulfilled', 'start'],
  ])
})

test('keyed executor serializes equal keys and allows different keys to overlap', async () => {
  const execute = createKeyedSerialExecutor()
  const gate = deferred()
  const events = []
  const first = execute('codex', async () => {
    events.push('codex:1:start')
    await gate.promise
    events.push('codex:1:end')
  })
  const second = execute('codex', async () => { events.push('codex:2') })
  const other = execute('traex', async () => { events.push('traex:1') })
  await other
  assert.deepEqual(events, ['codex:1:start', 'traex:1'])
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(events, ['codex:1:start', 'traex:1', 'codex:1:end', 'codex:2'])
})

test('keyed executor recovers queued and later work after a same-key rejection', async () => {
  const execute = createKeyedSerialExecutor()
  const gate = deferred()
  const firstStarted = deferred()
  const events = []
  const first = execute('codex', async () => {
    events.push('first:start')
    firstStarted.resolve()
    await gate.promise
    events.push('first:reject')
    throw new Error('first failed')
  })
  await firstStarted.promise
  const second = execute('codex', async () => { events.push('second') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['first:start'])
  gate.resolve()
  await assert.rejects(first, /first failed/)
  await second
  await execute('codex', async () => { events.push('third') })
  assert.deepEqual(events, ['first:start', 'first:reject', 'second', 'third'])
})

test('serialized runner executes latest state in order and recovers after a rejected caller', async () => {
  let state = 1
  let calls = 0
  const written = []
  const runner = createSerializedRunner(async () => {
    calls += 1
    if (calls === 1) throw new Error('first write failed')
    written.push(state)
  })
  await assert.rejects(runner.run(), /first write failed/)
  state = 2
  await runner.run()
  await runner.flush()
  assert.deepEqual(written, [2])
})

test('serialized runner flush waits for in-flight and queued work in order', async () => {
  const gate = deferred()
  const firstStarted = deferred()
  const events = []
  let calls = 0
  const runner = createSerializedRunner(async () => {
    calls += 1
    events.push(`start:${calls}`)
    if (calls === 1) {
      firstStarted.resolve()
      await gate.promise
    }
    events.push(`end:${calls}`)
  })
  const first = runner.run()
  await firstStarted.promise
  const second = runner.run()
  let flushed = false
  const flush = runner.flush().then(() => { flushed = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(flushed, false)
  assert.deepEqual(events, ['start:1'])
  gate.resolve()
  await Promise.all([first, second, flush])
  assert.equal(flushed, true)
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2'])
})

test('serialized snapshot writer cannot let an old snapshot overwrite newer state', async () => {
  const firstGate = deferred()
  const writes = []
  const state = new Map([['a', 'starting']])
  let call = 0
  const runner = createSerializedRunner(async () => {
    call += 1
    const snapshot = Object.fromEntries(state)
    if (call === 1) await firstGate.promise
    writes.push(snapshot)
  })
  const first = runner.run()
  state.set('b', 'running')
  const second = runner.run()
  firstGate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(writes.at(-1), { a: 'starting', b: 'running' })
})

test('prompt interrupter cancels an active prompt exactly once and ignores released prompts', () => {
  assert.equal(typeof controller.createPromptInterrupter, 'function')
  const interrupter = controller.createPromptInterrupter()
  const cancellations = []
  const release = interrupter.activate((error) => cancellations.push(error.message))

  assert.equal(interrupter.interrupt(new Error('SIGTERM')), true)
  assert.equal(interrupter.interrupt(new Error('SIGHUP')), false)
  release()
  assert.deepEqual(cancellations, ['SIGTERM'])

  const later = []
  const releaseLater = interrupter.activate((error) => later.push(error.message))
  releaseLater()
  assert.equal(interrupter.interrupt(new Error('SIGINT')), false)
  assert.deepEqual(later, [])
})

test('resource cleanup drains a resource registered after an earlier drain started', async () => {
  assert.equal(typeof controller.createResourceCleanup, 'function')
  const firstDrainGate = deferred()
  const firstDrainStarted = deferred()
  const resources = []
  const released = []
  let drains = 0
  let activeDrains = 0
  let peakDrains = 0
  const cleanup = controller.createResourceCleanup(async () => {
    drains += 1
    activeDrains += 1
    peakDrains = Math.max(peakDrains, activeDrains)
    while (resources.length) released.push(resources.shift())
    if (drains === 1) {
      firstDrainStarted.resolve()
      await firstDrainGate.promise
    }
    activeDrains -= 1
  })

  const signalCleanup = cleanup()
  await firstDrainStarted.promise
  resources.push('late-lease')
  const finalCleanup = cleanup()
  firstDrainGate.resolve()
  await Promise.all([signalCleanup, finalCleanup])

  assert.deepEqual(released, ['late-lease'])
  assert.equal(drains, 2)
  assert.equal(peakDrains, 1)
})
