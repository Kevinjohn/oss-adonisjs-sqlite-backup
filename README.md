# SQLite backup for AdonisJS

> Pre-release. Installed from GitHub releases; not published to npm.

Verified, immutable backup bundles of a Lucid SQLite database, and a prepare-only restore that
stages a checked copy without touching the live file.

## Install

Requires Node.js 24+, AdonisJS 7, Lucid 22 and better-sqlite3 13. Each release lists its
archive's SHA-256.

```sh
pnpm add https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/releases/download/v0.3.2/kevinjohn-adonisjs-sqlite-backup-0.3.2.tgz
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

Prune counts READY markers; it does not verify each bundle's database. READY means published, not
that the bundle remains readable or recoverable. Before pruning, verify recovery points with
`db:backup verify` and retain a separate known-good copy until the recovery point you intend to
keep has passed verification. A damaged READY bundle still counts toward `--keep` and can displace
an older usable bundle from retention.

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
The directory lock timeout (`lockTimeoutMs`) defaults to 0 and accepts integer milliseconds from
0 through 2,147,483,647. Prune reports `E_BACKUP_LOCKED` immediately if a backup lock on the
same event loop is already held. It can wait up to the timeout for a lock held in another process.

At application startup, call `backup.checkSource()` and `backup.prepareDirectory()` once before
scheduling `backup.create()` followed by `backup.prune()`. Preparation creates missing directories
and tightens an existing directory to mode `0700`; an existing non-directory root is refused. The
manual `db:backup create` command checks source-layout eligibility before preparing its root. Create
and prune never recreate a missing root. A vanished root is
`E_BACKUP_NOT_FOUND`, as is listing a missing root. An existing empty root lists as `[]`.
If prune fails while syncing the archive or releasing its lock, the command exits nonzero and
reports the removals it observed and any per-bundle errors. A failed archive sync leaves removal
durability unconfirmed. Programmatic callers can read the same details from the error's
`pruneProgress` property.

Configured prune refuses a root containing the configured live SQLite path. For standalone prune,
provide an archive directory that does not contain a live database.
Create, prune and restore preparation refuse roots writable by group or others with
`E_BACKUP_UNSAFE`. The manual `db:backup create` command prepares its root before creating a bundle.

Standalone hosts can import `prepareDirectory(path)`, `createBundle`, `listBundles`,
`verifyBundle`, `pruneBundles` and `prepareRestore`. `createBundle` accepts either `livePath` or
`source: { database }`, a better-sqlite3 handle. The latter works while an operator holds an
exclusive lock. Borrowed handles remain open on success and failure; the package closes only
handles it opens. The service also accepts `backup.create({ database })`.

Standalone callers can also import `acquireLock(directory, timeoutMs)` to coordinate their own
work with package backup operations. The caller must provide an existing private directory on a
local filesystem and keep its ancestors writable only by trusted users or sticky, as described
under Limits. The direct function does not check root privacy. Keep the returned lock object
referenced until `release()`. The `.backup.lock` file contains no application data. Damaged-lock
repair refuses multiply linked files before truncation; do not create hard-link aliases to it.

Filesystem paths are resolved segment by segment, so `..` follows symlink targets. Package-owned
source connections and restore targets are refused if the native SQLite driver changes the selected
filename spelling; this does not promise support for every kernel filename form. Borrowed
better-sqlite3 handles remain supported and are not closed by the package.

When the source has a migration journal, the complete rows captured immediately before copying
must match the copy. `createBundle` defaults to `migrationsTable: 'adonis_schema'`; the service
uses the selected Lucid connection's `migrations.tableName` when supplied. The optional format-1
manifest field `migrations: { table, count, last }` records the journal's row count and last name.
Verify and restore preparation check that metadata against the copy. Databases without the table
keep their manifests free of this field.

Verification uses package-opened SQLite connections. Functions, collations or extensions
registered only on the application's connection are not available to those connections. A schema
that depends on them may fail verification when the missing feature is exercised; in that case the
package refuses to publish the bundle. The package has no initializer hook for registering
connection-local SQL features on its verification connections.

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
- The snapshot records the primary connection's migrations table and follows the backup config's
  `lockTimeoutMs` and `requireWal`, like `db:backup create`.
- A database with no row of type `table` in `sqlite_master`, or an in-memory database, is migrated
  without a snapshot. Views or SQLite header metadata alone do not meet the table condition.
- If the snapshot cannot be written, nothing is migrated and the command exits 1 with
  `Upgrade failed: …`. If a migration fails, the command exits with `migration:run`'s code.
- The primary connection must use `better-sqlite3`.
- Schema classes are generated with `schema:generate` only after every migration succeeds, and not
  in production. `--no-schema-generate` skips them.

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
- `withOperatorDatabase(db, work)` keeps the primary pool's only handle checked out in EXCLUSIVE
  locking mode through `work(connection)`, then attempts to close every managed connection. Lucid
  queries and transactions on the primary connection borrow that handle in sequence. An overlapping
  call on the same `Database` is refused before taking cleanup ownership. Actual `SQLITE_BUSY`
  contention while taking the lock throws
  `Another process holds this database; stop the server and retry`; an idle open connection alone
  does not imply contention or prove that a server is running. Failed cleanup is reported, including
  lifecycle failures emitted by Lucid and the pool. When work and cleanup both fail, an
  `AggregateError` preserves the failures in order. The callback must finish its transactions and
  leave the borrowed handle open.
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

If the process is interrupted after the copy creates the target but before `restore-prepare`
returns, the target may remain incomplete or unverified. Its existence does not show that
verification finished. Inspect and remove only that chosen target before retrying; the retry
refuses an existing target. The bundle remains the recovery source.

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

## User story catalogue

See the [source-reviewed user story catalogue](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/blob/main/user-stories/README.md) for capability coverage and code-backed action flows.
