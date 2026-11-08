import { statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { BackupException } from './errors.js'
import type { NativeDatabase } from './native.js'
import { realPath } from './paths.js'
import type { LucidDatabaseConfig } from './types.js'

const SQLITE_CLIENTS = new Set(['better-sqlite3', 'sqlite3', 'sqlite'])

/** Resolve the live SQLite file from Lucid's `config/database.ts`, as SQLite itself would. */
export function resolveSqliteSource(
  database: LucidDatabaseConfig | undefined,
  connectionName?: string
): string {
  const name = connectionName ?? database?.connection
  const node = name ? database?.connections?.[name] : undefined
  if (!name || !node) {
    throw new BackupException('E_BACKUP_SOURCE', `Lucid connection "${name}" is not configured`)
  }
  if (!SQLITE_CLIENTS.has(node.client)) {
    throw new BackupException('E_BACKUP_SOURCE', `connection "${name}" uses ${node.client}`)
  }
  const filename = (node.connection as { filename?: unknown } | undefined)?.filename
  if (typeof filename !== 'string' || filename === '' || filename === ':memory:') {
    throw new BackupException('E_BACKUP_SOURCE', `connection "${name}" is not file-backed`)
  }
  if (/^file:/i.test(filename)) {
    throw new BackupException('E_BACKUP_SOURCE', `connection "${name}" uses a URI filename`)
  }
  return realPath(filename)
}

/** True when `child` is `parent` or below it (both already real paths). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

/**
 * The live database must be an existing regular file, and the backup directory must not contain
 * it. Both arguments must already be `realPath` results, so symlinks cannot hide the overlap.
 */
export function assertSafeLayout(livePath: string, directory: string): void {
  const stat = statSync(livePath, { throwIfNoEntry: false })
  if (!stat?.isFile()) {
    throw new BackupException(
      'E_BACKUP_SOURCE',
      `live database ${livePath} is not an existing file`
    )
  }
  if (isWithin(directory, livePath)) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `backup directory ${directory} contains the live database`
    )
  }
}

/** Discover a borrowed handle's main file without changing its settings or ownership. */
export function borrowedSourcePath(database: NativeDatabase): string {
  try {
    const files = database.pragma('database_list') as Array<{ name: string; file: string }>
    const filename = files.find((entry) => entry.name === 'main')?.file
    if (!filename || /^file:/i.test(filename))
      throw new Error('source must be a file-backed SQLite database')
    return realPath(filename)
  } catch (cause) {
    throw new BackupException('E_BACKUP_SOURCE', 'borrowed database cannot be read', { cause })
  }
}
