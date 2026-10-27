import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
test('windowless launcher waits for worker and preserves failure exit status',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'aamp launcher space-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const script=path.join(root,'worker.mjs'), marker=path.join(root,'marker.json')
 await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(23),100);`)
 const launcher=path.resolve(import.meta.dirname,'../bin/windows-service-launcher.vbs')
 const child=spawn('wscript.exe',['//B','//Nologo',launcher,process.execPath,script,marker],{windowsHide:true,stdio:'ignore',timeout:15000})
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 assert.equal(code,23)
 assert.ok(JSON.parse(await readFile(marker,'utf8')).pid>0)
})

test('worker console is hidden and isolated from the launching terminal',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'aamp-hidden-console-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const script=path.join(root,'worker.mjs'),marker=path.join(root,'pid')
 await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>{},10000);`)
 const child=spawn('wscript.exe',['//B','//Nologo',path.resolve(import.meta.dirname,'../bin/windows-service-launcher.vbs'),process.execPath,script,marker],{windowsHide:true,stdio:'ignore',timeout:15000})
 const closed=new Promise(resolve=>child.once('exit',resolve))
 let pid
 for(let i=0;i<50;i++){pid=await readFile(marker,'utf8').catch(()=>null);if(pid)break;await new Promise(resolve=>setTimeout(resolve,100))}
 assert.match(pid || '',/^\d+$/)
 const command=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class ConsoleProbe{[DllImport("kernel32.dll")]public static extern bool FreeConsole();[DllImport("kernel32.dll")]public static extern bool AttachConsole(uint id);[DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();[DllImport("kernel32.dll")]public static extern uint GetConsoleProcessList(uint[] ids,uint count);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hwnd);}';[void][ConsoleProbe]::FreeConsole();if(-not [ConsoleProbe]::AttachConsole(${pid})){throw 'attach failed'};$ids=New-Object uint[] 100;$count=[ConsoleProbe]::GetConsoleProcessList($ids,100);$visible=[ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow());[void][ConsoleProbe]::FreeConsole();@{visible=$visible;pids=@($ids | Select-Object -First $count)}|ConvertTo-Json -Compress`
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:8000})
 const state=JSON.parse(stdout.trim())
 assert.equal(state.visible,false)
 assert.ok(!state.pids.includes(process.pid))
 assert.equal(await closed,0)
})
