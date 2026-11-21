import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { test } from '@japa/runner'
import {
  stopWriter,
  waitForSamplerPeak,
  waitForWriterReady,
  withClosedDatabase,
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

function writerError(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'error'
      ) {
        child.off('message', onMessage)
        child.off('error', onError)
        child.off('exit', onExit)
        resolve()
      }
    }
    const onError = (error: Error) => {
      child.off('message', onMessage)
      child.off('exit', onExit)
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off('message', onMessage)
      child.off('error', onError)
      reject(new Error(`Writer exited before reporting its error (code ${code}, signal ${signal})`))
    }
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

test('rejects writer readiness on early exit and waits for process close', async () => {
  const child = writer('exit-before-ready')
  await assert.rejects(
    withWriter(child, async () => undefined),
    /exited before responding/
  )
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('rejects writer readiness on a process spawn error', async () => {
  const child = fork(new URL('../fixtures/measure_size_writer.ts', import.meta.url), ['normal'], {
    execPath: join(tmpdir(), `missing-node-${process.pid}`),
  })
  await assert.rejects(
    withWriter(child, async () => undefined),
    /ENOENT/
  )
})

test('writer stats timeout terminates and reaps the writer', async () => {
  const child = writer('no-stats')
  await assert.rejects(
    withWriter(child, async () => stopWriter(child, 50)),
    /Writer stats timed out/
  )
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('rejects invalid writer stats', async () => {
  const child = writer('bad-stats')
  await assert.rejects(
    withWriter(child, () => stopWriter(child)),
    /invalid stats/
  )
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('stopWriter waits for a controlled delayed child close', async () => {
  const child = fork(
    new URL('../fixtures/measure_size_writer.ts', import.meta.url),
    ['delayed-close'],
    {
      execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
      silent: true,
    }
  )
  child.stdout?.resume()
  child.stderr?.resume()
  let settled = false
  let returnedBeforeCloseSignal = false
  child.on('message', (message) => {
    if (typeof message !== 'string' || !message.startsWith('{')) return
    setImmediate(() => {
      returnedBeforeCloseSignal = settled
      child.send('close-now')
    })
  })
  await waitForWriterReady(child)
  const result = await stopWriter(child).finally(() => (settled = true))
  assert.deepEqual(result, { max: 1, writes: 2, busy: 3 })
  assert.equal(returnedBeforeCloseSignal, false)
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
  // Listen from the start: the writer sends its error straight after `ready`, and both messages
  // can arrive before a listener added once `ready` is seen.
  const writerFailed = writerError(child)
  writerFailed.catch(() => {})
  let releaseOperation!: () => void
  let reportErrorObserved!: () => void
  const operationGate = new Promise<void>((resolve) => (releaseOperation = resolve))
  const errorObserved = new Promise<void>((resolve) => (reportErrorObserved = resolve))
  const operation = withWriter(child, async () => {
    await within(writerFailed, 8000, 'unexpected SQLite writer error was not reported')
    reportErrorObserved()
    await operationGate
    return stopWriter(child, 250)
  })
  const outcome = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  try {
    // The operation settles first when the writer fails some other way; the assertions report it.
    await Promise.race([errorObserved, outcome])
    releaseOperation()
    const result = await outcome
    assert.ok('error' in result)
    assert.match(String(result.error), /writer failure/)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  } finally {
    releaseOperation()
    await outcome
    rmSync(root, { recursive: true, force: true })
  }
})

test('create failure terminates both writer and sampler before returning', async () => {
  const child = writer('normal')
  const worker = sampler()
  await assert.rejects(
    withWriter(child, () =>
      withSampler(worker, async () => {
        throw new Error('create failed')
      })
    ),
    /create failed/
  )
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(worker.threadId, -1)
})

test('waits for a pending operation after sampler exit before releasing its files', async () => {
  const root = mkdtempSync(join(tmpdir(), `measure-size-pending-${process.pid}-`))
  const marker = join(root, 'bundle-partial')
  writeFileSync(marker, 'owned by the pending operation')
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
     parentPort.on('message', () => process.exit(1))`,
    { eval: true }
  )
  let releaseOperation!: () => void
  let operationStarted!: () => void
  const started = new Promise<void>((resolve) => (operationStarted = resolve))
  const gate = new Promise<void>((resolve) => (releaseOperation = resolve))
  let scopeSettled = false
  const scope = withSampler(worker, async () => {
    operationStarted()
    await gate
    assert.equal(existsSync(marker), true)
  }).finally(() => {
    scopeSettled = true
    rmSync(root, { recursive: true, force: true })
  })

  try {
    await started
    worker.postMessage('exit')
    await once(worker, 'exit')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(scopeSettled, false)

    releaseOperation()
    await assert.rejects(scope, /Sampler exited unexpectedly/)
    assert.equal(scopeSettled, true)
  } finally {
    releaseOperation()
    rmSync(root, { recursive: true, force: true })
    if (worker.threadId !== -1) await worker.terminate()
  }
})

test('closes the database and preserves its operation error', () => {
  const root = mkdtempSync(join(tmpdir(), `measure-size-db-${process.pid}-`))
  const db = openDatabase(join(root, 'seed.db'))
  const failure = new Error('seed setup failed')
  try {
    assert.throws(
      () =>
        withClosedDatabase(db, () => {
          throw failure
        }),
      (error) => error === failure
    )
    assert.throws(() => db.exec('SELECT 1'), /not open/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('samples the peak and closes the worker and writer on the normal path', async () => {
  const child = writer('normal')
  const worker = sampler()
  const result = await withWriter(child, async () =>
    withSampler(worker, async () => {
      const peak = await waitForSamplerPeak(worker)
      const stats = await stopWriter(child)
      return { peak, stats }
    })
  )
  assert.deepEqual(result, { peak: 42, stats: { max: 1, writes: 2, busy: 3 } })
  assert.equal(worker.threadId, -1)
})
