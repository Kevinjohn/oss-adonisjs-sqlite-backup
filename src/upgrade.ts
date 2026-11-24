import { join } from 'node:path'
import { resolveFilesystemPath } from './paths.js'

/**
 * Where the pre-migration backup bundle is written: `pre-migration` under the configured backup
 * directory, or `<database>.backups` beside the database when backups are not configured.
 * Either way the bundles stay outside scheduled retention.
 *
 * @throws A filesystem path resolution error.
 *
 * @example
 * ```ts
 * import { preMigrationBackupDirectory } from '@kevinjohn/adonisjs-sqlite-backup'
 *
 * const directory = preMigrationBackupDirectory('storage/orchard.sqlite', 'storage/backups')
 * ```
 */
export function preMigrationBackupDirectory(dbPath: string, configuredDirectory?: string): string {
  return configuredDirectory
    ? join(resolveFilesystemPath(configuredDirectory), 'pre-migration')
    : `${resolveFilesystemPath(dbPath)}.backups`
}
