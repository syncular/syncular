//! Realtime JSON control messages (SPEC.md §8). Server→client messages use
//! `{"event": …, "data": …}`; the client ack uses `{"type":"ack", …}` (§8.2).
//! Unknown events are tolerated and preserved verbatim (§8.1 forward-compat
//! mirror of the frame-skip rule).

use serde_json::{Map, Value};

use crate::error::{DecodeError, Result};
use crate::primitives::I64_SAFE_MAX;

/// §8.3 wake-up reason codes — the closed three-value set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeReason {
    DeltaTooLarge,
    CatchupRequired,
    ResetRequired,
}

impl WakeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            WakeReason::DeltaTooLarge => "delta-too-large",
            WakeReason::CatchupRequired => "catchup-required",
            WakeReason::ResetRequired => "reset-required",
        }
    }

    pub fn from_reason(s: &str) -> Option<Self> {
        match s {
            "delta-too-large" => Some(WakeReason::DeltaTooLarge),
            "catchup-required" => Some(WakeReason::CatchupRequired),
            "reset-required" => Some(WakeReason::ResetRequired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControlMessage {
    /// §8.1 connect handshake.
    Hello {
        protocol_version: i64,
        session_id: String,
        actor_id: String,
        client_id: String,
        cursor: i64,
        latest_cursor: i64,
        requires_sync: bool,
        timestamp: i64,
    },
    /// §8.3 wake-up (`event = "sync"`).
    Wake {
        cursor: i64,
        requires_pull: bool,
        reason: WakeReason,
        timestamp: i64,
    },
    /// §8.5 heartbeat.
    Heartbeat { timestamp: i64 },
    /// §8.2 client ack — the sole client→server control message.
    Ack { cursor: i64 },
    /// §8.6.2 presence fanout (server→client) or a publisher-directed error.
    Presence {
        scope_key: String,
        /// `join` | `update` | `leave` for a fanout; `None` for an error.
        kind: Option<PresenceKind>,
        actor_id: Option<String>,
        client_id: Option<String>,
        /// The peer's document for join/update; `None`/null for leave.
        doc: Option<Value>,
        /// `presence.too_large` / `presence.forbidden` (§8.6.2), if this is
        /// a publisher-directed error variant.
        error: Option<String>,
        timestamp: Option<i64>,
    },
    /// Unknown JSON control event, tolerated and preserved (§8.1).
    Unknown(Value),
}

/// §8.6.2 presence fanout kind — a closed set of three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceKind {
    Join,
    Update,
    Leave,
}

impl PresenceKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "join" => Some(Self::Join),
            "update" => Some(Self::Update),
            "leave" => Some(Self::Leave),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Join => "join",
            Self::Update => "update",
            Self::Leave => "leave",
        }
    }
}

fn field<'a>(data: &'a Map<String, Value>, key: &str) -> Result<&'a Value> {
    data.get(key)
        .ok_or_else(|| DecodeError::invalid(format!("control message missing field {key:?}")))
}

fn as_i64(data: &Map<String, Value>, key: &str) -> Result<i64> {
    // Realtime numeric fields are integers within the ±(2^53−1) i64 contract
    // (SPEC.md §8.1); fractional or non-finite numbers are malformed.
    let v = field(data, key)?.as_i64().ok_or_else(|| {
        DecodeError::invalid(format!(
            "control field {key:?} is not an integer within the i64 safe range"
        ))
    })?;
    if !(-I64_SAFE_MAX..=I64_SAFE_MAX).contains(&v) {
        return Err(DecodeError::invalid(format!(
            "control field {key:?} = {v} outside the ±(2^53−1) safe-integer contract"
        )));
    }
    Ok(v)
}

fn as_str(data: &Map<String, Value>, key: &str) -> Result<String> {
    Ok(field(data, key)?
        .as_str()
        .ok_or_else(|| DecodeError::invalid(format!("control field {key:?} is not a string")))?
        .to_owned())
}

fn as_bool(data: &Map<String, Value>, key: &str) -> Result<bool> {
    field(data, key)?
        .as_bool()
        .ok_or_else(|| DecodeError::invalid(format!("control field {key:?} is not a boolean")))
}

/// Parse a JSON control message text frame.
pub fn parse_control(text: &str) -> Result<ControlMessage> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| DecodeError::invalid(format!("control message is not JSON: {e}")))?;
    parse_control_value(&value)
}

pub fn parse_control_value(value: &Value) -> Result<ControlMessage> {
    let root = value
        .as_object()
        .ok_or_else(|| DecodeError::invalid("control message is not a JSON object"))?;

    // Client ack shape: {"type":"ack","cursor":…} (§8.2).
    if root.get("type").and_then(Value::as_str) == Some("ack") {
        return Ok(ControlMessage::Ack {
            cursor: as_i64(root, "cursor")?,
        });
    }

    let Some(event) = root.get("event").and_then(Value::as_str) else {
        return Err(DecodeError::invalid(
            "control message has neither an \"event\" nor a known \"type\"",
        ));
    };
    let data = |what: &str| -> Result<&Map<String, Value>> {
        root.get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| DecodeError::invalid(format!("{what} control message missing data")))
    };
    match event {
        "hello" => {
            let d = data("hello")?;
            Ok(ControlMessage::Hello {
                protocol_version: as_i64(d, "protocolVersion")?,
                session_id: as_str(d, "sessionId")?,
                actor_id: as_str(d, "actorId")?,
                client_id: as_str(d, "clientId")?,
                cursor: as_i64(d, "cursor")?,
                latest_cursor: as_i64(d, "latestCursor")?,
                requires_sync: as_bool(d, "requiresSync")?,
                timestamp: as_i64(d, "timestamp")?,
            })
        }
        "sync" => {
            let d = data("sync")?;
            let reason_raw = as_str(d, "reason")?;
            let reason = WakeReason::from_reason(&reason_raw).ok_or_else(|| {
                DecodeError::invalid(format!("unknown wake-up reason {reason_raw:?}"))
            })?;
            // §8.3: requiresPull MUST be the literal true; anything else is
            // a malformed event.
            if !as_bool(d, "requiresPull")? {
                return Err(DecodeError::invalid(
                    "sync.data.requiresPull must be the literal true",
                ));
            }
            Ok(ControlMessage::Wake {
                cursor: as_i64(d, "cursor")?,
                requires_pull: true,
                reason,
                timestamp: as_i64(d, "timestamp")?,
            })
        }
        "heartbeat" => {
            let d = data("heartbeat")?;
            Ok(ControlMessage::Heartbeat {
                timestamp: as_i64(d, "timestamp")?,
            })
        }
        "presence" => {
            let d = data("presence")?;
            let scope_key = as_str(d, "scopeKey")?;
            if scope_key.is_empty() {
                return Err(DecodeError::invalid(
                    "presence.data.scopeKey must be non-empty",
                ));
            }
            let timestamp = if d.contains_key("timestamp") {
                Some(as_i64(d, "timestamp")?)
            } else {
                None
            };
            if let Some(error) = d.get("error") {
                // §8.6.2 publisher-directed error variant.
                let error = error
                    .as_str()
                    .ok_or_else(|| DecodeError::invalid("presence.data.error must be a string"))?
                    .to_owned();
                return Ok(ControlMessage::Presence {
                    scope_key,
                    kind: None,
                    actor_id: None,
                    client_id: None,
                    doc: None,
                    error: Some(error),
                    timestamp,
                });
            }
            match d.get("kind") {
                Some(kind_val) => {
                    // §8.6.2 fanout.
                    let kind_raw = kind_val.as_str().ok_or_else(|| {
                        DecodeError::invalid("presence.data.kind must be a string")
                    })?;
                    let kind = PresenceKind::from_str(kind_raw).ok_or_else(|| {
                        DecodeError::invalid(format!("unknown presence kind {kind_raw:?}"))
                    })?;
                    let actor_id = as_str(d, "actorId")?;
                    let client_id = as_str(d, "clientId")?;
                    let doc = d.get("doc").cloned();
                    // §8.6.2 doc-present-iff-not-leave.
                    match kind {
                        PresenceKind::Leave => {
                            if matches!(doc, Some(Value::Object(_))) {
                                return Err(DecodeError::invalid(
                                    "presence leave must carry doc: null",
                                ));
                            }
                        }
                        _ => {
                            if !matches!(doc, Some(Value::Object(_))) {
                                return Err(DecodeError::invalid(
                                    "presence.data.doc must be a JSON object",
                                ));
                            }
                        }
                    }
                    Ok(ControlMessage::Presence {
                        scope_key,
                        kind: Some(kind),
                        actor_id: Some(actor_id),
                        client_id: Some(client_id),
                        doc,
                        error: None,
                        timestamp,
                    })
                }
                None => {
                    // Client→server publish/leave: scopeKey + doc (object or null).
                    let doc = d.get("doc").cloned();
                    if !matches!(doc, None | Some(Value::Null) | Some(Value::Object(_))) {
                        return Err(DecodeError::invalid(
                            "presence.data.doc must be a JSON object or null",
                        ));
                    }
                    Ok(ControlMessage::Presence {
                        scope_key,
                        kind: None,
                        actor_id: None,
                        client_id: None,
                        doc,
                        error: None,
                        timestamp,
                    })
                }
            }
        }
        _ => Ok(ControlMessage::Unknown(value.clone())),
    }
}

/// §8.6.2 serialize a client→server presence publish/leave.
pub fn encode_presence_publish(scope_key: &str, doc: Option<&Value>) -> String {
    let mut d = Map::new();
    d.insert("scopeKey".to_string(), Value::from(scope_key));
    d.insert("doc".to_string(), doc.cloned().unwrap_or(Value::Null));
    let mut root = Map::new();
    root.insert("event".to_string(), Value::from("presence"));
    root.insert("data".to_string(), Value::Object(d));
    Value::Object(root).to_string()
}

/// Render a control message back to its JSON form.
pub fn render_control(msg: &ControlMessage) -> Value {
    fn envelope(event: &str, data: Vec<(&str, Value)>) -> Value {
        let mut d = Map::new();
        for (k, v) in data {
            d.insert(k.to_string(), v);
        }
        let mut root = Map::new();
        root.insert("event".to_string(), Value::from(event));
        root.insert("data".to_string(), Value::Object(d));
        Value::Object(root)
    }
    match msg {
        ControlMessage::Hello {
            protocol_version,
            session_id,
            actor_id,
            client_id,
            cursor,
            latest_cursor,
            requires_sync,
            timestamp,
        } => envelope(
            "hello",
            vec![
                ("protocolVersion", Value::from(*protocol_version)),
                ("sessionId", Value::from(session_id.clone())),
                ("actorId", Value::from(actor_id.clone())),
                ("clientId", Value::from(client_id.clone())),
                ("cursor", Value::from(*cursor)),
                ("latestCursor", Value::from(*latest_cursor)),
                ("requiresSync", Value::from(*requires_sync)),
                ("timestamp", Value::from(*timestamp)),
            ],
        ),
        ControlMessage::Wake {
            cursor,
            requires_pull,
            reason,
            timestamp,
        } => envelope(
            "sync",
            vec![
                ("cursor", Value::from(*cursor)),
                ("requiresPull", Value::from(*requires_pull)),
                ("reason", Value::from(reason.as_str())),
                ("timestamp", Value::from(*timestamp)),
            ],
        ),
        ControlMessage::Heartbeat { timestamp } => {
            envelope("heartbeat", vec![("timestamp", Value::from(*timestamp))])
        }
        ControlMessage::Ack { cursor } => {
            let mut root = Map::new();
            root.insert("type".to_string(), Value::from("ack"));
            root.insert("cursor".to_string(), Value::from(*cursor));
            Value::Object(root)
        }
        ControlMessage::Presence {
            scope_key,
            kind,
            actor_id,
            client_id,
            doc,
            error,
            timestamp,
        } => {
            // Field order matches the §8.6.2 wire shape so re-encoding a
            // parsed fanout round-trips byte-for-byte with the vectors.
            let mut d = Map::new();
            d.insert("scopeKey".to_string(), Value::from(scope_key.clone()));
            if let Some(error) = error {
                d.insert("error".to_string(), Value::from(error.clone()));
            } else if let Some(kind) = kind {
                d.insert("kind".to_string(), Value::from(kind.as_str()));
                if let Some(actor_id) = actor_id {
                    d.insert("actorId".to_string(), Value::from(actor_id.clone()));
                }
                if let Some(client_id) = client_id {
                    d.insert("clientId".to_string(), Value::from(client_id.clone()));
                }
                d.insert("doc".to_string(), doc.clone().unwrap_or(Value::Null));
            } else {
                // Client→server publish/leave.
                d.insert("doc".to_string(), doc.clone().unwrap_or(Value::Null));
            }
            if let Some(timestamp) = timestamp {
                d.insert("timestamp".to_string(), Value::from(*timestamp));
            }
            let mut root = Map::new();
            root.insert("event".to_string(), Value::from("presence"));
            root.insert("data".to_string(), Value::Object(d));
            Value::Object(root)
        }
        ControlMessage::Unknown(v) => v.clone(),
    }
}
