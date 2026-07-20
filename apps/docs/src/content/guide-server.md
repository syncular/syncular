# Server setup

The server is a framework-free protocol library:
`handleSyncRequest(bytes, ctx) → bytes` over host-provided storage,
scope-resolution, and segment/blob-store interfaces. A thin Hono adapter
mounts the routes, and `resolveScopes` runs in your process, next to your
auth. This page walks through that wiring; storage choices, Workers
deployment, and operations each have their own page.

The full host surface is the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md);
this guide is the path through it.

## The minimal server

Everything the [quickstart](/quickstart/) server needs: a schema, storage, a
segment store, and a resolver, wrapped by the Hono adapter.

```ts
import {
  ensureSyncServerReady,
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage('./data.db'), // or ':memory:'
  segments: new MemorySegmentStore(),
  resolveScopes: async ({ actorId }) => ({ list_id: await listsFor(actorId) }),
};

const app = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actor = await verify(request); // your auth
    return actor ? { actorId: actor.id, partition: actor.tenant } : null;
  },
});

await ensureSyncServerReady(config);
Bun.serve({ port: 8787, fetch: app.fetch });
```

Two callbacks handle all of the security, and both run in **your**
backend: `authenticate` maps a request to `{ actorId, partition }` (or
`null` for a 401), and `resolveScopes` maps that identity to the scope
values it may read and write. See
[Scopes & authorization](/concepts-scopes/).

Run `ensureSyncServerReady(config)` before binding a port. It accepts the
generated `ServerSchema`, compiles it, and applies the storage projection
migration. Failure throws `SyncServerReadinessError` with the stable code
`sync.schema_not_ready`, a `phase` (`schema_compile` or `storage_migration`),
and the schema version. Log its cause for operators and stop startup; do not
catch a schema-readiness failure inside authentication or translate it into a
401. Lazy schema checks in request handling remain defensive, not the startup
contract.

## The route surface

`createSyncularHono` mounts the HTTP binding:

| Route | Method | Purpose |
|---|---|---|
| `/sync` | POST | Combined push+pull; the whole protocol runs through here |
| `/segments/:segmentId` | GET | Bootstrap segment download (compressed per `Accept-Encoding`) |
| `/blobs/:blobId` | PUT | Blob upload, content-address verified |
| `/blobs/:blobId` | GET | Blob download, re-authorized against referencing rows |
| `/blobs/:blobId/upload-grant` | POST | Presigned direct-to-storage upload grant (only when configured) |

Two more surfaces attach outside the adapter:

- `GET /realtime`: the WebSocket upgrade is runtime-specific and stays with
  your host process (below).
- `GET /admin`: the optional operator console, mounted separately and
  never open by default. See [Operations](/server-operations/).

An HTTP-only deployment is fully conformant: clients that never open the
socket sync over `POST /sync` with identical semantics. Realtime is simply
a second binding onto that same handler, adding a live channel for
connected sockets.

## Realtime hub wiring

`createRealtimeHub` builds the transport-agnostic hub; passing it as
`config.realtime` makes every applied commit fan out to connected sockets.
Build both from one canonical sync capability object—not just the same storage,
but the same segments, blobs, CRDT mergers, validators, limits, leases, signed
delivery, clock, and events. The type inherits `SyncServerConfig` specifically
to prevent socket rounds from becoming a narrower handler.

```ts
import {
  createRealtimeHub,
  type RealtimeHubConfig,
  type RealtimeSession,
} from '@syncular/server';

const syncCapabilities = {
  schema,
  storage,
  segments,
  blobs,
  crdtMergers,
  validators,
  resolveScopes,
} satisfies RealtimeHubConfig;
const hub = createRealtimeHub(syncCapabilities);
const config: SyncServerConfig = {
  ...syncCapabilities,
  realtime: hub,
};
```

The upgrade itself belongs to the host. With `Bun.serve`, upgrade on
`/realtime` and hand the socket to the hub:

```ts
const server = Bun.serve<{ clientId: string; session?: RealtimeSession }, never>({
  port: 8787,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === '/realtime') {
      const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
      if (bunServer.upgrade(request, { data: { clientId } })) {
        return undefined as unknown as Response;
      }
      return new Response('expected a websocket upgrade', { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws) {
      hub
        .connect({
          partition: 'main', // from YOUR auth on the upgrade request
          actorId: 'user-1',
          clientId: ws.data.clientId,
          send: (data) => ws.send(data),
          closeSocket: () => ws.close(1008, 'protocol violation'),
        })
        .then((session) => { ws.data.session = session; })
        .catch(() => ws.close(1011, 'realtime connect failed'));
    },
    message(ws, message) {
      if (typeof message === 'string') ws.data.session?.handleMessage(message);
      else ws.data.session?.handleBinary(new Uint8Array(message));
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});
```

The
[demo server](https://github.com/syncular/syncular/blob/main/apps/demo/src/server.ts)
is the complete worked example: one Bun process serving HTTP, WebSocket
realtime, the admin console, and a static frontend. On Cloudflare Workers
the upgrade runs through a Durable Object instead; see
[Cloudflare Workers](/server-workers/).

Behind a load balancer, an in-memory hub only reaches its own instance's
sockets. Multi-instance deployments add a fanout bridge
(`PostgresFanout` on Postgres, the Durable Object on Workers). See
[Storage backends](/server-storage/).

## Seeding data

`seedMutations` pushes app-shaped values through the real push pipeline —
authorization, validation, idempotency, realtime fanout — so seeded rows
behave exactly like synced rows. It is THE supported seeding recipe for dev
servers, demos, and ops scripts:

```ts
import { SeedMutationError, seedMutations } from '@syncular/server';

try {
  await seedMutations(
    config,
    {
      partition: 'demo',
      actorId: 'seed-user',
      clientId: 'demo-seed',
      commitId: 'welcome-v1',
    },
    [
      {
        table: 'todos',
        op: 'upsert',
        // SQL snake_case or the exact generated camelCase alias; missing
        // nullable columns become NULL.
        values: { id: 'seed-1', listId: 'welcome', title: 'Hello', done: false },
      },
    ],
  );
} catch (error) {
  if (error instanceof SeedMutationError) {
    console.error({
      code: error.code,
      operation: error.opIndex,
      replayed: error.replayed,
      recordedAtMs: error.recordedAtMs,
      cacheIdentity: error.cacheIdentity,
    });
  }
  throw error;
}
```

The commit id defaults to a stable `seed-commit-1`, so re-running an accepted
seed writes nothing twice. Rejections are terminal for the same
`clientId`/`commitId` too: fixing the resolver or validator does not alter the
already-recorded outcome. `SeedMutationError` exposes the exact protocol or
host-validator `code`, `opIndex`, `replayed`, original `recordedAtMs`, and a
privacy-safe `cacheIdentity`; no message parsing is required.

For a corrected development seed, inspect the structured error, fix the seed
or authority, and advance a reviewable seed revision such as `welcome-v1` to
`welcome-v2`. Leave the database and unrelated rows intact. Do not delete the
whole database and do not mutate or remove the old idempotency outcome. This
revisioning rule is only for a changed seed definition. Application commands
must keep their original request ID after an unknown outcome: inventing a new
ID can execute the same real-world operation twice.

The `clientId` has a separate identity contract: its first registration binds
it to one actor within the partition. Revisions by that same seed actor keep the
stable client ID. If a security or ownership correction moves the seed to a
different actor, advance **both** identities:

```ts
await seedMutations(config, {
  partition: 'production-eu',
  actorId: 'server-authority',       // changed from seed-user
  clientId: 'catalog-server-seed',   // new purpose-specific client identity
  commitId: 'catalog-v2',            // new seed definition revision
}, correctedRows);
```

Changing the actor and commit ID while retaining the old client ID must fail
with `sync.invalid_client_id` and `recommendedAction: resetClientId`. That is
evidence of an actor/client mismatch, not database corruption. Recover by
using a new purpose-specific client ID as above; never delete unrelated rows or
the prior terminal outcome. This actor-change recipe is for controlled seeding
and backfills, not application commands or unknown real-world command outcomes.

Malformed helper input such as an unknown table/column throws `SyncError`
before a push exists. In tests, prefer
[`@syncular/testkit`](/tooling-testing/): a test client that mutates and syncs
covers the same ground with virtual time.

## Choosing the rest

- **Storage**: `SqliteServerStorage` (bun:sqlite) is the dev-speed default;
  `PostgresServerStorage` is the production database path; `D1ServerStorage`
  serves Workers. Full trade-offs in [Storage backends](/server-storage/).
- **Segments and blobs**: memory stores for tests, SQLite for a single
  node, S3-compatible object storage (AWS S3, Cloudflare R2, MinIO) with
  presigned URLs for production. Also in
  [Storage backends](/server-storage/).
- **Runtime**: the core is runtime-neutral TypeScript (enforced by a static
  import-graph test). `@syncular/server-hono` covers Bun/Node;
  `@syncular/server-workers` covers Cloudflare Workers. See
  [Cloudflare Workers](/server-workers/).
- **Day two**: structured events, the admin console, commit-log pruning,
  blob GC, and load testing live in [Operations](/server-operations/).

## Where to go next

- [Storage backends](/server-storage/): SQLite, Postgres, D1, segment and
  blob stores, signed URLs and CDN.
- [Cloudflare Workers](/server-workers/): D1 + R2 + Durable Object realtime.
- [Operations](/server-operations/): events, admin console, pruning, GC,
  load tests.
- [Scopes & authorization](/concepts-scopes/): how `resolveScopes` gates
  every read and write.
