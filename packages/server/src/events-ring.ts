/**
 * Event ring buffer + sink composition (TODO §2.5) — the "event stream"
 * without any infrastructure dependency.
 *
 * `RingBufferEvents` is a `SyncularServerEvents` sink that retains the last
 * N events in memory and exposes a `query({type?, sinceMs?, clientId?,
 * actorId?, limit})` plus a `subscribe(listener)` hook for live tails. It
 * composes with any other sink through `composeEvents(...sinks)`, so a host
 * can keep `consoleJsonEvents()` (or a Sentry adapter) AND feed the console
 * event tail from the same emissions. Fire-and-forget discipline is
 * preserved: a throwing member sink never affects the others (each emit is
 * guarded), and the ring itself never throws through.
 */
import {
  emitEvent,
  type SyncularServerEvent,
  type SyncularServerEvents,
} from './events';

export interface RingEventQuery {
  /** Restrict to one event `type` (e.g. `push.applied`). */
  readonly type?: SyncularServerEvent['type'];
  /** Only events with `atMs >= sinceMs`. */
  readonly sinceMs?: number;
  /** Restrict to events carrying this `clientId` (not every type does). */
  readonly clientId?: string;
  /** Restrict to events carrying this `actorId` (not every type does). */
  readonly actorId?: string;
  /** Newest-first cap (default: the whole retained buffer). */
  readonly limit?: number;
}

/**
 * The one matching rule shared by `RingBufferEvents.query` and live
 * subscribers (the admin SSE tail): `type` matches exactly; `clientId` /
 * `actorId` match only events that carry the field (events without a
 * client/actor identity never match an identity filter).
 */
export function matchesRingQuery(
  event: SyncularServerEvent,
  query: Omit<RingEventQuery, 'limit'>,
): boolean {
  if (query.type !== undefined && event.type !== query.type) return false;
  if (query.sinceMs !== undefined && event.atMs < query.sinceMs) return false;
  const carrier = event as { clientId?: string; actorId?: string };
  if (query.clientId !== undefined && carrier.clientId !== query.clientId) {
    return false;
  }
  if (query.actorId !== undefined && carrier.actorId !== query.actorId) {
    return false;
  }
  return true;
}

export const DEFAULT_RING_CAPACITY = 1000;

/**
 * In-memory ring of the most recent events. When full, the oldest event is
 * dropped as a new one arrives (bounded memory — the §1.4 anti-goal
 * discipline applied to observability). Events are stored by reference;
 * they are already frozen-shape JSON-able objects by the events contract,
 * so no copy is made on emit.
 */
export class RingBufferEvents implements SyncularServerEvents {
  readonly #capacity: number;
  #buffer: SyncularServerEvent[] = [];
  /** Index of the oldest element in the circular buffer. */
  #head = 0;
  #size = 0;
  /** Live subscribers (the SSE tail). Each notify is guarded. */
  readonly #listeners = new Set<(event: SyncularServerEvent) => void>();

  constructor(options?: { readonly capacity?: number }) {
    const capacity = options?.capacity ?? DEFAULT_RING_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('RingBufferEvents capacity must be a positive integer');
    }
    this.#capacity = capacity;
  }

  emit(event: SyncularServerEvent): void {
    if (this.#size < this.#capacity) {
      this.#buffer[(this.#head + this.#size) % this.#capacity] = event;
      this.#size += 1;
    } else {
      // Full: overwrite the oldest and advance the head.
      this.#buffer[this.#head] = event;
      this.#head = (this.#head + 1) % this.#capacity;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // fire-and-forget: a throwing subscriber never affects emission
      }
    }
  }

  /**
   * Subscribe to every event as it lands in the ring (the push half the
   * SSE tail needs). Returns the unsubscribe function. Listeners run
   * synchronously on the emit path under the same fire-and-forget contract
   * as sinks: a throwing listener is swallowed.
   */
  subscribe(listener: (event: SyncularServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The configured maximum number of retained events. */
  get capacity(): number {
    return this.#capacity;
  }

  /** The number of events currently retained. */
  get size(): number {
    return this.#size;
  }

  /**
   * Newest-first slice of the retained events. Filters by `type` and
   * `sinceMs`, then caps to `limit`. Returns a fresh array — the caller may
   * mutate it freely.
   */
  query(query: RingEventQuery = {}): SyncularServerEvent[] {
    const limit = query.limit ?? this.#size;
    const out: SyncularServerEvent[] = [];
    // Walk newest → oldest.
    for (let i = this.#size - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = this.#buffer[(this.#head + i) % this.#capacity];
      if (event === undefined) continue;
      if (!matchesRingQuery(event, query)) continue;
      out.push(event);
    }
    return out;
  }

  /** Drop all retained events. */
  clear(): void {
    this.#buffer = [];
    this.#head = 0;
    this.#size = 0;
  }
}

/**
 * Fan one emission out to several sinks. Each member emit is guarded, so a
 * throwing sink never affects the others or the request path (the same
 * fire-and-forget contract as `emitEvent`). Composing zero sinks yields a
 * silent no-op sink.
 */
export function composeEvents(
  ...sinks: readonly SyncularServerEvents[]
): SyncularServerEvents {
  return {
    emit(event) {
      for (const sink of sinks) {
        emitEvent(sink, event);
      }
    },
  };
}
