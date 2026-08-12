import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../src/agent-resolver.js'
import { discoverAcpBridgeAgents } from '../src/discovery.js'
import { KNOWN_AGENTS } from '../src/known-agents.js'
import {
  DEFAULT_ZCODE_CLI_PATH,
  ZCODE_ACP_COMMAND,
  detectZcodeInstallation,
} from '../src/zcode-acp/app-locator.js'

test('detects the ZCode CLI embedded in the macOS application', () => {
  const detected = detectKnownAgent('zcode')
  assert.ok(detected)
  assert.equal(detected.command, DEFAULT_ZCODE_CLI_PATH)
  assert.equal(detected.acpCommand, ZCODE_ACP_COMMAND)
  assert.match(detected.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
})

test('includes the detected ZCode installation in bridge discovery', () => {
  const result = discoverAcpBridgeAgents(join(tmpdir(), 'aamp-zcode-missing-config.json'))
  const zcode = result.candidates.find((candidate) => candidate.id === 'zcode')

  assert.ok(zcode)
  assert.equal(zcode.detected, true)
  assert.equal(zcode.confidence, 'high')
  assert.equal(zcode.acpCommand, 'aamp-zcode-acp serve')
})

test('keeps ZCode in the shared catalog exactly once', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'zcode').length, 1)
})

test('prefers the explicit ZCode CLI override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-zcode-locator-'))
  const cliPath = join(directory, 'zcode.cjs')
  writeFileSync(cliPath, 'process.stdout.write("9.8.7\\n")')

  assert.deepEqual(detectZcodeInstallation({
    platform: 'darwin',
    env: { AAMP_ZCODE_CLI_PATH: cliPath },
    runVersion: () => '9.8.7',
  } as never), {
    command: cliPath,
    acpCommand: ZCODE_ACP_COMMAND,
    version: '9.8.7',
  })
})

test('does not fall back when an explicit ZCode CLI override is invalid', () => {
  assert.equal(detectZcodeInstallation({
    platform: 'darwin',
    env: { AAMP_ZCODE_CLI_PATH: '/missing/zcode.cjs' },
    runVersion: () => '9.8.7',
  } as never), undefined)
})

test('does not auto-detect ZCode off macOS', () => {
  assert.equal(detectZcodeInstallation({
    platform: 'linux',
    runVersion: () => '9.8.7',
  }), undefined)
})

test('does not detect a CLI whose version probe fails', () => {
  assert.equal(detectZcodeInstallation({
    platform: 'darwin',
    defaultPath: DEFAULT_ZCODE_CLI_PATH,
    runVersion: () => {
      throw new Error('version failed')
    },
  }), undefined)
})

test('renders an official login command without shell interpolation', async () => {
  const locator = await import('../src/zcode-acp/app-locator.js') as unknown as {
    renderZcodeLoginCommand?: (cliPath: string) => string
  }

  assert.equal(typeof locator.renderZcodeLoginCommand, 'function')
  assert.equal(
    locator.renderZcodeLoginCommand?.('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
    'node "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" login',
  )
})

test('uses actionable ZCode defaults in resolver helpers', () => {
  assert.equal(defaultAcpCommand('zcode'), ZCODE_ACP_COMMAND)
  assert.match(missingAgentWarning('zcode'), /\/Applications\/ZCode\.app/)
  assert.match(missingAgentWarning('zcode'), /AAMP_ZCODE_CLI_PATH/)
})
