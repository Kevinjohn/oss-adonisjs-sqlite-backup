# US-OP-03 — Verify a published backup bundle

As a host operator, I want to verify a named or newest backup bundle so that I can check its marker, manifest, database bytes and SQLite integrity before relying on it.

**Status:** Operator; current Ace and public service operation.
**Access:** Operator able to read configured or explicitly selected backup directory.
**Entry:** `node ace db:backup verify [--bundle name] [--directory path]`.
**Documentation:** [Command behaviour](../../README.md#commands), [bundle validation contract](../../README.md#errors).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.verify](../../src/sqlite_backup.ts), [verifyBundle](../../src/bundles.ts).
**Coverage:** [Review tests](../../tests/review.spec.ts), [verify/restore tests](../../tests/verify_restore.spec.ts).

## Acceptance criteria

| Option        | Control     | Required/default/conditions                                      |
| ------------- | ----------- | ---------------------------------------------------------------- |
| `--bundle`    | String flag | Optional; selects a named bundle; newest READY bundle otherwise  |
| `--directory` | String flag | Optional read-only root override; configured directory otherwise |

- `verifyBundle()` selects a real directory, requires READY, parses the format-1 manifest, and checks file size, SHA-256, full SQLite integrity/foreign-key checks, and optional migration metadata.
- An invalid `--bundle` name yields `E_BACKUP_BUNDLE_NAME`. A matching entry that is a file or symlink yields `E_BACKUP_BUNDLE_FILE_TYPE`. A missing named bundle yields `E_BACKUP_NOT_FOUND`. Manifest and database checks report the specific verification failure. Default newest selection reports `E_BACKUP_BUNDLE_PRUNED` when prune unpublishes it during verification. A named selection can report `E_BACKUP_READY_MISSING` when unpublication occurs before its readiness snapshot.
- Verification is read-only and lock-free; a concurrent prune may cause the operation to fail. A successful check does not recheck READY after validation or guarantee continued publication.

- READY, manifest and database must be regular files. A format-1 manifest may omit migrations. With migration metadata, verify compares the declared main journal’s row count and final name in ID order. It counts every foreign-key violation using an iterator. Default selection reads the chosen manifest without parsing older malformed manifests. [Recovery scenarios](../../tests/adoption.spec.ts), [regular-file tests](../../tests/verify_restore.spec.ts), [SQLite checks](../../src/checks.ts)

## User flow

```mermaid
flowchart TD
    A["Operator runs verify"] --> B{"Name supplied?"}
    B -->|Yes| V{"Valid name for an existing real bundle directory?"}
    V -->|No| W["See the bundle name or lookup failure"]
    V -->|Yes| C["Select named bundle directory"]
    B -->|No| D["Select newest READY bundle"]
    C --> E["Check marker and manifest against database copy"]
    D --> E
    E --> F{"All checks pass?"}
    F -->|No| G["See not-found or invalid-bundle error"]
    F -->|Yes| H["See verified bundle name"]
```

## Code flow

Scope: lock-free bundle selection and verification.

```mermaid
flowchart TD
    A["DbBackup.run verify case"] --> B["SqliteBackup.verify(name, directory)"]
    B --> C["verifyBundle"]
    C --> S{"Name supplied?"}
    S -->|Yes| D["requireSelectedBundle: requireBundleTimestamp, lstat"]
    S -->|No| B1["List real bundle directories; choose newest with READY"]
    B1 -->|None| N
    B1 --> E1["Record prior READY presence"]
    D -->|Invalid name or not a directory| X["Throw E_BACKUP_BUNDLE_NAME or E_BACKUP_BUNDLE_FILE_TYPE"]
    D -->|No entry with that name| N["Throw E_BACKUP_NOT_FOUND"]
    D --> E1
    E1 --> E["readManifest"]
    E --> F["assertMatchesManifest"]
    F --> G["Check size, sha256, readDatabaseIntegrityProblem and assertMigrations"]
    E -->|Failure| H{"Was READY and now absent?"}
    G -->|Failure| H
    H -->|Yes| I["Throw E_BACKUP_BUNDLE_PRUNED"]
    H -->|No| K["Rethrow original error"]
    G -->|Success| J["Return selected BundleLocation"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [verifyBundle and assertions](../../src/bundles.ts), [checks](../../src/checks.ts), [verify tests](../../tests/verify_restore.spec.ts).
