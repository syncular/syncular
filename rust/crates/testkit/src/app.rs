use syncular_runtime::app_schema::AppSchema;
use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::error::Result;
use syncular_runtime::transport::SyncTransport;

use crate::app_server::AppTestServer;
use crate::temp::TempDbPath;
use crate::transport::TestTransport;

#[derive(Debug, Clone)]
pub struct AppFixtureOptions {
    pub db_prefix: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
}

impl Default for AppFixtureOptions {
    fn default() -> Self {
        Self {
            db_prefix: "syncular-app-test".to_string(),
            base_url: "http://syncular.test/sync".to_string(),
            client_id: "test-client".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("p0".to_string()),
        }
    }
}

pub struct AppFixture<T> {
    db: TempDbPath,
    pub client: SyncularClient<DieselSqliteStore, T>,
}

pub struct TestAppFixture {
    db: TempDbPath,
    pub client: SyncularClient<DieselSqliteStore, TestTransport>,
    pub transport: TestTransport,
}

pub struct InMemoryAppFixture<T> {
    pub client: SyncularClient<DieselSqliteStore, T>,
}

pub struct InMemoryTestAppFixture {
    pub client: SyncularClient<DieselSqliteStore, TestTransport>,
    pub transport: TestTransport,
}

impl<T> AppFixture<T> {
    pub fn db_path(&self) -> String {
        self.db.to_string_lossy()
    }
}

impl TestAppFixture {
    pub fn db_path(&self) -> String {
        self.db.to_string_lossy()
    }
}

pub fn open_app_client(app_schema: AppSchema) -> Result<TestAppFixture> {
    open_app_client_with_options(app_schema, AppFixtureOptions::default())
}

pub fn open_app_client_in_memory(app_schema: AppSchema) -> Result<InMemoryTestAppFixture> {
    let transport = TestTransport::new();
    let store = DieselSqliteStore::open_with_schema(":memory:", app_schema)?;
    let config = fixture_config(":memory:".to_string(), AppFixtureOptions::default());
    let client =
        SyncularClient::with_app_schema_parts(config, store, transport.clone(), app_schema);
    Ok(InMemoryTestAppFixture { client, transport })
}

pub fn open_app_client_with_options(
    app_schema: AppSchema,
    options: AppFixtureOptions,
) -> Result<TestAppFixture> {
    let transport = TestTransport::new();
    let db = TempDbPath::new(&options.db_prefix);
    let db_path = db.to_string_lossy();
    let store = DieselSqliteStore::open_with_schema(&db_path, app_schema)?;
    let config = fixture_config(db_path, options);
    let client =
        SyncularClient::with_app_schema_parts(config, store, transport.clone(), app_schema);
    Ok(TestAppFixture {
        db,
        client,
        transport,
    })
}

pub fn open_app_client_with_transport<T>(
    app_schema: AppSchema,
    transport: T,
    options: AppFixtureOptions,
) -> Result<AppFixture<T>>
where
    T: SyncTransport,
{
    let db = TempDbPath::new(&options.db_prefix);
    let db_path = db.to_string_lossy();
    let store = DieselSqliteStore::open_with_schema(&db_path, app_schema)?;
    let config = fixture_config(db_path, options);
    let client = SyncularClient::with_app_schema_parts(config, store, transport, app_schema);
    Ok(AppFixture { db, client })
}

pub fn open_app_client_with_server(
    app_schema: AppSchema,
    server: AppTestServer,
    options: AppFixtureOptions,
) -> Result<AppFixture<AppTestServer>> {
    open_app_client_with_transport(app_schema, server, options)
}

pub fn open_app_client_with_server_in_memory(
    app_schema: AppSchema,
    server: AppTestServer,
    options: AppFixtureOptions,
) -> Result<InMemoryAppFixture<AppTestServer>> {
    open_app_client_with_transport_in_memory(app_schema, server, options)
}

pub fn open_app_client_with_transport_in_memory<T>(
    app_schema: AppSchema,
    transport: T,
    options: AppFixtureOptions,
) -> Result<InMemoryAppFixture<T>>
where
    T: SyncTransport,
{
    let db_path = ":memory:".to_string();
    let store = DieselSqliteStore::open_with_schema(&db_path, app_schema)?;
    let config = fixture_config(db_path, options);
    let client = SyncularClient::with_app_schema_parts(config, store, transport, app_schema);
    Ok(InMemoryAppFixture { client })
}

fn fixture_config(db_path: String, options: AppFixtureOptions) -> SyncularClientConfig {
    SyncularClientConfig {
        db_path,
        base_url: options.base_url,
        client_id: options.client_id,
        actor_id: options.actor_id,
        project_id: options.project_id,
    }
}
