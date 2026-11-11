/**
 * Revisioned client-local observation events (SPEC §7.5).
 *
 * The core records observer domains while it owns the SQLite transaction,
 * increments the persisted local revision in that same transaction, and emits
 * the frozen batch only after commit. Bridges forward this shape verbatim.
 */
import type { ScopeMap } from '@syncular/core';
import type { LeaseState, SchemaFloor } from './client';
import type { CompiledClientTable } from './schema';

export type LocalRevision = bigint;

export interface TableChange {
  readonly table: string;
  /** Undefined means honestly table-wide; an empty set is never emitted. */
  readonly scopeKeys?: ReadonlySet<string>;
}

export interface WindowChange {
  readonly baseKey: string;
  /** Changed values of the base. */
  readonly units: ReadonlySet<string>;
}

export interface SyncStatusSnapshot {
  readonly currentSchemaVersion: number;
  readonly outbox: number;
  readonly upgrading: boolean;
  readonly leaseState: LeaseState | undefined;
  readonly schemaFloor: SchemaFloor | undefined;
  readonly syncNeeded: boolean;
  /**
   * RFC 0005 A2: whether a previous-version cache is present, so a host's
   * update/rollback path can require its discard. `createdAtMs` is the capture
   * time when a readable cache exists.
   */
  readonly previousVersionContext: {
    readonly present: boolean;
    readonly createdAtMs?: number;
  };
}

export interface ClientChangeBatch {
  readonly revision: LocalRevision;
  readonly tables: readonly TableChange[];
  readonly windows: readonly WindowChange[];
  readonly status?: SyncStatusSnapshot;
  readonly conflictsChanged: boolean;
  readonly rejectionsChanged: boolean;
  readonly outcomesChanged: boolean;
  /** Server COMMIT frames applied by this transaction, when present. */
  readonly appliedCommits?: readonly {
    readonly table: string;
    readonly commitSeq: number;
    readonly source: 'delta' | 'pull';
  }[];
}

export type ClientChangeListener = (batch: ClientChangeBatch) => void;

/** Network work created by a core command (SPEC §7.5). */
export type SyncIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'interactive' }
  | { readonly kind: 'background'; readonly delayMs: number };

export interface CommandEffects {
  readonly sync: SyncIntent;
}

export interface CommandResult<T> {
  readonly value: T;
  readonly effects: CommandEffects;
}

export const NO_COMMAND_EFFECTS: CommandEffects = {
  sync: { kind: 'none' },
};

interface MutableTableChange {
  tableWide: boolean;
  scopeKeys: Set<string> | undefined;
}

/**
 * Per-observer-transaction accumulator. It contains no revision itself: the
 * transaction wrapper assigns the revision only after all writes succeeded.
 */
export class ChangeAccumulator {
  readonly #tables = new Map<string, MutableTableChange>();
  readonly #windows = new Map<string, Set<string>>();
  #status = false;
  #conflicts = false;
  #rejections = false;
  #outcomes = false;
  readonly #appliedCommits: NonNullable<
    ClientChangeBatch['appliedCommits']
  >[number][] = [];

  appliedCommit(
    entry: NonNullable<ClientChangeBatch['appliedCommits']>[number],
  ): void {
    this.#appliedCommits.push(entry);
  }

  /** Mark a whole table dirty, discarding any weaker scope-only facts. */
  table(name: string): void {
    this.#tables.set(name, { tableWide: true, scopeKeys: undefined });
  }

  /** Associate a precise `prefix:value` key with its table. */
  scope(table: string, key: string): void {
    const current = this.#tables.get(table);
    if (current?.tableWide) return;
    if (current === undefined) {
      this.#tables.set(table, {
        tableWide: false,
        scopeKeys: new Set([key]),
      });
      return;
    }
    current.scopeKeys?.add(key);
  }

  /** Record registration/completeness change for one window value. */
  window(baseKey: string, value: string): void {
    const current = this.#windows.get(baseKey);
    if (current === undefined) this.#windows.set(baseKey, new Set([value]));
    else current.add(value);
  }

  status(): void {
    this.#status = true;
  }

  conflicts(): void {
    this.#conflicts = true;
  }

  rejections(): void {
    this.#rejections = true;
  }

  outcomes(): void {
    this.#outcomes = true;
  }

  /**
   * Add precise keys for a bulk scoped delete. A map that leaves a declared
   * scope variable unnamed cannot list the deleted rows' keys for that
   * variable, so the change is table-wide.
   */
  scopeMap(table: CompiledClientTable, scopes: ScopeMap): void {
    for (const variable of table.scopePrefixByVariable.keys()) {
      if (!Object.hasOwn(scopes, variable)) return this.table(table.name);
    }
    for (const [variable, values] of Object.entries(scopes)) {
      const prefix = table.scopePrefixByVariable.get(variable);
      if (prefix === undefined) continue;
      for (const value of values) this.scope(table.name, `${prefix}:${value}`);
    }
  }

  /** Add precise keys for a COMMIT change's stored scope values. */
  changeScopes(
    table: CompiledClientTable,
    scopes: Readonly<Record<string, string>>,
  ): void {
    for (const [variable, value] of Object.entries(scopes)) {
      const prefix = table.scopePrefixByVariable.get(variable);
      if (prefix !== undefined) {
        this.scope(table.name, `${prefix}:${value}`);
      }
    }
  }

  hasTable(name: string): boolean {
    return this.#tables.has(name);
  }

  get touched(): boolean {
    return (
      this.#tables.size > 0 ||
      this.#windows.size > 0 ||
      this.#status ||
      this.#conflicts ||
      this.#rejections ||
      this.#outcomes
    );
  }

  get statusChanged(): boolean {
    return this.#status;
  }

  finish(
    revision: LocalRevision,
    status: SyncStatusSnapshot | undefined,
  ): ClientChangeBatch {
    if (this.#status && status === undefined) {
      throw new Error('status change batch requires a post-commit snapshot');
    }
    const tables: TableChange[] = [];
    for (const [table, change] of this.#tables) {
      tables.push(
        change.tableWide
          ? { table }
          : { table, scopeKeys: change.scopeKeys as ReadonlySet<string> },
      );
    }
    const windows: WindowChange[] = [];
    for (const [baseKey, units] of this.#windows)
      windows.push({ baseKey, units });
    return {
      revision,
      tables,
      windows,
      ...(this.#status ? { status: status as SyncStatusSnapshot } : {}),
      conflictsChanged: this.#conflicts,
      rejectionsChanged: this.#rejections,
      outcomesChanged: this.#outcomes,
      ...(this.#appliedCommits.length > 0
        ? { appliedCommits: this.#appliedCommits }
        : {}),
    };
  }
}

/** Exception-isolated synchronous listener set; observer code must never
 * corrupt the committed core path. */
export class ChangeEmitter<T = ClientChangeBatch> {
  readonly #listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of this.#listeners) {
      try {
        listener(value);
      } catch {
        // Isolated: a throwing observer does not stop the others.
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}

// ---------------------------------------------------------------------------
// Compatibility projection
// ---------------------------------------------------------------------------

/**
 * Legacy invalidation shape. It is derived only from an exact core batch;
 * missing bridge information is never treated as global.
 */
export interface InvalidationEvent {
  readonly tables: ReadonlySet<string>;
  readonly scopeKeys: ReadonlySet<string>;
}

export type InvalidationListener = (event: InvalidationEvent) => void;

export function invalidationFromChange(
  batch: ClientChangeBatch,
): InvalidationEvent | undefined {
  if (batch.tables.length === 0) return undefined;
  const tables = new Set<string>();
  const scopeKeys = new Set<string>();
  for (const change of batch.tables) {
    tables.add(change.table);
    for (const key of change.scopeKeys ?? []) scopeKeys.add(key);
  }
  return { tables, scopeKeys };
}

export class InvalidationEmitter extends ChangeEmitter<InvalidationEvent> {}

/** @deprecated Use {@link ChangeAccumulator}. */
export { ChangeAccumulator as Invalidation };
