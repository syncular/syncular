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

    let local_base = json["localBaseSchema"]
        .as_object()
        .expect("localBaseSchema object");
    let table_setup_sql = local_base["tableSetupSql"]
        .as_array()
        .expect("localBaseSchema.tableSetupSql array");
    assert!(
        table_setup_sql.len() >= tables.len(),
        "localBaseSchema.tableSetupSql should install every synced table and may include explicit local-only tables"
    );
    for table in tables {
        let table_name = table["name"].as_str().expect("table name");
        assert!(
            table_setup_sql.iter().any(|statement| statement
                .as_str()
                .is_some_and(|sql| sql.contains(table_name))),
            "localBaseSchema.tableSetupSql should install synced table {table_name}"
        );
    }
    for statement in table_setup_sql {
        let sql = statement
            .as_str()
            .expect("localBaseSchema.tableSetupSql entries are strings");
        assert!(
            sql.to_ascii_uppercase()
                .contains("CREATE TABLE IF NOT EXISTS"),
            "localBaseSchema.tableSetupSql entries must be idempotent table DDL"
        );
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

    let local_derived = json["localDerivedSchema"]
        .as_object()
        .expect("localDerivedSchema object");
    let local_indexes = local_derived["indexes"]
        .as_array()
        .expect("localDerivedSchema.indexes array");
    for index in local_indexes {
        assert_non_empty_string(&index["table"], "localDerivedSchema.indexes.table");
        assert_non_empty_string(&index["name"], "localDerivedSchema.indexes.name");
        assert_non_empty_string(&index["sql"], "localDerivedSchema.indexes.sql");
        assert!(
            index["unique"].as_bool().is_some(),
            "localDerivedSchema.indexes.unique must be a boolean"
        );
        assert!(
            index["partial"].as_bool().is_some(),
            "localDerivedSchema.indexes.partial must be a boolean"
        );
    }
    assert!(
        local_derived["readModelSetupSql"].as_array().is_some(),
        "localDerivedSchema.readModelSetupSql"
    );
    assert!(
        local_derived["readModelRebuildSql"].as_array().is_some(),
        "localDerivedSchema.readModelRebuildSql"
    );
}

fn assert_non_empty_string(value: &Value, label: &str) {
    assert!(
        value.as_str().is_some_and(|value| !value.is_empty()),
        "{label} must be a non-empty string"
    );
}
