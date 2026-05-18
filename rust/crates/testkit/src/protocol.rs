use serde_json::{Map, Value};
use syncular_runtime::protocol::{
    BootstrapState, CombinedRequest, CombinedResponse, OperationResult, PullResponse,
    PushBatchResponse, PushCommitResponse, ScopeValues, SnapshotChunkRef, SubscriptionResponse,
    SyncChange, SyncCommit, SyncSnapshot,
};

pub fn scope_values(items: impl IntoIterator<Item = (impl Into<String>, Value)>) -> ScopeValues {
    items
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<_, _>>()
}

pub fn actor_project_scopes(actor_id: &str, project_id: Option<&str>) -> ScopeValues {
    let mut scopes = ScopeValues::new();
    scopes.insert("user_id".to_string(), Value::String(actor_id.to_string()));
    if let Some(project_id) = project_id {
        scopes.insert(
            "project_id".to_string(),
            Value::String(project_id.to_string()),
        );
    }
    scopes
}

pub fn schema_required_response(required_schema_version: i32) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: Some(required_schema_version),
        latest_schema_version: Some(required_schema_version),
        push: None,
        pull: None,
    }
}

pub fn schema_latest_response(latest_schema_version: i32) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: Some(latest_schema_version),
        push: None,
        pull: None,
    }
}

pub fn combined_not_ok_response() -> CombinedResponse {
    CombinedResponse {
        ok: false,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: None,
    }
}

pub fn push_not_ok_response(request: &CombinedRequest) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: request.push.as_ref().map(|_| PushBatchResponse {
            ok: false,
            commits: Vec::new(),
        }),
        pull: None,
    }
}

pub fn pull_not_ok_response() -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: false,
            subscriptions: Vec::new(),
        }),
    }
}

pub fn snapshot_combined_response(
    subscription_id: &str,
    table: &str,
    rows: Vec<Value>,
    scopes: ScopeValues,
    next_cursor: i64,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![snapshot_subscription_response(
                subscription_id,
                table,
                rows,
                scopes,
                next_cursor,
            )],
        }),
    }
}

pub fn snapshot_page_combined_response(
    subscription_id: &str,
    table: &str,
    rows: Vec<Value>,
    scopes: ScopeValues,
    next_cursor: i64,
    is_first_page: bool,
    is_last_page: bool,
    bootstrap_state: Option<BootstrapState>,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: subscription_id.to_string(),
                status: "active".to_string(),
                scopes,
                bootstrap: true,
                bootstrap_state,
                next_cursor,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: table.to_string(),
                    rows,
                    chunks: None,
                    is_first_page,
                    is_last_page,
                    bootstrap_state_after: None,
                }]),
            }],
        }),
    }
}

pub fn snapshot_chunks_combined_response(
    subscription_id: &str,
    table: &str,
    chunks: Vec<SnapshotChunkRef>,
    scopes: ScopeValues,
    next_cursor: i64,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: subscription_id.to_string(),
                status: "active".to_string(),
                scopes,
                bootstrap: true,
                bootstrap_state: None,
                next_cursor,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: table.to_string(),
                    rows: Vec::new(),
                    chunks: Some(chunks),
                    is_first_page: true,
                    is_last_page: true,
                    bootstrap_state_after: None,
                }]),
            }],
        }),
    }
}

pub fn snapshot_subscription_response(
    subscription_id: &str,
    table: &str,
    rows: Vec<Value>,
    scopes: ScopeValues,
    next_cursor: i64,
) -> SubscriptionResponse {
    SubscriptionResponse {
        id: subscription_id.to_string(),
        status: "active".to_string(),
        scopes,
        bootstrap: true,
        bootstrap_state: None,
        next_cursor,
        commits: Vec::new(),
        snapshots: Some(vec![SyncSnapshot {
            table: table.to_string(),
            rows,
            chunks: None,
            is_first_page: true,
            is_last_page: true,
            bootstrap_state_after: None,
        }]),
    }
}

pub fn revoked_subscription_response(
    subscription_id: &str,
    scopes: ScopeValues,
    next_cursor: i64,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: subscription_id.to_string(),
                status: "revoked".to_string(),
                scopes,
                bootstrap: false,
                bootstrap_state: None,
                next_cursor,
                commits: Vec::new(),
                snapshots: None,
            }],
        }),
    }
}

pub fn commit_combined_response(
    subscription_id: &str,
    scopes: ScopeValues,
    next_cursor: i64,
    commit_seq: i64,
    changes: Vec<SyncChange>,
) -> CombinedResponse {
    commits_combined_response(
        subscription_id,
        scopes,
        next_cursor,
        vec![SyncCommit {
            commit_seq,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            actor_id: "test-server".to_string(),
            commit_digest: None,
            commit_chain_root: None,
            changes,
        }],
    )
}

pub fn commits_combined_response(
    subscription_id: &str,
    scopes: ScopeValues,
    next_cursor: i64,
    commits: Vec<SyncCommit>,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: None,
        pull: Some(PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: subscription_id.to_string(),
                status: "active".to_string(),
                scopes,
                bootstrap: false,
                bootstrap_state: None,
                next_cursor,
                commits,
                snapshots: None,
            }],
        }),
    }
}

pub fn push_conflict_response(
    request: &CombinedRequest,
    message: &str,
    code: &str,
    server_row: Value,
    server_version: i64,
) -> CombinedResponse {
    CombinedResponse {
        ok: true,
        required_schema_version: None,
        latest_schema_version: None,
        push: request.push.as_ref().map(|push| PushBatchResponse {
            ok: true,
            commits: push
                .commits
                .iter()
                .map(|commit| PushCommitResponse {
                    client_commit_id: commit.client_commit_id.clone(),
                    status: "rejected".to_string(),
                    commit_seq: None,
                    results: vec![OperationResult {
                        op_index: 0,
                        status: "conflict".to_string(),
                        message: Some(message.to_string()),
                        error: None,
                        code: Some(code.to_string()),
                        retriable: Some(false),
                        server_version: Some(server_version),
                        server_row: Some(server_row.clone()),
                    }],
                })
                .collect(),
        }),
        pull: Some(PullResponse {
            ok: true,
            subscriptions: Vec::new(),
        }),
    }
}

pub fn upsert_change(table: &str, row_id: &str, row: Value, row_version: i64) -> SyncChange {
    SyncChange {
        table: table.to_string(),
        row_id: row_id.to_string(),
        op: "upsert".to_string(),
        row_json: Some(row),
        row_version: Some(row_version),
        scopes: ScopeValues::new(),
    }
}

pub fn delete_change(table: &str, row_id: &str, row_version: i64) -> SyncChange {
    SyncChange {
        table: table.to_string(),
        row_id: row_id.to_string(),
        op: "delete".to_string(),
        row_json: None,
        row_version: Some(row_version),
        scopes: ScopeValues::new(),
    }
}
