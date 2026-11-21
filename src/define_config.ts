import { BackupException } from './errors.js'
import type { BackupConfig, BackupConfigInput } from './types.js'
import { assertLockTimeout } from './lock.js'

/** Validate `config/backup.ts` and apply defaults. */
export function defineConfig(input: BackupConfigInput): BackupConfig {
  if (
    input.connection !== undefined &&
    (typeof input.connection !== 'string' || !input.connection.trim())
  ) {
    throw new BackupException('E_BACKUP_SOURCE', 'backup connection must be a non-empty string')
  }
  if (input.directory !== undefined && typeof input.directory !== 'string') {
    throw new BackupException('E_BACKUP_UNSAFE', 'backup directory must be a string')
  }
  if (input.requireWal !== undefined && typeof input.requireWal !== 'boolean') {
    throw new BackupException('E_BACKUP_SOURCE', 'backup requireWal must be a boolean')
  }
  const keep = input.keep ?? 7
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `backup keep must be an integer >= 1 (got ${keep})`
    )
  }
  const lockTimeoutMs = input.lockTimeoutMs ?? 0
  assertLockTimeout(lockTimeoutMs)
  return {
    connection: input.connection,
    directory: input.directory ?? '',
    keep,
    lockTimeoutMs,
    requireWal: input.requireWal ?? false,
  }
}
