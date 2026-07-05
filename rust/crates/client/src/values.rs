//! Value conversions at the client's edges: driver JSON (`{"$bytes": hex}`
//! convention) ↔ the §2.4 row-codec values ↔ SQLite storage, plus the §11.2
//! canonical scope JSON (contractual across implementations).

use std::collections::HashMap;

use serde_json::{Map, Value};
use ssp2::primitives::{RawJson, Reader, Writer};
use ssp2::segment::{decode_row, encode_row, Column, ColumnType, ColumnValue, Row};
use ssp2::util::utf16_lt;

use crate::schema::TableSchema;

/// §5.11 client-side encryption keys (`keyId → 32-byte key`) plus optional
/// key selection. Empty ⇒ E2EE off. `key_id_for` defaults to per-table
/// (`keyId = table`). Always present on the client; the crypto is compiled
/// only under the `e2ee` feature.
#[derive(Debug, Clone, Default)]
pub struct EncryptionConfig {
    pub keys: HashMap<String, Vec<u8>>,
}

impl EncryptionConfig {
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// §5.11 default key selection: per-table (`keyId = table`).
    pub fn key_id_for(&self, table: &str, _row_id: &str) -> String {
        table.to_owned()
    }
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("odd-length hex string".to_owned());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for pair in bytes.chunks(2) {
        let s = std::str::from_utf8(pair).map_err(|_| "non-ASCII hex".to_owned())?;
        out.push(u8::from_str_radix(s, 16).map_err(|e| format!("bad hex: {e}"))?);
    }
    Ok(out)
}

/// Driver JSON value → row-codec value for one column. `null`/absent maps to
/// NULL; bytes travel as `{"$bytes": "<hex>"}`.
pub fn json_to_column_value(
    column: &Column,
    value: Option<&Value>,
) -> Result<Option<ColumnValue>, String> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => v,
    };
    let fail = |expected: &str| {
        Err(format!(
            "column {:?}: expected {expected}, got {value}",
            column.name
        ))
    };
    match column.ty {
        ColumnType::String => match value.as_str() {
            Some(s) => Ok(Some(ColumnValue::String(s.to_owned()))),
            None => fail("a string"),
        },
        ColumnType::Integer => match value.as_i64() {
            Some(i) => Ok(Some(ColumnValue::Integer(i))),
            None => fail("an integer"),
        },
        ColumnType::Float => match value.as_f64() {
            Some(f) => Ok(Some(ColumnValue::Float(f))),
            None => fail("a number"),
        },
        ColumnType::Boolean => match value.as_bool() {
            Some(b) => Ok(Some(ColumnValue::Boolean(b))),
            None => fail("a boolean"),
        },
        // `json` columns stay raw strings at the driver boundary (§2.4).
        ColumnType::Json => match value.as_str() {
            Some(s) => Ok(Some(ColumnValue::Json(RawJson(s.to_owned())))),
            None => fail("a raw JSON string"),
        },
        // `blob_ref` (tag 7) also stays a raw string at the boundary (§5.9.1).
        ColumnType::BlobRef => match value.as_str() {
            Some(s) => Ok(Some(ColumnValue::BlobRef(RawJson(s.to_owned())))),
            None => fail("a raw BlobRef JSON string"),
        },
        ColumnType::Bytes => match value.get("$bytes").and_then(Value::as_str) {
            Some(hex) => Ok(Some(ColumnValue::Bytes(hex_to_bytes(hex)?))),
            None => fail("a {\"$bytes\": hex} object"),
        },
        // §5.10: crdt bytes cross the boundary as {"$bytes": hex}, like bytes.
        ColumnType::Crdt => match value.get("$bytes").and_then(Value::as_str) {
            Some(hex) => Ok(Some(ColumnValue::Crdt(hex_to_bytes(hex)?))),
            None => fail("a {\"$bytes\": hex} object"),
        },
    }
}

/// Row-codec value → driver JSON value.
pub fn column_value_to_json(value: &Option<ColumnValue>) -> Value {
    match value {
        None => Value::Null,
        Some(ColumnValue::String(s)) => Value::from(s.clone()),
        Some(ColumnValue::Integer(i)) => Value::from(*i),
        Some(ColumnValue::Float(f)) => {
            serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number)
        }
        Some(ColumnValue::Boolean(b)) => Value::from(*b),
        Some(ColumnValue::Json(raw)) => Value::from(raw.0.clone()),
        Some(ColumnValue::BlobRef(raw)) => Value::from(raw.0.clone()),
        Some(ColumnValue::Bytes(bytes)) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(bytes)));
            Value::Object(map)
        }
        Some(ColumnValue::Crdt(bytes)) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(bytes)));
            Value::Object(map)
        }
    }
}

/// Encode one full row (driver JSON values keyed by column name) with the
/// generated row codec (§2.4, §6.1). §5.11: encrypted columns are encrypted
/// here — the encode-at-send seam — before the codec serializes them as
/// ciphertext-envelope `bytes` using `wire_columns`.
pub fn encode_row_json(
    table: &TableSchema,
    row_id: &str,
    values: &Map<String, Value>,
    encryption: &EncryptionConfig,
) -> Result<Vec<u8>, String> {
    // Build the row from the LOCAL (declared-type) columns.
    let mut row: Row = Vec::with_capacity(table.columns.len());
    for column in &table.columns {
        row.push(json_to_column_value(column, values.get(&column.name))?);
    }
    if table.has_encrypted_columns() {
        encrypt_row(table, row_id, &mut row, encryption)?;
    }
    // Serialize with the WIRE columns (encrypted columns are `bytes`).
    let mut w = Writer::new();
    encode_row(&mut w, &table.wire_columns, &row);
    Ok(w.into_bytes())
}

/// Decode one row-codec payload; trailing bytes are a decode error. §5.11:
/// encrypted columns are decrypted here — the apply seam — back to their
/// declared-type plaintext value for the local mirror.
pub fn decode_row_bytes(
    table: &TableSchema,
    payload: &[u8],
    encryption: &EncryptionConfig,
) -> Result<Row, String> {
    let mut r = Reader::new(payload);
    // Decode with the WIRE columns (encrypted columns arrive as `bytes`).
    let mut row = decode_row(&mut r, &table.wire_columns).map_err(|e| e.to_string())?;
    if !r.is_empty() {
        return Err("row payload has trailing bytes".to_owned());
    }
    if table.has_encrypted_columns() {
        decrypt_row(table, &mut row, encryption)?;
    }
    Ok(row)
}

/// §5.11: decrypt the encrypted columns of an already-decoded segment row
/// (rows segments decode via their own column table, so decryption is a
/// post-decode pass over the positional values).
pub fn decrypt_segment_row(
    table: &TableSchema,
    row: &mut Row,
    encryption: &EncryptionConfig,
) -> Result<(), String> {
    decrypt_row(table, row, encryption)
}

// -- §5.11 encrypt/decrypt seam (feature-gated) ------------------------------

#[cfg(feature = "e2ee")]
fn encrypt_row(
    table: &TableSchema,
    row_id: &str,
    row: &mut Row,
    encryption: &EncryptionConfig,
) -> Result<(), String> {
    use rand_core::RngCore;
    use ssp2::crypto::{encrypt_value, NONCE_LENGTH};
    for enc in &table.encrypted_columns {
        let Some(value) = row.get(enc.index).and_then(|v| v.as_ref()) else {
            continue; // NULL stays NULL (§5.11)
        };
        let plain = column_value_to_plain(value)?;
        let key_id = encryption.key_id_for(&table.name, row_id);
        let key = encryption
            .keys
            .get(&key_id)
            .ok_or_else(|| format!("client.decrypt_failed: no key for keyId {key_id:?}"))?;
        let mut nonce = [0u8; NONCE_LENGTH];
        rand_core::OsRng.fill_bytes(&mut nonce);
        let envelope = encrypt_value(&plain, &key_id, key, nonce)?;
        row[enc.index] = Some(ColumnValue::Bytes(envelope));
    }
    Ok(())
}

#[cfg(feature = "e2ee")]
fn decrypt_row(
    table: &TableSchema,
    row: &mut Row,
    encryption: &EncryptionConfig,
) -> Result<(), String> {
    use ssp2::crypto::{decrypt_value, DeclaredType};
    for enc in &table.encrypted_columns {
        let Some(value) = row.get(enc.index).and_then(|v| v.as_ref()) else {
            continue;
        };
        let ColumnValue::Bytes(envelope) = value else {
            return Err(format!(
                "client.decrypt_failed: encrypted column at index {} is not bytes",
                enc.index
            ));
        };
        let declared = DeclaredType::from_name(&enc.declared_type)
            .ok_or_else(|| format!("unknown declaredType {:?}", enc.declared_type))?;
        let keys = &encryption.keys;
        let plain = decrypt_value(declared, envelope, |id| keys.get(id).cloned())
            .map_err(|e| e.to_string())?;
        row[enc.index] = Some(plain_to_column_value(plain));
    }
    Ok(())
}

/// Without the `e2ee` feature, a schema with encrypted columns is a
/// misconfiguration — fail loud rather than ship plaintext.
#[cfg(not(feature = "e2ee"))]
fn encrypt_row(
    table: &TableSchema,
    _row_id: &str,
    _row: &mut Row,
    _encryption: &EncryptionConfig,
) -> Result<(), String> {
    Err(format!(
        "table {:?} has encrypted columns but this build lacks the e2ee feature (§5.11)",
        table.name
    ))
}

#[cfg(not(feature = "e2ee"))]
fn decrypt_row(
    table: &TableSchema,
    _row: &mut Row,
    _encryption: &EncryptionConfig,
) -> Result<(), String> {
    Err(format!(
        "table {:?} has encrypted columns but this build lacks the e2ee feature (§5.11)",
        table.name
    ))
}

#[cfg(feature = "e2ee")]
fn column_value_to_plain(value: &ColumnValue) -> Result<ssp2::crypto::PlainValue, String> {
    use ssp2::crypto::PlainValue;
    Ok(match value {
        ColumnValue::String(s) => PlainValue::String(s.clone()),
        ColumnValue::Integer(i) => PlainValue::Integer(*i),
        ColumnValue::Float(f) => PlainValue::Float(*f),
        ColumnValue::Boolean(b) => PlainValue::Boolean(*b),
        ColumnValue::Json(j) => PlainValue::Json(j.0.clone()),
        ColumnValue::BlobRef(j) => PlainValue::BlobRef(j.0.clone()),
        ColumnValue::Bytes(b) => PlainValue::Bytes(b.clone()),
        ColumnValue::Crdt(_) => {
            return Err("crdt columns cannot be encrypted (§5.11)".to_owned())
        }
    })
}

#[cfg(feature = "e2ee")]
fn plain_to_column_value(value: ssp2::crypto::PlainValue) -> ColumnValue {
    use ssp2::crypto::PlainValue;
    match value {
        PlainValue::String(s) => ColumnValue::String(s),
        PlainValue::Integer(i) => ColumnValue::Integer(i),
        PlainValue::Float(f) => ColumnValue::Float(f),
        PlainValue::Boolean(b) => ColumnValue::Boolean(b),
        PlainValue::Json(s) => ColumnValue::Json(RawJson(s)),
        PlainValue::BlobRef(s) => ColumnValue::BlobRef(RawJson(s)),
        PlainValue::Bytes(b) => ColumnValue::Bytes(b),
    }
}

/// Render a primary-key value as the wire `rowId` string.
pub fn render_row_id(value: &Option<ColumnValue>) -> Result<String, String> {
    match value {
        Some(ColumnValue::String(s)) => Ok(s.clone()),
        Some(ColumnValue::Integer(i)) => Ok(i.to_string()),
        Some(ColumnValue::Float(f)) => Ok(f.to_string()),
        Some(ColumnValue::Boolean(b)) => Ok(b.to_string()),
        Some(ColumnValue::Json(raw)) => Ok(raw.0.clone()),
        Some(ColumnValue::BlobRef(_)) => Err("blob_ref column cannot be a rowId".to_owned()),
        Some(ColumnValue::Bytes(_)) => Err("bytes column cannot be a rowId".to_owned()),
        Some(ColumnValue::Crdt(_)) => Err("crdt column cannot be a rowId".to_owned()),
        None => Err("primary key value is missing".to_owned()),
    }
}

/// Driver JSON value → wire `rowId` string (for optimistic upserts).
pub fn render_row_id_json(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        Some(Value::Bool(b)) => Ok(b.to_string()),
        _ => Err("primary key value is missing or not renderable".to_owned()),
    }
}

fn sort_utf16(values: &mut [String]) {
    values.sort_by(|a, b| {
        if utf16_lt(a, b) {
            std::cmp::Ordering::Less
        } else if utf16_lt(b, a) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
}

/// Sort scope-map keys into ascending code-unit order (the canonical `map`
/// encoding of the Conventions section).
pub fn sort_scope_map(map: &mut [(String, Vec<String>)]) {
    map.sort_by(|a, b| {
        if utf16_lt(&a.0, &b.0) {
            std::cmp::Ordering::Less
        } else if utf16_lt(&b.0, &a.0) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
}

/// §11.2 canonical JSON of a scope map: keys sorted by code-unit, value
/// lists sorted and deduplicated, no insignificant whitespace.
pub fn canonical_scope_json(scopes: &[(String, Vec<String>)]) -> String {
    let mut entries: Vec<(String, Vec<String>)> = scopes.to_vec();
    sort_scope_map(&mut entries);
    let mut out = String::from("{");
    for (i, (key, values)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let mut sorted = values.clone();
        sort_utf16(&mut sorted);
        sorted.dedup();
        out.push_str(&serde_json::to_string(key).expect("string serializes"));
        out.push_str(":[");
        for (j, value) in sorted.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(value).expect("string serializes"));
        }
        out.push(']');
    }
    out.push('}');
    out
}

/// Scope map as a driver JSON object (`variable → list of values`, §3.2).
pub fn scope_map_to_json(scopes: &[(String, Vec<String>)]) -> Value {
    let mut map = Map::new();
    for (key, values) in scopes {
        map.insert(
            key.clone(),
            Value::Array(values.iter().map(|v| Value::from(v.clone())).collect()),
        );
    }
    Value::Object(map)
}

/// Driver JSON object → scope map, preserving key order.
pub fn json_to_scope_map(value: &Value) -> Result<Vec<(String, Vec<String>)>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "scope map must be an object".to_owned())?;
    let mut out = Vec::with_capacity(object.len());
    for (key, values) in object {
        let list = values
            .as_array()
            .ok_or_else(|| format!("scope values for {key:?} must be a list (§0)"))?;
        let mut strings = Vec::with_capacity(list.len());
        for v in list {
            strings.push(
                v.as_str()
                    .ok_or_else(|| format!("scope value for {key:?} is not a string"))?
                    .to_owned(),
            );
        }
        out.push((key.clone(), strings));
    }
    Ok(out)
}
