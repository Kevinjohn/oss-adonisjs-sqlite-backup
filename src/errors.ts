import { Exception } from '@adonisjs/core/exceptions'

function causeOnly(options?: ErrorOptions): ErrorOptions {
  return { cause: options?.cause }
}

/** A backup lock is held by another operation. Retry later. */
export class BackupLockedException extends Exception {
  static code = 'E_BACKUP_LOCKED' as const
  static status = 500
  declare code: typeof BackupLockedException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

/** The owned SQLite source could not be opened and read. */
export class BackupSourceException extends Exception {
  static code = 'E_BACKUP_SOURCE' as const
  static status = 500
  declare code: typeof BackupSourceException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

/** SQLite integrity_check found damage in a bundle or copy. */
export class BackupInvalidException extends Exception {
  static code = 'E_BACKUP_INVALID' as const
  static status = 500
  declare code: typeof BackupInvalidException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

/** The archive contains the live SQLite source. */
export class BackupUnsafeException extends Exception {
  static code = 'E_BACKUP_UNSAFE' as const
  static status = 500
  declare code: typeof BackupUnsafeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

/** A bundle with the requested name was not found. */
export class BackupNotFoundException extends Exception {
  static code = 'E_BACKUP_NOT_FOUND' as const
  static status = 500
  declare code: typeof BackupNotFoundException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

/** Configured backups are disabled. Supply an explicit directory for recovery. */
export class BackupDisabledException extends Exception {
  static code = 'E_BACKUP_DISABLED' as const
  static status = 500
  static message = 'backups are disabled'
  declare code: typeof BackupDisabledException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export class BackupCleanupException extends Exception {
  static code = 'E_BACKUP_CLEANUP' as const
  static status = 500
  static message = 'native resource cleanup failed'
  declare code: typeof BackupCleanupException.code

  constructor(
    readonly resourceCleanupErrors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_CLEANUP = BackupCleanupException

export class BackupLockReleaseException extends Exception {
  static code = 'E_BACKUP_LOCK_RELEASE' as const
  static status = 500
  static message = 'lock release failed'
  declare code: typeof BackupLockReleaseException.code

  constructor(
    readonly resourceCleanupErrors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_LOCK_RELEASE = BackupLockReleaseException

export class OperatorCleanupException extends Exception {
  static code = 'E_BACKUP_OPERATOR_CLEANUP' as const
  static status = 500
  static message = 'Operator database cleanup failed'
  declare code: typeof OperatorCleanupException.code

  constructor(
    readonly resourceCleanupErrors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_CLEANUP = OperatorCleanupException

export const E_BACKUP_LOCKED = BackupLockedException
export const E_BACKUP_SOURCE = BackupSourceException
export const E_BACKUP_INVALID = BackupInvalidException
export const E_BACKUP_UNSAFE = BackupUnsafeException
export const E_BACKUP_NOT_FOUND = BackupNotFoundException
export const E_BACKUP_DISABLED = BackupDisabledException

export class BackupBorrowedNotFileBackedException extends Exception {
  static code = 'E_BACKUP_BORROWED_NOT_FILE_BACKED' as const
  static status = 500
  static message = 'borrowed database cannot be read: source must be a file-backed SQLite database'
  declare code: typeof BackupBorrowedNotFileBackedException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_BORROWED_NOT_FILE_BACKED = BackupBorrowedNotFileBackedException

export class BackupBorrowedUnreadableException extends Exception {
  static code = 'E_BACKUP_BORROWED_UNREADABLE' as const
  static status = 500
  static message = 'borrowed database cannot be read'
  declare code: typeof BackupBorrowedUnreadableException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_BORROWED_UNREADABLE = BackupBorrowedUnreadableException

export class BackupBundleExistsException extends Exception {
  static code = 'E_BACKUP_BUNDLE_EXISTS' as const
  static status = 500
  declare code: typeof BackupBundleExistsException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_BUNDLE_EXISTS = BackupBundleExistsException

export class BackupBundleFileTypeException extends Exception {
  static code = 'E_BACKUP_BUNDLE_FILE_TYPE' as const
  static status = 500
  declare code: typeof BackupBundleFileTypeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_BUNDLE_FILE_TYPE = BackupBundleFileTypeException

export class BackupBundleNameException extends Exception {
  static code = 'E_BACKUP_BUNDLE_NAME' as const
  static status = 500
  declare code: typeof BackupBundleNameException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_BUNDLE_NAME = BackupBundleNameException

export class BackupBundlePrunedException extends Exception {
  static code = 'E_BACKUP_BUNDLE_PRUNED' as const
  static status = 500
  declare code: typeof BackupBundlePrunedException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_BUNDLE_PRUNED = BackupBundlePrunedException

export class BackupChecksumMismatchException extends Exception {
  static code = 'E_BACKUP_CHECKSUM_MISMATCH' as const
  static status = 500
  declare code: typeof BackupChecksumMismatchException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_CHECKSUM_MISMATCH = BackupChecksumMismatchException

export class BackupClockSkewException extends Exception {
  static code = 'E_BACKUP_CLOCK_SKEW' as const
  static status = 500
  declare code: typeof BackupClockSkewException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_CLOCK_SKEW = BackupClockSkewException

export class BackupDatabaseFileTypeException extends Exception {
  static code = 'E_BACKUP_DATABASE_FILE_TYPE' as const
  static status = 500
  declare code: typeof BackupDatabaseFileTypeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_DATABASE_FILE_TYPE = BackupDatabaseFileTypeException

export class BackupDatabaseMissingException extends Exception {
  static code = 'E_BACKUP_DATABASE_MISSING' as const
  static status = 500
  declare code: typeof BackupDatabaseMissingException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_DATABASE_MISSING = BackupDatabaseMissingException

export class BackupDatabaseUnreadableException extends Exception {
  static code = 'E_BACKUP_DATABASE_UNREADABLE' as const
  static status = 500
  declare code: typeof BackupDatabaseUnreadableException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_DATABASE_UNREADABLE = BackupDatabaseUnreadableException

export class BackupFlagActionException extends Exception {
  static code = 'E_BACKUP_FLAG_ACTION' as const
  static status = 500
  declare code: typeof BackupFlagActionException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_FLAG_ACTION = BackupFlagActionException

export class BackupInvalidKeepException extends Exception {
  static code = 'E_BACKUP_INVALID_KEEP' as const
  static status = 500
  declare code: typeof BackupInvalidKeepException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_INVALID_KEEP = BackupInvalidKeepException

export class BackupJournalMetadataException extends Exception {
  static code = 'E_BACKUP_JOURNAL_METADATA' as const
  static status = 500
  static message = 'new backup has unsupported migration metadata'
  declare code: typeof BackupJournalMetadataException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_JOURNAL_METADATA = BackupJournalMetadataException

export class BackupJournalMismatchException extends Exception {
  static code = 'E_BACKUP_JOURNAL_MISMATCH' as const
  static status = 500
  declare code: typeof BackupJournalMismatchException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_JOURNAL_MISMATCH = BackupJournalMismatchException

export class BackupJournalUnreadableException extends Exception {
  static code = 'E_BACKUP_JOURNAL_UNREADABLE' as const
  static status = 500
  declare code: typeof BackupJournalUnreadableException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_JOURNAL_UNREADABLE = BackupJournalUnreadableException

export class BackupLockFileLinksException extends Exception {
  static code = 'E_BACKUP_LOCK_FILE_LINKS' as const
  static status = 500
  declare code: typeof BackupLockFileLinksException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_LOCK_FILE_LINKS = BackupLockFileLinksException

export class BackupLockFileOpenException extends Exception {
  static code = 'E_BACKUP_LOCK_FILE_OPEN' as const
  static status = 500
  declare code: typeof BackupLockFileOpenException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_LOCK_FILE_OPEN = BackupLockFileOpenException

export class BackupLockFileTypeException extends Exception {
  static code = 'E_BACKUP_LOCK_FILE_TYPE' as const
  static status = 500
  declare code: typeof BackupLockFileTypeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_LOCK_FILE_TYPE = BackupLockFileTypeException

export class BackupManifestFileTypeException extends Exception {
  static code = 'E_BACKUP_MANIFEST_FILE_TYPE' as const
  static status = 500
  declare code: typeof BackupManifestFileTypeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_MANIFEST_FILE_TYPE = BackupManifestFileTypeException

export class BackupManifestShapeException extends Exception {
  static code = 'E_BACKUP_MANIFEST_SHAPE' as const
  static status = 500
  declare code: typeof BackupManifestShapeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_MANIFEST_SHAPE = BackupManifestShapeException

export class BackupManifestUnreadableException extends Exception {
  static code = 'E_BACKUP_MANIFEST_UNREADABLE' as const
  static status = 500
  declare code: typeof BackupManifestUnreadableException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_MANIFEST_UNREADABLE = BackupManifestUnreadableException

export class BackupNoReadyBundleException extends Exception {
  static code = 'E_BACKUP_NO_READY_BUNDLE' as const
  static status = 500
  declare code: typeof BackupNoReadyBundleException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_NO_READY_BUNDLE = BackupNoReadyBundleException

export class BackupOperatorLockedException extends Exception {
  static code = 'E_BACKUP_OPERATOR_LOCKED' as const
  static status = 500
  static message = 'Another process holds this database; stop the server and retry'
  declare code: typeof BackupOperatorLockedException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_LOCKED = BackupOperatorLockedException

export class BackupOperatorSourceException extends Exception {
  static code = 'E_BACKUP_OPERATOR_SOURCE' as const
  static status = 500
  static message = 'Operator commands require an existing on-disk database'
  declare code: typeof BackupOperatorSourceException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_SOURCE = BackupOperatorSourceException

export class BackupPathMissingDotException extends Exception {
  static code = 'E_BACKUP_PATH_MISSING_DOT' as const
  static status = 500
  declare code: typeof BackupPathMissingDotException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_PATH_MISSING_DOT = BackupPathMissingDotException

export class BackupPathMissingDotDotException extends Exception {
  static code = 'E_BACKUP_PATH_MISSING_DOT_DOT' as const
  static status = 500
  declare code: typeof BackupPathMissingDotDotException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_PATH_MISSING_DOT_DOT = BackupPathMissingDotDotException

export class BackupPathNotDirectoryException extends Exception {
  static code = 'E_BACKUP_PATH_NOT_DIRECTORY' as const
  static status = 500
  declare code: typeof BackupPathNotDirectoryException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_PATH_NOT_DIRECTORY = BackupPathNotDirectoryException

export class BackupPathSymlinkLimitException extends Exception {
  static code = 'E_BACKUP_PATH_SYMLINK_LIMIT' as const
  static status = 500
  declare code: typeof BackupPathSymlinkLimitException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_PATH_SYMLINK_LIMIT = BackupPathSymlinkLimitException

export class BackupReadyMissingException extends Exception {
  static code = 'E_BACKUP_READY_MISSING' as const
  static status = 500
  declare code: typeof BackupReadyMissingException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_READY_MISSING = BackupReadyMissingException

export class BackupRootNotFoundException extends Exception {
  static code = 'E_BACKUP_ROOT_NOT_FOUND' as const
  static status = 500
  declare code: typeof BackupRootNotFoundException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_ROOT_NOT_FOUND = BackupRootNotFoundException

export class BackupRootUnsafeException extends Exception {
  static code = 'E_BACKUP_ROOT_UNSAFE' as const
  static status = 500
  declare code: typeof BackupRootUnsafeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_ROOT_UNSAFE = BackupRootUnsafeException

export class BackupSourceClientException extends Exception {
  static code = 'E_BACKUP_SOURCE_CLIENT' as const
  static status = 500
  declare code: typeof BackupSourceClientException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_CLIENT = BackupSourceClientException

export class BackupSourceConnectionException extends Exception {
  static code = 'E_BACKUP_SOURCE_CONNECTION' as const
  static status = 500
  declare code: typeof BackupSourceConnectionException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_CONNECTION = BackupSourceConnectionException

export class BackupSourceDriverPathException extends Exception {
  static code = 'E_BACKUP_SOURCE_DRIVER_PATH' as const
  static status = 500
  declare code: typeof BackupSourceDriverPathException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_DRIVER_PATH = BackupSourceDriverPathException

export class BackupSourceMissingException extends Exception {
  static code = 'E_BACKUP_SOURCE_MISSING' as const
  static status = 500
  declare code: typeof BackupSourceMissingException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_MISSING = BackupSourceMissingException

export class BackupSourceNotFileBackedException extends Exception {
  static code = 'E_BACKUP_SOURCE_NOT_FILE_BACKED' as const
  static status = 500
  declare code: typeof BackupSourceNotFileBackedException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_NOT_FILE_BACKED = BackupSourceNotFileBackedException

export class BackupSourceNotWalException extends Exception {
  static code = 'E_BACKUP_SOURCE_NOT_WAL' as const
  static status = 500
  declare code: typeof BackupSourceNotWalException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_NOT_WAL = BackupSourceNotWalException

export class BackupSourceTransactionException extends Exception {
  static code = 'E_BACKUP_SOURCE_TRANSACTION' as const
  static status = 500
  static message =
    'the borrowed database handle has an open transaction; commit or roll it back first'
  declare code: typeof BackupSourceTransactionException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_TRANSACTION = BackupSourceTransactionException

export class BackupSourceUriException extends Exception {
  static code = 'E_BACKUP_SOURCE_URI' as const
  static status = 500
  declare code: typeof BackupSourceUriException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_SOURCE_URI = BackupSourceUriException

export class BackupTargetDriverPathException extends Exception {
  static code = 'E_BACKUP_TARGET_DRIVER_PATH' as const
  static status = 500
  static message = 'restore target changes when opened by the SQLite verification driver'
  declare code: typeof BackupTargetDriverPathException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_DRIVER_PATH = BackupTargetDriverPathException

export class BackupTargetExistsException extends Exception {
  static code = 'E_BACKUP_TARGET_EXISTS' as const
  static status = 500
  declare code: typeof BackupTargetExistsException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_EXISTS = BackupTargetExistsException

export class BackupTargetFolderException extends Exception {
  static code = 'E_BACKUP_TARGET_FOLDER' as const
  static status = 500
  declare code: typeof BackupTargetFolderException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_FOLDER = BackupTargetFolderException

export class BackupTargetInArchiveException extends Exception {
  static code = 'E_BACKUP_TARGET_IN_ARCHIVE' as const
  static status = 500
  declare code: typeof BackupTargetInArchiveException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_IN_ARCHIVE = BackupTargetInArchiveException

export class BackupTargetLiveException extends Exception {
  static code = 'E_BACKUP_TARGET_LIVE' as const
  static status = 500
  static message = 'restore target is the live database or one of its sidecars'
  declare code: typeof BackupTargetLiveException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_LIVE = BackupTargetLiveException

export class BackupTargetMovedException extends Exception {
  static code = 'E_BACKUP_TARGET_MOVED' as const
  static status = 500
  declare code: typeof BackupTargetMovedException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_MOVED = BackupTargetMovedException

export class BackupTargetParentMissingException extends Exception {
  static code = 'E_BACKUP_TARGET_PARENT_MISSING' as const
  static status = 500
  declare code: typeof BackupTargetParentMissingException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_PARENT_MISSING = BackupTargetParentMissingException

export class BackupTargetRequiredException extends Exception {
  static code = 'E_BACKUP_TARGET_REQUIRED' as const
  static status = 500
  static message = 'restore-prepare needs --target'
  declare code: typeof BackupTargetRequiredException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_TARGET_REQUIRED = BackupTargetRequiredException

export class BackupTimestampRangeException extends Exception {
  static code = 'E_BACKUP_TIMESTAMP_RANGE' as const
  static status = 500
  declare code: typeof BackupTimestampRangeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_TIMESTAMP_RANGE = BackupTimestampRangeException

export class BackupUnknownActionException extends Exception {
  static code = 'E_BACKUP_UNKNOWN_ACTION' as const
  static status = 500
  declare code: typeof BackupUnknownActionException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_UNKNOWN_ACTION = BackupUnknownActionException

export class BackupWriteIncompleteException extends Exception {
  static code = 'E_BACKUP_WRITE_INCOMPLETE' as const
  static status = 500
  declare code: typeof BackupWriteIncompleteException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_WRITE_INCOMPLETE = BackupWriteIncompleteException

export class BackupRootFileTypeException extends Exception {
  static code = 'E_BACKUP_ROOT_FILE_TYPE' as const
  static status = 500
  declare code: typeof BackupRootFileTypeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_ROOT_FILE_TYPE = BackupRootFileTypeException

export class BackupForeignKeysException extends Exception {
  static code = 'E_BACKUP_FOREIGN_KEYS' as const
  static status = 500
  declare code: typeof BackupForeignKeysException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_FOREIGN_KEYS = BackupForeignKeysException

export class BackupValidationOpenException extends Exception {
  static code = 'E_BACKUP_VALIDATION_OPEN' as const
  static status = 500
  declare code: typeof BackupValidationOpenException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_VALIDATION_OPEN = BackupValidationOpenException

export class BackupValidationQueryException extends Exception {
  static code = 'E_BACKUP_VALIDATION_QUERY' as const
  static status = 500
  declare code: typeof BackupValidationQueryException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_VALIDATION_QUERY = BackupValidationQueryException

export class BackupOperatorHandleUnavailableException extends Exception {
  static code = 'E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE' as const
  static status = 500
  static message = 'Operator database handle is no longer available'
  declare code: typeof BackupOperatorHandleUnavailableException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE = BackupOperatorHandleUnavailableException

export class BackupOperatorReleaseRefusedException extends Exception {
  static code = 'E_BACKUP_OPERATOR_RELEASE_REFUSED' as const
  static status = 500
  static message = 'Operator database owner refused the handle release'
  declare code: typeof BackupOperatorReleaseRefusedException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_RELEASE_REFUSED = BackupOperatorReleaseRefusedException

export class BackupOperatorPoolIncompleteException extends Exception {
  static code = 'E_BACKUP_OPERATOR_POOL_INCOMPLETE' as const
  static status = 500
  declare code: typeof BackupOperatorPoolIncompleteException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_POOL_INCOMPLETE = BackupOperatorPoolIncompleteException

export class BackupOperatorHandleOpenException extends Exception {
  static code = 'E_BACKUP_OPERATOR_HANDLE_OPEN' as const
  static status = 500
  static message = 'Operator database handle remained open after pool cleanup'
  declare code: typeof BackupOperatorHandleOpenException.code

  constructor(options?: ErrorOptions) {
    super(undefined, causeOnly(options))
  }
}

export const E_BACKUP_OPERATOR_HANDLE_OPEN = BackupOperatorHandleOpenException

export class BackupPruneFinalizeException extends Exception {
  static code = 'E_BACKUP_PRUNE_FINALIZE' as const
  static status = 500
  declare code: typeof BackupPruneFinalizeException.code

  constructor(message: string, options?: ErrorOptions) {
    super(message, causeOnly(options))
  }
}

export const E_BACKUP_PRUNE_FINALIZE = BackupPruneFinalizeException

/** The stable code for each expected backup failure. */
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number]

export const BACKUP_ERROR_CODES = [
  E_BACKUP_LOCKED.code,
  E_BACKUP_SOURCE.code,
  E_BACKUP_INVALID.code,
  E_BACKUP_UNSAFE.code,
  E_BACKUP_NOT_FOUND.code,
  E_BACKUP_DISABLED.code,
  E_BACKUP_BORROWED_NOT_FILE_BACKED.code,
  E_BACKUP_BORROWED_UNREADABLE.code,
  E_BACKUP_BUNDLE_EXISTS.code,
  E_BACKUP_BUNDLE_FILE_TYPE.code,
  E_BACKUP_BUNDLE_NAME.code,
  E_BACKUP_BUNDLE_PRUNED.code,
  E_BACKUP_CHECKSUM_MISMATCH.code,
  E_BACKUP_CLEANUP.code,
  E_BACKUP_CLOCK_SKEW.code,
  E_BACKUP_DATABASE_FILE_TYPE.code,
  E_BACKUP_DATABASE_MISSING.code,
  E_BACKUP_DATABASE_UNREADABLE.code,
  E_BACKUP_FLAG_ACTION.code,
  E_BACKUP_FOREIGN_KEYS.code,
  E_BACKUP_INVALID_KEEP.code,
  E_BACKUP_JOURNAL_METADATA.code,
  E_BACKUP_JOURNAL_MISMATCH.code,
  E_BACKUP_JOURNAL_UNREADABLE.code,
  E_BACKUP_LOCK_FILE_LINKS.code,
  E_BACKUP_LOCK_FILE_OPEN.code,
  E_BACKUP_LOCK_FILE_TYPE.code,
  E_BACKUP_LOCK_RELEASE.code,
  E_BACKUP_MANIFEST_FILE_TYPE.code,
  E_BACKUP_MANIFEST_SHAPE.code,
  E_BACKUP_MANIFEST_UNREADABLE.code,
  E_BACKUP_NO_READY_BUNDLE.code,
  E_BACKUP_OPERATOR_CLEANUP.code,
  E_BACKUP_OPERATOR_HANDLE_OPEN.code,
  E_BACKUP_OPERATOR_HANDLE_UNAVAILABLE.code,
  E_BACKUP_OPERATOR_LOCKED.code,
  E_BACKUP_OPERATOR_POOL_INCOMPLETE.code,
  E_BACKUP_OPERATOR_RELEASE_REFUSED.code,
  E_BACKUP_OPERATOR_SOURCE.code,
  E_BACKUP_PATH_MISSING_DOT.code,
  E_BACKUP_PATH_MISSING_DOT_DOT.code,
  E_BACKUP_PATH_NOT_DIRECTORY.code,
  E_BACKUP_PATH_SYMLINK_LIMIT.code,
  E_BACKUP_PRUNE_FINALIZE.code,
  E_BACKUP_READY_MISSING.code,
  E_BACKUP_ROOT_FILE_TYPE.code,
  E_BACKUP_ROOT_NOT_FOUND.code,
  E_BACKUP_ROOT_UNSAFE.code,
  E_BACKUP_SOURCE_CLIENT.code,
  E_BACKUP_SOURCE_CONNECTION.code,
  E_BACKUP_SOURCE_DRIVER_PATH.code,
  E_BACKUP_SOURCE_MISSING.code,
  E_BACKUP_SOURCE_NOT_FILE_BACKED.code,
  E_BACKUP_SOURCE_NOT_WAL.code,
  E_BACKUP_SOURCE_TRANSACTION.code,
  E_BACKUP_SOURCE_URI.code,
  E_BACKUP_TARGET_DRIVER_PATH.code,
  E_BACKUP_TARGET_EXISTS.code,
  E_BACKUP_TARGET_FOLDER.code,
  E_BACKUP_TARGET_IN_ARCHIVE.code,
  E_BACKUP_TARGET_LIVE.code,
  E_BACKUP_TARGET_MOVED.code,
  E_BACKUP_TARGET_PARENT_MISSING.code,
  E_BACKUP_TARGET_REQUIRED.code,
  E_BACKUP_TIMESTAMP_RANGE.code,
  E_BACKUP_UNKNOWN_ACTION.code,
  E_BACKUP_VALIDATION_OPEN.code,
  E_BACKUP_VALIDATION_QUERY.code,
  E_BACKUP_WRITE_INCOMPLETE.code,
] as const
