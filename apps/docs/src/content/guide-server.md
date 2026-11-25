# Server setup

Build the sync server your clients connect to: a schema, a database, an `authenticate` callback, and a `resolveScopes` callback, mounted on Hono. This page is for backend developers starting a Syncular server on Bun or Node. You finish with a server that answers sync rounds on port 8787. Cloudflare Workers has its own page, [Cloudflare Workers](/server-workers/).

::meta{for="Backend developers" time="10 minutes" first="quickstart"}

:::terms
- **Host**: Your process. It owns the HTTP listener, authentication, and scope resolution.
- **Actor**: The identity `authenticate` returns for a request.
- **Partition**: The isolation boundary `authenticate` assigns to a request, such as a tenant ([Partitions](/server-partitions/)).
- **Segment**: A cached bootstrap snapshot of one table's rows for one unit ([Bootstrap & segments](/concepts-bootstrap/)).
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

async function authenticate(request: Request) {
  const actor = await verify(request); // your auth
  return actor ? { actorId: actor.id, partition: actor.tenant } : null;
}

const app = createSyncularHono({ config, authenticate });
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
Give a client `httpSyncTransport('http://localhost:8787/sync')` and a unit. The [quickstart](/quickstart/) runs this exact pairing with two clients.

::checkpoint[A row written on one client appears on the other.]
::::
:::::

## The route surface

`createSyncularHono` mounts the HTTP binding:

| Route | Method | Purpose |
|---|---|---|
| `/sync` | POST | Combined push and pull; the whole protocol runs through here. Accepts a gzip request body and compresses its response per `Accept-Encoding` |
| `/operations` | POST | Registered queries and commands ([Remote server operations](/guide-remote-operations/)); answers `operation.unknown` unless the `operations` option is set. Compresses its response per `Accept-Encoding` |
| `/segments/:segmentId` | GET | Bootstrap segment download, compressed per `Accept-Encoding` |
| `/blobs/:blobId` | PUT | Blob upload, content-address verified; refused with 413 `blob.too_large` from `Content-Length` before the body is read |
| `/blobs/:blobId` | GET | Blob download, re-authorized against referencing rows before any byte is read, streamed with identity encoding |
| `/blobs/:blobId/upload-grant` | POST | Presigned direct-to-storage upload grant, only when configured |

`GET /realtime` is a WebSocket upgrade that depends on the runtime, so your host owns it ([below](#advanced-wire-the-realtime-hub)). `GET /admin` is the optional operator console, which the `admin` option mounts behind your guard ([Admin console](/server-admin-console/)).

## Transport compression

The `/sync`, `/operations` and segment responses are encoded per the request's `Accept-Encoding`: zstd first when the codec exists, gzip otherwise, identity when the client offers neither or the body is under 1 KiB (SPEC §1.3). A `/sync` response that streams `KEEPALIVE` frames while it builds ([below](#keepalive-frames-while-a-response-builds)) goes out with identity encoding, because a compressor would hold the keepalive bytes back. On Bun the codecs are `Bun.zstdCompressSync` and `Bun.gzipSync`; on workerd, Node, and Deno the adapter uses `CompressionStream('gzip')`. An encoded response carries `Content-Encoding` and `Vary: Accept-Encoding`, and it is marked `encodeBody: 'manual'` so workerd never encodes it a second time. Blob downloads are streamed as stored with `Content-Length` and identity encoding (SPEC §5.9.5).

`POST /sync` and `POST /operations` accept a gzip request body (`Content-Encoding: gzip`) and decode it before parsing SSP2. Any other request `Content-Encoding` is answered with HTTP 415 and an error body (`sync.invalid_request`, or `operation.invalid_request` on the operations route) instead of being parsed as protocol bytes. A gzip body that does not decompress is HTTP 400 `sync.invalid_request`.

A deployment without the realtime socket conforms to the protocol. Clients that never open it sync over `POST /sync` with identical semantics.

## Request limits

The `limits` field of the sync config caps what one request or watch session may ask of the server. Each value must be a positive safe integer; `createSyncularHono`, `createRealtimeHub` and every request throw on `NaN`, `0`, a fraction or `Infinity`. `inlineSegmentMaxBytes` is a size threshold and also accepts `0`.

| Limit | Default | Applies to |
|---|---|---|
| `maxRequestBytes` | 16 MiB | Decoded bytes of a `POST /sync` or `POST /operations` body after gzip decoding, and of a socket round's assembled request |
| `maxSubscriptionsPerRequest` | 500 | `UNIT` frames in a request that carries the registration list |
| `maxWatchesPerSession` | 100 | Registered-query watches open on one `RemoteOperationWatchHub` session |
| `maxOperationsPerRequest` | 500 | Push operations in one request (`sync.too_many_operations`) |
| `maxLiveSectionBytes` | 16 MiB | Stored bytes (payload, row id, scopes) of the log changes one pull loads for its live section |
| `maxImageSegmentBytes` | 32 MiB | File size of one SQLite range image ([range images](/concepts-bootstrap/#range-images)) |

A request past one of the first two limits fails with HTTP 413 `sync.limit_exceeded`; `details.limit` names the limit and `details.max` holds its value. The adapter stops decoding a gzip body when it reaches `maxRequestBytes`, so a small compressed body never inflates past the cap. A socket round that grows past `maxRequestBytes` closes the connection. A watch past `maxWatchesPerSession` receives a `watch_error` with `sync.limit_exceeded`; the session's other watches keep running, and each commit reruns a session's affected watches one at a time.

`maxSubscriptionsPerRequest` counts units, one per scope map, whatever the number of tables a unit covers. A client sends its registration list when the list changed and otherwise a 32-byte digest of it ([Subscriptions](/concepts-subscriptions/#what-a-round-sends-for-the-list)), so the limit bounds a round that changes the list and the first round of a new client. A client above the limit cannot pull until its list shrinks ([Pitfalls](/pitfalls/#do-keep-the-unit-count-under-the-server-limit)). Raise the limit when the app's heaviest account registers more units. The cost per unit is linear: at 10,000 one-row units a pull with an unchanged list costs the server 40 ms, of which the live scan reads one scope-index range per unit for 6 ms, and a changed list travels as about 35 bytes per unit ([Pitfalls](/pitfalls/#do-keep-the-reference-rows-your-data-names-with-a-window-on-the-primary-key) has the table). The Rust local authority takes the same cap through `set_max_subscriptions_per_request`.

`maxLiveSectionBytes` bounds the memory a pull spends on the commit log. The server buffers a live section whole before it answers, so a commit of 150 MB would otherwise load 150 MB for every replica whose cursor lies behind it. The storage sizes each candidate commit in SQL before it reads a payload, and counts for a unit only the changes of covered tables whose scopes carry every value of the unit's scope map. Each unit seeks the change log by the scope variable whose value has the fewest log entries, so a unit `{ availability: 'offered', release_id: 'r2' }` reads the commits of release `r2`, never every `offered` commit. A section stops before the commit that would pass the budget, and the client pulls the rest in the next round. A commit whose changes for the request pass the budget on their own resets only the units it reaches, with `sync.cursor_expired`: they bootstrap from the stored rows (or a SQLite image) at a pin above the commit, and the client keeps their rows until the bootstrap replaces them. The live section stays active for every other unit, so a replica that holds no unit the commit reaches never notices it (SPEC §4.6). Set the budget well below the host's heap; a Cloudflare Durable Object has 128 MB. Local authorities apply no budget.

`maxImageSegmentBytes` bounds the memory a client spends on one SQLite image. The builder measures the image file while it inserts rows and stops before the row that could carry the file past the bound, so a table becomes a run of range images, and a client holds about three bound-sized buffers at its peak: one image body, its copy in the SQLite heap, and the next body downloading. A lower bound adds an HTTP request and a reuse lookup per range image. Changing the bound changes the range starts, so images stored under the old bound stop matching after their first range.

A pull keeps up to six segment puts in flight. It scans and encodes its bootstrap pages in order, across every unit it bootstraps, and stores each rows segment it delivers by reference while it scans the next page. When six puts are in flight, the next page waits for one of them. The pull writes its unit sections once every put has completed and lists the segments in page order, so the frames and their order do not depend on the order the puts complete in. A failed put fails the pull with the error of the first failed page, and the pull scans no further page. A pull holds the encoded bytes of its puts in flight, about 5 MB with 1,000-row pages of 875 KB. A cold pull of sixteen segments to a store with 1,000 ms per put takes 3.0 s, and 16.1 s against a store that runs one put at a time (`bench/src/segment-put-lane.ts`). A Workers invocation holds at most six connections open and an R2 put uses one, so a Workers host gains nothing above six. SQLite range images are built and stored one at a time, because the next range starts after the last row the builder took.

### KEEPALIVE frames while a response builds

The server builds a whole response before it writes a push result or section, because the serve-gate check runs after the response's last read. When a response is not built after 10 s, the server writes `RESP_HEADER` (and `LEASE`) with one `KEEPALIVE` frame, then one `KEEPALIVE` every further 10 s, then the rest once it is built (SPEC §1.6). The native client's socket round fails after 30 s without a received chunk, so the interval leaves it two missed keepalives. A response built within 10 s carries no `KEEPALIVE` and keeps its bytes. Once the header went out, a failure of the build (a serve-gate refusal, a failed segment put) arrives as an in-band `ERROR` frame instead of an HTTP error status, and a failure outside the error catalog reaches `onError` and answers `sync.internal_error`. A build still running 300 s after the request (2.5 times the slowest cold build measured in production) ends with an in-band `ERROR` carrying the retryable `sync.segment_build_timeout`, and the keepalives stop; segment puts still in flight finish unobserved, and a later put of the same content reuses the stored bytes. Clients before 0.96.0 skip the frame as unknown. A received `KEEPALIVE` also restarts the client's 60 s round bound where the client reads the response in chunks ([Running rounds until idle](/concepts-bootstrap/#running-rounds-until-idle)).

```ts
const config: SyncServerConfig = {
  // schema, storage, segments, resolveScopes, ...
  limits: { maxSubscriptionsPerRequest: 2_000, maxRequestBytes: 32 * 1024 * 1024 },
};
```

## Server-owned columns

A server-owned column holds a value only the server decides, such as the
author's display label or a scope value derived from other rows. Declare it in
the table's `serverColumns` in `syncular.json` ([Schema](/guide-schema/)); the
column must be nullable and outside the primary key, the owner write set,
`CRDT` columns and encrypted columns. The table's row validator in
`validators` sets it by returning the values:

```ts
import type { ValidatorRegistry } from '@syncular/server';

const validators: ValidatorRegistry = {
  domain_events: async ({ row, stored }, { actorId, read }) => {
    if (row === undefined) return; // a delete
    const facility = await read.getRow('facilities', String(row.facility_id));
    return {
      actor_label: await labelFor(actorId),
      facility_label: facility?.row.label ?? null,
      // A scope column outside the owner set is set on insert only.
      ...(stored === undefined
        ? { activity_window_id: activityWindowFor(row) }
        : {}),
    };
  },
};

const config: SyncServerConfig = {
  // schema, storage, segments, resolveScopes, ...
  validators,
};
```

The validator runs inside the push transaction for every accepted upsert on
its table, from a client push or a registered command, after scope
authorization and the CRDT merge. `row` is the merged row with the
server-owned columns as stored (NULL on an insert), and `read` is the
candidate-state reader the whole-commit validator receives, so it sees rows
staged earlier in the same commit. The returned values are stored, and on an
insert the row's scopes are taken from them, so the row reaches the units of a
server-set scope value in the same commit. A column the validator omits keeps
its value, so a patch leaves it as stored. The commit validator and reactions
see the completed row. On a delete, a `rescope` and a declared-reference
cascade the server ignores returned values.

The server discards every pushed value of a server-owned column. An app built
before the column existed, or before it became server-owned, keeps pushing
and its values are replaced; a current client refuses such a mutation value
with `sync.invalid_request` and shows NULL until the server row arrives. On an
update the validator cannot move a server-owned scope column; a different
value rejects the commit, and a registered command's `rescope` moves the row.
Throw `ValidationRejection` to refuse the write with your own code. Any other
throw, a key that is not a server-owned column, or a value of the wrong type
rejects the commit with `sync.constraint_violation`. The local authority has
no validators and stores NULL. The rules are in
[SPEC §6.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#67-write-validation-hooks).

## Add CORS and other host headers

Mount `createSyncularHono` behind the host's Hono middleware. Headers set with `c.header()` before `await next()` carry through successful sync, operations, segment, and blob responses, 304 replies, and adapter errors. This includes the CORS headers a Tauri WebView or a browser on another origin needs. The adapter keeps `encodeBody: 'manual'` for every body it compressed itself, which matters on Cloudflare Workers. The presigned-URL answer of `GET /blobs/:blobId` keeps the handler's `Cache-Control: private, max-age=0`, `ETag` and `Vary` headers.

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

`route` names the surface that caught the exception: `sync`, `operations`, `segments`, `blobs`, `realtime` (a socket round, answered in-band with the same code), or `admin` (the console's JSON routes). A remote operation that fails unexpectedly still answers its `operation.*` code and reports the original. A whole-commit validator that throws is answered as the rejection `sync.validator_error` and still reports the original through the same hook with route `sync`. A throwing `onError` does not change the response. `onError` never sees a `SyncError`, so a catalog failure such as `sync.schema_not_ready` reaches it never. A catalog failure shows on the `request.handled` event (`outcome: "rejected"` or `"error"`, with `errorCode` and `clientId`) and on the client's stored record: `lastErrorCode`, `consecutiveFailures`, and `lastRoundAtMs` ([Admin console](/server-admin-console/)). The record updates for a client that has completed at least one round. A client also reports a round that failed on its side after the server answered it, such as a transport timeout: its next request carries the failed round's code, and the server stores it as `lastErrorCode` and increments `consecutiveFailures`.

A rejected segment store call (an R2 or S3 outage) answers the retryable `sync.segment_store_unavailable` instead: HTTP 503 with `Retry-After: 5`, or an in-band `ERROR` once a pull's header frames went out ([KEEPALIVE frames while a response builds](#keepalive-frames-while-a-response-builds)). `details.operation` names the call (`put`, `find`, `get` or `open`), and `onError` receives the store's error with route `sync` or `segments`; `mapError` does not see it. The code covers the pull's segment puts and reuse lookups and the segment download's reads. A fault in the server's own segment encoding still answers `sync.internal_error`.

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

`mapError` handles exceptions the HTTP adapters catch and realtime errors raised before the first response chunk. Registered operation handlers keep their `operation.*` failure envelope. A throw, a non-`SyncError` return, a code outside the catalog, or `details` that are not JSON is contained as `sync.internal_error`. A `SyncError` raised by the server bypasses both hooks. A mapped `retryAfterMs` is delivery metadata and does not change the client's retry schedule.

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

The host owns the upgrade. With `Bun.serve`, run the same `authenticate` on the upgrade request, answer 401 when it returns `null`, and hand its `partition` and `actorId` to the hub. A browser WebSocket sends cookies and no custom headers; [Authentication](/guide-auth/#browser-authenticate-the-realtime-socket) adds the `Origin` check a cookie session needs, and [short-lived tickets](/guide-auth/#realtime-tickets) cover bearer-token apps.

```ts title="src/server.ts"
interface SocketData {
  actorId: string;
  partition: string;
  clientId: string;
  session?: RealtimeSession;
}

const server = Bun.serve<SocketData, never>({
  port: 8787,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === '/realtime') {
      const auth = await authenticate(request);
      if (auth === null) return new Response(null, { status: 401 });
      const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
      if (bunServer.upgrade(request, { data: { ...auth, clientId } })) return;
      return new Response('expected a websocket upgrade', { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws) {
      hub
        .connect({
          partition: ws.data.partition,
          actorId: ws.data.actorId,
          clientId: ws.data.clientId,
          send: (data) => {
            ws.send(data);
          },
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

Send heartbeats from the host. After a connection's first heartbeat, both reference clients treat a socket that delivers no frame for twice the interval as lost. They assume 30 seconds unless their `realtimeHeartbeatMs` says otherwise. A host without this line keeps idle sockets open, and a client then detects a dead connection only when a send or a socket round fails:

```ts title="src/server.ts"
setInterval(() => hub.heartbeat(), 30_000);
```

The hub bounds what a slow client can leave unacknowledged. Past `maxUnackedDeltas` sent deltas (default 256) or `maxUnackedDeltaBytes` (default 4 MiB) above the client's last ack, it stops sending deltas to that socket and sends one `catchup-required` wake instead; the ack after the client's catch-up round resumes delivery. Both are `RealtimeHubConfig` fields.

The [demo server](https://github.com/syncular/syncular/blob/main/apps/demo/src/server.ts) is the complete worked example: one Bun process serving HTTP, WebSocket realtime, the admin console, and a static frontend. On Cloudflare Workers the upgrade runs through a Durable Object ([Cloudflare Workers](/server-workers/#add-the-durable-object)).

An in-memory hub reaches only its own instance's sockets. Behind a load balancer, add a fanout bridge: `PostgresFanout` on Postgres ([Multi-instance fanout](/server-storage-reference/#multi-instance-fanout)) or the Durable Object on Workers.

## Related setup

- **Runtime**: the core is runtime-neutral TypeScript, enforced by a static import-graph test. `@syncular/server-hono` covers Bun and Node; `@syncular/server-workers` covers Workers.
- **Day two**: events, the admin console, seeding, pruning, blob GC, backup, and load testing are on [Operations and maintenance](/server-operations/).
- **Post-commit work**: planners, leased handlers, retries, and dead letters are on [Durable server reactions](/server-reactions/).
