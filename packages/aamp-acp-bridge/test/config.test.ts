import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultAgentSlug, loadConfig } from '../src/config.js'

function configWithCommand(acpCommand: string) {
  return {
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: [{ name: 'trae', acpCommand }],
  }
}

test('bridge config rejects empty and whitespace-only ACP commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-config-test-'))
  const configPath = join(directory, 'bridge.json')

  try {
    for (const command of ['', '   ', '\t\r\n']) {
      writeFileSync(configPath, JSON.stringify(configWithCommand(command)))
      assert.throws(() => loadConfig(configPath))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bridge config preserves a quoted multi-token ACP command verbatim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-config-test-'))
  const configPath = join(directory, 'bridge.json')
  const command = '  traecli acp serve --model "doubao pro" --yolo  '

  try {
    writeFileSync(configPath, JSON.stringify(configWithCommand(command)))
    assert.equal(loadConfig(configPath).agents[0].acpCommand, command)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('default Agent slugs are schema-safe without changing canonical names', () => {
  assert.equal(defaultAgentSlug('workbuddy_ai'), 'workbuddy-ai-bridge')
  assert.equal(defaultAgentSlug('traex'), 'traex-bridge')
  assert.equal(defaultAgentSlug('My_Custom Agent'), 'my-custom-agent-bridge')
})

test('default Agent slug rejects names without ASCII alphanumeric content', () => {
  assert.throws(
    () => defaultAgentSlug('___ --- 你好'),
    /Cannot derive a valid default Agent slug/,
  )
})
