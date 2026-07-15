# @syncular/testkit

The app-developer test kit. Stand up a whole Syncular backend and N real
clients in memory, drive them from a `bun test` (or vitest/jest) file, and
assert what your app sees — convergence, offline queues, conflicts, live
queries — with **no HTTP server, no browser, no mocks**.

Everything here is the shipped core: the same `SyncClient`
(`@syncular/client`) and the same `@syncular/server` protocol
handler your production app runs, wired through an in-process loopback. A
green test here is real sync behaviour, not a fake.

> Designed for **app tests** — readable and minimal. If you are implementing
> a Syncular client or server and need the driver/pairing machinery, that is
> `@syncular/conformance`, not this.

## Install

Install it as a development dependency:

```bash
bun add --dev @syncular/testkit
```

Requires the Bun runtime (the in-memory client backend is `bun:sqlite`). The
React helper (`@syncular/testkit/react`) needs `react` — an optional peer.

## 60-second tour

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

`sync.client(id?)` returns a **`TestClient`**. Reach the full client API
through `.api` (it is a real `SyncClient`: `subscribe`, `mutate`, `query`,
`syncUntilIdle`, `conflicts`, `setWindow`, `uploadBlob`, …). The `TestClient`
adds the test-only controls below.

## The surface

### `createTestSync(options) → Promise<TestSync>`

| option          | default                | meaning                                                       |
| --------------- | ---------------------- | ------------------------------------------------------------- |
| `schema`        | —                      | your generated `ClientSchema` — feeds server and clients      |
| `partition`     | `"test"`               | the §1.1 partition every client lives in                      |
| `actorId`       | `"test-actor"`         | default actor a client authenticates as                       |
| `resolveScopes` | grant-all              | host authorization (§3.2); omit to grant `'*'` for every var  |
| `validators`    | off                    | real per-table write validators (§6.7), including structured rejection details |
| `startMs`       | `1_750_000_000_000`    | epoch ms the shared virtual clock starts at                   |

`TestSync`:

- `clock` — the shared `VirtualClock` (below).
- `server` — the in-memory server (`storage`, `segments`, realtime `hub`).
- `clients` — every client created, in order.
- `client(id?, overrides?)` — create **and start** one client.
- `syncAll()` — `syncUntilIdle()` on every online client until quiescent.
- `dispose()` — close every client and the server (idempotent).

`overrides` lets a client use a different `actorId` or extra `SyncClient`
config (e.g. `{ clientConfig: { onConflict: fn } }`).

### `TestClient`

```ts
client.api            // the real SyncClient
client.id             // stable client id (§1.5)
client.actorId        // the actor it authenticates as
client.faults         // transport-fault controller (below)
client.offline        // boolean

client.goOffline()    // cut the network — every hop rejects
client.goOnline()     // restore it (does NOT auto-sync; call sync())
await client.sync()   // syncUntilIdle: push the outbox, pull to idle
await client.connectRealtime()    // attach a live socket to the hub
client.disconnectRealtime()
await client.close()
```

### Offline queue / drain

```ts
a.goOffline();
a.api.mutate([{ table: 'notes', op: 'upsert', values: { id: 'n1', list_id: 'l', body: 'draft' } }]);

// Visible locally (optimistic), but nothing leaves:
expect(a.api.query('SELECT body FROM notes')).toEqual([{ body: 'draft' }]);
expect(a.api.pendingCommits()).toHaveLength(1);
await expect(a.api.sync()).rejects.toThrow(); // offline

a.goOnline();
await sync.syncAll();               // the queue drains
expect(a.api.pendingCommits()).toHaveLength(0);
```

### Fault injection

`client.faults` is the conformance harness's `TransportFaults` controller,
**re-exported, not re-implemented** — the same vocabulary the reference
pairing arms. Arm one flag; the next matching exchange misbehaves:

```ts
a.faults.dropNextRequests = 1;      // lose the next request (outbox survives)
a.faults.dropNextResponses = 1;     // server applies it, the ack is lost
a.faults.duplicateNextRequest = true;   // replay it — idempotency-cache test
a.faults.truncateNextResponse = true;   // cut the response short (decode error)
a.faults.truncateNextSegmentDownload = true;
a.faults.corrupt(bytes);            // flip a seeded byte (§5.1 tamper)
```

```ts
a.api.mutate([/* … */]);
a.faults.dropNextRequests = 1;
await expect(a.api.sync()).rejects.toThrow();   // request lost
expect(a.api.pendingCommits()).toHaveLength(1); // still queued
await a.sync();                                  // retried, drains
```

### Virtual clock

The server, every client, and the realtime hub share one clock. Time only
moves when you move it — so §5.1 segment TTLs, §5.4 signed-URL expiry, and
§7.3 lease windows are deterministic with no wall-clock flake.

```ts
sync.clock.now();          // current epoch ms
sync.clock.advance(60_000); // +60s → returns the new now()
sync.clock.set(1_800_000_000_000); // jump to an absolute instant
```

> The clock is the epoch-ms source Syncular's clock seam reads. It does **not**
> intercept `setTimeout`, so presence rate caps / heartbeats (which use real
> timers) are out of scope — the kit targets sync / offline / fault behaviour.

### Realtime deltas & presence

```ts
await b.connectRealtime();          // b now has a live socket on the hub
a.api.mutate([/* … */]);
await a.sync();                     // the hub fans the commit to b as a delta
// b applies it without an explicit pull
```

`goOffline()` also drops the socket; reconnect with `connectRealtime()`.

### Multi-client conflicts and correction metadata

Create the common server row, let both clients pull it, then make their edits
from the same observed version. Push one client first so the second write is a
deterministic conflict—no timers or transport mocks are needed:

```ts
await sync.syncAll();
const [{ version }] = a.api.query(
  'SELECT _sync_version AS version FROM notes WHERE id = ?',
  ['n1'],
) as Array<{ version: number }>;

a.api.patch('notes', 'n1', { body: 'A' }, { baseVersion: version });
b.api.patch('notes', 'n1', { body: 'B' }, { baseVersion: version });

await a.sync(); // wins version + 1
await b.sync(); // loses against the stale base

expect(b.api.conflicts[0]?.serverRow.body).toBe('A');
expect(b.api.conflicts[0]?.operation?.changedFields).toEqual(['body']);
```

Pass `validators` to `createTestSync` to exercise the same business rules as
production. A `ValidationRejection` with structured details reaches
`client.api.rejections` through both loopback and socket sync rounds, so app
tests can assert field focus and correction routing without displaying server
diagnostics.

Pass `commitValidator` to test aggregate invariants with the same
transaction-scoped candidate view as production. Throw
`CommitValidationRejection` to select the operation that correction UI should
focus. The test server uses real SQLite transaction serialization and shares
the callback across loopback and socket rounds.

## React

`@syncular/react`'s `SyncProvider` already takes any `SyncClient`, so
mounting hooks against a test client is a one-liner. `syncWrapper` builds the
`wrapper` prop `@testing-library/react` wants:

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

The re-render is driven by the client's **real** invalidation choke point —
the same one production hooks fire on — so a passing test reflects real
live-query behaviour.

## What it is not

- Not an HTTP harness. The transport is an in-process loopback; if you need
  to test your Hono/Workers adapter or real fetch/WebSocket wiring, boot the
  server yourself (see `examples/quickstart`).
- Not the conformance runner. No driver/pairing abstraction, no catalog —
  those live in `@syncular/conformance`.
- Not a `setTimeout` mock. See the clock note above.
