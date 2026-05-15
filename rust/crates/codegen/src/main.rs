use anyhow::{bail, Context, Result};
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Integer, Nullable, Text};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(QueryableByName)]
struct TableRow {
    #[diesel(sql_type = Text)]
    name: String,
}

#[derive(QueryableByName, Clone)]
struct ColumnRow {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    #[diesel(column_name = "type")]
    sql_type: String,
    #[diesel(sql_type = Integer)]
    notnull: i32,
    #[diesel(sql_type = Integer)]
    pk: i32,
    #[diesel(sql_type = Nullable<Text>)]
    dflt_value: Option<String>,
}

#[derive(Clone)]
struct TableInfo {
    name: String,
    columns: Vec<ColumnRow>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodegenConfig {
    tables: BTreeMap<String, TableCodegenConfig>,
    schema_output_path: Option<PathBuf>,
    typescript_output_path: Option<PathBuf>,
    typescript_runtime_import_path: Option<String>,
    rust_runtime_crate_path: Option<String>,
    native_swift_output_path: Option<PathBuf>,
    native_kotlin_output_path: Option<PathBuf>,
    native_android_kotlin_output_path: Option<PathBuf>,
    native_android_kotlin_package: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TableCodegenConfig {
    actor_scope_column: Option<String>,
    project_scope_column: Option<String>,
    subscription_id: Option<String>,
    subscription_params: BTreeMap<String, JsonValue>,
    scopes: Vec<ScopeCodegenConfig>,
    server_version_column: Option<String>,
    blob_columns: Vec<String>,
    crdt_yjs_fields: Vec<CrdtYjsFieldConfig>,
    encrypted_fields: Vec<EncryptedFieldConfig>,
    soft_delete_column: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct CrdtYjsFieldConfig {
    field: String,
    state_column: String,
    container_key: Option<String>,
    row_id_field: Option<String>,
    kind: String,
    sync_mode: String,
}

impl Default for CrdtYjsFieldConfig {
    fn default() -> Self {
        Self {
            field: String::new(),
            state_column: String::new(),
            container_key: None,
            row_id_field: None,
            kind: "text".to_string(),
            sync_mode: "server-merge".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct EncryptedFieldConfig {
    field: String,
    scope: Option<String>,
    row_id_field: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ScopeCodegenConfig {
    name: Option<String>,
    column: String,
    source: Option<String>,
    required: bool,
}

impl Default for ScopeCodegenConfig {
    fn default() -> Self {
        Self {
            name: None,
            column: String::new(),
            source: None,
            required: true,
        }
    }
}

impl CodegenConfig {
    fn table(&self, table: &str) -> TableCodegenConfig {
        self.tables.get(table).cloned().unwrap_or_default()
    }

    fn schema_output_path(&self, manifest_dir: &Path) -> Result<PathBuf> {
        output_path(
            manifest_dir,
            self.schema_output_path.clone(),
            "syncular.schema.json",
            "schemaOutputPath",
        )
    }

    fn typescript_output_path(&self, manifest_dir: &Path) -> Result<PathBuf> {
        let path = self
            .typescript_output_path
            .clone()
            .unwrap_or_else(|| PathBuf::from("generated/typescript/syncular.generated.ts"));
        if path.as_os_str().is_empty() {
            bail!("syncular.codegen.json typescriptOutputPath cannot be empty");
        }
        if path.is_absolute() {
            Ok(path)
        } else {
            Ok(manifest_dir.join(path))
        }
    }

    fn typescript_runtime_import_path(&self) -> Result<&str> {
        let path = self
            .typescript_runtime_import_path
            .as_deref()
            .unwrap_or("@syncular/client-rust");
        if path.is_empty() {
            bail!("syncular.codegen.json typescriptRuntimeImportPath cannot be empty");
        }
        Ok(path)
    }

    fn rust_runtime_crate_path(&self) -> Result<&str> {
        let path = self
            .rust_runtime_crate_path
            .as_deref()
            .unwrap_or("syncular_client");
        validate_rust_path(path, "rustRuntimeCratePath")?;
        Ok(path)
    }

    fn native_swift_output_path(&self, manifest_dir: &Path) -> Result<PathBuf> {
        output_path(
            manifest_dir,
            self.native_swift_output_path.clone(),
            "generated/swift/SyncularApp.swift",
            "nativeSwiftOutputPath",
        )
    }

    fn native_kotlin_output_path(&self, manifest_dir: &Path) -> Result<PathBuf> {
        output_path(
            manifest_dir,
            self.native_kotlin_output_path.clone(),
            "generated/kotlin/SyncularApp.kt",
            "nativeKotlinOutputPath",
        )
    }

    fn native_android_kotlin_output_path(&self, manifest_dir: &Path) -> Result<Option<PathBuf>> {
        self.native_android_kotlin_output_path
            .clone()
            .map(|path| {
                output_path(
                    manifest_dir,
                    Some(path),
                    "",
                    "nativeAndroidKotlinOutputPath",
                )
            })
            .transpose()
    }

    fn native_android_kotlin_package(&self) -> Result<&str> {
        let package = self
            .native_android_kotlin_package
            .as_deref()
            .unwrap_or("dev.syncular.client.generated");
        validate_kotlin_package(package, "nativeAndroidKotlinPackage")?;
        Ok(package)
    }
}

fn output_path(
    manifest_dir: &Path,
    configured: Option<PathBuf>,
    default_relative: &str,
    config_key: &str,
) -> Result<PathBuf> {
    let path = configured.unwrap_or_else(|| PathBuf::from(default_relative));
    if path.as_os_str().is_empty() {
        bail!("syncular.codegen.json {config_key} cannot be empty");
    }
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(manifest_dir.join(path))
    }
}

fn validate_kotlin_package(package: &str, config_key: &str) -> Result<()> {
    if package.is_empty() {
        bail!("syncular.codegen.json {config_key} cannot be empty");
    }
    for segment in package.split('.') {
        let mut chars = segment.chars();
        let Some(first) = chars.next() else {
            bail!("syncular.codegen.json {config_key} contains an empty package segment");
        };
        if !(first == '_' || first.is_ascii_alphabetic()) {
            bail!("syncular.codegen.json {config_key} has invalid package segment {segment:?}");
        }
        if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
            bail!("syncular.codegen.json {config_key} has invalid package segment {segment:?}");
        }
        if matches!(
            segment,
            "as" | "break"
                | "class"
                | "continue"
                | "do"
                | "else"
                | "false"
                | "for"
                | "fun"
                | "if"
                | "in"
                | "interface"
                | "is"
                | "null"
                | "object"
                | "package"
                | "return"
                | "super"
                | "this"
                | "throw"
                | "true"
                | "try"
                | "typealias"
                | "typeof"
                | "val"
                | "var"
                | "when"
                | "while"
        ) {
            bail!("syncular.codegen.json {config_key} uses reserved package segment {segment:?}");
        }
    }
    Ok(())
}

fn validate_rust_path(path: &str, config_key: &str) -> Result<()> {
    if path.is_empty() {
        bail!("syncular.codegen.json {config_key} cannot be empty");
    }
    let path = path.strip_prefix("::").unwrap_or(path);
    for segment in path.split("::") {
        let mut chars = segment.chars();
        let Some(first) = chars.next() else {
            bail!("syncular.codegen.json {config_key} contains an empty path segment");
        };
        if !(first == '_' || first.is_ascii_alphabetic()) {
            bail!("syncular.codegen.json {config_key} has invalid path segment {segment:?}");
        }
        if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
            bail!("syncular.codegen.json {config_key} has invalid path segment {segment:?}");
        }
    }
    Ok(())
}

impl TableCodegenConfig {
    fn scopes(&self) -> Vec<ScopeCodegenConfig> {
        self.scopes.clone()
    }

    fn subscription_id(&self, table: &str) -> String {
        self.subscription_id
            .clone()
            .unwrap_or_else(|| format!("sub-{table}"))
    }
}

fn quote_sqlite_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn split_sql_statements(sql: &str) -> impl Iterator<Item = String> + '_ {
    sql.split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(|statement| format!("{statement};"))
}

fn migration_dirs(migrations_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut migration_dirs = fs::read_dir(migrations_dir)
        .with_context(|| format!("read migrations dir {}", migrations_dir.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .context("read migration entries")?;
    migration_dirs.retain(|path| path.is_dir());
    migration_dirs.sort();
    Ok(migration_dirs)
}

fn current_schema_version_from_migrations(migrations_dir: &Path) -> Result<i32> {
    Ok(i32::try_from(migration_dirs(migrations_dir)?.len())
        .context("migration count exceeds i32")?
        .max(1))
}

fn rust_string_literal(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{{{:x}}}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn include_str_expr(manifest_dir: &Path, path: &Path) -> Result<String> {
    let manifest_dir = fs::canonicalize(manifest_dir)
        .with_context(|| format!("canonicalize {}", manifest_dir.display()))?;
    let path =
        fs::canonicalize(path).with_context(|| format!("canonicalize {}", path.display()))?;
    if let Ok(relative) = path.strip_prefix(&manifest_dir) {
        return Ok(format!(
            "include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), {}))",
            rust_string_literal(&format!("/{}", slash_path(relative)))
        ));
    }

    Ok(format!(
        "include_str!({})",
        rust_string_literal(&slash_path(&path))
    ))
}

fn generate_migrations_module(
    manifest_dir: &Path,
    migrations_dir: &Path,
    config: &CodegenConfig,
) -> Result<String> {
    let runtime_crate = config.rust_runtime_crate_path()?;
    let migrations = migration_dirs(migrations_dir)?;
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n\
         // Source: migrations/*.sql\n\n",
    );
    out.push_str(&format!(
        "pub use {runtime_crate}::app_schema::{{checksum, split_sql_statements, EmbeddedMigration}};\n\
         use {runtime_crate}::app_schema::current_schema_version as latest_schema_version;\n\n"
    ));
    out.push_str("pub const MIGRATIONS: &[EmbeddedMigration] = &[\n");
    for (index, migration_dir) in migrations.iter().enumerate() {
        let dir_name = migration_dir
            .file_name()
            .and_then(|value| value.to_str())
            .with_context(|| format!("invalid migration dir name {}", migration_dir.display()))?;
        let (version, name) = dir_name
            .split_once('_')
            .map(|(version, name)| (version, name))
            .unwrap_or((dir_name, dir_name));
        let up_sql_path = migration_dir.join("up.sql");
        let include_expr = include_str_expr(manifest_dir, &up_sql_path)?;
        out.push_str(&format!(
            "    EmbeddedMigration {{\n        version: {},\n        schema_version: {},\n        name: {},\n        up_sql: {},\n    }},\n",
            rust_string_literal(version),
            index + 1,
            rust_string_literal(name),
            include_expr
        ));
    }
    out.push_str("];\n\n");
    out.push_str(
        "pub fn current_schema_version() -> i32 {\n    latest_schema_version(MIGRATIONS)\n}\n",
    );
    Ok(out)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonDocument {
    #[serde(rename = "$schema")]
    schema_ref: String,
    contract_version: u32,
    app_schema_version: i32,
    migrations: Vec<SchemaJsonMigration>,
    tables: Vec<SchemaJsonTable>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonMigration {
    version: String,
    schema_version: i32,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonTable {
    name: String,
    primary_key_column: String,
    server_version_column: String,
    soft_delete_column: Option<String>,
    columns: Vec<SchemaJsonColumn>,
    blob_columns: Vec<String>,
    crdt_yjs_fields: Vec<SchemaJsonCrdtYjsField>,
    #[serde(default)]
    encrypted_fields: Vec<SchemaJsonEncryptedField>,
    scopes: Vec<SchemaJsonScope>,
    subscription: SchemaJsonSubscription,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonCrdtYjsField {
    field: String,
    state_column: String,
    container_key: String,
    row_id_field: String,
    kind: String,
    sync_mode: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonEncryptedField {
    field: String,
    scope: String,
    row_id_field: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonColumn {
    name: String,
    sql_type: String,
    type_family: String,
    app_type: String,
    nullable: bool,
    notnull_required: bool,
    primary_key: bool,
    has_default: bool,
    default_sql: Option<String>,
    server_version: bool,
    soft_delete: bool,
    blob_ref: bool,
    scope: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonScope {
    name: String,
    column: String,
    source: String,
    required: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaJsonSubscription {
    id: String,
    params: BTreeMap<String, JsonValue>,
}

fn migration_specs(migrations_dir: &Path) -> Result<Vec<SchemaJsonMigration>> {
    migration_dirs(migrations_dir)?
        .into_iter()
        .enumerate()
        .map(|(index, migration_dir)| {
            let dir_name = migration_dir
                .file_name()
                .and_then(|value| value.to_str())
                .with_context(|| {
                    format!("invalid migration dir name {}", migration_dir.display())
                })?;
            let (version, name) = dir_name
                .split_once('_')
                .map(|(version, name)| (version, name))
                .unwrap_or((dir_name, dir_name));
            Ok(SchemaJsonMigration {
                version: version.to_string(),
                schema_version: i32::try_from(index + 1).context("migration count exceeds i32")?,
                name: name.to_string(),
            })
        })
        .collect()
}

fn generate_schema_json(
    tables: &[TableInfo],
    config: &CodegenConfig,
    migrations_dir: &Path,
    app_schema_version: i32,
) -> Result<String> {
    let mut schema_tables = Vec::new();
    for table in tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
    {
        let table_config = config.table(&table.name);
        let primary_key = primary_key_column(table);
        let server_version_column = table_config
            .server_version_column
            .as_deref()
            .expect("validated table has server version column");
        let scopes = table_config.scopes();

        let columns = table
            .columns
            .iter()
            .map(|column| {
                let scope = scope_for_column(column, &table_config);
                SchemaJsonColumn {
                    name: column.name.clone(),
                    sql_type: column.sql_type.clone(),
                    type_family: ts_sqlite_column_type(column).to_string(),
                    app_type: schema_app_type(column, &table_config).to_string(),
                    nullable: is_nullable(column),
                    notnull_required: !is_nullable(column) && column.pk == 0,
                    primary_key: column.pk > 0,
                    has_default: has_sql_default(column),
                    default_sql: column.dflt_value.clone(),
                    server_version: column.name == server_version_column,
                    soft_delete: table_config
                        .soft_delete_column
                        .as_deref()
                        .is_some_and(|soft_delete_column| column.name == soft_delete_column),
                    blob_ref: is_blob_ref_column(column, &table_config),
                    scope: scope.as_ref().map(scope_name).map(str::to_string),
                }
            })
            .collect();

        let scopes = scopes
            .into_iter()
            .map(|scope| SchemaJsonScope {
                name: scope_name(&scope).to_string(),
                column: scope.column,
                source: scope.source.expect("validated scope has source"),
                required: scope.required,
            })
            .collect();

        schema_tables.push(SchemaJsonTable {
            name: table.name.clone(),
            primary_key_column: primary_key.name.clone(),
            server_version_column: server_version_column.to_string(),
            soft_delete_column: table_config.soft_delete_column.clone(),
            columns,
            blob_columns: table_config.blob_columns.clone(),
            crdt_yjs_fields: table_config
                .crdt_yjs_fields
                .iter()
                .map(|field| SchemaJsonCrdtYjsField {
                    field: field.field.clone(),
                    state_column: field.state_column.clone(),
                    container_key: field
                        .container_key
                        .clone()
                        .unwrap_or_else(|| field.field.clone()),
                    row_id_field: field
                        .row_id_field
                        .clone()
                        .unwrap_or_else(|| primary_key.name.clone()),
                    kind: if field.kind.is_empty() {
                        "text".to_string()
                    } else {
                        field.kind.clone()
                    },
                    sync_mode: if field.sync_mode.is_empty() {
                        "server-merge".to_string()
                    } else {
                        field.sync_mode.clone()
                    },
                })
                .collect(),
            encrypted_fields: table_config
                .encrypted_fields
                .iter()
                .map(|field| SchemaJsonEncryptedField {
                    field: field.field.clone(),
                    scope: field.scope.clone().unwrap_or_else(|| table.name.clone()),
                    row_id_field: field
                        .row_id_field
                        .clone()
                        .unwrap_or_else(|| primary_key.name.clone()),
                })
                .collect(),
            scopes,
            subscription: SchemaJsonSubscription {
                id: table_config.subscription_id(&table.name),
                params: table_config.subscription_params.clone(),
            },
        });
    }

    let document = SchemaJsonDocument {
        schema_ref: "https://syncular.dev/schemas/syncular.schema.v1.json".to_string(),
        contract_version: 1,
        app_schema_version,
        migrations: migration_specs(migrations_dir)?,
        tables: schema_tables,
    };

    Ok(format!("{}\n", serde_json::to_string_pretty(&document)?))
}

fn generate_runtime_app_schema_json(
    tables: &[TableInfo],
    config: &CodegenConfig,
    migrations_dir: Option<&Path>,
    schema_version: i32,
) -> Result<String> {
    let mut app_tables = Vec::new();
    for table in tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
    {
        let table_config = config.table(&table.name);
        let primary_key = primary_key_column(table);
        let server_version_column = table_config
            .server_version_column
            .as_deref()
            .expect("validated table has server version column");
        let scopes = table_config.scopes();
        app_tables.push(serde_json::json!({
            "name": table.name,
            "primaryKeyColumn": primary_key.name,
            "serverVersionColumn": server_version_column,
            "softDeleteColumn": table_config.soft_delete_column,
            "subscriptionId": table_config.subscription_id(&table.name),
            "columns": table.columns.iter().map(|column| {
                serde_json::json!({
                    "name": column.name,
                    "typeFamily": ts_sqlite_column_type(column),
                    "notnullRequired": !is_nullable(column) && column.pk == 0,
                    "primaryKey": column.pk > 0,
                })
            }).collect::<Vec<_>>(),
            "blobColumns": table_config.blob_columns,
            "crdtYjsFields": table_config.crdt_yjs_fields.iter().map(|field| {
                serde_json::json!({
                    "field": field.field,
                    "stateColumn": field.state_column,
                    "containerKey": field.container_key.as_deref().unwrap_or(&field.field),
                    "rowIdField": field.row_id_field.as_deref().unwrap_or(&primary_key.name),
                    "kind": if field.kind.is_empty() { "text" } else { &field.kind },
                    "syncMode": if field.sync_mode.is_empty() { "server-merge" } else { &field.sync_mode },
                })
            }).collect::<Vec<_>>(),
            "encryptedFields": table_config.encrypted_fields.iter().map(|field| {
                serde_json::json!({
                    "field": field.field,
                    "scope": field.scope.as_deref().unwrap_or(&table.name),
                    "rowIdField": field.row_id_field.as_deref().unwrap_or(&primary_key.name),
                })
            }).collect::<Vec<_>>(),
            "scopes": scopes.iter().map(|scope| {
                serde_json::json!({
                    "name": scope_name(scope),
                    "column": scope.column,
                    "source": scope.source.as_deref().expect("validated scope source"),
                    "required": scope.required,
                })
            }).collect::<Vec<_>>(),
        }));
    }

    let migrations = if let Some(migrations_dir) = migrations_dir {
        migration_dirs(migrations_dir)?
            .into_iter()
            .enumerate()
            .map(|(index, migration_dir)| {
                let dir_name = migration_dir
                    .file_name()
                    .and_then(|value| value.to_str())
                    .with_context(|| {
                        format!("invalid migration dir name {}", migration_dir.display())
                    })?;
                let (version, name) = dir_name
                    .split_once('_')
                    .map(|(version, name)| (version, name))
                    .unwrap_or((dir_name, dir_name));
                let up_sql_path = migration_dir.join("up.sql");
                let up_sql = fs::read_to_string(&up_sql_path)
                    .with_context(|| format!("read migration {}", up_sql_path.display()))?;
                Ok(serde_json::json!({
                    "version": version,
                    "schemaVersion": i32::try_from(index + 1).context("migration count exceeds i32")?,
                    "name": name,
                    "upSql": up_sql,
                }))
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        Vec::new()
    };

    Ok(serde_json::to_string(&serde_json::json!({
        "schemaVersion": schema_version,
        "tables": app_tables,
        "migrations": migrations,
    }))?)
}

fn schema_backed_codegen_inputs(
    schema_json: &str,
    base_config: &CodegenConfig,
    storage_tables: &[TableInfo],
) -> Result<(Vec<TableInfo>, CodegenConfig, i32)> {
    let document: SchemaJsonDocument =
        serde_json::from_str(schema_json).context("parse generated syncular.schema.json")?;
    if document.contract_version != 1 {
        bail!(
            "unsupported syncular.schema.json contractVersion {}; expected 1",
            document.contract_version
        );
    }
    if document.schema_ref != "https://syncular.dev/schemas/syncular.schema.v1.json" {
        bail!(
            "unsupported syncular.schema.json $schema {}; expected https://syncular.dev/schemas/syncular.schema.v1.json",
            document.schema_ref
        );
    }
    if document.app_schema_version < 1 {
        bail!(
            "syncular.schema.json appSchemaVersion must be >= 1; got {}",
            document.app_schema_version
        );
    }

    let mut tables = storage_tables
        .iter()
        .filter(|table| table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let mut table_configs = BTreeMap::new();
    for table in document.tables {
        if table.name.trim().is_empty() {
            bail!("syncular.schema.json contains a table with an empty name");
        }
        let mut columns = Vec::new();
        for column in table.columns {
            if column.name.trim().is_empty() {
                bail!(
                    "syncular.schema.json table {} contains a column with an empty name",
                    table.name
                );
            }
            columns.push(ColumnRow {
                name: column.name,
                sql_type: column.sql_type,
                notnull: i32::from(!column.nullable),
                pk: i32::from(column.primary_key),
                dflt_value: column.default_sql,
            });
        }

        let scopes = table
            .scopes
            .into_iter()
            .map(|scope| ScopeCodegenConfig {
                name: Some(scope.name),
                column: scope.column,
                source: Some(scope.source),
                required: scope.required,
            })
            .collect();

        table_configs.insert(
            table.name.clone(),
            TableCodegenConfig {
                actor_scope_column: None,
                project_scope_column: None,
                subscription_id: Some(table.subscription.id),
                subscription_params: table.subscription.params,
                scopes,
                server_version_column: Some(table.server_version_column),
                blob_columns: table.blob_columns,
                crdt_yjs_fields: table
                    .crdt_yjs_fields
                    .into_iter()
                    .map(|field| CrdtYjsFieldConfig {
                        field: field.field,
                        state_column: field.state_column,
                        container_key: Some(field.container_key),
                        row_id_field: Some(field.row_id_field),
                        kind: field.kind,
                        sync_mode: field.sync_mode,
                    })
                    .collect(),
                encrypted_fields: table
                    .encrypted_fields
                    .into_iter()
                    .map(|field| EncryptedFieldConfig {
                        field: field.field,
                        scope: Some(field.scope),
                        row_id_field: Some(field.row_id_field),
                    })
                    .collect(),
                soft_delete_column: table.soft_delete_column,
            },
        );
        tables.push(TableInfo {
            name: table.name,
            columns,
        });
    }

    let mut schema_config = base_config.clone();
    schema_config.tables = table_configs;
    Ok((tables, schema_config, document.app_schema_version))
}

fn apply_migrations(conn: &mut SqliteConnection, migrations_dir: &Path) -> Result<()> {
    for migration_dir in migration_dirs(migrations_dir)? {
        let up_sql_path = migration_dir.join("up.sql");
        let sql = fs::read_to_string(&up_sql_path)
            .with_context(|| format!("read migration {}", up_sql_path.display()))?;
        for statement in split_sql_statements(&sql) {
            sql_query(statement)
                .execute(conn)
                .with_context(|| format!("apply migration {}", up_sql_path.display()))?;
        }
    }

    Ok(())
}

fn rust_column_name(sql_name: &str) -> String {
    match sql_name {
        "table" => "table_name".to_string(),
        name => name.to_string(),
    }
}

fn pascal_case(name: &str) -> String {
    let mut out = String::new();
    let mut uppercase_next = true;
    for ch in name.chars() {
        if ch == '_' || ch == '-' {
            uppercase_next = true;
            continue;
        }
        if uppercase_next {
            out.extend(ch.to_uppercase());
            uppercase_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn singular_pascal_case(name: &str) -> String {
    pascal_case(&singular_name(name))
}

fn singular_name(name: &str) -> String {
    if let Some(prefix) = name.strip_suffix("ies") {
        format!("{prefix}y")
    } else if name.ends_with("ses") {
        name.strip_suffix("es").unwrap_or(name).to_string()
    } else if name.ends_with('s') {
        name.strip_suffix('s').unwrap_or(name).to_string()
    } else {
        name.to_string()
    }
}

fn const_case(name: &str) -> String {
    let mut out = String::new();
    let mut previous_was_separator = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if !out.is_empty() && previous_was_separator {
                out.push('_');
            }
            out.push(ch.to_ascii_uppercase());
            previous_was_separator = false;
        } else {
            previous_was_separator = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn has_sql_default(column: &ColumnRow) -> bool {
    column.dflt_value.is_some()
}

fn is_server_managed_column(column: &ColumnRow, config: &TableCodegenConfig) -> bool {
    config
        .server_version_column
        .as_deref()
        .is_some_and(|name| column.name == name)
}

fn is_scope_column(column: &ColumnRow, config: &TableCodegenConfig) -> bool {
    config
        .scopes()
        .iter()
        .any(|scope| scope.column == column.name)
}

fn is_blob_ref_column(column: &ColumnRow, config: &TableCodegenConfig) -> bool {
    config
        .blob_columns
        .iter()
        .any(|blob_column| blob_column == &column.name)
}

fn soft_delete_column<'a>(
    table: &'a TableInfo,
    config: &TableCodegenConfig,
) -> Option<&'a ColumnRow> {
    let column_name = config.soft_delete_column.as_deref()?;
    table
        .columns
        .iter()
        .find(|column| column.name == column_name)
}

fn scope_for_column<'a>(
    column: &ColumnRow,
    config: &'a TableCodegenConfig,
) -> Option<ScopeCodegenConfig> {
    config
        .scopes()
        .into_iter()
        .find(|scope| scope.column == column.name)
}

fn is_nullable(column: &ColumnRow) -> bool {
    column.notnull == 0 && column.pk == 0
}

fn rust_field_type(column: &ColumnRow) -> String {
    let nullable = is_nullable(column);
    let upper = column.sql_type.to_ascii_uppercase();
    let base = if upper.contains("BIGINT") {
        "i64"
    } else if upper.contains("INT") {
        "i32"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "f64"
    } else {
        "String"
    };

    if nullable {
        format!("Option<{base}>")
    } else {
        base.to_string()
    }
}

fn diesel_sql_type(sqlite_type: &str, nullable: bool) -> String {
    let upper = sqlite_type.to_ascii_uppercase();
    let base = if upper.contains("BIGINT") {
        "BigInt"
    } else if upper.contains("INT") {
        "Integer"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "Double"
    } else if upper.contains("BLOB") {
        "Binary"
    } else {
        "Text"
    };

    if nullable {
        format!("Nullable<{base}>")
    } else {
        base.to_string()
    }
}

fn rust_param_type(column: &ColumnRow) -> String {
    let field_type = rust_field_type(column);
    if field_type == "String" {
        "&str".to_string()
    } else if field_type == "Option<String>" {
        "Option<&str>".to_string()
    } else {
        field_type
    }
}

fn patch_field_type(column: &ColumnRow) -> String {
    let field_type = rust_field_type(column);
    format!("Option<{field_type}>")
}

fn patch_param_type(column: &ColumnRow) -> String {
    let field_type = rust_field_type(column);
    if field_type == "String" {
        "&str".to_string()
    } else if field_type == "Option<String>" {
        "Option<&str>".to_string()
    } else {
        field_type
    }
}

fn patch_value_from_param(column: &ColumnRow) -> String {
    let name = rust_column_name(&column.name);
    match rust_field_type(column).as_str() {
        "String" => format!("Some({name}.to_string())"),
        "Option<String>" => format!("Some({name}.map(str::to_string))"),
        _ => format!("Some({name})"),
    }
}

fn mutation_required_columns(table: &TableInfo, config: &TableCodegenConfig) -> Vec<ColumnRow> {
    table
        .columns
        .iter()
        .filter(|column| !is_server_managed_column(column, config))
        .filter(|column| !is_nullable(column) || is_scope_column(column, config))
        .filter(|column| {
            !has_sql_default(column) || column.pk > 0 || is_scope_column(column, config)
        })
        .cloned()
        .collect()
}

fn default_rust_value(column: &ColumnRow) -> String {
    if is_nullable(column) {
        return "None".to_string();
    }

    let upper = column.sql_type.to_ascii_uppercase();
    let default = column.dflt_value.as_deref();
    if upper.contains("BIGINT") || upper.contains("INT") {
        default.unwrap_or("0").trim_matches('\'').to_string()
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        default.unwrap_or("0.0").trim_matches('\'').to_string()
    } else {
        let value = default
            .map(|value| {
                value
                    .trim_matches('\'')
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
            })
            .unwrap_or_default();
        format!("\"{value}\".to_string()")
    }
}

fn rust_value_from_param(column: &ColumnRow) -> String {
    let name = rust_column_name(&column.name);
    match rust_field_type(column).as_str() {
        "String" => format!("{name}.to_string()"),
        "Option<String>" => format!("{name}.map(str::to_string)"),
        _ => name,
    }
}

fn json_literal(value: &JsonValue) -> String {
    serde_json::to_string(value).expect("JSON value serializes")
}

fn ts_record_literal(values: &BTreeMap<String, JsonValue>) -> String {
    if values.is_empty() {
        return "{}".to_string();
    }
    let entries = values
        .iter()
        .map(|(key, value)| format!("{}: {}", ts_property_name(key), json_literal(value)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{ {entries} }}")
}

fn swift_json_value_literal(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => ".null".to_string(),
        JsonValue::Bool(value) => format!(".bool({value})"),
        JsonValue::Number(value) => {
            if let Some(value) = value.as_i64() {
                format!(".int({value})")
            } else if let Some(value) = value.as_u64() {
                match i64::try_from(value) {
                    Ok(value) => format!(".int({value})"),
                    Err(_) => format!(".double({})", value as f64),
                }
            } else {
                format!(".double({})", value.as_f64().unwrap_or_default())
            }
        }
        JsonValue::String(value) => format!(".string({})", double_quoted_string(value)),
        JsonValue::Array(values) => format!(
            ".array([{}])",
            values
                .iter()
                .map(swift_json_value_literal)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        JsonValue::Object(values) => format!(
            ".object([{}])",
            values
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        double_quoted_string(key),
                        swift_json_value_literal(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn swift_json_record_literal(values: &BTreeMap<String, JsonValue>) -> String {
    if values.is_empty() {
        return "[:]".to_string();
    }
    format!(
        "[{}]",
        values
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}: {}",
                    double_quoted_string(key),
                    swift_json_value_literal(value)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn kotlin_json_value_literal(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".to_string(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => {
            if let Some(value) = value.as_i64() {
                format!("{value}L")
            } else if let Some(value) = value.as_u64() {
                match i64::try_from(value) {
                    Ok(value) => format!("{value}L"),
                    Err(_) => value.to_string(),
                }
            } else {
                value.as_f64().unwrap_or_default().to_string()
            }
        }
        JsonValue::String(value) => double_quoted_string(value),
        JsonValue::Array(values) => format!(
            "listOf({})",
            values
                .iter()
                .map(kotlin_json_value_literal)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        JsonValue::Object(values) => format!(
            "linkedMapOf<String, Any?>({})",
            values
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{} to {}",
                        double_quoted_string(key),
                        kotlin_json_value_literal(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn kotlin_json_record_literal(values: &BTreeMap<String, JsonValue>) -> String {
    if values.is_empty() {
        return "emptyMap<String, Any?>()".to_string();
    }
    format!(
        "linkedMapOf<String, Any?>({})",
        values
            .iter()
            .map(|(key, value)| {
                format!(
                    "{} to {}",
                    double_quoted_string(key),
                    kotlin_json_value_literal(value)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn ts_string(value: &str) -> String {
    format!(
        "'{}'",
        value
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', "\\n")
    )
}

fn is_ts_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn ts_property_name(value: &str) -> String {
    if is_ts_identifier(value) {
        value.to_string()
    } else {
        ts_string(value)
    }
}

fn ts_member(object: &str, property: &str) -> String {
    if is_ts_identifier(property) {
        format!("{object}.{property}")
    } else {
        format!("{object}[{}]", ts_string(property))
    }
}

fn ts_optional_member(object: &str, property: &str) -> String {
    if is_ts_identifier(property) {
        format!("{object}?.{property}")
    } else {
        format!("{object}?.[{}]", ts_string(property))
    }
}

fn ts_type(column: &ColumnRow) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let base = if upper.contains("INT")
        || upper.contains("REAL")
        || upper.contains("FLOA")
        || upper.contains("DOUB")
    {
        "number"
    } else if upper.contains("BLOB") {
        "Uint8Array"
    } else {
        "string"
    };
    if is_nullable(column) {
        format!("{base} | null")
    } else {
        base.to_string()
    }
}

fn ts_app_type(column: &ColumnRow, config: &TableCodegenConfig) -> String {
    if is_blob_ref_column(column, config) {
        if is_nullable(column) {
            "BlobRef | null".to_string()
        } else {
            "BlobRef".to_string()
        }
    } else {
        ts_type(column)
    }
}

fn ts_default_value(column: &ColumnRow) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let default = column.dflt_value.as_deref();
    if upper.contains("INT")
        || upper.contains("REAL")
        || upper.contains("FLOA")
        || upper.contains("DOUB")
    {
        default.unwrap_or("0").trim_matches('\'').to_string()
    } else {
        default
            .map(|value| ts_string(value.trim_matches('\'')))
            .unwrap_or_else(|| "''".to_string())
    }
}

fn ts_sqlite_column_type(column: &ColumnRow) -> &'static str {
    let upper = column.sql_type.to_ascii_uppercase();
    if upper.contains("INT") {
        "integer"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "real"
    } else if upper.contains("BLOB") {
        "blob"
    } else {
        "text"
    }
}

fn schema_app_type(column: &ColumnRow, config: &TableCodegenConfig) -> &'static str {
    if is_blob_ref_column(column, config) {
        return "blobRef";
    }

    match ts_sqlite_column_type(column) {
        "integer" => "integer",
        "real" => "number",
        "blob" => "bytes",
        _ => "string",
    }
}

fn ts_schema_column_callback(column: &ColumnRow) -> Option<String> {
    let mut calls = Vec::new();
    if column.pk > 0 {
        calls.push("primaryKey()".to_string());
    }
    if !is_nullable(column) && column.pk == 0 {
        calls.push("notNull()".to_string());
    }
    if has_sql_default(column) {
        calls.push(format!("defaultTo({})", ts_default_value(column)));
    }
    if calls.is_empty() {
        None
    } else {
        Some(format!("(col) => col.{}", calls.join(".")))
    }
}

fn ts_input_optional(column: &ColumnRow, config: &TableCodegenConfig) -> bool {
    if let Some(scope) = scope_for_column(column, config) {
        return !scope.required;
    }

    column.pk == 0 && (is_nullable(column) || has_sql_default(column))
}

fn lower_camel_case(name: &str) -> String {
    let pascal = pascal_case(name);
    let mut chars = pascal.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut out = first.to_ascii_lowercase().to_string();
    out.push_str(chars.as_str());
    out
}

fn apply_new_function_name(table_name: &str) -> String {
    format!("applyNew{}", singular_pascal_case(table_name))
}

fn apply_patch_function_name(table_name: &str) -> String {
    format!("apply{}Patch", singular_pascal_case(table_name))
}

fn apply_delete_function_name(table_name: &str) -> String {
    format!("apply{}Delete", singular_pascal_case(table_name))
}

fn enqueue_new_function_name(table_name: &str) -> String {
    format!("enqueueNew{}", singular_pascal_case(table_name))
}

fn enqueue_patch_function_name(table_name: &str) -> String {
    format!("enqueue{}Patch", singular_pascal_case(table_name))
}

fn enqueue_delete_function_name(table_name: &str) -> String {
    format!("enqueue{}Delete", singular_pascal_case(table_name))
}

fn double_quoted_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

fn swift_type(column: &ColumnRow, optional: bool) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let base = if upper.contains("INT") {
        "Int64"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "Double"
    } else if upper.contains("BLOB") {
        "Data"
    } else {
        "String"
    };
    if optional {
        format!("{base}?")
    } else {
        base.to_string()
    }
}

fn swift_app_type(column: &ColumnRow, config: &TableCodegenConfig, optional: bool) -> String {
    let base = if is_blob_ref_column(column, config) {
        "SyncularBlobRef".to_string()
    } else {
        swift_type(column, false)
    };
    if optional {
        format!("{base}?")
    } else {
        base
    }
}

fn kotlin_type(column: &ColumnRow, optional: bool) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let base = if upper.contains("INT") {
        "Long"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "Double"
    } else if upper.contains("BLOB") {
        "ByteArray"
    } else {
        "String"
    };
    if optional {
        format!("{base}?")
    } else {
        base.to_string()
    }
}

fn kotlin_app_type(column: &ColumnRow, config: &TableCodegenConfig, optional: bool) -> String {
    let base = if is_blob_ref_column(column, config) {
        "SyncularBlobRef".to_string()
    } else {
        kotlin_type(column, false)
    };
    if optional {
        format!("{base}?")
    } else {
        base
    }
}

fn swift_row_id_input_expr(primary_key: &ColumnRow) -> String {
    let property = lower_camel_case(&primary_key.name);
    if swift_type(primary_key, false) == "String" {
        format!("input.{property}")
    } else {
        format!("String(input.{property})")
    }
}

fn kotlin_row_id_input_expr(primary_key: &ColumnRow) -> String {
    let property = lower_camel_case(&primary_key.name);
    if kotlin_type(primary_key, false) == "String" {
        format!("input.{property}")
    } else {
        format!("input.{property}.toString()")
    }
}

fn swift_default_value(column: &ColumnRow) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let default = column.dflt_value.as_deref();
    if upper.contains("INT")
        || upper.contains("REAL")
        || upper.contains("FLOA")
        || upper.contains("DOUB")
    {
        default.unwrap_or("0").trim_matches('\'').to_string()
    } else {
        default
            .map(|value| double_quoted_string(value.trim_matches('\'')))
            .unwrap_or_else(|| "\"\"".to_string())
    }
}

fn kotlin_default_value(column: &ColumnRow) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    let default = column.dflt_value.as_deref();
    if upper.contains("INT") {
        format!("{}L", default.unwrap_or("0").trim_matches('\''))
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        default.unwrap_or("0.0").trim_matches('\'').to_string()
    } else {
        default
            .map(|value| double_quoted_string(value.trim_matches('\'')))
            .unwrap_or_else(|| "\"\"".to_string())
    }
}

fn swift_json_value(column: &ColumnRow, value: &str) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    if upper.contains("INT") {
        format!(".int({value})")
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        format!(".double({value})")
    } else if upper.contains("BLOB") {
        format!(".string({value}.base64EncodedString())")
    } else {
        format!(".string({value})")
    }
}

fn swift_payload_value(column: &ColumnRow, config: &TableCodegenConfig, value: &str) -> String {
    if is_blob_ref_column(column, config) {
        format!("{value}.syncularPayloadValue")
    } else {
        swift_json_value(column, value)
    }
}

fn kotlin_payload_value(column: &ColumnRow, value: &str) -> String {
    let upper = column.sql_type.to_ascii_uppercase();
    if upper.contains("BLOB") {
        format!("{value}.toString(Charsets.UTF_8)")
    } else {
        value.to_string()
    }
}

fn kotlin_app_payload_value(
    column: &ColumnRow,
    config: &TableCodegenConfig,
    value: &str,
) -> String {
    if is_blob_ref_column(column, config) {
        format!("{value}.toJsonValue()")
    } else {
        kotlin_payload_value(column, value)
    }
}

fn kotlin_row_decode_value(
    column: &ColumnRow,
    config: &TableCodegenConfig,
    row_var: &str,
) -> String {
    let key = double_quoted_string(&column.name);
    let nullable = is_nullable(column);
    if is_blob_ref_column(column, config) {
        if nullable {
            return format!("{row_var}.syncularOptionalBlobRef({key})");
        }
        return format!("{row_var}.syncularRequiredBlobRef({key})");
    }
    let upper = column.sql_type.to_ascii_uppercase();
    if upper.contains("INT") {
        if nullable {
            format!("{row_var}.syncularOptionalLong({key})")
        } else {
            format!("{row_var}.syncularRequiredLong({key})")
        }
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        if nullable {
            format!("{row_var}.syncularOptionalDouble({key})")
        } else {
            format!("{row_var}.syncularRequiredDouble({key})")
        }
    } else if upper.contains("BLOB") {
        if nullable {
            format!("{row_var}.syncularOptionalString({key})?.encodeToByteArray()")
        } else {
            format!("{row_var}.syncularRequiredString({key}).encodeToByteArray()")
        }
    } else if nullable {
        format!("{row_var}.syncularOptionalString({key})")
    } else {
        format!("{row_var}.syncularRequiredString({key})")
    }
}

fn load_tables(conn: &mut SqliteConnection) -> Result<Vec<TableInfo>> {
    let tables = sql_query(
        r#"
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
        "#,
    )
    .load::<TableRow>(conn)
    .context("load table list")?;

    let mut infos = Vec::new();
    for table in tables {
        let pragma = format!("PRAGMA table_info({})", quote_sqlite_ident(&table.name));
        let columns = sql_query(pragma)
            .load::<ColumnRow>(conn)
            .with_context(|| format!("load table columns for {}", table.name))?;
        infos.push(TableInfo {
            name: table.name,
            columns,
        });
    }

    Ok(infos)
}

fn load_codegen_config(manifest_dir: &Path) -> Result<CodegenConfig> {
    let path = manifest_dir.join("syncular.codegen.json");
    if !path.exists() {
        return Ok(CodegenConfig::default());
    }

    let json = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&json).with_context(|| format!("parse {}", path.display()))
}

fn validate_codegen_config(tables: &[TableInfo], config: &CodegenConfig) -> Result<()> {
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .collect::<Vec<_>>();

    for table in &user_tables {
        if !config.tables.contains_key(&table.name) {
            bail!(
                "syncular.codegen.json is missing metadata for app table {}; add an entry under tables.{}",
                table.name,
                table.name
            );
        }
    }

    for (table_name, table_config) in &config.tables {
        let table = tables
            .iter()
            .find(|table| &table.name == table_name)
            .ok_or_else(|| {
                anyhow::anyhow!("syncular.codegen.json references unknown table {table_name}")
            })?;
        if table_config.actor_scope_column.is_some() || table_config.project_scope_column.is_some()
        {
            bail!(
                "syncular.codegen.json table {table_name} uses deprecated actorScopeColumn/projectScopeColumn; use explicit scopes instead"
            );
        }

        let primary_keys = table
            .columns
            .iter()
            .filter(|column| column.pk > 0)
            .collect::<Vec<_>>();
        if primary_keys.len() != 1 {
            bail!(
                "syncular.codegen.json requires app table {table_name} to have exactly one primary key column; found {}",
                primary_keys.len()
            );
        }

        let Some(server_version_column) = table_config.server_version_column.as_deref() else {
            bail!("syncular.codegen.json table {table_name} must define serverVersionColumn");
        };
        if !table
            .columns
            .iter()
            .any(|column| column.name == server_version_column)
        {
            bail!(
                "syncular.codegen.json references unknown serverVersionColumn {table_name}.{server_version_column}"
            );
        }

        if let Some(soft_delete_column) = table_config.soft_delete_column.as_deref() {
            if soft_delete_column.trim().is_empty() {
                bail!("syncular.codegen.json table {table_name} has an empty softDeleteColumn");
            }
            let Some(column) = table
                .columns
                .iter()
                .find(|column| column.name == soft_delete_column)
            else {
                bail!(
                    "syncular.codegen.json references unknown softDeleteColumn {table_name}.{soft_delete_column}"
                );
            };
            if column.pk > 0 {
                bail!(
                    "syncular.codegen.json softDeleteColumn {table_name}.{soft_delete_column} cannot be the primary key"
                );
            }
            if soft_delete_column == server_version_column {
                bail!(
                    "syncular.codegen.json softDeleteColumn {table_name}.{soft_delete_column} cannot be the serverVersionColumn"
                );
            }
            if ts_sqlite_column_type(column) != "integer" || is_nullable(column) {
                bail!(
                    "syncular.codegen.json softDeleteColumn {table_name}.{soft_delete_column} must be a non-null integer SQLite column"
                );
            }
            if !has_sql_default(column) {
                bail!(
                    "syncular.codegen.json softDeleteColumn {table_name}.{soft_delete_column} must have a SQL default for active rows"
                );
            }
        }

        let subscription_id = table_config.subscription_id(table_name);
        if subscription_id.trim().is_empty() {
            bail!("syncular.codegen.json table {table_name} has an empty subscriptionId");
        }
        for param_name in table_config.subscription_params.keys() {
            if param_name.trim().is_empty() {
                bail!(
                    "syncular.codegen.json table {table_name} has an empty subscriptionParams key"
                );
            }
        }

        let mut scope_names = BTreeSet::new();
        let mut scope_columns = BTreeSet::new();
        for scope in table_config.scopes() {
            if scope.column.is_empty() {
                bail!("syncular.codegen.json has an empty scope column for table {table_name}");
            }
            let scope_name = scope_name(&scope);
            if scope_name.trim().is_empty() {
                bail!("syncular.codegen.json has an empty scope name for table {table_name}");
            }
            if !scope_names.insert(scope_name.to_string()) {
                bail!(
                    "syncular.codegen.json table {table_name} has duplicate scope name {scope_name}"
                );
            }
            if !scope_columns.insert(scope.column.clone()) {
                bail!(
                    "syncular.codegen.json table {table_name} has duplicate scope column {}",
                    scope.column
                );
            }
            if scope.source.is_none() {
                bail!("syncular.codegen.json scope {table_name}.{scope_name} must define source");
            }
            if matches!(scope.source.as_deref(), Some(source) if source != "actorId" && source != "projectId")
            {
                bail!(
                    "syncular.codegen.json has unsupported source `{}` for table {table_name}; supported sources are actorId and projectId",
                    scope.source.as_deref().unwrap_or_default()
                );
            }
            if !table
                .columns
                .iter()
                .any(|column| column.name == scope.column)
            {
                bail!(
                    "syncular.codegen.json references unknown column {table_name}.{}",
                    scope.column
                );
            }
        }

        let mut blob_columns = BTreeSet::new();
        for blob_column in &table_config.blob_columns {
            if blob_column.trim().is_empty() {
                bail!("syncular.codegen.json table {table_name} has an empty blob column");
            }
            if !blob_columns.insert(blob_column.clone()) {
                bail!(
                    "syncular.codegen.json table {table_name} has duplicate blob column {blob_column}"
                );
            }
            let Some(column) = table
                .columns
                .iter()
                .find(|column| &column.name == blob_column)
            else {
                bail!(
                    "syncular.codegen.json references unknown blob column {table_name}.{blob_column}"
                );
            };
            if ts_sqlite_column_type(column) != "text" {
                bail!(
                    "syncular.codegen.json blob column {table_name}.{blob_column} must use a text SQLite column containing a JSON BlobRef"
                );
            }
        }

        let crdt_columns = table_config
            .crdt_yjs_fields
            .iter()
            .flat_map(|field| [field.field.as_str(), field.state_column.as_str()])
            .collect::<BTreeSet<_>>();
        let mut encrypted_fields = BTreeSet::new();
        for encrypted_field in &table_config.encrypted_fields {
            if encrypted_field.field.trim().is_empty() {
                bail!("syncular.codegen.json table {table_name} has an encryptedFields entry with an empty field");
            }
            if !encrypted_fields.insert(encrypted_field.field.clone()) {
                bail!(
                    "syncular.codegen.json table {table_name} has duplicate encrypted field {}",
                    encrypted_field.field
                );
            }
            let Some(column) = table
                .columns
                .iter()
                .find(|column| column.name == encrypted_field.field)
            else {
                bail!(
                    "syncular.codegen.json references unknown encrypted field {table_name}.{}",
                    encrypted_field.field
                );
            };
            if column.pk > 0 {
                bail!(
                    "syncular.codegen.json encrypted field {table_name}.{} cannot be the primary key",
                    encrypted_field.field
                );
            }
            if encrypted_field.field == server_version_column {
                bail!(
                    "syncular.codegen.json encrypted field {table_name}.{} cannot be the serverVersionColumn",
                    encrypted_field.field
                );
            }
            if table_config
                .soft_delete_column
                .as_deref()
                .is_some_and(|soft_delete_column| encrypted_field.field == soft_delete_column)
            {
                bail!(
                    "syncular.codegen.json encrypted field {table_name}.{} cannot be the softDeleteColumn",
                    encrypted_field.field
                );
            }
            if scope_columns.contains(&encrypted_field.field) {
                bail!(
                    "syncular.codegen.json encrypted field {table_name}.{} cannot be a scope column",
                    encrypted_field.field
                );
            }
            if crdt_columns.contains(encrypted_field.field.as_str()) {
                bail!(
                    "syncular.codegen.json encrypted field {table_name}.{} cannot also be a CRDT Yjs field or stateColumn; use encrypted-update-log CRDT fields instead",
                    encrypted_field.field
                );
            }
            if let Some(scope) = encrypted_field.scope.as_deref() {
                if scope.trim().is_empty() {
                    bail!(
                        "syncular.codegen.json encrypted field {table_name}.{} has an empty scope",
                        encrypted_field.field
                    );
                }
            }
            if let Some(row_id_field) = encrypted_field.row_id_field.as_deref() {
                if row_id_field.trim().is_empty() {
                    bail!(
                        "syncular.codegen.json encrypted field {table_name}.{} has an empty rowIdField",
                        encrypted_field.field
                    );
                }
                if !table
                    .columns
                    .iter()
                    .any(|column| column.name == row_id_field)
                {
                    bail!(
                        "syncular.codegen.json references unknown encrypted rowIdField {table_name}.{row_id_field}"
                    );
                }
            }
        }

        let mut crdt_fields = BTreeSet::new();
        for field in &table_config.crdt_yjs_fields {
            if field.field.trim().is_empty() {
                bail!("syncular.codegen.json table {table_name} has a CRDT Yjs field with an empty field");
            }
            if field.state_column.trim().is_empty() {
                bail!("syncular.codegen.json table {table_name} has a CRDT Yjs field with an empty stateColumn");
            }
            if !crdt_fields.insert(field.field.clone()) {
                bail!(
                    "syncular.codegen.json table {table_name} has duplicate CRDT Yjs field {}",
                    field.field
                );
            }
            let Some(value_column) = table
                .columns
                .iter()
                .find(|column| column.name == field.field)
            else {
                bail!(
                    "syncular.codegen.json references unknown CRDT Yjs field {table_name}.{}",
                    field.field
                );
            };
            if ts_sqlite_column_type(value_column) != "text" {
                bail!(
                    "syncular.codegen.json CRDT Yjs field {table_name}.{} must use a text SQLite column",
                    field.field
                );
            }
            let Some(state_column) = table
                .columns
                .iter()
                .find(|column| column.name == field.state_column)
            else {
                bail!(
                    "syncular.codegen.json references unknown CRDT Yjs stateColumn {table_name}.{}",
                    field.state_column
                );
            };
            if ts_sqlite_column_type(state_column) != "text" {
                bail!(
                    "syncular.codegen.json CRDT Yjs stateColumn {table_name}.{} must use a text SQLite column containing a base64 Yjs update",
                    field.state_column
                );
            }
            if field.state_column == field.field {
                bail!(
                    "syncular.codegen.json CRDT Yjs field {table_name}.{} cannot use the same field and stateColumn",
                    field.field
                );
            }
            if let Some(row_id_field) = field.row_id_field.as_deref() {
                if row_id_field.trim().is_empty() {
                    bail!(
                        "syncular.codegen.json CRDT Yjs field {table_name}.{} has an empty rowIdField",
                        field.field
                    );
                }
                if !table
                    .columns
                    .iter()
                    .any(|column| column.name == row_id_field)
                {
                    bail!(
                        "syncular.codegen.json references unknown CRDT Yjs rowIdField {table_name}.{row_id_field}"
                    );
                }
            }
            if let Some(container_key) = field.container_key.as_deref() {
                if container_key.trim().is_empty() {
                    bail!(
                        "syncular.codegen.json CRDT Yjs field {table_name}.{} has an empty containerKey",
                        field.field
                    );
                }
            }
            if !matches!(
                field.kind.as_str(),
                "" | "text" | "xml-fragment" | "prosemirror"
            ) {
                bail!(
                    "syncular.codegen.json CRDT Yjs field {table_name}.{} has unsupported kind {}; supported kinds are text, xml-fragment, and prosemirror",
                    field.field,
                    field.kind
                );
            }
            if !matches!(
                field.sync_mode.as_str(),
                "" | "server-merge" | "encrypted-update-log"
            ) {
                bail!(
                    "syncular.codegen.json CRDT Yjs field {table_name}.{} has unsupported syncMode {}; supported modes are server-merge and encrypted-update-log",
                    field.field,
                    field.sync_mode
                );
            }
        }
    }

    Ok(())
}

fn generate_schema(tables: &[TableInfo]) -> Result<String> {
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n\
         // Source: migrations/*.sql\n\n",
    );
    let mut table_names = Vec::new();

    for table in tables {
        table_names.push(table.name.clone());
        let primary_keys = table
            .columns
            .iter()
            .filter(|column| column.pk > 0)
            .map(|column| rust_column_name(&column.name))
            .collect::<Vec<_>>();
        let primary_key = if primary_keys.len() <= 1 {
            primary_keys
                .first()
                .cloned()
                .unwrap_or_else(|| "id".to_string())
        } else {
            primary_keys.join(", ")
        };

        out.push_str("diesel::table! {\n");
        out.push_str(&format!("    {} ({}) {{\n", table.name, primary_key));

        for column in &table.columns {
            let rust_name = rust_column_name(&column.name);
            if rust_name != column.name {
                out.push_str(&format!("        #[sql_name = \"{}\"]\n", column.name));
            }
            let nullable = is_nullable(column);
            out.push_str(&format!(
                "        {} -> {},\n",
                rust_name,
                diesel_sql_type(&column.sql_type, nullable)
            ));
        }

        out.push_str("    }\n");
        out.push_str("}\n\n");
    }

    out.push_str("diesel::allow_tables_to_appear_in_same_query!(\n");
    for table in table_names {
        out.push_str(&format!("    {},\n", table));
    }
    out.push_str(");\n");
    Ok(out)
}

fn json_expr(column: &ColumnRow, config: &TableCodegenConfig) -> String {
    let sql_name = &column.name;
    let nullable = is_nullable(column);
    let upper = column.sql_type.to_ascii_uppercase();

    if nullable {
        if upper.contains("BIGINT") || upper.contains("INT") {
            format!(r#"obj.get("{sql_name}").and_then(Value::as_i64)"#)
        } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
            format!(r#"obj.get("{sql_name}").and_then(Value::as_f64)"#)
        } else if is_blob_ref_column(column, config) {
            format!(
                r#"obj.get("{sql_name}").and_then(|value| match value {{ Value::String(value) => Some(value.clone()), Value::Array(_) | Value::Object(_) => Some(value.to_string()), _ => None }})"#
            )
        } else {
            format!(r#"obj.get("{sql_name}").and_then(Value::as_str).map(str::to_string)"#)
        }
    } else if is_server_managed_column(column, config) && upper.contains("BIGINT") {
        format!(
            r#"fallback_version.or_else(|| obj.get("{sql_name}").and_then(Value::as_i64)).unwrap_or(0)"#
        )
    } else if upper.contains("BIGINT") {
        format!(r#"obj.get("{sql_name}").and_then(Value::as_i64).unwrap_or(0)"#)
    } else if upper.contains("INT") {
        format!(r#"obj.get("{sql_name}").and_then(Value::as_i64).unwrap_or(0) as i32"#)
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        format!(r#"obj.get("{sql_name}").and_then(Value::as_f64).unwrap_or(0.0)"#)
    } else if is_blob_ref_column(column, config) {
        format!(
            r#"obj.get("{sql_name}").and_then(|value| match value {{ Value::String(value) => Some(value.clone()), Value::Array(_) | Value::Object(_) => Some(value.to_string()), _ => None }}).unwrap_or_default()"#
        )
    } else if column.pk > 0 {
        format!(
            r#"obj.get("{sql_name}").and_then(Value::as_str).ok_or_else(|| SyncularError::protocol_message("{sql_name} missing"))?.to_string()"#
        )
    } else {
        format!(r#"obj.get("{sql_name}").and_then(Value::as_str).unwrap_or("").to_string()"#)
    }
}

fn json_insert_for_row(column: &ColumnRow, map_name: &str) -> String {
    let sql_name = &column.name;
    let rust_name = rust_column_name(sql_name);
    if is_nullable(column) {
        format!(
            "        if let Some(value) = &self.{rust_name} {{\n            {map_name}.insert(\"{sql_name}\".to_string(), json!(value));\n        }}\n"
        )
    } else {
        format!(
            "        {map_name}.insert(\"{sql_name}\".to_string(), json!(&self.{rust_name}));\n"
        )
    }
}

fn json_insert_for_payload(column: &ColumnRow, map_name: &str) -> String {
    if column.pk > 0 {
        return String::new();
    }
    json_insert_for_row(column, map_name)
}

fn crdt_envelope_field_for_column<'a>(
    column_name: &str,
    config: &'a TableCodegenConfig,
) -> Option<&'a str> {
    config
        .crdt_yjs_fields
        .iter()
        .filter(|field| is_server_merge_crdt_field(field))
        .find(|field| field.field == column_name || field.state_column == column_name)
        .map(|field| field.field.as_str())
}

fn rust_json_insert_for_payload(
    column: &ColumnRow,
    map_name: &str,
    config: &TableCodegenConfig,
) -> String {
    let insert = json_insert_for_payload(column, map_name);
    if insert.is_empty() {
        return insert;
    }
    let Some(crdt_field) = crdt_envelope_field_for_column(&column.name, config) else {
        return insert;
    };
    format!(
        "        if !self.yjs_updates.contains_key({}) {{\n{}        }}\n",
        double_quoted_string(crdt_field),
        indent_block(&insert, 4)
    )
}

fn indent_block(input: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    input
        .lines()
        .map(|line| format!("{prefix}{line}\n"))
        .collect::<String>()
}

fn scope_name(scope: &ScopeCodegenConfig) -> &str {
    scope.name.as_deref().unwrap_or(&scope.column)
}

fn scope_param_name(scope: &ScopeCodegenConfig) -> String {
    rust_column_name(scope_name(scope))
}

fn scope_call_expr(scope: &ScopeCodegenConfig) -> String {
    match (scope.source.as_deref(), scope.required) {
        (Some("actorId"), true) => "&config.actor_id".to_string(),
        (Some("actorId"), false) => "Some(config.actor_id.as_str())".to_string(),
        (Some("projectId"), true) => {
            "config.project_id.as_deref().expect(\"projectId scope requires config.project_id\")"
                .to_string()
        }
        (Some("projectId"), false) => "config.project_id.as_deref()".to_string(),
        _ => {
            if scope.required {
                "\"\"".to_string()
            } else {
                "None".to_string()
            }
        }
    }
}

fn primary_key_column(table: &TableInfo) -> &ColumnRow {
    table
        .columns
        .iter()
        .find(|column| column.pk > 0)
        .expect("validated table has primary key")
}

fn scope_source_variant(scope: &ScopeCodegenConfig) -> &'static str {
    match scope.source.as_deref() {
        Some("actorId") => "ScopeSource::ActorId",
        Some("projectId") => "ScopeSource::ProjectId",
        _ => unreachable!("validated scope source"),
    }
}

fn generate_table_metadata(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let const_prefix = const_case(&table.name);
    let columns_const = format!("{const_prefix}_COLUMNS");
    let scopes_const = format!("{const_prefix}_SCOPES");
    let blob_columns_const = format!("{const_prefix}_BLOB_COLUMNS");
    let crdt_yjs_fields_const = format!("{const_prefix}_CRDT_YJS_FIELDS");
    let encrypted_fields_const = format!("{const_prefix}_ENCRYPTED_FIELDS");
    let metadata_const = format!("{const_prefix}_METADATA");
    let primary_key = primary_key_column(table);
    let mut out = String::new();

    out.push_str(&format!(
        "pub const {columns_const}: &[ColumnMetadata] = &[\n"
    ));
    for column in &table.columns {
        out.push_str(&format!(
            "    ColumnMetadata {{ name: \"{}\", type_family: \"{}\", notnull_required: {}, primary_key: {} }},\n",
            column.name,
            ts_sqlite_column_type(column),
            !is_nullable(column) && column.pk == 0,
            column.pk > 0
        ));
    }
    out.push_str("];\n\n");

    out.push_str(&format!("pub const {blob_columns_const}: &[&str] = &[\n"));
    for column in &config.blob_columns {
        out.push_str(&format!("    \"{}\",\n", column));
    }
    out.push_str("];\n\n");

    out.push_str(&format!(
        "pub const {crdt_yjs_fields_const}: &[CrdtYjsFieldMetadata] = &[\n"
    ));
    for field in &config.crdt_yjs_fields {
        out.push_str(&format!(
            "    CrdtYjsFieldMetadata {{ field: \"{}\", state_column: \"{}\", container_key: \"{}\", row_id_field: \"{}\", kind: \"{}\", sync_mode: \"{}\" }},\n",
            field.field,
            field.state_column,
            field
                .container_key
                .as_deref()
                .unwrap_or(&field.field),
            field
                .row_id_field
                .as_deref()
                .unwrap_or(&primary_key.name),
            if field.kind.is_empty() {
                "text"
            } else {
                &field.kind
            },
            if field.sync_mode.is_empty() {
                "server-merge"
            } else {
                &field.sync_mode
            }
        ));
    }
    out.push_str("];\n\n");

    out.push_str(&format!(
        "pub const {encrypted_fields_const}: &[EncryptedFieldMetadata] = &[\n"
    ));
    for field in &config.encrypted_fields {
        out.push_str(&format!(
            "    EncryptedFieldMetadata {{ field: \"{}\", scope: \"{}\", row_id_field: \"{}\" }},\n",
            field.field,
            field.scope.as_deref().unwrap_or(&table.name),
            field.row_id_field.as_deref().unwrap_or(&primary_key.name)
        ));
    }
    out.push_str("];\n\n");

    out.push_str(&format!(
        "pub const {scopes_const}: &[ScopeMetadata] = &[\n"
    ));
    for scope in config.scopes() {
        out.push_str(&format!(
            "    ScopeMetadata {{ name: \"{}\", column: \"{}\", source: {}, required: {} }},\n",
            scope_name(&scope),
            scope.column,
            scope_source_variant(&scope),
            scope.required
        ));
    }
    out.push_str("];\n\n");

    out.push_str(&format!(
        "pub const {metadata_const}: AppTableMetadata = AppTableMetadata {{\n    name: \"{}\",\n    primary_key_column: \"{}\",\n    server_version_column: \"{}\",\n    soft_delete_column: {},\n    subscription_id: \"{}\",\n    columns: {columns_const},\n    blob_columns: {blob_columns_const},\n    crdt_yjs_fields: {crdt_yjs_fields_const},\n    encrypted_fields: {encrypted_fields_const},\n    scopes: {scopes_const},\n}};\n\n",
        table.name,
        primary_key.name,
        config
            .server_version_column
            .as_deref()
            .expect("validated table has server version column"),
        config
            .soft_delete_column
            .as_deref()
            .map(|column| format!("Some({})", double_quoted_string(column)))
            .unwrap_or_else(|| "None".to_string()),
        config.subscription_id(&table.name)
    ));

    out
}

fn generate_subscription_function(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let fn_name = format!("{}_subscription", table.name);
    let scopes = config.scopes();
    let params = scopes
        .iter()
        .map(|scope| {
            let param_name = scope_param_name(scope);
            let param_type = if scope.required {
                "&str"
            } else {
                "Option<&str>"
            };
            format!("{param_name}: {param_type}")
        })
        .collect::<Vec<_>>()
        .join(", ");

    let mut out = String::new();
    out.push_str(&format!(
        "pub fn {fn_name}({params}) -> SubscriptionSpec {{\n"
    ));
    out.push_str("    let mut scopes = Map::new();\n");
    for scope in scopes {
        let name = scope_name(&scope);
        let param_name = scope_param_name(&scope);
        if scope.required {
            out.push_str(&format!(
                "    scopes.insert(\"{name}\".to_string(), json!({param_name}));\n"
            ));
        } else {
            out.push_str(&format!(
                "    if let Some({param_name}) = {param_name} {{\n        scopes.insert(\"{name}\".to_string(), json!({param_name}));\n    }}\n"
            ));
        }
    }
    if config.subscription_params.is_empty() {
        out.push_str("    let params = Map::new();\n");
    } else {
        out.push_str("    let mut params = Map::new();\n");
        for (param_name, value) in &config.subscription_params {
            out.push_str(&format!(
                "    params.insert({}.to_string(), json!({}));\n",
                double_quoted_string(param_name),
                json_literal(value)
            ));
        }
    }
    out.push_str(&format!(
        "\n    SubscriptionSpec {{\n        id: \"{}\".to_string(),\n        table: \"{}\".to_string(),\n        scopes,\n        params,\n    }}\n}}\n\n",
        config.subscription_id(&table.name),
        table.name
    ));
    out
}

fn generate_encrypted_crdt_subscription_function(
    table: &TableInfo,
    config: &TableCodegenConfig,
    field: &CrdtYjsFieldConfig,
    system_table: &str,
    suffix: &str,
) -> String {
    let fn_name = format!(
        "{}_{}_crdt_{}_subscription",
        table.name,
        rust_column_name(&field.field),
        suffix
    );
    let scopes = config.scopes();
    let params = scopes
        .iter()
        .map(|scope| {
            let param_name = scope_param_name(scope);
            let param_type = if scope.required {
                "&str"
            } else {
                "Option<&str>"
            };
            format!("{param_name}: {param_type}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = String::new();
    out.push_str(&format!(
        "pub fn {fn_name}({params}) -> SubscriptionSpec {{\n"
    ));
    out.push_str("    let mut scopes = Map::new();\n");
    for scope in scopes {
        let name = scope_name(&scope);
        let param_name = scope_param_name(&scope);
        if scope.required {
            out.push_str(&format!(
                "    scopes.insert(\"{name}\".to_string(), json!({param_name}));\n"
            ));
        } else {
            out.push_str(&format!(
                "    if let Some({param_name}) = {param_name} {{\n        scopes.insert(\"{name}\".to_string(), json!({param_name}));\n    }}\n"
            ));
        }
    }
    out.push_str("    let mut params = Map::new();\n");
    out.push_str(&format!(
        "    params.insert(\"app_table\".to_string(), json!({}));\n",
        double_quoted_string(&table.name)
    ));
    out.push_str(&format!(
        "    params.insert(\"field_name\".to_string(), json!({}));\n",
        double_quoted_string(&field.field)
    ));
    out.push_str(&format!(
        "\n    SubscriptionSpec {{\n        id: \"sub-{}-{}-crdt-{}\".to_string(),\n        table: \"{}\".to_string(),\n        scopes,\n        params,\n    }}\n}}\n\n",
        table.name, field.field, suffix, system_table
    ));
    out
}

fn subscription_call(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let fn_name = format!("{}_subscription", table.name);
    let args = config
        .scopes()
        .iter()
        .map(scope_call_expr)
        .collect::<Vec<_>>()
        .join(", ");
    if args.is_empty() {
        format!("{fn_name}()")
    } else {
        format!("{fn_name}({args})")
    }
}

fn encrypted_crdt_subscription_call(
    table: &TableInfo,
    config: &TableCodegenConfig,
    field: &CrdtYjsFieldConfig,
    suffix: &str,
) -> String {
    let fn_name = format!(
        "{}_{}_crdt_{}_subscription",
        table.name,
        rust_column_name(&field.field),
        suffix
    );
    let args = config
        .scopes()
        .iter()
        .map(scope_call_expr)
        .collect::<Vec<_>>()
        .join(", ");
    if args.is_empty() {
        format!("{fn_name}()")
    } else {
        format!("{fn_name}({args})")
    }
}

fn ts_encrypted_crdt_subscription_fn(
    table: &TableInfo,
    field: &CrdtYjsFieldConfig,
    suffix: &str,
) -> String {
    lower_camel_case(&format!(
        "{}_{}_crdt_{}_subscription",
        singular_name(&table.name),
        field.field,
        suffix
    ))
}

fn native_table_subscription_fn(table: &TableInfo) -> String {
    lower_camel_case(&format!("{}_subscription", singular_name(&table.name)))
}

fn native_encrypted_crdt_subscription_fn(
    table: &TableInfo,
    field: &CrdtYjsFieldConfig,
    suffix: &str,
) -> String {
    lower_camel_case(&format!(
        "{}_{}_crdt_{}_subscription",
        singular_name(&table.name),
        field.field,
        suffix
    ))
}

fn is_server_merge_crdt_field(field: &CrdtYjsFieldConfig) -> bool {
    field.sync_mode.is_empty() || field.sync_mode == "server-merge"
}

fn is_encrypted_update_log_crdt_field(field: &CrdtYjsFieldConfig) -> bool {
    field.sync_mode == "encrypted-update-log"
}

fn has_server_merge_crdt_fields(config: &TableCodegenConfig) -> bool {
    config
        .crdt_yjs_fields
        .iter()
        .any(is_server_merge_crdt_field)
}

fn has_crdt_yjs_fields(config: &TableCodegenConfig) -> bool {
    !config.crdt_yjs_fields.is_empty()
}

fn encrypted_update_log_crdt_fields(
    config: &TableCodegenConfig,
) -> impl Iterator<Item = &CrdtYjsFieldConfig> {
    config
        .crdt_yjs_fields
        .iter()
        .filter(|field| is_encrypted_update_log_crdt_field(field))
}

fn has_encrypted_update_log_crdt_fields(config: &TableCodegenConfig) -> bool {
    config
        .crdt_yjs_fields
        .iter()
        .any(is_encrypted_update_log_crdt_field)
}

fn required_browser_runtime_features(
    user_tables: &[TableInfo],
    config: &CodegenConfig,
) -> Vec<&'static str> {
    let mut needs_blobs = false;
    let mut needs_crdt_yjs = false;
    let mut needs_e2ee = false;
    for table in user_tables {
        let table_config = config.table(&table.name);
        if !table_config.blob_columns.is_empty() {
            needs_blobs = true;
        }
        if has_crdt_yjs_fields(&table_config) {
            needs_crdt_yjs = true;
        }
        if !table_config.encrypted_fields.is_empty()
            || has_encrypted_update_log_crdt_fields(&table_config)
        {
            needs_e2ee = true;
        }
    }

    let mut features = vec!["web-owned-sqlite-core"];
    if needs_blobs {
        features.push("blobs");
    }
    if needs_crdt_yjs {
        features.push("crdt-yjs");
    }
    if needs_e2ee {
        features.push("e2ee");
    }
    features
}

fn generate_rust_yjs_update_methods(config: &TableCodegenConfig) -> String {
    let mut out = String::new();
    for field in config
        .crdt_yjs_fields
        .iter()
        .filter(|field| is_server_merge_crdt_field(field))
    {
        let method = rust_column_name(&format!("{}_yjs_update", field.field));
        let updates_method = rust_column_name(&format!("{}_yjs_updates", field.field));
        out.push_str(&format!(
            "    pub fn {method}(mut self, update: YjsUpdateEnvelope) -> Self {{\n        self.yjs_updates.insert({}.to_string(), json!(update));\n        self\n    }}\n\n",
            double_quoted_string(&field.field)
        ));
        out.push_str(&format!(
            "    pub fn {updates_method}(mut self, updates: Vec<YjsUpdateEnvelope>) -> Self {{\n        self.yjs_updates.insert({}.to_string(), json!(updates));\n        self\n    }}\n\n",
            double_quoted_string(&field.field)
        ));
    }
    out
}

fn generate_mutation_struct(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let mutation_name = format!("New{}", singular_pascal_case(&table.name));
    let mutation_columns = table
        .columns
        .iter()
        .filter(|column| !is_server_managed_column(column, config))
        .cloned()
        .collect::<Vec<_>>();
    let required_columns = mutation_required_columns(table, config);
    let primary_key = table.columns.iter().find(|column| column.pk > 0).cloned();
    let non_pk_required_columns = required_columns
        .iter()
        .filter(|column| column.pk == 0)
        .cloned()
        .collect::<Vec<_>>();

    let mut out = String::new();
    out.push_str("#[derive(Debug, Clone)]\n");
    out.push_str(&format!("pub struct {mutation_name} {{\n"));
    for column in &mutation_columns {
        out.push_str(&format!(
            "    pub {}: {},\n",
            rust_column_name(&column.name),
            rust_field_type(column)
        ));
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("    yjs_updates: Map<String, Value>,\n");
    }
    out.push_str("}\n\n");
    out.push_str(&format!("impl {mutation_name} {{\n"));
    out.push_str("    pub fn new(");
    for (index, column) in required_columns.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!(
            "{}: {}",
            rust_column_name(&column.name),
            rust_param_type(column)
        ));
    }
    out.push_str(") -> Self {\n");
    out.push_str("        Self {\n");
    for column in &mutation_columns {
        let name = rust_column_name(&column.name);
        if required_columns
            .iter()
            .any(|required| required.name == column.name)
        {
            out.push_str(&format!(
                "            {name}: {},\n",
                rust_value_from_param(column)
            ));
        } else {
            out.push_str(&format!(
                "            {name}: {},\n",
                default_rust_value(column)
            ));
        }
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("            yjs_updates: Map::new(),\n");
    }
    out.push_str("        }\n    }\n\n");
    if let Some(primary_key) = primary_key.as_ref() {
        if rust_field_type(primary_key) == "String" {
            out.push_str("    pub fn with_generated_id(");
            for (index, column) in non_pk_required_columns.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&format!(
                    "{}: {}",
                    rust_column_name(&column.name),
                    rust_param_type(column)
                ));
            }
            out.push_str(") -> Self {\n");
            out.push_str("        Self {\n");
            for column in &mutation_columns {
                let name = rust_column_name(&column.name);
                if column.pk > 0 {
                    out.push_str(&format!("            {name}: random_syncular_id(),\n"));
                } else if non_pk_required_columns
                    .iter()
                    .any(|required| required.name == column.name)
                {
                    out.push_str(&format!(
                        "            {name}: {},\n",
                        rust_value_from_param(column)
                    ));
                } else {
                    out.push_str(&format!(
                        "            {name}: {},\n",
                        default_rust_value(column)
                    ));
                }
            }
            if has_server_merge_crdt_fields(config) {
                out.push_str("            yjs_updates: Map::new(),\n");
            }
            out.push_str("        }\n    }\n\n");
        }
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str(&generate_rust_yjs_update_methods(config));
    }
    out.push_str("    pub fn row_json(&self) -> Value {\n");
    out.push_str("        let mut row = Map::new();\n");
    for column in &mutation_columns {
        out.push_str(&json_insert_for_row(column, "row"));
    }
    out.push_str("        Value::Object(row)\n    }\n\n");
    out.push_str("    pub fn sync_operation(&self) -> SyncOperation {\n");
    out.push_str("        let mut payload = Map::new();\n");
    for column in &mutation_columns {
        out.push_str(&rust_json_insert_for_payload(column, "payload", config));
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("        if !self.yjs_updates.is_empty() {\n            payload.insert(YJS_PAYLOAD_KEY.to_string(), Value::Object(self.yjs_updates.clone()));\n        }\n");
    }
    let row_id = if let Some(primary_key) = primary_key {
        let name = rust_column_name(&primary_key.name);
        if rust_field_type(&primary_key) == "String" {
            format!("self.{name}.clone()")
        } else {
            format!("self.{name}.to_string()")
        }
    } else {
        "\"\".to_string()".to_string()
    };
    out.push_str(&format!(
        "\n        SyncOperation {{\n            table: \"{}\".to_string(),\n            row_id: {},\n            op: \"upsert\".to_string(),\n            payload: Some(Value::Object(payload)),\n            base_version: Some(0),\n        }}\n    }}\n",
        table.name, row_id
    ));
    out.push_str("}\n\n");
    out.push_str(&format!(
        "impl IntoSyncularMutation for {mutation_name} {{\n"
    ));
    out.push_str("    fn into_syncular_mutation(self) -> PendingSyncularMutation {\n");
    out.push_str("        let row_id = ");
    out.push_str(&row_id.replace("self.", "self."));
    out.push_str(";\n");
    out.push_str("        PendingSyncularMutation {\n");
    out.push_str("            kind: SyncularMutationKind::Insert,\n");
    out.push_str(&format!(
        "            table: \"{}\".to_string(),\n",
        table.name
    ));
    out.push_str("            row_id,\n");
    out.push_str("            payload: self.sync_operation().payload,\n");
    out.push_str("            base_version: None,\n");
    out.push_str("            local_row: Some(self.row_json()),\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out
}

fn generate_delete_helper(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let fn_name = format!("delete_{}", singular_name(&table.name));
    let delete_name = format!("Delete{}", singular_pascal_case(&table.name));
    if let Some(column) = soft_delete_column(table, config) {
        return format!(
            r#"#[derive(Debug, Clone)]
pub struct {delete_name} {{
    row_id: String,
    base_version: Option<i64>,
}}

impl {delete_name} {{
    pub fn new(row_id: &str) -> Self {{
        Self {{ row_id: row_id.to_string(), base_version: None }}
    }}

    pub fn base_version(mut self, base_version: i64) -> Self {{
        self.base_version = Some(base_version);
        self
    }}

    pub fn sync_operation(&self) -> SyncOperation {{
        SyncOperation {{
            table: "{}".to_string(),
            row_id: self.row_id.clone(),
            op: "upsert".to_string(),
            payload: Some(json!({{ {}: 1 }})),
            base_version: self.base_version,
        }}
    }}
}}

impl IntoSyncularMutation for {delete_name} {{
    fn into_syncular_mutation(self) -> PendingSyncularMutation {{
        PendingSyncularMutation {{
            kind: SyncularMutationKind::Update,
            table: "{}".to_string(),
            row_id: self.row_id,
            payload: Some(json!({{ {}: 1 }})),
            base_version: self.base_version,
            local_row: None,
        }}
    }}
}}

pub fn {fn_name}(row_id: &str, base_version: Option<i64>) -> SyncOperation {{
    SyncOperation {{
        table: "{}".to_string(),
        row_id: row_id.to_string(),
        op: "upsert".to_string(),
        payload: Some(json!({{ {}: 1 }})),
        base_version,
    }}
}}

"#,
            table.name,
            double_quoted_string(&column.name),
            table.name,
            double_quoted_string(&column.name),
            table.name,
            double_quoted_string(&column.name)
        );
    }

    format!(
        r#"#[derive(Debug, Clone)]
pub struct {delete_name} {{
    row_id: String,
    base_version: Option<i64>,
}}

impl {delete_name} {{
    pub fn new(row_id: &str) -> Self {{
        Self {{ row_id: row_id.to_string(), base_version: None }}
    }}

    pub fn base_version(mut self, base_version: i64) -> Self {{
        self.base_version = Some(base_version);
        self
    }}

    pub fn sync_operation(&self) -> SyncOperation {{
        SyncOperation {{
            table: "{}".to_string(),
            row_id: self.row_id.clone(),
            op: "delete".to_string(),
            payload: None,
            base_version: self.base_version,
        }}
    }}
}}

impl IntoSyncularMutation for {delete_name} {{
    fn into_syncular_mutation(self) -> PendingSyncularMutation {{
        PendingSyncularMutation {{
            kind: SyncularMutationKind::Delete,
            table: "{}".to_string(),
            row_id: self.row_id,
            payload: None,
            base_version: self.base_version,
            local_row: None,
        }}
    }}
}}

pub fn {fn_name}(row_id: &str, base_version: Option<i64>) -> SyncOperation {{
    SyncOperation {{
        table: "{}".to_string(),
        row_id: row_id.to_string(),
        op: "delete".to_string(),
        payload: None,
        base_version,
    }}
}}

"#,
        table.name, table.name, table.name
    )
}

fn generate_patch_struct(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let patch_name = format!("{}Patch", singular_pascal_case(&table.name));
    let patch_columns = table
        .columns
        .iter()
        .filter(|column| column.pk == 0)
        .filter(|column| !is_server_managed_column(column, config))
        .cloned()
        .collect::<Vec<_>>();

    let mut out = String::new();
    out.push_str("#[derive(Debug, Clone)]\n");
    out.push_str(&format!("pub struct {patch_name} {{\n"));
    out.push_str("    row_id: String,\n");
    out.push_str("    base_version: Option<i64>,\n");
    for column in &patch_columns {
        out.push_str(&format!(
            "    {}: {},\n",
            rust_column_name(&column.name),
            patch_field_type(column)
        ));
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("    yjs_updates: Map<String, Value>,\n");
    }
    out.push_str("}\n\n");
    out.push_str(&format!("impl {patch_name} {{\n"));
    out.push_str(
        "    pub fn new(row_id: &str) -> Self {\n        Self {\n            row_id: row_id.to_string(),\n            base_version: None,\n",
    );
    for column in &patch_columns {
        out.push_str(&format!(
            "            {}: None,\n",
            rust_column_name(&column.name)
        ));
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("            yjs_updates: Map::new(),\n");
    }
    out.push_str("        }\n    }\n\n");
    out.push_str(
        "    pub fn base_version(mut self, base_version: i64) -> Self {\n        self.base_version = Some(base_version);\n        self\n    }\n\n",
    );
    for column in &patch_columns {
        let name = rust_column_name(&column.name);
        out.push_str(&format!(
            "    pub fn {name}(mut self, {name}: {}) -> Self {{\n        self.{name} = {};\n        self\n    }}\n\n",
            patch_param_type(column),
            patch_value_from_param(column)
        ));
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str(&generate_rust_yjs_update_methods(config));
    }
    out.push_str("    pub fn payload_json(&self) -> Value {\n");
    out.push_str("        let mut payload = Map::new();\n");
    for column in &patch_columns {
        let sql_name = &column.name;
        let name = rust_column_name(sql_name);
        let insert = format!(
            "        if let Some(value) = &self.{name} {{\n            payload.insert(\"{sql_name}\".to_string(), json!(value));\n        }}\n"
        );
        if let Some(crdt_field) = crdt_envelope_field_for_column(sql_name, config) {
            out.push_str(&format!(
                "        if !self.yjs_updates.contains_key({}) {{\n{}        }}\n",
                double_quoted_string(crdt_field),
                indent_block(&insert, 4)
            ));
        } else {
            out.push_str(&insert);
        }
    }
    if has_server_merge_crdt_fields(config) {
        out.push_str("        if !self.yjs_updates.is_empty() {\n            payload.insert(YJS_PAYLOAD_KEY.to_string(), Value::Object(self.yjs_updates.clone()));\n        }\n");
    }
    out.push_str("        Value::Object(payload)\n    }\n\n");
    out.push_str("    pub fn sync_operation(&self) -> SyncOperation {\n");
    out.push_str(&format!(
        "        SyncOperation {{\n            table: \"{}\".to_string(),\n            row_id: self.row_id.clone(),\n            op: \"upsert\".to_string(),\n            payload: Some(self.payload_json()),\n            base_version: self.base_version,\n        }}\n    }}\n",
        table.name
    ));
    out.push_str("}\n\n");
    out.push_str(&format!("impl IntoSyncularMutation for {patch_name} {{\n"));
    out.push_str("    fn into_syncular_mutation(self) -> PendingSyncularMutation {\n");
    out.push_str("        let payload = self.payload_json();\n");
    out.push_str("        PendingSyncularMutation {\n");
    out.push_str("            kind: SyncularMutationKind::Update,\n");
    out.push_str(&format!(
        "            table: \"{}\".to_string(),\n",
        table.name
    ));
    out.push_str("            row_id: self.row_id,\n");
    out.push_str("            payload: Some(payload),\n");
    out.push_str("            base_version: self.base_version,\n");
    out.push_str("            local_row: None,\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out
}

fn generate_rust_mutations_api(
    tables: &[TableInfo],
    table_configs: &BTreeMap<String, TableCodegenConfig>,
) -> String {
    let mut out = String::new();
    out.push_str("#[derive(Debug, Clone)]\n");
    out.push_str("pub struct InsertReceipt {\n");
    out.push_str("    pub id: String,\n");
    out.push_str("    pub commit: MutationReceipt,\n");
    out.push_str("}\n\n");
    out.push_str("#[derive(Debug, Clone)]\n");
    out.push_str("pub struct InsertManyReceipt {\n");
    out.push_str("    pub ids: Vec<String>,\n");
    out.push_str("    pub commit: MutationReceipt,\n");
    out.push_str("}\n\n");
    out.push_str("pub trait SyncularGeneratedMutationsExt: SyncularMutationExecutor {\n");
    out.push_str("    fn mutations(&mut self) -> SyncularAppMutations<'_, Self>\n");
    out.push_str("    where\n");
    out.push_str("        Self: Sized,\n");
    out.push_str("    {\n");
    out.push_str("        SyncularAppMutations { client: self }\n");
    out.push_str("    }\n\n");
    out.push_str("    fn commit<R>(\n");
    out.push_str("        &mut self,\n");
    out.push_str("        f: impl FnOnce(&mut SyncularAppMutationTx<'_>) -> Result<R>,\n");
    out.push_str("    ) -> Result<MutationCommit<R>>\n");
    out.push_str("    where\n");
    out.push_str("        Self: Sized,\n");
    out.push_str("    {\n");
    out.push_str("        let mut batch = SyncularMutationBatch::new();\n");
    out.push_str("        let result = {\n");
    out.push_str("            let mut tx = SyncularAppMutationTx { batch: &mut batch };\n");
    out.push_str("            f(&mut tx)?\n");
    out.push_str("        };\n");
    out.push_str("        let commit = self.apply_mutation_batch(batch)?;\n");
    out.push_str("        Ok(MutationCommit { result, commit })\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str(
        "impl<C> SyncularGeneratedMutationsExt for C where C: SyncularMutationExecutor {}\n\n",
    );
    out.push_str("pub struct SyncularAppMutations<'a, C: SyncularMutationExecutor + ?Sized> {\n");
    out.push_str("    client: &'a mut C,\n");
    out.push_str("}\n\n");
    out.push_str("pub struct SyncularAppMutationTx<'a> {\n");
    out.push_str("    batch: &'a mut SyncularMutationBatch,\n");
    out.push_str("}\n\n");

    for table in tables {
        let config = table_configs
            .get(&table.name)
            .expect("validated generated Rust table has config");
        let table_fn = rust_column_name(&table.name);
        let singular = singular_pascal_case(&table.name);
        let mutations_name = format!("{singular}Mutations");
        let tx_name = format!("{singular}MutationTx");
        let new_name = format!("New{singular}");
        let patch_name = format!("{singular}Patch");
        let delete_name = format!("Delete{singular}");
        let primary_key = rust_column_name(&primary_key_column(table).name);

        out.push_str(&format!(
            "impl<'a, C> SyncularAppMutations<'a, C>\nwhere\n    C: SyncularMutationExecutor + ?Sized,\n{{\n    pub fn {table_fn}(self) -> {mutations_name}<'a, C> {{\n        {mutations_name} {{ client: self.client }}\n    }}\n}}\n\n"
        ));
        out.push_str(&format!(
            "impl<'a> SyncularAppMutationTx<'a> {{\n    pub fn {table_fn}(&mut self) -> {tx_name}<'_> {{\n        {tx_name} {{ batch: self.batch }}\n    }}\n}}\n\n"
        ));
        out.push_str(&format!(
            "pub struct {mutations_name}<'a, C: SyncularMutationExecutor + ?Sized> {{\n    client: &'a mut C,\n}}\n\n"
        ));
        out.push_str(&format!(
            "impl<C> {mutations_name}<'_, C>\nwhere\n    C: SyncularMutationExecutor + ?Sized,\n{{\n    pub fn insert(self, row: {new_name}) -> Result<InsertReceipt> {{\n        let id = row.{primary_key}.clone();\n        let commit = self.client.apply_mutation(row)?;\n        Ok(InsertReceipt {{ id, commit }})\n    }}\n\n    pub fn insert_many(self, rows: impl IntoIterator<Item = {new_name}>) -> Result<InsertManyReceipt> {{\n        let mut batch = SyncularMutationBatch::new();\n        let mut ids = Vec::new();\n        for row in rows {{\n            ids.push(row.{primary_key}.clone());\n            batch.push(row);\n        }}\n        let commit = self.client.apply_mutation_batch(batch)?;\n        Ok(InsertManyReceipt {{ ids, commit }})\n    }}\n\n    pub fn update(self, patch: {patch_name}) -> Result<MutationReceipt> {{\n        self.client.apply_mutation(patch)\n    }}\n\n    pub fn delete(self, row_id: &str) -> Result<MutationReceipt> {{\n        self.client.apply_mutation({delete_name}::new(row_id))\n    }}\n"
        ));
        for field in encrypted_update_log_crdt_fields(config) {
            if field.kind != "text" {
                continue;
            }
            let method = rust_column_name(&format!("update_{}_text", field.field));
            let checkpoint_method = rust_column_name(&format!("checkpoint_{}_text", field.field));
            let metadata_const = format!("{}_METADATA", const_case(&table.name));
            out.push_str(&format!(
                "\n    pub fn {method}(self, row_id: &str, next_text: &str) -> Result<MutationReceipt>\n    where\n        C: SyncularEncryptedCrdtMutationExecutor,\n    {{\n        self.client.apply_encrypted_crdt_text_update(&{metadata_const}, {}, row_id, next_text)\n    }}\n\n    pub fn {checkpoint_method}(self, row_id: &str, min_uncheckpointed_updates: i64) -> Result<Option<MutationReceipt>>\n    where\n        C: SyncularEncryptedCrdtMutationExecutor,\n    {{\n        self.client.apply_encrypted_crdt_checkpoint(&{metadata_const}, {}, row_id, min_uncheckpointed_updates)\n    }}\n",
                double_quoted_string(&field.field),
                double_quoted_string(&field.field)
            ));
        }
        out.push_str("}\n\n");
        out.push_str(&format!(
            "pub struct {tx_name}<'a> {{\n    batch: &'a mut SyncularMutationBatch,\n}}\n\n"
        ));
        out.push_str(&format!(
            "impl {tx_name}<'_> {{\n    pub fn insert(self, row: {new_name}) -> Result<String> {{\n        let id = row.{primary_key}.clone();\n        self.batch.push(row);\n        Ok(id)\n    }}\n\n    pub fn insert_many(self, rows: impl IntoIterator<Item = {new_name}>) -> Result<Vec<String>> {{\n        let mut ids = Vec::new();\n        for row in rows {{\n            ids.push(row.{primary_key}.clone());\n            self.batch.push(row);\n        }}\n        Ok(ids)\n    }}\n\n    pub fn update(self, patch: {patch_name}) -> Result<()> {{\n        self.batch.push(patch);\n        Ok(())\n    }}\n\n    pub fn delete(self, row_id: &str) -> Result<()> {{\n        self.batch.push({delete_name}::new(row_id));\n        Ok(())\n    }}\n}}\n\n"
        ));
    }

    out.push_str("pub mod prelude {\n");
    out.push_str("    pub use super::{\n");
    out.push_str(
        "        InsertManyReceipt, InsertReceipt, SyncularAppMutationTx, SyncularAppMutations,\n",
    );
    out.push_str("        SyncularGeneratedMutationsExt,\n");
    for table in tables {
        let singular = singular_pascal_case(&table.name);
        out.push_str(&format!(
            "        Delete{singular}, New{singular}, {singular}Mutations, {singular}MutationTx, {singular}Patch,\n"
        ));
    }
    out.push_str("    };\n");
    out.push_str("}\n\n");
    out
}

fn generate_row_struct(table: &TableInfo) -> String {
    let row_name = format!("{}Row", singular_pascal_case(&table.name));
    let mut out = String::new();
    out.push_str(
        "#[derive(Debug, Clone, Queryable, Selectable, Insertable, Serialize, Deserialize)]\n",
    );
    out.push_str(&format!("#[diesel(table_name = schema::{})]\n", table.name));
    out.push_str(&format!("pub struct {row_name} {{\n"));
    for column in &table.columns {
        out.push_str(&format!(
            "    pub {}: {},\n",
            rust_column_name(&column.name),
            rust_field_type(column)
        ));
    }
    out.push_str("}\n\n");
    out
}

fn scope_subsets(scopes: &[ScopeCodegenConfig]) -> Vec<Vec<usize>> {
    let optional_indexes = scopes
        .iter()
        .enumerate()
        .filter_map(|(index, scope)| (!scope.required).then_some(index))
        .collect::<Vec<_>>();
    let required_indexes = scopes
        .iter()
        .enumerate()
        .filter_map(|(index, scope)| scope.required.then_some(index))
        .collect::<Vec<_>>();
    let mut subsets = Vec::new();
    for mask in 0..(1usize << optional_indexes.len()) {
        let mut indexes = required_indexes.clone();
        for (bit, scope_index) in optional_indexes.iter().enumerate() {
            if mask & (1usize << bit) != 0 {
                indexes.push(*scope_index);
            }
        }
        subsets.push(indexes);
    }
    subsets.sort_by_key(|indexes| std::cmp::Reverse(indexes.len()));
    subsets
}

fn clear_condition(scopes: &[ScopeCodegenConfig], included_indexes: &[usize]) -> String {
    let mut conditions = scopes
        .iter()
        .enumerate()
        .filter(|(_, scope)| scope.required)
        .map(|(index, _)| format!("scope_{index}.is_some()"))
        .collect::<Vec<_>>();

    for (index, scope) in scopes.iter().enumerate() {
        if !scope.required && included_indexes.contains(&index) {
            conditions.push(format!("scope_{index}.is_some()"));
        }
    }

    if conditions.is_empty() {
        "true".to_string()
    } else {
        conditions.join(" && ")
    }
}

fn generate_adapter(table: &TableInfo, config: &TableCodegenConfig) -> String {
    let pascal = pascal_case(&table.name);
    let row_name = format!("{}Row", singular_pascal_case(&table.name));
    let adapter_name = format!("{pascal}TableAdapter");
    let primary_key = table
        .columns
        .iter()
        .find(|column| column.pk > 0)
        .map(|column| rust_column_name(&column.name))
        .unwrap_or_else(|| "id".to_string());
    let update_columns = table
        .columns
        .iter()
        .filter(|column| column.pk == 0)
        .map(|column| rust_column_name(&column.name))
        .collect::<Vec<_>>();
    let scopes = config.scopes();

    let mut out = String::new();
    out.push_str(&generate_row_struct(table));
    out.push_str(&format!("struct {adapter_name};\n\n"));
    out.push_str(&format!("impl DieselTableAdapter for {adapter_name} {{\n"));
    out.push_str("    fn name(&self) -> &'static str {\n");
    out.push_str(&format!("        \"{}\"\n", table.name));
    out.push_str("    }\n\n");
    out.push_str(
        "    fn list_rows_json(&self, conn: &mut SqliteConnection) -> Result<Vec<Value>> {\n",
    );
    out.push_str(&format!(
        "        use schema::{}::dsl as t;\n\n",
        table.name
    ));
    out.push_str(&format!(
        "        let rows: Vec<{row_name}> = t::{}\n            .select({row_name}::as_select())\n            .load(conn)?;\n",
        table.name
    ));
    out.push_str(
        "        rows.into_iter()\n            .map(serde_json::to_value)\n            .collect::<serde_json::Result<Vec<_>>>()\n            .map_err(Into::into)\n    }\n\n",
    );
    out.push_str("    fn clear_for_scopes(&self, conn: &mut SqliteConnection, scopes: &ScopeValues) -> Result<()> {\n");
    out.push_str(&format!(
        "        use schema::{}::dsl as t;\n\n",
        table.name
    ));
    if scopes.is_empty() {
        out.push_str("        diesel::delete(t::TABLE).execute(conn)?;\n");
    } else {
        for (index, scope) in scopes.iter().enumerate() {
            out.push_str(&format!(
                "        let scope_{index} = scopes.get(\"{}\").and_then(Value::as_str);\n",
                scope_name(scope)
            ));
        }

        for (branch_index, included_indexes) in scope_subsets(&scopes).iter().enumerate() {
            let keyword = if branch_index == 0 { "if" } else { "else if" };
            out.push_str(&format!(
                "\n        {keyword} {} {{\n",
                clear_condition(&scopes, included_indexes)
            ));
            out.push_str("            diesel::delete(\n                t::TABLE\n");
            for index in included_indexes {
                let scope = &scopes[*index];
                let column = rust_column_name(&scope.column);
                out.push_str(&format!(
                    "                    .filter(t::{column}.eq(scope_{index}.expect(\"scope checked\")))\n"
                ));
            }
            out.push_str("            )\n            .execute(conn)?;\n");
            out.push_str("        }");
        }
        out.push_str(" else {\n            diesel::delete(t::TABLE).execute(conn)?;\n        }\n");
    }
    out = out.replace("t::TABLE", &format!("t::{}", table.name));
    out.push_str("\n        Ok(())\n    }\n\n");
    out.push_str("    fn upsert_row(&self, conn: &mut SqliteConnection, row: &Value, fallback_version: Option<i64>) -> Result<()> {\n");
    out.push_str(&format!(
        "        use schema::{}::dsl as t;\n\n",
        table.name
    ));
    out.push_str("        let obj = row.as_object().ok_or_else(|| SyncularError::protocol_message(format!(\"row is not an object: {row}\")))?;\n");
    out.push_str(&format!("        let row = {row_name} {{\n"));
    for column in &table.columns {
        out.push_str(&format!(
            "            {}: {},\n",
            rust_column_name(&column.name),
            json_expr(column, config)
        ));
    }
    out.push_str("        };\n\n");
    out.push_str(&format!(
        "        diesel::insert_into(t::{})\n            .values(&row)\n            .on_conflict(t::{})\n            .do_update()\n            .set((\n",
        table.name, primary_key
    ));
    for column in update_columns {
        out.push_str(&format!("                t::{column}.eq(&row.{column}),\n"));
    }
    out.push_str("            ))\n            .execute(conn)?;\n\n        Ok(())\n    }\n\n");
    out.push_str("    fn apply_change(&self, conn: &mut SqliteConnection, change: &SyncChange) -> Result<()> {\n");
    out.push_str(&format!(
        "        use schema::{}::dsl as t;\n\n",
        table.name
    ));
    out.push_str(&format!(
        "        if change.table != \"{}\" {{\n            return Err(SyncularError::codegen(format!(\"adapter cannot apply change for table {{}}\", change.table)));\n        }}\n\n",
        table.name
    ));
    out.push_str("        if change.op == \"delete\" {\n");
    out.push_str(&format!(
        "            diesel::delete(t::{}.filter(t::{}.eq(&change.row_id))).execute(conn)?;\n",
        table.name, primary_key
    ));
    out.push_str("            return Ok(());\n        }\n\n");
    out.push_str("        let row = change.row_json.as_ref().ok_or_else(|| SyncularError::protocol_message(format!(\"upsert change missing row_json for {}\", change.row_id)))?;\n");
    out.push_str("        self.upsert_row(conn, row, change.row_version)\n    }\n");
    out.push_str("}\n\n");
    out
}

fn generate_diesel_tables(tables: &[TableInfo], config: &CodegenConfig) -> Result<String> {
    let runtime_crate = config.rust_runtime_crate_path()?;
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n\
         // Source: migrations/*.sql\n\n",
    );
    out.push_str(&format!(
        "use {runtime_crate}::app_schema::DieselTableAdapter;\n\
         use {runtime_crate}::error::{{Result, SyncularError}};\n\
         use {runtime_crate}::protocol::{{ScopeValues, SyncChange}};\n"
    ));
    out.push_str(
        "use super::schema;\n\
         use diesel::prelude::*;\n\
         use diesel::sqlite::SqliteConnection;\n\
         use serde::{Deserialize, Serialize};\n\
         use serde_json::Value;\n\n",
    );

    for table in &user_tables {
        out.push_str(&format!(
            "static {}_ADAPTER: {}TableAdapter = {}TableAdapter;\n",
            table.name.to_ascii_uppercase(),
            pascal_case(&table.name),
            pascal_case(&table.name)
        ));
    }
    out.push_str("static TABLE_ADAPTERS: [&dyn DieselTableAdapter; ");
    out.push_str(&user_tables.len().to_string());
    out.push_str("] = [");
    for table in &user_tables {
        out.push_str(&format!("&{}_ADAPTER, ", table.name.to_ascii_uppercase()));
    }
    out.push_str("];\n\n");
    out.push_str(
        r#"pub fn adapter_for(table: &str) -> Result<&'static dyn DieselTableAdapter> {
    TABLE_ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.name() == table)
        .ok_or_else(|| SyncularError::codegen(format!("no Diesel table adapter registered for {table}")))
}

"#,
    );

    for table in &user_tables {
        out.push_str(&generate_adapter(table, &config.table(&table.name)));
    }
    Ok(out)
}

fn generate_generated_module(tables: &[TableInfo], config: &CodegenConfig) -> Result<String> {
    let runtime_crate = config.rust_runtime_crate_path()?;
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n\
         // Source: migrations/*.sql\n\n",
    );
    out.push_str(&format!(
        "pub use {runtime_crate}::app_schema::{{AppTableMetadata, ColumnMetadata, CrdtYjsFieldMetadata, EncryptedFieldMetadata, ScopeMetadata, ScopeSource}};\n\
         #[allow(unused_imports)]\n\
         use {runtime_crate}::client::{{SubscriptionSpec, SyncChangedRow, SyncularClientConfig, SyncularEncryptedCrdtMutationExecutor, SyncularMutationExecutor}};\n\
         use {runtime_crate}::crdt_yjs::{{YjsUpdateEnvelope, YJS_PAYLOAD_KEY}};\n\
         use {runtime_crate}::encryption::FieldEncryptionRule;\n\
         use {runtime_crate}::error::Result;\n\
         use {runtime_crate}::protocol::{{IntoSyncularMutation, MutationCommit, MutationReceipt, PendingSyncularMutation, SyncOperation, SyncularMutationBatch, SyncularMutationKind, random_syncular_id}};\n"
    ));
    out.push_str("use serde_json::{json, Map, Value};\n\n");

    out.push_str("pub const APP_TABLES: &[&str] = &[\n");
    for table in &user_tables {
        out.push_str(&format!("    \"{}\",\n", table.name));
    }
    out.push_str("];\n\n");

    for table in &user_tables {
        out.push_str(&format!(
            "pub const {}_TABLE: &str = \"{}\";\n",
            const_case(&table.name),
            table.name
        ));
    }
    if !user_tables.is_empty() {
        out.push('\n');
    }

    for table in &user_tables {
        out.push_str(&generate_table_metadata(table, &config.table(&table.name)));
    }

    out.push_str("pub const APP_TABLE_METADATA: &[AppTableMetadata] = &[\n");
    for table in &user_tables {
        out.push_str(&format!("    {}_METADATA,\n", const_case(&table.name)));
    }
    out.push_str("];\n\n");

    out.push_str(
        "pub fn table_metadata(table: &str) -> Option<&'static AppTableMetadata> {\n    APP_TABLE_METADATA.iter().find(|metadata| metadata.name == table)\n}\n\n",
    );

    push_rust_changed_row_helpers(&mut out, &user_tables);

    out.push_str("pub fn generated_field_encryption_rules() -> Vec<FieldEncryptionRule> {\n");
    let encrypted_rules = user_tables
        .iter()
        .flat_map(|table| {
            let primary_key = primary_key_column(table).name.clone();
            config
                .table(&table.name)
                .encrypted_fields
                .into_iter()
                .map(move |field| (table.name.clone(), primary_key.clone(), field))
        })
        .collect::<Vec<_>>();
    if encrypted_rules.is_empty() {
        out.push_str("    Vec::new()\n");
    } else {
        out.push_str("    vec![\n");
        for (table_name, primary_key, field) in encrypted_rules {
            out.push_str(&format!(
                "        FieldEncryptionRule {{ scope: \"{}\".to_string(), table: Some(\"{}\".to_string()), fields: vec![\"{}\".to_string()], row_id_field: Some(\"{}\".to_string()) }},\n",
                field.scope.as_deref().unwrap_or(&table_name),
                table_name,
                field.field,
                field.row_id_field.as_deref().unwrap_or(&primary_key)
            ));
        }
        out.push_str("    ]\n");
    }
    out.push_str("}\n\n");

    out.push_str(
        "pub fn default_subscriptions(config: &SyncularClientConfig) -> Vec<SubscriptionSpec> {\n",
    );
    if user_tables.is_empty() {
        out.push_str("    let _ = config;\n    Vec::new()\n");
    } else {
        out.push_str("    vec![\n");
        for table in &user_tables {
            let table_config = config.table(&table.name);
            out.push_str(&format!(
                "        {},\n",
                subscription_call(table, &table_config)
            ));
            for field in encrypted_update_log_crdt_fields(&table_config) {
                out.push_str(&format!(
                    "        {},\n",
                    encrypted_crdt_subscription_call(table, &table_config, field, "updates")
                ));
                out.push_str(&format!(
                    "        {},\n",
                    encrypted_crdt_subscription_call(table, &table_config, field, "checkpoints")
                ));
            }
        }
        out.push_str("    ]\n");
    }
    out.push_str("}\n\n");

    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&generate_subscription_function(table, &table_config));
        for field in encrypted_update_log_crdt_fields(&table_config) {
            out.push_str(&generate_encrypted_crdt_subscription_function(
                table,
                &table_config,
                field,
                "sync_crdt_updates",
                "updates",
            ));
            out.push_str(&generate_encrypted_crdt_subscription_function(
                table,
                &table_config,
                field,
                "sync_crdt_checkpoints",
                "checkpoints",
            ));
        }
    }
    for table in &user_tables {
        out.push_str(&generate_mutation_struct(table, &config.table(&table.name)));
        out.push_str(&generate_patch_struct(table, &config.table(&table.name)));
        out.push_str(&generate_delete_helper(table, &config.table(&table.name)));
    }
    out.push_str(&generate_rust_mutations_api(&user_tables, &config.tables));

    Ok(out)
}

fn push_rust_changed_row_helpers(out: &mut String, user_tables: &[TableInfo]) {
    for table in user_tables {
        let type_name = singular_pascal_case(&table.name);
        let helper_fn = format!("{}_changed_rows", singular_name(&table.name));
        out.push_str(&format!(
            "#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]\npub struct {type_name}ChangedFields {{\n"
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    pub {}: bool,\n",
                rust_column_name(&column.name)
            ));
        }
        out.push_str("}\n\n");
        out.push_str(&format!("impl {type_name}ChangedFields {{\n"));
        out.push_str("    pub fn from_columns(columns: &[String]) -> Self {\n");
        out.push_str("        Self {\n");
        for column in &table.columns {
            out.push_str(&format!(
                "            {}: columns.iter().any(|column| column == \"{}\"),\n",
                rust_column_name(&column.name),
                column.name
            ));
        }
        out.push_str("        }\n");
        out.push_str("    }\n\n");
        out.push_str("    pub fn contains(&self, column: &str) -> bool {\n");
        out.push_str("        match column {\n");
        for column in &table.columns {
            out.push_str(&format!(
                "            \"{}\" => self.{},\n",
                column.name,
                rust_column_name(&column.name)
            ));
        }
        out.push_str("            _ => false,\n");
        out.push_str("        }\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "#[derive(Debug, Clone, Copy)]\npub struct {type_name}ChangedRow<'a> {{\n    pub raw: &'a SyncChangedRow,\n    pub changed: {type_name}ChangedFields,\n    pub crdt: {type_name}ChangedFields,\n}}\n\n"
        ));
        out.push_str(&format!("impl<'a> {type_name}ChangedRow<'a> {{\n"));
        out.push_str("    pub fn from_raw(row: &'a SyncChangedRow) -> Option<Self> {\n");
        out.push_str(&format!(
            "        if row.table != \"{}\" {{\n            return None;\n        }}\n",
            table.name
        ));
        out.push_str("        Some(Self {\n");
        out.push_str("            raw: row,\n");
        out.push_str(&format!(
            "            changed: {type_name}ChangedFields::from_columns(&row.changed_fields),\n"
        ));
        out.push_str(&format!(
            "            crdt: {type_name}ChangedFields::from_columns(&row.crdt_fields),\n"
        ));
        out.push_str("        })\n");
        out.push_str("    }\n\n");
        out.push_str("    pub fn row_id(&self) -> Option<&str> {\n");
        out.push_str("        self.raw.row_id.as_deref()\n");
        out.push_str("    }\n\n");
        out.push_str("    pub fn is_insert(&self) -> bool {\n        self.raw.operation == \"insert\"\n    }\n\n");
        out.push_str("    pub fn is_update(&self) -> bool {\n        self.raw.operation == \"update\"\n    }\n\n");
        out.push_str("    pub fn is_delete(&self) -> bool {\n        self.raw.operation == \"delete\"\n    }\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "pub fn {helper_fn}<'a>(rows: impl IntoIterator<Item = &'a SyncChangedRow>) -> Vec<{type_name}ChangedRow<'a>> {{\n    rows.into_iter().filter_map({type_name}ChangedRow::from_raw).collect()\n}}\n\n"
        ));
    }
}

fn push_typescript_changed_row_helpers(out: &mut String, user_tables: &[TableInfo]) {
    out.push_str(
        "export type SyncularGeneratedChangedOperation = SyncularV2ChangedRow['operation'];\n",
    );
    out.push_str("export type SyncularChangedRowsInput = SyncularV2RowsChangedEvent | { changedRows?: readonly SyncularV2ChangedRow[] } | readonly SyncularV2ChangedRow[];\n\n");
    out.push_str("export interface SyncularGeneratedChangedRowBase<Table extends keyof SyncularAppDb, Field extends string> {\n");
    out.push_str("  raw: SyncularV2ChangedRow;\n");
    out.push_str("  table: Table;\n");
    out.push_str("  rowId: string | null;\n");
    out.push_str("  operation: SyncularGeneratedChangedOperation;\n");
    out.push_str("  changedFields: Field[];\n");
    out.push_str("  crdtFields: Field[];\n");
    out.push_str("  changed: Record<Field, boolean>;\n");
    out.push_str("  crdt: Record<Field, boolean>;\n");
    out.push_str("  commitId: string | null;\n");
    out.push_str("  commitSeq: number | null;\n");
    out.push_str("  subscriptionId: string | null;\n");
    out.push_str("  serverVersion: number | null;\n");
    out.push_str("  isInsert: boolean;\n");
    out.push_str("  isUpdate: boolean;\n");
    out.push_str("  isDelete: boolean;\n");
    out.push_str("}\n\n");
    out.push_str("function syncularRowsFromChangedInput(input: SyncularChangedRowsInput): readonly SyncularV2ChangedRow[] {\n");
    out.push_str("  return Array.isArray(input) ? input : input.changedRows ?? [];\n");
    out.push_str("}\n\n");
    out.push_str("function syncularColumnFlags<Field extends string>(fields: readonly string[], allFields: readonly Field[]): Record<Field, boolean> {\n");
    out.push_str("  const changed = new Set(fields);\n");
    out.push_str("  return Object.fromEntries(allFields.map((field) => [field, changed.has(field)])) as Record<Field, boolean>;\n");
    out.push_str("}\n\n");
    out.push_str("function syncularTypedChangedRows<Table extends keyof SyncularAppDb, Field extends string>(\n");
    out.push_str("  input: SyncularChangedRowsInput,\n");
    out.push_str("  table: Table,\n");
    out.push_str("  fields: readonly Field[]\n");
    out.push_str("): SyncularGeneratedChangedRowBase<Table, Field>[] {\n");
    out.push_str("  const fieldSet = new Set<string>(fields);\n");
    out.push_str("  return syncularRowsFromChangedInput(input)\n");
    out.push_str("    .filter((row) => row.table === table)\n");
    out.push_str("    .map((row) => ({\n");
    out.push_str("      raw: row,\n");
    out.push_str("      table,\n");
    out.push_str("      rowId: row.rowId ?? null,\n");
    out.push_str("      operation: row.operation,\n");
    out.push_str("      changedFields: row.changedFields.filter((field): field is Field => fieldSet.has(field)),\n");
    out.push_str("      crdtFields: row.crdtFields.filter((field): field is Field => fieldSet.has(field)),\n");
    out.push_str("      changed: syncularColumnFlags(row.changedFields, fields),\n");
    out.push_str("      crdt: syncularColumnFlags(row.crdtFields, fields),\n");
    out.push_str("      commitId: row.commitId ?? null,\n");
    out.push_str("      commitSeq: row.commitSeq ?? null,\n");
    out.push_str("      subscriptionId: row.subscriptionId ?? null,\n");
    out.push_str("      serverVersion: row.serverVersion ?? null,\n");
    out.push_str("      isInsert: row.operation === 'insert',\n");
    out.push_str("      isUpdate: row.operation === 'update',\n");
    out.push_str("      isDelete: row.operation === 'delete',\n");
    out.push_str("    }));\n");
    out.push_str("}\n\n");

    for table in user_tables {
        let type_name = singular_pascal_case(&table.name);
        let helper_name = format!("{}ChangedRows", singular_name(&table.name));
        out.push_str(&format!(
            "export const syncular{type_name}ChangedFields = [\n"
        ));
        for column in &table.columns {
            out.push_str(&format!("  {},\n", ts_string(&column.name)));
        }
        out.push_str("] as const;\n");
        out.push_str(&format!(
            "export type {type_name}ChangedField = typeof syncular{type_name}ChangedFields[number];\n"
        ));
        out.push_str(&format!(
            "export type {type_name}ChangedColumns = Record<{type_name}ChangedField, boolean>;\n"
        ));
        out.push_str(&format!(
            "export type {type_name}ChangedRow = SyncularGeneratedChangedRowBase<{}, {type_name}ChangedField>;\n",
            ts_string(&table.name)
        ));
        out.push_str(&format!(
            "export function {helper_name}(input: SyncularChangedRowsInput): {type_name}ChangedRow[] {{\n"
        ));
        out.push_str(&format!(
            "  return syncularTypedChangedRows(input, {}, syncular{type_name}ChangedFields);\n",
            ts_string(&table.name)
        ));
        out.push_str("}\n\n");
    }

    out.push_str("export type SyncularAppChangedRow =\n");
    if user_tables.is_empty() {
        out.push_str("  never;\n\n");
    } else {
        for (index, table) in user_tables.iter().enumerate() {
            let prefix = if index == 0 { "  " } else { "  | " };
            out.push_str(&format!(
                "{prefix}{}ChangedRow{}\n",
                singular_pascal_case(&table.name),
                if index + 1 == user_tables.len() {
                    ";"
                } else {
                    ""
                }
            ));
        }
        out.push('\n');
    }
    out.push_str("export function syncularAppChangedRows(input: SyncularChangedRowsInput): SyncularAppChangedRow[] {\n");
    out.push_str("  return [\n");
    for table in user_tables {
        out.push_str(&format!(
            "    ...{}ChangedRows(input),\n",
            singular_name(&table.name)
        ));
    }
    out.push_str("  ];\n");
    out.push_str("}\n\n");
    out.push_str("export const syncularChangedRows = {\n");
    for table in user_tables {
        out.push_str(&format!(
            "  {}: {}ChangedRows,\n",
            ts_property_name(&table.name),
            singular_name(&table.name)
        ));
    }
    out.push_str("} as const;\n\n");
}

fn push_swift_changed_row_helpers(out: &mut String, user_tables: &[TableInfo]) {
    for table in user_tables {
        let type_name = singular_pascal_case(&table.name);
        let helper_fn = lower_camel_case(&format!("{}_changed_rows", singular_name(&table.name)));
        out.push_str(&format!(
            "public struct {type_name}ChangedFields: Equatable {{\n"
        ));
        out.push_str("    public let raw: Set<String>\n");
        for column in &table.columns {
            out.push_str(&format!(
                "    public let {}: Bool\n",
                lower_camel_case(&column.name)
            ));
        }
        out.push_str("\n    public init(_ fields: [String]) {\n");
        out.push_str("        let raw = Set(fields)\n");
        out.push_str("        self.raw = raw\n");
        for column in &table.columns {
            out.push_str(&format!(
                "        self.{} = raw.contains({})\n",
                lower_camel_case(&column.name),
                double_quoted_string(&column.name)
            ));
        }
        out.push_str("    }\n\n");
        out.push_str("    public func contains(_ column: String) -> Bool {\n");
        out.push_str("        raw.contains(column)\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "public struct {type_name}ChangedRow: Equatable {{\n"
        ));
        out.push_str("    public let raw: SyncularChangedRow\n");
        out.push_str(&format!(
            "    public let changed: {type_name}ChangedFields\n"
        ));
        out.push_str(&format!(
            "    public let crdt: {type_name}ChangedFields\n\n"
        ));
        out.push_str("    public var rowId: String? { raw.rowId }\n");
        out.push_str("    public var operation: String { raw.operation }\n");
        out.push_str("    public var isInsert: Bool { raw.operation == \"insert\" }\n");
        out.push_str("    public var isUpdate: Bool { raw.operation == \"update\" }\n");
        out.push_str("    public var isDelete: Bool { raw.operation == \"delete\" }\n\n");
        out.push_str("    public init?(_ row: SyncularChangedRow) {\n");
        out.push_str(&format!(
            "        guard row.table == {} else {{ return nil }}\n",
            double_quoted_string(&table.name)
        ));
        out.push_str("        self.raw = row\n");
        out.push_str(&format!(
            "        self.changed = {type_name}ChangedFields(row.changedFields)\n"
        ));
        out.push_str(&format!(
            "        self.crdt = {type_name}ChangedFields(row.crdtFields)\n"
        ));
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "public func {helper_fn}(_ rows: [SyncularChangedRow]) -> [{type_name}ChangedRow] {{\n"
        ));
        out.push_str(&format!(
            "    rows.compactMap({type_name}ChangedRow.init)\n"
        ));
        out.push_str("}\n\n");
        out.push_str(&format!(
            "public func {helper_fn}(in event: SyncularNativeEvent) -> [{type_name}ChangedRow] {{\n"
        ));
        out.push_str(&format!("    {helper_fn}(event.changedRows)\n"));
        out.push_str("}\n\n");
    }
}

fn push_kotlin_changed_row_helpers(out: &mut String, user_tables: &[TableInfo]) {
    for table in user_tables {
        let type_name = singular_pascal_case(&table.name);
        let helper_fn = lower_camel_case(&format!("{}_changed_rows", singular_name(&table.name)));
        out.push_str(&format!(
            "data class {type_name}ChangedFields(val raw: Set<String>) {{\n"
        ));
        out.push_str("    constructor(fields: List<String>) : this(fields.toSet())\n");
        for column in &table.columns {
            out.push_str(&format!(
                "    val {}: Boolean = raw.contains({})\n",
                lower_camel_case(&column.name),
                double_quoted_string(&column.name)
            ));
        }
        out.push_str("\n    fun contains(column: String): Boolean = raw.contains(column)\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "data class {type_name}ChangedRow(\n    val raw: SyncularChangedRow,\n    val changed: {type_name}ChangedFields = {type_name}ChangedFields(raw.changedFields),\n    val crdt: {type_name}ChangedFields = {type_name}ChangedFields(raw.crdtFields),\n) {{\n"
        ));
        out.push_str("    val rowId: String? get() = raw.rowId\n");
        out.push_str("    val operation: String get() = raw.operation\n");
        out.push_str("    val isInsert: Boolean get() = raw.operation == \"insert\"\n");
        out.push_str("    val isUpdate: Boolean get() = raw.operation == \"update\"\n");
        out.push_str("    val isDelete: Boolean get() = raw.operation == \"delete\"\n\n");
        out.push_str("    companion object {\n");
        out.push_str(&format!(
            "        fun from(row: SyncularChangedRow): {type_name}ChangedRow? =\n            if (row.table == {}) {type_name}ChangedRow(row) else null\n",
            double_quoted_string(&table.name)
        ));
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str(&format!(
            "fun {helper_fn}(rows: List<SyncularChangedRow>): List<{type_name}ChangedRow> =\n    rows.mapNotNull {{ {type_name}ChangedRow.from(it) }}\n\n"
        ));
        out.push_str(&format!(
            "fun {helper_fn}(event: SyncularNativeEvent): List<{type_name}ChangedRow> =\n    {helper_fn}(event.changedRows)\n\n"
        ));
    }
}

fn generate_typescript_module(
    tables: &[TableInfo],
    config: &CodegenConfig,
    schema_version: i32,
) -> Result<String> {
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n",
    );
    out.push_str("// Source: migrations/*.sql and syncular.codegen.json\n\n");
    let runtime_import_path = config.typescript_runtime_import_path()?;
    out.push_str(&format!(
        "import {{ SYNCULAR_V2_PACKAGE_NAME, SYNCULAR_V2_PACKAGE_VERSION, SYNCULAR_V2_WORKER_PROTOCOL_VERSION, createSyncularRustSqliteDatabase, withSyncularV2SchemaWrites }} from {};\n",
        ts_string(runtime_import_path)
    ));
    out.push_str(&format!(
        "import type {{ CreateSyncularRustSqliteDatabaseOptions, SyncularRustSqliteDatabase, SyncularV2AppSchema, SyncularV2ChangedRow, SyncularV2FieldEncryptionConfig, SyncularV2FieldEncryptionRule, SyncularV2RowsChangedEvent, SyncularV2RuntimeInfo, SyncularYjsPayloadEnvelope }} from {};\n\n",
        ts_string(runtime_import_path)
    ));
    out.push_str("import { sql, type Kysely } from 'kysely';\n");
    out.push_str(
        "import { codecs, type BlobRef, type ColumnCodecSource } from '@syncular/core';\n\n",
    );
    out.push_str("export interface SyncularGeneratedOperation {\n");
    out.push_str("  table: string;\n");
    out.push_str("  row_id: string;\n");
    out.push_str("  op: 'upsert' | 'delete';\n");
    out.push_str("  payload: Record<string, unknown> | null;\n");
    out.push_str("  base_version?: number | null;\n");
    out.push_str("}\n\n");
    out.push_str("export interface SyncularSubscriptionSpec {\n");
    out.push_str("  id: string;\n");
    out.push_str("  table: string;\n");
    out.push_str("  scopes: Record<string, string | string[]>;\n");
    out.push_str("  params: Record<string, unknown>;\n");
    out.push_str("}\n\n");
    out.push_str("export interface SyncularSubscriptionArgs {\n");
    out.push_str("  actorId: string;\n");
    out.push_str("  projectId?: string | null;\n");
    out.push_str("}\n\n");
    out.push_str("export interface SyncularAppDb {\n");
    for table in &user_tables {
        out.push_str(&format!(
            "  {}: {}Row;\n",
            ts_property_name(&table.name),
            singular_pascal_case(&table.name)
        ));
    }
    out.push_str("}\n\n");
    out.push_str("export interface SyncularGeneratedTableConfig {\n");
    out.push_str("  primaryKeyColumn: string;\n");
    out.push_str("  serverVersionColumn: string;\n");
    out.push_str("  softDeleteColumn: string | null;\n");
    out.push_str("  subscriptionId: string;\n");
    out.push_str("  subscriptionParams: Record<string, unknown>;\n");
    out.push_str("  scopeColumns: Record<string, string>;\n");
    out.push_str("  blobColumns: readonly string[];\n");
    out.push_str("  crdtYjsFields: readonly { field: string; stateColumn: string; containerKey: string; rowIdField: string; kind: 'text' | 'xml-fragment' | 'prosemirror'; syncMode: 'server-merge' | 'encrypted-update-log' }[];\n");
    out.push_str(
        "  encryptedFields: readonly { field: string; scope: string; rowIdField: string }[];\n",
    );
    out.push_str("}\n\n");
    out.push_str(&format!(
        "export const syncularGeneratedSchemaVersion = {schema_version} as const;\n"
    ));
    out.push_str("const syncularGeneratedSchemaId = 'syncular-app';\n\n");
    out.push_str("export const syncularGeneratedRequiredRuntimeFeatures = [\n");
    for feature in required_browser_runtime_features(&user_tables, config) {
        out.push_str(&format!("  {},\n", ts_string(feature)));
    }
    out.push_str("] as const;\n\n");
    out.push_str("export const syncularGeneratedTableConfig = {\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        out.push_str(&format!("  {}: {{\n", ts_property_name(&table.name)));
        out.push_str(&format!(
            "    primaryKeyColumn: {},\n",
            ts_string(&primary_key.name)
        ));
        out.push_str(&format!(
            "    serverVersionColumn: {},\n",
            ts_string(
                table_config
                    .server_version_column
                    .as_deref()
                    .expect("validated table has server version column"),
            )
        ));
        out.push_str(&format!(
            "    softDeleteColumn: {},\n",
            table_config
                .soft_delete_column
                .as_deref()
                .map(ts_string)
                .unwrap_or_else(|| "null".to_string())
        ));
        out.push_str(&format!(
            "    subscriptionId: {},\n",
            ts_string(&table_config.subscription_id(&table.name))
        ));
        out.push_str(&format!(
            "    subscriptionParams: {},\n",
            ts_record_literal(&table_config.subscription_params)
        ));
        out.push_str("    scopeColumns: {\n");
        for scope in table_config.scopes() {
            out.push_str(&format!(
                "      {}: {},\n",
                ts_property_name(scope_name(&scope)),
                ts_string(&scope.column)
            ));
        }
        out.push_str("    },\n");
        out.push_str("    blobColumns: [");
        for (index, column) in table_config.blob_columns.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&ts_string(column));
        }
        out.push_str("],\n");
        out.push_str("    crdtYjsFields: [");
        for (index, field) in table_config.crdt_yjs_fields.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{{ field: {}, stateColumn: {}, containerKey: {}, rowIdField: {}, kind: {}, syncMode: {} }}",
                ts_string(&field.field),
                ts_string(&field.state_column),
                ts_string(field.container_key.as_deref().unwrap_or(&field.field)),
                ts_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name)),
                ts_string(if field.kind.is_empty() {
                    "text"
                } else {
                    &field.kind
                }),
                ts_string(if field.sync_mode.is_empty() {
                    "server-merge"
                } else {
                    &field.sync_mode
                })
            ));
        }
        out.push_str("],\n");
        out.push_str("    encryptedFields: [");
        for (index, field) in table_config.encrypted_fields.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{{ field: {}, scope: {}, rowIdField: {} }}",
                ts_string(&field.field),
                ts_string(field.scope.as_deref().unwrap_or(&table.name)),
                ts_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name))
            ));
        }
        out.push_str("],\n");
        out.push_str("  },\n");
    }
    out.push_str("} satisfies Record<keyof SyncularAppDb, SyncularGeneratedTableConfig>;\n\n");
    out.push_str("export const syncularGeneratedAppSchema = {\n");
    out.push_str("  schemaVersion: syncularGeneratedSchemaVersion,\n");
    out.push_str("  tables: [\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        out.push_str("    {\n");
        out.push_str(&format!("      name: {},\n", ts_string(&table.name)));
        out.push_str(&format!(
            "      primaryKeyColumn: {},\n",
            ts_string(&primary_key.name)
        ));
        out.push_str(&format!(
            "      serverVersionColumn: {},\n",
            ts_string(
                table_config
                    .server_version_column
                    .as_deref()
                    .expect("validated table has server version column"),
            )
        ));
        out.push_str(&format!(
            "      softDeleteColumn: {},\n",
            table_config
                .soft_delete_column
                .as_deref()
                .map(ts_string)
                .unwrap_or_else(|| "null".to_string())
        ));
        out.push_str(&format!(
            "      subscriptionId: {},\n",
            ts_string(&table_config.subscription_id(&table.name))
        ));
        out.push_str("      columns: [\n");
        for column in &table.columns {
            out.push_str(&format!(
                "        {{ name: {}, typeFamily: {}, notnullRequired: {}, primaryKey: {} }},\n",
                ts_string(&column.name),
                ts_string(ts_sqlite_column_type(column)),
                !is_nullable(column) && column.pk == 0,
                column.pk > 0
            ));
        }
        out.push_str("      ],\n");
        out.push_str("      blobColumns: [");
        for (index, column) in table_config.blob_columns.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&ts_string(column));
        }
        out.push_str("],\n");
        out.push_str("      crdtYjsFields: [");
        for (index, field) in table_config.crdt_yjs_fields.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{{ field: {}, stateColumn: {}, containerKey: {}, rowIdField: {}, kind: {}, syncMode: {} }}",
                ts_string(&field.field),
                ts_string(&field.state_column),
                ts_string(field.container_key.as_deref().unwrap_or(&field.field)),
                ts_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name)),
                ts_string(if field.kind.is_empty() {
                    "text"
                } else {
                    &field.kind
                }),
                ts_string(if field.sync_mode.is_empty() {
                    "server-merge"
                } else {
                    &field.sync_mode
                })
            ));
        }
        out.push_str("],\n");
        out.push_str("      encryptedFields: [");
        for (index, field) in table_config.encrypted_fields.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{{ field: {}, scope: {}, rowIdField: {} }}",
                ts_string(&field.field),
                ts_string(field.scope.as_deref().unwrap_or(&table.name)),
                ts_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name))
            ));
        }
        out.push_str("],\n");
        out.push_str("      scopes: [");
        for (index, scope) in table_config.scopes().iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{{ name: {}, column: {}, source: {}, required: {} }}",
                ts_string(scope_name(scope)),
                ts_string(&scope.column),
                ts_string(scope.source.as_deref().expect("validated scope source")),
                scope.required
            ));
        }
        out.push_str("],\n");
        out.push_str("    },\n");
    }
    out.push_str("  ],\n");
    out.push_str("} satisfies SyncularV2AppSchema;\n\n");
    out.push_str("export const syncularGeneratedFieldEncryptionRules = [\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        for field in &table_config.encrypted_fields {
            out.push_str(&format!(
                "  {{ scope: {}, table: {}, fields: [{}], rowIdField: {} }},\n",
                ts_string(field.scope.as_deref().unwrap_or(&table.name)),
                ts_string(&table.name),
                ts_string(&field.field),
                ts_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name))
            ));
        }
    }
    out.push_str("] satisfies readonly SyncularV2FieldEncryptionRule[];\n\n");
    out.push_str("export function syncularGeneratedFieldEncryptionConfig(\n");
    out.push_str("  options: Omit<SyncularV2FieldEncryptionConfig, 'rules'> & { rules?: SyncularV2FieldEncryptionRule[] }\n");
    out.push_str("): SyncularV2FieldEncryptionConfig {\n");
    out.push_str("  return {\n");
    out.push_str("    ...options,\n");
    out.push_str(
        "    rules: [...syncularGeneratedFieldEncryptionRules, ...(options.rules ?? [])],\n",
    );
    out.push_str("  };\n");
    out.push_str("}\n\n");
    out.push_str("export const syncularGeneratedAppTables = [\n");
    for table in &user_tables {
        out.push_str(&format!("  {},\n", ts_string(&table.name)));
    }
    out.push_str("] as const satisfies readonly (keyof SyncularAppDb)[];\n\n");
    push_typescript_changed_row_helpers(&mut out, &user_tables);
    out.push_str("export const syncularGeneratedCodecs: ColumnCodecSource = (column) => {\n");
    out.push_str(
        "  const table = syncularGeneratedTableConfig[column.table as keyof SyncularAppDb];\n",
    );
    out.push_str("  const blobColumns: readonly string[] = table?.blobColumns ?? [];\n");
    out.push_str("  if (blobColumns.includes(column.column)) {\n");
    out.push_str("    return codecs.stringJson<BlobRef>({ ts: { type: 'BlobRef', import: { name: 'BlobRef', from: '@syncular/core' } } });\n");
    out.push_str("  }\n");
    out.push_str("  return undefined;\n");
    out.push_str("};\n\n");
    out.push_str("function withSyncularGeneratedCodecs(userCodecs?: ColumnCodecSource): ColumnCodecSource {\n");
    out.push_str("  return (column) => syncularGeneratedCodecs(column) ?? userCodecs?.(column);\n");
    out.push_str("}\n\n");
    out.push_str(
        "export async function ensureSyncularAppSchema(db: Kysely<any>): Promise<void> {\n",
    );
    out.push_str("  await ensureSyncularAppSchemaMetadata(db);\n");
    for table in &user_tables {
        out.push_str("  await db.schema\n");
        out.push_str(&format!("    .createTable({})\n", ts_string(&table.name)));
        out.push_str("    .ifNotExists()\n");
        for column in &table.columns {
            if let Some(callback) = ts_schema_column_callback(column) {
                out.push_str(&format!(
                    "    .addColumn({}, {}, {})\n",
                    ts_string(&column.name),
                    ts_string(ts_sqlite_column_type(column)),
                    callback
                ));
            } else {
                out.push_str(&format!(
                    "    .addColumn({}, {})\n",
                    ts_string(&column.name),
                    ts_string(ts_sqlite_column_type(column))
                ));
            }
        }
        out.push_str("    .execute();\n\n");
    }
    out.push_str("  await validateSyncularAppSchema(db);\n");
    out.push_str("  await sql`\n");
    out.push_str("    insert into syncular_app_schema (schema_id, schema_version, updated_at)\n");
    out.push_str(
        "    values (${sql.val(syncularGeneratedSchemaId)}, ${sql.val(syncularGeneratedSchemaVersion)}, ${sql.val(Date.now())})\n",
    );
    out.push_str("    on conflict (schema_id) do update set\n");
    out.push_str("      schema_version = excluded.schema_version,\n");
    out.push_str("      updated_at = excluded.updated_at\n");
    out.push_str("  `.execute(db);\n");
    out.push_str("}\n\n");
    out.push_str("interface SyncularGeneratedColumnInfo {\n");
    out.push_str("  name: string;\n");
    out.push_str("  type: string;\n");
    out.push_str("  notnull: number;\n");
    out.push_str("  pk: number;\n");
    out.push_str("}\n\n");
    out.push_str("async function ensureSyncularAppSchemaMetadata(db: Kysely<any>): Promise<number | null> {\n");
    out.push_str("  await db.schema\n");
    out.push_str("    .createTable('syncular_app_schema')\n");
    out.push_str("    .ifNotExists()\n");
    out.push_str("    .addColumn('schema_id', 'text', (col) => col.primaryKey())\n");
    out.push_str("    .addColumn('schema_version', 'integer', (col) => col.notNull())\n");
    out.push_str("    .addColumn('updated_at', 'bigint', (col) => col.notNull())\n");
    out.push_str("    .execute();\n\n");
    out.push_str("  const rows = await sql<{ schema_version: number }>`\n");
    out.push_str("    select schema_version\n");
    out.push_str("    from syncular_app_schema\n");
    out.push_str("    where schema_id = ${sql.val(syncularGeneratedSchemaId)}\n");
    out.push_str("    limit 1\n");
    out.push_str("  `.execute(db);\n");
    out.push_str("  const version = rows.rows[0]?.schema_version;\n");
    out.push_str("  if (version == null) return null;\n");
    out.push_str("  const localVersion = Number(version);\n");
    out.push_str("  if (localVersion !== syncularGeneratedSchemaVersion) {\n");
    out.push_str("    throw new Error(`Syncular app schema version mismatch: local ${localVersion}, generated ${syncularGeneratedSchemaVersion}`);\n");
    out.push_str("  }\n");
    out.push_str("  return localVersion;\n");
    out.push_str("}\n\n");
    out.push_str("async function validateSyncularAppSchema(db: Kysely<any>): Promise<void> {\n");
    for table in &user_tables {
        out.push_str(&format!(
            "  await validateSyncularGeneratedTable(db, {}, [\n",
            ts_string(&table.name)
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    {{ name: {}, type: {}, notnull: {}, pk: {} }},\n",
                ts_string(&column.name),
                ts_string(ts_sqlite_column_type(column)),
                if is_nullable(column) || column.pk > 0 {
                    0
                } else {
                    1
                },
                if column.pk > 0 { 1 } else { 0 }
            ));
        }
        out.push_str("  ]);\n");
    }
    out.push_str("}\n\n");
    out.push_str("async function validateSyncularGeneratedTable(db: Kysely<any>, table: string, expected: SyncularGeneratedColumnInfo[]): Promise<void> {\n");
    out.push_str("  const rows = await sql<SyncularGeneratedColumnInfo>`\n");
    out.push_str("    select name, type, \"notnull\" as \"notnull\", pk\n");
    out.push_str("    from pragma_table_info(${sql.val(table)})\n");
    out.push_str("  `.execute(db);\n");
    out.push_str("  const actual = new Map(rows.rows.map((row) => [row.name, row]));\n");
    out.push_str("  for (const column of expected) {\n");
    out.push_str("    const found = actual.get(column.name);\n");
    out.push_str("    if (!found) throw new Error(`Syncular app schema mismatch: ${table}.${column.name} is missing`);\n");
    out.push_str("    if (sqliteTypeFamily(found.type) !== column.type) {\n");
    out.push_str("      throw new Error(`Syncular app schema mismatch: ${table}.${column.name} has type ${found.type}, expected ${column.type}`);\n");
    out.push_str("    }\n");
    out.push_str("    if (column.pk > 0 && Number(found.pk) <= 0) {\n");
    out.push_str("      throw new Error(`Syncular app schema mismatch: ${table}.${column.name} is not a primary key`);\n");
    out.push_str("    }\n");
    out.push_str(
        "    if (column.notnull > 0 && Number(found.notnull) <= 0 && Number(found.pk) <= 0) {\n",
    );
    out.push_str("      throw new Error(`Syncular app schema mismatch: ${table}.${column.name} is nullable`);\n");
    out.push_str("    }\n");
    out.push_str("  }\n");
    out.push_str("}\n\n");
    out.push_str("function sqliteTypeFamily(type: string | null | undefined): string {\n");
    out.push_str("  const upper = String(type ?? '').toUpperCase();\n");
    out.push_str("  if (upper.includes('INT')) return 'integer';\n");
    out.push_str("  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'real';\n");
    out.push_str("  if (upper.includes('BLOB')) return 'blob';\n");
    out.push_str("  return 'text';\n");
    out.push_str("}\n\n");
    out.push_str("export type SyncularAppDatabase = SyncularRustSqliteDatabase<SyncularAppDb>;\n");
    out.push_str("export type SyncularAppSubscriptionsOption =\n");
    out.push_str("  | false\n");
    out.push_str("  | readonly SyncularSubscriptionSpec[]\n");
    out.push_str(
        "  | ((args: SyncularSubscriptionArgs) => readonly SyncularSubscriptionSpec[]);\n\n",
    );
    out.push_str("export interface CreateSyncularAppDatabaseOptions extends CreateSyncularRustSqliteDatabaseOptions {\n");
    out.push_str("  subscriptions?: SyncularAppSubscriptionsOption;\n");
    out.push_str("}\n\n");
    out.push_str("export async function assertSyncularAppRuntime(database: Pick<SyncularAppDatabase, 'client'>): Promise<void> {\n");
    out.push_str("  assertSyncularAppRuntimeInfo(await database.client.runtimeInfo());\n");
    out.push_str("  const schemaState = await database.client.generatedSchemaState();\n");
    out.push_str("  if (schemaState.currentSchemaVersion !== syncularGeneratedSchemaVersion) {\n");
    out.push_str("    throw new Error(`Syncular Rust app schema version mismatch: ${schemaState.currentSchemaVersion}, expected ${syncularGeneratedSchemaVersion}`);\n");
    out.push_str("  }\n");
    out.push_str("}\n\n");
    out.push_str("export function assertSyncularAppRuntimeInfo(runtimeInfo: SyncularV2RuntimeInfo): void {\n");
    out.push_str("  if (runtimeInfo.packageName !== SYNCULAR_V2_PACKAGE_NAME) {\n");
    out.push_str("    throw new Error(`Syncular runtime package mismatch: ${runtimeInfo.packageName}, expected ${SYNCULAR_V2_PACKAGE_NAME}`);\n");
    out.push_str("  }\n");
    out.push_str("  if (runtimeInfo.packageVersion !== SYNCULAR_V2_PACKAGE_VERSION) {\n");
    out.push_str("    throw new Error(`Syncular runtime package version mismatch: ${runtimeInfo.packageVersion}, expected ${SYNCULAR_V2_PACKAGE_VERSION}`);\n");
    out.push_str("  }\n");
    out.push_str(
        "  if (runtimeInfo.workerProtocolVersion !== SYNCULAR_V2_WORKER_PROTOCOL_VERSION) {\n",
    );
    out.push_str("    throw new Error(`Syncular worker protocol mismatch: ${runtimeInfo.workerProtocolVersion}, expected ${SYNCULAR_V2_WORKER_PROTOCOL_VERSION}`);\n");
    out.push_str("  }\n");
    out.push_str("  if (!runtimeInfo.rust) {\n");
    out.push_str(
        "    throw new Error('Syncular runtime did not report Rust runtime information');\n",
    );
    out.push_str("  }\n");
    out.push_str("  for (const feature of syncularGeneratedRequiredRuntimeFeatures) {\n");
    out.push_str("    if (!runtimeInfo.rust.features.includes(feature)) {\n");
    out.push_str("      throw new Error(`Syncular Rust runtime is missing ${feature} support`);\n");
    out.push_str("    }\n");
    out.push_str("  }\n");
    out.push_str("}\n\n");
    out.push_str("function resolveSyncularAppSubscriptions(options: CreateSyncularAppDatabaseOptions): readonly SyncularSubscriptionSpec[] {\n");
    out.push_str("  const args: SyncularSubscriptionArgs = {\n");
    out.push_str("    actorId: options.config.actorId,\n");
    out.push_str("    projectId: options.config.projectId,\n");
    out.push_str("  };\n");
    out.push_str("  const subscriptions = options.subscriptions;\n");
    out.push_str("  if (subscriptions === false) return [];\n");
    out.push_str("  if (typeof subscriptions === 'function') return subscriptions(args);\n");
    out.push_str("  return subscriptions ?? defaultSyncularSubscriptions(args);\n");
    out.push_str("}\n\n");
    out.push_str("export async function createSyncularAppDatabase(\n");
    out.push_str("  options: CreateSyncularAppDatabaseOptions\n");
    out.push_str("): Promise<SyncularAppDatabase> {\n");
    out.push_str("  const database = await createSyncularRustSqliteDatabase<SyncularAppDb>({\n");
    out.push_str("    ...options,\n");
    out.push_str("    config: {\n");
    out.push_str("      ...options.config,\n");
    out.push_str(
        "      schemaVersion: options.config.schemaVersion ?? syncularGeneratedSchemaVersion,\n",
    );
    out.push_str("      appSchema: options.config.appSchema ?? syncularGeneratedAppSchema,\n");
    out.push_str("    },\n");
    out.push_str("    codecs: withSyncularGeneratedCodecs(options.codecs),\n");
    out.push_str("    appTables: syncularGeneratedAppTables,\n");
    out.push_str("    tableConfig: { ...options.tableConfig, ...syncularGeneratedTableConfig },\n");
    out.push_str("    requiredRuntimeFeatures: syncularGeneratedRequiredRuntimeFeatures,\n");
    out.push_str("  });\n");
    out.push_str("  try {\n");
    out.push_str("    await assertSyncularAppRuntime(database);\n");
    out.push_str("    await withSyncularV2SchemaWrites(database, ensureSyncularAppSchema);\n");
    out.push_str(
        "    await database.client.setSubscriptions(resolveSyncularAppSubscriptions(options));\n",
    );
    out.push_str("    return database;\n");
    out.push_str("  } catch (err) {\n");
    out.push_str("    await database.close();\n");
    out.push_str("    throw err;\n");
    out.push_str("  }\n");
    out.push_str("}\n\n");

    out.push_str(
        "export function defaultSyncularSubscriptions(args: SyncularSubscriptionArgs): SyncularSubscriptionSpec[] {\n",
    );
    out.push_str("  return [\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&format!(
            "    {}Subscription(args),\n",
            singular_name(&table.name)
        ));
        for field in encrypted_update_log_crdt_fields(&table_config) {
            out.push_str(&format!(
                "    {}(args),\n",
                ts_encrypted_crdt_subscription_fn(table, field, "updates")
            ));
            out.push_str(&format!(
                "    {}(args),\n",
                ts_encrypted_crdt_subscription_fn(table, field, "checkpoints")
            ));
        }
    }
    out.push_str("  ];\n");
    out.push_str("}\n\n");

    for table in &user_tables {
        let config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;

        out.push_str(&format!("export interface {type_name}Row {{\n"));
        for column in &table.columns {
            out.push_str(&format!(
                "  {}: {};\n",
                ts_property_name(&column.name),
                ts_app_type(column, &config)
            ));
        }
        out.push_str("}\n\n");

        let crdt_field_union = config
            .crdt_yjs_fields
            .iter()
            .filter(|field| is_server_merge_crdt_field(field))
            .map(|field| ts_string(&field.field))
            .collect::<Vec<_>>()
            .join(" | ");
        let crdt_envelope_type = if !has_server_merge_crdt_fields(&config) {
            String::new()
        } else {
            format!(" extends SyncularYjsPayloadEnvelope<{crdt_field_union}>")
        };

        out.push_str(&format!(
            "export interface New{type_name}{crdt_envelope_type} {{\n"
        ));
        let insert_columns = table
            .columns
            .iter()
            .filter(|column| !is_server_managed_column(column, &config))
            .collect::<Vec<_>>();
        for column in &insert_columns {
            let optional = ts_input_optional(column, &config);
            out.push_str(&format!(
                "  {}{}: {};\n",
                ts_property_name(&column.name),
                if optional { "?" } else { "" },
                ts_app_type(column, &config)
            ));
        }
        out.push_str("}\n\n");

        let payload_columns = table
            .columns
            .iter()
            .filter(|column| column.pk == 0)
            .filter(|column| !is_server_managed_column(column, &config))
            .collect::<Vec<_>>();

        out.push_str(&format!("export interface New{type_name}Payload {{\n"));
        for column in &payload_columns {
            let optional = ts_input_optional(column, &config) && !has_sql_default(column);
            out.push_str(&format!(
                "  {}{}: {};\n",
                ts_property_name(&column.name),
                if optional { "?" } else { "" },
                ts_app_type(column, &config)
            ));
        }
        out.push_str("}\n\n");

        out.push_str(&format!(
            "export type {type_name}Patch = Partial<Pick<{type_name}Row, "
        ));
        let patch_columns = payload_columns
            .iter()
            .map(|column| ts_string(&column.name))
            .collect::<Vec<_>>();
        out.push_str(&patch_columns.join(" | "));
        out.push_str(">>");
        if has_server_merge_crdt_fields(&config) {
            out.push_str(&format!(
                " & SyncularYjsPayloadEnvelope<{crdt_field_union}>"
            ));
        }
        out.push_str(";\n\n");

        out.push_str(&format!(
            "export function new{type_name}Payload(input: New{type_name}): New{type_name}Payload {{\n"
        ));
        out.push_str(&format!(
            "  const payload: Partial<New{type_name}Payload> = {{\n"
        ));
        for column in payload_columns
            .iter()
            .filter(|column| !ts_input_optional(column, &config))
        {
            let prop = ts_property_name(&column.name);
            out.push_str(&format!(
                "    {}: {},\n",
                prop,
                ts_member("input", &column.name)
            ));
        }
        out.push_str("  };\n");
        for column in payload_columns
            .iter()
            .filter(|column| ts_input_optional(column, &config))
        {
            let input_member = ts_member("input", &column.name);
            let payload_member = ts_member("payload", &column.name);
            if has_sql_default(column) && !is_nullable(column) {
                out.push_str(&format!(
                    "  {payload_member} = {input_member} ?? {};\n",
                    ts_default_value(column)
                ));
            } else {
                out.push_str(&format!(
                    "  if ({input_member} !== undefined) {payload_member} = {input_member};\n"
                ));
            }
        }
        if has_server_merge_crdt_fields(&config) {
            out.push_str("  if (input.__yjs !== undefined) (payload as Record<string, unknown>).__yjs = input.__yjs;\n");
            for field in config
                .crdt_yjs_fields
                .iter()
                .filter(|field| is_server_merge_crdt_field(field))
            {
                let yjs_member = ts_optional_member("input.__yjs", &field.field);
                let payload_field = ts_member("(payload as Record<string, unknown>)", &field.field);
                let payload_state =
                    ts_member("(payload as Record<string, unknown>)", &field.state_column);
                out.push_str(&format!(
                    "  if ({yjs_member} !== undefined) {{\n    delete {payload_field};\n    delete {payload_state};\n  }}\n"
                ));
            }
        }
        out.push_str(&format!(
            "  return payload as New{type_name}Payload;\n}}\n\n"
        ));

        out.push_str(&format!(
            "export function {}PatchPayload(patch: {type_name}Patch): {type_name}Patch {{\n",
            singular_name(&table.name)
        ));
        out.push_str(&format!("  const payload: {type_name}Patch = {{}};\n"));
        for column in &payload_columns {
            let patch_member = ts_member("patch", &column.name);
            let payload_member = ts_member("payload", &column.name);
            out.push_str(&format!(
                "  if ({patch_member} !== undefined) {payload_member} = {patch_member};\n"
            ));
        }
        if has_server_merge_crdt_fields(&config) {
            out.push_str("  if (patch.__yjs !== undefined) (payload as Record<string, unknown>).__yjs = patch.__yjs;\n");
            for field in config
                .crdt_yjs_fields
                .iter()
                .filter(|field| is_server_merge_crdt_field(field))
            {
                let yjs_member = ts_optional_member("patch.__yjs", &field.field);
                let payload_field = ts_member("(payload as Record<string, unknown>)", &field.field);
                let payload_state =
                    ts_member("(payload as Record<string, unknown>)", &field.state_column);
                out.push_str(&format!(
                    "  if ({yjs_member} !== undefined) {{\n    delete {payload_field};\n    delete {payload_state};\n  }}\n"
                ));
            }
        }
        out.push_str("  return payload;\n}\n\n");

        out.push_str(&format!(
            "export function new{type_name}Operation(input: New{type_name}, baseVersion: number | null = 0): SyncularGeneratedOperation {{\n"
        ));
        out.push_str(&format!(
            "  const payload = new{type_name}Payload(input);\n"
        ));
        out.push_str("  return {\n");
        out.push_str(&format!("    table: {},\n", ts_string(&table.name)));
        out.push_str(&format!(
            "    row_id: String({}),\n",
            ts_member("input", &primary_key.name)
        ));
        out.push_str(
            "    op: 'upsert',\n    payload: payload as unknown as Record<string, unknown>,\n    base_version: baseVersion,\n  };\n}\n\n",
        );

        out.push_str(&format!(
            "export function patch{type_name}Operation(rowId: string, patch: {type_name}Patch, baseVersion: number | null = null): SyncularGeneratedOperation {{\n"
        ));
        out.push_str(&format!(
            "  const payload = {}PatchPayload(patch);\n",
            singular_name(&table.name)
        ));
        out.push_str("  return {\n");
        out.push_str(&format!("    table: {},\n", ts_string(&table.name)));
        out.push_str("    row_id: rowId,\n    op: 'upsert',\n    payload: payload as unknown as Record<string, unknown>,\n    base_version: baseVersion,\n  };\n}\n\n");

        out.push_str(&format!(
            "export function delete{type_name}Operation(rowId: string, baseVersion: number | null = null): SyncularGeneratedOperation {{\n"
        ));
        if let Some(column) = soft_delete_column(table, &config) {
            out.push_str("  return {\n");
            out.push_str(&format!("    table: {},\n", ts_string(&table.name)));
            out.push_str("    row_id: rowId,\n");
            out.push_str("    op: 'upsert',\n");
            out.push_str(&format!(
                "    payload: {{ {}: 1 }},\n",
                ts_property_name(&column.name)
            ));
            out.push_str("    base_version: baseVersion,\n  };\n}\n\n");
        } else {
            out.push_str("  return {\n");
            out.push_str(&format!("    table: {},\n", ts_string(&table.name)));
            out.push_str("    row_id: rowId,\n    op: 'delete',\n    payload: null,\n    base_version: baseVersion,\n  };\n}\n\n");
        }

        out.push_str(&format!(
            "export function {}Subscription(args: SyncularSubscriptionArgs): SyncularSubscriptionSpec {{\n",
            singular_name(&table.name)
        ));
        out.push_str("  const scopes: Record<string, string | string[]> = {};\n");
        for scope in config.scopes() {
            let name = scope_name(&scope);
            match scope.source.as_deref() {
                Some("actorId") => {
                    out.push_str(&format!("  scopes[{}] = args.actorId;\n", ts_string(name)));
                }
                Some("projectId") => {
                    out.push_str(&format!(
                        "  if (args.projectId != null) scopes[{}] = args.projectId;\n",
                        ts_string(name)
                    ));
                }
                _ => {}
            }
        }
        out.push_str("  return {\n");
        out.push_str(&format!(
            "    id: {},\n",
            ts_string(&config.subscription_id(&table.name))
        ));
        out.push_str(&format!("    table: {},\n", ts_string(&table.name)));
        out.push_str(&format!(
            "    scopes,\n    params: {},\n  }};\n}}\n\n",
            ts_record_literal(&config.subscription_params)
        ));
        for field in encrypted_update_log_crdt_fields(&config) {
            for (suffix, system_table) in [
                ("updates", "sync_crdt_updates"),
                ("checkpoints", "sync_crdt_checkpoints"),
            ] {
                out.push_str(&format!(
                    "export function {}(args: SyncularSubscriptionArgs): SyncularSubscriptionSpec {{\n",
                    ts_encrypted_crdt_subscription_fn(table, field, suffix)
                ));
                out.push_str("  const scopes: Record<string, string | string[]> = {};\n");
                for scope in config.scopes() {
                    let name = scope_name(&scope);
                    match scope.source.as_deref() {
                        Some("actorId") => {
                            out.push_str(&format!(
                                "  scopes[{}] = args.actorId;\n",
                                ts_string(name)
                            ));
                        }
                        Some("projectId") => {
                            out.push_str(&format!(
                                "  if (args.projectId != null) scopes[{}] = args.projectId;\n",
                                ts_string(name)
                            ));
                        }
                        _ => {}
                    }
                }
                out.push_str("  return {\n");
                out.push_str(&format!(
                    "    id: {},\n",
                    ts_string(&format!(
                        "sub-{}-{}-crdt-{}",
                        table.name, field.field, suffix
                    ))
                ));
                out.push_str(&format!("    table: {},\n", ts_string(system_table)));
                out.push_str(&format!(
                    "    scopes,\n    params: {{ app_table: {}, field_name: {} }},\n  }};\n}}\n\n",
                    ts_string(&table.name),
                    ts_string(&field.field)
                ));
            }
        }
    }

    Ok(format!("{}\n", out.trim_end()))
}

fn generate_swift_module(
    tables: &[TableInfo],
    config: &CodegenConfig,
    schema_version: i32,
    app_schema_json: &str,
) -> Result<String> {
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let has_native_crdt = user_tables
        .iter()
        .any(|table| has_crdt_yjs_fields(&config.table(&table.name)));
    let has_native_encrypted_crdt = user_tables
        .iter()
        .any(|table| has_encrypted_update_log_crdt_fields(&config.table(&table.name)));
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n",
    );
    out.push_str("// Source: migrations/*.sql and syncular.codegen.json\n\n");
    out.push_str("import Foundation\n\n");
    out.push_str(&format!(
        "public let syncularNativeExpectedFfiAbiVersion = 1\npublic let syncularNativeExpectedCrateVersion = {}\npublic let syncularNativeGeneratedSchemaVersion = {schema_version}\n\n",
        double_quoted_string(env!("CARGO_PKG_VERSION"))
    ));
    out.push_str(&format!(
        "public let syncularNativeGeneratedAppSchemaJson = {}\n\n",
        double_quoted_string(app_schema_json)
    ));
    out.push_str("public enum SyncularNativeGeneratedError: Error, Equatable {\n");
    out.push_str("    case runtimeManifestMismatch(String)\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularNativeRuntimeManifest: Decodable, Equatable {\n");
    out.push_str("    public let ffiAbiVersion: Int\n");
    out.push_str("    public let crateName: String\n");
    out.push_str("    public let crateVersion: String\n");
    out.push_str("    public let schemaVersion: Int\n");
    out.push_str("    public let storageBackend: String\n");
    out.push_str("    public let transportBackends: [String]\n");
    out.push_str("    public let capabilities: [String]\n\n");
    out.push_str("    private enum CodingKeys: String, CodingKey {\n");
    out.push_str("        case ffiAbiVersion = \"ffi_abi_version\"\n");
    out.push_str("        case crateName = \"crate_name\"\n");
    out.push_str("        case crateVersion = \"crate_version\"\n");
    out.push_str("        case schemaVersion = \"schema_version\"\n");
    out.push_str("        case storageBackend = \"storage_backend\"\n");
    out.push_str("        case transportBackends = \"transport_backends\"\n");
    out.push_str("        case capabilities\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str(
        "public func assertSyncularNativeRuntimeManifestJson(_ manifestJson: String) throws {\n",
    );
    out.push_str("    let data = Data(manifestJson.utf8)\n");
    out.push_str("    let manifest = try JSONDecoder().decode(SyncularNativeRuntimeManifest.self, from: data)\n");
    out.push_str("    try assertSyncularNativeRuntimeManifest(manifest)\n");
    out.push_str("}\n\n");
    out.push_str("public func assertSyncularNativeRuntimeManifest(_ manifest: SyncularNativeRuntimeManifest) throws {\n");
    out.push_str(
        "    guard manifest.ffiAbiVersion == syncularNativeExpectedFfiAbiVersion else {\n",
    );
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"FFI ABI version \\(manifest.ffiAbiVersion) does not match generated expectation \\(syncularNativeExpectedFfiAbiVersion)\")\n");
    out.push_str("    }\n");
    out.push_str("    guard manifest.crateVersion == syncularNativeExpectedCrateVersion else {\n");
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust crate version \\(manifest.crateVersion) does not match generated expectation \\(syncularNativeExpectedCrateVersion)\")\n");
    out.push_str("    }\n");
    out.push_str("    guard manifest.storageBackend == \"diesel-sqlite\" else {\n");
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust storage backend \\(manifest.storageBackend) is not diesel-sqlite\")\n");
    out.push_str("    }\n");
    out.push_str(
        "    guard manifest.capabilities.contains(\"generated-json-local-operations\") else {\n",
    );
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing generated-json-local-operations\")\n");
    out.push_str("    }\n");
    out.push_str("    guard manifest.capabilities.contains(\"generated-json-mutations\") else {\n");
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing generated-json-mutations\")\n");
    out.push_str("    }\n");
    out.push_str("    guard manifest.capabilities.contains(\"read-only-query-json\") else {\n");
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing read-only-query-json\")\n");
    out.push_str("    }\n");
    out.push_str("    guard manifest.capabilities.contains(\"query-observer-events\") else {\n");
    out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing query-observer-events\")\n");
    out.push_str("    }\n");
    if has_native_encrypted_crdt {
        out.push_str(
            "    guard manifest.capabilities.contains(\"queued-encrypted-crdt\") else {\n",
        );
        out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing queued-encrypted-crdt\")\n");
        out.push_str("    }\n");
    }
    if has_native_crdt {
        out.push_str(
            "    guard manifest.capabilities.contains(\"generic-crdt-field-api\") else {\n",
        );
        out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing generic-crdt-field-api\")\n");
        out.push_str("    }\n");
        out.push_str(
            "    guard manifest.capabilities.contains(\"queued-crdt-field-updates\") else {\n",
        );
        out.push_str("        throw SyncularNativeGeneratedError.runtimeManifestMismatch(\"Rust native runtime is missing queued-crdt-field-updates\")\n");
        out.push_str("    }\n");
    }
    out.push_str("}\n\n");
    out.push_str("public enum SyncularGeneratedOperationKind: String, Codable, Equatable {\n");
    out.push_str("    case upsert\n");
    out.push_str("    case delete\n");
    out.push_str("}\n\n");
    out.push_str("public indirect enum SyncularJsonValue: Codable, Equatable {\n");
    out.push_str("    case string(String)\n");
    out.push_str("    case int(Int64)\n");
    out.push_str("    case double(Double)\n");
    out.push_str("    case bool(Bool)\n");
    out.push_str("    case object([String: SyncularJsonValue])\n");
    out.push_str("    case array([SyncularJsonValue])\n");
    out.push_str("    case null\n\n");
    out.push_str("    public init(from decoder: Decoder) throws {\n");
    out.push_str("        let container = try decoder.singleValueContainer()\n");
    out.push_str("        if container.decodeNil() { self = .null }\n");
    out.push_str(
        "        else if let value = try? container.decode(Bool.self) { self = .bool(value) }\n",
    );
    out.push_str(
        "        else if let value = try? container.decode(Int64.self) { self = .int(value) }\n",
    );
    out.push_str("        else if let value = try? container.decode(Double.self) { self = .double(value) }\n");
    out.push_str("        else if let value = try? container.decode([String: SyncularJsonValue].self) { self = .object(value) }\n");
    out.push_str("        else if let value = try? container.decode([SyncularJsonValue].self) { self = .array(value) }\n");
    out.push_str("        else { self = .string(try container.decode(String.self)) }\n");
    out.push_str("    }\n\n");
    out.push_str("    public func encode(to encoder: Encoder) throws {\n");
    out.push_str("        var container = encoder.singleValueContainer()\n");
    out.push_str("        switch self {\n");
    out.push_str("        case .string(let value): try container.encode(value)\n");
    out.push_str("        case .int(let value): try container.encode(value)\n");
    out.push_str("        case .double(let value): try container.encode(value)\n");
    out.push_str("        case .bool(let value): try container.encode(value)\n");
    out.push_str("        case .object(let value): try container.encode(value)\n");
    out.push_str("        case .array(let value): try container.encode(value)\n");
    out.push_str("        case .null: try container.encodeNil()\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularBlobRef: Codable, Equatable {\n");
    out.push_str("    public let hash: String\n");
    out.push_str("    public let size: Int64\n");
    out.push_str("    public let mimeType: String\n");
    out.push_str("    public let encrypted: Bool?\n");
    out.push_str("    public let keyId: String?\n\n");
    out.push_str("    public init(hash: String, size: Int64, mimeType: String, encrypted: Bool? = nil, keyId: String? = nil) {\n");
    out.push_str("        self.hash = hash\n");
    out.push_str("        self.size = size\n");
    out.push_str("        self.mimeType = mimeType\n");
    out.push_str("        self.encrypted = encrypted\n");
    out.push_str("        self.keyId = keyId\n");
    out.push_str("    }\n\n");
    out.push_str("    private enum CodingKeys: String, CodingKey {\n");
    out.push_str("        case hash\n");
    out.push_str("        case size\n");
    out.push_str("        case mimeType\n");
    out.push_str("        case encrypted\n");
    out.push_str("        case keyId\n");
    out.push_str("    }\n\n");
    out.push_str("    public init(from decoder: Decoder) throws {\n");
    out.push_str("        let single = try decoder.singleValueContainer()\n");
    out.push_str("        if let encoded = try? single.decode(String.self) {\n");
    out.push_str("            self = try JSONDecoder().decode(SyncularBlobRef.self, from: Data(encoded.utf8))\n");
    out.push_str("            return\n");
    out.push_str("        }\n");
    out.push_str("        let container = try decoder.container(keyedBy: CodingKeys.self)\n");
    out.push_str("        hash = try container.decode(String.self, forKey: .hash)\n");
    out.push_str("        size = try container.decode(Int64.self, forKey: .size)\n");
    out.push_str("        mimeType = try container.decode(String.self, forKey: .mimeType)\n");
    out.push_str(
        "        encrypted = try container.decodeIfPresent(Bool.self, forKey: .encrypted)\n",
    );
    out.push_str("        keyId = try container.decodeIfPresent(String.self, forKey: .keyId)\n");
    out.push_str("    }\n\n");
    out.push_str("    public func encode(to encoder: Encoder) throws {\n");
    out.push_str("        var container = encoder.container(keyedBy: CodingKeys.self)\n");
    out.push_str("        try container.encode(hash, forKey: .hash)\n");
    out.push_str("        try container.encode(size, forKey: .size)\n");
    out.push_str("        try container.encode(mimeType, forKey: .mimeType)\n");
    out.push_str("        try container.encodeIfPresent(encrypted, forKey: .encrypted)\n");
    out.push_str("        try container.encodeIfPresent(keyId, forKey: .keyId)\n");
    out.push_str("    }\n\n");
    out.push_str("    public var syncularPayloadValue: SyncularJsonValue {\n");
    out.push_str("        var value: [String: SyncularJsonValue] = [\n");
    out.push_str("            \"hash\": .string(hash),\n");
    out.push_str("            \"size\": .int(size),\n");
    out.push_str("            \"mimeType\": .string(mimeType),\n");
    out.push_str("        ]\n");
    out.push_str("        if let encrypted { value[\"encrypted\"] = .bool(encrypted) }\n");
    out.push_str("        if let keyId { value[\"keyId\"] = .string(keyId) }\n");
    out.push_str("        return .object(value)\n");
    out.push_str("    }\n");
    out.push_str("\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularSubscriptionArgs: Equatable {\n");
    out.push_str("    public let actorId: String\n");
    out.push_str("    public let projectId: String?\n\n");
    out.push_str("    public init(actorId: String, projectId: String? = nil) {\n");
    out.push_str("        self.actorId = actorId\n");
    out.push_str("        self.projectId = projectId\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularSubscriptionSpec: Codable, Equatable {\n");
    out.push_str("    public let id: String\n");
    out.push_str("    public let table: String\n");
    out.push_str("    public let scopes: [String: SyncularJsonValue]\n");
    out.push_str("    public let params: [String: SyncularJsonValue]\n\n");
    out.push_str("    public init(id: String, table: String, scopes: [String: SyncularJsonValue], params: [String: SyncularJsonValue] = [:]) {\n");
    out.push_str("        self.id = id\n");
    out.push_str("        self.table = table\n");
    out.push_str("        self.scopes = scopes\n");
    out.push_str("        self.params = params\n");
    out.push_str("    }\n\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public func syncularSubscriptionsJson(_ subscriptions: [SyncularSubscriptionSpec]) throws -> String {\n");
    out.push_str("    let encoder = JSONEncoder()\n");
    out.push_str("    encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("    return String(data: try encoder.encode(subscriptions), encoding: .utf8)!\n");
    out.push_str("}\n\n");
    out.push_str("public func syncularDefaultSubscriptionsJson(actorId: String, projectId: String? = nil) throws -> String {\n");
    out.push_str("    try syncularSubscriptionsJson(syncularDefaultSubscriptions(args: SyncularSubscriptionArgs(actorId: actorId, projectId: projectId)))\n");
    out.push_str("}\n\n");
    out.push_str("public func syncularDefaultSubscriptions(args: SyncularSubscriptionArgs) -> [SyncularSubscriptionSpec] {\n");
    out.push_str("    [\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&format!(
            "        {}(args: args),\n",
            native_table_subscription_fn(table)
        ));
        for field in encrypted_update_log_crdt_fields(&table_config) {
            out.push_str(&format!(
                "        {}(args: args),\n",
                native_encrypted_crdt_subscription_fn(table, field, "updates")
            ));
            out.push_str(&format!(
                "        {}(args: args),\n",
                native_encrypted_crdt_subscription_fn(table, field, "checkpoints")
            ));
        }
    }
    out.push_str("    ]\n");
    out.push_str("}\n\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&format!(
            "public func {}(args: SyncularSubscriptionArgs) -> SyncularSubscriptionSpec {{\n",
            native_table_subscription_fn(table)
        ));
        out.push_str("    var scopes: [String: SyncularJsonValue] = [:]\n");
        for scope in table_config.scopes() {
            let name = scope_name(&scope);
            match (scope.source.as_deref(), scope.required) {
                (Some("actorId"), _) => out.push_str(&format!(
                    "    scopes[{}] = .string(args.actorId)\n",
                    double_quoted_string(name)
                )),
                (Some("projectId"), true) => {
                    out.push_str("    precondition(args.projectId != nil, \"projectId scope requires projectId\")\n");
                    out.push_str(&format!(
                        "    scopes[{}] = .string(args.projectId!)\n",
                        double_quoted_string(name)
                    ));
                }
                (Some("projectId"), false) => out.push_str(&format!(
                    "    if let projectId = args.projectId {{ scopes[{}] = .string(projectId) }}\n",
                    double_quoted_string(name)
                )),
                (_, true) => out.push_str(&format!(
                    "    scopes[{}] = .string(\"\")\n",
                    double_quoted_string(name)
                )),
                (_, false) => {}
            }
        }
        out.push_str(&format!(
            "    return SyncularSubscriptionSpec(id: {}, table: {}, scopes: scopes, params: {})\n",
            double_quoted_string(&table_config.subscription_id(&table.name)),
            double_quoted_string(&table.name),
            swift_json_record_literal(&table_config.subscription_params)
        ));
        out.push_str("}\n\n");
        for field in encrypted_update_log_crdt_fields(&table_config) {
            for (suffix, system_table) in [
                ("updates", "sync_crdt_updates"),
                ("checkpoints", "sync_crdt_checkpoints"),
            ] {
                out.push_str(&format!(
                    "public func {}(args: SyncularSubscriptionArgs) -> SyncularSubscriptionSpec {{\n",
                    native_encrypted_crdt_subscription_fn(table, field, suffix)
                ));
                out.push_str("    var scopes: [String: SyncularJsonValue] = [:]\n");
                for scope in table_config.scopes() {
                    let name = scope_name(&scope);
                    match (scope.source.as_deref(), scope.required) {
                        (Some("actorId"), _) => out.push_str(&format!(
                            "    scopes[{}] = .string(args.actorId)\n",
                            double_quoted_string(name)
                        )),
                        (Some("projectId"), true) => {
                            out.push_str("    precondition(args.projectId != nil, \"projectId scope requires projectId\")\n");
                            out.push_str(&format!(
                                "    scopes[{}] = .string(args.projectId!)\n",
                                double_quoted_string(name)
                            ));
                        }
                        (Some("projectId"), false) => out.push_str(&format!(
                            "    if let projectId = args.projectId {{ scopes[{}] = .string(projectId) }}\n",
                            double_quoted_string(name)
                        )),
                        (_, true) => out.push_str(&format!(
                            "    scopes[{}] = .string(\"\")\n",
                            double_quoted_string(name)
                        )),
                        (_, false) => {}
                    }
                }
                out.push_str(&format!(
                    "    return SyncularSubscriptionSpec(id: {}, table: {}, scopes: scopes, params: [\"app_table\": .string({}), \"field_name\": .string({})])\n",
                    double_quoted_string(&format!("sub-{}-{}-crdt-{}", table.name, field.field, suffix)),
                    double_quoted_string(system_table),
                    double_quoted_string(&table.name),
                    double_quoted_string(&field.field)
                ));
                out.push_str("}\n\n");
            }
        }
    }
    out.push_str("public struct SyncularReadonlyQuery: Codable, Equatable {\n");
    out.push_str("    public let sql: String\n");
    out.push_str("    public let params: [SyncularJsonValue]\n");
    out.push_str("    public let tables: [String]\n\n");
    out.push_str(
        "    public init(sql: String, params: [SyncularJsonValue] = [], tables: [String]) {\n",
    );
    out.push_str("        self.sql = sql\n");
    out.push_str("        self.params = params\n");
    out.push_str("        self.tables = tables\n");
    out.push_str("    }\n\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularLiveQueryRegistration: Codable, Equatable {\n");
    out.push_str("    public let id: String\n");
    out.push_str("    public let tables: [String]\n");
    out.push_str("    public let label: String?\n\n");
    out.push_str("    public init(id: String, tables: [String], label: String? = nil) {\n");
    out.push_str("        self.id = id\n");
    out.push_str("        self.tables = tables\n");
    out.push_str("        self.label = label\n");
    out.push_str("    }\n\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularChangedRow: Decodable, Equatable {\n");
    out.push_str("    public let table: String\n");
    out.push_str("    public let rowId: String?\n");
    out.push_str("    public let operation: String\n");
    out.push_str("    public let changedFields: [String]\n");
    out.push_str("    public let crdtFields: [String]\n");
    out.push_str("    public let commitId: String?\n");
    out.push_str("    public let commitSeq: Int64?\n");
    out.push_str("    public let subscriptionId: String?\n");
    out.push_str("    public let serverVersion: Int64?\n\n");
    out.push_str(
        "    public init(table: String, rowId: String? = nil, operation: String, changedFields: [String] = [], crdtFields: [String] = [], commitId: String? = nil, commitSeq: Int64? = nil, subscriptionId: String? = nil, serverVersion: Int64? = nil) {\n",
    );
    out.push_str("        self.table = table\n");
    out.push_str("        self.rowId = rowId\n");
    out.push_str("        self.operation = operation\n");
    out.push_str("        self.changedFields = changedFields\n");
    out.push_str("        self.crdtFields = crdtFields\n");
    out.push_str("        self.commitId = commitId\n");
    out.push_str("        self.commitSeq = commitSeq\n");
    out.push_str("        self.subscriptionId = subscriptionId\n");
    out.push_str("        self.serverVersion = serverVersion\n");
    out.push_str("    }\n\n");
    out.push_str("    private enum CodingKeys: String, CodingKey {\n");
    out.push_str("        case table\n");
    out.push_str("        case rowId\n");
    out.push_str("        case operation\n");
    out.push_str("        case changedFields\n");
    out.push_str("        case crdtFields\n");
    out.push_str("        case commitId\n");
    out.push_str("        case commitSeq\n");
    out.push_str("        case subscriptionId\n");
    out.push_str("        case serverVersion\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularNativeEvent: Decodable, Equatable {\n");
    out.push_str("    public let eventSeq: UInt64\n");
    out.push_str("    public let kind: String\n");
    out.push_str("    public let tables: [String]\n");
    out.push_str("    public let queries: [String]\n");
    out.push_str("    public let changedRows: [SyncularChangedRow]\n");
    out.push_str("    public let commandId: String?\n");
    out.push_str("    public let clientCommitId: String?\n");
    out.push_str("    public let durationMs: UInt64?\n\n");
    out.push_str(
        "    public init(eventSeq: UInt64 = 0, kind: String, tables: [String] = [], queries: [String] = [], changedRows: [SyncularChangedRow] = [], commandId: String? = nil, clientCommitId: String? = nil, durationMs: UInt64? = nil) {\n",
    );
    out.push_str("        self.eventSeq = eventSeq\n");
    out.push_str("        self.kind = kind\n");
    out.push_str("        self.tables = tables\n");
    out.push_str("        self.queries = queries\n");
    out.push_str("        self.changedRows = changedRows\n");
    out.push_str("        self.commandId = commandId\n");
    out.push_str("        self.clientCommitId = clientCommitId\n");
    out.push_str("        self.durationMs = durationMs\n");
    out.push_str("    }\n\n");
    out.push_str("    private enum CodingKeys: String, CodingKey {\n");
    out.push_str("        case eventSeq = \"event_seq\"\n");
    out.push_str("        case kind\n");
    out.push_str("        case tables\n");
    out.push_str("        case queries\n");
    out.push_str("        case changedRows\n");
    out.push_str("        case commandId = \"command_id\"\n");
    out.push_str("        case clientCommitId = \"client_commit_id\"\n");
    out.push_str("        case durationMs = \"duration_ms\"\n");
    out.push_str("    }\n\n");
    out.push_str("    public init(from decoder: Decoder) throws {\n");
    out.push_str("        let container = try decoder.container(keyedBy: CodingKeys.self)\n");
    out.push_str(
        "        eventSeq = try container.decodeIfPresent(UInt64.self, forKey: .eventSeq) ?? 0\n",
    );
    out.push_str("        kind = try container.decode(String.self, forKey: .kind)\n");
    out.push_str(
        "        tables = try container.decodeIfPresent([String].self, forKey: .tables) ?? []\n",
    );
    out.push_str(
        "        queries = try container.decodeIfPresent([String].self, forKey: .queries) ?? []\n",
    );
    out.push_str(
        "        changedRows = try container.decodeIfPresent([SyncularChangedRow].self, forKey: .changedRows) ?? []\n",
    );
    out.push_str(
        "        commandId = try container.decodeIfPresent(String.self, forKey: .commandId)\n",
    );
    out.push_str("        clientCommitId = try container.decodeIfPresent(String.self, forKey: .clientCommitId)\n");
    out.push_str(
        "        durationMs = try container.decodeIfPresent(UInt64.self, forKey: .durationMs)\n",
    );
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public func syncularDecodeNativeEvent(_ eventJson: String) throws -> SyncularNativeEvent {\n");
    out.push_str(
        "    try JSONDecoder().decode(SyncularNativeEvent.self, from: Data(eventJson.utf8))\n",
    );
    out.push_str("}\n\n");
    push_swift_changed_row_helpers(&mut out, &user_tables);
    out.push_str("public struct SyncularGeneratedOperation: Codable, Equatable {\n");
    out.push_str("    public let table: String\n");
    out.push_str("    public let rowId: String\n");
    out.push_str("    public let op: SyncularGeneratedOperationKind\n");
    out.push_str("    public let payload: [String: SyncularJsonValue]?\n");
    out.push_str("    public let baseVersion: Int64?\n\n");
    out.push_str("    public init(table: String, rowId: String, op: SyncularGeneratedOperationKind, payload: [String: SyncularJsonValue]?, baseVersion: Int64?) {\n");
    out.push_str("        self.table = table\n");
    out.push_str("        self.rowId = rowId\n");
    out.push_str("        self.op = op\n");
    out.push_str("        self.payload = payload\n");
    out.push_str("        self.baseVersion = baseVersion\n");
    out.push_str("    }\n\n");
    out.push_str("    private enum CodingKeys: String, CodingKey {\n");
    out.push_str("        case table\n");
    out.push_str("        case rowId = \"row_id\"\n");
    out.push_str("        case op\n");
    out.push_str("        case payload\n");
    out.push_str("        case baseVersion = \"base_version\"\n");
    out.push_str("    }\n\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("\n");
    out.push_str("    public func encode(to encoder: Encoder) throws {\n");
    out.push_str("        var container = encoder.container(keyedBy: CodingKeys.self)\n");
    out.push_str("        try container.encode(table, forKey: .table)\n");
    out.push_str("        try container.encode(rowId, forKey: .rowId)\n");
    out.push_str("        try container.encode(op, forKey: .op)\n");
    out.push_str("        if let payload {\n");
    out.push_str("            try container.encode(payload, forKey: .payload)\n");
    out.push_str("        } else {\n");
    out.push_str("            try container.encodeNil(forKey: .payload)\n");
    out.push_str("        }\n");
    out.push_str("        if let baseVersion {\n");
    out.push_str("            try container.encode(baseVersion, forKey: .baseVersion)\n");
    out.push_str("        } else {\n");
    out.push_str("            try container.encodeNil(forKey: .baseVersion)\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularFieldEncryptionRule: Codable, Equatable {\n");
    out.push_str("    public let scope: String\n");
    out.push_str("    public let table: String?\n");
    out.push_str("    public let fields: [String]\n");
    out.push_str("    public let rowIdField: String?\n\n");
    out.push_str(
        "    public init(scope: String, table: String?, fields: [String], rowIdField: String?) {\n",
    );
    out.push_str("        self.scope = scope\n");
    out.push_str("        self.table = table\n");
    out.push_str("        self.fields = fields\n");
    out.push_str("        self.rowIdField = rowIdField\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularFieldEncryptionConfig: Codable, Equatable {\n");
    out.push_str("    public let rules: [SyncularFieldEncryptionRule]\n");
    out.push_str("    public let keys: [String: String]\n");
    out.push_str("    public let encryptionKid: String?\n");
    out.push_str("    public let decryptionErrorMode: String?\n");
    out.push_str("    public let envelopePrefix: String?\n\n");
    out.push_str("    public init(keys: [String: String], rules: [SyncularFieldEncryptionRule] = syncularGeneratedFieldEncryptionRules, encryptionKid: String? = nil, decryptionErrorMode: String? = nil, envelopePrefix: String? = nil) {\n");
    out.push_str("        self.rules = rules\n");
    out.push_str("        self.keys = keys\n");
    out.push_str("        self.encryptionKid = encryptionKid\n");
    out.push_str("        self.decryptionErrorMode = decryptionErrorMode\n");
    out.push_str("        self.envelopePrefix = envelopePrefix\n");
    out.push_str("    }\n\n");
    out.push_str("    public func jsonString() throws -> String {\n");
    out.push_str("        let encoder = JSONEncoder()\n");
    out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
    out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str(
        "public let syncularGeneratedFieldEncryptionRules: [SyncularFieldEncryptionRule] = [\n",
    );
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        for field in &table_config.encrypted_fields {
            out.push_str(&format!(
                "    SyncularFieldEncryptionRule(scope: {}, table: {}, fields: [{}], rowIdField: {}),\n",
                double_quoted_string(field.scope.as_deref().unwrap_or(&table.name)),
                double_quoted_string(&table.name),
                double_quoted_string(&field.field),
                double_quoted_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name))
            ));
        }
    }
    out.push_str("]\n\n");
    out.push_str("public func syncularGeneratedFieldEncryptionConfigJson(keys: [String: String], encryptionKid: String? = nil, decryptionErrorMode: String? = nil, envelopePrefix: String? = nil, additionalRules: [SyncularFieldEncryptionRule] = []) throws -> String {\n");
    out.push_str("    try SyncularFieldEncryptionConfig(keys: keys, rules: syncularGeneratedFieldEncryptionRules + additionalRules, encryptionKid: encryptionKid, decryptionErrorMode: decryptionErrorMode, envelopePrefix: envelopePrefix).jsonString()\n");
    out.push_str("}\n\n");
    if has_native_crdt {
        out.push_str("public struct SyncularYjsUpdateEnvelope: Codable, Equatable {\n");
        out.push_str("    public let updateId: String\n");
        out.push_str("    public let updateBase64: String\n\n");
        out.push_str("    public init(updateId: String, updateBase64: String) {\n");
        out.push_str("        self.updateId = updateId\n");
        out.push_str("        self.updateBase64 = updateBase64\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldRequest: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let field: String\n\n");
        out.push_str("    public init(table: String, rowId: String, field: String) {\n");
        out.push_str("        self.table = table\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.field = field\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldTextRequest: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let nextText: String\n\n");
        out.push_str(
            "    public init(table: String, rowId: String, field: String, nextText: String) {\n",
        );
        out.push_str("        self.table = table\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.field = field\n");
        out.push_str("        self.nextText = nextText\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldYjsUpdateRequest: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let update: SyncularYjsUpdateEnvelope\n\n");
        out.push_str("    public init(table: String, rowId: String, field: String, update: SyncularYjsUpdateEnvelope) {\n");
        out.push_str("        self.table = table\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.field = field\n");
        out.push_str("        self.update = update\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldCompactionRequest: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let minUncheckpointedUpdates: Int64?\n\n");
        out.push_str("    public init(table: String, rowId: String, field: String, minUncheckpointedUpdates: Int64? = nil) {\n");
        out.push_str("        self.table = table\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.field = field\n");
        out.push_str("        self.minUncheckpointedUpdates = minUncheckpointedUpdates\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldDescriptor: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let stateColumn: String\n");
        out.push_str("    public let containerKey: String\n");
        out.push_str("    public let rowIdField: String\n");
        out.push_str("    public let syncMode: String\n");
        out.push_str("    public let kind: String\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldWriteReceipt: Codable, Equatable {\n");
        out.push_str("    public let clientCommitId: String\n");
        out.push_str("    public let syncMode: String\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldMaterialization: Codable, Equatable {\n");
        out.push_str("    public let value: SyncularJsonValue\n");
        out.push_str("    public let stateBase64: String?\n");
        out.push_str("    public let stateVectorBase64: String\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldStateVector: Codable, Equatable {\n");
        out.push_str("    public let stateVectorBase64: String\n");
        out.push_str("}\n\n");
        out.push_str("public struct SyncularCrdtFieldCompactionReceipt: Codable, Equatable {\n");
        out.push_str("    public let checkpointCreated: Bool\n");
        out.push_str("    public let clientCommitId: String?\n");
        out.push_str("}\n\n");
    }
    if has_native_encrypted_crdt {
        out.push_str("public struct SyncularEncryptedCrdtUpdateRequest: Codable, Equatable {\n");
        out.push_str("    public let table: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let nextText: String?\n");
        out.push_str("    public let update: SyncularYjsUpdateEnvelope?\n\n");
        out.push_str("    public init(table: String, field: String, rowId: String, nextText: String? = nil, update: SyncularYjsUpdateEnvelope? = nil) {\n");
        out.push_str("        self.table = table\n");
        out.push_str("        self.field = field\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.nextText = nextText\n");
        out.push_str("        self.update = update\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
        out.push_str(
            "public struct SyncularEncryptedCrdtCheckpointRequest: Codable, Equatable {\n",
        );
        out.push_str("    public let table: String\n");
        out.push_str("    public let field: String\n");
        out.push_str("    public let rowId: String\n");
        out.push_str("    public let minUncheckpointedUpdates: Int64?\n\n");
        out.push_str("    public init(table: String, field: String, rowId: String, minUncheckpointedUpdates: Int64? = nil) {\n");
        out.push_str("        self.table = table\n");
        out.push_str("        self.field = field\n");
        out.push_str("        self.rowId = rowId\n");
        out.push_str("        self.minUncheckpointedUpdates = minUncheckpointedUpdates\n");
        out.push_str("    }\n\n");
        out.push_str("    public func jsonString() throws -> String {\n");
        out.push_str("        let encoder = JSONEncoder()\n");
        out.push_str("        encoder.outputFormatting = [.sortedKeys]\n");
        out.push_str("        return String(data: try encoder.encode(self), encoding: .utf8)!\n");
        out.push_str("    }\n");
        out.push_str("}\n\n");
    }
    out.push_str("public protocol SyncularNativeJsonClient {\n");
    out.push_str("    func applyMutationJson(mutationJson: String, localRowJson: String?) throws -> String\n");
    out.push_str("    func enqueueMutationJson(mutationJson: String, localRowJson: String?) throws -> String\n");
    if has_native_crdt {
        out.push_str("    func openCrdtFieldJson(requestJson: String) throws -> String\n");
        out.push_str("    func applyCrdtFieldTextJson(requestJson: String) throws -> String\n");
        out.push_str(
            "    func applyCrdtFieldYjsUpdateJson(requestJson: String) throws -> String\n",
        );
        out.push_str(
            "    func enqueueCrdtFieldYjsUpdateJson(requestJson: String) throws -> String\n",
        );
        out.push_str("    func enqueueCrdtFieldTextJson(requestJson: String) throws -> String\n");
        out.push_str(
            "    func enqueueCrdtFieldCompactionJson(requestJson: String) throws -> String\n",
        );
        out.push_str("    func materializeCrdtFieldJson(requestJson: String) throws -> String\n");
        out.push_str(
            "    func snapshotCrdtFieldStateVectorJson(requestJson: String) throws -> String\n",
        );
        out.push_str("    func compactCrdtFieldJson(requestJson: String) throws -> String\n");
    }
    if has_native_encrypted_crdt {
        out.push_str(
            "    func applyEncryptedCrdtUpdateJson(requestJson: String) throws -> String\n",
        );
        out.push_str(
            "    func enqueueEncryptedCrdtUpdateJson(requestJson: String) throws -> String\n",
        );
        out.push_str(
            "    func applyEncryptedCrdtCheckpointJson(requestJson: String) throws -> String\n",
        );
        out.push_str(
            "    func enqueueEncryptedCrdtCheckpointJson(requestJson: String) throws -> String\n",
        );
    }
    out.push_str("    func queryJson(requestJson: String) throws -> String\n");
    out.push_str("    func registerQueryJson(queryJson: String) throws -> String\n");
    out.push_str("    func unregisterQuery(id: String) throws -> Bool\n");
    out.push_str("}\n\n");
    out.push_str("public extension SyncularNativeJsonClient {\n");
    out.push_str("    func apply(_ operation: SyncularGeneratedOperation, localRowJson: String? = nil) throws -> String {\n");
    out.push_str(
        "        try applyMutationJson(mutationJson: operation.jsonString(), localRowJson: localRowJson)\n",
    );
    out.push_str("    }\n");
    out.push_str("\n");
    out.push_str("    func enqueue(_ operation: SyncularGeneratedOperation, localRowJson: String? = nil) throws -> String {\n");
    out.push_str("        try enqueueMutationJson(mutationJson: operation.jsonString(), localRowJson: localRowJson)\n");
    out.push_str("    }\n");
    out.push_str("\n");
    if has_native_crdt {
        out.push_str("    func openCrdtField(_ request: SyncularCrdtFieldRequest) throws -> SyncularCrdtFieldDescriptor {\n");
        out.push_str("        try syncularDecodeJson(openCrdtFieldJson(requestJson: request.jsonString()), as: SyncularCrdtFieldDescriptor.self)\n");
        out.push_str("    }\n\n");
        out.push_str("    func applyCrdtFieldText(_ request: SyncularCrdtFieldTextRequest) throws -> SyncularCrdtFieldWriteReceipt {\n");
        out.push_str("        try syncularDecodeJson(applyCrdtFieldTextJson(requestJson: request.jsonString()), as: SyncularCrdtFieldWriteReceipt.self)\n");
        out.push_str("    }\n\n");
        out.push_str("    func applyCrdtFieldYjsUpdate(_ request: SyncularCrdtFieldYjsUpdateRequest) throws -> SyncularCrdtFieldWriteReceipt {\n");
        out.push_str("        try syncularDecodeJson(applyCrdtFieldYjsUpdateJson(requestJson: request.jsonString()), as: SyncularCrdtFieldWriteReceipt.self)\n");
        out.push_str("    }\n\n");
        out.push_str("    func materializeCrdtField(_ request: SyncularCrdtFieldRequest) throws -> SyncularCrdtFieldMaterialization {\n");
        out.push_str("        try syncularDecodeJson(materializeCrdtFieldJson(requestJson: request.jsonString()), as: SyncularCrdtFieldMaterialization.self)\n");
        out.push_str("    }\n\n");
        out.push_str("    func snapshotCrdtFieldStateVector(_ request: SyncularCrdtFieldRequest) throws -> SyncularCrdtFieldStateVector {\n");
        out.push_str("        try syncularDecodeJson(snapshotCrdtFieldStateVectorJson(requestJson: request.jsonString()), as: SyncularCrdtFieldStateVector.self)\n");
        out.push_str("    }\n\n");
        out.push_str("    func compactCrdtField(_ request: SyncularCrdtFieldCompactionRequest) throws -> SyncularCrdtFieldCompactionReceipt {\n");
        out.push_str("        try syncularDecodeJson(compactCrdtFieldJson(requestJson: request.jsonString()), as: SyncularCrdtFieldCompactionReceipt.self)\n");
        out.push_str("    }\n\n");
    }
    out.push_str("    func query<Row: Decodable>(_ query: SyncularReadonlyQuery, as type: Row.Type) throws -> [Row] {\n");
    out.push_str("        try syncularDecodeQueryRows(queryJson(requestJson: query.jsonString()), as: Row.self)\n");
    out.push_str("    }\n");
    out.push_str("\n");
    out.push_str("    func registerLiveQuery(_ registration: SyncularLiveQueryRegistration) throws -> String {\n");
    out.push_str("        try registerQueryJson(queryJson: registration.jsonString())\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public final class SyncularNativeLiveQuery<Row: Decodable> {\n");
    out.push_str("    public let id: String\n");
    out.push_str("    public let query: SyncularReadonlyQuery\n");
    out.push_str("    public let label: String?\n");
    out.push_str("    public private(set) var rows: [Row] = []\n");
    out.push_str("    private let rowType: Row.Type\n\n");
    out.push_str("    public init(id: String, query: SyncularReadonlyQuery, as rowType: Row.Type, label: String? = nil) {\n");
    out.push_str("        self.id = id\n");
    out.push_str("        self.query = query\n");
    out.push_str("        self.label = label\n");
    out.push_str("        self.rowType = rowType\n");
    out.push_str("    }\n\n");
    out.push_str("    @discardableResult\n");
    out.push_str("    public func start(on client: SyncularNativeJsonClient) throws -> [Row] {\n");
    out.push_str("        _ = try client.registerLiveQuery(SyncularLiveQueryRegistration(id: id, tables: query.tables, label: label))\n");
    out.push_str("        return try refresh(on: client)\n");
    out.push_str("    }\n\n");
    out.push_str("    @discardableResult\n");
    out.push_str(
        "    public func refresh(on client: SyncularNativeJsonClient) throws -> [Row] {\n",
    );
    out.push_str("        rows = try client.query(query, as: rowType)\n");
    out.push_str("        return rows\n");
    out.push_str("    }\n\n");
    out.push_str("    @discardableResult\n");
    out.push_str("    public func stop(on client: SyncularNativeJsonClient) throws -> Bool {\n");
    out.push_str("        try client.unregisterQuery(id: id)\n");
    out.push_str("    }\n\n");
    out.push_str("    public func matches(queryIds: [String]) -> Bool {\n");
    out.push_str("        queryIds.contains(id)\n");
    out.push_str("    }\n");
    out.push_str("\n");
    out.push_str("    @discardableResult\n");
    out.push_str("    public func refreshIfChanged(event: SyncularNativeEvent, on client: SyncularNativeJsonClient) throws -> [Row]? {\n");
    out.push_str(
        "        guard event.kind == \"QueriesChanged\", matches(queryIds: event.queries) else {\n",
    );
    out.push_str("            return nil\n");
    out.push_str("        }\n");
    out.push_str("        return try refresh(on: client)\n");
    out.push_str("    }\n\n");
    out.push_str("    @discardableResult\n");
    out.push_str("    public func refreshIfChanged(eventJson: String, on client: SyncularNativeJsonClient) throws -> [Row]? {\n");
    out.push_str(
        "        try refreshIfChanged(event: syncularDecodeNativeEvent(eventJson), on: client)\n",
    );
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("private func syncularDecodeJson<T: Decodable>(_ json: String, as type: T.Type) throws -> T {\n");
    out.push_str("    try JSONDecoder().decode(T.self, from: Data(json.utf8))\n");
    out.push_str("}\n\n");
    out.push_str("private struct SyncularQueryResult<Row: Decodable>: Decodable {\n");
    out.push_str("    let rows: [Row]\n");
    out.push_str("}\n\n");
    out.push_str("private func syncularDecodeQueryRows<Row: Decodable>(_ json: String, as type: Row.Type) throws -> [Row] {\n");
    out.push_str(
        "    try JSONDecoder().decode(SyncularQueryResult<Row>.self, from: Data(json.utf8)).rows\n",
    );
    out.push_str("}\n\n");
    out.push_str("public protocol SyncularQueryValue {\n");
    out.push_str("    var syncularJsonValue: SyncularJsonValue { get }\n");
    out.push_str("}\n\n");
    out.push_str("extension String: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .string(self) } }\n");
    out.push_str("extension Int: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .int(Int64(self)) } }\n");
    out.push_str("extension Int64: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .int(self) } }\n");
    out.push_str("extension Double: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .double(self) } }\n");
    out.push_str("extension Bool: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .bool(self) } }\n\n");
    out.push_str("extension SyncularBlobRef: SyncularQueryValue { public var syncularJsonValue: SyncularJsonValue { .string((try? jsonString()) ?? \"{}\") } }\n\n");
    out.push_str("public struct SyncularQueryPredicate: Equatable {\n");
    out.push_str("    public let sql: String\n");
    out.push_str("    public let params: [SyncularJsonValue]\n");
    out.push_str("\n");
    out.push_str("    public init(sql: String, params: [SyncularJsonValue] = []) {\n");
    out.push_str("        self.sql = sql\n");
    out.push_str("        self.params = params\n");
    out.push_str("    }\n\n");
    out.push_str(
        "    public func and(_ other: SyncularQueryPredicate) -> SyncularQueryPredicate {\n",
    );
    out.push_str("        SyncularQueryPredicate(sql: \"((\\(sql)) and (\\(other.sql)))\", params: params + other.params)\n");
    out.push_str("    }\n\n");
    out.push_str(
        "    public func or(_ other: SyncularQueryPredicate) -> SyncularQueryPredicate {\n",
    );
    out.push_str("        SyncularQueryPredicate(sql: \"((\\(sql)) or (\\(other.sql)))\", params: params + other.params)\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularQueryOrder: Equatable {\n");
    out.push_str("    public let sql: String\n");
    out.push_str("\n");
    out.push_str("    public init(sql: String) {\n");
    out.push_str("        self.sql = sql\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularQueryColumn<Value>: Equatable {\n");
    out.push_str("    public let table: String\n");
    out.push_str("    public let name: String\n\n");
    out.push_str("    public init(table: String, name: String) {\n");
    out.push_str("        self.table = table\n");
    out.push_str("        self.name = name\n");
    out.push_str("    }\n\n");
    out.push_str("    public func eq(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) = ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func notEq(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) != ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func gt(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) > ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func gte(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) >= ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func lt(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) < ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func lte(_ value: Value) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) <= ?\", params: [value.syncularJsonValue])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func isNull() -> SyncularQueryPredicate {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) is null\", params: [])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func isNotNull() -> SyncularQueryPredicate {\n");
    out.push_str("        SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) is not null\", params: [])\n");
    out.push_str("    }\n\n");
    out.push_str("    public func isIn(_ values: [Value]) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str(
        "        guard !values.isEmpty else { return SyncularQueryPredicate(sql: \"0 = 1\") }\n",
    );
    out.push_str("        let placeholders = Array(repeating: \"?\", count: values.count).joined(separator: \", \")\n");
    out.push_str("        return SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) in (\\(placeholders))\", params: values.map(\\.syncularJsonValue))\n");
    out.push_str("    }\n\n");
    out.push_str("    public func notIn(_ values: [Value]) -> SyncularQueryPredicate where Value: SyncularQueryValue {\n");
    out.push_str(
        "        guard !values.isEmpty else { return SyncularQueryPredicate(sql: \"1 = 1\") }\n",
    );
    out.push_str("        let placeholders = Array(repeating: \"?\", count: values.count).joined(separator: \", \")\n");
    out.push_str("        return SyncularQueryPredicate(sql: \"\\(syncularQuoteIdentifier(name)) not in (\\(placeholders))\", params: values.map(\\.syncularJsonValue))\n");
    out.push_str("    }\n\n");
    out.push_str("    public func asc() -> SyncularQueryOrder {\n");
    out.push_str("        SyncularQueryOrder(sql: \"\\(syncularQuoteIdentifier(name)) asc\")\n");
    out.push_str("    }\n\n");
    out.push_str("    public func desc() -> SyncularQueryOrder {\n");
    out.push_str("        SyncularQueryOrder(sql: \"\\(syncularQuoteIdentifier(name)) desc\")\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularQueryTable<Row: Decodable>: Equatable {\n");
    out.push_str("    public let name: String\n");
    out.push_str("    public let columns: [String]\n\n");
    out.push_str("    public init(name: String, columns: [String]) {\n");
    out.push_str("        self.name = name\n");
    out.push_str("        self.columns = columns\n");
    out.push_str("    }\n\n");
    out.push_str("    public func select() -> SyncularSelectQuery<Row> {\n");
    out.push_str("        SyncularSelectQuery(table: self)\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("public struct SyncularSelectQuery<Row: Decodable>: Equatable {\n");
    out.push_str("    public let table: SyncularQueryTable<Row>\n");
    out.push_str("    public let predicates: [SyncularQueryPredicate]\n");
    out.push_str("    public let orders: [SyncularQueryOrder]\n");
    out.push_str("    public let limitValue: Int?\n\n");
    out.push_str("    public init(table: SyncularQueryTable<Row>, predicates: [SyncularQueryPredicate] = [], orders: [SyncularQueryOrder] = [], limitValue: Int? = nil) {\n");
    out.push_str("        self.table = table\n");
    out.push_str("        self.predicates = predicates\n");
    out.push_str("        self.orders = orders\n");
    out.push_str("        self.limitValue = limitValue\n");
    out.push_str("    }\n\n");
    out.push_str("    public func filter(_ predicate: SyncularQueryPredicate) -> Self {\n");
    out.push_str("        Self(table: table, predicates: predicates + [predicate], orders: orders, limitValue: limitValue)\n");
    out.push_str("    }\n\n");
    out.push_str("    public func orderBy(_ order: SyncularQueryOrder) -> Self {\n");
    out.push_str("        Self(table: table, predicates: predicates, orders: orders + [order], limitValue: limitValue)\n");
    out.push_str("    }\n\n");
    out.push_str("    public func limit(_ value: Int) -> Self {\n");
    out.push_str(
        "        Self(table: table, predicates: predicates, orders: orders, limitValue: value)\n",
    );
    out.push_str("    }\n\n");
    out.push_str("    public func readonlyQuery() -> SyncularReadonlyQuery {\n");
    out.push_str("        let columnSql = table.columns.map(syncularQuoteIdentifier).joined(separator: \", \")\n");
    out.push_str(
        "        var sql = \"select \\(columnSql) from \\(syncularQuoteIdentifier(table.name))\"\n",
    );
    out.push_str("        var params: [SyncularJsonValue] = []\n");
    out.push_str("        if !predicates.isEmpty {\n");
    out.push_str(
        "            sql += \" where \" + predicates.map(\\.sql).joined(separator: \" and \")\n",
    );
    out.push_str("            params = predicates.flatMap(\\.params)\n");
    out.push_str("        }\n");
    out.push_str("        if !orders.isEmpty {\n");
    out.push_str(
        "            sql += \" order by \" + orders.map(\\.sql).joined(separator: \", \")\n",
    );
    out.push_str("        }\n");
    out.push_str("        if let limitValue {\n");
    out.push_str("            sql += \" limit \\(limitValue)\"\n");
    out.push_str("        }\n");
    out.push_str(
        "        return SyncularReadonlyQuery(sql: sql, params: params, tables: [table.name])\n",
    );
    out.push_str("    }\n\n");
    out.push_str("    public func fetch(on client: SyncularNativeJsonClient) throws -> [Row] {\n");
    out.push_str("        try client.query(readonlyQuery(), as: Row.self)\n");
    out.push_str("    }\n\n");
    out.push_str("    public func liveQuery(id: String, label: String? = nil) -> SyncularNativeLiveQuery<Row> {\n");
    out.push_str("        SyncularNativeLiveQuery(id: id, query: readonlyQuery(), as: Row.self, label: label)\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("private func syncularQuoteIdentifier(_ identifier: String) -> String {\n");
    out.push_str("    \"\\\"\" + identifier.replacingOccurrences(of: \"\\\"\", with: \"\\\"\\\"\") + \"\\\"\"\n");
    out.push_str("}\n\n");

    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let insert_columns = table
            .columns
            .iter()
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();
        let payload_columns = table
            .columns
            .iter()
            .filter(|column| column.pk == 0)
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();

        out.push_str(&format!(
            "public struct {type_name}Row: Codable, Equatable {{\n"
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    public let {}: {}\n",
                lower_camel_case(&column.name),
                swift_app_type(column, &table_config, is_nullable(column))
            ));
        }
        push_swift_coding_keys(&mut out, table.columns.iter());
        out.push_str("}\n\n");

        out.push_str(&format!(
            "public struct New{type_name}: Codable, Equatable {{\n"
        ));
        for column in &insert_columns {
            out.push_str(&format!(
                "    public let {}: {}\n",
                lower_camel_case(&column.name),
                swift_app_type(
                    column,
                    &table_config,
                    ts_input_optional(column, &table_config)
                )
            ));
        }
        out.push('\n');
        out.push_str("    public init(");
        for (index, column) in insert_columns.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            let optional = ts_input_optional(column, &table_config);
            out.push_str(&format!(
                "{}: {}{}",
                lower_camel_case(&column.name),
                swift_app_type(column, &table_config, optional),
                if optional { " = nil" } else { "" }
            ));
        }
        out.push_str(") {\n");
        for column in &insert_columns {
            let name = lower_camel_case(&column.name);
            out.push_str(&format!("        self.{name} = {name}\n"));
        }
        out.push_str("    }\n");
        push_swift_coding_keys(&mut out, insert_columns.iter().copied());
        out.push_str("}\n\n");

        out.push_str(&format!(
            "public struct {type_name}Patch: Codable, Equatable {{\n"
        ));
        for column in &payload_columns {
            out.push_str(&format!(
                "    public let {}: {}\n",
                lower_camel_case(&column.name),
                swift_app_type(column, &table_config, true)
            ));
        }
        out.push('\n');
        out.push_str("    public init(");
        for (index, column) in payload_columns.iter().enumerate() {
            if index > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!(
                "{}: {} = nil",
                lower_camel_case(&column.name),
                swift_app_type(column, &table_config, true)
            ));
        }
        out.push_str(") {\n");
        for column in &payload_columns {
            let name = lower_camel_case(&column.name);
            out.push_str(&format!("        self.{name} = {name}\n"));
        }
        out.push_str("    }\n");
        push_swift_coding_keys(&mut out, payload_columns.iter().copied());
        out.push_str("}\n\n");
    }
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let query_name = format!("{type_name}Query");
        let columns = table
            .columns
            .iter()
            .map(|column| double_quoted_string(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("public enum {query_name} {{\n"));
        out.push_str(&format!(
            "    public static let table = SyncularQueryTable<{type_name}Row>(name: {}, columns: [{columns}])\n",
            double_quoted_string(&table.name)
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    public static let {} = SyncularQueryColumn<{}>(table: {}, name: {})\n",
                lower_camel_case(&column.name),
                swift_app_type(column, &table_config, false),
                double_quoted_string(&table.name),
                double_quoted_string(&column.name)
            ));
        }
        out.push_str(&format!(
            "    public static func select() -> SyncularSelectQuery<{type_name}Row> {{ table.select() }}\n"
        ));
        out.push_str("}\n\n");
    }

    out.push_str("public enum SyncularAppOperations {\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        let payload_columns = table
            .columns
            .iter()
            .filter(|column| column.pk == 0)
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();

        out.push_str(&format!(
            "    public static func new{type_name}(_ input: New{type_name}, baseVersion: Int64? = 0) -> SyncularGeneratedOperation {{\n"
        ));
        out.push_str("        var payload: [String: SyncularJsonValue] = [:]\n");
        for column in &payload_columns {
            let property = lower_camel_case(&column.name);
            let key = double_quoted_string(&column.name);
            if ts_input_optional(column, &table_config) {
                if has_sql_default(column) && !is_nullable(column) {
                    let expr = format!("input.{property} ?? {}", swift_default_value(column));
                    out.push_str(&format!(
                        "        payload[{key}] = {}\n",
                        swift_payload_value(column, &table_config, &expr)
                    ));
                } else {
                    out.push_str(&format!("        if let value = input.{property} {{\n"));
                    out.push_str(&format!(
                        "            payload[{key}] = {}\n",
                        swift_payload_value(column, &table_config, "value")
                    ));
                    out.push_str("        }\n");
                }
            } else {
                out.push_str(&format!(
                    "        payload[{key}] = {}\n",
                    swift_payload_value(column, &table_config, &format!("input.{property}"))
                ));
            }
        }
        out.push_str("        return SyncularGeneratedOperation(\n");
        out.push_str(&format!(
            "            table: {},\n",
            double_quoted_string(&table.name)
        ));
        out.push_str(&format!(
            "            rowId: {},\n",
            swift_row_id_input_expr(primary_key)
        ));
        out.push_str("            op: .upsert,\n");
        out.push_str("            payload: payload,\n");
        out.push_str("            baseVersion: baseVersion\n");
        out.push_str("        )\n");
        out.push_str("    }\n\n");

        out.push_str(&format!(
            "    public static func patch{type_name}(rowId: String, patch: {type_name}Patch, baseVersion: Int64? = nil) -> SyncularGeneratedOperation {{\n"
        ));
        out.push_str("        var payload: [String: SyncularJsonValue] = [:]\n");
        for column in &payload_columns {
            let property = lower_camel_case(&column.name);
            let key = double_quoted_string(&column.name);
            out.push_str(&format!("        if let value = patch.{property} {{\n"));
            out.push_str(&format!(
                "            payload[{key}] = {}\n",
                swift_payload_value(column, &table_config, "value")
            ));
            out.push_str("        }\n");
        }
        out.push_str("        return SyncularGeneratedOperation(\n");
        out.push_str(&format!(
            "            table: {},\n",
            double_quoted_string(&table.name)
        ));
        out.push_str("            rowId: rowId,\n");
        out.push_str("            op: .upsert,\n");
        out.push_str("            payload: payload,\n");
        out.push_str("            baseVersion: baseVersion\n");
        out.push_str("        )\n");
        out.push_str("    }\n\n");

        out.push_str(&format!(
            "    public static func delete{type_name}(rowId: String, baseVersion: Int64? = nil) -> SyncularGeneratedOperation {{\n"
        ));
        if let Some(column) = soft_delete_column(table, &table_config) {
            out.push_str("        SyncularGeneratedOperation(\n");
            out.push_str(&format!(
                "            table: {},\n",
                double_quoted_string(&table.name)
            ));
            out.push_str("            rowId: rowId,\n");
            out.push_str("            op: .upsert,\n");
            out.push_str(&format!(
                "            payload: [{}: .int(1)],\n",
                double_quoted_string(&column.name)
            ));
            out.push_str("            baseVersion: baseVersion\n");
            out.push_str("        )\n");
            out.push_str("    }\n\n");
        } else {
            out.push_str("        SyncularGeneratedOperation(\n");
            out.push_str(&format!(
                "            table: {},\n",
                double_quoted_string(&table.name)
            ));
            out.push_str("            rowId: rowId,\n");
            out.push_str("            op: .delete,\n");
            out.push_str("            payload: nil,\n");
            out.push_str("            baseVersion: baseVersion\n");
            out.push_str("        )\n");
            out.push_str("    }\n\n");
        }
    }
    out.push_str("}\n");

    out.push_str("\npublic extension SyncularNativeJsonClient {\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let apply_new_fn = apply_new_function_name(&table.name);
        let apply_patch_fn = apply_patch_function_name(&table.name);
        let apply_delete_fn = apply_delete_function_name(&table.name);
        let enqueue_new_fn = enqueue_new_function_name(&table.name);
        let enqueue_patch_fn = enqueue_patch_function_name(&table.name);
        let enqueue_delete_fn = enqueue_delete_function_name(&table.name);
        out.push_str(&format!(
            "    func {apply_new_fn}(_ input: New{type_name}, baseVersion: Int64? = 0, localRowJson: String? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try apply(SyncularAppOperations.new{type_name}(input, baseVersion: baseVersion), localRowJson: localRowJson)\n"
        ));
        out.push_str("    }\n\n");
        out.push_str(&format!(
            "    func {apply_patch_fn}(rowId: String, patch: {type_name}Patch, baseVersion: Int64? = nil, localRowJson: String? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try apply(SyncularAppOperations.patch{type_name}(rowId: rowId, patch: patch, baseVersion: baseVersion), localRowJson: localRowJson)\n"
        ));
        out.push_str("    }\n\n");
        out.push_str(&format!(
            "    func {apply_delete_fn}(rowId: String, baseVersion: Int64? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try apply(SyncularAppOperations.delete{type_name}(rowId: rowId, baseVersion: baseVersion))\n"
        ));
        out.push_str("    }\n\n");
        out.push_str(&format!(
            "    func {enqueue_new_fn}(_ input: New{type_name}, baseVersion: Int64? = 0, localRowJson: String? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try enqueue(SyncularAppOperations.new{type_name}(input, baseVersion: baseVersion), localRowJson: localRowJson)\n"
        ));
        out.push_str("    }\n\n");
        out.push_str(&format!(
            "    func {enqueue_patch_fn}(rowId: String, patch: {type_name}Patch, baseVersion: Int64? = nil, localRowJson: String? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try enqueue(SyncularAppOperations.patch{type_name}(rowId: rowId, patch: patch, baseVersion: baseVersion), localRowJson: localRowJson)\n"
        ));
        out.push_str("    }\n\n");
        out.push_str(&format!(
            "    func {enqueue_delete_fn}(rowId: String, baseVersion: Int64? = nil) throws -> String {{\n"
        ));
        out.push_str(&format!(
            "        try enqueue(SyncularAppOperations.delete{type_name}(rowId: rowId, baseVersion: baseVersion))\n"
        ));
        out.push_str("    }\n\n");
        for field in &table_config.crdt_yjs_fields {
            if field.kind != "text" {
                continue;
            }
            let table_name = double_quoted_string(&table.name);
            let field_name = double_quoted_string(&field.field);
            let open_fn = lower_camel_case(&format!(
                "open_{}_{}_crdt_field",
                singular_name(&table.name),
                field.field
            ));
            let apply_text_fn = lower_camel_case(&format!(
                "apply_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_text_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let apply_update_fn = lower_camel_case(&format!(
                "apply_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_update_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let materialize_fn = lower_camel_case(&format!(
                "materialize_{}_{}",
                singular_name(&table.name),
                field.field
            ));
            let materialize_json_fn = lower_camel_case(&format!(
                "materialize_{}_{}_json",
                singular_name(&table.name),
                field.field
            ));
            let snapshot_fn = lower_camel_case(&format!(
                "snapshot_{}_{}_state_vector",
                singular_name(&table.name),
                field.field
            ));
            let snapshot_json_fn = lower_camel_case(&format!(
                "snapshot_{}_{}_state_vector_json",
                singular_name(&table.name),
                field.field
            ));
            let compact_fn = lower_camel_case(&format!(
                "compact_{}_{}",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_compaction_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_compaction",
                singular_name(&table.name),
                field.field
            ));
            out.push_str(&format!(
                "    func {open_fn}(rowId: String) throws -> SyncularCrdtFieldDescriptor {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldRequest(table: {table_name}, rowId: rowId, field: {field_name})\n"
            ));
            out.push_str("        return try openCrdtField(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {apply_text_fn}(rowId: String, nextText: String) throws -> SyncularCrdtFieldWriteReceipt {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldTextRequest(table: {table_name}, rowId: rowId, field: {field_name}, nextText: nextText)\n"
            ));
            out.push_str("        return try applyCrdtFieldText(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_text_fn}(rowId: String, nextText: String) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldTextRequest(table: {table_name}, rowId: rowId, field: {field_name}, nextText: nextText)\n"
            ));
            out.push_str(
                "        return try enqueueCrdtFieldTextJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {apply_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope) throws -> SyncularCrdtFieldWriteReceipt {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldYjsUpdateRequest(table: {table_name}, rowId: rowId, field: {field_name}, update: update)\n"
            ));
            out.push_str("        return try applyCrdtFieldYjsUpdate(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldYjsUpdateRequest(table: {table_name}, rowId: rowId, field: {field_name}, update: update)\n"
            ));
            out.push_str(
                "        return try enqueueCrdtFieldYjsUpdateJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {materialize_fn}(rowId: String) throws -> SyncularCrdtFieldMaterialization {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldRequest(table: {table_name}, rowId: rowId, field: {field_name})\n"
            ));
            out.push_str("        return try materializeCrdtField(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {materialize_json_fn}(rowId: String) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldRequest(table: {table_name}, rowId: rowId, field: {field_name})\n"
            ));
            out.push_str(
                "        return try materializeCrdtFieldJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {snapshot_fn}(rowId: String) throws -> SyncularCrdtFieldStateVector {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldRequest(table: {table_name}, rowId: rowId, field: {field_name})\n"
            ));
            out.push_str("        return try snapshotCrdtFieldStateVector(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {snapshot_json_fn}(rowId: String) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldRequest(table: {table_name}, rowId: rowId, field: {field_name})\n"
            ));
            out.push_str("        return try snapshotCrdtFieldStateVectorJson(requestJson: request.jsonString())\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {compact_fn}(rowId: String, minUncheckpointedUpdates: Int64 = 1) throws -> SyncularCrdtFieldCompactionReceipt {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldCompactionRequest(table: {table_name}, rowId: rowId, field: {field_name}, minUncheckpointedUpdates: minUncheckpointedUpdates)\n"
            ));
            out.push_str("        return try compactCrdtField(request)\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_compaction_fn}(rowId: String, minUncheckpointedUpdates: Int64 = 1) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularCrdtFieldCompactionRequest(table: {table_name}, rowId: rowId, field: {field_name}, minUncheckpointedUpdates: minUncheckpointedUpdates)\n"
            ));
            out.push_str(
                "        return try enqueueCrdtFieldCompactionJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
        }
        for field in encrypted_update_log_crdt_fields(&table_config) {
            if field.kind != "text" {
                continue;
            }
            let table_name = double_quoted_string(&table.name);
            let field_name = double_quoted_string(&field.field);
            let apply_update_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_update_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let apply_text_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_text_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let apply_checkpoint_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_checkpoint",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_checkpoint_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_checkpoint",
                singular_name(&table.name),
                field.field
            ));
            out.push_str(&format!(
                "    func {apply_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtUpdateRequest(table: {table_name}, field: {field_name}, rowId: rowId, update: update)\n"
            ));
            out.push_str(
                "        return try applyEncryptedCrdtUpdateJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtUpdateRequest(table: {table_name}, field: {field_name}, rowId: rowId, update: update)\n"
            ));
            out.push_str(
                "        return try enqueueEncryptedCrdtUpdateJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {apply_text_fn}(rowId: String, nextText: String) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtUpdateRequest(table: {table_name}, field: {field_name}, rowId: rowId, nextText: nextText)\n"
            ));
            out.push_str(
                "        return try applyEncryptedCrdtUpdateJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_text_fn}(rowId: String, nextText: String) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtUpdateRequest(table: {table_name}, field: {field_name}, rowId: rowId, nextText: nextText)\n"
            ));
            out.push_str(
                "        return try enqueueEncryptedCrdtUpdateJson(requestJson: request.jsonString())\n",
            );
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {apply_checkpoint_fn}(rowId: String, minUncheckpointedUpdates: Int64 = 1) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtCheckpointRequest(table: {table_name}, field: {field_name}, rowId: rowId, minUncheckpointedUpdates: minUncheckpointedUpdates)\n"
            ));
            out.push_str("        return try applyEncryptedCrdtCheckpointJson(requestJson: request.jsonString())\n");
            out.push_str("    }\n\n");
            out.push_str(&format!(
                "    func {enqueue_checkpoint_fn}(rowId: String, minUncheckpointedUpdates: Int64 = 1) throws -> String {{\n"
            ));
            out.push_str(&format!(
                "        let request = SyncularEncryptedCrdtCheckpointRequest(table: {table_name}, field: {field_name}, rowId: rowId, minUncheckpointedUpdates: minUncheckpointedUpdates)\n"
            ));
            out.push_str("        return try enqueueEncryptedCrdtCheckpointJson(requestJson: request.jsonString())\n");
            out.push_str("    }\n\n");
        }
    }
    out.push_str("}\n");

    Ok(out)
}

fn push_swift_coding_keys<'a>(out: &mut String, columns: impl IntoIterator<Item = &'a ColumnRow>) {
    out.push_str("\n    private enum CodingKeys: String, CodingKey {\n");
    for column in columns {
        let property = lower_camel_case(&column.name);
        if property == column.name {
            out.push_str(&format!("        case {property}\n"));
        } else {
            out.push_str(&format!(
                "        case {property} = {}\n",
                double_quoted_string(&column.name)
            ));
        }
    }
    out.push_str("    }\n");
}

fn generate_kotlin_module(
    tables: &[TableInfo],
    config: &CodegenConfig,
    schema_version: i32,
    app_schema_json: &str,
    package_name: Option<&str>,
) -> Result<String> {
    let user_tables = tables
        .iter()
        .filter(|table| !table.name.starts_with("sync_"))
        .cloned()
        .collect::<Vec<_>>();
    let has_native_crdt = user_tables
        .iter()
        .any(|table| has_crdt_yjs_fields(&config.table(&table.name)));
    let has_native_encrypted_crdt = user_tables
        .iter()
        .any(|table| has_encrypted_update_log_crdt_fields(&config.table(&table.name)));
    let mut out = String::from(
        "// @generated by `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --`\n",
    );
    out.push_str("// Source: migrations/*.sql and syncular.codegen.json\n\n");
    if let Some(package_name) = package_name {
        validate_kotlin_package(package_name, "nativeAndroidKotlinPackage")?;
        out.push_str(&format!("package {package_name}\n\n"));
    }
    out.push_str("import kotlinx.serialization.json.Json\n");
    out.push_str("import kotlinx.serialization.json.JsonElement\n");
    out.push_str("import kotlinx.serialization.json.JsonNull\n");
    out.push_str("import kotlinx.serialization.json.JsonObject\n");
    out.push_str("import kotlinx.serialization.json.booleanOrNull\n");
    out.push_str("import kotlinx.serialization.json.doubleOrNull\n");
    out.push_str("import kotlinx.serialization.json.jsonArray\n");
    out.push_str("import kotlinx.serialization.json.jsonObject\n");
    out.push_str("import kotlinx.serialization.json.jsonPrimitive\n");
    out.push_str("import kotlinx.serialization.json.longOrNull\n\n");
    out.push_str("const val syncularNativeExpectedFfiAbiVersion: Int = 1\n");
    out.push_str(&format!(
        "const val syncularNativeExpectedCrateVersion: String = {}\n",
        double_quoted_string(env!("CARGO_PKG_VERSION"))
    ));
    out.push_str(&format!(
        "const val syncularNativeGeneratedSchemaVersion: Int = {schema_version}\n\n"
    ));
    out.push_str(&format!(
        "const val syncularNativeGeneratedAppSchemaJson: String = {}\n\n",
        double_quoted_string(app_schema_json)
    ));
    out.push_str("data class SyncularNativeRuntimeManifest(\n");
    out.push_str("    val ffiAbiVersion: Int,\n");
    out.push_str("    val crateName: String,\n");
    out.push_str("    val crateVersion: String,\n");
    out.push_str("    val schemaVersion: Int,\n");
    out.push_str("    val storageBackend: String,\n");
    out.push_str("    val transportBackends: List<String> = emptyList(),\n");
    out.push_str("    val capabilities: List<String> = emptyList(),\n");
    out.push_str(")\n\n");
    out.push_str(
        "fun assertSyncularNativeRuntimeManifest(manifest: SyncularNativeRuntimeManifest) {\n",
    );
    out.push_str("    require(manifest.ffiAbiVersion == syncularNativeExpectedFfiAbiVersion) { \"FFI ABI version ${manifest.ffiAbiVersion} does not match generated expectation $syncularNativeExpectedFfiAbiVersion\" }\n");
    out.push_str("    require(manifest.crateVersion == syncularNativeExpectedCrateVersion) { \"Rust crate version ${manifest.crateVersion} does not match generated expectation $syncularNativeExpectedCrateVersion\" }\n");
    out.push_str("    require(manifest.storageBackend == \"diesel-sqlite\") { \"Rust storage backend ${manifest.storageBackend} is not diesel-sqlite\" }\n");
    out.push_str("    require(manifest.capabilities.contains(\"generated-json-local-operations\")) { \"Rust native runtime is missing generated-json-local-operations\" }\n");
    out.push_str("    require(manifest.capabilities.contains(\"generated-json-mutations\")) { \"Rust native runtime is missing generated-json-mutations\" }\n");
    out.push_str("    require(manifest.capabilities.contains(\"read-only-query-json\")) { \"Rust native runtime is missing read-only-query-json\" }\n");
    out.push_str("    require(manifest.capabilities.contains(\"query-observer-events\")) { \"Rust native runtime is missing query-observer-events\" }\n");
    if has_native_encrypted_crdt {
        out.push_str("    require(manifest.capabilities.contains(\"queued-encrypted-crdt\")) { \"Rust native runtime is missing queued-encrypted-crdt\" }\n");
    }
    if has_native_crdt {
        out.push_str("    require(manifest.capabilities.contains(\"generic-crdt-field-api\")) { \"Rust native runtime is missing generic-crdt-field-api\" }\n");
        out.push_str("    require(manifest.capabilities.contains(\"queued-crdt-field-updates\")) { \"Rust native runtime is missing queued-crdt-field-updates\" }\n");
    }
    out.push_str("}\n\n");
    out.push_str("enum class SyncularGeneratedOperationKind(val wireValue: String) {\n");
    out.push_str("    Upsert(\"upsert\"),\n");
    out.push_str("    Delete(\"delete\"),\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularGeneratedOperation(\n");
    out.push_str("    val table: String,\n");
    out.push_str("    val rowId: String,\n");
    out.push_str("    val op: SyncularGeneratedOperationKind,\n");
    out.push_str("    val payload: Map<String, Any?>?,\n");
    out.push_str("    val baseVersion: Long?,\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
    out.push_str("        \"table\" to table,\n");
    out.push_str("        \"row_id\" to rowId,\n");
    out.push_str("        \"op\" to op.wireValue,\n");
    out.push_str("        \"payload\" to payload,\n");
    out.push_str("        \"base_version\" to baseVersion,\n");
    out.push_str("    )\n\n");
    out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularBlobRef(\n");
    out.push_str("    val hash: String,\n");
    out.push_str("    val size: Long,\n");
    out.push_str("    val mimeType: String,\n");
    out.push_str("    val encrypted: Boolean? = null,\n");
    out.push_str("    val keyId: String? = null,\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> {\n");
    out.push_str("        val value = linkedMapOf<String, Any?>(\n");
    out.push_str("            \"hash\" to hash,\n");
    out.push_str("            \"size\" to size,\n");
    out.push_str("            \"mimeType\" to mimeType,\n");
    out.push_str("        )\n");
    out.push_str("        encrypted?.let { value[\"encrypted\"] = it }\n");
    out.push_str("        keyId?.let { value[\"keyId\"] = it }\n");
    out.push_str("        return value\n");
    out.push_str("    }\n\n");
    out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularSubscriptionArgs(\n");
    out.push_str("    val actorId: String,\n");
    out.push_str("    val projectId: String? = null,\n");
    out.push_str(")\n\n");
    out.push_str("data class SyncularSubscriptionSpec(\n");
    out.push_str("    val id: String,\n");
    out.push_str("    val table: String,\n");
    out.push_str("    val scopes: Map<String, Any?>,\n");
    out.push_str("    val params: Map<String, Any?> = emptyMap(),\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
    out.push_str("        \"id\" to id,\n");
    out.push_str("        \"table\" to table,\n");
    out.push_str("        \"scopes\" to scopes,\n");
    out.push_str("        \"params\" to params,\n");
    out.push_str("    )\n\n");
    out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
    out.push_str("}\n\n");
    out.push_str(
        "fun syncularSubscriptionsJson(subscriptions: List<SyncularSubscriptionSpec>): String =\n",
    );
    out.push_str("    syncularJsonValue(subscriptions.map { it.toJsonValue() })\n\n");
    out.push_str("fun syncularDefaultSubscriptionsJson(actorId: String, projectId: String? = null): String =\n");
    out.push_str("    syncularSubscriptionsJson(syncularDefaultSubscriptions(SyncularSubscriptionArgs(actorId = actorId, projectId = projectId)))\n\n");
    out.push_str("fun syncularDefaultSubscriptions(args: SyncularSubscriptionArgs): List<SyncularSubscriptionSpec> = listOf(\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&format!(
            "    {}(args),\n",
            native_table_subscription_fn(table)
        ));
        for field in encrypted_update_log_crdt_fields(&table_config) {
            out.push_str(&format!(
                "    {}(args),\n",
                native_encrypted_crdt_subscription_fn(table, field, "updates")
            ));
            out.push_str(&format!(
                "    {}(args),\n",
                native_encrypted_crdt_subscription_fn(table, field, "checkpoints")
            ));
        }
    }
    out.push_str(")\n\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        out.push_str(&format!(
            "fun {}(args: SyncularSubscriptionArgs): SyncularSubscriptionSpec {{\n",
            native_table_subscription_fn(table)
        ));
        out.push_str("    val scopes = linkedMapOf<String, Any?>()\n");
        for scope in table_config.scopes() {
            let name = scope_name(&scope);
            match (scope.source.as_deref(), scope.required) {
                (Some("actorId"), _) => out.push_str(&format!(
                    "    scopes[{}] = args.actorId\n",
                    double_quoted_string(name)
                )),
                (Some("projectId"), true) => out.push_str(&format!(
                    "    scopes[{}] = requireNotNull(args.projectId) {{ \"projectId scope requires projectId\" }}\n",
                    double_quoted_string(name)
                )),
                (Some("projectId"), false) => out.push_str(&format!(
                    "    args.projectId?.let {{ scopes[{}] = it }}\n",
                    double_quoted_string(name)
                )),
                (_, true) => out.push_str(&format!(
                    "    scopes[{}] = \"\"\n",
                    double_quoted_string(name)
                )),
                (_, false) => {}
            }
        }
        out.push_str(&format!(
            "    return SyncularSubscriptionSpec(id = {}, table = {}, scopes = scopes, params = {})\n",
            double_quoted_string(&table_config.subscription_id(&table.name)),
            double_quoted_string(&table.name),
            kotlin_json_record_literal(&table_config.subscription_params)
        ));
        out.push_str("}\n\n");
        for field in encrypted_update_log_crdt_fields(&table_config) {
            for (suffix, system_table) in [
                ("updates", "sync_crdt_updates"),
                ("checkpoints", "sync_crdt_checkpoints"),
            ] {
                out.push_str(&format!(
                    "fun {}(args: SyncularSubscriptionArgs): SyncularSubscriptionSpec {{\n",
                    native_encrypted_crdt_subscription_fn(table, field, suffix)
                ));
                out.push_str("    val scopes = linkedMapOf<String, Any?>()\n");
                for scope in table_config.scopes() {
                    let name = scope_name(&scope);
                    match (scope.source.as_deref(), scope.required) {
                        (Some("actorId"), _) => out.push_str(&format!(
                            "    scopes[{}] = args.actorId\n",
                            double_quoted_string(name)
                        )),
                        (Some("projectId"), true) => out.push_str(&format!(
                            "    scopes[{}] = requireNotNull(args.projectId) {{ \"projectId scope requires projectId\" }}\n",
                            double_quoted_string(name)
                        )),
                        (Some("projectId"), false) => out.push_str(&format!(
                            "    args.projectId?.let {{ scopes[{}] = it }}\n",
                            double_quoted_string(name)
                        )),
                        (_, true) => out.push_str(&format!(
                            "    scopes[{}] = \"\"\n",
                            double_quoted_string(name)
                        )),
                        (_, false) => {}
                    }
                }
                out.push_str(&format!(
                    "    return SyncularSubscriptionSpec(id = {}, table = {}, scopes = scopes, params = linkedMapOf(\"app_table\" to {}, \"field_name\" to {}))\n",
                    double_quoted_string(&format!("sub-{}-{}-crdt-{}", table.name, field.field, suffix)),
                    double_quoted_string(system_table),
                    double_quoted_string(&table.name),
                    double_quoted_string(&field.field)
                ));
                out.push_str("}\n\n");
            }
        }
    }
    out.push_str("data class SyncularFieldEncryptionRule(\n");
    out.push_str("    val scope: String,\n");
    out.push_str("    val table: String?,\n");
    out.push_str("    val fields: List<String>,\n");
    out.push_str("    val rowIdField: String?,\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
    out.push_str("        \"scope\" to scope,\n");
    out.push_str("        \"table\" to table,\n");
    out.push_str("        \"fields\" to fields,\n");
    out.push_str("        \"rowIdField\" to rowIdField,\n");
    out.push_str("    ).filterValues { it != null }\n");
    out.push_str("}\n\n");
    out.push_str(
        "val syncularGeneratedFieldEncryptionRules: List<SyncularFieldEncryptionRule> = listOf(\n",
    );
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        for field in &table_config.encrypted_fields {
            out.push_str(&format!(
                "    SyncularFieldEncryptionRule(scope = {}, table = {}, fields = listOf({}), rowIdField = {}),\n",
                double_quoted_string(field.scope.as_deref().unwrap_or(&table.name)),
                double_quoted_string(&table.name),
                double_quoted_string(&field.field),
                double_quoted_string(field.row_id_field.as_deref().unwrap_or(&primary_key.name))
            ));
        }
    }
    out.push_str(")\n\n");
    out.push_str("fun syncularGeneratedFieldEncryptionConfigJson(\n");
    out.push_str("    keys: Map<String, String>,\n");
    out.push_str("    encryptionKid: String? = null,\n");
    out.push_str("    decryptionErrorMode: String? = null,\n");
    out.push_str("    envelopePrefix: String? = null,\n");
    out.push_str("    additionalRules: List<SyncularFieldEncryptionRule> = emptyList(),\n");
    out.push_str("): String = syncularJsonValue(linkedMapOf(\n");
    out.push_str("    \"rules\" to (syncularGeneratedFieldEncryptionRules + additionalRules).map { it.toJsonValue() },\n");
    out.push_str("    \"keys\" to keys,\n");
    out.push_str("    \"encryptionKid\" to encryptionKid,\n");
    out.push_str("    \"decryptionErrorMode\" to decryptionErrorMode,\n");
    out.push_str("    \"envelopePrefix\" to envelopePrefix,\n");
    out.push_str(").filterValues { it != null })\n\n");
    out.push_str("data class SyncularReadonlyQuery(\n");
    out.push_str("    val sql: String,\n");
    out.push_str("    val params: List<Any?> = emptyList(),\n");
    out.push_str("    val tables: List<String> = emptyList(),\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
    out.push_str("        \"sql\" to sql,\n");
    out.push_str("        \"params\" to params,\n");
    out.push_str("        \"tables\" to tables,\n");
    out.push_str("    )\n\n");
    out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularLiveQueryRegistration(\n");
    out.push_str("    val id: String,\n");
    out.push_str("    val tables: List<String>,\n");
    out.push_str("    val label: String? = null,\n");
    out.push_str(") {\n");
    out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
    out.push_str("        \"id\" to id,\n");
    out.push_str("        \"tables\" to tables,\n");
    out.push_str("        \"label\" to label,\n");
    out.push_str("    )\n\n");
    out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularChangedRow(\n");
    out.push_str("    val table: String,\n");
    out.push_str("    val rowId: String? = null,\n");
    out.push_str("    val operation: String,\n");
    out.push_str("    val changedFields: List<String> = emptyList(),\n");
    out.push_str("    val crdtFields: List<String> = emptyList(),\n");
    out.push_str("    val commitId: String? = null,\n");
    out.push_str("    val commitSeq: Long? = null,\n");
    out.push_str("    val subscriptionId: String? = null,\n");
    out.push_str("    val serverVersion: Long? = null,\n");
    out.push_str(")\n\n");
    out.push_str("data class SyncularNativeEvent(\n");
    out.push_str("    val eventSeq: Long = 0,\n");
    out.push_str("    val kind: String,\n");
    out.push_str("    val tables: List<String> = emptyList(),\n");
    out.push_str("    val queries: List<String> = emptyList(),\n");
    out.push_str("    val changedRows: List<SyncularChangedRow> = emptyList(),\n");
    out.push_str("    val commandId: String? = null,\n");
    out.push_str("    val clientCommitId: String? = null,\n");
    out.push_str("    val durationMs: Long? = null,\n");
    out.push_str(")\n\n");
    if has_native_crdt {
        out.push_str("data class SyncularYjsUpdateEnvelope(\n");
        out.push_str("    val updateId: String,\n");
        out.push_str("    val updateBase64: String,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"updateId\" to updateId,\n");
        out.push_str("        \"updateBase64\" to updateBase64,\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularCrdtFieldRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("    )\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularCrdtFieldTextRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val nextText: String,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("        \"nextText\" to nextText,\n");
        out.push_str("    )\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularCrdtFieldYjsUpdateRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val update: SyncularYjsUpdateEnvelope,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("        \"update\" to update.toJsonValue(),\n");
        out.push_str("    )\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularCrdtFieldCompactionRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val minUncheckpointedUpdates: Long? = null,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("        \"minUncheckpointedUpdates\" to minUncheckpointedUpdates,\n");
        out.push_str("    ).filterValues { it != null }\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularCrdtFieldDescriptor(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val stateColumn: String,\n");
        out.push_str("    val containerKey: String,\n");
        out.push_str("    val rowIdField: String,\n");
        out.push_str("    val syncMode: String,\n");
        out.push_str("    val kind: String,\n");
        out.push_str(")\n\n");
        out.push_str("data class SyncularCrdtFieldWriteReceipt(\n");
        out.push_str("    val clientCommitId: String,\n");
        out.push_str("    val syncMode: String,\n");
        out.push_str(")\n\n");
        out.push_str("data class SyncularCrdtFieldMaterialization(\n");
        out.push_str("    val value: JsonElement,\n");
        out.push_str("    val stateBase64: String?,\n");
        out.push_str("    val stateVectorBase64: String,\n");
        out.push_str(")\n\n");
        out.push_str("data class SyncularCrdtFieldStateVector(\n");
        out.push_str("    val stateVectorBase64: String,\n");
        out.push_str(")\n\n");
        out.push_str("data class SyncularCrdtFieldCompactionReceipt(\n");
        out.push_str("    val checkpointCreated: Boolean,\n");
        out.push_str("    val clientCommitId: String?,\n");
        out.push_str(")\n\n");
    }
    if has_native_encrypted_crdt {
        out.push_str("data class SyncularEncryptedCrdtUpdateRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val nextText: String? = null,\n");
        out.push_str("    val update: SyncularYjsUpdateEnvelope? = null,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"nextText\" to nextText,\n");
        out.push_str("        \"update\" to update?.toJsonValue(),\n");
        out.push_str("    ).filterValues { it != null }\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
        out.push_str("data class SyncularEncryptedCrdtCheckpointRequest(\n");
        out.push_str("    val table: String,\n");
        out.push_str("    val field: String,\n");
        out.push_str("    val rowId: String,\n");
        out.push_str("    val minUncheckpointedUpdates: Long? = null,\n");
        out.push_str(") {\n");
        out.push_str("    fun toJsonValue(): Map<String, Any?> = linkedMapOf(\n");
        out.push_str("        \"table\" to table,\n");
        out.push_str("        \"field\" to field,\n");
        out.push_str("        \"rowId\" to rowId,\n");
        out.push_str("        \"minUncheckpointedUpdates\" to minUncheckpointedUpdates,\n");
        out.push_str("    ).filterValues { it != null }\n\n");
        out.push_str("    fun toJsonString(): String = syncularJsonValue(toJsonValue())\n");
        out.push_str("}\n\n");
    }
    out.push_str(
        "fun syncularDecodeChangedRow(row: JsonObject): SyncularChangedRow = SyncularChangedRow(\n",
    );
    out.push_str("    table = row[\"table\"]?.jsonPrimitive?.content ?: \"\",\n");
    out.push_str("    rowId = row[\"rowId\"]?.jsonPrimitive?.content,\n");
    out.push_str("    operation = row[\"operation\"]?.jsonPrimitive?.content ?: \"\",\n");
    out.push_str("    changedFields = row[\"changedFields\"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),\n");
    out.push_str("    crdtFields = row[\"crdtFields\"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),\n");
    out.push_str("    commitId = row[\"commitId\"]?.jsonPrimitive?.content,\n");
    out.push_str("    commitSeq = row[\"commitSeq\"]?.jsonPrimitive?.longOrNull,\n");
    out.push_str("    subscriptionId = row[\"subscriptionId\"]?.jsonPrimitive?.content,\n");
    out.push_str("    serverVersion = row[\"serverVersion\"]?.jsonPrimitive?.longOrNull,\n");
    out.push_str(")\n\n");
    out.push_str("fun syncularDecodeNativeEvent(eventJson: String): SyncularNativeEvent {\n");
    out.push_str("    val event = Json.parseToJsonElement(eventJson).jsonObject\n");
    out.push_str("    return SyncularNativeEvent(\n");
    out.push_str("        eventSeq = event[\"event_seq\"]?.jsonPrimitive?.longOrNull ?: 0L,\n");
    out.push_str("        kind = event[\"kind\"]?.jsonPrimitive?.content ?: \"\",\n");
    out.push_str("        tables = event[\"tables\"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),\n");
    out.push_str("        queries = event[\"queries\"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),\n");
    out.push_str("        changedRows = event[\"changedRows\"]?.jsonArray?.map { syncularDecodeChangedRow(it.jsonObject) } ?: emptyList(),\n");
    out.push_str("        commandId = event[\"command_id\"]?.jsonPrimitive?.content,\n");
    out.push_str("        clientCommitId = event[\"client_commit_id\"]?.jsonPrimitive?.content,\n");
    out.push_str("        durationMs = event[\"duration_ms\"]?.jsonPrimitive?.longOrNull,\n");
    out.push_str("    )\n");
    out.push_str("}\n\n");
    push_kotlin_changed_row_helpers(&mut out, &user_tables);
    if has_native_crdt {
        out.push_str(
            "fun syncularDecodeCrdtFieldDescriptor(json: String): SyncularCrdtFieldDescriptor {\n",
        );
        out.push_str("    val value = Json.parseToJsonElement(json).jsonObject\n");
        out.push_str("    return SyncularCrdtFieldDescriptor(\n");
        out.push_str("        table = value[\"table\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("        rowId = value[\"rowId\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("        field = value[\"field\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str(
            "        stateColumn = value[\"stateColumn\"]?.jsonPrimitive?.content ?: \"\",\n",
        );
        out.push_str(
            "        containerKey = value[\"containerKey\"]?.jsonPrimitive?.content ?: \"\",\n",
        );
        out.push_str(
            "        rowIdField = value[\"rowIdField\"]?.jsonPrimitive?.content ?: \"\",\n",
        );
        out.push_str("        syncMode = value[\"syncMode\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("        kind = value[\"kind\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
        out.push_str("fun syncularDecodeCrdtFieldWriteReceipt(json: String): SyncularCrdtFieldWriteReceipt {\n");
        out.push_str("    val value = Json.parseToJsonElement(json).jsonObject\n");
        out.push_str("    return SyncularCrdtFieldWriteReceipt(\n");
        out.push_str(
            "        clientCommitId = value[\"clientCommitId\"]?.jsonPrimitive?.content ?: \"\",\n",
        );
        out.push_str("        syncMode = value[\"syncMode\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
        out.push_str("fun syncularDecodeCrdtFieldMaterialization(json: String): SyncularCrdtFieldMaterialization {\n");
        out.push_str("    val value = Json.parseToJsonElement(json).jsonObject\n");
        out.push_str("    return SyncularCrdtFieldMaterialization(\n");
        out.push_str("        value = value[\"value\"] ?: JsonNull,\n");
        out.push_str("        stateBase64 = value[\"stateBase64\"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,\n");
        out.push_str("        stateVectorBase64 = value[\"stateVectorBase64\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
        out.push_str("fun syncularDecodeCrdtFieldStateVector(json: String): SyncularCrdtFieldStateVector {\n");
        out.push_str("    val value = Json.parseToJsonElement(json).jsonObject\n");
        out.push_str("    return SyncularCrdtFieldStateVector(\n");
        out.push_str("        stateVectorBase64 = value[\"stateVectorBase64\"]?.jsonPrimitive?.content ?: \"\",\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
        out.push_str("fun syncularDecodeCrdtFieldCompactionReceipt(json: String): SyncularCrdtFieldCompactionReceipt {\n");
        out.push_str("    val value = Json.parseToJsonElement(json).jsonObject\n");
        out.push_str("    return SyncularCrdtFieldCompactionReceipt(\n");
        out.push_str("        checkpointCreated = value[\"checkpointCreated\"]?.jsonPrimitive?.booleanOrNull ?: false,\n");
        out.push_str("        clientCommitId = value[\"clientCommitId\"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,\n");
        out.push_str("    )\n");
        out.push_str("}\n\n");
    }
    out.push_str("interface SyncularNativeJsonClient {\n");
    out.push_str(
        "    fun applyMutationJson(mutationJson: String, localRowJson: String? = null): String\n",
    );
    out.push_str(
        "    fun enqueueMutationJson(mutationJson: String, localRowJson: String? = null): String\n",
    );
    if has_native_crdt {
        out.push_str("    fun openCrdtFieldJson(requestJson: String): String\n");
        out.push_str("    fun applyCrdtFieldTextJson(requestJson: String): String\n");
        out.push_str("    fun applyCrdtFieldYjsUpdateJson(requestJson: String): String\n");
        out.push_str("    fun enqueueCrdtFieldYjsUpdateJson(requestJson: String): String\n");
        out.push_str("    fun enqueueCrdtFieldTextJson(requestJson: String): String\n");
        out.push_str("    fun enqueueCrdtFieldCompactionJson(requestJson: String): String\n");
        out.push_str("    fun materializeCrdtFieldJson(requestJson: String): String\n");
        out.push_str("    fun snapshotCrdtFieldStateVectorJson(requestJson: String): String\n");
        out.push_str("    fun compactCrdtFieldJson(requestJson: String): String\n");
    }
    if has_native_encrypted_crdt {
        out.push_str("    fun applyEncryptedCrdtUpdateJson(requestJson: String): String\n");
        out.push_str("    fun enqueueEncryptedCrdtUpdateJson(requestJson: String): String\n");
        out.push_str("    fun applyEncryptedCrdtCheckpointJson(requestJson: String): String\n");
        out.push_str("    fun enqueueEncryptedCrdtCheckpointJson(requestJson: String): String\n");
    }
    out.push_str("    fun queryJson(requestJson: String): String\n");
    out.push_str("    fun registerQueryJson(queryJson: String): String\n");
    out.push_str("    fun unregisterQuery(id: String): Boolean\n");
    out.push_str("}\n\n");
    out.push_str("fun SyncularNativeJsonClient.apply(operation: SyncularGeneratedOperation, localRowJson: String? = null): String =\n");
    out.push_str("    applyMutationJson(operation.toJsonString(), localRowJson)\n\n");
    out.push_str("fun SyncularNativeJsonClient.enqueue(operation: SyncularGeneratedOperation, localRowJson: String? = null): String =\n");
    out.push_str("    enqueueMutationJson(operation.toJsonString(), localRowJson)\n\n");
    if has_native_crdt {
        out.push_str("fun SyncularNativeJsonClient.openCrdtField(request: SyncularCrdtFieldRequest): SyncularCrdtFieldDescriptor =\n");
        out.push_str(
            "    syncularDecodeCrdtFieldDescriptor(openCrdtFieldJson(request.toJsonString()))\n\n",
        );
        out.push_str("fun SyncularNativeJsonClient.applyCrdtFieldText(request: SyncularCrdtFieldTextRequest): SyncularCrdtFieldWriteReceipt =\n");
        out.push_str("    syncularDecodeCrdtFieldWriteReceipt(applyCrdtFieldTextJson(request.toJsonString()))\n\n");
        out.push_str("fun SyncularNativeJsonClient.applyCrdtFieldYjsUpdate(request: SyncularCrdtFieldYjsUpdateRequest): SyncularCrdtFieldWriteReceipt =\n");
        out.push_str("    syncularDecodeCrdtFieldWriteReceipt(applyCrdtFieldYjsUpdateJson(request.toJsonString()))\n\n");
        out.push_str("fun SyncularNativeJsonClient.materializeCrdtField(request: SyncularCrdtFieldRequest): SyncularCrdtFieldMaterialization =\n");
        out.push_str("    syncularDecodeCrdtFieldMaterialization(materializeCrdtFieldJson(request.toJsonString()))\n\n");
        out.push_str("fun SyncularNativeJsonClient.snapshotCrdtFieldStateVector(request: SyncularCrdtFieldRequest): SyncularCrdtFieldStateVector =\n");
        out.push_str("    syncularDecodeCrdtFieldStateVector(snapshotCrdtFieldStateVectorJson(request.toJsonString()))\n\n");
        out.push_str("fun SyncularNativeJsonClient.compactCrdtField(request: SyncularCrdtFieldCompactionRequest): SyncularCrdtFieldCompactionReceipt =\n");
        out.push_str("    syncularDecodeCrdtFieldCompactionReceipt(compactCrdtFieldJson(request.toJsonString()))\n\n");
    }
    out.push_str(
        "fun SyncularNativeJsonClient.query(query: SyncularReadonlyQuery): List<JsonObject> =\n",
    );
    out.push_str("    syncularGeneratedQueryRows(queryJson(query.toJsonString()))\n\n");
    out.push_str("fun <Row> SyncularNativeJsonClient.query(query: SyncularReadonlyQuery, decode: (JsonObject) -> Row): List<Row> =\n");
    out.push_str("    query(query).map(decode)\n\n");
    out.push_str("fun SyncularNativeJsonClient.registerLiveQuery(registration: SyncularLiveQueryRegistration): String =\n");
    out.push_str("    registerQueryJson(registration.toJsonString())\n\n");
    out.push_str("class SyncularNativeLiveQuery<Row>(\n");
    out.push_str("    val id: String,\n");
    out.push_str("    val query: SyncularReadonlyQuery,\n");
    out.push_str("    private val decode: (JsonObject) -> Row,\n");
    out.push_str("    val label: String? = null,\n");
    out.push_str(") {\n");
    out.push_str("    var rows: List<Row> = emptyList()\n");
    out.push_str("        private set\n\n");
    out.push_str("    fun start(client: SyncularNativeJsonClient): List<Row> {\n");
    out.push_str("        client.registerLiveQuery(SyncularLiveQueryRegistration(id = id, tables = query.tables, label = label))\n");
    out.push_str("        return refresh(client)\n");
    out.push_str("    }\n\n");
    out.push_str("    fun refresh(client: SyncularNativeJsonClient): List<Row> {\n");
    out.push_str("        rows = client.query(query, decode)\n");
    out.push_str("        return rows\n");
    out.push_str("    }\n\n");
    out.push_str(
        "    fun stop(client: SyncularNativeJsonClient): Boolean = client.unregisterQuery(id)\n\n",
    );
    out.push_str(
        "    fun matches(queryIds: Iterable<String>): Boolean = queryIds.any { it == id }\n",
    );
    out.push_str("\n");
    out.push_str("    fun refreshIfChanged(event: SyncularNativeEvent, client: SyncularNativeJsonClient): List<Row>? {\n");
    out.push_str(
        "        if (event.kind != \"QueriesChanged\" || !matches(event.queries)) return null\n",
    );
    out.push_str("        return refresh(client)\n");
    out.push_str("    }\n\n");
    out.push_str("    fun refreshIfChanged(eventJson: String, client: SyncularNativeJsonClient): List<Row>? =\n");
    out.push_str("        refreshIfChanged(syncularDecodeNativeEvent(eventJson), client)\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularQueryPredicate(\n");
    out.push_str("    val sql: String,\n");
    out.push_str("    val params: List<Any?> = emptyList(),\n");
    out.push_str(") {\n");
    out.push_str("    infix fun and(other: SyncularQueryPredicate): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"(($sql) and (${other.sql}))\", params = params + other.params)\n\n");
    out.push_str("    infix fun or(other: SyncularQueryPredicate): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"(($sql) or (${other.sql}))\", params = params + other.params)\n");
    out.push_str("}\n\n");
    out.push_str("data class SyncularQueryOrder(\n");
    out.push_str("    val sql: String,\n");
    out.push_str(")\n\n");
    out.push_str("class SyncularQueryColumn<T>(\n");
    out.push_str("    val table: String,\n");
    out.push_str("    val name: String,\n");
    out.push_str(") {\n");
    out.push_str("    fun eq(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} = ?\", params = listOf(value))\n\n");
    out.push_str("    fun notEq(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} != ?\", params = listOf(value))\n\n");
    out.push_str("    fun gt(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} > ?\", params = listOf(value))\n\n");
    out.push_str("    fun gte(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} >= ?\", params = listOf(value))\n\n");
    out.push_str("    fun lt(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} < ?\", params = listOf(value))\n\n");
    out.push_str("    fun lte(value: T): SyncularQueryPredicate =\n");
    out.push_str("        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} <= ?\", params = listOf(value))\n\n");
    out.push_str("    fun isNull(): SyncularQueryPredicate =\n");
    out.push_str(
        "        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} is null\")\n\n",
    );
    out.push_str("    fun isNotNull(): SyncularQueryPredicate =\n");
    out.push_str(
        "        SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} is not null\")\n\n",
    );
    out.push_str("    fun isIn(values: Iterable<T>): SyncularQueryPredicate {\n");
    out.push_str("        val list = values.toList()\n");
    out.push_str("        if (list.isEmpty()) return SyncularQueryPredicate(sql = \"0 = 1\")\n");
    out.push_str("        return SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} in (${list.joinToString(\", \") { \"?\" }})\", params = list)\n");
    out.push_str("    }\n\n");
    out.push_str("    fun notIn(values: Iterable<T>): SyncularQueryPredicate {\n");
    out.push_str("        val list = values.toList()\n");
    out.push_str("        if (list.isEmpty()) return SyncularQueryPredicate(sql = \"1 = 1\")\n");
    out.push_str("        return SyncularQueryPredicate(sql = \"${syncularQuoteIdentifier(name)} not in (${list.joinToString(\", \") { \"?\" }})\", params = list)\n");
    out.push_str("    }\n\n");
    out.push_str("    fun asc(): SyncularQueryOrder = SyncularQueryOrder(\"${syncularQuoteIdentifier(name)} asc\")\n\n");
    out.push_str("    fun desc(): SyncularQueryOrder = SyncularQueryOrder(\"${syncularQuoteIdentifier(name)} desc\")\n");
    out.push_str("}\n\n");
    out.push_str("class SyncularQueryTable<Row>(\n");
    out.push_str("    val name: String,\n");
    out.push_str("    val columns: List<String>,\n");
    out.push_str("    val decode: (JsonObject) -> Row,\n");
    out.push_str(") {\n");
    out.push_str(
        "    fun select(): SyncularSelectQuery<Row> = SyncularSelectQuery(table = this)\n",
    );
    out.push_str("}\n\n");
    out.push_str("data class SyncularSelectQuery<Row>(\n");
    out.push_str("    val table: SyncularQueryTable<Row>,\n");
    out.push_str("    val predicates: List<SyncularQueryPredicate> = emptyList(),\n");
    out.push_str("    val orders: List<SyncularQueryOrder> = emptyList(),\n");
    out.push_str("    val limitValue: Int? = null,\n");
    out.push_str(") {\n");
    out.push_str("    fun filter(predicate: SyncularQueryPredicate): SyncularSelectQuery<Row> =\n");
    out.push_str("        copy(predicates = predicates + predicate)\n\n");
    out.push_str("    fun orderBy(order: SyncularQueryOrder): SyncularSelectQuery<Row> =\n");
    out.push_str("        copy(orders = orders + order)\n\n");
    out.push_str(
        "    fun limit(value: Int): SyncularSelectQuery<Row> = copy(limitValue = value)\n\n",
    );
    out.push_str("    fun readonlyQuery(): SyncularReadonlyQuery {\n");
    out.push_str("        val columnSql = table.columns.joinToString(\", \") { syncularQuoteIdentifier(it) }\n");
    out.push_str("        val sql = buildString {\n");
    out.push_str("            append(\"select \")\n");
    out.push_str("            append(columnSql)\n");
    out.push_str("            append(\" from \")\n");
    out.push_str("            append(syncularQuoteIdentifier(table.name))\n");
    out.push_str("            if (predicates.isNotEmpty()) {\n");
    out.push_str("                append(\" where \")\n");
    out.push_str("                append(predicates.joinToString(\" and \") { it.sql })\n");
    out.push_str("            }\n");
    out.push_str("            if (orders.isNotEmpty()) {\n");
    out.push_str("                append(\" order by \")\n");
    out.push_str("                append(orders.joinToString(\", \") { it.sql })\n");
    out.push_str("            }\n");
    out.push_str("            limitValue?.let { append(\" limit $it\") }\n");
    out.push_str("        }\n");
    out.push_str("        return SyncularReadonlyQuery(\n");
    out.push_str("            sql = sql,\n");
    out.push_str("            params = predicates.flatMap { it.params },\n");
    out.push_str("            tables = listOf(table.name),\n");
    out.push_str("        )\n");
    out.push_str("    }\n\n");
    out.push_str("    fun fetch(client: SyncularNativeJsonClient): List<Row> = client.query(readonlyQuery(), table.decode)\n\n");
    out.push_str(
        "    fun liveQuery(id: String, label: String? = null): SyncularNativeLiveQuery<Row> =\n",
    );
    out.push_str("        SyncularNativeLiveQuery(id = id, query = readonlyQuery(), decode = table.decode, label = label)\n");
    out.push_str("}\n\n");
    out.push_str("private fun syncularQuoteIdentifier(identifier: String): String =\n");
    out.push_str("    \"\\\"\" + identifier.replace(\"\\\"\", \"\\\"\\\"\") + \"\\\"\"\n\n");

    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let insert_columns = table
            .columns
            .iter()
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();
        let payload_columns = table
            .columns
            .iter()
            .filter(|column| column.pk == 0)
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();

        out.push_str(&format!("data class {type_name}Row(\n"));
        for column in &table.columns {
            out.push_str(&format!(
                "    val {}: {},\n",
                lower_camel_case(&column.name),
                kotlin_app_type(column, &table_config, is_nullable(column))
            ));
        }
        out.push_str(")\n\n");

        out.push_str(&format!("data class New{type_name}(\n"));
        for column in &insert_columns {
            let optional = ts_input_optional(column, &table_config);
            out.push_str(&format!(
                "    val {}: {}{},\n",
                lower_camel_case(&column.name),
                kotlin_app_type(column, &table_config, optional),
                if optional { " = null" } else { "" }
            ));
        }
        out.push_str(")\n\n");

        out.push_str(&format!("data class {type_name}Patch(\n"));
        for column in &payload_columns {
            out.push_str(&format!(
                "    val {}: {} = null,\n",
                lower_camel_case(&column.name),
                kotlin_app_type(column, &table_config, true)
            ));
        }
        out.push_str(")\n\n");
    }
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let query_name = format!("{type_name}Query");
        let columns = table
            .columns
            .iter()
            .map(|column| double_quoted_string(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("object {query_name} {{\n"));
        out.push_str(&format!(
            "    val table = SyncularQueryTable(name = {}, columns = listOf({columns}), decode = ::syncularDecode{type_name}Row)\n",
            double_quoted_string(&table.name)
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    val {} = SyncularQueryColumn<{}>(table = {}, name = {})\n",
                lower_camel_case(&column.name),
                kotlin_app_type(column, &table_config, false),
                double_quoted_string(&table.name),
                double_quoted_string(&column.name)
            ));
        }
        out.push_str("    fun select(): SyncularSelectQuery<");
        out.push_str(&type_name);
        out.push_str("Row> = table.select()\n");
        out.push_str("}\n\n");
    }

    out.push_str("object SyncularAppOperations {\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let primary_key = table
            .columns
            .iter()
            .find(|column| column.pk > 0)
            .with_context(|| format!("table {} has no primary key", table.name))?;
        let payload_columns = table
            .columns
            .iter()
            .filter(|column| column.pk == 0)
            .filter(|column| !is_server_managed_column(column, &table_config))
            .collect::<Vec<_>>();

        out.push_str(&format!(
            "    fun new{type_name}(input: New{type_name}, baseVersion: Long? = 0): SyncularGeneratedOperation {{\n"
        ));
        out.push_str("        val payload = linkedMapOf<String, Any?>()\n");
        for column in &payload_columns {
            let property = lower_camel_case(&column.name);
            let key = double_quoted_string(&column.name);
            if ts_input_optional(column, &table_config) {
                if has_sql_default(column) && !is_nullable(column) {
                    let expr = format!("input.{property} ?: {}", kotlin_default_value(column));
                    out.push_str(&format!(
                        "        payload[{key}] = {}\n",
                        kotlin_app_payload_value(column, &table_config, &expr)
                    ));
                } else {
                    out.push_str(&format!(
                        "        input.{property}?.let {{ payload[{key}] = {} }}\n",
                        kotlin_app_payload_value(column, &table_config, "it")
                    ));
                }
            } else {
                out.push_str(&format!(
                    "        payload[{key}] = {}\n",
                    kotlin_app_payload_value(column, &table_config, &format!("input.{property}"))
                ));
            }
        }
        out.push_str("        return SyncularGeneratedOperation(\n");
        out.push_str(&format!(
            "            table = {},\n",
            double_quoted_string(&table.name)
        ));
        out.push_str(&format!(
            "            rowId = {},\n",
            kotlin_row_id_input_expr(primary_key)
        ));
        out.push_str("            op = SyncularGeneratedOperationKind.Upsert,\n");
        out.push_str("            payload = payload,\n");
        out.push_str("            baseVersion = baseVersion,\n");
        out.push_str("        )\n");
        out.push_str("    }\n\n");

        out.push_str(&format!(
            "    fun patch{type_name}(rowId: String, patch: {type_name}Patch, baseVersion: Long? = null): SyncularGeneratedOperation {{\n"
        ));
        out.push_str("        val payload = linkedMapOf<String, Any?>()\n");
        for column in &payload_columns {
            let property = lower_camel_case(&column.name);
            let key = double_quoted_string(&column.name);
            out.push_str(&format!(
                "        patch.{property}?.let {{ payload[{key}] = {} }}\n",
                kotlin_app_payload_value(column, &table_config, "it")
            ));
        }
        out.push_str("        return SyncularGeneratedOperation(\n");
        out.push_str(&format!(
            "            table = {},\n",
            double_quoted_string(&table.name)
        ));
        out.push_str("            rowId = rowId,\n");
        out.push_str("            op = SyncularGeneratedOperationKind.Upsert,\n");
        out.push_str("            payload = payload,\n");
        out.push_str("            baseVersion = baseVersion,\n");
        out.push_str("        )\n");
        out.push_str("    }\n\n");

        out.push_str(&format!(
            "    fun delete{type_name}(rowId: String, baseVersion: Long? = null): SyncularGeneratedOperation = SyncularGeneratedOperation(\n"
        ));
        if let Some(column) = soft_delete_column(table, &table_config) {
            out.push_str(&format!(
                "        table = {},\n",
                double_quoted_string(&table.name)
            ));
            out.push_str("        rowId = rowId,\n");
            out.push_str("        op = SyncularGeneratedOperationKind.Upsert,\n");
            out.push_str(&format!(
                "        payload = linkedMapOf({} to 1L),\n",
                double_quoted_string(&column.name)
            ));
            out.push_str("        baseVersion = baseVersion,\n");
            out.push_str("    )\n\n");
        } else {
            out.push_str(&format!(
                "        table = {},\n",
                double_quoted_string(&table.name)
            ));
            out.push_str("        rowId = rowId,\n");
            out.push_str("        op = SyncularGeneratedOperationKind.Delete,\n");
            out.push_str("        payload = null,\n");
            out.push_str("        baseVersion = baseVersion,\n");
            out.push_str("    )\n\n");
        }
    }
    out.push_str("}\n\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        let apply_new_fn = apply_new_function_name(&table.name);
        let apply_patch_fn = apply_patch_function_name(&table.name);
        let apply_delete_fn = apply_delete_function_name(&table.name);
        let enqueue_new_fn = enqueue_new_function_name(&table.name);
        let enqueue_patch_fn = enqueue_patch_function_name(&table.name);
        let enqueue_delete_fn = enqueue_delete_function_name(&table.name);
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{apply_new_fn}(input: New{type_name}, baseVersion: Long? = 0, localRowJson: String? = null): String =\n"
        ));
        out.push_str(&format!(
            "    apply(SyncularAppOperations.new{type_name}(input, baseVersion), localRowJson)\n\n"
        ));
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{apply_patch_fn}(rowId: String, patch: {type_name}Patch, baseVersion: Long? = null, localRowJson: String? = null): String =\n"
        ));
        out.push_str(&format!(
            "    apply(SyncularAppOperations.patch{type_name}(rowId, patch, baseVersion), localRowJson)\n\n"
        ));
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{apply_delete_fn}(rowId: String, baseVersion: Long? = null): String =\n"
        ));
        out.push_str(&format!(
            "    apply(SyncularAppOperations.delete{type_name}(rowId, baseVersion))\n\n"
        ));
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{enqueue_new_fn}(input: New{type_name}, baseVersion: Long? = 0, localRowJson: String? = null): String =\n"
        ));
        out.push_str(&format!(
            "    enqueue(SyncularAppOperations.new{type_name}(input, baseVersion), localRowJson)\n\n"
        ));
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{enqueue_patch_fn}(rowId: String, patch: {type_name}Patch, baseVersion: Long? = null, localRowJson: String? = null): String =\n"
        ));
        out.push_str(&format!(
            "    enqueue(SyncularAppOperations.patch{type_name}(rowId, patch, baseVersion), localRowJson)\n\n"
        ));
        out.push_str(&format!(
            "fun SyncularNativeJsonClient.{enqueue_delete_fn}(rowId: String, baseVersion: Long? = null): String =\n"
        ));
        out.push_str(&format!(
            "    enqueue(SyncularAppOperations.delete{type_name}(rowId, baseVersion))\n\n"
        ));
        for field in &table_config.crdt_yjs_fields {
            if field.kind != "text" {
                continue;
            }
            let table_name = double_quoted_string(&table.name);
            let field_name = double_quoted_string(&field.field);
            let open_fn = lower_camel_case(&format!(
                "open_{}_{}_crdt_field",
                singular_name(&table.name),
                field.field
            ));
            let apply_text_fn = lower_camel_case(&format!(
                "apply_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_text_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let apply_update_fn = lower_camel_case(&format!(
                "apply_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_update_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let materialize_fn = lower_camel_case(&format!(
                "materialize_{}_{}",
                singular_name(&table.name),
                field.field
            ));
            let materialize_json_fn = lower_camel_case(&format!(
                "materialize_{}_{}_json",
                singular_name(&table.name),
                field.field
            ));
            let snapshot_fn = lower_camel_case(&format!(
                "snapshot_{}_{}_state_vector",
                singular_name(&table.name),
                field.field
            ));
            let snapshot_json_fn = lower_camel_case(&format!(
                "snapshot_{}_{}_state_vector_json",
                singular_name(&table.name),
                field.field
            ));
            let compact_fn = lower_camel_case(&format!(
                "compact_{}_{}",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_compaction_fn = lower_camel_case(&format!(
                "enqueue_{}_{}_compaction",
                singular_name(&table.name),
                field.field
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{open_fn}(rowId: String): SyncularCrdtFieldDescriptor =\n"
            ));
            out.push_str(&format!(
                "    openCrdtField(SyncularCrdtFieldRequest(table = {table_name}, rowId = rowId, field = {field_name}))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{apply_text_fn}(rowId: String, nextText: String): SyncularCrdtFieldWriteReceipt =\n"
            ));
            out.push_str(&format!(
                "    applyCrdtFieldText(SyncularCrdtFieldTextRequest(table = {table_name}, rowId = rowId, field = {field_name}, nextText = nextText))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_text_fn}(rowId: String, nextText: String): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueCrdtFieldTextJson(SyncularCrdtFieldTextRequest(table = {table_name}, rowId = rowId, field = {field_name}, nextText = nextText).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{apply_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope): SyncularCrdtFieldWriteReceipt =\n"
            ));
            out.push_str(&format!(
                "    applyCrdtFieldYjsUpdate(SyncularCrdtFieldYjsUpdateRequest(table = {table_name}, rowId = rowId, field = {field_name}, update = update))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueCrdtFieldYjsUpdateJson(SyncularCrdtFieldYjsUpdateRequest(table = {table_name}, rowId = rowId, field = {field_name}, update = update).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{materialize_fn}(rowId: String): SyncularCrdtFieldMaterialization =\n"
            ));
            out.push_str(&format!(
                "    materializeCrdtField(SyncularCrdtFieldRequest(table = {table_name}, rowId = rowId, field = {field_name}))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{materialize_json_fn}(rowId: String): String =\n"
            ));
            out.push_str(&format!(
                "    materializeCrdtFieldJson(SyncularCrdtFieldRequest(table = {table_name}, rowId = rowId, field = {field_name}).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{snapshot_fn}(rowId: String): SyncularCrdtFieldStateVector =\n"
            ));
            out.push_str(&format!(
                "    snapshotCrdtFieldStateVector(SyncularCrdtFieldRequest(table = {table_name}, rowId = rowId, field = {field_name}))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{snapshot_json_fn}(rowId: String): String =\n"
            ));
            out.push_str(&format!(
                "    snapshotCrdtFieldStateVectorJson(SyncularCrdtFieldRequest(table = {table_name}, rowId = rowId, field = {field_name}).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{compact_fn}(rowId: String, minUncheckpointedUpdates: Long = 1): SyncularCrdtFieldCompactionReceipt =\n"
            ));
            out.push_str(&format!(
                "    compactCrdtField(SyncularCrdtFieldCompactionRequest(table = {table_name}, rowId = rowId, field = {field_name}, minUncheckpointedUpdates = minUncheckpointedUpdates))\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_compaction_fn}(rowId: String, minUncheckpointedUpdates: Long = 1): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueCrdtFieldCompactionJson(SyncularCrdtFieldCompactionRequest(table = {table_name}, rowId = rowId, field = {field_name}, minUncheckpointedUpdates = minUncheckpointedUpdates).toJsonString())\n\n"
            ));
        }
        for field in encrypted_update_log_crdt_fields(&table_config) {
            if field.kind != "text" {
                continue;
            }
            let table_name = double_quoted_string(&table.name);
            let field_name = double_quoted_string(&field.field);
            let apply_update_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_update_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_update",
                singular_name(&table.name),
                field.field
            ));
            let apply_text_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_text_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_text",
                singular_name(&table.name),
                field.field
            ));
            let apply_checkpoint_fn = lower_camel_case(&format!(
                "apply_encrypted_{}_{}_checkpoint",
                singular_name(&table.name),
                field.field
            ));
            let enqueue_checkpoint_fn = lower_camel_case(&format!(
                "enqueue_encrypted_{}_{}_checkpoint",
                singular_name(&table.name),
                field.field
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{apply_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope): String =\n"
            ));
            out.push_str(&format!(
                "    applyEncryptedCrdtUpdateJson(SyncularEncryptedCrdtUpdateRequest(table = {table_name}, field = {field_name}, rowId = rowId, update = update).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_update_fn}(rowId: String, update: SyncularYjsUpdateEnvelope): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueEncryptedCrdtUpdateJson(SyncularEncryptedCrdtUpdateRequest(table = {table_name}, field = {field_name}, rowId = rowId, update = update).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{apply_text_fn}(rowId: String, nextText: String): String =\n"
            ));
            out.push_str(&format!(
                "    applyEncryptedCrdtUpdateJson(SyncularEncryptedCrdtUpdateRequest(table = {table_name}, field = {field_name}, rowId = rowId, nextText = nextText).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_text_fn}(rowId: String, nextText: String): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueEncryptedCrdtUpdateJson(SyncularEncryptedCrdtUpdateRequest(table = {table_name}, field = {field_name}, rowId = rowId, nextText = nextText).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{apply_checkpoint_fn}(rowId: String, minUncheckpointedUpdates: Long = 1): String =\n"
            ));
            out.push_str(&format!(
                "    applyEncryptedCrdtCheckpointJson(SyncularEncryptedCrdtCheckpointRequest(table = {table_name}, field = {field_name}, rowId = rowId, minUncheckpointedUpdates = minUncheckpointedUpdates).toJsonString())\n\n"
            ));
            out.push_str(&format!(
                "fun SyncularNativeJsonClient.{enqueue_checkpoint_fn}(rowId: String, minUncheckpointedUpdates: Long = 1): String =\n"
            ));
            out.push_str(&format!(
                "    enqueueEncryptedCrdtCheckpointJson(SyncularEncryptedCrdtCheckpointRequest(table = {table_name}, field = {field_name}, rowId = rowId, minUncheckpointedUpdates = minUncheckpointedUpdates).toJsonString())\n\n"
            ));
        }
    }
    out.push_str("private val syncularGeneratedJson = Json { ignoreUnknownKeys = true }\n\n");
    out.push_str("private fun syncularGeneratedRows(json: String): List<JsonObject> =\n");
    out.push_str(
        "    syncularGeneratedJson.parseToJsonElement(json).jsonArray.map { it.jsonObject }\n\n",
    );
    out.push_str("private fun syncularGeneratedQueryRows(json: String): List<JsonObject> =\n");
    out.push_str("    syncularGeneratedJson.parseToJsonElement(json).jsonObject[\"rows\"]?.jsonArray?.map { it.jsonObject } ?: emptyList()\n\n");
    for table in &user_tables {
        let table_config = config.table(&table.name);
        let type_name = singular_pascal_case(&table.name);
        out.push_str(&format!(
            "private fun syncularDecode{type_name}Rows(json: String): List<{type_name}Row> =\n"
        ));
        out.push_str(&format!(
            "    syncularGeneratedRows(json).map(::syncularDecode{type_name}Row)\n\n"
        ));
        out.push_str(&format!(
            "private fun syncularDecode{type_name}Row(row: JsonObject): {type_name}Row = {type_name}Row(\n"
        ));
        for column in &table.columns {
            out.push_str(&format!(
                "    {} = {},\n",
                lower_camel_case(&column.name),
                kotlin_row_decode_value(column, &table_config, "row")
            ));
        }
        out.push_str(")\n\n");
    }
    out.push_str("private fun JsonObject.syncularRequiredString(name: String): String =\n");
    out.push_str("    syncularOptionalString(name) ?: error(\"missing string field $name\")\n\n");
    out.push_str("private fun JsonObject.syncularOptionalString(name: String): String? {\n");
    out.push_str("    val element = this[name] ?: return null\n");
    out.push_str("    if (element is JsonNull) return null\n");
    out.push_str("    return element.jsonPrimitive.content\n");
    out.push_str("}\n\n");
    out.push_str(
        "private fun JsonObject.syncularRequiredBlobRef(name: String): SyncularBlobRef =\n",
    );
    out.push_str(
        "    syncularOptionalBlobRef(name) ?: error(\"missing blob ref field $name\")\n\n",
    );
    out.push_str(
        "private fun JsonObject.syncularOptionalBlobRef(name: String): SyncularBlobRef? {\n",
    );
    out.push_str("    val element = this[name] ?: return null\n");
    out.push_str("    if (element is JsonNull) return null\n");
    out.push_str("    val objectValue = runCatching {\n");
    out.push_str("        syncularGeneratedJson.parseToJsonElement(element.jsonPrimitive.content).jsonObject\n");
    out.push_str("    }.getOrElse {\n");
    out.push_str("        element.jsonObject\n");
    out.push_str("    }\n");
    out.push_str("    return SyncularBlobRef(\n");
    out.push_str("        hash = objectValue.syncularRequiredString(\"hash\"),\n");
    out.push_str("        size = objectValue.syncularRequiredLong(\"size\"),\n");
    out.push_str("        mimeType = objectValue.syncularRequiredString(\"mimeType\"),\n");
    out.push_str("        encrypted = objectValue.syncularOptionalBoolean(\"encrypted\"),\n");
    out.push_str("        keyId = objectValue.syncularOptionalString(\"keyId\"),\n");
    out.push_str("    )\n");
    out.push_str("}\n\n");
    out.push_str("private fun JsonObject.syncularRequiredLong(name: String): Long =\n");
    out.push_str("    syncularOptionalLong(name) ?: error(\"missing integer field $name\")\n\n");
    out.push_str("private fun JsonObject.syncularOptionalLong(name: String): Long? {\n");
    out.push_str("    val element = this[name] ?: return null\n");
    out.push_str("    if (element is JsonNull) return null\n");
    out.push_str(
        "    return element.jsonPrimitive.longOrNull ?: error(\"field $name is not an integer\")\n",
    );
    out.push_str("}\n\n");
    out.push_str("private fun JsonObject.syncularRequiredDouble(name: String): Double =\n");
    out.push_str("    syncularOptionalDouble(name) ?: error(\"missing double field $name\")\n\n");
    out.push_str("private fun JsonObject.syncularOptionalDouble(name: String): Double? {\n");
    out.push_str("    val element = this[name] ?: return null\n");
    out.push_str("    if (element is JsonNull) return null\n");
    out.push_str(
        "    return element.jsonPrimitive.doubleOrNull ?: error(\"field $name is not a double\")\n",
    );
    out.push_str("}\n\n");
    out.push_str("private fun JsonObject.syncularRequiredBoolean(name: String): Boolean =\n");
    out.push_str("    syncularOptionalBoolean(name) ?: error(\"missing boolean field $name\")\n\n");
    out.push_str("private fun JsonObject.syncularOptionalBoolean(name: String): Boolean? {\n");
    out.push_str("    val element = this[name] ?: return null\n");
    out.push_str("    if (element is JsonNull) return null\n");
    out.push_str("    return element.jsonPrimitive.booleanOrNull ?: error(\"field $name is not a boolean\")\n");
    out.push_str("}\n\n");
    out.push_str("private fun syncularJsonValue(value: Any?): String = when (value) {\n");
    out.push_str("    null -> \"null\"\n");
    out.push_str("    is SyncularBlobRef -> syncularJsonString(value.toJsonString())\n");
    out.push_str("    is String -> syncularJsonString(value)\n");
    out.push_str("    is Number -> value.toString()\n");
    out.push_str("    is Boolean -> value.toString()\n");
    out.push_str("    is Map<*, *> -> value.entries.joinToString(prefix = \"{\", postfix = \"}\") { entry -> syncularJsonString(entry.key.toString()) + \":\" + syncularJsonValue(entry.value) }\n");
    out.push_str("    is Iterable<*> -> value.joinToString(prefix = \"[\", postfix = \"]\") { syncularJsonValue(it) }\n");
    out.push_str("    else -> syncularJsonString(value.toString())\n");
    out.push_str("}\n\n");
    out.push_str("private fun syncularJsonString(value: String): String = buildString {\n");
    out.push_str("    append('\\\"')\n");
    out.push_str("    for (ch in value) {\n");
    out.push_str("        when (ch) {\n");
    out.push_str("            '\\\\' -> append(\"\\\\\\\\\")\n");
    out.push_str("            '\\\"' -> append(\"\\\\\\\"\")\n");
    out.push_str("            '\\n' -> append(\"\\\\n\")\n");
    out.push_str("            '\\r' -> append(\"\\\\r\")\n");
    out.push_str("            '\\t' -> append(\"\\\\t\")\n");
    out.push_str("            else -> append(ch)\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("    append('\\\"')\n");
    out.push_str("}\n");

    Ok(out)
}

fn temp_sqlite_path() -> Result<PathBuf> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock before unix epoch")?
        .as_nanos();
    Ok(env::temp_dir().join(format!(
        "syncular-schema-{}-{now}.sqlite",
        std::process::id()
    )))
}

fn format_rust(source: String) -> Result<String> {
    let mut child = Command::new("rustfmt")
        .arg("--edition=2021")
        .arg("--emit=stdout")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("spawn rustfmt")?;

    child
        .stdin
        .as_mut()
        .context("open rustfmt stdin")?
        .write_all(source.as_bytes())
        .context("write rustfmt stdin")?;

    let output = child.wait_with_output().context("wait for rustfmt")?;
    if !output.status.success() {
        bail!(
            "rustfmt failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    String::from_utf8(output.stdout).context("rustfmt output was not utf8")
}

#[derive(Debug)]
struct CodegenArgs {
    check: bool,
    manifest_dir: PathBuf,
    migrations_dir: Option<PathBuf>,
    rust_output_dir: Option<PathBuf>,
}

fn usage() -> &'static str {
    "usage: syncular-codegen [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>]"
}

fn parse_args() -> Result<CodegenArgs> {
    let mut check = false;
    let mut manifest_dir = None;
    let mut migrations_dir = None;
    let mut rust_output_dir = None;
    let mut args = env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--check" => check = true,
            "--manifest-dir" => {
                manifest_dir =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        anyhow::anyhow!("--manifest-dir requires a path")
                    })?));
            }
            "--migrations-dir" => {
                migrations_dir =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        anyhow::anyhow!("--migrations-dir requires a path")
                    })?));
            }
            "--rust-output-dir" => {
                rust_output_dir =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        anyhow::anyhow!("--rust-output-dir requires a path")
                    })?));
            }
            "--help" | "-h" => bail!(usage()),
            _ => bail!(usage()),
        }
    }

    Ok(CodegenArgs {
        check,
        manifest_dir: manifest_dir
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        migrations_dir,
        rust_output_dir,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let check = args.check;
    let manifest_dir = args.manifest_dir;
    let migrations_dir = args
        .migrations_dir
        .unwrap_or_else(|| manifest_dir.join("migrations"));
    let generated_dir = args
        .rust_output_dir
        .unwrap_or_else(|| manifest_dir.join("generated/rust"));
    let schema_path = generated_dir.join("schema.rs");
    let diesel_tables_path = generated_dir.join("diesel_tables.rs");
    let migrations_path = generated_dir.join("migrations.rs");
    let generated_path = generated_dir.join("syncular.rs");
    let sqlite_path = temp_sqlite_path()?;
    let _ = fs::remove_file(&sqlite_path);

    let mut conn = SqliteConnection::establish(sqlite_path.to_str().context("utf8 sqlite path")?)
        .with_context(|| format!("open {}", sqlite_path.display()))?;
    apply_migrations(&mut conn, &migrations_dir)?;

    let tables = load_tables(&mut conn)?;
    let codegen_config = load_codegen_config(&manifest_dir)?;
    validate_codegen_config(&tables, &codegen_config)?;
    let schema_version = current_schema_version_from_migrations(&migrations_dir)?;
    let schema_json_path = codegen_config.schema_output_path(&manifest_dir)?;
    let generated_ts_path = codegen_config.typescript_output_path(&manifest_dir)?;
    let generated_swift_path = codegen_config.native_swift_output_path(&manifest_dir)?;
    let generated_kotlin_path = codegen_config.native_kotlin_output_path(&manifest_dir)?;
    let generated_android_kotlin_path =
        codegen_config.native_android_kotlin_output_path(&manifest_dir)?;
    let schema_json =
        generate_schema_json(&tables, &codegen_config, &migrations_dir, schema_version)?;
    let (schema_tables, schema_codegen_config, schema_version) =
        schema_backed_codegen_inputs(&schema_json, &codegen_config, &tables)?;
    let generated_android_kotlin_package =
        codegen_config.native_android_kotlin_package()?.to_string();
    let schema = format_rust(generate_schema(&schema_tables)?)?;
    let diesel_tables = format_rust(generate_diesel_tables(
        &schema_tables,
        &schema_codegen_config,
    )?)?;
    let migrations = format_rust(generate_migrations_module(
        &manifest_dir,
        &migrations_dir,
        &schema_codegen_config,
    )?)?;
    let generated = format_rust(generate_generated_module(
        &schema_tables,
        &schema_codegen_config,
    )?)?;
    let runtime_app_schema_json = generate_runtime_app_schema_json(
        &schema_tables,
        &schema_codegen_config,
        Some(&migrations_dir),
        schema_version,
    )?;
    let generated_ts =
        generate_typescript_module(&schema_tables, &schema_codegen_config, schema_version)?;
    let generated_swift = generate_swift_module(
        &schema_tables,
        &schema_codegen_config,
        schema_version,
        &runtime_app_schema_json,
    )?;
    let generated_kotlin = generate_kotlin_module(
        &schema_tables,
        &schema_codegen_config,
        schema_version,
        &runtime_app_schema_json,
        None,
    )?;
    let generated_android_kotlin = generated_android_kotlin_path
        .as_ref()
        .map(|_| {
            generate_kotlin_module(
                &schema_tables,
                &schema_codegen_config,
                schema_version,
                &runtime_app_schema_json,
                Some(generated_android_kotlin_package.as_str()),
            )
        })
        .transpose()?;
    let _ = fs::remove_file(&sqlite_path);

    if check {
        let existing = fs::read_to_string(&schema_json_path)
            .with_context(|| format!("read {}", schema_json_path.display()))?;
        if existing != schema_json {
            bail!(
                "{} is out of date; run `{}`",
                schema_json_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&schema_path)
            .with_context(|| format!("read {}", schema_path.display()))?;
        if existing != schema {
            bail!(
                "{} is out of date; run `{}`",
                schema_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&diesel_tables_path)
            .with_context(|| format!("read {}", diesel_tables_path.display()))?;
        if existing != diesel_tables {
            bail!(
                "{} is out of date; run `{}`",
                diesel_tables_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&migrations_path)
            .with_context(|| format!("read {}", migrations_path.display()))?;
        if existing != migrations {
            bail!(
                "{} is out of date; run `{}`",
                migrations_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&generated_path)
            .with_context(|| format!("read {}", generated_path.display()))?;
        if existing != generated {
            bail!(
                "{} is out of date; run `{}`",
                generated_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&generated_ts_path)
            .with_context(|| format!("read {}", generated_ts_path.display()))?;
        if existing != generated_ts {
            bail!(
                "{} is out of date; run `{}`",
                generated_ts_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&generated_swift_path)
            .with_context(|| format!("read {}", generated_swift_path.display()))?;
        if existing != generated_swift {
            bail!(
                "{} is out of date; run `{}`",
                generated_swift_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        let existing = fs::read_to_string(&generated_kotlin_path)
            .with_context(|| format!("read {}", generated_kotlin_path.display()))?;
        if existing != generated_kotlin {
            bail!(
                "{} is out of date; run `{}`",
                generated_kotlin_path.display(),
                "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
            );
        }
        if let (Some(path), Some(generated)) = (
            generated_android_kotlin_path.as_ref(),
            generated_android_kotlin.as_ref(),
        ) {
            let existing =
                fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
            if existing != *generated {
                bail!(
                    "{} is out of date; run `{}`",
                    path.display(),
                    "cargo run --manifest-path rust/Cargo.toml -p syncular-codegen --"
                );
            }
        }
    } else {
        fs::create_dir_all(&generated_dir)
            .with_context(|| format!("create {}", generated_dir.display()))?;
        let mut output_paths = vec![
            &schema_json_path,
            &generated_ts_path,
            &generated_swift_path,
            &generated_kotlin_path,
        ];
        if let Some(path) = generated_android_kotlin_path.as_ref() {
            output_paths.push(path);
        }
        for path in output_paths {
            let Some(parent) = path.parent() else {
                continue;
            };
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        fs::write(&schema_json_path, schema_json)
            .with_context(|| format!("write {}", schema_json_path.display()))?;
        fs::write(&schema_path, schema)
            .with_context(|| format!("write {}", schema_path.display()))?;
        fs::write(&diesel_tables_path, diesel_tables)
            .with_context(|| format!("write {}", diesel_tables_path.display()))?;
        fs::write(&migrations_path, migrations)
            .with_context(|| format!("write {}", migrations_path.display()))?;
        fs::write(&generated_path, generated)
            .with_context(|| format!("write {}", generated_path.display()))?;
        fs::write(&generated_ts_path, generated_ts)
            .with_context(|| format!("write {}", generated_ts_path.display()))?;
        fs::write(&generated_swift_path, generated_swift)
            .with_context(|| format!("write {}", generated_swift_path.display()))?;
        fs::write(&generated_kotlin_path, generated_kotlin)
            .with_context(|| format!("write {}", generated_kotlin_path.display()))?;
        if let (Some(path), Some(generated)) =
            (generated_android_kotlin_path, generated_android_kotlin)
        {
            fs::write(&path, generated).with_context(|| format!("write {}", path.display()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(
        name: &str,
        sql_type: &str,
        notnull: bool,
        pk: bool,
        dflt_value: Option<&str>,
    ) -> ColumnRow {
        ColumnRow {
            name: name.to_string(),
            sql_type: sql_type.to_string(),
            notnull: i32::from(notnull),
            pk: i32::from(pk),
            dflt_value: dflt_value.map(str::to_string),
        }
    }

    fn table(name: &str, columns: Vec<ColumnRow>) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            columns,
        }
    }

    fn scope(name: &str, column: &str, source: &str, required: bool) -> ScopeCodegenConfig {
        ScopeCodegenConfig {
            name: Some(name.to_string()),
            column: column.to_string(),
            source: Some(source.to_string()),
            required,
        }
    }

    fn table_config(
        subscription_id: &str,
        server_version_column: &str,
        scopes: Vec<ScopeCodegenConfig>,
    ) -> TableCodegenConfig {
        TableCodegenConfig {
            actor_scope_column: None,
            project_scope_column: None,
            subscription_id: Some(subscription_id.to_string()),
            subscription_params: BTreeMap::new(),
            scopes,
            server_version_column: Some(server_version_column.to_string()),
            blob_columns: Vec::new(),
            crdt_yjs_fields: Vec::new(),
            encrypted_fields: Vec::new(),
            soft_delete_column: None,
        }
    }

    fn temp_test_dir(name: &str) -> Result<PathBuf> {
        let path = env::temp_dir().join(format!(
            "syncular-codegen-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        Ok(path)
    }

    fn test_app_schema_json(
        tables: &[TableInfo],
        config: &CodegenConfig,
        schema_version: i32,
    ) -> Result<String> {
        generate_runtime_app_schema_json(tables, config, None, schema_version)
    }

    #[test]
    fn schema_output_path_defaults_to_manifest_schema_json() -> Result<()> {
        let config = CodegenConfig::default();
        assert_eq!(
            config.schema_output_path(Path::new("/workspace/app"))?,
            PathBuf::from("/workspace/app/syncular.schema.json")
        );
        Ok(())
    }

    #[test]
    fn typescript_output_path_defaults_to_generated_browser_file() -> Result<()> {
        let config = CodegenConfig::default();
        assert_eq!(
            config.typescript_output_path(Path::new("/workspace/app"))?,
            PathBuf::from("/workspace/app/generated/typescript/syncular.generated.ts")
        );
        Ok(())
    }

    #[test]
    fn typescript_output_path_uses_configured_relative_path() -> Result<()> {
        let config = CodegenConfig {
            typescript_output_path: Some(PathBuf::from("src/generated/syncular.ts")),
            ..CodegenConfig::default()
        };
        assert_eq!(
            config.typescript_output_path(Path::new("/workspace/app"))?,
            PathBuf::from("/workspace/app/src/generated/syncular.ts")
        );
        Ok(())
    }

    #[test]
    fn typescript_runtime_import_path_defaults_to_v2_client_package() -> Result<()> {
        let config = CodegenConfig::default();
        assert_eq!(
            config.typescript_runtime_import_path()?,
            "@syncular/client-rust"
        );
        Ok(())
    }

    #[test]
    fn rust_runtime_crate_path_defaults_to_rust_sdk_package() -> Result<()> {
        let config = CodegenConfig::default();
        assert_eq!(config.rust_runtime_crate_path()?, "syncular_client");
        Ok(())
    }

    #[test]
    fn rust_runtime_crate_path_can_target_runtime_internals() -> Result<()> {
        let config = CodegenConfig {
            rust_runtime_crate_path: Some("syncular_runtime".to_string()),
            ..CodegenConfig::default()
        };
        assert_eq!(config.rust_runtime_crate_path()?, "syncular_runtime");
        Ok(())
    }

    #[test]
    fn native_output_paths_default_to_app_generated_files() -> Result<()> {
        let config = CodegenConfig::default();
        assert_eq!(
            config.native_swift_output_path(Path::new("/workspace/app"))?,
            PathBuf::from("/workspace/app/generated/swift/SyncularApp.swift")
        );
        assert_eq!(
            config.native_kotlin_output_path(Path::new("/workspace/app"))?,
            PathBuf::from("/workspace/app/generated/kotlin/SyncularApp.kt")
        );
        assert_eq!(
            config.native_android_kotlin_output_path(Path::new("/workspace/app"))?,
            None
        );
        assert_eq!(
            config.native_android_kotlin_package()?,
            "dev.syncular.client.generated"
        );
        Ok(())
    }

    #[test]
    fn native_android_kotlin_output_path_uses_configured_relative_path() -> Result<()> {
        let config = CodegenConfig {
            native_android_kotlin_output_path: Some(PathBuf::from(
                "generated/kotlin/android/SyncularApp.kt",
            )),
            native_android_kotlin_package: Some("dev.syncular.client.generated".to_string()),
            ..CodegenConfig::default()
        };
        assert_eq!(
            config.native_android_kotlin_output_path(Path::new("/workspace/app"))?,
            Some(PathBuf::from(
                "/workspace/app/generated/kotlin/android/SyncularApp.kt"
            ))
        );
        assert_eq!(
            config.native_android_kotlin_package()?,
            "dev.syncular.client.generated"
        );
        Ok(())
    }

    #[test]
    fn schema_json_includes_stable_cross_platform_metadata() -> Result<()> {
        let migrations_dir = temp_test_dir("schema-json")?;
        fs::create_dir_all(migrations_dir.join("0001_initial"))?;
        fs::create_dir_all(migrations_dir.join("0002_add_images"))?;

        let tables = vec![table(
            "tasks",
            vec![
                column("id", "TEXT", false, true, None),
                column("title", "TEXT", true, false, None),
                column("project_id", "TEXT", false, false, None),
                column("image", "TEXT", false, false, None),
                column("deleted", "INTEGER", true, false, Some("0")),
                column("server_version", "BIGINT", true, false, Some("0")),
            ],
        )];
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![scope("project_id", "project_id", "projectId", false)],
        );
        tasks_config.blob_columns = vec!["image".to_string()];
        tasks_config.soft_delete_column = Some("deleted".to_string());
        tasks_config.encrypted_fields = vec![EncryptedFieldConfig {
            field: "title".to_string(),
            scope: None,
            row_id_field: None,
        }];
        tasks_config
            .subscription_params
            .insert("includeArchived".to_string(), serde_json::json!(true));
        let config = CodegenConfig {
            tables: BTreeMap::from([("tasks".to_string(), tasks_config)]),
            ..CodegenConfig::default()
        };

        let output = generate_schema_json(&tables, &config, &migrations_dir, 2)?;
        let json: JsonValue = serde_json::from_str(&output)?;
        let table = &json["tables"][0];

        assert_eq!(json["contractVersion"], 1);
        assert_eq!(json["appSchemaVersion"], 2);
        assert_eq!(json["migrations"][1]["version"], "0002");
        assert_eq!(json["migrations"][1]["name"], "add_images");
        assert_eq!(table["name"], "tasks");
        assert_eq!(table["primaryKeyColumn"], "id");
        assert_eq!(table["serverVersionColumn"], "server_version");
        assert_eq!(table["softDeleteColumn"], "deleted");
        assert_eq!(table["blobColumns"][0], "image");
        assert_eq!(table["encryptedFields"][0]["field"], "title");
        assert_eq!(table["encryptedFields"][0]["scope"], "tasks");
        assert_eq!(table["encryptedFields"][0]["rowIdField"], "id");
        assert_eq!(table["subscription"]["id"], "sub-tasks");
        assert_eq!(table["subscription"]["params"]["includeArchived"], true);
        assert_eq!(table["scopes"][0]["name"], "project_id");
        assert_eq!(table["scopes"][0]["source"], "projectId");

        let columns = table["columns"].as_array().expect("columns array");
        let image = columns
            .iter()
            .find(|column| column["name"] == "image")
            .expect("image column");
        assert_eq!(image["sqlType"], "TEXT");
        assert_eq!(image["typeFamily"], "text");
        assert_eq!(image["appType"], "blobRef");
        assert_eq!(image["nullable"], true);
        assert_eq!(image["blobRef"], true);

        let deleted = columns
            .iter()
            .find(|column| column["name"] == "deleted")
            .expect("deleted column");
        assert_eq!(deleted["appType"], "integer");
        assert_eq!(deleted["softDelete"], true);
        assert_eq!(deleted["hasDefault"], true);
        assert_eq!(deleted["defaultSql"], "0");

        let project_id = columns
            .iter()
            .find(|column| column["name"] == "project_id")
            .expect("project_id column");
        assert_eq!(project_id["scope"], "project_id");

        let _ = fs::remove_dir_all(&migrations_dir);
        Ok(())
    }

    #[test]
    fn schema_json_drives_language_generation() -> Result<()> {
        let migrations_dir = temp_test_dir("schema-backed-generation")?;
        fs::create_dir_all(migrations_dir.join("0001_initial"))?;
        fs::create_dir_all(migrations_dir.join("0002_add_images"))?;

        let tables = vec![table(
            "tasks",
            vec![
                column("id", "TEXT", false, true, None),
                column("title", "TEXT", true, false, None),
                column("project_id", "TEXT", false, false, None),
                column("image", "TEXT", false, false, None),
                column("deleted", "INTEGER", true, false, Some("0")),
                column("server_version", "BIGINT", true, false, Some("0")),
            ],
        )];
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![scope("project_id", "project_id", "projectId", false)],
        );
        tasks_config.blob_columns = vec!["image".to_string()];
        tasks_config.soft_delete_column = Some("deleted".to_string());
        tasks_config.encrypted_fields = vec![EncryptedFieldConfig {
            field: "title".to_string(),
            scope: None,
            row_id_field: None,
        }];
        tasks_config
            .subscription_params
            .insert("includeArchived".to_string(), serde_json::json!(true));
        let config = CodegenConfig {
            tables: BTreeMap::from([("tasks".to_string(), tasks_config)]),
            ..CodegenConfig::default()
        };

        let schema_json = generate_schema_json(&tables, &config, &migrations_dir, 2)?;
        let (schema_tables, schema_config, schema_version) =
            schema_backed_codegen_inputs(&schema_json, &config, &tables)?;

        assert_eq!(schema_version, 2);
        assert_eq!(
            generate_generated_module(&schema_tables, &schema_config)?,
            generate_generated_module(&tables, &config)?
        );
        assert_eq!(
            generate_diesel_tables(&schema_tables, &schema_config)?,
            generate_diesel_tables(&tables, &config)?
        );
        assert_eq!(
            generate_typescript_module(&schema_tables, &schema_config, schema_version)?,
            generate_typescript_module(&tables, &config, 2)?
        );
        assert_eq!(
            generate_swift_module(
                &schema_tables,
                &schema_config,
                schema_version,
                &test_app_schema_json(&schema_tables, &schema_config, schema_version)?,
            )?,
            generate_swift_module(
                &tables,
                &config,
                2,
                &test_app_schema_json(&tables, &config, 2)?
            )?
        );
        assert_eq!(
            generate_kotlin_module(
                &schema_tables,
                &schema_config,
                schema_version,
                &test_app_schema_json(&schema_tables, &schema_config, schema_version)?,
                None,
            )?,
            generate_kotlin_module(
                &tables,
                &config,
                2,
                &test_app_schema_json(&tables, &config, 2)?,
                None,
            )?
        );

        let _ = fs::remove_dir_all(&migrations_dir);
        Ok(())
    }

    #[test]
    fn typescript_module_supports_multiple_app_tables() -> Result<()> {
        let tables = vec![
            table(
                "tasks",
                vec![
                    column("id", "TEXT", false, true, None),
                    column("title", "TEXT", true, false, None),
                    column("completed", "INTEGER", true, false, Some("0")),
                    column("deleted", "INTEGER", true, false, Some("0")),
                    column("user_id", "TEXT", true, false, None),
                    column("project_id", "TEXT", false, false, None),
                    column("server_version", "BIGINT", true, false, Some("0")),
                    column("image", "TEXT", false, false, None),
                ],
            ),
            table(
                "projects",
                vec![
                    column("id", "TEXT", false, true, None),
                    column("name", "TEXT", true, false, None),
                    column("owner_id", "TEXT", true, false, None),
                    column("server_version", "BIGINT", true, false, Some("0")),
                ],
            ),
        ];
        let mut table_configs = BTreeMap::new();
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![
                scope("user_id", "user_id", "actorId", true),
                scope("project_id", "project_id", "projectId", false),
            ],
        );
        tasks_config.blob_columns = vec!["image".to_string()];
        tasks_config.soft_delete_column = Some("deleted".to_string());
        tasks_config.encrypted_fields = vec![EncryptedFieldConfig {
            field: "title".to_string(),
            scope: Some("tasks".to_string()),
            row_id_field: None,
        }];
        tasks_config
            .subscription_params
            .insert("includeArchived".to_string(), serde_json::json!(false));
        table_configs.insert("tasks".to_string(), tasks_config);
        table_configs.insert(
            "projects".to_string(),
            table_config(
                "sub-projects",
                "server_version",
                vec![scope("user_id", "owner_id", "actorId", true)],
            ),
        );
        let config = CodegenConfig {
            tables: table_configs,
            typescript_runtime_import_path: Some("@app/sync-runtime".to_string()),
            ..CodegenConfig::default()
        };

        let output = generate_typescript_module(&tables, &config, 7)?;

        assert!(output.contains(
            "import { SYNCULAR_V2_PACKAGE_NAME, SYNCULAR_V2_PACKAGE_VERSION, SYNCULAR_V2_WORKER_PROTOCOL_VERSION, createSyncularRustSqliteDatabase, withSyncularV2SchemaWrites } from '@app/sync-runtime';"
        ));
        assert!(output.contains(
            "import type { CreateSyncularRustSqliteDatabaseOptions, SyncularRustSqliteDatabase, SyncularV2AppSchema, SyncularV2ChangedRow, SyncularV2FieldEncryptionConfig, SyncularV2FieldEncryptionRule, SyncularV2RowsChangedEvent, SyncularV2RuntimeInfo, SyncularYjsPayloadEnvelope } from '@app/sync-runtime';"
        ));
        assert!(output.contains("import { sql, type Kysely } from 'kysely';"));
        assert!(output.contains(
            "import { codecs, type BlobRef, type ColumnCodecSource } from '@syncular/core';"
        ));
        assert!(output.contains("export interface SyncularAppDb"));
        assert!(output.contains(
            "export type SyncularAppDatabase = SyncularRustSqliteDatabase<SyncularAppDb>;"
        ));
        assert!(output.contains("export async function createSyncularAppDatabase("));
        assert!(output.contains(
            "export interface CreateSyncularAppDatabaseOptions extends CreateSyncularRustSqliteDatabaseOptions"
        ));
        assert!(output.contains("subscriptions?: SyncularAppSubscriptionsOption;"));
        assert!(output.contains("function resolveSyncularAppSubscriptions("));
        assert!(output.contains("if (subscriptions === false) return [];"));
        assert!(output.contains(
            "export async function assertSyncularAppRuntime(database: Pick<SyncularAppDatabase, 'client'>): Promise<void> {"
        ));
        assert!(output.contains(
            "export function assertSyncularAppRuntimeInfo(runtimeInfo: SyncularV2RuntimeInfo): void {"
        ));
        assert!(output.contains("await assertSyncularAppRuntime(database);"));
        assert!(output
            .contains("runtimeInfo.workerProtocolVersion !== SYNCULAR_V2_WORKER_PROTOCOL_VERSION"));
        assert!(
            output.contains("const schemaState = await database.client.generatedSchemaState();")
        );
        assert!(
            output.contains("schemaState.currentSchemaVersion !== syncularGeneratedSchemaVersion")
        );
        assert!(output.contains("export const syncularGeneratedRequiredRuntimeFeatures = ["));
        assert!(output.contains("  'web-owned-sqlite-core',"));
        assert!(output.contains("  'blobs',"));
        assert!(output.contains("  'e2ee',"));
        assert!(output.contains("for (const feature of syncularGeneratedRequiredRuntimeFeatures)"));
        assert!(output.contains("runtimeInfo.rust.features.includes(feature)"));
        assert!(
            output.contains("requiredRuntimeFeatures: syncularGeneratedRequiredRuntimeFeatures")
        );
        assert!(
            output.contains("await withSyncularV2SchemaWrites(database, ensureSyncularAppSchema);")
        );
        assert!(output.contains("await database.client.setSubscriptions("));
        assert!(output.contains(
            "await database.client.setSubscriptions(resolveSyncularAppSubscriptions(options));"
        ));
        assert!(!output.contains("createSyncularAppWebStoreHost"));
        assert!(!output.contains("SyncularWebStoreHostConfig"));
        assert!(output.contains(
            "export async function ensureSyncularAppSchema(db: Kysely<any>): Promise<void> {"
        ));
        assert!(output.contains("export const syncularGeneratedSchemaVersion = 7 as const;"));
        assert!(output.contains("await ensureSyncularAppSchemaMetadata(db);"));
        assert!(output.contains("async function validateSyncularAppSchema(db: Kysely<any>)"));
        assert!(output.contains("    .createTable('projects')"));
        assert!(output.contains("    .addColumn('owner_id', 'text', (col) => col.notNull())"));
        assert!(output.contains(
            "    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))"
        ));
        assert!(output.contains("    .addColumn('project_id', 'text')"));
        assert!(output.contains("  tasks: TaskRow;"));
        assert!(output.contains("  projects: ProjectRow;"));
        assert!(output.contains("export interface SyncularGeneratedTableConfig"));
        assert!(output.contains("export const syncularGeneratedTableConfig = {"));
        assert!(output.contains("export const syncularGeneratedAppSchema = {"));
        assert!(output.contains("} satisfies SyncularV2AppSchema;"));
        assert!(output.contains("    primaryKeyColumn: 'id',"));
        assert!(output.contains("    serverVersionColumn: 'server_version',"));
        assert!(output.contains("    softDeleteColumn: 'deleted',"));
        assert!(output.contains("    subscriptionId: 'sub-tasks',"));
        assert!(output.contains("    subscriptionParams: { includeArchived: false },"));
        assert!(output.contains("    blobColumns: ['image'],"));
        assert!(output.contains(
            "    encryptedFields: [{ field: 'title', scope: 'tasks', rowIdField: 'id' }],"
        ));
        assert!(output.contains("export const syncularGeneratedFieldEncryptionRules = ["));
        assert!(output.contains(
            "  { scope: 'tasks', table: 'tasks', fields: ['title'], rowIdField: 'id' },"
        ));
        assert!(output.contains("export function syncularGeneratedFieldEncryptionConfig("));
        assert!(output.contains("export const syncularGeneratedAppTables = ["));
        assert!(output.contains("  'projects',"));
        assert!(output
            .contains("      appSchema: options.config.appSchema ?? syncularGeneratedAppSchema,"));
        assert!(output.contains("    appTables: syncularGeneratedAppTables,"));
        assert!(output
            .contains("tableConfig: { ...options.tableConfig, ...syncularGeneratedTableConfig },"));
        assert!(output.contains("export const syncularGeneratedCodecs: ColumnCodecSource"));
        assert!(output.contains("return codecs.stringJson<BlobRef>"));
        assert!(output.contains("      user_id: 'owner_id',"));
        assert!(!output.contains("TASKS_TABLE"));
        assert!(!output.contains("TASKS_COLUMNS"));
        assert!(!output.contains("PROJECTS_TABLE"));
        assert!(!output.contains("SyncularTableMetadata"));
        assert!(output.contains("export interface ProjectRow"));
        assert!(output.contains("export interface NewProjectPayload"));
        assert!(output.contains("export function newProjectPayload"));
        assert!(output.contains("export function projectPatchPayload"));
        assert!(output.contains("export function newProjectOperation"));
        assert!(output.contains("export function projectSubscription"));
        assert!(output.contains("id: 'sub-projects'"));
        assert!(output.contains("table: 'projects'"));
        assert!(output.contains("scopes['user_id'] = args.actorId;"));
        assert!(output.contains("params: { includeArchived: false },"));
        assert!(output.contains("export function taskPatchPayload"));
        assert!(output.contains("payload.completed = input.completed ?? 0;"));
        assert!(output.contains("payload.deleted = input.deleted ?? 0;"));
        assert!(output.contains("export function deleteTaskOperation"));
        assert!(output.contains("    op: 'upsert',\n    payload: { deleted: 1 },"));
        assert!(output.contains("  image: BlobRef | null;"));
        assert!(output.contains("  if (input.image !== undefined) payload.image = input.image;"));
        Ok(())
    }

    #[test]
    fn native_modules_support_runtime_contract_and_operation_builders() -> Result<()> {
        let tables = vec![
            table(
                "tasks",
                vec![
                    column("id", "TEXT", false, true, None),
                    column("title", "TEXT", true, false, None),
                    column("completed", "INTEGER", true, false, Some("0")),
                    column("deleted", "INTEGER", true, false, Some("0")),
                    column("user_id", "TEXT", true, false, None),
                    column("project_id", "TEXT", false, false, None),
                    column("server_version", "BIGINT", true, false, Some("0")),
                    column("image", "TEXT", false, false, None),
                ],
            ),
            table(
                "projects",
                vec![
                    column("id", "TEXT", false, true, None),
                    column("name", "TEXT", true, false, None),
                    column("owner_id", "TEXT", true, false, None),
                    column("server_version", "BIGINT", true, false, Some("0")),
                ],
            ),
        ];
        let mut table_configs = BTreeMap::new();
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![
                scope("user_id", "user_id", "actorId", true),
                scope("project_id", "project_id", "projectId", false),
            ],
        );
        tasks_config.soft_delete_column = Some("deleted".to_string());
        tasks_config.blob_columns = vec!["image".to_string()];
        tasks_config.encrypted_fields = vec![EncryptedFieldConfig {
            field: "title".to_string(),
            scope: None,
            row_id_field: None,
        }];
        table_configs.insert("tasks".to_string(), tasks_config);
        table_configs.insert(
            "projects".to_string(),
            table_config(
                "sub-projects",
                "server_version",
                vec![scope("user_id", "owner_id", "actorId", true)],
            ),
        );
        let config = CodegenConfig {
            tables: table_configs,
            ..CodegenConfig::default()
        };

        let swift = generate_swift_module(
            &tables,
            &config,
            7,
            &test_app_schema_json(&tables, &config, 7)?,
        )?;
        assert!(swift.contains("public let syncularNativeExpectedFfiAbiVersion = 1"));
        assert!(swift.contains("public let syncularNativeGeneratedSchemaVersion = 7"));
        assert!(swift.contains("public struct SyncularNativeRuntimeManifest"));
        assert!(swift.contains("manifest.storageBackend == \"diesel-sqlite\""));
        assert!(swift.contains("generated-json-local-operations"));
        assert!(swift.contains("generated-json-mutations"));
        assert!(swift.contains("read-only-query-json"));
        assert!(swift.contains("query-observer-events"));
        assert!(swift.contains("public struct NewTask"));
        assert!(swift.contains("public struct TaskPatch"));
        assert!(swift.contains("public struct SyncularReadonlyQuery"));
        assert!(swift.contains("public struct SyncularSubscriptionSpec"));
        assert!(swift.contains("public func syncularSubscriptionsJson"));
        assert!(swift.contains("public func syncularDefaultSubscriptionsJson"));
        assert!(swift.contains("public func taskSubscription(args: SyncularSubscriptionArgs)"));
        assert!(
            swift.contains("return SyncularSubscriptionSpec(id: \"sub-tasks\", table: \"tasks\"")
        );
        assert!(swift.contains("public struct SyncularBlobRef"));
        assert!(swift.contains("public struct SyncularQueryColumn"));
        assert!(swift.contains("public struct SyncularSelectQuery"));
        assert!(swift.contains("public func notEq(_ value: Value)"));
        assert!(swift.contains("public func isIn(_ values: [Value])"));
        assert!(swift.contains("public func isNotNull()"));
        assert!(swift.contains("public func and(_ other: SyncularQueryPredicate)"));
        assert!(swift.contains("public struct SyncularLiveQueryRegistration"));
        assert!(swift.contains("public struct SyncularChangedRow"));
        assert!(swift.contains("public struct SyncularNativeEvent"));
        assert!(swift.contains("public let changedRows: [SyncularChangedRow]"));
        assert!(swift.contains("public let commandId: String?"));
        assert!(swift.contains("public struct SyncularFieldEncryptionRule"));
        assert!(swift.contains("public struct SyncularFieldEncryptionConfig"));
        assert!(swift.contains(
            "SyncularFieldEncryptionRule(scope: \"tasks\", table: \"tasks\", fields: [\"title\"], rowIdField: \"id\")"
        ));
        assert!(swift.contains("public func syncularGeneratedFieldEncryptionConfigJson"));
        assert!(swift.contains("public func syncularDecodeNativeEvent"));
        assert!(swift.contains("public final class SyncularNativeLiveQuery"));
        assert!(swift.contains("public protocol SyncularNativeJsonClient"));
        assert!(swift.contains("func applyMutationJson(mutationJson: String"));
        assert!(swift.contains("func enqueueMutationJson(mutationJson: String"));
        assert!(!swift.contains("func applyLocalOperationJson"));
        assert!(swift.contains("func queryJson(requestJson: String"));
        assert!(swift.contains("func registerQueryJson(queryJson: String"));
        assert!(swift.contains("func unregisterQuery(id: String"));
        assert!(swift.contains("func query<Row: Decodable>(_ query: SyncularReadonlyQuery"));
        assert!(
            swift.contains("func registerLiveQuery(_ registration: SyncularLiveQueryRegistration")
        );
        assert!(swift.contains("public func refresh(on client: SyncularNativeJsonClient"));
        assert!(swift.contains("public func refreshIfChanged(event: SyncularNativeEvent"));
        assert!(swift.contains("func apply(_ operation: SyncularGeneratedOperation"));
        assert!(swift.contains("public enum SyncularAppOperations"));
        assert!(swift.contains("public enum TaskQuery"));
        assert!(swift.contains("public static let table = SyncularQueryTable<TaskRow>"));
        assert!(swift.contains("public static let projectId = SyncularQueryColumn<String>"));
        assert!(swift.contains("public static let image = SyncularQueryColumn<SyncularBlobRef>"));
        assert!(swift.contains("public static func select() -> SyncularSelectQuery<TaskRow>"));
        assert!(swift.contains("public static func newTask(_ input: NewTask"));
        assert!(!swift.contains("func listTasks()"));
        assert!(!swift.contains("func listTableJson"));
        assert!(swift.contains("func applyNewTask(_ input: NewTask"));
        assert!(swift.contains("func enqueueNewTask(_ input: NewTask"));
        assert!(swift.contains("func enqueueTaskPatch(rowId: String"));
        assert!(swift.contains("func enqueueTaskDelete(rowId: String"));
        assert!(swift.contains("func applyTaskPatch(rowId: String"));
        assert!(swift.contains("func applyTaskDelete(rowId: String"));
        assert!(swift.contains("payload[\"completed\"] = .int(input.completed ?? 0)"));
        assert!(swift.contains("payload[\"image\"] = value.syncularPayloadValue"));
        assert!(swift.contains("public let image: SyncularBlobRef?"));
        assert!(swift.contains("payload: [\"deleted\": .int(1)]"));
        assert!(swift.contains("case projectId = \"project_id\""));
        assert!(swift.contains("rowId: input.id"));
        assert!(!swift.contains("TASKS_TABLE"));

        let kotlin = generate_kotlin_module(
            &tables,
            &config,
            7,
            &test_app_schema_json(&tables, &config, 7)?,
            None,
        )?;
        assert!(kotlin.contains("const val syncularNativeExpectedFfiAbiVersion: Int = 1"));
        assert!(kotlin.contains("const val syncularNativeGeneratedSchemaVersion: Int = 7"));
        assert!(kotlin.contains("data class SyncularNativeRuntimeManifest"));
        assert!(kotlin.contains("manifest.storageBackend == \"diesel-sqlite\""));
        assert!(kotlin.contains("generated-json-local-operations"));
        assert!(kotlin.contains("generated-json-mutations"));
        assert!(kotlin.contains("read-only-query-json"));
        assert!(kotlin.contains("query-observer-events"));
        assert!(kotlin.contains("data class NewTask"));
        assert!(kotlin.contains("data class TaskPatch"));
        assert!(kotlin.contains("data class SyncularReadonlyQuery"));
        assert!(kotlin.contains("data class SyncularSubscriptionSpec"));
        assert!(kotlin.contains("fun syncularSubscriptionsJson"));
        assert!(kotlin.contains("fun syncularDefaultSubscriptionsJson"));
        assert!(kotlin.contains("fun taskSubscription(args: SyncularSubscriptionArgs)"));
        assert!(kotlin
            .contains("return SyncularSubscriptionSpec(id = \"sub-tasks\", table = \"tasks\""));
        assert!(kotlin.contains("data class SyncularBlobRef"));
        assert!(kotlin.contains("class SyncularQueryColumn"));
        assert!(kotlin.contains("data class SyncularSelectQuery"));
        assert!(kotlin.contains("fun notEq(value: T): SyncularQueryPredicate"));
        assert!(kotlin.contains("fun isIn(values: Iterable<T>): SyncularQueryPredicate"));
        assert!(kotlin.contains("fun isNotNull(): SyncularQueryPredicate"));
        assert!(kotlin.contains("infix fun and(other: SyncularQueryPredicate)"));
        assert!(kotlin.contains("data class SyncularLiveQueryRegistration"));
        assert!(kotlin.contains("data class SyncularChangedRow"));
        assert!(kotlin.contains("data class SyncularNativeEvent"));
        assert!(kotlin.contains("val changedRows: List<SyncularChangedRow> = emptyList()"));
        assert!(kotlin.contains("val commandId: String? = null"));
        assert!(kotlin.contains("fun syncularDecodeChangedRow(row: JsonObject)"));
        assert!(kotlin.contains("data class SyncularFieldEncryptionRule"));
        assert!(kotlin.contains(
            "SyncularFieldEncryptionRule(scope = \"tasks\", table = \"tasks\", fields = listOf(\"title\"), rowIdField = \"id\")"
        ));
        assert!(kotlin.contains("fun syncularGeneratedFieldEncryptionConfigJson("));
        assert!(kotlin.contains("fun syncularDecodeNativeEvent(eventJson: String)"));
        assert!(kotlin.contains("class SyncularNativeLiveQuery<Row>"));
        assert!(kotlin.contains("interface SyncularNativeJsonClient"));
        assert!(kotlin.contains("fun applyMutationJson(mutationJson: String"));
        assert!(kotlin.contains("fun enqueueMutationJson(mutationJson: String"));
        assert!(!kotlin.contains("fun applyLocalOperationJson"));
        assert!(kotlin.contains("fun queryJson(requestJson: String): String"));
        assert!(kotlin.contains("fun registerQueryJson(queryJson: String): String"));
        assert!(kotlin.contains("fun unregisterQuery(id: String): Boolean"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.query(query: SyncularReadonlyQuery)"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.registerLiveQuery"));
        assert!(kotlin.contains("fun refresh(client: SyncularNativeJsonClient): List<Row>"));
        assert!(kotlin.contains("fun refreshIfChanged(event: SyncularNativeEvent"));
        assert!(kotlin
            .contains("fun SyncularNativeJsonClient.apply(operation: SyncularGeneratedOperation"));
        assert!(kotlin.contains("object SyncularAppOperations"));
        assert!(kotlin.contains("object TaskQuery"));
        assert!(kotlin.contains("val table = SyncularQueryTable(name = \"tasks\""));
        assert!(kotlin.contains("val projectId = SyncularQueryColumn<String>"));
        assert!(kotlin.contains("val image = SyncularQueryColumn<SyncularBlobRef>"));
        assert!(kotlin.contains("fun select(): SyncularSelectQuery<TaskRow>"));
        assert!(kotlin.contains("fun newTask(input: NewTask"));
        assert!(kotlin.contains("import kotlinx.serialization.json.Json"));
        assert!(!kotlin.contains("fun SyncularNativeJsonClient.listTasks()"));
        assert!(!kotlin.contains("fun listTableJson"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.applyNewTask(input: NewTask"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.enqueueNewTask(input: NewTask"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.enqueueTaskPatch(rowId: String"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.enqueueTaskDelete(rowId: String"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.applyTaskPatch(rowId: String"));
        assert!(kotlin.contains("fun SyncularNativeJsonClient.applyTaskDelete(rowId: String"));
        assert!(kotlin.contains("private fun syncularDecodeTaskRows(json: String): List<TaskRow>"));
        assert!(kotlin.contains("image = row.syncularOptionalBlobRef(\"image\")"));
        assert!(kotlin.contains("private fun syncularGeneratedQueryRows(json: String)"));
        assert!(kotlin.contains("payload[\"completed\"] = input.completed ?: 0L"));
        assert!(kotlin.contains("payload[\"image\"] = it.toJsonValue()"));
        assert!(kotlin.contains("val image: SyncularBlobRef?"));
        assert!(kotlin.contains("payload = linkedMapOf(\"deleted\" to 1L)"));
        assert!(kotlin.contains("rowId = input.id"));
        assert!(!kotlin.contains("rowId = input.id.toString()"));
        assert!(kotlin.contains("fun toJsonString(): String"));
        assert!(!kotlin.contains("TASKS_TABLE"));

        let android_kotlin = generate_kotlin_module(
            &tables,
            &config,
            7,
            &test_app_schema_json(&tables, &config, 7)?,
            Some("dev.syncular.client.generated"),
        )?;
        assert!(android_kotlin.contains("package dev.syncular.client.generated"));
        assert!(android_kotlin.contains("object SyncularAppOperations"));

        Ok(())
    }

    #[test]
    fn generated_rust_module_includes_table_column_metadata() -> Result<()> {
        let tables = vec![table(
            "tasks",
            vec![
                column("id", "TEXT", false, true, None),
                column("title", "TEXT", true, false, None),
                column("image", "TEXT", false, false, None),
                column("project_id", "TEXT", false, false, None),
                column("server_version", "BIGINT", true, false, Some("0")),
            ],
        )];
        let mut table_configs = BTreeMap::new();
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![scope("project_id", "project_id", "projectId", false)],
        );
        tasks_config.blob_columns = vec!["image".to_string()];
        tasks_config.encrypted_fields = vec![EncryptedFieldConfig {
            field: "title".to_string(),
            scope: None,
            row_id_field: None,
        }];
        tasks_config
            .subscription_params
            .insert("includeArchived".to_string(), serde_json::json!(true));
        table_configs.insert("tasks".to_string(), tasks_config);
        let config = CodegenConfig {
            tables: table_configs,
            ..CodegenConfig::default()
        };

        let output = generate_generated_module(&tables, &config)?;

        assert!(output
            .contains("pub use syncular_client::app_schema::{AppTableMetadata, ColumnMetadata"));
        assert!(output.contains("pub const TASKS_COLUMNS: &[ColumnMetadata] = &["));
        assert!(output.contains(
            "ColumnMetadata { name: \"id\", type_family: \"text\", notnull_required: false, primary_key: true }"
        ));
        assert!(output.contains(
            "ColumnMetadata { name: \"title\", type_family: \"text\", notnull_required: true, primary_key: false }"
        ));
        assert!(output.contains(
            "ColumnMetadata { name: \"project_id\", type_family: \"text\", notnull_required: false, primary_key: false }"
        ));
        assert!(output.contains("pub const TASKS_BLOB_COLUMNS: &[&str] = &[\n    \"image\","));
        assert!(output.contains("blob_columns: TASKS_BLOB_COLUMNS"));
        assert!(output.contains("pub const TASKS_ENCRYPTED_FIELDS: &[EncryptedFieldMetadata]"));
        assert!(output.contains(
            "EncryptedFieldMetadata { field: \"title\", scope: \"tasks\", row_id_field: \"id\" }"
        ));
        assert!(output.contains("encrypted_fields: TASKS_ENCRYPTED_FIELDS"));
        assert!(output.contains("columns: TASKS_COLUMNS"));
        assert!(output.contains("params.insert(\"includeArchived\".to_string(), json!(true));"));
        assert!(output.contains("use syncular_client::client::{SubscriptionSpec, SyncChangedRow, SyncularClientConfig, SyncularEncryptedCrdtMutationExecutor, SyncularMutationExecutor};"));
        assert!(output.contains("use syncular_client::encryption::FieldEncryptionRule;"));
        assert!(output
            .contains("pub fn generated_field_encryption_rules() -> Vec<FieldEncryptionRule>"));
        assert!(output.contains(
            "FieldEncryptionRule { scope: \"tasks\".to_string(), table: Some(\"tasks\".to_string()), fields: vec![\"title\".to_string()], row_id_field: Some(\"id\".to_string()) }"
        ));
        assert!(output
            .contains("pub fn with_generated_id(title: &str, project_id: Option<&str>) -> Self"));
        assert!(output.contains("impl IntoSyncularMutation for NewTask"));
        assert!(output.contains("kind: SyncularMutationKind::Insert"));
        assert!(output.contains("impl IntoSyncularMutation for TaskPatch"));
        assert!(output.contains("kind: SyncularMutationKind::Update"));
        assert!(output.contains("pub struct DeleteTask"));
        assert!(output.contains("pub trait SyncularGeneratedMutationsExt"));
        assert!(output.contains("fn mutations(&mut self) -> SyncularAppMutations<'_, Self>"));
        assert!(output.contains("fn commit<R>("));
        assert!(output.contains("pub struct TaskMutations"));
        assert!(output.contains("pub fn insert(self, row: NewTask) -> Result<InsertReceipt>"));
        assert!(output.contains("pub fn update(self, patch: TaskPatch) -> Result<MutationReceipt>"));

        let diesel_tables = generate_diesel_tables(&tables, &config)?;
        assert!(diesel_tables.contains("pub struct TaskRow"));
        assert!(diesel_tables.contains("pub title: String"));
        assert!(diesel_tables.contains("Selectable, Insertable, Serialize, Deserialize"));
        Ok(())
    }

    #[test]
    fn generated_clients_include_encrypted_crdt_helpers() -> Result<()> {
        let tables = vec![table(
            "tasks",
            vec![
                column("id", "TEXT", false, true, None),
                column("title", "TEXT", true, false, None),
                column("title_yjs_state", "TEXT", false, false, None),
                column("user_id", "TEXT", true, false, None),
                column("server_version", "BIGINT", true, false, Some("0")),
            ],
        )];
        let mut table_configs = BTreeMap::new();
        let mut tasks_config = table_config(
            "sub-tasks",
            "server_version",
            vec![scope("user_id", "user_id", "actorId", true)],
        );
        tasks_config.crdt_yjs_fields = vec![CrdtYjsFieldConfig {
            field: "title".to_string(),
            state_column: "title_yjs_state".to_string(),
            container_key: Some("title".to_string()),
            row_id_field: Some("id".to_string()),
            kind: "text".to_string(),
            sync_mode: "encrypted-update-log".to_string(),
        }];
        table_configs.insert("tasks".to_string(), tasks_config);
        let config = CodegenConfig {
            tables: table_configs,
            ..CodegenConfig::default()
        };

        let output = generate_generated_module(&tables, &config)?;

        assert!(output.contains("tasks_title_crdt_updates_subscription(&config.actor_id)"));
        assert!(output.contains("table: \"sync_crdt_updates\".to_string()"));
        assert!(output.contains("table: \"sync_crdt_checkpoints\".to_string()"));
        assert!(output.contains("sync_mode: \"encrypted-update-log\""));
        assert!(output.contains(
            "pub fn update_title_text(self, row_id: &str, next_text: &str) -> Result<MutationReceipt>"
        ));
        assert!(output.contains("C: SyncularEncryptedCrdtMutationExecutor"));
        assert!(output.contains(
            "self.client.apply_encrypted_crdt_text_update(&TASKS_METADATA, \"title\", row_id, next_text)"
        ));
        assert!(output.contains(
            "pub fn checkpoint_title_text(self, row_id: &str, min_uncheckpointed_updates: i64) -> Result<Option<MutationReceipt>>"
        ));
        assert!(output.contains(
            "self.client.apply_encrypted_crdt_checkpoint(&TASKS_METADATA, \"title\", row_id, min_uncheckpointed_updates)"
        ));
        assert!(!output.contains("pub fn title_yjs_update"));

        let swift = generate_swift_module(
            &tables,
            &config,
            9,
            &test_app_schema_json(&tables, &config, 9)?,
        )?;
        assert!(swift.contains("generic-crdt-field-api"));
        assert!(swift.contains("queued-crdt-field-updates"));
        assert!(swift.contains("queued-encrypted-crdt"));
        assert!(swift.contains("public struct SyncularYjsUpdateEnvelope"));
        assert!(swift.contains("public struct SyncularCrdtFieldTextRequest"));
        assert!(swift.contains("public struct SyncularCrdtFieldDescriptor"));
        assert!(swift.contains("public struct SyncularCrdtFieldMaterialization"));
        assert!(swift.contains("func openCrdtFieldJson(requestJson: String"));
        assert!(swift.contains("func applyCrdtFieldTextJson(requestJson: String"));
        assert!(swift.contains("func enqueueCrdtFieldYjsUpdateJson(requestJson: String"));
        assert!(swift.contains("func enqueueCrdtFieldTextJson(requestJson: String"));
        assert!(swift.contains("func enqueueCrdtFieldCompactionJson(requestJson: String"));
        assert!(swift.contains("func openCrdtField(_ request: SyncularCrdtFieldRequest) throws -> SyncularCrdtFieldDescriptor"));
        assert!(swift.contains("func applyTaskTitleText(rowId: String, nextText: String) throws -> SyncularCrdtFieldWriteReceipt"));
        assert!(swift.contains("func enqueueTaskTitleText(rowId: String, nextText: String)"));
        assert!(swift.contains(
            "func materializeTaskTitle(rowId: String) throws -> SyncularCrdtFieldMaterialization"
        ));
        assert!(swift.contains("func materializeTaskTitleJson(rowId: String)"));
        assert!(swift.contains("func compactTaskTitle(rowId: String, minUncheckpointedUpdates: Int64 = 1) throws -> SyncularCrdtFieldCompactionReceipt"));
        assert!(swift.contains(
            "func enqueueTaskTitleCompaction(rowId: String, minUncheckpointedUpdates: Int64 = 1)"
        ));
        assert!(swift.contains("public struct SyncularEncryptedCrdtUpdateRequest"));
        assert!(swift.contains("func applyEncryptedCrdtUpdateJson(requestJson: String"));
        assert!(swift.contains("func enqueueEncryptedCrdtUpdateJson(requestJson: String"));
        assert!(swift.contains(
            "func applyEncryptedTaskTitleUpdate(rowId: String, update: SyncularYjsUpdateEnvelope)"
        ));
        assert!(swift.contains(
            "func enqueueEncryptedTaskTitleUpdate(rowId: String, update: SyncularYjsUpdateEnvelope)"
        ));
        assert!(swift.contains("func applyEncryptedTaskTitleText(rowId: String, nextText: String)"));
        assert!(
            swift.contains("func enqueueEncryptedTaskTitleText(rowId: String, nextText: String)")
        );
        assert!(swift.contains(
            "func applyEncryptedTaskTitleCheckpoint(rowId: String, minUncheckpointedUpdates: Int64 = 1)"
        ));
        assert!(swift.contains(
            "let request = SyncularEncryptedCrdtUpdateRequest(table: \"tasks\", field: \"title\", rowId: rowId, update: update)"
        ));
        assert!(swift.contains(
            "let request = SyncularEncryptedCrdtUpdateRequest(table: \"tasks\", field: \"title\", rowId: rowId, nextText: nextText)"
        ));

        let kotlin = generate_kotlin_module(
            &tables,
            &config,
            9,
            &test_app_schema_json(&tables, &config, 9)?,
            None,
        )?;
        assert!(kotlin.contains("generic-crdt-field-api"));
        assert!(kotlin.contains("queued-crdt-field-updates"));
        assert!(kotlin.contains("queued-encrypted-crdt"));
        assert!(kotlin.contains("data class SyncularYjsUpdateEnvelope"));
        assert!(kotlin.contains("data class SyncularCrdtFieldTextRequest"));
        assert!(kotlin.contains("data class SyncularCrdtFieldDescriptor"));
        assert!(kotlin.contains("data class SyncularCrdtFieldMaterialization"));
        assert!(kotlin.contains("fun openCrdtFieldJson(requestJson: String): String"));
        assert!(kotlin.contains("fun applyCrdtFieldTextJson(requestJson: String): String"));
        assert!(kotlin.contains("fun enqueueCrdtFieldYjsUpdateJson(requestJson: String): String"));
        assert!(kotlin.contains("fun enqueueCrdtFieldTextJson(requestJson: String): String"));
        assert!(kotlin.contains("fun enqueueCrdtFieldCompactionJson(requestJson: String): String"));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.openCrdtField(request: SyncularCrdtFieldRequest): SyncularCrdtFieldDescriptor"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.applyTaskTitleText(rowId: String, nextText: String): SyncularCrdtFieldWriteReceipt"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.enqueueTaskTitleText(rowId: String, nextText: String): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.materializeTaskTitle(rowId: String): SyncularCrdtFieldMaterialization"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.materializeTaskTitleJson(rowId: String): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.compactTaskTitle(rowId: String, minUncheckpointedUpdates: Long = 1): SyncularCrdtFieldCompactionReceipt"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.enqueueTaskTitleCompaction(rowId: String, minUncheckpointedUpdates: Long = 1): String"
        ));
        assert!(kotlin.contains("data class SyncularEncryptedCrdtUpdateRequest"));
        assert!(kotlin.contains("fun applyEncryptedCrdtUpdateJson(requestJson: String): String"));
        assert!(kotlin.contains("fun enqueueEncryptedCrdtUpdateJson(requestJson: String): String"));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.applyEncryptedTaskTitleUpdate(rowId: String, update: SyncularYjsUpdateEnvelope): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.enqueueEncryptedTaskTitleUpdate(rowId: String, update: SyncularYjsUpdateEnvelope): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.applyEncryptedTaskTitleText(rowId: String, nextText: String): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.enqueueEncryptedTaskTitleText(rowId: String, nextText: String): String"
        ));
        assert!(kotlin.contains(
            "fun SyncularNativeJsonClient.applyEncryptedTaskTitleCheckpoint(rowId: String, minUncheckpointedUpdates: Long = 1): String"
        ));
        assert!(kotlin.contains(
            "SyncularEncryptedCrdtUpdateRequest(table = \"tasks\", field = \"title\", rowId = rowId, update = update)"
        ));
        assert!(kotlin.contains(
            "SyncularEncryptedCrdtUpdateRequest(table = \"tasks\", field = \"title\", rowId = rowId, nextText = nextText)"
        ));

        let typescript = generate_typescript_module(&tables, &config, 9)?;
        assert!(typescript.contains("  'web-owned-sqlite-core',"));
        assert!(typescript.contains("  'crdt-yjs',"));
        assert!(typescript.contains("  'e2ee',"));
        Ok(())
    }
}
