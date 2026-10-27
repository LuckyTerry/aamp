import {taskCommand} from '../bin/platform-hints.mjs'
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const commands = new Set(['install','start','status','stop','restart','logs','list','add','remove','update','help','__service-run']);
const packageDir = fileURLToPath(new URL('../', import.meta.url));

export function parseWindowsArguments(argv, entry = 'short') {
  const args = [...argv];
  if (args[0] === 'normal') args.shift();
  const result = {command:args.length === 0 && entry === 'long' ? 'install' : 'help',foreground:false,agent:'',host:'https://meshmail.ai',debug:false};
  if (commands.has(args[0])) result.command = args.shift();
  else if (args.length && !['-h','--help'].includes(args[0])) result.command = 'install';
  while (args.length) {
    const flag=args.shift();
    if (flag === '--foreground') result.foreground=true;
    else if (flag === '--no-start') result.noStart=true;
    else if (flag === '--debug') result.debug=true;
    else if (flag === '--help' || flag === '-h') result.command='help';
    else if (flag === '--agent' || flag === '--aamp-host') {
      const value=args.shift();
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      result[flag === '--agent' ? 'agent' : 'host']=value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return result;
}

async function runChild(command,args,env) {
  const child=spawn(command,args,{env,stdio:'inherit',shell:false});
  // In an inherited Windows console Ctrl+C already reaches the Controller.
  // child.kill('SIGINT') would terminate it before its cleanup can finish.
  const onInterrupt=()=>{};
  process.on('SIGINT',onInterrupt);
  try {
    return await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code)=>resolve(code ?? 1));
    });
  } finally { process.off('SIGINT',onInterrupt); }
}

export async function validateWindowsUpdatePackage(directory, expectedName) {
  const metadata=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  if (metadata.name!==expectedName || metadata.bin?.['feishu-task-agent']!=='bin/feishu-task-agent.mjs') throw new Error('该发布包不支持 Windows 原生入口，保留当前版本');
  for (const file of ['bin/feishu-task-agent.mjs','bin/windows-service-worker.mjs','bootstrap/windows-entry.mjs','bootstrap/windows-helper.mjs','bootstrap/task-agent-defaults.json']) {
    try {await access(path.join(directory,file));}
    catch {throw new Error(`该发布包缺少 Windows 运行文件：${file}，保留当前版本`);}
  }
}

export function windowsEntryKind(argv1 = '', env = process.env) {
  if (env.AAMP_TASK_ENTRY) return env.AAMP_TASK_ENTRY;
  return /^aamp-feishu-task-agent(?:\.(?:cmd|ps1|mjs))?$/i.test(path.win32.basename(argv1)) ? 'long' : 'short';
}

export function windowsNpmEnvironment(source = process.env) {
  const registry=source.AAMP_TASK_NPM_REGISTRY || source.NPM_REGISTRY || 'https://registry.npmjs.org/';
  const cache=source.AAMP_TASK_NPM_CACHE_DIR || source.NPM_CONFIG_CACHE || source.npm_config_cache || path.join(os.tmpdir(),'aamp-one-click-npm-cache');
  const env={...source,AAMP_TASK_NPM_REGISTRY:registry,AAMP_TASK_NPM_CACHE_DIR:cache,
    npm_config_registry:registry,NPM_CONFIG_REGISTRY:registry,npm_config_cache:cache,NPM_CONFIG_CACHE:cache};
  const prefix=source.AAMP_TASK_NPM_GLOBAL_PREFIX || source.NPM_GLOBAL_PREFIX || source.npm_config_prefix || source.NPM_CONFIG_PREFIX;
  if(prefix) Object.assign(env,{AAMP_TASK_NPM_GLOBAL_PREFIX:prefix,NPM_GLOBAL_PREFIX:prefix,npm_config_prefix:prefix,NPM_CONFIG_PREFIX:prefix});
  return env;
}

export async function runWindowsEntry(argv) {
  const options=parseWindowsArguments(argv,windowsEntryKind(process.argv[1]));
  if (options.command === 'help') {
    console.log(`${taskCommand('', 'win32')} <install|start|status|stop|restart|logs|list|add|remove|update>\n  --agent <name>  --aamp-host <url>  --foreground  --debug  --no-start`);
    return;
  }
  if (['install','add','remove'].includes(options.command) && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(`交互操作需要终端，请在 PowerShell 直接执行 ${taskCommand(options.command, 'win32')}`);
  }
  const defaults=JSON.parse(readFileSync(new URL('./task-agent-defaults.json',import.meta.url),'utf8'));
  const metadata=JSON.parse(readFileSync(path.join(packageDir,'package.json'),'utf8'));
  const {resolveNativeCommand}=await import('../bin/windows-platform.mjs');
  const npm=await resolveNativeCommand('npm',process.env);
  if (!npm) throw new Error('npm is unavailable; install Node.js with npm first');
  const env={...windowsNpmEnvironment(process.env),
    // Match the macOS launcher: only --agent may bypass interactive selection.
    AAMP_TASK_DEFAULT_AGENT:options.agent,
    AAMP_TASK_NO_START:String(options.noStart || process.env.AAMP_TASK_NO_START === 'true'),
    AAMP_TASK_AAMP_HOST:options.host,
    AAMP_TASK_FOREGROUND:String(options.foreground || process.env.AAMP_TASK_FOREGROUND === 'true'),
    AAMP_TASK_DEBUG_MODE:String(options.debug || process.env.AAMP_TASK_DEBUG_MODE === 'true'),
    AAMP_TASK_AGENT_VERSION:metadata.version,
    AAMP_TASK_NPM_BIN:npm.command,
    AAMP_TASK_NPM_ARGS_PREFIX:JSON.stringify(npm.argsPrefix || []),
    AAMP_TASK_BOOTSTRAP_PATH:path.join(packageDir,'bootstrap','aamp-feishu-task-agent-bootstrap.sh'),
    AAMP_TASK_CODEX_ACP_PKG:process.env.CODEX_ACP_PKG || defaults.packages.codexAcp,
    AAMP_LARK_CLI_CONFIG_DIR:process.env.AAMP_LARK_CLI_CONFIG_DIR || process.env.LARKSUITE_CLI_CONFIG_DIR || path.join(os.homedir(),defaults.larkCli.configDirName),
  };
  for (const [key,fallback,alias] of [
    ['AAMP_TASK_ACP_BRIDGE_PKG',defaults.packages.acpBridge,'ACP_BRIDGE_PKG'],
    ['AAMP_TASK_FEISHU_BRIDGE_PKG',defaults.packages.feishuBridge,'FEISHU_BRIDGE_PKG'],
    ['AAMP_TASK_AIME_ACP_PKG',defaults.packages.aimeAcp,'AIME_ACP_PKG'],
  ]) {
    env[key]=env.AAMP_TASK_ALLOW_PACKAGE_OVERRIDES === 'true' ? env[alias] || env[key] || fallback : fallback;
  }
  const controller=path.join(packageDir,'bin','feishu-task-agent-controller.mjs');
  // Resolve and perform updates before constructing any service/controller runtime.
  if (options.command !== '__service-run') {
    const {runWindowsUpdate}=await import('./windows-update.mjs');
    const outcome=await runWindowsUpdate({argv,command:options.command,metadata,packageDir,npm,env,runChild,validate:validateWindowsUpdatePackage});
    if(outcome.handled) { process.exitCode=outcome.code; return; }
  }
  process.exitCode=await runChild(process.execPath,[controller,options.command],env);
}
