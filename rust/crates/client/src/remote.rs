//! Database-less SSP2 producer (`SPEC.md` §6.10).
//!
//! Prepared request bytes are the retry unit. A caller that needs crash-safe
//! retry persists them in its own job or request store.

use serde::de::DeserializeOwned;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use ssp2::model::{Frame, Message, MsgKind, Op, OpResult, Operation, PushResultDetail, PushStatus};
use ssp2::{decode_message, encode_message};

use crate::api::Mutation;
use crate::schema::ClientSchema;
use crate::transport::Transport;
use crate::values::{
    encode_row_json, normalize_values_casing, render_row_id_json, EncryptionConfig,
};

#[derive(Debug, Clone)]
pub struct RemoteCommitInput {
    pub request_id: String,
    pub mutations: Vec<Mutation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRemoteCommit {
    pub request_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteCommitResult {
    pub request_id: String,
    pub status: PushStatus,
    pub commit_seq: Option<i64>,
    pub results: Vec<OpResult>,
    pub details: Vec<PushResultDetail>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteQueryResult<Row> {
    pub rows: Vec<Row>,
    pub max_commit_seq: i64,
}

/// Binary value for registered query and command parameters. Plain `Vec<u8>`
/// serializes as a JSON array, so callers use this wrapper when the remote
/// operation schema expects the protocol's `bytes` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBytes(pub Vec<u8>);

impl Serialize for RemoteBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("$syncular.bytes", &base64_encode(&self.0))?;
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteCommandResult {
    pub request_id: String,
    pub status: String,
    pub commit_seq: Option<i64>,
    pub results: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteClientError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl RemoteClientError {
    fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("sync.invalid_request", message, false)
    }

    fn invalid_response(message: impl Into<String>) -> Self {
        Self::new("client.invalid_host_response", message, false)
    }
}

impl std::fmt::Display for RemoteClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RemoteClientError {}

pub struct SyncRemoteClient {
    schema: Option<ClientSchema>,
    client_id: String,
    log_epoch: Option<String>,
    encryption: EncryptionConfig,
}

impl SyncRemoteClient {
    pub fn new(
        schema: ClientSchema,
        client_id: impl Into<String>,
    ) -> Result<Self, RemoteClientError> {
        let mut client = Self::for_operations(client_id)?;
        client.schema = Some(schema);
        Ok(client)
    }

    pub fn for_operations(client_id: impl Into<String>) -> Result<Self, RemoteClientError> {
        let client_id = client_id.into();
        if client_id.is_empty() {
            return Err(RemoteClientError::invalid(
                "SyncRemoteClient clientId must be non-empty",
            ));
        }
        Ok(Self {
            schema: None,
            client_id,
            log_epoch: None,
            encryption: EncryptionConfig::default(),
        })
    }

    pub fn with_encryption(mut self, encryption: EncryptionConfig) -> Self {
        self.encryption = encryption;
        self
    }

    /// Bind prepared commit bytes to one acquired partition log epoch (§2.1).
    pub fn with_log_epoch(
        mut self,
        log_epoch: impl Into<String>,
    ) -> Result<Self, RemoteClientError> {
        let log_epoch = log_epoch.into();
        if log_epoch.is_empty() {
            return Err(RemoteClientError::invalid("logEpoch must be non-empty"));
        }
        self.log_epoch = Some(log_epoch);
        Ok(self)
    }

    pub fn prepare_commit(
        &self,
        input: RemoteCommitInput,
    ) -> Result<PreparedRemoteCommit, RemoteClientError> {
        if input.request_id.is_empty() {
            return Err(RemoteClientError::invalid(
                "remote commit requestId must be non-empty",
            ));
        }
        if input.mutations.is_empty() {
            return Err(RemoteClientError::new(
                "sync.empty_commit",
                "a remote commit must carry at least one mutation (§6.1)",
                false,
            ));
        }
        let schema = self.schema.as_ref().ok_or_else(|| {
            RemoteClientError::new(
                "client.remote_schema_unconfigured",
                "SyncRemoteClient needs a schema to prepare ordinary commits",
                false,
            )
        })?;
        let mut operations = Vec::with_capacity(input.mutations.len());
        for mutation in input.mutations {
            match mutation {
                Mutation::Upsert {
                    table,
                    values,
                    base_version,
                } => {
                    let schema_table = schema.table(&table).ok_or_else(|| {
                        RemoteClientError::invalid("remote commit targets an unknown table")
                    })?;
                    let values: Map<String, serde_json::Value> =
                        normalize_values_casing(schema_table, values)
                            .map_err(RemoteClientError::invalid)?;
                    let row_id = render_row_id_json(values.get(&schema_table.primary_key))
                        .map_err(RemoteClientError::invalid)?;
                    let payload = encode_row_json(schema_table, &row_id, &values, &self.encryption)
                        .map_err(RemoteClientError::invalid)?;
                    operations.push(Operation {
                        table,
                        row_id,
                        op: Op::Upsert,
                        base_version,
                        payload: Some(payload),
                    });
                }
                Mutation::Delete {
                    table,
                    row_id,
                    base_version,
                } => {
                    if schema.table(&table).is_none() {
                        return Err(RemoteClientError::invalid(
                            "remote commit targets an unknown table",
                        ));
                    }
                    if row_id.is_empty() {
                        return Err(RemoteClientError::invalid(
                            "remote delete rowId must be non-empty",
                        ));
                    }
                    operations.push(Operation {
                        table,
                        row_id,
                        op: Op::Delete,
                        base_version,
                        payload: None,
                    });
                }
            }
        }
        let bytes = encode_message(&Message {
            wire_version: if self.log_epoch.is_some() { 2 } else { 1 },
            msg_kind: MsgKind::Request,
            frames: vec![
                Frame::ReqHeader {
                    client_id: self.client_id.clone(),
                    schema_version: schema.version,
                    log_epoch: self.log_epoch.clone(),
                },
                Frame::PushCommit {
                    client_commit_id: input.request_id.clone(),
                    operations,
                },
            ],
        });
        Ok(PreparedRemoteCommit {
            request_id: input.request_id,
            bytes,
        })
    }

    pub fn send_commit<T: Transport>(
        &self,
        transport: &mut T,
        prepared: &PreparedRemoteCommit,
    ) -> Result<RemoteCommitResult, RemoteClientError> {
        let bytes = transport
            .sync(&prepared.bytes)
            .map_err(|error| RemoteClientError::new(error.code, error.message, true))?;
        let response = decode_message(&bytes).map_err(|_| {
            RemoteClientError::invalid_response("remote commit response is not valid SSP2")
        })?;
        if response.msg_kind != MsgKind::Response {
            return Err(RemoteClientError::invalid_response(
                "remote commit transport returned a non-response SSP2 message",
            ));
        }
        for frame in &response.frames {
            if let Frame::Error {
                code,
                message,
                retryable,
                ..
            } = frame
            {
                return Err(RemoteClientError::new(code, message, *retryable));
            }
        }
        let mut matched = None;
        let mut details = Vec::new();
        for frame in response.frames {
            match frame {
                Frame::PushResult {
                    client_commit_id,
                    status,
                    commit_seq,
                    results,
                } if client_commit_id == prepared.request_id => {
                    matched = Some((status, commit_seq, results));
                }
                Frame::PushResultDetails {
                    client_commit_id,
                    entries,
                } if client_commit_id == prepared.request_id => {
                    details = entries;
                }
                _ => {}
            }
        }
        let Some((status, commit_seq, results)) = matched else {
            return Err(RemoteClientError::invalid_response(
                "remote commit response carried no matching PUSH_RESULT",
            ));
        };
        Ok(RemoteCommitResult {
            request_id: prepared.request_id.clone(),
            status,
            commit_seq,
            results,
            details,
        })
    }

    pub fn commit<T: Transport>(
        &self,
        transport: &mut T,
        input: RemoteCommitInput,
    ) -> Result<RemoteCommitResult, RemoteClientError> {
        let prepared = self.prepare_commit(input)?;
        self.send_commit(transport, &prepared)
    }

    pub fn query<T, Params, Row>(
        &self,
        transport: &mut T,
        operation_id: &str,
        params: &Params,
    ) -> Result<RemoteQueryResult<Row>, RemoteClientError>
    where
        T: Transport,
        Params: Serialize,
        Row: DeserializeOwned,
    {
        if operation_id.is_empty() {
            return Err(RemoteClientError::invalid(
                "remote query id must be non-empty",
            ));
        }
        let request = json!({
            "revision": protocol_revision(),
            "kind": "query",
            "clientId": self.client_id,
            "operationId": operation_id,
            "params": serde_json::to_value(params)
                .map_err(|error| RemoteClientError::invalid(error.to_string()))?,
        });
        let response = transport
            .remote_operation(&encode_operation_value(&request)?)
            .map_err(|error| RemoteClientError::new(error.code, error.message, true))?;
        let decoded = decode_operation_value(&response)?;
        validate_operation_revision(&decoded)?;
        if decoded.get("kind").and_then(Value::as_str) == Some("error") {
            return Err(operation_error(&decoded)?);
        }
        if decoded.get("kind").and_then(Value::as_str) != Some("query")
            || decoded.get("operationId").and_then(Value::as_str) != Some(operation_id)
        {
            return Err(RemoteClientError::invalid_response(
                "remote query returned a mismatched response",
            ));
        }
        let rows = serde_json::from_value(decoded.get("rows").cloned().unwrap_or(Value::Null))
            .map_err(|error| RemoteClientError::invalid_response(error.to_string()))?;
        let max_commit_seq = decoded
            .get("maxCommitSeq")
            .and_then(Value::as_i64)
            .filter(|sequence| (0..=9_007_199_254_740_991).contains(sequence))
            .ok_or_else(|| {
                RemoteClientError::invalid_response(
                    "remote query response has invalid maxCommitSeq",
                )
            })?;
        Ok(RemoteQueryResult {
            rows,
            max_commit_seq,
        })
    }

    pub fn command<T, Input>(
        &self,
        transport: &mut T,
        operation_id: &str,
        request_id: &str,
        input: &Input,
    ) -> Result<RemoteCommandResult, RemoteClientError>
    where
        T: Transport,
        Input: Serialize,
    {
        if operation_id.is_empty() || request_id.is_empty() {
            return Err(RemoteClientError::invalid(
                "remote command id and requestId must be non-empty",
            ));
        }
        let request = json!({
            "revision": protocol_revision(),
            "kind": "command",
            "clientId": self.client_id,
            "operationId": operation_id,
            "requestId": request_id,
            "params": serde_json::to_value(input)
                .map_err(|error| RemoteClientError::invalid(error.to_string()))?,
        });
        let response = transport
            .remote_operation(&encode_operation_value(&request)?)
            .map_err(|error| RemoteClientError::new(error.code, error.message, true))?;
        let decoded = decode_operation_value(&response)?;
        validate_operation_revision(&decoded)?;
        if decoded.get("kind").and_then(Value::as_str) == Some("error") {
            return Err(operation_error(&decoded)?);
        }
        if decoded.get("kind").and_then(Value::as_str) != Some("command")
            || decoded.get("operationId").and_then(Value::as_str) != Some(operation_id)
            || decoded.get("requestId").and_then(Value::as_str) != Some(request_id)
        {
            return Err(RemoteClientError::invalid_response(
                "remote command returned a mismatched response",
            ));
        }
        let status = decoded
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "applied" | "cached" | "rejected"))
            .ok_or_else(|| {
                RemoteClientError::invalid_response("remote command response has invalid status")
            })?;
        let commit_seq = match decoded.get("commitSeq") {
            Some(value) => Some(
                value
                    .as_i64()
                    .filter(|sequence| (1..=9_007_199_254_740_991).contains(sequence))
                    .ok_or_else(|| {
                        RemoteClientError::invalid_response(
                            "remote command response has invalid commitSeq",
                        )
                    })?,
            ),
            None => None,
        };
        Ok(RemoteCommandResult {
            request_id: request_id.to_owned(),
            status: status.to_owned(),
            commit_seq,
            results: decoded
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    RemoteClientError::invalid_response("remote command response lacks results")
                })?,
        })
    }
}

fn protocol_revision() -> Value {
    Value::Number(serde_json::Number::from_f64(1.0).expect("1.0 is finite"))
}

fn encode_tagged(value: &Value) -> Result<Value, RemoteClientError> {
    Ok(match value {
        Value::Null => json!({ "t": "null" }),
        Value::Bool(value) => json!({ "t": "boolean", "v": value }),
        Value::Number(value) if value.is_i64() => {
            json!({ "t": "integer", "v": value.to_string() })
        }
        Value::Number(value) if value.is_u64() => {
            let integer = value.as_u64().expect("guarded above");
            if integer > i64::MAX as u64 {
                return Err(RemoteClientError::invalid(
                    "remote operation integer exceeds signed 64-bit range",
                ));
            }
            json!({ "t": "integer", "v": value.to_string() })
        }
        Value::Number(value) => json!({ "t": "number", "v": value }),
        Value::String(value) => json!({ "t": "string", "v": value }),
        Value::Array(values) => json!({
            "t": "array",
            "v": values.iter().map(encode_tagged).collect::<Result<Vec<_>, _>>()?,
        }),
        Value::Object(values)
            if values.len() == 1
                && values
                    .get("$syncular.bytes")
                    .and_then(Value::as_str)
                    .is_some() =>
        {
            json!({
                "t": "bytes",
                "v": values
                    .get("$syncular.bytes")
                    .and_then(Value::as_str)
                    .expect("guarded above"),
            })
        }
        Value::Object(values) => json!({
            "t": "object",
            "v": values
                .iter()
                .map(|(key, value)| Ok(json!([key, encode_tagged(value)?])))
                .collect::<Result<Vec<Value>, RemoteClientError>>()?,
        }),
    })
}

fn encode_operation_value(value: &Value) -> Result<Vec<u8>, RemoteClientError> {
    serde_json::to_vec(&encode_tagged(value)?)
        .map_err(|error| RemoteClientError::invalid(error.to_string()))
}

fn decode_tagged(value: &Value) -> Result<Value, RemoteClientError> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| RemoteClientError::invalid_response("remote operation value lacks a tag"))?;
    match tag {
        "null" => Ok(Value::Null),
        "boolean" => value
            .get("v")
            .filter(|value| value.is_boolean())
            .cloned()
            .ok_or_else(|| RemoteClientError::invalid_response("remote boolean value is invalid")),
        "number" => value
            .get("v")
            .filter(|value| value.is_number())
            .cloned()
            .ok_or_else(|| RemoteClientError::invalid_response("remote number value is invalid")),
        "string" => value
            .get("v")
            .filter(|value| value.is_string())
            .cloned()
            .ok_or_else(|| RemoteClientError::invalid_response("remote string value is invalid")),
        "integer" => {
            let raw = value.get("v").and_then(Value::as_str).ok_or_else(|| {
                RemoteClientError::invalid_response("remote integer value is invalid")
            })?;
            let number = raw
                .parse::<i64>()
                .map_err(|_| RemoteClientError::invalid_response("remote integer exceeds i64"))?;
            if number.to_string() != raw {
                return Err(RemoteClientError::invalid_response(
                    "remote integer value is not canonical",
                ));
            }
            Ok(json!(number))
        }
        "bytes" => {
            let raw = value.get("v").and_then(Value::as_str).ok_or_else(|| {
                RemoteClientError::invalid_response("remote bytes value is invalid")
            })?;
            Ok(Value::Array(
                base64_decode(raw)?
                    .into_iter()
                    .map(|byte| json!(byte))
                    .collect(),
            ))
        }
        "array" => {
            let values = value.get("v").and_then(Value::as_array).ok_or_else(|| {
                RemoteClientError::invalid_response("remote array value is invalid")
            })?;
            Ok(Value::Array(
                values
                    .iter()
                    .map(decode_tagged)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        "object" => {
            let entries = value.get("v").and_then(Value::as_array).ok_or_else(|| {
                RemoteClientError::invalid_response("remote object value is invalid")
            })?;
            let mut object = Map::new();
            for entry in entries {
                let pair = entry.as_array().ok_or_else(|| {
                    RemoteClientError::invalid_response("remote object entry is invalid")
                })?;
                if pair.len() != 2 {
                    return Err(RemoteClientError::invalid_response(
                        "remote object entry is invalid",
                    ));
                }
                let key = pair.first().and_then(Value::as_str).ok_or_else(|| {
                    RemoteClientError::invalid_response("remote object key is invalid")
                })?;
                let encoded = pair.get(1).ok_or_else(|| {
                    RemoteClientError::invalid_response("remote object entry lacks a value")
                })?;
                if object
                    .insert(key.to_owned(), decode_tagged(encoded)?)
                    .is_some()
                {
                    return Err(RemoteClientError::invalid_response(
                        "remote object contains a duplicate key",
                    ));
                }
            }
            Ok(Value::Object(object))
        }
        _ => Err(RemoteClientError::invalid_response(
            "remote operation value has an unknown tag",
        )),
    }
}

fn decode_operation_value(bytes: &[u8]) -> Result<Value, RemoteClientError> {
    let encoded: Value = serde_json::from_slice(bytes)
        .map_err(|error| RemoteClientError::invalid_response(error.to_string()))?;
    decode_tagged(&encoded)
}

fn validate_operation_revision(value: &Value) -> Result<(), RemoteClientError> {
    if value.get("revision").and_then(Value::as_f64) == Some(1.0) {
        Ok(())
    } else {
        Err(RemoteClientError::invalid_response(
            "remote operation response has an unsupported revision",
        ))
    }
}

fn operation_error(value: &Value) -> Result<RemoteClientError, RemoteClientError> {
    let code = value.get("code").and_then(Value::as_str).ok_or_else(|| {
        RemoteClientError::invalid_response("remote operation error lacks a code")
    })?;
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RemoteClientError::invalid_response("remote operation error lacks a message")
        })?;
    let retryable = value
        .get("retryable")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            RemoteClientError::invalid_response("remote operation error lacks retryable")
        })?;
    Ok(RemoteClientError::new(code, message, retryable))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn base64_decode(text: &str) -> Result<Vec<u8>, RemoteClientError> {
    if !text.len().is_multiple_of(4) {
        return Err(RemoteClientError::invalid_response(
            "remote bytes value is invalid base64",
        ));
    }
    let mut output = Vec::with_capacity((text.len() / 4) * 3);
    for (chunk_index, chunk) in text.as_bytes().chunks(4).enumerate() {
        let last = chunk_index + 1 == text.len() / 4;
        let padding = if chunk[2] == b'=' {
            2
        } else if chunk[3] == b'=' {
            1
        } else {
            0
        };
        if (!last && padding != 0) || (padding == 2 && chunk[3] != b'=') {
            return Err(RemoteClientError::invalid_response(
                "remote bytes value is invalid base64",
            ));
        }
        let mut values = [0_u8; 4];
        for (index, byte) in chunk.iter().copied().enumerate() {
            values[index] = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if index >= 2 => 0,
                _ => {
                    return Err(RemoteClientError::invalid_response(
                        "remote bytes value is invalid base64",
                    ))
                }
            };
        }
        output.push((values[0] << 2) | (values[1] >> 4));
        if padding < 2 {
            output.push((values[1] << 4) | (values[2] >> 2));
        }
        if padding == 0 {
            output.push((values[2] << 6) | values[3]);
        }
    }
    if base64_encode(&output) != text {
        return Err(RemoteClientError::invalid_response(
            "remote bytes value is invalid base64",
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Map, Value};
    use ssp2::model::{Frame, Message, MsgKind, Op, OpResult, PushStatus};
    use ssp2::{decode_message, encode_message};

    use super::{
        decode_operation_value, encode_operation_value, RemoteBytes, RemoteCommitInput,
        SyncRemoteClient,
    };
    use crate::api::Mutation;
    use crate::schema::{compile_schema, ColumnIr, SchemaIr, ScopePatternIr, TableIr};
    use crate::transport::{SegmentRequest, Transport, TransportError};

    struct CachedTransport {
        requests: Vec<Vec<u8>>,
        operation_response: Option<Vec<u8>>,
    }

    impl Transport for CachedTransport {
        fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.requests.push(request.to_vec());
            Ok(encode_message(&Message {
                wire_version: 1,
                msg_kind: MsgKind::Response,
                frames: vec![
                    Frame::RespHeader {
                        required_schema_version: None,
                        latest_schema_version: None,
                        log_epoch: None,
                        reset_required: None,
                    },
                    Frame::PushResult {
                        client_commit_id: "job-1".to_owned(),
                        status: PushStatus::Cached,
                        commit_seq: Some(7),
                        results: vec![OpResult::Applied { op_index: 0 }],
                    },
                ],
            }))
        }

        fn remote_operation(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.requests.push(request.to_vec());
            self.operation_response
                .clone()
                .ok_or_else(|| TransportError::new("unused", "unused"))
        }

        fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("unused", "unused"))
        }

        fn download_segment(
            &mut self,
            _request: &SegmentRequest,
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("unused", "unused"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Err(TransportError::new("unused", "unused"))
        }

        fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
            Err(TransportError::new("unused", "unused"))
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn schema() -> crate::schema::ClientSchema {
        compile_schema(&SchemaIr {
            version: 1,
            tables: vec![TableIr {
                name: "tasks".to_owned(),
                columns: vec![
                    ColumnIr {
                        name: "id".to_owned(),
                        column_type: "string".to_owned(),
                        nullable: false,
                        encrypted: false,
                        declared_type: None,
                    },
                    ColumnIr {
                        name: "project_id".to_owned(),
                        column_type: "string".to_owned(),
                        nullable: false,
                        encrypted: false,
                        declared_type: None,
                    },
                ],
                primary_key: "id".to_owned(),
                scopes: vec![ScopePatternIr {
                    pattern: "project:{project_id}".to_owned(),
                    column: None,
                }],
                indexes: Vec::new(),
                fts_indexes: Vec::new(),
            }],
        })
        .expect("schema compiles")
    }

    #[test]
    fn prepares_push_only_bytes_and_reuses_them_for_retry() {
        let client = SyncRemoteClient::new(schema(), "worker").expect("client");
        let prepared = client
            .prepare_commit(RemoteCommitInput {
                request_id: "job-1".to_owned(),
                mutations: vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), json!("task-1")),
                        ("projectId".to_owned(), json!("project-1")),
                    ]),
                    base_version: None,
                }],
            })
            .expect("prepare");
        let request = decode_message(&prepared.bytes).expect("request decodes");
        assert!(matches!(
            request.frames.as_slice(),
            [
                Frame::ReqHeader { .. },
                Frame::PushCommit { operations, .. }
            ] if operations.len() == 1 && operations[0].op == Op::Upsert
        ));

        let mut transport = CachedTransport {
            requests: Vec::new(),
            operation_response: None,
        };
        let first = client
            .send_commit(&mut transport, &prepared)
            .expect("first response");
        let second = client
            .send_commit(&mut transport, &prepared)
            .expect("retry response");
        assert_eq!(first.status, PushStatus::Cached);
        assert_eq!(second.commit_seq, Some(7));
        assert_eq!(
            transport.requests,
            vec![prepared.bytes.clone(), prepared.bytes]
        );
    }

    #[derive(Debug, Serialize)]
    struct QueryParams {
        project_id: String,
        digest: RemoteBytes,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct QueryRow {
        id: String,
        digest: Vec<u8>,
    }

    #[test]
    fn encodes_query_parameters_and_decodes_binary_rows() {
        let client = SyncRemoteClient::new(schema(), "worker").expect("client");
        let response = json!({
            "revision": super::protocol_revision(),
            "kind": "query",
            "operationId": "tasks/by-project",
            "rows": [{
                "id": "task-1",
                "digest": { "$syncular.bytes": "AAEC/w==" },
            }],
            "maxCommitSeq": 9,
        });
        let mut transport = CachedTransport {
            requests: Vec::new(),
            operation_response: Some(encode_operation_value(&response).expect("response")),
        };

        let result = client
            .query::<_, _, QueryRow>(
                &mut transport,
                "tasks/by-project",
                &QueryParams {
                    project_id: "project-1".to_owned(),
                    digest: RemoteBytes(vec![0, 1, 2, 255]),
                },
            )
            .expect("query");

        assert_eq!(
            result.rows,
            vec![QueryRow {
                id: "task-1".to_owned(),
                digest: vec![0, 1, 2, 255],
            }]
        );
        assert_eq!(result.max_commit_seq, 9);
        assert_eq!(
            decode_operation_value(&transport.requests[0]).expect("request")["params"]["digest"],
            json!([0, 1, 2, 255])
        );
        assert!(String::from_utf8(transport.requests[0].clone())
            .expect("utf8")
            .contains("\"t\":\"bytes\""));
    }

    #[test]
    fn rejects_invalid_operation_revision_and_command_status() {
        let client = SyncRemoteClient::for_operations("worker").expect("client");
        let mut transport = CachedTransport {
            requests: Vec::new(),
            operation_response: Some(
                encode_operation_value(&json!({
                    "revision": 2.0,
                    "kind": "query",
                    "operationId": "tasks/all",
                    "rows": [],
                    "maxCommitSeq": 0,
                }))
                .expect("response"),
            ),
        };

        let revision = client
            .query::<_, _, Value>(&mut transport, "tasks/all", &())
            .expect_err("revision must fail");
        assert_eq!(revision.code, "client.invalid_host_response");

        transport.operation_response = Some(
            encode_operation_value(&json!({
                "revision": super::protocol_revision(),
                "kind": "query",
                "operationId": "tasks/all",
                "rows": [],
                "maxCommitSeq": 9_007_199_254_740_992i64,
            }))
            .expect("response"),
        );
        let sequence = client
            .query::<_, _, Value>(&mut transport, "tasks/all", &())
            .expect_err("unsafe sequence must fail");
        assert_eq!(sequence.code, "client.invalid_host_response");

        transport.operation_response = Some(
            encode_operation_value(&json!({
                "revision": super::protocol_revision(),
                "kind": "command",
                "operationId": "tasks/complete",
                "requestId": "request-1",
                "status": "unknown",
                "results": [],
            }))
            .expect("response"),
        );
        let status = client
            .command(&mut transport, "tasks/complete", "request-1", &())
            .expect_err("status must fail");
        assert_eq!(status.code, "client.invalid_host_response");

        transport.operation_response = Some(
            encode_operation_value(&json!({
                "revision": super::protocol_revision(),
                "kind": "command",
                "operationId": "tasks/complete",
                "requestId": "request-1",
                "status": "applied",
                "commitSeq": 0,
                "results": [],
            }))
            .expect("response"),
        );
        let sequence = client
            .command(&mut transport, "tasks/complete", "request-1", &())
            .expect_err("zero command sequence must fail");
        assert_eq!(sequence.code, "client.invalid_host_response");
    }

    #[test]
    fn rejects_non_portable_integers_and_noncanonical_base64() {
        let integer = encode_operation_value(&json!(u64::MAX))
            .expect_err("unsigned values outside i64 must fail");
        assert_eq!(integer.code, "sync.invalid_request");

        let bytes = decode_operation_value(br#"{"t":"bytes","v":"AB=="}"#)
            .expect_err("noncanonical base64 must fail");
        assert_eq!(bytes.code, "client.invalid_host_response");
    }
}
