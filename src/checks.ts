import { openDatabase, type NativeDatabase } from './native.js'

/** Full `integrity_check` and `foreign_key_check`. Returns the first problem, or null when clean. */
export function readDatabaseIntegrityProblem(path: string): string | null {
  let db: NativeDatabase
  try {
    db = openDatabase(path, { fileMustExist: true, readonly: true })
  } catch (error) {
    return `cannot open: ${String(error)}`
  }
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (rows.length !== 1 || rows[0]!.integrity_check !== 'ok') {
      return `integrity_check: ${rows.map((row) => row.integrity_check).join('; ')}`
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
    if (count > 0) return `foreign_key_check: ${count} violation(s)`
    return null
  } catch (error) {
    return `check failed: ${String(error)}`
  } finally {
    db.close()
  }
}
