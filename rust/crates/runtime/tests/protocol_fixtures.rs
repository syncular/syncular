use serde_json::Value;
use syncular_runtime::binary_sync_pack::{
    decode_binary_sync_pack, is_binary_sync_pack_content_type, SYNC_PACK_CONTENT_TYPE,
};
use syncular_runtime::protocol::CombinedResponse;

#[test]
fn decodes_typescript_encoded_binary_sync_pack_fixture() {
    let fixture = binary_sync_pack_fixture();
    assert_eq!(
        fixture["contentType"].as_str(),
        Some(SYNC_PACK_CONTENT_TYPE)
    );
    assert_eq!(fixture["wireVersion"].as_u64(), Some(9));
    assert!(is_binary_sync_pack_content_type(Some(
        "application/vnd.syncular.sync-pack.v1; charset=binary"
    )));

    let expected: CombinedResponse =
        serde_json::from_value(fixture["decodedResponse"].clone()).expect("fixture response");
    let encoded_hex = fixture["encodedHex"]
        .as_str()
        .expect("fixture encodedHex must be a string");
    let encoded = hex::decode(encoded_hex).expect("fixture encodedHex must be valid hex");
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
    assert_eq!(conflict_commit.results[0].code.as_deref(), Some("CONFLICT"));
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
    assert_eq!(snapshots[0].table, "tasks");
    assert!(snapshots[0].is_first_page);
    assert!(snapshots[0].is_last_page);
    assert_eq!(chunk.id, "chunk-1");
    assert_eq!(chunk.byte_length, 128);
    assert_eq!(chunk.encoding, "binary-table-v1");
    assert_eq!(chunk.compression, "gzip");
}

fn binary_sync_pack_fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/binary-sync-pack-v1-combined-response.json"
    ))
    .expect("binary sync pack fixture JSON")
}
