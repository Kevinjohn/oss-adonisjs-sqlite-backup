import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

/**
 * Writes config/backup.ts and registers the provider and the db:backup command. Ace finds a
 * command before any provider boots, so commands are registered in adonisrc, as Lucid does.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/backup.stub', {})
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider')
    rcFile.addCommand('@kevinjohn/adonisjs-sqlite-backup/commands')
  })
}
