# US-OP-04 — Prepare a verified restore copy

As a host operator, I want to stage and verify a selected bundle at a new path so that I can inspect a recovery copy before deliberately switching the application to it.

**Status:** Operator; current prepare-only restore action.
**Access:** Operator who can traverse the live database path and write to a private existing target folder.
**Entry:** `node ace db:backup restore-prepare --target path [--bundle name] [--directory path]`.
**Documentation:** [Restoring](../../README.md#restoring).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.prepareRestore](../../src/sqlite_backup.ts), [prepareRestore](../../src/restore.ts).
**Coverage:** [Restore preparation tests](../../tests/verify_restore.spec.ts), [path tests](../../tests/paths.spec.ts).

## Acceptance criteria

| Option        | Control     | Required/default/conditions                                                      |
| ------------- | ----------- | -------------------------------------------------------------------------------- |
| `--target`    | String flag | Required path; target file and sidecars must not exist; parent folder must exist |
| `--bundle`    | String flag | Optional named READY bundle; newest READY otherwise                              |
| `--directory` | String flag | Optional read-only backup root override; configured directory otherwise          |

- The action refuses the live database and its `-wal`, `-shm` or `-journal` sidecars, an existing target/sidecar (including dangling symlink), missing folder, or target inside backup root.
- It copies exclusively to the target, sets mode `0600`, and rechecks size, SHA-256, integrity, foreign keys and migration journal against the bundle manifest. It removes only its own staged file on post-copy failure.
- Success stops at a verified copy. It never replaces the live database or changes Lucid configuration. Stopping the app, switching paths, restarting and checking data remain operator decisions; retain the old file until satisfied.
- Operation is lock-free; a concurrently pruned source may fail verification.

## User flow

```mermaid
flowchart TD
    A["Operator selects a bundle and new target path"] --> B{"Target safe and absent?"}
    B -->|No| C["Refuse before replacing any file"]
    B -->|Yes| D["Copy bundle to staged target"]
    D --> E["Verify staged copy against manifest"]
    E --> F{"Copy verifies?"}
    F -->|No| G["Remove owned partial copy and report failure"]
    F -->|Yes| H["Report staged path; live database is untouched"]
    H --> I["Operator may separately stop app, switch path and validate"]
```

## Code flow

Scope: prepare-only copy through verification; host-controlled cutover is outside the package.

```mermaid
flowchart TD
    A["DbBackup.run restore-prepare case"] --> B["Require target and call SqliteBackup.prepareRestore"]
    B --> C["resolve paths and assertDirectory"]
    C --> D["Reject live/sidecar, existing target, missing parent or backup-root target"]
    D --> E["selectBundle and readManifest"]
    E --> F["copyFileSync with COPYFILE_EXCL"]
    F --> G["chmod target 0600 and assertMatchesManifest"]
    G --> H{"Path and verification valid?"}
    H -->|No| I["Remove only file created by this call and throw"]
    H -->|Yes| J["Return bundle and target; never swap live file"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [prepareRestore](../../src/restore.ts), [path safety](../../src/paths.ts), [README restore contract](../../README.md#restoring).
