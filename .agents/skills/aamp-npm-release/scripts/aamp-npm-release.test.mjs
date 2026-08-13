import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.join(scriptDir, 'aamp-npm-release.mjs')
const skillPath = path.resolve(scriptDir, '..', 'SKILL.md')

function createFakeNpm(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aamp-release-pm-'))
  const fakeNpm = path.join(root, 'npm')
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "10.0.0\\n" ;;',
    '  whoami) printf "luckyterry\\n" ;;',
    '  view) printf "[]\\n" ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'))
  fs.chmodSync(fakeNpm, 0o755)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return fakeNpm
}

test('release helper keeps --agent only as a deprecated compatibility option', () => {
  const help = execFileSync(process.execPath, [helperPath, '--help'], { encoding: 'utf8' })
  const source = fs.readFileSync(helperPath, 'utf8')

  assert.match(help, /--agent NAME\s+Deprecated compatibility option; printed startup commands omit --agent/)
  assert.doesNotMatch(help, /Default: coco/)
  assert.doesNotMatch(source, /bash -s -- install --agent/)
})

test('release skill documents interactive agent selection without a startup flag', () => {
  const skill = fs.readFileSync(skillPath, 'utf8')

  assert.match(skill, /one-click startup commands omit `--agent`/i)
  assert.match(skill, /interactive multi-select/i)
  assert.doesNotMatch(skill, /defaults?\s+generated startup commands to `--agent coco`/i)
})

test('release helper rejects the removed trae agent type', () => {
  const result = spawnSync(process.execPath, [helperPath, '--agent', 'trae', '--help'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--agent must be one of: codex, cursor, coco, traex, traecli, workbuddy/)
})

test('release wizard omits agent prompts and flags from local and remote one-click commands', (t) => {
  const fakeNpm = createFakeNpm(t)

  for (const choice of ['1', '2']) {
    const result = spawnSync(
      process.execPath,
      [helperPath, '--wizard', '--pm', fakeNpm, '--agent', 'cursor'],
      { encoding: 'utf8', input: `${choice}\n\nall\n` },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /启动命令使用哪个 agent/)
    if (choice === '2') assert.match(result.stdout, /bash -s -- install(?:\n|$)/)
    assert.doesNotMatch(result.stdout, /--agent(?:\s|$)/)
  }
})
