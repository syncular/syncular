/**
 * LISTEN/NOTIFY multi-instance fanout (TODO §4.1) — the primitive that lets
 * N server instances behind a load balancer wake each other's realtime
 * sessions when a commit lands on any one of them.
 *
 * ## The multi-instance problem
 *
 * A commit applied on instance A fans out to A's *local* RealtimeHub
 * sessions immediately (in-memory `notifyCommit`, full delta, no re-read).
 * But a client whose socket lives on instance B never saw it. LISTEN/NOTIFY
 * closes that gap:
 *
 *   1. after a commit lands, the originating instance calls `notify(payload)`
 *      → `NOTIFY syncular_commit, '<partition>:<commitSeq>'`;
 *   2. every instance runs a `listen()` loop on a dedicated connection;
 *      on a notification it parses the payload and calls
 *      `hub.wake(partition, 'sync')`.
 *
 * ## Why wake, not re-broadcast the delta
 *
 * Postgres NOTIFY payloads are capped (~8000 bytes) and are not an ordered,
 * lossless delta channel — so we do NOT try to ship commit bytes through
 * them. Remote sessions receive a `sync` wake and pull the delta from the
 * shared Postgres storage they already read from (§8.3 wake semantics). The
 * originating instance keeps the in-memory fast path (its own sessions get
 * the full delta with no extra read); only *cross-instance* delivery pays
 * the re-pull. Single-instance deployments never install a fanout at all.
 *
 * The payload carries `commitSeq` purely for observability/ordering in logs;
 * the wake itself is seq-agnostic (a session pulls whatever it is behind).
 *
 * pglite cannot exercise cross-connection NOTIFY, so the integration
 * (`postgres-fanout.integration.test.ts`) is env-gated on `SYNCULAR_PG_URL`
 * and skips cleanly; the payload encode/parse is unit-tested hermetically.
 */
import type { WakeReason } from '@syncular-v2/core';

/** The channel every syncular instance LISTENs on. */
export const FANOUT_CHANNEL = 'syncular_commit';

/**
 * The wake reason remote instances raise on a fanout notification (§8.3):
 * `catchup-required` — a commit landed on another instance, so the local
 * session pulls the delta it is now behind on from shared storage.
 */
const FANOUT_WAKE_REASON: WakeReason = 'catchup-required';

export interface FanoutPayload {
  readonly partition: string;
  readonly commitSeq: number;
}

/**
 * Encode a fanout payload as `<partition>:<commitSeq>`. The partition is
 * base64url-encoded so a partition string containing `:` cannot corrupt the
 * frame; commitSeq is a plain decimal integer.
 */
export function encodeFanoutPayload(payload: FanoutPayload): string {
  const partition = Buffer.from(payload.partition, 'utf8').toString(
    'base64url',
  );
  return `${partition}:${payload.commitSeq}`;
}

/** Parse a fanout payload; returns `undefined` for a malformed frame. */
export function parseFanoutPayload(text: string): FanoutPayload | undefined {
  const sep = text.indexOf(':');
  if (sep <= 0) return undefined;
  const partitionB64 = text.slice(0, sep);
  const seqText = text.slice(sep + 1);
  const commitSeq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(commitSeq) || commitSeq < 0) return undefined;
  if (!/^\d+$/.test(seqText)) return undefined;
  let partition: string;
  try {
    partition = Buffer.from(partitionB64, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (partition.length === 0) return undefined;
  return { partition, commitSeq };
}

/** The hub surface the fanout wakes (a `RealtimeHub` satisfies this). */
export interface FanoutWakeTarget {
  wake(partition: string, reason: WakeReason): void;
}

/**
 * A raw notification connection. Production wires a driver's LISTEN support:
 *   - node-postgres: a dedicated `Client` with `client.on('notification', …)`
 *     after `LISTEN syncular_commit`;
 *   - Bun.sql: `sql.listen(channel, handler)`.
 * The `notify` side can reuse the main pool (`SELECT pg_notify($1,$2)`), but
 * LISTEN needs its own long-lived connection.
 */
export interface PgNotificationConnection {
  /** Register a payload handler for the channel and begin listening. */
  listen(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<void> | void;
  /** Send a notification on the channel. */
  notify(channel: string, payload: string): Promise<void>;
  close?(): Promise<void>;
}

/**
 * The fanout primitive. `install(hub)` starts the LISTEN loop that wakes the
 * hub on every remote commit; `notifyCommit` is called after a local commit
 * lands to fan it to the other instances.
 */
export class PostgresFanout {
  readonly #conn: PgNotificationConnection;
  #installed = false;

  constructor(conn: PgNotificationConnection) {
    this.#conn = conn;
  }

  /** Start the LISTEN loop, waking `hub` on every notification received. */
  async install(hub: FanoutWakeTarget): Promise<void> {
    if (this.#installed) throw new Error('fanout already installed');
    this.#installed = true;
    await this.#conn.listen(FANOUT_CHANNEL, (payload) => {
      const parsed = parseFanoutPayload(payload);
      if (parsed === undefined) return; // ignore malformed frames
      hub.wake(parsed.partition, FANOUT_WAKE_REASON);
    });
  }

  /** Fan an applied commit out to the other instances. */
  async notifyCommit(partition: string, commitSeq: number): Promise<void> {
    await this.#conn.notify(
      FANOUT_CHANNEL,
      encodeFanoutPayload({ partition, commitSeq }),
    );
  }

  async close(): Promise<void> {
    await this.#conn.close?.();
  }
}
