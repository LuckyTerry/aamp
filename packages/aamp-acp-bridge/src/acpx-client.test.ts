import { parseWindowsAgentArgv, windowsAgentAlias } from './windows-agent-config.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AcpxClient,
  type AcpPromptControl,
  buildAcpxEnvironment,
  selectFinalAssistantOutput,
  selectOwnedWindowsTree,
  snapshotOwnedWindowsTree,
  terminateWindowsProcessTree,
  WindowsOwnedProcessTree,
  type WindowsProcessIdentity,
} from './acpx-client.js'

const tempDirectories: string[] = []
const testDirectory = dirname(fileURLToPath(import.meta.url))

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('terminateWindowsProcessTree kills only an unchanged owned process identity', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
  const identity: WindowsProcessIdentity = {
    pid: 4312,
    creationDate: '20260907101010.000000+480',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    ownerSid: 'S-1-5-21-1000',
  }
  const killed = terminateWindowsProcessTree(identity, () => ({ status: 'found', identity: { ...identity } }), ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options })
    return Buffer.alloc(0)
  }) as never)

  assert.equal(killed, 'termination-requested')
  assert.deepEqual(calls, [{
    command: 'taskkill.exe',
    args: ['/pid', '4312', '/t', '/f'],
    options: { stdio: 'ignore', windowsHide: true, timeout: 5_000 },
  }])
})

test('terminateWindowsProcessTree refuses a reused pid', () => {
  const expected: WindowsProcessIdentity = {
    pid: 4312,
    creationDate: '20260907101010.000000+480',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    ownerSid: 'S-1-5-21-1000',
  }
  let spawned = false
  const killed = terminateWindowsProcessTree(expected, () => ({ status: 'found', identity: {
    ...expected, creationDate: '20260907101100.000000+480',
  } }), (() => {
    spawned = true
    return Buffer.alloc(0)
  }) as never)

  assert.equal(killed, 'identity-changed')
  assert.equal(spawned, false)
})

test('buildAcpxEnvironment pins local bin through one case-insensitive PATH key', () => {
  const env = buildAcpxEnvironment('C:\\workspace', {
    Path: 'C:\\global-bin',
    PATH: 'C:\\stale-bin',
    PATHEXT: '.CMD',
  }, 'win32')

  assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === 'path'), ['Path'])
  assert.equal(env.Path, 'C:\\workspace\\node_modules\\.bin;C:\\global-bin')
})

test('exec preserves synchronous resolver errors without an unrelated npx fallback', async () => {
  const attempted: string[] = []
  const client = new AcpxClient(process.cwd(), {
    resolveCommand: (command) => {
      attempted.push(command)
      throw new Error(`${command} shim is unsupported`)
    },
  })

  await assert.rejects(
    () => client.ensureSession('codex', 'resolver-failure'),
    /acpx shim is unsupported/,
  )
  assert.deepEqual(attempted, ['acpx'])
})

test('WindowsOwnedProcessTree cleans a retained orphan without touching reused or unrelated pids', async () => {
  const root: WindowsProcessIdentity = {
    pid: 100,
    creationDate: 'root-created',
    executablePath: 'C:\\node.exe',
    ownerSid: 'S-1-5-21-owner',
  }
  const child: WindowsProcessIdentity = {
    pid: 101,
    creationDate: 'child-created',
    executablePath: 'C:\\agent.exe',
    ownerSid: root.ownerSid,
  }
  const reused: WindowsProcessIdentity = {
    pid: 102,
    creationDate: 'old-child-created',
    executablePath: 'C:\\helper.exe',
    ownerSid: root.ownerSid,
  }
  const unrelated: WindowsProcessIdentity = {
    pid: 900,
    creationDate: 'unrelated-created',
    executablePath: 'C:\\node.exe',
    ownerSid: root.ownerSid,
  }
  let intervalCallback: (() => void) | undefined
  let cleared = false
  const live = new Map([
    [child.pid, child],
    [reused.pid, { ...reused, creationDate: 'reused-by-new-process' }],
    [unrelated.pid, unrelated],
  ])
  const killed: number[] = []
  const tree = new WindowsOwnedProcessTree(root, {
    snapshot: () => [root, child, reused],
    terminate: (identity) => {
      const current = live.get(identity.pid)
      if (current?.creationDate !== identity.creationDate) return 'identity-changed'
      killed.push(identity.pid)
      return 'termination-requested'
    },
    setTimeoutFn: (callback: () => void) => {
      intervalCallback = callback
      return { unref() {} } as NodeJS.Timeout
    },
    clearTimeoutFn: () => { cleared = true },
  })

  tree.start()
  await tree.refresh()
  intervalCallback?.()
  await tree.refresh()
  tree.stopPolling()
  await tree.terminateRetained()

  assert.equal(cleared, true)
  assert.deepEqual(killed, [101])
  assert.equal(live.has(unrelated.pid), true)
})

test('WindowsOwnedProcessTree ignores a failed or root-mismatched snapshot', async () => {
  const root: WindowsProcessIdentity = {
    pid: 200,
    creationDate: 'root-created',
    executablePath: 'C:\\node.exe',
    ownerSid: 'S-1-5-21-owner',
  }
  const killed: number[] = []
  const snapshots: Array<() => WindowsProcessIdentity[]> = [
    () => { throw new Error('CIM unavailable') },
    () => [{ ...root, creationDate: 'reused-root' }, {
      pid: 201,
      creationDate: 'not-owned',
      executablePath: 'C:\\other.exe',
      ownerSid: root.ownerSid,
    }],
  ]
  const tree = new WindowsOwnedProcessTree(root, {
    snapshot: () => snapshots.shift()?.() ?? [],
    terminate: (identity) => { killed.push(identity.pid); return 'termination-requested' },
    setTimeoutFn: (() => ({ unref() {} })) as never,
    clearTimeoutFn: () => {},
  })

  await tree.refresh()
  await tree.refresh()
  await tree.terminateRetained()
  assert.deepEqual(killed, [root.pid])
})

test('selectOwnedWindowsTree rejects a child older than its parent after PID reuse', () => {
  const root: WindowsProcessIdentity = {
    pid: 300,
    creationDate: '2026-09-07T10:00:00.9000000+08:00',
    executablePath: 'C:\\node.exe',
    ownerSid: 'S-1-5-21-owner',
  }
  const selected = selectOwnedWindowsTree(root, [
    { ...root, parentPid: 1 },
    {
      pid: 301,
      parentPid: 300,
      creationDate: '2026-09-07T10:00:00.1000000+08:00',
      executablePath: 'C:\\stale.exe',
      ownerSid: root.ownerSid,
    },
    {
      pid: 302,
      parentPid: 300,
      creationDate: '2026-09-07T10:00:01.0000000+08:00',
      executablePath: 'C:\\owned.exe',
      ownerSid: root.ownerSid,
    },
  ])

  assert.deepEqual(selected.map((identity) => identity.pid), [300, 302])
})

test('WindowsOwnedProcessTree retains unconfirmed termination for a later retry', async () => {
  const root: WindowsProcessIdentity = {
    pid: 400,
    creationDate: 'root-created',
    executablePath: 'C:\\node.exe',
    ownerSid: 'S-1-5-21-owner',
  }
  const child = { ...root, pid: 401, creationDate: 'child-created' }
  const attempts: number[] = []
  let childOutcome: 'unconfirmed' | 'gone' = 'unconfirmed'
  const tree = new WindowsOwnedProcessTree(root, {
    snapshot: () => [root, child],
    terminate: (identity) => {
      attempts.push(identity.pid)
      return identity.pid === child.pid ? childOutcome : 'gone'
    },
    setTimeoutFn: (() => ({ unref() {} })) as never,
    clearTimeoutFn: () => {},
  })

  await tree.refresh()
  await tree.terminateRetained()
  childOutcome = 'gone'
  await tree.terminateRetained()

  assert.deepEqual(attempts, [401, 400, 401])
})

const samplingRoot: WindowsProcessIdentity = {
  pid: 500, creationDate: '2026-09-07T10:00:00.000Z',
  executablePath: 'C:\\node.exe', ownerSid: 'S-1-5-21-owner',
}

test('WindowsOwnedProcessTree coalesces slow snapshots without blocking the event loop', async () => {
  let finish!: (identities: WindowsProcessIdentity[]) => void
  let calls = 0
  const timers: Array<{ callback: () => void; delay: number }> = []
  const tree = new WindowsOwnedProcessTree(samplingRoot, {
    snapshot: () => { calls++; return new Promise(resolve => { finish = resolve }) },
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay })
      return { unref() {} } as NodeJS.Timeout
    },
    clearTimeoutFn: () => {},
  })
  tree.start()
  const first = tree.refresh()
  assert.equal(tree.refresh(), first)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(timers.length, 0)
  finish([samplingRoot])
  await first
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 500)
  timers[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  tree.stopPolling()
  finish([samplingRoot])
  await tree.refresh()
  assert.equal(timers.length, 1)
})

test('WindowsOwnedProcessTree drains an in-flight snapshot before cleanup and never resumes polling', async () => {
  let finish!: (identities: WindowsProcessIdentity[]) => void
  const child = { ...samplingRoot, pid: 501 }
  const killed: number[] = []
  let scheduled = 0
  const tree = new WindowsOwnedProcessTree(samplingRoot, {
    snapshot: () => new Promise(resolve => { finish = resolve }),
    terminate: identity => { killed.push(identity.pid); return 'gone' },
    setTimeoutFn: () => { scheduled++; return { unref() {} } as NodeJS.Timeout },
  })
  tree.start()
  await new Promise(resolve => setImmediate(resolve))
  const cleanup = tree.terminateRetained()
  assert.equal(tree.terminateRetained(), cleanup)
  tree.start()
  assert.deepEqual(killed, [])
  finish([samplingRoot, child])
  await cleanup
  assert.deepEqual(killed, [501, 500])
  assert.equal(scheduled, 0)
})

test('WindowsOwnedProcessTree retains verified identities when a later async snapshot times out', async () => {
  const child = { ...samplingRoot, pid: 501 }
  let attempts = 0
  const killed: number[] = []
  const tree = new WindowsOwnedProcessTree(samplingRoot, {
    snapshot: async () => {
      if (attempts++ === 0) return [samplingRoot, child]
      throw Object.assign(new Error('CIM timed out'), { killed: true })
    },
    terminate: identity => { killed.push(identity.pid); return 'gone' },
  })
  await tree.refresh()
  await tree.refresh()
  await tree.terminateRetained()
  assert.deepEqual(killed, [501, 500])
})

test('snapshotOwnedWindowsTree bounds async CIM execution and rejects timeout output', async () => {
  const identities = await snapshotOwnedWindowsTree(samplingRoot, (async (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
    assert.equal(command, 'powershell.exe')
    assert.equal(options.timeout, 10_000)
    assert.equal(options.maxBuffer, 1024 * 1024)
    throw Object.assign(new Error('timeout'), { killed: true, stdout: JSON.stringify({ processes: [samplingRoot] }) })
  }) as never)
  assert.deepEqual(identities, [])
})

test('AcpxClient resolves child close only after the pending Windows ownership sample drains', async () => {
  let finish!: (identities: WindowsProcessIdentity[]) => void
  const killed: number[] = []
  const tree = new WindowsOwnedProcessTree(samplingRoot, {
    snapshot: () => new Promise(resolve => { finish = resolve }),
    terminate: identity => { killed.push(identity.pid); return 'gone' },
  })
  tree.start()
  await new Promise(resolve => setImmediate(resolve))
  const proc = Object.assign(new EventEmitter(), {
    pid: samplingRoot.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams
  const client = new AcpxClient(process.cwd())
  client['spawnAcpx'] = () => proc
  client['windowsProcessTrees'].set(proc, tree)
  let completed = false
  client['runAcpx']([], { onClose: () => { completed = true }, onError: error => { throw error } })
  let closed = false
  const closing = client['activeProcesses'].get(proc)!.then(() => { closed = true })
  proc.emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  assert.equal(closed, false)
  assert.equal(client['activeProcesses'].size, 1)
  finish([samplingRoot, { ...samplingRoot, pid: 501 }])
  await closing
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, true)
  assert.equal(client['activeProcesses'].size, 0)
  assert.deepEqual(killed, [501, 500])
})

test('AcpxClient stops all Windows samplers before awaiting an in-flight cleanup', async () => {
  const client = new AcpxClient(process.cwd())
  const proc1 = { pid: 501 } as ChildProcessWithoutNullStreams
  const proc2 = { pid: 502 } as ChildProcessWithoutNullStreams
  client['activeProcesses'].set(proc1, new Promise(() => {}))
  client['activeProcesses'].set(proc2, new Promise(() => {}))
  const requested: number[] = []
  const finishes: Array<() => void> = []
  client['terminateProcessTree'] = proc => {
    requested.push(proc.pid!)
    return new Promise(resolve => { finishes.push(() => { client['activeProcesses'].delete(proc); resolve() }) })
  }
  const stopping = client.stop()
  assert.deepEqual(requested, [501, 502])
  assert.equal(client.stop(), stopping)
  finishes.forEach(finish => finish())
  await stopping
})

test('AcpxClient cancellation waits for pending Windows cleanup before its close deadline', async () => {
  let finish!: () => void
  const draining = new Promise<void>(resolve => { finish = resolve })
  const proc = Object.assign(new EventEmitter(), {
    pid: 503, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams
  const client = new AcpxClient(process.cwd())
  client['spawnAcpx'] = () => proc
  client['terminateProcessTree'] = () => draining
  const execution = client['runAcpx']([], { onClose: () => {}, onError: error => { throw error } })
  let cancelled = false
  const cancelling = execution.cancel().then(() => { cancelled = true })
  // Exceed the old 2s close race while the bounded CIM cleanup is pending.
  await new Promise(resolve => setTimeout(resolve, 2_100))
  assert.equal(cancelled, false)
  finish()
  proc.emit('close', 0)
  await cancelling
  assert.equal(cancelled, true)
})

function promptProcessHarness() {
  const client = new AcpxClient(process.cwd())
  const children: Array<{ args: string[]; proc: ChildProcessWithoutNullStreams }> = []
  const kills: Array<{ proc: ChildProcessWithoutNullStreams; signal: NodeJS.Signals | undefined }> = []
  client['spawnAcpx'] = (args) => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 10_000 + children.length,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams
    children.push({ args, proc })
    return proc
  }
  client['terminateProcessTree'] = (proc, signal) => {
    kills.push({ proc, signal })
    proc.emit('close', 137)
  }
  return { client, children, kills }
}

test('prompt control waits for both the exact prompt and its normal cancel command', async () => {
  const { client, children, kills } = promptProcessHarness()
  let control!: AcpPromptControl
  const prompt = client.prompt('codex', 'session-a', 'first', { onControl: (value) => { control = value } })
  const other = client.prompt('codex', 'session-b', 'other')
  let finished = false
  const cancellation = control.cancelAndWait().then((result) => { finished = true; return result })
  assert.ok(children[2]!.args.includes('cancel'))
  assert.equal(children[2]!.args.at(-1), 'session-a')
  children[0]!.proc.emit('close', 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false, 'a late session cancel cannot outlive replacement startup')
  children[2]!.proc.emit('close', 0)
  assert.deepEqual(await cancellation, { forced: false })
  assert.deepEqual(kills, [])
  assert.equal(client['activeProcesses'].has(children[1]!.proc), true)
  children[1]!.proc.emit('close', 0)
  await Promise.all([prompt, other])
})

test('prompt control escalates after two seconds and kills only its prompt and cancel process', async () => {
  const { client, children, kills } = promptProcessHarness()
  const wait = client['waitForExit'].bind(client)
  let waits = 0
  client['waitForExit'] = async (exited, timeoutMs) => {
    assert.equal(timeoutMs, 2_000)
    if (waits++ === 0) return false
    return await wait(exited, timeoutMs)
  }
  let control!: AcpPromptControl
  const prompt = client.prompt('codex', 'session-a', 'first', { onControl: (value) => { control = value } })
  const other = client.prompt('codex', 'session-b', 'other')
  const result = await control.cancelAndWait()
  assert.deepEqual(result, { forced: true })
  assert.deepEqual(kills.map((kill) => children.findIndex((child) => child.proc === kill.proc)), [0, 2])
  assert.ok(kills.every((kill) => kill.signal === 'SIGKILL'))
  assert.equal(client['activeProcesses'].has(children[1]!.proc), true)
  children[1]!.proc.emit('close', 0)
  await Promise.all([prompt.catch(() => {}), other])
})

test('prompt control fails when targeted processes cannot be confirmed exited', async () => {
  const { client, children } = promptProcessHarness()
  client['waitForExit'] = async () => false
  client['terminateProcessTree'] = () => {}
  let control!: AcpPromptControl
  const prompt = client.prompt('codex', 'session-a', 'first', { onControl: (value) => { control = value } })
  await assert.rejects(control.cancelAndWait(), /did not exit after targeted termination/)
  assert.equal(client['activeProcesses'].size, 2, 'failure must not pretend the process has exited')
  children.forEach(({ proc }) => proc.emit('close', 0))
  await prompt
})

function createFakeAcpx(mode: 'success' | 'auth-failure' | 'auth-with-output' | 'json-auth-failure' | 'json-aime-auth-failure' | 'json-aime-sources' | 'auth-discussion' | 'timeout' | 'close-retry'): { cwd: string; logFile: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'aamp-acpx-readiness-test-'))
  tempDirectories.push(cwd)
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const logFile = join(cwd, 'acpx.log')
  mkdirSync(binDirectory, { recursive: true })
  const entry = join(binDirectory, 'acpx.cjs')
  writeFileSync(entry, `process.env.AAMP_FAKE_ACPX_MODE = ${JSON.stringify(mode)};\nprocess.env.AAMP_FAKE_ACPX_CWD = ${JSON.stringify(cwd)};\nimport(${JSON.stringify(new URL('../test/fake-acpx.mjs', import.meta.url).href)});\n`)
  // npm-style shim exercises native resolution without requiring a POSIX shell.
  writeFileSync(join(binDirectory, 'acpx.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0\\acpx.cjs" %*\r\n')
  writeFileSync(join(binDirectory, 'acpx'), '#!/usr/bin/env node\n' + readFileSync(entry, 'utf8'))
  chmodSync(join(binDirectory, 'acpx'), 0o755)
  return { cwd, logFile }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForState(statePath: string, state: string): Promise<number> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      const record = readFileSync(statePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid?: unknown; state?: unknown })
        .find((entry) => entry.state === state)
      if (record && Number.isSafeInteger(record.pid) && (record.pid as number) > 1) {
        return record.pid as number
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for child state ${state}`)
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (processExists(pid)) throw new Error('owned fixture process did not exit')
}

function createTermResistantAcpx(): { cwd: string; statePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'aamp-acpx-stop-test-'))
  tempDirectories.push(cwd)
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const statePath = join(cwd, 'child-state.jsonl')
  const fixturePath = join(testDirectory, '..', 'test', 'acpx-stop-ignore-term-child.mjs')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'acpx'), [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} ${shellQuote(statePath)}`,
    '',
  ].join('\n'))
  chmodSync(join(binDirectory, 'acpx'), 0o755)
  return { cwd, statePath }
}

test('stop waits for a TERM-resistant owned child to close after SIGKILL', { timeout: 10_000, skip: process.platform === 'win32' ? 'POSIX SIGTERM resistance; Windows ownership and termination are covered separately' : false }, async () => {
  const { cwd, statePath } = createTermResistantAcpx()
  const client = new AcpxClient(cwd)
  const execution = client.ensureSession('fake-agent --acp', 'stop-owned-child')
  const executionOutcome = execution.then(
    () => ({ kind: 'fulfilled' as const }),
    () => ({ kind: 'rejected' as const }),
  )
  let pid = 0

  try {
    pid = await waitForState(statePath, 'ready')
    let stopSettled = false
    const stopping = Promise.resolve(client.stop()).finally(() => {
      stopSettled = true
    })
    await waitForState(statePath, 'sigterm-ignored')

    assert.equal(stopSettled, false, 'stop must retain ownership until child close')
    assert.equal(processExists(pid), true, 'TERM-resistant fixture must still be alive before KILL')
    await stopping
    assert.equal(processExists(pid), false, 'stop must settle only after the owned PID is gone')
    assert.equal((await executionOutcome).kind, 'rejected')
  } finally {
    if (pid > 1 && processExists(pid)) {
      try { process.kill(-pid, 'SIGKILL') } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* exact owned fixture cleanup */ }
      }
      await waitForProcessExit(pid)
    }
    await executionOutcome
  }
})

test('stop is safe after a child has already closed normally', async () => {
  const { cwd } = createFakeAcpx('success')
  const client = new AcpxClient(cwd)

  await client.ensureSession('fake-agent --acp', 'normally-closed-child')
  await Promise.resolve(client.stop())
})

test('probeAgent creates a fresh ACP session and closes it after success', async () => {
  const { cwd, logFile } = createFakeAcpx('success')
  const client = new AcpxClient(cwd)

  await client.probeAgent('fake-agent --acp', {
    sessionName: 'aamp-readiness-probe-test',
    timeoutMs: 5_000,
  })

  assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
    `--approve-all --cwd ${cwd} ${process.platform === 'win32' ? windowsAgentAlias(['fake-agent', '--acp']) : '--agent fake-agent --acp'} sessions new --name aamp-readiness-probe-test`,
    `--approve-all --cwd ${cwd} ${process.platform === 'win32' ? windowsAgentAlias(['fake-agent', '--acp']) : '--agent fake-agent --acp'} sessions close aamp-readiness-probe-test`,
  ])
})

test('probeAgent preserves authentication failures and does not close a session that was not created', async () => {
  const { cwd, logFile } = createFakeAcpx('auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.probeAgent('fake-agent --acp', {
      sessionName: 'aamp-readiness-auth-failure',
      timeoutMs: 5_000,
    }),
    /Authentication required/,
  )

  const commands = readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(commands.length, 1)
  assert.match(commands[0], /sessions new --name aamp-readiness-auth-failure$/)
})

test('probeAgent times out instead of hanging bridge startup', async () => {
  const { cwd, logFile } = createFakeAcpx('timeout')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.probeAgent('fake-agent --acp', {
      sessionName: 'aamp-readiness-timeout',
      timeoutMs: 1_000,
    }),
    /timed out after 1000ms/,
  )

  assert.match(
    readFileSync(logFile, 'utf8'),
    /sessions close aamp-readiness-timeout/,
  )
})

test('probeAgent retries cleanup after a temporary close failure', async () => {
  const { cwd, logFile } = createFakeAcpx('close-retry')
  const client = new AcpxClient(cwd)

  await client.probeAgent('fake-agent --acp', {
    sessionName: 'aamp-readiness-close-retry',
    timeoutMs: 5_000,
  })

  const closeCommands = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((command) => command.includes('sessions close'))
  assert.equal(closeCommands.length, 2)
})

test('prompt rejects an authentication message even when the agent exits successfully', async () => {
  const { cwd } = createFakeAcpx('auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /Authentication required/,
  )
})

test('prompt rejects a stderr authentication line even after partial stdout and warnings', async () => {
  const { cwd } = createFakeAcpx('auth-with-output')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /^Error: Authentication required$/,
  )
})

test('prompt rejects a bare authentication message from a JSON-RPC error', async () => {
  const { cwd } = createFakeAcpx('json-auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-workbuddy', 'hello'),
    /^Error: Authentication required$/,
  )
})

test('prompt rejects a structured AIME AUTH_REQUIRED response with safe login guidance', async () => {
  const { cwd } = createFakeAcpx('json-aime-auth-failure')
  const client = new AcpxClient(cwd)

  await assert.rejects(
    client.prompt('fake-agent --acp', 'aamp-aime', 'hello'),
    {
      message: 'AUTH_REQUIRED: Managed user authentication is required. Run `aime-acp auth login --site cn`.',
    },
  )
})

test('prompt preserves normal replies that merely discuss authentication errors', async () => {
  const { cwd } = createFakeAcpx('auth-discussion')
  const client = new AcpxClient(cwd)

  const result = await client.prompt('fake-agent --acp', 'aamp-workbuddy', 'explain auth errors')

  assert.equal(result.output, 'The phrase authentication required may appear in diagnostic logs.')
})

test('final assistant selection does not reserve the AIME Sources message id by itself', () => {
  const messages = new Map([
    ['aime-sources', 'AAMP_RESULT_JSON: legitimate final answer'],
  ])

  assert.equal(
    selectFinalAssistantOutput(messages, ['aime-sources']),
    'AAMP_RESULT_JSON: legitimate final answer',
  )
})

test('prompt excludes only meta-marked AIME Sources while preserving the original protocol result', async () => {
  const { cwd } = createFakeAcpx('json-aime-sources')
  const client = new AcpxClient(cwd)
  const chunks: string[] = []

  const result = await client.prompt('fake-agent --acp', 'aamp-aime', 'weather', {
    onTextChunk: ({ text }) => chunks.push(text),
  })

  assert.equal(
    result.output,
    'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\",\\"summary\\":\\"成都天气\\",\\"reply_written\\":false}"}',
  )
  assert.equal(JSON.parse(result.output.slice('AAMP_RESULT_JSON: '.length)).output.startsWith('FEISHU_TASK_RESULT_JSON: '), true)
  assert.deepEqual(chunks, [
    result.output,
    'Sources:\n- [Guide](https://example.test/guide)',
  ])
})

 test('Windows raw command launches acpx with registered argv alias while POSIX stays raw', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { cwd, logFile } = createFakeAcpx('success')
    const client = new AcpxClient(cwd, { platform })
    const command = '"C:\\Program Files\\node.exe" "C:\\工具 & data\\wrapper.mjs" "C:\\config.json"'
    await client.ensureSession(command, 'argv-integration')
    const logged = readFileSync(logFile, 'utf8')
    if (platform === 'win32') {
      const argv = parseWindowsAgentArgv(command)
      const alias = windowsAgentAlias(argv)
      assert.ok(logged.includes(alias))
      assert.ok(!logged.includes('--agent'))
      const config = JSON.parse(readFileSync(join(cwd, '.acpxrc.json'), 'utf8'))
      assert.deepEqual(config.agents[alias], { argv })
    } else {
      assert.ok(logged.includes('--agent ' + command))
      assert.equal(existsSync(join(cwd, '.acpxrc.json')), false)
    }
  }
})

for (const tree of [false, true]) {
  test(`native ACP CIM ${tree ? 'tree' : 'identity'} verifies exits and reuse but preserves live failures`, { skip: process.platform !== 'win32' }, async () => {
    const { execFileSync } = await import('node:child_process')
    const { WINDOWS_PROCESS_IDENTITY_SCRIPT, WINDOWS_PROCESS_TREE_SCRIPT } = await import('./acpx-client.js')
    const fixture = String.raw`
$script:reads = 0
$script:snapshot = [pscustomobject]@{ ProcessId=10384; ParentProcessId=1; CreationDate=[datetime]::Parse('2026-09-08T01:00:00Z'); ExecutablePath='C:\node.exe' }
if ($env:AAMP_CIM_RACE -like 'image-*') { $script:snapshot.ExecutablePath = '' }
function Get-CimInstance {
  $script:reads++
  if ($env:AAMP_CIM_RACE -like 'image-*' -and $script:reads -le 2) { return $script:snapshot }
  if ($env:AAMP_CIM_RACE -like 'image-*' -and $script:reads -gt 2) {
    if ($env:AAMP_CIM_RACE -eq 'image-gone') { return $null }
    if ($env:AAMP_CIM_RACE -eq 'image-reused') { return [pscustomobject]@{ ProcessId=10384; CreationDate=$script:snapshot.CreationDate.AddSeconds(1); ExecutablePath='C:\replacement.exe' } }
    if ($env:AAMP_CIM_RACE -eq 'image-recovered') { $script:snapshot.ExecutablePath = 'C:\node.exe' }
  }
  if ($script:reads -eq 1) { return $script:snapshot }
  if ($env:AAMP_CIM_RACE -eq 'reread-failure') { throw 'CIM reread denied' }
  if ($env:AAMP_CIM_RACE -like '*gone') { return $null }
  if ($env:AAMP_CIM_RACE -like '*reused') { return [pscustomobject]@{ ProcessId=10384; CreationDate=$script:snapshot.CreationDate.AddSeconds(1) } }
  return $script:snapshot
}
function Invoke-CimMethod {
  if ($env:AAMP_CIM_RACE -like 'error-*') { throw 'GetOwnerSid fixture failure' }
  if ($env:AAMP_CIM_RACE -eq 'return-code-live') { return [pscustomobject]@{ ReturnValue=2; Sid='' } }
  return [pscustomobject]@{ ReturnValue=0; Sid='S-1-5-21-1000' }
}
`
    const script = fixture + (tree ? WINDOWS_PROCESS_TREE_SCRIPT : WINDOWS_PROCESS_IDENTITY_SCRIPT)
    const run = (scenario: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, AAMP_CIM_RACE: scenario, AAMP_ACP_WINDOWS_INPUT_BASE64: Buffer.from(JSON.stringify({ pid: 10384 })).toString('base64') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const scenario of ['error-gone', 'error-reused', 'success-gone', 'success-reused', 'image-gone', 'image-reused']) {
      if (tree) assert.deepEqual(JSON.parse(run(scenario)), { processes: [] })
      else assert.throws(() => run(scenario), (error: unknown) => (error as { status: number }).status === 3)
    }
    const live = JSON.parse(run('success-live'))
    assert.equal((tree ? live.processes[0] : live).pid, 10384)
    const recovered = JSON.parse(run('image-recovered'))
    assert.equal((tree ? recovered.processes[0] : recovered).executablePath, 'C:\\node.exe')
    for (const scenario of ['error-live', 'return-code-live', 'reread-failure']) assert.throws(() => run(scenario))
  })
}

for (const fallback of [false, true]) for (const legacyText of [false, true]) {
  test(`Windows long prompt uses ${legacyText ? 'legacy text' : 'JSON'} stdin with ${fallback ? 'npx fallback' : 'direct acpx'}`, async () => {
    const { cwd, logFile } = createFakeAcpx('auth-discussion')
    const fixtureEntry = join(cwd, 'node_modules', '.bin', 'acpx.cjs')
    const attempts: string[] = []
    const client = new AcpxClient(cwd, {
      platform: 'win32',
      resolveCommand: command => {
        attempts.push(command)
        return fallback && command === 'acpx'
          ? { command: join(cwd, 'missing-acpx.exe'), argsPrefix: [] }
          : { command: process.execPath, argsPrefix: [fixtureEntry] }
      },
    })
    const prompt = '[{"type":"text","text":"literal, never reinterpret"}]\n' + '中文 "quotes" & %PATH% ^ (data)\n'.repeat(1200)
    const result = legacyText
      ? await client['promptTextMode']('fake-agent --acp', 'long-native-prompt', prompt)
      : await client.prompt('fake-agent --acp', 'long-native-prompt', prompt)
    assert.equal(result.output, 'The phrase authentication required may appear in diagnostic logs.')
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'stdin.json'), 'utf8')), [{ type: 'text', text: prompt.trim() }])
    const args = readFileSync(logFile, 'utf8')
    assert.match(args, /--file -/)
    assert.ok(args.length < 1000)
    assert.equal(args.includes('literal, never reinterpret'), false)
    const oneAttempt = fallback ? ['acpx', 'npx'] : ['acpx']
    assert.deepEqual(attempts, oneAttempt)
    assert.doesNotMatch(readFileSync(join(cwd, 'stdin.json'), 'utf8'), /[^\x00-\x7f]/)
    await client.stop()
  })
}

test('Windows prompt rejects when the child closes stdin before accepting the payload', async () => {
  const { cwd } = createFakeAcpx('success')
  const entry = join(cwd, 'close-input.mjs')
  writeFileSync(entry, 'process.stdin.destroy(); setTimeout(() => process.exit(0), 10)')
  const client = new AcpxClient(cwd, {
    platform: 'win32',
    resolveCommand: () => ({ command: process.execPath, argsPrefix: [entry] }),
  })
  await assert.rejects(client.prompt('fake-agent --acp', 'closed-input', 'x'.repeat(2_000_000)), /EPIPE|pipe|stream|ECONNRESET|EOF/i)
  await client.stop()
})


test('Windows failed stdin delivery terminates the exact child that remains running', { timeout: 60_000 }, async (t) => {
  const { cwd } = createFakeAcpx('success')
  const entry = join(cwd, 'hold-after-input-close.mjs')
  const pidFile = join(cwd, 'held.pid')
  const closeInput = process.platform === 'win32' ? '' : 'closeSync(0);'
  writeFileSync(entry, `import { writeFileSync, closeSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); ${closeInput} setInterval(() => {}, 1000)`)
  const client = new AcpxClient(cwd, {
    platform: 'win32',
    resolveCommand: () => ({ command: process.execPath, argsPrefix: [entry] }),
  })
  t.after(async () => { await client.stop() })
  try {
    const execution = client.prompt('fake-agent --acp', 'held-input', 'x'.repeat(2_000_000))
    void execution.catch(() => {})
    const ownedClosed = [...client['activeProcesses'].values()]
    assert.equal(ownedClosed.length, 1, 'capture the owned close lifecycle before injecting failure')
    if (process.platform === 'win32') {
      const deadline = Date.now() + 10_000
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(existsSync(pidFile), 'owned fixture must become ready within the bound')
      const pid = Number(readFileSync(pidFile, 'utf8'))
      const proc = [...client['activeProcesses'].keys()].find(child => child.pid === pid)
      assert.ok(proc, 'inject failure only into the exact tracked fixture')
      // Windows CRT fd0 closure does not close the inherited libuv pipe.
      // The preceding test covers real pipe failure; this drives cleanup while
      // a real verified Windows child deliberately remains alive.
      proc.stdin.destroy(Object.assign(new Error('EPIPE: controlled fixture input failure'), { code: 'EPIPE' }))
    }
    await assert.rejects(execution, /EPIPE|pipe|stream|ECONNRESET|EOF/i)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // Cleanup drains an in-flight CIM snapshot (10s), verifies identity, and
    // runs bounded taskkill. Wait for the actual owned close lifecycle first.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(ownedClosed),
        new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('owned EPIPE cleanup did not close within 45s')), 45_000) }),
      ])
    } finally { if (cleanupTimer) clearTimeout(cleanupTimer) }
    await waitForProcessExit(pid)
    assert.equal(client['activeProcesses'].size, 0)
  } finally {
    await client.stop()
  }
})

for (const platform of ['darwin', 'linux'] as const) {
  test(`ACP preserves case-sensitive PATH variables on ${platform}`, () => {
    const env = buildAcpxEnvironment('/workspace', {Path:'/custom', PATH:'/usr/bin', path:'/other'}, platform)
    assert.equal(env.PATH, '/workspace/node_modules/.bin:/usr/bin')
    assert.equal(env.Path, '/custom')
    assert.equal(env.path, '/other')
  })
}


test('Windows cleanup reports unavailable identity without killing or exposing query output', () => {
  const expected: WindowsProcessIdentity = { pid: 4312, creationDate: '2026-09-08T01:00:00Z', executablePath: 'C:\node.exe', ownerSid: 'S-1-5-21-1000' }
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => { warnings.push(message) }
  try {
    const outcome = terminateWindowsProcessTree(expected, () => ({ status: 'unknown', reason: 'query-timeout' }), (() => { assert.fail('unknown identity must not be killed') }) as never)
    assert.equal(outcome, 'unconfirmed')
    assert.deepEqual(warnings, ['Windows cleanup unconfirmed for PID 4312: query-timeout'])
  } finally { console.warn = original }
})

for (const tree of [false, true]) {
  test(`native ACP ${tree ? 'tree' : 'identity'} recovers a live image through a pinned native handle`, { skip: process.platform !== 'win32' }, async () => {
    const { execFileSync } = await import('node:child_process')
    const { WINDOWS_PROCESS_IDENTITY_SCRIPT, WINDOWS_PROCESS_TREE_SCRIPT } = await import('./acpx-client.js')
    const fixture = String.raw`
$ErrorActionPreference = 'Stop'
$script:targetPid = $PID
$script:actual = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID)
$script:expectedImage = $script:actual.ExecutablePath
$script:reads = 0
$env:AAMP_ACP_WINDOWS_INPUT_BASE64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('{"pid":' + $PID + '}')))
function Get-CimInstance {
  $script:reads++
  $value = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $script:targetPid)
  # Mask only the image field on a detached view: native CIM properties are read-only.
  return $value | Select-Object ProcessId, ParentProcessId, CreationDate, @{Name='ExecutablePath';Expression={''}}
}
function Invoke-CimMethod {
  param($InputObject, $MethodName)
  $native = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$InputObject.ProcessId)
  if ($native.CreationDate.ToUniversalTime().Ticks -ne $InputObject.CreationDate.ToUniversalTime().Ticks) {
    throw 'fixture process identity changed'
  }
  return CimCmdlets\Invoke-CimMethod -InputObject $native -MethodName $MethodName
}
`
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture + (tree ? WINDOWS_PROCESS_TREE_SCRIPT : WINDOWS_PROCESS_IDENTITY_SCRIPT) + "\nif ($script:reads -lt 8) { throw 'bounded image rereads were skipped' }", 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    const parsed = JSON.parse(result)
    const identity = tree ? parsed.processes[0] : parsed
    assert.ok(identity.pid > 0)
    assert.match(identity.executablePath, /powershell\.exe$/i)
    assert.match(identity.ownerSid, /^S-1-/)
  })
}
