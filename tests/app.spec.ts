/**
 * In-app integration: a booted AdonisJS app with Lucid and this provider, driving the real
 * `db:backup` command through the ace kernel while Lucid keeps writing on its own connection.
 */
import { test } from '@japa/runner'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { internalHooks } from '../src/internal_hooks.js'
import { prepareDirectory } from '../src/directory.js'
import { createBundle } from '../src/bundles.js'
import { defineConfig } from '../src/define_config.js'
import { SqliteBackup } from '../src/sqlite_backup.js'
import SqliteBackupProvider from '../providers/sqlite_backup_provider.js'
import { verifyBundle } from '../src/bundles.js'
import { openDatabase } from '../src/native.js'
import { countItems, startChild, stopChild, tempRoot, within } from './helpers.js'

async function bootApp(root: string, withBackupConfig: boolean | 'disabled' = true) {
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
                directory: withBackupConfig === 'disabled' ? '' : join(root, 'backups'),
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

test.group('db:backup inside a booted AdonisJS + Lucid app', (group) => {
  let root: string
  let cleanup: () => void
  let app: ApplicationService
  let live: string
  group.each.setup(async () => {
    ;({ root, cleanup } = tempRoot())
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

  test('command errors: unknown action, missing target, rollback-journal warning', async ({
    assert,
  }) => {
    const db = await app.container.make('lucid.db')
    await db.rawQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const unknown = await ace.exec('db:backup', ['explode'])
    unknown.assertFailed()
    unknown.assertLogMatches(/unknown action/)
    const noTarget = await ace.exec('db:backup', ['restore-prepare'])
    noTarget.assertFailed()
    noTarget.assertLogMatches(/needs --target/)
    const create = await ace.exec('db:backup', ['create'])
    create.assertSucceeded()
    create.assertLogMatches(/journal_mode=delete/)
    const verify = await ace.exec('db:backup', ['verify', '--bundle', 'nope'])
    verify.assertFailed()
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
  test('without config/backup.ts the binding fails with a fix-it message', async ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const { app } = await bootApp(root, false)
    try {
      await assert.rejects(() => app.container.make('sqlite.backup'), /node ace configure/)
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
    ;({ root, cleanup } = tempRoot())
    return () => cleanup()
  })

  test('writers stay fast and the bundle is one consistent snapshot', async ({ assert }) => {
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
  const { root, cleanup } = tempRoot()
  const { app, live } = await bootApp(root, 'disabled')
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
    for (const action of ['list', 'verify', 'restore-prepare']) {
      const command = await ace.exec('db:backup', [
        action,
        '--directory',
        directory,
        ...(action === 'restore-prepare' ? ['--target', join(root, 'recovered.db')] : []),
      ])
      command.assertSucceeded()
      command.assertLogMatches(new RegExp(result.name))
    }
    for (const action of ['create', 'prune']) {
      const command = await ace.exec('db:backup', [action, '--directory', directory])
      command.assertFailed()
      command.assertLogMatches(/only supported for list/)
    }
  } finally {
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)

test('command reports the original create failure and its cleanup failure', async () => {
  const { root, cleanup } = tempRoot()
  const { app, live } = await bootApp(root)
  try {
    const db = openDatabase(live)
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)')
    db.close()
    internalHooks.step = (step) => {
      if (step === 'create:copied') throw new Error('original copy failure')
      if (step === 'create:cleanup') throw new Error('cleanup permission failure')
    }
    const ace = await app.container.make('ace')
    ace.ui.switchMode('raw')
    const command = await ace.exec('db:backup', ['create'])
    command.assertFailed()
    command.assertLogMatches(/original copy failure/)
    command.assertLogMatches(/backup temp cleanup failed: Error: cleanup permission failure/)
  } finally {
    delete internalHooks.step
    await app.terminate()
    cleanup()
  }
}).timeout(30_000)
