/**
 * In-app integration: a booted AdonisJS app with Lucid and this provider, driving the real
 * `db:backup` command through the ace kernel while Lucid keeps writing on its own connection.
 */
import { test } from '@japa/runner'
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { InternalHooks } from '../src/internal_hooks.ts'
import { prepareDirectory } from '../src/directory.ts'
import { createBundle } from '../src/bundles.ts'
import { defineConfig } from '../src/define_config.ts'
import { SqliteBackup } from '../src/sqlite_backup.ts'
import SqliteBackupProvider from '../providers/sqlite_backup_provider.ts'
import { verifyBundle } from '../src/bundles.ts'
import { openDatabase } from '../src/native.ts'
import { acquireLock } from '../src/lock.ts'
import {
  countItems,
  failDirectorySync,
  startChild,
  stopChild,
  createTemporaryRoot,
  within,
} from './helpers.ts'

interface BootAppOptions {
  withBackupConfig?: boolean | 'disabled'
  backupDirectory?: string
  backupConnection?: string
}

async function bootApp(
  root: string,
  { withBackupConfig = true, backupDirectory, backupConnection }: BootAppOptions = {}
) {
  const live = join(root, 'live.db')
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: {
        database: defineDatabaseConfig({
          connection: 'sqlite',
          connections: {
            sqlite: {
              client: 'better-sqlite3',
              connection: { filename: live },
              useNullAsDefault: true,
            },
          },
        }),
        ...(withBackupConfig
          ? {
              backup: defineConfig({
                connection: backupConnection,
                directory:
                  withBackupConfig === 'disabled' ? '' : (backupDirectory ?? join(root, 'backups')),
              }),
            }
          : {}),
      },
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('../providers/sqlite_backup_provider.js'),
        ],
        commands: [() => import('../commands/main.js')],
      },
    })
    .create(pathToFileURL(`${root}/`))
  const app = ignitor.createApp('console') as ApplicationService
  await app.init()
  await app.boot()
  await app.start(() => {})
  return { app, live }
}

test('Ace preserves the framework exception for an unconfigured backup connection', async ({
  assert,
}) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app } = await bootApp(root, { backupConnection: 'missing' })
  try {
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    assert.instanceOf(command.error, InvalidArgumentsException)
    command.assertLogMatches(
      /db:backup create failed: Lucid connection "missing" is not configured/
    )
    assert.isFalse(existsSync(join(root, 'backups')))
  } finally {
    await app.terminate()
    cleanup()
  }
})

test('refused implicit create leaves an unsafe root permission unchanged', async ({ assert }) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root, { backupDirectory: root })
  try {
    openDatabase(live).close()
    chmodSync(root, 0o755)
    const before = statSync(root).mode & 0o777
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/E_BACKUP_UNSAFE/)
    assert.equal(statSync(root).mode & 0o777, before)
  } finally {
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test('create refuses a configured file root without changing its mode or bytes', async ({
  assert,
}) => {
  const { root, cleanup } = createTemporaryRoot()
  const directory = join(root, 'backup-root')
  const bytes = Buffer.from('preserve configured file')
  writeFileSync(directory, bytes, { mode: 0o644 })
  const beforeMode = statSync(directory).mode & 0o777
  const { app, live } = await bootApp(root, { backupDirectory: directory })
  try {
    openDatabase(live).close()
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/E_BACKUP_UNSAFE/)
    assert.equal(statSync(directory).mode & 0o777, beforeMode)
    assert.deepEqual(readFileSync(directory), bytes)
  } finally {
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test.group('db:backup inside a booted AdonisJS + Lucid app', (group) => {
  let root: string
  let cleanup: () => void
  let app: ApplicationService
  let live: string
  group.each.setup(async () => {
    ;({ root, cleanup } = createTemporaryRoot())
    ;({ app, live } = await bootApp(root))
    return async () => {
      await app.terminate()
      cleanup()
    }
  })

  test('create, list, verify, restore-prepare and prune while Lucid writes', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    await db.rawQuery('PRAGMA journal_mode = WAL')
    await db.rawQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
    await db.table('items').multiInsert(Array.from({ length: 500 }, () => ({ body: 'x' })))
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const run = async (argv: string[]) => {
      const command = await ace.exec('db:backup', argv)
      command.assertSucceeded()
      return command
    }

    let stop = false
    let duringBackup = 0
    let inBackup = false
    const writer = (async () => {
      while (!stop) {
        await db.table('items').insert({ body: 'live' })
        if (inBackup) duringBackup++
        // knex over better-sqlite3 settles in microtasks; yield like real requests do.
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    inBackup = true
    const create = await within(
      ace.exec('db:backup', ['create']),
      15_000,
      'db:backup create'
    ).finally(() => {
      inBackup = false
      stop = true
    })
    await writer
    create.assertSucceeded()
    assert.isAbove(duringBackup, 0)

    const backup = await app.container.make('sqlite.backup')
    assert.instanceOf(backup, SqliteBackup)
    assert.equal(backup.livePath(), live)
    const [bundle] = backup.list()
    assert.isAtLeast(countItems(join(bundle!.path, 'db.sqlite')), 500)

    const list = await ace.exec('db:backup', ['list'])
    list.assertSucceeded()
    list.assertLog(bundle!.name)
    await run(['verify'])

    const liveInode = statSync(live).ino
    const target = join(root, 'staged.db')
    await run(['restore-prepare', '--target', target])
    assert.isTrue(existsSync(target))
    const refused = await ace.exec('db:backup', ['restore-prepare', '--target', live])
    refused.assertFailed()
    refused.assertLogMatches(/E_BACKUP_UNSAFE/)
    assert.equal(statSync(live).ino, liveInode)
    await db.table('items').insert({ body: 'still writable' })

    await run(['create'])
    const prune = await ace.exec('db:backup', ['prune', '--keep', '1'])
    prune.assertSucceeded()
    prune.assertLogMatches(/Pruned 1 bundle/)
    assert.lengthOf(backup.list(), 1)
  }).timeout(30_000)

  test('M13: restore-prepare --bundle stages that bundle, not the newest', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    await db.rawQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
    await db.table('items').insert({ body: 'first' })
    const backup = await app.container.make('sqlite.backup')
    backup.prepareDirectory()
    const older = await backup.create()
    await db.table('items').insert({ body: 'second' })
    await backup.create()
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const target = join(root, 'older.db')
    const staged = await ace.exec('db:backup', [
      'restore-prepare',
      '--bundle',
      older.name,
      '--target',
      target,
    ])
    staged.assertSucceeded()
    staged.assertLogMatches(new RegExp(`Staged ${older.name}`))
    assert.equal(countItems(target), 1)
  }).timeout(30_000)

  test('command errors: unknown operation, missing target, rollback-journal warning', async ({
    assert,
  }) => {
    const db = await app.container.make('lucid.db')
    await db.rawQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const unknown = await ace.exec('db:backup', ['explode'])
    unknown.assertFailed()
    assert.equal(unknown.error?.code, 'E_BACKUP_UNSAFE')
    assert.lengthOf(
      ace.ui.logger.getLogs().filter((log) => log.message.includes('unknown operation')),
      1
    )
    unknown.assertLogMatches(/E_BACKUP_UNSAFE: unknown operation/)
    const noTarget = await ace.exec('db:backup', ['restore-prepare'])
    noTarget.assertFailed()
    noTarget.assertLogMatches(/E_BACKUP_UNSAFE: restore-prepare needs --target/)
    const invalidKeep = await ace.exec('db:backup', ['prune', '--keep', '0'])
    assert.equal(invalidKeep.exitCode, 1)
    invalidKeep.assertLogMatches(/E_BACKUP_UNSAFE: keep must be an integer >= 1/)
    const create = await ace.exec('db:backup', ['create'])
    create.assertSucceeded()
    create.assertLogMatches(/journal_mode=delete/)
    const verify = await ace.exec('db:backup', ['verify', '--bundle', 'nope'])
    verify.assertFailed()
    // A flag for another operation is refused, never ignored: prune --bundle must not prune by keep.
    for (const [argv, message] of [
      [['prune', '--bundle', 'nope'], /--bundle is only supported for verify and restore-prepare/],
      [
        ['create', '--target', join(root, 'x.db')],
        /--target is only supported for restore-prepare/,
      ],
      [['verify', '--keep', '1'], /--keep is only supported for prune/],
    ] as const) {
      const misused = await ace.exec('db:backup', [...argv])
      misused.assertFailed()
      misused.assertLogMatches(message)
    }
    assert.isFalse(existsSync(join(root, 'x.db')))
    const backup = await app.container.make('sqlite.backup')
    assert.lengthOf(backup.list(), 1)
    // Config keep (7) applies without --keep; a bundle that cannot be removed fails the command.
    for (let i = 0; i < 8; i++) await backup.create()
    const oldest = backup.list()[0]!.path
    chmodSync(oldest, 0o500)
    try {
      const prune = await ace.exec('db:backup', ['prune'])
      prune.assertFailed()
      prune.assertLogMatches(/could not remove/)
      assert.lengthOf(backup.list(), 8)
    } finally {
      chmodSync(oldest, 0o700)
    }
    const prune = await ace.exec('db:backup', ['prune'])
    prune.assertSucceeded()
    assert.lengthOf(backup.list(), 7)
  }).timeout(30_000)
})

test.group('provider', () => {
  test('Ace resolves each app’s backup binding after the service import is cached', async ({
    assert,
  }) => {
    const first = createTemporaryRoot()
    const second = createTemporaryRoot()
    const { app, live } = await bootApp(first.root)
    try {
      const { default: cached } = await import('../services/main.js')
      assert.strictEqual(cached, await app.container.make('sqlite.backup'))
      const other = await bootApp(second.root)
      try {
        const otherBackup = await other.app.container.make('sqlite.backup')
        assert.notStrictEqual(cached, otherBackup)
        const { default: reimported } = await import('../services/main.js')
        assert.strictEqual(reimported, cached)
        openDatabase(live).close()
        openDatabase(other.live).close()

        const firstAce = await app.container.make('ace')
        firstAce.ui.switchMode('raw')
        const secondAce = await other.app.container.make('ace')
        secondAce.ui.switchMode('raw')
        const firstRun = await firstAce.exec('db:backup', ['create'])
        firstRun.assertSucceeded()
        assert.lengthOf(cached.list(), 1)
        assert.isFalse(existsSync(otherBackup.config.directory))
        const secondRun = await secondAce.exec('db:backup', ['create'])
        secondRun.assertSucceeded()
        assert.lengthOf(cached.list(), 1)
        assert.lengthOf(otherBackup.list(), 1)
      } finally {
        await other.app.terminate()
      }
    } finally {
      await app.terminate()
      first.cleanup()
      second.cleanup()
    }
  })
  test('README startup example: disabled skips, enabled prepares, a bad source still throws', async ({
    assert,
  }) => {
    const startup = (backup: SqliteBackup) => {
      if (!backup.config.directory) return false
      backup.checkSource()
      backup.prepareDirectory()
      return true
    }
    const disabled = createTemporaryRoot()
    const enabled = createTemporaryRoot()
    const off = await bootApp(disabled.root, { withBackupConfig: 'disabled' })
    const on = await bootApp(enabled.root)
    try {
      const archive = join(disabled.root, 'archive')
      prepareDirectory(archive)
      const offService = await off.app.container.make('sqlite.backup')
      assert.isFalse(startup(offService))
      assert.deepEqual(offService.list(archive), [])

      const onService = await on.app.container.make('sqlite.backup')
      writeFileSync(on.live, 'not a database')
      assert.throws(() => startup(onService), /cannot be read/)
      assert.isFalse(existsSync(join(enabled.root, 'backups')))
      writeFileSync(on.live, '')
      const seeded = openDatabase(on.live)
      seeded.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
      seeded.close()
      assert.isTrue(startup(onService))
      assert.equal(statSync(join(enabled.root, 'backups')).mode & 0o777, 0o700)
      const created = await onService.create()
      await onService.prune()
      assert.deepEqual(
        onService.list().map((bundle) => bundle.name),
        [created.name]
      )
    } finally {
      await off.app.terminate()
      await on.app.terminate()
      disabled.cleanup()
      enabled.cleanup()
    }
  }).timeout(30_000)
  test('prune with a valid keep flag reports malformed configuration accurately', async ({
    assert,
  }) => {
    const { root, cleanup } = createTemporaryRoot()
    const { app } = await bootApp(root)
    try {
      app.config.set('backup', { directory: join(root, 'backups'), requireWal: 'yes' })
      const ace = await app.container.make('ace')
      ace.ui.switchMode('raw')
      const command = await ace.exec('db:backup', ['prune', '--keep', '7'])
      assert.equal(command.exitCode, 1)
      command.assertLogMatches(/db:backup prune failed: backup requireWal must be a boolean/)
    } finally {
      await app.terminate()
      cleanup()
    }
  }).timeout(30_000)

  test('without config/backup.ts the binding fails with a fix-it message', async ({ assert }) => {
    const { root, cleanup } = createTemporaryRoot()
    const { app } = await bootApp(root, { withBackupConfig: false })
    try {
      await assert.rejects(
        () => app.container.make('sqlite.backup'),
        RuntimeException,
        /node ace configure/
      )
      assert.isFunction(SqliteBackupProvider)
    } finally {
      await app.terminate()
      cleanup()
    }
  }).timeout(30_000)
})

test.group('WAL: backup in its own process while the app writes', (group) => {
  let root: string
  let cleanup: () => void
  group.each.setup(() => {
    ;({ root, cleanup } = createTemporaryRoot())
    return () => cleanup()
  })

  test('writers stay fast and the bundle holds one SQLite read snapshot', async ({ assert }) => {
    // Seed ~80 MB so the copy takes long enough to overlap many writes.
    const seed = openDatabase(join(root, 'live.db'))
    seed.pragma('journal_mode = WAL')
    seed.exec(
      'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);' +
        'CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER, pad TEXT);' +
        'CREATE TABLE counter (n INTEGER NOT NULL);' +
        'INSERT INTO accounts VALUES (1, 500), (2, 500); INSERT INTO counter VALUES (0)'
    )
    seed.exec('BEGIN')
    const pad = seed.prepare('INSERT INTO ledger (amount, pad) VALUES (0, ?)')
    for (let i = 0; i < 160_000; i++) pad.run('p'.repeat(500))
    seed.prepare('UPDATE counter SET n = 160000').run()
    seed.exec('COMMIT')
    seed.close()

    const { app, live } = await bootApp(root)
    try {
      const db = await app.container.make('lucid.db')
      const journal = await db.rawQuery('PRAGMA journal_mode')
      assert.equal(journal.at(0)?.journal_mode, 'wal')
      // Invariants every committed transaction keeps: balances sum to 1000; counter = ledger rows.
      const transfer = (amount: number) =>
        db.transaction(async (trx) => {
          await trx.from('accounts').where('id', 1).decrement('balance', amount)
          await trx.from('accounts').where('id', 2).increment('balance', amount)
          await trx.table('ledger').insert({ amount, pad: '' })
          await trx.from('counter').increment('n', 1)
        })

      let done = false
      let committed = 0
      let duringCopy = 0
      let copying = false
      const latencies: number[] = []
      const writer = (async () => {
        while (!done) {
          const started = performance.now()
          await transfer(Math.floor(Math.random() * 20) - 10)
          committed++
          if (copying) {
            duringCopy++
            latencies.push(performance.now() - started)
          }
          await new Promise((resolve) => setImmediate(resolve))
        }
      })()
      // The snapshot must contain app writes, so let the app commit some before the backup starts.
      while (committed < 50) await new Promise((resolve) => setTimeout(resolve, 5))
      copying = true
      const proc = await startChild('create', live, join(root, 'b'))
      const result = await within(
        new Promise<{ name: string; path: string }>((resolve) =>
          proc.once('message', (message) => resolve(JSON.parse(String(message))))
        ),
        30_000,
        'backup in a separate process'
      ).finally(() => {
        copying = false
        done = true
      })
      await writer
      await stopChild(proc)

      const maxLatency = Math.max(...latencies)
      assert.isAbove(duringCopy, 20, 'the app kept writing during the copy')
      // Shared CI runners add scheduling noise; locally the budget is 100 ms.
      const budget = process.env.CI ? 250 : 100
      assert.isBelow(maxLatency, budget, `max write latency ${maxLatency.toFixed(1)} ms`)

      verifyBundle(join(root, 'b'), result.name)
      const copy = openDatabase(join(result.path, 'db.sqlite'), { readonly: true })
      try {
        const sum = copy.prepare('SELECT sum(balance) AS s FROM accounts').get() as { s: number }
        const counter = copy.prepare('SELECT n FROM counter').get() as { n: number }
        const rows = copy.prepare('SELECT count(*) AS c FROM ledger').get() as { c: number }
        assert.equal(sum.s, 1000)
        assert.equal(counter.n, rows.c)
        assert.isAtLeast(rows.c, 160_050, 'the snapshot includes the app writes made before it')
      } finally {
        copy.close()
      }
      console.log(
        `    WAL: ${duringCopy} app writes during the copy, max ${maxLatency.toFixed(1)} ms`
      )
    } finally {
      await app.terminate()
    }
  }).timeout(60_000)
})

test('disabled provider boots; commands recover from an explicit directory and reject directory on writers', async ({
  assert,
}) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root, { withBackupConfig: 'disabled' })
  try {
    const db = openDatabase(live)
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
    db.close()
    const directory = join(root, 'archive')
    prepareDirectory(directory)
    const result = await createBundle({ livePath: live, directory })
    const service = await app.container.make('sqlite.backup')
    assert.instanceOf(service, SqliteBackup)
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const disabled = await ace.exec('db:backup', ['create'])
    disabled.assertFailed()
    disabled.assertLogMatches(/E_BACKUP_DISABLED/)
    for (const operation of ['list', 'verify', 'restore-prepare']) {
      const command = await ace.exec('db:backup', [
        operation,
        '--directory',
        directory,
        ...(operation === 'restore-prepare' ? ['--target', join(root, 'recovered.db')] : []),
      ])
      command.assertSucceeded()
      command.assertLogMatches(new RegExp(result.name))
    }
    for (const operation of ['create', 'prune']) {
      const command = await ace.exec('db:backup', [operation, '--directory', directory])
      command.assertFailed()
      command.assertLogMatches(/only supported for list/)
    }
  } finally {
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test('command reports the original create failure and its cleanup failure', async ({ assert }) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root)
  try {
    const db = openDatabase(live)
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
    db.close()
    const original = new Error('original copy failure')
    InternalHooks.step = (step) => {
      if (step === 'create:copied') throw original
      if (step === 'create:cleanup') throw new Error('cleanup permission failure')
    }
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    assert.strictEqual(command.error, original)
    assert.equal(command.exitCode, 1)
    assert.lengthOf(
      ace.ui.logger.getLogs().filter((log) => log.message.includes('original copy failure')),
      1
    )
    command.assertLogMatches(/original copy failure/)
    command.assertLogMatches(/backup temp cleanup failed: Error: cleanup permission failure/)
  } finally {
    InternalHooks.step = undefined
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test('prune reports observed removals and earlier failures when archive sync fails', async ({
  assert,
}) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root)
  const directory = join(root, 'backups')
  try {
    openDatabase(live).close()
    prepareDirectory(directory)
    const oldest = await createBundle({ livePath: live, directory })
    const newest = await createBundle({ livePath: live, directory })
    const abandoned = 'bak-utc-20010101-000000-001'
    const interrupted = 'bak-utc-20010101-000000-002'
    mkdirSync(join(directory, abandoned))
    mkdirSync(join(directory, interrupted))
    InternalHooks.step = (step, name) => {
      if (step === 'prune:unpublished' && name === interrupted) throw new Error('remove failed')
    }
    const restoreSync = failDirectorySync(directory, new Error('final archive sync failed'))
    try {
      const ace = await app.container.make('ace')
      ace.ui.switchMode('raw')
      const command = await ace.exec('db:backup', ['prune', '--keep', '1'])
      command.assertFailed()
      command.assertLogMatches(/db:backup prune failed: final archive sync failed/)
      command.assertLogMatches(new RegExp(`Observed removed bundle: ${oldest.name}`))
      command.assertLogMatches(new RegExp(`Observed removed unfinished bundle: ${abandoned}`))
      command.assertLogMatches(new RegExp(`could not remove ${interrupted}: Error: remove failed`))
      command.assertLogMatches(/Archive sync failed. Removal durability is unconfirmed./)
      assert.isFalse(existsSync(oldest.path))
      assert.isTrue(existsSync(newest.path))
      assert.isFalse(existsSync(join(directory, abandoned)))
      assert.isTrue(existsSync(join(directory, interrupted)))
    } finally {
      restoreSync()
      InternalHooks.step = undefined
    }
  } finally {
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test('command distinguishes failed lock acquisition from failed native cleanup', async ({
  assert,
}) => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root)
  const prototype = Database.prototype as {
    exec: (this: { name: string }, sql: string) => unknown
    close: (this: { name: string }) => void
  }
  const originalExec = prototype.exec
  const originalClose = prototype.close
  let lockHandle: { name: string } | undefined
  prototype.exec = function (sql) {
    if (this.name.endsWith('/.backup.lock') && sql === 'BEGIN EXCLUSIVE') throw false
    return originalExec.call(this, sql)
  }
  prototype.close = function () {
    if (this.name.endsWith('/.backup.lock')) {
      lockHandle = this
      throw 0
    }
    originalClose.call(this)
  }
  try {
    openDatabase(live).close()
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/db:backup create failed: lock acquisition and close failed: false/)
    command.assertLogMatches(/backup native cleanup failed: 0/)
    assert.notInclude(
      ace.ui.logger
        .getLogs()
        .map(({ message }) => message)
        .join('\n'),
      'backup native cleanup failed: false'
    )
    assert.instanceOf(command.error, AggregateError)
    const aggregate = command.error as AggregateError
    assert.deepEqual(aggregate.errors, [false, 0])
    assert.strictEqual(aggregate.cause, false)
  } finally {
    prototype.exec = originalExec
    prototype.close = originalClose
    try {
      if (lockHandle) originalClose.call(lockHandle)
    } finally {
      try {
        await app.terminate()
      } finally {
        cleanup()
      }
    }
  }
}).timeout(30_000)

test('command reports rollback and close failures without hiding the create error', async () => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root)
  const prototype = Database.prototype as {
    exec: (this: { name: string }, sql: string) => unknown
    close: (this: { name: string }) => void
  }
  const originalExec = prototype.exec
  const originalClose = prototype.close
  let lockHandle: { name: string } | undefined
  prototype.exec = function (sql) {
    if (this.name.endsWith('/.backup.lock') && sql === 'ROLLBACK')
      throw new Error('rollback diagnostic')
    return originalExec.call(this, sql)
  }
  prototype.close = function () {
    if (this.name.endsWith('/.backup.lock')) {
      lockHandle = this
      throw new Error('close diagnostic')
    }
    originalClose.call(this)
  }
  InternalHooks.step = (step) => {
    if (step === 'create:copied') throw new Error('original copy diagnostic')
  }
  try {
    const db = openDatabase(live)
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
    db.close()
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/original copy diagnostic/)
    command.assertLogMatches(/backup native cleanup failed: Error: rollback diagnostic/)
    command.assertLogMatches(/backup native cleanup failed: Error: close diagnostic/)
  } finally {
    InternalHooks.step = undefined
    prototype.exec = originalExec
    prototype.close = originalClose
    try {
      if (lockHandle) {
        try {
          originalExec.call(lockHandle, 'ROLLBACK')
        } finally {
          originalClose.call(lockHandle)
        }
      }
      if (existsSync(join(root, 'backups'))) acquireLock(join(root, 'backups')).release()
    } finally {
      try {
        await app.terminate()
      } finally {
        cleanup()
      }
    }
  }
}).timeout(30_000)

test('command reports a falsy temporary cleanup failure', async () => {
  const { root, cleanup } = createTemporaryRoot()
  const { app, live } = await bootApp(root)
  try {
    const db = openDatabase(live)
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
    db.close()
    InternalHooks.step = (step) => {
      if (step === 'create:copied') throw new Error('original copy failure')
      if (step === 'create:cleanup') throw 0
    }
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/original copy failure/)
    command.assertLogMatches(/backup temp cleanup failed: 0/)
  } finally {
    InternalHooks.step = undefined
    try {
      await app.terminate()
    } finally {
      cleanup()
    }
  }
}).timeout(30_000)
