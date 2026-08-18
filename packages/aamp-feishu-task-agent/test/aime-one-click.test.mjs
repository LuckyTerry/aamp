import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function optionalFunctionRange(source, startName, endName) {
  return source.includes(startName) ? functionRange(source, startName, endName) : ''
}

function runShell(lines, args = []) {
  return spawnSync('bash', ['-c', lines.join('\n'), 'bash', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function writeExecutable(file, body) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
}

async function until(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function discoveryFunctions(source) {
  return [
    optionalFunctionRange(source, 'aime_internal_network_reachable()', 'validate_agent_name()'),
    functionRange(source, 'validate_agent_name()', 'read_tty_line()'),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    functionRange(source, 'run_internal_discover_agents()', 'prepare_internal_agent_environment()'),
  ].join('\n')
}

function discoveryFixture(source, pingStatus, command) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-discovery-'))
  const callLog = path.join(root, 'ping.log')
  return runShell([
    'set -euo pipefail',
    'PING_STATUS="$1"',
    'PING_LOG="$2"',
    'AGENT=""',
    'DETECTED_AGENTS=()',
    'AAMP_TASK_INTERNAL_RESULT_FD=3',
    'is_macos() { return 0; }',
    'ping() { printf "%s\\n" "$*" >> "$PING_LOG"; return "$PING_STATUS"; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_traex_cli() { return 1; }',
    'find_legacy_trae_cli() { return 1; }',
    'find_traecode_cli() { return 1; }',
    'find_workbuddy_cli() { return 1; }',
    'find_workbuddy_ai_cli() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    discoveryFunctions(source),
    command,
  ], [String(pingStatus), callLog])
}

function aimeInstallFunctions(source) {
  return [
    functionRange(source, 'npm_install_global_from_registry()', 'npx_package()'),
    functionRange(source, 'aime_acp_package_spec()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
    functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()'),
  ].join('\n')
}

function aimeAuthFunctions(source) {
  return [
    functionRange(source, 'aime_acp_package_spec()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'run_aime_auth_status()', 'ensure_agent_login()'),
    functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()'),
  ].join('\n')
}

function bridgeOverridePolicyFunctions(source) {
  return functionRange(
    source,
    'local_package_override_is_supported()',
    'load_agent_metadata()',
  )
}

function packageOverrideInitialization(source) {
  return functionRange(
    source,
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=',
    'ACP_PID=""',
  )
}

function runAimeOverridePolicyFixture(source, spec, cwd = '') {
  return runShell([
    'set -euo pipefail',
    'if [ -n "$2" ]; then cd "$2"; fi',
    'AAMP_TASK_DEFAULT_ACP_BRIDGE_PKG="@luckyterry/aamp-acp-bridge@0.1.29-dev.0"',
    'AAMP_TASK_DEFAULT_FEISHU_BRIDGE_PKG="@luckyterry/aamp-feishu-bridge@0.1.52-dev.4"',
    'AAMP_TASK_DEFAULT_AIME_ACP_PKG="@tengchengwei/aime-acp@0.1.1-dev.1"',
    'AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG=""',
    'AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG=""',
    'AAMP_TASK_REQUESTED_AIME_ACP_PKG="$1"',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    functionRange(source, 'aime_acp_package_spec()', 'aime_acp_package_name()'),
    bridgeOverridePolicyFunctions(source),
    'apply_task_agent_package_override_policy',
    'printf "downstream:%s" "$(aime_acp_package_spec)"',
  ], [spec, cwd])
}

function taskAgentControllerLaunchFunction(source) {
  return functionRange(source, 'run_task_agent_controller()', 'cleanup()')
}

function writeFakeAimeCli(file) {
  writeExecutable(file, [
    'printf "%s\\n" "$*" >> "$AIME_CALL_LOG"',
    'case "$1 $2" in',
    '  "auth status")',
    '    case "${AIME_AUTH_STATUS_KIND:-authenticated}" in',
    '      authenticated|unauthenticated)',
    '        printf \"{\\\"schemaVersion\\\":1,\\\"ok\\\":true,\\\"command\\\":\\\"auth.status\\\",\\\"site\\\":\\\"cn\\\",\\\"status\\\":\\\"%s\\\"}\\n\" "$AIME_AUTH_STATUS_KIND"',
    '        ;;',
    '      error)',
    '        printf \"{\\\"schemaVersion\\\":1,\\\"ok\\\":false,\\\"command\\\":\\\"auth.status\\\",\\\"site\\\":\\\"cn\\\",\\\"error\\\":{\\\"code\\\":\\\"AIME_NETWORK_UNREACHABLE\\\",\\\"message\\\":\\\"Synthetic safe error.\\\",\\\"retryable\\\":true}}\\n\"',
    '        ;;',
    '    esac',
    '    exit "${AIME_AUTH_STATUS_CODE:-0}"',
    '    ;;',
    '  "auth login") exit "${AIME_AUTH_LOGIN_CODE:-0}" ;;',
    '  "doctor --site") exit "${AIME_DOCTOR_CODE:-0}" ;;',
    '  *) exit 90 ;;',
    'esac',
  ].join('\n'))
}

function createInstalledAime(root) {
  const prefix = path.join(root, 'npm-global')
  const packageDir = path.join(prefix, 'lib/node_modules/@tengchengwei/aime-acp')
  const scopedCli = path.join(packageDir, 'dist/bin.js')
  const legacyCli = path.join(prefix, 'bin/aime-acp')
  mkdirSync(packageDir, { recursive: true })
  mkdirSync(path.dirname(scopedCli), { recursive: true })
  mkdirSync(path.dirname(legacyCli), { recursive: true })
  writeFileSync(path.join(packageDir, 'package.json'), '{"name":"@tengchengwei/aime-acp","version":"0.1.0-dev.7"}\n')
  writeFakeAimeCli(scopedCli)
  writeFakeAimeCli(legacyCli)
  return { cli: scopedCli, prefix }
}

function installTaskAgentMetadata(prefix) {
  const metadataFile = path.join(
    prefix,
    'lib/node_modules/@larktask/aamp-feishu-task-agent/bin/agent-metadata.mjs',
  )
  mkdirSync(path.dirname(metadataFile), { recursive: true })
  writeFileSync(metadataFile, readFileSync(path.resolve(testDir, '../bin/agent-metadata.mjs')))
}

function isolatedBootstrapEnv(overrides = {}) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (/^(?:npm_config_|npm_package_|npm_lifecycle_|npm_command$|npm_execpath$|npm_node_execpath$|init_cwd$)/i.test(key)) {
      delete environment[key]
    }
  }
  return { ...environment, ...overrides }
}

function runControllerBootstrapHelper({
  root,
  helperBootstrap,
  action = '__prepare-agent',
  binding = {
    agent_type: 'aime',
    aamp_host: 'https://meshmail.ai',
  },
  inputPayload,
  env = {},
}) {
  const runner = path.join(root, `controller-helper-${crypto.randomUUID()}.mjs`)
  const runLogDir = path.join(root, 'controller-run')
  const oneClickLog = path.join(runLogDir, 'one-click.log')
  const errorsLog = path.join(runLogDir, 'errors.jsonl')
  mkdirSync(runLogDir, { recursive: true })
  writeFileSync(oneClickLog, '')
  writeFileSync(errorsLog, '')
  writeFileSync(runner, [
    `const controller = await import(${JSON.stringify(`${pathToFileURL(controller).href}?helper=${crypto.randomUUID()}`)})`,
    'try {',
    `  const result = await controller.runBootstrapHelper(${JSON.stringify(action)}, ${JSON.stringify(binding)}, ${JSON.stringify(inputPayload === undefined ? {} : { AAMP_TASK_INTERNAL_BINDING_JSON: inputPayload })})`,
    "  console.log(JSON.stringify({ type: 'helper.result', result }))",
    '} catch (error) {',
    "  console.error(JSON.stringify({ type: 'helper.error', message: error instanceof Error ? error.message : String(error) }))",
    '  process.exitCode = 1',
    '} finally {',
    '  await controller.cleanupAll()',
    '}',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [runner], {
    input: '',
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedBootstrapEnv({
      HOME: root,
      AAMP_TASK_BOOTSTRAP_PATH: helperBootstrap,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: runLogDir,
      AAMP_RUN_ID: 'remote-helper-test',
      ONE_CLICK_LOG: oneClickLog,
      ERRORS_LOG: errorsLog,
      ...env,
    }),
  })
  return {
    ...result,
    oneClickLog: readFileSync(oneClickLog, 'utf8'),
    errorsLog: readFileSync(errorsLog, 'utf8'),
  }
}

test('remote bootstrap preserves actionable failure text while redacting credentials', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-remote-diagnostic-output-'))
  const helper = path.join(root, 'helper.sh')
  writeExecutable(helper, [
    "printf '%s\n' 'AIME_ACP_INSTALL_FAILED: AIME ACP installation failed. Authorization: Bearer helper-bearer-sentinel access_token=helper-token-sentinel' >&2",
    'exit 73',
  ].join('\n'))

  const result = runControllerBootstrapHelper({
    root,
    helperBootstrap: helper,
  })
  const surfaces = `${result.stdout}\n${result.stderr}\n${result.oneClickLog}\n${result.errorsLog}`

  assert.equal(result.status, 1)
  assert.match(surfaces, /AIME_ACP_INSTALL_FAILED/)
  assert.match(surfaces, /AIME ACP installation failed/)
  assert.doesNotMatch(surfaces, /helper-bearer-sentinel|helper-token-sentinel/)
  assert.doesNotMatch(surfaces, /REMOTE OUTPUT REDACTED|redacted diagnostics/)
})

function runAimeAuthFixture(source, { statusCode, statusKind, loginCode, doctorCode }) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-auth-'))
  const { prefix } = createInstalledAime(root)
  const callLog = path.join(root, 'aime-calls.log')
  const result = runShell([
    'set -euo pipefail',
    'AGENT="aime"',
    'NPM_GLOBAL_PREFIX="$1"',
    'AIME_CALL_LOG="$2"',
    'AIME_AUTH_STATUS_CODE="$3"',
    'AIME_AUTH_STATUS_KIND="$4"',
    'AIME_AUTH_LOGIN_CODE="$5"',
    'AIME_DOCTOR_CODE="$6"',
    'export AIME_CALL_LOG AIME_AUTH_STATUS_CODE AIME_AUTH_STATUS_KIND AIME_AUTH_LOGIN_CODE AIME_DOCTOR_CODE',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    aimeAuthFunctions(source),
    'ensure_agent_login',
  ], [
    prefix,
    callLog,
    String(statusCode),
    statusKind ?? (statusCode === 0 ? 'authenticated' : 'unauthenticated'),
    String(loginCode),
    String(doctorCode),
  ])
  const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
  return { ...result, calls }
}

test('AIME is discovered only when the internal host answers ping', () => {
  const source = readFileSync(bootstrap, 'utf8')

  const interactive = discoveryFixture(
    source,
    0,
    'validate_agent_name aime; discover_interactive_agents; printf "%s" "${DETECTED_AGENTS[*]}"',
  )
  assert.equal(interactive.status, 0, interactive.stderr)
  assert.equal(interactive.stdout, 'aime')

  const internal = discoveryFixture(source, 0, 'exec 3>&1; run_internal_discover_agents')
  assert.equal(internal.status, 0, internal.stderr)
  assert.deepEqual(JSON.parse(internal.stdout), { agents: ['aime'] })

  const unavailable = discoveryFixture(source, 1, 'discover_interactive_agents')
  assert.equal(unavailable.status, 64)
  assert.match(unavailable.stderr, /暂未检测到本地智能体/)
})

test('explicit AIME selection fails before setup when the internal host is unreachable', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = discoveryFixture(
    source,
    1,
    'validate_agent_name aime; ensure_agent_selection_available aime',
  )

  assert.equal(result.status, 64)
  assert.match(result.stderr, /AIME.*公司内网/)
  assert.match(result.stderr, /aime\.bytedance\.net/)
})

test('explicit AIME entry fails before toolchain or one-click installation side effects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-entry-'))
  const binDir = path.join(root, 'bin')
  const sideEffectLog = path.join(root, 'side-effects.log')
  mkdirSync(binDir)
  writeExecutable(path.join(binDir, 'ping'), 'exit 1')
  for (const command of ['node', 'npm', 'npx']) {
    writeExecutable(
      path.join(binDir, command),
      `printf '%s\\n' ${JSON.stringify(command)} >> ${JSON.stringify(sideEffectLog)}\nexit 91`,
    )
  }

  const result = spawnSync('bash', [bootstrap, 'install', '--agent', 'aime'], {
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AIME.*公司内网/)
  assert.match(result.stderr, /aime\.bytedance\.net/)
  assert.equal(existsSync(sideEffectLog), false)
  assert.equal(existsSync(path.join(root, '.aamp')), false)
})

test('AIME help remains side-effect light and does not ping', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-help-'))
  const binDir = path.join(root, 'bin')
  const pingLog = path.join(root, 'ping.log')
  mkdirSync(binDir)
  writeExecutable(path.join(binDir, 'ping'), `printf 'called\\n' >> ${JSON.stringify(pingLog)}\nexit 1`)

  const result = spawnSync('bash', [bootstrap, '--agent', 'aime', '--help'], {
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--agent.*aime/)
  assert.equal(existsSync(pingLog), false)
})

test('a pending remote AIME binding without a local profile is accepted and displayed verbatim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-aime-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '44444444-4444-4444-8444-444444444444'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings: [{
      binding_id: bindingId,
      agent_type: 'aime',
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: {
        app_id: 'cli_aime_test',
        app_secret: 'aime-test-only-secret',
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
  assert.match(result.stdout, /aime/)
  assert.doesNotMatch(result.stdout, /aime-test-only-secret/)
})

test('a local binding without a lark-cli profile remains invalid', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-local-profile-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings: [{
      binding_id: bindingId,
      agent_type: 'codex',
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: { app_id: 'cli_local_test', app_secret: 'local-test-only-secret' },
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

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /bindings\[0\]\.bot\.lark_cli_profile/)
})

test('AIME preparation installs the fixed package into the isolated prefix and builds an absolute ACP command', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const pinnedAime = /AIME_ACP_PKG="\$\{AIME_ACP_PKG:-@tengchengwei\/aime-acp@([^}]+)\}"/.exec(source)?.[1]
  assert.ok(pinnedAime)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-install-'))
  const prefix = path.join(root, 'npm-global')
  const cache = path.join(root, 'npm-cache')
  const fakeNpm = path.join(root, 'npm')
  const fakeCliTemplate = path.join(root, 'aime-acp-template')
  const npmLog = path.join(root, 'npm-calls.log')
  writeFakeAimeCli(fakeCliTemplate)
  writeExecutable(fakeNpm, [
    'printf "%s\\n" "$*" >> "$FAKE_NPM_LOG"',
    'prefix=""',
    'previous=""',
    'for argument in "$@"; do',
    '  if [ "$previous" = "--prefix" ]; then prefix="$argument"; fi',
    '  previous="$argument"',
    'done',
    'mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@tengchengwei/aime-acp/dist"',
    `printf "%s\\n" \"{\\\"name\\\":\\\"@tengchengwei/aime-acp\\\",\\\"version\\\":\\\"${pinnedAime}\\\"}\" > "$prefix/lib/node_modules/@tengchengwei/aime-acp/package.json"`,
    'cp "$FAKE_AIME_TEMPLATE" "$prefix/lib/node_modules/@tengchengwei/aime-acp/dist/bin.js"',
    'chmod +x "$prefix/lib/node_modules/@tengchengwei/aime-acp/dist/bin.js"',
  ].join('\n'))

  const result = runShell([
    'set -euo pipefail',
    'AGENT="aime"',
    'NPM_GLOBAL_PREFIX="$1"',
    'NPM_CACHE_DIR="$2"',
    'NPM_BIN="$3"',
    'FAKE_AIME_TEMPLATE="$4"',
    'FAKE_NPM_LOG="$5"',
    'AIME_CALL_LOG="$6"',
    'export FAKE_AIME_TEMPLATE FAKE_NPM_LOG AIME_CALL_LOG',
    'mkdir -p "$NPM_CACHE_DIR"',
    'mkdir -p "$NPM_GLOBAL_PREFIX/lib/node_modules/aime-acp" "$NPM_GLOBAL_PREFIX/bin"',
    'printf legacy > "$NPM_GLOBAL_PREFIX/lib/node_modules/aime-acp/package.json"',
    'printf legacy > "$NPM_GLOBAL_PREFIX/bin/aime-acp"',
    'aime_internal_network_reachable() { return 0; }',
    'remote_internal_helper() { return 1; }',
    'sanitize_inherited_npm_exec_env() { :; }',
    'npm_log_indicates_cache_error() { return 1; }',
    'reset_npm_cache_for_retry() { :; }',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    aimeInstallFunctions(source),
    'ensure_agent_cli',
    'ensure_agent_cli',
    'test ! -e "$NPM_GLOBAL_PREFIX/lib/node_modules/aime-acp"',
    'test ! -e "$NPM_GLOBAL_PREFIX/bin/aime-acp"',
    'build_acp_agent_command',
    'eval "set -- $ACP_AGENT_COMMAND"',
    'printf "%s|%s|%s" "$1" "$2" "$3"',
  ], [prefix, cache, fakeNpm, fakeCliTemplate, npmLog, path.join(root, 'aime-calls.log')])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${prefix}/lib/node_modules/@tengchengwei/aime-acp/dist/bin.js|--site|cn`)
  const installs = readFileSync(npmLog, 'utf8').trim().split('\n')
  assert.deepEqual(installs, [
    `install -g --registry https://bnpm.byted.org --cache ${cache} --prefix ${prefix} @tengchengwei/aime-acp@${pinnedAime}`,
  ])
})

test('AIME command preparation keeps the exact ACP command private and logs only structural setup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-private-command-'))
  const { prefix } = createInstalledAime(root)
  const detailLog = path.join(root, 'prepare-details.log')
  const result = runShell([
    'set -euo pipefail',
    'AGENT="aime"',
    'NPM_GLOBAL_PREFIX="$1"',
    'DETAIL_LOG="$2"',
    'agent_detail() { printf "%s\\n" "$*" >> "$DETAIL_LOG"; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    aimeInstallFunctions(source),
    'build_acp_agent_command',
    'printf "%s" "$ACP_AGENT_COMMAND"',
  ], [prefix, detailLog])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `'${prefix}/lib/node_modules/@tengchengwei/aime-acp/dist/bin.js' --site cn`)
  const details = readFileSync(detailLog, 'utf8')
  assert.equal(details, 'AIME ACP configured for site cn\n')
  assert.equal(details.includes(prefix), false)
  assert.equal(details.includes(result.stdout), false)
})

test('AIME legacy cleanup preserves the canonical scoped package CLI symlink', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-canonical-bin-'))
  const prefix = path.join(root, 'npm-global')
  const packageDir = path.join(prefix, 'lib/node_modules/@tengchengwei/aime-acp')
  const scopedCli = path.join(packageDir, 'dist/bin.js')
  const globalCli = path.join(prefix, 'bin/aime-acp')
  mkdirSync(path.dirname(scopedCli), { recursive: true })
  mkdirSync(path.dirname(globalCli), { recursive: true })
  writeExecutable(scopedCli, '#!/usr/bin/env node\n')
  symlinkSync('../lib/node_modules/@tengchengwei/aime-acp/dist/bin.js', globalCli)

  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX="$1"',
    aimeAuthFunctions(source),
    'remove_legacy_aime_acp',
    'test -L "$NPM_GLOBAL_PREFIX/bin/aime-acp"',
    'readlink "$NPM_GLOBAL_PREFIX/bin/aime-acp"',
  ], [prefix])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '../lib/node_modules/@tengchengwei/aime-acp/dist/bin.js')
})

test('AIME legacy cleanup removes an obsolete bin when the canonical package is absent', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-obsolete-bin-'))
  const prefix = path.join(root, 'npm-global')
  const legacyDir = path.join(prefix, 'lib/node_modules/aime-acp')
  const legacyCli = path.join(legacyDir, 'dist/bin.js')
  const globalCli = path.join(prefix, 'bin/aime-acp')
  mkdirSync(path.dirname(legacyCli), { recursive: true })
  mkdirSync(path.dirname(globalCli), { recursive: true })
  writeExecutable(legacyCli, '#!/usr/bin/env node\n')
  symlinkSync('../lib/node_modules/aime-acp/dist/bin.js', globalCli)

  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX="$1"',
    aimeAuthFunctions(source),
    'remove_legacy_aime_acp',
    'test ! -e "$NPM_GLOBAL_PREFIX/lib/node_modules/aime-acp"',
    'test ! -L "$NPM_GLOBAL_PREFIX/bin/aime-acp"',
  ], [prefix])

  assert.equal(result.status, 0, result.stderr)
})

test('AIME preparation ignores an inherited non-canonical package and uses the embedded pin', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const pinnedAime = '@tengchengwei/aime-acp@0.1.1-dev.1'
  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX="$1"',
    'AIME_ACP_PKG="@luckyterry/aime-acp@0.1.0-dev.1"',
    'AIME_ACP_REGISTRY="https://registry.npmjs.org"',
    aimeAuthFunctions(source),
    'printf "%s|%s" "$(aime_acp_package_spec)" "$(aime_acp_registry)"',
  ], ['/tmp/aamp-aime-personal-trial'])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${pinnedAime}|https://bnpm.byted.org`)
})

test('AIME runtime accepts the scoped package recorded by the current BNPM release identity', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX=/tmp/aamp-bnpm-identity-prefix',
    'AIME_ACP_PKG=@zengxingyuan/aime-acp@0.1.2-dev.0',
    aimeAuthFunctions(source),
    'printf "%s|%s|%s|%s" "$(aime_acp_package_spec)" "$(aime_acp_package_name)" "$(aime_acp_package_version)" "$(aime_acp_package_dir)"',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    '@zengxingyuan/aime-acp@0.1.2-dev.0|@zengxingyuan/aime-acp|0.1.2-dev.0|/tmp/aamp-bnpm-identity-prefix/lib/node_modules/@zengxingyuan/aime-acp',
  )
})

test('AIME preparation ignores an inherited remote tgz URL without exposing it', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runShell([
    'set -euo pipefail',
    'AIME_ACP_PKG="https://user:secret@example.invalid/aime-acp.tgz"',
    aimeAuthFunctions(source),
    'aime_acp_package_spec',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '@tengchengwei/aime-acp@0.1.1-dev.1\n')
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /user:secret|example\.invalid/)
})

test('AIME local tgz specs still resolve the installed scoped package directory', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-local-tgz-'))
  const tgz = path.join(root, 'tengchengwei-aime-acp-0.1.1-dev.1.tgz')
  writeFileSync(tgz, 'local test artifact')
  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX="$1"',
    'AIME_ACP_PKG="$2"',
    aimeAuthFunctions(source),
    'printf "%s|%s" "$(aime_acp_package_dir)" "$(aime_acp_package_version || true)"',
  ], ['/tmp/aamp-shared-prefix', tgz])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    '/tmp/aamp-shared-prefix/lib/node_modules/@tengchengwei/aime-acp|',
  )
})

test('AIME local tgz resolves its packaged canonical name when the recorded BNPM scope differs', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-local-cross-scope-tgz-'))
  const archiveRoot = path.join(root, 'archive')
  const packageRoot = path.join(archiveRoot, 'package')
  const tgz = path.join(root, 'canonical-aime-acp.tgz')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@tengchengwei/aime-acp","version":"0.1.1-dev.1"}\n')
  const packed = spawnSync('tar', ['-czf', tgz, '-C', archiveRoot, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)

  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX=/tmp/aamp-cross-scope-prefix',
    'AAMP_TASK_DEFAULT_AIME_ACP_PKG=@zengxingyuan/aime-acp@0.1.2-dev.0',
    'AIME_ACP_PKG="$1"',
    aimeAuthFunctions(source),
    'printf "%s|%s" "$(aime_acp_package_name)" "$(aime_acp_package_dir)"',
  ], [tgz])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    '@tengchengwei/aime-acp|/tmp/aamp-cross-scope-prefix/lib/node_modules/@tengchengwei/aime-acp',
  )
})

test('AIME local tgz specs force installation even when a scoped package is already present', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-force-local-tgz-'))
  const tgz = path.join(root, 'tengchengwei-aime-acp-0.1.1-dev.1.tgz')
  writeFileSync(tgz, 'local test artifact')
  const result = runShell([
    'set -euo pipefail',
    'NPM_GLOBAL_PREFIX="$1"',
    'AIME_ACP_PKG="$2"',
    'mkdir -p "$NPM_GLOBAL_PREFIX/lib/node_modules/@tengchengwei/aime-acp/dist"',
    'printf "{\"name\":\"@tengchengwei/aime-acp\",\"version\":\"0.1.0-dev.10\"}\n" > "$NPM_GLOBAL_PREFIX/lib/node_modules/@tengchengwei/aime-acp/package.json"',
    'touch "$NPM_GLOBAL_PREFIX/lib/node_modules/@tengchengwei/aime-acp/dist/bin.js"',
    aimeAuthFunctions(source),
    'if aime_acp_install_is_current; then exit 41; fi',
  ], ['/tmp/aamp-shared-prefix', tgz])

  assert.equal(result.status, 0, result.stderr)
})

test('normal Task Agent start ignores inherited package overrides and keeps the released AIME pin', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runShell([
    'set -euo pipefail',
    'AAMP_TASK_DEFAULT_ACP_BRIDGE_PKG="@luckyterry/aamp-acp-bridge@0.1.29-dev.0"',
    'AAMP_TASK_DEFAULT_FEISHU_BRIDGE_PKG="@luckyterry/aamp-feishu-bridge@0.1.52-dev.4"',
    'AAMP_TASK_DEFAULT_AIME_ACP_PKG="@tengchengwei/aime-acp@0.1.1-dev.1"',
    'AAMP_TASK_REQUESTED_AIME_ACP_PKG="https://user:inherited-secret@example.invalid/aime-acp.tgz"',
    'AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG="/tmp/aamp-local-release/old-acp.tgz"',
    'AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG="file:/tmp/old-feishu"',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=false',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    bridgeOverridePolicyFunctions(source),
    'apply_task_agent_package_override_policy',
    'printf "%s|%s|%s" "$ACP_BRIDGE_PKG" "$FEISHU_BRIDGE_PKG" "$AIME_ACP_PKG"',
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    '@luckyterry/aamp-acp-bridge@0.1.29-dev.0|@luckyterry/aamp-feishu-bridge@0.1.52-dev.4|@tengchengwei/aime-acp@0.1.1-dev.1',
  )
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /inherited-secret|example\.invalid/)
})

test('explicit local package override opt-in accepts bridge directories and an AIME tgz', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-explicit-local-overrides-'))
  const acpTgz = path.join(root, 'acp.tgz')
  const aimeTgz = path.join(root, 'aime.tgz')
  const feishuDir = path.join(root, 'feishu')
  writeFileSync(acpTgz, 'local acp artifact')
  writeFileSync(aimeTgz, 'local aime artifact')
  mkdirSync(feishuDir)
  const result = runShell([
    'set -euo pipefail',
    'AAMP_TASK_DEFAULT_ACP_BRIDGE_PKG="@luckyterry/aamp-acp-bridge@0.1.29-dev.0"',
    'AAMP_TASK_DEFAULT_FEISHU_BRIDGE_PKG="@luckyterry/aamp-feishu-bridge@0.1.52-dev.4"',
    'AAMP_TASK_DEFAULT_AIME_ACP_PKG="@tengchengwei/aime-acp@0.1.1-dev.1"',
    'AAMP_TASK_REQUESTED_AIME_ACP_PKG="$3"',
    'AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG="$1"',
    'AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG="file:$2"',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    bridgeOverridePolicyFunctions(source),
    'apply_task_agent_package_override_policy',
    'printf "%s|%s|%s" "$ACP_BRIDGE_PKG" "$FEISHU_BRIDGE_PKG" "$AIME_ACP_PKG"',
  ], [acpTgz, feishuDir, aimeTgz])

  assert.equal(result.status, 0, result.stderr)
  const [actualAcp, actualFeishu, actualAime] = result.stdout.split('|')
  assert.equal(actualAcp, acpTgz)
  assert.equal(actualFeishu, `file:${feishuDir}`)
  assert.match(actualAime, /^\//)
  assert.equal(readFileSync(actualAime, 'utf8'), 'local aime artifact')
})

test('explicit local package override opt-in rejects missing artifacts without exposing paths', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runShell([
    'set -euo pipefail',
    'AAMP_TASK_DEFAULT_ACP_BRIDGE_PKG="@luckyterry/aamp-acp-bridge@0.1.29-dev.0"',
    'AAMP_TASK_DEFAULT_FEISHU_BRIDGE_PKG="@luckyterry/aamp-feishu-bridge@0.1.52-dev.4"',
    'AAMP_TASK_DEFAULT_AIME_ACP_PKG="@tengchengwei/aime-acp@0.1.1-dev.1"',
    'AAMP_TASK_REQUESTED_ACP_BRIDGE_PKG="/private/missing/credential-sentinel.tgz"',
    'AAMP_TASK_REQUESTED_FEISHU_BRIDGE_PKG=""',
    'AAMP_TASK_REQUESTED_AIME_ACP_PKG=""',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    bridgeOverridePolicyFunctions(source),
    'apply_task_agent_package_override_policy',
  ])

  assert.equal(result.status, 64)
  assert.match(result.stderr, /Local ACP Bridge package override is invalid/)
  assert.doesNotMatch(result.stderr, /private|credential-sentinel/)
})

for (const invalidOverride of [
  {
    name: 'an existing file directory',
    createSpec(root) {
      const directory = path.join(root, 'directory-credential-sentinel')
      mkdirSync(directory)
      return `file:${directory}`
    },
    secretPattern: /directory-credential-sentinel/,
  },
  {
    name: 'a remote tgz URL even when a URL-shaped local tree exists',
    createSpec(root) {
      const spec = 'https://user:remote-secret@example.invalid/aime-acp.tgz'
      const collision = path.join(root, 'https:/user:remote-secret@example.invalid/aime-acp.tgz')
      mkdirSync(path.dirname(collision), { recursive: true })
      writeFileSync(collision, 'must not turn a URL into a local override')
      return spec
    },
    useRootAsCwd: true,
    secretPattern: /remote-secret|example\.invalid/,
  },
  {
    name: 'a named remote tgz URL even when a matching local tree exists',
    createSpec(root) {
      const spec = 'aime@https://named-remote-secret.example.invalid/aime.tgz'
      const collision = path.join(root, 'aime@https:/named-remote-secret.example.invalid/aime.tgz')
      mkdirSync(path.dirname(collision), { recursive: true })
      writeFileSync(collision, 'must not turn a named remote spec into a local override')
      return spec
    },
    useRootAsCwd: true,
    secretPattern: /named-remote-secret|example\.invalid/,
  },
  {
    name: 'a file-prefixed tgz even when that relative filename exists',
    createSpec(root) {
      const spec = 'file:prefixed-credential-sentinel.tgz'
      writeFileSync(path.join(root, spec), 'must not accept file: package specs')
      return spec
    },
    useRootAsCwd: true,
    secretPattern: /prefixed-credential-sentinel/,
  },
  {
    name: 'an option-shaped tgz even when that relative filename exists',
    createSpec(root) {
      const spec = '--option-credential-sentinel.tgz'
      writeFileSync(path.join(root, spec), 'must not accept option-shaped specs')
      return spec
    },
    useRootAsCwd: true,
    secretPattern: /option-credential-sentinel/,
  },
  {
    name: 'a missing local tgz',
    createSpec(root) {
      return path.join(root, 'missing-credential-sentinel.tgz')
    },
    secretPattern: /missing-credential-sentinel/,
  },
  {
    name: 'the canonical remote package spec',
    createSpec() {
      return '@tengchengwei/aime-acp@0.1.1-dev.1'
    },
    secretPattern: /@tengchengwei\/aime-acp@0\.1\.1-dev\.1/,
  },
]) {
  test(`explicit AIME override opt-in rejects ${invalidOverride.name} before downstream setup`, () => {
    const source = readFileSync(bootstrap, 'utf8')
    const root = mkdtempSync(path.join(tmpdir(), 'aamp-invalid-aime-override-'))
    const result = runAimeOverridePolicyFixture(
      source,
      invalidOverride.createSpec(root),
      invalidOverride.useRootAsCwd ? root : '',
    )

    assert.doesNotMatch(result.stdout, /downstream|@tengchengwei\/aime-acp/)
    assert.equal(result.status, 64)
    assert.match(result.stderr, /AIME_ACP_PACKAGE_OVERRIDE_INVALID/)
    assert.match(result.stderr, /existing local \.tgz file/)
    assert.doesNotMatch(result.stderr, invalidOverride.secretPattern)
  })
}

test('AIME canonicalizes a shorthand-shaped local tgz before downstream setup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-shorthand-local-'))
  const relativeSpec = 'owner/artifact.tgz'
  const absoluteSpec = path.join(root, relativeSpec)
  mkdirSync(path.dirname(absoluteSpec), { recursive: true })
  writeFileSync(absoluteSpec, 'local AIME artifact')

  const result = runAimeOverridePolicyFixture(source, relativeSpec, root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^downstream:\//)
  assert.notEqual(result.stdout, `downstream:${relativeSpec}`)
  assert.equal(readFileSync(result.stdout.slice('downstream:'.length), 'utf8'), 'local AIME artifact')
})

test('bridge-only opt-in keeps the released AIME pin across outer controller and helper launch', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-bridge-only-controller-helper-'))
  const helper = path.join(root, 'helper.sh')
  const outer = path.join(root, 'outer.sh')
  const runner = path.join(root, 'controller-runner.mjs')
  const acpTgz = path.join(root, 'acp.tgz')
  const feishuDir = path.join(root, 'feishu')
  writeFileSync(acpTgz, 'local acp artifact')
  mkdirSync(feishuDir)
  writeExecutable(helper, [
    'set -euo pipefail',
    'AAMP_TASK_INTERNAL="${AAMP_TASK_INTERNAL:-false}"',
    packageOverrideInitialization(source),
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    bridgeOverridePolicyFunctions(source),
    'apply_task_agent_package_override_policy',
    `printf '{"acp":"%s","feishu":"%s","aime":"%s"}\\n' "$ACP_BRIDGE_PKG" "$FEISHU_BRIDGE_PKG" "$AIME_ACP_PKG" >&3`,
  ].join('\n'))
  writeFileSync(runner, [
    `const controller = await import(${JSON.stringify(`${pathToFileURL(controller).href}?bridgeOnly=${crypto.randomUUID()}`)})`,
    'try {',
    "  const result = await controller.runBootstrapHelper('__discover-agents', { agent_type: 'aime', aamp_host: 'https://meshmail.ai' })",
    '  console.log(JSON.stringify(result))',
    '} finally {',
    '  await controller.cleanupAll()',
    '}',
    '',
  ].join('\n'))
  writeExecutable(outer, [
    'set -euo pipefail',
    'AAMP_TASK_INTERNAL=false',
    packageOverrideInitialization(source),
    'AAMP_TASK_AGENT_NAME=@luckyterry/aamp-feishu-task-agent',
    'AAMP_TASK_AGENT_CHANNEL=dev',
    'AAMP_TASK_ACTION=start',
    'NPM_BIN=npm',
    'NPX_BIN=npx',
    'CODEX_ACP_PKG=@agentclientprotocol/codex-acp@1.0.2',
    'AAMP_TASK_AGENT_VERSION=0.1.1-dev.1',
    'AGENT=""',
    'AAMP_HOST=https://meshmail.ai',
    'DEBUG_MODE=false',
    'NPM_REGISTRY=https://registry.npmjs.org/',
    'NPM_CACHE_DIR="${NPM_CACHE_DIR:-$HOME/npm-cache}"',
    'NPM_GLOBAL_PREFIX="${NPM_GLOBAL_PREFIX:-$HOME/npm-prefix}"',
    'AAMP_LARK_CLI_CONFIG_DIR="${AAMP_LARK_CLI_CONFIG_DIR:-$HOME/lark-config}"',
    'AAMP_RUN_LOG_DIR="${AAMP_RUN_LOG_DIR:-$HOME/controller-run}"',
    'export AAMP_RUN_LOG_DIR',
    'mkdir -p "$AAMP_RUN_LOG_DIR"',
    'task_agent_controller_path() { printf "%s\n" "$FAKE_CONTROLLER"; }',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    bridgeOverridePolicyFunctions(source),
    taskAgentControllerLaunchFunction(source),
    'apply_task_agent_package_override_policy',
    'run_task_agent_controller',
  ].join('\n'))

  const runOuter = (packageEnv) => spawnSync('bash', [outer], {
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedBootstrapEnv({
      HOME: root,
      ACP_BRIDGE_PKG: '',
      AAMP_TASK_ACP_BRIDGE_PKG: '',
      FEISHU_BRIDGE_PKG: '',
      AAMP_TASK_FEISHU_BRIDGE_PKG: '',
      AIME_ACP_PKG: '',
      AAMP_TASK_AIME_ACP_PKG: '',
      AAMP_TASK_ALLOW_PACKAGE_OVERRIDES: 'true',
      AAMP_TASK_COMMAND_PATH: helper,
      FAKE_CONTROLLER: runner,
      ...packageEnv,
    }),
  })

  const acpResult = runOuter({ ACP_BRIDGE_PKG: acpTgz })
  assert.equal(acpResult.status, 0, acpResult.stderr)
  assert.deepEqual(JSON.parse(acpResult.stdout), {
    acp: acpTgz,
    feishu: '@luckyterry/aamp-feishu-bridge@0.1.52-dev.4',
    aime: '@tengchengwei/aime-acp@0.1.1-dev.1',
  })

  const feishuResult = runOuter({ FEISHU_BRIDGE_PKG: `file:${feishuDir}` })
  assert.equal(feishuResult.status, 0, feishuResult.stderr)
  assert.deepEqual(JSON.parse(feishuResult.stdout), {
    acp: '@luckyterry/aamp-acp-bridge@0.1.29-dev.0',
    feishu: `file:${feishuDir}`,
    aime: '@tengchengwei/aime-acp@0.1.1-dev.1',
  })
})

test('Task Agent controller explicitly propagates local AIME and bridge override state', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-override-env-'))
  const fakeNode = path.join(root, 'node')
  const fakeController = path.join(root, 'controller.mjs')
  const fakeBootstrap = path.join(root, 'bootstrap.sh')
  const acpTgz = path.join(root, 'acp.tgz')
  const aimeTgz = path.join(root, 'aime.tgz')
  const feishuDir = path.join(root, 'feishu')
  writeExecutable(fakeNode, [
    'printf "%s|%s|%s|%s" \\',
    '  "$AAMP_TASK_ACP_BRIDGE_PKG" \\',
    '  "$AAMP_TASK_FEISHU_BRIDGE_PKG" \\',
    '  "$AAMP_TASK_AIME_ACP_PKG" \\',
    '  "$AAMP_TASK_ALLOW_PACKAGE_OVERRIDES"',
  ].join('\n'))
  writeFileSync(fakeController, '')
  writeFileSync(fakeBootstrap, '')
  writeFileSync(acpTgz, 'local acp artifact')
  writeFileSync(aimeTgz, 'local aime artifact')
  mkdirSync(feishuDir)

  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$PATH"',
    'FAKE_CONTROLLER="$2"',
    'AAMP_TASK_COMMAND_PATH="$3"',
    'ACP_BRIDGE_PKG="$4"',
    'FEISHU_BRIDGE_PKG="file:$5"',
    'AIME_ACP_PKG="$6"',
    'AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true',
    'AAMP_TASK_AGENT_NAME=@luckyterry/aamp-feishu-task-agent',
    'AAMP_TASK_AGENT_CHANNEL=dev',
    'AAMP_TASK_ACTION=start',
    'NPM_BIN=npm',
    'NPX_BIN=npx',
    'CODEX_ACP_PKG=@agentclientprotocol/codex-acp@1.0.2',
    'AAMP_TASK_AGENT_VERSION=0.1.0-dev.202',
    'AGENT=aime',
    'AAMP_HOST=https://meshmail.ai',
    'DEBUG_MODE=false',
    'NPM_REGISTRY=https://registry.npmjs.org/',
    'NPM_CACHE_DIR=/tmp/aamp-cache',
    'NPM_GLOBAL_PREFIX=/tmp/aamp-prefix',
    'AAMP_LARK_CLI_CONFIG_DIR=/tmp/lark-config',
    'task_agent_controller_path() { printf "%s\n" "$FAKE_CONTROLLER"; }',
    'agent_fail() { printf "%s\n" "$*" >&2; exit 64; }',
    taskAgentControllerLaunchFunction(source),
    'run_task_agent_controller',
  ], [root, fakeController, fakeBootstrap, acpTgz, feishuDir, aimeTgz])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    `${acpTgz}|file:${feishuDir}|${aimeTgz}|true`,
  )
})

test('AIME readiness logs in once and requires doctor to pass', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runAimeAuthFixture(source, { statusCode: 1, loginCode: 0, doctorCode: 0 })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls, [
    'auth status --site cn --json',
    'auth login --site cn',
    'doctor --site cn --json',
  ])
})

test('AIME pending login stops before doctor with a safe retry instruction', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runAimeAuthFixture(source, { statusCode: 1, loginCode: 2, doctorCode: 0 })

  assert.equal(result.status, 64)
  assert.deepEqual(result.calls, [
    'auth status --site cn --json',
    'auth login --site cn',
  ])
  assert.match(result.stderr, /登录仍在等待完成/)
  assert.match(result.stderr, /aime-acp auth login --site cn/)
})

test('AIME doctor failure is fail-closed and never starts a second login', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runAimeAuthFixture(source, { statusCode: 0, loginCode: 0, doctorCode: 1 })

  assert.equal(result.status, 64)
  assert.deepEqual(result.calls, [
    'auth status --site cn --json',
    'doctor --site cn --json',
  ])
  assert.match(result.stderr, /doctor.*未通过/i)
})

test('AIME status errors fail closed without attempting login', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const result = runAimeAuthFixture(source, {
    statusCode: 1,
    statusKind: 'error',
    loginCode: 0,
    doctorCode: 0,
  })

  assert.equal(result.status, 64)
  assert.deepEqual(result.calls, ['auth status --site cn --json'])
  assert.match(result.stderr, /认证状态检查失败/)
})

test('AIME bridge config uses shared remote metadata to reject attachments and serialize task dispatch', async () => {
  const module = await import(pathToFileURL(controller).href)
  assert.equal(typeof module.acpBridgeAgentPolicy, 'function')

  const aime = module.acpBridgeAgentPolicy('aime')
  assert.deepEqual(aime, {
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  })

  assert.deepEqual(module.acpBridgeAgentPolicy('codex'), { executionLocation: 'local' })
})

test('AIME initialization sends the exact remote Agent object to ACP init', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-aime-init-'))
  const runtimeHome = path.join(root, 'runtime-v1')
  const captureFile = path.join(root, 'acp-init.json')
  const fakeNpm = path.join(root, 'npm')
  const fakeAcp = path.join(root, 'aamp-acp-bridge')
  const legacyConfigDir = path.join(root, 'legacy-lark-config')
  const legacyProfileFile = path.join(legacyConfigDir, 'profiles', 'aime-legacy-profile.json')
  const legacySentinel = Buffer.from('{"legacy":"retained-aime-profile-sentinel"}\n')
  const host = 'https://meshmail.ai'
  const bindingId = '66666666-6666-4666-8666-666666666666'
  mkdirSync(path.dirname(legacyProfileFile), { recursive: true })
  writeFileSync(legacyProfileFile, legacySentinel, { mode: 0o640 })
  chmodSync(legacyProfileFile, 0o640)
  const legacyMode = statSync(legacyProfileFile).mode & 0o777
  writeExecutable(fakeNpm, [
    "printf '%s\\n' 'api_key=resolver-api-key-sentinel /Users/resolver/private C:\\Users\\resolver\\private \\\\resolver\\share' >&2",
    'node -e \'process.stdout.write(JSON.stringify({ executable: "aamp-acp-bridge", kind: "direct", command: process.env.FAKE_ACP_BIN, pathValue: process.env.PATH, environment: {} }))\'',
  ].join('\n'))
  writeExecutable(fakeAcp, [
    "printf '%s\\n' 'password=acp-password-sentinel --cwd /Users/acp/private --agent /safe/bin/aime-acp' >&2",
    'node -e \'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",(chunk)=>{input+=chunk});process.stdin.on("end",()=>{require("fs").writeFileSync(process.env.ACP_CAPTURE_FILE,input);process.stdout.write(JSON.stringify({agents:[{name:"aime",email:"aime@meshmail.ai"}]}))})\'',
  ].join('\n'))
  const binding = {
    binding_id: bindingId,
    agent_type: 'aime',
    aamp_host: host,
    environment: { name: 'online' },
    bot: {
      app_id: 'cli_remote',
      app_secret: 'remote-secret',
      lark_cli_profile: 'aime-legacy-profile',
    },
    feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
    state: 'pending',
  }
  const envKeys = [
    'HOME', 'AAMP_TASK_RUNTIME_HOME', 'AAMP_TASK_STATE_HOME', 'AAMP_RUN_LOG_DIR',
    'AAMP_TASK_NPM_BIN', 'AAMP_TASK_NPM_CACHE_DIR',
    'AAMP_LARK_CLI_CONFIG_DIR', 'FAKE_ACP_BIN', 'ACP_CAPTURE_FILE',
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, {
      HOME: root,
      AAMP_TASK_RUNTIME_HOME: runtimeHome,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_RUN_LOG_DIR: path.join(root, 'logs'),
      AAMP_TASK_NPM_BIN: fakeNpm,
      AAMP_TASK_NPM_CACHE_DIR: path.join(root, 'npm-cache'),
      AAMP_LARK_CLI_CONFIG_DIR: legacyConfigDir,
      FAKE_ACP_BIN: fakeAcp,
      ACP_CAPTURE_FILE: captureFile,
    })
    const module = await import(`${pathToFileURL(controller).href}?aime-init=${Date.now()}`)
    const groups = await module.initializeAgentGroups([binding], {
      runBootstrapHelper: async (action, candidate) => {
        assert.equal(action, '__prepare-agent')
        assert.equal(candidate, binding)
        return { agent_type: 'aime', acp_command: '/safe/bin/aime-acp --site cn' }
      },
    })
    assert.deepEqual([...groups.values()].map((group) => [...group.failures.entries()]), [[]])
    await module.cleanupAll()
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const hostHash = crypto.createHash('sha256').update(host).digest('hex').slice(0, 12)
  const agentHome = path.join(runtimeHome, 'agent-bridges', hostHash, 'agents', 'aime')
  assert.deepEqual(JSON.parse(readFileSync(captureFile, 'utf8')), {
    aampHost: host,
    agents: [{
      name: 'aime',
      acpCommand: '/safe/bin/aime-acp --site cn',
      credentialsFile: path.join(agentHome, 'credentials.json'),
      pairingFile: path.join(agentHome, 'pairing.json'),
      senderPoliciesFile: path.join(agentHome, 'sender-policies.json'),
      createPairing: false,
      executionLocation: 'remote',
      attachmentPolicy: 'reject',
      taskDispatchConcurrency: 1,
    }],
  })
  const initLog = readFileSync(path.join(root, 'logs', `acp-bridge-${hostHash}.jsonl`), 'utf8')
  for (const forbidden of [
    'resolver-api-key-sentinel',
    'acp-password-sentinel',
    'fakeAcp-not-a-secret',
  ]) {
    assert.equal(initLog.includes(forbidden), false, `remote ACP init log leaked ${forbidden}`)
  }
  assert.match(initLog, /\/Users\/resolver\/private/)
  assert.match(initLog, /\/Users\/acp\/private/)
  assert.deepEqual(readFileSync(legacyProfileFile), legacySentinel)
  assert.equal(statSync(legacyProfileFile).mode & 0o777, legacyMode)
})

test('Feishu startup argv branches by execution metadata without leaking app secrets', async () => {
  const module = await import(pathToFileURL(controller).href)
  const remoteBinding = {
    agent_type: 'aime',
    aamp_host: 'https://meshmail.ai',
    feishu_config_dir: '/safe/remote-feishu-config',
    bot: {
      app_id: 'cli_remote',
      app_secret: 'remote-app-secret-sentinel',
      display_name: 'Remote AIME',
    },
  }
  const localBinding = {
    ...remoteBinding,
    agent_type: 'codex',
    bot: {
      ...remoteBinding.bot,
      app_id: 'cli_local',
      lark_cli_profile: 'local-profile',
    },
  }
  const target = { agentTargetEmail: 'agent@meshmail.ai' }

  const remote = module.feishuArgs(remoteBinding, '/safe/bin/lark-cli', target)
  assert.deepEqual(remote, [
    'start', '--enable-task',
    '--config-dir', '/safe/remote-feishu-config',
    '--aamp-host', 'https://meshmail.ai',
    '--agent', 'aime',
    '--agent-execution-location', 'remote',
    '--target-agent', 'agent@meshmail.ai',
    '--app-id', 'cli_remote',
    '--bot-name', 'Remote AIME',
    '--json',
  ])
  assert.doesNotMatch(remote.join(' '), /--use-feishu-cli|--feishu-cli-profile|--feishu-cli-bin|remote-app-secret-sentinel/)

  const local = module.feishuArgs(localBinding, '/safe/bin/lark-cli', target)
  assert.deepEqual(local.slice(-10), [
    '--app-id', 'cli_local',
    '--bot-name', 'Remote AIME',
    '--use-feishu-cli',
    '--feishu-cli-profile', 'local-profile',
    '--feishu-cli-bin', '/safe/bin/lark-cli',
    '--json',
  ])
  assert.ok(local.includes('--agent-execution-location'))
  assert.equal(local[local.indexOf('--agent-execution-location') + 1], 'local')
})

test('remote managed startup sanitizes real child output and uses location-aware startup copy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-remote-output-'))
  const fakeNpm = path.join(root, 'npm')
  const fakeAcp = path.join(root, 'fixture-acp.mjs')
  const remoteLog = path.join(root, 'logs', 'remote.jsonl')
  const localLog = path.join(root, 'logs', 'local.jsonl')
  const mixedLog = path.join(root, 'logs', 'mixed.jsonl')
  const sentinels = {
    token: 'remote-token-sentinel',
    password: 'remote-password-sentinel',
    apiKey: 'remote-api-key-sentinel',
    unix: '/Users/remote/private-agent',
    tilde: '~/.aime/private-agent',
    windows: 'C:\\Users\\remote\\private-agent',
    unc: '\\\\remote-server\\private-share\\agent',
  }
  const failedEvent = {
    type: 'agent.failed',
    agent: 'aime',
    message: `acpx argv --cwd ${sentinels.unix} --agent /safe/bin/aime-acp token=${sentinels.token}`,
    password: sentinels.password,
    api_key: sentinels.apiKey,
    windowsPath: sentinels.windows,
    uncPath: sentinels.unc,
  }
  writeFileSync(fakeAcp, [
    '#!/usr/bin/env node',
    "const remote = process.argv.some((value) => value.includes('remote-private'))",
    'if (remote) {',
    `  console.log(${JSON.stringify(JSON.stringify(failedEvent))})`,
    `  console.log(${JSON.stringify(`acpx argv --cwd ${sentinels.tilde} --agent /safe/bin/aime-acp secret=${sentinels.token}`)})`,
    `  console.error(${JSON.stringify(`password=${sentinels.password} api-key=${sentinels.apiKey} ${sentinels.windows} ${sentinels.unc}`)})`,
    "  console.log(JSON.stringify({ type: 'bridge.running', agents: [] }))",
    '} else {',
    "  console.log('local-compatible output /tmp/local-compatible')",
    "  console.log(JSON.stringify({ type: 'bridge.running', agents: [{ name: 'aime' }, { name: 'codex' }] }))",
    '}',
    'setInterval(() => {}, 1_000)',
    '',
  ].join('\n'))
  chmodSync(fakeAcp, 0o755)
  writeExecutable(fakeNpm, [
    "printf '%s\\n' 'token=resolver-token-sentinel /Users/resolver/remote-private' >&2",
    'node -e \'process.stdout.write(JSON.stringify({ executable: "aamp-acp-bridge", kind: "direct", command: process.env.FAKE_ACP_BIN, pathValue: process.env.PATH, environment: {} }))\'',
  ].join('\n'))

  const envKeys = [
    'HOME', 'AAMP_TASK_STATE_HOME', 'AAMP_TASK_RUNTIME_HOME', 'AAMP_RUN_LOG_DIR',
    'AAMP_TASK_NPM_BIN', 'AAMP_TASK_NPM_CACHE_DIR', 'AAMP_TASK_NETWORK_MAX_ATTEMPTS',
    'FAKE_ACP_BIN',
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const originalConsoleLog = console.log
  const output = []
  let module
  const makeGroup = (name, agents, logFile) => ({
    host: `https://${name}.meshmail.ai`,
    configFile: path.join(root, `${name}.json`),
    logFile,
    bridgeEnv: { ...process.env, FAKE_ACP_BIN: fakeAcp },
    agents: agents.map((agent) => ({ name: agent })),
    runtimeAgentTypes: new Map(agents.map((agent) => [agent, agent])),
    availableAgents: new Set(),
    failures: new Map(),
    leases: new Map(),
    process: undefined,
  })
  try {
    Object.assign(process.env, {
      HOME: root,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: path.join(root, 'run-logs'),
      AAMP_TASK_NPM_BIN: fakeNpm,
      AAMP_TASK_NPM_CACHE_DIR: path.join(root, 'npm-cache'),
      AAMP_TASK_NETWORK_MAX_ATTEMPTS: '1',
      FAKE_ACP_BIN: fakeAcp,
    })
    module = await import(`${pathToFileURL(controller).href}?remote-output=${Date.now()}`)
    const remote = makeGroup('remote-private', ['aime'], remoteLog)
    const local = makeGroup('local-compatible', ['codex'], localLog)
    const mixed = makeGroup('mixed-compatible', ['aime', 'codex'], mixedLog)
    console.log = (...args) => { output.push(args.join(' ')) }
    await module.startAgentGroups(new Map([
      [remote.host, remote],
      [local.host, local],
      [mixed.host, mixed],
    ]))
    console.log = originalConsoleLog
    await until(() => remote.process?.events.some((event) => event.type === 'bridge.running'), 'remote bridge did not become ready')
    await module.cleanupAll()

    const surfaces = {
      log: readFileSync(remoteLog, 'utf8'),
      outputTail: remote.process.outputTail.join('\n'),
      events: JSON.stringify(remote.process.events),
      userError: remote.failures.get('aime') || '',
    }
    for (const [surfaceName, surface] of Object.entries(surfaces)) {
      for (const forbidden of [sentinels.token, sentinels.password, sentinels.apiKey, 'resolver-token-sentinel']) {
        assert.equal(surface.includes(forbidden), false, `${surfaceName} leaked ${forbidden}`)
      }
    }
    assert.match(surfaces.log, /\/Users\/remote\/private-agent/)
    assert.match(surfaces.log, /remote-private/)
    assert.deepEqual(
      remote.process.events.find((event) => event.type === 'bridge.running'),
      { type: 'bridge.running', agentCount: 0, agents: [] },
    )
    assert.match(readFileSync(localLog, 'utf8'), /local-compatible output \/tmp\/local-compatible/)
    assert.deepEqual(output, [
      '[aamp-one-click] 正在启动远程 Agent Bridge (aime)...',
      '[aamp-one-click] 正在启动本地 Agent Bridge (codex)...',
      '[aamp-one-click] 正在启动 Agent Bridge (aime, codex)...',
    ])
  } finally {
    console.log = originalConsoleLog
    if (typeof module?.cleanupAll === 'function') await module.cleanupAll()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('remote managed output is a strict event projection on every controller surface', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-remote-projection-'))
  const fakeBridge = path.join(root, 'remote-event-fixture.mjs')
  const logFile = path.join(root, 'logs', 'remote.jsonl')
  const bindingRoot = path.join(root, 'runtime', 'bindings', 'opaque-path-binding', 'feishu-bridge')
  const imConfigDir = path.join(bindingRoot, 'instances', 'im-secret-descendant-sentinel')
  const taskConfigDir = path.join(bindingRoot, 'instances', 'task-secret-descendant-sentinel')
  const binding = {
    agent_type: 'aime',
    feishu_config_dir: bindingRoot,
    bot: { app_id: 'cli_remote' },
  }
  const expectedAgentEmail = 'aime@example.com'
  const sentinels = [
    'authorization-bearer-sentinel',
    'credential-value-sentinel',
    'private-key-value-sentinel',
    'refresh-token-value-sentinel',
    'id-token-value-sentinel',
    'session-token-value-sentinel',
    'cookie-value-sentinel',
    'unknown-json-value-sentinel',
    'arbitrary-prose-value-sentinel',
    '/Users/projection/private-command',
    'C:\\Users\\projection\\private-command',
    'private-package-sentinel',
    'im-secret-descendant-sentinel',
    'task-secret-descendant-sentinel',
  ]
  mkdirSync(imConfigDir, { recursive: true })
  mkdirSync(taskConfigDir, { recursive: true })
  writeFileSync(path.join(imConfigDir, 'config.json'), JSON.stringify({
    targetAgentEmail: expectedAgentEmail,
    feishu: { appId: binding.bot.app_id },
    mailbox: { email: 'feishu-bridge@example.com' },
  }))
  writeFileSync(path.join(taskConfigDir, 'config.json'), JSON.stringify({
    targetAgentEmail: expectedAgentEmail,
    feishu: { appId: binding.bot.app_id },
  }))
  writeFileSync(fakeBridge, [
    "const emit = (value, stream = 'log') => console[stream](typeof value === 'string' ? value : JSON.stringify(value))",
    'setTimeout(() => {',
    `  emit(${JSON.stringify(`arbitrary-prose-value-sentinel Authorization: Bearer authorization-bearer-sentinel`)})`,
    `  emit({ type: 'unknown.remote.event', payload: 'unknown-json-value-sentinel', credential: 'credential-value-sentinel' })`,
    "  emit({ type: 'agent.starting', agent: 'aime', command: '/Users/projection/private-command', cookie: 'cookie-value-sentinel' })",
    "  emit({ type: 'agent.failed', agent: 'aime', message: 'AUTH_REQUIRED credential-value-sentinel', Authorization: 'Bearer authorization-bearer-sentinel', credential: 'credential-value-sentinel', private_key: 'private-key-value-sentinel', refresh_token: 'refresh-token-value-sentinel', id_token: 'id-token-value-sentinel', session_token: 'session-token-value-sentinel', cookie: 'cookie-value-sentinel', nested: { unknown: 'unknown-json-value-sentinel' }, durationMs: 7 })",
    `  emit({ type: 'bridge.task_runtime.starting', appId: 'cli_remote', imConfigDir: ${JSON.stringify(imConfigDir)}, taskConfigDir: ${JSON.stringify(taskConfigDir)}, command: '/Users/projection/private-command', unknown: 'unknown-json-value-sentinel' })`,
    "  emit({ type: 'bridge.task_runtime.running', pairs: [{ private_key: 'private-key-value-sentinel' }], instances: Number.MAX_SAFE_INTEGER })",
    "  emit({ type: 'bridge.running', agents: [{ name: 'aime', email: 'private@example.com', credential: 'credential-value-sentinel' }], agentCount: 1, unknown: 'unknown-json-value-sentinel' })",
    `  emit(${JSON.stringify('cookie=cookie-value-sentinel C:\\Users\\projection\\private-command')}, 'error')`,
    '}, 50)',
    'setInterval(() => {}, 1_000)',
    '',
  ].join('\n'))
  const envKeys = ['HOME', 'AAMP_TASK_STATE_HOME', 'AAMP_TASK_RUNTIME_HOME', 'AAMP_RUN_LOG_DIR']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  let module
  let record
  const emittedOutput = []
  const emittedEvents = []
  try {
    Object.assign(process.env, {
      HOME: root,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: path.join(root, 'run-logs'),
    })
    module = await import(`${pathToFileURL(controller).href}?strict-projection=${Date.now()}`)
    record = await module.startManagedProcess({
      label: 'Remote private label',
      packageSpec: 'private-package-sentinel',
      executable: 'remote-event-fixture',
      args: [fakeBridge],
      env: process.env,
      logFile,
      preparedExecutable: {
        executable: 'remote-event-fixture',
        kind: 'direct',
        command: process.execPath,
        pathValue: process.env.PATH,
        environment: {},
      },
      executionLocation: 'remote',
      eventPathRoot: bindingRoot,
      allowedAppIds: ['cli_remote'],
      agentExecutionLocations: new Map([['aime', 'remote']]),
    })
    record.emitter.on('output', (line) => emittedOutput.push(line))
    record.emitter.on('event', (event) => emittedEvents.push(event))
    await until(
      () => record.events.some((event) => event.type === 'bridge.running')
        && record.events.some((event) => event.type === 'bridge.task_runtime.starting'),
      'strict remote projection fixture did not become ready',
    )
    const failed = record.events.find((event) => event.type === 'agent.failed')
    assert.deepEqual(failed, {
      type: 'agent.failed',
      agent: 'aime',
      code: 'AUTH_REQUIRED',
      message: 'AUTH_REQUIRED credential-value-sentinel',
      durationMs: 7,
    })
    assert.deepEqual(
      record.events.find((event) => event.type === 'bridge.running'),
      { type: 'bridge.running', agentCount: 1, agents: [{ name: 'aime' }] },
    )
    const starting = record.events.find((event) => event.type === 'bridge.task_runtime.starting')
    assert.deepEqual(Object.keys(starting).sort(), ['appId', 'imConfigDir', 'taskConfigDir', 'type'])
    assert.equal(starting.appId, 'cli_remote')
    assert.match(starting.imConfigDir, /^aamp-runtime:/)
    assert.match(starting.taskConfigDir, /^aamp-runtime:/)
    for (const token of [starting.imConfigDir, starting.taskConfigDir]) {
      const decoded = Buffer.from(token.slice('aamp-runtime:'.length), 'base64url').toString('utf8')
      assert.equal(decoded.includes('secret-descendant-sentinel'), false)
    }
    assert.deepEqual(
      record.events.find((event) => event.type === 'bridge.task_runtime.running'),
      { type: 'bridge.task_runtime.running' },
    )
    assert.equal(record.events.some((event) => event.type === 'unknown.remote.event'), false)
    assert.deepEqual(emittedEvents, record.events)
  assert.ok(readFileSync(logFile, 'utf8').includes('arbitrary-prose-value-sentinel'))

    const surfaces = {
      log: readFileSync(logFile, 'utf8'),
      outputTail: record.outputTail.join('\n'),
      events: JSON.stringify(record.events),
      emittedOutput: emittedOutput.join('\n'),
      emittedEvents: JSON.stringify(emittedEvents),
    }
    for (const [surfaceName, surface] of Object.entries(surfaces)) {
      for (const forbidden of sentinels.filter((value) => value.includes('token') || value.includes('key') || value.includes('cookie'))) {
        assert.equal(surface.includes(forbidden), false, `${surfaceName} leaked ${forbidden}`)
      }
    }

    assert.deepEqual(
      await module.readInitialRuntimeMetadata(binding, record, expectedAgentEmail),
      {
        im_config_dir: imConfigDir,
        task_config_dir: taskConfigDir,
        feishu_bridge_email: 'feishu-bridge@example.com',
      },
    )
    const originalEvents = record.events
    const forged = `aamp-runtime:${Buffer.from(path.relative(bindingRoot, imConfigDir)).toString('base64url')}`
    record.events = originalEvents.map((event) => event.type === 'bridge.task_runtime.starting'
      ? { ...event, imConfigDir: forged, taskConfigDir: forged }
      : event)
    await assert.rejects(
      module.readInitialRuntimeMetadata(binding, record, expectedAgentEmail),
      /无效的安全路径/,
    )
    record.events = originalEvents
    await assert.rejects(
      module.readInitialRuntimeMetadata(binding, { events: originalEvents }, expectedAgentEmail),
      /无效的安全路径/,
    )
    await module.cleanupAll()
    await assert.rejects(
      module.readInitialRuntimeMetadata(binding, record, expectedAgentEmail),
      /无效的安全路径/,
    )
  } finally {
    if (typeof module?.cleanupAll === 'function') await module.cleanupAll()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('mixed ACP output preserves trusted local retry failures and projects remote failures', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-mixed-projection-'))
  const fakeBridge = path.join(root, 'mixed-event-fixture.mjs')
  const logFile = path.join(root, 'logs', 'mixed.jsonl')
  writeFileSync(fakeBridge, [
    "const emit = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value))",
    'setTimeout(() => {',
    "  emit('mixed-ambiguous-prose-sentinel Authorization: Bearer mixed-prose-secret')",
    "  emit({ type: 'agent.failed', bridge: 'acp-bridge', agent: 'codex', message: 'fetch failed | code=ECONNRESET', code: 'ECONNRESET', durationMs: 8 })",
    "  emit({ type: 'agent.failed', bridge: 'acp-bridge', agent: 'aime', message: 'AUTH_REQUIRED mixed-remote-secret', code: 'AUTH_REQUIRED', durationMs: 9 })",
    "  emit({ type: 'agent.failed', bridge: 'acp-bridge', agent: 'cursor', message: 'mixed-ambiguous-agent-secret', code: 'ECONNRESET' })",
    "  emit({ type: 'bridge.running', bridge: 'acp-bridge', agents: [{ name: 'codex', email: 'local@example.com' }, { name: 'aime', email: 'remote-private@example.com' }] })",
    '}, 25)',
    'setInterval(() => {}, 1_000)',
    '',
  ].join('\n'))
  const envKeys = ['HOME', 'AAMP_TASK_STATE_HOME', 'AAMP_TASK_RUNTIME_HOME', 'AAMP_RUN_LOG_DIR']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  let module
  let record
  try {
    Object.assign(process.env, {
      HOME: root,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: path.join(root, 'run-logs'),
    })
    module = await import(`${pathToFileURL(controller).href}?mixed-projection=${Date.now()}`)
    record = await module.startManagedProcess({
      label: 'Mixed Agent Bridge',
      packageSpec: 'mixed-private-package',
      executable: 'mixed-event-fixture',
      args: [fakeBridge],
      env: process.env,
      logFile,
      preparedExecutable: {
        executable: 'mixed-event-fixture',
        kind: 'direct',
        command: process.execPath,
        pathValue: process.env.PATH,
        environment: {},
      },
      executionLocation: 'remote',
      agentExecutionLocations: [
        ['codex', 'local'],
        ['aime', 'remote'],
        ['cursor', 'local'],
        ['cursor', 'remote'],
      ],
    })
    await until(
      () => record.events.some((event) => event.type === 'bridge.running'),
      'mixed projection fixture did not become ready',
    )

    const failed = record.events.filter((event) => event.type === 'agent.failed')
    assert.deepEqual(failed, [
      {
        type: 'agent.failed',
        bridge: 'acp-bridge',
        agent: 'codex',
        message: 'fetch failed | code=ECONNRESET',
        code: 'ECONNRESET',
        durationMs: 8,
      },
      {
        type: 'agent.failed',
        agent: 'aime',
        code: 'AUTH_REQUIRED',
        message: 'AUTH_REQUIRED mixed-remote-secret',
        durationMs: 9,
      },
    ])
    const { agentStartRetryError } = await import('../bin/runtime-network.mjs')
    assert.match(
      agentStartRetryError(record.events, ['codex', 'aime'], 1, 2)?.message || '',
      /ECONNRESET/,
    )
    const surfaces = [
      readFileSync(logFile, 'utf8'),
      record.outputTail.join('\n'),
      JSON.stringify(record.events),
    ].join('\n')
    assert.match(surfaces, /fetch failed \| code=ECONNRESET/)
    for (const forbidden of [
      'mixed-prose-secret',
      'remote-private@example.com',
    ]) {
      assert.equal(surfaces.includes(forbidden), false, `mixed projection leaked ${forbidden}`)
    }
  } finally {
    if (typeof module?.cleanupAll === 'function') await module.cleanupAll()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('remote binding failure projection protects user output, manifest, and errors log', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-remote-failure-surfaces-'))
  const runLogDir = path.join(root, 'logs')
  const errorsLog = path.join(runLogDir, 'errors.jsonl')
  const envKeys = [
    'HOME', 'AAMP_TASK_STATE_HOME', 'AAMP_TASK_RUNTIME_HOME', 'AAMP_RUN_LOG_DIR', 'ERRORS_LOG',
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const binding = {
    binding_id: '99999999-9999-4999-8999-999999999999',
    agent_type: 'aime',
    aamp_host: 'https://meshmail.ai',
    bot: { app_id: 'cli_remote_failure', display_name: 'Remote failure fixture' },
  }
  const malicious = 'Authorization: Bearer user-surface-bearer credential=user-surface-credential private_key=user-surface-key session=user-surface-session cookie=user-surface-cookie /Users/user-surface/private'
  let module
  try {
    Object.assign(process.env, {
      HOME: root,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: runLogDir,
      ERRORS_LOG: errorsLog,
    })
    module = await import(`${pathToFileURL(controller).href}?failure-surfaces=${Date.now()}`)
    const group = {
      runtimeAgentTypes: new Map([['aime', 'aime']]),
      failures: new Map(),
    }
    const reason = module.recordStableAgentFailure(group, 'aime', malicious)
    assert.equal(reason, 'Authorization: [REDACTED] credential=[REDACTED] private_key=[REDACTED] session=[REDACTED] cookie=[REDACTED] /Users/user-surface/private')
    const summary = module.startupSummaryLines({
      title: '启动',
      plannedCount: 1,
      failed: [{ binding, runtimeAgentType: 'aime', reason: malicious }],
    }).join('\n')
    assert.match(summary, /user-surface\/private/)
    assert.doesNotMatch(summary, /user-surface-bearer|user-surface-credential|user-surface-key|user-surface-cookie/)
    await module.setBindingStatus(binding, 'start', 'failed', malicious)
    await module.recordError('startup', malicious, binding)
    await module.writeManifest()
    const manifest = readFileSync(path.join(runLogDir, 'manifest.json'), 'utf8')
    const errors = readFileSync(errorsLog, 'utf8')
    for (const [surfaceName, surface] of Object.entries({ manifest, errors })) {
      assert.match(surface, /user-surface\/private/)
      assert.doesNotMatch(surface, /user-surface-bearer|user-surface-credential|user-surface-key|user-surface-cookie/, `${surfaceName} retained a credential sentinel`)
    }
  } finally {
    if (typeof module?.cleanupAll === 'function') await module.cleanupAll()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('remote bootstrap helper keeps FD3 and FD4 while relaying only opaque output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-remote-helper-fds-'))
  const helper = path.join(root, 'helper.sh')
  const payload = JSON.stringify({ binding: 'fd4-payload-sentinel' })
  writeExecutable(helper, [
    'IFS= read -r payload <&"$AAMP_TASK_INTERNAL_INPUT_FD" || true',
    'printf \'%s\\n\' \'helper-prose-sentinel Authorization: Bearer helper-bearer-sentinel\'',
    'printf \'%s\\n\' \'helper-stderr-sentinel private_key=helper-private-key-sentinel /Users/helper/private\' >&2',
    'PAYLOAD="$payload" node -e \'process.stdout.write(JSON.stringify({ received: process.env.PAYLOAD }))\' >&"$AAMP_TASK_INTERNAL_RESULT_FD"',
  ].join('\n'))
  const result = runControllerBootstrapHelper({
    root,
    helperBootstrap: helper,
    inputPayload: payload,
  })

  assert.equal(result.status, 0, result.stderr)
  const resultEvent = result.stdout.trim().split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) } catch { return undefined }
  }).find((event) => event?.type === 'helper.result')
  assert.deepEqual(resultEvent, { type: 'helper.result', result: { received: payload } })
  const surfaces = `${result.stdout}\n${result.stderr}\n${result.oneClickLog}\n${result.errorsLog}`
  assert.match(surfaces, /helper-prose-sentinel/)
  for (const forbidden of [
    'helper-bearer-sentinel', 'helper-private-key-sentinel',
  ]) {
    assert.equal(surfaces.includes(forbidden), false, `remote helper surface leaked ${forbidden}`)
  }
  assert.match(surfaces, /\/Users\/helper\/private/)
})

test('actual remote AIME helper install and missing-executable failures expose only fixed errors', () => {
  const scenarios = [
    {
      name: 'install-failure',
      prepare(root, prefix, binDir) {
        writeExecutable(path.join(binDir, 'npm'), [
          'case "${1:-}" in',
          '  --version) printf \'10.0.0\\n\'; exit 0 ;;',
          '  config) exit 0 ;;',
          '  install)',
          '    printf \'%s\\n\' \'Authorization: Bearer npm-bearer-sentinel credential=npm-credential-sentinel private_key=npm-private-key-sentinel /Users/npm/private\' >&2',
          '    exit 73',
          '    ;;',
          'esac',
          'exit 0',
        ].join('\n'))
      },
    },
    {
      name: 'missing-executable',
      prepare(root, prefix, binDir) {
        const packageDir = path.join(prefix, 'lib/node_modules/@private/aime-acp')
        const aimeCli = path.join(prefix, 'bin/aime-acp')
        mkdirSync(packageDir, { recursive: true })
        mkdirSync(path.dirname(aimeCli), { recursive: true })
        writeFileSync(path.join(packageDir, 'package.json'), '{"name":"@private/aime-acp","version":"9.9.9"}\n')
        writeExecutable(aimeCli, [
          'case "$*" in',
          '  "auth status --site cn --json") printf \'{"schemaVersion":1,"ok":true,"status":"authenticated"}\\n\' ;;',
          '  "doctor --site cn --json") rm -f "$0" ;;',
          'esac',
          'exit 0',
        ].join('\n'))
        writeExecutable(path.join(binDir, 'npm'), [
          'case "${1:-}" in --version) printf \'10.0.0\\n\';; esac',
          'exit 0',
        ].join('\n'))
      },
    },
  ]

  for (const scenario of scenarios) {
    const root = mkdtempSync(path.join(tmpdir(), `aamp-controller-aime-helper-${scenario.name}-`))
    const prefix = path.join(root, 'private-prefix-sentinel')
    const binDir = path.join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    installTaskAgentMetadata(prefix)
    writeExecutable(path.join(binDir, 'npx'), 'case "${1:-}" in --version) printf \'10.0.0\\n\';; esac\nexit 0')
    writeExecutable(path.join(binDir, 'ping'), 'exit 0')
    writeExecutable(path.join(binDir, 'acpx'), 'exit 0')
    scenario.prepare(root, prefix, binDir)
    const result = runControllerBootstrapHelper({
      root,
      helperBootstrap: bootstrap,
      env: {
        PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        NPM_GLOBAL_PREFIX: prefix,
        NPM_CONFIG_CACHE: path.join(root, 'private-cache-sentinel'),
        AIME_ACP_PKG: '@private/aime-acp@9.9.9',
        AIME_ACP_REGISTRY: 'https://registry-user:registry-pass@private.registry.invalid',
        AAMP_TASK_AGENT_NAME: '@larktask/aamp-feishu-task-agent',
        AAMP_TASK_AUTO_UPDATE: 'false',
      },
    })

    assert.equal(result.status, 1, `${scenario.name} unexpectedly succeeded`)
    assert.match(result.stderr, /AIME_(?:ACP_)?[A-Z_]+/)
    const surfaces = `${result.stdout}\n${result.stderr}\n${result.oneClickLog}\n${result.errorsLog}`
    for (const forbidden of [
      'npm-bearer-sentinel', 'npm-credential-sentinel', 'npm-private-key-sentinel',
      '/Users/npm/private', 'private-prefix-sentinel', 'private-cache-sentinel',
      'registry-user', 'registry-pass', 'private.registry.invalid', '@private/aime-acp@9.9.9',
    ]) {
      assert.equal(surfaces.includes(forbidden), false, `${scenario.name} leaked ${forbidden}`)
    }
  }
})

test('production cleanup stops the complete remote AIME helper process group', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group semantics')
    return
  }
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-aime-helper-cleanup-'))
  const prefix = path.join(root, 'npm-global')
  const binDir = path.join(root, 'bin')
  const cacheDir = path.join(root, 'npm-cache')
  const runLogDir = path.join(root, 'run-logs')
  const startedFile = path.join(root, 'npm-started')
  const npmPidFile = path.join(root, 'npm.pid')
  const prefixMutation = path.join(prefix, 'continued-mutation')
  const cacheMutation = path.join(cacheDir, 'continued-mutation')
  const npmWorker = path.join(root, 'npm-worker.mjs')
  const runner = path.join(root, 'controller-cleanup-runner.mjs')
  const oneClickLog = path.join(runLogDir, 'one-click.log')
  const errorsLog = path.join(runLogDir, 'errors.jsonl')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(runLogDir, { recursive: true })
  writeFileSync(oneClickLog, '')
  writeFileSync(errorsLog, '')
  installTaskAgentMetadata(prefix)
  writeFileSync(npmWorker, [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
    "import path from 'node:path'",
    'const [pidFile, startedFile, prefixMutation, cacheMutation] = process.argv.slice(2)',
    'mkdirSync(path.dirname(prefixMutation), { recursive: true })',
    'mkdirSync(path.dirname(cacheMutation), { recursive: true })',
    "writeFileSync(pidFile, String(process.pid))",
    "process.stderr.write('Authorization: Bearer cleanup-npm-raw-secret private_key=cleanup-private-key\\n')",
    "appendFileSync(prefixMutation, 'x')",
    "appendFileSync(cacheMutation, 'x')",
    "writeFileSync(startedFile, 'started')",
    "process.on('SIGTERM', () => {})",
    'const mutation = setInterval(() => {',
    "  appendFileSync(prefixMutation, 'x')",
    "  appendFileSync(cacheMutation, 'x')",
    '}, 20)',
    'setTimeout(() => { clearInterval(mutation); process.exit(73) }, 10_000)',
    '',
  ].join('\n'))
  writeExecutable(path.join(binDir, 'npm'), [
    'case "${1:-}" in',
    '  --version) printf \'10.0.0\\n\'; exit 0 ;;',
    '  config) exit 0 ;;',
    '  install) exec "$TEST_NODE" "$NPM_WORKER" "$NPM_PID_FILE" "$NPM_STARTED" "$PREFIX_MUTATION" "$CACHE_MUTATION" ;;',
    'esac',
    'exit 0',
  ].join('\n'))
  writeExecutable(path.join(binDir, 'npx'), 'case "${1:-}" in --version) printf \'10.0.0\\n\';; esac\nexit 0')
  writeExecutable(path.join(binDir, 'ping'), 'exit 0')
  writeExecutable(path.join(binDir, 'acpx'), 'exit 0')
  writeFileSync(runner, [
    "import { existsSync, readFileSync, statSync } from 'node:fs'",
    `const controller = await import(${JSON.stringify(`${pathToFileURL(controller).href}?production-cleanup=${crypto.randomUUID()}`)})`,
    'const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }',
    'const waitFor = async (predicate, timeoutMs = 5_000) => {',
    '  const deadline = Date.now() + timeoutMs',
    '  while (!predicate()) { if (Date.now() >= deadline) throw new Error(\'fixture timed out\'); await delay(20) }',
    '}',
    `const helper = controller.runBootstrapHelper('__prepare-agent', ${JSON.stringify({ agent_type: 'aime', aamp_host: 'https://meshmail.ai' })}, ${JSON.stringify({ AAMP_TASK_INTERNAL_BINDING_JSON: '{"fd4":"cleanup-payload"}' })})`,
    "  .then((value) => ({ state: 'resolved', value }), (error) => ({ state: 'rejected', message: error?.message || String(error) }))",
    `await waitFor(() => existsSync(${JSON.stringify(startedFile)}))`,
    `const npmPid = Number(readFileSync(${JSON.stringify(npmPidFile)}, 'utf8'))`,
    'const cleanupStarted = Date.now()',
    'await controller.cleanupAll()',
    'const cleanupMs = Date.now() - cleanupStarted',
    "const helperOutcome = await Promise.race([helper, delay(3_000).then(() => ({ state: 'timeout' }))])",
    `const prefixAtCleanup = statSync(${JSON.stringify(prefixMutation)}).size`,
    `const cacheAtCleanup = statSync(${JSON.stringify(cacheMutation)}).size`,
    'await delay(300)',
    `const prefixAfter = statSync(${JSON.stringify(prefixMutation)}).size`,
    `const cacheAfter = statSync(${JSON.stringify(cacheMutation)}).size`,
    'const npmAliveAfterCleanup = alive(npmPid)',
    'const naturalExitDeadline = Date.now() + 12_000',
    'while (alive(npmPid) && Date.now() < naturalExitDeadline) await delay(20)',
    'console.log(JSON.stringify({ type: \'cleanup.result\', npmPid, cleanupMs, helperOutcome, npmAliveAfterCleanup, prefixAtCleanup, prefixAfter, cacheAtCleanup, cacheAfter }))',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    timeout: 25_000,
    env: isolatedBootstrapEnv({
      HOME: root,
      AAMP_TASK_BOOTSTRAP_PATH: bootstrap,
      AAMP_TASK_STATE_HOME: path.join(root, 'state'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
      AAMP_RUN_LOG_DIR: runLogDir,
      AAMP_RUN_ID: 'remote-helper-cleanup-test',
      ONE_CLICK_LOG: oneClickLog,
      ERRORS_LOG: errorsLog,
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TEST_NODE: process.execPath,
      NPM_WORKER: npmWorker,
      NPM_PID_FILE: npmPidFile,
      NPM_STARTED: startedFile,
      PREFIX_MUTATION: prefixMutation,
      CACHE_MUTATION: cacheMutation,
      NPM_GLOBAL_PREFIX: prefix,
      NPM_CONFIG_CACHE: cacheDir,
      AIME_ACP_PKG: '@tengchengwei/aime-acp@9.9.9',
      AIME_ACP_REGISTRY: 'https://private.registry.invalid',
      AAMP_TASK_AGENT_NAME: '@larktask/aamp-feishu-task-agent',
      AAMP_TASK_AUTO_UPDATE: 'false',
    }),
  })
  assert.equal(result.status, 0, result.stderr)
  const cleanupResult = result.stdout.trim().split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  }).find((event) => event.type === 'cleanup.result')
  assert.ok(cleanupResult, result.stdout)
  assert.notEqual(cleanupResult.npmPid, 65177)
  assert.equal(cleanupResult.helperOutcome.state, 'rejected')
  assert.doesNotMatch(cleanupResult.helperOutcome.message, /REMOTE_AGENT_PREPARATION_FAILED|redacted diagnostics/)
  assert.equal(cleanupResult.npmAliveAfterCleanup, false)
  assert.equal(cleanupResult.prefixAfter, cleanupResult.prefixAtCleanup)
  assert.equal(cleanupResult.cacheAfter, cleanupResult.cacheAtCleanup)
  assert.ok(cleanupResult.cleanupMs < 8_000, `cleanup took ${cleanupResult.cleanupMs}ms`)
  const surfaces = [result.stdout, result.stderr, readFileSync(oneClickLog, 'utf8'), readFileSync(errorsLog, 'utf8')].join('\n')
  for (const forbidden of ['cleanup-npm-raw-secret', 'cleanup-private-key']) {
    assert.equal(surfaces.includes(forbidden), false, `production cleanup leaked ${forbidden}`)
  }
})

test('remote AIME npm classification stays bounded for noisy output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-aime-helper-noisy-'))
  const prefix = path.join(root, 'npm-global')
  const binDir = path.join(root, 'bin')
  const npmCallLog = path.join(root, 'npm-calls.log')
  mkdirSync(binDir, { recursive: true })
  installTaskAgentMetadata(prefix)
  writeExecutable(path.join(binDir, 'npm'), [
    'case "${1:-}" in',
    '  --version) printf \'10.0.0\\n\'; exit 0 ;;',
    '  config) exit 0 ;;',
    '  install)',
    '    call_count=0',
    '    [ ! -f "$NPM_CALL_LOG" ] || call_count="$(wc -l < "$NPM_CALL_LOG")"',
    '    printf \'install\\n\' >> "$NPM_CALL_LOG"',
    '    if [ "$call_count" -eq 0 ]; then',
    '      "$TEST_NODE" -e \'const fs=require("fs"); const chunk=Buffer.from("noisy-output-secret".repeat(64)); for(let i=0;i<16384;i++) fs.writeSync(2,chunk)\'',
    '      printf \'TAR_BAD_ARCHIVE\\n\' >&2',
    '      exit 73',
    '    fi',
    '    printf \'second-attempt-secret\\n\' >&2',
    '    exit 74',
    '    ;;',
    'esac',
    'exit 0',
  ].join('\n'))
  writeExecutable(path.join(binDir, 'npx'), 'case "${1:-}" in --version) printf \'10.0.0\\n\';; esac\nexit 0')
  writeExecutable(path.join(binDir, 'ping'), 'exit 0')
  writeExecutable(path.join(binDir, 'acpx'), 'exit 0')
  const result = runControllerBootstrapHelper({
    root,
    helperBootstrap: bootstrap,
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TEST_NODE: process.execPath,
      NPM_CALL_LOG: npmCallLog,
      NPM_GLOBAL_PREFIX: prefix,
      NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
      AIME_ACP_PKG: '@tengchengwei/aime-acp@9.9.9',
      AIME_ACP_REGISTRY: 'https://private.registry.invalid',
      AAMP_TASK_AGENT_NAME: '@larktask/aamp-feishu-task-agent',
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })
  assert.equal(result.status, 1, 'noisy npm install unexpectedly succeeded')
  assert.match(result.stderr, /AIME_(?:ACP_)?[A-Z_]+/)
  const surfaces = `${result.stdout}\n${result.stderr}\n${result.oneClickLog}\n${result.errorsLog}`
  assert.equal(surfaces.includes('noisy-output-secret'), false)
  assert.equal(surfaces.includes('second-attempt-secret'), false)
  assert.equal(readFileSync(npmCallLog, 'utf8'), 'install\ninstall\n')

  const source = readFileSync(bootstrap, 'utf8')
  const remoteInstallPath = source.slice(
    source.indexOf('classify_remote_npm_cache_error()'),
    source.indexOf('\nnpm_install_global_from_registry()', source.indexOf('classify_remote_npm_cache_error()')),
  )
  assert.doesNotMatch(remoteInstallPath, /npm_output\s*=|mktemp/)
  assert.match(remoteInstallPath, /PIPESTATUS/)
})
