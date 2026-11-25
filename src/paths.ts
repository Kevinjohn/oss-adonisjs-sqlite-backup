import { lstatSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { E_BACKUP_UNSAFE } from './errors.ts'

/** Symlink hops followed before giving up, as Linux does (MAXSYMLINKS). */
const MAX_LINKS = 40

/** Stands for a trailing slash. It cannot be a folder name, since paths are split on it. */
const TRAILING_SLASH = '/'

const splitPathSegments = (path: string) => {
  const parts = path.split('/').filter((s) => s !== '')
  if (path.endsWith('/')) parts.push(TRAILING_SLASH)
  return parts
}

/**
 * The real path the kernel (and SQLite) reaches for `path`, relative paths taken from the current
 * folder. It walks one segment at a time: a symlink's text is spliced into the remaining segments
 * and `..` steps up from the real folder reached so far, never from the text. Existing paths
 * match `fs.realpathSync.native` when no segment traverses a regular file. A regular file followed
 * by another segment, including a trailing slash or `.`, is refused. At the first missing segment
 * the rest is appended as is; the result need not exist. A `.` or `..` after a missing segment is
 * refused, since the kernel would fail with ENOENT. A trailing slash after a missing segment is
 * dropped: it names a folder still to be made, as `mkdir` accepts.
 *
 * Never pass the input through `path.resolve` or `path.normalize` first: they collapse `..` before
 * symlinks are followed.
 */
export function resolveFilesystemPath(path: string): string {
  let current = isAbsolute(path) ? '/' : process.cwd()
  const pending = splitPathSegments(path)
  let isBeyondExistingPrefix = false
  let isDirectory = true
  let hops = 0
  while (pending.length > 0) {
    const segment = pending.shift()!
    if (!isDirectory) {
      throw new E_BACKUP_UNSAFE(`path ${path} traverses a non-directory`)
    }
    if (segment === TRAILING_SLASH) continue
    if (segment === '.') {
      if (isBeyondExistingPrefix)
        throw new E_BACKUP_UNSAFE(`path ${path} has . after a missing folder`)
      continue
    }
    if (segment === '..') {
      if (isBeyondExistingPrefix) {
        throw new E_BACKUP_UNSAFE(`path ${path} has .. after a missing folder`)
      }
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    if (isBeyondExistingPrefix) {
      current = next
      continue
    }
    const stat = lstatSync(next, { throwIfNoEntry: false })
    if (!stat?.isSymbolicLink()) {
      isBeyondExistingPrefix = stat === undefined
      isDirectory = isBeyondExistingPrefix || !!stat?.isDirectory()
      current = next
      continue
    }
    if (++hops > MAX_LINKS) {
      throw new E_BACKUP_UNSAFE(`too many symlinks resolving ${path}`)
    }
    const link = readlinkSync(next)
    if (isAbsolute(link)) current = '/'
    pending.unshift(...splitPathSegments(link))
  }
  return current
}
