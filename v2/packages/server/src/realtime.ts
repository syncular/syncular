/**
 * Realtime channel (SPEC.md §8) — transport-agnostic.
 *
 * A `RealtimeSession` wraps a connected socket's send/receive callbacks:
 * the host feeds inbound text frames to `handleMessage`, binary frames to
 * `handleBinary`, and wires `session.close()` to socket close. Initial
 * subscription registration comes from the client's most recent pull
 * (§8.1, loaded from the client record); a sync round completed on the
 * connection replaces it at round end (§8.7). Deltas are complete SSP2
 * response messages pushed as `0x00`-tagged binary (§8.2/§8.7); sync
 * rounds ride the same socket as `0x01`-tagged byte-stream chunks driven
 * through the SAME `createSyncResponseStream` as `POST /sync` (§8.7 —
 * one handler, two framings); the only JSON data-plane server event is
 * the `sync` wake-up (§8.3).
 */
import {
  type CommitChange,
  DecodeError,
  decodeMessage,
  encodeMessage,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type ResponseFrame,
  type ScopeMap,
  type WakeReason,
} from '@syncular-v2/core';
import type { ResolveScopes, ServerLimits } from './context';
import { SyncError, syncError } from './errors';
import { emitEvent, type SyncularServerEvents } from './events';
import { createSyncResponseStream } from './handler';
import type { ServerSchema } from './schema';
import { type CompiledSchema, compileSchema } from './schema';
import {
  computeEffective,
  matchesEffective,
  type ResolvedScopes,
} from './scopes';
import type { SegmentStore } from './segment-store';
import type { SegmentUrlConfig } from './signed-url';
import type { ServerStorage, StoredCommit } from './storage';

export interface RealtimeHubConfig {
  readonly schema: ServerSchema;
  readonly storage: ServerStorage;
  readonly resolveScopes: ResolveScopes;
  readonly clock?: () => number;
  /** Deltas larger than this become `delta-too-large` wake-ups (§8.2). */
  readonly maxDeltaBytes?: number;
  /** Optional structured-events sink (`realtime.*` events). */
  readonly events?: SyncularServerEvents;
  /**
   * Segment store for sync rounds over the socket (§8.7). Without it a
   * socket round fails loudly with an in-band ERROR — provide the same
   * store the HTTP binding uses (one handler, two framings).
   */
  readonly segments?: SegmentStore;
  /** Request limits for socket rounds; defaults match the HTTP binding. */
  readonly limits?: Partial<ServerLimits>;
  readonly signedUrls?: SegmentUrlConfig;
}

export interface RealtimeConnectOptions {
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  /**
   * Socket send: JSON control messages as text, tagged binary otherwise
   * (§8.7). A host MAY return a promise that resolves when the socket
   * has drained — the session awaits it between round-response chunks
   * (§8.7 backpressure: bounded buffering, mechanics host-owned).
   */
  readonly send: (data: string | Uint8Array) => void | Promise<void>;
  /**
   * Close the underlying socket — invoked on §8.7 protocol violations
   * (pipelined rounds, unframed streams). The host must still call
   * `session.close()` from its socket-close handler as usual.
   */
  readonly closeSocket?: () => void;
}

interface Registration {
  readonly id: string;
  readonly table: string;
  readonly effective: ScopeMap;
}

const DEFAULT_MAX_DELTA_BYTES = 1024 * 1024;

export class RealtimeSession {
  readonly sessionId: string;
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  /** Highest contiguously applied commitSeq acknowledged by the client. */
  cursor: number;
  /** Suppress deltas until the client catches up via pull + ack (§8.2). */
  wakePending: boolean;
  lastKnownSeq: number;
  /** Replaced at socket-round completion (§8.7); initial set from §8.1. */
  registrations: readonly Registration[];
  /** Epoch-ms (hub clock) at registration, for `realtime.closed`. */
  readonly openedAtMs: number;
  #send: (data: string | Uint8Array) => void | Promise<void>;
  #closeSocket: (() => void) | undefined;
  #hub: RealtimeHub;
  #clock: () => number;
  #maxDeltaBytes: number;
  #storage: ServerStorage;
  #events: SyncularServerEvents | undefined;
  /** §8.7 round state: request assembly + one-round-in-flight. The
   * token identifies the owning round so a finished round's cleanup
   * never clobbers a follow-up round's in-flight marker. */
  #requestScanner: MessageStreamScanner | undefined;
  #activeRound: symbol | undefined;

  constructor(
    hub: RealtimeHub,
    options: RealtimeConnectOptions,
    registrations: readonly Registration[],
    cursor: number,
    latestSeq: number,
    clock: () => number,
    maxDeltaBytes: number,
    storage: ServerStorage,
    events: SyncularServerEvents | undefined,
  ) {
    this.sessionId = crypto.randomUUID();
    this.partition = options.partition;
    this.actorId = options.actorId;
    this.clientId = options.clientId;
    this.cursor = cursor;
    this.lastKnownSeq = latestSeq;
    this.wakePending = cursor < latestSeq;
    this.registrations = registrations;
    this.openedAtMs = clock();
    this.#send = options.send;
    this.#closeSocket = options.closeSocket;
    this.#hub = hub;
    this.#clock = clock;
    this.#maxDeltaBytes = maxDeltaBytes;
    this.#storage = storage;
    this.#events = events;
  }

  /** Feed an inbound text frame (client → server control message, §8.2). */
  handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // tolerate unknown/garbled control messages
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== 'ack'
    ) {
      return;
    }
    const cursor = (parsed as { cursor?: unknown }).cursor;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) return;
    this.cursor = Math.max(this.cursor, cursor);
    if (this.cursor >= this.lastKnownSeq) this.wakePending = false;
    // §8.2: acks update the client cursor record without an HTTP pull.
    void this.#persistCursor();
  }

  /**
   * Feed an inbound binary frame: a `0x01`-tagged chunk of the sync
   * round's request byte stream (§8.7). Synchronous entry — assembly and
   * violation detection happen inline so a pipelined chunk arriving
   * while a response streams is caught deterministically; the round
   * itself runs async once the request is complete.
   */
  handleBinary(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes[0] !== REALTIME_TAG_ROUND) {
      // §8.7: client→server tags other than 0x01 — a broken client.
      this.#violation(`unexpected channel tag 0x${bytes[0]?.toString(16)}`);
      return;
    }
    if (this.#activeRound !== undefined) {
      // §8.7 one round in flight: MUST NOT process, drop the connection.
      this.#violation('sync round begun while a response stream is in flight');
      return;
    }
    const chunk = bytes.subarray(1);
    this.#requestScanner ??= new MessageStreamScanner();
    let done: ReturnType<MessageStreamScanner['push']>;
    try {
      done = this.#requestScanner.push(chunk);
    } catch (error) {
      // §8.7: an unframed stream has no findable end — connection-fatal.
      this.#requestScanner = undefined;
      this.#violation(
        error instanceof DecodeError
          ? error.message
          : 'malformed request stream',
      );
      return;
    }
    if (done === undefined) return;
    this.#requestScanner = undefined;
    if (done.excess > 0) {
      this.#violation('request bytes past END (pipelining, §8.7)');
      return;
    }
    const token = Symbol('round');
    this.#activeRound = token;
    void this.#runRound(done.message.slice(), token);
  }

  /** Drive the shared handler and stream the response back (§8.7). */
  async #runRound(requestBytes: Uint8Array, token: symbol): Promise<void> {
    const finishRound = (): void => {
      if (this.#activeRound === token) this.#activeRound = undefined;
    };
    try {
      let stream: AsyncIterable<Uint8Array> | undefined;
      try {
        // §8.7: the round's clientId must match the connection's —
        // registration identity would otherwise be ambiguous.
        const decoded = decodeMessage(requestBytes);
        const header = decoded.frames[0];
        if (decoded.msgKind !== 'request' || header?.type !== 'REQ_HEADER') {
          throw syncError('sync.invalid_request', 'expected a request message');
        }
        if (header.clientId !== this.clientId) {
          throw syncError(
            'sync.invalid_client_id',
            'socket round clientId must match the connection (§8.7)',
          );
        }
        stream = await createSyncResponseStream(
          requestBytes,
          this.#hub.requestContext(this),
        );
      } catch (error) {
        // §8.7 failures: what HTTP reports as status+JSON becomes a
        // minimal RESP_HEADER/ERROR/END response stream on the socket.
        if (error instanceof DecodeError || error instanceof SyncError) {
          const sync =
            error instanceof SyncError
              ? error
              : syncError(error.code, error.message);
          finishRound(); // END is in this one chunk
          await this.#sendRoundChunk(errorResponseBytes(sync));
          return;
        }
        throw error;
      }
      // Fetch-ahead so the round stops being "in flight" the moment the
      // chunk carrying END is handed to send: the client may legally
      // begin its next round as soon as END *arrives* (§8.7 rule 3), so
      // in-flight must end with the send, not with generator cleanup.
      const iterator = stream[Symbol.asyncIterator]();
      let step = await iterator.next();
      while (!step.done) {
        const chunk = step.value;
        step = await iterator.next();
        if (step.done) finishRound();
        await this.#sendRoundChunk(chunk);
      }
    } catch {
      // A host failure mid-stream leaves the byte stream unfinishable —
      // fail loud, drop the connection (§8.7 / §1.4 abort rule).
      this.#violation('sync round failed mid-stream');
    } finally {
      finishRound();
      // §8.7 registration at round end: reload the persisted list — it
      // only advances on success, so failed rounds change nothing.
      await this.#refreshRegistrations();
    }
  }

  async #sendRoundChunk(chunk: Uint8Array): Promise<void> {
    const tagged = new Uint8Array(chunk.length + 1);
    tagged[0] = REALTIME_TAG_ROUND;
    tagged.set(chunk, 1);
    await this.#send(tagged);
  }

  async #refreshRegistrations(): Promise<void> {
    try {
      this.registrations = await this.#hub.loadRegistrations(
        this.partition,
        this.actorId,
        this.clientId,
      );
    } catch {
      // Fail closed: an unreadable record or resolver failure leaves the
      // previous registrations in place; the next round repairs it.
    }
  }

  /** §8.7 protocol violation: drop the connection, fail loud. The
   * message is intentionally unsent — there is no error channel for an
   * unframed stream; `realtime.closed` fires via `disconnect`. */
  #violation(_message: string): void {
    this.#closeSocket?.();
    this.#hub.disconnect(this);
  }

  async #persistCursor(): Promise<void> {
    try {
      const record = await this.#storage.getClientRecord(
        this.partition,
        this.clientId,
      );
      if (record === undefined) return;
      await this.#storage.putClientRecord(this.partition, {
        ...record,
        cursor: Math.max(record.cursor, this.cursor),
        updatedAtMs: this.#clock(),
      });
    } catch {
      // Cursor persistence is best-effort; the next pull repairs it.
    }
  }

  /** Fire-and-forget send for control text and deltas; a host send
   * failure surfaces on the socket, not here. */
  #sendSafe(data: string | Uint8Array): void {
    try {
      const result = this.#send(data);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // socket already gone; close handling is the host's job
    }
  }

  sendHeartbeat(): void {
    this.#sendSafe(
      JSON.stringify({
        event: 'heartbeat',
        data: { timestamp: this.#clock() },
      }),
    );
  }

  sendWake(reason: WakeReason): void {
    this.wakePending = true;
    this.#sendSafe(
      JSON.stringify({
        event: 'sync',
        data: {
          cursor: this.lastKnownSeq,
          requiresPull: true,
          reason,
          timestamp: this.#clock(),
        },
      }),
    );
    const events = this.#events;
    if (events !== undefined) {
      emitEvent(events, {
        type: 'realtime.wake',
        atMs: this.#clock(),
        partition: this.partition,
        actorId: this.actorId,
        clientId: this.clientId,
        sessionId: this.sessionId,
        reason,
      });
    }
  }

  /** Called by the hub for every applied commit, in commitSeq order. */
  deliverCommit(commit: StoredCommit): void {
    this.lastKnownSeq = Math.max(this.lastKnownSeq, commit.commitSeq);
    const sections: Array<{
      registration: Registration;
      changes: CommitChange[];
    }> = [];
    for (const registration of this.registrations) {
      const changes = commit.changes
        .filter(
          (change) =>
            change.table === registration.table &&
            matchesEffective(change.scopes, registration.effective),
        )
        .map(
          (change): CommitChange => ({
            tableIndex: 0,
            rowId: change.rowId,
            op: change.op,
            ...(change.rowVersion !== undefined
              ? { rowVersion: change.rowVersion }
              : {}),
            scopes: change.scopes,
            ...(change.payload !== undefined ? { row: change.payload } : {}),
          }),
        );
      if (changes.length > 0) sections.push({ registration, changes });
    }
    if (sections.length === 0) return;
    if (this.#activeRound !== undefined) {
      // §8.7 interleaving: no 0x00 messages while a response stream is
      // in flight — the §8.2 suppression path takes over (the client's
      // post-round ack lifts it when the round covered this commit).
      this.sendWake('catchup-required');
      return;
    }
    if (this.wakePending) {
      // §8.2: deltas must be cursor-contiguous; while the client is behind
      // we send (coalescible) wake-ups instead of a delta past its cursor.
      this.sendWake('catchup-required');
      return;
    }
    const frames: ResponseFrame[] = [{ type: 'RESP_HEADER' }];
    for (const section of sections) {
      frames.push({
        type: 'SUB_START',
        id: section.registration.id,
        status: 'active',
        reasonCode: '',
        effectiveScopes: section.registration.effective,
        bootstrap: false,
      });
      frames.push({
        type: 'COMMIT',
        commitSeq: commit.commitSeq,
        createdAtMs: commit.createdAtMs,
        actorId: commit.actorId,
        tables: [section.registration.table],
        changes: section.changes,
      });
      frames.push({ type: 'SUB_END', nextCursor: commit.commitSeq });
    }
    const bytes = encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'response',
      frames,
    });
    if (bytes.length > this.#maxDeltaBytes) {
      this.sendWake('delta-too-large');
      return;
    }
    // §8.7: standalone deltas carry channel tag 0x00.
    const tagged = new Uint8Array(bytes.length + 1);
    tagged[0] = REALTIME_TAG_DELTA;
    tagged.set(bytes, 1);
    this.#sendSafe(tagged);
    this.cursor = commit.commitSeq;
    const events = this.#events;
    if (events !== undefined) {
      emitEvent(events, {
        type: 'realtime.delta',
        atMs: this.#clock(),
        partition: this.partition,
        actorId: this.actorId,
        clientId: this.clientId,
        sessionId: this.sessionId,
        commitSeq: commit.commitSeq,
        bytes: bytes.length,
        changes: sections.reduce((n, s) => n + s.changes.length, 0),
      });
    }
  }

  close(): void {
    this.#hub.disconnect(this);
  }
}

export class RealtimeHub {
  readonly #config: RealtimeHubConfig;
  readonly #schema: CompiledSchema;
  readonly #sessions = new Set<RealtimeSession>();

  constructor(config: RealtimeHubConfig) {
    this.#config = config;
    this.#schema = compileSchema(config.schema);
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Resolve the client record's subscription list into per-connection
   * registrations (§8.1 at upgrade; §8.7 at socket-round end).
   */
  async loadRegistrations(
    partition: string,
    actorId: string,
    clientId: string,
  ): Promise<Registration[]> {
    const record = await this.#config.storage.getClientRecord(
      partition,
      clientId,
    );
    let resolved: ResolvedScopes;
    try {
      const allowed = await this.#config.resolveScopes({
        partition,
        actorId,
      });
      resolved = { ok: true, allowed };
    } catch (error) {
      const events = this.#config.events;
      if (events !== undefined) {
        const clock = this.#config.clock ?? Date.now;
        emitEvent(events, {
          type: 'scopes.resolve_failed',
          atMs: clock(),
          partition,
          actorId,
          phase: 'realtime',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      resolved = { ok: false };
    }
    const registrations: Registration[] = [];
    for (const subscription of record?.subscriptions ?? []) {
      const table = this.#schema.tables.get(subscription.table);
      if (table === undefined) continue;
      const keysValid = Object.keys(subscription.scopes).every((key) =>
        table.declaredVariables.has(key),
      );
      if (!keysValid) continue;
      const outcome = computeEffective(subscription.scopes, resolved);
      if (outcome.status !== 'active') continue;
      registrations.push({
        id: subscription.id,
        table: subscription.table,
        effective: outcome.effective,
      });
    }
    return registrations;
  }

  /**
   * Build the per-round request context for a socket sync round (§8.7):
   * the same shape the HTTP adapter builds, so the round drives the
   * SAME handler with zero semantic divergence.
   */
  requestContext(session: RealtimeSession) {
    const segments = this.#config.segments;
    if (segments === undefined) {
      // Fail loud (§8.7): a hub serving socket rounds needs the same
      // segment store the HTTP binding uses — never a degraded round.
      throw syncError(
        'sync.invalid_request',
        'socket sync rounds require a segment store on the realtime hub (§8.7)',
      );
    }
    return {
      partition: session.partition,
      actorId: session.actorId,
      schema: this.#config.schema,
      storage: this.#config.storage,
      segments,
      resolveScopes: this.#config.resolveScopes,
      ...(this.#config.clock !== undefined
        ? { clock: this.#config.clock }
        : {}),
      ...(this.#config.limits !== undefined
        ? { limits: this.#config.limits }
        : {}),
      ...(this.#config.signedUrls !== undefined
        ? { signedUrls: this.#config.signedUrls }
        : {}),
      ...(this.#config.events !== undefined
        ? { events: this.#config.events }
        : {}),
      realtime: this,
    };
  }

  /**
   * Register a connected socket (§8.1): load the client's last pull's
   * subscription list, resolve + intersect scopes, send `hello`.
   */
  async connect(options: RealtimeConnectOptions): Promise<RealtimeSession> {
    const { storage } = this.#config;
    const clock = this.#config.clock ?? Date.now;
    const record = await storage.getClientRecord(
      options.partition,
      options.clientId,
    );
    if (record !== undefined && record.actorId !== options.actorId) {
      throw syncError(
        'sync.invalid_client_id',
        'clientId is bound to a different actor in this partition (§1.5)',
      );
    }
    const registrations = await this.loadRegistrations(
      options.partition,
      options.actorId,
      options.clientId,
    );
    const latestSeq = await storage.getMaxCommitSeq(options.partition);
    const cursor = record?.cursor ?? -1;
    const session = new RealtimeSession(
      this,
      options,
      registrations,
      cursor,
      latestSeq,
      clock,
      this.#config.maxDeltaBytes ?? DEFAULT_MAX_DELTA_BYTES,
      storage,
      this.#config.events,
    );
    this.#sessions.add(session);
    const helloResult = options.send(
      JSON.stringify({
        event: 'hello',
        data: {
          protocolVersion: 1,
          sessionId: session.sessionId,
          actorId: options.actorId,
          clientId: options.clientId,
          cursor,
          latestCursor: latestSeq,
          requiresSync: record === undefined || cursor < latestSeq,
          timestamp: clock(),
        },
      }),
    );
    if (helloResult instanceof Promise) helloResult.catch(() => {});
    const events = this.#config.events;
    if (events !== undefined) {
      emitEvent(events, {
        type: 'realtime.opened',
        atMs: clock(),
        partition: options.partition,
        actorId: options.actorId,
        clientId: options.clientId,
        sessionId: session.sessionId,
        registrations: registrations.length,
        cursor,
        latestSeq,
      });
    }
    return session;
  }

  disconnect(session: RealtimeSession): void {
    if (!this.#sessions.delete(session)) return;
    const events = this.#config.events;
    if (events !== undefined) {
      const clock = this.#config.clock ?? Date.now;
      const now = clock();
      emitEvent(events, {
        type: 'realtime.closed',
        atMs: now,
        partition: session.partition,
        actorId: session.actorId,
        clientId: session.clientId,
        sessionId: session.sessionId,
        durationMs: now - session.openedAtMs,
      });
    }
  }

  /** RealtimeNotifier: fan an applied commit out to matching sessions. */
  async notifyCommit(partition: string, commit: StoredCommit): Promise<void> {
    for (const session of this.#sessions) {
      if (session.partition !== partition) continue;
      session.deliverCommit(commit);
    }
  }

  /** Broadcast a wake-up (host-initiated resync, schema rollover, §8.3). */
  wake(partition: string, reason: WakeReason): void {
    for (const session of this.#sessions) {
      if (session.partition !== partition) continue;
      session.sendWake(reason);
    }
  }
}

export function createRealtimeHub(config: RealtimeHubConfig): RealtimeHub {
  return new RealtimeHub(config);
}

/** §8.7 failures: the socket has no HTTP status surface, so a
 * request-level failure becomes a minimal RESP_HEADER/ERROR/END
 * response message delivered as the round's response stream. */
function errorResponseBytes(error: SyncError): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'response',
    frames: [
      { type: 'RESP_HEADER' },
      {
        type: 'ERROR',
        code: error.code,
        message: error.message,
        category: error.category,
        retryable: error.retryable,
        recommendedAction: error.recommendedAction,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    ],
  });
}
