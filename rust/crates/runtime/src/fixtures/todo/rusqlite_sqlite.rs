use super::generated::{table_metadata, NewTask, TaskPatch};
use super::migrations::{checksum, current_schema_version, split_sql_statements, MIGRATIONS};
use crate::client::SubscriptionSpec;
use crate::error::{Result, SyncularError};
use crate::limits::validate_unresolved_outbox_capacity;
use crate::protocol::*;
use crate::runtime_schema::RUNTIME_SYSTEM_SCHEMA_SQL;
use crate::store::{
    now_ms, AppliedMigration, ConflictSummary, DemoTaskStore, OutboxCommit, OutboxSummary,
    ScopedRowsHealthSummary, ScopedRowsTableHealth, SubscriptionState, SyncStateStore, SyncStore,
    SyncStoreTx, Task, VerifiedRoot, MAX_SYNC_RETRIES, SQLITE_BUSY_TIMEOUT_MS,
    SYNC_SENDING_TIMEOUT_MS,
};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{Map, Value};
use uuid::Uuid;

pub struct RusqliteStore {
    conn: Connection,
}

pub struct RusqliteTx<'a> {
    tx: Transaction<'a>,
}

impl RusqliteStore {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open sqlite database at {path}"))
        })?;
        apply_sqlite_runtime_pragmas(&conn)?;
        let store = Self { conn };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn ensure_schema(&self) -> Result<()> {
        self.conn.execute(
            r#"
            create table if not exists sync_migrations (
                version text primary key,
                name text not null,
                checksum text not null,
                applied_at bigint not null
            )
            "#,
            [],
        )?;
        for statement in split_sql_statements(RUNTIME_SYSTEM_SCHEMA_SQL) {
            self.conn.execute(&statement, [])?;
        }

        for migration in MIGRATIONS {
            let applied: Option<String> = self
                .conn
                .query_row(
                    "select checksum from sync_migrations where version = ?1 limit 1",
                    params![migration.version],
                    |row| row.get(0),
                )
                .optional()?;
            let expected_checksum = checksum(migration.up_sql);

            if let Some(applied_checksum) = applied {
                if applied_checksum != expected_checksum {
                    return Err(SyncularError::schema(format!(
                        "migration {} checksum mismatch",
                        migration.version
                    )));
                }
                continue;
            }

            self.conn.execute_batch("begin immediate")?;
            let result = (|| -> Result<()> {
                for statement in split_sql_statements(migration.up_sql) {
                    self.conn.execute(&statement, [])?;
                }
                self.conn.execute(
                    r#"
                    insert into sync_migrations (version, name, checksum, applied_at)
                    values (?1, ?2, ?3, ?4)
                    "#,
                    params![
                        migration.version,
                        migration.name,
                        expected_checksum,
                        now_ms()
                    ],
                )?;
                Ok(())
            })();

            if result.is_ok() {
                self.conn.execute_batch("commit")?;
            } else {
                let _ = self.conn.execute_batch("rollback");
            }
            result?;
        }
        Ok(())
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>> {
        if table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {table}"
            )));
        }

        let mut statement = self
            .conn
            .prepare(&format!("select * from {}", quote_sqlite_ident(table)))?;
        let columns = statement
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let rows = statement.query_map([], |row| {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(column.clone(), sqlite_value_to_json(row.get_ref(index)?));
            }
            Ok(Value::Object(object))
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        if table_metadata(&operation.table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {}",
                operation.table
            )));
        }

        self.transaction(|tx| tx.apply_local_operation(operation, local_row))
    }
}

fn apply_sqlite_runtime_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!(
        r#"
        pragma busy_timeout = {SQLITE_BUSY_TIMEOUT_MS};
        pragma foreign_keys = on;
        pragma journal_mode = wal;
        pragma synchronous = normal;
        "#
    ))?;
    Ok(())
}

fn quote_sqlite_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sqlite_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => Value::String(hex::encode(value)),
    }
}

impl SyncStore for RusqliteStore {
    type Tx<'a> = RusqliteTx<'a>;

    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T>) -> Result<T> {
        let tx = self.conn.transaction()?;
        let mut wrapper = RusqliteTx { tx };
        let value = f(&mut wrapper)?;
        wrapper.tx.commit()?;
        Ok(value)
    }
}

impl DemoTaskStore for RusqliteStore {
    fn add_task(
        &mut self,
        actor_id: &str,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        self.transaction(|tx| tx.add_task(actor_id, project_id, task_id, title_value))
    }

    fn patch_task_title(
        &mut self,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        self.transaction(|tx| tx.patch_task_title(project_id, task_id, title_value))
    }

    fn list_tasks(&mut self) -> Result<Vec<Task>> {
        let mut statement = self.conn.prepare(
            r#"
            select id, title, completed, user_id, project_id, server_version, image, title_yjs_state
            from tasks
            order by user_id asc, title asc
            "#,
        )?;
        let rows = statement.query_map([], task_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }
}

impl SyncStateStore for RusqliteStore {
    fn applied_migrations(&mut self) -> Result<Vec<AppliedMigration>> {
        let mut statement = self.conn.prepare(
            r#"
            select version, name, checksum, applied_at
            from sync_migrations
            order by version asc
            "#,
        )?;
        let rows = statement.query_map([], applied_migration_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>> {
        let mut statement = self.conn.prepare(
            r#"
           select id, client_commit_id, status, schema_version, acked_commit_seq,
                  lease_id, lease_expires_at_ms, lease_status_at_enqueue,
                   lease_scope_summary_json, lease_token
            from sync_outbox_commits
            order by created_at asc
            "#,
        )?;
        let rows = statement.query_map([], outbox_summary_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn next_outbox_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            r#"
            select min(next_attempt_at)
            from sync_outbox_commits
            where status = 'pending' and attempt_count > 0 and attempt_count < ?1
            "#,
            params![MAX_SYNC_RETRIES],
            |row| row.get(0),
        )?)
    }

    fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>> {
        let mut statement = self.conn.prepare(
            r#"
            select id, client_commit_id, op_index, result_status, message, code, server_version,
                   resolved_at, resolution
            from sync_conflicts
            where resolved_at is null
            order by created_at desc
            "#,
        )?;
        let rows = statement.query_map([], conflict_summary_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn scoped_rows_health_summary(
        &mut self,
        subscriptions: &[SubscriptionSpec],
    ) -> Result<Option<ScopedRowsHealthSummary>> {
        Ok(Some(self.task_scoped_rows_health_summary(
            subscriptions,
            &[],
            false,
        )?))
    }

    fn clear_orphaned_synced_rows(
        &mut self,
        subscriptions: &[SubscriptionSpec],
        tables: &[String],
    ) -> Result<ScopedRowsHealthSummary> {
        self.task_scoped_rows_health_summary(subscriptions, tables, true)
    }

    fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.conn.execute(
            r#"
            update sync_conflicts
            set resolved_at = ?1, resolution = ?2
            where id = ?3 and resolved_at is null
            "#,
            params![now_ms(), resolution, id],
        )?;
        Ok(())
    }

    fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        self.transaction(|tx| tx.retry_conflict_keep_local(id))
    }
}

impl RusqliteStore {
    fn task_scoped_rows_health_summary(
        &mut self,
        subscriptions: &[SubscriptionSpec],
        tables: &[String],
        clear_orphaned: bool,
    ) -> Result<ScopedRowsHealthSummary> {
        for table in tables {
            if table != "tasks" {
                return Err(SyncularError::config(format!(
                    "unknown generated app table: {table}"
                )));
            }
        }
        if !tables.is_empty() && !tables.iter().any(|table| table == "tasks") {
            return Ok(ScopedRowsHealthSummary::default());
        }
        let task_subscriptions = subscriptions
            .iter()
            .filter(|subscription| subscription.table == "tasks")
            .collect::<Vec<_>>();
        let mut statement = self.conn.prepare(
            r#"
            select id, user_id, project_id
            from tasks
            where server_version > 0
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut checked_synced_rows = 0i64;
        let mut orphaned_row_ids = Vec::new();
        for row in rows {
            let (id, user_id, project_id) = row?;
            checked_synced_rows += 1;
            if task_subscriptions.is_empty()
                || !task_subscriptions.iter().any(|subscription| {
                    task_row_matches_subscription(&user_id, &project_id, subscription)
                })
            {
                orphaned_row_ids.push(id);
            }
        }
        drop(statement);
        if clear_orphaned {
            for row_id in &orphaned_row_ids {
                self.conn
                    .execute("delete from tasks where id = ?1", params![row_id])?;
            }
        }
        let orphaned_synced_rows = orphaned_row_ids.len() as i64;
        Ok(ScopedRowsHealthSummary {
            checked_synced_rows,
            orphaned_synced_rows,
            tables: vec![ScopedRowsTableHealth {
                table: "tasks".to_string(),
                checked_synced_rows,
                orphaned_synced_rows,
            }],
        })
    }
}

impl RusqliteTx<'_> {
    fn add_task(
        &mut self,
        actor_id: &str,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        let mutation = NewTask::new(&task_id, &title_value, actor_id, project_id);
        self.upsert_row("tasks", &mutation.row_json(), Some(0))?;
        self.enqueue_outbox(vec![mutation.sync_operation()])?;
        Ok(())
    }

    fn patch_task_title(
        &mut self,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()> {
        let mutation = TaskPatch::new(&task_id)
            .title(&title_value)
            .project_id(project_id);
        self.tx.execute(
            "update tasks set title = ?1 where id = ?2",
            params![title_value, task_id],
        )?;
        self.enqueue_outbox(vec![mutation.sync_operation()])?;
        Ok(())
    }

    fn enqueue_outbox(&mut self, operations: Vec<SyncOperation>) -> Result<String> {
        self.assert_outbox_capacity()?;
        let id = Uuid::new_v4().to_string();
        let client_commit_id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.tx.execute(
            r#"
            insert into sync_outbox_commits (
                id, client_commit_id, status, operations_json, last_response_json,
                error, created_at, updated_at, attempt_count, acked_commit_seq, schema_version,
                next_attempt_at
            ) values (?1, ?2, 'pending', ?3, null, null, ?4, ?5, 0, null, ?6, 0)
            "#,
            params![
                id,
                client_commit_id,
                sync_operations_json_for_outbox(&operations)?,
                now,
                now,
                current_schema_version()
            ],
        )?;
        Ok(client_commit_id)
    }

    fn assert_outbox_capacity(&mut self) -> Result<()> {
        let unresolved: i64 = self.tx.query_row(
            "select count(*) from sync_outbox_commits where status <> 'acked'",
            [],
            |row| row.get(0),
        )?;
        validate_unresolved_outbox_capacity(usize::try_from(unresolved).unwrap_or(usize::MAX))
    }

    fn retry_conflict_keep_local(&mut self, conflict_id: &str) -> Result<String> {
        let (server_version, op_index, operations_json): (i64, i32, String) = self
            .tx
            .query_row(
                r#"
                select c.server_version, c.op_index, o.operations_json
                from sync_conflicts c
                join sync_outbox_commits o on o.id = c.outbox_commit_id
                where c.id = ?1 and c.resolved_at is null
                limit 1
                "#,
                params![conflict_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| {
                SyncularError::config(format!("pending conflict not found: {conflict_id}"))
            })?;

        let mut operations: Vec<SyncOperation> = serde_json::from_str(&operations_json)?;
        let operation = operations.get_mut(op_index as usize).ok_or_else(|| {
            SyncularError::protocol_message(format!("conflict op index {op_index} out of bounds"))
        })?;
        operation.base_version = Some(server_version);
        let retry_client_commit_id = self.enqueue_outbox(vec![operation.clone()])?;

        self.tx.execute(
            r#"
            update sync_conflicts
            set resolved_at = ?1, resolution = 'keep-local'
            where id = ?2 and resolved_at is null
            "#,
            params![now_ms(), conflict_id],
        )?;

        Ok(retry_client_commit_id)
    }

    fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        match operation.op.as_str() {
            "upsert" => {
                let row = local_row.unwrap_or_else(|| row_from_operation_payload(&operation));
                self.upsert_row(
                    &operation.table,
                    &row,
                    Some(operation.base_version.unwrap_or(0)),
                )?;
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

impl SyncStoreTx for RusqliteTx<'_> {
    fn pending_outbox(&mut self, limit: i64) -> Result<Vec<OutboxCommit>> {
        let mut statement = self.tx.prepare(
            r#"
            select id, client_commit_id, status, operations_json, last_response_json,
                   error, created_at, updated_at, attempt_count, acked_commit_seq, schema_version,
                   next_attempt_at, lease_id, lease_expires_at_ms, lease_status_at_enqueue,
                   lease_scope_summary_json, lease_token
            from sync_outbox_commits
            where status = 'pending' and attempt_count < ?1 and next_attempt_at <= ?2
            order by created_at asc
            limit ?3
            "#,
        )?;
        let rows =
            statement.query_map(params![MAX_SYNC_RETRIES, now_ms(), limit], outbox_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn requeue_stale_outbox(&mut self) -> Result<()> {
        let now = now_ms();
        let stale_before = now - SYNC_SENDING_TIMEOUT_MS;
        self.tx.execute(
            r#"
            update sync_outbox_commits
            set status = case
                    when attempt_count >= ?1 then 'failed'
                    else 'pending'
                end,
                error = case
                    when attempt_count >= ?1 then 'Sync attempt timed out while in sending state'
                    else 'Sync attempt timed out while in sending state; retrying'
                end,
                next_attempt_at = case
                    when attempt_count >= ?1 then 0
                    else ?2
                end,
                updated_at = ?2
            where status = 'sending' and updated_at < ?3
            "#,
            params![MAX_SYNC_RETRIES, now, stale_before],
        )?;
        Ok(())
    }

    fn mark_outbox_sending(&mut self, row_id: &str) -> Result<()> {
        self.tx.execute(
            r#"
            update sync_outbox_commits
            set status = 'sending',
                updated_at = ?1,
                attempt_count = attempt_count + 1,
                error = null,
                next_attempt_at = 0
            where id = ?2
            "#,
            params![now_ms(), row_id],
        )?;
        Ok(())
    }

    fn mark_outbox_acked(&mut self, row_id: &str, response: &PushCommitResponse) -> Result<()> {
        self.tx.execute(
            r#"
            update sync_outbox_commits
            set status = 'acked',
                updated_at = ?1,
                acked_commit_seq = ?2,
                last_response_json = ?3,
                error = null,
                next_attempt_at = 0
            where id = ?4
            "#,
            params![
                now_ms(),
                response.commit_seq,
                serde_json::to_string(response)?,
                row_id
            ],
        )?;
        Ok(())
    }

    fn mark_outbox_failed(
        &mut self,
        row_id: &str,
        error: &str,
        response: &PushCommitResponse,
    ) -> Result<()> {
        self.tx.execute(
            r#"
            update sync_outbox_commits
            set status = 'failed',
                updated_at = ?1,
                last_response_json = ?2,
                error = ?3,
                next_attempt_at = 0
            where id = ?4
            "#,
            params![now_ms(), serde_json::to_string(response)?, error, row_id],
        )?;
        Ok(())
    }

    fn mark_outbox_retry(
        &mut self,
        row_id: &str,
        error: &str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Result<()> {
        self.tx.execute(
            r#"
            update sync_outbox_commits
            set status = ?1,
                updated_at = ?2,
                error = ?3,
                next_attempt_at = ?4
            where id = ?5
            "#,
            params![
                if failed { "failed" } else { "pending" },
                now_ms(),
                error,
                if failed { 0 } else { next_attempt_at },
                row_id
            ],
        )?;
        Ok(())
    }

    fn insert_conflict(&mut self, outbox: &OutboxCommit, result: &OperationResult) -> Result<()> {
        self.tx.execute(
            r#"
            insert into sync_conflicts (
                id, outbox_commit_id, client_commit_id, op_index, result_status,
                message, code, server_version, server_row_json, created_at,
                resolved_at, resolution
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, null, null)
            "#,
            params![
                Uuid::new_v4().to_string(),
                outbox.id,
                outbox.client_commit_id,
                result.op_index,
                result.status,
                result
                    .message
                    .clone()
                    .or_else(|| result.error.clone())
                    .unwrap_or_else(|| result.status.clone()),
                result.code,
                result.server_version,
                result.server_row.as_ref().map(Value::to_string),
                now_ms()
            ],
        )?;
        Ok(())
    }

    fn subscription_state(
        &mut self,
        state_id: &str,
        subscription_id: &str,
    ) -> Result<Option<SubscriptionState>> {
        self.tx
            .query_row(
                r#"
                select state_id, subscription_id, "table", scopes_json, params_json,
                       cursor, bootstrap_state_json, status
                from sync_subscription_state
                where state_id = ?1 and subscription_id = ?2
                limit 1
                "#,
                params![state_id, subscription_id],
                subscription_state_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    fn subscription_states(&mut self, state_id: &str) -> Result<Vec<SubscriptionState>> {
        let mut statement = self.tx.prepare(
            r#"
            select state_id, subscription_id, "table", scopes_json, params_json,
                   cursor, bootstrap_state_json, status
            from sync_subscription_state
            where state_id = ?1
            order by subscription_id asc
            "#,
        )?;
        let rows = statement
            .query_map(params![state_id], subscription_state_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn upsert_subscription_state(&mut self, state: &SubscriptionState) -> Result<()> {
        let now = now_ms();
        self.tx.execute(
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
            params![
                state.state_id,
                state.subscription_id,
                state.table,
                state.scopes_json,
                state.params_json,
                state.cursor,
                state.bootstrap_state_json,
                state.status,
                now,
                now
            ],
        )?;
        Ok(())
    }

    fn delete_subscription_state(&mut self, state_id: &str, subscription_id: &str) -> Result<()> {
        self.tx.execute(
            r#"
            delete from sync_subscription_state
            where state_id = ?1 and subscription_id = ?2
            "#,
            params![state_id, subscription_id],
        )?;
        Ok(())
    }

    fn verified_root(
        &mut self,
        state_id: &str,
        subscription_id: &str,
    ) -> Result<Option<VerifiedRoot>> {
        self.tx
            .query_row(
                r#"
                select state_id, subscription_id, partition_id, commit_seq, root
                from sync_verified_roots
                where state_id = ?1 and subscription_id = ?2
                limit 1
                "#,
                params![state_id, subscription_id],
                |row| {
                    Ok(VerifiedRoot {
                        state_id: row.get(0)?,
                        subscription_id: row.get(1)?,
                        partition_id: row.get(2)?,
                        commit_seq: row.get(3)?,
                        root: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn verified_roots(&mut self, state_id: &str) -> Result<Vec<VerifiedRoot>> {
        let mut statement = self.tx.prepare(
            r#"
            select state_id, subscription_id, partition_id, commit_seq, root
            from sync_verified_roots
            where state_id = ?1
            order by subscription_id asc
            "#,
        )?;
        let rows = statement
            .query_map(params![state_id], |row| {
                Ok(VerifiedRoot {
                    state_id: row.get(0)?,
                    subscription_id: row.get(1)?,
                    partition_id: row.get(2)?,
                    commit_seq: row.get(3)?,
                    root: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn upsert_verified_root(&mut self, root: &VerifiedRoot) -> Result<()> {
        let now = now_ms();
        self.tx.execute(
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
            params![
                root.state_id,
                root.subscription_id,
                root.partition_id,
                root.commit_seq,
                root.root,
                now,
                now
            ],
        )?;
        Ok(())
    }

    fn delete_verified_root(&mut self, state_id: &str, subscription_id: &str) -> Result<()> {
        self.tx.execute(
            r#"
            delete from sync_verified_roots
            where state_id = ?1 and subscription_id = ?2
            "#,
            params![state_id, subscription_id],
        )?;
        Ok(())
    }

    fn clear_table_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<()> {
        if table != "tasks" {
            return Err(SyncularError::codegen(format!(
                "no rusqlite table adapter registered for {table}"
            )));
        }

        let user_id = scopes.get("user_id").and_then(Value::as_str);
        let project_id = scopes.get("project_id").and_then(Value::as_str);
        match (user_id, project_id) {
            (Some(user_id), Some(project_id)) => {
                self.tx.execute(
                    "delete from tasks where user_id = ?1 and project_id = ?2",
                    params![user_id, project_id],
                )?;
            }
            (Some(user_id), None) => {
                self.tx
                    .execute("delete from tasks where user_id = ?1", params![user_id])?;
            }
            _ => {
                self.tx.execute("delete from tasks", [])?;
            }
        }
        Ok(())
    }

    fn clear_synced_rows_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<i64> {
        if table != "tasks" {
            return Err(SyncularError::codegen(format!(
                "no rusqlite table adapter registered for {table}"
            )));
        }

        let user_id = scopes.get("user_id").and_then(Value::as_str);
        let project_id = scopes.get("project_id").and_then(Value::as_str);
        let deleted = match (user_id, project_id) {
            (Some(user_id), Some(project_id)) => self.tx.execute(
                "delete from tasks where user_id = ?1 and project_id = ?2 and server_version > 0",
                params![user_id, project_id],
            )?,
            (Some(user_id), None) => self.tx.execute(
                "delete from tasks where user_id = ?1 and server_version > 0",
                params![user_id],
            )?,
            _ => self
                .tx
                .execute("delete from tasks where server_version > 0", [])?,
        };
        Ok(deleted as i64)
    }

    fn current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        if table != "tasks" {
            return Err(SyncularError::codegen(format!(
                "no rusqlite table adapter registered for {table}"
            )));
        }
        let row = self
            .tx
            .query_row(
                r#"
                select id, title, completed, user_id, project_id, server_version, image, title_yjs_state
                from tasks
                where id = ?1
                limit 1
                "#,
                params![row_id],
                task_from_row,
            )
            .optional()?;
        row.map(serde_json::to_value)
            .transpose()
            .map_err(Into::into)
    }

    fn upsert_row(
        &mut self,
        table: &str,
        row: &Value,
        fallback_version: Option<i64>,
    ) -> Result<()> {
        if table != "tasks" {
            return Err(SyncularError::codegen(format!(
                "no rusqlite table adapter registered for {table}"
            )));
        }

        let obj = row.as_object().ok_or_else(|| {
            SyncularError::protocol_message(format!("row is not an object: {row}"))
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncularError::protocol_message("id missing"))?;
        let title = obj.get("title").and_then(Value::as_str).unwrap_or("");
        let completed = obj.get("completed").and_then(Value::as_i64).unwrap_or(0) as i32;
        let user_id = obj.get("user_id").and_then(Value::as_str).unwrap_or("");
        let project_id = obj.get("project_id").and_then(Value::as_str);
        let server_version = fallback_version
            .or_else(|| obj.get("server_version").and_then(Value::as_i64))
            .unwrap_or(0);
        let image = obj.get("image").and_then(Value::as_str);
        let title_yjs_state = obj.get("title_yjs_state").and_then(Value::as_str);

        self.tx.execute(
            r#"
            insert into tasks (
                id, title, completed, user_id, project_id, server_version, image, title_yjs_state
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            on conflict (id) do update set
                title = excluded.title,
                completed = excluded.completed,
                user_id = excluded.user_id,
                project_id = excluded.project_id,
                server_version = excluded.server_version,
                image = excluded.image,
                title_yjs_state = excluded.title_yjs_state
            "#,
            params![
                id,
                title,
                completed,
                user_id,
                project_id,
                server_version,
                image,
                title_yjs_state
            ],
        )?;
        Ok(())
    }

    fn apply_change(&mut self, change: &SyncChange) -> Result<()> {
        if change.table != "tasks" {
            return Err(SyncularError::codegen(format!(
                "no rusqlite table adapter registered for {}",
                change.table
            )));
        }

        if change.op == "delete" {
            self.tx
                .execute("delete from tasks where id = ?1", params![change.row_id])?;
            return Ok(());
        }

        let row = change.row_json.as_ref().ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "upsert change missing row_json for {}",
                change.row_id
            ))
        })?;
        self.upsert_row("tasks", row, change.row_version)
    }
}

fn outbox_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxCommit> {
    Ok(OutboxCommit {
        id: row.get(0)?,
        client_commit_id: row.get(1)?,
        status: row.get(2)?,
        operations_json: row.get(3)?,
        last_response_json: row.get(4)?,
        error: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        attempt_count: row.get(8)?,
        acked_commit_seq: row.get(9)?,
        schema_version: row.get(10)?,
        next_attempt_at: row.get(11)?,
        auth_lease: auth_lease_provenance_from_columns(
            row.get(12)?,
            row.get(13)?,
            row.get(14)?,
            row.get(15)?,
            row.get(16)?,
        ),
    })
}

fn subscription_state_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubscriptionState> {
    Ok(SubscriptionState {
        state_id: row.get(0)?,
        subscription_id: row.get(1)?,
        table: row.get(2)?,
        scopes_json: row.get(3)?,
        params_json: row.get(4)?,
        cursor: row.get(5)?,
        bootstrap_state_json: row.get(6)?,
        status: row.get(7)?,
    })
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        completed: row.get(2)?,
        user_id: row.get(3)?,
        project_id: row.get(4)?,
        server_version: row.get(5)?,
        image: row.get(6)?,
        title_yjs_state: row.get(7)?,
    })
}

fn task_row_matches_subscription(
    user_id: &str,
    project_id: &Option<String>,
    subscription: &SubscriptionSpec,
) -> bool {
    let Some(expected_user_id) = subscription.scopes.get("user_id") else {
        return false;
    };
    if !scope_value_matches(expected_user_id, Some(user_id)) {
        return false;
    }
    match subscription.scopes.get("project_id") {
        Some(expected_project_id) => {
            scope_value_matches(expected_project_id, project_id.as_deref())
        }
        None => true,
    }
}

fn scope_value_matches(expected: &Value, actual: Option<&str>) -> bool {
    match expected {
        Value::Array(values) => values
            .iter()
            .any(|value| scope_value_matches(value, actual)),
        Value::Null => actual.is_none(),
        Value::String(value) => actual == Some(value.as_str()),
        _ => actual.is_some_and(|actual| expected == &Value::String(actual.to_string())),
    }
}

fn applied_migration_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppliedMigration> {
    Ok(AppliedMigration {
        version: row.get(0)?,
        name: row.get(1)?,
        checksum: row.get(2)?,
        applied_at: row.get(3)?,
    })
}

fn outbox_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxSummary> {
    Ok(OutboxSummary {
        outbox_id: row.get(0)?,
        client_commit_id: row.get(1)?,
        status: row.get(2)?,
        schema_version: row.get(3)?,
        acked_commit_seq: row.get(4)?,
        auth_lease: auth_lease_provenance_from_columns(
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
        ),
    })
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

fn conflict_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConflictSummary> {
    Ok(ConflictSummary {
        id: row.get(0)?,
        client_commit_id: row.get(1)?,
        op_index: row.get(2)?,
        result_status: row.get(3)?,
        message: row.get(4)?,
        code: row.get(5)?,
        server_version: row.get(6)?,
        resolved_at: row.get(7)?,
        resolution: row.get(8)?,
    })
}
