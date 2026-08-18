import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const LOCK_FILE_NAME = 'aamp-release.lock'
const QUARANTINE_MARKER = '.quarantine-'
const OWNER_KIND = 'aamp-shared-release-lock'
const OWNER_SCHEMA_VERSION = 1
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ReleaseLockError extends Error {
  constructor(message, { code, lockPath, owner = null, cause } = {}) {
    super(message, { cause })
    this.name = 'ReleaseLockError'
    this.code = code
    this.lockPath = lockPath
    this.owner = owner
  }
}

function canonicalDirectory(directory) {
  return fs.realpathSync(path.resolve(directory))
}

function gitCommonDirectory(repoRoot) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!raw) return null
    return canonicalDirectory(path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw))
  } catch {
    return null
  }
}

export function resolveReleaseLockPath(repoRoot) {
  const canonicalRepoRoot = canonicalDirectory(repoRoot)
  const commonDirectory = gitCommonDirectory(canonicalRepoRoot)
  if (commonDirectory) return path.join(commonDirectory, LOCK_FILE_NAME)
  return path.join(canonicalRepoRoot, '.aamp-npm-release', LOCK_FILE_NAME)
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameOwnerIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.lockPath === right.lockPath
    && left.token === right.token
    && left.pid === right.pid
    && left.hostname === right.hostname
    && left.helper === right.helper
    && left.operation === right.operation
    && left.repoRoot === right.repoRoot
    && left.cwd === right.cwd
    && left.startedAt === right.startedAt
    && left.argv.length === right.argv.length
    && left.argv.every((value, index) => value === right.argv[index])
}

function validateOwner(owner, expectedLockPath) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return 'owner must be a JSON object'
  if (owner.schemaVersion !== OWNER_SCHEMA_VERSION) return `schemaVersion must be ${OWNER_SCHEMA_VERSION}`
  if (owner.kind !== OWNER_KIND) return `kind must be ${OWNER_KIND}`
  if (owner.lockPath !== expectedLockPath) return `lockPath must equal ${expectedLockPath}`
  if (!UUID_PATTERN.test(owner.token || '')) return 'token must be a UUID'
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'pid must be a positive integer'
  if (typeof owner.hostname !== 'string' || !owner.hostname) return 'hostname must be non-empty'
  if (typeof owner.helper !== 'string' || !owner.helper) return 'helper must be non-empty'
  if (typeof owner.operation !== 'string' || !owner.operation) return 'operation must be non-empty'
  if (typeof owner.repoRoot !== 'string' || !path.isAbsolute(owner.repoRoot)) return 'repoRoot must be absolute'
  if (typeof owner.cwd !== 'string' || !path.isAbsolute(owner.cwd)) return 'cwd must be absolute'
  if (!Array.isArray(owner.argv) || owner.argv.some((value) => typeof value !== 'string')) return 'argv must contain only strings'
  if (typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))) return 'startedAt must be an ISO timestamp'
  return null
}

function invalidOwnerError(lockPath, detail, cause, owner = null) {
  return new ReleaseLockError(
    `Invalid release lock owner metadata at ${lockPath}: ${detail}. Refusing automatic recovery.`,
    { code: 'AAMP_RELEASE_LOCK_INVALID', lockPath, owner, cause },
  )
}

function readValidatedLock(filePath, expectedLockPath = filePath, expectedStat = null) {
  let pathStat
  try {
    pathStat = fs.lstatSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw invalidOwnerError(expectedLockPath, `lock file cannot be inspected: ${error.message}`, error)
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw invalidOwnerError(expectedLockPath, 'lock path is not a regular non-symlink file')
  }
  if (expectedStat && !sameFileIdentity(pathStat, expectedStat)) {
    throw invalidOwnerError(expectedLockPath, 'lock file identity changed during validation')
  }

  let descriptor
  let descriptorStat
  let raw
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    descriptorStat = fs.fstatSync(descriptor)
    raw = fs.readFileSync(descriptor, 'utf8')
  } catch (error) {
    throw invalidOwnerError(expectedLockPath, `lock file cannot be opened safely: ${error.message}`, error)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  if (!descriptorStat.isFile() || !sameFileIdentity(pathStat, descriptorStat)) {
    throw invalidOwnerError(expectedLockPath, 'lock file identity changed while it was being read')
  }

  let finalStat
  try {
    finalStat = fs.lstatSync(filePath)
  } catch (error) {
    throw invalidOwnerError(expectedLockPath, `lock file disappeared while it was being read: ${error.message}`, error)
  }
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || !sameFileIdentity(descriptorStat, finalStat)) {
    throw invalidOwnerError(expectedLockPath, 'lock file identity changed after it was read')
  }

  let owner
  try {
    owner = JSON.parse(raw)
  } catch (error) {
    throw invalidOwnerError(expectedLockPath, 'lock file is not valid JSON', error)
  }
  const validationError = validateOwner(owner, expectedLockPath)
  if (validationError) throw invalidOwnerError(expectedLockPath, validationError, undefined, owner)
  return { owner, stat: descriptorStat }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

function formatOwner(owner) {
  return [
    `pid: ${owner.pid}`,
    `hostname: ${owner.hostname}`,
    `helper: ${owner.helper}`,
    `operation: ${owner.operation}`,
    `startedAt: ${owner.startedAt}`,
    `cwd: ${owner.cwd}`,
    `argv: ${owner.argv.join(' ') || '(none)'}`,
  ].map((line) => `  ${line}`).join('\n')
}

function lockedError(lockPath, owner) {
  const remoteSuffix = owner.hostname === os.hostname()
    ? ''
    : ` Owner host ${owner.hostname} is not local, so PID liveness cannot be checked safely.`
  return new ReleaseLockError(
    `Another AAMP release operation is already running.\nlock: ${lockPath}\nowner:\n${formatOwner(owner)}${remoteSuffix}`,
    { code: 'AAMP_RELEASE_LOCKED', lockPath, owner },
  )
}

function quarantinePath(lockPath) {
  return `${lockPath}${QUARANTINE_MARKER}${process.pid}-${crypto.randomUUID()}`
}

function claimLockFile(lockPath, expectedLock) {
  let currentStat
  try {
    currentStat = fs.lstatSync(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw invalidOwnerError(lockPath, `lock file cannot be inspected before cleanup: ${error.message}`, error)
  }
  if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
    throw invalidOwnerError(lockPath, 'lock path is not a regular non-symlink file before cleanup')
  }
  if (!sameFileIdentity(currentStat, expectedLock.stat)) {
    throw invalidOwnerError(lockPath, 'lock file identity changed before cleanup', undefined, expectedLock.owner)
  }

  const claimedPath = quarantinePath(lockPath)
  try {
    fs.renameSync(lockPath, claimedPath)
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes(error.code)) return null
    throw new ReleaseLockError(
      `Could not atomically claim AAMP release lock ${lockPath} for cleanup: ${error.message}`,
      { code: 'AAMP_RELEASE_LOCK_RACE', lockPath, cause: error },
    )
  }
  return { claimedPath, expectedLock }
}

function deleteClaimedFile(claim, lockPath) {
  const claimedLock = readValidatedLock(claim.claimedPath, lockPath, claim.expectedLock.stat)
  if (!claimedLock || !sameOwnerIdentity(claimedLock.owner, claim.expectedLock.owner)) {
    throw invalidOwnerError(
      lockPath,
      'quarantined lock owner changed while it was being claimed',
      undefined,
      claimedLock?.owner || null,
    )
  }

  let finalStat
  try {
    finalStat = fs.lstatSync(claim.claimedPath)
  } catch (error) {
    throw invalidOwnerError(lockPath, `quarantined lock disappeared before deletion: ${error.message}`, error)
  }
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || !sameFileIdentity(finalStat, claimedLock.stat)) {
    throw invalidOwnerError(lockPath, 'quarantined lock identity changed before deletion', undefined, claimedLock.owner)
  }

  try {
    fs.unlinkSync(claim.claimedPath)
  } catch (error) {
    throw invalidOwnerError(lockPath, `quarantined lock could not be unlinked: ${error.message}`, error, claimedLock.owner)
  }
  return true
}

function removeExactOwner(lockPath, expectedLock) {
  const claim = claimLockFile(lockPath, expectedLock)
  if (!claim) return false
  return deleteClaimedFile(claim, lockPath)
}

function installCleanupHandlers(release) {
  const onExit = () => {
    try { release() } catch {}
  }
  process.on('exit', onExit)

  const signalHandlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      try {
        release()
      } finally {
        process.removeListener(signal, handler)
        process.kill(process.pid, signal)
      }
    }
    try {
      process.on(signal, handler)
      signalHandlers.set(signal, handler)
    } catch {
      // Some platforms do not expose every POSIX signal.
    }
  }

  return () => {
    process.removeListener('exit', onExit)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }
}

function createLockFile(lockPath, owner) {
  let descriptor
  let createdStat
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    createdStat = fs.fstatSync(descriptor)
    if (!createdStat.isFile()) throw invalidOwnerError(lockPath, 'new lock descriptor is not a regular file', undefined, owner)
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    return createdStat
  } catch (error) {
    if (createdStat) {
      try {
        const currentStat = fs.lstatSync(lockPath)
        if (currentStat.isFile() && !currentStat.isSymbolicLink() && sameFileIdentity(currentStat, createdStat)) {
          const quarantine = quarantinePath(lockPath)
          fs.renameSync(lockPath, quarantine)
          const quarantineStat = fs.lstatSync(quarantine)
          if (
            quarantineStat.isFile()
            && !quarantineStat.isSymbolicLink()
            && sameFileIdentity(quarantineStat, createdStat)
          ) {
            fs.unlinkSync(quarantine)
          }
        }
      } catch {}
    }
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function acquireReleaseLock({
  repoRoot,
  helper,
  operation,
  argv = process.argv.slice(2),
  handleSignals = true,
} = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required')
  if (typeof helper !== 'string' || !helper) throw new TypeError('helper is required')
  if (typeof operation !== 'string' || !operation) throw new TypeError('operation is required')
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('argv must contain only strings')
  }

  const canonicalRepoRoot = canonicalDirectory(repoRoot)
  const lockPath = resolveReleaseLockPath(canonicalRepoRoot)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const owner = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    kind: OWNER_KIND,
    lockPath,
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    helper,
    operation,
    repoRoot: canonicalRepoRoot,
    cwd: path.resolve(process.cwd()),
    argv: [...argv],
    startedAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const createdStat = createLockFile(lockPath, owner)
      const ownedLock = readValidatedLock(lockPath, lockPath, createdStat)
      if (!ownedLock || !sameOwnerIdentity(ownedLock.owner, owner)) {
        throw invalidOwnerError(lockPath, 'newly acquired lock identity does not match its owner metadata', undefined, owner)
      }

      let released = false
      let uninstallCleanupHandlers = () => {}
      const release = () => {
        if (released) return false
        released = true
        uninstallCleanupHandlers()
        return removeExactOwner(lockPath, ownedLock)
      }
      if (handleSignals) uninstallCleanupHandlers = installCleanupHandlers(release)
      else {
        const onExit = () => {
          try { release() } catch {}
        }
        process.on('exit', onExit)
        uninstallCleanupHandlers = () => process.removeListener('exit', onExit)
      }
      return { lockPath, owner: { ...owner, argv: [...owner.argv] }, release }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    const existingLock = readValidatedLock(lockPath)
    if (!existingLock) continue
    if (existingLock.owner.hostname !== os.hostname() || processExists(existingLock.owner.pid)) {
      throw lockedError(lockPath, existingLock.owner)
    }
    if (!removeExactOwner(lockPath, existingLock)) continue
  }

  const existingLock = readValidatedLock(lockPath)
  if (existingLock) throw lockedError(lockPath, existingLock.owner)
  throw new ReleaseLockError(`Could not acquire AAMP release lock at ${lockPath}`, {
    code: 'AAMP_RELEASE_LOCK_RACE',
    lockPath,
  })
}
