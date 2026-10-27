import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {appendLifecycleDiagnostic} from '../bin/windows-lifecycle-diagnostics.mjs'
test('diagnostics rotate within a fixed budget and omit arbitrary fields',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'aamp-diagnostics-'))
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 const file=path.join(root,'worker.jsonl')
 for(let i=0;i<40;i++)appendLifecycleDiagnostic(file,{event:'controller.exit',code:i,secret:'excluded'},512)
 assert.ok(statSync(file).size<=512)
 assert.ok(statSync(file+'.1').size<=512)
 const lines=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse)
 assert.equal(lines.at(-1).code,39)
 assert.equal(lines.at(-1).secret,undefined)
 assert.ok(lines.at(-1).timestamp)
})
test('diagnostic failure does not interrupt service lifecycle',()=>{
 assert.doesNotThrow(()=>appendLifecycleDiagnostic('\0',{event:'worker.exit'}))
})
