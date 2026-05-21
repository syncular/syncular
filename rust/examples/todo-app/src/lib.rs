pub mod generated {
    pub mod schema {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/generated/rust/schema.rs"
        ));
    }

    pub mod syncular {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/generated/rust/syncular.rs"
        ));
    }

    pub mod diesel_tables {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/generated/rust/diesel_tables.rs"
        ));
    }

    pub mod migrations {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/generated/rust/migrations.rs"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::generated::{diesel_tables, migrations, schema, syncular};
    use diesel::connection::SimpleConnection;
    use diesel::prelude::*;
    use diesel::sql_types::{Integer, Text};
    use diesel::sqlite::SqliteConnection;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use syncular_client::app_schema::AppSchema;
    use syncular_client::client::{
        SyncChangedRow, SyncReport, SyncularClient, SyncularClientConfig,
    };

    #[test]
    fn generated_rust_schema_builds_diesel_queries() {
        let mut conn = migrated_connection();
        let adapter = diesel_tables::adapter_for("tasks").expect("tasks adapter");
        adapter
            .upsert_row(
                &mut conn,
                &json!({
                    "id": "task-rust-1",
                    "title": "prove diesel codegen",
                    "completed": 0,
                    "user_id": "user-rust",
                    "project_id": "project-rust",
                    "server_version": 0,
                    "image": null,
                    "title_yjs_state": null
                }),
                Some(7),
            )
            .expect("upsert generated row");

        let count: i64 = schema::tasks::dsl::tasks
            .filter(schema::tasks::dsl::user_id.eq("user-rust"))
            .count()
            .get_result(&mut conn)
            .expect("typed Diesel query");
        assert_eq!(count, 1);

        let rows = adapter
            .list_rows_json(&mut conn)
            .expect("list generated rows");
        assert_eq!(rows[0]["id"], "task-rust-1");
        assert_eq!(rows[0]["server_version"], 7);
    }

    #[test]
    fn generated_local_read_model_sql_rebuilds_and_tracks_changes() {
        #[derive(QueryableByName)]
        struct TaskCountRow {
            #[diesel(sql_type = Text)]
            user_id: String,
            #[diesel(sql_type = Integer)]
            completed: i32,
            #[diesel(sql_type = Integer)]
            task_count: i32,
        }

        let mut conn = migrated_connection();
        let adapter = diesel_tables::adapter_for("tasks").expect("tasks adapter");
        for (id, completed) in [
            ("task-rust-count-1", 0),
            ("task-rust-count-2", 0),
            ("task-rust-count-3", 1),
        ] {
            adapter
                .upsert_row(
                    &mut conn,
                    &json!({
                        "id": id,
                        "title": id,
                        "completed": completed,
                        "user_id": "user-rust",
                        "project_id": "project-rust",
                        "server_version": 0,
                        "image": null,
                        "title_yjs_state": null
                    }),
                    Some(1),
                )
                .expect("seed task row");
        }

        let read_model = migrations::LOCAL_READ_MODELS
            .iter()
            .find(|model| model.name == "taskCountsByUserCompletion")
            .expect("generated task-count read model");
        for statement in read_model.setup_sql {
            conn.batch_execute(statement)
                .expect("install read-model setup SQL");
        }
        for statement in read_model.rebuild_sql {
            conn.batch_execute(statement)
                .expect("rebuild read-model SQL");
        }

        let counts = task_counts(&mut conn);
        assert_eq!(counts, vec![(0, 2), (1, 1)]);

        adapter
            .upsert_row(
                &mut conn,
                &json!({
                    "id": "task-rust-count-2",
                    "title": "task-rust-count-2",
                    "completed": 1,
                    "user_id": "user-rust",
                    "project_id": "project-rust",
                    "server_version": 0,
                    "image": null,
                    "title_yjs_state": null
                }),
                Some(2),
            )
            .expect("update task row");
        diesel::delete(
            schema::tasks::dsl::tasks.filter(schema::tasks::dsl::id.eq("task-rust-count-3")),
        )
        .execute(&mut conn)
        .expect("delete task row");

        let counts = task_counts(&mut conn);
        assert_eq!(counts, vec![(0, 1), (1, 1)]);
        let typed_counts: Vec<(i32, i32)> = schema::syncular_task_counts::dsl::syncular_task_counts
            .filter(schema::syncular_task_counts::dsl::user_id.eq("user-rust"))
            .order(schema::syncular_task_counts::dsl::completed.asc())
            .select((
                schema::syncular_task_counts::dsl::completed,
                schema::syncular_task_counts::dsl::task_count,
            ))
            .load(&mut conn)
            .expect("typed Diesel read-model query");
        assert_eq!(typed_counts, counts);

        fn task_counts(conn: &mut SqliteConnection) -> Vec<(i32, i32)> {
            diesel::sql_query(
                r#"
                SELECT user_id, completed, task_count
                FROM syncular_task_counts
                WHERE user_id = 'user-rust'
                ORDER BY completed ASC
                "#,
            )
            .load::<TaskCountRow>(conn)
            .expect("load read-model counts")
            .into_iter()
            .map(|row| {
                assert_eq!(row.user_id, "user-rust");
                (row.completed, row.task_count)
            })
            .collect()
        }
    }

    #[test]
    fn generated_rust_mutations_and_subscriptions_use_the_sdk_types() {
        let conformance = generated_client_conformance();
        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };

        let subscriptions = syncular::default_subscriptions(&config);
        assert_eq!(subscriptions.len(), 3);
        assert_eq!(subscriptions[2].table, "tasks");
        assert_eq!(subscriptions[2].scopes["user_id"], "user-rust");
        assert_eq!(subscriptions[2].scopes["project_id"], "project-rust");
        assert_eq!(
            serde_json::to_value(&subscriptions[2]).expect("subscription JSON"),
            conformance["task"]["subscription"]
        );

        let mut new_task = syncular::NewTask::new(
            "task-native",
            "Native smoke",
            "user-rust",
            Some("project-rust"),
        );
        new_task.completed = 1;
        let operation = new_task.sync_operation();
        assert_eq!(operation.table, "tasks");
        assert_eq!(operation.row_id, "task-native");
        assert_eq!(operation.op, "upsert");
        assert_eq!(
            operation
                .payload
                .as_ref()
                .and_then(|payload| payload.get("title")),
            Some(&json!("Native smoke"))
        );
        assert_eq!(
            serde_json::to_value(&operation).expect("new task operation JSON"),
            conformance["task"]["newOperation"]
        );

        let patch_operation = syncular::TaskPatch::new("task-native")
            .completed(0)
            .base_version(11)
            .sync_operation();
        assert_eq!(
            serde_json::to_value(&patch_operation).expect("patch task operation JSON"),
            conformance["task"]["patchOperation"]
        );

        let delete_operation = syncular::delete_task("task-native", Some(12));
        assert_eq!(
            serde_json::to_value(&delete_operation).expect("delete task operation JSON"),
            conformance["task"]["deleteOperation"]
        );
    }

    #[test]
    fn generated_rust_changed_row_helpers_type_generic_deltas() {
        let rows = vec![
            SyncChangedRow {
                table: "tasks".to_string(),
                row_id: Some("task-native".to_string()),
                operation: "update".to_string(),
                changed_fields: vec![
                    "title".to_string(),
                    "title_yjs_state".to_string(),
                    "unknown_column".to_string(),
                ],
                crdt_fields: vec!["title_yjs_state".to_string()],
                commit_id: Some("commit-delta".to_string()),
                commit_seq: Some(7),
                subscription_id: Some("sub-tasks".to_string()),
                server_version: Some(11),
                ..SyncChangedRow::default()
            },
            SyncChangedRow {
                table: "projects".to_string(),
                row_id: Some("project-rust".to_string()),
                operation: "delete".to_string(),
                changed_fields: vec!["name".to_string()],
                ..SyncChangedRow::default()
            },
        ];

        let task_rows = syncular::task_changed_rows(&rows);
        assert_eq!(task_rows.len(), 1);
        let task = task_rows[0];
        assert_eq!(task.row_id(), Some("task-native"));
        assert!(task.is_update());
        assert!(!task.is_insert());
        assert!(task.changed.title);
        assert!(task.changed.title_yjs_state);
        assert!(!task.changed.completed);
        assert!(task.changed.contains("title"));
        assert!(!task.changed.contains("unknown_column"));
        assert!(task.crdt.title_yjs_state);
        assert_eq!(task.raw.commit_id.as_deref(), Some("commit-delta"));
        assert_eq!(syncular::project_changed_rows(&rows).len(), 1);
        assert!(syncular::project_changed_rows(&rows)[0].is_delete());
        assert!(syncular::comment_changed_rows(&rows).is_empty());
    }

    #[test]
    fn generated_app_schema_drives_the_sdk_store() {
        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust-store".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");
        let task = syncular::NewTask::new(
            "task-rust-store",
            "drive SDK with generated schema",
            "user-rust",
            Some("project-rust"),
        );
        let operation_json = serde_json::to_string(&task.sync_operation()).expect("operation JSON");

        let commit_id = client
            .apply_mutation_json(&operation_json, None)
            .expect("apply generated operation");
        assert!(!commit_id.is_empty());

        let rows: Vec<serde_json::Value> =
            serde_json::from_str(&client.list_table_json("tasks").expect("list rows"))
                .expect("rows JSON");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "task-rust-store");
        assert_eq!(rows[0]["title"], "drive SDK with generated schema");

        let outbox = client.outbox_summaries().expect("outbox");
        assert_eq!(outbox.len(), 1);
        assert_eq!(
            outbox[0].schema_version,
            migrations::current_schema_version()
        );
    }

    #[test]
    fn rust_client_exposes_diesel_reads_and_typed_syncular_mutations() {
        use diesel_tables::TaskRow;
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust-ergonomic".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        let inserted = client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::with_generated_id(
                "typed insert",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("typed insert");
        assert!(!inserted.id.is_empty());
        assert!(!inserted.commit.client_commit_id.is_empty());

        let rows: Vec<TaskRow> = client
            .read(
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::user_id.eq("user-rust"))
                    .order(schema::tasks::dsl::server_version.desc())
                    .select(TaskRow::as_select()),
            )
            .expect("typed Diesel client read");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "typed insert");

        client
            .mutations()
            .tasks()
            .update(syncular::TaskPatch::new(&inserted.id).completed(1))
            .expect("typed update");

        let rows: Vec<TaskRow> = client
            .read(
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::id.eq(&inserted.id))
                    .select(TaskRow::as_select()),
            )
            .expect("typed Diesel client read after update");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "typed insert");
        assert_eq!(rows[0].completed, 1);

        let batched = client
            .commit(|tx| {
                let id = tx.tasks().insert(syncular::NewTask::with_generated_id(
                    "batched insert",
                    "user-rust",
                    Some("project-rust"),
                ))?;
                tx.tasks()
                    .update(syncular::TaskPatch::new(&id).completed(1))?;
                Ok(id)
            })
            .expect("typed batched commit");
        assert!(!batched.result.is_empty());
        assert!(!batched.commit.client_commit_id.is_empty());

        let outbox = client.outbox_summaries().expect("outbox");
        assert_eq!(outbox.len(), 3);
    }

    #[test]
    fn rust_client_generated_command_history_undo_redo_uses_mutation_path() {
        use diesel_tables::TaskRow;
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust-command-history".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        let inserted = client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::new(
                "history-task",
                "command history",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("seed task");

        client
            .commit_with_history(|tx| {
                tx.tasks()
                    .update(syncular::TaskPatch::new(&inserted.id).completed(1))?;
                Ok(())
            })
            .expect("tracked update");
        assert!(client
            .command_history()
            .can_undo()
            .expect("can undo after tracked update"));

        let rows: Vec<TaskRow> = client
            .read(
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::id.eq(&inserted.id))
                    .select(TaskRow::as_select()),
            )
            .expect("read after tracked update");
        assert_eq!(rows[0].completed, 1);

        let undo = client
            .command_history()
            .undo_last()
            .expect("undo tracked update");
        assert!(!undo.command_id.is_empty());
        assert!(!undo.commit.client_commit_id.is_empty());
        let rows: Vec<TaskRow> = client
            .read(
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::id.eq(&inserted.id))
                    .select(TaskRow::as_select()),
            )
            .expect("read after undo");
        assert_eq!(rows[0].completed, 0);
        assert!(client
            .command_history()
            .can_redo()
            .expect("can redo after undo"));

        let redo = client
            .command_history()
            .redo_last()
            .expect("redo tracked update");
        assert_eq!(redo.command_id, undo.command_id);
        let rows: Vec<TaskRow> = client
            .read(
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::id.eq(&inserted.id))
                    .select(TaskRow::as_select()),
            )
            .expect("read after redo");
        assert_eq!(rows[0].completed, 1);

        let outbox = client.outbox_summaries().expect("outbox");
        assert_eq!(outbox.len(), 4);
    }

    #[test]
    fn rust_client_generated_command_history_rejects_stale_undo() {
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust-command-history-conflict".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::new(
                "history-conflict-task",
                "command history conflict",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("seed task");
        client
            .commit_with_history(|tx| {
                tx.tasks()
                    .update(syncular::TaskPatch::new("history-conflict-task").completed(1))?;
                Ok(())
            })
            .expect("tracked update");
        client
            .mutations()
            .tasks()
            .update(syncular::TaskPatch::new("history-conflict-task").completed(2))
            .expect("independent local update");

        let error = client
            .command_history()
            .undo_last()
            .expect_err("stale undo should fail");
        assert!(error
            .message_text()
            .contains("sync.command_history_conflict"));

        let outbox = client.outbox_summaries().expect("outbox");
        assert_eq!(outbox.len(), 3);
    }

    #[test]
    fn rust_client_conflicts_have_ergonomic_resolution_helpers() {
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let base_url = rejecting_sync_server();
        let db_path = temp_db_path("conflicts-keep-local");
        let config = SyncularClientConfig {
            db_path: db_path.clone(),
            base_url,
            client_id: "client-rust-conflicts".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::new(
                "task-conflict",
                "local winner",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("typed insert");

        let report = client.sync_http().expect("sync conflict");
        assert!(report.conflicts_changed);

        let pending = client.conflicts().pending().expect("pending conflicts");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].code.as_deref(), Some("sync.version_conflict"));

        let receipt = client
            .conflicts()
            .keep_local(&pending[0].id)
            .expect("keep local conflict");
        assert_eq!(
            receipt.resolution,
            syncular_client::client::ConflictResolution::KeepLocal
        );
        assert!(receipt.retry_client_commit_id.is_some());
        assert!(client.conflicts().is_empty().expect("resolved conflicts"));

        let outbox = client.outbox_summaries().expect("outbox");
        assert_eq!(outbox.len(), 2);
        assert_eq!(outbox[1].status, "pending");
        assert_eq!(
            Some(outbox[1].client_commit_id.as_str()),
            receipt.retry_client_commit_id.as_deref()
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn rust_client_conflicts_keep_server_uses_js_resolution_string() {
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let base_url = rejecting_sync_server();
        let db_path = temp_db_path("conflicts-keep-server");
        let config = SyncularClientConfig {
            db_path: db_path.clone(),
            base_url,
            client_id: "client-rust-keep-server-conflict".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::new(
                "task-conflict",
                "local winner",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("typed insert");
        client.sync_http().expect("sync conflict");

        let pending = client.conflicts().pending().expect("pending conflicts");
        assert_eq!(pending.len(), 1);
        let receipt = client
            .conflicts()
            .accept_server(&pending[0].id)
            .expect("accept server conflict");

        assert_eq!(
            receipt.resolution,
            syncular_client::client::ConflictResolution::AcceptServer
        );
        assert_eq!(receipt.resolution.as_str(), "keep-server");
        assert!(receipt.retry_client_commit_id.is_none());
        assert!(client.conflicts().is_empty().expect("resolved conflicts"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn rust_client_live_query_refreshes_from_sync_reports() {
        use diesel_tables::TaskRow;
        use syncular::prelude::SyncularGeneratedMutationsExt;

        let config = SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://localhost:9811/api/sync".to_string(),
            client_id: "client-rust-live-query".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("project-rust".to_string()),
        };
        let mut client =
            SyncularClient::open_with_schema(config, generated_app_schema()).expect("open client");

        let mut live: syncular_client::client::SyncularLiveQuery<_, TaskRow> = client
            .live_query(["tasks"], || {
                schema::tasks::dsl::tasks
                    .filter(schema::tasks::dsl::user_id.eq("user-rust"))
                    .order(schema::tasks::dsl::server_version.desc())
                    .select(TaskRow::as_select())
            })
            .expect("live query");

        assert_eq!(live.rows().len(), 0);
        assert_eq!(live.revision(), 1);

        client
            .mutations()
            .tasks()
            .insert(syncular::NewTask::new(
                "task-live-query",
                "live query row",
                "user-rust",
                Some("project-rust"),
            ))
            .expect("typed insert");

        let unrelated = SyncReport::table_changed("projects");
        assert!(!live
            .refresh_if_changed(&mut client, &unrelated)
            .expect("unrelated refresh"));
        assert_eq!(live.rows().len(), 0);

        let changed = SyncReport::table_changed("tasks");
        assert!(live
            .refresh_if_changed(&mut client, &changed)
            .expect("affected refresh"));
        assert_eq!(live.rows().len(), 1);
        assert_eq!(live.rows()[0].title, "live query row");
        assert_eq!(live.revision(), 2);
    }

    fn generated_client_conformance() -> Value {
        serde_json::from_str(include_str!("../conformance/generated-client.json"))
            .expect("generated client conformance JSON")
    }

    fn migrated_connection() -> SqliteConnection {
        let mut conn = SqliteConnection::establish(":memory:").expect("open sqlite");
        for migration in migrations::MIGRATIONS {
            conn.batch_execute(migration.up_sql)
                .expect("apply migration");
        }
        conn
    }

    fn generated_app_schema() -> AppSchema {
        AppSchema {
            app_tables: syncular::APP_TABLES,
            app_table_metadata: syncular::APP_TABLE_METADATA,
            migrations: migrations::MIGRATIONS,
            schema_version: None,
            default_subscriptions: syncular::default_subscriptions,
            adapter_for: diesel_tables::adapter_for,
        }
    }

    fn temp_db_path(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "syncular-todo-app-{name}-{}-{nanos}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn rejecting_sync_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind rejecting server");
        let addr = listener.local_addr().expect("server addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept sync request");
            let request = read_http_request(&mut stream);
            let body_start = http_header_end(&request).expect("http headers");
            let request_json: serde_json::Value =
                serde_json::from_slice(&request[body_start..]).expect("sync request json");
            let client_commit_id = request_json["push"]["commits"][0]["clientCommitId"]
                .as_str()
                .expect("client commit id");

            let response = json!({
                "ok": true,
                "push": {
                    "ok": true,
                    "commits": [{
                        "clientCommitId": client_commit_id,
                        "status": "rejected",
                        "commitSeq": null,
                        "results": [{
                            "opIndex": 0,
                            "status": "conflict",
                            "message": "version conflict",
                            "error": null,
                            "code": "sync.version_conflict",
                            "retriable": false,
                            "server_version": 9,
                            "server_row": {
                                "id": "task-conflict",
                                "title": "server winner",
                                "completed": 0,
                                "user_id": "user-rust",
                                "project_id": "project-rust",
                                "server_version": 9,
                                "image": null,
                                "title_yjs_state": null
                            }
                        }]
                    }]
                },
                "pull": null
            });
            let body = response.to_string();
            let http = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(http.as_bytes())
                .expect("write sync response");
        });
        format!("http://{addr}/sync")
    }

    fn read_http_request(stream: &mut impl Read) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buf = [0_u8; 1024];
        loop {
            let len = stream.read(&mut buf).expect("read sync request");
            if len == 0 {
                break;
            }
            request.extend_from_slice(&buf[..len]);
            if let Some(header_end) = http_header_end(&request) {
                let header_text = String::from_utf8_lossy(&request[..header_end]);
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + content_length {
                    break;
                }
            }
        }
        request
    }

    fn http_header_end(bytes: &[u8]) -> Option<usize> {
        bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }
}
