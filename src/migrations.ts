import { BackupException } from './errors.js'
import { openDatabase, type NativeDatabase } from './native.js'
import type { BundleManifest } from './types.js'

/** Capture the complete migration journal in its application order. Table names are quoted. */
export function migrationRows(
  database: NativeDatabase,
  table: string
): Record<string, unknown>[] | undefined {
  if (
    !database
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE")
      .get(table)
  )
    return undefined
  return database
    .prepare(`SELECT * FROM main."${table.replaceAll('"', '""')}" ORDER BY id`)
    .safeIntegers(true)
    .all() as Record<string, unknown>[]
}

/** Verify the journal metadata retained in a format-1 manifest. */
export function assertMigrations(
  path: string,
  expected: NonNullable<BundleManifest['migrations']>
): void {
  const database = openDatabase(path, { fileMustExist: true, readonly: true })
  try {
    const rows = migrationRows(database, expected.table)
    if (!rows || rows.length !== expected.count || (rows.at(-1)?.name ?? null) !== expected.last) {
      throw new BackupException(
        'E_BACKUP_INVALID',
        `migration journal ${expected.table} does not match manifest`
      )
    }
  } catch (cause) {
    if (cause instanceof BackupException) throw cause
    throw new BackupException(
      'E_BACKUP_INVALID',
      `migration journal ${expected.table} cannot be read`,
      { cause }
    )
  } finally {
    database.close()
  }
}
