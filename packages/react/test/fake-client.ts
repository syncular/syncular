/**
 * A controllable in-memory `SyncClientLike` for deterministic hook tests:
 * an actual query surface (a tiny row store keyed by table), a manual
 * `emitInvalidate` to fire the choke-point event, and presence/status
 * accessors. It exercises the SAME `SyncClientLike` interface the real
 * `SyncClient` and `SyncClientHandle` satisfy, so the hook logic under test
 * is the shipped logic — only the substrate is a fake.
 */
import type {
  ClientChangeBatch,
  ClientChangeListener,
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  InvalidationEvent,
  InvalidationListener,
  LeaseState,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  ResolveCommitOutcomeInput,
  SchemaFloor,
  SqlRow,
  SyncStatusSnapshot,
  WindowBase,
  WindowState,
} from '@syncular/client';
import { windowBaseKey } from '@syncular/client';
import type { SyncClientLike } from '../src/client';

export class FakeClient implements SyncClientLike {
  #changes = new Set<ClientChangeListener>();
  #invalidation = new Set<InvalidationListener>();
  #presenceListeners = new Set<(scopeKey: string) => void>();
  #rows = new Map<string, SqlRow[]>();
  #presence = new Map<string, PresencePeer[]>();
  #conflicts: ConflictRecord[] = [];
  #rejections: RejectionRecord[] = [];
  #outcomes: CommitOutcome[] = [];
  #pending: unknown[] = [];
  #upgrading = false;
  #leaseState: LeaseState | undefined;
  #schemaFloor: SchemaFloor | undefined;
  #syncNeeded = false;
  /** Count query invocations to assert re-runs (I4). */
  queryCount = 0;
  #revision = 0n;

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

  setOutcomes(outcomes: CommitOutcome[]): void {
    this.#outcomes = outcomes;
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
    this.#emitChange({
      tables: tables.map((table) => ({
        table,
        ...(scopeKeys.length > 0 ? { scopeKeys: new Set(scopeKeys) } : {}),
      })),
      windows: [],
      conflictsChanged: false,
      rejectionsChanged: false,
    });
  }

  emitStatus(): void {
    this.#emitChange({
      tables: [],
      windows: [],
      status: this.statusSnapshot(),
      conflictsChanged: false,
      rejectionsChanged: false,
    });
  }

  emitConflicts(): void {
    this.#emitChange({
      tables: [],
      windows: [],
      conflictsChanged: true,
      rejectionsChanged: true,
    });
  }

  emitOutcomes(): void {
    this.#emitChange({
      tables: [],
      windows: [],
      conflictsChanged: false,
      rejectionsChanged: false,
      outcomesChanged: true,
    });
  }

  #emitChange(
    batch: Omit<ClientChangeBatch, 'revision' | 'outcomesChanged'> &
      Partial<Pick<ClientChangeBatch, 'outcomesChanged'>>,
  ): void {
    this.#revision += 1n;
    const revisioned: ClientChangeBatch = {
      revision: this.#revision,
      outcomesChanged: false,
      ...batch,
    };
    for (const listener of this.#changes) listener(revisioned);
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

  onChange(listener: ClientChangeListener): () => void {
    this.#changes.add(listener);
    return () => this.#changes.delete(listener);
  }

  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  query(sql: string, _params?: readonly unknown[]): SqlRow[] {
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

  patch(): string {
    return 'commit-id';
  }

  querySnapshot<Row = SqlRow>(spec: QueryReadSpec): QuerySnapshot<Row> {
    const rows = this.query(spec.sql, spec.params) as unknown as Row[];
    const pending: Array<{ baseKey: string; unit: string }> = [];
    const missing: Array<{ baseKey: string; unit: string }> = [];
    for (const coverage of spec.coverage ?? []) {
      const key = this.#windowKey(coverage.base);
      const units = this.#windowUnits.get(key) ?? [];
      const done = this.#windowBootstrapped.get(key) ?? new Set<string>();
      const baseKey = windowBaseKey(coverage.base);
      for (const unit of coverage.units) {
        if (!units.includes(unit)) missing.push({ baseKey, unit });
        else if (!done.has(unit)) pending.push({ baseKey, unit });
      }
    }
    return {
      revision: this.#revision,
      rows,
      coverage: {
        complete: pending.length === 0 && missing.length === 0,
        pending,
        missing,
      },
    };
  }

  statusSnapshot(): SyncStatusSnapshot {
    return {
      outbox: this.#pending.length,
      upgrading: this.#upgrading,
      leaseState: this.#leaseState,
      schemaFloor: this.#schemaFloor,
      syncNeeded: this.#syncNeeded,
    };
  }

  presence(scopeKey: string): readonly PresencePeer[] {
    return this.#presence.get(scopeKey) ?? [];
  }

  setPresence(_scopeKey: string, _doc: Record<string, unknown> | null): void {
    // No-op: presence publish is not exercised by the hook tests.
  }

  #windowUnits = new Map<string, string[]>();
  /** Units whose (fake) bootstrap completed — everything else is pending. */
  #windowBootstrapped = new Map<string, Set<string>>();

  #windowKey(base: WindowBase): string {
    return `${base.table} ${base.variable}`;
  }

  setWindow(base: WindowBase, units: readonly string[]): void {
    const key = this.#windowKey(base);
    this.#windowUnits.set(key, [...units]);
    // Departing units lose their bootstrap state (eviction, E3); entering
    // units start pending — `completeBootstrap` lands them.
    const done = this.#windowBootstrapped.get(key) ?? new Set<string>();
    this.#windowBootstrapped.set(
      key,
      new Set([...done].filter((unit) => units.includes(unit))),
    );
    this.#emitChange({
      tables: [],
      windows: [
        {
          baseKey: windowBaseKey(base),
          table: base.table,
          units: new Set(units),
        },
      ],
      conflictsChanged: false,
      rejectionsChanged: false,
    });
  }

  /**
   * Test control: complete the fake bootstrap for `units` (default: every
   * registered unit) and emit the table invalidation the real client emits
   * at bootstrap completion (§4.8 — even a zero-row bootstrap flips the
   * verdict through the choke point).
   */
  completeBootstrap(base: WindowBase, units?: readonly string[]): void {
    const key = this.#windowKey(base);
    const registered = this.#windowUnits.get(key) ?? [];
    const done = this.#windowBootstrapped.get(key) ?? new Set<string>();
    for (const unit of units ?? registered) done.add(unit);
    this.#windowBootstrapped.set(key, done);
    this.#emitChange({
      tables: [],
      windows: [
        {
          baseKey: windowBaseKey(base),
          table: base.table,
          units: new Set(units ?? registered),
        },
      ],
      conflictsChanged: false,
      rejectionsChanged: false,
    });
  }

  windowState(base: WindowBase): WindowState {
    const key = this.#windowKey(base);
    const units = this.#windowUnits.get(key) ?? [];
    const done = this.#windowBootstrapped.get(key) ?? new Set<string>();
    return { units, pending: units.filter((unit) => !done.has(unit)) };
  }

  // These four are getters on the real SyncClient — as plain values here,
  // the normalizer resolves both shapes.
  get conflicts(): readonly ConflictRecord[] {
    return this.#conflicts;
  }

  get rejections(): readonly RejectionRecord[] {
    return this.#rejections;
  }

  commitOutcome(clientCommitId: string): CommitOutcome | undefined {
    return this.#outcomes.find(
      (outcome) => outcome.clientCommitId === clientCommitId,
    );
  }

  commitOutcomes(query: CommitOutcomeQuery = {}): readonly CommitOutcome[] {
    const outcomes = query.activeOnly
      ? this.#outcomes.filter(
          (outcome) =>
            outcome.resolution === 'active' &&
            (outcome.status === 'conflict' || outcome.status === 'rejected'),
        )
      : this.#outcomes;
    return query.limit === undefined
      ? outcomes
      : outcomes.slice(0, query.limit);
  }

  resolveCommitOutcome(input: ResolveCommitOutcomeInput): CommitOutcome {
    const index = this.#outcomes.findIndex(
      (outcome) => outcome.clientCommitId === input.clientCommitId,
    );
    if (index < 0) throw new Error('missing fake outcome');
    const current = this.#outcomes[index] as CommitOutcome;
    const resolved: CommitOutcome = {
      ...current,
      resolution: input.resolution,
      resolvedAtMs: 1,
      ...(input.replacementClientCommitId !== undefined
        ? { replacementClientCommitId: input.replacementClientCommitId }
        : {}),
    };
    this.#outcomes[index] = resolved;
    this.emitOutcomes();
    return resolved;
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
