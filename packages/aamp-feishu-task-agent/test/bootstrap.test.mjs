import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(__dirname, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))

test('bootstrap embedded version matches the published package version', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const match = source.match(/^AAMP_TASK_AGENT_VERSION="([^"]+)"$/m)

  assert.ok(match, 'bootstrap must declare AAMP_TASK_AGENT_VERSION')
  assert.equal(match[1], packageJson.version)
})

test('bootstrap script has valid bash syntax', () => {
  execFileSync('bash', ['-n', bootstrap])
})

test('bootstrap --help remains side-effect light and prints usage', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-help-'))

  const output = execFileSync('bash', [bootstrap, '--help'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

  assert.match(output, /Usage:/)
  assert.match(output, /feishu-task-agent/)
})

test('bootstrap accepts the legacy normal token passed by an older auto-updater', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-legacy-update-'))
  const result = spawnSync('bash', [bootstrap, 'normal', '--help'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:/)
})

test('bootstrap does not detect Grok agent as Cursor', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('is_cursor_agent_cli()')
  const end = source.indexOf('\nresolve_cursor_cli_for_acp()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-grok-agent-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'agent'), `#!/usr/bin/env bash
printf 'grok 0.2.101 (5bc4b5dfadcf) [stable]\\n'
`)
  chmodSync(path.join(binDir, 'agent'), 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
CURSOR_LOCAL_BIN="$1/missing-cursor-bin"
${helpers}
find_cursor_agent_cli
`, 'bash', home], { encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
})

test('bootstrap prefers cursor-agent over a generic agent command', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('is_cursor_agent_cli()')
  const end = source.indexOf('\nresolve_cursor_cli_for_acp()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-cursor-agent-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'agent'), `#!/usr/bin/env bash
printf 'grok 0.2.101 (5bc4b5dfadcf) [stable]\\n'
`)
  writeFileSync(path.join(binDir, 'cursor-agent'), `#!/usr/bin/env bash
printf '2026.07.01-41b2de7\\n'
`)
  chmodSync(path.join(binDir, 'agent'), 0o755)
  chmodSync(path.join(binDir, 'cursor-agent'), 0o755)

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
CURSOR_LOCAL_BIN="$1/missing-cursor-bin"
${helpers}
find_cursor_agent_cli
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(output.trim(), path.join(binDir, 'cursor-agent'))
})

test('bootstrap help owns log commands and success output stays concise', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const controller = readFileSync(path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs'), 'utf8')
  const usageStart = source.indexOf('usage()')
  const usageEnd = source.indexOf('\nwrite_one_click_log()', usageStart)
  const usage = source.slice(usageStart, usageEnd)
  const successStart = source.indexOf('agent_success()')
  const successEnd = source.indexOf('\nagent_fail()', successStart)
  const success = source.slice(successStart, successEnd)

  assert.match(source, /--mock-fail-stage/)
  assert.match(source, /AAMP_ONE_CLICK_MOCK_FAIL_STAGE/)
  assert.match(source, /print_local_log_hints/)
  assert.match(usage, /日志命令/)
  assert.match(usage, /aamp-logs list-runs/)
  assert.match(usage, /aamp-logs collect --run-dir/)
  assert.match(usage, /aamp-logs collect --task-id xxx/)
  assert.match(usage, /aamp-logs collect --task-guid yyy/)
  assert.match(success, /🟢 保持终端打开，你可以给 agent 派发飞书任务/)
  assert.doesNotMatch(success, /print_local_log_hints/)
  assert.match(controller, /🟢 保持终端打开，你可以给 agent 派发飞书任务/)
  assert.match(controller, /\[aamp-one-click\] 启动成功：\$\{bindingLabel\(binding\)\}/)
  assert.equal(controller.match(/printBindingStarted\(/g)?.length, 3)
  assert.doesNotMatch(controller, /已接入飞书任务，可以开始对话 & 派发任务/)
  assert.doesNotMatch(controller, /飞书 Bot：/)
  assert.doesNotMatch(controller, /保持此终端打开；按 Ctrl\+C 停止本次启动的本地连接。/)
  assert.equal(controller.match(/printLogHints\(true\)/g)?.length, 1)
  assert.doesNotMatch(source, /近期日志打包/)
  assert.match(source, /aamp-logs/)
  assert.match(source, /errors\.jsonl/)
  assert.match(source, /已接入飞书任务，可以开始对话 & 派发任务/)
  assert.match(source, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(source, /AAMP_ONE_CLICK_VERBOSE/)
})

test('bootstrap failure UX prints friendly log hints', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('write_one_click_log()')
  const end = source.indexOf('\nwrite_run_manifest()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-failure-'))
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AAMP_RUN_LOG_DIR="$1/run"
AAMP_LOGS_BIN="$1/bin/aamp-logs"
ONE_CLICK_LOG="$1/one-click.log"
ERRORS_LOG="$1/errors.jsonl"
mkdir -p "$AAMP_RUN_LOG_DIR" "$(dirname "$AAMP_LOGS_BIN")"
${helpers}
agent_fail "测试失败"
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  const stderr = result.stderr
  assert.match(stderr, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(stderr, /原因：测试失败/)
  assert.match(stderr, /运行日志目录：/)
  assert.match(stderr, /运行日志打包：.* collect --run-dir .*\/run/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-id xxx/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-guid yyy/)
})

test('bootstrap mock failure stages use friendly failure UX', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('write_one_click_log()')
  const end = source.indexOf('\nwrite_run_manifest()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-mock-failure-'))
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AAMP_RUN_LOG_DIR="$1/run"
AAMP_LOGS_BIN="$1/bin/aamp-logs"
AAMP_ONE_CLICK_MOCK_FAIL_STAGE="agent-login"
ONE_CLICK_LOG="$1/one-click.log"
ERRORS_LOG="$1/errors.jsonl"
mkdir -p "$AAMP_RUN_LOG_DIR" "$(dirname "$AAMP_LOGS_BIN")"
${helpers}
validate_mock_fail_stage
maybe_mock_fail "node-toolchain"
maybe_mock_fail "agent-login"
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  const stderr = result.stderr
  assert.match(stderr, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(stderr, /原因：模拟启动失败：agent-login/)
  assert.match(stderr, /运行日志打包：.* collect --run-dir .*\/run/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-id xxx/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-guid yyy/)

  const mockStageList = source.match(/node-toolchain\|agent-login\|feishu-bot\|agent-bridge\|feishu-bridge/)?.[0] ?? ''
  assert.equal(mockStageList.split('|').length, 5)
})

test('bootstrap accepts lark-cli user auth token that needs refresh', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('lark_cli_user_auth_satisfied()')
  const end = source.indexOf('\nnormalize_lark_cli_auth_excludes()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-auth-status-'))
  const binDir = path.join(home, 'bin')
  const statusFile = path.join(home, 'auth-status.json')
  execFileSync('mkdir', ['-p', binDir])
  writeFileSync(path.join(binDir, 'lark-cli'), `#!/usr/bin/env bash
if [ "$1" = "--profile" ] && [ "$3" = "auth" ] && [ "$4" = "status" ]; then
  cat "$LARK_STATUS_FILE"
  exit 0
fi
exit 1
`)
  chmodSync(path.join(binDir, 'lark-cli'), 0o755)
  writeFileSync(statusFile, JSON.stringify({
    identities: {
      user: {
        available: true,
        tokenStatus: 'needs_refresh',
        scope: 'im:message task:task',
      },
    },
  }))

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:$PATH"
export LARK_STATUS_FILE="$2"
FEISHU_USER_AUTH_REQUIRED_SCOPES="im:message task:task"
FEISHU_USER_AUTH_EXCLUDES=""
agent_log() { printf '%s\\n' "$*"; }
${helpers}
lark_cli_user_auth_satisfied test-profile
printf 'ok\\n'
`, 'bash', home, statusFile], { encoding: 'utf8' })

  assert.equal(output, 'ok\n')
})

test('bootstrap manifest includes full app and bridge identity', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.match(source, /"app_id":/)
  assert.match(source, /"bot_name":/)
  assert.match(source, /"feishu_bridge_name": "aamp-feishu-bridge"/)
  assert.match(source, /"feishu_bridge_email":/)
  assert.match(source, /"agent_bridge_type":/)
  assert.match(source, /"agent_bridge_name":/)
  assert.match(source, /"agent_bridge_email":/)
  assert.doesNotMatch(source, /"app_id_prefix":/)
  assert.doesNotMatch(source, /"feishu_bridge_package":/)
  assert.doesNotMatch(source, /"feishu_bridge_log":/)
  assert.doesNotMatch(source, /"agent_bridge_package":/)
  assert.doesNotMatch(source, /"agent_bridge_log":/)
})

test('bootstrap extracts bridge emails', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('extract_email_from_pairing_url()')
  const end = source.indexOf('\ninit_log_run()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-mail-id-'))
  const feishuLog = path.join(home, 'feishu-bridge.jsonl')
  writeFileSync(feishuLog, `${JSON.stringify({
    message: '[bridge] starting target=agent@meshmail.ai mailbox=feishu@meshmail.ai events=task',
  })}\n`)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
${helpers}
extract_email_from_pairing_url 'aamp://connect?mailbox=agent%40meshmail.ai&pair_code=abc'
printf '\\n'
printf '%s' '{"agents":[{"email":"acp@meshmail.ai","pairing":{"mailbox":"acp-pairing@meshmail.ai"}}]}' | extract_agent_email_from_acp_init_output
printf '\\n'
extract_feishu_email_from_log "$1"
printf '\\n'
`, 'bash', feishuLog], { encoding: 'utf8' })

  assert.deepEqual(output.trim().split('\n'), [
    'agent@meshmail.ai',
    'acp@meshmail.ai',
    'feishu@meshmail.ai',
  ])
})

test('bootstrap summarizes long lark-cli auth scopes output', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('auth_scope_tokens=()')
  const end = source.indexOf('\nrun_lark_cli_auth_login_with_browser_open()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
${helpers}
while IFS= read -r line; do
  print_lark_cli_auth_output_line "$line"
done <<'EOF'
OK: 授权成功! 用户: foo
  本次请求 scopes:
    im:message im:message:readonly task:task task:comment
next line
EOF
flush_lark_cli_auth_scopes
`], { encoding: 'utf8' })

  assert.equal(output, [
    'OK: 授权成功! 用户: foo',
    '  本次请求 scopes: im:message, im:message:readonly 等共计 4 个权限。',
    'next line',
    '',
  ].join('\n'))
})


test('bootstrap installs short command and auto-updates at startup', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('AAMP_TASK_START_MODE="start"'))
  assert.ok(source.includes('AAMP_TASK_ACTION="start"'))
  assert.ok(source.includes('AAMP_TASK_COMMAND_NAME="${AAMP_TASK_COMMAND_NAME:-feishu-task-agent}"'))
  assert.ok(source.includes('AAMP_TASK_COMMAND_PATH="${AAMP_TASK_COMMAND_PATH:-$AAMP_BIN_DIR/$AAMP_TASK_COMMAND_NAME}"'))
  assert.ok(source.includes('AAMP_TASK_SHIM_DIR="${AAMP_TASK_SHIM_DIR:-$HOME/.local/bin}"'))
  assert.ok(source.includes('AAMP_TASK_UPDATE_CACHE_FILE="${AAMP_TASK_UPDATE_CACHE_FILE:-$HOME/.aamp/feishu-task-agent/update-cache.json}"'))
  assert.ok(source.includes('AAMP_TASK_UPDATE_CACHE_TTL_SECONDS="${AAMP_TASK_UPDATE_CACHE_TTL_SECONDS:-86400}"'))
  assert.ok(source.includes('record_version_line()'))
  assert.ok(source.includes('record_install_success()'))
  assert.ok(source.includes('当前版本：$AAMP_TASK_AGENT_VERSION'))
  const versionStart = source.indexOf('record_version_line()')
  const versionEnd = source.indexOf('\nprint_local_log_hints()', versionStart)
  const versionHelper = source.slice(versionStart, versionEnd)
  assert.ok(versionHelper.includes('printf '))
  assert.ok(source.includes('[aamp-one-click] start with: '))
  const installStart = source.indexOf('record_install_success()')
  const installEnd = source.indexOf('\nensure_selected_agent_for_start()', installStart)
  const installHelper = source.slice(installStart, installEnd)
  assert.ok(!installHelper.includes('printf '))
  assert.ok(source.includes('script_file_task_agent_version()'))
  assert.ok(source.includes('short_command_is_current()'))
  assert.ok(source.includes('write_task_update_cache()'))
  assert.ok(source.includes('task_update_cache_is_fresh()'))
  assert.ok(source.includes('install_short_command_from_version()'))
  assert.ok(source.includes('install_short_command_shim()'))
  assert.ok(source.includes('install_short_command_current()'))
  assert.ok(source.includes('local source_file="${BASH_SOURCE[0]:-}"'))
  assert.ok(source.includes('""|/dev/fd/*|/private/dev/fd/*|/proc/*'))
  assert.ok(source.includes('ensure_task_agent_global_install "$version"'))
  assert.ok(source.includes('source_file="$package_dir/bootstrap/aamp-feishu-task-agent-bootstrap.sh"'))
  assert.ok(source.includes('cat >"$tmp" <<EOF'))
  assert.ok(source.includes('exec "$target" "\\$@"'))
  assert.ok(source.includes('cmp -s "$tmp" "$shim"'))
  assert.ok(source.includes('resolve_latest_task_agent_version()'))
  assert.ok(source.includes('"$NPM_BIN" view "$AAMP_TASK_AGENT_NAME@$AAMP_TASK_AGENT_CHANNEL" version'))
  assert.ok(source.includes('auto_update_short_command_if_needed normal'))
  assert.ok(source.includes('auto_update_short_command_if_needed force'))
  assert.ok(source.includes('if [ "$mode" != "force" ] && task_update_cache_is_fresh; then'))
  assert.ok(source.includes('if [ "${1:-}" = "update" ]; then'))
  assert.ok(source.includes('run_task_agent_update_command()'))
  assert.ok(source.includes('if [ "$AAMP_TASK_ACTION" = "update" ]; then'))
  assert.ok(source.includes('if [ "$AAMP_TASK_START_MODE" = "start" ]; then'))
  assert.ok(source.includes('ORIGINAL_ARGS=("$@")'))
  assert.ok(source.includes('AAMP_TASK_AUTO_UPDATE_DONE=true exec "$AAMP_TASK_COMMAND_PATH" "${ORIGINAL_ARGS[@]}"'))
  assert.ok(source.includes('if [ "$AAMP_TASK_START_MODE" != "start" ]; then'))
  assert.ok(source.includes('write_task_update_cache "$AAMP_TASK_AGENT_VERSION"'))
  assert.ok(source.includes('return 0'))
  assert.ok(source.includes('ensure_selected_agent_for_start'))
  assert.ok(source.includes('invoked_name="$(basename "${0:-}")"'))
  assert.ok(source.includes('AAMP_TASK_START_MODE="start"'))

  assert.ok(source.indexOf('install_short_command || agent_fail') < source.indexOf('auto_update_short_command_if_needed normal'))
  assert.ok(source.indexOf('auto_update_short_command_if_needed normal') < source.indexOf('  record_version_line\n'))
  assert.ok(source.indexOf('  record_version_line\n') < source.indexOf('  if [ "$AAMP_TASK_START_MODE" != "start" ]; then'))
  assert.ok(source.indexOf('ensure_selected_agent_for_start') < source.indexOf('build_feishu_env_args'))
})

test('bootstrap keeps the npm-global task-agent package and aamp-logs on the launcher version', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('TASK_AGENT_UPDATE_LOCK_DIR='))
  assert.ok(source.includes('task_agent_global_package_version()'))
  assert.ok(source.includes('task_agent_global_install_is_current()'))
  assert.ok(source.includes('ensure_task_agent_global_install()'))
  assert.ok(source.includes('with_task_agent_update_lock()'))
  assert.ok(source.includes('npm_install_global "$AAMP_TASK_AGENT_NAME@$expected_version"'))
  assert.ok(source.includes('install_aamp_logs_bin "$AAMP_TASK_AGENT_VERSION"'))
  assert.ok(source.includes('install_aamp_logs_bin "$installed_version"'))
  assert.ok(source.includes('ln -s "$NPM_GLOBAL_PREFIX/bin/aamp-logs" "$tmp"'))
  assert.ok(source.indexOf('ensure_task_agent_global_install "$latest"') < source.indexOf('install_short_command_from_version "$latest"'))
})

test('bootstrap exposes aamp-logs through the user PATH shim directory', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('install_aamp_logs_shim()'))
  assert.ok(source.includes('install_command_shim "$AAMP_LOGS_BIN" "aamp-logs"'))
  assert.ok(source.indexOf('install_aamp_logs_bin()') < source.indexOf('install_aamp_logs_shim()'))
})

test('explicit update restarts into the newly installed launcher before running migrations', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const updateStart = source.indexOf('auto_update_short_command_if_needed()')
  const updateEnd = source.indexOf('\nadopt_newer_global_task_agent_if_available()', updateStart)
  const updateHelper = source.slice(updateStart, updateEnd)

  assert.ok(updateHelper.includes('[ "$AAMP_TASK_START_MODE" = "start" ] || [ "$AAMP_TASK_ACTION" = "update" ]'))
  assert.ok(updateHelper.includes('AAMP_TASK_AUTO_UPDATE_DONE=true exec "$AAMP_TASK_COMMAND_PATH" "${ORIGINAL_ARGS[@]}"'))
})

test('bootstrap validates the npm-global package version before reusing its binaries', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('task_agent_global_package_dir()')
  const end = source.indexOf('\nshort_command_is_current()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-task-agent-global-'))
  const prefix = path.join(home, 'npm-global')
  const packageDir = path.join(prefix, 'lib/node_modules/@zengxingyuan/aamp-feishu-task-agent')
  mkdirSync(path.join(packageDir, 'bootstrap'), { recursive: true })
  mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '9.8.7' }))
  writeFileSync(path.join(packageDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), '#!/usr/bin/env bash\n')
  writeFileSync(path.join(prefix, 'bin/aamp-logs'), '#!/usr/bin/env node\n')
  chmodSync(path.join(prefix, 'bin/aamp-logs'), 0o755)

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
NPM_GLOBAL_PREFIX="$1"
AAMP_TASK_AGENT_NAME="@zengxingyuan/aamp-feishu-task-agent"
ONE_CLICK_LOG="$2"
${helpers}
task_agent_global_package_version
task_agent_global_install_is_current "9.8.7"
if task_agent_global_install_is_current "9.8.6"; then
  exit 1
fi
`, 'bash', prefix, path.join(home, 'one-click.log')], { encoding: 'utf8' })

  assert.equal(output, '9.8.7')
})

test('bootstrap pins lark-cli to one absolute binary and serializes writes', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.match(source, /AAMP_LARK_CLI_BIN=/)
  assert.match(source, /select_lark_cli_bin\(\)/)
  assert.match(source, /lark_cli_candidate_paths\(\)/)
  assert.match(source, /LARK_CLI_INSTALL_LOCK_DIR/)
  assert.match(source, /LARK_CLI_CONFIG_LOCK_DIR/)
  assert.match(source, /with_lark_cli_install_lock/)
  assert.match(source, /with_lark_cli_config_lock/)
  assert.match(source, /export AAMP_LARK_CLI_BIN/)
  assert.match(source, /export AAMP_LARK_CLI_BIN=\"\$LARK_CLI_CMD\"/)
  assert.match(source, /\"\$LARK_CLI_CMD\" --profile \"\$profile\" auth status/)
  assert.match(source, /run_lark_cli_auth_login_with_browser_open \"\$LARK_CLI_CMD\"/)
  assert.match(source, /\"\$LARK_CLI_CMD\" profile list/)
  assert.match(source, /\| \"\$LARK_CLI_CMD\" profile add/)
})

test('bootstrap asks before a newer Codex update and stops when update fails', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('ensure_codex_cli_updated()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const prepareStart = source.indexOf('run_internal_prepare_agent()')
  const prepareEnd = source.indexOf('\nrun_internal_ensure_profile()', prepareStart)
  const prepare = source.slice(prepareStart, prepareEnd)

  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  assert.ok(source.includes('CODEX_UPDATE_LOCK_DIR='))
  assert.ok(helper.includes('resolve_codex_cli_for_acp'))
  assert.ok(helper.includes('resolve_latest_codex_cli_version'))
  assert.ok(helper.includes('codex_cli_update_available'))
  assert.ok(helper.includes('当前 Codex CLI 版本是：'))
  assert.ok(helper.includes('最新版本是：'))
  assert.ok(helper.includes('confirm_codex_cli_update'))
  assert.ok(helper.includes('不升级可能导致后续任务执行失败，本次启动前需升级 Codex CLI。'))
  assert.ok(source.includes('是否现在升级？[y/n]'))
  assert.ok(helper.includes('agent_log "正在更新 Codex CLI..."'))
  assert.ok(source.includes('"$codex_bin" update >>"$ONE_CLICK_LOG" 2>&1'))
  assert.ok(helper.includes('run_codex_cli_update "$codex_bin"'))
  assert.ok(helper.includes('Codex CLI 升级失败'))
  assert.ok(helper.includes('agent_fail'))
  assert.ok(prepare.indexOf('prepare_internal_agent_environment') < prepare.indexOf('ensure_codex_cli_updated'))
  assert.ok(prepare.indexOf('ensure_codex_cli_updated') < prepare.indexOf('ensure_agent_login'))
})

test('Codex update failure terminates the startup flow after user confirms', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-update-'))
  const fakeCodex = path.join(root, 'codex')
  const logFile = path.join(root, 'one-click.log')
  const detailFile = path.join(root, 'details.log')

  writeFileSync(fakeCodex, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "codex-cli 1.2.3\\n" ;;',
    '  update) printf "update attempted\\n"; exit 42 ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$2"',
    'DETAIL_FILE="$3"',
    'FAKE_CODEX="$4"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'agent_log() { printf "[aamp-one-click] %s\\n" "$*"; }',
    'agent_fail() { printf "[aamp-one-click] ERROR: %s\\n" "$*" >&2; exit 1; }',
    'write_one_click_log() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, logFile, detailFile, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /当前 Codex CLI 版本是：1\.2\.3，最新版本是：9\.9\.9/)
  assert.match(result.stdout, /\[aamp-one-click\] 正在更新 Codex CLI\.\.\./)
  assert.doesNotMatch(result.stdout, /startup-continued/)
  assert.match(result.stderr, /Codex CLI 升级失败/)
  assert.match(readFileSync(logFile, 'utf8'), /update attempted/)
})

test('declining a newer Codex update terminates without updating', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-decline-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 1; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /已取消 Codex CLI 升级，本次启动已终止/)
  assert.doesNotMatch(result.stdout, /startup-continued/)
  assert.equal(existsSync(updateMarker), false)
})

test('Codex update confirmation fails when no interactive terminal is available', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('confirm_codex_cli_update()')
  const helperEnd = source.indexOf('\nensure_codex_cli_updated()', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  assert.match(helper, /AAMP_CODEX_UPDATE_TTY/)

  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-no-tty-'))
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
AAMP_CODEX_UPDATE_TTY="$1/missing-tty"
${helper}
set +e
confirm_codex_cli_update 2>/dev/null
status=$?
set -e
printf '%s' "$status"
`, 'bash', root], { encoding: 'utf8' })

  assert.equal(output, '2')
})

test('Codex update exit zero without an actual version change terminates startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-confirm-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /startup-continued/)
  assert.match(result.stderr, /Codex CLI 升级未生效/)
  assert.equal(existsSync(updateMarker), true)
})

test('confirming a newer Codex update continues after the installed version changes', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-confirm-updated-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version)
    if [ -f ${JSON.stringify(updateMarker)} ]; then
      printf 'codex-cli 9.9.9\\n'
    else
      printf 'codex-cli 1.2.3\\n'
    fi
    ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.equal(existsSync(updateMarker), true)
})

test('Codex update is skipped when the selected CLI is already latest', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-current-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  const logFile = path.join(root, 'one-click.log')
  const detailFile = path.join(root, 'details.log')

  writeFileSync(fakeCodex, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "codex-cli 1.2.3\\n" ;;',
    `  update) printf "attempted\\n" >${JSON.stringify(updateMarker)} ;;`,
    'esac',
    '',
  ].join('\n'))
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$2"',
    'DETAIL_FILE="$3"',
    'FAKE_CODEX="$4"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'agent_log() { printf "[aamp-one-click] %s\\n" "$*"; }',
    'write_one_click_log() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "1.2.3\\n"; }',
    'ensure_codex_cli_updated',
  ].join('\n')
  const output = execFileSync(
    'bash',
    ['-c', shell, 'bash', root, logFile, detailFile, fakeCodex],
    { encoding: 'utf8' },
  )

  assert.match(output, /当前 Codex CLI 版本是：1\.2\.3，最新版本是：1\.2\.3/)
  assert.doesNotMatch(output, /正在更新 Codex CLI/)
  assert.equal(existsSync(updateMarker), false)
})
