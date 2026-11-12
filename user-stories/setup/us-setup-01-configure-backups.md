# US-SETUP-01 — Configure and prepare backup operations

As an application operator, I want to configure the Lucid connection, private backup directory and retention behavior so that manual, scheduled and restore-preparation actions use a known source and root.

**Status:** Operator; current configure and service setup path.
**Access:** Application operator able to configure Lucid and manage local filesystem permissions.
**Entry:** `node ace configure @kevinjohn/adonisjs-sqlite-backup`, `config/backup.ts`, and app startup call to `checkSource()`/`prepareDirectory()`.
**Documentation:** [Install](../../README.md#install), [service and configuration](../../README.md#service-and-configuration).
**Source:** [configure](../../configure.ts), [provider](../../providers/sqlite_backup_provider.ts), [defineConfig](../../src/define_config.ts), [backup service](../../src/sqlite_backup.ts), [pruning](../../src/prune.ts), [directory preparation](../../src/directory.ts), [backup command](../../commands/db_backup.ts).
**Coverage:** [Configure tests](../../tests/configure.spec.ts), [config source tests](../../tests/config_source.spec.ts).

## Acceptance criteria

| Config key      | Control                   | Required/default/conditions                                                                                                             |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`     | `config/backup.ts` string | May be omitted/empty to disable configured operations; backup root must not contain the live database; a sibling backup folder is valid |
| `connection`    | Lucid connection name     | Optional; defaults to Lucid's configured connection; uses its source and migration table when available                                 |
| `keep`          | Integer                   | Defaults to 7; minimum 1                                                                                                                |
| `lockTimeoutMs` | Integer milliseconds      | Defaults to 0; minimum 0                                                                                                                |
| `requireWal`    | Boolean                   | Defaults to false; true refuses sources not in WAL mode                                                                                 |

- Ace configure writes config stub and registers provider plus `db:backup` command. Provider binds `sqlite.backup` from backup and Lucid config.
- `defineConfig` validates `keep` and `lockTimeoutMs`; absent directory disables configured service operations, while a read-only `--directory` override remains available to list/verify/restore-prepare.
- At host startup, `checkSource()` can fail fast without making a bundle; call `prepareDirectory()` once to create/tighten the root to `0700` before scheduling create then prune.
- Service calls to `create()` and `prune()` require an existing backup root and do not recreate a vanished one. The `db:backup create` command calls `prepareDirectory()` before `create()`; callers using the service directly must prepare the root themselves. Host owns scheduling and any later switch to a staged restore file.

## User flow

```mermaid
flowchart TD
    A["Run Ace configure"] --> B["Set config/backup.ts and Lucid SQLite path"]
    B --> C["Choose retention, locking and WAL policy"]
    C --> D["At startup check source and prepare private root"]
    D --> E{"Source and root usable?"}
    E -->|No| F["Fail setup or backup operation clearly"]
    E -->|Yes| G["Host schedules create followed by prune"]
```

## Code flow

Scope: operator setup and backup-root behavior in service and command entry points; scheduling is host-owned.

```mermaid
flowchart TD
    A["configure(command) writes config and registers provider/command"] --> B["Provider binds SqliteBackup"]
    B --> C{"Which operation starts?"}
    C -->|Service create or prune| D["Use configured root without preparing it"]
    D --> E{"Does the root already exist?"}
    E -->|No| F["Fail; direct service call does not recreate the root"]
    E -->|Yes| G["Create bundle or prune retained bundles"]
    C -->|db:backup create| H["Command calls prepareDirectory"]
    H --> I["Command calls backup.create"]
    I --> J["Create bundle in prepared root"]
```

**Code references:** [configure hook](../../configure.ts), [provider](../../providers/sqlite_backup_provider.ts), [config validation](../../src/define_config.ts), [service create and prune](../../src/sqlite_backup.ts), [prune root check](../../src/prune.ts), [db:backup create preparation](../../commands/db_backup.ts), [README startup contract](../../README.md#service-and-configuration).
