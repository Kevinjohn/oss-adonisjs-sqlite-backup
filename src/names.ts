import { BackupException } from './errors.js'

/** Bundle directory names: UTC timestamp, millisecond precision, strictly increasing per directory. */
export const BUNDLE_RE = /^bak-utc-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/
export const READY = 'READY'
export const DATABASE = 'db.sqlite'
export const MANIFEST = 'manifest.json'
export const LOCK_FILE = '.backup.lock'

/** Names exist only for 2000-01-01 through 9999-12-31, so every name has a 4-digit year. */
const MIN_STAMP = Date.UTC(2000, 0, 1)
const MAX_STAMP = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

function format(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, width = 2) => String(n).padStart(width, '0')
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `bak-utc-${date}-${time}-${p(d.getUTCMilliseconds(), 3)}`
}

/** The name for a timestamp. Throws rather than produce a name `BUNDLE_RE` would reject. */
export function bundleName(ms: number): string {
  if (!Number.isInteger(ms) || ms < MIN_STAMP || ms > MAX_STAMP) {
    throw new BackupException('E_BACKUP_UNSAFE', `timestamp ${ms} is outside the bundle name range`)
  }
  return format(ms)
}

/** The timestamp of a name. Rejects names whose date is not real (month 13, day 32, ...). */
export function parseBundleName(name: string): number {
  const m = BUNDLE_RE.exec(name)
  const [, y, mo, d, h, mi, s, ms] = (m ?? []).map(Number)
  const stamp = m ? Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, ms!) : Number.NaN
  if (!(stamp >= MIN_STAMP && stamp <= MAX_STAMP) || format(stamp) !== name) {
    throw new BackupException('E_BACKUP_UNSAFE', `"${name}" is not a bundle name`)
  }
  return stamp
}

export function isBundleName(name: string): boolean {
  try {
    parseBundleName(name)
    return true
  } catch {
    return false
  }
}
