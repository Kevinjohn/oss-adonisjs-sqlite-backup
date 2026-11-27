import { Exception } from '@adonisjs/core/exceptions'
import type { BackupErrorCode } from './types.ts'

export type { BackupErrorCode }

/** A backup lock is held by another operation. Retry later. */
export class BackupLockedException extends Exception {
  static code = 'E_BACKUP_LOCKED' as const
  static status = 500
  declare code: typeof BackupLockedException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** A SQLite source does not meet the operation's requirements. */
export class BackupSourceException extends Exception {
  static code = 'E_BACKUP_SOURCE' as const
  static status = 500
  declare code: typeof BackupSourceException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** A bundle or copy failed verification. */
export class BackupInvalidException extends Exception {
  static code = 'E_BACKUP_INVALID' as const
  static status = 500
  declare code: typeof BackupInvalidException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** A durable file write made no progress. */
export class BackupWriteException extends Exception {
  static code = 'E_BACKUP_WRITE' as const
  static status = 500
  declare code: typeof BackupWriteException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** The request failed a path, layout or operation safety check. */
export class BackupUnsafeException extends Exception {
  static code = 'E_BACKUP_UNSAFE' as const
  static status = 500
  declare code: typeof BackupUnsafeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** No selected bundle or backup root was found. */
export class BackupNotFoundException extends Exception {
  static code = 'E_BACKUP_NOT_FOUND' as const
  static status = 500
  declare code: typeof BackupNotFoundException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, { cause: options?.cause })
  }
}

/** Configured backups are disabled. Supply an explicit directory for recovery. */
export class BackupDisabledException extends Exception {
  static code = 'E_BACKUP_DISABLED' as const
  static status = 500
  static message = 'backups are disabled'
  declare code: typeof BackupDisabledException.code

  constructor(options?: ErrorOptions) {
    super(undefined, { cause: options?.cause })
  }
}

export const E_BACKUP_LOCKED = BackupLockedException
export const E_BACKUP_SOURCE = BackupSourceException
export const E_BACKUP_INVALID = BackupInvalidException
export const E_BACKUP_WRITE = BackupWriteException
export const E_BACKUP_UNSAFE = BackupUnsafeException
export const E_BACKUP_NOT_FOUND = BackupNotFoundException
export const E_BACKUP_DISABLED = BackupDisabledException

export const BACKUP_ERROR_CODES = [
  E_BACKUP_LOCKED.code,
  E_BACKUP_SOURCE.code,
  E_BACKUP_INVALID.code,
  E_BACKUP_WRITE.code,
  E_BACKUP_UNSAFE.code,
  E_BACKUP_NOT_FOUND.code,
  E_BACKUP_DISABLED.code,
] as const satisfies readonly BackupErrorCode[]
