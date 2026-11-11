//! Wire version 4 client behaviour against a scripted transport (SPEC §4):
//! the unit store, the registration list and digest, PROGRESS, the replica
//! cursor and join rule J, the live-section unit filter, resets, revocation,
//! the version guard, windows as sets of units, the outbox sequence and the
//! §9 upgrade of a version 3 replica. The scenarios mirror
//! `packages/web-client/test/units.test.ts` one for one.
use super::*;
use crate::values::encode_row_json;
use serde_json::json;
use ssp2::model::{EchoStatus, FencedRecord};
use ssp2::segment::{encode_rows_segment, SegmentRow};

const ECHO: [u8; 32] = [7; 32];

fn schema() -> Value {
    json!({"version": 1, "tables": [
        {"name": "tasks", "primaryKey": "id", "columns": [
            {"name": "id", "type": "string", "nullable": false},
            {"name": "project_id", "type": "string", "nullable": false},
            {"name": "title", "type": "string", "nullable": false}],
         "scopes": [{"pattern": "project:{project_id}"}]},
        {"name": "notes", "primaryKey": "id", "columns": [
            {"name": "id", "type": "string", "nullable": false},
            {"name": "project_id", "type": "string", "nullable": false},
            {"name": "org_id", "type": "string", "nullable": false},
            {"name": "body", "type": "string", "nullable": false}],
         "scopes": [{"pattern": "project:{project_id}"}, {"pattern": "org:{org_id}"}]}]})
}

fn scopes(pairs: &[(&str, &str)]) -> UnitScopes {
    pairs
        .iter()
        .map(|(variable, value)| ((*variable).to_owned(), (*value).to_owned()))
        .collect()
}

fn p1() -> UnitScopes {
    scopes(&[("project_id", "p1")])
}

fn p2() -> UnitScopes {
    scopes(&[("project_id", "p2")])
}

fn org() -> UnitScopes {
    scopes(&[("org_id", "o1")])
}

fn id_of(unit: &UnitScopes) -> String {
    ssp2::registration::unit_id(&scope_pairs(unit))
}

fn start(id: &str, status: SubStatus, bootstrap: bool, fenced: Vec<FencedRecord>) -> Frame {
    Frame::SubStart {
        id: id.to_owned(),
        status,
        reason_code: match status {
            SubStatus::Active => String::new(),
            SubStatus::Revoked => "sync.scope_revoked".to_owned(),
            SubStatus::Reset => "sync.cursor_expired".to_owned(),
        },
        bootstrap,
        fenced,
    }
}

fn end(next_cursor: i64, bootstrap_state: Option<&str>) -> Frame {
    Frame::SubEnd {
        next_cursor,
        bootstrap_state: bootstrap_state.map(|token| RawJson(token.to_owned())),
    }
}

fn fenced(table: &str, status: EchoStatus, values: &[(&str, &str)]) -> FencedRecord {
    FencedRecord {
        table: table.to_owned(),
        status,
        scopes: values
            .iter()
            .map(|(variable, value)| ((*variable).to_owned(), vec![(*value).to_owned()]))
            .collect(),
    }
}

/// A test client with its scripted transport. Segment rows stand at
/// version 1 unless `rows_at` names another.
struct Harness {
    client: SyncClient,
    transport: Script,
}

#[derive(Default)]
struct Script {
    requests: Vec<Vec<Frame>>,
    replies: VecDeque<Vec<u8>>,
    sent: Vec<String>,
}

impl Transport for Script {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.requests
            .push(decode_message(request).expect("a request").frames);
        Ok(self.replies.pop_front().expect("no scripted response"))
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.sync(request)
    }

    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new(
            "test.no_segments",
            "inline segments only",
        ))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.sent.push(text.to_owned());
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn response(frames: Vec<Frame>) -> Vec<u8> {
    let mut all = vec![Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "e1".into(),
        reset_required: false,
    }];
    all.extend(frames);
    encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: all,
    })
}

impl Harness {
    fn new() -> Self {
        Self::over(
            SyncClient::new("units-client".into(), &schema(), ClientLimits::default()).unwrap(),
        )
    }

    fn over(client: SyncClient) -> Self {
        client.set_meta(LOG_EPOCH_KEY, "e1").unwrap();
        Self {
            client,
            transport: Script::default(),
        }
    }

    fn round(&mut self, frames: Vec<Frame>) -> SyncReport {
        self.transport.replies.push_back(response(frames));
        match self.client.sync(&mut self.transport) {
            SyncOutcome::Ok(report) => report,
            outcome => panic!("round failed: {outcome:?}"),
        }
    }

    fn last(&self) -> &[Frame] {
        self.transport.requests.last().expect("a request")
    }

    fn ids(&self, table: &str) -> Vec<String> {
        self.client
            .query(&format!("SELECT id FROM {table} ORDER BY id"), &[])
            .unwrap()
            .into_iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn tasks(&self) -> Vec<Value> {
        self.client
            .query("SELECT id, project_id, title FROM tasks", &[])
            .unwrap()
            .into_iter()
            .map(Value::Object)
            .collect()
    }

    fn unit(&self, unit: &UnitScopes) -> UnitRecord {
        self.client
            .unit(&id_of(unit))
            .unwrap()
            .expect("a registered unit")
    }

    fn rows_at(&self, table: &str, version: i64, rows: &[&[&str]]) -> Frame {
        let schema = self.client.schema.table(table).unwrap();
        Frame::SegmentInline {
            payload: encode_rows_segment(&RowsSegment {
                table: table.to_owned(),
                schema_version: 1,
                columns: schema.wire_columns.clone(),
                blocks: if rows.is_empty() {
                    Vec::new()
                } else {
                    vec![rows
                        .iter()
                        .map(|values| SegmentRow {
                            server_version: version,
                            values: values
                                .iter()
                                .map(|value| Some(ColumnValue::String((*value).to_owned())))
                                .collect(),
                        })
                        .collect()]
                },
            }),
        }
    }

    fn rows(&self, table: &str, rows: &[&[&str]]) -> Frame {
        self.rows_at(table, 1, rows)
    }

    /// A complete bootstrap section with one page per table.
    fn bootstrap(
        &self,
        unit: &UnitScopes,
        pin: i64,
        pages: Vec<Frame>,
        echo: Vec<FencedRecord>,
    ) -> Vec<Frame> {
        let mut frames = vec![start(&id_of(unit), SubStatus::Active, true, echo)];
        frames.extend(pages);
        frames.push(end(pin, None));
        frames
    }

    /// One `COMMIT`; each change is `(table, op, values, rowVersion)`.
    fn commit(&self, commit_seq: i64, changes: &[(&str, Op, &[&str], i64)]) -> Frame {
        let mut tables: Vec<String> = Vec::new();
        let changes = changes
            .iter()
            .map(|(table, op, values, row_version)| {
                if !tables.iter().any(|known| known == table) {
                    tables.push((*table).to_owned());
                }
                let schema = self.client.schema.table(table).unwrap();
                let mut change_scopes = vec![("project_id".to_owned(), values[1].to_owned())];
                if *table == "notes" {
                    change_scopes.insert(0, ("org_id".to_owned(), values[2].to_owned()));
                }
                ssp2::model::Change {
                    table_index: tables.iter().position(|known| known == table).unwrap() as u16,
                    row_id: values[0].to_owned(),
                    op: *op,
                    row_version: *row_version,
                    scopes: change_scopes,
                    row: (*op == Op::Upsert).then(|| {
                        let row = schema
                            .columns
                            .iter()
                            .zip(values.iter())
                            .map(|(column, value)| (column.name.clone(), Value::from(*value)))
                            .collect();
                        encode_row_json(schema, values[0], &row, &self.client.encryption).unwrap()
                    }),
                }
            })
            .collect();
        Frame::Commit {
            commit_seq,
            created_at_ms: 1,
            actor_id: "actor".into(),
            tables,
            changes,
        }
    }
}

fn live(through_seq: i64, commits: Vec<Frame>) -> Vec<Frame> {
    let mut frames = vec![Frame::LiveStart {
        status: LiveStatus::Active,
        reason_code: String::new(),
    }];
    frames.extend(commits);
    frames.push(Frame::LiveEnd {
        through_seq,
        echo_digest: Some(ECHO),
    });
    frames
}

fn concat(parts: Vec<Vec<Frame>>) -> Vec<Frame> {
    parts.into_iter().flatten().collect()
}

fn units_of(frames: &[Frame]) -> Vec<Vec<(String, String)>> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::Unit { scopes } => Some(scopes.clone()),
            _ => None,
        })
        .collect()
}

fn progress_of(frames: &[Frame]) -> Vec<(String, i64, Option<String>)> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            Frame::Progress {
                id,
                cursor,
                bootstrap_state,
            } => Some((
                id.clone(),
                *cursor,
                bootstrap_state.clone().map(|token| token.0),
            )),
            _ => None,
        })
        .collect()
}

fn pull_of(frames: &[Frame]) -> (i64, [u8; 32], Option<[u8; 32]>) {
    frames
        .iter()
        .find_map(|frame| match frame {
            Frame::PullHeader {
                cursor,
                registration_digest,
                echo_digest,
                ..
            } => Some((*cursor, *registration_digest, *echo_digest)),
            _ => None,
        })
        .expect("a pull header")
}

fn upsert(table: &str, values: &[(&str, &str)]) -> Mutation {
    Mutation::Upsert {
        table: table.to_owned(),
        values: values
            .iter()
            .map(|(column, value)| ((*column).to_owned(), Value::from(*value)))
            .collect(),
        base_version: None,
    }
}

fn applied(client_commit_id: &str, commit_seq: i64) -> Frame {
    Frame::PushResult {
        client_commit_id: client_commit_id.to_owned(),
        status: PushStatus::Applied,
        commit_seq: Some(commit_seq),
        results: vec![OpResult::Applied { op_index: 0 }],
    }
}

fn rejected(client_commit_id: &str, code: &str) -> Frame {
    Frame::PushResult {
        client_commit_id: client_commit_id.to_owned(),
        status: PushStatus::Rejected,
        commit_seq: None,
        results: vec![OpResult::Error {
            op_index: 0,
            code: code.to_owned(),
            message: "refused".to_owned(),
            retryable: false,
        }],
    }
}

// -- §4.1 registration list -----------------------------------------------------

#[test]
fn a_unit_registers_once_travels_while_it_changed_and_is_referenced_by_digest_after() {
    let mut h = Harness::new();
    let id = h.client.subscribe(p1()).unwrap();
    assert_eq!(id, id_of(&p1()));
    assert_eq!(h.client.subscribe(p1()).unwrap(), id);
    let pages = vec![
        h.rows("notes", &[&["n1", "p1", "o1", "b"]]),
        h.rows("tasks", &[&["t1", "p1", "a"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 5, pages, vec![]),
        live(5, vec![]),
    ]));
    let first = h.last().to_vec();
    let (cursor, digest, echo) = pull_of(&first);
    assert_eq!(cursor, -1);
    assert_eq!(
        digest,
        ssp2::registration::registration_digest([scope_pairs(&p1()).as_slice()])
    );
    assert_eq!(echo, None);
    assert_eq!(units_of(&first), vec![scope_pairs(&p1())]);
    assert_eq!(progress_of(&first), vec![(id.clone(), -1, None)]);
    assert!(matches!(
        first.first(),
        Some(Frame::ReqHeader { outbox_id: Some(outbox), .. }) if outbox.len() == 36
    ));
    // One unit covers both tables declaring its variable (§4.1).
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    assert_eq!(h.ids("notes"), vec!["n1"]);
    assert_eq!(h.unit(&p1()).cursor, None);
    let read = h
        .client
        .snapshot_read(
            &SnapshotReadRequest {
                units: vec![id.clone()],
                ..Default::default()
            },
            None,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&read.units).unwrap(),
        json!([{"state": "known", "id": id, "status": "active", "live": true, "cursor": 5,
            "hasResumeToken": false, "bootstrapComplete": true, "knownPendingPages": false}])
    );

    h.round(live(5, vec![]));
    let quiet = h.last().to_vec();
    assert!(units_of(&quiet).is_empty());
    assert!(progress_of(&quiet).is_empty());
    assert_eq!(pull_of(&quiet).0, 5);
    assert_eq!(pull_of(&quiet).2, Some(ECHO));

    let second = h.client.subscribe(p2()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p2(), 6, pages, vec![]),
        live(6, vec![]),
    ]));
    assert_eq!(
        units_of(h.last()),
        vec![scope_pairs(&p1()), scope_pairs(&p2())]
    );
    assert_eq!(progress_of(h.last()), vec![(second, -1, None)]);
}

#[test]
fn unregistered_keeps_every_cursor_and_sends_the_list_in_the_next_round_at_once() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    h.round(live(3, vec![]));
    assert!(units_of(h.last()).is_empty());
    h.client.drain_sync_intents();
    h.round(vec![
        Frame::LiveStart {
            status: LiveStatus::Unregistered,
            reason_code: String::new(),
        },
        Frame::LiveEnd {
            through_seq: -1,
            echo_digest: None,
        },
    ]);
    assert!(h.client.sync_needed());
    assert!(matches!(
        h.client.drain_sync_intents().as_slice(),
        [.., SyncIntent::Interactive]
    ));
    assert_eq!(h.client.diagnostics_snapshot().unwrap().replica_cursor, 3);
    h.round(live(3, vec![]));
    assert_eq!(units_of(h.last()), vec![scope_pairs(&p1())]);
    assert_eq!(pull_of(h.last()).0, 3);
}

#[test]
fn a_scope_map_without_a_value_with_a_wildcard_or_covering_no_table_is_refused() {
    let mut h = Harness::new();
    for unit in [
        UnitScopes::new(),
        scopes(&[("project_id", "*")]),
        scopes(&[("tenant_id", "t1")]),
    ] {
        let error = h.client.subscribe(unit).unwrap_err();
        assert!(error.starts_with("sync.invalid_subscription"), "{error}");
    }
    assert!(h.client.units().unwrap().is_empty());
}

// -- §4.5 replica cursor and live section ---------------------------------------

#[test]
fn join_rule_j_keeps_a_post_bootstrap_unit_catching_up_until_t_reaches_r() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 10, pages, vec![]),
        live(10, vec![]),
    ]));
    let b = h.client.subscribe(p2()).unwrap();
    // B completes at pin 4; the section is cut at T = 7, below R = 10.
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p2(), 4, pages, vec![]),
        live(7, vec![]),
    ]));
    assert_eq!(h.unit(&p2()).cursor, Some(7));
    assert_eq!(h.unit(&p1()).cursor, None);
    assert_eq!(h.client.diagnostics_snapshot().unwrap().replica_cursor, 10);
    assert!(h.client.sync_needed());
    h.round(live(12, vec![]));
    assert_eq!(progress_of(h.last()), vec![(b, 7, None)]);
    assert_eq!(h.unit(&p2()).cursor, None);
    assert_eq!(h.client.diagnostics_snapshot().unwrap().replica_cursor, 12);
}

#[test]
fn the_client_applies_only_changes_matching_a_live_or_post_bootstrap_unit() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 2, pages, vec![]),
        live(2, vec![]),
    ]));
    let p2_id = h.client.subscribe(p2()).unwrap();
    // P2 is still bootstrapping: its section carries a resume token.
    let commit = h.commit(
        3,
        &[
            ("tasks", Op::Upsert, &["t1", "p1", "a"], 2),
            ("tasks", Op::Upsert, &["t2", "p2", "b"], 2),
            ("tasks", Op::Upsert, &["t3", "p3", "c"], 2),
        ],
    );
    h.round(concat(vec![
        vec![
            start(&p2_id, SubStatus::Active, true, vec![]),
            h.rows("notes", &[]),
            end(5, Some(r#"{"t":1}"#)),
        ],
        live(5, vec![commit]),
    ]));
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    let unit = h.unit(&p2());
    assert_eq!(
        (unit.cursor, unit.seeded),
        (Some(5), vec!["notes".to_owned()])
    );
}

#[test]
fn a_replica_reset_bootstraps_live_units_again_and_keeps_post_bootstrap_cursors() {
    let mut h = Harness::new();
    let a = h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[&["t1", "p1", "a"]])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 10, pages, vec![]),
        live(10, vec![]),
    ]));
    h.client.subscribe(p2()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p2(), 4, pages, vec![]),
        live(7, vec![]),
    ]));
    let report = h.round(vec![
        Frame::LiveStart {
            status: LiveStatus::Reset,
            reason_code: "sync.cursor_expired".into(),
        },
        Frame::LiveEnd {
            through_seq: -1,
            echo_digest: Some(ECHO),
        },
    ]);
    assert_eq!(report.resets, vec![a]);
    let unit = h.unit(&p1());
    assert_eq!(
        (unit.cursor, unit.reason_code.as_deref()),
        (Some(-1), Some("sync.cursor_expired"))
    );
    assert_eq!(h.unit(&p2()).cursor, Some(7));
    let diagnostics = h.client.diagnostics_snapshot().unwrap();
    assert_eq!(diagnostics.replica_cursor, -1);
    assert_eq!(
        (diagnostics.units.reset, diagnostics.units.complete),
        (1, 1)
    );
    // A reset is staleness, never a purge.
    assert_eq!(h.ids("tasks"), vec!["t1"]);
}

// -- §3.3 revocation, purge and row ownership -----------------------------------

#[test]
fn a_revoked_unit_purges_its_echo_scopes_except_rows_another_unit_owns_then_rearms() {
    let mut h = Harness::new();
    let a = h.client.subscribe(p1()).unwrap();
    h.client.subscribe(org()).unwrap();
    let pages = vec![
        h.rows(
            "notes",
            &[&["n1", "p1", "o1", "x"], &["n2", "p1", "o2", "y"]],
        ),
        h.rows("tasks", &[&["t1", "p1", "a"]]),
    ];
    let org_pages = vec![h.rows("notes", &[&["n1", "p1", "o1", "x"]])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        h.bootstrap(&org(), 3, org_pages, vec![]),
        live(3, vec![]),
    ]));
    assert_eq!(h.ids("notes"), vec!["n1", "n2"]);
    let report = h.round(concat(vec![
        vec![start(&a, SubStatus::Revoked, false, vec![]), end(3, None)],
        live(3, vec![]),
    ]));
    assert_eq!(report.revoked, vec![a.clone()]);
    // n1 lies in the org unit's scope too: that unit owns it.
    assert_eq!(h.ids("notes"), vec!["n1"]);
    assert!(h.ids("tasks").is_empty());
    assert_eq!(h.unit(&p1()).status, UnitStatus::Revoked);
    h.round(live(3, vec![]));
    assert_eq!(units_of(h.last()), vec![scope_pairs(&org())]);
    h.client.subscribe(p1()).unwrap();
    let unit = h.unit(&p1());
    assert_eq!((unit.status, unit.cursor), (UnitStatus::Active, Some(-1)));
    assert!(h.client.sync_needed());
}

#[test]
fn a_revoked_fenced_record_purges_that_table_only_and_turning_active_rebootstraps() {
    let mut h = Harness::new();
    let a = h.client.subscribe(p1()).unwrap();
    let echo = vec![fenced("notes", EchoStatus::Active, &[("org_id", "o1")])];
    let pages = vec![
        h.rows("notes", &[&["n1", "p1", "o1", "x"]]),
        h.rows("tasks", &[&["t1", "p1", "a"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, echo.clone()),
        live(3, vec![]),
    ]));
    h.round(concat(vec![
        vec![
            start(
                &a,
                SubStatus::Active,
                false,
                vec![fenced("notes", EchoStatus::Revoked, &[])],
            ),
            end(3, None),
        ],
        live(3, vec![]),
    ]));
    assert!(h.ids("notes").is_empty());
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    assert_eq!(h.unit(&p1()).status, UnitStatus::Active);
    h.round(concat(vec![
        vec![start(&a, SubStatus::Active, false, echo), end(3, None)],
        live(3, vec![]),
    ]));
    let unit = h.unit(&p1());
    assert_eq!((unit.cursor, unit.seeded), (Some(-1), Vec::<String>::new()));
}

#[test]
fn the_first_page_clears_the_pair_scope_except_rows_an_owner_holds() {
    let mut h = Harness::new();
    h.client.subscribe(org()).unwrap();
    let pages = vec![h.rows("notes", &[&["n1", "p1", "o1", "x"]])];
    h.round(concat(vec![
        h.bootstrap(&org(), 2, pages, vec![]),
        live(2, vec![]),
    ]));
    h.client
        .conn
        .execute_batch(
            "INSERT INTO _syncular_base_notes VALUES('stale','p1','o2','s',1);
             INSERT INTO notes VALUES('stale','p1','o2','s',1);",
        )
        .unwrap();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 4, pages, vec![]),
        live(4, vec![]),
    ]));
    assert_eq!(h.ids("notes"), vec!["n1"]);
}

// -- §5.6 fail closed at the first-page clear -----------------------------------

#[test]
fn a_fenced_variable_without_a_local_mapping_fails_the_unit_and_keeps_its_rows() {
    let mut h = Harness::new();
    let a = h.client.subscribe(p1()).unwrap();
    h.client.subscribe(org()).unwrap();
    h.client
        .conn
        .execute_batch(
            "INSERT INTO _syncular_base_tasks VALUES('t0','p1','kept',1);
             INSERT INTO tasks VALUES('t0','p1','kept',1);",
        )
        .unwrap();
    let pages = vec![h.rows("tasks", &[&["t1", "p1", "a"]])];
    let org_pages = vec![h.rows("notes", &[&["n1", "p9", "o1", "x"]])];
    let report = h.round(concat(vec![
        h.bootstrap(
            &p1(),
            3,
            pages,
            vec![fenced("tasks", EchoStatus::Active, &[("region_id", "r1")])],
        ),
        h.bootstrap(&org(), 3, org_pages, vec![]),
        live(3, vec![]),
    ]));
    assert_eq!(report.failed, vec![a]);
    let unit = h.unit(&p1());
    assert_eq!(
        (unit.status, unit.reason_code.as_deref(), unit.cursor),
        (UnitStatus::Failed, Some("sync.scope_revoked"), Some(-1))
    );
    // Precision or nothing: the table is not cleared as an approximation.
    assert_eq!(h.ids("tasks"), vec!["t0"]);
    assert_eq!(h.ids("notes"), vec!["n1"]);
    assert_eq!(h.unit(&org()).cursor, None);
    // A failed unit is a configuration error: registering it again keeps it.
    h.client.subscribe(p1()).unwrap();
    assert_eq!(h.unit(&p1()).status, UnitStatus::Failed);
}

// -- §4.5 version guard ---------------------------------------------------------

#[test]
fn a_live_delete_of_the_old_scope_keeps_the_row_another_unit_holds_at_its_new_scope() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![
        h.rows("notes", &[]),
        h.rows("tasks", &[&["x", "p1", "old"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 5, pages, vec![]),
        live(5, vec![]),
    ]));
    h.client.subscribe(p2()).unwrap();
    // Commit 8 moved x from p1 to p2 at version 2 (§2.2). P2's segment (pin
    // 9) holds x at p2, and the live section from R = 5 carries the delete
    // half tagged p1: the upsert half lies at or below P2's pin.
    let pages = vec![
        h.rows("notes", &[]),
        h.rows_at("tasks", 2, &[&["x", "p2", "moved"]]),
    ];
    let delete = h.commit(8, &[("tasks", Op::Delete, &["x", "p1", "old"], 2)]);
    h.round(concat(vec![
        h.bootstrap(&p2(), 9, pages, vec![]),
        live(9, vec![delete]),
    ]));
    assert_eq!(
        h.tasks(),
        vec![json!({"id": "x", "project_id": "p2", "title": "moved"})]
    );
    // A delete above the row's version applies.
    let delete = h.commit(10, &[("tasks", Op::Delete, &["x", "p2", ""], 3)]);
    h.round(live(10, vec![delete]));
    assert!(h.ids("tasks").is_empty());
}

#[test]
fn a_move_pair_keeps_the_upsert_in_either_change_order() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    h.client.subscribe(p2()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[&["x", "p1", "a"]])];
    let p2_pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    let first = h.commit(
        4,
        &[
            ("tasks", Op::Upsert, &["x", "p2", "b"], 2),
            ("tasks", Op::Delete, &["x", "p1", "a"], 2),
        ],
    );
    let second = h.commit(
        5,
        &[
            ("tasks", Op::Delete, &["x", "p2", "b"], 3),
            ("tasks", Op::Upsert, &["x", "p1", "c"], 3),
        ],
    );
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        h.bootstrap(&p2(), 3, p2_pages, vec![]),
        live(5, vec![first, second]),
    ]));
    assert_eq!(
        h.tasks(),
        vec![json!({"id": "x", "project_id": "p1", "title": "c"})]
    );
}

#[test]
fn a_lagging_units_older_segment_row_upsert_and_delete_leave_the_newer_row_in_place() {
    let mut h = Harness::new();
    h.client.subscribe(p2()).unwrap();
    // x was created at p1 (commit 4, version 1), moved to p2 (commit 8,
    // version 2) and edited (commit 9, version 3).
    let pages = vec![
        h.rows("notes", &[]),
        h.rows_at("tasks", 3, &[&["x", "p2", "c"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p2(), 9, pages, vec![]),
        live(9, vec![]),
    ]));
    h.client.subscribe(p1()).unwrap();
    // P1's bootstrap pinned at 3 and served x from an earlier page; its scan
    // from 3 re-delivers the history tagged p1. Applied unconditionally it
    // would rewind x to p1 and then delete it.
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[&["x", "p1", "a"]])];
    let created = h.commit(4, &[("tasks", Op::Upsert, &["x", "p1", "a"], 1)]);
    let moved = h.commit(8, &[("tasks", Op::Delete, &["x", "p1", "a"], 2)]);
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(9, vec![created, moved]),
    ]));
    assert_eq!(
        h.tasks(),
        vec![json!({"id": "x", "project_id": "p2", "title": "c"})]
    );
}

#[test]
fn an_older_upsert_of_a_deleted_row_returns_until_the_same_scan_removes_it_again() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![
        h.rows("notes", &[&["n", "p1", "o1", "a"]]),
        h.rows("tasks", &[]),
    ];
    let delete = h.commit(6, &[("notes", Op::Delete, &["n", "p1", "o1", "a"], 2)]);
    h.round(concat(vec![
        h.bootstrap(&p1(), 5, pages, vec![]),
        live(6, vec![delete.clone()]),
    ]));
    assert!(h.ids("notes").is_empty());
    // The org unit's scan starts at its pin 3 and is cut at 4: it re-delivers
    // the insert the replica already saw deleted.
    h.client.subscribe(org()).unwrap();
    let pages = vec![h.rows("notes", &[])];
    let insert = h.commit(4, &[("notes", Op::Upsert, &["n", "p1", "o1", "a"], 1)]);
    h.round(concat(vec![
        h.bootstrap(&org(), 3, pages, vec![]),
        live(4, vec![insert]),
    ]));
    assert_eq!(h.ids("notes"), vec!["n"]);
    h.round(live(6, vec![delete]));
    assert!(h.ids("notes").is_empty());
}

#[test]
fn a_skipped_change_leaves_the_optimistic_overlay_and_its_rollback_base_intact() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![
        h.rows("notes", &[]),
        h.rows_at("tasks", 3, &[&["x", "p1", "base"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    h.client.connect_realtime(&mut h.transport).unwrap();
    let pending = h
        .client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "x"), ("project_id", "p1"), ("title", "mine")],
        )])
        .unwrap();
    // An older version arrives while the commit is pending: the overlay and
    // the base the rollback restores stay as they were.
    let stale = h.commit(4, &[("tasks", Op::Upsert, &["x", "p1", "stale"], 2)]);
    h.client
        .on_realtime_binary(&mut h.transport, &response(live(4, vec![stale])));
    assert_eq!(
        h.tasks(),
        vec![json!({"id": "x", "project_id": "p1", "title": "mine"})]
    );
    h.client.disconnect_realtime(&mut h.transport);
    h.round(concat(vec![
        vec![rejected(&pending, "app.refused")],
        live(4, vec![]),
    ]));
    assert_eq!(
        h.tasks(),
        vec![json!({"id": "x", "project_id": "p1", "title": "base"})]
    );
}

// -- §4.8 windows as sets of units ----------------------------------------------

fn project_window() -> WindowBase {
    WindowBase {
        variable: "project_id".into(),
        fixed_scopes: UnitScopes::new(),
    }
}

#[test]
fn a_window_and_an_explicit_subscribe_share_one_unit_and_the_last_release_evicts_it() {
    let mut h = Harness::new();
    let base = project_window();
    h.client
        .set_window(&base, &["p1".into(), "p2".into()])
        .unwrap();
    let ids: Vec<String> = h
        .client
        .units()
        .unwrap()
        .into_iter()
        .map(|unit| unit.id)
        .collect();
    assert_eq!(ids, vec![id_of(&p1()), id_of(&p2())]);
    assert_eq!(
        h.client.window_state(&base).unwrap(),
        WindowState {
            units: vec!["p1".into(), "p2".into()],
            pending: vec!["p1".into(), "p2".into()],
        }
    );
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[&["t1", "p1", "a"]])];
    let p2_pages = vec![h.rows("notes", &[]), h.rows("tasks", &[&["t2", "p2", "b"]])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        h.bootstrap(&p2(), 3, p2_pages, vec![]),
        live(3, vec![]),
    ]));
    assert!(h.client.window_state(&base).unwrap().pending.is_empty());
    h.client.subscribe(p1()).unwrap();
    h.client.set_window(&base, &[]).unwrap();
    // P1 stays: the explicit reference holds it. P2 left and was evicted.
    let ids: Vec<String> = h
        .client
        .units()
        .unwrap()
        .into_iter()
        .map(|unit| unit.id)
        .collect();
    assert_eq!(ids, vec![id_of(&p1())]);
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    h.round(live(3, vec![]));
    assert_eq!(units_of(h.last()), vec![scope_pairs(&p1())]);
    // Releasing the explicit reference unregisters without evicting.
    h.client.unsubscribe(&id_of(&p1())).unwrap();
    assert!(h.client.units().unwrap().is_empty());
    assert_eq!(h.ids("tasks"), vec!["t1"]);
}

#[test]
fn e1_a_pinned_row_survives_the_eviction_and_leaves_when_its_commit_drains() {
    let mut h = Harness::new();
    let base = project_window();
    h.client.set_window(&base, &["p1".into()]).unwrap();
    let pages = vec![
        h.rows("notes", &[]),
        h.rows("tasks", &[&["t1", "p1", "a"], &["t2", "p1", "b"]]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    let pending = h
        .client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "t1"), ("project_id", "p1"), ("title", "mine")],
        )])
        .unwrap();
    h.client.set_window(&base, &[]).unwrap();
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    h.round(vec![
        applied(&pending, 4),
        Frame::LiveStart {
            status: LiveStatus::Active,
            reason_code: String::new(),
        },
        Frame::LiveEnd {
            through_seq: -1,
            echo_digest: None,
        },
    ]);
    assert!(h.ids("tasks").is_empty());
}

#[test]
fn a_deferred_eviction_chunk_keeps_the_pages_a_bootstrapping_unit_already_applied() {
    let mut h = Harness::new();
    let base = project_window();
    h.client.set_window(&base, &["p1".into()]).unwrap();
    let pages = vec![
        h.rows("notes", &[&["n1", "p1", "o1", "a"]]),
        h.rows("tasks", &[]),
    ];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    let pending = h
        .client
        .mutate(vec![upsert(
            "notes",
            &[
                ("id", "n1"),
                ("project_id", "p1"),
                ("org_id", "o1"),
                ("body", "mine"),
            ],
        )])
        .unwrap();
    // n1 is pinned, so the eviction of p1 stays pending.
    h.client.set_window(&base, &[]).unwrap();
    assert_eq!(h.ids("notes"), vec!["n1"]);
    h.client.subscribe(org()).unwrap();
    // The push drains n1's pin in the same round in which the org unit's
    // first page delivers n1 and n2; its bootstrap is not complete yet.
    let page = h.rows_at(
        "notes",
        2,
        &[&["n1", "p1", "o1", "mine"], &["n2", "p1", "o1", "b"]],
    );
    h.round(concat(vec![
        vec![
            applied(&pending, 4),
            start(&id_of(&org()), SubStatus::Active, true, vec![]),
            page,
            end(4, Some(r#"{"tableIndex":0,"rowCursor":"n2"}"#)),
        ],
        live(4, vec![]),
    ]));
    assert_eq!(h.ids("notes"), vec!["n1", "n2"]);
}

#[test]
fn releasing_a_window_unit_keeps_the_prepared_round() {
    // §4.4: the released unit's section is skipped; the round completes.
    let mut h = Harness::new();
    h.client
        .set_window(&project_window(), &["p1".into()])
        .unwrap();
    h.client.active_round = Some(uuid::Uuid::nil());
    h.client.set_window(&project_window(), &[]).unwrap();
    assert_eq!(h.client.active_round, Some(uuid::Uuid::nil()));
}

#[test]
fn unsubscribing_keeps_the_prepared_round() {
    // §4.4: the released unit's section is skipped; the round completes.
    let mut h = Harness::new();
    let id = h.client.subscribe(p1()).unwrap();
    h.client.active_round = Some(uuid::Uuid::nil());
    h.client.unsubscribe(&id).unwrap();
    assert_eq!(h.client.active_round, Some(uuid::Uuid::nil()));
}

// -- §6.3.2 push sequence -------------------------------------------------------

#[test]
fn commits_carry_the_outbox_sequence_and_commit_expired_is_a_rejection() {
    let mut h = Harness::new();
    let first = h
        .client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "t1"), ("project_id", "p1"), ("title", "a")],
        )])
        .unwrap();
    let second = h
        .client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "t2"), ("project_id", "p1"), ("title", "b")],
        )])
        .unwrap();
    let report = h.round(concat(vec![
        vec![rejected(&first, "sync.commit_expired"), applied(&second, 1)],
        live(1, vec![]),
    ]));
    let sequences: Vec<i64> = h
        .last()
        .iter()
        .filter_map(|frame| match frame {
            Frame::PushCommit { client_seq, .. } => Some(*client_seq),
            _ => None,
        })
        .collect();
    assert_eq!(sequences, vec![1, 2]);
    assert_eq!(report.rejected, vec![first.clone()]);
    assert!(h.client.pending_commit_ids().is_empty());
    assert_eq!(
        h.client
            .commit_outcome(&first)
            .unwrap()
            .map(|outcome| outcome.status),
        Some(CommitOutcomeStatus::Rejected)
    );
    assert_eq!(h.ids("tasks"), vec!["t2"]);
}

// -- §8.2 deltas ----------------------------------------------------------------

#[test]
fn a_delta_applies_like_a_live_section_advances_the_replica_cursor_and_acks_it() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    h.client.connect_realtime(&mut h.transport).unwrap();
    h.transport.sent.clear();
    let insert = h.commit(4, &[("tasks", Op::Upsert, &["t1", "p1", "a"], 2)]);
    h.client
        .on_realtime_binary(&mut h.transport, &response(live(4, vec![insert])));
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    assert_eq!(h.client.diagnostics_snapshot().unwrap().replica_cursor, 4);
    assert_eq!(
        h.transport.sent,
        vec![r#"{"type":"ack","cursor":4}"#.to_owned()]
    );
    // A duplicate at or below the replica cursor is skipped, not a drop.
    let delete = h.commit(4, &[("tasks", Op::Delete, &["t1", "p1", ""], 3)]);
    h.client
        .on_realtime_binary(&mut h.transport, &response(live(4, vec![delete])));
    assert_eq!(h.ids("tasks"), vec!["t1"]);
    assert!(!h.client.sync_needed());
}

#[test]
fn a_delta_whose_resp_header_carries_a_schema_floor_records_it_and_applies_nothing() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        live(3, vec![]),
    ]));
    h.client.connect_realtime(&mut h.transport).unwrap();
    h.transport.sent.clear();
    h.client.sync_needed = false;
    // RESP_HEADER {required 3, latest 3, logEpoch e1}, LIVE_START active,
    // LIVE_END throughSeq 4; the TS client test applies the same bytes.
    let hex = "5353503204000200101100000001030000000103000000020000006531001c0500000001000000001d0c0000000400000000000000000000000000000000";
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    h.client.on_realtime_binary(&mut h.transport, &bytes);
    assert_eq!(
        h.client.schema_floor(),
        Some(&SchemaFloor {
            required_schema_version: Some(3),
            latest_schema_version: Some(3),
        })
    );
    assert_eq!(h.client.diagnostics_snapshot().unwrap().replica_cursor, 3);
    assert!(h.transport.sent.is_empty());
    assert!(!h.client.sync_needed());
}

#[test]
fn a_delta_while_no_unit_is_live_is_a_drop() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    h.client.connect_realtime(&mut h.transport).unwrap();
    h.client.sync_needed = false;
    let insert = h.commit(4, &[("tasks", Op::Upsert, &["t1", "p1", "a"], 2)]);
    h.client
        .on_realtime_binary(&mut h.transport, &response(live(4, vec![insert])));
    assert!(h.ids("tasks").is_empty());
    assert!(h.client.sync_needed());
}

// -- §7.6 diagnostics -----------------------------------------------------------

#[test]
fn units_appear_as_counts_and_reason_codes_never_ids() {
    let mut h = Harness::new();
    h.client.subscribe(p1()).unwrap();
    h.client.subscribe(p2()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        vec![
            start(&id_of(&p2()), SubStatus::Revoked, false, vec![]),
            end(-1, None),
        ],
        live(3, vec![]),
    ]));
    let snapshot = h.client.diagnostics_snapshot().unwrap();
    assert_eq!(snapshot.version, 2);
    assert_eq!(
        serde_json::to_value(&snapshot.units).unwrap(),
        json!({"bootstrapping": 0, "complete": 1, "reset": 0, "revoked": 1, "failed": 0,
            "reasonCodes": ["sync.scope_revoked"]})
    );
    assert_eq!(snapshot.active_units, 1);
    assert_eq!(snapshot.replica_cursor, 3);
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains(&id_of(&p1())));
}

// -- Rust-side bindings of the same rules ---------------------------------------

#[test]
fn integer_scope_columns_and_keys_bind_by_their_declared_type() {
    let schema = json!({"version": 1, "tables": [{"name": "counts", "primaryKey": "id",
        "columns": [{"name": "id", "type": "integer", "nullable": false},
                    {"name": "project_id", "type": "integer", "nullable": false}],
        "scopes": [{"pattern": "project:{project_id}"}]}]});
    let client = SyncClient::new("ints".into(), &schema, ClientLimits::default()).unwrap();
    client
        .conn
        .execute_batch(
            "INSERT INTO _syncular_base_counts VALUES (1,7,1), (2,7,1), (3,8,1), (4,8,1);
             INSERT INTO counts VALUES (1,7,1), (2,7,1), (3,8,1), (4,8,1);",
        )
        .unwrap();
    let seven = vec![("project_id".to_owned(), vec!["7".to_owned()])];
    assert!(client.scoped_rows_exist("counts", &seven, &[]));
    assert!(!client.scoped_rows_exist(
        "counts",
        &[("project_id".to_owned(), vec!["07".to_owned()])],
        &[]
    ));
    let pinned = HashSet::from(["3".to_owned()]);
    let (remaining, deferred) = client
        .evict_scope_rows(
            "counts",
            &[("project_id".to_owned(), vec!["8".to_owned()])],
            &[],
            &pinned,
        )
        .unwrap();
    assert!(!remaining && deferred);
    let ids: Vec<i64> = client
        .query("SELECT id FROM counts ORDER BY id", &[])
        .unwrap()
        .into_iter()
        .map(|row| row["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn a_revocation_keeps_pending_commits_another_unit_covers() {
    let mut h = Harness::new();
    let a = h.client.subscribe(p1()).unwrap();
    h.client.subscribe(org()).unwrap();
    let pages = vec![h.rows("notes", &[]), h.rows("tasks", &[])];
    let org_pages = vec![h.rows("notes", &[])];
    h.round(concat(vec![
        h.bootstrap(&p1(), 3, pages, vec![]),
        h.bootstrap(&org(), 3, org_pages, vec![]),
        live(3, vec![]),
    ]));
    let covered = h
        .client
        .mutate(vec![upsert(
            "notes",
            &[
                ("id", "n1"),
                ("project_id", "p1"),
                ("org_id", "o1"),
                ("body", "kept"),
            ],
        )])
        .unwrap();
    let doomed = h
        .client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "t1"), ("project_id", "p1"), ("title", "gone")],
        )])
        .unwrap();
    h.client.limits.max_push_commits_per_request = Some(0);
    let mut transport = Script::default();
    transport.replies.push_back(response(concat(vec![
        vec![start(&a, SubStatus::Revoked, false, vec![]), end(3, None)],
        live(3, vec![]),
    ])));
    assert!(matches!(h.client.sync(&mut transport), SyncOutcome::Ok(_)));
    assert_eq!(h.client.pending_commit_ids(), vec![covered]);
    assert_eq!(
        h.client
            .commit_outcome(&doomed)
            .unwrap()
            .map(|outcome| outcome.status),
        Some(CommitOutcomeStatus::Rejected)
    );
}

// -- §9 upgrade of a version 3 replica ------------------------------------------

/// A replica in the 0.59.0 local layout: the version 4 build's rows and outbox
/// with the version 3 registration tables and no outbox identity.
fn legacy_replica(eviction_scopes: &str) -> String {
    let path = std::env::temp_dir()
        .join(format!("syncular-v3-{}.db", uuid::Uuid::new_v4()))
        .to_string_lossy()
        .into_owned();
    let mut client = SyncClient::open_path(
        "units-client".into(),
        &schema(),
        ClientLimits::default(),
        &path,
    )
    .unwrap();
    client
        .conn
        .execute_batch(
            "INSERT INTO _syncular_base_tasks VALUES('t1','p1','kept',3),('t9','p9','pinned',1);
             INSERT INTO tasks VALUES('t1','p1','kept',3),('t9','p9','pinned',1);",
        )
        .unwrap();
    client
        .mutate(vec![upsert(
            "tasks",
            &[("id", "t9"), ("project_id", "p9"), ("title", "pinned")],
        )])
        .unwrap();
    drop(client);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!(
        "DROP TABLE _syncular_units;
         DROP TABLE _syncular_pending_evictions;
         DELETE FROM _syncular_meta WHERE key = 'outboxId';
         INSERT INTO _syncular_meta VALUES('logEpoch','e1');
         CREATE TABLE _syncular_subscriptions (
           id TEXT PRIMARY KEY, tbl TEXT NOT NULL, state_json TEXT NOT NULL);
         CREATE TABLE _syncular_window_pending_evict (
           sub_id TEXT PRIMARY KEY, tbl TEXT NOT NULL, effective_scopes TEXT NOT NULL);
         INSERT INTO _syncular_subscriptions VALUES('s1','tasks',
           '{{\"requested\":{{\"project_id\":[\"p1\",\"p2\"]}},\"cursor\":42,\"status\":\"active\"}}');
         INSERT INTO _syncular_windows VALUES('tasks' || char(0) || 'project_id' || char(0) || '{{}}','p9','w:tasks:1');
         INSERT INTO _syncular_window_pending_evict VALUES('w:tasks:1','tasks','{eviction_scopes}');"
    ))
    .unwrap();
    path
}

#[test]
fn a_version_3_replica_keeps_outbox_and_rows_drops_its_subscriptions_and_registers_units_fresh() {
    let path = legacy_replica(r#"{"project_id":["p9"]}"#);
    let client = SyncClient::open_path(
        "units-client".into(),
        &schema(),
        ClientLimits::default(),
        &path,
    )
    .unwrap();
    let mut h = Harness::over(client);
    let pending = h.client.pending_commit_ids();
    assert_eq!(pending.len(), 1);
    assert_eq!(h.ids("tasks"), vec!["t1", "t9"]);
    assert!(h.client.units().unwrap().is_empty());
    let names: Vec<String> = h
        .client
        .query(
            "SELECT name FROM sqlite_master WHERE name LIKE '_syncular_%' ORDER BY name",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|row| row["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(!names.contains(&"_syncular_subscriptions".to_owned()));
    assert!(!names.contains(&"_syncular_window_pending_evict".to_owned()));
    assert_eq!(
        h.client.load_pending_evictions().unwrap(),
        vec![(
            "w:tasks:1".to_owned(),
            "tasks".to_owned(),
            vec![("project_id".to_owned(), vec!["p9".to_owned()])]
        )]
    );
    assert!(h.client.load_window_registry().unwrap().is_empty());
    h.client.subscribe(p1()).unwrap();
    let pages = vec![
        h.rows("notes", &[]),
        h.rows("tasks", &[&["t1", "p1", "fresh"]]),
    ];
    h.round(concat(vec![
        vec![applied(&pending[0], 50)],
        h.bootstrap(&p1(), 50, pages, vec![]),
        live(50, vec![]),
    ]));
    let request = h.last().to_vec();
    assert!(matches!(
        request.first(),
        Some(Frame::ReqHeader {
            outbox_id: Some(_),
            ..
        })
    ));
    assert!(request
        .iter()
        .any(|frame| matches!(frame, Frame::PushCommit { client_seq: 1, .. })));
    assert_eq!(pull_of(&request).0, -1);
    assert_eq!(units_of(&request), vec![scope_pairs(&p1())]);
    // The carried eviction finished once the pinning commit drained.
    let rows: Vec<Value> = h
        .client
        .query("SELECT id, title FROM tasks ORDER BY id", &[])
        .unwrap()
        .into_iter()
        .map(Value::Object)
        .collect();
    assert_eq!(rows, vec![json!({"id": "t1", "title": "fresh"})]);
    drop(h);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_version_3_pending_eviction_that_cannot_be_carried_fails_loudly_before_any_write() {
    let path = legacy_replica("not json");
    let error = SyncClient::open_path(
        "units-client".into(),
        &schema(),
        ClientLimits::default(),
        &path,
    )
    .err()
    .expect("the upgrade refuses");
    assert!(error.starts_with("sync.local_corrupt"), "{error}");
    let conn = Connection::open(&path).unwrap();
    let kept: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = '_syncular_subscriptions')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(kept);
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_scope_changing_bump_deletes_the_pending_evictions_of_the_changed_table() {
    let path = std::env::temp_dir()
        .join(format!(
            "syncular-bump-evictions-{}.db",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned();
    let client = SyncClient::open_path(
        "units-client".into(),
        &schema(),
        ClientLimits::default(),
        &path,
    )
    .unwrap();
    client
        .conn
        .execute_batch(
            r#"INSERT INTO _syncular_pending_evictions(unit_id, tbl, effective_scopes) VALUES
                 ('gone-tasks', 'tasks', '{"project_id":["p1"]}'),
                 ('gone-notes', 'notes', '{"org_id":["o1"]}');"#,
        )
        .unwrap();
    drop(client);
    // §7.4.3: `tasks` changes its prefix; `notes` keeps every declaration.
    let mut bumped = schema();
    bumped["version"] = json!(2);
    bumped["tables"][0]["scopes"] = json!([{"pattern": "proj:{project_id}"}]);
    let client = SyncClient::open_path(
        "units-client".into(),
        &bumped,
        ClientLimits::default(),
        &path,
    )
    .unwrap();
    assert_eq!(
        client.load_pending_evictions().unwrap(),
        vec![(
            "gone-notes".to_owned(),
            "notes".to_owned(),
            vec![("org_id".to_owned(), vec!["o1".to_owned()])]
        )]
    );
    drop(client);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn acknowledged_intent_of_named_rows_reads_through_the_row_index() {
    let h = Harness::new();
    let plan: Vec<String> = h
        .client
        .conn
        .prepare(&format!("EXPLAIN QUERY PLAN {}", super::ACKED_ROWS_BY_ROW))
        .unwrap()
        .query_map(rusqlite::params![None::<String>, None::<String>], |row| {
            row.get::<_, String>(3)
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.contains("USING INDEX _syncular_acked_rows_row (tbl=? AND id=?)")),
        "{plan:?}"
    );
}
