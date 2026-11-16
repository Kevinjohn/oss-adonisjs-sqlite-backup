# Changelog

## Unreleased

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
