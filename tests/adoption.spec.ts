import { test } from '@japa/runner'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { prepareDirectory } from '../src/directory.js'
import { defineConfig } from '../src/define_config.js'
import { internalHooks } from '../src/internal_hooks.js'
import { openDatabase } from '../src/native.js'
import { pruneBundles } from '../src/prune.js'
import { prepareRestore } from '../src/restore.js'
import { SqliteBackup } from '../src/sqlite_backup.js'
import { makeLiveDatabase, tempRoot } from './helpers.js'

const codeOf = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (error) {
    return (error as { code: string }).code
  }
  return 'success'
}

test.group('host adoption contracts', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    live = join(root, 'live.db')
    directory = join(root, 'backups')
    return () => {
      delete internalHooks.step
      cleanup()
    }
  })

  test('borrowed exclusive handle stays usable on success and failure; path form refuses the lock', async ({
    assert,
  }) => {
    const database = makeLiveDatabase(live)
    prepareDirectory(directory)
    database.pragma('locking_mode = EXCLUSIVE')
    database.exec('BEGIN EXCLUSIVE; COMMIT')
    try {
      const service = new SqliteBackup(defineConfig({ directory }), undefined)
      let result!: Awaited<ReturnType<typeof service.create>>
      await assert.doesNotReject(async () => {
        result = await service.create({ database })
      })
      assert.equal(verifyBundle(directory, result.name).name, result.name)
      assert.doesNotThrow(() => {
        assert.deepEqual(database.prepare('SELECT count(*) AS n FROM items').get(), { n: 200 })
      })
      internalHooks.step = (step) => {
        if (step === 'create:copied') throw new Error('injected copy failure')
      }
      await assert.rejects(
        () => createBundle({ source: { database }, directory }),
        /injected copy failure/
      )
      database.exec("INSERT INTO items(body) VALUES ('still usable')")
      assert.deepEqual(database.prepare('SELECT count(*) AS n FROM items').get(), { n: 201 })
      delete internalHooks.step
      assert.equal(
        await codeOf(() => createBundle({ livePath: live, directory })),
        'E_BACKUP_SOURCE'
      )
    } finally {
      database.close()
    }
    const memory = openDatabase(':memory:')
    try {
      assert.equal(
        await codeOf(() => createBundle({ source: { database: memory }, directory })),
        'E_BACKUP_SOURCE'
      )
    } finally {
      memory.close()
    }
  }).timeout(15_000)

  test('only explicit preparation creates a root; scheduled create, list and prune refuse its loss', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    assert.equal(
      await codeOf(() => createBundle({ livePath: live, directory })),
      'E_BACKUP_NOT_FOUND'
    )
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_NOT_FOUND')
    assert.equal(await codeOf(() => pruneBundles({ directory, keep: 1 })), 'E_BACKUP_NOT_FOUND')
    assert.isFalse(existsSync(directory))
    prepareDirectory(directory)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.deepEqual(listBundles(directory), [])
    for (const mode of [0o720, 0o702]) {
      chmodSync(directory, mode)
      for (const operation of [
        () => createBundle({ livePath: live, directory }),
        () => pruneBundles({ directory, keep: 1 }),
        () => prepareRestore({ livePath: live, directory, target: join(root, 'stage.db') }),
      ])
        assert.equal(await codeOf(operation), 'E_BACKUP_UNSAFE')
    }
    prepareDirectory(directory)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    const result = await createBundle({ livePath: live, directory })
    assert.equal(verifyBundle(directory, result.name).name, result.name)
    rmSync(directory, { recursive: true })
    assert.equal(
      await codeOf(() => createBundle({ livePath: live, directory })),
      'E_BACKUP_NOT_FOUND'
    )
    writeFileSync(directory, 'not a folder')
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_UNSAFE')
  })

  test('disabled service refuses configured operations and allows explicit recovery directories', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    prepareDirectory(directory)
    const made = await createBundle({ livePath: live, directory })
    const database = {
      connection: 'sqlite',
      connections: { sqlite: { client: 'better-sqlite3', connection: { filename: live } } },
    }
    const backup = new SqliteBackup(defineConfig({}), database)
    for (const operation of [
      () => backup.livePath(),
      () => backup.checkSource(),
      () => backup.prepareDirectory(),
      () => backup.create(),
      () => backup.list(),
      () => backup.verify(),
      () => backup.prepareRestore({ target: join(root, 'disabled.db') }),
      () => backup.prune(),
    ]) {
      assert.equal(await codeOf(operation), 'E_BACKUP_DISABLED')
    }
    assert.equal(backup.list(directory)[0]!.createdAt, made.manifest.createdAt)
    assert.equal(backup.verify(made.name, directory).name, made.name)
    assert.equal(
      backup.prepareRestore({ directory, target: join(root, 'recovered.db') }).bundle,
      made.name
    )
  })

  test('checkSource opens without making a backup and refuses a missing or corrupt source', async ({
    assert,
  }) => {
    const database = {
      connection: 'sqlite',
      connections: { sqlite: { client: 'better-sqlite3', connection: { filename: live } } },
    }
    const backup = new SqliteBackup(defineConfig({ directory }), database)
    assert.equal(await codeOf(() => backup.checkSource()), 'E_BACKUP_SOURCE')
    assert.isFalse(existsSync(live))
    writeFileSync(live, 'not sqlite')
    assert.equal(await codeOf(() => backup.checkSource()), 'E_BACKUP_SOURCE')
    rmSync(live)
    makeLiveDatabase(live).close()
    backup.checkSource()
    assert.isFalse(existsSync(directory))
  })

  test('captures all source migration rows, validates the copy, and persists the selected journal', async ({
    assert,
  }) => {
    const database = makeLiveDatabase(live)
    database.exec(
      "CREATE TABLE custom_journal(id INTEGER PRIMARY KEY, name TEXT, batch INTEGER); INSERT INTO custom_journal VALUES (1, 'first', 1), (2, 'second', 1)"
    )
    database.close()
    prepareDirectory(directory)
    const config = {
      connection: 'default',
      connections: {
        default: {
          client: 'better-sqlite3',
          connection: { filename: join(root, 'wrong.db') },
          migrations: { tableName: 'wrong_journal' },
        },
        selected: {
          client: 'better-sqlite3',
          connection: { filename: live },
          migrations: { tableName: 'custom_journal' },
        },
      },
    }
    const service = new SqliteBackup(defineConfig({ directory, connection: 'selected' }), config)
    const made = await service.create()
    assert.deepEqual(made.manifest.migrations, {
      table: 'custom_journal',
      count: 2,
      last: 'second',
    })
    assert.equal(verifyBundle(directory).name, made.name)
    const manifest = join(made.path, 'manifest.json')
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const replacement of [
      { ...data.migrations, count: 3 },
      { ...data.migrations, last: 'wrong' },
      { ...data.migrations, table: 'missing' },
    ]) {
      chmodSync(manifest, 0o600)
      writeFileSync(manifest, JSON.stringify({ ...data, migrations: replacement }))
      assert.equal(await codeOf(() => verifyBundle(directory)), 'E_BACKUP_INVALID')
      assert.equal(
        await codeOf(() =>
          prepareRestore({ directory, livePath: live, target: join(root, 'invalid.db') })
        ),
        'E_BACKUP_INVALID'
      )
      assert.isFalse(existsSync(join(root, 'invalid.db')))
    }
    internalHooks.step = (step, file) => {
      if (step === 'create:copied') {
        const copy = openDatabase(file)
        try {
          copy.exec('UPDATE custom_journal SET batch = 99 WHERE id = 1')
        } finally {
          copy.close()
        }
      }
    }
    await assert.rejects(() => service.create(), /migration journal custom_journal mismatch/)
  })

  test('default migration journal supports an empty table and quoted table identifiers', async ({
    assert,
  }) => {
    const database = makeLiveDatabase(live)
    database.exec(
      'CREATE TABLE adonis_schema(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE "odd""name"(id INTEGER PRIMARY KEY, name TEXT)'
    )
    database.close()
    prepareDirectory(directory)
    const result = await createBundle({ livePath: live, directory })
    assert.deepEqual(result.manifest.migrations, { table: 'adonis_schema', count: 0, last: null })
    verifyBundle(directory)
    const quoted = await createBundle({ livePath: live, directory, migrationsTable: 'odd"name' })
    verifyBundle(directory, quoted.name)
    assert.equal(quoted.manifest.migrations!.table, 'odd"name')
  })

  test('listing reports manifest time, keeps name order and skips concurrently removed publications', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    prepareDirectory(directory)
    const now = Date.UTC(2030, 0, 1)
    const first = await createBundle({ livePath: live, directory, now: () => now })
    const second = await createBundle({ livePath: live, directory, now: () => now - 1000 })
    assert.deepEqual(
      listBundles(directory).map((bundle) => [bundle.name, bundle.createdAt]),
      [
        [first.name, first.manifest.createdAt],
        [second.name, second.manifest.createdAt],
      ]
    )
    mkdirSync(join(directory, 'bak-utc-20300101-000001-000'))
    internalHooks.step = (step, path) => {
      if (step === 'list:ready' && path === first.path) rmSync(join(path, 'READY'))
    }
    assert.doesNotThrow(() => {
      assert.deepEqual(
        listBundles(directory).map((bundle) => bundle.name),
        [second.name]
      )
    })
    internalHooks.step = (step, path) => {
      if (step === 'list:ready') rmSync(join(path, 'manifest.json'))
    }
    assert.doesNotThrow(() => {
      assert.deepEqual(listBundles(directory), [])
    })
    delete internalHooks.step
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_INVALID')
    writeFileSync(join(second.path, 'manifest.json'), '{')
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_INVALID')
    writeFileSync(
      join(second.path, 'manifest.json'),
      JSON.stringify({ ...second.manifest, createdAt: 'invalid' })
    )
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_INVALID')
  })
})

test('recovery selects the newest READY bundle without reading older malformed manifests', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  try {
    const live = join(root, 'live.db')
    const directory = join(root, 'bundles')
    makeLiveDatabase(live).close()
    prepareDirectory(directory)
    const old = await createBundle({ livePath: live, directory })
    const newest = await createBundle({ livePath: live, directory })
    chmodSync(join(old.path, 'manifest.json'), 0o600)
    writeFileSync(join(old.path, 'manifest.json'), '{')
    assert.throws(() => listBundles(directory), /manifest is unreadable/)
    assert.doesNotThrow(() => {
      assert.equal(verifyBundle(directory).name, newest.name)
    })
    assert.doesNotThrow(() => {
      assert.equal(
        prepareRestore({ directory, livePath: live, target: join(root, 'stage.db') }).bundle,
        newest.name
      )
    })
  } finally {
    cleanup()
  }
})

test('borrowed BigInt handles read the main mixed-case journal without changing global settings', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  const live = join(root, 'live.db')
  const directory = join(root, 'bundles')
  const database = makeLiveDatabase(live) as ReturnType<typeof makeLiveDatabase> & {
    defaultSafeIntegers(enabled: boolean): void
  }
  try {
    database.exec(
      `CREATE TABLE Adonis_Schema(id INTEGER PRIMARY KEY,name TEXT,batch INTEGER); INSERT INTO Adonis_Schema VALUES (9007199254740993,'baseline',1); CREATE TEMP TABLE adonis_schema(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO temp.adonis_schema VALUES (1,'temporary')`
    )
    database.defaultSafeIntegers(true)
    prepareDirectory(directory)
    let result!: Awaited<ReturnType<typeof createBundle>>
    await assert.doesNotReject(async () => {
      result = await createBundle({ source: { database }, directory })
    })
    assert.deepEqual(result.manifest.migrations, {
      table: 'adonis_schema',
      count: 1,
      last: 'baseline',
    })
    assert.equal(verifyBundle(directory).name, result.name)
    assert.deepEqual(database.prepare('SELECT id FROM main.adonis_schema').get(), {
      id: 9007199254740993n,
    })
    database.close()
    assert.equal(
      await codeOf(() => createBundle({ source: { database }, directory })),
      'E_BACKUP_SOURCE'
    )
  } finally {
    try {
      database.close()
    } finally {
      cleanup()
    }
  }
})

test('manifest metadata is validated and journal schema failures retain invalid-bundle meaning', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  try {
    const live = join(root, 'live.db')
    const directory = join(root, 'bundles')
    const database = makeLiveDatabase(live)
    database.exec('CREATE TABLE no_id(name TEXT)')
    database.close()
    prepareDirectory(directory)
    const result = await createBundle({ livePath: live, directory })
    const manifest = join(result.path, 'manifest.json')
    chmodSync(manifest, 0o600)
    const badMetadata = [
      null,
      false,
      0,
      [],
      {},
      { table: 1, count: 0, last: null },
      { table: '', count: 0, last: null },
      { table: 'adonis_schema', count: -1, last: null },
      { table: 'adonis_schema', count: 0.5, last: null },
      { table: 'adonis_schema', count: 0, last: 10 },
    ]
    for (const migrations of badMetadata) {
      writeFileSync(manifest, JSON.stringify({ ...result.manifest, migrations }))
      assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_INVALID')
      assert.equal(await codeOf(() => verifyBundle(directory)), 'E_BACKUP_INVALID')
      assert.equal(
        await codeOf(() =>
          prepareRestore({ directory, livePath: live, target: join(root, 'stage.db') })
        ),
        'E_BACKUP_INVALID'
      )
      assert.isFalse(existsSync(join(root, 'stage.db')))
    }
    writeFileSync(manifest, JSON.stringify({ ...result.manifest, createdAt: 'January 1, 2030' }))
    assert.equal(await codeOf(() => listBundles(directory)), 'E_BACKUP_INVALID')
    writeFileSync(
      manifest,
      JSON.stringify({ ...result.manifest, migrations: { table: 'no_id', count: 0, last: null } })
    )
    assert.equal(await codeOf(() => verifyBundle(directory)), 'E_BACKUP_INVALID')
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, livePath: live, target: join(root, 'stage.db') })
      ),
      'E_BACKUP_INVALID'
    )
    assert.isFalse(existsSync(join(root, 'stage.db')))
  } finally {
    cleanup()
  }
})

test('restore refuses absent live sidecars before copying and leaves the source usable', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  try {
    const live = join(root, 'live.db')
    const directory = join(root, 'bundles')
    makeLiveDatabase(live, { wal: false }).close()
    prepareDirectory(directory)
    await createBundle({ livePath: live, directory })
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const target = live + suffix
      assert.isFalse(existsSync(target))
      assert.equal(
        await codeOf(() => prepareRestore({ directory, livePath: live, target })),
        'E_BACKUP_UNSAFE'
      )
      assert.isFalse(existsSync(target))
    }
    const source = openDatabase(live)
    try {
      source.exec("INSERT INTO items(body) VALUES ('usable')")
    } finally {
      source.close()
    }
  } finally {
    cleanup()
  }
})

test('explicit recovery directory takes precedence over an enabled configured directory', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  try {
    const live = join(root, 'live.db')
    const directory = join(root, 'configured')
    const archive = join(root, 'archive')
    makeLiveDatabase(live).close()
    prepareDirectory(directory)
    prepareDirectory(archive)
    await createBundle({ livePath: live, directory, now: () => Date.UTC(2030, 0, 1) })
    const chosen = await createBundle({
      livePath: live,
      directory: archive,
      now: () => Date.UTC(2029, 0, 1),
    })
    const config = {
      connection: 'sqlite',
      connections: { sqlite: { client: 'better-sqlite3', connection: { filename: live } } },
    }
    const service = new SqliteBackup(defineConfig({ directory }), config)
    assert.deepEqual(
      service.list(archive).map((bundle) => bundle.name),
      [chosen.name]
    )
    assert.equal(service.verify(undefined, archive).name, chosen.name)
    assert.equal(
      service.prepareRestore({ directory: archive, target: join(root, 'recovered.db') }).bundle,
      chosen.name
    )
  } finally {
    cleanup()
  }
})

test('create rejects unsupported migration metadata without publishing a READY bundle', async ({
  assert,
}) => {
  const { root, cleanup } = tempRoot()
  try {
    const live = join(root, 'live.db')
    const directory = join(root, 'bundles')
    const database = makeLiveDatabase(live)
    database.exec(
      "CREATE TABLE adonis_schema(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO adonis_schema VALUES (1,x'62617365')"
    )
    database.close()
    prepareDirectory(directory)
    let failure: { code?: string; message?: string } | undefined
    try {
      await createBundle({ livePath: live, directory })
    } catch (error) {
      failure = error as { code?: string; message?: string }
    }
    assert.equal(failure?.code, 'E_BACKUP_INVALID')
    assert.match(failure!.message!, /unsupported migration metadata/)
    assert.deepEqual(listBundles(directory), [])
  } finally {
    cleanup()
  }
})
