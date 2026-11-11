import type { ScopeMap } from '@syncular/core';
import type { CompiledTable, IndexSchema } from './schema';
import { matchesEffective } from './scopes';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  IndexRowScanQuery,
  LiveWindow,
  LiveWindowQuery,
  RowScanQuery,
  StorageTransaction,
  StoredChange,
  StoredCommit,
} from './storage';
import { StorageQueryError } from './storage-errors';

/**
 * Fail loudly instead of making an unsupported unscoped scan look empty.
 * Returns the first scope variable in sorted order — the one every adapter
 * drives its inverted-index candidate selection with.
 */
export function assertScopeIndexedScan(query: RowScanQuery): string {
  const scopeFilter = (
    query as RowScanQuery & { readonly scopeFilter?: ScopeMap | null }
  ).scopeFilter;
  const firstVariable =
    scopeFilter === undefined || scopeFilter === null
      ? undefined
      : Object.keys(scopeFilter).sort()[0];
  if (firstVariable === undefined) {
    throw new StorageQueryError('sync.storage.scan_requires_scope');
  }
  return firstVariable;
}

/** Validate and resolve one exact trusted-host relational index lookup. */
export function resolveIndexRowScan(
  table: CompiledTable,
  query: IndexRowScanQuery,
): IndexSchema {
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 1_000
  ) {
    throw new StorageQueryError('sync.storage.invalid_limit');
  }
  if (!table.materialize) {
    throw new StorageQueryError('sync.storage.index_not_materialized');
  }
  const index = table.indexes.find(
    (candidate) => candidate.name === query.index,
  );
  if (index === undefined) {
    throw new StorageQueryError('sync.storage.index_not_found');
  }
  if (
    !Array.isArray(query.values) ||
    query.values.length !== index.columns.length
  ) {
    throw new StorageQueryError('sync.storage.index_value_count_mismatch');
  }
  return index;
}

/**
 * §6.7/§6.8 transaction-bound registered query for every host hook that runs
 * inside a push transaction. A storage transaction without the capability
 * fails; the call never falls back to `ServerStorage.queryAuthoritative`,
 * which reads outside the transaction.
 */
export async function transactionQuery(
  tx: StorageTransaction,
  query: AuthoritativeQueryRequest,
): Promise<AuthoritativeQueryResult> {
  if (tx.queryAuthoritative === undefined) {
    throw new StorageQueryError('sync.storage.transaction_query_unsupported');
  }
  return tx.queryAuthoritative(query);
}

/** One index range of the live scan: a unit key and its exclusive lower bound. */
export interface LiveKey {
  readonly var: string;
  readonly value: string;
  readonly after: number;
}

/**
 * One row of a live-window page: a candidate commit joined to its metadata
 * (absent when the commit vanished) and one of its changes (absent when it
 * has none), in (commitSeq, change index) order.
 */
export interface LiveWindowRow {
  readonly commitSeq: number;
  readonly meta?: { readonly actorId: string; readonly createdAtMs: number };
  readonly change?: StoredChange;
}

/**
 * The §4.5 live scan over a backend's page read. Each distinct unit key
 * (the first variable, keys sorted) becomes one index range starting at the
 * lowest bound of the units that share it; `readPage` returns up to `limit`
 * candidate commits above every range's bound. A change is kept when a unit
 * covers its table, the pair's effective scopes match it, and its commit
 * lies above that unit's own bound. Every candidate advances the scan, so a
 * page of non-matching candidates never repeats.
 */
export async function readLiveWindowPages(
  query: LiveWindowQuery,
  readPage: (
    keys: readonly LiveKey[],
    limit: number,
  ) => Promise<readonly LiveWindowRow[]>,
): Promise<LiveWindow> {
  const bounds = new Map<string, LiveKey>();
  for (const unit of query.units) {
    if (unit.tables.size === 0) continue;
    const variable = Object.keys(unit.scopes).sort()[0];
    const value = variable === undefined ? undefined : unit.scopes[variable];
    if (variable === undefined || value === undefined) {
      throw new StorageQueryError('sync.storage.scan_requires_scope');
    }
    const id = JSON.stringify([variable, value]);
    const prior = bounds.get(id);
    if (prior === undefined || unit.afterSeq < prior.after) {
      bounds.set(id, { var: variable, value, after: unit.afterSeq });
    }
  }
  const commits: StoredCommit[] = [];
  const limit = Math.max(64, query.limitChanges);
  let delivered = 0;
  let scanned = -1;
  while (bounds.size > 0) {
    const rows = await readPage(
      [...bounds.values()].map((key) => ({
        ...key,
        after: Math.max(key.after, scanned),
      })),
      limit,
    );
    let candidates = 0;
    for (let i = 0; i < rows.length;) {
      const head = rows[i];
      if (head === undefined) break;
      candidates += 1;
      scanned = head.commitSeq;
      const changes: StoredChange[] = [];
      for (; rows[i]?.commitSeq === head.commitSeq; i++) {
        const change = rows[i]?.change;
        if (
          change !== undefined &&
          query.units.some((unit) => {
            const effective: ScopeMap | undefined = unit.tables.get(
              change.table,
            );
            return (
              head.commitSeq > unit.afterSeq &&
              effective !== undefined &&
              matchesEffective(change.scopes, effective)
            );
          })
        ) {
          changes.push(change);
        }
      }
      if (head.meta === undefined || changes.length === 0) continue;
      commits.push({ commitSeq: head.commitSeq, ...head.meta, changes });
      delivered += changes.length;
      if (delivered >= query.limitChanges) {
        return { commits, throughSeq: head.commitSeq };
      }
    }
    if (candidates < limit) break;
  }
  return { commits, throughSeq: query.throughSeq };
}
