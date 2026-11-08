import { prepared } from './helpers.js'
/**
 * Phase 7: `..` is resolved against the real folder on disk, as SQLite and the kernel do, never
 * collapsed as text before symlinks are followed.
 */
import { test } from '@japa/runner'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { internalHooks } from '../src/internal_hooks.js'
import { acquireLock } from '../src/lock.js'
import { openDatabase } from '../src/native.js'
import { pruneBundles } from '../src/prune.js'
import { realPath } from '../src/paths.js'
import { prepareRestore } from '../src/restore.js'
import { resolveSqliteSource } from '../src/source.js'
import { makeLiveDatabase, tempRoot } from './helpers.js'

const codeOf = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (error) {
    const e = error as { code?: string; constructor?: { name?: string } }
    return e.constructor?.name === 'BackupException' ? e.code : `raw:${e.code}`
  }
  return 'no error'
}

const lucid = (filename: string) => ({
  connection: 'main',
  connections: { main: { client: 'better-sqlite3', connection: { filename } } },
})

/** A small database whose only row says who it belongs to. */
function markedDatabase(path: string, marker: string) {
  const db = openDatabase(path)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE m(v TEXT)')
  db.prepare('INSERT INTO m VALUES (?)').run(marker)
  db.close()
}

function markerOf(path: string) {
  const db = openDatabase(path, { readonly: true, fileMustExist: true })
  try {
    return (db.prepare('SELECT v FROM m').get() as { v: string }).v
  } finally {
    db.close()
  }
}

test.group('kernel-faithful paths', (group) => {
  let root: string
  let cleanup: () => void
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    return () => {
      delete internalHooks.step
      cleanup()
    }
  })

  test('P1: a Lucid filename with .. after a symlink backs up the file the app opens', async ({
    assert,
  }) => {
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    symlinkSync(join(root, 'deep', 'x'), join(root, 'alias'))
    markedDatabase(join(root, 'deep', 'live2.db'), 'what-the-app-uses')
    markedDatabase(join(root, 'live2.db'), 'lexical-other-file')
    const filename = join(root, 'alias') + '/../live2.db'
    // What SQLite itself opens with that filename:
    assert.equal(markerOf(filename), 'what-the-app-uses')
    const live = resolveSqliteSource(lucid(filename))
    const bundle = await createBundle(prepared({ livePath: live, directory: join(root, 'b') }))
    assert.equal(markerOf(join(bundle.path, 'db.sqlite')), 'what-the-app-uses')
    // The same when the raw filename is passed to createBundle directly.
    const direct = await createBundle(prepared({ livePath: filename, directory: join(root, 'b') }))
    assert.equal(markerOf(join(direct.path, 'db.sqlite')), 'what-the-app-uses')
  })

  test('P1: .. across two symlinked folders', async ({ assert }) => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    mkdirSync(join(root, 'c', 'd'), { recursive: true })
    symlinkSync(join(root, 'a', 'b'), join(root, 'l1'))
    symlinkSync('../c/d', join(root, 'a', 'l2')) // relative, inside a/
    markedDatabase(join(root, 'c', 'f.db'), 'what-the-app-uses')
    markedDatabase(join(root, 'f.db'), 'lexical-other-file')
    const filename = join(root, 'l1') + '/../l2/../f.db'
    assert.equal(markerOf(filename), 'what-the-app-uses')
    const bundle = await createBundle(
      prepared({
        livePath: resolveSqliteSource(lucid(filename)),
        directory: join(root, 'b'),
      })
    )
    assert.equal(markerOf(join(bundle.path, 'db.sqlite')), 'what-the-app-uses')
  })

  test('P2: a live path with .. after a symlink, its file lost, cannot be restored onto', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    mkdirSync(join(root, 'deep', 'data'))
    mkdirSync(join(root, 'app', 'data'), { recursive: true })
    symlinkSync(join(root, 'deep', 'x'), join(root, 'app', 'sub'))
    const appPath = join(root, 'app', 'sub') + '/../data/real.db' // the app opens deep/data/real.db
    const real = join(root, 'deep', 'data', 'real.db')
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target: real, livePath: appPath })),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(real))
  })

  test('P2: a dangling live link whose text has .. after a symlink', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    mkdirSync(join(root, 'deep', 'data'))
    mkdirSync(join(root, 'app', 'data'), { recursive: true })
    symlinkSync(join(root, 'deep', 'x'), join(root, 'app', 'sub'))
    symlinkSync('sub/../data/real.db', join(root, 'app', 'db.sqlite3'))
    const real = join(root, 'deep', 'data', 'real.db')
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: real, livePath: join(root, 'app', 'db.sqlite3') })
      ),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(real))
  })

  test('P2: a relative link with .. inside a folder reached through .. after a symlink', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    mkdirSync(join(root, 'deep', 'y'))
    symlinkSync(join(root, 'deep', 'x'), join(root, 's'))
    symlinkSync('../target.db', join(root, 'deep', 'y', 'ln')) // dangling
    const appPath = join(root, 's') + '/../y/ln' // the app opens deep/target.db
    const real = join(root, 'deep', 'target.db')
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target: real, livePath: appPath })),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(real))
  })

  test('P3: a target folder swapped for a symlink before the copy is refused and cleaned', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'stage'))
    mkdirSync(join(root, 'elsewhere'))
    internalHooks.step = (step) => {
      if (step === 'restore:checked') {
        renameSync(join(root, 'stage'), join(root, 'stage-old'))
        symlinkSync(join(root, 'elsewhere'), join(root, 'stage'))
      }
    }
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: join(root, 'stage', 's.db'), livePath: live })
      ),
      'E_BACKUP_UNSAFE'
    )
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), [])
  })

  test('P3: cleanup removes only the file restore created', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    const target = join(root, 's.db')
    internalHooks.step = (step) => {
      if (step === 'restore:copied') {
        unlinkSync(target)
        writeFileSync(target, 'someone else')
      }
    }
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target, livePath: live })),
      'E_BACKUP_INVALID'
    )
    assert.equal(readFileSync(target, 'utf8'), 'someone else')
  })

  test('Y11: a backup folder configured through a symlink', async ({ assert }) => {
    const live = join(root, 'data', 'live.db')
    mkdirSync(join(root, 'data'))
    makeLiveDatabase(live).close()
    mkdirSync(join(root, 'store'))
    symlinkSync(join(root, 'store'), join(root, 'backups'))
    const directory = join(root, 'backups')
    const a = await createBundle(prepared({ livePath: live, directory }))
    await createBundle(prepared({ livePath: live, directory }))
    assert.lengthOf(listBundles(directory), 2)
    assert.equal(verifyBundle(directory, a.name).name, a.name)
    assert.deepEqual(pruneBundles({ directory, keep: 1 }).removed, [a.name])
    assert.lengthOf(
      readdirSync(join(root, 'store')).filter((n) => n.startsWith('bak-')),
      1
    )
    // A backup folder linked to the live file's folder is still refused.
    symlinkSync(join(root, 'data'), join(root, 'onto-live'))
    assert.equal(
      await codeOf(() =>
        createBundle(prepared({ livePath: live, directory: join(root, 'onto-live') }))
      ),
      'E_BACKUP_UNSAFE'
    )
    // So is one reaching it through .. after a symlink (as text it would be root/x).
    mkdirSync(join(root, 'data', 'inner'))
    mkdirSync(join(root, 'x'))
    symlinkSync(join(root, 'data', 'inner'), join(root, 'x', 'via'))
    assert.equal(
      await codeOf(() =>
        createBundle(prepared({ livePath: live, directory: join(root, 'x', 'via') + '/..' }))
      ),
      'E_BACKUP_UNSAFE'
    )
  })

  test('a backup folder and a restore target given with .. after a symlink', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    mkdirSync(join(root, 'st', 'inner'), { recursive: true })
    mkdirSync(join(root, 'x'))
    symlinkSync(join(root, 'st', 'inner'), join(root, 'x', 'v'))
    const folder = join(root, 'x', 'v') + '/..' // the kernel reaches st; as text it is x
    const a = await createBundle(prepared({ livePath: live, directory: folder }))
    await createBundle(prepared({ livePath: live, directory: folder }))
    assert.lengthOf(listBundles(join(root, 'st')), 2)
    assert.deepEqual(readdirSync(join(root, 'x')), ['v'])
    assert.lengthOf(listBundles(folder), 2)
    assert.equal(verifyBundle(folder).name, listBundles(folder)[1]!.name)
    assert.deepEqual(pruneBundles({ directory: folder, keep: 1 }).removed, [a.name])
    // A target reaching the backup folder only through .. after a symlink is refused.
    symlinkSync(join(root, 'st', 'inner'), join(root, 'x', 'w'))
    const target = join(root, 'x', 'w') + '/../staged.db'
    assert.equal(
      await codeOf(() => prepareRestore({ directory: folder, target, livePath: live })),
      'E_BACKUP_UNSAFE'
    )
    assert.isFalse(existsSync(join(root, 'st', 'staged.db')))
    assert.isFalse(existsSync(join(root, 'x', 'staged.db')))
    // The lock lives in the real folder: a lock taken through .. blocks create on the real path.
    const held = acquireLock(folder)
    try {
      assert.equal(
        await codeOf(() => createBundle(prepared({ livePath: live, directory: join(root, 'st') }))),
        'E_BACKUP_LOCKED'
      )
    } finally {
      held.release()
    }
  })

  test('a target that is itself a dangling symlink is refused', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere', 'new.db'), join(root, 't.db'))
    assert.equal(
      await codeOf(() => prepareRestore({ directory, target: join(root, 't.db'), livePath: live })),
      'E_BACKUP_UNSAFE'
    )
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), [])
  })

  test('realPath equals realpathSync for every existing fixture path', ({ assert }) => {
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    mkdirSync(join(root, 'c', 'd'), { recursive: true })
    mkdirSync(join(root, 'deep', 'y'))
    for (const f of ['deep/live2.db', 'live2.db', 'c/f.db', 'f.db', 'deep/target.db']) {
      writeFileSync(join(root, f), '')
    }
    symlinkSync(join(root, 'deep', 'x'), join(root, 'alias'))
    symlinkSync(join(root, 'a', 'b'), join(root, 'l1'))
    symlinkSync('../c/d', join(root, 'a', 'l2'))
    symlinkSync('../target.db', join(root, 'deep', 'y', 'ln'))
    symlinkSync('alias/../live2.db', join(root, 'chain'))
    symlinkSync('chain', join(root, 'chain2'))
    const paths = [
      'alias/../live2.db',
      'l1/../l2/../f.db',
      'alias/../y/ln',
      'chain2',
      './alias/./../y/../live2.db',
      'deep//x/..//live2.db',
      'alias',
      '.',
    ].map((p) => `${root}/${p}`)
    for (const path of paths) assert.equal(realPath(path), realpathSync.native(path), path)
    // Node's JS realpathSync collapses .. as text first, so it is not the reference.
    assert.notEqual(realpathSync(paths[0]!), realpathSync.native(paths[0]!))
    const rel = relative(process.cwd(), join(root, 'alias')) + '/../live2.db'
    assert.equal(realPath(rel), realpathSync.native(rel))
    assert.equal(realPath('/'), '/')
  })

  test('realPath appends missing segments and refuses .. after them', ({ assert }) => {
    mkdirSync(join(root, 'deep', 'x'), { recursive: true })
    symlinkSync(join(root, 'deep', 'x'), join(root, 'alias'))
    writeFileSync(join(root, 'file'), '')
    const real = realpathSync(root)
    assert.equal(realPath(`${root}/alias/../new/a/b.db`), `${real}/deep/new/a/b.db`)
    assert.equal(realPath(`${root}/file/inner.db`), `${real}/file/inner.db`) // ENOTDIR
    assert.throws(() => realPath(`${root}/missing/../x.db`), /after a missing folder/)
  })

  test('Z7: relative paths start at the real cwd, not $PWD', ({ assert }) => {
    mkdirSync(join(root, 'x'))
    writeFileSync(join(root, 'x', 'f.db'), '')
    const before = process.cwd()
    const pwd = process.env.PWD
    try {
      process.chdir(join(root, 'x')) // chdir does not update $PWD
      process.env.PWD = root
      assert.equal(realPath('f.db'), realpathSync.native('f.db'))
      assert.equal(realPath('f.db'), join(realpathSync.native(root), 'x', 'f.db'))
    } finally {
      process.chdir(before)
      process.env.PWD = pwd
    }
  })

  test('Z3: 40 symlink hops resolve, 41 are refused, as the kernel does', ({ assert }) => {
    writeFileSync(join(root, 'f'), '')
    symlinkSync('f', join(root, 'l1'))
    for (let i = 2; i <= 41; i++) symlinkSync(`l${i - 1}`, join(root, `l${i}`))
    assert.equal(realPath(join(root, 'l40')), realpathSync.native(join(root, 'l40')))
    assert.throws(() => realpathSync.native(join(root, 'l41')), /ELOOP/)
    assert.throws(() => realPath(join(root, 'l41')), /too many symlinks/)
  })

  test('swap race: a folder swapped back before the post-copy check is typed and cleaned', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'stage'))
    mkdirSync(join(root, 'elsewhere'))
    internalHooks.step = (step) => {
      if (step === 'restore:checked') {
        renameSync(join(root, 'stage'), join(root, 'stage-real'))
        symlinkSync(join(root, 'elsewhere'), join(root, 'stage'))
      }
      if (step === 'restore:copied') {
        unlinkSync(join(root, 'stage'))
        renameSync(join(root, 'stage-real'), join(root, 'stage'))
      }
    }
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: join(root, 'stage', 's.db'), livePath: live })
      ),
      'E_BACKUP_UNSAFE'
    )
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), [])
    assert.deepEqual(readdirSync(join(root, 'stage')), [])
  })

  test('swap race: a folder swapped for a symlink after the copy is typed', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    await createBundle(prepared({ livePath: live, directory }))
    mkdirSync(join(root, 'stage'))
    mkdirSync(join(root, 'elsewhere'))
    internalHooks.step = (step) => {
      if (step === 'restore:copied') {
        renameSync(join(root, 'stage'), join(root, 'stage-real'))
        symlinkSync(join(root, 'elsewhere'), join(root, 'stage'))
      }
    }
    assert.equal(
      await codeOf(() =>
        prepareRestore({ directory, target: join(root, 'stage', 's.db'), livePath: live })
      ),
      'E_BACKUP_UNSAFE'
    )
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), [])
  })
})
