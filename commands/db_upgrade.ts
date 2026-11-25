import { BaseCommand, flags } from '@adonisjs/core/ace'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { createBundle } from '../src/bundles.ts'
import { prepareDirectory } from '../src/directory.ts'
import { resolveFilesystemPath } from '../src/paths.ts'
import { assertSafeLayout, normalizeConfiguredSqliteFilename } from '../src/source.ts'
import type { BackupConfig } from '../src/types.ts'
import { preMigrationBackupDirectory } from '../src/upgrade.ts'

/**
 * `node ace db:upgrade`: a verified pre-migration backup bundle, then the pending migrations. A
 * failure is reported as one line; `error` and the exit code are left for a calling command.
 */
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

  #childReportedFailure = false

  /**
   * @throws AggregateError when the pre-migration backup and cleanup fail, or when multiple cleanup steps fail.
   */
  async run() {
    const db = await this.app.container.make('lucid.db')
    const connectionConfig = db.getRawConnection(db.primaryConnectionName)?.config
    if (connectionConfig?.client !== 'better-sqlite3') {
      throw new InvalidArgumentsException('db:upgrade requires the configured SQLite connection')
    }
    const dbPath = normalizeConfiguredSqliteFilename(
      (connectionConfig.connection as { filename: string }).filename,
      connectionConfig.client
    )
    const existing = await db.from('sqlite_master').where({ type: 'table' }).select('name').first()
    // An empty or in-memory database has nothing to roll back to.
    if (dbPath !== ':memory:' && existing) {
      if (!dbPath || /^file:/i.test(dbPath)) {
        throw new InvalidArgumentsException('db:upgrade requires a file-backed SQLite connection')
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
    // Lucid's migration runner, not `migration:run`: a nested command renders its own failure
    // with the stack, and only that command's `completed()` could stop it.
    const migrator = new MigrationRunner(db, this.app, { direction: 'up' })
    migrator.on('migration:completed', (file) => this.logger.log(`❯ migrated ${file.file.name}`))
    migrator.on('migration:error', (file) => this.logger.log(`❯ error ${file.file.name}`))
    await migrator.run()
    if (migrator.error) {
      this.error = migrator.error
      this.exitCode = 1
      return
    }
    if (migrator.status === 'skipped') this.logger.log('Already up to date')
    // Generated only after every migration succeeds.
    if (this.schemaGenerate && !this.app.inProduction) {
      const generate = await this.kernel.exec('schema:generate', [
        `--connection=${db.primaryConnectionName}`,
      ])
      if (generate.exitCode !== 0) {
        this.error = generate.error
        this.exitCode = generate.exitCode ?? 1
        this.#childReportedFailure = true
      }
    }
  }

  /** Reports a failure kept in `error` as one line, so Ace does not render it with the stack. */
  async completed() {
    if (!this.error) return false
    if (this.#childReportedFailure) return true
    const detail =
      this.error instanceof InvalidArgumentsException
        ? `Error: ${this.error.message}`
        : String(this.error)
    this.logger.error(`Upgrade failed: ${detail}`)
    return true
  }
}
