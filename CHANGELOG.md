# Changelog

## Unreleased

### Breaking changes: programmatic callers

The standalone API now uses two classes exported from `@kevinjohn/adonisjs-sqlite-backup`.
Existing format-1 bundles remain readable without a data migration. The functions in the
left column have been removed from the package root without compatibility aliases.

Create one `new BackupArchive(directory)` for each archive you use. Pass the directory to the
constructor and omit it from method options.

| Removed export and previous call                 | Replacement                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepareDirectory(directory)`                    | `archive.prepareDirectory()`                                                                                                                                                                                                   |
| `createBundle({ directory, ...options })`        | `await archive.create(options)`. Pass `livePath` or `source: { database }` for a borrowed native handle.                                                                                                                       |
| `listBundles(directory)`                         | `archive.list()`                                                                                                                                                                                                               |
| `verifyBundle(directory, name)`                  | `archive.verify(name)`. Omit `name` to verify the newest bundle.                                                                                                                                                               |
| `prepareRestore({ directory, ...options })`      | `archive.prepareRestore({ livePath, target, name })`. Pass the live path and an unused target path. `name` is optional.                                                                                                        |
| `pruneBundles({ directory, ...options })`        | `archive.prune(options)`. Pass `keep` and optionally `lockTimeoutMs`.                                                                                                                                                          |
| `acquireLock(directory, timeoutMs)`              | `archive.acquireLock(timeoutMs)`. Keep the returned lock and call `release()` in a `finally` block.                                                                                                                            |
| `operatorDatabasePath(db, confirmation)`         | `operator.databasePath(confirmation)` on `new OperatorDatabase(db)`. Call it before opening any connection.                                                                                                                    |
| `withOperatorDatabase(db, callback)`             | `await operator.run(callback)`. The callback receives the pinned native handle. Leave it open for the operator's cleanup.                                                                                                      |
| `resolveSqliteSource(database, connection)`      | `new SqliteBackup(defineConfig({ directory, connection }), database).livePath()`, or use `livePath()` on the configured service. The service requires an enabled backup directory.                                             |
| `preMigrationBackupDirectory(dbPath, directory)` | Inspect `pre-migration` under the resolved backup directory, or the resolved database path with `.backups` appended when no backup directory is set. See [where db:upgrade writes its backup](README.md#upgrading-a-database). |
| `syncPath(path)`                                 | Use Node's `node:fs` APIs for caller-owned files or directories, for example `openSync`, `fsyncSync` and `closeSync`. The package handles syncing its own writes.                                                              |

`CreateBundleOptions` is available for typed wrappers around `archive.create()`.
`DirectoryLock` and `NativeDatabase` remain available as type exports.

`SqliteBackup` now holds the Lucid database configuration in a private field. Subclasses that
read the former `database` property should use `livePath()` to resolve the source or keep their
own reference to the supplied configuration. See the [caller migration guide](DECISIONS.md#updating-callers).

### Update error handling and Ace setup

- Match AdonisJS's `InvalidArgumentsException` for an unconfigured connection, unsupported
  client, or missing, non-string, empty, in-memory or URI filename. This replaces
  `E_BACKUP_SOURCE` for these configuration mistakes. Keep matching `errors.E_BACKUP_SOURCE`
  for operational source failures such as an unavailable database file.
- Match `errors.E_BACKUP_WRITE` by class or `E_BACKUP_WRITE` by code when a bundle file write
  makes no progress. Update tests and error handlers that expected `E_BACKUP_INVALID` for this case.
  Continue using `E_BACKUP_INVALID` for bundle verification failures.
- The first `db:backup` argument is now called `operation` in the command property, Ace metadata
  and help. Update code that sets or inspects `action`. Positional invocations still use
  `create`, `list`, `verify`, `restore-prepare` and `prune`.
- On adoption, rerun `node ace configure @kevinjohn/adonisjs-sqlite-backup` to register
  `@adonisjs/lucid/commands` in `adonisrc.ts` for schema generation after `db:upgrade`.
  Rerunning preserves existing backup configuration and avoids duplicate registrations.
- Ace reports an archive lock-acquisition failure before a separate native close failure,
  keeping the underlying failures available to callers. An acquisition `Error` retains its
  identity, with the close failure in `resourceCleanupErrors`. When acquisition throws a
  non-`Error` value and close also fails, the `AggregateError` lists both original values
  in that order.
- Correct a compound lock-release failure after successful bundle creation: preserve the original
  rollback and close failures and attempt to remove the new bundle, instead of masking the failure
  with a `TypeError` before removal. Both Ace commands keep their failure in `error` for calling
  commands and avoid duplicate primary failure output.

### Capacity Lens adoption

Capacity Lens pins the published 0.5.0 tarball. Apply these changes when adopting a release
that includes the new API.

- Use `new BackupArchive(directory).list()` in backend diagnostics. In installation reset, create
  the verified backup with `archive.create({ source: { database: connection } })` inside the
  operator callback. Sync the retained source files, archive directory and source parent directory
  with Node's filesystem API.
- In owner recovery, company initialization and installation reset, create
  `const operator = new OperatorDatabase(db)`. Call `operator.databasePath(confirmation)` before
  opening a connection, then `await operator.run(callback)`.
- Update the backend backup configuration, provider, restore, installation reset and upgrade
  tests that use the removed imports.

### Maintenance

- Require successful main CI for the release commit before packaging the GitHub release archive.

## 0.5.0 - 2026-11-24

- `db:upgrade` reports a failed migration as one `Upgrade failed: …` line, without a stack trace,
  and still exits 1 with the migration error in `error`. It runs the pending migrations with
  Lucid's migration runner instead of a nested `migration:run`, whose own failure output Ace
  printed with the stack, once from each command. Migrated files are listed as `❯ migrated <file>`,
  a failed one as `❯ error <file>`, and a database with nothing pending as `Already up to date`.
  A calling command should not report the copied `error` again; the README example does not.

- Breaking: replace the `BackupException` and `errors.BackupException` exports with one exception class per
  backup code. Match the corresponding class with `instanceof` or continue matching
  `error.code`. `BackupErrorCode` and `BACKUP_ERROR_CODES` remain available.

  | Previous exception check                    | Replacement                 |
  | ------------------------------------------- | --------------------------- |
  | `BackupException` with `E_BACKUP_LOCKED`    | `errors.E_BACKUP_LOCKED`    |
  | `BackupException` with `E_BACKUP_SOURCE`    | `errors.E_BACKUP_SOURCE`    |
  | `BackupException` with `E_BACKUP_INVALID`   | `errors.E_BACKUP_INVALID`   |
  | `BackupException` with `E_BACKUP_UNSAFE`    | `errors.E_BACKUP_UNSAFE`    |
  | `BackupException` with `E_BACKUP_NOT_FOUND` | `errors.E_BACKUP_NOT_FOUND` |
  | `BackupException` with `E_BACKUP_DISABLED`  | `errors.E_BACKUP_DISABLED`  |

- Malformed backup configuration and invalid API arguments for retention or lock timeout now
  throw AdonisJS's `InvalidArgumentsException`. Missing backup configuration throws
  AdonisJS's `RuntimeException`. Operator guards use framework exceptions for invalid arguments
  and pool state, `errors.E_BACKUP_SOURCE` for a missing on-disk source, and
  `errors.E_BACKUP_LOCKED` for exclusive-lock contention.
- Add TypeScript examples to the public API documentation.

## 0.4.3 - 2026-11-24

- Document operator and live database path requirements, pre-migration destinations and the scope of scheduled retention.

## 0.4.2 - 2026-11-23

- `node ace db:upgrade --help` now describes `--schema-generate` as it behaves: schema classes are
  generated with `schema:generate` after a successful migration, never in production. The flag
  name, default and behaviour are unchanged.
- Correction to 0.4.0: its entry described a documentation-only release, but 0.4.0 also shipped
  these runtime and public-surface changes.
  - Behaviour change: `db:backup verify` and `restore-prepare` fail with `E_BACKUP_INVALID` when a
    bundle's `READY`, `manifest.json` or `db.sqlite` is not a regular file, for example a symbolic
    link; `db:backup list` does the same for `READY` and `manifest.json`.
  - Behaviour change: `defineConfig` throws `E_BACKUP_SOURCE` for a malformed `connection` or
    `requireWal` and `E_BACKUP_UNSAFE` for a malformed `directory`. The provider runs
    `defineConfig` again on the host configuration when it builds the service.
  - New export `@kevinjohn/adonisjs-sqlite-backup/services/main`, the booted application's
    `sqlite.backup` singleton.
  - `./types` re-exports `BackupErrorCode`, `DirectoryLock` and `NativeDatabase`, and the build
    output is unbundled, one module per source file.

## 0.4.1 - 2026-11-22

- Refuse to prepare a backup directory containing the configured live database before changing
  directory permissions. Clarify that the backup service entry point is available since v0.4.0.

## 0.4.0 - 2026-11-21

- Document and verify the package user stories and implementation flows.

## 0.3.3 - 2026-11-21

- `db:upgrade` exits non-zero when a migration fails on every Lucid 22 release. With Lucid 22.0 or
  22.1, schema generation after a failed migration reset the exit code to 0. `db:upgrade` now runs
  `migration:run --no-schema-generate`, then `schema:generate` only after a successful migration.

## 0.3.2 - 2026-11-19

- Check snapshot path safety before preparing the backup directory, and verify the pre-upgrade
  snapshot before running migrations.
- Refuse configured prune when the archive directory contains the live database. Report same-process
  lock contention immediately and preserve observed deletion progress if finalization fails.

## 0.3.1 - 2026-11-18

- A trailing slash on a folder that does not exist yet is accepted again, so `prepareDirectory`
  creates a backup directory configured as `/path/backups/` on first use. 0.3.0 refused it with
  `E_BACKUP_UNSAFE` and a message about `.` after a missing folder. A trailing slash after a
  regular file, and `.` or `..` after a missing folder, are still refused. A restore target
  written with a trailing slash is still refused, now with a message that says so.

## 0.3.0 - 2026-11-16

- `db:upgrade` snapshots use the primary connection's migrations table and the backup config's
  `lockTimeoutMs` and `requireWal`, and report the non-WAL warning. Before, they always read
  `adonis_schema`, never waited for the lock and ignored `requireWal`.
- Operator commands pin the primary SQLite handle and serialize queries through it. Lucid and pool
  lifecycle failures remain visible; work and cleanup failures are both preserved.
- Filesystem paths are resolved segment by segment, so `..` follows symlink targets. Package-owned
  sources and restore targets are refused if the native SQLite driver changes the selected filename
  spelling; this does not promise support for every kernel filename form. Borrowed handles remain
  supported.
- `db:backup create` checks source-layout eligibility before directory preparation. Preparation
  makes missing directories and tightens an existing directory to mode `0700`, and refuses an
  existing non-directory root. First-use root and bundle metadata are synced in publication order;
  failed publication is unpublished when cleanup succeeds.
- Native close and cleanup failures are preserved in diagnostics, including contention and retry
  paths. Cleanup is attempted; the package does not guarantee every native close succeeds.
- Lock waits are cooperative and asynchronous for create operations. Timeouts are bounded to
  integer milliseconds from 0 through 2,147,483,647, and damaged multiply-linked lock files are
  refused before repair.
- Restore preparation classifies damaged READY bundles and refuses targets whose resolved spelling
  aliases the live database or its sidecars.
- Retention counts READY markers without verifying bundle contents. Verification connections do not
  load application-only SQL functions, collations or extensions; a bundle is refused only when
  their absence prevents verification. Idle server processes are not detected: EXCLUSIVE locking
  blocks conflicting work but does not prevent another process from opening a handle. No blanket
  power-loss guarantee is made.
- Deadline checks, child-process fixture readiness and benchmark cleanup now follow their actual
  process lifecycles. The release gate builds and packs the candidate, then installs that archive in
  a consumer fixture and exercises its exports, types, configure flow, provider and commands.

## 0.2.0 - 2026-11-13

- `db:upgrade` ace command: a verified snapshot of an existing database, then `migration:run`.
  The snapshot goes to `pre-migration` under the configured backup directory, or to
  `<database>.backups`; `preMigrationBackupDirectory` returns that path.
- `operatorDatabasePath` and `withOperatorDatabase` for stopped-server operator commands, with the
  `NativeDatabase` type.
- `syncPath` is exported.

## 0.1.0 - 2026-11-08

First release.

- `db:backup create|list|verify|restore-prepare|prune` ace command, a `sqlite.backup` service and
  `node ace configure` (writes `config/backup.ts`, registers the provider and command).
- Immutable bundles: online copy, full `integrity_check` and `foreign_key_check`, SHA-256 manifest,
  `READY` written last. Optional migration-journal metadata, checked on verify and restore.
- Backups through an already-open better-sqlite3 handle, which is never closed by the package.
- Prepare-only restore: stages and verifies a copy, never replaces the live database.
- Prune keeps the newest N READY bundles and removes unfinished ones, under a SQLite directory lock.
- Private backup roots (`0700`), a disabled configuration, `--directory` recovery overrides and a
  `BackupException` with six codes.
