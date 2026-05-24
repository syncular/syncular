use super::diesel_tables::adapter_for;
use super::generated::{NewTask, TaskPatch};
use super::schema;
use crate::error::Result;
use crate::protocol::SyncOperation;
use crate::store::Task;
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

#[derive(Debug, Clone, Queryable, Selectable)]
#[diesel(table_name = schema::tasks)]
struct DemoTaskRow {
    id: String,
    title: String,
    completed: i32,
    user_id: String,
    project_id: Option<String>,
    server_version: i64,
    image: Option<String>,
    title_yjs_state: Option<String>,
}

impl From<DemoTaskRow> for Task {
    fn from(row: DemoTaskRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            completed: row.completed,
            user_id: row.user_id,
            project_id: row.project_id,
            server_version: row.server_version,
            image: row.image,
            title_yjs_state: row.title_yjs_state,
        }
    }
}

pub fn insert_local_task(
    conn: &mut SqliteConnection,
    actor_id: &str,
    project_id: Option<&str>,
    task_id: &str,
    title_value: &str,
) -> Result<SyncOperation> {
    let mutation = NewTask::new(task_id, title_value, actor_id, project_id);
    adapter_for("tasks")?.upsert_row(conn, &mutation.row_json(), Some(0))?;
    Ok(mutation.sync_operation())
}

pub fn patch_local_task_title(
    conn: &mut SqliteConnection,
    project_id: Option<&str>,
    task_id: &str,
    title_value: &str,
) -> Result<SyncOperation> {
    use schema::tasks::dsl as t;

    let mutation = TaskPatch::new(task_id)
        .title(title_value)
        .project_id(project_id);

    diesel::update(t::tasks.filter(t::id.eq(task_id)))
        .set(t::title.eq(title_value))
        .execute(conn)?;

    Ok(mutation.sync_operation())
}

pub fn list_tasks(conn: &mut SqliteConnection) -> Result<Vec<Task>> {
    use schema::tasks::dsl as t;

    let rows: Vec<DemoTaskRow> = t::tasks
        .select(DemoTaskRow::as_select())
        .order((t::user_id.asc(), t::title.asc()))
        .load(conn)?;

    Ok(rows.into_iter().map(Task::from).collect())
}
