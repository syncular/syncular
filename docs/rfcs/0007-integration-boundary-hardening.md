# RFC 0007: Integration boundary hardening

- Status: accepted and implemented
- Authors: Syncular maintainers
- Last updated: 2026-07-18
- Source: follow-up integration feedback from the Diego offline-first medical
  scheduling POC
- Related: [RFC 0002](./0002-integration-feedback.md),
  [RFC 0003](./0003-revisioned-reactive-views.md)

## Summary

This RFC closes the remaining integration work found while running one medical
scheduling application across the browser worker/OPFS client and the native
Tauri client. It covers six boundaries which are individually small enough to
look application-specific but which every serious integrator would otherwise
have to rediscover:

1. relational constraint failures during push become durable, privacy-safe
   commit rejections;
2. generated TypeScript named queries decode boolean result columns instead of
   asserting that SQLite's `0 | 1` values are already booleans;
3. browser followers expose a bounded, typed blocked state when the Web Locks
   owner cannot be reached through the cross-tab channel;
4. React exposes one typed startup/availability boundary for schema,
   migration, and browser-leadership states;
5. the official Vite integration retains a worker resource only while its
   captured generated-schema identity remains current; and
6. concurrency and correction guidance is consolidated into one task-oriented
   guide.

No new wire frame is required. The push work implements an error already in
the SSP2 catalog, while the remaining changes are generated-code, client,
React, example, conformance, and documentation changes.

| Feedback item | Current state | RFC section |
| --- | --- | --- |
| SYNC-F29 | Open | §1 durable relational-constraint rejection |
| SYNC-F11 | Open for generated TypeScript results | §2 generated boolean result normalization |
| SYNC-F30 | Partially addressed by bounded follower calls | §3 partition-safe browser leadership |
| SYNC-F31 | Partially addressed by public raw status | §4 first-class React availability boundary |
| SYNC-F26 | Application workaround only | §5 schema-aware Vite HMR ownership |
| SYNC-F07 | Individual concepts documented | §6 concurrency and conflict-correction guide |

## Motivation

The POC found three correctness mismatches and three integration seams:

- a stale offline insert could violate a secondary unique index, preserve the
  existing database row, but escape the push transaction as a raw storage
  exception; the client then retained and replayed the same poison commit;
- a generated result field typed as `boolean` could be the numeric SQLite
  representation at runtime;
- a browser context could observe an occupied Web Lock without sharing the
  leader's `BroadcastChannel` partition;
- a schema floor was public but still required each React application to
  classify versions and build its own terminal guard;
- unconditional HMR retention could keep a worker compiled against an obsolete
  generated schema; and
- the concurrency primitives were documented separately, without one complete
  decision and recovery flow.

The current implementation already contains useful partial behavior. This RFC
keeps it: relational writes are atomic, follower calls time out with
`client.follower_timeout`, `useSyncStatus()` exposes `schemaFloor`, native
generated `fromRow` functions lift SQLite booleans, Vite documentation retains
one HMR owner, and conflict/outcome documentation covers the individual
primitives. The contract below specifies only the missing behavior and the
integration of those pieces.

## Goals

- A client-authored commit must never become an indefinitely replayed storage
  exception merely because it violates an application-table constraint.
- Generated result types and values must agree on every supported JavaScript
  host and on initial and reactive reads.
- A browser handle must never present an unreachable follower as ordinary
  readiness.
- React applications must be able to render every terminal or recoverable
  startup state from a public discriminated union.
- Development HMR must preserve one OPFS owner without preserving an obsolete
  worker schema.
- The documented correction flow must be sufficient to implement a durable UI
  without reading the protocol specification or internal client fields.

## Non-goals

- Automatically resolving domain conflicts or choosing a merge policy for an
  application.
- Turning arbitrary database, transport, storage, or programming failures into
  commit rejections. Only positively classified relational constraints are
  mapped.
- Stealing or expiring a live browser Web Lock. Promotion remains legal only
  after the browser grants the exclusive lock.
- Giving raw SQL a generated semantic result type. Runtime normalization is a
  promise of generated named queries, whose result IR supplies the evidence.
- Making `SyncProvider` reload the page or deploy a newer client/server.
  Provider actions expose retry/reload seams; the application owns policy.
- Replacing the existing conflict, rejection, or final-outcome journals.

## Current-state corrections

Two observations from the POC need precise wording before they become product
contracts.

First, an unreachable follower is not literally unbounded today. The follower
bind and calls use a ten-second default deadline and reject with
`client.follower_timeout`. Client construction currently catches the initial
bind timeout and returns the degraded follower anyway, however, so the
application does not receive a first-class blocked state and a subsequent
query pays another deadline before failing. This RFC builds on the existing
deadline rather than inventing a second timeout path.

Second, schema state is not internal today. `useSyncStatus()` publicly exposes
the raw `SchemaFloor`, but that value contains only the required and latest
server versions. It does not carry the current generated client version or a
classified reason, and `SyncProvider` only understands resource pending/error.
This RFC adds classification and presentation; it does not replace a hidden
API.

## 1. Durable relational-constraint rejection

### Contract

A relational constraint failure caused while applying a `PUSH_COMMIT`
operation is an operation-level, non-retryable rejection:

- code: `sync.constraint_violation`;
- category: `invalid-request`;
- retryable: `false`;
- recommended action: `fixRequest`;
- message: fixed Syncular-owned prose with no database, table, index, column,
  SQL, payload, or driver text; and
- `opIndex`: the pushed operation whose row write triggered the constraint.

This applies to the relational constraints supported by a storage backend,
including secondary unique constraints. It uses the existing SSP2 error
catalog entry; no new code or frame is introduced.

The complete commit is atomic. If operation N fails, operations `0..N-1`,
blob-reference changes, candidate commit-log rows, and all other staged state
are discarded. The server then persists the rejected `StoredPushResult` under
`(partition, clientId, clientCommitId)` in a clean transaction. A later replay
returns that stored rejection and never attempts the application writes again.

The HTTP adapter returns a normal SSP2 response containing the rejected
`PUSH_RESULT`. The realtime adapter does the same inside the active round. A
constraint rejection does not abort the response stream, close the socket, or
escape into the host's generic error boundary. A subsequent request is served
normally.

### Storage error classification

The server storage layer gains an internal typed constraint error. Each
relational adapter is responsible for recognizing its own structured engine
signal and wrapping it before the error reaches the push protocol. The wrapper
may retain an engine error as an internal `cause`, but its public fields are
bounded Syncular data only.

Classification must be positive:

- SQLite uses the driver's structured SQLite result/extended-result code;
- PostgreSQL uses the SQLSTATE constraint class and supported specific codes;
- D1 classifies the corresponding failed statement in its atomic batch and
  retains the pushed-operation association for deferred execution; and
- an unrecognized error remains an internal failure and is rethrown.

No adapter may classify by forwarding raw error text. If a platform exposes no
structured detail, an allowlisted adapter-private recognition step may decide
only that the error is a constraint; the text still never enters a response,
event, rejection journal, or generated diagnostic.

Eager adapters know the active `opIndex` when `upsertRow()` fails. Buffered
adapters must retain an opaque operation association with the statements they
enqueue so a commit-time constraint reports the same index. The public storage
interface does not expose database-specific constraint names.

### Durable finalization

Constraint handling reuses the existing rejected-result finalization seam:

1. mark the candidate transaction failed;
2. roll it back completely;
3. begin a clean rejection transaction;
4. persist the single terminating result; and
5. return the persisted value through `resultFrame()`.

Storage implementations must make the idempotency record first-writer-safe. If
a concurrent request has already finalized the same key, finalization returns
the existing stored outcome rather than overwriting it. This preserves the
existing exactly-once identity contract and also hardens the ordinary
rollback-then-persist rejection path.

### Verification

The server test uses a schema with a compound secondary unique index and pushes
an aggregate in which an earlier sibling write is valid and a later different
row ID collides. It proves:

- one rejected `PUSH_RESULT` with stable code, retryability, and colliding
  `opIndex`;
- byte-identical preservation of the pre-existing row;
- rollback of the valid sibling and all auxiliary indexes;
- no commit-log entry;
- a subsequent unrelated sync succeeds;
- replay returns the same persisted rejection; and
- neither the protocol response nor emitted operational events contain engine
  text.

The case runs against SQLite, PostgreSQL/PGlite, and D1. It belongs in server
tests and in the cross-storage conformance catalog, not only in direct
`upsertRow()` tests.

## 2. Generated boolean result normalization

### Contract

Every result column whose analyzed query IR type is `boolean` is returned as a
JavaScript `true | false` by a generated TypeScript named query. `null` remains
`null` for nullable columns. A real boolean is preserved; SQLite numeric
representation is decoded consistently with the native emitters (`0` is
false, any accepted non-zero SQLite boolean is true). Any other value is a
generated-result decoding error rather than an unchecked cast.

This applies equally to:

- the generated async query function;
- the first read performed by `useQuery()`;
- every reactive re-read after invalidation;
- direct Bun/Node clients;
- browser worker leaders and followers;
- the Tauri JavaScript bridge; and
- the React Native JavaScript bridge.

Raw `client.query()` and `useRawSql()` remain storage-shaped and untyped unless
the application supplies its own row mapping.

### Generated descriptor

Typegen emits one result decoder per query from the analyzed result columns.
The generated `NamedQuery` descriptor gains a `mapRow` member, and the direct
runner invokes the same function:

```ts
export interface NamedQuery<Row, Params = undefined> {
  // existing fields
  readonly mapRow: (row: Readonly<Record<string, unknown>>) => Row;
}
```

The React structural descriptor accepts `mapRow` optionally so an application
can upgrade `@syncular/react` before regenerating. Absence means the historical
identity cast. Newly generated files always provide it.

The reactive store applies `mapRow` before row-key calculation, equality
comparison, and object reconciliation. Thus the first result and later results
have the same value kinds, boolean normalization cannot create spurious
updates, and memoized rows still retain identity when their semantic values are
unchanged.

The generated decoder is the single TypeScript truth for all projection
columns that need semantic lifting. This RFC requires booleans; future result
types may reuse the seam instead of adding host-specific casts.

### Verification

- Typegen golden tests cover aliased, nullable, joined, and SYQL boolean
  projections.
- A generated direct runner receives `0`, `1`, `false`, `true`, and `null` and
  returns the declared shape.
- React tests prove the initial result and an invalidation result are both
  booleans and retain row identity when semantically equal.
- Host parity fixtures run the same generated query through direct,
  worker/follower, Tauri, and React Native command surfaces.
- Swift, Kotlin, and Dart `fromRow` fixtures remain green and agree with the
  TypeScript rules.

## 3. Partition-safe browser leadership

### Invariant

The Web Lock remains the sole authority for opening a shared persistent
database. Failure to reach the apparent leader through `BroadcastChannel` is
not evidence that the lock is stale and never permits a forced takeover. A
follower promotes only when its pending exclusive lock request is actually
granted.

This rule prevents two writers even when browser partition semantics are
surprising. Availability is recovered in one of three ways: the existing owner
becomes reachable, the browser releases its lock and grants it to a follower,
or the application opens an explicitly isolated replica whose database, lock,
and channel names are derived from the same replica identity.

### Leadership state

Worker handles expose a subscribable public snapshot:

```ts
type LeadershipState =
  | { state: 'leader'; clientId: string }
  | { state: 'follower'; leaderClientId: string; epoch: number }
  | { state: 'waiting'; reason: 'handover' | 'leader-announcement' }
  | {
      state: 'blocked';
      reason: 'leader-unreachable';
      code: 'client.follower_timeout';
      retryable: true;
    };
```

The existing role getters remain for compatibility. The richer snapshot is
the source for status and React integration.

An initial bind timeout is no longer swallowed as ordinary readiness. It
transitions the handle to `blocked`. Calls made while waiting retain the
existing bounded queue; calls made while blocked reject immediately with the
typed error until a leader announcement or granted lock changes the state.
An in-flight call timeout also moves the follower to `blocked`. A later valid
announcement rebinds it without replacing the handle.

Leader announcements act as heartbeats while followers are present. A
follower records the last reachable leader epoch and moves through `waiting`
to `blocked` after the configured deadline. Timer throttling may delay visual
notification in a suspended page, but an application call always retains its
own deadline and cannot hang.

### Shared versus isolated replicas

The browser configuration documents two explicit deployment modes:

- **shared**: ordinary same-partition tabs use one database, Web Lock, channel,
  client ID, and presence peer; this remains the default; and
- **isolated**: an application supplies a stable replica identity, and the
  database name, lock name, and channel name are all derived from it. This is
  the supported mode for embeds/previews/history entries known not to share a
  coordination partition.

`multiTab: false` remains supported as the strict single-owner opt-out. It is
not presented as a cure for namespace mismatch unless the application also
uses a distinct database and lock identity. Documentation must show the full
tuple; changing only one name is unsafe or ineffective.

### Verification

- Existing ordinary leader/follower/promotion tests remain unchanged.
- An injected test shares the lock implementation while deliberately
  partitioning the channels. It reaches `blocked` within the configured
  deadline, issues no worker/database open, and fails calls immediately.
- Releasing the original lock promotes exactly one waiter; no test observes
  concurrent database owners.
- A later reachable announcement clears `blocked` without replacing the
  handle.
- An isolated-replica fixture derives distinct database, lock, and channel
  names and opens independently.
- Browser-level coverage exercises ordinary tabs and an embedded/preview
  topology in addition to the deterministic injected unit tests.

## 4. First-class React availability boundary

### Client classification

Every client status snapshot adds `currentSchemaVersion`. From that value,
`schemaFloor`, `upgrading`, and browser leadership state, the public bindings
derive one discriminated availability value:

```ts
type SyncAvailability =
  | { state: 'ready' }
  | { state: 'migrating'; currentSchemaVersion: number }
  | {
      state: 'blocked';
      reason:
        | 'client-upgrade-required'
        | 'server-behind'
        | 'incompatible-schema'
        | 'leader-unreachable';
      currentSchemaVersion: number;
      requiredSchemaVersion?: number;
      latestServerSchemaVersion?: number;
      retryable: boolean;
    };
```

Classification is mechanical:

- `required > current` means `client-upgrade-required`;
- a known `latest < current` means `server-behind` (including the reference
  server's exact-version response where `required === latest < current`);
- a floor that cannot be ordered into either case, including
  `required < current <= latest`, means
  `incompatible-schema`;
- `upgrading` without a terminal floor means `migrating`; and
- an unreachable browser leader means `leader-unreachable`.

The TypeScript core, Rust core, command router, worker handle, Tauri bridge, and
React Native bridge expose the same version fields. Applications do not parse
messages or import generated schema merely to classify the state.

### Provider seam

`SyncProviderProps` gains an additive `renderBoundary` callback for typed
startup and availability states. The callback receives a discriminated state
and applicable actions:

```ts
type SyncBoundaryState =
  | { state: 'starting' }
  | { state: 'startup-error'; error: Error; retryable: boolean }
  | Exclude<SyncAvailability, { state: 'ready' }>;

interface SyncBoundaryActions {
  readonly retry?: () => Promise<void>;
}
```

```tsx
<SyncProvider
  client={resource}
  renderBoundary={(state, actions) => (
    <SyncBlockedScreen state={state} onRetry={actions.retry} />
  )}
>
  <App />
</SyncProvider>
```

The boundary covers resource startup, startup error, migration, and the
terminal blocked reasons above. Existing `fallback` and `renderError` remain
supported and preserve their current behavior when `renderBoundary` is absent.
The library supplies a retry when the resource/handle can retry; an application
may supply its own reload/deployment action.

When compatibility is restored, migration completes, a new client resource is
installed, or a browser leader becomes reachable, the provider automatically
renders its children again. A satisfied persisted native floor must not
reappear; the already-landed recovery behavior remains covered.

### Query seam

Generated and raw React query results add a typed `availability` field and a
`blocked` phase. A terminal block is never reported as ordinary initial
loading:

- `phase === 'blocked'`;
- `isLoading === false`;
- `availability.state === 'blocked'`; and
- the last safely read rows may remain present for deliberate read-only UI,
  but they are never presented as complete fresh server state by the boundary.

Adding `blocked` to the phase union is an intentional source-visible API
addition and is called out in the release notes. Query entries subscribe to
status/leadership changes as well as table/window changes, so entering or
leaving a boundary does not require an unrelated row invalidation.

### Verification

- Provider tests cover resource pending/error, migration, client-behind,
  server-behind, incompatible, leader-unreachable, and recovery to ready.
- Query-hook tests prove a terminal floor yields `blocked`, not `loading`, for
  both empty and previously populated results.
- Worker and native fixtures carry current, required, and latest versions with
  identical names and classifications.
- Browser-worker and Tauri documentation render the same canonical guard.

## 5. Schema-aware Vite HMR ownership

The Vite guide and an official React example retain this record in
`import.meta.hot.data`:

```ts
interface RetainedSyncularResource {
  readonly schemaVersion: number;
  readonly resource: SyncClientResource;
}
```

`schemaVersion` is captured into the record when the resource is created. It
is never read later from a hot-updated live ESM binding and assigned to the old
resource.

On module evaluation:

- no retained record creates one resource;
- an equal captured version reuses the same resource for ordinary component or
  query HMR; and
- a different captured version awaits disposal of the old resource before
  creating the replacement and requests full invalidation so the page, worker,
  generated schema, and generated queries advance together.

Disposal ordering is normative. The replacement must not be constructed while
the old worker can still own the same OPFS SAH pool or leader lock. A failed
disposal is surfaced through the development startup boundary rather than
silently opening a competing owner.

The guide explains why generated query HMR alone is insufficient: page modules
can adopt new SQL immediately while an already-running worker still owns the
old local schema. Boot-time schema recovery only runs in the replacement
worker, so retaining the old worker prevents that recovery point from being
reached.

A focused Vite fixture/test performs ordinary HMR reuse followed by one schema
bump. It asserts one owner at all times, disposal before replacement, and a
successful query against the new column. The example is referenced from the
React, web, Vite, and troubleshooting pages.

## 6. Concurrency and conflict-correction guide

A new **Concurrency and conflict correction** guide consolidates the existing
material without duplicating the normative protocol specification. It uses a
generated SYQL query, React, and one multi-row aggregate throughout.

The guide must cover:

1. projecting `_sync_version AS server_version` and receiving exact generated
   `serverVersion` values;
2. choosing `baseVersion = 0` for create-if-absent, a positive confirmed
   version for compare-and-set, or no base for explicit last-write-wins and
   chained optimistic offline work where no new confirmed version exists;
3. why a local optimistic sentinel is not a server concurrency token;
4. the distinction between `sync.version_conflict`, protocol rejections, and
   host/domain validation rejections;
5. whole-commit rollback, including the limits of per-row validators and the
   role of `commitValidator`;
6. keep-server, keep-local, and explicit-merge flows, with corrected replacement
   commits and the correct new `baseVersion`;
7. explicit acknowledgement through `resolveCommitOutcome()`;
8. restoring unresolved correction UI after restart and how outcome retention
   treats active versus resolved entries; and
9. when the operation must be a server-authoritative command/projection rather
   than an ordinary synced mutation.

The final section contains a decision table:

| Requirement | Use |
| --- | --- |
| Offline creation/editing with deterministic row ownership | Synced mutation |
| Compare-and-set edit of a confirmed row | Synced mutation with positive `baseVersion` |
| Create only if the primary key is absent | Synced mutation with `baseVersion = 0` |
| Deliberate last-write-wins or chained unconfirmed local edit | Synced mutation without a base |
| Mergeable CRDT field | Synced CRDT mutation without a base for the CRDT-only change |
| Validate one authorized proposed row | Row validator |
| Validate one atomic candidate aggregate | `commitValidator` |
| Allocate scarce/global resources, choose privileged values, or transform authoritative state | Server-authoritative command plus synced projection |

The guide includes complete code for an aggregate rejection, correction, sync,
acknowledgement, process restart, and restoration of the remaining active
outcomes. User-facing docs call the first category “ordinary synced writes”;
internal classification names such as “Class S” are explained if retained and
are not required vocabulary.

## Compatibility and rollout

- The SSP2 wire format and error catalog are unchanged.
- Storage adapters gain internal classification/finalization capabilities;
  custom adapters that do not classify a constraint retain loud internal-error
  behavior until upgraded. Server documentation marks full push conformance as
  requiring the new capability.
- Generated TypeScript descriptors add `mapRow`. React accepts older generated
  descriptors during the transition, while regeneration enables semantic
  normalization.
- Status and availability fields are additive across client/bridge JSON
  surfaces.
- The new React `blocked` phase expands a public union and is explicitly called
  out for exhaustive-switch consumers.
- Existing `multiTab`, role, `fallback`, and `renderError` APIs remain
  supported.

The work ships in this order:

1. durable constraint rejection and all-storage conformance;
2. generated result decoding and host parity;
3. leadership snapshot and partitioned-context coverage;
4. cross-core schema classification and the React boundary;
5. schema-aware Vite example/documentation; and
6. the consolidated correction guide.

The first two are correctness fixes. The browser and React work may share the
same availability types but must remain independently testable. Documentation
lands with the APIs/examples it describes rather than ahead of a release.

## Completion criteria

This RFC is complete only when:

- SQLite, PostgreSQL, and D1 return and replay the same safe constraint
  rejection from a real push;
- generated boolean result values agree across direct, worker/follower,
  Tauri, React Native, and reactive reads;
- a deliberately partitioned browser follower reaches a typed blocked state
  without opening a second writer;
- React renders and clears every schema/leadership boundary from public typed
  data;
- the official Vite fixture survives same-schema HMR and one schema bump with
  one owner; and
- the task-oriented concurrency guide contains the decision table and complete
  restart/correction example.

Consumer verification then runs the Diego POC matrix on browser, Tauri,
iOS, and Android with generated drift clean. Passing package tests or
publishing a package alone does not close an item.
