# Profiling your app

`@syncular/client/dev` records what an app's Syncular usage costs in a development build: how often each live query runs and which change ran it, the statements the client executes, the bytes of every sync round, the units the next pull sends against the server's limit, and the single-operation writes that could have been one commit. `assertBudgets` turns those numbers into test failures, so a regression fails CI before it reaches production.

::meta{for="App developers on the web, Tauri and React Native SDKs" time="10 minutes" first="tooling-testing"}

:::terms
- **Profiler**: The object `createSyncProfiler()` returns. It wraps surfaces the app already constructs and keeps one report in memory.
- **Identical run**: A live query run whose rows equal the previous run's rows. The React store publishes nothing for it, but SQLite still ran the read.
- **Write burst**: Consecutive single-operation `mutate` calls, each starting within `burstWindowMs` (16 ms by default) of the previous one.
:::

## Wrap a direct client

Pass each surface through the profiler as you construct the client:

```ts title="src/sync.dev.ts"
import {
  httpSyncTransport,
  SyncClient,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { createSyncProfiler } from '@syncular/client/dev';
import { openPersistentWasmDatabase } from '@syncular/client/wasm';

export const profiler = createSyncProfiler();
export const client = profiler.client(
  new SyncClient({
    database: profiler.database(await openPersistentWasmDatabase('app')),
    transport: profiler.transport(httpSyncTransport(syncUrl, { headers })),
    realtime: profiler.realtime(webSocketRealtimeConnector(realtimeUrl)),
    schema,
  }),
);
```

Hand `client` to `SyncProvider` as usual. Every hook reads through the wrapper, so the profiler sees each live query run. Read the numbers from the console or a debug screen:

```ts
console.table(profiler.report().queries);
profiler.reset(); // start a fresh measurement
```

Import the module only in development builds, for example behind `if (import.meta.env.DEV)` with a dynamic `import()`. `createSyncProfiler` throws `client.profiler_in_production` unless the build carries a development or test signal (`import.meta.env.DEV`, or `NODE_ENV` set to `development` or `test`) and no production one, the same signals the `__SYNCULAR__` registry reads ([Troubleshooting](/troubleshooting/)). The profiler keeps SQL text in memory and sends nothing over the network.

## What the report holds

`profiler.report()` returns a plain object:

| Field | Content |
|---|---|
| `queries` | Per live query id (or SQL text for an unowned read): `runs`, `identicalRuns`, `totalMs`, `maxMs`, `rows` of the last run, and `triggers`, the runs per changed table plus `mount` (first run) and `refresh` (no dependency table changed) |
| `statements` | Per SQL text: `runs`, `totalMs`, `maxMs` and `rows`, the client's own bookkeeping statements included |
| `rounds` | The last 256 rounds: `via` (`http` or `socket`), `requestBytes`, `responseBytes` and `ms` from request to last response byte |
| `deltas` | Count and bytes of realtime deltas |
| `units` | `active` (the units the next pull sends), `peak`, `limit`, and per unit the bootstrap `bytes`, `rows` and `ms` |
| `writes` | `mutateCalls`, `operations`, and `bursts` with their commit count and tables |

The server refuses a pull that carries more units than its `maxSubscriptionsPerRequest` limit (500 by default). Pass the deployment's value as `createSyncProfiler({ unitLimit })` so `units.limit` matches it.

A `refresh` run saw no change to a dependency table since the previous run; a window change, a coverage claim or an explicit refresh caused it. Many `identicalRuns` on one query mean it re-runs for changes that leave its rows as they were: a dependency on a table the query does not need, or a table-wide dependency where scope keys would narrow it.

## Profile a worker handle

In worker mode the database and the transport live in the worker. Write a development worker entry that wraps them and posts their numbers to the page on a `BroadcastChannel`:

```ts title="src/sync.worker.dev.ts"
import { httpSyncTransport } from '@syncular/client';
import { createSyncProfiler } from '@syncular/client/dev';
import { openPersistentWasmDatabase } from '@syncular/client/wasm';
import { startSyncWorker } from '@syncular/client/worker';

const profiler = createSyncProfiler({
  channel: new BroadcastChannel('syncular-profile'),
});
startSyncWorker({
  openDatabase: async () =>
    profiler.database(await openPersistentWasmDatabase('app')),
  createTransport: (config, http) =>
    profiler.transport(httpSyncTransport(config.endpoints.syncUrl, http)),
});
```

`createTransport` receives `http`, the reader of the host's current headers, so a token set with `setHeaders` reaches the next request. On the page, create a profiler on the same channel name and wrap the handle:

```ts title="src/sync.dev.ts"
const profiler = createSyncProfiler({
  channel: new BroadcastChannel('syncular-profile'),
});
const client = profiler.client(await createSyncClientHandle(config));
```

The page's report merges the worker's `statements` and `rounds`; `profiler.reset()` on the page resets the worker's profiler too. Query times on the page include the worker round trip. After a leadership change the new leader's worker starts an empty statement profile, and the report sums both.

## Profile Tauri and React Native

Wrap the native client with `profiler.client()`. The report fills `queries`, `units` and `writes`; query times include the IPC hop. The Rust core executes statements and rounds natively, so `statements`, `rounds` and `deltas` stay empty.

Swift, Kotlin and Flutter apps have no profiler. Their queries get the generate-time plan check ([Named queries](/tooling-queries/#query-plan-check)), and `diagnosticsSnapshot()` reports active units and the last round's counters.

## Lock the numbers in tests

`@syncular/testkit` takes a profiler per client and wraps the client's database, loopback transport, realtime connector and `api`. Pass the virtual clock so times stay deterministic, run the app scenario, and assert budgets:

```ts title="test/budgets.test.ts"
import { test } from 'bun:test';
import { assertBudgets, createSyncProfiler } from '@syncular/client/dev';
import { createTestSync } from '@syncular/testkit';

test('the board screen stays within its budgets', async () => {
  const sync = await createTestSync({ schema });
  const profiler = createSyncProfiler({ now: () => sync.clock.now() });
  const a = await sync.client('a', { profiler });
  // ... the app scenario ...
  assertBudgets(profiler.report(), {
    maxActiveUnits: 50,
    maxRoundBytes: 64_000,
    maxRunsPerQuery: 4,
    maxIdenticalRuns: 0,
    maxWriteBurst: 1,
  });
});
```

| Budget | Measured |
|---|---|
| `maxActiveUnits` | `units.peak` |
| `maxRoundBytes` | The largest `requestBytes + responseBytes` of one round |
| `maxRunsPerQuery` | The largest `runs` of one query |
| `maxIdenticalRuns` | `identicalRuns` summed over all queries |
| `maxWriteBurst` | The largest commit count of one write burst |

`assertBudgets` throws `client.profile_budget_exceeded` listing every exceeded budget in `details.exceeded`, each with `budget`, `limit` and `measured`.
