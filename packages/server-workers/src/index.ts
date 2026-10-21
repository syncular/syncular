/**
 * `@syncular/server-workers` — the Cloudflare Workers entry.
 *
 * This is deliberately thin. `createSyncularHono` (server-hono) is already
 * Workers-native: it routes with Hono (which runs unmodified on `workerd`)
 * and speaks only Web `Request`/`Response`/`fetch`/Web-Crypto — nothing
 * Bun- or Node-specific. So the Workers lane is *not* a second adapter; it
 * is the same HTTP handler wired to Workers bindings:
 *
 *   - **D1** → `D1ServerStorage` (the sqlite-family storage over the D1
 *     binding, §4.2);
 *   - **R2 / segments and blobs** → the segment store, blob store, and
 *     signed-URL config the host assembles from `env`. With a bucket binding
 *     (`env.BUCKET`), `R2SegmentStore` and `R2BlobStore` (`r2-stores.ts`) put
 *     the durable bytes in the same key layout as the S3 stores, with no S3
 *     credentials and no presign (bytes are served inline). With R2's S3
 *     endpoint, the S3 stores plus `s3PresignedUrls` give delegated presign
 *     (§5.4); a memory store serves tests;
 *   - **secrets** → whatever `authenticate` needs.
 *
 * ## Realtime (§8): the Durable Object
 *
 * The realtime channel (`GET <mount>/realtime`, §1.1 second binding) needs a
 * durable, stateful WebSocket host. On Workers that is a **Durable Object** —
 * `SyncularRealtimeDO` (`realtime-do.ts`): one DO per partition hosting the
 * `RealtimeHub`, WebSocket hibernation driving the existing `RealtimeSession`,
 * in-DO commit fan-out, storage over the same D1 binding. Pass a
 * `realtime` option to mount `/realtime`; its namespace also coordinates D1
 * `/sync`. An HTTP-only D1 deployment uses the `coordinator` option instead:
 * WebSockets are optional, the per-partition push queue is not.
 */
import {
  type D1Database,
  D1ServerStorage,
  errorBody,
  SSP2_CONTENT_TYPE,
  type StoredCommit,
  SyncError,
  SyncularAdmin,
  type SyncServerConfig,
} from '@syncular/server';
import {
  createSyncularAdminRoutes,
  createSyncularHono,
  type SyncularAdminGuards,
  type SyncularHonoOptions,
} from '@syncular/server-hono';
import {
  adminRequestForDurableObject,
  OPERATIONS_DO_REQUEST_PATH,
  REALTIME_DO_UPGRADE_PATH,
  REALTIME_DO_WAKE_PATH,
  type RealtimeUpgradeIdentity,
  SYNC_DO_REQUEST_PATH,
  writeIdentityHeaders,
  writeRequestIdentityHeaders,
} from './realtime-do';

export { type D1Database, D1ServerStorage } from '@syncular/server';
export * from './r2-stores';
export * from './realtime-do';

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

// -- Durable Object bindings (structural; no @cloudflare/workers-types dep) --

/** A DO stub — the callable handle to one Durable Object instance. */
export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

/** A DO namespace binding: `idFromName` → `get(id)` → a stub. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectIdLike {
  toString(): string;
}

/**
 * Realtime wiring for `createWorkersFetchHandler`. Supplying it mounts the
 * `GET <mount>/realtime` upgrade route and uses the same namespace as the D1
 * `/sync` coordinator.
 */
export interface WorkersRealtimeOptions {
  /** The DO namespace binding (wrangler `[[durable_objects.bindings]]`). */
  readonly namespace: DurableObjectNamespaceLike;
  /**
   * Resolve the §8 upgrade identity from the incoming `GET /realtime` request.
   * This is the realtime-channel authentication seam — the analogue of the
   * HTTP handler's `authenticate`. Return `undefined` to reject the upgrade
   * (a 401). The `partition` selects the DO (one DO per partition).
   */
  readonly authenticate: (
    request: Request,
  ) =>
    | RealtimeUpgradeIdentity
    | undefined
    | Promise<RealtimeUpgradeIdentity | undefined>;
  /** The mount path segment for the upgrade route; default `/realtime`. */
  readonly path?: string;
}

/** Resolve the per-env realtime wiring for one Worker invocation. */
export type WorkersRealtimeFactory<Env = unknown> = (
  env: Env,
  ctx: ExecutionContextLike,
) => WorkersRealtimeOptions | Promise<WorkersRealtimeOptions>;

/** Per-partition Durable Object boundary for D1 sync rounds without WS. */
export interface WorkersCoordinatorOptions {
  readonly namespace: DurableObjectNamespaceLike;
}

export type WorkersCoordinatorFactory<Env = unknown> = (
  env: Env,
  ctx: ExecutionContextLike,
) => WorkersCoordinatorOptions | Promise<WorkersCoordinatorOptions>;

/**
 * The admin console for `createWorkersFetchHandler`. The host guards run in
 * the Worker. With a coordinator (or realtime) namespace, every
 * partition-scoped admin request then goes to the partition's Durable
 * Object: its event ring sees that partition's sync rounds, and actions
 * share its FIFO. The page and the fleet view (`GET <path>/partitions`) are
 * served by the Worker. Without a namespace the Worker serves everything
 * and has no event ring.
 */
export interface WorkersAdminOptions extends SyncularAdminGuards {
  /** The mount path; default `/admin`. */
  readonly path?: string;
}

export type WorkersAdminFactory<Env = unknown> = (
  env: Env,
  ctx: ExecutionContextLike,
) => WorkersAdminOptions | Promise<WorkersAdminOptions>;

export interface WorkersFetchHandlerOptions<Env = unknown> {
  /** Build the HTTP handler config + auth per request (see the type doc). */
  readonly config: WorkersConfigFactory<Env>;
  /**
   * Serialize D1 `/sync` rounds through one Durable Object per partition.
   * Required for D1 pushes when `realtime` is omitted. If `realtime` is
   * present its namespace is the coordinator automatically.
   */
  readonly coordinator?: WorkersCoordinatorFactory<Env>;
  /**
   * Realtime (§8) over a Durable Object. Omit for an HTTP-only deployment
   * (still fully conformant — clients sync over `POST /sync`).
   */
  readonly realtime?: WorkersRealtimeFactory<Env>;
  /** Mount the admin console (see `WorkersAdminOptions`). */
  readonly admin?: WorkersAdminFactory<Env>;
}

/**
 * Wrap a config factory (or a `{ config, realtime }` options object) into a
 * Workers module `fetch` handler:
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
 * With realtime over a Durable Object, pass the options form and thread the
 * `durableObjectRealtimeNotifier` into the config's `realtime` so HTTP pushes
 * wake the partition's DO:
 *
 * ```ts
 * export default {
 *   fetch: createWorkersFetchHandler<Env>({
 *     config: (env) => ({
 *       config: {
 *         ...syncConfig(env),
 *         realtime: durableObjectRealtimeNotifier(env.REALTIME),
 *       },
 *       authenticate: (req) => authenticate(req, env),
 *     }),
 *     realtime: (env) => ({
 *       namespace: env.REALTIME,
 *       authenticate: (req) => authenticateRealtime(req, env),
 *     }),
 *   }),
 * };
 * export { SyncularRealtimeDO } from './realtime-do-class';
 * ```
 *
 * The returned handler builds the Hono app once per request from the factory
 * and delegates to it. Hono is cheap to construct; building per request keeps
 * the handler stateless (no module-global mutable server), which is the
 * Workers-correct posture — each invocation may run on a fresh isolate.
 */
export function createWorkersFetchHandler<Env = unknown>(
  factoryOrOptions: WorkersConfigFactory<Env> | WorkersFetchHandlerOptions<Env>,
): (
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
) => Promise<Response> {
  const options: WorkersFetchHandlerOptions<Env> =
    typeof factoryOrOptions === 'function'
      ? { config: factoryOrOptions }
      : factoryOrOptions;
  return async (request, env, ctx) => {
    // §8 upgrade: GET <mount>/realtime → forward to the partition's DO.
    let realtime: WorkersRealtimeOptions | undefined;
    if (options.realtime !== undefined) {
      realtime = await options.realtime(env, ctx);
      const upgraded = await handleRealtimeUpgrade(request, realtime);
      if (upgraded !== undefined) return upgraded;
    }
    const honoOptions = await options.config(env, ctx);
    const coordinator =
      options.coordinator !== undefined
        ? await options.coordinator(env, ctx)
        : realtime;
    const partitionPath =
      coordinator !== undefined ? partitionRequestPath(request) : undefined;
    if (coordinator !== undefined && partitionPath !== undefined) {
      if (
        partitionPath === OPERATIONS_DO_REQUEST_PATH &&
        honoOptions.operations !== undefined
      ) {
        // Commands must apply on the partition FIFO; a registry in the
        // Worker would run them beside it.
        throw new Error(
          'createWorkersFetchHandler: pass operations to the Durable Object config (RealtimeDOConfig.operations), not to the Worker config',
        );
      }
      const auth = await honoOptions.authenticate(request);
      if (auth === null) {
        const error = new SyncError('sync.auth_required');
        return Response.json(errorBody(error), { status: error.httpStatus });
      }
      return forwardSyncRequest(
        request,
        coordinator.namespace,
        auth,
        partitionPath,
      );
    }
    if (options.admin !== undefined) {
      const admin = await options.admin(env, ctx);
      const path = admin.path ?? '/admin';
      const url = new URL(request.url);
      if (url.pathname === path || url.pathname.startsWith(`${path}/`)) {
        const routePath = url.pathname.slice(path.length);
        const routes = createSyncularAdminRoutes(
          SyncularAdmin.fromConfig(honoOptions.config),
          {
            authorize: admin.authorize,
            ...(admin.authorizeActions !== undefined
              ? { authorizeActions: admin.authorizeActions }
              : {}),
            ...(honoOptions.config.onError !== undefined
              ? { onError: honoOptions.config.onError }
              : {}),
            ...(honoOptions.config.mapError !== undefined
              ? { mapError: honoOptions.config.mapError }
              : {}),
            ...(coordinator !== undefined
              ? {
                  forward: (forwarded, target) =>
                    coordinator.namespace
                      .get(coordinator.namespace.idFromName(target.partition))
                      .fetch(
                        adminRequestForDurableObject(
                          forwarded,
                          routePath,
                          target,
                        ),
                      ),
                }
              : {}),
          },
        );
        url.pathname = routePath === '' ? '/' : routePath;
        return routes.fetch(new Request(url, request));
      }
    }
    const app = createSyncularHono(honoOptions);
    return app.fetch(request);
  };
}

/**
 * The Durable Object path for a request that must run on the partition FIFO:
 * `POST /sync` with the SSP2 content type and `POST /operations` (the DO
 * checks the operations content type). Exactly the routes
 * `createSyncularHono` mounts at the app root; any other path, such as
 * `/admin/sync`, stays with Hono routing.
 */
function partitionRequestPath(request: Request): string | undefined {
  if (request.method !== 'POST') return undefined;
  const pathname = new URL(request.url).pathname;
  if (pathname === '/operations') return OPERATIONS_DO_REQUEST_PATH;
  const contentType = request.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim();
  if (pathname === '/sync' && contentType === SSP2_CONTENT_TYPE)
    return SYNC_DO_REQUEST_PATH;
  return undefined;
}

/**
 * Forward an authenticated HTTP sync round (or, with
 * `OPERATIONS_DO_REQUEST_PATH`, a remote operation) to the partition's
 * Durable Object. Pulls, pushes and commands share this boundary so
 * client-record updates and commit apply use one ordered partition FIFO.
 * Other HTTP routes remain direct.
 */
export function forwardSyncRequest(
  request: Request,
  namespace: DurableObjectNamespaceLike,
  identity: { readonly partition: string; readonly actorId: string },
  path: string = SYNC_DO_REQUEST_PATH,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(identity.partition));
  const forwarded = new Request(new URL(path, request.url), request);
  writeRequestIdentityHeaders(forwarded.headers, identity);
  return stub.fetch(forwarded);
}

/**
 * If `request` is the `GET <mount>/realtime` upgrade, authenticate it and
 * forward it to the partition's DO stub; otherwise return `undefined` so the
 * caller falls through to the HTTP handler.
 */
async function handleRealtimeUpgrade(
  request: Request,
  realtime: WorkersRealtimeOptions,
): Promise<Response | undefined> {
  const path = realtime.path ?? '/realtime';
  const url = new URL(request.url);
  if (url.pathname !== path && !url.pathname.endsWith(path)) return undefined;
  if (request.method !== 'GET') return undefined;
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 });
  }
  const identity = await realtime.authenticate(request);
  if (identity === undefined) {
    return new Response('unauthorized', { status: 401 });
  }
  return forwardRealtimeUpgrade(request, realtime.namespace, identity);
}

/**
 * Forward a `/realtime` upgrade to the partition's DO stub. The identity is
 * carried on internal headers to the DO's upgrade endpoint (the DO trusts the
 * Worker to have authenticated — the DO namespace is private to the Worker).
 * The DO is selected by `idFromName(partition)`: one DO per partition (§8.2).
 */
export function forwardRealtimeUpgrade(
  request: Request,
  namespace: DurableObjectNamespaceLike,
  identity: RealtimeUpgradeIdentity,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(identity.partition));
  const forwarded = new Request(
    new URL(REALTIME_DO_UPGRADE_PATH, request.url),
    request,
  );
  writeIdentityHeaders(forwarded.headers, identity);
  return stub.fetch(forwarded);
}

/**
 * A `RealtimeNotifier` (§8.2) for an external authoritative command host that
 * already serializes its D1 writes and must wake the partition's DO. The DO
 * calls `hub.wake(partition, 'catchup-required')` and its sockets re-pull the
 * delta from the shared D1 (§8.3) — the Workers in-platform analogue of the
 * Postgres LISTEN/NOTIFY fan-out. A wake, not a byte re-broadcast.
 *
 * Ordinary Workers `/sync` does not need this: it already lands on the DO and
 * fans out in-process. This wake is fire-and-forget:
 * a DO fetch failure never fails the push (the commit is already durable in
 * D1; the client's next pull or reconnect self-heals).
 */
export function durableObjectRealtimeNotifier(
  namespace: DurableObjectNamespaceLike,
): {
  notifyCommit: (partition: string, commit: StoredCommit) => Promise<void>;
} {
  return {
    async notifyCommit(partition: string): Promise<void> {
      try {
        const stub = namespace.get(namespace.idFromName(partition));
        // A synthetic origin — the DO only reads the path + JSON body.
        await stub.fetch(
          new Request(`https://do${REALTIME_DO_WAKE_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ partition }),
          }),
        );
      } catch {
        // Fire-and-forget: the commit is durable; the DO wake is best-effort.
      }
    },
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
