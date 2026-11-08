import { openDatabase, type NativeDatabase } from './native.js'

/** Full `integrity_check` and `foreign_key_check`. Returns the first problem, or null when clean. */
export function checkDatabase(path: string): string | null {
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
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) return `foreign_key_check: ${violations.length} violation(s)`
    return null
  } catch (error) {
    return `check failed: ${String(error)}`
  } finally {
    db.close()
  }
}
