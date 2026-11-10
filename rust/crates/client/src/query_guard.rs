//! The raw-query guard, mirrored from the TS core's `query-guard.ts`; both
//! cores refuse the same SQL through `query` and the snapshot reads:
//!
//! 1. READ-ONLY: SQLite decides (`sqlite3_stmt_readonly`) and the statement
//!    returns columns, which refuses `BEGIN`, `ATTACH` and the other read-only
//!    statements that change the connection. A write against the local
//!    mirror bypasses the outbox (SPEC §7.1); writes go through `mutate`.
//! 2. NO PRAGMA, refused before SQLite compiles anything: SQLite applies a
//!    flag pragma such as `query_only` while it compiles the statement, even
//!    under `EXPLAIN`. `pragma_table_info('tasks')` reads a pragma instead.
//! 3. ONE STATEMENT: anything but whitespace, comments and semicolons after
//!    the first statement is refused. Only the first statement is compiled
//!    (`Batch`), because `Connection::prepare` compiles the tail as well.
//!
//! Engine-internal reads use the connection directly and never route here.

use crate::api::QueryReadFailure;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{Batch, Connection, Statement};

const PUBLIC_SYNC_VERSION: &str = "_sync_version";
const NATIVE_SYNC_VERSION: &str = "_syncular_version";

/// Lower the app-facing row-version pseudo-column to the Rust client's private
/// physical column. The TypeScript client stores `_sync_version` directly;
/// Rust keeps `_syncular_version` for SSP2 SQLite-image parity, but both query
/// surfaces must accept the same authored SQL.
///
/// Only SQL identifiers are rewritten. Single-quoted values and comments are
/// copied byte-for-byte so application data cannot be changed by lowering.
pub(crate) fn lower_public_query_sql(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut output = String::with_capacity(sql.len());
    let mut copied_through = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..]
                    .find('\n')
                    .map_or(bytes.len(), |offset| i + offset + 1);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = sql[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |offset| i + 2 + offset + 2);
            }
            b'\'' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
                        if bytes.get(i + 1) == Some(&b'\'') {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            quote @ (b'"' | b'`') => {
                let content_start = i + 1;
                let mut end = content_start;
                while end < bytes.len() && bytes[end] != quote {
                    end += 1;
                }
                if end < bytes.len()
                    && sql[content_start..end].eq_ignore_ascii_case(PUBLIC_SYNC_VERSION)
                {
                    output.push_str(&sql[copied_through..content_start]);
                    output.push_str(NATIVE_SYNC_VERSION);
                    copied_through = end;
                }
                i = (end + 1).min(bytes.len());
            }
            b'[' => {
                let content_start = i + 1;
                let end = sql[content_start..]
                    .find(']')
                    .map_or(bytes.len(), |offset| content_start + offset);
                if end < bytes.len()
                    && sql[content_start..end].eq_ignore_ascii_case(PUBLIC_SYNC_VERSION)
                {
                    output.push_str(&sql[copied_through..content_start]);
                    output.push_str(NATIVE_SYNC_VERSION);
                    copied_through = end;
                }
                i = (end + 1).min(bytes.len());
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if sql[start..i].eq_ignore_ascii_case(PUBLIC_SYNC_VERSION) {
                    output.push_str(&sql[copied_through..start]);
                    output.push_str(NATIVE_SYNC_VERSION);
                    copied_through = i;
                }
            }
            _ => i += 1,
        }
    }
    output.push_str(&sql[copied_through..]);
    output
}

/// Prepare the first statement of `sql` for the raw-SQL tier, or refuse it.
pub(crate) fn prepare_read_only<'c>(
    conn: &'c Connection,
    sql: &str,
) -> Result<Statement<'c>, QueryReadFailure> {
    let read_only = || {
        QueryReadFailure::from(
            "query() runs read-only statements and no PRAGMA; write through mutate() so the \
             outbox records it (SPEC §7.1)"
                .to_owned(),
        )
    };
    let mut rest = skip_blank(sql);
    loop {
        let word = &rest[..rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len())];
        if word.eq_ignore_ascii_case("pragma") {
            return Err(read_only());
        }
        if !["explain", "query", "plan"]
            .iter()
            .any(|keyword| word.eq_ignore_ascii_case(keyword))
        {
            break;
        }
        rest = skip_blank(&rest[word.len()..]);
    }
    let bytes = sql.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end] != b';' {
        end = match bytes[end] {
            b'-' if bytes.get(end + 1) == Some(&b'-') => sql[end..]
                .find('\n')
                .map_or(bytes.len(), |off| end + off + 1),
            b'/' if bytes.get(end + 1) == Some(&b'*') => sql[end + 2..]
                .find("*/")
                .map_or(bytes.len(), |off| end + off + 4),
            quote @ (b'\'' | b'"' | b'`') => sql[end + 1..]
                .find(char::from(quote))
                .map_or(bytes.len(), |off| end + off + 2),
            b'[' => sql[end + 1..]
                .find(']')
                .map_or(bytes.len(), |off| end + off + 2),
            _ => end + 1,
        };
    }
    if !skip_blank(&sql[end..]).is_empty() {
        return Err("query() runs one statement per call".to_owned().into());
    }
    let statement = Batch::new(conn, sql)
        .next()?
        .ok_or_else(|| "query() was given an empty statement".to_owned())?;
    if !statement.readonly() || statement.column_count() == 0 {
        return Err(read_only());
    }
    Ok(statement)
}

/// Skip leading whitespace, comments and empty statements.
fn skip_blank(sql: &str) -> &str {
    let mut rest = sql;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ';');
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |off| &after[off + 1..]);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |off| &after[off + 2..]);
        } else {
            return rest;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a'), ('z');")
            .unwrap();
        conn
    }

    #[test]
    fn runs_one_statement_sqlite_reports_read_only() {
        let conn = connection();
        for sql in [
            "  select id from t",
            "WITH x AS (SELECT 1 AS v) SELECT v FROM x",
            "WITH RECURSIVE c(n) AS (VALUES (1)) SELECT n FROM c",
            "WITH \"x$delete\" AS (SELECT 1 AS v) SELECT v FROM \"x$delete\"",
            "EXPLAIN QUERY PLAN SELECT 1",
            "SELECT * FROM pragma_table_info('t')",
            "VALUES (1), (2)",
            "-- leading comment\nSELECT 1",
            "/* block */ SELECT 1",
            "SELECT ';' AS s",
            "SELECT 'it''s; fine' AS s",
            "SELECT \"id\" FROM t WHERE ';' <> 1 -- trailing; comment",
            "SELECT /* ; */ 1",
            "SELECT [id] FROM t",
            "SELECT 1;",
            "SELECT 1;  -- done",
            "SELECT 1;;",
        ] {
            assert!(prepare_read_only(&conn, sql).is_ok(), "should allow: {sql}");
        }
    }

    #[test]
    fn refuses_writes_pragma_and_multi_statements_before_they_act() {
        let conn = connection();
        for sql in [
            "INSERT INTO t (id) VALUES ('w')",
            "UPDATE t SET id = 'w'",
            "DELETE FROM t",
            "REPLACE INTO t (id) VALUES ('w')",
            "DROP TABLE t",
            "CREATE TABLE evil (id)",
            "ALTER TABLE t ADD COLUMN evil TEXT",
            "BEGIN",
            "VACUUM",
            "ATTACH ':memory:' AS evil",
            "WITH x AS (SELECT 1) DELETE FROM t",
            "WITH x$select AS (SELECT 1) DELETE FROM t",
            "WITH x AS (SELECT 1), y AS (SELECT 2) INSERT INTO t (id) VALUES ('w')",
            "PRAGMA query_only = ON",
            "EXPLAIN PRAGMA query_only = ON",
            "explain /* c */ query plan pragma query_only = ON",
            "; -- c\nPRAGMA query_only = ON",
            "SELECT 1; PRAGMA query_only = ON",
            "PRAGMA table_info(t)",
            "SELECT 1; SELECT 2",
            "SELECT 1; DELETE FROM t",
            "",
            "   ",
            "-- only a comment",
            ";",
        ] {
            let refused = prepare_read_only(&conn, sql).map(|_| ());
            assert!(refused.is_err(), "should refuse: {sql}");
            assert_eq!(refused.unwrap_err().code, None, "{sql}");
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |row| row.get(0))
            .unwrap();
        let query_only: i64 = conn
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();
        assert_eq!((count, query_only), (2, 0));
    }

    #[test]
    fn lowers_only_app_facing_sync_version_identifiers() {
        let sql = "SELECT t._sync_version AS server_version, \"_sync_version\" AS quoted \
                   FROM tasks t WHERE note = '_sync_version' /* _sync_version */ \
                   -- _sync_version\nORDER BY t.id";
        let lowered = lower_public_query_sql(sql);
        assert!(lowered.contains("t._syncular_version AS server_version"));
        assert!(lowered.contains("\"_syncular_version\" AS quoted"));
        assert!(lowered.contains("note = '_sync_version'"));
        assert!(lowered.contains("/* _sync_version */"));
        assert!(lowered.contains("-- _sync_version"));
    }
}
