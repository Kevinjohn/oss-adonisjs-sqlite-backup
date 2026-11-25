import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { createBundle, listBundles, verifyBundle } from './bundles.ts'
import { prepareDirectory } from './directory.ts'
import { E_BACKUP_DISABLED, E_BACKUP_SOURCE } from './errors.ts'
import type { NativeDatabase } from './native.ts'
import { resolveFilesystemPath } from './paths.ts'
import { pruneBundles } from './prune.ts'
import { prepareRestore } from './restore.ts'
import { assertSourceOutsideDirectory, openOwnedSource, resolveSqliteSource } from './source.ts'
import type { BackupConfig, LucidDatabaseConfig } from './types.ts'

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
  #database: LucidDatabaseConfig | undefined

  constructor(
    readonly config: BackupConfig,
    database: LucidDatabaseConfig | undefined
  ) {
    this.#database = database
  }

  #requireBackupDirectory(override?: string): string {
    const directory = override ?? this.config.directory
    if (!directory) throw new E_BACKUP_DISABLED()
    return directory
  }

  /**
   * Live SQLite path, read from Lucid’s connection config on every call.
   *
   * @example
   * ```ts
   * const livePath = backup.livePath()
   * ```
   */
  livePath(): string {
    this.#requireBackupDirectory()
    return resolveSqliteSource(this.#database, this.config.connection)
  }

  /**
   * Fail startup if the configured source cannot be opened, without creating a bundle.
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
      if (cause instanceof E_BACKUP_SOURCE) throw cause
      throw new E_BACKUP_SOURCE(`live database ${path} cannot be read`, {
        cause,
      })
    }
  }

  /**
   * Prepare the root after checking it does not contain the configured live database.
   *
   * @example
   * ```ts
   * backup.prepareDirectory()
   * ```
   */
  prepareDirectory(): void {
    const directory = resolveFilesystemPath(this.#requireBackupDirectory())
    this.#rejectLiveDatabaseInside(directory)
    prepareDirectory(directory)
  }

  /**
   * Copy the live database and publish a verified backup bundle.
   *
   * @example
   * ```ts
   * const bundle = await backup.create()
   * ```
   * @throws AggregateError propagated from bundle creation.
   */
  create(options: { now?: () => number; database?: NativeDatabase } = {}) {
    const directory = this.#requireBackupDirectory()
    const connection = this.config.connection ?? this.#database?.connection
    return createBundle({
      ...(options.database
        ? { source: { database: options.database } }
        : { livePath: this.livePath() }),
      directory,
      migrationsTable: connection
        ? this.#database?.connections[connection]?.migrations?.tableName
        : undefined,
      lockTimeoutMs: this.config.lockTimeoutMs,
      requireWal: this.config.requireWal,
      now: options.now,
    })
  }

  /**
   * List published bundles in creation order, oldest first.
   *
   * @example
   * ```ts
   * const bundles = backup.list()
   * ```
   */
  list(directory?: string) {
    return listBundles(this.#requireBackupDirectory(directory))
  }

  /**
   * Verify a published bundle, defaulting to the newest.
   *
   * @example
   * ```ts
   * const bundle = backup.verify()
   * ```
   */
  verify(name?: string, directory?: string) {
    return verifyBundle(this.#requireBackupDirectory(directory), name)
  }

  /**
   * Stage a verified copy for recovery at an unused path.
   *
   * @example
   * ```ts
   * const staged = backup.prepareRestore({ target: 'storage/recovered.sqlite' })
   * ```
   */
  prepareRestore(input: { target: string; name?: string; directory?: string }) {
    return prepareRestore({
      ...input,
      directory: this.#requireBackupDirectory(input.directory),
      livePath: resolveSqliteSource(this.#database, this.config.connection),
    })
  }

  #rejectLiveDatabaseInside(directory: string): void {
    let livePath: string | undefined
    try {
      livePath = resolveSqliteSource(this.#database, this.config.connection)
    } catch (error) {
      // A service can create backups from borrowed handles without a configured file source.
      if (!(error instanceof InvalidArgumentsException)) throw error
    }
    if (livePath !== undefined) assertSourceOutsideDirectory(livePath, directory)
  }

  /**
   * Remove unfinished bundles and retain the newest published bundles.
   *
   * @example
   * ```ts
   * const result = backup.prune({ keep: 7 })
   * ```
   * @throws AggregateError propagated from bundle pruning.
   */
  prune(options: { keep?: number } = {}) {
    const directory = resolveFilesystemPath(this.#requireBackupDirectory())
    this.#rejectLiveDatabaseInside(directory)
    return pruneBundles({
      directory,
      keep: options.keep ?? this.config.keep,
      lockTimeoutMs: this.config.lockTimeoutMs,
    })
  }
}
