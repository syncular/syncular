import type { ScopeMap } from '@syncular/core';
import type { CompiledTable, IndexSchema } from './schema';
import type { IndexRowScanQuery, RowScanQuery } from './storage';
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
