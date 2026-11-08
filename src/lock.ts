import { closeSync, constants, ftruncateSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { BackupException } from './errors.js'
import { internalHooks } from './internal_hooks.js'
import { realPath } from './paths.js'
import { LOCK_FILE } from './names.js'
import { openDatabase, type NativeDatabase } from './native.js'

export interface DirectoryLock {
  release(): void
}

const DAMAGED = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT'])

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
    handle.close()
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
    /* c8 ignore next 3 -- a device node swapped in by someone able to create one */
    if (!fstatSync(fd).isFile()) {
      throw new BackupException('E_BACKUP_UNSAFE', `lock path ${path} is not a regular file`)
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
  const path = join(realPath(directory), LOCK_FILE)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) {
    throw new BackupException('E_BACKUP_UNSAFE', `lock path ${path} is not a regular file`)
  }
  let handle: NativeDatabase
  try {
    handle = tryLock(path, timeoutMs)
  } catch (error) {
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
      released = true
      handle.exec('ROLLBACK')
      handle.close()
    },
  }
}
