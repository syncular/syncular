use crate::app_schema::{AppSchema, AppTableMetadata, ColumnMetadata, CrdtYjsFieldMetadata};
use crate::crdt_yjs::{YjsFieldKind, YjsFieldRule};
use crate::encrypted_crdt::is_encrypted_update_log_field;
use crate::error::{Result, SyncularError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtFieldId {
    pub table: String,
    pub row_id: String,
    pub field: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CrdtFieldSyncMode {
    ServerMerge,
    EncryptedUpdateLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CrdtUpdateOrigin {
    Local,
    Remote,
    Compaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CrdtUpdateStatus {
    Pending,
    Flushed,
    Acked,
    Pruned,
}

#[derive(Debug, Clone)]
pub struct CrdtField {
    id: CrdtFieldId,
    metadata: &'static AppTableMetadata,
    field: &'static CrdtYjsFieldMetadata,
    sync_mode: CrdtFieldSyncMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtDocumentSnapshot {
    pub document_key: String,
    pub table: String,
    pub row_id: String,
    pub field: String,
    pub state_column: String,
    pub sync_mode: CrdtFieldSyncMode,
    pub state_base64: Option<String>,
    pub state_vector_base64: String,
    pub pending_updates: i64,
    pub flushed_updates: i64,
    pub acked_updates: i64,
    pub log_updates: i64,
    pub updated_at: i64,
    pub compacted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtUpdateLogEntry {
    pub id: i64,
    pub document_key: String,
    pub update_id: String,
    pub client_commit_id: Option<String>,
    pub origin: CrdtUpdateOrigin,
    pub status: CrdtUpdateStatus,
    pub update_base64: String,
    pub state_vector_base64: String,
    pub created_at: i64,
    pub flushed_at: Option<i64>,
    pub acked_at: Option<i64>,
}

impl CrdtFieldId {
    pub fn new(
        table: impl Into<String>,
        row_id: impl Into<String>,
        field: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            row_id: row_id.into(),
            field: field.into(),
        }
    }
}

impl CrdtField {
    pub fn id(&self) -> &CrdtFieldId {
        &self.id
    }

    pub fn table(&self) -> &'static str {
        self.metadata.name
    }

    pub fn row_id(&self) -> &str {
        &self.id.row_id
    }

    pub fn field(&self) -> &'static str {
        self.field.field
    }

    pub fn state_column(&self) -> &'static str {
        self.field.state_column
    }

    pub fn container_key(&self) -> &'static str {
        self.field.container_key
    }

    pub fn row_id_field(&self) -> &'static str {
        self.field.row_id_field
    }

    pub fn sync_mode(&self) -> CrdtFieldSyncMode {
        self.sync_mode
    }

    pub fn metadata(&self) -> &'static AppTableMetadata {
        self.metadata
    }

    pub fn field_metadata(&self) -> &'static CrdtYjsFieldMetadata {
        self.field
    }

    pub fn yjs_rule(&self) -> Result<YjsFieldRule> {
        Ok(YjsFieldRule {
            table: self.metadata.name.to_string(),
            field: self.field.field.to_string(),
            state_column: self.field.state_column.to_string(),
            container_key: Some(self.field.container_key.to_string()),
            row_id_field: Some(self.field.row_id_field.to_string()),
            kind: YjsFieldKind::from_metadata(self.field.kind)?,
        })
    }

    pub fn document_key(&self) -> String {
        crdt_document_key(self.table(), self.row_id(), self.field())
    }
}

pub fn crdt_document_key(table: &str, row_id: &str, field: &str) -> String {
    format!("{table}\u{1f}{row_id}\u{1f}{field}")
}

pub fn validate_crdt_field(app_schema: AppSchema, id: &CrdtFieldId) -> Result<CrdtField> {
    let metadata = app_schema
        .table_metadata(&id.table)
        .ok_or_else(|| SyncularError::config(format!("unknown app table: {}", id.table)))?;
    let field = metadata
        .crdt_yjs_fields
        .iter()
        .find(|field| field.field == id.field)
        .ok_or_else(|| {
            SyncularError::config(format!(
                "no CRDT Yjs field metadata for {}.{}",
                id.table, id.field
            ))
        })?;
    validate_crdt_field_metadata(metadata, field)?;
    Ok(CrdtField {
        id: id.clone(),
        metadata,
        field,
        sync_mode: sync_mode_from_metadata(field)?,
    })
}

fn validate_crdt_field_metadata(
    metadata: &AppTableMetadata,
    field: &CrdtYjsFieldMetadata,
) -> Result<()> {
    if metadata.name.trim().is_empty() {
        return Err(SyncularError::config(
            "CRDT field metadata cannot reference an empty table name",
        ));
    }
    let primary_key = metadata_column(metadata, metadata.primary_key_column, "primaryKeyColumn")?;
    if !primary_key.primary_key {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {} expects primary key column {} to be marked primary",
            metadata.name, metadata.primary_key_column
        )));
    }
    metadata_column(
        metadata,
        metadata.server_version_column,
        "serverVersionColumn",
    )?;
    if field.field.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {} has an empty field name",
            metadata.name
        )));
    }
    if field.state_column.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} has an empty state column",
            metadata.name, field.field
        )));
    }
    if field.container_key.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} has an empty container key",
            metadata.name, field.field
        )));
    }
    if field.row_id_field.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} has an empty row id field",
            metadata.name, field.field
        )));
    }
    YjsFieldKind::from_metadata(field.kind)?;
    sync_mode_from_metadata(field)?;
    let value_column = metadata_column(metadata, field.field, "CRDT field")?;
    if value_column.type_family != "text" {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} must use a text column, got {}",
            metadata.name, field.field, value_column.type_family
        )));
    }
    if value_column.primary_key {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} cannot use the primary key column",
            metadata.name, field.field
        )));
    }
    if field.field == metadata.server_version_column {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} cannot use the server version column",
            metadata.name, field.field
        )));
    }
    if metadata
        .soft_delete_column
        .is_some_and(|soft_delete_column| field.field == soft_delete_column)
    {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} cannot use the soft delete column",
            metadata.name, field.field
        )));
    }
    let state_column = metadata_column(metadata, field.state_column, "CRDT stateColumn")?;
    if state_column.type_family != "text" {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} state column {} must use a text column, got {}",
            metadata.name, field.field, field.state_column, state_column.type_family
        )));
    }
    if field.state_column == field.field {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} cannot use the same field and state column",
            metadata.name, field.field
        )));
    }
    if field.state_column == metadata.server_version_column {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} cannot use the server version column as state column",
            metadata.name, field.field
        )));
    }
    if field.row_id_field != metadata.primary_key_column {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} uses row id field {}, expected primary key {}",
            metadata.name, field.field, field.row_id_field, metadata.primary_key_column
        )));
    }
    metadata_column(metadata, field.row_id_field, "CRDT rowIdField")?;
    for scope in metadata.scopes {
        if scope.name.trim().is_empty() {
            return Err(SyncularError::config(format!(
                "CRDT field metadata for {}.{} has an empty scope name",
                metadata.name, field.field
            )));
        }
        metadata_column(metadata, scope.column, "scope column")?;
    }
    if let Some(encrypted_field) = metadata.encrypted_fields.iter().find(|encrypted_field| {
        encrypted_field.field == field.field || encrypted_field.field == field.state_column
    }) {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {}.{} conflicts with encrypted field {}; use encrypted-update-log CRDT fields instead of field-level encryption",
            metadata.name, field.field, encrypted_field.field
        )));
    }
    Ok(())
}

fn metadata_column<'a>(
    metadata: &'a AppTableMetadata,
    column: &str,
    role: &str,
) -> Result<&'a ColumnMetadata> {
    if column.trim().is_empty() {
        return Err(SyncularError::config(format!(
            "CRDT field metadata for {} has an empty {role}",
            metadata.name
        )));
    }
    metadata
        .columns
        .iter()
        .find(|candidate| candidate.name == column)
        .ok_or_else(|| {
            SyncularError::config(format!(
                "CRDT field metadata for {} references unknown {role} {}",
                metadata.name, column
            ))
        })
}

fn sync_mode_from_metadata(field: &CrdtYjsFieldMetadata) -> Result<CrdtFieldSyncMode> {
    match field.sync_mode {
        "" | "server-merge" => Ok(CrdtFieldSyncMode::ServerMerge),
        "encrypted-update-log" if is_encrypted_update_log_field(field) => {
            Ok(CrdtFieldSyncMode::EncryptedUpdateLog)
        }
        other => Err(SyncularError::config(format!(
            "unsupported CRDT field sync mode for {}: {other}",
            field.field
        ))),
    }
}
