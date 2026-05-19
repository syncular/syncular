use serde_json::Value;
use std::fs;
use std::path::Path;

#[test]
fn generated_schema_json_is_the_stable_metadata_contract() {
    let codegen_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let rust_dir = codegen_dir
        .parent()
        .and_then(std::path::Path::parent)
        .expect("rust dir");

    assert_schema_contract(&rust_dir.join("crates/runtime/syncular.schema.json"));
    assert_schema_contract(&rust_dir.join("examples/todo-app/syncular.schema.json"));
}

fn assert_schema_contract(path: &Path) {
    let json: Value = serde_json::from_str(&fs::read_to_string(path).expect("read schema JSON"))
        .expect("schema JSON parses");
    assert_eq!(
        json["$schema"],
        "https://syncular.dev/schemas/syncular.schema.v1.json"
    );
    assert_eq!(json["contractVersion"], 1);

    let migrations = json["migrations"].as_array().expect("migrations array");
    assert!(!migrations.is_empty(), "schema JSON must list migrations");
    assert_eq!(
        json["appSchemaVersion"],
        migrations.last().expect("latest migration")["schemaVersion"]
    );

    let tables = json["tables"].as_array().expect("tables array");
    assert!(!tables.is_empty(), "schema JSON must list app tables");
    for table in tables {
        assert_non_empty_string(&table["name"], "table.name");
        assert_non_empty_string(&table["primaryKeyColumn"], "table.primaryKeyColumn");
        assert_non_empty_string(&table["serverVersionColumn"], "table.serverVersionColumn");
        assert!(table["columns"].is_array(), "table.columns");
        assert!(table["blobColumns"].is_array(), "table.blobColumns");
        assert!(table["encryptedFields"].is_array(), "table.encryptedFields");
        assert!(table["scopes"].is_array(), "table.scopes");
        assert_non_empty_string(&table["subscription"]["id"], "table.subscription.id");

        let columns = table["columns"].as_array().expect("columns array");
        assert!(
            columns
                .iter()
                .any(|column| column["name"] == table["primaryKeyColumn"]
                    && column["primaryKey"] == true),
            "primaryKeyColumn must reference a primary-key column"
        );
        assert!(
            columns
                .iter()
                .any(|column| column["name"] == table["serverVersionColumn"]
                    && column["serverVersion"] == true),
            "serverVersionColumn must reference a server-version column"
        );

        for column in columns {
            assert_non_empty_string(&column["name"], "column.name");
            assert_non_empty_string(&column["sqlType"], "column.sqlType");
            assert_non_empty_string(&column["typeFamily"], "column.typeFamily");
            assert_non_empty_string(&column["appType"], "column.appType");
            assert!(column["nullable"].is_boolean(), "column.nullable");
            assert!(column["primaryKey"].is_boolean(), "column.primaryKey");
            assert!(column["blobRef"].is_boolean(), "column.blobRef");
        }
    }

    let read_models = json["localReadModels"]
        .as_array()
        .expect("localReadModels array");
    for read_model in read_models {
        assert_non_empty_string(&read_model["name"], "localReadModel.name");
        assert_non_empty_string(&read_model["kind"], "localReadModel.kind");
        assert_non_empty_string(&read_model["sourceTable"], "localReadModel.sourceTable");
        assert_non_empty_string(&read_model["outputTable"], "localReadModel.outputTable");
        assert!(
            read_model["dimensions"]
                .as_array()
                .is_some_and(|values| !values.is_empty()),
            "localReadModel.dimensions"
        );
        assert_non_empty_string(&read_model["countColumn"], "localReadModel.countColumn");
        assert!(
            read_model["setupSql"]
                .as_array()
                .is_some_and(|values| !values.is_empty()),
            "localReadModel.setupSql"
        );
        assert!(
            read_model["rebuildSql"]
                .as_array()
                .is_some_and(|values| !values.is_empty()),
            "localReadModel.rebuildSql"
        );
    }
}

fn assert_non_empty_string(value: &Value, label: &str) {
    assert!(
        value.as_str().is_some_and(|value| !value.is_empty()),
        "{label} must be a non-empty string"
    );
}
