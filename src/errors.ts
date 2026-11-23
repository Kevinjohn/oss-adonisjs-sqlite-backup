import { Exception } from '@adonisjs/core/exceptions'

/** The complete error-code set. Each names what the caller should do next. */
export type BackupErrorCode =
  /** The backup directory lock is held, by another process or this event loop. Retry later. */
  | 'E_BACKUP_LOCKED'
  /**
   * The source cannot be backed up (not SQLite, not a file, missing, or not WAL when required),
   * `config/backup.ts` is missing, or its `connection` or `requireWal` setting is invalid.
   */
  | 'E_BACKUP_SOURCE'
  /** A bundle or copy failed verification (missing READY, checksum, integrity or FK check). */
  | 'E_BACKUP_INVALID'
  /**
   * The request would touch the live database, overwrite something, or use an unsafe path, or a
   * `directory`, `keep` or `lockTimeoutMs` setting is invalid.
   */
  | 'E_BACKUP_UNSAFE'
  /** No bundle with that name, no READY bundle at all, or the backup root is missing. */
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

/**
 * The error for expected backup failures; `code` is one of {@link BackupErrorCode}. The
 * stopped-server operator helpers throw plain `Error`s instead (see `withOperatorDatabase`).
 */
export class BackupException extends Exception {
  static status = 500
  declare code: BackupErrorCode

  constructor(code: BackupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, { code, status: BackupException.status, cause: options?.cause })
  }
}
