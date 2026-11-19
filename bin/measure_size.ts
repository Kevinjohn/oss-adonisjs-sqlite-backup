/**
 * Measures create / verify / restore-prepare on a ~300 MB database while another process writes.
 * Not a test. Run: node --import=@poppinss/ts-exec bin/measure_size.ts
 * Works under tmp/ (real disk; /tmp may be tmpfs, where fsync is free) and deletes it at the end.
 */
import { fork } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  hasCleanupFailure,
  stopWriter,
  waitForSamplerPeak,
  withClosedDatabase,
  withSampler,
  withWriter,
} from './measure_size_support.js'
import { prepareDirectory } from '../src/directory.js'
import { createBundle, verifyBundle } from '../src/bundles.js'
import { openDatabase } from '../src/native.js'
import { prepareRestore } from '../src/restore.js'

const [role, livePath] = process.argv.slice(2)

if (role === 'writer') {
  // Separate process: one small transaction at a time; reports max latency and busy errors.
  const db = openDatabase(livePath!, { timeout: 10_000 })
  const insert = db.prepare('INSERT INTO items (body) VALUES (?)')
  let max = 0
  let writes = 0
  let busy = 0
  let stop = false
  process.on('message', () => (stop = true))
  process.send!('ready')
  const tick = () => {
    if (stop) {
      process.send!(JSON.stringify({ max, writes, busy }), () => process.exit(0))
      return
    }
    const started = performance.now()
    try {
      insert.run('w'.repeat(200))
      writes++
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'SQLITE_BUSY' || code?.startsWith('SQLITE_BUSY_')) busy++
      else {
        db.close()
        process.send!({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        process.exitCode = 1
        return
      }
    }
    max = Math.max(max, performance.now() - started)
    setTimeout(tick, 2)
  }
  tick()
} else {
  const root = join(process.cwd(), 'tmp', `size-${process.pid}`)
  const live = join(root, 'live.db')
  const formatMebibytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  let removeRoot = true
  const measureElapsedTime = async <T>(fn: () => T | Promise<T>) => {
    const started = performance.now()
    const value = await fn()
    return { value, ms: Math.round(performance.now() - started) }
  }
  mkdirSync(root, { recursive: true })
  let benchmarkFailed = false
  let benchmarkError: unknown
  try {
    const seed = openDatabase(live)
    withClosedDatabase(seed, () => {
      seed.pragma('journal_mode = WAL')
      seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
      const insert = seed.prepare('INSERT INTO items (body) VALUES (?)')
      for (let batch = 0; batch < 60; batch++) {
        seed.exec('BEGIN')
        for (let i = 0; i < 10_000; i++) insert.run(`${batch}-${i}-${'x'.repeat(480)}`)
        seed.exec('COMMIT')
      }
      seed.pragma('wal_checkpoint(TRUNCATE)')
    })
    console.log(`database: ${formatMebibytes(statSync(live).size)} MB, 600000 rows`)

    for (const mode of ['wal', 'delete']) {
      const set = openDatabase(live)
      withClosedDatabase(set, () => set.pragma(`journal_mode = ${mode}`))
      const writer = fork(new URL(import.meta.url), ['writer', live], {
        execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
      })
      try {
        await withWriter(writer, async () => {
          const sampler = new Worker(
            `const { statSync } = require('node:fs'); const { workerData, parentPort } = require('node:worker_threads');
           let peak = 0; const t = setInterval(() => { try { peak = Math.max(peak, statSync(workerData).size) } catch {} }, 1);
           parentPort.on('message', () => { clearInterval(t); parentPort.postMessage(peak) })`,
            { eval: true, workerData: `${live}-wal` }
          )
          await withSampler(sampler, async () => {
            const directory = join(root, `bundles-${mode}`)
            prepareDirectory(directory)
            const created = await measureElapsedTime(() =>
              createBundle({ livePath: live, directory })
            )
            const peakWal = await waitForSamplerPeak(sampler)
            const stats = await stopWriter(writer)
            const verified = await measureElapsedTime(() =>
              verifyBundle(directory, created.value.name)
            )
            const restored = await measureElapsedTime(() =>
              prepareRestore({ directory, target: join(root, `staged-${mode}.db`), livePath: live })
            )
            console.log(
              `${mode}: create ${created.ms} ms, verify ${verified.ms} ms, restore-prepare ${restored.ms} ms, ` +
                `peak WAL ${formatMebibytes(peakWal)} MB, writer: ${stats.writes} writes, max ${stats.max.toFixed(1)} ms, ${stats.busy} busy errors`
            )
            rmSync(directory, { recursive: true, force: true })
            rmSync(join(root, `staged-${mode}.db`), { force: true })
          })
        })
      } catch (error) {
        if (hasCleanupFailure(error)) removeRoot = false
        throw error
      }
    }
  } catch (error) {
    benchmarkFailed = true
    benchmarkError = error
  }

  try {
    if (removeRoot) rmSync(root, { recursive: true, force: true })
    else console.error(`kept benchmark directory because a worker may still be active: ${root}`)
  } catch (cleanupError) {
    if (benchmarkFailed) {
      throw new AggregateError(
        [benchmarkError, cleanupError],
        'Benchmark and temporary directory cleanup failed'
      )
    }
    throw cleanupError
  }

  if (benchmarkFailed) throw benchmarkError
}
