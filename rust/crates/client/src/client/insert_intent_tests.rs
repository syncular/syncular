use super::*;
use serde_json::{json, Value};

/// Version 1 `tasks(id, title)`; later versions append `extra` columns.
fn tasks_schema(version: i32, extra: Value) -> Value {
    let mut columns = vec![
        json!({ "name": "id", "type": "string", "nullable": false }),
        json!({ "name": "title", "type": "string", "nullable": true }),
    ];
    columns.extend(extra.as_array().cloned().unwrap_or_default());
    json!({
        "version": version,
        "tables": [{ "name": "tasks", "primaryKey": "id", "columns": columns, "scopes": [] }]
    })
}

fn with_note() -> Value {
    tasks_schema(
        2,
        json!([{ "name": "note", "type": "string", "nullable": true }]),
    )
}

fn upsert(id: &str, title: &str) -> Mutation {
    Mutation::Upsert {
        table: "tasks".into(),
        values: Map::from_iter([("id".into(), json!(id)), ("title".into(), json!(title))]),
        base_version: None,
    }
}

fn persisted_markers(client: &SyncClient) -> Vec<Vec<Option<Value>>> {
    let mut statement = client
        .conn
        .prepare("SELECT ops_json FROM _syncular_outbox ORDER BY seq")
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|raw| {
            serde_json::from_str::<Vec<Value>>(&raw.unwrap())
                .unwrap()
                .iter()
                .map(|entry| entry.get("insert").cloned())
                .collect()
        })
        .collect()
}

/// One insert of `q` queued under version 1, then the bump to `next`.
/// `strip_marker` rewrites the persisted operation into the pre-marker
/// form an earlier release wrote.
fn queued_insert_after_bump(next: &Value, strip_marker: bool) -> SyncClient {
    let mut client = SyncClient::new(
        "insert-intent".into(),
        &tasks_schema(1, json!([])),
        ClientLimits::default(),
    )
    .unwrap();
    client.mutate(vec![upsert("q", "new")]).unwrap();
    if strip_marker {
        client
            .conn
            .execute_batch(
                "UPDATE _syncular_outbox SET ops_json = json_remove(ops_json, '$[0].insert')",
            )
            .unwrap();
        Arc::make_mut(&mut client.outbox[0]).ops[0].insert = false;
    }
    client.recreate_with_schema(next).unwrap();
    client
}

/// Write `q` into the base table under the current schema and replay the
/// outbox over it.
fn seed_base_row(client: &mut SyncClient, row: Row) {
    client
        .write_row(&base_table("tasks"), "tasks", &row, 1)
        .unwrap();
    client.overlay_dirty.set(true);
    client.rebuild_overlay().unwrap();
}

fn sparse_payload(client: &SyncClient, values: Value) -> Vec<u8> {
    let table = client.schema.table("tasks").unwrap();
    encode_sparse_row_json(
        table,
        "q",
        values.as_object().unwrap(),
        &client.encryption,
        None,
    )
    .unwrap()
}

#[test]
fn mutate_records_insert_intent_only_for_rows_absent_at_call_time() {
    let mut client = SyncClient::new(
        "insert-intent".into(),
        &tasks_schema(1, json!([])),
        ClientLimits::default(),
    )
    .unwrap();
    // Both upserts of one batch see the replica as it was at call time.
    client
        .mutate(vec![upsert("a", "first"), upsert("a", "second")])
        .unwrap();
    client.mutate(vec![upsert("a", "visible")]).unwrap();
    client
        .patch(
            "tasks",
            "a",
            Map::from_iter([("title".into(), json!("patched"))]),
            None,
        )
        .unwrap();
    client
        .mutate(vec![Mutation::Delete {
            table: "tasks".into(),
            row_id: "a".into(),
            base_version: None,
        }])
        .unwrap();

    let marker = Some(Value::Bool(true));
    assert_eq!(
        persisted_markers(&client),
        vec![
            vec![marker.clone(), marker],
            vec![None],
            vec![None],
            vec![None]
        ]
    );
    let flags = |commits: &[Arc<OutboxCommit>]| {
        commits
            .iter()
            .map(|commit| commit.ops.iter().map(|op| op.insert).collect::<Vec<_>>())
            .collect::<Vec<_>>()
    };
    let expected = vec![vec![true, true], vec![false], vec![false], vec![false]];
    assert_eq!(flags(&client.outbox), expected);
    assert_eq!(
        flags(&client.load_outbox().unwrap()),
        expected,
        "reload keeps it"
    );

    // The journal and failed-commit form carries the marker only when set.
    let insert = serde_json::to_value(CommitOperation::from(&client.outbox[0].ops[0])).unwrap();
    assert_eq!(insert["insert"], json!(true));
    assert!(
        serde_json::from_value::<CommitOperation>(insert)
            .unwrap()
            .insert
    );
    let update = serde_json::to_value(CommitOperation::from(&client.outbox[1].ops[0])).unwrap();
    assert!(update.get("insert").is_none());
}

#[test]
fn insert_intent_replays_and_encodes_an_appended_nullable_column_as_null() {
    let mut client = queued_insert_after_bump(&with_note(), false);
    assert_eq!(
        client
            .query("SELECT id, title, note FROM tasks", &[])
            .unwrap(),
        vec![Map::from_iter([
            ("id".into(), json!("q")),
            ("title".into(), json!("new")),
            ("note".into(), Value::Null),
        ])],
        "the replayed insert is visible with the appended column NULL"
    );
    assert_eq!(
        client.pending_payloads().unwrap(),
        vec![sparse_payload(
            &client,
            json!({ "id": "q", "title": "new", "note": null })
        )],
        "the insert presents the appended column as NULL"
    );

    // Over an existing local row the NULL overwrites the local value.
    seed_base_row(
        &mut client,
        vec![
            Some(ColumnValue::String("q".into())),
            Some(ColumnValue::String("base".into())),
            Some(ColumnValue::String("server".into())),
        ],
    );
    assert_eq!(
        client.query("SELECT title, note FROM tasks", &[]).unwrap(),
        vec![Map::from_iter([
            ("title".into(), json!("new")),
            ("note".into(), Value::Null),
        ])]
    );
}

#[test]
fn an_operation_without_the_marker_keeps_its_presence_set() {
    let mut client = queued_insert_after_bump(&with_note(), true);
    assert!(
        client
            .query("SELECT id FROM tasks", &[])
            .unwrap()
            .is_empty(),
        "a partial operation over an absent row stays invisible"
    );
    assert_eq!(
        client.pending_payloads().unwrap(),
        vec![sparse_payload(
            &client,
            json!({ "id": "q", "title": "new" })
        )],
        "the appended column stays absent"
    );

    seed_base_row(
        &mut client,
        vec![
            Some(ColumnValue::String("q".into())),
            Some(ColumnValue::String("base".into())),
            Some(ColumnValue::String("server".into())),
        ],
    );
    assert_eq!(
        client.query("SELECT title, note FROM tasks", &[]).unwrap(),
        vec![Map::from_iter([
            ("title".into(), json!("new")),
            ("note".into(), json!("server")),
        ])],
        "the stored appended value survives"
    );
}

#[test]
fn insert_intent_missing_a_non_nullable_column_is_outbox_incompatible() {
    let with_rank = tasks_schema(
        2,
        json!([{ "name": "rank", "type": "integer", "nullable": false }]),
    );
    let mut client = SyncClient::new(
        "insert-intent".into(),
        &tasks_schema(1, json!([])),
        ClientLimits::default(),
    )
    .unwrap();
    let insert = client.mutate(vec![upsert("q", "new")]).unwrap();
    // An update of the now-visible row carries no insert intent and keeps
    // its sparse presence set.
    let update = client.mutate(vec![upsert("q", "edited")]).unwrap();
    client.recreate_with_schema(&with_rank).unwrap();
    assert_eq!(
        client.pending_commit_ids(),
        vec![insert.clone(), update.clone()],
        "the reset classifies nothing"
    );
    assert!(client.rejections.is_empty());
    assert!(
        client
            .query("SELECT id FROM tasks", &[])
            .unwrap()
            .is_empty(),
        "the unencodable insert stays invisible"
    );

    assert!(client.drop_incompatible_outbox().unwrap());
    assert_eq!(client.pending_commit_ids(), vec![update]);
    assert_eq!(client.rejections.len(), 1);
    let rejection = &client.rejections[0];
    assert_eq!(rejection.client_commit_id, insert);
    assert_eq!(rejection.code, OUTBOX_INCOMPATIBLE_CODE);
    assert!(rejection.operation.as_ref().is_some_and(|op| op.insert));
    assert!(
        client.commit_outcome(&insert).unwrap().is_some(),
        "the journal accepts the marked operation"
    );
}

#[test]
fn the_stored_operation_validator_accepts_the_marker_only_on_upserts() {
    let upsert = json!({ "table": "tasks", "rowId": "q", "op": "upsert", "values": { "id": "q" } });
    let delete = json!({ "table": "tasks", "rowId": "q", "op": "delete" });
    let with = |base: &Value, insert: Value| {
        let mut value = base.clone();
        value["insert"] = insert;
        value
    };
    assert!(SyncClient::stored_operation_is_representable(&upsert));
    assert!(SyncClient::stored_operation_is_representable(&with(
        &upsert,
        json!(true)
    )));
    assert!(!SyncClient::stored_operation_is_representable(&with(
        &upsert,
        json!(false)
    )));
    assert!(!SyncClient::stored_operation_is_representable(&with(
        &upsert,
        json!("yes")
    )));
    assert!(SyncClient::stored_operation_is_representable(&delete));
    assert!(!SyncClient::stored_operation_is_representable(&with(
        &delete,
        json!(true)
    )));
}
