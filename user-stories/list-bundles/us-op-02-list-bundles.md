# US-OP-02 — List published backup bundles

As a host operator, I want to list READY bundles so that I can see available recovery points before verifying, restoring or pruning them.

**Status:** Operator; current Ace and public service operation.
**Access:** Operator able to read configured or explicitly selected backup directory.
**Entry:** `node ace db:backup list [--directory path]`.
**Documentation:** [Command behaviour](../../README.md#commands), [bundle listing contract](../../README.md#service-and-configuration).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.list](../../src/sqlite_backup.ts), [listBundles](../../src/bundles.ts).
**Coverage:** [Application command tests](../../tests/app.spec.ts), [bundle tests](../../tests/create.spec.ts).

## Acceptance criteria

| Option        | Control     | Required/default/conditions                                                     |
| ------------- | ----------- | ------------------------------------------------------------------------------- |
| `--directory` | String flag | Optional; read-only override for this operation; configured directory otherwise |

- `listBundles()` includes only real bundle directories with READY, ordered oldest first; Ace prints bundle names.
- An existing empty directory prints no bundle names; a missing directory fails. A concurrently removed publication is skipped; a READY bundle with unreadable manifest fails and identifies the bundle.
- Listing is lock-free and does not alter bundles. The override also works when configured operations are disabled.

- The service returns summaries with name, path and creation time. Ace prints names. Listing requires a regular READY marker and a regular manifest with a canonical UTC timestamp, and does not hash or open the database. [Manifest reader](../../src/bundles.ts)

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup list"] --> B{"Use configured root or --directory?"}
    B -->|Either| C["Read backup root"]
    C --> D{"Root exists and is readable?"}
    D -->|No| E["Report directory error"]
    D -->|Yes| F{"Published summaries readable?"}
    F -->|No| E
    F -->|Yes| G["Print READY names oldest first; none if empty"]
```

## Code flow

Scope: read-only listing through bundle metadata; no lock is acquired.

```mermaid
flowchart TD
    A["DbBackup.run list case"] --> B["SqliteBackup.list(directory)"]
    B --> C["requireBackupDirectory chooses override or config"]
    C --> D["listBundles"]
    D --> E["listBundleDirectoryNames checks root, then filters and sorts real bundle dirs"]
    E -->|Missing or unreadable root| R["Propagate directory failure to Ace"]
    E --> F["READY marker filter"]
    F -->|READY absent| X["Skip entry"]
    F -->|READY present| G["readManifest validates marker, manifest and createdAt"]
    G -->|Success| H["Collect BundleSummary"]
    G -->|READY or previously present manifest vanished| X
    G -->|Other manifest failure| I["Throw E_BACKUP_INVALID"]
    H --> J["Return summaries; Ace logs names"]
    X --> J
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [listBundles and listBundleDirectoryNames](../../src/bundles.ts), [listing contract](../../README.md#service-and-configuration).
