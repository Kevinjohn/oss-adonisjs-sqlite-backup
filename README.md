# SQLite backup for AdonisJS

> Pre-release. Installed from GitHub releases; not published to npm.

Verified, immutable backup bundles of a Lucid SQLite database, and a prepare-only restore that
stages a checked copy without touching the live file.

## Install

Each release lists its archive's SHA-256.

```sh
pnpm add https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/releases/download/v0.5.0/kevinjohn-adonisjs-sqlite-backup-0.5.0.tgz
node ace configure @kevinjohn/adonisjs-sqlite-backup
```

The Ace `configure` command requires `@adonisjs/assembler` in the host application for its
codemods. It writes `config/backup.ts` and adds the provider and the package's Ace command loader
(`db:backup` and `db:upgrade`) to `adonisrc.ts`. A plain rerun preserves an existing config and avoids
duplicate registrations. Current source builds also register `@adonisjs/lucid/commands` for schema
generation after `db:upgrade`. When using the v0.5.0 archive above, register the Lucid loader in
`adonisrc.ts` if it is missing and you use schema generation.
The live database path comes from the Lucid connection in `config/database.ts`.

## Service and configuration

`defineConfig({ directory: undefined })` and an empty directory disable configured operations.
The provider still boots; service operations without a recovery directory fail with
`E_BACKUP_DISABLED`. Retention defaults to seven READY bundles.
The directory lock timeout (`lockTimeoutMs`) defaults to 0 and accepts integer milliseconds from
0 through 2,147,483,647. Prune reports `E_BACKUP_LOCKED` immediately if a backup lock on the
same event loop is already held. It can wait up to the timeout for a lock held in another process.

When configured backups are enabled, call `backup.checkSource()` and `backup.prepareDirectory()`
once at application startup before scheduling `backup.create()` followed by `backup.prune()`.
When they are disabled, those calls throw `E_BACKUP_DISABLED`, so the startup example below checks
the resolved `backup.config.directory` first. `backup.prepareDirectory()` refuses a root that
contains the configured live SQLite database with `E_BACKUP_UNSAFE`, before creating or changing
anything. Otherwise preparation creates missing directories and tightens an existing directory to
mode `0700`; an existing non-directory root is refused. The standalone `archive.prepareDirectory()`
uses the path supplied when constructing the archive. The manual `db:backup create` command checks source-layout eligibility before preparing its root. Create
and prune never recreate a missing root. A vanished root is
`E_BACKUP_NOT_FOUND`, as is listing a missing root. An existing empty root lists as `[]`.
If prune fails while syncing the archive or releasing its lock, the command exits nonzero and
reports the removals it observed and any per-bundle errors. A failed archive sync leaves removal
durability unconfirmed. Programmatic callers can read the same details from the error's
`pruneProgress` property.

Starting with v0.4.0, a booted application can import the same singleton as the `sqlite.backup`
container binding from the service entry point:

```ts
import backup from '@kevinjohn/adonisjs-sqlite-backup/services/main'

// An empty or omitted directory disables configured backups: skip startup work, not errors.
if (backup.config.directory) {
  backup.checkSource()
  backup.prepareDirectory()
  // Schedule backup.create() followed by backup.prune() here.
}
```

`backup.livePath()` returns the resolved live database path. Call it on the default service from
`@kevinjohn/adonisjs-sqlite-backup/services/main`, or on an instance of `SqliteBackup` exported from
`@kevinjohn/adonisjs-sqlite-backup`. It requires a non-empty backup directory in the service
configuration and throws `E_BACKUP_DISABLED` before looking up the source if the directory is
absent or empty. It reads Lucid's connection configuration on each call, using the `connection`
setting from `config/backup.ts` when set and Lucid's default connection otherwise. An unconfigured
connection, a client other than `better-sqlite3`, `sqlite3` or `sqlite`, or a missing, non-string,
empty, in-memory or URI filename throws AdonisJS’s `InvalidArgumentsException`. The resolved file
may be missing. Use `backup.checkSource()` to check that SQLite can open and read it.

With backups disabled, the application still boots and `list`, `verify` and `prepareRestore`
read a recovery directory passed explicitly. With backups enabled, an unreadable source or an
unsafe root still throws from `checkSource()` or `prepareDirectory()` and stops startup.
Do not run those calls before the application has booted. The root entry point and standalone
utilities do not require a booted AdonisJS application. `defineConfig` checks that a supplied
`connection` is a non-blank string, `directory` is a string (empty disables configured operations),
and `requireWal` is boolean. Invalid settings throw AdonisJS's
`InvalidArgumentsException`. Resolving the service without `config/backup.ts` throws AdonisJS's
`RuntimeException` and includes the configure command.

Configured preparation and prune refuse a root containing the configured live SQLite path. For standalone prune,
provide an archive directory that does not contain a live database.
Create, prune and restore preparation refuse roots writable by group or others with
`E_BACKUP_UNSAFE`. The manual `db:backup create` command prepares its root before creating a bundle.

The examples below use the standalone classes in the unreleased source. For the published
0.5.0 API, see the [README at v0.5.0](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/blob/v0.5.0/README.md).

Standalone hosts can select an archive directly with `BackupArchive`. Create accepts exactly one
of `livePath` or `source: { database }`, a better-sqlite3 handle. Borrowed handles stay open on
success and failure, including when the caller holds the source database exclusively. The
configured service also accepts `backup.create({ database })`.

```ts
import { BackupArchive } from '@kevinjohn/adonisjs-sqlite-backup'

const archive = new BackupArchive('storage/backups')
const livePath = 'storage/orchard.sqlite'
archive.prepareDirectory()
const bundle = await archive.create({ livePath })
archive.verify(bundle.name)
const staged = archive.prepareRestore({
  livePath,
  name: bundle.name,
  target: 'storage/recovered.sqlite',
})
```

Use `archive.acquireLock(timeoutMs)` to coordinate host work with package backup operations. The caller must provide an existing private directory on a
local filesystem and keep its ancestors writable only by trusted users or sticky, as described
under Limits. The method assumes the directory is already private. Keep the returned lock object
referenced until `release()`. The `.backup.lock` file contains no application data. Damaged-lock
repair refuses multiply linked files before truncation; do not create hard-link aliases to it.

Filesystem paths are resolved segment by segment, so `..` follows symlink targets. Package-owned
source connections and restore targets are refused if the native SQLite driver changes the selected
filename spelling; this does not promise support for every kernel filename form. Borrowed
better-sqlite3 handles remain supported and are not closed by the package.

When the source has a migration journal, the complete rows captured immediately before copying
must match the copy. The backup reads SQLite through a single SQLite read snapshot.
`archive.create()` defaults to `migrationsTable: 'adonis_schema'`; the service
uses the selected Lucid connection's `migrations.tableName` when supplied. The optional format-1
manifest field `migrations: { table, count, last }` records the journal's row count and last name.
Verify and restore preparation check that metadata against the copy. Databases without the table
keep their manifests free of this field.

Verification uses package-opened SQLite connections. Functions, collations or extensions
registered only on the application's connection are not available to those connections. A schema
that depends on them may fail verification when the missing feature is exercised; in that case the
package refuses to publish the bundle. The package has no initialiser hook for registering
connection-local SQL features on its verification connections.

`archive.list()` returns `{ name, path, createdAt }`, with ISO creation time read from the manifest.
Name order remains creation order even after a backward clock step; take the maximum `createdAt`
for the newest recorded clock time. Concurrently removed publications are skipped. A READY bundle
with an unreadable manifest is `E_BACKUP_INVALID` and names the bundle.
Listing checks the creation metadata without reading or hashing the database; verify and restore
preparation check the expected size and hash against the bytes. The READY marker, manifest and
database members must be regular files for recovery. A missing `sourceJournalMode` in an imported
format-1 manifest is tolerated for compatibility; it is not used to establish recovery integrity.

## Commands

Pass the `operation` argument first to the `db:backup` Ace command.

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
`create` and `prune` always use the configured directory. A flag given with an operation that does
not read it, such as `prune --bundle`, is refused.

## Upgrading a database

The `db:upgrade` Ace command (`node ace db:upgrade`) creates a verified pre-migration backup bundle
of the primary connection's database, then runs the pending migrations with Lucid's migration
runner, as `migration:run --force` would. Schema generation uses the Lucid command loader
registered during [setup](#install).

- The command resolves the configured backup directory and appends `pre-migration`. With an
  omitted or empty directory, it resolves the database path and appends `.backups`. It checks the
  layout, prepares the destination and writes the pre-migration backup bundle there.
- `db:backup prune` scans the immediate bundle directories in the configured archive root after
  resolving symlinks. A distinct `pre-migration` child directory is outside that scan. If
  `pre-migration` is a symlink to the archive root, the bundles written through it are subject to
  retention. Bundles written to the fallback `<database>.backups` are also subject to retention
  if you later configure that directory as the archive root.
- The bundle records the primary connection's migrations table and follows the backup config's
  `lockTimeoutMs` and `requireWal`, like `db:backup create`.
- A database with no row of type `table` in `sqlite_master`, or an in-memory database, is migrated
  without a pre-migration backup bundle. Views or SQLite header metadata alone do not meet the table condition.
- If the bundle cannot be written, nothing is migrated and the command exits 1 with
  `Upgrade failed: …`. If a migration fails, the command reports it as one `Upgrade failed: …`
  line without a stack trace, exits 1 and keeps the migration error in `error` for a calling
  command. A caller that reports its own failure line would print it twice.
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

`OperatorDatabase` supports commands that need exclusive access to the database.

The operator must actually stop the server before running these commands. Confirmation is an
operator precondition, not an automatic server-status probe; the exclusive-lock acquisition checks
database contention separately.

- `operator.databasePath(confirmServerStopped)` checks preconditions before the command opens a connection. It requires operator
  confirmation, a Lucid primary connection configured with `better-sqlite3` and `pool.max: 1`, and
  an existing regular database file. It returns the configured filename with surrounding whitespace
  trimmed, preserving relative paths. Missing, non-string or empty filenames, `:memory:`, `file:`
  URI filenames and paths ending in a symlink are refused. The corresponding diagnostics are
  `Refusing without --confirm-server-stopped`,
  `Operator commands require the configured single-connection SQLite pool` and
  `Operator commands require an existing on-disk database`.
- `operator.run(work)` keeps the primary pool's only handle checked out in EXCLUSIVE
  locking mode through `work(connection)`, then attempts to close every managed connection. Lucid
  queries and transactions on the primary connection borrow that handle in sequence. An overlapping
  call on the same `Database` is refused before taking cleanup ownership. Actual `SQLITE_BUSY`
  contention while taking the lock throws
  `Another process holds this database; stop the server and retry`; an idle open connection alone
  does not imply contention or prove that a server is running. Failed cleanup is reported, including
  lifecycle failures emitted by Lucid and the pool. When work and cleanup both fail, an
  `AggregateError` preserves the failures in order. The callback must finish its transactions and
  leave the borrowed handle open.

```ts
import db from '@adonisjs/lucid/services/db'
import { OperatorDatabase } from '@kevinjohn/adonisjs-sqlite-backup'

const operator = new OperatorDatabase(db)
operator.databasePath(this.confirmServerStopped)
await operator.run(async () => {
  await db.from('heroes').where('name', 'Clark Kent').update({ alias: 'Superman' })
})
```

See [standalone API adoption](DECISIONS.md#updating-callers) for previous export names and their replacements.

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

Import the `errors` namespace to recognise an expected backup failure by class or by its
stable `code`. Each backup exception has status 500.

```ts
import { errors } from '@kevinjohn/adonisjs-sqlite-backup'
import backup from '@kevinjohn/adonisjs-sqlite-backup/services/main'

try {
  await backup.create()
} catch (error) {
  if (!(error instanceof errors.E_BACKUP_LOCKED)) throw error
  // Another operation holds the backup directory lock. Retry later.
}
```

| Exception                   | When it is thrown                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `errors.E_BACKUP_LOCKED`    | Another process or an earlier operation on the same event loop holds the lock.               |
| `errors.E_BACKUP_SOURCE`    | The SQLite database is unavailable or fails an operation’s source check.                     |
| `errors.E_BACKUP_INVALID`   | A bundle or copy failed verification.                                                        |
| `errors.E_BACKUP_WRITE`     | A file write made no progress before bundle publication.                                     |
| `errors.E_BACKUP_UNSAFE`    | A path, layout, or operation failed a safety check. A write may already have been attempted. |
| `errors.E_BACKUP_NOT_FOUND` | The backup directory or selected bundle is missing.                                          |
| `errors.E_BACKUP_DISABLED`  | Backups are disabled. Pass an explicit directory for recovery reads.                         |

Invalid Lucid source settings and invalid API arguments such as a negative lock timeout or a
retention count below one throw AdonisJS’s `InvalidArgumentsException`. Unexpected system errors
such as a full disk can propagate as native errors. A backup exception includes the underlying
error as its `cause` when it wraps one.

If create fails and removing its unfinished bundle also fails, the original `Error` is rethrown
with the cleanup failure on its `cleanupError` property. The command prints the original failure
and a separate cleanup-failure line, then exits 1. An unfinished bundle is never a recovery point;
a later successful prune removes it. Restore preparation attaches `cleanupError` in the same way
when it cannot remove the staged file it created. If lock acquisition and native close both
fail, Ace reports the acquisition failure first and the close separately. An acquisition
`Error` retains its identity and carries the close failure in `resourceCleanupErrors`. If
acquisition throws a non-`Error` value, the resulting `AggregateError` holds both original
values in order.

Stopped-server operator helpers report these preconditions and failures:

- `operator.databasePath()` throws `InvalidArgumentsException` when confirmation is missing or the
  primary connection is incompatible. An unavailable on-disk database throws
  `errors.E_BACKUP_SOURCE`.
- `operator.run()` throws `RuntimeException` for an overlapping call on the same
  `Database` or an inconsistent pool state. When exclusive acquisition meets `SQLITE_BUSY`, it
  throws `errors.E_BACKUP_LOCKED` with the native error as `cause` and advises stopping the server
  before retrying. Other lock setup errors retain their native type.
- A single failure, from the lock, the work or cleanup, is thrown unchanged. When more than one
  occurs, an `AggregateError` (`Operator database cleanup failed`) lists the lock or work failure
  first, then cleanup failures in the order they were observed.

## Supported versions

Requires Node.js 24+, AdonisJS 7, Lucid 22 and better-sqlite3 13.

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

See the [source-reviewed user story catalogue](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/blob/main/user-stories/README.md) for capability coverage and code-backed operation flows.
