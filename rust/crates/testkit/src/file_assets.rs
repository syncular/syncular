use serde_json::{json, Map, Value};
use syncular_runtime::app_schema::{
    unknown_table_adapter, AppSchema, AppTableMetadata, ColumnMetadata, EmbeddedMigration,
    ScopeMetadata, ScopeSource,
};
use syncular_runtime::client::{SubscriptionSpec, SyncularClientConfig};
use syncular_runtime::error::Result;
use syncular_runtime::protocol::{
    BlobRef, IntoSyncularMutation, PendingSyncularMutation, SyncularMutationKind,
};
use syncular_runtime::transport::SyncTransport;

use crate::app::{
    open_app_client_with_options, open_app_client_with_server, open_app_client_with_transport,
    AppFixture, AppFixtureOptions, TestAppFixture,
};
use crate::app_server::AppTestServer;

pub const FILES_TABLE: &str = "files";
pub const FILE_VERSIONS_TABLE: &str = "file_versions";
pub const FILES_SUBSCRIPTION_ID: &str = "sub-files";
pub const FILE_VERSIONS_SUBSCRIPTION_ID: &str = "sub-file-versions";

const FILE_ASSET_MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  parent_id TEXT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  current_version_id TEXT NULL,
  owner_id TEXT NOT NULL,
  project_id TEXT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  trashed_at BIGINT NULL,
  server_version BIGINT NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  blob_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  mime_type TEXT NULL,
  actor_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  project_id TEXT NULL,
  previous_version_id TEXT NULL,
  created_at BIGINT NOT NULL,
  server_version BIGINT NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_files_scope_parent_name
  ON files (owner_id, project_id, parent_id, name);

CREATE INDEX IF NOT EXISTS idx_file_versions_file_created
  ON file_versions (file_id, created_at);
"#;

const FILE_ASSET_MIGRATIONS: &[EmbeddedMigration] = &[EmbeddedMigration {
    version: "0001",
    schema_version: 1,
    name: "file_asset_reference_schema",
    up_sql: FILE_ASSET_MIGRATION_SQL,
}];

const FILE_ASSET_TABLES: &[&str] = &[FILES_TABLE, FILE_VERSIONS_TABLE];

const FILES_COLUMNS: &[ColumnMetadata] = &[
    ColumnMetadata {
        name: "id",
        type_family: "text",
        notnull_required: false,
        primary_key: true,
    },
    ColumnMetadata {
        name: "parent_id",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "name",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "kind",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "current_version_id",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "owner_id",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "project_id",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "deleted",
        type_family: "integer",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "trashed_at",
        type_family: "integer",
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

const FILE_VERSIONS_COLUMNS: &[ColumnMetadata] = &[
    ColumnMetadata {
        name: "id",
        type_family: "text",
        notnull_required: false,
        primary_key: true,
    },
    ColumnMetadata {
        name: "file_id",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "blob_ref",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "content_hash",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "byte_size",
        type_family: "integer",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "mime_type",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "actor_id",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "owner_id",
        type_family: "text",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "project_id",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "previous_version_id",
        type_family: "text",
        notnull_required: false,
        primary_key: false,
    },
    ColumnMetadata {
        name: "created_at",
        type_family: "integer",
        notnull_required: true,
        primary_key: false,
    },
    ColumnMetadata {
        name: "server_version",
        type_family: "integer",
        notnull_required: true,
        primary_key: false,
    },
];

const FILE_ASSET_SCOPES: &[ScopeMetadata] = &[
    ScopeMetadata {
        name: "user_id",
        column: "owner_id",
        source: ScopeSource::ActorId,
        required: true,
    },
    ScopeMetadata {
        name: "project_id",
        column: "project_id",
        source: ScopeSource::ProjectId,
        required: false,
    },
];

const FILES_METADATA: AppTableMetadata = AppTableMetadata {
    name: FILES_TABLE,
    primary_key_column: "id",
    server_version_column: "server_version",
    soft_delete_column: Some("deleted"),
    subscription_id: FILES_SUBSCRIPTION_ID,
    columns: FILES_COLUMNS,
    blob_columns: &[],
    crdt_yjs_fields: &[],
    encrypted_fields: &[],
    scopes: FILE_ASSET_SCOPES,
};

const FILE_VERSIONS_METADATA: AppTableMetadata = AppTableMetadata {
    name: FILE_VERSIONS_TABLE,
    primary_key_column: "id",
    server_version_column: "server_version",
    soft_delete_column: None,
    subscription_id: FILE_VERSIONS_SUBSCRIPTION_ID,
    columns: FILE_VERSIONS_COLUMNS,
    blob_columns: &["blob_ref"],
    crdt_yjs_fields: &[],
    encrypted_fields: &[],
    scopes: FILE_ASSET_SCOPES,
};

const FILE_ASSET_METADATA: &[AppTableMetadata] = &[FILES_METADATA, FILE_VERSIONS_METADATA];

pub type FileAssetFixture<T> = AppFixture<T>;
pub type TestFileAssetFixture = TestAppFixture;

pub fn file_asset_app_schema() -> AppSchema {
    AppSchema {
        app_tables: FILE_ASSET_TABLES,
        app_table_metadata: FILE_ASSET_METADATA,
        migrations: FILE_ASSET_MIGRATIONS,
        schema_version: Some(1),
        default_subscriptions: default_file_asset_subscriptions,
        adapter_for: unknown_table_adapter,
    }
}

pub fn open_file_asset_client() -> Result<TestFileAssetFixture> {
    open_file_asset_client_with_options(AppFixtureOptions {
        db_prefix: "syncular-file-assets-test".to_string(),
        ..AppFixtureOptions::default()
    })
}

pub fn open_file_asset_client_with_options(
    options: AppFixtureOptions,
) -> Result<TestFileAssetFixture> {
    open_app_client_with_options(file_asset_app_schema(), file_asset_fixture_options(options))
}

pub fn open_file_asset_client_with_transport<T>(
    transport: T,
    options: AppFixtureOptions,
) -> Result<FileAssetFixture<T>>
where
    T: SyncTransport,
{
    open_app_client_with_transport(
        file_asset_app_schema(),
        transport,
        file_asset_fixture_options(options),
    )
}

pub fn open_file_asset_client_with_server(
    server: AppTestServer,
    options: AppFixtureOptions,
) -> Result<FileAssetFixture<AppTestServer>> {
    open_app_client_with_server(
        file_asset_app_schema(),
        server,
        file_asset_fixture_options(options),
    )
}

fn file_asset_fixture_options(mut options: AppFixtureOptions) -> AppFixtureOptions {
    if options.db_prefix == AppFixtureOptions::default().db_prefix {
        options.db_prefix = "syncular-file-assets-test".to_string();
    }
    options
}

fn default_file_asset_subscriptions(config: &SyncularClientConfig) -> Vec<SubscriptionSpec> {
    let mut scopes = Map::new();
    scopes.insert(
        "user_id".to_string(),
        Value::String(config.actor_id.clone()),
    );
    if let Some(project_id) = &config.project_id {
        scopes.insert("project_id".to_string(), Value::String(project_id.clone()));
    }
    vec![
        SubscriptionSpec {
            id: FILES_SUBSCRIPTION_ID.to_string(),
            table: FILES_TABLE.to_string(),
            scopes: scopes.clone(),
            params: Map::new(),
            bootstrap_phase: 0,
        },
        SubscriptionSpec {
            id: FILE_VERSIONS_SUBSCRIPTION_ID.to_string(),
            table: FILE_VERSIONS_TABLE.to_string(),
            scopes,
            params: Map::new(),
            bootstrap_phase: 0,
        },
    ]
}

#[derive(Debug, Clone)]
pub struct NewFileAsset {
    id: String,
    parent_id: Option<String>,
    name: String,
    kind: String,
    current_version_id: Option<String>,
    owner_id: String,
    project_id: Option<String>,
}

impl NewFileAsset {
    pub fn file(id: &str, name: &str, owner_id: &str, project_id: Option<&str>) -> Self {
        Self::new(id, name, "file", owner_id, project_id)
    }

    pub fn folder(id: &str, name: &str, owner_id: &str, project_id: Option<&str>) -> Self {
        Self::new(id, name, "folder", owner_id, project_id)
    }

    fn new(id: &str, name: &str, kind: &str, owner_id: &str, project_id: Option<&str>) -> Self {
        Self {
            id: id.to_string(),
            parent_id: None,
            name: name.to_string(),
            kind: kind.to_string(),
            current_version_id: None,
            owner_id: owner_id.to_string(),
            project_id: project_id.map(str::to_string),
        }
    }

    pub fn parent_id(mut self, parent_id: Option<&str>) -> Self {
        self.parent_id = parent_id.map(str::to_string);
        self
    }

    pub fn current_version_id(mut self, version_id: Option<&str>) -> Self {
        self.current_version_id = version_id.map(str::to_string);
        self
    }

    pub fn row_json(&self) -> Value {
        let mut row = Map::new();
        row.insert("id".to_string(), json!(&self.id));
        row.insert("parent_id".to_string(), json!(&self.parent_id));
        row.insert("name".to_string(), json!(&self.name));
        row.insert("kind".to_string(), json!(&self.kind));
        row.insert(
            "current_version_id".to_string(),
            json!(&self.current_version_id),
        );
        row.insert("owner_id".to_string(), json!(&self.owner_id));
        row.insert("project_id".to_string(), json!(&self.project_id));
        row.insert("deleted".to_string(), json!(0));
        row.insert("trashed_at".to_string(), Value::Null);
        Value::Object(row)
    }

    fn payload_json(&self) -> Value {
        self.row_json()
    }
}

impl IntoSyncularMutation for NewFileAsset {
    fn into_syncular_mutation(self) -> PendingSyncularMutation {
        PendingSyncularMutation {
            kind: SyncularMutationKind::Insert,
            table: FILES_TABLE.to_string(),
            row_id: self.id.clone(),
            payload: Some(self.payload_json()),
            base_version: None,
            local_row: Some(self.row_json()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileAssetPatch {
    row_id: String,
    base_version: Option<i64>,
    parent_id: Option<Option<String>>,
    name: Option<String>,
    current_version_id: Option<Option<String>>,
    deleted: Option<i32>,
    trashed_at: Option<Option<i64>>,
}

impl FileAssetPatch {
    pub fn new(row_id: &str) -> Self {
        Self {
            row_id: row_id.to_string(),
            base_version: None,
            parent_id: None,
            name: None,
            current_version_id: None,
            deleted: None,
            trashed_at: None,
        }
    }

    pub fn base_version(mut self, base_version: i64) -> Self {
        self.base_version = Some(base_version);
        self
    }

    pub fn rename(mut self, name: &str) -> Self {
        self.name = Some(name.to_string());
        self
    }

    pub fn move_to(mut self, parent_id: Option<&str>) -> Self {
        self.parent_id = Some(parent_id.map(str::to_string));
        self
    }

    pub fn current_version_id(mut self, version_id: Option<&str>) -> Self {
        self.current_version_id = Some(version_id.map(str::to_string));
        self
    }

    pub fn soft_delete(mut self, trashed_at: i64) -> Self {
        self.deleted = Some(1);
        self.trashed_at = Some(Some(trashed_at));
        self
    }

    pub fn restore(mut self) -> Self {
        self.deleted = Some(0);
        self.trashed_at = Some(None);
        self
    }

    pub fn payload_json(&self) -> Value {
        let mut payload = Map::new();
        if let Some(parent_id) = &self.parent_id {
            payload.insert("parent_id".to_string(), json!(parent_id));
        }
        if let Some(name) = &self.name {
            payload.insert("name".to_string(), json!(name));
        }
        if let Some(version_id) = &self.current_version_id {
            payload.insert("current_version_id".to_string(), json!(version_id));
        }
        if let Some(deleted) = self.deleted {
            payload.insert("deleted".to_string(), json!(deleted));
        }
        if let Some(trashed_at) = self.trashed_at {
            payload.insert("trashed_at".to_string(), json!(trashed_at));
        }
        Value::Object(payload)
    }
}

impl IntoSyncularMutation for FileAssetPatch {
    fn into_syncular_mutation(self) -> PendingSyncularMutation {
        let payload = self.payload_json();
        PendingSyncularMutation {
            kind: SyncularMutationKind::Update,
            table: FILES_TABLE.to_string(),
            row_id: self.row_id,
            payload: Some(payload),
            base_version: self.base_version,
            local_row: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewFileVersion {
    id: String,
    file_id: String,
    blob_ref: BlobRef,
    actor_id: String,
    owner_id: String,
    project_id: Option<String>,
    previous_version_id: Option<String>,
    created_at: i64,
}

impl NewFileVersion {
    pub fn new(
        id: &str,
        file_id: &str,
        blob_ref: BlobRef,
        actor_id: &str,
        owner_id: &str,
        project_id: Option<&str>,
        created_at: i64,
    ) -> Self {
        Self {
            id: id.to_string(),
            file_id: file_id.to_string(),
            blob_ref,
            actor_id: actor_id.to_string(),
            owner_id: owner_id.to_string(),
            project_id: project_id.map(str::to_string),
            previous_version_id: None,
            created_at,
        }
    }

    pub fn previous_version_id(mut self, version_id: Option<&str>) -> Self {
        self.previous_version_id = version_id.map(str::to_string);
        self
    }

    pub fn row_json(&self) -> Value {
        let mut row = Map::new();
        row.insert("id".to_string(), json!(&self.id));
        row.insert("file_id".to_string(), json!(&self.file_id));
        row.insert("blob_ref".to_string(), json!(&self.blob_ref));
        row.insert("content_hash".to_string(), json!(&self.blob_ref.hash));
        row.insert("byte_size".to_string(), json!(self.blob_ref.size));
        row.insert("mime_type".to_string(), json!(&self.blob_ref.mime_type));
        row.insert("actor_id".to_string(), json!(&self.actor_id));
        row.insert("owner_id".to_string(), json!(&self.owner_id));
        row.insert("project_id".to_string(), json!(&self.project_id));
        row.insert(
            "previous_version_id".to_string(),
            json!(&self.previous_version_id),
        );
        row.insert("created_at".to_string(), json!(self.created_at));
        Value::Object(row)
    }

    fn payload_json(&self) -> Value {
        self.row_json()
    }
}

impl IntoSyncularMutation for NewFileVersion {
    fn into_syncular_mutation(self) -> PendingSyncularMutation {
        PendingSyncularMutation {
            kind: SyncularMutationKind::Insert,
            table: FILE_VERSIONS_TABLE.to_string(),
            row_id: self.id.clone(),
            payload: Some(self.payload_json()),
            base_version: None,
            local_row: Some(self.row_json()),
        }
    }
}
