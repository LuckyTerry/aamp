import {mkdir, readFile, writeFile, rename, stat} from 'node:fs/promises'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {withWindowsOperationLock} from '../bin/windows-operation-lock.mjs'

async function moveInstallation(source, destination) {
  // Windows scanners can briefly keep just-installed package files open.
  for (let attempt=0;;attempt++) {
    try {return await rename(source,destination)} catch(error) {
      if (!['EPERM','EBUSY','EACCES'].includes(error.code) || attempt>=20) throw error
      await new Promise(resolve=>setTimeout(resolve,250))
    }
  }
}

// Publish only complete installations. An interrupted npm install must never
// become the executable used by ACP, or be mistaken for a reusable npx cache.
export async function ensureCodexAdapter({root, spec, install, lock = withWindowsOperationLock}) {
  const match=/^(@[^/\s]+\/[^@/\s]+|[^@/\s]+)(?:@[^\s]+)?$/.exec(spec)
  if (!match) throw new Error('Codex ACP package must be an npm package name or name@version')
  const name=match[1]
  const directory=path.join(path.resolve(root),createHash('sha256').update(spec).digest('hex').slice(0,16))
  async function entryAt(base) {
    const manifest=JSON.parse(await readFile(path.join(base,'package.json'),'utf8'))
    if (!manifest || typeof manifest !== 'object') throw Error('missing installation manifest')
    const packageDirectory=path.join(base,'node_modules',name)
    const pkg=JSON.parse(await readFile(path.join(packageDirectory,'package.json'),'utf8'))
    const bin=typeof pkg.bin==='string'?pkg.bin:Object.values(pkg.bin || {})[0]
    if (typeof bin!=='string') throw Error('missing adapter entry')
    const entry=path.resolve(packageDirectory,bin)
    if (!entry.startsWith(packageDirectory+path.sep) || !(await stat(entry)).isFile()) throw Error('invalid adapter entry')
    return entry
  }
  return lock(`${directory}.lock`,async()=>{
    try {
      if ((await readFile(path.join(directory,'.aamp-complete'),'utf8'))===spec) return await entryAt(directory)
    } catch {}
    const stage=`${directory}.install-${randomUUID()}`
    await mkdir(stage,{recursive:true})
    try {
      await install(stage)
      await entryAt(stage)
      await writeFile(path.join(stage,'.aamp-complete'),spec)
      try {await moveInstallation(directory,`${directory}.incomplete-${randomUUID()}`)} catch(error) {if(error.code!=='ENOENT') throw error}
      await moveInstallation(stage,directory)
      return await entryAt(directory)
    } catch(error) {
      throw new Error(`Codex ACP 安装或自动重建失败：${error.message}`,{cause:error})
    }
  },{attempts:6000})
}
