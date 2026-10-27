import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {withWindowsOperationLock} from './windows-operation-lock.mjs'

// The existing operation lock also has a conservative POSIX PID-liveness path.
// Never replace a published tree: a different Bridge may still be using it.
export async function recoverPackageCache({cacheDir,packageSpec,prepare,isDamaged,onRecovery,signal,checkCancelled=()=>{}}) {
  const check=()=>{signal?.throwIfAborted();checkCancelled()}
  check()
  const hash=createHash('sha256').update(packageSpec).digest('hex')
  // Keep paths short enough for Windows npm .cmd shims. Reference metadata
  // still verifies the complete package spec before any generation is reused.
  const root=path.resolve(cacheDir,'_aamp-recovery-v2',hash.slice(0,32))
  const reference=path.join(root,'current.json')
  await fs.mkdir(root,{recursive:true})
  return withWindowsOperationLock(path.join(root,'.lock'),async()=>{
    check()
    let saved
    try {saved=JSON.parse(await fs.readFile(reference,'utf8'))}
    catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error}
    const candidates=[]
    if(saved?.version===1 && saved.packageSpec===packageSpec && /^g-[0-9a-f]{32}$/.test(saved.generation||''))
      candidates.push(path.join(root,saved.generation))
    candidates.push(path.resolve(cacheDir,'_aamp-recovery-v1',hash))
    for(const candidate of candidates) {
      check()
      if(!await fs.stat(candidate).then(s=>s.isDirectory(),error=>{if(error.code==='ENOENT')return false;throw error}))continue
      try {return await prepare(candidate)}
      catch(error){if(!isDamaged(error,candidate))throw error}
    }
    check()
    const generation='g-'+randomUUID().replaceAll('-','')
    const directory=path.join(root,generation)
    await fs.mkdir(directory)
    const temporary=path.join(root,`current-${randomUUID()}.tmp`)
    try {
      await onRecovery(directory)
      const value=await prepare(directory)
      check()
      await fs.writeFile(temporary,JSON.stringify({version:1,packageSpec,generation})+'\n',{flag:'wx',mode:0o600})
      await fs.rename(temporary,reference)
      return value
    } catch(error) {
      // Timed-out/cancelled probes can still own handles while their controller
      // performs verified cleanup. Leave their unpublished tree intact.
      if(!signal?.aborted && !/timeout|timed out|超时|cancel|abort|停止/i.test(String(error.code||'')+' '+String(error.message||''))) {
        const actual=await fs.realpath(directory)
        const parent=await fs.realpath(root)
        if(path.dirname(actual)===parent && path.basename(actual)===generation)
          await fs.rm(actual,{recursive:true,force:true})
      }
      throw error
    } finally {await fs.rm(temporary,{force:true})}
  },{wait:async ms=>{
    check()
    await new Promise(resolve=>setTimeout(resolve,ms))
    check()
  }})
}
