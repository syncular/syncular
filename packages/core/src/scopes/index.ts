/**
 * @syncular/core - Scope types, patterns, and utilities
 *
 * Scope patterns define how data is partitioned for sync.
 * Scopes are stored as JSONB on changes for flexible filtering.
 * Patterns use `{placeholder}` syntax to extract or inject values.
 */

// ── Types ────────────────────────────────────────────────────────────

/**
 * Scope pattern string, e.g., 'user:{user_id}', 'project:{project_id}'
 */
export type ScopePattern = string;

/**
 * Scope values - the actual values for scope variables.
 * Values can be single strings or arrays (for multi-value subscriptions).
 *
 * @example
 * { user_id: 'U1' }
 * { project_id: ['P1', 'P2'] }
 * { year: '2025', month: '03' }
 */
export type ScopeValues = Record<string, string | string[]>;

/**
 * Stored scopes on a change - always single values (not arrays).
 * This is what gets stored in the JSONB column.
 *
 * @example
 * { user_id: 'U1', project_id: 'P1' }
 */
export type StoredScopes = Record<string, string>;

/**
 * Definition of shared scopes across server and client.
 * Maps scope patterns to their variable types.
 *
 * @example
 * type SharedScopes = {
 *   'user:{user_id}': { user_id: string };
 *   'project:{project_id}': { project_id: string };
 *   'event_date:{year}:{month}': { year: string; month: string };
 * };
 */
export type SharedScopesDefinition = Record<
  ScopePattern,
  Record<string, string>
>;

/**
 * Simplified scope definition.
 * Can be a simple pattern string or an object with explicit column mapping.
 *
 * @example
 * ```typescript
 * // Simple: pattern column is auto-derived
 * scopes: ['user:{user_id}', 'org:{org_id}']
 *
 * // Explicit: when column differs from pattern variable
 * scopes: [
 *   { pattern: 'user:{user_id}', column: 'owner_id' }
 * ]
 * ```
 */
export type ScopeDefinition = string | { pattern: string; column: string };

// ── Pattern parsing (internal helpers) ───────────────────────────────

/**
 * Extract the placeholder name from a pattern.
 * Returns null if the pattern doesn't contain a valid placeholder.
 */
function extractPlaceholder(pattern: string): {
  prefix: string;
  placeholder: string;
  suffix: string;
} | null {
  const match = pattern.match(/^(.*?)\{(\w+)\}(.*)$/);
  if (!match) return null;

  return {
    prefix: match[1]!,
    placeholder: match[2]!,
    suffix: match[3]!,
  };
}

/**
 * Match a scope string against a pattern and extract the value.
 */
function matchScopePattern(pattern: string, scopeKey: string): string | null {
  const parsed = extractPlaceholder(pattern);
  if (!parsed) {
    // No placeholder - exact match
    return pattern === scopeKey ? '' : null;
  }

  const { prefix, suffix } = parsed;

  if (!scopeKey.startsWith(prefix)) {
    return null;
  }

  if (suffix && !scopeKey.endsWith(suffix)) {
    return null;
  }

  const valueStart = prefix.length;
  const valueEnd = suffix ? scopeKey.length - suffix.length : scopeKey.length;

  if (valueStart >= valueEnd) {
    return null;
  }

  return scopeKey.slice(valueStart, valueEnd);
}

/**
 * Extract the placeholder name from a pattern.
 */
function getPlaceholderName(pattern: string): string | null {
  const parsed = extractPlaceholder(pattern);
  return parsed?.placeholder ?? null;
}

// ── Pattern operations (public) ──────────────────────────────────────

/**
 * Build a scope string from a pattern and value.
 *
 * @example
 * buildScopeKey('user:{user_id}', '123') // 'user:123'
 */
export function buildScopeKey(pattern: string, value: string): string {
  const parsed = extractPlaceholder(pattern);
  if (!parsed) {
    return pattern;
  }

  return `${parsed.prefix}${value}${parsed.suffix}`;
}

/**
 * Check if a scope string matches a pattern.
 */
export function scopeKeyMatchesPattern(
  pattern: string,
  scopeKey: string
): boolean {
  return matchScopePattern(pattern, scopeKey) !== null;
}

/**
 * Normalize scope definitions to a pattern-to-column map.
 *
 * @example
 * normalizeScopes(['user:{user_id}'])
 * // → { 'user:{user_id}': 'user_id' }
 */
export function normalizeScopes(
  scopes: ScopeDefinition[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const scope of scopes) {
    if (typeof scope === 'string') {
      const placeholder = getPlaceholderName(scope);
      if (!placeholder) {
        throw new Error(
          `Scope pattern "${scope}" must contain a placeholder like {column_name}`
        );
      }
      result[scope] = placeholder;
    } else {
      result[scope.pattern] = scope.column;
    }
  }
  return result;
}

/**
 * Find the matching pattern and extract value from a scope string.
 */
export function findMatchingPattern(
  patterns: Record<string, string>,
  scopeKey: string
): { pattern: string; column: string; value: string } | null {
  for (const [pattern, column] of Object.entries(patterns)) {
    const value = matchScopePattern(pattern, scopeKey);
    if (value !== null) {
      return { pattern, column, value };
    }
  }
  return null;
}

// ── Value operations (public) ────────────────────────────────────────

/**
 * Extract variable names from a scope pattern.
 *
 * @example
 * extractScopeVars('project:{project_id}') // ['project_id']
 * extractScopeVars('event_date:{year}:{month}') // ['year', 'month']
 */
export function extractScopeVars(pattern: ScopePattern): string[] {
  const matches = pattern.match(/\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * Build scope values from a row based on a scope pattern.
 * Uses the pattern's variable names to extract values from the row.
 *
 * @example
 * buildScopeValuesFromRow('project:{project_id}', { id: '1', project_id: 'P1' })
 * // { project_id: 'P1' }
 */
export function buildScopeValuesFromRow(
  pattern: ScopePattern,
  row: Record<string, unknown>
): StoredScopes {
  const vars = extractScopeVars(pattern);
  const result: StoredScopes = {};

  for (const varName of vars) {
    const value = row[varName];
    if (value === null || value === undefined) {
      result[varName] = '';
    } else {
      result[varName] = String(value);
    }
  }

  return result;
}

/**
 * Merge multiple scope value objects into one.
 * Later values override earlier ones.
 */
export function mergeScopeValues(...sources: StoredScopes[]): StoredScopes {
  const result: StoredScopes = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Check if two stored scopes are equal.
 */
export function scopesEqual(a: StoredScopes, b: StoredScopes): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();

  if (keysA.length !== keysB.length) return false;

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (a[keysA[i]!] !== b[keysB[i]!]) return false;
  }

  return true;
}

/**
 * Check if stored scopes match a subscription's scope values.
 * Handles array values in subscription (OR semantics).
 * Missing keys in subscription are treated as wildcards (match any).
 *
 * @example
 * scopesMatchSubscription({ project_id: 'P1' }, { project_id: 'P1' }) // true
 * scopesMatchSubscription({ project_id: 'P1' }, { project_id: ['P1', 'P2'] }) // true
 * scopesMatchSubscription({ project_id: 'P1' }, { project_id: 'P2' }) // false
 */
export function scopesMatchSubscription(
  stored: StoredScopes,
  subscription: ScopeValues
): boolean {
  for (const [key, subValue] of Object.entries(subscription)) {
    const storedValue = stored[key];
    if (storedValue === undefined) return false;

    if (Array.isArray(subValue)) {
      if (!subValue.includes(storedValue)) return false;
    } else {
      if (storedValue !== subValue) return false;
    }
  }

  return true;
}

/**
 * Normalize scope values to always use arrays (for consistent handling).
 */
export function normalizeScopeValues(
  values: ScopeValues
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = Array.isArray(value) ? value : [value];
  }
  return result;
}

/**
 * Get all scope variable names from a set of patterns.
 */
export function getAllScopeVars(patterns: ScopePattern[]): string[] {
  const vars = new Set<string>();
  for (const pattern of patterns) {
    for (const v of extractScopeVars(pattern)) {
      vars.add(v);
    }
  }
  return Array.from(vars);
}
