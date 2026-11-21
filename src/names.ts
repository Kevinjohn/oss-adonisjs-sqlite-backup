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

function formatBundleName(ms: number): string {
  const date = new Date(ms)
  const padDecimal = (n: number, width = 2) => String(n).padStart(width, '0')
  const datePart = `${date.getUTCFullYear()}${padDecimal(date.getUTCMonth() + 1)}${padDecimal(date.getUTCDate())}`
  const time = `${padDecimal(date.getUTCHours())}${padDecimal(date.getUTCMinutes())}${padDecimal(date.getUTCSeconds())}`
  return `bak-utc-${datePart}-${time}-${padDecimal(date.getUTCMilliseconds(), 3)}`
}

/** The name for a timestamp. Throws rather than produce a name `BUNDLE_RE` would reject. */
export function requireFormattedBundleName(ms: number): string {
  if (!Number.isInteger(ms) || ms < MIN_STAMP || ms > MAX_STAMP) {
    throw new BackupException('E_BACKUP_UNSAFE', `timestamp ${ms} is outside the bundle name range`)
  }
  return formatBundleName(ms)
}

/** The timestamp of a name. Rejects names whose date is not real (month 13, day 32, ...). */
export function requireBundleTimestamp(name: string): number {
  const nameMatch = BUNDLE_RE.exec(name)
  const [, year, month, day, hour, minute, second, milliseconds] = (nameMatch ?? []).map(Number)
  const stamp = nameMatch
    ? Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, milliseconds!)
    : Number.NaN
  if (!(stamp >= MIN_STAMP && stamp <= MAX_STAMP) || formatBundleName(stamp) !== name) {
    throw new BackupException('E_BACKUP_UNSAFE', `"${name}" is not a bundle name`)
  }
  return stamp
}

export function isBundleName(name: string): boolean {
  try {
    requireBundleTimestamp(name)
    return true
  } catch {
    return false
  }
}
