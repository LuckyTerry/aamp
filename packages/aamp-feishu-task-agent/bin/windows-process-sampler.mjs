// One controller-wide, non-overlapping sampler. Registration remains strict;
// periodic observation failures never request shutdown of business processes.
export function createWindowsProcessSampler({snapshot,persist,onState=()=>{},intervalMs=5000,maxDelayMs=60000}) {
  const records=new Set()
  let timer,flight,abort,stopped=false,failures=0,lastSuccess,lastNotice=0
  const report=state=>{try{onState(state)}catch{}}
  const schedule=()=>{
    if(stopped || timer || !records.size)return
    timer=setTimeout(()=>{timer=undefined;void sample()},Math.min(maxDelayMs,intervalMs*2**Math.min(failures,8)))
    timer.unref?.()
  }
  async function register(record){
    if(stopped)throw Error('Windows process tracking is stopping')
    const identity=await record.windowsIdentity
    if(!identity){if(record.exited)return;throw record.windowsIdentityError || Error('Cannot verify Windows process identity')}
    await persist([identity])
    record.windowsDescendants.set(identity.pid,identity)
    if(stopped)throw Error('Windows process tracking is stopping')
    records.add(record);schedule()
  }
  function sample(){
    if(stopped)return Promise.resolve()
    if(flight)return flight
    if(timer){clearTimeout(timer);timer=undefined}
    abort=new AbortController()
    flight=(async()=>{
      let persisted=false;const started=Date.now()
      try{
        const active=[...records].filter(r=>!r.exited)
        const roots=(await Promise.all(active.map(r=>r.windowsIdentity))).filter(Boolean)
        const snapshots=roots.length ? await snapshot(roots,{signal:abort.signal}) : new Map()
        if(stopped)return
        const all=[]
        for(const record of records){
          const root=await record.windowsIdentity
          for(const item of snapshots.get(root.pid)||[]) record.windowsDescendants.set(item.pid,item)
          all.push(...record.windowsDescendants.values())
        }
        await persist(all)
        persisted=true
        lastSuccess=new Date().toISOString()
        if(failures)report({state:'healthy',failures:0,lastSuccess})
        failures=0
      }catch(error){
        if(stopped)return
        failures++
        if(failures===1 || Date.now()-lastNotice>=60000){
          lastNotice=Date.now();report({state:'degraded',failures,lastSuccess,elapsedMs:Date.now()-started,message:String(error.message||error)})
        }
      }finally{
        if(persisted)for(const record of records)if(record.exited)records.delete(record)
      }
    })().finally(()=>{flight=undefined;abort=undefined;schedule()})
    return flight
  }
  return {register,sample,get pending(){return Boolean(timer||flight)},async stop(){
    stopped=true;clearTimeout(timer);timer=undefined
    abort?.abort(new Error('Windows process sampling cancelled'))
    await flight
    records.clear()
  }}
}
