/**
 * Measures create / verify / restore-prepare on a ~300 MB database while another process writes.
 * Not a test. Run: node --import=@poppinss/ts-exec bin/measure_size.ts
 * Works under tmp/ (real disk; /tmp may be tmpfs, where fsync is free) and deletes it at the end.
 */
import { fork } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
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
    } catch {
      busy++
    }
    max = Math.max(max, performance.now() - started)
    setTimeout(tick, 2)
  }
  tick()
} else {
  const root = join(process.cwd(), 'tmp', `size-${process.pid}`)
  const live = join(root, 'live.db')
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  const time = async <T>(fn: () => T | Promise<T>) => {
    const started = performance.now()
    const value = await fn()
    return { value, ms: Math.round(performance.now() - started) }
  }
  mkdirSync(root, { recursive: true })
  try {
    const seed = openDatabase(live)
    seed.pragma('journal_mode = WAL')
    seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)')
    const insert = seed.prepare('INSERT INTO items (body) VALUES (?)')
    for (let batch = 0; batch < 60; batch++) {
      seed.exec('BEGIN')
      for (let i = 0; i < 10_000; i++) insert.run(`${batch}-${i}-${'x'.repeat(480)}`)
      seed.exec('COMMIT')
    }
    seed.pragma('wal_checkpoint(TRUNCATE)')
    seed.close()
    console.log(`database: ${mb(statSync(live).size)} MB, 600000 rows`)

    for (const mode of ['wal', 'delete']) {
      const set = openDatabase(live)
      set.pragma(`journal_mode = ${mode}`)
      set.close()
      const writer = fork(new URL(import.meta.url), ['writer', live], {
        execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
      })
      await new Promise((resolve) => writer.once('message', resolve))
      const sampler = new Worker(
        `const { statSync } = require('node:fs'); const { workerData, parentPort } = require('node:worker_threads');
         let peak = 0; const t = setInterval(() => { try { peak = Math.max(peak, statSync(workerData).size) } catch {} }, 1);
         parentPort.on('message', () => { clearInterval(t); parentPort.postMessage(peak) })`,
        { eval: true, workerData: `${live}-wal` }
      )
      const directory = join(root, `bundles-${mode}`)
      prepareDirectory(directory)
      const created = await time(() => createBundle({ livePath: live, directory }))
      sampler.postMessage('stop')
      const peakWal = await new Promise<number>((resolve) => sampler.once('message', resolve))
      await sampler.terminate()
      writer.send('stop')
      const stats = JSON.parse(
        String(await new Promise((resolve) => writer.once('message', resolve)))
      ) as { max: number; writes: number; busy: number }
      const verified = await time(() => verifyBundle(directory, created.value.name))
      const restored = await time(() =>
        prepareRestore({ directory, target: join(root, `staged-${mode}.db`), livePath: live })
      )
      console.log(
        `${mode}: create ${created.ms} ms, verify ${verified.ms} ms, restore-prepare ${restored.ms} ms, ` +
          `peak WAL ${mb(peakWal)} MB, writer: ${stats.writes} writes, max ${stats.max.toFixed(1)} ms, ${stats.busy} busy errors`
      )
      rmSync(directory, { recursive: true, force: true })
      rmSync(join(root, `staged-${mode}.db`), { force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
