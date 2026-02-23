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
 * Scope value for a single scope key.
 */
export type ScopeValue = string | string[];

/**
 * Scope values - the actual values for scope variables.
 * Values can be single strings or arrays (for multi-value subscriptions).
 *
 * @example
 * { user_id: 'U1' }
 * { project_id: ['P1', 'P2'] }
 * { year: '2025', month: '03' }
 */
export type ScopeValues = Record<string, ScopeValue>;

/**
 * Stored scopes on a change - always single values (not arrays).
 * This is what gets stored in the JSONB column.
 *
 * @example
 * { user_id: 'U1', project_id: 'P1' }
 */
export type StoredScopes = Record<string, string>;

/**
 * Extract scope keys from a scope pattern at the type level.
 *
 * @example
 * ScopeKeysFromPattern<'user:{user_id}'> // 'user_id'
 * ScopeKeysFromPattern<'event:{year}:{month}'> // 'year' | 'month'
 */
export type ScopeKeysFromPattern<Pattern extends ScopePattern> =
  string extends Pattern
    ? string
    : Pattern extends `${string}{${infer Key}}${infer Rest}`
      ? Key | ScopeKeysFromPattern<Rest>
      : never;

/**
 * Resolve the pattern string from a scope definition.
 */
export type ScopePatternFromDefinition<Definition extends ScopeDefinition> =
  Definition extends ScopePattern
    ? Definition
    : Definition extends { pattern: infer Pattern extends ScopePattern }
      ? Pattern
      : never;

/**
 * Extract scope keys from a list of scope definitions.
 */
export type ScopeKeysFromDefinitions<
  Definitions extends readonly ScopeDefinition[],
> = ScopeKeysFromPattern<ScopePatternFromDefinition<Definitions[number]>>;

/**
 * Scope values constrained to known scope keys.
 *
 * Unknown keys are rejected at compile-time when literals are used.
 */
export type ScopeValuesForKeys<ScopeKeys extends string> = Partial<
  Record<ScopeKeys, ScopeValue>
>;

/**
 * Scope values inferred from scope definitions.
 */
export type ScopeValuesFromPatterns<
  Definitions extends readonly ScopeDefinition[],
> = ScopeValuesForKeys<ScopeKeysFromDefinitions<Definitions>>;

/**
 * Stored scopes constrained to known scope keys.
 */
export type StoredScopesForKeys<ScopeKeys extends string> = Partial<
  Record<ScopeKeys, string>
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
export type ScopeDefinition =
  | ScopePattern
  | { pattern: ScopePattern; column: string };

/**
 * Keep scope definitions as a typed tuple for downstream inference.
 *
 * @example
 * const scopes = defineScopePatterns(['user:{user_id}'] as const);
 */
export function defineScopePatterns<
  const Definitions extends readonly ScopeDefinition[],
>(scopes: Definitions): Definitions {
  return scopes;
}

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
  scopes: readonly ScopeDefinition[]
): Record<ScopePattern, string> {
  const result: Record<ScopePattern, string> = {};
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
