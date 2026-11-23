# Decision gaps

The package README documents the supported commands, operator limits, expected errors and prepare-only restore boundary. There is no separate accepted product-decision record in this repository that specifies an automated live-database replacement journey.

Restore preparation stops at a verified staged copy. Any live cutover remains host policy.

The [README limits](../README.md#limits) describe the copy as synchronous. The public [create implementation](../src/bundles.ts) awaits the native backup, then performs synchronous file and integrity checks. The [catalogue reference](REFERENCE.md#operator-limits) states the actual call shape and preserves the recommendation to run backups as operator work. Clarifying the README is a separate documentation correction.
