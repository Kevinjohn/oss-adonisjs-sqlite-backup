import { E_BACKUP_JOURNAL_MISMATCH, E_BACKUP_JOURNAL_UNREADABLE } from './errors.js'
import { openDatabase, type NativeDatabase } from './native.js'
import type { BundleManifest } from './types.js'

function hasMigrationTable(database: NativeDatabase, table: string): boolean {
  return !!database
    .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE")
    .get(table)
}

/** Capture the complete migration journal in its application order. Table names are quoted. */
export function readMigrationRows(
  database: NativeDatabase,
  table: string
): Record<string, unknown>[] | undefined {
  if (!hasMigrationTable(database, table)) return undefined
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
    const table = `main."${expected.table.replaceAll('"', '""')}"`
    let matches = false
    if (hasMigrationTable(database, expected.table)) {
      const { count } = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number
      }
      // Preserve the create-side ordering, including custom journals with tied IDs. Fetch only
      // the final row, not the complete journal; the query still validates the id column when empty.
      const last = database
        .prepare(`SELECT * FROM ${table} ORDER BY id LIMIT 1 OFFSET ?`)
        .get(Math.max(0, count - 1)) as { name?: unknown } | undefined
      matches = count === expected.count && (last?.name ?? null) === expected.last
    }
    if (!matches) {
      throw new E_BACKUP_JOURNAL_MISMATCH(
        `migration journal ${expected.table} does not match manifest`
      )
    }
  } catch (cause) {
    if (cause instanceof E_BACKUP_JOURNAL_MISMATCH) throw cause
    throw new E_BACKUP_JOURNAL_UNREADABLE(`migration journal ${expected.table} cannot be read`, {
      cause,
    })
  } finally {
    database.close()
  }
}
