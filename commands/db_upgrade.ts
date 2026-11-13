import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { createBundle } from '../src/bundles.js'
import { prepareDirectory } from '../src/directory.js'
import type { BackupConfig } from '../src/types.js'
import { preMigrationBackupDirectory } from '../src/upgrade.js'

/** `node ace db:upgrade`: a verified snapshot of an existing database, then `migration:run`. */
export default class DbUpgrade extends BaseCommand {
  static commandName = 'db:upgrade'
  static description = 'Back up the SQLite database, then run pending migrations'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({
    description: 'Let migration:run generate schema classes afterwards',
    default: true,
    showNegatedVariantInHelp: true,
  })
  declare schemaGenerate: boolean

  async run() {
    try {
      const db = await this.app.container.make('lucid.db')
      const connectionConfig = db.getRawConnection(db.primaryConnectionName)?.config
      if (connectionConfig?.client !== 'better-sqlite3') {
        throw new Error('db:upgrade requires the configured SQLite connection')
      }
      const dbPath = (connectionConfig.connection as { filename: string }).filename
      const existing = await db
        .from('sqlite_master')
        .where({ type: 'table' })
        .select('name')
        .first()
      // An empty or in-memory database has nothing to roll back to.
      if (dbPath !== ':memory:' && existing) {
        const config = this.app.config.get<BackupConfig | undefined>('backup', undefined)
        const directory = preMigrationBackupDirectory(dbPath, config?.directory)
        prepareDirectory(directory)
        const bundle = await createBundle({ livePath: dbPath, directory })
        this.logger.success(`Pre-upgrade backup written ${bundle.path}`)
      }
      const migrate = await this.kernel.exec('migration:run', [
        '--force',
        ...(this.schemaGenerate ? [] : ['--no-schema-generate']),
      ])
      if (migrate.exitCode !== 0) {
        this.error = migrate.error
        this.exitCode = migrate.exitCode ?? 1
      }
    } catch (error) {
      this.logger.error(`Upgrade failed: ${String(error)}`)
      this.exitCode = 1
    }
  }
}
