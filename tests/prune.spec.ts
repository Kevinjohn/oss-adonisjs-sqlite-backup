import { prepared } from './helpers.ts'
import { test } from '@japa/runner'
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createBundle, listBundles } from '../src/bundles.ts'
import { defineConfig } from '../src/define_config.ts'
import { InternalHooks } from '../src/internal_hooks.ts'
import { acquireLock } from '../src/lock.ts'
import { pruneBundles } from '../src/prune.ts'
import { SqliteBackup } from '../src/sqlite_backup.ts'
import type { PruneProgress } from '../src/types.ts'
import {
  failDirectorySync,
  makeLiveDatabase,
  startChild,
  stopChild,
  createTemporaryRoot,
} from './helpers.ts'

test.group('pruneBundles', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = createTemporaryRoot())
    live = join(root, 'live.db')
    directory = join(root, 'b')
    makeLiveDatabase(live).close()
    return () => cleanup()
  })

  const createMany = async (count: number) => {
    const names: string[] = []
    for (let i = 0; i < count; i++) {
      const created = await createBundle(prepared({ livePath: live, directory }))
      names.push(created.name)
    }
    return names
  }

  test('keeps the newest READY bundles and removes crashed unfinished ones', async ({ assert }) => {
    const names = await createMany(4)
    const crashed = join(directory, 'bak-utc-20010101-000000-000')
    mkdirSync(crashed)
    writeFileSync(join(crashed, 'db.sqlite'), 'partial')
    mkdirSync(join(directory, 'not-a-bundle'))
    writeFileSync(join(directory, 'bak-utc-20010101-000000-001'), 'a file, not a bundle')
    const result = pruneBundles({ directory, keep: 2 })
    assert.deepEqual(result.removed, names.slice(0, 2))
    assert.deepEqual(result.abandoned, ['bak-utc-20010101-000000-000'])
    assert.deepEqual(result.failed, [])
    assert.deepEqual(
      listBundles(directory).map((b) => b.name),
      names.slice(2)
    )
    assert.isTrue(existsSync(join(directory, 'not-a-bundle')))
    assert.isTrue(existsSync(join(directory, 'bak-utc-20010101-000000-001')))
    assert.isTrue(existsSync(live))
  })

  test('refuses while another process holds the lock and removes nothing', async ({ assert }) => {
    const names = await createMany(3)
    mkdirSync(join(directory, 'bak-utc-20010101-000000-000'))
    const holder = await startChild('lock', directory)
    try {
      assert.throws(() => pruneBundles({ directory, keep: 1 }), /locked/)
      assert.deepEqual(
        listBundles(directory).map((b) => b.name),
        names
      )
      assert.isTrue(existsSync(join(directory, 'bak-utc-20010101-000000-000')))
    } finally {
      await stopChild(holder)
    }
  }).timeout(20_000)

  test('waits for a different process to release the lock', async ({ assert }) => {
    await createMany(2)
    const holder = await startChild('lock', directory, '300')
    try {
      const started = performance.now()
      const result = pruneBundles({ directory, keep: 1, lockTimeoutMs: 5_000 })
      assert.lengthOf(result.removed, 1)
      assert.isAtLeast(performance.now() - started, 100)
    } finally {
      await stopChild(holder)
    }
  }).timeout(20_000)

  test('refuses promptly at the copy boundary of a backup on the same event loop', async ({
    assert,
  }) => {
    const [oldest] = await createMany(1)
    const alias = join(root, 'archive-alias')
    symlinkSync(directory, alias)
    let refused: unknown
    let elapsed = Infinity
    InternalHooks.step = (step) => {
      if (step !== 'create:copying') return
      const started = performance.now()
      try {
        pruneBundles({ directory: alias, keep: 1, lockTimeoutMs: 2_000 })
      } catch (error) {
        refused = error
      } finally {
        elapsed = performance.now() - started
      }
    }
    try {
      await createMany(1)
    } finally {
      InternalHooks.step = undefined
    }
    assert.propertyVal(refused as object, 'code', 'E_BACKUP_LOCKED')
    assert.isBelow(elapsed, 1_000)
    assert.deepEqual(pruneBundles({ directory, keep: 1 }).removed, [oldest])
  })

  const pruneWithFailures = (
    primary?: { error: unknown },
    rollbackError = new Error('lock rollback failed')
  ) => {
    const prototype = Database.prototype as {
      exec: (this: { name: string }, sql: string) => unknown
    }
    const originalExec = prototype.exec
    prototype.exec = function (sql) {
      if (this.name === join(directory, '.backup.lock') && sql === 'ROLLBACK') throw rollbackError
      return originalExec.call(this, sql)
    }
    if (primary) {
      InternalHooks.step = (step) => {
        if (step === 'list:read') throw primary.error
      }
    }
    let failure: unknown
    try {
      pruneBundles({ directory, keep: 1 })
    } catch (error) {
      failure = error
    } finally {
      InternalHooks.step = undefined
      prototype.exec = originalExec
    }
    acquireLock(directory).release()
    return { failure, rollbackError }
  }

  test('keeps the listing error and attaches rollback failure', ({ assert }) => {
    mkdirSync(directory, { mode: 0o700 })
    const primary = new Error('directory listing failed')
    const { failure, rollbackError } = pruneWithFailures({ error: primary })
    assert.strictEqual(failure, primary)
    assert.deepEqual((failure as { resourceCleanupErrors: unknown[] }).resourceCleanupErrors, [
      rollbackError,
    ])
  })

  test('keeps both failures when pruning throws a non-Error', ({ assert }) => {
    mkdirSync(directory, { mode: 0o700 })
    const { failure, rollbackError } = pruneWithFailures({ error: undefined })
    assert.instanceOf(failure, AggregateError)
    assert.deepEqual((failure as AggregateError).errors, [undefined, rollbackError])
    assert.deepEqual((failure as { resourceCleanupErrors: unknown[] }).resourceCleanupErrors, [
      rollbackError,
    ])
  })

  test('reports a listing failure even when lock release succeeds', ({ assert }) => {
    mkdirSync(directory, { mode: 0o700 })
    const primary = new Error('directory listing failed')
    InternalHooks.step = (step) => {
      if (step === 'list:read') throw primary
    }
    try {
      assert.throws(() => pruneBundles({ directory, keep: 1 }), /directory listing failed/)
    } finally {
      InternalHooks.step = undefined
    }
    acquireLock(directory).release()
  })

  test('reports a release-only failure', ({ assert }) => {
    mkdirSync(directory, { mode: 0o700 })
    const { failure, rollbackError } = pruneWithFailures()
    assert.strictEqual(failure, rollbackError)
  })

  test('retains observed removals and the original archive sync error', async ({ assert }) => {
    const [oldest, newest] = await createMany(2)
    const syncError = new Error('final archive sync failed')
    const restoreSync = failDirectorySync(directory, syncError)
    let failure: unknown
    try {
      pruneBundles({ directory, keep: 1 })
    } catch (error) {
      failure = error
    } finally {
      restoreSync()
    }
    assert.strictEqual(failure, syncError)
    assert.deepEqual((failure as { pruneProgress: PruneProgress }).pruneProgress, {
      removed: [oldest],
      abandoned: [],
      failed: [],
      archiveSyncFailed: true,
    })
    assert.isFalse(existsSync(join(directory, oldest!)))
    assert.isTrue(existsSync(join(directory, newest!)))
    acquireLock(directory).release()
  })

  test('retains removals and per-item errors after lock release fails', async ({ assert }) => {
    const [oldest, newest] = await createMany(2)
    const abandoned = 'bak-utc-20010101-000000-001'
    const interrupted = 'bak-utc-20010101-000000-002'
    mkdirSync(join(directory, abandoned))
    mkdirSync(join(directory, interrupted))
    InternalHooks.step = (step, name) => {
      if (step === 'prune:unpublished' && name === interrupted) throw new Error('remove failed')
    }
    const frozenRollbackError = Object.freeze(new Error('lock rollback failed'))
    try {
      const { failure } = pruneWithFailures(undefined, frozenRollbackError)
      assert.strictEqual((failure as Error).cause, frozenRollbackError)
      assert.deepEqual((failure as { pruneProgress: PruneProgress }).pruneProgress, {
        removed: [oldest],
        abandoned: [abandoned],
        failed: [{ name: interrupted, reason: 'Error: remove failed' }],
        archiveSyncFailed: false,
      })
      assert.isFalse(existsSync(join(directory, oldest!)))
      assert.isTrue(existsSync(join(directory, newest!)))
      assert.isFalse(existsSync(join(directory, abandoned)))
      assert.isTrue(existsSync(join(directory, interrupted)))
    } finally {
      InternalHooks.step = undefined
    }
  })

  test('configured prune protects a live file in an unfinished bundle', ({ assert }) => {
    const unfinished = join(directory, 'bak-utc-20010101-000000-000')
    mkdirSync(unfinished, { recursive: true })
    const source = join(unfinished, 'live.db')
    makeLiveDatabase(source).close()
    const alias = join(root, 'live-alias.db')
    symlinkSync(source, alias)
    const service = new SqliteBackup(defineConfig({ directory }), {
      connection: 'sqlite',
      connections: { sqlite: { client: 'better-sqlite3', connection: { filename: alias } } },
    })
    let refused: unknown
    try {
      service.prune()
    } catch (error) {
      refused = error
    }
    assert.propertyVal(refused as object, 'code', 'E_BACKUP_UNSAFE')
    assert.isTrue(existsSync(source))
  })

  test('configured prune works without a configured file source', async ({ assert }) => {
    const names = await createMany(2)
    const service = new SqliteBackup(defineConfig({ directory }), undefined)
    assert.deepEqual(service.prune({ keep: 1 }).removed, names.slice(0, 1))
  })

  test('reports removal failures instead of throwing', async ({ assert }) => {
    const [oldest] = await createMany(2)
    chmodSync(join(directory, oldest!), 0o500)
    try {
      const result = pruneBundles({ directory, keep: 1 })
      assert.deepEqual(
        result.failed.map((f) => f.name),
        [oldest]
      )
      assert.deepEqual(result.removed, [])
    } finally {
      chmodSync(join(directory, oldest!), 0o700)
    }
  })

  test('rejects keep < 1 and refuses a missing directory', async ({ assert }) => {
    mkdirSync(directory)
    assert.throws(() => pruneBundles({ directory, keep: 0 }), /keep/)
    const lock = acquireLock(directory)
    lock.release()
    assert.throws(() => pruneBundles({ directory: join(root, 'none'), keep: 1 }), /missing/)
  })
})
