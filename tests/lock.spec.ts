import { test } from '@japa/runner'
// @ts-expect-error better-sqlite3 does not publish declarations
import Database from 'better-sqlite3'
import { linkSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireCreateLock, acquireLock } from '../src/lock.js'
import { startChild, stopChild, tempRoot } from './helpers.js'

test.group('Directory lock', () => {
  test('rejects unsupported timeout before touching the lock path', ({ assert }) => {
    assert.throws(() => acquireLock('/missing/lock/root', 2_147_483_648), /2147483647/)
  })

  test('damaged multiply linked lock cannot truncate its alias', ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const alias = join(root, 'alias')
    const lockPath = join(root, '.backup.lock')
    try {
      writeFileSync(alias, 'keep these bytes')
      linkSync(alias, lockPath)
      assert.throws(() => acquireLock(root), /singly linked regular file/)
      assert.equal(readFileSync(alias, 'utf8'), 'keep these bytes')
    } finally {
      cleanup()
    }
  })
  test('a second holder in the same process is refused until release', async ({ assert }) => {
    const { root, cleanup } = tempRoot()
    try {
      const first = acquireLock(root)
      assert.throws(() => acquireLock(root), /locked/)
      first.release()
      first.release()
      acquireLock(root).release()
    } finally {
      cleanup()
    }
  })

  test('release attempts close after rollback fails and can be retried after close fails', ({
    assert,
  }) => {
    const { root, cleanup } = tempRoot()
    const prototype = Database.prototype as {
      exec: (this: { name: string }, sql: string) => unknown
      close: (this: { name: string }) => void
    }
    const originalExec = prototype.exec
    const originalClose = prototype.close
    let failClose = true
    const lock = acquireLock(root)
    prototype.exec = function (sql) {
      if (this.name.endsWith('/.backup.lock') && sql === 'ROLLBACK')
        throw new Error('rollback failed')
      return originalExec.call(this, sql)
    }
    prototype.close = function () {
      if (this.name.endsWith('/.backup.lock') && failClose) throw new Error('close failed')
      originalClose.call(this)
    }
    try {
      let error: (Error & { resourceCleanupErrors?: Error[] }) | undefined
      try {
        lock.release()
      } catch (caught) {
        error = caught as Error & { resourceCleanupErrors?: Error[] }
      }
      assert.match(String(error), /rollback failed/)
      assert.match(String(error?.resourceCleanupErrors?.[0]), /close failed/)
      prototype.exec = originalExec
      failClose = false
      lock.release()
      acquireLock(root).release()
    } finally {
      prototype.exec = originalExec
      prototype.close = originalClose
      try {
        lock.release()
      } finally {
        cleanup()
      }
    }
  })

  test('release retains falsy rollback and close failures', ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const prototype = Database.prototype as {
      exec: (this: { name: string }, sql: string) => unknown
      close: (this: { name: string }) => void
    }
    const originalExec = prototype.exec
    const originalClose = prototype.close
    const lock = acquireLock(root)
    prototype.exec = function (sql) {
      if (this.name.endsWith('/.backup.lock') && sql === 'ROLLBACK') throw undefined
      return originalExec.call(this, sql)
    }
    prototype.close = function () {
      if (this.name.endsWith('/.backup.lock')) throw 0
      originalClose.call(this)
    }
    try {
      let failure: unknown
      try {
        lock.release()
        assert.fail('release should throw')
      } catch (error) {
        failure = error
      }
      assert.instanceOf(failure, AggregateError)
      assert.deepEqual((failure as AggregateError).errors, [undefined, 0])
    } finally {
      prototype.exec = originalExec
      prototype.close = originalClose
      try {
        lock.release()
      } finally {
        cleanup()
      }
    }
  })

  test('a single falsy rollback failure is still thrown after close succeeds', ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const prototype = Database.prototype as {
      exec: (this: { name: string }, sql: string) => unknown
    }
    const originalExec = prototype.exec
    const lock = acquireLock(root)
    prototype.exec = function (sql) {
      if (this.name.endsWith('/.backup.lock') && sql === 'ROLLBACK') throw undefined
      return originalExec.call(this, sql)
    }
    try {
      let caught = false
      try {
        lock.release()
      } catch (error) {
        caught = true
        assert.isUndefined(error)
      }
      assert.isTrue(caught)
      lock.release()
      prototype.exec = originalExec
      acquireLock(root).release()
    } finally {
      prototype.exec = originalExec
      cleanup()
    }
  })

  test('failed acquisition retains a non-Error primary and close failure', ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const prototype = Database.prototype as {
      exec: (this: { name: string }, sql: string) => unknown
      close: (this: { name: string }) => void
    }
    const originalExec = prototype.exec
    const originalClose = prototype.close
    let handle: { name: string } | undefined
    prototype.exec = function (sql) {
      if (this.name.endsWith('/.backup.lock') && sql === 'BEGIN EXCLUSIVE') throw false
      return originalExec.call(this, sql)
    }
    prototype.close = function () {
      if (this.name.endsWith('/.backup.lock')) {
        handle = this
        throw 0
      }
      originalClose.call(this)
    }
    try {
      let failure: unknown
      try {
        acquireLock(root)
        assert.fail('acquisition should throw')
      } catch (error) {
        failure = error
      }
      assert.instanceOf(failure, AggregateError)
      assert.deepEqual((failure as AggregateError).errors, [false, 0])
    } finally {
      prototype.exec = originalExec
      prototype.close = originalClose
      try {
        if (handle) originalClose.call(handle)
      } finally {
        cleanup()
      }
    }
  })

  test('another process holding the lock blocks; its death releases it', async ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const holder = await startChild('lock', root)
    try {
      try {
        acquireLock(root)
        assert.fail('lock should be held by the child')
      } catch (error) {
        assert.equal((error as { code: string }).code, 'E_BACKUP_LOCKED')
      }
      await stopChild(holder, 'SIGKILL')
      acquireLock(root).release()
    } finally {
      await stopChild(holder)
      cleanup()
    }
  }).timeout(20_000)

  test('lockTimeoutMs waits for the holder', async ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const holder = await startChild('lock', root, '300')
    try {
      const started = Date.now()
      acquireLock(root, 5000).release()
      assert.isAtLeast(Date.now() - started, 100)
    } finally {
      await stopChild(holder)
      cleanup()
    }
  }).timeout(20_000)

  test('async create wait yields for another process and bounds refusal', async ({ assert }) => {
    const { root, cleanup } = tempRoot()
    const holder = await startChild('lock', root, '300')
    try {
      const started = Date.now()
      await assert.rejects(() => acquireCreateLock(root, 40), /locked/)
      assert.isBelow(Date.now() - started, 500)
      const waited = await acquireCreateLock(root, 5_000)
      waited.release()
    } finally {
      await stopChild(holder)
      cleanup()
    }
  }).timeout(20_000)

  test('an unopenable lock path is E_BACKUP_UNSAFE; a damaged lock file is truncated and works', async ({
    assert,
  }) => {
    assert.throws(() => acquireLock('/nonexistent/dir/for/lock'), /cannot open lock file/)
    const { root, cleanup } = tempRoot()
    try {
      writeFileSync(join(root, '.backup.lock'), 'x'.repeat(4096))
      const held = acquireLock(root)
      assert.equal(statSync(join(root, '.backup.lock')).size, 0)
      assert.throws(() => acquireLock(root), /locked/)
      held.release()
    } finally {
      cleanup()
    }
  })
})
