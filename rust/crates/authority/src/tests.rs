//! Crate tests: the §12.2 profile through `sync` bytes, and §12.3 attach and
//! abandon against a second `LocalAuthority` serving as the remote server.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use ssp2::decode::WIRE_VERSION;
use ssp2::model::{
    Change, Frame, LiveStatus, Message, MsgKind, Op, OpResult, Operation, PushStatus, SubStatus,
};
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

/// A unit on the one scope variable every test table declares (§4.1).
fn org(value: &str) -> Vec<(String, String)> {
    vec![("org".to_owned(), value.to_owned())]
}

/// `PULL_HEADER` with replica cursor `cursor`, the digest of `units` and the
/// last echo digest; `pages = 0` takes the default of 4 pages.
fn pull_header(
    cursor: i64,
    units: &[Vec<(String, String)>],
    echo: Option<[u8; 32]>,
    rows: i32,
    pages: i32,
) -> Frame {
    Frame::PullHeader {
        limit_commits: 0,
        limit_snapshot_rows: rows,
        max_snapshot_pages: pages,
        accept: 0b0011,
        cursor,
        registration_digest: ssp2::registration_digest(units.iter().map(Vec::as_slice)),
        echo_digest: echo,
    }
}

/// A pull of the empty traveling list.
fn empty_pull() -> Frame {
    pull_header(-1, &[], None, 0, 0)
}

fn unit_frames(units: &[Vec<(String, String)>]) -> Vec<Frame> {
    units
        .iter()
        .map(|scopes| Frame::Unit {
            scopes: scopes.clone(),
        })
        .collect()
}

fn progress(unit: &[(String, String)], cursor: i64, token: Option<String>) -> Frame {
    Frame::Progress {
        id: ssp2::unit_id(unit),
        cursor,
        bootstrap_state: token.map(RawJson),
    }
}

fn encode_request(
    client_id: &str,
    schema_version: i32,
    log_epoch: Option<String>,
    outbox_id: Option<&str>,
    mut frames: Vec<Frame>,
) -> Vec<u8> {
    frames.insert(
        0,
        Frame::ReqHeader {
            client_id: client_id.to_owned(),
            schema_version,
            log_epoch,
            outbox_id: outbox_id.map(str::to_owned),
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
                    None,
                    vec![empty_pull()],
                ))
                .expect("acquire"),
        );
        let Some(Frame::RespHeader {
            log_epoch: epoch,
            reset_required: true,
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
        self.outbox_round(authority, None, frames)
    }

    fn outbox_round(
        &self,
        authority: &mut LocalAuthority,
        outbox_id: Option<&str>,
        frames: Vec<Frame>,
    ) -> Vec<Frame> {
        let request = encode_request(
            &self.client_id,
            self.version,
            Some(self.epoch.clone()),
            outbox_id,
            frames,
        );
        decode(&authority.sync(&request).expect("round"))
    }

    /// Push one commit without an outbox; its status, results and §6.3.1
    /// details.
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
                client_seq: 0,
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

    /// Register `units` (the list travels) with every unit catching up from
    /// cursor `-1`, and pull every table of each unit in one section.
    fn register(
        &self,
        authority: &mut LocalAuthority,
        units: &[Vec<(String, String)>],
    ) -> Vec<Frame> {
        let mut frames = vec![pull_header(-1, units, None, 0, 50)];
        frames.extend(unit_frames(units));
        frames.extend(units.iter().map(|unit| progress(unit, -1, None)));
        self.round(authority, frames)
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

/// Every unit section: `SUB_START` id, status and bootstrap flag, and its
/// `SUB_END` cursor and token.
type Section = (String, SubStatus, bool, i64, Option<String>);

fn sections(frames: &[Frame]) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut start = None;
    for frame in frames {
        match frame {
            Frame::SubStart {
                id,
                status,
                bootstrap,
                fenced,
                ..
            } => {
                assert!(fenced.is_empty(), "every scope value is granted");
                start = Some((id.clone(), *status, *bootstrap));
            }
            Frame::SubEnd {
                next_cursor,
                bootstrap_state,
            } => {
                let (id, status, bootstrap) = start.take().expect("SUB_START before SUB_END");
                sections.push((
                    id,
                    status,
                    bootstrap,
                    *next_cursor,
                    bootstrap_state.as_ref().map(|raw| raw.0.clone()),
                ));
            }
            _ => {}
        }
    }
    sections
}

/// The live section: `LIVE_START` status, `LIVE_END.throughSeq` and echo
/// digest, and every `COMMIT` as its sequence and changes.
type Live = (
    LiveStatus,
    i64,
    Option<[u8; 32]>,
    Vec<(i64, Vec<String>, Vec<Change>)>,
);

fn live(frames: &[Frame]) -> Live {
    let status = frames
        .iter()
        .find_map(|frame| match frame {
            Frame::LiveStart { status, .. } => Some(*status),
            _ => None,
        })
        .expect("a LIVE_START");
    let commits = frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::Commit {
                commit_seq,
                tables,
                changes,
                ..
            } => Some((*commit_seq, tables.clone(), changes.clone())),
            _ => None,
        })
        .collect();
    let Some(Frame::LiveEnd {
        through_seq,
        echo_digest,
    }) = frames.last()
    else {
        panic!("LIVE_END closes the response: {frames:?}");
    };
    (status, *through_seq, *echo_digest, commits)
}

/// The changes of every live-section commit: table, row id, op and version.
fn changes(frames: &[Frame]) -> Vec<(i64, String, String, Op, i64)> {
    live(frames)
        .3
        .into_iter()
        .flat_map(|(seq, tables, changes)| {
            changes.into_iter().map(move |change| {
                (
                    seq,
                    tables[change.table_index as usize].clone(),
                    change.row_id,
                    change.op,
                    change.row_version,
                )
            })
        })
        .collect()
}

/// The row's tombstone: `Some` with its recorded version.
fn tombstone(authority: &LocalAuthority, table: &str, row_id: &str) -> Option<Option<i64>> {
    authority
        .conn
        .query_row(
            "SELECT server_version FROM sync_tombstones WHERE tbl=?1 AND row_id=?2",
            [table, row_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read")
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
        let mut scope = column("org", ty, false);
        scope["crdtType"] = json!("yjs-doc");
        let schema = json!({ "version": 1, "tables": [table(
            "tasks",
            vec![column("id", "string", false), scope],
            json!({}),
        )] });
        let opened = LocalAuthority::open(":memory:", &schema);
        if accepted {
            opened.unwrap_or_else(|error| panic!("{ty}: {}", error.message));
        } else {
            let error = opened
                .err()
                .unwrap_or_else(|| panic!("{ty} must be refused"));
            assert!(
                error.details.unwrap().to_string().contains("(§3.1)"),
                "{ty}"
            );
        }
    }
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

    // §4.1: the unit covers every table declaring `org`; it bootstraps at
    // pin 1 and joins the scan set of the same response.
    let o1 = org("o1");
    let frames = client.register(&mut authority, std::slice::from_ref(&o1));
    assert_eq!(
        sections(&frames),
        vec![(ssp2::unit_id(&o1), SubStatus::Active, true, 1, None)]
    );
    assert_eq!(
        segment_rows(&frames),
        vec![("p1".to_owned(), 1), ("t1".to_owned(), 1)]
    );
    let (status, through, echo, commits) = live(&frames);
    assert_eq!((status, through, commits.len()), (LiveStatus::Active, 1, 0));
    let echo = echo.expect("an echo digest");
    assert_eq!(
        echo,
        ssp2::echo_digest([ssp2::UnitEcho {
            id: &ssp2::unit_id(&o1),
            status: ssp2::model::EchoStatus::Active,
            fenced: &[],
        }])
    );

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
            client_seq: 0,
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

    // A live unit referred to by digest: no unit section, one COMMIT.
    let frames = client.round(
        &mut authority,
        vec![pull_header(1, std::slice::from_ref(&o1), Some(echo), 0, 0)],
    );
    assert_eq!(sections(&frames), vec![]);
    let Frame::Commit {
        commit_seq,
        changes,
        actor_id,
        tables,
        ..
    } = &frames[2]
    else {
        panic!("a live-section COMMIT: {frames:?}");
    };
    assert_eq!(
        (*commit_seq, actor_id.as_str(), tables.clone()),
        (2, "local", vec!["tasks".to_owned()])
    );
    assert_eq!(changes[0].row_version, 2);
    assert_eq!(changes[0].scopes, vec![("org".to_owned(), "o1".to_owned())]);
    assert_eq!(live(&frames).1, 2);

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
    // §2.2, §6.2: the delete wrote version 2 and the recreate starts above
    // the delete floor, so a baseVersion held from the previous incarnation
    // conflicts.
    assert_eq!(
        stored(&authority, "tasks", "t1").map(|(version, _)| version),
        Some(3)
    );
    assert_eq!(tombstone(&authority, "tasks", "t1"), None);
    let stale = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), None, Some("stale"), None],
        Some(1),
    );
    let (_, results, _) = client.push(&mut authority, "stale", vec![stale]);
    assert!(
        matches!(
            &results[0],
            OpResult::Conflict {
                server_version: 3,
                ..
            }
        ),
        "{results:?}"
    );
    // Deleting an absent row is applied with no change.
    assert_eq!(
        client
            .push(&mut authority, "e", vec![delete("tasks", "nope")])
            .0,
        PushStatus::Applied
    );
}

#[test]
fn an_unreadable_idempotency_record_answers_a_retryable_cache_miss_for_its_commit_only() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    authority
        .conn
        .execute(
            "UPDATE sync_push_results SET result='{' WHERE client_commit_id='a'",
            [],
        )
        .unwrap();
    let frames = client.round(
        &mut authority,
        vec![
            Frame::PushCommit {
                client_commit_id: "a".to_owned(),
                client_seq: 0,
                operations: vec![task(&s, "t1", None, None)],
            },
            Frame::PushCommit {
                client_commit_id: "b".to_owned(),
                client_seq: 0,
                operations: vec![task(&s, "t2", None, None)],
            },
            pull_header(-1, &[org("o1")], None, 0, 50),
            Frame::Unit { scopes: org("o1") },
            progress(&org("o1"), -1, None),
        ],
    );
    let results: Vec<_> = frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::PushResult {
                client_commit_id,
                status,
                commit_seq,
                results,
            } => Some((
                client_commit_id.as_str(),
                *status,
                commit_seq.is_some(),
                results.clone(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        results,
        vec![
            (
                "a",
                PushStatus::Rejected,
                false,
                vec![OpResult::Error {
                    op_index: 0,
                    code: "sync.idempotency_cache_miss".to_owned(),
                    message: "persisted push result unreadable (§6.3)".to_owned(),
                    retryable: true,
                }]
            ),
            (
                "b",
                PushStatus::Applied,
                true,
                vec![OpResult::Applied { op_index: 0 }]
            ),
        ]
    );
    assert_eq!(
        segment_rows(&frames),
        vec![("t1".to_owned(), 1), ("t2".to_owned(), 1)],
        "the pull proceeds"
    );
    assert_eq!(
        store::push_result(&authority.conn, "c1", "a").unwrap(),
        Some("{".to_owned()),
        "the cache miss is not persisted"
    );
    assert_eq!(store::log_state(&authority.conn).unwrap().max_seq, 2);
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
    // A live unit at R = 1 receives the delete, its cascade and its SET NULL
    // in one COMMIT; every delete advances the version (§2.2).
    let mut frames = vec![pull_header(1, &[org("o1")], None, 0, 0)];
    frames.extend(unit_frames(&[org("o1")]));
    let frames = client.round(&mut authority, frames);
    let row = |seq: i64, table: &str, row_id: &str, op, version| {
        (seq, table.to_owned(), row_id.to_owned(), op, version)
    };
    assert_eq!(
        changes(&frames),
        vec![
            row(2, "projects", "p1", Op::Delete, 2),
            row(2, "tasks", "t1", Op::Delete, 2),
            row(2, "notes", "n1", Op::Upsert, 2),
        ]
    );
    assert_eq!(tombstone(&authority, "tasks", "t1"), Some(Some(2)));
    assert_eq!(store::log_state(&authority.conn).unwrap().delete_floor, 2);
}

#[test]
fn a_tombstone_from_before_recorded_versions_recreates_above_the_floor() {
    let path = temp_path();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_tombstones(tbl TEXT NOT NULL, row_id TEXT NOT NULL,
               commit_seq INTEGER NOT NULL, PRIMARY KEY (tbl, row_id));
             INSERT INTO sync_tombstones VALUES ('tasks', 't1', 1);",
        )
        .unwrap();
    }
    let mut authority = LocalAuthority::open(&path, &schema_json(1)).expect("open");
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    assert_eq!(tombstone(&authority, "tasks", "t1"), Some(None));
    let (_, results, _) = client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    assert_eq!(error_code(&results), (0, "sync.row_deleted".to_owned()));
    let recreate = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), None, Some("again"), None],
        Some(0),
    );
    assert_eq!(
        client.push(&mut authority, "b", vec![recreate]).0,
        PushStatus::Applied
    );
    assert_eq!(
        stored(&authority, "tasks", "t1").map(|(version, _)| version),
        Some(1)
    );
    client.push(&mut authority, "c", vec![delete("tasks", "t1")]);
    assert_eq!(tombstone(&authority, "tasks", "t1"), Some(Some(2)));
    drop(authority);
    let _ = std::fs::remove_file(&path);
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
fn a_conflict_reports_the_row_as_stored_once_the_commit_rolls_back() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    let titled = |title: &str, base| {
        upsert(
            &s,
            "tasks",
            &[Some("t1"), Some("o1"), None, Some(title), None],
            base,
        )
    };
    let (status, results, _) = client.push(
        &mut authority,
        "b",
        vec![titled("candidate", None), titled("mine", Some(1))],
    );
    assert_eq!(status, PushStatus::Rejected);
    let OpResult::Conflict {
        op_index,
        server_version,
        server_row,
        ..
    } = &results[0]
    else {
        panic!("a conflict record: {results:?}");
    };
    let row = store::decode_payload(&s.table("tasks").unwrap().columns, server_row).unwrap();
    assert_eq!(
        (*op_index, *server_version, row[3].clone()),
        (1, 1, text("title"))
    );
    // A row only an earlier operation of the commit inserted is gone once the
    // commit rolls back: there is no row to report.
    let insert = || {
        upsert(
            &s,
            "tasks",
            &[Some("t9"), Some("o1"), None, Some("x"), None],
            Some(0),
        )
    };
    let (_, results, _) = client.push(&mut authority, "c", vec![insert(), insert()]);
    assert_eq!(error_code(&results), (1, "sync.row_missing".to_owned()));
    assert!(stored(&authority, "tasks", "t9").is_none());
}

#[test]
fn a_patch_that_leaves_the_reference_absent_is_not_checked_for_its_parent() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(
        &mut authority,
        "a",
        vec![
            task(&s, "t1", None, None),
            upsert(&s, "notes", &[Some("n1"), Some("o1"), Some("t1")], None),
        ],
    );
    let notes = s.table("notes").unwrap();
    let patch = Operation {
        table: "notes".to_owned(),
        row_id: "n1".to_owned(),
        op: Op::Upsert,
        base_version: None,
        payload: Some(encode_sparse_row(
            &notes.columns,
            notes.pk,
            &vec![
                SparseSlot::Value(ColumnValue::String("n1".to_owned())),
                SparseSlot::Value(ColumnValue::String("o1".to_owned())),
                SparseSlot::Absent,
            ],
        )),
    };
    // The merged row names the parent the same commit deletes until SET NULL
    // clears the column.
    let (status, results, _) = client.push(&mut authority, "b", vec![patch, delete("tasks", "t1")]);
    assert_eq!(status, PushStatus::Applied, "{results:?}");
    let (version, values) = stored(&authority, "notes", "n1").expect("the child stays");
    assert_eq!((version, values[2].clone()), (3, None));
}

#[test]
fn an_unauthorized_payload_is_denied_before_the_tombstone_read() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    client.push(&mut authority, "b", vec![delete("tasks", "t1")]);
    // An empty scope value is a missing one (§3.4 step 2).
    let unscoped = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some(""), None, Some("x"), None],
        None,
    );
    let (_, results, _) = client.push(&mut authority, "c", vec![unscoped]);
    assert!(
        matches!(&results[0], OpResult::Error { code, message, .. }
            if code == "sync.forbidden" && message == "insert missing scope column value (§3.4)"),
        "{results:?}"
    );
}

#[test]
fn a_row_id_holding_nul_is_an_invalid_request() {
    let mut authority = memory();
    let client = Session::new(&mut authority, "c1");
    let (status, results, _) = client.push(&mut authority, "a", vec![delete("tasks", "a\0b")]);
    assert_eq!(status, PushStatus::Rejected);
    assert_eq!(error_code(&results), (0, "sync.invalid_request".to_owned()));
}

#[test]
fn the_child_probe_reads_one_page_at_a_time() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let mut operations = vec![task(&s, "t1", None, None)];
    operations.extend((1..=3).map(|i| {
        upsert(
            &s,
            "pins",
            &[Some(&format!("x{i}")), Some("o1"), Some("t1")],
            None,
        )
    }));
    assert_eq!(
        client.push(&mut authority, "a", operations).0,
        PushStatus::Applied
    );
    let pins = s.table("pins").unwrap();
    let page = |after: Option<&str>, limit| {
        store::children(&authority.conn, pins, 2, "t1", after, limit)
            .unwrap()
            .into_iter()
            .map(|row| row.row_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(page(None, 1), ["x1"]);
    assert_eq!(page(Some("x1"), 5), ["x2", "x3"]);
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
    let o1 = org("o1");
    let units = std::slice::from_ref(&o1);
    let tables = r#"["projects","tasks","notes","pins","nodes","docs"]"#;
    // §4.7: every covered table delivers at least one segment, an empty one
    // for a table without rows, and each segment counts as one page.
    let mut frames = vec![pull_header(-1, units, None, 2, 3)];
    frames.extend(unit_frames(units));
    frames.push(progress(&o1, -1, None));
    let mut echo = None;
    for (expected, next) in [
        (
            vec!["t1", "t2", "t3", "t4"],
            Some(format!(
                r#"{{"asOfCommitSeq":1,"tables":{tables},"tableIndex":1,"rowCursor":"t4"}}"#
            )),
        ),
        (
            vec!["t5"],
            Some(format!(
                r#"{{"asOfCommitSeq":1,"tables":{tables},"tableIndex":4,"rowCursor":null}}"#
            )),
        ),
        (vec![], None),
    ] {
        let response = client.round(&mut authority, frames);
        let rows: Vec<String> = segment_rows(&response)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(rows, expected);
        let [(_, SubStatus::Active, true, 1, token)] = &sections(&response)[..] else {
            panic!("one bootstrap section at pin 1: {response:?}");
        };
        assert_eq!(token, &next);
        echo = live(&response).2;
        // Later rounds refer to the stored list by its digest (§4.1).
        frames = vec![
            pull_header(-1, units, echo, 2, 3),
            progress(&o1, 1, token.clone()),
        ];
    }
    // The completed bootstrap joined: the unit is live at R = 1.
    let quiet = client.round(&mut authority, vec![pull_header(1, units, echo, 0, 0)]);
    assert_eq!(sections(&quiet), vec![]);
    assert_eq!(live(&quiet).1, 1);
    // §4.7: a token naming other tables restarts the bootstrap at a fresh pin.
    let restarted = client.round(
        &mut authority,
        vec![
            pull_header(-1, units, echo, 2, 3),
            progress(
                &o1,
                1,
                Some(
                    r#"{"asOfCommitSeq":1,"tables":["tasks"],"tableIndex":0,"rowCursor":"t4"}"#
                        .to_owned(),
                ),
            ),
        ],
    );
    assert_eq!(
        segment_rows(&restarted)
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>(),
        vec!["t1", "t2", "t3", "t4"]
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
        &Retention {
            min_retained_commits: 1,
            ..Retention::default()
        },
    )
    .unwrap();
    assert_eq!(horizon, 3);
    assert_eq!(
        tombstone(&authority, "tasks", "t1"),
        Some(Some(2)),
        "seq 4 survives"
    );
    let o1 = org("o1");
    let units = std::slice::from_ref(&o1);
    let pull = |cursor: i64, unit_cursor: Option<i64>| {
        let mut frames = vec![pull_header(cursor, units, None, 0, 0)];
        frames.extend(unit_frames(units));
        frames.extend(unit_cursor.map(|unit_cursor| progress(&o1, unit_cursor, None)));
        frames
    };
    // §4.6 unit reset: a post-bootstrap cursor below the horizon.
    let frames = client.round(&mut authority, pull(-1, Some(1)));
    assert_eq!(
        sections(&frames),
        vec![(ssp2::unit_id(&o1), SubStatus::Reset, false, 1, None)]
    );
    assert!(matches!(
        frames.iter().find(|frame| matches!(frame, Frame::SubStart { .. })),
        Some(Frame::SubStart { reason_code, .. }) if reason_code == "sync.cursor_expired"
    ));
    assert_eq!(live(&frames).1, 4);
    // §4.6 replica reset: a live unit with R below the horizon, or above
    // maxCommitSeq.
    for cursor in [1, 5] {
        let frames = client.round(&mut authority, pull(cursor, None));
        let (status, through, _, commits) = live(&frames);
        assert_eq!((status, through, commits.len()), (LiveStatus::Reset, -1, 0));
        assert!(matches!(
            frames.iter().find(|frame| matches!(frame, Frame::LiveStart { .. })),
            Some(Frame::LiveStart { reason_code, .. }) if reason_code == "sync.cursor_expired"
        ));
    }
    // At the horizon the log still answers: the delete carries the version
    // its tombstone records.
    let frames = client.round(&mut authority, pull(3, None));
    assert_eq!(
        changes(&frames),
        vec![(4, "tasks".to_owned(), "t1".to_owned(), Op::Delete, 2)]
    );
}

/// An authority whose clock the test moves.
fn clocked() -> (LocalAuthority, Arc<AtomicI64>) {
    let now = Arc::new(AtomicI64::new(1_000));
    let clock = now.clone();
    let authority = LocalAuthority::open_with_clock(
        ":memory:",
        &schema_json(1),
        Box::new(move || clock.load(Ordering::SeqCst)),
    )
    .expect("open");
    (authority, now)
}

/// The §4.5 record: cursor, retention timestamp, last round time, code, streak.
fn client_record(
    authority: &LocalAuthority,
    client_id: &str,
) -> Option<(i64, i64, i64, Option<String>, i64)> {
    authority
        .conn
        .query_row(
            "SELECT cursor, updated_at_ms, last_round_at_ms, last_error_code, consecutive_failures FROM sync_clients WHERE client_id=?1",
            [client_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .expect("read")
}

#[test]
fn the_client_record_carries_the_last_round_outcome() {
    let (mut authority, now) = clocked();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let report = |code: &str| Frame::RoundFailure {
        code: code.to_owned(),
    };
    // A report on a schema-floor round has no record to land on.
    let floor = encode_request(
        "c1",
        client.version + 1,
        Some(client.epoch.clone()),
        None,
        vec![report("sync.transport_failed"), empty_pull()],
    );
    authority.sync(&floor).expect("floor round");
    assert_eq!(client_record(&authority, "c1"), None);

    client.push(&mut authority, "c1", vec![task(&s, "t1", None, None)]);
    let o1 = org("o1");
    let units = std::slice::from_ref(&o1);
    let echo = live(&client.register(&mut authority, units)).2;
    assert_eq!(
        client_record(&authority, "c1"),
        Some((1, 1_000, 1_000, None, 0))
    );

    // The report lands before the round, whose completion keeps it.
    now.store(2_000, Ordering::SeqCst);
    client.round(
        &mut authority,
        vec![report("sync.timeout"), pull_header(1, units, echo, 0, 0)],
    );
    assert_eq!(
        client_record(&authority, "c1"),
        Some((1, 2_000, 2_000, Some("sync.timeout".to_owned()), 1))
    );

    // A refused round extends the streak and leaves the cursor and the
    // retention timestamp alone.
    now.store(3_000, Ordering::SeqCst);
    let twice = [o1.clone(), o1.clone()];
    let mut frames = vec![pull_header(1, &twice, echo, 0, 0)];
    frames.extend(unit_frames(&twice));
    let duplicate = encode_request(
        "c1",
        client.version,
        Some(client.epoch.clone()),
        None,
        frames,
    );
    assert_eq!(
        authority.sync(&duplicate).unwrap_err().code,
        "sync.invalid_subscription"
    );
    assert_eq!(
        client_record(&authority, "c1"),
        Some((
            1,
            2_000,
            3_000,
            Some("sync.invalid_subscription".to_owned()),
            2
        ))
    );
    // A refused round never creates a record.
    let stranger = encode_request(
        "c2",
        client.version,
        Some(client.epoch.clone()),
        None,
        vec![],
    );
    assert!(authority.sync(&stranger).is_err());
    assert_eq!(client_record(&authority, "c2"), None);

    // The next round without a report clears the outcome.
    now.store(4_000, Ordering::SeqCst);
    client.round(&mut authority, vec![pull_header(1, units, echo, 0, 0)]);
    assert_eq!(
        client_record(&authority, "c1"),
        Some((1, 4_000, 4_000, None, 0))
    );

    // §4.1: a digest the record does not hold answers `unregistered`, and
    // the round writes only its outcome (§4.5).
    now.store(5_000, Ordering::SeqCst);
    let frames = client.round(
        &mut authority,
        vec![
            report("sync.timeout"),
            pull_header(1, &[org("o2")], echo, 0, 0),
            progress(&o1, -1, None),
        ],
    );
    assert_eq!(
        frames[1..],
        [
            Frame::LiveStart {
                status: LiveStatus::Unregistered,
                reason_code: String::new(),
            },
            Frame::LiveEnd {
                through_seq: -1,
                echo_digest: None,
            },
        ]
    );
    assert_eq!(
        client_record(&authority, "c1"),
        Some((1, 4_000, 5_000, Some("sync.timeout".to_owned()), 1))
    );
    // A client with no record is `unregistered` too, and gains none.
    let stranger = Session::new(&mut authority, "c3");
    let frames = stranger.round(&mut authority, vec![pull_header(-1, units, None, 0, 0)]);
    assert_eq!(live(&frames).0, LiveStatus::Unregistered);
    assert_eq!(client_record(&authority, "c3"), None);
}

#[test]
fn the_clock_stamps_commits_and_prune_takes_the_host_floors() {
    let (mut authority, now) = clocked();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    // The record cursor joins at 1 (§4.5).
    client.register(&mut authority, &[org("o1")]);
    client.push(&mut authority, "b", vec![task(&s, "t2", None, None)]);
    let stamps: Vec<i64> = authority
        .conn
        .prepare("SELECT created_at_ms FROM sync_commits ORDER BY commit_seq")
        .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
        .expect("read");
    assert_eq!(stamps, vec![1_000, 1_000]);

    // The default floors keep the newest 1000 commits.
    assert_eq!(authority.prune(&Retention::default()).unwrap(), 0);
    now.store(2_000, Ordering::SeqCst);
    let floors = |active_window_ms| Retention {
        active_window_ms,
        min_retained_commits: 0,
        ..Retention::default()
    };
    // The record cursor holds the horizon while the record is inside the
    // active window on the authority's clock...
    assert_eq!(authority.prune(&floors(5_000)).unwrap(), 1);
    // ...and stops holding it once the window no longer reaches it.
    assert_eq!(authority.prune(&floors(500)).unwrap(), 2);
    assert_eq!(store::log_state(&authority.conn).unwrap().horizon, 2);
    // §4.6: a record cursor of -1 holds nothing.
    let (mut authority, now) = clocked();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![task(&s, "t1", None, None)]);
    now.store(2_000, Ordering::SeqCst);
    assert_eq!(
        client_record(&authority, "c1").map(|record| record.0),
        Some(-1)
    );
    assert_eq!(authority.prune(&floors(5_000)).unwrap(), 1);
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
    let frames = client.register(&mut authority, &[org("o1")]);
    let segment = frames
        .iter()
        .find_map(|frame| match frame {
            Frame::SegmentInline { payload } => Some(decode_rows_segment(payload).unwrap())
                .filter(|segment| segment.table == "tasks"),
            _ => None,
        })
        .unwrap();
    assert_eq!((segment.schema_version, segment.columns.len()), (2, 6));
    assert_eq!(segment.blocks[0][0].values[5], None);
    // The logged change was re-encoded to the new layout too.
    let frames = client.round(&mut authority, {
        let mut frames = vec![pull_header(0, &[org("o1")], None, 0, 0)];
        frames.extend(unit_frames(&[org("o1")]));
        frames
    });
    let changes = &live(&frames).3[0].2;
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

/// `schema_json(1)` at `version` with `nodes` scoped `team:{team}` over
/// `column` (`nodes` references only itself, so its pattern may change alone).
fn rescoped(version: i32, column: &str) -> Value {
    let mut schema = schema_json(1);
    schema["version"] = json!(version);
    for table in schema["tables"].as_array_mut().unwrap() {
        if table["name"] == "nodes" {
            table["scopes"] = json!([{ "pattern": "team:{team}", "column": column }]);
        }
    }
    schema
}

fn node(schema: &schema::Schema, id: &str, parent: Option<&str>) -> Operation {
    upsert(schema, "nodes", &[Some(id), Some("o1"), parent], None)
}

#[test]
fn a_bump_that_changes_a_scope_pattern_rekeys_the_table() {
    let path = temp_path();
    {
        let mut authority = LocalAuthority::open(&path, &schema_json(1)).unwrap();
        let s = authority.schema.clone();
        let client = Session::new(&mut authority, "c1");
        for id in ["n1", "n2", "n3"] {
            client.push(&mut authority, id, vec![node(&s, id, None)]);
        }
        client.push(&mut authority, "d", vec![delete("nodes", "n3")]);
    }
    // §3.1: at the same version a changed pattern is refused.
    let error = LocalAuthority::open(&path, &rescoped(1, "id"))
        .err()
        .unwrap();
    assert_eq!(
        (
            error.code.as_str(),
            error.details.unwrap()["reason"].clone()
        ),
        (
            "sync.schema_mismatch",
            json!("layout_changed_without_version_bump")
        )
    );
    let mut authority = LocalAuthority::open(&path, &rescoped(2, "id")).unwrap();
    let scopes = |authority: &LocalAuthority, row_id: &str| -> String {
        authority
            .conn
            .query_row(
                "SELECT _sync_scopes FROM nodes WHERE _sync_row_id=?1",
                [row_id],
                |row| row.get(0),
            )
            .unwrap()
    };
    let horizon = |authority: &LocalAuthority| -> (i64, i64) {
        authority
            .conn
            .query_row(
                "SELECT horizon_seq, max_commit_seq FROM sync_log WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    assert_eq!(scopes(&authority, "n1"), r#"{"team":"n1"}"#);
    assert_eq!(scopes(&authority, "n2"), r#"{"team":"n2"}"#);
    assert_eq!(tombstone(&authority, "nodes", "n3"), None);
    assert_eq!(horizon(&authority), (4, 4));
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c2");
    let team = vec![("team".to_owned(), "n1".to_owned())];
    let units = std::slice::from_ref(&team);
    let frames = client.register(&mut authority, units);
    let rows: Vec<Option<ColumnValue>> = frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::SegmentInline { payload } => Some(decode_rows_segment(payload).unwrap()),
            _ => None,
        })
        .filter(|segment| segment.table == "nodes")
        .flat_map(|segment| segment.blocks.into_iter().flatten())
        .map(|row| row.values[0].clone())
        .collect();
    assert_eq!(rows, vec![text("n1")]);
    // §4.6: a cursor into the history logged under `org` gets the reset.
    let mut pull = vec![pull_header(2, units, None, 0, 0)];
    pull.extend(unit_frames(units));
    let (status, through, _, commits) = live(&client.round(&mut authority, pull));
    assert_eq!((status, through, commits.len()), (LiveStatus::Reset, -1, 0));
    // The tombstone left with the re-key: an unversioned upsert inserts again.
    let (status, results, _) = client.push(&mut authority, "again", vec![node(&s, "n3", None)]);
    assert_eq!(status, PushStatus::Applied, "{results:?}");
    client.push(&mut authority, "d2", vec![delete("nodes", "n2")]);
    drop(authority);
    // A bump with unchanged patterns re-keys nothing.
    let authority = LocalAuthority::open(&path, &rescoped(3, "id")).unwrap();
    assert_eq!(horizon(&authority), (4, 6));
    assert!(tombstone(&authority, "nodes", "n2").is_some());
    drop(authority);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_rekey_refuses_a_row_without_a_value_for_the_new_pattern() {
    let path = temp_path();
    {
        let mut authority = LocalAuthority::open(&path, &schema_json(1)).unwrap();
        let s = authority.schema.clone();
        let client = Session::new(&mut authority, "c1");
        client.push(&mut authority, "a", vec![node(&s, "n1", None)]);
        client.push(&mut authority, "b", vec![node(&s, "n2", Some("n1"))]);
    }
    let error = LocalAuthority::open(&path, &rescoped(2, "parent_id"))
        .err()
        .unwrap();
    assert_eq!(error.code, "sync.schema_mismatch");
    assert_eq!(
        error.details.unwrap(),
        json!({ "table": "nodes", "reason": "scope_value_missing", "variable": "team", "rowId": "n1" })
    );
    // The refused bump changed nothing: version 1 still opens.
    LocalAuthority::open(&path, &schema_json(1)).unwrap();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn request_validation_fails_before_any_byte() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let epochless = encode_request(
        "c1",
        1,
        None,
        None,
        vec![Frame::PushCommit {
            client_commit_id: "a".to_owned(),
            client_seq: 0,
            operations: vec![delete("tasks", "t1")],
        }],
    );
    assert_eq!(
        authority.sync(&epochless).unwrap_err().code,
        "sync.invalid_request"
    );
    let refused = |authority: &mut LocalAuthority, outbox_id: Option<&str>, frames: Vec<Frame>| {
        let request = encode_request("c1", 1, Some(client.epoch.clone()), outbox_id, frames);
        authority.sync(&request).unwrap_err()
    };
    // §4.1 unit validation, with the reason in the details.
    let unit = |scopes: Vec<(String, String)>| {
        vec![
            pull_header(-1, std::slice::from_ref(&scopes), None, 0, 0),
            Frame::Unit { scopes },
        ]
    };
    for (scopes, reason) in [
        (vec![], "empty_scope_map"),
        (org("*"), "wildcard_value"),
        (
            vec![("missing".to_owned(), "x".to_owned())],
            "undeclared_variable",
        ),
    ] {
        let error = refused(&mut authority, None, unit(scopes));
        assert_eq!(
            (error.code.as_str(), &error.details.unwrap()["reason"]),
            ("sync.invalid_subscription", &json!(reason))
        );
    }
    // A digest that differs from the traveling list.
    let mut frames = vec![pull_header(-1, &[org("o2")], None, 0, 0)];
    frames.extend(unit_frames(&[org("o1")]));
    let error = refused(&mut authority, None, frames);
    assert_eq!(
        (error.code.as_str(), error.details),
        (
            "sync.invalid_subscription",
            Some(json!({ "reason": "registration_digest" }))
        )
    );
    // A PROGRESS id outside the list, or twice.
    for (progressed, reason) in [
        (vec![progress(&org("o2"), -1, None)], "unknown_unit"),
        (
            vec![
                progress(&org("o1"), -1, None),
                progress(&org("o1"), -1, None),
            ],
            "duplicate_progress",
        ),
    ] {
        let mut frames = unit(org("o1"));
        frames.extend(progressed);
        let error = refused(&mut authority, None, frames);
        assert_eq!(error.details.unwrap()["reason"], json!(reason));
    }
    // §6.1 sequence rules: with an outbox every clientSeq is ≥ 1 and strictly
    // increasing; without one every clientSeq is 0. Nothing applies.
    for (outbox_id, seqs) in [
        (Some("outbox-1"), vec![0]),
        (Some("outbox-1"), vec![2, 2]),
        (Some("outbox-1"), vec![3, 1]),
        (None, vec![1]),
    ] {
        let frames = seqs
            .iter()
            .enumerate()
            .map(|(index, seq)| Frame::PushCommit {
                client_commit_id: format!("c{index}"),
                client_seq: *seq,
                operations: vec![task(&s, &format!("t{index}"), None, None)],
            })
            .collect();
        let error = refused(&mut authority, outbox_id, frames);
        assert_eq!(
            (error.code.as_str(), error.details),
            (
                "sync.invalid_request",
                Some(json!({ "outbox": outbox_id.is_some(), "clientSeqs": seqs }))
            )
        );
    }
    assert!(stored(&authority, "tasks", "t0").is_none());
    // §1.7: more UNIT frames than the reference cap.
    let many: Vec<_> = (0..501).map(|i| org(&format!("o{i}"))).collect();
    let mut frames = vec![pull_header(-1, &many, None, 0, 0)];
    frames.extend(unit_frames(&many));
    assert_eq!(
        refused(&mut authority, None, frames).details,
        Some(json!({ "limit": "maxSubscriptionsPerRequest", "max": 500, "actual": 501 }))
    );
    // A raised cap admits them and reports the configured max beyond it.
    authority.set_max_subscriptions_per_request(501);
    let mut frames = vec![pull_header(-1, &many, None, 0, 0)];
    frames.extend(unit_frames(&many));
    assert!(matches!(
        client.round(&mut authority, frames).first(),
        Some(Frame::RespHeader {
            reset_required: false,
            ..
        })
    ));
    let more: Vec<_> = (0..502).map(|i| org(&format!("o{i}"))).collect();
    let mut frames = vec![pull_header(-1, &more, None, 0, 0)];
    frames.extend(unit_frames(&more));
    assert_eq!(
        refused(&mut authority, None, frames).details,
        Some(json!({ "limit": "maxSubscriptionsPerRequest", "max": 501, "actual": 502 }))
    );
    let stale = encode_request("c1", 1, Some("other".to_owned()), None, vec![empty_pull()]);
    let frames = decode(&authority.sync(&stale).unwrap());
    assert!(matches!(
        &frames[..],
        [Frame::RespHeader {
            reset_required: true,
            ..
        }]
    ));
}

#[test]
fn a_bootstrap_scan_seeks_one_scope_value_of_any_column_type() {
    let schema = json!({ "version": 1, "tables": [{
        "name": "codes",
        "primaryKey": "id",
        "columns": [
            column("id", "string", false),
            column("rank", "integer", false),
            column("tier", "string", false),
        ],
        "scopes": [{ "pattern": "rank:{rank}" }, { "pattern": "tier:{tier}" }],
    }]});
    let mut authority = LocalAuthority::open(":memory:", &schema).unwrap();
    let client = Session::new(&mut authority, "c1");
    let compiled = authority.schema.table("codes").unwrap().clone();
    let operations = (0..300)
        .map(|i| Operation {
            table: "codes".to_owned(),
            row_id: format!("r{i:03}"),
            op: Op::Upsert,
            base_version: None,
            payload: Some(encode_sparse_row(
                &compiled.columns,
                compiled.pk,
                &vec![
                    SparseSlot::Value(ColumnValue::String(format!("r{i:03}"))),
                    SparseSlot::Value(ColumnValue::Integer(i % 3)),
                    SparseSlot::Value(ColumnValue::String(format!("t{}", i % 2))),
                ],
            )),
        })
        .collect();
    client.push(&mut authority, "a", operations);
    let scan = |unit: &[(&str, &str)], after: Option<&str>, limit: usize| -> Vec<String> {
        let unit: Vec<_> = unit
            .iter()
            .map(|(variable, value)| ((*variable).to_owned(), (*value).to_owned()))
            .collect();
        store::scan_rows(&authority.conn, &compiled, &unit, after, limit)
            .unwrap()
            .into_iter()
            .map(|row| row.row_id)
            .collect()
    };
    let expected = |keep: fn(i64) -> bool| -> Vec<String> {
        (0..300)
            .filter(|i| keep(*i))
            .map(|i| format!("r{i:03}"))
            .collect()
    };
    assert_eq!(scan(&[("rank", "1")], None, 1000), expected(|i| i % 3 == 1));
    assert_eq!(
        scan(&[("rank", "2"), ("tier", "t0")], None, 1000),
        expected(|i| i % 3 == 2 && i % 2 == 0)
    );
    // A value the column type parses but its rendering differs from, or one
    // it cannot hold, matches nothing.
    for unit in [[("rank", "01")], [("rank", "x")], [("tier", "0")]] {
        assert!(scan(&unit, None, 1000).is_empty());
    }
    // §4.7 paging keeps `_sync_row_id` order.
    let first = scan(&[("rank", "1")], None, 10);
    let next = scan(&[("rank", "1")], first.last().map(String::as_str), 10);
    assert_eq!([first, next].concat(), expected(|i| i % 3 == 1)[..20]);
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
                    ..
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
    assert!(undo[0].0.ends_with(":undo:0:0"));
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
    assert_eq!(tombstone(&remote, "tasks", "t0000"), Some(Some(2)));
    assert_eq!(local.state(), AuthorityState::Local);
    assert_eq!(count(&local, "tasks"), 501);
}

/// A transport to `remote` that records every pushed `clientCommitId` and
/// drops the response of push request `lose` (0-based) after the remote
/// processed it.
fn remote_transport<'a>(
    remote: &'a mut LocalAuthority,
    pushed: &'a RefCell<Vec<String>>,
    lose: Option<usize>,
) -> impl FnMut(&[u8]) -> Result<Vec<u8>, AuthorityError> + 'a {
    let mut pushes = 0;
    move |bytes: &[u8]| {
        let commit =
            decode_message(bytes)
                .unwrap()
                .frames
                .into_iter()
                .find_map(|frame| match frame {
                    Frame::PushCommit {
                        client_commit_id, ..
                    } => Some(client_commit_id),
                    _ => None,
                });
        let response = remote.sync(bytes)?;
        if let Some(id) = commit {
            pushed.borrow_mut().push(id);
            pushes += 1;
            if Some(pushes - 1) == lose {
                return Err(AuthorityError::new(
                    "sync.transport_failed",
                    "the response was lost",
                ));
            }
        }
        Ok(response)
    }
}

#[test]
fn a_lost_undo_response_blocks_attach_until_a_retried_abandon_completes() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    client.push(&mut local, "a", vec![task(&s, "t1", None, None)]);
    let mut remote = memory();
    let pushed = RefCell::new(Vec::new());
    let lost = local
        .attach(&mut remote_transport(&mut remote, &pushed, Some(0)))
        .unwrap_err();
    assert_eq!(lost.code, "sync.transport_failed");
    let first = local.attach_id().unwrap();
    // Push 0 settles upload commit 0 (`cached`); push 1 is the undo commit
    // whose response is lost after the remote applied it.
    let lost = local
        .abandon_attach(Some(&mut remote_transport(&mut remote, &pushed, Some(1))))
        .unwrap_err();
    assert_eq!(lost.code, "sync.transport_failed");
    assert_eq!(local.state(), AuthorityState::Attaching);
    assert_eq!(count(&remote, "tasks"), 0, "the undo applied remotely");

    let refused = local
        .attach(&mut remote_transport(&mut remote, &pushed, None))
        .unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.details),
        (
            "sync.attach_rejected",
            Some(json!({ "reason": "undo_pending" }))
        ),
        "a resumed upload would replay `cached` for deleted rows"
    );
    assert_eq!(pushed.borrow().len(), 3, "the refusal sends nothing");

    local
        .abandon_attach(Some(&mut remote_transport(&mut remote, &pushed, None)))
        .unwrap();
    assert_eq!(local.state(), AuthorityState::Local);
    assert!(local.read_meta("undo").unwrap().is_none());
    local
        .attach(&mut remote_transport(&mut remote, &pushed, None))
        .unwrap();
    let second = local.attach_id().unwrap();
    assert_ne!(first, second, "a completed abandon retires the attach id");
    assert_eq!(
        pushed.into_inner(),
        vec![
            format!("{first}:0"),
            format!("{first}:0"),
            format!("{first}:undo:0:0"),
            format!("{first}:undo:1:0"),
            format!("{second}:0"),
        ]
    );
    assert_eq!(local.state(), AuthorityState::Attached);
    assert_eq!(
        stored(&remote, "tasks", "t1").map(|(version, _)| version),
        Some(3),
        "the undo delete wrote version 2; the fresh attach recreates above the delete floor"
    );
}

#[test]
fn a_rejected_undo_applies_on_a_retried_abandon_once_the_blocker_is_gone() {
    let mut local = memory();
    let s = local.schema.clone();
    let client = Session::new(&mut local, "c1");
    client.push(&mut local, "a", vec![task(&s, "t1", None, None)]);
    let mut remote = memory();
    let other = Session::new(&mut remote, "other");
    let pushed = RefCell::new(Vec::new());
    local
        .attach(&mut remote_transport(&mut remote, &pushed, Some(0)))
        .unwrap_err();
    let attach_id = local.attach_id().unwrap();
    let pin = upsert(&s, "pins", &[Some("x1"), Some("o1"), Some("t1")], None);
    assert_eq!(
        other.push(&mut remote, "pin", vec![pin]).0,
        PushStatus::Applied
    );

    let rejected = local
        .abandon_attach(Some(&mut remote_transport(&mut remote, &pushed, None)))
        .unwrap_err();
    assert_eq!(
        (rejected.code.as_str(), rejected.details),
        (
            "sync.attach_rejected",
            Some(json!({
                "reason": "commit_rejected",
                "clientCommitId": format!("{attach_id}:undo:0:0"),
                "opIndex": 0,
                "code": "sync.reference_violation",
            }))
        )
    );
    assert_eq!(
        local
            .attach(&mut remote_transport(&mut remote, &pushed, None))
            .unwrap_err()
            .details,
        Some(json!({ "reason": "undo_pending" }))
    );

    assert_eq!(
        other
            .push(&mut remote, "unpin", vec![delete("pins", "x1")])
            .0,
        PushStatus::Applied
    );
    local
        .abandon_attach(Some(&mut remote_transport(&mut remote, &pushed, None)))
        .unwrap();
    assert_eq!(
        pushed.borrow().last(),
        Some(&format!("{attach_id}:undo:1:0")),
        "the retry never replays the stored rejection"
    );
    assert_eq!(local.state(), AuthorityState::Local);
    assert_eq!(count(&remote, "tasks"), 0);
    assert_eq!(count(&local, "tasks"), 1);
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

fn org_task(s: &schema::Schema, id: &str, org: &str) -> Operation {
    upsert(
        s,
        "tasks",
        &[Some(id), Some(org), None, Some("title"), None],
        None,
    )
}

/// The stored client record's catching-up units and registration list.
fn registration(authority: &LocalAuthority, client_id: &str) -> (Value, Option<Value>) {
    let (catching_up, units): (String, Option<String>) = authority
        .conn
        .query_row(
            "SELECT catching_up, units FROM sync_clients WHERE client_id=?1",
            [client_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read");
    (
        serde_json::from_str(&catching_up).unwrap(),
        units.map(|units| serde_json::from_str(&units).unwrap()),
    )
}

#[test]
fn a_pull_carries_a_bootstrapping_unit_and_a_live_unit() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "a", vec![org_task(&s, "t1", "o1")]);
    let (o1, o2) = (org("o1"), org("o2"));
    let echo = live(&client.register(&mut authority, std::slice::from_ref(&o1))).2;
    client.push(&mut authority, "b", vec![org_task(&s, "t2", "o1")]);
    client.push(&mut authority, "c", vec![org_task(&s, "t3", "o2")]);

    // o1 is live at R = 1; o2 joins the list and bootstraps at pin 3.
    let both = [o1.clone(), o2.clone()];
    let mut frames = vec![pull_header(1, &both, echo, 0, 50)];
    frames.extend(unit_frames(&both));
    frames.push(progress(&o2, -1, None));
    let frames = client.round(&mut authority, frames);
    assert_eq!(
        sections(&frames),
        vec![
            (ssp2::unit_id(&o1), SubStatus::Active, false, 1, None),
            (ssp2::unit_id(&o2), SubStatus::Active, true, 3, None),
        ]
    );
    assert_eq!(segment_rows(&frames), vec![("t3".to_owned(), 1)]);
    // The live unit scans from R; the completed bootstrap from its pin.
    assert_eq!(
        changes(&frames),
        vec![(2, "tasks".to_owned(), "t2".to_owned(), Op::Upsert, 1)]
    );
    let (status, through, echo, _) = live(&frames);
    assert_eq!((status, through), (LiveStatus::Active, 3));
    // Join rule J: both units are live at R* = 3, and the record holds the
    // traveled list.
    assert_eq!(
        client_record(&authority, "c1").map(|record| record.0),
        Some(3)
    );
    assert_eq!(
        registration(&authority, "c1"),
        (json!([]), Some(json!([{ "org": "o1" }, { "org": "o2" }])))
    );

    // §4.5: a cut section stops after the commit that reaches the budget;
    // a post-bootstrap unit whose scan the cut stops below R stays catching
    // up and joins in a later round.
    for (id, org) in [("d", "o1"), ("e", "o1"), ("f", "o2"), ("g", "o2")] {
        client.push(
            &mut authority,
            id,
            vec![org_task(&s, &format!("t-{id}"), org)],
        );
    }
    let cut = |cursor, unit_cursor| {
        let mut frames = vec![Frame::PullHeader {
            limit_commits: 1,
            limit_snapshot_rows: 0,
            max_snapshot_pages: 0,
            accept: 0b0011,
            cursor,
            registration_digest: ssp2::registration_digest(both.iter().map(Vec::as_slice)),
            echo_digest: echo,
        }];
        frames.push(progress(&o2, unit_cursor, None));
        frames
    };
    let frames = client.round(&mut authority, cut(7, 5));
    assert_eq!(sections(&frames), vec![]);
    assert_eq!(
        changes(&frames),
        vec![(6, "tasks".to_owned(), "t-f".to_owned(), Op::Upsert, 1)]
    );
    assert_eq!(live(&frames).1, 6);
    assert_eq!(
        client_record(&authority, "c1").map(|record| record.0),
        Some(6)
    );
    assert_eq!(
        registration(&authority, "c1").0,
        json!([{ "id": ssp2::unit_id(&o2), "cursor": 6 }])
    );
    let frames = client.round(&mut authority, cut(7, 6));
    assert_eq!(
        changes(&frames),
        vec![(7, "tasks".to_owned(), "t-g".to_owned(), Op::Upsert, 1)]
    );
    assert_eq!(
        client_record(&authority, "c1").map(|record| record.0),
        Some(7)
    );
    assert_eq!(registration(&authority, "c1").0, json!([]));
}

#[test]
fn an_insert_starts_above_a_delete_earlier_in_its_commit() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let task = |id| {
        upsert(
            &s,
            "tasks",
            &[Some(id), Some("o1"), None, Some("x"), None],
            None,
        )
    };
    client.push(&mut authority, "insert", vec![task("t1")]);
    // §2.2: the delete writes t1 at 2, so the insert of t3 starts at 3.
    client.push(
        &mut authority,
        "both",
        vec![delete("tasks", "t1"), task("t3")],
    );
    assert_eq!(stored(&authority, "tasks", "t3").map(|row| row.0), Some(3));
}

#[test]
fn a_recreate_starts_above_the_delete_floor_so_a_stale_base_version_conflicts() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let titled = |title: &str, base| {
        upsert(
            &s,
            "tasks",
            &[Some("t1"), Some("o1"), None, Some(title), None],
            base,
        )
    };
    client.push(&mut authority, "c1", vec![titled("v1", None)]);
    for title in ["v2", "v3"] {
        client.push(&mut authority, title, vec![titled(title, None)]);
    }
    // The delete advances 3 to 4; the tombstone and the floor record 4.
    client.push(&mut authority, "delete", vec![delete("tasks", "t1")]);
    assert_eq!(tombstone(&authority, "tasks", "t1"), Some(Some(4)));
    assert_eq!(store::log_state(&authority.conn).unwrap().delete_floor, 4);
    let (status, ..) = client.push(&mut authority, "recreate", vec![titled("new", Some(0))]);
    assert_eq!(status, PushStatus::Applied);
    assert_eq!(stored(&authority, "tasks", "t1").map(|row| row.0), Some(5));
    let (_, results, _) = client.push(&mut authority, "stale", vec![titled("stale", Some(3))]);
    let OpResult::Conflict {
        server_version,
        server_row,
        ..
    } = &results[0]
    else {
        panic!("a conflict: {results:?}");
    };
    assert_eq!(*server_version, 5);
    let row = store::decode_payload(&s.table("tasks").unwrap().columns, server_row).unwrap();
    assert_eq!(row[3], text("new"));
}

#[test]
fn every_insert_starts_above_the_floor_and_a_pruned_tombstone_leaves_it() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let version = |authority: &LocalAuthority, id| stored(authority, "tasks", id).map(|row| row.0);
    client.push(&mut authority, "c1", vec![task(&s, "fresh", None, None)]);
    assert_eq!(version(&authority, "fresh"), Some(1));
    client.push(&mut authority, "c2", vec![task(&s, "gone", None, None)]);
    client.push(&mut authority, "c3", vec![delete("tasks", "gone")]);
    // Another row id starts above the floor too.
    client.push(&mut authority, "c4", vec![task(&s, "other", None, None)]);
    assert_eq!(version(&authority, "other"), Some(3));
    let recreate = upsert(
        &s,
        "tasks",
        &[Some("gone"), Some("o1"), None, Some("x"), None],
        Some(0),
    );
    client.push(&mut authority, "c5", vec![recreate]);
    assert_eq!(version(&authority, "gone"), Some(3));
    assert_eq!(tombstone(&authority, "tasks", "gone"), None);
    client.push(&mut authority, "c6", vec![delete("tasks", "gone")]);
    let horizon = store::prune(
        &authority.conn,
        store::now_ms() + 31 * 24 * 60 * 60 * 1000,
        &Retention {
            min_retained_commits: 0,
            ..Retention::default()
        },
    )
    .unwrap();
    assert_eq!(horizon, 6);
    assert_eq!(tombstone(&authority, "tasks", "gone"), None);
    // Past the horizon an unversioned insert applies, still above the floor.
    let (status, ..) = client.push(&mut authority, "c7", vec![task(&s, "gone", None, None)]);
    assert_eq!(status, PushStatus::Applied);
    assert_eq!(version(&authority, "gone"), Some(5));
}

#[test]
fn a_delete_and_a_recreate_in_one_commit_advance_past_each_other() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "c1", vec![task(&s, "t1", None, None)]);
    let recreate = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), None, Some("again"), None],
        Some(0),
    );
    let (status, ..) = client.push(&mut authority, "c2", vec![delete("tasks", "t1"), recreate]);
    assert_eq!(status, PushStatus::Applied);
    assert_eq!(stored(&authority, "tasks", "t1").map(|row| row.0), Some(3));
    assert_eq!(tombstone(&authority, "tasks", "t1"), None);
}

#[test]
fn a_tombstone_without_a_stored_version_still_recreates_above_the_floor() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    client.push(&mut authority, "c1", vec![task(&s, "t1", None, None)]);
    client.push(&mut authority, "delete", vec![delete("tasks", "t1")]);
    authority
        .conn
        .execute_batch("UPDATE sync_tombstones SET server_version = NULL, scopes = NULL")
        .unwrap();
    let recreate = upsert(
        &s,
        "tasks",
        &[Some("t1"), Some("o1"), None, Some("again"), None],
        Some(0),
    );
    client.push(&mut authority, "recreate", vec![recreate]);
    assert_eq!(stored(&authority, "tasks", "t1").map(|row| row.0), Some(3));
}

/// One push request under `outbox_id`: each commit's id, status and records.
fn outbox_push(
    client: &Session,
    authority: &mut LocalAuthority,
    outbox_id: Option<&str>,
    commits: Vec<(&str, i64, Vec<Operation>)>,
) -> Vec<(String, PushStatus, Vec<OpResult>)> {
    let frames = commits
        .into_iter()
        .map(|(id, client_seq, operations)| Frame::PushCommit {
            client_commit_id: id.to_owned(),
            client_seq,
            operations,
        })
        .collect();
    client
        .outbox_round(authority, outbox_id, frames)
        .into_iter()
        .filter_map(|frame| match frame {
            Frame::PushResult {
                client_commit_id,
                status,
                results,
                ..
            } => Some((client_commit_id, status, results)),
            _ => None,
        })
        .collect()
}

/// `clientCommitId` and outbox sequence of every stored result of a client.
fn results(
    authority: &LocalAuthority,
    client_id: &str,
) -> Vec<(String, Option<String>, Option<i64>)> {
    authority
        .conn
        .prepare("SELECT client_commit_id, outbox_id, client_seq FROM sync_push_results WHERE client_id=?1 ORDER BY client_commit_id")
        .and_then(|mut statement| {
            statement
                .query_map([client_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect()
        })
        .expect("read")
}

fn expired(id: &str) -> (String, PushStatus, Vec<OpResult>) {
    (
        id.to_owned(),
        PushStatus::Rejected,
        vec![OpResult::Error {
            op_index: 0,
            code: "sync.commit_expired".to_owned(),
            message: "the commit lies below its outbox watermark (§6.3.2)".to_owned(),
            retryable: false,
        }],
    )
}

#[test]
fn a_request_raises_the_watermark_to_its_first_client_seq_and_deletes_the_results_below_it() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let push = |authority: &mut LocalAuthority, id: &str, seq| {
        outbox_push(
            &client,
            authority,
            Some("outbox-1"),
            vec![(id, seq, vec![task(&s, id, None, None)])],
        )
    };
    push(&mut authority, "c1", 1);
    push(&mut authority, "c2", 2);
    // A lost-ack retry of a commit still in the outbox replays its result.
    let retry = client.outbox_round(
        &mut authority,
        Some("outbox-1"),
        vec![Frame::PushCommit {
            client_commit_id: "c2".to_owned(),
            client_seq: 2,
            operations: vec![task(&s, "c2", None, None)],
        }],
    );
    assert!(matches!(
        &retry[1],
        Frame::PushResult {
            status: PushStatus::Cached,
            commit_seq: Some(2),
            ..
        }
    ));
    push(&mut authority, "c3", 3);
    // §12.2: the replica keeps the results of at most one request.
    assert_eq!(
        results(&authority, "c1"),
        vec![("c3".to_owned(), Some("outbox-1".to_owned()), Some(3))]
    );
    let watermarks: Vec<(String, String, i64)> = authority
        .conn
        .prepare("SELECT client_id, outbox_id, through_seq FROM sync_push_watermarks")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect()
        })
        .unwrap();
    assert_eq!(
        watermarks,
        vec![("c1".to_owned(), "outbox-1".to_owned(), 3)]
    );
    assert_eq!(push(&mut authority, "c1", 1), vec![expired("c1")]);
}

#[test]
fn a_commit_below_the_watermark_without_a_result_answers_commit_expired_unpersisted() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let commit = |id: &'static str, seq| (id, seq, vec![task(&s, id, None, None)]);
    outbox_push(
        &client,
        &mut authority,
        Some("outbox-1"),
        vec![commit("t1", 1)],
    );
    outbox_push(
        &client,
        &mut authority,
        Some("outbox-1"),
        vec![commit("t3", 3)],
    );
    // A delayed copy of an abandoned request: t1's result was deleted, t2
    // never applied.
    let delayed = outbox_push(
        &client,
        &mut authority,
        Some("outbox-1"),
        vec![commit("t1", 1), commit("t2", 2), commit("t4", 4)],
    );
    assert_eq!(delayed[..2], [expired("t1"), expired("t2")]);
    assert_eq!(delayed[2].1, PushStatus::Applied);
    assert!(stored(&authority, "tasks", "t2").is_none());
    assert_eq!(stored(&authority, "tasks", "t1").map(|row| row.0), Some(1));
    // The lower first sequence did not lower W: t3 keeps its result.
    assert_eq!(
        results(&authority, "c1")
            .into_iter()
            .map(|(id, ..)| id)
            .collect::<Vec<_>>(),
        vec!["t3", "t4"]
    );
}

#[test]
fn a_reused_commit_id_above_its_stored_sequence_is_processed_not_replayed() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let push = |authority: &mut LocalAuthority, seq| {
        outbox_push(
            &client,
            authority,
            Some("outbox-1"),
            vec![("a", seq, vec![task(&s, "a", None, None)])],
        )
    };
    push(&mut authority, 1);
    // Step 2 deletes a's result (sequence 1 < W = 3), so step 3 processes it.
    assert_eq!(push(&mut authority, 3)[0].1, PushStatus::Applied);
    assert_eq!(
        results(&authority, "c1"),
        vec![("a".to_owned(), Some("outbox-1".to_owned()), Some(3))]
    );
}

#[test]
fn a_first_commit_that_rejects_still_settles_the_watermark() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![("c1", 1, vec![task(&s, "t1", None, None)])],
    );
    let rejected = outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![("c2", 2, vec![delete("nope", "x")])],
    );
    assert_eq!(rejected[0].1, PushStatus::Rejected);
    assert_eq!(
        results(&authority, "c1"),
        vec![("c2".to_owned(), Some("o1".to_owned()), Some(2))]
    );
    assert_eq!(
        outbox_push(
            &client,
            &mut authority,
            Some("o1"),
            vec![("c1", 1, vec![task(&s, "t1", None, None)])]
        ),
        vec![expired("c1")]
    );
}

#[test]
fn results_without_an_outbox_stay_and_a_replica_settles_its_pre_upgrade_results() {
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "client-1");
    let commit = |id: &'static str, seq| (id, seq, vec![task(&s, id, None, None)]);
    for id in ["old-1", "old-2", "service"] {
        outbox_push(&client, &mut authority, None, vec![commit(id, 0)]);
    }
    // The first request with an outbox carries the surviving prefix [old-2].
    let upgraded = outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![commit("old-2", 5), commit("new-1", 6)],
    );
    assert_eq!(
        upgraded.iter().map(|result| result.1).collect::<Vec<_>>(),
        vec![PushStatus::Cached, PushStatus::Applied]
    );
    assert_eq!(
        results(&authority, "client-1"),
        vec![
            ("new-1".to_owned(), Some("o1".to_owned()), Some(6)),
            ("old-2".to_owned(), Some("o1".to_owned()), Some(5)),
        ]
    );
    outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![commit("new-2", 7)],
    );
    assert_eq!(
        results(&authority, "client-1")
            .into_iter()
            .map(|(id, ..)| id)
            .collect::<Vec<_>>(),
        vec!["new-2"]
    );
    // Another client's results are never touched.
    let other = Session::new(&mut authority, "client-2");
    outbox_push(&other, &mut authority, None, vec![commit("other", 0)]);
    outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![commit("new-3", 8)],
    );
    assert_eq!(results(&authority, "client-2").len(), 1);
}

#[test]
fn pre_upgrade_results_are_sequenced_by_their_request_and_deleted_once_the_last_commit_holds_none()
{
    let mut authority = memory();
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    let commit = |id: &'static str, seq| (id, seq, vec![task(&s, id, None, None)]);
    for id in ["X", "Y", "Z"] {
        outbox_push(&client, &mut authority, None, vec![commit(id, 0)]);
    }
    // X left the outbox; a push budget cut the request after Y. Y's commit
    // holds a pre-upgrade result, so X and Z stay.
    assert_eq!(
        outbox_push(&client, &mut authority, Some("o1"), vec![commit("Y", 5)])[0].1,
        PushStatus::Cached
    );
    assert_eq!(
        results(&authority, "c1"),
        vec![
            ("X".to_owned(), None, None),
            ("Y".to_owned(), Some("o1".to_owned()), Some(5)),
            ("Z".to_owned(), None, None),
        ]
    );
    // The next request ends with a new commit: X is deleted, Z takes its
    // sequence and replays, and the watermark deletes Y.
    let statuses = outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![commit("Z", 6), commit("N", 7)],
    );
    assert_eq!(
        statuses.iter().map(|result| result.1).collect::<Vec<_>>(),
        vec![PushStatus::Cached, PushStatus::Applied]
    );
    assert_eq!(
        results(&authority, "c1"),
        vec![
            ("N".to_owned(), Some("o1".to_owned()), Some(7)),
            ("Z".to_owned(), Some("o1".to_owned()), Some(6)),
        ]
    );
    // A late request built before Y's sequences a result below W: expired.
    let mut authority = memory();
    let client = Session::new(&mut authority, "c1");
    for id in ["X", "Y"] {
        outbox_push(&client, &mut authority, None, vec![commit(id, 0)]);
    }
    outbox_push(&client, &mut authority, Some("o1"), vec![commit("Y", 4)]);
    let late = outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![commit("X", 2), commit("Y", 4)],
    );
    assert_eq!(late[0], expired("X"));
    assert_eq!(late[1].1, PushStatus::Cached);
    assert_eq!(
        results(&authority, "c1"),
        vec![("Y".to_owned(), Some("o1".to_owned()), Some(4))]
    );
}

/// The internal tables of the 0.59.0 authority (wire version 3).
const STORE_0_59: &str = "
CREATE TABLE sync_schema_meta(id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, layouts TEXT NOT NULL);
CREATE TABLE sync_log(id INTEGER PRIMARY KEY CHECK (id = 1), log_epoch TEXT NOT NULL, max_commit_seq INTEGER NOT NULL, horizon_seq INTEGER NOT NULL);
CREATE TABLE sync_commits(commit_seq INTEGER PRIMARY KEY, client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE sync_changes(commit_seq INTEGER NOT NULL, idx INTEGER NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, op INTEGER NOT NULL, row_version INTEGER, scopes TEXT NOT NULL, payload BLOB, PRIMARY KEY (commit_seq, idx));
CREATE INDEX sync_changes_by_table ON sync_changes(tbl, commit_seq, idx);
CREATE TABLE sync_tombstones(tbl TEXT NOT NULL, row_id TEXT NOT NULL, commit_seq INTEGER NOT NULL, server_version INTEGER, scopes TEXT, PRIMARY KEY (tbl, row_id));
CREATE INDEX sync_tombstones_by_seq ON sync_tombstones(commit_seq);
CREATE TABLE sync_push_results(client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (client_id, client_commit_id));
CREATE TABLE sync_clients(client_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, last_round_at_ms INTEGER NOT NULL, last_error_code TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0);
INSERT INTO sync_log VALUES (1, 'epoch-0', 2, 0);
INSERT INTO sync_commits VALUES (1, 'c1', 'k1', 'local', 10), (2, 'c1', 'k2', 'local', 10);
INSERT INTO sync_changes VALUES (2, 0, 'tasks', 't9', 2, NULL, '{\"org\":\"o1\"}', NULL);
INSERT INTO sync_tombstones VALUES ('tasks', 't9', 2, 5, '{\"org\":\"o1\"}');
INSERT INTO sync_clients VALUES ('c1', 2, 10, 10, NULL, 0);
INSERT INTO sync_push_results VALUES ('c1', 'k1', '{\"applied\":true,\"commitSeq\":1,\"results\":[{\"status\":\"applied\",\"opIndex\":0}]}');
";

#[test]
fn a_store_from_0_59_migrates_to_the_fresh_schema() {
    let catalog = |authority: &LocalAuthority| -> Vec<String> {
        authority
            .conn
            .prepare(
                "SELECT m.name || '.' || c.name || ' ' || c.type || ' ' || c.\"notnull\" || ' ' || coalesce(c.dflt_value, '') || ' ' || c.pk
                   FROM sqlite_master AS m, pragma_table_info(m.name) AS c WHERE m.type='table'
                 UNION ALL
                 SELECT type || ' ' || name || ' ' || tbl_name || ' ' || coalesce(sql, '') FROM sqlite_master WHERE type<>'table'
                 ORDER BY 1",
            )
            .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
            .expect("catalog")
    };
    let path = temp_path();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(STORE_0_59)
        .unwrap();
    let mut authority = LocalAuthority::open(&path, &schema_json(1)).expect("migrate");
    assert_eq!(catalog(&authority), catalog(&memory()));
    // §2.2: the delete floor starts at the highest tombstone version.
    assert_eq!(store::log_state(&authority.conn).unwrap().delete_floor, 5);
    // §9: the record keeps its cursor and holds no list, so a pull that
    // refers to one is `unregistered`.
    assert_eq!(
        client_record(&authority, "c1").map(|record| record.0),
        Some(2)
    );
    let s = authority.schema.clone();
    let client = Session::new(&mut authority, "c1");
    assert_eq!(client.epoch, "epoch-0");
    let frames = client.round(
        &mut authority,
        vec![pull_header(2, &[org("o1")], None, 0, 0)],
    );
    assert_eq!(live(&frames).0, LiveStatus::Unregistered);
    // §9: the first request with an outbox sequences the pre-upgrade result
    // it carries and replays it.
    let settled = outbox_push(
        &client,
        &mut authority,
        Some("o1"),
        vec![("k1", 3, vec![task(&s, "t8", None, None)])],
    );
    assert_eq!(settled[0].1, PushStatus::Cached);
    assert_eq!(
        results(&authority, "c1"),
        vec![("k1".to_owned(), Some("o1".to_owned()), Some(3))]
    );
    client.push(&mut authority, "k3", vec![task(&s, "t8", None, None)]);
    assert_eq!(stored(&authority, "tasks", "t8").map(|row| row.0), Some(6));
    // §9: the horizon starts at the last commit before the upgrade, so a
    // cursor into that history, which holds a delete without a row version,
    // receives the §4.6 replica reset.
    assert_eq!(store::log_state(&authority.conn).unwrap().horizon, 2);
    let mut frames = vec![pull_header(1, &[org("o1")], None, 0, 0)];
    frames.extend(unit_frames(&[org("o1")]));
    let (status, through, _, commits) = live(&client.round(&mut authority, frames));
    assert_eq!((status, through, commits.len()), (LiveStatus::Reset, -1, 0));
    drop(authority);
    let _ = std::fs::remove_file(&path);
}
