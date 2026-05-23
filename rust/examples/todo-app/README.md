# Todo App Generated Client Fixture

This example is the app-owned generator target for the Rust rewrite.

The typed app contract in `syncular.app.ts` is the source of truth for table
sync metadata. Generate the Rust-codegen handoff JSON from that contract into
`generated/syncular.codegen.json` instead of editing generated JSON by hand:

```bash
bun --cwd rust/examples/todo-app codegen:config
```

Then run the Rust generator from the repo root:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app
```

Or run both steps from the example package:

```bash
bun --cwd rust/examples/todo-app codegen
```

The generated files under `generated/` are intentionally app-local fixtures.
Framework packages should import them only from tests and examples; production
apps should generate the same shape into their own source tree.
The root `syncular.schema.json` is the generated cross-platform metadata
contract that the app-specific TypeScript, Rust, Swift, and Kotlin generators
consume before emitting target code.

The checked server-handler example in `server-handlers.ts` shows the intended
server-side shape: generated table contracts and schema-version projection
helpers, with app-owned authorization, snapshots, writes, and server/client row
translation.

```bash
bun test rust/examples/todo-app/server-handlers.test.ts
```

The Rust example crate compiles those generated files directly. Its tests prove
that the generated Diesel schema, Diesel table adapters, migrations, mutations,
subscriptions, and `AppSchema` wiring work against the `syncular-client` SDK:

```bash
cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example
```

The integration shape for another Rust app is:

```rust
use syncular_client::app_schema::AppSchema;
use syncular_client::client::{SyncularClient, SyncularClientConfig};

mod generated {
    pub mod schema { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/schema.rs")); }
    pub mod syncular { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/syncular.rs")); }
    pub mod diesel_tables { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/diesel_tables.rs")); }
    pub mod migrations { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/migrations.rs")); }
}

fn app_schema() -> AppSchema {
    AppSchema {
        app_tables: generated::syncular::APP_TABLES,
        app_table_metadata: generated::syncular::APP_TABLE_METADATA,
        migrations: generated::migrations::MIGRATIONS,
        default_subscriptions: generated::syncular::default_subscriptions,
        adapter_for: generated::diesel_tables::adapter_for,
    }
}

let mut client = SyncularClient::open_with_schema(config, app_schema())?;
```

Reads stay regular Diesel query-builder expressions; the SDK owns the
connection:

```rust
use diesel::prelude::*;
use generated::{diesel_tables::TaskRow, schema, syncular};
use syncular::prelude::SyncularGeneratedMutationsExt;

let tasks: Vec<TaskRow> = client.read(
    schema::tasks::dsl::tasks
        .filter(schema::tasks::dsl::user_id.eq("user-rust"))
        .order(schema::tasks::dsl::server_version.desc())
        .select(TaskRow::as_select()),
)?;
```

Writes use generated Syncular mutations so local state and the outbox stay in
one path:

```rust
let inserted = client.mutations().tasks().insert(
    syncular::NewTask::with_generated_id("Ship Rust", "user-rust", Some("project-rust")),
)?;

client
    .mutations()
    .tasks()
    .update(syncular::TaskPatch::new(&inserted.id).completed(1))?;

let batched = client.commit(|tx| {
    let id = tx.tasks().insert(syncular::NewTask::with_generated_id(
        "Batched task",
        "user-rust",
        Some("project-rust"),
    ))?;
    tx.tasks().update(syncular::TaskPatch::new(&id).completed(1))?;
    Ok(id)
})?;
```

Conflicts are namespaced on the client, so apps do not need to juggle the
lower-level retry methods directly:

```rust
let pending = client.conflicts().pending()?;

for conflict in pending {
    client.conflicts().keep_local(&conflict.id)?;
}
```

Typed live queries keep the same Diesel semantics and refresh from sync reports
or local table-change reports:

```rust
let mut live_tasks = client.live_query(["tasks"], || {
    schema::tasks::dsl::tasks
        .filter(schema::tasks::dsl::user_id.eq("user-rust"))
        .order(schema::tasks::dsl::server_version.desc())
        .select(TaskRow::as_select())
})?;

let report = client.sync_http()?;
if live_tasks.refresh_if_changed(&mut client, &report)? {
    render(live_tasks.rows());
}

let local_report = syncular_client::client::SyncReport::table_changed("tasks");
live_tasks.refresh_if_changed(&mut client, &local_report)?;
```

## Native Generated Client Smoke

The native smoke compiles and runs the app-owned Swift and Kotlin generated
clients in two layers. First it runs them against a mock generic native client
to pin generated query-builder SQL, mutation JSON, and live-query registration.
Then it builds the Rust runtime dylib, links Swift against the generated
BoltFFI wrapper, packages the JVM native library, and runs Kotlin through the
generated Kotlin/JNI binding against a real local SQLite database.

```bash
bun run rust:native-smoke
```

The real host-language smokes cover runtime manifest validation, dynamic auth
header updates, pause/resume/shutdown lifecycle, foreground
`resumeFromBackground()` recovery, typed Syncular mutations, typed query reads,
observed query registration, native event streaming, and live-query refresh
through `QueriesChanged`.

The Kotlin smoke downloads `kotlinx-serialization-json` jars into
`.context/native-smokes/kotlin-libs` if they are not already present, and uses
BoltFFI to package the JVM native library under `rust/bindings/java/native`.
Override `SYNCULAR_KOTLINX_SERIALIZATION_VERSION` or `SYNCULAR_KOTLIN_LIB_DIR`
if a host app wants to validate a different dependency version.
