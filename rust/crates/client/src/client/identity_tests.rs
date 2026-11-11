//! §1.5 client identity: a refused id surfaces its recommended action, and a
//! rotated id persists into the next request.
use super::*;
use crate::native_transport::HostTransport;
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
        .subscribe(UnitScopes::from([(
            "project_id".to_owned(),
            "p1".to_owned(),
        )]))
        .unwrap();
    let (message, _) = client.build_request(false).unwrap();
    assert!(matches!(
        message.frames.first(),
        Some(Frame::ReqHeader { client_id, .. }) if client_id == &next
    ));
}
