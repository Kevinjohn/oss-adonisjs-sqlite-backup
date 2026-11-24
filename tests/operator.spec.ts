import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { test } from '@japa/runner'
import { errors } from '../index.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from '@adonisjs/lucid/database'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createBundle, verifyBundle } from '../src/bundles.js'
import { prepareDirectory } from '../src/directory.js'
import { openDatabase } from '../src/native.js'
import { operatorDatabasePath, withOperatorDatabase } from '../src/operator.js'
import { countItems, makeLiveDatabase, createTemporaryRoot } from './helpers.js'

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
    const temp = createTemporaryRoot()
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
      InvalidArgumentsException,
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
    for (const [filename, exception] of [
      [':memory:', errors.E_BACKUP_SOURCE_NOT_FILE_BACKED],
      [' :memory: ', errors.E_BACKUP_SOURCE_NOT_FILE_BACKED],
      [' ', errors.E_BACKUP_SOURCE_NOT_FILE_BACKED],
      [join(root, 'missing.db'), errors.E_BACKUP_SOURCE_MISSING],
      [join(root, 'directory.db'), errors.E_BACKUP_OPERATOR_SOURCE],
      ['file:memory.db', errors.E_BACKUP_SOURCE_URI],
    ] as const) {
      assert.throws(
        () => operatorDatabasePath(configured(sqlite(filename)), true),
        exception,
        'Operator commands require an existing on-disk database'
      )
    }
    assert.throws(
      () =>
        operatorDatabasePath(
          configured({ ...sqlite(join(root, 'live.db')), connection: { filename: 7 } }),
          true
        ),
      errors.E_BACKUP_SOURCE_NOT_FILE_BACKED,
      'Operator commands require an existing on-disk database'
    )
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

function replica(db: Database) {
  const manager = db.manager as unknown as {
    add(name: string, config: unknown): void
    closeAll(): Promise<void>
    connections: Map<string, { connection?: unknown }>
  }
  manager.add('replica', {
    client: 'pg',
    connection: { host: '127.0.0.1', database: 'unused' },
    replicas: {
      write: { connection: { host: '127.0.0.1', database: 'unused' } },
      read: { connection: [{ host: '127.0.0.1', database: 'unused' }] },
    },
  })
  db.connection('replica')
  const connection = manager.connections.get('replica')?.connection as {
    client: { destroy(): Promise<void>; client: { pool: EventEmitter } }
    readClient: { destroy(): Promise<void>; client: { pool: EventEmitter } }
    ready: boolean
    listenerCount(event: string): number
  }
  return { manager, connection }
}

test.group('withOperatorDatabase', (group) => {
  let root: string
  group.each.setup(() => {
    const temp = createTemporaryRoot()
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

  test('creates a bundle from the pinned Lucid handle and releases it after cleanup', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    const directory = join(root, 'bundles')
    makeLiveDatabase(live).close()
    prepareDirectory(directory)
    const db = lucid(live)
    let borrowed!: ReturnType<typeof openDatabase>
    const result = await withOperatorDatabase(db, async (handle) => {
      borrowed = handle as typeof borrowed
      const other = openDatabase(live, { timeout: 0 })
      try {
        assert.throws(() => other.prepare('SELECT count(*) FROM items').get(), /locked/)
      } finally {
        other.close()
      }

      const bundle = await createBundle({ source: { database: handle }, directory })
      assert.isTrue((borrowed as typeof borrowed & { open: boolean }).open)
      assert.equal(countItems(join(bundle.path, 'db.sqlite')), 200)
      assert.equal(verifyBundle(directory, bundle.name).name, bundle.name)
      assert.deepEqual(handle.prepare('SELECT count(*) AS n FROM items').get(), { n: 200 })
      return bundle
    })

    assert.equal(result.name, verifyBundle(directory).name)
    assert.isFalse((borrowed as typeof borrowed & { open: boolean }).open)
    const reopened = openDatabase(live)
    try {
      reopened.exec('BEGIN EXCLUSIVE; ROLLBACK')
      assert.equal(
        (reopened.prepare('SELECT count(*) AS n FROM items').get() as { n: number }).n,
        200
      )
    } finally {
      reopened.close()
    }
  })

  test('reports only genuine external contention as stopped-server advice', async ({ assert }) => {
    const live = join(root, 'live.db')
    const holder = openDatabase(live)
    holder.exec('CREATE TABLE heroes (name TEXT); BEGIN IMMEDIATE')
    const db = lucid(live)
    try {
      await assert.rejects(
        () => withOperatorDatabase(db, async () => assert.fail('entered')),
        errors.E_BACKUP_OPERATOR_LOCKED,
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
      assert.isFalse((handle as typeof handle & { open: boolean }).open)
    } finally {
      knex.destroy = original
      await original()
    }
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

  test('captures a secondary replica read shutdown rejection after write completion', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const { connection } = replica(db)
    const read = connection.readClient
    const write = connection.client
    const readDestroy = read.destroy.bind(read)
    const readDestroyProperty = Object.getOwnPropertyDescriptor(read, 'destroy')!
    let writeCompleted = false
    write.client.pool.on('poolDestroySuccess', () => {
      writeCompleted = true
    })
    const sentinel = new Error('read destroy failed')
    Object.defineProperty(read, 'destroy', {
      configurable: true,
      value: async () => {
        throw sentinel
      },
    })
    try {
      await withOperatorDatabase(db, async () => 'done')
      assert.fail('Expected read shutdown failure')
    } catch (error) {
      assert.equal(error, sentinel)
      assert.isTrue(writeCompleted)
      assert.isTrue(connection.ready)
      assert.equal(connection.listenerCount('disconnect:error'), 0)
    } finally {
      Object.defineProperty(read, 'destroy', readDestroyProperty)
      await readDestroy()
    }
  })

  test('reports a secondary replica pool left alive by silent shutdown', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const { connection } = replica(db)
    const read = connection.readClient
    const readDestroy = read.destroy.bind(read)
    const readDestroyProperty = Object.getOwnPropertyDescriptor(read, 'destroy')!
    let writeCompleted = false
    connection.client.client.pool.on('poolDestroySuccess', () => {
      writeCompleted = true
    })
    Object.defineProperty(read, 'destroy', { configurable: true, value: async () => {} })
    try {
      await assert.rejects(() => withOperatorDatabase(db, async () => 'done'), /replica.*read/)
      assert.isTrue(writeCompleted)
      assert.isTrue(connection.ready)
      assert.equal(connection.listenerCount('disconnect:error'), 0)
    } finally {
      Object.defineProperty(read, 'destroy', readDestroyProperty)
      await readDestroy()
    }
  })

  test('completes both secondary replica pools on success', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const { connection } = replica(db)
    const completed: string[] = []
    connection.client.client.pool.on('poolDestroySuccess', () => completed.push('write'))
    connection.readClient.client.pool.on('poolDestroySuccess', () => completed.push('read'))
    assert.equal(await withOperatorDatabase(db, async () => 'done'), 'done')
    assert.deepEqual(completed, ['write', 'read'])
    assert.equal(connection.listenerCount('disconnect:error'), 0)
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

  test('reports the real pool destroy failure and preserves an earlier work error', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const work = new Error('work failed')
    const destroy = new Error('native destroy failed')
    const knex = db.connection().getWriteClient().client as unknown as {
      destroyRawConnection(handle: unknown): Promise<void>
    }
    const original = knex.destroyRawConnection.bind(knex)
    let handle!: ReturnType<typeof openDatabase>
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        knex.destroyRawConnection = async () => {
          throw destroy
        }
        throw work
      })
      assert.fail('Expected work and destroy failures')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      assert.deepEqual((error as AggregateError).errors, [work, destroy])
    } finally {
      knex.destroyRawConnection = original
    }
    assert.isFalse((handle as typeof handle & { open: boolean }).open)
  })

  test('reports loan pool shutdown failure after still closing the owned handle', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const owner = db.connection().getWriteClient().client.pool as unknown as {
      constructor: { prototype: { destroy(this: unknown): Promise<unknown> } }
    }
    const poolPrototype = owner.constructor.prototype
    const originalDestroy = poolPrototype.destroy
    const sentinel = new Error('loan pool destroy failed')
    let handle!: ReturnType<typeof openDatabase>
    poolPrototype.destroy = async function (this: unknown) {
      await originalDestroy.call(this)
      if (this !== owner) throw sentinel
    }
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        return 'complete work'
      })
      assert.fail('Expected the loan pool failure')
    } catch (error) {
      assert.equal(error, sentinel)
    } finally {
      poolPrototype.destroy = originalDestroy
    }
    assert.isFalse((handle as typeof handle & { open: boolean }).open)
  })

  test('reports an owner pool that throws while accepting the pinned handle', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const owner = db.connection().getWriteClient().client.pool as unknown as {
      release(handle: unknown): boolean
    }
    const originalRelease = owner.release.bind(owner)
    const sentinel = new Error('owner release failed')
    let handle!: ReturnType<typeof openDatabase>
    owner.release = (borrowed) => {
      originalRelease(borrowed)
      throw sentinel
    }
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        return 'complete work'
      })
      assert.fail('Expected owner release failure')
    } catch (error) {
      assert.equal(error, sentinel)
    } finally {
      owner.release = originalRelease
    }
    assert.isFalse((handle as typeof handle & { open: boolean }).open)
  })

  test('reports native close failure after silent pool cleanup', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const manager = db.manager as unknown as { closeAll(): Promise<void> }
    const originalCloseAll = manager.closeAll.bind(manager)
    const probe = openDatabase(live)
    const handlePrototype = Object.getPrototypeOf(probe) as {
      close: (this: { name: string }) => void
    }
    probe.close()
    const originalClose = handlePrototype.close
    const sentinel = new Error('native handle close failed')
    let handle!: ReturnType<typeof openDatabase>
    manager.closeAll = async () => {}
    handlePrototype.close = function () {
      if (this.name === live) throw sentinel
      originalClose.call(this)
    }
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        return 'complete work'
      })
      assert.fail('Expected pool cleanup and native close failures')
    } catch (error) {
      assert.instanceOf(error, errors.E_BACKUP_OPERATOR_CLEANUP)
      const failure = error as InstanceType<typeof errors.E_BACKUP_OPERATOR_CLEANUP>
      assert.lengthOf(failure.resourceCleanupErrors, 2)
      assert.strictEqual(failure.cause, failure.resourceCleanupErrors[0])
      assert.match(String(failure.resourceCleanupErrors[0]), /pool cleanup incomplete/)
      assert.strictEqual(failure.resourceCleanupErrors[1], sentinel)
    } finally {
      handlePrototype.close = originalClose
      manager.closeAll = originalCloseAll
      await originalCloseAll()
    }
    assert.isFalse((handle as typeof handle & { open: boolean }).open)
  })

  test('reports a native handle left open after the pool reports successful cleanup', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const owner = db.connection().getWriteClient().client.pool as unknown as {
      emitter: EventEmitter
    }
    const manager = db.manager as unknown as { closeAll(): Promise<void> }
    const closeAll = manager.closeAll.bind(manager)
    let handle: { open?: boolean } | undefined
    manager.closeAll = async () => {
      owner.emitter.emit('poolDestroySuccess')
    }
    try {
      await assert.rejects(
        () =>
          withOperatorDatabase(db, async (borrowed) => {
            handle = borrowed as typeof handle
          }),
        errors.E_BACKUP_OPERATOR_HANDLE_OPEN
      )
      assert.isFalse(handle?.open)
    } finally {
      manager.closeAll = closeAll
      await closeAll()
    }
  })

  test('closes an independently managed connection after first acquisition fails', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const { connection } = replica(db)
    const knex = db.connection().getWriteClient().client as unknown as {
      acquireConnection(): Promise<unknown>
    }
    const original = knex.acquireConnection.bind(knex)
    const sentinel = new Error('first checkout failed')
    knex.acquireConnection = async () => {
      throw sentinel
    }
    try {
      await withOperatorDatabase(db, async () => assert.fail('Callback entered'))
      assert.fail('Expected first checkout failure')
    } catch (error) {
      assert.equal(error, sentinel)
      assert.isFalse(connection.ready)
    } finally {
      knex.acquireConnection = original
    }
  })

  test('preserves primary work failure before direct manager rejection', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const manager = db.manager as unknown as { closeAll(): Promise<void> }
    const original = manager.closeAll.bind(manager)
    const work = new Error('work failed')
    const cleanup = new Error('manager failed')
    manager.closeAll = async () => {
      await original()
      throw cleanup
    }
    try {
      await withOperatorDatabase(db, async () => {
        throw work
      })
      assert.fail('Expected both failures')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      assert.deepEqual((error as AggregateError).errors, [work, cleanup])
    } finally {
      manager.closeAll = original
    }
  })

  test('reports silent primary cleanup alongside work failure and closes the handle', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live)
    const manager = db.manager as unknown as { closeAll(): Promise<void> }
    const original = manager.closeAll.bind(manager)
    const work = new Error('work failed')
    let handle!: ReturnType<typeof openDatabase>
    manager.closeAll = async () => {}
    try {
      await withOperatorDatabase(db, async (borrowed) => {
        handle = borrowed as typeof handle
        throw work
      })
      assert.fail('Expected both failures')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      const failures = (error as AggregateError).errors
      assert.equal(failures[0], work)
      assert.match((failures[1] as Error).message, /pool cleanup incomplete|handle remained open/)
      assert.isFalse((handle as typeof handle & { open: boolean }).open)
    } finally {
      manager.closeAll = original
      await original()
    }
  })

  test('preserves non-contention setup errors', async ({ assert }) => {
    const live = join(root, 'live.db')
    openDatabase(live).close()
    const db = lucid(live, {
      afterCreate: (handle: ReturnType<typeof openDatabase>, done: () => void) => {
        handle.exec('BEGIN')
        done()
      },
    })
    await assert.rejects(
      () => withOperatorDatabase(db, async () => assert.fail('entered')),
      /transaction/
    )
  })
})
