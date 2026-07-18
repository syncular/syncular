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
    /// Portable per-table selector: the named non-encrypted string column in
    /// each plaintext row contains the key id used for new envelopes.
    pub key_id_columns: HashMap<String, String>,
}

impl Drop for EncryptionConfig {
    fn drop(&mut self) {
        // Best-effort native key hygiene: replacement, preflight entry, and
        // client shutdown overwrite every owned key buffer before release.
        for key in self.keys.values_mut() {
            key.fill(0);
        }
    }
}

impl EncryptionConfig {
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// §5.11 portable key selection: configured row column, then table name.
    pub fn key_id_for(&self, table: &TableSchema, row: &Row) -> Result<String, String> {
        let Some(column_name) = self.key_id_columns.get(&table.name) else {
            return Ok(table.name.clone());
        };
        let Some(index) = table
            .columns
            .iter()
            .position(|column| &column.name == column_name)
        else {
            return Err(format!(
                "client.decrypt_failed: encryption key-id column {column_name:?} is not present on table {:?}",
                table.name
            ));
        };
        if table
            .encrypted_columns
            .iter()
            .any(|column| column.index == index)
        {
            return Err(format!(
                "client.decrypt_failed: encryption key-id column {column_name:?} on table {:?} must not be encrypted",
                table.name
            ));
        }
        match row.get(index).and_then(|value| value.as_ref()) {
            Some(ColumnValue::String(key_id)) if !key_id.is_empty() => Ok(key_id.clone()),
            _ => Err(format!(
                "client.decrypt_failed: encryption key-id column {column_name:?} on table {:?} must contain a non-empty string",
                table.name
            )),
        }
    }
}

/// The pinned §12 snake→camel conversion (DESIGN-queries.md §5) — the Rust
/// copy of the typegen/TS-client algorithm, kept in lockstep by shared test
/// vectors. Leading/trailing `_` runs are preserved; middle segments split
/// on `_` (doubled underscores drop); no acronym awareness.
pub fn snake_to_camel(name: &str) -> String {
    let is_mappable = {
        let bare = name.trim_start_matches('_');
        !bare.is_empty()
            && bare.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    if !is_mappable {
        return name.to_owned();
    }
    let lead_len = name.len() - name.trim_start_matches('_').len();
    let (lead, bare) = name.split_at(lead_len);
    let trail_len = bare.len() - bare.trim_end_matches('_').len();
    let (middle, trail) = bare.split_at(bare.len() - trail_len);
    let mut segments = middle.split('_').filter(|s| !s.is_empty());
    let Some(first) = segments.next() else {
        return name.to_owned();
    };
    let mut out = String::with_capacity(name.len());
    out.push_str(lead);
    out.push_str(first);
    for segment in segments {
        let mut chars = segment.chars();
        if let Some(head) = chars.next() {
            out.push(head.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out.push_str(trail);
    out
}

/// §5 mutate key normalization: accept BOTH casings for upsert value keys —
/// the SQL-truth snake_case and the generated row types' camelCase. A camel
/// key renames to its column's SQL name when that is unambiguous (the alias
/// equals no other column's exact name, and no two columns share it). A
/// column given in both casings is an error. Unknown keys fail loud, matching
/// the TypeScript core; silently dropping an app field would corrupt a
/// full-row mutation while appearing successful.
pub fn normalize_values_casing(
    table: &TableSchema,
    mut values: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    for column in &table.columns {
        let camel = snake_to_camel(&column.name);
        if camel == column.name {
            continue;
        }
        // Exact names always win; an alias colliding with another column's
        // real name (or with another column's alias) is not an alias.
        if table.columns.iter().any(|c| c.name == camel) {
            continue;
        }
        if table
            .columns
            .iter()
            .filter(|c| snake_to_camel(&c.name) == camel)
            .count()
            > 1
        {
            continue;
        }
        if let Some(value) = values.remove(&camel) {
            if values.contains_key(&column.name) {
                return Err(format!(
                    "table {:?}: column {:?} appears twice in mutation values (as both snake_case and camelCase) — pass it once",
                    table.name, column.name
                ));
            }
            values.insert(column.name.clone(), value);
        }
    }
    for key in values.keys() {
        if !table.columns.iter().any(|column| column.name == *key) {
            if key.starts_with("_sync_") {
                return Err(format!(
                    "table {:?}: {:?} is an internal sync column and cannot appear in mutation values",
                    table.name, key
                ));
            }
            return Err(format!(
                "table {:?}: unknown column {:?} in mutation values (snake_case and camelCase keys are accepted)",
                table.name, key
            ));
        }
    }
    Ok(values)
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
        let value = json_to_column_value(column, values.get(&column.name))?;
        if value.is_none() && !column.nullable {
            return Err(format!(
                "table {:?}: column {:?} is not nullable (§6.1 full-row payloads)",
                table.name, column.name
            ));
        }
        row.push(value);
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
    _row_id: &str,
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
        let key_id = encryption.key_id_for(table, row)?;
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
        ColumnValue::Crdt(_) => return Err("crdt columns cannot be encrypted (§5.11)".to_owned()),
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

#[cfg(test)]
mod naming_tests {
    use serde_json::{json, Map, Value};
    use ssp2::segment::{Column, ColumnType, ColumnValue, Row};

    use super::{normalize_values_casing, snake_to_camel, EncryptionConfig};
    use crate::schema::{EncryptedColumn, TableSchema};

    #[test]
    fn snake_to_camel_pinned_vectors() {
        for (input, expected) in [
            ("created_at", "createdAt"),
            ("col_2", "col2"),
            ("user_id", "userId"),
            ("_internal", "_internal"),
            ("__foo_bar", "__fooBar"),
            ("row_", "row_"),
            ("id_url", "idUrl"),
            ("api_key", "apiKey"),
            ("title", "title"),
            ("alreadyCamel", "alreadyCamel"),
            ("a__b", "aB"),
            ("_lead_and_trail_", "_leadAndTrail_"),
            ("count(*)", "count(*)"),
        ] {
            assert_eq!(snake_to_camel(input), expected, "input {input:?}");
        }
    }

    #[test]
    fn portable_key_selector_reads_a_non_encrypted_string_column() {
        let columns = vec![
            Column {
                name: "id".to_owned(),
                ty: ColumnType::String,
                nullable: false,
            },
            Column {
                name: "encryption_key_id".to_owned(),
                ty: ColumnType::String,
                nullable: false,
            },
            Column {
                name: "note".to_owned(),
                ty: ColumnType::String,
                nullable: false,
            },
        ];
        let table = TableSchema {
            name: "patients".to_owned(),
            columns: columns.clone(),
            wire_columns: columns,
            primary_key: "id".to_owned(),
            pk_index: 0,
            scope_variables: Vec::new(),
            indexes: Vec::new(),
            fts_indexes: Vec::new(),
            encrypted_columns: vec![EncryptedColumn {
                index: 2,
                declared_type: "string".to_owned(),
            }],
        };
        let mut config = EncryptionConfig::default();
        config
            .key_id_columns
            .insert("patients".to_owned(), "encryption_key_id".to_owned());
        let row: Row = vec![
            Some(ColumnValue::String("patient-1".to_owned())),
            Some(ColumnValue::String("practice-key-v1".to_owned())),
            Some(ColumnValue::String("Identity".to_owned())),
        ];
        assert_eq!(
            config.key_id_for(&table, &row).expect("selects key"),
            "practice-key-v1"
        );
    }

    fn table(names: &[&str]) -> TableSchema {
        let columns: Vec<Column> = names
            .iter()
            .map(|n| Column {
                name: (*n).to_owned(),
                ty: ColumnType::String,
                nullable: true,
            })
            .collect();
        TableSchema {
            name: "t".to_owned(),
            columns: columns.clone(),
            wire_columns: columns,
            primary_key: "id".to_owned(),
            pk_index: 0,
            scope_variables: Vec::new(),
            indexes: Vec::new(),
            fts_indexes: Vec::new(),
            encrypted_columns: Vec::new(),
        }
    }

    fn map(entries: &[(&str, &str)]) -> Map<String, Value> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect()
    }

    #[test]
    fn camel_keys_normalize_to_sql_names() {
        let t = table(&["id", "list_id", "updated_at_ms"]);
        let out = normalize_values_casing(
            &t,
            map(&[("id", "x"), ("listId", "l"), ("updatedAtMs", "9")]),
        )
        .expect("normalizes");
        assert_eq!(out.get("list_id"), Some(&json!("l")));
        assert_eq!(out.get("updated_at_ms"), Some(&json!("9")));
        assert!(!out.contains_key("listId"));
    }

    #[test]
    fn snake_keys_pass_through() {
        let t = table(&["id", "list_id"]);
        let out = normalize_values_casing(&t, map(&[("id", "x"), ("list_id", "l")])).expect("ok");
        assert_eq!(out.get("list_id"), Some(&json!("l")));
    }

    #[test]
    fn both_casings_for_one_column_is_an_error() {
        let t = table(&["id", "list_id"]);
        let err = normalize_values_casing(&t, map(&[("list_id", "a"), ("listId", "b")]))
            .expect_err("rejects");
        assert!(err.contains("both snake_case and camelCase"), "{err}");
    }

    #[test]
    fn an_alias_colliding_with_a_real_column_never_steals_it() {
        // `col_2` camel-maps to `col2`, which IS a column: exact wins, no rename.
        let t = table(&["id", "col_2", "col2"]);
        let out = normalize_values_casing(&t, map(&[("id", "x"), ("col2", "v")])).expect("ok");
        assert_eq!(out.get("col2"), Some(&json!("v")));
        assert!(!out.contains_key("col_2"));
    }

    #[test]
    fn unknown_and_internal_columns_fail_loud() {
        let t = table(&["id", "title"]);
        let unknown = normalize_values_casing(&t, map(&[("id", "x"), ("typo", "v")]))
            .expect_err("unknown field");
        assert!(unknown.contains("unknown column"), "{unknown}");
        let internal = normalize_values_casing(&t, map(&[("id", "x"), ("_sync_version", "1")]))
            .expect_err("internal field");
        assert!(internal.contains("internal sync column"), "{internal}");
    }
}
