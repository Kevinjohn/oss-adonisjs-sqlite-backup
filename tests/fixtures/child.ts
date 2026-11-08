/**
 * Second process for cross-process tests.
 *   lock <dir> [holdMs]           holds the backup directory lock until killed, or for holdMs
 *   writer <db>                   inserts rows continuously until killed
 *   create <db> <dir>             runs one create, sends 'start' then the result as JSON
 *   crash-create <db> <dir> <at>  SIGKILLs itself at a create step ('mid-copy' or a HookStep)
 *   crash-prune <dir> <keep>      SIGKILLs itself after the first bundle is unpublished
 */
import { statSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { prepareDirectory } from '../../src/directory.js'
import { createBundle } from '../../src/bundles.js'
import { internalHooks } from '../../src/internal_hooks.js'
import { acquireLock } from '../../src/lock.js'
import { openDatabase } from '../../src/native.js'
import { pruneBundles } from '../../src/prune.js'

const [mode, path, arg, at] = process.argv.slice(2) as [string, string, string?, string?]
const die = () => process.kill(process.pid, 'SIGKILL')

/** Kill this process from a worker once `file` has grown past `bytes` (the main thread is busy copying). */
const killWhenFileGrows = (file: string, bytes: number) =>
  new Worker(
    `const { statSync } = require('node:fs'); const { workerData: w } = require('node:worker_threads');
     for (;;) { try { if (statSync(w.file).size > w.bytes) process.kill(w.pid, 'SIGKILL') } catch {} }`,
    { eval: true, workerData: { file, bytes, pid: process.pid } }
  )

if (mode === 'lock') {
  // Keep a reference: an unreferenced handle is garbage-collected and closed, releasing the lock.
  const held = acquireLock(path)
  process.send!('ready')
  setInterval(() => held, 1000)
  if (arg) setTimeout(() => process.exit(0), Number(arg))
} else if (mode === 'writer') {
  const db = openDatabase(path, { timeout: 5000 })
  const insert = db.prepare('INSERT INTO items(body) VALUES (?)')
  process.send!('ready')
  const tick = () => {
    for (let i = 0; i < 50; i++) insert.run('w'.repeat(500))
    setImmediate(tick)
  }
  tick()
} else if (mode === 'create') {
  process.send!('ready')
  prepareDirectory(arg!)
  const result = await createBundle({ livePath: path, directory: arg! })
  process.send!(JSON.stringify(result))
  process.disconnect()
} else if (mode === 'crash-create') {
  internalHooks.step = (step, file) => {
    if (at === 'mid-copy' && step === 'create:copying') {
      killWhenFileGrows(file, Math.floor(statSync(path).size / 4))
    } else if (step === at) die()
  }
  process.send!('ready')
  await createBundle({ livePath: path, directory: arg! })
  process.send!('finished without crashing')
} else if (mode === 'crash-prune') {
  internalHooks.step = (step) => {
    if (step === 'prune:unpublished') die()
  }
  process.send!('ready')
  pruneBundles({ directory: path, keep: Number(arg) })
  process.send!('finished without crashing')
}
