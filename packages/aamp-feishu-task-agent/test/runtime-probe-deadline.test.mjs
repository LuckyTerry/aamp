import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as runtime from '../bin/runtime-package-executable.mjs'

test('probe timeout does not depend on cleanup completing', async () => {
  const started = Date.now()
  let cleanup = false
  await assert.rejects(runtime.withExecutableProbeDeadline(new Promise(() => {}), {
    timeoutMs: 20, label: 'fixture', onTimeout: () => { cleanup = true; return new Promise(() => {}) },
  }), /fixture.*超时/)
  assert.equal(cleanup, true)
  assert.ok(Date.now() - started < 1000)
})

test('successful probe clears its deadline and never triggers later cleanup', async () => {
  let cleanup = false
  assert.equal(await runtime.withExecutableProbeDeadline(Promise.resolve(42), {
    timeoutMs: 20, label: 'fixture', onTimeout: () => { cleanup = true },
  }), 42)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(cleanup, false)
})
