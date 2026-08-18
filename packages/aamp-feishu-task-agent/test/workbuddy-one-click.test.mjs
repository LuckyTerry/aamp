import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveTaskAgentMetadata } from '../bin/agent-metadata.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(testDir, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')

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

function bootstrapWorkBuddyFunctions(source) {
  return [
    functionRange(source, 'validate_agent_name()', 'read_tty_line()'),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
    functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()'),
    functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()'),
  ].join('\n')
}

test('WorkBuddy discovery skips built-in Marketplace initialization without invoking the CLI', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = bootstrapWorkBuddyFunctions(source)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-workbuddy-bootstrap-'))
  const fakeCli = path.join(root, 'codebuddy')
  const callLog = path.join(root, 'calls.log')
  writeFileSync(fakeCli, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
    'exit 0',
  ].join('\n'))
  chmodSync(fakeCli, 0o755)

  const result = runShell([
    'set -euo pipefail',
    'WORKBUDDY_APP_CLI="$1"',
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'HOME="$2"',
    'AGENT="workbuddy"',
    'DETECTED_AGENTS=()',
    'ACP_AGENT_COMMAND=""',
    'is_macos() { return 0; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_traex_cli() { return 1; }',
    'find_legacy_trae_cli() { return 1; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    helpers,
    'validate_agent_name workbuddy',
    'discover_interactive_agents',
    'ensure_agent_cli',
    'ensure_agent_login',
    'build_acp_agent_command',
    'eval "set -- $ACP_AGENT_COMMAND"',
    'printf "%s|%s|%s|%s|%s|%s" "${DETECTED_AGENTS[*]}" "$1" "$2" "${3-}" "${4-}" "${5-}"',
  ], [fakeCli, root])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    `workbuddy|env|CODEBUDDY_CONFIG_DIR=${root}/.workbuddy|CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1|${fakeCli}|--acp`,
  )
  assert.equal(existsSync(callLog), false)
})

test('WorkBuddy explicit preparation distinguishes unsupported platform and missing app', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = [
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
  ].join('\n')
  const common = [
    'set -euo pipefail',
    'AGENT="workbuddy"',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    helpers,
    'ensure_agent_cli',
  ]

  const unsupported = runShell([
    'WORKBUDDY_APP_CLI="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"',
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 1; }',
    ...common,
  ])
  assert.equal(unsupported.status, 64)
  assert.match(unsupported.stderr, /仅支持 macOS/)

  const missing = runShell([
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    ...common,
  ])
  assert.equal(missing.status, 64)
  assert.match(missing.stderr, /\/Applications\/WorkBuddy\.app/)
})

test('WorkBuddy appears in bootstrap agent guidance', () => {
  const source = readFileSync(bootstrap, 'utf8')
  assert.match(source, /--agent codex\|cursor\|coco\|traex\|traecli\|workbuddy/)
  assert.match(source, /pass --agent codex\|cursor\|coco\|traex\|traecli\|workbuddy/)
})

test('WorkBuddy is a canonical controller binding with actionable failure guidance', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /TASK_AGENT_TYPES,\n  resolveTaskAgentMetadata,\n\} from '\.\/agent-metadata\.mjs';/)
  assert.deepEqual(resolveTaskAgentMetadata('workbuddy'), { executionLocation: 'local' })
  assert.match(source, /codex\/cursor\/coco\/traex\/traecli\/workbuddy/)
  assert.match(source, /function agentFailureMessage\(agentType, message\)/)
  assert.match(source, /如果尚未登录，请打开 \$\{productName\} 完成登录后重试/)
})

test('WorkBuddy pending bindings can be loaded and listed without exposing secrets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-workbuddy-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '22222222-2222-4222-8222-222222222222'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  const binding = {
    binding_id: bindingId,
    agent_type: 'workbuddy',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: {
      app_id: 'cli_workbuddy_test',
      app_secret: 'workbuddy-test-only-secret',
      lark_cli_profile: 'workbuddy-test-profile',
    },
    feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
    state: 'pending',
  }
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings: [binding],
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
  assert.match(result.stdout, /workbuddy/)
  assert.doesNotMatch(result.stdout, /workbuddy-test-only-secret/)
})

test('WorkBuddy README documents standard-path detection and desktop authentication', () => {
  const readme = readFileSync(path.resolve(testDir, '../README.md'), 'utf8')
  assert.match(readme, /--agent codex\|cursor\|coco\|traex\|traecli\|workbuddy/)
  assert.match(readme, /\/Applications\/WorkBuddy\.app\/Contents\/Resources\/app\.asar\.unpacked\/cli\/bin\/codebuddy/)
  assert.match(readme, /does not run a WorkBuddy login command/i)
  assert.match(readme, /Open WorkBuddy and complete login/i)
})
