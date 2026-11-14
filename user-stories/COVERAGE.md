# Capability coverage

Inventory covers Ace commands (`db:backup` and `db:upgrade`), public service and standalone functions, configuration, provider setup, filesystem and database operations, examples, tests and README limitations. “New” means newly documented, not new functionality.

| Story                                                                   | Action                                                                                          | Access               | Status   | Catalogue |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------- | -------- | --------- |
| [US-SETUP-01](setup/us-setup-01-configure-backups.md)                   | Configure Lucid source, private root, keep count, lock timeout and WAL requirement              | Application operator | Operator | New       |
| [US-OP-01](create-bundle/us-op-01-create-bundle.md)                     | Copy live SQLite source, check database and migration journal, publish READY last               | Host operator        | Operator | New       |
| [US-OP-02](list-bundles/us-op-02-list-bundles.md)                       | List READY bundle names oldest first                                                            | Host operator        | Operator | New       |
| [US-OP-03](verify-bundle/us-op-03-verify-bundle.md)                     | Verify manifest, size, SHA-256, integrity, foreign keys and migration metadata                  | Host operator        | Operator | New       |
| [US-OP-04](prepare-restore/us-op-04-prepare-restore.md)                 | Exclusively stage and verify a copy; leave live database switching to operator                  | Host operator        | Operator | New       |
| [US-OP-05](prune-bundles/us-op-05-prune-bundles.md)                     | Retain newest READY bundles and remove older/unfinished matching directories                    | Host operator        | Operator | New       |     | [US-OP-06](upgrade-database/us-op-06-upgrade-database.md) | Snapshot a non-empty on-disk database to `pre-migration` or `<db>.backups`, then run `migration:run --force` | Host operator | Operator | New |
| [US-OP-07](operator-guards/us-op-07-stopped-server-operator-command.md) | Refuse unless the server is stopped, take an EXCLUSIVE lock and close the pool on every outcome | Host operator        | Operator | New       |

The service exposes matching methods through `SqliteBackup`; standalone hosts can use `prepareDirectory`, `createBundle`, `listBundles`, `verifyBundle`, `pruneBundles` and `prepareRestore`. Other exports: `acquireLock` and `resolveSqliteSource` (create internals, no separate story), `syncPath` (fsync helper, covered with US-OP-07), `preMigrationBackupDirectory` (US-OP-06), and `operatorDatabasePath` and `withOperatorDatabase` (US-OP-07). See [source map](REFERENCE.md).
