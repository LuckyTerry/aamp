import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runLayeredStarts } from '../bin/runtime-concurrency.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const controllerPath = path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs')
const source = readFileSync(controllerPath, 'utf8')
const controller = await import(pathToFileURL(controllerPath).href)

function requireExecutor(name) {
  assert.equal(typeof controller[name], 'function', `${name} must be executable in behavior tests`)
  return controller[name]
}

function preparedStart(pending) {
  const originalBinding = {
    binding_id: '11111111-1111-4111-8111-111111111111',
    agent_type: 'codex',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: {
      app_id: 'cli_task_agent',
      app_secret: 'test-secret',
      display_name: 'Task Agent',
      lark_cli_profile: 'task-agent-profile',
    },
    feishu_config_dir: '/tmp/aamp-task-agent/feishu-bridge',
    state: pending ? 'pending' : 'ready',
    ...(pending ? {} : {
      agent_target_email: 'codex@meshmail.ai',
      runtime: {
        im_config_dir: '/tmp/aamp-task-agent/feishu-bridge/task-runtime/instances/im',
        task_config_dir: '/tmp/aamp-task-agent/feishu-bridge/task-runtime/instances/task',
        feishu_bridge_email: 'feishu@meshmail.ai',
      },
    }),
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  }
  const binding = pending
    ? {
        ...originalBinding,
        state: 'ready',
        agent_target_email: 'codex@meshmail.ai',
        updated_at: '2026-08-13T00:01:00.000Z',
      }
    : originalBinding
  return {
    originalBinding,
    binding,
    group: {
      host: 'https://meshmail.ai',
      configFile: '/tmp/aamp-task-agent/acp/config.json',
      logFile: '/tmp/aamp-task-agent/acp/acp-bridge.log',
    },
    mode: 'install',
    pending,
    email: 'codex@meshmail.ai',
    runtimeAgentType: 'codex',
    preparedFeishu: {
      binding,
      phase: pending ? 'install' : 'start',
      runtimeAgentType: 'codex',
      larkCliBin: '/usr/local/bin/lark-cli',
      logFile: '/tmp/aamp-task-agent/feishu-bridge.log',
    },
  }
}

function lifecycleHarness(failAt) {
  const calls = []
  const processRecord = { label: 'controlled Feishu Bridge', exited: false }
  const runtime = {
    im_config_dir: '/tmp/aamp-task-agent/feishu-bridge/task-runtime/instances/im',
    task_config_dir: '/tmp/aamp-task-agent/feishu-bridge/task-runtime/instances/task',
    feishu_bridge_email: 'feishu@meshmail.ai',
  }
  const pairing = {
    type: 'pairing.created',
    bridge: 'acp-bridge',
    agent: 'codex',
    mailbox: 'codex@meshmail.ai',
    pairCode: 'controlled-pair-code',
    expiresAt: '2026-08-13T00:05:00.000Z',
    connectUrl: 'aamp://connect?mailbox=codex%40meshmail.ai&pair_code=controlled-pair-code',
    webUrl: 'https://meshmail.ai/pair?mailbox=codex%40meshmail.ai&pair_code=controlled-pair-code',
    pairingFile: '/tmp/aamp-task-agent/acp/pairing/codex.json',
  }
  const failure = failAt ? new Error(`${failAt} failed`) : undefined
  const updated = []
  const statuses = []
  const stopped = []
  const operations = {
    runCapture: async (_packageSpec, executable, args, options) => {
      calls.push('pair')
      assert.equal(executable, 'aamp-acp-bridge')
      assert.deepEqual(args, [
        'pair', '--agent', 'codex', '--config', '/tmp/aamp-task-agent/acp/config.json', '--json', '--no-start',
      ])
      assert.deepEqual(options, {
        logFile: '/tmp/aamp-task-agent/acp/acp-bridge.log',
        executionLocation: 'local',
      })
      if (failAt === 'pair') throw failure
      return { stdout: JSON.stringify(pairing), stderr: '' }
    },
    parseJsonDocument: (stdout, label) => {
      assert.equal(label, 'ACP pairing')
      return JSON.parse(stdout)
    },
    resolveConfiguredPendingPairingFile: async () => pairing.pairingFile,
    resolvePendingPairingFile: async (_group, _agentType, result) => result.pairingFile,
    startPreparedFeishuUntilReady: async () => {
      calls.push('start')
      if (failAt === 'start') throw failure
      return processRecord
    },
    readInitialRuntimeMetadata: async () => {
      calls.push('read')
      if (failAt === 'read') throw failure
      return runtime
    },
    validateSavedRuntime: async () => {
      calls.push('validate')
      if (failAt === 'validate') throw failure
    },
    updateBinding: async (binding) => {
      calls.push('update')
      updated.push(binding)
      if (failAt === 'update') throw failure
    },
    setBindingStatus: async (...args) => {
      calls.push('status')
      statuses.push(args)
      if (failAt === 'status') throw failure
    },
    stopManagedProcess: async (record) => {
      calls.push('stop')
      stopped.push(record)
    },
    printBindingStarted: () => {
      calls.push('print')
    },
    throwIfStopping: () => {},
  }
  return { calls, failure, operations, pairing, processRecord, runtime, statuses, stopped, updated }
}

function functionRange(startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

test('four Feishu starts overlap after every preparation has completed', async () => {
  const prepared = []
  const entered = []
  let activePrepare = 0
  let peakPrepare = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const execution = runLayeredStarts(['traex', 'workbuddy', 'codex', 'cursor'], {
    concurrency: 4,
    async prepare(item) {
      assert.equal(entered.length, 0)
      activePrepare += 1
      peakPrepare = Math.max(peakPrepare, activePrepare)
      await new Promise((resolve) => setImmediate(resolve))
      prepared.push(item)
      activePrepare -= 1
      return item
    },
    async start(item) {
      assert.equal(prepared.length, 4)
      entered.push(item)
      await gate
      return item
    },
  })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['traex', 'workbuddy', 'codex', 'cursor'])
  release()
  const outcomes = await execution
  assert.equal(peakPrepare, 1)
  assert.deepEqual(outcomes.map(({ value }) => value), ['traex', 'workbuddy', 'codex', 'cursor'])
})

test('a fifth Feishu start waits until one of four slots is released', async () => {
  const entered = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const execution = runLayeredStarts(['a', 'b', 'c', 'd', 'e'], {
    concurrency: 4,
    async prepare(item) { return item },
    async start(item) {
      entered.push(item)
      if (item !== 'e') await gate
      return item
    },
  })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['a', 'b', 'c', 'd'])
  release()
  await until(() => entered.includes('e'))
  await execution
})

test('one Feishu start failure does not block independent starts', async () => {
  const outcomes = await runLayeredStarts(['traex', 'bad', 'codex'], {
    concurrency: 3,
    async prepare(item) { return item },
    async start(item) {
      if (item === 'bad') throw new Error('ready timeout')
      return item
    },
  })
  assert.deepEqual(outcomes.map(({ status }) => status), [
    'fulfilled', 'rejected', 'fulfilled',
  ])
  assert.deepEqual(
    outcomes.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
    ['traex', 'codex'],
  )
})

test('Agent preparation stays serial while ACP init and start are split at the overlap boundary', () => {
  const initialize = functionRange('async function initializeAgentGroups(', 'async function startAgentGroups(')
  assert.match(initialize, /for \(const \[host, agentBindings\] of byHost\)/)
  assert.match(initialize, /for \(const \[agentType, sampleBinding\] of agentBindings\)/)
  assert.match(initialize, /const prepareAgent = operations\.runBootstrapHelper \|\| runBootstrapHelper/)
  assert.match(initialize, /await prepareAgent\('__prepare-agent'/)
  assert.match(initialize, /'acp-init'/)
  assert.doesNotMatch(initialize, /startManagedProcess/)

  const startAgents = functionRange('async function startAgentGroups(', 'async function setupAgentGroups(')
  assert.match(startAgents, /startManagedProcess/)
  assert.match(startAgents, /await waitForEvent\(process, \(event\) => event\.type === 'bridge\.running'\)/)

  const serialSetup = functionRange('async function setupAgentGroups(', 'function resolveInitializedGroup(')
  assert.ok(serialSetup.indexOf('await initializeAgentGroups(bindings)') < serialSetup.indexOf('await startAgentGroups(groups)'))

  const orchestrator = functionRange(
    'async function orchestrateStartupBindings(',
    'async function dispatchStartupResult(',
  )
  assert.ok(
    orchestrator.indexOf('operations.initializeAgentGroups(onlineBindings)')
      < orchestrator.indexOf('runOverlappedStartup(onlineBindings, groups, operations, profileProbes)'),
  )
})

test('controller gates pending pairing by host and stable agent type', () => {
  assert.match(source, /const runPairingSerially = createKeyedSerialExecutor\(\)/)
  assert.match(source, /function pairingQueueKey\(prepared\)/)
  assert.match(source, /`\$\{prepared\.group\.host\}\\u0000\$\{prepared\.binding\.agent_type\}`/)
  assert.match(source, /runPairingSerially\(pairingQueueKey\(prepared\)/)
})

test('start and install share the same layered binding launcher', () => {
  assert.match(source, /const FEISHU_START_CONCURRENCY = 4/)
  assert.match(source, /async function startBindingsWithGroups\([\s\S]*?operations = bindingLauncherOperations,[\s\S]*?options = \{\},[\s\S]*?\) \{/)
  assert.match(source, /concurrency: FEISHU_START_CONCURRENCY/)
  assert.match(source, /startSelectedBindings[\s\S]*orchestrateStartupBindings\(bindings, existingGroups\)/)
  assert.match(source, /orchestrateStartupBindings[\s\S]*operations\.startBindingsWithGroups\(onlineBindings, groups, 'start'\)/)
  assert.match(source, /runBindingSession[\s\S]*startBindingsWithGroups\(acceptedBindings, groups, mode\)/)
  assert.match(source, /runInstall[\s\S]*reconcileStartupResults\(bound\.selectedBindings/)
})

test('package preparation is separate from managed Bridge process execution', () => {
  const managed = functionRange(
    'async function startManagedProcess(',
    'function signalProcess(',
  )
  assert.match(managed, /packageExecutableLauncher\.launchPrepared\(/)
  assert.doesNotMatch(managed, /spawn\(NPM_BIN/)
  assert.match(managed, /type: 'bridge\.process'/)
  assert.match(managed, /status: 'started'/)
  assert.match(managed, /status: 'exited'/)
  assert.match(managed, /package: packageSpec/)

  const prepare = functionRange(
    'async function prepareFeishuProcess(',
    'async function startPreparedFeishuProcess(',
  )
  assert.match(prepare, /await packageExecutableLauncher\.resolve\(\s*FEISHU_PACKAGE,\s*'aamp-feishu-bridge'/)
  assert.match(prepare, /preparedExecutable/)

  const signalHandlers = source.slice(source.indexOf("for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])"))
  assert.match(signalHandlers, /void cleanupAll\(\)/)
})

test('shared launcher guards each pooled execution after stop requests', () => {
  const launcher = functionRange(
    'async function startBindingsWithGroups(',
    'async function startSelectedBindings(',
  )
  assert.match(
    launcher,
    /runPreparedBindingStarts\(preparedItems, \(prepared\) => \{\s*operations\.throwIfStopping\(\);\s*return operations\.executePreparedBindingStart\(prepared\);\s*\}/,
  )
})

test('controller separates binding preparation from non-interactive execution', () => {
  const prepare = functionRange(
    'async function prepareBindingStart(',
    'async function executePreparedReadyBindingStart(',
  )
  assert.match(prepare, /const pending = bindingNeedsInitialStart\(binding\)/)
  assert.match(prepare, /operations\.setBindingStatus\(binding, pending \? 'bind' : 'start', 'starting'\)/)
  assert.match(prepare, /operations\.resolveInitializedGroup/)
  assert.match(prepare, /operations\.resolveGroup/)
  assert.match(prepare, /resolve\(groups, binding\)/)
  assert.match(prepare, /operations\.validateSavedRuntime\(binding\)/)
  assert.match(prepare, /operations\.prepareFeishuProcess\([\s\S]*?activeBinding,[\s\S]*?mode,[\s\S]*?runtimeAgentType,[\s\S]*?options\.profileProbes/)
  assert.doesNotMatch(prepare, /startPreparedFeishuUntilReady|runCapture|updateBinding/)
})

test('pending execution persists exactly once only after pairing and runtime validation', () => {
  const execute = functionRange(
    'async function executePreparedPendingBindingStart(',
    'async function executePreparedBindingStart(',
  )
  const started = execute.indexOf('startPreparedFeishuUntilReady')
  const runtimeRead = execute.indexOf('readInitialRuntimeMetadata')
  const validated = execute.indexOf('validateSavedRuntime')
  const persisted = execute.indexOf('updateBinding')
  const runningStatus = execute.indexOf("setBindingStatus(binding, 'start', 'running')")
  for (const [name, index] of Object.entries({ started, runtimeRead, validated, persisted, runningStatus })) {
    assert.notEqual(index, -1, `pending execution must call ${name}`)
  }
  assert.ok(started < runtimeRead && runtimeRead < validated && validated < persisted && persisted < runningStatus)
  assert.equal(execute.match(/updateBinding\(/g)?.length, 1)
  assert.match(execute, /catch \(error\) \{\s*if \(feishu\) await operations\.stopManagedProcess\(feishu\)/)
})

test('ready execution stops its Feishu process when the running status write fails', () => {
  const execute = functionRange(
    'async function executePreparedReadyBindingStart(',
    'async function executePreparedPendingBindingStart(',
  )
  assert.match(execute, /let feishu;\s*try \{/)
  const started = execute.indexOf('startPreparedFeishuUntilReady')
  const runningStatus = execute.indexOf("setBindingStatus(binding, 'start', 'running')")
  assert.notEqual(started, -1, 'ready execution must start the prepared process')
  assert.notEqual(runningStatus, -1, 'ready execution must write running status')
  assert.ok(started < runningStatus)
  assert.match(execute, /catch \(error\) \{\s*if \(feishu\) await operations\.stopManagedProcess\(feishu\)/)
  assert.match(execute, /operations\.printBindingStarted\(binding, runtimeAgentType\)/)
  assert.match(source, /printBindingStarted: \(\) => \{\}/)
})

test('prepared startup dispatch and both callers use the shared launcher', () => {
  const dispatch = functionRange(
    'async function executePreparedBindingStart(',
    'async function startSelectedBindings(bindings, existingGroups)',
  )
  assert.match(dispatch, /if \(!prepared\.pending\) return executePreparedReadyBindingStart\(prepared, operations\)/)
  assert.match(dispatch, /runPairingSerially\(pairingQueueKey\(prepared\)/)
  assert.match(dispatch, /executePreparedPendingBindingStart\(prepared, operations\)/)

  const start = functionRange(
    'async function startSelectedBindings(bindings, existingGroups)',
    'async function markRuntimeFailed(binding, reason, component)',
  )
  assert.match(start, /orchestrateStartupBindings\(bindings, existingGroups\)/)
  assert.match(start, /dispatchStartupResult\(result/)
  assert.doesNotMatch(start, /updateBinding|Promise\.all/)

  const install = functionRange(
    'async function runBindingSession(mode)',
    'async function runInstall()',
  )
  assert.match(install, /startBindingsWithGroups\(acceptedBindings, groups, mode\)/)
  assert.match(install, /selectedBindings/)
  assert.doesNotMatch(install, /updateBinding|Promise\.all/)
})

test('add returns before process preparation while install retains its current status phase', () => {
  const session = functionRange(
    'async function runBindingSession(mode)',
    'async function runInstall()',
  )
  const addStart = session.indexOf("if (mode === 'add')")
  const installStart = session.indexOf("console.log('\\n=== \u5efa\u7acb\u7ed1\u5b9a\u5e76\u542f\u52a8 ===')")
  assert.notEqual(addStart, -1)
  assert.notEqual(installStart, -1)
  assert.ok(addStart < installStart, 'add must return before install process setup')
  assert.doesNotMatch(session.slice(addStart, installStart), /prepareBindingStart|executePreparedBindingStart|setupAgentGroups/)

  const pendingExecute = functionRange(
    'async function executePreparedPendingBindingStart(',
    'async function executePreparedBindingStart(',
  )
  assert.match(pendingExecute, /mode === 'install' \? 'feishu-install-bind' : 'feishu-add-bind'/)
  assert.match(pendingExecute, /setBindingStatus\(binding, 'start', 'running'\)/)
})

test('pending execution runs pairing through one promotion and running status in order', async () => {
  const execute = requireExecutor('executePreparedPendingBindingStart')
  const prepared = preparedStart(true)
  const harness = lifecycleHarness()

  const result = await execute(prepared, harness.operations)

  assert.deepEqual(harness.calls, ['pair', 'start', 'read', 'validate', 'update', 'status'])
  assert.deepEqual(harness.updated, [prepared.binding])
  assert.deepEqual(harness.statuses, [[prepared.binding, 'start', 'running']])
  assert.deepEqual(harness.stopped, [])
  assert.equal(prepared.binding.runtime, harness.runtime)
  assert.deepEqual(result, {
    binding: prepared.binding,
    process: harness.processRecord,
    group: prepared.group,
    runtimeAgentType: 'codex',
  })
})

test('pending pairing serializes by stable binding key while other keys and ready starts overlap', async () => {
  const execute = requireExecutor('executePreparedBindingStart')
  const first = preparedStart(true)
  first.binding.binding_id = 'pending-first'
  first.originalBinding.binding_id = 'pending-first'
  first.runtimeAgentType = 'traex'
  first.preparedFeishu.binding = first.binding

  const second = structuredClone(first)
  second.binding.binding_id = 'pending-second'
  second.originalBinding.binding_id = 'pending-second'
  second.runtimeAgentType = 'cursor'
  second.preparedFeishu.binding = second.binding

  const otherKey = structuredClone(first)
  otherKey.binding.binding_id = 'pending-other-key'
  otherKey.originalBinding.binding_id = 'pending-other-key'
  otherKey.binding.agent_type = 'workbuddy'
  otherKey.originalBinding.agent_type = 'workbuddy'
  otherKey.runtimeAgentType = 'workbuddy'
  otherKey.preparedFeishu.binding = otherKey.binding

  const ready = preparedStart(false)
  ready.binding.binding_id = 'ready-bypass'
  ready.originalBinding.binding_id = 'ready-bypass'
  ready.preparedFeishu.binding = ready.binding

  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const events = []
  const pairCounts = new Map()
  const operations = {
    runCapture: async (_packageSpec, _executable, args) => {
      const agent = args[2]
      pairCounts.set(agent, (pairCounts.get(agent) || 0) + 1)
      events.push(`pair:${agent}:${pairCounts.get(agent)}`)
      return {
        stdout: JSON.stringify({
          connectUrl: 'aamp://connect',
          pairingFile: `/tmp/${agent}.json`,
          mailbox: 'codex@meshmail.ai',
        }),
      }
    },
    parseJsonDocument: JSON.parse,
    resolveConfiguredPendingPairingFile: async (_group, agentType) => `/tmp/${agentType}.json`,
    resolvePendingPairingFile: async (_group, _agentType, pairing) => pairing.pairingFile,
    startPreparedFeishuUntilReady: async (preparedFeishu) => {
      events.push(`start:${preparedFeishu.binding.binding_id}`)
      return { bindingId: preparedFeishu.binding.binding_id }
    },
    readInitialRuntimeMetadata: async (_binding, processRecord) => ({
      im_config_dir: `/tmp/${processRecord.bindingId}/im`,
      task_config_dir: `/tmp/${processRecord.bindingId}/task`,
      feishu_bridge_email: 'feishu@meshmail.ai',
    }),
    validateSavedRuntime: async () => {},
    updateBinding: async (binding) => {
      events.push(`update:${binding.binding_id}`)
      if (binding.binding_id === 'pending-first') await firstGate
    },
    setBindingStatus: async () => {},
    stopManagedProcess: async () => {},
    printBindingStarted: () => {},
    throwIfStopping: () => {},
  }

  const firstRun = execute(first, operations)
  await until(() => events.includes('update:pending-first'))
  const secondRun = execute(second, operations)
  const otherRun = execute(otherKey, operations)
  const readyRun = execute(ready, operations)
  await until(() => (
    events.includes('update:pending-other-key')
      && events.includes('start:ready-bypass')
  ))
  assert.deepEqual(events.filter((event) => event.startsWith('pair:codex')), ['pair:codex:1'])
  releaseFirst()
  await Promise.all([firstRun, secondRun, otherRun, readyRun])
  assert.deepEqual(events.filter((event) => event.startsWith('pair:codex')), [
    'pair:codex:1',
    'pair:codex:2',
  ])
})

test('same-key pending waiters do not consume slots needed by an independent fifth start', async () => {
  const schedule = requireExecutor('runPreparedBindingStarts')
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const entered = []
  const sameKey = ['a1', 'a2', 'a3', 'a4'].map((bindingId, index) => ({
    index,
    prepared: {
      pending: true,
      group: { host: 'https://meshmail.ai' },
      binding: { binding_id: bindingId, agent_type: 'codex' },
    },
  }))
  const independent = {
    index: 4,
    prepared: {
      pending: true,
      group: { host: 'https://other.example' },
      binding: { binding_id: 'b1', agent_type: 'workbuddy' },
    },
  }

  const execution = schedule([...sameKey, independent], async (prepared) => {
    entered.push(prepared.binding.binding_id)
    if (prepared.binding.binding_id === 'a1') await firstGate
    return prepared.binding.binding_id
  })
  await until(() => entered.includes('b1'))
  assert.deepEqual(entered, ['a1', 'b1'])
  releaseFirst()
  const outcomes = await execution
  assert.deepEqual(entered, ['a1', 'b1', 'a2', 'a3', 'a4'])
  assert.deepEqual(outcomes.map(({ value }) => value), ['a1', 'a2', 'a3', 'a4', 'b1'])
})

test('prepared binding scheduler caps actual concurrent executions at four', async () => {
  const schedule = requireExecutor('runPreparedBindingStarts')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let active = 0
  let peak = 0
  const entered = []
  const preparedItems = ['a', 'b', 'c', 'd', 'e'].map((bindingId, index) => ({
    index,
    prepared: {
      pending: false,
      group: { host: `https://${bindingId}.example` },
      binding: { binding_id: bindingId, agent_type: 'codex' },
    },
  }))

  const execution = schedule(preparedItems, async (prepared) => {
    active += 1
    peak = Math.max(peak, active)
    entered.push(prepared.binding.binding_id)
    await gate
    active -= 1
    return prepared.binding.binding_id
  })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['a', 'b', 'c', 'd'])
  assert.equal(peak, 4)
  release()
  const outcomes = await execution
  assert.deepEqual(outcomes.map(({ value }) => value), ['a', 'b', 'c', 'd', 'e'])
})

test('preparation checks stop before persisting starting status', async () => {
  const prepare = requireExecutor('prepareBindingStart')
  const binding = preparedStart(false).originalBinding
  const calls = []
  const stopError = new Error('stop requested')

  await assert.rejects(prepare(binding, new Map(), 'start', {
    setBindingStatus: async () => { calls.push('status') },
    throwIfStopping: () => {
      calls.push('stop')
      throw stopError
    },
    resolveGroup: () => { calls.push('resolve') },
    validateSavedRuntime: async () => { calls.push('validate') },
    prepareFeishuProcess: async () => { calls.push('prepare') },
    nowIso: () => '2026-08-13T00:02:00.000Z',
  }), (error) => error === stopError)

  assert.deepEqual(calls, ['stop'])
})

test('controller composition merges every startup source once and supervises only survivors', async () => {
  const orchestrate = requireExecutor('orchestrateStartupBindings')
  const dispatch = requireExecutor('dispatchStartupResult')
  const ids = ['validation', 'cancel', 'prepare', 'start', 'reconcile', 'alive']
  const bindings = ids.map((bindingId) => ({
    ...preparedStart(false).originalBinding,
    binding_id: bindingId,
    bot: {
      ...preparedStart(false).originalBinding.bot,
      app_id: `cli_${bindingId}`,
      display_name: bindingId,
    },
  }))
  const groups = new Map([['https://meshmail.ai', {
    host: 'https://meshmail.ai',
    runtimeAgentTypes: new Map([['codex', 'codex']]),
  }]])
  const events = []
  const statuses = []
  const errors = []
  let activePrepare = 0
  let peakPrepare = 0
  const launcherOperations = {
    throwIfStopping: () => {},
    bindingCancellationReason: (_groups, item) => (
      item.binding_id === 'cancel' ? '用户取消了 Agent 准备流程' : ''
    ),
    setBindingStatus: async (item, phase, status, reason) => {
      statuses.push([item.binding_id, phase, status, reason])
    },
    printBindingCancelled: () => {},
    prepareBindingStart: async (item) => {
      activePrepare += 1
      peakPrepare = Math.max(peakPrepare, activePrepare)
      events.push(`prepare:${item.binding_id}`)
      await new Promise((resolve) => setImmediate(resolve))
      activePrepare -= 1
      if (item.binding_id === 'prepare') throw new Error('profile unavailable')
      return {
        pending: false,
        originalBinding: item,
        binding: item,
        group: groups.get(item.aamp_host),
        runtimeAgentType: item.agent_type,
      }
    },
    executePreparedBindingStart: async (prepared) => {
      events.push(`start:${prepared.binding.binding_id}`)
      if (prepared.binding.binding_id === 'start') throw new Error('ready timeout')
      return {
        binding: prepared.binding,
        process: { exited: false },
        group: prepared.group,
        runtimeAgentType: prepared.runtimeAgentType,
      }
    },
    recordError: async (component, reason, item) => {
      errors.push([component, reason, item.binding_id])
    },
    reportBindingFailure: () => {},
    printBindingStarted: () => {},
  }
  const result = await orchestrate(bindings, undefined, {
    validateBinding: (item) => {
      if (item.binding_id === 'validation') throw new Error('Online only')
    },
    recordValidationFailure: async (item, error) => ({ binding: item, reason: error.message }),
    initializeAgentGroups: async (items) => {
      assert.deepEqual(items.map(({ binding_id }) => binding_id), ids.slice(1))
      return groups
    },
    startAgentGroups: async () => { events.push('agent:settled') },
    startBindingsWithGroups: (items, activeGroups, mode, options) => (
      controller.startBindingsWithGroups(items, activeGroups, mode, launcherOperations, options)
    ),
    reconcileOverlappedReadyBindings: async (_items, launched) => {
      for (const item of launched.cancelled) {
        await launcherOperations.setBindingStatus(item.binding, 'start', 'cancelled', item.reason)
      }
      for (const item of launched.failed) {
        await launcherOperations.setBindingStatus(item.binding, 'start', 'failed', item.reason)
        await launcherOperations.recordError('startup', item.reason, item.binding)
      }
      return {
        alive: launched.running,
        failed: launched.failed,
        cancelled: launched.cancelled,
      }
    },
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
    reconcileRetainedBindings: async (running) => {
      assert.deepEqual(running.map(({ binding: item }) => item.binding_id), ['reconcile', 'alive'])
      return {
        alive: running.filter(({ binding: item }) => item.binding_id === 'alive'),
        failed: running
          .filter(({ binding: item }) => item.binding_id === 'reconcile')
          .map(({ binding: item, runtimeAgentType }) => ({
            binding: item,
            reason: 'exited before supervision',
            runtimeAgentType,
          })),
      }
    },
  })

  assert.equal(peakPrepare, 1)
  assert.deepEqual(result.running.map(({ binding: item }) => item.binding_id), ['alive'])
  assert.deepEqual(result.failed.map(({ binding: item }) => item.binding_id), [
    'validation', 'prepare', 'start', 'reconcile',
  ])
  assert.deepEqual(result.cancelled.map(({ binding: item }) => item.binding_id), ['cancel'])
  assert.equal(new Set(result.failed.map(({ binding: item }) => item.binding_id)).size, 4)
  assert.equal(result.disposition, 'supervise')
  assert.deepEqual(statuses.filter(([, , status]) => status === 'failed').map(([id]) => id), [
    'prepare', 'start',
  ])
  assert.deepEqual(errors.map(([, , id]) => id), ['prepare', 'start'])

  const dispatched = []
  await dispatch(result, {
    supervise: async (running, activeGroups) => {
      dispatched.push(['supervise', running.map(({ binding: item }) => item.binding_id), activeGroups])
    },
    shutdown: async () => { dispatched.push(['shutdown']) },
    onlyCancelled: async () => { dispatched.push(['only-cancel']) },
    allFailed: async () => { dispatched.push(['all-failed']) },
  })
  assert.deepEqual(dispatched, [['supervise', ['alive'], groups]])

  for (const [input, expected] of [
    [{ running: [], failed: [], cancelled: [{ binding: bindings[1], reason: 'cancel' }] }, 'only-cancel'],
    [{ running: [], failed: [{ binding: bindings[2], reason: 'failed' }], cancelled: [] }, 'all-failed'],
  ]) {
    const decisions = []
    await dispatch({ groups, ...input }, {
      supervise: async () => { decisions.push('supervise') },
      shutdown: async () => { decisions.push('shutdown') },
      onlyCancelled: async () => { decisions.push('only-cancel') },
      allFailed: async () => { decisions.push('all-failed') },
    })
    assert.deepEqual(decisions, ['shutdown', expected])
  }
})

test('Feishu package warmup starts before Agent initialization without blocking startup', async () => {
  const orchestrate = requireExecutor('orchestrateStartupBindings')
  const binding = startupBinding('warmup-ready', 'codex')
  const group = {
    host: binding.aamp_host,
    runtimeAgentTypes: new Map([['codex', 'codex']]),
  }
  const groups = new Map([[group.host, group]])
  const events = []
  let releaseWarmup
  const warmup = new Promise((resolve) => { releaseWarmup = resolve })

  const result = await orchestrate([binding], undefined, {
    validateBinding: () => {},
    recordValidationFailure: async () => assert.fail('binding must be valid'),
    prewarmFeishuExecutable: () => {
      events.push('feishu:warmup')
      return warmup
    },
    initializeAgentGroups: async () => {
      events.push('agent:init')
      return groups
    },
    startAgentGroups: async () => { events.push('agent:start') },
    startBindingsWithGroups: async () => {
      events.push('feishu:start')
      return { running: [], failed: [], cancelled: [] }
    },
    reconcileOverlappedReadyBindings: async () => ({
      alive: [],
      failed: [],
      cancelled: [],
    }),
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
    reconcileRetainedBindings: async () => ({ alive: [], failed: [] }),
  })

  assert.deepEqual(events, [
    'feishu:warmup',
    'agent:init',
    'agent:start',
    'feishu:start',
  ])
  assert.equal(result.disposition, 'all-failed')
  releaseWarmup()
})

test('Feishu package warmup failure stays speculative and binding startup owns the result', async () => {
  const orchestrate = requireExecutor('orchestrateStartupBindings')
  const binding = startupBinding('warmup-retry', 'codex')
  const group = {
    host: binding.aamp_host,
    runtimeAgentTypes: new Map([['codex', 'codex']]),
  }
  const groups = new Map([[group.host, group]])
  const started = launchedBinding(binding, group)

  const result = await orchestrate([binding], undefined, {
    validateBinding: () => {},
    recordValidationFailure: async () => assert.fail('binding must be valid'),
    prewarmFeishuExecutable: () => Promise.reject(new Error('controlled warmup failure')),
    initializeAgentGroups: async () => groups,
    startAgentGroups: async () => {},
    startBindingsWithGroups: async () => ({
      running: [started],
      failed: [],
      cancelled: [],
    }),
    reconcileOverlappedReadyBindings: async () => ({
      alive: [started],
      failed: [],
      cancelled: [],
    }),
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
    reconcileRetainedBindings: async (running) => ({ alive: running, failed: [] }),
  })

  assert.deepEqual(result.running, [started])
  assert.deepEqual(result.failed, [])
  assert.equal(result.disposition, 'supervise')
})

test('ready profile probes stay serial, exclude pending bindings, and retain binding identity', async () => {
  const probeReadyBindingProfiles = requireExecutor('probeReadyBindingProfiles')
  const readyA = startupBinding('probe-ready-a', 'codex')
  const pending = startupBinding('probe-pending', 'workbuddy', 'pending')
  const readyB = startupBinding('probe-ready-b', 'cursor')
  const calls = []
  let active = 0
  let peak = 0

  const probes = await probeReadyBindingProfiles([readyA, pending, readyB], {
    throwIfStopping: () => {},
    probeBindingProfile: async (binding) => {
      calls.push(binding.binding_id)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      if (binding === readyB) throw new Error('controlled probe miss')
      return {
        ready: true,
        lark_cli_bin: '/tmp/lark-cli',
        lark_cli_config_dir: '/tmp/lark-config',
      }
    },
  })

  assert.deepEqual(calls, ['probe-ready-a', 'probe-ready-b'])
  assert.equal(peak, 1)
  assert.equal(probes.get(readyA)?.lark_cli_bin, '/tmp/lark-cli')
  assert.equal(probes.has(structuredClone(readyA)), false, 'probe result must match the exact binding')
  assert.equal(probes.has(pending), false)
  assert.equal(probes.has(readyB), false, 'probe rejection must fall back later')
})

test('ready profile probing overlaps Agent initialization and is passed only to overlapped startup', async () => {
  const orchestrate = requireExecutor('orchestrateStartupBindings')
  const ready = startupBinding('probe-overlap-ready', 'codex')
  const pending = startupBinding('probe-overlap-pending', 'codex', 'pending')
  const profileProbes = new Map([[ready, { ready: true, lark_cli_bin: '/tmp/lark-cli' }]])
  const group = { host: ready.aamp_host, runtimeAgentTypes: new Map([['codex', 'codex']]) }
  const groups = new Map([[group.host, group]])
  const events = []
  let releaseInit
  let releaseProbe
  const initGate = new Promise((resolve) => { releaseInit = resolve })
  const probeGate = new Promise((resolve) => { releaseProbe = resolve })
  let settled = false

  const execution = orchestrate([ready, pending], undefined, {
    validateBinding: () => {},
    recordValidationFailure: async () => assert.fail('bindings must be valid'),
    prewarmFeishuExecutable: () => Promise.resolve(),
    initializeAgentGroups: async () => {
      events.push('agent:init')
      await initGate
      events.push('agent:initialized')
      return groups
    },
    probeReadyBindingProfiles: async (bindings) => {
      events.push(`profiles:probe:${bindings.map(({ binding_id }) => binding_id).join(',')}`)
      await probeGate
      events.push('profiles:probed')
      return profileProbes
    },
    startAgentGroups: async () => { events.push('agent:start') },
    startBindingsWithGroups: async (bindings, _groups, _mode, options) => {
      if (options?.allowAgentStarting) {
        assert.equal(options.profileProbes, profileProbes)
        events.push(`ready:start:${bindings.map(({ binding_id }) => binding_id).join(',')}`)
      } else {
        assert.equal(options, undefined)
        events.push(`pending:start:${bindings.map(({ binding_id }) => binding_id).join(',')}`)
      }
      return { running: [], failed: [], cancelled: [] }
    },
    reconcileOverlappedReadyBindings: async () => ({ alive: [], failed: [], cancelled: [] }),
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
    reconcileRetainedBindings: async () => ({ alive: [], failed: [] }),
  }).finally(() => { settled = true })

  await until(() => events.includes('agent:init') && events.some((event) => event.startsWith('profiles:probe:')))
  assert.equal(settled, false)
  assert.deepEqual(events.slice(0, 2).sort(), [
    'agent:init',
    'profiles:probe:probe-overlap-ready,probe-overlap-pending',
  ])
  releaseProbe()
  await until(() => events.includes('profiles:probed'))
  assert.equal(events.includes('agent:start'), false, 'startup must still await Agent initialization')
  releaseInit()
  await execution
  assert.deepEqual(events.slice(-4), [
    'agent:initialized',
    'agent:start',
    'ready:start:probe-overlap-ready',
    'pending:start:probe-overlap-pending',
  ])
})

test('probe miss or rejection falls back to authoritative profile ensure while a matching hit is reused', async () => {
  const probeReadyBindingProfiles = requireExecutor('probeReadyBindingProfiles')
  const prepareFeishuProcess = requireExecutor('prepareFeishuProcess')
  const hit = startupBinding('probe-hit', 'codex')
  const wrongConfig = startupBinding('probe-wrong-config', 'traex')
  const miss = startupBinding('probe-miss', 'cursor')
  const rejected = startupBinding('probe-rejected', 'workbuddy')
  const ensured = []
  const hitProfile = {
    ready: true,
    lark_cli_bin: '/tmp/probed-lark-cli',
    lark_cli_config_dir: '/tmp/lark-config',
  }
  const probes = await probeReadyBindingProfiles([hit, wrongConfig, miss, rejected], {
    throwIfStopping: () => {},
    probeBindingProfile: async (binding) => {
      if (binding === hit) return hitProfile
      if (binding === wrongConfig) return {
        ...hitProfile,
        lark_cli_config_dir: '/tmp/other-lark-config',
      }
      if (binding === miss) return { ready: false }
      throw new Error('controlled probe rejection')
    },
  })
  const operations = {
    throwIfStopping: () => {},
    writeFeishuRuntimeProfile: async () => {},
    ensureBindingProfile: async (binding) => {
      ensured.push(binding.binding_id)
      return { lark_cli_bin: `/tmp/ensured-${binding.binding_id}` }
    },
    resolveFeishuExecutable: async () => ({ executable: 'aamp-feishu-bridge' }),
    onlineEnvironment: () => ({ LARKSUITE_CLI_CONFIG_DIR: '/tmp/lark-config' }),
  }

  const preparedHit = await prepareFeishuProcess(hit, 'start', 'codex', probes, operations)
  const preparedWrongConfig = await prepareFeishuProcess(
    wrongConfig,
    'start',
    'traex',
    probes,
    operations,
  )
  const preparedMiss = await prepareFeishuProcess(miss, 'start', 'cursor', probes, operations)
  const preparedRejected = await prepareFeishuProcess(rejected, 'start', 'workbuddy', probes, operations)

  assert.equal(preparedHit.larkCliBin, '/tmp/probed-lark-cli')
  assert.equal(preparedWrongConfig.larkCliBin, '/tmp/ensured-probe-wrong-config')
  assert.equal(preparedMiss.larkCliBin, '/tmp/ensured-probe-miss')
  assert.equal(preparedRejected.larkCliBin, '/tmp/ensured-probe-rejected')
  assert.deepEqual(ensured, ['probe-wrong-config', 'probe-miss', 'probe-rejected'])
})

test('remote bindings never probe or ensure legacy local lark-cli profiles', async () => {
  const probeReadyBindingProfiles = requireExecutor('probeReadyBindingProfiles')
  const prepareFeishuProcess = requireExecutor('prepareFeishuProcess')
  const remote = startupBinding('remote-aime', 'aime')
  remote.bot.lark_cli_profile = 'aime-legacy-profile'
  let probeCalls = 0
  let ensureCalls = 0

  const probes = await probeReadyBindingProfiles([remote], {
    throwIfStopping: () => {},
    probeBindingProfile: async () => {
      probeCalls += 1
      throw new Error('remote binding must not inspect a legacy profile')
    },
  })
  const prepared = await prepareFeishuProcess(remote, 'start', 'aime', probes, {
    throwIfStopping: () => {},
    writeFeishuRuntimeProfile: async () => {},
    ensureBindingProfile: async () => {
      ensureCalls += 1
      throw new Error('remote binding must not ensure a local profile')
    },
    resolveFeishuExecutable: async () => ({ executable: 'aamp-feishu-bridge' }),
    onlineEnvironment: () => ({ LARKSUITE_CLI_CONFIG_DIR: '/tmp/lark-config' }),
  })

  assert.equal(probeCalls, 0)
  assert.equal(ensureCalls, 0)
  assert.equal(prepared.larkCliBin, undefined)
})

test('remote startup orchestration preserves a retained legacy AIME profile without local operations', async () => {
  const orchestrate = requireExecutor('orchestrateStartupBindings')
  const probeReadyBindingProfiles = requireExecutor('probeReadyBindingProfiles')
  const prepareFeishuProcess = requireExecutor('prepareFeishuProcess')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-startup-profile-'))
  const profileFile = path.join(root, 'lark-config', 'profiles', 'aime-legacy-profile.json')
  const sentinel = Buffer.from('{"legacy":"remote-startup-profile"}\n')
  const binding = startupBinding('remote-startup', 'aime')
  binding.bot.lark_cli_profile = 'aime-legacy-profile'
  mkdirSync(path.dirname(profileFile), { recursive: true })
  writeFileSync(profileFile, sentinel, { mode: 0o640 })
  chmodSync(profileFile, 0o640)
  const mode = statSync(profileFile).mode & 0o777
  const calls = []
  const groups = new Map([[binding.aamp_host, {
    host: binding.aamp_host,
    runtimeAgentTypes: new Map([['aime', 'aime']]),
  }]])

  const result = await orchestrate([binding], undefined, {
    validateBinding: (candidate) => {
      calls.push('validate')
      assert.equal(candidate.bot.lark_cli_profile, 'aime-legacy-profile')
    },
    recordValidationFailure: async () => assert.fail('remote binding must pass validation'),
    prewarmFeishuExecutable: () => {
      calls.push('prewarm')
      return Promise.resolve()
    },
    initializeAgentGroups: async () => {
      calls.push('initialize')
      return groups
    },
    probeReadyBindingProfiles: async (bindings) => {
      calls.push('probe-stage')
      return probeReadyBindingProfiles(bindings, {
        throwIfStopping: () => {},
        probeBindingProfile: async () => {
          calls.push('probe-local-profile')
          throw new Error('remote binding must not probe a local profile')
        },
      })
    },
    startAgentGroups: async () => { calls.push('start-agent') },
    startBindingsWithGroups: async (bindings, _groups, _mode, options) => {
      calls.push('start-feishu')
      assert.equal(options?.allowAgentStarting, true)
      const prepared = await prepareFeishuProcess(bindings[0], 'start', 'aime', options.profileProbes, {
        throwIfStopping: () => {},
        writeFeishuRuntimeProfile: async () => { calls.push('write-runtime-profile') },
        ensureBindingProfile: async () => {
          calls.push('ensure-local-profile')
          throw new Error('remote binding must not ensure a local profile')
        },
        resolveFeishuExecutable: async () => ({ executable: 'aamp-feishu-bridge' }),
        onlineEnvironment: () => ({ LARKSUITE_CLI_CONFIG_DIR: path.dirname(path.dirname(profileFile)) }),
      })
      assert.equal(prepared.larkCliBin, undefined)
      return { running: [{ binding: bindings[0], runtimeAgentType: 'aime' }], failed: [], cancelled: [] }
    },
    reconcileOverlappedReadyBindings: async (_bindings, launched) => ({ alive: launched.running, failed: [], cancelled: [] }),
    stopRunningBindings: async () => assert.fail('remote startup must not fail'),
    throwIfStopping: () => {},
    reconcileRetainedBindings: async (running) => ({ alive: running, failed: [] }),
  })

  assert.deepEqual(result.running.map(({ binding: item }) => item.binding_id), [binding.binding_id])
  assert.deepEqual(calls, [
    'validate', 'prewarm', 'initialize', 'probe-stage', 'start-agent',
    'start-feishu', 'write-runtime-profile',
  ])
  assert.deepEqual(readFileSync(profileFile), sentinel)
  assert.equal(statSync(profileFile).mode & 0o777, mode)
})

test('ready execution starts before status and retains the process', async () => {
  const execute = requireExecutor('executePreparedReadyBindingStart')
  const prepared = preparedStart(false)
  const harness = lifecycleHarness()

  const result = await execute(prepared, harness.operations)

  assert.deepEqual(harness.calls, ['start', 'status', 'print'])
  assert.deepEqual(harness.statuses, [[prepared.binding, 'start', 'running']])
  assert.deepEqual(harness.updated, [])
  assert.deepEqual(harness.stopped, [])
  assert.equal(result.process, harness.processRecord)
})

test('pending update failure stops once and preserves the original error', async () => {
  const execute = requireExecutor('executePreparedPendingBindingStart')
  const prepared = preparedStart(true)
  const harness = lifecycleHarness('update')

  await assert.rejects(execute(prepared, harness.operations), (error) => {
    assert.equal(error, harness.failure)
    return true
  })

  assert.deepEqual(harness.calls, ['pair', 'start', 'read', 'validate', 'update', 'stop'])
  assert.deepEqual(harness.updated, [prepared.binding])
  assert.deepEqual(harness.statuses, [])
  assert.deepEqual(harness.stopped, [harness.processRecord])
})

test('pending status failure stops once and preserves the original error', async () => {
  const execute = requireExecutor('executePreparedPendingBindingStart')
  const prepared = preparedStart(true)
  const harness = lifecycleHarness('status')

  await assert.rejects(execute(prepared, harness.operations), (error) => {
    assert.equal(error, harness.failure)
    return true
  })

  assert.deepEqual(harness.calls, ['pair', 'start', 'read', 'validate', 'update', 'status', 'stop'])
  assert.deepEqual(harness.updated, [prepared.binding])
  assert.deepEqual(harness.stopped, [harness.processRecord])
})

test('pending validation failure stops without persistence or status', async () => {
  const execute = requireExecutor('executePreparedPendingBindingStart')
  const prepared = preparedStart(true)
  const harness = lifecycleHarness('validate')

  await assert.rejects(execute(prepared, harness.operations), (error) => {
    assert.equal(error, harness.failure)
    return true
  })

  assert.deepEqual(harness.calls, ['pair', 'start', 'read', 'validate', 'stop'])
  assert.deepEqual(harness.updated, [])
  assert.deepEqual(harness.statuses, [])
  assert.deepEqual(harness.stopped, [harness.processRecord])
})

test('ready status failure stops once and preserves the original error', async () => {
  const execute = requireExecutor('executePreparedReadyBindingStart')
  const prepared = preparedStart(false)
  const harness = lifecycleHarness('status')

  await assert.rejects(execute(prepared, harness.operations), (error) => {
    assert.equal(error, harness.failure)
    return true
  })

  assert.deepEqual(harness.calls, ['start', 'status', 'stop'])
  assert.deepEqual(harness.stopped, [harness.processRecord])
})

function startupBinding(bindingId, agentType, state = 'ready') {
  const binding = structuredClone(preparedStart(state === 'pending').originalBinding)
  binding.binding_id = bindingId
  binding.agent_type = agentType
  binding.bot.app_id = `cli_${bindingId}`
  binding.bot.display_name = bindingId
  return binding
}

function launchedBinding(binding, group, processRecord = { exited: false }) {
  return {
    binding,
    group,
    process: processRecord,
    runtimeAgentType: binding.agent_type,
  }
}

test('ready Feishu preparation and process start overlap unresolved Agent startup after init', async () => {
  const runOverlappedStartup = requireExecutor('runOverlappedStartup')
  const bindings = [
    startupBinding('ready-slow', 'codex'),
    startupBinding('pending', 'workbuddy', 'pending'),
    startupBinding('ready-fast', 'cursor'),
  ]
  const group = { host: 'https://meshmail.ai' }
  const groups = new Map([[group.host, group]])
  const events = ['init:done']
  let releaseAgentStart
  const agentStartGate = new Promise((resolve) => { releaseAgentStart = resolve })
  let settled = false

  const execution = runOverlappedStartup(bindings, groups, {
    startAgentGroups: async () => {
      events.push('agent:start')
      await agentStartGate
      events.push('agent:running')
    },
    startBindingsWithGroups: async (items, activeGroups, mode, options) => {
      assert.equal(activeGroups, groups)
      assert.equal(mode, 'start')
      if (options?.allowAgentStarting) {
        events.push(`ready:prepare:${items.map(({ binding_id }) => binding_id).join(',')}`)
        events.push('ready:process')
        return {
          running: [
            launchedBinding(items[1], group),
            launchedBinding(items[0], group),
          ],
          failed: [],
          cancelled: [],
        }
      }
      events.push(`pending:start:${items.map(({ binding_id }) => binding_id).join(',')}`)
      return {
        running: [launchedBinding(items[0], group)],
        failed: [],
        cancelled: [],
      }
    },
    reconcileOverlappedReadyBindings: async (_items, launched) => {
      events.push('ready:reconcile')
      return { alive: launched.running, failed: [], cancelled: [] }
    },
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
  }).finally(() => { settled = true })

  await until(() => events.includes('ready:process'))
  assert.equal(settled, false, 'summary must wait for Agent startup')
  assert.equal(events.includes('ready:reconcile'), false)
  assert.equal(events.some((event) => event.startsWith('pending:start:')), false)
  assert.ok(events.indexOf('init:done') < events.indexOf('ready:prepare:ready-slow,ready-fast'))
  assert.equal(events.includes('agent:running'), false)

  releaseAgentStart()
  const result = await execution
  assert.deepEqual(events, [
    'init:done',
    'agent:start',
    'ready:prepare:ready-slow,ready-fast',
    'ready:process',
    'agent:running',
    'ready:reconcile',
    'pending:start:pending',
  ])
  assert.deepEqual(result.running.map(({ binding }) => binding.binding_id), [
    'ready-slow',
    'pending',
    'ready-fast',
  ])
})

test('Feishu failure does not interrupt Agent settlement or unrelated ready starts', async () => {
  const runOverlappedStartup = requireExecutor('runOverlappedStartup')
  const bindings = [
    startupBinding('ready-ok', 'codex'),
    startupBinding('ready-failed', 'cursor'),
  ]
  const group = { host: 'https://meshmail.ai' }
  const groups = new Map([[group.host, group]])
  const events = []
  let releaseAgentStart
  const agentStartGate = new Promise((resolve) => { releaseAgentStart = resolve })

  const execution = runOverlappedStartup(bindings, groups, {
    startAgentGroups: async () => {
      events.push('agent:start')
      await agentStartGate
      events.push('agent:settled')
    },
    startBindingsWithGroups: async (items) => {
      events.push('feishu:all-attempted')
      return {
        running: [launchedBinding(items[0], group)],
        failed: [{ binding: items[1], reason: 'Feishu ready timeout', runtimeAgentType: 'cursor' }],
        cancelled: [],
      }
    },
    reconcileOverlappedReadyBindings: async (_items, launched) => {
      assert.deepEqual(launched.failed.map(({ binding }) => binding.binding_id), ['ready-failed'])
      events.push('feishu:reported')
      return {
        alive: launched.running,
        failed: launched.failed,
        cancelled: launched.cancelled,
      }
    },
    stopRunningBindings: async () => {},
    throwIfStopping: () => {},
  })

  await until(() => events.includes('feishu:all-attempted'))
  assert.deepEqual(events, ['agent:start', 'feishu:all-attempted'])
  releaseAgentStart()
  const result = await execution
  assert.deepEqual(events, [
    'agent:start',
    'feishu:all-attempted',
    'agent:settled',
    'feishu:reported',
  ])
  assert.deepEqual(result.running.map(({ binding }) => binding.binding_id), ['ready-ok'])
  assert.deepEqual(result.failed.map(({ binding }) => binding.binding_id), ['ready-failed'])
})

test('concurrent Agent and ready Feishu failures commit only the stable Agent failure', async () => {
  const reconcile = requireExecutor('reconcileOverlappedReadyBindings')
  const binding = startupBinding('both-failed', 'codex')
  const group = {
    host: 'https://meshmail.ai',
    process: undefined,
    availableAgents: new Set(),
    failures: new Map([['codex', 'Codex Agent failed to start']]),
    cancellations: new Map(),
  }
  const statuses = []
  const errors = []
  const reports = []

  const result = await reconcile(
    [binding],
    {
      running: [],
      failed: [{ binding, reason: 'Feishu ready timeout', runtimeAgentType: 'codex' }],
      cancelled: [],
    },
    new Map([[group.host, group]]),
    {
      throwIfStopping: () => {},
      stopManagedProcess: async () => assert.fail('a failed Feishu launch has no process to stop'),
      setBindingStatus: async (item, phase, status, reason) => {
        statuses.push([item.binding_id, phase, status, reason])
      },
      recordError: async (component, reason, item) => {
        errors.push([component, reason, item.binding_id])
      },
      reportBindingFailure: (_item, _agentType, reason) => { reports.push(reason) },
      printBindingCancelled: () => assert.fail('Agent failure must not be reported as cancellation'),
      printBindingStarted: () => assert.fail('failed binding must not be reported running'),
    },
  )

  assert.deepEqual(result.alive, [])
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(result.failed, [{
    binding,
    reason: 'Codex Agent failed to start',
    runtimeAgentType: 'codex',
  }])
  assert.deepEqual(statuses, [[
    'both-failed',
    'start',
    'failed',
    'Codex Agent failed to start',
  ]])
  assert.deepEqual(errors, [['startup', 'Codex Agent failed to start', 'both-failed']])
  assert.deepEqual(reports, ['Codex Agent failed to start'])
})

test('branch rejection waits the sibling branch, stops early Feishu, and launches no pending work', async () => {
  const runOverlappedStartup = requireExecutor('runOverlappedStartup')
  const bindings = [
    startupBinding('ready', 'codex'),
    startupBinding('pending', 'codex', 'pending'),
  ]
  const group = { host: 'https://meshmail.ai' }
  const groups = new Map([[group.host, group]])
  const stopError = new Error('SIGTERM requested')
  const early = launchedBinding(bindings[0], group)
  const stopped = []
  let releaseReady
  const readyGate = new Promise((resolve) => { releaseReady = resolve })
  let settled = false
  let pendingStarted = false

  const execution = runOverlappedStartup(bindings, groups, {
    startAgentGroups: async () => { throw stopError },
    startBindingsWithGroups: async (items, _groups, _mode, options) => {
      if (!options?.allowAgentStarting) {
        pendingStarted = true
        return { running: [], failed: [], cancelled: [] }
      }
      await readyGate
      assert.deepEqual(items, [bindings[0]])
      return { running: [early], failed: [], cancelled: [] }
    },
    reconcileOverlappedReadyBindings: async () => assert.fail('must not reconcile after stop'),
    stopRunningBindings: async (running) => { stopped.push(...running) },
    throwIfStopping: () => { throw stopError },
  }).finally(() => { settled = true })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'orchestration must drain the still-running Feishu branch')
  releaseReady()
  await assert.rejects(execution, (error) => error === stopError)
  assert.equal(pendingStarted, false)
  assert.deepEqual(stopped, [early])
})

test('Agent failure stops only its early Feishu and commits the available sibling exactly once', async () => {
  const reconcile = requireExecutor('reconcileOverlappedReadyBindings')
  const failedBinding = startupBinding('failed-agent', 'codex')
  const aliveBinding = startupBinding('alive-agent', 'cursor')
  const group = {
    host: 'https://meshmail.ai',
    process: { exited: false },
    availableAgents: new Set(['cursor']),
    failures: new Map([['codex', 'Codex Agent failed to start']]),
    cancellations: new Map(),
  }
  const failedProcess = { exited: false, name: 'failed-feishu' }
  const aliveProcess = { exited: false, name: 'alive-feishu' }
  const statuses = []
  const errors = []
  const stopped = []
  const printed = []

  const running = [
    launchedBinding(failedBinding, group, failedProcess),
    launchedBinding(aliveBinding, group, aliveProcess),
  ]
  const result = await reconcile([failedBinding, aliveBinding], {
    running,
    failed: [],
    cancelled: [],
  }, new Map([[group.host, group]]), {
    throwIfStopping: () => {},
    stopManagedProcess: async (record) => { stopped.push(record) },
    setBindingStatus: async (binding, phase, status, reason) => {
      statuses.push([binding.binding_id, phase, status, reason])
    },
    recordError: async (component, reason, binding) => {
      errors.push([component, reason, binding.binding_id])
    },
    reportBindingFailure: (binding) => { printed.push(`failed:${binding.binding_id}`) },
    printBindingCancelled: (binding) => { printed.push(`cancelled:${binding.binding_id}`) },
    printBindingStarted: (binding) => { printed.push(`running:${binding.binding_id}`) },
  })

  assert.deepEqual(result.alive.map(({ binding }) => binding.binding_id), ['alive-agent'])
  assert.deepEqual(result.failed.map(({ binding }) => binding.binding_id), ['failed-agent'])
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(stopped, [failedProcess])
  assert.deepEqual(statuses, [
    ['failed-agent', 'start', 'failed', 'Codex Agent failed to start'],
    ['alive-agent', 'start', 'running', undefined],
  ])
  assert.deepEqual(errors, [['startup', 'Codex Agent failed to start', 'failed-agent']])
  assert.deepEqual(printed, ['failed:failed-agent', 'running:alive-agent'])
})

test('whole-host Agent failure stops every early Feishu without a running status', async () => {
  const reconcile = requireExecutor('reconcileOverlappedReadyBindings')
  const bindings = [
    startupBinding('codex', 'codex'),
    startupBinding('cursor', 'cursor'),
  ]
  const group = {
    host: 'https://meshmail.ai',
    process: undefined,
    availableAgents: new Set(),
    failures: new Map([
      ['codex', 'ACP host startup failed'],
      ['cursor', 'ACP host startup failed'],
    ]),
    cancellations: new Map(),
  }
  const processes = [{ exited: false }, { exited: false }]
  const statuses = []
  const errors = []
  const stopped = []

  const running = bindings.map((binding, index) => (
    launchedBinding(binding, group, processes[index])
  ))
  const result = await reconcile(bindings, {
    running,
    failed: [],
    cancelled: [],
  }, new Map([[group.host, group]]), {
    throwIfStopping: () => {},
    stopManagedProcess: async (record) => { stopped.push(record) },
    setBindingStatus: async (binding, phase, status, reason) => {
      statuses.push([binding.binding_id, phase, status, reason])
    },
    recordError: async (component, reason, binding) => {
      errors.push([component, reason, binding.binding_id])
    },
    reportBindingFailure: () => {},
    printBindingCancelled: () => {},
    printBindingStarted: () => assert.fail('failed host must not report running'),
  })

  assert.deepEqual(result.alive, [])
  assert.deepEqual(result.failed.map(({ binding }) => binding.binding_id), ['codex', 'cursor'])
  assert.deepEqual(stopped, processes)
  assert.deepEqual(statuses.map(([id, , status]) => [id, status]), [
    ['codex', 'failed'],
    ['cursor', 'failed'],
  ])
  assert.equal(errors.length, 2)
})

test('early ready preparation uses initialized identity while pending still requires Agent availability', async () => {
  const prepare = requireExecutor('prepareBindingStart')
  const ready = startupBinding('ready', 'codex')
  const pending = startupBinding('pending', 'codex', 'pending')
  const calls = []
  const groupResult = {
    group: { host: 'https://meshmail.ai' },
    email: 'codex@meshmail.ai',
    runtimeAgentType: 'codex',
  }
  const operations = {
    setBindingStatus: async () => {},
    throwIfStopping: () => {},
    resolveGroup: () => {
      calls.push('available')
      return groupResult
    },
    resolveInitializedGroup: () => {
      calls.push('initialized')
      return groupResult
    },
    validateSavedRuntime: async () => {},
    prepareFeishuProcess: async (binding) => ({ binding }),
    nowIso: () => '2026-08-13T00:02:00.000Z',
  }

  const preparedReady = await prepare(ready, new Map(), 'start', operations, {
    allowAgentStarting: true,
    deferReadyCommit: true,
  })
  assert.deepEqual(calls, ['initialized'])
  assert.equal(preparedReady.deferReadyCommit, true)

  calls.length = 0
  await prepare(pending, new Map(), 'start', operations, {
    allowAgentStarting: true,
    deferReadyCommit: true,
  })
  assert.deepEqual(calls, ['available'])
})

test('deferred ready execution starts the process without emitting running state', async () => {
  const execute = requireExecutor('executePreparedReadyBindingStart')
  const prepared = { ...preparedStart(false), deferReadyCommit: true }
  const harness = lifecycleHarness()

  const result = await execute(prepared, harness.operations)

  assert.deepEqual(harness.calls, ['start'])
  assert.deepEqual(harness.statuses, [])
  assert.equal(result.process, harness.processRecord)
})
