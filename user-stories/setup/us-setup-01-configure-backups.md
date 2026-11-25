# US-SETUP-01 — Configure and prepare backup operations

As an application operator, I want to configure the Lucid connection, private backup directory and retention behaviour so that manual, scheduled and restore-preparation operations use a known source and root.

**Status:** Operator; current configure and service setup path.
**Access:** Application operator able to configure Lucid and manage local filesystem permissions.
**Entry:** `node ace configure @kevinjohn/adonisjs-sqlite-backup`, `config/backup.ts`, and app startup calls to `checkSource()`/`prepareDirectory()` when the resolved `backup.config.directory` is set.
**Documentation:** [Install](../../README.md#install), [service and configuration](../../README.md#service-and-configuration).
**Source:** [configure](../../configure.ts), [provider](../../providers/sqlite_backup_provider.ts), [defineConfig](../../src/define_config.ts), [backup service](../../src/sqlite_backup.ts), [pruning](../../src/prune.ts), [directory preparation](../../src/directory.ts), [backup command](../../commands/db_backup.ts).
**Coverage:** [Configure tests](../../tests/configure.spec.ts), [config source tests](../../tests/config_source.spec.ts).

## Acceptance criteria

| Config key      | Control                   | Required/default/conditions                                                                                                             |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`     | `config/backup.ts` string | May be omitted/empty to disable configured operations; backup root must not contain the live database; a sibling backup folder is valid |
| `connection`    | Lucid connection name     | Optional; defaults to Lucid's configured connection; uses its source and migration table when available                                 |
| `keep`          | Integer                   | Defaults to 7; minimum 1                                                                                                                |
| `lockTimeoutMs` | Integer milliseconds      | Defaults to 0; range 0–2,147,483,647                                                                                                    |
| `requireWal`    | Boolean                   | Defaults to false; true refuses sources not in WAL mode                                                                                 |

- Ace configure requires the host's `@adonisjs/assembler` for codemods, writes the config stub and registers the provider and the package command loader (`@kevinjohn/adonisjs-sqlite-backup/commands`), which provides `db:backup` and `db:upgrade`. Configure also registers the Lucid command loader for schema generation after upgrade. The provider binds `sqlite.backup` from backup and Lucid config; the boot-aware `@kevinjohn/adonisjs-sqlite-backup/services/main` import resolves the same singleton.
- `defineConfig` rejects invalid `connection`, `requireWal`, `directory`, `keep` and `lockTimeoutMs` with AdonisJS’s `InvalidArgumentsException`. An absent or empty directory disables configured service operations. List, verify and restore preparation still accept an explicit archive root.
- At host startup, check the resolved `backup.config.directory` first. When it is empty, configured backups are disabled: the provider still boots, `checkSource()`, `prepareDirectory()`, `create()` and `prune()` would throw `E_BACKUP_DISABLED`, so the host skips them and schedules nothing, and recovery reads take an explicit directory. When it is set, `checkSource()` can fail fast without making a bundle; call `prepareDirectory()` once to create/tighten the root to `0700` before scheduling create then prune. `prepareDirectory()` refuses a root that contains the configured live database with `E_BACKUP_UNSAFE` before creating or changing anything. An unreadable source or unsafe root still throws and stops startup.
- Service calls to `create()` and `prune()` require an existing backup root and do not recreate a vanished one. The `db:backup create` command calls `prepareDirectory()` before `create()`; callers using the service directly must prepare the root themselves. Host owns scheduling and any later switch to a staged restore file.
- A caller using the [standalone archive lock](../integration/us-int-02-archive-lock.md) provides an existing private root. `acquireLock` itself does not check root privacy.

- If the app resolves the singleton without a backup config, the provider raises AdonisJS’s `RuntimeException` with the configure command. Missing config differs from a present config with an empty directory, for which archive overrides are available. [Provider](../../providers/sqlite_backup_provider.ts), [application tests](../../tests/app.spec.ts)

## User flow

```mermaid
flowchart TD
    A["Run Ace configure"] --> B["Set config/backup.ts and Lucid SQLite path"]
    B --> C["Choose retention, locking and WAL policy"]
    C --> C1{"Resolved backup directory set?"}
    C1 -->|No| C2["Skip startup checks and scheduling; recover with an explicit directory"]
    C1 -->|Yes| D["At startup check source and prepare private root"]
    D --> E{"Source readable and live database outside the root?"}
    E -->|No| F["Fail setup or backup operation clearly"]
    E -->|Yes| G["Host schedules create followed by prune"]
```

## Code flow

Scope: operator setup and backup-root behaviour in service and command entry points; scheduling is host-owned.

```mermaid
flowchart TD
    A["configure(command) writes config and registers provider and both command loaders"] --> B["Provider registers lazy singleton"]
    B --> B1{"Backup config present and valid?"}
    B1 -->|Missing| X["Throw RuntimeException on singleton resolution"]
    B1 -->|Invalid| X1["defineConfig throws InvalidArgumentsException"]
    B1 -->|Yes| O{"Which group of operations?"}
    O -->|List, verify or restore preparation| R["Use supplied directory or configured root; restore also resolves live path"]
    R -->|Neither directory set| F0["Service throws E_BACKUP_DISABLED"]
    O -->|Source check, directory prep, create or prune| D0{"Configured directory set?"}
    D0 -->|No| F1["Host skips startup and scheduled work; a direct call throws E_BACKUP_DISABLED"]
    D0 -->|Yes| C{"Which configured operation?"}
    C -->|checkSource| S["Resolve enabled source; open read-only, probe schema and close"]
    C -->|prepareDirectory| P1{"Root contains the configured live database?"}
    P1 -->|Yes| P2["Throw E_BACKUP_UNSAFE before creating or changing the root"]
    P1 -->|No| P["Create or tighten root to 0700"]
    C -->|Service create or prune| D["Use configured root without preparing it"]
    D --> E{"Does the root already exist?"}
    E -->|No| F["Fail; direct service call does not recreate the root"]
    E -->|Yes| G["Create bundle or prune retained bundles"]
    C -->|db:backup create| H1["Check source/root layout"]
    H1 --> H["Command calls prepareDirectory"]
    H --> I["Command calls backup.create"]
    I --> J["Create bundle in prepared root"]
```

**Code references:** [configure hook](../../configure.ts), [provider](../../providers/sqlite_backup_provider.ts), [config validation](../../src/define_config.ts), [service preparation, create and prune](../../src/sqlite_backup.ts), [prune root check](../../src/prune.ts), [direct lock export](../../index.ts), [lock implementation](../../src/lock.ts), [db:backup create preparation](../../commands/db_backup.ts), [README startup contract](../../README.md#service-and-configuration).
