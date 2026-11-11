use super::*;
use serde_json::json;

fn schema() -> Value {
    json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]})
}

fn client() -> SyncClient {
    SyncClient::new("robust".into(), &schema(), ClientLimits::default()).expect("client")
}

fn scopes() -> Vec<(String, Vec<String>)> {
    vec![("project_id".to_owned(), vec!["p1".to_owned()])]
}

fn operation(table: &str) -> OutboxOp {
    OutboxOp {
        table: table.into(),
        row_id: "t1".into(),
        upsert: true,
        insert: false,
        base_version: Some(1),
        values: Some(Map::from_iter([("id".into(), json!("t1"))])),
    }
}

// R3
#[test]
fn retained_failed_commits_skip_operations_on_removed_tables() {
    let mut client = client();
    let removed = operation("removed");
    client
        .retain_failed_commit("c1", std::slice::from_ref(&removed))
        .expect("a removed table is skipped, not an error");
    assert_eq!(client.failed_commits.len(), 1);
    client
        .persist_commit_outcome(
            "c1",
            CommitOutcomeStatus::Rejected,
            &[CommitOperationOutcome::Error {
                rejection: RejectionRecord {
                    client_commit_id: "c1".into(),
                    op_index: 0,
                    code: "validation.denied".into(),
                    message: "denied".into(),
                    retryable: false,
                    details: None,
                    operation: None,
                },
            }],
            Some(&[removed]),
        )
        .unwrap();
    let outcome = client.commit_outcome("c1").unwrap().expect("outcome");
    assert_eq!(outcome.retained_rows, Some(Vec::new()));
}

// R5
#[test]
fn a_failed_acknowledged_rows_read_is_an_error() {
    let client = client();
    assert!(!client.has_acknowledged_rows().unwrap());
    client
        .conn
        .execute_batch("DROP TABLE _syncular_acked_rows")
        .unwrap();
    assert!(client.has_acknowledged_rows().is_err());
}

// R5
#[test]
fn finishing_a_round_tolerates_an_unclassified_storage_failure() {
    let mut client = client();
    *client.storage_failure.borrow_mut() =
        Some(QueryReadFailure::from(rusqlite::Error::QueryReturnedNoRows));
    let outcome = client.finish_sync_round(
        0,
        SyncOutcome::Failed {
            error_code: "sync.invalid_request".into(),
            message: "original".into(),
            details: None,
            recommended_action: None,
        },
    );
    let SyncOutcome::Failed {
        error_code,
        message,
        ..
    } = outcome
    else {
        panic!("a failed round stays failed");
    };
    assert_eq!(error_code, "sync.invalid_request");
    assert_eq!(message, "original");
}

// R6
#[test]
fn a_failed_security_preflight_marker_write_fails_the_preflight() {
    let mut client = client();
    client
        .conn
        .execute_batch(&format!(
            "CREATE TRIGGER fail_marker BEFORE INSERT ON _syncular_meta
             WHEN NEW.key = '{SECURITY_PREFLIGHT_PENDING_KEY}'
             BEGIN SELECT RAISE(FAIL, 'injected marker failure'); END"
        ))
        .unwrap();
    let error = client
        .begin_security_preflight()
        .expect_err("the marker write failed");
    assert!(error.contains("injected marker failure"), "{error}");
    assert_eq!(
        client.get_meta(SECURITY_PREFLIGHT_PENDING_KEY).unwrap(),
        None
    );
}

// R6
#[test]
fn a_failed_log_epoch_read_fails_the_round_instead_of_adopting_an_epoch() {
    let mut client = client();
    client
        .conn
        .execute_batch("ALTER TABLE _syncular_meta RENAME TO _syncular_meta_unreadable")
        .unwrap();
    assert!(matches!(
        client.build_request(false).err().as_deref(),
        Some(SyncOutcome::Failed { .. })
    ));
    assert!(client.run_log_epoch_reset("epoch-2").is_err());
}

// R7
#[test]
fn an_image_scan_that_disagrees_with_its_count_aborts() {
    let path = std::env::temp_dir().join(format!(
        "syncular-image-fixture-{}.db",
        uuid::Uuid::new_v4()
    ));
    let image = Connection::open(&path).unwrap();
    image
        .execute_batch(
            "PRAGMA page_size = 512;
             CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, _syncular_version INTEGER NOT NULL);
             CREATE INDEX tasks_version ON tasks(_syncular_version);
             INSERT INTO tasks VALUES ('a','p1',1),('b','p1',2),('c','p1',3);
             CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
             INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',2);",
        )
        .unwrap();
    let root: usize = image
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name = 'tasks_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(image);
    // Drop the last entry of the version index: `count(*)` reads the
    // index and reports 2 while the primary-key scan still yields 3 rows.
    let mut bytes = std::fs::read(&path).unwrap();
    let header = (root - 1) * 512;
    bytes[header + 3..header + 5].copy_from_slice(&2u16.to_be_bytes());
    std::fs::write(&path, &bytes).unwrap();
    let image =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        image
            .query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );

    let mut client = client();
    let table = client.schema.table("tasks").unwrap().clone();
    let error = client
        .apply_sqlite_image(&image, &table, true, &scopes(), &[], 2, 7, "digest")
        .expect_err("a scan longer than the declared count aborts");
    let SectionError::Abort(code, message) = error else {
        panic!("expected an abort");
    };
    assert_eq!(code, "sync.invalid_request");
    assert!(message.contains("expected 2"), "{message}");
    drop(image);
    std::fs::remove_file(path).unwrap();
}

fn image_bytes() -> Vec<u8> {
    let path = std::env::temp_dir().join(format!(
        "syncular-image-fixture-{}.db",
        uuid::Uuid::new_v4()
    ));
    let image = Connection::open(&path).unwrap();
    image
        .execute_batch(
            "CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, _syncular_version INTEGER NOT NULL);
             INSERT INTO tasks VALUES ('a','p1',1),('b','p1',1);
             CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
             INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',2);",
        )
        .unwrap();
    drop(image);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    bytes
}

#[cfg(unix)]
/// Lists the image temp files in `directory` with their modes, read from
/// the commit hook of the first image chunk while the apply is running.
fn watch_image_files(
    client: &mut SyncClient,
    directory: std::path::PathBuf,
) -> std::sync::Arc<std::sync::Mutex<Vec<(std::path::PathBuf, u32)>>> {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = seen.clone();
    client
        .conn
        .commit_hook(Some(move || {
            for entry in std::fs::read_dir(&directory).unwrap().flatten() {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".syncular-image-")
                {
                    let mode = std::os::unix::fs::PermissionsExt::mode(
                        &entry.metadata().unwrap().permissions(),
                    ) & 0o777;
                    sink.lock().unwrap().push((entry.path(), mode));
                }
            }
            false
        }))
        .unwrap();
    seen
}

// R7
#[cfg(unix)]
#[test]
fn the_image_temp_file_sits_beside_the_replica_owner_only_and_is_removed() {
    let directory =
        std::env::temp_dir().join(format!("syncular-image-dir-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let replica = directory.join("replica.db");
    let mut client = SyncClient::open_path(
        "image-beside".into(),
        &schema(),
        ClientLimits::default(),
        replica.to_str().unwrap(),
    )
    .unwrap();
    let table = client.schema.table("tasks").unwrap().clone();
    let seen = watch_image_files(&mut client, directory.clone());
    let applied = client
        .apply_sqlite_segment(&table, &image_bytes(), true, &scopes(), &[], 2, 7, "digest")
        .unwrap_or_else(|_| panic!("image applies"));
    assert_eq!(applied, 2);
    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty(), "the image was staged beside the replica");
    assert!(seen
        .iter()
        .all(|(path, mode)| path.parent() == Some(directory.as_path()) && *mode == 0o600));
    drop(seen);
    // Every exit path removes it, including a rejected image.
    assert!(client
        .apply_sqlite_segment(
            &table,
            b"not a database",
            true,
            &scopes(),
            &[],
            2,
            7,
            "digest"
        )
        .is_err());
    let leftovers = std::fs::read_dir(&directory)
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".syncular-image-")
        })
        .count();
    assert_eq!(leftovers, 0);
    drop(client);
    std::fs::remove_dir_all(directory).unwrap();
}

// T16
#[test]
fn an_image_for_a_table_with_encrypted_columns_is_rejected() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"note","type":"bytes","nullable":true,
         "encrypted":true,"declaredType":"string"}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client =
        SyncClient::new("robust".into(), &schema, ClientLimits::default()).expect("client");
    let table = client.schema.table("tasks").unwrap().clone();
    let Err(SectionError::Abort(code, message)) =
        client.apply_sqlite_segment(&table, &image_bytes(), true, &scopes(), &[], 2, 7, "digest")
    else {
        panic!("an encrypted table refuses the image");
    };
    assert_eq!(code, "sync.invalid_request");
    assert!(message.contains("encrypted columns"), "{message}");
    assert_eq!(client.read_rows("tasks").unwrap().len(), 0);
}

// R7
#[cfg(unix)]
#[test]
fn an_in_memory_replica_stages_the_image_owner_only_in_the_system_temp_dir() {
    let mut client = client();
    let table = client.schema.table("tasks").unwrap().clone();
    let seen = watch_image_files(&mut client, std::env::temp_dir());
    let applied = client
        .apply_sqlite_segment(&table, &image_bytes(), true, &scopes(), &[], 2, 7, "digest")
        .unwrap_or_else(|_| panic!("image applies"));
    assert_eq!(applied, 2);
    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|(_, mode)| *mode == 0o600));
}

// R8
#[test]
fn subscribe_and_unsubscribe_raise_sync_needed() {
    let mut client = client();
    let unit = UnitScopes::from([("project_id".to_owned(), "p1".to_owned())]);
    let id = client.subscribe(unit.clone()).unwrap();
    assert!(client.sync_needed);
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));

    // Registering the same unit again changes nothing.
    client.sync_needed = false;
    client.subscribe(unit).unwrap();
    assert!(!client.sync_needed);
    assert!(client.sync_intent_queue.is_empty());

    client.unsubscribe(&id).unwrap();
    assert!(client.sync_needed);
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));

    // An unknown id is a no-op.
    client.sync_needed = false;
    client.unsubscribe(&id).unwrap();
    assert!(!client.sync_needed);
    assert!(client.sync_intent_queue.is_empty());
}

#[cfg(feature = "e2ee")]
fn encrypted_client() -> SyncClient {
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "patients",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "integer", "nullable": false },
                { "name": "encryption_key_id", "type": "string", "nullable": true },
                { "name": "note", "type": "bytes", "nullable": true,
                  "encrypted": true, "declaredType": "string" }
            ],
            "scopes": []
        }]
    });
    let mut client =
        SyncClient::new("encrypted".into(), &schema, ClientLimits::default()).expect("test client");
    client.create_synced_tables().unwrap();
    let mut config = crate::values::EncryptionConfig::default();
    config.keys.insert("k1".to_owned(), vec![0x2A; 32]);
    config
        .key_id_columns
        .insert("patients".to_owned(), "encryption_key_id".to_owned());
    client.set_encryption(config);
    client
}

// R9
#[cfg(feature = "e2ee")]
#[test]
fn a_failed_key_selector_read_is_an_error_and_an_absent_key_is_none() {
    let client = encrypted_client();
    let table = client.schema.table("patients").unwrap();
    assert!(client.stored_key_fallback(table, "5").unwrap().is_none());
    client
        .conn
        .execute(
            "INSERT INTO patients (id, encryption_key_id, note, _syncular_version) VALUES (5, 'k1', NULL, 1)",
            [],
        )
        .unwrap();
    assert!(client.stored_key_fallback(table, "5").unwrap().is_some());
    client.conn.execute_batch("DROP TABLE patients").unwrap();
    assert!(client.stored_key_fallback(table, "5").is_err());
}

// R10
#[cfg(feature = "e2ee")]
#[test]
fn a_commit_frame_decrypt_failure_keeps_its_identity() {
    let mut client = encrypted_client();
    let table = client.schema.table("patients").unwrap();
    let values = Map::from_iter([
        ("id".into(), json!(5)),
        ("encryption_key_id".into(), json!("k1")),
        ("note".into(), json!("secret")),
    ]);
    let payload = crate::values::encode_row_json(table, "5", &values, &client.encryption).unwrap();
    // The receiving client holds no key for the envelope.
    client.set_encryption(crate::values::EncryptionConfig::default());
    let change = ssp2::model::Change {
        table_index: 0,
        row_id: "5".into(),
        op: Op::Upsert,
        row_version: 1,
        scopes: Vec::new(),
        row: Some(payload),
    };
    let (code, _) = client
        .apply_commit_changes(&["patients".to_owned()], &[change])
        .expect_err("the envelope cannot be decrypted");
    assert_eq!(code, "client.decrypt_failed");
}

// R11
#[test]
fn acknowledged_row_lookups_by_table_and_id_use_an_index() {
    let client = client();
    let plan: String = client
        .conn
        .query_row(
            "EXPLAIN QUERY PLAN DELETE FROM _syncular_acked_rows WHERE tbl = 't' AND id = 'i' AND commit_seq <= 1",
            [],
            |row| row.get(3),
        )
        .unwrap();
    assert!(plan.contains("_syncular_acked_rows_row"), "{plan}");
}

// R11
#[test]
fn commit_frames_record_deliveries_only_for_rows_pinned_by_the_outbox() {
    let mut client = client();
    client.outbox.push(Arc::new(OutboxCommit {
        client_commit_id: "pending".into(),
        ops: vec![operation("tasks")],
    }));
    let table = client.schema.table("tasks").unwrap();
    let change = |id: &str| {
        let values = Map::from_iter([("id".into(), json!(id)), ("project_id".into(), json!("p1"))]);
        ssp2::model::Change {
            table_index: 0,
            row_id: id.into(),
            op: Op::Upsert,
            row_version: 1,
            scopes: Vec::new(),
            row: Some(
                crate::values::encode_row_json(table, id, &values, &client.encryption).unwrap(),
            ),
        }
    };
    let changes = vec![change("t1"), change("other")];
    client
        .apply_commit_frame(&["tasks".to_owned()], &changes, 9)
        .unwrap();
    let delivered: Vec<(String, i64)> = client
        .conn
        .prepare("SELECT id, commit_seq FROM _syncular_row_deliveries ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(delivered, vec![("t1".to_owned(), 9)]);
}
