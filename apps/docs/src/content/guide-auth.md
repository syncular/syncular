# Authentication

Syncular ships no login, session, or token format. Your server owns identity:
one `authenticate(request)` callback turns each HTTP request into an `actorId`
and a `partition`, and every client attaches whatever credential that callback
expects. The protocol carries no credential fields
([SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints)).
This page is for developers who connect an existing login to a Syncular server.
You finish with a bearer token verified on the server, sent and rotated by the
client, and a realtime socket that authenticates without a long-lived token on
its URL.

::meta{for="App developers on any SDK" time="20 minutes" first="guide-server" spec="1"}

:::terms
- **`authenticate`**: The server callback that returns `{ actorId, partition }` for a request, or `null` to reject it.
- **Actor**: The authenticated user or service. The server records it as the author of every commit it pushes.
- **Partition**: The tenant whose data a request touches.
- **Header set**: The full record of host headers a client attaches to sync, segment, and blob requests.
- **Ticket**: A short-lived signed value on the realtime socket URL, minted from a normal bearer.
:::

:::figure{title="Two doors, one identity" note="HTTP carries headers; the socket cannot" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">HTTP: sync, segments, blobs</span>Authorization header from the client's header set</div>
<div class="node cool"><span class="t">Realtime socket</span>Same-origin cookie, or a ticket on the URL</div>
</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Your server</span><code>authenticate(request)</code> or your upgrade handler</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Identity</span><code>actorId</code> + <code>partition</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">resolveScopes</span>Which rows this actor reads and writes</div>
</div>

::caption[`authenticate` answers who the caller is. `resolveScopes` answers which rows the caller may touch. A browser `WebSocket` cannot send headers, which is why the socket has its own path.]
:::

## What `authenticate` returns

`authenticate` receives the raw `Request` and returns `{ actorId, partition }`,
or `null` to reject it. `createSyncularHono` calls it on `/sync`,
`/operations`, `/segments/:id`, and every `/blobs` route. A `null` result
answers HTTP 401 with the error code `sync.auth_required`, which the client
treats as retryable.

- `actorId`: the authenticated user or service. `resolveScopes` receives it and
  returns the scope values that actor may read and write
  ([Scopes & authorization](/concepts-scopes/)).
- `partition`: the tenant whose data the request touches. A single-tenant app
  returns a constant ([Partitions & multi-tenancy](/server-partitions/)).

Signed segment and blob URLs skip `authenticate`: the URL is the grant, and the
client attaches no host headers to it (SPEC §5.4, §5.9.5).

## Steps

:::::steps
::::step{title="Verify the credential on the server" time="5 min"}
This example verifies a JWT from an OIDC provider with
[`jose`](https://github.com/panva/jose). The token's `sub` becomes the actor and
a custom `org_id` claim names the partition:

```ts title="src/auth.ts"
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

::checkpoint[A request without the header answers 401 with `sync.auth_required`; a request with a valid token reaches your handler.]
::::

::::step{title="Scope reads and writes by the actor" time="3 min"}
Pass `authenticate` to the adapter and derive scopes from the actor it returns:

```ts title="src/server.ts"
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

Keep membership checks in `resolveScopes`, because it also gates writes against
the stored row ([write-path authorization](/concepts-scopes/#write-path-authorization)).

On Cloudflare Workers the same function goes into
`createWorkersFetchHandler({ config: (env) => ({ config, authenticate }) })`
([Cloudflare Workers](/server-workers/)).

::checkpoint[Two users in different lists each receive only their own list's rows.]
::::

::::step{title="Browser: send and rotate the header" time="5 min"}
`createSyncClientHandle` takes a `headers` record. The worker attaches it to
every sync, segment, and blob request:

```ts title="src/sync.ts"
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

`setHeaders` replaces the whole header set, and the next request uses it. Call
it whenever your auth library rotates the token, before the old token expires,
so sync rounds never see a 401. The `onSynced` branch covers a token that
expired first: `sync.auth_required` is retryable, so the worker keeps retrying
with backoff, and `sync()` after the refresh runs the next round without waiting
for the backoff.

With multi-tab on, `setHeaders` on a follower tab forwards to the leader worker.
Each tab also keeps its latest set, and a follower that becomes leader starts
its worker with that set. Rotate the token in every tab that holds a handle; the
most recent call wins. [Browser: realtime & lifecycle](/platform-web-realtime/)
covers the rest of the handle lifecycle.

::checkpoint[After `setHeaders`, the next request in the network panel carries the new `Authorization` value.]
::::

::::step{title="Native and headless: send and rotate the header" time="5 min"}
The Swift, Kotlin, Flutter, React Native, Tauri, and Rust clients take a headers
map in their config and replace the full set at runtime. Their native WebSocket
sends the headers on the handshake, so realtime needs no ticket. A live socket
keeps its handshake credentials until you reconnect it.

:::tabs
```swift sdk=swift title="Auth.swift"
try client.setHeaders(["Authorization": "Bearer \(token)"])
// A live socket keeps the old handshake headers: pause(), then resume().
```
```kotlin sdk=kotlin title="Auth.kt"
client.setHeaders(mapOf("Authorization" to "Bearer $token"))
```
```dart sdk=flutter title="lib/auth.dart"
client.setHeaders({'Authorization': 'Bearer $token'});
```
```ts sdk=react-native title="src/auth.ts"
await client.setHeaders({ authorization: `Bearer ${token}` });
// A live socket keeps the old handshake headers: pause(), then resume().
```
```ts sdk=tauri title="src/auth.ts"
await client.setHeaders({ authorization: `Bearer ${token}` });
// Apply it to the live socket now: disconnectRealtime(), then connectRealtime().
```
```rust sdk=rust title="src/auth.rs"
transport.set_headers(vec![("authorization".into(), format!("Bearer {token}"))]);
```
:::

A headless TypeScript process passes `headers` as a record or as a function to
`httpSyncTransport`, `httpSegmentDownloader`, and `httpBlobTransport`. The
transport calls the function on every request, so a long-running process rotates
its credential without rebuilding the client:

```ts title="src/service.ts"
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

The per-SDK calls are on [Swift](/platform-swift/), [Kotlin](/platform-kotlin/),
[Flutter](/platform-flutter/), [React Native](/platform-react-native/),
[Tauri](/platform-tauri/), and [Rust](/platform-rust/); the shared native
surface is on [Native client API](/native-client-api/). The rest of the headless
setup is on [Server-side sync clients](/guide-server-clients/).

::checkpoint[The next HTTP request from the client carries the new header, and a reconnected socket sends it in its handshake.]
::::
:::::

## Realtime tickets

### Browser: authenticate the realtime socket

The browser `WebSocket` constructor cannot send headers, so the realtime socket
authenticates by cookie or by a value on its URL. `setHeaders` never reaches it,
and a live socket keeps the credentials from its handshake. Native sockets send
headers and skip this section.

:::figure{title="Ticket flow, once per connection attempt" note="The long-lived bearer never reaches a URL"}
<div class="d-row">
<div class="node"><span class="t">1 · Client</span>POST /realtime-ticket with the bearer</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">2 · Mint</span>HMAC over actorId, partition, expiry; 60 s</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">3 · Client</span>wss://…/realtime?ticket=…</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">4 · Upgrade handler</span>Verify, then <code>hub.connect</code></div>
</div>

::caption[The realtime supervisor calls the connector on every reconnect, so each attempt mints a fresh ticket.]
:::

### Cookie sessions

A same-origin cookie session needs nothing extra: the browser sends the cookie
with the upgrade request, and your upgrade handler runs the same
`authenticate`. A cookie-session app reads the cookie inside that callback:

```ts title="src/auth.ts"
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
Serve the sync routes from that origin, or proxy them there, when you
authenticate with cookies. With `Bun.serve`, authenticate before upgrading and
carry the identity into `hub.connect`:

```ts title="src/server.ts"
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

### Mint a ticket

A bearer-token app exchanges the token for a short-lived ticket on each
connection attempt, because proxy access logs retain URLs. The ticket format is
yours: Syncular hands you the upgrade request to authenticate. Add an
authenticated HTTP endpoint that exchanges the caller's normal bearer for a
signed, expiring ticket. An HMAC over `actorId`, `partition`, and an expiry
needs no storage:

```ts title="src/ticket.ts"
const encoder = new TextEncoder();
const key = await crypto.subtle.importKey(
  'raw',
  encoder.encode(process.env.TICKET_SECRET!),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify'],
);

app.post('/realtime-ticket', async (c) => {
  const actor = await verify(c.req.raw); // your normal bearer auth
  if (actor === null) return c.body(null, 401);
  const payload = JSON.stringify({
    actorId: actor.id,
    partition: actor.tenant,
    expiresAtMs: Date.now() + 60_000,
  });
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload),
  );
  return c.json({
    ticket: `${btoa(payload)}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  });
});
```

### Verify at the upgrade

The WebSocket upgrade is host-owned ([Server setup](/guide-server/)). Verify the
ticket there, reject expired or badly signed tickets before upgrading, and pass
the recovered identity to `hub.connect`:

```ts title="src/server.ts"
const url = new URL(request.url);
const identity = await verifyTicket(url.searchParams.get('ticket'));
if (identity === null) return new Response(null, { status: 401 });
// … upgrade, then:
hub.connect({
  partition: identity.partition,
  actorId: identity.actorId,
  clientId,
  send,
  closeSocket,
});
```

On Cloudflare Workers the same check goes in the `authenticateRealtime` callback
([Cloudflare Workers](/server-workers/)).

### Fetch a ticket per attempt

A 60-second ticket outlives one connection attempt and no more. The built-in
`webSocketRealtimeConnector` takes a fixed URL, so a rotating flow supplies a
custom connector that fetches a fresh ticket for each attempt. In the browser
worker, `startSyncWorker({ createRealtime })` installs that connector and passes
it the current header set, so the ticket request carries the same bearer the sync
rounds use:

```ts title="src/worker.ts"
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

The [realtime supervisor](/platform-web-realtime/) calls the connector on every
reconnect. A failed ticket request fails the attempt, and the supervisor retries
it with backoff. A fixed ticket URL with `webSocketRealtimeConnector` suffices
for a ticket whose lifetime covers the process, such as a deploy-scoped service
credential.

A live socket authenticates only at handshake time. Rotating the ticket leaves
an established connection unchanged, so cutting off a revoked actor means
closing that actor's sockets on the server. The same rule holds for the
[operations watch socket](/guide-remote-operations/). What runs over the socket
after it connects is on [Realtime](/concepts-realtime/).

## Cross-origin and sign-out

A browser client on another origin sends `Authorization` and
`X-Syncular-Scopes`, which triggers a CORS preflight. Allow both headers in
front of the Syncular routes:

```ts title="src/server.ts"
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

The local database outlives a sign-out and still holds the previous user's rows
and outbox. Name the persistent database per user
(`database: { mode: 'persistent', name: 'my-app-' + userId }`) and close the
handle on sign-out, so the next user opens a separate replica. A
server-directed revocation removes rows through
[Authorized local purge](/concepts-local-data-purge/).
