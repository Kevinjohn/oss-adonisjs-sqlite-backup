import { prepareDirectory } from '../src/directory.js'
import { fork, type ChildProcess } from 'node:child_process'
import fs, {
  fstatSync,
  statSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/native.js'

/** A fresh temporary directory removed by the returned cleanup. */
export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'adonisjs-sqlite-backup-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Create a live database with parent/items tables and `rows` rows (~500 bytes each). */
export function makeLiveDatabase(path: string, options: { rows?: number; wal?: boolean } = {}) {
  const db = openDatabase(path)
  if (options.wal ?? true) db.pragma('journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS parent(id INTEGER PRIMARY KEY);' +
      'CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, body TEXT, parent_id INTEGER REFERENCES parent(id));' +
      'CREATE INDEX IF NOT EXISTS items_body ON items(body)'
  )
  db.exec('BEGIN')
  const insert = db.prepare('INSERT INTO items(body) VALUES (?)')
  for (let i = 0; i < (options.rows ?? 200); i++) insert.run(`${i}-${'x'.repeat(500)}`)
  db.exec('COMMIT')
  return db
}

export function countItems(path: string): number {
  const db = openDatabase(path, { readonly: true, fileMustExist: true })
  try {
    return (db.prepare('SELECT count(*) AS c FROM items').get() as { c: number }).c
  } finally {
    db.close()
  }
}

/** Overwrite bytes inside a file (used to corrupt a bundle). */
export function overwrite(path: string, offset: number, bytes: string) {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.from(bytes), 0, bytes.length, offset)
  } finally {
    closeSync(fd)
  }
}

/** Fork tests/fixtures/child.ts and wait for its ready message. */
export function startChild(
  mode: 'lock' | 'writer' | 'create' | 'crash-create' | 'crash-prune',
  arg: string,
  ...extra: string[]
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./fixtures/child.ts', import.meta.url), [mode, arg, ...extra], {
      execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
    })
    let ready = false
    const timer = setTimeout(
      () => fail(new Error('Child did not become ready within 5000 ms')),
      5000
    )
    const clear = () => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
    }
    const fail = (error: Error) => {
      if (ready) return
      ready = true
      clear()
      void stopChild(child).finally(() => reject(error))
    }
    const onError = (error: Error) => fail(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`Child exited before ready (code ${code}, signal ${signal})`))
    const onMessage = (message: unknown) => {
      if (message !== 'ready') return fail(new Error(String(message)))
      ready = true
      clear()
      resolve(child)
    }
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export async function stopChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', done)
      child.unref()
      resolve()
    }, 5000)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('close', done)
    child.kill(signal)
  })
}

/** Reject if `promise` takes longer than `ms` (turns a livelock into a red test). */
export function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Run a child to completion; resolves with its exit signal and any non-ready messages. */
export function runChild(
  mode: 'create' | 'crash-create' | 'crash-prune',
  ...args: string[]
): Promise<{ signal: NodeJS.Signals | null; code: number | null; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./fixtures/child.ts', import.meta.url), [mode, ...args], {
      execArgv: ['--import=@poppinss/ts-exec', '--no-warnings'],
    })
    const messages: string[] = []
    child.on('message', (message) => {
      if (message !== 'ready') messages.push(String(message))
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, messages }))
  })
}

/** Prepare a fixture root before calling the production create API. */
export function prepared<T extends { directory: string }>(input: T): T {
  prepareDirectory(input.directory)
  return input
}

/** Inject an fsync error for this directory only, leaving per-bundle syncs intact. */
export function failDirectorySync(directory: string, error: Error): () => void {
  const { dev, ino } = statSync(directory)
  const original = fs.fsyncSync
  fs.fsyncSync = (fd) => {
    const stat = fstatSync(fd)
    if (stat.dev === dev && stat.ino === ino) throw error
    original(fd)
  }
  syncBuiltinESMExports()
  return () => {
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
}
