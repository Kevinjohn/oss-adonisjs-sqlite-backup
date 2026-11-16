import { configure, defineConfig, SqliteBackup } from '@kevinjohn/adonisjs-sqlite-backup'
import type { BackupErrorCode } from '@kevinjohn/adonisjs-sqlite-backup'
import type * as BackupTypes from '@kevinjohn/adonisjs-sqlite-backup/types'
import { getCommand, getMetaData } from '@kevinjohn/adonisjs-sqlite-backup/commands'
import BackupProvider from '@kevinjohn/adonisjs-sqlite-backup/sqlite_backup_provider'

void [configure, defineConfig, SqliteBackup, getCommand, getMetaData, BackupProvider]
const errorCode: BackupErrorCode | undefined = undefined
void errorCode
type ExportedTypes = typeof BackupTypes
const exportedTypes: ExportedTypes | undefined = undefined
void exportedTypes
