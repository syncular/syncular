use super::*;
use serde_json::json;

fn client() -> SyncClient {
    let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
        {"name":"id","type":"string","nullable":false},
        {"name":"project_id","type":"string","nullable":false}],
        "scopes":[{"pattern":"project:{project_id}"}],"indexes":[],"ftsIndexes":[]}]});
    SyncClient::new("rearm".into(), &schema, ClientLimits::default()).expect("client")
}

fn scopes() -> Vec<(String, Vec<String>)> {
    vec![("project_id".to_owned(), vec!["p1".to_owned()])]
}

/// §3.3: the stored registration carries progress the re-arm must drop.
fn store_revoked(client: &mut SyncClient) {
    client
        .subscribe("sub".into(), "tasks".into(), scopes(), None)
        .expect("subscribe");
    let sub = &mut client.subs[0];
    sub.cursor = 41;
    sub.bootstrap_state = Some("resume".to_owned());
    sub.effective = Some(scopes());
    sub.state = SubState::Revoked;
    sub.reason_code = Some("sync.scope_revoked".to_owned());
    client.persist_sub(&client.subs[0]).expect("persist");
    client.sync_needed = false;
    client.sync_intent_queue.clear();
}

#[test]
fn resubscribing_the_same_intent_rearms_a_revoked_registration() {
    let mut client = client();
    store_revoked(&mut client);

    client
        .subscribe("sub".into(), "tasks".into(), scopes(), None)
        .expect("re-arm");

    let view = client.subscription_state("sub").expect("state");
    assert_eq!(view.status, "active");
    assert_eq!(view.cursor, -1);
    assert!(!view.has_resume_token);
    assert_eq!(view.effective_scopes, None);
    assert_eq!(view.reason_code, None);
    assert!(client.sync_needed, "a re-arm asks for a pull");
    assert!(matches!(
        client.drain_sync_intents().as_slice(),
        [SyncIntent::Interactive]
    ));
    let stored: String = client
        .conn
        .query_row(
            "SELECT state_json FROM _syncular_subscriptions WHERE id = 'sub'",
            [],
            |row| row.get(0),
        )
        .expect("persisted row");
    let stored: Value = serde_json::from_str(&stored).expect("stored json");
    assert_eq!(stored["status"], json!("active"));
    assert_eq!(stored["cursor"], json!(-1));
    assert_eq!(stored["bootstrapState"], Value::Null);
    assert_eq!(stored["effectiveScopes"], Value::Null);
    assert_eq!(stored["reasonCode"], Value::Null);
}

#[test]
fn a_failed_registration_is_not_rearmed() {
    let mut client = client();
    client
        .subscribe("sub".into(), "tasks".into(), scopes(), None)
        .expect("subscribe");
    client.subs[0].state = SubState::Failed;
    client.subs[0].reason_code = Some("sync.scope_revoked".to_owned());
    client.persist_sub(&client.subs[0]).expect("persist");
    client.sync_needed = false;
    client.sync_intent_queue.clear();

    client
        .subscribe("sub".into(), "tasks".into(), scopes(), None)
        .expect("subscribe");

    let view = client.subscription_state("sub").expect("state");
    assert_eq!(view.status, "failed");
    assert_eq!(view.reason_code.as_deref(), Some("sync.scope_revoked"));
    assert!(!client.sync_needed);
    assert!(client.drain_sync_intents().is_empty());
}
