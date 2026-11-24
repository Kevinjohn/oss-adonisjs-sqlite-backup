import { createBundle, listBundles, verifyBundle } from './bundles.js'
import { prepareDirectory } from './directory.js'
import {
  E_BACKUP_DISABLED,
  E_BACKUP_SOURCE,
  E_BACKUP_SOURCE_CLIENT,
  E_BACKUP_SOURCE_CONNECTION,
  E_BACKUP_SOURCE_DRIVER_PATH,
  E_BACKUP_SOURCE_NOT_FILE_BACKED,
  E_BACKUP_SOURCE_URI,
} from './errors.js'
import type { NativeDatabase } from './native.js'
import { resolveFilesystemPath } from './paths.js'
import { pruneBundles } from './prune.js'
import { prepareRestore } from './restore.js'
import { assertSourceOutsideDirectory, openOwnedSource, resolveSqliteSource } from './source.js'
import type { BackupConfig, LucidDatabaseConfig } from './types.js'

/**
 * Backup service bound in the container as `sqlite.backup`.
 *
 * @example
 * ```ts
 * import { defineConfig, SqliteBackup } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const backup = new SqliteBackup(defineConfig({ directory: 'storage/backups' }), {
 *   connection: 'orchard',
 *   connections: {
 *     orchard: { client: 'better-sqlite3', connection: { filename: 'storage/orchard.sqlite' } },
 *   },
 * })
 * backup.checkSource()
 * backup.prepareDirectory()
 * const bundle = await backup.create()
 * ```
 */
export class SqliteBackup {
  constructor(
    readonly config: BackupConfig,
    protected database: LucidDatabaseConfig | undefined
  ) {}

  private requireBackupDirectory(override?: string): string {
    const directory = override ?? this.config.directory
    if (!directory) throw new E_BACKUP_DISABLED()
    return directory
  }

  /**
   * Live SQLite path, read from Lucid’s connection config on every call.
   *
   * @throws `E_BACKUP_DISABLED` or a configured source resolution error.
   *
   * @example
   * ```ts
   * const livePath = backup.livePath()
   * ```
   */
  livePath(): string {
    this.requireBackupDirectory()
    return resolveSqliteSource(this.database, this.config.connection)
  }

  /**
   * Fail startup if the configured source cannot be opened, without creating a bundle.
   *
   * @throws `E_BACKUP_DISABLED`, a source resolution error, or an error reading the source.
   *
   * @example
   * ```ts
   * backup.checkSource()
   * ```
   */
  checkSource(): void {
    const path = this.livePath()
    try {
      const source = openOwnedSource(path)
      try {
        source.pragma('schema_version')
      } finally {
        source.close()
      }
    } catch (cause) {
      if (cause instanceof E_BACKUP_SOURCE_DRIVER_PATH) throw cause
      throw new E_BACKUP_SOURCE(`live database ${path} cannot be read`, {
        cause,
      })
    }
  }

  /**
   * Prepare the root after checking it does not contain the configured live database.
   *
   * @throws `E_BACKUP_DISABLED`, an unsafe layout or a filesystem error preparing the root.
   *
   * @example
   * ```ts
   * backup.prepareDirectory()
   * ```
   */
  prepareDirectory(): void {
    const directory = resolveFilesystemPath(this.requireBackupDirectory())
    this.rejectLiveDatabaseInside(directory)
    prepareDirectory(directory)
  }

  /**
   * Copy the live database and publish a verified backup bundle.
   *
   * @throws `AggregateError` when lock acquisition or copy fails with a non-Error and cleanup also fails, with the primary failure first.
   * @throws Configuration, source, archive, verification and native errors from creating the bundle.
   *
   * @example
   * ```ts
   * const bundle = await backup.create()
   * ```
   */
  create(options: { now?: () => number; database?: NativeDatabase } = {}) {
    const directory = this.requireBackupDirectory()
    const connection = this.config.connection ?? this.database?.connection
    return createBundle({
      ...(options.database
        ? { source: { database: options.database } }
        : { livePath: this.livePath() }),
      directory,
      migrationsTable: connection
        ? this.database?.connections[connection]?.migrations?.tableName
        : undefined,
      lockTimeoutMs: this.config.lockTimeoutMs,
      requireWal: this.config.requireWal,
      now: options.now,
    })
  }

  /**
   * List published bundles in creation order, oldest first.
   *
   * @throws `E_BACKUP_DISABLED` or an archive path or manifest error.
   *
   * @example
   * ```ts
   * const bundles = backup.list()
   * ```
   */
  list(directory?: string) {
    return listBundles(this.requireBackupDirectory(directory))
  }

  /**
   * Verify a published bundle, defaulting to the newest.
   *
   * @throws `E_BACKUP_DISABLED` or a bundle lookup or verification error.
   *
   * @example
   * ```ts
   * const bundle = backup.verify()
   * ```
   */
  verify(name?: string, directory?: string) {
    return verifyBundle(this.requireBackupDirectory(directory), name)
  }

  /**
   * Stage a verified copy for recovery at an unused path.
   *
   * @throws `E_BACKUP_DISABLED` or a source, target, copy or bundle verification error.
   *
   * @example
   * ```ts
   * const staged = backup.prepareRestore({ target: 'storage/recovered.sqlite' })
   * ```
   */
  prepareRestore(input: { target: string; name?: string; directory?: string }) {
    return prepareRestore({
      ...input,
      directory: this.requireBackupDirectory(input.directory),
      livePath: resolveSqliteSource(this.database, this.config.connection),
    })
  }

  private rejectLiveDatabaseInside(directory: string): void {
    let livePath: string | undefined
    try {
      livePath = resolveSqliteSource(this.database, this.config.connection)
    } catch (error) {
      // A service can create backups from borrowed handles without a configured file source.
      if (!(
        error instanceof E_BACKUP_SOURCE_CONNECTION ||
        error instanceof E_BACKUP_SOURCE_CLIENT ||
        error instanceof E_BACKUP_SOURCE_NOT_FILE_BACKED ||
        error instanceof E_BACKUP_SOURCE_URI
      ))
        throw error
    }
    if (livePath !== undefined) assertSourceOutsideDirectory(livePath, directory)
  }

  /**
   * Remove unfinished bundles and retain the newest published bundles.
   *
   * @throws `AggregateError` when lock acquisition or prune work fails with a non-Error and cleanup also fails, with the primary failure first.
   * @throws Configuration, archive and finalization errors from pruning.
   *
   * @example
   * ```ts
   * const result = backup.prune({ keep: 7 })
   * ```
   */
  prune(options: { keep?: number } = {}) {
    const directory = resolveFilesystemPath(this.requireBackupDirectory())
    this.rejectLiveDatabaseInside(directory)
    return pruneBundles({
      directory,
      keep: options.keep ?? this.config.keep,
      lockTimeoutMs: this.config.lockTimeoutMs,
    })
  }
}
