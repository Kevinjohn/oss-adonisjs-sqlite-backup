# Catalogue reference

## Source baseline and scope

Fetched `origin/main` baseline: [`5e225b8f8f5d74b4d60a56c11b00f46583d94c29`](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/commit/5e225b8f8f5d74b4d60a56c11b00f46583d94c29). Inventory covers Ace actions/options, config and provider, the container service, standalone exports, file/database effects, operational documentation and relevant tests.

## Roles and boundaries

- **Application operator:** configures the Lucid SQLite connection, backup root, startup preparation and scheduler.
- **Host operator:** runs create/list/verify/restore-prepare/prune and manages filesystem access.
- **Application runtime:** owns the live SQLite file and any application cutover to a staged recovery copy.

The package exposes commands and APIs, not a graphical application workflow. `restore-prepare` writes a verified copy to a new path and does not replace the live database or switch Lucid configuration. Stopping the application, selecting the staged file, restarting and validating are host decisions.

## Availability and evidence

All listed actions are Operator journeys. Create/source checks require a configured Lucid SQLite file. List and verify need only the selected backup root; restore preparation also resolves the live path for safety. A nonempty configured directory enables configured operations; list/verify/restore root overrides work while configured backups are disabled. Source-reviewed availability does not establish that any runtime backup or recovery was exercised; linked tests were inspected as evidence locations only.

## Source map

| Capability            | Ace/service entry                                                                        | Implementation and contract                                                           |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Configure and prepare | [configure](../configure.ts), [provider](../providers/sqlite_backup_provider.ts)         | [defineConfig](../src/define_config.ts), [directory](../src/directory.ts)             |
| Create                | [DbBackup.run](../commands/db_backup.ts), [SqliteBackup.create](../src/sqlite_backup.ts) | [createBundle](../src/bundles.ts), [checks](../src/checks.ts), [lock](../src/lock.ts) |
| List                  | [DbBackup.run](../commands/db_backup.ts), [SqliteBackup.list](../src/sqlite_backup.ts)   | [listBundles](../src/bundles.ts)                                                      |
| Verify                | [SqliteBackup.verify](../src/sqlite_backup.ts)                                           | [verifyBundle and manifest checks](../src/bundles.ts)                                 |
| Prepare restore       | [SqliteBackup.prepareRestore](../src/sqlite_backup.ts)                                   | [prepareRestore](../src/restore.ts), [path resolution](../src/paths.ts)               |
| Prune                 | [SqliteBackup.prune](../src/sqlite_backup.ts)                                            | [pruneBundles](../src/prune.ts)                                                       |

Standalone exports are in [the package index](../index.ts). The [README](../README.md) is the user-facing contract for limitations, error codes and the fact that restore is preparation only.

## Operator limits

The [README limits](../README.md#limits) require a local filesystem for the SQLite lock and trusted parent directories for backup/restore paths. Linux is tested; Windows is unsupported because directory fsync is required. Copy work is synchronous and belongs in an operator task, not a web request. A plain filesystem SQLite path is required; in-memory and `file:` URI sources are refused. No runtime platform or recovery verification is claimed by this catalogue.
