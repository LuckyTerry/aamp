import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  createLaunchdServiceManager,
  parseLaunchctlPrint,
  renderLaunchAgentPlist,
} from '../bin/launchd-service.mjs'
import * as launchdService from '../bin/launchd-service.mjs'

test('launchd plist runs the installed bootstrap in service mode without shell dependencies', () => {
  const plist = renderLaunchAgentPlist({
    label: 'com.larktask.aamp-feishu-task-agent',
    bootstrapPath: '/Users/Test & Co/.aamp/bin/feishu-task-agent',
    home: '/Users/Test & Co',
    pathValue: '/opt/node/bin:/usr/bin:/bin',
    stdoutPath: '/Users/Test & Co/.aamp/logs/service.log',
    stderrPath: '/Users/Test & Co/.aamp/logs/service.log',
  })

  assert.match(plist, /<string>com\.larktask\.aamp-feishu-task-agent<\/string>/)
  assert.match(plist, /<string>\/Users\/Test &amp; Co\/\.aamp\/bin\/feishu-task-agent<\/string>/)
  assert.match(plist, /<string>__service-run<\/string>/)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.doesNotMatch(plist, /app_secret|token|password/i)
})

test('launchctl status parser distinguishes running, loaded, and stopped jobs', () => {
  assert.deepEqual(parseLaunchctlPrint('state = running\n\tpid = 4321\n'), {
    loaded: true,
    state: 'running',
    pid: 4321,
  })
  assert.deepEqual(parseLaunchctlPrint('state = waiting\n'), {
    loaded: true,
    state: 'waiting',
    pid: null,
  })
  assert.deepEqual(parseLaunchctlPrint('', 113), {
    loaded: false,
    state: 'stopped',
    pid: null,
  })
})

test('process identity reader returns a parseable start time and full command on macOS', async (context) => {
  if (process.platform !== 'darwin') return context.skip('macOS ps format')
  const identity = await launchdService.readProcessIdentity(process.pid)
  assert.ok(identity)
  assert.equal(Number.isFinite(Date.parse(identity.startedAt)), true)
  assert.match(identity.command, /node|launchd-service\.test\.mjs/)
})

test('launchd manager persists the selected bindings and starts a user service', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-start-'))
  const calls = []
  let loaded = false
  let manager
  const runLaunchctl = async (args) => {
    calls.push(args)
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: 'state = running\n\tpid = 2468\n', stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' }
    }
    if (args[0] === 'bootstrap') {
      loaded = true
      const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
      writeFileSync(manager.paths.readinessFile, JSON.stringify({
        version: 1,
        state: 'ready',
        generation: selection.generation,
        pid: 2468,
        binding_ids: selection.binding_ids,
      }))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/opt/node/bin:/usr/bin:/bin',
    runLaunchctl,
  })

  const result = await manager.start(['binding-a', 'binding-b'])

  assert.deepEqual(result, {
    loaded: true,
    state: 'running',
    pid: 2468,
    ready: true,
    alreadyRunning: false,
  })
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'bootstrap', 'print'])
  const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
  assert.equal(selection.version, 1)
  assert.match(selection.generation, /^[0-9a-f-]{36}$/)
  assert.deepEqual(selection.binding_ids, ['binding-a', 'binding-b'])
  assert.equal(statSync(manager.paths.selectionFile).mode & 0o777, 0o600)
  assert.equal(existsSync(manager.paths.plistFile), true)
  assert.equal(statSync(manager.paths.plistFile).mode & 0o777, 0o600)
})

test('launchd manager waits for a newly registered service to obtain a running pid', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-start-wait-'))
  let printCount = 0
  let manager
  const runLaunchctl = async (args) => {
    if (args[0] === 'print') {
      printCount += 1
      if (printCount === 1) return { code: 113, stdout: '', stderr: '' }
      if (printCount < 4) return { code: 0, stdout: 'state = waiting\n', stderr: '' }
      const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
      writeFileSync(manager.paths.readinessFile, JSON.stringify({
        version: 1,
        state: 'ready',
        generation: selection.generation,
        pid: 8642,
        binding_ids: selection.binding_ids,
      }))
      return { code: 0, stdout: 'state = running\n\tpid = 8642\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl,
    wait: async () => {},
  })

  const result = await manager.start(['binding-a'])

  assert.equal(result.state, 'running')
  assert.equal(result.pid, 8642)
  assert.equal(result.ready, true)
  assert.equal(printCount, 4)
})

test('launchd manager waits for the service worker readiness marker before reporting success', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-ready-wait-'))
  let loaded = false
  let waitCount = 0
  let manager
  const runLaunchctl = async (args) => {
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: 'state = running\n\tpid = 6420\n', stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootstrap') loaded = true
    return { code: 0, stdout: '', stderr: '' }
  }
  const wait = async () => {
    waitCount += 1
    const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
    writeFileSync(manager.paths.readinessFile, JSON.stringify({
      version: 1,
      state: 'ready',
      generation: selection.generation,
      pid: 6420,
      binding_ids: selection.binding_ids,
    }))
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl,
    wait,
    startupAttempts: 3,
  })

  const result = await manager.start(['binding-a'])

  assert.equal(waitCount, 1)
  assert.equal(result.state, 'running')
  assert.equal(result.pid, 6420)
  assert.equal(result.ready, true)
})

test('launchd manager fails instead of reporting success when bridge readiness never arrives', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-ready-timeout-'))
  let loaded = false
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async (args) => {
      if (args[0] === 'print') {
        return loaded
          ? { code: 0, stdout: 'state = running\n\tpid = 6421\n', stderr: '' }
          : { code: 113, stdout: '', stderr: '' }
      }
      if (args[0] === 'bootstrap') loaded = true
      return { code: 0, stdout: '', stderr: '' }
    },
    wait: async () => {},
    startupAttempts: 2,
  })

  await assert.rejects(manager.start(['binding-a']), /未进入运行状态.*logs/)
})

test('service worker readiness marker is generation-scoped and tied to its controller pid', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-ready-marker-'))
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => ({ code: 113, stdout: '', stderr: '' }),
  })
  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, JSON.stringify({
    version: 1,
    generation: 'generation-test',
    binding_ids: ['binding-a'],
  }))

  await manager.markReady(['binding-a'], 'generation-test')

  const readiness = JSON.parse(readFileSync(manager.paths.readinessFile, 'utf8'))
  assert.equal(readiness.state, 'ready')
  assert.equal(readiness.generation, 'generation-test')
  assert.equal(readiness.pid, process.pid)
  assert.deepEqual(readiness.binding_ids, ['binding-a'])
  assert.equal(statSync(manager.paths.readinessFile).mode & 0o777, 0o600)
})

test('an old service worker cannot publish readiness for a newer selection generation', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-ready-generation-race-'))
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => ({ code: 113, stdout: '', stderr: '' }),
  })
  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, JSON.stringify({
    version: 1,
    generation: 'new-generation',
    binding_ids: ['binding-new'],
  }))

  await assert.rejects(
    manager.markReady(['binding-old'], 'old-generation'),
    /启动代次已变化/,
  )
  assert.equal(existsSync(manager.paths.readinessFile), false)
})

test('launchd status rejects readiness for a different binding selection', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-ready-bindings-'))
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => ({
      code: 0,
      stdout: 'state = running\n\tpid = 2468\n',
      stderr: '',
    }),
  })
  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, JSON.stringify({
    version: 1,
    generation: 'generation-test',
    binding_ids: ['binding-new'],
  }))
  writeFileSync(manager.paths.readinessFile, JSON.stringify({
    version: 1,
    state: 'ready',
    generation: 'generation-test',
    pid: 2468,
    binding_ids: ['binding-old'],
  }))

  assert.deepEqual(await manager.status(), {
    loaded: true,
    state: 'starting',
    pid: 2468,
    ready: false,
  })
})

test('launchd status never reports ready without a valid selection snapshot', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-missing-selection-'))
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => ({
      code: 0,
      stdout: 'state = running\n\tpid = 9753\n',
      stderr: '',
    }),
  })

  assert.deepEqual(await manager.status(), {
    loaded: true,
    state: 'starting',
    pid: 9753,
    ready: false,
  })

  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, '{not-json')
  assert.equal((await manager.status()).ready, false)
})

test('launchd start repairs a running job whose selection snapshot is missing', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-repair-selection-'))
  const calls = []
  let manager
  const runLaunchctl = async (args) => {
    calls.push(args)
    if (args[0] === 'print') {
      return { code: 0, stdout: 'state = running\n\tpid = 9753\n', stderr: '' }
    }
    if (args[0] === 'kickstart') {
      const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
      writeFileSync(manager.paths.readinessFile, JSON.stringify({
        version: 1,
        state: 'ready',
        generation: selection.generation,
        pid: 9753,
        binding_ids: selection.binding_ids,
      }))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl,
    startupAttempts: 1,
  })

  assert.deepEqual(await manager.start(['binding-a']), {
    loaded: true,
    state: 'running',
    pid: 9753,
    ready: true,
    alreadyRunning: false,
  })
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'kickstart', 'print'])
})

test('launchd start replaces a stale in-flight selection before waiting for readiness', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-replace-selection-'))
  const calls = []
  let manager
  const runLaunchctl = async (args) => {
    calls.push(args)
    if (args[0] === 'print') {
      return { code: 0, stdout: 'state = running\n\tpid = 9754\n', stderr: '' }
    }
    if (args[0] === 'kickstart') {
      const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
      writeFileSync(manager.paths.readinessFile, JSON.stringify({
        version: 1,
        state: 'ready',
        generation: selection.generation,
        pid: 9754,
        binding_ids: selection.binding_ids,
      }))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl,
    startupAttempts: 1,
  })
  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, JSON.stringify({
    version: 1,
    generation: 'stale-generation',
    binding_ids: ['binding-removed', 'binding-kept'],
  }))

  const result = await manager.start(['binding-kept'])
  const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))

  assert.equal(result.ready, true)
  assert.notEqual(selection.generation, 'stale-generation')
  assert.deepEqual(selection.binding_ids, ['binding-kept'])
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'kickstart', 'print'])
})

test('launchd manager start is idempotent and stop unloads the service', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-stop-'))
  let loaded = true
  const calls = []
  const runLaunchctl = async (args) => {
    calls.push(args)
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: 'state = running\n\tpid = 9753\n', stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootout') loaded = false
    return { code: 0, stdout: '', stderr: '' }
  }
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    runLaunchctl,
  })
  mkdirSync(path.dirname(manager.paths.selectionFile), { recursive: true })
  writeFileSync(manager.paths.selectionFile, JSON.stringify({
    version: 1,
    generation: 'generation-current',
    binding_ids: ['binding-a'],
  }))
  writeFileSync(manager.paths.readinessFile, JSON.stringify({
    version: 1,
    state: 'ready',
    generation: 'generation-current',
    pid: 9753,
    binding_ids: ['binding-a'],
  }))

  assert.deepEqual(await manager.start(['binding-a']), {
    loaded: true,
    state: 'running',
    pid: 9753,
    ready: true,
    alreadyRunning: true,
  })
  assert.deepEqual(await manager.stop(), {
    stopped: true,
    wasLoaded: true,
  })
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'print', 'bootout', 'print'])
})

test('launchd manager waits for bootout to become observable before reporting stopped', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-stop-wait-'))
  let bootout = false
  let postBootoutPrints = 0
  const runLaunchctl = async (args) => {
    if (args[0] === 'bootout') {
      bootout = true
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'print') {
      if (!bootout) return { code: 0, stdout: 'state = running\n\tpid = 9753\n', stderr: '' }
      postBootoutPrints += 1
      if (postBootoutPrints < 3) return { code: 0, stdout: 'state = waiting\n', stderr: '' }
      return { code: 113, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl,
    wait: async () => {},
  })

  assert.deepEqual(await manager.stop(), { stopped: true, wasLoaded: true })
  assert.equal(postBootoutPrints, 3)
})

test('launchd manager rejects background mode outside macOS', async () => {
  const manager = createLaunchdServiceManager({
    home: '/tmp/aamp-linux',
    uid: 1000,
    platform: 'linux',
    bootstrapPath: '/tmp/aamp-linux/feishu-task-agent',
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => assert.fail('launchctl must not run outside macOS'),
  })

  await assert.rejects(manager.start([]), /仅支持 macOS/)
})

test('runtime owner discovery deduplicates controller leases and rejects unrelated live PIDs', async () => {
  assert.equal(typeof launchdService.findOwnedControllerPids, 'function')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-runtime-owners-'))
  const leasesHome = path.join(root, 'leases')
  const controllerPath = '/pkg/bin/feishu-task-agent-controller.mjs'
  const runtimeHome = path.join(root, 'runtime-v1')
  for (const [name, pid, createdAt] of [
    ['runtime-session.lock', 1234, '2026-09-04T08:00:10.000Z'],
    ['agent-first.lock', 1234, '2026-09-04T08:00:10.000Z'],
    ['agent-unrelated.lock', 5678, '2026-09-04T08:00:10.000Z'],
    ['agent-stale.lock', 9999, '2026-09-04T08:00:10.000Z'],
  ]) {
    const directory = path.join(leasesHome, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({
      pid,
      created_at: createdAt,
      controller_path: controllerPath,
      runtime_home: runtimeHome,
      process_started_at: '2026-09-04T08:00:00.000Z',
    }))
  }

  const pids = await launchdService.findOwnedControllerPids({
    leasesHome,
    expectedControllerPath: controllerPath,
    expectedRuntimeHome: runtimeHome,
    pidAlive: (pid) => pid !== 9999,
    readProcessCommand: async (pid) => pid === 1234
      ? `/opt/node ${controllerPath} __service-run`
      : `/opt/node /other/bin/feishu-task-agent-controller.mjs start`,
    readProcessIdentity: async (pid) => ({
      command: pid === 1234
        ? `/opt/node ${controllerPath} __service-run`
        : `/opt/node /other/bin/feishu-task-agent-controller.mjs start`,
      startedAt: pid === 1234
        ? '2026-09-04T08:00:00.000Z'
        : '2026-09-04T08:01:00.000Z',
    }),
  })

  assert.deepEqual(pids, [1234])
})

test('runtime owner discovery safely recognizes a legacy lease using exact path and process age', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-runtime-legacy-owner-'))
  const leasesHome = path.join(root, 'leases')
  const directory = path.join(leasesHome, 'runtime-session.lock')
  const controllerPath = '/pkg/bin/feishu-task-agent-controller.mjs'
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({
    pid: 2345,
    created_at: '2026-09-04T08:00:10.000Z',
  }))

  const pids = await launchdService.findOwnedControllerPids({
    leasesHome,
    expectedControllerPath: controllerPath,
    expectedRuntimeHome: path.join(root, 'runtime-v1'),
    pidAlive: () => true,
    readProcessIdentity: async () => ({
      command: `/opt/node ${controllerPath} start`,
      startedAt: '2026-09-04T08:00:00.000Z',
    }),
  })

  assert.deepEqual(pids, [2345])
})

test('runtime owner stop sends SIGTERM only to verified controller processes', async () => {
  assert.equal(typeof launchdService.stopOwnedControllerProcesses, 'function')
  const stopped = []
  const result = await launchdService.stopOwnedControllerProcesses({
    pids: [4321, 8765],
    signalProcess: (pid, signal) => stopped.push([pid, signal]),
    waitForExit: async () => true,
  })

  assert.deepEqual(stopped, [[4321, 'SIGTERM'], [8765, 'SIGTERM']])
  assert.deepEqual(result, { stopped: [4321, 8765], remaining: [] })
})

test('runtime owner stop revalidates process identity immediately before signaling', async () => {
  const signals = []
  const result = await launchdService.stopOwnedControllerProcesses({
    pids: [4321, 8765],
    validateProcess: async (pid) => pid === 4321,
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    waitForExit: async () => true,
  })

  assert.deepEqual(signals, [[4321, 'SIGTERM']])
  assert.deepEqual(result, { stopped: [4321], remaining: [8765] })
})

test('launchd manager restart preserves the saved binding selection', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-restart-'))
  let loaded = false
  let pid = 3000
  const calls = []
  let manager
  const runLaunchctl = async (args) => {
    calls.push(args)
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: `state = running\n\tpid = ${pid}\n`, stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootstrap') {
      loaded = true
      pid += 1
      const selection = JSON.parse(readFileSync(manager.paths.selectionFile, 'utf8'))
      writeFileSync(manager.paths.readinessFile, JSON.stringify({
        version: 1,
        state: 'ready',
        generation: selection.generation,
        pid,
        binding_ids: selection.binding_ids,
      }))
    }
    if (args[0] === 'bootout') loaded = false
    return { code: 0, stdout: '', stderr: '' }
  }
  manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    runLaunchctl,
  })

  assert.equal(typeof manager.restart, 'function')
  await manager.start(['binding-a', 'binding-b'])
  const restarted = await manager.restart()

  assert.equal(restarted.pid, 3002)
  assert.deepEqual(await manager.selection(), ['binding-a', 'binding-b'])
  assert.equal(calls.some((args) => args[0] === 'bootout'), true)
  assert.equal(calls.filter((args) => args[0] === 'bootstrap').length, 2)
})

test('launchd manager returns a bounded tail of its service log', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-launchd-logs-'))
  const manager = createLaunchdServiceManager({
    home,
    uid: 501,
    platform: 'darwin',
    bootstrapPath: path.join(home, '.aamp/bin/feishu-task-agent'),
    pathValue: '/usr/bin:/bin',
    runLaunchctl: async () => ({ code: 113, stdout: '', stderr: '' }),
  })
  mkdirSync(path.dirname(manager.paths.logFile), { recursive: true })
  writeFileSync(manager.paths.logFile, 'line-1\nline-2\nline-3\n')

  assert.equal(typeof manager.recentLogs, 'function')
  assert.equal(await manager.recentLogs(2), 'line-2\nline-3')
})
