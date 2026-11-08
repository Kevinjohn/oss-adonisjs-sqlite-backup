import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { BackupException } from '../src/errors.js'

const ACTIONS = ['create', 'list', 'verify', 'restore-prepare', 'prune'] as const

/** The actions each flag applies to; a flag given with any other action is refused, not ignored. */
const FLAG_ACTIONS = {
  bundle: ['verify', 'restore-prepare'],
  target: ['restore-prepare'],
  keep: ['prune'],
  directory: ['list', 'verify', 'restore-prepare'],
} as const satisfies Record<string, readonly (typeof ACTIONS)[number][]>

const listOf = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('')

/** `node ace db:backup <create|list|verify|restore-prepare|prune>` */
export default class DbBackup extends BaseCommand {
  static commandName = 'db:backup'
  static description =
    'Create, list, verify, stage (restore-prepare) or prune SQLite backup bundles'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: ACTIONS.join(' | ') })
  declare action: string

  @flags.string({ description: 'Bundle name for verify / restore-prepare (default: newest READY)' })
  declare bundle?: string

  @flags.string({ description: 'restore-prepare: path to stage the copy at (must not exist)' })
  declare target?: string

  @flags.number({ description: 'prune: READY bundles to keep (default: config keep)' })
  declare keep?: number

  @flags.string({
    description: 'list / verify / restore-prepare: use this directory instead of config',
  })
  declare directory?: string

  async run() {
    try {
      const backup = await this.app.container.make('sqlite.backup')
      for (const [flag, actions] of Object.entries(FLAG_ACTIONS)) {
        if (this[flag as keyof typeof FLAG_ACTIONS] === undefined) continue
        if (!(actions as readonly string[]).includes(this.action)) {
          throw new BackupException(
            'E_BACKUP_UNSAFE',
            `--${flag} is only supported for ${listOf(actions)}`
          )
        }
      }
      switch (this.action) {
        case 'create': {
          backup.prepareDirectory()
          const result = await backup.create()
          for (const warning of result.warnings) this.logger.warning(warning)
          this.logger.success(`Backup ${result.name} written to ${result.path}`)
          return
        }
        case 'list':
          for (const bundle of backup.list(this.directory)) this.logger.log(bundle.name)
          return
        case 'verify':
          this.logger.success(`Bundle ${backup.verify(this.bundle, this.directory).name} verified`)
          return
        case 'restore-prepare': {
          if (!this.target) {
            throw new BackupException('E_BACKUP_UNSAFE', 'restore-prepare needs --target')
          }
          const staged = backup.prepareRestore({
            target: this.target,
            name: this.bundle,
            directory: this.directory,
          })
          this.logger.success(
            `Staged ${staged.bundle} at ${staged.target}. The live database is untouched.`
          )
          return
        }
        case 'prune': {
          const result = await backup.prune({ keep: this.keep })
          for (const failure of result.failed) {
            this.logger.warning(`could not remove ${failure.name}: ${failure.reason}`)
          }
          this.logger.success(
            `Pruned ${result.removed.length} bundle(s), ${result.abandoned.length} unfinished`
          )
          if (result.failed.length > 0) this.exitCode = 1
          return
        }
        default:
          throw new BackupException(
            'E_BACKUP_UNSAFE',
            `unknown action "${this.action}" (use ${ACTIONS.join(', ')})`
          )
      }
    } catch (error) {
      const code = error instanceof BackupException ? `${error.code}: ` : ''
      this.logger.error(`db:backup ${this.action} failed: ${code}${(error as Error).message}`)
      const cleanupError = (error as { cleanupError?: unknown }).cleanupError
      if (cleanupError) this.logger.error(`backup temp cleanup failed: ${String(cleanupError)}`)
      this.exitCode = 1
    }
  }
}
