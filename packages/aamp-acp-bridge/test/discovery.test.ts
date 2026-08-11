import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { discoverAcpBridgeAgents } from '../src/discovery.js'
import { withFakePath } from './path-fixture.js'

function findTraex(configPath: string) {
  const matches = discoverAcpBridgeAgents(configPath).candidates
    .filter((candidate) => candidate.id === 'traex')
  assert.equal(matches.length, 1)
  return matches[0]
}

test('discovers an installed native traex executable', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], (directory) => {
    assert.deepEqual(findTraex(join(directory, 'missing-config.json')), {
      id: 'traex',
      displayName: 'traex',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'traecli 0.200.19',
      warnings: [],
    })
  })
})

test('reports the native defaults when traex is missing', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([], (directory) => {
    const candidate = findTraex(join(directory, 'missing-config.json'))
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, false)
    assert.equal(candidate.confidence, 'low')
    assert.equal(candidate.command, 'traex')
    assert.equal(candidate.acpCommand, 'traex acp serve')
    assert.deepEqual(candidate.warnings, ['traex was not found on PATH.'])
  })
})

test('does not expose legacy Trae or Coco names as native candidates', () => {
  const ids = discoverAcpBridgeAgents('/definitely/missing/config.json')
    .candidates.map((candidate) => candidate.id)
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.equal(ids.includes(legacyName), false)
  }
})
