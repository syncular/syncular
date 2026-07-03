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
} from '@syncular-v2/core';
import type {
  ClientInstance,
  ClientLimitsOptions,
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
    } else if (event.event === 'sync' && typeof event.data === 'object') {
      const reason = (event.data as { reason?: unknown }).reason;
      if (typeof reason === 'string') {
        this.wakeReasons.push(reason);
        drain(this.#wakeWaiters, this.wakeReasons.length);
      }
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
}

export interface NewClientOptions {
  readonly actorId: string;
  readonly clientId: string;
  readonly schema?: DriverSchema;
  readonly limits?: ClientLimitsOptions;
  /** Convenience: set the actor's allowed scopes before first use. */
  readonly allowed?: DriverScopeMap;
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
  readonly random: () => number;
  readonly #clients: ClientHandle[] = [];

  constructor(
    pairing: Pairing,
    server: ServerInstance,
    schema: DriverSchema,
    seed: number,
  ) {
    this.pairing = pairing;
    this.server = server;
    this.schema = schema;
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
    const server = this.server;
    const actorId = options.actorId;
    const clientId = options.clientId;

    const api = await this.pairing.client.create({
      clientId,
      schema: options.schema ?? this.schema,
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      endpoints: {
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
    };
    this.#clients.push(handle);
    return handle;
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
  });
  return new ScenarioContext(
    pairing,
    server,
    // Clients are created against the fixture schema unless the scenario
    // overrides per client (schema-floor scenarios pair mismatched
    // versions deliberately).
    FIXTURE_SCHEMA,
    seedFromName(scenario.name),
  );
}
