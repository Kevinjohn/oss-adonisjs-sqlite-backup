import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

/**
 * Writes config/backup.ts and registers the provider and the loader for the db:backup and
 * db:upgrade Ace commands. Ace finds commands before any provider boots, as Lucid does.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/backup.stub', {})
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider')
    rcFile.addCommand('@kevinjohn/adonisjs-sqlite-backup/commands')
  })
}
