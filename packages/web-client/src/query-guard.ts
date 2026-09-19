/**
 * The raw-query guard. `client.query()` and the React
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
 *      multi-statement string (`SELECT 1; DROP TABLE t`), while the native
 *      SQLite adapters prepare only the first. We unify on the strict
 *      behaviour: exactly one statement per `query()`.
 *
 * The guard only fronts the PUBLIC `client.query()` — engine-internal reads
 * call the `ClientDatabase` directly and are trusted, so they are never
 * routed through here.
 *
 * RFC 0005 adds a third rule: the previous-version context container is
 * engine-private local data and MUST NOT be raw-readable through the public
 * read tier. The check is engine-authoritative (SQLite's own `EXPLAIN` plan
 * plus `sqlite_master` root pages), never a regex over table names, because a
 * covering-index read opens the INDEX's root page rather than the table's and
 * quoted, schema-qualified, CTE, subquery and view forms all defeat text
 * matching.
 */
import type { ClientDatabase, SqlRow } from './database';

/**
 * RFC 0005 D3: the one non-reserved container table holding captured rows from
 * the previous local schema. Named here (not in the capture module) so the
 * guard stays dependency-free.
 */
export const PREVIOUS_VERSION_CONTAINER = 'syncular_prev_context';

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
 * The main verb of a `WITH …` statement: SQLite allows a with-clause before
 * SELECT **and before INSERT/UPDATE/DELETE**, so `WITH t AS (…) DELETE …`
 * must not slip through the verb allowlist. CTE bodies live inside
 * parentheses, and a bare keyword cannot be a CTE name, so the first
 * paren-depth-0 keyword after the clause IS the main verb.
 */
function mainVerbAfterWith(sql: string): string | undefined {
  const MAIN_VERBS = new Set([
    'select',
    'values',
    'insert',
    'update',
    'delete',
    'replace',
  ]);
  let depth = 0;
  let i = 0;
  const n = sql.length;
  let sawWith = false;
  while (i < n) {
    const c = sql[i] as string;
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
    } else if (c === '(') {
      depth += 1;
      i += 1;
    } else if (c === ')') {
      depth -= 1;
      i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j] as string)) j += 1;
      const word = sql.slice(i, j).toLowerCase();
      if (depth === 0) {
        if (!sawWith && word === 'with') sawWith = true;
        else if (sawWith && MAIN_VERBS.has(word)) return word;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return undefined;
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
  const statement = stripLeading(statements[0] ?? '');
  const verb = statement.match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase();
  const rejectWrite = (): never => {
    throw new RawSqlError(
      'client.query() is read-only — this statement writes the local ' +
        'database directly, which bypasses the sync outbox (SPEC §7.1). Use ' +
        '`client.mutate([...])` for inserts/updates/deletes. ' +
        `Rejected: ${firstWords(sql)}`,
    );
  };
  if (verb === undefined || !READ_ONLY_VERBS.has(verb)) rejectWrite();
  if (verb === 'with') {
    // SQLite allows `WITH … DELETE/INSERT/UPDATE`; only a SELECT/VALUES
    // main statement is a read.
    const main = mainVerbAfterWith(statement);
    if (main !== 'select' && main !== 'values') rejectWrite();
  }
}

/**
 * RFC 0005 D4: the root pages that belong to the container table and every
 * index SQLite created on it (the `PRIMARY KEY (tbl, row_id)` autoindex).
 * `undefined` means the container does not exist, so no read can reach it.
 * Root pages are per-database, so this set is only meaningful against opcodes
 * with `p3 = 0` (`main`).
 */
function protectedRootPages(db: ClientDatabase): Set<number> | undefined {
  const rows = db.query(
    'SELECT rootpage FROM sqlite_master WHERE tbl_name = ?',
    [PREVIOUS_VERSION_CONTAINER],
  );
  if (rows.length === 0) return undefined;
  const pages = new Set<number>();
  for (const row of rows) {
    const page = Number(row.rootpage);
    if (Number.isSafeInteger(page) && page > 0) pages.add(page);
  }
  return pages;
}

/** True iff the RFC 0005 container currently exists locally. */
export function previousVersionContainerExists(db: ClientDatabase): boolean {
  return protectedRootPages(db) !== undefined;
}

/**
 * RFC 0005 D4: refuse a statement that reads `syncular_prev_context`.
 *
 * The caller MUST run this inside the same transaction that executes `sql` on
 * the same connection: the protected root-page set is re-read on every call
 * and never cached, so a schema change cannot land between the decision and
 * the read. The check fails closed while the container exists: an unavailable
 * or unparseable `EXPLAIN`, or any `OpenRead`/`OpenWrite` against an attached
 * or `temp` database, is a refusal.
 */
export function assertProtectedTableAccess(
  db: ClientDatabase,
  sql: string,
): void {
  const pages = protectedRootPages(db);
  if (pages === undefined) return;
  const refuse = (detail: string): never => {
    throw new RawSqlError(
      `client.query() refused a statement that reads the ${PREVIOUS_VERSION_CONTAINER} ` +
        `container (RFC 0005): ${detail}. Read captured previous-version rows ` +
        'only through client.previousVersionSnapshot().',
    );
  };
  let plan: SqlRow[];
  try {
    plan = db.query(`EXPLAIN ${sql}`);
  } catch {
    return refuse('EXPLAIN is unavailable');
  }
  if (plan.length === 0) return refuse('EXPLAIN returned no plan');
  let parsed = false;
  for (const row of plan) {
    const opcode = row.opcode;
    if (typeof opcode !== 'string') continue;
    parsed = true;
    if (opcode !== 'OpenRead' && opcode !== 'OpenWrite') continue;
    if (Number(row.p3) !== 0) {
      return refuse('the statement opens an attached or temporary database');
    }
    if (pages.has(Number(row.p2))) {
      return refuse('the statement opens the protected table or its index');
    }
  }
  if (!parsed) return refuse('the EXPLAIN plan could not be parsed');
}
