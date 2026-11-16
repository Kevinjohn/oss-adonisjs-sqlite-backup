import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { BackupException } from './errors.js'
import { syncPath } from './fs.js'
import { realPath } from './paths.js'

/** Create or tighten a backup root to owner-only access. Call once at startup. */
export function prepareDirectory(path: string): void {
  const directory = realPath(path)
  const missing: string[] = []
  for (
    let current = directory;
    !statSync(current, { throwIfNoEntry: false });
    current = dirname(current)
  ) {
    missing.push(current)
  }
  for (const current of missing.reverse()) {
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) throw error
    }
    syncPath(dirname(current))
  }
  assertDirectory(directory)
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
