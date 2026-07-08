import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
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
