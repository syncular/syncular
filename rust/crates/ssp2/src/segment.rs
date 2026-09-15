//! SSG2 rows segments (SPEC.md §5.2) and the §2.4 generated-row codec they
//! embed, plus the sparse row codec push payloads use (RFC §6.1). All
//! structural decode failures are `sync.invalid_request` (§5.2 error-code
//! rule); the column-table-vs-generated-schema comparison
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
    /// §2.4 tag 7 (§5.9): a canonical BlobRef JSON document, codec-shaped
    /// identically to `json`.
    BlobRef,
    /// §2.4 tag 8 (§5.10): opaque server-merged CRDT bytes, codec-shaped
    /// identically to `bytes`. The Rust client round-trips the bytes; merging
    /// is server-side (§5.10.5).
    Crdt,
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
            7 => Some(ColumnType::BlobRef),
            8 => Some(ColumnType::Crdt),
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
            ColumnType::BlobRef => 7,
            ColumnType::Crdt => 8,
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
            ColumnType::BlobRef => "blob_ref",
            ColumnType::Crdt => "crdt",
        }
    }

    /// Inverse of [`ColumnType::name`] — the golden-vector harness rebuilds a
    /// column table from its §11 rendering, which carries names, not tags.
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "string" => ColumnType::String,
            "integer" => ColumnType::Integer,
            "float" => ColumnType::Float,
            "boolean" => ColumnType::Boolean,
            "json" => ColumnType::Json,
            "bytes" => ColumnType::Bytes,
            "blob_ref" => ColumnType::BlobRef,
            "crdt" => ColumnType::Crdt,
            _ => return None,
        })
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
    /// §5.9.1: a canonical BlobRef document, held as a raw validated string.
    BlobRef(RawJson),
    /// §5.10: opaque CRDT bytes (server-merged; the Rust client only
    /// round-trips them), codec-shaped identically to `bytes`.
    Crdt(Vec<u8>),
}

/// One row: `columns.len()` slots, `None` = NULL.
pub type Row = Vec<Option<ColumnValue>>;

/// One sparse-row slot (SPEC.md §2.4, RFC §6.1): `Absent` when the column is
/// not in the payload (an apply leaves the stored value untouched), `Null`
/// when it is present and NULL.
#[derive(Debug, Clone, PartialEq)]
pub enum SparseSlot {
    Absent,
    Null,
    Value(ColumnValue),
}

/// A decoded sparse row: one slot per column, in declaration order.
pub type SparseRow = Vec<SparseSlot>;

/// One §5.2 row record: the row's `server_version` (≥ 1) plus its values.
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentRow {
    pub server_version: i64,
    pub values: Row,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowsSegment {
    pub table: String,
    pub schema_version: i32,
    pub columns: Vec<Column>,
    /// Row blocks in wire order; block boundaries are part of the canonical
    /// byte stream and are preserved for re-encoding.
    pub blocks: Vec<Vec<SegmentRow>>,
}

/// Read one non-null column value per the §2.4 column-type table.
fn read_column_value(r: &mut Reader<'_>, col: &Column) -> Result<ColumnValue> {
    Ok(match col.ty {
        ColumnType::String => ColumnValue::String(r.str(&col.name)?),
        ColumnType::Integer => ColumnValue::Integer(r.i64(&col.name)?),
        ColumnType::Float => ColumnValue::Float(r.f64(&col.name)?),
        ColumnType::Boolean => ColumnValue::Boolean(r.bool(&col.name)?),
        ColumnType::Json => ColumnValue::Json(r.json(&col.name)?),
        ColumnType::Bytes => ColumnValue::Bytes(r.bytes(&col.name)?),
        ColumnType::BlobRef => ColumnValue::BlobRef(r.blob_ref(&col.name)?),
        // §5.10 tag 8: opaque bytes, decoded exactly like tag 6.
        ColumnType::Crdt => ColumnValue::Crdt(r.bytes(&col.name)?),
    })
}

/// Write one non-null column value per the §2.4 column-type table.
fn write_column_value(w: &mut Writer, value: &ColumnValue) {
    match value {
        ColumnValue::String(s) => w.str(s),
        ColumnValue::Integer(v) => w.i64(*v),
        ColumnValue::Float(v) => w.f64(*v),
        ColumnValue::Boolean(v) => w.bool(*v),
        ColumnValue::Json(j) => w.str(&j.0),
        ColumnValue::Bytes(b) => w.bytes(b),
        ColumnValue::BlobRef(j) => w.str(&j.0),
        ColumnValue::Crdt(b) => w.bytes(b),
    }
}

/// One bit of a bitmap: LSB-first within byte `index / 8`.
fn bitmap_bit(bitmap: &[u8], index: usize) -> bool {
    bitmap[index / 8] & (1 << (index % 8)) != 0
}

fn set_bitmap_bit(bitmap: &mut [u8], index: usize) {
    bitmap[index / 8] |= 1 << (index % 8);
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
        row.push(Some(read_column_value(r, col)?));
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
        write_column_value(w, value);
    }
}

/// Decode one standalone sparse row (SPEC.md §2.4, RFC §6.1): the bytes must
/// contain exactly one row. `primary_key_index` is the row's primary-key
/// column; its presence bit MUST be set.
///
/// Decode validates in this order, each a `sync.invalid_request` decode error:
/// a set presence padding bit, an absent primary key, a set null-bitmap
/// padding bit (a null for an absent column), a null bit for a non-nullable
/// column.
pub fn decode_sparse_row(
    columns: &[Column],
    primary_key_index: usize,
    bytes: &[u8],
) -> Result<SparseRow> {
    let mut r = Reader::new(bytes);
    let presence_len = columns.len().div_ceil(8);
    let presence = r.take(presence_len, "sparse row presence bitmap")?.to_vec();
    for bit in columns.len()..presence_len * 8 {
        if bitmap_bit(&presence, bit) {
            return Err(DecodeError::invalid(
                "sparse row presence bitmap has a set padding bit (non-canonical encoding)",
            ));
        }
    }
    let primary_key = columns.get(primary_key_index);
    if primary_key.is_none() || !bitmap_bit(&presence, primary_key_index) {
        return Err(DecodeError::invalid(format!(
            "sparse row is missing the primary-key column {}",
            primary_key.map_or(primary_key_index.to_string(), |c| format!("{:?}", c.name))
        )));
    }
    let present_count: usize = presence.iter().map(|b| b.count_ones() as usize).sum();
    let null_len = present_count.div_ceil(8);
    let nulls = r.take(null_len, "sparse row null bitmap")?.to_vec();
    for bit in present_count..null_len * 8 {
        if bitmap_bit(&nulls, bit) {
            return Err(DecodeError::invalid(
                "sparse row null bitmap sets a null bit for an absent column",
            ));
        }
    }
    let mut row: SparseRow = Vec::with_capacity(columns.len());
    let mut present_index = 0usize;
    for (i, col) in columns.iter().enumerate() {
        if !bitmap_bit(&presence, i) {
            row.push(SparseSlot::Absent);
            continue;
        }
        let is_null = bitmap_bit(&nulls, present_index);
        present_index += 1;
        if !is_null {
            row.push(SparseSlot::Value(read_column_value(&mut r, col)?));
            continue;
        }
        if !col.nullable {
            return Err(DecodeError::invalid(format!(
                "null bit set for non-nullable column {:?}",
                col.name
            )));
        }
        row.push(SparseSlot::Null);
    }
    if !r.is_empty() {
        return Err(DecodeError::invalid(
            "trailing bytes after sparse row payload",
        ));
    }
    Ok(row)
}

/// Encode one standalone sparse row canonically (SPEC.md §2.4, RFC §6.1).
/// A row that does not match the column table, or that omits the primary key,
/// is encoder misuse and panics (the full-row codec traps the same misuse).
pub fn encode_sparse_row(columns: &[Column], primary_key_index: usize, row: &SparseRow) -> Vec<u8> {
    assert_eq!(
        row.len(),
        columns.len(),
        "sparse row length must match the column table"
    );
    let mut presence = vec![0u8; columns.len().div_ceil(8)];
    let mut present_count = 0usize;
    for (i, slot) in row.iter().enumerate() {
        if matches!(slot, SparseSlot::Absent) {
            continue;
        }
        set_bitmap_bit(&mut presence, i);
        present_count += 1;
    }
    let primary_key = columns.get(primary_key_index).unwrap_or_else(|| {
        panic!("primary-key column index {primary_key_index} is outside the column table")
    });
    assert!(
        bitmap_bit(&presence, primary_key_index),
        "sparse row is missing the primary-key column {:?}",
        primary_key.name
    );
    let mut nulls = vec![0u8; present_count.div_ceil(8)];
    let mut present_index = 0usize;
    for (i, slot) in row.iter().enumerate() {
        match slot {
            SparseSlot::Absent => continue,
            SparseSlot::Null => {
                let col = &columns[i];
                assert!(col.nullable, "column {:?} is not nullable", col.name);
                set_bitmap_bit(&mut nulls, present_index);
            }
            SparseSlot::Value(_) => {}
        }
        present_index += 1;
    }
    let mut w = Writer::new();
    w.raw(&presence);
    w.raw(&nulls);
    for slot in row {
        if let SparseSlot::Value(value) = slot {
            write_column_value(&mut w, value);
        }
    }
    w.into_bytes()
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

    let mut blocks: Vec<Vec<SegmentRow>> = Vec::new();
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
            // §5.2: each row record leads with the row's server_version.
            let server_version = rr.i64("row serverVersion")?;
            if server_version < 1 {
                return Err(DecodeError::invalid(format!(
                    "row serverVersion must be >= 1, got {server_version}"
                )));
            }
            rows.push(SegmentRow {
                server_version,
                values: decode_row(&mut rr, &columns)?,
            });
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
            bw.i64(row.server_version);
            encode_row(&mut bw, &seg.columns, &row.values);
        }
        let row_bytes = bw.into_bytes();
        w.u32(block.len() as u32);
        w.u32(row_bytes.len() as u32);
        w.raw(&row_bytes);
    }
    w.u32(0); // end-of-segment marker
    w.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC §6.1 fixture: every §2.4 column type across 9 columns, so both
    /// bitmaps carry padding bits.
    fn sparse_columns() -> Vec<Column> {
        vec![
            Column {
                name: "id".to_owned(),
                ty: ColumnType::String,
                nullable: false,
            },
            Column {
                name: "title".to_owned(),
                ty: ColumnType::String,
                nullable: true,
            },
            Column {
                name: "body".to_owned(),
                ty: ColumnType::String,
                nullable: false,
            },
            Column {
                name: "count".to_owned(),
                ty: ColumnType::Integer,
                nullable: true,
            },
            Column {
                name: "score".to_owned(),
                ty: ColumnType::Float,
                nullable: false,
            },
            Column {
                name: "done".to_owned(),
                ty: ColumnType::Boolean,
                nullable: false,
            },
            Column {
                name: "meta".to_owned(),
                ty: ColumnType::Json,
                nullable: true,
            },
            Column {
                name: "blob".to_owned(),
                ty: ColumnType::Bytes,
                nullable: true,
            },
            Column {
                name: "doc".to_owned(),
                ty: ColumnType::Crdt,
                nullable: true,
            },
        ]
    }

    fn partial_row() -> SparseRow {
        vec![
            SparseSlot::Value(ColumnValue::String("n-1".to_owned())),
            SparseSlot::Null,
            SparseSlot::Absent,
            SparseSlot::Absent,
            SparseSlot::Absent,
            SparseSlot::Absent,
            SparseSlot::Value(ColumnValue::Json(RawJson("{\"tags\": [\"a\"]}".to_owned()))),
            SparseSlot::Absent,
            SparseSlot::Absent,
        ]
    }

    fn decode_error(columns: &[Column], bytes: &[u8]) -> String {
        let error =
            decode_sparse_row(columns, 0, bytes).expect_err("sparse payload must be rejected");
        assert_eq!(error.code, crate::error::ErrorCode::InvalidRequest);
        error.detail
    }

    #[test]
    fn partial_row_round_trips_with_a_present_null() {
        let columns = sparse_columns();
        let row = partial_row();
        let bytes = encode_sparse_row(&columns, 0, &row);
        assert_eq!(bytes[0], 0b0100_0011); // columns 0, 1, 6 present
        assert_eq!(bytes[1], 0x00); // presence padding bits zero
        assert_eq!(bytes[2], 0b0000_0010); // present index 1 (title) is NULL
        let decoded = decode_sparse_row(&columns, 0, &bytes).unwrap();
        assert_eq!(decoded, row);
        assert_eq!(encode_sparse_row(&columns, 0, &decoded), bytes);
    }

    #[test]
    fn full_row_still_leads_with_the_presence_bitmap() {
        let columns = sparse_columns();
        let row: SparseRow = vec![
            SparseSlot::Value(ColumnValue::String("n-2".to_owned())),
            SparseSlot::Null,
            SparseSlot::Value(ColumnValue::String("body".to_owned())),
            SparseSlot::Value(ColumnValue::Integer(-7)),
            SparseSlot::Value(ColumnValue::Float(0.125)),
            SparseSlot::Value(ColumnValue::Boolean(false)),
            SparseSlot::Value(ColumnValue::Json(RawJson("{\"k\":true}".to_owned()))),
            SparseSlot::Value(ColumnValue::Bytes(vec![0, 1, 254, 255])),
            SparseSlot::Value(ColumnValue::Crdt(vec![0x01, 0x02, 0xfe])),
        ];
        let bytes = encode_sparse_row(&columns, 0, &row);
        assert_eq!(&bytes[..2], &[0xff, 0x01]);
        assert_eq!(decode_sparse_row(&columns, 0, &bytes).unwrap(), row);
        // The full-row codec writes no presence bitmap: same values, other
        // bytes.
        let full_row: Row = row
            .iter()
            .map(|slot| match slot {
                SparseSlot::Absent => None,
                SparseSlot::Null => None,
                SparseSlot::Value(value) => Some(value.clone()),
            })
            .collect();
        let mut w = Writer::new();
        encode_row(&mut w, &columns, &full_row);
        assert_ne!(w.into_bytes(), bytes);
    }

    #[test]
    fn every_column_count_boundary_round_trips() {
        for count in [1usize, 7, 8, 9] {
            let columns: Vec<Column> = (0..count)
                .map(|i| Column {
                    name: format!("c{i}"),
                    ty: ColumnType::String,
                    nullable: true,
                })
                .collect();
            let row: SparseRow = (0..count)
                .map(|i| {
                    if i > 0 && i % 3 == 0 {
                        SparseSlot::Absent
                    } else if i == 1 {
                        SparseSlot::Null
                    } else {
                        SparseSlot::Value(ColumnValue::String(format!("v{i}")))
                    }
                })
                .collect();
            let bytes = encode_sparse_row(&columns, 0, &row);
            let pad_start = count % 8;
            if pad_start != 0 {
                let last = bytes[count.div_ceil(8) - 1];
                for bit in pad_start..8 {
                    assert_eq!((last >> bit) & 1, 0, "column count {count}");
                }
            }
            let decoded = decode_sparse_row(&columns, 0, &bytes).unwrap();
            assert_eq!(decoded, row, "column count {count}");
            assert_eq!(encode_sparse_row(&columns, 0, &decoded), bytes);
        }
    }

    #[test]
    fn decode_rejects_presence_padding_bits() {
        // Column 9 does not exist: bit 9 of the presence bitmap is padding.
        let columns = sparse_columns();
        let detail = decode_error(&columns, &[0b0000_0001, 0b0000_0010]);
        assert!(
            detail.contains("presence bitmap has a set padding bit"),
            "{detail}"
        );
    }

    #[test]
    fn decode_rejects_a_null_bit_for_an_absent_column() {
        // Only column 0 is present, so null bitmap bit 3 is padding.
        let columns = sparse_columns();
        let detail = decode_error(&columns, &[0b0000_0001, 0x00, 0b0000_1000]);
        assert!(detail.contains("null bit for an absent column"), "{detail}");
    }

    #[test]
    fn decode_rejects_a_null_bit_for_a_non_nullable_column() {
        // Present indices 0 and 1 are id and title; bit 0 marks id NULL.
        let columns = sparse_columns();
        let detail = decode_error(&columns, &[0b0000_0011, 0x00, 0b0000_0001]);
        assert!(
            detail.contains("null bit set for non-nullable column \"id\""),
            "{detail}"
        );
    }

    #[test]
    fn decode_rejects_an_absent_primary_key() {
        let columns = sparse_columns();
        let mut w = Writer::new();
        w.raw(&[0b0000_0010, 0x00]); // title only, no id
        w.u8(0x00); // null bitmap
        w.str("unnamed");
        let detail = decode_error(&columns, &w.into_bytes());
        assert!(
            detail.contains("missing the primary-key column \"id\""),
            "{detail}"
        );
    }

    #[test]
    fn decode_rejects_trailing_bytes() {
        let columns = sparse_columns();
        let mut bytes = encode_sparse_row(&columns, 0, &partial_row());
        bytes.push(0x00);
        let detail = decode_error(&columns, &bytes);
        assert!(detail.contains("trailing bytes"), "{detail}");
    }

    #[test]
    #[should_panic(expected = "is missing the primary-key column \"id\"")]
    fn encode_rejects_a_missing_primary_key() {
        let columns = sparse_columns();
        let row: SparseRow = vec![SparseSlot::Absent; columns.len()];
        encode_sparse_row(&columns, 0, &row);
    }

    #[test]
    #[should_panic(expected = "is not nullable")]
    fn encode_rejects_a_null_in_a_non_nullable_column() {
        let columns = sparse_columns();
        let mut row = partial_row();
        row[0] = SparseSlot::Null;
        encode_sparse_row(&columns, 0, &row);
    }
}
