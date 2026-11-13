# Decision gaps

The package README documents the supported commands, operator limits, expected errors and prepare-only restore boundary. There is no separate accepted product-decision record in this repository that specifies an automated live-database replacement journey.

No source-backed mismatch with the documented package contract was identified. The stories preserve the README boundary: restore preparation stops at a verified staged copy, and any live cutover remains host policy. This catalogue does not infer a target to replace or automate that operator decision.
