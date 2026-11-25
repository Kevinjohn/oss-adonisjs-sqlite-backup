import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.ts'

/**
 * Writes config/backup.ts and registers the provider and the loader for the db:backup and
 * db:upgrade Ace commands. Registers the Lucid command loader for schema generation.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/backup.stub', {})
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider')
    rcFile.addCommand('@kevinjohn/adonisjs-sqlite-backup/commands')
    rcFile.addCommand('@adonisjs/lucid/commands')
  })
}
