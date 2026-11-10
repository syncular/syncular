# RFC: Client performance tooling for app developers

- Status: proposal; no implementation, no SPEC or SYQL change
- Date: 2026-11-10
- Review baseline: `806a45bc` (0.59.0 plus open items)
- Scope: `packages/typegen`, `packages/web-client` (new `./dev` subpath),
  `packages/testing` (`@syncular/testkit`), `packages/react` (docs only),
  the conformance catalog, the docs site; the Rust core and the native
  bindings in a deferred stage

## 1. Decision asked

Adopt four tools that show an app developer the cost of their Syncular usage
before production does, in this order: a query-plan check in `typegen`, a
development profiler at `@syncular/client/dev`, a strict mode in
`@syncular/testkit`, and budget assertions over the profiler's report.

Consumer apps found their costs late. One app sent 223 subscriptions per
round, about 150 bytes each way per subscription
(`apps/docs/src/content/pitfalls.md:55`); past 500 the server refuses every
pull of that account (`pitfalls.md:59`, `packages/server/src/context.ts:105`).
Today's instruments cannot show query plans, query re-runs or per-round bytes:
the diagnostics snapshot excludes SQL, scope values and row counts by contract
(`packages/web-client/src/diagnostics.ts:1-7`, SPEC §7.6), and the
`__SYNCULAR__` console registry reports counts only
(`packages/web-client/src/devtools.ts:83-100`). `typegen` already prepares
every named query against an in-memory SQLite built from the schema
(`packages/typegen/src/generate.ts:498-530`), including the declared indexes
(`packages/typegen/src/query.ts:1623-1630`); asking that database for the plan
costs one statement per query.

| Area | Change |
| --- | --- |
| `typegen` | Runs `EXPLAIN QUERY PLAN` on every emitted physical statement. Reports a scan of a constrained table, an automatic index, an unfiltered unbounded read and a query over many tables, each with a static `typegen.query_*` code. An allowlist in `syncular.json` acknowledges an intended finding |
| `@syncular/client/dev` (new subpath of `packages/web-client`) | `createSyncProfiler()` wraps a `ClientDatabase`, a `SyncTransport`, a `RealtimeConnector` and a client handle, and records per live query, per statement, per subscription, per round and per write burst. Records SQL text and query ids. Refuses to start in a production build |
| `packages/web-client` worker core | `createTransport` receives the current-headers reader that `createRealtime` already receives (`worker-core.ts:76`, `:84-88`), so a profiled worker transport keeps auth headers current |
| `@syncular/testkit` | `createTestSync({ profile, strict })`: a profiler per test client, five strict-mode perturbations, and `assertBudgets(report, budgets)` |
| Conformance catalog | One scenario for a duplicated realtime delta (SPEC §8.2) in both cores, before strict mode doubles deltas |

What stays: the wire protocol, both cores' apply paths, the diagnostics
snapshot and its privacy contract, the production client and worker bundles,
the `__SYNCULAR__` registry, and every public API except the added
`createTransport` argument.

What the maintainer gets, by stage:

1. **Plan check.** Every app in every target language gets plan findings at
   generate time, with zero runtime cost and zero bundle bytes. On the
   `basic` typegen fixture it reports 7 of 23 statements scanning a
   constrained table and 1 automatic index (§3.1).
2. **Profiler.** Web, Tauri and React Native apps get per-query run counts,
   re-runs that returned identical rows, invalidating tables, round bytes,
   subscription counts against the 500 limit, and single-operation write
   bursts.
3. **Strict mode and budgets.** App tests run under perturbations the
   protocol already permits and lock their numbers in CI.
4. **Deferred: native counters.** Swift, Kotlin and Flutter get the stage 1
   check only, until the Rust core exposes counters through the FFI (§6).

Cost: stage 1 is about 200 lines in `typegen` plus fixture expectations;
stage 2 about 500 lines in a new module plus tests; stage 3 about 300 lines in
the testkit and one conformance scenario per core. These are estimates from
the size of the modules they wrap; nothing is measured. The production client
and worker bundles stay byte-identical except for the `createTransport`
argument, which the worker lane must pay for by removing bytes elsewhere
(§8.5).

Biggest risks:

- **Plan findings break generation for existing apps.** A table of 20 rows
  scans in microseconds and still produces a finding. If findings fail
  generation by default, every app with such a query must add allowlist
  entries on upgrade.
- **Planner drift.** `typegen` plans with Bun's SQLite 3.54.0; browsers run
  `@sqlite.org/sqlite-wasm` `^3.53.0-build1`
  (`packages/web-client/package.json:115`) and native hosts the SQLite bundled
  by `rusqlite` 0.41 (`rust/crates/client/Cargo.toml:18`). A finding states
  what Bun's planner chose.
- **A shipped profiler.** The production guard reads the same environment
  signals as the devtools registry (`devtools.ts:60-76`). A build that sets
  none of them runs the profiler in production, holding SQL text in memory.

Questions only the maintainer can answer:

1. Do plan findings fail `syncular generate` by default (recommended), or
   print as warnings and fail only under a flag? `typegen` has no warning
   channel today.
2. Acknowledge an intended finding in `syncular.json` (recommended; one
   mechanism for `.sql` and `.syql`, no SYQL grammar change), or beside the
   statement, which needs a SYQL grammar addition?
3. Is strict mode on by default in development builds, or opt-in
   (recommended)?
4. Ship the profiler as `@syncular/client/dev` (recommended) or as a separate
   package such as `@syncular/devtools`?
5. Defer native counters (recommended), or put them in stage 3?

## 2. What can be observed from outside the core today

### 2.1 Storage

`ClientDatabase` is a synchronous interface of `exec`, `query`,
`queryReadOnly` and `transaction` (`packages/web-client/src/database.ts:32-71`).
`client.query()` and `querySnapshot()` read through `queryReadOnly`
(`packages/web-client/src/client.ts:1734`). The bench read lane replaces
`query`, `queryReadOnly` and `transaction` on a live database to count
statements per read surface (`bench/src/read-lane.ts:130-162`) and records the
plan with `EXPLAIN QUERY PLAN` (`read-lane.ts:168`). A profiler can wrap the
same three methods at construction time; it sees the SQL text, the
parameters, the row count and the wall time of every statement, the client's
own bookkeeping statements included.

In a direct client the app passes the database (`client.ts:427`). In a worker,
`startSyncWorker` accepts an `openDatabase` override
(`packages/web-client/src/worker-core.ts:63-65`, used at `:391-395`), so a
development worker entry can open and wrap the database without a core
change. The testkit constructs its own `BunClientDatabase` and keeps
`database` out of the overridable config
(`packages/testing/src/client.ts:85-96`, `:109`); wrapping there is a testkit
change.

### 2.2 Live queries in TypeScript

`@syncular/react` builds one `ReactiveClientStore` per client object, keyed in
a `WeakMap` (`packages/react/src/provider.ts:62-75`). The store reads through
the structural `ReactiveQueryClient` interface: `onChange`, `querySnapshot`,
`onProgress` and status readers (`packages/web-client/src/reactive-store.ts:57-74`).
A wrapper object that implements `SyncClientLike`
(`packages/react/src/client.ts:27`) and delegates to the real client therefore
gets its own store and sees every read the store makes.

What the wrapper sees per read: the store calls `querySnapshot` with the SQL,
parameters, coverage and an `owner` holding the query id and its dependency
tables (`reactive-store.ts:686-702`). What it does not see: the store's match
decision. `QueryEntry.onChange` re-reads when `batchMatches` finds a changed
table, a matching scope key or a changed window unit
(`reactive-store.ts:197-226`, `:564-579`). The scope keys of a dependency
(`reactive-store.ts:25-28`) never reach `querySnapshot`. A wrapper that also
listens to `onChange` attributes a run to the batches since the previous run
whose tables intersect `owner.tables`. That attribution is exact per table and
cannot tell a scope-key match from a table-wide one.

Identical results are visible. After each read the store reconciles rows by
value and keeps the previous array when nothing changed
(`reactive-store.ts:278-300`, `:726-734`), and `#publish` then notifies no
listener (`reactive-store.ts:581-591`). The wrapper repeats that comparison
with the exported `canonicalValue` (`reactive-store.ts:169`) and counts a run
whose rows equal the previous run's rows as an identical re-run.

### 2.3 Sync rounds, subscriptions and writes

- **Round bytes.** `SyncTransport` maps request bytes to response bytes
  (`packages/web-client/src/transport.ts:13`); `SegmentDownloader` returns
  segment bytes (`transport.ts:60-61`); socket rounds and deltas pass through
  `RealtimeConnector` (`transport.ts:71-90`). Wrapping all three gives
  request, response, segment and delta bytes per exchange. In a worker,
  `createTransport` receives only the init config (`worker-core.ts:76`) while
  `createRealtime` also receives a current-headers reader (`:84-88`); a
  wrapped worker transport would send the init headers forever.
- **Round time.** `diagnosticsSnapshot().lastRound` carries start, end and
  duration with 12 counters (`diagnostics.ts:103-135`). Round duration minus
  the transport's exchange time approximates encode plus apply time. The
  split is approximate because the round's awaits interleave with other
  microtasks.
- **Subscriptions.** `activeSubscriptions` counts the registrations the next
  pull sends (`diagnostics.ts:207`), the count the server's
  `maxSubscriptionsPerRequest` limit checks
  (`packages/server/src/handler.ts:299-305`). The server's value is not
  visible to the client.
- **Bootstrap.** `SyncProgress` events carry `subscriptionId`, `table`,
  `phase`, `bytesReceived` and `rowsProcessed` (`packages/web-client/src/progress.ts:4-20`),
  delivered through `onProgress` (`client.ts:2221`). They carry no
  timestamp; the profiler stamps them on receipt.
- **Writes.** `mutate` takes an array of mutations and returns a commit id
  (`client.ts:3528`). A wrapper counts operations per call and calls per
  microtask turn.
- **Change batches.** `ClientChangeBatch` lists changed tables with scope
  keys, windows, status and applied server commits
  (`packages/web-client/src/invalidation.ts:44-59`).

### 2.4 Worker, multi-tab and native hosts

A worker handle runs the core in a dedicated worker; in multi-tab mode the
leader tab owns the worker and followers forward each call over a
`BroadcastChannel` (`packages/web-client/src/multi-tab.ts:2-60`,
`LeaderBridge` at `:293`, `FollowerLink` at `:477`). A page-side wrapper
measures each call's round trip, forwarding included. Statement time exists
only inside the leader's worker.

Tauri and React Native drive one Rust core through the command bridge
(`packages/web-client/src/native-bridge.ts:1-12`); `querySnapshot` is one
command (`native-bridge.ts:709`). The JS wrapper of §2.2 works on these
handles. Statement time, request bytes and apply time are inside Rust.

Swift, Kotlin and Flutter send JSON commands through
`syncular_client_command` and read events through `syncular_client_poll_event`
(`rust/crates/ffi/src/lib.rs:453`, `:483`): `change`, `progress`,
`sync-intent`, `diagnostics` and `presence` events (`lib.rs:244`, `:275`,
`:346`, `:376`, `:392`). Each binding has one command entry point
(`bindings/swift/Sources/Syncular/SyncularClient.swift:219`,
`bindings/kotlin/src/main/kotlin/dev/syncular/SyncularClient.kt:157`,
`bindings/flutter/syncular/lib/src/client.dart:218`). None of them has a
live-query scheduler; app code calls `querySnapshot` itself.

The Rust core's equivalents: `diagnostics_snapshot`
(`rust/crates/client/src/client.rs:2697`), `drain_change_batches`
(`client.rs:2924`), `query_snapshot` with a `QueryOwner`
(`client.rs:6993`, `rust/crates/client/src/api.rs:534`), a progress observer
(`client.rs:7326`) and a `Transport` trait (`rust/crates/client/src/transport.rs:73`)
that the FFI host implements internally. `rusqlite` is built without the
`trace` feature (`Cargo.toml:18`; `hooks` is a dev-dependency only, `:79`),
so the core cannot time statements today.

### 2.5 The testkit

`@syncular/testkit` gives an app test an in-memory server, real clients on
`bun:sqlite` through an in-process loopback, a virtual clock and per-client
offline (`packages/testing/src/index.ts:1-40`). Its `TransportFaults` drop a
request, drop a response, duplicate a request, truncate a response, drop or
truncate a segment download, and refuse a realtime connect
(`packages/testing/src/faults.ts:52-66`); the loopback honors each
(`packages/testing/src/client.ts:114-178`). Nothing in it perturbs realtime
deltas or leadership.

### 2.6 Availability per number

"Wrapper" means no core change; "hook" means a change of a few lines in core
code; "core" means new core instrumentation in Rust.

| Number | TS direct | TS worker / multi-tab | Tauri, React Native | Swift, Kotlin, Flutter |
| --- | --- | --- | --- | --- |
| Live query runs, rows, call time per query id | wrapper | wrapper (round trip) | wrapper (round trip) | binding wrapper per language |
| Invalidating tables per run | wrapper | wrapper | wrapper | binding wrapper |
| Invalidating scope keys per run | hook in `reactive-store.ts` | hook | hook | none |
| Re-runs with identical rows | wrapper | wrapper | wrapper | binding wrapper |
| Statement SQL time and row count | wrapper | wrapper in a dev worker entry | core | core |
| Active subscriptions against the server limit | wrapper | wrapper | wrapper | event wrapper |
| Bootstrap rows and bytes per subscription | wrapper | wrapper | wrapper | event wrapper |
| Bootstrap time per subscription | wrapper (receipt stamps) | wrapper | wrapper | event wrapper |
| Request and response bytes per round | wrapper | hook (`createTransport` headers) | core | core |
| Apply time per round | wrapper, approximate | wrapper, approximate | core | core |
| Single-operation commits per microtask turn | wrapper | wrapper | wrapper | binding wrapper |

## 3. Stage 1: the generate-time plan check

### 3.1 What `EXPLAIN QUERY PLAN` returns

I ran a throwaway script that built the `basic` fixture's DDL with
`synthesizeDdl` and planned every statement in
`packages/typegen/test/fixtures/basic/syncular.queries.ir.json` on Bun 1.4.4
(SQLite 3.54.0). Each plan row carries a `detail` string. Representative
output:

| Query | Plan details |
| --- | --- |
| `findDocByOrg` (`WHERE org_id = :orgId ORDER BY id`) | `SCAN docs USING INDEX sqlite_autoindex_docs_1` |
| `facilityDocs` (sync query `by docs.org_id`) | `SCAN docs USING INDEX sqlite_autoindex_docs_1` |
| `docsInProject` (`WHERE org_id = ? AND project_id = ?`) | `SCAN docs USING INDEX sqlite_autoindex_docs_1` |
| `booleanResults` (join on `d.project_id`) | `SCAN t USING INDEX sqlite_autoindex_tasks_1`, `SEARCH d USING AUTOMATIC COVERING INDEX (project_id=?)` |
| `tasksSince` (`WHERE estimated_at > :sinceMs + 0`) | `SCAN tasks` |
| `taskTitles` (no `WHERE`, no `LIMIT`) | `SCAN tasks` |
| `listProjectTasks` (`WHERE project_id = ? ORDER BY priority`) | `SEARCH tasks USING INDEX idx_tasks_project_title (project_id=?)`, `USE TEMP B-TREE FOR ORDER BY` |
| `docValueTypes` (`WHERE id = :id`) | `SEARCH docs USING INDEX sqlite_autoindex_docs_1 (id=?)` |

Across the 23 statements: 7 scan a table that a `WHERE` or join constraint
filters, 1 builds an automatic index, 8 sort in a temporary B-tree, and the
rest search an index. `docs` has no secondary index in the fixture, which
explains every `docs` scan.

### 3.2 What is trustworthy on an empty database

SQLite chooses a plan from the schema, the query and the `sqlite_stat1`
statistics. The generate-time database has the same tables and declared
indexes the client materializes (`query.ts:1598-1640` against
`packages/web-client/src/schema.ts:379-398`) and no statistics. `ANALYZE` on
the empty database writes zero `sqlite_stat1` rows (measured). Neither client
runs `ANALYZE` or `PRAGMA optimize`: `rg -i "analyze|pragma optimize|sqlite_stat"`
over `packages/web-client/src` and `rust/crates/client/src` finds nothing
outside tests. Clients therefore plan without statistics too, and for one
SQLite version the generate-time plan is the runtime plan.

Reliable without row counts:

- **Scan of a constrained table.** When no index covers any constrained
  column, every SQLite version scans; statistics only choose among indexes
  that exist. This is the main finding.
- **Automatic index.** SQLite builds a transient index on each execution when
  no persistent index serves a join constraint. The plan says so verbatim.
- **Unbounded unfiltered read.** A statement with no `WHERE`, no `LIMIT` and
  a scan reads and returns every row; this follows from the SQL.
- **Many tables.** The query IR lists each relation (`relations` in
  `syncular.queries.ir.json`); every listed table is an invalidation
  dependency, so a change to any of them re-runs the query.

Not reliable:

- **Which index wins.** For `listProjectTasks` the planner chose the unique
  `idx_tasks_project_title` over `idx_tasks_project`. With statistics the
  choice can change; without them it matches the client only on the same
  SQLite version.
- **Cost.** A plan has no row estimates. A scan of a 20-row table and a scan
  of a 200 000-row table produce the same `detail`.
- **Temporary sorts.** 8 of 23 fixture statements sort; the cost is
  proportional to the matched rows, which are unknown. The check does not
  report sorts; the profiler measures them.

### 3.3 Findings and codes

| Code | Trigger | Details |
| --- | --- | --- |
| `typegen.query_scan` | A `SCAN <table>` row for a relation whose columns appear in a `WHERE` conjunct or join constraint of that statement | `query`, `file`, `statement`, `table`, `columns`, `plan` |
| `typegen.query_automatic_index` | A row containing `AUTOMATIC INDEX` or `AUTOMATIC COVERING INDEX` | `query`, `file`, `statement`, `table`, `columns`, `plan` |
| `typegen.query_unbounded` | No `WHERE`, no `LIMIT` (authored or SYQL dynamic limit), and a top-level scan | `query`, `file`, `statement`, `table` |
| `typegen.query_many_tables` | More distinct relations than `queryPlan.maxTables` (default 4) | `query`, `file`, `tables` |
| `typegen.query_allow_unused` | An allowlist entry that matches no finding | `query`, `code`, `table` |

`statement` identifies the physical statement: SYQL lowers one logical query
to several statements under the `variants` backend and guards conditionals
with boolean binds under `neutralize` (`docs/SYQL.md:659-675`). A guarded
conjunct of the form `(:flag = 0 OR column = :value)` cannot use an index, so
the check plans every physical statement and names the variant that scans.
The column set comes from the relation boundaries `typegen` already records
per statement.

Each finding is a `TypegenError` with a static message, the code and the
details (`packages/typegen/src/errors.ts:4-21`), so the CLI, `--check`
(`packages/typegen/src/cli.ts:50`) and the language server report it through
the existing path. The language server publishes severity 1 only
(`packages/typegen/src/lsp.ts:392`, `:416`). Question 1 decides whether
findings are errors by default; the recommendation is yes, matching the
fail-loud doctrine and the absence of a warning channel. A new SYQL
diagnostic code also needs its remedy in `SYQL_DIAGNOSTIC_REMEDIES`
(`docs/SYQL.md:737-742`); the `typegen.*` codes belong to `.sql` and `.syql`
alike, so the remedy catalog gains five entries.

### 3.4 Acknowledging an intended finding

```json
"queryPlan": {
  "maxTables": 4,
  "allow": [
    { "query": "taskTitles", "code": "typegen.query_unbounded", "table": "tasks",
      "reason": "settings table, at most 20 rows" }
  ]
}
```

The entry names the query, the code and the table; `reason` is required and
non-empty so a reviewer sees why. An entry that matches nothing fails with
`typegen.query_allow_unused`, so the list shrinks when the query changes.

The alternative is a statement-local marker. `.sql` files already carry
statement-scoped `-- param :name <type>` markers
(`packages/typegen/src/query.ts:469`, `:520-531`), so `-- allow scan tasks`
would follow precedent. A `.syql` source has no comment-carried directives in
its grammar (`docs/SYQL.md:86-143`); the marker needs a SYQL grammar addition
and a formatter rule. The manifest allowlist serves both sources with one
mechanism and no grammar change, which is the recommendation (question 2).

### 3.5 Cost and parity

The check runs `EXPLAIN QUERY PLAN` once per physical statement on the
database `makeQueryDb` already opens. Every target language receives the SQL
`typegen` checked (commit `57d4dd9e`: "Emitted query SQL comes from the SYQL
lexer and is prepared at generate time"), so Swift, Kotlin, Dart and Rust apps
get the same findings. Runtime cost and bundle bytes are zero. Queries an app
writes by hand against `client.query()` are outside the check; the profiler
covers them.

### 3.6 Proof

The `basic` fixture gains an expected-findings file and an allowlist that
acknowledges each fixture finding, since the fixture's scans exist to test
typing. A new fixture holds one query per code and one unused allowlist entry;
a `bun:test` asserts the codes and details. A Bun upgrade that changes a plan
fails this test, which is the planner-drift signal of §8.

## 4. Stage 2: the development profiler

### 4.1 API

```ts
import { createSyncProfiler } from '@syncular/client/dev';

const profiler = createSyncProfiler({
  now: () => performance.now(),      // injectable; tests pass a virtual clock
  serverSubscriptionLimit: 500,       // the server's maxSubscriptionsPerRequest
  compareResults: true,               // identical re-run detection
});

const client = new SyncClient({
  database: profiler.database(await openPersistentWasmDatabase(options)),
  transport: profiler.transport(httpSyncTransport(syncUrl, http)),
  segments: profiler.segments(httpSegmentDownloader(segmentsUrl, http)),
  realtime: profiler.realtime(webSocketRealtimeConnector(realtimeUrl, http)),
  schema,
});

<SyncProvider client={profiler.client(client)}>…</SyncProvider>

profiler.report(); // ProfileReport, a plain object
profiler.reset();
```

`ProfileReport`:

| Field | Content |
| --- | --- |
| `queries[]` | Per owner id: `sql`, `tables`, `runs`, `identicalRuns`, `totalMs`, `maxMs`, `lastRows`, `triggers` (runs per invalidating table, plus `mount` and `refresh`) |
| `statements[]` | Per SQL text: `runs`, `totalMs`, `maxMs`, `rows`; the client's own statements included |
| `subscriptions` | `active`, `limit`, `peakActive`, per-table counts, `bootstraps[]` with `id`, `table`, `rows`, `bytes`, `ms` |
| `rounds[]` | Last 256 rounds: `requestBytes`, `responseBytes`, `segmentBytes`, `exchangeMs`, `totalMs`, `applyMsApprox`, `via` (`http` or `socket`) |
| `deltas` | Count and bytes of realtime deltas |
| `writes` | `mutateCalls`, `operations`, `bursts[]`: microtask turns with more than one single-operation commit |

Runs that `profiler.client()` does not see (an app calling `client.query()`
on the raw client) still appear under `statements`.

### 4.2 Where it lives

A new `./dev` export in `packages/web-client/package.json`, beside `./bun`,
`./wasm` and `./worker` (`package.json:30-80`), with source
`src/dev-profiler.ts`. Neither `client.ts` nor `worker-core.ts` imports it.
The bundle test measures the production client at 165 019 bytes against a
167 000 ceiling and the worker at 185 992 bytes against 186 000
(`packages/web-client/test/authority-bundle.test.ts:7-9`, `:21`, `:33`); a
module neither entry imports leaves both unchanged. The bundle test already
asserts that a production build contains no `__SYNCULAR__`
(`authority-bundle.test.ts:200`); it gains the same assertion for a profiler
marker string.

### 4.3 Worker and multi-tab

In worker mode the app writes a development worker entry:

```ts
startSyncWorker({
  openDatabase: async (config) => profiler.database(await openPersistentWasmDatabase(…)),
  createTransport: (config, headers) => profiler.transport(httpSyncTransport(config.endpoints.syncUrl, { headers })),
});
```

The `headers` argument is the one hook stage 2 needs (§2.3). The worker-side
profiler posts its `statements` and `rounds` on a `BroadcastChannel` named
from the lock name; the page-side profiler merges them into its report. A
follower tab's page profiler records its own queries with forwarding time
included. A leadership change starts a new worker with an empty statement
profile; the report marks the boundary with the leader's tab id.

### 4.4 Tauri and React Native

`profiler.client(handle)` works on a native handle, since the handle
implements the same client surface. Queries, invalidations, identical runs,
subscriptions, bootstraps and write bursts are available. Query times include
the IPC hop. Statement times, request bytes and apply time stay empty until
stage 4.

### 4.5 Cost when enabled

Per statement: two `now()` calls and one map update. Per live query run: one
`canonicalValue` over the result rows when `compareResults` is on, linear in
result size. Per round: byte lengths already in hand. The overhead is
unmeasured; stage 2 adds a bench lane that runs the read lane through the
profiler and reports the difference.

### 4.6 Production guard

`createSyncProfiler` throws `client.profiler_in_production` when
`process.env.NODE_ENV === 'production'` or `import.meta.env.PROD === true`,
the signals `devtools.ts:60-76` reads. A loud refusal matches the doctrine.
A build that sets neither signal runs the profiler: it keeps SQL text and
query ids in memory, sends nothing over the network, and costs the CPU of
§4.5. The docs page states that the profiler belongs in a development-only
import (`if (import.meta.env.DEV) await import('@syncular/client/dev')`).

### 4.7 Optional hook: invalidating scope keys

To report which scope key re-ran a query, `QueryEntry` passes the revision of
the batch that triggered a read in `owner` (`reactive-store.ts:696-701`), and
the profiler matches it against the batches it saw. This touches the
page-side store only, which no worker or client bundle lane includes. It is
optional for stage 2.

## 5. Stage 3: strict mode and budgets

### 5.1 Shape

```ts
const sync = await createTestSync({
  schema,
  profile: true,
  strict: { reverseUnorderedSelects: true, dropAckEvery: 3, duplicateDeltas: true,
            reconnectEvery: 5, rebootstrapOnce: true },
});
const a = await sync.client('a');
// … app scenario …
assertBudgets(a.profile.report(), {
  maxActiveSubscriptions: 50,
  maxQueryRunsPerMutation: 1,
  maxRoundBytes: 64_000,
  maxIdenticalRuns: 0,
});
```

`assertBudgets` throws `testkit.budget_exceeded` with the budget name, the
limit and the measured value in `details`. Every perturbation counts rounds,
deltas or commits; none reads a clock.

### 5.2 Perturbations

| Perturbation | Mechanism | Invariant that makes it safe | App failure it exposes | Conformance coverage today | Where |
| --- | --- | --- | --- | --- | --- |
| Reverse unordered selects | `PRAGMA reverse_unordered_selects = ON` on the wrapped database at open | SQL gives no order without `ORDER BY` | A list whose order flips; a test that compares row order | None needed; app SQL only | development and tests |
| Drop every Nth push acknowledgement | Testkit `faults.dropNextResponses` on every Nth round | §7.2 idempotent retry, §2.3 cached replay | An app that re-calls `mutate` after a failed sync and writes a second row | `offline/ack-loss-cached-replay` (`packages/conformance/src/catalog/offline.ts:945`), `offline/duplicate-request-delivery` (`:991`) | development and tests |
| Forced disconnect and catch-up | Close the realtime socket after every Nth delta; the test or host reconnects | §8.4 reconnect, sync-needed signal, catch-up pull | Screens that rely on deltas and ignore `syncNeeded`; state lost on reconnect | `realtime/behind-session-wakes-then-deltas-resume` (`catalog/realtime.ts:177`), `reconnect-storm/n-sessions-churn-and-converge` (`catalog/reconnect-storm.ts:37`) | development and tests |
| Duplicate every delta | The testkit realtime `send` calls `onBinary` twice (`packages/testing/src/client.ts:165-168`) | §8.2: a section with `nextCursor` at or below the local cursor is skipped or re-applied; §5.6 upsert idempotency | App code that treats each change batch or applied commit as a unique event, when a core re-applies | No scenario found: `rg -i duplicate` over the catalog finds push duplication only | tests only, after a new catalog scenario |
| Re-bootstrap once | `rebootstrapLocalData` on every subscription after the first converged round | §4.7 bootstrap, §5.6 first-page clear | UI that assumes rows never leave; caches keyed by row presence | `lifecycle/pruning-during-pull-resets-and-rebootstraps` (`catalog/lifecycle.ts:167`) | tests only |
| Leadership handoff | Close the leader handle after the Nth round so a follower promotes | Multi-tab handover (`multi-tab.ts:2-60`), `client.leader_handover` | Code that holds a closed handle; writes rejected during handover and never retried | `packages/web-client/test/multi-tab.test.ts` (TS only; Rust has no multi-tab) | development on demand; tests in the isolated multi-tab lane |

Strict mode tests the app. A perturbation without a conformance scenario
tests the cores first, so the duplicate-delta perturbation waits for a catalog
scenario in both cores; I did not locate the duplicate-skip comparison in
either core's code. Leadership handoff in tests needs real workers and runs
in the isolated lane that carries the documented Bun worker segfault
(`package.json:37`, `:41`); stage 3 adds it there and not to the default
testkit.

The live-query double read the brief proposed (run each live query twice,
compare) detects only non-deterministic SQL functions such as
`datetime('now')`; SQLite returns the same order for the same plan twice.
`reverse_unordered_selects` exposes the more common mistake, a missing
`ORDER BY`. Measured on Bun's SQLite: three rows returned `t1,t2,t3` by
default and `t3,t2,t1` with the pragma on.

### 5.3 Budgets in this repository

The repository locks bundle size by ceilings in a test
(`authority-bundle.test.ts:7-11`) and bench numbers by budgets in `bench/`.
`assertBudgets` applies the same pattern to an app: the budget values live in
the app's test, the profiler produces the numbers, and a regression fails CI.

### 5.4 Proof

Each perturbation gets a testkit test with a seeded scenario, asserting the
perturbation fired (counts) and the app-level fixture converged. Budgets get a
test per field with a report built by hand. Every test drives rounds through
`sync()` and the virtual clock (`packages/testing/src/clock.ts:27`) and waits
on chained microtasks.

## 6. Parity

The plan check covers Swift, Kotlin, Flutter and Rust apps at stage 1,
because they receive the checked SQL.

For the profiler, the Rust core needs: statement timing through `rusqlite`'s
`trace` feature (`Connection::profile` or `trace_v2`), which is off today
(`Cargo.toml:18`); request, response and apply measurements inside
`sync` (`client.rs:7330`); and a new FFI event, `profile`, beside `change`
and `progress` (`ffi/src/lib.rs:244`, `:346`). Each binding then needs a
profiler of its own in Swift, Kotlin and Dart, since none has a live-query
layer to wrap.

This RFC defers that work. The trace feature compiles statement tracing into
`libsyncular` for every release artifact, or a second debug artifact per
platform doubles the binding release matrix. A new event is cross-core
behavior and needs SPEC text and a conformance scenario. The consumer reports
behind this RFC (`pitfalls.md:55`, `:247`) do not name a native host.

## 7. Stages, cost and proof

| Stage | Gives an app developer | Packages | Estimate | Proof |
| --- | --- | --- | --- | --- |
| 1. Plan check | Findings for every query in every language, at generate time | `typegen`, docs `tooling-queries.md`, `tooling-cli.md`, changelog | ~200 lines plus fixtures | Golden findings per fixture (§3.6) |
| 2. Profiler | Per-query, per-round, per-subscription and per-write numbers in web, Tauri and React Native development builds | `web-client` (`./dev`, one worker hook), docs, changelog | ~500 lines plus tests | Unit tests over wrapped stubs with an injected clock; bundle exclusion assertion; one bench lane |
| 3. Strict mode and budgets | Perturbed app tests and CI performance budgets | `testing`, conformance (one scenario per core), docs, changelog | ~300 lines plus tests | Testkit tests per perturbation and budget (§5.4) |
| 4. Native counters (deferred) | Statement time and round bytes for native hosts | `rust/crates/client`, `ffi`, three bindings, SPEC | unestimated | Conformance scenario plus binding tests |

Stage 1 comes first: it needs no runtime code, reaches every language, and
its findings are the cheapest to fix. Stage 3 depends on stage 2's report.

## 8. Risks in detail

### 8.1 Noise and allowlist rot

Findings carry no cost estimate (§3.2). An app with small reference tables
will acknowledge several scans. The required `reason` and the unused-entry
error keep the list reviewable; they do not make a scan of a growing table
visible once it is acknowledged. The profiler's `statements` report is the
runtime counterpart.

### 8.2 Planner drift

Bun's SQLite (3.54.0) plans the check; the browser and native SQLite can be a
different version. For the reliable findings of §3.2 the answer depends on
which indexes exist, which no version changes. For index choice it can
differ, which is why the check does not report index choice.

### 8.3 Profiler in production

Covered in §4.6. The guard depends on bundler environment signals.

### 8.4 Strict mode reports core bugs

A perturbation that hits a core defect produces an app-test failure that the
app developer cannot fix. Each perturbation therefore ships only with a
conformance scenario in both cores (§5.2).

### 8.5 Worker bundle budget

The worker lane has 8 bytes under its ceiling (`authority-bundle.test.ts:8`,
`:33`). Passing a headers reader to `createTransport` adds bytes; the change
must remove at least as many from the worker graph.

## 9. Alternatives

### 9.1 Extend the diagnostics snapshot

The snapshot already crosses every host, both cores and the FFI, so new
counters would reach every language at once. Its contract excludes SQL, scope
values and row counts (`diagnostics.ts:1-7`, SPEC §7.6), and it ships in
production; per-query SQL and timings in it would break that contract, and
counters without SQL do not tell a developer which query to fix. Every field
is cross-core behavior, so each addition needs both cores and a catalog
scenario.

### 9.2 A browser devtools extension

An extension gives a panel without app code changes. It still needs a data
source inside the page, which is the profiler of stage 2; it adds a
distribution channel per browser; and it gives nothing to tests, CI or native
apps. It can be built later on top of the profiler and the `__SYNCULAR__`
registry.

### 9.3 Bench suite and docs only

`bench/` measures Syncular on its own fixture (`bench/src/read-lane.ts:26-49`)
and the pitfalls page records consumer findings after the fact. Neither sees
an app's queries, subscription counts or write patterns. The pitfalls entries
this RFC cites were found that way, in production or on a dev API, late.

## 10. Notes for the maintainer

- `AGENTS.md:23` names `flushQuerySchedulers` as the deterministic flush
  helper. No function of that name exists in the repository; tests use
  chained microtasks. This RFC's proof plans use chained microtasks.
- SPEC numbers two sections §7.6 ("Privacy-safe client diagnostics" at
  `docs/SPEC.md:5675` and "Live sync progress" at `:5779`).
