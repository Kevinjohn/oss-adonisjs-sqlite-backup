# SQLite backup for AdonisJS

> Pre-release. Installed from GitHub releases; not published to npm.

Verified, immutable backup bundles of a Lucid SQLite database, and a prepare-only restore that
stages a checked copy without touching the live file.

## Install

Requires Node.js 24+, AdonisJS 7, Lucid 22 and better-sqlite3 13. Each release lists its
archive's SHA-256.

```sh
pnpm add https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/releases/download/v0.2.0/kevinjohn-adonisjs-sqlite-backup-0.2.0.tgz
node ace configure @kevinjohn/adonisjs-sqlite-backup
```

`configure` writes `config/backup.ts` and adds the provider and the `db:backup` command to
`adonisrc.ts`. The live database path comes from the Lucid connection in `config/database.ts`.

## Commands

| Command                                                            | What it does                                                                                     | Lock |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---- |
| `node ace db:backup create`                                        | Online copy, full `integrity_check` and `foreign_key_check`, manifest with SHA-256, then `READY` | yes  |
| `node ace db:backup list`                                          | Names of READY bundles, oldest first                                                             | no   |
| `node ace db:backup verify [--bundle name]`                        | Re-checks READY, size, SHA-256 and integrity of a bundle (default: newest)                       | no   |
| `node ace db:backup restore-prepare --target path [--bundle name]` | Copies a bundle to a new path and verifies the copy. Never replaces the live database            | no   |
| `node ace db:backup prune [--keep n]`                              | Keeps the newest `n` READY bundles (default: `keep` in config) and removes unfinished ones       | yes  |

A bundle is a real directory (never a symlink) named `bak-utc-YYYYMMDD-HHMMSS-mmm` with a valid
date, holding `db.sqlite`, `manifest.json` and `READY`, all read-only. Names only increase within
a directory, so name order is age order for prune. A clock step back of up to 24 h is absorbed;
if the newest bundle is dated more than 24 h after the clock, create refuses until the clock or
the bundle is fixed. `manifest.createdAt` is the real clock time.

`list`, `verify` and `restore-prepare` accept `--directory <path>` to read another backup
root. This overrides the configured directory and works even when scheduled backups are disabled.
`create` and `prune` always use the configured directory. A flag given with an action that does
not read it, such as `prune --bundle`, is refused.

## Service and configuration

`defineConfig({ directory: undefined })` and an empty directory disable configured operations.
The provider still boots; service operations without a recovery directory fail with
`E_BACKUP_DISABLED`. Retention defaults to seven READY bundles.

At application startup, call `backup.checkSource()` and `backup.prepareDirectory()` once before
scheduling `backup.create()` followed by `backup.prune()`. Preparation creates or tightens the root
to mode `0700`; create and prune never recreate a missing root. A vanished root is
`E_BACKUP_NOT_FOUND`, as is listing a missing root. An existing empty root lists as `[]`.
Create, prune and restore preparation refuse roots writable by group or others with
`E_BACKUP_UNSAFE`. The manual `db:backup create` command prepares its root before creating a bundle.

Standalone hosts can import `prepareDirectory(path)`, `createBundle`, `listBundles`,
`verifyBundle`, `pruneBundles` and `prepareRestore`. `createBundle` accepts either `livePath` or
`source: { database }`, a better-sqlite3 handle. The latter works while an operator holds an
exclusive lock. Borrowed handles remain open on success and failure; the package closes only
handles it opens. The service also accepts `backup.create({ database })`.

When the source has a migration journal, the complete rows captured immediately before copying
must match the copy. `createBundle` defaults to `migrationsTable: 'adonis_schema'`; the service
uses the selected Lucid connection's `migrations.tableName` when supplied. The optional format-1
manifest field `migrations: { table, count, last }` records the journal's row count and last name.
Verify and restore preparation check that metadata against the copy. Databases without the table
keep their manifests free of this field.

`listBundles` returns `{ name, path, createdAt }`, with ISO creation time read from the manifest.
Name order remains creation order even after a backward clock step; take the maximum `createdAt`
for the newest recorded clock time. Concurrently removed publications are skipped. A READY bundle
with an unreadable manifest is `E_BACKUP_INVALID` and names the bundle.

## Upgrading a database

`node ace db:upgrade` takes a verified snapshot of the primary connection's database, then runs
`migration:run --force`. Register `@adonisjs/lucid/commands` as well as this package's commands.

- The snapshot goes to `pre-migration` under the configured backup directory, or to
  `<database>.backups` beside the database when no backup directory is configured. These bundles
  are outside `db:backup prune`. `preMigrationBackupDirectory(dbPath, configuredDirectory)` returns
  the same path.
- An empty or in-memory database is migrated without a snapshot.
- If the snapshot cannot be written, nothing is migrated and the command exits 1 with
  `Upgrade failed: …`. If a migration fails, the command exits with `migration:run`'s code.
- The primary connection must use `better-sqlite3`.
- `--no-schema-generate` is passed on to `migration:run`.

To add a check after migrating, run the command from your own:

```ts
const upgrade = await this.kernel.exec('db:upgrade', ['--no-schema-generate'])
if (upgrade.exitCode !== 0) {
  this.exitCode = upgrade.exitCode ?? 1
  return
}
```

## Stopped-server operator commands

Three exports support commands that must own the database while the server is stopped:

- `operatorDatabasePath(db, confirmServerStopped)` refuses unless the operator confirmed (for
  example with a `--confirm-server-stopped` flag), the primary connection is `better-sqlite3` with a
  pool of one, and the database is an existing file. It returns the file path.
- `withOperatorDatabase(db, work)` puts the pool's only handle in EXCLUSIVE locking mode, runs
  `work(connection)`, then closes every connection. Lucid queries inside `work` use that handle. If
  another process has the file open it throws
  `Another process holds this database; stop the server and retry`. The pool is closed after every
  outcome; when a cleanup step also fails, an `AggregateError` carries both failures.
- `syncPath(path)` fsyncs a file or directory.

```ts
import db from '@adonisjs/lucid/services/db'
import { operatorDatabasePath, withOperatorDatabase } from '@kevinjohn/adonisjs-sqlite-backup'

operatorDatabasePath(db, this.confirmServerStopped)
await withOperatorDatabase(db, async () => {
  await db.from('heroes').where('name', 'Clark Kent').update({ alias: 'Superman' })
})
```

## Restoring

`restore-prepare` refuses a target that is the live database or one of its reserved
`-wal`/`-shm`/`-journal` paths (symlinks followed, dangling ones included), already exists, has `-wal`/`-shm`/`-journal` sidecars, sits in a missing folder or
lies inside the backup folder. It stops at a verified copy. Switching the app to it is your decision: stop the
app, point the Lucid connection at the staged file (or move it into place), start the app and
check it. Keep the old file until you are satisfied.

## Errors

Expected failures are a `BackupException` with one of six codes: `E_BACKUP_LOCKED`,
`E_BACKUP_SOURCE`, `E_BACKUP_INVALID`, `E_BACKUP_UNSAFE`, `E_BACKUP_NOT_FOUND`,
`E_BACKUP_DISABLED`. Unexpected
system errors (permissions, a full disk) are passed through unchanged.

If create fails and removing its unfinished bundle also fails, the original `Error` is rethrown
with the cleanup failure on its `cleanupError` property. The command prints the original failure
and a separate cleanup-failure line, then exits 1. An unfinished bundle is never a recovery point;
a later successful prune removes it.

## Limits

- Keep every folder above the backup root writable only by trusted users, or sticky (like `/tmp`).
  The root's own permissions are checked, its parents' are not: a user who can rename a parent
  could swap the root for a symlink between the check and the write.
- The backup root must not contain the live database. Use a sibling or separate local directory.
  Lucid `file:` URI filenames and in-memory databases are refused; configure a plain filesystem path.

- Use WAL. With a rollback journal, writers in other processes wait for the whole copy; the
  command warns, or refuses with `requireWal: true`.
- The copy runs synchronously. Run it as `node ace db:backup`, not inside a web request.
- The lock is a SQLite lock on `.backup.lock`. It needs a local filesystem, not NFS. The lock
  file never holds data; a damaged one is emptied and reused.
- Linux is tested. Windows is not supported (directory fsync); `package.json` excludes it.
- `list` and `verify` take no lock. When prune removes the bundle being verified, verify of the
  newest bundle reports `E_BACKUP_NOT_FOUND`. A named bundle can instead report `E_BACKUP_INVALID`
  ("no READY marker") if prune unpublishes it in the short window right after it is selected.
- Paths (Lucid filename, backup folder, restore target) are resolved as the kernel and SQLite
  resolve them: `..` steps up from the real folder a symlink leads to, not from the text.
- `restore-prepare` re-checks the staged path after the copy and removes only the file it made,
  but a process that can rewrite the target's parent folder can still race it. Keep that folder
  writable only by trusted users.
- Run `restore-prepare` as a user who can traverse every folder on the live database's path.
  Paths are resolved by walking them; running it as another user who cannot is not supported.
