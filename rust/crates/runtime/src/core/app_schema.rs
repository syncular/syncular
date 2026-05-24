use crate::client::{SubscriptionSpec, SyncularClientConfig};
use crate::encryption::FieldEncryptionRule;
#[cfg(feature = "native")]
use crate::error::ErrorKind;
use crate::error::{Result, SyncularError};
use crate::protocol::{
    AuthLeaseIssueRequest, AuthLeaseIssueResponse, AuthLeasePayload, AuthLeaseScope,
    AUTH_LEASE_PROTOCOL_VERSION, AUTH_LEASE_VERSION,
};
#[cfg(feature = "native")]
use crate::protocol::{ScopeValues, SyncChange};
#[cfg(feature = "native")]
use diesel::sqlite::SqliteConnection;
use serde::{Deserialize, Serialize};
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

pub fn validate_field_encryption_rules_against_app_schema(
    app_schema: AppSchema,
    rules: &[FieldEncryptionRule],
) -> Result<()> {
    for rule in rules {
        let table_name = rule.table.as_deref().ok_or_else(|| {
            SyncularError::config(format!(
                "field encryption rule for scope {} must specify a generated table",
                rule.scope
            ))
        })?;
        let metadata = app_schema.table_metadata(table_name).ok_or_else(|| {
            SyncularError::config(format!(
                "field encryption rule references unknown generated table {table_name}"
            ))
        })?;
        let row_id_field = rule
            .row_id_field
            .as_deref()
            .unwrap_or(metadata.primary_key_column);
        if !metadata
            .columns
            .iter()
            .any(|column| column.name == row_id_field)
        {
            return Err(SyncularError::config(format!(
                "field encryption rule for {}.{} references unknown rowIdField {}",
                rule.scope, table_name, row_id_field
            )));
        }

        for field in &rule.fields {
            let declared = metadata.encrypted_fields.iter().any(|candidate| {
                candidate.field == field
                    && candidate.scope == rule.scope
                    && candidate.row_id_field == row_id_field
            });
            if !declared {
                return Err(SyncularError::config(format!(
                    "field encryption rule for {}.{} is not declared in the generated app schema",
                    table_name, field
                )));
            }
        }
    }

    Ok(())
}

pub fn validate_blob_encryption_against_app_schema(app_schema: AppSchema) -> Result<()> {
    if validate_blob_runtime_against_app_schema(app_schema).is_ok() {
        return Ok(());
    }

    Err(SyncularError::config(
        "blob encryption requires at least one generated blob column",
    ))
}

pub fn validate_blob_runtime_against_app_schema(app_schema: AppSchema) -> Result<()> {
    if app_schema
        .app_table_metadata
        .iter()
        .any(|table| !table.blob_columns.is_empty())
    {
        return Ok(());
    }

    Err(SyncularError::config(
        "blob operations require at least one generated blob column",
    ))
}

pub fn validate_encrypted_crdt_against_app_schema(app_schema: AppSchema) -> Result<()> {
    if app_schema.app_table_metadata.iter().any(|table| {
        table
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
    }) {
        return Ok(());
    }

    Err(SyncularError::config(
        "encrypted CRDT config requires at least one generated encrypted-update-log CRDT field",
    ))
}

pub fn validate_auth_lease_issue_request_against_app_schema(
    app_schema: AppSchema,
    request: &AuthLeaseIssueRequest,
) -> Result<()> {
    validate_auth_lease_schema_version(app_schema, request.schema_version, "auth lease request")?;
    if let Some(ttl_ms) = request.ttl_ms {
        if ttl_ms <= 0 {
            return Err(SyncularError::config(
                "auth lease request ttlMs must be positive",
            ));
        }
    }
    validate_auth_lease_scopes_against_app_schema(app_schema, &request.scopes, "auth lease request")
}

pub fn validate_auth_lease_issue_response_against_app_schema(
    app_schema: AppSchema,
    response: &AuthLeaseIssueResponse,
    request_schema_version: i32,
) -> Result<()> {
    if response.payload.schema_version != request_schema_version {
        return Err(SyncularError::protocol_message(format!(
            "auth lease response schemaVersion {} does not match request schemaVersion {}",
            response.payload.schema_version, request_schema_version
        )));
    }
    validate_auth_lease_payload_against_app_schema(app_schema, &response.payload)
}

pub fn validate_auth_lease_payload_against_app_schema(
    app_schema: AppSchema,
    payload: &AuthLeasePayload,
) -> Result<()> {
    if payload.version != AUTH_LEASE_VERSION {
        return Err(SyncularError::protocol_message(
            "auth lease payload version is unsupported",
        ));
    }
    if payload.protocol_version != AUTH_LEASE_PROTOCOL_VERSION {
        return Err(SyncularError::protocol_message(
            "auth lease payload protocolVersion is unsupported",
        ));
    }
    validate_auth_lease_schema_version(app_schema, payload.schema_version, "auth lease payload")?;
    validate_auth_lease_scopes_against_app_schema(app_schema, &payload.scopes, "auth lease payload")
}

fn validate_auth_lease_schema_version(
    app_schema: AppSchema,
    schema_version: i32,
    source: &str,
) -> Result<()> {
    let current = app_schema.current_schema_version();
    if schema_version == current {
        return Ok(());
    }
    Err(SyncularError::config(format!(
        "{source} schemaVersion {schema_version} does not match generated app schema version {current}"
    )))
}

fn validate_auth_lease_scopes_against_app_schema(
    app_schema: AppSchema,
    scopes: &[AuthLeaseScope],
    source: &str,
) -> Result<()> {
    if scopes.is_empty() {
        return Err(SyncularError::config(format!(
            "{source} must contain at least one generated table scope"
        )));
    }
    for scope in scopes {
        validate_auth_lease_scope_against_app_schema(app_schema, scope, source)?;
    }
    Ok(())
}

fn validate_auth_lease_scope_against_app_schema(
    app_schema: AppSchema,
    scope: &AuthLeaseScope,
    source: &str,
) -> Result<()> {
    if scope.subscription_id.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "{source} scope subscriptionId must not be empty"
        )));
    }
    let table = scope.table.trim();
    if table.is_empty() {
        return Err(SyncularError::config(format!(
            "{source} scope table must not be empty"
        )));
    }
    let metadata = app_schema.table_metadata(table).ok_or_else(|| {
        SyncularError::config(format!(
            "{source} scope references unknown generated table {table}"
        ))
    })?;
    if scope.operations.is_empty() {
        return Err(SyncularError::config(format!(
            "{source} scope for table {table} must include at least one operation"
        )));
    }
    for operation in &scope.operations {
        match operation.as_str() {
            "upsert" | "delete" => {}
            other => {
                return Err(SyncularError::config(format!(
                    "{source} scope for table {table} references unsupported operation {other}"
                )));
            }
        }
    }

    for scope_key in scope.values.keys() {
        if !metadata
            .scopes
            .iter()
            .any(|metadata_scope| metadata_scope.name == scope_key)
        {
            return Err(SyncularError::config(format!(
                "{source} scope for table {table} references unknown generated scope {scope_key}"
            )));
        }
    }
    for required_scope in metadata.scopes.iter().filter(|scope| scope.required) {
        if !scope.values.contains_key(required_scope.name) {
            return Err(SyncularError::config(format!(
                "{source} scope for table {table} is missing required generated scope {}",
                required_scope.name
            )));
        }
    }
    for (name, value) in &scope.values {
        validate_auth_lease_scope_value(source, table, name, value)?;
    }
    Ok(())
}

fn validate_auth_lease_scope_value(
    source: &str,
    table: &str,
    name: &str,
    value: &Value,
) -> Result<()> {
    match value {
        Value::String(value) if !value.is_empty() => Ok(()),
        Value::Array(values)
            if !values.is_empty()
                && values
                    .iter()
                    .all(|value| matches!(value, Value::String(value) if !value.is_empty())) =>
        {
            Ok(())
        }
        _ => Err(SyncularError::config(format!(
            "{source} scope {table}.{name} must be a non-empty string or non-empty string array"
        ))),
    }
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
    const TABLE_COLUMNS: &[ColumnMetadata] = &[
        ColumnMetadata {
            name: "id",
            type_family: "text",
            notnull_required: false,
            primary_key: true,
        },
        ColumnMetadata {
            name: "title",
            type_family: "text",
            notnull_required: true,
            primary_key: false,
        },
        ColumnMetadata {
            name: "title_yjs_state",
            type_family: "text",
            notnull_required: false,
            primary_key: false,
        },
        ColumnMetadata {
            name: "secret",
            type_family: "text",
            notnull_required: false,
            primary_key: false,
        },
        ColumnMetadata {
            name: "image",
            type_family: "text",
            notnull_required: false,
            primary_key: false,
        },
        ColumnMetadata {
            name: "server_version",
            type_family: "integer",
            notnull_required: true,
            primary_key: false,
        },
    ];
    const EMPTY_SCOPES: &[ScopeMetadata] = &[];
    const REQUIRED_SCOPES: &[ScopeMetadata] = &[ScopeMetadata {
        name: "user_id",
        column: "user_id",
        source: ScopeSource::ActorId,
        required: true,
    }];
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
    const SCOPED_TABLE_METADATA: AppTableMetadata = table_metadata_with_scopes(
        EMPTY_BLOBS,
        EMPTY_CRDT_FIELDS,
        EMPTY_ENCRYPTED_FIELDS,
        REQUIRED_SCOPES,
    );
    const PLAIN_SCHEMA_TABLES: &[AppTableMetadata] = &[PLAIN_TABLE_METADATA];
    const BLOB_SCHEMA_TABLES: &[AppTableMetadata] = &[BLOB_TABLE_METADATA];
    const CRDT_SCHEMA_TABLES: &[AppTableMetadata] = &[CRDT_TABLE_METADATA];
    const ENCRYPTED_FIELD_SCHEMA_TABLES: &[AppTableMetadata] = &[ENCRYPTED_FIELD_TABLE_METADATA];
    const ENCRYPTED_CRDT_SCHEMA_TABLES: &[AppTableMetadata] = &[ENCRYPTED_CRDT_TABLE_METADATA];
    const SCOPED_SCHEMA_TABLES: &[AppTableMetadata] = &[SCOPED_TABLE_METADATA];

    const fn table_metadata(
        blob_columns: &'static [&'static str],
        crdt_yjs_fields: &'static [CrdtYjsFieldMetadata],
        encrypted_fields: &'static [EncryptedFieldMetadata],
    ) -> AppTableMetadata {
        table_metadata_with_scopes(
            blob_columns,
            crdt_yjs_fields,
            encrypted_fields,
            EMPTY_SCOPES,
        )
    }

    const fn table_metadata_with_scopes(
        blob_columns: &'static [&'static str],
        crdt_yjs_fields: &'static [CrdtYjsFieldMetadata],
        encrypted_fields: &'static [EncryptedFieldMetadata],
        scopes: &'static [ScopeMetadata],
    ) -> AppTableMetadata {
        AppTableMetadata {
            name: "tasks",
            primary_key_column: "id",
            server_version_column: "server_version",
            soft_delete_column: None,
            subscription_id: "sub-tasks",
            columns: TABLE_COLUMNS,
            blob_columns,
            crdt_yjs_fields,
            encrypted_fields,
            scopes,
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

    #[test]
    fn field_encryption_rules_must_match_generated_metadata() {
        let valid = FieldEncryptionRule {
            scope: "tasks".to_string(),
            table: Some("tasks".to_string()),
            fields: vec!["secret".to_string()],
            row_id_field: Some("id".to_string()),
        };
        assert!(validate_field_encryption_rules_against_app_schema(
            schema(ENCRYPTED_FIELD_SCHEMA_TABLES),
            &[valid]
        )
        .is_ok());

        let unknown_field = FieldEncryptionRule {
            scope: "tasks".to_string(),
            table: Some("tasks".to_string()),
            fields: vec!["title".to_string()],
            row_id_field: Some("id".to_string()),
        };
        assert!(validate_field_encryption_rules_against_app_schema(
            schema(ENCRYPTED_FIELD_SCHEMA_TABLES),
            &[unknown_field]
        )
        .expect_err("runtime-only encryption fields should fail")
        .message_text()
        .contains("not declared"));

        let wildcard_table = FieldEncryptionRule {
            scope: "tasks".to_string(),
            table: None,
            fields: vec!["secret".to_string()],
            row_id_field: Some("id".to_string()),
        };
        assert!(validate_field_encryption_rules_against_app_schema(
            schema(ENCRYPTED_FIELD_SCHEMA_TABLES),
            &[wildcard_table]
        )
        .expect_err("field encryption rules must be table-specific")
        .message_text()
        .contains("must specify"));
    }

    #[test]
    fn blob_encryption_requires_generated_blob_column() {
        assert!(validate_blob_encryption_against_app_schema(schema(BLOB_SCHEMA_TABLES)).is_ok());
        assert!(
            validate_blob_encryption_against_app_schema(schema(PLAIN_SCHEMA_TABLES))
                .expect_err("blob encryption without blob fields should fail")
                .message_text()
                .contains("blob column")
        );
    }

    #[test]
    fn encrypted_crdt_requires_generated_encrypted_crdt_field() {
        assert!(
            validate_encrypted_crdt_against_app_schema(schema(ENCRYPTED_CRDT_SCHEMA_TABLES))
                .is_ok()
        );
        assert!(
            validate_encrypted_crdt_against_app_schema(schema(CRDT_SCHEMA_TABLES))
                .expect_err("encrypted CRDT config without encrypted-update-log fields should fail")
                .message_text()
                .contains("encrypted-update-log")
        );
    }

    #[test]
    fn auth_lease_issue_request_must_match_generated_scope_metadata() {
        let valid = AuthLeaseIssueRequest {
            schema_version: 1,
            ttl_ms: Some(60_000),
            scopes: vec![AuthLeaseScope {
                subscription_id: "custom-sub-tasks".to_string(),
                table: "tasks".to_string(),
                values: serde_json::json!({ "user_id": ["user-rust"] })
                    .as_object()
                    .expect("scope object")
                    .clone(),
                operations: vec!["upsert".to_string(), "delete".to_string()],
            }],
        };
        assert!(validate_auth_lease_issue_request_against_app_schema(
            schema(SCOPED_SCHEMA_TABLES),
            &valid
        )
        .is_ok());

        let unknown_scope = AuthLeaseIssueRequest {
            schema_version: 1,
            ttl_ms: None,
            scopes: vec![AuthLeaseScope {
                subscription_id: "sub-tasks".to_string(),
                table: "tasks".to_string(),
                values: serde_json::json!({ "project_id": "p0" })
                    .as_object()
                    .expect("scope object")
                    .clone(),
                operations: vec!["upsert".to_string()],
            }],
        };
        assert!(validate_auth_lease_issue_request_against_app_schema(
            schema(SCOPED_SCHEMA_TABLES),
            &unknown_scope
        )
        .expect_err("unknown generated lease scopes should fail")
        .message_text()
        .contains("unknown generated scope project_id"));

        let missing_required_scope = AuthLeaseIssueRequest {
            schema_version: 1,
            ttl_ms: None,
            scopes: vec![AuthLeaseScope {
                subscription_id: "sub-tasks".to_string(),
                table: "tasks".to_string(),
                values: serde_json::Map::new(),
                operations: vec!["upsert".to_string()],
            }],
        };
        assert!(validate_auth_lease_issue_request_against_app_schema(
            schema(SCOPED_SCHEMA_TABLES),
            &missing_required_scope
        )
        .expect_err("missing generated lease scopes should fail")
        .message_text()
        .contains("missing required generated scope user_id"));
    }
}
