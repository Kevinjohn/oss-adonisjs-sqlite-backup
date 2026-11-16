import { closeSync, constants, ftruncateSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { BackupException } from './errors.js'
import { internalHooks } from './internal_hooks.js'
import { realPath } from './paths.js'
import { LOCK_FILE } from './names.js'
import { openDatabase, type NativeDatabase } from './native.js'

export interface DirectoryLock {
  release(): void
}

const DAMAGED = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT'])
export const MAX_LOCK_TIMEOUT_MS = 2_147_483_647

export function validateLockTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `backup lockTimeoutMs must be an integer between 0 and ${MAX_LOCK_TIMEOUT_MS}`
    )
  }
}

function tryLock(path: string, timeoutMs: number): NativeDatabase {
  let handle: NativeDatabase
  try {
    handle = openDatabase(path, { timeout: timeoutMs })
  } catch (cause) {
    throw new BackupException('E_BACKUP_UNSAFE', `cannot open lock file ${path}`, { cause })
  }
  try {
    handle.exec('BEGIN EXCLUSIVE')
    return handle
  } catch (error) {
    try {
      handle.close()
    } catch (closeError) {
      if (error instanceof Error) {
        Object.defineProperty(error, 'resourceCleanupErrors', { value: [closeError] })
      } else {
        throw new AggregateError([error, closeError], 'lock acquisition and close failed')
      }
    }
    throw error
  }
}

/** Empty a damaged lock file without following a symlink swapped in after the lstat check. */
function truncateLockFile(path: string): void {
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    throw new BackupException('E_BACKUP_UNSAFE', `lock path ${path} is not a regular file`, {
      cause,
    })
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new BackupException(
        'E_BACKUP_UNSAFE',
        `lock path ${path} must be a singly linked regular file`
      )
    }
    ftruncateSync(fd, 0)
  } finally {
    closeSync(fd)
  }
}

/**
 * Take the cooperative directory lock. It is an exclusive SQLite transaction on a lock file, so
 * the OS drops it when the holder dies: no PID files, no stale-lock takeover, no PID-reuse hazard.
 * Local filesystems only (POSIX advisory locks are unreliable over NFS). Keep the returned object
 * referenced until `release()`: a garbage-collected handle is closed, which releases the lock.
 *
 * The lock file never holds data, so a damaged (non-empty, non-SQLite) one is truncated and the
 * lock retried. That is safe: nobody can hold a lock on a damaged file, and truncating the empty
 * file another process has just locked changes nothing.
 */
export function acquireLock(directory: string, timeoutMs = 0): DirectoryLock {
  validateLockTimeout(timeoutMs)
  const path = join(realPath(directory), LOCK_FILE)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) {
    throw new BackupException('E_BACKUP_UNSAFE', `lock path ${path} is not a regular file`)
  }
  let handle: NativeDatabase
  try {
    handle = tryLock(path, timeoutMs)
  } catch (error) {
    if (error instanceof Error && 'resourceCleanupErrors' in error) throw error
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_BUSY') {
      throw new BackupException('E_BACKUP_LOCKED', `backup directory ${directory} is locked`, {
        cause: error,
      })
    }
    if (!code || !DAMAGED.has(code)) throw error
    internalHooks.step?.('lock:damaged', path)
    truncateLockFile(path)
    return acquireLock(directory, timeoutMs)
  }
  let released = false
  return {
    release() {
      if (released) return
      let rollbackError: unknown
      let rollbackFailed = false
      try {
        handle.exec('ROLLBACK')
      } catch (error) {
        rollbackError = error
        rollbackFailed = true
      }
      let closeError: unknown
      let closeFailed = false
      try {
        handle.close()
        released = true
      } catch (error) {
        closeError = error
        closeFailed = true
      }
      if (rollbackFailed && closeFailed) {
        if (rollbackError instanceof Error) {
          Object.defineProperty(rollbackError, 'resourceCleanupErrors', { value: [closeError] })
          throw rollbackError
        }
        throw new AggregateError([rollbackError, closeError], 'lock release failed')
      }
      if (rollbackFailed) throw rollbackError
      if (closeFailed) throw closeError
    },
  }
}

/** Wait for a create lock without blocking the event loop needed by an in-process backup. */
export async function acquireCreateLock(directory: string, timeoutMs = 0): Promise<DirectoryLock> {
  validateLockTimeout(timeoutMs)
  const deadline = performance.now() + timeoutMs
  while (true) {
    try {
      return acquireLock(directory)
    } catch (error) {
      if (!(error instanceof BackupException) || error.code !== 'E_BACKUP_LOCKED') throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw error
      await delay(Math.min(remaining, 10))
    }
  }
}
