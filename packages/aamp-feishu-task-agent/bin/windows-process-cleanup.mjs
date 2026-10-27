import {stopOwnedWindowsTree} from './windows-platform.mjs'

// The signal reaches each native helper; the deadline is shared across the pass.
export async function cleanupWindowsProcesses(records,{timeoutMs=60000,stopTree=stopOwnedWindowsTree,beforeStop=async()=>{}}={}) {
  const abort=new AbortController(),deadline=Date.now()+timeoutMs,errors=[]
  let timer
  const expired=new Promise(resolve=>{timer=setTimeout(()=>{
    abort.abort(new Error('Windows cleanup deadline exceeded'))
    resolve({ok:false,errors:[...errors,'Windows cleanup deadline exceeded']})
  },timeoutMs)})
  const work=(async()=>{
    await beforeStop(abort.signal)
    const identities=new Map()
    for(const record of records){
      for(const identity of record.windowsDescendants?.values()||[])identities.set(identity.pid+':'+identity.startedAt,identity)
      const root=await record.windowsIdentity
      if(root)identities.set(root.pid+':'+root.startedAt,root)
      else if(!record.exited)errors.push('Cannot verify Windows process identity')
    }
    for(const identity of [...identities.values()].reverse()){
      if(abort.signal.aborted)break
      try{await stopTree(identity,{signal:abort.signal,timeoutMs:Math.max(1,deadline-Date.now()),allowExitedIdentity:true})}
      catch(error){errors.push(String(error.message||error))}
    }
    return {ok:errors.length===0&&!abort.signal.aborted,errors}
  })().catch(error=>({ok:false,errors:[...errors,String(error.message||error)]}))
  try{return await Promise.race([work,expired])}finally{clearTimeout(timer)}
}

export async function withWindowsCleanupDeadline(action,{timeoutMs=75000}={}) {
  const abort=new AbortController(),deadline=Date.now()+timeoutMs
  let timer
  const timeout=new Promise((resolve,reject)=>{timer=setTimeout(()=>{
    const error=new Error('Windows 停止未完成：清理超过总时限')
    abort.abort(error);reject(error)
  },timeoutMs)})
  const context={signal:abort.signal,options(){abort.signal.throwIfAborted();return {signal:abort.signal,timeoutMs:Math.max(1,deadline-Date.now())}}}
  try{return await Promise.race([Promise.resolve().then(()=>action(context)),timeout])}finally{clearTimeout(timer)}
}
