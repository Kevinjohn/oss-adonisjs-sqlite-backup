import { prepared } from './helpers.js'
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'
import { test } from '@japa/runner'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { checkDatabase } from '../src/checks.js'
import { acquireLock } from '../src/lock.js'
import { internalHooks } from '../src/internal_hooks.js'
import { bundleName } from '../src/names.js'
import { openDatabase } from '../src/native.js'
import { SqliteBackup } from '../src/sqlite_backup.js'
import {
  countItems,
  makeLiveDatabase,
  overwrite,
  startChild,
  stopChild,
  tempRoot,
  within,
} from './helpers.js'

const code = (error: unknown) => (error as { code?: string }).code

test.group('createBundle', (group) => {
  let root: string
  let cleanup: () => void
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    return () => cleanup()
  })

  test('owned reads refuse a source filename changed by the native driver', async ({ assert }) => {
    const ordinary = join(root, 'live.db')
    const spaced = `${ordinary} `
    const alias = join(root, 'alias.db')
    const directory = join(root, 'backups')
    const original = makeLiveDatabase(join(root, 'original.db'), { rows: 3 })
    original.close()
    assert.equal(countItems(join(root, 'original.db')), 3)
    renameSync(join(root, 'original.db'), spaced)
    makeLiveDatabase(ordinary, { rows: 7 }).close()
    assert.equal(countItems(ordinary), 7)
    const spacedBytes = readFileSync(spaced)
    const ordinaryBytes = readFileSync(ordinary)
    symlinkSync(spaced, alias)

    const config = {
      connection: 'main',
      connections: { main: { client: 'sqlite3', connection: { filename: spaced } } },
    }
    const service = new SqliteBackup(
      { directory, keep: 7, lockTimeoutMs: 0, requireWal: false },
      config
    )
    prepared({ directory })
    for (const check of [
      () => service.checkSource(),
      () => service.create(),
      () => createBundle(prepared({ livePath: spaced, directory })),
      () => createBundle(prepared({ livePath: alias, directory })),
    ]) {
      const error = await Promise.resolve()
        .then(check)
        .catch((caught: unknown) => caught)
      assert.equal((error as { code?: string } | undefined)?.code, 'E_BACKUP_SOURCE')
      assert.match(String(error), /better-sqlite3 changes its filename/)
    }
    assert.deepEqual(readFileSync(spaced), spacedBytes)
    assert.deepEqual(readFileSync(ordinary), ordinaryBytes)
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith('bak-')),
      []
    )

    const normal = new SqliteBackup(
      { directory, keep: 7, lockTimeoutMs: 0, requireWal: false },
      {
        connection: 'main',
        connections: { main: { client: 'sqlite3', connection: { filename: ordinary } } },
      }
    )
    normal.checkSource()
    const result = await normal.create()
    assert.equal(countItems(join(result.path, 'db.sqlite')), 7)
  })

  test('publishes db, manifest and READY; files are read-only', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const result = await createBundle(prepared({ livePath: live, directory: join(root, 'b') }))
    assert.deepEqual(readdirSync(result.path).sort(), ['READY', 'db.sqlite', 'manifest.json'])
    for (const file of ['READY', 'db.sqlite', 'manifest.json']) {
      assert.equal(statSync(join(result.path, file)).mode & 0o777, 0o400, file)
    }
    const mtime = (file: string) => statSync(join(result.path, file), { bigint: true }).mtimeNs
    assert.isTrue(mtime('READY') >= mtime('manifest.json'), 'READY after manifest')
    assert.isTrue(mtime('manifest.json') >= mtime('db.sqlite'), 'manifest after database')
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'))
    assert.equal(manifest.sha256, result.manifest.sha256)
    assert.equal(manifest.sourceJournalMode, 'wal')
    assert.deepEqual(result.warnings, [])
    assert.equal(countItems(join(result.path, 'db.sqlite')), 200)
    assert.deepEqual(
      listBundles(join(root, 'b')).map((b) => b.name),
      [result.name]
    )
  })

  test('finishes while another process writes continuously', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live, { rows: 20_000 }).close()
    const writer = await startChild('writer', live)
    try {
      const result = await within(
        createBundle(prepared({ livePath: live, directory: join(root, 'b') })),
        15_000,
        'backup under sustained writes'
      )
      assert.isAtLeast(countItems(join(result.path, 'db.sqlite')), 20_000)
    } finally {
      await stopChild(writer)
    }
  }).timeout(30_000)

  test('a second create waits while the first backup yields in this process', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live, { rows: 20_000 }).close()
    const directory = join(root, 'b')
    let resolveCopying!: () => void
    const copying = new Promise<void>((resolve) => {
      resolveCopying = resolve
    })
    const prior = internalHooks.step
    internalHooks.step = (step) => {
      if (step === 'create:copying') resolveCopying()
    }
    try {
      const first = createBundle(prepared({ livePath: live, directory }))
      await copying
      const second = createBundle(prepared({ livePath: live, directory, lockTimeoutMs: 5_000 }))
      const [one, two] = await within(Promise.all([first, second]), 10_000, 'overlapping creates')
      assert.notEqual(one.name, two.name)
      assert.equal(listBundles(directory).length, 2)
    } finally {
      internalHooks.step = prior
    }
  }).timeout(15_000)

  test('a failed check publishes nothing', async ({ assert }) => {
    const live = join(root, 'live.db')
    const db = makeLiveDatabase(live)
    db.pragma('foreign_keys = OFF')
    db.prepare('INSERT INTO items(body, parent_id) VALUES (?, 999)').run('orphan')
    db.close()
    const directory = join(root, 'b')
    await assert.rejects(
      () => createBundle(prepared({ livePath: live, directory })),
      /foreign_key_check/
    )
    assert.deepEqual(
      readdirSync(directory).filter((n) => n.startsWith('bak-')),
      []
    )
  })

  test('failed create unpublishes READY before a refused recursive cleanup', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    mkdirSync(directory)
    let readyWritten = false
    internalHooks.durability = (event, path) => {
      if (event === 'write' && path.endsWith('/READY')) readyWritten = true
      if (readyWritten && event === 'sync' && path === directory)
        throw new Error('post publication failure')
    }
    internalHooks.step = (step) => {
      if (step === 'create:cleanup') throw new Error('recursive cleanup refused')
    }
    try {
      const error = await createBundle({ livePath: live, directory }).catch(
        (caught: unknown) => caught
      )
      assert.match(String(error), /post publication failure/)
      assert.match(
        String((error as { cleanupError?: unknown }).cleanupError),
        /recursive cleanup refused/
      )
      const bundles = readdirSync(directory).filter((name) => name.startsWith('bak-'))
      assert.lengthOf(bundles, 1)
      assert.isFalse(existsSync(join(directory, bundles[0], 'READY')))
    } finally {
      delete internalHooks.durability
      delete internalHooks.step
    }
  })

  test('source close failure preserves the create error and still releases the lock', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    mkdirSync(directory)
    const prototype = Database.prototype as { close: (this: { name: string }) => void }
    const originalClose = prototype.close
    let failedHandle: { name: string } | undefined
    prototype.close = function () {
      if (this.name === live) {
        failedHandle = this
        throw new Error('source close failed')
      }
      originalClose.call(this)
    }
    internalHooks.step = (step) => {
      if (step === 'create:copied') throw new Error('copy interrupted')
    }
    try {
      const error = await createBundle({ livePath: live, directory }).catch(
        (caught: unknown) => caught
      )
      assert.match(String(error), /copy interrupted/)
      assert.match(
        String((error as { resourceCleanupErrors?: unknown[] }).resourceCleanupErrors?.[0]),
        /source close failed/
      )
      acquireLock(directory).release()
    } finally {
      delete internalHooks.step
      prototype.close = originalClose
      if (failedHandle) originalClose.call(failedHandle)
    }
  })

  test('keeps a non-Error copy failure with a source close failure', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    const prototype = Database.prototype as { close: (this: { name: string }) => void }
    const originalClose = prototype.close
    const closeFailure = new Error('source close failure')
    let source: { name: string } | undefined
    prototype.close = function () {
      if (this.name === live) {
        source = this
        throw closeFailure
      }
      originalClose.call(this)
    }
    internalHooks.step = (step) => {
      if (step === 'create:copied') throw null
    }
    try {
      const failure = await createBundle(prepared({ livePath: live, directory })).catch(
        (error: unknown) => error
      )
      assert.instanceOf(failure, AggregateError)
      assert.deepEqual((failure as AggregateError).errors, [null, closeFailure])
      assert.deepEqual((failure as { resourceCleanupErrors: unknown[] }).resourceCleanupErrors, [
        closeFailure,
      ])
      assert.deepEqual(listBundles(directory), [])
    } finally {
      delete internalHooks.step
      prototype.close = originalClose
      if (source) originalClose.call(source)
    }
  })

  test('aggregates multiple native cleanup failures after a completed copy', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    mkdirSync(directory)
    const lockPath = join(directory, '.backup.lock')
    const prototype = Database.prototype as { close: (this: { name: string }) => void }
    const originalClose = prototype.close
    const sourceFailure = new Error('source close failure')
    const lockFailure = new Error('lock close failure')
    const handles: Array<{ name: string }> = []
    prototype.close = function () {
      if (this.name === live) {
        handles.push(this)
        throw sourceFailure
      }
      if (this.name === lockPath) {
        handles.push(this)
        throw lockFailure
      }
      originalClose.call(this)
    }
    try {
      const failure = await createBundle({ livePath: live, directory }).catch(
        (error: unknown) => error
      )
      assert.instanceOf(failure, AggregateError)
      assert.deepEqual((failure as AggregateError).errors, [sourceFailure, lockFailure])
      assert.deepEqual((failure as { resourceCleanupErrors: unknown[] }).resourceCleanupErrors, [
        sourceFailure,
        lockFailure,
      ])
      assert.deepEqual(listBundles(directory), [])
    } finally {
      prototype.close = originalClose
      for (const handle of handles) originalClose.call(handle)
    }
  })

  test('native cleanup failures after READY leave no published recovery point', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    mkdirSync(directory)
    const prototype = Database.prototype as { close: (this: { name: string }) => void }
    const originalClose = prototype.close
    for (const failedPath of [live, join(directory, '.backup.lock')]) {
      let failedHandle: { name: string } | undefined
      prototype.close = function () {
        if (this.name === failedPath) {
          failedHandle = this
          throw new Error('native close failed')
        }
        originalClose.call(this)
      }
      internalHooks.step = (step) => {
        if (step === 'create:cleanup') throw new Error('recursive cleanup refused')
      }
      try {
        const error = await createBundle({ livePath: live, directory }).catch(
          (caught: unknown) => caught
        )
        assert.match(String(error), /native close failed/)
        assert.match(
          String((error as { cleanupError?: unknown }).cleanupError),
          /recursive cleanup refused/
        )
        assert.deepEqual(listBundles(directory), [])
        assert.throws(() => verifyBundle(directory), /no READY bundle/)
      } finally {
        delete internalHooks.step
        prototype.close = originalClose
        if (failedHandle) originalClose.call(failedHandle)
      }
    }
  })

  test('non-Error work and recursive cleanup failures both remain observable', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    internalHooks.step = (step) => {
      if (step === 'create:copied') throw null
      if (step === 'create:cleanup') throw 0
    }
    try {
      const failure = await createBundle(prepared({ livePath: live, directory })).catch(
        (error: unknown) => error
      )
      assert.instanceOf(failure, AggregateError)
      assert.deepEqual((failure as AggregateError).errors, [null, 0])
      assert.isTrue(Object.hasOwn(failure as object, 'cleanupError'))
      assert.equal((failure as { cleanupError: unknown }).cleanupError, 0)
    } finally {
      delete internalHooks.step
    }
  })

  test('checkDatabase reports page corruption', async ({ assert }) => {
    const path = join(root, 'corrupt.db')
    makeLiveDatabase(path, { rows: 2000, wal: false }).close()
    assert.isNull(checkDatabase(path))
    overwrite(path, 4096 * 40, 'zzzzzzzzzzzz') // page header, not row text
    assert.isNotNull(checkDatabase(path))
    assert.match(checkDatabase(join(root, 'missing.db'))!, /cannot open/)
  })

  test('checkDatabase reports an index that disagrees with its table', async ({ assert }) => {
    const path = join(root, 'index.db')
    const db = openDatabase(path)
    db.exec(
      'CREATE TABLE small(k TEXT); CREATE INDEX small_k ON small(k);' +
        "INSERT INTO small VALUES ('aaaaaaaaaaaaaaaa'), ('bbbbbbbbbbbbbbbb'), ('cccccccccccccccc')"
    )
    const { r: rootPage } = db
      .prepare("SELECT rootpage AS r FROM sqlite_schema WHERE name = 'small_k'")
      .get() as { r: number }
    db.close()
    // Change one key inside the index leaf: the file stays readable, integrity_check returns rows.
    overwrite(path, rootPage * 4096 - 8, 'zzzz')
    assert.equal(checkDatabase(path), 'integrity_check: row 1 missing from index small_k')
  })

  test('a non-WAL source warns, or fails when WAL is required', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live, { wal: false }).close()
    const directory = join(root, 'b')
    const warned = await createBundle(prepared({ livePath: live, directory }))
    assert.match(warned.warnings[0]!, /journal_mode=delete/)
    try {
      await createBundle(prepared({ livePath: live, directory, requireWal: true }))
      assert.fail('should require WAL')
    } catch (error) {
      assert.equal(code(error), 'E_BACKUP_SOURCE')
    }
    assert.lengthOf(
      readdirSync(directory).filter((n) => n.startsWith('bak-')),
      1
    )
  })

  test('names keep increasing when the clock steps back', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    const t = Date.UTC(2030, 0, 1)
    const first = await createBundle(prepared({ livePath: live, directory, now: () => t }))
    // Back 23 h: within the allowance, so the name follows the newest bundle.
    const second = await createBundle(
      prepared({ livePath: live, directory, now: () => t - 23 * 3_600_000 })
    )
    assert.isTrue(second.name > first.name)
    assert.equal(second.name, bundleName(t + 1))
    // Back 25 h: refused instead of naming a bundle a day ahead of the clock.
    await assert.rejects(
      () => createBundle(prepared({ livePath: live, directory, now: () => t - 25 * 3_600_000 })),
      /more than 24 h after the clock/
    )
  })

  test('refuses while locked, and refuses a directory holding the live file', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    mkdirSync(directory)
    const lock = acquireLock(directory)
    try {
      await createBundle(prepared({ livePath: live, directory }))
      assert.fail('should be locked')
    } catch (error) {
      assert.equal(code(error), 'E_BACKUP_LOCKED')
    } finally {
      lock.release()
    }
    try {
      await createBundle(prepared({ livePath: live, directory: root }))
      assert.fail('should refuse')
    } catch (error) {
      assert.equal(code(error), 'E_BACKUP_UNSAFE')
    }
    try {
      await createBundle(prepared({ livePath: join(root, 'missing.db'), directory }))
      assert.fail('should refuse')
    } catch (error) {
      assert.equal(code(error), 'E_BACKUP_SOURCE')
    }
    assert.isFalse(existsSync(join(root, 'missing.db')))
  })
})
