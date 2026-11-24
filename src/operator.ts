import { existsSync, lstatSync } from 'node:fs'
import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
import type { Database } from '@adonisjs/lucid/database'
import {
  E_BACKUP_OPERATOR_CLEANUP,
  E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE,
  E_BACKUP_OPERATOR_RELEASE_REFUSED,
  E_BACKUP_OPERATOR_POOL_INCOMPLETE,
  E_BACKUP_OPERATOR_HANDLE_OPEN,
  E_BACKUP_OPERATOR_LOCKED,
  E_BACKUP_OPERATOR_SOURCE,
} from './errors.js'
import type { NativeDatabase } from './native.js'
import { normalizeConfiguredSqliteFilename } from './source.js'

/**
 * Checks that a stopped-server operator command may open the primary connection, and returns the
 * database file it uses. Call it before opening any connection.
 * @throws InvalidArgumentsException `Refusing without --confirm-server-stopped` when the operator has not confirmed.
 * @throws InvalidArgumentsException when the primary connection is not better-sqlite3 with a pool of one.
 * @throws E_BACKUP_OPERATOR_SOURCE when the database is in memory or is not an existing regular file.
 *
 * @example
 * ```ts
 * import { operatorDatabasePath } from '@kevinjohn/adonisjs-sqlite-backup'
 * import db from '@adonisjs/lucid/services/db'
 *
 * // Run after the operator confirms that the server is stopped.
 * const livePath = operatorDatabasePath(db, true)
 * ```
 */
export function operatorDatabasePath(db: Database, confirmServerStopped: boolean): string {
  if (!confirmServerStopped)
    throw new InvalidArgumentsException('Refusing without --confirm-server-stopped')
  const config = db.getRawConnection(db.primaryConnectionName)?.config
  if (config?.client !== 'better-sqlite3' || config.pool?.max !== 1) {
    throw new InvalidArgumentsException(
      'Operator commands require the configured single-connection SQLite pool'
    )
  }
  const configuredFilename = (config.connection as { filename?: unknown } | undefined)?.filename
  const path =
    typeof configuredFilename === 'string'
      ? normalizeConfiguredSqliteFilename(configuredFilename, config.client)
      : ''
  if (
    !path ||
    path === ':memory:' ||
    /^file:/i.test(path) ||
    !existsSync(path) ||
    !lstatSync(path).isFile()
  ) {
    throw new E_BACKUP_OPERATOR_SOURCE()
  }
  return path
}

type Handle = NativeDatabase & { open: boolean; __knex__disposed?: boolean }
type Pool = {
  constructor: new (options: Record<string, unknown>) => Pool
  acquireTimeoutMillis: number
  release(handle: Handle): boolean
  destroy(): Promise<unknown>
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
}
type Client = {
  pool: Pool
  config: { pool?: { validate?: (handle: Handle) => boolean | Promise<boolean> } }
  acquireConnection(): Promise<Handle>
}
type Managed = {
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  client?: { client?: { pool?: Pool } }
  readClient?: { client?: { pool?: Pool } }
}

const activeOperators = new WeakSet<Database>()

/**
 * Run on the primary connection's pinned native handle, then attempt to close all managed Lucid
 * connections. The callback must finish its transactions and leave the borrowed handle open.
 * Concurrent calls on the same Database are refused before cleanup ownership is taken.
 * Only SQLITE_BUSY during exclusive-lock acquisition receives stopped-server advice; other
 * failures retain their meaning. An isolated work or cleanup failure is thrown unchanged. When
 * both fail, the primary failure precedes cleanup failures in observation order.
 *
 * @throws `AggregateError` when both setup or work and cleanup fail, with the primary failure first.
 * @throws `E_BACKUP_OPERATOR_CLEANUP` for multiple cleanup failures after successful work.
 * @throws A single setup, work or cleanup failure as observed.
 *
 * @example
 * ```ts
 * import { createBundle, operatorDatabasePath, prepareDirectory, withOperatorDatabase } from '@kevinjohn/adonisjs-sqlite-backup'
 * import db from '@adonisjs/lucid/services/db'
 *
 * // Run after the operator confirms that the server is stopped.
 * operatorDatabasePath(db, true)
 * const bundle = await withOperatorDatabase(db, async (database) => {
 *   prepareDirectory('storage/backups')
 *   return createBundle({ source: { database }, directory: 'storage/backups' })
 * })
 * ```
 */
export async function withOperatorDatabase<T>(
  db: Database,
  run: (connection: NativeDatabase) => Promise<T>
): Promise<T> {
  if (activeOperators.has(db))
    throw new RuntimeException('An operator command is already using this database')
  activeOperators.add(db)
  try {
    return await runOperatorDatabase(db, run)
  } finally {
    activeOperators.delete(db)
  }
}

/**
 * @throws `AggregateError` when setup or work fails before cleanup also fails, with the primary failure first.
 * @throws `E_BACKUP_OPERATOR_CLEANUP` for multiple cleanup failures after successful work.
 */
async function runOperatorDatabase<T>(
  db: Database,
  run: (connection: NativeDatabase) => Promise<T>
): Promise<T> {
  const errors: unknown[] = []
  let workFailed = false
  let result!: T
  let handle: Handle | undefined
  let client: Client | undefined
  let owner: Pool | undefined
  let loan: Pool | undefined
  const listeners: Array<() => void> = []
  const manager = db.manager as unknown as {
    connections?: Map<string, { connection?: Managed }>
    closeAll(): Promise<void>
  }
  try {
    client = db.connection().getWriteClient().client as unknown as Client
    owner = client.pool
    if (!owner) throw new RuntimeException('Operator command requires an initialized SQLite pool')
    handle = await client.acquireConnection()
    handle.pragma('busy_timeout = 0')
    handle.pragma('locking_mode = EXCLUSIVE')
    try {
      handle.exec('BEGIN EXCLUSIVE; COMMIT')
    } catch (error) {
      if (
        error instanceof Error &&
        /^SQLITE_BUSY(?:_|$)/.test((error as Error & { code?: string }).code ?? '')
      ) {
        throw new E_BACKUP_OPERATOR_LOCKED({
          cause: error,
        })
      }
      throw error
    }

    const pinned = handle
    let created = false
    let validationFailure: Error | undefined
    const validate = client.config.pool?.validate
    loan = new owner.constructor({
      min: 1,
      max: 1,
      acquireTimeoutMillis: owner.acquireTimeoutMillis,
      propagateCreateError: true,
      create: async () => {
        if (created) throw validationFailure ?? new E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE()
        created = true
        return pinned
      },
      destroy: async () => {},
      validate: async (candidate: Handle) => {
        if (candidate !== pinned || !candidate.open || candidate.__knex__disposed) return false
        if (!validate) return true
        try {
          return await validate(candidate)
        } catch (error) {
          validationFailure = new E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE({
            cause: error,
          })
          return false
        }
      },
    })
    client.pool = loan
    result = await run(pinned)
  } catch (error) {
    workFailed = true
    errors.push(error)
  }

  if (loan && client && owner) {
    try {
      await loan.destroy()
    } catch (error) {
      errors.push(error)
    }
    client.pool = owner
  }
  if (handle && owner) {
    try {
      if (!owner.release(handle)) errors.push(new E_BACKUP_OPERATOR_RELEASE_REFUSED())
    } catch (error) {
      errors.push(error)
    }
  }

  let primaryCleanupObserved = false
  const captured: Array<{
    name: string
    pools: Array<{ pool: Pool; roles: string[]; completed: boolean }>
    disconnectCount: number
  }> = []
  for (const [name, entry] of manager.connections ?? []) {
    const connection = entry.connection
    if (!connection) continue
    const record = {
      name,
      pools: [] as Array<{ pool: Pool; roles: string[]; completed: boolean }>,
      disconnectCount: 0,
    }
    captured.push(record)
    const recordDisconnectError = (error: unknown) => {
      errors.push(error)
      record.disconnectCount++
      if (name === db.primaryConnectionName) primaryCleanupObserved = true
    }
    connection.on('disconnect:error', recordDisconnectError)
    listeners.push(() => connection.removeListener('disconnect:error', recordDisconnectError))
    for (const [role, pool] of [
      ['write', connection.client?.client?.pool],
      ['read', connection.readClient?.client?.pool],
    ] as const) {
      if (!pool) continue
      const existing = record.pools.find((item) => item.pool === pool)
      if (existing) {
        existing.roles.push(role)
        continue
      }
      const state = { pool, roles: [role], completed: false }
      record.pools.push(state)
      const recordPoolDestroyFailure = (_id: unknown, _resource: unknown, error: unknown) => {
        errors.push(error)
        if (name === db.primaryConnectionName && pool === owner) primaryCleanupObserved = true
      }
      const recordPoolDestroyed = () => {
        state.completed = true
        connection.removeListener('disconnect:error', recordDisconnectError)
        connection.on('disconnect:error', recordDisconnectError)
      }
      pool.on('destroyFail', recordPoolDestroyFailure)
      pool.on('poolDestroySuccess', recordPoolDestroyed)
      listeners.push(() => pool.removeListener('destroyFail', recordPoolDestroyFailure))
      listeners.push(() => pool.removeListener('poolDestroySuccess', recordPoolDestroyed))
    }
  }
  let managerFailed = false
  try {
    await manager.closeAll()
  } catch (error) {
    managerFailed = true
    primaryCleanupObserved = true
    errors.push(error)
  } finally {
    for (const remove of listeners) remove()
  }
  if (!managerFailed) {
    for (const record of captured) {
      const pending = record.pools.filter((item) => !item.completed)
      if (pending.length > record.disconnectCount) {
        errors.push(
          new E_BACKUP_OPERATOR_POOL_INCOMPLETE(
            `Operator connection ${record.name} pool cleanup incomplete: ${pending.flatMap((item) => item.roles).join(', ')}`
          )
        )
        if (record.name === db.primaryConnectionName) primaryCleanupObserved = true
      }
    }
  }
  if (handle?.open) {
    if (!primaryCleanupObserved) errors.push(new E_BACKUP_OPERATOR_HANDLE_OPEN())
    try {
      handle.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 1) {
    if (workFailed) throw new AggregateError(errors, 'Operator database cleanup failed')
    throw new E_BACKUP_OPERATOR_CLEANUP(errors, { cause: errors[0] })
  }
  if (errors.length === 1) throw errors[0]
  return result
}
