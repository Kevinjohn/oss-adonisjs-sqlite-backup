import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertDirectory } from './directory.js'
import { listBundleDirectoryNames } from './bundles.js'
import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
import { resolveFilesystemPath } from './paths.js'
import { syncPath } from './fs.js'
import { internalHooks } from './internal_hooks.js'
import { acquireLock } from './lock.js'
import { READY } from './names.js'
import type { PruneProgress, PruneResult } from './types.js'

function attachProgress(error: unknown, progress: PruneProgress): Error {
  const failure =
    error instanceof Error && Object.isExtensible(error)
      ? error
      : new RuntimeException(String(error), { cause: error })
  return Object.defineProperty(failure, 'pruneProgress', { value: progress })
}

export function pruneKeepProblem(keep: number): string | undefined {
  if (!Number.isInteger(keep) || keep < 1) {
    return `keep must be an integer >= 1 (got ${keep})`
  }
}

/**
 * Keep the newest `keep` READY bundles (newest = latest name; names only increase) and remove the
 * rest. Unfinished bundles (no READY) are removed too: create holds the lock for its whole run, so
 * an unfinished bundle seen under the lock belongs to a create that crashed. Only directories
 * matching the bundle name pattern are ever touched. Per-item failures are returned in the result.
 * If finalization fails, the thrown error carries the observed `pruneProgress`.
 *
 * @example
 * ```ts
 * import { pruneBundles } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const result = pruneBundles({ directory: 'storage/backups', keep: 7 })
 * ```
 */
export function pruneBundles(input: {
  directory: string
  keep: number
  lockTimeoutMs?: number
}): PruneResult {
  const { keep: retainedBundleCount, lockTimeoutMs = 0 } = input
  const directory = resolveFilesystemPath(input.directory)
  const keepProblem = pruneKeepProblem(retainedBundleCount)
  if (keepProblem) throw new InvalidArgumentsException(keepProblem)
  const result: PruneResult = { removed: [], abandoned: [], failed: [] }
  assertDirectory(directory, { requirePrivateRoot: true })
  const lock = acquireLock(directory, lockTimeoutMs)
  let syncingArchive = false
  try {
    const ready: string[] = []
    const unfinished: string[] = []
    for (const name of listBundleDirectoryNames(directory)) {
      const group = existsSync(join(directory, name, READY)) ? ready : unfinished
      group.push(name)
    }
    const remove = (name: string, into: string[]) => {
      const path = join(directory, name)
      try {
        // Unpublish first so a crash mid-removal leaves an unfinished bundle, never a broken READY one.
        if (existsSync(join(path, READY))) {
          unlinkSync(join(path, READY))
          syncPath(path)
        }
        internalHooks.step?.('prune:unpublished', name)
        rmSync(path, { recursive: true, force: true })
        into.push(name)
      } catch (error) {
        result.failed.push({ name, reason: String(error) })
      }
    }
    for (const name of ready.slice(0, Math.max(0, ready.length - retainedBundleCount)))
      remove(name, result.removed)
    for (const name of unfinished) remove(name, result.abandoned)
    if (result.removed.length + result.abandoned.length > 0) {
      syncingArchive = true
      syncPath(directory)
    }
  } catch (cause) {
    const error = syncingArchive
      ? attachProgress(cause, { ...result, archiveSyncFailed: true })
      : cause
    try {
      lock.release()
    } catch (cleanupError) {
      if (error instanceof Error) {
        Object.defineProperty(error, 'resourceCleanupErrors', { value: [cleanupError] })
      } else {
        const combined = new AggregateError([error, cleanupError], 'prune and cleanup failed')
        Object.defineProperty(combined, 'resourceCleanupErrors', { value: [cleanupError] })
        throw combined
      }
    }
    throw error
  }
  try {
    lock.release()
  } catch (error) {
    throw attachProgress(error, { ...result, archiveSyncFailed: false })
  }
  return result
}
