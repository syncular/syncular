/**
 * The pinned snake→camel naming map (DESIGN-queries.md §5, §12) — the
 * client-side copy of the typegen algorithm (kept in lockstep by shared
 * test vectors; the Rust core carries the same function). Used by `mutate`
 * to accept BOTH casings for value keys: the canonical camelCase the
 * generated row types use, and the SQL-truth snake_case. One bijective map
 * lookup per key; anything else errors (no fuzzy matching).
 */

const MAPPABLE_RE = /^_*[A-Za-z][A-Za-z0-9_]*$/;

/** The pinned §12 snake→camel conversion (see typegen's naming.ts). */
export function snakeToCamel(name: string): string {
  if (!MAPPABLE_RE.test(name)) return name;
  const lead = /^_*/.exec(name)?.[0] ?? '';
  const bare = name.slice(lead.length);
  const trail = /_*$/.exec(bare)?.[0] ?? '';
  const middle = bare.slice(0, bare.length - trail.length);
  const segments = middle.split('_').filter((s) => s.length > 0);
  if (segments.length === 0) return name;
  const first = segments[0] as string;
  const rest = segments
    .slice(1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return lead + first + rest.join('') + trail;
}
