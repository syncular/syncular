# Syncular remote operation protocol

- Status: normative, revision 1
- HTTP content type: `application/vnd.syncular.operations.v1+json`

This protocol serves database-less processes that need authoritative reads or
server-authoritative commands. Ordinary row commits use the push-only SSP2
binding in `SPEC.md` §6.10.

An operation-only client does not require a client schema or `/sync`
transport. Those capabilities are required when it prepares and sends an
ordinary row commit.

## 1. Registry and trust boundary

The server exposes a deployment-time registry of query and command operations.
Each operation has a stable ID. A request carries the ID and encoded values.
SQL and command code stay in the server process.

Host authentication maps every HTTP request or WebSocket upgrade to an
`actorId` and partition before the operation runs. Revision 1 is
partition-local. If the supplied `clientId` already belongs to another actor
in that partition, the operation fails with `sync.invalid_client_id`. The
authenticated actor remains the authority; a host must not treat the
caller-supplied `clientId` as an authentication credential. Client IDs
beginning with the internal `["remote-command",` prefix are reserved and fail
with the same code.

The runtime admin API, `SyncularServerEvents`, durable server reactions, and
remote application operations are separate surfaces. Remote operations read or
change application rows. The admin API inspects Syncular runtime state.
Operational events report protocol activity. Durable reactions schedule
retained follow-up work after an accepted commit.

## 2. Registered queries

A registered query uses a generated `NamedQuery` descriptor. The descriptor
provides its ID, selected positional SQL, bind values, table dependencies,
result-column metadata, result mapper, and scope coverage. Registration fails
if result-column metadata is missing, empty, or contains duplicate names.

Before execution, storage replaces every generated application-table relation
with a derived relation that selects the table's application columns and binds
`_sync_partition` to the authenticated partition. Request values are never
interpolated into SQL. A table with `materialize: false` cannot be queried.

Storage executes the query and reads the partition's `maxCommitSeq` in one
database snapshot. A success response carries both rows and `maxCommitSeq`.
The server returns only columns named by the generated result metadata and
normalizes their database values to the declared types. A missing value, a
null for a non-nullable column, or an invalid value fails with
`operation.query_failed`.

Every query sets `maxRows` to an integer from 1 through 10,000. Storage executes
the query with `LIMIT maxRows + 1`. A larger result fails as
`operation.result_too_large`; a partial result is never returned.

### 2.1 Authorization

Every query uses one registration mode:

- `scoped`: generated coverage must contain exactly one record for every table
  read by the query and cover every scope variable declared by that table. The
  server resolves the actor's allowed scopes and verifies every covered value
  before SQL execution. Empty, duplicate, extra, or incomplete coverage fails
  closed. SYQL emits this proof only for a valid `sync query`.
- `privileged`: registration supplies a query-specific `authorize` callback.
  A false result fails with `operation.forbidden`.

The `'*'` allowed-scope value grants every value for that variable. It does not
turn a scoped query into a privileged registration.

The authored statement is checked by the current typegen SQLite analyzer.
SQLite and D1 execute that statement directly after partition rewriting.
Postgres converts bind placeholders and executes the same SQL. Applications
that register queries on Postgres MUST keep those queries within the common
SQL subset and test them against Postgres.

## 3. Registered commands

A command has a typed descriptor ID and a mandatory custom `authorize`
callback. The server also resolves normal write scopes. Command reads return
only rows authorized by those resolved scopes.

Each invocation carries a non-empty caller-owned `requestId`. The server maps
the command to the ordinary push idempotency identity:

```text
clientId       = JSON.stringify(["remote-command", actorId, request.clientId])
clientCommitId = JSON.stringify([operationId, requestId])
```

The tuple encoding prevents delimiter collisions between distinct command and
request IDs and isolates two authenticated actors that happen to supply the
same client ID. The sync server rejects ordinary SSP2 client IDs beginning
with the internal `["remote-command",` prefix, so an ordinary commit cannot
occupy a command result key.

The command callback runs after the partition write lock and the serialized
idempotency recheck. It may call `getRow(table, rowId)` and returns one or more
full-row upserts or deletes. The returned operations then use the ordinary
scope authorization, row validators, whole-commit validator, relational
constraints, commit log, idempotency record, and realtime notifier.

An applied retry returns `cached` without running the callback again. A normal
push rejection is stored and replays as `rejected`. A callback exception is a
request failure and is not a stored command outcome. Empty mutation lists fail
with `operation.invalid_request`.

The callback MUST NOT perform external side effects. It may insert a domain
event row in its returned commit. External work uses an idempotent worker or a
durable server reaction after the commit.

## 4. Value encoding

HTTP and WebSocket operation messages use UTF-8 JSON with a recursively tagged
value encoding. Tagging preserves integers, bytes, arrays, and objects without
collisions with application object keys.

| Value | Encoded form |
|---|---|
| `null` | `{"t":"null"}` |
| boolean | `{"t":"boolean","v":true}` |
| finite number | `{"t":"number","v":1.5}` |
| string | `{"t":"string","v":"x"}` |
| signed 64-bit integer / bigint | `{"t":"integer","v":"42"}` |
| bytes | `{"t":"bytes","v":"AAE="}` using standard padded base64 |
| array | `{"t":"array","v":[...]}` |
| object | `{"t":"object","v":[["key",...],...]}` |

The complete request or response object is itself encoded as an object value.
Integer text uses canonical decimal form and the range -2^63 through 2^63-1.
Base64 must use its canonical padded form.

## 5. HTTP binding

`POST <mount>/operations` accepts one encoded request. Decoded request shapes:

```ts
type Request =
  | {
      revision: 1;
      kind: 'query';
      clientId: string;
      operationId: string;
      params: unknown;
    }
  | {
      revision: 1;
      kind: 'command';
      clientId: string;
      operationId: string;
      requestId: string;
      params: unknown;
    };
```

Decoded success shapes:

```ts
type Success =
  | {
      revision: 1;
      kind: 'query';
      operationId: string;
      rows: Record<string, unknown>[];
      maxCommitSeq: number;
    }
  | {
      revision: 1;
      kind: 'command';
      operationId: string;
      requestId: string;
      status: 'applied' | 'cached' | 'rejected';
      commitSeq?: number;
      results: unknown[];
};
```

`maxCommitSeq` is a non-negative safe integer. A present command `commitSeq`
is a positive safe integer.

An operation-level failure uses an encoded response with `kind: 'error'`, a
stable `code`, `message`, and `retryable`. Host authentication failures may use
the normal HTTP JSON error response before operation decoding. A request with
another content type fails with HTTP 415.

## 6. Live query watches

`<mount>/operations/realtime` is the conventional WebSocket path. The runtime
host owns the upgrade and passes authenticated bytes to
`RemoteOperationWatchHub`.

Decoded client messages are:

```ts
type ClientMessage =
  | {
      revision: 1;
      kind: 'watch';
      watchId: string;
      clientId: string;
      operationId: string;
      params: unknown;
    }
  | { revision: 1; kind: 'unwatch'; watchId: string };
```

A watch runs the same query and authorization path as HTTP. It receives a full
replacement `snapshot` containing `rows` and `maxCommitSeq`. A commit touching
one of the descriptor's tables reruns the query. Commits arriving during a run
set one dirty flag, producing at most one pending rerun at a time. Commits for
other tables do not rerun it.

`watchId` is unique within one connection. Reusing an active ID fails with
`operation.invalid_request`. An `unwatch` removes the registration and
suppresses a query result that was still running for it.

Closing the session removes every watch. Revision 1 has no durable watch cursor
or reconnect token. The client reconnects and registers a new watch to obtain a
fresh snapshot.

## 7. Errors

| Code | Retryable | Produced when |
|---|---:|---|
| `operation.unknown` | no | The ID is absent or has the wrong operation kind |
| `operation.forbidden` | no | Scope or custom authorization denies access |
| `operation.invalid_request` | no | The message, generated query coverage, or command mutation plan is invalid |
| `operation.result_too_large` | no | The query exceeds `maxRows` |
| `operation.storage_unsupported` | no | Storage lacks authoritative query support |
| `operation.query_failed` | no | Registered SQL execution fails |
| `operation.execution_failed` | no | Registered operation code or infrastructure fails unexpectedly |

Identity binding can also produce `sync.invalid_client_id`. Normal command
commit validation can produce the `sync.*` result codes defined by `SPEC.md`.

Host validator codes follow `SPEC.md` §6.7.

## 8. Conformance

The catalog scenario `remote-producer/push-only-idempotency` requires both
pairings to accept a push-only request and return `cached` for an identical
retry without allocating another commit sequence.

Package tests additionally cover scoped query execution, partition rewriting,
command retry without a second callback run, and watch replacement snapshots.
