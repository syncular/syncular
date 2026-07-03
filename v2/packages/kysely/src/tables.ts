/**
 * Extract every table name a compiled query reads, by walking the Kysely
 * operation-node tree for `TableNode`s. This is the AST equivalent of
 * `@syncular-v2/react`'s `inferTables` SQL-text scan — but exact, since it
 * reads the structured query rather than the string. It feeds the React
 * hook's `{tables}` invalidation set: a live query re-runs when any of these
 * tables is invalidated.
 *
 * The walk is intentionally over-inclusive (it collects tables in CTEs,
 * subqueries, and joins) because over-inclusion only costs a harmless extra
 * re-run, whereas under-inclusion is a stale query — the one thing a live
 * query must never be. Schema qualifiers are dropped so names match the
 * invalidation event's bare table names.
 */
import type { CompiledQuery } from 'kysely';

interface TableNodeLike {
  readonly kind: 'TableNode';
  readonly table: {
    readonly identifier: { readonly name: string };
  };
}

function isTableNode(value: unknown): value is TableNodeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'TableNode'
  );
}

/** Depth-first collect of every `TableNode.table.identifier.name`. */
export function extractTables(query: CompiledQuery): readonly string[] {
  const tables = new Set<string>();
  const seen = new Set<unknown>();
  const stack: unknown[] = [query.query];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (isTableNode(node)) {
      const name = node.table.identifier.name;
      if (typeof name === 'string' && name.length > 0) tables.add(name);
    }
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return [...tables];
}
