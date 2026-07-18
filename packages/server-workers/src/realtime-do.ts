/**
 * `SyncularRealtimeDO` — the Cloudflare Durable Object realtime host (§8, the
 * second binding of §1.1). ROADMAP block 2: the designed-but-deferred half of
 * the Workers deployment matrix, now built.
 *
 * ## The shape
 *
 * One DO instance hosts **one `RealtimeHub`** and serves **one partition**
 * (the DO id is `idFromName(partition)`, see `realtimeStubFor`). All of a
 * partition's sync rounds, sockets, and commit fan-out live behind its
 * explicit FIFO — the per-partition serialization point D1 requires. Because
 * the hub is the
 * `RealtimeNotifier` (§8.2) *inside* the DO, a sync round that lands over the
 * socket fans its full delta out to the partition's other sockets with no
 * LISTEN/NOTIFY — writes and sockets are co-located.
 *
 * One-partition-per-DO is the natural §8.2 fan-out boundary and the rung we
 * ship. Many-partitions-per-shard (one DO fronting a bucket of low-traffic
 * partitions, to amortize the DO floor) is a future tuning knob: the hub
 * already keys every operation by partition, so a shard DO would host one hub
 * and route by `partition` — no protocol change, only the id-derivation and
 * the fan-out `partition` filter (already present). Deferred until a
 * cost/traffic signal asks for it.
 *
 * ## WebSocket hibernation (`state.acceptWebSocket`)
 *
 * Idle sockets must not pin the DO in memory or bill wall time. We use the
 * Hibernation API: `acceptWebSocket(ws)` hands the socket to the runtime,
 * `webSocketMessage`/`webSocketClose`/`webSocketError` are delivered as
 * class methods, and between deliveries the DO may be evicted from memory
 * while the sockets stay open.
 *
 * The per-connection state machine is the existing `RealtimeSession`
 * (`@syncular/server`) — unchanged, driven from the hibernation callbacks:
 * binary frames → `session.handleBinary` (§8.7 rounds + acks), text frames →
 * `session.handleMessage` (§8.2 acks, §8.6 presence), hub delta/wake sends →
 * `ws.send`.
 *
 * ### Hibernation-safe state: rehydration
 *
 * A `RealtimeSession` is *in-memory only* — on wake from hibernation the DO's
 * `#sessions` map is empty. The honest rule:
 *
 *   - **Hibernation only happens between rounds.** An in-flight sync round is
 *     an async generator draining over `ws.send`; while it is pending it holds
 *     the DO's event loop, so the DO cannot be evicted mid-round. (This is the
 *     same property the §8.7 "one round in flight" rule relies on.)
 *   - **On the first message after a wake**, the socket has a serialized
 *     attachment (`ws.serializeAttachment` — `{clientId, actorId, partition}`,
 *     written at accept time) but no live session. We reconstruct the session
 *     via `hub.connect(...)`, which reloads the registration list from the
 *     client record in D1 (the §8.1 load-at-upgrade rule — exactly what a
 *     fresh upgrade does), then dispatch the message into it. Rehydration is
 *     transparent to the client: it saw `hello` once at the real upgrade, so
 *     the rehydration `hello` is swallowed (a one-shot filter on the send
 *     wrapper). Cursor/registration are the durable truth in D1; nothing
 *     in-flight is lost because nothing in-flight can be hibernated.
 *
 * So the serialized attachment is deliberately minimal — the three identity
 * fields `connect` needs. Everything else (`cursor`, `registrations`,
 * `lastKnownSeq`) is re-derived from D1 by `connect`, which is authoritative.
 *
 * ## The wake path (external-command fan-out)
 *
 * Ordinary HTTP `/sync` is forwarded into this DO and fans out in-process. An
 * external authoritative command host that already provides equivalent D1
 * partition serialization may call `/__wake` after its own commit so sockets
 * re-pull. See `durableObjectRealtimeNotifier` for that caller side.
 */
import {
  createRealtimeHub,
  D1ServerStorage,
  errorBody,
  handleSyncRequest,
  type RealtimeHub,
  type RealtimeHubConfig,
  type RealtimeSession,
  SSP2_CONTENT_TYPE,
  SyncError,
} from '@syncular/server';

// -- The Durable Object platform surface this class uses (structural) -------
// Declared locally so the package takes no `@cloudflare/workers-types`
// dependency; the real bindings are structurally compatible. This is the
// same posture `d1-storage.ts` takes for the D1 API.

export interface DurableObjectStateLike {
  acceptWebSocket(ws: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
}

export interface WebSocketLike {
  accept?(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The `WebSocketPair` constructor result: `[client, server]` by index. */
export type WebSocketPairLike = { 0: WebSocketLike; 1: WebSocketLike };

/**
 * The host env a `SyncularRealtimeDO` reads. Supplied by the DO runtime via
 * the class constructor's second arg. `DB` is the D1 binding (the same one the
 * outer Worker config uses); `configFactory` builds the hub config from `env`.
 */
export type RealtimeDOConfig =
  | {
      /**
       * Preferred: build the complete canonical sync config around the DO's
       * coordinated D1 storage. Reuse this factory for the outer HTTP adapter
       * so HTTP-forwarded and socket rounds cannot drift by capability.
       */
      syncConfig(storage: D1ServerStorage): RealtimeHubConfig;
      readonly hubConfig?: never;
    }
  | {
      /**
       * @deprecated Use `syncConfig`. This compatibility shape predates the
       * canonical HTTP/realtime capability contract.
       */
      hubConfig(storage: D1ServerStorage): RealtimeHubConfigInput;
      readonly syncConfig?: never;
    };

/**
 * The subset of `RealtimeHubConfig` the DO host supplies (storage is wired by
 * the DO from its D1 binding, so it is omitted here).
 */
export type RealtimeHubConfigInput = Omit<RealtimeHubConfig, 'storage'>;

/** The attachment persisted on each hibernatable socket (§8.1 identity). */
interface SocketAttachment {
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
}

function isAttachment(value: unknown): value is SocketAttachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SocketAttachment).partition === 'string' &&
    typeof (value as SocketAttachment).actorId === 'string' &&
    typeof (value as SocketAttachment).clientId === 'string'
  );
}

/** The identity the upgrade request must carry (resolved by the Worker). */
export interface RealtimeUpgradeIdentity {
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
}

/** Internal control-request paths on the DO stub (never client-facing). */
export const REALTIME_DO_WAKE_PATH = '/__syncular_realtime/wake';
export const REALTIME_DO_UPGRADE_PATH = '/__syncular_realtime/upgrade';
export const SYNC_DO_REQUEST_PATH = '/__syncular_realtime/sync';

/**
 * The base `SyncularRealtimeDO`. A host subclasses (or instantiates) it with a
 * `RealtimeDOConfig`. The class is platform-shaped: `state.acceptWebSocket` +
 * `webSocket*` handlers are the Cloudflare Durable Object hibernation contract.
 *
 * Because the platform types are declared structurally (no
 * `@cloudflare/workers-types` dependency), a real deployment declares:
 *
 * ```ts
 * export class SyncularRealtimeDO extends DurableObject {
 *   #impl = new SyncularRealtimeHost(this.ctx, this.env, config);
 *   fetch(req: Request) { return this.#impl.fetch(req); }
 *   webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
 *     return this.#impl.webSocketMessage(ws, msg);
 *   }
 *   webSocketClose(ws: WebSocket) { return this.#impl.webSocketClose(ws); }
 *   webSocketError(ws: WebSocket) { return this.#impl.webSocketError(ws); }
 * }
 * ```
 *
 * The reference host is `SyncularRealtimeHost` below; the tests drive it
 * directly over the DO double.
 */
export class SyncularRealtimeHost {
  readonly #state: DurableObjectStateLike;
  readonly #storage: D1ServerStorage;
  readonly #config: RealtimeDOConfig;
  #hub: RealtimeHub | undefined;
  /** Live sessions, keyed by their socket. Empty after a hibernation wake;
   * lazily rehydrated on the first message per socket (see the class doc). */
  readonly #sessions = new Map<WebSocketLike, RealtimeSession>();
  /** Sockets whose rehydration `hello` must be swallowed (already greeted at
   * the real upgrade — rehydration is transparent to the client). */
  readonly #swallowHello = new Set<WebSocketLike>();
  /** Explicit FIFO: Durable Object events may interleave at `await`. */
  #partitionTail: Promise<void> = Promise.resolve();

  constructor(
    state: DurableObjectStateLike,
    db: D1Database,
    config: RealtimeDOConfig,
  ) {
    this.#state = state;
    this.#storage = new D1ServerStorage(db, {
      // Every HTTP/socket sync round enters #serializePartition before this
      // storage is used. One DO is selected per partition.
      pushApplySerialized: true,
    });
    this.#config = config;
  }

  #getHub(): RealtimeHub {
    if (this.#hub === undefined) {
      const config =
        this.#config.syncConfig !== undefined
          ? this.#config.syncConfig(this.#storage)
          : {
              ...this.#config.hubConfig(this.#storage),
              storage: this.#storage,
            };
      if (config.storage !== this.#storage) {
        throw new Error(
          'RealtimeDOConfig.syncConfig must use the coordinated storage argument',
        );
      }
      this.#hub = createRealtimeHub(config);
    }
    return this.#hub;
  }

  /**
   * The DO `fetch` handler: routes the internal upgrade + wake control paths.
   * The Worker forwards `GET <mount>/realtime` here as an upgrade with the
   * resolved identity in headers (see `forwardRealtimeUpgrade` in `index.ts`),
   * and accepts external-command wakes at `/__syncular_realtime/wake`.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === SYNC_DO_REQUEST_PATH) {
      return this.#serializePartition(() => this.#handleSync(request));
    }
    if (url.pathname === REALTIME_DO_WAKE_PATH) {
      return this.#handleWake(request);
    }
    if (url.pathname === REALTIME_DO_UPGRADE_PATH) {
      return this.#handleUpgrade(request);
    }
    return new Response('not found', { status: 404 });
  }

  #serializePartition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#partitionTail.then(operation, operation);
    this.#partitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #handleSync(request: Request): Promise<Response> {
    const contentType = request.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim();
    if (contentType !== SSP2_CONTENT_TYPE) {
      const error = new SyncError(
        'sync.invalid_request',
        'unsupported content type',
      );
      return Response.json(errorBody(error), { status: 415 });
    }
    const identity = readRequestIdentityHeaders(request);
    if (identity === undefined) {
      const error = new SyncError('sync.auth_required');
      return Response.json(errorBody(error), { status: error.httpStatus });
    }
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const out = await handleSyncRequest(
        bytes,
        this.#getHub().requestContextFor(identity),
      );
      return new Response(out.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': SSP2_CONTENT_TYPE },
      });
    } catch (error) {
      const sync =
        error instanceof SyncError
          ? error
          : new SyncError('sync.invalid_request', String(error));
      return Response.json(errorBody(sync), { status: sync.httpStatus });
    }
  }

  /** §8.3 wake: an external coordinated command landed; re-pull the delta. */
  async #handleWake(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      partition?: unknown;
    } | null;
    const partition = body?.partition;
    if (typeof partition !== 'string') {
      return new Response('bad wake', { status: 400 });
    }
    // Wake only if this DO actually holds sockets (a cold DO has none — the
    // socket that would care is on this DO by construction, so a wake to a
    // DO with no sockets is simply a no-op, not an error).
    this.#getHub().wake(partition, 'catchup-required');
    return new Response(null, { status: 204 });
  }

  /** The WebSocket upgrade: accept a hibernatable socket, connect the hub. */
  async #handleUpgrade(request: Request): Promise<Response> {
    const identity = readIdentityHeaders(request);
    if (identity === undefined) {
      return new Response('missing realtime identity', { status: 400 });
    }
    const pair = newWebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hand the server socket to the runtime for hibernation. The attachment
    // is the minimal §8.1 identity `connect` needs to rehydrate.
    const attachment: SocketAttachment = {
      partition: identity.partition,
      actorId: identity.actorId,
      clientId: identity.clientId,
    };
    server.serializeAttachment(attachment);
    this.#state.acceptWebSocket(server);
    // Build the session now (first connect: hello IS delivered). Any failure
    // closes the socket loudly — never a half-open realtime connection.
    try {
      const session = await this.#connectSession(server, attachment, false);
      this.#sessions.set(server, session);
    } catch (error) {
      server.close(1011, 'realtime connect failed');
      return new Response(
        error instanceof Error ? error.message : 'connect failed',
        { status: 400 },
      );
    }
    // `webSocket` is a workerd-only ResponseInit field (the 101 upgrade
    // handshake); the standard lib type has no slot for it.
    const init = { status: 101, webSocket: client } as unknown as ResponseInit;
    return new Response(null, init);
  }

  /** Build a `RealtimeSession` for a socket via the hub (§8.1). */
  async #connectSession(
    ws: WebSocketLike,
    attachment: SocketAttachment,
    rehydrate: boolean,
  ): Promise<RealtimeSession> {
    if (rehydrate) this.#swallowHello.add(ws);
    const session = await this.#getHub().connect({
      partition: attachment.partition,
      actorId: attachment.actorId,
      clientId: attachment.clientId,
      send: (data) => {
        // Swallow exactly one hello on a rehydrated socket — the client was
        // greeted at the real upgrade; rehydration is transparent (§8.1).
        if (this.#swallowHello.has(ws)) {
          this.#swallowHello.delete(ws);
          if (isHello(data)) return;
        }
        sendOverSocket(ws, data);
      },
      closeSocket: () => ws.close(1008, 'protocol violation (§8.7)'),
    });
    return session;
  }

  /**
   * Resolve the session for a socket, rehydrating from the attachment + D1 if
   * the DO woke from hibernation and lost its in-memory map.
   */
  async #sessionFor(ws: WebSocketLike): Promise<RealtimeSession | undefined> {
    const existing = this.#sessions.get(ws);
    if (existing !== undefined) return existing;
    const attachment = ws.deserializeAttachment();
    if (!isAttachment(attachment)) return undefined;
    const session = await this.#connectSession(ws, attachment, true);
    this.#sessions.set(ws, session);
    return session;
  }

  /** Hibernation callback: an inbound frame. */
  async webSocketMessage(
    ws: WebSocketLike,
    message: ArrayBuffer | string,
  ): Promise<void> {
    await this.#serializePartition(async () => {
      const session = await this.#sessionFor(ws);
      if (session === undefined) return;
      if (typeof message === 'string') {
        await session.handleMessage(message);
      } else {
        // §8.7: tagged binary — sync-round request chunks / acks.
        await session.handleBinary(new Uint8Array(message));
      }
    });
  }

  /** Hibernation callback: the socket closed. */
  async webSocketClose(ws: WebSocketLike): Promise<void> {
    const session = this.#sessions.get(ws);
    if (session !== undefined) {
      session.close();
      this.#sessions.delete(ws);
    }
    this.#swallowHello.delete(ws);
  }

  /** Hibernation callback: a socket error — treat as a close. */
  async webSocketError(ws: WebSocketLike): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Test/introspection: the number of live sessions on this DO. */
  get sessionCount(): number {
    return this.#sessions.size;
  }
}

// -- Platform helpers -------------------------------------------------------

/**
 * `WebSocketPair` is a runtime global on `workerd`. We reference it through a
 * lazily-resolved binding so this module imports cleanly under Bun/Node for
 * the hermetic tests (which inject a double via `setWebSocketPair`).
 */
let WebSocketPairImpl: (new () => WebSocketPairLike) | undefined;

/** Construct a `WebSocketPair`: the injected double in tests, else the
 * `workerd` global. */
function newWebSocketPair(): WebSocketPairLike {
  const impl =
    WebSocketPairImpl ??
    (globalThis as { WebSocketPair?: new () => WebSocketPairLike })
      .WebSocketPair;
  if (impl === undefined) {
    throw new Error(
      'WebSocketPair is not available; on workerd it is a global, in tests inject one with setWebSocketPair()',
    );
  }
  return new impl();
}

/** Inject a `WebSocketPair` implementation (hermetic tests). */
export function setWebSocketPair(
  impl: (new () => WebSocketPairLike) | undefined,
): void {
  WebSocketPairImpl = impl;
}

/** Send a session frame over a socket, normalizing `Uint8Array` → the
 * `ArrayBuffer` the WS API wants (a view over a shared buffer is copied so a
 * later mutation of the source cannot corrupt an in-flight frame). */
function sendOverSocket(ws: WebSocketLike, data: string | Uint8Array): void {
  if (typeof data === 'string') {
    ws.send(data);
    return;
  }
  // Copy into a fresh (non-shared) ArrayBuffer so a later mutation of the
  // source cannot corrupt an in-flight frame.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  ws.send(copy.buffer);
}

/** A `hello` control frame (text JSON) — used by the rehydration swallow. */
function isHello(data: string | Uint8Array): boolean {
  if (typeof data !== 'string') return false;
  try {
    return (JSON.parse(data) as { event?: unknown }).event === 'hello';
  } catch {
    return false;
  }
}

const REALTIME_ID_HEADER = {
  partition: 'x-syncular-partition',
  actorId: 'x-syncular-actor',
  clientId: 'x-syncular-client',
} as const;

export function writeRequestIdentityHeaders(
  headers: Headers,
  identity: { readonly partition: string; readonly actorId: string },
): void {
  headers.set(REALTIME_ID_HEADER.partition, identity.partition);
  headers.set(REALTIME_ID_HEADER.actorId, identity.actorId);
}

/** Write the resolved identity onto an upgrade request's headers (Worker side). */
export function writeIdentityHeaders(
  headers: Headers,
  identity: RealtimeUpgradeIdentity,
): void {
  headers.set(REALTIME_ID_HEADER.partition, identity.partition);
  headers.set(REALTIME_ID_HEADER.actorId, identity.actorId);
  headers.set(REALTIME_ID_HEADER.clientId, identity.clientId);
}

function readIdentityHeaders(
  request: Request,
): RealtimeUpgradeIdentity | undefined {
  const partition = request.headers.get(REALTIME_ID_HEADER.partition);
  const actorId = request.headers.get(REALTIME_ID_HEADER.actorId);
  const clientId = request.headers.get(REALTIME_ID_HEADER.clientId);
  if (
    partition === null ||
    partition === '' ||
    actorId === null ||
    clientId === null ||
    clientId === ''
  ) {
    return undefined;
  }
  return { partition, actorId, clientId };
}

function readRequestIdentityHeaders(
  request: Request,
): { readonly partition: string; readonly actorId: string } | undefined {
  const partition = request.headers.get(REALTIME_ID_HEADER.partition);
  const actorId = request.headers.get(REALTIME_ID_HEADER.actorId);
  if (
    partition === null ||
    partition === '' ||
    actorId === null ||
    actorId === ''
  ) {
    return undefined;
  }
  return { partition, actorId };
}

// -- Minimal ambient types (structural; not the real workers-types) ---------

/** The D1 binding, re-declared structurally (see `d1-storage.ts`). */
export type D1Database = ConstructorParameters<typeof D1ServerStorage>[0];
