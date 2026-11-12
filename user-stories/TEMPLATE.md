# Story format

A story records one meaningful user action and why it matters. Use actual permission roles,
actual command/API names and relevant options or form fields. Keep implementation contracts in the repository's
authoritative decision record, instructions in guides and runnable scenarios in the test suite.

Copy the story example below into `user-stories/backup/US-BACKUP-NN-action.md`; its source links resolve from that copied path. Replace its sample content with source-backed
details. Keep the writing and maintenance guidance in this TEMPLATE.md, outside individual stories.
Omit the optional Coverage line when there is no useful test link. The field table is for form
actions; use the controls/results alternative below for actions without input fields. Adapt both
diagrams to the actual action rather than retaining the sample save flow.

## Story example

````markdown
# US-OP-01 — Create a verified backup bundle

As a host operator, I want to create an immutable backup bundle from the configured Lucid SQLite database so that I have a checked recovery point.

**Status:** Operator; current Ace command and service operation.
**Access:** Host operator with a readable live database and private configured backup root.
**Entry:** `node ace db:backup create`; run as an operator task, not in a web request.
**Documentation:** [Command behavior](../../README.md#commands), [service and configuration](../../README.md#service-and-configuration).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.create](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts).
**Coverage:** [Create tests](../../tests/create.spec.ts), [durability tests](../../tests/durability.spec.ts).

## Acceptance criteria

- `DbBackup.run` prepares the configured root and calls `SqliteBackup.create()`, which resolves the configured live path, selected migration table, lock timeout and WAL requirement.
- `createBundle()` validates private directory/source layout and holds `.backup.lock` for its run. It refuses a borrowed handle with an open transaction; a borrowed handle stays open afterward.
- The copy is made using SQLite backup, journal and migration metadata are checked, `checkDatabase()` runs full integrity and foreign-key checks, and a read-only database file plus manifest are written before READY is durably written last.
- The existing source journal mode is read, not changed. A non-WAL source produces a warning unless `requireWal` makes it a refusal. The backup copy is checkpointed and normalized to `journal_mode=DELETE`. A failed create cleans up its unfinished bundle where possible and exits nonzero; cleanup failure is separately reported.
- `create` uses only configured backup directory; `--directory` is invalid for this action.

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup create"] --> B["Prepare configured private backup root"]
    B --> C["Open configured live SQLite source and acquire lock"]
    C --> J{"Existing source mode is WAL?"}
    J -->|No and requireWal| K["Refuse; operator resolves source configuration"]
    J -->|No and allowed| L["Report warning; keep source journal mode"]
    J -->|Yes| D["Copy, normalize copy to DELETE, verify and write manifest"]
    L --> D
    D --> E{"All checks pass?"}
    E -->|No| F["Report failure; unfinished bundle is not published"]
    E -->|Yes| G["Write READY last and report bundle path"]
```

## Code flow

Scope: Ace create action through publication and lock release.

```mermaid
flowchart TD
    A["DbBackup.run create case"] --> B["SqliteBackup.prepareDirectory"]
    B --> C["SqliteBackup.create"]
    C --> D["resolveSqliteSource and createBundle"]
    D --> E["assertDirectory, assertSafeLayout, acquireLock"]
    E --> J{"Read source journal_mode; non-WAL?"}
    J -->|Yes and requireWal| K["Throw E_BACKUP_SOURCE"]
    J -->|Yes and allowed| L["Add warning without changing source"]
    J -->|No| N["Read source migrationRows"]
    L --> N
    N --> F["NativeDatabase.backup to db.sqlite"]
    F --> M["Checkpoint copy; set copy journal_mode DELETE"]
    M --> G["Verify copied migrationRows; checkDatabase and sha256File"]
    G --> H["writeDurable manifest then READY"]
    H --> I["Return result; close owned source and release lock"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts), [durability tests](../../tests/durability.spec.ts).
````

## Actions with input fields

Use this table for actual command/API options or forms. Record required/default state, limits, options, dependent choices, visibility and read-only conditions; do not invent UI controls for an API.

```markdown
| Field or input             | Control or API type   | Required/default/conditions                                  |
| -------------------------- | --------------------- | ------------------------------------------------------------ |
| [Exact label or parameter] | [Actual control/type] | [Required/optional, default, limits, options and conditions] |
```

## Actions without input fields

Replace the field table with a short list of controls and their visible results. Do not create
empty or artificial field rows. For example, a timeline navigation action could use:

```markdown
## Acceptance criteria

- **List** prints READY bundle names from oldest to newest without modifying them.
```

Use the actual control and behavior in the product. Include confirmation controls and relevant
cancellation or failure results when they affect the action. Keep both diagrams in these stories.

## Writing and maintenance rules

- Use one story per meaningful outcome. An inseparable set of controls may share a story;
  independently useful actions deserve their own. Create and edit are distinct actions.
  When splitting, preserve the original ID/path for one outcome and give the other the next unused
  ID; update catalogue references and counts together.
- Include every relevant field, including conditional and read-only fields. Record exact labels,
  required/optional state, defaults, limits, available options and dependent choices. For dynamic
  choices, describe their source and filtering rules rather than listing transient data.
- Edit forms include current-value prefills. API/library/CLI actions document real argument names,
  required values, omission/null defaults, flag/prompt behavior and limits. Verify what callbacks
  receive before assigning host policy to them.
- Link an identical shared field list and describe create/edit differences locally. Do not make
  readers chase several links to discover a form.
- Keep acceptance criteria concise and observable. Avoid detailed test scripts and exhaustive
  backend guarantees; keep those in tests and the authoritative decision record.
- Keep identifiers and filenames stable. Add the next unused identifier within the area. Retain
  intent and mark availability when a feature disappears, unless retirement is explicitly authorized.
- Use the availability definitions below. Explain unavailable entries and identify historical or
  intended controls clearly. Retention does not promise restoration or authorize new functionality.
  State opt-in capabilities and required hooks; trace account-state and permission requirements
  for this operation instead of copying them from a neighboring action.
- An optional **Coverage:** test link identifies supporting tests; it does not claim they were run.
  Keep runtime results separate from source-reviewed availability.
- Verify source rather than inheriting stale copy. Update the index (README.md), coverage matrix
  (COVERAGE.md), shared reference (REFERENCE.md) and decision gaps (GAPS.md) alongside affected stories.
  Adapt these names to the repository's established equivalents.
- Reconcile copied examples in TEMPLATE.md too. Close review findings with source evidence for
  each correction; green checks alone do not establish that an inaccurate claim is fixed.
- Record differences between agreed targets and current implementation in the gaps record without
  silently changing either. “New” in the coverage matrix means newly documented, not newly implemented.

## Availability definitions

| Status   | Meaning                                                                 |
| -------- | ----------------------------------------------------------------------- |
| Current  | Exposed, subject to stated roles, configuration and conditions          |
| Hidden   | Implementation remains but its ordinary entry or trigger is unavailable |
| Removed  | Historical capability has no current product entry                      |
| Demo     | Available only in the specified demo context                            |
| Operator | Installation, hosting or recovery outside the ordinary application UI   |
| Planned  | Agreed target without an ordinary implemented journey                   |

Read Status with Access and Entry. A configured feature switch is a condition, not proof of removal.
Current describes availability, not a browser test result. Preserve equivalent repository status
semantics and explain their mapping where an established scheme differs.

## Diagram conventions

- Every story has User flow and Code flow sections, each containing a Mermaid flowchart. The first
  uses screens, actions, decisions and outcomes a person understands; the second names the actual
  implementation. Link supporting files under Code references.
- Keep diagrams focused on the action. Include meaningful choices, cancellation, refusal, failure
  and recovery where they affect the journey; avoid repeating every validation or security rule.
- Trace producers and consumers: entry, handler, state or service, persistence where applicable
  and resulting UI. A retained component or setter alone does not prove a reachable journey.
- Distinguish server writes, device preferences and read-only actions. Verify the demo's actual
  path. Do not infer server authorization from hidden controls.
- Trace each client and authentication strategy separately. Show actual response fields and
  prerequisite-token sources; browser rendering, API acknowledgements and audit events may differ.
  Keep real calls on the branches that execute them, including client-specific queries.
- Place guards and validation before the operations they govern. Include early no-op returns,
  scope/replacement effects and refusals that consume proof or leave committed state in place.
  Distinguish confirmation/completion recipients and attempted cleanup from guaranteed removal;
  show recovery when these differences affect the action. Bounded counts describe the current run.
- Code labels must name existing symbols or explicitly identify absent/intended controls. State
  the scope when a diagram stops at a shared boundary.
- For Hidden, Removed or Planned features, label the intended user flow as unavailable. Show the
  actual missing entry/trigger and retained support in the code flow without implying execution.
- Reconcile labels and branches against source. Parse changed Mermaid diagrams and inspect
  representative rendering; report any check that could not be completed. Syntax validation does
  not establish behavioral correctness or prove a browser journey was exercised.
- Tie validation and CI to the final content/revision, distinguish skipped jobs from successful
  gates and reuse evidence only for unchanged guarantees. Report source review, documentation
  checks and runtime journeys separately.
