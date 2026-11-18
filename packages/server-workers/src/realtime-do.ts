/**
 * `SyncularRealtimeDO` — the Cloudflare Durable Object realtime host (§8, the
 * second binding of §1.1). The deferred half of
 * the Workers deployment matrix, now built.
 *
 * ## The shape
 *
 * One DO instance hosts **one `RealtimeHub`** and serves **one partition**
 * (the DO id is `idFromName(partition)`, see `realtimeStubFor`). A
 * partition's writing rounds, socket rounds, and commit fan-out live behind
 * its explicit FIFO — the per-partition serialization point D1 requires. An
 * HTTP round without `PUSH_COMMIT` frames runs beside it. Because
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
 *   - **Before any entry point proceeds after a wake** (a socket frame or
 *     close, an HTTP sync round including a pull-only one, an upgrade, a
 *     command, an admin request), every accepted socket has a serialized
 *     attachment (`ws.serializeAttachment`: its identity, written at accept
 *     time, and its presence documents, rewritten on every change) but no
 *     live session. The host rebuilds the
 *     session of every socket in `getWebSockets()` once, through one promise
 *     every entry point awaits, so no commit fans out to a partly rebuilt hub
 *     and sockets that stayed quiet through the hibernation keep receiving
 *     deltas. `hub.restore(...)` reloads each registration list from the
 *     client record (the §8.1 load-at-upgrade rule), touches the partition
 *     and reads its latest sequence once, and sends no `hello`: the client
 *     was greeted at the real upgrade. Cursor/registration are the durable
 *     truth in storage; nothing in-flight is lost because nothing in-flight
 *     can be hibernated.
 *
 * The attachment holds what storage cannot: the identity `restore` needs and
 * the connection's §8.6 presence documents, which `restore` seeds silently so
 * a close after a wake still sends `leave` and a new socket still receives
 * the snapshot. Everything else (`cursor`, `registrations`, `lastKnownSeq`)
 * is re-derived from storage, which is authoritative.
 *
 * The attachment is one `Uint8Array`, so its structured-clone size is its
 * byte length plus fixed framing: the identity as UTF-8 JSON (`[partition,
 * actorId, clientId]`, plus the authentication context as a fourth element
 * when the upgrade had one) and a newline,
 * then per presence key a varint key length, the key's UTF-8 bytes, the
 * document's UTF-8 JSON and a newline (a JSON text holds no raw newline).
 * Each key costs at least 3 counted bytes (a non-empty key and `{}`) and at
 * most 2 framing bytes below 128 key bytes, so a connection within
 * `maxPresenceBytes` needs at most `cap + floor(2 * cap / 3)` presence
 * bytes. The hub refuses a cap whose worst case leaves no room for an empty
 * identity, and the upgrade refuses an identity that does not fit beside the
 * worst case, so no presence change can overflow the attachment.
 *
 * ## Heartbeats (§8.5)
 *
 * The host arms the Durable Object alarm when a socket connects. `alarm()`
 * sends `heartbeat` straight to every hibernatable socket, without rebuilding
 * sessions, and re-arms while sockets remain. The host owns the alarm: a
 * subclass that needs another alarm schedule cannot share it.
 *
 * ## Fanout between objects (§8.9)
 *
 * Ordinary HTTP `/sync` and `/operations` (with `RealtimeDOConfig.operations`)
 * are forwarded into this DO and fan out in-process. A commit applied
 * elsewhere reaches the partition's object through
 * `durableObjectRealtimeNotifier`: a POST to the fanout path carrying the
 * commit, which the object delivers to its hub as a delta.
 *
 * On PostgreSQL the Worker may shard sockets over several objects
 * (`WorkersRealtimeOptions.shard`) and run every round itself. The
 * partition's object (`idFromName(partition)`) then holds no socket: it keeps
 * the names of the shard objects that registered with it in its storage and
 * relays every fanout message to each of them. A shard registers when it
 * accepts a socket, before its hub connects it; a shard that answers a relay with 404 (no socket
 * left) is removed unless it registered again meanwhile. A shard's hub
 * (`RealtimeHubConfig.fanout`) sends the commits of its own rounds through the
 * partition's object too, so every shard, the shard itself included, receives
 * each commit once. A host scope refresh (`refreshScopes` on the notifier)
 * and a host announcement (`announceScopes`) take the same path. A relay that fails leaves a record of what the shard
 * owes in the partition object's storage, and the alarm retries it every
 * second until the shard answers or is removed.
 */
import {
  adapterSyncError,
  composeEvents,
  createRealtimeHub,
  D1ServerStorage,
  decodeRequestBody,
  encodeHeartbeat,
  errorBody,
  eraseScopeValue,
  type EraseScopeValueOptions,
  type EraseScopeValueResult,
  handleRemoteOperation,
  handleSyncRequest,
  pruneCommitLog,
  type PruneOptions,
  type RealtimeConnectOptions,
  type RealtimeHub,
  type RealtimeHubConfig,
  type RealtimeSession,
  type RemoteOperationRegistry,
  type RemoteOperationResolver,
  RingBufferEvents,
  type RealtimeNotifier,
  type ServerStorage,
  SSP2_CONTENT_TYPE,
  type StoredCommit,
  SyncError,
  type SyncularServerEvents,
  emitEvent,
  SyncularAdmin,
  type SyncularErrorRoute,
  type SyncRequestContext,
} from '@syncular/server';
import { createSyncularAdminRoutes } from '@syncular/server-hono';
import { decodeRequest } from '@syncular/core';

// -- The Durable Object platform surface this class uses (structural) -------
// Declared locally so the package takes no `@cloudflare/workers-types`
// dependency; the real bindings are structurally compatible. This is the
// same posture `d1-storage.ts` takes for the D1 API.

export interface DurableObjectStateLike {
  acceptWebSocket(ws: WebSocketLike, tags?: string[]): void;
  /** Keeps work alive after a response: the notifier's retries (§8.9). */
  waitUntil(promise: Promise<unknown>): void;
  getWebSockets(tag?: string): WebSocketLike[];
  /** The DO storage API the host uses: the alarm drives §8.5 heartbeats, and
   * the partition's object keeps its registered shards as keys. */
  readonly storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    get(key: string): Promise<unknown>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
  };
}

/** A DO stub: the callable handle to one Durable Object instance. */
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
 * A storage the host coordinates: any `ServerStorage` with an idempotent
 * `migrate()`, which the host runs before prune, erase and admin actions.
 * `D1ServerStorage` and `PostgresServerStorage` qualify.
 */
export type RealtimeHostStorage = ServerStorage & {
  migrate(): Promise<void>;
};

/**
 * The config of a `SyncularRealtimeHost`. `S` is the storage the host
 * coordinates: `D1ServerStorage` when the host is built from a D1 binding,
 * otherwise the storage passed to the constructor.
 */
export type RealtimeDOConfig<S extends RealtimeHostStorage = D1ServerStorage> =
  (
    | {
        /**
         * Preferred: build the complete canonical sync config around the DO's
         * coordinated storage. Reuse this factory for the outer HTTP adapter
         * so HTTP-forwarded and socket rounds cannot drift by capability.
         */
        syncConfig(storage: S): RealtimeHubConfig;
        readonly hubConfig?: never;
      }
    | {
        /**
         * @deprecated Use `syncConfig`. This compatibility shape predates the
         * canonical HTTP/realtime capability contract.
         */
        hubConfig(storage: S): RealtimeHubConfigInput;
        readonly syncConfig?: never;
      }
  ) & {
    /**
     * Events the admin console keeps for this partition; default 1000. The DO
     * composes its event ring into the sync config's `events` and serves the
     * admin routes the Worker forwards (`WorkersFetchHandlerOptions.admin`),
     * so the event tail, metrics, failures and client drill-down see this
     * partition's rounds.
     */
    readonly adminRingCapacity?: number;
    /**
     * §8.5 heartbeat interval in ms; default 30000. The host sends `heartbeat`
     * to every socket from the Durable Object alarm, which stays armed while
     * sockets are connected.
     */
    readonly heartbeatIntervalMs?: number;
    /**
     * Registered remote queries and commands (REMOTE.md). The Worker forwards
     * `POST <mount>/operations` here, so a command applies on the partition
     * FIFO and fans out to the partition's sockets like a pushed commit. A
     * `RemoteOperationResolver` chooses the registry, the commit actor, and
     * the scope resolver per request (REMOTE.md §5.1).
     */
    readonly operations?: RemoteOperationRegistry | RemoteOperationResolver;
    /**
     * The namespace this class is bound to. Required when the Worker shards
     * sockets (`WorkersRealtimeOptions.shard`, §8.9): a shard registers with
     * the partition's object through it, the partition's object relays every
     * commit to the registered shards, and a shard's own rounds send their
     * commits through the partition's object. The storage must lock
     * partitions in the database (PostgreSQL); a D1 host refuses it.
     */
    readonly namespace?: DurableObjectNamespaceLike;
  };

/**
 * The subset of `RealtimeHubConfig` the DO host supplies (storage is wired by
 * the DO, so it is omitted here).
 */
export type RealtimeHubConfigInput = Omit<RealtimeHubConfig, 'storage'>;

/**
 * Cloudflare's cap on a socket attachment's serialized size
 * (https://developers.cloudflare.com/durable-objects/api/websockets/,
 * `serializeAttachment`).
 */
const ATTACHMENT_LIMIT_BYTES = 16_384;
/** Room for the structured-clone framing around the attachment's one
 * `Uint8Array`: format header, buffer and view tags, length varints. */
const ATTACHMENT_FRAMING_BYTES = 64;

/** `maxPresenceBytes` leaves no room in a socket attachment for an empty
 * identity beside a full presence budget (§8.6.1). */
export class PresenceAttachmentError extends Error {
  readonly code = 'realtime.presence_exceeds_attachment';

  constructor(
    readonly details: {
      readonly maxPresenceBytes: number;
      readonly attachmentLimitBytes: number;
    },
  ) {
    super('maxPresenceBytes does not fit a socket attachment (§8.6.1)');
    this.name = 'PresenceAttachmentError';
  }
}

/** A hibernatable socket's attachment bytes (layout: see the module doc). */
function encodeAttachment(
  identity: RealtimeUpgradeIdentity,
  presence: ReadonlyMap<string, string>,
): Uint8Array {
  const utf8 = new TextEncoder();
  const bytes = [
    ...utf8.encode(
      JSON.stringify([
        identity.partition,
        identity.actorId,
        identity.clientId,
        ...(identity.context !== undefined ? [identity.context] : []),
      ]),
    ),
    0x0a,
  ];
  for (const [scopeKey, json] of presence) {
    const key = utf8.encode(scopeKey);
    let length = key.length;
    for (; length >= 0x80; length >>>= 7) bytes.push((length & 0x7f) | 0x80);
    bytes.push(length, ...key, ...utf8.encode(json), 0x0a);
  }
  return Uint8Array.from(bytes);
}

/**
 * §8.9: what a shard missed when a relay to it failed, delivered from the
 * partition object's alarm: the highest commit sequence (sessions behind it get
 * a `catchup-required` wake), a fail-closed refresh of every session's scopes,
 * changed registrations (a wake, whose round reloads them), and the actors of
 * missed announcements (a `scopes` event, §8.7).
 */
interface Owed {
  readonly commitSeq?: number;
  readonly refresh?: true;
  readonly registrations?: true;
  readonly announce?: readonly string[];
}

/** A message between objects (§8.9): a commit, a client's changed
 * registrations, a host refresh of scopes, a host announcement, or what a
 * failed relay owes. */
type FanoutMessage =
  | { readonly partition: string; readonly commit: StoredCommit }
  | { readonly partition: string; readonly clientId: string }
  | {
      readonly partition: string;
      readonly refresh: { readonly actorId?: string };
    }
  | { readonly partition: string; readonly announce: readonly string[] }
  | { readonly partition: string; readonly owed: Owed };

/**
 * Fanout body: a u32 length, the message as UTF-8 JSON with each change
 * payload replaced by its byte length, then the payloads in change order.
 */
function encodeFanout(message: FanoutMessage): Uint8Array<ArrayBuffer> {
  const payloads: Uint8Array[] = [];
  const head = new TextEncoder().encode(
    JSON.stringify(
      'commit' in message
        ? {
            ...message,
            commit: {
              ...message.commit,
              changes: message.commit.changes.map(({ payload, ...change }) => {
                if (payload === undefined) return change;
                payloads.push(payload);
                return { ...change, payloadBytes: payload.byteLength };
              }),
            },
          }
        : message,
    ),
  );
  const bytes = new Uint8Array(
    payloads.reduce((total, p) => total + p.byteLength, 4 + head.byteLength),
  );
  new DataView(bytes.buffer).setUint32(0, head.byteLength);
  bytes.set(head, 4);
  let at = 4 + head.byteLength;
  for (const payload of payloads) {
    bytes.set(payload, at);
    at += payload.byteLength;
  }
  return bytes;
}

function decodeFanout(bytes: Uint8Array): FanoutMessage {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const message = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + length)),
  ) as
    | {
        readonly partition: string;
        readonly commit: Omit<StoredCommit, 'changes'> & {
          readonly changes: readonly (Omit<
            StoredCommit['changes'][number],
            'payload'
          > & { readonly payloadBytes?: number })[];
        };
      }
    | Exclude<FanoutMessage, { readonly commit: StoredCommit }>;
  if (!('commit' in message)) return message;
  let at = 4 + length;
  return {
    partition: message.partition,
    commit: {
      ...message.commit,
      changes: message.commit.changes.map(({ payloadBytes, ...change }) =>
        payloadBytes === undefined
          ? change
          : { ...change, payload: bytes.slice(at, (at += payloadBytes)) },
      ),
    },
  };
}

/** Options of `durableObjectRealtimeNotifier`. */
export interface DurableObjectRealtimeNotifierOptions {
  /**
   * Keeps the retries of a failed request alive after the response: the
   * Worker's `ctx.waitUntil`, or the Durable Object state's.
   */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Receives `realtime.relay_failed` when the retries give up. */
  readonly events?: SyncularServerEvents;
  /**
   * Resolves when retry `attempt` (1 to 3) may start. Default: after 250 ms,
   * 1 s and 4 s.
   */
  readonly retryDelay?: (attempt: number) => Promise<void>;
}

/**
 * The `RealtimeNotifier` (§8.2, §8.9) that sends a commit, or a client's
 * changed registrations, to the partition's Durable Object, which delivers it
 * to its own sockets and relays it to every shard registered with it, retrying
 * a shard whose relay failed. Pass it as the Worker config's `realtime`
 * whenever the Worker applies commits itself: sharded sockets, or an external
 * command host. A failed request to the partition's object never fails the
 * push, whose commit is durable: the notifier retries it three times in
 * `waitUntil` and emits `realtime.relay_failed` when the last one fails.
 *
 * `refreshScopes(partition, actorId?)` is `RealtimeHub.refreshScopes` for
 * every object of the partition: call it after a grant changes. It throws when
 * the partition's object did not take the refresh.
 *
 * `announceScopes(partition, actorIds)` is `RealtimeHub.announceScopes` for
 * every object of the partition: call it after a grant widened. It throws when
 * the partition's object did not take the announcement.
 */
export function durableObjectRealtimeNotifier(
  namespace: DurableObjectNamespaceLike,
  options: DurableObjectRealtimeNotifierOptions,
): RealtimeNotifier & {
  refreshScopes(partition: string, actorId?: string): Promise<void>;
  announceScopes(partition: string, actorIds: readonly string[]): Promise<void>;
} {
  // A synthetic origin: the DO reads only the path and the body. The partition
  // object answers 204, or 404 when no object of the partition holds a socket.
  const send = async (
    message: FanoutMessage,
    body = encodeFanout(message),
  ): Promise<number> => {
    try {
      const response = await namespace
        .get(namespace.idFromName(message.partition))
        .fetch(
          new Request(`https://do${REALTIME_DO_FANOUT_PATH}`, {
            method: 'POST',
            body,
          }),
        );
      return response.status;
    } catch {
      return 0;
    }
  };
  const deliver = async (message: FanoutMessage): Promise<void> => {
    const body = encodeFanout(message);
    const status = await send(message, body);
    if (status === 204 || status === 404) return;
    options.waitUntil(
      (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await (options.retryDelay?.(attempt) ??
            new Promise((resolve) =>
              setTimeout(resolve, 250 * 4 ** (attempt - 1)),
            ));
          const retried = await send(message, body);
          if (retried === 204 || retried === 404) return;
        }
        if (options.events !== undefined) {
          emitEvent(options.events, {
            type: 'realtime.relay_failed',
            atMs: Date.now(),
            partition: message.partition,
            ...('commit' in message
              ? { commitSeq: message.commit.commitSeq }
              : {}),
            attempts: 4,
          });
        }
      })(),
    );
  };
  return {
    notifyCommit: (partition, commit) => deliver({ partition, commit }),
    notifySubscriptions: (partition, clientId) =>
      deliver({ partition, clientId }),
    async refreshScopes(partition, actorId) {
      const status = await send({
        partition,
        refresh: actorId === undefined ? {} : { actorId },
      });
      if (status !== 204 && status !== 404) {
        throw new SyncError(
          'sync.internal_error',
          'realtime scope refresh failed',
          JSON.stringify({ status }),
        );
      }
    },
    async announceScopes(partition, actorIds) {
      const status = await send({ partition, announce: actorIds });
      if (status !== 204 && status !== 404) {
        throw new SyncError(
          'sync.internal_error',
          'realtime scope announcement failed',
          JSON.stringify({ status }),
        );
      }
    },
  };
}

/** The identity the upgrade request must carry (resolved by the Worker). */
export interface RealtimeUpgradeIdentity {
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  /** The authentication context (§1.1) the connection resolves scopes under. */
  readonly context?: string;
}

/** Internal control-request paths on the DO stub (never client-facing). */
export const REALTIME_DO_FANOUT_PATH = '/__syncular_realtime/fanout';
export const REALTIME_DO_SHARDS_PATH = '/__syncular_realtime/shards';
export const REALTIME_DO_UPGRADE_PATH = '/__syncular_realtime/upgrade';
export const SYNC_DO_REQUEST_PATH = '/__syncular_realtime/sync';
export const OPERATIONS_DO_REQUEST_PATH = '/__syncular_realtime/operations';
/** The remote operation protocol content type (REMOTE.md §5). */
export const OPERATIONS_CONTENT_TYPE =
  'application/vnd.syncular.operations.v1+json';
/** Prefix of forwarded admin routes; the admin route path follows it. */
export const ADMIN_DO_PATH = '/__syncular_realtime/admin';

/**
 * §1.3: a forwarded round may carry a gzip body (`decodeRequestBody` accepts
 * it); any other declared `Content-Encoding` is refused with 415 instead of
 * being parsed as SSP2 bytes.
 */
function unsupportedEncoding(route: 'sync' | 'operations'): Response {
  const error = new SyncError(
    route === 'sync' ? 'sync.invalid_request' : 'operation.invalid_request',
    'unsupported content encoding',
  );
  return Response.json(errorBody(error), { status: 415 });
}

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
 *   #impl = new SyncularRealtimeHost(this.ctx, this.env.DB, config);
 *   fetch(req: Request) { return this.#impl.fetch(req); }
 *   webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
 *     return this.#impl.webSocketMessage(ws, msg);
 *   }
 *   webSocketClose(ws: WebSocket) { return this.#impl.webSocketClose(ws); }
 *   webSocketError(ws: WebSocket) { return this.#impl.webSocketError(ws); }
 *   alarm() { return this.#impl.alarm(); }
 * }
 * ```
 *
 * The reference host is `SyncularRealtimeHost` below; the tests drive it
 * directly over the DO double.
 */
export class SyncularRealtimeHost<
  S extends RealtimeHostStorage = D1ServerStorage,
> {
  readonly #state: DurableObjectStateLike;
  readonly #storage: RealtimeHostStorage;
  readonly #config: RealtimeDOConfig<RealtimeHostStorage>;
  #hub: RealtimeHub | undefined;
  /** Attachment bytes held back for framing and a full presence budget. */
  #presenceReserve = 0;
  #admin: SyncularAdmin | undefined;
  /** Live sessions, keyed by their socket. Empty after a hibernation wake;
   * rehydrated for every socket before any entry point proceeds (see the
   * class doc). */
  readonly #sessions = new Map<WebSocketLike, RealtimeSession>();
  readonly #closedSockets = new WeakSet<WebSocketLike>();
  /** This instance's one rebuild of hibernated sockets' sessions. Every entry
   * point awaits it, so no commit fans out to a partly rebuilt hub. */
  #rehydration: Promise<void> | undefined;
  /** Explicit FIFO: Durable Object events may interleave at `await`. */
  #partitionTail: Promise<void> = Promise.resolve();
  /** The shard name this instance registered with the partition's object. */
  #registeredShard: string | undefined;

  /**
   * Host a partition over a D1 binding (the host builds the coordinated
   * `D1ServerStorage`) or over a storage the caller built, such as a
   * `PostgresServerStorage` behind Hyperdrive. The host owns the storage's
   * serialization: every HTTP and socket round enters the partition FIFO
   * before the storage is used.
   */
  constructor(
    state: DurableObjectStateLike,
    db: D1Database,
    config: RealtimeDOConfig<D1ServerStorage>,
  );
  constructor(
    state: DurableObjectStateLike,
    storage: S,
    config: RealtimeDOConfig<S>,
  );
  constructor(
    state: DurableObjectStateLike,
    storage: D1Database | S,
    config: RealtimeDOConfig<D1ServerStorage> | RealtimeDOConfig<S>,
  ) {
    this.#state = state;
    if (config.namespace !== undefined && 'prepare' in storage) {
      throw new Error(
        'RealtimeDOConfig.namespace needs a storage that locks partitions in the database; D1 pushes need the partition FIFO',
      );
    }
    this.#storage =
      'prepare' in storage
        ? // One DO is selected per partition, and every round enters
          // #serializePartition before this storage is used.
          new D1ServerStorage(storage, { pushApplySerialized: true })
        : storage;
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
      const ring = new RingBufferEvents(
        this.#config.adminRingCapacity !== undefined
          ? { capacity: this.#config.adminRingCapacity }
          : undefined,
      );
      const withRing = {
        ...config,
        events:
          config.events !== undefined
            ? composeEvents(ring, config.events)
            : ring,
      };
      if (this.#config.namespace !== undefined) {
        withRing.fanout = durableObjectRealtimeNotifier(
          this.#config.namespace,
          {
            waitUntil: (promise) => this.#state.waitUntil(promise),
            events: withRing.events,
          },
        );
      }
      const hub = createRealtimeHub(withRing);
      const cap = hub.maxPresenceBytes;
      this.#presenceReserve =
        ATTACHMENT_FRAMING_BYTES + cap + Math.floor((2 * cap) / 3);
      if (
        this.#presenceReserve +
          encodeAttachment(
            { partition: '', actorId: '', clientId: '' },
            new Map(),
          ).byteLength >
        ATTACHMENT_LIMIT_BYTES
      ) {
        throw new PresenceAttachmentError({
          maxPresenceBytes: cap,
          attachmentLimitBytes: ATTACHMENT_LIMIT_BYTES,
        });
      }
      this.#hub = hub;
      this.#admin = SyncularAdmin.fromConfig(
        { ...withRing, realtime: hub },
        { ring },
      );
    }
    return this.#hub;
  }

  /**
   * The DO `fetch` handler: routes the internal control paths. The Worker
   * forwards `GET <mount>/realtime` here as an upgrade with the resolved
   * identity in headers (see `forwardRealtimeUpgrade` in `index.ts`), and
   * commits applied elsewhere arrive at the fanout path (§8.9).
   */
  async fetch(request: Request): Promise<Response> {
    await this.#rehydrateSockets();
    const url = new URL(request.url);
    if (url.pathname === SYNC_DO_REQUEST_PATH) {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await decodeRequestBody(
          request,
          this.#getHub().limits.maxRequestBytes,
        );
      } catch (error) {
        const sync = this.#syncError(error, 'sync');
        return Response.json(errorBody(sync), { status: sync.httpStatus });
      }
      if (bytes === undefined) return unsupportedEncoding('sync');
      // A round without PUSH_COMMIT frames writes only its own client
      // record, so it runs beside the FIFO instead of queueing behind every
      // other client's round. An undecodable request takes the FIFO and
      // fails in the handler.
      let pullOnly = false;
      try {
        pullOnly = decodeRequest(bytes).frames.every(
          (frame) => frame.type !== 'PUSH_COMMIT',
        );
      } catch {}
      if (pullOnly) return this.#handleSync(request, bytes);
      return this.#serializePartition(() => this.#handleSync(request, bytes));
    }
    if (url.pathname === OPERATIONS_DO_REQUEST_PATH) {
      return this.#serializePartition(() => this.#handleOperation(request));
    }
    if (url.pathname === REALTIME_DO_FANOUT_PATH) {
      // Beside the FIFO: a round that applied this commit may be waiting on
      // the relay that delivers it here.
      return this.#handleFanout(request);
    }
    if (url.pathname === REALTIME_DO_SHARDS_PATH) {
      const { shard, token } = (await request.json()) as {
        shard: string;
        token: string;
      };
      await this.#state.storage.put(`shard:${shard}`, token);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === REALTIME_DO_UPGRADE_PATH) {
      return this.#handleUpgrade(request);
    }
    if (url.pathname.startsWith(`${ADMIN_DO_PATH}/`)) {
      return this.#handleAdmin(request, url);
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * Run host work on the partition FIFO, after the sessions of hibernated
   * sockets are rebuilt: a server-side command, a reaction drain, an import.
   * `contextFor` returns the sync context of the hub for an actor; a commit
   * made through it (`handleRemoteOperation`, `eraseScopeValue`, a push)
   * reaches the matching sockets as a delta, so the host needs no wake.
   */
  serialized<T>(
    work: (
      contextFor: (identity: {
        readonly partition: string;
        readonly actorId: string;
        readonly context?: string;
      }) => SyncRequestContext,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#serializePartition(() =>
      work((identity) => this.#getHub().requestContextFor(identity)),
    );
  }

  /** Trusted maintenance shares the partition FIFO with HTTP/socket writes. */
  pruneCommitLog(options: Omit<PruneOptions, 'storage'>): Promise<number> {
    return this.#serializePartition(async () => {
      await this.#storage.migrate();
      return pruneCommitLog({ ...options, storage: this.#storage });
    });
  }

  /**
   * §4.6.1 scope-value erasure on the partition FIFO: one budgeted step per
   * call, its delete commit fanned out to connected sockets.
   */
  eraseScopeValue(
    options: EraseScopeValueOptions,
  ): Promise<EraseScopeValueResult> {
    return this.#serializePartition(async () => {
      await this.#storage.migrate();
      return eraseScopeValue(
        this.#getHub().requestContextFor({
          partition: options.partition,
          actorId: options.actorId ?? 'syncular.erase',
        }),
        options,
      );
    });
  }

  #serializePartition<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.#rehydrateSockets();
      return operation();
    };
    const result = this.#partitionTail.then(run, run);
    this.#partitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * After a hibernation wake the session map is empty while sockets stay
   * open. Rebuild every socket's session once, so a commit fans out to sockets
   * that stayed quiet through the hibernation. A socket whose session cannot
   * be rebuilt is closed; its client reconnects and catches up (§8.4).
   */
  #rehydrateSockets(): Promise<void> {
    this.#rehydration ??= (async () => {
      const sockets = this.#state.getWebSockets().flatMap((ws) => {
        const bytes = ws.deserializeAttachment();
        if (!(bytes instanceof Uint8Array)) return [];
        const utf8 = new TextDecoder();
        let end = bytes.indexOf(0x0a);
        const [partition, actorId, clientId, context] = JSON.parse(
          utf8.decode(bytes.subarray(0, end)),
        ) as [string, string, string, string?];
        const presence = new Map<string, string>();
        for (let at = end + 1; at < bytes.length; at = end + 1) {
          let length = 0;
          for (let shift = 0; ; shift += 7) {
            const byte = bytes[at++]!;
            length |= (byte & 0x7f) << shift;
            if (byte < 0x80) break;
          }
          end = bytes.indexOf(0x0a, at + length);
          presence.set(
            utf8.decode(bytes.subarray(at, at + length)),
            utf8.decode(bytes.subarray(at + length, end)),
          );
        }
        const identity: RealtimeUpgradeIdentity = {
          partition,
          actorId,
          clientId,
          ...(context !== undefined ? { context } : {}),
        };
        return [{ ws, identity, presence }];
      });
      if (sockets.length === 0) return;
      const results = await this.#getHub().restore(
        sockets.map(({ ws, identity, presence }) => ({
          ...this.#connectOptions(ws, identity),
          presence,
        })),
      );
      for (const [i, result] of results.entries()) {
        const ws = sockets[i]!.ws;
        if (result.status === 'rejected') {
          ws.close(1011, 'realtime rehydration failed');
          this.#syncError(result.reason, 'realtime');
        } else if (this.#closedSockets.has(ws)) {
          result.value.close();
        } else {
          this.#sessions.set(ws, result.value);
        }
      }
    })();
    return this.#rehydration;
  }

  /**
   * Map a host failure to its catalog error. The reporters are read inside
   * the callbacks so a failing accessor stays inside `adapterSyncError`.
   */
  #syncError(error: unknown, route: SyncularErrorRoute): SyncError {
    return adapterSyncError(
      error,
      (error, context) => this.#getHub().onError?.(error, context),
      route,
      (error, context) => this.#getHub().mapError?.(error, context),
    );
  }

  async #handleOperation(request: Request): Promise<Response> {
    const contentType = request.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim();
    if (contentType !== OPERATIONS_CONTENT_TYPE) {
      const error = new SyncError('operation.invalid_request');
      return Response.json(errorBody(error), { status: 415 });
    }
    const registry = this.#config.operations;
    if (registry === undefined) {
      const error = new SyncError('operation.unknown');
      return Response.json(errorBody(error), { status: error.httpStatus });
    }
    const identity = readRequestIdentityHeaders(request);
    if (identity === undefined) {
      const error = new SyncError('sync.auth_required');
      return Response.json(errorBody(error), { status: error.httpStatus });
    }
    try {
      const bytes = await decodeRequestBody(
        request,
        this.#getHub().limits.maxRequestBytes,
      );
      if (bytes === undefined) return unsupportedEncoding('operations');
      const out = await handleRemoteOperation(
        bytes,
        this.#getHub().requestContextFor(identity),
        registry,
      );
      return new Response(out.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': OPERATIONS_CONTENT_TYPE },
      });
    } catch (error) {
      const sync = this.#syncError(error, 'operations');
      return Response.json(errorBody(sync), { status: sync.httpStatus });
    }
  }

  async #handleSync(request: Request, bytes: Uint8Array): Promise<Response> {
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
      const out = await handleSyncRequest(
        bytes,
        this.#getHub().requestContextFor(identity),
      );
      return new Response(out.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': SSP2_CONTENT_TYPE },
      });
    } catch (error) {
      const sync = this.#syncError(error, 'sync');
      return Response.json(errorBody(sync), { status: sync.httpStatus });
    }
  }

  /**
   * A Worker-authorized admin request: the Worker ran the host guards and
   * names the partition and whether actions are granted in headers.
   * Actions share the partition FIFO with sync rounds.
   */
  async #handleAdmin(request: Request, url: URL): Promise<Response> {
    const hub = this.#getHub();
    const partition = request.headers.get(REALTIME_ID_HEADER.partition);
    if (this.#admin === undefined || partition === null || partition === '') {
      const error = new SyncError(
        'sync.invalid_request',
        'forwarded admin request names no partition',
      );
      return Response.json(errorBody(error), { status: error.httpStatus });
    }
    const routes = createSyncularAdminRoutes(this.#admin, {
      authorize: () => true,
      ...(request.headers.get(ADMIN_ACTIONS_HEADER) === '1'
        ? { authorizeActions: () => true }
        : {}),
      ...(hub.onError !== undefined ? { onError: hub.onError } : {}),
      ...(hub.mapError !== undefined ? { mapError: hub.mapError } : {}),
    });
    url.pathname = url.pathname.slice(ADMIN_DO_PATH.length);
    url.searchParams.set('partition', partition);
    const routed = new Request(url, request);
    if (request.method !== 'POST') return routes.fetch(routed);
    return this.#serializePartition(async () => {
      await this.#storage.migrate();
      return routes.fetch(routed);
    });
  }

  /**
   * §8.9: deliver a message to this object's sockets, then relay it to every
   * shard registered here. A relay that fails (a thrown request, any status
   * but 2xx and 404) leaves the shard owing what the message carried, and the
   * alarm retries it. This object answers 404 when it holds no socket and no
   * shard.
   */
  async #handleFanout(request: Request): Promise<Response> {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const message = decodeFanout(bytes);
    const hub = this.#getHub();
    if ('commit' in message) {
      await hub.notifyCommit(message.partition, message.commit);
    } else if ('clientId' in message) {
      await hub.notifySubscriptions(message.partition, message.clientId);
    } else if ('refresh' in message) {
      await hub.refreshScopes(message.partition, message.refresh.actorId);
    } else if ('announce' in message) {
      hub.announceScopes(message.partition, message.announce);
    } else {
      if (message.owed.refresh) await hub.refreshScopes(message.partition);
      if (message.owed.announce !== undefined) {
        hub.announceScopes(message.partition, message.owed.announce);
      }
      if (message.owed.registrations) {
        hub.wake(message.partition, 'catchup-required');
      }
      if (message.owed.commitSeq !== undefined) {
        hub.wakeBehind(message.partition, message.owed.commitSeq);
      }
    }
    const shards = await this.#state.storage.list({ prefix: 'shard:' });
    const owes: Owed =
      'commit' in message
        ? { commitSeq: message.commit.commitSeq }
        : 'clientId' in message
          ? { registrations: true }
          : 'refresh' in message
            ? { refresh: true }
            : 'announce' in message
              ? { announce: message.announce }
              : message.owed;
    await Promise.all(
      [...shards].map(async ([key, token]) => {
        const shard = key.slice('shard:'.length);
        const status = await this.#relay(shard, token, bytes);
        if (status !== 'failed') return;
        const stored = await this.#state.storage.get(`owed:${shard}`);
        const before =
          typeof stored === 'string'
            ? (JSON.parse(stored) as { readonly owed: Owed }).owed
            : {};
        const commitSeq = Math.max(
          before.commitSeq ?? -1,
          owes.commitSeq ?? -1,
        );
        const announce = new Set([
          ...(before.announce ?? []),
          ...(owes.announce ?? []),
        ]);
        const owed: Owed = {
          ...(commitSeq >= 0 ? { commitSeq } : {}),
          ...(announce.size > 0 ? { announce: [...announce] } : {}),
          ...(before.refresh || owes.refresh ? { refresh: true } : {}),
          ...(before.registrations || owes.registrations
            ? { registrations: true }
            : {}),
        };
        await this.#state.storage.put(
          `owed:${shard}`,
          JSON.stringify({ partition: message.partition, owed }),
        );
        const at = await this.#state.storage.getAlarm();
        if (at === null || at > Date.now() + 1_000) {
          await this.#state.storage.setAlarm(Date.now() + 1_000);
        }
      }),
    );
    if (this.#state.getWebSockets().length > 0 || shards.size > 0) {
      return new Response(null, { status: 204 });
    }
    this.#registeredShard = undefined;
    return new Response(null, { status: 404 });
  }

  /**
   * Send a fanout body to a registered shard. A shard that answers 404 holds
   * no socket: it is removed with what it owes, unless it registered again
   * with a new token meanwhile.
   */
  async #relay(
    shard: string,
    token: unknown,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<'delivered' | 'gone' | 'failed'> {
    const namespace = this.#config.namespace;
    if (namespace === undefined) {
      throw new Error('a registered shard needs RealtimeDOConfig.namespace');
    }
    let status = 0;
    try {
      const response = await namespace.get(namespace.idFromName(shard)).fetch(
        new Request(`https://do${REALTIME_DO_FANOUT_PATH}`, {
          method: 'POST',
          body,
        }),
      );
      status = response.status;
    } catch {
      return 'failed';
    }
    if (status === 404) {
      if ((await this.#state.storage.get(`shard:${shard}`)) === token) {
        await this.#state.storage.delete(`shard:${shard}`);
        await this.#state.storage.delete(`owed:${shard}`);
      }
      return 'gone';
    }
    return status >= 200 && status < 300 ? 'delivered' : 'failed';
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
    // Hand the server socket to the runtime for hibernation with the §8.1
    // identity `restore` needs to rehydrate.
    const attachment = encodeAttachment(identity, new Map());
    server.serializeAttachment(attachment);
    this.#state.acceptWebSocket(server);
    // Build the session now (first connect: hello IS delivered). Any failure
    // closes the socket loudly — never a half-open realtime connection.
    try {
      const hub = this.#getHub();
      // §8.6.1: the identity must fit the attachment beside a full presence
      // budget, so no later presence change can overflow it.
      if (
        this.#presenceReserve + attachment.byteLength >
        ATTACHMENT_LIMIT_BYTES
      ) {
        throw new SyncError(
          'sync.limit_exceeded',
          'realtime identity does not fit the socket attachment (§8.6.1)',
          JSON.stringify({
            limit: 'attachmentBytes',
            max: ATTACHMENT_LIMIT_BYTES,
          }),
        );
      }
      // §8.9: a shard registers with the partition's object after it accepts
      // the socket (so a relay meanwhile does not find it empty and drop it)
      // and before the hub reads the latest sequence, so a commit relayed
      // after that read reaches the session.
      const shard = request.headers.get(REALTIME_SHARD_HEADER);
      if (shard !== null && this.#registeredShard !== shard) {
        const namespace = this.#config.namespace;
        if (namespace === undefined) {
          throw new Error(
            'a sharded realtime upgrade needs RealtimeDOConfig.namespace',
          );
        }
        const registered = await namespace
          .get(namespace.idFromName(identity.partition))
          .fetch(
            new Request(new URL(REALTIME_DO_SHARDS_PATH, request.url), {
              method: 'POST',
              body: JSON.stringify({ shard, token: crypto.randomUUID() }),
            }),
          );
        if (registered.status !== 204) {
          throw new Error('shard registration failed');
        }
        this.#registeredShard = shard;
      }
      const session = await hub.connect(this.#connectOptions(server, identity));
      this.#sessions.set(server, session);
      if ((await this.#state.storage.getAlarm()) === null) {
        await this.#state.storage.setAlarm(
          Date.now() + (this.#config.heartbeatIntervalMs ?? 30_000),
        );
      }
    } catch (error) {
      this.#sessions.get(server)?.close();
      this.#sessions.delete(server);
      server.close(1011, 'realtime connect failed');
      const sync = this.#syncError(error, 'realtime');
      return Response.json(errorBody(sync), { status: sync.httpStatus });
    }
    // `webSocket` is a workerd-only ResponseInit field (the 101 upgrade
    // handshake); the standard lib type has no slot for it.
    const init = { status: 101, webSocket: client } as unknown as ResponseInit;
    return new Response(null, init);
  }

  /** The hub connect options of a hibernatable socket (§8.1). */
  #connectOptions(
    ws: WebSocketLike,
    identity: RealtimeUpgradeIdentity,
  ): RealtimeConnectOptions {
    return {
      partition: identity.partition,
      actorId: identity.actorId,
      clientId: identity.clientId,
      ...(identity.context !== undefined ? { context: identity.context } : {}),
      send: (data) => sendOverSocket(ws, data),
      closeSocket: () => ws.close(1008, 'protocol violation (§8.7)'),
      // §8.6.1: presence survives a hibernation in the socket's attachment.
      onPresence: (presence) =>
        ws.serializeAttachment(encodeAttachment(identity, presence)),
    };
  }

  /**
   * The Durable Object alarm: send a §8.5 heartbeat to every socket, retry
   * every shard that owes a failed relay (§8.9), and re-arm: after the
   * heartbeat interval while sockets remain, after one second while a shard
   * still owes. The heartbeat goes straight to the hibernatable sockets, so it
   * rebuilds no session.
   */
  async alarm(): Promise<void> {
    const sockets = this.#state.getWebSockets();
    const heartbeat = encodeHeartbeat(Date.now());
    for (const ws of sockets) {
      try {
        ws.send(heartbeat);
      } catch {
        // A closing socket; its close callback cleans up.
      }
    }
    const storage = this.#state.storage;
    for (const [key, value] of await storage.list({ prefix: 'owed:' })) {
      const shard = key.slice('owed:'.length);
      const token = await storage.get(`shard:${shard}`);
      const message = JSON.parse(String(value)) as {
        readonly partition: string;
        readonly owed: Owed;
      };
      // A newer failure may have merged into the record during the retry.
      if (
        (await this.#relay(shard, token, encodeFanout(message))) ===
          'delivered' &&
        (await storage.get(key)) === value
      ) {
        await storage.delete(key);
      }
    }
    const owing = (await storage.list({ prefix: 'owed:' })).size > 0;
    if (sockets.length > 0 || owing) {
      await storage.setAlarm(
        Date.now() +
          (owing ? 1_000 : (this.#config.heartbeatIntervalMs ?? 30_000)),
      );
    }
  }

  /** Hibernation callback: an inbound frame. */
  async webSocketMessage(
    ws: WebSocketLike,
    message: ArrayBuffer | string,
  ): Promise<void> {
    await this.#serializePartition(async () => {
      const session = this.#sessions.get(ws);
      if (session === undefined) return;
      if (typeof message === 'string') {
        session.handleMessage(message);
      } else {
        // §8.7: tagged binary — sync-round request chunks / acks.
        await session.handleBinary(new Uint8Array(message));
      }
      // §8.2: an ack persists the cursor without being awaited inside the
      // session. Drain it inside the hibernatable event so the DO never
      // ends the event with storage work still in flight.
      await session.drain();
    });
  }

  /** Hibernation callback: the socket closed. */
  async webSocketClose(ws: WebSocketLike): Promise<void> {
    this.#closedSockets.add(ws);
    await this.#rehydrateSockets();
    const session = this.#sessions.get(ws);
    if (session !== undefined) {
      try {
        // §8.2: a cursor write queued by the last ack may still be in flight.
        // The failure must surface, but it must not skip the cleanup below —
        // a leaked session keeps its presence and its map entry.
        await session.drain();
      } finally {
        session.close();
        this.#sessions.delete(ws);
      }
    }
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

const REALTIME_ID_HEADER = {
  partition: 'x-syncular-partition',
  actorId: 'x-syncular-actor',
  clientId: 'x-syncular-client',
  // URI-encoded: a header value carries no arbitrary UTF-8.
  context: 'x-syncular-context',
} as const;

const ADMIN_ACTIONS_HEADER = 'x-syncular-admin-actions';
/** The object name of the shard a sharded upgrade goes to (§8.9). */
const REALTIME_SHARD_HEADER = 'x-syncular-shard';

/** Address a Worker-authorized admin request to the DO (Worker side). */
export function adminRequestForDurableObject(
  request: Request,
  routePath: string,
  target: { readonly partition: string; readonly actions: boolean },
): Request {
  const source = new URL(request.url);
  const forwarded = new Request(
    new URL(`${ADMIN_DO_PATH}${routePath}${source.search}`, request.url),
    request,
  );
  forwarded.headers.set(REALTIME_ID_HEADER.partition, target.partition);
  if (target.actions) forwarded.headers.set(ADMIN_ACTIONS_HEADER, '1');
  else forwarded.headers.delete(ADMIN_ACTIONS_HEADER);
  return forwarded;
}

/**
 * Write the authenticated identity onto a forwarded request's headers (Worker
 * side). The forwarded request copies the client's headers, so a context
 * header the client sent is removed when authentication yielded none.
 */
export function writeRequestIdentityHeaders(
  headers: Headers,
  identity: {
    readonly partition: string;
    readonly actorId: string;
    readonly context?: string;
  },
): void {
  headers.set(REALTIME_ID_HEADER.partition, identity.partition);
  headers.set(REALTIME_ID_HEADER.actorId, identity.actorId);
  if (identity.context === undefined) {
    headers.delete(REALTIME_ID_HEADER.context);
  } else {
    headers.set(
      REALTIME_ID_HEADER.context,
      encodeURIComponent(identity.context),
    );
  }
}

/**
 * Write the resolved identity, and the object name of a sharded upgrade's
 * shard (§8.9), onto an upgrade request's headers (Worker side). A shard
 * header the client sent is removed when the upgrade is not sharded.
 */
export function writeIdentityHeaders(
  headers: Headers,
  identity: RealtimeUpgradeIdentity,
  shard?: string,
): void {
  writeRequestIdentityHeaders(headers, identity);
  headers.set(REALTIME_ID_HEADER.clientId, identity.clientId);
  if (shard === undefined) headers.delete(REALTIME_SHARD_HEADER);
  else headers.set(REALTIME_SHARD_HEADER, shard);
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
  const context = request.headers.get(REALTIME_ID_HEADER.context);
  return {
    partition,
    actorId,
    clientId,
    ...(context !== null ? { context: decodeURIComponent(context) } : {}),
  };
}

function readRequestIdentityHeaders(request: Request):
  | {
      readonly partition: string;
      readonly actorId: string;
      readonly context?: string;
    }
  | undefined {
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
  const context = request.headers.get(REALTIME_ID_HEADER.context);
  return {
    partition,
    actorId,
    ...(context !== null ? { context: decodeURIComponent(context) } : {}),
  };
}

// -- Minimal ambient types (structural; not the real workers-types) ---------

/** The D1 binding, re-declared structurally (see `d1-storage.ts`). */
export type D1Database = ConstructorParameters<typeof D1ServerStorage>[0];
