/**
 * `@syncular-v2/server-workers` — the Cloudflare Workers entry (TODO §4.2).
 *
 * This is deliberately thin. `createSyncularHono` (server-hono) is already
 * Workers-native: it routes with Hono (which runs unmodified on `workerd`)
 * and speaks only Web `Request`/`Response`/`fetch`/Web-Crypto — nothing
 * Bun- or Node-specific. So the Workers lane is *not* a second adapter; it
 * is the same HTTP handler wired to Workers bindings:
 *
 *   - **D1** → `D1ServerStorage` (the sqlite-family storage over the D1
 *     binding, §4.2);
 *   - **R2 / secrets** → the segment store, blob store, and signed-URL
 *     config the host assembles from `env` (R2-as-S3 via `S3SegmentStore` +
 *     `s3PresignedUrls`, or a memory store for tests);
 *   - **secrets** → whatever `authenticate` needs.
 *
 * ## What this entry does NOT mount: realtime (§8)
 *
 * The realtime channel (`GET <mount>/realtime`, §1.1 second binding) needs a
 * durable, stateful WebSocket host. On Workers that is a **Durable Object**,
 * and it is a designed-but-deferred follow-up (README "Workers realtime — the
 * DO follow-up"). This entry mounts the HTTP binding only: `POST /sync`,
 * `GET /segments/:id`, `PUT`/`GET /blobs/:id`. Per SPEC §1.1 an HTTP-only
 * deployment is fully conformant — clients that cannot open the socket sync
 * over `POST /sync`, which carries identical semantics. No fallback is
 * implied: this is a smaller, complete deployment, not a degraded one.
 */
import {
  type D1Database,
  D1ServerStorage,
  type SyncServerConfig,
} from '@syncular-v2/server';
import {
  createSyncularHono,
  type SyncularHonoOptions,
} from '@syncular-v2/server-hono';

export { type D1Database, D1ServerStorage } from '@syncular-v2/server';

/**
 * Build the request-scoped config + auth for one Worker invocation from the
 * Worker's `env` (and `ctx`, e.g. for `waitUntil`). Runs per request so
 * bindings resolved from `env` (D1, R2, secrets) are always the live ones.
 * Return the `SyncServerConfig` the core handler needs plus the host
 * `authenticate` callback (§1.1).
 */
export type WorkersConfigFactory<Env = unknown> = (
  env: Env,
  ctx: ExecutionContextLike,
) => SyncularHonoOptions | Promise<SyncularHonoOptions>;

/** The subset of `ExecutionContext` this entry passes through. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/**
 * Wrap a `WorkersConfigFactory` into a Workers module `fetch` handler:
 *
 * ```ts
 * export default {
 *   fetch: createWorkersFetchHandler((env: Env) => ({
 *     config: syncConfig(env),
 *     authenticate: (req) => authenticate(req, env),
 *   })),
 * };
 * ```
 *
 * The returned handler builds the Hono app once per request from the factory
 * and delegates to it. Hono is cheap to construct; building per request keeps
 * the handler stateless (no module-global mutable server), which is the
 * Workers-correct posture — each invocation may run on a fresh isolate.
 */
export function createWorkersFetchHandler<Env = unknown>(
  factory: WorkersConfigFactory<Env>,
): (
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
) => Promise<Response> {
  return async (request, env, ctx) => {
    const options = await factory(env, ctx);
    const app = createSyncularHono(options);
    return app.fetch(request);
  };
}

/**
 * Convenience: a `D1ServerStorage` over a Worker's D1 binding. `migrate` is
 * NOT called here — apply the schema with `wrangler d1 migrations` (see the
 * README + `wrangler.toml` example) so cold requests never race a DDL apply.
 */
export function d1Storage(binding: D1Database): D1ServerStorage {
  return new D1ServerStorage(binding);
}

/** Re-export the shared config type for host `configFactory` signatures. */
export type { SyncServerConfig, SyncularHonoOptions };
