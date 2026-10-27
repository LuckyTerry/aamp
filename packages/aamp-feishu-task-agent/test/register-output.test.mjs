import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'

test('POSIX generated registration writes authorization to fd5 while diagnostics stay in redirected stdout', {skip:process.platform==='win32'}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aamp-register-output-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const sdk=path.join(root,'node_modules','@larksuiteoapi','node-sdk');await mkdir(sdk,{recursive:true})
  await writeFile(path.join(sdk,'package.json'),JSON.stringify({name:'@larksuiteoapi/node-sdk',version:'1.68.0',type:'module',main:'index.js'}))
  await writeFile(path.join(sdk,'index.js'),`export const Domain={Feishu:'feishu'};export async function registerApp(o){o.onQRCodeReady({url:'https://example.test/register?test-code=123',expireIn:180});o.onStatusChange({status:'registered'});return {client_id:'cli_test',client_secret:'secret-sentinel'}};export class Client{constructor(){this.application={application:{get:async()=>({data:{app:{app_name:'Test Bot'}}})}}}}`)
  const bootstrap=await readFile(new URL('../bootstrap/aamp-feishu-task-agent-bootstrap.sh',import.meta.url),'utf8')
  const source=bootstrap.split('# BEGIN GENERATED FEISHU REGISTER HELPER')[1].split("<<'NODE'\n")[1].split('\nNODE\n')[0]
  const script=path.join(root,'register.mjs');await writeFile(script,source)
  // Force the browser launch to fail on macOS too; the user still gets the URL.
  const child=spawn(process.execPath,[script],{env:{...process.env,PATH:'',AAMP_REGISTER_APP_RESULT_FILE:path.join(root,'result.json')},stdio:['ignore','pipe','pipe','ignore','ignore','pipe']})
  let diagnostics='',user='',error='';child.stdout.on('data',c=>diagnostics+=c);child.stderr.on('data',c=>error+=c);child.stdio[5].on('data',c=>user+=c)
  assert.equal(await new Promise(resolve=>child.once('close',resolve)),0,error)
  assert.match(user,/https:\/\/example.test\/register\?test-code=123/)
  assert.match(user,/180/)
  assert.match(diagnostics,/sdk=1.68.0/)
  assert.match(diagnostics,/status: registered/)
  assert.match(diagnostics,/registration completed: cli_test/)
  assert.doesNotMatch(user+diagnostics+error,/secret-sentinel/)
})
