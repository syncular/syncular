# Using The Local Rust Syncular Client

This guide is for trying the current Rust-first Syncular client from another
local Rust project before the crates are published.

For a shorter cross-platform API reference, see
[`GENERATED_CLIENT_API.md`](GENERATED_CLIENT_API.md). This file remains the full
setup and integration checklist.

The local Syncular repo root used in these examples is:

```text
/Users/bkniffler/conductor/workspaces/syncular/indianapolis
```

## 1. Add Local Dependencies

In your app's `Cargo.toml`, point at the local SDK crate:

```toml
[dependencies]
diesel = { version = "2.2", features = ["sqlite", "returning_clauses_for_sqlite_3_35"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
syncular-client = { path = "/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/crates/client", default-features = false, features = ["native", "crdt-yjs"] }
```

Use `syncular-client` in app code. It re-exports the runtime and is the
developer-facing Rust SDK. The `native,crdt-yjs` no-default profile is covered
by Syncular's native checks and is the intended app profile for native clients
that use CRDT/Yjs fields without enabling the demo CLI or testkit.

## 2. Create Migrations

Create Diesel-style migration folders in your app:

```text
your-app/
  migrations/
    0001_initial/
      up.sql
    0002_blob_client_tables/
      up.sql
    0003_retry_backoff/
      up.sql
```

Migrations should declare your app replica tables. Syncular runtime system
tables are installed by the runtime itself; if older example migrations still
contain `sync_*` DDL, codegen strips those statements from generated app
migrations before embedding them.

Use the example app as the template:

```bash
cp -R /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/examples/todo-app/migrations ./migrations
```

Then edit the app-table DDL in `migrations/0001_initial/up.sql`. New apps
should not add runtime-owned `sync_*` tables to app migrations.

Current app-table rules:

- each app table needs exactly one primary key column.
- each app table needs a configured server-version column, usually
  `server_version BIGINT NOT NULL DEFAULT 0`.
- writes must go through generated Syncular mutations, not raw SQL
  `INSERT`/`UPDATE`/`DELETE`.
- reads stay normal Diesel query-builder expressions.

## 3. Add `syncular.codegen.json`

Create `syncular.codegen.json` next to your app's `Cargo.toml`.

Minimal example:

```json
{
  "tables": {
    "tasks": {
      "subscriptionId": "sub-tasks",
      "scopes": [
        {
          "name": "user_id",
          "column": "user_id",
          "source": "actorId",
          "required": true
        },
        {
          "name": "project_id",
          "column": "project_id",
          "source": "projectId",
          "required": false
        }
      ],
      "serverVersionColumn": "server_version",
      "blobColumns": ["image"],
      "crdtYjsFields": [
        {
          "field": "title",
          "stateColumn": "title_yjs_state",
          "containerKey": "title",
          "kind": "text"
        }
      ]
    }
  }
}
```

Useful fields:

- `tables`: app tables that Syncular should generate metadata/mutations for.
- `subscriptionId`: server subscription id for this table.
- `scopes`: how default subscriptions are built from client config.
- `serverVersionColumn`: required optimistic-sync version column.
- `softDeleteColumn`: optional column used for generated soft-delete mutation
  semantics.
- `blobColumns`: optional blob reference columns.
- `crdtYjsFields`: optional Yrs/Yjs-backed CRDT fields. The app table must
  have both the materialized field and a nullable text state column, for example
  `title TEXT NOT NULL` plus `title_yjs_state TEXT NULL`.
- `subscriptionParams`: optional static params sent with default subscriptions.
- `schemaOutputPath`: defaults to `syncular.schema.json`.
- `typescriptOutputPath`: defaults to
  `generated/typescript/syncular.generated.ts`.
- `nativeSwiftOutputPath`: defaults to `generated/swift/SyncularApp.swift`.
- `nativeKotlinOutputPath`: defaults to `generated/kotlin/SyncularApp.kt`.

The generator emits TypeScript/Swift/Kotlin too, but for a Rust-only app you
can ignore those generated files.

## 4. Run Codegen

From anywhere, run the local generator against your app directory:

```bash
cargo run \
  --manifest-path /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/Cargo.toml \
  -p syncular-codegen \
  -- \
  --manifest-dir /absolute/path/to/your-app
```

Generated Rust files are written to:

```text
generated/rust/schema.rs
generated/rust/diesel_tables.rs
generated/rust/migrations.rs
generated/rust/syncular.rs
```

The cross-platform schema contract is written to:

```text
syncular.schema.json
```

To verify generated files are current:

```bash
cargo run \
  --manifest-path /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/Cargo.toml \
  -p syncular-codegen \
  -- \
  --manifest-dir /absolute/path/to/your-app \
  --check
```

## 5. Include Generated Rust Modules

Create something like `src/generated.rs`:

```rust
pub mod schema {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/rust/schema.rs"
    ));
}

pub mod syncular {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/rust/syncular.rs"
    ));
}

pub mod diesel_tables {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/rust/diesel_tables.rs"
    ));
}

pub mod migrations {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/rust/migrations.rs"
    ));
}
```

Then expose it from `src/lib.rs` or `src/main.rs`:

```rust
mod generated;
```

## 6. Open A Client With Your Generated Schema

```rust
use syncular_client::app_schema::AppSchema;
use syncular_client::client::{SyncularClient, SyncularClientConfig};

use crate::generated::{diesel_tables, migrations, syncular};

fn app_schema() -> AppSchema {
    AppSchema {
        app_tables: syncular::APP_TABLES,
        app_table_metadata: syncular::APP_TABLE_METADATA,
        migrations: migrations::MIGRATIONS,
        default_subscriptions: syncular::default_subscriptions,
        adapter_for: diesel_tables::adapter_for,
    }
}

fn open_client() -> syncular_client::error::Result<SyncularClient> {
    let config = SyncularClientConfig {
        db_path: "syncular.sqlite".to_string(),
        base_url: "http://localhost:9811/api/sync".to_string(),
        client_id: "rust-local-client".to_string(),
        actor_id: "user-rust".to_string(),
        project_id: Some("project-rust".to_string()),
    };

    SyncularClient::open_with_schema(config, app_schema())
}
```

`open_with_schema` applies your generated app migrations from embedded SQL,
installs Syncular runtime system tables, builds default subscriptions from your
config, and uses generated table adapters for sync changes.

## 7. Auth Headers

App code owns auth. Set headers before sync calls when your server requires
auth:

```rust
use syncular_client::transport::SyncAuthHeaders;

let mut headers = SyncAuthHeaders::new();
headers.insert("authorization".to_string(), format!("Bearer {token}"));
client.set_auth_headers(headers);
```

Native UI apps can refresh auth on the existing worker before the next sync or
realtime reconnect. HTTP 401/403 sync failures surface as an `AuthExpired`
native event with the original `commandId`, so the host can correlate the failed
foreground action, refresh headers, and enqueue another sync without reopening
SQLite.

When a browser or native UI returns to the foreground, prefer the runtime-owned
resume hook over manually restarting internal pieces. In browser apps, call
`database.client.resumeFromBackground()` after refreshing any host auth state.
In Swift/Kotlin/Java BoltFFI hosts, call `resumeFromBackground()` on the native
client. The native runtime resumes the worker if needed, restarts realtime, and
enqueues a command-correlated sync; the browser worker marks lifecycle as
`recovering`, restarts remembered realtime options, and resolves with the
normal `syncOnce` result. Foreground resume is intentionally limited to
sync/realtime recovery. Blob uploads, blob cache maintenance, and storage
compaction should be scheduled through their explicit queued APIs only when the
host app has enough background execution budget and the current battery/network
policy allows that work.

Swift/Kotlin/JVM native apps also need subscriptions before sync when opening
with injected `appSchemaJson`. Generated app clients now emit subscription
helpers, so normal app code should avoid hand-written subscription JSON:

```swift
let args = SyncularSubscriptionArgs(actorId: actorId, projectId: projectId)
try client.setSubscriptionsJson(
    subscriptionsJson: syncularSubscriptionsJson([taskSubscription(args: args)])
)
```

```kotlin
client.setSubscriptionsJson(
    syncularSubscriptionsJson(
        listOf(taskSubscription(SyncularSubscriptionArgs(actorId = actorId, projectId = projectId))),
    ),
)
```

Use `syncularDefaultSubscriptionsJson(actorId:projectId:)` /
`syncularDefaultSubscriptionsJson(actorId = ..., projectId = ...)` when the app
wants all generated table subscriptions. Use the per-table helpers when a view
or app shell intentionally syncs a smaller set.

### Staged Bootstrap

Generated subscriptions support local-only bootstrap phases. Lower phases start
first; ready or already-bootstrapping later phases continue to participate in
pull requests. Use this to make the app shell usable without pretending that
later scopes are complete.

Rust:

```rust
let config = SyncularClientConfig {
    db_path: "syncular.sqlite".to_string(),
    base_url: "http://localhost:9811/api/sync".to_string(),
    client_id: "rust-local-client".to_string(),
    actor_id: "user-rust".to_string(),
    project_id: Some("project-rust".to_string()),
};

let subscriptions = syncular::default_subscriptions_with_bootstrap_phases(
    &config,
    &[
        ("projects", 0),
        ("tasks", 1),
        ("comments", 2),
    ],
);

let mut client = SyncularClient::open_with_schema(config, app_schema())?;
client.set_subscriptions(subscriptions);
```

Browser/TypeScript generated app client:

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId,
    clientId,
    projectId,
    pull: {
      criticalBootstrapPhase: 0,
      interactiveBootstrapPhase: 1,
    },
  },
  bootstrapPhases: {
    projects: 0,
    tasks: 1,
    comments: 2,
  },
});

const result = await syncular.client.syncOnce();

if (result.bootstrap.criticalReady) {
  showShell();
}

syncular.client.addEventListener('bootstrapChanged', (bootstrap) => {
  if (bootstrap.interactiveReady) showPrimaryViews();
  if (bootstrap.complete) showAllViews();
});
```

Swift/Kotlin generated subscriptions accept the same phase map:

```swift
let subscriptionsJson = try syncularDefaultSubscriptionsJson(
    actorId: actorId,
    projectId: projectId,
    bootstrapPhases: [
        "projects": 0,
        "tasks": 1,
        "comments": 2,
    ]
)
```

```kotlin
val subscriptionsJson = syncularDefaultSubscriptionsJson(
    actorId = actorId,
    projectId = projectId,
    bootstrapPhases = mapOf(
        "projects" to 0L,
        "tasks" to 1L,
        "comments" to 2L,
    ),
)
```

Browser sync results expose aggregate readiness as `result.bootstrap` and emit
`bootstrapChanged` events after worker/realtime syncs. Native `SyncCompleted`
worker events expose the same readiness shape as `bootstrap`; generated Swift
and Kotlin clients decode it as `SyncularBootstrapStatus`.

Do not render missing later-phase data as an empty result while
`complete == false`. Gate each view on the relevant phase or subscription id.

## 8. Client-Side Field Encryption

The Rust client can encrypt configured fields on push and decrypt them on pull
while keeping local SQLite/outbox rows plaintext. The server sees ciphertext
only for encrypted columns.

Declare encrypted columns in `syncular.codegen.json`:

```json
{
  "tables": {
    "tasks": {
      "serverVersionColumn": "server_version",
      "encryptedFields": [{ "field": "title" }]
    }
  }
}
```

The generated clients turn that schema metadata into field-encryption rules, so
app code only supplies keys and optional key settings.

```rust
use syncular_client::encryption::{
    FieldEncryption, StaticFieldEncryptionConfig,
};
use your_app::generated::syncular::generated_field_encryption_rules;
use std::collections::BTreeMap;

let mut keys = BTreeMap::new();
keys.insert("default".to_string(), "base64url-or-hex-32-byte-key".to_string());

client.set_field_encryption(Some(FieldEncryption::from_static_config(
    StaticFieldEncryptionConfig {
        rules: generated_field_encryption_rules(),
        keys,
        encryption_kid: Some("default".to_string()),
        decryption_error_mode: None,
        envelope_prefix: None,
    },
)?));
```

Generated TypeScript exposes the same rule set:

```ts
await database.client.setFieldEncryption(
  syncularGeneratedFieldEncryptionConfig({
    keys: { default: keyMaterial },
    encryptionKid: 'default',
  })
);
```

Generated Swift/Kotlin expose `syncularGeneratedFieldEncryptionConfigJson(...)`
for passing the same config into `setFieldEncryptionJson(...)` on the native
binding.

Useful helpers are available under `syncular_client::encryption`:

```rust
use syncular_client::encryption::{
    generate_symmetric_key, key_to_mnemonic, wrap_key_for_recipient,
    generate_x25519_keypair, derive_scoped_passphrase_key_pbkdf2,
    derive_passphrase_key_argon2id,
};
```

Compatibility notes:

- field envelopes match the existing JS plugin format.
- symmetric field encryption uses XChaCha20-Poly1305.
- asymmetric key sharing uses X25519 + HKDF-SHA256 + XChaCha20-Poly1305.
- PBKDF2 scoped derivation exists for the old demo/passphrase flow.
- Argon2id is preferred for new passphrase-derived keys.

## 9. Type-Safe Reads With Diesel

Reads are normal Diesel query-builder expressions. The SDK owns the SQLite
connection, so app code never receives or passes `SqliteConnection`.

```rust
use diesel::prelude::*;

use crate::generated::{diesel_tables::TaskRow, schema};

let tasks: Vec<TaskRow> = client.read(
    schema::tasks::dsl::tasks
        .filter(schema::tasks::dsl::user_id.eq("user-rust"))
        .order(schema::tasks::dsl::server_version.desc())
        .select(TaskRow::as_select()),
)?;
```

Do not use raw Diesel inserts/updates/deletes against app tables. That bypasses
the local-row/outbox/conflict path.

## 10. Outbox-Safe Mutations

Generated mutations mirror the pre-Rust Syncular JS shape: table namespace,
typed insert/patch/delete DTOs, and one Syncular outbox path.

```rust
use crate::generated::syncular;
use syncular::prelude::SyncularGeneratedMutationsExt;

let inserted = client.mutations().tasks().insert(
    syncular::NewTask::with_generated_id(
        "Ship Rust",
        "user-rust",
        Some("project-rust"),
    ),
)?;

client
    .mutations()
    .tasks()
    .update(syncular::TaskPatch::new(&inserted.id).completed(1))?;

client.mutations().tasks().delete(&inserted.id)?;
```

Batch multiple mutations into one outbox commit:

```rust
let batch = client.commit(|tx| {
    let id = tx.tasks().insert(syncular::NewTask::with_generated_id(
        "Batched task",
        "user-rust",
        Some("project-rust"),
    ))?;

    tx.tasks().update(syncular::TaskPatch::new(&id).completed(1))?;
    Ok(id)
})?;

println!("queued commit {}", batch.commit.client_commit_id);
```

## 11. Yrs/Yjs CRDT Mutations

For configured `crdtYjsFields`, generated Rust mutations get typed envelope
helpers. Local SQLite rows are materialized immediately, but the outbox
operation keeps `__yjs` so the server-side Yjs push plugin can merge concurrent
updates.

```rust
use syncular_client::crdt_yjs::{build_yjs_text_update, BuildYjsTextUpdateArgs};

let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
    previous_state_base64: existing_task.title_yjs_state.clone(),
    next_text: "Edited title".to_string(),
    container_key: Some("title".to_string()),
    update_id: None,
})?;

client.mutations().tasks().update(
    syncular::TaskPatch::new(&existing_task.id)
        .title_yjs_update(update.update),
)?;
```

The browser generated TypeScript client accepts the same `__yjs` envelope in
mutation payloads and the Rust-owned Worker materializes the local row before
writing SQLite.

For host/runtime code that should not depend on a generated table helper, use
the generic field identity APIs:

```rust
use syncular_client::crdt_field::CrdtFieldId;

let field = client.open_crdt_field(CrdtFieldId::new(
    "tasks",
    &existing_task.id,
    "title",
))?;

client.apply_crdt_field_text(&field, "Edited title")?;

let materialized = client.materialize_crdt_field(&field)?;
println!("title = {}", materialized.value);
```

Encrypted CRDT fields use the same generic field APIs, but the schema must mark
the field with `syncMode: "encrypted-update-log"`:

```json
{
  "crdtYjsFields": [
    {
      "field": "body",
      "stateColumn": "body_yjs_state",
      "kind": "text",
      "syncMode": "encrypted-update-log"
    }
  ]
}
```

This creates support for the shared hidden `sync_crdt_updates` and
`sync_crdt_checkpoints` tables. Generated Rust clients expose table-field text
and checkpoint helpers, for example:

```rust
client.set_encrypted_crdt(Some(encrypted_crdt_config));

client
    .mutations()
    .tasks()
    .update_title_text(&task_id, "Encrypted title")?;

client
    .mutations()
    .tasks()
    .checkpoint_title_text(&task_id, 10)?;
```

Generated default subscriptions include the app table plus the encrypted CRDT
update/checkpoint system-table subscriptions, for example
`tasks_title_crdt_updates_subscription(...)` and
`tasks_title_crdt_checkpoints_subscription(...)` in Rust, or
`taskTitleCrdtUpdatesSubscription(args)` and
`taskTitleCrdtCheckpointsSubscription(args)` in TypeScript. If an app supplies
custom subscriptions, it must include both system-table subscriptions for every
encrypted-update-log field it wants to sync.

The hidden outbox operation contains ciphertext only; local native/browser
SQLite materializes decrypted updates back into the app row. Encrypted update
payloads also carry their required Yjs base state vector inside the ciphertext.
If local state is missing or stale, sync fails with `resyncRequired`; call
`force_subscriptions_bootstrap(&[])` on Rust/native or
`forceSubscriptionsBootstrap()` in the browser worker, then sync again so the
app/update/checkpoint subscriptions recover from canonical snapshots.

## 12. Sync

HTTP push/pull:

```rust
let report = client.sync_http()?;

if report.changes_table("tasks") {
    println!("tasks changed");
}

if report.conflicts_changed {
    println!("conflicts changed");
}
```

WebSocket push path:

```rust
let report = client.sync_ws()?;
```

Watch realtime wakeups for a bounded interval:

```rust
use syncular_client::transport::RealtimeEvent;

client.watch(30, |event| {
    if matches!(event, RealtimeEvent::Sync) {
        println!("server requested sync");
    }
})?;
```

## 13. Conflicts

The low-level summaries still exist, but new code should prefer the namespaced
helper API:

```rust
let pending = client.conflicts().pending()?;

for conflict in pending {
    println!("conflict {}: {}", conflict.id, conflict.message);

    // Requeue the rejected local mutation using the server version as the new
    // base version.
    let receipt = client.conflicts().keep_local(&conflict.id)?;
    println!("retry commit {:?}", receipt.retry_client_commit_id);
}
```

Other resolution helpers:

```rust
client.conflicts().accept_server(conflict_id)?;
client.conflicts().dismiss(conflict_id)?;
```

`accept_server` and `dismiss` mark the conflict resolved. `keep_local` also
queues a retry commit.

## 14. Typed Live Queries

Live queries keep Diesel semantics. You declare table dependencies and provide
a closure that rebuilds the Diesel query.

```rust
use diesel::prelude::*;
use crate::generated::{diesel_tables::TaskRow, schema};

let mut live_tasks = client.live_query(["tasks"], || {
    schema::tasks::dsl::tasks
        .filter(schema::tasks::dsl::user_id.eq("user-rust"))
        .order(schema::tasks::dsl::server_version.desc())
        .select(TaskRow::as_select())
})?;

render(live_tasks.rows());
```

Refresh after sync only when relevant tables changed:

```rust
let report = client.sync_http()?;

if live_tasks.refresh_if_changed(&mut client, &report)? {
    render(live_tasks.rows());
}
```

Refresh after local mutations by emitting a local table-change report:

```rust
client.mutations().tasks().insert(syncular::NewTask::with_generated_id(
    "Local task",
    "user-rust",
    Some("project-rust"),
))?;

let local_report = syncular_client::client::SyncReport::table_changed("tasks");
live_tasks.refresh_if_changed(&mut client, &local_report)?;
```

You can also force a refresh:

```rust
live_tasks.refresh(&mut client)?;
```

## 15. Blobs

Blob columns should be listed in `syncular.codegen.json` under `blobColumns`.

Store bytes locally and queue upload:

```rust
let blob = client.store_blob_bytes(image_bytes, "image/png", false)?;
```

Store bytes and upload immediately:

```rust
let blob = client.store_blob_bytes(image_bytes, "image/png", true)?;
```

Use the generated blob column in your mutation payload according to the
generated type for that table. Process queued uploads:

```rust
let result = client.process_blob_upload_queue()?;
println!("uploaded {}, failed {}", result.uploaded, result.failed);
```

Read bytes later:

```rust
let bytes = client.retrieve_blob_bytes(&blob)?;
```

## 16. Quick Smoke Test

After codegen, this should compile and run in your app:

```rust
fn main() -> syncular_client::error::Result<()> {
    let mut client = open_client()?;

    let inserted = client.mutations().tasks().insert(
        syncular::NewTask::with_generated_id(
            "Local smoke",
            "user-rust",
            Some("project-rust"),
        ),
    )?;

    let rows: Vec<diesel_tables::TaskRow> = client.read(
        schema::tasks::dsl::tasks
            .filter(schema::tasks::dsl::id.eq(&inserted.id))
            .select(diesel_tables::TaskRow::as_select()),
    )?;

    assert_eq!(rows.len(), 1);
    Ok(())
}
```

Adjust module paths to match where you put `generated.rs`.

## 17. Known Local-Only Caveats

- The crates are not published yet; use path dependencies.
- Keep generated files checked into the app while developing. They are what
  rust-analyzer and the compiler use for dev-time types.
- The generator currently writes all target outputs. For a Rust-only test,
  ignore the TypeScript/Swift/Kotlin outputs.
- The current native Rust path is the strongest path. Swift/Kotlin generated
  query builders now exist, but should still be treated as early app-side DSLs
  over the stable `queryJson` binding.
- Native release packaging is local but repeatable now:
  `bash rust/scripts/package-native-bindings.sh --all` writes fresh Swift,
  Android, Android Maven/AAR, and JVM artifacts to `.context/native-packages`.
  Use `bun run rust:native:release-check` as the full local native release
  gate: Apple package, Android AAR/local Maven package, current-host JVM,
  Linux x86_64 JVM, and the generated native smoke.
  Use `SYNCULAR_NATIVE_PACKAGE_OUT=/path/to/out` when copying artifacts into a
  consuming app. The Android low-level binding is packaged as
  `dev.syncular:syncular-android:<runtime-version>` in the generated local
  Maven repository. Desktop JVM packaging defaults to the current host; Linux
  x86_64 can be built with `bash rust/scripts/package-native-bindings.sh
  --java-linux-x86_64` after installing `x86_64-unknown-linux-gnu` and `zig`.
  Windows JVM artifacts need a Windows host/runner with the current BoltFFI
  packaging backend.
- CI coverage exists for local integration hardening, but the crates/packages
  are not published yet; use path dependencies until published packages are cut.

## 18. Local Native Generated-Client Smoke

To validate the generated Swift/Kotlin app clients locally without pushing CI,
run this from the Syncular repo root:

```bash
bun run rust:native-smoke
```

That compiles and runs:

- `rust/examples/todo-app/generated/swift/SyncularApp.swift`
- `rust/examples/todo-app/native-smokes/swift/GeneratedClientSmoke.swift`
- `rust/examples/todo-app/generated/kotlin/SyncularApp.kt`
- `rust/examples/todo-app/native-smokes/kotlin/GeneratedClientSmoke.kt`
- the Swift/Kotlin/JVM BoltFFI host smokes, lifecycle command-line smokes, and
  real Hono server sync smokes

The first generated-client stage uses a mock `SyncularNativeJsonClient`, so it
checks generated query SQL, subscription JSON, mutation JSON, live-query
registration, event filtering, and refresh behavior. Later stages link the real
native library, exercise the same generated APIs against local SQLite, then
start a local Hono sync server and prove Swift/Kotlin can set auth, set
generated subscriptions, receive command-correlated `AuthExpired` for stale
auth, refresh headers on the hot worker, enqueue sync, query pulled rows, push
generated task mutations over HTTP and WebSocket, resolve a server version
conflict with keep-local retry, clear conflicts with keep-server/dismiss, and
pull those pushed/resolved rows into a second native client. The same server
smokes mount the real Hono blob routes and prove Swift/Kotlin can store a blob
file through the native binding, upload it from the queue, sync a generated
task `BlobRef`, pull that row into another native client, and retrieve the
blob bytes back through the binding. They also prove stale-auth blob uploads
stay retryable, become failed after max attempts, and keep local cache bytes
available for recovery, and that missing remote blobs surface a 404 without
being cached locally. They also prove generated field-level
E2EE config against that Hono server: the writer pushes an encrypted title, an
unencrypted reader sees the ciphertext envelope, and an encrypted reader pulls
plaintext. The same run verifies native subscription revocation by switching
the generated task subscription to an unauthorized actor scope, clearing the
local scoped row, restoring the valid scope, and pulling the row again. It
also registers generated Swift/Kotlin live queries before a server pull and
refreshes typed rows from the native `QueriesChanged` event after
`SyncCompleted`. Native schema negotiation is covered too: a Hono route with a
future `requiredSchemaVersion` produces a command-correlated `SyncFailed`
event, while a route with only a future `latestSchemaVersion` still completes
sync. Client-id ownership is covered as well: a second native client reusing
the same client id with a different authenticated actor receives the server's
HTTP ownership failure as a native `SyncFailed` event.

For real app-shell validation, run:

```bash
bash rust/examples/todo-app/native-smokes/ios-lifecycle/run-local.sh
bash rust/examples/todo-app/native-smokes/android-lifecycle/run-local.sh
```

## 19. Native App Lifecycle Rules

For Swift, Kotlin/Android, and JVM UI apps, treat the low-level native binding
as a long-lived runtime object, not as a per-screen helper:

- open the database once per app/session and call the generated runtime/schema
  assertion before showing data from that store.
- keep SQLite open, migration, schema validation, and native library loading
  away from UI-critical startup paths. Use `SyncularBoltClient(openAsync:)` on
  Swift, `SyncularBoltClient.openAsync(config)` on Kotlin/JVM, or
  `syncular_native_client_open_async_finish_timeout(...)` from C when app
  startup needs an async shell state before the native runtime is ready.
- prefer queued APIs for writes and bursty work:
  `enqueueMutationJson`, `enqueueSyncNow`, `enqueueSyncWebsocket`, queued CRDT
  text/compaction helpers, queued blob file operations, queued snapshot
  refresh, queued blob upload processing, and queued storage compaction. These
  return command ids immediately and report durability later. Use
  `enqueueSyncNow` for the normal HTTP path; use `enqueueSyncWebsocket` when
  the server route supports Syncular's WebSocket push transport.
- start the native event stream once, read `nextEventJson()` from a background
  task, and update UI state by ordered `eventSeq` plus `commandId`. Events
  include rows/query changes, command completion/failure, sync state, conflicts,
  CRDT field changes, and blob work. `BlobUploadsChanged` carries
  `lifecycle.blobUploads` with pending/uploading/failed counts, so UI shells
  can show failed or pending uploads without polling Syncular system tables.
  `RowsChanged`, `QueriesChanged`, `SyncCompleted`, and
  `LocalWriteCommitted` also include `changedRows` when the runtime can derive
  precise row/field deltas. Use those deltas to route active-document CRDT
  updates, list row refreshes, deletes, and conflict indicators before falling
  back to table-level refresh.
- refresh auth headers before foreground recovery, then call
  `resumeFromBackground()` instead of independently poking realtime and sync. A
  stale HTTP 401/403 sync response is reported as `AuthExpired` with the
  original command id.
- set generated subscriptions with `setSubscriptionsJson` before the first sync
  when opening native clients with injected `appSchemaJson`.
- when backgrounding, only enqueue sync/blob/compaction work that fits the host
  platform's background execution budget. Prefer `resumeFromBackground()` for
  foreground sync/realtime recovery, and schedule queued blob upload/cache or
  compaction work separately based on app policy. The native lifecycle smokes
  model this as a small host policy object: restricted background state does
  not enqueue upload/compaction work, while foreground policy may call
  `enqueueProcessBlobUploadQueue()` and `enqueueCompactStorageJson(...)`.
- close the event stream and call the explicit native lifecycle method
  (`shutdown()` in BoltFFI wrappers) during app teardown.
- initialize CRDT-backed text fields empty or with existing Yjs state before
  queued text replacement. The runtime rejects replacing populated legacy
  plaintext without Yjs state to prevent duplicated or blank editor content.
- treat `resyncRequired` diagnostics as a lost local CRDT/snapshot base. Reset
  subscription state with the generated/native force-bootstrap helper and run a
  normal sync; do not try to manually patch the app row or CRDT system tables.

## 20. Typed Row Delta Helpers

The runtime emits schema-agnostic `changedRows` on sync, local write, live
query, and native worker events. Codegen turns those generic rows into
table-specific helpers in each generated app client so UI code can route
precise row/field changes without hard-coded string checks.

Browser/TypeScript:

```ts
import { syncularChangedRows } from './generated/syncular.browser';

syncular.client.addRowsChangedListener((event) => {
  for (const task of syncularChangedRows.tasks(event)) {
    if (task.isDelete) removeTask(task.rowId);
    if (task.changed.title || task.changed.completed) refreshTask(task.rowId);
    if (task.crdt.title_yjs_state) refreshActiveEditor(task.rowId);
  }
});
```

Rust:

```rust
for task in generated::syncular::task_changed_rows(&event.changed_rows) {
    if task.is_delete() {
        remove_task(task.row_id());
    }
    if task.changed.title || task.changed.completed {
        refresh_task(task.row_id());
    }
    if task.crdt.title_yjs_state {
        refresh_active_editor(task.row_id());
    }
}
```

Swift:

```swift
for task in taskChangedRows(in: event) {
    if task.isDelete { removeTask(task.rowId) }
    if task.changed.title || task.changed.completed { refreshTask(task.rowId) }
    if task.crdt.titleYjsState { refreshActiveEditor(task.rowId) }
}
```

Kotlin/JVM/Android:

```kotlin
for (task in taskChangedRows(event)) {
    if (task.isDelete) removeTask(task.rowId)
    if (task.changed.title || task.changed.completed) refreshTask(task.rowId)
    if (task.crdt.titleYjsState) refreshActiveEditor(task.rowId)
}
```

Use these helpers for UI invalidation, active CRDT document refresh, conflict
badges, and narrow list updates. `changedRows` operations are normalized to
`insert`, `update`, and `delete` for row mutations; CRDT compaction events may
also report the affected CRDT state column so hosts can refresh materialized
document state.
