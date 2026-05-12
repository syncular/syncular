use crate::client::{SubscriptionSpec, SyncularClientConfig};
#[cfg(feature = "native")]
use crate::error::Result;
#[cfg(feature = "native")]
use crate::error::{ErrorKind, SyncularError};
#[cfg(feature = "native")]
use crate::protocol::{ScopeValues, SyncChange};
#[cfg(feature = "native")]
use diesel::sqlite::SqliteConnection;
use serde::Serialize;
#[cfg(feature = "native")]
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
    fn apply_change(&self, conn: &mut SqliteConnection, change: &SyncChange) -> Result<()>;
}

#[derive(Clone, Copy)]
pub struct AppSchema {
    pub app_tables: &'static [&'static str],
    pub app_table_metadata: &'static [AppTableMetadata],
    pub migrations: &'static [EmbeddedMigration],
    pub default_subscriptions: fn(&SyncularClientConfig) -> Vec<SubscriptionSpec>,
    #[cfg(feature = "native")]
    pub adapter_for: fn(&str) -> Result<&'static dyn DieselTableAdapter>,
}

impl AppSchema {
    pub fn current_schema_version(&self) -> i32 {
        current_schema_version(self.migrations)
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
    AppSchema {
        app_tables: crate::generated::APP_TABLES,
        app_table_metadata: crate::generated::APP_TABLE_METADATA,
        migrations: crate::migrations::MIGRATIONS,
        default_subscriptions: crate::generated::default_subscriptions,
        adapter_for: crate::diesel_tables::adapter_for,
    }
}

#[cfg(not(feature = "native"))]
pub fn default_app_schema() -> AppSchema {
    AppSchema {
        app_tables: crate::generated::APP_TABLES,
        app_table_metadata: crate::generated::APP_TABLE_METADATA,
        migrations: crate::migrations::MIGRATIONS,
        default_subscriptions: crate::generated::default_subscriptions,
    }
}

#[cfg(feature = "native")]
pub fn unknown_table_adapter(table: &str) -> Result<&'static dyn DieselTableAdapter> {
    Err(SyncularError::message(
        ErrorKind::Config,
        format!("no Diesel table adapter registered for {table}"),
    ))
}
