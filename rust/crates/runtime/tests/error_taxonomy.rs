use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::json;
use syncular_runtime::error::{ErrorKind, SyncularError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorTaxonomyFixture {
    version: u32,
    definitions: BTreeMap<String, ErrorDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDefinition {
    category: String,
    retryable: bool,
    recommended_action: String,
    message: String,
}

#[test]
fn rust_error_classifier_matches_core_error_taxonomy_fixture() {
    let fixture: ErrorTaxonomyFixture =
        serde_json::from_str(include_str!("fixtures/error-taxonomy-v1.json"))
            .expect("error taxonomy fixture should parse");
    assert_eq!(fixture.version, 1);

    for (code, definition) in fixture.definitions {
        let body = json!({
            "error": code,
            "code": code,
            "message": definition.message,
        });
        let error = SyncularError::message(ErrorKind::Transport, format!("server error: {body}"));
        let classification = error.classification();

        assert_eq!(classification.code, code, "{code} code should roundtrip");
        assert_eq!(
            classification.category, definition.category,
            "{code} category should match core taxonomy"
        );
        assert_eq!(
            classification.retryable, definition.retryable,
            "{code} retryability should match core taxonomy"
        );
        assert_eq!(
            classification.recommended_action, definition.recommended_action,
            "{code} recovery action should match core taxonomy"
        );
    }
}
