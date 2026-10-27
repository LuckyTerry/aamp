import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { withWindowsOperationLock } from './windows-operation-lock.mjs'

const platform = () => import('./windows-platform.mjs')

function sameIdentity(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.startedAt === right.startedAt
    && left.executablePath.toLowerCase() === right.executablePath.toLowerCase()
    && left.ownerSid.toLowerCase() === right.ownerSid.toLowerCase())
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

async function writeAtomic(file, value, atomicReplace) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await atomicReplace(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}

async function journalFiles(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return entries.filter((entry) => entry.isFile() && /^controller-.*\.json$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

function journalPath(directory, controller) {
  const stamp = encodeURIComponent(controller.startedAt).replace(/%/g, '')
  return path.join(directory, `controller-${controller.pid}-${stamp}.json`)
}

const replaceRecoveryFile = async (source, destination) => process.platform === 'win32'
  ? (await platform()).atomicReplaceWindows(source, destination)
  : fsp.rename(source, destination)

async function withRecoveryLock(file, signal, action) {
  signal?.throwIfAborted()
  return withWindowsOperationLock(`${file}.recovery-lock`, async () => {
    signal?.throwIfAborted()
    return action()
  }, {
    ...(process.platform === 'win32' ? {readIdentity: async pid =>
      (await platform()).readWindowsProcessIdentity(pid, {signal})} : {}),
    wait: async ms => {
      signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, ms))
      signal?.throwIfAborted()
    },
  })
}

// Transfer durable recovery evidence into the service's generation-specific acknowledgement.
// Keep the receipt if persistence fails; never consume it while a journal remains pending.
export async function confirmWindowsProcessRecovery(directory, controller, persist, {signal} = {}) {
  const file = journalPath(directory, controller)
  return withRecoveryLock(file, signal, async () => {
    if (await fsp.stat(file).then(() => true, error => {if(error.code==='ENOENT')return false;throw error})) return false
    const receipt = await readJson(`${file}.recovered`).catch(error => {if(error.code==='ENOENT')return undefined;throw error})
    if (receipt?.version !== 1 || receipt?.state !== 'recovered' || !sameIdentity(receipt.controller, controller)) return false
    signal?.throwIfAborted()
    await persist()
    signal?.throwIfAborted()
    await fsp.rm(`${file}.recovered`, {force:true})
    return true
  })
}

// A missing receipt is not permission to discard a still-pending registered journal.
export async function hasPendingWindowsProcessJournal(directory, controller, {signal} = {}) {
  const file=journalPath(directory,controller)
  return withRecoveryLock(file,signal,()=>fsp.stat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error}))
}

export async function createWindowsProcessJournal(directory, controller, {
  ensurePrivateDirectory = async (target) => (await platform()).ensurePrivateWindowsDirectory(target),
  atomicReplace = async (source, destination) => (await platform()).atomicReplaceWindows(source, destination),
} = {}) {
  await ensurePrivateDirectory(directory)
  const file = journalPath(directory, controller)
  const stopFile = `${file}.stop`
  let state = { version: 1, controller, descendants: [] }
  let tail = Promise.resolve()
  await writeAtomic(file, state, atomicReplace)
  return {
    file,
    stopFile,
    record(identities) {
      tail = tail.catch(() => {}).then(async () => {
        const merged = new Map(state.descendants.map((identity) => [`${identity.pid}:${identity.startedAt}`, identity]))
        for (const identity of identities || []) {
          if (!sameIdentity(identity, controller)) merged.set(`${identity.pid}:${identity.startedAt}`, identity)
        }
        const next = { ...state, descendants: [...merged.values()] }
        if (JSON.stringify(next) === JSON.stringify(state)) return
        await writeAtomic(file, next, atomicReplace)
        state = next
      })
      return tail
    },
    async stopRequested() {
      const request = await readJson(stopFile).catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      return request?.pid === controller.pid && request?.startedAt === controller.startedAt
    },
  }
}

export async function recoverWindowsProcessJournals(directory, {
  readIdentity = async (pid, options) => (await platform()).readWindowsProcessIdentity(pid, options),
  stopTree = async (identity, options) => (await platform()).stopOwnedWindowsTree(identity, options),
  controllerIdentity, signal, atomicReplace = replaceRecoveryFile,
} = {}) {
  let recovered=0
  for (const file of await journalFiles(directory)) {
    recovered += await withRecoveryLock(file, signal, async () => {
      // Another recovery may have finished while this caller was waiting. This is
      // not proof of success: the service must still verify the durable receipt.
      const journal = await readJson(file).catch(error => {if(error.code==='ENOENT')return undefined;throw error})
      if (!journal) return 0
      if (journal.version !== 1 || !journal.controller || !Array.isArray(journal.descendants)) {
        throw new Error(`invalid Windows process journal: ${file}`)
      }
      signal?.throwIfAborted()
      if (controllerIdentity && !sameIdentity(journal.controller,controllerIdentity)) return 0
      const liveController = await readIdentity(journal.controller.pid, {exitedBefore:journal.controller.startedAt,...(signal ? {signal} : {})})
      if (sameIdentity(liveController, journal.controller)) return 0
      for (const identity of [...journal.descendants].reverse()) {
        await stopTree(identity, { allowExitedIdentity: true, ...(signal ? {signal} : {}) })
      }
      signal?.throwIfAborted()
      await writeAtomic(`${file}.recovered`, {version:1,state:'recovered',controller:journal.controller}, atomicReplace)
      signal?.throwIfAborted()
      await fsp.rm(`${file}.stop`, { force: true })
      await fsp.rm(file)
      return 1
    })
  }
  return recovered
}

export async function requestWindowsControllerStop(directory, pid, {
  readIdentity = async (targetPid) => (await platform()).readWindowsProcessIdentity(targetPid),
  atomicReplace = async (source, destination) => (await platform()).atomicReplaceWindows(source, destination),
} = {}) {
  for (const file of await journalFiles(directory)) {
    const journal = await readJson(file)
    if (journal?.controller?.pid !== pid) continue
    const live = await readIdentity(pid)
    if (!sameIdentity(live, journal.controller)) throw new Error(`Windows Controller ${pid} identity changed`)
    await writeAtomic(`${file}.stop`, { pid, startedAt: journal.controller.startedAt }, atomicReplace)
    return true
  }
  return false
}
