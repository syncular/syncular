# CRDT columns — collaborative text & state

Most columns are **last-write-wins** (LWW): the newest write to a row wins, and
a concurrent write to the same optimistic-concurrency token conflicts (see
[Conflicts](concepts-conflicts.md)). That is the wrong model for a shared
document two people edit at the same time — you want both edits to survive and
**converge**, not one to clobber the other.

A **`crdt` column** gets a different consistency model on the *same row and in
the same commit* as your LWW columns. It carries opaque CRDT bytes — a Yjs
update — that the **server merges** on push instead of overwriting. Concurrent
edits merge order-independently, so everyone lands on identical bytes.

Normative detail: [SPEC.md §5.10](../../SPEC.md#510-crdt-columns--opt-in-collaborative-state).

## The `crdt` column

Declare one with a `CRDT` column in your migration. It is a `bytes`-shaped
column to the codec — commits, pushes, and segments carry it with **zero new
codec cost** — but the schema, apply, and query layers recognize it as
"collaborative state the server merges rather than overwrites."

```sql
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title      TEXT NOT NULL,   -- ordinary LWW column
  doc        CRDT             -- collaborative text; nullable = empty document
);
```

A `crdt` column names a `crdtType` that selects the server-side merger. This
rung ships exactly one: `yjs-doc`. The merger lives in a **separate package**
(`@syncular/crdt-yjs`) so Yjs never enters `@syncular/core` or
`@syncular/server` — a host opts in by registering it, exactly like a blob
store.

## The merge semantics (why it never conflicts)

Two rules make collaborative editing conflict-free:

1. **`baseVersion` governs only the non-crdt columns.** A `crdt` column is
   excluded from the optimistic-concurrency comparison, so it **never** produces
   a `version_conflict` on its own account.
2. **On apply, each `crdt` column is `merge(stored, incoming)`** — never the raw
   pushed bytes. Yjs updates are a CRDT, so the merge is commutative,
   associative, and idempotent: concurrent pushes converge order-independently,
   and a replayed update is a no-op (offline outbox replay is safe).

A mutation touching **only** a `crdt` column pushes with `baseVersion` absent
(last-write-wins mode) — it can never conflict, no matter how far the row has
advanced. That is the "crdt-only divergence merges cleanly" rule.

## Web client — the `YjsColumn` helper

Clients **push updates; the server merges; clients apply the merged state on
delivery.** A keystroke is a few-byte update, not the whole document. The
`@syncular/crdt-yjs` `YjsColumn` helper wraps a `Y.Doc` bound to one column
value:

```ts
import { YjsColumn } from '@syncular/crdt-yjs';

// Load the current merged bytes from the row, edit, push the full state.
const col = new YjsColumn(row.doc);          // row.doc is a Uint8Array | null
col.text().insert(0, 'Hello ');              // mutate the shared text
client.mutate([
  { table: 'notes', op: 'upsert', values: { ...row, doc: col.columnBytes() } },
  // baseVersion omitted → merges cleanly (crdt-only divergence rule)
]);

// On delivery of the server-merged value, apply it back — idempotent.
col.applyServerBytes(updatedRow.doc);
console.log(col.text().toString());          // the app-visible collaborative text
```

Generated row types keep the column a plain `Uint8Array` — codegen has no Yjs
dependency. The `Y.Doc` accessor is the helper, never generated code.

## Native clients (Rust / Swift / Kotlin / Dart / Tauri / React Native)

The Rust client core round-trips `crdt` bytes for free (a `crdt` column is a
`bytes` column to the codec). To let a native app **render and edit**
collaborative text without hand-rolling a CRDT, the core integrates
[`yrs`](https://crates.io/crates/yrs) — the Rust Yjs port — behind the
**`crdt-yjs` feature**. Because `yrs` is Yjs-wire-compatible, a native edit
merges byte-identically with a `@syncular/crdt-yjs` edit on the server: a Rust
app and a web app can collaborate on the same document.

The feature is **off by default** so lean/offline builds never pay for it;
examples and demos turn it on. It surfaces four typed methods on every wrapper,
thin over the shared command router:

```ts
// The same shape on Tauri / React Native (TS), Swift, Kotlin, and Dart.
const text = await client.crdtText('notes', 'n1', 'doc');   // materialize
await client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hello ');   // edit + push
await client.crdtDeleteText('notes', 'n1', 'doc', 0, 6);          // edit + push
await client.crdtApplyUpdate('notes', 'n1', 'doc', updateBytes);  // escape hatch
```

Each edit loads the row's current merged bytes, applies the op with `yrs`,
re-encodes the whole document state, and pushes it baseVersion-less through the
normal mutate path — the exact model the `YjsColumn` helper uses on the web,
one layer down. The `crdtApplyUpdate` escape hatch applies an arbitrary Yjs
update the app produced with its own `yrs` model (maps, arrays, XML).

Cross-core convergence is proven in the conformance suite: a scenario has the
**Rust** core author edits via `crdtInsertText`/`crdtDeleteText` and the
**TypeScript** server merge them (and vice versa), asserting byte-identical
converged state both directions.

> **Feature flag.** In Rust, enable `crdt-yjs` on the crate that owns the core
> — the FFI crate (`syncular-ffi`), the Tauri plugin (`tauri-plugin-syncular`),
> or the command crate directly. Without it, the `crdt*` commands return
> `client.crdt_unavailable` and the rest of the client still runs (lean core).
