import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AampAcpBridge, type AgentBridgeHandle } from './bridge.js'
import type { AgentConfig, BridgeConfig } from './config.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function config(names: string[]): BridgeConfig {
  return {
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: names.map((name) => ({ name, acpCommand: `${name} acp` })),
  }
}

test('starts at most four agents concurrently and reports successful agents in config order', async () => {
  const gates = new Map(['a', 'b', 'c', 'd', 'e'].map((name) => [name, deferred()]))
  const entered: string[] = []
  const events: Array<Record<string, unknown>> = []
  let active = 0
  let peak = 0

  const bridge = new AampAcpBridge(config(['a', 'b', 'c', 'd', 'e']), {
    maxAgentConcurrency: 4,
    createAgentBridge(agent: AgentConfig): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          entered.push(agent.name)
          active += 1
          peak = Math.max(peak, active)
          await gates.get(agent.name)!.promise
          active -= 1
        },
        async stop() {},
      }
    },
  })

  const starting = bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['a', 'b', 'c', 'd'])
  assert.equal(peak, 4)
  gates.get('b')!.resolve()
  await until(() => entered.includes('e'))
  for (const gate of gates.values()) gate.resolve()
  await starting

  const running = events.find((event) => event.type === 'bridge.running')
  assert.ok(running)
  assert.deepEqual(running?.agents, ['a', 'b', 'c', 'd', 'e'].map((name) => ({
    name,
    email: `${name}@meshmail.ai`,
  })))
  assert.equal(Number.isFinite(Number(running.durationMs)) && Number(running.durationMs) >= 0, true)
  const runningIndex = events.indexOf(running)
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const startingIndex = events.findIndex((event) => event.type === 'agent.starting' && event.agent === name)
    const startedIndex = events.findIndex((event) => event.type === 'agent.started' && event.agent === name)
    assert.ok(startingIndex < startedIndex && startedIndex < runningIndex)
    assert.equal(Number.isFinite(Number(events[startedIndex].durationMs)), true)
  }
})

test('one failed agent is cleaned without blocking successful agents', async () => {
  const stopped: string[] = []
  const events: Array<Record<string, unknown>> = []
  const bridge = new AampAcpBridge(config(['bad', 'good']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          if (agent.name === 'bad') throw new Error('bad startup')
        },
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  assert.deepEqual(stopped, ['bad'])
  assert.equal(events.some((event) => event.type === 'agent.failed' && event.agent === 'bad'), true)
  assert.equal(events.some((event) => event.type === 'agent.started' && event.agent === 'good'), true)
  assert.deepEqual(
    events.find((event) => event.type === 'bridge.running')?.agents,
    [{ name: 'good', email: 'good@meshmail.ai' }],
  )
})

test('all failures reject without bridge.running and all partial bridges are stopped', async () => {
  const events: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  const bridge = new AampAcpBridge(config(['one', 'two']), {
    now: (() => { let value = 100; return () => value += 5 })(),
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: false,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() { throw new Error(`${agent.name} failed`) },
        async stop() { stopped.push(agent.name) },
      }
    },
  })
  await assert.rejects(
    bridge.start({ quiet: true, onEvent: (event) => events.push(event) }),
    /No agents started successfully/,
  )
  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.equal(events.some((event) => event.type === 'bridge.running'), false)
  const failed = events.filter((event) => event.type === 'agent.failed')
  assert.equal(failed.length, 2)
  assert.equal(failed.every((event) => (
    Number.isFinite(Number(event.durationMs)) && Number(event.durationMs) >= 0
  )), true)
})

test('stop attempts every running agent even when one stop fails', async () => {
  const stopped: string[] = []
  const events: Array<Record<string, unknown>> = []
  const stopGate = deferred()
  const bridge = new AampAcpBridge(config(['one', 'two']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {
          stopped.push(agent.name)
          await stopGate.promise
          if (agent.name === 'one') throw new Error('stop failed')
        },
      }
    },
  })
  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const stopping = bridge.stop()
  await until(() => stopped.length === 2)
  stopGate.resolve()
  await stopping
  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.equal(events.at(-1)?.type, 'bridge.stopped')
})

test('clamps started and running durations when the clock regresses', async () => {
  const events: Array<Record<string, unknown>> = []
  const times = [100, 90, 80, 70]
  const bridge = new AampAcpBridge(config(['one']), {
    now: () => times.shift() ?? 60,
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {},
      }
    },
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const started = events.find((event) => event.type === 'agent.started')
  const running = events.find((event) => event.type === 'bridge.running')
  assert.ok(started)
  assert.ok(running)
  assert.equal(started.durationMs, 0)
  assert.equal(running.durationMs, 0)
})

test('reports a factory failure while allowing another agent to start', async () => {
  const events: Array<Record<string, unknown>> = []
  const bridge = new AampAcpBridge(config(['broken', 'good']), {
    createAgentBridge(agent): AgentBridgeHandle {
      if (agent.name === 'broken') throw new Error('factory failed')
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {},
      }
    },
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const failed = events.filter((event) => event.type === 'agent.failed')
  assert.deepEqual(failed.map((event) => event.agent), ['broken'])
  assert.match(String(failed[0].message), /factory failed/)
  assert.equal(Number.isFinite(Number(failed[0].durationMs)), true)
  assert.equal(events.some((event) => event.type === 'agent.started' && event.agent === 'good'), true)
})

test('propagates an agent event callback failure after reporting the agent failure', async () => {
  const events: Array<Record<string, unknown>> = []
  const callbackFailure = new Error('event callback failed')
  const bridge = new AampAcpBridge(config(['one']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {},
      }
    },
  })

  await assert.rejects(
    bridge.start({
      quiet: true,
      onEvent: (event) => {
        if (event.type === 'agent.starting') throw callbackFailure
        events.push(event)
      },
    }),
    callbackFailure,
  )
  assert.equal(events.some((event) => event.type === 'agent.failed' && event.agent === 'one'), true)
})

test('stop waits for startup and stops an in-flight handle without emitting bridge.running', async () => {
  const events: Array<Record<string, unknown>> = []
  const started = deferred()
  const stopped: string[] = []
  let entered = false
  const bridge = new AampAcpBridge(config(['one']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          entered = true
          await started.promise
        },
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  const starting = bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  await until(() => entered)
  const stopping = bridge.stop()
  started.resolve()
  await Promise.all([starting, stopping])

  assert.deepEqual(stopped, ['one'])
  assert.equal(events.some((event) => event.type === 'bridge.running'), false)
  assert.equal(events.at(-1)?.type, 'bridge.stopped')
})

test('rejects a start requested during stop without leaking another handle', async () => {
  const events: Array<Record<string, unknown>> = []
  const stopGate = deferred()
  const stopped: string[] = []
  let created = 0
  const bridge = new AampAcpBridge(config(['one']), {
    createAgentBridge(agent): AgentBridgeHandle {
      created += 1
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {
          stopped.push(agent.name)
          await stopGate.promise
        },
      }
    },
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const stopping = bridge.stop()
  await until(() => stopped.length === 1)
  await assert.rejects(bridge.start({ quiet: true }), /Bridge is stopping/)
  stopGate.resolve()
  await stopping

  assert.equal(created, 1)
  assert.deepEqual(stopped, ['one'])
  const stoppedIndex = events.findIndex((event) => event.type === 'bridge.stopped')
  assert.ok(stoppedIndex > events.findIndex((event) => event.type === 'agent.stopping'))
  assert.equal(events.slice(stoppedIndex + 1).some((event) => event.type === 'bridge.running'), false)
})

test('stops every agent before propagating an agent.stopping callback failure', async () => {
  const callbackFailure = new Error('stopping callback failed')
  const stopped: string[] = []
  const events: Array<Record<string, unknown>> = []
  const bridge = new AampAcpBridge(config(['one', 'two']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  await bridge.start({
    quiet: true,
    onEvent: (event) => {
      if (event.type === 'agent.stopping' && event.agent === 'one') throw callbackFailure
      events.push(event)
    },
  })
  await assert.rejects(bridge.stop(), callbackFailure)

  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.equal(events.at(-1)?.type, 'bridge.stopped')
})

test('cleans successful handles before propagating an agent.failed callback failure', async () => {
  const callbackFailure = new Error('failed callback failed')
  const stopped: string[] = []
  const bridge = new AampAcpBridge(config(['bad', 'good']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          if (agent.name === 'bad') throw new Error('bad startup')
        },
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  await assert.rejects(
    bridge.start({
      quiet: true,
      onEvent: (event) => {
        if (event.type === 'agent.failed') throw callbackFailure
      },
    }),
    callbackFailure,
  )
  assert.deepEqual(stopped.sort(), ['bad', 'good'])
})

test('cleans successful handles before propagating a bridge.running callback failure', async () => {
  const callbackFailure = new Error('running callback failed')
  const stopped: string[] = []
  const bridge = new AampAcpBridge(config(['one']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  await assert.rejects(
    bridge.start({
      quiet: true,
      onEvent: (event) => {
        if (event.type === 'bridge.running') throw callbackFailure
      },
    }),
    callbackFailure,
  )
  assert.deepEqual(stopped, ['one'])
})
