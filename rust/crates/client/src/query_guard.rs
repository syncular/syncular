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
    if !READ_ONLY_VERBS.contains(&verb.as_str()) {
        return Err(format!(
            "query() is read-only — this statement writes the local database \
             directly, which bypasses the sync outbox (SPEC §7.1); use \
             mutate() for inserts/updates/deletes. Rejected: {}",
            first_words(sql)
        ));
    }
    Ok(())
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
            "",
            "   ",
            "-- only a comment",
            ";",
        ] {
            assert!(assert_read_only_query(sql).is_err(), "should reject: {sql}");
        }
    }
}
