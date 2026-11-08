import { Exception } from '@adonisjs/core/exceptions'

/** The complete error-code set. Each names what the caller should do next. */
export type BackupErrorCode =
  /** Another process holds the backup directory lock. Retry later. */
  | 'E_BACKUP_LOCKED'
  /** The source cannot be backed up (not SQLite, not a file, missing, or not WAL when required). */
  | 'E_BACKUP_SOURCE'
  /** A bundle or copy failed verification (missing READY, checksum, integrity or FK check). */
  | 'E_BACKUP_INVALID'
  /** The request would touch the live database or overwrite something. Nothing was written. */
  | 'E_BACKUP_UNSAFE'
  /** No bundle with that name, or no READY bundle at all. */
  | 'E_BACKUP_NOT_FOUND'
  /** Scheduled backups are disabled; supply an explicit directory for recovery. */
  | 'E_BACKUP_DISABLED'

export const BACKUP_ERROR_CODES: readonly BackupErrorCode[] = [
  'E_BACKUP_LOCKED',
  'E_BACKUP_SOURCE',
  'E_BACKUP_INVALID',
  'E_BACKUP_UNSAFE',
  'E_BACKUP_NOT_FOUND',
  'E_BACKUP_DISABLED',
]

/** The only error the package throws on purpose; `code` is one of {@link BackupErrorCode}. */
export class BackupException extends Exception {
  static status = 500
  declare code: BackupErrorCode

  constructor(code: BackupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, { code, status: BackupException.status, cause: options?.cause })
  }
}
