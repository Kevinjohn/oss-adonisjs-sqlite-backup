import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { transpileModule, ModuleKind } from 'typescript'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import * as backupPackage from '@kevinjohn/adonisjs-sqlite-backup'
import * as backupTypes from '@kevinjohn/adonisjs-sqlite-backup/types'
import * as backupCommands from '@kevinjohn/adonisjs-sqlite-backup/commands'
import BackupProvider from '@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider'

const require = createRequire(import.meta.url)
for (const entry of ['.', './types', './commands', './sqlite_backup_provider', './services/main']) {
  const path = require.resolve(
    entry === '.'
      ? '@kevinjohn/adonisjs-sqlite-backup'
      : `@kevinjohn/adonisjs-sqlite-backup/${entry.slice(2)}`
  )
  assert(path.includes('/node_modules/'), `${entry} did not resolve from installed package`)
}
assert.equal(typeof backupPackage.configure, 'function')
assert.equal(typeof backupPackage.defineConfig, 'function')
assert.equal(typeof backupCommands.getCommand, 'function')
assert.deepEqual(
  (await backupCommands.getMetaData()).map((command) => command.commandName).sort(),
  ['db:backup', 'db:upgrade']
)
assert.equal(typeof BackupProvider, 'function')
assert(backupTypes)

const root = process.cwd()
await mkdir(join(root, 'config'), { recursive: true })
await writeFile(join(root, 'tsconfig.json'), '{}')
await writeFile(
  join(root, 'adonisrc.ts'),
  `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [] })\n`
)
const configureIgnitor = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({ rcFileContents: { providers: [], commands: [async () => new ListLoader([Configure])] } })
  .create(pathToFileURL(`${root}/`), { importer: (specifier) => import(specifier) })
await configureIgnitor.ace().handle(['configure', '@kevinjohn/adonisjs-sqlite-backup'])
const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
assert(rc.includes('@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider'))
assert(rc.includes('@kevinjohn/adonisjs-sqlite-backup/commands'))
const config = await readFile(join(root, 'config/backup.ts'), 'utf8')
assert(config.includes("from '@kevinjohn/adonisjs-sqlite-backup'"))
const editedConfig = config.replace('keep: 7', 'keep: 12')
assert.notEqual(config, editedConfig)
await writeFile(join(root, 'config/backup.ts'), editedConfig)
await configureIgnitor.ace().handle(['configure', '@kevinjohn/adonisjs-sqlite-backup'])
assert.equal(await readFile(join(root, 'adonisrc.ts'), 'utf8'), rc)
assert.equal(await readFile(join(root, 'config/backup.ts'), 'utf8'), editedConfig)

for (const source of ['adonisrc.ts', 'config/backup.ts']) {
  const compiled = transpileModule(await readFile(join(root, source), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext },
    fileName: source,
  })
  await writeFile(join(root, source.replace(/\.ts$/, '.js')), compiled.outputText)
}
const generatedRc = (await import(pathToFileURL(join(root, 'adonisrc.js')).href)).default
const generatedBackup = (await import(pathToFileURL(join(root, 'config/backup.js')).href)).default

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
      backup: generatedBackup,
    },
    rcFileContents: {
      providers: [() => import('@adonisjs/lucid/database_provider'), ...generatedRc.providers],
      commands: generatedRc.commands,
    },
  })
  .create(pathToFileURL(`${root}/`))
const app = ignitor.createApp('console')
try {
  await app.init()
  await app.boot()
  await app.start(() => {})
  const db = await app.container.make('lucid.db')
  await db.rawQuery('PRAGMA journal_mode = WAL')
  await db.rawQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
  await db.table('items').insert({ body: 'packed consumer' })
  const ace = await app.container.make('ace')
  ace.ui.switchMode('raw')
  for (const args of [['create'], ['list'], ['verify']]) {
    const result = await ace.exec('db:backup', args)
    result.assertSucceeded()
  }
  const service = await app.container.make('sqlite.backup')
  const { default: importedService } =
    await import('@kevinjohn/adonisjs-sqlite-backup/services/main')
  assert.equal(importedService, service)
  assert.equal(service.config.keep, 12)
  assert.equal(service.list().length, 1)
  assert(existsSync(join(service.list()[0].path, 'db.sqlite')))
  await db.table('items').insert({ body: 'live only' })
  const target = join(root, 'staged.db')
  const staged = await ace.exec('db:backup', ['restore-prepare', '--target', target])
  staged.assertSucceeded()
  const { default: Database } = await import('better-sqlite3')
  const stagedDatabase = new Database(target, { readonly: true, fileMustExist: true })
  try {
    assert.deepEqual(stagedDatabase.prepare('SELECT body FROM items ORDER BY id').all(), [
      { body: 'packed consumer' },
    ])
  } finally {
    stagedDatabase.close()
  }
  assert.deepEqual(await db.from('items').select('body').orderBy('id'), [
    { body: 'packed consumer' },
    { body: 'live only' },
  ])
} finally {
  await app.terminate()
}
