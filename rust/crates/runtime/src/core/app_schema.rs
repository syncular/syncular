use crate::client::{SubscriptionSpec, SyncularClientConfig};
#[cfg(feature = "native")]
use crate::error::ErrorKind;
use crate::error::{Result, SyncularError};
#[cfg(feature = "native")]
use crate::protocol::{ScopeValues, SyncChange};
#[cfg(feature = "native")]
use diesel::sqlite::SqliteConnection;
use serde::{Deserialize, Serialize};
#[cfg(feature = "native")]
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScopeSource {
    ActorId,
    ProjectId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScopeMetadata {
    pub name: &'static str,
    pub column: &'static str,
    pub source: ScopeSource,
    pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ColumnMetadata {
    pub name: &'static str,
    pub type_family: &'static str,
    pub notnull_required: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CrdtYjsFieldMetadata {
    pub field: &'static str,
    pub state_column: &'static str,
    pub container_key: &'static str,
    pub row_id_field: &'static str,
    pub kind: &'static str,
    pub sync_mode: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EncryptedFieldMetadata {
    pub field: &'static str,
    pub scope: &'static str,
    pub row_id_field: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AppTableMetadata {
    pub name: &'static str,
    pub primary_key_column: &'static str,
    pub server_version_column: &'static str,
    pub soft_delete_column: Option<&'static str>,
    pub subscription_id: &'static str,
    pub columns: &'static [ColumnMetadata],
    pub blob_columns: &'static [&'static str],
    pub crdt_yjs_fields: &'static [CrdtYjsFieldMetadata],
    pub encrypted_fields: &'static [EncryptedFieldMetadata],
    pub scopes: &'static [ScopeMetadata],
}

#[derive(Debug, Clone, Copy)]
pub struct EmbeddedMigration {
    pub version: &'static str,
    pub schema_version: i32,
    pub name: &'static str,
    pub up_sql: &'static str,
}

#[cfg(feature = "native")]
pub trait DieselTableAdapter: Sync {
    fn name(&self) -> &'static str;
    fn list_rows_json(&self, conn: &mut SqliteConnection) -> Result<Vec<Value>>;
    fn clear_for_scopes(&self, conn: &mut SqliteConnection, scopes: &ScopeValues) -> Result<()>;
    fn upsert_row(
        &self,
        conn: &mut SqliteConnection,
        row: &Value,
        fallback_version: Option<i64>,
    ) -> Result<()>;
    fn upsert_rows(
        &self,
        conn: &mut SqliteConnection,
        rows: &[Value],
        fallback_version: Option<i64>,
    ) -> Result<()> {
        for row in rows {
            self.upsert_row(conn, row, fallback_version)?;
        }
        Ok(())
    }
    fn apply_change(&self, conn: &mut SqliteConnection, change: &SyncChange) -> Result<()>;
}

#[derive(Clone, Copy)]
pub struct AppSchema {
    pub app_tables: &'static [&'static str],
    pub app_table_metadata: &'static [AppTableMetadata],
    pub migrations: &'static [EmbeddedMigration],
    pub schema_version: Option<i32>,
    pub default_subscriptions: fn(&SyncularClientConfig) -> Vec<SubscriptionSpec>,
    #[cfg(feature = "native")]
    pub adapter_for: fn(&str) -> Result<&'static dyn DieselTableAdapter>,
}

impl AppSchema {
    pub fn current_schema_version(&self) -> i32 {
        self.schema_version
            .unwrap_or_else(|| current_schema_version(self.migrations))
    }

    pub fn table_metadata(&self, table: &str) -> Option<&'static AppTableMetadata> {
        self.app_table_metadata
            .iter()
            .find(|metadata| metadata.name == table)
    }

    pub fn default_subscriptions(&self, config: &SyncularClientConfig) -> Vec<SubscriptionSpec> {
        (self.default_subscriptions)(config)
    }

    #[cfg(feature = "native")]
    pub fn adapter_for(&self, table: &str) -> Result<&'static dyn DieselTableAdapter> {
        (self.adapter_for)(table)
    }
}

pub fn validate_app_schema_runtime_features(app_schema: &AppSchema) -> Result<()> {
    for table in app_schema.app_table_metadata {
        if !cfg!(any(feature = "native", feature = "web-blobs")) && !table.blob_columns.is_empty() {
            return Err(SyncularError::config(format!(
                "app schema table {} requires blobs runtime feature",
                table.name
            )));
        }

        if !cfg!(feature = "crdt-yjs") && !table.crdt_yjs_fields.is_empty() {
            return Err(SyncularError::config(format!(
                "app schema table {} requires crdt-yjs runtime feature",
                table.name
            )));
        }

        if !cfg!(feature = "e2ee")
            && (!table.encrypted_fields.is_empty()
                || table
                    .crdt_yjs_fields
                    .iter()
                    .any(|field| field.sync_mode == "encrypted-update-log"))
        {
            return Err(SyncularError::config(format!(
                "app schema table {} requires e2ee runtime feature",
                table.name
            )));
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSchemaJson {
    pub schema_version: i32,
    #[serde(default)]
    pub tables: Vec<AppTableMetadataJson>,
    #[serde(default)]
    pub migrations: Vec<EmbeddedMigrationJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedMigrationJson {
    pub version: String,
    pub schema_version: i32,
    pub name: String,
    pub up_sql: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTableMetadataJson {
    pub name: String,
    pub primary_key_column: String,
    pub server_version_column: String,
    pub soft_delete_column: Option<String>,
    pub subscription_id: String,
    #[serde(default)]
    pub columns: Vec<ColumnMetadataJson>,
    #[serde(default)]
    pub blob_columns: Vec<String>,
    #[serde(default)]
    pub crdt_yjs_fields: Vec<CrdtYjsFieldMetadataJson>,
    #[serde(default)]
    pub encrypted_fields: Vec<EncryptedFieldMetadataJson>,
    #[serde(default)]
    pub scopes: Vec<ScopeMetadataJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeMetadataJson {
    pub name: String,
    pub column: String,
    pub source: ScopeSource,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMetadataJson {
    pub name: String,
    pub type_family: String,
    #[serde(default)]
    pub notnull_required: bool,
    #[serde(default)]
    pub primary_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtYjsFieldMetadataJson {
    pub field: String,
    pub state_column: String,
    pub container_key: String,
    pub row_id_field: String,
    pub kind: String,
    pub sync_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFieldMetadataJson {
    pub field: String,
    pub scope: String,
    pub row_id_field: String,
}

pub fn app_schema_from_json(schema_json: &str) -> crate::error::Result<AppSchema> {
    let schema: AppSchemaJson = serde_json::from_str(schema_json)?;
    Ok(app_schema_from_config(schema))
}

pub fn app_schema_from_config(schema: AppSchemaJson) -> AppSchema {
    let migrations = leak_static_slice(
        schema
            .migrations
            .into_iter()
            .map(leak_embedded_migration)
            .collect(),
    );
    let app_tables = leak_static_slice(
        schema
            .tables
            .iter()
            .map(|table| leak_static_str(table.name.clone()))
            .collect(),
    );
    let app_table_metadata = leak_static_slice(
        schema
            .tables
            .into_iter()
            .map(leak_app_table_metadata)
            .collect(),
    );

    AppSchema {
        app_tables,
        app_table_metadata,
        migrations,
        schema_version: Some(schema.schema_version),
        default_subscriptions: empty_default_subscriptions,
        #[cfg(feature = "native")]
        adapter_for: unknown_table_adapter,
    }
}

pub fn empty_default_subscriptions(_: &SyncularClientConfig) -> Vec<SubscriptionSpec> {
    Vec::new()
}

pub fn empty_app_schema(schema_version: i32) -> AppSchema {
    AppSchema {
        app_tables: &[],
        app_table_metadata: &[],
        migrations: &[],
        schema_version: Some(schema_version),
        default_subscriptions: empty_default_subscriptions,
        #[cfg(feature = "native")]
        adapter_for: unknown_table_adapter,
    }
}

fn leak_app_table_metadata(table: AppTableMetadataJson) -> AppTableMetadata {
    AppTableMetadata {
        name: leak_static_str(table.name),
        primary_key_column: leak_static_str(table.primary_key_column),
        server_version_column: leak_static_str(table.server_version_column),
        soft_delete_column: table.soft_delete_column.map(leak_static_str),
        subscription_id: leak_static_str(table.subscription_id),
        columns: leak_static_slice(
            table
                .columns
                .into_iter()
                .map(leak_column_metadata)
                .collect(),
        ),
        blob_columns: leak_static_slice(
            table
                .blob_columns
                .into_iter()
                .map(leak_static_str)
                .collect(),
        ),
        crdt_yjs_fields: leak_static_slice(
            table
                .crdt_yjs_fields
                .into_iter()
                .map(leak_crdt_yjs_field_metadata)
                .collect(),
        ),
        encrypted_fields: leak_static_slice(
            table
                .encrypted_fields
                .into_iter()
                .map(leak_encrypted_field_metadata)
                .collect(),
        ),
        scopes: leak_static_slice(table.scopes.into_iter().map(leak_scope_metadata).collect()),
    }
}

fn leak_embedded_migration(migration: EmbeddedMigrationJson) -> EmbeddedMigration {
    EmbeddedMigration {
        version: leak_static_str(migration.version),
        schema_version: migration.schema_version,
        name: leak_static_str(migration.name),
        up_sql: leak_static_str(migration.up_sql),
    }
}

fn leak_scope_metadata(scope: ScopeMetadataJson) -> ScopeMetadata {
    ScopeMetadata {
        name: leak_static_str(scope.name),
        column: leak_static_str(scope.column),
        source: scope.source,
        required: scope.required,
    }
}

fn leak_column_metadata(column: ColumnMetadataJson) -> ColumnMetadata {
    ColumnMetadata {
        name: leak_static_str(column.name),
        type_family: leak_static_str(column.type_family),
        notnull_required: column.notnull_required,
        primary_key: column.primary_key,
    }
}

fn leak_crdt_yjs_field_metadata(field: CrdtYjsFieldMetadataJson) -> CrdtYjsFieldMetadata {
    CrdtYjsFieldMetadata {
        field: leak_static_str(field.field),
        state_column: leak_static_str(field.state_column),
        container_key: leak_static_str(field.container_key),
        row_id_field: leak_static_str(field.row_id_field),
        kind: leak_static_str(field.kind),
        sync_mode: leak_static_str(field.sync_mode),
    }
}

fn leak_encrypted_field_metadata(field: EncryptedFieldMetadataJson) -> EncryptedFieldMetadata {
    EncryptedFieldMetadata {
        field: leak_static_str(field.field),
        scope: leak_static_str(field.scope),
        row_id_field: leak_static_str(field.row_id_field),
    }
}

fn leak_static_str(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

fn leak_static_slice<T>(value: Vec<T>) -> &'static [T] {
    Box::leak(value.into_boxed_slice())
}

pub fn current_schema_version(migrations: &[EmbeddedMigration]) -> i32 {
    migrations
        .last()
        .map(|migration| migration.schema_version)
        .unwrap_or(1)
}

pub fn split_sql_statements(sql: &str) -> impl Iterator<Item = String> + '_ {
    sql.split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(|statement| format!("{statement};"))
}

pub fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    hex::encode(digest)
}

#[cfg(feature = "native")]
pub fn default_app_schema() -> AppSchema {
    empty_app_schema(crate::runtime_schema::runtime_schema_version())
}

#[cfg(not(feature = "native"))]
pub fn default_app_schema() -> AppSchema {
    empty_app_schema(crate::runtime_schema::runtime_schema_version())
}

#[cfg(feature = "native")]
pub fn unknown_table_adapter(table: &str) -> Result<&'static dyn DieselTableAdapter> {
    Err(SyncularError::message(
        ErrorKind::Config,
        format!("no Diesel table adapter registered for {table}"),
    ))
}

#[cfg(test)]
mod runtime_feature_tests {
    use super::*;

    const CRDT_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
        field: "title",
        state_column: "title_yjs_state",
        container_key: "title",
        row_id_field: "id",
        kind: "text",
        sync_mode: "server-merge",
    }];
    const ENCRYPTED_CRDT_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
        field: "body",
        state_column: "body_yjs_state",
        container_key: "body",
        row_id_field: "id",
        kind: "text",
        sync_mode: "encrypted-update-log",
    }];
    const ENCRYPTED_FIELDS: &[EncryptedFieldMetadata] = &[EncryptedFieldMetadata {
        field: "secret",
        scope: "tasks",
        row_id_field: "id",
    }];
    const TABLES: &[&str] = &["tasks"];
    const EMPTY_COLUMNS: &[ColumnMetadata] = &[];
    const EMPTY_SCOPES: &[ScopeMetadata] = &[];
    const EMPTY_BLOBS: &[&str] = &[];
    const BLOB_COLUMNS: &[&str] = &["image"];
    const EMPTY_CRDT_FIELDS: &[CrdtYjsFieldMetadata] = &[];
    const EMPTY_ENCRYPTED_FIELDS: &[EncryptedFieldMetadata] = &[];

    const PLAIN_TABLE_METADATA: AppTableMetadata =
        table_metadata(EMPTY_BLOBS, EMPTY_CRDT_FIELDS, EMPTY_ENCRYPTED_FIELDS);
    const BLOB_TABLE_METADATA: AppTableMetadata =
        table_metadata(BLOB_COLUMNS, EMPTY_CRDT_FIELDS, EMPTY_ENCRYPTED_FIELDS);
    const CRDT_TABLE_METADATA: AppTableMetadata =
        table_metadata(EMPTY_BLOBS, CRDT_FIELDS, EMPTY_ENCRYPTED_FIELDS);
    const ENCRYPTED_FIELD_TABLE_METADATA: AppTableMetadata =
        table_metadata(EMPTY_BLOBS, EMPTY_CRDT_FIELDS, ENCRYPTED_FIELDS);
    const ENCRYPTED_CRDT_TABLE_METADATA: AppTableMetadata =
        table_metadata(EMPTY_BLOBS, ENCRYPTED_CRDT_FIELDS, EMPTY_ENCRYPTED_FIELDS);
    const PLAIN_SCHEMA_TABLES: &[AppTableMetadata] = &[PLAIN_TABLE_METADATA];
    const BLOB_SCHEMA_TABLES: &[AppTableMetadata] = &[BLOB_TABLE_METADATA];
    const CRDT_SCHEMA_TABLES: &[AppTableMetadata] = &[CRDT_TABLE_METADATA];
    const ENCRYPTED_FIELD_SCHEMA_TABLES: &[AppTableMetadata] = &[ENCRYPTED_FIELD_TABLE_METADATA];
    const ENCRYPTED_CRDT_SCHEMA_TABLES: &[AppTableMetadata] = &[ENCRYPTED_CRDT_TABLE_METADATA];

    const fn table_metadata(
        blob_columns: &'static [&'static str],
        crdt_yjs_fields: &'static [CrdtYjsFieldMetadata],
        encrypted_fields: &'static [EncryptedFieldMetadata],
    ) -> AppTableMetadata {
        AppTableMetadata {
            name: "tasks",
            primary_key_column: "id",
            server_version_column: "server_version",
            soft_delete_column: None,
            subscription_id: "sub-tasks",
            columns: EMPTY_COLUMNS,
            blob_columns,
            crdt_yjs_fields,
            encrypted_fields,
            scopes: EMPTY_SCOPES,
        }
    }

    fn schema(metadata: &'static [AppTableMetadata]) -> AppSchema {
        AppSchema {
            app_tables: TABLES,
            app_table_metadata: metadata,
            migrations: &[],
            schema_version: Some(1),
            default_subscriptions: empty_default_subscriptions,
            #[cfg(feature = "native")]
            adapter_for: unknown_table_adapter,
        }
    }

    #[test]
    fn plain_schema_needs_no_optional_features() {
        assert!(validate_app_schema_runtime_features(&schema(PLAIN_SCHEMA_TABLES)).is_ok());
    }

    #[test]
    fn blob_schema_matches_blobs_feature() {
        let result = validate_app_schema_runtime_features(&schema(BLOB_SCHEMA_TABLES));
        if cfg!(any(feature = "native", feature = "web-blobs")) {
            assert!(result.is_ok());
        } else {
            assert!(result
                .expect_err("blob schema should require blobs")
                .message_text()
                .contains("blobs"));
        }
    }

    #[test]
    fn crdt_schema_matches_crdt_yjs_feature() {
        let result = validate_app_schema_runtime_features(&schema(CRDT_SCHEMA_TABLES));
        if cfg!(feature = "crdt-yjs") {
            assert!(result.is_ok());
        } else {
            assert!(result
                .expect_err("CRDT schema should require crdt-yjs")
                .message_text()
                .contains("crdt-yjs"));
        }
    }

    #[test]
    fn encrypted_schema_matches_e2ee_feature() {
        let result = validate_app_schema_runtime_features(&schema(ENCRYPTED_FIELD_SCHEMA_TABLES));
        if cfg!(feature = "e2ee") {
            assert!(result.is_ok());
        } else {
            assert!(result
                .expect_err("encrypted schema should require e2ee")
                .message_text()
                .contains("e2ee"));
        }
    }

    #[test]
    fn encrypted_crdt_schema_matches_crdt_and_e2ee_features() {
        let result = validate_app_schema_runtime_features(&schema(ENCRYPTED_CRDT_SCHEMA_TABLES));
        if cfg!(feature = "crdt-yjs") && cfg!(feature = "e2ee") {
            assert!(result.is_ok());
        } else {
            let message = result
                .expect_err("encrypted CRDT schema should require optional features")
                .message_text();
            assert!(message.contains("crdt-yjs") || message.contains("e2ee"));
        }
    }
}
