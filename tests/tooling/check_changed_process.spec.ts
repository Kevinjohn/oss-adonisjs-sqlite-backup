import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { test } from '@japa/runner'
import { collectExit, isAlive, outputOf, waitForFile } from '../helpers/child_process.js'
import { fileURLToPath } from 'node:url'
import { startChild } from '../helpers.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runnerPath = path.join(repoRoot, 'bin/check_changed.ts')
const plannerPath = path.join(repoRoot, 'bin/check_changed_plan.ts')

type FixtureOptions = {
  command?: 'normal' | 'hang' | 'missing'
  hook?: 'record-term' | 'fail-reap'
}

type Fixture = {
  directory: string
  root: string
  bin: string
  log: string
  ready: string
  termSent: string
  base: string
  env: NodeJS.ProcessEnv
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-check-changed-'))
  const root = path.join(directory, 'checkout')
  const bin = path.join(directory, 'bin')
  const supportBin = path.join(directory, 'support-bin')
  await mkdir(path.join(root, 'bin'), { recursive: true })
  await mkdir(bin)
  await mkdir(supportBin)
  await writeFile(path.join(root, 'bin/check_changed.ts'), await readFile(runnerPath))
  await writeFile(path.join(root, 'bin/check_changed_plan.ts'), await readFile(plannerPath))
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(path.join(root, 'README.md'), 'fixture baseline\n')
  await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')

  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  await symlink(git, path.join(supportBin, 'git'))
  const runGit = (args: string[]) => execFileSync(git, args, { cwd: root, stdio: 'ignore' })
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'fixture@example.test'])
  runGit(['config', 'user.name', 'Fixture'])
  runGit(['add', '.'])
  runGit(['commit', '-qm', 'fixture baseline'])
  const base = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  await writeFile(path.join(root, 'src-trigger.ts'), 'export const changed = true\n')
  runGit(['add', 'src-trigger.ts'])
  runGit(['commit', '-qm', 'select static checks'])
  const log = path.join(directory, 'commands.log')
  const ready = path.join(directory, 'descendant.pid')
  const termSent = path.join(directory, 'term-sent')
  await writeFile(log, '')

  await writeFile(
    path.join(root, 'worker.js'),
    `import { writeFile } from 'node:fs/promises'\nprocess.on('SIGTERM', () => {})\nawait writeFile(${JSON.stringify(ready)}, String(process.pid) + '\\n')\nsetInterval(() => {}, 1000)\n`
  )
  if (options.command !== 'missing') {
    const commandPath = path.join(bin, 'pnpm')
    await writeFile(
      commandPath,
      `#!${process.execPath}\nimport { spawn } from 'node:child_process'\nimport { readFile, writeFile } from 'node:fs/promises'\nconst args = process.argv.slice(2)\nawait writeFile(${JSON.stringify(log)}, (await readFile(${JSON.stringify(log)}, 'utf8')) + args.join(' ') + '\\n')\nif (process.env.CHECK_CHANGED_HANG === '1') {\n  spawn(process.execPath, ['worker.js'], { cwd: process.cwd(), stdio: 'ignore' })\n  for (let attempt = 0; attempt < 250; attempt++) {\n    if (/^[1-9]\\d*\\n$/.test(await readFile(${JSON.stringify(ready)}, 'utf8').catch(() => ''))) break\n    await new Promise((resolve) => setTimeout(resolve, 20))\n  }\n  setInterval(() => {}, 1000)\n}\n`,
      { mode: 0o755 }
    )
  }

  if (options.hook) {
    const hookPath = path.join(directory, 'process-hook.cjs')
    const recordTerm = options.hook === 'record-term'
    await writeFile(
      hookPath,
      `const original = process.kill.bind(process)\nlet killedGroup = null\nprocess.kill = (pid, signal) => {\n  if (pid < 0 && signal === 'SIGTERM') require('node:fs').writeFileSync(${JSON.stringify(termSent)}, String(process.pid) + '\\n')\n  if (pid < 0 && signal === 'SIGKILL') { killedGroup = pid; return original(pid, signal) }\n  if (${recordTerm ? 'false' : 'true'} && pid === killedGroup && signal === 0) return true\n  return original(pid, signal)\n}\n`
    )
  }

  await chmod(directory, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${supportBin}`,
  }
  delete env.CHECK_CHANGED_HANG
  if (options.command === 'hang') env.CHECK_CHANGED_HANG = '1'
  if (options.hook) {
    env.NODE_OPTIONS =
      `${env.NODE_OPTIONS ?? ''} --require=${path.join(directory, 'process-hook.cjs')}`.trim()
  }
  return { directory, root, bin, log, ready, termSent, base, env }
}

function launch(f: Fixture): ChildProcess {
  return spawn(
    process.execPath,
    ['--import=@poppinss/ts-exec', path.join(f.root, 'bin/check_changed.ts'), '--static', f.base],
    { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

test('runs selected static checks normally and observes a missing command spawn error', async ({
  cleanup,
}) => {
  const normal = await fixture()
  cleanup(() => rm(normal.directory, { recursive: true, force: true }))
  const normalChild = launch(normal)
  const normalOutput = await outputOf(normalChild)
  const normalResult = await collectExit(normalChild, normalOutput)
  assert.equal(normalResult.code, 0, normalResult.text)
  assert.match(normalResult.text, /pass format/)
  assert.match(await readFile(normal.log, 'utf8'), /exec prettier --check/)

  const missing = await fixture({ command: 'missing' })
  cleanup(() => rm(missing.directory, { recursive: true, force: true }))
  const missingChild = launch(missing)
  const missingOutput = await outputOf(missingChild)
  const missingResult = await collectExit(missingChild, missingOutput)
  assert.equal(missingResult.code, 1, missingResult.text)
  assert.match(missingResult.text, /spawn failed: spawn pnpm ENOENT/)
  assert.doesNotMatch(missingResult.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(30_000)

test('TERM-resistant descendants receive KILL, are reaped, and block later selected checks', async ({
  cleanup,
}) => {
  const f = await fixture({ command: 'hang' })
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const child = launch(f)
  const output = await outputOf(child)
  const descendantPid = await waitForFile(f.ready)
  child.kill('SIGTERM')
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /fail format \(exit killed\)/)
  assert.doesNotMatch(await readFile(f.log, 'utf8'), /pnpm lint|pnpm typecheck/)
  assert.equal(await isAlive(descendantPid), false)
  assert.doesNotMatch(result.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(20_000)

test('a second signal escalates immediately while the first signal determines the exit code', async ({
  cleanup,
}) => {
  const f = await fixture({ command: 'hang', hook: 'record-term' })
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const child = launch(f)
  const output = await outputOf(child)
  const descendantPid = await waitForFile(f.ready)
  child.kill('SIGTERM')
  await waitForFile(f.termSent)
  child.kill('SIGINT')
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.equal(await isAlive(descendantPid), false)
  assert.doesNotMatch(await readFile(f.log, 'utf8'), /pnpm lint|pnpm typecheck/)
}).timeout(15_000)

test('reports failed final reap and retains the first signal result', async ({ cleanup }) => {
  const f = await fixture({ command: 'hang', hook: 'fail-reap' })
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const child = launch(f)
  const output = await outputOf(child)
  await waitForFile(f.ready)
  child.kill('SIGTERM')
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /cleanup failed:.*did not exit after SIGKILL/s)
  assert.doesNotMatch(await readFile(f.log, 'utf8'), /pnpm lint|pnpm typecheck/)
  assert.doesNotMatch(result.text, /UnhandledPromiseRejection|unhandledRejection/)
}).timeout(20_000)

test('interrupt settles a never-closing owned child and releases its live local handles', async ({
  cleanup,
}) => {
  const f = await fixture()
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const hook = path.join(f.directory, 'never-close.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999; child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 const liveHandle = setInterval(() => {}, 1000)
 child.unref = () => { clearInterval(liveHandle); console.log('LOCAL_HANDLE_RELEASED') }
 setImmediate(() => { child.stdout.write('partial output'); process.emit('SIGTERM') })
 return child
}
process.kill = () => true
let clock = 0; Date.now = () => (clock += 6000)
require('node:module').syncBuiltinESMExports()
`
  )
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(f)
  const output = await outputOf(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 143, result.text)
  assert.match(result.text, /did not exit after SIGKILL/)
  assert.match(result.text, /partial output/)
  assert.match(result.text, /LOCAL_HANDLE_RELEASED/)
  assert.equal(await readFile(f.log, 'utf8'), '')
}).timeout(10_000)

test('deadline settles a never-closing owned child with timeout diagnostics', async ({
  cleanup,
}) => {
  const f = await fixture()
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const hook = path.join(f.directory, 'deadline-hook.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const realSetTimeout = global.setTimeout
global.setTimeout = (callback, delay, ...args) => {
 if (delay === 900000) { setImmediate(callback); return realSetTimeout(() => {}, 0) }
 return realSetTimeout(callback, delay, ...args)
}
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999; child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 const liveHandle = setInterval(() => {}, 1000)
 child.unref = () => { clearInterval(liveHandle); console.log('LOCAL_HANDLE_RELEASED') }
 setImmediate(() => child.stdout.write('partial timeout output'))
 return child
}
process.kill = () => true
let clock = 0; Date.now = () => (clock += 6000)
require('node:module').syncBuiltinESMExports()
`
  )
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(f)
  const output = await outputOf(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /stopped after 15 minutes/)
  assert.match(result.text, /did not exit after SIGKILL/)
  assert.match(result.text, /LOCAL_HANDLE_RELEASED/)
  assert.equal(await readFile(f.log, 'utf8'), '')
}).timeout(10_000)

test('a stale deadline cannot signal a later child', async ({ cleanup }) => {
  const f = await fixture()
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const hook = path.join(f.directory, 'stale-deadline-hook.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const realSetTimeout = global.setTimeout
let firstDeadline
global.setTimeout = (callback, delay, ...args) => {
 if (delay === 900000) { if (!firstDeadline) firstDeadline = callback; return realSetTimeout(() => {}, 0) }
 return realSetTimeout(callback, delay, ...args)
}
let count = 0
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999 + ++count
 child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 setImmediate(() => {
   if (count === 2) firstDeadline()
   child.stdout.end('finished')
   child.stderr.end()
   child.emit('close', 0, null)
 })
 return child
}
process.kill = () => { throw new Error('stale deadline signalled a child') }
require('node:module').syncBuiltinESMExports()
`
  )
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(f)
  const output = await outputOf(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /pass lint/)
  assert.doesNotMatch(result.text, /stale deadline signalled/)
}).timeout(10_000)

test('failed step retains only a bounded tail of captured output', async ({ cleanup }) => {
  const f = await fixture()
  cleanup(() => rm(f.directory, { recursive: true, force: true }))
  const hook = path.join(f.directory, 'large-output-hook.cjs')
  await writeFile(
    hook,
    `
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
cp.spawn = () => {
 const child = new EventEmitter(); child.pid = 99999999
 child.exitCode = child.signalCode = null
 child.stdout = new PassThrough(); child.stderr = new PassThrough()
 setImmediate(() => {
   child.stdout.end('x'.repeat(1024 * 1024) + 'TAIL_MARKER')
   child.stderr.end()
   child.emit('close', 1, null)
 })
 return child
}
require('node:module').syncBuiltinESMExports()
`
  )
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${hook}`
  const child = launch(f)
  const output = await outputOf(child)
  const result = await collectExit(child, output)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /TAIL_MARKER/)
  assert.ok(result.text.length < 210 * 1024, `captured ${result.text.length} characters`)
}).timeout(10_000)
test('PID readiness ignores empty and numeric-prefix records until framed', async ({ cleanup }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-pid-record-'))
  cleanup(() => rm(directory, { recursive: true, force: true }))
  const record = path.join(directory, 'pid')
  await writeFile(record, '')
  let settled = false
  const waiting = waitForFile(record, 1000).then((pid) => {
    settled = true
    return pid
  })
  await writeFile(record, '123')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  await writeFile(record, '123\n')
  assert.equal(await waiting, 123)
})

test('fixture startup rejects when its child exits before ready', async () => {
  await assert.rejects(startChild('invalid' as 'lock', ''), /exited before ready/)
}).timeout(10_000)

test('exit collection includes output delivered after exit and before close', async () => {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr })
  const output = await outputOf(child)
  const finished = collectExit(child, output)
  child.emit('exit', 0, null)
  stdout.write('last stdout')
  stderr.write(' and stderr')
  child.emit('close', 0, null)
  assert.deepEqual(await finished, { code: 0, signal: null, text: 'last stdout and stderr' })
})
