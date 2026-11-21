# User story catalogue

Operator journeys for configuring the SQLite source and private backup root, creating and inspecting bundles, staging a restore copy, pruning retained data, backing up before migrations, and guarding stopped-server operator commands.

Source baseline: [`6f0dd18`](https://github.com/Kevinjohn/oss-adonisjs-sqlite-backup/commit/6f0dd18c2404559334749799762e3dfde0852a22) on `origin/main`.

The README and source define available operations. “Operator” describes where the action runs; it is not evidence of runtime verification.

## Index

| Story                                                                                                           | Action                                                                              | Access               | Status   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------- | -------- |
| [US-SETUP-01 — Configure and prepare backup operations](setup/us-setup-01-configure-backups.md)                 | Configure and prepare backup operations                                             | Application operator | Operator |
| [US-OP-01 — Create a verified backup bundle](create-bundle/us-op-01-create-bundle.md)                           | Create a verified backup bundle                                                     | Host operator        | Operator |
| [US-OP-02 — List published backup bundles](list-bundles/us-op-02-list-bundles.md)                               | List published backup bundles                                                       | Host operator        | Operator |
| [US-OP-03 — Verify a published backup bundle](verify-bundle/us-op-03-verify-bundle.md)                          | Verify a published backup bundle                                                    | Host operator        | Operator |
| [US-OP-04 — Prepare a verified restore copy](prepare-restore/us-op-04-prepare-restore.md)                       | Prepare a verified restore copy without live replacement                            | Host operator        | Operator |
| [US-OP-05 — Prune older and unfinished backup bundles](prune-bundles/us-op-05-prune-bundles.md)                 | Prune older and unfinished backup bundles                                           | Host operator        | Operator |
| [US-OP-06 — Back up, then migrate the database](upgrade-database/us-op-06-upgrade-database.md)                  | Create a pre-migration backup bundle, then run pending migrations with `db:upgrade` | Host operator        | Operator |
| [US-OP-07 — Run a stopped-server operator command](operator-guards/us-op-07-stopped-server-operator-command.md) | Guard a host command with `operatorDatabasePath` and `withOperatorDatabase`         | Host operator        | Operator |

## Catalogue records

- [Portable story template](TEMPLATE.md)
- [Roles and source map](REFERENCE.md)
- [Capability coverage](COVERAGE.md)
- [Decision gaps](GAPS.md)
