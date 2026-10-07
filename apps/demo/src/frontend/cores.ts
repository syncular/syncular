/**
 * The client cores behind the two devices, one per mode:
 * - default: the WHOLE core runs in a Web Worker on a persistent
 *   opfs-sahpool database (`demo-laptop` / `demo-phone`), driven through
 *   the `SyncClientHandle` RPC against the Bun dev server;
 * - `?ephemeral`: an explicit in-memory `SyncClient` on the main thread,
 *   over HTTP and a WebSocket against the dev server;
 * - static build (`SYNCULAR_DEMO_EMBEDDED`): the same main-thread
 *   `SyncClient`, with every transport posting into the server that runs in
 *   a Web Worker in the page.
 *
 * Each device signs in as its own actor (the laptop is Ada, the phone is
 * Ben): a header and a realtime query parameter against the dev server, a
 * field on every RPC to the embedded server.
 */
import {
  ClientSyncError,
  type ConflictRecord,
  createSyncClientHandle,
  documentLifecycleSignal,
  httpSegmentDownloader,
  httpSyncTransport,
  installRealtimeSupervisor,
  type MutationInput,
  NOT_LEADER_CODE,
  type OutboxCommit,
  type RealtimeHandlers,
  type RealtimeSocket,
  type ResolveCommitOutcomeInput,
  type SqlRow,
  type SqlValue,
  type SubscribeInput,
  type SubscriptionRecord,
  SyncClient,
  type SyncSummary,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { openWasmDatabase } from '@syncular/client/wasm';
import type { SyncularServerEvent } from '@syncular/server';
import { schema } from '../syncular.generated';
import type { DeviceId } from './lab';

/**
 * Build-time flag (Bun.build `define`): the static, backend-free bundle sets
 * it, and the devices then talk to the embedded server worker instead of
 * HTTP. The dev server bundle leaves it unset.
 */
declare const SYNCULAR_DEMO_EMBEDDED: boolean;
export const EMBEDDED =
  typeof SYNCULAR_DEMO_EMBEDDED !== 'undefined' && SYNCULAR_DEMO_EMBEDDED;

export const EPHEMERAL = new URLSearchParams(location.search).has('ephemeral');
/**
 * `?multitab` makes each device a multi-tab core: open the lab in two tabs
 * and the first tab's device is the leader, the second's is a follower
 * proxying to it (one socket, one DB, N tabs).
 */
export const MULTITAB = new URLSearchParams(location.search).has('multitab');
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

function mutableConnectivitySignal() {
  let state: 'online' | 'offline' = 'online';
  const listeners = new Set<(value: 'online' | 'offline') => void>();
  return {
    signal: {
      current: () => state,
      subscribe(listener: (value: 'online' | 'offline') => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(value: 'online' | 'offline') {
      state = value;
      for (const listener of listeners) listener(value);
    },
  };
}

/**
 * A device's view of a client core: the handle's async surface. The worker
 * handle implements it directly; the main-thread `SyncClient` is adapted
 * below so every mode drives the same device code.
 */
export interface DeviceCore {
  readonly backendLabel: string;
  readonly clientId: string;
  /** 'leader' | 'follower' in multi-tab mode; absent otherwise. */
  role?(): 'leader' | 'follower';
  onRoleChange?(cb: (role: 'leader' | 'follower') => void): void;
  /** Local data, outbox, or outcomes changed. */
  onChange(listener: () => void): void;
  subscribe(input: SubscribeInput): Promise<void>;
  unsubscribe(id: string): Promise<void>;
  subscriptions(): Promise<readonly SubscriptionRecord[]>;
  mutate(mutations: readonly MutationInput[]): Promise<string>;
  syncUntilIdle(): Promise<SyncSummary>;
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  pendingCommits(): Promise<readonly OutboxCommit[]>;
  conflicts(): Promise<readonly ConflictRecord[]>;
  resolveCommitOutcome(input: ResolveCommitOutcomeInput): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  /** Best-effort; connect-then-sync is the reference boot order: the
   * first sync round rides the socket and registers this connection's
   * subscriptions at round end (§8.7). */
  connectRealtime(): Promise<void>;
  /** Install retry/resume policy after the explicit first catch-up. */
  startRealtimeSupervisor(): void;
}

// -- worker mode (the default): whole core behind the RPC handle -------------

async function makeWorkerCore(
  device: DeviceId,
  actor: string,
): Promise<DeviceCore> {
  const handle = await createSyncClientHandle({
    worker: () => new Worker('worker.js', { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: `demo-${device}` },
    endpoints: {
      syncUrl: 'sync',
      segmentsUrl: 'segments',
      blobsUrl: 'blobs',
      realtimeUrl: `${WS_PROTO}://${location.host}/realtime?clientId={clientId}&actor=${actor}`,
    },
    headers: { 'x-syncular-demo-actor': actor },
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    // §8.4 host loop: wake-ups coalesce into sync rounds INSIDE the worker.
    autoSync: true,
    lockName: `syncular-demo-${device}`,
    multiTab: MULTITAB,
  });
  if (!MULTITAB && !handle.isLeader) {
    throw new ClientSyncError(
      NOT_LEADER_CODE,
      `another tab owns the ${device} core; close it first, ` +
        'or open with ?multitab to follow it',
    );
  }
  // The device's network switch drives the supervisor's connectivity
  // evidence, matching the main-thread modes below.
  const network = mutableConnectivitySignal();
  return {
    backendLabel: MULTITAB
      ? 'Web Worker · OPFS · multi-tab'
      : 'Web Worker · OPFS',
    clientId: handle.clientId,
    ...(MULTITAB
      ? {
          role: () => handle.role,
          onRoleChange: (cb: (role: 'leader' | 'follower') => void) =>
            handle.onRoleChange(cb),
        }
      : {}),
    onChange: (listener) => handle.onChange(listener),
    subscribe: (input) => handle.subscribe(input),
    unsubscribe: (id) => handle.unsubscribe(id),
    subscriptions: () => handle.subscriptions(),
    mutate: (mutations) => handle.mutate(mutations),
    syncUntilIdle: () => handle.syncUntilIdle(),
    query: (sql, params) => handle.query(sql, params),
    pendingCommits: () => handle.pendingCommits(),
    conflicts: () => handle.conflicts(),
    resolveCommitOutcome: async (input) => {
      await handle.resolveCommitOutcome(input);
    },
    setOffline: async (offline) => {
      network.set(offline ? 'offline' : 'online');
      await handle.setOffline(offline);
    },
    connectRealtime: async () => {
      try {
        await handle.connectRealtime();
      } catch {
        // HTTP sync still works without the socket.
      }
    },
    startRealtimeSupervisor: () => {
      // With ?multitab the devices share one leader socket, so
      // `sharedTransport` keeps a hidden tab from tearing it down for a
      // sibling tab that is still visible.
      installRealtimeSupervisor(handle, {
        connectivity: network.signal,
        lifecycle: documentLifecycleSignal(),
        sharedTransport: MULTITAB,
      });
    },
  };
}

// -- embedded mode (static build): the server runs in a web worker -----------

/** The page-side handle on the embedded server worker (one per page). */
interface EmbeddedServer {
  sync(actorId: string, bytes: Uint8Array): Promise<Uint8Array>;
  admin(
    path: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  /** A realtime "socket": a numbered channel into the worker's hub (§8.7). */
  rtOpen(
    actorId: string,
    clientId: string,
    handlers: RealtimeHandlers,
  ): Promise<RealtimeSocket>;
  /** Tail the server event ring: retained backlog first, then live. */
  events(listener: (event: SyncularServerEvent) => void): void;
}

/**
 * The latency slider: half of `ms` delays each direction of every
 * in-page message (sync requests, responses, and realtime frames). A
 * per-lane delivery clock keeps messages in order when the slider moves.
 */
export const latency = { ms: 0 };

function orderedLane(): (deliver: () => void) => void {
  let lastAt = 0;
  return (deliver) => {
    const now = performance.now();
    const at = Math.max(now + latency.ms / 2, lastAt);
    lastAt = at;
    if (at <= now) deliver();
    else window.setTimeout(deliver, at - now);
  };
}

let embeddedServer: Promise<EmbeddedServer> | undefined;

export function getEmbeddedServer(): Promise<EmbeddedServer> {
  if (embeddedServer !== undefined) return embeddedServer;
  embeddedServer = new Promise<EmbeddedServer>((resolve, reject) => {
    const worker = new Worker('server-worker.js', { type: 'module' });
    let nextId = 1;
    let nextChannel = 1;
    let eventListener: ((event: SyncularServerEvent) => void) | undefined;
    const pending = new Map<
      number,
      {
        resolve: (msg: {
          bytes?: Uint8Array;
          status?: number;
          body?: unknown;
        }) => void;
        reject: (error: Error) => void;
      }
    >();
    const channels = new Map<
      number,
      { handlers: RealtimeHandlers; inbound: (deliver: () => void) => void }
    >();
    const call = (
      body: Record<string, unknown>,
    ): Promise<{ bytes?: Uint8Array; status?: number; body?: unknown }> =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ id, ...body });
      });
    // Sync requests are sequential per core, so a plain wait keeps order.
    const delay = () =>
      new Promise<void>((done) =>
        latency.ms > 0 ? window.setTimeout(done, latency.ms / 2) : done(),
      );
    const api: EmbeddedServer = {
      sync: async (actorId, bytes) => {
        await delay();
        const out = (await call({ kind: 'sync', actorId, bytes })).bytes;
        if (out === undefined) throw new Error('sync rpc returned no bytes');
        await delay();
        return out;
      },
      admin: async (path) => {
        const result = await call({ kind: 'admin', path });
        if (result.status === undefined || result.body === undefined) {
          throw new Error('admin rpc returned no response');
        }
        return { status: result.status, body: result.body };
      },
      rtOpen: async (actorId, clientId, handlers) => {
        const channel = nextChannel++;
        channels.set(channel, { handlers, inbound: orderedLane() });
        await call({ kind: 'rt-open', channel, actorId, clientId });
        const outbound = orderedLane();
        return {
          send: (text) =>
            outbound(() =>
              worker.postMessage({ kind: 'rt-text', channel, text }),
            ),
          sendBytes: (bytes) =>
            outbound(() =>
              worker.postMessage({ kind: 'rt-bytes', channel, bytes }),
            ),
          close: () => {
            worker.postMessage({ kind: 'rt-close', channel });
            channels.delete(channel);
          },
        };
      },
      events: (listener) => {
        if (eventListener !== undefined) {
          throw new Error('the embedded server event tail has one listener');
        }
        eventListener = listener;
        worker.postMessage({ kind: 'events' });
      },
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        kind: string;
        id?: number;
        ok?: boolean;
        bytes?: Uint8Array;
        status?: number;
        body?: unknown;
        text?: string;
        channel?: number;
        event?: SyncularServerEvent;
        error?: { code: string; message: string };
      };
      switch (msg.kind) {
        case 'ready':
          resolve(api);
          break;
        case 'boot-error':
          reject(
            new ClientSyncError(
              msg.error?.code ?? 'sync.internal',
              msg.error?.message ?? 'embedded server failed to start',
              false,
            ),
          );
          break;
        case 'event':
          if (msg.event !== undefined) eventListener?.(msg.event);
          break;
        case 'result': {
          if (msg.id === undefined) break;
          const waiter = pending.get(msg.id);
          if (waiter === undefined) break;
          pending.delete(msg.id);
          if (msg.ok === true) waiter.resolve(msg);
          else
            waiter.reject(
              new ClientSyncError(
                msg.error?.code ?? 'sync.transport_failed',
                msg.error?.message ?? 'embedded server call failed',
                false,
              ),
            );
          break;
        }
        case 'rt-text': {
          const channel = channels.get(msg.channel ?? -1);
          const text = msg.text;
          if (channel !== undefined && text !== undefined) {
            channel.inbound(() => channel.handlers.onText(text));
          }
          break;
        }
        case 'rt-bytes': {
          const channel = channels.get(msg.channel ?? -1);
          const bytes = msg.bytes;
          if (channel !== undefined && bytes !== undefined) {
            channel.inbound(() => channel.handlers.onBinary(bytes));
          }
          break;
        }
        case 'rt-closed':
          if (msg.channel !== undefined) {
            channels.get(msg.channel)?.handlers.onClose?.();
            channels.delete(msg.channel);
          }
          break;
      }
    };
    worker.onerror = (event) => {
      reject(new Error(`embedded server worker failed: ${event.message}`));
    };
  });
  return embeddedServer;
}

/**
 * The main-thread `SyncClient` behind the embedded and ephemeral modes. The
 * transports are the only difference: the embedded mode routes sync bytes
 * and a realtime channel into the server worker; the ephemeral mode uses
 * HTTP and a WebSocket against the dev server.
 */
async function makeMainThreadCore(
  device: DeviceId,
  actor: string,
): Promise<DeviceCore> {
  const server = EMBEDDED ? await getEmbeddedServer() : undefined;
  const database = await openWasmDatabase();
  const clientId = crypto.randomUUID();
  let offline = false;
  const network = mutableConnectivitySignal();
  const httpTransport = httpSyncTransport('sync', {
    headers: { 'x-syncular-demo-actor': actor },
  });
  const client = new SyncClient({
    database,
    schema,
    clientId,
    transport: async (bytes) => {
      if (offline) {
        throw new ClientSyncError(
          'sync.transport_failed',
          `the ${device} is offline`,
          true,
        );
      }
      return server !== undefined
        ? server.sync(actor, bytes)
        : httpTransport(bytes);
    },
    ...(server === undefined
      ? {
          segments: httpSegmentDownloader('segments', {
            headers: { 'x-syncular-demo-actor': actor },
          }),
        }
      : {}),
    realtime:
      server !== undefined
        ? (handlers) => server.rtOpen(actor, clientId, handlers)
        : webSocketRealtimeConnector(
            `${WS_PROTO}://${location.host}/realtime?clientId=${clientId}&actor=${actor}`,
          ),
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    onSyncNeeded: () => {
      if (!offline) void syncUntilIdle().catch(() => {});
    },
  });

  // One sync loop per core: realtime wake-ups and the device's explicit
  // syncs share the in-flight run (SyncClient rejects overlapping rounds).
  let running: Promise<SyncSummary> | undefined;
  let again = false;
  function syncUntilIdle(): Promise<SyncSummary> {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = (async () => {
      for (;;) {
        again = false;
        const summary = await client.syncUntilIdle();
        // A wake-up or write arrived during the run: go again while online.
        if (!again || offline) return summary;
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  await client.start();
  return {
    backendLabel: EMBEDDED
      ? 'main thread · in-memory'
      : 'main thread · in-memory · ephemeral',
    clientId,
    onChange: (listener) => {
      client.onChange(listener);
    },
    subscribe: async (input) => client.subscribe(input),
    unsubscribe: async (id) => client.unsubscribe(id),
    subscriptions: async () => client.subscriptions(),
    mutate: async (mutations) => client.mutate(mutations),
    syncUntilIdle,
    query: async (sql, params) => client.query(sql, params),
    pendingCommits: async () => client.pendingCommits(),
    conflicts: async () => client.conflicts(),
    resolveCommitOutcome: async (input) => {
      client.resolveCommitOutcome(input);
    },
    connectRealtime: async () => {
      try {
        await client.connectRealtime();
      } catch {
        // request/response sync still works without the channel
      }
    },
    startRealtimeSupervisor: () => {
      installRealtimeSupervisor(client, {
        connectivity: network.signal,
        lifecycle: documentLifecycleSignal(),
      });
    },
    setOffline: async (value) => {
      offline = value;
      network.set(offline ? 'offline' : 'online');
      if (offline) client.disconnectRealtime();
    },
  };
}

export function makeCore(device: DeviceId, actor: string): Promise<DeviceCore> {
  return EMBEDDED || EPHEMERAL
    ? makeMainThreadCore(device, actor)
    : makeWorkerCore(device, actor);
}
