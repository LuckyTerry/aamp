import assert from 'node:assert/strict'
import test from 'node:test'
import {
  noAgentsFoundMessage,
  resolveInitScanTargets,
} from '../src/cli/init.js'

test('interactive init accepts only the native traex name', () => {
  assert.deepEqual(resolveInitScanTargets('traex'), ['traex'])
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.throws(
      () => resolveInitScanTargets(legacyName),
      new RegExp(`Unknown ACP agent "${legacyName}"`),
    )
  }
})

test('forced init explains a missing traex executable', () => {
  assert.equal(
    noAgentsFoundMessage('traex'),
    'No ACP agent found. traex was not found on PATH.',
  )
  assert.match(noAgentsFoundMessage(), /Install an agent first/)
})
