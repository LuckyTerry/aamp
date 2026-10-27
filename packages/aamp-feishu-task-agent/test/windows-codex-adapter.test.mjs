import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {ensureCodexAdapter} from '../bootstrap/windows-codex-adapter.mjs'
import {withWindowsOperationLock} from '../bin/windows-operation-lock.mjs'
const lock=(directory, operation)=>withWindowsOperationLock(directory,operation,{readIdentity:async pid=>({pid,startedAt:'fixture',executablePath:process.execPath,ownerSid:'fixture'})})

test('repairs partial installation, reuses complete installation and serializes concurrent starts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-adapter-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  let calls=0
  const install=async directory => {
    calls++
    await mkdir(path.join(directory,'node_modules/adapter'),{recursive:true})
    await writeFile(path.join(directory,'package.json'),'{}')
    await writeFile(path.join(directory,'node_modules/adapter/package.json'),JSON.stringify({bin:'index.js'}))
    await writeFile(path.join(directory,'node_modules/adapter/index.js'),'// fixture')
  }
  const options={root, spec:'adapter@1.0.0', install, lock}
  const first=await ensureCodexAdapter(options)
  await rm(path.join(path.dirname(path.dirname(path.dirname(first))),'package.json'))
  const results=await Promise.all([ensureCodexAdapter(options),ensureCodexAdapter(options)])
  assert.deepEqual(results,[first,first])
  assert.equal(calls,2)
})

test('failed rebuild is bounded and never accepted as ready', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'codex-adapter-failure-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  let calls=0
  await assert.rejects(ensureCodexAdapter({root,spec:'adapter@1.0.0',lock,install:async()=>{calls++;throw Error('download failed')}}),/download failed/)
  assert.equal(calls,1)
})
