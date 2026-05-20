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

pub fn sync_conformance_i32(path: &[&str]) -> i32 {
    sync_conformance_i64(path)
        .try_into()
        .unwrap_or_else(|_| panic!("sync conformance path {path:?} must fit in i32"))
}

pub fn sync_conformance_usize(path: &[&str]) -> usize {
    sync_conformance_i64(path)
        .try_into()
        .unwrap_or_else(|_| panic!("sync conformance path {path:?} must fit in usize"))
}

pub fn sync_conformance_bytes(path: &[&str]) -> Vec<u8> {
    sync_conformance_value(path)
        .as_array()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be an array"))
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|byte| byte.try_into().ok())
                .unwrap_or_else(|| panic!("sync conformance path {path:?} must contain bytes"))
        })
        .collect()
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
