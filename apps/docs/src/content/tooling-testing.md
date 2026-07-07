# Testing your app

`@syncular/testkit` stands up a whole syncular backend and N real clients
**in memory**, running as plain function calls rather than over HTTP, a
browser, or mocked pieces, so you can assert what your app actually sees:
convergence, offline queues, conflicts, live queries. Everything in it is
the shipped core: the same `SyncClient` and the same `@syncular/server`
protocol handler your production app runs, wired through an in-process
loopback. A passing test here reflects real sync behavior, running through
the same code paths production uses.

## Install

```sh
bun add -d @syncular/testkit
```

The kit requires the Bun runtime (the in-memory client backend is
`bun:sqlite`); the test API works from `bun:test`, vitest, or jest files run
under Bun. The React helper additionally needs `react` (an optional peer).

## Two clients converge

```ts
import { expect, test } from 'bun:test';
import { createTestSync } from '@syncular/testkit';
import { schema } from '../src/syncular.generated'; // your generated schema

test('two clients converge', async () => {
  const sync = await createTestSync({ schema });
  const a = await sync.client('a');
  const b = await sync.client('b');

  const sub = { id: 's', table: 'notes', scopes: { list_id: ['welcome'] } };
  a.api.subscribe(sub);
  b.api.subscribe(sub);

  a.api.mutate([
    { table: 'notes', op: 'upsert', values: { id: 'n1', list_id: 'welcome', body: 'hi' } },
  ]);
  await sync.syncAll(); // push A's outbox, pull it into B

  expect(b.api.query('SELECT body FROM notes')).toEqual([{ body: 'hi' }]);
  await sync.dispose();
});
```

`sync.client(id?)` creates **and starts** a `TestClient`. Its `.api` is a
real `SyncClient`: `subscribe`, `mutate`, `query`, `syncUntilIdle`,
`conflicts`, `setWindow`, `uploadBlob`, everything. The `TestClient` wraps
it with test-only controls: `goOffline()` / `goOnline()`, `sync()`,
`faults`, `connectRealtime()`.

`createTestSync` takes your generated `schema` plus optional `partition`,
`actorId`, `resolveScopes` (host authorization; the default grants
everything), and `startMs` (where the virtual clock starts). The returned
`TestSync` exposes `clock`, `server`, `clients`, `client()`, `syncAll()`,
and `dispose()`.

## Offline, then replay

```ts
test('an offline client queues writes, then drains on reconnect', async () => {
  const sync = await createTestSync({ schema });
  const a = await sync.client('a');
  const b = await sync.client('b');
  const sub = { id: 's', table: 'notes', scopes: { list_id: ['welcome'] } };
  a.api.subscribe(sub);
  b.api.subscribe(sub);
  await sync.syncAll();

  a.goOffline();
  a.api.mutate([
    { table: 'notes', op: 'upsert', values: { id: 'n1', list_id: 'welcome', body: 'offline' } },
  ]);

  // Optimistically visible locally, but nothing leaves the client:
  expect(a.api.query('SELECT body FROM notes')).toEqual([{ body: 'offline' }]);
  expect(a.api.pendingCommits()).toHaveLength(1);
  await expect(a.api.sync()).rejects.toThrow();

  // B has not seen it — nothing left A.
  await b.sync();
  expect(b.api.query('SELECT id FROM notes')).toHaveLength(0);

  // Back online: the queue drains and B converges.
  a.goOnline();
  await sync.syncAll();
  expect(a.api.pendingCommits()).toHaveLength(0);
  expect(b.api.query('SELECT id, body FROM notes')).toEqual([
    { id: 'n1', body: 'offline' },
  ]);
  await sync.dispose();
});
```

`goOnline()` does not auto-sync: your test decides when the round happens.

## Fault injection

`client.faults` arms transport faults with the same vocabulary the
conformance harness uses; testkit re-exports that vocabulary directly
instead of duplicating it. Arm one flag; the next matching exchange
misbehaves:

```ts
a.faults.dropNextRequests = 1;        // lose the next request (outbox survives)
a.faults.dropNextResponses = 1;       // server applies it, the ack is lost
a.faults.duplicateNextRequest = true; // replay it — idempotency-cache test
a.faults.truncateNextResponse = true; // cut the response short (decode error)
a.faults.corrupt(bytes);              // flip a seeded byte (tamper detection)
```

The pattern: arm, sync (it rejects), assert the outbox is intact, sync again
(it drains):

```ts
a.api.mutate([/* … */]);
a.faults.dropNextRequests = 1;
await expect(a.api.sync()).rejects.toThrow();   // request lost
expect(a.api.pendingCommits()).toHaveLength(1); // still queued
await a.sync();                                 // retried, drains
expect(a.api.pendingCommits()).toHaveLength(0);
```

## Deterministic time

The server, every client, and the realtime hub share one `VirtualClock`.
Time only moves when you move it, so segment TTLs, signed-URL expiry, and
lease windows are deterministic, with no wall-clock flake:

```ts
sync.clock.now();                  // current epoch ms
sync.clock.advance(60_000);        // +60s, returns the new now()
sync.clock.set(1_800_000_000_000); // jump to an absolute instant
```

The clock is the epoch-ms source syncular reads. It does **not** intercept
`setTimeout`, so real-timer behaviors (presence heartbeats, rate caps) are
out of scope: the kit targets sync, offline, and fault behavior.

## Realtime deltas

```ts
await b.connectRealtime(); // b gets a live socket on the in-memory hub
a.api.mutate([/* … */]);
await a.sync();            // the hub fans the commit to b as a delta
// b applies it without an explicit pull
```

`goOffline()` also drops the socket; reconnect with `connectRealtime()`.

## Testing React hooks

`syncWrapper` (from `@syncular/testkit/react`) builds the `wrapper` prop
`@testing-library/react` wants, mounting your hooks on a test client:

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRawSql } from '@syncular/react';
import { createTestSync } from '@syncular/testkit';
import { syncWrapper } from '@syncular/testkit/react';

const sync = await createTestSync({ schema });
const client = await sync.client('a');
client.api.subscribe({ id: 's', table: 'notes', scopes: { list_id: ['x'] } });
await client.sync();

const { result } = renderHook(
  () => useRawSql('SELECT * FROM notes'),
  { wrapper: syncWrapper(client) },
);

await act(async () => {
  client.api.mutate([{ table: 'notes', op: 'upsert', values: { id: 'n1', list_id: 'x', body: 'hi' } }]);
});
await waitFor(() => expect(result.current.rows).toHaveLength(1));
```

The re-render is driven by the client's real invalidation choke point, the
same one production hooks fire on, so a passing test reflects real
live-query behavior. This works identically for `useQuery` and the
other hooks.

## Scope

- The transport here is an in-process loopback. To test your Hono/Workers
  adapter or real fetch/WebSocket wiring, boot the server yourself (see
  [Quickstart](/quickstart/)).
- Driver/pairing machinery and the scenario catalog live in
  `@syncular/conformance` instead. See [Conformance](/guide-conformance/).
- The clock advances only when your test moves it; setTimeout runs on its
  own. See the clock note above.

## Where to go next

- [Schema & typegen](/guide-schema/): generate the `schema` your tests import.
- [React](/platform-react/): the hooks you just tested.
- [Conformance](/guide-conformance/): the deeper harness for implementing clients and servers.
- [testkit README](https://github.com/syncular/syncular/blob/main/packages/testing/README.md): the full `TestSync` / `TestClient` surface.
