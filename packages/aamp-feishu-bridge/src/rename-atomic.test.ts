import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameAtomic } from './rename-atomic.js'

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows atomic rename retries a transient ${code} without changing paths`, async () => {
    const calls: unknown[] = []
    const delays: number[] = []
    await renameAtomic('source.tmp', 'state.json', {
      platform: 'win32',
      rename: async (...paths) => {
        calls.push(paths)
        if (calls.length === 1) throw Object.assign(new Error('sharing violation'), { code })
      },
      delay: async (milliseconds) => { delays.push(milliseconds) },
    })
    assert.deepEqual(calls, [['source.tmp', 'state.json'], ['source.tmp', 'state.json']])
    assert.deepEqual(delays, [100])
  })
}

test('Windows atomic rename preserves the original error after bounded retries', async () => {
  const error = Object.assign(new Error('access remains denied'), { code: 'EPERM' })
  let attempts = 0
  const delays: number[] = []
  await assert.rejects(renameAtomic('source.tmp', 'state.json', {
    platform: 'win32',
    rename: async () => { attempts += 1; throw error },
    delay: async (milliseconds) => { delays.push(milliseconds) },
  }), (actual) => actual === error)
  assert.equal(attempts, 6)
  assert.deepEqual(delays, [100, 200, 400, 800, 1600])
})

for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EACCES'], ['win32', 'ENOENT']] as const) {
  test(`atomic rename immediately preserves ${platform} ${code}`, async () => {
    const error = Object.assign(new Error('rename failed'), { code })
    let attempts = 0
    await assert.rejects(renameAtomic('source.tmp', 'state.json', {
      platform,
      rename: async () => { attempts += 1; throw error },
      delay: async () => { assert.fail('unexpected retry') },
    }), (actual) => actual === error)
    assert.equal(attempts, 1)
  })
}

for (const permanent of [false, true]) {
  test(`Windows state replacement keeps existing JSON intact during ${permanent ? 'permanent' : 'transient'} denial`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aamp-rename-state-'))
    const destination = join(directory, 'state.json')
    const source = join(directory, '.state.json.tmp')
    const oldState = JSON.stringify({ version: 1, tasks: { previous: {} } })
    const newState = JSON.stringify({ version: 1, tasks: { completed: {} } })
    const denied = Object.assign(new Error('file is occupied'), { code: 'EPERM' })
    try {
      await writeFile(destination, oldState)
      await writeFile(source, newState)
      let attempts = 0
      const replacement = renameAtomic(source, destination, {
        platform: 'win32',
        rename: async (from, to) => {
          assert.equal(await readFile(destination, 'utf8'), oldState)
          assert.equal(await readFile(source, 'utf8'), newState)
          if (++attempts === 1 || permanent) throw denied
          await rename(from, to)
        },
        delay: async () => {},
      })
      if (permanent) await assert.rejects(replacement, error => error === denied)
      else await replacement
      assert.equal(await readFile(destination, 'utf8'), permanent ? oldState : newState)
      assert.equal(attempts, permanent ? 6 : 2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
