# Using The Local Rust Syncular Client

This guide is for trying the current Rust-first Syncular client from another
local Rust project before the crates are published.

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
syncular-client = { path = "/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/crates/client", default-features = false, features = ["native"] }
```

Use `syncular-client` in app code. It re-exports the runtime and is the
developer-facing Rust SDK.

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

For now, migrations must include both your app tables and Syncular's internal
tables, because generated `AppSchema` migrations are what
`SyncularClient::open_with_schema` applies.

Use the example app as the template:

```bash
cp -R /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/examples/todo-app/migrations ./migrations
```

Then edit `migrations/0001_initial/up.sql` app tables. Keep the internal
`sync_*` tables, `0002_blob_client_tables`, and `0003_retry_backoff` unless you
know exactly which runtime features you are removing.

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

`open_with_schema` applies your generated migrations, builds default
subscriptions from your config, and uses generated table adapters for sync
changes.

## 7. Auth Headers

App code owns auth. Set headers before sync calls when your server requires
auth:

```rust
use syncular_client::transport::SyncAuthHeaders;

let mut headers = SyncAuthHeaders::new();
headers.insert("authorization".to_string(), format!("Bearer {token}"));
client.set_auth_headers(headers);
```

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

Encrypted CRDT fields are now represented in the schema contract but are not
fully materialized by the Rust client yet. Use explicit sync mode metadata when
you want the encrypted update-log path:

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
helpers, for example `client.mutations().tasks().update_title_text(row_id,
next_text)?`, after `client.set_encrypted_crdt(...)` is configured. The hidden
outbox operation contains ciphertext only; local native/browser SQLite
materializes decrypted updates back into the app row.

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
- CI coverage exists for local integration hardening, but the crates/packages
  are not published yet; use path dependencies until release packaging is cut.

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

The smoke uses a mock `SyncularNativeJsonClient`, so it checks generated query
SQL, mutation JSON, live-query registration, event filtering, and refresh
behavior without needing a real Swift/Kotlin app shell.
