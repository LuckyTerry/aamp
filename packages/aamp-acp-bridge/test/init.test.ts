import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  noAgentsFoundMessage,
  resolveInitAcpCommand,
  resolveInitScanTargets,
} from '../src/cli/init.js'
import { withFakePath } from './path-fixture.js'

test('interactive init accepts canonical Traex, TraeCode CLI, and WorkBuddy product names', () => {
  assert.deepEqual(resolveInitScanTargets('traex'), ['traex'])
  assert.deepEqual(resolveInitScanTargets('traecli'), ['traecli'])
  assert.deepEqual(resolveInitScanTargets('workbuddy'), ['workbuddy'])
  assert.deepEqual(resolveInitScanTargets('workbuddy_ai'), ['workbuddy_ai'])
  for (const nonNativeName of ['trae', 'coco']) {
    assert.throws(
      () => resolveInitScanTargets(nonNativeName),
      new RegExp(`Unknown ACP agent "${nonNativeName}"`),
    )
  }
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.throws(
      () => resolveInitScanTargets(alias),
      new RegExp(`Unknown ACP agent "${alias}"`),
    )
  }
  assert.equal(
    noAgentsFoundMessage('traecli'),
    'No ACP agent found. traecli was not found on PATH.',
  )
})

test('forced init explains missing canonical agents', () => {
  assert.equal(
    noAgentsFoundMessage('traex'),
    'No ACP agent found. traex was not found on PATH.',
  )
  assert.match(noAgentsFoundMessage('workbuddy'), /WorkBuddy/)
  assert.match(noAgentsFoundMessage('workbuddy_ai'), /WorkBuddy AI/)
  assert.match(noAgentsFoundMessage(), /Install an agent first/)
})

test('interactive init preserves configured ACP commands verbatim', () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], (directory) => {
    const configPath = join(directory, 'bridge.json')
    const customCommand = '  traex acp serve --model "doubao pro"  '
    writeFileSync(configPath, JSON.stringify({
      agents: [
        { name: 'traex', acpCommand: customCommand },
        { name: 'trae', acpCommand: 'traex acp serve' },
      ],
    }))

    assert.equal(resolveInitAcpCommand(configPath, 'traex'), customCommand)
    assert.equal(resolveInitAcpCommand(configPath, 'trae'), 'traex acp serve')
  })
})

test('interactive init ignores blank or malformed configured commands', () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], (directory) => {
    const configPath = join(directory, 'bridge.json')

    for (const acpCommand of ['', '   ', 42, null]) {
      writeFileSync(configPath, JSON.stringify({
        agents: [{ name: 'traex', acpCommand }],
      }))
      assert.equal(resolveInitAcpCommand(configPath, 'traex'), 'traex acp serve')
    }

    writeFileSync(configPath, '{ malformed json')
    assert.equal(resolveInitAcpCommand(configPath, 'traex'), 'traex acp serve')
  })
})
