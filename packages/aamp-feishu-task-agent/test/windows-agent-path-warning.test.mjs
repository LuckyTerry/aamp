import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findWindowsAgent} from '../bootstrap/windows-agents.mjs'
import {resolveWindowsCodexCli} from '../bootstrap/windows-helper.mjs'

test('invalid explicit paths explain missing files without falling back or changing valid discovery',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aamp-path-warning-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const warnings=[]
  t.mock.method(console,'error',message=>warnings.push(message))
  await writeFile(path.join(root,'coco.exe'),'')
  // Match fixture suffixes on case-sensitive CI filesystems as well as Windows.
  const env={PATH:root,PATHEXT:'.exe',AAMP_COCO_CLI_BIN:path.join(root,'missing.exe')}
  assert.equal(await findWindowsAgent('coco',env,async()=>{}),undefined)
  assert.match(warnings.join('\n'),/AAMP_COCO_CLI_BIN.*不存在/)
  assert.match(warnings.join('\n'),/清除.*重新扫描/)
  warnings.length=0
  assert.ok(await findWindowsAgent('coco',{...env,AAMP_COCO_CLI_BIN:''},async()=>{}))
  assert.equal(warnings.length,0)
  assert.equal(await resolveWindowsCodexCli({AAMP_CODEX_CLI_BIN:path.join(root,'missing.exe')},{findUserCodex:()=>assert.fail('must not fall back')}),'')
  assert.match(warnings.join('\n'),/AAMP_CODEX_CLI_BIN.*不存在/)
})

test('warnings distinguish unsupported wrappers and Cursor identity failures and preserve AIME fallback policy',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aamp-path-warning-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const warnings=[]
  t.mock.method(console,'error',message=>warnings.push(message))
  const wrapper=path.join(root,'coco.bat'),alias=path.join(root,'agent.exe')
  await writeFile(wrapper,'echo fixture');await writeFile(alias,'',{mode:0o755})
  assert.equal(await findWindowsAgent('coco',{AAMP_COCO_CLI_BIN:wrapper},async()=>{}),undefined)
  assert.match(warnings.pop(),/不支持/)
  assert.equal(await findWindowsAgent('cursor',{AAMP_CURSOR_CLI_BIN:alias},async()=>({stdout:'other product',stderr:''})),undefined)
  assert.match(warnings.pop(),/Cursor.*身份/)
  assert.equal(await findWindowsAgent('aime',{AAMP_AIME_ACP_BIN:path.join(root,'missing.exe')},async()=>{}),undefined)
  assert.match(warnings.pop(),/继续.*托管适配器/)
})
