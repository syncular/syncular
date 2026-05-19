use crate::error::{ProtocolError, Result};
use crate::{
    CombinedResponse, OperationResult, PullResponse, PushBatchResponse, PushCommitResponse,
    SnapshotChunkRef, SubscriptionIntegrity, SubscriptionResponse, SyncChange, SyncCommit,
    SyncSnapshot, BINARY_SYNC_PACK_WIRE_VERSION,
};
use serde_json::{Map, Value};

pub use crate::{SYNC_PACK_CONTENT_TYPE, SYNC_PACK_ENCODING_BINARY_V1, SYNC_PACK_ENCODING_JSON_V1};

const MAGIC: &[u8; 4] = b"SSP1";
const VERSION: u16 = BINARY_SYNC_PACK_WIRE_VERSION;
const FLAG_NONE: u16 = 0;
const BINARY_SNAPSHOT_MAGIC: &[u8; 4] = b"SBT1";
const BINARY_SNAPSHOT_VERSION: u16 = 1;
const BINARY_SNAPSHOT_COLUMN_FLAG_NULLABLE: u8 = 1;

struct PendingBinaryChangeRowRef {
    change_index: usize,
    table: String,
    group_index: usize,
    row_index: usize,
}

struct DecodedSyncPackBinarySnapshotTable {
    table: String,
    rows: Vec<Map<String, Value>>,
}

struct SyncPackBinarySnapshotColumn {
    name: String,
    column_type: SyncPackBinarySnapshotColumnType,
    nullable: bool,
}

#[derive(Clone, Copy)]
enum SyncPackBinarySnapshotColumnType {
    String,
    Integer,
    Float,
    Boolean,
    Json,
    Bytes,
}

impl SyncPackBinarySnapshotColumnType {
    fn from_tag(tag: u8) -> Result<Self> {
        match tag {
            1 => Ok(Self::String),
            2 => Ok(Self::Integer),
            3 => Ok(Self::Float),
            4 => Ok(Self::Boolean),
            5 => Ok(Self::Json),
            6 => Ok(Self::Bytes),
            _ => Err(ProtocolError::message(format!(
                "unsupported binary snapshot type tag: {tag}"
            ))),
        }
    }
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
        return Err(ProtocolError::message(format!(
            "unsupported binary sync pack version: {version}"
        )));
    }
    let flags = reader.read_u16("binary sync pack flags")?;
    if flags != FLAG_NONE {
        return Err(ProtocolError::message(format!(
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
        status: read_push_commit_status(reader)?,
        commit_seq: reader.read_optional_i64("push commit seq")?,
        results: reader.read_array("push operation results", read_operation_result)?,
    })
}

fn read_operation_result(reader: &mut BinarySyncPackReader<'_>) -> Result<OperationResult> {
    let op_index = reader.read_i32("operation result index")?;
    let status = reader.read_u8("operation result status")?;
    match status {
        1 => Ok(OperationResult {
            op_index,
            status: "applied".to_string(),
            message: None,
            error: None,
            code: None,
            retriable: None,
            server_version: None,
            server_row: None,
        }),
        2 => Ok(OperationResult {
            op_index,
            status: "conflict".to_string(),
            message: Some(reader.read_string32("operation result conflict message")?),
            error: None,
            code: reader.read_optional_string32("operation result conflict code")?,
            retriable: None,
            server_version: Some(reader.read_i64("operation result conflict server version")?),
            server_row: Some(reader.read_json("operation result conflict server row")?),
        }),
        3 => Ok(OperationResult {
            op_index,
            status: "error".to_string(),
            message: None,
            error: Some(reader.read_string32("operation result error message")?),
            code: reader.read_optional_string32("operation result error code")?,
            retriable: reader.read_optional_bool("operation result error retriable")?,
            server_version: None,
            server_row: None,
        }),
        value => Err(ProtocolError::message(format!(
            "unsupported binary sync pack operation result status byte: {value}"
        ))),
    }
}

fn read_push_commit_status(reader: &mut BinarySyncPackReader<'_>) -> Result<String> {
    match reader.read_u8("push commit status")? {
        1 => Ok("applied".to_string()),
        2 => Ok("cached".to_string()),
        3 => Ok("rejected".to_string()),
        value => Err(ProtocolError::message(format!(
            "unsupported binary sync pack push commit status byte: {value}"
        ))),
    }
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
    let integrity = reader.read_optional_value(read_subscription_integrity)?;
    let commits = reader.read_array("subscription commits", read_commit)?;
    let snapshots = reader.read_optional_array("subscription snapshots", read_snapshot)?;
    Ok(SubscriptionResponse {
        id,
        status,
        scopes,
        bootstrap,
        bootstrap_state,
        next_cursor,
        integrity,
        commits,
        snapshots,
    })
}

fn read_subscription_integrity(
    reader: &mut BinarySyncPackReader<'_>,
) -> Result<SubscriptionIntegrity> {
    Ok(SubscriptionIntegrity {
        partition_id: reader.read_string32("subscription integrity partitionId")?,
        previous_chain_root: reader.read_string32("subscription integrity previous root")?,
        commit_chain_root: reader.read_string32("subscription integrity chain root")?,
        commit_seq: reader.read_i64("subscription integrity commit seq")?,
    })
}

fn read_commit(reader: &mut BinarySyncPackReader<'_>) -> Result<SyncCommit> {
    Ok(SyncCommit {
        commit_seq: reader.read_i64("commit seq")?,
        created_at: reader.read_string32("commit createdAt")?,
        actor_id: reader.read_string32("commit actorId")?,
        changes: read_changes_v8(reader)?,
    })
}

fn read_changes_v8(reader: &mut BinarySyncPackReader<'_>) -> Result<Vec<SyncChange>> {
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
        changes.push(read_change_metadata_v8(
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
            return Err(ProtocolError::message(format!(
                "binary sync pack row group table mismatch: expected {table}, got {}",
                decoded.table
            )));
        }
        group_rows.push(decoded.rows.into_iter().map(Some).collect::<Vec<_>>());
    }

    for row_ref in row_refs {
        let Some(rows) = group_rows.get_mut(row_ref.group_index) else {
            return Err(ProtocolError::message(format!(
                "binary sync pack change row ref has invalid group index: {}",
                row_ref.group_index
            )));
        };
        let Some(row) = rows.get_mut(row_ref.row_index) else {
            return Err(ProtocolError::message(format!(
                "binary sync pack change row ref has invalid row index: group={}, row={}",
                row_ref.group_index, row_ref.row_index
            )));
        };
        let Some(row) = row.take() else {
            return Err(ProtocolError::message(format!(
                "binary sync pack change row ref was already consumed: group={}, row={}",
                row_ref.group_index, row_ref.row_index
            )));
        };
        let Some(change) = changes.get_mut(row_ref.change_index) else {
            return Err(ProtocolError::message(format!(
                "binary sync pack change row ref has invalid change index: {}",
                row_ref.change_index
            )));
        };
        if change.table != row_ref.table {
            return Err(ProtocolError::message(
                "binary sync pack row ref table mismatch",
            ));
        }
        change.row_json = Some(Value::Object(row));
    }

    Ok(changes)
}

fn read_change_metadata_v8(
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
            return Err(ProtocolError::message(format!(
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
            return Err(ProtocolError::message(format!(
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
        ProtocolError::message(format!("binary sync pack table index is invalid: {index}"))
    })
}

fn scope_values_at(
    scope_values_by_index: &[Map<String, Value>],
    index: usize,
) -> Result<Map<String, Value>> {
    scope_values_by_index.get(index).cloned().ok_or_else(|| {
        ProtocolError::message(format!("binary sync pack scope index is invalid: {index}"))
    })
}

fn read_snapshot(reader: &mut BinarySyncPackReader<'_>) -> Result<SyncSnapshot> {
    let mut snapshot = SyncSnapshot {
        table: reader.read_string16("snapshot table")?,
        rows: reader.read_array("snapshot rows", |reader| reader.read_json("snapshot row"))?,
        chunks: reader.read_optional_array("snapshot chunks", read_snapshot_chunk_ref)?,
        manifest: None,
        is_first_page: reader.read_bool("snapshot first page")?,
        is_last_page: reader.read_bool("snapshot last page")?,
        bootstrap_state_after: reader
            .read_optional_json("snapshot bootstrap state after")?
            .map(serde_json::from_value)
            .transpose()?,
    };
    snapshot.manifest = reader
        .read_optional_json("snapshot manifest")?
        .map(serde_json::from_value)
        .transpose()?;
    Ok(snapshot)
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

fn decode_binary_snapshot_table(bytes: &[u8]) -> Result<DecodedSyncPackBinarySnapshotTable> {
    let mut reader = BinarySyncPackReader::new(bytes);
    reader.expect_magic(BINARY_SNAPSHOT_MAGIC, "binary snapshot table")?;

    let version = reader.read_u16("binary snapshot version")?;
    if version != BINARY_SNAPSHOT_VERSION {
        return Err(ProtocolError::message(format!(
            "unsupported binary snapshot version: {version}"
        )));
    }
    let flags = reader.read_u16("binary snapshot flags")?;
    if flags != FLAG_NONE {
        return Err(ProtocolError::message(format!(
            "unsupported binary snapshot flags: {flags}"
        )));
    }

    let table = reader.read_string16("binary snapshot table name")?;
    let column_count = reader.read_u16("binary snapshot column count")? as usize;
    let mut columns = Vec::with_capacity(column_count);
    for _ in 0..column_count {
        let name = reader.read_string16("binary snapshot column name")?;
        let column_type = SyncPackBinarySnapshotColumnType::from_tag(
            reader.read_u8("binary snapshot column type")?,
        )?;
        let column_flags = reader.read_u8("binary snapshot column flags")?;
        if column_flags & !BINARY_SNAPSHOT_COLUMN_FLAG_NULLABLE != 0 {
            return Err(ProtocolError::message(format!(
                "unsupported binary snapshot column flags: {column_flags}"
            )));
        }
        columns.push(SyncPackBinarySnapshotColumn {
            name,
            column_type,
            nullable: column_flags & BINARY_SNAPSHOT_COLUMN_FLAG_NULLABLE != 0,
        });
    }

    let row_count = reader.read_u32("binary snapshot row count")? as usize;
    let null_bitmap_bytes = columns.len().div_ceil(8);
    let mut rows = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        let null_bitmap =
            reader.read_bytes(null_bitmap_bytes, "binary snapshot row null bitmap")?;
        let mut row = Map::with_capacity(columns.len());
        for (column_index, column) in columns.iter().enumerate() {
            let is_null = null_bitmap[column_index / 8] & (1u8 << (column_index % 8)) != 0;
            if is_null {
                if !column.nullable {
                    return Err(ProtocolError::message(format!(
                        "binary snapshot column {} is not nullable",
                        column.name
                    )));
                }
                row.insert(column.name.clone(), Value::Null);
                continue;
            }
            let value = reader.read_binary_snapshot_json_value(column.column_type, &column.name)?;
            row.insert(column.name.clone(), value);
        }
        rows.push(row);
    }
    reader.assert_done()?;

    Ok(DecodedSyncPackBinarySnapshotTable { table, rows })
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
            return Err(ProtocolError::message(format!("unexpected {label} magic")));
        }
        Ok(())
    }

    fn read_bool(&mut self, label: &str) -> Result<bool> {
        match self.read_u8(label)? {
            0 => Ok(false),
            1 => Ok(true),
            value => Err(ProtocolError::message(format!(
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

    fn read_f64(&mut self, label: &str) -> Result<f64> {
        let bytes = self.read_array_bytes::<8>(label)?;
        Ok(f64::from_le_bytes(bytes))
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
            _ => Err(ProtocolError::message(format!(
                "{label} expected JSON object"
            ))),
        }
    }

    fn read_binary_snapshot_json_value(
        &mut self,
        column_type: SyncPackBinarySnapshotColumnType,
        column: &str,
    ) -> Result<Value> {
        match column_type {
            SyncPackBinarySnapshotColumnType::String => {
                Ok(Value::String(self.read_string32("binary snapshot string")?))
            }
            SyncPackBinarySnapshotColumnType::Integer => Ok(Value::Number(
                serde_json::Number::from(self.read_i64("binary snapshot integer")?),
            )),
            SyncPackBinarySnapshotColumnType::Float => {
                let value = self.read_f64("binary snapshot float")?;
                serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .ok_or_else(|| {
                        ProtocolError::message(format!(
                            "binary snapshot {column} contained non-finite float"
                        ))
                    })
            }
            SyncPackBinarySnapshotColumnType::Boolean => {
                let value = self.read_u8("binary snapshot boolean")?;
                match value {
                    0 => Ok(Value::Bool(false)),
                    1 => Ok(Value::Bool(true)),
                    _ => Err(ProtocolError::message(format!(
                        "binary snapshot {column} expected boolean byte"
                    ))),
                }
            }
            SyncPackBinarySnapshotColumnType::Json => self.read_json("binary snapshot json"),
            SyncPackBinarySnapshotColumnType::Bytes => {
                let length = self.read_u32("binary snapshot bytes length")? as usize;
                Ok(Value::Array(
                    self.read_bytes(length, "binary snapshot bytes")?
                        .iter()
                        .map(|byte| Value::Number(serde_json::Number::from(*byte)))
                        .collect(),
                ))
            }
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
            value => Err(ProtocolError::message(format!(
                "optional value marker must be 0 or 1, got {value}"
            ))),
        }
    }

    fn read_string(&mut self, length: usize, label: &str) -> Result<String> {
        String::from_utf8(self.read_bytes(length, label)?.to_vec())
            .map_err(|err| ProtocolError::message(format!("{label} is not valid UTF-8: {err}")))
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
            return Err(ProtocolError::message(
                "binary sync pack has trailing bytes",
            ));
        }
        Ok(())
    }

    fn require(&self, length: usize, label: &str) -> Result<()> {
        if self.offset + length > self.bytes.len() {
            return Err(ProtocolError::message(format!(
                "{label} exceeds binary sync pack bounds"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_binary_sync_pack, is_binary_sync_pack_content_type, SYNC_PACK_CONTENT_TYPE,
    };

    #[test]
    fn decodes_current_typescript_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../runtime/tests/fixtures/binary-sync-pack-v1-combined-response.json"
        ))
        .expect("fixture json");
        assert_eq!(
            fixture["contentType"].as_str(),
            Some(SYNC_PACK_CONTENT_TYPE)
        );
        assert!(is_binary_sync_pack_content_type(Some(
            "application/vnd.syncular.sync-pack.v1; charset=binary"
        )));

        let encoded = hex::decode(
            fixture["encodedHex"]
                .as_str()
                .expect("fixture encodedHex string"),
        )
        .expect("fixture encoded hex");
        let response = decode_binary_sync_pack(&encoded).expect("decode current fixture");
        assert_eq!(response.required_schema_version, Some(2));
        assert_eq!(response.latest_schema_version, Some(3));
        let push = response.push.as_ref().expect("push response");
        assert_eq!(push.commits[0].client_commit_id, "fixture-local-1");
        assert_eq!(push.commits[1].status, "rejected");
        assert_eq!(push.commits[1].results[0].server_version, Some(7));
        let pull = response.pull.unwrap();
        let subscription = &pull.subscriptions[0];
        assert_eq!(
            subscription
                .integrity
                .as_ref()
                .map(|integrity| integrity.commit_seq),
            Some(42)
        );
        let change = &pull.subscriptions[0].commits[0].changes[0];
        assert_eq!(change.table, "tasks");
        assert_eq!(change.row_id, "task-1");
        assert_eq!(
            change.row_json.as_ref().unwrap()["title"].as_str(),
            Some("Remote")
        );
        assert_eq!(
            subscription.snapshots.as_ref().unwrap()[0]
                .manifest
                .as_ref()
                .map(|manifest| manifest.digest.as_str()),
            Some("28906bb034df33f281391be2cc697cdf669646f5e2158f07b6b9a35277cc4b6b")
        );
    }

    #[test]
    fn rejects_old_binary_sync_pack_versions() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../runtime/tests/fixtures/binary-sync-pack-v1-combined-response.json"
        ))
        .expect("fixture json");
        let mut encoded = hex::decode(
            fixture["encodedHex"]
                .as_str()
                .expect("fixture encodedHex string"),
        )
        .expect("fixture encoded hex");
        encoded[4..6].copy_from_slice(&10u16.to_le_bytes());
        let error = decode_binary_sync_pack(&encoded).expect_err("old version is rejected");
        assert!(error
            .to_string()
            .contains("unsupported binary sync pack version: 10"));
    }
}
