import { prepared } from './helpers.js'
/**
 * Crash safety: a create or prune SIGKILLed at each meaningful point leaves only READY bundles
 * visible, frees the lock, and the next prune removes exactly the unfinished folder.
 */
import { test } from '@japa/runner'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createBundle, listBundles, verifyBundle } from '../src/bundles.js'
import { acquireLock } from '../src/lock.js'
import { pruneBundles } from '../src/prune.js'
import { makeLiveDatabase, runChild, tempRoot } from './helpers.js'

const bundleDirs = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.startsWith('bak-utc-'))
    .sort()

/** The four post-crash guarantees. */
async function assertRecovers(
  assert: import('@japa/assert').Assert,
  live: string,
  directory: string,
  ready: string[],
  unfinished: string
) {
  assert.deepEqual(
    listBundles(directory).map((bundle) => bundle.name),
    ready,
    'list shows only READY bundles'
  )
  for (const name of ready) verifyBundle(directory, name)
  acquireLock(directory).release()
  const next = await createBundle(prepared({ livePath: live, directory }))
  const result = pruneBundles({ directory, keep: 100 })
  assert.deepEqual(result.abandoned, [unfinished], 'prune removes the unfinished folder')
  assert.deepEqual(result.removed, [], 'prune leaves READY bundles')
  assert.deepEqual(bundleDirs(directory), [...ready, next.name].sort())
  for (const name of [...ready, next.name]) verifyBundle(directory, name)
}

test.group('crash safety', (group) => {
  let root: string
  let cleanup: () => void
  group.each.setup(() => {
    ;({ root, cleanup } = tempRoot())
    return () => cleanup()
  })

  for (const at of ['mid-copy', 'create:copied', 'create:checked', 'create:manifest']) {
    test(`create killed at ${at}`, async ({ assert }) => {
      const live = join(root, 'live.db')
      makeLiveDatabase(live, { rows: at === 'mid-copy' ? 60_000 : 200 }).close()
      const directory = join(root, 'b')
      const first = await createBundle(prepared({ livePath: live, directory }))
      const second = await createBundle(prepared({ livePath: live, directory }))
      const ready = [first.name, second.name]

      const run = await runChild('crash-create', live, directory, at)
      assert.equal(run.signal, 'SIGKILL', `child output: ${run.messages.join(', ')}`)
      const [unfinished] = bundleDirs(directory).filter((name) => !ready.includes(name))
      assert.isDefined(unfinished, 'the crash left an unfinished folder')
      const files = readdirSync(join(directory, unfinished!))
      assert.notInclude(files, 'READY')
      if (at === 'mid-copy') {
        assert.notInclude(files, 'manifest.json')
        assert.isBelow(
          statSync(join(directory, unfinished!, 'db.sqlite')).size,
          statSync(live).size
        )
      }
      if (at === 'create:manifest') assert.include(files, 'manifest.json')

      await assertRecovers(assert, live, directory, ready, unfinished!)
    }).timeout(60_000)
  }

  test('prune killed after unpublishing its first bundle', async ({ assert }) => {
    const live = join(root, 'live.db')
    makeLiveDatabase(live).close()
    const directory = join(root, 'b')
    const names: string[] = []
    for (let i = 0; i < 4; i++) {
      const created = await createBundle(prepared({ livePath: live, directory }))
      names.push(created.name)
    }

    const run = await runChild('crash-prune', directory, '1')
    assert.equal(run.signal, 'SIGKILL', `child output: ${run.messages.join(', ')}`)
    const [victim, ...rest] = names
    assert.isTrue(existsSync(join(directory, victim!)), 'killed before removal')
    assert.isFalse(existsSync(join(directory, victim!, 'READY')), 'unpublished first')

    await assertRecovers(assert, live, directory, rest, victim!)
  }).timeout(60_000)
})
