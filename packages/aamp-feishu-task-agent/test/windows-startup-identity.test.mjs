import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startManagedProcess, cleanupAll } from '../bin/feishu-task-agent-controller.mjs'

test('native Windows managed startup waits for verified process sampling', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aamp-startup-identity-'))
  let record
  t.after(async () => {
    if (record) {
      await record.windowsIdentity.catch(() => {})
      await cleanupAll()
      if (!record.exited) record.child.kill()
      await record.exitPromise
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  record = await startManagedProcess({
    label: 'identity-test', executable: 'node', packageSpec: 'local-test-fixture',
    // Independent lifetime also bounds failures before startManagedProcess returns a record.
    args: ['-e', 'setTimeout(()=>{},30000)'],
    env: process.env, logFile: path.join(root, 'process.log'),
    preparedExecutable: { executable: 'node', kind: 'direct', command: process.execPath, pathValue: process.env.PATH || process.env.Path, environment: {} },
  })
  assert.ok(record.windowsDescendants.has(record.child.pid), 'startup must await the first verified snapshot')
})
