import {appendFileSync,statSync,renameSync,rmSync} from 'node:fs'

// Synchronous only at lifecycle boundaries, including Node's final exit event.
// Two files per role, at most 1 MiB total; no prompts, credentials or environment.
export function appendLifecycleDiagnostic(file, fields, maxBytes=512*1024) {
 try {
  const event={timestamp:new Date().toISOString(),pid:process.pid,ppid:process.ppid}
  for(const key of ['event','generation','childPid','code','signal','attempt','errorCode']) {
   const value=fields[key]
   if(typeof value==='string')event[key]=value.slice(0,160)
   else if(typeof value==='number' || value===null)event[key]=value
  }
  const line=JSON.stringify(event)+'\n'
  if(Buffer.byteLength(line)>maxBytes)return
  let size=0
  try {size=statSync(file).size}catch(error){if(error.code!=='ENOENT')throw error}
  if(size+Buffer.byteLength(line)>maxBytes){rmSync(file+'.1',{force:true});renameSync(file,file+'.1')}
  appendFileSync(file,line,{mode:0o600})
 } catch { /* Diagnostics must not change startup, cleanup or exit behavior. */ }
}
