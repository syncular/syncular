# Server setup

Build the sync server your clients connect to: a schema, a database, an `authenticate` callback, and a `resolveScopes` callback, mounted on Hono. This page is for backend developers starting a Syncular server on Bun or Node. You finish with a server that answers sync rounds on port 8787. Cloudflare Workers has its own page, [Cloudflare Workers](/server-workers/).

::meta{for="Backend developers" time="10 minutes" first="quickstart"}

:::terms
- **Host**: Your process. It owns the HTTP listener, authentication, and scope resolution.
- **Actor**: The identity `authenticate` returns for a request.
- **Partition**: The isolation boundary `authenticate` assigns to a request, such as a tenant ([Partitions](/server-partitions/)).
- **Segment**: A cached bootstrap snapshot of one subscription's rows ([Bootstrap & segments](/concepts-bootstrap/)).
:::

:::figure{title="What you assemble" note="Two callbacks hold all of the security" ticks}
<div class="d-row">
<div class="node"><span class="t">Clients</span>POST /sync<br>GET /segments, /blobs</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Your host process</p>
<div class="d-stack">
<div class="node hot"><span class="t">authenticate</span>request → actor + partition</div>
<div class="node"><span class="t">createSyncularHono</span>mounts the routes, calls handleSyncRequest</div>
<div class="node hot"><span class="t">resolveScopes</span>actor → readable and writable scopes</div>
</div>
</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node ok"><span class="t">ServerStorage</span>commit log and rows</div>
<div class="node ok"><span class="t">SegmentStore</span>bootstrap segments</div>
<div class="node ok"><span class="t">BlobStore</span>attachment bytes</div>
</div>
</div>

::caption[The core is a protocol library: `handleSyncRequest(bytes, ctx)` returns bytes over the three storage interfaces. The Hono adapter is the HTTP binding around it. Storage choices are on [Choosing a database](/server-storage/).]
:::

A backend process that consumes the server runs a [server-side client](/guide-server-clients/) instead of embedding more server code. The full host surface is the [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).

## Steps

:::::steps
::::step{title="Generate the schema" time="1 min"}
The server compiles the `schema` object that [typegen](/guide-schema/) writes to `src/syncular.generated.ts`. Clients import the same object.

```sh title="terminal"
bun run generate     # runs: syncular generate --manifest-dir .
```

::checkpoint[`src/syncular.generated.ts` exports `schema`.]
::::

::::step{title="Write the server config" time="3 min"}
The config names the schema, the storage, a segment store, and the scope resolver.

```ts title="src/server.ts"
import {
  ensureSyncServerReady,
  MemorySegmentStore,
  type SyncServerConfig,
} from '@syncular/server';
import { buildSqliteImage, SqliteServerStorage } from '@syncular/server/sqlite';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage('./data.db'), // or ':memory:'
  sqliteImageBuilder: buildSqliteImage,
  segments: new MemorySegmentStore(),
  resolveScopes: async ({ actorId }) => ({ list_id: await listsFor(actorId) }),
};
```

`resolveScopes` maps the actor to the scope values it may read and write; [Scopes & authorization](/concepts-scopes/) defines the contract. `sqliteImageBuilder` opts this host into building SQLite bootstrap images ([image construction](/concepts-bootstrap/#opting-into-image-construction)). Without it, the server serves stored images when they exist and inline or external rows otherwise. Supply it to the realtime hub too when the hub serves sync rounds.

:::warning{title="Use a file path in production"}
`:memory:` loses the commit log on restart. Pick a real database on [Choosing a database](/server-storage/).
:::

::checkpoint[`config` typechecks against `SyncServerConfig`.]
::::

::::step{title="Mount the routes" time="2 min"}
`createSyncularHono` returns a Hono app. `authenticate` runs in your process before every route and returns `{ actorId, partition }`, or `null` for a 401.

```ts title="src/server.ts"
import { createSyncularHono } from '@syncular/server-hono';

const app = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actor = await verify(request); // your auth
    return actor ? { actorId: actor.id, partition: actor.tenant } : null;
  },
});
```

[Authentication](/guide-auth/) shows a bearer-token and a cookie `authenticate`.

::checkpoint[`app.fetch` is a standard `(Request) => Response` handler.]
::::

::::step{title="Check readiness and listen" time="1 min"}
`ensureSyncServerReady(config)` compiles the schema and applies the storage projection migration. Run it before binding a port.

```ts title="src/server.ts"
await ensureSyncServerReady(config);
Bun.serve({ port: 8787, fetch: app.fetch });
```

Failure throws `SyncServerReadinessError` with the stable code `sync.schema_not_ready`, a `phase` (`schema_compile` or `storage_migration`), and the schema version. Log its cause for operators and stop startup. Do not catch it inside authentication or translate it into a 401.

```sh title="terminal"
bun run src/server.ts
```

::checkpoint[The process stays up. A `POST /sync` with any content type other than the sync media type answers HTTP 415, which shows the route is mounted.]
::::

::::step{title="Point a client at it" time="2 min"}
Give a client `httpSyncTransport('http://localhost:8787/sync')` and a subscription. The [quickstart](/quickstart/) runs this exact pairing with two clients.

::checkpoint[A row written on one client appears on the other.]
::::
:::::

## The route surface

`createSyncularHono` mounts the HTTP binding:

| Route | Method | Purpose |
|---|---|---|
| `/sync` | POST | Combined push and pull; the whole protocol runs through here |
| `/operations` | POST | Registered queries and commands ([Remote server operations](/guide-remote-operations/)); answers `operation.unknown` unless the `operations` option is set |
| `/segments/:segmentId` | GET | Bootstrap segment download, compressed per `Accept-Encoding` |
| `/blobs/:blobId` | PUT | Blob upload, content-address verified |
| `/blobs/:blobId` | GET | Blob download, re-authorized against referencing rows |
| `/blobs/:blobId/upload-grant` | POST | Presigned direct-to-storage upload grant, only when configured |

Two surfaces attach outside the adapter. `GET /realtime` is a WebSocket upgrade that depends on the runtime, so your host owns it ([below](#advanced-wire-the-realtime-hub)). `GET /admin` is the optional operator console, mounted separately and never open by default ([Operations and maintenance](/server-operations/#admin-console)).

A deployment without the realtime socket conforms to the protocol. Clients that never open it sync over `POST /sync` with identical semantics.

## Add CORS and other host headers

Mount `createSyncularHono` behind the host's Hono middleware. Headers set with `c.header()` before `await next()` carry through successful segment downloads, 304 replies, and adapter errors. This includes the CORS headers a Tauri WebView or a browser on another origin needs. The adapter keeps `encodeBody: 'manual'` for segment bodies it compressed on Cloudflare Workers.

```ts title="src/server.ts"
import { Hono } from 'hono';

const host = new Hono();
host.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', 'https://app.example.com');
  await next();
});
host.route('/api', createSyncularHono({ config, authenticate }));
```

## Reporting server errors

A `SyncError` answers with its catalog code and HTTP status. Any other exception (a storage or network failure, a bug in a validator or resolver helper) answers HTTP 500 with `sync.internal_error` and a fixed message that never contains the exception text. Clients retry it with backoff. Pass `onError` in the config to receive the original exception:

```ts title="src/server.ts"
const config: SyncServerConfig = {
  // ...
  onError: (error, { route }) => Sentry.captureException(error, { tags: { route } }),
};
```

`route` names the surface that caught the exception: `sync`, `operations`, `segments`, `blobs`, `realtime` (a socket round, answered in-band with the same code), or `admin` (`createSyncularAdminRoutes` takes its own `onError`). A remote operation that fails unexpectedly still answers its `operation.*` code and reports the original. A throwing `onError` does not change the response.

To answer a typed catalog error instead of `sync.internal_error`, add a synchronous `mapError` hook. `onError` still observes the original once. `mapError` may return a catalog `SyncError` that carries structured `details`:

```ts title="src/server.ts"
const config: SyncServerConfig = {
  // ...
  onError: (error, { route }) => log.warn({ route }, error),
  mapError: (error) => {
    if (isStorageQuota(error))
      return new SyncError(
        'sync.rate_limited',
        'service paused',
        JSON.stringify({ retryAfterMs: 30_000 }),
      );
    return undefined; // keep sync.internal_error
  },
};
```

`mapError` handles exceptions the HTTP adapters catch and realtime errors raised before the first response chunk. Registered operation handlers keep their `operation.*` failure envelope, and the admin routes take their own `mapError`. A throw, a non-`SyncError` return, a code outside the catalog, or `details` that are not JSON is contained as `sync.internal_error`. A `SyncError` raised by the server bypasses both hooks. A mapped `retryAfterMs` is delivery metadata and does not change the client's retry schedule.

## Advanced: wire the realtime hub

Realtime is optional. `createRealtimeHub` builds the transport-agnostic hub, and passing it as `config.realtime` fans every applied commit out to connected sockets. Build the hub and the config from one capability object (storage, segments, blobs, CRDT mergers, validators, limits, leases, signed delivery, clock, events), so a socket round cannot run a narrower handler than `POST /sync`. `RealtimeHubConfig` inherits `SyncServerConfig` for that reason. The protocol is on [Realtime & the WebSocket-native loop](/concepts-realtime/).

```ts title="src/server.ts"
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

The host owns the upgrade. With `Bun.serve`, upgrade on `/realtime` and hand the socket to the hub. The `partition` and `actorId` come from your own authentication of the upgrade request; [Authentication](/guide-auth/#browser-authenticate-the-realtime-socket) shows the authenticated upgrade and [short-lived tickets](/guide-auth/#realtime-tickets) for bearer-token apps.

```ts title="src/server.ts"
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
    async close(ws) {
      // Persist any cursor ack still in flight before dropping the session;
      // `drain()` throws the first persistence failure instead of hiding it.
      await ws.data.session?.drain();
      ws.data.session?.close();
    },
  },
});
```

The [demo server](https://github.com/syncular/syncular/blob/main/apps/demo/src/server.ts) is the complete worked example: one Bun process serving HTTP, WebSocket realtime, the admin console, and a static frontend. On Cloudflare Workers the upgrade runs through a Durable Object ([Cloudflare Workers](/server-workers/#add-the-durable-object)).

An in-memory hub reaches only its own instance's sockets. Behind a load balancer, add a fanout bridge: `PostgresFanout` on Postgres ([Multi-instance fanout](/server-storage-reference/#multi-instance-fanout)) or the Durable Object on Workers.

## Related setup

- **Runtime**: the core is runtime-neutral TypeScript, enforced by a static import-graph test. `@syncular/server-hono` covers Bun and Node; `@syncular/server-workers` covers Workers.
- **Day two**: events, the admin console, seeding, pruning, blob GC, backup, and load testing are on [Operations and maintenance](/server-operations/).
- **Post-commit work**: planners, leased handlers, retries, and dead letters are on [Durable server reactions](/server-reactions/).
