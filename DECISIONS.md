# Decisions

## Standalone API

On November 25, 2026, the package had no active installations requiring a legacy API. This
alignment targets fresh installations without legacy aliases. Standalone callers select an archive
or operator database with a class instance. These entry points use the existing bundle format,
cooperative archive lock, exclusive database lease and staged restore. Future changes follow the
normal release policy.

The configured `SqliteBackup` service continues to own Lucid source selection and exposes
`livePath()` for an enabled backup configuration. Its database configuration is private.

### Updating callers

These changes are in the unreleased source and apply when adopting the next release.

| Previous export                                  | Replacement                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `prepareDirectory(directory)`                    | `archive.prepareDirectory()`                                                                                                |
| `createBundle({ directory, ...options })`        | `archive.create(options)`                                                                                                   |
| `listBundles(directory)`                         | `archive.list()`                                                                                                            |
| `verifyBundle(directory, name)`                  | `archive.verify(name)`                                                                                                      |
| `prepareRestore({ directory, ...options })`      | `archive.prepareRestore(options)`                                                                                           |
| `pruneBundles({ directory, ...options })`        | `archive.prune(options)`                                                                                                    |
| `acquireLock(directory, timeoutMs)`              | `archive.acquireLock(timeoutMs)`                                                                                            |
| `resolveSqliteSource(database, connection)`      | `new SqliteBackup(defineConfig({ directory, connection }), database).livePath()`                                            |
| `operatorDatabasePath(db, confirmation)`         | `operator.databasePath(confirmation)`                                                                                       |
| `withOperatorDatabase(db, work)`                 | `operator.run(work)`                                                                                                        |
| `preMigrationBackupDirectory(dbPath, directory)` | Use the [destination documented for db:upgrade](README.md#upgrading-a-database) to inspect pre-migration bundles.           |
| `syncPath(path)`                                 | Use Node's filesystem API when syncing a caller-owned file or directory. The package handles durability for its own writes. |

Create `archive` with `new BackupArchive(directory)` and `operator` with
`new OperatorDatabase(db)`. See [standalone backup and restore](README.md#service-and-configuration)
and [stopped-server commands](README.md#stopped-server-operator-commands) for usage.

CapacityLens currently pins an earlier release. At its next adoption, update archive reads in
diagnostics and installation reset, the operator database calls in owner recovery, company
initialization and installation reset, and the backup, restore, diagnostics and upgrade tests
that exercise those APIs.

Configuration mistakes in Lucid source lookup use AdonisJS’s `InvalidArgumentsException`.
Update code that matched `E_BACKUP_SOURCE` for a missing connection, unsupported client or
invalid configured filename. That package code still covers operational source failures such
as an unreadable SQLite file. Match `E_BACKUP_WRITE` for a file write that makes no progress,
and `E_BACKUP_INVALID` for verification failures.

## Ace binding resolution

Package commands resolve services from the running command’s application container. Lucid 22.4.2
uses the same pattern in `build/commands/migration/run.js` and `build/commands/schema_generate.js`.
Its `build/services/db.js` captures the application’s binding at module load, so the command must
resolve against its own application when invoked within a process that hosts multiple apps.
See the [service import discussion](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/issues/128)
and the [two-app startup test](tests/app.spec.ts).
