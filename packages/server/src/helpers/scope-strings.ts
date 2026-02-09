/**
 * @syncular/server - Scope string utilities
 *
 * Helpers for creating and parsing scope strings.
 * Scope strings identify partitions of data for sync subscriptions.
 */

/**
 * Result from parsing a scope key
 */
interface ParsedScopeKey {
  /** The prefix (first segment) */
  prefix: string;
  /** The remaining values (segments after prefix) */
  values: string[];
}

/**
 * Create a scope string from a prefix and values.
 *
 * Scope strings use colon separators: `prefix:value1:value2`
 *
 * @example
 * ```typescript
 * // Simple scope string
 * createScopeKey('user', 'alice')
 * // => 'user:alice'
 *
 * // Multi-value scope string
 * createScopeKey('user', 'alice', 'project', 'proj-1')
 * // => 'user:alice:project:proj-1'
 * ```
 */
export function createScopeKey(prefix: string, ...values: string[]): string {
  return [prefix, ...values].join(':');
}

/**
 * Parse a scope string into its prefix and values.
 *
 * Returns null if the key is invalid or doesn't match the expected prefix.
 *
 * @example
 * ```typescript
 * // Parse any scope string
 * parseScopeKey('user:alice')
 * // => { prefix: 'user', values: ['alice'] }
 *
 * // Parse with expected prefix
 * parseScopeKey('user:alice', 'user')
 * // => { prefix: 'user', values: ['alice'] }
 *
 * // Returns null if prefix doesn't match
 * parseScopeKey('user:alice', 'project')
 * // => null
 *
 * // Multi-value scope string
 * parseScopeKey('user:alice:project:proj-1')
 * // => { prefix: 'user', values: ['alice', 'project', 'proj-1'] }
 * ```
 */
export function parseScopeKey(
  key: string,
  expectedPrefix?: string
): ParsedScopeKey | null {
  const parts = key.split(':');
  if (parts.length < 1) return null;

  const [prefix, ...values] = parts;
  if (!prefix) return null;

  // Check expected prefix if provided
  if (expectedPrefix && prefix !== expectedPrefix) return null;

  return { prefix, values };
}

/**
 * Extract a specific value from a scope string by index.
 *
 * @example
 * ```typescript
 * // Get first value after prefix
 * getScopeKeyValue('user:alice:project:proj-1', 0)
 * // => 'alice'
 *
 * // Get second value
 * getScopeKeyValue('user:alice:project:proj-1', 2)
 * // => 'proj-1'
 * ```
 */
export function getScopeKeyValue(
  key: string,
  valueIndex: number
): string | null {
  const parsed = parseScopeKey(key);
  if (!parsed) return null;
  return parsed.values[valueIndex] ?? null;
}

export type { ParsedScopeKey };
