use serde_json::Value;
use syncular_runtime::binary_snapshot::{decode_binary_snapshot_table, BinarySnapshotColumnType};
use syncular_runtime::binary_sync_pack::{
    decode_binary_sync_pack, is_binary_sync_pack_content_type, SYNC_PACK_CONTENT_TYPE,
};
use syncular_runtime::protocol::{
    validate_pull_snapshot_manifests, CombinedRequest, CombinedResponse,
};

#[test]
fn decodes_json_combined_sync_fixture() {
    let fixture = json_combined_sync_fixture();
    assert_eq!(fixture["name"].as_str(), Some("json-combined-sync-v1"));

    let request: CombinedRequest =
        serde_json::from_value(fixture["request"].clone()).expect("fixture request");
    assert_eq!(request.client_id, "fixture-client-1");

    let push = request.push.expect("push request");
    assert_eq!(push.commits.len(), 1);
    assert_eq!(push.commits[0].client_commit_id, "fixture-commit-1");
    assert_eq!(push.commits[0].schema_version, 3);
    assert_eq!(push.commits[0].operations.len(), 2);
    assert_eq!(push.commits[0].operations[0].table, "tasks");
    assert_eq!(push.commits[0].operations[0].row_id, "task-local-1");
    assert_eq!(push.commits[0].operations[0].op, "upsert");
    assert_eq!(push.commits[0].operations[0].base_version, Some(5));
    assert_eq!(
        push.commits[0].operations[0]
            .payload
            .as_ref()
            .and_then(|payload| payload.get("title"))
            .and_then(Value::as_str),
        Some("Local edit")
    );
    assert_eq!(push.commits[0].operations[1].op, "delete");
    assert!(push.commits[0].operations[1].payload.is_none());

    let pull = request.pull.expect("pull request");
    assert_eq!(pull.limit_commits, 50);
    assert_eq!(pull.limit_snapshot_rows, 1000);
    assert_eq!(pull.max_snapshot_pages, 4);
    assert_eq!(pull.dedupe_rows, Some(true));
    assert_eq!(pull.subscriptions.len(), 1);
    assert_eq!(pull.subscriptions[0].id, "sub-tasks");
    assert_eq!(pull.subscriptions[0].table, "tasks");
    assert_eq!(pull.subscriptions[0].cursor, 41);
    assert_eq!(pull.subscriptions[0].crdt_state_vectors.len(), 1);
    assert_eq!(
        pull.subscriptions[0].crdt_state_vectors[0].state_column,
        "title_yjs_state"
    );
    assert_eq!(
        pull.subscriptions[0]
            .scopes
            .get("user_id")
            .and_then(Value::as_str),
        Some("user-1")
    );
    assert_eq!(
        pull.subscriptions[0]
            .bootstrap_state
            .as_ref()
            .map(|state| state.row_cursor.as_deref()),
        Some(Some("task-0"))
    );

    let response: CombinedResponse =
        serde_json::from_value(fixture["response"].clone()).expect("fixture response");
    assert!(response.ok);
    assert_eq!(response.required_schema_version, Some(3));
    assert_eq!(response.latest_schema_version, Some(4));

    let push = response.push.expect("push response");
    assert!(push.ok);
    assert_eq!(push.commits[0].client_commit_id, "fixture-commit-1");
    assert_eq!(push.commits[0].commit_seq, Some(42));
    assert_eq!(push.commits[0].results.len(), 2);
    assert_eq!(push.commits[0].results[1].status, "applied");

    let pull = response.pull.expect("pull response");
    assert!(pull.ok);
    let subscription = &pull.subscriptions[0];
    assert_eq!(subscription.id, "sub-tasks");
    assert_eq!(subscription.next_cursor, 42);
    assert_eq!(
        subscription
            .bootstrap_state
            .as_ref()
            .map(|state| state.row_cursor.as_deref()),
        Some(Some("task-1"))
    );
    assert_eq!(subscription.commits[0].changes[0].row_id, "task-remote-1");

    let snapshot = &subscription.snapshots.as_ref().expect("snapshots")[0];
    assert_eq!(snapshot.table, "tasks");
    assert!(snapshot.is_first_page);
    assert!(!snapshot.is_last_page);
    assert_eq!(
        snapshot
            .bootstrap_state_after
            .as_ref()
            .map(|state| state.row_cursor.as_deref()),
        Some(Some("task-snapshot-1"))
    );
}

#[test]
fn decodes_typescript_encoded_binary_sync_pack_fixture() {
    let fixture = binary_sync_pack_fixture();
    assert_eq!(
        fixture["contentType"].as_str(),
        Some(SYNC_PACK_CONTENT_TYPE)
    );
    assert!(is_binary_sync_pack_content_type(Some(
        "application/vnd.syncular.sync-pack.v1; charset=binary"
    )));

    let expected: CombinedResponse =
        serde_json::from_value(fixture["decodedResponse"].clone()).expect("fixture response");
    let encoded_hex = fixture["encodedHex"]
        .as_str()
        .expect("fixture encodedHex must be a string");
    let encoded = hex::decode(encoded_hex).expect("fixture encodedHex must be valid hex");
    assert_eq!(
        fixture["wireVersion"].as_u64(),
        Some(sync_pack_wire_version(&encoded) as u64)
    );
    let decoded = decode_binary_sync_pack(&encoded).expect("decode fixture");

    assert_eq!(decoded.ok, expected.ok);
    assert_eq!(decoded.required_schema_version, Some(2));
    assert_eq!(decoded.latest_schema_version, Some(3));

    let push = decoded.push.expect("push response");
    let expected_push = expected.push.expect("expected push response");
    assert!(push.ok);
    assert_eq!(push.commits.len(), expected_push.commits.len());
    assert_eq!(push.commits[0].client_commit_id, "fixture-local-1");
    assert_eq!(push.commits[0].status, "applied");
    assert_eq!(push.commits[0].commit_seq, Some(41));
    assert_eq!(push.commits[0].results[0].status, "applied");

    let conflict_commit = &push.commits[1];
    assert_eq!(conflict_commit.client_commit_id, "fixture-local-2");
    assert_eq!(conflict_commit.status, "rejected");
    assert_eq!(conflict_commit.results[0].status, "conflict");
    assert_eq!(
        conflict_commit.results[0].message.as_deref(),
        Some("server row changed")
    );
    assert_eq!(
        conflict_commit.results[0].code.as_deref(),
        Some("sync.version_conflict")
    );
    assert_eq!(conflict_commit.results[0].server_version, Some(7));
    assert_eq!(
        conflict_commit.results[0]
            .server_row
            .as_ref()
            .and_then(|row| row.get("title"))
            .and_then(Value::as_str),
        Some("Server")
    );

    let pull = decoded.pull.expect("pull response");
    let expected_pull = expected.pull.expect("expected pull response");
    assert!(pull.ok);
    assert_eq!(pull.subscriptions.len(), expected_pull.subscriptions.len());
    let subscription = &pull.subscriptions[0];
    assert_eq!(subscription.id, "sub-tasks");
    assert_eq!(subscription.status, "active");
    assert_eq!(subscription.next_cursor, 42);
    assert_eq!(
        subscription.scopes.get("user_id").and_then(Value::as_str),
        Some("user-1")
    );

    let commit = &subscription.commits[0];
    assert_eq!(commit.commit_seq, 42);
    assert_eq!(commit.actor_id, "user-2");
    let integrity = subscription
        .integrity
        .as_ref()
        .expect("subscription integrity");
    assert_eq!(
        integrity.previous_chain_root,
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
    assert_eq!(
        integrity.commit_chain_root,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(integrity.commit_seq, 42);
    assert_eq!(commit.changes.len(), 1);
    assert_eq!(commit.changes[0].table, "tasks");
    assert_eq!(commit.changes[0].row_id, "task-1");
    assert_eq!(commit.changes[0].op, "upsert");
    assert_eq!(commit.changes[0].row_version, Some(42));
    assert_eq!(
        commit.changes[0]
            .row_json
            .as_ref()
            .and_then(|row| row.get("title"))
            .and_then(Value::as_str),
        Some("Remote")
    );

    let snapshots = subscription.snapshots.as_ref().expect("snapshots");
    let chunk = &snapshots[0].chunks.as_ref().expect("chunks")[0];
    let manifest = snapshots[0].manifest.as_ref().expect("manifest");
    assert_eq!(snapshots[0].table, "tasks");
    assert!(snapshots[0].is_first_page);
    assert!(snapshots[0].is_last_page);
    assert_eq!(manifest.version, 1);
    assert_eq!(manifest.table, "tasks");
    assert_eq!(manifest.chunks[0].id, chunk.id);
    assert_eq!(chunk.id, "chunk-1");
    assert_eq!(chunk.byte_length, 128);
    assert_eq!(chunk.encoding, "binary-table-v1");
    assert_eq!(chunk.compression, "gzip");
    validate_pull_snapshot_manifests(&pull).expect("snapshot manifest validation");
}

#[test]
fn decodes_typescript_encoded_binary_snapshot_table_fixture() {
    let fixture = binary_snapshot_table_fixture();
    assert_eq!(fixture["encoding"].as_str(), Some("binary-table-v1"));
    assert_eq!(fixture["wireVersion"].as_u64(), Some(1));

    let encoded_hex = fixture["encodedHex"]
        .as_str()
        .expect("fixture encodedHex must be a string");
    let encoded = hex::decode(encoded_hex).expect("fixture encodedHex must be valid hex");
    let decoded = decode_binary_snapshot_table(&encoded).expect("decode fixture");

    assert_eq!(decoded.table, "tasks");
    assert_eq!(decoded.columns.len(), 6);
    assert_eq!(decoded.columns[0].name, "id");
    assert_eq!(
        decoded.columns[0].column_type,
        BinarySnapshotColumnType::String
    );
    assert!(!decoded.columns[0].nullable);
    assert_eq!(decoded.columns[2].name, "server_version");
    assert_eq!(
        decoded.columns[2].column_type,
        BinarySnapshotColumnType::Integer
    );
    assert_eq!(decoded.columns[3].name, "score");
    assert_eq!(
        decoded.columns[3].column_type,
        BinarySnapshotColumnType::Float
    );
    assert_eq!(decoded.columns[4].name, "done");
    assert_eq!(
        decoded.columns[4].column_type,
        BinarySnapshotColumnType::Boolean
    );
    assert_eq!(decoded.columns[5].name, "metadata");
    assert_eq!(
        decoded.columns[5].column_type,
        BinarySnapshotColumnType::Json
    );
    assert!(decoded.columns[5].nullable);

    assert_eq!(decoded.rows.len(), 2);
    assert_eq!(
        decoded.rows[0].get("id").and_then(Value::as_str),
        Some("task-1")
    );
    assert_eq!(
        decoded.rows[0].get("title").and_then(Value::as_str),
        Some("Remote")
    );
    assert_eq!(
        decoded.rows[0]
            .get("server_version")
            .and_then(Value::as_i64),
        Some(42)
    );
    assert_eq!(
        decoded.rows[0].get("score").and_then(Value::as_f64),
        Some(1.5)
    );
    assert_eq!(
        decoded.rows[0].get("done").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        decoded.rows[0]
            .get("metadata")
            .and_then(|metadata| metadata.get("priority"))
            .and_then(Value::as_str),
        Some("high")
    );
    assert_eq!(
        decoded.rows[1].get("id").and_then(Value::as_str),
        Some("task-2")
    );
    assert_eq!(
        decoded.rows[1].get("score").and_then(Value::as_f64),
        Some(-2.25)
    );
    assert_eq!(
        decoded.rows[1].get("done").and_then(Value::as_bool),
        Some(true)
    );
    assert!(decoded.rows[1].get("metadata").is_some_and(Value::is_null));
}

fn binary_sync_pack_fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/binary-sync-pack-v1-combined-response.json"
    ))
    .expect("binary sync pack fixture JSON")
}

fn sync_pack_wire_version(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[4], bytes[5]])
}

fn json_combined_sync_fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/json-combined-sync-v1.json"))
        .expect("JSON combined sync fixture")
}

fn binary_snapshot_table_fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/binary-snapshot-table-v1-tasks.json"))
        .expect("binary snapshot table fixture JSON")
}
