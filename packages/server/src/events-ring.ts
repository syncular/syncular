/**
 * Event ring buffer + sink composition (TODO §2.5) — the "event stream"
 * without any infrastructure dependency.
 *
 * `RingBufferEvents` is a `SyncularServerEvents` sink that retains the last
 * N events in memory and exposes a `query({type?, sinceMs?, limit})`. It
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
  /** Newest-first cap (default: the whole retained buffer). */
  readonly limit?: number;
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
      if (query.type !== undefined && event.type !== query.type) continue;
      if (query.sinceMs !== undefined && event.atMs < query.sinceMs) continue;
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
