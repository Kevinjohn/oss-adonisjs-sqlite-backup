import app from '@adonisjs/core/services/app'
import type { SqliteBackup } from '../src/sqlite_backup.js'
import type {} from '../providers/sqlite_backup_provider.js'

/** The configured application's backup service, resolved once the application has booted. */
let backup: SqliteBackup
await app.booted(async () => {
  backup = await app.container.make('sqlite.backup')
})

export { backup as default }
