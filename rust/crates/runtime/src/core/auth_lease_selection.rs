use crate::app_schema::AppTableMetadata;
use crate::error::{Result, SyncularError};
use crate::protocol::{
    AuthLeasePayload, AuthLeaseProvenance, SyncOperation, AUTH_LEASE_CODE_EXPIRED,
    AUTH_LEASE_CODE_MISSING, AUTH_LEASE_CODE_SCOPE_MISMATCH,
};
use crate::store::AuthLeaseRecord;
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct ActiveAuthLeasePolicy<'a> {
    pub actor_id: Option<&'a str>,
    pub now_ms: i64,
}

#[derive(Debug, Clone)]
pub struct MutationOperationScope {
    pub table: String,
    pub op: String,
    pub scopes: Map<String, Value>,
    pub requires_scope_values: bool,
    pub missing_required_scope_values: bool,
}

pub fn app_table_operation_scope(
    metadata: &AppTableMetadata,
    operation: &SyncOperation,
    row: Option<&Value>,
    row_exists_or_will_be_written: bool,
) -> MutationOperationScope {
    let mut scopes = Map::new();
    if let Some(Value::Object(object)) = row {
        for scope in metadata.scopes {
            if let Some(value) = object.get(scope.column).and_then(scope_value_string) {
                scopes.insert(scope.name.to_string(), Value::String(value));
            }
        }
    }
    let missing_required_scope_values = row_exists_or_will_be_written
        && metadata.scopes.iter().any(|scope| {
            scope.required
                && !matches!(scopes.get(scope.name), Some(Value::String(value)) if !value.is_empty())
        });

    MutationOperationScope {
        table: operation.table.clone(),
        op: operation.op.clone(),
        scopes,
        requires_scope_values: row_exists_or_will_be_written
            && metadata.scopes.iter().any(|scope| scope.required),
        missing_required_scope_values,
    }
}

pub fn system_table_operation_scope(operation: &SyncOperation) -> MutationOperationScope {
    let scopes = operation
        .payload
        .as_ref()
        .and_then(|payload| payload.get("scopes"))
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    scope_value_string(value).map(|value| (key.clone(), Value::String(value)))
                })
                .collect()
        })
        .unwrap_or_default();

    MutationOperationScope {
        table: operation.table.clone(),
        op: operation.op.clone(),
        scopes,
        requires_scope_values: false,
        missing_required_scope_values: false,
    }
}

pub fn select_active_auth_lease_for_operations(
    policy: ActiveAuthLeasePolicy<'_>,
    candidate_leases: Vec<AuthLeaseRecord>,
    current_schema_version: i32,
    operations: &[MutationOperationScope],
) -> Result<AuthLeaseProvenance> {
    for operation in operations {
        if operation.missing_required_scope_values {
            return Err(SyncularError::protocol_message(format!(
                "{}: mutation for table {} is missing required lease scope values",
                AUTH_LEASE_CODE_SCOPE_MISMATCH, operation.table
            )));
        }
    }

    let mut saw_expired_covering_lease = false;
    for lease in candidate_leases {
        if lease.status != "active" {
            continue;
        }
        if lease.schema_version != current_schema_version {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<AuthLeasePayload>(&lease.payload_json) else {
            continue;
        };
        if payload.schema_version != current_schema_version {
            continue;
        }
        if let Some(actor_id) = policy.actor_id {
            if payload.actor_id != actor_id {
                continue;
            }
        }
        if auth_lease_payload_covers_operations(&payload, operations) {
            if lease.not_before_ms > policy.now_ms || payload.not_before_ms > policy.now_ms {
                continue;
            }
            if lease.expires_at_ms <= policy.now_ms || payload.expires_at_ms <= policy.now_ms {
                saw_expired_covering_lease = true;
                continue;
            }
            return Ok(AuthLeaseProvenance {
                lease_id: lease.lease_id,
                lease_expires_at_ms: lease.expires_at_ms,
                lease_status_at_enqueue: lease.status,
                lease_scope_summary_json: serde_json::to_string(&payload.scopes).ok(),
                lease_token: Some(lease.token),
            });
        }
    }

    if saw_expired_covering_lease {
        return Err(SyncularError::protocol_message(format!(
            "{}: matching auth lease is expired",
            AUTH_LEASE_CODE_EXPIRED
        )));
    }

    Err(SyncularError::protocol_message(format!(
        "{}: no active auth lease covers generated mutation batch",
        AUTH_LEASE_CODE_MISSING
    )))
}

fn auth_lease_payload_covers_operations(
    payload: &AuthLeasePayload,
    operations: &[MutationOperationScope],
) -> bool {
    operations.iter().all(|operation| {
        let Some(scope) = payload.scopes.iter().find(|scope| {
            scope.table == operation.table
                && scope
                    .operations
                    .iter()
                    .any(|allowed_op| allowed_op == &operation.op)
        }) else {
            return false;
        };

        if operation.requires_scope_values && operation.scopes.is_empty() {
            return false;
        }

        operation.scopes.iter().all(|(name, value)| {
            scope
                .values
                .get(name)
                .is_some_and(|lease_value| lease_scope_value_covers(lease_value, value))
        })
    })
}

fn lease_scope_value_covers(lease_value: &Value, requested_value: &Value) -> bool {
    let Some(requested) = scope_value_string(requested_value) else {
        return false;
    };
    match lease_value {
        Value::String(value) => value == "*" || value == &requested,
        Value::Array(values) => values.iter().any(|value| {
            value
                .as_str()
                .is_some_and(|value| value == "*" || value == requested)
        }),
        other => scope_value_string(other).is_some_and(|value| value == "*" || value == requested),
    }
}

fn scope_value_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => {
            if value.is_empty() {
                None
            } else {
                Some(value.clone())
            }
        }
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(_) | Value::Object(_) => None,
    }
}
