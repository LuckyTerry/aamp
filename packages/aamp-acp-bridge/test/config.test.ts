import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultAgentSlug, loadConfig, normalizeAgentConfig } from '../src/config.js'

function configWithCommand(acpCommand: string) {
  return {
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: [{ name: 'trae', acpCommand }],
  }
}

function configWithAgent(agent: Record<string, unknown>) {
  return {
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: [{ name: 'remote-agent', acpCommand: 'remote-agent --acp', ...agent }],
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

test('bridge config normalizes attachment policy to an explicit allow or reject value', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-config-test-'))
  const configPath = join(directory, 'bridge.json')

  try {
    writeFileSync(configPath, JSON.stringify(configWithAgent({ attachmentPolicy: 'reject' })))
    assert.equal(loadConfig(configPath).agents[0].attachmentPolicy, 'reject')

    writeFileSync(configPath, JSON.stringify(configWithAgent({})))
    assert.equal(loadConfig(configPath).agents[0].attachmentPolicy, 'allow')

    writeFileSync(configPath, JSON.stringify(configWithAgent({ attachmentPolicy: 'drop' })))
    assert.throws(() => loadConfig(configPath))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('programmatic agent config input normalizes to an explicit runtime policy', () => {
  const normalized = normalizeAgentConfig({
    name: 'remote-agent',
    acpCommand: 'remote-agent --acp',
  })

  assert.equal(normalized.attachmentPolicy, 'allow')
  assert.equal(normalized.executionLocation, 'local')
})

test('remote Agents require rejected attachments', () => {
  assert.equal(normalizeAgentConfig({
    name: 'aime',
    acpCommand: 'aime-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
  }).executionLocation, 'remote')

  assert.throws(() => normalizeAgentConfig({
    name: 'unsafe-remote',
    acpCommand: 'unsafe-remote-acp',
    executionLocation: 'remote',
    attachmentPolicy: 'allow',
  }), /remote Agent requires attachmentPolicy=reject/)
})
