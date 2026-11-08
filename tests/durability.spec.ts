import { prepared } from './helpers.js'
/** Every publish step is fsynced in order: file, then its directory, before the next step. */
import { test } from '@japa/runner'
import { join, relative } from 'node:path'
import { createBundle } from '../src/bundles.js'
import { internalHooks } from '../src/internal_hooks.js'
import { pruneBundles } from '../src/prune.js'
import { prepareRestore } from '../src/restore.js'
import { makeLiveDatabase, tempRoot } from './helpers.js'

test.group('durability', (group) => {
  let root: string
  let cleanup: () => void
  let events: string[]
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
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
      'sync b',
      'sync b/BUNDLE/db.sqlite',
      'write b/BUNDLE/manifest.json',
      'sync b/BUNDLE',
      'write b/BUNDLE/READY',
      'sync b/BUNDLE',
      'sync b',
    ])
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
})
