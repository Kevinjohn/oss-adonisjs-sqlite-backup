# Capability coverage

Inventory covers Ace commands, public service and standalone functions, configuration, provider setup, filesystem and database operations, examples, tests and README limitations. “New” means newly documented, not new functionality.

| Story                                                   | Action                                                                             | Access               | Status   | Catalogue |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- | -------- | --------- |
| [US-SETUP-01](setup/us-setup-01-configure-backups.md)   | Configure Lucid source, private root, keep count, lock timeout and WAL requirement | Application operator | Operator | New       |
| [US-OP-01](create-bundle/us-op-01-create-bundle.md)     | Copy live SQLite source, check database and migration journal, publish READY last  | Host operator        | Operator | New       |
| [US-OP-02](list-bundles/us-op-02-list-bundles.md)       | List READY bundle names oldest first                                               | Host operator        | Operator | New       |
| [US-OP-03](verify-bundle/us-op-03-verify-bundle.md)     | Verify manifest, size, SHA-256, integrity, foreign keys and migration metadata     | Host operator        | Operator | New       |
| [US-OP-04](prepare-restore/us-op-04-prepare-restore.md) | Exclusively stage and verify a copy; leave live database switching to operator     | Host operator        | Operator | New       |
| [US-OP-05](prune-bundles/us-op-05-prune-bundles.md)     | Retain newest READY bundles and remove older/unfinished matching directories       | Host operator        | Operator | New       |

The service exposes matching methods through `SqliteBackup`; standalone hosts can use `prepareDirectory`, `createBundle`, `listBundles`, `verifyBundle`, `pruneBundles` and `prepareRestore`. See [source map](REFERENCE.md).
