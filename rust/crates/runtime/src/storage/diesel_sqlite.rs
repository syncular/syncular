use crate::app_schema::{default_app_schema, AppSchema, AppTableMetadata};
use crate::compaction::{
    required_compaction_cutoff, tombstone_delete_statements, StorageCompactionOptions,
    StorageCompactionReport,
};
use crate::crdt_yjs::{
    materialize_row_for_metadata, transform_local_row_for_metadata, YJS_PAYLOAD_KEY,
};
use crate::demo_tasks::{insert_local_task, list_tasks, patch_local_task_title};
use crate::encrypted_crdt::{
    apply_encrypted_crdt_plaintext_to_row, encrypted_crdt_identity_column,
    encrypted_crdt_normalize_row, encrypted_crdt_row_matches_scopes, encrypted_crdt_scopes_json,
    is_encrypted_crdt_system_table, EncryptedCrdtStreamStats, CRDT_CHECKPOINTS_TABLE,
    CRDT_UPDATES_TABLE,
};
use crate::error::{Result, SyncularError};
use crate::migrations::{checksum, split_sql_statements};
use crate::protocol::*;
use crate::schema;
use crate::store::{
    now_ms, AppliedMigration, ConflictSummary, DemoTaskStore, OutboxCommit, OutboxSummary,
    SubscriptionState, SyncStateStore, SyncStore, SyncStoreTx, Task, BLOB_UPLOAD_STALE_TIMEOUT_MS,
    MAX_BLOB_UPLOAD_RETRIES, MAX_SYNC_RETRIES, SYNC_SENDING_TIMEOUT_MS,
};
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Binary, Integer, Text};
use diesel::sqlite::SqliteConnection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

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
        }
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
struct OutboxSummaryRow {
    #[diesel(sql_type = Text)]
    client_commit_id: String,
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = Integer)]
    schema_version: i32,
}

impl From<OutboxSummaryRow> for OutboxSummary {
    fn from(row: OutboxSummaryRow) -> Self {
        Self {
            client_commit_id: row.client_commit_id,
            status: row.status,
            schema_version: row.schema_version,
        }
    }
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

impl DieselSqliteStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::open_with_schema(path, default_app_schema())
    }

    pub fn open_with_schema(path: &str, app_schema: AppSchema) -> Result<Self> {
        let conn = SqliteConnection::establish(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open sqlite database at {path}"))
        })?;
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

        Ok(())
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>> {
        if self.app_schema.table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {table}"
            )));
        }

        self.app_schema
            .adapter_for(table)?
            .list_rows_json(&mut self.conn)
    }

    pub fn read_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        current_app_row_json(&mut self.conn, self.app_schema, table, row_id)
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

    pub fn apply_syncular_mutations(
        &mut self,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        self.transaction(|tx| tx.apply_syncular_mutations(mutations))
    }

    pub fn store_blob_bytes(
        &mut self,
        data: &[u8],
        mime_type: &str,
        enqueue_upload: bool,
    ) -> Result<BlobRef> {
        let blob = BlobRef {
            hash: blob_hash(data),
            size: i64::try_from(data.len()).map_err(|_| {
                SyncularError::protocol_message("blob is too large for SQLite size metadata")
            })?,
            mime_type: if mime_type.trim().is_empty() {
                "application/octet-stream".to_string()
            } else {
                mime_type.to_string()
            },
            encrypted: false,
            key_id: None,
        };

        self.conn.transaction::<(), SyncularError, _>(|conn| {
            cache_blob(conn, &blob, data)?;
            if enqueue_upload {
                enqueue_blob_upload(conn, &blob, data)?;
            }
            Ok(())
        })?;
        Ok(blob)
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

    pub fn pending_blob_uploads(&mut self, limit: i64) -> Result<Vec<PendingBlobUploadRow>> {
        let now = now_ms();
        Ok(sql_query(
            r#"
            select hash, size, mime_type, body, attempt_count
            from sync_blob_outbox
            where status = 'pending' and attempt_count < ?1 and next_attempt_at <= ?2
            order by created_at asc
            limit ?3
            "#,
        )
        .bind::<Integer, _>(MAX_BLOB_UPLOAD_RETRIES)
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
            for statement in tombstone_delete_statements(max_server_version)? {
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

        Ok(report)
    }

    pub fn compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        let options = StorageCompactionOptions::from_json(options_json)?;
        Ok(serde_json::to_string(&self.compact_storage(&options)?)?)
    }
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

impl SyncStore for DieselSqliteStore {
    type Tx<'a> = DieselSqliteTx<'a>;

    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T>) -> Result<T> {
        let app_schema = self.app_schema;
        self.conn.transaction::<T, SyncularError, _>(|conn| {
            let mut tx = DieselSqliteTx { conn, app_schema };
            f(&mut tx)
        })
    }
}

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

    fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>> {
        let rows = sql_query(
            r#"
            select client_commit_id, status, schema_version
            from sync_outbox_commits
            order by created_at asc
            "#,
        )
        .load::<OutboxSummaryRow>(&mut self.conn)?;

        Ok(rows.into_iter().map(OutboxSummary::from).collect())
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

        let id = Uuid::new_v4().to_string();
        let client_commit_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let row = NewOutboxCommit {
            id: id.clone(),
            client_commit_id: client_commit_id.clone(),
            status: "pending".to_string(),
            operations_json: serde_json::to_string(&operations)?,
            last_response_json: None,
            error: None,
            created_at: now,
            updated_at: now,
            attempt_count: 0,
            acked_commit_seq: None,
            schema_version: self.app_schema.current_schema_version(),
            next_attempt_at: 0,
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
                let row = local_row.unwrap_or_else(|| row_from_operation_payload(&operation));
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

        self.enqueue_outbox(vec![operation])
    }

    fn apply_syncular_mutations(
        &mut self,
        mutations: Vec<PendingSyncularMutation>,
    ) -> Result<MutationReceipt> {
        if mutations.is_empty() {
            return Err(SyncularError::config(
                "cannot commit an empty Syncular mutation batch",
            ));
        }

        let mut operations = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            if is_encrypted_crdt_system_table(&mutation.table) {
                let operation = mutation.operation(None);
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
                        merged_local_row(current_row, &mutation.row_id, operation.payload.as_ref())
                    });
                    self.upsert_row(
                        &mutation.table,
                        &local_row,
                        current_server_version.or(base_version),
                    )?;
                }
            }

            operations.push(operation);
        }

        self.enqueue_outbox_receipt(operations)
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

fn row_from_operation_payload(operation: &SyncOperation) -> Value {
    let mut row = operation
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    row.insert("id".to_string(), Value::String(operation.row_id.clone()));
    Value::Object(row)
}

fn merged_local_row(current_row: Option<Value>, row_id: &str, payload: Option<&Value>) -> Value {
    let mut row = current_row
        .and_then(|row| row.as_object().cloned())
        .unwrap_or_default();
    if let Some(payload) = payload.and_then(Value::as_object) {
        for (key, value) in payload {
            row.insert(key.clone(), value.clone());
        }
    }
    row.insert("id".to_string(), Value::String(row_id.to_string()));
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
    app_schema
        .adapter_for(app_table)?
        .upsert_row(conn, &row, fallback_version)?;
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
    let rows = app_schema.adapter_for(table)?.list_rows_json(conn)?;
    Ok(rows.into_iter().find(|row| {
        row.get(metadata.primary_key_column)
            .and_then(Value::as_str)
            .map(|id| id == row_id)
            .unwrap_or(false)
    }))
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
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq("sending"),
                o::updated_at.eq(now_ms()),
                o::attempt_count.eq(o::attempt_count + 1),
                o::error.eq::<Option<String>>(None),
                o::next_attempt_at.eq(0),
            ))
            .execute(self.conn)?;
        Ok(())
    }

    fn mark_outbox_acked(&mut self, row_id: &str, response: &PushCommitResponse) -> Result<()> {
        use schema::sync_outbox_commits::dsl as o;
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq("acked"),
                o::updated_at.eq(now_ms()),
                o::acked_commit_seq.eq(response.commit_seq),
                o::last_response_json.eq(Some(serde_json::to_string(response)?)),
                o::error.eq::<Option<String>>(None),
                o::next_attempt_at.eq(0),
            ))
            .execute(self.conn)?;
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
        diesel::update(o::sync_outbox_commits.filter(o::id.eq(row_id)))
            .set((
                o::status.eq(if failed { "failed" } else { "pending" }),
                o::updated_at.eq(now_ms()),
                o::error.eq(Some(error.to_string())),
                o::next_attempt_at.eq(if failed { 0 } else { next_attempt_at }),
            ))
            .execute(self.conn)?;
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

    fn clear_table_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<()> {
        if is_encrypted_crdt_system_table(table) {
            return clear_encrypted_crdt_system_table_for_scopes(self.conn, table, scopes);
        }
        self.app_schema
            .adapter_for(table)?
            .clear_for_scopes(self.conn, scopes)
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
        self.app_schema
            .adapter_for(table)?
            .upsert_row(self.conn, &row, fallback_version)
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
                change.row_json = Some(materialize_row_for_metadata(
                    &change.table,
                    Some(&change.row_id),
                    row.clone(),
                    metadata,
                )?);
                return self
                    .app_schema
                    .adapter_for(&change.table)?
                    .apply_change(self.conn, &change);
            }
        }
        self.app_schema
            .adapter_for(&change.table)?
            .apply_change(self.conn, change)
    }
}
