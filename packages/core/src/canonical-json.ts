/**
 * Canonical JSON for digests (SPEC.md §11.2) — contractual across
 * implementations: UTF-8, no insignificant whitespace, object keys sorted
 * by code-unit, scope value lists sorted and deduplicated.
 *
 * Used for the scope digest (§3.5) and the `X-Syncular-Scopes` header
 * (§5.5). Hashing itself is the host's job; this module only produces the
 * canonical text.
 */
export function canonicalScopeJson(
  scopes: Readonly<Record<string, readonly string[]>>,
): string {
  const keys = Object.keys(scopes).sort();
  const parts = keys.map((key) => {
    const values = [...new Set(scopes[key] ?? [])].sort();
    const list = values.map((value) => JSON.stringify(value)).join(',');
    return `${JSON.stringify(key)}:[${list}]`;
  });
  return `{${parts.join(',')}}`;
}
