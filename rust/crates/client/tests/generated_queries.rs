#[allow(dead_code)]
#[path = "../../../../packages/typegen/test/fixtures/basic/syncular.queries.rs"]
mod generated;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use syncular_client::{ClientLimits, Mutation, SyncClient};

fn fixture_schema() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/typegen/test/fixtures/basic/syncular.ir.json"
    ))
    .expect("valid generated schema IR")
}

#[test]
fn generated_plain_query_runs_and_snapshots_against_the_real_client() {
    let mut client = SyncClient::new(
        "generated-query-test".to_owned(),
        &fixture_schema(),
        ClientLimits::default(),
    )
    .expect("create client");
    client
        .mutate(vec![
            Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), json!("task-1")),
                    ("project_id".to_owned(), json!("project-1")),
                    ("title".to_owned(), json!("Generated Rust")),
                    ("done".to_owned(), json!(false)),
                    ("priority".to_owned(), json!(i64::MAX)),
                    ("estimate".to_owned(), json!(1.5)),
                    ("meta".to_owned(), json!(r#"{"source":"rust"}"#)),
                ]),
                base_version: None,
            },
            Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), json!("task-2")),
                    ("project_id".to_owned(), json!("project-1")),
                    ("title".to_owned(), json!("Nullable")),
                    ("done".to_owned(), json!(true)),
                    ("priority".to_owned(), json!(i64::MIN)),
                ]),
                base_version: None,
            },
        ])
        .expect("insert local row");

    let params = generated::list_project_tasks::Params::new("project-1".to_owned());
    let rows = generated::list_project_tasks::run(&client, &params).expect("typed query");
    assert_eq!(rows.len(), 2);
    let maximum = rows.iter().find(|row| row.id == "task-1").expect("max row");
    assert_eq!(maximum.title, "Generated Rust");
    assert!(!maximum.done);
    assert_eq!(maximum.priority, Some(i64::MAX));
    assert_eq!(maximum.estimate, Some(1.5));
    let minimum = rows.iter().find(|row| row.id == "task-2").expect("min row");
    assert_eq!(minimum.priority, Some(i64::MIN));
    assert_eq!(minimum.estimate, None);

    let value_params = generated::task_value_types::Params::new("task-1".to_owned());
    let value_rows = generated::task_value_types::run(&client, &value_params).expect("value query");
    assert_eq!(value_rows[0].priority, Some(i64::MAX));
    assert_eq!(value_rows[0].estimate, Some(1.5));
    assert_eq!(value_rows[0].meta.as_deref(), Some(r#"{"source":"rust"}"#));

    let snapshot =
        generated::list_project_tasks::snapshot(&mut client, &params).expect("typed snapshot");
    assert_eq!(snapshot.rows, rows);
    assert_eq!(snapshot.revision, "1");
    assert!(!snapshot.coverage.complete);
}

#[test]
fn generated_rows_cover_every_query_ir_value_type() {
    let mut client = SyncClient::new(
        "generated-value-test".to_owned(),
        &fixture_schema(),
        ClientLimits::default(),
    )
    .expect("create client");
    client
        .mutate(vec![Mutation::Upsert {
            table: "docs".to_owned(),
            values: Map::from_iter([
                ("id".to_owned(), json!("doc-1")),
                ("org_id".to_owned(), json!("org-1")),
                ("project_id".to_owned(), json!("project-1")),
                ("body".to_owned(), json!("body")),
                ("score".to_owned(), json!(2.5)),
                ("attachment".to_owned(), json!({ "$bytes": "00ff10" })),
                ("body_doc".to_owned(), json!({ "$bytes": "0102" })),
                ("remote_blob".to_owned(), json!("blob-1")),
            ]),
            base_version: None,
        }])
        .expect("insert typed row");

    let params = generated::doc_value_types::Params::new("doc-1".to_owned());
    let rows = generated::doc_value_types::run(&client, &params).expect("typed query");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attachment, Some(vec![0x00, 0xff, 0x10]));
    assert_eq!(rows[0].body_doc, Some(vec![0x01, 0x02]));
    assert_eq!(rows[0].remote_blob.as_deref(), Some("blob-1"));

    let task_params = generated::task_value_types::Params::new("missing".to_owned());
    assert!(generated::task_value_types::run(&client, &task_params)
        .expect("empty typed query")
        .is_empty());
}

#[test]
fn generated_syql_selection_preserves_presence_defaults_and_bounds() {
    let mut params = generated::search_tasks::Params::new("project-1".to_owned());
    let baseline = generated::search_tasks::select(&params).expect("default selection");
    assert_eq!(baseline.params.last(), Some(&json!(50)));

    for (sort, sql) in [
        (generated::search_tasks::SortBy::PriorityAsc, "priority asc"),
        (
            generated::search_tasks::SortBy::PriorityDesc,
            "priority desc",
        ),
        (
            generated::search_tasks::SortBy::EstimatedAtAsc,
            "estimated_at asc",
        ),
        (
            generated::search_tasks::SortBy::EstimatedAtDesc,
            "estimated_at desc",
        ),
        (generated::search_tasks::SortBy::TitleAsc, "title asc"),
        (generated::search_tasks::SortBy::TitleDesc, "title desc"),
    ] {
        params.sort_by = sort;
        assert!(generated::search_tasks::select(&params)
            .expect("sort profile")
            .sql
            .contains(sql));
    }

    params.page_size = Some(1);
    assert!(generated::search_tasks::select(&params).is_ok());
    params.page_size = Some(200);
    assert!(generated::search_tasks::select(&params).is_ok());

    params.needle = Some("Rust".to_owned());
    params.open_only = true;
    params.sort_by = generated::search_tasks::SortBy::TitleAsc;
    params.page_size = Some(25);
    let selected = generated::search_tasks::select(&params).expect("variant selection");
    assert!(selected.sql.contains("title like"));
    assert!(selected.sql.contains("done = 0"));
    assert!(selected.sql.contains("title asc"));
    assert_eq!(selected.params.last(), Some(&json!(25)));

    params.page_size = Some(201);
    let error = generated::search_tasks::select(&params).expect_err("invalid limit");
    assert!(error.to_string().contains("SYQL_RUNTIME_INVALID_LIMIT"));
    params.page_size = Some(0);
    assert!(generated::search_tasks::select(&params).is_err());

    let mut grouped = generated::task_estimate_range::Params::new("project-1".to_owned());
    let absent_group = generated::task_estimate_range::select(&grouped).expect("absent group");
    grouped.range = Some(generated::task_estimate_range::Range { start: 10, end: 20 });
    let present_group = generated::task_estimate_range::select(&grouped).expect("present group");
    assert_eq!(absent_group.params, [json!("project-1")]);
    assert_eq!(
        present_group.params[present_group.params.len() - 2],
        json!(10)
    );
    assert_eq!(present_group.params.last(), Some(&json!(20)));
}

#[test]
fn generated_variants_distinguish_absent_from_present_null() {
    let mut params = generated::task_meta_filter::Params::new("project-1".to_owned());
    let absent = generated::task_meta_filter::select(&params).expect("absent variant");
    assert!(!absent.sql.contains("meta is ?"));

    params.meta = generated::SyqlPresence::Present(None);
    let present_null = generated::task_meta_filter::select(&params).expect("null variant");
    assert!(present_null.sql.contains("meta is ?"));
    assert_eq!(present_null.params.last(), Some(&Value::Null));

    params.meta = generated::SyqlPresence::Present(Some(r#"{"x":1}"#.to_owned()));
    let present_value = generated::task_meta_filter::select(&params).expect("value variant");
    assert_eq!(present_value.params.last(), Some(&json!(r#"{"x":1}"#)));
}

#[test]
fn generated_descriptors_expose_scope_coverage_and_row_identity() {
    let params = generated::list_project_tasks::Params::new("project-1".to_owned());
    let dependencies = generated::list_project_tasks::dependencies(&params);
    assert_eq!(dependencies[0].table, "tasks");
    assert_eq!(
        dependencies[0].scope_keys.as_deref(),
        Some(["project:project-1".to_owned()].as_slice())
    );
    let coverage = generated::list_project_tasks::coverage(&params);
    assert_eq!(coverage[0].base.table, "tasks");
    assert_eq!(coverage[0].units, ["project-1"]);

    let docs = generated::docs_in_project::Params::new("org-1".to_owned(), "project-1".to_owned());
    let docs_coverage = generated::docs_in_project::coverage(&docs);
    assert!(!docs_coverage.is_empty());
    assert!(docs_coverage
        .iter()
        .any(|item| !item.base.fixed_scopes.is_empty()));

    let row = generated::list_project_tasks::Row {
        id: "task-1".to_owned(),
        title: "Generated Rust".to_owned(),
        done: false,
        priority: None,
        estimate: None,
    };
    assert_eq!(
        generated::list_project_tasks::row_key(&row),
        vec![json!("task-1")]
    );
}

#[test]
fn generated_integer_and_byte_decoders_are_strict_and_lossless() {
    let bigint = json!({ "$bigint": i64::MAX.to_string() });
    let bytes = json!({ "$bytes": "00ff10" });
    let mut row = BTreeMap::new();
    row.insert("big".to_owned(), bigint);
    row.insert("bytes".to_owned(), bytes);

    // Compile-time coverage for the public aliases used by generated source.
    let _: syncular_client::QueryValue = row["big"].clone();
    let _: syncular_client::QueryRow = row.into_iter().collect();

    let missing = Map::from_iter([
        ("id".to_owned(), json!("task-1")),
        ("done".to_owned(), json!(false)),
        ("priority".to_owned(), json!(1)),
        ("estimate".to_owned(), json!(1.5)),
    ]);
    let error = generated::task_value_types::decode(missing).expect_err("missing column");
    assert!(error.to_string().contains("meta"));
    assert!(error.to_string().contains("missing column"));

    let malformed = Map::from_iter([
        ("id".to_owned(), json!("doc-1")),
        ("attachment".to_owned(), json!({ "$bytes": "xyz" })),
        ("bodyDoc".to_owned(), Value::Null),
        ("remoteBlob".to_owned(), Value::Null),
    ]);
    let error = generated::doc_value_types::decode(malformed).expect_err("bad bytes");
    assert!(error.to_string().contains("attachment"));
    assert!(error.to_string().contains("$bytes"));
}
