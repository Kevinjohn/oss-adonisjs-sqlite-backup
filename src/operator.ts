import { existsSync, lstatSync } from 'node:fs'
import type { Database } from '@adonisjs/lucid/database'
import type { NativeDatabase } from './native.js'
import { normalizeConfiguredSqliteFilename } from './source.js'

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
    throw new Error('Operator commands require an existing on-disk database')
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

/** Run against one pinned native handle, then close the managed Lucid connections. */
export async function withOperatorDatabase<T>(
  db: Database,
  run: (connection: NativeDatabase) => Promise<T>
): Promise<T> {
  if (activeOperators.has(db)) throw new Error('An operator command is already using this database')
  activeOperators.add(db)
  try {
    return await runOperatorDatabase(db, run)
  } finally {
    activeOperators.delete(db)
  }
}

async function runOperatorDatabase<T>(
  db: Database,
  run: (connection: NativeDatabase) => Promise<T>
): Promise<T> {
  const errors: unknown[] = []
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
    if (!owner) throw new Error('Operator command requires an initialized SQLite pool')
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
        throw new Error('Another process holds this database; stop the server and retry', {
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
        if (created)
          throw validationFailure ?? new Error('Operator database handle is no longer available')
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
          validationFailure = new Error('Operator database handle is no longer available', {
            cause: error,
          })
          return false
        }
      },
    })
    client.pool = loan
    result = await run(pinned)
  } catch (error) {
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
      if (!owner.release(handle))
        errors.push(new Error('Operator database owner refused the handle release'))
    } catch (error) {
      errors.push(error)
    }
  }

  for (const entry of manager.connections?.values() ?? []) {
    const connection = entry.connection
    if (!connection) continue
    const disconnect = (error: unknown) => errors.push(error)
    connection.on('disconnect:error', disconnect)
    listeners.push(() => connection.removeListener('disconnect:error', disconnect))
    for (const pool of new Set([
      connection.client?.client?.pool,
      connection.readClient?.client?.pool,
    ])) {
      if (!pool) continue
      const destroy = (_id: unknown, _resource: unknown, error: unknown) => errors.push(error)
      pool.on('destroyFail', destroy)
      listeners.push(() => pool.removeListener('destroyFail', destroy))
    }
  }
  try {
    await manager.closeAll()
  } catch (error) {
    errors.push(error)
  } finally {
    for (const remove of listeners) remove()
  }
  if (handle?.open) {
    if (errors.length === 0)
      errors.push(new Error('Operator database handle remained open after pool cleanup'))
    try {
      handle.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, 'Operator database cleanup failed')
  if (errors.length === 1) throw errors[0]
  return result
}
