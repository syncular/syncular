# Testing your app

This page is for developers who want fast, deterministic tests of sync behavior: convergence, offline replay, transport faults, and React hooks. `@syncular/testkit` runs a Syncular server and N real clients in memory as plain function calls. You finish with tests that run under `bun test` with no HTTP, browser, or mocks between the assertion and the engine.

::meta{for="App developers on any SDK that runs tests under Bun" time="15 minutes" first="quickstart"}

:::terms
- **Test client**: A real `SyncClient` plus test-only controls for connectivity, faults, and realtime.
- **Loopback**: The in-process transport that connects each test client to the server handler.
- **Virtual clock**: The one epoch-ms source the server, every client, and the realtime hub share.
:::

:::figure{title="What createTestSync wires together" note="One process, no network" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">Test client a</span>SyncClient + bun:sqlite</div>
<div class="node hot"><span class="t">Test client b</span>SyncClient + bun:sqlite</div>
</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Loopback + faults</span>Function calls; the next exchange can drop, duplicate, or truncate</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Server handler</span>The same <code>@syncular/server</code> protocol handler your app runs</div>
</div>
<div class="node"><span class="t">Virtual clock</span>Shared by the server, every client, and the realtime hub; moves only when the test moves it</div>

::caption[The loopback replaces HTTP and WebSocket. The client and server code on either side is the production code.]
:::

## Steps

:::::steps
::::step{title="Install the kit" time="1 min"}
```sh title="terminal"
bun add -d @syncular/testkit
```

The kit requires the Bun runtime, because the in-memory client backend is `bun:sqlite`. The test API works from `bun:test`, vitest, or jest files run under Bun. The React helper also needs `react`, an optional peer.

::checkpoint[`@syncular/testkit` appears in `devDependencies`.]
::::

::::step{title="Test that two clients converge" time="3 min"}
```ts title="test/converge.test.ts"
import { expect, test } from 'bun:test';
import { createTestSync } from '@syncular/testkit';
import { schema } from '../src/syncular.generated'; // your generated schema

test('two clients converge', async () => {
  const sync = await createTestSync({ schema });
  const a = await sync.client('a');
  const b = await sync.client('b');

  const sub = { id: 's', table: 'todos', scopes: { list_id: ['groceries'] } };
  a.api.subscribe(sub);
  b.api.subscribe(sub);

  a.api.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: {
        id: 't1',
        list_id: 'groceries',
        title: 'Buy milk',
        done: false,
        position: 1,
        updated_at_ms: Date.now(),
      },
    },
  ]);
  await sync.syncAll(); // push A's outbox, pull it into B

  expect(b.api.query('SELECT title FROM todos')).toEqual([{ title: 'Buy milk' }]);
  await sync.dispose();
});
```

`sync.client(id?)` creates and starts a `TestClient`. Its `.api` is a real `SyncClient` with `subscribe`, `mutate`, `query`, `syncUntilIdle`, `conflicts`, `setWindow`, `uploadBlob`, and the rest. The `TestClient` adds `goOffline()`, `goOnline()`, `sync()`, `faults`, and `connectRealtime()`.

::checkpoint[`bun test test/converge.test.ts` passes.]
::::

::::step{title="Test offline writes and replay" time="3 min"}
```ts title="test/offline.test.ts"
test('an offline client queues writes, then drains on reconnect', async () => {
  const sync = await createTestSync({ schema });
  const a = await sync.client('a');
  const b = await sync.client('b');
  const sub = { id: 's', table: 'todos', scopes: { list_id: ['groceries'] } };
  a.api.subscribe(sub);
  b.api.subscribe(sub);
  await sync.syncAll();

  a.goOffline();
  a.api.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: {
        id: 't1',
        list_id: 'groceries',
        title: 'written offline',
        done: false,
        position: 1,
        updated_at_ms: Date.now(),
      },
    },
  ]);

  // Visible locally, but nothing leaves the client:
  expect(a.api.query('SELECT title FROM todos')).toEqual([{ title: 'written offline' }]);
  expect(a.api.pendingCommits()).toHaveLength(1);
  await expect(a.api.sync()).rejects.toThrow();

  await b.sync();
  expect(b.api.query('SELECT id FROM todos')).toHaveLength(0);

  // Back online: the queue drains and B converges.
  a.goOnline();
  await sync.syncAll();
  expect(a.api.pendingCommits()).toHaveLength(0);
  expect(b.api.query('SELECT id, title FROM todos')).toEqual([
    { id: 't1', title: 'written offline' },
  ]);
  await sync.dispose();
});
```

`goOnline()` does not start a round. The test decides when the round runs.

::checkpoint[The test passes: the outbox holds one commit offline and zero after `syncAll()`.]
::::

::::step{title="Inject transport faults" time="3 min"}
`client.faults` arms transport faults with the vocabulary the conformance harness uses. Arm a fault and the next matching exchange misbehaves. The pattern is: arm, sync (it rejects), assert the outbox is intact, sync again (it drains).

```ts title="test/faults.test.ts"
a.api.mutate([/* … */]);
a.faults.dropNextRequests = 1;
await expect(a.api.sync()).rejects.toThrow();   // request lost
expect(a.api.pendingCommits()).toHaveLength(1); // still queued
await a.sync();                                 // retried, drains
expect(a.api.pendingCommits()).toHaveLength(0);
```

| Fault | Effect |
|---|---|
| `dropNextRequests = N` | Fails the next N sync requests before they reach the server. The outbox survives. |
| `dropNextResponses = N` | Delivers the next N requests, then loses their responses. The server applied the commit and the ack is lost. |
| `deferNextPulls = N` | Returns acks while withholding pull sections without advancing their cursors. |
| `duplicateNextRequest = true` | Delivers the next request twice and returns the second response (an idempotency-cache test). |
| `truncateNextResponse = true` | Cuts the next response at a seeded offset (a decode error). |
| `dropNextSegmentRequests = N` | Fails the next N segment downloads. |
| `truncateNextSegmentDownload = true` | Cuts the next segment download at a seeded offset. |
| `dropNextUrlFetches = N` | Fails the next N signed-URL fetches. |
| `corruptNextUrlFetch = true` | Corrupts the bytes of the next signed-URL fetch (tamper detection). |
| `refuseNextRealtimeConnect = true` | Refuses the next realtime connect. |
| `corrupt(bytes)` | Returns a copy with one seeded byte flipped, for tamper tests. |

::checkpoint[The test passes: one commit stays queued after the dropped request and drains on the retry.]
::::

::::step{title="Control time" time="2 min"}
The server, every client, and the realtime hub share one `VirtualClock`. Segment TTLs, signed-URL expiry, and lease windows are deterministic.

```ts title="test/clock.test.ts"
sync.clock.now();                  // current epoch ms
sync.clock.advance(60_000);        // +60 s, returns the new now()
sync.clock.set(1_800_000_000_000); // jump to an absolute instant
```

The clock is the epoch-ms source Syncular reads. It does not intercept `setTimeout`, so real-timer behavior such as presence heartbeats and rate caps is outside the kit.

::checkpoint[`sync.clock.now()` returns the value you set.]
::::

::::step{title="Test realtime deltas" time="2 min"}
```ts title="test/realtime.test.ts"
await b.connectRealtime(); // b gets a live socket on the in-memory hub
a.api.mutate([/* … */]);
await a.sync();            // the hub fans the commit to b as a delta
// b applies it without an explicit pull
```

`goOffline()` also drops the socket. Reconnect with `connectRealtime()`.

::checkpoint[`b.api.query(…)` returns A's row without a call to `b.sync()`.]
::::

::::step{title="Test React hooks" time="3 min"}
`syncWrapper` from `@syncular/testkit/react` builds the `wrapper` that `@testing-library/react` takes and mounts your hooks on a test client.

```tsx title="test/hooks.test.tsx"
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRawSql } from '@syncular/react';
import { createTestSync } from '@syncular/testkit';
import { syncWrapper } from '@syncular/testkit/react';

const sync = await createTestSync({ schema });
const client = await sync.client('a');
client.api.subscribe({ id: 's', table: 'todos', scopes: { list_id: ['x'] } });
await client.sync();

const { result } = renderHook(
  () => useRawSql('SELECT * FROM todos'),
  { wrapper: syncWrapper(client) },
);

await act(async () => {
  client.api.mutate([/* … */]);
});
await waitFor(() => expect(result.current.rows).toHaveLength(1));
```

The re-render comes from the client's real invalidation path, the same one production hooks use. It works the same for `useQuery` and the other hooks.

::checkpoint[`result.current.rows` has one row after the mutation.]
::::
:::::

## Options and boundaries

`createTestSync` takes your generated `schema` plus these options:

| Option | Meaning |
|---|---|
| `partition`, `actorId` | The partition and actor the test server authenticates. |
| `resolveScopes` | Host authorization. The default grants every scope. |
| `validators`, `commitValidator` | Server write validators and the whole-commit validator. |
| `startMs` | Where the virtual clock starts. |

The returned `TestSync` exposes `clock`, `server`, `clients`, `client()`, `syncAll()`, and `dispose()`. The [testkit README](https://github.com/syncular/syncular/blob/main/packages/testing/README.md) lists the full `TestSync` and `TestClient` surface.

- The transport is an in-process loopback. To test your Hono or Workers adapter or real fetch and WebSocket wiring, boot the server yourself as in the [quickstart](/quickstart/).
- The driver and pairing machinery and the scenario catalog live in `@syncular/conformance` ([Protocol & conformance](/reference/#protocol--conformance)).
- Durable reaction planners and runners use server integration and storage contract tests with the same virtual-clock discipline ([reaction testing checklist](/server-reactions/#testing-checklist)).
