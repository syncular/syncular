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
  encodePresenceError,
  encodePresenceFanout,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  type PresenceKind,
  parseRealtimePresencePublish,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type ResponseFrame,
  type ScopeMap,
  type WakeReason,
} from '@syncular/core';
import type { SyncRequestContext, SyncServerConfig } from './context';
import { RESOLVER_OUTAGE } from './context';
import { SyncError, syncError } from './errors';
import { emitEvent, type SyncularServerEvents } from './events';
import { createSyncResponseStream } from './handler';
import { type CompiledSchema, compileSchema } from './schema';
import {
  computeEffective,
  matchesEffective,
  type ResolvedScopes,
} from './scopes';
import type { ServerStorage, StoredCommit } from './storage';

/**
 * Realtime adds fanout/presence tuning to the canonical sync-server config;
 * socket rounds must never have a narrower push/pull capability set than HTTP.
 */
export interface RealtimeHubConfig extends Omit<SyncServerConfig, 'realtime'> {
  /** Deltas larger than this become `delta-too-large` wake-ups (§8.2). */
  readonly maxDeltaBytes?: number;
  /**
   * §8.6 presence: cap on the serialized size (bytes) of a published
   * presence document. An over-cap publish is rejected loudly to the
   * publisher with `presence.too_large` and fans out nothing. Default 16 KiB.
   */
  readonly maxPresenceBytes?: number;
  /**
   * §8.6.4 presence rate cap: minimum ms between fanned-out publishes per
   * connection per scope key. Absent ⇒ off (the reference default): every
   * publish fans out immediately. When set, publishes exceeding the cap
   * coalesce latest-wins into at most one `update` per window (never an
   * error, never a stale or lost latest document).
   */
  readonly presenceMinIntervalMs?: number;
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
const DEFAULT_MAX_PRESENCE_BYTES = 16 * 1024;

type PresenceDoc = Record<string, unknown>;

/**
 * §8.6 presence registry — pure in-memory ephemeral state, keyed per
 * `(partition, scopeKey)` → the set of present sessions and their
 * documents. It never touches `ServerStorage`; a server restart loses all
 * presence (§8.6.1). Fanout is scoped to registered peers only — the
 * privacy floor (§8.6.3).
 */
class PresenceRegistry {
  /** partition → scopeKey → session → document. */
  readonly #byKey = new Map<
    string,
    Map<string, Map<RealtimeSession, PresenceDoc>>
  >();

  #keyMap(
    partition: string,
    scopeKey: string,
  ): Map<RealtimeSession, PresenceDoc> {
    let byScope = this.#byKey.get(partition);
    if (byScope === undefined) {
      byScope = new Map();
      this.#byKey.set(partition, byScope);
    }
    let sessions = byScope.get(scopeKey);
    if (sessions === undefined) {
      sessions = new Map();
      byScope.set(scopeKey, sessions);
    }
    return sessions;
  }

  /** Current documents on a key, excluding one session (the snapshot,
   * §8.6.4). */
  snapshot(
    partition: string,
    scopeKey: string,
    exclude: RealtimeSession,
  ): Array<{ session: RealtimeSession; doc: PresenceDoc }> {
    const sessions = this.#byKey.get(partition)?.get(scopeKey);
    if (sessions === undefined) return [];
    const out: Array<{ session: RealtimeSession; doc: PresenceDoc }> = [];
    for (const [session, doc] of sessions) {
      if (session !== exclude) out.push({ session, doc });
    }
    return out;
  }

  /** Store/replace a session's document for a key. Returns whether this is
   * the session's FIRST document on the key (join) or a replacement
   * (update). */
  set(
    partition: string,
    scopeKey: string,
    session: RealtimeSession,
    doc: PresenceDoc,
  ): 'join' | 'update' {
    const sessions = this.#keyMap(partition, scopeKey);
    const kind = sessions.has(session) ? 'update' : 'join';
    sessions.set(session, doc);
    return kind;
  }

  /** Remove a session's document for a key. Returns true if one existed. */
  clear(
    partition: string,
    scopeKey: string,
    session: RealtimeSession,
  ): boolean {
    const sessions = this.#byKey.get(partition)?.get(scopeKey);
    if (sessions === undefined) return false;
    const existed = sessions.delete(session);
    if (sessions.size === 0) this.#byKey.get(partition)?.delete(scopeKey);
    return existed;
  }

  /** Every key a session currently holds a document on (for leave-on-drop
   * and registration-change re-derivation). */
  keysOf(partition: string, session: RealtimeSession): string[] {
    const byScope = this.#byKey.get(partition);
    if (byScope === undefined) return [];
    const keys: string[] = [];
    for (const [scopeKey, sessions] of byScope) {
      if (sessions.has(session)) keys.push(scopeKey);
    }
    return keys;
  }

  /** Sessions currently registered as peers on a key (for fanout). */
  peers(partition: string, scopeKey: string): RealtimeSession[] {
    const sessions = this.#byKey.get(partition)?.get(scopeKey);
    return sessions === undefined ? [] : [...sessions.keys()];
  }
}

/** The scope keys a set of registrations covers (§3.1: `prefix:value`). A
 * registration's effective scopes are variable → values; a scope key is
 * `prefix:value` for each declared value. */
function registrationScopeKeys(
  registrations: readonly Registration[],
  schema: CompiledSchema,
): Set<string> {
  const keys = new Set<string>();
  for (const registration of registrations) {
    const table = schema.tables.get(registration.table);
    if (table === undefined) continue;
    for (const [variable, values] of Object.entries(registration.effective)) {
      const pattern = table.scopePatterns.find((p) => p.variable === variable);
      if (pattern === undefined) continue;
      for (const value of values) keys.add(`${pattern.prefix}:${value}`);
    }
  }
  return keys;
}

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
  /** §8.6.4 rate cap: per-scope-key last-fanout time + a pending latest
   * document coalesced while over the cap. */
  #presenceRate = new Map<
    string,
    {
      lastFanoutMs: number;
      pending?: PresenceDoc;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

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

  /** Feed an inbound text frame (client → server control message, §8.2
   * ack, §8.6.2 presence). */
  handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // tolerate unknown/garbled control messages
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    // §8.6.2: client→server presence carries `event: 'presence'` (server
    // control messages carry `event`; the ack carries `type`, §8.1).
    if ((parsed as { event?: unknown }).event === 'presence') {
      this.#handlePresence(text);
      return;
    }
    if ((parsed as { type?: unknown }).type !== 'ack') return;
    const cursor = (parsed as { cursor?: unknown }).cursor;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) return;
    this.cursor = Math.max(this.cursor, cursor);
    if (this.cursor >= this.lastKnownSeq) this.wakePending = false;
    // §8.2: acks update the client cursor record without an HTTP pull.
    void this.#persistCursor();
  }

  /** §8.6.2 inbound presence publish/leave from the client. */
  #handlePresence(text: string): void {
    let publish: ReturnType<typeof parseRealtimePresencePublish>;
    try {
      publish = parseRealtimePresencePublish(text);
    } catch {
      // A malformed known event is a parse error (§8.1) — a broken client;
      // drop the connection loudly rather than silently ignore.
      this.#violation('malformed presence control message (§8.6.2)');
      return;
    }
    const { scopeKey, doc } = publish.data;
    // §8.6.3 authorization: the publish key must be in the connection's
    // registered effective scopes.
    if (!this.#currentScopeKeys().has(scopeKey)) {
      this.#sendSafe(
        encodePresenceError(scopeKey, 'presence.forbidden', this.#clock()),
      );
      return;
    }
    if (doc === null) {
      this.#leavePresence(scopeKey);
      return;
    }
    // §8.6.2 size cap: fail loud to the publisher, fan out nothing.
    const serialized = JSON.stringify(doc);
    if (serialized.length > this.#hub.maxPresenceBytes) {
      this.#sendSafe(
        encodePresenceError(scopeKey, 'presence.too_large', this.#clock()),
      );
      return;
    }
    this.#publishPresence(scopeKey, doc);
  }

  /** §8.6.4: store + fan out a publish, honoring the rate cap (latest-wins
   * coalesce). */
  #publishPresence(scopeKey: string, doc: PresenceDoc): void {
    const minInterval = this.#hub.presenceMinIntervalMs;
    if (minInterval > 0) {
      const now = this.#clock();
      const rate = this.#presenceRate.get(scopeKey);
      if (rate !== undefined && now - rate.lastFanoutMs < minInterval) {
        // Over the cap: keep only the latest document, fan it out at the
        // window edge (never an error, never a stale/lost latest, §8.6.4).
        rate.pending = doc;
        if (rate.timer === undefined) {
          const delay = minInterval - (now - rate.lastFanoutMs);
          rate.timer = setTimeout(() => {
            delete rate.timer;
            const pending = rate.pending;
            delete rate.pending;
            if (pending !== undefined) this.#fanoutPublish(scopeKey, pending);
          }, delay);
        }
        return;
      }
    }
    this.#fanoutPublish(scopeKey, doc);
  }

  #fanoutPublish(scopeKey: string, doc: PresenceDoc): void {
    const kind = this.#hub.presence.set(this.partition, scopeKey, this, doc);
    let rate = this.#presenceRate.get(scopeKey);
    if (rate === undefined) {
      rate = { lastFanoutMs: this.#clock() };
      this.#presenceRate.set(scopeKey, rate);
    } else {
      rate.lastFanoutMs = this.#clock();
    }
    this.#hub.fanoutPresence(this, scopeKey, kind, doc);
  }

  /** §8.6.1/§8.6.3: clear this session's document for a key and fan a
   * leave to the remaining peers. */
  #leavePresence(scopeKey: string): void {
    const existed = this.#hub.presence.clear(this.partition, scopeKey, this);
    const rate = this.#presenceRate.get(scopeKey);
    if (rate?.timer !== undefined) clearTimeout(rate.timer);
    this.#presenceRate.delete(scopeKey);
    if (existed) this.#hub.fanoutPresence(this, scopeKey, 'leave', null);
  }

  /** Deliver a fanout event to this session (called by the hub for peers,
   * §8.6.3 receive authorization checked by the caller). */
  receivePresence(
    scopeKey: string,
    kind: PresenceKind,
    actorId: string,
    clientId: string,
    doc: PresenceDoc | null,
  ): void {
    this.#sendSafe(
      encodePresenceFanout(
        scopeKey,
        kind,
        actorId,
        clientId,
        doc,
        this.#clock(),
      ),
    );
  }

  /** The scope keys this connection currently holds (§8.6.3). */
  #currentScopeKeys(): Set<string> {
    return this.#hub.scopeKeysOf(this.registrations);
  }

  /** §8.6.3: drop presence on keys the connection no longer holds and
   * deliver the snapshot on keys it newly holds. Called after a
   * registration change (§8.7 round end, §8.1 reconnect handled by
   * connect's snapshot). */
  reconcilePresence(previousKeys: ReadonlySet<string>): void {
    const currentKeys = this.#currentScopeKeys();
    // Keys lost: leave my own published docs; presence delivery stops
    // naturally (peers no longer fan to me — I am not registered).
    for (const key of previousKeys) {
      if (!currentKeys.has(key)) this.#leavePresence(key);
    }
    // Keys gained: deliver the snapshot of already-present peers.
    for (const key of currentKeys) {
      if (!previousKeys.has(key)) this.#deliverSnapshot(key);
    }
  }

  /** §8.6.4 snapshot: a burst of `join`s for peers already present on a
   * key, delivered to this session only. */
  #deliverSnapshot(scopeKey: string): void {
    for (const peer of this.#hub.presence.snapshot(
      this.partition,
      scopeKey,
      this,
    )) {
      this.receivePresence(
        scopeKey,
        'join',
        peer.session.actorId,
        peer.session.clientId,
        peer.doc,
      );
    }
  }

  /** §8.6.1: on disconnect, leave every key this session was present on. */
  dropAllPresence(): void {
    for (const key of this.#hub.presence.keysOf(this.partition, this)) {
      this.#leavePresence(key);
    }
    for (const rate of this.#presenceRate.values()) {
      if (rate.timer !== undefined) clearTimeout(rate.timer);
    }
    this.#presenceRate.clear();
  }

  /** Snapshot delivery on connect (§8.6.4) — the newly-registered
   * connection sees who is already present on each of its keys. */
  deliverInitialPresence(): void {
    for (const key of this.#currentScopeKeys()) this.#deliverSnapshot(key);
  }

  /**
   * Feed an inbound binary frame: a `0x01`-tagged chunk of the sync
   * round's request byte stream (§8.7). Synchronous entry — assembly and
   * violation detection happen inline so a pipelined chunk arriving
   * while a response streams is caught deterministically; the round
   * itself runs async once the request is complete. The returned promise, when
   * present, resolves only after response streaming and registration refresh;
   * coordinated hosts await it to retain their partition FIFO through commit.
   */
  handleBinary(bytes: Uint8Array): Promise<void> | undefined {
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
    return this.#runRound(done.message.slice(), token);
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
    // §8.6.3: a registration change re-derives the presence grant — capture
    // the keys before, reconcile after (leaves on lost keys, snapshots on
    // gained keys).
    const previousKeys = this.#currentScopeKeys();
    try {
      this.registrations = await this.#hub.loadRegistrations(
        this.partition,
        this.actorId,
        this.clientId,
      );
    } catch {
      // Fail closed: an unreadable record or resolver failure leaves the
      // previous registrations in place; the next round repairs it.
      return;
    }
    this.reconcilePresence(previousKeys);
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
  /** §8.6 presence registry — ephemeral, in-memory, never persisted. */
  readonly presence = new PresenceRegistry();

  constructor(config: RealtimeHubConfig) {
    this.#config = config;
    this.#schema = compileSchema(config.schema);
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** §8.6.2 published-document size cap (bytes). */
  get maxPresenceBytes(): number {
    return this.#config.maxPresenceBytes ?? DEFAULT_MAX_PRESENCE_BYTES;
  }

  /** §8.6.4 presence rate cap (ms); 0 = off (reference default). */
  get presenceMinIntervalMs(): number {
    return this.#config.presenceMinIntervalMs ?? 0;
  }

  /** §8.6.3: the scope keys a set of registrations covers. */
  scopeKeysOf(registrations: readonly Registration[]): Set<string> {
    return registrationScopeKeys(registrations, this.#schema);
  }

  /**
   * §8.6.3 fanout: deliver a presence change to every OTHER session
   * registered on the key (the privacy floor — only current scope-mates).
   * The publisher does not receive its own fanout.
   */
  fanoutPresence(
    origin: RealtimeSession,
    scopeKey: string,
    kind: PresenceKind,
    doc: PresenceDoc | null,
  ): void {
    for (const session of this.#sessions) {
      if (session === origin) continue;
      if (session.partition !== origin.partition) continue;
      // Receive authorization (§8.6.3): the receiver must itself hold the key.
      if (!this.scopeKeysOf(session.registrations).has(scopeKey)) continue;
      session.receivePresence(
        scopeKey,
        kind,
        origin.actorId,
        origin.clientId,
        doc,
      );
    }
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
        clientId,
      });
      // §7.3.3: delta-fanout registration needs live scopes — an outage
      // registers nothing (the client's next socket round, §8.7, is
      // lease-aware and re-registers at round end, §8.1).
      resolved =
        allowed === RESOLVER_OUTAGE ? { ok: false } : { ok: true, allowed };
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
  requestContextFor(identity: {
    readonly partition: string;
    readonly actorId: string;
  }): SyncRequestContext {
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
      partition: identity.partition,
      actorId: identity.actorId,
      schema: this.#config.schema,
      storage: this.#config.storage,
      segments,
      resolveScopes: this.#config.resolveScopes,
      ...(this.#config.blobs !== undefined
        ? { blobs: this.#config.blobs }
        : {}),
      ...(this.#config.maxBlobBytes !== undefined
        ? { maxBlobBytes: this.#config.maxBlobBytes }
        : {}),
      ...(this.#config.crdtMergers !== undefined
        ? { crdtMergers: this.#config.crdtMergers }
        : {}),
      ...(this.#config.validators !== undefined
        ? { validators: this.#config.validators }
        : {}),
      ...(this.#config.commitValidator !== undefined
        ? { commitValidator: this.#config.commitValidator }
        : {}),
      ...(this.#config.clock !== undefined
        ? { clock: this.#config.clock }
        : {}),
      ...(this.#config.limits !== undefined
        ? { limits: this.#config.limits }
        : {}),
      ...(this.#config.signedUrls !== undefined
        ? { signedUrls: this.#config.signedUrls }
        : {}),
      ...(this.#config.blobSignedUrls !== undefined
        ? { blobSignedUrls: this.#config.blobSignedUrls }
        : {}),
      ...(this.#config.blobUploadUrls !== undefined
        ? { blobUploadUrls: this.#config.blobUploadUrls }
        : {}),
      ...(this.#config.sqliteImageBuilder !== undefined
        ? { sqliteImageBuilder: this.#config.sqliteImageBuilder }
        : {}),
      ...(this.#config.leases !== undefined
        ? { leases: this.#config.leases }
        : {}),
      ...(this.#config.events !== undefined
        ? { events: this.#config.events }
        : {}),
      realtime: this,
    };
  }

  requestContext(session: RealtimeSession): SyncRequestContext {
    return this.requestContextFor(session);
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
    // §8.6.4: the newly-registered connection sees who is already present
    // on each key it holds (a burst of joins, after hello).
    session.deliverInitialPresence();
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
    // §8.6.1: lost on disconnect ⇒ leave emitted for every held key. Done
    // AFTER removing from the set so the leaving session is not fanned to.
    session.dropAllPresence();
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
