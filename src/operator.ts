import { existsSync, lstatSync } from 'node:fs'
import type { Database } from '@adonisjs/lucid/database'
import type { NativeDatabase } from './native.js'

/**
 * Checks that a stopped-server operator command may open the primary connection, and returns the
 * database file it uses. Call it before opening any connection.
 * @throws Error `Refusing without --confirm-server-stopped` when the operator has not confirmed.
 * @throws Error when the primary connection is not better-sqlite3 with a pool of one.
 * @throws Error when the database is in memory or is not an existing regular file.
 */
export function operatorDatabasePath(db: Database, confirmServerStopped: boolean): string {
  if (!confirmServerStopped) throw new Error('Refusing without --confirm-server-stopped')
  const config = db.getRawConnection(db.primaryConnectionName)?.config
  if (config?.client !== 'better-sqlite3' || config.pool?.max !== 1) {
    throw new Error('Operator commands require the configured single-connection SQLite pool')
  }
  const path = (config.connection as { filename: string }).filename
  if (path === ':memory:' || !existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error('Operator commands require an existing on-disk database')
  }
  return path
}

/**
 * Runs `run` while the pool's only handle holds the database in EXCLUSIVE locking mode, so no
 * other process can open it, then closes every connection. Lucid queries inside `run` use that
 * same handle. The pool is closed on success and on every failure.
 * @throws Error `Another process holds this database; stop the server and retry` when another
 *   process has the file open.
 * @throws AggregateError when a cleanup step also fails, holding the first failure and the
 *   cleanup failure in order.
 */
export async function withOperatorDatabase<T>(
  db: Database,
  run: (connection: NativeDatabase) => Promise<T>
): Promise<T> {
  let failure: unknown
  let failed = false
  let result!: T
  try {
    const client = db.connection().getWriteClient().client
    const connection = await client.acquireConnection()
    let lockFailure: Error | undefined
    try {
      connection.pragma('busy_timeout = 0')
      connection.pragma('locking_mode = EXCLUSIVE')
      try {
        connection.exec('BEGIN EXCLUSIVE; COMMIT')
      } catch (cause) {
        throw new Error('Another process holds this database; stop the server and retry', {
          cause,
        })
      }
    } catch (error) {
      lockFailure =
        error instanceof Error ? error : new Error('Operator lock failed', { cause: error })
    }
    try {
      await client.releaseConnection(connection)
    } catch (cleanup) {
      if (lockFailure !== undefined) {
        throw new AggregateError([lockFailure, cleanup], 'Operator lock release failed')
      }
      throw cleanup
    }
    if (lockFailure !== undefined) throw lockFailure
    result = await run(connection as NativeDatabase)
  } catch (error) {
    failure = error
    failed = true
  }
  // Closing the sole handle releases EXCLUSIVE mode even after acquisition or lock failure.
  try {
    await db.manager.closeAll()
  } catch (cleanup) {
    if (failed) throw new AggregateError([failure, cleanup], 'Operator database cleanup failed')
    throw cleanup
  }
  if (failed) throw failure
  return result
}
