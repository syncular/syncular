/**
 * @syncular/client - Fingerprint-based rerender optimization utilities
 *
 * Provides efficient fingerprint computation for query results to avoid
 * expensive deep equality checks. Uses mutation timestamps from the SyncEngine.
 */

export interface MutationTimestampSource {
  getMutationTimestamp(table: string, rowId: string): number;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function hashMix(hash: number, value: number): number {
  return Math.imul(hash ^ value, FNV_PRIME) >>> 0;
}

function hashString(hash: number, value: string): number {
  let next = hash;
  for (let i = 0; i < value.length; i++) {
    next = hashMix(next, value.charCodeAt(i));
  }
  return next;
}

function hashTimestamp(hash: number, value: number): number {
  if (!Number.isFinite(value)) {
    return hashMix(hash, 0);
  }
  // Keep three decimal places to preserve sub-millisecond precision.
  const scaled = Math.round(value * 1000);
  const lowBits = scaled >>> 0;
  const highBits = Math.floor(scaled / 0x1_0000_0000) >>> 0;
  return hashMix(hashMix(hash, lowBits), highBits);
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
 * Format: `table:count:hash`
 */
export function computeRowFingerprint(
  rows: unknown[],
  table: string,
  engine: MutationTimestampSource,
  keyField: string
): string {
  let hash = hashMix(FNV_OFFSET_BASIS, rows.length);
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const id = String(r[keyField] ?? '');
    const ts = engine.getMutationTimestamp(table, id);
    hash = hashString(hash, id);
    hash = hashMix(hash, 0); // separator
    hash = hashTimestamp(hash, ts);
    hash = hashMix(hash, 1); // separator
  }

  return `${table}:${rows.length}:${hash.toString(16).padStart(8, '0')}`;
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
