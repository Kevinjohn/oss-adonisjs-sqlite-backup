import { test } from '@japa/runner'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from '@adonisjs/lucid/database'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { openDatabase } from '../src/native.js'
import { operatorDatabasePath, withOperatorDatabase } from '../src/operator.js'
import { tempRoot } from './helpers.js'

function configured(config: unknown) {
  return {
    primaryConnectionName: 'sqlite',
    getRawConnection: () => (config ? { config } : undefined),
  } as unknown as Database
}

const sqlite = (filename: string, max = 1) => ({
  client: 'better-sqlite3',
  connection: { filename },
  pool: { max },
})

test.group('operatorDatabasePath', (group) => {
  let root: string
  group.each.setup(() => {
    const temp = tempRoot()
    root = temp.root
    return temp.cleanup
  })

  test('returns the file of a single-connection better-sqlite3 pool', ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    assert.equal(operatorDatabasePath(configured(sqlite(live)), true), live)
    assert.equal(operatorDatabasePath(configured(sqlite(` ${live} `)), true), live)
  })

  test('refuses without the operator confirmation, before reading any configuration', ({
    assert,
  }) => {
    const unreadable = { primaryConnectionName: 'sqlite' } as unknown as Database
    assert.throws(
      () => operatorDatabasePath(unreadable, false),
      'Refusing without --confirm-server-stopped'
    )
  })

  test('refuses another client, a larger pool or a missing connection', ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    for (const config of [
      { ...sqlite(live), client: 'pg' },
      sqlite(live, 2),
      { client: 'better-sqlite3', connection: { filename: live } },
      undefined,
    ]) {
      assert.throws(
        () => operatorDatabasePath(configured(config), true),
        'Operator commands require the configured single-connection SQLite pool'
      )
    }
  })

  test('refuses an in-memory, missing or non-file database', ({ assert }) => {
    mkdirSync(join(root, 'directory.db'))
    for (const filename of [
      ':memory:',
      ' :memory: ',
      ' ',
      join(root, 'missing.db'),
      join(root, 'directory.db'),
    ]) {
      assert.throws(
        () => operatorDatabasePath(configured(sqlite(filename)), true),
        'Operator commands require an existing on-disk database'
      )
    }
  })
})

const logger = new Proxy({}, { get: () => () => {} })
function lucid(path: string, pool: Record<string, unknown> = {}) {
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: path },
          pool: { min: 0, max: 1, ...pool },
        },
      },
    },
    logger as never,
    Object.assign(new EventEmitter(), { hasListeners: () => false }) as never
  )
}

test.group('withOperatorDatabase', (group) => {
  let root: string
  group.each.setup(() => {
    const temp = tempRoot()
    root = temp.root
    return temp.cleanup
  })

  test('pins the Lucid handle across ordinary queries and transactions', async ({ assert }) => {
    const live = join(root, 'live.db')
    const seed = openDatabase(live)
    seed.exec('CREATE TABLE heroes (name TEXT)')
    seed.close()
    const db = lucid(live)
    const result = await withOperatorDatabase(db, async (handle) => {
      handle.exec("CREATE TEMP TABLE marker (value TEXT); INSERT INTO marker VALUES ('pinned')")
      const other = openDatabase(live, { timeout: 0 })
      try {
        assert.throws(() => other.prepare('SELECT name FROM heroes').all(), /locked/)
      } finally {
        other.close()
      }
      const marker = await db.rawQuery('SELECT value FROM marker')
      assert.equal(marker[0].value, 'pinned')
      await db.table('heroes').insert({ name: 'kept' })
      const trx = await db.transaction()
      await trx.table('heroes').insert({ name: 'rolled back' })
      await trx.rollback()
      return 'done'
    })
    assert.equal(result, 'done')
    const reopened = openDatabase(live)
    assert.deepEqual(reopened.prepare('SELECT name FROM heroes').all(), [{ name: 'kept' }])
    reopened.close()
  })

  test('reports only genuine external contention as stopped-server advice', async ({ assert }) => {
    const live = join(root, 'live.db')
    const holder = openDatabase(live)
    holder.exec('CREATE TABLE heroes (name TEXT); BEGIN IMMEDIATE')
    const db = lucid(live)
    try {
      await assert.rejects(
        () => withOperatorDatabase(db, async () => assert.fail('entered')),
        /Another process holds/
      )
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    const idle = openDatabase(live)
    const next = lucid(live)
    try {
      assert.equal(await withOperatorDatabase(next, async () => 'entered'), 'entered')
    } finally {
      idle.close()
    }
  })

  test('retains the original lease across the owning pool reaper', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live, { idleTimeoutMillis: 1, reapIntervalMillis: 1000 })
    const owner = db.connection().getWriteClient().client.pool as unknown as {
      used: unknown[]
      check(): void
    }
    await withOperatorDatabase(db, async (handle) => {
      const client = db.connection().getWriteClient().client as unknown as {
        pool: { used: unknown[]; check(): void }
      }
      assert.lengthOf(owner.used, 1)
      handle.exec("CREATE TEMP TABLE marker (value TEXT); INSERT INTO marker VALUES ('same')")
      const before = await db.rawQuery('SELECT value FROM marker')
      assert.equal(before[0].value, 'same')
      const loan = client.pool as typeof client.pool & { free: Array<{ timestamp: number }> }
      assert.lengthOf(loan.free, 1)
      loan.free[0].timestamp = Date.now() - 60_000
      loan.check()
      owner.check()
      assert.isTrue((handle as typeof handle & { open: boolean }).open)
      const query = await db.rawQuery('SELECT value FROM marker')
      assert.equal(query[0].value, 'same')
      assert.notEqual(client.pool, owner)
    })
  })

  test('keeps the same handle after its configured lifetime expires', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live, { maxConnectionLifetimeMillis: 50 })
    await withOperatorDatabase(db, async (handle) => {
      handle.exec("CREATE TEMP TABLE marker (value TEXT); INSERT INTO marker VALUES ('same')")
      ;(handle as typeof handle & { __knexLifetimeLimit: number }).__knexLifetimeLimit =
        performance.now() - 1
      assert.isBelow(
        (handle as typeof handle & { __knexLifetimeLimit: number }).__knexLifetimeLimit,
        performance.now()
      )
      const rows = await db.rawQuery('SELECT value FROM marker')
      assert.equal(rows[0].value, 'same')
      assert.isTrue((handle as typeof handle & { open: boolean }).open)
    })
  })

  test('queues a write behind a transaction without joining its rollback', async ({ assert }) => {
    const live = join(root, 'live.db')
    const seed = openDatabase(live)
    seed.exec('CREATE TABLE heroes (name TEXT)')
    seed.close()
    const db = lucid(live)
    await withOperatorDatabase(db, async () => {
      const trx = await db.transaction()
      await trx.table('heroes').insert({ name: 'rolled back' })
      const client = db.connection().getWriteClient().client as unknown as {
        pool: {
          on(event: string, listener: () => void): void
          removeListener(event: string, listener: () => void): void
        }
      }
      let requested!: () => void
      const demand = new Promise<void>((resolve) => {
        requested = resolve
      })
      client.pool.on('acquireRequest', requested)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const queued = Promise.resolve(db.table('heroes').insert({ name: 'kept' }))
        await Promise.race([
          demand,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Queued acquisition did not start')), 1000)
          }),
        ])
        await trx.rollback()
        await queued
      } finally {
        if (timer) clearTimeout(timer)
        client.pool.removeListener('acquireRequest', requested)
        if (!trx.isCompleted) await trx.rollback()
      }
    })
    const reopened = openDatabase(live)
    assert.deepEqual(reopened.prepare('SELECT name FROM heroes').all(), [{ name: 'kept' }])
    reopened.close()
  })

  test('surfaces real Lucid disconnect errors and closes the native handle', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const failure = new Error('destroy rejected')
    let handle!: ReturnType<typeof openDatabase>
    const knex = db.connection().getWriteClient().client as unknown as { destroy(): Promise<void> }
    const original = knex.destroy.bind(knex)
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        knex.destroy = async () => {
          throw failure
        }
      })
      assert.fail('Expected the destroy failure')
    } catch (error) {
      assert.equal(error, failure)
    } finally {
      knex.destroy = original
      await original()
    }
    assert.isFalse((handle as typeof handle & { open: boolean }).open)
  })

  test('does not replace a handle rejected by the configured validator', async ({ assert }) => {
    const live = join(root, 'live.db')
    const seed = openDatabase(live)
    seed.exec('CREATE TABLE heroes (name TEXT)')
    seed.close()
    let allowed = true
    let afterCreate = 0
    const db = lucid(live, {
      validate: () => allowed,
      afterCreate: (_handle: unknown, done: () => void) => {
        afterCreate++
        done()
      },
    })
    await withOperatorDatabase(db, async () => {
      allowed = false
      await assert.rejects(
        () => db.table('heroes').insert({ name: 'forbidden' }),
        /no longer available/
      )
      const other = openDatabase(live, { timeout: 0 })
      try {
        assert.throws(() => other.prepare('SELECT name FROM heroes').all(), /locked/)
      } finally {
        other.close()
      }
    })
    assert.equal(afterCreate, 1)
    const reopened = openDatabase(live)
    assert.deepEqual(reopened.prepare('SELECT name FROM heroes').all(), [])
    reopened.close()
  })

  test('preserves the cause of a throwing validator', async ({ assert }) => {
    const live = join(root, 'live.db')
    const seed = openDatabase(live)
    seed.exec('CREATE TABLE heroes (name TEXT)')
    seed.close()
    const sentinel = new Error('validator failed')
    let reject = false
    let created = 0
    const db = lucid(live, {
      validate: () => {
        if (reject) throw sentinel
        return true
      },
      afterCreate: (_handle: unknown, done: () => void) => {
        created++
        done()
      },
    })
    await withOperatorDatabase(db, async () => {
      reject = true
      try {
        await db.table('heroes').insert({ name: 'forbidden' })
        assert.fail('Expected validation failure')
      } catch (error) {
        assert.equal((error as Error).cause, sentinel)
      }
      const other = openDatabase(live, { timeout: 0 })
      try {
        assert.throws(() => other.prepare('SELECT name FROM heroes').all(), /locked/)
      } finally {
        other.close()
      }
    })
    assert.equal(created, 1)
    const reopened = openDatabase(live)
    assert.deepEqual(reopened.prepare('SELECT name FROM heroes').all(), [])
    reopened.close()
  })

  test('rejects a second operator while the first owns the lease', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    let resume!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = withOperatorDatabase(db, async () => {
      entered()
      await held
    })
    await started
    try {
      await assert.rejects(() => withOperatorDatabase(db, async () => {}), /already using/)
    } finally {
      resume()
      await first
    }
  })

  test('reports an unowned original release even when manager cleanup resolves', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const owner = db.connection().getWriteClient().client.pool as unknown as {
      release(handle: unknown): boolean
    }
    await assert.rejects(
      () =>
        withOperatorDatabase(db, async (handle) => {
          assert.isTrue(owner.release(handle))
        }),
      /refused the handle release/
    )
  })
})
