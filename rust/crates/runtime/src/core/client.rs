#[cfg(feature = "native")]
use crate::app_schema::validate_app_schema_runtime_features;
use crate::app_schema::{default_app_schema, AppSchema, AppTableMetadata};
use crate::binary_snapshot::{
    BinarySnapshotCell, BinarySnapshotPayload, BorrowedBinarySnapshotCell,
    DecodedBinarySnapshotRows, SnapshotChunkRows,
};
#[cfg(feature = "native")]
use crate::crdt_field::{
    validate_crdt_field, CrdtDocumentSnapshot, CrdtField, CrdtFieldId, CrdtFieldSyncMode,
    CrdtUpdateLogEntry,
};
#[cfg(feature = "native")]
use crate::crdt_yjs::{
    build_yjs_text_update, materialize_yjs_state, yjs_state_vector_base64, BuildYjsTextUpdateArgs,
};
use crate::crdt_yjs::{YjsUpdateEnvelope, YJS_PAYLOAD_KEY};
#[cfg(feature = "native")]
use crate::diesel_sqlite::{DieselSqliteStore, DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY};
use crate::encrypted_crdt::EncryptedCrdt;
#[cfg(feature = "native")]
use crate::encrypted_crdt::{
    encrypted_crdt_stream_id, encrypted_field_metadata, BuildEncryptedCrdtCheckpointArgs,
    BuildEncryptedCrdtTextUpdateArgs, BuildEncryptedCrdtYjsUpdateArgs,
};
use crate::encryption::{FieldEncryption, FieldEncryptionContext};
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "demo-todo-native-fixture")]
use crate::fixtures::todo::rusqlite_sqlite::RusqliteStore;
use crate::protocol::*;
#[cfg(feature = "native")]
use crate::store::MAX_BLOB_UPLOAD_RETRIES;
use crate::store::{
    next_retry_at, now_ms, OutboxCommit, SubscriptionState, SyncStateStore, SyncStore, SyncStoreTx,
    VerifiedRoot, MAX_SYNC_RETRIES,
};
#[cfg(feature = "demo-todo-fixture")]
use crate::store::{DemoTaskStore, Task};
#[cfg(feature = "native")]
use crate::transport::BlobTransport;
#[cfg(feature = "native")]
use crate::transport::{HttpSyncTransport, SyncTransportConfig};
use crate::transport::{
    RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport,
};
#[cfg(feature = "native")]
use crate::transport::{SyncAuthSigner, SyncAuthSignerStore};
use serde::{Deserialize, Serialize};
#[cfg(feature = "native")]
use serde_json::json;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;
#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::fs::File;
#[cfg(feature = "native")]
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
#[cfg(feature = "demo-todo-fixture")]
use uuid::Uuid;

const DEFAULT_STATE_ID: &str = "default";
const MAX_PULL_ROUNDS: usize = 20;

static ACTIVE_SYNC_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct SyncularClientConfig {
    pub db_path: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
}

pub trait SyncularMutationExecutor {
    fn apply_mutation<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation;

    fn apply_mutation_batch(&mut self, batch: SyncularMutationBatch) -> Result<MutationReceipt>;

    fn commit_mutations<R>(
        &mut self,
        f: impl FnOnce(&mut SyncularMutationBatch) -> Result<R>,
    ) -> Result<MutationCommit<R>> {
        let mut batch = SyncularMutationBatch::new();
        let result = f(&mut batch)?;
        let commit = self.apply_mutation_batch(batch)?;
        Ok(MutationCommit { result, commit })
    }
}

pub trait SyncularEncryptedCrdtMutationExecutor {
    fn apply_encrypted_crdt_text_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        next_text: &str,
    ) -> Result<MutationReceipt>;

    fn apply_encrypted_crdt_yjs_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        update: YjsUpdateEnvelope,
    ) -> Result<MutationReceipt>;

    fn apply_encrypted_crdt_checkpoint(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        min_uncheckpointed_updates: i64,
    ) -> Result<Option<MutationReceipt>>;
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtFieldWriteReceipt {
    pub client_commit_id: String,
    pub sync_mode: CrdtFieldSyncMode,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtFieldMaterialization {
    pub value: Value,
    pub state_base64: Option<String>,
    pub state_vector_base64: String,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtFieldCompactionReceipt {
    pub checkpoint_created: bool,
    pub client_commit_id: Option<String>,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCrdtUpdateJsonRequest {
    table: String,
    field: String,
    #[serde(alias = "row_id")]
    row_id: String,
    #[serde(default)]
    next_text: Option<String>,
    #[serde(default)]
    update: Option<YjsUpdateEnvelope>,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCrdtCheckpointJsonRequest {
    table: String,
    field: String,
    #[serde(alias = "row_id")]
    row_id: String,
    #[serde(default)]
    min_uncheckpointed_updates: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionSpec {
    pub id: String,
    pub table: String,
    pub scopes: ScopeValues,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChangedRow {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_id: Option<String>,
    pub operation: String,
    #[serde(default)]
    pub changed_fields: Vec<String>,
    #[serde(default)]
    pub crdt_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub changed_tables: Vec<String>,
    pub changed_rows: Vec<SyncChangedRow>,
    pub conflicts_changed: bool,
}

#[derive(Debug, Clone)]
struct PreparedSnapshot {
    snapshot: SyncSnapshot,
    chunk_batches: Vec<SnapshotChunkRows>,
    artifact_rows: Vec<Value>,
}

impl SyncReport {
    pub fn table_changed(table: impl Into<String>) -> Self {
        Self {
            changed_tables: vec![table.into()],
            changed_rows: Vec::new(),
            conflicts_changed: false,
        }
    }

    pub fn tables_changed<I, Table>(tables: I) -> Self
    where
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        let mut report = Self::default();
        for table in tables {
            report.add_changed_table(&table.into());
        }
        report
    }

    pub fn conflicts_changed() -> Self {
        Self {
            changed_tables: Vec::new(),
            changed_rows: Vec::new(),
            conflicts_changed: true,
        }
    }

    fn add_changed_table(&mut self, table: &str) {
        if !self.changed_tables.iter().any(|existing| existing == table) {
            self.changed_tables.push(table.to_string());
        }
    }

    pub fn changes_table(&self, table: &str) -> bool {
        self.changed_tables.iter().any(|existing| existing == table)
    }

    pub fn changes_any_table<'a>(&self, tables: impl IntoIterator<Item = &'a str>) -> bool {
        tables.into_iter().any(|table| self.changes_table(table))
    }

    fn add_changed_row(&mut self, row: SyncChangedRow) {
        self.add_changed_table(&row.table);
        self.changed_rows.push(row);
    }

    fn merge(&mut self, other: SyncReport) {
        self.conflicts_changed |= other.conflicts_changed;
        for table in other.changed_tables {
            self.add_changed_table(&table);
        }
        self.changed_rows.extend(other.changed_rows);
    }
}

pub fn sync_changed_row_for_operation(
    app_schema: AppSchema,
    operation: &SyncOperation,
    commit_id: Option<String>,
) -> Option<SyncChangedRow> {
    sync_changed_row_for_local_operation(app_schema, operation, None, None, commit_id)
}

pub fn sync_changed_row_for_local_operation(
    app_schema: AppSchema,
    operation: &SyncOperation,
    previous_row: Option<&Value>,
    local_row: Option<&Value>,
    commit_id: Option<String>,
) -> Option<SyncChangedRow> {
    let metadata = app_schema.table_metadata(&operation.table)?;
    let changed_fields = if operation.op == "delete" {
        Vec::new()
    } else if let Some(local_row) = local_row {
        changed_fields_from_row_diff(metadata, previous_row, Some(local_row))
    } else {
        changed_fields_from_payload(metadata, operation.payload.as_ref())
    };
    let operation_kind = if operation.op == "upsert" {
        if previous_row.is_some() {
            "update"
        } else {
            "insert"
        }
    } else {
        operation.op.as_str()
    };
    Some(SyncChangedRow {
        table: operation.table.clone(),
        row_id: Some(operation.row_id.clone()),
        operation: operation_kind.to_string(),
        crdt_fields: crdt_state_columns_for_fields(metadata, &changed_fields),
        changed_fields,
        commit_id,
        commit_seq: None,
        subscription_id: None,
        server_version: operation.base_version,
    })
}

pub fn sync_changed_row_for_change(
    app_schema: AppSchema,
    change: &SyncChange,
    previous_row: Option<&Value>,
    commit_seq: i64,
    subscription_id: &str,
) -> Option<SyncChangedRow> {
    let metadata = app_schema.table_metadata(&change.table)?;
    let changed_fields = changed_fields_from_remote_change(metadata, change, previous_row);
    Some(SyncChangedRow {
        table: change.table.clone(),
        row_id: Some(change.row_id.clone()),
        operation: if change.op == "delete" {
            "delete".to_string()
        } else if previous_row.is_some() {
            "update".to_string()
        } else {
            "insert".to_string()
        },
        crdt_fields: crdt_state_columns_for_fields(metadata, &changed_fields),
        changed_fields,
        commit_id: Some(commit_seq.to_string()),
        commit_seq: Some(commit_seq),
        subscription_id: Some(subscription_id.to_string()),
        server_version: change.row_version,
    })
}

pub fn sync_changed_row_for_snapshot(
    app_schema: AppSchema,
    table: &str,
    row: &Value,
    previous_row: Option<&Value>,
    subscription_id: &str,
) -> Option<SyncChangedRow> {
    let metadata = app_schema.table_metadata(table)?;
    let row_id = row
        .get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .map(str::to_string);
    let changed_fields = changed_fields_from_row_diff(metadata, previous_row, Some(row));
    Some(SyncChangedRow {
        table: table.to_string(),
        row_id,
        operation: if previous_row.is_some() {
            "update".to_string()
        } else {
            "insert".to_string()
        },
        crdt_fields: crdt_state_columns_for_fields(metadata, &changed_fields),
        changed_fields,
        commit_id: None,
        commit_seq: None,
        subscription_id: Some(subscription_id.to_string()),
        server_version: row
            .get(metadata.server_version_column)
            .and_then(Value::as_i64),
    })
}

pub(crate) fn sync_changed_rows_for_cleared_snapshot_chunk(
    app_schema: AppSchema,
    table: &str,
    rows: &SnapshotChunkRows,
    subscription_id: &str,
) -> Vec<SyncChangedRow> {
    sync_changed_rows_for_cleared_snapshot_chunk_limited(
        app_schema,
        table,
        rows,
        subscription_id,
        usize::MAX,
    )
    .0
}

pub(crate) fn sync_changed_rows_for_cleared_snapshot_chunk_limited(
    app_schema: AppSchema,
    table: &str,
    rows: &SnapshotChunkRows,
    subscription_id: &str,
    limit: usize,
) -> (Vec<SyncChangedRow>, bool) {
    match rows {
        SnapshotChunkRows::Json(rows) => (
            rows.iter()
                .take(limit)
                .filter_map(|row| {
                    sync_changed_row_for_snapshot(app_schema, table, row, None, subscription_id)
                })
                .collect(),
            rows.len() > limit,
        ),
        SnapshotChunkRows::Binary(rows) => sync_changed_rows_for_cleared_binary_snapshot_chunk(
            app_schema,
            table,
            rows,
            subscription_id,
            limit,
        ),
        SnapshotChunkRows::BinaryPayload(rows) => {
            sync_changed_rows_for_cleared_binary_snapshot_payload(
                app_schema,
                table,
                rows,
                subscription_id,
                limit,
            )
        }
    }
}

fn sync_changed_rows_for_cleared_binary_snapshot_chunk(
    app_schema: AppSchema,
    table: &str,
    rows: &DecodedBinarySnapshotRows,
    subscription_id: &str,
    limit: usize,
) -> (Vec<SyncChangedRow>, bool) {
    sync_changed_rows_for_cleared_binary_snapshot_chunk_limited(
        app_schema,
        table,
        rows,
        subscription_id,
        limit,
    )
    .unwrap_or_default()
}

fn sync_changed_rows_for_cleared_binary_snapshot_chunk_limited(
    app_schema: AppSchema,
    table: &str,
    rows: &DecodedBinarySnapshotRows,
    subscription_id: &str,
    limit: usize,
) -> Result<(Vec<SyncChangedRow>, bool)> {
    let Some(metadata) = app_schema.table_metadata(table) else {
        return Ok((Vec::new(), false));
    };
    let Some(primary_key_index) = rows
        .columns
        .iter()
        .position(|column| column.name == metadata.primary_key_column)
    else {
        return Ok((Vec::new(), false));
    };
    let server_version_index = rows
        .columns
        .iter()
        .position(|column| column.name == metadata.server_version_column);
    let present_columns = rows
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let changed_fields = metadata
        .columns
        .iter()
        .filter_map(|column| {
            if column.name == metadata.primary_key_column || !present_columns.contains(column.name)
            {
                return None;
            }
            Some(column.name.to_string())
        })
        .collect::<Vec<_>>();
    let crdt_fields = crdt_state_columns_for_fields(metadata, &changed_fields);
    Ok((
        rows.rows
            .iter()
            .take(limit)
            .map(|row| SyncChangedRow {
                table: table.to_string(),
                row_id: row
                    .get(primary_key_index)
                    .and_then(binary_snapshot_cell_row_id),
                operation: "insert".to_string(),
                crdt_fields: crdt_fields.clone(),
                changed_fields: changed_fields.clone(),
                commit_id: None,
                commit_seq: None,
                subscription_id: Some(subscription_id.to_string()),
                server_version: server_version_index
                    .and_then(|index| row.get(index))
                    .and_then(binary_snapshot_cell_i64),
            })
            .collect(),
        rows.rows.len() > limit,
    ))
}

fn binary_snapshot_cell_row_id(cell: &BinarySnapshotCell) -> Option<String> {
    match cell {
        BinarySnapshotCell::String(value) => Some(value.clone()),
        BinarySnapshotCell::Integer(value) => Some(value.to_string()),
        _ => None,
    }
}

fn binary_snapshot_cell_i64(cell: &BinarySnapshotCell) -> Option<i64> {
    match cell {
        BinarySnapshotCell::Integer(value) => Some(*value),
        BinarySnapshotCell::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn sync_changed_rows_for_cleared_binary_snapshot_payload(
    app_schema: AppSchema,
    table: &str,
    payload: &BinarySnapshotPayload,
    subscription_id: &str,
    limit: usize,
) -> (Vec<SyncChangedRow>, bool) {
    sync_changed_rows_for_cleared_binary_snapshot_payload_limited(
        app_schema,
        table,
        payload,
        subscription_id,
        limit,
    )
    .unwrap_or_default()
}

fn sync_changed_rows_for_cleared_binary_snapshot_payload_limited(
    app_schema: AppSchema,
    table: &str,
    payload: &BinarySnapshotPayload,
    subscription_id: &str,
    limit: usize,
) -> Result<(Vec<SyncChangedRow>, bool)> {
    let truncated = payload.row_count() > limit;
    if limit == 0 {
        return Ok((Vec::new(), truncated));
    }
    let Some(metadata) = app_schema.table_metadata(table) else {
        return Ok((Vec::new(), false));
    };
    let Some(primary_key_index) = payload
        .columns
        .iter()
        .position(|column| column.name == metadata.primary_key_column)
    else {
        return Ok((Vec::new(), false));
    };
    let server_version_index = payload
        .columns
        .iter()
        .position(|column| column.name == metadata.server_version_column);
    let present_columns = payload
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let changed_fields = metadata
        .columns
        .iter()
        .filter_map(|column| {
            if column.name == metadata.primary_key_column || !present_columns.contains(column.name)
            {
                return None;
            }
            Some(column.name.to_string())
        })
        .collect::<Vec<_>>();
    let crdt_fields = crdt_state_columns_for_fields(metadata, &changed_fields);
    let mut cursor = payload.row_cursor();
    let row_limit = payload.row_count().min(limit);
    let mut rows = Vec::with_capacity(row_limit);
    for _ in 0..row_limit {
        let mut row_id = None;
        let mut server_version = None;
        let read = cursor.read_next_row(|column_index, _column, cell| {
            if column_index == primary_key_index {
                row_id = borrowed_binary_snapshot_cell_row_id(cell);
            }
            if Some(column_index) == server_version_index {
                server_version = borrowed_binary_snapshot_cell_i64(cell);
            }
            Ok(())
        })?;
        if !read {
            break;
        }
        rows.push(SyncChangedRow {
            table: table.to_string(),
            row_id,
            operation: "insert".to_string(),
            crdt_fields: crdt_fields.clone(),
            changed_fields: changed_fields.clone(),
            commit_id: None,
            commit_seq: None,
            subscription_id: Some(subscription_id.to_string()),
            server_version,
        });
    }
    if !truncated {
        cursor.assert_done()?;
    }
    Ok((rows, truncated))
}

fn borrowed_binary_snapshot_cell_row_id(cell: BorrowedBinarySnapshotCell<'_>) -> Option<String> {
    match cell {
        BorrowedBinarySnapshotCell::String(value) => Some(value.to_string()),
        BorrowedBinarySnapshotCell::Integer(value) => Some(value.to_string()),
        _ => None,
    }
}

fn borrowed_binary_snapshot_cell_i64(cell: BorrowedBinarySnapshotCell<'_>) -> Option<i64> {
    match cell {
        BorrowedBinarySnapshotCell::Integer(value) => Some(value),
        BorrowedBinarySnapshotCell::String(value) => value.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod changed_rows_tests {
    use super::*;
    use crate::app_schema::{ColumnMetadata, EmbeddedMigration};
    use crate::binary_snapshot::decode_binary_snapshot_payload;

    static TEST_COLUMNS: [ColumnMetadata; 3] = [
        ColumnMetadata {
            name: "id",
            type_family: "text",
            notnull_required: true,
            primary_key: true,
        },
        ColumnMetadata {
            name: "title",
            type_family: "text",
            notnull_required: false,
            primary_key: false,
        },
        ColumnMetadata {
            name: "server_version",
            type_family: "integer",
            notnull_required: true,
            primary_key: false,
        },
    ];

    static TEST_TABLES: [&str; 1] = ["tasks"];
    static TEST_TABLE_METADATA: [AppTableMetadata; 1] = [AppTableMetadata {
        name: "tasks",
        primary_key_column: "id",
        server_version_column: "server_version",
        soft_delete_column: None,
        subscription_id: "tasks",
        columns: &TEST_COLUMNS,
        blob_columns: &[],
        crdt_yjs_fields: &[],
        encrypted_fields: &[],
        scopes: &[],
    }];
    static TEST_MIGRATIONS: [EmbeddedMigration; 0] = [];

    fn default_subscriptions(_: &SyncularClientConfig) -> Vec<SubscriptionSpec> {
        Vec::new()
    }

    #[cfg(feature = "native")]
    fn adapter_for(_: &str) -> Result<&'static dyn crate::app_schema::DieselTableAdapter> {
        Err(SyncularError::config("test schema has no diesel adapter"))
    }

    fn test_schema() -> AppSchema {
        AppSchema {
            app_tables: &TEST_TABLES,
            app_table_metadata: &TEST_TABLE_METADATA,
            migrations: &TEST_MIGRATIONS,
            schema_version: Some(1),
            default_subscriptions,
            #[cfg(feature = "native")]
            adapter_for,
        }
    }

    #[test]
    fn builds_changed_rows_from_binary_snapshot_payload() {
        let payload = decode_binary_snapshot_payload(binary_snapshot_bytes()).unwrap();
        let rows = sync_changed_rows_for_cleared_snapshot_chunk(
            test_schema(),
            "tasks",
            &SnapshotChunkRows::BinaryPayload(payload),
            "sub-tasks",
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].row_id.as_deref(), Some("task-1"));
        assert_eq!(rows[0].operation, "insert");
        assert_eq!(rows[0].changed_fields, vec!["title", "server_version"]);
        assert_eq!(rows[0].server_version, Some(41));
        assert_eq!(rows[0].subscription_id.as_deref(), Some("sub-tasks"));
        assert_eq!(rows[1].row_id.as_deref(), Some("task-2"));
        assert_eq!(rows[1].server_version, Some(42));

        let payload = decode_binary_snapshot_payload(binary_snapshot_bytes()).unwrap();
        let (limited, truncated) = sync_changed_rows_for_cleared_snapshot_chunk_limited(
            test_schema(),
            "tasks",
            &SnapshotChunkRows::BinaryPayload(payload),
            "sub-tasks",
            1,
        );
        assert!(truncated);
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].row_id.as_deref(), Some("task-1"));
    }

    fn binary_snapshot_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"SBT1");
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 0);
        push_string16(&mut bytes, "tasks");
        push_u16(&mut bytes, 3);
        for (name, tag, flags) in [
            ("id", 1u8, 0u8),
            ("title", 1u8, 0u8),
            ("server_version", 2u8, 0u8),
        ] {
            push_string16(&mut bytes, name);
            bytes.push(tag);
            bytes.push(flags);
        }
        push_u32(&mut bytes, 2);

        bytes.push(0);
        push_string32(&mut bytes, "task-1");
        push_string32(&mut bytes, "First");
        push_i64(&mut bytes, 41);

        bytes.push(0);
        push_string32(&mut bytes, "task-2");
        push_string32(&mut bytes, "Second");
        push_i64(&mut bytes, 42);
        bytes
    }

    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_i64(bytes: &mut Vec<u8>, value: i64) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_string16(bytes: &mut Vec<u8>, value: &str) {
        push_u16(bytes, value.len() as u16);
        bytes.extend_from_slice(value.as_bytes());
    }

    fn push_string32(bytes: &mut Vec<u8>, value: &str) {
        push_u32(bytes, value.len() as u32);
        bytes.extend_from_slice(value.as_bytes());
    }
}

fn changed_fields_from_remote_change(
    metadata: &AppTableMetadata,
    change: &SyncChange,
    previous_row: Option<&Value>,
) -> Vec<String> {
    if change.op == "delete" {
        return Vec::new();
    }
    let Some(row) = change.row_json.as_ref() else {
        return Vec::new();
    };
    if row
        .as_object()
        .is_some_and(|object| object.contains_key(YJS_PAYLOAD_KEY))
    {
        return changed_fields_from_yjs_envelope(metadata, row);
    }
    changed_fields_from_row_diff(metadata, previous_row, Some(row))
}

fn changed_fields_from_row_diff(
    metadata: &AppTableMetadata,
    previous_row: Option<&Value>,
    next_row: Option<&Value>,
) -> Vec<String> {
    let Some(next_row) = next_row.and_then(Value::as_object) else {
        return Vec::new();
    };
    let previous_row = previous_row.and_then(Value::as_object);
    metadata
        .columns
        .iter()
        .filter_map(|column| {
            if column.name == metadata.primary_key_column || !next_row.contains_key(column.name) {
                return None;
            }
            match previous_row.and_then(|row| row.get(column.name)) {
                Some(previous) if Some(previous) == next_row.get(column.name) => None,
                _ => Some(column.name.to_string()),
            }
        })
        .collect()
}

fn changed_fields_from_payload(
    metadata: &AppTableMetadata,
    payload: Option<&Value>,
) -> Vec<String> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    if payload
        .as_object()
        .is_some_and(|object| object.contains_key(YJS_PAYLOAD_KEY))
    {
        return changed_fields_from_yjs_envelope(metadata, payload);
    }
    let Some(payload) = payload.as_object() else {
        return Vec::new();
    };
    metadata
        .columns
        .iter()
        .filter_map(|column| {
            if column.name == metadata.primary_key_column || !payload.contains_key(column.name) {
                return None;
            }
            Some(column.name.to_string())
        })
        .collect()
}

fn changed_fields_from_yjs_envelope(metadata: &AppTableMetadata, payload: &Value) -> Vec<String> {
    let Some(envelope) = payload.get(YJS_PAYLOAD_KEY).and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut fields = Vec::new();
    for field_name in envelope.keys() {
        if let Some(field) = metadata
            .crdt_yjs_fields
            .iter()
            .find(|candidate| candidate.field == field_name.as_str())
        {
            push_unique(&mut fields, field.field);
            push_unique(&mut fields, field.state_column);
        }
    }
    fields
}

fn crdt_state_columns_for_fields(
    metadata: &AppTableMetadata,
    changed_fields: &[String],
) -> Vec<String> {
    let changed = changed_fields
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    metadata
        .crdt_yjs_fields
        .iter()
        .filter_map(|field| {
            if changed.contains(field.field) || changed.contains(field.state_column) {
                Some(field.state_column.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

fn row_id_for_metadata(app_schema: AppSchema, table: &str, row: &Value) -> Option<String> {
    let metadata = app_schema.table_metadata(table)?;
    row.get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn snapshot_clear_removes_all_rows(app_schema: AppSchema, table: &str) -> bool {
    app_schema.table_metadata(table).is_some_and(|metadata| {
        !metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictResolution {
    KeepLocal,
    #[serde(rename = "keep-server", alias = "accept-server")]
    AcceptServer,
    Dismiss,
}

impl ConflictResolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeepLocal => "keep-local",
            Self::AcceptServer => "keep-server",
            Self::Dismiss => "dismiss",
        }
    }
}

impl fmt::Display for ConflictResolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictResolutionReceipt {
    pub conflict_id: String,
    pub resolution: ConflictResolution,
    pub retry_client_commit_id: Option<String>,
}

pub struct SyncularConflicts<'a, S, T> {
    client: &'a mut SyncularClient<S, T>,
}

#[cfg(feature = "native")]
#[derive(Debug)]
pub struct SyncularLiveQuery<QF, Row> {
    tables: Vec<String>,
    build_query: QF,
    rows: Vec<Row>,
    revision: u64,
}

#[cfg(feature = "native")]
impl<QF, Row> SyncularLiveQuery<QF, Row> {
    pub fn new<I, Table>(tables: I, build_query: QF) -> Self
    where
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        Self {
            tables: tables.into_iter().map(Into::into).collect(),
            build_query,
            rows: Vec::new(),
            revision: 0,
        }
    }

    pub fn tables(&self) -> &[String] {
        &self.tables
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn into_rows(self) -> Vec<Row> {
        self.rows
    }

    pub fn is_affected_by(&self, report: &SyncReport) -> bool {
        report.changes_any_table(self.tables.iter().map(String::as_str))
    }

    pub fn refresh<T, Q>(
        &mut self,
        client: &mut SyncularClient<DieselSqliteStore, T>,
    ) -> Result<&[Row]>
    where
        T: SyncTransport,
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        self.rows = client.read((self.build_query)())?;
        self.revision = self.revision.saturating_add(1);
        Ok(&self.rows)
    }

    pub fn refresh_if_changed<T, Q>(
        &mut self,
        client: &mut SyncularClient<DieselSqliteStore, T>,
        report: &SyncReport,
    ) -> Result<bool>
    where
        T: SyncTransport,
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        if !self.is_affected_by(report) {
            return Ok(false);
        }
        self.refresh(client)?;
        Ok(true)
    }
}

pub struct SyncularClient<
    #[cfg(feature = "native")] S = DieselSqliteStore,
    #[cfg(not(feature = "native"))] S,
    #[cfg(feature = "native")] T = HttpSyncTransport,
    #[cfg(not(feature = "native"))] T,
> {
    config: SyncularClientConfig,
    store: S,
    transport: T,
    subscriptions: Vec<SubscriptionSpec>,
    app_schema: AppSchema,
    schema_version: i32,
    sync_lock_key: String,
    field_encryption: Option<FieldEncryption>,
    encrypted_crdt: Option<EncryptedCrdt>,
}

#[cfg(feature = "native")]
impl SyncularClient<DieselSqliteStore, HttpSyncTransport> {
    pub fn open(config: SyncularClientConfig) -> Result<Self> {
        Self::open_with_schema(config, default_app_schema())
    }

    pub fn open_with_schema(config: SyncularClientConfig, app_schema: AppSchema) -> Result<Self> {
        validate_app_schema_runtime_features(&app_schema)?;
        let store = DieselSqliteStore::open_with_schema(&config.db_path, app_schema)?;
        let transport = HttpSyncTransport::new(SyncTransportConfig::new(
            config.base_url.clone(),
            config.client_id.clone(),
            config.actor_id.clone(),
        ))
        .with_schema_version(app_schema.current_schema_version());
        Ok(Self::with_app_schema_parts(
            config, store, transport, app_schema,
        ))
    }
}

#[cfg(feature = "native")]
impl<S> SyncularClient<S, HttpSyncTransport>
where
    S: SyncStore,
{
    pub fn with_store(config: SyncularClientConfig, store: S) -> Self {
        let app_schema = default_app_schema();
        let transport = HttpSyncTransport::new(SyncTransportConfig::new(
            config.base_url.clone(),
            config.client_id.clone(),
            config.actor_id.clone(),
        ))
        .with_schema_version(app_schema.current_schema_version());
        Self::with_parts(config, store, transport)
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStateStore,
{
    pub fn next_outbox_retry_at_ms(&mut self) -> Result<Option<i64>> {
        self.store.next_outbox_retry_at()
    }

    pub fn next_blob_upload_retry_at_ms(&mut self) -> Result<Option<i64>> {
        self.store.next_blob_upload_retry_at()
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    pub fn with_parts(config: SyncularClientConfig, store: S, transport: T) -> Self {
        Self::with_app_schema_parts(config, store, transport, default_app_schema())
    }

    pub fn with_app_schema_parts(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        app_schema: AppSchema,
    ) -> Self {
        let subscriptions = app_schema.default_subscriptions(&config);
        Self::with_subscriptions_and_schema(
            config,
            store,
            transport,
            subscriptions,
            app_schema,
            app_schema.current_schema_version(),
        )
    }

    pub fn with_subscriptions(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        subscriptions: Vec<SubscriptionSpec>,
        schema_version: i32,
    ) -> Self {
        Self::with_subscriptions_and_schema(
            config,
            store,
            transport,
            subscriptions,
            default_app_schema(),
            schema_version,
        )
    }

    fn with_subscriptions_and_schema(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        subscriptions: Vec<SubscriptionSpec>,
        app_schema: AppSchema,
        schema_version: i32,
    ) -> Self {
        Self {
            sync_lock_key: config.db_path.clone(),
            config,
            store,
            transport,
            subscriptions,
            app_schema,
            schema_version,
            field_encryption: None,
            encrypted_crdt: None,
        }
    }

    pub fn set_field_encryption(&mut self, encryption: Option<FieldEncryption>) {
        self.field_encryption = encryption;
    }

    pub fn set_field_encryption_json(&mut self, config_json: &str) -> Result<()> {
        self.field_encryption = FieldEncryption::from_static_config_json(config_json)?;
        Ok(())
    }

    pub fn set_encrypted_crdt(&mut self, encryption: Option<EncryptedCrdt>) {
        self.encrypted_crdt = encryption;
    }

    pub fn set_encrypted_crdt_json(&mut self, config_json: &str) -> Result<()> {
        self.encrypted_crdt = EncryptedCrdt::from_static_config_json(config_json)?;
        Ok(())
    }

    pub fn table_metadata(&self, table: &str) -> Option<&'static AppTableMetadata> {
        self.app_schema.table_metadata(table)
    }

    pub fn app_schema(&self) -> AppSchema {
        self.app_schema
    }

    pub fn current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        self.store
            .transaction(|tx| tx.current_row_json(table, row_id))
    }

    pub fn subscriptions(&self) -> &[SubscriptionSpec] {
        &self.subscriptions
    }

    pub fn set_subscriptions(&mut self, subscriptions: Vec<SubscriptionSpec>) {
        self.subscriptions = subscriptions;
    }

    pub fn set_subscriptions_json(&mut self, subscriptions_json: &str) -> Result<()> {
        let subscriptions: Vec<SubscriptionSpec> = serde_json::from_str(subscriptions_json)?;
        self.set_subscriptions(subscriptions);
        Ok(())
    }

    pub fn sync_http(&mut self) -> Result<SyncReport> {
        let _guard = SyncLockGuard::acquire(&self.sync_lock_key)?;
        self.sync_http_unlocked()
    }

    fn sync_http_unlocked(&mut self) -> Result<SyncReport> {
        let pending = self.prepare_sync()?;
        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            sync_pack_encodings: self.sync_pack_encodings(),
            push: self.build_push_request(&pending)?,
            pull: Some(self.build_pull_request()?),
        };

        let response = match self.transport.post_sync(&request) {
            Ok(response) => response,
            Err(error) => {
                self.schedule_outbox_retry(&pending, &error)?;
                return Err(error);
            }
        };
        self.apply_combined_response(&pending, response)
    }

    pub fn sync_ws(&mut self) -> Result<SyncReport> {
        let _guard = SyncLockGuard::acquire(&self.sync_lock_key)?;
        self.sync_ws_unlocked()
    }

    fn sync_ws_unlocked(&mut self) -> Result<SyncReport> {
        let pending = self.prepare_sync()?;
        let mut report = SyncReport::default();
        if !pending.is_empty() {
            let mut socket = match self.transport.connect_realtime() {
                Ok(socket) => socket,
                Err(error) => {
                    self.schedule_outbox_retry(&pending, &error)?;
                    return Err(error);
                }
            };

            for commit in &pending {
                let operations = self.operations_for_push(commit)?;
                let response = match socket.push_commit(PushCommitRequest {
                    client_commit_id: commit.client_commit_id.clone(),
                    operations,
                    schema_version: commit.schema_version,
                }) {
                    Ok(response) => response,
                    Err(error) => {
                        self.schedule_outbox_retry(std::slice::from_ref(commit), &error)?;
                        return Err(error);
                    }
                };
                report.merge(self.apply_single_push_response(commit, response)?);
            }

            socket.close();
        }

        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            sync_pack_encodings: self.sync_pack_encodings(),
            push: None,
            pull: Some(self.build_pull_request()?),
        };
        let response = match self.transport.post_sync(&request) {
            Ok(response) => response,
            Err(error) => {
                self.schedule_outbox_retry(&[], &error)?;
                return Err(error);
            }
        };
        report.merge(self.apply_combined_response(&[], response)?);
        Ok(report)
    }

    pub fn watch<F>(&mut self, seconds: u64, mut on_event: F) -> Result<()>
    where
        F: FnMut(&RealtimeEvent),
    {
        let mut socket = self.transport.connect_realtime()?;
        let deadline = SystemTime::now()
            .checked_add(Duration::from_secs(seconds))
            .unwrap_or_else(SystemTime::now);

        while SystemTime::now() < deadline {
            let Some(event) = socket.read_event()? else {
                continue;
            };
            on_event(&event);
            if matches!(event, RealtimeEvent::Sync) {
                let _ = self.sync_http_unlocked()?;
            }
        }

        socket.close();
        Ok(())
    }

    pub fn process_realtime_events<F>(
        &mut self,
        max_events: usize,
        mut on_event: F,
    ) -> Result<usize>
    where
        F: FnMut(&RealtimeEvent),
    {
        let mut socket = self.transport.connect_realtime()?;
        let mut processed = 0usize;

        for _ in 0..max_events {
            let Some(event) = socket.read_event()? else {
                break;
            };
            on_event(&event);
            processed += 1;
            if matches!(event, RealtimeEvent::Sync) {
                let _ = self.sync_http_unlocked()?;
            }
        }

        socket.close();
        Ok(processed)
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport + SyncAuthHeaderStore,
{
    pub fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.transport.set_auth_headers(headers);
    }
}

#[cfg(feature = "native")]
impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport + SyncAuthSignerStore,
{
    pub fn set_auth_signer(&mut self, signer: Option<SyncAuthSigner>) {
        self.transport.set_auth_signer(signer);
    }
}

#[cfg(feature = "native")]
impl<T> SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport + BlobTransport,
{
    pub fn store_blob_bytes(
        &mut self,
        data: &[u8],
        mime_type: &str,
        immediate: bool,
    ) -> Result<BlobRef> {
        let blob = self.store.store_blob_bytes(data, mime_type, !immediate)?;
        if immediate {
            self.transport.upload_blob(&blob, data)?;
        }
        Ok(blob)
    }

    pub fn store_blob_file(
        &mut self,
        path: &Path,
        mime_type: &str,
        immediate: bool,
        cache_local: bool,
    ) -> Result<BlobRef> {
        if cache_local {
            let data = fs::read(path).map_err(|err| {
                SyncularError::storage(err).context(format!("read blob file {path:?}"))
            })?;
            let blob = self.store.store_blob_bytes(&data, mime_type, !immediate)?;
            if immediate {
                self.transport.upload_blob_file(&blob, path)?;
            }
            return Ok(blob);
        }

        if !immediate {
            return Err(SyncularError::config(
                "native blob file storage with cacheLocal=false requires immediate=true",
            ));
        }

        let file = File::open(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open blob file {path:?}"))
        })?;
        let (hash, size) = blob_hash_reader(file)?;
        let blob = BlobRef {
            hash,
            size,
            mime_type: if mime_type.trim().is_empty() {
                "application/octet-stream".to_string()
            } else {
                mime_type.to_string()
            },
            encrypted: false,
            key_id: None,
        };
        self.transport.upload_blob_file(&blob, path)?;
        Ok(blob)
    }

    pub fn retrieve_blob_bytes(&mut self, blob: &BlobRef) -> Result<Vec<u8>> {
        if let Some(bytes) = self.store.read_cached_blob(&blob.hash)? {
            return Ok(bytes);
        }
        let bytes = self.transport.download_blob(blob)?;
        self.store.cache_blob_bytes(blob, &bytes)?;
        Ok(bytes)
    }

    pub fn retrieve_blob_file(
        &mut self,
        blob: &BlobRef,
        path: &Path,
        cache_local: bool,
    ) -> Result<()> {
        if let Some(bytes) = self.store.read_cached_blob(&blob.hash)? {
            fs::write(path, bytes).map_err(|err| {
                SyncularError::storage(err).context(format!("write blob file {path:?}"))
            })?;
            return Ok(());
        }

        if cache_local {
            let bytes = self.transport.download_blob(blob)?;
            self.store.cache_blob_bytes(blob, &bytes)?;
            fs::write(path, bytes).map_err(|err| {
                SyncularError::storage(err).context(format!("write blob file {path:?}"))
            })?;
        } else {
            self.transport.download_blob_to_file(blob, path)?;
        }
        Ok(())
    }

    pub fn process_blob_upload_queue(
        &mut self,
    ) -> Result<crate::diesel_sqlite::BlobUploadQueueResult> {
        self.store.requeue_stale_blob_uploads()?;
        let pending = self.store.pending_blob_uploads(10)?;
        let mut result = crate::diesel_sqlite::BlobUploadQueueResult {
            uploaded: 0,
            failed: 0,
        };
        for item in pending {
            let next_attempt_count = item.attempt_count + 1;
            self.store
                .mark_blob_uploading(&item.hash, next_attempt_count)?;
            let blob = BlobRef {
                hash: item.hash.clone(),
                size: item.size,
                mime_type: item.mime_type.clone(),
                encrypted: false,
                key_id: None,
            };
            match self.transport.upload_blob(&blob, &item.body) {
                Ok(()) => {
                    self.store.delete_blob_upload(&item.hash)?;
                    result.uploaded += 1;
                }
                Err(error) => {
                    let failed = next_attempt_count >= MAX_BLOB_UPLOAD_RETRIES;
                    let now = now_ms();
                    self.store.mark_blob_upload_error(
                        &item.hash,
                        if failed { "failed" } else { "pending" },
                        &error.to_string(),
                        if failed {
                            0
                        } else {
                            next_retry_at(now, next_attempt_count)
                        },
                    )?;
                    if failed {
                        result.failed += 1;
                    }
                }
            }
        }
        Ok(result)
    }
}

#[cfg(feature = "native")]
impl<T> SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    pub fn store_blob_file_local_json(
        &mut self,
        path: &Path,
        mime_type: &str,
        enqueue_upload: bool,
    ) -> Result<String> {
        let data = fs::read(path).map_err(|err| {
            SyncularError::storage(err).context(format!("read blob file {path:?}"))
        })?;
        let blob = self
            .store
            .store_blob_bytes(&data, mime_type, enqueue_upload)?;
        Ok(serde_json::to_string(&blob)?)
    }

    pub fn retrieve_cached_blob_file_json(
        &mut self,
        blob: &BlobRef,
        path: &Path,
    ) -> Result<String> {
        let Some(bytes) = self.store.read_cached_blob(&blob.hash)? else {
            return Err(SyncularError::config(
                "blob is not present in the local cache",
            ));
        };
        fs::write(path, bytes).map_err(|err| {
            SyncularError::storage(err).context(format!("write blob file {path:?}"))
        })?;
        Ok(serde_json::to_string(&json!({ "ok": true }))?)
    }

    pub fn is_blob_local(&mut self, hash: &str) -> Result<bool> {
        self.store.is_blob_local(hash)
    }

    pub fn blob_upload_queue_stats(
        &mut self,
    ) -> Result<crate::diesel_sqlite::BlobUploadQueueStats> {
        self.store.blob_upload_queue_stats()
    }

    pub fn blob_cache_stats(&mut self) -> Result<crate::diesel_sqlite::BlobCacheStats> {
        self.store.blob_cache_stats()
    }

    pub fn prune_blob_cache(&mut self, max_bytes: i64) -> Result<i64> {
        self.store.prune_blob_cache(max_bytes)
    }

    pub fn clear_blob_cache(&mut self) -> Result<()> {
        self.store.clear_blob_cache()
    }

    pub fn compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        self.store.compact_storage_json(options_json)
    }

    pub fn readonly_query_json(&self, request_json: &str) -> Result<String> {
        crate::sqlite_query::execute_readonly_query_json_with_schema(
            &self.config.db_path,
            request_json,
            self.app_schema,
        )
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    fn prepare_sync(&mut self) -> Result<Vec<OutboxCommit>> {
        self.store.transaction(|tx| {
            tx.requeue_stale_outbox()?;
            let pending = tx.pending_outbox(20)?;
            for commit in &pending {
                validate_outbox_schema_version(commit, self.schema_version)?;
            }
            for commit in &pending {
                tx.mark_outbox_sending(&commit.id)?;
            }
            Ok(pending)
        })
    }

    fn build_pull_request(&mut self) -> Result<PullRequest> {
        let specs = self.subscriptions.clone();
        let snapshot_artifacts =
            self.store
                .supports_sqlite_snapshot_artifacts()
                .then(|| SnapshotArtifactsRequest {
                    schema_version: self.schema_version.to_string(),
                    artifact_kinds: vec![SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1.to_string()],
                    compressions: vec![SNAPSHOT_ARTIFACT_COMPRESSION_NONE.to_string()],
                    feature_set: Vec::new(),
                });
        self.store.transaction(|tx| {
            let mut subscriptions = Vec::new();
            for spec in specs {
                let state = tx.subscription_state(DEFAULT_STATE_ID, &spec.id)?;
                let scopes_changed = state
                    .as_ref()
                    .map(|row| {
                        let scopes: ScopeValues = serde_json::from_str(&row.scopes_json)?;
                        Ok::<bool, SyncularError>(scopes != spec.scopes)
                    })
                    .transpose()?
                    .unwrap_or(false);
                let verified_root = if scopes_changed {
                    None
                } else {
                    tx.verified_root(DEFAULT_STATE_ID, &spec.id)?
                        .map(|root| root.root)
                };
                subscriptions.push(SubscriptionRequest {
                    id: spec.id,
                    table: spec.table,
                    scopes: spec.scopes,
                    params: spec.params,
                    cursor: if scopes_changed {
                        -1
                    } else {
                        state.as_ref().map(|row| row.cursor).unwrap_or(-1)
                    },
                    bootstrap_state: if scopes_changed {
                        None
                    } else {
                        state
                            .and_then(|row| row.bootstrap_state_json)
                            .map(|json| serde_json::from_str(&json))
                            .transpose()?
                    },
                    verified_root,
                });
            }

            Ok(PullRequest {
                limit_commits: 1000,
                limit_snapshot_rows: 50_000,
                max_snapshot_pages: 10,
                dedupe_rows: None,
                snapshot_encodings: vec![SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1.to_string()],
                snapshot_artifacts,
                sync_pack_encodings: vec![SYNC_PACK_ENCODING_BINARY_V1.to_string()],
                subscriptions,
            })
        })
    }

    fn sync_pack_encodings(&self) -> Vec<String> {
        vec![SYNC_PACK_ENCODING_BINARY_V1.to_string()]
    }

    fn build_push_request(&self, pending: &[OutboxCommit]) -> Result<Option<PushBatchRequest>> {
        if pending.is_empty() {
            return Ok(None);
        }

        let ctx = self.encryption_context();
        Ok(Some(PushBatchRequest {
            commits: pending
                .iter()
                .map(|commit| {
                    let operations: Vec<SyncOperation> =
                        serde_json::from_str(&commit.operations_json)?;
                    let operations = if let Some(encryption) = &self.field_encryption {
                        encryption.transform_operations_for_push(&ctx, operations)?
                    } else {
                        operations
                    };
                    Ok(PushCommitRequest {
                        client_commit_id: commit.client_commit_id.clone(),
                        operations,
                        schema_version: commit.schema_version,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        }))
    }

    fn operations_for_push(&self, commit: &OutboxCommit) -> Result<Vec<SyncOperation>> {
        let operations: Vec<SyncOperation> = serde_json::from_str(&commit.operations_json)?;
        if let Some(encryption) = &self.field_encryption {
            encryption.transform_operations_for_push(&self.encryption_context(), operations)
        } else {
            Ok(operations)
        }
    }

    fn transform_push_response(
        &self,
        outbox: &OutboxCommit,
        response: PushCommitResponse,
    ) -> Result<PushCommitResponse> {
        let Some(encryption) = &self.field_encryption else {
            return Ok(response);
        };
        let operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
        encryption.transform_push_response(&self.encryption_context(), &operations, response)
    }

    fn transform_pull_response(&self, response: PullResponse) -> Result<PullResponse> {
        let response = if let Some(encryption) = &self.field_encryption {
            encryption.transform_pull_response(&self.encryption_context(), response)?
        } else {
            response
        };
        if let Some(encryption) = &self.encrypted_crdt {
            encryption.transform_pull_response(response)
        } else {
            Ok(response)
        }
    }

    fn transform_snapshot_row(&self, snapshot_table: &str, row: Value) -> Result<Value> {
        if let Some(encryption) = &self.field_encryption {
            encryption.transform_snapshot_row(&self.encryption_context(), snapshot_table, row)
        } else {
            Ok(row)
        }
    }

    fn transform_snapshot_chunk_rows(
        &self,
        snapshot_table: &str,
        rows: SnapshotChunkRows,
    ) -> Result<SnapshotChunkRows> {
        if self.field_encryption.is_none() {
            return Ok(rows);
        }
        rows.try_into_value_rows()?
            .into_iter()
            .map(|row| self.transform_snapshot_row(snapshot_table, row))
            .collect::<Result<Vec<_>>>()
            .map(SnapshotChunkRows::Json)
    }

    fn encryption_context(&self) -> FieldEncryptionContext {
        FieldEncryptionContext {
            actor_id: self.config.actor_id.clone(),
            client_id: self.config.client_id.clone(),
        }
    }

    fn apply_single_push_response(
        &mut self,
        outbox: &OutboxCommit,
        response: PushCommitResponse,
    ) -> Result<SyncReport> {
        let response = self.transform_push_response(outbox, response)?;
        self.store.transaction(|tx| {
            let conflicts_changed = apply_push_commit_response(tx, outbox, &response)?;
            Ok(SyncReport {
                changed_tables: Vec::new(),
                changed_rows: Vec::new(),
                conflicts_changed,
            })
        })
    }

    fn apply_combined_response(
        &mut self,
        pending: &[OutboxCommit],
        response: CombinedResponse,
    ) -> Result<SyncReport> {
        if let Err(error) = validate_server_schema_version(&response, self.schema_version) {
            self.schedule_outbox_retry(pending, &error)?;
            return Err(error);
        }

        if !response.ok {
            let error = SyncularError::protocol_message("combined sync response was not ok");
            self.schedule_outbox_retry(pending, &error)?;
            return Err(error);
        }

        let mut report = SyncReport::default();
        if let Some(push) = response.push {
            if !push.ok {
                let error = SyncularError::protocol_message("push response was not ok");
                self.schedule_outbox_retry(pending, &error)?;
                return Err(error);
            }

            let mut transformed_commits = Vec::new();
            for commit_response in push.commits {
                let Some(index) = pending
                    .iter()
                    .position(|row| row.client_commit_id == commit_response.client_commit_id)
                else {
                    continue;
                };
                let commit_response =
                    self.transform_push_response(&pending[index], commit_response)?;
                transformed_commits.push((index, commit_response));
            }

            report.conflicts_changed |= self.store.transaction(|tx| {
                let mut conflicts_changed = false;
                for (index, commit_response) in transformed_commits {
                    let outbox = &pending[index];
                    conflicts_changed |= apply_push_commit_response(tx, outbox, &commit_response)?;
                }
                Ok(conflicts_changed)
            })?;
        }

        if let Some(pull) = response.pull {
            report.merge(self.apply_pull_until_settled(pull)?);
        }

        Ok(report)
    }

    fn apply_pull_until_settled(&mut self, mut response: PullResponse) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        for round in 0..MAX_PULL_ROUNDS {
            if !response.ok {
                return Err(SyncularError::protocol_message("pull response was not ok"));
            }

            let transformed_response = self.transform_pull_response(response)?;
            let needs_more = pull_response_needs_another_round(&transformed_response, 50);
            report.merge(self.apply_pull_response(transformed_response)?);

            if !needs_more {
                return Ok(report);
            }

            if round + 1 == MAX_PULL_ROUNDS {
                return Ok(report);
            }

            let request = CombinedRequest {
                client_id: self.config.client_id.clone(),
                sync_pack_encodings: self.sync_pack_encodings(),
                push: None,
                pull: Some(self.build_pull_request()?),
            };
            let combined = self.transport.post_sync(&request)?;
            validate_server_schema_version(&combined, self.schema_version)?;
            response = combined.pull.unwrap_or(PullResponse {
                ok: true,
                subscriptions: Vec::new(),
            });
        }

        Ok(report)
    }

    fn apply_pull_response(&mut self, response: PullResponse) -> Result<SyncReport> {
        validate_pull_commit_integrity_metadata(&response)?;
        validate_pull_snapshot_manifests(&response)?;
        let mut report = SyncReport::default();
        for sub in response.subscriptions {
            if sub.status == "revoked" {
                self.store.transaction(|tx| {
                    if let Some(prev) = tx.subscription_state(DEFAULT_STATE_ID, &sub.id)? {
                        let scopes: ScopeValues = serde_json::from_str(&prev.scopes_json)?;
                        tx.clear_table_for_scopes(&prev.table, &scopes)?;
                        report.add_changed_table(&prev.table);
                    }
                    tx.delete_verified_root(DEFAULT_STATE_ID, &sub.id)?;
                    tx.delete_subscription_state(DEFAULT_STATE_ID, &sub.id)
                })?;
                continue;
            }
            let spec = self
                .subscriptions
                .iter()
                .find(|candidate| candidate.id == sub.id);
            let table = spec
                .map(|spec| spec.table.clone())
                .unwrap_or_else(|| "tasks".to_string());
            let params_json = spec
                .map(|spec| serde_json::to_string(&spec.params))
                .transpose()?
                .unwrap_or_else(|| "{}".to_string());

            let mut prepared_snapshots = Vec::new();
            if let Some(snapshots) = sub.snapshots.as_ref() {
                for snapshot in snapshots {
                    let mut artifact_rows = Vec::new();
                    if let Some(artifacts) = &snapshot.artifacts {
                        if !artifacts.is_empty() && !self.store.supports_sqlite_snapshot_artifacts()
                        {
                            return Err(SyncularError::protocol_message(
                                "snapshot artifacts are not supported by this store",
                            ));
                        }
                        for artifact in artifacts {
                            validate_sqlite_snapshot_artifact_for_apply(
                                artifact,
                                &sub.id,
                                &snapshot.table,
                            )?;
                            let bytes = self
                                .transport
                                .fetch_snapshot_artifact_bytes(artifact, &sub.scopes)?;
                            let rows = self
                                .store
                                .decode_sqlite_snapshot_artifact_rows(&snapshot.table, &bytes)?;
                            for row in rows {
                                artifact_rows
                                    .push(self.transform_snapshot_row(&snapshot.table, row)?);
                            }
                        }
                    }
                    let mut chunk_batches = Vec::new();
                    if let Some(chunks) = &snapshot.chunks {
                        for chunk in chunks {
                            let rows = self
                                .transport
                                .fetch_snapshot_chunk_rows(chunk, &sub.scopes)?;
                            chunk_batches
                                .push(self.transform_snapshot_chunk_rows(&snapshot.table, rows)?);
                        }
                    }
                    if snapshot.is_first_page
                        || !snapshot.rows.is_empty()
                        || !artifact_rows.is_empty()
                        || chunk_batches.iter().any(|rows| !rows.is_empty())
                    {
                        report.add_changed_table(&snapshot.table);
                    }
                    prepared_snapshots.push(PreparedSnapshot {
                        snapshot: snapshot.clone(),
                        chunk_batches,
                        artifact_rows,
                    });
                }
            }

            self.store.transaction(|tx| {
                let previous_state = tx.subscription_state(DEFAULT_STATE_ID, &sub.id)?;
                let mut previous_scopes_match = false;
                if let Some(prev) = &previous_state {
                    let previous_scopes: ScopeValues = serde_json::from_str(&prev.scopes_json)?;
                    if previous_scopes != sub.scopes {
                        tx.clear_table_for_scopes(&prev.table, &previous_scopes)?;
                        tx.delete_verified_root(DEFAULT_STATE_ID, &sub.id)?;
                        report.add_changed_table(&prev.table);
                    } else {
                        previous_scopes_match = true;
                    }
                }

                let stored_root = tx.verified_root(DEFAULT_STATE_ID, &sub.id)?;
                let verified_root = verify_subscription_commit_integrity(
                    &sub.id,
                    stored_root.as_ref().map(|root| root.root.as_str()),
                    sub.integrity.as_ref(),
                    &sub.commits,
                )?;

                let mut snapshot_cleared_tables = HashSet::new();
                if let Some(prev) = previous_state.as_ref() {
                    if prev.bootstrap_state_json.is_some()
                        && previous_scopes_match
                        && snapshot_clear_removes_all_rows(self.app_schema, &prev.table)
                    {
                        snapshot_cleared_tables.insert(prev.table.clone());
                    }
                }
                for prepared in &prepared_snapshots {
                    let snapshot = &prepared.snapshot;
                    if snapshot.is_first_page {
                        tx.clear_table_for_scopes_preserving_local_crdt(
                            &snapshot.table,
                            &sub.scopes,
                        )?;
                        if snapshot_clear_removes_all_rows(self.app_schema, &snapshot.table) {
                            snapshot_cleared_tables.insert(snapshot.table.clone());
                        }
                    }
                    if snapshot_cleared_tables.contains(&snapshot.table) {
                        tx.upsert_rows(&snapshot.table, &snapshot.rows, None)?;
                        for row in &snapshot.rows {
                            if let Some(changed_row) = sync_changed_row_for_snapshot(
                                self.app_schema,
                                &snapshot.table,
                                row,
                                None,
                                &sub.id,
                            ) {
                                report.add_changed_row(changed_row);
                            }
                        }

                        tx.upsert_rows(&snapshot.table, &prepared.artifact_rows, None)?;
                        for row in &prepared.artifact_rows {
                            if let Some(changed_row) = sync_changed_row_for_snapshot(
                                self.app_schema,
                                &snapshot.table,
                                row,
                                None,
                                &sub.id,
                            ) {
                                report.add_changed_row(changed_row);
                            }
                        }

                        for chunk_rows in &prepared.chunk_batches {
                            tx.upsert_snapshot_chunk_rows(&snapshot.table, chunk_rows, None)?;
                            for changed_row in sync_changed_rows_for_cleared_snapshot_chunk(
                                self.app_schema,
                                &snapshot.table,
                                chunk_rows,
                                &sub.id,
                            ) {
                                report.add_changed_row(changed_row);
                            }
                        }
                    } else {
                        for row in snapshot.rows.iter().chain(prepared.artifact_rows.iter()) {
                            let previous_row =
                                row_id_for_metadata(self.app_schema, &snapshot.table, row)
                                    .map(|row_id| tx.current_row_json(&snapshot.table, &row_id))
                                    .transpose()?
                                    .flatten();
                            tx.upsert_row(&snapshot.table, row, None)?;
                            if let Some(changed_row) = sync_changed_row_for_snapshot(
                                self.app_schema,
                                &snapshot.table,
                                row,
                                previous_row.as_ref(),
                                &sub.id,
                            ) {
                                report.add_changed_row(changed_row);
                            }
                        }
                        for chunk_rows in &prepared.chunk_batches {
                            let chunk_rows = chunk_rows.clone().try_into_value_rows()?;
                            for row in &chunk_rows {
                                let previous_row =
                                    row_id_for_metadata(self.app_schema, &snapshot.table, row)
                                        .map(|row_id| tx.current_row_json(&snapshot.table, &row_id))
                                        .transpose()?
                                        .flatten();
                                tx.upsert_row(&snapshot.table, row, None)?;
                                if let Some(changed_row) = sync_changed_row_for_snapshot(
                                    self.app_schema,
                                    &snapshot.table,
                                    row,
                                    previous_row.as_ref(),
                                    &sub.id,
                                ) {
                                    report.add_changed_row(changed_row);
                                }
                            }
                        }
                    }
                }

                for commit in &sub.commits {
                    for change in &commit.changes {
                        let previous_row = tx.current_row_json(&change.table, &change.row_id)?;
                        tx.apply_change(change)?;
                        if let Some(changed_row) = sync_changed_row_for_change(
                            self.app_schema,
                            change,
                            previous_row.as_ref(),
                            commit.commit_seq,
                            &sub.id,
                        ) {
                            report.add_changed_row(changed_row);
                        } else {
                            report.add_changed_table(&change.table);
                        }
                    }
                }

                tx.upsert_subscription_state(&SubscriptionState {
                    state_id: DEFAULT_STATE_ID.to_string(),
                    subscription_id: sub.id.clone(),
                    table: table.clone(),
                    scopes_json: serde_json::to_string(&sub.scopes)?,
                    params_json,
                    cursor: sub.next_cursor,
                    bootstrap_state_json: sub
                        .bootstrap_state
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    status: sub.status.clone(),
                })?;
                if let Some(root) = verified_root {
                    tx.upsert_verified_root(&VerifiedRoot {
                        state_id: DEFAULT_STATE_ID.to_string(),
                        subscription_id: sub.id.clone(),
                        partition_id: root.partition_id,
                        commit_seq: root.commit_seq,
                        root: root.root,
                    })?;
                }

                Ok(())
            })?;
        }

        Ok(report)
    }

    fn schedule_outbox_retry(
        &mut self,
        pending: &[OutboxCommit],
        error: &SyncularError,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }

        let now = now_ms();
        let message = error.to_string();
        let auth_error = is_auth_transport_error(error);
        self.store.transaction(|tx| {
            for commit in pending {
                let attempt_count = commit.attempt_count.saturating_add(1);
                let failed = attempt_count >= MAX_SYNC_RETRIES;
                let next_attempt_at = if failed || auth_error {
                    0
                } else {
                    next_retry_at(now, attempt_count)
                };
                tx.mark_outbox_retry(&commit.id, &message, next_attempt_at, failed)?;
            }
            Ok(())
        })
    }
}

#[cfg(feature = "demo-todo-native-fixture")]
impl<T> SyncularClient<RusqliteStore, T>
where
    T: SyncTransport,
{
    pub fn list_table_json(&mut self, table: &str) -> Result<String> {
        Ok(serde_json::to_string(&self.store.list_table_json(table)?)?)
    }

    pub fn apply_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(mutation_json)?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        self.store.apply_local_operation(operation, local_row)
    }

    pub fn apply_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<MutationReceipt> {
        let _request: EncryptedCrdtUpdateJsonRequest = serde_json::from_str(request_json)?;
        Err(SyncularError::config(
            "encrypted CRDT update JSON is not supported by RusqliteStore",
        ))
    }

    pub fn apply_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<MutationReceipt>> {
        let _request: EncryptedCrdtCheckpointJsonRequest = serde_json::from_str(request_json)?;
        Err(SyncularError::config(
            "encrypted CRDT checkpoint JSON is not supported by RusqliteStore",
        ))
    }
}

#[cfg(feature = "native")]
impl<T> SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    pub fn read<'query, Q, Row>(&mut self, query: Q) -> Result<Vec<Row>>
    where
        Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        self.store.read(query)
    }

    pub fn live_query<QF, Q, Row, I, Table>(
        &mut self,
        tables: I,
        build_query: QF,
    ) -> Result<SyncularLiveQuery<QF, Row>>
    where
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        let mut live_query = SyncularLiveQuery::new(tables, build_query);
        live_query.refresh(self)?;
        Ok(live_query)
    }

    pub fn apply<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation,
    {
        self.apply_mutation(mutation)
    }

    pub fn apply_mutation_batch(
        &mut self,
        batch: SyncularMutationBatch,
    ) -> Result<MutationReceipt> {
        <Self as SyncularMutationExecutor>::apply_mutation_batch(self, batch)
    }

    pub fn commit_mutations<R>(
        &mut self,
        f: impl FnOnce(&mut SyncularMutationBatch) -> Result<R>,
    ) -> Result<MutationCommit<R>> {
        let mut batch = SyncularMutationBatch::new();
        let result = f(&mut batch)?;
        let commit = self.apply_mutation_batch(batch)?;
        Ok(MutationCommit { result, commit })
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<String> {
        Ok(serde_json::to_string(&self.store.list_table_json(table)?)?)
    }

    pub fn apply_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(mutation_json)?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        self.store.apply_local_operation(operation, local_row)
    }

    pub fn apply_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<MutationReceipt> {
        let request: EncryptedCrdtUpdateJsonRequest = serde_json::from_str(request_json)?;
        let (metadata, field) =
            self.encrypted_crdt_metadata_field(&request.table, &request.field)?;
        match (request.next_text, request.update) {
            (Some(next_text), None) => {
                self.apply_encrypted_crdt_text_update(metadata, field, &request.row_id, &next_text)
            }
            (None, Some(update)) => {
                self.apply_encrypted_crdt_yjs_update(metadata, field, &request.row_id, update)
            }
            (Some(_), Some(_)) => Err(SyncularError::config(
                "encrypted CRDT update JSON must provide either nextText or update, not both",
            )),
            (None, None) => Err(SyncularError::config(
                "encrypted CRDT update JSON requires nextText or update",
            )),
        }
    }

    pub fn apply_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<MutationReceipt>> {
        let request: EncryptedCrdtCheckpointJsonRequest = serde_json::from_str(request_json)?;
        let (metadata, field) =
            self.encrypted_crdt_metadata_field(&request.table, &request.field)?;
        self.apply_encrypted_crdt_checkpoint(
            metadata,
            field,
            &request.row_id,
            request.min_uncheckpointed_updates.unwrap_or(1),
        )
    }

    pub fn open_crdt_field(&self, id: CrdtFieldId) -> Result<CrdtField> {
        let field = validate_crdt_field(self.app_schema, &id)?;
        if field.sync_mode() == CrdtFieldSyncMode::EncryptedUpdateLog
            && self.encrypted_crdt.is_none()
        {
            return Err(SyncularError::config(
                "encrypted CRDT fields require set_encrypted_crdt(...)",
            ));
        }
        Ok(field)
    }

    pub fn apply_crdt_field_yjs_update(
        &mut self,
        field: &CrdtField,
        update: YjsUpdateEnvelope,
    ) -> Result<CrdtFieldWriteReceipt> {
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                let client_commit_id = self.store.apply_crdt_field_yjs_update(
                    field,
                    update,
                    DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY,
                )?;
                Ok(CrdtFieldWriteReceipt {
                    client_commit_id,
                    sync_mode: field.sync_mode(),
                })
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let receipt = self.apply_encrypted_crdt_yjs_update(
                    field.metadata(),
                    field.field(),
                    field.row_id(),
                    update,
                )?;
                Ok(CrdtFieldWriteReceipt {
                    client_commit_id: receipt.client_commit_id,
                    sync_mode: field.sync_mode(),
                })
            }
        }
    }

    pub fn apply_crdt_field_yjs_update_with_queue_capacity(
        &mut self,
        field: &CrdtField,
        update: YjsUpdateEnvelope,
        max_pending_updates: i64,
    ) -> Result<CrdtFieldWriteReceipt> {
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                let client_commit_id =
                    self.store
                        .apply_crdt_field_yjs_update(field, update, max_pending_updates)?;
                Ok(CrdtFieldWriteReceipt {
                    client_commit_id,
                    sync_mode: field.sync_mode(),
                })
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                self.apply_crdt_field_yjs_update(field, update)
            }
        }
    }

    pub fn apply_crdt_field_text(
        &mut self,
        field: &CrdtField,
        next_text: &str,
    ) -> Result<CrdtFieldWriteReceipt> {
        if field.field_metadata().kind != "text" {
            return Err(SyncularError::config(format!(
                "apply_crdt_field_text requires a text CRDT field, got {}",
                field.field_metadata().kind
            )));
        }
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                let current_row = self.store.read_row_json(field.table(), field.row_id())?;
                let previous_state_base64 = current_row.as_ref().and_then(|row| {
                    row.get(field.state_column())
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                });
                if previous_state_base64.is_none() {
                    if let Some(existing_text) = current_row
                        .as_ref()
                        .and_then(|row| row.get(field.field()))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty() && *value != next_text)
                    {
                        return Err(SyncularError::config(format!(
                            "cannot replace non-empty CRDT text field {}.{} row {} without existing Yjs state; migrate or initialize {} first (current value: {existing_text:?})",
                            field.table(),
                            field.field(),
                            field.row_id(),
                            field.state_column()
                        )));
                    }
                }
                let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
                    previous_state_base64,
                    next_text: next_text.to_string(),
                    container_key: Some(field.container_key().to_string()),
                    update_id: None,
                })?;
                self.apply_crdt_field_yjs_update(field, update.update)
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let receipt = self.apply_encrypted_crdt_text_update(
                    field.metadata(),
                    field.field(),
                    field.row_id(),
                    next_text,
                )?;
                Ok(CrdtFieldWriteReceipt {
                    client_commit_id: receipt.client_commit_id,
                    sync_mode: field.sync_mode(),
                })
            }
        }
    }

    pub fn materialize_crdt_field(
        &mut self,
        field: &CrdtField,
    ) -> Result<CrdtFieldMaterialization> {
        let row = self
            .store
            .read_row_json(field.table(), field.row_id())?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot materialize CRDT field {}.{} for missing row {}",
                    field.table(),
                    field.field(),
                    field.row_id()
                ))
            })?;
        let state_base64 = row
            .get(field.state_column())
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let value = match state_base64.as_deref() {
            Some(state_base64) => materialize_yjs_state(state_base64, &field.yjs_rule()?)?,
            None => row.get(field.field()).cloned().unwrap_or(Value::Null),
        };
        let state_vector_base64 = yjs_state_vector_base64(state_base64.as_deref())?;
        Ok(CrdtFieldMaterialization {
            value,
            state_base64,
            state_vector_base64,
        })
    }

    pub fn materialize_crdt_field_json(&mut self, field: &CrdtField) -> Result<String> {
        Ok(serde_json::to_string(&self.materialize_crdt_field(field)?)?)
    }

    pub fn crdt_document_snapshot(&mut self, field: &CrdtField) -> Result<CrdtDocumentSnapshot> {
        self.store.crdt_document_snapshot(field)
    }

    pub fn crdt_document_snapshot_json(&mut self, field: &CrdtField) -> Result<String> {
        Ok(serde_json::to_string(&self.crdt_document_snapshot(field)?)?)
    }

    pub fn crdt_update_log(
        &mut self,
        field: &CrdtField,
        limit: i64,
    ) -> Result<Vec<CrdtUpdateLogEntry>> {
        self.store.crdt_update_log(field, limit)
    }

    pub fn crdt_update_log_json(&mut self, field: &CrdtField, limit: i64) -> Result<String> {
        Ok(serde_json::to_string(&self.crdt_update_log(field, limit)?)?)
    }

    pub fn snapshot_crdt_field_state_vector_base64(&mut self, field: &CrdtField) -> Result<String> {
        let row = self.store.read_row_json(field.table(), field.row_id())?;
        let state_base64 = row.as_ref().and_then(|row| {
            row.get(field.state_column())
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
        yjs_state_vector_base64(state_base64)
    }

    pub fn compact_crdt_field(
        &mut self,
        field: &CrdtField,
        min_uncheckpointed_updates: i64,
    ) -> Result<CrdtFieldCompactionReceipt> {
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                self.store.compact_crdt_document(field)?;
                Ok(CrdtFieldCompactionReceipt {
                    checkpoint_created: false,
                    client_commit_id: None,
                })
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let receipt = self.apply_encrypted_crdt_checkpoint(
                    field.metadata(),
                    field.field(),
                    field.row_id(),
                    min_uncheckpointed_updates,
                )?;
                Ok(CrdtFieldCompactionReceipt {
                    checkpoint_created: receipt.is_some(),
                    client_commit_id: receipt.map(|receipt| receipt.client_commit_id),
                })
            }
        }
    }

    fn encrypted_crdt_metadata_field(
        &self,
        table: &str,
        field: &str,
    ) -> Result<(&'static AppTableMetadata, &'static str)> {
        let metadata = self.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        let field = encrypted_field_metadata(metadata, field)?.field;
        Ok((metadata, field))
    }
}

#[cfg(feature = "native")]
impl<T> SyncularMutationExecutor for SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_mutation<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation,
    {
        self.store
            .apply_syncular_mutations(vec![mutation.into_syncular_mutation()])
    }

    fn apply_mutation_batch(&mut self, batch: SyncularMutationBatch) -> Result<MutationReceipt> {
        self.store.apply_syncular_mutations(batch.into_mutations())
    }
}

#[cfg(feature = "native")]
impl<T> SyncularEncryptedCrdtMutationExecutor for SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_encrypted_crdt_text_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        next_text: &str,
    ) -> Result<MutationReceipt> {
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT updates require set_encrypted_crdt(...)",
            ));
        };
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot update encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_text_update_mutation(BuildEncryptedCrdtTextUpdateArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            next_text,
        })?;
        self.store.apply_syncular_mutations(vec![mutation])
    }

    fn apply_encrypted_crdt_yjs_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        update: YjsUpdateEnvelope,
    ) -> Result<MutationReceipt> {
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT updates require set_encrypted_crdt(...)",
            ));
        };
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot update encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_yjs_update_mutation(BuildEncryptedCrdtYjsUpdateArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            update,
        })?;
        self.store.apply_syncular_mutations(vec![mutation])
    }

    fn apply_encrypted_crdt_checkpoint(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        min_uncheckpointed_updates: i64,
    ) -> Result<Option<MutationReceipt>> {
        if min_uncheckpointed_updates < 1 {
            return Err(SyncularError::config(
                "encrypted CRDT checkpoint threshold must be at least 1",
            ));
        }
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT checkpoints require set_encrypted_crdt(...)",
            ));
        };
        let stream_id = encrypted_crdt_stream_id(metadata.name, row_id, field);
        let stats = self
            .store
            .encrypted_crdt_stream_stats(encryption.partition_id(), &stream_id)?;
        if stats.checkpointable_update_count < min_uncheckpointed_updates {
            return Ok(None);
        }
        let Some(covers_seq) = stats.max_server_seq else {
            return Ok(None);
        };
        if stats
            .latest_checkpoint_covers_seq
            .is_some_and(|latest| latest >= covers_seq)
        {
            return Ok(None);
        }
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot checkpoint encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_checkpoint_mutation(BuildEncryptedCrdtCheckpointArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            covers_seq,
        })?;
        Ok(Some(self.store.apply_syncular_mutations(vec![mutation])?))
    }
}

struct SyncLockGuard {
    key: String,
}

impl SyncLockGuard {
    fn acquire(key: &str) -> Result<Self> {
        let locks = ACTIVE_SYNC_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = locks
            .lock()
            .map_err(|_| SyncularError::busy("sync lock is poisoned"))?;
        if !active.insert(key.to_string()) {
            return Err(SyncularError::busy(format!(
                "sync already active for local database {key}"
            )));
        }
        Ok(Self {
            key: key.to_string(),
        })
    }
}

impl Drop for SyncLockGuard {
    fn drop(&mut self) {
        if let Some(locks) = ACTIVE_SYNC_KEYS.get() {
            if let Ok(mut active) = locks.lock() {
                active.remove(&self.key);
            }
        }
    }
}

fn pull_response_needs_another_round(response: &PullResponse, limit_commits: i64) -> bool {
    let mut total_commits = 0usize;
    for sub in &response.subscriptions {
        if sub.status != "active" {
            continue;
        }
        if sub.bootstrap_state.is_some() {
            return true;
        }
        total_commits += sub.commits.len();
    }
    total_commits >= limit_commits as usize
}

#[cfg(feature = "demo-todo-fixture")]
impl<S, T> SyncularClient<S, T>
where
    S: SyncStore + DemoTaskStore,
    T: SyncTransport,
{
    pub fn add_task(&mut self, title: String, id: Option<String>) -> Result<String> {
        let task_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        self.store.add_task(
            &self.config.actor_id,
            self.config.project_id.as_deref(),
            task_id.clone(),
            title,
        )?;
        Ok(task_id)
    }

    pub fn patch_task_title(&mut self, id: String, title: String) -> Result<()> {
        self.store
            .patch_task_title(self.config.project_id.as_deref(), id, title)
    }

    pub fn list_tasks(&mut self) -> Result<Vec<Task>> {
        self.store.list_tasks()
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    pub fn applied_migrations(&mut self) -> Result<Vec<crate::store::AppliedMigration>> {
        self.store.applied_migrations()
    }

    pub fn outbox_summaries(&mut self) -> Result<Vec<crate::store::OutboxSummary>> {
        self.store.outbox_summaries()
    }

    pub fn conflict_summaries(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.store.conflict_summaries()
    }

    pub fn conflicts(&mut self) -> SyncularConflicts<'_, S, T> {
        SyncularConflicts { client: self }
    }

    pub fn pending_conflicts(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.conflict_summaries()
    }

    pub fn has_pending_conflicts(&mut self) -> Result<bool> {
        Ok(!self.pending_conflicts()?.is_empty())
    }

    pub fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.store.resolve_conflict(id, resolution)
    }

    pub fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        self.store.retry_conflict_keep_local(id)
    }
}

impl<'a, S, T> SyncularConflicts<'a, S, T>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    pub fn pending(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.client.store.conflict_summaries()
    }

    pub fn is_empty(&mut self) -> Result<bool> {
        Ok(self.pending()?.is_empty())
    }

    pub fn keep_local(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        let retry_client_commit_id = self.client.store.retry_conflict_keep_local(conflict_id)?;
        Ok(ConflictResolutionReceipt {
            conflict_id: conflict_id.to_string(),
            resolution: ConflictResolution::KeepLocal,
            retry_client_commit_id: Some(retry_client_commit_id),
        })
    }

    pub fn accept_server(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        self.resolve(conflict_id, ConflictResolution::AcceptServer)
    }

    pub fn dismiss(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        self.resolve(conflict_id, ConflictResolution::Dismiss)
    }

    pub fn resolve(
        &mut self,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> Result<ConflictResolutionReceipt> {
        if resolution == ConflictResolution::KeepLocal {
            return self.keep_local(conflict_id);
        }

        self.client
            .store
            .resolve_conflict(conflict_id, resolution.as_str())?;
        Ok(ConflictResolutionReceipt {
            conflict_id: conflict_id.to_string(),
            resolution,
            retry_client_commit_id: None,
        })
    }
}

fn validate_outbox_schema_version(commit: &OutboxCommit, current: i32) -> Result<()> {
    if commit.schema_version < 1 {
        return Err(SyncularError::schema(format!(
            "outbox commit {} has invalid schema version {}",
            commit.client_commit_id, commit.schema_version
        )));
    }

    if commit.schema_version > current {
        return Err(SyncularError::schema(format!(
            "outbox commit {} was created with schema version {}, but this client supports {}",
            commit.client_commit_id, commit.schema_version, current
        )));
    }

    Ok(())
}

fn validate_server_schema_version(response: &CombinedResponse, current: i32) -> Result<()> {
    if let Some(required) = response.required_schema_version {
        if required < 1 {
            return Err(SyncularError::schema(format!(
                "server reported invalid required schema version {required}"
            )));
        }

        if required > current {
            return Err(SyncularError::schema(format!(
                "server requires schema version {required}, but this client supports {current}"
            )));
        }
    }

    if let Some(latest) = response.latest_schema_version {
        if latest < 1 {
            return Err(SyncularError::schema(format!(
                "server reported invalid latest schema version {latest}"
            )));
        }
    }

    Ok(())
}

fn apply_push_commit_response(
    tx: &mut impl SyncStoreTx,
    outbox: &OutboxCommit,
    response: &PushCommitResponse,
) -> Result<bool> {
    let mut conflicts_changed = false;
    match response.status.as_str() {
        "applied" | "cached" => {
            tx.mark_pushed_operation_server_versions(outbox, response)?;
            tx.mark_outbox_acked(&outbox.id, response)?;
        }
        _ => {
            for result in &response.results {
                if result.status == "conflict" || result.status == "error" {
                    tx.insert_conflict(outbox, result)?;
                    conflicts_changed = true;
                }
            }
            tx.mark_outbox_failed(&outbox.id, "REJECTED", response)?;
        }
    }
    Ok(conflicts_changed)
}

fn is_auth_transport_error(error: &SyncularError) -> bool {
    if error.kind() != ErrorKind::Transport {
        return false;
    }
    let message = error.message_text();
    message.contains("HTTP 401") || message.contains("HTTP 403")
}
