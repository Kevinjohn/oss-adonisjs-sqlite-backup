import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { BackupException } from './errors.js'
import { realPath } from './paths.js'

/** Create or tighten a backup root to owner-only access. Call once at startup. */
export function prepareDirectory(path: string): void {
  const directory = realPath(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

/** Refuse a vanished root; never recreate a potentially unmounted volume during a run. */
export function assertDirectory(directory: string, privateRoot = false): void {
  const stat = statSync(directory, { throwIfNoEntry: false })
  if (!stat)
    throw new BackupException('E_BACKUP_NOT_FOUND', `backup directory ${directory} is missing`)
  if (!stat.isDirectory() || (privateRoot && (stat.mode & 0o022) !== 0)) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `backup directory ${directory} must be a private directory; run prepareDirectory() to set mode 0700`
    )
  }
}
