import { ListLoader } from '@adonisjs/core/ace'
import type { CommandMetaData } from '@adonisjs/core/types/ace'
import DbBackup from './db_backup.js'

/** Command loader referenced from the app's adonisrc `commands` list. */
const loader = new ListLoader([DbBackup])

export const getMetaData = () => loader.getMetaData()
export const getCommand = (metaData: CommandMetaData) => loader.getCommand(metaData)
