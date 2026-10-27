import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(path.join(tmpdir(), 'aamp-remote-pending-pairing-'))
const runtimeHome = path.join(root, 'runtime-v1')
const stateHome = path.join(root, 'state')
const runLogDir = path.join(root, 'logs')
mkdirSync(runtimeHome, { recursive: true })

const previousEnvironment = Object.fromEntries([
  'AAMP_TASK_RUNTIME_HOME',
  'AAMP_TASK_STATE_HOME',
  'AAMP_RUN_LOG_DIR',
].map((name) => [name, process.env[name]]))
process.env.AAMP_TASK_RUNTIME_HOME = runtimeHome
process.env.AAMP_TASK_STATE_HOME = stateHome
process.env.AAMP_RUN_LOG_DIR = runLogDir

const controllerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/feishu-task-agent-controller.mjs',
)
const controller = await import(`${pathToFileURL(controllerPath).href}?remote-pending-pairing=${Date.now()}`)

after(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function remotePrepared(caseName) {
  const agentHome = path.join(runtimeHome, 'agent-bridges', caseName, 'agents', 'aime')
  mkdirSync(agentHome, { recursive: true })
  const pairingFile = path.join(agentHome, 'pairing.json')
  const originalBinding = {
    binding_id: '11111111-1111-4111-8111-111111111111',
    agent_type: 'aime',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: { app_id: 'cli_aime', app_secret: 'test-secret' },
    feishu_config_dir: path.join(runtimeHome, 'bindings', '11111111-1111-4111-8111-111111111111', 'feishu-bridge'),
    state: 'pending',
  }
  const binding = {
    ...originalBinding,
    state: 'ready',
    agent_target_email: 'aime@meshmail.ai',
  }
  return {
    pairingFile,
    prepared: {
      originalBinding,
      binding,
      group: {
        host: 'https://meshmail.ai',
        home: path.join(runtimeHome, 'agent-bridges', caseName),
        configFile: path.join(runtimeHome, 'agent-bridges', caseName, 'config.json'),
        logFile: path.join(runLogDir, `${caseName}.jsonl`),
        agents: [{ name: 'aime', pairingFile }],
      },
      mode: 'install',
      pending: true,
      email: 'aime@meshmail.ai',
      runtimeAgentType: 'aime',
      preparedFeishu: { binding, phase: 'install', runtimeAgentType: 'aime' },
    },
  }
}

function lifecycleOperations(pairingOutputs, expectedPairingFile) {
  const starts = []
  let pairIndex = 0
  return {
    starts,
    operations: {
      runCapture: async () => ({ stdout: JSON.stringify(pairingOutputs[pairIndex++]), stderr: '' }),
      parseJsonDocument: JSON.parse,
      resolveConfiguredPendingPairingFile: controller.resolveConfiguredPendingPairingFile,
      resolvePendingPairingFile: controller.resolvePendingPairingFile,
      startPreparedFeishuUntilReady: async (_preparedFeishu, target, options) => {
        assert.deepEqual(target, {
          pairingUrl: 'aamp://connect?mailbox=aime%40meshmail.ai&pair_code=test',
        })
        assert.equal(options.pairingFile, expectedPairingFile)
        starts.push(options)
        return { label: 'Feishu Bridge', exited: false }
      },
      readInitialRuntimeMetadata: async () => ({
        im_config_dir: path.join(runtimeHome, 'bindings', 'runtime', 'im'),
        task_config_dir: path.join(runtimeHome, 'bindings', 'runtime', 'task'),
        feishu_bridge_email: 'feishu@meshmail.ai',
      }),
      validateSavedRuntime: async () => {},
      updateBinding: async () => {},
      setBindingStatus: async () => {},
      stopManagedProcess: async () => {},
      throwIfStopping: () => {},
    },
  }
}

test('remote pending binding accepts the private-path marker and never lets a public raw path override the trusted agent path', async () => {
  const { pairingFile, prepared } = remotePrepared('trusted-path')
  const connectUrl = 'aamp://connect?mailbox=aime%40meshmail.ai&pair_code=test'
  const forgedPublicPath = path.join(root, 'forged-public-pairing.json')
  const harness = lifecycleOperations([
    {
      type: 'pairing.created',
      agent: 'aime',
      mailbox: 'aime@meshmail.ai',
      connectUrl,
      pairingFileConfigured: true,
    },
    {
      type: 'pairing.created',
      agent: 'aime',
      mailbox: 'aime@meshmail.ai',
      connectUrl,
      pairingFileConfigured: true,
      pairingFile: forgedPublicPath,
    },
  ], pairingFile)

  await controller.executePreparedPendingBindingStart(prepared, harness.operations)
  await controller.executePreparedPendingBindingStart(prepared, harness.operations)

  assert.equal(harness.starts.length, 2)
  assert.equal(harness.starts.every(({ pairingFile: used }) => used === pairingFile), true)
  assert.equal(harness.starts.some(({ pairingFile: used }) => used === forgedPublicPath), false)
})

test('remote pending binding requires the private-path marker even when a raw path is present', async () => {
  const { pairingFile, prepared } = remotePrepared('missing-marker')

  await assert.rejects(
    controller.resolvePendingPairingFile(prepared.group, 'aime', { pairingFile }),
    /未确认远程 Agent 的私有配对文件配置/,
  )
})

test('remote pending binding rejects a private pairing file outside its exact Agent Bridge runtime before launch', async () => {
  const { prepared } = remotePrepared('escaped-path')
  const escapedPairingFile = path.join(runtimeHome, 'other-agent-bridge', 'pairing.json')
  prepared.group.agents[0].pairingFile = escapedPairingFile
  const harness = lifecycleOperations([{
    type: 'pairing.created',
    agent: 'aime',
    mailbox: 'aime@meshmail.ai',
    connectUrl: 'aamp://connect?mailbox=aime%40meshmail.ai&pair_code=test',
    pairingFileConfigured: true,
  }], escapedPairingFile)

  await assert.rejects(
    controller.executePreparedPendingBindingStart(prepared, harness.operations),
    /私有配对文件不属于当前 Agent Bridge runtime/,
  )
  assert.equal(harness.starts.length, 0)
})

test('remote pending binding rejects a symlinked trusted pairing file before launch', async (t) => {
  const { pairingFile, prepared } = remotePrepared('symlinked-path')
  const symlinkTarget = path.join(root, 'outside-pairing.json')
  const externalSentinel = 'external-pairing-sentinel'
  writeFileSync(symlinkTarget, externalSentinel)
  try {
    symlinkSync(symlinkTarget, pairingFile)
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows account cannot create symlinks without Developer Mode or the symlink privilege')
      return
    }
    throw error
  }
  const harness = lifecycleOperations([{
    type: 'pairing.created',
    agent: 'aime',
    mailbox: 'aime@meshmail.ai',
    connectUrl: 'aamp://connect?mailbox=aime%40meshmail.ai&pair_code=test',
    pairingFileConfigured: true,
  }], pairingFile)
  let pairInvocations = 0
  harness.operations.runCapture = async () => {
    pairInvocations += 1
    writeFileSync(pairingFile, 'pair-overwrite')
    return {
      stdout: JSON.stringify({
        type: 'pairing.created',
        agent: 'aime',
        mailbox: 'aime@meshmail.ai',
        connectUrl: 'aamp://connect?mailbox=aime%40meshmail.ai&pair_code=test',
        pairingFileConfigured: true,
      }),
      stderr: '',
    }
  }

  await assert.rejects(
    controller.executePreparedPendingBindingStart(prepared, harness.operations),
    /拒绝使用包含符号链接的 runtime 路径/,
  )
  assert.equal(pairInvocations, 0)
  assert.equal(readFileSync(symlinkTarget, 'utf8'), externalSentinel)
  assert.equal(harness.starts.length, 0)
})

test('local pending binding requires the public pairing path to match the trusted private configuration', async () => {
  const { pairingFile, prepared } = remotePrepared('local-consistency')
  prepared.group.agents[0].name = 'codex'
  const forgedPublicPath = path.join(prepared.group.home, 'agents', 'codex', 'forged.json')

  await assert.rejects(
    controller.resolvePendingPairingFile(prepared.group, 'codex', {
      pairingFile: forgedPublicPath,
    }),
    /本地配对文件与私有配置不一致/,
  )
  assert.equal(
    await controller.resolvePendingPairingFile(prepared.group, 'codex', { pairingFile }),
    pairingFile,
  )
})
