import { test } from '@japa/runner'
import { join } from 'node:path'
import { BACKUP_ERROR_CODES, BackupException } from '../src/errors.js'
import { defineConfig } from '../src/define_config.js'
import { requireFormattedBundleName, requireBundleTimestamp } from '../src/names.js'
import { resolveSqliteSource } from '../src/source.js'

const sqlite = (filename: unknown, client = 'better-sqlite3') => ({
  connection: 'main',
  connections: { main: { client, connection: { filename } } },
})

test.group('config and source resolution', () => {
  test('defineConfig applies defaults and rejects bad values', ({ assert }) => {
    assert.deepEqual(defineConfig({ directory: '/b' }), {
      connection: undefined,
      directory: '/b',
      keep: 7,
      lockTimeoutMs: 0,
      requireWal: false,
    })
    assert.throws(() => defineConfig({ directory: '/b', keep: 0 }), /keep/)
    assert.throws(() => defineConfig({ directory: '/b', keep: 1.5 }), /keep/)
    assert.throws(() => defineConfig({ directory: '/b', lockTimeoutMs: -1 }), /lockTimeoutMs/)
    assert.equal(defineConfig({ lockTimeoutMs: 2_147_483_647 }).lockTimeoutMs, 2_147_483_647)
    assert.throws(() => defineConfig({ lockTimeoutMs: 2_147_483_648 }), /2147483647/)
    assert.equal(defineConfig({ directory: '' }).directory, '')
    assert.equal(defineConfig({}).directory, '')
  })

  test('invalid runtime types fail with configuration diagnostics', ({ assert }) => {
    for (const [input, field, code] of [
      [{ connection: '' }, 'connection', 'E_BACKUP_SOURCE'],
      [{ connection: '   ' }, 'connection', 'E_BACKUP_SOURCE'],
      [{ connection: 123 }, 'connection', 'E_BACKUP_SOURCE'],
      [{ directory: false }, 'directory', 'E_BACKUP_UNSAFE'],
      [{ requireWal: 'false' }, 'requireWal', 'E_BACKUP_SOURCE'],
    ] as const) {
      try {
        defineConfig(input as Parameters<typeof defineConfig>[0])
        assert.fail('accepted malformed config')
      } catch (error) {
        assert.instanceOf(error, BackupException)
        assert.equal((error as BackupException).code, code)
        assert.include((error as Error).message, field)
      }
    }
    assert.equal(
      defineConfig({ connection: 'custom connection', requireWal: true }).connection,
      'custom connection'
    )
  })

  test('the live path comes from the Lucid connection config', ({ assert }) => {
    assert.equal(resolveSqliteSource(sqlite('/data/app.db')), '/data/app.db')
    assert.equal(resolveSqliteSource(sqlite('rel.db')), join(process.cwd(), 'rel.db'))
    const multi = {
      connection: 'main',
      connections: {
        ...sqlite('/a.db').connections,
        other: { client: 'sqlite3', connection: { filename: '/b.db' } },
      },
    }
    assert.equal(resolveSqliteSource(multi, 'other'), '/b.db')
    assert.equal(resolveSqliteSource(sqlite('  /data/app.db  ')), '/data/app.db')
    assert.equal(resolveSqliteSource(sqlite('/data/app.db  ', 'sqlite3')), '/data/app.db  ')
  })

  test('non-file and non-SQLite connections are refused', ({ assert }) => {
    for (const config of [
      undefined,
      sqlite('/a.db', 'pg'),
      sqlite(':memory:'),
      sqlite(''),
      sqlite(undefined),
      sqlite('file:/a.db?mode=memory'),
      sqlite('  :memory:  '),
      sqlite('   '),
      sqlite('  file:/a.db?mode=memory  '),
    ]) {
      try {
        resolveSqliteSource(config)
        assert.fail(`accepted ${JSON.stringify(config)}`)
      } catch (error) {
        assert.instanceOf(error, BackupException)
        assert.equal((error as BackupException).code, 'E_BACKUP_SOURCE')
      }
    }
    assert.throws(() => resolveSqliteSource(sqlite('/a.db'), 'missing'), /not configured/)
  })

  test('six error codes; bundle names round-trip', ({ assert }) => {
    assert.lengthOf(BACKUP_ERROR_CODES, 6)
    const ms = Date.UTC(2026, 10, 7, 4, 5, 6, 789)
    assert.equal(requireFormattedBundleName(ms), 'bak-utc-20261107-040506-789')
    assert.equal(requireBundleTimestamp(requireFormattedBundleName(ms)), ms)
    assert.throws(() => requireBundleTimestamp('nope'), /not a bundle name/)
  })
})
