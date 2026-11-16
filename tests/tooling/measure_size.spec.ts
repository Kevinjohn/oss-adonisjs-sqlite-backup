import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { test } from '@japa/runner'
import {
  stopWriter,
  waitForSamplerPeak,
  withSampler,
  withWriter,
} from '../../bin/measure_size_support.js'
import { openDatabase } from '../../src/native.js'

function writer(mode: string): ChildProcess {
  return fork(new URL('../fixtures/measure_size_writer.ts', import.meta.url), [mode], {
    execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
  })
}

function sampler() {
  return new Worker(
    `const { parentPort } = require('node:worker_threads');
     const timer = setInterval(() => {}, 1000);
     parentPort.on('message', () => { clearInterval(timer); parentPort.postMessage(42) })`,
    { eval: true }
  )
}

function closed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('close', () => resolve()))
}

test('rejects writer readiness on early exit and waits for process close', async () => {
  const child = writer('exit-before-ready')
  const close = closed(child)
  await assert.rejects(
    withWriter(child, async () => undefined),
    /exited before responding/
  )
  await close
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('rejects writer readiness on a process spawn error', async () => {
  const child = fork(new URL('../fixtures/measure_size_writer.ts', import.meta.url), ['normal'], {
    execPath: join(tmpdir(), `missing-node-${process.pid}`),
  })
  const close = closed(child)
  await assert.rejects(
    withWriter(child, async () => undefined),
    /ENOENT/
  )
  await close
})

test('writer stats timeout terminates and reaps the writer', async () => {
  const child = writer('no-stats')
  const close = closed(child)
  await assert.rejects(
    withWriter(child, async () => stopWriter(child, 50)),
    /Writer stats timed out/
  )
  await close
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('surfaces unexpected SQLite writer errors instead of counting them as busy', async () => {
  const root = join(tmpdir(), `measure-size-${process.pid}-${Date.now()}`)
  mkdirSync(root)
  const live = join(root, 'live.db')
  const db = openDatabase(live)
  db.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT); ' +
      "CREATE TRIGGER fail_writes BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'writer failure'); END;"
  )
  db.close()
  const child = fork(new URL('../../bin/measure_size.ts', import.meta.url), ['writer', live], {
    execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
  })
  const childClosed = closed(child)
  try {
    await assert.rejects(
      withWriter(child, () => stopWriter(child)),
      /writer failure/
    )
    await childClosed
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('create failure terminates both writer and sampler before returning', async () => {
  const child = writer('normal')
  const childClosed = closed(child)
  const worker = sampler()
  await assert.rejects(
    withWriter(child, () =>
      withSampler(worker, async () => {
        throw new Error('create failed')
      })
    ),
    /create failed/
  )
  await childClosed
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(worker.threadId, -1)
})

test('samples the peak and closes the worker and writer on the normal path', async () => {
  const child = writer('normal')
  const childClosed = closed(child)
  const worker = sampler()
  const result = await withWriter(child, async () =>
    withSampler(worker, async () => {
      const peak = await waitForSamplerPeak(worker)
      const stats = await stopWriter(child)
      return { peak, stats }
    })
  )
  await childClosed
  assert.deepEqual(result, { peak: 42, stats: { max: 1, writes: 2, busy: 3 } })
  assert.equal(worker.threadId, -1)
})
