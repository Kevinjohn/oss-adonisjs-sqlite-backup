import { chmodSync, constants, copyFileSync, lstatSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertMatchesManifest, readManifest, selectBundle } from './bundles.js'
import { assertDirectory } from './directory.js'
import { BackupException } from './errors.js'
import { syncPath } from './fs.js'
import { internalHooks } from './internal_hooks.js'
import { DATABASE } from './names.js'
import { realPath } from './paths.js'
import { isWithin } from './source.js'

/** Exists in any form, including a dangling symlink (unlike existsSync). */
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/**
 * Stage a verified copy of a bundle at `target`. Never touches the live database and never swaps
 * it in: stopping the app and switching files is host policy. Lock-free, so it cannot starve
 * creates; a bundle pruned mid-copy fails the checksum and nothing is left behind.
 */
export function prepareRestore(input: {
  directory: string
  target: string
  livePath: string
  name?: string
}): { bundle: string; target: string } {
  const target = realPath(input.target)
  const livePath = realPath(input.livePath)
  const directory = realPath(input.directory)
  assertDirectory(directory, true)
  if ([livePath, `${livePath}-wal`, `${livePath}-shm`, `${livePath}-journal`].includes(target)) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      'restore target is the live database or one of its sidecars'
    )
  }
  // Checked as given too: a dangling symlink at the target is present even though its end is not.
  const names = [target, input.target].flatMap((t) => [t, `${t}-wal`, `${t}-shm`, `${t}-journal`])
  for (const path of names) {
    if (present(path)) {
      throw new BackupException('E_BACKUP_UNSAFE', `restore target ${path} already exists`)
    }
  }
  if (!statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()) {
    throw new BackupException(
      'E_BACKUP_UNSAFE',
      `restore target folder ${dirname(target)} is missing`
    )
  }
  if (isWithin(directory, target)) {
    throw new BackupException('E_BACKUP_UNSAFE', `restore target ${target} is in the backup folder`)
  }
  const bundle = selectBundle(directory, input.name)
  const manifest = readManifest(bundle)
  const source = join(bundle.path, DATABASE)
  internalHooks.step?.('restore:checked', target)
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    /* c8 ignore next 5 -- race: the target appeared between the existence check and the copy */
    if (code === 'EEXIST') {
      throw new BackupException('E_BACKUP_UNSAFE', `restore target ${target} already exists`, {
        cause,
      })
    }
    // The bundle is still there, so the target side failed (permissions, read-only, disk full).
    if (present(source)) throw cause
    throw new BackupException('E_BACKUP_NOT_FOUND', `bundle ${bundle.name} cannot be read`, {
      cause,
    })
  }
  // Where the copy landed, read at once: a folder on the way swapped for a symlink during the copy
  // moves it elsewhere, and may be swapped back before the checks below.
  const made = lstatSync(target, { throwIfNoEntry: false })
  const landed = realPath(target)
  internalHooks.step?.('restore:copied', target)
  const ours = (path: string) => {
    const now = lstatSync(path, { throwIfNoEntry: false })
    // Inode numbers are reused once a file is deleted, so a replacement file can share one;
    // its creation time still differs (on filesystems that record it).
    return (
      made !== undefined &&
      now?.ino === made.ino &&
      now.dev === made.dev &&
      now.birthtimeMs === made.birthtimeMs
    )
  }
  try {
    /* c8 ignore next -- `made` is missing only if swapped back within microseconds of the copy */
    if (!made || landed !== target || realPath(target) !== target) {
      throw new BackupException('E_BACKUP_UNSAFE', `restore target ${target} moved during the copy`)
    }
    chmodSync(target, 0o600)
    assertMatchesManifest(target, manifest, `staged copy of ${bundle.name}`)
    syncPath(target)
    syncPath(dirname(target))
  } catch (error) {
    // Remove only the file this restore created: where the path leads now and where it landed.
    try {
      for (const path of new Set([target, landed])) if (ours(path)) rmSync(path, { force: true })
    } catch (cleanupError) {
      // The verification failure is the finding; the failed removal rides along as in create.
      if (error instanceof Error)
        Object.defineProperty(error, 'cleanupError', { value: cleanupError })
    }
    throw error
  }
  return { bundle: bundle.name, target }
}
