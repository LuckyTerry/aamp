import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWN_AGENTS,
  WORKBUDDY_APP_CLI,
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../src/agent-resolver.js'
import { withFakePath } from './path-fixture.js'

test('registers only traex as a native Trae profile', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'traex').length, 1)
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.equal(KNOWN_AGENTS.includes(legacyName), false)
  }
})

test('detects traex and maps its native ACP command', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], () => {
    assert.deepEqual(detectKnownAgent('traex'), {
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'traecli 0.200.19',
    })
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
  })
})

test('does not fall back to traecli or coco', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([
    { name: 'traecli', version: 'legacy' },
    { name: 'coco', version: 'legacy' },
  ], () => {
    assert.equal(detectKnownAgent('traex'), undefined)
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
    assert.equal(missingAgentWarning('traex'), 'traex was not found on PATH.')
  })
})

test('preserves representative existing native mappings', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([
    { name: 'claude', version: 'claude 1.0.0' },
    { name: 'hermes', version: 'hermes 1.0.0' },
  ], () => {
    assert.equal(detectKnownAgent('claude')?.acpCommand, 'claude')
    assert.equal(detectKnownAgent('hermes')?.acpCommand, 'hermes acp')
    assert.equal(
      defaultAcpCommand('codex', 'npx -y custom-codex-acp'),
      'npx -y custom-codex-acp',
    )
  })
})

test('registers workbuddy exactly once as a known ACP agent', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy').length, 1)
})

test('resolves the installed macOS WorkBuddy app to its embedded ACP command', () => {
  const resolution = detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathExists: (path) => path === WORKBUDDY_APP_CLI,
    versionFor: () => '2.115.0',
  })

  assert.deepEqual(resolution, {
    command: WORKBUDDY_APP_CLI,
    acpCommand: `${WORKBUDDY_APP_CLI} --acp`,
    version: '2.115.0',
  })
})

test('reports the expected WorkBuddy app path when macOS detection fails', () => {
  assert.equal(
    missingAgentWarning('workbuddy', { platform: 'darwin' }),
    `WorkBuddy was not found at ${WORKBUDDY_APP_CLI}.`,
  )
})

test('requires an explicit WorkBuddy ACP command outside macOS', () => {
  assert.equal(detectKnownAgent('workbuddy', {
    platform: 'linux',
    pathExists: () => true,
    versionFor: () => '2.115.0',
  }), undefined)
  assert.equal(
    missingAgentWarning('workbuddy', { platform: 'linux' }),
    'WorkBuddy auto-detection is only supported on macOS; configure acpCommand explicitly.',
  )
})

test('preserves explicit ACP commands and existing Hermes defaults', () => {
  assert.equal(
    defaultAcpCommand('workbuddy', 'custom-codebuddy --acp'),
    'custom-codebuddy --acp',
  )
  assert.equal(
    defaultAcpCommand('codex', 'npx -y custom-codex-acp'),
    'npx -y custom-codex-acp',
  )
  assert.equal(defaultAcpCommand('hermes'), 'hermes acp')
})
