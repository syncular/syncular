/**
 * A controllable in-memory `SyncClientLike` for deterministic hook tests:
 * an actual query surface (a tiny row store keyed by table), a manual
 * `emitInvalidate` to fire the choke-point event, and presence/status
 * accessors. It exercises the SAME `SyncClientLike` interface the real
 * `SyncClient` and `SyncClientHandle` satisfy, so the hook logic under test
 * is the shipped logic — only the substrate is a fake.
 */
import type {
  ConflictRecord,
  InvalidationEvent,
  InvalidationListener,
  LeaseState,
  MutationInput,
  PresencePeer,
  RejectionRecord,
  SchemaFloor,
  SqlRow,
  WindowBase,
  WindowState,
} from '@syncular-v2/web-client';
import type { SyncClientLike } from '../src/client';

export class FakeClient implements SyncClientLike {
  #invalidation = new Set<InvalidationListener>();
  #presenceListeners = new Set<(scopeKey: string) => void>();
  #rows = new Map<string, SqlRow[]>();
  #presence = new Map<string, PresencePeer[]>();
  #conflicts: ConflictRecord[] = [];
  #rejections: RejectionRecord[] = [];
  #pending: unknown[] = [];
  #upgrading = false;
  #leaseState: LeaseState | undefined;
  #schemaFloor: SchemaFloor | undefined;
  #syncNeeded = false;
  /** Count query invocations to assert re-runs (I4). */
  queryCount = 0;

  setRows(table: string, rows: SqlRow[]): void {
    this.#rows.set(table, rows);
  }

  seedPresence(scopeKey: string, peers: PresencePeer[]): void {
    this.#presence.set(scopeKey, peers);
  }

  setPending(commits: unknown[]): void {
    this.#pending = commits;
  }

  setConflicts(conflicts: ConflictRecord[]): void {
    this.#conflicts = conflicts;
  }

  setUpgrading(value: boolean): void {
    this.#upgrading = value;
  }

  setLeaseState(value: LeaseState | undefined): void {
    this.#leaseState = value;
  }

  setSchemaFloor(value: SchemaFloor | undefined): void {
    this.#schemaFloor = value;
  }

  /** Fire an apply-batch invalidation to every listener (the choke point). */
  emitInvalidate(tables: string[], scopeKeys: string[] = []): void {
    const event: InvalidationEvent = {
      tables: new Set(tables),
      scopeKeys: new Set(scopeKeys),
    };
    for (const listener of this.#invalidation) listener(event);
  }

  /** Fire a presence change to every listener. */
  emitPresence(scopeKey: string): void {
    for (const listener of this.#presenceListeners) listener(scopeKey);
  }

  // -- SyncClientLike --------------------------------------------------------

  onInvalidate(listener: InvalidationListener): () => void {
    this.#invalidation.add(listener);
    return () => this.#invalidation.delete(listener);
  }

  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  query(sql: string): SqlRow[] {
    this.queryCount += 1;
    // Return rows for whichever known table name appears in the SQL text.
    for (const [table, rows] of this.#rows) {
      if (sql.includes(table)) return rows;
    }
    return [];
  }

  mutate(_mutations: readonly MutationInput[]): string {
    return 'commit-id';
  }

  presence(scopeKey: string): readonly PresencePeer[] {
    return this.#presence.get(scopeKey) ?? [];
  }

  setPresence(_scopeKey: string, _doc: Record<string, unknown> | null): void {
    // No-op: presence publish is not exercised by the hook tests.
  }

  #windowUnits = new Map<string, string[]>();

  #windowKey(base: WindowBase): string {
    return `${base.table} ${base.variable}`;
  }

  setWindow(base: WindowBase, units: readonly string[]): void {
    this.#windowUnits.set(this.#windowKey(base), [...units]);
    // A window change touches the base table — the useWindow hook re-reads.
    this.emitInvalidate([base.table]);
  }

  windowState(base: WindowBase): WindowState {
    return { units: this.#windowUnits.get(this.#windowKey(base)) ?? [] };
  }

  // These four are getters on the real SyncClient — as plain values here,
  // the normalizer resolves both shapes.
  get conflicts(): readonly ConflictRecord[] {
    return this.#conflicts;
  }

  get rejections(): readonly RejectionRecord[] {
    return this.#rejections;
  }

  get schemaFloor(): SchemaFloor | undefined {
    return this.#schemaFloor;
  }

  get leaseState(): LeaseState | undefined {
    return this.#leaseState;
  }

  get upgrading(): boolean {
    return this.#upgrading;
  }

  get syncNeeded(): boolean {
    return this.#syncNeeded;
  }

  pendingCommits(): unknown[] {
    return this.#pending;
  }

  setSyncNeeded(value: boolean): void {
    this.#syncNeeded = value;
  }
}
