import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,chmod,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findUserCodexCli} from '../bootstrap/windows-codex-discovery.mjs'
import {resolveWindowsCodexCli} from '../bootstrap/windows-helper.mjs'

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'aamp-codex-discovery-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=path.join(root,'OpenAI','Codex','bin')
  await mkdir(bin,{recursive:true})
  const add=async(name,file='codex.exe')=>{
    const target=path.join(bin,name,file)
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'fixture');await chmod(target,0o755)
    return target
  }
  return {root,bin,add}
}

test('user Codex discovery ignores helpers and selects a runnable CLI by version, not directory order',async t=>{
  const {root,add}=await fixture(t)
  const newer=await add('aaaa')
  const older=await add('zzzz')
  const denied=await add('denied')
  const invalid=await add('not-cli')
  await add('desktop','CodexDesktop.exe');await add('helper','rg.exe')
  const checked=[]
  const result=await findUserCodexCli({LOCALAPPDATA:root},{probe:async file=>{
    checked.push(file)
    if(file===denied)throw new Error('access denied')
    return file===newer?'codex-cli 0.153.4\r\n':file===older?'codex-cli 0.99.0\n':'another product 9.0.0'
  }})
  assert.equal(result,newer)
  assert.deepEqual(new Set(checked),new Set([newer,older,denied,invalid]))
})

test('user Codex discovery returns unavailable for missing install or failed probes',async t=>{
  const {root,add}=await fixture(t)
  const fail=async()=>{throw new Error('timeout')}
  assert.equal(await findUserCodexCli({LOCALAPPDATA:path.join(root,'missing')},{probe:fail}),'')
  await add('candidate')
  assert.equal(await findUserCodexCli({LOCALAPPDATA:root},{probe:fail}),'')
  assert.equal(await findUserCodexCli({},{probe:()=>assert.fail('must not search cwd')}),'')
})

test('user Codex discovery accepts Windows environment casing and prefers stable over same-core prerelease',async t=>{
  const {root,add}=await fixture(t)
  const stable=await add('stable'), rc=await add('rc')
  assert.equal(await findUserCodexCli({LocalAppData:root},{probe:async file=>file===stable?'codex-cli 1.0.0':'codex-cli 1.0.0-rc.1'}),stable)
})

test('Codex resolution keeps explicit and PATH priority and falls back only when neither is available',async t=>{
  const {root,add}=await fixture(t)
  const explicit=await add('explicit'), pathCli=await add('path')
  const env={PATH:path.dirname(pathCli),PATHEXT:'.exe',AAMP_WINDOWS_TEST_PLATFORM:'win32'}
  const forbidden={findUserCodex:async()=>assert.fail('must preserve higher-priority selection')}
  assert.equal(await resolveWindowsCodexCli({...env,AAMP_CODEX_CLI_BIN:explicit},forbidden),explicit)
  assert.equal(await resolveWindowsCodexCli(env,forbidden),await realpath(pathCli))
  assert.equal(await resolveWindowsCodexCli({...env,AAMP_CODEX_CLI_BIN:path.join(root,'missing.exe')},forbidden),'')
  let called=0
  assert.equal(await resolveWindowsCodexCli({...env,PATH:''},{findUserCodex:async received=>{
    called++;assert.equal(received.PATH,'');return explicit
  }}),explicit)
  assert.equal(called,1)
})
