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

Bun.serve({ port: 8787, fetch: app.fetch });
```

Two callbacks handle all of the security, and both run in **your**
backend: `authenticate` maps a request to `{ actorId, partition }` (or
`null` for a 401), and `resolveScopes` maps that identity to the scope
values it may read and write. See
[Scopes & authorization](/concepts-scopes/).

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
Give the hub the **same** storage and segment store as the HTTP path: the
socket carries full sync rounds through the same handler.

```ts
import { createRealtimeHub, type RealtimeSession } from '@syncular/server';

const hub = createRealtimeHub({ schema, storage, resolveScopes, segments });
const config: SyncServerConfig = {
  schema, storage, segments, resolveScopes,
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
