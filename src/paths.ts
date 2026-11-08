import { lstatSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { BackupException } from './errors.js'

/** Symlink hops followed before giving up, as Linux does (MAXSYMLINKS). */
const MAX_LINKS = 40

const segments = (path: string) => path.split('/').filter((s) => s !== '' && s !== '.')

/**
 * The real path the kernel (and SQLite) reaches for `path`, relative paths taken from the current
 * folder. It walks one segment at a time: a symlink's text is spliced into the remaining segments
 * and `..` steps up from the real folder reached so far, never from the text. When the file exists
 * the result equals `fs.realpathSync.native` (libc). Node's JS `fs.realpathSync` is not a reference:
 * it collapses `..` as text first. At the first missing segment the rest is appended as is; a
 * `..` after that is refused, since the kernel would fail with ENOENT.
 *
 * Never pass the input through `path.resolve` or `path.normalize` first: they collapse `..` before
 * symlinks are followed.
 */
export function realPath(path: string): string {
  let current = isAbsolute(path) ? '/' : process.cwd()
  const pending = segments(path)
  let missing = false
  let hops = 0
  while (pending.length > 0) {
    const segment = pending.shift()!
    if (segment === '..') {
      if (missing) {
        throw new BackupException('E_BACKUP_UNSAFE', `path ${path} has .. after a missing folder`)
      }
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    if (missing) {
      current = next
      continue
    }
    let stat
    try {
      stat = lstatSync(next, { throwIfNoEntry: false })
    } catch {
      stat = undefined // ENOTDIR and the like: the kernel would fail here too
    }
    if (!stat?.isSymbolicLink()) {
      missing = stat === undefined
      current = next
      continue
    }
    if (++hops > MAX_LINKS) {
      throw new BackupException('E_BACKUP_UNSAFE', `too many symlinks resolving ${path}`)
    }
    const link = readlinkSync(next)
    if (isAbsolute(link)) current = '/'
    pending.unshift(...segments(link))
  }
  return current
}
