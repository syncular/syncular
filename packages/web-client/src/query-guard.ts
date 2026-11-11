/**
 * The raw-query guard behind `client.query()`, `querySnapshot()` and
 * `snapshotRead()`, the untrusted raw-SQL tier. Each `ClientDatabase` adapter
 * prepares only the first statement and reports what SQLite knows about it:
 *
 *   1. READ-ONLY. SQLite decides (`sqlite3_stmt_readonly`) and the statement
 *      returns columns, which refuses `BEGIN`, `ATTACH` and the other
 *      read-only statements that change the connection. A write against the
 *      local mirror bypasses the outbox (SPEC §7.1); writes go through
 *      `client.mutate([...])`.
 *   2. NO PRAGMA, refused before SQLite compiles anything: SQLite applies a
 *      flag pragma such as `query_only` while it compiles the statement, even
 *      under `EXPLAIN`. Read a pragma through its table-valued function
 *      (`SELECT * FROM pragma_table_info('tasks')`).
 *   3. ONE STATEMENT. Anything but whitespace, comments and semicolons after
 *      the first statement is refused, because sqlite-wasm's `exec` runs
 *      every statement in the string. The tail is never compiled.
 *
 * Engine-internal reads call the `ClientDatabase` directly and never route
 * here.
 */

/** Raised when `client.query()` is handed SQL it will not run. */
export class RawSqlError extends Error {
  override readonly name = 'RawSqlError';
}

/** Refuse a statement the raw-SQL tier does not run. */
export function refuseRawSql(): never {
  throw new RawSqlError(
    'client.query() runs read-only statements and no PRAGMA; write through client.mutate() so the outbox records it (SPEC §7.1).',
  );
}

/**
 * Prepare `sql` for the raw-SQL tier or throw `RawSqlError`. `prepare`
 * compiles the first statement only and returns it, the text SQLite compiled
 * for it, and whether SQLite reports it read-only with result columns.
 */
export function prepareReadOnly<S>(
  sql: string,
  prepare: () => readonly [statement: S, first: string, reads: boolean],
): S {
  if (
    /^(?:[\s;]|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$)|explain\b|query\b|plan\b)*pragma\b/i.test(
      sql,
    )
  ) {
    refuseRawSql();
  }
  const [statement, first, reads] = prepare();
  if (
    sql
      .slice(first.length)
      .replace(
        /^(?:[\s;]|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*/,
        '',
      ) !== ''
  ) {
    throw new RawSqlError('client.query() runs one statement per call.');
  }
  if (!reads) refuseRawSql();
  return statement;
}
