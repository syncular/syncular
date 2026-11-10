use super::*;
use serde_json::{json, Value};

fn previous_version_schema(version: i32) -> Value {
    json!({
        "version": version,
        "tables": [{
            "name": "tasks",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "note", "type": "string", "nullable": true }
            ],
            "scopes": []
        }]
    })
}

fn previous_version_limits() -> crate::api::ClientLimits {
    crate::api::ClientLimits {
        previous_version_context: Some(crate::previous_version::PreviousVersionContextConfig {
            enabled: true,
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// The configuration the live client carries, for a direct capture call.
fn previous_version_config() -> crate::previous_version::PreviousVersionContextConfig {
    previous_version_limits()
        .previous_version_context
        .expect("configured")
}

/// Capture the container the way a bump would, so a read test starts from a
/// container this client's own state will then decide about.
fn recapture_previous_version(client: &SyncClient) {
    let replica_path = client
        .previous_version_replica_path()
        .expect("file-backed replica");
    let outcome = crate::previous_version::capture_previous_version_from_replica(
        &client.conn,
        &replica_path,
        2,
        2,
        &previous_version_config(),
        1,
    )
    .expect("capture");
    assert!(matches!(
        outcome,
        crate::previous_version::CaptureOutcome::Captured(_)
    ));
}

fn subscription(state: SubState, cursor: i64, bootstrap_state: Option<&str>) -> Subscription {
    Subscription {
        id: "wiring-sub".to_owned(),
        table: "tasks".to_owned(),
        requested: Vec::new(),
        params: None,
        cursor,
        bootstrap_state: bootstrap_state.map(str::to_owned),
        state,
        reason_code: None,
        effective: None,
        synced_once: false,
    }
}

#[test]
fn schema_downgrade_refuses_all_opens_and_recreate_without_mutation() {
    let path = std::env::temp_dir().join(format!("syncular-downgrade-{}.db", uuid::Uuid::new_v4()));
    let path_str = path.to_str().expect("temp path");
    let schema = previous_version_schema(3);
    let mut older = previous_version_schema(2);
    older["tables"][0]["columns"] = json!([{ "name": "id", "type": "string", "nullable": false }]);
    let mut client = SyncClient::open_path(
        "downgrade".into(),
        &previous_version_schema(1),
        previous_version_limits(),
        path_str,
    )
    .expect("fresh");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("accepted")),
                ("note".into(), json!("old")),
            ]),
            base_version: None,
        }])
        .expect("v1 write");
    client
        .recreate_with_schema(&schema)
        .expect("upgrade captures context");
    let commit = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("queued")),
                ("note".into(), json!("v3-only")),
            ]),
            base_version: None,
        }])
        .expect("queued v3 write");
    let changes = client.conn.total_changes();
    let outbox = client.pending_commit_ids();
    assert!(outbox.contains(&commit));
    let descriptor = client.get_meta("localSchemaDescriptor").unwrap();
    let container = format!(
        "{path_str}{}",
        crate::previous_version::PREVIOUS_VERSION_CONTAINER_SUFFIX
    );
    let context = std::fs::read(&container).expect("captured context");
    assert!(client
        .recreate_with_schema(&older)
        .expect_err("refuse recreate")
        .starts_with("client.schema_downgrade:"));
    assert_eq!(client.schema.version, 3);
    assert_eq!(client.conn.total_changes(), changes);
    assert_eq!(client.pending_commit_ids(), outbox);
    assert_eq!(
        client.get_meta("localSchemaDescriptor").unwrap(),
        descriptor
    );
    assert_eq!(
        client
            .conn
            .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("queued row"),
        "v3-only"
    );
    assert_eq!(std::fs::read(&container).expect("context remains"), context);
    drop(client);
    let before = std::fs::read(&path).expect("replica bytes");
    // open_path uses DELETE journaling. The identity open must refuse
    // before its normal WAL configuration changes this database.
    for entry in 0..3 {
        let error = match entry {
            0 => SyncClient::open_path(
                "downgrade".into(),
                &older,
                previous_version_limits(),
                path_str,
            ),
            1 => SyncClient::open_path_with_identity(
                None,
                &older,
                previous_version_limits(),
                path_str,
            ),
            _ => SyncClient::with_connection(
                "downgrade".into(),
                &older,
                previous_version_limits(),
                Connection::open(&path).expect("connection"),
            ),
        }
        .err()
        .expect("refuse open");
        assert!(error.starts_with("client.schema_downgrade:"));
        let conn = Connection::open(&path).expect("inspect");
        assert_eq!(
            conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                .expect("journal mode"),
            "delete"
        );
        drop(conn);
        assert_eq!(std::fs::read(&path).expect("replica unchanged"), before);
        assert_eq!(
            std::fs::read(&container).expect("context unchanged"),
            context
        );
    }
    let reopened = SyncClient::open_path(
        "downgrade".into(),
        &schema,
        previous_version_limits(),
        path_str,
    )
    .expect("compatible reopen");
    assert_eq!(reopened.pending_commit_ids(), outbox);
    assert_eq!(
        reopened
            .conn
            .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("queued row remains"),
        "v3-only"
    );
    reopened.delete_meta(LOCAL_SCHEMA_VERSION_KEY).unwrap();
    reopened
        .delete_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY)
        .unwrap();
    drop(reopened);
    let legacy = SyncClient::open_path(
        "downgrade".into(),
        &schema,
        previous_version_limits(),
        path_str,
    )
    .expect("legacy no-marker reopen");
    assert_eq!(legacy.pending_commit_ids(), outbox);
    assert!(!legacy.upgrading());
    assert_eq!(
        legacy
            .conn
            .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("legacy row remains"),
        "v3-only"
    );
    drop(legacy);
    std::fs::remove_file(path).expect("remove replica");
    let _ = std::fs::remove_file(container);
}

#[test]
fn schema_marker_errors_refuse_open_and_recreate_without_mutation() {
    for marker in [
        "''",
        "'bad'",
        "'0'",
        "'-1'",
        "'2.5'",
        "'03'",
        "'3\n'",
        "' 3'",
        "'+3'",
        "'3e0'",
        "'2147483648'",
        "NULL",
        "X'33'",
    ] {
        let conn = Connection::open_in_memory().expect("connection");
        conn.execute_batch(&format!("CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value); INSERT INTO _syncular_meta VALUES ('localSchemaVersion', {marker});")).expect("invalid marker fixture");
        let error = SyncClient::with_connection(
            "marker".into(),
            &previous_version_schema(3),
            ClientLimits::default(),
            conn,
        )
        .err()
        .expect("refuse marker");
        assert!(
            error.starts_with("sync.local_corrupt:"),
            "{marker}: {error}"
        );
    }
    for fault in [
        "UPDATE _syncular_meta SET value = 'bad' WHERE key = 'localSchemaVersion'",
        "ALTER TABLE _syncular_meta RENAME COLUMN value TO unreadable_value",
    ] {
        let mut client = SyncClient::new(
            "marker".into(),
            &previous_version_schema(3),
            ClientLimits::default(),
        )
        .expect("fresh");
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([("id".into(), json!("queued"))]),
                base_version: None,
            }])
            .expect("queued write");
        client.conn.execute_batch(fault).expect("marker fault");
        let changes = client.conn.total_changes();
        let error = client
            .recreate_with_schema(&previous_version_schema(4))
            .expect_err("refuse corrupt marker");
        assert!(error.starts_with("sync.local_corrupt:"));
        assert_eq!(client.conn.total_changes(), changes);
        assert_eq!(client.schema.version, 3);
        assert_eq!(client.pending_commit_ids(), vec![commit]);
    }
    for setup in [
        "CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY)",
        "CREATE VIEW _syncular_meta AS SELECT 'localSchemaVersion' AS key, '3' AS value",
    ] {
        let path =
            std::env::temp_dir().join(format!("syncular-marker-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("connection");
        conn.execute_batch(setup)
            .expect("unreadable metadata fixture");
        drop(conn);
        let before = std::fs::read(&path).expect("before");
        let error = SyncClient::open_path_with_identity(
            None,
            &previous_version_schema(3),
            ClientLimits::default(),
            path.to_str().expect("path"),
        )
        .err()
        .expect("refuse unreadable marker");
        assert!(error.starts_with("sync.local_corrupt:"));
        assert_eq!(std::fs::read(&path).expect("after"), before);
        std::fs::remove_file(path).expect("remove fixture");
    }
}

std::thread_local! {
    /// The pending concurrent upgrade a busy handler commits, so a lock
    /// collision deterministically becomes the marker race under test.
    static CONCURRENT_UPGRADE: RefCell<Option<Connection>> =
        const { RefCell::new(None) };
}

fn commit_concurrent_upgrade(attempts: i32) -> bool {
    CONCURRENT_UPGRADE.with(|slot| {
        if let Some(banner) = slot.borrow_mut().take() {
            banner
                .execute_batch(
                    "UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion'; COMMIT",
                )
                .expect("commit the concurrent upgrade");
        }
    });
    attempts < 10
}

fn journal_mode(conn: &Connection) -> String {
    conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        .expect("journal mode")
}

fn temp_replica(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("syncular-{label}-{}.db", uuid::Uuid::new_v4()))
}

#[test]
fn file_identity_constructor_requires_the_returned_wal_mode() {
    for path in [":memory:", ""] {
        let error = SyncClient::open_path_with_identity(
            None,
            &previous_version_schema(1),
            ClientLimits::default(),
            path,
        )
        .err()
        .expect("temporary SQLite databases cannot enter WAL mode");
        assert_eq!(
            error,
            "sync.invalid_request: file-backed client requires WAL journal mode"
        );
    }
    let path = temp_replica("confirmed-wal");
    let client = SyncClient::open_path_with_identity(
        None,
        &previous_version_schema(1),
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(journal_mode(&client.conn), "wal");
    drop(client);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn non_wal_identity_open_is_accepted_when_wal_is_not_required() {
    for path in [":memory:", ""] {
        let client = SyncClient::open_path_with_identity_journal(
            None,
            &previous_version_schema(1),
            ClientLimits::default(),
            path,
            false,
        )
        .expect("a host without WAL can still open the identity constructor");
        assert_ne!(journal_mode(&client.conn), "wal");
        assert_eq!(
            client
                .conn
                .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
                .expect("synchronous"),
            2,
            "every identity open pins FULL durability"
        );
    }
}

#[test]
fn reset_replica_deletes_the_database_and_its_sidecars_through_the_vfs() {
    let path = temp_replica("reset");
    let path_str = path.to_str().expect("path");
    let client = SyncClient::open_path(
        "reset-replica".into(),
        &previous_version_schema(1),
        ClientLimits::default(),
        path_str,
    )
    .expect("replica");
    let original_id = client.client_id().to_owned();
    drop(client);
    for suffix in ["-journal", "-wal", "-shm"] {
        std::fs::write(format!("{path_str}{suffix}"), b"stale sidecar").expect("sidecar");
    }

    SyncClient::reset_replica(path_str).expect("reset through the VFS");

    for suffix in ["", "-journal", "-wal", "-shm"] {
        assert!(
            !std::path::Path::new(&format!("{path_str}{suffix}")).exists(),
            "reset removes the replica file {suffix:?}"
        );
    }
    let reopened = SyncClient::open_path_with_identity(
        None,
        &previous_version_schema(1),
        ClientLimits::default(),
        path_str,
    )
    .expect("fresh replica");
    assert_ne!(reopened.client_id(), original_id);
    assert!(reopened
        .query("SELECT id FROM tasks", &[])
        .expect("empty")
        .is_empty());
    drop(reopened);
    assert_eq!(
        SyncClient::reset_replica(":memory:").expect_err("memory has nothing to reset"),
        "sync.invalid_request: a memory replica has nothing to reset"
    );
}

#[test]
fn reset_replica_after_a_clean_close_without_sidecars_opens_an_empty_replica() {
    let path = temp_replica("reset-clean");
    let path_str = path.to_str().expect("path");
    let mut client = SyncClient::open_path(
        "reset-clean".into(),
        &previous_version_schema(1),
        ClientLimits::default(),
        path_str,
    )
    .expect("replica");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), Value::from("t1")),
                ("note".into(), Value::from("stale")),
            ]),
            base_version: None,
        }])
        .expect("stale row");
    assert_eq!(
        client
            .query("SELECT id FROM tasks", &[])
            .expect("row")
            .len(),
        1
    );
    drop(client);
    for suffix in ["-journal", "-wal", "-shm"] {
        assert!(
            !std::path::Path::new(&format!("{path_str}{suffix}")).exists(),
            "a clean close leaves no {suffix:?} sidecar"
        );
    }

    SyncClient::reset_replica(path_str).expect("missing sidecars count as deleted");

    assert!(!path.exists(), "reset removes the replica file");
    let reopened = SyncClient::open_path_with_identity(
        None,
        &previous_version_schema(1),
        ClientLimits::default(),
        path_str,
    )
    .expect("fresh replica");
    assert_ne!(reopened.client_id(), "reset-clean");
    assert!(reopened
        .query("SELECT id FROM tasks", &[])
        .expect("empty")
        .is_empty());
    drop(reopened);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn non_positive_generated_schema_versions_are_refused_before_storage() {
    for version in [json!(0), json!(-1), json!(i32::MIN), json!(2147483648i64)] {
        let mut schema = previous_version_schema(1);
        schema["version"] = version.clone();
        let error = SyncClient::new("bad-version".into(), &schema, ClientLimits::default())
            .err()
            .expect("refuse an out-of-range generated version");
        assert_eq!(
            error,
            "sync.invalid_request: generated schema version must be an integer in 1..=2147483647"
        );
        // The file-backed seam refuses before the replica gains a table.
        let path = temp_replica("bad-version");
        let path_str = path.to_str().expect("path");
        for identity in [false, true] {
            let error = if identity {
                SyncClient::open_path_with_identity(
                    None,
                    &schema,
                    ClientLimits::default(),
                    path_str,
                )
            } else {
                SyncClient::open_path(
                    "bad-version".into(),
                    &schema,
                    ClientLimits::default(),
                    path_str,
                )
            }
            .err()
            .expect("refuse before storage");
            assert!(
                error.starts_with("sync.invalid_request:"),
                "{version}: {error}"
            );
            assert!(
                !path.exists(),
                "{version}: a refused constructor creates no replica file"
            );
        }
    }
    // A missing version is the same request error, not a parse failure.
    let mut schema = previous_version_schema(1);
    schema
        .as_object_mut()
        .expect("schema object")
        .remove("version");
    let error = SyncClient::new("bad-version".into(), &schema, ClientLimits::default())
        .err()
        .expect("refuse a missing version");
    assert!(error.starts_with("sync.invalid_request:"), "{error}");
}

#[test]
fn a_duplicated_schema_marker_is_refused_without_a_reset() {
    let path = temp_replica("duplicate-marker");
    let path_str = path.to_str().expect("path");
    {
        // A hand-built/legacy metadata table without its primary key, with
        // the older marker first: `query_row` would pick it and reset.
        let conn = Connection::open(path_str).expect("fixture");
        conn.execute_batch(
            "CREATE TABLE _syncular_meta(key TEXT, value);
             INSERT INTO _syncular_meta VALUES
               ('localSchemaVersion', '1'),
               ('localSchemaVersion', '2'),
               ('clientId', 'duplicate');",
        )
        .expect("duplicate marker fixture");
    }
    let error = SyncClient::open_path_with_identity(
        None,
        &previous_version_schema(3),
        ClientLimits::default(),
        path_str,
    )
    .err()
    .expect("refuse a duplicated marker");
    assert!(error.starts_with("sync.local_corrupt:"), "{error}");
    let probe = Connection::open(path_str).expect("probe");
    assert_eq!(
        probe
            .query_row(
                "SELECT COUNT(*) FROM _syncular_meta WHERE key = 'localSchemaVersion'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("marker rows"),
        2,
        "the duplicated rows are left for the operator, not collapsed"
    );
    assert_eq!(
        probe
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_syncular_%' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("synced tables"),
        0,
        "a duplicated marker never drives the reset that recreates v3 tables"
    );
    assert_eq!(
        journal_mode(&probe),
        "delete",
        "the refusal leaves the journal mode alone"
    );
    drop(probe);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn a_refused_open_does_not_persist_wal_or_mutate_the_replica() {
    let path = temp_replica("refused-wal");
    let path_str = path.to_str().expect("path");
    // `open_path` leaves the default journal mode, so a refused open is
    // the only thing that could switch this replica to WAL.
    drop(
        SyncClient::open_path(
            "owner".into(),
            &previous_version_schema(2),
            ClientLimits::default(),
            path_str,
        )
        .expect("v2 replica"),
    );
    let before = std::fs::read(&path).expect("before");
    let error = SyncClient::open_path_with_identity(
        Some("intruder".into()),
        &previous_version_schema(2),
        ClientLimits::default(),
        path_str,
    )
    .err()
    .expect("refuse the identity mismatch");
    assert!(error.starts_with("client.identity_mismatch:"), "{error}");
    let probe = Connection::open(path_str).expect("probe");
    assert_eq!(
        journal_mode(&probe),
        "delete",
        "a refused open must not persist WAL"
    );
    assert_eq!(std::fs::read(&path).expect("after"), before);
    assert_eq!(
        meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY)
            .unwrap()
            .as_deref(),
        Some("2")
    );
    drop(probe);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn a_concurrent_marker_upgrade_refuses_a_stale_open() {
    let path = temp_replica("marker-race");
    let path_str = path.to_str().expect("path");
    drop(
        SyncClient::open_path_with_identity(
            Some("stale".into()),
            &previous_version_schema(1),
            ClientLimits::default(),
            path_str,
        )
        .expect("v1 replica"),
    );
    // Another process holds the write lock with an uncommitted upgrade; a
    // stale open reads the v1 marker first and only then meets the lock.
    // The first busy therefore lands after this replica became v2.
    let banner = Connection::open(path_str).expect("banner");
    banner
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion';",
        )
        .expect("pending upgrade");
    CONCURRENT_UPGRADE.with(|slot| *slot.borrow_mut() = Some(banner));
    let mut conn = Connection::open(path_str).expect("stale connection");
    conn.busy_handler(Some(commit_concurrent_upgrade))
        .expect("busy handler");
    let error = SyncClient::with_connection(
        "stale".into(),
        &previous_version_schema(1),
        ClientLimits::default(),
        conn,
    )
    .err()
    .expect("a concurrent upgrade must refuse the stale open");
    assert!(error.starts_with("client.schema_downgrade:"), "{error}");
    let probe = Connection::open(path_str).expect("probe");
    assert_eq!(
        meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY)
            .unwrap()
            .as_deref(),
        Some("2"),
        "the concurrent upgrade survives"
    );
    drop(probe);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn a_concurrent_marker_upgrade_refuses_a_stale_recreate() {
    let path = temp_replica("recreate-race");
    let path_str = path.to_str().expect("path");
    let mut client = SyncClient::open_path_with_identity(
        Some("stale".into()),
        &previous_version_schema(1),
        ClientLimits::default(),
        path_str,
    )
    .expect("v1 replica");
    client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([("id".into(), json!("queued"))]),
            base_version: None,
        }])
        .expect("queued write");
    let commit = client.pending_commit_ids();
    let banner = Connection::open(path_str).expect("banner");
    banner
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion';",
        )
        .expect("pending upgrade");
    CONCURRENT_UPGRADE.with(|slot| *slot.borrow_mut() = Some(banner));
    client
        .conn
        .busy_handler(Some(commit_concurrent_upgrade))
        .expect("busy handler");
    let error = client
        .recreate_with_schema(&previous_version_schema(1))
        .expect_err("a concurrent upgrade must refuse the stale recreate");
    assert!(error.starts_with("client.schema_downgrade:"), "{error}");
    assert_eq!(client.schema.version, 1, "the compiled schema is restored");
    assert_eq!(
        client.pending_commit_ids(),
        commit,
        "the outbox is preserved"
    );
    let probe = Connection::open(path_str).expect("probe");
    assert_eq!(
        meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY)
            .unwrap()
            .as_deref(),
        Some("2")
    );
    drop(probe);
    drop(client);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn failed_schema_record_writes_roll_back_recreation() {
    for key in [
        LOCAL_SCHEMA_VERSION_KEY,
        crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY,
    ] {
        let mut client = SyncClient::new(
            "schema-record".into(),
            &previous_version_schema(1),
            ClientLimits::default(),
        )
        .expect("v1");
        let marker = client.get_meta(LOCAL_SCHEMA_VERSION_KEY).unwrap();
        let descriptor = client
            .get_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY)
            .unwrap();
        client.conn.execute_batch(&format!("CREATE TRIGGER refuse_schema_record BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{key}' BEGIN SELECT RAISE(ABORT, 'refuse schema record'); END")).expect("fault");
        client
            .recreate_with_schema(&previous_version_schema(2))
            .expect_err("both record writes must propagate failure");
        assert_eq!(client.schema.version, 1);
        assert_eq!(client.get_meta(LOCAL_SCHEMA_VERSION_KEY).unwrap(), marker);
        assert_eq!(
            client
                .get_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY)
                .unwrap(),
            descriptor
        );
        client
            .conn
            .execute_batch("DROP TRIGGER refuse_schema_record")
            .expect("remove fault");
        client
            .recreate_with_schema(&previous_version_schema(2))
            .expect("retry");
        assert_eq!(client.schema.version, 2);
    }
}

#[test]
fn a_failed_outer_commit_restores_every_reset_side_effect() {
    let path = temp_replica("outer-commit");
    let path_str = path.to_str().expect("path");
    // A rollback-journal replica (no WAL), so a second read connection can
    // hold SHARED across the recreated transaction's COMMIT.
    let conn = Connection::open(path_str).expect("replica connection");
    let mut client = SyncClient::with_connection(
        "outer-commit".into(),
        &previous_version_schema(1),
        previous_version_limits(),
        conn,
    )
    .expect("v1 replica");
    assert_eq!(journal_mode(&client.conn), "delete");
    let commit = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("queued")),
                ("note".into(), json!("dropped-by-v2")),
            ]),
            base_version: None,
        }])
        .expect("queued write");
    client.drain_change_batches();
    // v2 drops `note`, so the queued upsert cannot re-encode.
    let mut dropped = previous_version_schema(2);
    dropped["tables"][0]["columns"] =
        json!([{ "name": "id", "type": "string", "nullable": false }]);
    // Prior database and memory state: the refused COMMIT must restore all
    // of it.
    let marker = meta_get(&client.conn, LOCAL_SCHEMA_VERSION_KEY).unwrap();
    let revision = client.local_revision().unwrap();
    let rows = client.query("SELECT * FROM tasks", &[]).expect("rows");
    let columns: i64 = client
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('tasks')",
            [],
            |row| row.get(0),
        )
        .expect("column count");
    let rebuilds = client.overlay_rebuild_count.get();
    let prior_subs = client.subs.len();
    let prior_changes = client.change_queue.len();
    let prior_intents = client.sync_intent_queue.len();
    let prior_last_change = client.last_change.clone();
    let prior_overlay_dirty = client.overlay_dirty.get();
    let prior_sync_needed = client.sync_needed;
    let prior_upgrading = client.upgrading;
    let prior_stopped = client.stopped;
    let prior_schema_floor = client.schema_floor.clone();
    let prior_active_round = client.active_round;
    // The reader holds SHARED for the whole attempt: the writer takes
    // RESERVED, runs the reset, and fails when COMMIT needs EXCLUSIVE.
    let reader = Connection::open(path_str).expect("reader");
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
        .expect("reader snapshot");
    client
        .conn
        .busy_timeout(std::time::Duration::ZERO)
        .expect("busy timeout");
    let error = client
        .recreate_with_schema(&dropped)
        .expect_err("a blocked COMMIT must refuse the recreation");
    assert!(error.starts_with("client.storage_busy:"), "{error}");
    assert!(
        client.overlay_rebuild_count.get() > rebuilds,
        "the reset ran to its overlay rebuild inside the transaction"
    );
    assert!(client.conn.is_autocommit(), "the transaction is released");
    // Database: the rolled-back reset left nothing behind.
    assert_eq!(
        meta_get(&client.conn, LOCAL_SCHEMA_VERSION_KEY).unwrap(),
        marker
    );
    assert_eq!(client.local_revision().unwrap(), revision);
    assert_eq!(
        client.query("SELECT * FROM tasks", &[]).expect("rows"),
        rows
    );
    assert_eq!(
        client
            .conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('tasks')",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .expect("column count"),
        columns,
        "the previous table layout survives the rollback"
    );
    assert_eq!(client.pending_commit_ids(), vec![commit.clone()]);
    // Memory: every side effect of the successful reset is restored with
    // the rolled-back database.
    assert_eq!(client.schema.version, 1, "compiled schema");
    assert_eq!(client.subs.len(), prior_subs);
    assert_eq!(client.change_queue.len(), prior_changes);
    assert_eq!(client.sync_intent_queue.len(), prior_intents);
    assert_eq!(client.last_change, prior_last_change);
    assert_eq!(client.overlay_dirty.get(), prior_overlay_dirty);
    assert_eq!(client.sync_needed, prior_sync_needed);
    assert_eq!(client.upgrading, prior_upgrading);
    assert_eq!(client.stopped, prior_stopped);
    assert_eq!(client.schema_floor, prior_schema_floor);
    assert_eq!(client.active_round, prior_active_round);
    assert!(
        client.rejections.is_empty(),
        "the dropped-column rejection is rolled back too"
    );
    // The capture committed in its separate file before the failed replica
    // COMMIT. It belongs to v2 and cannot be exposed by the restored v1 core.
    let container = crate::previous_version::previous_version_container_path(path_str);
    assert!(std::path::Path::new(&container).exists());
    // The reader no longer needs its snapshot, so discard can clean the
    // replica's audit records along with the stale sibling file.
    drop(reader);
    let snapshot = client
        .previous_version_snapshot(&PreviousVersionReadSpec {
            table: "tasks".into(),
            ..Default::default()
        })
        .expect("refuse stale capture");
    assert!(!snapshot.available);
    assert_eq!(snapshot.current_version, 1);
    assert!(!std::path::Path::new(&container).exists());
    // The client remains usable: releasing the reader lets the identical
    // recreation run to completion, and the reset preserves the
    // incompatible intent until the send-time prepass classifies it
    // (§7.4.3/§7.4.4: the reset never touches the outbox).
    client
        .conn
        .busy_timeout(std::time::Duration::from_secs(1))
        .expect("busy timeout");
    client
        .recreate_with_schema(&dropped)
        .expect("the recreation succeeds once the reader releases");
    assert_eq!(client.schema.version, 2);
    assert_eq!(
        client.pending_commit_ids(),
        vec![commit.clone()],
        "the reset kept the incompatible commit pending"
    );
    assert!(
        client.rejections.is_empty(),
        "no rejection exists before the send-time prepass"
    );
    // The send boundary classifies and drops it.
    client
        .prepare_sync_round(false)
        .expect("the send prepass runs during round preparation");
    assert!(client.pending_commit_ids().is_empty());
    assert!(
        client
            .rejections
            .iter()
            .any(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE),
        "the dropped-column commit surfaced as a rejection at send time"
    );
    client.previous_version_discard().unwrap();
    drop(client);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn the_send_time_incompatible_drop_is_atomic_and_publishes_once() {
    let v1 = previous_version_schema(1);
    let mut v2 = previous_version_schema(2);
    // v2 drops `note`, so the queued `dropped` upsert cannot re-encode.
    v2["tables"][0]["columns"] = json!([{ "name": "id", "type": "string", "nullable": false }]);
    let mut client = SyncClient::new("drop".to_string(), &v1, ClientLimits::default()).unwrap();
    let dropped = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("dropped")),
                ("note".into(), json!("gone")),
            ]),
            base_version: None,
        }])
        .unwrap();
    // A full-row v1 upsert always carries the v1 columns, so the surviving
    // commit is a value-free delete (it encodes under any schema that still
    // has the table).
    let survivor = client
        .mutate(vec![Mutation::Delete {
            table: "tasks".into(),
            row_id: "gone".into(),
            base_version: None,
        }])
        .unwrap();
    client
        .recreate_with_schema(&v2)
        .expect("the reset preserves the outbox");
    assert_eq!(
        client.pending_commit_ids(),
        vec![dropped.clone(), survivor.clone()],
        "the reset preserves both commits"
    );
    assert!(client.rejections.is_empty(), "the reset classifies nothing");
    client.drain_change_batches();
    let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
    assert_eq!(rows.len(), 1, "only the dropped upsert has a visible row");

    // A fault anywhere in the atomic drop leaves the replica, the outbox,
    // the durable outcomes, the visible projection, the revision, and the
    // publish surface untouched. Clearing `syncNeeded` first keeps the
    // round's own status flip out of the assertion, so any published change
    // can only be the drop's.
    for fault in [
        "outcome-insert",
        "outbox-delete",
        "overlay-rebuild",
        "publish-revision",
    ] {
        client.set_sync_needed(false, false);
        client.drain_change_batches();
        let revision = client.local_revision().unwrap();
        let trigger = match fault {
            "outcome-insert" => {
                "CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(ABORT,'drop fault'); END"
            }
            "outbox-delete" => {
                "CREATE TRIGGER fail_drop BEFORE DELETE ON _syncular_outbox BEGIN SELECT RAISE(ABORT,'drop fault'); END"
            }
            // The optimized replay removes only the dropped projection, so
            // the replay fault belongs on the DELETE; a publish fault lands
            // on the revision write that `finish_observation` performs after
            // every durable effect already succeeded.
            "publish-revision" => {
                "CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(ABORT,'drop fault'); END"
            }
            _ => {
                "CREATE TRIGGER fail_drop BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'drop fault'); END"
            }
        };
        client.conn.execute_batch(trigger).unwrap();
        let outcome = client
            .prepare_sync_round(false)
            .err()
            .unwrap_or_else(|| panic!("{fault}: a fault in the drop must fail the round"));
        assert!(
            matches!(*outcome, SyncOutcome::Failed { ref error_code, .. } if error_code == "storage.failed"),
            "{fault}: {outcome:?}"
        );
        client.conn.execute_batch("DROP TRIGGER fail_drop").unwrap();
        assert!(client.conn.is_autocommit(), "{fault}: no leaked savepoint");
        assert_eq!(
            client.pending_commit_ids(),
            vec![dropped.clone(), survivor.clone()],
            "{fault}: the outbox is restored"
        );
        assert!(
            client.rejections.is_empty(),
            "{fault}: no in-memory rejection survives"
        );
        assert!(
            client.commit_outcome(&dropped).unwrap().is_none(),
            "{fault}: the durable outcome rolled back"
        );
        assert_eq!(
            client.local_revision().unwrap(),
            revision,
            "{fault}: revision"
        );
        assert_eq!(
            client.query("SELECT * FROM tasks", &[]).unwrap(),
            rows,
            "{fault}: the visible projection is unchanged"
        );
        assert!(
            client.drain_change_batches().is_empty(),
            "{fault}: nothing is published"
        );
    }

    // A nested failure leaves the caller's transaction and earlier writes
    // intact; only the drop's savepoint is rolled back.
    client
        .conn
        .execute_batch(
            "BEGIN; INSERT INTO _syncular_meta(key,value) VALUES ('outerProbe','kept');
         CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_commit_outcomes
         BEGIN SELECT RAISE(ABORT,'nested drop fault'); END;",
        )
        .unwrap();
    assert!(client.drop_incompatible_outbox().is_err());
    assert!(!client.conn.is_autocommit());
    assert_eq!(
        client.get_meta("outerProbe").unwrap().as_deref(),
        Some("kept")
    );
    assert_eq!(
        client.pending_commit_ids(),
        vec![dropped.clone(), survivor.clone()]
    );
    assert!(client.commit_outcome(&dropped).unwrap().is_none());
    client
        .conn
        .execute_batch("DROP TRIGGER fail_drop; COMMIT")
        .unwrap();

    // The successful drop publishes exactly once and leaves the surviving
    // intent queued for the same round. A log epoch is required before a
    // round builds push frames at all, so the classification provably runs
    // before any operation of the dropped commit is sent.
    client.set_meta(LOG_EPOCH_KEY, "epoch").unwrap();
    client.set_sync_needed(false, false);
    client.drain_change_batches();
    let revision = client.local_revision().unwrap();
    let prepared = client.prepare_sync_round(false).expect("the drop succeeds");
    assert_eq!(client.pending_commit_ids(), vec![survivor.clone()]);
    assert_eq!(
        prepared.meta.pushed_ids,
        vec![survivor.clone()],
        "the incompatible commit is classified before any operation is sent"
    );
    let rejection = client
        .rejections
        .iter()
        .find(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE)
        .expect("a sync.outbox_incompatible rejection");
    assert_eq!(rejection.client_commit_id, dropped);
    assert!(
        !rejection.retryable,
        "a schema-incompatible commit is final"
    );
    assert_eq!(
        client
            .commit_outcome(&dropped)
            .unwrap()
            .expect("a durable rejected outcome")
            .status,
        CommitOutcomeStatus::Rejected
    );
    assert_eq!(
        client.local_revision().unwrap(),
        revision + 1,
        "one revision"
    );
    let batches = client.drain_change_batches();
    assert_eq!(batches.len(), 1, "one change batch");
    assert!(
        batches[0].rejections_changed && batches[0].outcomes_changed && batches[0].status.is_some(),
        "{:?}",
        batches[0]
    );
    assert!(
        batches[0].tables.iter().any(|entry| entry.table == "tasks"),
        "{:?}",
        batches[0]
    );
    let visible = client.query("SELECT * FROM tasks", &[]).unwrap();
    assert!(
        visible.is_empty(),
        "the dropped projection is undone: {visible:?}"
    );

    // The observation's outer RELEASE (transaction COMMIT) is guarded too:
    // a rollback-journal reader holding SHARED makes it fail with the typed
    // busy classification, and releasing the reader lets the retry succeed.
    let path = temp_replica("outbox-drop-commit");
    let path_str = path.to_str().expect("path");
    let conn = Connection::open(path_str).expect("replica connection");
    let mut client =
        SyncClient::with_connection("drop-commit".into(), &v1, ClientLimits::default(), conn)
            .expect("v1 replica");
    let dropped = client
        .mutate(vec![Mutation::Upsert {
            table: "tasks".into(),
            values: Map::from_iter([
                ("id".into(), json!("dropped")),
                ("note".into(), json!("gone")),
            ]),
            base_version: None,
        }])
        .unwrap();
    client
        .recreate_with_schema(&v2)
        .expect("the reset preserves the outbox");
    assert_eq!(client.pending_commit_ids(), vec![dropped.clone()]);
    let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
    assert_eq!(rows.len(), 1, "the optimistic row is visible");
    client.set_sync_needed(false, false);
    client.drain_change_batches();
    let revision = client.local_revision().unwrap();
    let reader = Connection::open(path_str).expect("reader");
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
        .expect("reader snapshot");
    client
        .conn
        .busy_timeout(std::time::Duration::ZERO)
        .expect("busy timeout");
    let outcome = client
        .prepare_sync_round(false)
        .err()
        .expect("a blocked COMMIT must fail the round");
    assert!(
        matches!(*outcome, SyncOutcome::Failed { ref error_code, .. } if error_code == "client.storage_busy"),
        "{outcome:?}"
    );
    assert!(client.conn.is_autocommit(), "the savepoint is released");
    assert_eq!(client.pending_commit_ids(), vec![dropped.clone()]);
    assert!(client.rejections.is_empty());
    assert!(client.commit_outcome(&dropped).unwrap().is_none());
    assert_eq!(client.local_revision().unwrap(), revision);
    assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
    assert!(client.drain_change_batches().is_empty());
    // The same round succeeds once the reader releases.
    drop(reader);
    client
        .conn
        .busy_timeout(std::time::Duration::from_secs(1))
        .expect("busy timeout");
    client
        .prepare_sync_round(false)
        .expect("the drop succeeds after the reader releases");
    assert!(client.pending_commit_ids().is_empty());
    assert!(client
        .rejections
        .iter()
        .any(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE));
    assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
    drop(client);
    std::fs::remove_file(path).expect("remove replica");
}

#[test]
fn previous_version_read_reasons_come_from_live_client_state() {
    use crate::previous_version::{
        PreviousVersionReadSpec, PreviousVersionReason, PREVIOUS_VERSION_CONTAINER_SUFFIX,
    };
    let path = std::env::temp_dir()
        .join(format!("syncular-prev-wiring-{}.db", uuid::Uuid::new_v4()))
        .to_string_lossy()
        .into_owned();
    let container = format!("{path}{PREVIOUS_VERSION_CONTAINER_SUFFIX}");
    {
        let mut setup = SyncClient::open_path(
            "wiring".to_owned(),
            &previous_version_schema(1),
            previous_version_limits(),
            &path,
        )
        .expect("v1 install");
        setup
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([("id".to_owned(), json!("t1"))]),
                base_version: None,
            }])
            .expect("seed a row");
    }
    let mut client = SyncClient::open_path(
        "wiring".to_owned(),
        &previous_version_schema(2),
        previous_version_limits(),
        &path,
    )
    .expect("v2 bump captures");
    assert!(std::path::Path::new(&container).exists());
    let spec = PreviousVersionReadSpec {
        table: "tasks".to_owned(),
        ..Default::default()
    };

    // §7.3.5 lease error ⇒ lease-inactive, and the read discards.
    recapture_previous_version(&client);
    client.lease_state = Some(LeaseState {
        lease_id: None,
        expires_at_ms: None,
        error_code: Some("lease.expired".to_owned()),
    });
    let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
    assert_eq!(snapshot.reason, Some(PreviousVersionReason::LeaseInactive));
    assert!(!snapshot.available);
    assert!(!std::path::Path::new(&container).exists());

    // An expired lease uses the client clock (injected, no sleeps).
    recapture_previous_version(&client);
    client.set_now_ms(1_000);
    client.lease_state = Some(LeaseState {
        lease_id: Some("lease".to_owned()),
        expires_at_ms: Some(1_000),
        error_code: None,
    });
    let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
    assert_eq!(snapshot.reason, Some(PreviousVersionReason::LeaseInactive));
    assert!(!std::path::Path::new(&container).exists());
    client.lease_state = None;

    // A revoked subscription ⇒ scope-revoked.
    recapture_previous_version(&client);
    client.subs.push(subscription(SubState::Revoked, 0, None));
    let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
    assert_eq!(snapshot.reason, Some(PreviousVersionReason::ScopeRevoked));
    assert!(!std::path::Path::new(&container).exists());
    client.subs.clear();

    // Coverage completion: every ACTIVE subscription has a cursor and no
    // resume token — a still-resuming subscription is not completion.
    recapture_previous_version(&client);
    client
        .subs
        .push(subscription(SubState::Active, 0, Some("resume")));
    assert!(!client.previous_version_coverage_complete());
    let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
    assert!(snapshot.available);
    assert_eq!(snapshot.previous_version, Some(2));
    assert_eq!(snapshot.rows.len(), 1);

    recapture_previous_version(&client);
    client.subs[0].bootstrap_state = None;
    assert!(client.previous_version_coverage_complete());
    let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
    assert_eq!(
        snapshot.reason,
        Some(PreviousVersionReason::CoverageComplete)
    );
    assert!(!std::path::Path::new(&container).exists());
    client.subs.clear();

    // With no active subscription at all, coverage is NOT complete.
    assert!(!client.previous_version_coverage_complete());

    drop(client);
    let _ = std::fs::remove_file(&path);
}

/// RFC 0005 D7 lifetime drops. The read surface already proves the reasons
/// come from live state; this proves the OTHER caller —
/// `previous_version_lifetime_check`, the once-per-sync-round trigger —
/// actually removes the container for lease-inactivity, coverage
/// completion and scope revocation, and leaves it alone while the
/// replacement bootstrap is still resuming.
#[test]
fn previous_version_lifetime_check_drops_on_lease_coverage_and_revocation() {
    let path = std::env::temp_dir()
        .join(format!(
            "syncular-prev-lifetime-{}.db",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned();
    let container = format!(
        "{path}{}",
        crate::previous_version::PREVIOUS_VERSION_CONTAINER_SUFFIX
    );
    let exists = || std::path::Path::new(&container).exists();
    {
        let mut setup = SyncClient::open_path(
            "lifetime".to_owned(),
            &previous_version_schema(1),
            previous_version_limits(),
            &path,
        )
        .expect("v1 install");
        setup
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([("id".to_owned(), json!("t1"))]),
                base_version: None,
            }])
            .expect("seed a row");
    }
    let mut client = SyncClient::open_path(
        "lifetime".to_owned(),
        &previous_version_schema(2),
        previous_version_limits(),
        &path,
    )
    .expect("v2 bump captures");
    // Pin the clock so the 24h TTL never fires in this test (the TTL has
    // its own coverage); the capture record's createdAtMs is 1.
    client.set_now_ms(1_000);
    assert!(exists());

    // §7.3.5 lease error ⇒ the lifetime check drops the container.
    client.lease_state = Some(LeaseState {
        lease_id: None,
        expires_at_ms: None,
        error_code: Some("lease.expired".to_owned()),
    });
    client.previous_version_lifetime_check();
    assert!(!exists());
    client.lease_state = None;

    // §7.4.5 coverage completion (every active sub has a cursor and no
    // resume token) ⇒ drop.
    recapture_previous_version(&client);
    client.subs.push(subscription(SubState::Active, 0, None));
    client.previous_version_lifetime_check();
    assert!(!exists());
    client.subs.clear();

    // §3.3 scope revocation ⇒ drop.
    recapture_previous_version(&client);
    client.subs.push(subscription(SubState::Revoked, 0, None));
    client.previous_version_lifetime_check();
    assert!(!exists());
    client.subs.clear();

    // Negative control: a still-resuming active subscription is NOT
    // coverage completion, so the container survives the same call.
    recapture_previous_version(&client);
    client
        .subs
        .push(subscription(SubState::Active, 0, Some("resume")));
    client.previous_version_lifetime_check();
    assert!(exists());
    client.subs.clear();

    drop(client);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&container);
    let _ = std::fs::remove_file(format!("{container}-wal"));
    let _ = std::fs::remove_file(format!("{container}-shm"));
}
