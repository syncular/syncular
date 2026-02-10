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
 * Extract the placeholder name from a pattern.
 */
function getPlaceholderName(pattern: string): string | null {
  const parsed = extractPlaceholder(pattern);
  return parsed?.placeholder ?? null;
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
