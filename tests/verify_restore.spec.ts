import { prepared } from './helpers.js'
import { test } from '@japa/runner'
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createBundle, verifyBundle } from '../src/bundles.js'
import { acquireLock } from '../src/lock.js'
import { prepareRestore } from '../src/restore.js'
import { countItems, makeLiveDatabase, overwrite, tempRoot } from './helpers.js'

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
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
    ;({ root, cleanup } = tempRoot())
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

  test('verify rejects a corrupt bundle, a missing READY and a bad manifest', async ({
    assert,
  }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 2, 'garbage')
    assert.equal(
      codeOf(() => verifyBundle(directory, name)),
      'E_BACKUP_INVALID'
    )
    unlinkSync(join(path, 'READY'))
    assert.equal(
      codeOf(() => verifyBundle(directory, name)),
      'E_BACKUP_INVALID'
    )
    writeFileSync(join(path, 'READY'), '')
    chmodSync(join(path, 'manifest.json'), 0o600)
    writeFileSync(join(path, 'manifest.json'), '{"format":2}')
    assert.equal(
      codeOf(() => verifyBundle(directory, name)),
      'E_BACKUP_INVALID'
    )
  })

  test('verify catches damage that only the checksum can see', async ({ assert }) => {
    const db = join(path, 'db.sqlite')
    const bytes = readFileSync(db)
    const offset = bytes.indexOf(Buffer.from('x'.repeat(64)))
    chmodSync(db, 0o600)
    overwrite(db, offset, 'y'.repeat(64)) // row text only; the file stays structurally valid
    assert.throws(() => verifyBundle(directory, name), /checksum/)
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
      codeOf(() => verifyBundle(directory, 'bak-utc-20000101-000000-000')),
      'E_BACKUP_NOT_FOUND'
    )
    assert.equal(
      codeOf(() => verifyBundle(directory, '../live.db')),
      'E_BACKUP_UNSAFE'
    )
    assert.equal(
      codeOf(() => verifyBundle(join(root, 'empty'))),
      'E_BACKUP_NOT_FOUND'
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
      codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(target))
    rmSync(`${target}-wal`)
    writeFileSync(target, 'existing')
    assert.equal(
      codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_UNSAFE'
    )
  })

  test('prepareRestore of a corrupt bundle leaves nothing staged', async ({ assert }) => {
    const db = join(path, 'db.sqlite')
    chmodSync(db, 0o600)
    overwrite(db, 4096 * 2, 'garbage')
    const target = join(root, 'staged.db')
    assert.equal(
      codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_INVALID'
    )
    assert.isFalse(existsSync(target))
  })

  test('prepareRestore is lock-free and reports a vanished bundle as not found', async ({
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
      codeOf(() => prepareRestore({ directory, target: join(root, 'b.db'), livePath: live })),
      'E_BACKUP_NOT_FOUND'
    )
  })
})
