# Named queries

A named query is a `SELECT` in a file that typegen turns into a typed function
on every SDK, so the query and its row type cannot drift apart. This page is for
developers who read synced data and want typed inputs, typed rows, and reactive
metadata. You finish with one query generated, checked in CI, and called from
your SDK.

::meta{for="App developers on any SDK" time="10 minutes" first="guide-schema" spec="2"}

:::terms
- **Named query**: A `.sql` or `.syql` file that typegen compiles to a typed function and a reactive descriptor.
- **QueryIR**: The target-neutral compiled form of a query. Every SDK output consumes the same QueryIR.
- **SYQL**: The structured query format with optional predicates, sort profiles, bounded limits, and sync coverage. See the [SYQL language](/syql/).
- **Reactive dependencies**: The tables and scope values a query reads, which decide when it re-runs.
:::

## Choose `.sql` or `.syql`

Use `.sql` when the statement shape is fixed. Use `.syql` when optional inputs
change the shape, or when the query must claim that a window is fully synced
before it reports ready.

:::figure{title="Which format to write" note="Decided per query" ticks}
<div class="d-cols-2">
<div class="node ok"><span class="t">.sql</span>A fixed SQLite SELECT with named :params<br>Parameters, columns, types, tables, and conservative reactive metadata come from the statement</div>
<div class="node hot"><span class="t">.syql</span>Optional <code>when</code> predicates, reusable predicates, sort profiles, bounded limits<br><code>sync query</code> adds a coverage claim</div>
</div>

::caption[Both formats compile to one QueryIR. A `.syql` statement that cannot prove its claims fails at generation time.]
:::

The [SYQL playground](/playground/) compiles `.syql` in the browser against
the hosted demo's schema and runs each statement on the demo's sample data. The
[SYQL specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
is normative.

## Steps

:::::steps
::::step{title="Write the query file" time="2 min"}
Named queries live in `queries/` next to `migrations/`. Override the directory
with the top-level `queries` manifest key. Typegen walks it recursively, and the
default name is the path relative to the queries root, camelCased:
`list-todos.sql` becomes `listTodos` and `billing/invoices/list.sql` becomes
`billingInvoicesList`.

:::tabs
```sql label=".sql" title="queries/list-todos.sql"
select id, list_id, title, done
from todos
where list_id = :listId
order by position, id
```
```syql label=".syql" title="queries/list-todos.syql"
sync query listTodos(listId) {
  select id, list_id, title, done from todos
  where todos.list_id = :listId
  order by sortBy default position {
    position: position asc, id asc;
    newest: updated_at_ms desc, id desc;
  }
  limit pageSize default 50 max 200;
}
```
:::

In `.syql`, `query` is a reactive local read, and `sync query` also claims
synchronization coverage: the query is not ready until every covered table
window is complete. Use explicit `JOIN ... ON` syntax in both formats. Typegen
rejects comma-separated table sources so a valid SQLite statement cannot omit a
table from the reactive metadata.

Plain projected columns keep their schema type and nullability. Outer joins add
SQL null-extension: columns from the optional side of a `LEFT JOIN`, the prior
side of a `RIGHT JOIN`, and both sides of a `FULL OUTER JOIN` generate as
nullable in every target, even when the physical column is `NOT NULL`.

```sql title="queries/todo-notes.sql"
select t.id, n.title as note_title
from todos t
left join notes n on n.list_id = t.list_id
```

Here `id` stays required and `noteTitle` is nullable. Aliases, left-to-right
join chains, and parenthesized relation groups keep the nullability that an
earlier outer join introduced. Physical tables inside a derived subquery still
count as reactive dependencies.

::checkpoint[`syncular fmt --check queries` passes for `.syql` files.]
::::

::::step{title="Turn on the output for your SDK" time="1 min"}
Each language's queries file is a separate opt-in output, so schema-only
consumers do not change when a query does. When no output requests a queries
file, typegen does not read `queries/`.

:::tabs
```json sdk=web title="syncular.json"
{ "output": { "queries": "./src/syncular.queries.ts" } }
```
```json sdk=swift title="syncular.json"
{ "output": { "swift": { "path": "./Sources/App/Syncular.generated.swift", "queriesPath": "./Sources/App/SyncularQueries.generated.swift" } } }
```
```json sdk=kotlin title="syncular.json"
{ "output": { "kotlin": { "path": "./Syncular.generated.kt", "queriesPath": "./SyncularQueries.generated.kt" } } }
```
```json sdk=flutter title="syncular.json"
{ "output": { "dart": { "path": "./lib/syncular.generated.dart", "queriesPath": "./lib/syncular_queries.generated.dart" } } }
```
```json sdk=rust title="syncular.json"
{ "output": { "ir": "./syncular.ir.json", "rust": { "queriesPath": "./src/syncular_queries.rs" } } }
```
:::

Rust output is object-only because the Rust core loads the neutral schema IR
directly instead of a generated schema source file. `clientCrate` defaults to
`syncular_client`.

::checkpoint[The manifest parses: `syncular generate` reports no unknown-key error.]
::::

::::step{title="Generate and check" time="1 min"}
The `syncular` CLI ships in `@syncular/typegen`:

```sh title="terminal"
bunx syncular generate --manifest-dir .
bunx syncular generate --manifest-dir . --check
bunx syncular fmt queries
bunx syncular fmt --check queries
```

Run both `--check` commands in CI. Each queries file carries a do-not-edit
header and the IR hash, and `--check` compares every queries file byte for byte.
Generation emits the target-neutral QueryIR plus the configured TypeScript,
Swift, Kotlin, Dart, and Rust APIs. All targets share the same physical plan,
bind order, input-presence semantics, reactive facts, and runtime validation
rules. The migration-lock subcommands are on [Schema & typegen](/guide-schema/).

::checkpoint[The queries file exists, and `generate --check` prints `generated output is up to date`.]
::::

::::step{title="Call the generated function" time="2 min"}
Every query becomes one typed function, one row type per projection, and the
list of tables it reads. Each projection row is its own generated type, so the
row shape is exactly what the `SELECT` returns.

:::tabs
```ts sdk=web title="src/todos.ts"
import { listTodos } from './syncular.queries';

const rows = await listTodos(handle, { listId });
```
```tsx sdk=react title="src/Todos.tsx"
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });
// todos.rows: ListTodosRow[]; todos.phase: loading | partial | ready | error
```
```swift sdk=swift title="Todos.swift"
let rows = try SyncularSchemaQueries.listTodos(client: client, listId: listId)
```
```kotlin sdk=kotlin title="Todos.kt"
val rows = SyncularSchemaQueries.listTodos(client, listId)
```
```dart sdk=flutter title="lib/todos.dart"
final rows = syncularListTodosQuery(client, listId);
```
```rust sdk=rust title="src/todos.rs"
mod syncular_queries;

let params = syncular_queries::list_todos::Params::new(list_id);
let rows = syncular_queries::list_todos::run(&client, &params)?;
let view = syncular_queries::list_todos::snapshot(&mut client, &params)?;
```
:::

Casing follows the manifest `naming` mode: generated rows and inputs are
camelCase, and projections are `AS`-aliased so runtime keys match. The Swift and
Kotlin object names default to `SyncularSchema`; set `enumName` or `objectName`
on the output to change them. React Native and Tauri use the TypeScript output.

::checkpoint[The call returns rows typed as `ListTodosRow` with the columns the `SELECT` projects.]
::::
:::::

## Reference: what each target emits

| Target | Emitted shape |
|---|---|
| TypeScript | `ListTodosRow`, `ListTodosParams`, `listTodosTables`, `async listTodos(client, params)`, and a `listTodosQuery` descriptor for React |
| Swift | `struct ListTodosRow` with `init?(row:)`, `<Enum>Queries.listTodos(client:listId:)`, `listTodosTables` |
| Kotlin | `data class ListTodosRow` with `fromRow`, `<Object>Queries.listTodos(client, listId)`, `listTodosTables` |
| Dart | `class ListTodosRow` with `fromRow`, `syncularListTodosQuery(client, listId)`, `syncularListTodosQueryTables` |
| Rust | `list_todos::{Row, Params, DESCRIPTOR, select, run, snapshot}` |

The TypeScript runner takes a structural `QueryClient` with one method,
`query(sql, params?)`. One `mapRow` decoder per projection serves both the direct
runner and the React descriptor, so a boolean column is a JavaScript boolean on
the first read and on every reactive re-read. A value that does not match the
analyzed result type throws `QueryResultDecodeError`. Raw `client.query()` and
`useRawSql()` stay storage-shaped unless the caller supplies a mapper.

Each Rust query is a snake-case module. `Params::new` takes the required inputs,
and `select(&params)` exposes the exact checked SQL and binds for diagnostics.
`run` executes a typed local read, and `snapshot` returns typed rows, the local
revision, and coverage from one SQLite read transaction. The `DESCRIPTOR` holds
the QueryIR identity, dependencies, coverage, and any proven row key. Exact
integers stay `i64`, optional nullable values keep absent distinct from present
`NULL`, and row decoding is strict. Byte decoders reject odd-length and
non-hexadecimal `$bytes` envelopes before they return a row. The generated
module uses the `syncular-client` query boundary and needs no direct
`serde_json` dependency. See [Rust](/platform-rust/) for the client workflow.

`syncular generate --print <name>` prints a query's lowered, checked SQL, its
parameters, tables, and variants. For offline full-text search, declare a
client-local FTS5 projection and query it through the same generated surface
([Local full-text search](/tooling-local-search/)).

## Related uses of a generated query

- A write that needs compare-and-set semantics projects `_sync_version AS
  server_version` in the query. [Handling conflicts](/guide-concurrency-correction/#read-the-confirmed-version)
  walks the full flow.
- The same generated descriptor registers as a scoped or privileged
  [authoritative remote query](/guide-remote-operations/#registered-typed-queries).
  Remote callers send its generated ID and typed parameters, and the SQL stays in
  the server registry.
