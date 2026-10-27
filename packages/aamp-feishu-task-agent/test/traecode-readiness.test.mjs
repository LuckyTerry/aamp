import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseTraeCodeDoctor,
  supportsTraeCodeAcpHelp,
} from '../bin/traecode-readiness.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const helper = path.resolve(testDir, '../bin/traecode-readiness.mjs')

test('ACP detection requires serve usage and the dedicated description', () => {
  assert.equal(supportsTraeCodeAcpHelp(`
Start the ACP server
Usage:
  trae-cli acp serve [flags]
`), true)
  assert.equal(supportsTraeCodeAcpHelp(`
Available Commands:
  acp Agent Client Protocol commands
`), false)
  assert.equal(supportsTraeCodeAcpHelp('Usage: traecli acp serve [flags]'), false)
})

test('doctor exit-two JSON is parsed by checks, with model guidance preserved', () => {
  const result = parseTraeCodeDoctor(JSON.stringify({
    checks: [
      { name: 'binary', severity: 'info', message: '/Users/test/.local/bin/traecli' },
      { name: 'model', severity: 'error', message: 'no effective model configured', fix: 'use /model to pick one' },
    ],
  }), '/Users/test')
  assert.equal(result.status, 'model_required')
  assert.deepEqual(result.errors, [{
    name: 'model',
    severity: 'error',
    message: 'no effective model configured',
    fix: 'use /model to pick one',
  }])
  assert.doesNotMatch(JSON.stringify(result), /\/Users\/test/)
})

test('doctor warnings continue and malformed JSON is rejected', () => {
  assert.deepEqual(parseTraeCodeDoctor(JSON.stringify({ checks: [
    { name: 'update', severity: 'warning', message: 'new version available' },
  ] })), {
    status: 'ready',
    warnings: [{ name: 'update', severity: 'warning', message: 'new version available' }],
    errors: [],
  })
  assert.throws(() => parseTraeCodeDoctor('{broken'), /valid JSON/)
  assert.throws(() => parseTraeCodeDoctor('{}'), /checks array/)
  assert.throws(() => parseTraeCodeDoctor(JSON.stringify({ checks: [null] })), /check 0 is invalid/)
})

test('CLI probe rejects root help even when the command exits zero', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, '#!/bin/sh\nprintf "Available Commands:\\n  acp Agent Client Protocol commands\\n"\n')
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '5'], { encoding: 'utf8' })
  assert.equal(result.status, 3)
})

test('CLI probe accepts only a successful dedicated ACP help response', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, '#!/bin/sh\nprintf "Start the ACP server\\nUsage: trae-cli acp serve [flags]\\n"\n')
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '5'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('CLI probe timeout is distinct from unsupported ACP help', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '1'], {
    encoding: 'utf8', timeout: 4_000,
  })
  assert.equal(result.status, 124)
})

test('CLI probe timeout escalates from TERM to KILL for the direct child', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, `#!${process.execPath}
process.on('SIGTERM', () => {})
setTimeout(() => {}, 60_000)
`)
  chmodSync(fake, 0o755)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '3'], {
    encoding: 'utf8', timeout: 7_000,
  })
  const elapsedMs = Date.now() - startedAt
  assert.equal(result.status, 124, result.error?.message || result.stderr)
  assert.ok(elapsedMs >= 3_400 && elapsedMs < 6_000, `expected TERM-to-KILL bound, got ${elapsedMs}ms`)
})

test('CLI doctor is bounded and never invokes login/status', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'doctor --json') process.exit(90)
setTimeout(() => {}, 60_000)
`)
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'doctor', fake, '1'], {
    encoding: 'utf8', timeout: 4_000,
  })
  assert.equal(result.status, 124)
})

test('CLI doctor rejects unsupported exits and oversized output safely', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const unsupported = path.join(directory, 'unsupported')
  writeFileSync(unsupported, '#!/bin/sh\nprintf "{}"\nexit 9\n')
  chmodSync(unsupported, 0o755)
  assert.equal(
    spawnSync(process.execPath, [helper, 'doctor', unsupported, '10']).status,
    70,
  )

  const noisy = path.join(directory, 'noisy')
  writeFileSync(noisy, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024))\n`)
  chmodSync(noisy, 0o755)
  assert.equal(
    spawnSync(process.execPath, [helper, 'doctor', noisy, '10'], { timeout: 5_000 }).status,
    70,
  )

  const delayedNoisy = path.join(directory, 'delayed-noisy')
  writeFileSync(delayedNoisy, `#!${process.execPath}
process.on('SIGTERM', () => {})
process.stdout.write('x'.repeat(2 * 1024 * 1024))
setTimeout(() => {}, 60_000)
`)
  chmodSync(delayedNoisy, 0o755)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [helper, 'doctor', delayedNoisy, '10'], { timeout: 5_000 })
  assert.equal(result.status, 70, result.error?.message || result.stderr)
  assert.ok(Date.now() - startedAt < 4_000, 'output limit must remain hard-bounded')
})

test('CLI doctor unsupported exits do not expose child diagnostics', { skip: process.platform === 'win32' ? 'POSIX Trae probe fixtures; Windows Trae entry is not enabled' : false }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const unsupported = path.join(directory, 'unsupported')
  writeFileSync(unsupported, `#!${process.execPath}
process.stdout.write(JSON.stringify({ apiKey: '/Users/test/.trae/token' }))
process.stderr.write(JSON.stringify({ error: '/Users/test/private-error' }))
process.exit(9)
`)
  chmodSync(unsupported, 0o755)
  const result = spawnSync(process.execPath, [helper, 'doctor', unsupported, '10'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/Users/test' },
  })

  assert.equal(result.status, 70)
  const diagnostics = `${result.stdout}${result.stderr}`
  assert.doesNotMatch(diagnostics, /\{|apiKey|error|\/Users\/test/)
})
