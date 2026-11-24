import { BACKUP_ERROR_CODES, errors } from '../index.js'
import { prepared } from './helpers.js'
import { test } from '@japa/runner'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createBundle, verifyBundle } from '../src/bundles.js'
import { acquireLock } from '../src/lock.js'
import { internalHooks } from '../src/internal_hooks.js'
import { openDatabase } from '../src/native.js'
import { prepareRestore } from '../src/restore.js'
import { countItems, makeLiveDatabase, overwrite, createTemporaryRoot } from './helpers.js'

const readBackupErrorCode = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    const code = (error as { code?: string }).code
    const backupCode = BACKUP_ERROR_CODES.find((candidate) => candidate === code)
    return backupCode && error instanceof errors[backupCode] ? backupCode : `raw:${code}`
  }
  return 'no error'
}

test.group('verify and prepareRestore', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  let name: string
  let path: string
  group.each.setup(async () => {
    ;({ root, cleanup } = createTemporaryRoot())
    live = join(root, 'live.db')
    directory = join(root, 'b')
    makeLiveDatabase(live).close()
    ;({ name, path } = await createBundle(prepared({ livePath: live, directory })))
    return () => cleanup()
  })

  test('verify accepts a good bundle and finds the newest by default', async ({ assert }) => {
    assert.equal(verifyBundle(directory).name, name)
    assert.equal(verifyBundle(directory, name).name, name)
  })

  test('format-1 imports without journal-mode metadata still verify', ({ assert }) => {
    const manifest = join(path, 'manifest.json')
    const contents = JSON.parse(readFileSync(manifest, 'utf8'))
    delete contents.sourceJournalMode
    chmodSync(manifest, 0o600)
    writeFileSync(manifest, JSON.stringify(contents))
    assert.equal(verifyBundle(directory, name).name, name)
  })

  test('published members must be regular files', ({ assert }) => {
    for (const member of ['READY', 'manifest.json', 'db.sqlite']) {
      const file = join(path, member)
      const bytes = readFileSync(file)
      unlinkSync(file)
      mkdirSync(file)
      assert.equal(
        readBackupErrorCode(() => verifyBundle(directory, name)),
        member === 'db.sqlite' ? 'E_BACKUP_DATABASE_FILE_TYPE' : 'E_BACKUP_MANIFEST_FILE_TYPE'
      )
      const target = join(root, 'staged.db')
      assert.equal(
        readBackupErrorCode(() => prepareRestore({ directory, livePath: live, target })),
        member === 'db.sqlite' ? 'E_BACKUP_DATABASE_FILE_TYPE' : 'E_BACKUP_MANIFEST_FILE_TYPE'
      )
      assert.isFalse(existsSync(target))
      rmSync(file, { recursive: true })
      writeFileSync(file, bytes)
    }
    assert.equal(verifyBundle(directory, name).name, name)
  })

  test('published members must not be symbolic links, even to identical files', ({ assert }) => {
    for (const member of ['READY', 'manifest.json', 'db.sqlite']) {
      const file = join(path, member)
      const copy = join(root, `outside-${member}`)
      copyFileSync(file, copy)
      unlinkSync(file)
      symlinkSync(copy, file)
      assert.equal(
        readBackupErrorCode(() => verifyBundle(directory, name)),
        member === 'db.sqlite' ? 'E_BACKUP_DATABASE_FILE_TYPE' : 'E_BACKUP_MANIFEST_FILE_TYPE',
        `verify ${member}`
      )
      const target = join(root, 'staged.db')
      assert.equal(
        readBackupErrorCode(() => prepareRestore({ directory, livePath: live, target })),
        member === 'db.sqlite' ? 'E_BACKUP_DATABASE_FILE_TYPE' : 'E_BACKUP_MANIFEST_FILE_TYPE',
        `prepareRestore ${member}`
      )
      assert.isFalse(existsSync(target))
      unlinkSync(file)
      copyFileSync(copy, file)
    }
    assert.equal(verifyBundle(directory, name).name, name)
  })

  test('verify rejects a corrupt bundle, a missing READY and a bad manifest', async ({
    assert,
  }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 2, 'garbage')
    assert.equal(
      readBackupErrorCode(() => verifyBundle(directory, name)),
      'E_BACKUP_CHECKSUM_MISMATCH'
    )
    unlinkSync(join(path, 'READY'))
    assert.equal(
      readBackupErrorCode(() => verifyBundle(directory, name)),
      'E_BACKUP_READY_MISSING'
    )
    writeFileSync(join(path, 'READY'), '')
    chmodSync(join(path, 'manifest.json'), 0o600)
    writeFileSync(join(path, 'manifest.json'), '{"format":2}')
    assert.equal(
      readBackupErrorCode(() => verifyBundle(directory, name)),
      'E_BACKUP_MANIFEST_SHAPE'
    )
  })

  test('verify reports an unreadable database separately from a missing file', ({ assert }) => {
    const file = join(path, 'db.sqlite')
    chmodSync(file, 0o000)
    try {
      assert.throws(() => verifyBundle(directory, name), errors.E_BACKUP_DATABASE_UNREADABLE)
    } finally {
      chmodSync(file, 0o400)
    }
  })

  test('verify reports a size mismatch even when the stored checksum is correct', ({ assert }) => {
    const file = join(path, 'manifest.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    chmodSync(file, 0o600)
    writeFileSync(file, JSON.stringify({ ...manifest, bytes: manifest.bytes + 1 }))
    assert.throws(() => verifyBundle(directory, name), errors.E_BACKUP_SIZE_MISMATCH, /size/)
  })

  test('verify catches damage that only the checksum can see', async ({ assert }) => {
    const db = join(path, 'db.sqlite')
    const bytes = readFileSync(db)
    const offset = bytes.indexOf(Buffer.from('x'.repeat(64)))
    chmodSync(db, 0o600)
    overwrite(db, offset, 'y'.repeat(64)) // row text only; the file stays structurally valid
    assert.throws(
      () => verifyBundle(directory, name),
      errors.E_BACKUP_CHECKSUM_MISMATCH,
      /checksum/
    )
  })

  test('verify runs the integrity check, not only the checksum', async ({ assert }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 5, 'zzzzzzzzzzzz') // page header, not row text
    // Bit rot before hashing: the manifest matches the damaged bytes.
    const { createHash } = await import('node:crypto')
    const manifestPath = join(path, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.sha256 = createHash('sha256').update(readFileSync(db)).digest('hex')
    chmodSync(manifestPath, 0o600)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => verifyBundle(directory, name), /integrity_check|malformed|cannot open/)
  })

  test('bundle lookup errors', async ({ assert }) => {
    assert.equal(
      readBackupErrorCode(() => verifyBundle(directory, 'bak-utc-20000101-000000-000')),
      'E_BACKUP_NOT_FOUND'
    )
    assert.equal(
      readBackupErrorCode(() => verifyBundle(directory, '../live.db')),
      'E_BACKUP_BUNDLE_NAME'
    )
    assert.equal(
      readBackupErrorCode(() => verifyBundle(join(root, 'empty'))),
      'E_BACKUP_ROOT_NOT_FOUND'
    )
  })

  test('prepareRestore stages a verified copy and never touches the live file', async ({
    assert,
  }) => {
    const before = statSync(live)
    const target = join(root, 'staged.db')
    const staged = prepareRestore({ directory, target, livePath: live })
    assert.deepEqual(staged, { bundle: name, target })
    assert.equal(countItems(target), 200)
    assert.equal(statSync(target).mode & 0o777, 0o600)
    const after = statSync(live)
    assert.equal(after.ino, before.ino)
    assert.equal(after.mtimeMs, before.mtimeMs)
  })

  test('prepareRestore preserves a filesystem copy permission error', async ({ assert }) => {
    const stage = join(root, 'read-only-stage')
    mkdirSync(stage)
    chmodSync(stage, 0o500)
    const target = join(stage, 'staged.db')
    try {
      let failure: NodeJS.ErrnoException | undefined
      try {
        prepareRestore({ directory, target, livePath: live, name })
      } catch (error) {
        failure = error as NodeJS.ErrnoException
      }
      assert.equal(failure?.code, 'EACCES')
      assert.isFalse(existsSync(target))
    } finally {
      chmodSync(stage, 0o700)
    }
  })

  test('restore refuses a target the verification driver would reinterpret', async ({ assert }) => {
    const before = statSync(live)
    const driver = openDatabase(`${live} `, { readonly: true, fileMustExist: true })
    try {
      const main = (driver.pragma('database_list') as Array<{ name: string; file: string }>).find(
        (entry) => entry.name === 'main'
      )
      assert.equal(main?.file, live)
    } finally {
      driver.close()
    }
    const target = join(root, 'staged.db ')
    assert.equal(
      readBackupErrorCode(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_TARGET_DRIVER_PATH'
    )
    assert.equal(
      readBackupErrorCode(() => prepareRestore({ directory, target: `${live} `, livePath: live })),
      'E_BACKUP_TARGET_DRIVER_PATH'
    )
    assert.isFalse(existsSync(target))
    assert.isFalse(existsSync(join(root, 'staged.db')))
    assert.equal(statSync(live).mtimeMs, before.mtimeMs)

    const valid = join(root, ' staged.db')
    const staged = prepareRestore({ directory, target: valid, livePath: live })
    assert.equal(staged.target, valid)
    assert.equal(countItems(valid), 200)
  })

  test('prepareRestore refuses the live path, existing targets and stale sidecars', async ({
    assert,
  }) => {
    assert.throws(
      () => prepareRestore({ directory, target: live, livePath: live }),
      /restore target is the live database/
    )
    const target = join(root, 'staged.db')
    writeFileSync(`${target}-wal`, 'stale')
    assert.equal(
      readBackupErrorCode(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_TARGET_EXISTS'
    )
    assert.isFalse(existsSync(target))
    rmSync(`${target}-wal`)
    writeFileSync(target, 'existing')
    assert.equal(
      readBackupErrorCode(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_TARGET_EXISTS'
    )
  })

  test('prepareRestore of a corrupt bundle leaves nothing staged', async ({ assert }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 2, 'garbage')
    const target = join(root, 'staged.db')
    assert.equal(
      readBackupErrorCode(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_CHECKSUM_MISMATCH'
    )
    assert.isFalse(existsSync(target))
  })

  test('prepareRestore reports the verification failure even when cleanup fails', async ({
    assert,
  }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 2, 'garbage')
    const stage = join(root, 'stage')
    mkdirSync(stage)
    const target = join(stage, 'staged.db')
    // Once the copy has landed, the staging folder stops accepting deletions.
    internalHooks.step = (step) => {
      if (step === 'restore:copied') chmodSync(stage, 0o500)
    }
    try {
      const error = (() => {
        try {
          prepareRestore({ directory, target, livePath: live })
          return undefined
        } catch (caught) {
          return caught as Error & { code?: string; cleanupError?: NodeJS.ErrnoException }
        }
      })()
      assert.instanceOf(error, errors.E_BACKUP_CHECKSUM_MISMATCH)
      assert.equal(error?.code, 'E_BACKUP_CHECKSUM_MISMATCH')
      assert.equal(error?.cleanupError?.code, 'EACCES')
    } finally {
      delete internalHooks.step
      chmodSync(stage, 0o700)
    }
  })

  test('prepareRestore is lock-free and reports a damaged READY bundle as invalid', async ({
    assert,
  }) => {
    const lock = acquireLock(directory)
    try {
      prepareRestore({ directory, target: join(root, 'a.db'), livePath: live })
    } finally {
      lock.release()
    }
    rmSync(join(path, 'db.sqlite'))
    assert.equal(
      readBackupErrorCode(() =>
        prepareRestore({ directory, target: join(root, 'b.db'), livePath: live })
      ),
      'E_BACKUP_DATABASE_MISSING'
    )
  })

  test('reports a bundle pruned after selection as not found', async ({ assert }) => {
    const target = join(root, 'pruned-stage.db')
    internalHooks.step = (step, detail) => {
      if (step === 'restore:checked' && detail === target) rmSync(path, { recursive: true })
    }
    try {
      const error = (() => {
        try {
          prepareRestore({ directory, target, livePath: live, name })
          return undefined
        } catch (caught) {
          return caught as NodeJS.ErrnoException & { code?: string; cause?: NodeJS.ErrnoException }
        }
      })()
      assert.equal(error?.code, 'E_BACKUP_BUNDLE_PRUNED')
      assert.equal(error?.cause?.code, 'ENOENT')
      assert.isFalse(existsSync(target))
    } finally {
      delete internalHooks.step
    }
  })
})
