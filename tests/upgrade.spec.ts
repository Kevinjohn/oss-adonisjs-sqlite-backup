/**
 * `db:upgrade` inside a booted AdonisJS + Lucid app: the real command through the ace kernel,
 * running real migrations.
 */
import { test } from '@japa/runner'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BaseCommand } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { readManifest, verifyBundle } from '../src/bundles.ts'
import { defineConfig } from '../src/define_config.ts'
import type { BackupConfigInput } from '../src/types.ts'
import { openDatabase } from '../src/native.ts'
import { preMigrationBackupDirectory } from '../index.ts'
import DbUpgrade from '../commands/db_upgrade.ts'
import { startChild, stopChild, createTemporaryRoot } from './helpers.ts'

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

async function bootApp(
  root: string,
  options: {
    filename?: string
    backups?: string
    backup?: Omit<BackupConfigInput, 'directory'>
    migrationsTable?: string
  } = {}
) {
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
              ...(options.migrationsTable
                ? { migrations: { tableName: options.migrationsTable } }
                : {}),
            },
          },
        }),
        ...(options.backups
          ? { backup: defineConfig({ ...options.backup, directory: options.backups }) }
          : {}),
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

// Mirrors the application wrapper: the child has already reported an unsuccessful upgrade.
class AppUpgrade extends BaseCommand {
  static commandName = 'app:upgrade'
  async run() {
    const upgrade = await this.kernel.exec('db:upgrade', ['--no-schema-generate'])
    if (upgrade.exitCode !== 0) this.exitCode = upgrade.exitCode ?? 1
  }
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
    const temp = createTemporaryRoot()
    root = temp.root
    return async () => {
      await app?.terminate()
      app = undefined
      temp.cleanup()
    }
  })

  test('describes the schema-generate flag as it behaves', ({ assert }) => {
    const flag = DbUpgrade.flags.find((candidate) => candidate.name === 'schemaGenerate')
    assert.equal(
      flag?.description,
      'Generate schema classes with schema:generate after a successful migration, never in production'
    )
  })

  test('preMigrationBackupDirectory prefers the configured directory', ({ assert }) => {
    assert.equal(
      preMigrationBackupDirectory('/srv/app/live.db', '/srv/backups'),
      join('/srv/backups', 'pre-migration')
    )
    assert.equal(preMigrationBackupDirectory('live.db'), `${resolve('live.db')}.backups`)
    assert.equal(preMigrationBackupDirectory('live.db', ''), `${resolve('live.db')}.backups`)
  })

  test('pre-migration paths follow symlinks before parent traversal', ({ assert }) => {
    mkdirSync(join(root, 'deep', 'nested'), { recursive: true })
    mkdirSync(join(root, 'deep', 'store'))
    writeFileSync(join(root, 'deep', 'live.db'), '')
    symlinkSync(join(root, 'deep', 'nested'), join(root, 'alias'))
    const configured = `${root}/alias/../store`
    const database = `${root}/alias/../live.db`
    assert.equal(
      preMigrationBackupDirectory(database, configured),
      join(realpathSync.native(configured), 'pre-migration')
    )
    assert.equal(preMigrationBackupDirectory(database), `${realpathSync.native(database)}.backups`)
  })

  test('migrates an empty database without a pre-migration backup bundle', async ({ assert }) => {
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
    assert.include(booted.logs(), '❯ migrated database/migrations/001_heroes')
    assert.notInclude(booted.logs(), 'Pre-upgrade backup written')
    assert.isFalse(existsSync(join(root, 'backups')))
    const repeated = await booted.upgrade()
    repeated.assertSucceeded()
    assert.include(booted.logs(), 'Already up to date')
  })

  test('backs up an existing database under the configured directory before migrating', async ({
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
    assert.include(booted.logs(), 'live database uses journal_mode=delete, not WAL')
    assert.deepEqual(tables(join(bundle.path, 'db.sqlite')), ['villains'])
  })

  test('records the configured migrations table in the pre-migration backup bundle', async ({
    assert,
  }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, {
      backups: join(root, 'backups'),
      migrationsTable: 'schema_versions',
    })
    app = booted.app
    // The first run migrates an empty database, so it creates the journal without a backup bundle.
    const first = await booted.upgrade()
    first.assertSucceeded()
    writeMigration(root, '002_teams', "this.schema.createTable('teams', (t) => t.increments('id'))")
    const second = await booted.upgrade()
    second.assertSucceeded()
    const bundle = verifyBundle(join(root, 'backups', 'pre-migration'))
    assert.deepEqual(readManifest(bundle).migrations, {
      table: 'schema_versions',
      count: 1,
      last: 'database/migrations/001_heroes',
    })
  })

  test('refuses to back up a rollback-journal database when requireWal is set', async ({
    assert,
  }) => {
    openDatabase(join(root, 'live.db')).exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, {
      backups: join(root, 'backups'),
      backup: { requireWal: true },
    })
    app = booted.app
    const command = await booted.upgrade()
    assert.equal(command.exitCode, 1)
    assert.include(booted.logs(), 'Upgrade failed: ')
    assert.include(booted.logs(), 'not WAL')
    assert.notInclude(tables(booted.live), 'heroes')
  })

  test('waits lockTimeoutMs for a held backup lock before refusing', async ({ assert }) => {
    openDatabase(join(root, 'live.db')).exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const directory = join(root, 'backups', 'pre-migration')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const booted = await bootApp(root, {
      backups: join(root, 'backups'),
      backup: { lockTimeoutMs: 1000 },
    })
    app = booted.app
    // The child holds the lock until it is stopped, so the command can only time out. Without the
    // configured timeout it would refuse at once instead of after the full second.
    const holder = await startChild('lock', directory)
    try {
      const started = Date.now()
      const command = await booted.upgrade()
      assert.equal(command.exitCode, 1)
      assert.isAtLeast(Date.now() - started, 1000)
      assert.include(booted.logs(), 'is locked')
    } finally {
      await stopChild(holder)
    }
    assert.notInclude(tables(booted.live), 'heroes')
  }).timeout(20_000)

  test('backs up beside the database when backups are not configured', async ({ assert }) => {
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

  test('skips the pre-migration backup bundle for an in-memory database', async ({ assert }) => {
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

  test('does not migrate when the pre-migration backup bundle cannot be written', async ({
    assert,
  }) => {
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
    assert.instanceOf(command.error, Error)
    assert.lengthOf(booted.logs().split('Upgrade failed: '), 2)
    assert.notInclude(tables(booted.live), 'heroes')
  })

  test('refuses an archive containing the live database before preparing it', async ({
    assert,
  }) => {
    const backups = join(root, 'backups')
    const directory = join(backups, 'pre-migration')
    mkdirSync(directory, { recursive: true })
    chmodSync(directory, 0o750)
    const live = join(directory, 'live.db')
    const seed = openDatabase(live)
    try {
      seed.exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
      seed.exec('CREATE TABLE adonis_schema (id INTEGER PRIMARY KEY, name VARCHAR, batch INTEGER)')
      seed.exec("INSERT INTO adonis_schema (name, batch) VALUES ('known migration', 1)")
      seed.exec('CREATE TABLE adonis_schema_versions (version INTEGER PRIMARY KEY)')
      seed.exec('INSERT INTO adonis_schema_versions (version) VALUES (2)')
    } finally {
      seed.close()
    }
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root, { filename: live, backups })
    app = booted.app
    const command = await booted.upgrade()
    assert.equal(command.exitCode, 1)
    assert.include(booted.logs(), 'contains the live database')
    assert.equal(statSync(directory).mode & 0o777, 0o750)
    assert.notInclude(tables(live), 'heroes')
    const database = openDatabase(live, { readonly: true })
    try {
      assert.deepEqual(database.prepare('SELECT name, batch FROM adonis_schema').all(), [
        { name: 'known migration', batch: 1 },
      ])
    } finally {
      database.close()
    }
  })

  test('keeps a usable pre-migration backup bundle when a migration fails', async ({ assert }) => {
    const seed = openDatabase(join(root, 'live.db'))
    try {
      seed.exec('CREATE TABLE villains (id INTEGER PRIMARY KEY, name TEXT)')
      seed.exec("INSERT INTO villains (id, name) VALUES (1, 'known row')")
    } finally {
      seed.close()
    }
    writeMigration(root, '001_broken', "await this.db.rawQuery('SELECT * FROM no_such_table')")
    const booted = await bootApp(root)
    app = booted.app
    const command = await booted.upgrade()
    assert.isAbove(command.exitCode ?? 0, 0)
    assert.include(command.error?.message, 'no such table: no_such_table')
    const bundle = verifyBundle(`${booted.live}.backups`)
    assert.include(booted.logs(), `Pre-upgrade backup written ${bundle.path}`)
    const database = openDatabase(join(bundle.path, 'db.sqlite'), { readonly: true })
    try {
      assert.deepEqual(database.prepare('SELECT id, name FROM villains').all(), [
        { id: 1, name: 'known row' },
      ])
    } finally {
      database.close()
    }
  })

  test('reports a failed migration as one error line without a stack trace', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    writeMigration(root, '002_broken', "await this.db.rawQuery('SELECT * FROM no_such_table')")
    const booted = await bootApp(root)
    app = booted.app
    const ace = await booted.app.container.make('ace')
    // Ace renders a command's unhandled error, with its stack, through the kernel's handler.
    const rendered: unknown[] = []
    const render = ace.errorHandler.render.bind(ace.errorHandler)
    ace.errorHandler.render = async (error, kernel) => {
      rendered.push(error)
      await render(error, kernel)
    }
    const command = await booted.upgrade()
    assert.equal(command.exitCode, 1)
    assert.include(command.error?.message, 'no such table: no_such_table')
    assert.lengthOf(rendered, 0)
    const errors = ace.ui.logger.getLogs().filter((log) => log.stream === 'stderr')
    assert.lengthOf(errors, 1)
    assert.include(errors[0]!.message, 'Upgrade failed: ')
    assert.include(errors[0]!.message, 'no such table: no_such_table')
    assert.notInclude(errors[0]!.message, '\n')
    assert.include(booted.logs(), 'database/migrations/001_heroes')
    assert.include(booted.logs(), 'database/migrations/002_broken')
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

  test('refuses an invalid configured filename before backing up or migrating', async ({
    assert,
  }) => {
    const seed = openDatabase(join(root, 'live.db'))
    try {
      seed.exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    } finally {
      seed.close()
    }
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const backups = join(root, 'backups')
    const booted = await bootApp(root, { backups })
    app = booted.app
    const db = await booted.app.container.make('lucid.db')
    const original = db.getRawConnection.bind(db)
    db.getRawConnection = ((name: string) => {
      const connection = original(name)
      return connection
        ? {
            ...connection,
            config: {
              ...connection.config,
              connection: {
                ...(connection.config.connection as Record<string, unknown>),
                filename: 'file:memory.db',
              },
            },
          }
        : connection
    }) as typeof db.getRawConnection
    try {
      const command = await booted.upgrade()
      assert.equal(command.exitCode, 1)
      assert.include(booted.logs(), 'db:upgrade requires a file-backed SQLite connection')
    } finally {
      db.getRawConnection = original
    }
    assert.isFalse(existsSync(backups))
    assert.notInclude(tables(booted.live), 'heroes')
  })

  test('fails when a migration fails even with schema generation on', async ({ assert }) => {
    writeMigration(root, '001_broken', "await this.db.rawQuery('SELECT * FROM no_such_table')")
    const booted = await bootApp(root)
    app = booted.app
    const command = await booted.upgrade([])
    assert.isAbove(command.exitCode ?? 0, 0)
    assert.isFalse(existsSync(join(root, 'database', 'schema.ts')))
  })

  test('reports a schema generation failure after migrating', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    // A directory where the generated file belongs makes schema:generate fail.
    mkdirSync(join(root, 'database', 'schema.ts'))
    const booted = await bootApp(root)
    app = booted.app
    const ace = await app.container.make('ace')
    const rendered: unknown[] = []
    const render = ace.errorHandler.render.bind(ace.errorHandler)
    ace.errorHandler.render = async (error, kernel) => {
      rendered.push(error)
      await render(error, kernel)
    }
    const command = await booted.upgrade([])
    assert.isAbove(command.exitCode ?? 0, 0)
    assert.instanceOf(command.error, Error)
    assert.deepEqual(rendered, [command.error])
    const errors = ace.ui.logger.getLogs().filter((log) => log.stream === 'stderr')
    assert.lengthOf(errors, 1)
    assert.notInclude(booted.logs(), 'Upgrade failed:')
    assert.include(tables(booted.live), 'heroes')
  })

  test('a wrapper reports backup and migration failures once', async ({ assert }) => {
    const seed = openDatabase(join(root, 'live.db'))
    seed.exec('CREATE TABLE villains (id INTEGER PRIMARY KEY)')
    seed.close()
    writeMigration(root, '001_broken', "await this.db.rawQuery('SELECT * FROM no_such_table')")
    writeFileSync(join(root, 'occupied'), 'not a directory')
    const booted = await bootApp(root, { backups: join(root, 'occupied') })
    app = booted.app
    const ace = await app.container.make('ace')
    const first = await ace.create(AppUpgrade, [])
    await first.exec()
    assert.equal(first.exitCode, 1)
    assert.lengthOf(
      ace.ui.logger.getLogs().filter((log) => log.message.includes('Upgrade failed:')),
      1
    )
    assert.notInclude(tables(booted.live), 'adonis_schema')
    // Repair the destination and run the same wrapper against the failing migration.
    app.config.set('backup', defineConfig({ directory: join(root, 'backups') }))
    const second = await ace.create(AppUpgrade, [])
    await second.exec()
    assert.equal(second.exitCode, 1)
    const logs = ace.ui.logger.getLogs().map((log) => log.message)
    assert.lengthOf(
      logs.filter((message) => message.includes('Upgrade failed:')),
      2
    )
    assert.lengthOf(
      logs.filter((message) => message.includes('no such table: no_such_table')),
      1
    )
    assert.isTrue(logs.some((message) => message.includes('Pre-upgrade backup written')))
  })

  test('preserves a schema child exit code without an error object', async ({ assert }) => {
    const booted = await bootApp(root)
    app = booted.app
    const ace = await app.container.make('ace')
    const exec = ace.exec.bind(ace)
    ace.exec = (async (name, argv, options) => {
      if (name === 'schema:generate') {
        ace.ui.logger.error('schema child failed')
        return { exitCode: 7, error: undefined }
      }
      return exec(name, argv, options)
    }) as typeof ace.exec
    const command = await booted.upgrade([])
    assert.equal(command.exitCode, 7)
    assert.isUndefined(command.error)
    assert.lengthOf(
      ace.ui.logger.getLogs().filter((log) => log.message.includes('schema child failed')),
      1
    )
    assert.notInclude(booted.logs(), 'Upgrade failed:')
  })

  test('does not generate schema classes in production', async ({ assert }) => {
    writeMigration(
      root,
      '001_heroes',
      "this.schema.createTable('heroes', (t) => t.increments('id'))"
    )
    const booted = await bootApp(root)
    app = booted.app
    Object.defineProperty(booted.app, 'inProduction', { value: true })
    const command = await booted.upgrade([])
    command.assertSucceeded()
    assert.include(tables(booted.live), 'heroes')
    assert.isFalse(existsSync(join(root, 'database', 'schema.ts')))
  })

  test('generates schema classes after migrating unless told not to', async ({ assert }) => {
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
