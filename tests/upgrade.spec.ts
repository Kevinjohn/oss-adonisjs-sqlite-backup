/**
 * `db:upgrade` inside a booted AdonisJS + Lucid app: the real command through the ace kernel,
 * running real migrations.
 */
import { test } from '@japa/runner'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { verifyBundle } from '../src/bundles.js'
import { defineConfig } from '../src/define_config.js'
import { openDatabase } from '../src/native.js'
import { preMigrationBackupDirectory } from '../index.js'
import { tempRoot } from './helpers.js'

// Migration files live in a temporary directory, so they import Lucid by absolute URL.
const schemaModule = pathToFileURL(createRequire(import.meta.url).resolve('@adonisjs/lucid/schema'))

function writeMigration(root: string, name: string, body: string) {
  const directory = join(root, 'database', 'migrations')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${name}.js`),
    `import { BaseSchema } from '${schemaModule}'\nexport default class extends BaseSchema { async up() { ${body} } }\n`
  )
}

async function bootApp(root: string, options: { filename?: string; backups?: string } = {}) {
  const live = options.filename ?? join(root, 'live.db')
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
              pool: { min: 1, max: 1 },
            },
          },
        }),
        ...(options.backups ? { backup: defineConfig({ directory: options.backups }) } : {}),
      },
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('../providers/sqlite_backup_provider.js'),
        ],
        commands: [() => import('@adonisjs/lucid/commands'), () => import('../commands/main.js')],
      },
    })
    .create(pathToFileURL(`${root}/`))
  const app = ignitor.createApp('console') as ApplicationService
  await app.init()
  await app.boot()
  await app.start(() => {})
  const ace = await app.container.make('ace')
  ace.ui.switchMode('raw')
  const upgrade = (argv: string[] = ['--no-schema-generate']) => ace.exec('db:upgrade', argv)
  const logs = () =>
    ace.ui.logger
      .getLogs()
      .map((log) => log.message)
      .join('\n')
  return { app, live, upgrade, logs }
}

function tables(path: string): string[] {
  const database = openDatabase(path, { readonly: true })
  try {
    return (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((row) => row.name)
  } finally {
    database.close()
  }
}

test.group('db:upgrade', (group) => {
  let root: string
  let app: ApplicationService | undefined
  group.each.setup(() => {
    const temp = tempRoot()
    root = temp.root
    return async () => {
      await app?.terminate()
      app = undefined
      temp.cleanup()
    }
  })

  test('preMigrationBackupDirectory prefers the configured directory', ({ assert }) => {
    assert.equal(
      preMigrationBackupDirectory('/srv/app/live.db', '/srv/backups'),
      join('/srv/backups', 'pre-migration')
    )
    assert.equal(preMigrationBackupDirectory('live.db'), `${resolve('live.db')}.backups`)
    assert.equal(preMigrationBackupDirectory('live.db', ''), `${resolve('live.db')}.backups`)
  })

  test('migrates an empty database without a snapshot', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, { backups: join(root, 'backups') })
    app = booted.app
    const command = await booted.upgrade()
    command.assertSucceeded()
    assert.include(tables(booted.live), 'heroes')
    assert.notInclude(booted.logs(), 'Pre-upgrade backup written')
    assert.isFalse(existsSync(join(root, 'backups')))
  })

  test('snapshots an existing database under the configured directory before migrating', async ({
    assert,
  }) => {
    openDatabase(join(root, 'live.db')).exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, { backups: join(root, 'backups') })
    app = booted.app
    const command = await booted.upgrade()
    command.assertSucceeded()
    assert.include(tables(booted.live), 'heroes')
    const directory = join(root, 'backups', 'pre-migration')
    const bundle = verifyBundle(directory)
    assert.include(booted.logs(), `Pre-upgrade backup written ${bundle.path}`)
    assert.deepEqual(tables(join(bundle.path, 'db.sqlite')), ['villains'])
  })

  test('snapshots beside the database when backups are not configured', async ({ assert }) => {
    openDatabase(join(root, 'live.db')).exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root)
    app = booted.app
    const command = await booted.upgrade()
    command.assertSucceeded()
    assert.lengthOf(
      readdirSync(`${booted.live}.backups`).filter((name) => name.startsWith('bak-')),
      1
    )
  })

  test('skips the snapshot for an in-memory database', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, { filename: ':memory:' })
    app = booted.app
    const db = await booted.app.container.make('lucid.db')
    await db.rawQuery('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    const command = await booted.upgrade()
    command.assertSucceeded()
    assert.notInclude(booted.logs(), 'Pre-upgrade backup written')
    assert.isTrue(await db.connection().schema.hasTable('heroes'))
  })

  test('does not migrate when the snapshot cannot be written', async ({ assert }) => {
    openDatabase(join(root, 'live.db')).exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    writeFileSync(join(root, 'occupied'), 'not a directory')
    const booted = await bootApp(root, { backups: join(root, 'occupied') })
    app = booted.app
    const command = await booted.upgrade()
    assert.equal(command.exitCode, 1)
    assert.include(booted.logs(), 'Upgrade failed: ')
    assert.notInclude(tables(booted.live), 'heroes')
  })

  test('exits non-zero when a migration fails', async ({ assert }) => {
    writeMigration(root, '001_broken', "await this.db.rawQuery('SELECT * FROM no_such_table')")
    const booted = await bootApp(root)
    app = booted.app
    const command = await booted.upgrade()
    assert.isAbove(command.exitCode ?? 0, 0)
  })

  test('refuses a connection that is not better-sqlite3', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root)
    app = booted.app
    const db = await booted.app.container.make('lucid.db')
    const original = db.getRawConnection.bind(db)
    db.getRawConnection = ((name: string) => {
      const connection = original(name)
      return connection
        ? { ...connection, config: { ...connection.config, client: 'pg' } }
        : connection
    }) as typeof db.getRawConnection
    try {
      const command = await booted.upgrade()
      assert.equal(command.exitCode, 1)
      assert.include(
        booted.logs(),
        'Upgrade failed: Error: db:upgrade requires the configured SQLite connection'
      )
    } finally {
      db.getRawConnection = original
    }
    // Refused before any query, so the database file was never created.
    assert.isFalse(existsSync(booted.live))
  })

  test('lets migration:run generate schema classes unless told not to', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root)
    app = booted.app
    const quiet = await booted.upgrade(['--no-schema-generate'])
    quiet.assertSucceeded()
    const before = readdirSync(join(root, 'database'))
    writeMigration(root, '002_teams', "this.schema.createTable('teams', (t) => t.increments('id'))")
    const generating = await booted.upgrade([])
    generating.assertSucceeded()
    assert.isAbove(readdirSync(join(root, 'database')).length, before.length)
  })
})
