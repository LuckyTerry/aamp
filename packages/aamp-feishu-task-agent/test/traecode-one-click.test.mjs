import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(testDir, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')
const readinessHelper = path.resolve(testDir, '../bin/traecode-readiness.mjs')
const nodeBinDir = path.dirname(process.execPath)

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

function runShell(lines, args = []) {
  return spawnSync('bash', ['-c', lines.join('\n'), 'bash', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function writeExecutable(file, body = 'exit 0') {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
}

function resolutionFunctions(source) {
  return functionRange(source, 'resolve_trae_cli_candidate()', 'find_workbuddy_cli()')
}

function ensureCliFunction(source) {
  return functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()')
}

function readinessFunctions(source) {
  return functionRange(source, 'traecode_readiness_helper_path()', 'ensure_agent_login()')
}

function acpCommandFunctions(source) {
  return functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()')
}

function runDiscoveryFixture(names) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-discovery-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(path.join(binDir, name))
  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT=""',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'DETECTED_AGENTS=()',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_workbuddy_cli() { return 1; }',
    'find_workbuddy_ai_cli() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    'discover_interactive_agents',
    'printf "%s" "${DETECTED_AGENTS[*]}"',
  ], [binDir, nodeBinDir])
  return { ...result, stdout: result.stdout.trim() }
}

function runDiscoveryNoExecFixture(names) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-discovery-noexec-'))
  const binDir = path.join(root, 'bin')
  const callLog = path.join(root, 'calls.log')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(
    path.join(binDir, name),
    `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\nexit 91`,
  )
  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT=""',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'DETECTED_AGENTS=()',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_workbuddy_cli() { return 1; }',
    'find_workbuddy_ai_cli() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    'discover_interactive_agents',
  ], [binDir, nodeBinDir])
  return { ...result, callLog }
}

function runAliasedFixture({ agent, sharedTarget }) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-alias-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  const target = path.join(root, 'internal-coco')
  writeExecutable(target)
  symlinkSync(target, path.join(binDir, 'coco'))
  if (sharedTarget) symlinkSync(target, path.join(binDir, 'traecli'))
  else writeExecutable(path.join(binDir, 'traecli'))
  return runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT="$3"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'find_cursor_agent_cli() { return 1; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    ensureCliFunction(source),
    'ensure_agent_cli',
  ], [binDir, nodeBinDir, agent])
}

function runPreparedFixture({ names, agent, pathWithSpace = false }) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-prepared-'))
  const binDir = path.join(root, pathWithSpace ? 'bin with space' : 'bin')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(path.join(binDir, name))
  return runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT="$3"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'ACP_AGENT_COMMAND=""',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'find_cursor_agent_cli() { return 1; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'agent_detail() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    ensureCliFunction(source),
    acpCommandFunctions(source),
    'ensure_agent_cli',
    'build_acp_agent_command',
    'printf "%s|%s" "$AGENT" "$ACP_AGENT_COMMAND"',
  ], [binDir, nodeBinDir, agent])
}

function runOverrideFixture({ agent, overrideName, overrideVariable }) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-override-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  const override = path.join(binDir, overrideName)
  writeExecutable(override)
  return runShell([
    'set -euo pipefail',
    'PATH="$2:/usr/bin:/bin"',
    'AGENT="$3"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'case "$4" in AAMP_TRAE_CLI_BIN) AAMP_TRAE_CLI_BIN="$1" ;; AAMP_TRAECODE_CLI_BIN) AAMP_TRAECODE_CLI_BIN="$1" ;; TRAECODE_CLI_BIN) TRAECODE_CLI_BIN="$1" ;; esac',
    resolutionFunctions(source),
    'set +e',
    'resolve_trae_cli',
    'result=$?',
    'set -e',
    'printf "STATUS:%s" "$result"',
  ], [override, nodeBinDir, agent, overrideVariable])
}

function runBareTraeCodeOverrideFixture({
  aampOverride = '',
  cachedOverride = '',
  aliasOverrideToCoco = false,
}) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-bare-override-'))
  const binDir = path.join(root, 'bin')
  const cocoTarget = path.join(root, 'internal-coco')
  mkdirSync(binDir)
  writeExecutable(cocoTarget)
  symlinkSync(cocoTarget, path.join(binDir, 'coco'))
  writeExecutable(path.join(binDir, 'traecli'))
  if (aliasOverrideToCoco) symlinkSync(cocoTarget, path.join(binDir, 'renamed-wrapper'))
  else writeExecutable(path.join(binDir, 'renamed-wrapper'))
  return runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT="traecli"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN="$3"',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN="$4"',
    resolutionFunctions(source),
    'set +e',
    'resolved="$(find_traecode_cli)"',
    'result=$?',
    'set -e',
    'printf "%s|%s" "$result" "$resolved"',
  ], [binDir, nodeBinDir, aampOverride, cachedOverride])
}

function runControllerBindingHelper(script) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-binding-helper-'))
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import {
      prepareAndCommitAgentBindings,
      recordPreparationFailure,
      recordStableAgentFailure,
      resolvePreparedAgentBindings,
    } from ${JSON.stringify(pathToFileURL(controller).href)};
    ${script}
  `], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'state', 'runtime-v1'),
      AAMP_RUN_LOG_DIR: path.join(root, 'logs'),
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function runCommandRoundTripFixture(pathSegment, markerName) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-command-word-'))
  const binDir = path.join(root, pathSegment)
  const fake = path.join(binDir, 'traecli')
  const executionLog = path.join(root, 'execution.log')
  const marker = path.join(root, markerName)
  mkdirSync(binDir)
  writeExecutable(fake, 'printf "%s\\n%s\\n" "$0" "$*" > "$TEST_EXECUTION_LOG"')
  const result = runShell([
    'set -euo pipefail',
    'cd "$1"',
    'PATH="$2:$3:/usr/bin:/bin"',
    'AGENT="traecli"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'ACP_AGENT_COMMAND=""',
    'TEST_EXECUTION_LOG="$4"',
    'export TEST_EXECUTION_LOG',
    'agent_detail() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    acpCommandFunctions(source),
    'build_acp_agent_command',
    'eval "$ACP_AGENT_COMMAND verify"',
    'printf "COMMAND:%s" "$ACP_AGENT_COMMAND"',
  ], [root, binDir, nodeBinDir, executionLog])
  return {
    ...result,
    fake,
    marker,
    execution: existsSync(executionLog) ? readFileSync(executionLog, 'utf8').trim().split('\n') : [],
  }
}

function runTraeCodePreparation({
  initialAcp,
  consent,
  doctor,
  updateFails = false,
  updateStillMissingAcp = false,
  removeAfterUpdate = false,
}) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-prepare-'))
  const binDir = path.join(root, 'bin')
  const fake = path.join(binDir, 'traecli')
  const callLog = path.join(root, 'calls.log')
  const updateMarker = path.join(root, 'updated')
  mkdirSync(binDir)
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TEST_CALL_LOG, args.join(' ') + '\\n')
if (args.join(' ') === 'acp serve --help') {
  const supported = process.env.TEST_INITIAL_ACP === 'true'
    || (fs.existsSync(process.env.TEST_UPDATE_MARKER) && process.env.TEST_UPDATE_STILL_MISSING !== 'true')
  process.stdout.write(supported
    ? 'Start the ACP server\\nUsage: trae-cli acp serve [flags]\\n'
    : 'Available Commands:\\n  acp Agent Client Protocol commands\\n')
  process.exit(0)
}
if (args.join(' ') === 'update') {
  if (process.env.TEST_UPDATE_FAILS === 'true') process.exit(9)
  fs.writeFileSync(process.env.TEST_UPDATE_MARKER, 'updated')
  if (process.env.TEST_REMOVE_AFTER_UPDATE === 'true') {
    fs.renameSync(process.argv[1], process.argv[1] + '.removed')
  }
  process.exit(0)
}
if (args.join(' ') === 'doctor --json') {
  const mode = process.env.TEST_DOCTOR
  if (mode === 'malformed') { process.stdout.write('{broken'); process.exit(2) }
  const checks = mode === 'model'
    ? [{ name: 'model', severity: 'error', message: 'no effective model configured', fix: 'use /model to pick one' }]
    : mode === 'other'
      ? [{ name: 'auth', severity: 'error', message: 'authorization unavailable', fix: 'open TraeCode CLI' }]
      : mode === 'warning'
        ? [{ name: 'update', severity: 'warning', message: 'new version available' }]
        : [{ name: 'binary', severity: 'info', message: process.argv[1] }]
  process.stdout.write(JSON.stringify({ checks }))
  process.exit(checks.some((check) => check.severity === 'error') ? 2 : 0)
}
process.exit(90)
`)
  chmodSync(fake, 0o755)

  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'TEST_CALL_LOG="$3"',
    'TEST_UPDATE_MARKER="$4"',
    'TEST_INITIAL_ACP="$5"',
    'TEST_DOCTOR="$6"',
    'TEST_CONSENT="$7"',
    'TEST_UPDATE_FAILS="$8"',
    'TEST_UPDATE_STILL_MISSING="$9"',
    'TEST_REMOVE_AFTER_UPDATE="${10}"',
    'export TEST_CALL_LOG TEST_UPDATE_MARKER TEST_INITIAL_ACP TEST_DOCTOR TEST_UPDATE_FAILS TEST_UPDATE_STILL_MISSING TEST_REMOVE_AFTER_UPDATE',
    'AGENT="traecli"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'AAMP_TRAECODE_CHECK_TIMEOUT_SECONDS=5',
    'AAMP_TRAECODE_READINESS_HELPER="${11}"',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'ACP_AGENT_COMMAND=""',
    'AGENT_PREPARE_CANCELLED="false"',
    'AGENT_PREPARE_CANCEL_REASON=""',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    readinessFunctions(source),
    acpCommandFunctions(source),
    'confirm_traecode_update() { case "$TEST_CONSENT" in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac; }',
    'ensure_traecode_ready',
    'if [ "$AGENT_PREPARE_CANCELLED" != "true" ]; then build_acp_agent_command; fi',
    'printf "RESULT:%s|%s|%s|%s\\n" "$AGENT" "$ACP_AGENT_COMMAND" "$AGENT_PREPARE_CANCELLED" "$AGENT_PREPARE_CANCEL_REASON"',
  ], [
    binDir,
    nodeBinDir,
    callLog,
    updateMarker,
    String(initialAcp),
    doctor,
    consent === true ? 'yes' : consent === false ? 'no' : 'no-tty',
    String(updateFails),
    String(updateStillMissingAcp),
    String(removeAfterUpdate),
    readinessHelper,
  ])
  const marker = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'))
  const fields = marker ? marker.slice('RESULT:'.length).split('|') : []
  return {
    ...result,
    agent: fields[0] || '',
    command: fields[1] || '',
    cancelled: fields[2] === 'true',
    reason: fields.slice(3).join('|'),
    calls: existsSync(callLog)
      ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
      : [],
  }
}

function runControllerListFixture({ agent_type }) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-traecode-'))
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
      agent_type,
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: {
        app_id: 'cli_traecode_test',
        app_secret: 'test-only-secret',
        display_name: 'TraeCode test Bot',
        lark_cli_profile: 'traecode-test-profile',
      },
      feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
      state: 'pending',
    }],
  }, null, 2)}\n`)
  return spawnSync(process.execPath, [controller, 'list'], {
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
}

function controllerBindingContract() {
  const source = readFileSync(controller, 'utf8')
  const helpers = functionRange(source, 'function agentFailureMessage(', 'function bindingCancellationReason(')
  return new Function('AGENT_TYPES', `${helpers}\nreturn {
    resolvePreparedAgentBindings,
    commitPreparedAgentBindings,
    prepareAndCommitAgentBindings,
    recordPreparationFailure,
    recordStableAgentFailure,
  };`)(['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy'])
}

test('Trae-family discovery is traex, then coco, then external traecli', () => {
  const scenarios = [
    { names: ['traex', 'coco', 'traecli'], expected: 'traex' },
    { names: ['coco', 'traecli'], expected: 'coco' },
    { names: ['traecli'], expected: 'traecli' },
  ]
  for (const scenario of scenarios) {
    const result = runDiscoveryFixture(scenario.names)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, scenario.expected)
  }
})

test('Trae-family discovery resolves executables without invoking them', () => {
  for (const names of [['traex'], ['coco'], ['traecli']]) {
    const result = runDiscoveryNoExecFixture(names)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(result.callLog), false)
  }
})

test('explicit TraeCode selection rejects a traecli alias of coco', () => {
  const result = runAliasedFixture({ agent: 'traecli', sharedTarget: true })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /Trae CLI（内部版）/)
  assert.match(result.stderr, /TraeCode CLI/)
})

test('explicit and saved TraeCode selection remains exact when traex also exists', () => {
  const result = runPreparedFixture({ names: ['traex', 'traecli'], agent: 'traecli' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /traecli\|'.*\/traecli' acp serve$/)
  assert.doesNotMatch(result.stdout, /traex acp serve/)
})

test('resolved TraeCode commands quote an executable path containing spaces', () => {
  const result = runPreparedFixture({ names: ['traecli'], agent: 'traecli', pathWithSpace: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^traecli\|'.*\/bin with space\/traecli' acp serve$/)
})

test('built TraeCode ACP commands round-trip shell metacharacters without substitution', () => {
  const scenarios = [
    { segment: 'bin $AAMP_TRAECODE_SHOULD_NOT_EXPAND', marker: 'marker-dollar' },
    { segment: 'bin `touch marker-backtick`', marker: 'marker-backtick' },
    { segment: 'bin $(touch marker-substitution)', marker: 'marker-substitution' },
    { segment: "bin ' literal-quote", marker: 'marker-quote' },
  ]
  for (const scenario of scenarios) {
    const result = runCommandRoundTripFixture(scenario.segment, scenario.marker)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.execution, [result.fake, 'acp serve verify'])
    assert.equal(existsSync(result.marker), false)
  }
})

test('internal Trae overrides remain restricted to their canonical basenames', () => {
  for (const overrideName of ['coco', 'traecli']) {
    const result = runOverrideFixture({
      agent: 'traex', overrideName, overrideVariable: 'AAMP_TRAE_CLI_BIN',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'STATUS:1')
  }
})

test('explicit external overrides accept renamed wrappers but reject known internal products', () => {
  for (const overrideVariable of ['AAMP_TRAECODE_CLI_BIN', 'TRAECODE_CLI_BIN']) {
    const renamed = runOverrideFixture({
      agent: 'traecli', overrideName: 'traecode-app-wrapper', overrideVariable,
    })
    assert.equal(renamed.status, 0, renamed.stderr)
    assert.match(renamed.stdout, /\/traecode-app-wrapper\nSTATUS:0$/)

    for (const overrideName of ['coco', 'traex']) {
      const internal = runOverrideFixture({ agent: 'traecli', overrideName, overrideVariable })
      assert.equal(internal.status, 0, internal.stderr)
      assert.equal(internal.stdout, 'STATUS:2')
    }
  }
})

test('bare explicit TraeCode override aliasing Coco is authoritative and never falls back', () => {
  const result = runBareTraeCodeOverrideFixture({
    aampOverride: 'renamed-wrapper',
    aliasOverrideToCoco: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2|')
})

test('missing bare explicit TraeCode override is authoritative and never falls back', () => {
  const result = runBareTraeCodeOverrideFixture({ aampOverride: 'missing-traecode-wrapper' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '1|')
})

test('distinct bare TraeCode wrapper is resolved exactly and AAMP override takes precedence', () => {
  const distinct = runBareTraeCodeOverrideFixture({ cachedOverride: 'renamed-wrapper' })
  assert.equal(distinct.status, 0, distinct.stderr)
  assert.match(distinct.stdout, /^0\|.*\/renamed-wrapper$/)

  const authoritativeMissing = runBareTraeCodeOverrideFixture({
    aampOverride: 'missing-traecode-wrapper',
    cachedOverride: 'renamed-wrapper',
  })
  assert.equal(authoritativeMissing.status, 0, authoritativeMissing.stderr)
  assert.equal(authoritativeMissing.stdout, '1|')
})

test('old TraeCode CLI updates after consent, reprobes ACP, runs doctor, and never logs in', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: true, doctor: 'healthy' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.command, /\/traecli' acp serve$/)
  assert.deepEqual(result.calls, [
    'acp serve --help',
    'update',
    'acp serve --help',
    'doctor --json',
  ])
})

test('declining a TraeCode update cancels without doctor or bridge command', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: false, doctor: 'healthy' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.cancelled, true)
  assert.match(result.reason, /用户取消升级/)
  assert.deepEqual(result.calls, ['acp serve --help'])
})

test('non-interactive old TraeCode CLI fails fast with the manual update command', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: undefined, doctor: 'healthy' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /traecli update/)
  assert.deepEqual(result.calls, ['acp serve --help'])
})

test('failed or ineffective updates terminate without doctor or CLI Bridge fallback', () => {
  const failed = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', updateFails: true,
  })
  assert.equal(failed.status, 64)
  assert.match(failed.stderr, /升级失败/)
  assert.deepEqual(failed.calls, ['acp serve --help', 'update'])

  const ineffective = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', updateStillMissingAcp: true,
  })
  assert.equal(ineffective.status, 64)
  assert.match(ineffective.stderr, /升级后仍不支持 ACP/)
  assert.deepEqual(ineffective.calls, ['acp serve --help', 'update', 'acp serve --help'])
})

test('successful update must rediscover TraeCode CLI before reprobe', () => {
  const result = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', removeAfterUpdate: true,
  })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /升级后仍未检测到 TraeCode CLI/)
  assert.deepEqual(result.calls, ['acp serve --help', 'update'])
})

test('doctor model error gives login and /model guidance without a login command', () => {
  const result = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'model' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /打开 TraeCode CLI/)
  assert.match(result.stderr, /\/model/)
  assert.deepEqual(result.calls, ['acp serve --help', 'doctor --json'])
})

test('doctor warning-only result continues and malformed output fails safely', () => {
  const warning = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'warning' })
  assert.equal(warning.status, 0, warning.stderr)
  assert.match(warning.stdout, /诊断警告/)
  const malformed = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'malformed' })
  assert.equal(malformed.status, 64)
  assert.match(malformed.stderr, /诊断结果无法解析/)
})

test('other doctor errors surface only sanitized actionable checks', () => {
  const result = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'other' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /auth: authorization unavailable/)
  assert.match(result.stderr, /open TraeCode CLI/)
  assert.doesNotMatch(result.stderr, /\{"checks"/)
})

test('controller displays all canonical agent types verbatim', () => {
  const source = readFileSync(controller, 'utf8')
  const helpers = functionRange(source, 'function agentSelectionDisplayName(', 'function bindingCancellationReason(')
  const values = new Function(`${helpers}\nreturn { agentSelectionDisplayName, agentBindingDisplayName };`)()
  for (const agent of ['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy', 'workbuddy_ai']) {
    assert.equal(values.agentSelectionDisplayName(agent), agent)
    assert.equal(values.agentBindingDisplayName(agent), agent)
  }
})

test('Coco binding resolution stays pure until pending normalization is committed', () => {
  const { resolvePreparedAgentBindings, commitPreparedAgentBindings } = controllerBindingContract()
  const host = 'https://meshmail.ai'
  for (const resolved of ['traex', 'traecli']) {
    const pending = [{ agent_type: 'coco', aamp_host: host, state: 'pending' }]
    const pendingPlan = resolvePreparedAgentBindings(pending, host, 'coco', resolved)
    assert.equal(pendingPlan.stableAgentType, resolved)
    assert.equal(pending[0].agent_type, 'coco')
    commitPreparedAgentBindings(pendingPlan)
    assert.equal(pending[0].agent_type, resolved)
    const ready = [{ agent_type: 'coco', aamp_host: host, state: 'ready', agent_target_email: 'saved@example.com' }]
    const readyPlan = resolvePreparedAgentBindings(ready, host, 'coco', resolved)
    assert.equal(readyPlan.stableAgentType, 'coco')
    commitPreparedAgentBindings(readyPlan)
    assert.equal(ready[0].agent_type, 'coco')
  }
})

test('mixed Coco bindings prepare both stable identities transactionally', () => {
  const result = runControllerBindingHelper(`
    const host = 'https://meshmail.ai';
    const bindings = [
      { binding_id: 'ready', agent_type: 'coco', aamp_host: host, state: 'ready', agent_target_email: 'saved@example.com' },
      { binding_id: 'pending', agent_type: 'coco', aamp_host: host, state: 'pending' },
    ];
    const failedPlan = resolvePreparedAgentBindings(bindings, host, 'coco', 'traecli');
    const attempted = [];
    let preparationFailure = '';
    try {
      await prepareAndCommitAgentBindings(failedPlan, async (stableAgentType) => {
        attempted.push(stableAgentType);
        if (stableAgentType === 'traecli') throw new Error('second stable identity failed');
        return { name: stableAgentType, acpCommand: 'traecli acp serve' };
      });
    } catch (error) {
      preparationFailure = error.message;
    }
    const afterFailure = bindings.map((binding) => binding.agent_type);
    const failedGroup = { failures: new Map() };
    recordPreparationFailure(failedGroup, 'coco', failedPlan.runtimeAgentType, new Error(preparationFailure));

    const successPlan = resolvePreparedAgentBindings(bindings, host, 'coco', 'traecli');
    const agents = await prepareAndCommitAgentBindings(successPlan, async (stableAgentType) => ({
      name: stableAgentType,
      acpCommand: 'traecli acp serve',
    }));
    const runtimeAgentTypes = new Map(successPlan.stableAgentTypes.map((stable) => [stable, successPlan.runtimeAgentType]));
    const runningGroup = { failures: new Map(), runtimeAgentTypes };
    for (const stable of successPlan.stableAgentTypes) {
      recordStableAgentFailure(runningGroup, stable, stable + ' bridge failed');
    }
    process.stdout.write(JSON.stringify({
      stableAgentTypes: successPlan.stableAgentTypes,
      attempted,
      afterFailure,
      requestedFailure: failedGroup.failures.get('coco'),
      bindingTypes: bindings.map((binding) => binding.agent_type),
      agentNames: agents.map((agent) => agent.name),
      commands: agents.map((agent) => agent.acpCommand),
      stableFailures: Object.fromEntries(runningGroup.failures),
    }));
  `)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.stableAgentTypes, ['coco', 'traecli'])
  assert.deepEqual(output.attempted, ['coco', 'traecli'])
  assert.deepEqual(output.afterFailure, ['coco', 'coco'])
  assert.match(output.requestedFailure, /second stable identity failed/)
  assert.match(output.requestedFailure, /traecli doctor --json/)
  assert.deepEqual(output.bindingTypes, ['coco', 'traecli'])
  assert.deepEqual(output.agentNames, ['coco', 'traecli'])
  assert.deepEqual(output.commands, ['traecli acp serve', 'traecli acp serve'])
  assert.match(output.stableFailures.coco, /traecli doctor --json/)
  assert.match(output.stableFailures.traecli, /traecli doctor --json/)
})

test('Task Agent bootstrap and ACP README use only the approved Trae Next label', () => {
  const bootstrapSource = readFileSync(bootstrap, 'utf8')
  const acpReadme = readFileSync(path.resolve(testDir, '../../aamp-acp-bridge/README.md'), 'utf8')
  for (const source of [bootstrapSource, acpReadme]) {
    assert.doesNotMatch(source, /Trae CLI 2\.0/)
    assert.match(source, /Trae CLI Next（内部版）/)
  }
})

test('raw runtime types are used for ready Coco bindings', () => {
  const source = readFileSync(controller, 'utf8')
  const helpers = functionRange(source, 'function agentSelectionDisplayName(', 'function bindingCancellationReason(')
  const values = new Function('AGENT_TYPES', `${helpers}\nreturn { bindingLabel, resolvePreparedAgentBindings };`)(
    ['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy'],
  )
  const binding = {
    agent_type: 'coco',
    bot: { app_id: 'cli_test', display_name: 'Trae test Bot' },
  }
  assert.match(values.bindingLabel(binding), /^coco/)
  assert.match(values.bindingLabel(binding, 'traex'), /^traex/)
  assert.match(values.bindingLabel(binding, 'traecli'), /^traecli/)
})

test('saved TraeCode binding is accepted and listed without secrets', () => {
  const result = runControllerListFixture({ agent_type: 'traecli' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /traecli/)
  assert.doesNotMatch(result.stdout, /test-only-secret/)
})

test('controller rejects the removed legacy trae binding type', () => {
  const result = runControllerListFixture({ agent_type: 'trae' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /agent_type 仅支持 codex\/cursor\/coco\/traex\/traecli\/workbuddy/)
})

test('runtime startup renders resolved raw runtime agent types', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /runtimeAgentNames[^;]+\.map\(agentSelectionDisplayName\)/s)
  assert.match(source, /bindingLabel\(binding, runtimeAgentType\)/)
})

test('TraeCode controller failures recommend the bounded doctor check', () => {
  const source = readFileSync(controller, 'utf8')
  const helper = functionRange(source, 'function agentFailureMessage(', 'function resolvePreparedAgentBindings(')
  const agentFailureMessage = new Function(`${helper}\nreturn agentFailureMessage;`)()
  assert.equal(
    agentFailureMessage('traecli', 'bridge failed'),
    "bridge failed\n请执行 'traecli doctor --json' 检查 TraeCode CLI，修复后重试。",
  )
})

test('pending Coco preparation failure leaves identity unchanged and reachable by coco', async () => {
  const {
    resolvePreparedAgentBindings,
    prepareAndCommitAgentBindings,
    recordPreparationFailure,
  } = controllerBindingContract()
  const binding = { agent_type: 'coco', aamp_host: 'https://meshmail.ai', state: 'pending' }
  const plan = resolvePreparedAgentBindings([binding], binding.aamp_host, 'coco', 'traecli')
  const group = { failures: new Map() }

  const preparationError = new Error('config dir mismatch')
  await assert.rejects(
    prepareAndCommitAgentBindings(plan, async () => { throw preparationError }),
    preparationError,
  )
  recordPreparationFailure(group, 'coco', plan.runtimeAgentType, preparationError)

  assert.equal(binding.agent_type, 'coco')
  assert.match(group.failures.get('coco'), /config dir mismatch/)
  assert.match(group.failures.get('coco'), /traecli doctor --json/)
  assert.equal(group.failures.has('traecli'), false)
})

test('bootstrap helper failure does not guess TraeCode runtime guidance', () => {
  const { recordPreparationFailure } = controllerBindingContract()
  const group = { failures: new Map() }

  recordPreparationFailure(group, 'coco', undefined, new Error('helper actionable failure'))

  assert.equal(group.failures.get('coco'), 'helper actionable failure')
  assert.equal(group.failures.has('traecli'), false)
})

test('successful pending Coco preparation commits traecli identity', async () => {
  const { resolvePreparedAgentBindings, prepareAndCommitAgentBindings } = controllerBindingContract()
  const binding = { agent_type: 'coco', aamp_host: 'https://meshmail.ai', state: 'pending' }
  const plan = resolvePreparedAgentBindings([binding], binding.aamp_host, 'coco', 'traecli')

  await prepareAndCommitAgentBindings(plan, async () => 'prepared')

  assert.equal(binding.agent_type, 'traecli')
})

test('ready Coco post-preparation failure keeps identity and uses TraeCode guidance', async () => {
  const {
    resolvePreparedAgentBindings,
    prepareAndCommitAgentBindings,
    recordPreparationFailure,
  } = controllerBindingContract()
  const binding = {
    agent_type: 'coco',
    aamp_host: 'https://meshmail.ai',
    state: 'ready',
    agent_target_email: 'saved@example.com',
  }
  const plan = resolvePreparedAgentBindings([binding], binding.aamp_host, 'coco', 'traecli')
  const group = { failures: new Map() }

  const preparationError = new Error('path rejected')
  await assert.rejects(
    prepareAndCommitAgentBindings(plan, async () => { throw preparationError }),
    preparationError,
  )
  recordPreparationFailure(group, 'coco', plan.runtimeAgentType, preparationError)

  assert.equal(binding.agent_type, 'coco')
  assert.match(group.failures.get('coco'), /path rejected/)
  assert.match(group.failures.get('coco'), /traecli doctor --json/)
  assert.equal(group.failures.has('traecli'), false)
})

test('downstream failure uses runtime guidance while remaining keyed by stable Coco identity', () => {
  const { recordStableAgentFailure } = controllerBindingContract()
  const group = {
    failures: new Map(),
    runtimeAgentTypes: new Map([['coco', 'traecli']]),
  }

  recordStableAgentFailure(group, 'coco', 'ACP start failed')

  assert.match(group.failures.get('coco'), /ACP start failed/)
  assert.match(group.failures.get('coco'), /traecli doctor --json/)
  assert.equal(group.failures.has('traecli'), false)
})

test('agent setup documents TraeCode as a canonical native ACP agent', () => {
  const setupSource = readFileSync(path.resolve(testDir, '../../../docs/AGENT_SETUP.md'), 'utf8')
  const connectorTable = setupSource.match(/\| Requested agent \| Preferred connector \| Fallback \|[\s\S]*?(?=\n\n)/)?.[0] ?? ''
  const knownAgentTable = setupSource.match(/\| Agent name \| ACP command used by bridge \|[\s\S]*?(?=\n\n)/)?.[0] ?? ''

  assert.match(connectorTable, /`traecli` \(TraeCode CLI\).*`aamp-acp-bridge`.*`traecli acp serve`.*no CLI Bridge fallback/is)
  assert.match(knownAgentTable, /`traecli`.*`traecli acp serve`/is)
  assert.match(setupSource, /`traecli` is the external TraeCode CLI identity/)
  assert.match(setupSource, /Trae CLI（内部版）/)
  assert.match(setupSource, /Trae CLI Next（内部版）/)
  assert.match(setupSource, /TraeCode CLI/)
  assert.doesNotMatch(setupSource, /Trae CLI 2\.0/)
  assert.doesNotMatch(setupSource, /legacy[^\n]*`traecli`|`traecli`[^\n]*legacy/i)
})
