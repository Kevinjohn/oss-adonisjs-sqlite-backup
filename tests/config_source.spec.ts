import { test } from '@japa/runner'
import { join } from 'node:path'
import { BACKUP_ERROR_CODES, BackupException } from '../src/errors.js'
import { defineConfig } from '../src/define_config.js'
import { bundleName, parseBundleName } from '../src/names.js'
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
    assert.equal(defineConfig({ directory: '' }).directory, '')
    assert.equal(defineConfig({}).directory, '')
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
  })

  test('non-file and non-SQLite connections are refused', ({ assert }) => {
    for (const config of [
      undefined,
      sqlite('/a.db', 'pg'),
      sqlite(':memory:'),
      sqlite(''),
      sqlite(undefined),
      sqlite('file:/a.db?mode=memory'),
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
    assert.equal(bundleName(ms), 'bak-utc-20261107-040506-789')
    assert.equal(parseBundleName(bundleName(ms)), ms)
    assert.throws(() => parseBundleName('nope'), /not a bundle name/)
  })
})
