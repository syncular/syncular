use crate::app_schema::{
    checksum, default_app_schema, split_sql_statements, AppSchema, AppTableMetadata,
};
use crate::auth_lease_selection::{
    app_table_operation_scope,
    select_active_auth_lease_for_operations as select_auth_lease_for_operation_scopes,
    system_table_operation_scope, ActiveAuthLeasePolicy, MutationOperationScope,
};
use crate::binary_snapshot::{BinarySnapshotCell, DecodedBinarySnapshotRows, SnapshotChunkRows};
use crate::client::SubscriptionSpec;
use crate::command_history::{CommandHistoryEntry, CommandHistoryRecord, CommandHistoryState};
use crate::compaction::{
    required_compaction_cutoff, tombstone_delete_statements, StorageCompactionOptions,
    StorageCompactionReport,
};
use crate::crdt_field::{
    validate_crdt_field, CrdtDocumentSnapshot, CrdtField, CrdtFieldId, CrdtUpdateLogEntry,
    CrdtUpdateOrigin, CrdtUpdateStatus,
};
use crate::crdt_yjs::{
    materialize_row_for_metadata, transform_local_row_for_metadata, yjs_state_vector_base64,
    YjsUpdateEnvelope, YJS_PAYLOAD_KEY,
};
use crate::encrypted_crdt::{
    apply_encrypted_crdt_plaintext_to_row, encrypted_crdt_identity_column,
    encrypted_crdt_normalize_row, encrypted_crdt_row_matches_scopes, encrypted_crdt_scopes_json,
    is_encrypted_crdt_system_table, EncryptedCrdtStreamStats, CRDT_CHECKPOINTS_TABLE,
    CRDT_UPDATES_TABLE,
};
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "demo-todo-native-fixture")]
use crate::fixtures::todo::tasks::{insert_local_task, list_tasks, patch_local_task_title};
use crate::limits::validate_unresolved_outbox_capacity;
use crate::protocol::*;
use crate::protocol::{sync_operations_json_for_outbox, validate_pending_mutation_batch_size};
use crate::runtime_schema::RUNTIME_SYSTEM_SCHEMA_SQL;
use crate::schema;
use crate::store::{
    now_ms, AppSchemaState, AppliedMigration, AuthLeaseRecord, BlobHealthSummary, ConflictSummary,
    CrdtHealthSummary, OutboxCommit, OutboxSummary, ScopedRowsHealthSummary, ScopedRowsTableHealth,
    SubscriptionState, SyncStateStore, SyncStore, SyncStoreTx, VerifiedRoot, APP_SCHEMA_ID,
    BLOB_UPLOAD_STALE_TIMEOUT_MS, MAX_BLOB_UPLOAD_RETRIES, MAX_SYNC_RETRIES,
    SQLITE_BUSY_TIMEOUT_MS, SYNC_SENDING_TIMEOUT_MS,
};
#[cfg(feature = "demo-todo-fixture")]
use crate::store::{DemoTaskStore, Task};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Binary, Bool, Integer, Nullable, Text};
use diesel::sqlite::SqliteConnection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

const SNAPSHOT_UPSERT_BATCH_ROWS: usize = 128;

#[derive(Debug, Clone, Queryable, Selectable)]
#[diesel(table_name = schema::sync_outbox_commits)]
#[allow(dead_code)]
struct OutboxCommitRow {
    id: String,
    client_commit_id: String,
    status: String,
    operations_json: String,
    last_response_json: Option<String>,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    attempt_count: i32,
    acked_commit_seq: Option<i64>,
    schema_version: i32,
    next_attempt_at: i64,
    lease_id: Option<String>,
    lease_expires_at_ms: Option<i64>,
    lease_status_at_enqueue: Option<String>,
    lease_scope_summary_json: Option<String>,
    lease_token: Option<String>,
}

#[derive(Debug, Clone, QueryableByName)]
struct CommandHistoryRow {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    mutation_scope: String,
    #[diesel(sql_type = Text)]
    state: String,
    #[diesel(sql_type = Text)]
    entries_json: String,
    #[diesel(sql_type = Text)]
    client_commit_id: String,
    #[diesel(sql_type = Nullable<Text>)]
    undo_client_commit_id: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    redo_client_commit_id: Option<String>,
    #[diesel(sql_type = BigInt)]
    created_at: i64,
    #[diesel(sql_type = BigInt)]
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct PendingCommandHistoryEntry {
    table: String,
    row_id: String,
    before: Option<Value>,
}

impl TryFrom<CommandHistoryRow> for CommandHistoryRecord {
    type Error = SyncularError;

    fn try_from(row: CommandHistoryRow) -> Result<Self> {
        let entries =
            serde_json::from_str::<Vec<CommandHistoryEntry>>(&row.entries_json).map_err(|err| {
                SyncularError::storage(err).context("deserialize sync_command_history.entries_json")
            })?;
        Ok(Self {
            id: row.id,
            mutation_scope: row.mutation_scope,
            state: CommandHistoryState::try_from(row.state.as_str())?,
            entries,
            client_commit_id: row.client_commit_id,
            undo_client_commit_id: row.undo_client_commit_id,
            redo_client_commit_id: row.redo_client_commit_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

fn insert_command_history_record(
    conn: &mut SqliteConnection,
    mutation_scope: &str,
    entries: &[CommandHistoryEntry],
    receipt: &MutationReceipt,
) -> Result<CommandHistoryRecord> {
    let id = Uuid::new_v4().to_string();
    let entries_json = serde_json::to_string(entries)?;
    let created_at = now_ms();
    sql_query("delete from sync_command_history where state = 'undone'").execute(conn)?;
    sql_query(
        r#"
        insert into sync_command_history (
            id,
            mutation_scope,
            state,
            entries_json,
            client_commit_id,
            undo_client_commit_id,
            redo_client_commit_id,
            created_at,
            updated_at
        )
        values (?1, ?2, 'done', ?3, ?4, null, null, ?5, ?5)
        "#,
    )
    .bind::<Text, _>(&id)
    .bind::<Text, _>(mutation_scope)
    .bind::<Text, _>(&entries_json)
    .bind::<Text, _>(&receipt.client_commit_id)
    .bind::<BigInt, _>(created_at)
    .execute(conn)?;
    Ok(CommandHistoryRecord {
        id,
        mutation_scope: mutation_scope.to_string(),
        state: CommandHistoryState::Done,
        entries: entries.to_vec(),
        client_commit_id: receipt.client_commit_id.clone(),
        undo_client_commit_id: None,
        redo_client_commit_id: None,
        created_at,
        updated_at: created_at,
    })
}

#[derive(Debug, Clone, QueryableByName)]
struct CrdtDocumentSnapshotRow {
    #[diesel(sql_type = Text)]
    document_key: String,
    #[diesel(sql_type = Text)]
    app_table: String,
    #[diesel(sql_type = Text)]
    row_id: String,
    #[diesel(sql_type = Text)]
    field_name: String,
    #[diesel(sql_type = Text)]
    state_column: String,
    #[diesel(sql_type = Text)]
    sync_mode: String,
    #[diesel(sql_type = Nullable<Text>)]
    state_base64: Option<String>,
    #[diesel(sql_type = Text)]
    state_vector_base64: String,
    #[diesel(sql_type = BigInt)]
    pending_updates: i64,
    #[diesel(sql_type = BigInt)]
    flushed_updates: i64,
    #[diesel(sql_type = BigInt)]
    acked_updates: i64,
    #[diesel(sql_type = BigInt)]
    log_updates: i64,
    #[diesel(sql_type = BigInt)]
    updated_at: i64,
    #[diesel(sql_type = Nullable<BigInt>)]
    compacted_at: Option<i64>,
}

#[derive(Debug, Clone, QueryableByName)]
struct CrdtUpdateLogRow {
    #[diesel(sql_type = BigInt)]
    id: i64,
    #[diesel(sql_type = Text)]
    document_key: String,
    #[diesel(sql_type = Text)]
    update_id: String,
    #[diesel(sql_type = Nullable<Text>)]
    client_commit_id: Option<String>,
    #[diesel(sql_type = Text)]
    origin: String,
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = Text)]
    update_base64: String,
    #[diesel(sql_type = Text)]
    state_vector_base64: String,
    #[diesel(sql_type = BigInt)]
    created_at: i64,
    #[diesel(sql_type = Nullable<BigInt>)]
    flushed_at: Option<i64>,
    #[diesel(sql_type = Nullable<BigInt>)]
    acked_at: Option<i64>,
}

impl From<OutboxCommitRow> for OutboxCommit {
    fn from(row: OutboxCommitRow) -> Self {
        Self {
            id: row.id,
            client_commit_id: row.client_commit_id,
            status: row.status,
            operations_json: row.operations_json,
            last_response_json: row.last_response_json,
            error: row.error,
            created_at: row.created_at,
            updated_at: row.updated_at,
            attempt_count: row.attempt_count,
            acked_commit_seq: row.acked_commit_seq,
            schema_version: row.schema_version,
            next_attempt_at: row.next_attempt_at,
            auth_lease: auth_lease_provenance_from_columns(
                row.lease_id,
                row.lease_expires_at_ms,
                row.lease_status_at_enqueue,
                row.lease_scope_summary_json,
                row.lease_token,
            ),
        }
    }
}

fn auth_lease_provenance_from_columns(
    lease_id: Option<String>,
    lease_expires_at_ms: Option<i64>,
    lease_status_at_enqueue: Option<String>,
    lease_scope_summary_json: Option<String>,
    lease_token: Option<String>,
) -> Option<AuthLeaseProvenance> {
    Some(AuthLeaseProvenance {
        lease_id: lease_id?,
        lease_expires_at_ms: lease_expires_at_ms?,
        lease_status_at_enqueue: lease_status_at_enqueue?,
        lease_scope_summary_json,
        lease_token,
    })
}

impl TryFrom<CrdtDocumentSnapshotRow> for CrdtDocumentSnapshot {
    type Error = SyncularError;

    fn try_from(row: CrdtDocumentSnapshotRow) -> Result<Self> {
        Ok(Self {
            document_key: row.document_key,
            table: row.app_table,
            row_id: row.row_id,
            field: row.field_name,
            state_column: row.state_column,
            sync_mode: crdt_sync_mode_from_str(&row.sync_mode)?,
            state_base64: row.state_base64,
            state_vector_base64: row.state_vector_base64,
            pending_updates: row.pending_updates,
            flushed_updates: row.flushed_updates,
            acked_updates: row.acked_updates,
            log_updates: row.log_updates,
            updated_at: row.updated_at,
            compacted_at: row.compacted_at,
        })
    }
}

impl TryFrom<CrdtUpdateLogRow> for CrdtUpdateLogEntry {
    type Error = SyncularError;

    fn try_from(row: CrdtUpdateLogRow) -> Result<Self> {
        Ok(Self {
            id: row.id,
            document_key: row.document_key,
            update_id: row.update_id,
            client_commit_id: row.client_commit_id,
            origin: crdt_update_origin_from_str(&row.origin)?,
            status: crdt_update_status_from_str(&row.status)?,
            update_base64: row.update_base64,
            state_vector_base64: row.state_vector_base64,
            created_at: row.created_at,
            flushed_at: row.flushed_at,
            acked_at: row.acked_at,
        })
    }
}

#[derive(Insertable)]
#[diesel(table_name = schema::sync_outbox_commits)]
struct NewOutboxCommit {
    id: String,
    client_commit_id: String,
    status: String,
    operations_json: String,
    last_response_json: Option<String>,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    attempt_count: i32,
    acked_commit_seq: Option<i64>,
    schema_version: i32,
    next_attempt_at: i64,
    lease_id: Option<String>,
    lease_expires_at_ms: Option<i64>,
    lease_status_at_enqueue: Option<String>,
    lease_scope_summary_json: Option<String>,
    lease_token: Option<String>,
}

#[derive(Debug, Clone, Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = schema::sync_auth_leases)]
struct AuthLeaseRecordRow {
    lease_id: String,
    kid: String,
    actor_id: String,
    issued_at_ms: i64,
    not_before_ms: i64,
    expires_at_ms: i64,
    schema_version: i32,
    payload_json: String,
    token: String,
    status: String,
    last_validation_error: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl From<AuthLeaseRecordRow> for AuthLeaseRecord {
    fn from(row: AuthLeaseRecordRow) -> Self {
        Self {
            lease_id: row.lease_id,
            kid: row.kid,
            actor_id: row.actor_id,
            issued_at_ms: row.issued_at_ms,
            not_before_ms: row.not_before_ms,
            expires_at_ms: row.expires_at_ms,
            schema_version: row.schema_version,
            payload_json: row.payload_json,
            token: row.token,
            status: row.status,
            last_validation_error: row.last_validation_error,
            created_at_ms: row.created_at_ms,
            updated_at_ms: row.updated_at_ms,
        }
    }
}

impl From<&AuthLeaseRecord> for AuthLeaseRecordRow {
    fn from(record: &AuthLeaseRecord) -> Self {
        Self {
            lease_id: record.lease_id.clone(),
            kid: record.kid.clone(),
            actor_id: record.actor_id.clone(),
            issued_at_ms: record.issued_at_ms,
            not_before_ms: record.not_before_ms,
            expires_at_ms: record.expires_at_ms,
            schema_version: record.schema_version,
            payload_json: record.payload_json.clone(),
            token: record.token.clone(),
            status: record.status.clone(),
            last_validation_error: record.last_validation_error.clone(),
            created_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, Queryable, Selectable)]
#[diesel(table_name = schema::sync_subscription_state)]
#[allow(dead_code)]
struct SubscriptionStateRow {
    state_id: String,
    subscription_id: String,
    table_name: String,
    scopes_json: String,
    params_json: String,
    cursor: i64,
    bootstrap_state_json: Option<String>,
    status: String,
    created_at: i64,
    updated_at: i64,
}

impl From<SubscriptionStateRow> for SubscriptionState {
    fn from(row: SubscriptionStateRow) -> Self {
        Self {
            state_id: row.state_id,
            subscription_id: row.subscription_id,
            table: row.table_name,
            scopes_json: row.scopes_json,
            params_json: row.params_json,
            cursor: row.cursor,
            bootstrap_state_json: row.bootstrap_state_json,
            status: row.status,
        }
    }
}

#[derive(Debug, Clone, QueryableByName)]
struct VerifiedRootRow {
    #[diesel(sql_type = Text)]
    state_id: String,
    #[diesel(sql_type = Text)]
    subscription_id: String,
    #[diesel(sql_type = Text)]
    partition_id: String,
    #[diesel(sql_type = BigInt)]
    commit_seq: i64,
    #[diesel(sql_type = Text)]
    root: String,
}

impl From<VerifiedRootRow> for VerifiedRoot {
    fn from(row: VerifiedRootRow) -> Self {
        Self {
            state_id: row.state_id,
            subscription_id: row.subscription_id,
            partition_id: row.partition_id,
            commit_seq: row.commit_seq,
            root: row.root,
        }
    }
}

#[derive(QueryableByName)]
struct MigrationVersionRow {
    #[diesel(sql_type = Text)]
    version: String,
    #[diesel(sql_type = Text)]
    checksum: String,
}

#[derive(QueryableByName)]
struct AppliedMigrationRow {
    #[diesel(sql_type = Text)]
    version: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    checksum: String,
    #[diesel(sql_type = BigInt)]
    applied_at: i64,
}

impl From<AppliedMigrationRow> for AppliedMigration {
    fn from(row: AppliedMigrationRow) -> Self {
        Self {
            version: row.version,
            name: row.name,
            checksum: row.checksum,
            applied_at: row.applied_at,
        }
    }
}

#[derive(QueryableByName)]
struct AppSchemaStateRow {
    #[diesel(sql_type = Integer)]
    schema_version: i32,
    #[diesel(sql_type = BigInt)]
    updated_at: i64,
}

#[derive(QueryableByName)]
struct OutboxSummaryRow {
    #[diesel(sql_type = Text)]
    client_commit_id: String,
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = Integer)]
    schema_version: i32,
    #[diesel(sql_type = Nullable<Text>)]
    lease_id: Option<String>,
    #[diesel(sql_type = Nullable<BigInt>)]
    lease_expires_at_ms: Option<i64>,
    #[diesel(sql_type = Nullable<Text>)]
    lease_status_at_enqueue: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    lease_scope_summary_json: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    lease_token: Option<String>,
}

impl From<OutboxSummaryRow> for OutboxSummary {
    fn from(row: OutboxSummaryRow) -> Self {
        Self {
            client_commit_id: row.client_commit_id,
            status: row.status,
            schema_version: row.schema_version,
            auth_lease: auth_lease_provenance_from_columns(
                row.lease_id,
                row.lease_expires_at_ms,
                row.lease_status_at_enqueue,
                row.lease_scope_summary_json,
                row.lease_token,
            ),
        }
    }
}

#[derive(QueryableByName)]
struct NextRetryAtRow {
    #[diesel(sql_type = diesel::sql_types::Nullable<BigInt>)]
    next_attempt_at: Option<i64>,
}

#[derive(QueryableByName)]
struct ConflictSummaryRow {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    client_commit_id: String,
    #[diesel(sql_type = Integer)]
    op_index: i32,
    #[diesel(sql_type = Text)]
    result_status: String,
    #[diesel(sql_type = Text)]
    message: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<Text>)]
    code: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<BigInt>)]
    server_version: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Nullable<BigInt>)]
    resolved_at: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Nullable<Text>)]
    resolution: Option<String>,
}

#[derive(QueryableByName)]
struct ConflictRetryRow {
    #[diesel(sql_type = BigInt)]
    server_version: i64,
    #[diesel(sql_type = Integer)]
    op_index: i32,
    #[diesel(sql_type = Text)]
    operations_json: String,
}

#[derive(QueryableByName)]
struct BlobBodyRow {
    #[diesel(sql_type = Binary)]
    body: Vec<u8>,
}

#[derive(QueryableByName)]
struct BlobFoundRow {
    #[diesel(sql_type = Integer)]
    found: i32,
}

#[derive(QueryableByName)]
struct JsonObjectRow {
    #[diesel(sql_type = Text)]
    row_json: String,
}

#[derive(QueryableByName)]
struct EncryptedCrdtScopeRow {
    #[diesel(sql_type = Text)]
    identity: String,
    #[diesel(sql_type = Text)]
    scopes: String,
}

#[derive(QueryableByName)]
struct EncryptedCrdtStreamStatsRow {
    #[diesel(sql_type = BigInt)]
    update_count: i64,
    #[diesel(sql_type = BigInt)]
    checkpoint_count: i64,
    #[diesel(sql_type = BigInt)]
    checkpointable_update_count: i64,
    #[diesel(sql_type = diesel::sql_types::Nullable<BigInt>)]
    max_server_seq: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Nullable<BigInt>)]
    latest_checkpoint_covers_seq: Option<i64>,
}

impl From<EncryptedCrdtStreamStatsRow> for EncryptedCrdtStreamStats {
    fn from(row: EncryptedCrdtStreamStatsRow) -> Self {
        Self {
            update_count: row.update_count,
            checkpoint_count: row.checkpoint_count,
            checkpointable_update_count: row.checkpointable_update_count,
            max_server_seq: row.max_server_seq,
            latest_checkpoint_covers_seq: row.latest_checkpoint_covers_seq,
        }
    }
}

#[derive(QueryableByName)]
pub struct PendingBlobUploadRow {
    #[diesel(sql_type = Text)]
    pub hash: String,
    #[diesel(sql_type = BigInt)]
    pub size: i64,
    #[diesel(sql_type = Text)]
    pub mime_type: String,
    #[diesel(sql_type = Binary)]
    pub body: Vec<u8>,
    #[diesel(sql_type = Integer)]
    pub encrypted: i32,
    #[diesel(sql_type = Nullable<Text>)]
    pub key_id: Option<String>,
    #[diesel(sql_type = Integer)]
    pub attempt_count: i32,
}

#[derive(QueryableByName)]
struct BlobQueueStatsRow {
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = BigInt)]
    count: i64,
}

#[derive(QueryableByName)]
struct BlobCacheStatsRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
    #[diesel(sql_type = BigInt)]
    total_bytes: i64,
}

#[derive(QueryableByName)]
struct BlobCacheEntryRow {
    #[diesel(sql_type = Text)]
    hash: String,
    #[diesel(sql_type = BigInt)]
    size: i64,
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

#[derive(QueryableByName)]
struct StringValueRow {
    #[diesel(sql_type = Text)]
    value: String,
}

#[derive(QueryableByName)]
struct ColumnNameRow {
    #[diesel(sql_type = Text)]
    name: String,
}

#[derive(QueryableByName)]
struct NullableStringValueRow {
    #[diesel(sql_type = Nullable<Text>)]
    value: Option<String>,
}

#[derive(QueryableByName)]
struct CrdtHealthStatsRow {
    #[diesel(sql_type = BigInt)]
    document_count: i64,
    #[diesel(sql_type = BigInt)]
    pending_updates: i64,
    #[diesel(sql_type = BigInt)]
    flushed_updates: i64,
    #[diesel(sql_type = BigInt)]
    acked_updates: i64,
    #[diesel(sql_type = BigInt)]
    log_updates: i64,
}

#[derive(QueryableByName)]
struct CrdtDocumentIdentityRow {
    #[diesel(sql_type = Text)]
    app_table: String,
    #[diesel(sql_type = Text)]
    row_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadQueueStats {
    pub pending: i64,
    pub uploading: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobCacheStats {
    pub count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadQueueResult {
    pub uploaded: i32,
    pub failed: i32,
}

impl From<ConflictSummaryRow> for ConflictSummary {
    fn from(row: ConflictSummaryRow) -> Self {
        Self {
            id: row.id,
            client_commit_id: row.client_commit_id,
            op_index: row.op_index,
            result_status: row.result_status,
            message: row.message,
            code: row.code,
            server_version: row.server_version,
            resolved_at: row.resolved_at,
            resolution: row.resolution,
        }
    }
}

pub struct DieselSqliteStore {
    conn: SqliteConnection,
    app_schema: AppSchema,
}

pub struct DieselSqliteTx<'a> {
    conn: &'a mut SqliteConnection,
    app_schema: AppSchema,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SqliteRuntimePragmaReport {
    pub journal_mode: String,
    pub foreign_keys: i32,
    pub busy_timeout: i32,
    pub synchronous: i32,
}

#[derive(QueryableByName)]
struct JournalModePragmaRow {
    #[diesel(sql_type = Text)]
    journal_mode: String,
}

#[derive(QueryableByName)]
struct ForeignKeysPragmaRow {
    #[diesel(sql_type = Integer)]
    foreign_keys: i32,
}

#[derive(QueryableByName)]
struct BusyTimeoutPragmaRow {
    #[diesel(sql_type = Integer)]
    timeout: i32,
}

#[derive(QueryableByName)]
struct SynchronousPragmaRow {
    #[diesel(sql_type = Integer)]
    synchronous: i32,
}

impl DieselSqliteStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::open_with_schema(path, default_app_schema())
    }

    pub fn open_with_schema(path: &str, app_schema: AppSchema) -> Result<Self> {
        let mut conn = SqliteConnection::establish(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open sqlite database at {path}"))
        })?;
        apply_sqlite_runtime_pragmas(&mut conn)?;
        let mut store = Self { conn, app_schema };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn ensure_schema(&mut self) -> Result<()> {
        sql_query(
            r#"
            create table if not exists sync_migrations (
                version text primary key,
                name text not null,
                checksum text not null,
                applied_at bigint not null
            )
            "#,
        )
        .execute(&mut self.conn)?;
        self.ensure_app_schema_state_table()?;
        self.reject_future_app_schema_state()?;
        self.ensure_runtime_system_schema()?;

        for migration in self.app_schema.migrations {
            let applied = sql_query(
                r#"
                select version, checksum
                from sync_migrations
                where version = ?1
                limit 1
                "#,
            )
            .bind::<Text, _>(migration.version)
            .load::<MigrationVersionRow>(&mut self.conn)?
            .into_iter()
            .next();
            let expected_checksum = checksum(migration.up_sql);

            if let Some(applied) = applied {
                if applied.checksum != expected_checksum {
                    return Err(SyncularError::schema(format!(
                        "migration {} checksum mismatch",
                        applied.version
                    )));
                }
                continue;
            }

            self.conn.transaction::<(), SyncularError, _>(|conn| {
                for statement in split_sql_statements(migration.up_sql) {
                    sql_query(statement).execute(conn)?;
                }
                sql_query(
                    r#"
                    insert into sync_migrations (version, name, checksum, applied_at)
                    values (?1, ?2, ?3, ?4)
                    "#,
                )
                .bind::<Text, _>(migration.version)
                .bind::<Text, _>(migration.name)
                .bind::<Text, _>(&expected_checksum)
                .bind::<BigInt, _>(now_ms())
                .execute(conn)?;
                Ok(())
            })?;
        }

        self.record_app_schema_state()?;
        Ok(())
    }

    fn ensure_app_schema_state_table(&mut self) -> Result<()> {
        sql_query(
            r#"
            create table if not exists syncular_app_schema (
                schema_id text primary key,
                schema_version integer not null,
                updated_at bigint not null
            )
            "#,
        )
        .execute(&mut self.conn)?;
        Ok(())
    }

    fn app_schema_state_row(&mut self) -> Result<Option<AppSchemaStateRow>> {
        Ok(sql_query(
            r#"
            select schema_version, updated_at
            from syncular_app_schema
            where schema_id = ?1
            limit 1
            "#,
        )
        .bind::<Text, _>(APP_SCHEMA_ID)
        .load::<AppSchemaStateRow>(&mut self.conn)?
        .into_iter()
        .next())
    }

    fn reject_future_app_schema_state(&mut self) -> Result<()> {
        let current = self.app_schema.current_schema_version();
        if let Some(row) = self.app_schema_state_row()? {
            if row.schema_version > current {
                return Err(SyncularError::schema(format!(
                    "Syncular app schema version mismatch: local {}, generated {}",
                    row.schema_version, current
                )));
            }
        }
        Ok(())
    }

    fn record_app_schema_state(&mut self) -> Result<()> {
        let current = self.app_schema.current_schema_version();
        sql_query(
            r#"
            insert into syncular_app_schema (schema_id, schema_version, updated_at)
            values (?1, ?2, ?3)
            on conflict (schema_id) do update set
                schema_version = excluded.schema_version,
                updated_at = excluded.updated_at
            "#,
        )
        .bind::<Text, _>(APP_SCHEMA_ID)
        .bind::<Integer, _>(current)
        .bind::<BigInt, _>(now_ms())
        .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn app_schema_state(&mut self) -> Result<AppSchemaState> {
        self.ensure_app_schema_state_table()?;
        let row = self.app_schema_state_row()?;
        Ok(AppSchemaState {
            schema_id: APP_SCHEMA_ID.to_string(),
            schema_version: row.as_ref().map(|row| row.schema_version),
            current_schema_version: self.app_schema.current_schema_version(),
            updated_at: row.as_ref().map(|row| row.updated_at),
        })
    }

    pub fn runtime_pragma_report(&mut self) -> Result<SqliteRuntimePragmaReport> {
        sqlite_runtime_pragma_report(&mut self.conn)
    }

    fn ensure_runtime_system_schema(&mut self) -> Result<()> {
        for statement in split_sql_statements(RUNTIME_SYSTEM_SCHEMA_SQL) {
            sql_query(statement).execute(&mut self.conn)?;
        }
        self.ensure_runtime_system_schema_upgrades()?;
        Ok(())
    }

    fn ensure_runtime_system_schema_upgrades(&mut self) -> Result<()> {
        add_column_if_missing(
            &mut self.conn,
            "sync_outbox_commits",
            "lease_id",
            "alter table sync_outbox_commits add column lease_id text null",
        )?;
        add_column_if_missing(
            &mut self.conn,
            "sync_outbox_commits",
            "lease_expires_at_ms",
            "alter table sync_outbox_commits add column lease_expires_at_ms bigint null",
        )?;
        add_column_if_missing(
            &mut self.conn,
            "sync_outbox_commits",
            "lease_status_at_enqueue",
            "alter table sync_outbox_commits add column lease_status_at_enqueue text null",
        )?;
        add_column_if_missing(
            &mut self.conn,
            "sync_outbox_commits",
            "lease_scope_summary_json",
            "alter table sync_outbox_commits add column lease_scope_summary_json text null",
        )?;
        add_column_if_missing(
            &mut self.conn,
            "sync_outbox_commits",
            "lease_token",
            "alter table sync_outbox_commits add column lease_token text null",
        )
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>> {
        if self.app_schema.table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {table}"
            )));
        }

        list_app_rows_json(&mut self.conn, self.app_schema, table)
    }

    pub fn read_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        current_app_row_json(&mut self.conn, self.app_schema, table, row_id)
    }

    pub fn record_command_history(
        &mut self,
        mutation_scope: &str,
        entries: &[CommandHistoryEntry],
        receipt: &MutationReceipt,
    ) -> Result<CommandHistoryRecord> {
        self.conn
            .transaction::<CommandHistoryRecord, SyncularError, _>(|conn| {
                insert_command_history_record(conn, mutation_scope, entries, receipt)
            })
    }

    pub fn apply_syncular_mutations_with_command_history(
        &mut self,
        mutation_scope: &str,
        actor_id: Option<&str>,
        now_ms_value: i64,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.transaction(|tx| {
            tx.apply_syncular_mutations_with_command_history(
                mutation_scope,
                actor_id,
                now_ms_value,
                mutations,
            )
        })
    }

    pub fn latest_command_history(
        &mut self,
        state: CommandHistoryState,
    ) -> Result<Option<CommandHistoryRecord>> {
        sql_query(
            r#"
            select id, mutation_scope, state, entries_json, client_commit_id,
                   undo_client_commit_id, redo_client_commit_id, created_at, updated_at
            from sync_command_history
            where state = ?1
            order by updated_at desc, created_at desc, id desc
            limit 1
            "#,
        )
        .bind::<Text, _>(state.as_str())
        .load::<CommandHistoryRow>(&mut self.conn)?
        .into_iter()
        .next()
        .map(CommandHistoryRecord::try_from)
        .transpose()
    }

    pub fn mark_command_history(
        &mut self,
        id: &str,
        state: CommandHistoryState,
        receipt: &MutationReceipt,
    ) -> Result<()> {
        let replay_column = match state {
            CommandHistoryState::Done => "redo_client_commit_id",
            CommandHistoryState::Undone => "undo_client_commit_id",
        };
        let statement = format!(
            "update sync_command_history set state = ?1, updated_at = ?2, {replay_column} = ?3 where id = ?4"
        );
        sql_query(statement)
            .bind::<Text, _>(state.as_str())
            .bind::<BigInt, _>(now_ms())
            .bind::<Text, _>(&receipt.client_commit_id)
            .bind::<Text, _>(id)
            .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn read<'query, Q, Row>(&mut self, query: Q) -> Result<Vec<Row>>
    where
        Q: diesel::query_dsl::LoadQuery<'query, SqliteConnection, Row>,
    {
        query.load(&mut self.conn).map_err(Into::into)
    }

    pub fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        if self.app_schema.table_metadata(&operation.table).is_none()
            && !is_encrypted_crdt_system_table(&operation.table)
        {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {}",
                operation.table
            )));
        }

        self.transaction(|tx| tx.apply_local_operation(operation, local_row))
    }

    pub fn apply_local_operation_with_active_auth_lease(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        self.transaction(|tx| {
            tx.apply_local_operation_with_active_auth_lease(
                actor_id,
                now_ms_value,
                operation,
                local_row,
            )
        })
    }

    pub fn apply_syncular_mutations(
        &mut self,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.transaction(|tx| tx.apply_syncular_mutations(mutations))
    }

    pub fn apply_syncular_mutations_with_active_auth_lease(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.transaction(|tx| {
            tx.apply_syncular_mutations_with_active_auth_lease(actor_id, now_ms_value, mutations)
        })
    }

    pub fn upsert_auth_lease(&mut self, lease: &AuthLeaseRecord) -> Result<()> {
        self.transaction(|tx| tx.upsert_auth_lease(lease))
    }

    pub fn auth_lease(&mut self, lease_id: &str) -> Result<Option<AuthLeaseRecord>> {
        self.transaction(|tx| tx.auth_lease(lease_id))
    }

    pub fn active_auth_leases(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
    ) -> Result<Vec<AuthLeaseRecord>> {
        self.transaction(|tx| tx.active_auth_leases(actor_id, now_ms_value))
    }

    pub fn set_outbox_auth_lease(
        &mut self,
        client_commit_id: &str,
        provenance: Option<&AuthLeaseProvenance>,
    ) -> Result<()> {
        self.transaction(|tx| tx.set_outbox_auth_lease(client_commit_id, provenance))
    }

    pub fn store_blob_bytes(
        &mut self,
        data: &[u8],
        mime_type: &str,
        enqueue_upload: bool,
    ) -> Result<BlobRef> {
        let size = i64::try_from(data.len()).map_err(|_| {
            SyncularError::protocol_message("blob is too large for SQLite size metadata")
        })?;
        validate_blob_size_bytes(size)?;
        let blob = BlobRef {
            hash: blob_hash(data),
            size,
            mime_type: normalize_blob_mime_type(mime_type),
            encrypted: false,
            key_id: None,
        };

        self.store_blob_body(&blob, data, enqueue_upload)?;
        Ok(blob)
    }

    pub fn store_blob_body(
        &mut self,
        blob: &BlobRef,
        data: &[u8],
        enqueue_upload: bool,
    ) -> Result<()> {
        self.conn.transaction::<(), SyncularError, _>(|conn| {
            cache_blob(conn, blob, data)?;
            if enqueue_upload {
                enqueue_blob_upload(conn, blob, data)?;
            }
            Ok(())
        })
    }

    pub fn cache_blob_bytes(&mut self, blob: &BlobRef, data: &[u8]) -> Result<()> {
        cache_blob(&mut self.conn, blob, data)
    }

    pub fn read_cached_blob(&mut self, hash: &str) -> Result<Option<Vec<u8>>> {
        validate_blob_hash(hash)?;
        let row = sql_query("select body from sync_blob_cache where hash = ?1 limit 1")
            .bind::<Text, _>(hash)
            .load::<BlobBodyRow>(&mut self.conn)?
            .into_iter()
            .next();
        let Some(row) = row else {
            return Ok(None);
        };
        sql_query("update sync_blob_cache set last_accessed_at = ?1 where hash = ?2")
            .bind::<BigInt, _>(now_ms())
            .bind::<Text, _>(hash)
            .execute(&mut self.conn)?;
        Ok(Some(row.body))
    }

    pub fn is_blob_local(&mut self, hash: &str) -> Result<bool> {
        validate_blob_hash(hash)?;
        let row = sql_query("select 1 as found from sync_blob_cache where hash = ?1 limit 1")
            .bind::<Text, _>(hash)
            .load::<BlobFoundRow>(&mut self.conn)?
            .into_iter()
            .next();
        Ok(row.is_some_and(|row| row.found == 1))
    }

    pub fn requeue_stale_blob_uploads(&mut self) -> Result<()> {
        let now = now_ms();
        let stale_before = now - BLOB_UPLOAD_STALE_TIMEOUT_MS;
        sql_query(
            r#"
            update sync_blob_outbox
            set status = case
                    when attempt_count >= ?1 then 'failed'
                    else 'pending'
                end,
                error = case
                    when attempt_count >= ?1 then 'Upload timed out while in uploading state'
                    else 'Upload timed out while in uploading state; retrying'
                end,
                next_attempt_at = case
                    when attempt_count >= ?1 then 0
                    else ?2
                end,
                updated_at = ?2
            where status = 'uploading' and updated_at < ?3
            "#,
        )
        .bind::<Integer, _>(MAX_BLOB_UPLOAD_RETRIES)
        .bind::<BigInt, _>(now)
        .bind::<BigInt, _>(stale_before)
        .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn pending_blob_uploads(
        &mut self,
        limit: i64,
        retry_now: bool,
    ) -> Result<Vec<PendingBlobUploadRow>> {
        let now = now_ms();
        Ok(sql_query(
            r#"
            select hash, size, mime_type, body, encrypted, key_id, attempt_count
            from sync_blob_outbox
            where status = 'pending' and attempt_count < ?1 and (?2 or next_attempt_at <= ?3)
            order by created_at asc
            limit ?4
            "#,
        )
        .bind::<Integer, _>(MAX_BLOB_UPLOAD_RETRIES)
        .bind::<Bool, _>(retry_now)
        .bind::<BigInt, _>(now)
        .bind::<BigInt, _>(limit)
        .load::<PendingBlobUploadRow>(&mut self.conn)?)
    }

    pub fn mark_blob_uploading(&mut self, hash: &str, attempt_count: i32) -> Result<()> {
        sql_query(
            r#"
            update sync_blob_outbox
            set status = 'uploading',
                attempt_count = ?1,
                error = null,
                next_attempt_at = 0,
                updated_at = ?2
            where hash = ?3 and status = 'pending'
            "#,
        )
        .bind::<Integer, _>(attempt_count)
        .bind::<BigInt, _>(now_ms())
        .bind::<Text, _>(hash)
        .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn mark_blob_upload_error(
        &mut self,
        hash: &str,
        status: &str,
        error: &str,
        next_attempt_at: i64,
    ) -> Result<()> {
        sql_query(
            r#"
            update sync_blob_outbox
            set status = ?1, error = ?2, next_attempt_at = ?3, updated_at = ?4
            where hash = ?5
            "#,
        )
        .bind::<Text, _>(status)
        .bind::<Text, _>(error)
        .bind::<BigInt, _>(next_attempt_at)
        .bind::<BigInt, _>(now_ms())
        .bind::<Text, _>(hash)
        .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn delete_blob_upload(&mut self, hash: &str) -> Result<()> {
        sql_query("delete from sync_blob_outbox where hash = ?1")
            .bind::<Text, _>(hash)
            .execute(&mut self.conn)?;
        Ok(())
    }

    pub fn blob_upload_queue_stats(&mut self) -> Result<BlobUploadQueueStats> {
        let rows = sql_query(
            r#"
            select status, count(hash) as count
            from sync_blob_outbox
            group by status
            "#,
        )
        .load::<BlobQueueStatsRow>(&mut self.conn)?;
        let mut stats = BlobUploadQueueStats {
            pending: 0,
            uploading: 0,
            failed: 0,
        };
        for row in rows {
            match row.status.as_str() {
                "pending" => stats.pending = row.count,
                "uploading" => stats.uploading = row.count,
                "failed" => stats.failed = row.count,
                _ => {}
            }
        }
        Ok(stats)
    }

    pub fn blob_cache_stats(&mut self) -> Result<BlobCacheStats> {
        let row = sql_query(
            r#"
            select count(hash) as count, coalesce(sum(size), 0) as total_bytes
            from sync_blob_cache
            "#,
        )
        .load::<BlobCacheStatsRow>(&mut self.conn)?
        .into_iter()
        .next()
        .unwrap_or(BlobCacheStatsRow {
            count: 0,
            total_bytes: 0,
        });
        Ok(BlobCacheStats {
            count: row.count,
            total_bytes: row.total_bytes,
        })
    }

    fn blob_reference_health_counts(&mut self) -> Result<(i64, i64)> {
        let mut checked = 0i64;
        let mut invalid = 0i64;
        for metadata in self.app_schema.app_table_metadata {
            validate_app_table_metadata(metadata)?;
            for column in metadata.blob_columns {
                validate_identifier(column)?;
                let sql = format!(
                    "select {column} as value from {table} where {column} is not null and {column} <> ''",
                    table = metadata.name
                );
                let rows = sql_query(sql).load::<NullableStringValueRow>(&mut self.conn)?;
                for row in rows {
                    let Some(value) = row.value else {
                        continue;
                    };
                    checked += 1;
                    let parsed = serde_json::from_str::<BlobRef>(&value);
                    match parsed {
                        Ok(blob) if validate_blob_ref_size(&blob).is_ok() => {}
                        _ => invalid += 1,
                    }
                }
            }
        }
        Ok((checked, invalid))
    }

    fn scoped_rows_health_summary(
        &mut self,
        subscriptions: &[SubscriptionSpec],
    ) -> Result<ScopedRowsHealthSummary> {
        scoped_rows_health_summary_for_schema(&mut self.conn, self.app_schema, subscriptions)
    }

    fn clear_orphaned_synced_rows(
        &mut self,
        subscriptions: &[SubscriptionSpec],
        tables: &[String],
    ) -> Result<ScopedRowsHealthSummary> {
        self.conn.transaction(|conn| {
            clear_orphaned_synced_rows_for_schema(conn, self.app_schema, subscriptions, tables)
        })
    }

    pub fn crdt_health_summary(&mut self) -> Result<CrdtHealthSummary> {
        let stats = sql_query(
            r#"
            select
              count(*) as document_count,
              coalesce(sum(pending_updates), 0) as pending_updates,
              coalesce(sum(flushed_updates), 0) as flushed_updates,
              coalesce(sum(acked_updates), 0) as acked_updates,
              coalesce(sum(log_updates), 0) as log_updates
            from sync_crdt_documents
            "#,
        )
        .load::<CrdtHealthStatsRow>(&mut self.conn)?
        .into_iter()
        .next()
        .unwrap_or(CrdtHealthStatsRow {
            document_count: 0,
            pending_updates: 0,
            flushed_updates: 0,
            acked_updates: 0,
            log_updates: 0,
        });
        let orphaned_log_entries = sql_query(
            r#"
            select count(*) as count
            from sync_crdt_update_log log
            left join sync_crdt_documents documents
              on documents.document_key = log.document_key
            where documents.document_key is null
            "#,
        )
        .load::<CountRow>(&mut self.conn)?
        .into_iter()
        .next()
        .map(|row| row.count)
        .unwrap_or(0);

        Ok(CrdtHealthSummary {
            document_count: stats.document_count,
            pending_updates: stats.pending_updates,
            flushed_updates: stats.flushed_updates,
            acked_updates: stats.acked_updates,
            log_updates: stats.log_updates,
            orphaned_documents: self.orphaned_crdt_document_count()?,
            orphaned_log_entries,
        })
    }

    fn orphaned_crdt_document_count(&mut self) -> Result<i64> {
        let documents = sql_query(
            r#"
            select app_table, row_id
            from sync_crdt_documents
            order by app_table asc, row_id asc
            "#,
        )
        .load::<CrdtDocumentIdentityRow>(&mut self.conn)?;
        let mut orphaned = 0i64;
        for document in documents {
            let Some(metadata) = self.app_schema.table_metadata(&document.app_table) else {
                orphaned += 1;
                continue;
            };
            if get_app_row_json_generic(&mut self.conn, metadata, &document.row_id)?.is_none() {
                orphaned += 1;
            }
        }
        Ok(orphaned)
    }

    pub fn apply_crdt_field_yjs_update(
        &mut self,
        field: &CrdtField,
        update: YjsUpdateEnvelope,
        max_pending_updates: i64,
    ) -> Result<String> {
        self.transaction(|tx| tx.apply_crdt_field_yjs_update(field, update, max_pending_updates))
    }

    pub fn crdt_document_snapshot(&mut self, field: &CrdtField) -> Result<CrdtDocumentSnapshot> {
        let row = current_app_row_json(
            &mut self.conn,
            self.app_schema,
            field.table(),
            field.row_id(),
        )?;
        let state_base64 = crdt_field_state_base64(field, row.as_ref());
        let state_vector_base64 = yjs_state_vector_base64(state_base64.as_deref())?;
        upsert_crdt_document_snapshot(
            &mut self.conn,
            field,
            state_base64.as_deref(),
            &state_vector_base64,
            None,
        )?;
        select_crdt_document_snapshot(&mut self.conn, &field.document_key())
    }

    pub fn crdt_update_log(
        &mut self,
        field: &CrdtField,
        limit: i64,
    ) -> Result<Vec<CrdtUpdateLogEntry>> {
        sql_query(
            r#"
            select id, document_key, update_id, client_commit_id, origin, status, update_base64,
                   state_vector_base64, created_at, flushed_at, acked_at
            from sync_crdt_update_log
            where document_key = ?1
            order by id asc
            limit ?2
            "#,
        )
        .bind::<Text, _>(field.document_key())
        .bind::<BigInt, _>(limit.max(0))
        .load::<CrdtUpdateLogRow>(&mut self.conn)?
        .into_iter()
        .map(CrdtUpdateLogEntry::try_from)
        .collect()
    }

    pub fn compact_crdt_document(&mut self, field: &CrdtField) -> Result<CrdtDocumentSnapshot> {
        let row = current_app_row_json(
            &mut self.conn,
            self.app_schema,
            field.table(),
            field.row_id(),
        )?;
        let state_base64 = crdt_field_state_base64(field, row.as_ref());
        let state_vector_base64 = yjs_state_vector_base64(state_base64.as_deref())?;
        upsert_crdt_document_snapshot(
            &mut self.conn,
            field,
            state_base64.as_deref(),
            &state_vector_base64,
            Some(now_ms()),
        )?;
        select_crdt_document_snapshot(&mut self.conn, &field.document_key())
    }

    pub fn prune_blob_cache(&mut self, max_bytes: i64) -> Result<i64> {
        if max_bytes <= 0 {
            return Ok(0);
        }
        let stats = self.blob_cache_stats()?;
        if stats.total_bytes <= max_bytes {
            return Ok(0);
        }
        let target = stats.total_bytes - max_bytes;
        let entries = sql_query(
            r#"
            select hash, size
            from sync_blob_cache
            order by last_accessed_at asc
            "#,
        )
        .load::<BlobCacheEntryRow>(&mut self.conn)?;
        let mut freed = 0i64;
        for entry in entries {
            if freed >= target {
                break;
            }
            sql_query("delete from sync_blob_cache where hash = ?1")
                .bind::<Text, _>(&entry.hash)
                .execute(&mut self.conn)?;
            freed += entry.size;
        }
        Ok(freed)
    }

    pub fn prune_crdt_update_log(&mut self, cutoff: i64) -> Result<i64> {
        let deleted = sql_query(
            r#"
            delete from sync_crdt_update_log
            where status in ('acked', 'pruned')
              and coalesce(acked_at, flushed_at, created_at) <= ?1
            "#,
        )
        .bind::<BigInt, _>(cutoff)
        .execute(&mut self.conn)? as i64;
        refresh_all_crdt_document_counts(&mut self.conn)?;
        Ok(deleted)
    }

    pub fn clear_blob_cache(&mut self) -> Result<()> {
        sql_query("delete from sync_blob_cache").execute(&mut self.conn)?;
        Ok(())
    }

    pub fn encrypted_crdt_stream_stats(
        &mut self,
        partition_id: &str,
        stream_id: &str,
    ) -> Result<EncryptedCrdtStreamStats> {
        Ok(sql_query(
            r#"
            select
                (select count(*) from sync_crdt_updates
                 where partition_id = ?1 and stream_id = ?2) as update_count,
                (select count(*) from sync_crdt_checkpoints
                 where partition_id = ?1 and stream_id = ?2) as checkpoint_count,
                (select count(*) from sync_crdt_updates
                 where partition_id = ?1 and stream_id = ?2
                   and server_seq is not null
                   and server_seq > coalesce((
                       select max(covers_seq) from sync_crdt_checkpoints
                       where partition_id = ?1 and stream_id = ?2
                   ), 0)) as checkpointable_update_count,
                (select max(server_seq) from sync_crdt_updates
                 where partition_id = ?1 and stream_id = ?2) as max_server_seq,
                (select max(covers_seq) from sync_crdt_checkpoints
                 where partition_id = ?1 and stream_id = ?2) as latest_checkpoint_covers_seq
            "#,
        )
        .bind::<Text, _>(partition_id)
        .bind::<Text, _>(stream_id)
        .load::<EncryptedCrdtStreamStatsRow>(&mut self.conn)?
        .into_iter()
        .next()
        .map(Into::into)
        .unwrap_or_default())
    }

    pub fn prune_encrypted_crdt_updates(&mut self) -> Result<i64> {
        Ok(sql_query(
            r#"
            delete from sync_crdt_updates
            where server_seq is not null
              and exists (
                select 1
                from sync_crdt_checkpoints
                where sync_crdt_checkpoints.partition_id = sync_crdt_updates.partition_id
                  and sync_crdt_checkpoints.stream_id = sync_crdt_updates.stream_id
                  and sync_crdt_checkpoints.key_id = sync_crdt_updates.key_id
                  and sync_crdt_checkpoints.server_seq is not null
                  and sync_crdt_checkpoints.covers_seq >= sync_crdt_updates.server_seq
              )
            "#,
        )
        .execute(&mut self.conn)? as i64)
    }

    pub fn prune_encrypted_crdt_checkpoints(&mut self, keep_per_stream: i64) -> Result<i64> {
        Ok(sql_query(
            r#"
            delete from sync_crdt_checkpoints
            where checkpoint_id in (
                select checkpoint_id
                from (
                    select
                        checkpoint_id,
                        row_number() over (
                            partition by partition_id, stream_id, key_id
                            order by covers_seq desc, coalesce(server_seq, 0) desc, seq desc
                        ) as checkpoint_rank
                    from sync_crdt_checkpoints
                ) ranked
                where checkpoint_rank > ?1
            )
            "#,
        )
        .bind::<BigInt, _>(keep_per_stream)
        .execute(&mut self.conn)? as i64)
    }

    pub fn compact_storage(
        &mut self,
        options: &StorageCompactionOptions,
    ) -> Result<StorageCompactionReport> {
        let cutoff = options.cutoff_ms_now()?;
        let mut report = StorageCompactionReport::default();

        if options.should_prune_acked_outbox() {
            let cutoff = required_compaction_cutoff(cutoff, "acked outbox")?;
            report.acked_outbox_commits_deleted = sql_query(
                "delete from sync_outbox_commits where status = 'acked' and updated_at <= ?1",
            )
            .bind::<BigInt, _>(cutoff)
            .execute(&mut self.conn)? as i64;
        }

        if options.should_prune_resolved_conflicts() {
            let cutoff = required_compaction_cutoff(cutoff, "resolved conflicts")?;
            report.resolved_conflicts_deleted = sql_query(
                "delete from sync_conflicts where resolved_at is not null and resolved_at <= ?1",
            )
            .bind::<BigInt, _>(cutoff)
            .execute(&mut self.conn)? as i64;
        }

        if options.should_prune_failed_blob_uploads() {
            let cutoff = required_compaction_cutoff(cutoff, "failed blob uploads")?;
            report.failed_blob_uploads_deleted = sql_query(
                "delete from sync_blob_outbox where status = 'failed' and updated_at <= ?1",
            )
            .bind::<BigInt, _>(cutoff)
            .execute(&mut self.conn)? as i64;
        }

        if options.should_prune_inactive_subscription_states() {
            let cutoff = required_compaction_cutoff(cutoff, "inactive subscription states")?;
            report.inactive_subscription_states_deleted = sql_query(
                "delete from sync_subscription_state where status != 'active' and updated_at <= ?1",
            )
            .bind::<BigInt, _>(cutoff)
            .execute(&mut self.conn)?
                as i64;
        }

        if options.should_prune_tombstones() {
            let max_server_version = options.max_tombstone_server_version.ok_or_else(|| {
                SyncularError::config(
                    "storage compaction tombstone cleanup requires maxTombstoneServerVersion",
                )
            })?;
            for statement in
                tombstone_delete_statements(self.app_schema.app_table_metadata, max_server_version)?
            {
                report.tombstone_rows_deleted +=
                    sql_query(statement).execute(&mut self.conn)? as i64;
            }
        }

        if let Some(max_bytes) = options.max_blob_cache_bytes {
            report.blob_cache_bytes_pruned = self.prune_blob_cache(max_bytes)?;
        }

        if options.should_prune_encrypted_crdt_updates() {
            report.encrypted_crdt_updates_deleted = self.prune_encrypted_crdt_updates()?;
        }

        if let Some(keep) = options.encrypted_crdt_checkpoint_keep_count()? {
            report.encrypted_crdt_checkpoints_deleted =
                self.prune_encrypted_crdt_checkpoints(keep)?;
        }

        if options.should_prune_crdt_update_log() {
            let cutoff = required_compaction_cutoff(cutoff, "CRDT update log")?;
            report.crdt_update_log_deleted = self.prune_crdt_update_log(cutoff)?;
        }

        Ok(report)
    }

    pub fn compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        let options = StorageCompactionOptions::from_json(options_json)?;
        Ok(serde_json::to_string(&self.compact_storage(&options)?)?)
    }
}

pub fn apply_sqlite_runtime_pragmas(conn: &mut SqliteConnection) -> Result<()> {
    conn.batch_execute(&format!(
        r#"
        pragma busy_timeout = {SQLITE_BUSY_TIMEOUT_MS};
        pragma foreign_keys = on;
        pragma journal_mode = wal;
        pragma synchronous = normal;
        "#
    ))?;
    Ok(())
}

fn sqlite_runtime_pragma_report(conn: &mut SqliteConnection) -> Result<SqliteRuntimePragmaReport> {
    Ok(SqliteRuntimePragmaReport {
        journal_mode: sql_query("pragma journal_mode")
            .load::<JournalModePragmaRow>(conn)?
            .into_iter()
            .next()
            .map(|row| row.journal_mode)
            .unwrap_or_default(),
        foreign_keys: sql_query("pragma foreign_keys")
            .load::<ForeignKeysPragmaRow>(conn)?
            .into_iter()
            .next()
            .map(|row| row.foreign_keys)
            .unwrap_or_default(),
        busy_timeout: sql_query("pragma busy_timeout")
            .load::<BusyTimeoutPragmaRow>(conn)?
            .into_iter()
            .next()
            .map(|row| row.timeout)
            .unwrap_or_default(),
        synchronous: sql_query("pragma synchronous")
            .load::<SynchronousPragmaRow>(conn)?
            .into_iter()
            .next()
            .map(|row| row.synchronous)
            .unwrap_or_default(),
    })
}

fn cache_blob(conn: &mut SqliteConnection, blob: &BlobRef, data: &[u8]) -> Result<()> {
    validate_blob_bytes(blob, data)?;
    let now = now_ms();
    sql_query(
        r#"
        insert into sync_blob_cache
            (hash, size, mime_type, body, encrypted, key_id, cached_at, last_accessed_at)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        on conflict(hash) do update set
            size = excluded.size,
            mime_type = excluded.mime_type,
            body = excluded.body,
            encrypted = excluded.encrypted,
            key_id = excluded.key_id,
            last_accessed_at = excluded.last_accessed_at
        "#,
    )
    .bind::<Text, _>(&blob.hash)
    .bind::<BigInt, _>(blob.size)
    .bind::<Text, _>(&blob.mime_type)
    .bind::<Binary, _>(data)
    .bind::<Integer, _>(if blob.encrypted { 1 } else { 0 })
    .bind::<diesel::sql_types::Nullable<Text>, _>(blob.key_id.as_deref())
    .bind::<BigInt, _>(now)
    .bind::<BigInt, _>(now)
    .execute(conn)?;
    Ok(())
}

fn enqueue_blob_upload(conn: &mut SqliteConnection, blob: &BlobRef, data: &[u8]) -> Result<()> {
    let now = now_ms();
    sql_query(
        r#"
        insert into sync_blob_outbox
            (hash, size, mime_type, body, encrypted, key_id, status, attempt_count, error, created_at, updated_at, next_attempt_at)
        values (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, null, ?7, ?8, 0)
        on conflict(hash) do nothing
        "#,
    )
    .bind::<Text, _>(&blob.hash)
    .bind::<BigInt, _>(blob.size)
    .bind::<Text, _>(&blob.mime_type)
    .bind::<Binary, _>(data)
    .bind::<Integer, _>(if blob.encrypted { 1 } else { 0 })
    .bind::<diesel::sql_types::Nullable<Text>, _>(blob.key_id.as_deref())
    .bind::<BigInt, _>(now)
    .bind::<BigInt, _>(now)
    .execute(conn)?;
    Ok(())
}

fn mutation_has_server_merge_yjs_payload(
    mutation: &PendingSyncularMutation,
    metadata: &AppTableMetadata,
) -> bool {
    operation_payload_has_server_merge_yjs_payload(mutation.payload.as_ref(), metadata)
}

fn operation_payload_has_server_merge_yjs_payload(
    payload: Option<&Value>,
    metadata: &AppTableMetadata,
) -> bool {
    let Some(Value::Object(payload)) = payload else {
        return false;
    };
    let Some(Value::Object(envelope)) = payload.get(YJS_PAYLOAD_KEY) else {
        return false;
    };

    metadata.crdt_yjs_fields.iter().any(|field| {
        (field.sync_mode == "server-merge" || field.sync_mode.is_empty())
            && envelope.contains_key(field.field)
    })
}

fn collect_server_merge_yjs_updates(
    app_schema: AppSchema,
    metadata: &'static AppTableMetadata,
    operation: &SyncOperation,
) -> Result<Vec<(CrdtField, YjsUpdateEnvelope)>> {
    let Some(Value::Object(payload)) = operation.payload.as_ref() else {
        return Ok(Vec::new());
    };
    let Some(Value::Object(envelope)) = payload.get(YJS_PAYLOAD_KEY) else {
        return Ok(Vec::new());
    };

    let mut updates = Vec::new();
    for field_metadata in metadata.crdt_yjs_fields.iter().filter(|field| {
        (field.sync_mode == "server-merge" || field.sync_mode.is_empty())
            && envelope.contains_key(field.field)
    }) {
        let field = validate_crdt_field(
            app_schema,
            &CrdtFieldId::new(&operation.table, &operation.row_id, field_metadata.field),
        )?;
        let Some(value) = envelope.get(field_metadata.field) else {
            continue;
        };
        match value {
            Value::Array(items) => {
                for item in items {
                    updates.push((field.clone(), serde_json::from_value(item.clone())?));
                }
            }
            Value::Null => {}
            item => updates.push((field, serde_json::from_value(item.clone())?)),
        }
    }

    Ok(updates)
}

impl SyncStore for DieselSqliteStore {
    type Tx<'a> = DieselSqliteTx<'a>;

    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T>) -> Result<T> {
        let app_schema = self.app_schema;
        self.conn.transaction::<T, SyncularError, _>(|conn| {
            let mut tx = DieselSqliteTx { conn, app_schema };
            f(&mut tx)
        })
    }

    fn supports_sqlite_snapshot_artifacts(&self) -> bool {
        true
    }

    fn decode_sqlite_snapshot_artifact_rows(
        &self,
        table: &str,
        artifact_bytes: &[u8],
    ) -> Result<Vec<Value>> {
        let mut artifact_conn = SqliteConnection::establish(":memory:")
            .map_err(|err| SyncularError::storage(err).context("open sqlite snapshot artifact"))?;
        artifact_conn
            .deserialize_readonly_database_from_buffer(artifact_bytes)
            .map_err(|err| {
                SyncularError::storage(err).context("deserialize sqlite snapshot artifact")
            })?;
        list_app_rows_json(&mut artifact_conn, self.app_schema, table)
    }
}

#[cfg(feature = "demo-todo-native-fixture")]
impl DemoTaskStore for DieselSqliteStore {
    fn add_task(
        &mut self,
        actor_id: &str,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        self.transaction(|tx| tx.add_task(actor_id, project_id, task_id, title_value))
    }

    fn list_tasks(&mut self) -> Result<Vec<Task>> {
        list_tasks(&mut self.conn)
    }

    fn patch_task_title(
        &mut self,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        self.transaction(|tx| tx.patch_task_title(project_id, task_id, title_value))
    }
}

impl SyncStateStore for DieselSqliteStore {
    fn applied_migrations(&mut self) -> Result<Vec<AppliedMigration>> {
        let rows = sql_query(
            r#"
            select version, name, checksum, applied_at
            from sync_migrations
            order by version asc
            "#,
        )
        .load::<AppliedMigrationRow>(&mut self.conn)?;

        Ok(rows.into_iter().map(AppliedMigration::from).collect())
    }

    fn app_schema_state(&mut self, _current_schema_version: i32) -> Result<AppSchemaState> {
        DieselSqliteStore::app_schema_state(self)
    }

    fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>> {
        let rows = sql_query(
            r#"
            select client_commit_id, status, schema_version,
                   lease_id, lease_expires_at_ms, lease_status_at_enqueue,
                   lease_scope_summary_json, lease_token
            from sync_outbox_commits
            order by created_at asc
            "#,
        )
        .load::<OutboxSummaryRow>(&mut self.conn)?;

        Ok(rows.into_iter().map(OutboxSummary::from).collect())
    }

    fn next_outbox_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(sql_query(
            r#"
            select min(next_attempt_at) as next_attempt_at
            from sync_outbox_commits
            where status = 'pending' and attempt_count > 0 and attempt_count < ?1
            "#,
        )
        .bind::<Integer, _>(MAX_SYNC_RETRIES)
        .load::<NextRetryAtRow>(&mut self.conn)?
        .into_iter()
        .next()
        .and_then(|row| row.next_attempt_at))
    }

    fn next_blob_upload_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(sql_query(
            r#"
            select min(next_attempt_at) as next_attempt_at
            from sync_blob_outbox
            where status = 'pending' and attempt_count > 0 and attempt_count < ?1
            "#,
        )
        .bind::<Integer, _>(MAX_BLOB_UPLOAD_RETRIES)
        .load::<NextRetryAtRow>(&mut self.conn)?
        .into_iter()
        .next()
        .and_then(|row| row.next_attempt_at))
    }

    fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>> {
        let rows = sql_query(
            r#"
            select id, client_commit_id, op_index, result_status, message, code, server_version,
                   resolved_at, resolution
            from sync_conflicts
            where resolved_at is null
            order by created_at desc
            "#,
        )
        .load::<ConflictSummaryRow>(&mut self.conn)?;

        Ok(rows.into_iter().map(ConflictSummary::from).collect())
    }

    fn blob_health_summary(&mut self) -> Result<Option<BlobHealthSummary>> {
        let upload = self.blob_upload_queue_stats()?;
        let cache = self.blob_cache_stats()?;
        let (checked_references, invalid_references) = self.blob_reference_health_counts()?;
        Ok(Some(BlobHealthSummary {
            cache_count: cache.count,
            cache_bytes: cache.total_bytes,
            upload_pending: upload.pending,
            upload_uploading: upload.uploading,
            upload_failed: upload.failed,
            checked_references,
            invalid_references,
        }))
    }

    fn crdt_health_summary(&mut self) -> Result<Option<CrdtHealthSummary>> {
        Ok(Some(DieselSqliteStore::crdt_health_summary(self)?))
    }

    fn scoped_rows_health_summary(
        &mut self,
        subscriptions: &[SubscriptionSpec],
    ) -> Result<Option<ScopedRowsHealthSummary>> {
        Ok(Some(DieselSqliteStore::scoped_rows_health_summary(
            self,
            subscriptions,
        )?))
    }

    fn clear_orphaned_synced_rows(
        &mut self,
        subscriptions: &[SubscriptionSpec],
        tables: &[String],
    ) -> Result<ScopedRowsHealthSummary> {
        DieselSqliteStore::clear_orphaned_synced_rows(self, subscriptions, tables)
    }

    fn resolve_conflict(&mut self, id_value: &str, resolution_value: &str) -> Result<()> {
        sql_query(
            r#"
            update sync_conflicts
            set resolved_at = ?1, resolution = ?2
            where id = ?3 and resolved_at is null
            "#,
        )
        .bind::<BigInt, _>(now_ms())
        .bind::<Text, _>(resolution_value)
        .bind::<Text, _>(id_value)
        .execute(&mut self.conn)?;
        Ok(())
    }

    fn retry_conflict_keep_local(&mut self, id_value: &str) -> Result<String> {
        self.transaction(|tx| tx.retry_conflict_keep_local(id_value))
    }
}

impl<'a> DieselSqliteTx<'a> {
    #[cfg(feature = "demo-todo-native-fixture")]
    fn add_task(
        &mut self,
        actor_id: &str,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        let operation = insert_local_task(self.conn, actor_id, project_id, &task_id, &title_value)?;
        self.enqueue_outbox(vec![operation])?;

        Ok(())
    }

    #[cfg(feature = "demo-todo-native-fixture")]
    fn patch_task_title(
        &mut self,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        let operation = patch_local_task_title(self.conn, project_id, &task_id, &title_value)?;
        self.enqueue_outbox(vec![operation])?;

        Ok(())
    }

    fn enqueue_outbox_receipt(
        &mut self,
        operations: Vec<SyncOperation>,
    ) -> Result<MutationReceipt> {
        use schema::sync_outbox_commits::dsl as o;

        self.assert_outbox_capacity()?;
        let id = Uuid::new_v4().to_string();
        let client_commit_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let row = NewOutboxCommit {
            id: id.clone(),
            client_commit_id: client_commit_id.clone(),
            status: "pending".to_string(),
            operations_json: sync_operations_json_for_outbox(&operations)?,
            last_response_json: None,
            error: None,
            created_at: now,
            updated_at: now,
            attempt_count: 0,
            acked_commit_seq: None,
            schema_version: self.app_schema.current_schema_version(),
            next_attempt_at: 0,
            lease_id: None,
            lease_expires_at_ms: None,
            lease_status_at_enqueue: None,
            lease_scope_summary_json: None,
            lease_token: None,
        };

        diesel::insert_into(o::sync_outbox_commits)
            .values(row)
            .execute(self.conn)?;

        Ok(MutationReceipt {
            commit_id: id,
            client_commit_id,
        })
    }

    fn enqueue_outbox(&mut self, operations: Vec<SyncOperation>) -> Result<String> {
        Ok(self.enqueue_outbox_receipt(operations)?.client_commit_id)
    }

    fn assert_outbox_capacity(&mut self) -> Result<()> {
        let unresolved = sql_query(
            r#"
            select count(*) as count
            from sync_outbox_commits
            where status <> 'acked'
            "#,
        )
        .load::<CountRow>(self.conn)?
        .into_iter()
        .next()
        .map(|row| row.count)
        .unwrap_or(0);
        validate_unresolved_outbox_capacity(usize::try_from(unresolved).unwrap_or(usize::MAX))
    }

    fn retry_conflict_keep_local(&mut self, conflict_id: &str) -> Result<String> {
        let row = sql_query(
            r#"
            select c.server_version as server_version,
                   c.op_index as op_index,
                   o.operations_json as operations_json
            from sync_conflicts c
            join sync_outbox_commits o on o.id = c.outbox_commit_id
            where c.id = ?1 and c.resolved_at is null
            limit 1
            "#,
        )
        .bind::<Text, _>(conflict_id)
        .load::<ConflictRetryRow>(self.conn)?
        .into_iter()
        .next()
        .ok_or_else(|| {
            SyncularError::config(format!("pending conflict not found: {conflict_id}"))
        })?;

        let mut operations: Vec<SyncOperation> = serde_json::from_str(&row.operations_json)?;
        let operation = operations.get_mut(row.op_index as usize).ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "conflict op index {} out of bounds",
                row.op_index
            ))
        })?;
        operation.base_version = Some(row.server_version);
        let retry_client_commit_id = self.enqueue_outbox(vec![operation.clone()])?;

        sql_query(
            r#"
            update sync_conflicts
            set resolved_at = ?1, resolution = 'keep-local'
            where id = ?2 and resolved_at is null
            "#,
        )
        .bind::<BigInt, _>(now_ms())
        .bind::<Text, _>(conflict_id)
        .execute(self.conn)?;

        Ok(retry_client_commit_id)
    }

    fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        if is_encrypted_crdt_system_table(&operation.table) {
            match operation.op.as_str() {
                "upsert" => {
                    let row = apply_encrypted_crdt_system_row(
                        self.conn,
                        &operation.table,
                        &operation.row_id,
                        local_row.as_ref().or(operation.payload.as_ref()),
                        None,
                    )?;
                    materialize_encrypted_crdt_system_row(
                        self.conn,
                        self.app_schema,
                        &operation.table,
                        &row,
                    )?;
                }
                "delete" => delete_encrypted_crdt_system_row(
                    self.conn,
                    &operation.table,
                    &operation.row_id,
                )?,
                op => {
                    return Err(SyncularError::protocol_message(format!(
                        "unsupported local operation: {op}"
                    )));
                }
            }
            return self.enqueue_outbox(vec![operation]);
        }

        let metadata = self
            .app_schema
            .table_metadata(&operation.table)
            .ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {}", operation.table))
            })?;
        let current_row = self.current_row_json(&operation.table, &operation.row_id)?;
        let current_server_version =
            self.row_server_version(&operation.table, current_row.as_ref());
        let yjs_updates = collect_server_merge_yjs_updates(self.app_schema, metadata, &operation)?;
        let local_row = transform_local_row_for_metadata(
            &operation.table,
            &operation.row_id,
            local_row,
            operation.payload.as_ref(),
            current_row.as_ref(),
            metadata,
        )?;

        match operation.op.as_str() {
            "upsert" => {
                let row = local_row.unwrap_or_else(|| {
                    merged_local_row(
                        metadata,
                        current_row,
                        &operation.row_id,
                        operation.payload.as_ref(),
                    )
                });
                let local_server_version = if operation_payload_has_server_merge_yjs_payload(
                    operation.payload.as_ref(),
                    metadata,
                ) {
                    current_server_version.or(operation.base_version)
                } else {
                    Some(operation.base_version.unwrap_or(0))
                };
                self.upsert_row(&operation.table, &row, local_server_version)?;
            }
            "delete" => {
                self.apply_change(&SyncChange {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    op: "delete".to_string(),
                    row_json: None,
                    row_version: operation.base_version,
                    scopes: Map::new(),
                })?;
            }
            op => {
                return Err(SyncularError::protocol_message(format!(
                    "unsupported local operation: {op}"
                )));
            }
        }

        let client_commit_id = self.enqueue_outbox(vec![operation])?;
        for (field, update) in yjs_updates {
            let row = self.current_row_json(field.table(), field.row_id())?;
            let state_base64 = crdt_field_state_base64(&field, row.as_ref());
            let state_vector_base64 = yjs_state_vector_base64(state_base64.as_deref())?;
            record_crdt_update_log(
                self.conn,
                &field,
                &update,
                Some(&client_commit_id),
                CrdtUpdateOrigin::Local,
                CrdtUpdateStatus::Pending,
                state_base64.as_deref(),
                &state_vector_base64,
            )?;
        }
        Ok(client_commit_id)
    }

    fn apply_local_operation_with_active_auth_lease(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        let pre_delete_scope = if operation.op == "delete" {
            Some(self.operation_scope_for_current_row(&operation)?)
        } else {
            None
        };
        let client_commit_id = self.apply_local_operation(operation.clone(), local_row)?;
        let operation_scope = pre_delete_scope
            .map(Ok)
            .unwrap_or_else(|| self.operation_scope_for_current_row(&operation))?;
        let provenance = self.select_active_auth_lease_for_operations(
            ActiveAuthLeasePolicy {
                actor_id,
                now_ms: now_ms_value,
            },
            &[operation_scope],
        )?;
        self.set_outbox_auth_lease(&client_commit_id, Some(&provenance))?;
        Ok(client_commit_id)
    }

    fn operation_scope_for_current_row(
        &mut self,
        operation: &SyncOperation,
    ) -> Result<MutationOperationScope> {
        if is_encrypted_crdt_system_table(&operation.table) {
            return Ok(system_table_operation_scope(operation));
        }
        let metadata = self
            .app_schema
            .table_metadata(&operation.table)
            .ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {}", operation.table))
            })?;
        let row = self.current_row_json(&operation.table, &operation.row_id)?;
        Ok(app_table_operation_scope(
            metadata,
            operation,
            row.as_ref(),
            row.is_some() || operation.op == "upsert",
        ))
    }

    fn apply_crdt_field_yjs_update(
        &mut self,
        field: &CrdtField,
        update: YjsUpdateEnvelope,
        max_pending_updates: i64,
    ) -> Result<String> {
        assert_crdt_document_capacity(self.conn, &field.document_key(), max_pending_updates)?;
        let mut envelope = Map::new();
        envelope.insert(field.field().to_string(), serde_json::to_value(&update)?);
        let mut payload = Map::new();
        payload.insert(YJS_PAYLOAD_KEY.to_string(), Value::Object(envelope));
        let operation = SyncOperation {
            table: field.table().to_string(),
            row_id: field.row_id().to_string(),
            op: "upsert".to_string(),
            payload: Some(Value::Object(payload)),
            base_version: None,
        };
        let client_commit_id = self.apply_local_operation(operation, None)?;
        let row = self.current_row_json(field.table(), field.row_id())?;
        let state_base64 = crdt_field_state_base64(field, row.as_ref());
        let state_vector_base64 = yjs_state_vector_base64(state_base64.as_deref())?;
        record_crdt_update_log(
            self.conn,
            field,
            &update,
            Some(&client_commit_id),
            CrdtUpdateOrigin::Local,
            CrdtUpdateStatus::Pending,
            state_base64.as_deref(),
            &state_vector_base64,
        )?;
        Ok(client_commit_id)
    }

    fn apply_syncular_mutations(
        &mut self,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.apply_syncular_mutations_inner(mutations, None)
    }

    fn apply_syncular_mutations_with_active_auth_lease(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.apply_syncular_mutations_inner(
            mutations,
            Some(ActiveAuthLeasePolicy {
                actor_id,
                now_ms: now_ms_value,
            }),
        )
    }

    fn apply_syncular_mutations_with_command_history(
        &mut self,
        mutation_scope: &str,
        actor_id: Option<&str>,
        now_ms_value: i64,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        let pending = self.command_history_pending_entries(&mutations)?;
        let receipt = match mutation_scope {
            "mutations" => self.apply_syncular_mutations_inner(mutations, None)?,
            "leasedMutations" => self.apply_syncular_mutations_inner(
                mutations,
                Some(ActiveAuthLeasePolicy {
                    actor_id,
                    now_ms: now_ms_value,
                }),
            )?,
            other => {
                return Err(SyncularError::config(format!(
                    "sync.command_history_scope_unsupported: {other}"
                )));
            }
        };
        let entries = self.command_history_committed_entries(pending)?;
        if !entries.is_empty() {
            insert_command_history_record(self.conn, mutation_scope, &entries, &receipt)?;
        }
        Ok(receipt)
    }

    fn command_history_pending_entries(
        &mut self,
        mutations: &[PendingSyncularMutation],
    ) -> Result<Vec<PendingCommandHistoryEntry>> {
        let mut entries = Vec::new();
        for mutation in mutations {
            if entries.iter().any(|entry: &PendingCommandHistoryEntry| {
                entry.table == mutation.table && entry.row_id == mutation.row_id
            }) {
                continue;
            }
            let before = self.current_row_json(&mutation.table, &mutation.row_id)?;
            entries.push(PendingCommandHistoryEntry {
                table: mutation.table.clone(),
                row_id: mutation.row_id.clone(),
                before,
            });
        }
        Ok(entries)
    }

    fn command_history_committed_entries(
        &mut self,
        pending: Vec<PendingCommandHistoryEntry>,
    ) -> Result<Vec<CommandHistoryEntry>> {
        let mut entries = Vec::new();
        for entry in pending {
            let after = self.current_row_json(&entry.table, &entry.row_id)?;
            if entry.before == after {
                continue;
            }
            entries.push(CommandHistoryEntry {
                table: entry.table,
                row_id: entry.row_id,
                before: entry.before,
                after,
            });
        }
        Ok(entries)
    }

    fn apply_syncular_mutations_inner(
        &mut self,
        mutations: Vec<PendingSyncularMutation>,
        auth_lease_policy: Option<ActiveAuthLeasePolicy<'_>>,
    ) -> Result<MutationReceipt> {
        if mutations.is_empty() {
            return Err(SyncularError::config(
                "cannot commit an empty Syncular mutation batch",
            ));
        }
        validate_pending_mutation_batch_size(&mutations)?;

        let mut operations = Vec::with_capacity(mutations.len());
        let mut operation_scopes = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            if is_encrypted_crdt_system_table(&mutation.table) {
                let operation = mutation.operation(None);
                operation_scopes.push(system_table_operation_scope(&operation));
                match mutation.kind {
                    SyncularMutationKind::Delete => {
                        delete_encrypted_crdt_system_row(
                            self.conn,
                            &mutation.table,
                            &mutation.row_id,
                        )?;
                    }
                    SyncularMutationKind::Insert
                    | SyncularMutationKind::Update
                    | SyncularMutationKind::Upsert => {
                        let row = apply_encrypted_crdt_system_row(
                            self.conn,
                            &mutation.table,
                            &mutation.row_id,
                            mutation.local_row.as_ref().or(operation.payload.as_ref()),
                            None,
                        )?;
                        materialize_encrypted_crdt_system_row(
                            self.conn,
                            self.app_schema,
                            &mutation.table,
                            &row,
                        )?;
                    }
                }
                operations.push(operation);
                continue;
            }

            if self.app_schema.table_metadata(&mutation.table).is_none() {
                return Err(SyncularError::config(format!(
                    "unknown generated app table: {}",
                    mutation.table
                )));
            }

            let metadata = self
                .app_schema
                .table_metadata(&mutation.table)
                .expect("validated mutation table has metadata");
            let current_row = self.current_row_json(&mutation.table, &mutation.row_id)?;
            let current_server_version =
                self.row_server_version(&mutation.table, current_row.as_ref());
            let base_version = mutation.base_version.or_else(|| {
                if mutation_has_server_merge_yjs_payload(&mutation, metadata) {
                    return None;
                }

                match mutation.kind {
                    SyncularMutationKind::Insert => None,
                    SyncularMutationKind::Update
                    | SyncularMutationKind::Upsert
                    | SyncularMutationKind::Delete => current_server_version,
                }
            });
            let operation = mutation.operation(base_version);

            match mutation.kind {
                SyncularMutationKind::Delete => {
                    operation_scopes.push(app_table_operation_scope(
                        metadata,
                        &operation,
                        current_row.as_ref(),
                        current_row.is_some(),
                    ));
                    self.apply_change(&SyncChange {
                        table: mutation.table.clone(),
                        row_id: mutation.row_id.clone(),
                        op: "delete".to_string(),
                        row_json: None,
                        row_version: base_version,
                        scopes: Map::new(),
                    })?;
                }
                SyncularMutationKind::Insert
                | SyncularMutationKind::Update
                | SyncularMutationKind::Upsert => {
                    let local_row = transform_local_row_for_metadata(
                        &mutation.table,
                        &mutation.row_id,
                        mutation.local_row,
                        operation.payload.as_ref(),
                        current_row.as_ref(),
                        metadata,
                    )?;
                    let local_row = local_row.unwrap_or_else(|| {
                        merged_local_row(
                            metadata,
                            current_row,
                            &mutation.row_id,
                            operation.payload.as_ref(),
                        )
                    });
                    operation_scopes.push(app_table_operation_scope(
                        metadata,
                        &operation,
                        Some(&local_row),
                        true,
                    ));
                    self.upsert_row(
                        &mutation.table,
                        &local_row,
                        current_server_version.or(base_version),
                    )?;
                }
            }

            operations.push(operation);
        }

        let receipt = self.enqueue_outbox_receipt(operations)?;
        if let Some(policy) = auth_lease_policy {
            let provenance =
                self.select_active_auth_lease_for_operations(policy, &operation_scopes)?;
            self.set_outbox_auth_lease(&receipt.client_commit_id, Some(&provenance))?;
        }
        Ok(receipt)
    }

    fn select_active_auth_lease_for_operations(
        &mut self,
        policy: ActiveAuthLeasePolicy<'_>,
        operations: &[MutationOperationScope],
    ) -> Result<AuthLeaseProvenance> {
        let candidate_leases = self.auth_lease_candidates_for_selection(policy.actor_id)?;
        select_auth_lease_for_operation_scopes(
            policy,
            candidate_leases,
            self.app_schema.current_schema_version(),
            operations,
        )
    }

    fn auth_lease_candidates_for_selection(
        &mut self,
        actor_id_value: Option<&str>,
    ) -> Result<Vec<AuthLeaseRecord>> {
        use schema::sync_auth_leases::dsl as l;

        let mut query = l::sync_auth_leases
            .select(AuthLeaseRecordRow::as_select())
            .filter(l::status.eq("active"))
            .into_boxed();
        if let Some(actor_id_value) = actor_id_value {
            query = query.filter(l::actor_id.eq(actor_id_value));
        }
        let rows = query.order(l::expires_at_ms.asc()).load(self.conn)?;
        Ok(rows.into_iter().map(AuthLeaseRecord::from).collect())
    }

    fn current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        current_app_row_json(self.conn, self.app_schema, table, row_id)
    }

    fn row_server_version(&self, table: &str, row: Option<&Value>) -> Option<i64> {
        let metadata = self.app_schema.table_metadata(table)?;
        row.and_then(|row| {
            row.get(metadata.server_version_column)
                .and_then(Value::as_i64)
        })
    }
}

fn merged_local_row(
    metadata: &AppTableMetadata,
    current_row: Option<Value>,
    row_id: &str,
    payload: Option<&Value>,
) -> Value {
    let mut row = current_row
        .and_then(|row| row.as_object().cloned())
        .unwrap_or_default();
    if let Some(payload) = payload.and_then(Value::as_object) {
        for (key, value) in payload {
            row.insert(key.clone(), value.clone());
        }
    }
    row.insert(
        metadata.primary_key_column.to_string(),
        Value::String(row_id.to_string()),
    );
    Value::Object(row)
}

fn apply_encrypted_crdt_system_row(
    conn: &mut SqliteConnection,
    table: &str,
    row_id: &str,
    row: Option<&Value>,
    server_seq: Option<i64>,
) -> Result<Map<String, Value>> {
    let row = encrypted_crdt_normalize_row(table, row_id, row)?;
    let server_seq = server_seq
        .or_else(|| row.get("server_seq").and_then(Value::as_i64))
        .or_else(|| row.get("seq").and_then(Value::as_i64));
    let scopes_json = encrypted_crdt_scopes_json(&row)?;
    let partition_id = row
        .get("partition_id")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let stream_id = row.get("stream_id").and_then(Value::as_str).unwrap();
    let app_table = row.get("app_table").and_then(Value::as_str).unwrap();
    let app_row_id = row.get("row_id").and_then(Value::as_str).unwrap();
    let field_name = row.get("field_name").and_then(Value::as_str).unwrap();
    let key_id = row.get("key_id").and_then(Value::as_str).unwrap();
    let ciphertext = row.get("ciphertext").and_then(Value::as_str).unwrap();
    let actor_id = row.get("actor_id").and_then(Value::as_str);
    let client_id = row.get("client_id").and_then(Value::as_str);
    let created_at = row
        .get("created_at")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms);

    match table {
        CRDT_UPDATES_TABLE => {
            let update_id = row.get("update_id").and_then(Value::as_str).unwrap();
            sql_query(
                r#"
                insert into sync_crdt_updates (
                    partition_id, stream_id, app_table, row_id, field_name,
                    update_id, actor_id, client_id, key_id, ciphertext, scopes, created_at,
                    server_seq
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                on conflict (update_id) do update set
                    server_seq = coalesce(excluded.server_seq, sync_crdt_updates.server_seq)
                "#,
            )
            .bind::<Text, _>(partition_id)
            .bind::<Text, _>(stream_id)
            .bind::<Text, _>(app_table)
            .bind::<Text, _>(app_row_id)
            .bind::<Text, _>(field_name)
            .bind::<Text, _>(update_id)
            .bind::<diesel::sql_types::Nullable<Text>, _>(actor_id)
            .bind::<diesel::sql_types::Nullable<Text>, _>(client_id)
            .bind::<Text, _>(key_id)
            .bind::<Text, _>(ciphertext)
            .bind::<Text, _>(&scopes_json)
            .bind::<BigInt, _>(created_at)
            .bind::<diesel::sql_types::Nullable<BigInt>, _>(server_seq)
            .execute(conn)?;
        }
        CRDT_CHECKPOINTS_TABLE => {
            let checkpoint_id = row.get("checkpoint_id").and_then(Value::as_str).unwrap();
            let covers_seq = row.get("covers_seq").and_then(Value::as_i64).unwrap();
            sql_query(
                r#"
                insert into sync_crdt_checkpoints (
                    partition_id, stream_id, app_table, row_id, field_name,
                    checkpoint_id, covers_seq, actor_id, client_id, key_id,
                    ciphertext, scopes, created_at, server_seq
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                on conflict (checkpoint_id) do update set
                    server_seq = coalesce(excluded.server_seq, sync_crdt_checkpoints.server_seq)
                "#,
            )
            .bind::<Text, _>(partition_id)
            .bind::<Text, _>(stream_id)
            .bind::<Text, _>(app_table)
            .bind::<Text, _>(app_row_id)
            .bind::<Text, _>(field_name)
            .bind::<Text, _>(checkpoint_id)
            .bind::<BigInt, _>(covers_seq)
            .bind::<diesel::sql_types::Nullable<Text>, _>(actor_id)
            .bind::<diesel::sql_types::Nullable<Text>, _>(client_id)
            .bind::<Text, _>(key_id)
            .bind::<Text, _>(ciphertext)
            .bind::<Text, _>(&scopes_json)
            .bind::<BigInt, _>(created_at)
            .bind::<diesel::sql_types::Nullable<BigInt>, _>(server_seq)
            .execute(conn)?;
        }
        _ => unreachable!("validated encrypted CRDT table"),
    }
    Ok(row)
}

fn delete_encrypted_crdt_system_row(
    conn: &mut SqliteConnection,
    table: &str,
    row_id: &str,
) -> Result<()> {
    let identity = encrypted_crdt_identity_column(table)?;
    let sql = format!("delete from {table} where {identity} = ?1");
    sql_query(sql).bind::<Text, _>(row_id).execute(conn)?;
    Ok(())
}

fn update_encrypted_crdt_system_server_seq(
    conn: &mut SqliteConnection,
    table: &str,
    row_id: &str,
    server_seq: i64,
) -> Result<()> {
    let identity = encrypted_crdt_identity_column(table)?;
    let sql = format!("update {table} set server_seq = ?1 where {identity} = ?2");
    sql_query(sql)
        .bind::<BigInt, _>(server_seq)
        .bind::<Text, _>(row_id)
        .execute(conn)?;
    Ok(())
}

fn materialize_encrypted_crdt_system_row(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    system_table: &str,
    system_row: &Map<String, Value>,
) -> Result<()> {
    let app_table = system_row
        .get("app_table")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncularError::protocol_message("encrypted CRDT row missing app_table"))?;
    let app_row_id = system_row
        .get("row_id")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncularError::protocol_message("encrypted CRDT row missing row_id"))?;
    let field_name = system_row
        .get("field_name")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncularError::protocol_message("encrypted CRDT row missing field_name"))?;
    let Some(metadata) = app_schema.table_metadata(app_table) else {
        return Ok(());
    };
    if !metadata
        .crdt_yjs_fields
        .iter()
        .any(|field| field.field == field_name && field.sync_mode == "encrypted-update-log")
    {
        return Ok(());
    }
    let current_row = current_app_row_json(conn, app_schema, app_table, app_row_id)?;
    let Some(row) = apply_encrypted_crdt_plaintext_to_row(
        metadata,
        field_name,
        app_row_id,
        system_table,
        system_row,
        current_row,
    )?
    else {
        return Ok(());
    };
    let fallback_version = row
        .get(metadata.server_version_column)
        .and_then(Value::as_i64)
        .or(Some(0));
    upsert_app_row(conn, app_schema, app_table, &row, fallback_version)?;
    Ok(())
}

fn current_app_row_json(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    row_id: &str,
) -> Result<Option<Value>> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    get_app_row_json_generic(conn, metadata, row_id)
}

fn get_app_row_json_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    row_id: &str,
) -> Result<Option<Value>> {
    validate_app_table_metadata(metadata)?;
    let projection = json_object_projection(metadata)?;
    let sql = format!(
        "select {projection} as row_json from {table} where {pk} = {row_id} limit 1",
        table = metadata.name,
        pk = metadata.primary_key_column,
        row_id = sql_string(row_id)
    );
    Ok(rows_from_json_query(conn, sql)?.into_iter().next())
}

fn crdt_state_vector_hints_for_subscription(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    scopes: &ScopeValues,
    limit: i64,
) -> Result<Vec<CrdtStateVectorHint>> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    validate_app_table_metadata(metadata)?;
    let rows = sql_query(
        r#"
        select document_key, app_table, row_id, field_name, state_column, sync_mode,
               state_base64, state_vector_base64, pending_updates, flushed_updates,
               acked_updates, log_updates, updated_at, compacted_at
        from sync_crdt_documents
        where app_table = ?1 and state_vector_base64 != ''
        order by updated_at desc
        limit ?2
        "#,
    )
    .bind::<Text, _>(table)
    .bind::<BigInt, _>(limit.max(0))
    .load::<CrdtDocumentSnapshotRow>(conn)?;

    let mut hints = Vec::new();
    for row in rows {
        let Some(app_row) = get_app_row_json_generic(conn, metadata, &row.row_id)? else {
            continue;
        };
        if !row_matches_scope_values(metadata, &app_row, scopes) {
            continue;
        }
        hints.push(CrdtStateVectorHint {
            row_id: row.row_id,
            field: row.field_name,
            state_column: row.state_column,
            state_vector_base64: row.state_vector_base64,
            sync_mode: row.sync_mode,
            updated_at: row.updated_at,
        });
    }
    Ok(hints)
}

fn clear_encrypted_crdt_system_table_for_scopes(
    conn: &mut SqliteConnection,
    table: &str,
    scopes: &ScopeValues,
) -> Result<()> {
    let identity = encrypted_crdt_identity_column(table)?;
    if scopes.is_empty() {
        let sql = format!("delete from {table}");
        sql_query(sql).execute(conn)?;
        return Ok(());
    }

    let sql = format!("select {identity} as identity, scopes from {table}");
    let rows = sql_query(sql).load::<EncryptedCrdtScopeRow>(conn)?;
    for row in rows {
        let stored_scopes: Value = serde_json::from_str(&row.scopes)?;
        let mut object = Map::new();
        object.insert("scopes".to_string(), stored_scopes);
        if encrypted_crdt_row_matches_scopes(&object, scopes) {
            delete_encrypted_crdt_system_row(conn, table, &row.identity)?;
        }
    }
    Ok(())
}

fn list_app_rows_json(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
) -> Result<Vec<Value>> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    match app_schema.adapter_for(table) {
        Ok(adapter) => adapter.list_rows_json(conn),
        Err(_) => list_rows_json_generic(conn, metadata),
    }
}

fn clear_app_table_for_scopes(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    scopes: &ScopeValues,
) -> Result<()> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    match app_schema.adapter_for(table) {
        Ok(adapter) => adapter.clear_for_scopes(conn, scopes),
        Err(_) => clear_table_for_scopes_generic(conn, metadata, scopes),
    }
}

fn clear_app_table_for_scopes_preserving_local_crdt(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    scopes: &ScopeValues,
) -> Result<()> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    let encrypted_fields = metadata
        .crdt_yjs_fields
        .iter()
        .filter(|field| field.sync_mode == "encrypted-update-log")
        .collect::<Vec<_>>();
    if encrypted_fields.is_empty() {
        return clear_app_table_for_scopes(conn, app_schema, table, scopes);
    }

    validate_app_table_metadata(metadata)?;
    for field in &encrypted_fields {
        validate_identifier(field.state_column)?;
    }
    let mut filters = scope_filters(metadata, scopes)?;
    filters.extend(encrypted_fields.iter().map(|field| {
        format!(
            "({} is null or {} = '')",
            field.state_column, field.state_column
        )
    }));
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!(" where {}", filters.join(" and "))
    };
    let sql = format!("delete from {table}{where_clause}", table = metadata.name);
    sql_query(sql).execute(conn)?;
    Ok(())
}

fn clear_synced_app_rows_for_scopes(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    scopes: &ScopeValues,
) -> Result<i64> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    clear_synced_rows_for_scopes_generic(conn, metadata, scopes)
}

fn scoped_rows_health_summary_for_schema(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    subscriptions: &[SubscriptionSpec],
) -> Result<ScopedRowsHealthSummary> {
    let mut summary = ScopedRowsHealthSummary::default();
    for metadata in app_schema.app_table_metadata {
        validate_app_table_metadata(metadata)?;
        validate_identifier(metadata.server_version_column)?;
        let checked_synced_rows = count_rows(
            conn,
            &format!(
                "select count(*) as count from {table} where {server_version} > 0",
                table = metadata.name,
                server_version = metadata.server_version_column
            ),
        )?;
        let table_subscriptions = subscriptions
            .iter()
            .filter(|subscription| subscription.table == metadata.name)
            .collect::<Vec<_>>();
        let orphaned_synced_rows = if checked_synced_rows == 0 {
            0
        } else if table_subscriptions.is_empty() {
            checked_synced_rows
        } else {
            let scope_clauses = table_subscriptions
                .iter()
                .map(|subscription| scope_clause(metadata, &subscription.scopes))
                .collect::<Result<Vec<_>>>()?;
            count_rows(
                conn,
                &format!(
                    "select count(*) as count from {table} where {server_version} > 0 and not ({scope_clause})",
                    table = metadata.name,
                    server_version = metadata.server_version_column,
                    scope_clause = scope_clauses.join(" or ")
                ),
            )?
        };
        summary.checked_synced_rows += checked_synced_rows;
        summary.orphaned_synced_rows += orphaned_synced_rows;
        summary.tables.push(ScopedRowsTableHealth {
            table: metadata.name.to_string(),
            checked_synced_rows,
            orphaned_synced_rows,
        });
    }
    Ok(summary)
}

fn clear_orphaned_synced_rows_for_schema(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    subscriptions: &[SubscriptionSpec],
    tables: &[String],
) -> Result<ScopedRowsHealthSummary> {
    validate_requested_app_tables(app_schema, tables)?;
    let mut summary = ScopedRowsHealthSummary::default();
    for metadata in app_schema
        .app_table_metadata
        .iter()
        .filter(|metadata| tables.is_empty() || tables.iter().any(|table| table == metadata.name))
    {
        validate_app_table_metadata(metadata)?;
        validate_identifier(metadata.server_version_column)?;
        let checked_synced_rows = count_rows(
            conn,
            &format!(
                "select count(*) as count from {table} where {server_version} > 0",
                table = metadata.name,
                server_version = metadata.server_version_column
            ),
        )?;
        let table_subscriptions = subscriptions
            .iter()
            .filter(|subscription| subscription.table == metadata.name)
            .collect::<Vec<_>>();
        let orphaned_synced_rows = if checked_synced_rows == 0 {
            0
        } else if table_subscriptions.is_empty() {
            delete_rows_with_count(
                conn,
                &format!(
                    "delete from {table} where {server_version} > 0",
                    table = metadata.name,
                    server_version = metadata.server_version_column
                ),
            )?
        } else {
            let scope_clauses = table_subscriptions
                .iter()
                .map(|subscription| scope_clause(metadata, &subscription.scopes))
                .collect::<Result<Vec<_>>>()?;
            delete_rows_with_count(
                conn,
                &format!(
                    "delete from {table} where {server_version} > 0 and not ({scope_clause})",
                    table = metadata.name,
                    server_version = metadata.server_version_column,
                    scope_clause = scope_clauses.join(" or ")
                ),
            )?
        };
        summary.checked_synced_rows += checked_synced_rows;
        summary.orphaned_synced_rows += orphaned_synced_rows;
        summary.tables.push(ScopedRowsTableHealth {
            table: metadata.name.to_string(),
            checked_synced_rows,
            orphaned_synced_rows,
        });
    }
    Ok(summary)
}

fn validate_requested_app_tables(app_schema: AppSchema, tables: &[String]) -> Result<()> {
    for table in tables {
        if app_schema.table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {table}"
            )));
        }
    }
    Ok(())
}

fn count_rows(conn: &mut SqliteConnection, sql: &str) -> Result<i64> {
    Ok(sql_query(sql)
        .load::<CountRow>(conn)?
        .into_iter()
        .next()
        .map(|row| row.count)
        .unwrap_or_default())
}

fn delete_rows_with_count(conn: &mut SqliteConnection, sql: &str) -> Result<i64> {
    Ok(sql_query(sql).execute(conn)? as i64)
}

fn preserve_encrypted_crdt_materialized_columns(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    metadata: &'static AppTableMetadata,
    row: Value,
) -> Result<Value> {
    if !metadata
        .crdt_yjs_fields
        .iter()
        .any(|field| field.sync_mode == "encrypted-update-log")
    {
        return Ok(row);
    }
    let Some(mut row_object) = row.as_object().cloned() else {
        return Ok(row);
    };
    let Some(row_id) = row_object
        .get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(Value::Object(row_object));
    };
    let Some(existing_row) = current_app_row_json(conn, app_schema, metadata.name, &row_id)? else {
        return Ok(Value::Object(row_object));
    };
    let Some(existing_object) = existing_row.as_object() else {
        return Ok(Value::Object(row_object));
    };

    for field in metadata
        .crdt_yjs_fields
        .iter()
        .filter(|field| field.sync_mode == "encrypted-update-log")
    {
        let Some(state) = existing_object
            .get(field.state_column)
            .and_then(Value::as_str)
            .filter(|state| !state.is_empty())
        else {
            continue;
        };
        row_object.insert(
            field.state_column.to_string(),
            Value::String(state.to_string()),
        );
        if let Some(value) = existing_object.get(field.field) {
            row_object.insert(field.field.to_string(), value.clone());
        }
    }
    Ok(Value::Object(row_object))
}

fn upsert_app_row(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    table: &str,
    row: &Value,
    fallback_version: Option<i64>,
) -> Result<()> {
    let metadata = app_schema
        .table_metadata(table)
        .ok_or_else(|| SyncularError::config(format!("unknown generated app table: {table}")))?;
    match app_schema.adapter_for(table) {
        Ok(adapter) => adapter.upsert_row(conn, row, fallback_version),
        Err(_) => upsert_row_generic(conn, metadata, row, fallback_version),
    }
}

fn apply_app_change(
    conn: &mut SqliteConnection,
    app_schema: AppSchema,
    change: &SyncChange,
) -> Result<()> {
    let metadata = app_schema.table_metadata(&change.table).ok_or_else(|| {
        SyncularError::config(format!("unknown generated app table: {}", change.table))
    })?;
    if change.op == "upsert" && change.row_json.is_some() {
        let mut change = change.clone();
        let row = change.row_json.take().expect("checked row_json presence");
        change.row_json = Some(preserve_encrypted_crdt_materialized_columns(
            conn, app_schema, metadata, row,
        )?);
        return match app_schema.adapter_for(&change.table) {
            Ok(adapter) => adapter.apply_change(conn, &change),
            Err(_) => apply_change_generic(conn, metadata, &change),
        };
    }
    match app_schema.adapter_for(&change.table) {
        Ok(adapter) => adapter.apply_change(conn, change),
        Err(_) => apply_change_generic(conn, metadata, change),
    }
}

fn list_rows_json_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
) -> Result<Vec<Value>> {
    validate_app_table_metadata(metadata)?;
    let projection = json_object_projection(metadata)?;
    let sql = format!(
        "select {projection} as row_json from {table} order by {pk} asc",
        table = metadata.name,
        pk = metadata.primary_key_column
    );
    rows_from_json_query(conn, sql)
}

fn clear_table_for_scopes_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    scopes: &ScopeValues,
) -> Result<()> {
    validate_app_table_metadata(metadata)?;
    let filters = scope_filters(metadata, scopes)?;
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!(" where {}", filters.join(" and "))
    };
    let sql = format!("delete from {table}{where_clause}", table = metadata.name);
    sql_query(sql).execute(conn)?;
    Ok(())
}

fn clear_synced_rows_for_scopes_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    scopes: &ScopeValues,
) -> Result<i64> {
    validate_app_table_metadata(metadata)?;
    validate_identifier(metadata.server_version_column)?;
    let mut filters = scope_filters(metadata, scopes)?;
    filters.push(format!("{} > 0", metadata.server_version_column));
    let sql = format!(
        "delete from {table} where {where_clause}",
        table = metadata.name,
        where_clause = filters.join(" and ")
    );
    Ok(sql_query(sql).execute(conn)? as i64)
}

fn upsert_row_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    row: &Value,
    fallback_version: Option<i64>,
) -> Result<()> {
    validate_app_table_metadata(metadata)?;
    let row = row.as_object().ok_or_else(|| {
        SyncularError::protocol_message(format!("row is not a JSON object: {row}"))
    })?;
    row.get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "row for table {} is missing string primary key {}",
                metadata.name, metadata.primary_key_column
            ))
        })?;

    let columns = syncable_columns(metadata);
    if columns.is_empty() {
        return Ok(());
    }
    let values = columns
        .iter()
        .map(|column| generic_column_sql_value(metadata, row, column, fallback_version))
        .collect::<Result<Vec<_>>>()?;
    let update_columns = columns
        .iter()
        .copied()
        .filter(|column| *column != metadata.primary_key_column)
        .collect::<Vec<_>>();
    let on_conflict = if update_columns.is_empty() {
        "do nothing".to_string()
    } else {
        format!(
            "do update set {}",
            update_columns
                .iter()
                .map(|column| format!("{column} = excluded.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    let sql = format!(
        "insert into {table} ({columns}) values ({values}) on conflict({pk}) {on_conflict}",
        table = metadata.name,
        columns = columns.join(", "),
        values = values.join(", "),
        pk = metadata.primary_key_column,
    );
    sql_query(sql).execute(conn)?;
    Ok(())
}

fn upsert_rows_generic_batch(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    rows: &[Map<String, Value>],
    fallback_version: Option<i64>,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    validate_app_table_metadata(metadata)?;

    let columns = syncable_columns(metadata);
    if columns.is_empty() {
        return Ok(());
    }
    let update_columns = columns
        .iter()
        .copied()
        .filter(|column| *column != metadata.primary_key_column)
        .collect::<Vec<_>>();
    let on_conflict = if update_columns.is_empty() {
        "do nothing".to_string()
    } else {
        format!(
            "do update set {}",
            update_columns
                .iter()
                .map(|column| format!("{column} = excluded.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    for batch in rows.chunks(SNAPSHOT_UPSERT_BATCH_ROWS) {
        let value_groups = batch
            .iter()
            .map(|row| {
                row.get(metadata.primary_key_column)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        SyncularError::protocol_message(format!(
                            "row for table {} is missing string primary key {}",
                            metadata.name, metadata.primary_key_column
                        ))
                    })?;
                let values = columns
                    .iter()
                    .map(|column| generic_column_sql_value(metadata, row, column, fallback_version))
                    .collect::<Result<Vec<_>>>()?;
                Ok(format!("({})", values.join(", ")))
            })
            .collect::<Result<Vec<_>>>()?;
        let sql = format!(
            "insert into {table} ({columns}) values {values} on conflict({pk}) {on_conflict}",
            table = metadata.name,
            columns = columns.join(", "),
            values = value_groups.join(", "),
            pk = metadata.primary_key_column,
        );
        sql_query(sql).execute(conn)?;
    }

    Ok(())
}

fn upsert_binary_snapshot_rows_batch(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    rows: &DecodedBinarySnapshotRows,
) -> Result<()> {
    if rows.rows.is_empty() {
        return Ok(());
    }
    if rows.table != metadata.name {
        return Err(SyncularError::protocol_message(format!(
            "binary snapshot table mismatch: expected {}, got {}",
            metadata.name, rows.table
        )));
    }
    validate_app_table_metadata(metadata)?;

    let columns = rows
        .columns
        .iter()
        .map(|column| {
            validate_identifier(&column.name)?;
            Ok(column.name.as_str())
        })
        .collect::<Result<Vec<_>>>()?;
    if !columns.contains(&metadata.primary_key_column) {
        return Err(SyncularError::protocol_message(format!(
            "binary snapshot for table {} is missing primary key {}",
            metadata.name, metadata.primary_key_column
        )));
    }
    if rows.rows.iter().any(|row| row.len() != columns.len()) {
        return Err(SyncularError::protocol_message(format!(
            "binary snapshot for table {} has a row with the wrong column count",
            metadata.name
        )));
    }

    let update_columns = columns
        .iter()
        .copied()
        .filter(|column| *column != metadata.primary_key_column)
        .collect::<Vec<_>>();
    let on_conflict = if update_columns.is_empty() {
        "do nothing".to_string()
    } else {
        format!(
            "do update set {}",
            update_columns
                .iter()
                .map(|column| format!("{column} = excluded.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    for batch in rows.rows.chunks(SNAPSHOT_UPSERT_BATCH_ROWS) {
        let value_groups = batch
            .iter()
            .map(|row| {
                let values = row
                    .iter()
                    .map(binary_snapshot_cell_sql_value)
                    .collect::<Result<Vec<_>>>()?;
                Ok(format!("({})", values.join(", ")))
            })
            .collect::<Result<Vec<_>>>()?;
        let sql = format!(
            "insert into {table} ({columns}) values {values} on conflict({pk}) {on_conflict}",
            table = metadata.name,
            columns = columns.join(", "),
            values = value_groups.join(", "),
            pk = metadata.primary_key_column,
        );
        sql_query(sql).execute(conn)?;
    }

    Ok(())
}

fn binary_snapshot_cell_sql_value(value: &BinarySnapshotCell) -> Result<String> {
    Ok(match value {
        BinarySnapshotCell::Null => "NULL".to_string(),
        BinarySnapshotCell::String(value) => sql_string(value),
        BinarySnapshotCell::Integer(value) => value.to_string(),
        BinarySnapshotCell::Float(value) => {
            if value.is_finite() {
                value.to_string()
            } else {
                return Err(SyncularError::protocol_message(
                    "binary snapshot float value must be finite",
                ));
            }
        }
        BinarySnapshotCell::Boolean(value) => i32::from(*value).to_string(),
        BinarySnapshotCell::Json(value) => sql_string(&value.to_string()),
        BinarySnapshotCell::Bytes(value) => {
            format!("X'{}'", hex::encode(value))
        }
    })
}

fn apply_change_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    change: &SyncChange,
) -> Result<()> {
    if change.table != metadata.name {
        return Err(SyncularError::schema(format!(
            "metadata for {} cannot apply change for {}",
            metadata.name, change.table
        )));
    }
    match change.op.as_str() {
        "delete" => delete_row_generic(conn, metadata, &change.row_id),
        "upsert" => {
            let row = change.row_json.as_ref().ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "upsert change missing row_json for {}",
                    change.row_id
                ))
            })?;
            upsert_row_generic(conn, metadata, row, change.row_version)
        }
        op => Err(SyncularError::protocol_message(format!(
            "unsupported sync change operation: {op}"
        ))),
    }
}

fn delete_row_generic(
    conn: &mut SqliteConnection,
    metadata: &AppTableMetadata,
    row_id: &str,
) -> Result<()> {
    validate_app_table_metadata(metadata)?;
    let sql = format!(
        "delete from {table} where {pk} = {row_id}",
        table = metadata.name,
        pk = metadata.primary_key_column,
        row_id = sql_string(row_id),
    );
    sql_query(sql).execute(conn)?;
    Ok(())
}

fn rows_from_json_query(conn: &mut SqliteConnection, sql: String) -> Result<Vec<Value>> {
    sql_query(sql)
        .load::<JsonObjectRow>(conn)?
        .into_iter()
        .map(|row| Ok(serde_json::from_str::<Value>(&row.row_json)?))
        .collect()
}

fn json_object_projection(metadata: &AppTableMetadata) -> Result<String> {
    let columns = syncable_columns(metadata);
    if columns.is_empty() {
        return Err(SyncularError::schema(format!(
            "app table {} has no declared columns",
            metadata.name
        )));
    }
    let pairs = columns
        .iter()
        .map(|column| {
            validate_identifier(column)?;
            Ok(format!("{label}, {column}", label = sql_string(column)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(format!("json_object({})", pairs.join(", ")))
}

fn generic_column_sql_value(
    metadata: &AppTableMetadata,
    row: &Map<String, Value>,
    column: &str,
    fallback_version: Option<i64>,
) -> Result<String> {
    if column == metadata.server_version_column {
        if let Some(version) = fallback_version {
            return Ok(version.to_string());
        }
        return Ok(row
            .get(column)
            .map(sql_value)
            .unwrap_or_else(|| "0".to_string()));
    }

    if let Some(value) = row.get(column) {
        return Ok(sql_value(value));
    }

    if column == metadata.primary_key_column {
        return Err(SyncularError::protocol_message(format!(
            "row for table {} is missing primary key {}",
            metadata.name, metadata.primary_key_column
        )));
    }

    let column_metadata = metadata
        .columns
        .iter()
        .find(|candidate| candidate.name == column);
    if column_metadata.is_some_and(|column| column.notnull_required) {
        return Err(SyncularError::protocol_message(format!(
            "row for table {} is missing required column {}",
            metadata.name, column
        )));
    }

    Ok("NULL".to_string())
}

fn scope_filters(metadata: &AppTableMetadata, scopes: &ScopeValues) -> Result<Vec<String>> {
    for scope_name in scopes.keys() {
        if !metadata.scopes.iter().any(|scope| scope.name == scope_name) {
            return Err(SyncularError::config(format!(
                "unknown scope {scope_name} for table {}",
                metadata.name
            )));
        }
    }

    let mut filters = Vec::new();
    for scope in metadata.scopes {
        match scopes.get(scope.name) {
            Some(value) => filters.push(scope_filter(scope.column, value)?),
            None if scope.required => filters.push("0 = 1".to_string()),
            None => {}
        }
    }
    Ok(filters)
}

fn scope_clause(metadata: &AppTableMetadata, scopes: &ScopeValues) -> Result<String> {
    let filters = scope_filters(metadata, scopes)?;
    if filters.is_empty() {
        Ok("1 = 1".to_string())
    } else {
        Ok(format!("({})", filters.join(" and ")))
    }
}

fn scope_filter(column: &str, value: &Value) -> Result<String> {
    validate_identifier(column)?;
    Ok(match value {
        Value::Null => format!("{column} is null"),
        Value::Array(values) if values.is_empty() => "0 = 1".to_string(),
        Value::Array(values) => format!(
            "{column} in ({})",
            values.iter().map(sql_value).collect::<Vec<_>>().join(", ")
        ),
        value => format!("{column} = {}", sql_value(value)),
    })
}

fn row_matches_scope_values(
    metadata: &AppTableMetadata,
    row: &Value,
    scopes: &ScopeValues,
) -> bool {
    metadata.scopes.iter().all(|scope| {
        let Some(expected) = scopes.get(scope.name) else {
            return !scope.required;
        };
        let actual = row.get(scope.column);
        match expected {
            Value::Array(values) => actual.is_some_and(|actual| values.iter().any(|v| v == actual)),
            value => actual == Some(value),
        }
    })
}

fn syncable_columns(metadata: &AppTableMetadata) -> Vec<&'static str> {
    let mut columns = metadata
        .columns
        .iter()
        .map(|column| column.name)
        .collect::<Vec<_>>();
    if !columns.contains(&metadata.primary_key_column) {
        columns.insert(0, metadata.primary_key_column);
    }
    if !columns.contains(&metadata.server_version_column) {
        columns.push(metadata.server_version_column);
    }
    columns
}

fn validate_app_table_metadata(metadata: &AppTableMetadata) -> Result<()> {
    validate_identifier(metadata.name)?;
    validate_identifier(metadata.primary_key_column)?;
    validate_identifier(metadata.server_version_column)?;
    for column in metadata.columns {
        validate_identifier(column.name)?;
    }
    for scope in metadata.scopes {
        validate_identifier(scope.column)?;
    }
    Ok(())
}

fn validate_identifier(identifier: &str) -> Result<()> {
    if !identifier.is_empty()
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        Ok(())
    } else {
        Err(SyncularError::schema(format!(
            "invalid sqlite identifier: {identifier}"
        )))
    }
}

fn add_column_if_missing(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<()> {
    let columns = sql_query(format!(
        "select name from pragma_table_info({})",
        sql_string(table)
    ))
    .load::<ColumnNameRow>(conn)?;
    if columns.iter().any(|row| row.name == column) {
        return Ok(());
    }
    sql_query(alter_sql).execute(conn)?;
    Ok(())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_value(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => i32::from(*value).to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => sql_string(value),
        Value::Array(_) | Value::Object(_) => sql_string(&value.to_string()),
    }
}

fn crdt_sync_mode_str(mode: crate::crdt_field::CrdtFieldSyncMode) -> &'static str {
    match mode {
        crate::crdt_field::CrdtFieldSyncMode::ServerMerge => "server-merge",
        crate::crdt_field::CrdtFieldSyncMode::EncryptedUpdateLog => "encrypted-update-log",
    }
}

fn crdt_sync_mode_from_str(value: &str) -> Result<crate::crdt_field::CrdtFieldSyncMode> {
    match value {
        "server-merge" => Ok(crate::crdt_field::CrdtFieldSyncMode::ServerMerge),
        "encrypted-update-log" => Ok(crate::crdt_field::CrdtFieldSyncMode::EncryptedUpdateLog),
        other => Err(SyncularError::message(
            ErrorKind::Storage,
            format!("unknown CRDT document sync mode: {other}"),
        )),
    }
}

fn crdt_update_origin_str(origin: CrdtUpdateOrigin) -> &'static str {
    match origin {
        CrdtUpdateOrigin::Local => "local",
        CrdtUpdateOrigin::Remote => "remote",
        CrdtUpdateOrigin::Compaction => "compaction",
    }
}

fn crdt_update_origin_from_str(value: &str) -> Result<CrdtUpdateOrigin> {
    match value {
        "local" => Ok(CrdtUpdateOrigin::Local),
        "remote" => Ok(CrdtUpdateOrigin::Remote),
        "compaction" => Ok(CrdtUpdateOrigin::Compaction),
        other => Err(SyncularError::message(
            ErrorKind::Storage,
            format!("unknown CRDT update origin: {other}"),
        )),
    }
}

fn crdt_update_status_str(status: CrdtUpdateStatus) -> &'static str {
    match status {
        CrdtUpdateStatus::Pending => "pending",
        CrdtUpdateStatus::Flushed => "flushed",
        CrdtUpdateStatus::Acked => "acked",
        CrdtUpdateStatus::Pruned => "pruned",
    }
}

fn crdt_update_status_from_str(value: &str) -> Result<CrdtUpdateStatus> {
    match value {
        "pending" => Ok(CrdtUpdateStatus::Pending),
        "flushed" => Ok(CrdtUpdateStatus::Flushed),
        "acked" => Ok(CrdtUpdateStatus::Acked),
        "pruned" => Ok(CrdtUpdateStatus::Pruned),
        other => Err(SyncularError::message(
            ErrorKind::Storage,
            format!("unknown CRDT update status: {other}"),
        )),
    }
}

fn crdt_field_state_base64(field: &CrdtField, row: Option<&Value>) -> Option<String> {
    row.and_then(|row| {
        row.get(field.state_column())
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn assert_crdt_document_capacity(
    conn: &mut SqliteConnection,
    document_key: &str,
    max_pending_updates: i64,
) -> Result<()> {
    if max_pending_updates < 1 {
        return Err(SyncularError::config(
            "CRDT update queue capacity must be at least 1",
        ));
    }
    let pending = sql_query(
        r#"
        select count(*) as count
        from sync_crdt_update_log
        where document_key = ?1 and status in ('pending', 'flushed')
        "#,
    )
    .bind::<Text, _>(document_key)
    .load::<CountRow>(conn)?
    .into_iter()
    .next()
    .map(|row| row.count)
    .unwrap_or(0);
    if pending >= max_pending_updates {
        return Err(SyncularError::message(ErrorKind::Storage, format!(
            "CRDT update queue is full for document {document_key}; pending={pending}, capacity={max_pending_updates}"
        )));
    }
    Ok(())
}

fn upsert_crdt_document_snapshot(
    conn: &mut SqliteConnection,
    field: &CrdtField,
    state_base64: Option<&str>,
    state_vector_base64: &str,
    compacted_at: Option<i64>,
) -> Result<()> {
    let now = now_ms();
    sql_query(
        r#"
        insert into sync_crdt_documents (
          document_key, app_table, row_id, field_name, state_column, sync_mode,
          state_base64, state_vector_base64, pending_updates, flushed_updates,
          acked_updates, log_updates, created_at, updated_at, compacted_at
        ) values (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          0, 0, 0, 0, ?9, ?10, ?11
        )
        on conflict(document_key) do update set
          state_base64 = excluded.state_base64,
          state_vector_base64 = excluded.state_vector_base64,
          state_column = excluded.state_column,
          sync_mode = excluded.sync_mode,
          updated_at = excluded.updated_at,
          compacted_at = coalesce(excluded.compacted_at, sync_crdt_documents.compacted_at)
        "#,
    )
    .bind::<Text, _>(field.document_key())
    .bind::<Text, _>(field.table())
    .bind::<Text, _>(field.row_id())
    .bind::<Text, _>(field.field())
    .bind::<Text, _>(field.state_column())
    .bind::<Text, _>(crdt_sync_mode_str(field.sync_mode()))
    .bind::<Nullable<Text>, _>(state_base64)
    .bind::<Text, _>(state_vector_base64)
    .bind::<BigInt, _>(now)
    .bind::<BigInt, _>(now)
    .bind::<Nullable<BigInt>, _>(compacted_at)
    .execute(conn)?;
    refresh_crdt_document_counts(conn, &field.document_key())
}

fn record_crdt_update_log(
    conn: &mut SqliteConnection,
    field: &CrdtField,
    update: &YjsUpdateEnvelope,
    client_commit_id: Option<&str>,
    origin: CrdtUpdateOrigin,
    status: CrdtUpdateStatus,
    state_base64: Option<&str>,
    state_vector_base64: &str,
) -> Result<()> {
    upsert_crdt_document_snapshot(conn, field, state_base64, state_vector_base64, None)?;
    let now = now_ms();
    let document_key = field.document_key();
    sql_query(
        r#"
        insert into sync_crdt_update_log (
          document_key, app_table, row_id, field_name, update_id, client_commit_id,
          origin, status, update_base64, state_vector_base64, created_at, flushed_at, acked_at
        ) values (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
          case when ?8 in ('flushed', 'acked') then ?11 else null end,
          case when ?8 = 'acked' then ?11 else null end
        )
        on conflict(update_id) do update set
          state_vector_base64 = excluded.state_vector_base64,
          status = case
            when sync_crdt_update_log.status = 'acked' then sync_crdt_update_log.status
            else excluded.status
          end,
          flushed_at = coalesce(sync_crdt_update_log.flushed_at, excluded.flushed_at),
          acked_at = coalesce(sync_crdt_update_log.acked_at, excluded.acked_at)
        "#,
    )
    .bind::<Text, _>(&document_key)
    .bind::<Text, _>(field.table())
    .bind::<Text, _>(field.row_id())
    .bind::<Text, _>(field.field())
    .bind::<Text, _>(&update.update_id)
    .bind::<Nullable<Text>, _>(client_commit_id)
    .bind::<Text, _>(crdt_update_origin_str(origin))
    .bind::<Text, _>(crdt_update_status_str(status))
    .bind::<Text, _>(&update.update_base64)
    .bind::<Text, _>(state_vector_base64)
    .bind::<BigInt, _>(now)
    .execute(conn)?;
    refresh_crdt_document_counts(conn, &document_key)
}

fn select_crdt_document_snapshot(
    conn: &mut SqliteConnection,
    document_key: &str,
) -> Result<CrdtDocumentSnapshot> {
    sql_query(
        r#"
        select document_key, app_table, row_id, field_name, state_column, sync_mode,
               state_base64, state_vector_base64, pending_updates, flushed_updates,
               acked_updates, log_updates, updated_at, compacted_at
        from sync_crdt_documents
        where document_key = ?1
        limit 1
        "#,
    )
    .bind::<Text, _>(document_key)
    .load::<CrdtDocumentSnapshotRow>(conn)?
    .into_iter()
    .next()
    .ok_or_else(|| {
        SyncularError::message(
            ErrorKind::Storage,
            format!("CRDT document not found: {document_key}"),
        )
    })?
    .try_into()
}

fn refresh_crdt_document_counts(conn: &mut SqliteConnection, document_key: &str) -> Result<()> {
    sql_query(
        r#"
        update sync_crdt_documents
        set pending_updates = (
              select count(*) from sync_crdt_update_log
              where document_key = ?1 and status = 'pending'
            ),
            flushed_updates = (
              select count(*) from sync_crdt_update_log
              where document_key = ?1 and status = 'flushed'
            ),
            acked_updates = (
              select count(*) from sync_crdt_update_log
              where document_key = ?1 and status = 'acked'
            ),
            log_updates = (
              select count(*) from sync_crdt_update_log
              where document_key = ?1
            ),
            updated_at = ?2
        where document_key = ?1
        "#,
    )
    .bind::<Text, _>(document_key)
    .bind::<BigInt, _>(now_ms())
    .execute(conn)?;
    Ok(())
}

fn refresh_all_crdt_document_counts(conn: &mut SqliteConnection) -> Result<()> {
    let keys = sql_query("select document_key as value from sync_crdt_documents")
        .load::<StringValueRow>(conn)?;
    for key in keys {
        refresh_crdt_document_counts(conn, &key.value)?;
    }
    Ok(())
}

impl SyncStoreTx for DieselSqliteTx<'_> {
    fn pending_outbox(&mut self, limit: i64) -> Result<Vec<OutboxCommit>> {
        use schema::sync_outbox_commits::dsl as o;
        let now = now_ms();

        let rows: Vec<OutboxCommitRow> = o::sync_outbox_commits
            .select(OutboxCommitRow::as_select())
            .filter(o::status.eq("pending"))
            .filter(o::attempt_count.lt(MAX_SYNC_RETRIES))
            .filter(o::next_attempt_at.le(now))
            .order(o::created_at.asc())
            .limit(limit)
            .load(self.conn)?;

        Ok(rows.into_iter().map(OutboxCommit::from).collect())
    }

    fn requeue_stale_outbox(&mut self) -> Result<()> {
        let now = now_ms();
        let stale_before = now - SYNC_SENDING_TIMEOUT_MS;
        sql_query(
            r#"
            update sync_outbox_commits
            set status = case when attempt_count >= ?1 then 'failed' else 'pending' end,
                next_attempt_at = case when attempt_count >= ?1 then 0 else ?2 end,
                error = case
                    when attempt_count >= ?1 then 'Sync attempt timed out while in sending state'
                    else 'Sync attempt timed out while in sending state; retrying'
                end,
                updated_at = ?2
            where status = 'sending' and updated_at < ?3
            "#,
        )
        .bind::<Integer, _>(MAX_SYNC_RETRIES)
        .bind::<BigInt, _>(now)
        .bind::<BigInt, _>(stale_before)
        .execute(self.conn)?;
        Ok(())
    }

    fn mark_outbox_sending(&mut self, row_id: &str) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;
        let now = now_ms();
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq("sending"),
                o::updated_at.eq(now),
                o::attempt_count.eq(o::attempt_count + 1),
                o::error.eq::<Option<String>>(None),
                o::next_attempt_at.eq(0),
            ))
            .execute(self.conn)?;
        sql_query(
            r#"
            update sync_crdt_update_log
            set status = 'flushed',
                flushed_at = coalesce(flushed_at, ?1)
            where status = 'pending'
              and client_commit_id = (
                select client_commit_id from sync_outbox_commits where id = ?2
              )
            "#,
        )
        .bind::<BigInt, _>(now)
        .bind::<Text, _>(row_id)
        .execute(self.conn)?;
        refresh_all_crdt_document_counts(self.conn)?;
        Ok(())
    }

    fn mark_pushed_operation_server_versions(
        &mut self,
        outbox: &OutboxCommit,
        response: &PushCommitResponse,
    ) -> Result<()> {
        let operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
        if response.results.is_empty() {
            if let Some(server_seq) = response.commit_seq {
                for operation in &operations {
                    if is_encrypted_crdt_system_table(&operation.table) {
                        update_encrypted_crdt_system_server_seq(
                            self.conn,
                            &operation.table,
                            &operation.row_id,
                            server_seq,
                        )?;
                    }
                }
            }
            return Ok(());
        }

        for result in &response.results {
            if !matches!(result.status.as_str(), "applied" | "cached") {
                continue;
            }
            let Some(server_seq) = result.server_version.or(response.commit_seq) else {
                continue;
            };
            let operation = operations.get(result.op_index as usize).ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "push response op_index {} out of bounds for local outbox commit {}",
                    result.op_index, outbox.client_commit_id
                ))
            })?;
            if is_encrypted_crdt_system_table(&operation.table) {
                update_encrypted_crdt_system_server_seq(
                    self.conn,
                    &operation.table,
                    &operation.row_id,
                    server_seq,
                )?;
            }
        }
        Ok(())
    }

    fn mark_outbox_acked(&mut self, row_id: &str, response: &PushCommitResponse) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;
        let now = now_ms();
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq("acked"),
                o::updated_at.eq(now),
                o::acked_commit_seq.eq(response.commit_seq),
                o::last_response_json.eq(Some(serde_json::to_string(response)?)),
                o::error.eq::<Option<String>>(None),
                o::next_attempt_at.eq(0),
            ))
            .execute(self.conn)?;
        sql_query(
            r#"
            update sync_crdt_update_log
            set status = 'acked',
                flushed_at = coalesce(flushed_at, ?1),
                acked_at = coalesce(acked_at, ?1)
            where status in ('pending', 'flushed')
              and client_commit_id = (
                select client_commit_id from sync_outbox_commits where id = ?2
              )
            "#,
        )
        .bind::<BigInt, _>(now)
        .bind::<Text, _>(row_id)
        .execute(self.conn)?;
        refresh_all_crdt_document_counts(self.conn)?;
        Ok(())
    }

    fn mark_outbox_failed(
        &mut self,
        row_id: &str,
        error: &str,
        response: &PushCommitResponse,
    ) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq("failed"),
                o::updated_at.eq(now_ms()),
                o::last_response_json.eq(Some(serde_json::to_string(response)?)),
                o::error.eq(Some(error.to_string())),
                o::next_attempt_at.eq(0),
            ))
            .execute(self.conn)?;
        Ok(())
    }

    fn mark_outbox_retry(
        &mut self,
        row_id: &str,
        error: &str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;
        let now = now_ms();
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq(if failed { "failed" } else { "pending" }),
                o::updated_at.eq(now),
                o::error.eq(Some(error.to_string())),
                o::next_attempt_at.eq(if failed { 0 } else { next_attempt_at }),
            ))
            .execute(self.conn)?;
        if !failed {
            sql_query(
                r#"
                update sync_crdt_update_log
                set status = 'pending'
                where status = 'flushed'
                  and client_commit_id = (
                    select client_commit_id from sync_outbox_commits where id = ?1
                  )
                "#,
            )
            .bind::<Text, _>(row_id)
            .execute(self.conn)?;
            refresh_all_crdt_document_counts(self.conn)?;
        }
        Ok(())
    }

    fn insert_conflict(&mut self, outbox: &OutboxCommit, result: &OperationResult) -> Result<()> {
        sql_query(
            r#"
            insert into sync_conflicts (
                id, outbox_commit_id, client_commit_id, op_index, result_status,
                message, code, server_version, server_row_json, created_at,
                resolved_at, resolution
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, null, null)
            "#,
        )
        .bind::<diesel::sql_types::Text, _>(Uuid::new_v4().to_string())
        .bind::<diesel::sql_types::Text, _>(&outbox.id)
        .bind::<diesel::sql_types::Text, _>(&outbox.client_commit_id)
        .bind::<diesel::sql_types::Integer, _>(result.op_index)
        .bind::<diesel::sql_types::Text, _>(&result.status)
        .bind::<diesel::sql_types::Text, _>(
            result
                .message
                .clone()
                .or_else(|| result.error.clone())
                .unwrap_or_else(|| result.status.clone()),
        )
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(result.code.clone())
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(result.server_version)
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(
            result.server_row.as_ref().map(Value::to_string),
        )
        .bind::<diesel::sql_types::BigInt, _>(now_ms())
        .execute(self.conn)?;

        Ok(())
    }

    fn upsert_auth_lease(&mut self, lease: &AuthLeaseRecord) -> Result<()> {
        use schema::sync_auth_leases::dsl as l;

        let row = AuthLeaseRecordRow::from(lease);
        diesel::insert_into(l::sync_auth_leases)
            .values(&row)
            .on_conflict(l::lease_id)
            .do_update()
            .set(&row)
            .execute(self.conn)?;
        Ok(())
    }

    fn auth_lease(&mut self, lease_id_value: &str) -> Result<Option<AuthLeaseRecord>> {
        use schema::sync_auth_leases::dsl as l;

        let row = l::sync_auth_leases
            .select(AuthLeaseRecordRow::as_select())
            .filter(l::lease_id.eq(lease_id_value))
            .first::<AuthLeaseRecordRow>(self.conn)
            .optional()?;
        Ok(row.map(AuthLeaseRecord::from))
    }

    fn active_auth_leases(
        &mut self,
        actor_id_value: Option<&str>,
        now_ms_value: i64,
    ) -> Result<Vec<AuthLeaseRecord>> {
        use schema::sync_auth_leases::dsl as l;

        let mut query = l::sync_auth_leases
            .select(AuthLeaseRecordRow::as_select())
            .filter(l::status.eq("active"))
            .filter(l::not_before_ms.le(now_ms_value))
            .filter(l::expires_at_ms.gt(now_ms_value))
            .into_boxed();
        if let Some(actor_id_value) = actor_id_value {
            query = query.filter(l::actor_id.eq(actor_id_value));
        }
        let rows = query.order(l::expires_at_ms.asc()).load(self.conn)?;
        Ok(rows.into_iter().map(AuthLeaseRecord::from).collect())
    }

    fn set_outbox_auth_lease(
        &mut self,
        client_commit_id_value: &str,
        provenance: Option<&AuthLeaseProvenance>,
    ) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;

        let lease_token_value = match provenance {
            Some(lease) => lease.lease_token.clone().or_else(|| {
                self.auth_lease(&lease.lease_id)
                    .ok()
                    .flatten()
                    .map(|record| record.token)
            }),
            None => None,
        };
        let affected = diesel::update(
            o::sync_outbox_commits.filter(o::client_commit_id.eq(client_commit_id_value)),
        )
        .set((
            o::lease_id.eq(provenance.map(|lease| lease.lease_id.clone())),
            o::lease_expires_at_ms.eq(provenance.map(|lease| lease.lease_expires_at_ms)),
            o::lease_status_at_enqueue
                .eq(provenance.map(|lease| lease.lease_status_at_enqueue.clone())),
            o::lease_scope_summary_json
                .eq(provenance.and_then(|lease| lease.lease_scope_summary_json.clone())),
            o::lease_token.eq(lease_token_value),
        ))
        .execute(self.conn)?;
        if affected == 0 {
            return Err(SyncularError::storage(anyhow::anyhow!(
                "outbox commit {client_commit_id_value} does not exist"
            )));
        }
        Ok(())
    }

    fn subscription_state(
        &mut self,
        state_id_value: &str,
        subscription_id_value: &str,
    ) -> Result<Option<SubscriptionState>> {
        use schema::sync_subscription_state::dsl as s;

        let row: Option<SubscriptionStateRow> = s::sync_subscription_state
            .select(SubscriptionStateRow::as_select())
            .filter(s::state_id.eq(state_id_value))
            .filter(s::subscription_id.eq(subscription_id_value))
            .first(self.conn)
            .optional()?;

        Ok(row.map(SubscriptionState::from))
    }

    fn subscription_states(&mut self, state_id_value: &str) -> Result<Vec<SubscriptionState>> {
        use schema::sync_subscription_state::dsl as s;

        let rows: Vec<SubscriptionStateRow> = s::sync_subscription_state
            .select(SubscriptionStateRow::as_select())
            .filter(s::state_id.eq(state_id_value))
            .order(s::subscription_id.asc())
            .load(self.conn)?;

        Ok(rows.into_iter().map(SubscriptionState::from).collect())
    }

    fn upsert_subscription_state(&mut self, state: &SubscriptionState) -> Result<()> {
        sql_query(
            r#"
            insert into sync_subscription_state (
                state_id, subscription_id, "table", scopes_json, params_json,
                cursor, bootstrap_state_json, status, created_at, updated_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            on conflict (state_id, subscription_id) do update set
                "table" = excluded."table",
                scopes_json = excluded.scopes_json,
                params_json = excluded.params_json,
                cursor = excluded.cursor,
                bootstrap_state_json = excluded.bootstrap_state_json,
                status = excluded.status,
                updated_at = excluded.updated_at
            "#,
        )
        .bind::<diesel::sql_types::Text, _>(&state.state_id)
        .bind::<diesel::sql_types::Text, _>(&state.subscription_id)
        .bind::<diesel::sql_types::Text, _>(&state.table)
        .bind::<diesel::sql_types::Text, _>(&state.scopes_json)
        .bind::<diesel::sql_types::Text, _>(&state.params_json)
        .bind::<diesel::sql_types::BigInt, _>(state.cursor)
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(
            state.bootstrap_state_json.clone(),
        )
        .bind::<diesel::sql_types::Text, _>(&state.status)
        .bind::<diesel::sql_types::BigInt, _>(now_ms())
        .bind::<diesel::sql_types::BigInt, _>(now_ms())
        .execute(self.conn)?;

        Ok(())
    }

    fn delete_subscription_state(
        &mut self,
        state_id_value: &str,
        subscription_id_value: &str,
    ) -> Result<()> {
        use schema::sync_subscription_state::dsl as s;

        diesel::delete(
            s::sync_subscription_state
                .filter(s::state_id.eq(state_id_value))
                .filter(s::subscription_id.eq(subscription_id_value)),
        )
        .execute(self.conn)?;
        Ok(())
    }

    fn verified_root(
        &mut self,
        state_id_value: &str,
        subscription_id_value: &str,
    ) -> Result<Option<VerifiedRoot>> {
        let row: Option<VerifiedRootRow> = sql_query(
            r#"
            select state_id, subscription_id, partition_id, commit_seq, root
            from sync_verified_roots
            where state_id = ?1 and subscription_id = ?2
            limit 1
            "#,
        )
        .bind::<Text, _>(state_id_value)
        .bind::<Text, _>(subscription_id_value)
        .get_result(self.conn)
        .optional()?;
        Ok(row.map(VerifiedRoot::from))
    }

    fn verified_roots(&mut self, state_id_value: &str) -> Result<Vec<VerifiedRoot>> {
        let rows: Vec<VerifiedRootRow> = sql_query(
            r#"
            select state_id, subscription_id, partition_id, commit_seq, root
            from sync_verified_roots
            where state_id = ?1
            order by subscription_id asc
            "#,
        )
        .bind::<Text, _>(state_id_value)
        .load(self.conn)?;
        Ok(rows.into_iter().map(VerifiedRoot::from).collect())
    }

    fn upsert_verified_root(&mut self, root: &VerifiedRoot) -> Result<()> {
        let now = now_ms();
        sql_query(
            r#"
            insert into sync_verified_roots (
                state_id, subscription_id, partition_id, commit_seq, root,
                created_at, updated_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            on conflict (state_id, subscription_id) do update set
                partition_id = excluded.partition_id,
                commit_seq = excluded.commit_seq,
                root = excluded.root,
                updated_at = excluded.updated_at
            "#,
        )
        .bind::<Text, _>(&root.state_id)
        .bind::<Text, _>(&root.subscription_id)
        .bind::<Text, _>(&root.partition_id)
        .bind::<BigInt, _>(root.commit_seq)
        .bind::<Text, _>(&root.root)
        .bind::<BigInt, _>(now)
        .bind::<BigInt, _>(now)
        .execute(self.conn)?;
        Ok(())
    }

    fn delete_verified_root(
        &mut self,
        state_id_value: &str,
        subscription_id_value: &str,
    ) -> Result<()> {
        sql_query(
            r#"
            delete from sync_verified_roots
            where state_id = ?1 and subscription_id = ?2
            "#,
        )
        .bind::<Text, _>(state_id_value)
        .bind::<Text, _>(subscription_id_value)
        .execute(self.conn)?;
        Ok(())
    }

    fn crdt_state_vector_hints(
        &mut self,
        table: &str,
        scopes: &ScopeValues,
        limit: i64,
    ) -> Result<Vec<CrdtStateVectorHint>> {
        crdt_state_vector_hints_for_subscription(self.conn, self.app_schema, table, scopes, limit)
    }

    fn clear_table_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<()> {
        if is_encrypted_crdt_system_table(table) {
            return clear_encrypted_crdt_system_table_for_scopes(self.conn, table, scopes);
        }
        clear_app_table_for_scopes(self.conn, self.app_schema, table, scopes)
    }

    fn clear_synced_rows_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<i64> {
        clear_synced_app_rows_for_scopes(self.conn, self.app_schema, table, scopes)
    }

    fn clear_table_for_scopes_preserving_local_crdt(
        &mut self,
        table: &str,
        scopes: &ScopeValues,
    ) -> Result<()> {
        if is_encrypted_crdt_system_table(table) {
            return clear_encrypted_crdt_system_table_for_scopes(self.conn, table, scopes);
        }
        clear_app_table_for_scopes_preserving_local_crdt(self.conn, self.app_schema, table, scopes)
    }

    fn current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        if is_encrypted_crdt_system_table(table) {
            return Ok(None);
        }
        current_app_row_json(self.conn, self.app_schema, table, row_id)
    }

    fn upsert_row(
        &mut self,
        table: &str,
        row: &Value,
        fallback_version: Option<i64>,
    ) -> Result<()> {
        if is_encrypted_crdt_system_table(table) {
            let identity = encrypted_crdt_identity_column(table)?;
            let row_id = row.get(identity).and_then(Value::as_str).ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "encrypted CRDT row missing identity column {identity}"
                ))
            })?;
            let row = apply_encrypted_crdt_system_row(
                self.conn,
                table,
                row_id,
                Some(row),
                fallback_version,
            )?;
            materialize_encrypted_crdt_system_row(self.conn, self.app_schema, table, &row)?;
            return Ok(());
        }

        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        let row = materialize_row_for_metadata(table, None, row.clone(), metadata)?;
        let row = preserve_encrypted_crdt_materialized_columns(
            self.conn,
            self.app_schema,
            metadata,
            row,
        )?;
        upsert_app_row(self.conn, self.app_schema, table, &row, fallback_version)
    }

    fn upsert_rows(
        &mut self,
        table: &str,
        rows: &[Value],
        fallback_version: Option<i64>,
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if is_encrypted_crdt_system_table(table) {
            for row in rows {
                self.upsert_row(table, row, fallback_version)?;
            }
            return Ok(());
        }

        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        if metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
        {
            for row in rows {
                self.upsert_row(table, row, fallback_version)?;
            }
            return Ok(());
        }

        let row_objects = rows
            .iter()
            .map(|row| {
                let row = materialize_row_for_metadata(table, None, row.clone(), metadata)?;
                row.as_object().cloned().ok_or_else(|| {
                    SyncularError::protocol_message(format!("row is not a JSON object: {row}"))
                })
            })
            .collect::<Result<Vec<_>>>()?;

        upsert_rows_generic_batch(self.conn, metadata, &row_objects, fallback_version)
    }

    fn upsert_snapshot_chunk_rows(
        &mut self,
        table: &str,
        rows: &SnapshotChunkRows,
        fallback_version: Option<i64>,
    ) -> Result<()> {
        match rows {
            SnapshotChunkRows::Json(rows) => self.upsert_rows(table, rows, fallback_version),
            SnapshotChunkRows::Binary(rows) => {
                if fallback_version.is_some() || is_encrypted_crdt_system_table(table) {
                    let rows = rows.clone().into_value_rows();
                    return self.upsert_rows(table, &rows, fallback_version);
                }

                let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                    SyncularError::config(format!("unknown generated app table: {table}"))
                })?;
                if metadata
                    .crdt_yjs_fields
                    .iter()
                    .any(|field| field.sync_mode == "encrypted-update-log")
                {
                    let rows = rows.clone().into_value_rows();
                    return self.upsert_rows(table, &rows, fallback_version);
                }

                upsert_binary_snapshot_rows_batch(self.conn, metadata, rows)
            }
            SnapshotChunkRows::BinaryPayload(rows) => {
                let rows = rows.clone().into_decoded_rows()?;
                if fallback_version.is_some() || is_encrypted_crdt_system_table(table) {
                    let rows = rows.into_value_rows();
                    return self.upsert_rows(table, &rows, fallback_version);
                }

                let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                    SyncularError::config(format!("unknown generated app table: {table}"))
                })?;
                if metadata
                    .crdt_yjs_fields
                    .iter()
                    .any(|field| field.sync_mode == "encrypted-update-log")
                {
                    let rows = rows.into_value_rows();
                    return self.upsert_rows(table, &rows, fallback_version);
                }

                upsert_binary_snapshot_rows_batch(self.conn, metadata, &rows)
            }
        }
    }

    fn apply_change(&mut self, change: &SyncChange) -> Result<()> {
        if is_encrypted_crdt_system_table(&change.table) {
            if change.op == "delete" {
                return delete_encrypted_crdt_system_row(self.conn, &change.table, &change.row_id);
            }
            let row = apply_encrypted_crdt_system_row(
                self.conn,
                &change.table,
                &change.row_id,
                change.row_json.as_ref(),
                change.row_version,
            )?;
            materialize_encrypted_crdt_system_row(self.conn, self.app_schema, &change.table, &row)?;
            return Ok(());
        }

        if change.op == "upsert" {
            let metadata = self
                .app_schema
                .table_metadata(&change.table)
                .ok_or_else(|| {
                    SyncularError::config(format!("unknown generated app table: {}", change.table))
                })?;
            if let Some(row) = change.row_json.as_ref() {
                let mut change = change.clone();
                change.row_json = Some(if has_yjs_payload(row) {
                    let existing_row = current_app_row_json(
                        self.conn,
                        self.app_schema,
                        &change.table,
                        &change.row_id,
                    )?;
                    transform_local_row_for_metadata(
                        &change.table,
                        &change.row_id,
                        None,
                        Some(row),
                        existing_row.as_ref(),
                        metadata,
                    )?
                    .ok_or_else(|| {
                        SyncularError::protocol_message(format!(
                            "server-merge Yjs change for {}.{} did not materialize a row",
                            change.table, change.row_id
                        ))
                    })?
                } else {
                    materialize_row_for_metadata(
                        &change.table,
                        Some(&change.row_id),
                        row.clone(),
                        metadata,
                    )?
                });
                return apply_app_change(self.conn, self.app_schema, &change);
            }
        }
        apply_app_change(self.conn, self.app_schema, change)
    }
}

fn has_yjs_payload(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.contains_key(YJS_PAYLOAD_KEY))
}
