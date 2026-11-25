import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { E_BACKUP_NOT_FOUND, E_BACKUP_UNSAFE } from './errors.ts'
import { syncPath } from './fs.ts'
import { resolveFilesystemPath } from './paths.ts'

/**
 * Create or tighten a backup root to owner-only access. Call once at startup.
 *
 * @example
 * ```ts
 * import { prepareDirectory } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * prepareDirectory('storage/backups')
 * ```
 */
export function prepareDirectory(path: string): void {
  const directory = resolveFilesystemPath(path)
  const missingDirectories: string[] = []
  for (
    let current = directory;
    !statSync(current, { throwIfNoEntry: false });
    current = dirname(current)
  ) {
    missingDirectories.push(current)
  }
  for (const current of missingDirectories.reverse()) {
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

interface AssertDirectoryOptions {
  requirePrivateRoot?: boolean
}

/** Refuse a vanished root; never recreate a potentially unmounted volume during a run. */
export function assertDirectory(
  directory: string,
  { requirePrivateRoot = false }: AssertDirectoryOptions = {}
): void {
  const stat = statSync(directory, { throwIfNoEntry: false })
  if (!stat) throw new E_BACKUP_NOT_FOUND(`backup directory ${directory} is missing`)
  if (!stat.isDirectory() || (requirePrivateRoot && (stat.mode & 0o022) !== 0)) {
    throw new E_BACKUP_UNSAFE(
      `backup directory ${directory} must be a private directory; run prepareDirectory() to set mode 0700`
    )
  }
}
