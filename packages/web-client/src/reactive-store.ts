import {
  classifySyncAvailability,
  type SyncAvailability,
} from './availability';
import type {
  CommitOutcome,
  ClientSnapshotReader,
  QueryReadSpec,
  QuerySnapshot,
  WindowCoverage,
  WindowState,
} from './client';
import type { SqlValue } from './database';
import { ClientSyncError } from './errors';
import type {
  ClientChangeBatch,
  ClientChangeListener,
  SyncStatusSnapshot,
} from './invalidation';
import type { LeadershipState } from './multi-tab';
import { type WindowBase, windowBaseKey } from './window';

export interface QueryDependency {
  readonly table: string;
  readonly scopeKeys?: readonly string[];
}

export interface ReactiveQuerySpec<Row> {
  readonly id: string;
  readonly sql: string;
  readonly params?: readonly SqlValue[];
  readonly dependencies: readonly QueryDependency[];
  readonly coverage?: readonly WindowCoverage[];
  readonly mapRow?: (row: Readonly<Record<string, SqlValue>>) => Row;
  readonly rowKey?: (row: Row) => readonly SqlValue[];
  readonly claimCoverage?: boolean;
}

export type LiveQueryPhase =
  | 'loading'
  | 'partial'
  | 'ready'
  | 'blocked'
  | 'error';

export interface LiveQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly phase: LiveQueryPhase;
  readonly revision: bigint | undefined;
  readonly error: Error | undefined;
  readonly isRefreshing: boolean;
  readonly availability: SyncAvailability;
}

export interface ReactiveQueryClient extends Pick<
  ClientSnapshotReader,
  'statusSnapshot' | 'commitOutcomes'
> {
  readonly currentSchemaVersion?: number;
  onChange(listener: ClientChangeListener): () => void;
  querySnapshot<Row = Record<string, SqlValue>>(
    spec: QueryReadSpec,
  ): QuerySnapshot<Row> | Promise<QuerySnapshot<Row>>;
  leadershipSnapshot?(): LeadershipState | undefined;
  onLeadershipChange?(listener: (state: LeadershipState) => void): () => void;
  conflicts(): readonly unknown[] | Promise<readonly unknown[]>;
  rejections(): readonly unknown[] | Promise<readonly unknown[]>;
  setWindow(base: WindowBase, units: readonly string[]): void | Promise<void>;
  windowState(base: WindowBase): WindowState | Promise<WindowState>;
}

export interface ExternalStoreEntry<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
  refresh(): void;
}

export interface WindowRetention {
  /** Resolves once this retained claim has reached the core window. */
  readonly ready: Promise<void>;
  /** Release only this retention owner's units from the composable union. */
  readonly release: () => void;
}

export interface StatusStoreSnapshot {
  readonly status: SyncStatusSnapshot | undefined;
  readonly leadership: LeadershipState | undefined;
  readonly error: Error | undefined;
  readonly isLoading: boolean;
}

export interface ConflictStoreSnapshot<
  Conflict = unknown,
  Rejection = unknown,
> {
  readonly conflicts: readonly Conflict[];
  readonly rejections: readonly Rejection[];
  readonly error: Error | undefined;
  readonly isLoading: boolean;
}

export interface OutcomeStoreSnapshot {
  readonly outcomes: readonly CommitOutcome[];
  readonly error: Error | undefined;
  readonly isLoading: boolean;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function unsupportedCanonicalValue(value: unknown): never {
  const description = Object.prototype.toString.call(value);
  throw new TypeError(
    `unsupported reactive cache-key value ${description}; use null, string, finite number, bigint, boolean, bytes, arrays, or plain objects`,
  );
}

function encodeCanonical(value: unknown, stack: Set<object>): string {
  if (value === null) return 'n';
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return unsupportedCanonicalValue(value);
    if (Object.is(value, -0)) return 'd-0';
    return `d${value}`;
  }
  if (typeof value === 'bigint') return `i${value}`;
  if (typeof value === 'boolean') return value ? 'b1' : 'b0';
  if (value instanceof Uint8Array) {
    let hex = '';
    for (const byte of value) hex += byte.toString(16).padStart(2, '0');
    return `x${hex}`;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) return unsupportedCanonicalValue(value);
    stack.add(value);
    const encoded = `a${value.length}[${value
      .map((member) => encodeCanonical(member, stack))
      .join('')}]`;
    stack.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupportedCanonicalValue(value);
    }
    if (stack.has(value)) return unsupportedCanonicalValue(value);
    stack.add(value);
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    const encoded = `o${entries.length}{${entries
      .map(
        ([key, member]) =>
          `${encodeCanonical(key, stack)}${encodeCanonical(member, stack)}`,
      )
      .join('')}}`;
    stack.delete(value);
    return encoded;
  }
  return unsupportedCanonicalValue(value);
}

/** Lossless deterministic identity for query params, bytes, and row keys. */
export function canonicalValue(value: unknown): string {
  return encodeCanonical(value, new Set());
}

const reactiveFunctionIds = new WeakMap<
  (...args: never[]) => unknown,
  number
>();
let nextReactiveFunctionId = 1;

function reactiveFunctionId(
  fn: ((...args: never[]) => unknown) | undefined,
): number | undefined {
  if (fn === undefined) return undefined;
  let id = reactiveFunctionIds.get(fn);
  if (id === undefined) {
    id = nextReactiveFunctionId;
    nextReactiveFunctionId += 1;
    reactiveFunctionIds.set(fn, id);
  }
  return id;
}

function scheduleMicrotask(task: () => void): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(task);
  else void Promise.resolve().then(task);
}

function batchMatches<Row>(
  batch: ClientChangeBatch,
  spec: ReactiveQuerySpec<Row>,
): boolean {
  for (const change of batch.tables) {
    const dependency = spec.dependencies.find(
      (candidate) => candidate.table === change.table,
    );
    if (dependency === undefined) continue;
    if (dependency.scopeKeys === undefined || change.scopeKeys === undefined) {
      return true;
    }
    for (const key of dependency.scopeKeys) {
      if (change.scopeKeys.has(key)) return true;
    }
  }
  for (const change of batch.windows) {
    for (const coverage of spec.coverage ?? []) {
      if (windowBaseKey(coverage.base) !== change.baseKey) continue;
      if (coverage.units.some((unit) => change.units.has(unit))) return true;
    }
  }
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
      return false;
    }
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((member, index) => valuesEqual(member, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(rightRecord, key) &&
      valuesEqual(leftRecord[key], rightRecord[key]),
  );
}

function reconcileRows<Row>(
  previous: readonly Row[],
  fresh: readonly Row[],
  rowKey: ((row: Row) => readonly SqlValue[]) | undefined,
): readonly Row[] {
  if (previous.length === 0) return fresh;
  if (rowKey === undefined) {
    let changed = previous.length !== fresh.length;
    const next = fresh.map((row, index) => {
      const prior = previous[index];
      if (prior !== undefined && valuesEqual(prior, row)) return prior;
      changed = true;
      return row;
    });
    return changed ? next : previous;
  }
  const priorByKey = new Map<string, Row>();
  let duplicate = false;
  for (const row of previous) {
    const key = canonicalValue(rowKey(row));
    if (priorByKey.has(key)) duplicate = true;
    priorByKey.set(key, row);
  }
  const seen = new Set<string>();
  const next = fresh.map((row) => {
    const key = canonicalValue(rowKey(row));
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    const prior = priorByKey.get(key);
    return prior !== undefined && valuesEqual(prior, row) ? prior : row;
  });
  if (duplicate) return reconcileRows(previous, fresh, undefined);
  return next.length === previous.length &&
    next.every((row, i) => row === previous[i])
    ? previous
    : next;
}

interface CachedObservation {
  onChange(batch: ClientChangeBatch): void;
  reset(): void;
  dispose(): void;
}

/** Shared ownership for query and window observations, including abandoned renders. */
class ObservationCache {
  readonly #entries = new Map<string, CachedObservation>();
  readonly #active = new Set<CachedObservation>();
  get size(): number {
    return this.#entries.size;
  }
  get activeSize(): number {
    return this.#active.size;
  }
  get(key: string): CachedObservation | undefined {
    return this.#entries.get(key);
  }
  add(key: string, entry: CachedObservation): void {
    this.#entries.set(key, entry);
    this.#cleanup(key, entry);
  }
  activate(key: string, candidate: CachedObservation): CachedObservation {
    const entry = this.#entries.get(key) ?? candidate;
    this.#entries.set(key, entry);
    this.#active.add(entry);
    return entry;
  }
  deactivate(key: string, entry: CachedObservation): void {
    this.#active.delete(entry);
    this.#cleanup(key, entry);
  }
  #cleanup(key: string, entry: CachedObservation): void {
    scheduleMicrotask(() => {
      if (this.#active.has(entry)) return;
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      entry.reset();
    });
  }
  onChange(batch: ClientChangeBatch): void {
    for (const entry of this.#active) entry.onChange(batch);
  }
  clear(): void {
    for (const entry of this.#entries.values()) entry.dispose();
    this.#entries.clear();
    this.#active.clear();
  }
}

class QueryEntry<Row> implements ExternalStoreEntry<LiveQueryResult<Row>> {
  readonly #owner = Symbol('query-window-claim');
  readonly #listeners = new Set<() => void>();
  #state: LiveQueryResult<Row> = {
    rows: [],
    phase: 'loading',
    revision: undefined,
    error: undefined,
    isRefreshing: false,
    availability: { state: 'ready' },
  };
  #delegate: QueryEntry<Row> | undefined;
  #generation = 0;
  #scheduled = false;
  #running = false;
  #requested = false;
  #desiredRevision = 0n;
  #claimReady: Promise<void> = Promise.resolve();
  #offStatus: (() => void) | undefined;

  constructor(
    readonly store: ReactiveClientStore,
    readonly spec: ReactiveQuerySpec<Row>,
    private readonly key: string,
    private readonly cache: ObservationCache,
  ) {}

  getSnapshot = (): LiveQueryResult<Row> =>
    this.#delegate?.getSnapshot() ?? this.#state;

  subscribe = (listener: () => void): (() => void) => {
    const current = this.cache.activate(this.key, this);
    if (current !== this) {
      this.#delegate = current as QueryEntry<Row>;
      return this.#delegate.subscribe(listener);
    }
    this.#delegate = undefined;
    const notify = () => listener();
    this.#listeners.add(notify);
    if (this.#listeners.size === 1) {
      this.#offStatus = this.store.status.subscribe(() =>
        this.#onAvailabilityChange(),
      );
      this.#onAvailabilityChange();
      if (this.spec.claimCoverage !== false) {
        const claims: Promise<void>[] = [];
        for (const coverage of this.spec.coverage ?? []) {
          claims.push(
            this.store.setWindowClaim(
              this.#owner,
              coverage.base,
              coverage.units,
            ),
          );
        }
        this.#claimReady = Promise.all(claims).then(() => undefined);
        // A render can lose its last subscriber before the read loop starts.
        // The loop still observes the original rejection while it owns the claim.
        void this.#claimReady.catch(() => undefined);
      }
      this.#requestRead();
    }
    return () => {
      if (!this.#listeners.delete(notify)) return;
      if (this.#listeners.size === 0) {
        this.cache.deactivate(this.key, this);
        this.#offStatus?.();
        this.#offStatus = undefined;
        this.store.releaseWindowClaims(this.#owner);
      }
    };
  };

  refresh = (): void => {
    if (this.#delegate !== undefined) this.#delegate.refresh();
    else this.#requestRead(true);
  };

  reset(): void {
    this.#generation += 1;
    this.#scheduled = false;
    this.#running = false;
    this.#requested = false;
    this.#desiredRevision = 0n;
    this.#claimReady = Promise.resolve();
    this.#state = {
      rows: [],
      phase: 'loading',
      revision: undefined,
      error: undefined,
      isRefreshing: false,
      availability: { state: 'ready' },
    };
  }

  dispose(): void {
    this.#listeners.clear();
    this.#offStatus?.();
    this.#offStatus = undefined;
    this.store.releaseWindowClaims(this.#owner);
    this.reset();
  }

  onChange(batch: ClientChangeBatch): void {
    if (!batchMatches(batch, this.spec)) return;
    if (batch.revision > this.#desiredRevision) {
      this.#desiredRevision = batch.revision;
    }
    if (this.#listeners.size > 0) this.#requestRead();
  }

  #publish(next: LiveQueryResult<Row>): void {
    if (
      next.rows === this.#state.rows &&
      next.phase === this.#state.phase &&
      next.error === this.#state.error &&
      next.isRefreshing === this.#state.isRefreshing &&
      canonicalValue(next.availability) ===
        canonicalValue(this.#state.availability)
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #requestRead(refreshing = false): void {
    if (this.#listeners.size === 0) return;
    this.#requested = true;
    if (
      refreshing &&
      this.#state.revision !== undefined &&
      !this.#state.isRefreshing
    ) {
      this.#publish({ ...this.#state, isRefreshing: true });
    }
    if (this.#scheduled || this.#running) return;
    this.#scheduled = true;
    const generation = this.#generation;
    scheduleMicrotask(() => {
      if (generation !== this.#generation) return;
      this.#scheduled = false;
      void this.#readLoop();
    });
  }

  #onAvailabilityChange(): void {
    const availability = this.store.availabilitySnapshot();
    if (availability.state === 'blocked') {
      this.#publish({
        ...this.#state,
        phase: 'blocked',
        availability,
        isRefreshing: false,
      });
      return;
    }
    const wasBlocked = this.#state.phase === 'blocked';
    this.#publish({
      ...this.#state,
      phase: wasBlocked
        ? this.#state.rows.length > 0
          ? 'partial'
          : 'loading'
        : this.#state.phase,
      availability,
    });
    if (wasBlocked) this.#requestRead();
  }

  async #readLoop(): Promise<void> {
    if (this.#running || this.#listeners.size === 0) return;
    const generation = this.#generation;
    this.#running = true;
    try {
      do {
        this.#requested = false;
        if (this.store.availabilitySnapshot().state === 'blocked') break;
        await this.#claimReady;
        if (generation !== this.#generation || this.#listeners.size === 0)
          return;
        const snapshot = await this.store.client.querySnapshot<
          Record<string, SqlValue>
        >({
          sql: this.spec.sql,
          ...(this.spec.params !== undefined
            ? { params: this.spec.params }
            : {}),
          ...(this.spec.coverage !== undefined
            ? { coverage: this.spec.coverage }
            : {}),
        });
        if (generation !== this.#generation || this.#listeners.size === 0)
          return;
        const availability = this.store.availabilitySnapshot();
        if (availability.state === 'blocked') {
          this.#publish({
            ...this.#state,
            phase: 'blocked',
            availability,
            isRefreshing: false,
          });
          break;
        }
        if (snapshot.revision < this.#desiredRevision) {
          this.#requested = true;
          continue;
        }
        const mappedRows =
          this.spec.mapRow === undefined
            ? (snapshot.rows as readonly Row[])
            : snapshot.rows.map(this.spec.mapRow);
        const rows = reconcileRows(
          this.#state.rows,
          mappedRows,
          this.spec.rowKey,
        );
        const phase: LiveQueryPhase = snapshot.coverage.complete
          ? 'ready'
          : rows.length > 0
            ? 'partial'
            : 'loading';
        this.#publish({
          rows,
          phase,
          revision: snapshot.revision,
          error: undefined,
          isRefreshing: false,
          availability,
        });
      } while (this.#requested && this.#listeners.size > 0);
    } catch (error) {
      if (generation !== this.#generation || this.#listeners.size === 0) return;
      const wrapped = errorOf(error);
      this.#publish({
        ...this.#state,
        phase: this.#state.revision === undefined ? 'error' : this.#state.phase,
        error: wrapped,
        isRefreshing: false,
        availability: this.store.availabilitySnapshot(),
      });
    } finally {
      if (generation === this.#generation) {
        this.#running = false;
        if (this.#requested && this.#listeners.size > 0) this.#requestRead();
      }
    }
  }
}

class ValueEntry<T> implements ExternalStoreEntry<T> {
  #generation = 0;
  readonly #listeners = new Set<() => void>();
  constructor(
    private value: T,
    private readonly read: () => Promise<T>,
  ) {}
  getSnapshot = (): T => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  refresh = (): void => {
    const generation = ++this.#generation;
    void this.read().then((next) => {
      if (generation === this.#generation) this.set(next);
    });
  };
  invalidate(): void {
    this.#generation += 1;
  }
  set(next: T): void {
    this.invalidate();
    if (next === this.value) return;
    this.value = next;
    for (const listener of this.#listeners) listener();
  }
}

interface WindowClaimGroup {
  readonly base: WindowBase;
  readonly claims: Map<symbol, ReadonlySet<string>>;
  appliedKey: string;
  scheduled: boolean;
  running: boolean;
  requested: boolean;
  readonly waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

class WindowEntry implements ExternalStoreEntry<WindowState> {
  readonly #listeners = new Set<() => void>();
  #state: WindowState = { units: [], pending: [] };
  #generation = 0;
  #delegate: WindowEntry | undefined;
  #running = false;
  #requested = false;

  constructor(
    readonly store: ReactiveClientStore,
    readonly base: WindowBase,
    readonly baseKey: string,
    private readonly cache: ObservationCache,
  ) {}

  getSnapshot = (): WindowState => this.#delegate?.getSnapshot() ?? this.#state;
  subscribe = (listener: () => void): (() => void) => {
    const current = this.cache.activate(this.baseKey, this);
    if (current !== this) {
      this.#delegate = current as WindowEntry;
      return this.#delegate.subscribe(listener);
    }
    this.#delegate = undefined;
    const notify = () => listener();
    this.#listeners.add(notify);
    if (this.#listeners.size === 1) this.refresh();
    return () => {
      if (this.#listeners.delete(notify) && this.#listeners.size === 0) {
        this.cache.deactivate(this.baseKey, this);
      }
    };
  };
  refresh = (): void => {
    if (this.#delegate !== undefined) {
      this.#delegate.refresh();
      return;
    }
    if (this.#listeners.size === 0) return;
    this.#requested = true;
    if (this.#running) return;
    void this.#readLoop();
  };
  reset(): void {
    this.#generation += 1;
    this.#running = false;
    this.#requested = false;
    this.#state = { units: [], pending: [] };
  }
  dispose(): void {
    this.#listeners.clear();
    this.reset();
  }
  onChange(batch: ClientChangeBatch): void {
    if (
      batch.windows.some((change) => change.baseKey === this.baseKey) &&
      this.#listeners.size > 0
    ) {
      this.refresh();
    }
  }
  async #readLoop(): Promise<void> {
    const generation = this.#generation;
    this.#running = true;
    try {
      do {
        this.#requested = false;
        const next = await this.store.client.windowState(this.base);
        if (generation !== this.#generation || this.#listeners.size === 0)
          return;
        if (
          canonicalValue(next.units) !== canonicalValue(this.#state.units) ||
          canonicalValue(next.pending) !== canonicalValue(this.#state.pending)
        ) {
          this.#state = next;
          for (const listener of this.#listeners) listener();
        }
      } while (this.#requested && this.#listeners.size > 0);
    } catch {
      // WindowState predates the error-bearing query result. Keep the last
      // coherent snapshot; a later exact window event or refresh retries.
    } finally {
      if (generation === this.#generation) {
        this.#running = false;
        if (this.#requested) this.refresh();
      }
    }
  }
}

export class ReactiveClientStore {
  readonly #queries = new ObservationCache();
  readonly #windows = new ObservationCache();
  readonly #windowClaims = new Map<string, WindowClaimGroup>();
  #offChange: (() => void) | undefined;
  #offLeadership: (() => void) | undefined;
  readonly status: ExternalStoreEntry<StatusStoreSnapshot>;
  readonly conflicts: ExternalStoreEntry<ConflictStoreSnapshot>;
  readonly outcomes: ExternalStoreEntry<OutcomeStoreSnapshot>;

  constructor(readonly client: ReactiveQueryClient) {
    const status = new ValueEntry<StatusStoreSnapshot>(
      {
        status: undefined,
        leadership: client.leadershipSnapshot?.(),
        error: undefined,
        isLoading: true,
      },
      async () => {
        try {
          return {
            status: await client.statusSnapshot(),
            leadership: client.leadershipSnapshot?.(),
            error: undefined,
            isLoading: false,
          };
        } catch (error) {
          return {
            status: undefined,
            leadership: client.leadershipSnapshot?.(),
            error: errorOf(error),
            isLoading: false,
          };
        }
      },
    );
    const conflicts = new ValueEntry<ConflictStoreSnapshot>(
      { conflicts: [], rejections: [], error: undefined, isLoading: true },
      async () => {
        try {
          const [found, rejected] = await Promise.all([
            client.conflicts(),
            client.rejections(),
          ]);
          return {
            conflicts: found,
            rejections: rejected,
            error: undefined,
            isLoading: false,
          };
        } catch (error) {
          return {
            conflicts: [],
            rejections: [],
            error: errorOf(error),
            isLoading: false,
          };
        }
      },
    );
    const outcomes = new ValueEntry<OutcomeStoreSnapshot>(
      { outcomes: [], error: undefined, isLoading: true },
      async () => {
        try {
          return {
            outcomes: await client.commitOutcomes(),
            error: undefined,
            isLoading: false,
          };
        } catch (error) {
          return { outcomes: [], error: errorOf(error), isLoading: false };
        }
      },
    );
    this.status = status;
    this.conflicts = conflicts;
    this.outcomes = outcomes;
    this.start();
  }

  query<Row>(
    spec: ReactiveQuerySpec<Row>,
  ): ExternalStoreEntry<LiveQueryResult<Row>> {
    const dependencies = spec.dependencies.map((dependency) => ({
      table: dependency.table,
      ...(dependency.scopeKeys === undefined
        ? {}
        : { scopeKeys: [...new Set(dependency.scopeKeys)].sort() }),
    }));
    const coverage = (spec.coverage ?? []).map((item) => ({
      baseKey: windowBaseKey(item.base),
      units: [...new Set(item.units)].sort(),
    }));
    const mapRowId = reactiveFunctionId(
      spec.mapRow as ((...args: never[]) => unknown) | undefined,
    );
    const key = canonicalValue({
      id: spec.id,
      sql: spec.sql,
      params: spec.params ?? [],
      dependencies,
      coverage,
      claimCoverage: spec.claimCoverage !== false,
      ...(mapRowId === undefined ? {} : { mapRow: mapRowId }),
    });
    let entry = this.#queries.get(key) as QueryEntry<Row> | undefined;
    if (entry === undefined) {
      entry = new QueryEntry(this, spec, key, this.#queries);
      this.#queries.add(key, entry);
    }
    return entry;
  }

  availabilitySnapshot(): SyncAvailability {
    const snapshot = this.status.getSnapshot();
    if (snapshot.status === undefined) {
      return snapshot.leadership?.state === 'blocked'
        ? {
            state: 'blocked',
            reason: 'leader-unreachable',
            currentSchemaVersion: this.client.currentSchemaVersion ?? 0,
            retryable: true,
          }
        : { state: 'ready' };
    }
    return classifySyncAvailability(snapshot.status, snapshot.leadership);
  }

  /** Retain a composable window working set outside React. The returned
   * handle exposes registration completion and releases only this owner. */
  retainWindow(base: WindowBase, units: readonly string[]): WindowRetention {
    const owner = Symbol('retained-window');
    const ready = this.setWindowClaim(owner, base, units);
    let active = true;
    return {
      ready,
      release: () => {
        if (!active) return;
        active = false;
        this.releaseWindowClaims(owner);
      },
    };
  }

  window(base: WindowBase): ExternalStoreEntry<WindowState> {
    const key = windowBaseKey(base);
    let entry = this.#windows.get(key) as WindowEntry | undefined;
    if (entry === undefined) {
      entry = new WindowEntry(this, base, key, this.#windows);
      this.#windows.add(key, entry);
    }
    return entry;
  }

  setWindowClaim(
    owner: symbol,
    base: WindowBase,
    units: readonly string[],
  ): Promise<void> {
    const key = windowBaseKey(base);
    let group = this.#windowClaims.get(key);
    if (group === undefined) {
      group = {
        base,
        claims: new Map(),
        appliedKey: '',
        scheduled: false,
        running: false,
        requested: false,
        waiters: [],
      };
      this.#windowClaims.set(key, group);
    }
    group.claims.set(owner, new Set(units));
    const result = new Promise<void>((resolve, reject) => {
      group?.waiters.push({ resolve, reject });
    });
    this.#scheduleWindow(group);
    return result;
  }

  releaseWindowClaims(owner: symbol): void {
    for (const group of this.#windowClaims.values()) {
      if (group.claims.delete(owner)) this.#scheduleWindow(group);
    }
  }

  #scheduleWindow(group: WindowClaimGroup): void {
    group.requested = true;
    if (group.scheduled || group.running) return;
    group.scheduled = true;
    scheduleMicrotask(() => {
      group.scheduled = false;
      void this.#flushWindow(group);
    });
  }

  async #flushWindow(group: WindowClaimGroup): Promise<void> {
    const baseKey = windowBaseKey(group.base);
    if (group.running || this.#windowClaims.get(baseKey) !== group) return;
    group.running = true;
    try {
      while (group.requested) {
        group.requested = false;
        const units = [
          ...new Set([...group.claims.values()].flatMap((set) => [...set])),
        ].sort();
        const key = canonicalValue(units);
        if (key !== group.appliedKey) {
          await this.client.setWindow(group.base, units);
          if (this.#windowClaims.get(baseKey) !== group) return;
          group.appliedKey = key;
        }
      }
      for (const waiter of group.waiters.splice(0)) waiter.resolve();
    } catch (error) {
      for (const waiter of group.waiters.splice(0)) waiter.reject(error);
    } finally {
      group.running = false;
      if (group.requested && this.#windowClaims.get(baseKey) === group)
        this.#scheduleWindow(group);
      else if (
        group.claims.size === 0 &&
        group.waiters.length === 0 &&
        group.appliedKey === canonicalValue([])
      ) {
        const key = windowBaseKey(group.base);
        if (this.#windowClaims.get(key) === group)
          this.#windowClaims.delete(key);
      }
    }
  }

  /** Retained observation counts for diagnostics and resource benchmarks. */
  cacheStats() {
    return {
      queries: this.#queries.size,
      activeQueries: this.#queries.activeSize,
      windows: this.#windows.size,
      activeWindows: this.#windows.activeSize,
      windowClaims: this.#windowClaims.size,
    };
  }

  start(): void {
    if (this.#offChange !== undefined) return;
    this.#offChange = this.client.onChange((batch) => {
      this.#queries.onChange(batch);
      this.#windows.onChange(batch);
      if (batch.status !== undefined) {
        (this.status as ValueEntry<StatusStoreSnapshot>).set({
          status: batch.status,
          leadership: this.client.leadershipSnapshot?.(),
          error: undefined,
          isLoading: false,
        });
      }
      if (batch.conflictsChanged || batch.rejectionsChanged) {
        this.conflicts.refresh();
      }
      if (batch.outcomesChanged) this.outcomes.refresh();
    });
    this.#offLeadership = this.client.onLeadershipChange?.((leadership) => {
      const previous = this.status.getSnapshot();
      (this.status as ValueEntry<StatusStoreSnapshot>).set({
        ...previous,
        leadership,
      });
      if (previous.isLoading) this.status.refresh();
    });
    this.status.refresh();
    this.conflicts.refresh();
    this.outcomes.refresh();
  }

  dispose(): void {
    this.#queries.clear();
    this.#windows.clear();
    for (const entry of [this.status, this.conflicts, this.outcomes]) {
      (entry as ValueEntry<unknown>).invalidate();
    }
    this.#offChange?.();
    this.#offChange = undefined;
    this.#offLeadership?.();
    this.#offLeadership = undefined;
    for (const group of this.#windowClaims.values()) {
      for (const waiter of group.waiters.splice(0)) {
        waiter.reject(
          new ClientSyncError(
            'client.reactive_store_disposed',
            'reactive store disposed',
          ),
        );
      }
      // Releasing a window is best-effort teardown. A resource owner may have
      // already closed the underlying worker/native handle before React effect
      // cleanup runs (notably during schema-changing HMR). Do not let that
      // harmless ordering race escape as an unhandled rejection — and the
      // interface permits a plain void return, so a closed handle may also
      // throw synchronously; swallow that the same way.
      try {
        void Promise.resolve(this.client.setWindow(group.base, [])).catch(
          () => undefined,
        );
      } catch {
        // Same teardown race, surfaced synchronously.
      }
    }
    this.#windowClaims.clear();
  }
}
