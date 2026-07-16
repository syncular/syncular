//! The raw-query guard (DESIGN-queries.md I3), mirrored from the TS core's
//! `query-guard.ts` — the two cores enforce the same rule so `query` behaves
//! identically through every binding:
//!
//! 1. READ-ONLY: only `select / with / explain / pragma / values` may run.
//!    A write against the local mirror bypasses the outbox (SPEC §7.1) and
//!    silently diverges from the server — writes go through `mutate`.
//! 2. ONE STATEMENT: `sqlite3_prepare` parses only the first statement and
//!    silently ignores the tail; instead of ignoring, reject loudly.
//!
//! Engine-internal reads use the connection directly and never route here.

const READ_ONLY_VERBS: [&str; 5] = ["select", "with", "explain", "pragma", "values"];
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

/// Assert `sql` is one read-only statement; `Err(message)` otherwise.
pub fn assert_read_only_query(sql: &str) -> Result<(), String> {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Err("query() was given an empty statement".to_owned());
    }
    if statements.len() > 1 {
        return Err(format!(
            "query() runs a single statement, but {} were given — split them \
             into separate query() calls",
            statements.len()
        ));
    }
    let head = strip_leading(statements[0]);
    let verb: String = head
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    let reject = || {
        Err(format!(
            "query() is read-only — this statement writes the local database \
             directly, which bypasses the sync outbox (SPEC §7.1); use \
             mutate() for inserts/updates/deletes. Rejected: {}",
            first_words(sql)
        ))
    };
    if !READ_ONLY_VERBS.contains(&verb.as_str()) {
        return reject();
    }
    if verb == "with" {
        // SQLite allows `WITH … DELETE/INSERT/UPDATE`; only a SELECT/VALUES
        // main statement is a read.
        match main_verb_after_with(head) {
            Some(main) if main == "select" || main == "values" => {}
            _ => return reject(),
        }
    }
    Ok(())
}

/// The main verb of a `WITH …` statement. CTE bodies live inside
/// parentheses, and a bare keyword cannot be a CTE name, so the first
/// paren-depth-0 keyword after the clause is the main verb.
fn main_verb_after_with(sql: &str) -> Option<String> {
    const MAIN_VERBS: [&str; 6] = ["select", "values", "insert", "update", "delete", "replace"];
    let bytes = sql.as_bytes();
    let n = bytes.len();
    let mut depth: i32 = 0;
    let mut i = 0usize;
    let mut saw_with = false;
    while i < n {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(n, |off| i + off + 1);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = sql[i + 2..].find("*/").map_or(n, |off| i + 2 + off + 2);
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < n {
                    if bytes[i] == q {
                        if bytes.get(i + 1) == Some(&q) {
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
            b'[' => {
                i = sql[i + 1..].find(']').map_or(n, |off| i + 1 + off + 1);
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let mut j = i + 1;
                while j < n && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                    j += 1;
                }
                let word = sql[i..j].to_ascii_lowercase();
                if depth == 0 {
                    if !saw_with && word == "with" {
                        saw_with = true;
                    } else if saw_with && MAIN_VERBS.contains(&word.as_str()) {
                        return Some(word);
                    }
                }
                i = j;
            }
            _ => i += 1,
        }
    }
    None
}

/// Split into top-level statements at unquoted `;`, skipping string
/// literals, quoted/bracketed identifiers and comments. Statements that are
/// only whitespace/comments are dropped.
fn split_statements(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let n = bytes.len();
    while i < n {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(n, |off| i + off + 1);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = sql[i + 2..].find("*/").map_or(n, |off| i + 2 + off + 2);
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < n {
                    if bytes[i] == q {
                        if bytes.get(i + 1) == Some(&q) {
                            i += 2; // doubled quote escapes itself
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'[' => {
                i = sql[i + 1..].find(']').map_or(n, |off| i + 1 + off + 1);
            }
            b';' => {
                let piece = &sql[start..i];
                if !strip_leading(piece).is_empty() {
                    statements.push(piece);
                }
                start = i + 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    let piece = &sql[start..];
    if !strip_leading(piece).is_empty() {
        statements.push(piece);
    }
    statements
}

/// Strip leading whitespace and comments.
fn strip_leading(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |off| &after[off + 1..]);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |off| &after[off + 2..]);
        } else {
            return rest;
        }
        rest = rest.trim_start();
    }
}

fn first_words(sql: &str) -> String {
    let compact = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > 72 {
        let head: String = compact.chars().take(72).collect();
        format!("{head}…")
    } else {
        compact
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_read_only_verbs() {
        for sql in [
            "SELECT 1",
            "  select * from tasks",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "WITH x AS (SELECT 1), y AS (SELECT 2) SELECT * FROM x, y",
            "WITH RECURSIVE c(n) AS (VALUES (1)) SELECT n FROM c",
            "EXPLAIN QUERY PLAN SELECT 1",
            "PRAGMA table_info(tasks)",
            "VALUES (1), (2)",
            "-- leading comment\nSELECT 1",
            "/* block */ SELECT 1",
            "SELECT 1;",
            "SELECT 1; -- done",
            "SELECT ';' AS s",
            "SELECT 'it''s; fine'",
            "SELECT \"a;b\" FROM tasks",
            "SELECT [a;b] FROM tasks",
        ] {
            assert!(assert_read_only_query(sql).is_ok(), "should allow: {sql}");
        }
    }

    #[test]
    fn rejects_writes_and_multi_statements() {
        for sql in [
            "INSERT INTO tasks (id) VALUES ('t1')",
            "UPDATE tasks SET title = 'x'",
            "DELETE FROM tasks",
            "DROP TABLE tasks",
            "CREATE TABLE evil (id)",
            "BEGIN",
            "VACUUM",
            "SELECT 1; DROP TABLE tasks",
            "SELECT 1; SELECT 2",
            "WITH t AS (SELECT 1) DELETE FROM tasks",
            "WITH t AS (SELECT 1) INSERT INTO tasks (id) SELECT 'x'",
            "WITH t AS (SELECT 1) UPDATE tasks SET title = 'x'",
            "",
            "   ",
            "-- only a comment",
            ";",
        ] {
            assert!(assert_read_only_query(sql).is_err(), "should reject: {sql}");
        }
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
