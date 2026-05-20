use serde_json::Value;

pub fn sync_conformance() -> Value {
    serde_json::from_str(include_str!(
        "../../../examples/todo-app/conformance/sync-scenarios.json"
    ))
    .expect("sync conformance JSON")
}

pub fn sync_conformance_str(path: &[&str]) -> String {
    sync_conformance_value(path)
        .as_str()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be a string"))
        .to_string()
}

pub fn sync_conformance_i64(path: &[&str]) -> i64 {
    sync_conformance_value(path)
        .as_i64()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be an integer"))
}

pub fn sync_conformance_value(path: &[&str]) -> Value {
    let mut value = sync_conformance();
    for segment in path {
        value = value
            .get(segment)
            .unwrap_or_else(|| panic!("missing sync conformance path {path:?}"))
            .clone();
    }
    value
}
