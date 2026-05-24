use serde_json::{json, Value};
use syncular_runtime::error::Result;
use syncular_runtime::fixtures::todo;
use syncular_runtime::protocol::{
    CombinedResponse, PullResponse, SubscriptionResponse, SyncSnapshot,
};
use syncular_runtime::transport::SyncTransport;

use crate::app::{
    open_app_client_with_options, open_app_client_with_transport, AppFixture, AppFixtureOptions,
    TestAppFixture,
};

#[derive(Debug, Clone)]
pub struct TodoFixtureOptions {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
}

impl Default for TodoFixtureOptions {
    fn default() -> Self {
        Self {
            base_url: "http://syncular.test/sync".to_string(),
            client_id: "test-client".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("p0".to_string()),
        }
    }
}

pub type TodoFixture<T> = AppFixture<T>;
pub type TestTodoFixture = TestAppFixture;

pub fn open_todo_client() -> Result<TestTodoFixture> {
    open_todo_client_with_options(TodoFixtureOptions::default())
}

pub fn open_todo_client_with_options(options: TodoFixtureOptions) -> Result<TestTodoFixture> {
    open_app_client_with_options(todo::app_schema(), todo_app_fixture_options(options))
}

pub fn open_todo_client_with_transport<T>(
    transport: T,
    options: TodoFixtureOptions,
) -> Result<TodoFixture<T>>
where
    T: SyncTransport,
{
    open_app_client_with_transport(
        todo::app_schema(),
        transport,
        todo_app_fixture_options(options),
    )
}

fn todo_app_fixture_options(options: TodoFixtureOptions) -> AppFixtureOptions {
    AppFixtureOptions {
        db_prefix: "syncular-todo-test".to_string(),
        base_url: options.base_url,
        client_id: options.client_id,
        actor_id: options.actor_id,
        project_id: options.project_id,
    }
}

pub fn todo_task_row(id: &str, title: &str, server_version: i64) -> Value {
    json!({
        "id": id,
        "title": title,
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": server_version,
        "image": null,
        "title_yjs_state": null
    })
}

pub fn todo_snapshot_response(rows: Vec<Value>) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: "sub-tasks".to_string(),
                status: "active".to_string(),
                scopes: serde_json::Map::from_iter([
                    (
                        "user_id".to_string(),
                        Value::String("user-rust".to_string()),
                    ),
                    ("project_id".to_string(), Value::String("p0".to_string())),
                ]),
                bootstrap: true,
                bootstrap_state: None,
                next_cursor: 1,
                integrity: None,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: "tasks".to_string(),
                    rows,
                    chunks: None,
                    artifacts: None,
                    manifest: None,
                    is_first_page: true,
                    is_last_page: true,
                    bootstrap_state_after: None,
                }]),
            }],
        }),
    }
}
