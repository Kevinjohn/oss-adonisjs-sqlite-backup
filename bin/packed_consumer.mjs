import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const tarball = process.argv[2]
assert(tarball, 'usage: node bin/packed_consumer.mjs <tarball path or URL>')
const candidate = tarball.includes('://') ? tarball : resolve(tarball)
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert(
  Number(process.versions.node.split('.')[0]) >= Number(manifest.engines.node.match(/\d+/)[0]),
  `Node ${manifest.engines.node} is required`
)
const pnpmVersion = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
assert.equal(pnpmVersion.status, 0, 'pnpm is required')
assert.equal(
  pnpmVersion.stdout.trim(),
  manifest.packageManager.split('@')[1],
  'pnpm version must match packageManager'
)
const root = await mkdtemp(join(tmpdir(), 'sqlite-backup-consumer-'))
const fixture = fileURLToPath(new URL('./packed_consumer_fixture.mjs', import.meta.url))
const typesFixture = fileURLToPath(new URL('./packed_consumer_types.ts', import.meta.url))
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`)
}

try {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('pnpm', [
    'add',
    '--allow-build=better-sqlite3',
    candidate,
    '@adonisjs/core@^7.0.1',
    '@adonisjs/lucid@^22.4.2',
    '@adonisjs/assembler@^8.6.0',
    'better-sqlite3@^13.0.0',
    'luxon@^3.0.0',
    'typescript@^5.9.3',
    '@types/node@^24.0.0',
    '@types/luxon@^3.0.0',
  ])
  await copyFile(fixture, join(root, 'smoke.mjs'))
  await copyFile(typesFixture, join(root, 'smoke.ts'))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
      },
      files: ['smoke.ts'],
    })
  )
  run('pnpm', ['exec', 'tsc'])
  run('node', ['smoke.mjs'])
  console.log('packed consumer: configure, exports and booted backup passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
