import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import type { BackupConfig, BackupConfigInput } from './types.js'
import { assertLockTimeout } from './lock.js'

/**
 * Validate `config/backup.ts` and apply defaults.
 *
 * @throws `InvalidArgumentsException` if a supplied configuration value is invalid.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * export default defineConfig({ directory: 'storage/backups', keep: 14, requireWal: true })
 * ```
 */
export function defineConfig(input: BackupConfigInput): BackupConfig {
  if (
    input.connection !== undefined &&
    (typeof input.connection !== 'string' || !input.connection.trim())
  ) {
    throw new InvalidArgumentsException('backup connection must be a non-empty string')
  }
  if (input.directory !== undefined && typeof input.directory !== 'string') {
    throw new InvalidArgumentsException('backup directory must be a string')
  }
  if (input.requireWal !== undefined && typeof input.requireWal !== 'boolean') {
    throw new InvalidArgumentsException('backup requireWal must be a boolean')
  }
  const keep = input.keep ?? 7
  if (!Number.isInteger(keep) || keep < 1) {
    throw new InvalidArgumentsException(`backup keep must be an integer >= 1 (got ${keep})`)
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
