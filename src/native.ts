// better-sqlite3 13 publishes no declarations; the surface this package consumes is typed here.
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'

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

/** Open a native SQLite handle. */
export function openDatabase(
  path: string,
  options?: { fileMustExist?: boolean; readonly?: boolean; timeout?: number }
): NativeDatabase {
  return new Database(path, options) as NativeDatabase
}
