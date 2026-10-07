# Tauri: troubleshooting

Match a Tauri symptom or error code to its cause and fix: slow or partial
views, a client that does not converge with the web, identity and database-name
errors, and closed-client rejections.

::meta{for="Developers debugging a Tauri client" time="5 minutes" first="platform-tauri-specifics"}

## Find the symptom

| Symptom or code | Cause | Where |
|---|---|---|
| A view is slow, partial, or ignores another client's writes | Version mismatch, an in-memory database, a reused client id, mismatched partitions, or serialization cost. | [below](#slow-partial-or-non-converging-views) |
| `client.identity_mismatch` | An explicit `clientId` differs from the one stored in the database. | [below](#identity-and-database-names) |
| `sync.invalid_request` on `create` | The database name is invalid, `database_dir` is unset, or the webview supplied a `dbPath`. | [below](#identity-and-database-names) |
| `client.closed` | A method ran after `close()`. | [below](#closed-client) |
| `client.security_preflight_required` | Ordinary reads or writes ran before `activateSecurity`. | [Authorized local purge](/concepts-local-data-purge/) |
| `client.authority_read_forbidden` | An authority read carried SQL, tables, or columns outside the native ceiling. | [Platform specifics](/platform-tauri-specifics/#authority-evidence-before-activation) |
| `sync.offline` | The transport gate is closed. | [Platform specifics](/platform-tauri-specifics/#local-activation-with-transport-closed) |
| `client.not_created` from `set_now_ms` | The test clock was set before a `create`. | [Platform specifics](/platform-tauri-specifics/#test-clock) |
| Network commands fail while local work succeeds | The plugin was built without `native-transport`. | [Install & first sync](/platform-tauri-install/#install-the-dependencies) |

## Slow, partial, or non-converging views

Web and Tauri clients converge in both directions. They are separate local
replicas, so they need distinct persisted client ids, the same server partition,
a compatible schema, and overlapping authorized scopes. A web mutation drains
through its outbox, commits on the server, and wakes the Tauri client over
realtime; the reverse path is identical.

When a Tauri view is slow, stays partial, or does not react to another client:

1. Confirm the npm bridge and the Rust plugin resolve to matching versions. Do
   not mix an older crate with a newer JS bridge.
2. Confirm `db_path` or `database_dir` is set and writable. Without one,
   snapshots share the mutable owner by design.
3. Let the database own its persisted client id. Do not reuse one database or one
   explicit `clientId` across devices or actors; the native transport puts the
   restored id on the realtime URL automatically.
4. Verify the HTTP and WebSocket endpoints authenticate into the same server
   partition and grants as the web client, and that both clients use the same
   generated schema version.
5. Check the surfaced sync error and the outbox count. A non-draining outbox
   points to transport, auth, or server work. An empty outbox with slow large
   queries points to result serialization or rendering; bounded windows and
   pagination fix that.

The read-path latency contract behind these checks is in
[Platform specifics](/platform-tauri-specifics/#performance-contract).

## Identity and database names

On first open the core stores a random client id in the database, and later
opens restore it. An explicit `clientId` can initialize a new database. A
different id for an existing database fails with `client.identity_mismatch`
instead of rebinding the identity.

A database name is 1 to 128 ASCII letters, digits, `-`, `_`, or `.`, starts with
a letter or digit, and contains no `..`. The plugin rejects an invalid name, a
name without a configured `database_dir`, and a webview-supplied `dbPath`, all
with `sync.invalid_request`. See
[Realtime & lifecycle](/platform-tauri-realtime/#open-one-replica-per-actor).

## Closed client

After `await client.close()`, data and control methods reject with
`client.closed` before they check security preflight. Local listener
registration and progress reads throw the same code. `close()` stays idempotent.
Create a new client for later work, and dispose session listeners together with
their client.
