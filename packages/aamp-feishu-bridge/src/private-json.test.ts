import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { writePrivateJsonAtomic } from './private-json.js'

test('writePrivateJsonAtomic writes and replaces mode 0600 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-private-json-'))
  const target = join(root, 'nested', 'config.json')
  try {
    await writePrivateJsonAtomic(target, { app_secret: 'SECRET_SENTINEL' })
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    await writePrivateJsonAtomic(target, { app_secret: 'SECOND_SENTINEL' })
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app_secret: 'SECOND_SENTINEL' })
    assert.deepEqual((await readdir(dirname(target))).sort(), ['config.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
