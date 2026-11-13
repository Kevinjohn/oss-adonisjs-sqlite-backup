# Changelog

## Unreleased

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
