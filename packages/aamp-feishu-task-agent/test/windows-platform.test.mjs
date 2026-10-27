import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  ensurePrivateWindowsDirectory,
  atomicReplaceWindows,
  getCurrentWindowsSid,
  openWindowsTerminal,
  readWindowsProcessIdentity,
  resolveNativeCommand,
  runWindowsPowerShell,
  snapshotOwnedWindowsTree,
  stopOwnedWindowsTree,
} from '../bin/windows-platform.mjs'

test('native identity can read a live image when CIM and MainModule have no path', {skip: process.platform !== 'win32'}, async () => {
  const {__test} = await import('../bin/windows-platform.mjs')
  const script = __test.powershellScripts['read-process-identity']
    .replaceAll('$snapshot.ExecutablePath', "''")
    .replace('[string]$native.MainModule.FileName', "''")
  const identity = await runWindowsPowerShell(script, {pid: process.pid})
  assert.equal(identity.executablePath.toLowerCase(), process.execPath.toLowerCase())
  assert.equal(identity.pid, process.pid)
})

test('atomic Windows replace retries shared-busy errors with the fixed bounded backoff', async () => {
  const calls = []
  const waits = []
  await atomicReplaceWindows('new.tmp', 'bindings.json', {
    platform: 'win32',
    rename: async (source, destination) => {
      calls.push([source, destination])
      if (calls.length <= 5) throw Object.assign(new Error('shared'), { code: 'EPERM' })
    },
    wait: async (milliseconds) => { waits.push(milliseconds) },
  })
  assert.deepEqual(calls, Array.from({ length: 6 }, () => ['new.tmp', 'bindings.json']))
  assert.deepEqual(waits, [100, 200, 400, 800, 1600])
})

test('atomic Windows replace preserves the old destination when all retries fail', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-replace-'))
  const temporary = path.join(root, 'bindings.tmp')
  const destination = path.join(root, 'bindings.json')
  await fsp.writeFile(temporary, '{"version":2}\n')
  await fsp.writeFile(destination, '{"version":1}\n')
  let attempts = 0
  try {
    await assert.rejects(atomicReplaceWindows(temporary, destination, {
      platform: 'win32',
      rename: async () => {
        attempts += 1
        throw Object.assign(new Error('still shared'), { code: 'EBUSY' })
      },
      wait: async () => {},
    }), /still shared/)
    assert.equal(attempts, 6)
    assert.equal(await fsp.readFile(destination, 'utf8'), '{"version":1}\n')
    assert.equal(await fsp.readFile(temporary, 'utf8'), '{"version":2}\n')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('atomic Windows replace does not retry an unrelated rename failure', async () => {
  const waits = []
  let attempts = 0
  await assert.rejects(atomicReplaceWindows('new.tmp', 'bindings.json', {
    platform: 'win32',
    rename: async () => {
      attempts += 1
      throw Object.assign(new Error('invalid destination'), { code: 'EINVAL' })
    },
    wait: async (milliseconds) => { waits.push(milliseconds) },
  }), /invalid destination/)
  assert.equal(attempts, 1)
  assert.deepEqual(waits, [])
})

test('PowerShell uses environment JSON input and decodes chunked UTF-8 CRLF output', async () => {
  const calls = []
  const result = await runWindowsPowerShell('fixed-script', { path: 'C:\\用户 & Co\\runtime' }, {
    environment: { SAFE: '1' },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options })
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        const encoded = Buffer.from('{"message":"完成"}\r\n', 'utf8')
        child.stdout.write(encoded.subarray(0, encoded.length - 3))
        child.stdout.end(encoded.subarray(encoded.length - 3))
        child.stderr.end()
        child.emit('close', 0)
      })
      return child
    },
  })
  assert.deepEqual(result, { message: '完成' })
  assert.equal(calls[0].command, 'powershell.exe')
  assert.deepEqual(calls[0].args.slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'fixed-script'])
  assert.equal(calls[0].args.join(' ').includes('用户'), false)
  const payload = calls[0].options.env.AAMP_WINDOWS_PLATFORM_INPUT_BASE64
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), {
    path: 'C:\\用户 & Co\\runtime',
  })
})

test('private directory is created before its ACL is applied through structured input', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-private-'))
  const target = path.join(root, 'User & Co', 'runtime')
  const calls = []
  try {
    await ensurePrivateWindowsDirectory(target, {
      platform: 'win32',
      runPowerShell: async (operation, input) => {
        calls.push({ operation, input, exists: await fsp.stat(input.path).then((s) => s.isDirectory()) })
        return { path: input.path, ownerSid: 'S-1-5-21-1000' }
      },
    })
    assert.deepEqual(calls, [{
      operation: 'protect-directory',
      input: { path: target },
      exists: true,
    }])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('private directory setup fails closed when ACL application fails', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-private-fail-'))
  const target = path.join(root, 'runtime')
  try {
    await assert.rejects(
      ensurePrivateWindowsDirectory(target, {
        platform: 'win32',
        runPowerShell: async () => { throw new Error('access denied') },
      }),
      /access denied/,
    )
    assert.equal((await fsp.stat(target)).isDirectory(), true)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('CIM identity is normalized with owner SID and an ISO creation time', async () => {
  const identity = await readWindowsProcessIdentity(4321, {
    platform: 'win32',
    runPowerShell: async (operation, input) => {
      assert.equal(operation, 'read-process-identity')
      assert.deepEqual(input, { pid: 4321 })
      return {
        found: true,
        pid: 4321,
        creationDate: '2026-09-07T01:02:03.456+08:00',
        commandLine: '"C:\\Program Files\\nodejs\\node.exe" worker.mjs',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        ownerSid: 'S-1-5-21-1000',
      }
    },
  })
  assert.deepEqual(identity, {
    pid: 4321,
    startedAt: '2026-09-06T17:02:03.456Z',
    command: '"C:\\Program Files\\nodejs\\node.exe" worker.mjs',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    ownerSid: 'S-1-5-21-1000',
  })
})

test('CIM distinguishes a missing PID from an identity query failure', async () => {
  assert.equal(await readWindowsProcessIdentity(9001, {
    platform: 'win32',
    runPowerShell: async () => ({ found: false }),
  }), undefined)
  await assert.rejects(readWindowsProcessIdentity(9001, {
    platform: 'win32',
    runPowerShell: async () => { throw new Error('CIM access denied') },
  }), /CIM access denied/)
})

test('native command resolution prefers an executable and preserves argument boundaries', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-command-')))
  const executable = path.join(root, 'agent.EXE')
  await fsp.writeFile(executable, '')
  try {
    assert.deepEqual(await resolveNativeCommand('agent', {
      platform: 'win32',
      env: { Path: root, PATHEXT: '.EXE;.CMD' },
    }), { command: executable, argsPrefix: [] })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('native command resolution accepts an environment object as its second argument', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-command-env-')))
  const executable = path.join(root, 'npm.EXE')
  await fsp.writeFile(executable, '')
  try {
    assert.deepEqual(await resolveNativeCommand('npm', { Path: root, PATHEXT: '.EXE' }), {
      command: executable,
      argsPrefix: [],
    })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('current Windows SID rejects malformed PowerShell results', async () => {
  assert.equal(await getCurrentWindowsSid({
    platform: 'win32',
    runPowerShell: async (operation, input) => {
      assert.equal(operation, 'current-user-sid')
      assert.deepEqual(input, {})
      return { ownerSid: 'S-1-5-21-1000' }
    },
  }), 'S-1-5-21-1000')
  await assert.rejects(getCurrentWindowsSid({
    platform: 'win32',
    runPowerShell: async () => ({ ownerSid: '' }),
  }), /invalid current user SID/)
})

test('native command resolution unwraps a standard npm cmd shim to its real JavaScript bin', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-npm-bin-')))
  const bin = path.join(root, 'node_modules', '@scope', 'tool', 'bin', 'cli.mjs')
  await fsp.mkdir(path.dirname(bin), { recursive: true })
  await fsp.writeFile(bin, 'process.exit(0)\n')
  await fsp.writeFile(path.join(root, 'tool.cmd'), '@ECHO off\r\n"%~dp0\\node.exe"  "%~dp0\\node_modules\\@scope\\tool\\bin\\cli.mjs" %*\r\n')
  try {
    assert.deepEqual(await resolveNativeCommand('tool', {
      platform: 'win32',
      env: { PATH: root, PATHEXT: '.cmd' },
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    }), {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: [bin],
    })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('native command resolution selects the CLI assignment from a modern npx cmd shim', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-modern-npx-')))
  const prefix = path.join(root, 'node_modules', 'npm', 'bin', 'npm-prefix.js')
  const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  await fsp.mkdir(path.dirname(cli), { recursive: true })
  await fsp.writeFile(prefix, 'process.exit(0)\n')
  await fsp.writeFile(cli, 'process.exit(0)\n')
  await fsp.writeFile(path.join(root, 'npx.cmd'), `@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n`)
  try {
    assert.deepEqual(await resolveNativeCommand('npx', {
      platform: 'win32', env: { PATH: root, PATHEXT: '.cmd' }, nodeExecutable: 'C:\\node.exe',
    }), { command: 'C:\\node.exe', argsPrefix: [cli] })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('owned tree snapshot follows verified parent links and excludes spectators', async () => {
  const root = {
    pid: 100,
    startedAt: '2026-09-07T01:00:00.000Z',
    command: 'node root.mjs',
    executablePath: 'C:\\node.exe',
    ownerSid: 'S-1-5-21-1000',
  }
  const child = { ...root, pid: 101, parentPid: 100, startedAt: '2026-09-07T01:00:01.000Z' }
  const grandchild = { ...root, pid: 102, parentPid: 101, startedAt: '2026-09-07T01:00:02.000Z' }
  const spectator = { ...root, pid: 200, parentPid: 99, startedAt: '2026-09-07T01:00:01.000Z' }
  assert.deepEqual(await snapshotOwnedWindowsTree(root, {
    platform: 'win32',
    getCurrentSid: async () => root.ownerSid,
    listIdentities: async () => [{ ...root, parentPid: 1 }, child, grandchild, spectator],
  }), [root, child, grandchild])
})

test('owned tree snapshot returns empty when the live root identity changed', async () => {
  const root = {
    pid: 100, startedAt: '2026-09-07T01:00:00.000Z', command: 'node root.mjs',
    executablePath: 'C:\\node.exe', ownerSid: 'S-1-5-21-1000',
  }
  assert.deepEqual(await snapshotOwnedWindowsTree(root, {
    platform: 'win32',
    getCurrentSid: async () => root.ownerSid,
    listIdentities: async () => [{ ...root, parentPid: 1, startedAt: '2026-09-07T02:00:00.000Z' }],
  }), [])
})

test('owned tree snapshot rejects a descendant older than its recorded parent edge', async () => {
  const root = {
    pid: 100, startedAt: '2026-09-07T01:00:00.000Z', command: 'node root.mjs',
    executablePath: 'C:\\node.exe', ownerSid: 'S-1-5-21-1000',
  }
  const child = { ...root, pid: 101, parentPid: 100, startedAt: '2026-09-07T01:02:00.000Z' }
  const recycledGrandchild = { ...root, pid: 102, parentPid: 101, startedAt: '2026-09-07T01:01:00.000Z' }
  assert.deepEqual(await snapshotOwnedWindowsTree(root, {
    platform: 'win32',
    getCurrentSid: async () => root.ownerSid,
    listIdentities: async () => [{ ...root, parentPid: 1 }, child, recycledGrandchild],
  }), [root, child])
})

test('native command resolution rejects a cmd shim whose argv handling cannot be verified', async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-cmd-')))
  const shim = path.join(root, 'legacy.cmd')
  await fsp.writeFile(shim, '@echo off\r\nlegacy-real.exe %*\r\n')
  try {
    await assert.rejects(resolveNativeCommand('legacy', {
      platform: 'win32',
      env: { PATH: root, PATHEXT: '.cmd' },
    }), /cannot safely launch opaque Windows command shim/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('PowerShell aborts when output exceeds its bounded result buffer', async () => {
  let killed = false
  await assert.rejects(runWindowsPowerShell('fixed-script', {}, {
    maxOutputBytes: 8,
    spawnProcess() {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { killed = true }
      queueMicrotask(() => child.stdout.write('123456789'))
      return child
    },
  }), /output limit/)
  assert.equal(killed, true)
})

test('Windows terminal uses the process console streams without opening a tty device', () => {
  assert.deepEqual(openWindowsTerminal({ stdin: 'input', stdout: 'output' }), {
    input: 'input',
    output: 'output',
  })
})

test('owned tree cleanup rechecks the full identity before taskkill', async () => {
  const expected = {
    pid: 4321,
    startedAt: '2026-09-06T17:02:03.456Z',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    ownerSid: 'S-1-5-21-1000',
  }
  const calls = []
  let reads = 0
  await stopOwnedWindowsTree(expected, {
    platform: 'win32',
    getCurrentSid: async () => expected.ownerSid,
    readIdentity: async () => (++reads === 1 ? { ...expected, command: 'node worker.mjs' } : undefined),
    runTaskkill: async (args) => { calls.push(args) },
  })
  assert.deepEqual(calls, [['/PID', '4321', '/T', '/F']])
})

for (const [name, changed] of [
  ['creation time', { startedAt: '2026-09-06T17:02:04.456Z' }],
  ['executable path', { executablePath: 'C:\\Other\\node.exe' }],
  ['owner SID', { ownerSid: 'S-1-5-21-2000' }],
]) {
  test(`owned tree cleanup refuses taskkill after ${name} changes`, async () => {
    const expected = {
      pid: 4321,
      startedAt: '2026-09-06T17:02:03.456Z',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
      ownerSid: 'S-1-5-21-1000',
    }
    let killed = false
    await assert.rejects(stopOwnedWindowsTree(expected, {
      platform: 'win32',
      getCurrentSid: async () => expected.ownerSid,
      readIdentity: async () => ({ ...expected, ...changed, command: 'node worker.mjs' }),
      runTaskkill: async () => { killed = true },
    }), /identity changed/)
    assert.equal(killed, false)
  })
}

test('owned tree cleanup refuses a recorded process owned by another Windows user', async () => {
  const expected = {
    pid: 4321,
    startedAt: '2026-09-06T17:02:03.456Z',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    ownerSid: 'S-1-5-21-2000',
  }
  let read = false
  let killed = false
  await assert.rejects(stopOwnedWindowsTree(expected, {
    platform: 'win32',
    getCurrentSid: async () => 'S-1-5-21-1000',
    readIdentity: async () => { read = true; return expected },
    runTaskkill: async () => { killed = true },
  }), /another Windows user/)
  assert.equal(read, false)
  assert.equal(killed, false)
})

test('native Windows CIM and ACL smoke test', { skip: process.platform !== 'win32' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-native-'))
  try {
    await ensurePrivateWindowsDirectory(root)
    const identity = await readWindowsProcessIdentity(process.pid)
    assert.equal(identity?.pid, process.pid)
    assert.match(identity?.ownerSid || '', /^S-/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('native Windows cleanup kills only the owned parent-child-grandchild tree', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-tree-'))
  const fixture = path.join(root, 'process-tree-fixture.mjs')
  const stateFile = path.join(root, 'pids.ndjson')
  await fsp.writeFile(fixture, `
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [role, stateFile] = process.argv.slice(2)
appendFileSync(stateFile, JSON.stringify({ role, pid: process.pid }) + '\\n')
if (role === 'parent') {
  spawn(process.execPath, [process.argv[1], 'child', stateFile], { stdio: 'ignore' })
} else if (role === 'child') {
  spawn(process.execPath, [process.argv[1], 'grandchild', stateFile], { stdio: 'ignore' })
}
setInterval(() => {}, 1_000)
`)
  const managed = spawn(process.execPath, [fixture, 'parent', stateFile], { stdio: 'ignore' })
  const spectator = spawn(process.execPath, [fixture, 'spectator', stateFile], { stdio: 'ignore' })
  const forceStop = (pid) => new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], () => resolve())
  })
  const waitUntil = async (predicate, message) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail(message)
  }
  let records = []
  try {
    await waitUntil(async () => {
      const content = await fsp.readFile(stateFile, 'utf8').catch(() => '')
      records = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      return ['parent', 'child', 'grandchild', 'spectator']
        .every((role) => records.some((record) => record.role === role))
    }, 'Windows fixture process tree did not start')

    const rootIdentity = await readWindowsProcessIdentity(managed.pid)
    assert.ok(rootIdentity)
    await stopOwnedWindowsTree(rootIdentity)

    const managedPids = records.filter(({ role }) => role !== 'spectator').map(({ pid }) => pid)
    await waitUntil(async () => (await Promise.all(
      managedPids.map((pid) => readWindowsProcessIdentity(pid)),
    )).every((identity) => identity === undefined), 'managed Windows process tree remained alive')
    const spectatorRecord = records.find(({ role }) => role === 'spectator')
    assert.ok(await readWindowsProcessIdentity(spectatorRecord.pid), 'unrelated spectator was killed')
  } finally {
    await Promise.all([...new Set([managed.pid, spectator.pid, ...records.map(({ pid }) => pid)])]
      .filter(Number.isSafeInteger)
      .map(forceStop))
    await fsp.rm(root, { recursive: true, force: true })
  }
})


test('journal recovery skips a reused PID before querying its inaccessible owner', {skip: process.platform !== 'win32'}, async () => {
  const {__test} = await import('../bin/windows-platform.mjs')
  const fixture = String.raw`
function Get-CimInstance {
  return [pscustomobject]@{ProcessId=10384; CreationDate=[datetime]::Parse('2026-09-11T01:00:00.123456Z')}
}
function Invoke-CimMethod { throw 'owner access denied: must not query a newer process' }
`
  const expected = {pid:10384,startedAt:'2026-09-10T01:00:00.000Z',executablePath:'C:\\node.exe',ownerSid:'S-1-5-21-1000'}
  const readIdentity = (pid, options) => readWindowsProcessIdentity(pid, {
    ...options, platform:'win32',
    runPowerShell: (operation, config) => runWindowsPowerShell(fixture + __test.powershellScripts[operation], config),
  })
  await stopOwnedWindowsTree(expected, {
    platform:'win32',getCurrentSid:async()=>expected.ownerSid,readIdentity,
    allowExitedIdentity:true,runTaskkill:async()=>assert.fail('must not kill the successor'),
  })
  const {createWindowsProcessJournal, recoverWindowsProcessJournals} = await import('../bin/windows-process-journal.mjs')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-native-controller-recovery-'))
  try {
    const journal = await createWindowsProcessJournal(root, expected, {
      ensurePrivateDirectory: async () => {}, atomicReplace: fsp.rename,
    })
    const descendant = {...expected, pid:10385}
    await journal.record([descendant])
    const stopped = []
    await recoverWindowsProcessJournals(root, {
      readIdentity,
      stopTree: async identity => stopped.push(identity),
    })
    assert.deepEqual(stopped, [descendant])
    await assert.rejects(fsp.stat(journal.file), {code:'ENOENT'})
  } finally { await fsp.rm(root, {recursive:true,force:true}) }
  for (const startedAt of ['2026-09-11T01:00:00.123Z','2026-09-12T01:00:00.000Z']) {
    await assert.rejects(readIdentity(expected.pid,{exitedBefore:startedAt}),/owner access denied/)
  }
})

for (const operation of ['read-process-identity', 'list-process-tree']) {
  test(`native ${operation} verifies disappearance and PID reuse without suppressing live CIM failures`, {skip: process.platform !== 'win32' && 'requires native PowerShell race fixture'}, async () => {
    const {__test} = await import('../bin/windows-platform.mjs')
    const fixture = String.raw`
$script:reads = 0
$script:snapshot = [pscustomobject]@{
  ProcessId = 10384; ParentProcessId = 1
  CreationDate = [datetime]::Parse('2026-09-08T01:00:00Z')
  CommandLine = 'node fixture'; ExecutablePath = 'C:\fixture\node.exe'
}
function Get-CimInstance {
  $script:reads++
  if ($script:reads -eq 1) { return $script:snapshot }
  if ($env:AAMP_CIM_RACE -eq 'reread-failure') { throw 'CIM reread denied' }
  if ($env:AAMP_CIM_RACE -like '*gone') { return $null }
  if ($env:AAMP_CIM_RACE -like '*reused') {
    return [pscustomobject]@{ProcessId=10384;CreationDate=$script:snapshot.CreationDate.AddSeconds(1)}
  }
  return $script:snapshot
}
function Invoke-CimMethod {
  if ($env:AAMP_CIM_RACE -like 'error-*' -or $env:AAMP_CIM_RACE -eq 'reread-failure') { throw 'GetOwnerSid failed: fixture ObjectNotFound or denied' }
  if ($env:AAMP_CIM_RACE -eq 'return-code-live') { return [pscustomobject]@{ReturnValue=2;Sid=''} }
  return [pscustomobject]@{ReturnValue=0;Sid='S-1-5-21-1000'}
}
`
    const run = scenario => runWindowsPowerShell(fixture + __test.powershellScripts[operation], {pid:10384}, {environment:{...process.env,AAMP_CIM_RACE:scenario}})
    for (const scenario of ['error-gone','error-reused','success-gone','success-reused']) {
      const result = await run(scenario)
      if (operation === 'read-process-identity') assert.deepEqual(result,{found:false})
      else assert.deepEqual(result,{processes:[]})
    }
    const live = await run('success-live')
    const identity = operation === 'read-process-identity' ? live : live.processes[0]
    assert.equal(identity.pid,10384)
    assert.equal(identity.ownerSid,'S-1-5-21-1000')
    await assert.rejects(run('error-live'),/GetOwnerSid failed/)
    await assert.rejects(run('return-code-live'),/unable to read process owner SID/)
    await assert.rejects(run('reread-failure'),/CIM reread denied/)
  })
}


test('invalid CIM tree diagnostics include numeric IDs and field names without credentials', async () => {
  const root = {pid:101,startedAt:'2026-09-08T01:00:00.000Z',command:'node',executablePath:'C:\\node.exe',ownerSid:'S-1-5-21-1000'}
  const malformed = {
    pid:102,parentPid:101,creationDate:'2026-09-08T01:00:01.000Z',
    commandLine:'node --secret command-secret-sentinel',executablePath:'',ownerSid:'S-1-5-21-1000',
  }
  const inspect = value => snapshotOwnedWindowsTree(root, {
    platform:'win32',getCurrentSid:async()=>root.ownerSid,listIdentities:async()=>[value],
  })
  await assert.rejects(inspect(malformed), error => {
    assert.equal(error.message,'CIM returned an invalid Windows process tree identity (pid=102, parentPid=101, invalidFields=executablePath)')
    assert.doesNotMatch(error.message,/command-secret-sentinel|--secret/)
    return true
  })
  await assert.rejects(inspect({...malformed,pid:'pid-secret-sentinel',parentPid:'parent-secret-sentinel',creationDate:'date-secret-sentinel',commandLine:null,executablePath:null,ownerSid:null}), error => {
    assert.equal(error.message,'CIM returned an invalid Windows process tree identity (pid=invalid, parentPid=invalid, invalidFields=pid,parentPid,creationDate/startedAt,commandLine/command,executablePath,ownerSid)')
    assert.doesNotMatch(error.message,/secret-sentinel/)
    return true
  })
})

for (const operation of ['read-process-identity', 'list-process-tree']) {
  test(`native ${operation} refreshes incomplete metadata only for the same process`, {skip: process.platform !== 'win32' && 'requires native PowerShell race fixture'}, async () => {
    const {__test} = await import('../bin/windows-platform.mjs')
    const fixture = String.raw`
$script:reads = 0
$script:created = [datetime]::Parse('2026-09-08T01:00:00Z')
function Get-CimInstance {
  $script:reads++
  $created = $script:created
  $executable = ''
  if ($script:reads -gt 1) {
    if ($env:AAMP_CIM_METADATA -eq 'gone') { return $null }
    if ($env:AAMP_CIM_METADATA -eq 'reused') { $created = $created.AddSeconds(1) }
    if ($env:AAMP_CIM_METADATA -eq 'failure') { throw 'metadata read denied' }
    if ($env:AAMP_CIM_METADATA -ne 'missing' -and $env:AAMP_CIM_METADATA -notlike 'native-*' -and ($env:AAMP_CIM_METADATA -ne 'delayed' -or $script:reads -ge 5)) { $executable = 'C:\fixture\node.exe' }
  }
  return [pscustomobject]@{ProcessId=10384;ParentProcessId=1;CreationDate=$created;CommandLine='node fixture';ExecutablePath=$executable}
}
function Invoke-CimMethod { return [pscustomobject]@{ReturnValue=0;Sid='S-1-5-21-1000'} }
function Get-FixtureNativeProcess {
  param($id)
  if ($env:AAMP_CIM_METADATA -eq 'native-gone') { return [pscustomobject]@{HasExited=$true} }
  if ($env:AAMP_CIM_METADATA -eq 'native-denied') { throw [System.UnauthorizedAccessException]::new('native handle denied') }
  $created = $script:created.AddTicks(4)
  if ($env:AAMP_CIM_METADATA -eq 'native-reused') { $created = $created.AddSeconds(1) }
  $image = if ($env:AAMP_CIM_METADATA -eq 'missing') { '' } else { 'C:\fixture\node.exe' }
  $native = [pscustomobject]@{HasExited=($env:AAMP_CIM_METADATA -eq 'native-exited');StartTime=$created;ImagePath=$image}
  $native | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $native
}
`
    const run = scenario => runWindowsPowerShell(fixture + __test.powershellScripts[operation].replace('Read-LimitedProcessImage ([int]$snapshot.ProcessId)', '(Get-FixtureNativeProcess ([int]$snapshot.ProcessId))'), {pid:10384}, {environment:{...process.env,AAMP_CIM_METADATA:scenario}})
    const native = await run('native-restored')
    assert.equal((operation === 'read-process-identity' ? native : native.processes[0]).executablePath, String.raw`C:\fixture\node.exe`)
    for (const scenario of ['native-gone','native-reused','native-exited']) {
      assert.deepEqual(await run(scenario), operation === 'read-process-identity' ? {found:false} : {processes:[]})
    }
    await assert.rejects(run('native-denied'), /native handle denied/)
    const delayed = await run('delayed')
    assert.equal((operation === 'read-process-identity' ? delayed : delayed.processes[0]).executablePath, String.raw`C:\fixture\node.exe`)
    const result = await run('restored')
    const identity = operation === 'read-process-identity' ? result : result.processes[0]
    assert.equal(identity.executablePath, String.raw`C:\fixture\node.exe`)
    for (const scenario of ['gone','reused']) {
      assert.deepEqual(await run(scenario), operation === 'read-process-identity' ? {found:false} : {processes:[]})
    }
    await assert.rejects(run('failure'), /metadata read denied/)
    await assert.rejects(run('missing'), /unable to read process executable path/)
  })
}

test('PowerShell cancellation kills its helper and rejects with the operation stage',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=false
 child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',1));return true}
 const abort=new AbortController()
 const pending=runWindowsPowerShell('unused',{}, {spawnProcess:()=>child,signal:abort.signal,operation:'list-process-tree'})
 abort.abort(new Error('stop requested'))
 await assert.rejects(pending,/list-process-tree.*stop requested/)
 assert.equal(killed,true)
})

test('native shared snapshot identifies two owned roots in one query', {skip:process.platform!=='win32'},async t=>{
 const {snapshotOwnedWindowsTrees}=await import('../bin/windows-platform.mjs')
 const children=[spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})]
 t.after(()=>{for(const child of children)child.kill()})
 const roots=await Promise.all(children.map(child=>readWindowsProcessIdentity(child.pid)))
 const snapshots=await snapshotOwnedWindowsTrees(roots)
 for(const root of roots)assert.ok(snapshots.get(root.pid).some(i=>i.pid===root.pid))
})

test('native cancelled PowerShell helper actually exits', {skip:process.platform!=='win32'},async()=>{
 let child,closed,deadlineTimer
 const abort=new AbortController()
 const pending=runWindowsPowerShell('Start-Sleep -Seconds 30; @{ok=$true}|ConvertTo-Json',{}, {
 signal:abort.signal,operation:'native-cancel-probe',spawnProcess:(...args)=>{child=spawn(...args);closed=new Promise(resolve=>child.once('close',resolve));return child},
 })
 const timer=setTimeout(()=>abort.abort(new Error('cancel probe')),150)
 try {await assert.rejects(pending,/native-cancel-probe/);await Promise.race([closed,new Promise((resolve,reject)=>{deadlineTimer=setTimeout(()=>reject(Error('helper remained alive')),3000)})]);assert.ok(child.exitCode!==null || child.signalCode!==null)}finally{clearTimeout(timer);clearTimeout(deadlineTimer);child?.kill()}
})
