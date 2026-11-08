import { prepared } from './helpers.js'
/**
 * Independent review findings (F1-F11) and rules the review found untested (M1-M16).
 * Each test names the finding or mutation it pins.
 */
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { defineConfig } from '../src/define_config.js'
import { internalHooks } from '../src/internal_hooks.js'
import { acquireLock } from '../src/lock.js'
import { bundleName, parseBundleName } from '../src/names.js'
import { sha256File } from '../src/fs.js'
import { pruneBundles } from '../src/prune.js'
import { prepareRestore } from '../src/restore.js'
import { SqliteBackup } from '../src/sqlite_backup.js'
import { makeLiveDatabase, overwrite, startChild, stopChild, tempRoot } from './helpers.js'

/** The error code thrown by `fn`, 'raw:<code>' for a non-package error, or 'no error'. */
const codeOf = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (error) {
    const e = error as { code?: string; name?: string }
    return e.name === 'BackupException' || e.constructor?.name === 'BackupException'
      ? e.code
      : `raw:${e.code}`
  }
  return 'no error'
}
const T = Date.UTC(2026, 10, 7, 12, 0, 0, 0)
const sqliteConfig = (filename: string) => ({
  connection: 'main',
  connections: { main: { client: 'better-sqlite3', connection: { filename } } },
})

test.group('review findings', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    live = join(root, 'live.db')
    directory = join(root, 'b')
    return () => {
      delete internalHooks.step
      cleanup()
    }
  })

  test('F1: a file or symlink at the chosen name is refused and left alone', async ({ assert }) => {
    makeLiveDatabase(live).close()
    mkdirSync(directory)
    writeFileSync(join(directory, bundleName(T)), 'not ours')
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory, now: () => T }))),
      'E_BACKUP_UNSAFE'
    )
    assert.equal(readFileSync(join(directory, bundleName(T)), 'utf8'), 'not ours')

    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    symlinkSync(outside, join(directory, bundleName(T + 5)))
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory, now: () => T + 5 }))),
      'E_BACKUP_UNSAFE'
    )
    assert.isTrue(lstatSync(join(directory, bundleName(T + 5))).isSymbolicLink())
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep')
  })

  test('F2: a far-future stray bundle is refused, not leapfrogged; invalid dates are not bundles', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    const stray = join(directory, 'bak-utc-99991231-235959-999')
    mkdirSync(stray, { recursive: true })
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory, now: () => T }))),
      'E_BACKUP_UNSAFE'
    )
    assert.isTrue(existsSync(stray))
    rmSync(stray, { recursive: true })

    assert.throws(() => bundleName(Date.UTC(10000, 0, 1)))
    assert.throws(() => parseBundleName('bak-utc-20261399-000000-000'), /not a bundle name/)
    mkdirSync(join(directory, 'bak-utc-20261332-000000-000'))
    const created = await createBundle(prepared({ livePath: live, directory, now: () => T }))
    assert.equal(created.name, bundleName(T))
    assert.deepEqual(
      listBundles(directory).map((b) => b.name),
      [bundleName(T)]
    )
    assert.deepEqual(pruneBundles({ directory, keep: 1 }).abandoned, [])
    assert.isTrue(existsSync(join(directory, 'bak-utc-20261332-000000-000')))
  })

  test('F3: a target reaching the live path through a symlinked folder is refused', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory }))
    const liveDir = join(root, 'data')
    mkdirSync(liveDir)
    const missingLive = join(liveDir, 'app.db')
    symlinkSync(liveDir, join(root, 'alias'))
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: join(root, 'alias', 'app.db'), livePath: missingLive })
      ),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(missingLive))
  })

  test('F4: hashing streams, so files over 2 GiB work', async ({ assert }) => {
    const big = join(root, 'big.bin')
    const size = 2 ** 31 + 4096
    // Sparse: no disk or memory cost.
    closeSync(openSync(big, 'w'))
    truncateSync(big, size)
    const expected = createHash('sha256')
    const zeros = Buffer.alloc(1 << 20)
    for (let left = size; left > 0; left -= zeros.length) {
      expected.update(left >= zeros.length ? zeros : zeros.subarray(0, left))
    }
    assert.equal(sha256File(big), expected.digest('hex'))
  }).timeout(120_000)

  test('F5: raw errors become BackupExceptions; a damaged lock file is recovered', async ({
    assert,
  }) => {
    writeFileSync(live, 'x'.repeat(8192))
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory }))),
      'E_BACKUP_SOURCE'
    )
    rmSync(live)
    mkdirSync(live)
    await assert.rejects(
      () => createBundle(prepared({ livePath: live, directory })),
      /is not an existing file/
    )
    rmSync(live, { recursive: true })

    makeLiveDatabase(live).close()
    writeFileSync(join(directory, '.backup.lock'), 'x'.repeat(8192))
    const created = await createBundle(prepared({ livePath: live, directory }))
    const held = acquireLock(directory)
    assert.equal(await codeOf(() => acquireLock(directory)), 'E_BACKUP_LOCKED')
    held.release()

    rmSync(join(directory, '.backup.lock'))
    mkdirSync(join(directory, '.backup.lock'))
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory }))),
      'E_BACKUP_UNSAFE'
    )
    rmSync(join(directory, '.backup.lock'), { recursive: true })
    // A symlinked lock file is refused: recovery must never truncate a file outside the folder.
    const precious = join(root, 'precious.txt')
    writeFileSync(precious, 'x'.repeat(8192))
    symlinkSync(precious, join(directory, '.backup.lock'))
    assert.equal(await codeOf(() => acquireLock(directory)), 'E_BACKUP_UNSAFE')
    assert.equal(readFileSync(precious, 'utf8').length, 8192)
    rmSync(join(directory, '.backup.lock'))
    // Also when the outside file is a usable (empty) lock file: SQLite would lock it otherwise.
    const outside = join(root, 'outside.lock')
    writeFileSync(outside, '')
    symlinkSync(outside, join(directory, '.backup.lock'))
    assert.equal(await codeOf(() => acquireLock(directory)), 'E_BACKUP_UNSAFE')
    rmSync(join(directory, '.backup.lock'))

    chmodSync(join(created.path, 'db.sqlite'), 0o600)
    unlinkSync(join(created.path, 'db.sqlite'))
    assert.equal(await codeOf(() => verifyBundle(directory, created.name)), 'E_BACKUP_INVALID')
  })

  test('F6: a symlinked bundle name is not a bundle', async ({ assert }) => {
    makeLiveDatabase(live).close()
    const real = await createBundle(prepared({ livePath: live, directory }))
    const alias = bundleName(parseBundleName(real.name) + 1)
    symlinkSync(real.path, join(directory, alias))
    assert.equal(await codeOf(() => verifyBundle(directory, alias)), 'E_BACKUP_UNSAFE')
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, name: alias, target: join(root, 's.db'), livePath: live })
      ),
      'E_BACKUP_UNSAFE'
    )
  })

  test('F7: a missing target folder is E_BACKUP_UNSAFE, not E_BACKUP_NOT_FOUND', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory }))
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: join(root, 'missing', 's.db'), livePath: live })
      ),
      'E_BACKUP_UNSAFE'
    )
  })

  test('F8: a dangling sidecar symlink blocks restore', async ({ assert }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory }))
    const target = join(root, 's.db')
    symlinkSync(join(root, 'nowhere'), `${target}-wal`)
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(target))
  })

  test('F9: a backup folder that aliases the live folder is refused; "..x.db" is inside', async ({
    assert,
  }) => {
    const liveDir = join(root, 'data')
    mkdirSync(liveDir)
    const liveFile = join(liveDir, 'app.db')
    makeLiveDatabase(liveFile).close()
    symlinkSync(liveDir, join(root, 'alias'))
    assert.equal(
      await codeOf(() =>
        createBundle(prepared({ livePath: liveFile, directory: join(root, 'alias') }))
      ),
      'E_BACKUP_UNSAFE'
    )
    const odd = join(directory, '..x.db')
    mkdirSync(directory)
    makeLiveDatabase(odd).close()
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: odd, directory }))),
      'E_BACKUP_UNSAFE'
    )
  })

  test('F10: list and verify racing prune give no raw error and no false INVALID', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    const a = await createBundle(prepared({ livePath: live, directory }))
    const b = await createBundle(prepared({ livePath: live, directory }))
    internalHooks.step = (step) => {
      if (step === 'list:read') rmSync(a.path, { recursive: true, force: true })
    }
    assert.deepEqual(
      listBundles(directory).map((x) => x.name),
      [b.name]
    )
    internalHooks.step = (step) => {
      if (step === 'verify:selected') {
        chmodSync(join(b.path, 'db.sqlite'), 0o600)
        unlinkSync(join(b.path, 'READY'))
        unlinkSync(join(b.path, 'db.sqlite'))
      }
    }
    assert.equal(await codeOf(() => verifyBundle(directory, b.name)), 'E_BACKUP_NOT_FOUND')
  })

  test('F11: manifest.createdAt is the real clock time even when the name is adjusted', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory, now: () => T }))
    const back = await createBundle(
      prepared({ livePath: live, directory, now: () => T - 3_600_000 })
    )
    assert.equal(back.name, bundleName(T + 1))
    assert.equal(back.manifest.createdAt, new Date(T - 3_600_000).toISOString())
  })
})

test.group('rules the review found untested', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    live = join(root, 'live.db')
    directory = join(root, 'b')
    makeLiveDatabase(live).close()
    return () => {
      delete internalHooks.step
      cleanup()
    }
  })

  test('M1: create checks the copy, not the live file', async ({ assert }) => {
    internalHooks.step = (step, file) => {
      if (step === 'create:copied') {
        // Break an index inside the copy only; the live file stays clean.
        overwrite(file, 4096 * 3, 'zzzzzzzzzzzz')
      }
    }
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: live, directory }))),
      'E_BACKUP_INVALID'
    )
    assert.deepEqual(listBundles(directory), [])
  })

  for (const sidecar of ['-wal', '-shm', '-journal']) {
    test(`M2: a stale ${sidecar} next to the target blocks restore`, async ({ assert }) => {
      await createBundle(prepared({ livePath: live, directory }))
      const target = join(root, 's.db')
      writeFileSync(`${target}${sidecar}`, 'stale')
      assert.equal(
        await codeOf(() => prepareRestore({ directory, target, livePath: live })),
        'E_BACKUP_UNSAFE'
      )
    })
  }

  test('M3/M4: symlinks and unanchored names are not bundles for list or prune', async ({
    assert,
  }) => {
    const real = await createBundle(prepared({ livePath: live, directory, now: () => T }))
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'READY'), '')
    symlinkSync(outside, join(directory, bundleName(T - 10)))
    mkdirSync(join(directory, `x${bundleName(T - 20)}`))
    assert.deepEqual(
      listBundles(directory).map((b) => b.name),
      [real.name]
    )
    const result = pruneBundles({ directory, keep: 1 })
    assert.deepEqual(result, { removed: [], abandoned: [], failed: [] })
    assert.isTrue(existsSync(join(outside, 'READY')))
    assert.isTrue(existsSync(join(directory, `x${bundleName(T - 20)}`)))
  })

  test('M5: a live file nested below the backup folder is refused', async ({ assert }) => {
    mkdirSync(join(directory, 'sub'), { recursive: true })
    const nested = join(directory, 'sub', 'app.db')
    makeLiveDatabase(nested).close()
    assert.equal(
      await codeOf(() => createBundle(prepared({ livePath: nested, directory }))),
      'E_BACKUP_UNSAFE'
    )
  })

  test('M6/M7: the service passes requireWal and lockTimeoutMs through', async ({ assert }) => {
    const rollback = join(root, 'rollback.db')
    makeLiveDatabase(rollback, { wal: false }).close()
    const strict = new SqliteBackup(
      defineConfig({ directory, requireWal: true }),
      sqliteConfig(rollback)
    )
    strict.prepareDirectory()
    assert.equal(await codeOf(() => strict.create()), 'E_BACKUP_SOURCE')
    mkdirSync(directory, { recursive: true })
    const holder = await startChild('lock', directory, '300')
    try {
      const patient = new SqliteBackup(
        defineConfig({ directory, lockTimeoutMs: 5000 }),
        sqliteConfig(live)
      )
      const created = await patient.create()
      assert.isTrue(existsSync(join(created.path, 'READY')))
    } finally {
      await stopChild(holder)
    }
  }).timeout(20_000)

  test('M8: a manifest with an unknown format is refused even if the hash matches', async ({
    assert,
  }) => {
    const b = await createBundle(prepared({ livePath: live, directory }))
    const path = join(b.path, 'manifest.json')
    chmodSync(path, 0o600)
    writeFileSync(path, JSON.stringify({ ...b.manifest, format: 2 }))
    assert.equal(await codeOf(() => verifyBundle(directory, b.name)), 'E_BACKUP_INVALID')
  })

  test('M10: list and prune order by name, not by directory order', async ({ assert }) => {
    const names = [3, 1, 4, 0, 2].map((i) => bundleName(T + i))
    for (const name of names) {
      mkdirSync(join(directory, name), { recursive: true })
      writeFileSync(join(directory, name, 'READY'), '')
      writeFileSync(
        join(directory, name, 'manifest.json'),
        JSON.stringify({ format: 1, sha256: 'unused', createdAt: new Date(T).toISOString() })
      )
    }
    prepared({ directory })
    const sorted = [...names].sort()
    assert.deepEqual(
      listBundles(directory).map((b) => b.name),
      sorted
    )
    assert.deepEqual(pruneBundles({ directory, keep: 2 }).removed, sorted.slice(0, 3))
  })

  test('M11: restore refuses a bundle without READY even if the manifest is fine', async ({
    assert,
  }) => {
    const b = await createBundle(prepared({ livePath: live, directory }))
    chmodSync(join(b.path, 'READY'), 0o600)
    unlinkSync(join(b.path, 'READY'))
    const target = join(root, 's.db')
    assert.equal(
      await codeOf(() => prepareRestore({ directory, name: b.name, target, livePath: live })),
      'E_BACKUP_INVALID'
    )
    assert.isFalse(existsSync(target))
  })

  test('M12: unfinished bundles do not count toward keep', async ({ assert }) => {
    const a = await createBundle(prepared({ livePath: live, directory, now: () => T }))
    const b = await createBundle(prepared({ livePath: live, directory, now: () => T + 1 }))
    mkdirSync(join(directory, bundleName(T + 2)))
    const result = pruneBundles({ directory, keep: 2 })
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.abandoned, [bundleName(T + 2)])
    assert.deepEqual(
      listBundles(directory).map((x) => x.name),
      [a.name, b.name]
    )
  })

  test('M14: the service refuses the live path as a restore target', async ({ assert }) => {
    await createBundle(prepared({ livePath: live, directory }))
    const service = new SqliteBackup(defineConfig({ directory }), sqliteConfig(live))
    for (const path of [live, `${live}-wal`, `${live}-shm`]) rmSync(path, { force: true })
    assert.throws(
      () => service.prepareRestore({ target: live }),
      /restore target is the live database/
    )
    assert.isFalse(existsSync(live))
  })

  test('M16: the staged copy gets the integrity check, not only the checksum', async ({
    assert,
  }) => {
    const b = await createBundle(prepared({ livePath: live, directory }))
    const db = join(b.path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 3, 'zzzzzzzzzzzz')
    const manifestPath = join(b.path, 'manifest.json')
    chmodSync(manifestPath, 0o600)
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...b.manifest, sha256: sha256File(db), bytes: lstatSync(db).size })
    )
    const target = join(root, 's.db')
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_INVALID'
    )
    assert.isFalse(existsSync(target))
  })
})
