import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(__dirname, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs')
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))

function shell(source, args = []) {
  return spawnSync('bash', ['-c', source, 'bash', ...args], { encoding: 'utf8' })
}

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf('\n' + endName, start)
  assert.notEqual(start, -1, startName + ' must exist')
  assert.notEqual(end, -1, endName + ' must follow ' + startName)
  return source.slice(start, end)
}

test('bootstrap builds native ACP commands only for Trae CLI Next（内部版）', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = functionRange(source, 'resolve_trae_cli_candidate()', 'ensure_agent_cli()')
    + '\n' + functionRange(source, 'build_acp_agent_command()', 'validate_codex_acp_command()')

  for (const scenario of [
    { agent: 'traex', names: ['traex'] },
    { agent: 'coco', names: ['coco', 'traex'] },
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), 'aamp-trae-aliases-'))
    const binDir = path.join(root, 'bin')
    mkdirSync(binDir)
    for (const name of scenario.names) {
      const executable = path.join(binDir, name)
      writeFileSync(executable, '#!/usr/bin/env bash\nexit 0\n')
      chmodSync(executable, 0o755)
    }
    const result = shell([
      'set -euo pipefail',
      'PATH="$1/bin:/usr/bin:/bin"',
      `AGENT="${scenario.agent}"`,
      'AAMP_TRAE_CLI_BIN=""',
      'TRAE_CLI_BIN=""',
      'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'agent_detail() { :; }',
      helpers,
      'find_traex_cli >/dev/null',
      'build_acp_agent_command',
      'printf "%s" "$ACP_AGENT_COMMAND"',
    ].join('\n'), [root])
    assert.equal(result.status, 0, result.stderr)
    const expected = path.join(binDir, 'traex')
    assert.equal(result.stdout, `${expected} acp serve`)
    assert.doesNotMatch(result.stdout, /--yolo/)
  }

  const root = mkdtempSync(path.join(tmpdir(), 'aamp-trae-legacy-acp-rejected-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'coco'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(path.join(binDir, 'coco'), 0o755)
  const legacy = shell([
    'set -euo pipefail',
    'PATH="$1/bin:/usr/bin:/bin"',
    'AGENT="coco"',
    'AAMP_TRAE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 71; }',
    'agent_detail() { :; }',
    helpers,
    'find_legacy_trae_cli >/dev/null',
    'build_acp_agent_command',
  ].join('\n'), [root])
  assert.equal(legacy.status, 71)
  assert.match(legacy.stderr, /Trae CLI Next（内部版）/)
  assert.doesNotMatch(legacy.stdout, /acp serve/)
})

test('bootstrap discovers traex when available and coco only when needed', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const traeHelpers = functionRange(source, 'resolve_trae_cli_candidate()', 'ensure_agent_cli()')
  const validate = functionRange(source, 'validate_agent_name()', 'read_tty_line()')
  const discovery = functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()')

  for (const scenario of [
    { names: ['traex', 'coco'], expected: 'traex' },
    { names: ['coco'], expected: 'coco' },
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), 'aamp-trae-discovery-'))
    const binDir = path.join(root, 'bin')
    mkdirSync(binDir)
    for (const name of scenario.names) {
      writeFileSync(path.join(binDir, name), '#!/usr/bin/env bash\nexit 0\n')
      chmodSync(path.join(binDir, name), 0o755)
    }
    const discovered = shell([
      'set -euo pipefail',
      'PATH="$1/bin:/usr/bin:/bin"',
      'AAMP_TRAE_CLI_BIN=""',
      'AAMP_TRAECODE_CLI_BIN=""',
      'TRAE_CLI_BIN=""',
      'TRAECODE_CLI_BIN=""',
      'agent_fail() { exit 64; }',
      'resolve_codex_cli_for_acp() { return 1; }',
      'find_cursor_agent_cli() { return 1; }',
      traeHelpers,
      validate,
      discovery,
      'validate_agent_name coco',
      'validate_agent_name traex',
      'discover_interactive_agents',
      'printf "%s" "$' + '{DETECTED_AGENTS[*]}"',
    ].join('\n'), [root])
    assert.equal(discovered.status, 0, discovered.stderr)
    assert.equal(discovered.stdout, scenario.expected)
  }
  const invalid = shell(['set -euo pipefail', 'agent_fail() { exit 64; }', validate, 'validate_agent_name unrelated'].join('\n'))
  assert.equal(invalid.status, 64)
})

test('bootstrap accepts coco, rejects trae, and displays canonical agent types verbatim', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = functionRange(source, 'validate_agent_name()', 'read_tty_line()')
  const result = shell([
    'set +e',
    'agent_fail() { printf "%s\\n" "$*" >&2; return 64; }',
    helpers,
    'validate_agent_name coco',
    'coco_status=$?',
    'validate_agent_name trae',
    'trae_status=$?',
    'set -e',
    'for agent in codex cursor coco traex traecli workbuddy; do agent_display_name "$agent"; printf "\\n"; done',
    'printf "status:%s,%s\\n" "$coco_status" "$trae_status"',
  ].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'codex',
    'cursor',
    'coco',
    'traex',
    'traecli',
    'workbuddy',
    'status:0,64',
  ])
})

test('bootstrap performs Trae login only for traex', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = functionRange(source, 'resolve_trae_cli_candidate()', 'print_cursor_gatekeeper_help()')
    + '\n' + functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-trae-login-'))
  const fakeTrae = path.join(root, 'traex')
  const calls = path.join(root, 'calls.log')
  const loggedIn = path.join(root, 'logged-in')
  writeFileSync(fakeTrae, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "' + calls + '"',
    'if [ "$1" = login ] && [ "$' + '{2:-}" = status ] && [ ! -f "' + loggedIn + '" ]; then exit 1; fi',
    'if [ "$1" = login ]; then touch "' + loggedIn + '"; fi',
    '',
  ].join('\n'))
  chmodSync(fakeTrae, 0o755)
  const result = shell([
    'set -euo pipefail',
    'AGENT="traex"',
    'FAKE_TRAE="$1"',
    'AAMP_TRAE_CLI_BIN="$FAKE_TRAE"',
    'AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5',
    'TRAE_CLI_BIN=""',
    'agent_log() { :; }',
    'agent_detail() { :; }',
    'agent_fail() { exit 1; }',
    'clear_codex_quarantine() { :; }',
    'clear_cursor_quarantine() { :; }',
    helpers,
    'ensure_agent_login',
  ].join('\n'), [fakeTrae])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['login status', 'login', 'login status'])
})

test('bootstrap marks Coco preparation cancelled when the upgrade prompt is declined', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = functionRange(source, 'resolve_trae_cli_candidate()', 'print_cursor_gatekeeper_help()')
    + '\n' + functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-legacy-trae-no-login-'))
  const fakeTrae = path.join(root, 'coco')
  const calls = path.join(root, 'calls.log')
  writeFileSync(fakeTrae, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "' + calls + '"',
    'exit 72',
  ].join('\n'))
  chmodSync(fakeTrae, 0o755)
  const result = shell([
    'set -euo pipefail',
    'PATH="' + path.dirname(fakeTrae) + ':/usr/bin:/bin"',
    'AGENT="coco"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5',
    'TRAEX_INSTALLER_URL="https://code.byted.org/api/tos-proxy/download/traex_install.sh"',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'AGENT_PREPARE_CANCELLED="false"',
    'AGENT_PREPARE_CANCEL_REASON=""',
    'agent_log() { :; }',
    'agent_detail() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'clear_codex_quarantine() { :; }',
    'clear_cursor_quarantine() { :; }',
    helpers,
    'confirm_trae_upgrade() { return 1; }',
    'run_traex_installer() { printf "unexpected installer\\n" >&2; return 1; }',
    'ensure_agent_login',
    'printf "%s|%s" "$AGENT_PREPARE_CANCELLED" "$AGENT_PREPARE_CANCEL_REASON"',
  ].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^true\|/)
  assert.match(result.stdout, /飞书任务 Agent 暂不支持使用 Trae CLI（内部版）建立连接/)
  assert.match(result.stdout, /Trae CLI Next（内部版）/)
  assert.doesNotMatch(result.stdout, /ACP|login|TUI/)
  assert.equal(result.stderr, '')
  assert.equal(spawnSync('test', ['-e', calls]).status, 1)
})

test('legacy Trae upgrade prompt explains product support without implementation jargon', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const prompt = functionRange(source, 'confirm_trae_upgrade()', 'run_traex_installer()')
  assert.match(prompt, /飞书任务 Agent 暂不支持使用该版本建立连接/)
  assert.match(prompt, /建议升级到 Trae CLI Next（内部版）（traex）后继续/)
  assert.match(prompt, /升级过程中可自行选择是否保留 Trae CLI（内部版）/)
  assert.doesNotMatch(prompt, /TUI|login status|login 命令|无法可靠检测登录状态/)
})

test('controller normalizes only new Coco bindings to the prepared traex type', () => {
  const source = readFileSync(controller, 'utf8')
  const helper = functionRange(source, 'function resolvePreparedAgentBindings(', 'function printBindingStarted(')
  const helpers = new Function(
    'AGENT_TYPES',
    `${helper}\nreturn { resolvePreparedAgentBindings, commitPreparedAgentBindings };`,
  )(['codex', 'cursor', 'coco', 'traex'])
  const host = 'https://meshmail.ai'
  const pending = [{ agent_type: 'coco', aamp_host: host, state: 'pending' }]
  const ready = [{ agent_type: 'coco', aamp_host: host, state: 'ready', agent_target_email: 'coco@example.com' }]

  const pendingPlan = helpers.resolvePreparedAgentBindings(pending, host, 'coco', 'traex')
  assert.equal(pendingPlan.stableAgentType, 'traex')
  assert.equal(pending[0].agent_type, 'coco')
  helpers.commitPreparedAgentBindings(pendingPlan)
  assert.equal(pending[0].agent_type, 'traex')
  const readyPlan = helpers.resolvePreparedAgentBindings(ready, host, 'coco', 'traex')
  assert.equal(readyPlan.stableAgentType, 'coco')
  helpers.commitPreparedAgentBindings(readyPlan)
  assert.equal(ready[0].agent_type, 'coco')
  assert.throws(
    () => helpers.resolvePreparedAgentBindings(pending, host, 'traex', 'codex'),
    /unexpected prepared Agent type/,
  )
})

test('controller reports the resolved traex runtime for saved coco bindings', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /runtimeAgentTypes: new Map\(\)/)
  assert.match(source, /runtimeAgentTypes\.set\(stableAgentType, runtimeAgentType\)/)
  assert.match(source, /bindingLabel\(binding, runtimeAgentType\)/)
  assert.match(source, /正在启动本地 Agent Bridge \(\$\{runtimeAgentNames\.join/)
})

test('controller treats structured Agent preparation cancellation separately from failures', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /prepared\.cancelled/)
  assert.match(source, /group\.cancellations\.set/)
  assert.match(source, /setBindingStatus\([^\n]+, '(?:start|bind)', 'cancelled'/)
  assert.match(source, /🟡 已取消/)
  assert.match(source, /lines\.push\('已取消：'\)/)
})

test('bootstrap reuses an installed traex for a Coco binding without prompting again', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = functionRange(source, 'resolve_trae_cli_candidate()', 'print_cursor_gatekeeper_help()')
    + '\n' + functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()')
    + '\n' + functionRange(source, 'build_acp_agent_command()', 'validate_codex_acp_command()')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-legacy-trae-reuses-traex-'))
  const binDir = path.join(root, 'bin')
  const traexCalls = path.join(root, 'traex-calls.log')
  const legacyCalls = path.join(root, 'legacy-calls.log')
  const promptCalls = path.join(root, 'prompt-calls.log')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'traex'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "' + traexCalls + '"',
    'exit 0',
  ].join('\n'))
  writeFileSync(path.join(binDir, 'traecli'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "' + legacyCalls + '"',
    'exit 72',
  ].join('\n'))
  chmodSync(path.join(binDir, 'traex'), 0o755)
  chmodSync(path.join(binDir, 'traecli'), 0o755)

  const result = shell([
    'set -euo pipefail',
    `PATH="$1/bin:${path.dirname(process.execPath)}:/usr/bin:/bin"`,
    'AGENT="coco"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5',
    'TRAE_CLI_BIN=""',
    'agent_log() { :; }',
    'agent_detail() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'clear_codex_quarantine() { :; }',
    'clear_cursor_quarantine() { :; }',
    helpers,
    'confirm_trae_upgrade() { touch "' + promptCalls + '"; return 1; }',
    'ensure_agent_cli',
    'ensure_agent_login',
    'build_acp_agent_command',
    'printf "%s|%s" "$AGENT" "$ACP_AGENT_COMMAND"',
  ].join('\n'), [root])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `traex|${path.join(binDir, 'traex')} acp serve`)
  assert.deepEqual(readFileSync(traexCalls, 'utf8').trim().split('\n'), ['login status'])
  assert.equal(spawnSync('test', ['-e', legacyCalls]).status, 1)
  assert.equal(spawnSync('test', ['-e', promptCalls]).status, 1)
})

test('controller displays a saved Coco binding as its raw type in list and start selection', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-trae-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '11111111-1111-4111-8111-111111111111'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  const binding = {
    binding_id: bindingId,
    agent_type: 'coco',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: { app_id: 'cli_test_app', app_secret: 'test-only-secret', lark_cli_profile: 'test-only-profile' },
    feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
    state: 'pending',
  }
  writeFileSync(configFile, JSON.stringify({ schema: 'aamp.feishu-task-agent.bindings', version: 1, bindings: [binding] }, null, 2) + '\n')
  const result = spawnSync(process.execPath, [controller, 'list'], {
    env: { ...process.env, HOME: root, AAMP_TASK_STATE_HOME: stateHome, AAMP_TASK_CONFIG_FILE: configFile, AAMP_TASK_RUNTIME_HOME: runtimeHome, AAMP_RUN_LOG_DIR: path.join(root, 'logs') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /coco/)
  assert.doesNotMatch(result.stdout, /test-only-secret/)

  const controllerSource = readFileSync(controller, 'utf8')
  const labelHelpers = functionRange(
    controllerSource,
    'function agentBindingDisplayName(',
    'function resolvePreparedAgentBindings(',
  )
  const bindingLabel = new Function(`${labelHelpers}\nreturn bindingLabel;`)()
  assert.equal(bindingLabel(binding), 'coco ↔ cli_test_app (cli_test_app)')
  assert.match(
    controllerSource,
    /chooseMany\('请选择要启动的绑定配置：', store\.bindings, bindingLabel\)/,
  )
})

test('Trae one-click package pins move together', () => {
  const bootstrapSource = readFileSync(bootstrap, 'utf8')
  const controllerSource = readFileSync(controller, 'utf8')
  const acpPackage = JSON.parse(readFileSync(path.resolve(__dirname, '../../aamp-acp-bridge/package.json'), 'utf8'))
  const acpLock = JSON.parse(readFileSync(path.resolve(__dirname, '../../aamp-acp-bridge/package-lock.json'), 'utf8'))
  const taskLock = JSON.parse(readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8'))
  assert.equal(acpPackage.version, '0.1.28-dev.21')
  assert.equal(acpLock.version, acpPackage.version)
  assert.equal(acpLock.packages[''].version, acpPackage.version)
  assert.equal(packageJson.version, '0.1.0-dev.175')
  assert.equal(taskLock.version, packageJson.version)
  assert.equal(taskLock.packages[''].version, packageJson.version)
  assert.match(bootstrapSource, /ACP_BRIDGE_PKG="\$\{ACP_BRIDGE_PKG:-@zengxingyuan\/aamp-acp-bridge@0\.1\.28-dev\.21\}"/)
  assert.match(controllerSource, /@zengxingyuan\/aamp-acp-bridge@0\.1\.28-dev\.21/)
})

test('Trae one-click user-facing agent guidance is not stale', () => {
  const bootstrapSource = readFileSync(bootstrap, 'utf8')
  const readmeSource = readFileSync(path.resolve(__dirname, '../README.md'), 'utf8')
  assert.match(bootstrapSource, /pass --agent codex\|cursor\|coco\|traex\|traecli\|workbuddy/)
  assert.match(bootstrapSource, /Trae CLI（内部版）/)
  assert.match(bootstrapSource, /Trae CLI Next（内部版）/)
  assert.match(bootstrapSource, /TraeCode CLI/)
  assert.doesNotMatch(bootstrapSource, /旧版 Coco/)
  assert.match(readmeSource, /--agent codex\|cursor\|coco\|traex\|traecli\|workbuddy/)
  assert.match(readmeSource, /Trae CLI（内部版）/)
  assert.match(readmeSource, /Trae CLI Next（内部版）/)
  assert.match(readmeSource, /TraeCode CLI/)
  assert.match(readmeSource, /traex.*coco.*traecli/is)
  assert.match(readmeSource, /traecli update/)
  assert.match(readmeSource, /traecli doctor --json/)
  assert.match(readmeSource, /\/model/)
  assert.match(readmeSource, /saved.*traecli.*TraeCode CLI/is)
  assert.doesNotMatch(readmeSource, /TraeCode CLI.*aamp-cli-bridge/is)
})
