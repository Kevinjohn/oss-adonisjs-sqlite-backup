/** Options accepted by `defineConfig` in `config/backup.ts`. */
export interface BackupConfigInput {
  /** Lucid connection to back up. Defaults to the primary connection (`database.connection`). */
  connection?: string
  /** Directory holding the bundles. Must not contain the live database. */
  directory?: string
  /** READY bundles kept by `prune` (the `--keep` flag overrides it). Default 7. */
  keep?: number
  /** Milliseconds to wait for the directory lock before `E_BACKUP_LOCKED`. Default 0. */
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
  /** Bundles that could not be removed, with the reason. Prune never throws for these. */
  failed: Array<{ name: string; reason: string }>
}
