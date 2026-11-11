//! Authority storage over one SQLite connection.
//!
//! Every synced table is a table named like the replica's, in the layout of
//! the reference `SqliteServerStorage`: `_sync_partition` (always `local`),
//! `_sync_row_id`, one typed projection column per schema column,
//! `_sync_server_version`, `_sync_scopes` (JSON object), `_sync_payload` (the
//! full-row §2.4 codec bytes, the serve path's source of truth) and
//! `_sync_column_versions` (LEB128 `(ordinal, version)` pairs above 1).
//! Declared indexes are `sync_ix_<name>` over `(_sync_partition, columns…)`,
//! so a unique index enforces uniqueness in SQLite.
//!
//! The commit log, tombstones, idempotency records, client cursors and the
//! log identity live in `sync_*` tables. A schema bump (§12.2) adds tables,
//! appends nullable columns and re-keys tables whose scope patterns changed:
//! `ADD COLUMN` extends the projection, and the stored payloads (rows and
//! logged changes) are re-encoded with NULL in the appended slots.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use ssp2::primitives::{Reader, Writer};
use ssp2::segment::{decode_row, encode_row, Column, ColumnType, ColumnValue, Row};

use crate::schema::{Schema, Table};
use crate::{AuthorityError, Db, Retention};

/// The one partition a local authority serves (§12.2).
pub(crate) const PARTITION: &str = "local";

/// Stored scopes (§3.1): variable → value.
pub(crate) type Scopes = BTreeMap<String, String>;

/// A unit's scope map (§4.1), in its wire order.
pub(crate) type UnitScopes = Vec<(String, String)>;

pub(crate) const STATE_TABLE: &str = "sync_local_authority";

const INTERNAL_DDL: &str = "
CREATE TABLE IF NOT EXISTS sync_schema_meta(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  layouts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_log(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  log_epoch TEXT NOT NULL,
  max_commit_seq INTEGER NOT NULL,
  horizon_seq INTEGER NOT NULL,
  delete_floor INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sync_commits(
  commit_seq INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_changes(
  commit_seq INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op INTEGER NOT NULL,
  row_version INTEGER,
  scopes TEXT NOT NULL,
  payload BLOB,
  PRIMARY KEY (commit_seq, idx));
CREATE TABLE IF NOT EXISTS sync_tombstones(
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  server_version INTEGER,
  scopes TEXT,
  PRIMARY KEY (tbl, row_id));
CREATE INDEX IF NOT EXISTS sync_tombstones_by_seq ON sync_tombstones(commit_seq);
CREATE TABLE IF NOT EXISTS sync_push_results(
  client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL,
  result TEXT NOT NULL,
  outbox_id TEXT,
  client_seq INTEGER,
  PRIMARY KEY (client_id, client_commit_id));
CREATE TABLE IF NOT EXISTS sync_push_watermarks(
  client_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  PRIMARY KEY (client_id, outbox_id));
CREATE TABLE IF NOT EXISTS sync_clients(
  client_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_round_at_ms INTEGER NOT NULL,
  last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  units TEXT,
  registration_digest BLOB,
  catching_up TEXT NOT NULL DEFAULT '[]');
";

pub(crate) fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub(crate) fn corrupt(what: &str) -> AuthorityError {
    AuthorityError::with_details(
        "sync.internal_error",
        "the local authority storage is corrupt",
        json!({ "what": what }),
    )
}

/// One current row (§2.2).
#[derive(Debug, Clone)]
pub(crate) struct StoredRow {
    pub row_id: String,
    pub version: i64,
    pub scopes: Scopes,
    pub payload: Vec<u8>,
    pub column_versions: Option<Vec<u8>>,
}

pub(crate) fn decode_payload(columns: &[Column], payload: &[u8]) -> Result<Row, AuthorityError> {
    let mut reader = Reader::new(payload);
    let row = decode_row(&mut reader, columns).map_err(|_| corrupt("row payload"))?;
    if !reader.is_empty() {
        return Err(corrupt("row payload"));
    }
    Ok(row)
}

pub(crate) fn encode_payload(columns: &[Column], row: &Row) -> Vec<u8> {
    let mut writer = Writer::new();
    encode_row(&mut writer, columns, row);
    writer.into_bytes()
}

/// The reference `renderScopeValue`: the string a row id, scope value or
/// reference value renders to; absent for NULL, bytes and the empty string.
pub(crate) fn render(value: &Option<ColumnValue>) -> Option<String> {
    let rendered = match value.as_ref()? {
        ColumnValue::String(s) => s.clone(),
        ColumnValue::Integer(v) => v.to_string(),
        ColumnValue::Boolean(v) => v.to_string(),
        ColumnValue::Json(raw) | ColumnValue::BlobRef(raw) => raw.0.clone(),
        ColumnValue::Float(_) | ColumnValue::Bytes(_) | ColumnValue::Crdt(_) => return None,
    };
    (!rendered.is_empty()).then_some(rendered)
}

/// The stored scopes of a row (§3.1), or `None` when one is missing.
pub(crate) fn scopes_of(table: &Table, values: &Row) -> Option<Scopes> {
    table
        .scopes
        .iter()
        .map(|scope| Some((scope.variable.clone(), render(&values[scope.column])?)))
        .collect()
}

pub(crate) fn encode_column_versions(versions: &BTreeMap<usize, i64>) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut varint = |mut value: u64| {
        while value >= 0x80 {
            bytes.push((value & 0x7f) as u8 | 0x80);
            value >>= 7;
        }
        bytes.push(value as u8);
    };
    for (ordinal, version) in versions {
        if *version <= 1 {
            continue;
        }
        varint(*ordinal as u64);
        varint(*version as u64);
    }
    (!bytes.is_empty()).then_some(bytes)
}

pub(crate) fn decode_column_versions(
    blob: Option<&[u8]>,
) -> Result<BTreeMap<usize, i64>, AuthorityError> {
    let mut versions = BTreeMap::new();
    let Some(blob) = blob else {
        return Ok(versions);
    };
    let mut bytes = blob.iter();
    let mut varint = || -> Result<Option<u64>, AuthorityError> {
        let mut value = 0u64;
        let mut shift = 0;
        let mut first = true;
        loop {
            let Some(byte) = bytes.next() else {
                return if first {
                    Ok(None)
                } else {
                    Err(corrupt("column versions"))
                };
            };
            first = false;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(Some(value));
            }
            shift += 7;
            if shift > 63 {
                return Err(corrupt("column versions"));
            }
        }
    };
    while let Some(ordinal) = varint()? {
        let version = varint()?.ok_or_else(|| corrupt("column versions"))? as i64;
        if version <= 1 {
            return Err(corrupt("column versions"));
        }
        versions.insert(ordinal as usize, version);
    }
    Ok(versions)
}

pub(crate) fn scopes_json(scopes: &Scopes) -> String {
    serde_json::to_string(scopes).expect("a string map serializes")
}

fn sql_value(value: &Option<ColumnValue>) -> SqlValue {
    match value {
        None => SqlValue::Null,
        Some(ColumnValue::String(s)) => SqlValue::Text(s.clone()),
        Some(ColumnValue::Integer(v)) => SqlValue::Integer(*v),
        Some(ColumnValue::Float(v)) => SqlValue::Real(*v),
        Some(ColumnValue::Boolean(v)) => SqlValue::Integer(i64::from(*v)),
        Some(ColumnValue::Json(raw)) | Some(ColumnValue::BlobRef(raw)) => {
            SqlValue::Text(raw.0.clone())
        }
        Some(ColumnValue::Bytes(b)) | Some(ColumnValue::Crdt(b)) => SqlValue::Blob(b.clone()),
    }
}

const ROW_COLUMNS: &str =
    "_sync_row_id, _sync_server_version, _sync_scopes, _sync_payload, _sync_column_versions";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRow> {
    let scopes = serde_json::from_str(row.get_ref(2)?.as_str()?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(StoredRow {
        row_id: row.get(0)?,
        version: row.get(1)?,
        scopes,
        payload: row.get(3)?,
        column_versions: row.get(4)?,
    })
}

pub(crate) fn get_row(
    conn: &Connection,
    table: &str,
    row_id: &str,
) -> Result<Option<StoredRow>, AuthorityError> {
    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM {} WHERE _sync_partition=?1 AND _sync_row_id=?2",
        quote(table)
    );
    conn.prepare_cached(&sql)
        .and_then(|mut statement| {
            statement
                .query_row(params![PARTITION, row_id], read_row)
                .optional()
        })
        .db()
}

/// Write one row and its typed projection. A constraint failure (a declared
/// unique index) surfaces as the SQLite error for the caller to classify.
pub(crate) fn write_row(
    conn: &Connection,
    table: &Table,
    row: &StoredRow,
    values: &Row,
) -> rusqlite::Result<()> {
    let names: Vec<String> = table.columns.iter().map(|c| quote(&c.name)).collect();
    let placeholders: Vec<String> = (0..table.columns.len())
        .map(|i| format!("?{}", i + 7))
        .collect();
    let updates: Vec<String> = names.iter().map(|n| format!("{n}=excluded.{n}")).collect();
    let sql = format!(
        "INSERT INTO {} (_sync_partition, _sync_row_id, _sync_server_version, _sync_scopes, _sync_payload, _sync_column_versions{}{})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6{}{})
         ON CONFLICT(_sync_partition, _sync_row_id) DO UPDATE SET
           _sync_server_version=excluded._sync_server_version, _sync_scopes=excluded._sync_scopes,
           _sync_payload=excluded._sync_payload, _sync_column_versions=excluded._sync_column_versions{}{}",
        quote(&table.name),
        if names.is_empty() { "" } else { ", " },
        names.join(", "),
        if placeholders.is_empty() { "" } else { ", " },
        placeholders.join(", "),
        if updates.is_empty() { "" } else { ", " },
        updates.join(", "),
    );
    let mut bindings: Vec<SqlValue> = vec![
        SqlValue::Text(PARTITION.to_owned()),
        SqlValue::Text(row.row_id.clone()),
        SqlValue::Integer(row.version),
        SqlValue::Text(scopes_json(&row.scopes)),
        SqlValue::Blob(row.payload.clone()),
        row.column_versions
            .clone()
            .map_or(SqlValue::Null, SqlValue::Blob),
    ];
    bindings.extend(values.iter().map(sql_value));
    conn.prepare_cached(&sql)?
        .execute(rusqlite::params_from_iter(bindings))
        .map(|_| ())
}

pub(crate) fn delete_row(
    conn: &Connection,
    table: &str,
    row_id: &str,
) -> Result<(), AuthorityError> {
    let sql = format!(
        "DELETE FROM {} WHERE _sync_partition=?1 AND _sync_row_id=?2",
        quote(table)
    );
    conn.prepare_cached(&sql)
        .and_then(|mut statement| statement.execute(params![PARTITION, row_id]))
        .db()?;
    Ok(())
}

/// Does a stored scope map match the effective scopes (§3.2)?
pub(crate) fn matches_effective(scopes: &Scopes, effective: &[(String, Vec<String>)]) -> bool {
    effective.iter().all(|(variable, values)| {
        scopes
            .get(variable)
            .is_some_and(|value| values.contains(value))
    })
}

/// Up to `limit` rows after `after` in `_sync_row_id` order whose stored
/// scopes match `effective` (the reference `scanRows`).
pub(crate) fn scan_rows(
    conn: &Connection,
    table: &str,
    effective: &[(String, Vec<String>)],
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<StoredRow>, AuthorityError> {
    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM {} WHERE _sync_partition=?1 AND _sync_row_id>?2 ORDER BY _sync_row_id LIMIT ?3",
        quote(table)
    );
    let batch = limit.max(64);
    let mut rows = Vec::new();
    let mut cursor = after.unwrap_or("").to_owned();
    while rows.len() < limit {
        let page: Vec<_> = conn
            .prepare_cached(&sql)
            .and_then(|mut statement| {
                statement
                    .query_map(params![PARTITION, cursor, batch as i64], read_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .db()?;
        let exhausted = page.len() < batch;
        for row in page {
            cursor.clone_from(&row.row_id);
            if matches_effective(&row.scopes, effective) {
                rows.push(row);
                if rows.len() >= limit {
                    break;
                }
            }
        }
        if exhausted {
            break;
        }
    }
    Ok(rows)
}

/// Up to `limit` rows of `child` after `after` whose reference `column`
/// names `parent_row_id`, in `_sync_row_id` order: one page of the §6.11
/// child probe over the declared index.
pub(crate) fn children(
    conn: &Connection,
    child: &Table,
    column: usize,
    parent_row_id: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<StoredRow>, AuthorityError> {
    let key = match child.columns[column].ty {
        ColumnType::Integer => SqlValue::Integer(
            parent_row_id
                .parse()
                .map_err(|_| corrupt("integer row id"))?,
        ),
        ColumnType::Boolean => SqlValue::Integer(i64::from(parent_row_id == "true")),
        _ => SqlValue::Text(parent_row_id.to_owned()),
    };
    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM {} WHERE _sync_partition=?1 AND {}=?2 AND (?3 IS NULL OR _sync_row_id>?3) ORDER BY _sync_row_id LIMIT ?4",
        quote(&child.name),
        quote(&child.columns[column].name)
    );
    conn.prepare_cached(&sql)
        .and_then(|mut statement| {
            statement
                .query_map(params![PARTITION, key, after, limit as i64], read_row)?
                .collect()
        })
        .db()
}

/// Every row of `table` in `_sync_row_id` (binary) order, for the §12.3 plan.
pub(crate) fn all_rows(
    conn: &Connection,
    table: &str,
) -> Result<Vec<(String, Vec<u8>)>, AuthorityError> {
    let sql = format!(
        "SELECT _sync_row_id, _sync_payload FROM {} WHERE _sync_partition=?1 ORDER BY _sync_row_id",
        quote(table)
    );
    conn.prepare(&sql)
        .and_then(|mut statement| {
            statement
                .query_map(params![PARTITION], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .db()
}

/// One change of a commit (§2.2).
#[derive(Debug, Clone)]
pub(crate) struct NewChange {
    pub table: String,
    pub row_id: String,
    pub upsert: bool,
    /// The row's version after the write; a delete's is the version its
    /// tombstone records (§2.2).
    pub row_version: i64,
    pub scopes: Scopes,
    pub payload: Option<Vec<u8>>,
}

pub(crate) struct LogState {
    pub log_epoch: String,
    pub max_seq: i64,
    pub horizon: i64,
    pub delete_floor: i64,
}

pub(crate) fn log_state(conn: &Connection) -> Result<LogState, AuthorityError> {
    conn.query_row(
        "SELECT log_epoch, max_commit_seq, horizon_seq, delete_floor FROM sync_log WHERE id=1",
        [],
        |row| {
            Ok(LogState {
                log_epoch: row.get(0)?,
                max_seq: row.get(1)?,
                horizon: row.get(2)?,
                delete_floor: row.get(3)?,
            })
        },
    )
    .db()
}

/// Append an applied commit and its changes; every delete the same commit
/// does not follow with an upsert of the row leaves a tombstone and raises
/// the delete floor to its version (§2.2).
pub(crate) fn append_commit(
    conn: &Connection,
    client_id: &str,
    client_commit_id: &str,
    created_at_ms: i64,
    changes: &[NewChange],
) -> Result<i64, AuthorityError> {
    let commit_seq = log_state(conn)?.max_seq + 1;
    // The reference `rowsLiveAfterDelete`.
    let key = |change: &NewChange| (change.table.clone(), change.row_id.clone());
    let mut deleted = std::collections::HashSet::new();
    let mut live = std::collections::HashSet::new();
    let mut last = std::collections::HashMap::new();
    for change in changes {
        if !change.upsert {
            deleted.insert(key(change));
        } else if deleted.contains(&key(change)) {
            live.insert(key(change));
        }
        last.insert(key(change), change.upsert);
    }
    live.retain(|k| last.get(k) == Some(&true));
    let leaves_tombstone = |change: &&NewChange| !change.upsert && !live.contains(&key(change));
    let floor = changes
        .iter()
        .filter(leaves_tombstone)
        .map(|change| change.row_version)
        .max()
        .unwrap_or(0);
    conn.execute(
        "UPDATE sync_log SET max_commit_seq=?1, delete_floor=max(delete_floor, ?2) WHERE id=1",
        [commit_seq, floor],
    )
    .db()?;
    // §12.2: every request authenticates as actor `local`.
    conn.execute(
        "INSERT INTO sync_commits(commit_seq, client_id, client_commit_id, actor_id, created_at_ms) VALUES (?1,?2,?3,'local',?4)",
        params![commit_seq, client_id, client_commit_id, created_at_ms],
    )
    .db()?;
    for (idx, change) in changes.iter().enumerate() {
        conn.prepare_cached(
            "INSERT INTO sync_changes(commit_seq, idx, tbl, row_id, op, row_version, scopes, payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .and_then(|mut statement| {
            statement.execute(params![
                commit_seq,
                idx as i64,
                change.table,
                change.row_id,
                if change.upsert { 1 } else { 2 },
                change.row_version,
                scopes_json(&change.scopes),
                change.payload,
            ])
        })
        .db()?;
        if leaves_tombstone(&change) {
            conn.prepare_cached(
                "INSERT INTO sync_tombstones(tbl, row_id, commit_seq, server_version, scopes) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(tbl, row_id) DO UPDATE SET commit_seq=excluded.commit_seq,
                   server_version=excluded.server_version, scopes=excluded.scopes",
            )
            .and_then(|mut statement| {
                statement.execute(params![
                    change.table,
                    change.row_id,
                    commit_seq,
                    change.row_version,
                    scopes_json(&change.scopes),
                ])
            })
            .db()?;
        }
    }
    Ok(commit_seq)
}

/// Does the row hold a tombstone within the horizon (§2.2)? Every scope
/// value is granted, so its stored scopes never hide it.
pub(crate) fn tombstoned(
    conn: &Connection,
    table: &str,
    row_id: &str,
) -> Result<bool, AuthorityError> {
    conn.prepare_cached("SELECT 1 FROM sync_tombstones WHERE tbl=?1 AND row_id=?2")
        .and_then(|mut statement| statement.exists(params![table, row_id]))
        .db()
}

pub(crate) fn clear_tombstone(
    conn: &Connection,
    table: &str,
    row_id: &str,
) -> Result<(), AuthorityError> {
    conn.prepare_cached("DELETE FROM sync_tombstones WHERE tbl=?1 AND row_id=?2")
        .and_then(|mut statement| statement.execute(params![table, row_id]))
        .db()?;
    Ok(())
}

pub(crate) fn push_result(
    conn: &Connection,
    client_id: &str,
    client_commit_id: &str,
) -> Result<Option<String>, AuthorityError> {
    conn.prepare_cached(
        "SELECT result FROM sync_push_results WHERE client_id=?1 AND client_commit_id=?2",
    )
    .and_then(|mut statement| {
        statement
            .query_row(params![client_id, client_commit_id], |row| row.get(0))
            .optional()
    })
    .db()
}

/// Persist a result; `sequence` is its outbox and `clientSeq` (§6.3.2).
pub(crate) fn put_push_result(
    conn: &Connection,
    client_id: &str,
    client_commit_id: &str,
    result: &str,
    sequence: Option<(&str, i64)>,
) -> Result<(), AuthorityError> {
    conn.prepare_cached("INSERT OR IGNORE INTO sync_push_results(client_id, client_commit_id, result, outbox_id, client_seq) VALUES (?1,?2,?3,?4,?5)")
        .and_then(|mut statement| {
            statement.execute(params![
                client_id,
                client_commit_id,
                result,
                sequence.map(|(outbox_id, _)| outbox_id),
                sequence.map(|(_, client_seq)| client_seq),
            ])
        })
        .db()?;
    Ok(())
}

/// The §9 settlement and §6.3.2 steps 1 and 2 for a request whose commits
/// are `commits` (`clientCommitId`, `clientSeq`), in frame order; returns the
/// watermark `W`.
pub(crate) fn settle_outbox(
    conn: &Connection,
    client_id: &str,
    outbox_id: &str,
    commits: &[(&str, i64)],
) -> Result<i64, AuthorityError> {
    let (Some((_, first)), Some((last, _))) = (commits.first(), commits.last()) else {
        return Err(corrupt("outbox settlement without commits"));
    };
    let stored: Option<i64> = conn
        .query_row(
            "SELECT through_seq FROM sync_push_watermarks WHERE client_id=?1 AND outbox_id=?2",
            params![client_id, outbox_id],
            |row| row.get(0),
        )
        .optional()
        .db()?;
    let watermark = stored.unwrap_or(0).max(*first);
    let ids = Value::from(commits.iter().map(|(id, _)| *id).collect::<Vec<_>>()).to_string();
    // §9 (b), then (a): with no pre-upgrade result on the request's last
    // commit, every remaining one outside the request left the outbox.
    let last_sequenceless = conn
        .prepare("SELECT 1 FROM sync_push_results WHERE client_id=?1 AND client_commit_id=?2 AND outbox_id IS NULL")
        .and_then(|mut statement| statement.exists(params![client_id, last]))
        .db()?;
    if !last_sequenceless {
        conn.execute(
            "DELETE FROM sync_push_results WHERE client_id=?1 AND outbox_id IS NULL
               AND client_commit_id NOT IN (SELECT value FROM json_each(?2))",
            params![client_id, ids],
        )
        .db()?;
    }
    for (client_commit_id, client_seq) in commits {
        conn.execute(
            "UPDATE sync_push_results SET outbox_id=?3, client_seq=?4
              WHERE client_id=?1 AND client_commit_id=?2 AND outbox_id IS NULL",
            params![client_id, client_commit_id, outbox_id, client_seq],
        )
        .db()?;
    }
    conn.execute(
        "INSERT INTO sync_push_watermarks(client_id, outbox_id, through_seq) VALUES (?1,?2,?3)
         ON CONFLICT(client_id, outbox_id) DO UPDATE SET through_seq=max(through_seq, excluded.through_seq)",
        params![client_id, outbox_id, watermark],
    )
    .db()?;
    conn.execute(
        "DELETE FROM sync_push_results WHERE client_id=?1 AND outbox_id=?2 AND client_seq<?3",
        params![client_id, outbox_id, watermark],
    )
    .db()?;
    Ok(watermark)
}

/// One commit of a live section, with only its matching changes.
pub(crate) struct LiveCommit {
    pub commit_seq: i64,
    pub created_at_ms: i64,
    pub actor_id: String,
    pub changes: Vec<NewChange>,
}

/// The §4.5 live section from one scan of the log: commits in
/// `(min bound, through]` with the changes `matches` admits (given the commit
/// sequence), oldest first, stopping after the commit that reaches
/// `limit_changes` matching changes. Returns the commits and `T`.
pub(crate) fn live_window(
    conn: &Connection,
    after: i64,
    through: i64,
    limit_changes: usize,
    matches: impl Fn(i64, &str, &Scopes) -> bool,
) -> Result<(Vec<LiveCommit>, i64), AuthorityError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT ch.commit_seq, c.created_at_ms, c.actor_id, ch.tbl, ch.row_id, ch.op, ch.row_version, ch.scopes, ch.payload
               FROM sync_changes ch JOIN sync_commits c ON c.commit_seq = ch.commit_seq
              WHERE ch.commit_seq>?1 AND ch.commit_seq<=?2
              ORDER BY ch.commit_seq, ch.idx",
        )
        .db()?;
    let mut rows = statement.query(params![after, through]).db()?;
    let mut commits: Vec<LiveCommit> = Vec::new();
    let mut delivered = 0;
    while let Some(row) = rows.next().db()? {
        let seq: i64 = row.get(0).db()?;
        if commits.last().is_none_or(|commit| commit.commit_seq != seq) {
            if delivered >= limit_changes {
                let cut = commits.last().map_or(through, |commit| commit.commit_seq);
                return Ok((commits, cut));
            }
            if commits
                .last()
                .is_some_and(|commit| commit.changes.is_empty())
            {
                commits.pop();
            }
            commits.push(LiveCommit {
                commit_seq: seq,
                created_at_ms: row.get(1).db()?,
                actor_id: row.get(2).db()?,
                changes: Vec::new(),
            });
        }
        let table: String = row.get(3).db()?;
        let scopes: Scopes = serde_json::from_str(&row.get::<_, String>(7).db()?)
            .map_err(|_| corrupt("stored scopes"))?;
        if !matches(seq, &table, &scopes) {
            continue;
        }
        // §4.5: apply is version-guarded, so a change logged without a
        // version (a delete from before wire version 4) cannot be served.
        let row_version: Option<i64> = row.get(6).db()?;
        let commit = commits.last_mut().expect("pushed above");
        commit.changes.push(NewChange {
            table,
            row_id: row.get(4).db()?,
            upsert: row.get::<_, i64>(5).db()? == 1,
            row_version: row_version.ok_or_else(|| corrupt("change row version"))?,
            scopes,
            payload: row.get(8).db()?,
        });
        delivered += 1;
    }
    if commits
        .last()
        .is_some_and(|commit| commit.changes.is_empty())
    {
        commits.pop();
    }
    let cut = if delivered >= limit_changes {
        commits.last().map_or(through, |commit| commit.commit_seq)
    } else {
        through
    };
    Ok((commits, cut))
}

/// The client record (§4.5): the stored registration list when its digest
/// is `digest`.
pub(crate) fn client_registration(
    conn: &Connection,
    client_id: &str,
    digest: &[u8; 32],
) -> Result<Option<Vec<UnitScopes>>, AuthorityError> {
    let units: Option<String> = conn
        .prepare_cached(
            "SELECT units FROM sync_clients WHERE client_id=?1 AND registration_digest=?2",
        )
        .and_then(|mut statement| {
            statement
                .query_row(params![client_id, digest.as_slice()], |row| row.get(0))
                .optional()
        })
        .db()?;
    units
        .map(|units| {
            let units: Vec<BTreeMap<String, String>> =
                serde_json::from_str(&units).map_err(|_| corrupt("registration list"))?;
            Ok(units
                .into_iter()
                .map(|unit| unit.into_iter().collect())
                .collect())
        })
        .transpose()
}

/// §4.5: a completed round stores the record cursor, the catching-up units
/// and, when the list traveled, the registration list and its digest; it
/// clears the failure streak unless the round carried a `ROUND_FAILURE`
/// report (`keep_outcome`). `None` keeps the stored cursor and states (a
/// push-only round).
pub(crate) fn put_client(
    conn: &Connection,
    client_id: &str,
    round: Option<(i64, &[(String, i64)])>,
    registration: Option<(&[UnitScopes], &[u8; 32])>,
    now: i64,
    keep_outcome: bool,
) -> Result<(), AuthorityError> {
    let catching_up = round.map(|(_, units)| {
        Value::from(
            units
                .iter()
                .map(|(id, cursor)| json!({ "id": id, "cursor": cursor }))
                .collect::<Vec<_>>(),
        )
        .to_string()
    });
    let units = registration.map(|(units, _)| {
        Value::from(
            units
                .iter()
                .map(|unit| {
                    Value::from(
                        unit.iter()
                            .map(|(key, value)| (key.clone(), Value::from(value.as_str())))
                            .collect::<serde_json::Map<_, _>>(),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .to_string()
    });
    let sql = format!(
        "INSERT INTO sync_clients(client_id, cursor, updated_at_ms, last_round_at_ms, units, registration_digest, catching_up)
         VALUES (?1, coalesce(?2, -1), ?3, ?3, ?4, ?5, coalesce(?6, '[]'))
         ON CONFLICT(client_id) DO UPDATE SET cursor=coalesce(?2, cursor), updated_at_ms=?3,
           last_round_at_ms=?3, catching_up=coalesce(?6, catching_up){}{}",
        if registration.is_some() {
            ", units=?4, registration_digest=?5"
        } else {
            ""
        },
        if keep_outcome {
            ""
        } else {
            ", last_error_code=NULL, consecutive_failures=0"
        },
    );
    conn.execute(
        &sql,
        params![
            client_id,
            round.map(|(cursor, _)| cursor),
            now,
            units,
            registration.map(|(_, digest)| digest.as_slice()),
            catching_up,
        ],
    )
    .db()?;
    Ok(())
}

/// §4.5: a round answered `unregistered` writes only its outcome on the
/// existing record.
pub(crate) fn record_round(
    conn: &Connection,
    client_id: &str,
    now: i64,
    keep_outcome: bool,
) -> Result<(), AuthorityError> {
    conn.execute(
        if keep_outcome {
            "UPDATE sync_clients SET last_round_at_ms=?1 WHERE client_id=?2"
        } else {
            "UPDATE sync_clients SET last_round_at_ms=?1, last_error_code=NULL, consecutive_failures=0 WHERE client_id=?2"
        },
        params![now, client_id],
    )
    .db()?;
    Ok(())
}

/// §4.5: a failed round sets the code and time on the existing record and
/// extends the streak; it never creates a record and leaves the cursor and
/// the retention timestamp alone.
pub(crate) fn record_round_failure(
    conn: &Connection,
    client_id: &str,
    code: &str,
    now: i64,
) -> Result<(), AuthorityError> {
    conn.prepare_cached(
        "UPDATE sync_clients SET last_round_at_ms=?1, last_error_code=?2,
           consecutive_failures=consecutive_failures+1 WHERE client_id=?3",
    )
    .and_then(|mut statement| statement.execute(params![now, code, client_id]))
    .db()?;
    Ok(())
}

/// The reference `pruneCommitLog`: the horizon never passes the lowest
/// record cursor (`-1` holds nothing) a client touched within the active
/// window, except past commits
/// older than the age-force limit, and the newest `min_retained_commits`
/// always stay. Tombstones prune with the log.
pub(crate) fn prune(
    conn: &Connection,
    now: i64,
    retention: &Retention,
) -> Result<i64, AuthorityError> {
    let state = log_state(conn)?;
    let cursor_floor: Option<i64> = conn
        .query_row(
            "SELECT MIN(cursor) FROM sync_clients WHERE updated_at_ms>=?1 AND cursor>=0",
            [now - retention.active_window_ms],
            |row| row.get(0),
        )
        .db()?;
    let forced: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(commit_seq), 0) FROM sync_commits WHERE created_at_ms<?1",
            [now - retention.age_force_ms],
            |row| row.get(0),
        )
        .db()?;
    let target = cursor_floor
        .unwrap_or(i64::MAX)
        .max(forced)
        .min(state.max_seq - retention.min_retained_commits);
    let horizon = state.horizon.max(target.max(0));
    transaction(conn, || {
        conn.execute("UPDATE sync_log SET horizon_seq=?1 WHERE id=1", [horizon])
            .db()?;
        for table in ["sync_commits", "sync_changes", "sync_tombstones"] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE commit_seq<=?1"),
                [horizon],
            )
            .db()?;
        }
        Ok(())
    })?;
    Ok(horizon)
}

/// Run `work` in one `BEGIN IMMEDIATE` transaction.
pub(crate) fn transaction<T>(
    conn: &Connection,
    work: impl FnOnce() -> Result<T, AuthorityError>,
) -> Result<T, AuthorityError> {
    conn.execute_batch("BEGIN IMMEDIATE").db()?;
    match work() {
        Ok(value) => {
            conn.execute_batch("COMMIT").db()?;
            Ok(value)
        }
        Err(error) => {
            // A failed rollback leaves nothing more to undo; the work's error wins.
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn mismatch(table: &str, reason: &str) -> AuthorityError {
    AuthorityError::with_details(
        "sync.schema_mismatch",
        "the schema changes the authority tables beyond appended tables and nullable columns",
        json!({ "table": table, "reason": reason }),
    )
}

fn column_ddl_type(column: &Column) -> &'static str {
    match column.ty {
        ColumnType::String | ColumnType::Json | ColumnType::BlobRef => "TEXT",
        ColumnType::Integer | ColumnType::Boolean => "INTEGER",
        ColumnType::Float => "REAL",
        ColumnType::Bytes | ColumnType::Crdt => "BLOB",
    }
}

/// §12.2: bring the authority tables to `schema` before serving. A version
/// already stored must carry the same layouts; a newer schema may add tables,
/// append nullable columns and change scope patterns, which re-keys the
/// table's rows (§3.1), and every other change is refused.
pub(crate) fn migrate(conn: &Connection, schema: &Schema) -> Result<(), AuthorityError> {
    transaction(conn, || {
        conn.execute_batch(INTERNAL_DDL).db()?;
        // Columns added after the internal tables' first release: a tombstone
        // from before recorded versions carries neither its version nor its
        // scopes (§2.2), a client record from before wire version 4 holds no
        // registration list and a push result from before it no outbox
        // sequence (§9).
        for (table, column, definition) in [
            ("sync_tombstones", "server_version", "INTEGER"),
            ("sync_tombstones", "scopes", "TEXT"),
            ("sync_log", "delete_floor", "INTEGER NOT NULL DEFAULT 0"),
            ("sync_push_results", "outbox_id", "TEXT"),
            ("sync_push_results", "client_seq", "INTEGER"),
            ("sync_clients", "units", "TEXT"),
            ("sync_clients", "registration_digest", "BLOB"),
            ("sync_clients", "catching_up", "TEXT NOT NULL DEFAULT '[]'"),
        ] {
            let present = conn
                .prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name=?2")
                .and_then(|mut statement| statement.exists([table, column]))
                .db()?;
            if present {
                continue;
            }
            conn.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .db()?;
            // A store from before wire version 4 (and the delete floor)
            // starts the delete floor at the highest version its tombstones
            // recorded (§2.2) and the horizon at its last commit (§9).
            if column == "delete_floor" {
                conn.execute_batch(
                    "UPDATE sync_log SET horizon_seq=max_commit_seq, delete_floor=coalesce((SELECT max(server_version) FROM sync_tombstones), 0)",
                )
                .db()?;
            }
        }
        // Wire version 4 scans the log by commit, never by table (§4.5).
        conn.execute_batch("DROP INDEX IF EXISTS sync_changes_by_table")
            .db()?;
        let layouts: serde_json::Map<String, Value> = schema
            .tables
            .iter()
            .map(|table| (table.name.clone(), table.layout()))
            .collect();
        let stored: Option<(i64, String)> = conn
            .query_row(
                "SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .db()?;
        let stored_layouts = match &stored {
            Some((_, text)) => serde_json::from_str::<serde_json::Map<String, Value>>(text)
                .map_err(|_| corrupt("schema layouts"))?,
            None => serde_json::Map::new(),
        };
        match stored {
            Some((version, _)) if version > i64::from(schema.version) => {
                return Err(AuthorityError::with_details(
                    "sync.schema_not_ready",
                    "the authority database was migrated by a newer schema",
                    json!({ "storedSchemaVersion": version, "schemaVersion": schema.version }),
                ));
            }
            Some((version, _)) if version == i64::from(schema.version) => {
                if stored_layouts != layouts {
                    return Err(mismatch("", "layout_changed_without_version_bump"));
                }
            }
            _ => upgrade(conn, schema, &stored_layouts)?,
        }
        conn.execute(
            "INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, layouts=excluded.layouts",
            params![schema.version, Value::Object(layouts).to_string()],
        )
        .db()?;
        conn.execute(
            "INSERT OR IGNORE INTO sync_log(id, log_epoch, max_commit_seq, horizon_seq) VALUES (1, ?1, 0, 0)",
            [uuid::Uuid::new_v4().to_string()],
        )
        .db()?;
        Ok(())
    })
}

fn upgrade(
    conn: &Connection,
    schema: &Schema,
    stored: &serde_json::Map<String, Value>,
) -> Result<(), AuthorityError> {
    for name in stored.keys() {
        if schema.table(name).is_none() {
            return Err(mismatch(name, "table_removed"));
        }
    }
    for table in &schema.tables {
        let Some(old) = stored.get(&table.name) else {
            let columns: Vec<String> = table
                .columns
                .iter()
                .map(|column| {
                    format!(
                        "{} {}{}",
                        quote(&column.name),
                        column_ddl_type(column),
                        if column.nullable { "" } else { " NOT NULL" }
                    )
                })
                .collect();
            conn.execute_batch(&format!(
                "CREATE TABLE {} (_sync_partition TEXT NOT NULL, _sync_row_id TEXT NOT NULL, {}{}_sync_server_version INTEGER NOT NULL, _sync_scopes TEXT NOT NULL, _sync_payload BLOB NOT NULL, _sync_column_versions BLOB, PRIMARY KEY (_sync_partition, _sync_row_id))",
                quote(&table.name),
                columns.join(", "),
                if columns.is_empty() { "" } else { ", " },
            ))
            .db()?;
            create_indexes(conn, table)?;
            continue;
        };
        let new = table.layout();
        if old["primaryKey"] != new["primaryKey"] {
            return Err(mismatch(&table.name, "primary_key_changed"));
        }
        // The stored `Table::layout` columns: `[name, type, nullable]`.
        let old_columns: Vec<Column> = old["columns"]
            .as_array()
            .and_then(|columns| {
                columns
                    .iter()
                    .map(|column| {
                        Some(Column {
                            name: column[0].as_str()?.to_owned(),
                            ty: ColumnType::from_name(column[1].as_str()?)?,
                            nullable: column[2].as_bool()?,
                        })
                    })
                    .collect()
            })
            .ok_or_else(|| corrupt("schema layouts"))?;
        if old_columns.len() > table.columns.len()
            || old_columns.iter().zip(&table.columns).any(|(a, b)| a != b)
        {
            return Err(mismatch(&table.name, "column_changed"));
        }
        let appended = &table.columns[old_columns.len()..];
        if appended.iter().any(|column| !column.nullable) {
            return Err(mismatch(&table.name, "appended_column_not_nullable"));
        }
        for column in appended {
            conn.execute_batch(&format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                quote(&table.name),
                quote(&column.name),
                column_ddl_type(column)
            ))
            .db()?;
        }
        if !appended.is_empty() {
            reencode(conn, table, &old_columns)?;
        }
        if old["scopes"] != new["scopes"] {
            rekey(conn, table)?;
        }
        create_indexes(conn, table)?;
    }
    Ok(())
}

/// §3.1: recompute every row's stored scopes under the table's patterns. A
/// deleted row's scopes cannot be recomputed, so its tombstone goes, and the
/// horizon passes the changes logged under the previous patterns (§4.6).
fn rekey(conn: &Connection, table: &Table) -> Result<(), AuthorityError> {
    let sql = format!(
        "UPDATE {} SET _sync_scopes=?1 WHERE _sync_partition=?2 AND _sync_row_id=?3",
        quote(&table.name)
    );
    for (row_id, payload) in all_rows(conn, &table.name)? {
        let values = decode_payload(&table.columns, &payload)?;
        let Some(scopes) = scopes_of(table, &values) else {
            let variable = table
                .scopes
                .iter()
                .find(|scope| render(&values[scope.column]).is_none())
                .map(|scope| scope.variable.as_str());
            return Err(AuthorityError::with_details(
                "sync.schema_mismatch",
                "a stored row has no value for a scope column the schema bump re-keys it under",
                json!({
                    "table": table.name,
                    "reason": "scope_value_missing",
                    "variable": variable,
                    "rowId": row_id,
                }),
            ));
        };
        conn.execute(&sql, params![scopes_json(&scopes), PARTITION, row_id])
            .db()?;
    }
    conn.execute("DELETE FROM sync_tombstones WHERE tbl=?1", [&table.name])
        .db()?;
    conn.execute_batch(
        "UPDATE sync_log SET horizon_seq=max_commit_seq WHERE horizon_seq<max_commit_seq",
    )
    .db()?;
    Ok(())
}

/// Re-encode the stored payloads of `table` (rows and logged changes) from
/// `old` to the table's columns: appended slots are NULL.
fn reencode(conn: &Connection, table: &Table, old: &[Column]) -> Result<(), AuthorityError> {
    let widen = |payload: &[u8]| -> Result<Vec<u8>, AuthorityError> {
        let mut row = decode_payload(old, payload)?;
        row.resize(table.columns.len(), None);
        Ok(encode_payload(&table.columns, &row))
    };
    let rows = all_rows(conn, &table.name)?;
    let sql = format!(
        "UPDATE {} SET _sync_payload=?1 WHERE _sync_partition=?2 AND _sync_row_id=?3",
        quote(&table.name)
    );
    for (row_id, payload) in rows {
        conn.execute(&sql, params![widen(&payload)?, PARTITION, row_id])
            .db()?;
    }
    let changes: Vec<(i64, i64, Vec<u8>)> = conn
        .prepare("SELECT commit_seq, idx, payload FROM sync_changes WHERE tbl=?1 AND payload IS NOT NULL")
        .and_then(|mut statement| {
            statement
                .query_map([&table.name], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect()
        })
        .db()?;
    for (seq, idx, payload) in changes {
        conn.execute(
            "UPDATE sync_changes SET payload=?1 WHERE commit_seq=?2 AND idx=?3",
            params![widen(&payload)?, seq, idx],
        )
        .db()?;
    }
    Ok(())
}

/// Replace the table's `sync_ix_*` indexes with the declared ones.
fn create_indexes(conn: &Connection, table: &Table) -> Result<(), AuthorityError> {
    let existing: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?1 AND substr(name, 1, 8)='sync_ix_'")
        .and_then(|mut statement| statement.query_map([&table.name], |row| row.get(0))?.collect())
        .db()?;
    for name in existing {
        conn.execute_batch(&format!("DROP INDEX {}", quote(&name)))
            .db()?;
    }
    for index in &table.indexes {
        let columns: Vec<String> = std::iter::once("_sync_partition".to_owned())
            .chain(index.columns.iter().map(|c| quote(c)))
            .collect();
        conn.execute_batch(&format!(
            "CREATE {}INDEX {} ON {} ({})",
            if index.unique { "UNIQUE " } else { "" },
            quote(&format!("sync_ix_{}", index.name)),
            quote(&table.name),
            columns.join(", ")
        ))
        .db()?;
    }
    Ok(())
}
