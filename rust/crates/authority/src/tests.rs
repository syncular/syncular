//! Crate tests: the §12.2 profile through `sync` bytes, and §12.3 attach and
//! abandon against a second `LocalAuthority` serving as the remote server.

use std::cell::Cell;

use serde_json::{json, Value};
use ssp2::decode::WIRE_VERSION;
use ssp2::model::{Frame, Message, MsgKind, Op, OpResult, Operation, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, encode_sparse_row, ColumnValue, SparseSlot};
use ssp2::{decode_message, encode_message};

use super::*;

fn column(name: &str, ty: &str, nullable: bool) -> Value {
    json!({ "name": name, "type": ty, "nullable": nullable })
}

fn table(name: &str, columns: Vec<Value>, extra: Value) -> Value {
    let mut table = json!({
        "name": name,
        "primaryKey": "id",
        "columns": columns,
        "scopes": [{ "pattern": "org:{org}" }],
    });
    for (key, value) in extra.as_object().expect("an object") {
        table[key] = value.clone();
    }
    table
}

fn reference(column: &str, parent: &str, on_delete: &str, index: &str) -> Value {
    json!({
        "references": [{ "column": column, "parentTable": parent, "onDelete": on_delete }],
        "indexes": [{ "name": index, "columns": [column], "unique": false }],
    })
}

/// Version 2 appends a nullable `estimate` to `tasks` and adds `labels`.
fn schema_json(version: i32) -> Value {
    let base = |name: &str| {
        vec![
            column("id", "string", false),
            column("org", "string", false),
            column(name, "string", true),
        ]
    };
    let mut task_columns = vec![
        column("id", "string", false),
        column("org", "string", false),
        column("project_id", "string", true),
        column("title", "string", false),
        column("code", "string", true),
    ];
    if version >= 2 {
        task_columns.push(column("estimate", "integer", true));
    }
    let mut tables = vec![
        table("projects", base("name"), json!({})),
        table(
            "tasks",
            task_columns,
            json!({
                "references": [{ "column": "project_id", "parentTable": "projects", "onDelete": "CASCADE" }],
                "indexes": [
                    { "name": "tasks_project", "columns": ["project_id"], "unique": false },
                    { "name": "tasks_code", "columns": ["code"], "unique": true },
                ],
            }),
        ),
        table(
            "notes",
            base("task_id"),
            reference("task_id", "tasks", "SET NULL", "notes_task"),
        ),
        table(
            "pins",
            vec![
                column("id", "string", false),
                column("org", "string", false),
                column("task_id", "string", false),
            ],
            reference("task_id", "tasks", "RESTRICT", "pins_task"),
        ),
        table(
            "nodes",
            base("parent_id"),
            reference("parent_id", "nodes", "SET NULL", "nodes_parent"),
        ),
        table(
            "docs",
            vec![
                column("id", "string", false),
                column("org", "string", false),
                json!({ "name": "body", "type": "crdt", "nullable": true, "crdtType": "yjs-doc" }),
            ],
            json!({}),
        ),
    ];
    if version >= 2 {
        tables.push(table("labels", base("name"), json!({})));
    }
    json!({ "version": version, "tables": tables })
}

fn memory() -> LocalAuthority {
    LocalAuthority::open(":memory:", &schema_json(1)).expect("open")
}

fn temp_path() -> String {
    std::env::temp_dir()
        .join(format!(
            "syncular-authority-{}.sqlite",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned()
}

fn decode(bytes: &[u8]) -> Vec<Frame> {
    let message = decode_message(bytes).expect("a response decodes");
    assert_eq!(message.msg_kind, MsgKind::Response);
    message.frames
}

fn empty_pull() -> Frame {
    Frame::PullHeader {
        limit_commits: 0,
        limit_snapshot_rows: 0,
        max_snapshot_pages: 0,
        accept: 0b0011,
    }
}

fn encode_request(
    client_id: &str,
    schema_version: i32,
    log_epoch: Option<String>,
    mut frames: Vec<Frame>,
) -> Vec<u8> {
    frames.insert(
        0,
        Frame::ReqHeader {
            client_id: client_id.to_owned(),
            schema_version,
            log_epoch,
        },
    );
    encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Request,
        frames,
    })
}

/// A client bound to an authority's `logEpoch`.
struct Session {
    client_id: String,
    epoch: String,
    version: i32,
}

impl Session {
    fn new(authority: &mut LocalAuthority, client_id: &str) -> Session {
        let version = authority.schema.version;
        let frames = decode(
            &authority
                .sync(&encode_request(
                    client_id,
                    version,
                    None,
                    vec![empty_pull()],
                ))
                .expect("acquire"),
        );
        let Some(Frame::RespHeader {
            log_epoch: Some(epoch),
            reset_required: Some(true),
            ..
        }) = frames.first()
        else {
            panic!("epoch acquisition answers the log epoch: {frames:?}");
        };
        assert_eq!(frames.len(), 1);
        Session {
            client_id: client_id.to_owned(),
            epoch: epoch.clone(),
            version,
        }
    }

    fn round(&self, authority: &mut LocalAuthority, frames: Vec<Frame>) -> Vec<Frame> {
        let request = encode_request(
            &self.client_id,
            self.version,
            Some(self.epoch.clone()),
            frames,
        );
        decode(&authority.sync(&request).expect("round"))
    }

    /// Push one commit; its status, results and §6.3.1 details.
    fn push(
        &self,
        authority: &mut LocalAuthority,
        id: &str,
        operations: Vec<Operation>,
    ) -> (PushStatus, Vec<OpResult>, Option<String>) {
        let frames = self.round(
            authority,
            vec![Frame::PushCommit {
                client_commit_id: id.to_owned(),
                operations,
            }],
        );
        let Some(Frame::PushResult {
            status, results, ..
        }) = frames.get(1)
        else {
            panic!("a PUSH_RESULT follows the header: {frames:?}");
        };
        let details = frames.iter().find_map(|frame| match frame {
            Frame::PushResultDetails { entries, .. } => Some(entries[0].details.0.clone()),
            _ => None,
        });
        (*status, results.clone(), details)
    }

    fn pull(
        &self,
        authority: &mut LocalAuthority,
        subscriptions: Vec<Frame>,
        rows: i32,
        pages: i32,
    ) -> Vec<Frame> {
        let mut frames = vec![Frame::PullHeader {
            limit_commits: 0,
            limit_snapshot_rows: rows,
            max_snapshot_pages: pages,
            accept: 0b0011,
        }];
        frames.extend(subscriptions);
        self.round(authority, frames)
    }
}

fn subscription(table: &str, cursor: i64, token: Option<String>) -> Frame {
    Frame::Subscription {
        id: format!("sub-{table}"),
        table: table.to_owned(),
        scopes: vec![("org".to_owned(), vec!["o1".to_owned()])],
        params: None,
        cursor,
        bootstrap_state: token.map(RawJson),
    }
}

fn upsert(
    schema: &schema::Schema,
    table: &str,
    values: &[Option<&str>],
    base_version: Option<i64>,
) -> Operation {
    let compiled = schema.table(table).expect("table");
    let slots = values
        .iter()
        .map(|value| match value {
            Some(text) => SparseSlot::Value(ColumnValue::String((*text).to_owned())),
            None => SparseSlot::Null,
        })
        .collect();
    Operation {
        table: table.to_owned(),
        row_id: values[0].expect("an id").to_owned(),
        op: Op::Upsert,
        base_version,
        payload: Some(encode_sparse_row(&compiled.columns, compiled.pk, &slots)),
    }
}

fn delete(table: &str, row_id: &str) -> Operation {
    Operation {
        table: table.to_owned(),
        row_id: row_id.to_owned(),
        op: Op::Delete,
        base_version: None,
        payload: None,
    }
}

fn task(schema: &schema::Schema, id: &str, project: Option<&str>, code: Option<&str>) -> Operation {
    upsert(
        schema,
        "tasks",
        &[Some(id), Some("o1"), project, Some("title"), code],
        None,
    )
}

fn error_code(results: &[OpResult]) -> (i32, String) {
    match &results[0] {
        OpResult::Error { op_index, code, .. } => (*op_index, code.clone()),
        other => panic!("expected an error record, got {other:?}"),
    }
}

/// The current row of `table` straight from storage: version and values.
fn stored(
    authority: &LocalAuthority,
    table: &str,
    row_id: &str,
) -> Option<(i64, Vec<Option<ColumnValue>>)> {
    let compiled = authority.schema.table(table).expect("table");
    store::get_row(&authority.conn, table, row_id)
        .expect("read")
        .map(|row| {
            (
                row.version,
                store::decode_payload(&compiled.columns, &row.payload).expect("payload"),
            )
        })
}

fn text(value: &str) -> Option<ColumnValue> {
    Some(ColumnValue::String(value.to_owned()))
}

/// Row ids and versions of every inline segment in a response.
fn segment_rows(frames: &[Frame]) -> Vec<(String, i64)> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::SegmentInline { payload } => {
                Some(decode_rows_segment(payload).expect("segment"))
            }
            _ => None,
        })
        .flat_map(|segment| segment.blocks.into_iter().flatten())
        .map(|row| match &row.values[0] {
            Some(ColumnValue::String(id)) => (id.clone(), row.server_version),
            other => panic!("string id, got {other:?}"),
        })
        .collect()
}

fn sub_end(frames: &[Frame]) -> (i64, Option<String>) {
    frames
        .iter()
        .find_map(|frame| match frame {
            Frame::SubEnd {
                next_cursor,
                bootstrap_state,
            } => Some((
                *next_cursor,
                bootstrap_state.as_ref().map(|raw| raw.0.clone()),
            )),
            _ => None,
        })
        .expect("a SUB_END")
}

fn count(authority: &LocalAuthority, table: &str) -> i64 {
    authority
        .conn
        .query_row(
            &format!("SELECT count(*) FROM {}", store::quote(table)),
            [],
            |row| row.get(0),
        )
        .expect("count")
}

#[test]
fn push_pull_round_trip() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let p1 = upsert(
        &s,
        "projects",
        &[Some("p1"), Some("o1"), Some("Alpha")],
        None,
    );
    let t1 = task(&s, "t1", Some("p1"), None);
    let (status, results, _) = client.push(&mut authority, "c1:0", vec![p1, t1]);
    assert_eq!(status, PushStatus::Applied);
    assert_eq!(
        results,
        vec![
            OpResult::Applied { op_index: 0 },
            OpResult::Applied { op_index: 1 }
        ]
    );

    let frames = client.pull(&mut authority, vec![subscription("tasks", -1, None)], 0, 0);
    assert!(matches!(
        &frames[1],
        Frame::SubStart { status: SubStatus::Active, bootstrap: true, effective_scopes, .. }
            if effective_scopes == &vec![("org".to_owned(), vec!["o1".to_owned()])]
    ));
    assert_eq!(segment_rows(&frames), vec![("t1".to_owned(), 1)]);
    assert_eq!(sub_end(&frames), (1, None));

    let update = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), Some("p1"), Some("renamed"), None],
        Some(1),
    );
    let (status, ..) = client.push(&mut authority, "c1:1", vec![update.clone()]);
    assert_eq!(status, PushStatus::Applied);
    // §2.3: a replay answers the persisted result as `cached`.
    let frames = client.round(
        &mut authority,
        vec![Frame::PushCommit {
            client_commit_id: "c1:1".to_owned(),
            operations: vec![update],
        }],
    );
    assert!(matches!(
        &frames[1],
        Frame::PushResult {
            status: PushStatus::Cached,
            commit_seq: Some(2),
            ..
        }
    ));

    let frames = client.pull(&mut authority, vec![subscription("tasks", 1, None)], 0, 0);
    let Frame::Commit {
        commit_seq,
        changes,
        actor_id,
        tables,
        ..
    } = &frames[2]
    else {
        panic!("an incremental COMMIT: {frames:?}");
    };
    assert_eq!(
        (*commit_seq, actor_id.as_str(), tables.clone()),
        (2, "local", vec!["tasks".to_owned()])
    );
    assert_eq!(changes[0].row_version, Some(2));
    assert_eq!(changes[0].scopes, vec![("org".to_owned(), "o1".to_owned())]);
    assert_eq!(sub_end(&frames), (2, None));

    // The conformance reader's view: the reference server row-table layout.
    let (version, scopes): (i64, String) = authority
        .conn
        .query_row(
            "SELECT _sync_server_version, _sync_scopes FROM tasks WHERE _sync_partition='local' AND _sync_row_id='t1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("row");
    assert_eq!((version, scopes.as_str()), (2, r#"{"org":"o1"}"#));
}

#[test]
fn version_conflict_marks_the_moved_columns() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    let rename = |title: &str, base| {
        let compiled = s.table("tasks").unwrap();
        let slots = vec![
            SparseSlot::Value(ColumnValue::String("t1".to_owned())),
            SparseSlot::Absent,
            SparseSlot::Absent,
            SparseSlot::Value(ColumnValue::String(title.to_owned())),
            SparseSlot::Absent,
        ];
        Operation {
            table: "tasks".to_owned(),
            row_id: "t1".to_owned(),
            op: Op::Upsert,
            base_version: Some(base),
            payload: Some(encode_sparse_row(&compiled.columns, compiled.pk, &slots)),
        }
    };
    let first = rename("one", 1);
    let stale = rename("two", 1);
    assert_eq!(
        client.push(&mut authority, "b", vec![first]).0,
        PushStatus::Applied
    );
    let (status, results, _) = client.push(&mut authority, "c", vec![stale]);
    assert_eq!(status, PushStatus::Rejected);
    let OpResult::Conflict {
        code,
        server_version,
        conflict_columns,
        server_row,
        ..
    } = &results[0]
    else {
        panic!("a conflict record: {results:?}");
    };
    assert_eq!(
        (code.as_str(), *server_version),
        ("sync.version_conflict", 2)
    );
    assert_eq!(conflict_columns, &vec![0b0000_1000]);
    let row = store::decode_payload(
        &authority.schema.table("tasks").unwrap().columns,
        server_row,
    )
    .unwrap();
    assert_eq!(row[3], text("one"));
    // A lost insert race marks every present non-primary-key column.
    let (_, results, _) = client.push(
        &mut authority,
        "d",
        vec![upsert(
            &s,
            "tasks",
            &[Some("t1"), Some("o1"), None, Some("x"), None],
            Some(0),
        )],
    );
    assert!(
        matches!(&results[0], OpResult::Conflict { conflict_columns, .. } if conflict_columns == &vec![0b0001_1110])
    );
    // baseVersion past the server version is a request the server never issued.
    let (_, results, _) = client.push(&mut authority, "e", vec![rename("three", 7)]);
    assert_eq!(error_code(&results), (0, "sync.invalid_request".to_owned()));
}

#[test]
fn a_tombstone_beats_an_unversioned_upsert_and_an_insert_recreates() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    assert_eq!(
        client
            .push(&mut authority, "b", vec![delete("tasks", "t1")])
            .0,
        PushStatus::Applied
    );
    let (_, results, _) = client.push(&mut authority, "c", vec![task(&s, "t1", None, None)]);
    assert_eq!(error_code(&results), (0, "sync.row_deleted".to_owned()));
    let recreate = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), None, Some("again"), None],
        Some(0),
    );
    assert_eq!(
        client.push(&mut authority, "d", vec![recreate]).0,
        PushStatus::Applied
    );
    assert_eq!(
        stored(&authority, "tasks", "t1").map(|(version, _)| version),
        Some(1)
    );
    assert!(!store::has_tombstone(&authority.conn, "tasks", "t1").unwrap());
    // Deleting an absent row is applied with no change.
    assert_eq!(
        client
            .push(&mut authority, "e", vec![delete("tasks", "nope")])
            .0,
        PushStatus::Applied
    );
}

#[test]
fn declared_references_cascade_set_null_and_restrict() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let (status, results, details) = client.push(
        &mut authority,
        "a",
        vec![task(&s, "t0", Some("nope"), None)],
    );
    assert_eq!(status, PushStatus::Rejected);
    assert_eq!(
        error_code(&results),
        (0, "sync.reference_violation".to_owned())
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details.unwrap()).unwrap(),
        json!({ "reason": "missing_parent", "fieldPaths": ["project_id"], "references": { "parent": "projects", "row": "nope" } })
    );

    let operations = vec![
        upsert(&s, "projects", &[Some("p1"), Some("o1"), None], None),
        task(&s, "t1", Some("p1"), None),
        task(&s, "t2", None, None),
        upsert(&s, "notes", &[Some("n1"), Some("o1"), Some("t1")], None),
        upsert(&s, "pins", &[Some("x1"), Some("o1"), Some("t2")], None),
    ];
    assert_eq!(
        client.push(&mut authority, "b", operations).0,
        PushStatus::Applied
    );

    let (status, results, details) = client.push(&mut authority, "c", vec![delete("tasks", "t2")]);
    assert_eq!(
        (status, error_code(&results)),
        (
            PushStatus::Rejected,
            (0, "sync.reference_violation".to_owned())
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details.unwrap()).unwrap(),
        json!({ "reason": "restricted_delete", "references": { "child": "pins" } })
    );

    assert_eq!(
        client
            .push(&mut authority, "d", vec![delete("projects", "p1")])
            .0,
        PushStatus::Applied
    );
    assert!(stored(&authority, "tasks", "t1").is_none());
    let (version, values) = stored(&authority, "notes", "n1").expect("the SET NULL child stays");
    assert_eq!((version, values[2].clone()), (2, None));
    let frames = client.pull(&mut authority, vec![subscription("notes", 1, None)], 0, 0);
    let Frame::Commit { changes, .. } = &frames[2] else {
        panic!("{frames:?}")
    };
    assert_eq!(
        (changes[0].op, changes[0].row_version),
        (Op::Upsert, Some(2))
    );
    assert!(store::has_tombstone(&authority.conn, "tasks", "t1").unwrap());
}

#[test]
fn the_cascade_cap_rejects_the_originating_delete() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(
        &mut authority,
        "p",
        vec![upsert(
            &s,
            "projects",
            &[Some("p1"), Some("o1"), None],
            None,
        )],
    );
    for batch in 0..3 {
        let operations = (batch * 500..(batch * 500 + 500).min(1001))
            .map(|i| task(&s, &format!("t{i:04}"), Some("p1"), None))
            .collect();
        assert_eq!(
            client
                .push(&mut authority, &format!("b{batch}"), operations)
                .0,
            PushStatus::Applied
        );
    }
    let (status, results, details) =
        client.push(&mut authority, "d", vec![delete("projects", "p1")]);
    assert_eq!(
        (status, error_code(&results)),
        (
            PushStatus::Rejected,
            (0, "sync.reference_violation".to_owned())
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details.unwrap()).unwrap(),
        json!({ "reason": "cascade_limit" })
    );
    assert_eq!(count(&authority, "tasks"), 1001);
}

#[test]
fn a_unique_index_rejects_the_commit() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, Some("X"))]);
    let rejected = vec![
        task(&s, "t2", None, Some("Y")),
        task(&s, "t3", None, Some("X")),
    ];
    let (status, results, _) = client.push(&mut authority, "b", rejected.clone());
    assert_eq!(
        (status, error_code(&results)),
        (
            PushStatus::Rejected,
            (1, "sync.constraint_violation".to_owned())
        )
    );
    assert!(
        stored(&authority, "tasks", "t2").is_none(),
        "the commit rolls back whole"
    );
    // NULL codes never collide.
    let operations = vec![task(&s, "t4", None, None), task(&s, "t5", None, None)];
    assert_eq!(
        client.push(&mut authority, "c", operations).0,
        PushStatus::Applied
    );
    // A rejection replays as the persisted rejection.
    let (status, results, _) = client.push(&mut authority, "b", rejected);
    assert_eq!(
        (status, error_code(&results).1),
        (PushStatus::Rejected, "sync.constraint_violation".to_owned())
    );
}

#[test]
fn bootstrap_pages_resume_through_the_token() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let operations = ["t1", "t2", "t3", "t4", "t5"]
        .iter()
        .map(|id| task(&s, id, None, None))
        .collect();
    client.push(&mut authority, "a", operations);
    let mut token = None;
    let mut seen = Vec::new();
    for expected in [vec!["t1", "t2"], vec!["t3", "t4"], vec!["t5"]] {
        let frames = client.pull(
            &mut authority,
            vec![subscription("tasks", -1, token.clone())],
            2,
            1,
        );
        let rows: Vec<String> = segment_rows(&frames)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(rows, expected);
        seen.extend(rows);
        let (cursor, next) = sub_end(&frames);
        assert_eq!(cursor, 1);
        token = next;
    }
    assert!(token.is_none(), "the last page completes the bootstrap");
    assert_eq!(seen.len(), 5);
    let frames = client.pull(&mut authority, vec![subscription("tasks", -1, None)], 2, 1);
    assert_eq!(
        sub_end(&frames).1.as_deref(),
        Some(r#"{"asOfCommitSeq":1,"tables":["tasks"],"tableIndex":0,"rowCursor":"t2"}"#)
    );
}

#[test]
fn a_cursor_behind_the_horizon_resets() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    for id in ["t1", "t2", "t3"] {
        client.push(&mut authority, id, vec![task(&s, id, None, None)]);
    }
    client.push(&mut authority, "d", vec![delete("tasks", "t1")]);
    // Past the age-force limit, with one retained commit: horizon = 3.
    let horizon = store::prune(
        &authority.conn,
        store::now_ms() + 31 * 24 * 60 * 60 * 1000,
        1,
    )
    .unwrap();
    assert_eq!(horizon, 3);
    assert!(
        store::has_tombstone(&authority.conn, "tasks", "t1").unwrap(),
        "seq 4 survives"
    );
    let frames = client.pull(&mut authority, vec![subscription("tasks", 1, None)], 0, 0);
    assert!(matches!(
        &frames[1],
        Frame::SubStart { status: SubStatus::Reset, reason_code, .. } if reason_code == "sync.cursor_expired"
    ));
    assert_eq!(sub_end(&frames), (1, None));
    let frames = client.pull(&mut authority, vec![subscription("tasks", 3, None)], 0, 0);
    assert!(matches!(&frames[2], Frame::Commit { commit_seq: 4, .. }));
}

#[test]
fn a_schema_bump_appends_a_nullable_column_and_keeps_rows() {
    let path = temp_path();
    {
        let mut authority = LocalAuthority::open(&path, &schema_json(1)).unwrap();
        let s = authority.schema.clone();
        let client = Session::new(&mut authority, "c1");
        client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    }
    let mut authority = LocalAuthority::open(&path, &schema_json(2)).unwrap();
    let s = authority.schema.clone();
    let mut client = Session::new(&mut authority, "c1");
    let frames = client.pull(&mut authority, vec![subscription("tasks", -1, None)], 0, 0);
    let segment = frames
        .iter()
        .find_map(|frame| match frame {
            Frame::SegmentInline { payload } => Some(decode_rows_segment(payload).unwrap()),
            _ => None,
        })
        .unwrap();
    assert_eq!((segment.schema_version, segment.columns.len()), (2, 6));
    assert_eq!(segment.blocks[0][0].values[5], None);
    // The logged change was re-encoded to the new layout too.
    let frames = client.pull(&mut authority, vec![subscription("tasks", 0, None)], 0, 0);
    let Frame::Commit { changes, .. } = &frames[2] else {
        panic!("{frames:?}")
    };
    let row = store::decode_payload(
        &authority.schema.table("tasks").unwrap().columns,
        changes[0].row.as_ref().unwrap(),
    )
    .unwrap();
    assert_eq!((row[0].clone(), row[5].clone()), (text("t1"), None));
    let labels = upsert(&s, "labels", &[Some("l1"), Some("o1"), None], None);
    assert_eq!(
        client.push(&mut authority, "b", vec![labels]).0,
        PushStatus::Applied
    );
    // A version-1 client meets the schema floor.
    client.version = 1;
    let frames = client.round(&mut authority, vec![empty_pull()]);
    assert!(matches!(
        &frames[..],
        [Frame::RespHeader {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
            ..
        }]
    ));
    drop(authority);
    // Reopening an older schema against the migrated database is refused.
    let error = LocalAuthority::open(&path, &schema_json(1)).err().unwrap();
    assert_eq!(error.code, "sync.schema_not_ready");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn request_validation_fails_before_any_byte() {
    let mut authority = memory();
    let client = Session::new(&mut authority, "c1");
    let epochless = encode_request(
        "c1",
        1,
        None,
        vec![Frame::PushCommit {
            client_commit_id: "a".to_owned(),
            operations: vec![delete("tasks", "t1")],
        }],
    );
    assert_eq!(
        authority.sync(&epochless).unwrap_err().code,
        "sync.invalid_request"
    );
    let unknown = encode_request(
        "c1",
        1,
        Some(client.epoch.clone()),
        vec![
            Frame::PullHeader {
                limit_commits: 0,
                limit_snapshot_rows: 0,
                max_snapshot_pages: 0,
                accept: 3,
            },
            subscription("missing", -1, None),
        ],
    );
    assert_eq!(
        authority.sync(&unknown).unwrap_err().code,
        "sync.unknown_table"
    );
    let stale = encode_request("c1", 1, Some("other".to_owned()), vec![empty_pull()]);
    let frames = decode(&authority.sync(&stale).unwrap());
    assert!(matches!(
        &frames[..],
        [Frame::RespHeader {
            reset_required: Some(true),
            ..
        }]
    ));
}

#[cfg(not(feature = "crdt-yjs"))]
#[test]
fn a_crdt_push_without_a_merger_fails_the_merge() {
    let mut authority = memory();
    let client = Session::new(&mut authority, "c1");
    let compiled = authority.schema.table("docs").unwrap().clone();
    let slots = vec![
        SparseSlot::Value(ColumnValue::String("d1".to_owned())),
        SparseSlot::Value(ColumnValue::String("o1".to_owned())),
        SparseSlot::Value(ColumnValue::Crdt(vec![0, 0])),
    ];
    let operation = Operation {
        table: "docs".to_owned(),
        row_id: "d1".to_owned(),
        op: Op::Upsert,
        base_version: None,
        payload: Some(encode_sparse_row(&compiled.columns, compiled.pk, &slots)),
    };
    let (_, results, _) = client.push(&mut authority, "a", vec![operation]);
    assert_eq!(
        error_code(&results),
        (0, "sync.crdt_merge_failed".to_owned())
    );
}

#[cfg(feature = "crdt-yjs")]
#[test]
fn the_yjs_merger_merges_concurrent_updates() {
    use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact};
    let update = |content: &str| {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("text");
        text.insert(&mut doc.transact_mut(), 0, content);
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        bytes
    };
    let mut authority = memory();
    let client = Session::new(&mut authority, "c1");
    let compiled = authority.schema.table("docs").unwrap().clone();
    let push = |bytes: Vec<u8>| {
        let slots = vec![
            SparseSlot::Value(ColumnValue::String("d1".to_owned())),
            SparseSlot::Value(ColumnValue::String("o1".to_owned())),
            SparseSlot::Value(ColumnValue::Crdt(bytes)),
        ];
        Operation {
            table: "docs".to_owned(),
            row_id: "d1".to_owned(),
            op: Op::Upsert,
            base_version: None,
            payload: Some(encode_sparse_row(&compiled.columns, compiled.pk, &slots)),
        }
    };
    assert_eq!(
        client
            .push(&mut authority, "a", vec![push(update("hello"))])
            .0,
        PushStatus::Applied
    );
    assert_eq!(
        client
            .push(&mut authority, "b", vec![push(update("world"))])
            .0,
        PushStatus::Applied
    );
    let (_, values) = stored(&authority, "docs", "d1").unwrap();
    let Some(ColumnValue::Crdt(merged)) = &values[2] else {
        panic!("crdt bytes")
    };
    let doc = Doc::new();
    {
        use yrs::updates::decoder::Decode;
        doc.transact_mut()
            .apply_update(yrs::Update::decode_v1(merged).unwrap())
            .unwrap();
    }
    let merged_text = doc.get_or_insert_text("text").get_string(&doc.transact());
    assert_eq!(
        merged_text.len(),
        10,
        "both concurrent inserts survive: {merged_text}"
    );
    let (_, results, _) = client.push(&mut authority, "c", vec![push(vec![0xff, 0xff])]);
    assert_eq!(
        error_code(&results),
        (0, "sync.crdt_merge_failed".to_owned())
    );
}

// ----- §12.3 attach -----

/// Plan order and packing are the contract a resumed attach relies on.
#[test]
fn attach_orders_parents_first_and_keeps_a_cycle_whole() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    let operations = vec![
        // A chain whose child sorts before its parent: n1 → n3, n2 → n1.
        upsert(&s, "nodes", &[Some("n1"), Some("o1"), Some("n3")], None),
        upsert(&s, "nodes", &[Some("n2"), Some("o1"), Some("n1")], None),
        upsert(&s, "nodes", &[Some("n3"), Some("o1"), None], None),
        // A two-row cycle, legal inside one commit.
        upsert(&s, "nodes", &[Some("c1"), Some("o1"), Some("c2")], None),
        upsert(&s, "nodes", &[Some("c2"), Some("o1"), Some("c1")], None),
        // Across tables: `notes` sorts before its parents `tasks`, `projects`.
        upsert(&s, "projects", &[Some("p1"), Some("o1"), None], None),
        task(&s, "t1", Some("p1"), None),
        upsert(&s, "notes", &[Some("x1"), Some("o1"), Some("t1")], None),
    ];
    assert_eq!(
        client.push(&mut local, "a", operations).0,
        PushStatus::Applied
    );
    let plan = attach::plan(&local.conn, &local.schema, "A").unwrap();
    let order: Vec<String> = plan[0]
        .1
        .iter()
        .map(|op| format!("{}/{}", op.table, op.row_id))
        .collect();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].0, "A:0");
    assert_eq!(
        order,
        [
            "nodes/c1",
            "nodes/c2",
            "nodes/n3",
            "nodes/n1",
            "nodes/n2",
            "projects/p1",
            "tasks/t1",
            "notes/x1"
        ]
    );
    assert!(plan[0].1.iter().all(|op| op.base_version == Some(0)));

    let mut remote = memory();
    {
        let mut transport = |bytes: &[u8]| remote.sync(bytes);
        local.attach(&mut transport).unwrap();
    }
    assert_eq!(local.state(), AuthorityState::Attached);
    for (table, row_id) in [
        ("nodes", "n2"),
        ("nodes", "c1"),
        ("notes", "x1"),
        ("projects", "p1"),
    ] {
        assert_eq!(
            stored(&remote, table, row_id).map(|(version, _)| version),
            Some(1),
            "{table}/{row_id}"
        );
    }
}

#[test]
fn attach_packs_whole_components_into_500_operation_commits() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    for batch in 0..2 {
        let operations = (batch * 300..batch * 300 + 300)
            .map(|i| task(&s, &format!("t{i:04}"), None, None))
            .collect();
        client.push(&mut local, &format!("b{batch}"), operations);
    }
    let plan = attach::plan(&local.conn, &local.schema, "A").unwrap();
    let sizes: Vec<(String, usize)> = plan
        .iter()
        .map(|(id, ops)| (id.clone(), ops.len()))
        .collect();
    assert_eq!(
        sizes,
        vec![("A:0".to_owned(), 500), ("A:1".to_owned(), 100)]
    );
}

#[test]
fn attach_resumes_after_a_lost_response_and_the_remote_answers_cached() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    client.push(&mut local, "a", vec![task(&s, "t1", None, None)]);
    let mut remote = memory();
    let pushes = Cell::new(0);
    {
        let mut transport = |bytes: &[u8]| {
            let response = remote.sync(bytes)?;
            let frames = decode(&response);
            if frames
                .iter()
                .any(|frame| matches!(frame, Frame::PushResult { .. }))
            {
                pushes.set(pushes.get() + 1);
                if pushes.get() == 1 {
                    return Err(AuthorityError::new(
                        "sync.transport_failed",
                        "the response was lost",
                    ));
                }
                assert!(frames.iter().any(|frame| matches!(
                    frame,
                    Frame::PushResult {
                        status: PushStatus::Cached,
                        ..
                    }
                )));
            }
            Ok(response)
        };
        let error = local.attach(&mut transport).unwrap_err();
        assert_eq!(
            error.code, "sync.transport_failed",
            "the transport's error is returned unchanged"
        );
        assert_eq!(local.state(), AuthorityState::Attaching);
        local.attach(&mut transport).unwrap();
    }
    assert_eq!(pushes.get(), 2);
    assert_eq!(local.state(), AuthorityState::Attached);
    assert_eq!(
        store::log_state(&remote.conn).unwrap().max_seq,
        1,
        "the row applied exactly once"
    );
}

#[test]
fn a_rejected_commit_is_terminal_until_abandoned() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    client.push(&mut local, "a", vec![task(&s, "t1", None, None)]);
    let mut remote = memory();
    let other = Session::new(&mut remote, "other");
    other.push(&mut remote, "a", vec![task(&s, "t1", None, None)]);
    let attach_id;
    {
        let mut transport = |bytes: &[u8]| remote.sync(bytes);
        let first = local.attach(&mut transport).unwrap_err();
        attach_id = local.attach_id().unwrap();
        assert_eq!(first.code, "sync.attach_rejected");
        assert_eq!(
            first.details,
            Some(json!({
                "reason": "commit_rejected",
                "clientCommitId": format!("{attach_id}:0"),
                "opIndex": 0,
                "code": "sync.version_conflict",
            }))
        );
        assert_eq!(
            local.attach(&mut transport).unwrap_err(),
            first,
            "the remote replays the rejection"
        );
        assert_eq!(
            local.sync(&[]).unwrap_err().details,
            Some(json!({ "state": "attaching" }))
        );
        local.abandon_attach(Some(&mut transport)).unwrap();
    }
    assert_eq!(local.state(), AuthorityState::Local);
    assert!(local.read_meta("attach_id").unwrap().is_none());
    // The client is served again.
    assert_eq!(
        client.push(&mut local, "b", vec![delete("tasks", "t1")]).0,
        PushStatus::Applied
    );
    assert!(
        stored(&remote, "tasks", "t1").is_some(),
        "the remote keeps its own row"
    );
}

#[test]
fn abandon_deletes_the_applied_prefix_in_reverse_plan_order() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    // 501 rows: commit 0 holds t0000..t0499, commit 1 holds t0500.
    for batch in 0..2 {
        let operations = (batch * 500..(batch * 500 + 500).min(501))
            .map(|i| task(&s, &format!("t{i:04}"), None, None))
            .collect();
        client.push(&mut local, &format!("b{batch}"), operations);
    }
    let mut remote = memory();
    let other = Session::new(&mut remote, "other");
    other.push(&mut remote, "a", vec![task(&s, "t0500", None, None)]);
    let undo = std::cell::RefCell::new(Vec::new());
    {
        let mut transport = |bytes: &[u8]| {
            let message = decode_message(bytes).unwrap();
            for frame in &message.frames {
                if let Frame::PushCommit {
                    client_commit_id,
                    operations,
                } = frame
                {
                    if client_commit_id.contains(":undo:") {
                        undo.borrow_mut()
                            .push((client_commit_id.clone(), operations.clone()));
                    }
                }
            }
            remote.sync(bytes)
        };
        let error = local.attach(&mut transport).unwrap_err();
        assert_eq!(
            error.details.as_ref().unwrap()["clientCommitId"],
            json!(format!("{}:1", local.attach_id().unwrap()))
        );
        assert_eq!(
            (
                local.ordinal("sent").unwrap(),
                local.ordinal("applied").unwrap()
            ),
            (1, 0)
        );
        // Abandoning after an upload request reached the remote needs the transport.
        assert_eq!(
            local.abandon_attach(None).unwrap_err().code,
            "sync.invalid_request"
        );
        local.abandon_attach(Some(&mut transport)).unwrap();
    }
    let undo = undo.into_inner();
    assert_eq!(undo.len(), 1);
    assert!(undo[0].0.ends_with(":undo:0"));
    assert_eq!(undo[0].1.len(), 500);
    assert_eq!(
        (undo[0].1[0].row_id.as_str(), undo[0].1[499].row_id.as_str()),
        ("t0499", "t0000")
    );
    assert!(undo[0].1.iter().all(|op| op.op == Op::Delete));
    assert_eq!(
        count(&remote, "tasks"),
        1,
        "only the remote's own row remains"
    );
    assert!(store::has_tombstone(&remote.conn, "tasks", "t0000").unwrap());
    assert_eq!(local.state(), AuthorityState::Local);
    assert_eq!(count(&local, "tasks"), 501);
}

#[test]
fn a_cycle_larger_than_one_commit_stops_attach_before_any_upload() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    let node = |i: usize, parent: Option<usize>| {
        let id = format!("n{i:03}");
        let parent = parent.map(|p| format!("n{p:03}"));
        upsert(
            &s,
            "nodes",
            &[Some(&id), Some("o1"), parent.as_deref()],
            None,
        )
    };
    client.push(&mut local, "a", vec![node(0, None)]);
    client.push(
        &mut local,
        "b",
        (1..500).map(|i| node(i, Some(i - 1))).collect(),
    );
    client.push(&mut local, "c", vec![node(500, Some(499))]);
    client.push(&mut local, "d", vec![node(0, Some(500))]);
    let calls = Cell::new(0);
    {
        let mut transport = |_: &[u8]| -> Result<Vec<u8>, AuthorityError> {
            calls.set(calls.get() + 1);
            Err(AuthorityError::new("sync.transport_failed", "unreachable"))
        };
        let error = local.attach(&mut transport).unwrap_err();
        assert_eq!(error.code, "sync.attach_rejected");
        assert_eq!(
            error.details,
            Some(json!({ "reason": "cycle_too_large", "table": "nodes", "size": 501 }))
        );
    }
    assert_eq!(calls.get(), 0);
    assert_eq!(local.state(), AuthorityState::Attaching);
    local.abandon_attach(None).unwrap();
    assert_eq!(local.state(), AuthorityState::Local);
}

#[test]
fn a_retired_authority_reopens_attached_and_refuses_everything() {
    let path = temp_path();
    let mut remote = memory();
    {
        let mut local = LocalAuthority::open(&path, &schema_json(1)).unwrap();
        let s = local.schema.clone();
        let client = Session::new(&mut local, "c1");
        client.push(&mut local, "a", vec![task(&s, "t1", None, None)]);
        let mut transport = |bytes: &[u8]| remote.sync(bytes);
        local.attach(&mut transport).unwrap();
        local.attach(&mut transport).unwrap();
    }
    let mut local = LocalAuthority::open(&path, &schema_json(2)).unwrap();
    assert_eq!(local.state(), AuthorityState::Attached);
    let tables: Vec<String> = local
        .conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tables, vec![STATE_TABLE.to_owned()]);
    let error = local.sync(&[]).unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.details),
        (
            "sync.authority_unavailable",
            Some(json!({ "state": "attached" }))
        )
    );
    assert_eq!(
        local.abandon_attach(None).unwrap_err().code,
        "sync.authority_unavailable"
    );
    drop(local);
    let _ = std::fs::remove_file(&path);
}
