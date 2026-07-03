/**
 * The ONE apply-path invalidation choke point (TODO 3.1 / DESIGN-eviction
 * I1–I4). Every local mutation — `COMMIT` apply, segment apply (rows +
 * sqlite images), optimistic overlay rebuild, revocation purge, schema-bump
 * reset, and (future) window eviction — routes its touched keys through a
 * single {@link Invalidation} accumulator, and the client emits exactly ONE
 * {@link InvalidationEvent} per apply batch (never per row). Live queries
 * subscribe via `SyncClient.onInvalidate` and re-run only when a table they
 * depend on appears.
 *
 * Granularity truth (honest to the wire, §4.5 / §5.2):
 * - `COMMIT` changes carry per-row `scopes` (variable → value), so their
 *   `prefix:value` scope keys (§3.1 vocabulary, I2) are emitted precisely.
 * - Segments carry only a table + `scopeDigest`, NOT per-row scope keys, so
 *   a segment apply invalidates at the **table** granularity plus the
 *   subscription's requested/effective scope keys (the coarsest honest key
 *   the wire supports for bulk data).
 * - Purge / reset / optimistic / eviction are keyed by table (and effective
 *   scope keys where a scope map is in hand).
 *
 * `tables` is therefore always the reliable floor; `scopeKeys` is a
 * best-effort refinement present where the source carried it. A live query
 * that cannot express its scope footprint keys off `tables` alone.
 */
import type { ScopeMap } from '@syncular-v2/core';
import type { CompiledClientTable } from './schema';

/** One coalesced invalidation batch (I1). Empty batches are not emitted. */
export interface InvalidationEvent {
  /** Tables whose local rows changed this batch — the reliable floor. */
  readonly tables: ReadonlySet<string>;
  /** `prefix:value` scope keys touched, where the source carried them (I2). */
  readonly scopeKeys: ReadonlySet<string>;
}

export type InvalidationListener = (event: InvalidationEvent) => void;

/**
 * A per-batch accumulator. One is created at the top of each apply batch,
 * fed by the apply paths, and flushed once at the batch boundary. Mutable
 * and cheap on purpose — no allocation until something is actually touched.
 */
export class Invalidation {
  #tables: Set<string> | undefined;
  #scopeKeys: Set<string> | undefined;

  /** Mark a whole table dirty (the floor for any apply). */
  table(name: string): void {
    if (this.#tables === undefined) this.#tables = new Set();
    this.#tables.add(name);
  }

  /** Add a raw `prefix:value` scope key (§3.1). */
  scopeKey(key: string): void {
    if (this.#scopeKeys === undefined) this.#scopeKeys = new Set();
    this.#scopeKeys.add(key);
  }

  /**
   * Add the `prefix:value` keys for an effective/requested scope map on
   * `table` (variable → list(value)), skipping variables the table has no
   * prefix for (never guesses a key).
   */
  scopeMap(table: CompiledClientTable, scopes: ScopeMap): void {
    for (const [variable, values] of Object.entries(scopes)) {
      const prefix = table.scopePrefixByVariable.get(variable);
      if (prefix === undefined) continue;
      for (const v of values) this.scopeKey(`${prefix}:${v}`);
    }
  }

  /** A COMMIT change's stored scopes (variable → single value, §4.5). */
  changeScopes(
    table: CompiledClientTable,
    scopes: Record<string, string>,
  ): void {
    for (const [variable, value] of Object.entries(scopes)) {
      const prefix = table.scopePrefixByVariable.get(variable);
      if (prefix !== undefined) this.scopeKey(`${prefix}:${value}`);
    }
  }

  get touched(): boolean {
    return this.#tables !== undefined || this.#scopeKeys !== undefined;
  }

  /** Freeze into an event, or undefined when nothing was touched. */
  finish(): InvalidationEvent | undefined {
    if (!this.touched) return undefined;
    return {
      tables: this.#tables ?? EMPTY,
      scopeKeys: this.#scopeKeys ?? EMPTY,
    };
  }
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * A tiny subscribable listener set. Notification is synchronous and
 * exception-isolated (one throwing listener never starves the rest, and
 * never corrupts the emitting apply path). Reused by the worker handle so
 * both cores expose the identical `onInvalidate` surface.
 */
export class InvalidationEmitter {
  readonly #listeners = new Set<InvalidationListener>();

  on(listener: InvalidationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: InvalidationEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A UI listener must never break the apply path (I1).
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}
