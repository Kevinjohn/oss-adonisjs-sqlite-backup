# US-OP-07 — Run a stopped-server operator command

As a host operator, I want to guard a custom Ace command with `operatorDatabasePath()` and `withOperatorDatabase()` so that it changes the SQLite database only after I confirm the server is stopped and the command holds an exclusive lock on the file.

**Status:** Operator; current public exports for host-written commands. The package ships no command that uses them.
**Access:** Host operator running a host-written command, with a Lucid primary connection that uses `better-sqlite3` with a pool of one.
**Entry:** A host command calling `operatorDatabasePath(db, confirmServerStopped)` then `withOperatorDatabase(db, run)`, typically behind a `--confirm-server-stopped` flag.
**Documentation:** [Stopped-server operator commands](../../README.md#stopped-server-operator-commands).
**Source:** [operatorDatabasePath and withOperatorDatabase](../../src/operator.ts), [package exports](../../index.ts).
**Coverage:** [Operator tests](../../tests/operator.spec.ts).

## Acceptance criteria

| Argument               | Control          | Required/default/conditions                                                                        |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `db`                   | Lucid `Database` | Required; the primary connection is checked                                                        |
| `confirmServerStopped` | Boolean          | Required; `false` refuses with `Refusing without --confirm-server-stopped`                         |
| `run(connection)`      | Async callback   | Required for `withOperatorDatabase`; receives the pool's only handle, which Lucid queries also use |

- `operatorDatabasePath` is called before any connection is opened. It refuses a connection that is not `better-sqlite3` with `pool.max` of 1, an in-memory database, and a path that is not an existing regular file; it returns the file path.
- `withOperatorDatabase` sets `busy_timeout = 0` and `locking_mode = EXCLUSIVE` on the only handle and takes the lock with `BEGIN EXCLUSIVE; COMMIT`. If `BEGIN EXCLUSIVE` fails it throws `Another process holds this database; stop the server and retry`. A PRAGMA failure keeps its own error. `run` starts only after the lock setup and the connection release both succeed.
- The helpers do not detect a running server; stopping it is the operator's responsibility, confirmed through `confirmServerStopped`.
- `db.manager.closeAll()` is attempted after success and after every failure. A cleanup failure is reported: alone when nothing failed earlier, otherwise in an `AggregateError` carrying the first failure and the cleanup failure in order.

## User flow

```mermaid
flowchart TD
    A["Operator stops the server and runs the host command with --confirm-server-stopped"] --> B{"Confirmed, single-connection SQLite, existing file?"}
    B -->|No| C["See refusal; fix flag or pool configuration"]
    B -->|Yes| D{"Exclusive lock obtained?"}
    D -->|No| E["See Another process holds this database, or the setup or release error; stop the server and retry"]
    D -->|Yes| F["Command work runs on the locked handle"]
    F --> G["Pool close attempted; command reports its result or error"]
    E --> G
```

## Code flow

Scope: the two exported helpers; the host command and its work are outside the package.

```mermaid
flowchart TD
    A["Host command"] --> B["operatorDatabasePath(db, confirmServerStopped)"]
    B -->|Refused| X["Throw before any connection is opened"]
    B -->|Path returned| C["withOperatorDatabase(db, run)"]
    C --> D["acquireConnection"]
    D -->|Throws| I["db.manager.closeAll()"]
    D --> S["busy_timeout 0; locking_mode EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT"]
    S -->|PRAGMA fails| P["Record that error as the lock failure"]
    S -->|BEGIN EXCLUSIVE fails| Q["Record Another process holds this database"]
    S -->|Succeeds| E["releaseConnection back to the pool"]
    P --> E
    Q --> E
    E --> F{"Lock failure or release failure?"}
    F -->|Both| R["Throw AggregateError Operator lock release failed"]
    F -->|One| G["Throw it"]
    F -->|None| H["await run(connection)"]
    H --> I
    G --> I
    R --> I
    I --> J{"Earlier failure or closeAll failure?"}
    J -->|Both| K["Throw AggregateError"]
    J -->|One| L["Throw it"]
    J -->|None| M["Return run result"]
```

**Code references:** [operator helpers](../../src/operator.ts), [package exports](../../index.ts), [operator tests](../../tests/operator.spec.ts), [README operator contract](../../README.md#stopped-server-operator-commands).
