/**
 * The raw-query guard (DESIGN-queries.md I3). `client.query()` / the React
 * `useRawSql` hook are the untrusted raw-SQL tier: an app hands us a SQL
 * string and we run it against the local database. Two rules make that safe
 * to expose, enforced HERE in the core (previously they lived in the
 * now-removed `@syncular/kysely` read-only driver):
 *
 *   1. READ-ONLY. Only `select / with / explain / pragma / values` are
 *      allowed. A write (`insert/update/delete/…`) against the local mirror
 *      bypasses the outbox (SPEC §7.1) and silently diverges from the
 *      server — writes MUST go through `client.mutate([...])`.
 *   2. ONE STATEMENT. `sqlite-wasm`'s `exec` runs every statement in a
 *      multi-statement string (`SELECT 1; DROP TABLE t`), while bun:sqlite /
 *      better-sqlite3 prepare only the first. We unify on the strict
 *      behaviour: exactly one statement per `query()`.
 *
 * The guard only fronts the PUBLIC `client.query()` — engine-internal reads
 * call the `ClientDatabase` directly and are trusted, so they are never
 * routed through here.
 */

/** Verbs a read-only query may begin with (lowercased). */
const READ_ONLY_VERBS = new Set([
  'select',
  'with',
  'explain',
  'pragma',
  'values',
]);

/** Raised when `client.query()` is handed SQL it will not run. */
export class RawSqlError extends Error {
  override readonly name = 'RawSqlError';
}

/**
 * Split `sql` into top-level statements at unquoted `;`, skipping over
 * string literals ('…'), quoted/bracketed identifiers ("…", `…`, […]) and
 * comments (-- …, /* … *​/) so a `;` inside any of them is not a boundary.
 * Returns the non-empty statements (comment/whitespace-only trailers drop).
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const pushIfNonEmpty = (end: number) => {
    const stripped = stripLeading(sql.slice(start, end));
    if (stripped.length > 0) statements.push(sql.slice(start, end));
    start = end + 1;
  };

  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i, c as "'" | '"' | '`');
    } else if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      i = close === -1 ? n : close + 1;
    } else if (c === ';') {
      pushIfNonEmpty(i);
      i += 1;
    } else {
      i += 1;
    }
  }
  pushIfNonEmpty(n);
  return statements;
}

/** Advance past a quoted run opened at `open`; SQL doubles the quote to escape it. */
function skipQuoted(sql: string, open: number, quote: "'" | '"' | '`'): number {
  let i = open + 1;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else {
      i += 1;
    }
  }
  return n;
}

/** Strip leading whitespace and comments, returning the remainder. */
function stripLeading(sql: string): string {
  return sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)+/, '')
    .trimStart();
}

function firstWords(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, ' ');
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed;
}

/**
 * Assert `sql` is a single read-only statement, or throw `RawSqlError`.
 * Called by `client.query()` before the string reaches the database.
 */
export function assertReadOnlyQuery(sql: string): void {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new RawSqlError('client.query() was given an empty statement.');
  }
  if (statements.length > 1) {
    throw new RawSqlError(
      `client.query() runs a single statement, but ${statements.length} were ` +
        'given. Split them into separate query() calls. ' +
        `First: ${firstWords(statements[0] ?? '')}`,
    );
  }
  const verb = stripLeading(statements[0] ?? '')
    .match(/^([a-zA-Z]+)/)?.[1]
    ?.toLowerCase();
  if (verb === undefined || !READ_ONLY_VERBS.has(verb)) {
    throw new RawSqlError(
      'client.query() is read-only — this statement writes the local ' +
        'database directly, which bypasses the sync outbox (SPEC §7.1). Use ' +
        '`client.mutate([...])` for inserts/updates/deletes. ' +
        `Rejected: ${firstWords(sql)}`,
    );
  }
}
