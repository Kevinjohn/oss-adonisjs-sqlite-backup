import { errors } from '../index.js'
import { prepared } from './helpers.js'
/** Every publish step is fsynced in order: file, then its directory, before the next step. */
import { test } from '@japa/runner'
import fs, { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { createBundle, listBundleDirectoryNames, listBundles } from '../src/bundles.js'
import { prepareDirectory } from '../src/directory.js'
import { writeAll } from '../src/fs.js'
import { internalHooks } from '../src/internal_hooks.js'
import { pruneBundles } from '../src/prune.js'
import { prepareRestore } from '../src/restore.js'
import { MANIFEST } from '../src/names.js'
import { makeLiveDatabase, createTemporaryRoot } from './helpers.js'

test.group('durability', (group) => {
  let root: string
  let cleanup: () => void
  let events: string[]
  group.each.setup(() => {
    ;({ root, cleanup } = createTemporaryRoot())
    events = []
    internalHooks.durability = (event, path) => {
      events.push(`${event} ${relative(root, path).replace(/bak-utc-[\d-]+/, 'BUNDLE')}`)
    }
    return () => {
      delete internalHooks.durability
      cleanup()
    }
  })

  test('create fsyncs data, manifest and READY, each followed by its directory', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory: join(root, 'b') }))
    assert.deepEqual(events, [
      'sync ',
      'sync b',
      'sync b/BUNDLE/db.sqlite',
      'write b/BUNDLE/manifest.json',
      'sync b/BUNDLE',
      'write b/BUNDLE/READY',
      'sync b/BUNDLE',
      'sync b',
    ])
  })

  test('a manifest write that stalls after a short write never publishes a bundle', async ({
    assert,
  }) => {
    const livePath = join(root, 'live.db')
    const directory = join(root, 'b')
    makeLiveDatabase(livePath).close()
    const input = prepared({ livePath, directory })
    const originalWrite = fs.writeSync
    const offsets: number[] = []
    let manifestPath: string | undefined

    internalHooks.step = (step, path) => {
      if (step === 'create:checked') manifestPath = join(dirname(path), MANIFEST)
    }
    fs.writeSync = (
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ): number => {
      const manifest = manifestPath && statSync(manifestPath, { throwIfNoEntry: false })
      if (manifest && Buffer.isBuffer(data)) {
        const file = fs.fstatSync(fd)
        if (file.ino === manifest.ino && file.dev === manifest.dev) {
          const offset = args[0] as number
          offsets.push(offset)
          return offset === 0 ? originalWrite(fd, data, offset, 5) : 0
        }
      }
      return Reflect.apply(originalWrite, fs, [fd, data, ...args])
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(
        () => createBundle(input),
        errors.E_BACKUP_WRITE_INCOMPLETE,
        /write stopped after 5 of [0-9]+ bytes/
      )
      assert.deepEqual(offsets, [0, 5])
      assert.deepEqual(listBundleDirectoryNames(directory), [])
    } finally {
      delete internalHooks.step
      fs.writeSync = originalWrite
      syncBuiltinESMExports()
    }
    await createBundle(input)
    assert.lengthOf(listBundles(directory), 1)
  })

  test('a failed READY removal leaves the bundle listed and reports the cleanup error', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    const directory = join(root, 'b')
    makeLiveDatabase(live).close()
    const input = prepared({ livePath: live, directory })
    const syncError = new Error('sync failed after writing READY')
    const cleanupError = new Error('could not remove READY')
    const originalUnlink = fs.unlinkSync

    internalHooks.durability = (event, path) => {
      if (event === 'sync' && fs.existsSync(join(path, 'READY'))) throw syncError
    }
    fs.unlinkSync = (path) => {
      if (String(path).endsWith('/READY')) throw cleanupError
      originalUnlink(path)
    }
    syncBuiltinESMExports()
    try {
      const failure = await createBundle(input).then(
        () => assert.fail('expected bundle creation to fail'),
        (error: unknown) => error
      )
      assert.strictEqual(failure, syncError)
      assert.strictEqual((failure as { cleanupError?: unknown }).cleanupError, cleanupError)
      assert.lengthOf(listBundles(directory), 1)
    } finally {
      fs.unlinkSync = originalUnlink
      syncBuiltinESMExports()
    }
  })

  test('first-use nested root syncs every new parent entry before bundle publication', async ({
    assert,
  }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'nested', 'backups')
    prepareDirectory(directory)
    await createBundle({ livePath: live, directory })
    assert.deepEqual(events.slice(0, 2), ['sync ', 'sync nested'])
    assert.equal(events[2], 'sync nested/backups')
    assert.equal(events.at(-1), 'sync nested/backups')
  })

  test('two staged preparations accept a directory created after their missing-entry scan', ({
    assert,
  }) => {
    const directory = join(root, 'nested', 'backups')
    let secondStarted = false
    internalHooks.durability = (event, path) => {
      events.push(`${event} ${relative(root, path)}`)
      if (event === 'sync' && path === root && !secondStarted) {
        secondStarted = true
        prepareDirectory(directory)
      }
    }
    prepareDirectory(directory)
    assert.isTrue(secondStarted)
    assert.deepEqual(events, ['sync ', 'sync nested', 'sync nested'])
  })

  test('preparing an existing file refuses it without changing its mode or bytes', ({ assert }) => {
    const file = join(root, 'backup-root')
    const bytes = Buffer.from('keep this file intact')
    writeFileSync(file, bytes, { mode: 0o644 })
    const beforeMode = statSync(file).mode & 0o777

    assert.throws(() => prepareDirectory(file), /must be a private directory/)
    assert.equal(statSync(file).mode & 0o777, beforeMode)
    assert.deepEqual(readFileSync(file), bytes)
  })

  test('preparing a missing root written with a trailing slash creates it', ({ assert }) => {
    const directory = join(root, 'nested', 'backups')
    prepareDirectory(`${directory}/`)
    assert.equal(statSync(directory).mode & 0o777, 0o700)

    const file = join(root, 'backup-root')
    writeFileSync(file, '')
    assert.throws(() => prepareDirectory(`${file}/`), /non-directory/)
  })

  test('preparing existing permissive directories tightens their mode', ({ assert }) => {
    for (const mode of [0o755, 0o777]) {
      const directory = join(root, `mode-${mode.toString(8)}`)
      mkdirSync(directory, { mode })
      chmodSync(directory, mode)

      prepareDirectory(directory)

      assert.equal(statSync(directory).mode & 0o777, 0o700)
    }
  })

  test('restore-prepare fsyncs the staged file and its directory', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    await createBundle(prepared({ livePath: live, directory: join(root, 'b') }))
    events = []
    prepareRestore({ directory: join(root, 'b'), target: join(root, 'staged.db'), livePath: live })
    assert.deepEqual(events, ['sync staged.db', 'sync '])
  })

  test('prune fsyncs each unpublish and the directory after removal', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    for (let i = 0; i < 3; i++)
      await createBundle(prepared({ livePath: live, directory: join(root, 'b') }))
    events = []
    pruneBundles({ directory: join(root, 'b'), keep: 1 })
    assert.deepEqual(events, ['sync b/BUNDLE', 'sync b/BUNDLE', 'sync b'])
  })

  test('writeAll keeps writing after a short write and fails on no progress', ({ assert }) => {
    const data = Buffer.from('0123456789')
    const chunks: string[] = []
    writeAll(7, data, (_fd, buffer, offset) => {
      chunks.push(buffer.subarray(offset, offset + 3).toString())
      return Math.min(3, buffer.length - offset)
    })
    assert.deepEqual(chunks, ['012', '345', '678', '9'])
    assert.throws(
      () => writeAll(7, data, (_fd, _buffer, offset) => (offset === 0 ? 3 : 0)),
      errors.E_BACKUP_WRITE_INCOMPLETE,
      /write stopped after 3 of 10 bytes/
    )
  })
})
