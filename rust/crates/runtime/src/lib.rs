extern crate self as syncular_runtime;

#[path = "core/app_schema.rs"]
pub mod app_schema;
#[cfg(all(feature = "boltffi-bindings", feature = "native"))]
#[path = "bindings/boltffi.rs"]
pub mod boltffi_bindings;
#[path = "core/client.rs"]
pub mod client;
#[path = "storage/compaction.rs"]
pub mod compaction;
#[path = "core/crdt_field.rs"]
pub mod crdt_field;
#[path = "core/crdt_yjs.rs"]
pub mod crdt_yjs;
#[cfg(feature = "native")]
#[path = "storage/diesel_sqlite.rs"]
pub mod diesel_sqlite;
#[cfg(feature = "e2ee")]
#[path = "core/encrypted_crdt.rs"]
pub mod encrypted_crdt;
#[cfg(not(feature = "e2ee"))]
#[path = "core/encrypted_crdt_disabled.rs"]
pub mod encrypted_crdt;
#[cfg(feature = "e2ee")]
#[path = "core/encryption.rs"]
pub mod encryption;
#[cfg(not(feature = "e2ee"))]
#[path = "core/encryption_disabled.rs"]
pub mod encryption;
#[path = "core/error.rs"]
pub mod error;
#[cfg(feature = "demo-todo-fixture")]
pub mod fixtures;
#[cfg(feature = "native")]
#[path = "native/facade.rs"]
pub mod native;
#[cfg(feature = "native")]
#[path = "native/ffi.rs"]
pub mod native_ffi;
#[path = "core/protocol.rs"]
pub mod protocol;
#[path = "core/runtime_schema.rs"]
pub mod runtime_schema;
#[cfg(feature = "native")]
#[path = "storage/diesel_schema.rs"]
mod schema;
#[cfg(feature = "native")]
#[path = "storage/sqlite_query.rs"]
pub mod sqlite_query;
#[path = "storage/traits.rs"]
pub mod store;
pub mod transport;
#[cfg(all(feature = "web-client", target_arch = "wasm32"))]
#[path = "web/client.rs"]
pub mod web_client;
#[cfg(all(feature = "web-store", target_arch = "wasm32"))]
#[path = "web/host_store.rs"]
pub mod web_host_store;
#[cfg(all(feature = "web-owned-sqlite-core", target_arch = "wasm32"))]
#[path = "web/sqlite_wasm_store.rs"]
pub mod web_sqlite_wasm_store;
#[cfg(feature = "web-client")]
#[path = "web/store.rs"]
pub mod web_store;
#[cfg(all(feature = "web-store", target_arch = "wasm32"))]
#[path = "web/wasm.rs"]
pub mod web_wasm;
#[path = "core/worker.rs"]
pub mod worker;

#[cfg(all(target_arch = "wasm32", feature = "web-client"))]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn syncular_wasm_start() {
    use std::sync::Once;

    static INIT: Once = Once::new();
    INIT.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let location = info
                .location()
                .map(|location| {
                    format!(
                        " at {}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_default();
            web_sys::console::error_1(&wasm_bindgen::JsValue::from_str(&format!(
                "Syncular WASM panic: {info}{location}"
            )));
        }));
    });
}
