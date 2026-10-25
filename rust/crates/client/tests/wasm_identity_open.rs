//! wasm32 conformance: a browser worker's sqlite-wasm VFS has no WAL mode.
//! The identity constructor must still open the replica there. The native
//! gate keeps the WAL requirement; this test runs in a wasm host and is
//! compiled by `cargo check --target wasm32-unknown-unknown --test ...`.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use serde_json::json;
use syncular_client::{ClientLimits, SyncClient};

#[test]
fn identity_open_accepts_a_non_wal_wasm_replica() {
    let client = SyncClient::open_path_with_identity(
        None,
        &json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false }
                ],
                "scopes": []
            }]
        }),
        ClientLimits::default(),
        ":memory:",
    )
    .expect("wasm identity open must not require WAL");
    assert!(!client.client_id().is_empty());
}
