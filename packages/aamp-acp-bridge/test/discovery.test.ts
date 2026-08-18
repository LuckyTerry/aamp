import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  discoverAcpBridgeAgents,
  type AcpBridgeAgentCandidate,
} from '../src/discovery.js'
import {
  defaultAcpCommand,
  WORKBUDDY_AI_APP_CLI,
  WORKBUDDY_APP_CLI,
} from '../src/agent-resolver.js'
import { expectedFakePathVersion, withFakePath } from './path-fixture.js'

function findCandidate(configPath: string, name: string): AcpBridgeAgentCandidate {
  const matches = discoverAcpBridgeAgents(configPath).candidates
    .filter((candidate) => candidate.id === name)
  assert.equal(matches.length, 1)
  return matches[0]
}

test('discovers an installed native traex executable', () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], (directory) => {
    assert.deepEqual(findCandidate(join(directory, 'missing-config.json'), 'traex'), {
      id: 'traex',
      displayName: 'traex',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: expectedFakePathVersion('traecli 0.200.19'),
      warnings: [],
    })
  })
})

test('reports canonical native defaults when traex is missing', () => {
  withFakePath([], (directory) => {
    const candidate = findCandidate(join(directory, 'missing-config.json'), 'traex')
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, false)
    assert.equal(candidate.confidence, 'low')
    assert.equal(candidate.command, 'traex')
    assert.equal(candidate.acpCommand, 'traex acp serve')
    assert.deepEqual(candidate.warnings, ['traex was not found on PATH.'])
  })
})

test('discovers an installed native TraeCode CLI executable', () => {
  withFakePath([{ name: 'traecli', version: 'trae-cli version 0.120.52' }], (directory) => {
    assert.deepEqual(findCandidate(join(directory, 'missing-config.json'), 'traecli'), {
      id: 'traecli',
      displayName: 'traecli',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: expectedFakePathVersion('trae-cli version 0.120.52'),
      warnings: [],
    })
  })
})

test('reports the canonical TraeCode CLI default when it is missing', () => {
  withFakePath([], (directory) => {
    const candidate = findCandidate(join(directory, 'missing-config.json'), 'traecli')
    assert.equal(candidate.detected, false)
    assert.equal(candidate.command, 'traecli')
    assert.equal(candidate.acpCommand, 'traecli acp serve')
    assert.deepEqual(candidate.warnings, ['traecli was not found on PATH.'])
  })
})

test('exposes WorkBuddy once with its standard embedded command', () => {
  withFakePath([], (directory) => {
    const candidate = findCandidate(join(directory, 'missing-config.json'), 'workbuddy')
    assert.equal(candidate.command, WORKBUDDY_APP_CLI)
    assert.equal(candidate.acpCommand, defaultAcpCommand('workbuddy'))
  })
})

test('discovery upgrades exact saved WorkBuddy legacy commands', () => {
  withFakePath([], (directory) => {
    const cases = [
      ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
      ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
    ] as const

    for (const [name, legacyCommand] of cases) {
      const configPath = join(directory, `${name}.json`)
      writeFileSync(configPath, JSON.stringify({
        aampHost: 'https://meshmail.ai',
        rejectUnauthorized: false,
        agents: [{
          name,
          acpCommand: legacyCommand,
          credentialsFile: join(directory, `${name}-credentials.json`),
        }],
      }))
      assert.equal(findCandidate(configPath, name).acpCommand, defaultAcpCommand(name))
    }
  })
})

test('does not expose legacy Trae names as native candidates', () => {
  withFakePath([], (directory) => {
    const ids = discoverAcpBridgeAgents(join(directory, 'missing-config.json'))
      .candidates.map((candidate) => candidate.id)
    for (const legacyName of ['trae', 'coco']) {
      assert.equal(ids.includes(legacyName), false)
    }
  })
})

test('preserves an explicitly configured legacy Trae command for saved bindings', () => {
  withFakePath([], (directory) => {
    const configPath = join(directory, 'bridge.json')
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'trae',
        acpCommand: 'traex acp serve',
        credentialsFile: join(directory, 'missing-credentials.json'),
      }],
    }))

    const candidate = findCandidate(configPath, 'trae')
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, true)
    assert.equal(candidate.confidence, 'medium')
    assert.equal(candidate.acpCommand, 'traex acp serve')
  })
})

test('redacts configured remote discovery commands into structural booleans', () => {
  withFakePath([], (directory) => {
    const configPath = join(directory, 'remote-bridge.json')
    const credentialsFile = join(directory, 'REMOTE_DISCOVERY_CREDENTIAL_SENTINEL.json')
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'aime@example.com',
      smtpPassword: 'fixture-password',
    }))
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'aime',
        acpCommand: "'/Users/private/REMOTE_DISCOVERY_COMMAND_SENTINEL' --acp",
        credentialsFile,
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      }],
    }))

    assert.deepEqual(findCandidate(configPath, 'aime'), {
      id: 'aime',
      displayName: 'aime',
      connection: 'acp_bridge',
      detected: false,
      configured: true,
      confidence: 'medium',
      executionLocation: 'remote',
      commandConfigured: true,
      acpCommandConfigured: true,
      email: 'aime@example.com',
      warnings: ['Remote Agent adapter was not detected.'],
    })
  })
})

test('remote discovery omits generated command, version, and warning paths', () => {
  withFakePath([], (directory) => {
    const configPath = join(directory, 'remote-workbuddy-ai.json')
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'workbuddy_ai',
        acpCommand: "env CODEBUDDY_CONFIG_DIR='/Users/private/REMOTE_CONFIG_DIR_SENTINEL' '/Applications/WorkBuddy AI.app/REMOTE_APP_SENTINEL' --acp",
        credentialsFile: join(directory, 'missing-credentials.json'),
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      }],
    }))

    const candidate = findCandidate(configPath, 'workbuddy_ai') as unknown as Record<string, unknown>
    assert.equal(candidate.executionLocation, 'remote')
    assert.equal(candidate.commandConfigured, true)
    assert.equal(candidate.acpCommandConfigured, true)
    assert.equal('command' in candidate, false)
    assert.equal('acpCommand' in candidate, false)
    assert.equal('version' in candidate, false)
    assert.doesNotMatch(
      JSON.stringify(candidate),
      /REMOTE_CONFIG_DIR_SENTINEL|REMOTE_APP_SENTINEL|Applications|\.workbuddy|Users\/private/,
    )
  })
})

test('exposes both WorkBuddy products as distinct native candidates', () => {
  const ids = discoverAcpBridgeAgents('/definitely/missing/config.json')
    .candidates.map((candidate) => candidate.id)
  assert.equal(ids.filter((id) => id === 'workbuddy').length, 1)
  assert.equal(ids.filter((id) => id === 'workbuddy_ai').length, 1)
})
