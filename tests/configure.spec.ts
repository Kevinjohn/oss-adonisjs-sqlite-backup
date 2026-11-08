import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'

test('configure writes config/backup.ts and registers provider and commands once', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'adonisjs-sqlite-backup-configure-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      '{"type":"module","devDependencies":{"@adonisjs/assembler":"8.6.0"}}'
    )
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(
      join(root, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [] })\n`
    )
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules')
    )
    const importer = (specifier: string) =>
      specifier === '@kevinjohn/adonisjs-sqlite-backup'
        ? import(new URL('../index.ts', import.meta.url).href)
        : import(specifier)
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [], commands: [async () => new ListLoader([Configure])] },
      })
      .create(pathToFileURL(`${root}/`), { importer })

    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-sqlite-backup'])
    const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
    assert.equal(rc.match(/adonisjs-sqlite-backup\/sqlite_backup_provider/g)?.length, 1)
    assert.equal(rc.match(/adonisjs-sqlite-backup\/commands/g)?.length, 1)
    const config = await readFile(join(root, 'config/backup.ts'), 'utf8')
    assert.include(config, "from '@kevinjohn/adonisjs-sqlite-backup'")
    assert.include(config, "directory: app.makePath('storage/backups')")

    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-sqlite-backup'])
    assert.equal(await readFile(join(root, 'adonisrc.ts'), 'utf8'), rc)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)
