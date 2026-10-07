# Reads & writes (Rust)

Subscribe, write optimistically, read rows and SQL, and follow each commit to its outcome.

::meta{for="Rust developers building on a SyncClient" time="8 minutes"}

:::figure{title="What one mutate does" note="Offline-safe" ticks}
<div class="d-row">
<div class="node hot"><span class="t">mutate</span>validates the values,<br>records one commit</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Replica</span>rows visible to<br><code>read_rows</code> and <code>query</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Outbox</span>commit waits for<br>the next round</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Outcome</span>journaled when<br>the server answers</div>
</div>
:::

## Subscribe, mutate, read

```rust title="src/main.rs"
client.subscribe(
    "todos".to_owned(),                                    // subscription id
    "todos".to_owned(),                                    // table
    vec![("list_id".to_owned(), vec!["groceries".to_owned()])],
    None,                                                  // params
)?;

let commit_id = client.mutate(vec![Mutation::Upsert {
    table: "todos".to_owned(),
    values,
    base_version: None,
}])?;

let rows = client.read_rows("todos")?;   // version -1 = optimistic
let hits = client.query("SELECT id, title FROM todos ORDER BY id", &[])?;
```

`Mutation` has three arms: `Upsert { table, values, base_version }`, `Patch { table, values, base_version }`, and `Delete { table, row_id, base_version }`. `base_version` drives [conflict detection](/concepts-conflicts/). `query` accepts one read-only statement over the local tables and refuses SQL that writes.

`mutate` returns a `ClientError` on failure: a stable `code`, a static `message`, optional `details`, and `retryable`. [Platform specifics](/platform-rust-specifics/#structured-authoring-failures) lists the validation rules.

## Outcomes and conflicts

`conflicts()`, `rejections()`, and `pending_commit_ids()` report divergence. Final results are also journaled durably: `commit_outcome(id)`, `commit_outcomes(query)`, and `resolve_commit_outcome(input)` restore correction UI after a restart and keep active conflicts and rejections until the application resolves them. An outcome's status is `applied`, `cached`, `conflict`, or `rejected`. See [Handling conflicts](/guide-concurrency-correction/).

## Purge

For a validated device or key-revocation directive, `purge_local_data(&input)` applies a bounded, idempotent local cleanup, the same one the web and native bridges apply. Gate the affected subscriptions first; see [Authorized local purge](/concepts-local-data-purge/).

## Generated named queries

Typed Rust reads come from the same `.sql` and `.syql` files as the other clients. Add the Rust output to `syncular.json`:

```json title="syncular.json"
{
  "output": {
    "ir": "./syncular.ir.json",
    "rust": { "queriesPath": "./src/syncular_queries.rs" }
  }
}
```

`clientCrate` is optional; set it only when Cargo aliases the `syncular-client` dependency. Include the generated module and call the query-specific API:

```rust title="src/main.rs"
mod syncular_queries;
use syncular_queries::list_todos;

let mut params = list_todos::Params::new("groceries".to_owned());
params.page_size = Some(100);

let rows: Vec<list_todos::Row> = list_todos::run(&client, &params)?;
let view = list_todos::snapshot(&mut client, &params)?;
println!("revision={}, complete={}", view.revision, view.coverage.complete);
```

- `select` exposes the compiler-checked SQL and positional values for diagnostics.
- `DESCRIPTOR` carries the QueryIR-hash identity, table and scope dependencies, `WindowCoverage`, and an optional proven row-key function. Combine it with `drain_change_batches()` to build your own observer; codegen imposes no async runtime or UI framework.
- SYQL `integer` is `i64`. Optional nullable inputs use `SyqlPresence<Option<T>>`, which keeps absent distinct from present `NULL`.
- Decoding accepts the core's `$bigint` and `$bytes` envelopes and returns a column-specific `QueryError` for a malformed row.
- A failed snapshot read appears in `diagnostics_snapshot().query_failures` until the same query reads successfully. The entry holds no SQL, parameters, rows, or SQLite error text. SQLite corruption and I/O failures use `client.storage_corrupt`, `client.storage_io`, and `client.storage_full`; every other failure uses `client.query_failed`.

`syncular generate --check` byte-gates the schema IR and the `.rs` file. [Named queries](/tooling-queries/) covers the source files.

## Blob bytes

`fetch_blob_bytes` returns a complete attachment:

```rust title="src/main.rs"
let blob = client.fetch_blob_bytes(&mut transport, &blob_ref)?;
assert_eq!(blob.byte_length, blob.bytes.len() as i64);
```

`FetchedBlob` owns its `Vec<u8>`, which stays valid after later client calls and after the client closes. The C ABI and native bindings receive the same bytes as `{"$bytes":"<lowercase-hex>"}`. [Blobs](/concepts-blobs/) covers the model.
