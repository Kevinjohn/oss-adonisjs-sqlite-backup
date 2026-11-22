import { createBundle, listBundles, verifyBundle } from './bundles.js'
import { prepareDirectory } from './directory.js'
import { BackupException } from './errors.js'
import type { NativeDatabase } from './native.js'
import { resolveFilesystemPath } from './paths.js'
import { pruneBundles } from './prune.js'
import { prepareRestore } from './restore.js'
import { assertSourceOutsideDirectory, openOwnedSource, resolveSqliteSource } from './source.js'
import type { BackupConfig, LucidDatabaseConfig } from './types.js'

/** Backup service bound in the container as `sqlite.backup`. */
export class SqliteBackup {
  constructor(
    readonly config: BackupConfig,
    protected database: LucidDatabaseConfig | undefined
  ) {}

  private requireBackupDirectory(override?: string): string {
    const directory = override ?? this.config.directory
    if (!directory) throw new BackupException('E_BACKUP_DISABLED', 'backups are disabled')
    return directory
  }

  /** Live SQLite path, read from Lucid's connection config on every call. */
  livePath(): string {
    this.requireBackupDirectory()
    return resolveSqliteSource(this.database, this.config.connection)
  }

  /** Fail startup if the configured source cannot be opened, without creating a bundle. */
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
      if (cause instanceof BackupException) throw cause
      throw new BackupException('E_BACKUP_SOURCE', `live database ${path} cannot be read`, {
        cause,
      })
    }
  }

  /** Prepare the root after checking it does not contain the configured live database. */
  prepareDirectory(): void {
    const directory = resolveFilesystemPath(this.requireBackupDirectory())
    this.rejectLiveDatabaseInside(directory)
    prepareDirectory(directory)
  }

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

  list(directory?: string) {
    return listBundles(this.requireBackupDirectory(directory))
  }

  verify(name?: string, directory?: string) {
    return verifyBundle(this.requireBackupDirectory(directory), name)
  }

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
      if (!(error instanceof BackupException) || error.code !== 'E_BACKUP_SOURCE') throw error
    }
    if (livePath !== undefined) assertSourceOutsideDirectory(livePath, directory)
  }

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
