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

- A successful create reports the bundle path; when the source is not using WAL, it also warns that other writers wait for the copy. With `requireWal: true`, it refuses instead.
- On failure, the command reports the error and exits nonzero. If cleanup of a bundle created by this attempt also fails, it reports that failure separately; the operator can run `prune` to remove unfinished bundles.
- `create` uses the configured backup directory. `--directory` is refused for this action.
- For source preservation, checked publication, lock scope and cleanup behavior, see [create guarantees and recovery](../REFERENCE.md#create-guarantees-and-recovery).

## User flow

```mermaid
flowchart TD
    A["Operator runs db:backup create"] --> B["Prepare configured backup root"]
    B --> C{"Non-WAL source with requireWal enabled?"}
    C -->|Yes| D["See refusal; fix source or configuration and retry"]
    C -->|No| E{"Source uses WAL?"}
    E -->|No| F["Continue with a non-WAL source"]
    E -->|Yes| G["Create backup"]
    F --> G
    G --> H{"Create succeeds?"}
    H -->|No| I["See error; resolve cause and retry; run prune if an unfinished bundle remains"]
    H -->|Yes| J["See bundle path and any non-WAL writer-wait warning"]
```

## Code flow

Scope: Ace create case through the `createBundle()` result and its post-acquisition `finally`. Path checks and `acquireLock()` failures happen before the lock-owning `try/finally` and do not release an unacquired lock.

```mermaid
flowchart TD
    A["DbBackup.run create case"] --> B["prepareDirectory; SqliteBackup.create; createBundle preflight"]
    B --> C{"acquireLock succeeds?"}
    C -->|No| D["Throw; no acquired lock to release"]
    C -->|Yes| E["Open source and validate journal mode and transaction state"]
    E --> F{"Source readable and WAL policy accepted?"}
    F -->|No| G["Throw E_BACKUP_SOURCE"]
    F -->|Yes| H["Create owned bundle; copy and check database"]
    H --> I["Write manifest, then READY last"]
    I --> J["Return result"]
    G --> K["Catch: remove unfinished bundle only if this call created it"]
    H -->|failure| K
    I -->|failure| K
    K --> L["Rethrow original; attach cleanupError if cleanup fails"]
    J --> M["Finally: close owned source; call lock.release()"]
    L --> M
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
  Keep inputs, decisions and recovery focused on that one action; do not create stories for its
  internal guards, helpers or technical variants.
  When splitting, preserve the original ID/path for one outcome and give the other the next unused
  ID; update catalogue references and counts together.
- Include every relevant field, including conditional and read-only fields. Record exact labels,
  required/optional state, defaults, limits, available options and dependent choices. For dynamic
  choices, describe their source and filtering rules rather than listing transient data.
- Edit forms include current-value prefills. API/library/CLI actions document real argument names,
  required values, omission/null defaults, flag/prompt behavior and limits. Verify what callbacks
  receive before assigning host policy to them.
- Move repeated or lengthy field lists, technical schemas and protocol details to one cohesive
  repository guide/reference with a direct section link. Keep relevant controls, outcomes and
  action-specific differences clear locally; do not make readers chase several links for a form.
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
  Use the owning handler/service/transaction as the default code-flow unit. Group routine field/proof
  validation into one boundary with one refusal path; field rules stay in criteria or a reference.
  Expand only for materially different access, persisted effects, commit/consumption or recovery.
  Preserve material ordering without making a node for each field, message or helper.
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
