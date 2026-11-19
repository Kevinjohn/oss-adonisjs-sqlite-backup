import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertDirectory } from './directory.js'
import { listBundleDirectoryNames } from './bundles.js'
import { BackupException } from './errors.js'
import { resolveFilesystemPath } from './paths.js'
import { syncPath } from './fs.js'
import { internalHooks } from './internal_hooks.js'
import { acquireLock } from './lock.js'
import { READY } from './names.js'
import type { PruneResult } from './types.js'

/**
 * Keep the newest `keep` READY bundles (newest = latest name; names only increase) and remove the
 * rest. Unfinished bundles (no READY) are removed too: create holds the lock for its whole run, so
 * an unfinished bundle seen under the lock belongs to a create that crashed. Only directories
 * matching the bundle name pattern are ever touched. Removal failures are reported, not thrown.
 */
export function pruneBundles(input: {
  directory: string
  keep: number
  lockTimeoutMs?: number
}): PruneResult {
  const { keep: retainedBundleCount, lockTimeoutMs = 0 } = input
  const directory = resolveFilesystemPath(input.directory)
  if (!Number.isInteger(retainedBundleCount) || retainedBundleCount < 1) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `keep must be an integer >= 1 (got ${retainedBundleCount})`
    )
  }
  const result: PruneResult = { removed: [], abandoned: [], failed: [] }
  assertDirectory(directory, { requirePrivateRoot: true })
  const lock = acquireLock(directory, lockTimeoutMs)
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
    if (result.removed.length + result.abandoned.length > 0) syncPath(directory)
  } catch (error) {
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
  lock.release()
  return result
}
