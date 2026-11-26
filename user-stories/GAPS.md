# Decision gaps

The package README documents the supported commands, operator limits, expected errors and prepare-only restore boundary. The [standalone API decision](../DECISIONS.md#standalone-api) records the unreleased API alignment; it does not specify an automated live-database replacement journey.

Restore preparation stops at a verified staged copy. Any live cutover remains host policy.

The [README limits](../README.md#limits) describe the copy as synchronous. The public [create implementation](../src/bundles.ts) awaits the native backup, then performs synchronous file and integrity checks. The [catalogue reference](REFERENCE.md#operator-limits) states the actual call shape and preserves the recommendation to run backups as operator work. Clarifying the README is a separate documentation correction.

The [upgrade guide](../README.md#upgrading-a-database) explains that symlinked or later reconfigured pre-migration locations can be subject to retention; [US-OP-06](upgrade-database/us-op-06-upgrade-database.md) records that condition. Restore copy errors and failures during post-copy identity capture occur before the cleanup block in [prepareRestore](../src/restore.ts); the [restore guide](../README.md#restoring) discusses interruption and later cleanup but does not explicitly describe those failure windows. Clarifying the guide is separate work; [US-OP-04](prepare-restore/us-op-04-prepare-restore.md) records the source behaviour.
