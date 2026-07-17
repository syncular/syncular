# RFC 0006: Rust named-query code generation

- Status: accepted and implemented
- Authors: Syncular maintainers
- Last updated: 2026-07-18
- Scope: `packages/typegen`, `rust/crates/client`, `spec/syql`, query and Rust
  documentation
- Related architecture: [`docs/DESIGN-queries.md`](../DESIGN-queries.md)
- Normative language: [`docs/SYQL.md`](../SYQL.md)
- Conformance entry point: [`spec/syql/manifest.json`](../../spec/syql/manifest.json)

## Summary

Add Rust as a first-class named-query code-generation target. Typegen will
consume the existing QueryIR and emit a deterministic `.rs` module containing:

- typed parameter and projection-row types;
- exact revision-1 SYQL input, validation, and physical-plan selection;
- strict conversion between Rust values and the Rust client's dynamic query
  value boundary;
- typed one-shot and atomic-snapshot runners;
- query identity, table dependencies, scope dependencies, synchronization
  coverage, and proven row identity.

The proposal adds no Rust-specific query language, SQL analyzer, replication
behavior, or query engine. QueryIR remains the semantic boundary. The existing
Rust `SyncClient::query` and `SyncClient::query_snapshot` methods remain the
execution boundary.

Rust codegen is one complete target, not a raw-SQL convenience wrapper. A Rust
consumer must receive the same selected statement, positional binds, exact
integer behavior, presence semantics, reactive facts, and coverage facts as a
TypeScript consumer of the same QueryIR.

## Motivation

Syncular's Rust client can already execute checked SQL and read rows, coverage,
and the local revision atomically. Rust applications must currently repeat the
remaining compiler work by hand:

- duplicate query strings and positional bind order;
- manually define result structs and decode dynamic JSON values;
- reproduce optional-input and present-null behavior;
- choose one statement from a lowered SYQL variants plan;
- restate table/scope dependencies and `WindowCoverage`;
- keep that code synchronized with migrations and QueryIR.

That is exactly the drift that named-query generation removes for TypeScript,
Swift, Kotlin, and Dart. It is especially unnecessary in Rust because the core
already owns the local SQLite connection and the atomic snapshot operation.

The current pieces are deliberately close to sufficient:

1. QueryIR records authored and lowered SQL, ordered physical binds, public
   inputs, result columns, selected statements, dependencies, coverage, and
   row identity.
2. `SyncClient::query` accepts positional dynamic values and returns dynamic
   rows.
3. `SyncClient::query_snapshot` returns rows, coverage, and local revision from
   one SQLite read snapshot.
4. `ClientChangeBatch` supplies the transaction-boundary changes required by a
   Rust host that wants to build a reactive observer.

The missing layer is generated Rust source over these primitives.

## Design principles

1. QueryIR is the only semantic input to the emitter.
2. Generated Rust is idiomatic without changing cross-target query meaning.
3. Values are lossless across SQLite's signed 64-bit integer and BLOB domains.
4. Invalid generated-query inputs and malformed rows fail explicitly.
5. Reactive metadata is emitted even though v1 does not prescribe a Rust UI
   framework or observer runtime.
6. Generation is byte-deterministic and does not require a Rust toolchain.
7. Existing manifests and generated outputs remain byte-identical unless the
   Rust target is requested.

## Goals and invariants

### R1 — one compiler contract

Rust consumes the same `AnalyzedQuery` and serialized QueryIR as every other
emitter. It does not parse SQL, infer types, select a lowering backend, or
reconstruct reactive metadata.

### R2 — exact statement and bind parity

For a public input value, every target selects the same physical statement and
produces positionally equivalent binds. This includes `neutralize` and
`variants`, optional groups, nested activation controls, finite sort profiles,
and bounded limits.

### R3 — presence is not null

An absent optional nullable value remains distinct from a present `NULL`.
Generated Rust represents this with `SyqlPresence<Option<T>>`.

### R4 — exact integer behavior

SYQL `integer` maps to Rust `i64`. Inputs bind without conversion through
`f64`. Results accept both an ordinary JSON integer and the Rust client's
lossless `{"$bigint":"..."}` output envelope.

### R5 — strict result decoding

A missing column, unexpected null, invalid envelope, out-of-range integer, or
wrong dynamic type returns a query/column-specific error. The runner never
silently removes a malformed row.

### R6 — atomic typed snapshots

The typed snapshot runner decodes the rows returned by one
`SyncClient::query_snapshot` call. Its rows, coverage verdict, and revision
therefore describe one local SQLite read snapshot.

### R7 — proven metadata only

Generated dependencies, coverage, and row identity are direct renderings of
QueryIR. Unproven scope precision remains table-wide; unproven coverage or row
identity remains absent.

### R8 — deterministic source

The same QueryIR, options, and typegen version produce byte-identical Rust.
Generated source is `rustfmt`-clean, but `syncular generate` does not invoke
`rustfmt` or require Cargo to be installed.

## Non-goals

- Generating Rust schema declarations. Rust continues to load neutral schema
  IR through the existing client API.
- A Rust-specific SQL or SYQL frontend.
- A new query executor or direct generated `rusqlite` access.
- Protocol, replication, subscription, or storage changes.
- An async client API. Generated functions follow the synchronous Rust client.
- A framework-specific reactive hook or store.
- Serde derives for accepting arbitrary/dynamic public query input objects.
- Changing the public shapes emitted for TypeScript, Swift, Kotlin, or Dart.

## Manifest contract

Rust named queries are opt-in through an object-valued output:

```json
{
  "manifestVersion": 1,
  "output": {
    "rust": {
      "queriesPath": "./src/syncular_queries.rs",
      "clientCrate": "syncular_client"
    }
  }
}
```

`queriesPath` is required and is resolved relative to `syncular.json`.
`clientCrate` is optional and defaults to `syncular_client`, the Rust module
name of the `syncular-client` package. It supports Cargo dependency aliases
without placing project-specific imports in QueryIR. It must be one valid Rust
identifier; module paths and arbitrary source fragments are rejected.

The Rust output is object-only in revision 1. A bare string is rejected. This
leaves room for an independent Rust schema output later without making today's
single path ambiguous.

Adding a recognized optional output does not bump `manifestVersion`. Older
manifests are unchanged; older typegen versions correctly reject the unknown
`rust` key rather than silently skipping requested output.

Requesting `output.rust.queriesPath` participates in the existing
`wantsQueries` behavior. It therefore analyzes the configured query directory
and fails when no `.sql` or `.syql` query exists.

## Generated module contract

Each query is emitted as a public snake-case Rust module. A query named
`listTodos` becomes `list_todos`. Common support types are emitted once at the
top of the generated file.

For example, the following SYQL:

```syql
sync query listTodos(
  listId,
  status?: string | null,
  unassigned: bool = false,
) {
  select id, title, status, done
  from todos
  where list_id = :listId
    and when(status) status is :status
    and when(unassigned) assignee_id is null
  order by sortBy default newest {
    newest: created_at desc, id desc;
    oldest: created_at asc, id asc;
  }
  limit pageSize default 50 max 200;
}
```

produces this logical public shape (formatting and private helpers omitted):

```rust
use syncular_client::{
    CoverageSnapshot, QueryRow, QueryValue, SyncClient, WindowCoverage,
};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SyqlPresence<T> {
    #[default]
    Absent,
    Present(T),
}

pub struct SelectedQuery {
    pub sql: &'static str,
    pub params: Vec<QueryValue>,
}

pub struct QueryDependency {
    pub table: &'static str,
    pub scope_keys: Option<Vec<String>>,
}

pub struct TypedQuerySnapshot<Row> {
    pub revision: String,
    pub rows: Vec<Row>,
    pub coverage: CoverageSnapshot,
}

pub struct QueryDescriptor<Params, Row> {
    pub id: &'static str,
    pub tables: &'static [&'static str],
    pub select: fn(&Params) -> Result<SelectedQuery, QueryError>,
    pub dependencies: fn(&Params) -> Vec<QueryDependency>,
    pub coverage: fn(&Params) -> Vec<WindowCoverage>,
    pub row_key: Option<fn(&Row) -> Vec<QueryValue>>,
}

pub mod list_todos {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    pub struct Row {
        pub id: String,
        pub title: String,
        pub status: Option<String>,
        pub done: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub enum SortBy {
        #[default]
        Newest,
        Oldest,
    }

    #[derive(Debug, Clone, PartialEq)]
    pub struct Params {
        pub list_id: String,
        pub status: SyqlPresence<Option<String>>,
        pub unassigned: bool,
        pub sort_by: SortBy,
        pub page_size: Option<i64>,
    }

    impl Params {
        pub fn new(list_id: String) -> Self {
            Self {
                list_id,
                status: SyqlPresence::Absent,
                unassigned: false,
                sort_by: SortBy::Newest,
                page_size: None,
            }
        }
    }

    pub const ID: &str = "sha256:<query-ir-hash>/listTodos";
    pub const TABLES: &[&str] = &["todos"];
    pub const DESCRIPTOR: QueryDescriptor<Params, Row> = QueryDescriptor {
        id: ID,
        tables: TABLES,
        select,
        dependencies,
        coverage,
        row_key: Some(row_key),
    };

    pub fn select(params: &Params) -> Result<SelectedQuery, QueryError>;
    pub fn dependencies(params: &Params) -> Vec<QueryDependency>;
    pub fn coverage(params: &Params) -> Vec<WindowCoverage>;
    pub fn row_key(row: &Row) -> Vec<QueryValue>;

    pub fn run(
        client: &SyncClient,
        params: &Params,
    ) -> Result<Vec<Row>, QueryError>;

    pub fn snapshot(
        client: &mut SyncClient,
        params: &Params,
    ) -> Result<TypedQuerySnapshot<Row>, QueryError>;
}
```

The `QueryDescriptor` value is metadata and selection, not an observer. A host
may use it with `ClientChangeBatch` to build a cache or reactive integration;
`run` and `snapshot` remain useful without such a host.

Param-less queries use `()` as their descriptor parameter type and expose
`run(client)` and `snapshot(client)` convenience functions. Their metadata and
selection functions take `&()` internally.

### Input types

| QueryIR type | Rust public type |
|---|---|
| `string` | `String` |
| `integer` | `i64` |
| `float` | `f64` |
| `boolean` | `bool` |
| `json` | `String` |
| `bytes` | `Vec<u8>` |
| `blob_ref` | `String` |
| `crdt` | `Vec<u8>` |
| nullable value | `Option<T>` |

Revision-1 SYQL public inputs map as follows:

- required scalar: `T`, or `Option<T>` when required and nullable;
- optional non-null scalar: `Option<T>`;
- optional nullable scalar: `SyqlPresence<Option<T>>`;
- optional atomic group: `Option<GeneratedGroup>`;
- default-false boolean: `bool` initialized to `false`;
- sort selector: a generated enum implementing `Default` with the declared
  default profile;
- bounded limit: `Option<i64>`, with the declared default applied during
  selection and bounds checked before client execution.

Every `Params` type has a `new(...)` constructor taking required inputs and
initializing omission defaults. A query with no required inputs additionally
implements `Default`. Fields remain public so normal Rust struct-update syntax
can configure optional values.

The Rust type system makes unknown inputs, partial groups, invalid sort names,
and missing required inputs unrepresentable in ordinary generated API calls.
Runtime validation still rejects non-finite floats and limits outside
`1..=max`, using the stable SYQL runtime error code from the cross-target
contract.

### Binding and plan selection

`select` validates the effective inputs, selects the exact statement recorded
in `QuerySyqlExecutionPlan`, and returns its positional binds. It is public so
tests, diagnostics, and future Rust observers can inspect the same execution
decision used by `run` and `snapshot`.

Selection rules are mechanical renderings of QueryIR:

- activation controls use declaration order;
- `SyqlPresence::Absent` is inactive and `Present(None)` is active with a SQL
  `NULL` bind;
- optional groups activate atomically;
- default-false booleans activate only when true;
- sort enum variants select complete compiler-checked profiles;
- the limit default is applied before bounds validation;
- compiler-generated binds never become public fields.

Integers bind as `QueryValue::from(i64)` and never pass through a floating
point representation. Bytes and CRDT values use the client's `{"$bytes":
"<hex>"}` query envelope. Strings, JSON text, blob references, booleans,
floats, and null bind through their corresponding dynamic values.

### Row decoding

The generated decoder reads the runtime key recorded as `column.langName`, not
the Rust field identifier. This matters because QueryIR projection lowering
may produce camel-case runtime aliases while Rust exposes snake-case fields.

Decoding is strict and accepts only the runtime representations produced by
the Rust query boundary:

- strings, JSON text, and blob references require a string;
- integers accept an in-range JSON integer or a decimal `$bigint` envelope;
- floats accept a finite JSON number, including an integer-valued number;
- booleans accept a JSON boolean or a numeric SQLite value, with zero false
  and non-zero true, matching the existing native emitters;
- bytes and CRDT require an even-length hexadecimal `$bytes` envelope;
- nullable columns accept explicit null, but a missing column is always an
  error;
- non-null columns reject null.

Decode errors contain the generated query ID, column runtime name, expected
QueryIR type, and a stable error category. They do not include the complete row
or parameter values, avoiding accidental disclosure of application data.

### Errors

The generated module defines one `QueryError` implementing `Display` and
`std::error::Error`, with these categories:

- `Input`: stable SYQL runtime code plus query ID and message;
- `Client`: query ID plus the error returned by `SyncClient`;
- `Decode`: query ID, column, expected type, and decode reason.

The error owns its strings so it can cross ordinary application task/thread
boundaries. No generated function panics for application data, dynamic rows,
or client errors.

### Reactive descriptor

`dependencies(params)` renders `QueryReactiveMetadata.dependencies`:

- a proven scope bind becomes a complete scope key string;
- multiple proven values produce multiple keys in deterministic QueryIR order;
- a dependency without proven scope values has `scope_keys: None`, meaning
  table-wide invalidation.

`coverage(params)` renders `QueryReactiveMetadata.coverage` directly into the
Rust client's `WindowCoverage`, including fixed scopes and requested units.
An ordinary `query` normally returns no coverage; a proven `sync query` may
return one or more entries.

`row_key` is present on the descriptor only when QueryIR proves an identity.
It returns values in QueryIR key order using the same lossless dynamic forms as
binds. There is no generated or authored fallback identity.

### Typed execution

`run` calls `select`, then `SyncClient::query`, then strictly decodes every
row. The first decode error fails the complete query result.

`snapshot` calls `select`, derives coverage from the same effective params,
and invokes `SyncClient::query_snapshot` once. It decodes that returned row
set and preserves the returned `revision` and `CoverageSnapshot` unchanged.

## Rust client support seam

The generated module should not require an application to depend directly on
the exact `serde_json` version used by `syncular-client`. The client crate will
therefore expose aliases for its existing dynamic query boundary:

```rust
pub type QueryValue = serde_json::Value;
pub type QueryRow = serde_json::Map<String, QueryValue>;
```

`SyncClient::query`, `QuerySnapshot::rows`, and their documentation will use
these aliases without changing their concrete ABI or serialization. The
aliases are re-exported from the crate root. This is a small public API
addition, not a query-engine change.

The Rust schema deserializer also accepts typegen's neutral `schemaVersion`
field as the alias of its existing `version` field. This makes the documented
direct `syncular.ir.json` path executable; it does not add a Rust schema-source
emitter or change schema IR.

Envelope encoding/decoding remains generated and private in revision 1. If a
second Rust-facing feature needs the same helpers, they can move behind a
documented client utility API in a later additive change.

## Naming

Rust is added to `NamingTarget` so collision and keyword failures occur during
generation rather than at Cargo compile time.

The mapping has two names for every generated field:

1. the QueryIR `langName`, used as the runtime row-map key;
2. a deterministic Rust identifier, used in source.

Rust identifiers use pinned snake-case conversion. Query module names are
snake-case, generated struct and enum names are UpperCamelCase, and enum
variants are UpperCamelCase. Leading/trailing underscores follow the existing
naming rules. Two QueryIR names mapping to one Rust identifier are a hard
error. Rust keywords are hard errors with an `AS` alias remediation; the
emitter does not silently introduce raw identifiers.

The pinned conversion preserves leading and trailing underscore runs, treats
an existing internal underscore run as one word boundary, inserts a boundary
before an uppercase letter following a lowercase letter or digit, inserts an
acronym boundary before the final uppercase letter when it is followed by a
lowercase letter, lowercases ASCII letters, and leaves digits in their current
word. For example: `createdAt` becomes `created_at`, `URLValue` becomes
`url_value`, `idURL` becomes `id_url`, and `col2Value` becomes `col2_value`.
Collapsed names still participate in collision detection.

The algorithm and keyword set become part of the naming tests and
`DESIGN-queries.md`, rather than relying on a third-party case conversion
library.

## Determinism and formatting

The header records the schema IR version and QueryIR hash, matching the other
query emitters. SQL literals, error text, identifiers, and strings use
emitter-owned escaping; no source fragment comes from an unchecked runtime
value.

Typegen writes source from deterministic templates and does not execute
`rustfmt`. The committed golden must pass the repository's pinned
`cargo fmt --check`. `syncular generate --check` compares the `.rs` file
byte-for-byte like every other output.

## Compatibility and versioning

- Existing manifests and outputs do not change when `output.rust` is absent.
- QueryIR does not change, so `queryIrVersion` does not change.
- The wire protocol and schema IR do not change.
- `syncular-client` gains public query aliases and accepts the neutral
  `schemaVersion` spelling; existing Rust source remains compatible.
- Adding the output key is an additive typegen feature under
  `manifestVersion: 1`.
- The generated Rust source is versioned with typegen and is freshness-gated;
  generated-source API stability follows the same policy as other emitters.

## Implementation plan

### Phase A — manifest and emitter foundation

- [x] Add `RustOutput { queriesPath, clientCrate }` and strict manifest
  parsing in `packages/typegen/src/manifest.ts`.
- [x] Add `rust` to `NamingTarget`, its reserved words, pinned case conversion,
  collision checks, and naming tests.
- [x] Add `packages/typegen/src/emit-queries-rust.ts` and export it from the
  package entry point.
- [x] Wire Rust into target discovery, `wantsQueries`, output generation,
  byte-exact check mode, watch mode, and LSP target discovery.
- [x] Add the `QueryValue` and `QueryRow` aliases to `syncular-client` and use
  them in the public query/snapshot signatures.

Exit criterion: a manifest can deterministically emit a compiling param-less
Rust query with a typed row and `run` function.

### Phase B — complete query semantics

- [x] Emit typed params for plain SQL queries.
- [x] Emit all revision-1 SYQL input shapes and constructors/defaults.
- [x] Implement finite sort enums, limit validation, presence, optional-group
  activation, and both physical-plan backends.
- [x] Implement lossless bind encoding for every QueryIR type.
- [x] Implement strict row decoding for nullability, booleans, exact i64,
  floats, strings, JSON/blob references, bytes, and CRDT.
- [x] Emit stable input/client/decode errors without data-bearing diagnostics.
- [x] Emit `select` and use it as the single path for both runners.

Exit criterion: Rust produces the same selected statement and binds as all
existing targets for every SYQL emitter/conformance vector.

### Phase C — descriptor and snapshot parity

- [x] Emit query ID, table constants, dependencies, coverage, and optional
  row-key functions.
- [x] Emit the generic `QueryDescriptor` value for every query.
- [x] Emit `TypedQuerySnapshot<Row>` and the atomic `snapshot` runner.
- [x] Test exact scope-key formatting, fixed scopes, unit order, conservative
  table-wide fallbacks, absent coverage, and proven composite row keys.

Exit criterion: a Rust host can execute or observe a query without manually
restating any QueryIR reactive or synchronization metadata.

### Phase D — conformance, compilation, and documentation

- [x] Add `syncular.queries.rs` to the basic typegen fixture and byte-exact
  golden tests.
- [x] Add Rust snippets to the revision-1 cross-emitter fixture schema and
  vectors.
- [x] Exercise Rust in the “every emitter consumes the same selected plan”
  lowering tests for `neutralize` and `variants`.
- [x] Compile the committed generated fixture from a Rust test so typegen
  goldens cannot drift into syntactically or semantically invalid Rust.
- [x] Run a real in-memory `SyncClient` smoke test covering `run` and atomic
  `snapshot`.
- [x] Add runtime cases for present-null versus absent, groups, defaults,
  every sort profile, limit boundaries, large positive/negative i64, booleans,
  nullable rows, bytes, CRDT, malformed envelopes, and decode failures.
- [x] Gate generated source with `cargo fmt --check` and `cargo clippy`.
- [x] Update typegen manifest/output docs, named-query architecture, SYQL
  target tables, Rust platform docs, and the website SYQL page.

Exit criterion: byte-exact generation, cross-emitter selection, Rust
compilation, real client execution, formatting, linting, and documentation are
green in CI.

## Verification matrix

| Area | Required proof |
|---|---|
| Manifest | accepted object/default crate path; missing/unknown/wrong-type keys rejected |
| Determinism | golden equality and `generate --check` failure after manual edit |
| Naming | modules, fields, types, keywords, leading underscores, and collisions |
| Plain SQL | param-less and parameterized queries; every result type/nullability |
| SYQL inputs | required/optional/nullable/group/bool/sort/limit public shapes |
| Lowering | identical neutralized and variants statement/bind selection |
| Fidelity | exact `i64`, non-finite float rejection, bytes/CRDT envelopes |
| Decoding | missing/null/wrong-type/malformed values fail with column context |
| Reactivity | table-wide and exact scope dependencies; no guessed precision |
| Coverage | none for local queries; exact bases/fixed scopes/units for proven sync queries |
| Identity | absent when unproven; stable scalar/composite order when proven |
| Snapshot | rows, revision, and coverage originate from one client snapshot call |
| Tooling | LSP target awareness, watch output, rustfmt, clippy, Cargo compilation |

The preferred compile proof uses the same committed `.rs` fixture as both the
typegen golden and a Rust `include!`/module input. This prevents a second
hand-maintained “compile fixture” from passing while actual generated output is
broken.

## Rejected alternatives

### Generate only typed rows

This leaves bind order, SYQL plan selection, presence, and coverage in
application code. It does not remove the drift codegen is intended to remove.

### Generate only `run`

A one-shot runner is useful but makes Rust second-class for revisioned views:
applications would still restate dependencies, coverage, and row identity.
The complete descriptor is small because QueryIR already contains the facts.

### Parse QueryIR at Rust runtime

Runtime interpretation avoids generated Rust source but gives up native types,
compile-time input shapes, ordinary navigation, and dead-simple deployment.
It also moves plan-selection correctness into another runtime implementation.

### Generate direct `rusqlite` code

Direct database access bypasses `SyncClient`'s read guard and atomic coverage
snapshot, couples codegen to storage internals, and cannot work uniformly with
future client storage changes.

### Use `Option<Option<T>>` for optional nullable values

Although technically capable of three states, nested `Option` is easy to
flatten accidentally and obscure at call sites. `SyqlPresence<Option<T>>`
names the semantic distinction shared by every emitter.

### Silently drop rows that fail decoding

Returning partial data hides schema/query drift and makes coverage truth apply
to a result set the query did not actually return. Strict failure is safer and
more diagnosable.

### Require `serde_json` directly in every application

The public `QueryValue`/`QueryRow` aliases give generated code the exact client
boundary types without coupling application manifests to the client's
transitive dependency version.

### Invoke `rustfmt` during generation

Generation must work on machines consuming Rust output without requiring a
locally installed toolchain. Templates remain deterministic; CI proves their
format.

## Acceptance decision

Rust named-query codegen is accepted and implemented with phases A through D
complete. The shipped target includes typed runners, atomic snapshots, and
descriptor metadata rather than advertising `run`-only support as parity. The
committed generated fixture compiles in the Rust workspace and the normative
cross-emitter vector includes Rust.
