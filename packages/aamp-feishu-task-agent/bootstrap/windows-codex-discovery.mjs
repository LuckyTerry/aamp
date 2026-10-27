import {readdir,stat} from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {taskAgentVersionIsNewer} from './windows-update.mjs'

const execute=promisify(execFile)

export async function findUserCodexCli(env, {
  probe=async file=>(await execute(file,['--version'],{
    env,windowsHide:true,timeout:5000,maxBuffer:16384,encoding:'utf8',
  })).stdout,
}={}) {
  const localAppData=Object.entries(env).find(([key])=>key.toLowerCase()==='localappdata')?.[1]
  if(!localAppData || !path.isAbsolute(localAppData))return ''
  const root=path.join(localAppData,'OpenAI','Codex','bin')
  const entries=await readdir(root,{withFileTypes:true}).catch(()=>[])
  let selected='',selectedVersion=''
  // Inspect only the known user CLI layout, never a desktop launcher or WindowsApps.
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!entry.isDirectory())continue
    const candidate=path.join(root,entry.name,'codex.exe')
    try {
      if(!(await stat(candidate)).isFile())continue
      const output=await probe(candidate)
      const version=String(output).trim().match(/^codex-cli (\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?)$/)?.[1]
      if(version && (!selected || taskAgentVersionIsNewer(selectedVersion,version))) {
        selected=candidate;selectedVersion=version
      }
    } catch { /* A missing, inaccessible, or unresponsive candidate is unavailable. */ }
  }
  return selected
}
