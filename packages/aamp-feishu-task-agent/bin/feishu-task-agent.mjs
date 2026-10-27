#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

try {
  if (process.platform === 'win32') {
    const {runWindowsEntry}=await import('../bootstrap/windows-entry.mjs');
    await runWindowsEntry(process.argv.slice(2));
  } else {
    const bootstrap=fileURLToPath(new URL('../bootstrap/aamp-feishu-task-agent-bootstrap.sh',import.meta.url));
    const env={...process.env};
    if (path.basename(process.argv[1] || '') === 'feishu-task-agent') env.AAMP_TASK_ENTRY='short';
    const child=spawn('bash',[bootstrap,...process.argv.slice(2)],{stdio:'inherit',env});
    const handlers=new Map();
    for (const signal of ['SIGINT','SIGTERM','SIGHUP']) {
      const handler=()=>child.kill(signal);
      handlers.set(signal,handler);
      process.on(signal,handler);
    }
    await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>{
        for (const [name,handler] of handlers) process.off(name,handler);
        process.exitCode=code ?? (signal === 'SIGINT' ? 130 : 1);
        resolve();
      });
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
