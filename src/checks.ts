import {
  E_BACKUP_FOREIGN_KEYS,
  E_BACKUP_INVALID,
  E_BACKUP_VALIDATION_OPEN,
  E_BACKUP_VALIDATION_QUERY,
} from './errors.js'
import { openDatabase, type NativeDatabase } from './native.js'

/**
 * Run SQLite's full integrity and foreign key checks.
 *
 * @throws A verification exception with the first failed check or the underlying driver error.
 */
export function assertDatabaseIntegrity(path: string, label: string): void {
  let db: NativeDatabase
  try {
    db = openDatabase(path, { fileMustExist: true, readonly: true })
  } catch (error) {
    throw new E_BACKUP_VALIDATION_OPEN(`${label}: cannot open: ${String(error)}`, { cause: error })
  }
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (rows.length !== 1 || rows[0]!.integrity_check !== 'ok') {
      throw new E_BACKUP_INVALID(
        `${label}: integrity_check: ${rows.map((row) => row.integrity_check).join('; ')}`
      )
    }
    // This is a package-owned better-sqlite3 handle. Iterate the pragma directly rather than
    // retaining all diagnostic rows (or resolving a table-valued function by name).
    const statement = db.prepare('PRAGMA foreign_key_check') as ReturnType<
      NativeDatabase['prepare']
    > & {
      iterate(): Iterable<unknown>
    }
    let count = 0
    for (const violation of statement.iterate()) {
      void violation
      count++
    }
    if (count > 0)
      throw new E_BACKUP_FOREIGN_KEYS(`${label}: foreign_key_check: ${count} violation(s)`)
  } catch (error) {
    if (error instanceof E_BACKUP_INVALID || error instanceof E_BACKUP_FOREIGN_KEYS) throw error
    throw new E_BACKUP_VALIDATION_QUERY(`${label}: check failed: ${String(error)}`, {
      cause: error,
    })
  } finally {
    db.close()
  }
}
