/**
 * Scope semantics (SPEC.md §3) — requested ∩ allowed intersection,
 * revocation, stored-scope extraction, write-path authorization, and the
 * §3.5 scope digest.
 */
import {
  canonicalScopeJson,
  type RowValue,
  type ScopeMap,
} from '@syncular/core';
import type { CompiledTable } from './schema';

export type StoredScopes = Record<string, string>;

/** Outcome of resolving the host's allowed scopes once per request (§3.4). */
export type ResolvedScopes =
  | { readonly ok: true; readonly allowed: ScopeMap }
  | { readonly ok: false };

export type EffectiveOutcome =
  | { readonly status: 'active'; readonly effective: ScopeMap }
  | { readonly status: 'revoked' };

/**
 * Effective = requested ∩ allowed per §3.2 rules 4–6. Inputs are assumed
 * key-validated (requested keys declared, no `'*'` requested values).
 * `declared` is the table's declared variables: when a requested key passes
 * through an allowed `'*'`, every declared variable the request omits and
 * the actor holds a non-wildcard list for joins effective with that list
 * (rule 4), so the wildcard never lifts the actor's other fences.
 */
export function computeEffective(
  declared: ReadonlySet<string>,
  requested: ScopeMap,
  resolved: ResolvedScopes,
): EffectiveOutcome {
  if (!resolved.ok) return { status: 'revoked' };
  const effective: ScopeMap = {};
  let wildcard = false;
  for (const key of Object.keys(requested)) {
    const requestedValues = requested[key] ?? [];
    const allowedValues = resolved.allowed[key];
    if (allowedValues === undefined) return { status: 'revoked' };
    let values: string[];
    if (allowedValues.includes('*')) {
      wildcard = true;
      values = [...requestedValues];
    } else {
      values = requestedValues.filter((v) => allowedValues.includes(v));
    }
    if (values.length === 0) return { status: 'revoked' };
    effective[key] = values;
  }
  if (Object.keys(effective).length === 0) return { status: 'revoked' };
  if (wildcard) {
    for (const variable of declared) {
      const allowedValues = resolved.allowed[variable];
      if (
        Object.hasOwn(requested, variable) ||
        allowedValues === undefined ||
        allowedValues.includes('*')
      ) {
        continue;
      }
      if (allowedValues.length === 0) return { status: 'revoked' };
      effective[variable] = [...allowedValues];
    }
  }
  return { status: 'active', effective };
}

/** Render a stored scope column value; `undefined` means missing/empty. */
export function renderScopeValue(
  value: RowValue | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Uint8Array) return undefined;
  const rendered = typeof value === 'string' ? value : String(value);
  return rendered.length === 0 ? undefined : rendered;
}

/**
 * Extract the stored scopes (§3.1) from a decoded row. A NULL column outside
 * the owner set leaves its variable without a stored scope. Returns the
 * variable name when a column is empty, or NULL in the owner set.
 */
export function storedScopesForRow(
  table: CompiledTable,
  values: readonly RowValue[],
): { scopes: StoredScopes } | { missing: string } {
  const scopes: StoredScopes = {};
  for (const pattern of table.scopePatterns) {
    const raw = values[pattern.columnIndex];
    if (
      (raw === null || raw === undefined) &&
      !table.writeScopeSets[0]!.includes(pattern.variable)
    ) {
      continue;
    }
    const value = renderScopeValue(raw);
    if (value === undefined) return { missing: pattern.variable };
    scopes[pattern.variable] = value;
  }
  return { scopes };
}

/**
 * Write-path authorization (§3.4 step 3): a write set admits the row when
 * each of its variables has a value the actor is allowed (or `'*'`). An
 * insert and a rescope need the owner set; an existing row needs any set.
 */
export function authorizeWrite(
  table: CompiledTable,
  rowScopes: StoredScopes,
  resolved: ResolvedScopes,
  ownerOnly = false,
): boolean {
  if (!resolved.ok) return false;
  const { allowed } = resolved;
  return (
    ownerOnly ? table.writeScopeSets.slice(0, 1) : table.writeScopeSets
  ).some((set) =>
    set.every((variable) => {
      const value = rowScopes[variable];
      const values = allowed[variable];
      return (
        value !== undefined &&
        value.length > 0 &&
        values !== undefined &&
        (values.includes('*') || values.includes(value))
      );
    }),
  );
}

/** Does a change's stored scopes match the effective scopes (§3.2)? */
export function matchesEffective(
  storedScopes: StoredScopes,
  effective: ScopeMap,
): boolean {
  for (const [variable, values] of Object.entries(effective)) {
    const stored = storedScopes[variable];
    if (stored === undefined || !values.includes(stored)) return false;
  }
  return true;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** §3.5: SHA-256 over the canonical JSON of the effective-scope map. */
export async function scopeDigest(effective: ScopeMap): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalScopeJson(effective)));
}
