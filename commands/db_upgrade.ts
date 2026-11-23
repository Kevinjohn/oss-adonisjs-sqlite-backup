import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { createBundle } from '../src/bundles.js'
import { prepareDirectory } from '../src/directory.js'
import { resolveFilesystemPath } from '../src/paths.js'
import { assertSafeLayout, normalizeConfiguredSqliteFilename } from '../src/source.js'
import type { BackupConfig } from '../src/types.js'
import { preMigrationBackupDirectory } from '../src/upgrade.js'

/** `node ace db:upgrade`: a verified pre-migration backup bundle, then `migration:run`. */
export default class DbUpgrade extends BaseCommand {
  static commandName = 'db:upgrade'
  static description = 'Back up the SQLite database, then run pending migrations'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({
    description:
      'Generate schema classes with schema:generate after a successful migration, never in production',
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
      const dbPath = normalizeConfiguredSqliteFilename(
        (connectionConfig.connection as { filename: string }).filename,
        connectionConfig.client
      )
      const existing = await db
        .from('sqlite_master')
        .where({ type: 'table' })
        .select('name')
        .first()
      // An empty or in-memory database has nothing to roll back to.
      if (dbPath !== ':memory:' && existing) {
        if (!dbPath || /^file:/i.test(dbPath)) {
          throw new Error('db:upgrade requires a file-backed SQLite connection')
        }
        const config = this.app.config.get<BackupConfig | undefined>('backup', undefined)
        const directory = preMigrationBackupDirectory(dbPath, config?.directory)
        assertSafeLayout(resolveFilesystemPath(dbPath), resolveFilesystemPath(directory))
        prepareDirectory(directory)
        // The same journal table, lock timeout and WAL requirement as db:backup, read from the
        // connection being migrated.
        const bundle = await createBundle({
          livePath: dbPath,
          directory,
          migrationsTable: connectionConfig.migrations?.tableName,
          lockTimeoutMs: config?.lockTimeoutMs,
          requireWal: config?.requireWal,
        })
        for (const warning of bundle.warnings) this.logger.warning(warning)
        this.logger.success(`Pre-upgrade backup written ${bundle.path}`)
      }
      const migrate = await this.kernel.exec('migration:run', ['--force', '--no-schema-generate'])
      if (migrate.exitCode !== 0) {
        this.error = migrate.error
        this.exitCode = migrate.exitCode ?? 1
        return
      }
      // Generated here, not by migration:run: Lucid 22.0 and 22.1 generate after a failed
      // migration too, and the generator's exit code replaces the failure.
      if (this.schemaGenerate && !this.app.inProduction) {
        const generate = await this.kernel.exec('schema:generate', [
          `--connection=${db.primaryConnectionName}`,
        ])
        if (generate.exitCode !== 0) {
          this.error = generate.error
          this.exitCode = generate.exitCode ?? 1
        }
      }
    } catch (error) {
      this.logger.error(`Upgrade failed: ${String(error)}`)
      this.exitCode = 1
    }
  }
}
