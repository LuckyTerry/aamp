import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const controllerPath = path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs')
const root = mkdtempSync(path.join(tmpdir(), 'aamp-binding-persistence-'))
const stateHome = path.join(root, 'state')
const runtimeHome = path.join(stateHome, 'runtime-v1')
const configFile = path.join(stateHome, 'bindings-v1.json')

process.env.AAMP_TASK_STATE_HOME = stateHome
process.env.AAMP_TASK_RUNTIME_HOME = runtimeHome
process.env.AAMP_TASK_CONFIG_FILE = configFile
process.env.AAMP_RUN_LOG_DIR = path.join(root, 'logs')

const controller = await import(pathToFileURL(controllerPath).href)

after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(stateHome, { recursive: true, force: true })
  mkdirSync(stateHome, { recursive: true })
})

function expectedFeishuConfigDir(bindingId) {
  return path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge')
}

function expectedRuntime(bindingId) {
  const bindingHome = expectedFeishuConfigDir(bindingId)
  return {
    im_config_dir: path.join(bindingHome, 'task-runtime', 'instances', 'im'),
    task_config_dir: path.join(bindingHome, 'task-runtime', 'instances', 'task'),
    feishu_bridge_email: `${bindingId}@meshmail.ai`,
  }
}

function pendingBinding(bindingId, appId) {
  return {
    binding_id: bindingId,
    agent_type: 'codex',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: {
      app_id: appId,
      app_secret: `secret-${appId}`,
      display_name: appId,
      lark_cli_profile: `profile-${appId}`,
    },
    feishu_config_dir: expectedFeishuConfigDir(bindingId),
    state: 'pending',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
  }
}

function readyBinding(bindingId, appId) {
  return {
    ...pendingBinding(bindingId, appId),
    state: 'ready',
    agent_target_email: `${bindingId}@meshmail.ai`,
    runtime: expectedRuntime(bindingId),
  }
}

function writeStore(bindings) {
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings,
  }, null, 2)}\n`)
}

function readStore() {
  return JSON.parse(readFileSync(configFile, 'utf8'))
}

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

test('sameBindingRelationship ignores credentials labels and runtime metadata', () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  const candidate = pendingBinding('22222222-2222-4222-8222-222222222222', 'cli_same')
  candidate.bot.app_secret = 'rotated-secret'
  candidate.bot.lark_cli_profile = 'new-local-profile'
  candidate.bot.display_name = 'Renamed Bot'
  candidate.created_at = '2026-08-13T01:00:00.000Z'
  candidate.updated_at = '2026-08-13T01:00:00.000Z'

  assert.equal(controller.sameBindingRelationship(existing, candidate), true)
})

test('sameBindingRelationship rejects every routing-field difference', () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  const candidate = pendingBinding('22222222-2222-4222-8222-222222222222', 'cli_same')
  const changed = [
    ['agent_type', { ...candidate, agent_type: 'cursor' }],
    ['aamp_host', { ...candidate, aamp_host: 'https://other.meshmail.ai' }],
    ['environment.name', { ...candidate, environment: { name: 'boe' } }],
    ['bot.app_id', { ...candidate, bot: { ...candidate.bot, app_id: 'cli_other' } }],
  ]

  for (const [field, value] of changed) {
    assert.equal(controller.sameBindingRelationship(existing, value), false, field)
  }
})

test('upsertBindings appends new Bots without removing existing bindings', async () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_old')
  writeStore([existing])

  const fresh = pendingBinding('22222222-2222-4222-8222-222222222222', 'cli_new')
  const result = await controller.upsertBindings([{ binding: fresh, expected: undefined }])

  assert.equal(result.replacedCount, 0)
  assert.deepEqual(readStore().bindings.map(({ bot }) => bot.app_id), ['cli_old', 'cli_new'])
})

test('upsertBindings atomically replaces the approved Bot in its original position', async () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  const untouched = readyBinding('22222222-2222-4222-8222-222222222222', 'cli_keep')
  writeStore([existing, untouched])

  const replacement = pendingBinding('33333333-3333-4333-8333-333333333333', 'cli_same')
  const result = await controller.upsertBindings([{
    binding: replacement,
    expected: controller.bindingExpectation(existing),
  }])

  assert.equal(result.replacedCount, 1)
  const bindings = readStore().bindings
  assert.deepEqual(bindings.map(({ binding_id }) => binding_id), [
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ])
  assert.equal(bindings[0].state, 'pending')
  assert.equal('runtime' in bindings[0], false)
  assert.equal('agent_target_email' in bindings[0], false)
})

test('upsertBindings rejects a stale approval without partially writing the batch', async () => {
  const approved = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  writeStore([approved])
  const expectation = controller.bindingExpectation(approved)

  const changed = readyBinding('22222222-2222-4222-8222-222222222222', 'cli_same')
  changed.updated_at = '2026-08-12T22:00:00.000Z'
  writeStore([changed])

  await assert.rejects(
    controller.upsertBindings([
      {
        binding: pendingBinding('33333333-3333-4333-8333-333333333333', 'cli_same'),
        expected: expectation,
      },
      {
        binding: pendingBinding('44444444-4444-4444-8444-444444444444', 'cli_other'),
        expected: undefined,
      },
    ]),
    /绑定已发生变化，请重新执行/,
  )
  assert.deepEqual(readStore().bindings.map(({ binding_id }) => binding_id), [
    '22222222-2222-4222-8222-222222222222',
  ])
})

test('install and add silently reuse identical relationships and confirm changed ones', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const reuseStart = session.indexOf('if (existing && sameBindingRelationship(existing, draft))')
  const conflictStart = session.indexOf('else if (existing)', reuseStart)
  const acceptedStart = session.indexOf('if (accepted)', conflictStart)

  assert.notEqual(reuseStart, -1)
  assert.notEqual(conflictStart, -1)
  assert.notEqual(acceptedStart, -1)
  const reuseBranch = session.slice(reuseStart, conflictStart)
  assert.match(reuseBranch, /acceptedBinding = existing/)
  assert.doesNotMatch(reuseBranch, /confirm|bindingIntents\.push|已存在绑定|拟替换为/)

  const conflictBranch = session.slice(conflictStart, acceptedStart)
  assert.match(conflictBranch, /Bot .* 已存在绑定/)
  assert.match(conflictBranch, /拟替换为/)
  assert.match(conflictBranch, /await confirm\('是否替换绑定？', false\)/)
})

test('declining a replacement returns to the continue-selection prompt', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const duplicateStart = session.indexOf('else if (existing)')
  const acceptedStart = session.indexOf('if (accepted)', duplicateStart)
  assert.notEqual(duplicateStart, -1)
  assert.notEqual(acceptedStart, -1)
  assert.ok(duplicateStart < acceptedStart, 'replacement decision must precede accepting the binding')
  const duplicateBranch = session.slice(duplicateStart, acceptedStart)
  assert.doesNotMatch(duplicateBranch, /continue;/)
  assert.match(session, /keepGoing = await confirm\('是否继续选择智能体和 Bot？', false\)/)
})

test('selection copy allows both local and remote agents', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const create = functionRange(source, 'async function createDraft(', 'async function runBindingSession(')
  const discover = functionRange(source, 'async function discoverAgents()', 'async function createDraft(')

  assert.match(create, /请选择要绑定的智能体：/)
  assert.match(discover, /暂未检测到智能体/)
  assert.doesNotMatch(create, /请选择要绑定的本地智能体：/)
})

test('install saves draft intents then launches all accepted bindings in selection order', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const persisted = session.indexOf('await upsertBindings(bindingIntents)')
  const setup = session.indexOf('await setupAgentGroups(acceptedBindings)')

  assert.match(session, /const acceptedBindings = \[\]/)
  assert.match(session, /acceptedBindings\.push\(acceptedBinding\)/)
  assert.match(session, /selectedBindings\.push\(accepted \? acceptedBinding : draft\)/)
  assert.match(session, /if \(bindingIntents\.length\)/)
  assert.notEqual(persisted, -1)
  assert.notEqual(setup, -1)
  assert.ok(persisted < setup)
  assert.match(session, /startBindingsWithGroups\(acceptedBindings, groups, mode\)/)
  assert.doesNotMatch(session, /setupAgentGroups\(saved\)|startBindingsWithGroups\(saved/)
})

test('a failed install start keeps the already-saved pending binding', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const launchStart = session.indexOf('await startBindingsWithGroups(acceptedBindings, groups, mode)')
  assert.notEqual(launchStart, -1, 'install must launch accepted bindings')
  const launchBranch = session.slice(launchStart)
  assert.doesNotMatch(launchBranch, /removeBinding|replaceBindings/)
  assert.match(launchBranch, /failed\.push\(\.\.\.launched\.failed\)/)
})

test('install startup errors say the binding remains saved for retry', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const reporter = functionRange(source, 'function reportBindingFailure(', 'const bindingLauncherOperations = ')
  const finalizer = functionRange(source, 'async function finalizeDeferredLaunchResults(', 'async function startBindingsWithGroups(')
  const launcher = functionRange(source, 'async function startBindingsWithGroups(', 'function startupDisposition(')
  assert.match(reporter, /🔴 启动失败：\$\{bindingLabel\(binding, runtimeAgentType\)\}/)
  assert.match(reporter, /绑定配置已保存，可稍后运行 feishu-task-agent start 重试/)
  assert.match(finalizer, /operations\.reportBindingFailure\([\s\S]*item\.runtimeAgentType,[\s\S]*item\.reason,[\s\S]*mode/)
  assert.match(finalizer, /setBindingStatus\(item\.binding, 'start', 'failed', item\.reason\)/)
  assert.match(launcher, /finalizeDeferredLaunchResults\(launched, mode, operations\)/)
})

test('add accepts reused bindings without persisting or starting them', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const addBranch = session.slice(
    session.indexOf("if (mode === 'add')"),
    session.indexOf("console.log('\\n=== 建立绑定并启动 ===')"),
  )
  const runAdd = functionRange(source, 'async function runAdd()', 'async function runList()')

  assert.match(addBranch, /succeeded\.push\(\.\.\.acceptedBindings\)/)
  assert.doesNotMatch(addBranch, /setupAgentGroups|startBindingsWithGroups/)
  assert.match(runAdd, /if \(!result\.acceptedBindings\.length\)/)
})

test('install completion distinguishes accepted bindings from newly saved bindings', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const runInstall = functionRange(source, 'async function runInstall()', 'async function runAdd()')

  assert.match(runInstall, /if \(!result\.acceptedBindings\.length\)/)
  assert.match(runInstall, /\$\{result\.acceptedBindings\.length\} 个绑定配置已保存/)
})

test('saved binding output does not use the ready-state green icon', () => {
  const source = readFileSync(controllerPath, 'utf8')

  assert.match(source, /console\.log\(`已保存：\$\{bindingLabel\(binding\)\}`\)/)
  assert.doesNotMatch(source, /🟢 已保存：/)
})
