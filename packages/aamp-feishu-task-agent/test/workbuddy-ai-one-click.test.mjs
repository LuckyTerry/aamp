import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(testDir, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')
const agentSetupDocs = path.resolve(testDir, '../../../docs/AGENT_SETUP.md')

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

function runShell(lines, args = []) {
  return spawnSync('bash', ['-c', lines.join('\n'), 'bash', ...args], { encoding: 'utf8' })
}

function workbuddyFunctions(source) {
  return [
    functionRange(source, 'validate_agent_name()', 'read_tty_line()'),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
    functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()'),
    functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()'),
  ].join('\n')
}

test('discovers both WorkBuddy products and skips WorkBuddy AI Marketplace initialization', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-workbuddy-ai-bootstrap-'))
  const workbuddyCli = path.join(root, 'WorkBuddy.app', 'codebuddy')
  const workbuddyAiCli = path.join(root, 'WorkBuddy AI.app', 'codebuddy')
  const callLog = path.join(root, 'calls.log')
  for (const cli of [workbuddyCli, workbuddyAiCli]) {
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\n`)
    chmodSync(cli, 0o755)
  }

  const result = runShell([
    'set -euo pipefail',
    'WORKBUDDY_APP_CLI="$1"',
    'WORKBUDDY_AI_APP_CLI="$2"',
    'HOME="$3"',
    'AGENT="workbuddy_ai"',
    'DETECTED_AGENTS=()',
    'ACP_AGENT_COMMAND=""',
    'is_macos() { return 0; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_traex_cli() { return 1; }',
    'find_legacy_trae_cli() { return 1; }',
    'find_traecode_cli() { return 1; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    workbuddyFunctions(source),
    'validate_agent_name workbuddy_ai',
    'discover_interactive_agents',
    'ensure_agent_cli',
    'ensure_agent_login',
    'build_acp_agent_command',
    'eval "set -- $ACP_AGENT_COMMAND"',
    'printf "%s|%s|%s|%s|%s|%s" "${DETECTED_AGENTS[*]}" "$1" "$2" "${3-}" "${4-}" "${5-}"',
  ], [workbuddyCli, workbuddyAiCli, root])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    `workbuddy workbuddy_ai|env|CODEBUDDY_CONFIG_DIR=${root}/.workbuddy-ai|CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1|${workbuddyAiCli}|--acp`,
  )
  assert.equal(existsSync(callLog), false)
})

test('WorkBuddy AI preparation reports unsupported platform and its exact missing CLI path', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = [
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
    functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()'),
  ].join('\n')
  const common = [
    'set -euo pipefail',
    'AGENT="workbuddy_ai"',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    helpers,
  ]

  const unsupported = runShell([
    'WORKBUDDY_AI_APP_CLI="/Applications/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 1; }',
    ...common,
    'ensure_agent_cli',
  ])
  assert.equal(unsupported.status, 64)
  assert.match(unsupported.stderr, /WorkBuddy AI.*macOS/)

  const missing = runShell([
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    ...common,
    'find_workbuddy_ai_cli() { return 1; }',
    'ensure_agent_cli',
  ])
  assert.equal(missing.status, 64, missing.stderr)
  assert.match(missing.stderr, /\/missing\/WorkBuddy AI\.app\/codebuddy/)

  const commandMissing = runShell([
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    ...common,
    'find_workbuddy_ai_cli() { return 1; }',
    'build_acp_agent_command',
  ])
  assert.equal(commandMissing.status, 64, commandMissing.stderr)
  assert.match(commandMissing.stderr, /\/missing\/WorkBuddy AI\.app\/codebuddy/)
})

test('controller initializes canonical WorkBuddy AI and starts the same generated config', () => {
  const source = readFileSync(controller, 'utf8')
  const initialize = functionRange(source, 'async function initializeAgentGroups(', 'async function startAgentGroups(')
  const startGroups = functionRange(source, 'async function startAgentGroups(', 'async function setupAgentGroups(')
  const setup = functionRange(source, 'async function setupAgentGroups(', 'function resolveInitializedGroup(')
  const canonicalName = initialize.indexOf('name: stableAgentType,')
  const init = initialize.indexOf("['init', '--json', '--config', group.configFile, '--input', '-']")
  const initInput = initialize.indexOf('{ input: JSON.stringify({ aampHost: host, agents })')
  const start = startGroups.indexOf("args: ['start', '--config', group.configFile, '--json'")

  assert.notEqual(canonicalName, -1)
  assert.notEqual(init, -1)
  assert.notEqual(initInput, -1)
  assert.notEqual(start, -1)
  assert.ok(canonicalName < init)
  assert.ok(init < initInput)
  assert.ok(setup.indexOf('await initializeAgentGroups(bindings)') < setup.indexOf('await startAgentGroups(groups)'))
})

test('bootstrap and controller expose only the canonical workbuddy_ai spelling', () => {
  const bootstrapSource = readFileSync(bootstrap, 'utf8')
  const controllerSource = readFileSync(controller, 'utf8')
  assert.match(bootstrapSource, /codex\|cursor\|coco\|traex\|traecli\|workbuddy\|workbuddy_ai/)
  assert.match(controllerSource, /const AGENT_TYPES = \[[^\]]*'workbuddy_ai'/)
  const failureSource = functionRange(
    controllerSource,
    'function agentFailureMessage(',
    'function resolvePreparedAgentBindings(',
  )
  const agentFailureMessage = new Function(`${failureSource}\nreturn agentFailureMessage;`)()
  assert.equal(
    agentFailureMessage('workbuddy_ai', 'bridge exited'),
    'bridge exited\n如果尚未登录，请打开 WorkBuddy AI 完成登录后重试。',
  )
  assert.equal(
    agentFailureMessage(
      'workbuddy_ai',
      'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
    ),
    'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
  )
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.doesNotMatch(bootstrapSource, new RegExp(`\\|${alias.replace('-', '\\-')}\\|`))
  }
})

test('a pending workbuddy_ai binding is accepted and displayed verbatim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-workbuddy-ai-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '33333333-3333-4333-8333-333333333333'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings: [{
      binding_id: bindingId,
      agent_type: 'workbuddy_ai',
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: {
        app_id: 'cli_workbuddy_ai_test',
        app_secret: 'workbuddy-ai-test-only-secret',
        lark_cli_profile: 'workbuddy-ai-test-profile',
      },
      feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
      state: 'pending',
    }],
  }, null, 2)}\n`)

  const result = spawnSync(process.execPath, [controller, 'list'], {
    env: {
      ...process.env,
      HOME: root,
      AAMP_TASK_STATE_HOME: stateHome,
      AAMP_TASK_CONFIG_FILE: configFile,
      AAMP_TASK_RUNTIME_HOME: runtimeHome,
      AAMP_RUN_LOG_DIR: path.join(root, 'logs'),
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /workbuddy_ai/)
  assert.doesNotMatch(result.stdout, /workbuddy-ai-test-only-secret/)
})

test('Agent setup documents both WorkBuddy products as distinct ACP connectors', () => {
  const source = readFileSync(agentSetupDocs, 'utf8')
  assert.match(source, /\| `workbuddy` \| `aamp-acp-bridge` \|/)
  assert.match(source, /\| `workbuddy_ai` \| `aamp-acp-bridge` \|/)
  assert.match(source, /Prefer `aamp-acp-bridge` for Codex, Claude, WorkBuddy, and WorkBuddy AI/)
})
