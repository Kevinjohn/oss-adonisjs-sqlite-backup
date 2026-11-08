import { BackupException } from './errors.js'
import type { BackupConfig, BackupConfigInput } from './types.js'

/** Validate `config/backup.ts` and apply defaults. */
export function defineConfig(input: BackupConfigInput): BackupConfig {
  const keep = input.keep ?? 7
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `backup keep must be an integer >= 1 (got ${keep})`
    )
  }
  const lockTimeoutMs = input.lockTimeoutMs ?? 0
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new BackupException('E_BACKUP_UNSAFE', 'backup lockTimeoutMs must be an integer >= 0')
  }
  return {
    connection: input.connection,
    directory: input.directory ?? '',
    keep,
    lockTimeoutMs,
    requireWal: input.requireWal ?? false,
  }
}
