# Changelog

## Unreleased

## 0.4.3 - 2026-11-24

- `db:upgrade` reports a failed migration as one `Upgrade failed: …` line, without a stack trace,
  and still exits 1 with the migration error in `error`. It runs the pending migrations with
  Lucid's migration runner instead of a nested `migration:run`, whose own failure output Ace
  printed with the stack, once from each command. Migrated files are listed as `❯ migrated <file>`,
  a failed one as `❯ error <file>`, and a database with nothing pending as `Already up to date`.
  A calling command should not report the copied `error` again; the README example does not.

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
