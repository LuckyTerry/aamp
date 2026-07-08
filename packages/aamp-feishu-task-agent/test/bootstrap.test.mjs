import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  assert.match(source, /Logs saved at:/)
  assert.match(source, /collect --latest/)
  assert.match(source, /aamp-logs/)
  assert.match(source, /errors\.jsonl/)
  assert.match(source, /已接入飞书任务，可以开始对话 & 派发任务/)
  assert.match(source, /AAMP_ONE_CLICK_VERBOSE/)
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
