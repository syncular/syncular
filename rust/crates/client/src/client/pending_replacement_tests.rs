//! §7.2.3 replacing a pending commit and the §6.12 fence round, against an
//! in-process server.
use super::*;
use serde_json::json;
use syncular_authority::LocalAuthority;

fn schema() -> Value {
    json!({
        "version": 1,
        "tables": [{
            "name": "notes",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "list_id", "type": "string", "nullable": false },
                { "name": "title", "type": "string", "nullable": false },
                { "name": "body", "type": "string", "nullable": false }
            ],
            "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
        }]
    })
}

/// The server, with seams that lose a request before the server sees it or
/// lose the reply after it applied, and a canned reply in place of it.
struct Server {
    authority: LocalAuthority,
    drop_request: bool,
    drop_reply: bool,
    canned: Option<Vec<u8>>,
    requests: usize,
}

impl Transport for Server {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.requests += 1;
        if let Some(reply) = &self.canned {
            return Ok(reply.clone());
        }
        if self.drop_request {
            return Err(TransportError::new("sync.transport_failed", "request lost"));
        }
        let response = self
            .authority
            .sync(request)
            .map_err(|error| TransportError {
                code: error.code,
                message: error.message,
                details: error.details,
            })?;
        if self.drop_reply {
            return Err(TransportError::new("sync.transport_failed", "reply lost"));
        }
        Ok(response)
    }
    fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "no socket"))
    }
    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "no segments"))
    }
    fn realtime_connect(&mut self, _client_id: &str) -> Result<(), TransportError> {
        Err(TransportError::new("sync.transport_failed", "no socket"))
    }
    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }
    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn server() -> Server {
    Server {
        authority: LocalAuthority::open(":memory:", &schema()).unwrap(),
        drop_request: false,
        drop_reply: false,
        canned: None,
        requests: 0,
    }
}

fn note(id: &str, title: &str, body: &str, base_version: Option<i64>) -> Mutation {
    Mutation::Upsert {
        table: "notes".into(),
        values: Map::from_iter([
            ("id".into(), json!(id)),
            ("list_id".into(), json!("one")),
            ("title".into(), json!(title)),
            ("body".into(), json!(body)),
        ]),
        base_version,
    }
}

fn idle(client: &mut SyncClient, server: &mut Server) {
    match client.sync_until_idle(server, None) {
        SyncOutcome::Ok(_) => {}
        other => panic!("drive did not reach idle: {:?}", other.to_json()),
    }
}

/// A subscribed client that adopted the server's epoch, so its next round pushes.
fn client(server: &mut Server, id: &str) -> SyncClient {
    let mut client = SyncClient::new(id.into(), &schema(), ClientLimits::default()).unwrap();
    client
        .subscribe(UnitScopes::from([("list_id".to_owned(), "one".to_owned())]))
        .unwrap();
    idle(&mut client, server);
    client
}

fn attempted(client: &SyncClient, id: &str) -> bool {
    client
        .conn
        .query_row(
            "SELECT attempted FROM _syncular_outbox WHERE commit_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn outbox_seq(client: &SyncClient, id: &str) -> i64 {
    client
        .conn
        .query_row(
            "SELECT seq FROM _syncular_outbox WHERE commit_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn row(client: &SyncClient, id: &str) -> (Value, Value) {
    let rows = client.read_rows("notes").unwrap();
    let row = rows.iter().find(|row| row.row_id == id).expect("row");
    (row.values["title"].clone(), row.values["body"].clone())
}

/// A push whose request never reached the server: the commit is attempted.
fn lose_push(client: &mut SyncClient, server: &mut Server) {
    server.drop_request = true;
    assert!(matches!(client.sync(server), SyncOutcome::Failed { .. }));
    server.drop_request = false;
}

fn replaced_by(client: &mut SyncClient, id: &str) -> Option<String> {
    match client.commit_delivery(id).unwrap() {
        CommitDelivery::Known { outcome, .. } => {
            assert_eq!(outcome.status, CommitOutcomeStatus::Replaced);
            assert_eq!(outcome.resolution, CommitOutcomeResolution::Superseded);
            outcome.replacement_client_commit_id
        }
        other => panic!("expected a known delivery, got {other:?}"),
    }
}

#[test]
fn a_never_attempted_commit_is_replaced_in_place_without_transport() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    c.set_transport_gate(&mut server, crate::TransportGate::Closed)
        .unwrap();
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    let later = c.mutate(vec![note("n2", "later", "later", None)]).unwrap();
    assert!(!attempted(&c, &original));
    let seq = outbox_seq(&c, &original);
    c.drain_change_batches();
    let revision = c.local_revision().unwrap();
    let requests = server.requests;
    let id = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap();
    assert_eq!(id, "r1");
    assert_eq!(server.requests, requests);
    assert_eq!(c.pending_commit_ids(), vec!["r1".to_owned(), later]);
    assert_eq!(outbox_seq(&c, "r1"), seq);
    assert!(!attempted(&c, "r1"));
    assert_eq!(row(&c, "n1"), (json!("second"), json!("second")));
    assert_eq!(replaced_by(&mut c, &original).as_deref(), Some("r1"));
    assert!(matches!(
        c.commit_delivery("r1").unwrap(),
        CommitDelivery::Pending { .. }
    ));
    assert_eq!(c.drain_change_batches().len(), 1);
    assert_eq!(c.local_revision().unwrap(), revision + 1);
}

#[test]
fn a_retry_with_the_same_replacement_id_returns_it() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    let replace = |c: &mut SyncClient, server: &mut Server, replacement: &str| {
        c.replace_pending_commit(
            server,
            &original,
            vec![note("n1", "second", "second", None)],
            replacement,
        )
    };
    assert_eq!(replace(&mut c, &mut server, "r1").unwrap(), "r1");
    c.drain_change_batches();
    assert_eq!(replace(&mut c, &mut server, "r1").unwrap(), "r1");
    assert!(c.drain_change_batches().is_empty());
    assert_eq!(
        replace(&mut c, &mut server, "r2").unwrap_err().code,
        "sync.outcome_not_found"
    );
    assert_eq!(
        c.replace_pending_commit(&mut server, "r1", vec![note("n1", "x", "x", None)], "r1")
            .unwrap_err()
            .code,
        "sync.invalid_request"
    );
    assert_eq!(c.pending_commit_ids(), vec!["r1".to_owned()]);
}

#[test]
fn a_pull_round_marks_nothing_and_a_push_round_marks_what_it_carries() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    c.set_transport_gate(&mut server, crate::TransportGate::Pull)
        .unwrap();
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    assert!(matches!(c.sync(&mut server), SyncOutcome::Ok(_)));
    assert!(!attempted(&c, &original));
    c.set_transport_gate(&mut server, crate::TransportGate::Open)
        .unwrap();
    lose_push(&mut c, &mut server);
    assert!(attempted(&c, &original));
}

#[test]
fn an_attempted_commit_is_fenced_then_replaced() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let mut peer = client(&mut server, "peer");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    lose_push(&mut c, &mut server);
    c.set_transport_gate(&mut server, crate::TransportGate::Pull)
        .unwrap();
    let requests = server.requests;
    let id = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap();
    assert_eq!((id.as_str(), server.requests), ("r1", requests + 1));
    assert_eq!(replaced_by(&mut c, &original).as_deref(), Some("r1"));
    assert!(!attempted(&c, "r1"));
    c.set_transport_gate(&mut server, crate::TransportGate::Open)
        .unwrap();
    idle(&mut c, &mut server);
    assert!(c.pending_commit_ids().is_empty());
    idle(&mut peer, &mut server);
    assert_eq!(row(&peer, "n1"), (json!("second"), json!("second")));
}

#[test]
fn a_stored_receipt_settles_the_original_and_fails_the_call() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    server.drop_reply = true;
    assert!(matches!(c.sync(&mut server), SyncOutcome::Failed { .. }));
    server.drop_reply = false;
    let error = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap_err();
    assert_eq!(error.code, "client.commit_settled");
    assert_eq!(
        error.details,
        Some(json!({ "clientCommitId": original, "status": "applied" }))
    );
    assert!(c.pending_commit_ids().is_empty());
    assert_eq!(row(&c, "n1"), (json!("first"), json!("first")));
    let CommitDelivery::Known { outcome, .. } = c.commit_delivery(&original).unwrap() else {
        panic!("expected a known delivery");
    };
    assert_eq!(outcome.status, CommitOutcomeStatus::Cached);
    assert!(matches!(
        c.commit_delivery("r1").unwrap(),
        CommitDelivery::Unknown { .. }
    ));
}

#[test]
fn a_closed_gate_refuses_the_fence_and_changes_nothing() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    lose_push(&mut c, &mut server);
    c.set_transport_gate(&mut server, crate::TransportGate::Closed)
        .unwrap();
    let requests = server.requests;
    let error = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap_err();
    assert_eq!(error.code, "sync.offline");
    assert_eq!(server.requests, requests);
    assert_eq!(c.pending_commit_ids(), vec![original]);
    assert_eq!(row(&c, "n1"), (json!("first"), json!("first")));
}

#[test]
fn an_old_server_refusal_surfaces_and_replaces_nothing() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    lose_push(&mut c, &mut server);
    server.canned = Some(encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: "epoch".into(),
                reset_required: false,
            },
            Frame::Error {
                code: "sync.invalid_request".into(),
                message: "request carries neither PUSH_COMMIT nor PULL_HEADER".into(),
                category: "request".into(),
                retryable: false,
                recommended_action: String::new(),
                details: None,
            },
        ],
    }));
    let error = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap_err();
    assert_eq!(error.code, "sync.invalid_request");
    assert_eq!(c.pending_commit_ids(), vec![original.clone()]);
    assert!(attempted(&c, &original));
    assert_eq!(row(&c, "n1"), (json!("first"), json!("first")));
}

#[test]
fn a_crash_between_fence_and_replace_fences_again_on_retry() {
    let mut server = server();
    let path = std::env::temp_dir().join(format!("syncular-fence-{}.db", uuid::Uuid::new_v4()));
    let open = || {
        SyncClient::open_path(
            "c".into(),
            &schema(),
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap()
    };
    let mut c = open();
    c.subscribe(UnitScopes::from([("list_id".to_owned(), "one".to_owned())]))
        .unwrap();
    idle(&mut c, &mut server);
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    lose_push(&mut c, &mut server);
    let prepared = c
        .prepare_pending_commit_replacement(
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap()
        .expect("an attempted commit needs a fence");
    assert!(prepared.exchange(&mut server).is_ok());
    drop(prepared);
    drop(c);

    let mut c = open();
    assert_eq!(c.pending_commit_ids(), vec![original.clone()]);
    assert!(attempted(&c, &original));
    c.set_transport_gate(&mut server, crate::TransportGate::Pull)
        .unwrap();
    let id = c
        .replace_pending_commit(
            &mut server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap();
    assert_eq!(id, "r1");
    assert_eq!(c.pending_commit_ids(), vec!["r1".to_owned()]);
    drop(c);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_replacement_keeps_the_original_base_versions() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let mut peer = client(&mut server, "peer");
    peer.mutate(vec![note("n1", "first", "first", None)])
        .unwrap();
    idle(&mut peer, &mut server);
    idle(&mut c, &mut server);
    let version = c.read_rows("notes").unwrap()[0].version;
    c.set_transport_gate(&mut server, crate::TransportGate::Closed)
        .unwrap();
    let original = c
        .mutate(vec![note("n1", "mine", "mine", Some(version))])
        .unwrap();
    c.replace_pending_commit(
        &mut server,
        &original,
        vec![
            note("n1", "replaced", "replaced", None),
            note("n2", "new", "new", Some(7)),
        ],
        "r1",
    )
    .unwrap();
    let bases: Vec<_> = c.outbox[0]
        .ops
        .iter()
        .map(|op| (op.row_id.as_str(), op.base_version))
        .collect();
    assert_eq!(bases, vec![("n1", Some(version)), ("n2", Some(7))]);
}

#[test]
fn a_dependent_later_commit_re_derives_over_the_replacement() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let mut peer = client(&mut server, "peer");
    peer.mutate(vec![note("n1", "first", "first", None)])
        .unwrap();
    idle(&mut peer, &mut server);
    idle(&mut c, &mut server);
    let version = c.read_rows("notes").unwrap()[0].version;
    c.set_transport_gate(&mut server, crate::TransportGate::Closed)
        .unwrap();
    let a = c.mutate(vec![note("n1", "a", "a", Some(version))]).unwrap();
    let b = c
        .patch(
            "notes",
            "n1",
            Map::from_iter([("body".to_owned(), json!("b"))]),
            Some(version),
        )
        .unwrap();
    c.replace_pending_commit(&mut server, &a, vec![note("n1", "a2", "a2", None)], "r1")
        .unwrap();
    assert_eq!(c.pending_commit_ids(), vec!["r1".to_owned(), b.clone()]);
    assert_eq!(row(&c, "n1"), (json!("a2"), json!("b")));
    c.set_transport_gate(&mut server, crate::TransportGate::Open)
        .unwrap();
    idle(&mut c, &mut server);
    assert!(c.pending_commit_ids().is_empty());
    for id in ["r1", b.as_str()] {
        let CommitDelivery::Known { outcome, .. } = c.commit_delivery(id).unwrap() else {
            panic!("expected a known delivery");
        };
        assert_eq!(outcome.status, CommitOutcomeStatus::Applied, "{id}");
    }
    idle(&mut peer, &mut server);
    assert_eq!(row(&peer, "n1"), (json!("a2"), json!("b")));
}

#[test]
fn a_pre_upgrade_outbox_gains_the_marker_at_open_and_its_commits_read_attempted() {
    let path = std::env::temp_dir().join(format!("syncular-upgrade-{}.db", uuid::Uuid::new_v4()));
    let open = || {
        SyncClient::open_path(
            "c".into(),
            &schema(),
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap()
    };
    let mut c = open();
    let first = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    let second = c
        .mutate(vec![note("n2", "second", "second", None)])
        .unwrap();
    // The bookkeeping as a client before the send-attempt marker wrote it.
    c.conn
        .execute_batch(
            "INSERT INTO _syncular_commit_outcomes
               (client_commit_id, status, recorded_at_ms, results_json, resolution)
             VALUES ('applied', 'applied', 1, '[]', 'active'),
                    ('cached', 'cached', 2, '[]', 'dismissed'),
                    ('conflict', 'conflict', 3, '[]', 'active'),
                    ('rejected', 'rejected', 4, '[]', 'resolved_keep_server');
             CREATE TABLE old_outbox (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL DEFAULT 0);
             INSERT INTO old_outbox SELECT seq, commit_id, ops_json, created_at_ms
               FROM _syncular_outbox;
             DROP TABLE _syncular_outbox;
             ALTER TABLE old_outbox RENAME TO _syncular_outbox;",
        )
        .unwrap();
    drop(c);

    let mut c = open();
    assert_eq!(c.pending_commit_ids(), vec![first.clone(), second.clone()]);
    assert!(attempted(&c, &first) && attempted(&c, &second));
    let statuses: Vec<(String, String)> = c
        .conn
        .prepare("SELECT client_commit_id, status FROM _syncular_commit_outcomes ORDER BY seq")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        statuses,
        ["applied", "cached", "conflict", "rejected"]
            .map(|status| (status.to_owned(), status.to_owned()))
            .to_vec()
    );
    // A new commit starts unattempted.
    let third = c.mutate(vec![note("n3", "third", "third", None)]).unwrap();
    assert!(!attempted(&c, &third));
    drop(c);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_replaced_commit_is_reported_replaced_and_kept_as_a_decided_rejection() {
    let limits = ClientLimits {
        outcome_retention_max_entries: Some(1),
        ..ClientLimits::default()
    };
    let mut c = SyncClient::new("c".into(), &schema(), limits).unwrap();
    let mut transport = server();
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    c.replace_pending_commit(
        &mut transport,
        &original,
        vec![note("n1", "second", "second", None)],
        "r1",
    )
    .unwrap();
    // Stored as a decided rejection with one replaced result per operation.
    let stored = c.commit_outcome(&original).unwrap().unwrap();
    assert_eq!(stored.status, CommitOutcomeStatus::Rejected);
    assert_eq!(stored.resolution, CommitOutcomeResolution::Superseded);
    assert!(matches!(
        stored.results.as_slice(),
        [CommitOperationOutcome::Error { rejection }]
            if rejection.code == "client.commit_replaced" && !rejection.retryable
    ));
    // Reported as replaced by commitOutcomes and commitDelivery only.
    assert_eq!(replaced_by(&mut c, &original).as_deref(), Some("r1"));
    let listed = c.commit_outcomes(CommitOutcomeQuery::default()).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|outcome| (outcome.client_commit_id.as_str(), outcome.status))
            .collect::<Vec<_>>(),
        vec![(original.as_str(), CommitOutcomeStatus::Replaced)]
    );
    assert!(c
        .commit_outcomes(CommitOutcomeQuery {
            active_only: true,
            ..CommitOutcomeQuery::default()
        })
        .unwrap()
        .is_empty());
    assert!(c.conflicts().is_empty() && c.rejections().is_empty());
    let resolved = c
        .resolve_commit_outcome(ResolveCommitOutcomeInput {
            client_commit_id: original.clone(),
            resolution: CommitOutcomeResolution::ResolvedKeepServer,
            replacement_client_commit_id: None,
        })
        .unwrap();
    assert_eq!(resolved.resolution, CommitOutcomeResolution::Superseded);
    // Retention prunes it as it prunes any decided rejection.
    c.replace_pending_commit(
        &mut transport,
        "r1",
        vec![note("n1", "third", "third", None)],
        "r2",
    )
    .unwrap();
    assert!(matches!(
        c.commit_delivery(&original).unwrap(),
        CommitDelivery::Unknown { .. }
    ));
    assert_eq!(replaced_by(&mut c, "r1").as_deref(), Some("r2"));
    assert_eq!(transport.requests, 0);
}

#[test]
fn a_full_row_upsert_of_a_row_the_original_inserted_keeps_its_insert_intent() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    c.set_transport_gate(&mut server, crate::TransportGate::Closed)
        .unwrap();
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    assert!(c.outbox[0].ops[0].insert);
    c.replace_pending_commit(
        &mut server,
        &original,
        vec![note("n1", "second", "second", None)],
        "r1",
    )
    .unwrap();
    assert!(c.outbox[0].ops[0].insert);
}

#[test]
fn a_header_only_fence_response_records_a_schema_floor_or_refuses_a_reset() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let original = c.mutate(vec![note("n1", "first", "first", None)]).unwrap();
    lose_push(&mut c, &mut server);
    let header_only = |required_schema_version: Option<i32>, reset_required: bool| {
        encode_message(&Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version,
                latest_schema_version: required_schema_version,
                log_epoch: "epoch".into(),
                reset_required,
            }],
        })
    };
    let replace = |c: &mut SyncClient, server: &mut Server| {
        c.replace_pending_commit(
            server,
            &original,
            vec![note("n1", "second", "second", None)],
            "r1",
        )
        .unwrap_err()
        .code
    };
    server.canned = Some(header_only(None, true));
    assert_eq!(replace(&mut c, &mut server), "client.invalid_host_response");
    assert!(c.schema_floor().is_none());
    server.canned = Some(header_only(Some(2), false));
    assert_eq!(replace(&mut c, &mut server), "sync.schema_mismatch");
    assert_eq!(
        c.schema_floor()
            .and_then(|floor| floor.required_schema_version),
        Some(2)
    );
    assert_eq!(c.pending_commit_ids(), vec![original.clone()]);
    assert_eq!(row(&c, "n1"), (json!("first"), json!("first")));
}

fn through(c: &mut SyncClient, server: &mut Server, id: &str) {
    let gate = crate::TransportGate::Through(id.to_owned());
    c.set_transport_gate(server, gate).unwrap();
}

/// A subscribed client whose push request carries one commit.
fn capped_client(server: &mut Server, id: &str) -> SyncClient {
    let limits = ClientLimits {
        max_push_commits_per_request: Some(1),
        ..ClientLimits::default()
    };
    let mut client = SyncClient::new(id.into(), &schema(), limits).unwrap();
    let scopes = UnitScopes::from([("list_id".to_owned(), "one".to_owned())]);
    client.subscribe(scopes).unwrap();
    idle(&mut client, server);
    client
}

/// Three commits queued under `pull`, the second named as the boundary.
fn queued(c: &mut SyncClient, server: &mut Server) -> (String, String, String) {
    c.set_transport_gate(server, crate::TransportGate::Pull)
        .unwrap();
    let a = c.mutate(vec![note("n1", "a", "a", None)]).unwrap();
    let b = c.mutate(vec![note("n2", "b", "b", None)]).unwrap();
    let later = c.mutate(vec![note("n3", "later", "later", None)]).unwrap();
    c.drain_sync_intents();
    through(c, server, &b);
    (a, b, later)
}

fn deferred(c: &mut SyncClient, server: &mut Server) -> usize {
    match c.sync(server) {
        SyncOutcome::Ok(report) => report.deferred_commits,
        other => panic!("round failed: {:?}", other.to_json()),
    }
}

#[test]
fn a_through_gate_pushes_its_prefix_and_the_boundary_ack_ends_it() {
    let mut server = server();
    let mut c = capped_client(&mut server, "c");
    let (_, b, later) = queued(&mut c, &mut server);
    let intents = c.drain_sync_intents();
    assert!(matches!(intents.as_slice(), [SyncIntent::Interactive]));
    through(&mut c, &mut server, &b);
    assert!(c.drain_sync_intents().is_empty());
    // The cap carries one commit; the deferred count covers the prefix only.
    assert_eq!(deferred(&mut c, &mut server), 1);
    assert_eq!(c.pending_commit_ids(), vec![b.clone(), later.clone()]);
    assert_eq!(c.transport_gate(), crate::TransportGate::Through(b.clone()));
    assert_eq!(deferred(&mut c, &mut server), 0);
    assert_eq!(c.pending_commit_ids(), vec![later.clone()]);
    assert!(!attempted(&c, &later));
    assert_eq!(c.transport_gate(), crate::TransportGate::Pull);
    idle(&mut c, &mut server);
    assert_eq!(c.pending_commit_ids(), vec![later]);
}

#[test]
fn a_through_gate_needs_a_pending_commit() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    c.set_transport_gate(&mut server, crate::TransportGate::Pull)
        .unwrap();
    c.drain_sync_intents();
    let gate = crate::TransportGate::Through("missing".into());
    let error = c.set_transport_gate(&mut server, gate).unwrap_err();
    assert_eq!(error.code, "sync.outcome_not_found");
    assert_eq!(error.details, Some(json!({ "clientCommitId": "missing" })));
    assert_eq!(c.transport_gate(), crate::TransportGate::Pull);
    assert!(c.drain_sync_intents().is_empty());
}

#[test]
fn a_rejected_prefix_commit_ends_the_gate() {
    let mut server = server();
    let mut c = capped_client(&mut server, "c");
    let mut peer = client(&mut server, "peer");
    peer.mutate(vec![note("n1", "first", "first", None)])
        .unwrap();
    idle(&mut peer, &mut server);
    idle(&mut c, &mut server);
    let version = c.read_rows("notes").unwrap()[0].version;
    peer.mutate(vec![note("n1", "second", "second", Some(version))])
        .unwrap();
    idle(&mut peer, &mut server);
    c.set_transport_gate(&mut server, crate::TransportGate::Pull)
        .unwrap();
    let stale = c
        .mutate(vec![note("n1", "mine", "mine", Some(version))])
        .unwrap();
    let b = c.mutate(vec![note("n2", "b", "b", None)]).unwrap();
    through(&mut c, &mut server, &b);
    // The round carries only the stale commit, which the server rejects.
    deferred(&mut c, &mut server);
    assert!(!c.pending_commit_ids().contains(&stale));
    assert_eq!(c.transport_gate(), crate::TransportGate::Pull);
    assert_eq!(c.pending_commit_ids(), vec![b.clone()]);
    assert!(!attempted(&c, &b));
}

#[test]
fn a_prefix_sent_without_a_receipt_ends_the_gate_and_stays_pending() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let (a, b, later) = queued(&mut c, &mut server);
    server.drop_reply = true;
    assert!(matches!(c.sync(&mut server), SyncOutcome::Failed { .. }));
    server.drop_reply = false;
    assert_eq!(c.transport_gate(), crate::TransportGate::Pull);
    let pending = vec![a.clone(), b.clone(), later.clone()];
    assert_eq!(c.pending_commit_ids(), pending);
    assert!(attempted(&c, &a) && attempted(&c, &b) && !attempted(&c, &later));
}

#[test]
fn replacing_a_prefix_commit_ends_the_gate_and_a_failed_replacement_keeps_it() {
    let mut server = server();
    let mut c = client(&mut server, "c");
    let (a, b, later) = queued(&mut c, &mut server);
    let replacement = || vec![note("n1", "replaced", "replaced", None)];
    let refuse = "CREATE TEMP TRIGGER refuse_outcomes BEFORE INSERT ON _syncular_commit_outcomes
                  BEGIN SELECT RAISE(ABORT, 'refused'); END";
    c.conn.execute_batch(refuse).unwrap();
    let failed = c.replace_pending_commit(&mut server, &a, replacement(), "r1");
    assert!(failed.is_err());
    assert_eq!(c.transport_gate(), crate::TransportGate::Through(b.clone()));
    let pending = vec![a.clone(), b.clone(), later.clone()];
    assert_eq!(c.pending_commit_ids(), pending);
    c.conn
        .execute_batch("DROP TRIGGER refuse_outcomes")
        .unwrap();
    let id = c.replace_pending_commit(&mut server, &a, replacement(), "r1");
    assert_eq!(id.unwrap(), "r1");
    assert_eq!(c.transport_gate(), crate::TransportGate::Pull);
    assert_eq!(c.pending_commit_ids(), vec!["r1".to_owned(), b, later]);
}
