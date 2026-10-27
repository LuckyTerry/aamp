import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
// These suites execute retained POSIX Bootstrap/launchd behavior. Windows counterparts are windows-helper/profile/entry/service.
const posixBootstrap=new Set(['bootstrap.test.mjs','aime-one-click.test.mjs','trae-one-click.test.mjs','traecode-one-click.test.mjs','workbuddy-one-click.test.mjs','workbuddy-ai-one-click.test.mjs','launchd-service.test.mjs']);
const files=(await readdir(path.join(root,'test'))).filter(file=>file.endsWith('.test.mjs')).sort();
const excluded=process.platform==='win32'?files.filter(file=>posixBootstrap.has(file)):[];
const selected=files.filter(file=>!excluded.includes(file));
if(!selected.length) throw new Error('No tests selected');
console.log(JSON.stringify({platform:process.platform,executed:selected,excluded:excluded.map(file=>({file,reason:file==='launchd-service.test.mjs' ? 'macOS launchd backend; Windows counterpart is windows-service' : 'POSIX Bootstrap; Windows equivalents run in windows-entry/helper/profile suites'}))},null,2));
const env={...process.env};
if(process.platform==='win32') {
  const keys=Object.keys(env).filter(key=>key.toLowerCase()==='path');
  const value=keys.map(key=>env[key]).filter(Boolean).join(';');
  for(const key of keys) delete env[key];
  env.Path=[...new Set(value.split(';').filter(p=>p && !/[\\/](?:git[\\/](?:usr|mingw\d*|bin)|msys\d*|cygwin\d*)[\\/]?/i.test(p)))].join(';');
}
const child=spawn(process.execPath,['--test','--test-concurrency=1',...selected.map(file=>path.join('test',file))],{cwd:root,env,stdio:'inherit',shell:false});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('close',code=>{process.exitCode=code ?? 1;});
