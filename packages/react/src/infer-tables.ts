/**
 * Conservative table inference for `useRawSql` (TODO 3.1: "infer
 * conservatively from the SQL text's table names … documented as a
 * heuristic with the explicit option as the escape hatch").
 *
 * This is a SIMPLE identifier scan, NOT a SQL parser. It collects the
 * identifiers that follow `FROM` and `JOIN` — the tables a SELECT reads.
 * It is deliberately over-inclusive at the edges (a table aliased in a CTE,
 * a function-table, an odd quoting style) because the failure mode of
 * over-inclusion is a harmless extra re-run, whereas under-inclusion is a
 * stale query — the one thing live queries must never do. When a query's
 * real dependencies cannot be read off its text (dynamic SQL, views,
 * unusual syntax), pass the explicit `tables` option; that always wins.
 */

const FROM_JOIN_RE =
  /\b(?:from|join)\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([a-zA-Z_][a-zA-Z0-9_$]*))/gi;

/**
 * Extract the table names a SELECT reads. Returns a de-duplicated,
 * lower-nothing set (identifiers are compared to invalidation table names
 * as-is — SQLite table names are case-sensitive for our generated schema).
 */
export function inferTables(sql: string): Set<string> {
  const tables = new Set<string>();
  // Strip a leading schema qualifier (`main.tasks` → `tasks`) so the name
  // matches the invalidation event's bare table name.
  for (const match of sql.matchAll(FROM_JOIN_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (raw === undefined) continue;
    const dot = raw.lastIndexOf('.');
    tables.add(dot === -1 ? raw : raw.slice(dot + 1));
  }
  return tables;
}
