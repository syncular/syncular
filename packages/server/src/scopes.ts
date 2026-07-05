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
 * Effective = requested ∩ allowed per §3.2 rules 4–5. Inputs are assumed
 * key-validated (requested keys declared, no `'*'` requested values).
 */
export function computeEffective(
  requested: ScopeMap,
  resolved: ResolvedScopes,
): EffectiveOutcome {
  if (!resolved.ok) return { status: 'revoked' };
  const effective: ScopeMap = {};
  const requestedKeys = Object.keys(requested);
  for (const key of requestedKeys) {
    const requestedValues = requested[key] ?? [];
    const allowedValues = resolved.allowed[key];
    if (allowedValues === undefined) return { status: 'revoked' };
    let values: string[];
    if (allowedValues.includes('*')) {
      values = [...requestedValues];
    } else {
      values = requestedValues.filter((v) => allowedValues.includes(v));
    }
    if (values.length === 0) return { status: 'revoked' };
    effective[key] = values;
  }
  if (Object.keys(effective).length === 0) return { status: 'revoked' };
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
 * Extract the stored scopes (§3.1) from a decoded row. Returns the missing
 * variable name when a declared scope column is absent or empty.
 */
export function storedScopesForRow(
  table: CompiledTable,
  values: readonly RowValue[],
): { scopes: StoredScopes } | { missing: string } {
  const scopes: StoredScopes = {};
  for (const pattern of table.scopePatterns) {
    const value = renderScopeValue(values[pattern.columnIndex]);
    if (value === undefined) return { missing: pattern.variable };
    scopes[pattern.variable] = value;
  }
  return { scopes };
}

/**
 * Write-path authorization (§3.4 steps 2–3): every declared variable's
 * stored value must be present and allowed (or the allowed list holds
 * `'*'`). All declared keys are required — there is no partial pass.
 */
export function authorizeWrite(
  table: CompiledTable,
  rowScopes: StoredScopes,
  resolved: ResolvedScopes,
): boolean {
  if (!resolved.ok) return false;
  for (const pattern of table.scopePatterns) {
    const value = rowScopes[pattern.variable];
    if (value === undefined || value.length === 0) return false;
    const allowedValues = resolved.allowed[pattern.variable];
    if (allowedValues === undefined) return false;
    if (!allowedValues.includes('*') && !allowedValues.includes(value)) {
      return false;
    }
  }
  return true;
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
