import { prepared } from './helpers.js'
import { test } from '@japa/runner'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles } from '../src/bundles.js'
import { acquireLock } from '../src/lock.js'
import { pruneBundles } from '../src/prune.js'
import { makeLiveDatabase, startChild, stopChild, tempRoot } from './helpers.js'

test.group('pruneBundles', (group) => {
  let root: string
  let cleanup: () => void
  let live: string
  let directory: string
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
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
