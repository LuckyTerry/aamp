import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {findWindowsAgent} from '../bootstrap/windows-agents.mjs'
// Match fixture suffixes on case-sensitive CI filesystems as well as Windows.
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'aamp-cursor-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const local=path.join(root,'local'),bin=path.join(root,'bin'),official=path.join(local,'cursor-agent')
 await mkdir(official,{recursive:true});await mkdir(bin)
 const exe=async(dir,name)=>{const file=path.join(dir,name);await writeFile(file,'');await chmod(file,0o755);return file}
 return {root,local,bin,official,exe,env:{LOCALAPPDATA:local,PATH:bin,PATHEXT:'.exe'}}
}
test('Cursor official directory fills missing PATH without overriding explicit or dedicated PATH commands',async t=>{
 const f=await fixture(t),local=await f.exe(f.official,'cursor-agent.exe')
 const run=async()=>({stdout:'Authenticate with Cursor',stderr:''})
 assert.equal((await findWindowsAgent('cursor',f.env,run)).command,local)
 await f.exe(f.bin,'agent.exe')
 assert.equal((await findWindowsAgent('cursor',f.env,run)).command,local)
 const dedicated=await f.exe(f.bin,'cursor-agent.exe')
 assert.equal((await findWindowsAgent('cursor',f.env,run)).command,dedicated)
 assert.equal((await findWindowsAgent('cursor',{...f.env,AAMP_CURSOR_CLI_BIN:local},run)).command,local)
 assert.equal(await findWindowsAgent('cursor',{...f.env,AAMP_CURSOR_CLI_BIN:path.join(f.root,'missing.exe')},run),undefined)
})
test('generic official alias requires identity and unrelated local alias falls back to PATH',async t=>{
 const f=await fixture(t),local=await f.exe(f.official,'agent.exe'),external=await f.exe(f.bin,'agent.exe')
 const env={...f.env,LOCALAPPDATA:undefined,LocalAppData:f.local}
 const run=async command=>({stdout:command.command===local?'unrelated':'Authenticate with Cursor',stderr:''})
 assert.equal((await findWindowsAgent('cursor',env,run)).command,external)
 assert.equal((await findWindowsAgent('cursor',env,async()=>({stdout:'Authenticate with Cursor',stderr:''}))).command,local)
})
