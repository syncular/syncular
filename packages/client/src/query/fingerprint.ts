/**
 * @syncular/client - Fingerprint-based rerender optimization utilities
 *
 * Provides efficient fingerprint computation for query results to avoid
 * expensive deep equality checks. Uses mutation timestamps from the SyncEngine.
 */

export interface MutationTimestampSource {
  getMutationTimestamp(table: string, rowId: string): number;
}

/**
 * Compute a fingerprint for query results based on length + ids + mutation timestamps.
 * Much faster than deep equality for large datasets.
 *
 * Fingerprint format: `length:id1@ts1,id2@ts2,...`
 *
 * @param rows - Query result rows (must have an id-like field)
 * @param engine - SyncEngine to look up mutation timestamps
 * @param table - Table name for timestamp lookup
 * @param keyField - Field name to use as row identifier (default: 'id')
 * @returns Fingerprint string for comparison
 *
 * @example
 * ```ts
 * const fingerprint = computeFingerprint(tasks, engine, 'tasks', 'id');
 * // Returns: "3:abc@1706123456789,def@1706123456790,ghi@0"
 * ```
 */
export function computeFingerprint<T extends Record<string, unknown>>(
  rows: T[],
  engine: MutationTimestampSource,
  table: string,
  keyField = 'id'
): string {
  if (rows.length === 0) return '0:';

  const parts: string[] = [];
  for (const row of rows) {
    const id = String(row[keyField] ?? '');
    const ts = engine.getMutationTimestamp(table, id);
    parts.push(`${id}@${ts}`);
  }

  return `${rows.length}:${parts.join(',')}`;
}

/**
 * Check if rows have the required key field for fingerprinting.
 * Returns true for empty arrays (no data to fingerprint).
 *
 * @param rows - Query result rows to check
 * @param keyField - Field name to check for (default: 'id')
 * @returns true if rows can be fingerprinted, false otherwise
 *
 * @example
 * ```ts
 * // Can fingerprint - rows have 'id' field
 * canFingerprint([{ id: '1', name: 'foo' }]); // true
 *
 * // Cannot fingerprint - rows lack 'id' field (aggregates, etc.)
 * canFingerprint([{ count: 42 }]); // false
 * ```
 */
export function canFingerprint<T>(rows: T[], keyField = 'id'): boolean {
  if (rows.length === 0) return true;
  return keyField in (rows[0] as Record<string, unknown>);
}

/**
 * Compute row-level fingerprint from query results.
 * Format: `table:count:id1@ts1,id2@ts2,...`
 */
export function computeRowFingerprint(
  rows: unknown[],
  table: string,
  engine: MutationTimestampSource,
  keyField: string
): string {
  if (rows.length === 0) return `${table}:0:`;

  const parts: string[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const id = String(r[keyField] ?? '');
    const ts = engine.getMutationTimestamp(table, id);
    parts.push(`${id}@${ts}`);
  }

  return `${table}:${rows.length}:${parts.join(',')}`;
}

/**
 * Compute value-based fingerprint for aggregate/scalar queries.
 * Format: `table:hash(value)`
 */
export function computeValueFingerprint(table: string, value: unknown): string {
  // Simple hash of the JSON representation
  const json = JSON.stringify(value);
  return `${table}:${json}`;
}

/**
 * Check if result rows have the key field for row-level fingerprinting.
 */
export function hasKeyField(rows: unknown[], keyField: string): boolean {
  if (rows.length === 0) return false;
  return keyField in (rows[0] as Record<string, unknown>);
}
