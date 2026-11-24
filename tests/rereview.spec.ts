import { BACKUP_ERROR_CODES, errors } from '../index.js'
import { prepared } from './helpers.js'
/**
 * Re-review findings (phase 6). Each test names the finding or mutation it pins.
 */
import { test } from '@japa/runner'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { internalHooks } from '../src/internal_hooks.js'
import { acquireLock } from '../src/lock.js'
import { openDatabase } from '../src/native.js'
import { prepareRestore } from '../src/restore.js'
import { makeLiveDatabase, createTemporaryRoot } from './helpers.js'

const readBackupErrorCode = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (error) {
    const code = (error as { code?: string }).code
    const backupCode = BACKUP_ERROR_CODES.find((candidate) => candidate === code)
    return backupCode && error instanceof errors[backupCode] ? backupCode : `raw:${code}`
  }
  return 'no error'
}

test.group('re-review', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = createTemporaryRoot())
    live = join(root, 'live.db')
    directory = join(root, 'b')
    return () => {
      delete internalHooks.step
      cleanup()
    }
  })

  test('P2: the live path is a dangling symlink; staging at its target is refused', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory }))
    const data = join(root, 'var', 'data')
    mkdirSync(data, { recursive: true })
    mkdirSync(join(root, 'app', 'tmp'), { recursive: true })
    const appPath = join(root, 'app', 'tmp', 'db.sqlite3')
    symlinkSync(join(data, 'db.sqlite3'), appPath) // the data file is lost: the link dangles
    assert.equal(
      await readBackupErrorCode(() =>
        prepareRestore({ directory, target: join(data, 'db.sqlite3'), livePath: appPath })
      ),
      'E_BACKUP_TARGET_LIVE'
    )
    // A two-hop chain, relative links included.
    const hop = join(root, 'app', 'hop')
    symlinkSync('tmp/db.sqlite3', hop)
    assert.equal(
      await readBackupErrorCode(() =>
        prepareRestore({ directory, target: join(data, 'db.sqlite3'), livePath: hop })
      ),
      'E_BACKUP_TARGET_LIVE'
    )
    assert.isFalse(existsSync(join(data, 'db.sqlite3')))
    // A symlink loop is refused, not followed forever.
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'))
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'))
    assert.equal(
      await readBackupErrorCode(() =>
        prepareRestore({ directory, target: join(root, 's.db'), livePath: join(root, 'loop-a') })
      ),
      'E_BACKUP_PATH_SYMLINK_LIMIT'
    )
  })

  test('P3: an unwritable target folder passes the permission error through', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory }))
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      assert.equal(
        await readBackupErrorCode(() =>
          prepareRestore({ directory, target: join(locked, 's.db'), livePath: live })
        ),
        'raw:EACCES'
      )
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  test('P3: a target inside the backup folder is refused', async ({ assert }) => {
    makeLiveDatabase(live).close()
    const b = await createBundle(prepared({ livePath: live, directory }))
    for (const target of [join(b.path, 'extra.db'), join(directory, 'staged.db')]) {
      assert.equal(
        await readBackupErrorCode(() => prepareRestore({ directory, target, livePath: live })),
        'E_BACKUP_TARGET_IN_ARCHIVE'
      )
      assert.isFalse(existsSync(target))
    }
  })

  test('P3: only EEXIST is "already exists"; other mkdir errors pass through', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    mkdirSync(directory)
    internalHooks.step = (step) => {
      if (step === 'create:naming') chmodSync(directory, 0o500)
    }
    try {
      assert.equal(
        await readBackupErrorCode(() => createBundle(prepared({ livePath: live, directory }))),
        'raw:EACCES'
      )
    } finally {
      chmodSync(directory, 0o700)
    }
    assert.deepEqual(listBundles(directory), [])
  })

  test('X19: a live path that is a symlink into the backup folder is refused', async ({
    assert,
  }) => {
    mkdirSync(directory)
    const inside = join(directory, 'real.db')
    makeLiveDatabase(inside).close()
    symlinkSync(inside, live)
    assert.equal(
      await readBackupErrorCode(() => createBundle(prepared({ livePath: live, directory }))),
      'E_BACKUP_UNSAFE'
    )
  })

  test('X6: a truncated SQLite lock file (SQLITE_CORRUPT) is recovered', async ({ assert }) => {
    mkdirSync(directory)
    const sample = join(root, 'sample.db')
    const db = openDatabase(sample)
    db.exec('CREATE TABLE t(a); INSERT INTO t VALUES (1)')
    db.close()
    writeFileSync(join(directory, '.backup.lock'), readFileSync(sample).subarray(0, 512))
    const held = acquireLock(directory)
    assert.equal(await readBackupErrorCode(() => acquireLock(directory)), 'E_BACKUP_LOCKED')
    held.release()
  })

  test('reports when a damaged lock disappears before repair', async ({ assert }) => {
    mkdirSync(directory)
    const lockPath = join(directory, '.backup.lock')
    writeFileSync(lockPath, 'not a database, but long enough to be read as a header....')
    internalHooks.step = (step) => {
      if (step === 'lock:damaged') unlinkSync(lockPath)
    }
    let failure: unknown
    try {
      acquireLock(directory)
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, errors.E_BACKUP_LOCK_FILE_OPEN)
    assert.propertyVal((failure as Error).cause as object, 'code', 'ENOENT')
    assert.isFalse(existsSync(lockPath))
  })

  test('P3: a lock file swapped for a symlink before truncation is refused, victim intact', async ({
    assert,
  }) => {
    mkdirSync(directory)
    const lockPath = join(directory, '.backup.lock')
    writeFileSync(lockPath, 'not a database, but long enough to be read as a header....')
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'keep me')
    internalHooks.step = (step) => {
      if (step === 'lock:damaged') {
        unlinkSync(lockPath)
        symlinkSync(victim, lockPath)
      }
    }
    assert.equal(await readBackupErrorCode(() => acquireLock(directory)), 'E_BACKUP_LOCK_FILE_OPEN')
    assert.equal(readFileSync(victim, 'utf8'), 'keep me')
    // Keep a reader open so repair opens the FIFO and rejects its descriptor type.
    let reader: number | undefined
    unlinkSync(lockPath)
    writeFileSync(lockPath, 'not a database, but long enough to be read as a header....')
    internalHooks.step = (step) => {
      if (step === 'lock:damaged') {
        unlinkSync(lockPath)
        execFileSync('mkfifo', [lockPath])
        reader = openSync(lockPath, constants.O_RDONLY | constants.O_NONBLOCK)
      }
    }
    try {
      assert.equal(
        await readBackupErrorCode(() => acquireLock(directory)),
        'E_BACKUP_LOCK_FILE_TYPE'
      )
    } finally {
      if (reader !== undefined) closeSync(reader)
    }
  }).timeout(10_000)

  test('P3: prune unpublishing between selection and the READY check is NOT_FOUND', async ({
    assert,
  }) => {
    makeLiveDatabase(live).close()
    const b = await createBundle(prepared({ livePath: live, directory }))
    internalHooks.step = (step) => {
      if (step === 'verify:listed') {
        chmodSync(join(b.path, 'READY'), 0o600)
        unlinkSync(join(b.path, 'READY'))
      }
    }
    assert.equal(await readBackupErrorCode(() => verifyBundle(directory)), 'E_BACKUP_BUNDLE_PRUNED')
  })
})
