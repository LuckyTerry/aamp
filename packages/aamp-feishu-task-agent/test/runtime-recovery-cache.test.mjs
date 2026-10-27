import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {recoverPackageCache} from '../bin/runtime-recovery-cache.mjs'

const exec=promisify(execFile)
const spec='fixture@1.0.0'
const hash=createHash('sha256').update(spec).digest('hex').slice(0,32)
async function fixture(t) {
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'aamp-generations-'))
 t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}))
 const root=path.join(cacheDir,'_aamp-recovery-v2',hash)
 return {cacheDir,root,reference:path.join(root,'current.json')}
}
const missing=()=>Object.assign(new Error('missing entry'),{code:'MISSING'})

test('healthy generation is reused; damaged published generation is preserved and replaced',async t=>{
 const f=await fixture(t);let builds=0;const broken=new Set()
 const options={...f,packageSpec:spec,isDamaged:e=>e.code==='MISSING',onRecovery:async()=>{builds++},
  prepare:async dir=>{if(broken.has(dir))throw missing();return dir}}
 const first=await recoverPackageCache(options)
 assert.equal(await recoverPackageCache(options),first);assert.equal(builds,1)
 broken.add(first)
 const second=await recoverPackageCache(options)
 assert.notEqual(second,first);assert.equal(builds,2);assert.ok(await fs.stat(first))
 assert.equal(JSON.parse(await fs.readFile(f.reference)).generation,path.basename(second))
})

test('failed fresh validation does not publish and removes only its own generation',async t=>{
 const f=await fixture(t);let dir
 await assert.rejects(recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>true,
  onRecovery:async d=>{dir=d},prepare:async()=>{throw new Error('health check failed')}}),/health check failed/)
 assert.equal(await fs.stat(f.reference).then(()=>true,()=>false),false)
 assert.equal(await fs.stat(dir).then(()=>true,()=>false),false)
})

test('timeout leaves unpublished files until process cleanup is known complete',async t=>{
 const f=await fixture(t);let dir
 await assert.rejects(recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>true,
  onRecovery:async d=>{dir=d},prepare:async()=>{throw new Error('health check timed out')}}),/timed out/)
 assert.ok(await fs.stat(dir));assert.equal(await fs.stat(f.reference).then(()=>true,()=>false),false)
})

test('unrelated failure from saved cache does not rebuild or change its reference',async t=>{
 const f=await fixture(t)
 await recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>false,onRecovery:async()=>{},prepare:async dir=>dir})
 const previous=await fs.readFile(f.reference,'utf8')
 await assert.rejects(recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>false,
  onRecovery:async()=>assert.fail('must not rebuild'),prepare:async()=>{throw new Error('authentication required')}}),/authentication/)
 assert.equal(await fs.readFile(f.reference,'utf8'),previous)
})

test('reference cannot select an external cache directory',async t=>{
 const f=await fixture(t);await fs.mkdir(f.root,{recursive:true})
 await fs.writeFile(f.reference,JSON.stringify({version:1,packageSpec:spec,generation:'../../outside'}))
 const dir=await recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>false,onRecovery:async()=>{},prepare:async dir=>dir})
 assert.equal(path.dirname(dir),f.root)
})

test('independent processes share one published rebuild',async t=>{
 const f=await fixture(t)
 const script=`
 import fs from 'node:fs/promises';
 import {recoverPackageCache} from ${JSON.stringify(new URL('../bin/runtime-recovery-cache.mjs',import.meta.url).href)};
 const cacheDir=process.argv[1];
 const result=await recoverPackageCache({cacheDir,packageSpec:'fixture@1.0.0',isDamaged:()=>false,
  onRecovery:async()=>{await fs.appendFile(cacheDir+'/builds.txt','build\\n');await new Promise(r=>setTimeout(r,300))},
  prepare:async dir=>dir});
 console.log(result);
 `
 const [a,b]=await Promise.all([1,2].map(()=>exec(process.execPath,['--input-type=module','-e',script,f.cacheDir],{timeout:30000})))
 assert.equal(a.stdout.trim(),b.stdout.trim());assert.equal(await fs.readFile(path.join(f.cacheDir,'builds.txt'),'utf8'),'build\n')
})

test('controller cancellation interrupts waiting on a live cache owner',async t=>{
 const f=await fixture(t);let release,entered
 const held=new Promise(resolve=>{release=resolve})
 const ready=new Promise(resolve=>{entered=resolve})
 const first=recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>false,onRecovery:async()=>{},
  prepare:async dir=>{entered();await held;return dir}})
 await ready
 let checks=0
 try {
  await assert.rejects(recoverPackageCache({...f,packageSpec:spec,isDamaged:()=>false,
   onRecovery:async()=>assert.fail('must not rebuild'),prepare:async()=>assert.fail('must not acquire lock'),
   checkCancelled:()=>{if(++checks>=2)throw new Error('controller cancelled')},
  }),/controller cancelled/)
  assert.ok(await fs.stat(path.join(f.root,'.lock')))
 } finally {release();await first}
})
