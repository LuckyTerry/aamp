import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(__dirname, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')

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
  assert.match(output, /aamp-feishu-task-agent/)
})

test('bootstrap terminal UX points users at local logs and success state', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.match(source, /print_local_log_hints/)
  assert.match(source, /运行日志目录/)
  assert.match(source, /运行日志打包/)
  assert.match(source, /collect --run-dir/)
  assert.match(source, /特定任务日志打包/)
  assert.match(source, /collect --task-id xxx/)
  assert.match(source, /collect --task-guid yyy/)
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
