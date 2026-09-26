# Authentication

Syncular ships no login, session, or token format. Your server owns
identity: one `authenticate(request)` callback turns each HTTP request and
WebSocket upgrade into an `actorId` and a `partition`, and every client
attaches whatever credential that callback expects. The protocol carries no
credential fields ([SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints)).
This page wires a bearer token end to end, then covers cookies, rotation,
realtime, and headless clients.

## What `authenticate` returns

`authenticate` receives the raw `Request` and returns
`{ actorId, partition }`, or `null` to reject it. `createSyncularHono` calls
it on `/sync`, `/operations`, `/segments/:id`, and every `/blobs` route.
A `null` result answers HTTP 401 with the error code `sync.auth_required`,
which the client treats as retryable.

- `actorId`: the authenticated user or service. `resolveScopes` receives it
  and returns the scope values that actor may read and write
  ([Scopes & authorization](/concepts-scopes/)). The server records it as
  the author of every commit the actor pushes.
- `partition`: the tenant whose data the request touches. A single-tenant
  app returns a constant ([Partitions & multi-tenancy](/server-partitions/)).

Signed segment and blob URLs skip `authenticate`: the URL is the grant, and
the client never attaches host headers to it (SPEC §5.4, §5.9.5).

## Server: verify a bearer token

This example verifies a JWT from an OIDC provider with
[`jose`](https://github.com/panva/jose). The token's `sub` becomes the actor
and a custom `org_id` claim names the partition:

```ts
// src/auth.ts
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(
  new URL('https://auth.example.com/.well-known/jwks.json'),
);

export async function authenticate(
  request: Request,
): Promise<{ actorId: string; partition: string } | null> {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(header.slice('Bearer '.length), jwks, {
      issuer: 'https://auth.example.com',
      audience: 'syncular',
    });
    if (typeof payload.sub !== 'string' || typeof payload.org_id !== 'string') {
      return null;
    }
    return { actorId: payload.sub, partition: payload.org_id };
  } catch (error) {
    // Expired, malformed, or badly signed tokens are a 401. Anything else
    // (a bug, a storage outage) propagates as a server error.
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}
```

Pass it to the adapter, and scope reads and writes by the actor it returns:

```ts
// src/server.ts
import { createSyncularHono } from '@syncular/server-hono';
import { authenticate } from './auth';

const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  resolveScopes: async ({ actorId }) => ({
    list_id: await db.listIdsForMember(actorId), // your membership query
  }),
};

const app = createSyncularHono({ config, authenticate });
```

`authenticate` answers who the caller is; `resolveScopes` answers which rows
that caller may touch. Keep membership checks in `resolveScopes`, because it
also gates writes against the stored row
([write-path authorization](/concepts-scopes/#write-path-authorization)).

On Cloudflare Workers the same function goes into
`createWorkersFetchHandler({ config: (env) => ({ config, authenticate }) })`
([Cloudflare Workers](/server-workers/)).

### Session cookies

A cookie-session app reads the cookie inside the same callback:

```ts
export async function authenticate(request: Request) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  if (sid === undefined) return null;
  const session = await sessions.lookup(sid); // your session store
  return session === null
    ? null
    : { actorId: session.userId, partition: session.orgId };
}
```

The browser worker sends cookies only to endpoints on the page's own origin.
Serve the sync routes from that origin (or proxy them there) when you
authenticate with cookies.

### CORS for a separate API origin

A browser client on another origin sends `Authorization` and
`X-Syncular-Scopes`, which triggers a CORS preflight. Allow both headers in
front of the syncular routes:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const api = new Hono();
api.use(
  '*',
  cors({
    origin: 'https://app.example.com',
    allowHeaders: ['Authorization', 'Content-Type', 'X-Syncular-Scopes'],
  }),
);
api.route('/', createSyncularHono({ config, authenticate }));
```

## Browser: send and rotate the header

`createSyncClientHandle` takes a `headers` record. The worker attaches it to
every sync, segment, and blob request:

```ts
import { createSyncClientHandle } from '@syncular/client';

const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' },
  endpoints: {
    syncUrl: 'https://api.example.com/sync',
    segmentsUrl: 'https://api.example.com/segments',
  },
  headers: { Authorization: `Bearer ${await auth.getAccessToken()}` },
  onSynced: async ({ error }) => {
    if (error?.code !== 'sync.auth_required') return;
    await handle.setHeaders({
      Authorization: `Bearer ${await auth.refreshAccessToken()}`,
    });
    await handle.sync();
  },
});
```

`setHeaders` replaces the whole header set, and the next request uses it.
Call it whenever your auth library rotates the token, before the old token
expires, so sync rounds never see a 401. The `onSynced` branch handles the
case where the token expired first: `sync.auth_required` is retryable, so
the worker keeps retrying with backoff, and `sync()` after the refresh runs
the next round without waiting for the backoff.

With multi-tab on, `setHeaders` on a follower tab forwards to the leader
worker. Each tab also keeps its latest set, and a follower that becomes
leader starts its worker with that set. Rotate the token in every tab that
holds a handle; the most recent call wins.

The local database outlives a sign-out and still holds the previous user's
rows and outbox. Name the persistent database per user
(`database: { mode: 'persistent', name: 'my-app-' + userId }`) and close
the handle on sign-out, so the next user opens a separate replica. A
server-directed revocation removes rows through
[Authorized local purge](/concepts-local-data-purge/).

## Browser: authenticate the realtime socket

The browser `WebSocket` constructor cannot send headers, so the realtime
socket authenticates by cookie or by a value on its URL. `setHeaders` never
reaches it, and a live socket keeps the credentials from its handshake.

A same-origin cookie session needs nothing extra: the browser sends the
cookie with the upgrade request, and your upgrade handler runs the same
`authenticate`. With `Bun.serve`, authenticate before upgrading and carry
the identity into `hub.connect`:

```ts
fetch: async (request, bunServer) => {
  const url = new URL(request.url);
  if (url.pathname === '/realtime') {
    const auth = await authenticate(request);
    if (auth === null) return new Response(null, { status: 401 });
    const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
    if (bunServer.upgrade(request, { data: { clientId, ...auth } })) {
      return undefined as unknown as Response;
    }
    return new Response('expected a websocket upgrade', { status: 400 });
  }
  return app.fetch(request);
},
websocket: {
  open(ws) {
    hub.connect({
      partition: ws.data.partition,
      actorId: ws.data.actorId,
      clientId: ws.data.clientId,
      send: (data) => ws.send(data),
      closeSocket: () => ws.close(1008, 'protocol violation'),
    });
    // … session wiring as in Server setup
  },
},
```

A bearer-token app exchanges the token for a short-lived ticket on each
connection attempt, because proxy logs retain URLs. The server side (mint
and verify) is on [Realtime tickets](/server-realtime-tickets/). In the
browser, give the worker a custom realtime connector. `startSyncWorker`
passes it the current header set, so the ticket request carries the same
bearer the sync rounds use:

```ts
// worker.ts
import { ClientSyncError, webSocketRealtimeConnector } from '@syncular/client';
import { startSyncWorker } from '@syncular/client/worker';

startSyncWorker({
  createRealtime: (_config, clientId, headers) => async (handlers) => {
    const response = await fetch('https://api.example.com/realtime-ticket', {
      method: 'POST',
      headers: headers(),
    });
    if (!response.ok) {
      throw new ClientSyncError(
        'sync.auth_required',
        'realtime ticket request failed',
        true,
      );
    }
    const { ticket } = (await response.json()) as { ticket: string };
    const url = new URL('wss://api.example.com/realtime');
    url.searchParams.set('clientId', clientId);
    url.searchParams.set('ticket', ticket);
    return webSocketRealtimeConnector(url.toString())(handlers);
  },
});
```

The [realtime supervisor](/platform-web/#the-realtime-supervisor) calls the
connector on every reconnect, so each attempt mints a fresh ticket. A
failed ticket request fails the attempt, and the supervisor retries it with
backoff.

Cutting off a revoked actor means closing that actor's sockets on the
server; rotating credentials on the client does not affect an established
connection.

## Headless and server-side clients

`httpSyncTransport`, `httpSegmentDownloader`, and `httpBlobTransport` take
`headers` as a record or as a function. The transport calls the function on
every request, so a long-running process rotates its credential without
rebuilding the client:

```ts
import { httpSegmentDownloader, httpSyncTransport, SyncClient } from '@syncular/client';

let token = await issueServiceToken();
const http = { headers: () => ({ Authorization: `Bearer ${token}` }) };

const client = new SyncClient({
  database,
  schema,
  transport: httpSyncTransport('https://api.example.com/sync', http),
  segments: httpSegmentDownloader('https://api.example.com/segments', http),
});

// Elsewhere, on your token schedule:
token = await issueServiceToken();
```

See [Server-side sync clients](/guide-server-clients/) for the rest of the
headless setup.

## Native platforms

The Swift, Kotlin, Flutter, React Native, and Tauri clients take a
`headers` map in their config and expose `setHeaders(...)` with the same
full-replacement semantics. Their native WebSocket sends the headers on the
handshake, so realtime needs no ticket; a live socket keeps its handshake
credentials until you pause and resume it (or reconnect realtime on Tauri).
The per-platform calls are on [Swift](/platform-swift/),
[Kotlin](/platform-kotlin/), [Flutter](/platform-flutter/),
[React Native](/platform-react-native/), and [Tauri](/platform-tauri/).
