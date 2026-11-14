# US-OP-07 — Run a stopped-server operator command

As a host developer, I want to guard a custom Ace command with `operatorDatabasePath()` and `withOperatorDatabase()` so that it changes the SQLite database only while the server is stopped and no other process has the file open.

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
- `withOperatorDatabase` sets `busy_timeout = 0` and `locking_mode = EXCLUSIVE` on the only handle and takes the lock with `BEGIN EXCLUSIVE; COMMIT`. If another process holds the file it throws `Another process holds this database; stop the server and retry` and `run` never starts.
- The pool is closed after success and after every failure. When a cleanup step also fails, an `AggregateError` carries the first failure and the cleanup failure in order.

## User flow

```mermaid
flowchart TD
    A["Operator stops the server and runs the host command with --confirm-server-stopped"] --> B{"Confirmed, single-connection SQLite, existing file?"}
    B -->|No| C["See refusal; fix flag or pool configuration"]
    B -->|Yes| D{"Exclusive lock obtained?"}
    D -->|No| E["See Another process holds this database; stop it and retry"]
    D -->|Yes| F["Command work runs on the locked handle"]
    F --> G["Connections close; command reports its result or error"]
    E --> G
```

## Code flow

Scope: the two exported helpers; the host command and its work are outside the package.

```mermaid
flowchart TD
    A["Host command"] --> B["operatorDatabasePath(db, confirmServerStopped)"]
    B -->|Refused| X["Throw before any connection is opened"]
    B -->|Path returned| C["withOperatorDatabase(db, run)"]
    C --> D["acquireConnection; busy_timeout 0; locking_mode EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT"]
    D --> E["releaseConnection back to the pool"]
    E --> F{"Lock acquired?"}
    F -->|No| G["Throw Another process holds this database"]
    F -->|Yes| H["await run(connection)"]
    H --> I["db.manager.closeAll()"]
    G --> I
    I --> J{"Earlier failure or closeAll failure?"}
    J -->|Both| K["Throw AggregateError"]
    J -->|One| L["Throw it"]
    J -->|None| M["Return run result"]
```

**Code references:** [operator helpers](../../src/operator.ts), [package exports](../../index.ts), [operator tests](../../tests/operator.spec.ts), [README operator contract](../../README.md#stopped-server-operator-commands).
