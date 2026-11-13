import { join, resolve } from 'node:path'

/**
 * Where the snapshot taken before migrating is written: `pre-migration` under the configured
 * backup directory, or `<database>.backups` beside the database when backups are not configured.
 * Either way the bundles stay outside scheduled retention.
 */
export function preMigrationBackupDirectory(dbPath: string, configuredDirectory?: string): string {
  return configuredDirectory
    ? join(configuredDirectory, 'pre-migration')
    : `${resolve(dbPath)}.backups`
}
