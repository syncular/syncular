use crate::error::{Result, SyncularError};
use crate::protocol::{
    CombinedResponse, OperationResult, PullResponse, PushBatchResponse, PushCommitResponse,
    SnapshotChunkRef, SubscriptionResponse, SyncChange, SyncCommit, SyncSnapshot,
};
use serde_json::{Map, Value};

pub const SYNC_PACK_ENCODING_JSON_V1: &str = "json-v1";
pub const SYNC_PACK_ENCODING_BINARY_V1: &str = "binary-sync-pack-v1";
pub const SYNC_PACK_CONTENT_TYPE: &str = "application/vnd.syncular.sync-pack.v1";

const MAGIC: &[u8; 4] = b"SSP1";
const VERSION: u16 = 3;
const FLAG_NONE: u16 = 0;

pub fn is_binary_sync_pack_content_type(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim() == SYNC_PACK_CONTENT_TYPE)
}

pub fn decode_binary_sync_pack(bytes: &[u8]) -> Result<CombinedResponse> {
    let mut reader = BinarySyncPackReader::new(bytes);
    reader.expect_magic(MAGIC, "binary sync pack")?;

    let version = reader.read_u16("binary sync pack version")?;
    if !(1..=VERSION).contains(&version) {
        return Err(SyncularError::protocol_message(format!(
            "unsupported binary sync pack version: {version}"
        )));
    }
    reader.version = version;
    let flags = reader.read_u16("binary sync pack flags")?;
    if flags != FLAG_NONE {
        return Err(SyncularError::protocol_message(format!(
            "unsupported binary sync pack flags: {flags}"
        )));
    }

    let response = CombinedResponse {
        ok: reader.read_bool("combined response ok")?,
        required_schema_version: reader.read_optional_i32("required schema version")?,
        latest_schema_version: reader.read_optional_i32("latest schema version")?,
        push: reader.read_optional_value(read_push_response)?,
        pull: reader.read_optional_value(read_pull_response)?,
    };
    reader.assert_done()?;
    Ok(response)
}

fn read_push_response(reader: &mut BinarySyncPackReader<'_>) -> Result<PushBatchResponse> {
    Ok(PushBatchResponse {
        ok: reader.read_bool("push response ok")?,
        commits: reader.read_array("push commits", read_push_commit_response)?,
    })
}

fn read_push_commit_response(reader: &mut BinarySyncPackReader<'_>) -> Result<PushCommitResponse> {
    let _ok = reader.read_bool("push commit ok")?;
    Ok(PushCommitResponse {
        client_commit_id: reader.read_string32("push client commit id")?,
        status: reader.read_string16("push commit status")?,
        commit_seq: reader.read_optional_i64("push commit seq")?,
        results: reader.read_array("push operation results", read_operation_result)?,
    })
}

fn read_operation_result(reader: &mut BinarySyncPackReader<'_>) -> Result<OperationResult> {
    Ok(OperationResult {
        op_index: reader.read_i32("operation result index")?,
        status: reader.read_string16("operation result status")?,
        message: reader.read_optional_string32("operation result message")?,
        error: reader.read_optional_string32("operation result error")?,
        code: reader.read_optional_string32("operation result code")?,
        retriable: reader.read_optional_bool("operation result retriable")?,
        server_version: reader.read_optional_i64("operation result server version")?,
        server_row: reader.read_optional_json("operation result server row")?,
    })
}

fn read_pull_response(reader: &mut BinarySyncPackReader<'_>) -> Result<PullResponse> {
    Ok(PullResponse {
        ok: reader.read_bool("pull response ok")?,
        subscriptions: reader.read_array("pull subscriptions", read_subscription_response)?,
    })
}

fn read_subscription_response(
    reader: &mut BinarySyncPackReader<'_>,
) -> Result<SubscriptionResponse> {
    let id = reader.read_string32("subscription id")?;
    let status = reader.read_string16("subscription status")?;
    let scopes = reader.read_json_map("subscription scopes")?;
    let bootstrap = reader.read_bool("subscription bootstrap")?;
    let bootstrap_state = reader
        .read_optional_json("subscription bootstrap state")?
        .map(serde_json::from_value)
        .transpose()?;
    let next_cursor = reader.read_i64("subscription next cursor")?;
    let commits = reader.read_array("subscription commits", read_commit)?;
    let snapshots = reader.read_optional_array("subscription snapshots", read_snapshot)?;
    Ok(SubscriptionResponse {
        id,
        status,
        scopes,
        bootstrap,
        bootstrap_state,
        next_cursor,
        commits,
        snapshots,
    })
}

fn read_commit(reader: &mut BinarySyncPackReader<'_>) -> Result<SyncCommit> {
    Ok(SyncCommit {
        commit_seq: reader.read_i64("commit seq")?,
        created_at: reader.read_string32("commit createdAt")?,
        actor_id: reader.read_string32("commit actorId")?,
        changes: reader.read_array("commit changes", read_change)?,
    })
}

fn read_change(reader: &mut BinarySyncPackReader<'_>) -> Result<SyncChange> {
    if reader.version < 3 {
        return Ok(SyncChange {
            table: reader.read_string16("change table")?,
            row_id: reader.read_string32("change row id")?,
            op: reader.read_string16("change op")?,
            row_json: reader.read_optional_json("change row json")?,
            row_version: reader.read_optional_i64("change row version")?,
            scopes: reader.read_json_map("change scopes")?,
        });
    }
    let table = reader.read_string16("change table")?;
    let row_id = reader.read_string32("change row id")?;
    let op = match reader.read_u8("change op")? {
        1 => "upsert".to_string(),
        2 => "delete".to_string(),
        value => {
            return Err(SyncularError::protocol_message(format!(
                "unsupported binary sync pack change op byte: {value}"
            )));
        }
    };
    Ok(SyncChange {
        table,
        row_id,
        op,
        row_json: reader.read_optional_json("change row json")?,
        row_version: reader.read_optional_i64("change row version")?,
        scopes: reader.read_string_map("change scopes")?,
    })
}

fn read_snapshot(reader: &mut BinarySyncPackReader<'_>) -> Result<SyncSnapshot> {
    Ok(SyncSnapshot {
        table: reader.read_string16("snapshot table")?,
        rows: reader.read_array("snapshot rows", |reader| reader.read_json("snapshot row"))?,
        chunks: reader.read_optional_array("snapshot chunks", read_snapshot_chunk_ref)?,
        is_first_page: reader.read_bool("snapshot first page")?,
        is_last_page: reader.read_bool("snapshot last page")?,
    })
}

fn read_snapshot_chunk_ref(reader: &mut BinarySyncPackReader<'_>) -> Result<SnapshotChunkRef> {
    let id = reader.read_string32("snapshot chunk id")?;
    let byte_length = reader.read_i64("snapshot chunk byte length")?;
    let sha256 = reader.read_string16("snapshot chunk sha256")?;
    let encoding = reader.read_string16("snapshot chunk encoding")?;
    let compression = reader.read_string16("snapshot chunk compression")?;
    let body = if reader.version >= 2 {
        reader.read_optional_bytes32("snapshot chunk body")?
    } else {
        None
    };
    Ok(SnapshotChunkRef {
        id,
        byte_length,
        sha256,
        encoding,
        compression,
        body,
    })
}

struct BinarySyncPackReader<'a> {
    bytes: &'a [u8],
    offset: usize,
    version: u16,
}

impl<'a> BinarySyncPackReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            version: 1,
        }
    }

    fn expect_magic(&mut self, magic: &[u8], label: &str) -> Result<()> {
        let actual = self.read_bytes(magic.len(), &format!("{label} magic"))?;
        if actual != magic {
            return Err(SyncularError::protocol_message(format!(
                "unexpected {label} magic"
            )));
        }
        Ok(())
    }

    fn read_bool(&mut self, label: &str) -> Result<bool> {
        match self.read_u8(label)? {
            0 => Ok(false),
            1 => Ok(true),
            value => Err(SyncularError::protocol_message(format!(
                "{label} expected boolean byte, got {value}"
            ))),
        }
    }

    fn read_optional_bool(&mut self, label: &str) -> Result<Option<bool>> {
        self.read_optional_value(|reader| reader.read_bool(label))
    }

    fn read_u8(&mut self, label: &str) -> Result<u8> {
        self.require(1, label)?;
        let value = self.bytes[self.offset];
        self.offset += 1;
        Ok(value)
    }

    fn read_u16(&mut self, label: &str) -> Result<u16> {
        let bytes = self.read_array_bytes::<2>(label)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self, label: &str) -> Result<u32> {
        let bytes = self.read_array_bytes::<4>(label)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_i32(&mut self, label: &str) -> Result<i32> {
        let bytes = self.read_array_bytes::<4>(label)?;
        Ok(i32::from_le_bytes(bytes))
    }

    fn read_optional_i32(&mut self, label: &str) -> Result<Option<i32>> {
        self.read_optional_value(|reader| reader.read_i32(label))
    }

    fn read_i64(&mut self, label: &str) -> Result<i64> {
        let bytes = self.read_array_bytes::<8>(label)?;
        Ok(i64::from_le_bytes(bytes))
    }

    fn read_optional_i64(&mut self, label: &str) -> Result<Option<i64>> {
        self.read_optional_value(|reader| reader.read_i64(label))
    }

    fn read_string16(&mut self, label: &str) -> Result<String> {
        let length = self.read_u16(&format!("{label} length"))? as usize;
        self.read_string(length, label)
    }

    fn read_string32(&mut self, label: &str) -> Result<String> {
        let length = self.read_u32(&format!("{label} length"))? as usize;
        self.read_string(length, label)
    }

    fn read_optional_string32(&mut self, label: &str) -> Result<Option<String>> {
        self.read_optional_value(|reader| reader.read_string32(label))
    }

    fn read_bytes32(&mut self, label: &str) -> Result<Vec<u8>> {
        let length = self.read_u32(&format!("{label} length"))? as usize;
        Ok(self.read_bytes(length, label)?.to_vec())
    }

    fn read_optional_bytes32(&mut self, label: &str) -> Result<Option<Vec<u8>>> {
        self.read_optional_value(|reader| reader.read_bytes32(label))
    }

    fn read_json(&mut self, label: &str) -> Result<Value> {
        Ok(serde_json::from_str(&self.read_string32(label)?)?)
    }

    fn read_optional_json(&mut self, label: &str) -> Result<Option<Value>> {
        self.read_optional_value(|reader| reader.read_json(label))
    }

    fn read_json_map(&mut self, label: &str) -> Result<Map<String, Value>> {
        match self.read_json(label)? {
            Value::Object(map) => Ok(map),
            _ => Err(SyncularError::protocol_message(format!(
                "{label} expected JSON object"
            ))),
        }
    }

    fn read_string_map(&mut self, label: &str) -> Result<Map<String, Value>> {
        let length = self.read_u32(&format!("{label} length"))? as usize;
        let mut map = Map::with_capacity(length);
        for _ in 0..length {
            let key = self.read_string16(&format!("{label} key"))?;
            let value = self.read_string32(&format!("{label} value"))?;
            map.insert(key, Value::String(value));
        }
        Ok(map)
    }

    fn read_array<T>(
        &mut self,
        label: &str,
        mut read: impl FnMut(&mut Self) -> Result<T>,
    ) -> Result<Vec<T>> {
        let length = self.read_u32(&format!("{label} length"))? as usize;
        let mut values = Vec::with_capacity(length);
        for _ in 0..length {
            values.push(read(self)?);
        }
        Ok(values)
    }

    fn read_optional_array<T>(
        &mut self,
        label: &str,
        mut read: impl FnMut(&mut Self) -> Result<T>,
    ) -> Result<Option<Vec<T>>> {
        self.read_optional_value(|reader| reader.read_array(label, &mut read))
    }

    fn read_optional_value<T>(
        &mut self,
        read: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<Option<T>> {
        match self.read_u8("optional value present")? {
            0 => Ok(None),
            1 => read(self).map(Some),
            value => Err(SyncularError::protocol_message(format!(
                "optional value marker must be 0 or 1, got {value}"
            ))),
        }
    }

    fn read_string(&mut self, length: usize, label: &str) -> Result<String> {
        String::from_utf8(self.read_bytes(length, label)?.to_vec()).map_err(|err| {
            SyncularError::protocol_message(format!("{label} is not valid UTF-8: {err}"))
        })
    }

    fn read_array_bytes<const N: usize>(&mut self, label: &str) -> Result<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.read_bytes(N, label)?);
        Ok(out)
    }

    fn read_bytes(&mut self, length: usize, label: &str) -> Result<&'a [u8]> {
        self.require(length, label)?;
        let value = &self.bytes[self.offset..self.offset + length];
        self.offset += length;
        Ok(value)
    }

    fn assert_done(&self) -> Result<()> {
        if self.offset != self.bytes.len() {
            return Err(SyncularError::protocol_message(
                "binary sync pack has trailing bytes",
            ));
        }
        Ok(())
    }

    fn require(&self, length: usize, label: &str) -> Result<()> {
        if self.offset + length > self.bytes.len() {
            return Err(SyncularError::protocol_message(format!(
                "{label} exceeds binary sync pack bounds"
            )));
        }
        Ok(())
    }
}
