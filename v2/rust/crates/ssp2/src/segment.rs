//! SSG2 rows segments (SPEC.md §5.2) and the §2.4 generated-row codec they
//! embed. All structural decode failures are `sync.invalid_request` (§5.2
//! error-code rule); the column-table-vs-generated-schema comparison
//! (`sync.schema_mismatch`) is the receiver's job, not the codec's.

use crate::error::{DecodeError, Result};
use crate::primitives::{RawJson, Reader, Writer};

pub const SSG2_MAGIC: &[u8; 4] = b"SSG2";
pub const SSG2_FORMAT_VERSION: u16 = 1;

/// Column type tags (§2.4) — unchanged from v1's binary-table-v1 assignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    String,
    Integer,
    Float,
    Boolean,
    Json,
    Bytes,
}

impl ColumnType {
    pub fn from_tag(tag: u8) -> Option<Self> {
        match tag {
            1 => Some(ColumnType::String),
            2 => Some(ColumnType::Integer),
            3 => Some(ColumnType::Float),
            4 => Some(ColumnType::Boolean),
            5 => Some(ColumnType::Json),
            6 => Some(ColumnType::Bytes),
            _ => None,
        }
    }

    pub fn tag(self) -> u8 {
        match self {
            ColumnType::String => 1,
            ColumnType::Integer => 2,
            ColumnType::Float => 3,
            ColumnType::Boolean => 4,
            ColumnType::Json => 5,
            ColumnType::Bytes => 6,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ColumnType::String => "string",
            ColumnType::Integer => "integer",
            ColumnType::Float => "float",
            ColumnType::Boolean => "boolean",
            ColumnType::Json => "json",
            ColumnType::Bytes => "bytes",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub name: String,
    pub ty: ColumnType,
    pub nullable: bool,
}

/// A decoded column value. `Json` keeps the raw string (round-trip fidelity).
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Json(RawJson),
    Bytes(Vec<u8>),
}

/// One row: `columns.len()` slots, `None` = NULL.
pub type Row = Vec<Option<ColumnValue>>;

#[derive(Debug, Clone, PartialEq)]
pub struct RowsSegment {
    pub table: String,
    pub schema_version: i32,
    pub columns: Vec<Column>,
    /// Row blocks in wire order; block boundaries are part of the canonical
    /// byte stream and are preserved for re-encoding.
    pub blocks: Vec<Vec<Row>>,
}

/// Decode one row per the §2.4 row codec: null bitmap (LSB-first, byte i/8),
/// then non-null values positionally in column order.
pub fn decode_row(r: &mut Reader<'_>, columns: &[Column]) -> Result<Row> {
    let bitmap_len = columns.len().div_ceil(8);
    let bitmap = r.take(bitmap_len, "row null bitmap")?.to_vec();
    // Padding bits (positions ≥ columnCount in the final byte) must be zero.
    for bit in columns.len()..bitmap_len * 8 {
        if bitmap[bit / 8] & (1 << (bit % 8)) != 0 {
            return Err(DecodeError::invalid(
                "row null bitmap has a set padding bit (non-canonical encoding)",
            ));
        }
    }
    let mut row: Row = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let is_null = bitmap[i / 8] & (1 << (i % 8)) != 0;
        if is_null {
            if !col.nullable {
                return Err(DecodeError::invalid(format!(
                    "null bit set for non-nullable column {:?}",
                    col.name
                )));
            }
            row.push(None);
            continue;
        }
        let value = match col.ty {
            ColumnType::String => ColumnValue::String(r.str(&col.name)?),
            ColumnType::Integer => ColumnValue::Integer(r.i64(&col.name)?),
            ColumnType::Float => ColumnValue::Float(r.f64(&col.name)?),
            ColumnType::Boolean => ColumnValue::Boolean(r.bool(&col.name)?),
            ColumnType::Json => ColumnValue::Json(r.json(&col.name)?),
            ColumnType::Bytes => ColumnValue::Bytes(r.bytes(&col.name)?),
        };
        row.push(Some(value));
    }
    Ok(row)
}

/// Encode one row canonically per §2.4.
pub fn encode_row(w: &mut Writer, columns: &[Column], row: &Row) {
    let bitmap_len = columns.len().div_ceil(8);
    let mut bitmap = vec![0u8; bitmap_len];
    for (i, value) in row.iter().enumerate() {
        if value.is_none() {
            bitmap[i / 8] |= 1 << (i % 8);
        }
    }
    w.raw(&bitmap);
    for value in row.iter().flatten() {
        match value {
            ColumnValue::String(s) => w.str(s),
            ColumnValue::Integer(v) => w.i64(*v),
            ColumnValue::Float(v) => w.f64(*v),
            ColumnValue::Boolean(v) => w.bool(*v),
            ColumnValue::Json(j) => w.str(&j.0),
            ColumnValue::Bytes(b) => w.bytes(b),
        }
    }
}

/// Decode a complete SSG2 rows segment (§5.2). Structural validation only —
/// exactly the closed §5.2 failure list, every failure `sync.invalid_request`.
pub fn decode_rows_segment(bytes: &[u8]) -> Result<RowsSegment> {
    let mut r = Reader::new(bytes);
    let magic = r.take(4, "SSG2 magic")?;
    if magic != SSG2_MAGIC {
        return Err(DecodeError::invalid("bad SSG2 magic"));
    }
    let format_version = r.u16("formatVersion")?;
    if format_version != SSG2_FORMAT_VERSION {
        return Err(DecodeError::invalid(format!(
            "unsupported SSG2 formatVersion {format_version}"
        )));
    }
    let flags = r.u16("flags")?;
    if flags != 0 {
        return Err(DecodeError::invalid(format!(
            "SSG2 flags must be 0, got 0x{flags:04x}"
        )));
    }

    let table = r.str("table")?;
    let schema_version = r.i32("schemaVersion")?;
    let column_count = r.u16("column count")? as usize;
    let mut columns = Vec::with_capacity(column_count);
    for _ in 0..column_count {
        let name = r.str("column name")?;
        let tag = r.u8("column type")?;
        let ty = ColumnType::from_tag(tag).ok_or_else(|| {
            DecodeError::invalid(format!("unknown column type tag {tag} for column {name:?}"))
        })?;
        let col_flags = r.u8("column flags")?;
        if col_flags & !0x01 != 0 {
            return Err(DecodeError::invalid(format!(
                "reserved column flag bits set for column {name:?} (0x{col_flags:02x})"
            )));
        }
        columns.push(Column {
            name,
            ty,
            nullable: col_flags & 0x01 != 0,
        });
    }

    let mut blocks: Vec<Vec<Row>> = Vec::new();
    loop {
        let row_count = r.u32("block rowCount")? as usize;
        if row_count == 0 {
            // End-of-segment marker: nothing follows it.
            if !r.is_empty() {
                return Err(DecodeError::invalid(
                    "trailing bytes after the SSG2 end-of-segment marker",
                ));
            }
            break;
        }
        let byte_length = r.u32("block byteLength")? as usize;
        let row_bytes = r.take(byte_length, "block rows")?;
        let mut rr = Reader::new(row_bytes);
        let mut rows = Vec::with_capacity(row_count.min(4096));
        for _ in 0..row_count {
            rows.push(decode_row(&mut rr, &columns)?);
        }
        if !rr.is_empty() {
            return Err(DecodeError::invalid(
                "block rows do not consume exactly byteLength bytes",
            ));
        }
        blocks.push(rows);
    }
    Ok(RowsSegment {
        table,
        schema_version,
        columns,
        blocks,
    })
}

/// Canonically encode a rows segment (§5.2).
pub fn encode_rows_segment(seg: &RowsSegment) -> Vec<u8> {
    let mut w = Writer::new();
    w.raw(SSG2_MAGIC);
    w.u16(SSG2_FORMAT_VERSION);
    w.u16(0); // flags
    w.str(&seg.table);
    w.i32(seg.schema_version);
    w.u16(seg.columns.len() as u16);
    for col in &seg.columns {
        w.str(&col.name);
        w.u8(col.ty.tag());
        w.u8(u8::from(col.nullable));
    }
    for block in &seg.blocks {
        let mut bw = Writer::new();
        for row in block {
            encode_row(&mut bw, &seg.columns, row);
        }
        let row_bytes = bw.into_bytes();
        w.u32(block.len() as u32);
        w.u32(row_bytes.len() as u32);
        w.raw(&row_bytes);
    }
    w.u32(0); // end-of-segment marker
    w.into_bytes()
}
