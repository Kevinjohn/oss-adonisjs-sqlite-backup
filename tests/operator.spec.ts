import { test } from '@japa/runner'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '@adonisjs/lucid/database'
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
    for (const filename of [':memory:', join(root, 'missing.db'), join(root, 'directory.db')]) {
      assert.throws(
        () => operatorDatabasePath(configured(sqlite(filename)), true),
        'Operator commands require an existing on-disk database'
      )
    }
  })
})

/** A Lucid-shaped pool of one over a real handle, recording whether the pool was closed. */
function pool(path: string) {
  const handle = openDatabase(path)
  const state = { closed: false }
  const db = {
    connection: () => ({
      getWriteClient: () => ({
        client: { acquireConnection: async () => handle, releaseConnection: async () => {} },
      }),
    }),
    manager: {
      closeAll: async () => {
        state.closed = true
        handle.close()
      },
    },
  } as unknown as Database
  return { db, state }
}

test.group('withOperatorDatabase', (group) => {
  let root: string
  group.each.setup(() => {
    const temp = tempRoot()
    root = temp.root
    return temp.cleanup
  })

  test('holds the file exclusively during the work and closes the pool afterwards', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    openDatabase(live).exec('CREATE TABLE heroes (name TEXT)')
    const { db, state } = pool(live)
    const result = await withOperatorDatabase(db, async (connection) => {
      connection.prepare('INSERT INTO heroes (name) VALUES (?)').run('Diana Prince')
      const other = openDatabase(live, { timeout: 0 })
      try {
        assert.throws(() => other.prepare('SELECT name FROM heroes').all(), /locked/)
      } finally {
        other.close()
      }
      return 'done'
    })
    assert.equal(result, 'done')
    assert.isTrue(state.closed)
    const reopened = openDatabase(live)
    assert.deepEqual(reopened.prepare('SELECT name FROM heroes').all(), [{ name: 'Diana Prince' }])
    reopened.close()
  })

  test('refuses when another process holds the database, and still closes the pool', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    const holder = openDatabase(live)
    holder.exec('CREATE TABLE heroes (name TEXT); BEGIN IMMEDIATE')
    const { db, state } = pool(live)
    let entered = false
    try {
      await assert.rejects(
        () =>
          withOperatorDatabase(db, async () => {
            entered = true
          }),
        'Another process holds this database; stop the server and retry'
      )
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    assert.isFalse(entered)
    assert.isTrue(state.closed)
  })

  test('closes the pool when {$self} fails')
    .with(['acquire', 'setup', 'release', 'callback'] as const)
    .run(async ({ assert }, stage) => {
      let closed = false
      let entered = false
      const failure = new Error(`fixture-${stage}`)
      const client = {
        async acquireConnection() {
          if (stage === 'acquire') throw failure
          return {
            pragma() {
              if (stage === 'setup') throw failure
            },
            exec() {},
          }
        },
        async releaseConnection() {
          if (stage === 'release') throw failure
        },
      }
      const db = {
        connection: () => ({ getWriteClient: () => ({ client }) }),
        manager: {
          closeAll: async () => {
            closed = true
          },
        },
      } as unknown as Database
      await assert.rejects(
        () =>
          withOperatorDatabase(db, async () => {
            entered = true
            throw failure
          }),
        failure.message
      )
      assert.isTrue(closed)
      assert.equal(entered, stage === 'callback')
    })

  test('wraps a non-Error lock failure', async ({ assert }) => {
    const client = {
      acquireConnection: async () => ({
        pragma() {
          throw 'driver refused'
        },
        exec() {},
      }),
      releaseConnection: async () => {},
    }
    const db = {
      connection: () => ({ getWriteClient: () => ({ client }) }),
      manager: { closeAll: async () => {} },
    } as unknown as Database
    await assert.rejects(() => withOperatorDatabase(db, async () => {}), 'Operator lock failed')
  })

  test('reports a lock failure and a failed release together', async ({ assert }) => {
    const lock = new Error('lock refused')
    const release = new Error('release failed')
    const client = {
      acquireConnection: async () => ({
        pragma() {
          throw lock
        },
        exec() {},
      }),
      releaseConnection: async () => {
        throw release
      },
    }
    const db = {
      connection: () => ({ getWriteClient: () => ({ client }) }),
      manager: { closeAll: async () => {} },
    } as unknown as Database
    try {
      await withOperatorDatabase(db, async () => {})
      assert.fail('Expected both failures')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      assert.equal((error as AggregateError).message, 'Operator lock release failed')
      assert.deepEqual((error as AggregateError).errors, [lock, release])
    }
  })

  test('reports the first failure and a failed pool close together', async ({ assert }) => {
    const failure = new Error('original acquisition failure')
    const cleanup = new Error('pool cleanup failure')
    const db = {
      connection: () => {
        throw failure
      },
      manager: {
        closeAll: async () => {
          throw cleanup
        },
      },
    } as unknown as Database
    try {
      await withOperatorDatabase(db, async () => undefined)
      assert.fail('Expected both failures')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      assert.equal((error as AggregateError).message, 'Operator database cleanup failed')
      assert.deepEqual((error as AggregateError).errors, [failure, cleanup])
    }
  })

  test('reports a failed pool close after successful work', async ({ assert }) => {
    const cleanup = new Error('pool cleanup failure')
    const client = {
      acquireConnection: async () => ({ pragma() {}, exec() {} }),
      releaseConnection: async () => {},
    }
    const db = {
      connection: () => ({ getWriteClient: () => ({ client }) }),
      manager: {
        closeAll: async () => {
          throw cleanup
        },
      },
    } as unknown as Database
    await assert.rejects(() => withOperatorDatabase(db, async () => 'done'), cleanup.message)
  })
})
