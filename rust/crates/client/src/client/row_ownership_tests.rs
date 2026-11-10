//! §3.3/§4.8/§5.6 row ownership, §8.2 delta skips and typed scope binds.
use super::*;
use crate::values::encode_row_json;
use serde_json::json;

fn client() -> SyncClient {
    let schema = json!({"version":1,"tables":[
        {"name":"docs","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"org_id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false}],
         "scopes":[{"pattern":"org:{org_id}"},{"pattern":"project:{project_id}"}]},
        {"name":"counts","primaryKey":"id","columns":[
            {"name":"id","type":"integer","nullable":false},
            {"name":"project_id","type":"integer","nullable":false}],
         "scopes":[{"pattern":"project:{project_id}"}]}]});
    let client =
        SyncClient::new("ownership".into(), &schema, ClientLimits::default()).expect("client");
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    client
}

fn scopes(variable: &str, values: &[&str]) -> Vec<(String, Vec<String>)> {
    vec![(
        variable.to_owned(),
        values.iter().map(|value| (*value).to_owned()).collect(),
    )]
}

/// An active registration that completed a bootstrap at cursor 1.
fn synced(client: &mut SyncClient, id: &str, table: &str, scopes: Vec<(String, Vec<String>)>) {
    client
        .subscribe(id.into(), table.into(), scopes.clone(), None)
        .expect("subscribe");
    let sub = client
        .subs
        .iter_mut()
        .find(|sub| sub.id == id)
        .expect("sub");
    sub.cursor = 1;
    sub.synced_once = true;
    sub.effective = Some(scopes);
    let sub = sub.clone();
    client.persist_sub(&sub).expect("persist");
}

fn insert(client: &SyncClient, table: &str, rows: &str) {
    client
        .conn
        .execute_batch(&format!(
            "INSERT INTO _syncular_base_{table} VALUES {rows}; INSERT INTO {table} VALUES {rows};"
        ))
        .expect("rows");
}

fn ids(client: &SyncClient, table: &str) -> Vec<String> {
    let mut statement = client
        .conn
        .prepare(&format!("SELECT CAST(id AS TEXT) FROM {table} ORDER BY id"))
        .expect("select");
    let ids = statement
        .query_map([], |row| row.get(0))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("ids");
    ids
}

fn response(frames: Vec<Frame>) -> Vec<u8> {
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

/// Answers every round with one fixed response.
struct Reply(Vec<u8>);

impl Transport for Reply {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        Ok(self.0.clone())
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

fn revoke(id: &str) -> Vec<Frame> {
    vec![
        Frame::SubStart {
            id: id.into(),
            status: SubStatus::Revoked,
            reason_code: "sync.scope_revoked".into(),
            effective_scopes: Vec::new(),
            bootstrap: false,
        },
        Frame::SubEnd {
            next_cursor: 1,
            bootstrap_state: None,
        },
    ]
}

fn docs_window() -> WindowBase {
    WindowBase {
        table: "docs".into(),
        variable: "project_id".into(),
        fixed_scopes: Vec::new(),
        params: None,
    }
}

#[test]
fn window_eviction_keeps_rows_another_active_subscription_covers() {
    let mut client = client();
    synced(&mut client, "org", "docs", scopes("org_id", &["o1"]));
    client
        .set_window(&docs_window(), &["p1".into(), "p3".into()])
        .expect("widen");
    insert(
        &client,
        "docs",
        "('shared','o1','p1',1), ('window-only','o2','p3',1)",
    );
    client.drain_change_batches();

    client.set_window(&docs_window(), &[]).expect("shrink");

    assert_eq!(ids(&client, "docs"), vec!["shared"]);
    // The eviction map names only `project_id`; a query keyed by `org:`
    // must re-run, so the change is table-wide.
    let tables = client
        .drain_change_batches()
        .into_iter()
        .flat_map(|batch| batch.tables)
        .filter(|change| change.table == "docs")
        .map(|change| change.scope_keys)
        .collect::<Vec<_>>();
    assert!(
        !tables.is_empty() && tables.iter().all(Option::is_none),
        "{tables:?}"
    );
}

#[test]
fn a_revocation_purge_keeps_rows_another_active_subscription_covers() {
    let mut client = client();
    synced(&mut client, "org", "docs", scopes("org_id", &["o1"]));
    synced(
        &mut client,
        "project",
        "docs",
        scopes("project_id", &["p1"]),
    );
    insert(
        &client,
        "docs",
        "('shared','o1','p1',1), ('lone','o2','p1',1)",
    );

    let outcome = client.sync(&mut Reply(response(revoke("project"))));

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(
        client.subscription_state("project").expect("state").status,
        "revoked"
    );
    assert_eq!(ids(&client, "docs"), vec!["shared"]);
}

#[test]
fn a_revocation_keeps_pending_commits_another_active_subscription_covers() {
    let mut client = client();
    synced(&mut client, "org", "docs", scopes("org_id", &["o1"]));
    synced(
        &mut client,
        "project",
        "docs",
        scopes("project_id", &["p1"]),
    );
    let [shared, lone] = [("shared", "o1"), ("lone", "o2")].map(|(id, org)| {
        client
            .mutate(vec![Mutation::Upsert {
                table: "docs".into(),
                values: Map::from_iter([
                    ("id".into(), json!(id)),
                    ("org_id".into(), json!(org)),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .expect("mutate")
    });

    let outcome = client.sync(&mut Reply(response(revoke("project"))));

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(client.pending_commit_ids(), vec![shared]);
    assert_eq!(
        client
            .rejections
            .iter()
            .map(|rejection| (rejection.client_commit_id.clone(), rejection.code.clone()))
            .collect::<Vec<_>>(),
        vec![(lone, "sync.scope_revoked".to_owned())]
    );
}

#[test]
fn a_fresh_first_page_clear_keeps_rows_a_complete_subscription_owns() {
    let mut client = client();
    synced(&mut client, "org", "docs", scopes("org_id", &["o1"]));
    client
        .subscribe(
            "project".into(),
            "docs".into(),
            scopes("project_id", &["p1"]),
            None,
        )
        .expect("subscribe");
    insert(
        &client,
        "docs",
        "('held','o1','p1',1), ('stale','o2','p1',1)",
    );
    let empty = ssp2::segment::encode_rows_segment(&RowsSegment {
        table: "docs".into(),
        schema_version: 1,
        columns: client.schema.table("docs").unwrap().wire_columns.clone(),
        blocks: Vec::new(),
    });

    let outcome = client.sync(&mut Reply(response(vec![
        Frame::SubStart {
            id: "project".into(),
            status: SubStatus::Active,
            reason_code: String::new(),
            effective_scopes: scopes("project_id", &["p1"]),
            bootstrap: true,
        },
        Frame::SegmentInline { payload: empty },
        Frame::SubEnd {
            next_cursor: 1,
            bootstrap_state: None,
        },
    ])));

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(
        client.subscription_state("project").expect("state").cursor,
        1
    );
    assert_eq!(ids(&client, "docs"), vec!["held"]);
}

#[test]
fn integer_scope_columns_and_keys_bind_by_their_declared_type() {
    let mut client = client();
    synced(&mut client, "seven", "counts", scopes("project_id", &["7"]));
    insert(&client, "counts", "(1,7,1), (2,7,1), (3,8,1), (4,8,1)");
    assert!(client.scoped_rows_exist("counts", &scopes("project_id", &["7"]), &[]));
    assert!(!client.scoped_rows_exist("counts", &scopes("project_id", &["07"]), &[]));

    let outcome = client.sync(&mut Reply(response(revoke("seven"))));

    assert!(matches!(outcome, SyncOutcome::Ok(_)), "{outcome:?}");
    assert_eq!(ids(&client, "counts"), vec!["3", "4"]);
    let pinned = std::collections::HashSet::from(["3".to_owned()]);
    let (remaining, deferred) = client
        .evict_scope_rows("counts", &scopes("project_id", &["8"]), &[], &pinned)
        .expect("evict");
    assert!(!remaining && deferred);
    assert_eq!(ids(&client, "counts"), vec!["3"]);
}

#[test]
fn a_delta_for_a_reset_subscription_is_skipped_and_raises_sync_needed() {
    let mut client = client();
    synced(&mut client, "live", "docs", scopes("org_id", &["o1"]));
    synced(&mut client, "reset", "docs", scopes("org_id", &["o2"]));
    // §4.6 reset: cursor -1, no resume token, rows kept.
    let reset = client
        .subs
        .iter_mut()
        .find(|sub| sub.id == "reset")
        .unwrap();
    reset.cursor = -1;
    let reset = reset.clone();
    client.persist_sub(&reset).unwrap();
    client.sync_needed = false;
    let section = |client: &SyncClient, id: &str, org: &str| {
        let values = Map::from_iter([
            ("id".into(), Value::from(format!("d-{id}"))),
            ("org_id".into(), Value::from(org)),
            ("project_id".into(), Value::from("p1")),
        ]);
        vec![
            Frame::SubStart {
                id: id.into(),
                status: SubStatus::Active,
                reason_code: String::new(),
                effective_scopes: scopes("org_id", &[org]),
                bootstrap: false,
            },
            Frame::Commit {
                commit_seq: 2,
                actor_id: "writer".into(),
                created_at_ms: 1,
                tables: vec!["docs".into()],
                changes: vec![ssp2::model::Change {
                    table_index: 0,
                    row_id: format!("d-{id}"),
                    op: Op::Upsert,
                    row_version: Some(2),
                    scopes: vec![("org_id".into(), org.into())],
                    row: Some(
                        encode_row_json(
                            client.schema.table("docs").unwrap(),
                            &format!("d-{id}"),
                            &values,
                            &client.encryption,
                        )
                        .unwrap(),
                    ),
                }],
            },
            Frame::SubEnd {
                next_cursor: 2,
                bootstrap_state: None,
            },
        ]
    };
    let mut frames = section(&client, "live", "o1");
    frames.extend(section(&client, "reset", "o2"));

    let controls = client.on_realtime_binary_queued(&response(frames));

    assert_eq!(controls, vec!["{\"type\":\"ack\",\"cursor\":2}".to_owned()]);
    assert_eq!(ids(&client, "docs"), vec!["d-live"]);
    assert_eq!(
        client.subscription_state("reset").expect("state").cursor,
        -1
    );
    assert!(client.sync_needed, "the skipped section asks for a pull");
}

#[test]
fn evicting_a_window_unit_cancels_the_prepared_round() {
    let mut client = client();
    client
        .set_window(&docs_window(), &["p1".into()])
        .expect("widen");
    client.active_round = Some(uuid::Uuid::nil());

    client.set_window(&docs_window(), &[]).expect("shrink");

    assert_eq!(client.active_round, None);
}
