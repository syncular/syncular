/**
 * Scenario definitions and the per-scenario harness.
 *
 * A scenario is implementation-agnostic: its script only ever touches the
 * driver interfaces (`driver.ts`), the raw reference-codec surface
 * (`raw.ts`), and the fault controller at the transport seam
 * (`faults.ts`). The harness owns the loopback between client and server
 * drivers, so it — not either implementation — is where faults inject and
 * where readiness signals (delivered deltas, wake-ups, acks) are observed
 * as explicit completion promises. No timers anywhere.
 */

import {
  MessageStreamScanner,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RequestFrame,
  type ResponseMessage,
} from '@syncular/core';
import type {
  ClientInstance,
  ClientLimitsOptions,
  DriverEncryptionConfig,
  DriverError,
  DriverSchema,
  DriverScopeMap,
  Pairing,
  RealtimeSink,
  ServerCapability,
  ServerInstance,
  ServerLimitsOptions,
} from './driver';
import {
  seededRandom,
  seedFromName,
  TransportFault,
  TransportFaults,
} from './faults';
import { FIXTURE_SCHEMA, PARTITION } from './fixture';
import { decodeResponse, rawRequestBytes } from './raw';

export const DEFAULT_NOW_MS = 1_750_000_000_000;

/** A request-level server error surfaced through the transport (§1.1). */
export class EndpointError extends Error {
  override readonly name = 'EndpointError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: DriverError) {
    super(error.message);
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

export interface ScenarioServerOptions {
  readonly schema?: DriverSchema;
  readonly limits?: ServerLimitsOptions;
  readonly nowMs?: number;
  /** §5.4 native-scheme signed-URL issuance for this scenario's server. */
  readonly signedUrls?: { readonly ttlSeconds?: number };
  /** §7.3 auth leases for this scenario's server (absent ⇒ off). */
  readonly leases?: { readonly ttlMs: number };
}

export interface Scenario {
  /** `area/behavior`, unique within the catalog. */
  readonly name: string;
  /** SPEC.md section references this scenario pins. */
  readonly specRefs: readonly string[];
  /**
   * Present when the reference pairing is known to diverge from the spec:
   * the runner then EXPECTS the scenario to fail and reports the
   * discrepancy instead of a pass. Never weaken a scenario to green it.
   */
  readonly knownDiscrepancy?: string;
  /** Optional server capabilities; missing ones skip the scenario. */
  readonly requires?: readonly ServerCapability[];
  /** Overrides for the server instance this scenario runs against. */
  readonly server?: ScenarioServerOptions;
  run(t: ScenarioContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Client handle: driver instance + seam observability
// ---------------------------------------------------------------------------

interface Waiter {
  readonly threshold: number;
  readonly resolve: () => void;
}

/** Realtime traffic observed at the transport seam (server → client and
 * client → server), with promise-based readiness waits. Binary traffic
 * is routed by §8.7 channel tag: `0x00` messages count as deltas,
 * `0x01` chunks feed per-direction round scanners so socket sync rounds
 * are observed as rounds, never miscounted as deltas. */
export class RealtimeObservations {
  readonly hellos: Array<Record<string, unknown>> = [];
  readonly wakeReasons: string[] = [];
  /** §8.6 server→client presence events observed at the seam, in order. */
  readonly presenceEvents: Array<Record<string, unknown>> = [];
  deltasDelivered = 0;
  readonly ackCursors: number[] = [];
  /** Completed §8.7 socket sync rounds (response END observed). */
  roundsCompleted = 0;
  /** True once the server closed the connection (§8.7 violations). */
  closedByServer = false;
  /** Any 0x00 delta message delivered while a round response stream
   * was in flight — a §8.7 interleaving violation. */
  deltaInterleavedDuringRound = false;

  #responseScanner: MessageStreamScanner | undefined;

  readonly #ackWaiters: Waiter[] = [];
  readonly #wakeWaiters: Waiter[] = [];
  readonly #deltaWaiters: Waiter[] = [];
  readonly #roundWaiters: Waiter[] = [];
  readonly #presenceWaiters: Waiter[] = [];
  readonly #helloWaiters: Waiter[] = [];
  readonly #closeWaiters: Array<() => void> = [];

  get maxAckCursor(): number {
    return this.ackCursors.length > 0 ? Math.max(...this.ackCursors) : -1;
  }

  /** Resolves once the client has acked a cursor ≥ `cursor` (§8.2) — the
   * "delta applied" readiness signal. */
  waitForAck(cursor: number): Promise<void> {
    if (this.maxAckCursor >= cursor) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ackWaiters.push({ threshold: cursor, resolve });
    });
  }

  /** Resolves once at least `count` wake-ups arrived (§8.3). */
  waitForWakes(count: number): Promise<void> {
    if (this.wakeReasons.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#wakeWaiters.push({ threshold: count, resolve });
    });
  }

  /** Resolves once at least `count` binary deltas were DELIVERED (not
   * necessarily applied — await the ack for that). */
  waitForDeltas(count: number): Promise<void> {
    if (this.deltasDelivered >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#deltaWaiters.push({ threshold: count, resolve });
    });
  }

  /** Resolves once at least `count` socket rounds completed (§8.7). */
  waitForRounds(count: number): Promise<void> {
    if (this.roundsCompleted >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#roundWaiters.push({ threshold: count, resolve });
    });
  }

  /** Resolves once at least `count` presence events arrived at the seam
   * (§8.6) — the "presence delivered" readiness signal, no timers. */
  waitForPresence(count: number): Promise<void> {
    if (this.presenceEvents.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#presenceWaiters.push({ threshold: count, resolve });
    });
  }

  /** Resolves once at least `count` `hello` handshakes arrived (§8.1) — the
   * reconnect readiness signal across a churn. */
  waitForHelloCount(count: number): Promise<void> {
    if (this.hellos.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#helloWaiters.push({ threshold: count, resolve });
    });
  }

  /** Resolves once the server closed the connection (§8.7). */
  waitForClose(): Promise<void> {
    if (this.closedByServer) return Promise.resolve();
    return new Promise((resolve) => {
      this.#closeWaiters.push(resolve);
    });
  }

  observeServerClose(): void {
    this.closedByServer = true;
    for (const resolve of this.#closeWaiters.splice(0)) resolve();
  }

  observeServerText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const event = parsed as { event?: unknown; data?: unknown };
    if (event.event === 'hello' && typeof event.data === 'object') {
      this.hellos.push((event.data ?? {}) as Record<string, unknown>);
      drain(this.#helloWaiters, this.hellos.length);
    } else if (event.event === 'sync' && typeof event.data === 'object') {
      const reason = (event.data as { reason?: unknown }).reason;
      if (typeof reason === 'string') {
        this.wakeReasons.push(reason);
        drain(this.#wakeWaiters, this.wakeReasons.length);
      }
    } else if (event.event === 'presence' && typeof event.data === 'object') {
      this.presenceEvents.push((event.data ?? {}) as Record<string, unknown>);
      drain(this.#presenceWaiters, this.presenceEvents.length);
    }
  }

  observeDelta(): void {
    this.deltasDelivered += 1;
    drain(this.#deltaWaiters, this.deltasDelivered);
  }

  /** Route one server→client binary message by its §8.7 channel tag. */
  observeServerBinary(bytes: Uint8Array): void {
    const tag = bytes[0];
    if (tag === REALTIME_TAG_ROUND) {
      this.#responseScanner ??= new MessageStreamScanner();
      const done = this.#responseScanner.push(bytes.subarray(1));
      if (done !== undefined) {
        this.#responseScanner = undefined;
        this.roundsCompleted += 1;
        drain(this.#roundWaiters, this.roundsCompleted);
      }
      return;
    }
    if (tag === REALTIME_TAG_DELTA) {
      if (this.#responseScanner !== undefined) {
        // §8.7: the server MUST NOT interleave deltas mid-stream.
        this.deltaInterleavedDuringRound = true;
      }
      this.observeDelta();
    }
  }

  observeClientText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = parsed as { type?: unknown; cursor?: unknown };
    if (message.type === 'ack' && typeof message.cursor === 'number') {
      this.ackCursors.push(message.cursor);
      const max = this.maxAckCursor;
      for (let i = this.#ackWaiters.length - 1; i >= 0; i--) {
        const waiter = this.#ackWaiters[i];
        if (waiter !== undefined && max >= waiter.threshold) {
          this.#ackWaiters.splice(i, 1);
          waiter.resolve();
        }
      }
    }
  }
}

function drain(waiters: Waiter[], reached: number): void {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    if (waiter !== undefined && reached >= waiter.threshold) {
      waiters.splice(i, 1);
      waiter.resolve();
    }
  }
}

export interface ClientHandle {
  readonly actorId: string;
  readonly clientId: string;
  /** The driver-facing client API. */
  readonly api: ClientInstance;
  /** Fault controller for this client's transport (the seam). */
  readonly faults: TransportFaults;
  /** Every sync request's bytes, in order (stale-retransmit material). */
  readonly sentRequests: Uint8Array[];
  /** Seam-observed realtime traffic + readiness waits. */
  readonly realtime: RealtimeObservations;
  /** Signed URLs fetched at the CDN hop, in order (§5.4). */
  readonly urlFetches: string[];
  /** Direct-endpoint downloads (§5.5), by segmentId, in order. */
  readonly directDownloads: string[];
  /** Blob uploads (§5.9.3), by blobId, in order (direct host-authed PUTs). */
  readonly blobUploads: string[];
  /**
   * Blob download REQUESTS (§5.9.5) to the authorized endpoint, by blobId, in
   * order — the cache-hit oracle. Counts the request regardless of whether the
   * response was inline bytes or a presigned url.
   */
  readonly blobDownloads: string[];
  /** §5.9.5 presigned blob url fetches — the CDN hop, by url, in order. */
  readonly blobUrlFetches: string[];
  /** §5.9.3 presigned direct-to-storage PUTs — by url, in order. */
  readonly blobDirectPuts: string[];
}

export interface NewClientOptions {
  readonly actorId: string;
  readonly clientId: string;
  readonly schema?: DriverSchema;
  readonly limits?: ClientLimitsOptions;
  /** Convenience: set the actor's allowed scopes before first use. */
  readonly allowed?: DriverScopeMap;
  /**
   * Give this client's endpoints a URL host (§5.4 bit-3 capability —
   * negotiation, not fallback). Requires a `signed-urls` server created
   * with `server.signedUrls`.
   */
  readonly signedUrls?: boolean;
  /** Pin the client clock (epoch ms) — required by §5.4 expiry checks
   * against the server's virtual clock. */
  readonly nowMs?: number;
  /** §5.11 client-side encryption keys; absent ⇒ E2EE off. */
  readonly encryption?: DriverEncryptionConfig;
}

// ---------------------------------------------------------------------------
// Scenario context
// ---------------------------------------------------------------------------

export type RawSyncResult =
  | { readonly ok: true; readonly message: ResponseMessage }
  | { readonly ok: false; readonly error: DriverError };

export class ScenarioContext {
  readonly pairing: Pairing;
  readonly server: ServerInstance;
  readonly schema: DriverSchema;
  /**
   * The schema the SERVER runs (may differ from `schema`, the client
   * default). Seeds go in at this version so a scenario running a bumped
   * server (§7.4) can still seed rows the server accepts.
   */
  readonly serverSchema: DriverSchema;
  readonly random: () => number;
  readonly #clients: ClientHandle[] = [];

  constructor(
    pairing: Pairing,
    server: ServerInstance,
    schema: DriverSchema,
    seed: number,
    serverSchema: DriverSchema = schema,
  ) {
    this.pairing = pairing;
    this.server = server;
    this.schema = schema;
    this.serverSchema = serverSchema;
    this.random = seededRandom(seed);
  }

  /** Create a client wired to the server through a faultable loopback. */
  async newClient(options: NewClientOptions): Promise<ClientHandle> {
    if (options.allowed !== undefined) {
      await this.server.setAllowedScopes(options.actorId, options.allowed);
    }
    const faults = new TransportFaults(this.random);
    const sentRequests: Uint8Array[] = [];
    const realtime = new RealtimeObservations();
    const urlFetches: string[] = [];
    const directDownloads: string[] = [];
    const blobUploads: string[] = [];
    const blobDownloads: string[] = [];
    const blobUrlFetches: string[] = [];
    const blobDirectPuts: string[] = [];
    const server = this.server;
    const actorId = options.actorId;
    const clientId = options.clientId;
    // §5.9: blob endpoints exist iff the server driver supports blobs. Their
    // presence makes the client core blob-capable (upload/download available).
    const serverUploadBlob = server.uploadBlob?.bind(server);
    const serverDownloadBlob = server.downloadBlob?.bind(server);
    const serverFetchBlobUrl = server.fetchBlobUrl?.bind(server);
    const serverUploadBlobGrant = server.uploadBlobGrant?.bind(server);
    const serverPutBlobUrl = server.putBlobUrl?.bind(server);
    const uploadBlob =
      serverUploadBlob !== undefined
        ? async (
            blobId: string,
            bytes: Uint8Array,
            mediaType?: string,
          ): Promise<void> => {
            blobUploads.push(blobId);
            const result = await serverUploadBlob(
              actorId,
              blobId,
              bytes,
              mediaType,
            );
            if (!result.ok) throw new EndpointError(result.error);
          }
        : undefined;
    const downloadBlob =
      serverDownloadBlob !== undefined
        ? async (
            blobId: string,
          ): Promise<
            | { kind: 'bytes'; bytes: Uint8Array }
            | { kind: 'url'; url: string; urlExpiresAtMs?: number }
          > => {
            // Count the authorized-endpoint REQUEST (the cache-hit oracle),
            // whether it returns inline bytes or a presigned url.
            blobDownloads.push(blobId);
            const result = await serverDownloadBlob(actorId, blobId);
            if (!result.ok) throw new EndpointError(result.error);
            if ('url' in result) {
              return {
                kind: 'url',
                url: result.url,
                ...(result.urlExpiresAtMs !== undefined
                  ? { urlExpiresAtMs: result.urlExpiresAtMs }
                  : {}),
              };
            }
            return { kind: 'bytes', bytes: result.bytes };
          }
        : undefined;
    // §5.9.5 CDN hop: only when the server exposes the presign CDN role.
    const fetchBlobUrl =
      serverFetchBlobUrl !== undefined
        ? async (url: string): Promise<Uint8Array> => {
            blobUrlFetches.push(url);
            // §5.9.5: the CDN hop shares the url-fetch fault knobs (loss +
            // tamper) so scenarios can drive the recovery + tamper probes.
            if (faults.dropNextUrlFetches > 0) {
              faults.dropNextUrlFetches -= 1;
              throw new TransportFault('injected: blob url fetch lost');
            }
            const result = await serverFetchBlobUrl(url);
            if (!result.ok) throw new EndpointError(result.error);
            if (faults.corruptNextUrlFetch) {
              faults.corruptNextUrlFetch = false;
              return faults.corrupt(result.bytes);
            }
            return result.bytes;
          }
        : undefined;
    const uploadBlobGrant =
      serverUploadBlobGrant !== undefined
        ? async (
            blobId: string,
            byteLength: number,
            mediaType?: string,
          ): Promise<
            | { kind: 'url'; url: string; urlExpiresAtMs?: number }
            | { kind: 'present' }
            | { kind: 'none' }
          > => {
            const result = await serverUploadBlobGrant(
              actorId,
              blobId,
              byteLength,
              mediaType,
            );
            if (!result.ok) throw new EndpointError(result.error);
            return result.grant;
          }
        : undefined;
    // §5.9.3 direct-to-storage PUT hop.
    const putBlobUrl =
      serverPutBlobUrl !== undefined
        ? async (
            url: string,
            bytes: Uint8Array,
            _mediaType?: string,
          ): Promise<void> => {
            blobDirectPuts.push(url);
            const result = await serverPutBlobUrl(url, bytes);
            if (!result.ok) throw new EndpointError(result.error);
          }
        : undefined;
    const fetchSegmentUrl =
      options.signedUrls === true
        ? async (url: string): Promise<Uint8Array> => {
            urlFetches.push(url);
            if (faults.dropNextUrlFetches > 0) {
              faults.dropNextUrlFetches -= 1;
              throw new TransportFault('injected: url fetch lost');
            }
            const serve = server.fetchSegmentUrl?.bind(server);
            if (serve === undefined) {
              throw new Error(
                'newClient({ signedUrls: true }) needs a signed-urls server',
              );
            }
            const result = await serve(url);
            if (!result.ok) throw new EndpointError(result.error);
            if (faults.corruptNextUrlFetch) {
              faults.corruptNextUrlFetch = false;
              return faults.corrupt(result.bytes);
            }
            return result.bytes;
          }
        : undefined;

    const api = await this.pairing.client.create({
      clientId,
      schema: options.schema ?? this.schema,
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.encryption !== undefined
        ? { encryption: options.encryption }
        : {}),
      endpoints: {
        ...(fetchSegmentUrl !== undefined ? { fetchSegmentUrl } : {}),
        ...(uploadBlob !== undefined ? { uploadBlob } : {}),
        ...(downloadBlob !== undefined ? { downloadBlob } : {}),
        ...(fetchBlobUrl !== undefined ? { fetchBlobUrl } : {}),
        ...(uploadBlobGrant !== undefined ? { uploadBlobGrant } : {}),
        ...(putBlobUrl !== undefined ? { putBlobUrl } : {}),
        sync: async (request) => {
          sentRequests.push(request);
          if (faults.dropNextRequests > 0) {
            faults.dropNextRequests -= 1;
            throw new TransportFault('injected: request lost');
          }
          if (faults.duplicateNextRequest) {
            faults.duplicateNextRequest = false;
            // First delivery: processed by the server, response discarded.
            await server.handleSyncRequest(actorId, request);
          }
          const result = await server.handleSyncRequest(actorId, request);
          if (!result.ok) throw new EndpointError(result.error);
          if (faults.dropNextResponses > 0) {
            faults.dropNextResponses -= 1;
            throw new TransportFault('injected: response lost');
          }
          if (faults.truncateNextResponse) {
            faults.truncateNextResponse = false;
            return faults.truncate(result.bytes);
          }
          return result.bytes;
        },
        downloadSegment: async (request) => {
          directDownloads.push(request.segmentId);
          if (faults.dropNextSegmentRequests > 0) {
            faults.dropNextSegmentRequests -= 1;
            throw new TransportFault('injected: segment request lost');
          }
          const result = await server.downloadSegment(
            actorId,
            request.segmentId,
            request.requestedScopesJson,
          );
          if (!result.ok) throw new EndpointError(result.error);
          if (faults.truncateNextSegmentDownload) {
            faults.truncateNextSegmentDownload = false;
            return faults.truncate(result.bytes);
          }
          return result.bytes;
        },
        connectRealtime: async (sink: RealtimeSink) => {
          const result = await server.connectRealtime(actorId, clientId, {
            onText: (text) => {
              realtime.observeServerText(text);
              sink.onText(text);
            },
            onBinary: (bytes) => {
              realtime.observeServerBinary(bytes);
              sink.onBinary(bytes);
            },
            onClose: () => {
              realtime.observeServerClose();
              sink.onClose?.();
            },
          });
          if (!result.ok) throw new EndpointError(result.error);
          const connection = result.connection;
          return {
            send: (text: string) => {
              realtime.observeClientText(text);
              connection.send(text);
            },
            sendBinary: (bytes: Uint8Array) => connection.sendBinary(bytes),
            close: () => connection.close(),
          };
        },
      },
    });

    const handle: ClientHandle = {
      actorId,
      clientId,
      api,
      faults,
      sentRequests,
      realtime,
      urlFetches,
      directDownloads,
      blobUploads,
      blobDownloads,
      blobUrlFetches,
      blobDirectPuts,
    };
    this.#clients.push(handle);
    return handle;
  }

  /**
   * §7.4.2 "app ships new code": recreate a client's core with a NEW
   * generated schema on the SAME local database (the boot-time §7.4.1
   * marker check then drives the wipe/re-bootstrap). The handle's fault
   * controller, transport seam, and realtime observations are preserved —
   * only the client core is swapped. Requires a client driver that
   * implements `recreateWithSchema`.
   */
  async recreateClient(
    handle: ClientHandle,
    schema: DriverSchema,
  ): Promise<void> {
    if (handle.api.recreateWithSchema === undefined) {
      throw new Error(
        'this client driver does not support recreateWithSchema (§7.4.2)',
      );
    }
    const next = await handle.api.recreateWithSchema(schema);
    // The driver returns `this` with the core swapped; keep the same handle
    // object (mutably rebind `api`) so scenarios hold one reference.
    (handle as { api: ClientInstance }).api = next;
  }

  /** Raw-bytes surface: hand-built reference-codec request → decoded
   * response, or the server's request-level error (§1.7). */
  async rawSync(
    actorId: string,
    frames: readonly RequestFrame[],
    options?: { clientId?: string; schemaVersion?: number },
  ): Promise<RawSyncResult> {
    return this.rawSyncBytes(actorId, rawRequestBytes(frames, options));
  }

  /** Deliver arbitrary request bytes (captured replays, corruptions). */
  async rawSyncBytes(
    actorId: string,
    bytes: Uint8Array,
  ): Promise<RawSyncResult> {
    const result = await this.server.handleSyncRequest(actorId, bytes);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, message: decodeResponse(result.bytes) };
  }

  async close(): Promise<void> {
    for (const handle of this.#clients) {
      await handle.api.close();
    }
    await this.server.close();
  }
}

export async function createScenarioContext(
  scenario: Scenario,
  pairing: Pairing,
): Promise<ScenarioContext> {
  const schema = scenario.server?.schema ?? FIXTURE_SCHEMA;
  const server = await pairing.server.create({
    schema,
    partition: PARTITION,
    nowMs: scenario.server?.nowMs ?? DEFAULT_NOW_MS,
    ...(scenario.server?.limits !== undefined
      ? { limits: scenario.server.limits }
      : {}),
    ...(scenario.server?.signedUrls !== undefined
      ? { signedUrls: scenario.server.signedUrls }
      : {}),
    ...(scenario.server?.leases !== undefined
      ? { leases: scenario.server.leases }
      : {}),
  });
  return new ScenarioContext(
    pairing,
    server,
    // Clients are created against the fixture schema unless the scenario
    // overrides per client (schema-floor scenarios pair mismatched
    // versions deliberately).
    FIXTURE_SCHEMA,
    seedFromName(scenario.name),
    // Seeds go in at the server's actual schema version (§7.4 scenarios
    // run a bumped server).
    schema,
  );
}
