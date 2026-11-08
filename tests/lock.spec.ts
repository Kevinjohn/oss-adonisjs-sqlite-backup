import { test } from '@japa/runner'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../src/lock.js'
import { startChild, stopChild, tempRoot } from './helpers.js'

test.group('Directory lock', () => {
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
