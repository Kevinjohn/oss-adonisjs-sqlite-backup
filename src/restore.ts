import { chmodSync, constants, copyFileSync, lstatSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertMatchesManifest, readManifest, requireSelectedBundle } from './bundles.js'
import { assertDirectory } from './directory.js'
import { E_BACKUP_INVALID, E_BACKUP_NOT_FOUND, E_BACKUP_UNSAFE } from './errors.js'
import { syncPath } from './fs.js'
import { internalHooks } from './internal_hooks.js'
import { DATABASE, READY } from './names.js'
import { resolveFilesystemPath } from './paths.js'
import { isWithin, normalizeConfiguredSqliteFilename } from './source.js'

/** Exists in any form, including a dangling symlink (unlike existsSync). */
const existsIncludingDanglingSymlink = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined

/**
 * Stage a verified copy of a bundle at `target`. Never touches the live database and never swaps
 * it in: stopping the app and switching files is host policy. Lock-free, so it cannot starve
 * creates; a bundle pruned mid-copy fails the checksum and nothing is left behind.
 *
 * @example
 * ```ts
 * import { prepareRestore } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const staged = prepareRestore({
 *   directory: 'storage/backups',
 *   livePath: 'storage/orchard.sqlite',
 *   target: 'storage/recovered.sqlite',
 * })
 * ```
 */
export function prepareRestore(input: {
  directory: string
  target: string
  livePath: string
  name?: string
}): { bundle: string; target: string } {
  // resolveFilesystemPath drops a trailing slash after a missing segment, and the as-given check below would
  // follow a dangling symlink through it.
  if (input.target.endsWith('/')) {
    throw new E_BACKUP_UNSAFE(
      `restore target ${input.target} names a folder; give the file to create`
    )
  }
  const target = resolveFilesystemPath(input.target)
  if (normalizeConfiguredSqliteFilename(target, 'better-sqlite3') !== target) {
    throw new E_BACKUP_UNSAFE(
      'restore target changes when opened by the SQLite verification driver'
    )
  }
  const livePath = resolveFilesystemPath(input.livePath)
  const directory = resolveFilesystemPath(input.directory)
  assertDirectory(directory, { requirePrivateRoot: true })
  if ([livePath, `${livePath}-wal`, `${livePath}-shm`, `${livePath}-journal`].includes(target)) {
    throw new E_BACKUP_UNSAFE('restore target is the live database or one of its sidecars')
  }
  // Checked as given too: a dangling symlink at the target is present even though its end is not.
  const names = [target, input.target].flatMap((t) => [t, `${t}-wal`, `${t}-shm`, `${t}-journal`])
  for (const path of names) {
    if (existsIncludingDanglingSymlink(path)) {
      throw new E_BACKUP_UNSAFE(`restore target ${path} already exists`)
    }
  }
  if (!statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()) {
    throw new E_BACKUP_UNSAFE(`restore target folder ${dirname(target)} is missing`)
  }
  if (isWithin(directory, target)) {
    throw new E_BACKUP_UNSAFE(`restore target ${target} is in the backup folder`)
  }
  const bundle = requireSelectedBundle(directory, input.name)
  const manifest = readManifest(bundle)
  const source = join(bundle.path, DATABASE)
  internalHooks.step?.('restore:checked', target)
  try {
    const sourceStat = lstatSync(source, { throwIfNoEntry: false })
    if (sourceStat && !sourceStat.isFile()) {
      throw new E_BACKUP_INVALID(`bundle ${bundle.name} database is not a regular file`)
    }
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    /* c8 ignore next 5 -- race: the target appeared between the existence check and the copy */
    if (code === 'EEXIST') {
      throw new E_BACKUP_UNSAFE(`restore target ${target} already exists`, {
        cause,
      })
    }
    // Only a vanished publication is missing. A READY bundle with a missing database is damaged.
    if (code === 'ENOENT' && !existsIncludingDanglingSymlink(join(bundle.path, READY))) {
      throw new E_BACKUP_NOT_FOUND(`bundle ${bundle.name} was pruned`, { cause })
    }
    if (code === 'ENOENT' && !existsIncludingDanglingSymlink(source)) {
      throw new E_BACKUP_INVALID(`bundle ${bundle.name} database is missing`, {
        cause,
      })
    }
    throw cause
  }
  // Where the copy landed, read at once: a folder on the way swapped for a symlink during the copy
  // moves it elsewhere, and may be swapped back before the checks below.
  const createdFileStat = lstatSync(target, { throwIfNoEntry: false })
  const resolvedTargetPath = resolveFilesystemPath(target)
  internalHooks.step?.('restore:copied', target)
  const matchesCreatedRestoreFile = (path: string) => {
    const currentFileStat = lstatSync(path, { throwIfNoEntry: false })
    // Inode numbers are reused once a file is deleted, so a replacement file can share one;
    // its creation time still differs (on filesystems that record it).
    return (
      createdFileStat !== undefined &&
      currentFileStat?.ino === createdFileStat.ino &&
      currentFileStat.dev === createdFileStat.dev &&
      currentFileStat.birthtimeMs === createdFileStat.birthtimeMs
    )
  }
  try {
    /* c8 ignore next -- `createdFileStat` is missing only if swapped back within microseconds of the copy */
    if (
      !createdFileStat ||
      resolvedTargetPath !== target ||
      resolveFilesystemPath(target) !== target
    ) {
      throw new E_BACKUP_UNSAFE(`restore target ${target} moved during the copy`)
    }
    chmodSync(target, 0o600)
    assertMatchesManifest(target, manifest, `staged copy of ${bundle.name}`)
    syncPath(target)
    syncPath(dirname(target))
  } catch (error) {
    // Remove only the file this restore created: where the path leads now and where it landed.
    try {
      for (const path of new Set([target, resolvedTargetPath]))
        if (matchesCreatedRestoreFile(path)) rmSync(path, { force: true })
    } catch (cleanupError) {
      // The verification failure is the finding; the failed removal rides along as in create.
      if (error instanceof Error)
        Object.defineProperty(error, 'cleanupError', { value: cleanupError })
    }
    throw error
  }
  return { bundle: bundle.name, target }
}
