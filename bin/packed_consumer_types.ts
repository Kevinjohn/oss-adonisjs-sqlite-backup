import {
  configure,
  defineConfig,
  SqliteBackup,
  createBundle,
  acquireLock,
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
  code: BackupErrorCode
) {
  const rootDatabase: RootDatabase = database
  const rootCode: RootErrorCode = code
  const lock: DirectoryLock = acquireLock('/archive', 0)
  const rootLock: RootLock = lock
  const service: SqliteBackup = backup
  void createBundle({ livePath: '/live.db', directory: '/archive' })
  void createBundle({ source: { database: rootDatabase }, directory: '/archive' })
  void service.create({ database })
  // @ts-expect-error Owned and borrowed sources are mutually exclusive.
  void createBundle({ livePath: '/live.db', source: { database }, directory: '/archive' })
  return [defineConfig(config), rootCode, rootLock]
}
