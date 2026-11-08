import { createBundle, listBundles, verifyBundle } from './bundles.js'
import { prepareDirectory } from './directory.js'
import { BackupException } from './errors.js'
import { openDatabase, type NativeDatabase } from './native.js'
import { pruneBundles } from './prune.js'
import { prepareRestore } from './restore.js'
import { resolveSqliteSource } from './source.js'
import type { BackupConfig, LucidDatabaseConfig } from './types.js'

/** Backup service bound in the container as `sqlite.backup`. */
export class SqliteBackup {
  constructor(
    readonly config: BackupConfig,
    protected database: LucidDatabaseConfig | undefined
  ) {}

  private directory(override?: string): string {
    const directory = override ?? this.config.directory
    if (!directory) throw new BackupException('E_BACKUP_DISABLED', 'backups are disabled')
    return directory
  }

  /** Live SQLite path, read from Lucid's connection config on every call. */
  livePath(): string {
    this.directory()
    return resolveSqliteSource(this.database, this.config.connection)
  }

  /** Fail startup if the configured source cannot be opened, without creating a bundle. */
  checkSource(): void {
    const path = this.livePath()
    try {
      const source = openDatabase(path, { fileMustExist: true, readonly: true })
      try {
        source.pragma('schema_version')
      } finally {
        source.close()
      }
    } catch (cause) {
      throw new BackupException('E_BACKUP_SOURCE', `live database ${path} cannot be read`, {
        cause,
      })
    }
  }

  prepareDirectory(): void {
    prepareDirectory(this.directory())
  }

  create(options: { now?: () => number; database?: NativeDatabase } = {}) {
    const directory = this.directory()
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
    return listBundles(this.directory(directory))
  }

  verify(name?: string, directory?: string) {
    return verifyBundle(this.directory(directory), name)
  }

  prepareRestore(input: { target: string; name?: string; directory?: string }) {
    return prepareRestore({
      ...input,
      directory: this.directory(input.directory),
      livePath: resolveSqliteSource(this.database, this.config.connection),
    })
  }

  prune(options: { keep?: number } = {}) {
    return pruneBundles({
      directory: this.directory(),
      keep: options.keep ?? this.config.keep,
      lockTimeoutMs: this.config.lockTimeoutMs,
    })
  }
}
