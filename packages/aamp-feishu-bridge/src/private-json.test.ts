import { assertPrivateFile } from './private-json-test-support.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { writePrivateJsonAtomic } from './private-json.js'

test('writePrivateJsonAtomic writes and replaces private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-private-json-'))
  const target = join(root, 'nested', 'config.json')
  try {
    await writePrivateJsonAtomic(target, { app_secret: 'SECRET_SENTINEL' })
    await assertPrivateFile(target)
    await writePrivateJsonAtomic(target, { app_secret: 'SECOND_SENTINEL' })
    await assertPrivateFile(target)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app_secret: 'SECOND_SENTINEL' })
    await writePrivateJsonAtomic(target, { app_secret: 'THIRD_SENTINEL' })
    await assertPrivateFile(target)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app_secret: 'THIRD_SENTINEL' })
    assert.deepEqual((await readdir(dirname(target))).sort(), ['config.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
