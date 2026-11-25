import type { Database } from '@adonisjs/lucid/database'
import {
  configure,
  defineConfig,
  errors,
  SqliteBackup,
  BackupArchive,
  OperatorDatabase,
} from '@kevinjohn/adonisjs-sqlite-backup'
import type {
  BackupErrorCode as RootErrorCode,
  DirectoryLock as RootLock,
  NativeDatabase as RootDatabase,
} from '@kevinjohn/adonisjs-sqlite-backup'
import type {
  BackupErrorCode,
  DirectoryLock,
  NativeDatabase,
  BackupConfigInput,
} from '@kevinjohn/adonisjs-sqlite-backup/types'
import { getCommand, getMetaData } from '@kevinjohn/adonisjs-sqlite-backup/commands'
import BackupProvider from '@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider'
import backup from '@kevinjohn/adonisjs-sqlite-backup/services/main'

void [configure, defineConfig, SqliteBackup, getCommand, getMetaData, BackupProvider]
export function publicTypes(
  config: BackupConfigInput,
  database: NativeDatabase,
  code: BackupErrorCode,
  lucid: Database
) {
  const rootDatabase: RootDatabase = database
  const rootCode: RootErrorCode = code
  const archive = new BackupArchive('/archive')
  const lock: DirectoryLock = archive.acquireLock(0)
  const operator = new OperatorDatabase(lucid)
  const path: string = operator.databasePath(true)
  const operation: Promise<number> = operator.run(async (handle) => {
    const borrowed: NativeDatabase = handle
    const bundle = await archive.create({ source: { database: borrowed } })
    return bundle.manifest.bytes
  })
  const rootLock: RootLock = lock
  const service: SqliteBackup = backup
  try {
    service.verify('bak-utc-20000101-000000-000')
  } catch (error) {
    if (!(error instanceof errors.E_BACKUP_NOT_FOUND)) throw error
    const missingCode: 'E_BACKUP_NOT_FOUND' = error.code
    void missingCode
  }
  void archive.create({ livePath: path })
  void archive.create({ source: { database: rootDatabase } })
  void service.create({ database })
  // @ts-expect-error Owned and borrowed sources are mutually exclusive.
  void archive.create({ livePath: path, source: { database } })
  return [defineConfig(config), rootCode, rootLock, operation]
}
