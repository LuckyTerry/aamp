import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FINAL_PACKAGED_AIME_IDENTITY,
  runBounded,
  runPackagedAimeBridgeProof,
} from './aime-packaged-harness.js'
import { FakeRemoteSessions, fakeEventOffset } from './aime-packaged-fake-support.mjs'

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))

test('tracked packaged evidence pins the final source and tarball identity', async () => {
  const evidenceFiles = await Promise.all([
    readFile(join(TEST_DIRECTORY, 'aime-packaged-harness.ts'), 'utf8'),
    readFile(join(TEST_DIRECTORY, '../../../docs/aime-acp/generic-bridge-smoke.md'), 'utf8'),
    readFile(join(TEST_DIRECTORY, '../../../docs/aime-acp/e2e-report.md'), 'utf8'),
  ])
  const expected = [
    'b3c43ae9e2c3a8d8fa14ef4ef207e09cb079305d',
    '17119558e9df225707e288320b2fea2a1baaa5bf',
    '723c15fa63e28d68c2621b859af7f25b2b7115c2aad01d01843c7b30105cf8b1',
    'fdfb89fa5abf7ffadbcd78a9225e2a5dfed5a89f',
    'sha512-pQUImtXGIdYiO6hi1+KrOtJRBC1Kn4M46pDd3+oVgWrzkK/2C1sWKz6OwnAVARBHtVAglfjJTrKHyMZ9LotSZQ==',
  ]
  for (const content of evidenceFiles) {
    for (const identity of expected) {
      assert.equal(content.includes(identity), true, `tracked evidence is missing ${identity}`)
    }
  }

  const stale = [
    '9d72777ecb8e29cd8ac4aa695777723c3ec9995f',
    '10684a7e0baa0bd3217657c24e93eb65144f25fb',
    'f7cf3a66e59747a654683a504f5f37a84634cd0b',
    '983367cc0cdf1e871b26edad6d945dea5a519d5b61da5500b075c1e7ffadd7cd',
    'sha512-1ajz9SRIJsZmPy/LaNhuLR3nt/kgvYxbRsHEyzb9pTP20MXEaX/+fklZZc5z6bYNnYJfWa8M1CODDFhK5xVe4A==',
    '5649f19363839ad4fedfddf8b862737ba6638637',
    '8edb91e8fa13dcd0399ac4a521fbf27a2e59d8448e77d64acf5a95594808c111',
    '1edd79bf5a90e72c770dc48f2f415cc8f871ba04',
    'sha512-4X3lT05OoUaG0tXQ/H/+jUTrQNT6CYh9oQ2iNDejWZy4DFDMeP4YyODYAdmfw1WTyvoZ7QJDaENNUjmGe+OA/w==',
  ]
  for (const content of evidenceFiles) {
    for (const identity of stale) {
      assert.equal(content.includes(identity), false, `tracked evidence retained stale identity ${identity}`)
    }
  }
})

test('tracked Feishu contract distinguishes deterministic remote attachment coverage from the live gate', async () => {
  const contract = await readFile(
    join(TEST_DIRECTORY, '../../../docs/aime-acp/feishu-task-bridge-contract.md'),
    'utf8',
  )

  for (const staleClaim of [
    /current one-click[\s\S]{0,180}(?:do not set|omit)/i,
    /not a current one-click fact/i,
    /Attachment privacy gate:\s*\*{0,2}FAIL\s*\/\s*not configured/i,
    /required explicit\s+`?reject`?\s+binding is absent/i,
    /failing\/unconfigured\s+AIME attachment-privacy gate/i,
  ]) {
    assert.doesNotMatch(contract, staleClaim)
  }

  assert.match(contract, /deterministic one-click\/controller\/bootstrap coverage/i)
  assert.match(contract, /`attachmentPolicy:\s*reject`/)
  assert.match(contract, /`taskDispatchConcurrency:\s*1`/)
  assert.match(contract, /rejects incoming\s+attachment metadata before download, AAMP, or ACP dispatch/i)
  assert.match(contract, /configuration wiring and deterministic pre-dispatch behavior only/i)
  assert.match(contract, /Deployment mapping remains \*\*BLOCKED \/ NOT PROVIDED\*\*/i)
  assert.match(contract, /live visible\s+Feishu attachment-rejection chain remains \*\*BLOCKED \/ NOT RUN\*\*/i)
})

async function waitForFixtureReady(path: string): Promise<{ pid: number }> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(path, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid?: unknown; state?: unknown })
      const ready = records.find((record) => record.state === 'ready')
      if (Number.isSafeInteger(ready?.pid) && (ready?.pid as number) > 1) {
        return { pid: ready!.pid as number }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10))
  }
  throw new Error('timed out waiting for TERM-resistant fixture')
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10))
  }
  if (processExists(pid)) throw new Error('fixture process did not exit')
}

test('runBounded retains child close through TERM to KILL timeout cleanup', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-run-bounded-'))
  const statePath = join(root, 'child-state.jsonl')
  const termExitStatePath = join(root, 'term-exit-state.jsonl')
  const ordering: string[] = []
  let pid = 0
  const execution = runBounded(
    process.execPath,
    [join(TEST_DIRECTORY, 'aime-packaged-ignore-term-child.mjs'), statePath],
    {
      cwd: root,
      timeoutMs: 500,
      onChildCloseObserved: () => { ordering.push('close') },
    },
  )
  void execution.then(
    () => { ordering.push('settled') },
    () => { ordering.push('settled') },
  )

  try {
    pid = (await waitForFixtureReady(statePath)).pid
    await assert.rejects(execution, /bounded child timed out/)
    assert.deepEqual(ordering, ['close', 'settled'])
    assert.equal(processExists(pid), false)
    const trace = await readFile(statePath, 'utf8')
    assert.match(trace, /"state":"sigterm-ignored"/)

    let termExitPid = 0
    const termExitExecution = runBounded(
      process.execPath,
      [
        join(TEST_DIRECTORY, 'aime-packaged-ignore-term-child.mjs'),
        termExitStatePath,
        'exit-on-term',
      ],
      { cwd: root, timeoutMs: 300 },
    )
    const termExitOutcome = termExitExecution.then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error: Error) => ({ kind: 'rejected' as const, error }),
    )
    try {
      termExitPid = (await waitForFixtureReady(termExitStatePath)).pid
      const outcome = await termExitOutcome
      assert.equal(outcome.kind, 'rejected')
      if (outcome.kind === 'rejected') assert.match(outcome.error.message, /bounded child timed out/)
      assert.equal(processExists(termExitPid), false)
      assert.match(await readFile(termExitStatePath, 'utf8'), /"state":"sigterm-exit"/)
    } finally {
      if (termExitPid > 1 && processExists(termExitPid)) {
        try { process.kill(termExitPid, 'SIGKILL') } catch { /* exact owned fixture cleanup */ }
        await waitForProcessExit(termExitPid)
      }
    }

    await assert.rejects(
      runBounded(join(root, 'missing-executable'), [], { cwd: root, timeoutMs: 500 }),
      (error: Error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )
  } finally {
    if (pid > 1 && processExists(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* exact owned fixture cleanup */ }
      await waitForProcessExit(pid)
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('test-only AIME fake preserves exact offsets and remote session identity', () => {
  assert.equal(fakeEventOffset({ data: { event_offset: 7 } }), 7)
  assert.equal(fakeEventOffset({
    type: 'unknown',
    data: { raw: { event_offset: 8 } },
  }), 8)

  const originalProcess = new FakeRemoteSessions(41001)
  const first = originalProcess.create('safe-remote-space')
  const second = originalProcess.create('safe-remote-space')
  assert.notEqual(first.id, second.id)

  const continuationProcess = new FakeRemoteSessions(41002)
  assert.equal(
    continuationProcess.load(first.id, 'safe-remote-space').id,
    first.id,
  )
  assert.deepEqual(continuationProcess.createdIds, [])
})

test('packaged aime-acp preserves the generic AAMP bridge contract', { timeout: 600_000 }, async () => {
  const evidence = await runPackagedAimeBridgeProof()

  assert.deepEqual(evidence.scenarios, [
    'text-streaming',
    'completed-continuation',
    'help-continuation',
    'attachment-reject',
    'cancel-drain-follow-up',
    'same-session-concurrency',
  ])
  assert.equal(evidence.packageVersion, FINAL_PACKAGED_AIME_IDENTITY.packageVersion)
  assert.equal(evidence.acpxVersion, '0.11.2')
  assert.equal(evidence.bytedcliVersion, '0.123.0')
  assert.deepEqual(evidence.completedResultContract, {
    turns: 2,
    visibleOuterEnvelopes: true,
    forwardedInnerMarkers: true,
    schemaV2: true,
    dispositionKinds: ['answered', 'answered'],
    summaries: ['Synthetic first-turn answer.', 'Synthetic follow-up answer.'],
    replyWritten: [false, false],
    commentRequired: [true, true],
    completionRequired: [true, true],
  })
  assert.equal(evidence.tarballSha256, FINAL_PACKAGED_AIME_IDENTITY.tarballSha256)
  assert.equal(evidence.npmShasum, FINAL_PACKAGED_AIME_IDENTITY.npmShasum)
  assert.equal(evidence.npmIntegrity, FINAL_PACKAGED_AIME_IDENTITY.npmIntegrity)
  assert.equal(evidence.entryCount, FINAL_PACKAGED_AIME_IDENTITY.entryCount)
  assert.equal(evidence.packedSize, FINAL_PACKAGED_AIME_IDENTITY.packedSize)
  assert.equal(evidence.unpackedSize, FINAL_PACKAGED_AIME_IDENTITY.unpackedSize)
  assert.equal(evidence.productionBridgeCommit, FINAL_PACKAGED_AIME_IDENTITY.productionBridgeCommit)
  assert.equal(evidence.coreCommit, FINAL_PACKAGED_AIME_IDENTITY.coreCommit)
  assert.deepEqual(evidence.counts, {
    streams: 9,
    results: 7,
    helps: 2,
    remoteCreates: 6,
    remoteSends: 9,
    remoteCancels: 1,
  })
  assert.deepEqual(evidence.stopReasons, ['cancelled', 'end_turn', 'help_needed'])
  assert.deepEqual(evidence.installedBridge, {
    packageVersion: '0.1.28-dev.21',
    jsonInitExecutionLocation: 'remote',
    runtime: 'installed-package',
  })
  assert.deepEqual(evidence.completedTurnContract, {
    turns: 2,
    reusedRemoteSession: true,
    bothCompleted: true,
    remoteSandbox: true,
    remoteNativeCapabilities: true,
    invariantAampResultJson: true,
    invariantFeishuTaskResultJson: true,
    localLarkCliProfileRules: false,
    localEnvironmentSource: false,
    localFileMarker: false,
    localFilePathGuidance: false,
    secretEvidence: false,
    callerCwdEvidence: false,
    rawAcpCommandEvidence: false,
    localProfileEvidence: false,
  })
  assert.deepEqual(evidence.promptContract, {
    turns: 2,
    reusedRemoteSession: true,
    remoteSandbox: true,
    remoteNativeCapabilities: true,
    invariantAampResultJson: true,
    invariantFeishuTaskResultJson: true,
    localLarkCliProfileRules: false,
    localEnvironmentSource: false,
    localFileMarker: false,
    localFilePathGuidance: false,
    secretEvidence: false,
    callerCwdEvidence: false,
    rawAcpCommandEvidence: false,
    localProfileEvidence: false,
  })
  assert.equal(evidence.promptFingerprints.length, 4)
  assert.notEqual(evidence.promptFingerprints[0], evidence.promptFingerprints[1])
  for (const fingerprint of evidence.promptFingerprints) {
    assert.match(fingerprint, /^[a-f0-9]{64}$/)
  }
  assert.equal(evidence.cleanup.ownedProcesses, 0)
  assert.equal(evidence.cleanup.tempRootRemoved, true)
})
