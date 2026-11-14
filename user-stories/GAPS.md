# Decision gaps

The package README documents the supported commands, operator limits, expected errors and prepare-only restore boundary. There is no separate accepted product-decision record in this repository that specifies an automated live-database replacement journey.

No source-backed mismatch with the documented package contract was identified. The stories preserve the README boundary: restore preparation stops at a verified staged copy, and any live cutover remains host policy. This catalogue does not infer a target to replace or automate that operator decision.

Observed difference, recorded without changing either side: `db:upgrade` calls `createBundle` with only the live path and directory ([commands/db_upgrade.ts](../commands/db_upgrade.ts)), so a configured `requireWal`, `lockTimeoutMs` and migrations table do not apply to its snapshot. [US-OP-06](upgrade-database/us-op-06-upgrade-database.md) documents the current behavior; whether it should honor them is a product decision.
