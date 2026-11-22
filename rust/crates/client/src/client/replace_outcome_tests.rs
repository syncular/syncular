//! §7.2.2 replacement on a proven base, against an in-process server.
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

struct Server(LocalAuthority);

impl Transport for Server {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.0.sync(request).map_err(|error| TransportError {
            code: error.code,
            message: error.message,
            details: error.details,
        })
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

/// §2.1: a fresh replica adopts the epoch in its first round and applies its
/// unit's bootstrap from the same response; its outbox pushes next round.
#[test]
fn a_fresh_replica_adopts_the_epoch_and_bootstraps_in_one_round() {
    let mut server = Server(LocalAuthority::open(":memory:", &schema()).unwrap());
    let scopes = UnitScopes::from([("list_id".to_owned(), "one".to_owned())]);
    let mut peer = SyncClient::new("peer".into(), &schema(), ClientLimits::default()).unwrap();
    peer.subscribe(scopes.clone()).unwrap();
    peer.mutate(vec![Mutation::Upsert {
        table: "notes".into(),
        values: Map::from_iter([
            ("id".into(), json!("n1")),
            ("list_id".into(), json!("one")),
            ("title".into(), json!("first")),
            ("body".into(), json!("first")),
        ]),
        base_version: None,
    }])
    .unwrap();
    idle(&mut peer, &mut server);
    let mut fresh = SyncClient::new("fresh".into(), &schema(), ClientLimits::default()).unwrap();
    fresh.subscribe(scopes).unwrap();
    let id = fresh
        .mutate(vec![Mutation::Upsert {
            table: "notes".into(),
            values: Map::from_iter([
                ("id".into(), json!("n2")),
                ("list_id".into(), json!("one")),
                ("title".into(), json!("mine")),
                ("body".into(), json!("mine")),
            ]),
            base_version: None,
        }])
        .unwrap();
    let SyncOutcome::Ok(report) = fresh.sync(&mut server) else {
        panic!("the adoption round failed");
    };
    assert_eq!((report.pushed, report.resets.len()), (0, 0));
    assert!(fresh.get_meta(LOG_EPOCH_KEY).unwrap().is_some());
    assert_eq!(fresh.read_rows("notes").unwrap().len(), 2);
    assert_eq!(fresh.pending_commit_ids(), vec![id.clone()]);
    idle(&mut fresh, &mut server);
    assert!(fresh.pending_commit_ids().is_empty());
}

/// A server, a peer that writes ahead, and a reader whose patch conflicts.
struct Setup {
    server: Server,
    peer: SyncClient,
    reader: SyncClient,
    path: std::path::PathBuf,
    outcome: CommitOutcome,
}

fn open_reader(path: &std::path::Path) -> SyncClient {
    let mut reader = SyncClient::open_path(
        "reader".into(),
        &schema(),
        ClientLimits::default(),
        path.to_str().unwrap(),
    )
    .unwrap();
    reader.set_retain_failed_commits(true).unwrap();
    reader
}

fn idle(client: &mut SyncClient, server: &mut Server) -> SyncReport {
    match client.sync_until_idle(server, None) {
        SyncOutcome::Ok(report) => report,
        other => panic!("drive did not reach idle: {:?}", other.to_json()),
    }
}

fn patch(client: &mut SyncClient, column: &str, value: &str, base: Option<i64>) -> String {
    client
        .patch(
            "notes",
            "n1",
            Map::from_iter([(column.to_owned(), json!(value))]),
            base,
        )
        .unwrap()
}

fn row(client: &SyncClient) -> (i64, Value, Value) {
    let rows = client.read_rows("notes").unwrap();
    assert_eq!(rows.len(), 1);
    (
        rows[0].version,
        rows[0].values["title"].clone(),
        rows[0].values["body"].clone(),
    )
}

fn setup() -> Setup {
    let mut server = Server(LocalAuthority::open(":memory:", &schema()).unwrap());
    let path = std::env::temp_dir().join(format!("syncular-replace-{}.db", uuid::Uuid::new_v4()));
    let mut peer = SyncClient::new("peer".into(), &schema(), ClientLimits::default()).unwrap();
    let mut reader = open_reader(&path);
    for client in [&mut peer, &mut reader] {
        client
            .subscribe(UnitScopes::from([("list_id".to_owned(), "one".to_owned())]))
            .unwrap();
    }
    peer.mutate(vec![Mutation::Upsert {
        table: "notes".into(),
        values: Map::from_iter([
            ("id".into(), json!("n1")),
            ("list_id".into(), json!("one")),
            ("title".into(), json!("first")),
            ("body".into(), json!("first")),
        ]),
        base_version: None,
    }])
    .unwrap();
    idle(&mut peer, &mut server);
    idle(&mut reader, &mut server);
    let (base, ..) = row(&reader);
    patch(&mut peer, "body", "peer", None);
    idle(&mut peer, &mut server);
    let id = patch(&mut reader, "body", "mine", Some(base));
    idle(&mut reader, &mut server);
    // §7.5: the owner's delivery read carries the retained rows that the
    // keep-mine scenarios below rely on.
    let CommitDelivery::Known { outcome, .. } = reader.commit_delivery(&id).unwrap() else {
        panic!("expected a known delivery");
    };
    assert_eq!(outcome.status, CommitOutcomeStatus::Conflict);
    assert!(outcome.retained_rows.is_some());
    Setup {
        server,
        peer,
        reader,
        path,
        outcome,
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn gate(s: &mut Setup, state: crate::TransportGate) {
    s.reader.set_transport_gate(&mut s.server, state).unwrap();
}

fn replace(s: &mut Setup, replacement: Option<Vec<Mutation>>) -> Result<String, ClientError> {
    let (id, sequence) = (s.outcome.client_commit_id.clone(), s.outcome.sequence);
    s.reader.replace_commit_outcome(&id, sequence, replacement)
}

fn pending_operations(client: &SyncClient) -> Vec<Value> {
    client
        .outbox
        .iter()
        .map(|commit| {
            json!({
                "id": commit.client_commit_id,
                "ops": commit.ops.iter().map(CommitOperation::from).collect::<Vec<_>>(),
            })
        })
        .collect()
}

#[test]
fn keep_mine_offline_stays_pending_then_the_next_drive_writes_it() {
    let mut s = setup();
    gate(&mut s, crate::TransportGate::Closed);
    let replacement = replace(&mut s, None).unwrap();
    let current = s
        .reader
        .commit_outcome(&s.outcome.client_commit_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.resolution, CommitOutcomeResolution::Active);
    assert_eq!(
        current.replacement_client_commit_id.as_deref(),
        Some(replacement.as_str())
    );
    let server_version = s.outcome.retained_rows.as_ref().unwrap()[0]
        .server_version
        .unwrap();
    assert_eq!(
        pending_operations(&s.reader),
        vec![json!({
            "id": replacement,
            "ops": [{
                "table": "notes", "rowId": "n1", "op": "upsert",
                "baseVersion": server_version,
                "values": { "id": "n1", "body": "mine" }
            }]
        })]
    );
    let resolved = s.reader.resolve_commit_outcome(ResolveCommitOutcomeInput {
        client_commit_id: s.outcome.client_commit_id.clone(),
        resolution: CommitOutcomeResolution::ResolvedKeepServer,
        replacement_client_commit_id: None,
    });
    assert!(resolved
        .unwrap_err()
        .starts_with("client.replacement_pending:"));
    assert_eq!(
        replace(&mut s, None).unwrap_err().code,
        "client.replacement_pending"
    );

    // A later write of the same row queues behind the held replacement.
    patch(&mut s.reader, "body", "later", None);
    gate(&mut s, crate::TransportGate::Open);
    idle(&mut s.reader, &mut s.server);
    let current = s
        .reader
        .commit_outcome(&s.outcome.client_commit_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.resolution, CommitOutcomeResolution::Superseded);
    assert_eq!(
        current.replacement_client_commit_id.as_deref(),
        Some(replacement.as_str())
    );
    assert_eq!(
        s.reader
            .commit_outcome(&replacement)
            .unwrap()
            .unwrap()
            .status,
        CommitOutcomeStatus::Applied
    );
    assert!(s.reader.pending_commit_ids().is_empty());
    assert_eq!(row(&s.reader).1, json!("first"));
    assert_eq!(row(&s.reader).2, json!("later"));
    idle(&mut s.peer, &mut s.server);
    assert_eq!(row(&s.peer).2, json!("later"));
}

#[test]
fn a_held_replacement_and_every_later_commit_stay_out_of_the_push() {
    let mut s = setup();
    let replacement = replace(&mut s, None).unwrap();
    let later = patch(&mut s.reader, "title", "later", None);
    let decisions = s.reader.prepare_replacements().unwrap();
    assert_eq!(decisions.len(), 1);
    // The round pushes nothing and does not ask for another one.
    let prepared = match s.reader.prepare_sync_round(false) {
        Ok(prepared) => prepared,
        Err(outcome) => panic!("{:?}", outcome.to_json()),
    };
    assert!(prepared.meta.pushed_ids.is_empty());
    assert_eq!(prepared.meta.deferred_commits, 0);
    drop(prepared);
    assert_eq!(s.reader.pending_commit_ids(), vec![replacement, later]);
}

#[test]
fn a_pending_replacement_payload_survives_a_restart() {
    let mut s = setup();
    gate(&mut s, crate::TransportGate::Closed);
    let replacement = replace(
        &mut s,
        Some(vec![Mutation::Patch {
            table: "notes".into(),
            values: Map::from_iter([("id".into(), json!("n1")), ("body".into(), json!("edited"))]),
            base_version: None,
        }]),
    )
    .unwrap();
    assert_eq!(row(&s.reader).2, json!("edited"));
    s.reader = SyncClient::new("placeholder".into(), &schema(), ClientLimits::default()).unwrap();
    s.reader = open_reader(&s.path);
    let current = s
        .reader
        .commit_outcome(&s.outcome.client_commit_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.resolution, CommitOutcomeResolution::Active);
    assert_eq!(
        current.replacement_client_commit_id.as_deref(),
        Some(replacement.as_str())
    );
    assert_eq!(row(&s.reader).2, json!("edited"));
    idle(&mut s.reader, &mut s.server);
    assert_eq!(
        s.reader
            .commit_outcome(&replacement)
            .unwrap()
            .unwrap()
            .status,
        CommitOutcomeStatus::Applied
    );
    assert_eq!(row(&s.reader).1, json!("first"));
    assert_eq!(row(&s.reader).2, json!("edited"));
}

#[test]
fn a_base_that_moves_before_the_proof_refuses_the_decision() {
    let mut s = setup();
    gate(&mut s, crate::TransportGate::Closed);
    let replacement = replace(&mut s, None).unwrap();
    patch(&mut s.peer, "title", "newer", None);
    idle(&mut s.peer, &mut s.server);
    gate(&mut s, crate::TransportGate::Open);
    idle(&mut s.reader, &mut s.server);
    let current = s
        .reader
        .commit_outcome(&s.outcome.client_commit_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.resolution, CommitOutcomeResolution::Superseded);
    assert_eq!(
        current.replacement_client_commit_id.as_deref(),
        Some(replacement.as_str())
    );
    let refused = s.reader.commit_outcome(&replacement).unwrap().unwrap();
    assert_eq!(refused.status, CommitOutcomeStatus::Rejected);
    assert_eq!(refused.resolution, CommitOutcomeResolution::Active);
    let CommitOperationOutcome::Error { rejection } = &refused.results[0] else {
        panic!("{:?}", refused.results);
    };
    assert_eq!(rejection.code, "sync.replacement_refused");
    assert!(!rejection.retryable);
    assert_eq!(
        rejection.details.as_ref().and_then(|d| d.reason.as_deref()),
        Some("base_moved")
    );
    let retained = &refused.retained_rows.as_ref().unwrap()[0];
    let (version, ..) = row(&s.peer);
    assert_eq!(retained.server_version, Some(version));
    let local = retained.local_row.as_ref().unwrap();
    let server = retained.server_row.as_ref().unwrap();
    assert_eq!(
        (&local["title"], &local["body"]),
        (&json!("newer"), &json!("mine"))
    );
    assert_eq!(
        (&server["title"], &server["body"]),
        (&json!("newer"), &json!("peer"))
    );
    // The payload stays visible; the server keeps the peer's row.
    assert_eq!(row(&s.reader).1, json!("newer"));
    assert_eq!(row(&s.reader).2, json!("mine"));
    assert!(s.reader.pending_commit_ids().is_empty());

    // Deciding again against the fresh base writes it.
    let second = s
        .reader
        .replace_commit_outcome(&replacement, refused.sequence, None)
        .unwrap();
    idle(&mut s.reader, &mut s.server);
    assert_eq!(
        s.reader.commit_outcome(&second).unwrap().unwrap().status,
        CommitOutcomeStatus::Applied
    );
    idle(&mut s.peer, &mut s.server);
    assert_eq!(row(&s.peer).1, json!("newer"));
    assert_eq!(row(&s.peer).2, json!("mine"));
}

#[test]
fn a_payload_names_no_base_version_for_a_retained_row() {
    let mut s = setup();
    let error = replace(
        &mut s,
        Some(vec![Mutation::Patch {
            table: "notes".into(),
            values: Map::from_iter([("id".into(), json!("n1")), ("body".into(), json!("x"))]),
            base_version: Some(1),
        }]),
    )
    .unwrap_err();
    assert_eq!(error.code, "sync.invalid_request");
    let id = s.outcome.client_commit_id.clone();
    assert_eq!(
        s.reader
            .replace_commit_outcome(&id, -1, None)
            .unwrap_err()
            .code,
        "sync.invalid_request"
    );
    assert_eq!(
        s.reader
            .replace_commit_outcome("none", 1, None)
            .unwrap_err()
            .code,
        "sync.outcome_not_found"
    );
    assert!(s.reader.pending_commit_ids().is_empty());
}

#[test]
fn a_registration_change_during_the_drive_keeps_the_decision_pending() {
    let mut s = setup();
    let replacement = replace(&mut s, None).unwrap();
    let decisions = s.reader.prepare_replacements().unwrap();
    s.reader
        .subscribe(UnitScopes::from([("list_id".to_owned(), "two".to_owned())]))
        .unwrap();
    let drive = s.reader.sync(&mut s.server);
    assert!(!s.reader.settle_replacements(&decisions, &drive).unwrap());
    let current = s
        .reader
        .commit_outcome(&s.outcome.client_commit_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.resolution, CommitOutcomeResolution::Active);
    idle(&mut s.reader, &mut s.server);
    assert_eq!(
        s.reader
            .commit_outcome(&replacement)
            .unwrap()
            .unwrap()
            .status,
        CommitOutcomeStatus::Applied
    );
}

/// §6.7 `notes` with a nullable `label`, server-owned when `owned`.
fn labeled(owned: bool, version: i32) -> Value {
    json!({
        "version": version,
        "tables": [{
            "name": "notes",
            "primaryKey": "id",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "list_id", "type": "string", "nullable": false },
                { "name": "label", "type": "string", "nullable": true, "serverOwned": owned }
            ],
            "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
        }]
    })
}

fn labels(client: &SyncClient) -> Vec<(i64, Value)> {
    client
        .read_rows("notes")
        .unwrap()
        .into_iter()
        .map(|row| (row.version, row.values["label"].clone()))
        .collect()
}

fn write_label(client: &mut SyncClient, label: &str) {
    client
        .mutate(vec![Mutation::Upsert {
            table: "notes".into(),
            values: Map::from_iter([
                ("id".into(), json!("n1")),
                ("list_id".into(), json!("one")),
                ("label".into(), json!(label)),
            ]),
            base_version: None,
        }])
        .unwrap();
}

/// §6.7: the server stores a value the client did not push (here an older
/// client writes a column the server owns) and the delivered change
/// replaces the acknowledged intent.
#[test]
fn the_mirror_takes_the_stored_row_over_the_pushed_values() {
    let mut server = Server(LocalAuthority::open(":memory:", &labeled(true, 1)).unwrap());
    let mut client =
        SyncClient::new("old".into(), &labeled(false, 1), ClientLimits::default()).unwrap();
    client
        .subscribe(UnitScopes::from([("list_id".to_owned(), "one".to_owned())]))
        .unwrap();
    write_label(&mut client, "written");
    idle(&mut client, &mut server);
    assert_eq!(labels(&client), vec![(1, Value::Null)]);
    client
        .patch(
            "notes",
            "n1",
            Map::from_iter([("label".to_owned(), json!("patched"))]),
            None,
        )
        .unwrap();
    idle(&mut client, &mut server);
    assert_eq!(labels(&client), vec![(2, Value::Null)]);
}

/// §7.1, §7.4.4: a patch acknowledged after a schema-bump reset carries no
/// scope column and has no base row to merge over; the completed bootstrap
/// still covers it through the bootstrapped row.
#[test]
fn a_bootstrap_covers_a_patch_acknowledged_after_a_schema_bump_reset() {
    let dir = std::env::temp_dir();
    let id = uuid::Uuid::new_v4();
    let server_path = dir.join(format!("syncular-owned-server-{id}.db"));
    let client_path = dir.join(format!("syncular-owned-client-{id}.db"));
    let open = |owned, version| {
        let mut client = SyncClient::open_path(
            "c".into(),
            &labeled(owned, version),
            ClientLimits::default(),
            client_path.to_str().unwrap(),
        )
        .unwrap();
        client
            .subscribe(UnitScopes::from([("list_id".to_owned(), "one".to_owned())]))
            .unwrap();
        client
    };
    let mut server =
        Server(LocalAuthority::open(server_path.to_str().unwrap(), &labeled(false, 1)).unwrap());
    let mut client = open(false, 1);
    write_label(&mut client, "written");
    idle(&mut client, &mut server);
    client
        .patch(
            "notes",
            "n1",
            Map::from_iter([("label".to_owned(), json!("patched"))]),
            None,
        )
        .unwrap();
    drop((client, server));
    let mut server =
        Server(LocalAuthority::open(server_path.to_str().unwrap(), &labeled(true, 2)).unwrap());
    let mut client = open(true, 2);
    idle(&mut client, &mut server);
    assert_eq!(labels(&client), vec![(2, json!("written"))]);
    drop((client, server));
    for path in [server_path, client_path] {
        let _ = std::fs::remove_file(path);
    }
}
