# Live demos

This page is for developers who want to watch Syncular sync a scoped data model, queue offline writes, and surface conflicts before writing code. The hosted sync lab needs no install; the local demos and the native examples run from the repository.

::meta{for="Developers trying Syncular before building with it" time="12 minutes" first="quickstart"}

:::terms
- **Release board**: The lab's data model: boards, members, cards, labels, card labels, and comments. Every table carries `board_id` and syncs under the `board:{board_id}` scope. The [SYQL playground](/playground/) loads the same schema and sample rows.
- **Device**: One independent client core with its own SQLite database. The lab runs two: Ada's laptop and Ben's phone.
- **Commit log**: The server's ordered record of commits. The lab shows each commit's sequence number, origin device, board scope, outcome, and receivers.
- **Outbox**: The local commits a device has written and the server has not yet acknowledged.
- **Embedded server**: The sync server running in a Web Worker inside the page.
:::

:::figure{title="What the hosted sync lab runs" note="Everything inside one page" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">Laptop · Ada, team lead</span>Client core over in-memory SQLite. Member of the Web and Mobile boards.</div>
<div class="node ok"><span class="t">Phone · Ben, mobile engineer</span>Client core over in-memory SQLite. Member of the Mobile board.</div>
</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Embedded server · Web Worker</span>Syncular server core over in-memory sqlite-wasm. <code>resolveScopes</code> returns the boards an actor has a <code>members</code> row on. Its event stream feeds the commit log.</div>
</div>

::caption[The hosted lab is static files. No request leaves the page, and a reload resets both devices and the server.]
:::

## Try the hosted sync lab

[Open the sync lab](/demo/). The commit log, the packets on the wires between the devices and the server, and the tour checkmarks come from the embedded server's events (`push.applied`, `push.conflicted`, `realtime.delta`, `pull.served`) and from each device's own rows, outbox, subscriptions, and conflict records.

:::::steps
::::step{title="Move a card" time="1 min"}
Drag a card on the laptop's Mobile board to another column. On touch, or with the keyboard, open the card and pick a column.

::checkpoint[The log gains a `move` commit from the laptop on `board:mobile`, a packet travels to the phone, and the card changes column there. A move on the laptop's Web board stays on the laptop, and its log entry states that the phone has no access.]
::::

::::step{title="Go offline and move cards on both devices" time="2 min"}
Switch the phone's network to offline and move a card on it, then move a card on the laptop.

::checkpoint[The phone's outbox counter grows and its outbox panel lists each queued move. The laptop's move reaches the server, and its log entry reads "held for Phone (offline)".]
::::

::::step{title="Reconnect and watch the replay" time="1 min"}
Switch the phone back online.

::checkpoint[The phone pulls the commits it missed, its outbox drains in order, and the log shows one commit per replayed move with its delivery to the laptop.]
::::

::::step{title="Create a conflict and resolve it" time="2 min"}
Select "Simulate conflict". Both devices go offline and move the same Mobile card to different columns. The phone reconnects first and its move applies; the laptop then replays its move with a stale `baseVersion`.

::checkpoint[The log records a conflict, the card turns red on the laptop, and the card sheet shows the laptop's write next to the server row for each contested column. "Keep server" resolves the commit outcome with the server row; "Keep mine" re-pushes the patch with `baseVersion` set to the server version ([Conflicts](/concepts-conflicts/)).]
::::

::::step{title="Change the phone's scope" time="3 min"}
Select "Grant Web" under the phone. The laptop writes Ben's `members` row on the Web board, the phone subscribes to `board:web`, and its Local SQL lens runs the rows-per-board query. Select "Revoke Web" to delete the row again.

::checkpoint[After the grant, the phone bootstraps the 12 Web cards with their labels and comments. After the revoke, the phone's next round returns its `board:web` subscriptions as revoked, the phone purges those rows, and the lens shows only `board:mobile` ([Scopes](/concepts-scopes/)).]
::::
:::::

Every card edit is a sparse `patch` carrying the row's version, so a move on one device and an estimate change on the other both apply, and only writes to the same column conflict. A move writes `column_id` and a `position` between its new neighbours, and renumbers the column in one commit when no integer is left between them.

The Local SQL lens on each device runs read-only SQL against that device's SQLite through `client.query()`, which refuses writes and multi-statement input. The example queries cover joins, aggregates, and a window function over the Release board tables. The latency slider delays every message between the page and the embedded server by half the chosen round trip in each direction. "Server console" opens the `SyncularAdmin` interface for the embedded server in a side drawer, with horizon status, metrics, store stats, clients, commit metadata, row inspection, scope activity, and the event tail for the in-page `demo` partition.

## Run the demos locally

The local sync lab is a Bun process that holds the server (`@syncular/server-hono` over bun:sqlite), the `/realtime` WebSocket, the `/events` server-sent event stream that feeds the commit log, and the frontend bundles. Each device runs its whole client core in a Web Worker on sqlite-wasm with a persistent OPFS database, so a reload keeps the device's rows and outbox. Each device names its actor in an `x-syncular-demo-actor` header and an `actor` realtime parameter; the server accepts `ada` and `ben`. The latency slider and the server console belong to the hosted build.

```sh title="terminal"
git clone https://github.com/syncular/syncular
cd syncular
bun install
bun run --cwd apps/demo dev          # http://localhost:8787
bun run --cwd apps/demo-react dev    # http://localhost:8788
```

`apps/demo-react` is the hooks version: one client on `@syncular/react` against the same server core. It uses `useQuery` with generated dependencies, window coverage, and row identity; `useRawSql` for the done and total badge; typed `useMutation` helpers; and `useSyncStatus` for the outbox badge. The seed lists `groceries`, `work`, and `travel` are separate scope values. Picking one changes the query params, the generated coverage claims the new list, and the atomic result phase prevents a pending bootstrap from appearing as an empty list ([windowed sync](/concepts-windowing/)). Adding a todo shows the optimistic path: the row appears at once, the outbox badge ticks up, and the sync loop drains it.

The [demo README](https://github.com/syncular/syncular/tree/main/apps/demo) and the [demo-react README](https://github.com/syncular/syncular/tree/main/apps/demo-react) have the full walkthroughs.

## Native examples

Each binding ships a runnable example: a todo list over the native Rust core. The example README has its run and verification steps.

| Platform | Example |
|---|---|
| Swift (macOS) | A SwiftUI window and a terminal variant over `SyncularClient`, with a `TodoStore` of about 30 lines. [bindings/swift/example](https://github.com/syncular/syncular/tree/main/bindings/swift/example) |
| Kotlin (JVM) | A terminal app over `SyncularClient` (FFM, JDK 21+) with the same `TodoStore` shape. [bindings/kotlin/example](https://github.com/syncular/syncular/tree/main/bindings/kotlin/example) |
| Flutter | A todo list of about 150 lines over the Dart `SyncularClient` through `dart:ffi`. [bindings/flutter/example](https://github.com/syncular/syncular/tree/main/bindings/flutter/example) |
| React Native | The `@syncular/react` hooks over `createNativeSyncClient()`, a Rust-core TurboModule. [bindings/react-native/example](https://github.com/syncular/syncular/tree/main/bindings/react-native/example) |
| Tauri | The same hooks over `createTauriSyncClient()`, with a native instance in the Tauri host process. [bindings/tauri/example](https://github.com/syncular/syncular/tree/main/bindings/tauri/example) |

## Advanced: environment variables and URL modes

These switches apply to the local `apps/demo` only.

| Setting | Effect |
|---|---|
| `PORT=…` | Overrides the port (8787; `apps/demo-react` uses 8788). |
| `HOST=…` | Binds the server to one address, such as `127.0.0.1` behind a TLS proxy. Unset, Bun listens on all interfaces. |
| `SYNCULAR_DEMO_DB=path` | Persists server storage to a file. Server storage is in-memory by default, so a server restart forgets commits that the devices' persistent databases still hold. |
| `SYNCULAR_DEMO_ADMIN=1` | Mounts the operator console at `/admin`. |
| `SYNCULAR_DEMO_ADMIN_TOKEN=…` | Requires a matching `?token=` query parameter or `Authorization: Bearer` header on `/admin`. Unset, `/admin` is open. |
| `?multitab` | Open two tabs with it. Each device in the first tab becomes the leader: it spawns the worker, owns the OPFS database, and holds the socket. The second tab's devices proxy to it over a BroadcastChannel. The device label shows `leader` or `follower`, and closing the leader promotes the follower. |
| `?ephemeral` | Runs the device cores in memory on the main thread, labeled in the UI. Nothing survives a reload. |
