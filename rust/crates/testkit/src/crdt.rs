use serde_json::{json, Value};
use syncular_runtime::client::{CrdtFieldMaterialization, CrdtFieldWriteReceipt, SyncularClient};
use syncular_runtime::crdt_field::CrdtFieldId;
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::native::NativeSyncularClient;
use syncular_runtime::transport::SyncTransport;

pub fn crdt_field_id(
    table: impl Into<String>,
    row_id: impl Into<String>,
    field: impl Into<String>,
) -> CrdtFieldId {
    CrdtFieldId::new(table, row_id, field)
}

pub fn crdt_field_request_json(table: &str, row_id: &str, field: &str) -> String {
    json!({
        "table": table,
        "rowId": row_id,
        "field": field
    })
    .to_string()
}

pub fn crdt_field_text_request_json(
    table: &str,
    row_id: &str,
    field: &str,
    next_text: &str,
) -> String {
    json!({
        "table": table,
        "rowId": row_id,
        "field": field,
        "nextText": next_text
    })
    .to_string()
}

pub fn apply_crdt_field_text<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    table: &str,
    row_id: &str,
    field_name: &str,
    next_text: &str,
) -> CrdtFieldWriteReceipt
where
    T: SyncTransport,
{
    let field = client
        .open_crdt_field(crdt_field_id(table, row_id, field_name))
        .expect("open CRDT field");
    client
        .apply_crdt_field_text(&field, next_text)
        .expect("apply CRDT field text")
}

pub fn assert_crdt_field_materializes<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    table: &str,
    row_id: &str,
    field_name: &str,
    expected: Value,
) -> CrdtFieldMaterialization
where
    T: SyncTransport,
{
    let field = client
        .open_crdt_field(crdt_field_id(table, row_id, field_name))
        .expect("open CRDT field");
    let materialized = client
        .materialize_crdt_field(&field)
        .expect("materialize CRDT field");
    assert_eq!(materialized.value, expected, "unexpected CRDT value");
    assert!(
        !materialized.state_vector_base64.is_empty(),
        "CRDT state vector should not be empty"
    );
    materialized
}

pub fn assert_crdt_field_text_nonblank<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    table: &str,
    row_id: &str,
    field_name: &str,
) -> CrdtFieldMaterialization
where
    T: SyncTransport,
{
    let field = client
        .open_crdt_field(crdt_field_id(table, row_id, field_name))
        .expect("open CRDT field");
    let materialized = client
        .materialize_crdt_field(&field)
        .expect("materialize CRDT field");
    let text = materialized
        .value
        .as_str()
        .expect("CRDT field should materialize to text");
    assert!(!text.is_empty(), "CRDT text field should not blank");
    materialized
}

pub fn apply_native_crdt_field_text(
    client: &mut NativeSyncularClient,
    table: &str,
    row_id: &str,
    field_name: &str,
    next_text: &str,
) -> Value {
    let json = client
        .apply_crdt_field_text_json(&crdt_field_text_request_json(
            table, row_id, field_name, next_text,
        ))
        .expect("apply native CRDT field text");
    serde_json::from_str(&json).expect("native CRDT write receipt JSON")
}

pub fn assert_native_crdt_field_materializes(
    client: &mut NativeSyncularClient,
    table: &str,
    row_id: &str,
    field_name: &str,
    expected: Value,
) -> Value {
    let json = client
        .materialize_crdt_field_json(&crdt_field_request_json(table, row_id, field_name))
        .expect("materialize native CRDT field");
    let materialized: Value =
        serde_json::from_str(&json).expect("native CRDT materialization JSON");
    assert_eq!(
        materialized["value"], expected,
        "unexpected native CRDT value"
    );
    assert!(
        materialized["stateVectorBase64"]
            .as_str()
            .is_some_and(|value| !value.is_empty()),
        "native CRDT state vector should not be empty"
    );
    materialized
}
