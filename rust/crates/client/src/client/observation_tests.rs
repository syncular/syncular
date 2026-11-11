use super::*;
use crate::native_transport::HostTransport;
use crate::values::encode_row_json;
use crate::BlobUploadGrant;
use serde_json::json;

#[test]
fn authority_policy_refuses_encrypted_and_undeclared_columns_before_open() {
    let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
        {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "secret", "type": "bytes", "encrypted": true, "declaredType": "string", "nullable": true}
    ]}]});
    for name in [
        "secret",
        "missing",
        "*",
        "id FROM authority; DELETE FROM authority",
        "_syncular_version",
    ] {
        let limits = ClientLimits {
            authority_reads: vec![crate::api::AuthorityReadDeclaration {
                table: "authority".into(),
                columns: vec!["id".into(), "actor_id".into(), name.into()],
                scopes: [("actor_id".into(), vec!["a".into()])].into(),
            }],
            ..Default::default()
        };
        let error = SyncClient::new("authority".into(), &schema, limits)
            .err()
            .expect("forbidden policy");
        assert!(
            error.starts_with("client.authority_read_forbidden:"),
            "{error}"
        );
    }
}

#[test]
fn authority_snapshot_observes_one_file_transaction_during_concurrent_writes() {
    let path = std::env::temp_dir().join(format!(
        "syncular-authority-snapshot-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
        {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "revision", "type": "integer", "nullable": false}
    ]}]});
    let limits = ClientLimits {
        authority_reads: vec![crate::api::AuthorityReadDeclaration {
            table: "authority".into(),
            columns: vec!["id".into(), "actor_id".into(), "revision".into()],
            scopes: [("actor_id".into(), vec!["a".into()])].into(),
        }],
        ..Default::default()
    };
    let mut client =
        SyncClient::open_path("authority".into(), &schema, limits, path.to_str().unwrap()).unwrap();
    client.begin_security_preflight().unwrap();
    let update = |conn: &Connection, revision: i64| {
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO _syncular_base_authority VALUES('one','a',?1,1)",
            [revision],
        )
        .unwrap();
        conn.execute(
            "UPDATE _syncular_meta SET value=?1 WHERE key='localRevision'",
            [revision.to_string()],
        )
        .unwrap();
        conn.execute("INSERT OR REPLACE INTO _syncular_units(id,scopes,explicit,status,cursor,seeded,echo) VALUES('u','{\"actor_id\":\"a\"}',1,'active',?1,'[]','[]')", [revision]).unwrap();
        conn.execute_batch("COMMIT").unwrap();
    };
    update(&client.conn, 1);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writer_barrier = barrier.clone();
    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        let conn = Connection::open(writer_path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        writer_barrier.wait();
        for revision in 2..=100 {
            update(&conn, revision);
        }
    });
    barrier.wait();
    for _ in 0..100 {
        let snapshot = client.authority_snapshot().unwrap();
        let revision = snapshot["revision"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        assert_eq!(
            snapshot["tables"][0]["rows"][0]["values"]["revision"],
            revision
        );
        assert_eq!(snapshot["tables"][0]["persisted"][0]["cursor"], revision);
        assert_eq!(snapshot["complete"], true);
    }
    writer.join().unwrap();
    assert_eq!(client.authority_snapshot().unwrap()["revision"], "100");
    drop(client);
    let _ = std::fs::remove_file(path);
}

fn client() -> SyncClient {
    SyncClient::new(
        "retry-test".to_owned(),
        &json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        }),
        ClientLimits::default(),
    )
    .expect("test client")
}

/// A live unit with an empty echo, as after a bootstrap that joined; the
/// replica cursor is at least `0`.
fn live_unit(client: &SyncClient, scopes: &[(&str, &str)]) -> String {
    let scopes: UnitScopes = scopes
        .iter()
        .map(|(variable, value)| ((*variable).to_owned(), (*value).to_owned()))
        .collect();
    let id = ssp2::registration::unit_id(&scope_pairs(&scopes));
    save_unit(
        &client.conn,
        &UnitRecord {
            id: id.clone(),
            scopes,
            explicit: true,
            status: UnitStatus::Active,
            reason_code: None,
            cursor: None,
            bootstrap_state: None,
            seeded: Vec::new(),
            echo: Some(Vec::new()),
        },
    )
    .unwrap();
    if replica_cursor(&client.conn).unwrap() < 0 {
        client.set_meta(REPLICA_CURSOR_KEY, "0").unwrap();
    }
    id
}

/// One active live section around `commits` (§4.4).
fn live_section(through_seq: i64, commits: Vec<Frame>) -> Vec<Frame> {
    let mut frames = vec![Frame::LiveStart {
        status: LiveStatus::Active,
        reason_code: String::new(),
    }];
    frames.extend(commits);
    frames.push(Frame::LiveEnd {
        through_seq,
        echo_digest: None,
    });
    frames
}

fn unit_scopes(variable: &str, value: &str) -> UnitScopes {
    UnitScopes::from([(variable.to_owned(), value.to_owned())])
}

fn round_error(outcome: SyncOutcome) -> TransportError {
    match outcome {
        SyncOutcome::Failed {
            error_code,
            message,
            details,
            ..
        } => TransportError {
            code: error_code,
            message,
            details,
        },
        other => TransportError::new(
            "client.failed",
            format!("unexpected round outcome: {other:?}"),
        ),
    }
}

/// Upload every pinned blob through the split round API and stop before the
/// metadata request.
fn flush_blob_uploads(
    client: &mut SyncClient,
    transport: &mut dyn Transport,
) -> Result<(), TransportError> {
    let mut prepared = match client.prepare_sync_round(false) {
        Ok(prepared) => prepared,
        Err(outcome) => return Err(round_error(*outcome)),
    };
    loop {
        if prepared.uploads.is_empty() {
            client.cancel_sync_round();
            return Ok(());
        }
        let completed = crate::round::test_support::drive_round(prepared, transport);
        prepared = match client.apply_sync_round(completed) {
            crate::AppliedSyncRound::Continue(prepared) => prepared,
            crate::AppliedSyncRound::Complete { outcome, .. } => {
                return match outcome {
                    SyncOutcome::Ok(_) => Ok(()),
                    other => Err(round_error(other)),
                };
            }
        };
    }
}

#[test]
fn subscribe_many_registers_all_or_nothing() {
    let mut client = client();
    client
        .subscribe_many(vec![
            unit_scopes("project_id", "p1"),
            unit_scopes("project_id", "p2"),
        ])
        .unwrap();
    assert_eq!(client.units().unwrap().len(), 2);
    // The second unit names no declared variable: the whole call fails and
    // the first stays out.
    let error = client
        .subscribe_many(vec![
            unit_scopes("project_id", "p3"),
            unit_scopes("tenant_id", "t1"),
        ])
        .unwrap_err();
    assert!(error.starts_with("sync.invalid_subscription:"), "{error}");
    assert_eq!(client.units().unwrap().len(), 2);
    assert!(client.conn.is_autocommit());
}

#[cfg(feature = "e2ee")]
#[test]
fn an_unresolvable_key_id_becomes_a_durable_rejection_at_the_push_seam() {
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "secrets",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "encryption_key_id", "type": "string", "nullable": true },
                { "name": "note", "type": "bytes", "nullable": true,
                  "encrypted": true, "declaredType": "string" }
            ],
            "scopes": []
        }]
    });
    let mut client = SyncClient::new("encrypt-reject".into(), &schema, ClientLimits::default())
        .expect("test client");
    let mut config = crate::values::EncryptionConfig::default();
    config.keys.insert("k1".to_owned(), vec![0x2A; 32]);
    config
        .key_id_columns
        .insert("secrets".to_owned(), "encryption_key_id".to_owned());
    client.set_encryption(config);
    // The row exists, but its key selector is absent. The encrypted edit
    // authors locally and fails at the push seam.
    client
        .write_base_row(
            "secrets",
            &vec![Some(ColumnValue::String("ghost".into())), None, None],
            1,
        )
        .unwrap();
    client.rebuild_overlay().expect("rebuild overlay");
    let commit_id = client
        .patch(
            "secrets",
            "ghost",
            Map::from_iter([("note".to_owned(), json!("x"))]),
            None,
        )
        .expect("patch records without an author-time encrypt failure");
    assert_eq!(client.pending_commit_ids(), vec![commit_id.clone()]);
    // ...and the push seam raises a durable local rejection, not a throw.
    assert!(client.drop_unencodable_outbox(true, None).unwrap());
    assert!(client.pending_commit_ids().is_empty());
    let rejections = client.rejections();
    assert_eq!(rejections.len(), 1);
    assert_eq!(rejections[0].code, "client.encrypt_failed");
    assert_eq!(rejections[0].client_commit_id, commit_id);
    assert_eq!(
        client
            .commit_outcome(&commit_id)
            .unwrap()
            .map(|outcome| outcome.status),
        Some(CommitOutcomeStatus::Rejected)
    );
}

#[test]
fn patch_scope_read_preserves_sqlite_failure() {
    let mut client = client();
    client
        .conn
        .execute_batch(
            "DROP TABLE tasks;
        CREATE VIEW tasks AS SELECT 't1' AS id, abs(-9223372036854775808) AS project_id;",
        )
        .unwrap();
    let error = client
        .patch(
            "tasks",
            "t1",
            Map::from_iter([("project_id".to_owned(), json!("p1"))]),
            None,
        )
        .expect_err("the scope read must fail");
    assert_ne!(error.code, "sync.invalid_request");
    assert_eq!(error.code, "client.failed");
    assert!(error.details.as_ref().unwrap()["legacyCause"]
        .as_str()
        .unwrap()
        .contains("integer overflow"));
    assert!(client.pending_commit_ids().is_empty());
    assert!(client.conn.is_autocommit());
}

#[test]
fn patch_with_a_scope_column_matches_the_stored_local_row() {
    let mut client = client();
    client.create_synced_tables().unwrap();
    client
        .conn
        .execute(
            "INSERT INTO tasks (id, project_id, _syncular_version) VALUES ('t1', 'p1', 1)",
            [],
        )
        .unwrap();

    // §3.4 rule 5: a value equal to the stored local row is a no-op, so
    // the scope column leaves the presence set.
    client
        .patch(
            "tasks",
            "t1",
            Map::from_iter([
                ("project_id".to_owned(), json!("p1")),
                ("id".to_owned(), json!("t1")),
            ]),
            None,
        )
        .expect("an equal scope column is a no-op");
    let values = client.outbox[0].ops[0]
        .values
        .clone()
        .expect("the patch records values");
    assert_eq!(values.get("id"), Some(&json!("t1")));
    assert!(!values.contains_key("project_id"));

    // A differing value stays rejected.
    let differing = client.patch(
        "tasks",
        "t1",
        Map::from_iter([("project_id".to_owned(), json!("p2"))]),
        None,
    );
    let differing = differing.expect_err("a differing scope column is rejected");
    assert_eq!(differing.code, "sync.invalid_request");
    assert_eq!(differing.message, "the authoring request is invalid");
    assert!(
        differing
            .details
            .as_ref()
            .and_then(|details| details["legacyCause"].as_str())
            .is_some_and(|cause| cause.contains("patch cannot write scope column")),
        "{differing:?}"
    );

    // An absent local row leaves nothing to prove equality against, so
    // the patch fails closed.
    let absent = client.patch(
        "tasks",
        "ghost",
        Map::from_iter([("project_id".to_owned(), json!("p1"))]),
        None,
    );
    let absent = absent.expect_err("an absent local row is rejected");
    assert_eq!(absent.code, "sync.row_missing");
    assert!(absent.message.contains("requires a local row"));
    assert_eq!(client.pending_commit_ids().len(), 1);
}

#[test]
fn patch_scope_column_parity_for_the_primary_key_and_coerced_values() {
    let schema = json!({
        "version": 1,
        "tables": [
            {
                "name": "tenants",
                "primaryKey": "tenant_id",
                "columns": [
                    { "name": "tenant_id", "type": "string", "nullable": false },
                    { "name": "body", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "tenant:{tenant_id}" }]
            },
            {
                "name": "buckets",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "bucket", "type": "integer", "nullable": false },
                    { "name": "body", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "bucket:{bucket}" }]
            }
        ]
    });
    let mut client = SyncClient::new("scope-parity".into(), &schema, ClientLimits::default())
        .expect("test client");
    client.create_synced_tables().unwrap();

    // A primary key that is also a scope column still needs a local base.
    client
        .conn
        .execute(
            "INSERT INTO tenants (tenant_id, body, _syncular_version) VALUES ('t1', 'seed', 1)",
            [],
        )
        .unwrap();
    client
        .patch(
            "tenants",
            "t1",
            Map::from_iter([
                ("tenant_id".to_owned(), json!("t1")),
                ("body".to_owned(), json!("created")),
            ]),
            None,
        )
        .expect("the primary-key scope column is proven equal by construction");

    // A supplied integer equal to the stored integer scope value drops from the patch.
    client
        .conn
        .execute(
            "INSERT INTO buckets (id, bucket, body, _syncular_version) VALUES ('b1', 2, 'seed', 1)",
            [],
        )
        .unwrap();
    client
        .patch(
            "buckets",
            "b1",
            Map::from_iter([
                ("bucket".to_owned(), json!(2)),
                ("body".to_owned(), json!("coerced")),
            ]),
            None,
        )
        .expect("a supplied integer equal to the stored scope value is accepted");
    let values = client.outbox[1].ops[0]
        .values
        .clone()
        .expect("the patch records values");
    assert!(!values.contains_key("bucket"));

    // A differing value stays rejected.
    let differing = client.patch(
        "buckets",
        "b1",
        Map::from_iter([("bucket".to_owned(), json!(3))]),
        None,
    );
    let differing = differing.expect_err("a differing scope value is rejected");
    assert_eq!(differing.code, "sync.invalid_request");
    assert_eq!(differing.message, "the authoring request is invalid");
    assert!(
        differing
            .details
            .as_ref()
            .and_then(|details| details["legacyCause"].as_str())
            .is_some_and(|cause| cause.contains("patch cannot write scope column")),
        "{differing:?}"
    );
}

#[cfg(feature = "e2ee")]
#[test]
fn stored_key_fallback_resolves_an_integer_primary_key() {
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
        SyncClient::new("int-key".into(), &schema, ClientLimits::default()).expect("test client");
    client.create_synced_tables().unwrap();
    client
        .conn
        .execute(
            "INSERT INTO patients (id, encryption_key_id, note, _syncular_version)
             VALUES (5, 'k1', NULL, 1)",
            [],
        )
        .unwrap();
    let mut config = crate::values::EncryptionConfig::default();
    config.keys.insert("k1".to_owned(), vec![0x2A; 32]);
    config
        .key_id_columns
        .insert("patients".to_owned(), "encryption_key_id".to_owned());
    client.set_encryption(config);
    let table = client.schema.table("patients").unwrap();
    let fallback = client
        .stored_key_fallback(table, "5")
        .unwrap()
        .expect("the stored integer key resolves the fallback");
    assert_eq!(fallback[1], Some(ColumnValue::String("k1".to_owned())));
}

#[test]
fn patch_types_an_integer_primary_key_from_its_canonical_row_id() {
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "counters",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "integer", "nullable": false },
                { "name": "title", "type": "string", "nullable": false }
            ],
            "scopes": []
        }]
    });
    let mut client =
        SyncClient::new("int-patch".into(), &schema, ClientLimits::default()).expect("test client");
    client
        .write_base_row(
            "counters",
            &vec![
                Some(ColumnValue::Integer(42)),
                Some(ColumnValue::String("before".into())),
            ],
            1,
        )
        .unwrap();
    client.rebuild_overlay().expect("rebuild overlay");
    client
        .patch(
            "counters",
            "42",
            Map::from_iter([
                ("id".to_owned(), json!(42)),
                ("title".to_owned(), json!("after")),
            ]),
            None,
        )
        .expect("an integer key that renders as the rowId is not a change");
    let rows = client.query("SELECT id, title FROM counters", &[]).unwrap();
    assert_eq!(Value::from(rows), json!([{"id": 42, "title": "after"}]));
    for row_id in ["042", "+42", "42.0"] {
        let error = client
            .patch(
                "counters",
                row_id,
                Map::from_iter([("title".to_owned(), json!("x"))]),
                None,
            )
            .expect_err("a non-canonical integer rowId names no row");
        assert_eq!(error.code, "sync.row_missing", "{row_id}");
    }
}

#[test]
fn blob_staging_failures_preserve_durable_state_and_allow_retry() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    for state in ["absent", "cached", "pinned"] {
        let path = std::env::temp_dir().join(format!(
            "syncular-blob-stage-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut client = SyncClient::open_path(
            "stage-test".into(),
            &schema,
            Default::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        let bytes = b"atomic stage";
        if state != "absent" {
            client
                .upload_blob(bytes, Some("text/plain".into()), None)
                .unwrap();
            if state == "cached" {
                client
                    .conn
                    .execute("DELETE FROM _syncular_blob_uploads", [])
                    .unwrap();
            }
        }
        let bodies = client.query("SELECT * FROM _syncular_blobs", &[]).unwrap();
        client
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_stage_insert BEFORE INSERT ON _syncular_blobs
               BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END;
             CREATE TRIGGER fail_stage_update BEFORE UPDATE ON _syncular_blobs
               BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END;",
            )
            .unwrap();
        let error = client
            .upload_blob(bytes, Some("application/octet-stream".into()), None)
            .unwrap_err();
        assert!(error.contains("injected stage failure"), "{state}: {error}");
        assert!(client.conn.is_autocommit());
        let immediate = client.query("SELECT * FROM _syncular_blobs", &[]).unwrap();
        drop(client);
        let mut reopened = SyncClient::open_path(
            "stage-test".into(),
            &schema,
            Default::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        let durable = reopened
            .query("SELECT * FROM _syncular_blobs", &[])
            .unwrap();
        reopened
            .conn
            .execute_batch("DROP TRIGGER fail_stage_insert; DROP TRIGGER fail_stage_update")
            .unwrap();
        let retried = reopened.upload_blob(bytes, None, None).unwrap();
        assert_eq!(reopened.upload_blob(bytes, None, None).unwrap(), retried);
        assert_eq!(
            reopened
                .query("SELECT blob_id FROM _syncular_blob_uploads", &[])
                .unwrap(),
            vec![Map::from_iter([(
                "blob_id".into(),
                Value::from(blob_id_for(bytes)),
            )])]
        );
        drop(reopened);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(durable, bodies, "{state}: reopened body state");
        assert_eq!(immediate, bodies, "{state}: immediate body state");
    }
}

#[test]
fn blob_upload_failures_preserve_pins_and_original_commits_after_file_reopen() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    for fault in [
        "missing",
        "body-type",
        "length",
        "hash",
        "pin-metadata",
        "read",
        "pin-delete",
    ] {
        let path = std::env::temp_dir().join(format!(
            "syncular-blob-upload-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut client = SyncClient::open_path(
            "upload-test".into(),
            &schema,
            Default::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        let bytes = b"durable upload";
        let ref_value = client
            .upload_blob(bytes, Some("text/plain".into()), None)
            .unwrap();
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "attachments".into(),
                values: Map::from_iter([
                    ("id".into(), Value::from("pending")),
                    (
                        "file".into(),
                        Value::from(format!(
                            "{{\"blobId\":\"{}\",\"byteLength\":{}}}",
                            blob_id_for(bytes),
                            bytes.len()
                        )),
                    ),
                ]),
                base_version: None,
            }])
            .unwrap();
        client
            .conn
            .execute_batch("CREATE TABLE saved_bodies AS SELECT * FROM _syncular_blobs")
            .unwrap();
        client.conn.execute_batch(match fault {
            "missing" => "DELETE FROM _syncular_blobs",
            "body-type" => "UPDATE _syncular_blobs SET bytes = 'wrong type'",
            "length" => "UPDATE _syncular_blobs SET byte_length = byte_length + 1",
            "hash" => "UPDATE _syncular_blobs SET bytes = zeroblob(byte_length)",
            "pin-metadata" => "UPDATE _syncular_blob_uploads SET media_type = x'ff'",
            "read" => "ALTER TABLE _syncular_blobs RENAME TO unavailable_bodies",
            _ => "CREATE TRIGGER fail_pin_delete BEFORE DELETE ON _syncular_blob_uploads BEGIN SELECT RAISE(ABORT, 'injected pin deletion failure'); END",
        }).unwrap();
        let state = if fault == "read" {
            Vec::new()
        } else {
            client.query("SELECT * FROM _syncular_blobs", &[]).unwrap()
        };
        client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
        let mut transport = CountingRealtimeTransport::default();
        let error = flush_blob_uploads(&mut client, &mut transport).unwrap_err();
        assert_eq!(
            error.code,
            if matches!(fault, "read" | "pin-delete") {
                "client.failed"
            } else {
                "sync.local_corrupt"
            },
            "{fault}"
        );
        assert_eq!(
            transport.blob_uploads.len(),
            usize::from(fault == "pin-delete"),
            "{fault}: corrupt bytes must never be uploaded"
        );
        assert_eq!(client.pending_commit_ids(), std::slice::from_ref(&commit));
        if fault != "read" {
            assert_eq!(
                client.query("SELECT * FROM _syncular_blobs", &[]).unwrap(),
                state
            );
        } else {
            client
                .conn
                .execute_batch("ALTER TABLE unavailable_bodies RENAME TO _syncular_blobs")
                .unwrap();
        }
        drop(client);
        let mut reopened = SyncClient::open_path(
            "upload-test".into(),
            &schema,
            Default::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(reopened.pending_commit_ids(), std::slice::from_ref(&commit));
        if fault != "read" {
            assert_eq!(
                reopened
                    .query("SELECT * FROM _syncular_blobs", &[])
                    .unwrap(),
                state
            );
        }
        if fault == "pin-delete" {
            reopened
                .conn
                .execute_batch("DROP TRIGGER fail_pin_delete")
                .unwrap();
        }
        if fault == "pin-metadata" {
            reopened
                .conn
                .execute(
                    "UPDATE _syncular_blob_uploads SET media_type = 'text/plain'",
                    [],
                )
                .unwrap();
        }
        reopened
            .conn
            .execute_batch(
                "DELETE FROM _syncular_blobs;
                 INSERT INTO _syncular_blobs SELECT * FROM saved_bodies",
            )
            .unwrap();
        transport.blob_uploads.clear();
        flush_blob_uploads(&mut reopened, &mut transport).unwrap();
        assert_eq!(
            transport.blob_uploads,
            [(blob_id_for(bytes), bytes.to_vec())]
        );
        assert_eq!(
            reopened
                .query("SELECT blob_id FROM _syncular_blob_uploads", &[])
                .unwrap(),
            Vec::<Map<String, Value>>::new()
        );
        assert_eq!(reopened.pending_commit_ids(), [commit]);
        assert_eq!(
            reopened
                .get_cached_blob_bytes(ref_value["blobId"].as_str().unwrap())
                .unwrap()
                .unwrap()
                .bytes,
            bytes
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
}

/// §1.4 rule 4: `units` live units, each with `commits` COMMIT frames of
/// `rows` rows in one live section. Returns the client with its units
/// registered and the response.
fn coalesced_fixture(units: usize, commits: usize, rows: usize) -> (SyncClient, Message) {
    let client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut frames = vec![Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "epoch-1".into(),
        reset_required: false,
    }];
    let mut seq = 0;
    let mut live = Vec::new();
    for unit in 0..units {
        let project = format!("p{unit}");
        live_unit(&client, &[("project_id", &project)]);
        for _ in 0..commits {
            seq += 1;
            let changes = (0..rows)
                .map(|row| {
                    let id = format!("{project}-{seq}-{row}");
                    let values = Map::from_iter([
                        ("id".into(), Value::from(id.clone())),
                        ("project_id".into(), Value::from(project.clone())),
                    ]);
                    ssp2::model::Change {
                        table_index: 0,
                        row_id: id.clone(),
                        op: Op::Upsert,
                        row_version: seq,
                        scopes: vec![("project_id".into(), project.clone())],
                        row: Some(
                            encode_row_json(
                                client.schema.table("tasks").unwrap(),
                                &id,
                                &values,
                                &client.encryption,
                            )
                            .unwrap(),
                        ),
                    }
                })
                .collect();
            live.push(Frame::Commit {
                commit_seq: seq,
                actor_id: "writer".into(),
                created_at_ms: 1,
                tables: vec!["tasks".into()],
                changes,
            });
        }
    }
    frames.extend(live_section(seq, live));
    let mut client = client;
    client.drain_change_batches();
    (
        client,
        Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames,
        },
    )
}

fn count_commits(client: &mut SyncClient) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
    let commits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = commits.clone();
    client
        .conn
        .commit_hook(Some(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            false
        }))
        .expect("commit hook");
    commits
}

#[test]
fn a_response_of_many_small_sections_commits_once() {
    for realtime in [false, true] {
        let (mut client, response) = coalesced_fixture(70, 1, 1);
        client.realtime_state = RealtimeState::Connected;
        client.realtime_reason_code = None;
        let mut transport = CountingRealtimeTransport::default();
        let (_, meta) = client.build_request(false).unwrap();
        let commits = count_commits(&mut client);
        if realtime {
            client.on_realtime_binary(&mut transport, &encode_message(&response));
        } else {
            assert!(matches!(
                client.process_response(&mut transport, response, &meta),
                SyncOutcome::Ok(_)
            ));
        }
        assert_eq!(
            commits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "{realtime}"
        );
        assert!(client.conn.is_autocommit());
        assert_eq!(replica_cursor(&client.conn).unwrap(), 70);
        // Every frame keeps its own revision, published in order.
        let revisions = client
            .drain_change_batches()
            .into_iter()
            .filter(|batch| !batch.tables.is_empty())
            .map(|batch| batch.revision)
            .collect::<Vec<_>>();
        assert_eq!(
            revisions,
            (1..=70).map(|r: u64| r.to_string()).collect::<Vec<_>>()
        );
        assert_eq!(client.query("SELECT id FROM tasks", &[]).unwrap().len(), 70);
        // The ack follows the COMMIT.
        assert_eq!(
            transport
                .messages
                .iter()
                .filter(|m| m.contains("\"ack\""))
                .count(),
            1,
            "{realtime}"
        );
    }
}

#[test]
fn a_response_past_the_row_bound_commits_per_bound() {
    // 3 frames of 600 rows: no two fit one 1,024-row transaction.
    let (mut client, response) = coalesced_fixture(1, 3, 600);
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    let (_, meta) = client.build_request(false).unwrap();
    let commits = count_commits(&mut client);
    assert!(matches!(
        client.process_response(&mut transport, response, &meta),
        SyncOutcome::Ok(_)
    ));
    assert_eq!(commits.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(
        client.query("SELECT id FROM tasks", &[]).unwrap().len(),
        1800
    );
    assert_eq!(replica_cursor(&client.conn).unwrap(), 3);
}

#[test]
fn a_failed_coalesced_commit_restores_memory_and_publishes_nothing() {
    // Two sections of two frames of 600 rows: the bound commits the first
    // frame alone, so the deferred violation it carries fails that
    // mid-response COMMIT, and every later frame of the response fails.
    let (mut client, response) = coalesced_fixture(2, 2, 600);
    client
        .conn
        .execute_batch(
            "PRAGMA foreign_keys = ON; CREATE TABLE fail_parent(id INTEGER PRIMARY KEY); CREATE TABLE fail_child(id INTEGER REFERENCES fail_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON _syncular_base_tasks WHEN NEW.id = 'p0-1-0' BEGIN INSERT INTO fail_child VALUES(1); END",
        )
        .unwrap();
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    let (_, meta) = client.build_request(false).unwrap();
    let revision = client.local_revision().unwrap();
    let outcome = client.process_response(&mut transport, response.clone(), &meta);
    assert!(
        matches!(&outcome, SyncOutcome::Failed { error_code, .. } if error_code == "storage.failed"),
        "{outcome:?}"
    );
    assert!(client.conn.is_autocommit());
    assert!(client.coalesced.is_none() && client.coalesced_failure.is_none());
    assert_eq!(client.local_revision().unwrap(), revision);
    assert!(client
        .drain_change_batches()
        .iter()
        .all(|batch| batch.tables.is_empty()));
    assert!(client
        .query("SELECT id FROM tasks", &[])
        .unwrap()
        .is_empty());
    assert_eq!(replica_cursor(&client.conn).unwrap(), 0);
    // The next response applies in full.
    client
        .conn
        .execute_batch("DROP TRIGGER fail_commit")
        .unwrap();
    let (_, meta) = client.build_request(false).unwrap();
    assert!(matches!(
        client.process_response(&mut transport, response, &meta),
        SyncOutcome::Ok(_)
    ));
    assert_eq!(
        client.query("SELECT id FROM tasks", &[]).unwrap().len(),
        2400
    );
}

#[test]
fn incoming_frame_transactions_preserve_prefix_cursor_and_revision_after_reopen() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    for realtime in [false, true] {
        for fault in [
            "none",
            "row",
            "revision",
            "commit",
            "cursor",
            "error",
            "missing-end",
        ] {
            if realtime && fault == "missing-end" {
                continue;
            }
            let path = std::env::temp_dir()
                .join(format!("syncular-frame-{}.sqlite", uuid::Uuid::new_v4()));
            let mut client = SyncClient::open_path(
                "frame-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
            live_unit(&client, &[("project_id", "p1")]);
            client.realtime_state = RealtimeState::Connected;
            client.realtime_reason_code = None;
            client.drain_change_batches();
            let mut transport = CountingRealtimeTransport::default();
            let (_, meta) = client.build_request(false).unwrap();
            let mut response = Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![
                    Frame::RespHeader {
                        required_schema_version: None,
                        latest_schema_version: None,
                        log_epoch: "epoch-1".into(),
                        reset_required: false,
                    },
                    Frame::LiveStart {
                        status: LiveStatus::Active,
                        reason_code: String::new(),
                    },
                ],
            };
            for (index, id) in ["first", "second"].iter().enumerate() {
                let values = Map::from_iter([
                    ("id".into(), Value::from(*id)),
                    ("project_id".into(), Value::from("p1")),
                ]);
                response.frames.push(Frame::Commit {
                    commit_seq: index as i64 + 1,
                    actor_id: "writer".into(),
                    created_at_ms: 1,
                    tables: vec!["tasks".into()],
                    changes: vec![ssp2::model::Change {
                        table_index: 0,
                        row_id: (*id).into(),
                        op: Op::Upsert,
                        row_version: index as i64 + 1,
                        scopes: vec![("project_id".into(), "p1".into())],
                        row: Some(
                            encode_row_json(
                                client.schema.table("tasks").unwrap(),
                                id,
                                &values,
                                &client.encryption,
                            )
                            .unwrap(),
                        ),
                    }],
                });
            }
            response.frames.push(Frame::LiveEnd {
                through_seq: 2,
                echo_digest: None,
            });
            let valid = response.clone();
            match fault {
                "row" => {
                    let Frame::Commit {changes, ..} = &mut response.frames[3] else {panic!("second frame")};
                    let mut malformed = changes[0].clone(); malformed.row_id = "malformed".into(); malformed.row = Some(vec![]); changes.push(malformed);
                },
                "revision" => client.conn.execute_batch("CREATE TRIGGER fail_frame BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND NEW.value = '2' AND EXISTS (SELECT 1 FROM _syncular_base_tasks WHERE id = 'second') BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END").unwrap(),
                "commit" => client.conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE frame_parent(id INTEGER PRIMARY KEY); CREATE TABLE frame_child(id INTEGER REFERENCES frame_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_frame AFTER INSERT ON _syncular_base_tasks WHEN NEW.id = 'second' BEGIN INSERT INTO frame_child VALUES(1); END").unwrap(),
                "cursor" => client.conn.execute_batch("CREATE TRIGGER fail_frame BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'replicaCursor' AND NEW.value = '2' BEGIN SELECT RAISE(FAIL, 'injected cursor failure'); END").unwrap(),
                "error" => {response.frames.truncate(3);response.frames.push(Frame::Error {code:"sync.invalid_request".into(),message:"later error".into(),category:"protocol".into(),retryable:false,recommended_action:"retry".into(),details:None});},
                "missing-end" => {response.frames.truncate(3);},
                _ => {}
            }
            if realtime {
                client.on_realtime_binary(&mut transport, &encode_message(&response));
            } else {
                // §7.1: a response without LIVE_END completes and leaves
                // sync-needed raised.
                assert_eq!(
                    matches!(
                        client.process_response(&mut transport, response, &meta),
                        SyncOutcome::Ok(_)
                    ),
                    matches!(fault, "none" | "missing-end"),
                    "{fault}"
                );
            }
            assert!(
                client.conn.is_autocommit(),
                "no open transaction after {realtime}/{fault}"
            );
            // §1.4 rule 4: the deferred foreign key of the "commit" fault
            // fails the response's coalesced COMMIT, which rolls back both
            // frames; the other faults roll back only the failing frame.
            let count = match fault {
                "none" | "cursor" => 2,
                "commit" => 0,
                _ => 1,
            };
            // A dropped delta and a pull without LIVE_END raise sync-needed,
            // which publishes one status revision (§7.1, §8.2).
            let expected_revision =
                count + u64::from((realtime && fault != "none") || fault == "missing-end");
            assert_eq!(
                client.local_revision().unwrap(),
                expected_revision,
                "{realtime}/{fault}"
            );
            let batches = client.drain_change_batches();
            assert_eq!(
                batches.len(),
                expected_revision as usize,
                "{realtime}/{fault}"
            );
            let row_batches: Vec<_> = batches
                .iter()
                .filter(|batch| !batch.tables.is_empty())
                .collect();
            assert_eq!(row_batches.len(), count as usize);
            assert_eq!(
                row_batches
                    .iter()
                    .map(|b| b.revision.clone())
                    .collect::<Vec<_>>(),
                (1..=count).map(|r| r.to_string()).collect::<Vec<_>>()
            );
            for table in ["tasks", "_syncular_base_tasks"] {
                assert_eq!(
                    client
                        .conn
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                            .get::<_, u64>(0))
                        .unwrap(),
                    count,
                    "{realtime}/{fault}/{table}"
                );
            }
            assert_eq!(
                replica_cursor(&client.conn).unwrap(),
                if fault == "none" { 2 } else { 0 }
            );
            assert_eq!(
                transport
                    .messages
                    .iter()
                    .filter(|m| m.contains("\"ack\""))
                    .count(),
                // §8.2: a completed pull acks the replica cursor.
                usize::from(matches!(fault, "none" | "missing-end"))
            );
            if matches!(fault, "revision" | "commit" | "cursor") {
                client
                    .conn
                    .execute_batch("DROP TRIGGER fail_frame")
                    .unwrap();
            }
            drop(client);
            let mut reopened = SyncClient::open_path(
                "frame-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            assert_eq!(reopened.local_revision().unwrap(), expected_revision);
            assert_eq!(
                reopened
                    .query("SELECT id FROM tasks ORDER BY id", &[])
                    .unwrap()
                    .len(),
                count as usize
            );
            assert_eq!(
                replica_cursor(&reopened.conn).unwrap(),
                if fault == "none" { 2 } else { 0 }
            );
            let (_, meta) = reopened.build_request(false).unwrap();
            assert!(matches!(
                reopened.process_response(&mut transport, valid, &meta),
                SyncOutcome::Ok(_)
            ));
            assert_eq!(
                reopened
                    .query("SELECT id FROM tasks ORDER BY id", &[])
                    .unwrap()
                    .len(),
                2
            );
            assert_eq!(replica_cursor(&reopened.conn).unwrap(), 2);
            drop(reopened);
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[test]
fn failed_subscription_control_persistence_rolls_back_rows_outbox_and_memory() {
    for status in [SubStatus::Reset, SubStatus::Revoked] {
        for fault in ["subscription", "revision"] {
            let mut client = client();
            let id = live_unit(&client, &[("project_id", "p1")]);
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), Value::from("pending")),
                        ("project_id".into(), Value::from("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let ids = client.pending_commit_ids();
            let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
            let revision = client.local_revision().unwrap();
            client.drain_change_batches();
            let (_, meta) = client.build_request(false).unwrap();
            client.conn.execute_batch(if fault == "subscription" {
                "CREATE TRIGGER fail_control BEFORE INSERT ON _syncular_units BEGIN SELECT RAISE(FAIL, 'injected unit failure'); END"
            } else {
                "CREATE TRIGGER fail_control BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END"
            }).unwrap();
            let mut transport = CountingRealtimeTransport::default();
            let mut report = SyncReport::default();
            // Reset changes window completeness and therefore needs a revision.
            if status == SubStatus::Reset {
                client
                    .conn
                    .execute(
                        "INSERT INTO _syncular_windows(base,unit,sub_id) VALUES ('base','p1',?1)",
                        [&id],
                    )
                    .unwrap();
            }
            let result = client.process_section(
                &mut transport,
                &SectionStart {
                    id: id.clone(),
                    status,
                    reason_code: "sync.scope_revoked".into(),
                    bootstrap: false,
                    fenced: Vec::new(),
                },
                vec![],
                Some((42, None)),
                &meta,
                &mut report,
            );
            assert!(result.is_err(), "{status:?}/{fault}");
            assert!(client.conn.is_autocommit());
            let unit = client.unit(&id).unwrap().unwrap();
            assert_eq!((unit.cursor, unit.status), (None, UnitStatus::Active));
            assert_eq!(client.pending_commit_ids(), ids);
            assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
            assert!(client.rejections.is_empty());
            assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
            assert_eq!(client.local_revision().unwrap(), revision);
            assert!(client.drain_change_batches().is_empty());
            assert!(report.revoked.is_empty() && report.resets.is_empty());
        }
    }
}

#[test]
fn rows_segment_blocks_commit_independently_and_clear_with_the_first_block() {
    let mut client = client();
    let table = client.schema.table("tasks").unwrap().clone();
    let effective = vec![("project_id".to_owned(), vec!["p1".to_owned()])];
    client.conn.execute_batch("INSERT INTO _syncular_base_tasks VALUES ('stale','p1',1); INSERT INTO tasks VALUES ('stale','p1',1);
        CREATE TRIGGER fail_block BEFORE INSERT ON _syncular_base_tasks WHEN NEW.id = 'bad' BEGIN SELECT RAISE(FAIL,'injected later block failure'); END").unwrap();
    let row = |id: &str| ssp2::segment::SegmentRow {
        server_version: 1,
        values: vec![
            Some(ColumnValue::String(id.into())),
            Some(ColumnValue::String("p1".into())),
        ],
    };
    let segment = RowsSegment {
        table: "tasks".into(),
        schema_version: 1,
        columns: client.schema.table("tasks").unwrap().wire_columns.clone(),
        blocks: vec![vec![row("first")], vec![row("second"), row("bad")]],
    };
    assert!(client
        .apply_segment(&table, &segment, true, &effective, &[])
        .is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(
        client
            .query("SELECT id FROM tasks ORDER BY id", &[])
            .unwrap(),
        vec![Map::from_iter([("id".into(), Value::from("first"))])]
    );
    assert_eq!(client.local_revision().unwrap(), 1);
    assert_eq!(client.drain_change_batches().len(), 1);
    client
        .conn
        .execute_batch("DROP TRIGGER fail_block")
        .unwrap();
    assert!(matches!(
        client.apply_segment(&table, &segment, true, &effective, &[]),
        Ok(3)
    ));
    assert_eq!(client.local_revision().unwrap(), 3);
    assert_eq!(client.drain_change_batches().len(), 2);
}

/// Serves one response and records the segment batch it causes. A single
/// `download_segment` call means the core fell back to per-descriptor
/// fetches.
struct SegmentBatchTransport {
    response: Message,
    bodies: BTreeMap<String, Vec<u8>>,
    batches: Vec<Vec<String>>,
    single_fetches: usize,
}

impl Transport for SegmentBatchTransport {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        Ok(encode_message(&self.response))
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        self.single_fetches += 1;
        Err(TransportError::new(
            "sync.transport_failed",
            "per-descriptor fetch",
        ))
    }

    fn download_segments(
        &mut self,
        fetches: &[crate::SegmentFetch],
        on_progress: &mut (dyn FnMut(usize, u64) + Send),
    ) -> Vec<Result<Vec<u8>, TransportError>> {
        self.batches.push(
            fetches
                .iter()
                .map(|fetch| match fetch {
                    crate::SegmentFetch::Direct(request) => request.segment_id.clone(),
                    crate::SegmentFetch::Url { url, .. } => url.clone(),
                })
                .collect(),
        );
        fetches
            .iter()
            .enumerate()
            .map(|(index, fetch)| {
                let crate::SegmentFetch::Direct(request) = fetch else {
                    panic!("the descriptors are direct-endpoint requests")
                };
                let bytes = self.bodies[&request.segment_id].clone();
                on_progress(index, bytes.len() as u64);
                Ok(bytes)
            })
            .collect()
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[test]
fn a_response_fetches_all_its_segment_pages_in_one_ordered_batch() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let id = client
        .subscribe(UnitScopes::from([("project_id".to_owned(), "p1".into())]))
        .unwrap();
    client.drain_change_batches();
    let columns = client.schema.table("tasks").unwrap().wire_columns.clone();

    // Four pages, one row each. Applying a page under another page's
    // descriptor fails §5.1 content-address verification, so a green round
    // proves the results kept the wire order.
    let pages = ["one", "two", "three", "four"].map(|id| {
        let bytes = ssp2::segment::encode_rows_segment(&RowsSegment {
            table: "tasks".into(),
            schema_version: 1,
            columns: columns.clone(),
            blocks: vec![vec![ssp2::segment::SegmentRow {
                server_version: 1,
                values: vec![
                    Some(ColumnValue::String(id.into())),
                    Some(ColumnValue::String("p1".into())),
                ],
            }]],
        });
        (
            format!("sha256:{}", bytes_to_hex(&Sha256::digest(&bytes))),
            bytes,
        )
    });

    let mut frames = vec![
        Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: "epoch-1".into(),
            reset_required: false,
        },
        Frame::SubStart {
            id: id.clone(),
            status: SubStatus::Active,
            reason_code: String::new(),
            bootstrap: true,
            fenced: Vec::new(),
        },
    ];
    for (segment_id, bytes) in &pages {
        frames.push(Frame::SegmentRef {
            segment_id: segment_id.clone(),
            media_type: MediaType::Rows,
            table: "tasks".into(),
            byte_length: bytes.len() as i64,
            row_count: 1,
            as_of_commit_seq: 1,
            scope_digest: "digest".into(),
            row_cursor: None,
            next_row_cursor: None,
            url: None,
            url_expires_at_ms: None,
        });
    }
    frames.push(Frame::SubEnd {
        next_cursor: 1,
        bootstrap_state: None,
    });
    frames.extend(live_section(1, Vec::new()));
    let mut transport = SegmentBatchTransport {
        response: Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames,
        },
        bodies: pages
            .iter()
            .map(|(segment_id, bytes)| (segment_id.clone(), bytes.clone()))
            .collect(),
        batches: Vec::new(),
        single_fetches: 0,
    };

    let outcome = client.sync(&mut transport);
    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(
        transport.batches,
        vec![pages
            .iter()
            .map(|(segment_id, _)| segment_id.clone())
            .collect::<Vec<_>>()],
        "one batch per response, in wire order"
    );
    assert_eq!(
        transport.single_fetches, 0,
        "the batch seam replaces the per-descriptor calls"
    );
    assert_eq!(
        client
            .query("SELECT id FROM tasks ORDER BY id", &[])
            .unwrap(),
        ["four", "one", "three", "two"]
            .map(|id| Map::from_iter([("id".to_owned(), Value::from(id))]))
            .to_vec()
    );
    assert_eq!(client.unit(&id).unwrap().unwrap().cursor, None);
    assert_eq!(replica_cursor(&client.conn).unwrap(), 1);
}

#[test]
fn diagnostic_storage_reads_fresh_aggregates_after_writes_rollback_and_schema_changes() {
    assert_eq!(
        client().diagnostics_storage().blob_cache_bytes_approx,
        Some(0)
    );
    let client = SyncClient::new(
        "diagnostic-storage".to_owned(),
        &json!({
            "version": 1, "tables": [{"name": "attachments", "primaryKey": "id",
                "columns": [{"name": "id", "type": "string", "nullable": false},
                    {"name": "body", "type": "blob_ref", "nullable": false}], "scopes": []}]
        }),
        ClientLimits {
            blob_cache_max_bytes: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    let empty = client.diagnostics_storage();
    assert_eq!(empty.status, "healthy");
    assert_eq!(empty.pending_outbox_bytes_approx, Some(0));
    assert_eq!(empty.retained_outcome_entries, Some(0));
    assert_eq!(empty.retained_outcome_bytes_approx, Some(0));
    assert_eq!(empty.blob_cache_bytes_approx, Some(0));
    client.conn.execute_batch("INSERT INTO _syncular_outbox(commit_id, ops_json) VALUES ('one', '[]');
        INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results_json,operations_json)
            VALUES ('one','applied',0,'[]',NULL),('two','rejected',0,'[]','[]');
        INSERT INTO _syncular_blobs(blob_id,bytes,byte_length,media_type,created_at_ms)
            VALUES ('body',zeroblob(8),8,NULL,0);").unwrap();
    let written = client.diagnostics_storage();
    assert_eq!(written.status, "pressure");
    assert_eq!(written.pending_outbox_bytes_approx, Some(2));
    assert_eq!(written.retained_outcome_entries, Some(2));
    assert_eq!(written.retained_outcome_bytes_approx, Some(6));
    assert_eq!(written.blob_cache_bytes_approx, Some(8));
    assert_eq!(
        written.pressure_reason_code.as_deref(),
        Some("client.blob_cache_over_limit")
    );
    client
        .conn
        .execute_batch(
            "BEGIN; UPDATE _syncular_outbox SET ops_json = '[1,2]';
        DELETE FROM _syncular_commit_outcomes; DELETE FROM _syncular_blobs;",
        )
        .unwrap();
    let staged = client.diagnostics_storage();
    assert_eq!(staged.pending_outbox_bytes_approx, Some(5));
    assert_eq!(staged.retained_outcome_entries, Some(0));
    assert_eq!(staged.blob_cache_bytes_approx, Some(0));
    assert_eq!(staged.status, "healthy");
    client.conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(client.diagnostics_storage(), written);
    client
        .conn
        .execute_batch(
            "ALTER TABLE _syncular_commit_outcomes RENAME COLUMN results_json TO hidden_results",
        )
        .unwrap();
    let unreadable = client.diagnostics_storage();
    assert_eq!(unreadable.status, "unreadable");
    assert!(unreadable.database_bytes_approx.is_none());
    assert!(unreadable.pending_outbox_bytes_approx.is_none());
    assert!(unreadable.retained_outcome_entries.is_none());
    assert!(unreadable.retained_outcome_bytes_approx.is_none());
    assert!(unreadable.blob_cache_bytes_approx.is_none());
    client
        .conn
        .execute_batch(
            "ALTER TABLE _syncular_commit_outcomes RENAME COLUMN hidden_results TO results_json",
        )
        .unwrap();
    let restored = client.diagnostics_storage();
    assert_eq!(restored.status, written.status);
    assert_eq!(
        restored.retained_outcome_bytes_approx,
        written.retained_outcome_bytes_approx
    );
    client.conn.set_prepared_statement_cache_capacity(0);
    assert_eq!(client.diagnostics_storage(), restored);
}

/// Answers every round with one server `ERROR` frame (§1.6).
struct ServerErrorTransport {
    code: &'static str,
    retryable: bool,
}

impl Transport for ServerErrorTransport {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        Ok(encode_message(&Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: "epoch-1".to_owned(),
                    reset_required: false,
                },
                Frame::Error {
                    code: self.code.to_owned(),
                    message: "server error".to_owned(),
                    category: "internal".to_owned(),
                    retryable: self.retryable,
                    recommended_action: "retryLater".to_owned(),
                    details: None,
                },
            ],
        }))
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[test]
fn a_retryable_in_band_failure_keeps_the_socket_connected_and_still_asks_for_a_retry() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = ServerErrorTransport {
        code: "sync.schema_not_ready",
        retryable: true,
    };
    client.connect_realtime(&mut transport).expect("connect");
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.schema_not_ready"
    ));
    assert_eq!(
        client.realtime_state(),
        RealtimeState::Connected,
        "the socket delivered the answer, so it is not lost"
    );
    assert!(
        matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ),
        "the retry deadline is a sync round and no reconnect satisfies it"
    );
    assert_eq!(
        client.progress().snapshot().unwrap().retry_delay_ms,
        Some(250)
    );
}

#[test]
fn retryable_server_error_schedules_a_background_retry() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = ServerErrorTransport {
        code: "sync.internal_error",
        retryable: true,
    };
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"
    ));
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
    assert_eq!(
        client.progress().snapshot().unwrap().retry_delay_ms,
        Some(250)
    );
    let mut transport = ServerErrorTransport {
        code: "sync.invalid_request",
        retryable: false,
    };
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.invalid_request"
    ));
    assert!(client.drain_sync_intents().is_empty());
    let progress = client.progress().snapshot().unwrap();
    assert_eq!(progress.state, ProgressState::Failed);
    assert_eq!(progress.retry_delay_ms, None);
}

#[test]
fn sync_until_idle_reports_budget_exhaustion_or_failure() {
    // §7.8: the exhausted outcome is a partial success, not a failure,
    // and serializes with an explicit flag.
    let exhausted = SyncOutcome::BudgetExhausted(SyncReport::default()).to_json();
    assert_eq!(exhausted["ok"], json!(true));
    assert_eq!(exhausted["budgetExhausted"], json!(true));
    assert!(exhausted["report"].is_object());

    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    // Zero explicit budget is a caller error, not an exhaustion.
    let mut idle_transport = HostTransport::new_from_config(&json!({})).unwrap();
    let zero = client.sync_until_idle(&mut idle_transport, Some(0));
    assert!(
        matches!(zero, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.invalid_request"),
        "{zero:?}"
    );
    // A real server failure stays a failure across the budget loop.
    let mut erroring = ServerErrorTransport {
        code: "sync.internal_error",
        retryable: false,
    };
    let failed = client.sync_until_idle(&mut erroring, Some(3));
    assert!(
        matches!(failed, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"),
        "{failed:?}"
    );
}

/// A transport that fails every round with one `causeKind`.
struct CauseTransport(&'static str);

impl Transport for CauseTransport {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let mut error = TransportError::new("transport.failed", "no route");
        error.details = Some(serde_json::json!({ "causeKind": self.0 }));
        Err(error)
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[test]
fn an_unreachable_transport_schedules_no_retry() {
    // §1.8: `connect` (native) and `network` (browser fetch) describe a
    // refused or unreachable endpoint; neither earns another backoff.
    for cause in ["connect", "network"] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        let mut transport = CauseTransport(cause);
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { ref error_code, .. } if error_code == "transport.failed"
        ));
        assert!(
            client.drain_sync_intents().is_empty(),
            "{cause} scheduled a retry"
        );
        // The round's work is still owed: the host's connectivity resume
        // runs it.
        assert!(client.sync_needed(), "{cause} left sync-needed lowered");
    }

    // Every other retryable transport cause keeps the background retry.
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = CauseTransport("timeout");
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "transport.failed"
    ));
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
    assert!(!client.sync_needed());
}

#[test]
fn a_subscription_holding_a_resume_token_raises_sync_needed() {
    // §4.7: the bootstrap continues on the next round, also when the
    // drive that started it ends early.
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let id = client.subscribe(unit_scopes("project_id", "p1")).unwrap();
    let mut frames = vec![
        Frame::SubStart {
            id: id.clone(),
            status: SubStatus::Active,
            reason_code: String::new(),
            bootstrap: true,
            fenced: Vec::new(),
        },
        Frame::SubEnd {
            next_cursor: 0,
            bootstrap_state: Some(RawJson(r#"{"page":1}"#.into())),
        },
    ];
    frames.extend(live_section(0, Vec::new()));
    let mut transport = failure_transport([Ok(completed_response(frames))]);

    let outcome = client.sync(&mut transport);

    let SyncOutcome::Ok(report) = outcome else {
        panic!("the paged round succeeds: {outcome:?}")
    };
    assert_eq!(report.bootstrapping, vec![id]);
    assert!(client.sync_needed());
}

#[test]
fn sync_until_idle_reports_its_total_deadline() {
    assert_eq!(SyncClient::SYNC_IDLE_TIMEOUT_MS, 60_000);
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();

    // A zero deadline is a caller error, like a zero round budget.
    let invalid = client.sync_until_idle_with_deadline(&mut transport, None, Some(0));
    assert!(
        matches!(invalid, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.invalid_request"),
        "{invalid:?}"
    );

    // The expired deadline stops before the first round and reports how
    // many rounds ran.
    let now = client.clock_now_ms();
    let outcome = client.sync_until_idle_bounded(&mut transport, None, now, Some(now));
    let SyncOutcome::Failed {
        error_code,
        details,
        recommended_action,
        ..
    } = outcome
    else {
        panic!("expected the idle deadline, got {outcome:?}");
    };
    assert_eq!(error_code, "sync.idle_timeout");
    assert_eq!(recommended_action.as_deref(), Some("retryLater"));
    let details = details.expect("deadline details");
    assert_eq!(details["timeoutMs"], json!(0));
    assert_eq!(details["rounds"], json!(0));
}

/// Returns one pre-built response per round so a test can pin a successful
/// work-bearing round followed by a failure or a schema floor.
struct ScriptedSyncTransport {
    responses: std::collections::VecDeque<Message>,
    calls: usize,
}

impl Transport for ScriptedSyncTransport {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.calls += 1;
        let response = self.responses.pop_front().expect("scripted response");
        Ok(encode_message(&response))
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[test]
fn sync_until_idle_success_then_failure_keeps_earlier_work() {
    let path = std::env::temp_dir().join(format!(
        "syncular-budget-script-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client = SyncClient::open_path(
        "budget-script".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .expect("open client");
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    live_unit(&client, &[("project_id", "p1")]);
    client.drain_change_batches();

    let row = encode_row_json(
        client.schema.table("tasks").unwrap(),
        "kept",
        &Map::from_iter([
            ("id".into(), json!("kept")),
            ("project_id".into(), json!("p1")),
        ]),
        &client.encryption,
    )
    .unwrap();
    let success = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".into(),
                reset_required: false,
            },
            Frame::LiveStart {
                status: LiveStatus::Active,
                reason_code: String::new(),
            },
            Frame::Commit {
                commit_seq: 1,
                created_at_ms: 1,
                actor_id: "writer".into(),
                tables: vec!["tasks".into()],
                changes: vec![ssp2::model::Change {
                    table_index: 0,
                    row_id: "kept".into(),
                    op: Op::Upsert,
                    row_version: 1,
                    scopes: vec![("project_id".into(), "p1".into())],
                    row: Some(row),
                }],
            },
            Frame::LiveEnd {
                through_seq: 1,
                echo_digest: None,
            },
        ],
    };
    let failure = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".into(),
                reset_required: false,
            },
            Frame::Error {
                code: "sync.internal_error".into(),
                message: "second round failed".into(),
                category: "internal".into(),
                retryable: false,
                recommended_action: "retryLater".into(),
                details: None,
            },
        ],
    };
    let mut transport = ScriptedSyncTransport {
        responses: std::collections::VecDeque::from([success, failure]),
        calls: 0,
    };
    let outcome = client.sync_until_idle(&mut transport, Some(2));
    let SyncOutcome::Failed {
        error_code,
        recommended_action,
        ..
    } = outcome
    else {
        panic!("expected the in-band failure");
    };
    assert_eq!(error_code, "sync.internal_error");
    assert_eq!(recommended_action.as_deref(), Some("retryLater"));
    assert_eq!(
        transport.calls, 2,
        "one successful round then the failing round"
    );
    assert_eq!(
        client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
        json!("kept"),
        "the earlier round's durable work survives the later failure"
    );
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn sync_until_idle_stops_on_a_schema_floor() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let floor = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![Frame::RespHeader {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
            log_epoch: "epoch-1".into(),
            reset_required: false,
        }],
    };
    let mut transport = ScriptedSyncTransport {
        responses: std::collections::VecDeque::from([floor.clone(), floor]),
        calls: 0,
    };
    let outcome = client.sync_until_idle(&mut transport, Some(3));
    match outcome {
        SyncOutcome::Ok(report) => assert_eq!(
            report
                .schema_floor
                .as_ref()
                .and_then(|floor| floor.required_schema_version),
            Some(2),
            "the stop retains the latest schema floor"
        ),
        other => panic!("expected a schema-floor stop, got {other:?}"),
    }
    assert_eq!(
        transport.calls, 1,
        "a schema floor stops the budget loop after one round"
    );
}

/// Records the decoded request of every round and answers from a script of
/// round results, so a test can pin what the following request carries.
struct FailureScriptTransport {
    rounds: std::collections::VecDeque<Result<Vec<u8>, TransportError>>,
    requests: Vec<Message>,
    segment_error: Option<TransportError>,
}

impl Transport for FailureScriptTransport {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.requests
            .push(decode_message(request).expect("the client encodes a legal request"));
        self.rounds.pop_front().expect("scripted round")
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(self
            .segment_error
            .clone()
            .unwrap_or_else(|| TransportError::new("transport.timeout", "segment stalled")))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

/// A complete response: RESP_HEADER for the client's epoch plus `frames`.
fn completed_response(frames: Vec<Frame>) -> Vec<u8> {
    let mut all = vec![Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "epoch-1".into(),
        reset_required: false,
    }];
    all.extend(frames);
    encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: all,
    })
}

fn carried_round_failures(request: &Message) -> Vec<String> {
    request
        .frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::RoundFailure { code } => Some(code.clone()),
            _ => None,
        })
        .collect()
}

fn failure_transport(
    rounds: impl IntoIterator<Item = Result<Vec<u8>, TransportError>>,
) -> FailureScriptTransport {
    FailureScriptTransport {
        rounds: rounds.into_iter().collect(),
        requests: Vec::new(),
        segment_error: None,
    }
}

#[test]
fn transport_diagnostics_bound_evidence_and_clear_it_after_recovery() {
    let secret = "https://user:password@example.invalid/private?token=secret";
    for (code, details, expected_cause, expected_status, connectivity, retry) in [
        (
            "transport.failed",
            json!({"causeKind":"connect", "secret":secret}),
            Some(crate::TransportCauseKind::Connect),
            None,
            "offline",
            None,
        ),
        (
            "transport.failed",
            json!({"causeKind":"status", "httpStatus":500, "secret":secret}),
            Some(crate::TransportCauseKind::Status),
            Some(500),
            "online",
            Some(250),
        ),
        (
            "sync.auth_required",
            json!({"causeKind":"status", "httpStatus":401, "secret":secret}),
            Some(crate::TransportCauseKind::Status),
            Some(401),
            "online",
            Some(250),
        ),
        (
            "transport.timeout",
            json!({"causeKind":"timeout", "secret":secret}),
            Some(crate::TransportCauseKind::Timeout),
            None,
            "unknown",
            Some(250),
        ),
        (
            "transport.failed",
            json!({"causeKind":"unknown", "secret":secret}),
            Some(crate::TransportCauseKind::Unknown),
            None,
            "unknown",
            Some(250),
        ),
        (
            "transport.failed",
            json!({"causeKind":secret, "httpStatus":500}),
            None,
            None,
            "unknown",
            Some(250),
        ),
        (
            "transport.failed",
            json!({"causeKind":"status", "httpStatus":500.5}),
            Some(crate::TransportCauseKind::Status),
            None,
            "unknown",
            Some(250),
        ),
        (
            "transport.failed",
            json!({"causeKind":"connect", "httpStatus":500}),
            Some(crate::TransportCauseKind::Connect),
            None,
            "offline",
            None,
        ),
    ] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        let mut error = TransportError::new(code, secret);
        error.details = Some(details);
        let mut transport = failure_transport([Err(error), Ok(completed_response(vec![]))]);
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { .. }
        ));
        let progress = client.progress().snapshot().unwrap();
        assert_eq!(progress.cause_kind, expected_cause);
        assert_eq!(progress.http_status, expected_status);
        assert_eq!(progress.retry_delay_ms, retry);
        let snapshot = client.diagnostics_snapshot().unwrap();
        assert_eq!(snapshot.host.connectivity, connectivity);
        let last_round = snapshot.last_round.as_ref().unwrap();
        assert_eq!(last_round.cause_kind, expected_cause);
        assert_eq!(last_round.http_status, expected_status);
        assert!(!serde_json::to_string(&snapshot).unwrap().contains(secret));
        assert!(!serde_json::to_string(&progress).unwrap().contains(secret));

        assert!(matches!(client.sync(&mut transport), SyncOutcome::Ok(_)));
        let progress = client.progress().snapshot().unwrap();
        assert_eq!(progress.cause_kind, None);
        assert_eq!(progress.http_status, None);
        let snapshot = client.diagnostics_snapshot().unwrap();
        assert_eq!(snapshot.host.connectivity, "online");
        let last_round = snapshot.last_round.unwrap();
        assert_eq!(last_round.cause_kind, None);
        assert_eq!(last_round.http_status, None);
    }
}

#[test]
fn a_round_without_a_complete_response_reports_its_code_on_every_following_request() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = failure_transport([
        Err(TransportError::new("transport.timeout", "round timed out")),
        Ok(completed_response(Vec::new())),
        Ok(completed_response(Vec::new())),
    ]);
    for _ in 0..3 {
        client.sync(&mut transport);
    }
    assert!(carried_round_failures(&transport.requests[0]).is_empty());
    assert_eq!(
        carried_round_failures(&transport.requests[1]),
        vec!["transport.timeout"]
    );
    assert!(
        matches!(transport.requests[1].frames[0], Frame::ReqHeader { .. })
            && matches!(transport.requests[1].frames[1], Frame::RoundFailure { .. }),
        "the report sits immediately after REQ_HEADER"
    );
    assert!(
        carried_round_failures(&transport.requests[2]).is_empty(),
        "a complete response ends the report"
    );
}

#[test]
fn a_newer_round_failure_replaces_the_kept_code() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = failure_transport([
        Err(TransportError::new("transport.timeout", "round timed out")),
        Err(TransportError::new("transport.failed", "socket closed")),
        Ok(completed_response(Vec::new())),
        Ok(completed_response(Vec::new())),
    ]);
    for _ in 0..4 {
        client.sync(&mut transport);
    }
    assert_eq!(
        carried_round_failures(&transport.requests[1]),
        vec!["transport.timeout"]
    );
    assert_eq!(
        carried_round_failures(&transport.requests[2]),
        vec!["transport.failed"]
    );
    assert!(carried_round_failures(&transport.requests[3]).is_empty());
}

#[test]
fn an_in_band_error_completes_the_round_and_is_never_reported() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = failure_transport([
        Err(TransportError::new("transport.timeout", "round timed out")),
        Ok(completed_response(vec![Frame::Error {
            code: "sync.internal_error".into(),
            message: "server error".into(),
            category: "internal".into(),
            retryable: false,
            recommended_action: "retryLater".into(),
            details: None,
        }])),
        Ok(completed_response(Vec::new())),
    ]);
    client.sync(&mut transport);
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"
    ));
    client.sync(&mut transport);
    assert_eq!(
        carried_round_failures(&transport.requests[1]),
        vec!["transport.timeout"]
    );
    assert!(
        carried_round_failures(&transport.requests[2]).is_empty(),
        "the server already recorded an in-band ERROR"
    );
}

#[test]
fn a_silent_segment_fetch_is_retryable_and_reported_on_the_next_request() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let id = client.subscribe(unit_scopes("project_id", "p1")).unwrap();
    client.drain_change_batches();
    client.drain_sync_intents();
    let mut transport = failure_transport([
        Ok(completed_response(vec![
            Frame::SubStart {
                id,
                status: SubStatus::Active,
                reason_code: String::new(),
                bootstrap: true,
                fenced: Vec::new(),
            },
            Frame::SegmentRef {
                segment_id: "sha256:stalled".into(),
                media_type: MediaType::Rows,
                table: "tasks".into(),
                byte_length: 1,
                row_count: 1,
                as_of_commit_seq: 1,
                scope_digest: "digest".into(),
                row_cursor: None,
                next_row_cursor: None,
                url: None,
                url_expires_at_ms: None,
            },
            Frame::SubEnd {
                next_cursor: 1,
                bootstrap_state: None,
            },
        ])),
        Ok(completed_response(Vec::new())),
        Ok(completed_response(Vec::new())),
    ]);
    let mut segment_error = TransportError::new("transport.timeout", "private response body");
    segment_error.details = Some(json!({
        "causeKind": "status",
        "httpStatus": 500,
        "url": "https://example.invalid/private"
    }));
    transport.segment_error = Some(segment_error);

    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "transport.timeout"
    ));
    let progress = client.progress().snapshot().unwrap();
    assert_eq!(progress.cause_kind, Some(crate::TransportCauseKind::Status));
    assert_eq!(progress.http_status, Some(500));
    let diagnostics = client.diagnostics_snapshot().unwrap();
    assert_eq!(diagnostics.host.connectivity, "online");
    let round = diagnostics.last_round.as_ref().unwrap();
    assert_eq!(round.cause_kind, Some(crate::TransportCauseKind::Status));
    assert_eq!(round.http_status, Some(500));
    assert!(!serde_json::to_string(&diagnostics)
        .unwrap()
        .contains("private"));
    assert!(!serde_json::to_string(&progress)
        .unwrap()
        .contains("private"));
    assert!(
        matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ),
        "a silent transfer asks the host for a Background retry"
    );
    client.sync(&mut transport);
    client.sync(&mut transport);
    assert!(carried_round_failures(&transport.requests[0]).is_empty());
    assert_eq!(
        carried_round_failures(&transport.requests[1]),
        vec!["transport.timeout"],
        "the round's own response was complete, so the fetch failure rides the next request"
    );
    assert!(
        carried_round_failures(&transport.requests[2]).is_empty(),
        "a complete response ends the report"
    );
}

#[test]
fn a_code_the_frame_grammar_rejects_is_not_attached() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = failure_transport([
        Err(TransportError::new("offline", "no dotted code")),
        Ok(completed_response(Vec::new())),
    ]);
    client.sync(&mut transport);
    client.sync(&mut transport);
    assert!(carried_round_failures(&transport.requests[1]).is_empty());
}

#[test]
fn sync_report_merge_schema_floor_is_latest_state() {
    let mut aggregate = SyncReport {
        schema_floor: Some(SchemaFloor {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
        }),
        ..SyncReport::default()
    };
    aggregate.merge(&SyncReport::default());
    assert!(
        aggregate.schema_floor.is_none(),
        "a later round without a floor clears it"
    );
}

#[test]
fn push_capacity_limits_are_hard_and_keep_intent() {
    // The configured operation cap is hard for the first commit.
    let mut c = client();
    c.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    c.limits.max_push_operations_per_request = Some(1);
    let id = c
        .mutate(vec![
            Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("a")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            },
            Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("b")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            },
        ])
        .unwrap();
    let error = c.build_request(false).unwrap_err();
    let SyncOutcome::Failed {
        error_code,
        details,
        ..
    } = *error
    else {
        panic!("expected a capacity failure");
    };
    assert_eq!(error_code, "client.push_request_too_large");
    let details = details.expect("capacity details");
    assert_eq!(details["kind"], json!("operations"));
    assert_eq!(details["limit"], json!(1));
    assert_eq!(details["size"], json!(2));
    assert_eq!(details["clientCommitId"], json!(id));
    assert_eq!(c.pending_commit_ids(), vec![id]);

    // The commit-count cap defers whole later commits.
    let mut c = client();
    c.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    c.limits.max_push_commits_per_request = Some(1);
    let first = c
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("one")),
                ("project_id".into(), json!("p1")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let second = c
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("two")),
                ("project_id".into(), json!("p1")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let (_, meta) = c.build_request(false).unwrap();
    assert_eq!(meta.pushed_ids, vec![first.clone()]);
    assert_eq!(meta.deferred_commits, 1);
    assert_eq!(c.pending_commit_ids(), vec![first, second]);
}

#[test]
fn push_request_byte_cap_defers_the_prefix_boundary_and_errors_the_head() {
    // Two small commits: a cap just below the full request defers the
    // last commit and sends the fitting prefix (header + first commit).
    let mut c = client();
    c.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let first = c
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("one")),
                ("project_id".into(), json!("p1")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let second = c
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("two")),
                ("project_id".into(), json!("p1")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let (message, meta) = c.build_request(false).unwrap();
    assert_eq!(meta.pushed_ids.len(), 2);
    let full = encode_message(&message).len();
    c.limits.max_push_request_bytes = Some(full - 1);
    let (_, meta) = c.build_request(false).unwrap();
    assert_eq!(meta.pushed_ids, vec![first.clone()]);
    assert_eq!(meta.deferred_commits, 1);
    assert_eq!(c.pending_commit_ids(), vec![first, second]);

    // A single commit larger than the budget is a typed capacity error and
    // stays queued, reporting the full projected request size.
    let mut c = client();
    c.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let huge = c
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("x".repeat(20_000))),
                ("project_id".into(), json!("p1")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let (message, meta) = c.build_request(false).unwrap();
    assert_eq!(meta.pushed_ids, vec![huge.clone()]);
    let with_huge = encode_message(&message).len();
    c.limits.max_push_request_bytes = Some(with_huge - 1);
    let error = c.build_request(false).unwrap_err();
    let SyncOutcome::Failed {
        error_code,
        details,
        ..
    } = *error
    else {
        panic!("expected a capacity failure");
    };
    assert_eq!(error_code, "client.push_request_too_large");
    let details = details.expect("capacity details");
    assert_eq!(details["kind"], json!("bytes"));
    assert_eq!(details["limit"], json!((with_huge - 1) as u64));
    assert_eq!(details["size"], json!(with_huge as u64));
    assert_eq!(details["clientCommitId"], json!(huge));
    assert_eq!(c.pending_commit_ids(), vec![huge]);

    // A cap smaller than the fixed frames reports no blocked commit.
    let mut c = client();
    c.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    c.limits.max_push_request_bytes = Some(1);
    let error = c.build_request(false).unwrap_err();
    let SyncOutcome::Failed { details, .. } = *error else {
        panic!("expected a capacity failure");
    };
    let details = details.expect("capacity details");
    assert_eq!(details["kind"], json!("bytes"));
    assert!(details.get("clientCommitId").is_none(), "{details}");
}

#[test]
fn push_limits_validate_at_construction() {
    for limits in [
        ClientLimits {
            max_push_commits_per_request: Some(0),
            ..Default::default()
        },
        ClientLimits {
            max_push_operations_per_request: Some(0),
            ..Default::default()
        },
        ClientLimits {
            max_push_request_bytes: Some(0),
            ..Default::default()
        },
        ClientLimits {
            max_push_request_bytes: Some(u32::MAX as usize + 1),
            ..Default::default()
        },
    ] {
        let schema = json!({"version":1,"tables":[]});
        let error = SyncClient::with_connection(
            "bad-limits".into(),
            &schema,
            limits,
            Connection::open_in_memory().unwrap(),
        )
        .err();
        assert_eq!(
            error.as_deref(),
            Some("sync.invalid_request: push limit must be an integer in 1..=4294967295")
        );
    }
}

#[test]
fn open_path_rejects_invalid_push_limits_before_storage() {
    for identity in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "syncular-bad-limits-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version":1,"tables":[]});
        let limits = ClientLimits {
            max_push_request_bytes: Some(0),
            ..Default::default()
        };
        let error = if identity {
            SyncClient::open_path_with_identity(None, &schema, limits, path.to_str().unwrap())
        } else {
            SyncClient::open_path("bad-limits".into(), &schema, limits, path.to_str().unwrap())
        }
        .err();
        assert_eq!(
            error.as_deref(),
            Some("sync.invalid_request: push limit must be an integer in 1..=4294967295")
        );
        assert!(
            !path.exists(),
            "an invalid limit is rejected before the database file is created"
        );
    }
}

#[test]
fn failed_progress_retry_delay_doubles_to_the_cap() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let mut transport = ServerErrorTransport {
        code: "sync.internal_error",
        retryable: true,
    };
    let delays: Vec<Option<u64>> = (0..9)
        .map(|_| {
            client.sync(&mut transport);
            client.progress().snapshot().unwrap().retry_delay_ms
        })
        .collect();
    assert_eq!(
        delays,
        [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].map(Some)
    );
}

#[test]
fn background_retry_deadlines_back_off_and_reset() {
    let mut client = client();
    client.schedule_background_retry();
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
    client.schedule_background_retry();
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 500 }]
    ));
    client.reset_background_retry();
    client.schedule_background_retry();
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
}

#[test]
fn log_epoch_reset_requests_an_immediate_follow_up_round() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
        .subscribe(UnitScopes::from([(
            "project_id".to_owned(),
            "p1".to_owned(),
        )]))
        .expect("subscribe");
    client.drain_sync_intents();

    client
        .run_log_epoch_reset("epoch-2")
        .expect("reset partition log epoch");

    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
}

#[derive(Default)]
struct CountingRealtimeTransport {
    connects: usize,
    closes: usize,
    messages: Vec<String>,
    blob_uploads: Vec<(String, Vec<u8>)>,
    blob_download: Option<Vec<u8>>,
    sync_calls: usize,
    realtime_sync_calls: usize,
    refuse_connect: bool,
}

impl Transport for CountingRealtimeTransport {
    fn blob_upload(
        &mut self,
        blob_id: &str,
        bytes: &[u8],
        _media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        self.blob_uploads.push((blob_id.to_owned(), bytes.to_vec()));
        Ok(())
    }

    fn blob_download(
        &mut self,
        _blob_id: &str,
        _byte_length: Option<u64>,
    ) -> Result<BlobDownload, TransportError> {
        self.blob_download
            .clone()
            .map(BlobDownload::Bytes)
            .ok_or_else(|| TransportError::new("blob.not_found", "missing blob"))
    }

    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync_calls += 1;
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.realtime_sync_calls += 1;
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "offline"))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        self.connects += 1;
        if self.refuse_connect {
            return Err(TransportError::new("transport.failed", "refused"));
        }
        Ok(())
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.messages.push(text.to_owned());
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        self.closes += 1;
        Ok(())
    }
}

#[test]
fn blob_results_own_downloaded_bytes() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    let bytes = b"owned typed result".to_vec();
    let blob_id = blob_id_for(&bytes);
    let mut transport = CountingRealtimeTransport {
        blob_download: Some(bytes.clone()),
        ..Default::default()
    };
    let result = {
        let mut client =
            SyncClient::new("owned-result".to_owned(), &schema, ClientLimits::default()).unwrap();
        let result = client.fetch_blob_bytes(&mut transport, &blob_id).unwrap();
        assert_eq!(result.blob_id, blob_id);
        assert_eq!(result.byte_length, bytes.len() as i64);
        assert_eq!(result.bytes, bytes);
        assert_eq!(result.media_type, None);
        assert_eq!(
            client
                .conn
                .query_row(
                    "SELECT count(*) FROM _syncular_blob_uploads WHERE blob_id = ?",
                    rusqlite::params![blob_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        result
    };
    assert_eq!(result.bytes, bytes);

    let mut client =
        SyncClient::new("blob-errors".to_owned(), &schema, ClientLimits::default()).unwrap();
    assert_eq!(
        client
            .fetch_blob_bytes(&mut transport, "not json")
            .unwrap_err(),
        (
            "client.failed".to_owned(),
            "blob ref is not JSON".to_owned()
        )
    );
}

#[test]
fn a_blob_longer_than_its_declared_byte_length_fails_before_the_content_check() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    // The body hashes to its content address, so only the §5.4 cap can
    // refuse it; a bare blobId declares no size and fetches it.
    let bytes = b"twelve bytes".to_vec();
    let blob_id = blob_id_for(&bytes);
    let reference = json!({"blobId": blob_id, "byteLength": 4}).to_string();
    let mut transport = CountingRealtimeTransport {
        blob_download: Some(bytes.clone()),
        ..Default::default()
    };
    let mut client =
        SyncClient::new("blob-cap".to_owned(), &schema, ClientLimits::default()).unwrap();
    assert_eq!(
        client
            .fetch_blob_bytes(&mut transport, &reference)
            .unwrap_err(),
        (
            "sync.invalid_request".to_owned(),
            "blob exceeds its byteLength".to_owned()
        )
    );
    assert_eq!(
        client
            .fetch_blob_bytes(&mut transport, &blob_id)
            .unwrap()
            .bytes,
        bytes
    );
}

#[test]
fn visible_blob_references_survive_cache_trimming() {
    let schema = json!({"version":1,"tables":[
        {"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"body","type":"blob_ref","nullable":true},
            {"name":"preview","type":"blob_ref","nullable":true}],"scopes":[]},
        {"name":"avatars","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"photo","type":"blob_ref","nullable":true}],"scopes":[]}
    ]});
    let bytes = b"referenced above cap".to_vec();
    let blob_id = blob_id_for(&bytes);
    let reference = json!({"blobId": blob_id, "byteLength": bytes.len()}).to_string();
    let mut client = SyncClient::new(
        "visible-blob-refs".to_owned(),
        &schema,
        ClientLimits {
            blob_cache_max_bytes: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    client.conn.execute(
        "INSERT INTO attachments VALUES ('one', ?, ?, 0), ('two', ?, 'malformed', 0), ('three', 12, ?, 0)",
        rusqlite::params![reference, reference, reference, reference],
    ).unwrap();
    client
        .conn
        .execute(
            "INSERT INTO avatars VALUES ('one', ?, 0), ('two', '{\"blobId\":12}', 0)",
            rusqlite::params![reference],
        )
        .unwrap();
    client.conn.execute(
        "INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES ('sha256:other', X'02', 1, NULL, 0)",
        [],
    ).unwrap();
    let mut transport = CountingRealtimeTransport {
        blob_download: Some(bytes.clone()),
        ..Default::default()
    };

    assert_eq!(
        client
            .fetch_blob_bytes(&mut transport, &blob_id)
            .unwrap()
            .bytes,
        bytes
    );
    let rows = client
        .conn
        .prepare("SELECT blob_id FROM _syncular_blobs ORDER BY blob_id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![blob_id]);
}

#[test]
fn closed_transport_never_invokes_network_and_reopen_is_host_owned() {
    let mut transport = CountingRealtimeTransport::default();
    let path = std::env::temp_dir().join(format!(
        "syncular-transport-gate-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],"scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client = SyncClient::open_path(
        "gate".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    client.connect_realtime(&mut transport).unwrap();
    client.set_transport_enabled(&mut transport, false);
    assert_eq!(transport.closes, 1);
    client.begin_security_preflight().unwrap();
    client.activate_security(Default::default()).unwrap();
    client
        .subscribe(UnitScopes::from([("project_id".to_owned(), "p1".into())]))
        .unwrap();
    for id in ["one", "two"] {
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!(id)),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
    }
    assert_eq!(
        client
            .query("SELECT id FROM tasks ORDER BY id", &[])
            .unwrap()
            .len(),
        2
    );
    assert!(
        matches!(client.sync(&mut transport), SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.offline")
    );
    assert!(client
        .connect_realtime(&mut transport)
        .unwrap_err()
        .starts_with("sync.offline:"));
    assert!(client
        .set_presence(&mut transport, "project:p1", None)
        .unwrap_err()
        .starts_with("sync.offline:"));
    assert_eq!(transport.sync_calls, 0);
    assert_eq!(transport.realtime_sync_calls, 0);
    assert_eq!(transport.connects, 1);
    assert!(transport.messages.is_empty());
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::None]
    ));
    let pending = client.pending_commit_ids();
    drop(client);
    let mut reopened = SyncClient::open_path(
        "gate".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    assert!(reopened.transport_enabled());
    reopened.set_transport_enabled(&mut transport, false);
    assert_eq!(reopened.pending_commit_ids(), pending);
    assert_eq!(
        reopened.query("SELECT id FROM tasks", &[]).unwrap().len(),
        2
    );
    reopened.set_transport_enabled(&mut transport, true);
    assert!(matches!(
        reopened.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
    reopened.set_transport_enabled(&mut transport, true);
    assert!(reopened.drain_sync_intents().is_empty());
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn realtime_connection_ownership_is_idempotent() {
    let mut client = client();
    let mut transport = CountingRealtimeTransport {
        connects: 0,
        closes: 0,
        ..Default::default()
    };
    client
        .connect_realtime(&mut transport)
        .expect("first connect");
    client
        .connect_realtime(&mut transport)
        .expect("idempotent connect");
    assert_eq!(transport.connects, 1);
    client.disconnect_realtime(&mut transport);
    client.disconnect_realtime(&mut transport);
    assert_eq!(transport.closes, 1);
    client
        .connect_realtime(&mut transport)
        .expect("deliberate reconnect");
    assert_eq!(transport.connects, 2);
}

#[test]
fn required_policy_refuses_a_round_without_a_socket_and_never_uses_http() {
    let mut client = client();
    client
        .set_realtime_policy(RealtimePolicy::Required)
        .expect("set policy");
    let mut transport = CountingRealtimeTransport::default();
    match client.sync(&mut transport) {
        SyncOutcome::RealtimeUnavailable {
            state,
            reason_code,
            retry_delay_ms,
        } => {
            assert_eq!(state, RealtimeState::Disconnected);
            assert_eq!(reason_code, None);
            assert_eq!(retry_delay_ms, 250);
        }
        other => panic!("expected RealtimeUnavailable, got {other:?}"),
    }
    assert_eq!(transport.sync_calls, 0);
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(snapshot.host.realtime, RealtimeState::Disconnected);
    assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Required);
    assert_eq!(snapshot.host.realtime_reason_code, None);
    assert_eq!(snapshot.host.realtime_retry_delay_ms, Some(250));
    assert_eq!(
        snapshot
            .last_round
            .as_ref()
            .and_then(|round| round.error_code.clone()),
        Some(REALTIME_UNAVAILABLE_CODE.to_owned())
    );
}

#[test]
fn refused_handshake_is_a_visible_state_and_a_required_round_does_not_fall_back() {
    let mut client = client();
    client
        .set_realtime_policy(RealtimePolicy::Required)
        .expect("set policy");
    let mut transport = CountingRealtimeTransport {
        refuse_connect: true,
        ..Default::default()
    };
    assert!(client.connect_realtime(&mut transport).is_err());
    assert_eq!(client.realtime_state(), RealtimeState::Refused);
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(
        snapshot.host.realtime_reason_code.as_deref(),
        Some("transport.failed")
    );
    match client.sync(&mut transport) {
        SyncOutcome::RealtimeUnavailable {
            state, reason_code, ..
        } => {
            assert_eq!(state, RealtimeState::Refused);
            assert_eq!(reason_code.as_deref(), Some("transport.failed"));
        }
        other => panic!("expected RealtimeUnavailable, got {other:?}"),
    }
    assert_eq!(transport.sync_calls, 0);
    assert_eq!(transport.realtime_sync_calls, 0);
}

#[test]
fn an_unsolicited_socket_end_is_lost_with_the_transport_code_and_a_retry_intent() {
    let mut client = client();
    let mut transport = CountingRealtimeTransport::default();
    let ended = TransportError::new("transport.failed", "realtime connection closed");
    client.realtime_lost(&mut transport, &ended);
    assert_eq!(
        client.realtime_state(),
        RealtimeState::Disconnected,
        "a socket that was never connected has nothing to lose"
    );
    assert!(client.drain_sync_intents().is_empty());

    client.connect_realtime(&mut transport).expect("connect");
    client.realtime_lost(&mut transport, &ended);
    assert_eq!(client.realtime_state(), RealtimeState::Lost);
    assert_eq!(transport.closes, 1);
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Background { delay_ms: 250 }]
    ));
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(snapshot.host.realtime, RealtimeState::Lost);
    assert_eq!(
        snapshot.host.realtime_reason_code.as_deref(),
        Some("transport.failed")
    );
    assert_eq!(snapshot.host.realtime_retry_delay_ms, Some(250));

    client.realtime_lost(&mut transport, &ended);
    assert!(
        client.drain_sync_intents().is_empty(),
        "a second report for the same loss schedules nothing"
    );
    client.connect_realtime(&mut transport).expect("reconnect");
    assert_eq!(client.realtime_state(), RealtimeState::Connected);
}

#[test]
fn a_failed_socket_round_is_lost_and_the_next_required_round_refuses_http() {
    let mut client = client();
    client
        .set_realtime_policy(RealtimePolicy::Required)
        .expect("set policy");
    let mut transport = CountingRealtimeTransport::default();
    client.connect_realtime(&mut transport).expect("connect");
    assert_eq!(client.realtime_state(), RealtimeState::Connected);
    assert!(
        client.set_realtime_policy(RealtimePolicy::Off).is_err(),
        "a policy change cannot silently re-route a connected socket"
    );
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.transport_failed"
    ));
    assert_eq!(client.realtime_state(), RealtimeState::Lost);
    assert_eq!(transport.realtime_sync_calls, 1);
    assert_eq!(transport.sync_calls, 0);
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(
        snapshot.host.realtime_reason_code.as_deref(),
        Some("sync.transport_failed")
    );
    assert_eq!(snapshot.host.realtime_retry_delay_ms, Some(250));
    match client.sync(&mut transport) {
        SyncOutcome::RealtimeUnavailable {
            state, reason_code, ..
        } => {
            assert_eq!(state, RealtimeState::Lost);
            assert_eq!(reason_code.as_deref(), Some("sync.transport_failed"));
        }
        other => panic!("expected RealtimeUnavailable, got {other:?}"),
    }
    assert_eq!(transport.sync_calls, 0);
    client.disconnect_realtime(&mut transport);
    assert_eq!(client.realtime_state(), RealtimeState::Disconnected);
    assert_eq!(transport.closes, 1);
    client.connect_realtime(&mut transport).expect("reconnect");
    assert_eq!(client.realtime_state(), RealtimeState::Connected);
    assert_eq!(transport.connects, 2);
}

#[test]
fn off_policy_uses_http_and_refuses_an_explicit_connect() {
    let mut client = client();
    client
        .set_realtime_policy(RealtimePolicy::Off)
        .expect("set policy");
    let mut transport = CountingRealtimeTransport::default();
    assert!(client.connect_realtime(&mut transport).is_err());
    assert_eq!(client.realtime_state(), RealtimeState::Disabled);
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { .. }
    ));
    assert_eq!(transport.sync_calls, 1);
    assert_eq!(transport.realtime_sync_calls, 0);
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(snapshot.host.realtime, RealtimeState::Disabled);
    assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Off);
}

#[test]
fn optional_policy_keeps_the_http_round() {
    let mut client = client();
    let mut transport = CountingRealtimeTransport::default();
    assert!(matches!(
        client.sync(&mut transport),
        SyncOutcome::Failed { .. }
    ));
    assert_eq!(transport.sync_calls, 1);
    assert_eq!(transport.realtime_sync_calls, 0);
    let snapshot = client.diagnostics_snapshot().expect("diagnostics");
    assert_eq!(snapshot.host.realtime, RealtimeState::Disconnected);
    assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Optional);
}

#[test]
fn local_rebootstrap_is_atomic_idempotent_and_preserves_offline_work() {
    let mut client = client();
    let id = live_unit(&client, &[("project_id", "p1")]);
    for table in ["_syncular_base_tasks", "tasks"] {
        client
            .conn
            .execute(
                &format!(
                    "INSERT INTO {table}(id, project_id, _syncular_version) VALUES (?1, ?2, 1)"
                ),
                rusqlite::params!["server-row", "p1"],
            )
            .expect("seed server row");
    }
    let pending = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("offline-row")),
                ("project_id".to_owned(), Value::from("p1")),
            ]),
            base_version: None,
        }])
        .expect("queue offline work");
    client.drain_change_batches();
    client.drain_sync_intents();

    assert_eq!(
        client
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "support-case-001".to_owned(),
            })
            .expect("rebootstrap"),
        LocalDataRebootstrapResult {
            already_applied: false,
            retained_commits: 1,
            reset_subscriptions: 1,
        }
    );
    let visible_ids = client
        .conn
        .prepare("SELECT id FROM tasks ORDER BY id")
        .expect("prepare visible ids")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query visible ids")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect visible ids");
    assert_eq!(visible_ids, vec!["offline-row"]);
    assert_eq!(client.pending_commit_ids(), vec![pending]);
    assert_eq!(client.unit(&id).unwrap().expect("unit").cursor, Some(-1));
    assert!(client.upgrading());
    assert!(client.sync_needed());
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
    assert_eq!(client.drain_change_batches().len(), 1);

    assert_eq!(
        client
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "support-case-001".to_owned(),
            })
            .expect("idempotent retry"),
        LocalDataRebootstrapResult {
            already_applied: true,
            retained_commits: 1,
            reset_subscriptions: 1,
        }
    );
    assert!(client.drain_change_batches().is_empty());
}

#[test]
fn local_rebootstrap_receipt_codec_is_bounded_and_legacy_compatible() {
    let encoded = encode_local_rebootstrap_receipt(3, 4).expect("encode receipt");
    assert_eq!(
        decode_local_rebootstrap_receipt(&encoded).expect("decode receipt"),
        (3, 4)
    );
    assert_eq!(
        decode_local_rebootstrap_receipt("v1").expect("legacy marker"),
        (0, 0)
    );
    for malformed in [
        "",
        "{}",
        r#"{"version":3,"retainedCommits":1,"resetSubscriptions":1}"#,
        r#"{"version":2,"retainedCommits":1,"resetSubscriptions":1,"extra":true}"#,
        r#"{"version":2,"retainedCommits":9007199254740992,"resetSubscriptions":1}"#,
    ] {
        assert_eq!(
            decode_local_rebootstrap_receipt(malformed).expect_err("malformed receipt must fail"),
            "sync.local_corrupt: persisted local rebootstrap receipt is invalid"
        );
    }
}

#[test]
fn local_rebootstrap_replays_the_original_receipt_after_reopen() {
    let path = std::env::temp_dir().join(format!(
        "syncular-rebootstrap-receipt-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let path_string = path.to_str().expect("UTF-8 temp path");

    {
        let mut first = SyncClient::open_path(
            "repair-restart-client".to_owned(),
            &schema,
            ClientLimits::default(),
            path_string,
        )
        .expect("first open");
        first
            .subscribe(UnitScopes::from([(
                "project_id".to_owned(),
                "p1".to_owned(),
            )]))
            .expect("subscribe");
        first
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("offline-row")),
                    ("project_id".to_owned(), Value::from("p1")),
                ]),
                base_version: None,
            }])
            .expect("queue offline work");
        assert_eq!(
            first
                .rebootstrap_local_data(&LocalDataRebootstrapInput {
                    rebootstrap_id: "restart-receipt".to_owned(),
                })
                .expect("first rebootstrap"),
            LocalDataRebootstrapResult {
                already_applied: false,
                retained_commits: 1,
                reset_subscriptions: 1,
            }
        );
    }

    let mut reopened = SyncClient::open_path(
        "repair-restart-client".to_owned(),
        &schema,
        ClientLimits::default(),
        path_string,
    )
    .expect("reopen");
    reopened.drain_change_batches();
    reopened.drain_sync_intents();
    assert_eq!(
        reopened
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "restart-receipt".to_owned(),
            })
            .expect("receipt replay"),
        LocalDataRebootstrapResult {
            already_applied: true,
            retained_commits: 1,
            reset_subscriptions: 1,
        }
    );
    assert!(reopened.drain_change_batches().is_empty());
    assert!(reopened.drain_sync_intents().is_empty());
    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn local_rebootstrap_fails_closed_on_malformed_or_unreadable_receipts() {
    let mut malformed = client();
    let unit = malformed
        .subscribe(UnitScopes::from([(
            "project_id".to_owned(),
            "p1".to_owned(),
        )]))
        .expect("subscribe");
    malformed
        .set_meta("localRebootstrap:malformed", "{\"version\":2}")
        .unwrap();
    malformed.drain_change_batches();
    malformed.drain_sync_intents();
    let malformed_error = malformed
        .rebootstrap_local_data(&LocalDataRebootstrapInput {
            rebootstrap_id: "malformed".to_owned(),
        })
        .expect_err("malformed receipt must fail closed");
    assert_eq!(
        malformed_error,
        "sync.local_corrupt: persisted local rebootstrap receipt is invalid"
    );
    assert!(!malformed.upgrading());
    assert_eq!(
        malformed
            .unit(&unit)
            .unwrap()
            .expect("unchanged unit")
            .cursor,
        Some(-1)
    );
    assert!(malformed.drain_change_batches().is_empty());
    assert!(malformed.drain_sync_intents().is_empty());

    let mut unreadable = client();
    unreadable
        .conn
        .execute(
            "INSERT INTO tasks(id, project_id, _syncular_version) VALUES (?1, ?2, 1)",
            rusqlite::params!["server-row", "p1"],
        )
        .expect("seed visible row");
    unreadable
        .conn
        .execute("DROP TABLE _syncular_meta", [])
        .expect("break marker storage");
    let unreadable_error = unreadable
        .rebootstrap_local_data(&LocalDataRebootstrapInput {
            rebootstrap_id: "unreadable".to_owned(),
        })
        .expect_err("unreadable marker storage must fail closed");
    assert_eq!(
        unreadable_error,
        "sync.local_corrupt: persisted local rebootstrap receipt is unreadable"
    );
    let visible_rows = unreadable
        .conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
        .expect("visible projection remains");
    assert_eq!(visible_rows, 1);
    assert!(!unreadable.upgrading());
    assert!(unreadable.drain_change_batches().is_empty());
    assert!(unreadable.drain_sync_intents().is_empty());
}

#[test]
fn local_rebootstrap_cannot_bypass_schema_floor() {
    let mut client = client();
    client
        .set_schema_floor(Some(SchemaFloor {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
        }))
        .unwrap();
    let error = client
        .rebootstrap_local_data(&LocalDataRebootstrapInput {
            rebootstrap_id: "blocked-floor".to_owned(),
        })
        .expect_err("schema floor must block repair");
    assert!(error.contains("cannot bypass an active schema-floor stop"));
}

#[test]
fn diego_applied_sparse_moves_stay_visible_until_pull_image_arrives() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
        "columns":[{"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"starts_at_ms","type":"integer","nullable":false},
            {"name":"version","type":"integer","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client =
        SyncClient::new("diego-ack-gap".into(), &schema, ClientLimits::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
        .write_base_row(
            "tasks",
            &vec![
                Some(ColumnValue::String("t1".into())),
                Some(ColumnValue::String("p1".into())),
                Some(ColumnValue::Integer(100)),
                Some(ColumnValue::Integer(1)),
            ],
            1,
        )
        .unwrap();
    client.rebuild_overlay().expect("rebuild overlay");
    let first = client
        .patch(
            "tasks",
            "t1",
            Map::from_iter([
                ("starts_at_ms".into(), json!(200)),
                ("version".into(), json!(2)),
            ]),
            None,
        )
        .unwrap();
    let (_, first_request) = client.build_request(false).unwrap();
    // This second edit happens while the first request is in flight.
    let second = client
        .patch(
            "tasks",
            "t1",
            Map::from_iter([
                ("starts_at_ms".into(), json!(300)),
                ("version".into(), json!(3)),
            ]),
            None,
        )
        .unwrap();
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    for (id, seq, meta) in [
        (first, 2, first_request),
        (second, 3, client.build_request(false).unwrap().1),
    ] {
        let response = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: "epoch-1".into(),
                    reset_required: false,
                },
                Frame::PushResult {
                    client_commit_id: id,
                    status: PushStatus::Applied,
                    commit_seq: Some(seq),
                    results: vec![OpResult::Applied { op_index: 0 }],
                },
            ],
        };
        assert!(matches!(
            client.process_response(&mut transport, response, &meta),
            SyncOutcome::Ok(_)
        ));
        let row = &client
            .query("SELECT starts_at_ms, version FROM tasks WHERE id='t1'", &[])
            .unwrap()[0];
        assert_eq!(
            row["starts_at_ms"],
            json!(300),
            "an applied ACK without a pull image must not expose the old base"
        );
        assert_eq!(
            row["version"],
            json!(3),
            "the queued domain version must remain monotonic"
        );
    }
}

#[test]
fn first_epoch_acquisition_preserves_tables_subscriptions_and_local_intent() {
    for stored in [None, Some("epoch-old")] {
        let mut client = client();
        let unit = client
            .subscribe(UnitScopes::from([("project_id".to_owned(), "p1".into())]))
            .unwrap();
        client
            .conn
            .execute_batch(
                "CREATE TRIGGER epoch_table_identity AFTER INSERT ON tasks BEGIN SELECT 1; END",
            )
            .unwrap();
        let id = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("offline")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        if let Some(epoch) = stored {
            client.set_meta(LOG_EPOCH_KEY, epoch).unwrap();
        }
        let before = client.unit(&unit).unwrap();
        let (_, meta) = client.build_request(false).unwrap();
        client.drain_change_batches();
        client.drain_sync_intents();
        let response = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-new".into(),
                reset_required: true,
            }],
        };
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        let outcome = client.process_response(&mut transport, response, &meta);
        let SyncOutcome::Ok(report) = outcome else {
            panic!("epoch round failed: {outcome:?}");
        };
        assert_eq!(
            report.resets,
            if stored.is_none() {
                Vec::<String>::new()
            } else {
                vec![unit.clone()]
            }
        );
        assert_eq!(
            client.get_meta(LOG_EPOCH_KEY).unwrap().as_deref(),
            Some("epoch-new")
        );
        assert_eq!(client.pending_commit_ids(), vec![id]);
        assert_eq!(
            client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
            json!("offline")
        );
        let trigger: i64 = client
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='epoch_table_identity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if stored.is_none() {
            assert!(!client.upgrading);
            assert!(client
                .drain_change_batches()
                .iter()
                .all(|batch| batch.status.as_ref().is_none_or(|status| !status.upgrading)));
            assert_eq!(client.unit(&unit).unwrap(), before);
            assert_eq!(trigger, 1, "acquisition must not drop the synced table");
        } else {
            assert!(client.upgrading);
            assert_eq!(trigger, 0, "an epoch change must drop the old table");
        }
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
    }
}

#[test]
fn epoch_acquisition_storage_failures_preserve_ready_state_and_intent() {
    for key in ["logEpoch", "localRevision"] {
        let mut client = client();
        let id = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("offline")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let revision = client.local_revision().unwrap();
        let needed = client.sync_needed;
        client.drain_change_batches();
        client.drain_sync_intents();
        client.conn.execute_batch(&format!("CREATE TRIGGER fail_acquisition BEFORE INSERT ON _syncular_meta WHEN NEW.key='{key}' BEGIN SELECT RAISE(FAIL,'injected acquisition failure'); END")).unwrap();
        assert!(client.run_log_epoch_reset("epoch-new").is_err());
        assert!(client.get_meta(LOG_EPOCH_KEY).unwrap().is_none());
        assert!(!client.upgrading);
        assert_eq!(client.sync_needed, needed);
        assert_eq!(client.local_revision().unwrap(), revision);
        assert_eq!(client.pending_commit_ids(), [id]);
        assert!(client.drain_change_batches().is_empty());
        assert!(client.drain_sync_intents().is_empty());
    }
}

#[test]
fn failed_log_epoch_resets_restore_memory_and_durable_state() {
    for key in [
        "localSchemaVersion",
        "localSchemaDescriptor",
        "logEpoch",
        "localRevision",
    ] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-old").unwrap();
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("offline")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        client.active_round = Some(uuid::Uuid::new_v4());
        client.overlay_dirty.set(false);
        let round = client.active_round;
        let needed = client.sync_needed;
        let revision = client.local_revision().unwrap();
        let rows = serde_json::to_value(client.read_rows("tasks").unwrap()).unwrap();
        client.drain_change_batches();
        client.drain_sync_intents();
        client.conn.execute_batch(&format!("CREATE TRIGGER fail_reset BEFORE INSERT ON _syncular_meta WHEN NEW.key='{key}' BEGIN SELECT RAISE(FAIL,'injected reset failure'); END")).unwrap();
        assert!(client.run_log_epoch_reset("epoch-new").is_err(), "{key}");
        assert_eq!(
            client.get_meta(LOG_EPOCH_KEY).unwrap().as_deref(),
            Some("epoch-old")
        );
        assert!(!client.upgrading);
        assert_eq!(client.active_round, round);
        assert!(!client.overlay_dirty.get());
        assert_eq!(client.sync_needed, needed);
        assert_eq!(client.local_revision().unwrap(), revision);
        assert_eq!(
            client.pending_commit_ids().as_slice(),
            std::slice::from_ref(&commit)
        );
        assert_eq!(
            serde_json::to_value(client.read_rows("tasks").unwrap()).unwrap(),
            rows
        );
        assert!(client.drain_change_batches().is_empty());
        assert!(client.drain_sync_intents().is_empty());
        assert!(client.conn.is_autocommit());
        client
            .conn
            .execute_batch("DROP TRIGGER fail_reset")
            .unwrap();
        client.run_log_epoch_reset("epoch-new").unwrap();
        assert_eq!(
            client.get_meta(LOG_EPOCH_KEY).unwrap().as_deref(),
            Some("epoch-new")
        );
        assert_eq!(client.pending_commit_ids(), [commit]);
    }
}

#[test]
fn acknowledged_restore_and_replay_ignore_unrelated_subscription_count() {
    for subscriptions in [0, 2, 6, 12] {
        let mut client = SyncClient::new("ack-scope".into(), &json!({ "version": 1, "tables": [
            { "name": "tasks", "primaryKey": "id", "columns": [{ "name": "id", "type": "string", "nullable": false }, { "name": "project_id", "type": "string", "nullable": false }], "scopes": [{ "pattern": "project:{project_id}" }] },
            { "name": "docs", "primaryKey": "id", "columns": [{ "name": "id", "type": "string", "nullable": false }, { "name": "project_id", "type": "string", "nullable": false }], "scopes": [{ "pattern": "project:{project_id}" }] }
        ] }), ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        client.conn.execute_batch("CREATE TABLE ack_writes(kind TEXT); CREATE TRIGGER count_ack_restore AFTER DELETE ON tasks BEGIN INSERT INTO ack_writes VALUES('restore'); END; CREATE TRIGGER count_ack_replay AFTER INSERT ON tasks BEGIN INSERT INTO ack_writes VALUES('replay'); END;").unwrap();
        for index in 0..32 {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!(format!("task-{index}"))),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
        }
        let (_, meta) = client.build_request(false).unwrap();
        let mut frames = vec![Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: "epoch-1".into(),
            reset_required: false,
        }];
        frames.extend(
            meta.pushed_ids
                .iter()
                .enumerate()
                .map(|(index, id)| Frame::PushResult {
                    client_commit_id: id.clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(index as i64 + 1),
                    results: vec![OpResult::Applied { op_index: 0 }],
                }),
        );
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        client.acknowledged_replay_count.set(0);
        client.conn.execute("DELETE FROM ack_writes", []).unwrap();
        assert!(matches!(
            client.process_response(
                &mut transport,
                Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames
                },
                &meta
            ),
            SyncOutcome::Ok(_)
        ));
        assert_eq!(client.acknowledged_replay_count.get(), 32);
        assert_eq!(
            client
                .query(
                    "SELECT count(*) AS n FROM ack_writes WHERE kind='restore'",
                    &[]
                )
                .unwrap()[0]["n"],
            json!(32)
        );
        assert_eq!(
            client
                .query(
                    "SELECT count(*) AS n FROM ack_writes WHERE kind='replay'",
                    &[]
                )
                .unwrap()[0]["n"],
            json!(32)
        );
        client.conn.execute("DELETE FROM ack_writes", []).unwrap();
        client.acknowledged_replay_count.set(0);
        let docs = client.schema.table("docs").unwrap().clone();
        for index in 0..subscriptions {
            let effective = vec![("project_id".to_owned(), vec![format!("scope-{index}")])];
            let segment = RowsSegment {
                table: "docs".into(),
                schema_version: 1,
                columns: client.schema.table("docs").unwrap().wire_columns.clone(),
                blocks: if index % 2 == 0 {
                    vec![vec![ssp2::segment::SegmentRow {
                        values: vec![
                            Some(ColumnValue::String(format!("doc-{index}"))),
                            Some(ColumnValue::String(format!("scope-{index}"))),
                        ],
                        server_version: 1,
                    }]]
                } else {
                    vec![]
                },
            };
            assert!(client
                .apply_segment(&docs, &segment, true, &effective, &[])
                .is_ok());
        }
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM ack_writes", &[])
                .unwrap()[0]["n"],
            json!(0),
            "unrelated bootstrap must not restore/replay tasks"
        );
        assert_eq!(
            client.acknowledged_replay_count.get(),
            0,
            "unrelated bootstrap must not decode task ACKs"
        );
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            json!(32)
        );
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM _syncular_acked_rows", &[])
                .unwrap()[0]["n"],
            json!(32)
        );
    }
}

#[test]
fn batched_push_acknowledgements_reconcile_rows_without_a_table_rebuild() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    const COMMIT_COUNT: usize = 32;

    for index in 0..COMMIT_COUNT {
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from(format!("task-{index}"))),
                    ("project_id".to_owned(), Value::from("project-1")),
                ]),
                base_version: None,
            }])
            .expect("queue commit");
    }

    let (_, request_meta) = client.build_request(false).unwrap();
    assert_eq!(request_meta.pushed_ids.len(), COMMIT_COUNT);
    let mut frames = vec![Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "epoch-1".to_owned(),
        reset_required: false,
    }];
    frames.extend(
        request_meta
            .pushed_ids
            .iter()
            .enumerate()
            .map(|(index, client_commit_id)| Frame::PushResult {
                client_commit_id: client_commit_id.clone(),
                status: PushStatus::Applied,
                commit_seq: Some(index as i64 + 1),
                results: vec![OpResult::Applied { op_index: 0 }],
            }),
    );
    let response = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames,
    };
    let mut transport =
        HostTransport::new_from_config(&json!({})).expect("no-network host transport");

    client.overlay_rebuild_count.set(0);
    client.outcome_prune_count.set(0);
    let outcome = client.process_response(&mut transport, response, &request_meta);
    assert!(matches!(outcome, SyncOutcome::Ok(_)));
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(
        client.overlay_rebuild_count.get(),
        0,
        "acknowledged commits reconcile their rows without a table rebuild"
    );
    assert_eq!(
        client.outcome_prune_count.get(),
        1,
        "one response must enforce outcome retention once"
    );
}

#[test]
fn clean_commit_mirroring_matches_full_replay_with_fts_and_unique_indexes() {
    let schema = json!({ "version": 1, "tables": [{ "name": "tasks", "primaryKey": "id",
        "columns": [
            {"name":"id", "type":"string", "nullable":false},
            {"name":"project_id", "type":"string", "nullable":false},
            {"name":"title", "type":"string", "nullable":false}
        ], "scopes": [{"pattern":"project:{project_id}"}],
        "indexes": [{"name":"unique_title", "columns":["title"], "unique":true}],
        "ftsIndexes": [{"name":"tasks_fts", "columns":["title"], "tokenize":"unicode61"}]
    }] });
    let mut incremental =
        SyncClient::new("mirror".to_owned(), &schema, ClientLimits::default()).unwrap();
    let mut reference =
        SyncClient::new("mirror".to_owned(), &schema, ClientLimits::default()).unwrap();
    let tables = vec!["tasks".to_owned()];
    for index in 0..32 {
        let id = format!("task-{}", index % 8);
        let values = Map::from_iter([
            ("id".to_owned(), Value::from(id.clone())),
            (
                "project_id".to_owned(),
                Value::from(format!("p{}", index % 2)),
            ),
            ("title".to_owned(), Value::from(format!("needle{index}"))),
        ]);
        let payload = encode_row_json(
            incremental.schema.table("tasks").unwrap(),
            &id,
            &values,
            &incremental.encryption,
        )
        .unwrap();
        let change = ssp2::model::Change {
            table_index: 0,
            row_id: id,
            op: if index % 5 == 0 {
                Op::Delete
            } else {
                Op::Upsert
            },
            row_version: index + 1,
            scopes: vec![("project_id".to_owned(), format!("p{}", index % 2))],
            row: Some(payload),
        };
        reference.overlay_dirty.set(true);
        for instance in [&mut incremental, &mut reference] {
            instance.begin_observation("mirror_test").unwrap();
            let mut batch = ChangeAccumulator::default();
            instance.record_commit_changes(&mut batch, &tables, std::slice::from_ref(&change));
            instance
                .apply_commit_changes(&tables, std::slice::from_ref(&change))
                .unwrap();
            instance
                .rebuild_overlay_if_dirty()
                .expect("rebuild overlay");
            instance.finish_observation("mirror_test", batch).unwrap();
        }
        for sql in [
            "SELECT * FROM tasks ORDER BY id",
            "SELECT _syncular_source_id, title FROM tasks_fts ORDER BY _syncular_source_id",
        ] {
            assert_eq!(
                incremental.query(sql, &[]).unwrap(),
                reference.query(sql, &[]).unwrap()
            );
        }
        assert_eq!(
            incremental.local_revision().unwrap(),
            reference.local_revision().unwrap()
        );
        assert_eq!(
            serde_json::to_value(incremental.drain_change_batches()).unwrap(),
            serde_json::to_value(reference.drain_change_batches()).unwrap()
        );
    }
    assert_eq!(incremental.overlay_rebuild_count.get(), 0);
    assert_eq!(reference.overlay_rebuild_count.get(), 32);
}

#[test]
fn row_id_lookups_preserve_text_matching_and_seek_lossless_keys() {
    let cases = [
        (
            "string",
            vec![
                json!("1"),
                json!("01"),
                json!(""),
                json!("nul\u{0}id"),
                json!("é"),
            ],
        ),
        (
            "integer",
            vec![
                json!(i64::MIN),
                json!(-1),
                json!(0),
                json!(1),
                json!(i64::MAX),
            ],
        ),
        ("boolean", vec![json!(false), json!(true)]),
        ("json", vec![json!("null"), json!("1"), json!("{\"a\":1}")]),
    ];
    for (kind, ids) in cases {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
            "columns":[{"name":"id","type":kind,"nullable":false},
                {"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client =
            SyncClient::new("row-id-lookup".into(), &schema, ClientLimits::default()).unwrap();
        for (index, id) in ids.iter().enumerate() {
            let table = client.schema.table("tasks").unwrap();
            client
                .write_base_row(
                    "tasks",
                    &vec![
                        if kind == "integer" {
                            // Exercise local SQLite key lookup across its
                            // full i64 range independently of authoring.
                            Some(ColumnValue::Integer(id.as_i64().unwrap()))
                        } else {
                            json_to_column_value(&table.columns[0], Some(id)).unwrap()
                        },
                        Some(ColumnValue::String(format!("p{index}"))),
                    ],
                    1,
                )
                .unwrap();
        }
        client.rebuild_overlay_if_dirty().expect("rebuild overlay");
        for base in [true, false] {
            let full = if base {
                base_table("tasks")
            } else {
                visible_table("tasks")
            };
            let predicate = row_id_predicate(client.schema.table("tasks").unwrap());
            for row_id in [
                "1",
                "01",
                "1.0",
                "1.0000000000000002",
                "+1",
                "1e0",
                " 1",
                "-1",
                "0",
                "9223372036854775807",
                "-9223372036854775808",
                "true",
                "false",
                "",
                "nul\u{0}id",
                "é",
                "null",
                "{\"a\":1}",
            ] {
                let old_sql = format!("SELECT project_id FROM {full} WHERE CAST(id AS TEXT) = ?1");
                let new_sql = format!("SELECT project_id FROM {full} WHERE {predicate}");
                let old = client
                    .conn
                    .prepare(&old_sql)
                    .unwrap()
                    .query_map([row_id], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                let new = client
                    .conn
                    .prepare_cached(&new_sql)
                    .unwrap()
                    .query_map([row_id], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                assert_eq!(old, new, "{kind}, base={base}, row_id={row_id:?}");
                let mut batch = ChangeAccumulator::default();
                assert_eq!(
                    client.record_row_scopes(&mut batch, "tasks", row_id, base),
                    !old.is_empty()
                );
                let expected = old.first().map(|scope| {
                    BTreeMap::from([(
                        "tasks".to_owned(),
                        Some(BTreeSet::from([format!("project:{scope}")])),
                    )])
                });
                assert_eq!(batch.tables, expected.unwrap_or_default());
                client
                    .conn
                    .execute_batch("SAVEPOINT lookup_delete")
                    .unwrap();
                if base {
                    client.delete_base_row("tasks", row_id, i64::MAX).unwrap();
                } else {
                    client
                        .apply_outbox_ops(&[OutboxOp {
                            upsert: false,
                            insert: false,
                            table: "tasks".into(),
                            row_id: row_id.into(),
                            base_version: None,
                            values: None,
                        }])
                        .expect("replay delete");
                }
                let remaining: i64 = client
                    .conn
                    .query_row(&format!("SELECT count(*) FROM {full}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(remaining, ids.len() as i64 - old.len() as i64);
                client
                    .conn
                    .execute_batch("ROLLBACK TO lookup_delete; RELEASE lookup_delete")
                    .unwrap();
                client.overlay_dirty.set(false);
            }
            for (predicate, expected) in [
                ("CAST(id AS TEXT) = ?1".to_owned(), "SCAN"),
                (predicate, "SEARCH"),
            ] {
                let sql = format!(
                    "EXPLAIN QUERY PLAN SELECT project_id FROM {full} WHERE {predicate} LIMIT 1"
                );
                let details = client
                    .conn
                    .prepare(&sql)
                    .unwrap()
                    .query_map(["1"], |row| row.get::<_, String>(3))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                assert!(
                    details.iter().any(|detail| detail.contains(expected)),
                    "{kind}: {details:?}"
                );
            }
        }
    }
}

#[test]
fn primary_keys_reject_every_ineligible_column_type() {
    // §2.4: a `rowId` is a string, so a primary key type whose string form
    // differs per renderer, or cannot be reproduced by local storage
    // comparison, is a schema error rather than a silent lookup miss.
    for ty in ["float", "bytes", "crdt", "blob_ref"] {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
            "columns":[{"name":"id","type":ty,"nullable":false},
                {"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let error = match SyncClient::new("pk-eligibility".into(), &schema, ClientLimits::default())
        {
            Ok(_) => panic!("ineligible primary key {ty} must be rejected"),
            Err(error) => error,
        };
        assert!(
            error.contains("has an ineligible column type (§2.4)"),
            "{ty}: {error}"
        );
    }
    for ty in ["string", "integer", "boolean", "json"] {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
            "columns":[{"name":"id","type":ty,"nullable":false},
                {"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        SyncClient::new("pk-eligibility".into(), &schema, ClientLimits::default())
            .unwrap_or_else(|error| panic!("{ty}: {error}"));
    }
}

#[test]
fn scope_columns_must_be_string_or_integer() {
    for (ty, accepted) in [
        ("string", true),
        ("integer", true),
        ("float", false),
        ("boolean", false),
        ("json", false),
        ("bytes", false),
        ("blob_ref", false),
        ("crdt", false),
    ] {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
            "columns":[{"name":"id","type":"string","nullable":false},
                {"name":"project_id","type":ty,"nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let built = SyncClient::new("scope-types".into(), &schema, ClientLimits::default());
        match (accepted, built) {
            (true, Ok(_)) => {}
            (false, Err(error)) => assert!(error.contains("(§3.1)"), "{ty}: {error}"),
            (true, Err(error)) => panic!("{ty}: {error}"),
            (false, Ok(_)) => panic!("{ty} must be refused"),
        }
    }
}

#[test]
fn pending_row_reconciliation_matches_full_fifo_replay() {
    for unique in [false, true] {
        let schema = json!({"version": 1, "tables": (["tasks", "notes"].map(|name| json!({
            "name": name, "primaryKey": "id", "columns": [
                {"name":"id", "type":"string", "nullable":false},
                {"name":"project_id", "type":"string", "nullable":false},
                {"name":"title", "type":"string", "nullable":false}],
            "scopes": [{"pattern":"project:{project_id}"}],
            "indexes": [{"name":format!("{name}_title"), "columns":["title"], "unique":unique || name == "notes"}],
            "ftsIndexes": [{"name":format!("{name}_fts"), "columns":["title"], "tokenize":"unicode61"}]
        })))});
        let mut incremental =
            SyncClient::new("pending".into(), &schema, ClientLimits::default()).unwrap();
        let mut reference =
            SyncClient::new("pending".into(), &schema, ClientLimits::default()).unwrap();
        let tables = vec!["tasks".to_owned(), "notes".to_owned()];
        for instance in [&mut incremental, &mut reference] {
            for table in &tables {
                for index in 0..12 {
                    instance
                        .write_base_row(
                            table,
                            &vec![
                                Some(ColumnValue::String(format!("row{index}"))),
                                Some(ColumnValue::String("p0".into())),
                                Some(ColumnValue::String(format!("base{index}"))),
                            ],
                            1,
                        )
                        .unwrap();
                }
            }
            instance
                .rebuild_overlay_if_dirty()
                .expect("rebuild overlay");
        }
        for index in 0..80 {
            let mutations = (0..3)
                .map(|offset| {
                    let table = tables[(index + offset) % 2].clone();
                    let id = format!("row{}", (index + offset) % 16);
                    if (index + offset) % 7 == 0 {
                        Mutation::Delete {
                            table,
                            row_id: id,
                            base_version: None,
                        }
                    } else {
                        Mutation::Upsert {
                            table,
                            values: Map::from_iter([
                                ("id".into(), Value::from(id)),
                                ("project_id".into(), Value::from(format!("p{}", index % 3))),
                                (
                                    "title".into(),
                                    Value::from(format!("needle{}", (index + offset) % 16)),
                                ),
                            ]),
                            base_version: None,
                        }
                    }
                })
                .collect::<Vec<_>>();
            for instance in [&mut incremental, &mut reference] {
                instance.mutate(mutations.clone()).unwrap();
            }
            // Most frames touch only the table without unique constraints.
            // Mixed frames must retain full replay for both tables.
            let changes = (0..3)
                .map(|offset| {
                    let table_index = if index % 4 == 0 { offset % 2 } else { 0 };
                    let id = format!("row{}", (index + offset) % 16);
                    let values = Map::from_iter([
                        ("id".into(), Value::from(id.clone())),
                        (
                            "project_id".into(),
                            Value::from(format!("p{}", (index + 1) % 3)),
                        ),
                        (
                            "title".into(),
                            Value::from(format!("remote{index}_{offset}")),
                        ),
                    ]);
                    ssp2::model::Change {
                        table_index: table_index as u16,
                        row_id: id.clone(),
                        op: if (index + offset) % 5 == 0 {
                            Op::Delete
                        } else {
                            Op::Upsert
                        },
                        row_version: index as i64 + 2,
                        scopes: vec![],
                        row: Some(
                            encode_row_json(
                                incremental.schema.table(&tables[table_index]).unwrap(),
                                &id,
                                &values,
                                &incremental.encryption,
                            )
                            .unwrap(),
                        ),
                    }
                })
                .collect::<Vec<_>>();
            reference.overlay_dirty.set(true);
            incremental
                .apply_commit_frame(&tables, &changes, 0)
                .unwrap();
            reference.apply_commit_frame(&tables, &changes, 0).unwrap();
            for table in &tables {
                for sql in [format!("SELECT * FROM {table} ORDER BY id"),
                    format!("SELECT * FROM _syncular_base_{table} ORDER BY id"),
                    format!("SELECT _syncular_source_id, title FROM {table}_fts ORDER BY _syncular_source_id"),
                    format!("SELECT _syncular_source_id FROM {table}_fts WHERE {table}_fts MATCH 'needle1' ORDER BY _syncular_source_id")] {
                    assert_eq!(incremental.query(&sql, &[]).unwrap(), reference.query(&sql, &[]).unwrap(), "unique={unique}, frame={index}: {sql}");
                }
            }
            assert_eq!(
                incremental.local_revision().unwrap(),
                reference.local_revision().unwrap()
            );
            assert_eq!(
                serde_json::to_value(incremental.drain_change_batches()).unwrap(),
                serde_json::to_value(reference.drain_change_batches()).unwrap()
            );
        }
        assert_eq!(
            incremental.overlay_rebuild_count.get(),
            if unique { 81 } else { 21 }
        );
        assert_eq!(reference.overlay_rebuild_count.get(), 81);
    }
}

#[test]
fn remote_unique_values_reconsider_pending_writes_on_other_rows() {
    let schema = json!({"version": 1, "tables": [{"name":"tasks", "primaryKey":"id",
        "columns":[{"name":"id", "type":"string", "nullable":false},
            {"name":"title", "type":"string", "nullable":false}],
        "scopes":[], "indexes":[{"name":"unique_title", "columns":["title"], "unique":true}]}]});
    let mut client =
        SyncClient::new("unique-pending".into(), &schema, ClientLimits::default()).unwrap();
    for (id, title) in [("a", "original"), ("b", "occupied")] {
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String(id.into())),
                    Some(ColumnValue::String(title.into())),
                ],
                1,
            )
            .unwrap();
    }
    client.rebuild_overlay_if_dirty().expect("rebuild overlay");
    let pending = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), Value::from("a")),
                ("title".into(), Value::from("available")),
            ]),
            base_version: None,
        }])
        .unwrap();
    assert_eq!(
        client
            .conn
            .query_row("SELECT title FROM tasks WHERE id = 'a'", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "available"
    );
    for (row_version, title, expected) in
        [(2, "available", "original"), (3, "occupied", "available")]
    {
        let change = ssp2::model::Change {
            table_index: 0,
            row_id: "b".into(),
            op: Op::Upsert,
            row_version,
            scopes: vec![],
            row: Some(
                encode_row_json(
                    client.schema.table("tasks").unwrap(),
                    "b",
                    &Map::from_iter([
                        ("id".into(), Value::from("b")),
                        ("title".into(), Value::from(title)),
                    ]),
                    &client.encryption,
                )
                .unwrap(),
            ),
        };
        client
            .apply_commit_frame(&["tasks".into()], &[change], 0)
            .unwrap();
        assert_eq!(
            client
                .conn
                .query_row("SELECT title FROM tasks WHERE id = 'a'", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            expected
        );
        assert_eq!(client.pending_commit_ids(), vec![pending.clone()]);
    }
    assert_eq!(client.overlay_rebuild_count.get(), 3);
}

fn measure_scoped_overlay(unchanged_rows: i64, rounds: i64) -> Vec<u128> {
    let schema = json!({ "version": 1, "tables": [
        { "name":"tasks", "primaryKey":"id", "columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}] },
        { "name":"catalogue", "primaryKey":"id", "columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"title","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}],
            "ftsIndexes":[{"name":"catalogue_fts","columns":["title"],"tokenize":"unicode61"}] }
    ] });
    let mut client =
        SyncClient::new("overlay-scope".into(), &schema, ClientLimits::default()).unwrap();
    if unchanged_rows > 0 {
        client.conn.execute_batch(&format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{unchanged_rows}) INSERT INTO _syncular_base_catalogue SELECT 'c'||i,'p1','needle '||i,1 FROM n")).unwrap();
    }
    client.rebuild_overlay().expect("rebuild overlay");
    client.conn.execute_batch("CREATE TABLE audit(tbl TEXT); CREATE TRIGGER catalogue_changed AFTER DELETE ON catalogue BEGIN INSERT INTO audit VALUES ('catalogue'); END;").unwrap();
    let mut elapsed = Vec::new();
    for round in 1..=rounds {
        let pending = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("t1")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let started = std::time::Instant::now();
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("t1".into())),
                    Some(ColumnValue::String("p1".into())),
                ],
                round,
            )
            .unwrap();
        let mut report = SyncReport::default();
        client
            .handle_push_results(
                &[Frame::PushResult {
                    client_commit_id: pending.clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(round),
                    results: vec![OpResult::Applied { op_index: 0 }],
                }],
                &HashSet::from([pending.as_str()]),
                &HashMap::new(),
                &mut report,
                Some(&pending),
            )
            .unwrap();
        client.rebuild_overlay_if_dirty().expect("rebuild overlay");
        elapsed.push(started.elapsed().as_nanos());
    }
    assert_eq!(
        client
            .conn
            .query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0,
        "unchanged catalogue must never be copied"
    );
    assert_eq!(
        client
            .conn
            .query_row(
                "SELECT count(*) FROM catalogue_fts WHERE catalogue_fts MATCH 'needle'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        unchanged_rows
    );
    assert_eq!(
        client
            .query("SELECT _sync_version AS version FROM tasks", &[])
            .unwrap()[0]["version"],
        json!(rounds)
    );
    elapsed
}

#[test]
fn changed_overlay_leaves_large_unchanged_table_and_fts_untouched() {
    let elapsed = measure_scoped_overlay(100_000, 1);
    eprintln!(
        "table-scoped overlay with 100k unchanged rows: {} ns",
        elapsed[0]
    );
}

#[test]
#[ignore = "isolated performance measurement; run with the shared heavy-check lock"]
fn benchmark_scoped_overlay() {
    for rows in [0, 100_000, 200_000] {
        let mut elapsed = measure_scoped_overlay(rows, 30);
        elapsed.sort_unstable();
        eprintln!(
            "{}",
            json!({"unchangedRows": rows, "rounds": elapsed.len(),
            "medianNs": elapsed[elapsed.len()/2], "minNs": elapsed[0],
            "maxNs": elapsed[elapsed.len()-1], "unchangedDeletes": 0})
        );
    }
}

#[test]
fn released_context_discards_in_flight_ack_and_server_rows() {
    for barrier in [
        "preflight",
        "purge",
        "rebootstrap",
        "subscription",
        "failed-purge-replay",
        "failed-purge-publish",
        "failed-rebootstrap",
    ] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
        let unit = client
            .subscribe(UnitScopes::from([("project_id".to_owned(), "p1".into())]))
            .unwrap();
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("local")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let prepared = client.prepare_sync_round(false).unwrap();
        client.set_transport_enabled(&mut CountingRealtimeTransport::default(), false);
        let payload = encode_row_json(
            &client.schema.tables[0],
            "server",
            &Map::from_iter([
                ("id".into(), json!("server")),
                ("project_id".into(), json!("p1")),
            ]),
            &client.encryption,
        )
        .unwrap();
        let completed = crate::CompletedSyncRound {
            prepared,
            exchange: crate::round::ExchangeResult::Reply {
                transport_failed: false,
                downloads: Default::default(),
                response: Ok(Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames: vec![
                        Frame::RespHeader {
                            required_schema_version: None,
                            latest_schema_version: None,
                            log_epoch: "epoch".into(),
                            reset_required: false,
                        },
                        Frame::PushResult {
                            client_commit_id: commit.clone(),
                            status: PushStatus::Applied,
                            commit_seq: Some(1),
                            results: vec![OpResult::Applied { op_index: 0 }],
                        },
                        Frame::SubStart {
                            id: unit.clone(),
                            status: SubStatus::Active,
                            reason_code: String::new(),
                            bootstrap: true,
                            fenced: Vec::new(),
                        },
                        Frame::SubEnd {
                            next_cursor: 0,
                            bootstrap_state: None,
                        },
                        Frame::LiveStart {
                            status: LiveStatus::Active,
                            reason_code: String::new(),
                        },
                        Frame::Commit {
                            commit_seq: 1,
                            created_at_ms: 0,
                            actor_id: "actor".into(),
                            tables: vec!["tasks".into()],
                            changes: vec![ssp2::model::Change {
                                table_index: 0,
                                row_id: "server".into(),
                                op: Op::Upsert,
                                row_version: 1,
                                scopes: vec![("project_id".into(), "p1".into())],
                                row: Some(payload),
                            }],
                        },
                        Frame::LiveEnd {
                            through_seq: 1,
                            echo_digest: None,
                        },
                    ],
                }),
            },
        };
        match barrier {
            "preflight" => client.begin_security_preflight().unwrap(),
            "purge" => {
                client
                    .purge_local_data(&LocalDataPurgeInput {
                        purge_id: "pending-round".into(),
                        targets: vec![LocalDataPurgeTarget {
                            table: "tasks".into(),
                            selectors: BTreeMap::from([("project_id".into(), vec!["p1".into()])]),
                        }],
                    })
                    .unwrap();
            }
            "rebootstrap" => {
                client
                    .rebootstrap_local_data(&LocalDataRebootstrapInput {
                        rebootstrap_id: "pending-round".into(),
                    })
                    .unwrap();
            }
            "failed-purge-replay" | "failed-purge-publish" | "failed-rebootstrap" => {
                let trigger = if barrier == "failed-purge-replay" {
                    "CREATE TRIGGER fail_local BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'local fault'); END"
                } else {
                    "CREATE TRIGGER fail_local BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(ABORT, 'local fault'); END"
                };
                client.conn.execute_batch(trigger).unwrap();
                let revision = client.local_revision().unwrap();
                if barrier == "failed-rebootstrap" {
                    assert!(client
                        .rebootstrap_local_data(&LocalDataRebootstrapInput {
                            rebootstrap_id: "failed-round".into(),
                        })
                        .is_err());
                } else {
                    assert!(client
                        .purge_local_data(&LocalDataPurgeInput {
                            purge_id: "failed-round".into(),
                            targets: vec![LocalDataPurgeTarget {
                                table: "tasks".into(),
                                selectors: BTreeMap::from([(
                                    "project_id".into(),
                                    vec!["p1".into()]
                                )]),
                            }],
                        })
                        .is_err());
                }
                assert_eq!(client.local_revision().unwrap(), revision);
                assert_eq!(client.pending_commit_ids(), vec![commit.clone()]);
                client
                    .conn
                    .execute_batch("DROP TRIGGER fail_local")
                    .unwrap();
                let applied = client.apply_sync_round(completed);
                assert!(
                    matches!(
                        applied,
                        crate::AppliedSyncRound::Complete {
                            outcome: SyncOutcome::Ok(_),
                            ..
                        }
                    ),
                    "{barrier}"
                );
                assert!(client.pending_commit_ids().is_empty());
                assert_eq!(
                    client
                        .query("SELECT id FROM tasks WHERE id = 'server'", &[])
                        .unwrap()
                        .len(),
                    1
                );
                continue;
            }
            "subscription" => {
                client.unsubscribe(&unit).unwrap();
                client
                    .subscribe(UnitScopes::from([("project_id".to_owned(), "p2".into())]))
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let pending_before_reply = client.pending_commit_ids();
        let revision = client.local_revision().unwrap();
        let applied = client.apply_sync_round(completed);
        assert!(
            matches!(applied, crate::AppliedSyncRound::Complete { outcome: SyncOutcome::Failed { ref error_code, .. }, ref controls, .. } if error_code == "client.round_cancelled" && controls.is_empty())
        );
        assert_eq!(client.local_revision().unwrap(), revision);
        assert!(client
            .conn
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM tasks WHERE id='server')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert_eq!(client.pending_commit_ids(), pending_before_reply);
    }
}

#[test]
fn sync_round_deadline_is_anchored_once_per_round_and_carried_across_continues() {
    struct DeadlineRecording {
        budget: std::time::Duration,
        seen: Vec<Option<std::time::Instant>>,
    }
    impl Transport for DeadlineRecording {
        fn round_deadline(&self) -> Option<std::time::Duration> {
            Some(self.budget)
        }
        fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
            self.seen.push(deadline);
        }
        fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("transport.failed", "injected"))
        }
        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.sync(request)
        }
        fn download_segment(
            &mut self,
            _: &SegmentRequest,
            _: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("transport.failed", "injected"))
        }
        fn blob_upload_grant(
            &mut self,
            _: &str,
            _: u64,
            _: Option<&str>,
        ) -> Result<crate::BlobUploadGrant, TransportError> {
            Ok(crate::BlobUploadGrant::Present)
        }
        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_send(&mut self, _: &str) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    let mut client = SyncClient::new("deadline-round".into(), &schema, Default::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
    client
        .upload_blob(b"pending upload", Some("text/plain".into()), None)
        .unwrap();

    let mut transport = DeadlineRecording {
        budget: std::time::Duration::from_secs(30),
        seen: Vec::new(),
    };
    let prepared = client.prepare_sync_round(false).unwrap();
    assert_eq!(prepared.uploads.len(), 1, "one staged upload");
    // Upload exchange -> Continue (the pin removal is persisted by apply).
    let prepared = match client.apply_sync_round(prepared.exchange(&mut transport)) {
        crate::AppliedSyncRound::Continue(prepared) => prepared,
        crate::AppliedSyncRound::Complete { .. } => panic!("the upload must continue"),
    };
    // Main request exchange -> Complete.
    let completed = prepared.exchange(&mut transport);
    let anchor = completed
        .prepared
        .round_deadline_at
        .expect("the upload round anchors a deadline");
    assert!(matches!(
        client.apply_sync_round(completed),
        crate::AppliedSyncRound::Complete { .. }
    ));
    assert_eq!(transport.seen.len(), 4, "one scope per exchange");
    assert_eq!(
        transport.seen[0],
        Some(anchor),
        "the upload anchors the round"
    );
    assert_eq!(
        transport.seen[1], None,
        "the upload exchange clears its scope"
    );
    assert_eq!(
        transport.seen[2],
        Some(anchor),
        "a continuation reuses the carried anchor instead of refreshing it"
    );
    assert_eq!(transport.seen[3], None, "the continuation clears its scope");

    // A fresh round anchors a new deadline from the transport's (now larger)
    // budget and never inherits the old one; the clock granule is irrelevant.
    transport.budget = std::time::Duration::from_secs(60);
    let prepared = client.prepare_sync_round(false).unwrap();
    let completed = prepared.exchange(&mut transport);
    let fresh = completed
        .prepared
        .round_deadline_at
        .expect("the next round anchors a deadline");
    client.apply_sync_round(completed);
    assert!(
        fresh >= anchor + std::time::Duration::from_secs(30),
        "the next round anchors a fresh deadline from the new budget"
    );
    assert_eq!(transport.seen[4], Some(fresh));
    assert_eq!(
        transport.seen[5], None,
        "the new round clears its scope too"
    );
}

/// Records the round-deadline traffic so a test can prove whether a round
/// asked for a budget and whether it ever scoped an anchor.
#[derive(Default)]
struct RoundDeadlineProbe {
    budget: Option<std::time::Duration>,
    budget_queries: std::cell::Cell<usize>,
    scoped: Vec<Option<std::time::Instant>>,
}

impl Transport for RoundDeadlineProbe {
    fn round_deadline(&self) -> Option<std::time::Duration> {
        self.budget_queries.set(self.budget_queries.get() + 1);
        self.budget
    }
    fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
        self.scoped.push(deadline);
    }
    fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("transport.failed", "injected"))
    }
    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }
    fn download_segment(
        &mut self,
        _: &SegmentRequest,
        _: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("transport.failed", "injected"))
    }
    fn blob_upload_grant(
        &mut self,
        _: &str,
        _: u64,
        _: Option<&str>,
    ) -> Result<crate::BlobUploadGrant, TransportError> {
        Ok(crate::BlobUploadGrant::Present)
    }
    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
    fn realtime_send(&mut self, _: &str) -> Result<(), TransportError> {
        Ok(())
    }
    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

#[test]
fn an_unusable_upload_body_does_not_anchor_the_round_deadline() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
    let mut client =
        SyncClient::new("deadline-unusable".into(), &schema, ClientLimits::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
    client
        .upload_blob(b"pending upload", Some("text/plain".into()), None)
        .unwrap();
    client
        .conn
        .execute_batch("DELETE FROM _syncular_blobs")
        .unwrap();
    let prepared = client.prepare_sync_round(false).unwrap();
    assert!(
        prepared.uploads.front().is_some_and(|u| u.bytes.is_err()),
        "the staged body must fail locally"
    );
    let mut transport = RoundDeadlineProbe {
        budget: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    };
    let completed = prepared.exchange(&mut transport);
    assert!(matches!(
        completed.exchange,
        crate::round::ExchangeResult::Upload { result: Err(_), .. }
    ));
    assert_eq!(
        transport.budget_queries.get(),
        0,
        "a round with no network work never asks for a budget"
    );
    assert_eq!(transport.scoped, vec![None]);
}

#[test]
fn a_transport_budget_the_clock_cannot_represent_fails_before_network() {
    struct HugeBudget;
    impl Transport for HugeBudget {
        fn round_deadline(&self) -> Option<std::time::Duration> {
            Some(std::time::Duration::MAX)
        }
        fn sync(&mut self, _: &[u8]) -> Result<Vec<u8>, TransportError> {
            panic!("no network for an invalid budget")
        }
        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.sync(request)
        }
        fn download_segment(
            &mut self,
            _: &SegmentRequest,
            _: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            panic!("no network for an invalid budget")
        }
        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_send(&mut self, _: &str) -> Result<(), TransportError> {
            Ok(())
        }
        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
    let prepared = client.prepare_sync_round(false).unwrap();
    let outcome = match client.apply_sync_round(prepared.exchange(&mut HugeBudget)) {
        crate::AppliedSyncRound::Complete { outcome, .. } => outcome,
        crate::AppliedSyncRound::Continue(_) => {
            panic!("an unrepresentable budget must not continue")
        }
    };
    match outcome {
        SyncOutcome::Failed {
            error_code,
            message,
            ..
        } => {
            assert_eq!(error_code, "sync.invalid_request");
            assert_eq!(message, "transport round deadline is out of range");
        }
        _ => panic!("an unrepresentable budget must fail synchronously"),
    }
}

#[test]
fn pending_row_reconciliation_failure_preserves_queue_and_frame_state() {
    for failure in ["visible", "revision", "commit"] {
        let mut client = client();
        let id = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), Value::from("t1")),
                    ("project_id".into(), Value::from("pending")),
                ]),
                base_version: None,
            }])
            .unwrap();
        client.drain_change_batches();
        let revision = client.local_revision().unwrap();
        let before = client.query("SELECT * FROM tasks", &[]).unwrap();
        let trigger = match failure {
            "visible" => "CREATE TRIGGER fail_pending BEFORE INSERT ON tasks WHEN NEW.project_id = 'remote' BEGIN SELECT RAISE(ABORT, 'injected visible failure'); END".to_owned(),
            "revision" => format!("CREATE TRIGGER fail_pending BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{LOCAL_REVISION_KEY}' BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END"),
            _ => "PRAGMA foreign_keys = ON; CREATE TABLE pending_parent(id INTEGER PRIMARY KEY); CREATE TABLE pending_child(id INTEGER REFERENCES pending_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_pending AFTER INSERT ON _syncular_base_tasks BEGIN INSERT INTO pending_child VALUES(1); END".to_owned(),
        };
        client.conn.execute_batch(&trigger).unwrap();
        let change = ssp2::model::Change {
            table_index: 0,
            row_id: "t1".into(),
            op: Op::Upsert,
            row_version: 2,
            scopes: vec![],
            row: Some(
                encode_row_json(
                    client.schema.table("tasks").unwrap(),
                    "t1",
                    &Map::from_iter([
                        ("id".into(), Value::from("t1")),
                        ("project_id".into(), Value::from("remote")),
                    ]),
                    &client.encryption,
                )
                .unwrap(),
            ),
        };
        assert!(client
            .apply_commit_frame(&["tasks".into()], std::slice::from_ref(&change), 0)
            .is_err());
        assert!(client.conn.is_autocommit());
        assert!(!client.overlay_dirty.get());
        assert_eq!(client.local_revision().unwrap(), revision);
        assert!(client.drain_change_batches().is_empty());
        assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), before);
        assert!(client
            .query("SELECT * FROM _syncular_base_tasks", &[])
            .unwrap()
            .is_empty());
        client
            .conn
            .execute_batch("DROP TRIGGER fail_pending")
            .unwrap();
        client
            .apply_commit_frame(&["tasks".into()], &[change], 0)
            .unwrap();
        assert_eq!(client.local_revision().unwrap(), revision + 1);
        assert_eq!(client.pending_commit_ids(), vec![id]);
        // The overlay keeps the pending write visible; the row now carries
        // the server row's version it is layered on (§7.1).
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), before);
        assert_eq!(
            client
                .query("SELECT _sync_version AS version FROM tasks", &[])
                .unwrap()[0]["version"],
            json!(2)
        );
        assert_eq!(
            client
                .conn
                .query_row("SELECT project_id FROM _syncular_base_tasks", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "remote"
        );
    }
}

#[test]
fn appended_overlay_matches_full_fifo_replay_with_constraints_and_fts() {
    let schema = json!({"version": 1, "tables": [{"name": "tasks", "primaryKey": "id",
        "columns": [
            {"name":"id", "type":"string", "nullable":false},
            {"name":"project_id", "type":"string", "nullable":false},
            {"name":"title", "type":"string", "nullable":false}],
        "scopes": [{"pattern":"project:{project_id}"}],
        "indexes": [{"name":"unique_title", "columns":["title"], "unique":true}],
        "ftsIndexes": [{"name":"tasks_fts", "columns":["title"], "tokenize":"unicode61"}]}]});
    let mut incremental =
        SyncClient::new("append".to_owned(), &schema, ClientLimits::default()).unwrap();
    let mut reference =
        SyncClient::new("append".to_owned(), &schema, ClientLimits::default()).unwrap();
    for instance in [&mut incremental, &mut reference] {
        for index in 0..16 {
            instance
                .write_base_row(
                    "tasks",
                    &vec![
                        Some(ColumnValue::String(format!("task{index}"))),
                        Some(ColumnValue::String("p0".to_owned())),
                        Some(ColumnValue::String(format!("base{index}"))),
                    ],
                    1,
                )
                .unwrap();
        }
        instance
            .rebuild_overlay_if_dirty()
            .expect("rebuild overlay");
        instance.overlay_rebuild_count.set(0);
    }
    for index in 0..100 {
        let mutations = (0..1 + index % 4)
            .map(|offset| {
                let id = format!("task{}", (index + offset) % 24);
                if (index + offset) % 7 == 0 {
                    Mutation::Delete {
                        table: "tasks".to_owned(),
                        row_id: id,
                        base_version: None,
                    }
                } else {
                    Mutation::Upsert {
                        table: "tasks".to_owned(),
                        values: Map::from_iter([
                            ("id".to_owned(), Value::from(id)),
                            (
                                "project_id".to_owned(),
                                Value::from(format!("p{}", index % 2)),
                            ),
                            (
                                "title".to_owned(),
                                Value::from(format!("needle{}", (index + offset) % 24)),
                            ),
                        ]),
                        base_version: None,
                    }
                }
            })
            .collect::<Vec<_>>();
        reference.overlay_dirty.set(true);
        incremental.mutate(mutations.clone()).unwrap();
        reference.mutate(mutations).unwrap();
        for sql in ["SELECT * FROM tasks ORDER BY id", "SELECT _syncular_source_id, title FROM tasks_fts ORDER BY _syncular_source_id",
            "SELECT _syncular_source_id FROM tasks_fts WHERE tasks_fts MATCH 'needle1' ORDER BY _syncular_source_id"] {
            assert_eq!(incremental.query(sql, &[]).unwrap(), reference.query(sql, &[]).unwrap(), "commit {index}: {sql}");
        }
        assert_eq!(
            incremental.local_revision().unwrap(),
            reference.local_revision().unwrap()
        );
        assert_eq!(
            serde_json::to_value(incremental.drain_change_batches()).unwrap(),
            serde_json::to_value(reference.drain_change_batches()).unwrap()
        );
    }
    assert_eq!(incremental.outbox.len(), 100);
    assert_eq!(incremental.overlay_rebuild_count.get(), 0);
    assert_eq!(reference.overlay_rebuild_count.get(), 100);
}

#[test]
fn failed_append_rolls_back_durable_queue_visible_rows_and_memory() {
    for fail_at in ["outbox", "revision"] {
        let mut client = client();
        let values = Map::from_iter([
            ("id".to_owned(), Value::from("t1")),
            ("project_id".to_owned(), Value::from("p1")),
        ]);
        let mutation = Mutation::Upsert {
            table: "tasks".to_owned(),
            values,
            base_version: None,
        };
        let trigger = if fail_at == "outbox" {
            "CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_outbox BEGIN SELECT RAISE(FAIL, 'injected outbox failure'); END".to_owned()
        } else {
            format!("CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{LOCAL_REVISION_KEY}' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END")
        };
        client.conn.execute_batch(&trigger).unwrap();
        let revision = client.local_revision().unwrap();
        assert!(client.mutate(vec![mutation.clone()]).is_err(), "{fail_at}");
        assert_eq!(client.local_revision().unwrap(), revision);
        assert!(client.outbox.is_empty());
        assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(client.drain_change_batches().is_empty());
        assert!(!client.overlay_dirty.get());
        client
            .conn
            .execute_batch("DROP TRIGGER fail_append")
            .unwrap();
        client.mutate(vec![mutation]).unwrap();
        assert_eq!(client.outbox.len(), 1);
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap().len(), 1);
    }
}

#[test]
fn mirrored_commit_failure_rolls_back_base_visible_and_revision() {
    let mut client = client();
    let tables = vec!["tasks".to_owned(), "missing".to_owned()];
    let values = Map::from_iter([
        ("id".to_owned(), Value::from("t1")),
        ("project_id".to_owned(), Value::from("p1")),
    ]);
    let payload = encode_row_json(
        client.schema.table("tasks").unwrap(),
        "t1",
        &values,
        &client.encryption,
    )
    .unwrap();
    let first = ssp2::model::Change {
        table_index: 0,
        row_id: "t1".to_owned(),
        op: Op::Upsert,
        row_version: 1,
        scopes: vec![("project_id".to_owned(), "p1".to_owned())],
        row: Some(payload),
    };
    let mut invalid = first.clone();
    invalid.table_index = 1;
    let revision = client.local_revision().unwrap();
    client.begin_observation("failed_mirror").unwrap();
    assert!(client
        .apply_commit_changes(&tables, &[first, invalid])
        .is_err());
    client.rollback_observation("failed_mirror");
    client.rebuild_overlay_if_dirty().expect("rebuild overlay");
    assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
    assert_eq!(
        client
            .conn
            .query_row("SELECT count(*) FROM _syncular_base_tasks", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(client.local_revision().unwrap(), revision);
    assert!(client.drain_change_batches().is_empty());
}

#[test]
fn successful_acknowledgement_runs_are_atomic_and_preserve_completed_runs() {
    for failure in ["journal", "revision", "commit", "later-frame"] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        for id in ["first", "second"] {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), Value::from(id)),
                        ("project_id".to_owned(), Value::from("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
        }
        let (_, meta) = client.build_request(false).unwrap();
        // A malicious or stale response must not drain an unsent local commit.
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("later")),
                    ("project_id".to_owned(), Value::from("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let ids = client.pending_commit_ids();
        let rows = client
            .query("SELECT * FROM tasks ORDER BY id", &[])
            .unwrap();
        let revision = client.local_revision().unwrap();
        client.drain_change_batches();
        if failure != "later-frame" {
            client.conn.execute_batch(match failure {
                "journal" => "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 1 BEGIN SELECT RAISE(FAIL, 'injected second journal failure'); END",
                "revision" => "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN SELECT RAISE(FAIL, 'injected run revision failure'); END",
                _ => "PRAGMA foreign_keys = ON; CREATE TABLE ack_parent(id INTEGER PRIMARY KEY); CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_run AFTER INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN INSERT INTO ack_child VALUES (1); END",
            }).unwrap();
        }
        let mut response = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".to_owned(),
                reset_required: false,
            }],
        };
        for id in [&ids[0], &ids[0], "unknown", &ids[1], &ids[2]] {
            response.frames.push(Frame::PushResult {
                client_commit_id: id.to_owned(),
                status: PushStatus::Applied,
                commit_seq: Some(1),
                results: vec![OpResult::Applied { op_index: 0 }],
            });
        }
        if failure == "later-frame" {
            response.frames.push(Frame::Error {
                code: "sync.invalid_request".to_owned(),
                message: "later error".to_owned(),
                category: "protocol".to_owned(),
                retryable: false,
                recommended_action: "retry".to_owned(),
                details: None,
            });
        }
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        let outcome = client.process_response(&mut transport, response.clone(), &meta);
        // §1.4 rule 4: the deferred foreign key of "commit" fails the
        // response's coalesced COMMIT instead of the run's RELEASE.
        let expected = match failure {
            "later-frame" => "sync.invalid_request",
            "commit" => "storage.failed",
            _ => "client.outcome_persistence_failed",
        };
        assert!(
            matches!(&outcome, SyncOutcome::Failed { error_code, .. } if error_code == expected),
            "{failure}: {outcome:?}"
        );
        if failure == "later-frame" {
            assert_eq!(client.pending_commit_ids(), ids[2..]);
            assert!(client.commit_outcome(&ids[0]).unwrap().is_some());
            assert!(client.commit_outcome(&ids[1]).unwrap().is_some());
            let batches = client.drain_change_batches();
            assert_eq!(batches.len(), 1);
            assert_eq!(batches[0].status.as_ref().unwrap().outbox, 1);
            assert_eq!(client.local_revision().unwrap(), revision + 1);
            response.frames.pop();
        } else {
            assert_eq!(client.pending_commit_ids(), ids);
            assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
            assert!(client.commit_outcome(&ids[1]).unwrap().is_none());
            assert_eq!(client.local_revision().unwrap(), revision);
            assert!(client.drain_change_batches().is_empty());
            assert_eq!(
                client
                    .query("SELECT * FROM tasks ORDER BY id", &[])
                    .unwrap(),
                rows
            );
            client.conn.execute_batch("DROP TRIGGER fail_run").unwrap();
        }
        for frame in &mut response.frames {
            if let Frame::PushResult { status, .. } = frame {
                *status = PushStatus::Cached;
            }
        }
        let SyncOutcome::Ok(report) = client.process_response(&mut transport, response, &meta)
        else {
            panic!("retry failed");
        };
        assert_eq!(
            report.applied,
            if failure == "later-frame" {
                vec![]
            } else {
                ids[..2].to_vec()
            }
        );
        assert_eq!(client.pending_commit_ids(), ids[2..]);
        let batches = client.drain_change_batches();
        assert_eq!(batches.len(), usize::from(failure != "later-frame"));
        if let Some(batch) = batches.first() {
            assert_eq!(batch.status.as_ref().unwrap().outbox, 1);
        }
        assert_eq!(client.local_revision().unwrap(), revision + 1);
    }
}

#[test]
fn failed_push_result_preserves_memory_disk_and_retry_identity() {
    for failure in ["revision", "journal", "commit"] {
        for status in ["applied", "cached", "rejected", "conflict"] {
            let mut client = client();
            client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
            for id in ["first", "later"] {
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "tasks".to_owned(),
                        values: Map::from_iter([
                            ("id".to_owned(), Value::from(id)),
                            ("project_id".to_owned(), Value::from("p1")),
                        ]),
                        base_version: None,
                    }])
                    .unwrap();
            }
            let (_, meta) = client.build_request(false).unwrap();
            let ids = client.pending_commit_ids();
            let rows = client
                .query("SELECT * FROM tasks ORDER BY id", &[])
                .unwrap();
            let revision = client.local_revision().unwrap();
            client.drain_change_batches();
            let (push_status, results) = match status {
                "applied" => (PushStatus::Applied, vec![OpResult::Applied { op_index: 0 }]),
                "cached" => (PushStatus::Cached, vec![OpResult::Applied { op_index: 0 }]),
                "conflict" => (
                    PushStatus::Rejected,
                    vec![OpResult::Conflict {
                        op_index: 0,
                        code: "sync.version_conflict".to_owned(),
                        message: "conflict".to_owned(),
                        server_version: 1,
                        server_row: encode_row_json(
                            client.schema.table("tasks").unwrap(),
                            "first",
                            &Map::from_iter([
                                ("id".to_owned(), Value::from("first")),
                                ("project_id".to_owned(), Value::from("p1")),
                            ]),
                            &client.encryption,
                        )
                        .unwrap(),
                        conflict_columns: Vec::new(),
                    }],
                ),
                _ => (
                    PushStatus::Rejected,
                    vec![OpResult::Error {
                        op_index: 0,
                        code: "sync.validation_failed".to_owned(),
                        message: "rejected".to_owned(),
                        retryable: false,
                    }],
                ),
            };
            let response = Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![
                    Frame::RespHeader {
                        required_schema_version: None,
                        latest_schema_version: None,
                        log_epoch: "epoch-1".to_owned(),
                        reset_required: false,
                    },
                    Frame::PushResult {
                        client_commit_id: ids[0].clone(),
                        status: push_status,
                        commit_seq: Some(1),
                        results,
                    },
                    Frame::LiveStart {
                        status: LiveStatus::Active,
                        reason_code: String::new(),
                    },
                    Frame::LiveEnd {
                        through_seq: 1,
                        echo_digest: None,
                    },
                ],
            };
            client.conn.execute_batch(match failure {
                "journal" => "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(FAIL, 'injected journal failure'); END",
                "revision" => "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END",
                _ => "PRAGMA foreign_keys = ON; CREATE TABLE ack_parent(id INTEGER PRIMARY KEY); CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_ack AFTER INSERT ON _syncular_commit_outcomes BEGIN INSERT INTO ack_child VALUES (1); END",
            }).unwrap();
            let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
            let outcome = client.process_response(&mut transport, response.clone(), &meta);
            assert_eq!(
                client.pending_commit_ids(),
                ids,
                "{failure}/{status}: pending identity"
            );
            assert_eq!(
                client.local_revision().unwrap(),
                revision,
                "{failure}/{status}: revision"
            );
            assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
            assert!(client.conflicts().is_empty());
            assert!(client.rejections().is_empty());
            assert!(client.drain_change_batches().is_empty());
            assert_eq!(
                client
                    .query("SELECT * FROM tasks ORDER BY id", &[])
                    .unwrap(),
                rows
            );
            // §1.4 rule 4: the deferred foreign key of "commit" fails the
            // response's coalesced COMMIT instead of the result's RELEASE.
            let expected = if failure == "commit" {
                "storage.failed"
            } else {
                "client.outcome_persistence_failed"
            };
            assert!(
                matches!(&outcome, SyncOutcome::Failed { error_code, .. } if error_code == expected),
                "{failure}/{status}: failed round"
            );
            client.conn.execute_batch("DROP TRIGGER fail_ack").unwrap();
            assert!(matches!(
                client.process_response(&mut transport, response, &meta),
                SyncOutcome::Ok(_)
            ));
            assert_eq!(client.pending_commit_ids(), ids[1..]);
            assert!(client.commit_outcome(&ids[0]).unwrap().is_some());
            assert_eq!(client.drain_change_batches().len(), 1);
        }
    }
}

#[test]
fn mixed_push_results_reconcile_each_boundary_and_prune_once_per_response() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    for index in 0..4 {
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from(format!("task-{index}"))),
                    ("project_id".to_owned(), Value::from("project-1")),
                ]),
                base_version: None,
            }])
            .expect("queue commit");
    }

    let (_, request_meta) = client.build_request(false).unwrap();
    let ids = &request_meta.pushed_ids;
    assert_eq!(ids.len(), 4);
    let response = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".to_owned(),
                reset_required: false,
            },
            Frame::PushResult {
                client_commit_id: ids[0].clone(),
                status: PushStatus::Applied,
                commit_seq: Some(1),
                results: vec![OpResult::Applied { op_index: 0 }],
            },
            Frame::PushResult {
                client_commit_id: ids[1].clone(),
                status: PushStatus::Cached,
                commit_seq: Some(2),
                results: vec![OpResult::Applied { op_index: 0 }],
            },
            Frame::PushResult {
                client_commit_id: ids[2].clone(),
                status: PushStatus::Rejected,
                commit_seq: None,
                results: vec![OpResult::Error {
                    op_index: 0,
                    code: "sync.validation_failed".to_owned(),
                    message: "rejected".to_owned(),
                    retryable: false,
                }],
            },
            Frame::PushResult {
                client_commit_id: ids[3].clone(),
                status: PushStatus::Rejected,
                commit_seq: None,
                results: vec![OpResult::Error {
                    op_index: 0,
                    code: "sync.idempotency_cache_miss".to_owned(),
                    message: "retry".to_owned(),
                    retryable: true,
                }],
            },
        ],
    };
    let mut transport =
        HostTransport::new_from_config(&json!({})).expect("no-network host transport");

    client.overlay_rebuild_count.set(0);
    client.outcome_prune_count.set(0);
    client.drain_change_batches();
    let outcome = client.process_response(&mut transport, response, &request_meta);
    let SyncOutcome::Ok(report) = outcome else {
        panic!("mixed push-result response failed");
    };

    assert_eq!(report.applied, ids[..2]);
    assert_eq!(report.rejected, ids[2..3]);
    assert_eq!(report.retryable, ids[3..4]);
    assert_eq!(client.pending_commit_ids(), ids[3..4]);
    assert_eq!(
        client
            .query("SELECT id FROM tasks ORDER BY id", &[])
            .expect("query visible overlay"),
        ["task-0", "task-1", "task-3"]
            .map(|id| Map::from_iter([("id".to_owned(), Value::from(id))]))
            .to_vec()
    );
    // The successful ACK run and final rejection have distinct durable
    // boundaries, and each reconciles only its drained rows.
    assert_eq!(client.drain_change_batches().len(), 2);
    assert_eq!(client.overlay_rebuild_count.get(), 0);
    assert_eq!(client.outcome_prune_count.get(), 1);
}

fn replay_schema(fts: bool) -> Value {
    json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"title","type":"string","nullable":false},
        {"name":"done","type":"boolean","nullable":false}
    ],"scopes":[{"pattern":"project:{project_id}"}], "ftsIndexes": if fts { json!([{"name":"tasks_fts","columns":["title"],"tokenize":"unicode61"}]) } else { json!([]) }}]})
}

#[test]
fn aborted_schema_and_epoch_resets_restore_memory_and_durable_intent() {
    for schema_reset in [false, true] {
        let mut schema = replay_schema(false);
        let mut client =
            SyncClient::new("reset-failure".into(), &schema, ClientLimits::default()).unwrap();
        let id = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("queued")),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!("old")),
                    ("done".into(), json!(false)),
                ]),
                base_version: None,
            }])
            .unwrap();
        client.set_meta(LOG_EPOCH_KEY, "old").unwrap();
        let revision = client.local_revision().unwrap();
        let needed = client.sync_needed;
        client.drain_change_batches();
        client.drain_sync_intents();
        client.conn.execute_batch("CREATE TRIGGER refuse_revision BEFORE INSERT ON _syncular_meta WHEN NEW.key='localRevision' BEGIN SELECT RAISE(ABORT,'reset completion failed'); END;").unwrap();
        if schema_reset {
            schema["version"] = json!(2);
            schema["tables"][0]["columns"]
                .as_array_mut()
                .unwrap()
                .retain(|column| column["name"] != "title");
            client.schema = parse_schema_json(&schema).unwrap();
            assert!(client.run_schema_reset().is_err());
        } else {
            assert!(client.run_log_epoch_reset("new").is_err());
        }
        assert!(!client.upgrading);
        assert_eq!(client.sync_needed, needed);
        assert_eq!(client.local_revision().unwrap(), revision);
        assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
        assert!(client.rejections.is_empty());
        assert!(client.commit_outcome(&id).unwrap().is_none());
        assert_eq!(
            client.get_meta(LOG_EPOCH_KEY).unwrap().as_deref(),
            Some("old")
        );
        assert_eq!(
            client
                .query("SELECT title FROM tasks WHERE id='queued'", &[])
                .unwrap()[0]["title"],
            "old"
        );
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(client.drain_change_batches().is_empty());
        assert!(client.drain_sync_intents().is_empty());
        assert!(client.conn.is_autocommit());
    }
}

#[test]
fn cached_blob_cleanup_propagates_delete_failures() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"owner_id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],
        "scopes":[{"pattern":"owner:{owner_id}"}]}]});
    let mut client =
        SyncClient::new("blob-cleanup".into(), &schema, ClientLimits::default()).unwrap();
    client.conn.execute_batch("CREATE TRIGGER refuse_blob_cleanup BEFORE DELETE ON _syncular_blobs BEGIN SELECT RAISE(ABORT,'blob cleanup failed'); END;").unwrap();
    client.conn.execute("INSERT INTO _syncular_blobs(blob_id,bytes,byte_length,created_at_ms) VALUES ('test',X'01',1,0)", []).unwrap();
    let id = live_unit(&client, &[("owner_id", "o1")]);
    let revision = client.local_revision().unwrap();
    let (_, meta) = client.build_request(false).unwrap();
    let mut transport = CountingRealtimeTransport::default();
    let mut report = SyncReport::default();
    let revoked = SectionStart {
        id: id.clone(),
        status: SubStatus::Revoked,
        reason_code: "sync.scope_revoked".into(),
        bootstrap: false,
        fenced: Vec::new(),
    };
    assert!(client
        .process_section(
            &mut transport,
            &revoked,
            vec![],
            Some((0, None)),
            &meta,
            &mut report
        )
        .is_err());
    assert_eq!(
        client.unit(&id).unwrap().unwrap().status,
        UnitStatus::Active
    );
    assert_eq!(client.local_revision().unwrap(), revision);
    assert!(report.revoked.is_empty());
    assert!(client.conn.is_autocommit());
    client
        .conn
        .execute_batch("DROP TRIGGER refuse_blob_cleanup")
        .unwrap();
    assert!(client
        .process_section(
            &mut transport,
            &revoked,
            vec![],
            Some((0, None)),
            &meta,
            &mut report
        )
        .is_ok());
    assert_eq!(
        client.unit(&id).unwrap().unwrap().status,
        UnitStatus::Revoked
    );
    assert_eq!(
        client
            .conn
            .query_row("SELECT count(*) FROM _syncular_blobs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn overlay_replay_trigger_refuses_reopen_and_preserves_durable_intent() {
    let path = std::env::temp_dir().join(format!("syncular-replay-{}.db", uuid::Uuid::new_v4()));
    let schema = replay_schema(false);
    let mut client = SyncClient::open_path(
        "replay".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    let ids = ["early", "bad"].map(|id| {
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!(id)),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!(id)),
                    ("done".into(), json!(false)),
                ]),
                base_version: None,
            }])
            .unwrap()
    });
    client.conn.execute_batch("DELETE FROM tasks; CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='bad' BEGIN SELECT RAISE(ABORT,'replay failed'); END;").unwrap();
    let revision = client.local_revision().unwrap();
    drop(client);
    let error = SyncClient::open_path(
        "replay".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .err()
    .expect("reopen must fail");
    assert!(error.contains("replay failed"));
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        meta_get(&conn, LOCAL_REVISION_KEY).unwrap(),
        Some(revision.to_string())
    );
    conn.execute_batch("DROP TRIGGER fail_replay").unwrap();
    drop(conn);
    let reopened = SyncClient::open_path(
        "replay".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(reopened.pending_commit_ids(), ids);
    assert_eq!(
        reopened
            .query("SELECT id FROM tasks ORDER BY id", &[])
            .unwrap()
            .len(),
        2
    );
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn overlay_replay_failure_rolls_back_push_and_pull_apply_boundaries() {
    let schema = replay_schema(false);
    let mut client = SyncClient::new("replay".into(), &schema, ClientLimits::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
        .write_base_row(
            "tasks",
            &vec![
                Some(ColumnValue::String("queued".into())),
                Some(ColumnValue::String("p1".into())),
                Some(ColumnValue::String("server".into())),
                Some(ColumnValue::Boolean(false)),
            ],
            1,
        )
        .unwrap();
    client.rebuild_overlay().unwrap();
    let id = client
        .patch(
            "tasks",
            "queued",
            Map::from_iter([("title".into(), json!("local"))]),
            Some(1),
        )
        .unwrap();
    let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
    let base = client
        .query("SELECT * FROM _syncular_base_tasks", &[])
        .unwrap();
    let revision = client.local_revision().unwrap();
    client.drain_change_batches();
    client.conn.execute_batch("CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.title='local' BEGIN SELECT RAISE(ABORT,'replay failed'); END").unwrap();
    let remote = vec![
        Some(ColumnValue::String("queued".into())),
        Some(ColumnValue::String("p1".into())),
        Some(ColumnValue::String("remote".into())),
        Some(ColumnValue::Boolean(false)),
    ];
    let bytes = crate::values::encode_row_json(
        client.schema.table("tasks").unwrap(),
        "queued",
        &Map::from_iter(
            client
                .schema
                .table("tasks")
                .unwrap()
                .columns
                .iter()
                .zip(&remote)
                .map(|(column, value)| (column.name.clone(), column_value_to_json(value))),
        ),
        &client.encryption,
    )
    .unwrap();
    let change = ssp2::model::Change {
        table_index: 0,
        op: Op::Upsert,
        row_id: "queued".into(),
        row_version: 2,
        scopes: vec![("project_id".into(), "p1".into())],
        row: Some(bytes),
    };
    assert!(client
        .apply_commit_frame(&["tasks".into()], std::slice::from_ref(&change), 2)
        .is_err());
    assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
    assert_eq!(
        client
            .query("SELECT * FROM _syncular_base_tasks", &[])
            .unwrap(),
        base
    );
    assert_eq!(client.local_revision().unwrap(), revision);
    assert!(client.drain_change_batches().is_empty());
    let response = Message {
        wire_version: 2,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".into(),
                reset_required: false,
            },
            Frame::PushResult {
                client_commit_id: id.clone(),
                status: PushStatus::Applied,
                commit_seq: Some(2),
                results: vec![OpResult::Applied { op_index: 0 }],
            },
        ],
    };
    let (_, meta) = client.build_request(false).unwrap();
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    assert!(
        matches!(client.process_response(&mut transport,response.clone(),&meta),SyncOutcome::Failed { error_code,.. } if error_code=="client.outcome_persistence_failed")
    );
    assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
    assert!(client.commit_outcome(&id).unwrap().is_none());
    assert_eq!(
        client
            .conn
            .query_row("SELECT count(*) FROM _syncular_acked_rows", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(
        client
            .conn
            .query_row("SELECT count(*) FROM _syncular_row_deliveries", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
    assert_eq!(client.local_revision().unwrap(), revision);
    assert!(client.drain_change_batches().is_empty());
    client
        .conn
        .execute_batch("DROP TRIGGER fail_replay")
        .unwrap();
    assert!(matches!(
        client.process_response(&mut transport, response, &meta),
        SyncOutcome::Ok(_)
    ));
    client
        .apply_commit_frame(&["tasks".into()], &[change], 2)
        .unwrap();
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(
        client.query("SELECT title FROM tasks", &[]).unwrap()[0]["title"],
        json!("remote")
    );
}

#[test]
fn overlay_replay_distinguishes_absence_from_sql_and_value_decode_errors() {
    let client = SyncClient::new(
        "replay".into(),
        &replay_schema(false),
        ClientLimits::default(),
    )
    .unwrap();
    let table = client.schema.table("tasks").unwrap();
    let patch = OutboxOp {
        table: "tasks".into(),
        row_id: "absent".into(),
        upsert: true,
        insert: false,
        base_version: Some(1),
        values: Some(Map::from_iter([
            ("id".into(), json!("absent")),
            ("title".into(), json!("patch")),
        ])),
    };
    assert!(client.visible_row(table, "absent").unwrap().is_none());
    client
        .apply_outbox_ops([&patch])
        .expect("sparse replay over truly absent row");
    client
        .conn
        .execute_batch("INSERT INTO tasks VALUES ('bad','p1','title','invalid',1)")
        .unwrap();
    assert!(client
        .visible_row(table, "bad")
        .unwrap_err()
        .starts_with("sync.local_corrupt:"));
    let mut invalid = patch.clone();
    invalid.values = Some(Map::from_iter([
        ("id".into(), json!("bad-value")),
        ("project_id".into(), json!("p1")),
        ("title".into(), json!("title")),
        ("done".into(), json!({"bad":true})),
    ]));
    assert!(client
        .apply_outbox_ops([&invalid])
        .unwrap_err()
        .starts_with("sync.local_corrupt:"));
    client.conn.execute_batch("DROP TABLE tasks").unwrap();
    assert!(
        client.apply_outbox_ops([&patch]).is_err(),
        "SQL failure must not count as absence"
    );
}

#[test]
fn overlay_replay_keeps_secondary_unique_deferral_and_lazy_base_precedence() {
    let mut schema = replay_schema(false);
    schema["tables"][0]["indexes"] =
        json!([{"name":"tasks_project_title", "columns":["project_id","title"],"unique":true}]);
    let mut client = SyncClient::new("replay".into(), &schema, ClientLimits::default()).unwrap();
    let id = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("queued")),
                ("project_id".into(), json!("p1")),
                ("title".into(), json!("occupied")),
                ("done".into(), json!(false)),
            ]),
            base_version: None,
        }])
        .unwrap();
    client
        .write_base_row(
            "tasks",
            &vec![
                Some(ColumnValue::String("server".into())),
                Some(ColumnValue::String("p1".into())),
                Some(ColumnValue::String("occupied".into())),
                Some(ColumnValue::Boolean(false)),
            ],
            1,
        )
        .unwrap();
    client.rebuild_overlay_if_dirty().unwrap();
    assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
    assert!(client
        .visible_row(client.schema.table("tasks").unwrap(), "queued")
        .unwrap()
        .is_none());
    assert!(client.rejections().is_empty());
    client.delete_base_row("tasks", "server", i64::MAX).unwrap();
    client.rebuild_overlay_if_dirty().unwrap();
    assert!(client
        .visible_row(client.schema.table("tasks").unwrap(), "queued")
        .unwrap()
        .is_some());
    client
        .write_base_row(
            "tasks",
            &vec![
                Some(ColumnValue::String("base".into())),
                Some(ColumnValue::String("p1".into())),
                Some(ColumnValue::String("base-title".into())),
                Some(ColumnValue::Boolean(false)),
            ],
            1,
        )
        .unwrap();
    client.conn.execute_batch("DROP TABLE tasks").unwrap();
    client
        .retain_failed_commit(
            "retained",
            &[OutboxOp {
                table: "tasks".into(),
                row_id: "base".into(),
                upsert: true,
                insert: false,
                base_version: Some(1),
                values: Some(Map::from_iter([
                    ("id".into(), json!("base")),
                    ("title".into(), json!("patch")),
                ])),
            }],
        )
        .expect("an existing base must not read the unavailable visible table");
}

#[test]
fn overlay_replay_fts_and_savepoint_release_failures_roll_back_all_visible_changes() {
    for failure in ["fts", "release"] {
        let mut client = SyncClient::new(
            "replay".into(),
            &replay_schema(true),
            ClientLimits::default(),
        )
        .unwrap();
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("queued")),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!("needle")),
                    ("done".into(), json!(false)),
                ]),
                base_version: None,
            }])
            .unwrap();
        let before = client.query("SELECT * FROM tasks", &[]).unwrap();
        let fts_before = client
            .query("SELECT _syncular_source_id,title FROM tasks_fts", &[])
            .unwrap();
        let triggers_before: Vec<String> = client
            .conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        if failure == "fts" {
            client.conn.execute_batch("CREATE TRIGGER fail_fts BEFORE INSERT ON _syncular_fts_tasks_fts BEGIN SELECT RAISE(ABORT,'fts replay failed'); END;").unwrap();
        } else {
            client.conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE deferred(id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_release AFTER INSERT ON tasks BEGIN INSERT INTO deferred VALUES ('missing'); END;").unwrap();
        }
        client.overlay_dirty.set(true);
        assert!(client.rebuild_overlay().is_err());
        assert!(client.overlay_dirty.get());
        assert!(client.conn.is_autocommit());
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), before);
        assert_eq!(
            client
                .query("SELECT _syncular_source_id,title FROM tasks_fts", &[])
                .unwrap(),
            fts_before
        );
        let original_triggers: Vec<String> = client.conn.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'fail_%' ORDER BY name").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(original_triggers, triggers_before);
        assert_eq!(client.pending_commit_ids().len(), 1);
        client
            .conn
            .execute_batch(if failure == "fts" {
                "DROP TRIGGER fail_fts"
            } else {
                "DROP TRIGGER fail_release"
            })
            .unwrap();
        client
            .rebuild_overlay()
            .expect("retry after removing the fault");
    }
}

#[test]
fn secondary_unique_collision_preserves_existing_synced_row() {
    let client = SyncClient::new(
        "unique-upsert-test".to_owned(),
        &json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }],
                "indexes": [{
                    "name": "tasks_by_project_title",
                    "columns": ["project_id", "title"],
                    "unique": true
                }]
            }]
        }),
        ClientLimits::default(),
    )
    .expect("test client");
    let table = client.schema.table("tasks").expect("tasks table");
    let sql = client.insert_row_sql(&base_table("tasks"), table);

    client
        .conn
        .execute(&sql, rusqlite::params!["t1", "p1", "original", 1])
        .expect("insert first row");
    client
        .conn
        .execute(&sql, rusqlite::params!["t1", "p1", "updated", 2])
        .expect("update same primary key");
    client
        .conn
        .execute(&sql, rusqlite::params!["t2", "p1", "original", 1])
        .expect("insert second row");
    assert!(client
        .conn
        .execute(&sql, rusqlite::params!["t3", "p1", "original", 2])
        .is_err());

    let rows = client
        .conn
        .prepare("SELECT id, title FROM _syncular_base_tasks ORDER BY id")
        .expect("prepare rows")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect rows");
    assert_eq!(
        rows,
        vec![
            ("t1".to_owned(), "updated".to_owned()),
            ("t2".to_owned(), "original".to_owned())
        ]
    );
}

#[test]
fn reopening_active_subscriptions_emits_a_catch_up_intent() {
    let path = std::env::temp_dir().join(format!(
        "syncular-startup-intent-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });

    {
        let mut first = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("first open");
        first
            .set_window(
                &WindowBase {
                    variable: "project_id".to_owned(),
                    fixed_scopes: UnitScopes::new(),
                },
                &["persisted".to_owned()],
            )
            .expect("persist window");
    }

    let mut reopened = SyncClient::open_path_with_identity(
        None,
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("reopen");
    assert!(reopened.sync_needed());
    assert!(matches!(
        reopened.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn reopening_preserves_unit_progress_and_registering_again_changes_nothing() {
    let path = std::env::temp_dir().join(format!(
        "syncular-unit-progress-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let id = {
        let mut first = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("first open");
        let id = first
            .subscribe(unit_scopes("project_id", "p1"))
            .expect("register");
        let unit = first.unit(&id).unwrap().expect("unit");
        save_unit(
            &first.conn,
            &UnitRecord {
                cursor: Some(41),
                bootstrap_state: Some("resume-token".to_owned()),
                seeded: vec!["tasks".to_owned()],
                ..unit
            },
        )
        .unwrap();
        id
    };

    let mut reopened = SyncClient::open_path_with_identity(
        None,
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("reopen");
    let progress = reopened.unit(&id).unwrap().expect("persisted state");
    assert_eq!(progress.cursor, Some(41));
    assert_eq!(progress.bootstrap_state.as_deref(), Some("resume-token"));
    // §4.1: registering an active unit again keeps all of its state.
    assert_eq!(
        reopened.subscribe(unit_scopes("project_id", "p1")).unwrap(),
        id
    );
    assert_eq!(reopened.unit(&id).unwrap(), Some(progress));

    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn reopening_clears_a_schema_floor_the_running_app_already_satisfies() {
    let path = std::env::temp_dir().join(format!(
        "syncular-satisfied-schema-floor-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 23,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });

    {
        let mut first = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("first open");
        first
            .subscribe(UnitScopes::from([(
                "project_id".to_owned(),
                "p1".to_owned(),
            )]))
            .expect("persist subscription");
        first
            .set_schema_floor(Some(SchemaFloor {
                required_schema_version: Some(22),
                latest_schema_version: Some(22),
            }))
            .unwrap();
    }

    let mut reopened = SyncClient::open_path_with_identity(
        None,
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("reopen");
    assert!(reopened.schema_floor().is_none());
    assert!(reopened.get_meta(SCHEMA_FLOOR_KEY).unwrap().is_none());
    assert!(reopened.sync_needed());
    assert!(matches!(
        reopened.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn reopening_keeps_an_unsatisfied_schema_floor_stopped() {
    let path = std::env::temp_dir().join(format!(
        "syncular-unsatisfied-schema-floor-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });

    {
        let mut first = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("first open");
        first
            .subscribe(UnitScopes::from([(
                "project_id".to_owned(),
                "p1".to_owned(),
            )]))
            .expect("persist subscription");
        first
            .set_schema_floor(Some(SchemaFloor {
                required_schema_version: Some(2),
                latest_schema_version: Some(2),
            }))
            .unwrap();
    }

    let reopened = SyncClient::open_path_with_identity(
        None,
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("reopen");
    assert_eq!(
        reopened.schema_floor(),
        Some(&SchemaFloor {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
        })
    );
    assert!(!reopened.sync_needed());
    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn schema_bump_precedes_index_ddl_and_prunes_removed_subscriptions() {
    let path = std::env::temp_dir().join(format!(
        "syncular-indexed-column-bump-{}.db",
        uuid::Uuid::new_v4()
    ));
    let old_schema = json!({
        "version": 1,
        "tables": [
            {
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            },
            {
                "name": "legacy",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }
        ]
    });
    {
        let mut first = SyncClient::open_path_with_identity(
            None,
            &old_schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("open old schema");
        first
            .subscribe(UnitScopes::from([(
                "project_id".to_owned(),
                "p1".to_owned(),
            )]))
            .expect("persist legacy subscription");
    }

    let new_schema = json!({
        "version": 2,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false },
                { "name": "facility_membership_id", "type": "string", "nullable": true }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }],
            "indexes": [{
                "name": "tasks_by_membership",
                "columns": ["project_id", "facility_membership_id"],
                "unique": false
            }]
        }]
    });
    let upgraded = SyncClient::open_path_with_identity(
        None,
        &new_schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open upgraded schema");
    let columns = upgraded
        .conn
        .prepare("PRAGMA table_info(tasks)")
        .expect("prepare columns")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect columns");
    assert!(columns.contains(&"facility_membership_id".to_owned()));
    let index_count: i64 = upgraded
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'tasks_by_membership'",
            [],
            |row| row.get(0),
        )
        .expect("query index");
    assert_eq!(index_count, 1);
    // The unit covered `legacy`, which the bump removed (§7.4.3).
    assert!(upgraded.units().unwrap().is_empty());
    drop(upgraded);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn migrates_pre_envelope_outcome_journal_additively() {
    let path = std::env::temp_dir().join(format!(
        "syncular-outcome-migration-{}.db",
        uuid::Uuid::new_v4()
    ));
    let conn = Connection::open(&path).expect("open legacy database");
    conn.execute_batch(
        "CREATE TABLE _syncular_commit_outcomes (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           client_commit_id TEXT NOT NULL UNIQUE,
           status TEXT NOT NULL,
           recorded_at_ms INTEGER NOT NULL,
           results_json TEXT NOT NULL,
           resolution TEXT NOT NULL DEFAULT 'active',
           resolved_at_ms INTEGER,
           replacement_client_commit_id TEXT);",
    )
    .expect("create legacy outcome journal");
    drop(conn);
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let client = SyncClient::open_path(
        "migration-native".to_owned(),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("migrate database");
    let has_operations = client
        .conn
        .prepare("PRAGMA table_info(_syncular_commit_outcomes)")
        .expect("prepare table info")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table info")
        .filter_map(Result::ok)
        .any(|column| column == "operations_json");
    assert!(has_operations);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn retained_rejection_survives_file_reopen_and_security_purge() {
    let path = std::env::temp_dir().join(format!("syncular-retained-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({ "version": 1, "tables": [{ "name": "tasks", "primaryKey": "id", "columns": [
        { "name": "id", "type": "string", "nullable": false },
        { "name": "project_id", "type": "string", "nullable": false },
        { "name": "title", "type": "string", "nullable": false }
    ], "scopes": [{ "pattern": "project:{project_id}" }] }] });
    {
        let mut first = SyncClient::open_path(
            "retained-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        first
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("t1".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String("server".into())),
                ],
                1,
            )
            .unwrap();
        first.rebuild_overlay().expect("rebuild overlay");
        let operation = OutboxOp {
            table: "tasks".into(),
            row_id: "t1".into(),
            upsert: true,
            insert: false,
            base_version: Some(1),
            values: Some(Map::from_iter([
                ("id".into(), json!("t1")),
                ("title".into(), json!("mine")),
            ])),
        };
        first
            .retain_failed_commit("retained", std::slice::from_ref(&operation))
            .unwrap();
        first
            .persist_commit_outcome(
                "retained",
                CommitOutcomeStatus::Rejected,
                &[CommitOperationOutcome::Error {
                    rejection: RejectionRecord {
                        client_commit_id: "retained".into(),
                        op_index: 0,
                        code: "validation.denied".into(),
                        message: "denied".into(),
                        retryable: false,
                        details: None,
                        operation: None,
                    },
                }],
                Some(&[operation]),
            )
            .unwrap();
        first.rebuild_overlay().expect("rebuild overlay");
    }
    {
        let mut reopened = SyncClient::open_path(
            "retained-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        let row = reopened
            .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
            .expect("read visible row")
            .unwrap();
        assert_eq!(row.0[2], Some(ColumnValue::String("mine".into())));
        assert_eq!(
            reopened
                .commit_outcome("retained")
                .unwrap()
                .unwrap()
                .retained_rows
                .unwrap()[0]
                .server_row
                .as_ref()
                .unwrap()["title"],
            json!("server")
        );
        reopened
            .conn
            .execute("DELETE FROM _syncular_base_tasks WHERE id = 't1'", [])
            .unwrap();
        reopened.rebuild_overlay().expect("rebuild overlay");
        assert!(reopened
            .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
            .expect("read visible row")
            .is_none());
        let retained = reopened.commit_outcome("retained").unwrap().unwrap();
        assert!(retained.retained_rows.is_some());
        assert_eq!(
            retained.operations.unwrap()[0].values.as_ref().unwrap()["title"],
            json!("mine")
        );
        reopened
            .purge_local_data(&LocalDataPurgeInput {
                purge_id: "protected-purge".into(),
                targets: vec![LocalDataPurgeTarget {
                    table: "tasks".into(),
                    selectors: BTreeMap::from_iter([("project_id".into(), vec!["p1".into()])]),
                }],
            })
            .unwrap();
        assert!(reopened
            .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
            .expect("read visible row")
            .is_none());
        assert!(reopened
            .commit_outcome("retained")
            .unwrap()
            .unwrap()
            .retained_rows
            .is_none());
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn durable_conflict_outcome_and_resolution_survive_reopen() {
    let path = std::env::temp_dir().join(format!(
        "syncular-durable-outcome-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let conflict = ConflictRecord {
        client_commit_id: "losing-commit".to_owned(),
        op_index: 0,
        table: "tasks".to_owned(),
        row_id: "t1".to_owned(),
        code: "sync.version_conflict".to_owned(),
        message: "stale base version".to_owned(),
        server_version: 2,
        server_row: Map::from_iter([("id".to_owned(), json!("t1"))]),
        conflict_columns: vec!["project_id".to_owned()],
        operation: Some(CommitOperation {
            table: "tasks".to_owned(),
            row_id: "t1".to_owned(),
            op: "upsert".to_owned(),
            base_version: Some(1),
            values: Some(Map::from_iter([
                ("id".into(), json!("t1")),
                ("project_id".into(), json!("p1")),
            ])),
            insert: false,
        }),
    };
    let failed_operations = vec![
        OutboxOp {
            upsert: true,
            insert: false,
            table: "tasks".to_owned(),
            row_id: "t1".to_owned(),
            base_version: Some(1),
            values: Some(Map::from_iter([
                ("id".into(), json!("t1")),
                ("project_id".into(), json!("p1")),
            ])),
        },
        OutboxOp {
            upsert: true,
            insert: false,
            table: "tasks".to_owned(),
            row_id: "status-event-1".to_owned(),
            base_version: Some(0),
            values: Some(Map::from_iter([
                ("id".into(), json!("status-event-1")),
                ("project_id".into(), json!("p1")),
            ])),
        },
    ];

    {
        let mut first = SyncClient::open_path(
            "durable-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("first open");
        first
            .begin_observation("test_outcome")
            .expect("begin outcome");
        first
            .persist_commit_outcome(
                "losing-commit",
                CommitOutcomeStatus::Conflict,
                &[CommitOperationOutcome::Conflict {
                    conflict: conflict.clone(),
                }],
                Some(&failed_operations),
            )
            .expect("persist outcome");
        first.conflicts.push(conflict);
        first
            .finish_observation(
                "test_outcome",
                ChangeAccumulator {
                    conflicts: true,
                    outcomes: true,
                    ..ChangeAccumulator::default()
                },
            )
            .expect("commit outcome");
    }

    {
        let mut reopened = SyncClient::open_path(
            "durable-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("reopen");
        assert_eq!(reopened.conflicts().len(), 1);
        assert_eq!(
            reopened.conflicts()[0].conflict_columns,
            vec!["project_id".to_owned()],
            "conflictColumns survives the journal round trip"
        );
        let outcome = reopened
            .commit_outcome("losing-commit")
            .expect("read outcome")
            .expect("outcome");
        assert_eq!(outcome.status, CommitOutcomeStatus::Conflict);
        let operations = outcome.operations.expect("aggregate envelope");
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[1].row_id, "status-event-1");
        let resolved = reopened
            .resolve_commit_outcome(ResolveCommitOutcomeInput {
                client_commit_id: "losing-commit".to_owned(),
                resolution: CommitOutcomeResolution::ResolvedKeepServer,
                replacement_client_commit_id: None,
            })
            .expect("resolve");
        assert_eq!(
            resolved.resolution,
            CommitOutcomeResolution::ResolvedKeepServer
        );
        assert!(reopened.conflicts().is_empty());
    }

    let reopened = SyncClient::open_path(
        "durable-native".to_owned(),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("second reopen");
    assert!(reopened.conflicts().is_empty());
    assert_eq!(
        reopened
            .commit_outcome("losing-commit")
            .expect("read outcome")
            .expect("outcome")
            .resolution,
        CommitOutcomeResolution::ResolvedKeepServer
    );
    drop(reopened);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn file_snapshot_reader_matches_owner_rows_revision_and_coverage() {
    let path =
        std::env::temp_dir().join(format!("syncular-read-sidecar-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-client".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    let base = WindowBase {
        variable: "project_id".to_owned(),
        fixed_scopes: UnitScopes::new(),
    };
    client
        .set_window(&base, &["one".to_owned()])
        .expect("set window");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("t1")),
                ("project_id".to_owned(), Value::from("one")),
            ]),
            base_version: None,
        }])
        .expect("local mutate");

    let coverage = [WindowCoverage {
        base,
        units: vec!["one".to_owned(), "missing".to_owned()],
    }];
    let owner = client
        .query_snapshot(
            "SELECT id, project_id, _sync_version AS server_version FROM tasks ORDER BY id",
            &[],
            &coverage,
            None,
        )
        .expect("owner snapshot");
    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    let sidecar = reader
        .query_snapshot(
            "SELECT id, project_id, _sync_version AS server_version FROM tasks ORDER BY id",
            &[],
            &coverage,
        )
        .expect("sidecar snapshot");

    assert_eq!(sidecar.revision, owner.revision);
    assert_eq!(sidecar.rows, owner.rows);
    assert_eq!(
        serde_json::to_value(&sidecar.coverage).expect("serialize sidecar coverage"),
        serde_json::to_value(&owner.coverage).expect("serialize owner coverage")
    );
    assert_eq!(sidecar.revision, "2");
    assert_eq!(sidecar.rows[0]["id"], "t1");
    assert_eq!(sidecar.rows[0]["server_version"], -1);
    assert!(!sidecar.coverage.complete);
    assert_eq!(sidecar.coverage.pending.len(), 1);
    assert_eq!(sidecar.coverage.missing.len(), 1);

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn file_snapshot_reader_reports_catchup_delivery_and_multi_statement() {
    let path =
        std::env::temp_dir().join(format!("syncular-read-sidecar-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-catchup".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    let unit = client
        .subscribe(UnitScopes::from([("project_id".to_owned(), "one".into())]))
        .expect("subscribe");
    let commit_id = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("t1")),
                ("project_id".to_owned(), Value::from("one")),
            ]),
            base_version: None,
        }])
        .expect("mutate");
    let revision = client.local_revision().unwrap().to_string();

    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    assert_eq!(reader.local_revision().expect("revision"), revision);

    let read = reader
        .snapshot_read(&SnapshotReadRequest {
            statements: vec![
                SnapshotStatement {
                    sql: "SELECT 1 AS n",
                    params: &[],
                },
                SnapshotStatement {
                    sql: "SELECT id FROM tasks ORDER BY id",
                    params: &[],
                },
            ],
            coverage: &[],
            units: vec![unit.clone(), "absent".to_owned()],
            commit_ids: vec![commit_id.clone(), "never-known".to_owned()],
        })
        .expect("snapshot read");
    assert_eq!(read.revision, revision);
    assert_eq!(read.queries.len(), 2);
    assert_eq!(read.queries[0][0]["n"], 1);
    assert_eq!(read.queries[1][0]["id"], "t1");
    match &read.units[0] {
        UnitCatchup::Known {
            status,
            cursor,
            bootstrap_complete,
            known_pending_pages,
            ..
        } => {
            assert_eq!(*status, UnitStatus::Active);
            assert_eq!(*cursor, -1);
            assert!(!bootstrap_complete);
            assert!(known_pending_pages);
        }
        other => panic!("expected a known unit: {other:?}"),
    }
    assert!(matches!(
        &read.units[1],
        UnitCatchup::Unknown { id } if id.as_str() == "absent"
    ));
    assert!(matches!(
        &read.deliveries[0],
        CommitDelivery::Pending { client_commit_id } if client_commit_id == &commit_id
    ));
    assert!(matches!(
        &read.deliveries[1],
        CommitDelivery::Unknown { client_commit_id } if client_commit_id.as_str() == "never-known"
    ));

    // A bad statement rolls the whole read back and releases the connection.
    assert!(reader
        .query_snapshot("SELECT * FROM does_not_exist", &[], &[])
        .is_err());
    assert_eq!(
        reader.local_revision().expect("revision after rollback"),
        revision
    );
    // The read-only guard refuses a write on any statement.
    assert!(reader
        .query_snapshot("DELETE FROM tasks", &[], &[])
        .is_err());

    // A corrupt revision marker fails typed, not as an invented zero.
    client
        .conn
        .execute(
            "UPDATE _syncular_meta SET value = '+1' WHERE key = 'localRevision'",
            [],
        )
        .expect("corrupt revision");
    let failure = reader.local_revision().expect_err("corrupt revision fails");
    assert_eq!(failure.code, Some("sync.local_corrupt"));

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn snapshot_delivery_is_the_persisted_journal_view_without_retained_rows() {
    let path =
        std::env::temp_dir().join(format!("syncular-read-sidecar-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-delivery".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    client.begin_observation("test_delivery").expect("observe");
    let operations = [OutboxOp {
        upsert: true,
        insert: false,
        table: "tasks".to_owned(),
        row_id: "t1".to_owned(),
        base_version: Some(1),
        values: Some(Map::from_iter([
            ("id".into(), json!("t1")),
            ("project_id".into(), json!("p1")),
        ])),
    }];
    client
        .persist_commit_outcome(
            "conflict-commit",
            CommitOutcomeStatus::Conflict,
            &[CommitOperationOutcome::Conflict {
                conflict: ConflictRecord {
                    client_commit_id: "conflict-commit".to_owned(),
                    op_index: 0,
                    table: "tasks".to_owned(),
                    row_id: "t1".to_owned(),
                    code: "sync.version_conflict".to_owned(),
                    message: "stale base version".to_owned(),
                    server_version: 2,
                    server_row: Map::from_iter([("id".to_owned(), json!("t1"))]),
                    conflict_columns: vec!["project_id".to_owned()],
                    operation: None,
                },
            }],
            Some(&operations),
        )
        .expect("persist conflict");
    client
        .persist_commit_outcome(
            "rejected-commit",
            CommitOutcomeStatus::Rejected,
            &[CommitOperationOutcome::Error {
                rejection: RejectionRecord {
                    client_commit_id: "rejected-commit".to_owned(),
                    op_index: 0,
                    code: "sync.unknown_table".to_owned(),
                    message: "unknown table".to_owned(),
                    retryable: false,
                    details: None,
                    operation: None,
                },
            }],
            Some(&operations),
        )
        .expect("persist rejection");
    client
        .finish_observation(
            "test_delivery",
            ChangeAccumulator {
                conflicts: true,
                outcomes: true,
                ..ChangeAccumulator::default()
            },
        )
        .expect("commit outcomes");

    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    match reader.commit_delivery("conflict-commit").expect("conflict") {
        CommitDelivery::Known { outcome, .. } => {
            assert_eq!(outcome.status, CommitOutcomeStatus::Conflict);
            assert!(matches!(
                outcome.results.as_slice(),
                [CommitOperationOutcome::Conflict { conflict }]
                    if conflict.code == "sync.version_conflict"
                        && conflict.server_version == 2
            ));
            assert_eq!(outcome.operations.as_ref().map(Vec::len), Some(1));
            assert!(
                outcome.retained_rows.is_none(),
                "the sidecar reports the persisted view, not owner-derived retained rows"
            );
        }
        other => panic!("expected a known conflict: {other:?}"),
    }
    match reader
        .commit_delivery("rejected-commit")
        .expect("rejection")
    {
        CommitDelivery::Known { outcome, .. } => {
            assert_eq!(outcome.status, CommitOutcomeStatus::Rejected);
            assert!(matches!(
                outcome.results.as_slice(),
                [CommitOperationOutcome::Error { rejection }]
                    if rejection.code == "sync.unknown_table"
            ));
            assert_eq!(outcome.operations.as_ref().map(Vec::len), Some(1));
            assert!(outcome.retained_rows.is_none());
        }
        other => panic!("expected a known rejection: {other:?}"),
    }
    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn snapshot_read_isolates_a_concurrent_writer_commit() {
    use std::sync::mpsc::channel;
    let path = std::env::temp_dir().join(format!(
        "syncular-read-concurrent-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-concurrent".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("t1")),
                ("project_id".to_owned(), Value::from("one")),
            ]),
            base_version: None,
        }])
        .expect("seed row");
    let revision_before = client.local_revision().unwrap().to_string();

    // A writer on a second connection commits while the reader is between
    // statements; the hook rendezvous is a barrier, not a sleep.
    let (ready_tx, ready_rx) = channel::<()>();
    let (done_tx, done_rx) = channel::<()>();
    let writer_path = path.to_string_lossy().into_owned();
    let writer_schema = schema.clone();
    let writer = std::thread::spawn(move || {
        let mut writer = SyncClient::open_path_with_identity(
            Some("sidecar-concurrent".to_owned()),
            &writer_schema,
            ClientLimits::default(),
            &writer_path,
        )
        .expect("open writer");
        ready_rx.recv().expect("reader signalled");
        writer
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("t2")),
                    ("project_id".to_owned(), Value::from("one")),
                ]),
                base_version: None,
            }])
            .expect("writer commit");
        let _ = done_tx.send(());
    });
    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    SNAPSHOT_READ_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            ready_tx.send(()).expect("signal writer");
            done_rx.recv().expect("writer finished");
        }));
    });
    let read = reader
        .snapshot_read(&SnapshotReadRequest {
            statements: vec![
                SnapshotStatement {
                    sql: "SELECT count(*) AS n FROM tasks",
                    params: &[],
                },
                SnapshotStatement {
                    sql: "SELECT count(*) AS n FROM tasks",
                    params: &[],
                },
            ],
            coverage: &[],
            units: Vec::new(),
            commit_ids: Vec::new(),
        })
        .expect("snapshot read");
    assert_eq!(
        read.queries[0][0]["n"], 1,
        "first statement sees the pre-commit row"
    );
    assert_eq!(
        read.queries[1][0]["n"], 1,
        "a later statement keeps the one read snapshot"
    );
    assert_eq!(
        read.revision, revision_before,
        "the read reports the snapshot revision, not the writer's"
    );
    writer.join().expect("join writer");

    assert_ne!(
        reader.local_revision().expect("revision after commit"),
        revision_before,
        "the next read observes the committed revision"
    );
    let after = reader
        .query_snapshot("SELECT count(*) AS n FROM tasks", &[], &[])
        .expect("count after commit");
    assert_eq!(
        after.rows[0]["n"], 2,
        "the committed row is visible afterwards"
    );

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn snapshot_read_rejects_every_non_canonical_revision() {
    let path = std::env::temp_dir().join(format!(
        "syncular-read-revision-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let client = SyncClient::open_path_with_identity(
        Some("sidecar-revision".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    for bad in [
        "+1",
        "01",
        "-1",
        " 1",
        "1 ",
        "18446744073709551616",
        "1.0",
        "abc",
        "",
    ] {
        client
            .conn
            .execute(
                "UPDATE _syncular_meta SET value = ?1 WHERE key = 'localRevision'",
                rusqlite::params![bad],
            )
            .expect("corrupt revision");
        let failure = reader.local_revision().expect_err("corrupt marker fails");
        assert_eq!(failure.code, Some("sync.local_corrupt"), "{bad:?}");
    }
    for value in ["X'31'", "CAST(X'FF' AS TEXT)"] {
        client
            .conn
            .execute_batch(&format!(
                "UPDATE _syncular_meta SET value={value} WHERE key='localRevision'"
            ))
            .expect("corrupt stored revision type");
        assert_eq!(
            reader.local_revision().expect_err("invalid SQL field").code,
            Some("sync.local_corrupt")
        );
    }
    // The absent marker is the legacy zero, not corruption.
    client
        .conn
        .execute("DELETE FROM _syncular_meta WHERE key = 'localRevision'", [])
        .expect("delete marker");
    assert_eq!(reader.local_revision().expect("legacy zero"), "0");

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn snapshot_read_rejects_corrupt_unit_state() {
    let path = std::env::temp_dir().join(format!(
        "syncular-read-unitstate-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-unitstate".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    let id = client
        .subscribe(UnitScopes::from([("project_id".to_owned(), "one".into())]))
        .expect("subscribe");
    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    for assignment in [
        "scopes='not json'",
        "scopes='[]'",
        "status='bogus'",
        "cursor='x'",
        "bootstrap_state=X'00'",
        "reason_code=X'00'",
        "seeded='{}'",
        "echo='[1]'",
        "scopes=X'7b7d'",
        "scopes=CAST(X'FF' AS TEXT)",
    ] {
        client
            .conn
            .execute_batch(&format!(
                "UPDATE _syncular_units SET scopes='{{\"project_id\":\"one\"}}', status='active',
                   cursor=-1, bootstrap_state=NULL, reason_code=NULL, seeded='[]', echo=NULL;
                 UPDATE _syncular_units SET {assignment} WHERE id='{id}'"
            ))
            .expect("corrupt stored unit");
        let failure = reader.unit_catchup(&id).expect_err("corrupt state fails");
        assert_eq!(failure.code, Some("sync.local_corrupt"), "{assignment}");
    }

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn snapshot_read_rolls_back_a_later_invalid_statement_and_guards_every_write() {
    let path = std::env::temp_dir().join(format!(
        "syncular-read-rollback-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "project_id", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "project:{project_id}" }]
        }]
    });
    let mut client = SyncClient::open_path_with_identity(
        Some("sidecar-rollback".to_owned()),
        &schema,
        ClientLimits::default(),
        path.to_str().expect("UTF-8 temp path"),
    )
    .expect("open owner");
    let commit_id = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("t1")),
                ("project_id".to_owned(), Value::from("one")),
            ]),
            base_version: None,
        }])
        .expect("seed row");
    let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
    let revision = reader.local_revision().expect("revision");

    // The second statement fails: the whole read rolls back and the
    // connection releases, so the same reader still works afterwards.
    let failure = reader
        .snapshot_read(&SnapshotReadRequest {
            statements: vec![
                SnapshotStatement {
                    sql: "SELECT id FROM tasks",
                    params: &[],
                },
                SnapshotStatement {
                    sql: "SELECT * FROM does_not_exist",
                    params: &[],
                },
            ],
            coverage: &[],
            units: Vec::new(),
            commit_ids: vec![commit_id.clone()],
        })
        .expect_err("second statement fails");
    assert_eq!(failure.code, None);
    assert_eq!(
        reader.local_revision().expect("revision after rollback"),
        revision,
        "a rolled-back read consumes no revision"
    );
    assert!(
        !matches!(
            reader
                .commit_delivery(&commit_id)
                .expect("delivery after rollback"),
            CommitDelivery::Unknown { .. }
        ),
        "the same reader serves the next read after releasing the connection"
    );

    // The read-only guard rejects a write in the first position too.
    let guard = reader
        .snapshot_read(&SnapshotReadRequest {
            statements: vec![SnapshotStatement {
                sql: "DELETE FROM tasks",
                params: &[],
            }],
            coverage: &[],
            units: Vec::new(),
            commit_ids: Vec::new(),
        })
        .expect_err("write guard");
    assert!(guard.message.contains("read-only"), "{}", guard.message);

    drop(reader);
    drop(client);
    std::fs::remove_file(path).expect("remove temp database");
}

#[test]
fn owned_query_failures_classify_order_bound_and_clear() {
    let io = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(266),
        Some("private SQLite prose".to_owned()),
    ));
    assert_eq!(io.code, Some("client.storage_io"));
    assert_eq!(io.sqlite_code, Some(266));
    assert_eq!(io.message, "local SQLite storage I/O failed");
    let corrupt = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(26),
        None,
    ));
    assert_eq!(corrupt.code, Some("client.storage_corrupt"));
    assert!(!io.retryable());
    assert!(!corrupt.retryable());

    // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including extended codes, are
    // transient lock contention: classified busy and retryable.
    for (raw, extended) in [(5, 5), (5 | (1 << 8), 261), (6, 6), (6 | (1 << 8), 262)] {
        let busy = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(raw),
            Some("database is locked".to_owned()),
        ));
        assert_eq!(busy.code, Some("client.storage_busy"));
        assert_eq!(busy.sqlite_code, Some(extended));
        assert_eq!(busy.message, "local SQLite storage is busy");
        assert!(busy.retryable());
    }
    let unrelated = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(1),
        Some("generic SQLite prose".to_owned()),
    ));
    assert_eq!(unrelated.code, None);
    assert!(!unrelated.retryable());

    let mut client = client();
    let generic = QueryReadFailure::from("private query prose".to_owned());
    client.record_query_read(
        QueryOwner {
            id: "first",
            tables: &["tasks", "tasks"],
        },
        Some(&generic),
    );
    client.record_query_read(
        QueryOwner {
            id: "second",
            tables: &["tasks"],
        },
        Some(&generic),
    );
    client.record_query_read(
        QueryOwner {
            id: "first",
            tables: &["docs"],
        },
        Some(&io),
    );
    let failures = &client
        .diagnostics_snapshot()
        .expect("diagnostics")
        .query_failures;
    assert_eq!(
        failures
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "first"]
    );
    assert_eq!(failures[1].tables, vec!["docs"]);
    assert_eq!(failures[1].code, "client.storage_io");

    for index in 0..=MAX_DIAGNOSTIC_QUERY_FAILURES {
        client.record_query_read(
            QueryOwner {
                id: &format!("query-{index}"),
                tables: &["tasks"],
            },
            Some(&generic),
        );
    }
    let failures = &client
        .diagnostics_snapshot()
        .expect("bounded diagnostics")
        .query_failures;
    assert_eq!(failures.len(), MAX_DIAGNOSTIC_QUERY_FAILURES);
    assert_eq!(failures.last().expect("last failure").id, "query-256");

    client
        .query_snapshot(
            "SELECT id FROM tasks",
            &[],
            &[],
            Some(QueryOwner {
                id: "query-256",
                tables: &["tasks"],
            }),
        )
        .expect("successful owned read");
    assert!(client
        .diagnostics_snapshot()
        .expect("cleared diagnostics")
        .query_failures
        .iter()
        .all(|entry| entry.id != "query-256"));
}

#[test]
fn image_chunks_keep_their_committed_prefix_after_a_later_invalid_row() {
    let mut client = client();
    let image = Connection::open_in_memory().unwrap();
    image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, _syncular_version INTEGER NOT NULL);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
        INSERT INTO tasks SELECT printf('%05d',x),CASE WHEN x=1500 THEN NULL ELSE 'p1' END,1 FROM n;
        CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
        INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',2050);").unwrap();
    let table = client.schema.table("tasks").unwrap().clone();
    let scopes = vec![("project_id".into(), vec!["p1".into()])];
    assert!(client
        .apply_sqlite_image(&image, &table, true, &scopes, &[], 2050, 7, "digest")
        .is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        1024
    );
    assert_eq!(client.drain_change_batches().len(), 1);
    image
        .execute("UPDATE tasks SET project_id='p1' WHERE id='01500'", [])
        .unwrap();
    assert!(matches!(
        client.apply_sqlite_image(&image, &table, true, &scopes, &[], 2050, 7, "digest"),
        Ok(2050)
    ));
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        2050
    );
    assert_eq!(client.drain_change_batches().len(), 3);
}

#[test]
fn eviction_chunks_commit_before_failure_and_resume_with_exact_scope() {
    let mut client = client();
    let base = WindowBase {
        variable: "project_id".into(),
        fixed_scopes: UnitScopes::new(),
    };
    client
        .set_window(&base, &["p1".into(), "p2".into()])
        .unwrap();
    client
        .conn
        .execute("UPDATE _syncular_units SET echo='[]', cursor=NULL", [])
        .unwrap();
    client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
        INSERT INTO _syncular_base_tasks SELECT printf('%05d',x),'p1',1 FROM n;
        INSERT INTO _syncular_base_tasks VALUES ('held','p2',1);
        INSERT INTO tasks SELECT * FROM _syncular_base_tasks;
        CREATE TRIGGER interrupt_evict BEFORE DELETE ON tasks WHEN old.id='01500' BEGIN SELECT RAISE(ABORT,'interrupted chunk'); END;").unwrap();
    client.drain_change_batches();
    assert!(client.set_window(&base, &["p2".into()]).is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        1027
    );
    assert_eq!(client.window_state(&base).unwrap().units, vec!["p2"]);
    assert_eq!(client.load_pending_evictions().unwrap().len(), 1);
    assert_eq!(client.drain_change_batches().len(), 1);
    client
        .conn
        .execute_batch("DROP TRIGGER interrupt_evict")
        .unwrap();
    client.drain_pending_evictions().unwrap();
    assert!(client.load_pending_evictions().unwrap().is_empty());
    assert_eq!(
        client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
        "held"
    );
    assert_eq!(client.drain_change_batches().len(), 2);
}

#[test]
fn eviction_marker_failures_roll_back_window_changes() {
    let mut client = client();
    let base = WindowBase {
        variable: "project_id".into(),
        fixed_scopes: UnitScopes::new(),
    };
    client.set_window(&base, &["p1".into()]).unwrap();
    // A unit evicts only the rows of its persisted echo (§4.8).
    client
        .conn
        .execute("UPDATE _syncular_units SET echo='[]', cursor=NULL", [])
        .unwrap();
    client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
        INSERT INTO _syncular_base_tasks SELECT printf('%05d',x),'p1',1 FROM n;
        INSERT INTO tasks SELECT * FROM _syncular_base_tasks;
        CREATE TRIGGER fail_marker BEFORE INSERT ON _syncular_pending_evictions BEGIN SELECT RAISE(ABORT,'marker failed'); END;").unwrap();
    let revision = client.local_revision().unwrap();
    assert!(client.set_window(&base, &[]).is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(client.local_revision().unwrap(), revision);
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        2050
    );
    assert_eq!(client.window_state(&base).unwrap().units, vec!["p1"]);
    client.conn.execute_batch("DROP TRIGGER fail_marker;
        CREATE TRIGGER interrupt_evict BEFORE DELETE ON tasks WHEN old.id='01500' BEGIN SELECT RAISE(ABORT,'interrupted chunk'); END;").unwrap();
    assert!(client.set_window(&base, &[]).is_err());
    client.conn.execute_batch("DROP TRIGGER interrupt_evict;
        CREATE TRIGGER fail_marker BEFORE DELETE ON _syncular_pending_evictions BEGIN SELECT RAISE(ABORT,'marker failed'); END;").unwrap();
    assert!(client.drain_pending_evictions().is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        2
    );
    assert!(client.set_window(&base, &["p1".into()]).is_err());
    assert!(client.conn.is_autocommit());
    assert!(client.window_state(&base).unwrap().units.is_empty());
    assert!(client.units().unwrap().is_empty());
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM _syncular_pending_evictions", &[])
            .unwrap()[0]["n"],
        1
    );
    client
        .conn
        .execute_batch("DROP TRIGGER fail_marker")
        .unwrap();
    client.set_window(&base, &["p1".into()]).unwrap();
    assert_eq!(client.window_state(&base).unwrap().units, vec!["p1"]);
}

#[test]
fn malformed_eviction_marker_is_reported_without_starting_cleanup() {
    let mut client = client();
    client
        .conn
        .execute(
            "INSERT INTO _syncular_pending_evictions VALUES ('broken','tasks','{')",
            [],
        )
        .unwrap();
    assert_eq!(
        client.drain_pending_evictions().unwrap_err(),
        "sync.local_corrupt: invalid pending eviction scopes"
    );
    assert!(client.conn.is_autocommit());
    assert!(client.enqueue_startup_sync_if_needed().is_err());
}

#[test]
fn image_chunks_reject_null_primary_keys() {
    let mut client = client();
    let image = Connection::open_in_memory().unwrap();
    image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1025)
        INSERT INTO tasks SELECT NULL,'p1',1 FROM n;
        CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
        INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1025);").unwrap();
    let table = client.schema.table("tasks").unwrap().clone();
    assert!(client
        .apply_sqlite_image(
            &image,
            &table,
            true,
            &[("project_id".into(), vec!["p1".into()])],
            &[],
            1025,
            7,
            "digest"
        )
        .is_err());
    assert!(client.conn.is_autocommit());
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        0
    );
}

#[test]
fn import_chunks_with_unique_constraints_match_full_pending_replay() {
    for images in [false, true] {
        let schema = json!({"version":1,"tables": (["tasks", "notes"].map(|name| json!({
            "name":name,"primaryKey":"id","columns":[
                {"name":"id","type":"string","nullable":false},
                {"name":"project_id","type":"string","nullable":false},
                {"name":"title","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}],
            "indexes":[{"name":format!("{name}_unique_title"),"columns":["title"],"unique":true}],
            "ftsIndexes":[{"name":format!("{name}_fts"),"columns":["title"],"tokenize":"unicode61"}]
        })))});
        let mut actual =
            SyncClient::new("actual".into(), &schema, ClientLimits::default()).unwrap();
        let mut reference =
            SyncClient::new("reference".into(), &schema, ClientLimits::default()).unwrap();
        let scopes = vec![("project_id".into(), vec!["p1".into()])];
        for client in [&mut actual, &mut reference] {
            for (table, id, title) in [
                ("tasks", "a", "original"),
                ("tasks", "b", "occupied"),
                ("tasks", "c", "deleted"),
                ("notes", "n", "untouched"),
            ] {
                client
                    .write_base_row(
                        table,
                        &vec![
                            Some(ColumnValue::String(id.into())),
                            Some(ColumnValue::String("p1".into())),
                            Some(ColumnValue::String(title.into())),
                        ],
                        1,
                    )
                    .unwrap();
            }
            client.rebuild_overlay_if_dirty().expect("rebuild overlay");
            client
                .mutate(vec![
                    Mutation::Upsert {
                        table: "tasks".into(),
                        values: Map::from_iter([
                            ("id".into(), Value::from("a")),
                            ("project_id".into(), Value::from("p1")),
                            ("title".into(), Value::from("available")),
                        ]),
                        base_version: None,
                    },
                    Mutation::Delete {
                        table: "tasks".into(),
                        row_id: "c".into(),
                        base_version: None,
                    },
                    Mutation::Upsert {
                        table: "tasks".into(),
                        values: Map::from_iter([
                            ("id".into(), Value::from("local")),
                            ("project_id".into(), Value::from("p1")),
                            ("title".into(), Value::from("local value")),
                        ]),
                        base_version: None,
                    },
                    Mutation::Upsert {
                        table: "notes".into(),
                        values: Map::from_iter([
                            ("id".into(), Value::from("n")),
                            ("project_id".into(), Value::from("p1")),
                            ("title".into(), Value::from("pending note")),
                        ]),
                        base_version: None,
                    },
                ])
                .unwrap();
        }
        let pending = actual.pending_commit_ids();
        actual.overlay_rebuild_count.set(0);
        // §4.5: every server write of a row carries a higher version.
        for (version, (id, title)) in (2..).zip([
            ("b", "available"),
            ("b", "occupied"),
            ("a", "server original"),
            ("d", "local value"),
            ("d", "released"),
            ("c", "redelivered"),
        ]) {
            let table = actual.schema.table("tasks").unwrap().clone();
            let values = vec![
                Some(ColumnValue::String(id.into())),
                Some(ColumnValue::String("p1".into())),
                Some(ColumnValue::String(title.into())),
            ];
            if images {
                let image = Connection::open_in_memory().unwrap();
                image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
                    CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
                    INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1);").unwrap();
                image
                    .execute(
                        "INSERT INTO tasks VALUES (?1,'p1',?2,?3)",
                        rusqlite::params![id, title, version],
                    )
                    .unwrap();
                assert!(matches!(
                    actual.apply_sqlite_image(&image, &table, false, &scopes, &[], 1, 7, "digest"),
                    Ok(1)
                ));
            } else {
                let segment = RowsSegment {
                    table: "tasks".into(),
                    schema_version: 1,
                    columns: table.wire_columns.clone(),
                    blocks: vec![vec![ssp2::segment::SegmentRow {
                        server_version: version,
                        values: values.clone(),
                    }]],
                };
                assert!(matches!(
                    actual.apply_segment(&table, &segment, false, &scopes, &[]),
                    Ok(1)
                ));
            }
            reference.write_base_row("tasks", &values, version).unwrap();
            reference.rebuild_overlay().expect("rebuild overlay");
            for table in ["tasks", "notes"] {
                for sql in [format!("SELECT * FROM {table} ORDER BY id"),format!("SELECT _syncular_source_id,title FROM {table}_fts ORDER BY _syncular_source_id"),format!("SELECT source_id FROM _syncular_fts_{table}_fts ORDER BY source_id")] {
                    assert_eq!(actual.query(&sql, &[]).unwrap(), reference.query(&sql, &[]).unwrap(), "images={images}, {id}/{title}: {sql}");
                }
            }
            assert_eq!(actual.pending_commit_ids(), pending);
        }
        assert_eq!(
            actual.overlay_rebuild_count.get(),
            0,
            "each chunk must leave unrelated tables alone"
        );
        let before = actual
            .query("SELECT * FROM tasks ORDER BY id", &[])
            .unwrap();
        let fts_before = actual
            .query("SELECT * FROM tasks_fts ORDER BY _syncular_source_id", &[])
            .unwrap();
        let revision = actual.local_revision().unwrap();
        actual.conn.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON tasks WHEN new.id='b' BEGIN SELECT RAISE(ABORT,'restore failed'); END").unwrap();
        let table = actual.schema.table("tasks").unwrap().clone();
        let segment = RowsSegment {
            table: "tasks".into(),
            schema_version: 1,
            columns: table.wire_columns.clone(),
            blocks: vec![vec![ssp2::segment::SegmentRow {
                server_version: 9,
                values: vec![
                    Some(ColumnValue::String("b".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String("fresh".into())),
                ],
            }]],
        };
        assert!(actual
            .apply_segment(&table, &segment, false, &scopes, &[])
            .is_err());
        assert!(actual.conn.is_autocommit());
        assert_eq!(
            actual
                .query("SELECT * FROM tasks ORDER BY id", &[])
                .unwrap(),
            before
        );
        assert_eq!(
            actual
                .query("SELECT * FROM tasks_fts ORDER BY _syncular_source_id", &[])
                .unwrap(),
            fts_before
        );
        assert_eq!(actual.local_revision().unwrap(), revision);
        assert_eq!(actual.pending_commit_ids(), pending);
    }
}

#[test]
fn import_reconciliation_preserves_typed_pending_primary_keys() {
    for (kind, a, b) in [
        ("string", json!("a"), json!("b")),
        ("integer", json!(1), json!(2)),
        ("boolean", json!(true), json!(false)),
        ("json", json!("1"), json!("2")),
    ] {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[{"name":"id","type":kind,"nullable":false},{"name":"title","type":"string","nullable":false}],"scopes":[],"indexes":[{"name":"unique_title","columns":["title"],"unique":true}]}]});
        for images in [false, true] {
            let mut client =
                SyncClient::new("typed".into(), &schema, ClientLimits::default()).unwrap();
            let table = client.schema.table("tasks").unwrap().clone();
            for (id, title) in [(&a, "original"), (&b, "occupied")] {
                client
                    .write_base_row(
                        "tasks",
                        &vec![
                            json_to_column_value(&table.columns[0], Some(id)).unwrap(),
                            Some(ColumnValue::String(title.into())),
                        ],
                        1,
                    )
                    .unwrap();
            }
            client.rebuild_overlay_if_dirty().expect("rebuild overlay");
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), a.clone()),
                        ("title".into(), json!("available")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            client.overlay_rebuild_count.set(0);
            for (version, title, expected) in
                [(2, "available", "original"), (3, "occupied", "available")]
            {
                let values = vec![
                    json_to_column_value(&table.columns[0], Some(&b)).unwrap(),
                    Some(ColumnValue::String(title.into())),
                ];
                if images {
                    let image = Connection::open_in_memory().unwrap();
                    image.execute_batch("CREATE TABLE tasks(id PRIMARY KEY, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
                        CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
                        INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1);").unwrap();
                    image
                        .execute(
                            "INSERT INTO tasks VALUES (?1,?2,?3)",
                            rusqlite::params![RowParam::Cell(&values[0]), title, version],
                        )
                        .unwrap();
                    assert!(
                        matches!(
                            client.apply_sqlite_image(
                                &image,
                                &table,
                                false,
                                &[],
                                &[],
                                1,
                                7,
                                "digest"
                            ),
                            Ok(1)
                        ),
                        "{kind}, images={images}"
                    );
                } else {
                    let segment = RowsSegment {
                        table: "tasks".into(),
                        schema_version: 1,
                        columns: table.wire_columns.clone(),
                        blocks: vec![vec![ssp2::segment::SegmentRow {
                            server_version: version,
                            values,
                        }]],
                    };
                    assert!(
                        matches!(
                            client.apply_segment(&table, &segment, false, &[], &[]),
                            Ok(1)
                        ),
                        "{kind}"
                    );
                }
                let key = json_to_column_value(&table.columns[0], Some(&a)).unwrap();
                let actual: String = client
                    .conn
                    .query_row(
                        "SELECT title FROM tasks WHERE id=?1",
                        [RowParam::Cell(&key)],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(actual, expected, "{kind}, images={images}");
            }
            assert_eq!(client.overlay_rebuild_count.get(), 0);
        }
    }
}

fn unique_import_fixture(rows: usize) -> (SyncClient, Connection, TableSchema) {
    let schema = json!({"version":1,"tables": (["tasks", "notes"].map(|name| json!({
        "name":name,"primaryKey":"id","columns":[{"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false},{"name":"title","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}],"indexes":[{"name":format!("{name}_title"),"columns":["title"],"unique":true}],
        "ftsIndexes":[{"name":format!("{name}_fts"),"columns":["title"],"tokenize":"unicode61"}]
    })))});
    let mut client =
        SyncClient::new("unique-import".into(), &schema, ClientLimits::default()).unwrap();
    client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO _syncular_base_notes SELECT printf('%08d',x),'p2','note-'||x,1 FROM n").unwrap();
    client.rebuild_overlay().expect("rebuild overlay");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("offline")),
                ("project_id".into(), json!("p1")),
                ("title".into(), json!("pending edit")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let image = Connection::open_in_memory().unwrap();
    image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
        CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);").unwrap();
    image.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO tasks SELECT printf('%08d',x),'p1','item-'||x,1 FROM n",[rows]).unwrap();
    image
        .execute(
            "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',?1)",
            [rows],
        )
        .unwrap();
    client.overlay_rebuild_count.set(0);
    let table = client.schema.table("tasks").unwrap().clone();
    (client, image, table)
}

#[test]
fn sqlite_full_image_import_retains_the_first_code_and_recovers() {
    let (mut client, image, table) = unique_import_fixture(1);
    image
        .execute("UPDATE tasks SET title = ?1", ["full ".repeat(32768)])
        .unwrap();
    client
        .conn
        .execute_batch("PRAGMA max_page_count = 1")
        .unwrap();
    let effective = [("project_id".into(), vec!["p1".into()])];
    assert!(client
        .apply_sqlite_image(&image, &table, true, &effective, &[], 1, 7, "digest")
        .is_err());
    let failure = client.storage_failure.borrow().clone().unwrap();
    assert_eq!(failure.code, Some("client.storage_full"));
    assert_eq!(failure.sqlite_code, Some(13));
    assert!(!failure.message.contains("rollback"));
    assert!(client.conn.is_autocommit());
    client
        .conn
        .execute_batch("PRAGMA max_page_count = 1073741823")
        .unwrap();
    assert!(matches!(
        client.apply_sqlite_image(&image, &table, true, &effective, &[], 1, 7, "digest"),
        Ok(1)
    ));
    assert!(client.conn.is_autocommit());
}

#[test]
fn authoring_storage_failures_are_structured_and_scoped() {
    let path = std::env::temp_dir().join(format!(
        "syncular-authoring-failure-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"title","type":"string","nullable":false}],"scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client = SyncClient::open_path(
        "authoring".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .expect("open client");
    client.create_synced_tables().expect("create synced tables");
    // Return BUSY immediately rather than waiting out the file timeout.
    client.conn.busy_timeout(std::time::Duration::ZERO).unwrap();

    let upsert = |id: &str| {
        vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!(id)),
                ("project_id".into(), json!("p1")),
                ("title".into(), json!("first")),
            ]),
            base_version: None,
        }]
    };

    let locker = Connection::open(&path).expect("second connection");
    locker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let busy = client.mutate(upsert("t1")).expect_err("busy write");
    assert_eq!(busy.code, "client.storage_busy");
    assert!(busy.retryable);
    assert_eq!(busy.details.as_ref().unwrap()["sqliteCode"], 5);
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(client.local_revision().unwrap(), 0);

    // A stale classified failure must not classify a later unrelated one.
    let invalid = client.mutate(Vec::new()).expect_err("empty commit");
    assert_eq!(invalid.code, "sync.invalid_request");
    assert_eq!(invalid.message, "the authoring request is invalid");
    assert!(
        invalid.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap()
            .contains("at least one operation"),
        "{invalid:?}"
    );

    locker.execute_batch("ROLLBACK").unwrap();
    let id = client.mutate(upsert("t1")).expect("retry after busy");
    assert_eq!(client.pending_commit_ids(), vec![id]);
    assert_eq!(client.local_revision().unwrap(), 1);

    // A later storage failure reports its own code and details.
    locker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let busy_again = client.mutate(upsert("t2")).expect_err("busy write again");
    assert_eq!(busy_again.code, "client.storage_busy");
    assert!(busy_again.retryable);
    locker.execute_batch("ROLLBACK").unwrap();

    // Non-retryable classified failures keep their sqlite evidence too.
    let full = ClientError::from(QueryReadFailure::from(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(13),
        Some("database or disk is full".to_owned()),
    )));
    assert_eq!(full.code, "client.storage_full");
    assert!(!full.retryable);
    assert_eq!(full.details.as_ref().unwrap()["sqliteCode"], 13);

    drop(locker);
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn query_rows_never_carry_the_unaliased_physical_version_column() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client =
        SyncClient::new("star".into(), &schema, ClientLimits::default()).expect("client");
    client.create_synced_tables().expect("create synced tables");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), Value::from("t1")),
                ("project_id".into(), Value::from("p1")),
            ]),
            base_version: None,
        }])
        .expect("mutate");
    let row = Map::from_iter([
        ("id".to_owned(), json!("t1")),
        ("project_id".to_owned(), json!("p1")),
    ]);
    assert_eq!(
        client.query("SELECT * FROM tasks", &[]),
        Ok(vec![row.clone()])
    );
    assert_eq!(
        client.query("SELECT id, project_id, _syncular_version FROM tasks", &[]),
        Ok(vec![row.clone()])
    );
    let mut aliased = row;
    aliased.insert("v".to_owned(), json!(-1));
    assert_eq!(
        client.query("SELECT *, _sync_version AS v FROM tasks", &[]),
        Ok(vec![aliased])
    );
}

#[test]
fn caller_value_failures_are_invalid_request_and_leave_no_outbox_entry() {
    let path = std::env::temp_dir().join(format!(
        "syncular-caller-values-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"title","type":"string","nullable":false},
        {"name":"priority","type":"integer","nullable":false},
        {"name":"payload","type":"bytes","nullable":false},
        {"name":"extra","type":"bytes","nullable":true},
        {"name":"doc","type":"json","nullable":true},
        {"name":"file","type":"blob_ref","nullable":true}],"scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client = SyncClient::open_path(
        "caller-values".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .expect("open client");
    client.create_synced_tables().expect("create synced tables");

    let values = |id: &str| {
        Map::from_iter([
            ("id".to_owned(), json!(id)),
            ("project_id".to_owned(), json!("p1")),
            ("title".to_owned(), json!("first")),
            ("priority".to_owned(), json!(1)),
            ("payload".to_owned(), json!({"$bytes": "0a"})),
        ])
    };
    let upsert = |values: Map<String, Value>| {
        vec![Mutation::Upsert {
            table: "tasks".into(),
            values,
            base_version: None,
        }]
    };
    let seed = client.mutate(upsert(values("t1"))).expect("seed row");
    let rows = client.query("SELECT * FROM tasks", &[]).unwrap();

    // §6.1/§7.1: every caller value the authoring seam rejects reports the
    // same stable identity instead of the internal-failure default, keeps
    // the dynamic cause in `details.legacyCause`, and leaves the durable
    // outbox, the local revision and the projection untouched.
    for (label, override_value, cause) in [
        ("unknown column", ("nope", json!(1)), "unknown column"),
        (
            "internal sync column",
            ("_sync_version", json!(1)),
            "internal sync column",
        ),
        ("wrong value type", ("title", json!(7)), "expected a string"),
        (
            "malformed bytes envelope",
            ("payload", json!({"$bytes": "zz"})),
            "expected exactly",
        ),
        (
            "odd-length bytes envelope",
            ("payload", json!({"$bytes": "abc"})),
            "expected exactly",
        ),
        (
            "plus-sign bytes envelope",
            ("payload", json!({"$bytes": "+a"})),
            "expected exactly",
        ),
        (
            "bytes envelope with a second key",
            ("payload", json!({"$bytes": "0a", "extra": 1})),
            "expected exactly",
        ),
        (
            "no bytes envelope",
            ("payload", json!({"nested": true})),
            "expected exactly",
        ),
        // §2.4/§7.1: the push admission values the server rejects.
        (
            "string with U+0000",
            ("title", json!("a\u{0}b")),
            "not a push admission value",
        ),
        (
            "json number beyond binary64",
            ("doc", json!("[1e999]")),
            "not a push admission value",
        ),
        (
            "json nested 65 deep",
            (
                "doc",
                json!(format!("{}{}", "[".repeat(65), "]".repeat(65))),
            ),
            "not a push admission value",
        ),
        (
            "blob_ref with reordered keys",
            (
                "file",
                json!(format!(
                    "{{\"byteLength\":3,\"blobId\":\"sha256:{}\"}}",
                    "0".repeat(64)
                )),
            ),
            "not a push admission value",
        ),
    ] {
        let mut full = values("t2");
        full.insert(override_value.0.to_owned(), override_value.1);
        let error = client.mutate(upsert(full)).expect_err(label);
        assert_eq!(error.code, "sync.invalid_request", "{label}: {error:?}");
        assert_eq!(error.message, "the authoring request is invalid", "{label}");
        assert!(!error.retryable, "{label}");
        let legacy = error.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap();
        assert!(
            legacy.starts_with("sync.invalid_request: ") && legacy.contains(cause),
            "{label}: {legacy}"
        );
        assert_eq!(client.pending_commit_ids(), vec![seed.clone()], "{label}");
        assert_eq!(client.local_revision().unwrap(), 1, "{label}");
        assert_eq!(
            client.query("SELECT * FROM tasks", &[]).unwrap(),
            rows,
            "{label}"
        );
    }

    // A full-row upsert presents every column, so a missing required one is
    // the caller's failure too.
    let mut missing = values("t3");
    missing.remove("payload");
    let missing_error = client.mutate(upsert(missing)).expect_err("missing column");
    assert_eq!(missing_error.code, "sync.invalid_request");
    assert!(missing_error.details.as_ref().unwrap()["legacyCause"]
        .as_str()
        .unwrap()
        .contains("is not nullable"));

    // A primary key the wire cannot render is rejected before any op is
    // recorded.
    let mut bad_row_id = values("t4");
    bad_row_id.insert("id".to_owned(), json!({"nested": true}));
    let row_id_error = client.mutate(upsert(bad_row_id)).expect_err("bad rowId");
    assert_eq!(row_id_error.code, "sync.invalid_request");

    // The sparse route classifies the same value failures.
    for (label, partial, cause) in [
        (
            "patch wrong value type",
            ("priority", json!("high")),
            "expected an integer",
        ),
        ("patch unknown column", ("nope", json!(1)), "unknown column"),
        (
            "patch string with U+0000",
            ("title", json!("\u{0}")),
            "not a push admission value",
        ),
    ] {
        let error = client
            .patch(
                "tasks",
                "t1",
                Map::from_iter([(partial.0.to_owned(), partial.1)]),
                None,
            )
            .expect_err(label);
        assert_eq!(error.code, "sync.invalid_request", "{label}: {error:?}");
        assert_eq!(error.message, "the authoring request is invalid", "{label}");
        assert!(
            error.details.as_ref().unwrap()["legacyCause"]
                .as_str()
                .unwrap()
                .contains(cause),
            "{label}"
        );
    }
    let delete_error = client
        .mutate(vec![Mutation::Delete {
            table: "tasks".into(),
            row_id: "t\u{0}1".into(),
            base_version: None,
        }])
        .expect_err("rowId with U+0000");
    assert_eq!(delete_error.code, "sync.invalid_request");
    assert_eq!(client.pending_commit_ids(), vec![seed.clone()]);
    assert_eq!(client.local_revision().unwrap(), 1);
    assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);

    // Nullable explicit null, an empty envelope, and uppercase digits stay
    // accepted; the stored payload is the decoded byte sequence.
    for (label, payload) in [
        ("explicit null", json!(null)),
        ("empty envelope", json!({"$bytes": ""})),
        ("uppercase envelope", json!({"$bytes": "0AFF"})),
    ] {
        let mut accepted = values("t-ok");
        accepted.insert("extra".to_owned(), payload);
        let encoded = client.mutate(upsert(accepted)).unwrap_or_else(|error| {
            panic!("{label} must be accepted: {error:?}");
        });
        assert!(!encoded.is_empty(), "{label}");
    }

    // Nothing is poisoned: the next valid authoring call succeeds.
    let next = client
        .mutate(upsert(values("t5")))
        .expect("valid after failures");
    assert_ne!(next, seed);

    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_legacy_outbox_value_the_codec_refuses_is_dropped_instead_of_wedging() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"payload","type":"bytes","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let open = |path: &std::path::Path| {
        SyncClient::open_path(
            "legacy-values".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client")
    };
    let row = |id: &str| {
        Map::from_iter([
            ("id".to_owned(), json!(id)),
            ("project_id".to_owned(), json!("p1")),
            ("payload".to_owned(), json!({"$bytes": "0a"})),
        ])
    };
    let upsert = |values| {
        vec![Mutation::Upsert {
            table: "tasks".into(),
            values,
            base_version: None,
        }]
    };
    for (label, stored_cell, representable) in [
        ("plus-sign envelope", json!({"$bytes": "+a"}), false),
        ("non-hex envelope", json!({"$bytes": "zz"}), false),
        ("odd-length envelope", json!({"$bytes": "abc"}), false),
        ("no envelope", json!({"nested": true}), false),
        // A wrong declared type and a stored null for a non-nullable column
        // are journalable as stored, so their rejection keeps the operation
        // envelope.
        ("wrong declared type", json!("high"), true),
        ("stored null for a non-nullable column", json!(null), true),
    ] {
        let path = std::env::temp_dir().join(format!(
            "syncular-legacy-values-{}-{}.db",
            label.replace(' ', "-"),
            uuid::Uuid::new_v4()
        ));
        let mut client = open(&path);
        client.create_synced_tables().expect("create synced tables");
        let stale = client.mutate(upsert(row("t1"))).expect("stale commit");
        let successor = client.mutate(upsert(row("t2"))).expect("successor commit");
        drop(client);

        // The stored intent an earlier version accepted.
        let connection = Connection::open(&path).expect("raw connection");
        let (column, cell) = if stored_cell.is_null() {
            ("project_id", stored_cell.clone())
        } else {
            ("payload", stored_cell.clone())
        };
        let mut planted_values = json!({
            "id": "t1", "project_id": "p1", "payload": {"$bytes": "0a"}
        });
        planted_values[column] = cell;
        let planted = json!([{
            "op": "upsert",
            "table": "tasks",
            "rowId": "t1",
            "baseVersion": null,
            "values": planted_values
        }]);
        connection
            .execute(
                "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                rusqlite::params![planted.to_string(), stale],
            )
            .expect("plant legacy intent");
        drop(connection);

        // Reopen: the startup reconciliation recovers the commit before any
        // replay, so the observable phase matches the browser core.
        let reopened = open(&path);
        assert_eq!(
            reopened.pending_commit_ids(),
            vec![successor.clone()],
            "{label}"
        );
        let rejection = reopened
            .rejections()
            .iter()
            .find(|rejection| rejection.client_commit_id == stale)
            .unwrap_or_else(|| panic!("{label}: rejection"));
        assert_eq!(rejection.code, OUTBOX_INCOMPATIBLE_CODE, "{label}");
        assert_eq!(
            rejection.message, "the persisted commit carries values the current codec refuses",
            "{label}"
        );
        assert_eq!(rejection.operation.is_some(), representable, "{label}");
        assert_eq!(
            rejection
                .details
                .as_ref()
                .and_then(|details| details.reason.as_deref()),
            Some(INVALID_STORED_VALUES_REASON),
            "{label}"
        );
        // The rejection stays readable after a further reopen.
        let journal = reopened
            .commit_outcome(&stale)
            .expect("read outcome")
            .expect("journal entry");
        assert!(matches!(journal.status, CommitOutcomeStatus::Rejected));
        drop(reopened);
        let mut reopened = open(&path);
        let reread = reopened
            .commit_outcome(&stale)
            .expect("read outcome")
            .expect("journal entry");
        assert!(matches!(reread.status, CommitOutcomeStatus::Rejected));

        // The legacy row's optimistic projection is gone, the successor
        // survives and still encodes, and the round path keeps the queue.
        assert_eq!(
            reopened
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .unwrap(),
            vec![Map::from_iter([("id".to_owned(), json!("t2"))])],
            "{label}"
        );
        assert_eq!(reopened.pending_commit_ids(), vec![successor.clone()]);
        assert_eq!(reopened.pending_payloads().unwrap().len(), 1, "{label}");
        assert!(!reopened
            .drop_unencodable_outbox(false, None)
            .expect("idempotent prepass"));
        let mut transport = CountingRealtimeTransport::default();
        let outcome = reopened.sync(&mut transport);
        assert!(matches!(outcome, SyncOutcome::Failed { .. }), "{outcome:?}");
        assert_eq!(reopened.pending_commit_ids(), vec![successor.clone()]);
        let next = reopened.mutate(upsert(row("t3"))).expect("after the drop");
        assert_eq!(reopened.pending_commit_ids(), vec![successor, next]);
        assert_eq!(reopened.pending_payloads().unwrap().len(), 2, "{label}");
        drop(reopened);
        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn two_legacy_values_on_the_same_row_recover_in_fifo_order() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"payload","type":"bytes","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    for (label, column, planted) in [
        ("malformed envelope", "payload", json!({"$bytes": "zz"})),
        (
            "stored null for a non-nullable column",
            "project_id",
            json!(null),
        ),
        ("wrong declared type", "payload", json!(7)),
    ] {
        let path = std::env::temp_dir().join(format!(
            "syncular-shared-row-{}-{}.db",
            label.replace(' ', "-"),
            uuid::Uuid::new_v4()
        ));
        let open = |path: &std::path::Path| {
            SyncClient::open_path(
                "shared-row".into(),
                &schema,
                ClientLimits::default(),
                path.to_str().unwrap(),
            )
            .expect("open client")
        };
        let row = |id: &str| {
            Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("project_id".to_owned(), json!("p1")),
                ("payload".to_owned(), json!({"$bytes": "0a"})),
            ])
        };
        let upsert = |values| {
            vec![Mutation::Upsert {
                table: "tasks".into(),
                values,
                base_version: None,
            }]
        };
        let mut client = open(&path);
        client.create_synced_tables().expect("create synced tables");
        let older = client.mutate(upsert(row("t1"))).expect("older commit");
        let newer = client.mutate(upsert(row("t1"))).expect("newer commit");
        let successor = client.mutate(upsert(row("t2"))).expect("successor commit");
        drop(client);

        let connection = Connection::open(&path).expect("raw connection");
        for commit_id in [&older, &newer] {
            let mut values = row("t1");
            values.insert(column.to_owned(), planted.clone());
            let planted_ops = json!([{
                "op": "upsert",
                "table": "tasks",
                "rowId": "t1",
                "baseVersion": null,
                "values": values
            }]);
            connection
                .execute(
                    "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                    rusqlite::params![planted_ops.to_string(), commit_id],
                )
                .expect("plant legacy intent");
        }
        drop(connection);

        // Startup recovery drops both, FIFO, and publishes one batch.
        let mut reopened = open(&path);
        assert_eq!(
            reopened.pending_commit_ids(),
            vec![successor.clone()],
            "{label}"
        );
        assert_eq!(
            reopened
                .rejections()
                .iter()
                .map(|rejection| rejection.client_commit_id.clone())
                .collect::<Vec<_>>(),
            vec![older.clone(), newer.clone()],
            "{label}"
        );
        assert!(
            reopened
                .rejections()
                .iter()
                .all(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE
                    && rejection.details.as_ref().and_then(|d| d.reason.as_deref())
                        == Some(INVALID_STORED_VALUES_REASON)),
            "{label}"
        );
        for commit_id in [&older, &newer] {
            assert!(
                matches!(
                    reopened
                        .commit_outcome(commit_id)
                        .expect("outcome")
                        .map(|o| o.status),
                    Some(CommitOutcomeStatus::Rejected)
                ),
                "{label}"
            );
        }
        assert_eq!(
            reopened
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .unwrap(),
            vec![Map::from_iter([("id".to_owned(), json!("t2"))])],
            "{label}"
        );
        let revision = reopened.local_revision().unwrap();
        let batches = reopened.drain_change_batches();
        assert!(
            batches.iter().any(|batch| batch.rejections_changed
                && batch.outcomes_changed
                && batch.tables.iter().any(|change| change.table == "tasks")
                && batch.revision == revision.to_string()),
            "{label}: {batches:?}"
        );
        drop(reopened);

        // An ordinary reopen with nothing to recover publishes nothing and
        // leaves the revision alone.
        let mut stable = open(&path);
        assert_eq!(stable.local_revision().unwrap(), revision, "{label}");
        assert!(stable.drain_change_batches().is_empty(), "{label}");
        assert_eq!(stable.pending_commit_ids(), vec![successor], "{label}");
        drop(stable);
        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn recovery_omits_a_legacy_operation_the_journal_reader_rejects() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"payload","type":"bytes","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    for (label, second_op) in [
        (
            "delete carrying values",
            json!({"op": "delete", "table": "tasks", "rowId": "t9", "values": {}}),
        ),
        (
            "baseVersion beyond the safe bound",
            json!({"op": "upsert", "table": "tasks", "rowId": "t9",
                "baseVersion": MAX_JS_SAFE_INTEGER + 1,
                "values": {"id": "t9", "project_id": "p1", "payload": {"$bytes": "0a"}}}),
        ),
    ] {
        let path = std::env::temp_dir().join(format!(
            "syncular-journal-shape-{}-{}.db",
            label.replace(' ', "-"),
            uuid::Uuid::new_v4()
        ));
        let open = |path: &std::path::Path| {
            SyncClient::open_path(
                "journal-shape".into(),
                &schema,
                ClientLimits::default(),
                path.to_str().unwrap(),
            )
            .expect("open client")
        };
        let values = |id: &str| {
            Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("project_id".to_owned(), json!("p1")),
                ("payload".to_owned(), json!({"$bytes": "0a"})),
            ])
        };
        let upsert = |values| {
            vec![Mutation::Upsert {
                table: "tasks".into(),
                values,
                base_version: None,
            }]
        };
        let mut client = open(&path);
        client.create_synced_tables().expect("create synced tables");
        let stale = client.mutate(upsert(values("t1"))).expect("stale commit");
        drop(client);

        let connection = Connection::open(&path).expect("raw connection");
        // The first operation triggers the drop with canonical cells (a
        // stored null for a non-nullable column); the second one is the
        // operation shape the journal reader refuses.
        let planted = json!([
            {
                "op": "upsert",
                "table": "tasks",
                "rowId": "t1",
                "baseVersion": null,
                "values": {"id": "t1", "project_id": null,
                    "payload": {"$bytes": "0a"}}
            },
            second_op
        ]);
        connection
            .execute(
                "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                rusqlite::params![planted.to_string(), stale],
            )
            .expect("plant legacy intent");
        drop(connection);

        let reopened = open(&path);
        let journal = reopened
            .commit_outcome(&stale)
            .unwrap_or_else(|error| panic!("{label}: journal read: {error}"))
            .unwrap_or_else(|| panic!("{label}: journal entry"));
        assert!(
            matches!(journal.status, CommitOutcomeStatus::Rejected),
            "{label}"
        );
        assert!(journal.operations.is_none(), "{label}");
        assert!(
            reopened
                .commit_outcomes(CommitOutcomeQuery::default())
                .is_ok(),
            "{label}: outcome list query"
        );
        assert!(reopened.pending_commit_ids().is_empty(), "{label}");
        drop(reopened);
        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn legacy_values_recover_at_the_recreate_and_bump_reset_boundaries() {
    let schema = |version: i32, extra: bool| {
        let mut columns = vec![
            json!({"name":"id","type":"string","nullable":false}),
            json!({"name":"project_id","type":"string","nullable":false}),
            json!({"name":"payload","type":"bytes","nullable":true}),
        ];
        if extra {
            columns.push(json!({"name":"later","type":"string","nullable":true}));
        }
        json!({"version":version,"tables":[{"name":"tasks","primaryKey":"id","columns":columns,
            "scopes":[{"pattern":"project:{project_id}"}]}]})
    };
    for (label, bump) in [
        ("same-version recreation", false),
        ("version-bump reset", true),
        ("version-only bump reset", true),
    ] {
        let path = std::env::temp_dir().join(format!(
            "syncular-legacy-reset-{}-{}.db",
            label.replace(' ', "-"),
            uuid::Uuid::new_v4()
        ));
        let v1 = schema(1, false);
        let open = |schema: &Value, path: &std::path::Path| {
            SyncClient::open_path(
                "legacy-reset".into(),
                schema,
                ClientLimits::default(),
                path.to_str().unwrap(),
            )
            .expect("open client")
        };
        let row = |id: &str| {
            Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("project_id".to_owned(), json!("p1")),
                ("payload".to_owned(), json!({"$bytes": "0a"})),
            ])
        };
        let upsert = |values| {
            vec![Mutation::Upsert {
                table: "tasks".into(),
                values,
                base_version: None,
            }]
        };
        let mut client = open(&v1, &path);
        client.create_synced_tables().expect("create synced tables");
        let stale = client.mutate(upsert(row("t1"))).expect("stale commit");
        let successor = client.mutate(upsert(row("t2"))).expect("successor commit");
        drop(client);

        let connection = Connection::open(&path).expect("raw connection");
        let planted = json!([{
            "op": "upsert",
            "table": "tasks",
            "rowId": "t1",
            "baseVersion": null,
            "values": {"id": "t1", "project_id": 7, "payload": {"$bytes": "0a"}}
        }]);
        connection
            .execute(
                "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                rusqlite::params![planted.to_string(), stale],
            )
            .expect("plant legacy intent");
        drop(connection);

        let target = if bump {
            schema(2, label == "version-bump reset")
        } else {
            v1.clone()
        };
        let reopened = open(&target, &path);
        let rejection = reopened
            .rejections()
            .iter()
            .find(|rejection| rejection.client_commit_id == stale)
            .unwrap_or_else(|| panic!("{label}: rejection"));
        assert_eq!(rejection.code, OUTBOX_INCOMPATIBLE_CODE, "{label}");
        assert_eq!(
            rejection
                .details
                .as_ref()
                .and_then(|details| details.reason.as_deref()),
            Some(INVALID_STORED_VALUES_REASON),
            "{label}"
        );
        assert!(rejection.operation.is_some(), "{label}");
        assert_eq!(
            reopened.pending_commit_ids(),
            vec![successor.clone()],
            "{label}"
        );
        // The successor survives and still encodes. It carries §7.1
        // insert intent, so after a bump that appends a nullable column it
        // replays as a full row with that column NULL.
        assert_eq!(reopened.pending_payloads().unwrap().len(), 1, "{label}");
        if label == "version-bump reset" {
            assert_eq!(
                reopened
                    .query("SELECT id, later FROM tasks ORDER BY id", &[])
                    .unwrap(),
                vec![Map::from_iter([
                    ("id".to_owned(), json!("t2")),
                    ("later".to_owned(), Value::Null),
                ])],
                "{label}"
            );
            // The guarded bump reset owns the publication, so its change
            // batch carries the recovery's rejection, outcome, and table
            // domains at the revision it advanced to.
            let mut next = reopened;
            let revision = next.local_revision().unwrap();
            let batches = next.drain_change_batches();
            assert!(
                batches.iter().any(|batch| batch.rejections_changed
                    && batch.outcomes_changed
                    && batch.tables.iter().any(|change| change.table == "tasks")
                    && batch.revision == revision.to_string()),
                "{label}: {batches:?}"
            );
            next.mutate(upsert(Map::from_iter([
                ("id".to_owned(), json!("t3")),
                ("project_id".to_owned(), json!("p1")),
                ("payload".to_owned(), json!({"$bytes": "0b"})),
                ("later".to_owned(), json!("v2")),
            ])))
            .expect("v2 authoring after the reset");
            assert_eq!(next.pending_commit_ids().len(), 2, "{label}");
            assert_eq!(next.pending_payloads().unwrap().len(), 2, "{label}");
            drop(next);
        } else {
            assert_eq!(
                reopened
                    .query("SELECT id FROM tasks ORDER BY id", &[])
                    .unwrap(),
                vec![Map::from_iter([("id".to_owned(), json!("t2"))])],
                "{label}"
            );
            drop(reopened);
        }

        // Queue and corrupt a new commit while the client stays open so only
        // recreation can recover it.
        if !bump {
            let mut recreated = open(&v1, &path);
            let fresh = recreated
                .mutate(upsert(row("t3")))
                .expect("fresh commit while open");
            recreated.drain_change_batches();
            let planted_fresh = json!([{
                "op": "upsert",
                "table": "tasks",
                "rowId": "t3",
                "baseVersion": null,
                "values": {"id": "t3", "project_id": "p1",
                    "payload": {"$bytes": "zz"}}
            }]);
            let connection = Connection::open(&path).expect("raw connection");
            let affected = connection
                .execute(
                    "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                    rusqlite::params![planted_fresh.to_string(), fresh],
                )
                .expect("plant fresh legacy intent");
            assert_eq!(
                affected, 1,
                "{label}: the in-place plant must hit the queued commit"
            );
            drop(connection);
            let revision_before = recreated.local_revision().unwrap();
            recreated
                .recreate_with_schema(&v1)
                .unwrap_or_else(|error| panic!("{label}: recreation failed: {error}"));
            assert_eq!(recreated.pending_commit_ids(), vec![successor], "{label}");
            let fresh_rejection = recreated
                .rejections()
                .iter()
                .find(|rejection| rejection.client_commit_id == fresh)
                .expect("the in-place recovery rejection");
            assert_eq!(fresh_rejection.code, OUTBOX_INCOMPATIBLE_CODE, "{label}");
            assert_eq!(
                fresh_rejection
                    .details
                    .as_ref()
                    .and_then(|details| details.reason.as_deref()),
                Some(INVALID_STORED_VALUES_REASON),
                "{label}"
            );
            assert!(
                matches!(
                    recreated
                        .commit_outcome(&fresh)
                        .expect("outcome read")
                        .map(|outcome| outcome.status),
                    Some(CommitOutcomeStatus::Rejected)
                ),
                "{label}"
            );
            assert!(
                recreated.local_revision().unwrap() > revision_before,
                "{label}"
            );
            let revision = recreated.local_revision().unwrap();
            let batches = recreated.drain_change_batches();
            assert_eq!(batches.len(), 1, "{label}: one recovery batch");
            assert!(
                batches.iter().any(|batch| batch.rejections_changed
                    && batch.outcomes_changed
                    && batch.tables.iter().any(|change| change.table == "tasks")
                    && batch.revision == revision.to_string()),
                "{label}: {batches:?}"
            );
            assert_eq!(recreated.pending_payloads().unwrap().len(), 1, "{label}");
            assert_eq!(
                recreated
                    .query("SELECT id FROM tasks ORDER BY id", &[])
                    .unwrap(),
                vec![Map::from_iter([("id".to_owned(), json!("t2"))])],
                "{label}: the recovered commit leaves no projection"
            );
            drop(recreated);
        }
        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn legacy_values_recover_over_a_synced_authoritative_row() {
    let path = std::env::temp_dir().join(format!(
        "syncular-authoritative-row-{}.db",
        uuid::Uuid::new_v4()
    ));
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"title","type":"string","nullable":false},
        {"name":"payload","type":"bytes","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let open = |path: &std::path::Path| {
        SyncClient::open_path(
            "authoritative-row".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client")
    };
    let row = |title: &str| {
        Map::from_iter([
            ("id".to_owned(), json!("t1")),
            ("project_id".to_owned(), json!("p1")),
            ("title".to_owned(), json!(title)),
            ("payload".to_owned(), json!({"$bytes": "0a"})),
        ])
    };
    let upsert = |values| {
        vec![Mutation::Upsert {
            table: "tasks".into(),
            values,
            base_version: None,
        }]
    };
    let mut client = open(&path);
    client.create_synced_tables().expect("create synced tables");
    // A server-confirmed row: base and visible carry the authoritative
    // values at version 1.
    client
        .conn
        .execute_batch(
            "INSERT INTO _syncular_base_tasks VALUES ('t1','p1','authoritative',x'0a',1);
             INSERT INTO tasks VALUES ('t1','p1','authoritative',x'0a',1);",
        )
        .expect("seed authoritative row");
    let older = client.mutate(upsert(row("older"))).expect("older");
    let newer = client.mutate(upsert(row("newer"))).expect("newer");
    let successor = client.mutate(upsert(row("successor"))).expect("successor");
    drop(client);

    let connection = Connection::open(&path).expect("raw connection");
    for commit_id in [&older, &newer] {
        let planted = json!([{
            "op": "upsert",
            "table": "tasks",
            "rowId": "t1",
            "baseVersion": null,
            "values": {"id": "t1", "project_id": "p1", "title": "legacy",
                "payload": {"$bytes": "zz"}}
        }]);
        connection
            .execute(
                "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
                rusqlite::params![planted.to_string(), commit_id],
            )
            .expect("plant legacy intent");
    }
    drop(connection);

    let reopened = open(&path);
    assert_eq!(reopened.pending_commit_ids(), vec![successor.clone()]);
    assert_eq!(
        reopened
            .rejections()
            .iter()
            .map(|rejection| rejection.client_commit_id.clone())
            .collect::<Vec<_>>(),
        vec![older.clone(), newer.clone()]
    );
    // The pending successor overlays the restored authoritative row, which
    // keeps its server version.
    assert_eq!(
        reopened.query("SELECT id,title,_sync_version AS version FROM tasks", &[]),
        Ok(vec![Map::from_iter([
            ("id".to_owned(), json!("t1")),
            ("title".to_owned(), json!("successor")),
            ("version".to_owned(), json!(1)),
        ])])
    );

    // A later rejection of the surviving successor restores the
    // authoritative values and version exactly.
    drop(reopened);
    let connection = Connection::open(&path).expect("raw connection");
    connection
        .execute(
            "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
            rusqlite::params![
                json!([{
                    "op": "upsert",
                    "table": "tasks",
                    "rowId": "t1",
                    "baseVersion": null,
                    "values": {"id": "t1", "project_id": "p1", "title": "legacy",
                        "payload": {"$bytes": "zz"}}
                }])
                .to_string(),
                successor
            ],
        )
        .expect("plant successor intent");
    drop(connection);
    let late = open(&path);
    assert!(late.pending_commit_ids().is_empty());
    assert_eq!(
        late.query("SELECT id,title,_sync_version AS version FROM tasks", &[]),
        Ok(vec![Map::from_iter([
            ("id".to_owned(), json!("t1")),
            ("title".to_owned(), json!("authoritative")),
            ("version".to_owned(), json!(1)),
        ])])
    );
    drop(late);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_failed_value_recovery_commit_restores_every_side_effect() {
    let path = std::env::temp_dir().join(format!(
        "syncular-value-recovery-commit-{}.db",
        uuid::Uuid::new_v4()
    ));
    let path_str = path.to_str().expect("path");
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"payload","type":"bytes","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    // A rollback-journal replica, so a second read connection can hold
    // SHARED across the recovery transaction's COMMIT.
    let conn = Connection::open(path_str).expect("replica connection");
    let mut client = SyncClient::with_connection(
        "value-recovery-commit".into(),
        &schema,
        ClientLimits::default(),
        conn,
    )
    .expect("replica");
    assert_eq!(
        client
            .conn
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("journal mode"),
        "delete"
    );
    client.create_synced_tables().expect("create synced tables");
    let stale = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".to_owned(), json!("t1")),
                ("project_id".to_owned(), json!("p1")),
                ("payload".to_owned(), json!({"$bytes": "0a"})),
            ]),
            base_version: None,
        }])
        .expect("queued write");
    client.drain_change_batches();
    let affected = client
        .conn
        .execute(
            "UPDATE _syncular_outbox SET ops_json=? WHERE commit_id=?",
            rusqlite::params![
                json!([{
                    "op": "upsert",
                    "table": "tasks",
                    "rowId": "t1",
                    "baseVersion": null,
                    "values": {"id": "t1", "project_id": "p1",
                        "payload": {"$bytes": "zz"}}
                }])
                .to_string(),
                stale
            ],
        )
        .expect("plant legacy intent");
    assert_eq!(affected, 1, "the planted row must exist");
    let revision = client.local_revision().unwrap();
    let rows = client.query("SELECT * FROM tasks", &[]).expect("rows");
    let prior_outbox = client.pending_commit_ids();
    let prior_rejections = client.rejections().len();
    let prior_changes = client.change_queue.len();
    let prior_intents = client.sync_intent_queue.len();
    let prior_failed = client.failed_commits.len();
    // The reader holds SHARED for the whole attempt: the recovery runs to
    // its publication and the COMMIT fails.
    let reader = Connection::open(path_str).expect("reader");
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
        .expect("reader snapshot");
    client
        .conn
        .busy_timeout(std::time::Duration::ZERO)
        .expect("busy timeout");
    let error = client
        .recreate_with_schema(&schema)
        .expect_err("a blocked COMMIT must refuse the recovery");
    assert!(error.starts_with("client.storage_busy:"), "{error}");
    assert!(client.conn.is_autocommit(), "the transaction is released");
    assert_eq!(client.local_revision().unwrap(), revision);
    assert_eq!(client.pending_commit_ids(), prior_outbox);
    assert_eq!(client.rejections().len(), prior_rejections);
    assert_eq!(client.change_queue.len(), prior_changes);
    assert_eq!(client.sync_intent_queue.len(), prior_intents);
    assert_eq!(client.failed_commits.len(), prior_failed);
    assert_eq!(
        client.query("SELECT * FROM tasks", &[]).expect("rows"),
        rows
    );
    assert!(
        client
            .commit_outcome(&stale)
            .expect("outcome read")
            .is_none(),
        "the rolled-back recovery kept no outcome"
    );
    // The retry runs the same publication branch to completion.
    reader.execute_batch("ROLLBACK").expect("release reader");
    client
        .recreate_with_schema(&schema)
        .expect("retry after the blocked commit");
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(client.rejections().len(), prior_rejections + 1);
    assert!(client.local_revision().unwrap() > revision);
    let batches = client.drain_change_batches();
    assert!(
        batches.iter().any(|batch| batch.rejections_changed
            && batch.outcomes_changed
            && batch.tables.iter().any(|change| change.table == "tasks")),
        "{batches:?}"
    );
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[cfg(feature = "e2ee")]
#[test]
fn a_failed_recovery_restores_retained_failed_commits() {
    let path = std::env::temp_dir().join(format!(
        "syncular-value-recovery-retention-{}.db",
        uuid::Uuid::new_v4()
    ));
    let path_str = path.to_str().expect("path");
    let schema = json!({"version":1,"tables":[{"name":"secrets","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"note","type":"bytes","nullable":true,"encrypted":true,"declaredType":"string"}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let conn = Connection::open(path_str).expect("replica connection");
    let mut client = SyncClient::with_connection(
        "value-recovery-retention".into(),
        &schema,
        ClientLimits::default(),
        conn,
    )
    .expect("replica");
    client.create_synced_tables().expect("create synced tables");
    client.set_retain_failed_commits(true).expect("retention");
    // No keys configured: the §5.11 seal fails, so retention is exercised.
    client.set_encryption(crate::values::EncryptionConfig::default());
    client
        .mutate(vec![Mutation::Upsert {
            table: "secrets".into(),
            values: Map::from_iter([
                ("id".to_owned(), json!("s1")),
                ("project_id".to_owned(), json!("p1")),
                ("note".to_owned(), json!("secret")),
            ]),
            base_version: None,
        }])
        .expect("queued write");
    client.drain_change_batches();
    let revision = client.local_revision().unwrap();
    let prior_outbox = client.pending_commit_ids();
    let prior_rejections = client.rejections().len();
    let prior_failed = client.failed_commits.len();
    let reader = Connection::open(path_str).expect("reader");
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
        .expect("reader snapshot");
    client
        .conn
        .busy_timeout(std::time::Duration::ZERO)
        .expect("busy timeout");
    let error = client
        .drop_unencodable_outbox(true, None)
        .expect_err("a blocked COMMIT must refuse the recovery");
    assert!(error.starts_with("client.storage_busy:"), "{error}");
    assert_eq!(client.failed_commits.len(), prior_failed);
    assert_eq!(client.pending_commit_ids(), prior_outbox);
    assert_eq!(client.rejections().len(), prior_rejections);
    assert_eq!(client.local_revision().unwrap(), revision);
    // The retry retains the failed commit and drops it from the outbox.
    reader.execute_batch("ROLLBACK").expect("release reader");
    client
        .drop_unencodable_outbox(true, None)
        .expect("retry after the blocked commit");
    assert_eq!(client.failed_commits.len(), prior_failed + 1);
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(client.rejections().len(), prior_rejections + 1);
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn client_error_maps_legacy_codes_and_static_messages() {
    let code_only = ClientError::from("sync.unknown_table".to_owned());
    assert_eq!(code_only.code, "sync.unknown_table");
    assert_eq!(code_only.message, "the commit targets an unknown table");
    assert!(code_only.details.is_none());

    let dynamic = ClientError::from(
        "sync.invalid_request: table \"tasks\": patch cannot write scope column".to_owned(),
    );
    assert_eq!(dynamic.code, "sync.invalid_request");
    assert_eq!(dynamic.message, "the authoring request is invalid");
    assert!(dynamic.details.as_ref().unwrap()["legacyCause"]
        .as_str()
        .unwrap()
        .contains("patch cannot write scope column"));

    let unclassified = ClientError::from("a commit must contain at least one operation".to_owned());
    assert_eq!(unclassified.code, "client.failed");
    assert_eq!(unclassified.message, "the local authoring operation failed");
    assert!(unclassified.details.as_ref().unwrap()["legacyCause"]
        .as_str()
        .unwrap()
        .contains("at least one operation"));

    // An unclassified QueryReadFailure keeps its numeric SQLite evidence.
    let metadata = ClientError::from(QueryReadFailure {
        code: None,
        sqlite_code: Some(1),
        sqlite_message: Some("generic SQLite prose".to_owned()),
        rollback_failure: Some(Box::new(QueryReadFailure::from(
            rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), None),
        ))),
        message: "unclassified read".to_owned(),
    });
    assert_eq!(metadata.code, "client.failed");
    assert_eq!(metadata.message, "the local authoring operation failed");
    let details = metadata.details.as_ref().unwrap();
    assert_eq!(details["sqliteCode"], 1);
    assert_eq!(details["sqliteMessage"], "generic SQLite prose");
    assert_eq!(details["rollbackFailure"]["sqliteCode"], 1);
    assert_eq!(details["legacyCause"], "unclassified read");
}

#[test]
fn schema_marker_read_keeps_storage_classification() {
    let busy = schema_marker_read_failure(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(5),
        Some("database is locked".to_owned()),
    ));
    assert!(busy.starts_with("client.storage_busy:"), "{busy}");
    let invalid = schema_marker_read_failure(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(1),
        Some("unreadable".to_owned()),
    ));
    assert_eq!(
        invalid,
        "sync.local_corrupt: persisted local schema marker is unreadable or invalid"
    );

    // A real exclusive lock on the marker read surfaces BUSY, not corrupt,
    // and the guard writes nothing.
    let path =
        std::env::temp_dir().join(format!("syncular-marker-busy-{}.db", uuid::Uuid::new_v4()));
    let setup = Connection::open(&path).expect("setup connection");
    setup
        .execute_batch(
            "CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value TEXT);\n                 INSERT INTO _syncular_meta VALUES ('localSchemaVersion','1');",
        )
        .unwrap();
    let locker = Connection::open(&path).expect("locker connection");
    locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let reader = Connection::open(&path).expect("reader connection");
    reader.busy_timeout(std::time::Duration::ZERO).unwrap();
    let locked = read_local_schema_version(&reader, 1).expect_err("locked marker read");
    assert!(locked.starts_with("client.storage_busy:"), "{locked}");
    locker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(read_local_schema_version(&reader, 1).unwrap(), Some(1));
    let rows = setup
        .query_row("SELECT count(*) FROM _syncular_meta", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(rows, 1, "the guard performed no writes");
    drop(reader);
    drop(locker);
    drop(setup);
    let _ = std::fs::remove_file(&path);
}

#[cfg(feature = "crdt-yjs")]
#[test]
fn crdt_authoring_pre_read_preserves_storage_classification() {
    let path = std::env::temp_dir().join(format!("syncular-crdt-busy-{}.db", uuid::Uuid::new_v4()));
    let schema = json!({"version":1,"tables":[{"name":"notes","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"doc","type":"crdt","nullable":true,"crdtType":"yjs-doc"}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let mut client = SyncClient::open_path(
        "crdt-busy".into(),
        &schema,
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .expect("open client");
    client.create_synced_tables().expect("create synced tables");
    client.conn.busy_timeout(std::time::Duration::ZERO).unwrap();

    let locker = Connection::open(&path).expect("locker connection");
    locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let busy = client
        .crdt_apply_update("notes", "n1", "doc", &[])
        .expect_err("busy crdt pre-read");
    assert_eq!(busy.code, "client.storage_busy");
    assert!(busy.retryable);
    assert_eq!(busy.details.as_ref().unwrap()["sqliteCode"], 5);
    assert!(client.pending_commit_ids().is_empty());
    let revision_error = client
        .local_revision()
        .expect_err("a locked database fails the revision read");
    assert!(
        revision_error.starts_with("client.storage_busy"),
        "{revision_error}"
    );

    locker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(client.local_revision().unwrap(), 0);
    drop(locker);
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn large_unique_import_copies_no_unrelated_tables() {
    let (mut client, image, table) = unique_import_fixture(10240);
    let pending = client.pending_commit_ids();
    client.conn.execute_batch("CREATE TRIGGER unrelated_insert BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'unrelated insert'); END;
        CREATE TRIGGER unrelated_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'unrelated delete'); END;").unwrap();
    assert!(matches!(
        client.apply_sqlite_image(
            &image,
            &table,
            true,
            &[("project_id".into(), vec!["p1".into()])],
            &[],
            10240,
            7,
            "digest"
        ),
        Ok(10240)
    ));
    assert_eq!(client.overlay_rebuild_count.get(), 0);
    assert_eq!(client.pending_commit_ids(), pending);
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks", &[])
            .unwrap()[0]["n"],
        10241
    );
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM tasks_fts", &[])
            .unwrap()[0]["n"],
        10241
    );
    assert_eq!(
        client
            .query("SELECT count(*) AS n FROM notes_fts", &[])
            .unwrap()[0]["n"],
        8192
    );
}

#[test]
#[ignore = "manual scaling benchmark; see bench/README.md"]
fn benchmark_unique_image_import() {
    let mut samples = Vec::new();
    for rows in [10240, 51200, 102400] {
        for trial in 0..4 {
            let (mut client, image, table) = unique_import_fixture(rows);
            let start = std::time::Instant::now();
            assert!(
                matches!(client.apply_sqlite_image(&image,&table,true,&[("project_id".into(),vec!["p1".into()])], &[],rows as i64,7,"digest"),Ok(n) if n as usize == rows)
            );
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM tasks", &[])
                    .unwrap()[0]["n"],
                rows + 1
            );
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM tasks_fts", &[])
                    .unwrap()[0]["n"],
                rows + 1
            );
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM notes_fts", &[])
                    .unwrap()[0]["n"],
                8192
            );
            assert_eq!(client.pending_commit_ids().len(), 1);
            if trial > 0 {
                samples.push(json!({"rows":rows,"trial":trial,"elapsedMs":elapsed,"fullRebuilds":client.overlay_rebuild_count.get()}));
            }
        }
    }
    let artifact = json!({"boundary":"Rust core; in-memory SQLite; one pending edit; secondary unique indexes and FTS; 8192 unrelated rows; one warmup per size","optimized":!cfg!(debug_assertions),"sqliteVersion":rusqlite::version(),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"sourceHash":bytes_to_hex(&Sha256::digest(include_str!("../client.rs").as_bytes())),"samples":samples});
    let output = serde_json::to_string_pretty(&artifact).unwrap();
    if let Ok(path) = std::env::var("SYNCULAR_IMPORT_BENCH_OUTPUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(output.as_bytes()).unwrap();
    } else {
        println!("{output}");
    }
}

#[test]
fn local_fts_projection_tracks_optimistic_overlay_rebuilds() {
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "catalogue_codes",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "release_id", "type": "string", "nullable": false },
                { "name": "code", "type": "string", "nullable": false },
                { "name": "title", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "release:{release_id}" }],
            "ftsIndexes": [{
                "name": "catalogue_codes_fts",
                "columns": ["code", "title"],
                "tokenize": "unicode61 remove_diacritics 2"
            }]
        }]
    });
    let mut client = SyncClient::new("fts-test".to_owned(), &schema, ClientLimits::default())
        .expect("FTS5 client");
    let insert_trigger: String = client
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_ai'",
            [],
            |row| row.get(0),
        )
        .expect("insert trigger");
    let replace_guard: String = client
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bi'",
            [],
            |row| row.get(0),
        )
        .expect("replace guard");
    assert!(!insert_trigger.contains("DELETE FROM"));
    assert!(replace_guard.contains("BEFORE INSERT"));
    assert!(replace_guard.contains("WHEN EXISTS"));
    let search = |client: &SyncClient, query: &str| {
        client
            .query(
                "SELECT c.id FROM catalogue_codes_fts f JOIN catalogue_codes c ON CAST(c.id AS TEXT) = f._syncular_source_id WHERE catalogue_codes_fts MATCH ?1 ORDER BY c.id",
                &[Value::from(query)],
            )
            .expect("FTS query")
    };

    client
        .mutate(vec![Mutation::Upsert {
            table: "catalogue_codes".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("c1")),
                ("release_id".to_owned(), Value::from("r1")),
                ("code".to_owned(), Value::from("A01")),
                ("title".to_owned(), Value::from("Cholera")),
            ]),
            base_version: None,
        }])
        .expect("insert code");
    assert_eq!(search(&client, "cholera").len(), 1);
    let prior = client
        .query("SELECT rowid, * FROM catalogue_codes_fts", &[])
        .unwrap();
    client
        .conn
        .execute_batch("DROP TABLE _syncular_fts_catalogue_codes_fts")
        .unwrap();
    client.create_synced_tables().unwrap();
    assert_eq!(
        client
            .query("SELECT rowid, * FROM catalogue_codes_fts", &[])
            .unwrap(),
        prior
    );
    let plan = client.query("EXPLAIN QUERY PLAN SELECT rowid FROM catalogue_codes_fts WHERE rowid = (SELECT id FROM _syncular_fts_catalogue_codes_fts WHERE source_id = 'c1')", &[]).unwrap();
    let rendered = serde_json::to_string(&plan).unwrap();
    assert!(rendered.contains("COVERING INDEX"));
    assert!(rendered.contains("INDEX 0:="));
    client.conn.execute_batch("SAVEPOINT test_mapping; DELETE FROM catalogue_codes WHERE id='c1'; ROLLBACK TO test_mapping; RELEASE test_mapping").unwrap();
    assert_eq!(search(&client, "cholera").len(), 1);

    client
        .mutate(vec![Mutation::Upsert {
            table: "catalogue_codes".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), Value::from("c1")),
                ("release_id".to_owned(), Value::from("r1")),
                ("code".to_owned(), Value::from("A01")),
                ("title".to_owned(), Value::from("Enteric infection")),
            ]),
            base_version: None,
        }])
        .expect("update code");
    assert!(search(&client, "cholera").is_empty());
    assert_eq!(search(&client, "enteric").len(), 1);

    client
        .mutate(vec![Mutation::Delete {
            table: "catalogue_codes".to_owned(),
            row_id: "c1".to_owned(),
            base_version: None,
        }])
        .expect("delete code");
    assert!(search(&client, "enteric").is_empty());
}

#[test]
fn application_authorized_local_purge_is_exact_atomic_and_idempotent() {
    let schema = json!({
        "version": 1,
        "tables": [{
            "name": "patient_notes",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "practice_id", "type": "string", "nullable": false },
                { "name": "encryption_key_id", "type": "string", "nullable": false },
                { "name": "title", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "practice:{practice_id}" }],
            "ftsIndexes": [{
                "name": "patient_notes_fts",
                "columns": ["title"],
                "tokenize": "unicode61 remove_diacritics 2"
            }]
        }]
    });
    let mut client = SyncClient::new(
        "local-purge-test".to_owned(),
        &schema,
        ClientLimits::default(),
    )
    .expect("local purge client");
    client
        .conn
        .execute(
            "INSERT INTO _syncular_base_patient_notes(id, practice_id, encryption_key_id, title, _syncular_version) VALUES
             ('target', 'practice-1', 'key-revoked', 'Target original', 1),
             ('unrelated', 'practice-1', 'key-held', 'Unrelated original', 1)",
            [],
        )
        .expect("seed base rows");
    client.overlay_dirty.set(true);
    client.rebuild_overlay_if_dirty().expect("rebuild overlay");

    let note = |id: &str, key_id: &str, title: &str| {
        Map::from_iter([
            ("id".to_owned(), Value::from(id)),
            ("practice_id".to_owned(), Value::from("practice-1")),
            ("encryption_key_id".to_owned(), Value::from(key_id)),
            ("title".to_owned(), Value::from(title)),
        ])
    };
    let doomed = client
        .mutate(vec![
            Mutation::Upsert {
                table: "patient_notes".to_owned(),
                values: note("target", "key-revoked", "Target changed"),
                base_version: None,
            },
            Mutation::Upsert {
                table: "patient_notes".to_owned(),
                values: note("unrelated", "key-held", "Unrelated changed"),
                base_version: None,
            },
        ])
        .expect("doomed commit");
    let kept = client
        .mutate(vec![Mutation::Upsert {
            table: "patient_notes".to_owned(),
            values: note("kept", "key-held", "Kept optimistic"),
            base_version: None,
        }])
        .expect("kept commit");
    client.drain_change_batches();

    let input = LocalDataPurgeInput {
        purge_id: "purge-001".to_owned(),
        targets: vec![LocalDataPurgeTarget {
            table: "patient_notes".to_owned(),
            selectors: BTreeMap::from([(
                "encryption_key_id".to_owned(),
                vec!["key-revoked".to_owned()],
            )]),
        }],
    };
    assert_eq!(
        client.purge_local_data(&input).expect("apply purge"),
        LocalDataPurgeResult {
            already_applied: false,
            purged_rows: 1,
            dropped_commits: 1,
        }
    );
    let rows = client
        .query("SELECT id, title FROM patient_notes ORDER BY id", &[])
        .expect("visible rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "kept");
    assert_eq!(rows[1]["id"], "unrelated");
    assert_eq!(rows[1]["title"], "Unrelated original");
    let fts = client
        .query(
            "SELECT n.id FROM patient_notes_fts f JOIN patient_notes n ON CAST(n.id AS TEXT) = f._syncular_source_id WHERE patient_notes_fts MATCH 'target'",
            &[],
        )
        .expect("fts query");
    assert!(fts.is_empty());
    assert_eq!(client.outbox.len(), 1);
    assert_eq!(client.outbox[0].client_commit_id, kept);
    let outcome = client
        .commit_outcome(&doomed)
        .expect("read doomed outcome")
        .expect("doomed outcome");
    assert_eq!(outcome.status, CommitOutcomeStatus::Rejected);
    match &outcome.results[0] {
        CommitOperationOutcome::Error { rejection } => {
            assert_eq!(rejection.code, "client.local_data_purged");
            assert_eq!(rejection.client_commit_id, doomed);
        }
        other => panic!("expected local purge rejection, got {other:?}"),
    }
    assert_eq!(client.drain_change_batches().len(), 1);
    assert_eq!(
        client.purge_local_data(&input).expect("retry purge"),
        LocalDataPurgeResult {
            already_applied: true,
            purged_rows: 0,
            dropped_commits: 0,
        }
    );
    let conflicting = LocalDataPurgeInput {
        purge_id: input.purge_id.clone(),
        targets: vec![LocalDataPurgeTarget {
            table: "patient_notes".to_owned(),
            selectors: BTreeMap::from([(
                "encryption_key_id".to_owned(),
                vec!["key-held".to_owned()],
            )]),
        }],
    };
    assert!(client
        .purge_local_data(&conflicting)
        .expect_err("id collision must fail")
        .contains("already used with a different plan"));
}

/// Mirror `SyncClient::sync` through the split round API.
fn sync_split(client: &mut SyncClient, transport: &mut dyn Transport) -> SyncOutcome {
    let mut next = match client.prepare_sync_round(transport.supports_url_fetch()) {
        Ok(prepared) => prepared,
        Err(outcome) => return *outcome,
    };
    loop {
        let completed = crate::round::test_support::drive_round(next, transport);
        match client.apply_sync_round(completed) {
            crate::AppliedSyncRound::Continue(prepared) => next = prepared,
            crate::AppliedSyncRound::Complete {
                outcome, controls, ..
            } => {
                if client.transport_enabled() {
                    for text in controls {
                        let _ = transport.realtime_send(&text);
                    }
                } else {
                    client.disconnect_realtime(transport);
                }
                return outcome;
            }
        }
    }
}

#[derive(Clone)]
enum RoundReplyScript {
    Response(Message),
    /// Answer every pushed commit with an applied result.
    PushAck,
    Error(TransportError),
}

/// Serves one scripted reply and records every request, segment batch, and
/// upload the round makes.
struct SplitParityTransport {
    script: RoundReplyScript,
    segments: BTreeMap<String, Vec<u8>>,
    requests: Vec<Message>,
    batches: Vec<Vec<String>>,
    uploads: Vec<String>,
    /// Answers the upload of this blob id with this error.
    refused_upload: Option<(String, TransportError)>,
    sync_calls: usize,
    realtime_sync_calls: usize,
}

impl SplitParityTransport {
    fn new(script: RoundReplyScript) -> Self {
        Self {
            script,
            segments: BTreeMap::new(),
            requests: Vec::new(),
            batches: Vec::new(),
            uploads: Vec::new(),
            refused_upload: None,
            sync_calls: 0,
            realtime_sync_calls: 0,
        }
    }

    fn with_segments(script: RoundReplyScript, segments: BTreeMap<String, Vec<u8>>) -> Self {
        Self {
            segments,
            ..Self::new(script)
        }
    }

    fn respond(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let message = decode_message(request).expect("the client encodes a legal round request");
        self.requests.push(message.clone());
        match &self.script {
            RoundReplyScript::Response(response) => Ok(encode_message(response)),
            RoundReplyScript::Error(error) => Err(error.clone()),
            RoundReplyScript::PushAck => {
                let mut frames = vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: "epoch-1".into(),
                    reset_required: false,
                }];
                let mut commit_seq = 0;
                for frame in &message.frames {
                    if let Frame::PushCommit {
                        client_commit_id,
                        operations,
                        ..
                    } = frame
                    {
                        commit_seq += 1;
                        frames.push(Frame::PushResult {
                            client_commit_id: client_commit_id.clone(),
                            status: PushStatus::Applied,
                            commit_seq: Some(commit_seq),
                            results: (0..operations.len())
                                .map(|op_index| OpResult::Applied {
                                    op_index: op_index as i32,
                                })
                                .collect(),
                        });
                    }
                }
                frames.extend(live_section(commit_seq, Vec::new()));
                Ok(encode_message(&Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames,
                }))
            }
        }
    }
}

impl Transport for SplitParityTransport {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync_calls += 1;
        self.respond(request)
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.realtime_sync_calls += 1;
        self.respond(request)
    }
    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new(
            "sync.transport_failed",
            "per-descriptor fetch",
        ))
    }

    fn download_segments(
        &mut self,
        fetches: &[crate::SegmentFetch],
        on_progress: &mut (dyn FnMut(usize, u64) + Send),
    ) -> Vec<Result<Vec<u8>, TransportError>> {
        self.batches.push(
            fetches
                .iter()
                .map(|fetch| match fetch {
                    crate::SegmentFetch::Direct(request) => request.segment_id.clone(),
                    crate::SegmentFetch::Url { url, .. } => url.clone(),
                })
                .collect(),
        );
        fetches
            .iter()
            .enumerate()
            .map(|(index, fetch)| {
                let crate::SegmentFetch::Direct(request) = fetch else {
                    panic!("the descriptors are direct-endpoint requests")
                };
                let bytes = self
                    .segments
                    .get(&request.segment_id)
                    .cloned()
                    .ok_or_else(|| {
                        TransportError::new("transport.not_found", "missing segment body")
                    })?;
                on_progress(index, bytes.len() as u64);
                Ok(bytes)
            })
            .collect()
    }

    fn blob_upload_grant(
        &mut self,
        _blob_id: &str,
        _byte_length: u64,
        _media_type: Option<&str>,
    ) -> Result<BlobUploadGrant, TransportError> {
        Ok(BlobUploadGrant::None)
    }

    fn blob_upload(
        &mut self,
        blob_id: &str,
        _bytes: &[u8],
        _media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        self.uploads.push(blob_id.to_owned());
        match &self.refused_upload {
            Some((refused, error)) if refused == blob_id => Err(error.clone()),
            _ => Ok(()),
        }
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn parity_clients() -> (SyncClient, SyncClient) {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let [exchange, split] = ["parity-exchange", "parity-split"].map(|id| {
        let mut client = SyncClient::new(id.to_owned(), &schema, ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        live_unit(&client, &[("project_id", "p1")]);
        client.drain_change_batches();
        client
    });
    (exchange, split)
}

fn pull_response(client: &SyncClient) -> Message {
    let row = encode_row_json(
        client.schema.table("tasks").unwrap(),
        "kept",
        &Map::from_iter([
            ("id".into(), json!("kept")),
            ("project_id".into(), json!("p1")),
        ]),
        &client.encryption,
    )
    .unwrap();
    Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".into(),
                reset_required: false,
            },
            Frame::LiveStart {
                status: LiveStatus::Active,
                reason_code: String::new(),
            },
            Frame::Commit {
                commit_seq: 1,
                created_at_ms: 1,
                actor_id: "writer".into(),
                tables: vec!["tasks".into()],
                changes: vec![ssp2::model::Change {
                    table_index: 0,
                    row_id: "kept".into(),
                    op: Op::Upsert,
                    row_version: 1,
                    scopes: vec![("project_id".into(), "p1".into())],
                    row: Some(row),
                }],
            },
            Frame::LiveEnd {
                through_seq: 1,
                echo_digest: None,
            },
        ],
    }
}

#[test]
fn split_round_matches_exchange_for_a_pull() {
    let (mut exchange, mut split) = parity_clients();
    let response = pull_response(&exchange);
    let mut exchange_transport =
        SplitParityTransport::new(RoundReplyScript::Response(response.clone()));
    let mut split_transport = SplitParityTransport::new(RoundReplyScript::Response(response));

    let exchange_outcome = exchange.sync(&mut exchange_transport);
    let split_outcome = sync_split(&mut split, &mut split_transport);
    assert_eq!(exchange_outcome.to_json(), split_outcome.to_json());
    assert_eq!(
        exchange
            .query("SELECT id, project_id FROM tasks", &[])
            .unwrap(),
        split
            .query("SELECT id, project_id FROM tasks", &[])
            .unwrap()
    );
    assert_eq!(exchange_transport.requests.len(), 1);
    assert_eq!(split_transport.requests.len(), 1);
}

#[test]
fn split_round_matches_exchange_for_a_push_with_an_upload() {
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let [mut exchange, mut split] = ["parity-push-exchange", "parity-push-split"].map(|id| {
        let mut client = SyncClient::new(id.to_owned(), &schema, ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        client
            .subscribe(UnitScopes::from([("project_id".to_owned(), "p1".into())]))
            .unwrap();
        client
    });
    let bytes = b"split upload";
    let mut mutations = Vec::new();
    for client in [&mut exchange, &mut split] {
        client
            .upload_blob(bytes, Some("text/plain".into()), None)
            .unwrap();
        mutations.push(
            client
                .mutate(vec![Mutation::Upsert {
                    table: "attachments".into(),
                    values: Map::from_iter([
                        ("id".into(), Value::from("a1")),
                        ("project_id".into(), Value::from("p1")),
                        (
                            "file".into(),
                            Value::from(format!(
                                "{{\"blobId\":\"{}\",\"byteLength\":{}}}",
                                blob_id_for(bytes),
                                bytes.len()
                            )),
                        ),
                    ]),
                    base_version: None,
                }])
                .unwrap(),
        );
    }
    let mut exchange_transport = SplitParityTransport::new(RoundReplyScript::PushAck);
    let mut split_transport = SplitParityTransport::new(RoundReplyScript::PushAck);
    let exchange_outcome = exchange.sync(&mut exchange_transport);
    let split_outcome = sync_split(&mut split, &mut split_transport);
    let SyncOutcome::Ok(exchange_report) = exchange_outcome else {
        panic!("the exchange round must succeed: {exchange_outcome:?}")
    };
    let SyncOutcome::Ok(split_report) = split_outcome else {
        panic!("the split round must succeed: {split_outcome:?}")
    };
    assert_eq!(exchange_report.pushed, 1);
    assert_eq!(split_report.pushed, 1);
    assert_eq!(
        exchange_report.commits_applied,
        split_report.commits_applied
    );
    assert_eq!(
        exchange_transport.uploads,
        [blob_id_for(bytes)],
        "one upload before the metadata request"
    );
    assert_eq!(split_transport.uploads, exchange_transport.uploads);
    assert!(exchange.pending_commit_ids().is_empty());
    assert!(split.pending_commit_ids().is_empty());
    assert_eq!(
        exchange
            .query("SELECT id, project_id FROM attachments", &[])
            .unwrap(),
        split
            .query("SELECT id, project_id FROM attachments", &[])
            .unwrap()
    );
}

#[test]
fn a_non_retryable_upload_refusal_rejects_its_commits_and_the_round_continues() {
    // §5.9.7: the refusal is the body's final outcome; a retryable one and
    // a failure without a server code still fail the round.
    let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false},
        {"name":"file","type":"blob_ref","nullable":true}],
        "scopes":[{"pattern":"project:{project_id}"}]}]});
    let refused_bytes = b"refused body";
    let kept_bytes = b"kept body";
    let refusal = |retryable: Option<bool>| {
        let mut error = TransportError::new("blob.too_large", "blob exceeds the byte cap");
        error.details = retryable.map(|retryable| json!({ "retryable": retryable }));
        error
    };
    for split in [false, true] {
        for retryable in [Some(false), Some(true), None] {
            let label = format!("split={split} retryable={retryable:?}");
            let mut client =
                SyncClient::new("refused-upload".into(), &schema, ClientLimits::default()).unwrap();
            client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
            let mut attach = |id: &str, bytes: &[u8]| {
                client.upload_blob(bytes, None, None).unwrap();
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "attachments".into(),
                        values: Map::from_iter([
                            ("id".into(), Value::from(id)),
                            ("project_id".into(), Value::from("p1")),
                            (
                                "file".into(),
                                Value::from(format!(
                                    "{{\"blobId\":\"{}\",\"byteLength\":{}}}",
                                    blob_id_for(bytes),
                                    bytes.len()
                                )),
                            ),
                        ]),
                        base_version: None,
                    }])
                    .unwrap()
            };
            let refused = attach("big", refused_bytes);
            let kept = attach("small", kept_bytes);
            let mut transport = SplitParityTransport::new(RoundReplyScript::PushAck);
            transport.refused_upload = Some((blob_id_for(refused_bytes), refusal(retryable)));

            let outcome = if split {
                sync_split(&mut client, &mut transport)
            } else {
                client.sync(&mut transport)
            };

            if retryable != Some(false) {
                assert!(
                    matches!(&outcome, SyncOutcome::Failed { error_code, .. } if error_code == "blob.too_large"),
                    "{label}: {outcome:?}"
                );
                assert!(transport.requests.is_empty(), "{label}");
                assert_eq!(client.pending_commit_ids(), vec![refused, kept], "{label}");
                assert!(client.rejections.is_empty(), "{label}");
                continue;
            }
            let SyncOutcome::Ok(report) = outcome else {
                panic!("{label}: the round continues: {outcome:?}")
            };
            assert_eq!(report.pushed, 1, "{label}");
            assert_eq!(
                transport.uploads,
                [blob_id_for(refused_bytes), blob_id_for(kept_bytes)],
                "{label}"
            );
            let pushed = transport.requests[0]
                .frames
                .iter()
                .filter_map(|frame| match frame {
                    Frame::PushCommit {
                        client_commit_id, ..
                    } => Some(client_commit_id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(pushed, vec![kept.clone()], "{label}");
            assert!(client.pending_commit_ids().is_empty(), "{label}");
            assert_eq!(
                client
                    .rejections
                    .iter()
                    .map(|rejection| (
                        rejection.client_commit_id.clone(),
                        rejection.code.clone(),
                        rejection.retryable
                    ))
                    .collect::<Vec<_>>(),
                vec![(refused.clone(), "blob.too_large".to_owned(), false)],
                "{label}"
            );
            assert_eq!(
                client
                    .conn
                    .query_row("SELECT count(*) FROM _syncular_blob_uploads", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0,
                "{label}"
            );
            assert_eq!(
                client
                    .query("SELECT id FROM attachments ORDER BY id", &[])
                    .unwrap()
                    .iter()
                    .map(|row| row["id"].clone())
                    .collect::<Vec<_>>(),
                vec![json!("small")],
                "{label}"
            );
        }
    }
}

#[test]
fn split_round_matches_exchange_for_a_segment_download() {
    let (mut exchange, mut split) = parity_clients();
    let columns = exchange.schema.table("tasks").unwrap().wire_columns.clone();
    let page = ssp2::segment::encode_rows_segment(&RowsSegment {
        table: "tasks".into(),
        schema_version: 1,
        columns,
        blocks: vec![vec![ssp2::segment::SegmentRow {
            server_version: 1,
            values: vec![
                Some(ColumnValue::String("page".into())),
                Some(ColumnValue::String("p1".into())),
            ],
        }]],
    });
    let segment_id = format!("sha256:{}", bytes_to_hex(&Sha256::digest(&page)));
    let response = Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch-1".into(),
                reset_required: false,
            },
            Frame::SubStart {
                id: ssp2::registration::unit_id(&[("project_id".into(), "p1".into())]),
                status: SubStatus::Active,
                reason_code: String::new(),
                bootstrap: true,
                fenced: Vec::new(),
            },
            Frame::SegmentRef {
                segment_id: segment_id.clone(),
                media_type: MediaType::Rows,
                table: "tasks".into(),
                byte_length: page.len() as i64,
                row_count: 1,
                as_of_commit_seq: 1,
                scope_digest: "digest".into(),
                row_cursor: None,
                next_row_cursor: None,
                url: None,
                url_expires_at_ms: None,
            },
            Frame::SubEnd {
                next_cursor: 1,
                bootstrap_state: None,
            },
            Frame::LiveStart {
                status: LiveStatus::Active,
                reason_code: String::new(),
            },
            Frame::LiveEnd {
                through_seq: 1,
                echo_digest: None,
            },
        ],
    };
    let segments = BTreeMap::from([(segment_id.clone(), page)]);
    let mut exchange_transport = SplitParityTransport::with_segments(
        RoundReplyScript::Response(response.clone()),
        segments.clone(),
    );
    let mut split_transport =
        SplitParityTransport::with_segments(RoundReplyScript::Response(response), segments);
    let exchange_outcome = exchange.sync(&mut exchange_transport);
    let split_outcome = sync_split(&mut split, &mut split_transport);
    assert_eq!(exchange_outcome.to_json(), split_outcome.to_json());
    assert_eq!(exchange_transport.batches, [vec![segment_id.clone()]]);
    assert_eq!(split_transport.batches, exchange_transport.batches);
    assert_eq!(
        exchange
            .query("SELECT id, project_id FROM tasks", &[])
            .unwrap(),
        split
            .query("SELECT id, project_id FROM tasks", &[])
            .unwrap()
    );
}

#[test]
fn split_round_matches_exchange_for_a_transport_failure() {
    let (mut exchange, mut split) = parity_clients();
    let error = TransportError::new("transport.timeout", "injected");
    let mut exchange_transport = SplitParityTransport::new(RoundReplyScript::Error(error.clone()));
    let mut split_transport = SplitParityTransport::new(RoundReplyScript::Error(error));
    let exchange_outcome = exchange.sync(&mut exchange_transport);
    let split_outcome = sync_split(&mut split, &mut split_transport);
    assert_eq!(exchange_outcome.to_json(), split_outcome.to_json());
    assert!(matches!(
        split_outcome,
        SyncOutcome::Failed { ref error_code, .. } if error_code == "transport.timeout"
    ));
    assert_eq!(
        exchange.query("SELECT id FROM tasks", &[]).unwrap(),
        split.query("SELECT id FROM tasks", &[]).unwrap()
    );
}

#[test]
fn split_round_matches_exchange_for_a_failed_realtime_round() {
    let (mut exchange, mut split) = parity_clients();
    let error = TransportError::new("transport.timeout", "socket round failed");
    let mut exchange_transport = SplitParityTransport::new(RoundReplyScript::Error(error));
    let mut split_transport = SplitParityTransport::new(RoundReplyScript::Error(
        TransportError::new("transport.timeout", "socket round failed"),
    ));
    exchange.connect_realtime(&mut exchange_transport).unwrap();
    split.connect_realtime(&mut split_transport).unwrap();
    let exchange_outcome = exchange.sync(&mut exchange_transport);
    let split_outcome = sync_split(&mut split, &mut split_transport);
    assert_eq!(exchange_outcome.to_json(), split_outcome.to_json());
    assert_eq!(exchange_transport.realtime_sync_calls, 1);
    assert_eq!(exchange_transport.sync_calls, 0);
    assert_eq!(split_transport.realtime_sync_calls, 1);
    assert_eq!(split_transport.sync_calls, 0);
    assert_eq!(exchange.realtime_state(), RealtimeState::Lost);
    assert_eq!(split.realtime_state(), RealtimeState::Lost);
}

/// Answers every commit the next request pushes with `status(index)`.
fn answer_pushes(
    client: &mut SyncClient,
    first_seq: i64,
    status: impl Fn(usize) -> PushStatus,
) -> SyncOutcome {
    let (_, meta) = client.build_request(false).unwrap();
    let mut frames = vec![Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "epoch-1".into(),
        reset_required: false,
    }];
    frames.extend(meta.pushed_ids.iter().enumerate().map(|(index, id)| {
        let status = status(index);
        Frame::PushResult {
            client_commit_id: id.clone(),
            status,
            commit_seq: (status != PushStatus::Rejected).then_some(first_seq + index as i64),
            results: vec![if status == PushStatus::Rejected {
                OpResult::Error {
                    op_index: 0,
                    code: "sync.forbidden".into(),
                    message: "rejected".into(),
                    retryable: false,
                }
            } else {
                OpResult::Applied { op_index: 0 }
            }],
        }
    }));
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    client.process_response(
        &mut transport,
        Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames,
        },
        &meta,
    )
}

#[test]
fn acknowledged_edit_reconciles_only_its_rows_of_a_large_table() {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false},{"name":"title","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}],
        "ftsIndexes":[{"name":"tasks_fts","columns":["title"],"tokenize":"unicode61"}]}]});
    let mut client = SyncClient::new("large-ack".into(), &schema, ClientLimits::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO _syncular_base_tasks SELECT printf('t%05d',x),'p1','title '||x,1 FROM n").unwrap();
    client.rebuild_overlay().unwrap();
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("t00042")),
                ("project_id".into(), json!("p1")),
                ("title".into(), json!("edited")),
            ]),
            base_version: None,
        }])
        .unwrap();
    client.conn.execute_batch("CREATE TABLE visible_writes(kind TEXT);
        CREATE TRIGGER count_delete AFTER DELETE ON tasks BEGIN INSERT INTO visible_writes VALUES('delete'); END;
        CREATE TRIGGER count_insert AFTER INSERT ON tasks BEGIN INSERT INTO visible_writes VALUES('insert'); END;").unwrap();
    client.overlay_rebuild_count.set(0);
    assert!(matches!(
        answer_pushes(&mut client, 1, |_| PushStatus::Applied),
        SyncOutcome::Ok(_)
    ));
    assert_eq!(client.overlay_rebuild_count.get(), 0);
    assert_eq!(
        client
            .query(
                "SELECT kind, count(*) AS n FROM visible_writes GROUP BY kind ORDER BY kind",
                &[]
            )
            .unwrap(),
        [
            Map::from_iter([("kind".into(), json!("delete")), ("n".into(), json!(1))]),
            Map::from_iter([("kind".into(), json!("insert")), ("n".into(), json!(1))])
        ]
    );
    let reads = [
        "SELECT * FROM tasks ORDER BY id",
        "SELECT _syncular_source_id, title FROM tasks_fts WHERE tasks_fts MATCH 'edited OR title' ORDER BY _syncular_source_id",
    ];
    let keyed = reads.map(|sql| client.query(sql, &[]).unwrap());
    assert_eq!(keyed[1].len(), 10000);
    client.overlay_dirty.set(true);
    client.rebuild_overlay_if_dirty().unwrap();
    assert_eq!(reads.map(|sql| client.query(sql, &[]).unwrap()), keyed);
}

#[test]
fn bootstrap_stays_incremental_beside_protected_intent_on_another_table() {
    let mut client = SyncClient::new("protected-elsewhere".into(), &json!({"version":1,"tables":(["tasks","docs"].map(|name| json!({
        "name":name,"primaryKey":"id","columns":[{"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}]})))}), ClientLimits::default()).unwrap();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client.set_retain_failed_commits(true).unwrap();
    let doc = |id: &str| Mutation::Upsert {
        table: "docs".into(),
        values: Map::from_iter([("id".into(), json!(id)), ("project_id".into(), json!("p1"))]),
        base_version: None,
    };
    client.mutate(vec![doc("acked")]).unwrap();
    assert!(matches!(
        answer_pushes(&mut client, 1, |_| PushStatus::Applied),
        SyncOutcome::Ok(_)
    ));
    let tasks = client.schema.table("tasks").unwrap().clone();
    let effective = vec![("project_id".to_owned(), vec!["p1".to_owned()])];
    let columns = tasks.wire_columns.clone();
    let segment = |from: usize, blocks: usize| RowsSegment {
        table: "tasks".into(),
        schema_version: 1,
        columns: columns.clone(),
        blocks: (0..blocks)
            .map(|block| {
                (0..1024)
                    .map(|row| ssp2::segment::SegmentRow {
                        server_version: 1,
                        values: vec![
                            Some(ColumnValue::String(format!(
                                "task-{:06}",
                                from + block * 1024 + row
                            ))),
                            Some(ColumnValue::String("p1".into())),
                        ],
                    })
                    .collect()
            })
            .collect(),
    };
    let first = segment(0, 49);
    client.overlay_rebuild_count.set(0);
    assert!(matches!(
        client.apply_segment(&tasks, &first, true, &effective, &[]),
        Ok(50176)
    ));
    assert_eq!(
        client.overlay_rebuild_count.get(),
        0,
        "an acknowledged docs row must not rebuild tasks per block"
    );
    client.mutate(vec![doc("rejected")]).unwrap();
    assert!(matches!(
        answer_pushes(&mut client, 2, |_| PushStatus::Rejected),
        SyncOutcome::Ok(_)
    ));
    assert_eq!(client.failed_commits.len(), 1);
    let second = segment(50176, 8);
    client.overlay_rebuild_count.set(0);
    assert!(matches!(
        client.apply_segment(&tasks, &second, false, &effective, &[]),
        Ok(8192)
    ));
    assert_eq!(
        client.overlay_rebuild_count.get(),
        0,
        "a retained docs failure must not rebuild tasks per block"
    );
    for (sql, expected) in [
        ("SELECT count(*) AS n FROM tasks", 58368),
        ("SELECT count(*) AS n FROM docs", 2),
        ("SELECT count(*) AS n FROM _syncular_acked_rows", 1),
    ] {
        assert_eq!(client.query(sql, &[]).unwrap()[0]["n"], expected, "{sql}");
    }
}

#[test]
fn keyed_push_result_reconciliation_matches_a_full_rebuild() {
    let table = |name: &str, extra: Value| {
        let mut table = json!({"name":name,"primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false},{"name":"title","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]});
        table
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        table
    };
    let schema = json!({"version":1,"tables":[
        table("tasks", json!({"indexes":[{"name":"unique_title","columns":["title"],"unique":true}],
            "ftsIndexes":[{"name":"tasks_fts","columns":["title"],"tokenize":"unicode61"}]})),
        table("notes", json!({}))]});
    let [mut keyed, mut reference] = ["keyed", "reference"].map(|_| {
        let mut client =
            SyncClient::new("push-keyed".into(), &schema, ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        client.set_retain_failed_commits(true).unwrap();
        client
    });
    let tables = vec!["tasks".to_owned(), "notes".to_owned()];
    let values = |id: &str, title: String| {
        Map::from_iter([
            ("id".into(), json!(id)),
            ("project_id".into(), json!("p1")),
            ("title".into(), json!(title)),
        ])
    };
    for round in 0..16usize {
        let seq = round as i64 * 10 + 1;
        // A server row takes a title that a pending edit may hold, so
        // replay defers that edit until the server answers its push.
        let id = format!("task-{}", round % 6);
        let mut title = format!("title-{}", round % 4);
        if keyed
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM _syncular_base_tasks WHERE title=?1 AND id<>?2)",
                [&title, &id],
                |row| row.get(0),
            )
            .unwrap()
        {
            title = format!("server-{round}");
        }
        for client in [&mut keyed, &mut reference] {
            let change = ssp2::model::Change {
                table_index: 0,
                row_id: id.clone(),
                op: if round % 5 == 4 {
                    Op::Delete
                } else {
                    Op::Upsert
                },
                row_version: seq,
                scopes: vec![("project_id".into(), "p1".into())],
                row: Some(
                    encode_row_json(
                        client.schema.table("tasks").unwrap(),
                        &id,
                        &values(&id, title.clone()),
                        &client.encryption,
                    )
                    .unwrap(),
                ),
            };
            client.apply_commit_frame(&tables, &[change], seq).unwrap();
        }
        for commit in 0..3 {
            let n = round * 3 + commit;
            let mut mutations = vec![Mutation::Upsert {
                table: "notes".into(),
                values: values(&format!("note-{}", n % 3), format!("note-{n}")),
                base_version: None,
            }];
            if n % 4 != 3 {
                let id = format!("task-{}", n % 6);
                mutations.push(Mutation::Upsert {
                    table: "tasks".into(),
                    values: values(&id, format!("title-{}", n % 5)),
                    base_version: None,
                });
            }
            assert_eq!(
                keyed.mutate(mutations.clone()).is_ok(),
                reference.mutate(mutations).is_ok()
            );
        }
        reference.overlay_dirty.set(true);
        keyed.overlay_rebuild_count.set(0);
        for client in [&mut keyed, &mut reference] {
            let status = |index: usize| {
                if (round + index) % 3 == 1 {
                    PushStatus::Rejected
                } else {
                    PushStatus::Applied
                }
            };
            assert!(matches!(
                answer_pushes(client, seq + 1, status),
                SyncOutcome::Ok(_)
            ));
        }
        assert_eq!(keyed.overlay_rebuild_count.get(), 0, "round {round}");
        for sql in [
            "SELECT * FROM tasks ORDER BY id",
            "SELECT * FROM notes ORDER BY id",
            "SELECT _syncular_source_id, title FROM tasks_fts ORDER BY _syncular_source_id",
        ] {
            assert_eq!(
                keyed.query(sql, &[]).unwrap(),
                reference.query(sql, &[]).unwrap(),
                "round {round}: {sql}"
            );
        }
        assert_eq!(
            keyed.local_revision().unwrap(),
            reference.local_revision().unwrap()
        );
        assert_eq!(
            serde_json::to_value(keyed.drain_change_batches()).unwrap(),
            serde_json::to_value(reference.drain_change_batches()).unwrap()
        );
    }
    assert!(!keyed.failed_commits.is_empty());
}

#[test]
fn failed_operations_restore_every_mirror_through_one_rollback() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client.set_retain_failed_commits(true).unwrap();
    let ids = (0..3)
        .map(|index| {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!(format!("t{index}"))),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap()
        })
        .collect::<Vec<_>>();
    let rows = client
        .query("SELECT * FROM tasks ORDER BY id", &[])
        .unwrap();
    client.conn.execute_batch("CREATE TRIGGER fail_revision BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END").unwrap();
    let before = format!("{:?}", client.capture());

    // Former hand-rolled site: the push-result transaction drains one
    // acknowledged and one retained rejected commit before it fails.
    let mut report = SyncReport::default();
    assert!(client
        .handle_push_results(
            &[
                Frame::PushResult {
                    client_commit_id: ids[0].clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(1),
                    results: vec![OpResult::Applied { op_index: 0 }],
                },
                Frame::PushResult {
                    client_commit_id: ids[1].clone(),
                    status: PushStatus::Rejected,
                    commit_seq: None,
                    results: vec![OpResult::Error {
                        op_index: 0,
                        code: "sync.forbidden".into(),
                        message: "rejected".into(),
                        retryable: false,
                    }],
                },
            ],
            &ids.iter().map(String::as_str).collect(),
            &HashMap::new(),
            &mut report,
            None,
        )
        .is_err());
    assert!(report.applied.is_empty() && report.rejected.is_empty());
    assert_eq!(format!("{:?}", client.capture()), before);
    assert_eq!(
        client
            .query("SELECT * FROM tasks ORDER BY id", &[])
            .unwrap(),
        rows
    );

    // Former hand-rolled site: the local purge drops every pending commit
    // and base row of the scope before it fails.
    assert!(client
        .purge_local_data(&LocalDataPurgeInput {
            purge_id: "purge-1".into(),
            targets: vec![LocalDataPurgeTarget {
                table: "tasks".into(),
                selectors: BTreeMap::from([("project_id".into(), vec!["p1".into()])]),
            }],
        })
        .is_err());
    assert_eq!(format!("{:?}", client.capture()), before);
    assert_eq!(
        client
            .query("SELECT * FROM tasks ORDER BY id", &[])
            .unwrap(),
        rows
    );
}

#[test]
fn a_unit_limit_refusal_reaches_the_app_with_its_details_and_is_not_retried() {
    // The error the native transport builds from the server's HTTP 413 body.
    let mut refusal = TransportError::new(
        "sync.limit_exceeded",
        "request carries more units than the server accepts (§1.7)",
    );
    refusal.details = Some(json!({
        "category": "invalid-request",
        "recommendedAction": "fixRequest",
        "retryable": false,
        "limit": "maxSubscriptionsPerRequest",
        "max": 1,
        "actual": 2,
        "causeKind": "status",
        "httpStatus": 413,
    }));
    let mut transport = failure_transport([Err(refusal)]);
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
        .subscribe_many(["a", "b"].map(|id| unit_scopes("project_id", id)).to_vec())
        .unwrap();
    assert_eq!(client.diagnostics_snapshot().unwrap().active_units, 2);
    client.drain_sync_intents();
    let outcome = client.sync(&mut transport);
    let SyncOutcome::Failed {
        error_code,
        details,
        recommended_action,
        ..
    } = outcome
    else {
        panic!("expected a failed round, got {outcome:?}");
    };
    assert_eq!(error_code, "sync.limit_exceeded");
    assert_eq!(recommended_action.as_deref(), Some("fixRequest"));
    let details = details.unwrap();
    assert_eq!(details["limit"], "maxSubscriptionsPerRequest");
    assert_eq!(details["max"], 1);
    assert_eq!(details["actual"], 2);
    assert_eq!(details["retryable"], false);
    assert_eq!(details["httpStatus"], 413);
    assert!(client.drain_sync_intents().is_empty());
    assert_eq!(client.progress().snapshot().unwrap().retry_delay_ms, None);
    let snapshot = client.diagnostics_snapshot().unwrap();
    assert_eq!(
        snapshot.last_round.unwrap().error_code.as_deref(),
        Some("sync.limit_exceeded")
    );
}
