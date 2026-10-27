import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findWindowsAgent,prepareWindowsNativeAgent} from '../bootstrap/windows-agents.mjs'

// Match fixture suffixes on case-sensitive CI filesystems as well as Windows.
async function fixture(t) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'aamp-trae-identity-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const warnings=[]
  t.mock.method(console,'error',line=>warnings.push(line))
  const file=async name=>{const value=path.join(root,name);await writeFile(value,'');return value}
  const shim=async(name,entry)=>{const value=path.join(root,name);await writeFile(value,`@echo off\r\n"node" "%~dp0\\${entry}" %*\r\n`);return value}
  return {root,file,shim,warnings,env:{PATH:root,PATHEXT:'.exe;.cmd'}}
}
const noRun=()=>assert.fail('identity checks must not execute an agent')

test('both explicit TraeCode overrides reject Coco and Traex basenames without PATH fallback',async t=>{
  const f=await fixture(t)
  await f.file('traecli.exe')
  for (const key of ['AAMP_TRAECODE_CLI_BIN','TRAECODE_CLI_BIN']) {
    for (const name of ['coco.exe','TRAEX.EXE','coco.js']) {
      const env={...f.env,[key]:await f.file(name)}
      assert.equal(await findWindowsAgent('traecli',env,noRun),undefined)
      assert.match(f.warnings.pop(),/TraeCode.*(?:coco|traex)/i)
      await assert.rejects(prepareWindowsNativeAgent('traecli',env,{run:noRun,npmLaunch:noRun}),/未检测到/)
    }
  }
})

test('npm aliases sharing a JS entry conflict but independent entries sharing node.exe do not',async t=>{
  const f=await fixture(t)
  await f.file('shared.js');await f.file('independent.js')
  await f.shim('coco.cmd','shared.js')
  const trae=await f.shim('traecli.cmd','shared.js')
  assert.equal(await findWindowsAgent('traecli',f.env,noRun),undefined)
  assert.match(f.warnings.pop(),/Coco.*同一/)
  assert.equal(await findWindowsAgent('traecli',{...f.env,AAMP_TRAECODE_CLI_BIN:trae},noRun),undefined)
  await f.shim('traecli.cmd','independent.js')
  assert.equal((await findWindowsAgent('traecli',f.env,noRun)).argsPrefix[0],path.join(f.root,'independent.js'))
})

test('real paths through a directory junction detect the same entry',async t=>{
  const f=await fixture(t)
  const actual=path.join(f.root,'actual'),alias=path.join(f.root,'alias')
  await mkdir(actual)
  await writeFile(path.join(actual,'entry.js'),'')
  await symlink(actual,alias,'junction')
  const env={...f.env,AAMP_COCO_CLI_BIN:path.join(actual,'entry.js'),AAMP_TRAECODE_CLI_BIN:path.join(alias,'entry.js')}
  assert.equal(await findWindowsAgent('traecli',env,noRun),undefined)
  assert.match(f.warnings.pop(),/Coco.*同一/)
})
