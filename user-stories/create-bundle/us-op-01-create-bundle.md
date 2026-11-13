# US-OP-01 — Create a verified backup bundle

As a host operator, I want to create an immutable backup bundle from the configured Lucid SQLite database so that I have a checked recovery point.

**Status:** Operator; current Ace command and service operation.
**Access:** Host operator with a readable live database and private configured backup root.
**Entry:** `node ace db:backup create`; run as an operator task, not in a web request.
**Documentation:** [Command behavior](../../README.md#commands), [service and configuration](../../README.md#service-and-configuration).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.create](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts).
**Coverage:** [Create tests](../../tests/create.spec.ts), [durability tests](../../tests/durability.spec.ts).

## Acceptance criteria

- `DbBackup.run` prepares the configured root and calls `SqliteBackup.create()`, which resolves the configured live path, selected migration table, lock timeout and WAL requirement.
- `createBundle()` validates private directory/source layout and holds `.backup.lock` for its run. It refuses a borrowed handle with an open transaction; a borrowed handle stays open afterward.
- The copy is made using SQLite backup, journal and migration metadata are checked, `checkDatabase()` runs full integrity and foreign-key checks, and a read-only database file plus manifest are written before READY is durably written last.
- The existing source journal mode is read, not changed. A non-WAL source produces a warning unless `requireWal` makes it a refusal. The backup copy is checkpointed and normalized to `journal_mode=DELETE`. A failed create cleans up its unfinished bundle where possible and exits nonzero; cleanup failure is separately reported.
- `create` uses only configured backup directory; `--directory` is invalid for this action.

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup create"] --> B["Prepare configured private backup root"]
    B --> C["Open configured live SQLite source and acquire lock"]
    C --> J{"Existing source mode is WAL?"}
    J -->|No and requireWal| K["Refuse; operator resolves source configuration"]
    J -->|No and allowed| L["Continue without changing source journal mode"]
    J -->|Yes| D["Copy, normalize copy to DELETE, verify and write manifest"]
    L --> D
    D --> E{"All checks pass?"}
    E -->|No| F["Report failure; unfinished bundle is not published"]
    E -->|Yes| G["Write READY last; report queued non-WAL warning if any and bundle path"]
```

## Code flow

Scope: Ace create action through publication and lock release.

```mermaid
flowchart TD
    A["DbBackup.run create case"] --> B["SqliteBackup.prepareDirectory"]
    B --> C["SqliteBackup.create"]
    C --> D["resolveSqliteSource and createBundle"]
    D --> E["assertDirectory, assertSafeLayout, acquireLock"]
    E --> J{"Read source journal_mode; non-WAL?"}
    J -->|Yes and requireWal| K["Throw E_BACKUP_SOURCE"]
    J -->|Yes and allowed| L["Add warning without changing source"]
    J -->|No| N["Read source migrationRows"]
    L --> N
    N --> F["NativeDatabase.backup to db.sqlite"]
    F --> M["Checkpoint copy; set copy journal_mode DELETE"]
    M --> G["Verify copied migrationRows; checkDatabase and sha256File"]
    G --> H["writeDurable manifest then READY"]
    H --> I["Return result; close owned source and release lock"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts), [durability tests](../../tests/durability.spec.ts).
