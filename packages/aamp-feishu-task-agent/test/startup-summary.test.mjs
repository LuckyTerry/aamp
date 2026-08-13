import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const controllerPath = path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs')
const {
  installHasOnlyCancellations,
  orderStartupItems,
  reconcileStartupResults,
  startupSummaryLines,
} = await import(pathToFileURL(controllerPath).href)

function binding(agentType, botName, appId) {
  return {
    agent_type: agentType,
    bot: {
      display_name: botName,
      app_id: appId,
    },
  }
}

test('partial success keeps the planned denominator and lists success then failure without a blank line', () => {
  const lines = startupSummaryLines({
    title: '已成功启动',
    plannedCount: 2,
    running: [{ binding: binding('codex', 'Codex Bot', 'cli_ok') }],
    failed: [{
      binding: binding('traex', 'Trae Bot', 'cli_bad'),
      reason: 'Trae CLI Next 未登录',
    }],
    cancelled: [],
  })

  assert.deepEqual(lines, [
    '已成功启动 1/2 个配置。',
    '启动成功：',
    '- codex ↔ Codex Bot (cli_ok)',
    '启动失败：',
    '- traex ↔ Trae Bot (cli_bad)',
    '  原因：Trae CLI Next 未登录',
  ])
  assert.doesNotMatch(lines.join('\n'), /\n\n启动失败：/)
})

test('concurrent completion order is restored to binding selection order', () => {
  const selected = [
    { binding_id: 'traex', ...binding('traex', 'Trae', 'cli_traex') },
    { binding_id: 'codex', ...binding('codex', 'Codex', 'cli_codex') },
    { binding_id: 'cursor', ...binding('cursor', 'Cursor', 'cli_cursor') },
  ]
  const completed = [selected[2], selected[0], selected[1]].map((item) => ({ binding: item }))
  const ordered = orderStartupItems(selected, completed)
  assert.deepEqual(
    ordered.map(({ binding: item }) => item.binding_id),
    ['traex', 'codex', 'cursor'],
  )
  assert.deepEqual(startupSummaryLines({
    title: '已成功启动',
    plannedCount: selected.length,
    running: ordered,
  }), [
    '已成功启动 3/3 个配置。',
    '启动成功：',
    '- traex ↔ Trae (cli_traex)',
    '- codex ↔ Codex (cli_codex)',
    '- cursor ↔ Cursor (cli_cursor)',
  ])
})

test('install cancellations from selection and launcher retain full selection order', async () => {
  const acceptedThenAgentCancelled = {
    binding_id: 'accepted-first',
    ...binding('codex', 'Accepted First', 'cli_first'),
  }
  const declinedReplacement = {
    binding_id: 'declined-second',
    ...binding('cursor', 'Declined Second', 'cli_second'),
  }
  const selected = [acceptedThenAgentCancelled, declinedReplacement]
  const result = await reconcileStartupResults(selected, {
    running: [],
    failed: [],
    cancelled: [
      { binding: declinedReplacement, reason: '用户取消替换已有绑定' },
      { binding: acceptedThenAgentCancelled, reason: '用户取消了 Agent 准备流程' },
    ],
  }, [], async () => ({ alive: [], failed: [] }))

  assert.deepEqual(result.cancelled.map(({ binding: item }) => item.binding_id), [
    'accepted-first',
    'declined-second',
  ])
  assert.equal(result.disposition, 'only-cancel')
})

test('summary uses the resolved runtime type and omits empty sections', () => {
  const lines = startupSummaryLines({
    title: '已成功建立绑定并启动',
    plannedCount: 1,
    running: [{
      binding: binding('coco', 'Trae Bot', 'cli_ok'),
      runtimeAgentType: 'traex',
    }],
    failed: [],
    cancelled: [],
  })

  assert.deepEqual(lines, [
    '已成功建立绑定并启动 1/1 个配置。',
    '启动成功：',
    '- traex ↔ Trae Bot (cli_ok)',
  ])
})

test('cancelled bindings have a separate section and are not failures', () => {
  const lines = startupSummaryLines({
    title: '已成功启动',
    plannedCount: 2,
    running: [{ binding: binding('codex', 'Codex Bot', 'cli_ok') }],
    failed: [],
    cancelled: [{
      binding: binding('coco', 'Trae Bot', 'cli_cancel'),
      reason: '用户取消升级',
    }],
  })

  assert.deepEqual(lines.slice(-3), [
    '已取消：',
    '- coco ↔ Trae Bot (cli_cancel)',
    '  原因：用户取消升级',
  ])
  assert.equal(lines.includes('启动失败：'), false)
})

test('all failures retain the planned count and omit success and cancellation sections', () => {
  const lines = startupSummaryLines({
    title: '已成功启动',
    plannedCount: 2,
    running: [],
    failed: [
      { binding: binding('codex', 'Codex Bot', 'cli_one'), reason: '失败一' },
      { binding: binding('cursor', 'Cursor Bot', 'cli_two'), reason: '失败二' },
    ],
    cancelled: [],
  })

  assert.equal(lines[0], '已成功启动 0/2 个配置。')
  assert.equal(lines.includes('启动成功：'), false)
  assert.equal(lines.includes('已取消：'), false)
  assert.equal(lines.filter((line) => line === '启动失败：').length, 1)
})

test('runtime reconciliation preserves the resolved Agent type for failure summaries', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(controllerPath, 'utf8'))
  const reconcileStart = source.indexOf('async function reconcileRetainedBindings(')
  const reconcileEnd = source.indexOf('\nasync function supervise(', reconcileStart)
  assert.notEqual(reconcileStart, -1)
  assert.notEqual(reconcileEnd, -1)
  const reconcile = source.slice(reconcileStart, reconcileEnd)
  assert.match(reconcile, /runtimeAgentType: item\.runtimeAgentType/)
})

test('layered startup failures preserve the resolved Agent type for failure summaries', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(controllerPath, 'utf8'))
  const start = source.indexOf('async function startBindingsWithGroups(')
  const end = source.indexOf('\nasync function startSelectedBindings(', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const launcher = source.slice(start, end)
  assert.match(launcher, /failed\.push\(\{ binding, reason, runtimeAgentType \}\)/)
  assert.match(launcher, /runtimeAgentTypes\?\.get\(binding\.agent_type\)/)
})

test('a reconciled runtime failure prevents install from returning as cancellation-only', () => {
  const cancelled = [{
    binding: binding('coco', 'Cancelled Bot', 'cli_cancel'),
    reason: '用户取消升级',
  }]
  const runtimeFailure = [{
    binding: binding('codex', 'Stopped Bot', 'cli_stopped'),
    reason: 'Bridge 在启动确认前退出',
  }]

  assert.equal(installHasOnlyCancellations({
    cancelled,
    failures: runtimeFailure,
    selectionFailures: [],
  }), false)
  assert.equal(installHasOnlyCancellations({
    cancelled,
    failures: [],
    selectionFailures: [],
  }), true)
})
