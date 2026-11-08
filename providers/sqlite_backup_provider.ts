import type { ApplicationService } from '@adonisjs/core/types'
import { BackupException } from '../src/errors.js'
import { SqliteBackup } from '../src/sqlite_backup.js'
import type { BackupConfig, LucidDatabaseConfig } from '../src/types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'sqlite.backup': SqliteBackup
  }
}

/** Binds `sqlite.backup`, built from `config/backup.ts` and Lucid's `config/database.ts`. */
export default class SqliteBackupProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('sqlite.backup', () => {
      const config = this.app.config.get<BackupConfig | undefined>('backup', undefined)
      if (!config) {
        throw new BackupException(
          'E_BACKUP_SOURCE',
          'config/backup.ts is missing: run "node ace configure @kevinjohn/adonisjs-sqlite-backup"'
        )
      }
      return new SqliteBackup(config, this.app.config.get<LucidDatabaseConfig>('database'))
    })
  }
}
