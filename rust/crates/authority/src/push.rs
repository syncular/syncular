//! §6 push apply over the §12.2 profile, following the reference
//! `processPushCommitWithTrace`: idempotency replay (§2.3), sequential
//! atomic apply (§6.4), the §6.2 conflict and tombstone rules, §6.11
//! declared references, unique indexes, and §5.10.3 CRDT merges. Every scope
//! value is granted, so authorization reduces to every declared scope column
//! carrying a value.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ssp2::model::{Frame, Op, OpResult, Operation, PushResultDetail, PushStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_sparse_row, ColumnValue, Row, SparseSlot};

use crate::crdt::{merge, MergeError};
use crate::schema::{OnDelete, Schema, Table};
use crate::store::{self, NewChange, Scopes, StoredRow};
use crate::{storage_error, AuthorityError, Db};

/// One persisted operation result (§6.3, §6.3.1 details).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum StoredOp {
    #[serde(rename_all = "camelCase")]
    Applied { op_index: i32 },
    #[serde(rename_all = "camelCase")]
    Conflict {
        op_index: i32,
        code: String,
        message: String,
        server_version: i64,
        server_row: Vec<u8>,
        conflict_columns: Vec<u8>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        op_index: i32,
        code: String,
        message: String,
        retryable: bool,
        details: Option<String>,
    },
}

/// The §2.3 idempotency record.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredResult {
    applied: bool,
    commit_seq: Option<i64>,
    results: Vec<StoredOp>,
}

impl StoredResult {
    /// `PUSH_RESULT` (applied ⇒ `cached` on replay) plus the §6.3.1
    /// companion when a rejection carries details.
    fn frames(&self, client_commit_id: &str, replay: bool) -> Vec<Frame> {
        let status = match (self.applied, replay) {
            (true, false) => PushStatus::Applied,
            (true, true) => PushStatus::Cached,
            (false, _) => PushStatus::Rejected,
        };
        let mut details = Vec::new();
        let results = self
            .results
            .iter()
            .map(|result| match result.clone() {
                StoredOp::Applied { op_index } => OpResult::Applied { op_index },
                StoredOp::Conflict {
                    op_index,
                    code,
                    message,
                    server_version,
                    server_row,
                    conflict_columns,
                } => OpResult::Conflict {
                    op_index,
                    code,
                    message,
                    server_version,
                    server_row,
                    conflict_columns,
                },
                StoredOp::Error {
                    op_index,
                    code,
                    message,
                    retryable,
                    details: entry,
                } => {
                    if let Some(entry) = entry {
                        details.push(PushResultDetail {
                            op_index,
                            details: RawJson(entry),
                        });
                    }
                    OpResult::Error {
                        op_index,
                        code,
                        message,
                        retryable,
                    }
                }
            })
            .collect();
        let mut frames = vec![Frame::PushResult {
            client_commit_id: client_commit_id.to_owned(),
            status,
            commit_seq: self.commit_seq,
            results,
        }];
        if !details.is_empty() {
            frames.push(Frame::PushResultDetails {
                client_commit_id: client_commit_id.to_owned(),
                entries: details,
            });
        }
        frames
    }
}

enum Fail {
    /// The terminating operation record of a rejected commit (§6.3).
    Terminate(StoredOp),
    Storage(AuthorityError),
}

impl From<AuthorityError> for Fail {
    fn from(error: AuthorityError) -> Self {
        Fail::Storage(error)
    }
}

fn error(op_index: i32, code: &str, message: &str) -> Fail {
    Fail::Terminate(StoredOp::Error {
        op_index,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
        details: None,
    })
}

fn reference_error(op_index: i32, message: &str, details: serde_json::Value) -> Fail {
    Fail::Terminate(StoredOp::Error {
        op_index,
        code: "sync.reference_violation".to_owned(),
        message: message.to_owned(),
        retryable: false,
        details: Some(details.to_string()),
    })
}

/// Write a row; a SQLite constraint failure (a unique index) rejects the
/// commit with `sync.constraint_violation` at `op_index`.
fn write(
    conn: &Connection,
    table: &Table,
    row: &StoredRow,
    values: &Row,
    op_index: i32,
) -> Result<(), Fail> {
    store::write_row(conn, table, row, values).map_err(|e| {
        if e.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            error(
                op_index,
                "sync.constraint_violation",
                "write violates a relational constraint",
            )
        } else {
            Fail::Storage(storage_error(e))
        }
    })
}

/// §3.4 with every value granted: every declared scope variable is present.
fn authorized(table: &Table, scopes: &Scopes) -> bool {
    table
        .scopes
        .iter()
        .all(|scope| scopes.get(&scope.variable).is_some_and(|v| !v.is_empty()))
}

/// The stored scopes of a row (§3.1), or `None` when one is missing.
fn scopes_of(table: &Table, values: &Row) -> Option<Scopes> {
    table
        .scopes
        .iter()
        .map(|scope| {
            Some((
                scope.variable.clone(),
                store::render(&values[scope.column])?,
            ))
        })
        .collect()
}

/// §5.10.3: replace each present non-NULL crdt value with
/// `merge(stored, incoming)`.
fn merge_crdt(
    table: &Table,
    values: &mut Row,
    stored: Option<&Row>,
    present: &[bool],
    op_index: i32,
) -> Result<(), Fail> {
    for (index, crdt_type) in &table.crdt {
        if !present[*index] {
            continue;
        }
        let Some(ColumnValue::Crdt(incoming)) = &values[*index] else {
            continue;
        };
        let stored_bytes = match stored.map(|row| &row[*index]) {
            Some(Some(ColumnValue::Crdt(bytes))) => Some(bytes.as_slice()),
            _ => None,
        };
        let merged = merge(crdt_type, stored_bytes, incoming).map_err(|failure| match failure {
            MergeError::Unregistered => error(
                op_index,
                "sync.crdt_merge_failed",
                "no CRDT merger registered",
            ),
            MergeError::Failed => error(op_index, "sync.crdt_merge_failed", "CRDT merger failed"),
        })?;
        values[*index] = Some(ColumnValue::Crdt(merged));
    }
    Ok(())
}

/// §5.9.6: the authority has no blob store, so any referenced blob is absent.
fn check_blobs(table: &Table, values: &Row, op_index: i32) -> Result<(), Fail> {
    if table.blob_refs.iter().any(|index| values[*index].is_some()) {
        return Err(error(
            op_index,
            "blob.not_found",
            "row references a blob but the server has no blob store (§5.9.6)",
        ));
    }
    Ok(())
}

/// The final state of one client operation, as the §6.11 pass sees it.
struct Staged {
    table: String,
    row_id: String,
    op_index: i32,
    /// Final values of an upsert; `None` for a delete.
    values: Option<Row>,
    /// A stored row existed immediately before the write.
    existed: bool,
}

fn apply_operation(
    conn: &Connection,
    schema: &Schema,
    op: &Operation,
    op_index: i32,
) -> Result<(Vec<NewChange>, Staged), Fail> {
    let Some(table) = schema.table(&op.table) else {
        return Err(error(
            op_index,
            "sync.unknown_table",
            "the table is not handled by this server",
        ));
    };
    let stored = store::get_row(conn, &table.name, &op.row_id)?;
    let staged = |values: Option<Row>, existed: bool| Staged {
        table: table.name.clone(),
        row_id: op.row_id.clone(),
        op_index,
        values,
        existed,
    };
    if op.op == Op::Delete {
        // Deleting an absent row is applied with no change (§6.2).
        let Some(stored) = stored else {
            return Ok((Vec::new(), staged(None, false)));
        };
        if !authorized(table, &stored.scopes) {
            return Err(error(
                op_index,
                "sync.forbidden",
                "delete denied by scope authorization (§3.4)",
            ));
        }
        store::delete_row(conn, &table.name, &op.row_id)?;
        let change = NewChange {
            table: table.name.clone(),
            row_id: op.row_id.clone(),
            upsert: false,
            row_version: None,
            scopes: stored.scopes,
            payload: None,
        };
        return Ok((vec![change], staged(None, true)));
    }
    let Some(payload) = &op.payload else {
        return Err(error(
            op_index,
            "sync.invalid_request",
            "upsert without payload",
        ));
    };
    let Ok(sparse) = decode_sparse_row(&table.columns, table.pk, payload) else {
        return Err(error(
            op_index,
            "sync.invalid_request",
            "row payload failed row-codec decode (§1.7)",
        ));
    };
    let present: Vec<bool> = sparse
        .iter()
        .map(|slot| !matches!(slot, SparseSlot::Absent))
        .collect();
    let mut values: Row = sparse
        .into_iter()
        .map(|slot| match slot {
            SparseSlot::Value(value) => Some(value),
            SparseSlot::Absent | SparseSlot::Null => None,
        })
        .collect();
    if store::render(&values[table.pk]).as_deref() != Some(op.row_id.as_str()) {
        return Err(error(
            op_index,
            "sync.invalid_request",
            "payload primary key does not match rowId",
        ));
    }
    let crdt_columns: HashSet<usize> = table.crdt.iter().map(|(index, _)| *index).collect();

    if let Some(stored) = stored {
        if !authorized(table, &stored.scopes) {
            return Err(error(
                op_index,
                "sync.forbidden",
                "write denied by scope authorization (§3.4)",
            ));
        }
        let stored_values = store::decode_payload(&table.columns, &stored.payload)?;
        if table.scopes.iter().any(|scope| {
            present[scope.column] && values[scope.column] != stored_values[scope.column]
        }) {
            return Err(error(
                op_index,
                "sync.invalid_request",
                "scope column is immutable on update (§3.4)",
            ));
        }
        if op.base_version.is_some_and(|base| base > stored.version) {
            return Err(error(
                op_index,
                "sync.invalid_request",
                "baseVersion exceeds the stored server version (§6.2)",
            ));
        }
        // §2.2: a row stored without column versions has every column at
        // its server version; with them, an unlisted column sits at 1.
        let versions = store::decode_column_versions(stored.column_versions.as_deref())?;
        let column_version = |index: usize| {
            versions
                .get(&index)
                .copied()
                .unwrap_or(if stored.column_versions.is_none() {
                    stored.version
                } else {
                    1
                })
        };
        let comparable =
            |index: usize| present[index] && !crdt_columns.contains(&index) && index != table.pk;
        if let Some(base) = op.base_version {
            let marked: Vec<usize> = (0..table.columns.len())
                .filter(|index| comparable(*index) && (base == 0 || column_version(*index) > base))
                .collect();
            if base == 0 || !marked.is_empty() {
                let mut conflict_columns = vec![0u8; table.columns.len().div_ceil(8)];
                for index in marked {
                    conflict_columns[index / 8] |= 1 << (index % 8);
                }
                return Err(Fail::Terminate(StoredOp::Conflict {
                    op_index,
                    code: "sync.version_conflict".to_owned(),
                    message: "present columns moved past baseVersion (§6.2)".to_owned(),
                    server_version: stored.version,
                    server_row: stored.payload,
                    conflict_columns,
                }));
            }
        }
        let mut next = stored_values.clone();
        for (index, slot) in values.iter_mut().enumerate() {
            if present[index] {
                next[index] = slot.take();
            }
        }
        merge_crdt(table, &mut next, Some(&stored_values), &present, op_index)?;
        let version = stored.version + 1;
        let next_versions: BTreeMap<usize, i64> = (0..table.columns.len())
            .map(|index| {
                let moved = present[index] && index != table.pk;
                (
                    index,
                    if moved {
                        version
                    } else {
                        column_version(index)
                    },
                )
            })
            .collect();
        let payload = store::encode_payload(&table.columns, &next);
        check_blobs(table, &next, op_index)?;
        let row = StoredRow {
            row_id: op.row_id.clone(),
            version,
            scopes: stored.scopes.clone(),
            payload: payload.clone(),
            column_versions: store::encode_column_versions(&next_versions),
        };
        write(conn, table, &row, &next, op_index)?;
        let change = NewChange {
            table: table.name.clone(),
            row_id: op.row_id.clone(),
            upsert: true,
            row_version: Some(version),
            scopes: stored.scopes,
            payload: Some(payload),
        };
        return Ok((vec![change], staged(Some(next), true)));
    }

    // Insert path: no stored row (§6.2 tombstone table).
    if op.base_version.is_some_and(|base| base != 0) {
        if scopes_of(table, &values).is_none() {
            return Err(error(
                op_index,
                "sync.forbidden",
                "write denied by scope authorization (§3.4)",
            ));
        }
        return Err(error(
            op_index,
            "sync.row_missing",
            "upsert with baseVersion targets an absent row (§6.2)",
        ));
    }
    if op.base_version.is_none() && store::has_tombstone(conn, &table.name, &op.row_id)? {
        return Err(error(
            op_index,
            "sync.row_deleted",
            "a deleted row rejects an unversioned upsert within the retention horizon (§5.2)",
        ));
    }
    if present.iter().any(|p| !p) {
        return Err(error(
            op_index,
            "sync.row_missing",
            "a partial payload targets an absent row (§6.3)",
        ));
    }
    let Some(scopes) = scopes_of(table, &values) else {
        return Err(error(
            op_index,
            "sync.forbidden",
            "insert missing scope column value (§3.4)",
        ));
    };
    merge_crdt(table, &mut values, None, &present, op_index)?;
    let payload = store::encode_payload(&table.columns, &values);
    check_blobs(table, &values, op_index)?;
    if op.base_version.is_some() {
        store::clear_tombstone(conn, &table.name, &op.row_id)?;
    }
    let row = StoredRow {
        row_id: op.row_id.clone(),
        version: 1,
        scopes: scopes.clone(),
        payload: payload.clone(),
        column_versions: None,
    };
    write(conn, table, &row, &values, op_index)?;
    let change = NewChange {
        table: table.name.clone(),
        row_id: op.row_id.clone(),
        upsert: true,
        row_version: Some(1),
        scopes,
        payload: Some(payload),
    };
    Ok((vec![change], staged(Some(values), false)))
}

/// §6.11 once per commit after every client operation is staged: a non-null
/// reference must name a live parent, and a parent delete expands through
/// `CASCADE` / `SET NULL` or rejects under `RESTRICT`. Appended operations
/// take synthetic op indexes from `client_ops` on; rejections attribute to
/// the originating client delete.
fn enforce_references(
    conn: &Connection,
    schema: &Schema,
    staged: &[Staged],
    client_ops: usize,
) -> Result<Vec<NewChange>, Fail> {
    let mut order: Vec<(usize, usize)> = Vec::new();
    let mut by_row: HashMap<(&str, &str), usize> = HashMap::new();
    for (index, write) in staged.iter().enumerate() {
        match by_row.get(&(write.table.as_str(), write.row_id.as_str())) {
            Some(slot) => order[*slot].1 = index,
            None => {
                by_row.insert((&write.table, &write.row_id), order.len());
                order.push((index, index));
            }
        }
    }
    for (_, last) in &order {
        let write = &staged[*last];
        let Some(values) = &write.values else {
            continue;
        };
        let table = schema.table(&write.table).expect("staged tables exist");
        for reference in &table.references {
            let Some(parent_id) = store::render(&values[reference.column]) else {
                continue;
            };
            if store::get_row(conn, &reference.parent, &parent_id)?.is_some() {
                continue;
            }
            let column = &table.columns[reference.column].name;
            let references = if parent_id.len() <= 256 {
                json!({ "parent": reference.parent, "row": parent_id })
            } else {
                json!({ "parent": reference.parent })
            };
            return Err(reference_error(
                write.op_index,
                "declared reference names an absent parent row (§6.11)",
                json!({ "reason": "missing_parent", "fieldPaths": [column], "references": references }),
            ));
        }
    }

    let mut changes = Vec::new();
    let mut appended = 0usize;
    let mut scheduled: HashSet<(String, String)> = HashSet::new();
    let mut queue: Vec<(String, String, i32)> = Vec::new();
    for (first, last) in &order {
        let write = &staged[*last];
        if write.values.is_none() && staged[*first].existed {
            scheduled.insert((write.table.clone(), write.row_id.clone()));
            queue.push((write.table.clone(), write.row_id.clone(), write.op_index));
        }
    }
    let mut processed: HashSet<(String, String)> = HashSet::new();
    let mut cursor = 0;
    while cursor < queue.len() {
        let (parent_table, parent_id, origin) = queue[cursor].clone();
        cursor += 1;
        if !processed.insert((parent_table.clone(), parent_id.clone())) {
            continue;
        }
        let parent = schema.table(&parent_table).expect("scheduled tables exist");
        for incoming in &parent.referenced_by {
            let child = schema
                .table(&incoming.child)
                .expect("compiled reference child");
            let rows = store::children(conn, child, incoming.column, &parent_id)?;
            if rows.is_empty() {
                continue;
            }
            if incoming.on_delete == OnDelete::Restrict {
                return Err(reference_error(
                    origin,
                    "delete is blocked by a declared reference with ON DELETE RESTRICT (§6.11)",
                    json!({ "reason": "restricted_delete", "references": { "child": child.name } }),
                ));
            }
            for row in rows {
                let key = (child.name.clone(), row.row_id.clone());
                if incoming.on_delete == OnDelete::Cascade {
                    if !scheduled.insert(key.clone()) {
                        continue;
                    }
                    queue.push((key.0, key.1, origin));
                } else if scheduled.contains(&key) {
                    continue;
                }
                // §6.11 cascade cap per commit (the reference default).
                if appended >= 1000 {
                    return Err(reference_error(
                        origin,
                        "declared-reference cascade exceeded the per-commit operation cap (§6.11)",
                        json!({ "reason": "cascade_limit" }),
                    ));
                }
                let synthetic = (client_ops + appended) as i32;
                if incoming.on_delete == OnDelete::Cascade {
                    store::delete_row(conn, &child.name, &row.row_id)?;
                    changes.push(NewChange {
                        table: child.name.clone(),
                        row_id: row.row_id.clone(),
                        upsert: false,
                        row_version: None,
                        scopes: row.scopes,
                        payload: None,
                    });
                } else {
                    let mut values = store::decode_payload(&child.columns, &row.payload)?;
                    values[incoming.column] = None;
                    // §6.2: the SET NULL upsert writes only the reference column.
                    let version = row.version + 1;
                    let stored_versions =
                        store::decode_column_versions(row.column_versions.as_deref())?;
                    let next_versions: BTreeMap<usize, i64> = (0..child.columns.len())
                        .map(|index| {
                            let previous = stored_versions.get(&index).copied().unwrap_or(
                                if row.column_versions.is_none() {
                                    row.version
                                } else {
                                    1
                                },
                            );
                            (
                                index,
                                if index == incoming.column {
                                    version
                                } else {
                                    previous
                                },
                            )
                        })
                        .collect();
                    let payload = store::encode_payload(&child.columns, &values);
                    let next = StoredRow {
                        row_id: row.row_id.clone(),
                        version,
                        scopes: row.scopes.clone(),
                        payload: payload.clone(),
                        column_versions: store::encode_column_versions(&next_versions),
                    };
                    write(conn, child, &next, &values, synthetic)?;
                    changes.push(NewChange {
                        table: child.name.clone(),
                        row_id: row.row_id,
                        upsert: true,
                        row_version: Some(version),
                        scopes: row.scopes,
                        payload: Some(payload),
                    });
                }
                appended += 1;
            }
        }
    }
    Ok(changes)
}

fn apply_commit(
    conn: &Connection,
    schema: &Schema,
    operations: &[Operation],
) -> Result<Vec<NewChange>, Fail> {
    let mut changes = Vec::new();
    let mut staged = Vec::with_capacity(operations.len());
    for (index, op) in operations.iter().enumerate() {
        let (op_changes, write) = apply_operation(conn, schema, op, index as i32)?;
        changes.extend(op_changes);
        staged.push(write);
    }
    changes.extend(enforce_references(conn, schema, &staged, operations.len())?);
    Ok(changes)
}

/// Process one `PUSH_COMMIT` in its own transaction and answer its frames;
/// the idempotency record persists with the commit's writes, a rejection
/// with none of them.
pub(crate) fn process_commit(
    conn: &Connection,
    schema: &Schema,
    client_id: &str,
    client_commit_id: &str,
    operations: &[Operation],
    created_at_ms: i64,
) -> Result<Vec<Frame>, AuthorityError> {
    store::transaction(conn, || {
        if let Some(text) = store::push_result(conn, client_id, client_commit_id)? {
            let stored: StoredResult =
                serde_json::from_str(&text).map_err(|_| store::corrupt("push result"))?;
            return Ok(stored.frames(client_commit_id, true));
        }
        conn.execute_batch("SAVEPOINT syncular_push_candidate")
            .db()?;
        let result = match apply_commit(conn, schema, operations) {
            Ok(changes) => {
                conn.execute_batch("RELEASE syncular_push_candidate").db()?;
                let commit_seq = store::append_commit(
                    conn,
                    client_id,
                    client_commit_id,
                    created_at_ms,
                    &changes,
                )?;
                StoredResult {
                    applied: true,
                    commit_seq: Some(commit_seq),
                    results: (0..operations.len() as i32)
                        .map(|op_index| StoredOp::Applied { op_index })
                        .collect(),
                }
            }
            Err(Fail::Terminate(record)) => {
                conn.execute_batch(
                    "ROLLBACK TO syncular_push_candidate; RELEASE syncular_push_candidate",
                )
                .db()?;
                StoredResult {
                    applied: false,
                    commit_seq: None,
                    results: vec![record],
                }
            }
            Err(Fail::Storage(error)) => return Err(error),
        };
        let text = serde_json::to_string(&result).expect("a push result serializes");
        store::put_push_result(conn, client_id, client_commit_id, &text)?;
        Ok(result.frames(client_commit_id, false))
    })
}
