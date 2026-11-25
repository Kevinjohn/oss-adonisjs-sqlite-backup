import { createBundle, listBundles, verifyBundle } from './bundles.ts'
import { prepareDirectory } from './directory.ts'
import { acquireLock } from './lock.ts'
import { pruneBundles } from './prune.ts'
import { prepareRestore } from './restore.ts'
import type { CreateBundleOptions } from './types.ts'

/**
 * Standalone operations for a directory of SQLite backup bundles.
 *
 * @example
 * ```ts
 * import { BackupArchive } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const archive = new BackupArchive('storage/backups')
 * archive.prepareDirectory()
 * const bundle = await archive.create({ livePath: 'storage/orchard.sqlite' })
 * ```
 */
export class BackupArchive {
  constructor(readonly directory: string) {}

  /**
   * Create the archive directory or tighten its permissions to 0700.
   *
   * @example
   * ```ts
   * archive.prepareDirectory()
   * ```
   */
  prepareDirectory(): void {
    prepareDirectory(this.directory)
  }

  /**
   * Copy a file-backed source or a borrowed native handle and publish a verified bundle.
   *
   * @example
   * ```ts
   * const bundle = await archive.create({ livePath: 'storage/orchard.sqlite' })
   * ```
   * @throws AggregateError propagated from bundle creation.
   */
  create(options: CreateBundleOptions) {
    return createBundle({ ...options, directory: this.directory })
  }

  /**
   * List published bundles oldest first.
   *
   * @example
   * ```ts
   * const bundles = archive.list()
   * ```
   */
  list() {
    return listBundles(this.directory)
  }

  /**
   * Verify a published bundle, defaulting to the newest.
   *
   * @example
   * ```ts
   * const bundle = archive.verify()
   * ```
   */
  verify(name?: string) {
    return verifyBundle(this.directory, name)
  }

  /**
   * Stage a verified copy at an unused target, keeping the live database in place.
   *
   * @example
   * ```ts
   * const staged = archive.prepareRestore({
   *   livePath: 'storage/orchard.sqlite',
   *   target: 'storage/recovered.sqlite',
   * })
   * ```
   */
  prepareRestore(options: { target: string; livePath: string; name?: string }) {
    return prepareRestore({ ...options, directory: this.directory })
  }

  /**
   * Remove unfinished bundles and retain the newest published bundles.
   * The caller must choose an archive that does not contain a live database.
   *
   * @example
   * ```ts
   * const result = archive.prune({ keep: 7 })
   * ```
   * @throws AggregateError propagated from bundle pruning.
   */
  prune(options: { keep: number; lockTimeoutMs?: number }) {
    return pruneBundles({ ...options, directory: this.directory })
  }

  /**
   * Acquire the archive lock. The caller must provide an existing private local directory and
   * keep the returned lock referenced until release.
   *
   * @example
   * ```ts
   * const lock = archive.acquireLock(250)
   * try {
   *   await performArchiveMaintenance()
   * } finally {
   *   lock.release()
   * }
   * ```
   * @throws AggregateError propagated from lock acquisition.
   */
  acquireLock(timeoutMs = 0) {
    return acquireLock(this.directory, timeoutMs)
  }
}
