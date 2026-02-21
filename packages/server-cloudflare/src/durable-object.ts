/**
 * @syncular/server-cloudflare - Durable Object handler (WebSocket + polling)
 *
 * Provides a base DurableObject class with Hono routing and WebSocket support.
 * The DO's stateful nature allows it to hold persistent WebSocket connections,
 * bridging Cloudflare's hibernation API to Hono's `upgradeWebSocket` interface.
 *
 * @example
 * ```typescript
 * import { SyncDurableObject, createSyncWorkerWithDO } from '@syncular/server-cloudflare/durable-object';
 * import { createD1Db } from '@syncular/dialect-d1';
 * import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
 * import { ensureSyncSchema } from '@syncular/server';
 * import { createSyncServer } from '@syncular/server-hono';
 *
 * type Env = { DB: D1Database; SYNC_DO: DurableObjectNamespace };
 *
 * export class SyncDO extends SyncDurableObject<Env> {
 *   setup(app, env, upgradeWebSocket) {
 *     const db = createD1Db(env.DB);
 *     const dialect = createSqliteServerDialect();
 *     const { syncRoutes, consoleRoutes } = createSyncServer({
 *       db, dialect,
 *       sync: {
 *         handlers: [tasksHandler],
 *         authenticate: async (request) => ({
 *           actorId: request.headers.get('x-user-id')!,
 *         }),
 *       },
 *       upgradeWebSocket,
 *     });
 *     app.route('/sync', syncRoutes);
 *     if (consoleRoutes) app.route('/console', consoleRoutes);
 *   }
 * }
 *
 * // Worker entry — routes all requests to the DO
 * export default createSyncWorkerWithDO<Env>('SYNC_DO');
 * ```
 */

import { Hono } from 'hono';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import { defineWebSocketHelper, WSContext } from 'hono/ws';

// ---------------------------------------------------------------------------
// WebSocket ↔ Hono bridge
// ---------------------------------------------------------------------------

interface WebSocketTag {
  events: WSEvents<WebSocket>;
}

const STALE_SOCKET_CLOSE_CODE = 1012;
const STALE_SOCKET_CLOSE_REASON =
  'WebSocket session expired; reconnect required';

/**
 * WeakMap from server-side WebSocket → tag with event handlers.
 * Populated on upgrade, read in webSocketMessage/webSocketClose.
 */
const socketTags = new WeakMap<WebSocket, WebSocketTag>();

function closeStaleSocket(ws: WebSocket): void {
  try {
    ws.close(STALE_SOCKET_CLOSE_CODE, STALE_SOCKET_CLOSE_REASON);
  } catch {
    // ignore
  }
}

function createWSContext(ws: WebSocket): WSContext<WebSocket> {
  return new WSContext<WebSocket>({
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    raw: ws,
    get readyState() {
      return ws.readyState as 0 | 1 | 2 | 3;
    },
  });
}

/**
 * Create an `upgradeWebSocket` function backed by the Durable Object
 * hibernation API (`state.acceptWebSocket`).
 *
 * Each accepted socket is tagged with its Hono `WSEvents` handlers so the
 * DO's `webSocketMessage` / `webSocketClose` callbacks can dispatch to them.
 */
function createDOUpgradeWebSocket(
  doState: DurableObjectState
): UpgradeWebSocket<WebSocket> {
  return defineWebSocketHelper((_c, events) => {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Accept via hibernation API so the DO can wake on messages
    doState.acceptWebSocket(server);

    // Tag the server socket so webSocketMessage/webSocketClose can find handlers
    socketTags.set(server, { events: events as WSEvents<WebSocket> });

    // Fire onOpen synchronously (socket is already accepted)
    const wsCtx = createWSContext(server);
    events.onOpen?.(new Event('open'), wsCtx);

    return new Response(null, { status: 101, webSocket: client });
  });
}

// ---------------------------------------------------------------------------
// SyncDurableObject base class
// ---------------------------------------------------------------------------

/**
 * Base class for a Syncular Durable Object with Hono routing and WebSocket.
 *
 * Subclass and implement `setup()` to configure routes.
 */
export abstract class SyncDurableObject<
  E extends object = Record<string, unknown>,
> {
  protected ctx: DurableObjectState;
  protected env: E;

  private app: Hono<{ Bindings: E }> | null = null;
  private initPromise: Promise<void> | null = null;
  private doUpgradeWebSocket: UpgradeWebSocket<WebSocket>;

  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
    this.doUpgradeWebSocket = createDOUpgradeWebSocket(ctx);
    this.closeUntrackedSockets();
  }

  /**
   * Configure the Hono app with sync routes.
   *
   * Called once when the DO first receives a request.
   * Use `upgradeWebSocket` when creating the sync server to enable realtime.
   */
  abstract setup(
    app: Hono<{ Bindings: E }>,
    env: E,
    upgradeWebSocket: UpgradeWebSocket<WebSocket>
  ): void | Promise<void>;

  private async getApp(): Promise<Hono<{ Bindings: E }>> {
    if (this.app) return this.app;
    if (!this.initPromise) {
      const honoApp = new Hono<{ Bindings: E }>();
      this.initPromise = Promise.resolve(
        this.setup(honoApp, this.env, this.doUpgradeWebSocket)
      ).then(() => {
        this.app = honoApp;
      });
    }
    await this.initPromise;
    return this.app!;
  }

  private closeUntrackedSockets(): void {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      if (socketTags.has(ws)) continue;
      closeStaleSocket(ws);
    }
  }

  /** Handle incoming HTTP requests (and WebSocket upgrades). */
  async fetch(request: Request): Promise<Response> {
    const app = await this.getApp();
    return app.fetch(request, this.env);
  }

  /** Dispatch incoming WebSocket messages to Hono event handlers. */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const tag = socketTags.get(ws);
    if (!tag?.events.onMessage) {
      closeStaleSocket(ws);
      return;
    }

    const wsCtx = createWSContext(ws);
    const evt = new MessageEvent('message', { data: message });
    tag.events.onMessage(evt, wsCtx);
  }

  /** Dispatch WebSocket close events to Hono event handlers. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const tag = socketTags.get(ws);
    if (!tag?.events.onClose) {
      socketTags.delete(ws);
      return;
    }

    const wsCtx = createWSContext(ws);
    const evt = new CloseEvent('close', { code, reason });
    tag.events.onClose(evt, wsCtx);
    socketTags.delete(ws);
  }

  /** Dispatch WebSocket error events to Hono event handlers. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const tag = socketTags.get(ws);
    if (!tag?.events.onError) {
      closeStaleSocket(ws);
      return;
    }

    const wsCtx = createWSContext(ws);
    const evt = new Event('error');
    tag.events.onError(evt, wsCtx);
  }
}

// ---------------------------------------------------------------------------
// Worker → DO router
// ---------------------------------------------------------------------------

/**
 * Create a Worker export that routes all requests to a Durable Object.
 *
 * Uses a single DO instance (derived from a stable ID) to hold all
 * connections. For multi-tenant setups, override `getStubId`.
 *
 * @example
 * ```typescript
 * export default createSyncWorkerWithDO<Env>('SYNC_DO');
 * ```
 */
export function createSyncWorkerWithDO<E extends object>(
  bindingName: string & keyof E,
  options?: {
    /**
     * Derive a DurableObject ID from the request.
     * Defaults to a single global instance via `idFromName('sync')`.
     */
    getStubId?: (
      ns: DurableObjectNamespace,
      request: Request,
      env: E
    ) => DurableObjectId;
  }
): ExportedHandler<E> {
  return {
    async fetch(
      request: Request,
      env: E,
      _ctx: ExecutionContext
    ): Promise<Response> {
      const ns = env[
        bindingName as keyof E
      ] as unknown as DurableObjectNamespace;
      const id = options?.getStubId
        ? options.getStubId(ns, request, env)
        : ns.idFromName('sync');
      const stub = ns.get(id);
      return stub.fetch(request);
    },
  };
}
