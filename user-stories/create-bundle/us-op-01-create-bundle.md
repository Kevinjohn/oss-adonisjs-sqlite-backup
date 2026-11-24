# US-OP-01 — Create a verified backup bundle

As a host operator, I want to create a verified backup bundle from the configured Lucid SQLite database so that I have a checked recovery point.

**Status:** Operator; current Ace command and service operation.
**Access:** Host operator with a readable live database and private configured backup root.
**Entry:** `node ace db:backup create`; run as an operator task, not in a web request.
**Documentation:** [Command behaviour](../../README.md#commands), [service and configuration](../../README.md#service-and-configuration).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.create](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts).
**Coverage:** [Create tests](../../tests/create.spec.ts), [durability tests](../../tests/durability.spec.ts).

## Acceptance criteria

- `DbBackup.run` checks the source/root layout before preparing the configured root and calls `SqliteBackup.create()`, which resolves the configured live path, selected migration table, lock timeout and WAL requirement.
- `createBundle()` validates private directory/source layout and takes the cooperative `.backup.lock` for creation and publication. Resource-cleanup failure can trigger bundle cleanup after the lock-release attempt. It relies on trusted archive parents and cooperating writers. It refuses a borrowed handle with an open transaction; a borrowed handle stays open afterward.
- The copy is made using SQLite backup, journal and migration metadata are checked, `readDatabaseIntegrityProblem()` runs full integrity and foreign-key checks, and a read-only database file plus manifest are written before READY is durably written last.
- Verification uses package-opened SQLite connections. SQL functions, collations or extensions registered only on the application's connection are not registered on those handles. A schema that depends on them, such as an expression index using an application-registered function, may fail verification; create fails closed and does not publish the bundle. There is no connection initialiser hook.
- The existing source journal mode is read, not changed. A non-WAL source produces a warning unless `requireWal` makes it a refusal. The backup copy is checkpointed and normalised to `journal_mode=DELETE`. A failed create cleans up its unfinished bundle where possible and exits nonzero. If cleanup fails, inspect the cleanup error and the archive before retrying. A bundle may remain visible if its READY marker could not be removed.
- Create is refused with `E_BACKUP_LOCKED` when another run holds `.backup.lock` for longer than `lockTimeoutMs`, and with `E_BACKUP_UNSAFE` when the newest existing bundle is dated more than 24 hours after the clock; the operator fixes the clock or moves that bundle, then retries.
- `create` uses only configured backup directory; `--directory` is invalid for this operation.

- Create compares every ordered row of the source migration journal with the copy. A missing journal omits migration metadata. Unsupported metadata prevents publication. [Adoption scenarios](../../tests/adoption.spec.ts)

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup create"] --> P["Check source/root layout"]
    P --> B["Prepare configured private backup root"]
    B --> C["Acquire lock and open configured live SQLite source"]
    C -->|Lock busy past lockTimeoutMs| X["Refuse E_BACKUP_LOCKED; retry later"]
    C --> O{"Source readable and idle?"}
    O -->|No| F
    O -->|Yes| J{"Existing source mode is WAL?"}
    J -->|No and requireWal| K["Refuse; operator resolves source configuration"]
    J -->|No and allowed| L["Continue without changing source journal mode"]
    L --> Y{"Newest bundle dated over 24 h ahead of clock?"}
    J -->|Yes| Y
    Y -->|Yes| Z["Refuse E_BACKUP_UNSAFE; fix clock or move that bundle"]
    Y -->|No| D["Copy, normalise copy to DELETE, verify and write manifest"]
    D --> E{"All checks pass?"}
    E -->|No| F["Report failure"]
    E -->|Yes| G["Write READY last, sync and finish resource cleanup"]
    G -->|Success| H["Report warnings and bundle path"]
    G -->|Failure| F
    F --> T{"READY absent or removed?"}
    T -->|Yes| U["No bundle published"]
    T -->|No or unknown| V["Inspect cleanup error and archive before retrying; bundle may still be listed"]
```

## Code flow

Scope: Ace create operation through publication, failure cleanup and lock release. `assertDirectory`, `assertSafeLayout` and `acquireCreateLock` failures happen before the lock-owning `try/finally`, so a lock that was never acquired is not released.

```mermaid
flowchart TD
    A["DbBackup.run create case"] --> A1["assertSafeLayout before preparing the root"]
    A1 --> B["SqliteBackup.prepareDirectory"]
    B --> C["SqliteBackup.create"]
    C --> D["resolveSqliteSource and createBundle"]
    D --> E["assertDirectory, assertSafeLayout, await acquireCreateLock"]
    E -->|Lock busy past lockTimeoutMs| W["Throw E_BACKUP_LOCKED"]
    E -->|Lock acquired| O["Open source and read journal_mode"]
    O --> O1{"Source readable and not in transaction?"}
    O1 -->|No| K
    O1 -->|Yes| J{"Non-WAL?"}
    J -->|"Non-WAL and requireWal"| K["Throw E_BACKUP_SOURCE"]
    J -->|"Non-WAL and allowed"| L["Add warning without changing source"]
    J -->|"No, source is WAL"| Q{"Newest bundle over MAX_FUTURE_MS ahead of clock?"}
    L --> Q
    Q -->|Yes| R["Throw E_BACKUP_UNSAFE"]
    Q -->|No| S["mkdir bundle directory; this call now owns it"]
    S --> N["Sync archive and read source migration rows"]
    N --> F["NativeDatabase.backup to db.sqlite"]
    F --> M["Checkpoint copy; set copy journal_mode DELETE"]
    M --> G["Remove copy sidecars; verify copied migration rows and readDatabaseIntegrityProblem"]
    G --> H["chmod 0400 and sync; hash file, validate metadata, write manifest then READY and sync"]
    H --> I["Record result"]
    K --> V["Catch: remove READY then owned bundle if created"]
    R --> V
    S -->|failure| V
    N -->|failure| V
    F -->|failure| V
    M -->|failure| V
    G -->|failure| V
    H -->|failure| V
    V --> U["Record primary error and any cleanupError; failed READY removal can leave the bundle visible"]
    I --> T["Finally: attempt owned source close and lock.release independently"]
    U --> T
    T --> T1{"Primary or resource cleanup failure?"}
    T1 -->|Primary failure| T2["Throw primary error with resource cleanup diagnostics"]
    T1 -->|Cleanup only| T3["Attempt unpublication and owned bundle removal; throw failure and attach any cleanupError"]
    T1 -->|Neither| T4["Return result"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts), [durability tests](../../tests/durability.spec.ts).
