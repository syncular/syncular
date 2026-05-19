use crate::error::{Result, SyncularError};
use serde_json::Value;
use std::ops::Deref;
use syncular_protocol::binary_snapshot as protocol_binary_snapshot;

pub use protocol_binary_snapshot::{
    BinarySnapshotCell, BinarySnapshotColumn, BinarySnapshotColumnType, BorrowedBinarySnapshotCell,
    DecodedBinarySnapshotRows, DecodedBinarySnapshotTable,
};

#[derive(Debug, Clone, PartialEq)]
pub struct BinarySnapshotPayload(protocol_binary_snapshot::BinarySnapshotPayload);

impl BinarySnapshotPayload {
    pub fn row_count(&self) -> usize {
        self.0.row_count()
    }

    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }

    pub fn row_cursor(&self) -> BinarySnapshotRowCursor<'_> {
        BinarySnapshotRowCursor {
            inner: self.0.row_cursor(),
        }
    }

    pub fn into_decoded_rows(self) -> Result<DecodedBinarySnapshotRows> {
        Ok(self.0.into_decoded_rows()?)
    }

    pub fn into_value_rows(self) -> Result<Vec<Value>> {
        Ok(self.0.into_value_rows()?)
    }
}

impl Deref for BinarySnapshotPayload {
    type Target = protocol_binary_snapshot::BinarySnapshotPayload;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<protocol_binary_snapshot::BinarySnapshotPayload> for BinarySnapshotPayload {
    fn from(payload: protocol_binary_snapshot::BinarySnapshotPayload) -> Self {
        Self(payload)
    }
}

pub trait BorrowedBinarySnapshotRawCellVisitor<'a> {
    fn visit_null(&mut self) -> Result<()>;
    fn visit_string_bytes(&mut self, value: &'a [u8]) -> Result<()>;
    fn visit_integer(&mut self, value: i64) -> Result<()>;
    fn visit_float(&mut self, value: f64) -> Result<()>;
    fn visit_boolean(&mut self, value: bool) -> Result<()>;
    fn visit_json_bytes(&mut self, value: &'a [u8]) -> Result<()>;
    fn visit_bytes(&mut self, value: &'a [u8]) -> Result<()>;
}

pub struct BinarySnapshotRowCursor<'a> {
    inner: protocol_binary_snapshot::BinarySnapshotRowCursor<'a>,
}

impl<'a> BinarySnapshotRowCursor<'a> {
    pub fn read_next_row<F>(&mut self, mut on_cell: F) -> Result<bool>
    where
        F: FnMut(usize, &BinarySnapshotColumn, BorrowedBinarySnapshotCell<'a>) -> Result<()>,
    {
        self.inner
            .read_next_row(|column_index, column, cell| on_cell(column_index, column, cell))
            .map_err(syncular_error_from_visit)
    }

    pub fn read_next_row_with_raw_visitor_trusted<V>(&mut self, visitor: &mut V) -> Result<bool>
    where
        V: BorrowedBinarySnapshotRawCellVisitor<'a>,
    {
        let mut adapter = RawCellVisitorAdapter { visitor };
        self.inner
            .read_next_row_with_raw_visitor_trusted(&mut adapter)
            .map_err(syncular_error_from_visit)
    }

    pub fn assert_done(&self) -> Result<()> {
        Ok(self.inner.assert_done()?)
    }
}

struct RawCellVisitorAdapter<'v, V> {
    visitor: &'v mut V,
}

impl<'a, V> protocol_binary_snapshot::BorrowedBinarySnapshotRawCellVisitor<'a>
    for RawCellVisitorAdapter<'_, V>
where
    V: BorrowedBinarySnapshotRawCellVisitor<'a>,
{
    type Error = SyncularError;

    fn visit_null(&mut self) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_null()
    }

    fn visit_string_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_string_bytes(value)
    }

    fn visit_integer(&mut self, value: i64) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_integer(value)
    }

    fn visit_float(&mut self, value: f64) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_float(value)
    }

    fn visit_boolean(&mut self, value: bool) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_boolean(value)
    }

    fn visit_json_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_json_bytes(value)
    }

    fn visit_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error> {
        self.visitor.visit_bytes(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SnapshotChunkRows {
    Json(Vec<Value>),
    Binary(DecodedBinarySnapshotRows),
    BinaryPayload(BinarySnapshotPayload),
}

impl SnapshotChunkRows {
    pub fn row_count(&self) -> usize {
        match self {
            Self::Json(rows) => rows.len(),
            Self::Binary(rows) => rows.row_count(),
            Self::BinaryPayload(rows) => rows.row_count(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.row_count() == 0
    }

    pub fn encoding_name(&self) -> &'static str {
        match self {
            Self::Json(_) => "json-row-frame-v1",
            Self::Binary(_) | Self::BinaryPayload(_) => "binary-table-v1",
        }
    }

    pub fn into_value_rows(self) -> Vec<Value> {
        self.try_into_value_rows()
            .expect("binary snapshot payload decodes into JSON rows")
    }

    pub fn try_into_value_rows(self) -> Result<Vec<Value>> {
        match self {
            Self::Json(rows) => Ok(rows),
            Self::Binary(rows) => Ok(rows.into_value_rows()),
            Self::BinaryPayload(rows) => rows.into_value_rows(),
        }
    }
}

pub fn decode_binary_snapshot_table(bytes: &[u8]) -> Result<DecodedBinarySnapshotTable> {
    Ok(protocol_binary_snapshot::decode_binary_snapshot_table(
        bytes,
    )?)
}

pub fn decode_snapshot_row_frames(bytes: &[u8]) -> Result<Vec<Value>> {
    Ok(protocol_binary_snapshot::decode_snapshot_row_frames(bytes)?)
}

pub fn decode_binary_snapshot_rows(bytes: &[u8]) -> Result<DecodedBinarySnapshotRows> {
    Ok(protocol_binary_snapshot::decode_binary_snapshot_rows(
        bytes,
    )?)
}

pub fn decode_binary_snapshot_payload(bytes: Vec<u8>) -> Result<BinarySnapshotPayload> {
    Ok(protocol_binary_snapshot::decode_binary_snapshot_payload(bytes)?.into())
}

fn syncular_error_from_visit(
    error: protocol_binary_snapshot::BinarySnapshotVisitError<SyncularError>,
) -> SyncularError {
    match error {
        protocol_binary_snapshot::BinarySnapshotVisitError::Protocol(error) => error.into(),
        protocol_binary_snapshot::BinarySnapshotVisitError::Visitor(error) => error,
    }
}
