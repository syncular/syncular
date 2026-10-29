//! §12.3 attach: the upload plan and the remote exchange, following the
//! reference `planAttach` and `connect` in
//! `packages/server/src/local-authority.ts`.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{json, Value};
use ssp2::decode::WIRE_VERSION;
use ssp2::model::{Frame, Message, MsgKind, Op, OpResult, Operation, PushStatus};
use ssp2::segment::{encode_sparse_row, SparseSlot};
use ssp2::{decode_message, encode_message};

use crate::schema::Schema;
use crate::store;
use crate::{AuthorityError, RemoteTransport};

/// Operations per attach commit: the reference server's request cap (§6.1).
pub(crate) const OPERATION_BUDGET: usize = 500;

/// One planned commit: `clientCommitId` and its operations.
pub(crate) type PlannedCommit = (String, Vec<Operation>);

pub(crate) fn rejected(details: Value) -> AuthorityError {
    AuthorityError::with_details(
        "sync.attach_rejected",
        "the remote server did not accept the attach upload",
        details,
    )
}

fn request_failed(code: &str, retryable: bool) -> AuthorityError {
    rejected(json!({ "reason": "request_failed", "code": code, "retryable": retryable }))
}

/// Every live row as one insert. Rows are visited in (table name, row ID)
/// binary order; Tarjan's strongly connected components of the row-level
/// reference graph come out in completion order (every parent before its
/// children) and pack whole into commits of at most [`OPERATION_BUDGET`].
pub(crate) fn plan(
    conn: &Connection,
    schema: &Schema,
    attach_id: &str,
) -> Result<Vec<PlannedCommit>, AuthorityError> {
    let mut tables: Vec<_> = schema.tables.iter().collect();
    tables.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    let mut node_table = Vec::new();
    let mut node_row_id = Vec::new();
    let mut node_values = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    for table in &tables {
        for (row_id, payload) in store::all_rows(conn, &table.name)? {
            index.insert((table.name.clone(), row_id.clone()), node_row_id.len());
            node_values.push(store::decode_payload(&table.columns, &payload)?);
            node_table.push(*table);
            node_row_id.push(row_id);
        }
    }
    let parents: Vec<Vec<usize>> = node_values
        .iter()
        .enumerate()
        .map(|(node, values)| {
            node_table[node]
                .references
                .iter()
                .filter_map(|reference| {
                    let parent_id = store::render(&values[reference.column])?;
                    index.get(&(reference.parent.clone(), parent_id)).copied()
                })
                .collect()
        })
        .collect();

    // Iterative Tarjan: a deep parent chain must not exhaust the stack.
    let count = node_row_id.len();
    let mut order = vec![usize::MAX; count];
    let mut low = vec![0usize; count];
    let mut on_stack = vec![false; count];
    let mut stack = Vec::new();
    let mut components: Vec<Vec<usize>> = Vec::new();
    let mut counter = 0;
    for root in 0..count {
        if order[root] != usize::MAX {
            continue;
        }
        order[root] = counter;
        low[root] = counter;
        counter += 1;
        stack.push(root);
        on_stack[root] = true;
        let mut frames: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some(&(node, edge)) = frames.last() {
            if let Some(&next) = parents[node].get(edge) {
                if let Some(frame) = frames.last_mut() {
                    frame.1 += 1;
                }
                if order[next] == usize::MAX {
                    order[next] = counter;
                    low[next] = counter;
                    counter += 1;
                    stack.push(next);
                    on_stack[next] = true;
                    frames.push((next, 0));
                } else if on_stack[next] {
                    low[node] = low[node].min(order[next]);
                }
                continue;
            }
            frames.pop();
            if let Some(&(caller, _)) = frames.last() {
                low[caller] = low[caller].min(low[node]);
            }
            if low[node] != order[node] {
                continue;
            }
            let mut component = Vec::new();
            loop {
                let member = stack.pop().expect("the root is on the stack");
                on_stack[member] = false;
                component.push(member);
                if member == node {
                    break;
                }
            }
            component.sort_unstable();
            components.push(component);
        }
    }

    let mut commits: Vec<PlannedCommit> = Vec::new();
    let mut operations: Vec<Operation> = Vec::new();
    for component in components {
        if component.len() > OPERATION_BUDGET {
            return Err(rejected(json!({
                "reason": "cycle_too_large",
                "table": node_table[component[0]].name,
                "size": component.len(),
            })));
        }
        if operations.len() + component.len() > OPERATION_BUDGET {
            commits.push((
                format!("{attach_id}:{}", commits.len()),
                std::mem::take(&mut operations),
            ));
        }
        for node in component {
            let table = node_table[node];
            let slots = node_values[node]
                .iter()
                .map(|value| value.clone().map_or(SparseSlot::Null, SparseSlot::Value))
                .collect();
            operations.push(Operation {
                table: table.name.clone(),
                row_id: node_row_id[node].clone(),
                op: Op::Upsert,
                base_version: Some(0),
                payload: Some(encode_sparse_row(&table.columns, table.pk, &slots)),
            });
        }
    }
    if !operations.is_empty() {
        commits.push((format!("{attach_id}:{}", commits.len()), operations));
    }
    Ok(commits)
}

fn exchange(
    remote: &mut RemoteTransport<'_>,
    frames: Vec<Frame>,
) -> Result<Vec<Frame>, AuthorityError> {
    let bytes = remote(&encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind: MsgKind::Request,
        frames,
    }))?;
    let message = decode_message(&bytes).map_err(|e| {
        AuthorityError::with_details(
            e.code.as_str(),
            "the remote response failed to decode",
            json!({ "detail": e.detail }),
        )
    })?;
    if message.msg_kind != MsgKind::Response {
        return Err(request_failed("sync.invalid_request", false));
    }
    if let Some(Frame::RespHeader {
        required_schema_version: Some(required),
        latest_schema_version,
        ..
    }) = message.frames.first()
    {
        if *required != 0 {
            let mut details =
                json!({ "reason": "schema_floor", "requiredSchemaVersion": required });
            if let Some(latest) = latest_schema_version {
                details["latestSchemaVersion"] = json!(latest);
            }
            return Err(rejected(details));
        }
    }
    if let Some(Frame::Error {
        code, retryable, ..
    }) = message
        .frames
        .iter()
        .find(|frame| matches!(frame, Frame::Error { .. }))
    {
        return Err(request_failed(code, *retryable));
    }
    Ok(message.frames)
}

/// The remote side of an attach: the producer identity and the acquired
/// `logEpoch` (§2.1).
pub(crate) struct Remote<'r, 'a> {
    transport: &'r mut RemoteTransport<'a>,
    client_id: String,
    schema_version: i32,
    log_epoch: String,
}

impl<'r, 'a> Remote<'r, 'a> {
    /// Acquire the remote `logEpoch` with a pull-less round.
    pub(crate) fn connect(
        transport: &'r mut RemoteTransport<'a>,
        attach_id: &str,
        schema_version: i32,
    ) -> Result<Self, AuthorityError> {
        let client_id = format!("authority-{attach_id}");
        let frames = exchange(
            transport,
            vec![
                Frame::ReqHeader {
                    client_id: client_id.clone(),
                    schema_version,
                    log_epoch: None,
                },
                Frame::PullHeader {
                    limit_commits: 0,
                    limit_snapshot_rows: 0,
                    max_snapshot_pages: 0,
                    accept: 0b0011,
                },
            ],
        )?;
        let Some(Frame::RespHeader {
            log_epoch: Some(log_epoch),
            ..
        }) = frames.into_iter().next()
        else {
            return Err(request_failed("sync.invalid_request", false));
        };
        Ok(Remote {
            transport,
            client_id,
            schema_version,
            log_epoch,
        })
    }

    /// Send one commit: `None` when the remote applied it (`applied` or
    /// `cached`), else the `sync.attach_rejected` `commit_rejected` error.
    pub(crate) fn send(
        &mut self,
        commit: &PlannedCommit,
    ) -> Result<Option<AuthorityError>, AuthorityError> {
        let frames = exchange(
            self.transport,
            vec![
                Frame::ReqHeader {
                    client_id: self.client_id.clone(),
                    schema_version: self.schema_version,
                    log_epoch: Some(self.log_epoch.clone()),
                },
                Frame::PushCommit {
                    client_commit_id: commit.0.clone(),
                    operations: commit.1.clone(),
                },
            ],
        )?;
        if matches!(
            frames.first(),
            Some(Frame::RespHeader {
                reset_required: Some(true),
                ..
            })
        ) {
            return Err(rejected(json!({ "reason": "log_epoch_changed" })));
        }
        let Some(Frame::PushResult {
            status, results, ..
        }) = frames
            .iter()
            .find(|frame| matches!(frame, Frame::PushResult { .. }))
        else {
            return Err(request_failed("sync.invalid_request", false));
        };
        if matches!(status, PushStatus::Applied | PushStatus::Cached) {
            return Ok(None);
        }
        let (op_index, code) = results
            .iter()
            .find_map(|result| match result {
                OpResult::Applied { .. } => None,
                OpResult::Conflict { op_index, code, .. }
                | OpResult::Error { op_index, code, .. } => Some((*op_index, code.clone())),
            })
            .unwrap_or((0, "sync.invalid_request".to_owned()));
        Ok(Some(rejected(json!({
            "reason": "commit_rejected",
            "clientCommitId": commit.0,
            "opIndex": op_index,
            "code": code,
        }))))
    }
}
