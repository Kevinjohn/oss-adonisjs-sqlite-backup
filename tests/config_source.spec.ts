import { test } from '@japa/runner'
import { join } from 'node:path'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { BACKUP_ERROR_CODES, errors } from '../index.ts'
import { defineConfig } from '../index.ts'
import type { BackupConfig, BackupErrorCode } from '../src/types.ts'
import { requireFormattedBundleName, requireBundleTimestamp } from '../src/names.ts'
import { resolveSqliteSource } from '../src/source.ts'

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
    for (const [input, field] of [
      [{ connection: '' }, 'connection'],
      [{ connection: '   ' }, 'connection'],
      [{ connection: 123 }, 'connection'],
      [{ directory: false }, 'directory'],
      [{ requireWal: 'false' }, 'requireWal'],
    ] as const) {
      try {
        defineConfig(input as Parameters<typeof defineConfig>[0])
        assert.fail('accepted malformed config')
      } catch (error) {
        assert.instanceOf(error, InvalidArgumentsException)
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
        assert.instanceOf(error, InvalidArgumentsException)
      }
    }
    assert.throws(
      () => resolveSqliteSource(sqlite('/a.db'), 'missing'),
      InvalidArgumentsException,
      /not configured/
    )
  })

  test('public backup errors keep distinct classes, codes, messages and causes', ({ assert }) => {
    const cause = new Error('underlying SQLite failure')
    const detail = 'backup diagnostic'
    const cases = [
      ['E_BACKUP_LOCKED', new errors.E_BACKUP_LOCKED(detail, { cause }), detail],
      ['E_BACKUP_SOURCE', new errors.E_BACKUP_SOURCE(detail, { cause }), detail],
      ['E_BACKUP_INVALID', new errors.E_BACKUP_INVALID(detail, { cause }), detail],
      ['E_BACKUP_WRITE', new errors.E_BACKUP_WRITE(detail, { cause }), detail],
      ['E_BACKUP_UNSAFE', new errors.E_BACKUP_UNSAFE(detail, { cause }), detail],
      ['E_BACKUP_NOT_FOUND', new errors.E_BACKUP_NOT_FOUND(detail, { cause }), detail],
      ['E_BACKUP_DISABLED', new errors.E_BACKUP_DISABLED({ cause }), 'backups are disabled'],
    ] as const
    assert.deepEqual(
      BACKUP_ERROR_CODES,
      cases.map(([code]) => code)
    )
    for (const [code, error, message] of cases) {
      const matches = BACKUP_ERROR_CODES.filter((candidate) => error instanceof errors[candidate])
      assert.deepEqual(matches, [code])
      assert.equal(error.code, code)
      assert.equal(error.status, 500)
      assert.equal(error.message, message)
      assert.strictEqual(error.cause, cause)
    }
  })

  test('BACKUP_ERROR_CODES lists exactly the BackupErrorCode union', ({ expectTypeOf }) => {
    expectTypeOf<(typeof BACKUP_ERROR_CODES)[number]>().toEqualTypeOf<BackupErrorCode>()
  })

  test('bundle names round-trip', ({ assert }) => {
    const ms = Date.UTC(2026, 10, 7, 4, 5, 6, 789)
    assert.equal(requireFormattedBundleName(ms), 'bak-utc-20261107-040506-789')
    assert.equal(requireBundleTimestamp(requireFormattedBundleName(ms)), ms)
    assert.throws(() => requireBundleTimestamp('nope'), /not a bundle name/)
  })
})

test('defineConfig exposes a resolved backup configuration', ({ expectTypeOf }) => {
  const config = defineConfig({ directory: 'storage/backups' })
  expectTypeOf(config).toEqualTypeOf<BackupConfig>()
  expectTypeOf(config.keep).toEqualTypeOf<number>()
  expectTypeOf(config.requireWal).toEqualTypeOf<boolean>()
})
