import { statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { E_BACKUP_SOURCE, E_BACKUP_UNSAFE } from './errors.js'
import { openDatabase, type NativeDatabase } from './native.js'
import { resolveFilesystemPath } from './paths.js'
import type { LucidDatabaseConfig } from './types.js'

const SQLITE_CLIENTS = new Set(['better-sqlite3', 'sqlite3', 'sqlite'])

/** Match better-sqlite3's constructor before interpreting a configured filename. */
export function normalizeConfiguredSqliteFilename(filename: string, client: string): string {
  return client === 'better-sqlite3' ? filename.trim() : filename
}

/** Open a resolved, owned source only when the native driver will use that exact file path. */
export function openOwnedSource(path: string): NativeDatabase {
  if (normalizeConfiguredSqliteFilename(path, 'better-sqlite3') !== path) {
    throw new E_BACKUP_SOURCE(
      `live database ${JSON.stringify(path)} cannot be read: better-sqlite3 changes its filename when opening it`
    )
  }
  return openDatabase(path, { fileMustExist: true, readonly: true })
}

/**
 * Resolve the live SQLite file from Lucid's `config/database.ts`, as SQLite itself would.
 *
 * @example
 * ```ts
 * import { resolveSqliteSource } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const livePath = resolveSqliteSource({
 *   connection: 'orchard',
 *   connections: {
 *     orchard: { client: 'better-sqlite3', connection: { filename: 'storage/orchard.sqlite' } },
 *   },
 * })
 * ```
 */
export function resolveSqliteSource(
  database: LucidDatabaseConfig | undefined,
  connectionName?: string
): string {
  const name = connectionName ?? database?.connection
  const node = name ? database?.connections?.[name] : undefined
  if (!name || !node) {
    throw new E_BACKUP_SOURCE(`Lucid connection "${name}" is not configured`)
  }
  if (!SQLITE_CLIENTS.has(node.client)) {
    throw new E_BACKUP_SOURCE(`connection "${name}" uses ${node.client}`)
  }
  const configuredFilename = (node.connection as { filename?: unknown } | undefined)?.filename
  if (typeof configuredFilename !== 'string') {
    throw new E_BACKUP_SOURCE(`connection "${name}" is not file-backed`)
  }
  const filename = normalizeConfiguredSqliteFilename(configuredFilename, node.client)
  if (filename === '' || filename === ':memory:') {
    throw new E_BACKUP_SOURCE(`connection "${name}" is not file-backed`)
  }
  if (/^file:/i.test(filename)) {
    throw new E_BACKUP_SOURCE(`connection "${name}" uses a URI filename`)
  }
  return resolveFilesystemPath(filename)
}

/** True when `child` is `parent` or below it (both already real paths). */
export function isWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return (
    relativePath === '' ||
    !(relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
  )
}

/**
 * The live database must be an existing regular file, and the backup directory must not contain
 * it. Both arguments must already be `resolveFilesystemPath` results, so symlinks cannot hide the overlap.
 */
export function assertSafeLayout(livePath: string, directory: string): void {
  const stat = statSync(livePath, { throwIfNoEntry: false })
  if (!stat?.isFile()) {
    throw new E_BACKUP_SOURCE(`live database ${livePath} is not an existing file`)
  }
  assertSourceOutsideDirectory(livePath, directory)
}

/** Reject a backup directory containing the configured live path. Both paths are canonical. */
export function assertSourceOutsideDirectory(livePath: string, directory: string): void {
  if (isWithin(directory, livePath)) {
    throw new E_BACKUP_UNSAFE(`backup directory ${directory} contains the live database`)
  }
}

/** Discover a borrowed handle's main file without changing its settings or ownership. */
export function requireBorrowedSourcePath(database: NativeDatabase): string {
  try {
    const files = database.pragma('database_list') as Array<{ name: string; file: string }>
    const filename = files.find((entry) => entry.name === 'main')?.file
    if (!filename || /^file:/i.test(filename))
      throw new E_BACKUP_SOURCE('source must be a file-backed SQLite database')
    return resolveFilesystemPath(filename)
  } catch (cause) {
    throw new E_BACKUP_SOURCE('borrowed database cannot be read', { cause })
  }
}
