import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertDirectory } from './directory.ts'
import { assertMigrations, readMigrationRows } from './migrations.ts'
import { readDatabaseIntegrityProblem } from './checks.ts'
import { E_BACKUP_INVALID, E_BACKUP_NOT_FOUND, E_BACKUP_SOURCE, E_BACKUP_UNSAFE } from './errors.ts'
import { resolveFilesystemPath } from './paths.ts'
import { hashFileSha256, syncPath, writeDurable } from './fs.ts'
import { internalHooks } from './internal_hooks.ts'
import { acquireCreateLock } from './lock.ts'
import {
  DATABASE,
  MANIFEST,
  READY,
  requireFormattedBundleName,
  isBundleName,
  requireBundleTimestamp,
} from './names.ts'
import { openDatabase, type NativeDatabase } from './native.ts'
import { assertSafeLayout, requireBorrowedSourcePath, openOwnedSource } from './source.ts'
import type { BundleLocation, BundleManifest, BundleSummary, CreateResult } from './types.ts'

/** A clock-step allowance: a newest bundle further ahead of the clock than this is refused. */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

/**
 * Every real directory (not a symlink) with a valid bundle name, READY or not, oldest first.
 * Entries that vanish while listing (a concurrent prune) are skipped.
 */
export function listBundleDirectoryNames(directory: string): string[] {
  assertDirectory(directory)
  const names = readdirSync(directory)
  internalHooks.step?.('list:read', directory)
  return names
    .filter(
      (name) =>
        isBundleName(name) &&
        lstatSync(join(directory, name), { throwIfNoEntry: false })?.isDirectory() === true
    )
    .sort()
}

/**
 * Published bundles only (READY present), oldest first. Name order is creation order.
 *
 * @example
 * ```ts
 * import { listBundles } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const bundles = listBundles('storage/backups')
 * ```
 */
export function listBundles(folder: string): BundleSummary[] {
  const directory = resolveFilesystemPath(folder)
  return listBundleDirectoryNames(directory).flatMap((name) => {
    const bundle = { name, path: join(directory, name) }
    if (!existsSync(join(bundle.path, READY))) return []
    const hadManifest = existsSync(join(bundle.path, MANIFEST))
    internalHooks.step?.('list:ready', bundle.path)
    try {
      return [{ ...bundle, createdAt: readManifest(bundle).createdAt }]
    } catch (error) {
      if (
        !existsSync(join(bundle.path, READY)) ||
        (hadManifest && !existsSync(join(bundle.path, MANIFEST)))
      )
        return []
      throw error
    }
  })
}

/** Pick a bundle by name (a real directory, never a symlink), or the newest READY bundle. */
export function requireSelectedBundle(directory: string, name?: string): BundleLocation {
  if (name !== undefined) {
    requireBundleTimestamp(name)
    const path = join(directory, name)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) throw new E_BACKUP_NOT_FOUND(`no bundle ${name}`)
    if (!stat.isDirectory()) {
      throw new E_BACKUP_UNSAFE(`${name} is not a bundle directory`)
    }
    return { name, path }
  }
  const newest = listBundleDirectoryNames(directory)
    .filter((entry) => existsSync(join(directory, entry, READY)))
    .at(-1)
  if (!newest) throw new E_BACKUP_NOT_FOUND(`no READY bundle in ${directory}`)
  return { name: newest, path: join(directory, newest) }
}

function isMigrationManifest(value: unknown): value is NonNullable<BundleManifest['migrations']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.table === 'string' &&
    record.table.length > 0 &&
    Number.isSafeInteger(record.count) &&
    Number(record.count) >= 0 &&
    (record.last === null || typeof record.last === 'string')
  )
}

/** Read the manifest of a published bundle; a missing READY means the bundle does not exist yet. */
export function readManifest(bundle: BundleLocation): BundleManifest {
  if (!existsSync(join(bundle.path, READY))) {
    throw new E_BACKUP_INVALID(`bundle ${bundle.name} has no READY marker`)
  }
  try {
    if (
      !lstatSync(join(bundle.path, READY)).isFile() ||
      !lstatSync(join(bundle.path, MANIFEST)).isFile()
    ) {
      throw new E_BACKUP_INVALID('expected regular READY and manifest files')
    }
    const manifest = JSON.parse(readFileSync(join(bundle.path, MANIFEST), 'utf8')) as BundleManifest
    if (
      manifest.format !== 1 ||
      typeof manifest.sha256 !== 'string' ||
      typeof manifest.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
      (Object.hasOwn(manifest, 'migrations') && !isMigrationManifest(manifest.migrations))
    )
      throw new E_BACKUP_INVALID('bad shape')
    return manifest
  } catch (cause) {
    throw new E_BACKUP_INVALID(`bundle ${bundle.name} manifest is unreadable`, {
      cause,
    })
  }
}

/** Check a database file against a manifest: size, sha256, full integrity and FK checks. */
export function assertMatchesManifest(path: string, manifest: BundleManifest, label: string): void {
  let matches: boolean
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new E_BACKUP_INVALID('expected a regular database file')
    matches = stat.size === manifest.bytes && hashFileSha256(path) === manifest.sha256
  } catch (cause) {
    throw new E_BACKUP_INVALID(`${label}: database file cannot be read`, {
      cause,
    })
  }
  if (!matches) {
    throw new E_BACKUP_INVALID(`${label}: checksum does not match manifest`)
  }
  const problem = readDatabaseIntegrityProblem(path)
  if (problem) throw new E_BACKUP_INVALID(`${label}: ${problem}`)
  if (manifest.migrations) assertMigrations(path, manifest.migrations)
}

/**
 * Re-verify a published bundle in place. Lock-free: if prune unpublishes the bundle while it is
 * being checked, the result is E_BACKUP_NOT_FOUND, not a false E_BACKUP_INVALID.
 *
 * @example
 * ```ts
 * import { verifyBundle } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const verified = verifyBundle('storage/backups')
 * ```
 */
export function verifyBundle(folder: string, name?: string): BundleLocation {
  const directory = resolveFilesystemPath(folder)
  const bundle = requireSelectedBundle(directory, name)
  internalHooks.step?.('verify:listed', bundle.path)
  // Default selection saw READY; a concurrent unpublish is reported as NOT_FOUND.
  const wasReady = name === undefined || existsSync(join(bundle.path, READY))
  internalHooks.step?.('verify:selected', bundle.path)
  try {
    const manifest = readManifest(bundle)
    assertMatchesManifest(join(bundle.path, DATABASE), manifest, `bundle ${bundle.name}`)
    return bundle
  } catch (error) {
    if (wasReady && !existsSync(join(bundle.path, READY))) {
      throw new E_BACKUP_NOT_FOUND(`bundle ${bundle.name} was pruned`, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Online copy -> full checks -> manifest -> READY last, all under the directory lock.
 * A bundle without READY is not a backup; prune removes it once nobody holds the lock.
 *
 * @example
 * ```ts
 * import { createBundle, prepareDirectory } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * prepareDirectory('storage/backups')
 * const bundle = await createBundle({
 *   livePath: 'storage/orchard.sqlite',
 *   directory: 'storage/backups',
 * })
 * ```
 * @throws AggregateError propagated from lock acquisition or release, or created if bundle
 * creation throws a non-Error value and cleanup fails, or if multiple native cleanup steps fail
 * after successful creation.
 */
export async function createBundle(
  input: (
    | { livePath: string; source?: never }
    | { source: { database: NativeDatabase }; livePath?: never }
  ) & {
    directory: string
    migrationsTable?: string
    lockTimeoutMs?: number
    requireWal?: boolean
    now?: () => number
  }
): Promise<CreateResult> {
  const { lockTimeoutMs = 0, requireWal = false, now = Date.now } = input
  const borrowed = input.source?.database
  const livePath = borrowed
    ? requireBorrowedSourcePath(borrowed)
    : resolveFilesystemPath(input.livePath!)
  const directory = resolveFilesystemPath(input.directory)
  assertDirectory(directory, { requirePrivateRoot: true })
  assertSafeLayout(livePath, directory)
  const lock = await acquireCreateLock(directory, lockTimeoutMs)
  const warnings: string[] = []
  let bundlePath: string | undefined
  let source: NativeDatabase | undefined
  let primaryError: unknown
  let failed = false
  let result: CreateResult | undefined
  const cleanupErrors: unknown[] = []
  const cleanupFailedBundle = (error: unknown): unknown => {
    if (!bundlePath) return error
    try {
      const marker = join(bundlePath, READY)
      if (existsSync(marker)) {
        unlinkSync(marker)
        syncPath(bundlePath)
      }
      internalHooks.step?.('create:cleanup', bundlePath)
      rmSync(bundlePath, { recursive: true, force: true })
    } catch (cleanupError) {
      if (error instanceof Error) {
        Object.defineProperty(error, 'cleanupError', { value: cleanupError })
      } else {
        const combined = new AggregateError([error, cleanupError], 'bundle cleanup failed')
        Object.defineProperty(combined, 'cleanupError', { value: cleanupError })
        return combined
      }
    }
    return error
  }
  try {
    let journalMode: string
    try {
      source = borrowed ?? openOwnedSource(livePath)
      journalMode = String(source.pragma('journal_mode', { simple: true }))
    } catch (cause) {
      if (cause instanceof E_BACKUP_SOURCE) throw cause
      throw new E_BACKUP_SOURCE(`live database ${livePath} cannot be read`, {
        cause,
      })
    }
    // The backup API cannot run from a connection with an open transaction.
    if (source.inTransaction) {
      throw new E_BACKUP_SOURCE(
        'the borrowed database handle has an open transaction; commit or roll it back first'
      )
    }
    if (journalMode !== 'wal') {
      const message = `live database uses journal_mode=${journalMode}, not WAL: writers in other processes wait for the whole copy`
      if (requireWal) throw new E_BACKUP_SOURCE(message)
      warnings.push(message)
    }
    // Names must stay strictly increasing even if the clock steps back, because prune orders by
    // name. A newest bundle far in the future is a stray or a wrong clock: refuse, do not follow it.
    const clock = now()
    const newest = listBundleDirectoryNames(directory).at(-1)
    const newestStamp = newest ? requireBundleTimestamp(newest) : Number.NEGATIVE_INFINITY
    if (newestStamp > clock + MAX_FUTURE_MS) {
      throw new E_BACKUP_UNSAFE(
        `newest bundle ${newest} is dated more than 24 h after the clock; fix the clock or move it`
      )
    }
    const stamp = Math.max(clock, newestStamp + 1)
    const name = requireFormattedBundleName(stamp)
    internalHooks.step?.('create:naming', directory)
    try {
      mkdirSync(join(directory, name), { mode: 0o700 })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      throw new E_BACKUP_UNSAFE(`${join(directory, name)} already exists`, {
        cause,
      })
    }
    // Only now is the folder ours to clean up.
    bundlePath = join(directory, name)
    syncPath(directory)
    const file = join(bundlePath, DATABASE)
    const migrationsTable = input.migrationsTable ?? 'adonis_schema'
    const migrations = readMigrationRows(source, migrationsTable)
    internalHooks.step?.('create:copying', file)
    // One step: the default 100-page steps restart on every write by another connection and
    // never finish under sustained writes. One step copies under a single SQLite read snapshot.
    await source.backup(file, { progress: () => 0x7fffffff })
    internalHooks.step?.('create:copied', file)
    const copy = openDatabase(file, { fileMustExist: true })
    try {
      copy.pragma('wal_checkpoint(TRUNCATE)')
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    rmSync(`${file}-wal`, { force: true })
    rmSync(`${file}-shm`, { force: true })
    const journal = openDatabase(file, { fileMustExist: true, readonly: true })
    try {
      if (!isDeepStrictEqual(readMigrationRows(journal, migrationsTable), migrations)) {
        throw new E_BACKUP_INVALID(`new backup migration journal ${migrationsTable} mismatch`)
      }
    } finally {
      journal.close()
    }
    const problem = readDatabaseIntegrityProblem(file)
    if (problem) throw new E_BACKUP_INVALID(`new backup failed: ${problem}`)
    chmodSync(file, 0o400)
    syncPath(file)
    internalHooks.step?.('create:checked', file)
    const manifest: BundleManifest = {
      format: 1,
      createdAt: new Date(clock).toISOString(),
      bytes: statSync(file).size,
      sha256: hashFileSha256(file),
      sourceJournalMode: journalMode,
      ...(migrations
        ? {
            migrations: {
              table: migrationsTable,
              count: migrations.length,
              last: (migrations.at(-1)?.name as string | undefined) ?? null,
            },
          }
        : {}),
    }
    if (manifest.migrations && !isMigrationManifest(manifest.migrations)) {
      throw new E_BACKUP_INVALID('new backup has unsupported migration metadata')
    }
    writeDurable(join(bundlePath, MANIFEST), JSON.stringify(manifest, null, 2))
    syncPath(bundlePath)
    internalHooks.step?.('create:manifest', file)
    writeDurable(join(bundlePath, READY), '')
    syncPath(bundlePath)
    syncPath(directory)
    result = { name, path: bundlePath, createdAt: manifest.createdAt, manifest, warnings }
  } catch (error) {
    failed = true
    primaryError = cleanupFailedBundle(error)
  } finally {
    try {
      if (!borrowed) source?.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      lock.release()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (failed) {
    if (cleanupErrors.length) {
      if (primaryError instanceof Error)
        Object.defineProperty(primaryError, 'resourceCleanupErrors', { value: cleanupErrors })
      else {
        const combined = new AggregateError(
          [primaryError, ...cleanupErrors],
          'bundle creation and cleanup failed'
        )
        Object.defineProperty(combined, 'resourceCleanupErrors', { value: cleanupErrors })
        throw combined
      }
    }
    throw primaryError
  }
  if (cleanupErrors.length) {
    const failure =
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'native resource cleanup failed')
    if (failure instanceof AggregateError)
      Object.defineProperty(failure, 'resourceCleanupErrors', { value: cleanupErrors })
    throw cleanupFailedBundle(failure)
  }
  return result!
}
