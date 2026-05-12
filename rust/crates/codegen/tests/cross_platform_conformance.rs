use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[test]
fn generated_targets_share_the_same_app_schema_contract() {
    let rust_dir = rust_workspace_dir();
    let example_dir = rust_dir.join("examples/todo-app");
    let schema: Value = serde_json::from_str(
        &fs::read_to_string(example_dir.join("syncular.schema.json")).expect("read schema json"),
    )
    .expect("parse schema json");

    let generated = GeneratedTargets {
        rust_schema: read(&example_dir.join("generated/rust/schema.rs")),
        rust_tables: read(&example_dir.join("generated/rust/diesel_tables.rs")),
        rust_syncular: read(&example_dir.join("generated/rust/syncular.rs")),
        typescript: read(&example_dir.join("generated/typescript/syncular.generated.ts")),
        swift: read(&example_dir.join("generated/swift/SyncularApp.swift")),
        kotlin: read(&example_dir.join("generated/kotlin/SyncularApp.kt")),
        android_kotlin: read(&example_dir.join("generated/kotlin/android/SyncularApp.kt")),
    };

    assert_target_boundaries(&generated);

    let tables = schema["tables"].as_array().expect("schema tables");
    assert!(!tables.is_empty(), "schema must contain app tables");
    for table in tables {
        let table_name = table["name"].as_str().expect("table name");
        let type_name = singular_pascal_case(table_name);
        let primary_key = table["primaryKeyColumn"]
            .as_str()
            .expect("primary key column");
        let server_version = table["serverVersionColumn"]
            .as_str()
            .expect("server version column");

        assert_contains(
            &generated.rust_schema,
            &format!("{} ({})", table_name, primary_key),
            "rust schema table primary key",
        );
        assert_contains(
            &generated.rust_tables,
            &format!("pub struct {type_name}Row"),
            "rust row struct",
        );
        assert_contains(
            &generated.rust_syncular,
            &format!("pub struct New{type_name}"),
            "rust new mutation DTO",
        );
        assert_contains(
            &generated.rust_syncular,
            &format!("pub struct {type_name}Patch"),
            "rust patch mutation DTO",
        );
        assert_contains(
            &generated.rust_syncular,
            &format!("pub struct Delete{type_name}"),
            "rust delete mutation DTO",
        );
        assert_contains(
            &generated.rust_syncular,
            &format!("pub fn {table_name}(self)"),
            "rust mutation namespace",
        );

        assert_contains(
            &generated.typescript,
            &format!("{table_name}: {type_name}Row;"),
            "typescript db table mapping",
        );
        assert_contains(
            &generated.typescript,
            &format!("export interface {type_name}Row"),
            "typescript row type",
        );
        assert_contains(
            &generated.typescript,
            &format!("export interface New{type_name}"),
            "typescript new input type",
        );
        assert_contains(
            &generated.typescript,
            &format!("export type {type_name}Patch"),
            "typescript patch type",
        );
        assert_contains(
            &generated.typescript,
            &format!("new{type_name}Operation"),
            "typescript new operation builder",
        );
        assert_contains(
            &generated.typescript,
            &format!("patch{type_name}Operation"),
            "typescript patch operation builder",
        );

        assert_contains(
            &generated.swift,
            &format!("public struct {type_name}Row"),
            "swift row type",
        );
        assert_contains(
            &generated.swift,
            &format!("public struct New{type_name}"),
            "swift new input type",
        );
        assert_contains(
            &generated.swift,
            &format!("public struct {type_name}Patch"),
            "swift patch type",
        );
        assert_contains(
            &generated.swift,
            &format!("public enum {type_name}Query"),
            "swift generated query namespace",
        );
        assert_contains(
            &generated.swift,
            &format!("SyncularQueryTable<{type_name}Row>"),
            "swift generated query table descriptor",
        );
        assert_contains(
            &generated.swift,
            &format!("public static func select() -> SyncularSelectQuery<{type_name}Row>"),
            "swift generated query select builder",
        );
        assert_contains(
            &generated.swift,
            &format!("public static func new{type_name}"),
            "swift operation builder",
        );
        assert_contains(
            &generated.swift,
            &format!("func applyNew{type_name}"),
            "swift mutation helper",
        );

        for kotlin in [&generated.kotlin, &generated.android_kotlin] {
            assert_contains(
                kotlin,
                &format!("data class {type_name}Row"),
                "kotlin row type",
            );
            assert_contains(
                kotlin,
                &format!("data class New{type_name}"),
                "kotlin new input type",
            );
            assert_contains(
                kotlin,
                &format!("data class {type_name}Patch"),
                "kotlin patch type",
            );
            assert_contains(
                kotlin,
                &format!("object {type_name}Query"),
                "kotlin generated query namespace",
            );
            assert_contains(
                kotlin,
                &format!("SyncularQueryTable(name = \"{table_name}\""),
                "kotlin generated query table descriptor",
            );
            assert_contains(
                kotlin,
                &format!("fun select(): SyncularSelectQuery<{type_name}Row>"),
                "kotlin generated query select builder",
            );
            assert_contains(
                kotlin,
                &format!("fun new{type_name}"),
                "kotlin operation builder",
            );
            assert_contains(
                kotlin,
                &format!("fun SyncularNativeJsonClient.applyNew{type_name}"),
                "kotlin mutation helper",
            );
        }

        assert_contains(
            &generated.typescript,
            &format!("serverVersionColumn: '{server_version}'"),
            "typescript table metadata",
        );
        assert_contains(
            &generated.rust_syncular,
            &format!("server_version_column: \"{server_version}\""),
            "rust table metadata",
        );
    }
}

fn assert_target_boundaries(generated: &GeneratedTargets) {
    for source in [
        &generated.swift,
        &generated.kotlin,
        &generated.android_kotlin,
    ] {
        assert_contains(
            source,
            "queryJson",
            "native generated read path must use queryJson",
        );
        assert_contains(
            source,
            "applyMutationJson",
            "native generated write path must use applyMutationJson",
        );
        assert_contains(
            source,
            "registerQueryJson",
            "native generated live queries must register through generic query observer",
        );
        assert_contains(
            source,
            "SyncularSelectQuery",
            "native generated app modules must expose a query-builder adapter",
        );
        assert!(
            !source.contains("listTasks"),
            "native generated app modules must not expose predefined task reads"
        );
        assert!(
            !source.contains("TASKS_TABLE"),
            "generated modules must not expose table constants as the query API"
        );
    }
}

struct GeneratedTargets {
    rust_schema: String,
    rust_tables: String,
    rust_syncular: String,
    typescript: String,
    swift: String,
    kotlin: String,
    android_kotlin: String,
}

fn rust_workspace_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("rust workspace")
        .to_path_buf()
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn assert_contains(source: &str, needle: &str, label: &str) {
    assert!(
        source.contains(needle),
        "{label} missing expected snippet: {needle}"
    );
}

fn singular_pascal_case(table: &str) -> String {
    let singular = table.strip_suffix('s').unwrap_or(table);
    singular
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect()
}
