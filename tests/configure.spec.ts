import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { FileSystem } from '@japa/file-system'
import { createTemporaryRoot } from './helpers.ts'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'

test('configure writes config/backup.ts and registers provider and commands once', async ({
  assert,
}) => {
  const { root } = createTemporaryRoot()
  const fs = new FileSystem(root)
  try {
    await fs.create(
      'package.json',
      '{"type":"module","devDependencies":{"@adonisjs/assembler":"8.6.0"}}'
    )
    await fs.create('tsconfig.json', '{}')
    await fs.create(
      'adonisrc.ts',
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
    const rc = await fs.contents('adonisrc.ts')
    assert.equal(rc.match(/adonisjs-sqlite-backup\/sqlite_backup_provider/g)?.length, 1)
    assert.equal(rc.match(/adonisjs-sqlite-backup\/commands/g)?.length, 1)
    assert.equal(rc.match(/@adonisjs\/lucid\/commands/g)?.length, 1)
    const config = await fs.contents('config/backup.ts')
    assert.include(config, "from '@kevinjohn/adonisjs-sqlite-backup'")
    assert.include(config, "directory: app.makePath('storage/backups')")

    const edited = config.replace('keep: 7', 'keep: 12')
    await fs.create('config/backup.ts', edited)
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-sqlite-backup'])
    assert.equal(await fs.contents('adonisrc.ts'), rc)
    assert.equal(await fs.contents('config/backup.ts'), edited)
  } finally {
    await fs.cleanup()
  }
}).timeout(30_000)
