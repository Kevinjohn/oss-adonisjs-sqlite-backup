import { ListLoader } from '@adonisjs/core/ace'
import type { CommandMetaData } from '@adonisjs/core/types/ace'
import DbBackup from './db_backup.js'
import DbUpgrade from './db_upgrade.js'

/** Command loader referenced from the app's adonisrc `commands` list. */
const loader = new ListLoader([DbBackup, DbUpgrade])

/**
 * List the backup and upgrade commands registered by the loader.
 *
 * @example
 * ```ts
 * import { getMetaData } from '@kevinjohn/adonisjs-sqlite-backup/commands'
 *
 * const commands = await getMetaData()
 * ```
 */
export const getMetaData = () => loader.getMetaData()

/**
 * Resolve the command class for a metadata entry returned by the loader.
 *
 * @example
 * ```ts
 * import { getCommand, getMetaData } from '@kevinjohn/adonisjs-sqlite-backup/commands'
 *
 * const metadata = (await getMetaData()).find((command) => command.commandName === 'db:backup')
 * if (metadata) {
 *   const DbBackup = await getCommand(metadata)
 * }
 * ```
 */
export const getCommand = (metaData: CommandMetaData) => loader.getCommand(metaData)
