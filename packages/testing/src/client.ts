/**
 * The client half of a test sync: a real `SyncClient` on bun:sqlite wired
 * to the {@link TestServer} through an in-process loopback seam. No HTTP —
 * the transport calls `handleSyncRequest` directly, the segment downloader
 * calls `handleSegmentDownload`, and (when realtime is on) the connector
 * attaches a `RealtimeSession` to the hub. Every hop passes through a fault
 * gate so an app test can drop / duplicate / corrupt individual exchanges,
 * and an offline flag that makes every hop reject like a lost network.
 *
 * The fault controller is the `TransportFaults` the conformance harness
 * extends; this loopback honors every flag on it.
 */

import {
  type ClientSchema,
  type RealtimeConnector,
  type SegmentDownloader,
  type SegmentFetchRequest,
  SyncClient,
  type SyncClientConfig,
  type SyncTransport,
  transportFailed,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { SyncProfiler } from '@syncular/client/dev';
import { handleSegmentDownload, handleSyncRequest } from '@syncular/server';
import type { VirtualClock } from './clock';
import {
  seededRandom,
  seedFromName,
  TransportFault,
  TransportFaults,
} from './faults';
import type { TestServer } from './server';

/** Rejects a hop the way `httpSyncTransport` reports a dead network. */
const offline = () =>
  transportFailed('injected: client is offline', { causeKind: 'network' });

/**
 * A test client. Everything an app test needs to script a scenario:
 * the real `SyncClient` (`api`, or spread it — see the getters), the fault
 * controller, and the connectivity toggle.
 */
export interface TestClient {
  /** The stable client id (§1.5). */
  readonly id: string;
  /** The actor this client authenticates as (§1.1). */
  readonly actorId: string;
  /** The underlying `SyncClient` — the full shipped client API. */
  readonly api: SyncClient;
  /** Transport-seam faults: drop / duplicate / corrupt the next exchange. */
  readonly faults: TransportFaults;
  /** True while the client is offline (every hop rejects). */
  readonly offline: boolean;
  /**
   * Cut the network: sync / segment / realtime hops reject until online with
   * the `sync.transport_failed` error a dead network raises
   * (`details.causeKind: 'network'`), so the client reports connectivity
   * `offline` and waits for a resume instead of scheduling a retry.
   */
  goOffline(): void;
  /** Restore the network. Does NOT auto-sync — call `sync()` yourself. */
  goOnline(): void;
  /** Push the outbox and pull to quiescence (`SyncClient.syncUntilIdle`). */
  sync(): Promise<void>;
  /** Attach a realtime socket to the hub (deltas, presence, socket rounds). */
  connectRealtime(): Promise<void>;
  /** Detach the realtime socket. */
  disconnectRealtime(): void;
  /** Close the client and its database. */
  close(): Promise<void>;
}

export interface TestClientOptions {
  readonly server: TestServer;
  readonly schema: ClientSchema;
  readonly clock: VirtualClock;
  readonly id: string;
  readonly actorId: string;
  /**
   * Extra `SyncClient` config merged over the loopback defaults — e.g.
   * `onConflict`, `limits`. `database`, `schema`, `clientId`, `now`,
   * `transport`, `segments`, and `realtime` are owned by the kit.
   */
  /** Wraps the client's database, transport, realtime connector and `api`. */
  readonly profiler?: SyncProfiler | undefined;
  readonly clientConfig?: Partial<
    Omit<
      SyncClientConfig,
      | 'database'
      | 'schema'
      | 'clientId'
      | 'now'
      | 'transport'
      | 'segments'
      | 'realtime'
    >
  >;
}

/**
 * Build a `TestClient`. The client is NOT started — the caller (or
 * `createTestSync`) awaits `api.start()`. Split out so `createTestSync` can
 * construct and start in one place.
 */
export function buildTestClient(options: TestClientOptions): {
  client: TestClient;
  start: () => Promise<void>;
} {
  const { server, schema, clock, id, actorId } = options;
  const db = new BunClientDatabase();
  const faults = new TransportFaults(seededRandom(seedFromName(id)));
  const state = { offline: false };
  const ctx = () => server.ctxFor(actorId);

  const transport: SyncTransport = async (request) => {
    if (state.offline) throw offline();
    if (faults.dropNextRequests > 0) {
      faults.dropNextRequests -= 1;
      throw new TransportFault('injected: request lost');
    }
    if (faults.duplicateNextRequest) {
      faults.duplicateNextRequest = false;
      // First delivery is processed by the server; its response is discarded
      // (the §6 idempotency cache absorbs the replay on the second delivery).
      await handleSyncRequest(request, ctx());
    }
    const bytes = await handleSyncRequest(request, ctx());
    if (faults.dropNextResponses > 0) {
      faults.dropNextResponses -= 1;
      throw new TransportFault('injected: response lost');
    }
    if (faults.truncateNextResponse) {
      faults.truncateNextResponse = false;
      return faults.truncate(bytes);
    }
    return bytes;
  };

  const segments: SegmentDownloader = async (request: SegmentFetchRequest) => {
    if (state.offline) throw offline();
    if (faults.dropNextSegmentRequests > 0) {
      faults.dropNextSegmentRequests -= 1;
      throw new TransportFault('injected: segment request lost');
    }
    const result = await handleSegmentDownload(ctx(), {
      segmentId: request.segmentId,
      scopesHeader: request.requestedScopesJson,
    });
    if (faults.truncateNextSegmentDownload) {
      faults.truncateNextSegmentDownload = false;
      return faults.truncate(result.bytes);
    }
    return result.bytes;
  };

  const realtime: RealtimeConnector = async (handlers) => {
    if (state.offline) throw offline();
    if (faults.refuseNextRealtimeConnect) {
      faults.refuseNextRealtimeConnect = false;
      throw new TransportFault('injected: realtime connect refused');
    }
    const session = await server.hub.connect({
      partition: server.partition,
      actorId,
      clientId: id,
      send: (data) => {
        if (typeof data === 'string') handlers.onText(data);
        else handlers.onBinary(data);
      },
    });
    return {
      send: (text) => session.handleMessage(text),
      sendBytes: (bytes) => session.handleBinary(bytes),
      close: () => {
        session.close();
        handlers.onClose?.();
      },
    };
  };

  const { profiler } = options;
  const unprofiled = new SyncClient({
    database: profiler?.database(db) ?? db,
    schema,
    clientId: id,
    now: () => clock.now(),
    transport: profiler?.transport(transport) ?? transport,
    segments,
    realtime: profiler?.realtime(realtime) ?? realtime,
    ...options.clientConfig,
  });
  const api = profiler?.client(unprofiled) ?? unprofiled;

  const client: TestClient = {
    id,
    actorId,
    api,
    faults,
    get offline() {
      return state.offline;
    },
    goOffline: () => {
      state.offline = true;
      api.disconnectRealtime();
    },
    goOnline: () => {
      state.offline = false;
    },
    sync: async () => {
      await api.syncUntilIdle();
    },
    connectRealtime: () => api.connectRealtime(),
    disconnectRealtime: () => api.disconnectRealtime(),
    close: () => api.close(),
  };

  return { client, start: () => api.start() };
}
