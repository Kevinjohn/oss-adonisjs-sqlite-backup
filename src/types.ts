/** The native driver operations this package uses. */
export interface NativeDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    safeIntegers(enabled?: boolean): { all(...params: unknown[]): unknown[] }
  }
  pragma(sql: string, options?: { simple?: boolean }): unknown
  backup(path: string, options?: { progress?: (info: unknown) => number }): Promise<unknown>
  close(): void
  readonly inTransaction: boolean
}

/** The stable code for each expected backup failure. */
export type BackupErrorCode =
  | 'E_BACKUP_LOCKED'
  | 'E_BACKUP_SOURCE'
  | 'E_BACKUP_INVALID'
  | 'E_BACKUP_WRITE'
  | 'E_BACKUP_UNSAFE'
  | 'E_BACKUP_NOT_FOUND'
  | 'E_BACKUP_DISABLED'

export interface DirectoryLock {
  /**
   * Release the directory lock after the protected operation finishes.
   *
   * @example
   * ```ts
   * lock.release()
   * ```
   * @throws AggregateError when rollback throws a non-Error value and closing the handle also fails.
   */
  release(): void
}

/** Options accepted by `defineConfig` in `config/backup.ts`. */
export interface BackupConfigInput {
  /** Lucid connection to back up. Defaults to the primary connection (`database.connection`). */
  connection?: string
  /** Directory holding the bundles. Must not contain the live database. */
  directory?: string
  /** READY bundles kept by `prune` (the `--keep` flag overrides it). Default 7. */
  keep?: number
  /** Directory-lock wait before `E_BACKUP_LOCKED`: integer milliseconds 0–2,147,483,647. Default 0. */
  lockTimeoutMs?: number
  /** Refuse non-WAL sources instead of warning. Default false. */
  requireWal?: boolean
}

/** Config after defaults are applied. */
export interface BackupConfig {
  connection?: string
  directory: string
  keep: number
  lockTimeoutMs: number
  requireWal: boolean
}

/** The part of Lucid's `config/database.ts` the package reads. */
export interface LucidDatabaseConfig {
  connection: string
  connections: Record<
    string,
    { client: string; connection?: unknown; migrations?: { tableName?: string } }
  >
}

/** Content of `manifest.json` inside each bundle. */
export interface BundleManifest {
  format: 1
  createdAt: string
  bytes: number
  sha256: string
  sourceJournalMode: string
  migrations?: { table: string; count: number; last: string | null }
}

/** A published (READY) bundle. */
export interface BundleLocation {
  name: string
  path: string
}

/** A READY bundle with its manifest creation time. */
export interface BundleSummary extends BundleLocation {
  createdAt: string
}

/** Standalone copy options for a path or a borrowed native SQLite handle. */
export type CreateBundleOptions = (
  { livePath: string; source?: never } | { source: { database: NativeDatabase }; livePath?: never }
) & {
  migrationsTable?: string
  lockTimeoutMs?: number
  requireWal?: boolean
  now?: () => number
}

/** Result of `create`. */
export interface CreateResult extends BundleSummary {
  manifest: BundleManifest
  warnings: string[]
}

/** Result of `prune`. */
export interface PruneResult {
  /** READY bundles removed beyond `keep`, oldest first. */
  removed: string[]
  /** Unfinished bundles (no READY) removed; only possible while holding the lock. */
  abandoned: string[]
  /** Bundles that could not be removed, with the reason. These do not cause prune to throw. */
  failed: Array<{ name: string; reason: string }>
}

/** Observations attached as `pruneProgress` to a prune finalization error. */
export interface PruneProgress extends PruneResult {
  /** The final archive sync failed, so removal durability is unconfirmed. */
  archiveSyncFailed: boolean
}
