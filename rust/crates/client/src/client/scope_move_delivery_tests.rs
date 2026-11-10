use super::*;
use crate::native_transport::HostTransport;
use crate::values::encode_row_json;
use serde_json::json;

fn client() -> SyncClient {
    SyncClient::new(
        "scope-move".to_owned(),
        &json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        }),
        ClientLimits::default(),
    )
    .expect("test client")
}

fn upsert(client: &SyncClient, project: &str) -> ssp2::model::Change {
    ssp2::model::Change {
        table_index: 0,
        row_id: "t1".to_owned(),
        op: Op::Upsert,
        row_version: Some(1),
        scopes: vec![("project_id".to_owned(), project.to_owned())],
        row: Some(
            encode_row_json(
                client.schema.table("tasks").unwrap(),
                "t1",
                &Map::from_iter([
                    ("id".to_owned(), Value::from("t1")),
                    ("project_id".to_owned(), Value::from(project)),
                ]),
                &client.encryption,
            )
            .unwrap(),
        ),
    }
}

fn delete(project: &str) -> ssp2::model::Change {
    ssp2::model::Change {
        table_index: 0,
        row_id: "t1".to_owned(),
        op: Op::Delete,
        row_version: None,
        scopes: vec![("project_id".to_owned(), project.to_owned())],
        row: None,
    }
}

#[test]
fn a_scope_move_keeps_the_row_in_either_section_order() {
    for order in [["old", "new"], ["new", "old"]] {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
        client
            .subscribe(
                "old".into(),
                "tasks".into(),
                vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                None,
            )
            .unwrap();
        client
            .subscribe(
                "new".into(),
                "tasks".into(),
                vec![("project_id".to_owned(), vec!["p2".to_owned()])],
                None,
            )
            .unwrap();
        let seed = upsert(&client, "p1");
        client
            .apply_commit_frame(&["tasks".into()], &[seed], Some(1))
            .unwrap();
        assert_eq!(
            client.query("SELECT project_id FROM tasks", &[]).unwrap()[0]["project_id"],
            json!("p1")
        );

        let mut frames = vec![Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: "epoch-1".to_owned(),
            reset_required: false,
        }];
        for id in order {
            let project = if id == "old" { "p1" } else { "p2" };
            frames.push(Frame::SubStart {
                id: id.to_owned(),
                status: SubStatus::Active,
                reason_code: String::new(),
                effective_scopes: vec![("project_id".to_owned(), vec![project.to_owned()])],
                bootstrap: false,
            });
            frames.push(Frame::Commit {
                commit_seq: 2,
                created_at_ms: 0,
                actor_id: "actor".to_owned(),
                tables: vec!["tasks".to_owned()],
                changes: vec![if id == "old" {
                    delete("p1")
                } else {
                    upsert(&client, "p2")
                }],
            });
            frames.push(Frame::SubEnd {
                next_cursor: 2,
                bootstrap_state: None,
            });
        }
        let (_, meta) = client.build_request(false).unwrap();
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        let outcome = client.process_response(
            &mut transport,
            Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames,
            },
            &meta,
        );
        assert!(
            matches!(outcome, SyncOutcome::Ok(_)),
            "{order:?}: {outcome:?}"
        );
        let rows = client
            .query("SELECT id, project_id FROM tasks", &[])
            .unwrap();
        assert_eq!(rows.len(), 1, "{order:?}: the row was lost");
        assert_eq!(rows[0]["project_id"], json!("p2"), "{order:?}");
    }
}

struct RefusalTransport;

impl Transport for RefusalTransport {
    fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let mut error = TransportError::new(
            "sync.invalid_client_id",
            "clientId is bound to a different actor in this partition",
        );
        error.details = Some(json!({
            "causeKind": "status",
            "httpStatus": 400,
            "category": "invalid-request",
            "retryable": false,
            "recommendedAction": "resetClientId"
        }));
        Err(error)
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

#[test]
fn an_http_refusal_carries_its_code_and_recommended_action() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let outcome = client.sync(&mut RefusalTransport);
    let SyncOutcome::Failed {
        error_code,
        recommended_action,
        details,
        ..
    } = outcome
    else {
        panic!("expected a failed round");
    };
    assert_eq!(error_code, "sync.invalid_client_id");
    assert_eq!(recommended_action.as_deref(), Some("resetClientId"));
    assert_eq!(
        details
            .as_ref()
            .and_then(|details| details.get("httpStatus")),
        Some(&json!(400))
    );
}

#[test]
fn reset_client_id_persists_and_changes_the_request_identity() {
    let mut client = client();
    client.set_meta(LOG_EPOCH_KEY, "epoch-1").unwrap();
    let previous = client.client_id().to_owned();
    let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
    let next = client.reset_client_id(&mut transport).unwrap();
    assert_ne!(next, previous);
    assert_eq!(client.client_id(), next);
    assert_eq!(client.get_meta(CLIENT_ID_KEY).unwrap(), Some(next.clone()));

    client
        .subscribe(
            "tasks".into(),
            "tasks".into(),
            vec![("project_id".to_owned(), vec!["p1".to_owned()])],
            None,
        )
        .unwrap();
    let (message, _) = client.build_request(false).unwrap();
    assert!(matches!(
        message.frames.first(),
        Some(Frame::ReqHeader { client_id, .. }) if client_id == &next
    ));
}
