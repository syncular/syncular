# Upgrade to wire version 4

Wire version 4 replaces the per-table subscription with the unit, gives each replica one cursor, and bounds the server's idempotency results with a per-outbox watermark. This page lists what an app changes, the order to deploy server and clients, and what an installed app does on its first launch after the update.

::meta{for="Teams upgrading an app from wire version 3" time="15 minutes" first="concepts-subscriptions" spec="4.1 4.5 6.3 9"}

:::terms
- **Unit**: A subscription to one value per scope variable. It covers every table that declares all of its variables.
- **Registration list**: The client's units in registration order. A pull sends it only when it changed.
- **Replica cursor**: The one cursor a replica holds for all of its live units.
- **Version guard**: The client rule that applies a delivered change only when its version exceeds the local row's.
- **Watermark**: The lowest outbox sequence the server still keeps idempotency results for, per outbox.
:::

## What breaks

The server reads wire version 4 only, and the clients write version 4 only. A version 3 request fails decoding and receives `sync.invalid_request`; a version 3 client stops syncing until it updates. Its outbox stays on the device and pushes after the update.

| Area | Version 3 | Version 4 |
|---|---|---|
| Subscribe | an app-chosen id, a table, a list of values per variable, optional `params` | a scope map with one value per variable; the id is derived; no table, no `params` |
| Unit state | `subscriptionState(id)`, `subscriptions()`, `subscriptionCatchup(id)` | `unit(id)`, `units()`, `unitCatchup(id)` |
| Window base | `{ table, variable, fixedScopes? }` with value lists | `{ variable, fixedScopes? }` with one value per fixed variable |
| Manifest template | `{ name, table, scopes: { v: ["{p}"] } }` | `{ name, scopes: { v: "{p}" } }` |
| Diagnostics | version 1: `activeSubscriptions`, `expectedSubscriptions` request | version 2: `units`, `activeUnits`, `replicaCursor`; no request argument |
| Server limits | `maxSubscriptionsPerRequest` counts subscriptions; `maxScopeValuesPerSubscription` | `maxSubscriptionsPerRequest` counts units (default 500); `maxScopeValuesPerSubscription` is gone |
| Server events | `pull.served.subscriptions[]`, `request.handled.subscriptions` | `pull.served.units[]`, `registrationTraveled`, `live`; `request.handled.units` |
| Row versions | an insert starts at 1; a delete and a scope move keep the version | an insert starts above the delete floor; a delete and a scope move advance the version |
| Pushes | `clientId` and `clientCommitId` | also an outbox id and a sequence per commit; `sync.commit_expired` below the watermark |

A unit has no table list. An app that held only some of the tables of one scope variable on a device gives those tables their own scope variable before it upgrades.

## Deploy server and clients together

1. Update every `@syncular/*` package and the `syncular-client` crate to the same release ([Do's and Don'ts](/pitfalls/#do-upgrade-every-syncular-package-and-syncular-client-crate-together)).
2. Deploy the server. Its storage migrates in place: `SqliteServerStorage` on construction, `PostgresServerStorage` and `D1ServerStorage` in `migrate()` (D1 also on the first open of a storage instance). The migration adds the unit columns of the client record, the change-scope index `(partition, var, value, commit_seq)`, the delete floor and the watermark table, drops the version 3 subscription column, sets each partition's delete floor to the highest version its tombstones recorded, and sets each partition's pruning horizon to its last commit. A delete logged before version 4 carries no row version, so no client can resume from a cursor into that history.
3. Release the clients in the same window. Until a device updates, its pulls and pushes fail with `sync.invalid_request`.

A client record written under version 3 holds no registration list. The server answers the first referring pull of such a client `unregistered`, the client sends its list in the next round, and realtime delivers no delta to it until that round completes.

## What a user sees on first launch

A replica written under version 3 keeps its outbox, outcome journal, rows, row versions, `clientId`, log epoch and pending evictions. In the same transaction the client deletes the version 3 subscription records, cursors, effective-scope echoes, resume tokens and window registry entries, creates its outbox id, and sets the replica cursor to `-1`.

The app then registers its units, and each unit bootstraps once. The rows already on the device stay readable during the download; the first page of each covered table replaces the rows of the unit's scope. A device with 13 units downloads 13 bootstraps and from then on sends a 32-byte digest and one cursor per round. Window registrations are gone after the upgrade, so the app sets its windows again on launch. Generated queries and `useRetainedWindow` claim their units when they mount; code that calls `setWindow` at startup does it already.

Results the server stored for a client under version 3 carry no outbox sequence. The client's first version 4 request settles them: the server assigns the request's sequences to the results it matches and deletes that client's other sequence-less results.

## Code changes per platform

Register units where the app registered subscriptions. One unit replaces every per-table subscription of the same scope value.

:::tabs
```ts sdk=web title="src/sync.ts"
// Version 3
client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
client.subscribe({ id: 'comments', table: 'comments', scopes: { list_id: ['groceries'] } });

// Version 4: one unit covers todos and comments.
const unitId = client.subscribe({ list_id: 'groceries' });
client.unsubscribe(unitId);
```
```tsx sdk=react title="src/Support.tsx"
// Version 3
const { snapshot } = useDiagnostics({
  expectedSubscriptions: [{ id: 'todos', table: 'todos' }],
});

// Version 4
const { snapshot } = useDiagnostics();
// snapshot.units, snapshot.activeUnits, snapshot.replicaCursor
```
```swift sdk=swift title="Sync.swift"
// Version 3
try client.subscribe(id: "todos", table: "todos", scopes: ["list_id": ["groceries"]])

// Version 4
let unitId = try client.subscribe(scopes: ["list_id": "groceries"])
try client.unsubscribe(id: unitId)
```
```kotlin sdk=kotlin title="Sync.kt"
// Version 3
client.subscribe("todos", "todos", mapOf("list_id" to listOf("groceries")))

// Version 4
val unitId = client.subscribe(mapOf("list_id" to "groceries"))
client.unsubscribe(unitId)
```
```dart sdk=flutter title="lib/sync.dart"
// Version 3
client.subscribe('todos', 'todos', scopes: {'list_id': ['groceries']});

// Version 4
final unitId = client.subscribe({'list_id': 'groceries'});
client.unsubscribe(unitId);
```
```ts sdk=react-native title="src/sync.ts"
// Version 3
await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });

// Version 4
const unitId = await client.subscribe({ list_id: 'groceries' });
```
```ts sdk=tauri title="src/sync.ts"
// Version 3
await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });

// Version 4
const unitId = await client.subscribe({ list_id: 'groceries' });
```
```rust sdk=rust title="src/sync.rs"
// Version 3
client.subscribe("todos".into(), "todos".into(),
    vec![("list_id".into(), vec!["groceries".into()])], None)?;

// Version 4
let unit_id = client.subscribe(BTreeMap::from([
    ("list_id".into(), "groceries".into()),
]))?;
```
:::

`subscribeMany` (`subscribe_many` in Rust) takes a list of scope maps and returns the ids in order. A subscription that listed several values becomes one unit per value. A subscription with `params` loses them; no server read them.

A window base loses its table. Swift and Kotlin gain typed window methods in place of the raw `setWindow` command:

:::tabs
```ts sdk=web title="src/sync.ts"
// Version 3
await client.setWindow({ table: 'messages', variable: 'created_month' }, last(3, 'month'));

// Version 4
await client.setWindow({ variable: 'created_month' }, last(3, 'month'));
```
```swift sdk=swift title="Sync.swift"
// Version 4
try client.setWindow(variable: "created_month", units: ["2026-10", "2026-11"])
```
```kotlin sdk=kotlin title="Sync.kt"
// Version 4
client.setWindow("created_month", listOf("2026-10", "2026-11"))
```
```dart sdk=flutter title="lib/sync.dart"
// Version 4
client.setWindow('created_month', ['2026-10', '2026-11']);
```
```rust sdk=rust title="src/sync.rs"
// Version 4
let base = WindowBase { variable: "created_month".into(), fixed_scopes: Default::default() };
client.set_window(&base, &last(3, TimeBucketUnit::Month, now_ms)?)?;
```
:::

A `fixedScopes` entry holds one value: `{ variable: 'month', fixedScopes: { workspace_id: 'w1' } }`. Change-batch `appliedCommits` entries lose `subscriptionId`, and progress snapshots carry `unitId` in its place.

## The manifest

A subscription template becomes a unit template: drop `table`, and give each variable one value or one `{param}` placeholder. `syncular generate` refuses the version 3 shape with `typegen.subscription_legacy_shape`. A template that listed several values becomes several templates.

```json title="syncular.json"
"subscriptions": [
  { "name": "todosInList", "scopes": { "list_id": "{listId}" } }
]
```

The generated builders return the unit's scope map, which `subscribe` takes: `client.subscribe(todosInListSubscription.scopes({ listId }))` in TypeScript, `SyncularSchema.subscriptions.TodosInList.scopes(listId:)` in Swift, `SyncularSchema.Subscriptions.TodosInList.scopes(listId =)` in Kotlin, `SyncularTodosInListSubscription.scopes(listId:)` in Dart ([Schema & typegen](/guide-schema/)).

## Server code

- `limits.maxSubscriptionsPerRequest` counts the units of a request that carries the registration list; remove `maxScopeValuesPerSubscription` from the config ([Request limits](/guide-server/#request-limits)).
- Event sinks read `pull.served.units[]`, `pull.served.registrationTraveled` and `pull.served.live`, and `request.handled.units` ([Operations](/server-operations/)).
- `publishSqliteImage({ config, partition, table, scopes, allowed? })` takes the unit's scope map and an optional allowed map ([Bootstrap & segments](/concepts-bootstrap/#publishing-images-from-another-host)).
- `RemoteQueryCoverage.base` is `{ variable, fixedScopes? }` with one value per fixed variable.
- The admin trace verdict `no-subscription` is `no-unit`; client records list `units`; `findWrite` reports the outbox watermark of a write whose result is gone ([Admin console](/server-admin-console/)).
- A custom `ServerStorage` implements `readLiveWindow`, the registration fields of `putClientRecord`, and the per-outbox watermark of SPEC §6.3.2; run the shared contract suite in `packages/server/test/storage-contract.ts` against it ([Storage reference](/server-storage-reference/)).

## Row versions

An insert starts the row's `server_version` one above the partition's delete floor, and a delete and a scope move advance it by 1. Code that treats version 1 as "never edited", compares versions of different rows, or expects a recreated row to restart at 1 reads wrong values. Compare a row's version only with that row's earlier versions ([Commits](/concepts-commits/#the-commit-log)). The client's version guard skips a delivered change at or below the local row's version, so a replayed delta or segment changes nothing.

## Restored and copied replicas

A replica restored from a backup, or copied with its database to a second device, shares its `clientId`, outbox id and sequence with the original. Its commits below the original's watermark receive `sync.commit_expired`, which the client records as a rejection. An app that restores or copies a replica resets it before the first sync on the new device: delete the database file and open a fresh one, which creates a new client id, a new outbox id and an empty outbox. In Rust, `SyncClient::reset_replica(path)` deletes the file with its journal files. The pending writes of the copy belong to the original device and leave with the reset.

## Verify the upgrade

Read `diagnosticsSnapshot()` after the first launch on an upgraded device:

- `version` is `2`.
- `activeUnits` equals the number of units the app registers, and stays under 500 for the heaviest account the app's tests cover.
- `units.bootstrapping` falls to `0` once every unit downloaded its rows.
- `replicaCursor` is `0` or higher once a unit is live.

On the server, `pull.served.registrationTraveled` is `true` for a device's first version 4 round and `false` for its later rounds while its units stay the same.
