use crate::error::{ProtocolError, Result};
use serde_json::{Map, Number, Value};
use std::fmt;

const MAGIC: &[u8; 4] = b"SBT1";
const VERSION: u16 = 1;
const FLAG_NONE: u16 = 0;
const COLUMN_FLAG_NULLABLE: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinarySnapshotColumnType {
    String,
    Integer,
    Float,
    Boolean,
    Json,
    Bytes,
}

impl BinarySnapshotColumnType {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinarySnapshotColumn {
    pub name: String,
    pub column_type: BinarySnapshotColumnType,
    pub nullable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedBinarySnapshotTable {
    pub table: String,
    pub columns: Vec<BinarySnapshotColumn>,
    pub rows: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BinarySnapshotCell {
    Null,
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Json(Value),
    Bytes(Vec<u8>),
}

impl BinarySnapshotCell {
    pub fn into_json_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::String(value) => Value::String(value),
            Self::Integer(value) => Value::Number(Number::from(value)),
            Self::Float(value) => Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Self::Boolean(value) => Value::Bool(value),
            Self::Json(value) => value,
            Self::Bytes(bytes) => Value::Array(
                bytes
                    .into_iter()
                    .map(|byte| Value::Number(Number::from(byte)))
                    .collect(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedBinarySnapshotRows {
    pub table: String,
    pub columns: Vec<BinarySnapshotColumn>,
    pub rows: Vec<Vec<BinarySnapshotCell>>,
}

impl DecodedBinarySnapshotRows {
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub fn into_value_rows(self) -> Vec<Value> {
        self.into_maps().into_iter().map(Value::Object).collect()
    }

    pub fn into_maps(self) -> Vec<Map<String, Value>> {
        let columns = self.columns;
        self.rows
            .into_iter()
            .map(|row| {
                columns
                    .iter()
                    .zip(row)
                    .map(|(column, value)| (column.name.clone(), value.into_json_value()))
                    .collect()
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinarySnapshotPayload {
    bytes: Vec<u8>,
    pub table: String,
    pub columns: Vec<BinarySnapshotColumn>,
    pub row_count: usize,
    rows_offset: usize,
}

impl BinarySnapshotPayload {
    pub fn row_count(&self) -> usize {
        self.row_count
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn row_cursor(&self) -> BinarySnapshotRowCursor<'_> {
        BinarySnapshotRowCursor {
            reader: BinarySnapshotReader {
                bytes: &self.bytes,
                offset: self.rows_offset,
            },
            columns: &self.columns,
            null_bitmap_bytes: self.columns.len().div_ceil(8),
            remaining: self.row_count,
        }
    }

    pub fn into_decoded_rows(self) -> Result<DecodedBinarySnapshotRows> {
        decode_binary_snapshot_rows(&self.bytes)
    }

    pub fn into_value_rows(self) -> Result<Vec<Value>> {
        self.into_decoded_rows()
            .map(DecodedBinarySnapshotRows::into_value_rows)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BorrowedBinarySnapshotCell<'a> {
    Null,
    String(&'a str),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Json(&'a str),
    Bytes(&'a [u8]),
}

#[derive(Debug)]
pub enum BinarySnapshotVisitError<E> {
    Protocol(ProtocolError),
    Visitor(E),
}

impl<E> BinarySnapshotVisitError<E> {
    fn protocol(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }

    fn visitor(error: E) -> Self {
        Self::Visitor(error)
    }
}

impl<E: fmt::Display> fmt::Display for BinarySnapshotVisitError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => error.fmt(f),
            Self::Visitor(error) => error.fmt(f),
        }
    }
}

impl<E> std::error::Error for BinarySnapshotVisitError<E> where E: std::error::Error + 'static {}

pub trait BorrowedBinarySnapshotRawCellVisitor<'a> {
    type Error;

    fn visit_null(&mut self) -> std::result::Result<(), Self::Error>;
    fn visit_string_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error>;
    fn visit_integer(&mut self, value: i64) -> std::result::Result<(), Self::Error>;
    fn visit_float(&mut self, value: f64) -> std::result::Result<(), Self::Error>;
    fn visit_boolean(&mut self, value: bool) -> std::result::Result<(), Self::Error>;
    fn visit_json_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error>;
    fn visit_bytes(&mut self, value: &'a [u8]) -> std::result::Result<(), Self::Error>;
}

pub struct BinarySnapshotRowCursor<'a> {
    reader: BinarySnapshotReader<'a>,
    columns: &'a [BinarySnapshotColumn],
    null_bitmap_bytes: usize,
    remaining: usize,
}

impl<'a> BinarySnapshotRowCursor<'a> {
    pub fn read_next_row<F, E>(
        &mut self,
        mut on_cell: F,
    ) -> std::result::Result<bool, BinarySnapshotVisitError<E>>
    where
        F: FnMut(
            usize,
            &BinarySnapshotColumn,
            BorrowedBinarySnapshotCell<'a>,
        ) -> std::result::Result<(), E>,
    {
        if self.remaining == 0 {
            return Ok(false);
        }

        let null_bitmap = self
            .reader
            .read_bytes(self.null_bitmap_bytes, "binary snapshot row null bitmap")
            .map_err(BinarySnapshotVisitError::protocol)?;
        for (column_index, column) in self.columns.iter().enumerate() {
            let is_null = null_bitmap[column_index / 8] & (1u8 << (column_index % 8)) != 0;
            if is_null {
                if !column.nullable {
                    return Err(BinarySnapshotVisitError::protocol(ProtocolError::message(
                        format!("binary snapshot column {} is not nullable", column.name),
                    )));
                }
                on_cell(column_index, column, BorrowedBinarySnapshotCell::Null)
                    .map_err(BinarySnapshotVisitError::visitor)?;
                continue;
            }
            let value = self
                .reader
                .read_borrowed_cell(column.column_type, &column.name)
                .map_err(BinarySnapshotVisitError::protocol)?;
            on_cell(column_index, column, value).map_err(BinarySnapshotVisitError::visitor)?;
        }
        self.remaining -= 1;
        Ok(true)
    }

    pub fn read_next_row_with_raw_visitor_trusted<V>(
        &mut self,
        visitor: &mut V,
    ) -> std::result::Result<bool, BinarySnapshotVisitError<V::Error>>
    where
        V: BorrowedBinarySnapshotRawCellVisitor<'a>,
    {
        if self.remaining == 0 {
            return Ok(false);
        }

        let null_bitmap = self
            .reader
            .read_bytes(self.null_bitmap_bytes, "binary snapshot row null bitmap")
            .map_err(BinarySnapshotVisitError::protocol)?;
        for (column_index, column) in self.columns.iter().enumerate() {
            let is_null = null_bitmap[column_index / 8] & (1u8 << (column_index % 8)) != 0;
            if is_null {
                visitor
                    .visit_null()
                    .map_err(BinarySnapshotVisitError::visitor)?;
                continue;
            }
            self.reader
                .visit_raw_cell_trusted(column.column_type, visitor)?;
        }
        self.remaining -= 1;
        Ok(true)
    }

    pub fn assert_done(&self) -> Result<()> {
        self.reader.assert_done()
    }
}

pub fn decode_binary_snapshot_table(bytes: &[u8]) -> Result<DecodedBinarySnapshotTable> {
    let DecodedBinarySnapshotRows {
        table,
        columns,
        rows,
    } = decode_binary_snapshot_rows(bytes)?;
    let value_rows = rows
        .into_iter()
        .map(|row| {
            columns
                .iter()
                .zip(row)
                .map(|(column, value)| (column.name.clone(), value.into_json_value()))
                .collect()
        })
        .collect();
    Ok(DecodedBinarySnapshotTable {
        table,
        columns,
        rows: value_rows,
    })
}

pub fn decode_snapshot_row_frames(bytes: &[u8]) -> Result<Vec<Value>> {
    if bytes.len() < 4 || &bytes[0..4] != b"SRF1" {
        return Err(ProtocolError::message(
            "unexpected snapshot chunk frame header",
        ));
    }

    let mut offset = 4usize;
    let mut rows = Vec::with_capacity(estimated_snapshot_row_count(bytes.len()));
    while offset < bytes.len() {
        if offset + 4 > bytes.len() {
            return Err(ProtocolError::message("snapshot frame ended mid-header"));
        }
        let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if offset + len > bytes.len() {
            return Err(ProtocolError::message("snapshot frame ended mid-body"));
        }
        let row: Value = serde_json::from_slice(&bytes[offset..offset + len])?;
        rows.push(row);
        offset += len;
    }

    Ok(rows)
}

fn estimated_snapshot_row_count(byte_len: usize) -> usize {
    (byte_len / 160).clamp(1, 20_000)
}

pub fn decode_binary_snapshot_rows(bytes: &[u8]) -> Result<DecodedBinarySnapshotRows> {
    let mut reader = BinarySnapshotReader::new(bytes);
    let (table, columns, row_count, _) = read_binary_snapshot_header(&mut reader)?;
    let null_bitmap_bytes = columns.len().div_ceil(8);
    let mut rows = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        let null_bitmap =
            reader.read_bytes(null_bitmap_bytes, "binary snapshot row null bitmap")?;
        let mut row = Vec::with_capacity(columns.len());
        for (column_index, column) in columns.iter().enumerate() {
            let is_null = null_bitmap[column_index / 8] & (1u8 << (column_index % 8) as u32) != 0;
            if is_null {
                if !column.nullable {
                    return Err(ProtocolError::message(format!(
                        "binary snapshot column {} is not nullable",
                        column.name
                    )));
                }
                row.push(BinarySnapshotCell::Null);
                continue;
            }
            row.push(reader.read_cell(column.column_type, &column.name)?);
        }
        rows.push(row);
    }
    reader.assert_done()?;

    Ok(DecodedBinarySnapshotRows {
        table,
        columns,
        rows,
    })
}

pub fn decode_binary_snapshot_payload(bytes: Vec<u8>) -> Result<BinarySnapshotPayload> {
    let mut reader = BinarySnapshotReader::new(&bytes);
    let (table, columns, row_count, rows_offset) = read_binary_snapshot_header(&mut reader)?;
    Ok(BinarySnapshotPayload {
        bytes,
        table,
        columns,
        row_count,
        rows_offset,
    })
}

fn read_binary_snapshot_header(
    reader: &mut BinarySnapshotReader<'_>,
) -> Result<(String, Vec<BinarySnapshotColumn>, usize, usize)> {
    reader.expect_magic(MAGIC, "binary snapshot table")?;

    let version = reader.read_u16("binary snapshot version")?;
    if version != VERSION {
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
        let column_type =
            BinarySnapshotColumnType::from_tag(reader.read_u8("binary snapshot column type")?)?;
        let column_flags = reader.read_u8("binary snapshot column flags")?;
        if column_flags & !COLUMN_FLAG_NULLABLE != 0 {
            return Err(ProtocolError::message(format!(
                "unsupported binary snapshot column flags: {column_flags}"
            )));
        }
        columns.push(BinarySnapshotColumn {
            name,
            column_type,
            nullable: column_flags & COLUMN_FLAG_NULLABLE != 0,
        });
    }

    let row_count = reader.read_u32("binary snapshot row count")? as usize;
    let rows_offset = reader.offset;
    Ok((table, columns, row_count, rows_offset))
}

struct BinarySnapshotReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BinarySnapshotReader<'a> {
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

    fn read_u8(&mut self, label: &str) -> Result<u8> {
        self.require(1, label)?;
        let value = self.bytes[self.offset];
        self.offset += 1;
        Ok(value)
    }

    fn read_u16(&mut self, label: &str) -> Result<u16> {
        self.require(2, label)?;
        let value = u16::from_le_bytes(
            self.bytes[self.offset..self.offset + 2]
                .try_into()
                .expect("slice length checked"),
        );
        self.offset += 2;
        Ok(value)
    }

    fn read_u32(&mut self, label: &str) -> Result<u32> {
        self.require(4, label)?;
        let value = u32::from_le_bytes(
            self.bytes[self.offset..self.offset + 4]
                .try_into()
                .expect("slice length checked"),
        );
        self.offset += 4;
        Ok(value)
    }

    fn read_i64(&mut self, label: &str) -> Result<i64> {
        self.require(8, label)?;
        let value = i64::from_le_bytes(
            self.bytes[self.offset..self.offset + 8]
                .try_into()
                .expect("slice length checked"),
        );
        self.offset += 8;
        Ok(value)
    }

    fn read_f64(&mut self, label: &str) -> Result<f64> {
        self.require(8, label)?;
        let value = f64::from_le_bytes(
            self.bytes[self.offset..self.offset + 8]
                .try_into()
                .expect("slice length checked"),
        );
        self.offset += 8;
        Ok(value)
    }

    fn read_string16(&mut self, label: &str) -> Result<String> {
        let len = self.read_u16(&format!("{label} length"))? as usize;
        let bytes = self.read_bytes(len, label)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|err| ProtocolError::message(format!("decode {label} as utf8: {err}")))
    }

    fn read_string32(&mut self, label: &str) -> Result<String> {
        let len = self.read_u32(&format!("{label} length"))? as usize;
        let bytes = self.read_bytes(len, label)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|err| ProtocolError::message(format!("decode {label} as utf8: {err}")))
    }

    fn read_str32(&mut self, label: &str) -> Result<&'a str> {
        let len = self.read_u32(&format!("{label} length"))? as usize;
        let bytes = self.read_bytes(len, label)?;
        std::str::from_utf8(bytes)
            .map_err(|err| ProtocolError::message(format!("decode {label} as utf8: {err}")))
    }

    fn read_bytes32(&mut self, label: &str) -> Result<&'a [u8]> {
        let len = self.read_u32(&format!("{label} length"))? as usize;
        self.read_bytes(len, label)
    }

    fn read_bytes(&mut self, len: usize, label: &str) -> Result<&'a [u8]> {
        self.require(len, label)?;
        let bytes = &self.bytes[self.offset..self.offset + len];
        self.offset += len;
        Ok(bytes)
    }

    fn read_cell(
        &mut self,
        column_type: BinarySnapshotColumnType,
        column: &str,
    ) -> Result<BinarySnapshotCell> {
        match column_type {
            BinarySnapshotColumnType::String => Ok(BinarySnapshotCell::String(
                self.read_string32("binary snapshot string")?,
            )),
            BinarySnapshotColumnType::Integer => Ok(BinarySnapshotCell::Integer(
                self.read_i64("binary snapshot integer")?,
            )),
            BinarySnapshotColumnType::Float => {
                let value = self.read_f64("binary snapshot float")?;
                Number::from_f64(value).ok_or_else(|| {
                    ProtocolError::message(format!(
                        "binary snapshot {column} contained non-finite float"
                    ))
                })?;
                Ok(BinarySnapshotCell::Float(value))
            }
            BinarySnapshotColumnType::Boolean => {
                let value = self.read_u8("binary snapshot boolean")?;
                match value {
                    0 => Ok(BinarySnapshotCell::Boolean(false)),
                    1 => Ok(BinarySnapshotCell::Boolean(true)),
                    _ => Err(ProtocolError::message(format!(
                        "binary snapshot {column} expected boolean byte"
                    ))),
                }
            }
            BinarySnapshotColumnType::Json => {
                let value = self.read_string32("binary snapshot json")?;
                Ok(BinarySnapshotCell::Json(serde_json::from_str(&value)?))
            }
            BinarySnapshotColumnType::Bytes => {
                let len = self.read_u32("binary snapshot bytes length")? as usize;
                let bytes = self.read_bytes(len, "binary snapshot bytes")?;
                Ok(BinarySnapshotCell::Bytes(bytes.to_vec()))
            }
        }
    }

    fn read_borrowed_cell(
        &mut self,
        column_type: BinarySnapshotColumnType,
        column: &str,
    ) -> Result<BorrowedBinarySnapshotCell<'a>> {
        match column_type {
            BinarySnapshotColumnType::String => Ok(BorrowedBinarySnapshotCell::String(
                self.read_str32("binary snapshot string")?,
            )),
            BinarySnapshotColumnType::Integer => Ok(BorrowedBinarySnapshotCell::Integer(
                self.read_i64("binary snapshot integer")?,
            )),
            BinarySnapshotColumnType::Float => {
                let value = self.read_f64("binary snapshot float")?;
                Number::from_f64(value).ok_or_else(|| {
                    ProtocolError::message(format!(
                        "binary snapshot {column} contained non-finite float"
                    ))
                })?;
                Ok(BorrowedBinarySnapshotCell::Float(value))
            }
            BinarySnapshotColumnType::Boolean => {
                let value = self.read_u8("binary snapshot boolean")?;
                match value {
                    0 => Ok(BorrowedBinarySnapshotCell::Boolean(false)),
                    1 => Ok(BorrowedBinarySnapshotCell::Boolean(true)),
                    _ => Err(ProtocolError::message(format!(
                        "binary snapshot {column} expected boolean byte"
                    ))),
                }
            }
            BinarySnapshotColumnType::Json => Ok(BorrowedBinarySnapshotCell::Json(
                self.read_str32("binary snapshot json")?,
            )),
            BinarySnapshotColumnType::Bytes => {
                let len = self.read_u32("binary snapshot bytes length")? as usize;
                let bytes = self.read_bytes(len, "binary snapshot bytes")?;
                Ok(BorrowedBinarySnapshotCell::Bytes(bytes))
            }
        }
    }

    fn visit_raw_cell_trusted<V>(
        &mut self,
        column_type: BinarySnapshotColumnType,
        visitor: &mut V,
    ) -> std::result::Result<(), BinarySnapshotVisitError<V::Error>>
    where
        V: BorrowedBinarySnapshotRawCellVisitor<'a>,
    {
        match column_type {
            BinarySnapshotColumnType::String => {
                let value = self
                    .read_bytes32("binary snapshot string")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                visitor
                    .visit_string_bytes(value)
                    .map_err(BinarySnapshotVisitError::visitor)
            }
            BinarySnapshotColumnType::Integer => {
                let value = self
                    .read_i64("binary snapshot integer")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                visitor
                    .visit_integer(value)
                    .map_err(BinarySnapshotVisitError::visitor)
            }
            BinarySnapshotColumnType::Float => {
                let value = self
                    .read_f64("binary snapshot float")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                if !value.is_finite() {
                    return Err(BinarySnapshotVisitError::protocol(ProtocolError::message(
                        "binary snapshot contained non-finite float",
                    )));
                }
                visitor
                    .visit_float(value)
                    .map_err(BinarySnapshotVisitError::visitor)
            }
            BinarySnapshotColumnType::Boolean => {
                let value = self
                    .read_u8("binary snapshot boolean")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                match value {
                    0 => visitor
                        .visit_boolean(false)
                        .map_err(BinarySnapshotVisitError::visitor),
                    1 => visitor
                        .visit_boolean(true)
                        .map_err(BinarySnapshotVisitError::visitor),
                    _ => Err(BinarySnapshotVisitError::protocol(ProtocolError::message(
                        "binary snapshot expected boolean byte",
                    ))),
                }
            }
            BinarySnapshotColumnType::Json => {
                let value = self
                    .read_bytes32("binary snapshot json")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                visitor
                    .visit_json_bytes(value)
                    .map_err(BinarySnapshotVisitError::visitor)
            }
            BinarySnapshotColumnType::Bytes => {
                let len =
                    self.read_u32("binary snapshot bytes length")
                        .map_err(BinarySnapshotVisitError::protocol)? as usize;
                let bytes = self
                    .read_bytes(len, "binary snapshot bytes")
                    .map_err(BinarySnapshotVisitError::protocol)?;
                visitor
                    .visit_bytes(bytes)
                    .map_err(BinarySnapshotVisitError::visitor)
            }
        }
    }

    fn assert_done(&self) -> Result<()> {
        if self.offset != self.bytes.len() {
            return Err(ProtocolError::message(
                "binary snapshot payload has trailing bytes",
            ));
        }
        Ok(())
    }

    fn require(&self, len: usize, label: &str) -> Result<()> {
        if self.offset + len > self.bytes.len() {
            return Err(ProtocolError::message(format!(
                "{label} exceeds binary snapshot payload bounds"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_i64(bytes: &mut Vec<u8>, value: i64) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_f64(bytes: &mut Vec<u8>, value: f64) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_string16(bytes: &mut Vec<u8>, value: &str) {
        push_u16(bytes, value.len() as u16);
        bytes.extend_from_slice(value.as_bytes());
    }

    fn push_string32(bytes: &mut Vec<u8>, value: &str) {
        push_u32(bytes, value.len() as u32);
        bytes.extend_from_slice(value.as_bytes());
    }

    #[test]
    fn decodes_binary_snapshot_table_rows() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"SBT1");
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 0);
        push_string16(&mut bytes, "tasks");
        push_u16(&mut bytes, 6);
        for (name, tag, flags) in [
            ("id", 1u8, 0u8),
            ("completed", 4, 0),
            ("server_version", 2, 0),
            ("score", 3, 0),
            ("metadata", 5, COLUMN_FLAG_NULLABLE),
            ("payload", 6, 0),
        ] {
            push_string16(&mut bytes, name);
            bytes.push(tag);
            bytes.push(flags);
        }
        push_u32(&mut bytes, 2);

        bytes.push(0);
        push_string32(&mut bytes, "task-1");
        bytes.push(0);
        push_i64(&mut bytes, 42);
        push_f64(&mut bytes, 1.5);
        push_string32(&mut bytes, r#"{"priority":"high"}"#);
        push_u32(&mut bytes, 3);
        bytes.extend_from_slice(&[1, 2, 3]);

        bytes.push(1 << 4);
        push_string32(&mut bytes, "task-2");
        bytes.push(1);
        push_i64(&mut bytes, 43);
        push_f64(&mut bytes, 2.25);
        push_u32(&mut bytes, 0);

        let decoded = decode_binary_snapshot_table(&bytes).unwrap();

        assert_eq!(decoded.table, "tasks");
        assert_eq!(decoded.columns.len(), 6);
        assert_eq!(decoded.rows[0]["id"], json!("task-1"));
        assert_eq!(decoded.rows[0]["completed"], json!(false));
        assert_eq!(decoded.rows[0]["server_version"], json!(42));
        assert_eq!(decoded.rows[0]["score"], json!(1.5));
        assert_eq!(decoded.rows[0]["metadata"], json!({"priority": "high"}));
        assert_eq!(decoded.rows[0]["payload"], json!([1, 2, 3]));
        assert_eq!(decoded.rows[1]["metadata"], Value::Null);

        let payload = decode_binary_snapshot_payload(bytes).unwrap();
        let mut cursor = payload.row_cursor();
        let mut first_row = Vec::new();
        assert!(cursor
            .read_next_row(|_, _, value| {
                first_row.push(value);
                Ok::<(), ProtocolError>(())
            })
            .unwrap());
        assert_eq!(first_row[0], BorrowedBinarySnapshotCell::String("task-1"));
        assert_eq!(first_row[1], BorrowedBinarySnapshotCell::Boolean(false));
        assert_eq!(first_row[2], BorrowedBinarySnapshotCell::Integer(42));
        assert_eq!(first_row[3], BorrowedBinarySnapshotCell::Float(1.5));
        assert_eq!(
            first_row[4],
            BorrowedBinarySnapshotCell::Json(r#"{"priority":"high"}"#)
        );
        assert_eq!(first_row[5], BorrowedBinarySnapshotCell::Bytes(&[1, 2, 3]));

        #[derive(Debug, PartialEq)]
        enum RawCell<'a> {
            Null,
            String(&'a [u8]),
            Integer(i64),
            Float(f64),
            Boolean(bool),
            Json(&'a [u8]),
            Bytes(&'a [u8]),
        }

        struct RawRecordingVisitor<'a> {
            values: Vec<RawCell<'a>>,
        }

        impl<'a> BorrowedBinarySnapshotRawCellVisitor<'a> for RawRecordingVisitor<'a> {
            type Error = ProtocolError;

            fn visit_null(&mut self) -> Result<()> {
                self.values.push(RawCell::Null);
                Ok(())
            }

            fn visit_string_bytes(&mut self, value: &'a [u8]) -> Result<()> {
                self.values.push(RawCell::String(value));
                Ok(())
            }

            fn visit_integer(&mut self, value: i64) -> Result<()> {
                self.values.push(RawCell::Integer(value));
                Ok(())
            }

            fn visit_float(&mut self, value: f64) -> Result<()> {
                self.values.push(RawCell::Float(value));
                Ok(())
            }

            fn visit_boolean(&mut self, value: bool) -> Result<()> {
                self.values.push(RawCell::Boolean(value));
                Ok(())
            }

            fn visit_json_bytes(&mut self, value: &'a [u8]) -> Result<()> {
                self.values.push(RawCell::Json(value));
                Ok(())
            }

            fn visit_bytes(&mut self, value: &'a [u8]) -> Result<()> {
                self.values.push(RawCell::Bytes(value));
                Ok(())
            }
        }

        let mut cursor = payload.row_cursor();
        let mut raw_visitor = RawRecordingVisitor { values: Vec::new() };
        assert!(cursor
            .read_next_row_with_raw_visitor_trusted(&mut raw_visitor)
            .unwrap());
        assert_eq!(
            raw_visitor.values,
            vec![
                RawCell::String(&b"task-1"[..]),
                RawCell::Boolean(false),
                RawCell::Integer(42),
                RawCell::Float(1.5),
                RawCell::Json(&br#"{"priority":"high"}"#[..]),
                RawCell::Bytes(&[1, 2, 3]),
            ]
        );
    }
}
