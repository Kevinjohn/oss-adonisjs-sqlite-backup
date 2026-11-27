// better-sqlite3 13 publishes no declarations; the surface this package consumes is typed in types.ts.
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'
import type { NativeDatabase } from './types.ts'

export type { NativeDatabase }

/** Open a native SQLite handle. */
export function openDatabase(
  path: string,
  options?: { fileMustExist?: boolean; readonly?: boolean; timeout?: number }
): NativeDatabase {
  return new Database(path, options) as NativeDatabase
}
