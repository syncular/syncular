/**
 * Realtime channel (SPEC.md §8) — transport-agnostic.
 *
 * A `RealtimeSession` wraps a connected socket's send/receive callbacks:
 * the host feeds inbound text frames to `handleMessage` and wires
 * `session.close()` to socket close. Subscription registration comes from
 * the client's most recent HTTP pull (§8.1, loaded from the client
 * record); deltas are complete SSP2 response messages pushed as binary
 * (§8.2); the only JSON data-plane server event is the `sync` wake-up
 * (§8.3).
 */
import {
  type CommitChange,
  encodeMessage,
  PROTOCOL_WIRE_VERSION,
  type ResponseFrame,
  type ScopeMap,
  type WakeReason,
} from '@syncular-v2/core';
import type { ResolveScopes } from './context';
import { syncError } from './errors';
import type { ServerSchema } from './schema';
import { type CompiledSchema, compileSchema } from './schema';
import {
  computeEffective,
  matchesEffective,
  type ResolvedScopes,
} from './scopes';
import type { ServerStorage, StoredCommit } from './storage';

export interface RealtimeHubConfig {
  readonly schema: ServerSchema;
  readonly storage: ServerStorage;
  readonly resolveScopes: ResolveScopes;
  readonly clock?: () => number;
  /** Deltas larger than this become `delta-too-large` wake-ups (§8.2). */
  readonly maxDeltaBytes?: number;
}

export interface RealtimeConnectOptions {
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  /** Socket send: JSON control messages as text, deltas as bytes (§8.1). */
  readonly send: (data: string | Uint8Array) => void;
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
  readonly registrations: readonly Registration[];
  #send: (data: string | Uint8Array) => void;
  #hub: RealtimeHub;
  #clock: () => number;
  #maxDeltaBytes: number;
  #storage: ServerStorage;

  constructor(
    hub: RealtimeHub,
    options: RealtimeConnectOptions,
    registrations: readonly Registration[],
    cursor: number,
    latestSeq: number,
    clock: () => number,
    maxDeltaBytes: number,
    storage: ServerStorage,
  ) {
    this.sessionId = crypto.randomUUID();
    this.partition = options.partition;
    this.actorId = options.actorId;
    this.clientId = options.clientId;
    this.cursor = cursor;
    this.lastKnownSeq = latestSeq;
    this.wakePending = cursor < latestSeq;
    this.registrations = registrations;
    this.#send = options.send;
    this.#hub = hub;
    this.#clock = clock;
    this.#maxDeltaBytes = maxDeltaBytes;
    this.#storage = storage;
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

  sendHeartbeat(): void {
    this.#send(
      JSON.stringify({
        event: 'heartbeat',
        data: { timestamp: this.#clock() },
      }),
    );
  }

  sendWake(reason: WakeReason): void {
    this.wakePending = true;
    this.#send(
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
    this.#send(bytes);
    this.cursor = commit.commitSeq;
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
    let resolved: ResolvedScopes;
    try {
      const allowed = await this.#config.resolveScopes({
        partition: options.partition,
        actorId: options.actorId,
      });
      resolved = { ok: true, allowed };
    } catch {
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
    );
    this.#sessions.add(session);
    options.send(
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
    return session;
  }

  disconnect(session: RealtimeSession): void {
    this.#sessions.delete(session);
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
