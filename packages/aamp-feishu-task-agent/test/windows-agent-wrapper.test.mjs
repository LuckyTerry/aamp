import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

test('wrapper preserves argv, environment, stdin and child exit code', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-wrapper-'))
  const fixture = path.join(root, 'fixture.mjs')
  const output = path.join(root, 'output.json')
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => { writeFileSync(process.env.OUT, JSON.stringify({argv:process.argv.slice(2), value:process.env.TEST_VALUE, input})); process.exit(23) })`)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/windows-agent-wrapper.mjs', import.meta.url))], {
    input: 'hello\r\n', encoding: 'utf8', env: { ...process.env, AAMP_WINDOWS_AGENT_CONFIG: JSON.stringify({ command: process.execPath, args: [fixture, 'space value', '中文', '"quoted"'], env: { OUT: output, TEST_VALUE: 'kept' } }) },
  })
  assert.equal(result.status, 23, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { argv: ['space value', '中文', '"quoted"'], value: 'kept', input: 'hello\r\n' })
})

test('wrapper rejects malformed or shell-string config', () => {
  for (const config of [{ command: 'codex --help', args: [] }, { command: 'codex', args: ' --help' }]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/windows-agent-wrapper.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, AAMP_WINDOWS_AGENT_CONFIG: JSON.stringify(config) } })
    assert.equal(result.status, 2)
  }
})
