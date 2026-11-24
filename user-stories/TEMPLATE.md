# Story format

A story records one meaningful user operation and why it matters. Use actual permission roles,
actual command/API names and relevant options or form fields. Keep implementation contracts in the repository's
authoritative decision record, instructions in guides and runnable scenarios in the test suite.

Copy the story example below into a story directory under `user-stories/`; its source links resolve from that depth. Replace its sample content with source-backed
details. Keep the writing and maintenance guidance in this TEMPLATE.md, outside individual stories.
Omit the optional Coverage line when there is no useful test link. The field table is for form
operations; use the controls/results alternative below for operations without input fields. Adapt both
diagrams to the actual operation rather than retaining the sample save flow.

## Story example

````markdown
# US-OP-01 — Create a verified backup bundle

As a host operator, I want to create a verified backup bundle from the configured Lucid SQLite database so that I have a checked recovery point.

**Status:** Operator; current Ace command and service operation.
**Access:** Host operator with a readable live database and private configured backup root.
**Entry:** `node ace db:backup create`; run as an operator task, not in a web request.
**Documentation:** [Command behaviour](../../README.md#commands), [service and configuration](../../README.md#service-and-configuration).
**Source:** [DbBackup.run](../../commands/db_backup.ts), [SqliteBackup.create](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts).
**Coverage:** [Create tests](../../tests/create.spec.ts), [durability tests](../../tests/durability.spec.ts).

## Acceptance criteria

- `DbBackup.run` checks the source/root layout before preparing the configured root and calls `SqliteBackup.create()`, which resolves the configured live path, selected migration table, lock timeout and WAL requirement.
- `createBundle()` validates private directory/source layout and takes the cooperative `.backup.lock` for creation and publication. Resource-cleanup failure can trigger bundle cleanup after the lock-release attempt. It relies on trusted archive parents and cooperating writers. It refuses a borrowed handle with an open transaction; a borrowed handle stays open afterward.
- The copy is made using SQLite backup, journal and migration metadata are checked, `readDatabaseIntegrityProblem()` runs full integrity and foreign-key checks, and a read-only database file plus manifest are written before READY is durably written last.
- Verification uses package-opened SQLite connections. SQL functions, collations or extensions registered only on the application's connection are not registered on those handles. A schema that depends on them, such as an expression index using an application-registered function, may fail verification; create fails closed and does not publish the bundle. There is no connection initialiser hook.
- The existing source journal mode is read, not changed. A non-WAL source produces a warning unless `requireWal` makes it a refusal. The backup copy is checkpointed and normalised to `journal_mode=DELETE`. A failed create cleans up its unfinished bundle where possible and exits nonzero. If cleanup fails, inspect the cleanup error and the archive before retrying. A bundle may remain visible if its READY marker could not be removed.
- Create is refused with `E_BACKUP_LOCKED` when another run holds `.backup.lock` for longer than `lockTimeoutMs`, and with `E_BACKUP_UNSAFE` when the newest existing bundle is dated more than 24 hours after the clock; the operator fixes the clock or moves that bundle, then retries.
- `create` uses only configured backup directory; `--directory` is invalid for this operation.

- Create compares every ordered row of the source migration journal with the copy. A missing journal omits migration metadata. Unsupported metadata prevents publication. [Adoption scenarios](../../tests/adoption.spec.ts)

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup create"] --> P["Check source/root layout"]
    P --> B["Prepare configured private backup root"]
    B --> C["Acquire lock and open configured live SQLite source"]
    C -->|Lock busy past lockTimeoutMs| X["Refuse E_BACKUP_LOCKED; retry later"]
    C --> O{"Source readable and idle?"}
    O -->|No| F
    O -->|Yes| J{"Existing source mode is WAL?"}
    J -->|No and requireWal| K["Refuse; operator resolves source configuration"]
    J -->|No and allowed| L["Continue without changing source journal mode"]
    L --> Y{"Newest bundle dated over 24 h ahead of clock?"}
    J -->|Yes| Y
    Y -->|Yes| Z["Refuse E_BACKUP_UNSAFE; fix clock or move that bundle"]
    Y -->|No| D["Copy, normalise copy to DELETE, verify and write manifest"]
    D --> E{"All checks pass?"}
    E -->|No| F["Report failure"]
    E -->|Yes| G["Write READY last, sync and finish resource cleanup"]
    G -->|Success| H["Report warnings and bundle path"]
    G -->|Failure| F
    F --> T{"READY absent or removed?"}
    T -->|Yes| U["No bundle published"]
    T -->|No or unknown| V["Inspect cleanup error and archive before retrying; bundle may still be listed"]
```

## Code flow

Scope: Ace create operation through publication, failure cleanup and lock release. `assertDirectory`, `assertSafeLayout` and `acquireCreateLock` failures happen before the lock-owning `try/finally`, so a lock that was never acquired is not released.

```mermaid
flowchart TD
    A["DbBackup.run create case"] --> A1["assertSafeLayout before preparing the root"]
    A1 --> B["SqliteBackup.prepareDirectory"]
    B --> C["SqliteBackup.create"]
    C --> D["resolveSqliteSource and createBundle"]
    D --> E["assertDirectory, assertSafeLayout, await acquireCreateLock"]
    E -->|Lock busy past lockTimeoutMs| W["Throw E_BACKUP_LOCKED"]
    E -->|Lock acquired| O["Open source and read journal_mode"]
    O --> O1{"Source readable and not in transaction?"}
    O1 -->|No| K
    O1 -->|Yes| J{"Non-WAL?"}
    J -->|"Non-WAL and requireWal"| K["Throw E_BACKUP_SOURCE"]
    J -->|"Non-WAL and allowed"| L["Add warning without changing source"]
    J -->|"No, source is WAL"| Q{"Newest bundle over MAX_FUTURE_MS ahead of clock?"}
    L --> Q
    Q -->|Yes| R["Throw E_BACKUP_UNSAFE"]
    Q -->|No| S["mkdir bundle directory; this call now owns it"]
    S --> N["Sync archive and read source migration rows"]
    N --> F["NativeDatabase.backup to db.sqlite"]
    F --> M["Checkpoint copy; set copy journal_mode DELETE"]
    M --> G["Remove copy sidecars; verify copied migration rows and readDatabaseIntegrityProblem"]
    G --> H["chmod 0400 and sync; hash file, validate metadata, write manifest then READY and sync"]
    H --> I["Record result"]
    K --> V["Catch: remove READY then owned bundle if created"]
    R --> V
    S -->|failure| V
    N -->|failure| V
    F -->|failure| V
    M -->|failure| V
    G -->|failure| V
    H -->|failure| V
    V --> U["Record primary error and any cleanupError; failed READY removal can leave the bundle visible"]
    I --> T["Finally: attempt owned source close and lock.release independently"]
    U --> T
    T --> T1{"Primary or resource cleanup failure?"}
    T1 -->|Primary failure| T2["Throw primary error with resource cleanup diagnostics"]
    T1 -->|Cleanup only| T3["Attempt unpublication and owned bundle removal; throw failure and attach any cleanupError"]
    T1 -->|Neither| T4["Return result"]
```

**Code references:** [command](../../commands/db_backup.ts), [service](../../src/sqlite_backup.ts), [createBundle](../../src/bundles.ts), [durability tests](../../tests/durability.spec.ts).
````

## Operations with input fields

Use this table for actual command/API options or forms. Record required/default state, limits, options, dependent choices, visibility and read-only conditions; do not invent UI controls for an API.

```markdown
| Field or input             | Control or API type   | Required/default/conditions                                  |
| -------------------------- | --------------------- | ------------------------------------------------------------ |
| [Exact label or parameter] | [Actual control/type] | [Required/optional, default, limits, options and conditions] |
```

## Operations without input fields

Replace the field table with a short list of controls and their visible results. Do not create
empty or artificial field rows. For example, a timeline navigation operation could use:

```markdown
## Acceptance criteria

- **List** prints READY bundle names from oldest to newest without modifying them.
```

Use the actual control and behaviour in the product. Include confirmation controls and relevant
cancellation or failure results when they affect the operation. Keep both diagrams in these stories.

## Writing and maintenance rules

- Use one story per meaningful outcome. An inseparable set of controls may share a story;
  independently useful operations deserve their own. Create and edit are distinct operations.
  Keep inputs, decisions and recovery focused on that one operation; do not create stories for its
  internal checks, helpers or technical variants.
  When splitting, preserve the original ID/path for one outcome and give the other the next unused
  ID; update catalogue references and counts together.
- Include every relevant field, including conditional and read-only fields. Record exact labels,
  required/optional state, defaults, limits, available options and dependent choices. For dynamic
  choices, describe their source and filtering rules rather than listing transient data.
- Edit forms include current-value prefills. API/library/CLI operations document real argument names,
  required values, omission/null defaults, flag/prompt behaviour and limits. Verify what callbacks
  receive before assigning host policy to them.
- Move repeated or lengthy field lists, technical schemas and protocol details to one cohesive
  repository guide/reference with a direct section link. Keep relevant controls, outcomes and
  operation-specific differences clear locally; do not make readers chase several links for a form.
- Keep acceptance criteria concise and observable. Avoid detailed test scripts and exhaustive
  backend guarantees; keep those in tests and the authoritative decision record.
- Keep identifiers and filenames stable. Add the next unused identifier within the area. Retain
  intent and mark availability when a feature disappears, unless retirement is explicitly authorised.
- Use the availability definitions below. Explain unavailable entries and identify historical or
  intended controls clearly. Retention does not promise restoration or authorise new functionality.
  State opt-in capabilities and required hooks; trace account-state and permission requirements
  for this operation instead of copying them from a neighbouring operation.
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

| Status     | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| Current    | Exposed, subject to stated roles, configuration and conditions          |
| Hidden     | Implementation remains but its ordinary entry or trigger is unavailable |
| Removed    | Historical capability has no current product entry                      |
| Demo       | Available only in the specified demo context                            |
| Operator   | Installation, hosting or recovery outside the ordinary application UI   |
| Planned    | Agreed target without an ordinary implemented journey                   |
| Public API | Exposed for host integration under the stated conditions                |

Read Status with Access and Entry. A configured feature switch is a condition, not proof of removal.
Current describes availability, not a browser test result. Preserve equivalent repository status
semantics and explain their mapping where an established scheme differs.

## Diagram conventions

- Every story has User flow and Code flow sections, each containing a Mermaid flowchart. The first
  uses screens, operations, decisions and outcomes a person understands; the second names the actual
  implementation. Link supporting files under Code references.
- Keep diagrams focused on the operation. Include meaningful choices, cancellation, refusal, failure
  and recovery where they affect the journey; avoid repeating every validation or security rule.
  Use the owning handler/service/transaction as the default code-flow unit. Group routine field/proof
  validation into one boundary with one refusal path; field rules stay in criteria or a reference.
  Expand only for materially different access, persisted effects, commit/consumption or recovery.
  Preserve material ordering without making a node for each field, message or helper.
- Trace producers and consumers: entry, handler, state or service, persistence where applicable
  and resulting UI. A retained component or setter alone does not prove a reachable journey.
- Distinguish server writes, device preferences and read-only operations. Verify the demo's actual
  path. Do not infer server authorisation from hidden controls.
- Trace each client and authentication strategy separately. Show actual response fields and
  prerequisite-token sources; browser rendering, API acknowledgements and audit events may differ.
  Keep real calls on the branches that execute them, including client-specific queries.
- Place checks and validation before the operations they govern. Include early no-op returns,
  scope/replacement effects and refusals that consume proof or leave committed state in place.
  Distinguish confirmation/completion recipients and attempted cleanup from guaranteed removal;
  show recovery when these differences affect the operation. Bounded counts describe the current run.
- Code labels must name existing symbols or explicitly identify absent/intended controls. State
  the scope when a diagram stops at a shared boundary.
- For Hidden, Removed or Planned features, label the intended user flow as unavailable. Show the
  actual missing entry/trigger and retained support in the code flow without implying execution.
- Reconcile labels and branches against source. Parse changed Mermaid diagrams and inspect
  representative rendering; report any check that could not be completed. Syntax validation does
  not establish behavioural correctness or prove a browser journey was exercised.

## Verification and sign-off

Agree whether the task covers a catalogue baseline, named stories or an agreed finding list.
Sign off that scope only after reconciling it with source and obtaining the applicable checks and
required review. In the existing handoff or final response, record the reviewed scope/source and
content revision, supporting source references and finding dispositions, actual checks/skips/limits,
review outcome when required, and delivery/PR state. CI evidence must match the final published
head. Keep source review, documentation checks and runtime journeys distinct.

For correction rounds, verify the agreed items and affected guarantees; record unrelated new
observations separately. Recheck introduced defects and invalidated review evidence while retaining
acceptance for unaffected content. Closing the latest finding list establishes that list's closure;
a catalogue-wide baseline claim needs reconciliation of the agreed catalogue scope. Preserve the
requested merge boundary; catalogue work grants no merge permission.
