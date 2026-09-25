use serde_json::{json, Map, Value};
use syncular_client::{ClientLimits, Mutation, SyncClient};

fn fixture_client() -> SyncClient {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../packages/typegen/test/fixtures/basic/syncular.ir.json"
    ))
    .expect("valid generated schema IR");
    SyncClient::new(
        "local-unique-test".to_owned(),
        &schema,
        ClientLimits::default(),
    )
    .expect("create client")
}

fn task(id: &str, project_id: &str, title: &str) -> Mutation {
    Mutation::Upsert {
        table: "tasks".to_owned(),
        values: Map::from_iter([
            ("id".to_owned(), json!(id)),
            ("project_id".to_owned(), json!(project_id)),
            ("title".to_owned(), json!(title)),
            ("done".to_owned(), json!(false)),
        ]),
        base_version: None,
    }
}

fn task_ids(client: &SyncClient) -> Vec<String> {
    client
        .read_rows("tasks")
        .expect("read tasks")
        .into_iter()
        .map(|row| row.row_id)
        .collect()
}

#[test]
fn a_commit_violating_a_secondary_unique_index_fails_and_enqueues_nothing() {
    let mut client = fixture_client();
    let error = client
        .mutate(vec![task("t1", "p1", "same"), task("t2", "p1", "same")])
        .expect_err("the second row violates idx_tasks_project_title");
    assert_eq!(
        error,
        "sync.constraint_violation: local write violates a unique constraint"
    );
    assert!(task_ids(&client).is_empty());
    assert!(client.pending_commit_ids().is_empty());
    assert_eq!(client.local_revision(), 0);

    let first = client
        .mutate(vec![task("t1", "p1", "same")])
        .expect("first row");
    let error = client
        .mutate(vec![task("t2", "p1", "same")])
        .expect_err("a later commit collides with the pending row");
    assert!(error.starts_with("sync.constraint_violation:"), "{error}");
    assert_eq!(task_ids(&client), vec!["t1".to_owned()]);
    assert_eq!(client.pending_commit_ids(), vec![first]);
    assert_eq!(client.local_revision(), 1);

    // Same values in another project, and a rename that frees the value
    // before a sibling takes it within one commit, both apply.
    client
        .mutate(vec![task("t2", "p2", "same")])
        .expect("another project");
    client
        .mutate(vec![task("t1", "p1", "renamed"), task("t3", "p1", "same")])
        .expect("value freed earlier in the same commit");
    assert_eq!(
        task_ids(&client),
        vec!["t1".to_owned(), "t2".to_owned(), "t3".to_owned()]
    );
    assert_eq!(client.pending_commit_ids().len(), 3);
}

#[test]
fn a_patch_violating_a_secondary_unique_index_fails_and_enqueues_nothing() {
    let mut client = fixture_client();
    client
        .mutate(vec![task("t1", "p1", "a"), task("t2", "p1", "b")])
        .expect("seed");
    let error = client
        .patch(
            "tasks",
            "t2",
            Map::from_iter([("title".to_owned(), json!("a"))]),
            None,
        )
        .expect_err("the patch collides with t1");
    assert!(error.starts_with("sync.constraint_violation:"), "{error}");
    assert_eq!(client.pending_commit_ids().len(), 1);
    let titles: Vec<Value> = client
        .read_rows("tasks")
        .expect("read tasks")
        .into_iter()
        .map(|row| row.values["title"].clone())
        .collect();
    assert_eq!(titles, vec![json!("a"), json!("b")]);
}
