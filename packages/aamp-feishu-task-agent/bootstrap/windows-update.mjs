import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);

// SemVer precedence (build metadata is ignored); malformed versions are not comparable.
function compareTaskAgentVersions(left, right) {
  const parse=value=>{
    const match=String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
    if(!match)return null;
    const pre=match[4]?.split('.') || [];
    if(pre.some(id=>/^\d+$/.test(id) && id.length>1 && id[0]==='0'))return null;
    return {core:match.slice(1,4).map(BigInt),pre};
  };
  const a=parse(left),b=parse(right);
  if(!a || !b)return null;
  const compare=(x,y)=>x===y?0:x<y?-1:1;
  for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return compare(a.core[i],b.core[i]);
  if(!a.pre.length || !b.pre.length)return compare(Number(!a.pre.length),Number(!b.pre.length));
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    const x=a.pre[i],y=b.pre[i];
    if(x===undefined || y===undefined)return compare(a.pre.length,b.pre.length);
    if(x===y)continue;
    const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);
    if(nx && ny)return compare(BigInt(x),BigInt(y));
    if(nx!==ny)return nx?-1:1;
    return compare(x,y);
  }
  return 0;
}

export function taskAgentVersionIsNewer(current,latest) {
  return compareTaskAgentVersions(current,latest)===-1;
}

export async function installPreservingService({stage, snapshot, stop, install, resume}) {
  const artifact=await stage(); // All download/validation precedes any interruption.
  const previous=await snapshot();
  if(previous.running && !previous.bindingIds?.length) throw new Error('后台绑定选择缺失，保留当前版本');
  if(previous.running) await stop();
  let failure;
  try { await install(artifact); } catch(error) { failure=error; }
  if(previous.running) {
    try { await resume(previous, !failure); }
    catch(error) { throw new Error(`${failure ? `更新失败：${failure.message}；` : '更新已安装；'}后台恢复失败：${error.message}`,{cause:error}); }
  }
  if(failure)throw failure;
}

export async function runWindowsUpdate(context, injected = {}) {
  const {argv,command,metadata,packageDir,npm,env,runChild,validate}=context;
  const manual=command==='update';
  const noUpdate=()=>{if(manual)console.log(`当前版本：${metadata.version}`);return {handled:manual,code:0};};
  if(command==='__service-run' || env.AAMP_TASK_NON_INTERACTIVE==='true')return noUpdate();
  if((env.AAMP_TASK_AUTO_UPDATE || 'true')!=='true' || env.AAMP_TASK_AUTO_UPDATE_DONE==='true')return noUpdate();
  const cacheFile=env.AAMP_TASK_UPDATE_CACHE_FILE || path.join(os.homedir(),'.aamp','feishu-task-agent','update-cache.json');
  const now=Math.floor(Date.now()/1000);
  const ttl=Number(env.AAMP_TASK_UPDATE_CACHE_TTL_SECONDS || 86400);
  try {
    const cache=JSON.parse(await readFile(cacheFile,'utf8'));
    if(!manual && cache.current_version===metadata.version && cache.checked_at>0 && now-cache.checked_at>=0 && now-cache.checked_at<ttl)return noUpdate();
  } catch {}
  const capture=injected.capture || (async args=>(await exec(npm.command,[...(npm.argsPrefix || []),...args],{env,encoding:'utf8',timeout:60000,windowsHide:true})).stdout.trim());
  const remember=async latest=>{
    try {await mkdir(path.dirname(cacheFile),{recursive:true});await writeFile(cacheFile,JSON.stringify({version:1,checked_at:now,current_version:metadata.version,latest_version:latest}));}catch {}
  };
  let latest;
  try { latest=await capture(['view',`${metadata.name}@${env.AAMP_TASK_AGENT_CHANNEL || 'dev'}`,'version']); }
  catch(error) {console.error(`Task Agent 更新检查失败，继续当前版本：${error.message}`);return noUpdate();}
  if(!taskAgentVersionIsNewer(metadata.version,latest)) {await remember(latest);return noUpdate();}
  let installedDir;
  try {
    const root=await capture(['root','--global']);
    installedDir=path.join(root,...metadata.name.split('/'));
    let installed;
    try {installed=JSON.parse(await readFile(path.join(installedDir,'package.json'),'utf8'));}catch {}
    if(installed?.name===metadata.name && compareTaskAgentVersions(installed.version,latest)===null)throw new Error('已安装版本无法比较，保留当前安装');
    if(installed?.name===metadata.name && !taskAgentVersionIsNewer(installed.version,latest)) {
      await validate(installedDir,metadata.name);
      latest=installed.version;
    } else await (injected.install || installNative)({...context,latest,installedDir});
  }catch(error){ console.error(`Task Agent 更新失败，继续当前版本：${error.message}`);return {handled:manual,code:manual?1:0}; }
  await remember(latest);
  // A fresh Node process loads the installed entry and dependencies after npm replaced them.
  const code=await runChild(process.execPath,[path.join(installedDir,'bin','feishu-task-agent.mjs'),...argv],{...env,AAMP_TASK_AUTO_UPDATE_DONE:'true'});
  return {handled:true,code};
}

async function installNative({metadata,latest,installedDir,packageDir,npm,env,runChild,validate}) {
  const temp=await mkdtemp(path.join(os.tmpdir(),'aamp-windows-update-'));
  const npmRun=async args=>{const code=await runChild(npm.command,[...(npm.argsPrefix || []),...args],env);if(code!==0)throw new Error(`npm ${args[0]} exited ${code}`);};
  const runtimeHome=env.AAMP_TASK_RUNTIME_HOME || path.join(env.AAMP_TASK_STATE_HOME || path.join(os.homedir(),'.aamp','feishu-task-agent'),'runtime-v1');
  // The old manager is used only to inspect/stop; restoration imports from its target in a fresh process.
  const {createWindowsServiceManager}=await import('../bin/windows-service.mjs');
  const manager=createWindowsServiceManager({runtimeHome,environment:env});
  try {
    await installPreservingService({
      stage:async()=>{
        await npmRun(['pack','--ignore-scripts','--pack-destination',temp,`${metadata.name}@${latest}`]);
        const archives=(await readdir(temp)).filter(f=>f.endsWith('.tgz'));
        if(archives.length!==1)throw new Error('更新包数量异常');
        const archive=path.join(temp,archives[0]);
        await npmRun(['install','--ignore-scripts','--no-audit','--no-fund','--prefix',temp,archive]);
        await validate(path.join(temp,'node_modules',...metadata.name.split('/')),metadata.name);
        return archive;
      },
      snapshot:async()=>{
        const status=await manager.status();
        if(status.state==='starting')throw new Error('后台服务正在启动或身份尚未确认，请稍后更新');
        if(status.state!=='running')return {running:false};
        const config=JSON.parse(await readFile(manager.paths.configFile,'utf8'));
        return {running:true,bindingIds:await manager.selection(),controllerPath:config.controllerPath,environment:config.env};
      },
      stop:()=>manager.stop(),
      install:async archive=>{await npmRun(['install','--global',archive]);await validate(installedDir,metadata.name);},
      resume:async(previous,success)=>{
        const dir=success?installedDir:path.dirname(path.dirname(previous.controllerPath));
        const script=`const {createWindowsServiceManager}=await import(${JSON.stringify(pathToFileURL(path.join(dir,'bin','windows-service.mjs')).href)});const m=createWindowsServiceManager({runtimeHome:${JSON.stringify(runtimeHome)},controllerPath:${JSON.stringify(path.join(dir,'bin','feishu-task-agent-controller.mjs'))},workerPath:${JSON.stringify(path.join(dir,'bin','windows-service-worker.mjs'))},environment:process.env});await m.start(${JSON.stringify(previous.bindingIds)});`;
        const code=await runChild(process.execPath,['--input-type=module','-e',script],{...env,...previous.environment,AAMP_TASK_AUTO_UPDATE_DONE:'true',AAMP_TASK_AGENT_VERSION:success?latest:previous.environment.AAMP_TASK_AGENT_VERSION,AAMP_TASK_BOOTSTRAP_PATH:path.join(dir,'bootstrap','aamp-feishu-task-agent-bootstrap.sh')});
        if(code!==0)throw new Error(`service restart exited ${code}`);
      },
    });
  } finally {await rm(temp,{recursive:true,force:true});}
}
