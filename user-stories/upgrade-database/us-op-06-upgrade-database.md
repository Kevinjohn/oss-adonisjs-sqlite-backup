# US-OP-06 — Back up, then migrate the database

As a host operator, I want the `db:upgrade` Ace command to create a verified pre-migration backup bundle of the SQLite database before running pending migrations so that a failed or unwanted migration has a recovery point.

**Status:** Operator; current Ace command.
**Access:** Host operator with a readable live database, a writable backup directory and Lucid registered with a `better-sqlite3` primary connection, and `@adonisjs/lucid/commands` registered because `db:upgrade` runs `migration:run` through the Ace kernel.
**Entry:** `node ace db:upgrade [--no-schema-generate]`; run as an operator task, not in a web request.
**Documentation:** [Upgrading a database](../../README.md#upgrading-a-database).
**Release note:** Since v0.3.0, the pre-migration backup bundle uses the primary connection's migrations table and the backup configuration's `lockTimeoutMs` and `requireWal`, and reports non-WAL warnings.
**Source:** [DbUpgrade.run](../../commands/db_upgrade.ts), [preMigrationBackupDirectory](../../src/upgrade.ts), [createBundle](../../src/bundles.ts), [command loader](../../commands/main.ts).
**Coverage:** [Upgrade tests](../../tests/upgrade.spec.ts).

## Acceptance criteria

| Option                 | Control      | Required/default/conditions                                                                        |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `--no-schema-generate` | Boolean flag | Optional; `--schema-generate` defaults to true. When off, skip the separate schema-generation step |

- The command refuses with `Upgrade failed: …` and exit code 1 when the primary connection is not `better-sqlite3`.
- A database with no row of type `table` in `sqlite_master`, or an in-memory database, is migrated without a pre-migration backup bundle. Views or SQLite header metadata alone do not meet the table condition.
- Otherwise it writes a verified bundle to `pre-migration` under the configured backup `directory`, or to `<database>.backups` beside the database when no directory is configured, and reports `Pre-upgrade backup written <path>`. These bundles are outside `db:backup prune` retention.
- The bundle uses the primary connection's migrations table (`migrations.tableName`, default `adonis_schema`) and the backup config's `lockTimeoutMs` and `requireWal`, as `db:backup create` does. A non-WAL source is reported as a warning, or refused with `requireWal: true`.
- If the bundle cannot be written, nothing is migrated and the command exits 1. Otherwise it runs `migration:run --force --no-schema-generate`. A migration failure propagates its error and exit code and skips generation. After success outside production, schema generation runs by default on the primary connection. Its failure propagates separately.

## User flow

```mermaid
flowchart TD
    A["Operator runs db:upgrade"] --> B{"Primary connection is better-sqlite3?"}
    B -->|No| C["See Upgrade failed; exit 1"]
    B -->|Yes| D{"Database has tables and is on disk?"}
    D -->|No| G["Run pending migrations without a backup bundle"]
    D -->|Yes| E["Write verified backup bundle to pre-migration or database.backups"]
    E --> F{"Snapshot written?"}
    F -->|No| C
    F -->|Yes| G
    G --> H{"Migrations succeed?"}
    H -->|No| I["See migration error; restore-prepare if a bundle was written"]
    H -->|Yes| J["Generate schema if enabled outside production"]
    J --> K["Report completion or generator failure"]
```

## Code flow

Scope: `DbUpgrade.run` through the `migration:run` exit code.

```mermaid
flowchart TD
    A["DbUpgrade.run"] --> B["Make lucid.db; read primary connection config"]
    B --> C{"client is better-sqlite3?"}
    C -->|No| X["Throw; catch logs Upgrade failed; exitCode 1"]
    C -->|Yes| D["Normalise configured filename; query sqlite_master for a table"]
    D --> E{"dbPath is not :memory: and a table exists?"}
    E -->|No| H["kernel.exec migration:run --force --no-schema-generate"]
    E -->|Yes| F1{"Filename is nonempty and not a URI?"}
    F1 -->|No| X
    F1 -->|Yes| F["preMigrationBackupDirectory; assertSafeLayout; prepareDirectory"]
    F -->|Failure| X
    F --> G["createBundle with livePath, directory, migrations table, lockTimeoutMs and requireWal; log warnings"]
    G -->|failure| X
    G -->|success| H
    H -->|Throws| X
    H -->|Returns| I{"migrate.exitCode is 0?"}
    I -->|No| J["Copy migrate.error and exit code"]
    I -->|Yes| K{"Generation enabled outside production?"}
    K -->|No| L["Finish successfully"]
    K -->|Yes| M["Run schema:generate for primary connection"]
    M -->|Throws| X
    M -->|Nonzero or absent exit code| N["Copy generator error and exit code, default 1"]
    M -->|Exit code 0| L
```

**Code references:** [command](../../commands/db_upgrade.ts), [pre-migration backup directory](../../src/upgrade.ts), [createBundle](../../src/bundles.ts), [upgrade tests](../../tests/upgrade.spec.ts), [README upgrade contract](../../README.md#upgrading-a-database).
