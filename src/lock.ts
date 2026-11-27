import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { closeSync, constants, ftruncateSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { E_BACKUP_LOCKED, E_BACKUP_UNSAFE } from './errors.ts'
import { InternalHooks } from './internal_hooks.ts'
import { resolveFilesystemPath } from './paths.ts'
import { LOCK_FILE } from './names.ts'
import { openDatabase } from './native.ts'
import type { DirectoryLock, NativeDatabase } from './types.ts'

export type { DirectoryLock }

const DAMAGED = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT'])
export const MAX_LOCK_TIMEOUT_MS = 2_147_483_647

class LocalLockRegistry {
  static #handlesByPath = new Map<string, WeakRef<NativeDatabase>>()

  static isHeld(path: string): boolean {
    return Boolean(this.#handlesByPath.get(path)?.deref()?.inTransaction)
  }

  static register(path: string, handle: NativeDatabase): WeakRef<NativeDatabase> {
    const reference = new WeakRef(handle)
    this.#handlesByPath.set(path, reference)
    return reference
  }

  static unregister(path: string, reference: WeakRef<NativeDatabase>): void {
    if (this.#handlesByPath.get(path) === reference) {
      this.#handlesByPath.delete(path)
    }
  }
}

export function assertLockTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new InvalidArgumentsException(
      `backup lockTimeoutMs must be an integer between 0 and ${MAX_LOCK_TIMEOUT_MS}`
    )
  }
}

/**
 * @throws AggregateError when exclusive acquisition throws a non-Error value and closing also fails.
 */
function acquireNativeLock(path: string, timeoutMs: number): NativeDatabase {
  let handle: NativeDatabase
  try {
    handle = openDatabase(path, { timeout: timeoutMs })
  } catch (cause) {
    throw new E_BACKUP_UNSAFE(`cannot open lock file ${path}`, { cause })
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
        const failure = new AggregateError(
          [error, closeError],
          'lock acquisition and close failed',
          {
            cause: error,
          }
        )
        Object.defineProperty(failure, 'resourceCleanupErrors', { value: [closeError] })
        throw failure
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
    throw new E_BACKUP_UNSAFE(`lock path ${path} is not a regular file`, {
      cause,
    })
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new E_BACKUP_UNSAFE(`lock path ${path} must be a singly linked regular file`)
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
 * @throws AggregateError propagated from native lock acquisition.
 */
export function acquireLock(directory: string, timeoutMs = 0): DirectoryLock {
  assertLockTimeout(timeoutMs)
  const path = join(resolveFilesystemPath(directory), LOCK_FILE)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) {
    throw new E_BACKUP_UNSAFE(`lock path ${path} is not a regular file`)
  }
  let handle: NativeDatabase
  try {
    // A holder on this event loop cannot make progress while SQLite waits synchronously.
    const wait = LocalLockRegistry.isHeld(path) ? 0 : timeoutMs
    handle = acquireNativeLock(path, wait)
  } catch (error) {
    if (error instanceof Error && 'resourceCleanupErrors' in error) throw error
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_BUSY') {
      throw new E_BACKUP_LOCKED(`backup directory ${directory} is locked`, {
        cause: error,
      })
    }
    if (!code || !DAMAGED.has(code)) throw error
    InternalHooks.step?.('lock:damaged', path)
    truncateLockFile(path)
    return acquireLock(directory, timeoutMs)
  }
  const reference = LocalLockRegistry.register(path, handle)
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
        LocalLockRegistry.unregister(path, reference)
      } catch (error) {
        closeError = error
        closeFailed = true
      }
      if (rollbackFailed && closeFailed) {
        if (rollbackError instanceof Error) {
          Object.defineProperty(rollbackError, 'resourceCleanupErrors', { value: [closeError] })
          throw rollbackError
        }
        const failures = [rollbackError, closeError]
        const combined = new AggregateError(failures, 'lock release failed')
        Object.defineProperty(combined, 'resourceCleanupErrors', { value: failures })
        throw combined
      }
      if (rollbackFailed) throw rollbackError
      if (closeFailed) throw closeError
    },
  }
}

/**
 * Wait for a create lock without blocking the event loop needed by an in-process backup.
 *
 * @throws AggregateError propagated from lock acquisition.
 */
export async function acquireCreateLock(directory: string, timeoutMs = 0): Promise<DirectoryLock> {
  assertLockTimeout(timeoutMs)
  const deadline = performance.now() + timeoutMs
  while (true) {
    try {
      return acquireLock(directory)
    } catch (error) {
      if (!(error instanceof E_BACKUP_LOCKED)) throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw error
      await delay(Math.min(remaining, 10))
    }
  }
}
