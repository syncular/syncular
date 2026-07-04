# @syncular-v2/server-workers

The Cloudflare Workers entry for the Syncular v2 sync server (TODO §4.2). It
wires the runtime-neutral server core to Workers bindings — **D1** for
storage, **R2** for durable segment/blob bytes, secrets for signing and
auth — behind a standard Workers module `fetch` handler.

This package is deliberately thin. `@syncular-v2/server-hono`'s
`createSyncularHono` is already Workers-native (it routes with Hono, which
runs unmodified on `workerd`, and speaks only Web `Request`/`Response`/
`fetch`/Web-Crypto). So the Workers lane is not a second adapter — it is the
same HTTP handler wired to `env` bindings.

## What it mounts

The HTTP binding (SPEC §1.1):

| Route | Method | Purpose |
|---|---|---|
| `<mount>/sync` | POST | Combined push+pull (§4, §6) |
| `<mount>/segments/{id}` | GET | Bootstrap segment download (§5.5) |
| `<mount>/blobs/{id}` | PUT | Blob upload, content-address verified (§5.9.3) |
| `<mount>/blobs/{id}` | GET | Blob download, row-derived re-auth (§5.9.5) |

**Realtime (`GET <mount>/realtime`, §8) is supported** via a Durable Object —
see "Workers realtime — the Durable Object" below. It is opt-in: pass a
`realtime` option to `createWorkersFetchHandler` and add the DO binding to
`wrangler.toml`. Omit it for an HTTP-only deployment — per SPEC §1.1 that is
fully conformant: reference clients that cannot open the socket sync over
`POST /sync`, which carries identical semantics. This is a smaller, complete
deployment, not a degraded one — no fallback is implied.

## Usage

```ts
// src/worker.ts
import {
  D1ServerStorage,
  S3SegmentStore,
  s3PresignedUrls,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createWorkersFetchHandler } from '@syncular-v2/server-workers';
import { schema } from './syncular.generated'; // typegen output

interface Env {
  DB: D1Database; // wrangler.toml [[d1_databases]] binding = "DB"
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SYNC_JWT_SECRET: string;
}

function syncConfig(env: Env): SyncServerConfig {
  const segments = new S3SegmentStore({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket: 'syncular-segments',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  return {
    schema,
    storage: new D1ServerStorage(env.DB),
    segments,
    // §5.4 delegated presign: R2 mints the segment URL directly.
    signedUrls: s3PresignedUrls(segments, { ttlSeconds: 900 }),
    resolveScopes: (args) => resolveScopes(args, env),
    // No `sqliteImageBuilder`: Workers has no SQLite engine, so bit-2
    // clients are served the rows lane (§5.3 support floor). No `realtime`:
    // the DO follow-up.
  };
}

export default {
  fetch: createWorkersFetchHandler<Env>((env) => ({
    config: syncConfig(env),
    authenticate: (request) => authenticate(request, env),
  })),
};
```

`createWorkersFetchHandler(factory)` builds the Hono app once per request from
the factory and delegates. Building per request keeps the handler stateless
(no module-global mutable server) — the Workers-correct posture, since each
invocation may run on a fresh isolate.

See `wrangler.toml.example` for the binding config.

## Schema migration (D1)

`D1ServerStorage` does **not** apply its DDL on construction (a cold request
must never race a schema apply). Apply it once with wrangler. Generate the
migration SQL from `sqliteDdlStatements()` (exported from `@syncular-v2/server`)
into a `migrations/` file, then:

```sh
wrangler d1 create syncular
wrangler d1 migrations apply syncular
```

The schema is plain SQLite DDL (shared with `bun:sqlite` via
`sqlite-dialect.ts`), so it is portable across the two SQLite-family
storages.

## Storage: D1 (`D1ServerStorage`)

D1 *is* SQLite over an async, statement-at-a-time API, so `D1ServerStorage`
shares the schema and value codecs with `SqliteServerStorage` (the
`sqlite-dialect.ts` module) and differs only in execution shape.

**Transaction model.** D1 has no interactive transaction — the only atomic
primitive is `db.batch([...])`. The push handler reads first (conflict
detection) then writes, so `D1ServerStorage`'s transaction executes reads
immediately (autocommit) and **buffers** writes, flushing them as one atomic
`db.batch()` at `commit()` (the §6.4 all-or-nothing commit; a rejected op
rolls back by never flushing). A read-your-own-writes overlay makes `getRow`
see buffered writes of the same commit.

**Concurrency posture.** The dense per-partition `commitSeq` (§2.1) is
allocated by reading `max_commit_seq` live and buffering the `+1`. Under one
Worker request this is exact. For two concurrent pushes to the *same
partition*, serialize the writes: the DO realtime host (the follow-up) is the
natural per-partition serialization point; a stateless HTTP-only deployment
that expects concurrent same-partition writes SHOULD front D1 per-partition
writes with a coordinating primitive (a DO or a Queue). This mirrors
Postgres's per-partition row lock, achieved by placement rather than a lock
D1 does not expose. Cross-partition pushes never contend.

## Workers realtime — the Durable Object

The realtime channel (§8) needs a durable, stateful WebSocket host. On Workers
that is a **Durable Object**: `SyncularRealtimeHost` (`src/realtime-do.ts`)
hosts the `RealtimeHub`, uses WebSocket hibernation to drive the existing
`RealtimeSession`, and reads/writes the same D1 binding as the HTTP handler.

### Sharding: one DO per partition

The DO id is `idFromName(partition)`, so **all of a partition's sockets and
its commit fan-out live in one single-threaded DO** — which is also the
per-partition write-serialization point the D1 storage wants (see "Concurrency
posture"). Because the hub is the `RealtimeNotifier` (§8.2) *inside* the DO, a
sync round landing over the socket fans its full delta to the partition's
other sockets with **no LISTEN/NOTIFY** — writes and sockets are co-located.

One-partition-per-DO is the natural §8.2 fan-out boundary and the rung we ship.
**Many-partitions-per-shard** (one DO fronting a bucket of low-traffic
partitions, to amortize the DO floor) is a future tuning knob: the hub already
keys every operation by partition, so a shard DO hosts one hub and routes by
`partition` — no protocol change, only the id-derivation. Deferred until a
cost/traffic signal asks for it.

### Hibernation semantics

The DO uses the Hibernation API (`state.acceptWebSocket(ws)` +
`webSocketMessage`/`webSocketClose`/`webSocketError` handlers), so **idle
connections do not pin the DO in memory or bill wall time** — the cost story
for realtime on Workers: an idle open socket is ~free, you pay for rounds and
fan-out, not for connection wall time.

A `RealtimeSession` is in-memory only. The honest rule, as built:

- **Hibernation only happens between rounds.** An in-flight sync round is an
  async generator draining over `ws.send`; while pending it holds the DO's
  event loop, so the DO cannot be evicted mid-round. (This is the same
  property the §8.7 "one round in flight" rule already relies on.)
- **On the first message after a wake**, the socket carries a serialized
  attachment (`ws.serializeAttachment` — the minimal `{clientId, actorId,
  partition}` §8.1 identity, written at accept time) but no live session. The
  host rebuilds it via `hub.connect(...)`, which reloads the registration list
  from the client record in D1 (exactly what a fresh upgrade does, §8.1).
  Rehydration is transparent to the client: it was greeted once at the real
  upgrade, so the rehydration `hello` is swallowed. Cursor and registrations
  are the durable truth in D1; nothing in-flight is lost because nothing
  in-flight can be hibernated.

So the serialized attachment is deliberately minimal — the three identity
fields `connect` needs. Everything else is re-derived from D1, which is
authoritative.

### The wake path (HTTP push → DO)

A push landing via the *plain* HTTP handler (a stateless isolate with no
sockets) wakes the partition's DO. Wire `durableObjectRealtimeNotifier(env.
REALTIME)` into `SyncServerConfig.realtime`; after a commit lands it
`stub.fetch`es the DO's internal wake path, and the DO calls `hub.wake(
partition, 'catchup-required')` — its sockets re-pull the delta from the shared
D1 (§8.3). This is the Workers in-platform equivalent of Postgres LISTEN/NOTIFY:
a wake, not a byte re-broadcast, so remote sessions pay one re-pull. The wake
is fire-and-forget — a DO fetch failure never fails the push (the commit is
already durable; the client's next pull self-heals). A round landing *on the
DO itself* skips this entirely: the hub fans the full delta out in-process.

### Wiring

`createWorkersFetchHandler` takes a `{ config, realtime }` options object; the
`realtime` factory resolves the DO namespace + the upgrade auth per request:

```ts
// src/worker.ts
import {
  createWorkersFetchHandler,
  durableObjectRealtimeNotifier,
  D1ServerStorage,
  SyncularRealtimeHost,
  type RealtimeDOConfig,
} from '@syncular-v2/server-workers';
import { DurableObject } from 'cloudflare:workers';
import { MemorySegmentStore } from '@syncular-v2/server';
import { schema } from './syncular.generated';

interface Env {
  DB: D1Database;
  REALTIME: DurableObjectNamespace<SyncularRealtimeDO>;
}

const realtimeDOConfig = (env: Env): RealtimeDOConfig => ({
  hubConfig: () => ({
    schema,
    resolveScopes: (args) => resolveScopes(args, env),
    // §8.7: the socket carries sync rounds through the SAME handler + segment
    // store as POST /sync — pass the same segment store the HTTP path uses.
    segments: makeSegments(env),
  }),
});

// The DO class the runtime instantiates. It delegates to SyncularRealtimeHost;
// the platform bindings (DurableObjectState, WebSocket, D1Database) are the
// real cloudflare:workers types here.
export class SyncularRealtimeDO extends DurableObject<Env> {
  #host = new SyncularRealtimeHost(this.ctx, this.env.DB, realtimeDOConfig(this.env));
  fetch(request: Request) { return this.#host.fetch(request); }
  webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    return this.#host.webSocketMessage(ws, msg);
  }
  webSocketClose(ws: WebSocket) { return this.#host.webSocketClose(ws); }
  webSocketError(ws: WebSocket) { return this.#host.webSocketError(ws); }
}

export default {
  fetch: createWorkersFetchHandler<Env>({
    config: (env) => ({
      config: {
        schema,
        storage: new D1ServerStorage(env.DB),
        segments: makeSegments(env),
        resolveScopes: (args) => resolveScopes(args, env),
        // HTTP pushes wake the partition's DO (the LISTEN/NOTIFY analogue).
        realtime: durableObjectRealtimeNotifier(env.REALTIME),
      },
      authenticate: (request) => authenticate(request, env),
    }),
    realtime: (env) => ({
      namespace: env.REALTIME,
      // The realtime-channel auth seam (analogue of `authenticate`): resolve
      // the §8 upgrade identity; the `partition` selects the DO. Return
      // undefined to reject with a 401.
      authenticate: (request) => authenticateRealtime(request, env),
    }),
  }),
};
```

The platform surface (`DurableObjectState`, `WebSocket`, `D1Database`,
`DurableObjectNamespace`) is typed **structurally** in `realtime-do.ts`, so the
package takes no `@cloudflare/workers-types` dependency — the same posture
`d1-storage.ts` takes for the D1 API. Your Worker's own types come from
`@cloudflare/workers-types` / `cloudflare:workers`; they are structurally
compatible with the host's declared subset.

Add the DO binding + migration to `wrangler.toml` (see `wrangler.toml.example`).

### Real-workerd smoke: a manual recipe (why no automated lane)

The hermetic tests (`test/realtime-do.test.ts`) drive the **real**
`RealtimeSession`/`RealtimeHub`/`D1ServerStorage` code through the real DO class
over a DO double + the D1 double + the reference codec — connect → hello →
round-over-socket → delta-on-commit → ack, hibernation rehydration, the
HTTP-push wake fan-out, and presence. Because the DO is a *deployment adapter*
(same wire, same handler), that is the conformance bar.

An automated `wrangler dev` smoke was **deliberately not added**: `wrangler` as
a devDependency bundles `workerd` + `esbuild` + `miniflare` — well over 100 MB
installed, disproportionate for one WebSocket round when the double already
exercises the real logic. Instead, smoke it manually against real `workerd`:

```sh
# In a Worker project wired per the "Wiring" example above:
wrangler d1 create syncular && wrangler d1 migrations apply syncular --local
wrangler dev
# Then, against the local dev server, open the socket and run one round:
#   const ws = new WebSocket('ws://localhost:8787/realtime?...')
#   ws.onmessage = (e) => console.log(e.data)  // expect a `hello` frame
# (the demo app's frontend worker is a worked reference client.)
```

If a signal justifies it later, the automated lane is a small `SYNCULAR_
WRANGLER_SMOKE=1`-gated test wrapping exactly this recipe.

## Runtime neutrality

The server core this entry loads (handler, realtime session, D1 storage,
memory stores, signed-URL/segment/blob machinery) is free of Bun- and
Node-only builtins — SigV4 and all hashing use Web Crypto, base64 uses
`btoa`/`atob`, and the SQLite-family stores that need `bun:sqlite`
(`SqliteServerStorage`, `SqliteSegmentStore`, `SqliteBlobStore`,
`SqliteLeaseStore`, `buildSqliteImage`) live in separate modules a Bun/Node
host opts into and a Workers bundle tree-shakes away. This is enforced by a
static import-graph scan in
`packages/server/test/runtime-neutrality.test.ts`.
