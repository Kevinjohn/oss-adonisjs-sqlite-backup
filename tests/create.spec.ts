import { prepared } from './helpers.js'
import { test } from '@japa/runner'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles } from '../src/bundles.js'
import { checkDatabase } from '../src/checks.js'
import { acquireLock } from '../src/lock.js'
import { bundleName } from '../src/names.js'
import { openDatabase } from '../src/native.js'
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
