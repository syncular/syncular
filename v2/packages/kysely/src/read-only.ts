/**
 * Read-only enforcement (the load-bearing rule of this package).
 *
 * Kysely is syncular's typed READ layer. Writes MUST go through
 * `client.mutate()` so they land in the outbox and sync (SPEC §7.1) — a
 * Kysely INSERT/UPDATE/DELETE would write the local mirror directly,
 * bypassing the outbox and silently diverging from the server. So the driver
 * rejects any non-SELECT statement, loudly, pointing the caller at `mutate`.
 *
 * The check is at the DRIVER (the SQL string), not the builder, so it also
 * catches `sql`-tagged raw fragments and compiled queries handed in directly.
 */

/** The verbs a read-only driver serves. Everything else is rejected. */
const READ_ONLY_PREFIXES = ['select', 'with', 'explain', 'pragma', 'values'];

export class SyncularReadOnlyError extends Error {
  constructor(sql: string) {
    super(
      'syncular kysely is a READ-only typed layer — this statement writes ' +
        'the local database directly, which bypasses the sync outbox ' +
        '(SPEC §7.1). Use `client.mutate([...])` for inserts/updates/' +
        `deletes. Rejected SQL: ${firstWords(sql)}`,
    );
    this.name = 'SyncularReadOnlyError';
  }
}

function firstWords(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, ' ');
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/**
 * Strip leading SQL comments/whitespace and test the first keyword against
 * the read-only allowlist. A `WITH …` CTE is allowed because SQLite CTEs
 * front SELECTs here (a data-modifying CTE would still be caught: its outer
 * statement keyword is INSERT/UPDATE/DELETE, not WITH). Fail closed: an
 * unrecognized/empty statement is rejected.
 */
export function assertReadOnly(sql: string): void {
  const stripped = sql
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '')
    .trimStart();
  const match = stripped.match(/^([a-zA-Z]+)/);
  const verb = match?.[1]?.toLowerCase();
  if (verb === undefined || !READ_ONLY_PREFIXES.includes(verb)) {
    throw new SyncularReadOnlyError(sql);
  }
}
