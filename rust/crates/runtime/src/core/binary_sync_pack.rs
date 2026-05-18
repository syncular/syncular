use crate::binary_snapshot::decode_binary_snapshot_table;
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
const VERSION: u16 = 7;
const FLAG_NONE: u16 = 0;

struct PendingBinaryChangeRowRef {
    change_index: usize,
    table: String,
    group_index: usize,
    row_index: usize,
}

pub fn is_binary_sync_pack_content_type(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim() == SYNC_PACK_CONTENT_TYPE)
}

pub fn decode_binary_sync_pack(bytes: &[u8]) -> Result<CombinedResponse> {
    let mut reader = BinarySyncPackReader::new(bytes);
    reader.expect_magic(MAGIC, "binary sync pack")?;

    let version = reader.read_u16("binary sync pack version")?;
    if version != VERSION {
        return Err(SyncularError::protocol_message(format!(
            "unsupported binary sync pack version: {version}"
        )));
    }
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
        changes: read_changes_v7(reader)?,
    })
}

fn read_changes_v7(reader: &mut BinarySyncPackReader<'_>) -> Result<Vec<SyncChange>> {
    let table_names = reader.read_array("commit change table dictionary", |reader| {
        reader.read_string16("commit change table")
    })?;
    let scope_values_by_index = reader.read_array("commit change scope dictionary", |reader| {
        reader.read_string_map("commit change scopes")
    })?;
    let change_count = reader.read_u32("commit changes length")? as usize;
    let mut changes = Vec::with_capacity(change_count);
    let mut row_refs = Vec::new();
    for change_index in 0..change_count {
        changes.push(read_change_metadata_v7(
            reader,
            change_index,
            &table_names,
            &scope_values_by_index,
            &mut row_refs,
        )?);
    }

    let group_count = reader.read_u32("binary change row group count")? as usize;
    let mut group_rows = Vec::with_capacity(group_count);
    for _ in 0..group_count {
        let table = table_name_at(
            &table_names,
            reader.read_u16("binary change row group table index")? as usize,
        )?;
        let payload = reader.read_bytes32("binary change row group payload")?;
        let decoded = decode_binary_snapshot_table(&payload)?;
        if decoded.table != table {
            return Err(SyncularError::protocol_message(format!(
                "binary sync pack row group table mismatch: expected {table}, got {}",
                decoded.table
            )));
        }
        group_rows.push(decoded.rows.into_iter().map(Some).collect::<Vec<_>>());
    }

    for row_ref in row_refs {
        let Some(rows) = group_rows.get_mut(row_ref.group_index) else {
            return Err(SyncularError::protocol_message(format!(
                "binary sync pack change row ref has invalid group index: {}",
                row_ref.group_index
            )));
        };
        let Some(row) = rows.get_mut(row_ref.row_index) else {
            return Err(SyncularError::protocol_message(format!(
                "binary sync pack change row ref has invalid row index: group={}, row={}",
                row_ref.group_index, row_ref.row_index
            )));
        };
        let Some(row) = row.take() else {
            return Err(SyncularError::protocol_message(format!(
                "binary sync pack change row ref was already consumed: group={}, row={}",
                row_ref.group_index, row_ref.row_index
            )));
        };
        let Some(change) = changes.get_mut(row_ref.change_index) else {
            return Err(SyncularError::protocol_message(format!(
                "binary sync pack change row ref has invalid change index: {}",
                row_ref.change_index
            )));
        };
        if change.table != row_ref.table {
            return Err(SyncularError::protocol_message(
                "binary sync pack row ref table mismatch",
            ));
        }
        change.row_json = Some(Value::Object(row));
    }

    Ok(changes)
}

fn read_change_metadata_v7(
    reader: &mut BinarySyncPackReader<'_>,
    change_index: usize,
    table_names: &[String],
    scope_values_by_index: &[Map<String, Value>],
    row_refs: &mut Vec<PendingBinaryChangeRowRef>,
) -> Result<SyncChange> {
    let table = table_name_at(table_names, reader.read_u16("change table index")? as usize)?;
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
    let row_json = match reader.read_u8("change row payload kind")? {
        0 => None,
        1 => Some(reader.read_json("change row json")?),
        2 => {
            row_refs.push(PendingBinaryChangeRowRef {
                change_index,
                table: table.clone(),
                group_index: reader.read_u32("change row group index")? as usize,
                row_index: reader.read_u32("change row group row index")? as usize,
            });
            None
        }
        value => {
            return Err(SyncularError::protocol_message(format!(
                "unsupported binary sync pack change row payload kind: {value}"
            )));
        }
    };
    Ok(SyncChange {
        table,
        row_id,
        op,
        row_json,
        row_version: reader.read_optional_i64("change row version")?,
        scopes: scope_values_at(
            scope_values_by_index,
            reader.read_u32("change scopes index")? as usize,
        )?,
    })
}

fn table_name_at(table_names: &[String], index: usize) -> Result<String> {
    table_names.get(index).cloned().ok_or_else(|| {
        SyncularError::protocol_message(format!("binary sync pack table index is invalid: {index}"))
    })
}

fn scope_values_at(
    scope_values_by_index: &[Map<String, Value>],
    index: usize,
) -> Result<Map<String, Value>> {
    scope_values_by_index.get(index).cloned().ok_or_else(|| {
        SyncularError::protocol_message(format!("binary sync pack scope index is invalid: {index}"))
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
    Ok(SnapshotChunkRef {
        id,
        byte_length,
        sha256,
        encoding,
        compression,
    })
}

struct BinarySyncPackReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BinarySyncPackReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
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

#[cfg(test)]
mod tests {
    use super::decode_binary_sync_pack;

    #[test]
    fn decodes_v7_table_and_scope_dictionary_changes() {
        let bytes = [
            83, 83, 80, 49, 7, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 21, 0, 0, 0, 95, 95, 115,
            121, 110, 99, 117, 108, 97, 114, 95, 114, 101, 97, 108, 116, 105, 109, 101, 95, 95, 6,
            0, 97, 99, 116, 105, 118, 101, 2, 0, 0, 0, 123, 125, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1,
            0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 50, 48, 50, 54, 45, 48, 53, 45, 49, 56,
            84, 48, 48, 58, 48, 48, 58, 48, 48, 46, 48, 48, 48, 90, 6, 0, 0, 0, 117, 115, 101, 114,
            45, 97, 1, 0, 0, 0, 5, 0, 116, 97, 115, 107, 115, 1, 0, 0, 0, 1, 0, 0, 0, 7, 0, 117,
            115, 101, 114, 95, 105, 100, 6, 0, 0, 0, 117, 115, 101, 114, 45, 49, 1, 0, 0, 0, 0, 0,
            6, 0, 0, 0, 116, 97, 115, 107, 45, 49, 1, 1, 59, 0, 0, 0, 123, 34, 105, 100, 34, 58,
            34, 116, 97, 115, 107, 45, 49, 34, 44, 34, 116, 105, 116, 108, 101, 34, 58, 34, 65, 34,
            44, 34, 115, 101, 114, 118, 101, 114, 95, 118, 101, 114, 115, 105, 111, 110, 34, 58,
            49, 44, 34, 100, 111, 110, 101, 34, 58, 102, 97, 108, 115, 101, 125, 1, 1, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        let response = decode_binary_sync_pack(&bytes).unwrap();
        let pull = response.pull.unwrap();
        let change = &pull.subscriptions[0].commits[0].changes[0];
        assert_eq!(change.table, "tasks");
        assert_eq!(change.row_id, "task-1");
        assert_eq!(
            change.row_json.as_ref().unwrap()["title"].as_str(),
            Some("A")
        );
    }
}
