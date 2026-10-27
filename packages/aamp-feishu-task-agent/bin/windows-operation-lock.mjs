import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readWindowsProcessIdentity } from './windows-platform.mjs'

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))
async function defaultIdentity(pid) {
  if (process.platform === 'win32') return readWindowsProcessIdentity(pid)
  // Host-side tests never reclaim a live PID without a Windows identity.
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return undefined
    throw error
  }
  return {
    pid,
    startedAt: 'unknown',
    executablePath: process.execPath,
    ownerSid: String(process.getuid?.()),
  }
}
function validIdentity(identity) {
  return (
    Number.isSafeInteger(identity?.pid) &&
    identity.pid > 0 &&
    ['startedAt', 'executablePath', 'ownerSid'].every(
      (key) => typeof identity[key] === 'string' && identity[key],
    )
  )
}
function sameIdentity(left, right) {
  return ['pid', 'startedAt', 'executablePath', 'ownerSid'].every(
    (key) => left[key] === right[key],
  )
}
async function readOwner(directory) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(directory, 'owner.json'), 'utf8'),
    )
  } catch {
    return undefined
  }
}

export async function withWindowsOperationLock(
  directory,
  operation,
  { readIdentity = defaultIdentity, wait = pause, attempts = 1200 } = {},
) {
  await fs.mkdir(path.dirname(directory), { recursive: true })
  const identity = await readIdentity(process.pid)
  if (!validIdentity(identity))
    throw new Error('Cannot verify operation lock owner identity')
  const token = randomUUID()
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(directory)
      try {
        await fs.writeFile(
          path.join(directory, 'owner.json'),
          JSON.stringify({ version: 1, token, identity }),
          { flag: 'wx', mode: 0o600 },
        )
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await readOwner(directory)
      if (
        owner?.version === 1 &&
        owner.token &&
        validIdentity(owner.identity) &&
        owner.identity.ownerSid === identity.ownerSid
      ) {
        const live = await readIdentity(owner.identity.pid)
        if (
          !live ||
          (validIdentity(live) && !sameIdentity(owner.identity, live))
        ) {
          // Only one contender may reclaim this exact generation. Unknown owners are never deleted.
          const reclaim = path.join(directory, 'reclaim')
          try {
            await fs.mkdir(reclaim)
            if ((await readOwner(directory))?.token === owner.token) {
              const retired = `${directory}.retired-${randomUUID()}`
              await fs.rename(directory, retired)
              await fs.rm(retired, { recursive: true, force: true })
              continue
            }
          } catch (error) {
            if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error
          }
        }
      }
      if (attempt >= attempts)
        throw new Error(
          'Timed out waiting for operation lock; unknown owners require manual inspection',
        )
      await wait(50)
    }
  }
  try {
    return await operation()
  } finally {
    if ((await readOwner(directory))?.token === token)
      await fs.rm(directory, { recursive: true, force: true })
  }
}
