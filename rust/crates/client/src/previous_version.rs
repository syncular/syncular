//! RFC 0005 previous-version context — phase 1 (the storage half).
//!
//! A schema bump wipes the local replica (§7.4.3), so the rows the app could
//! see a moment ago are gone before the server can re-bootstrap them. This
//! module persists the SEMANTIC schema descriptor (D1), captures a bounded,
//! typed, read-only copy of the pre-reset rows into a SECOND database file
//! beside the replica (D2/D3/A4), and discards that file.
//!
//! Three rules shape the implementation:
//!
//! - Storage is a sibling FILE `<replica path>.prev-context`, never a table in
//!   the replica connection. The guarantee is stated narrowly: an older
//!   client's ordinary query connection does not attach this file, so no SQL it
//!   runs can reach the container. It is NOT protection against arbitrary
//!   filesystem access, and the filename is a code constant (not a secret).
//! - The capture is typed by the OLD schema's [`LocalSchemaDescriptor`]. SQLite
//!   affinity cannot recover a semantic type (`boolean` and `integer` are both
//!   INTEGER; `string`, `json` and `blob_ref` are all TEXT), so a
//!   descriptor-free capture would be undecodable. It is NEVER inferred.
//! - Every budget is measured BEFORE any row is materialized. An over-budget
//!   capture stores nothing and leaves no file behind.
//!
//! Phase 2 (commands, bridges, conformance) layers the read surface, the
//! compatibility audit and the lifetime triggers on top; this module owns only
//! the descriptor, the container file and its capture/discard semantics.

use std::collections::BTreeSet;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use ssp2::segment::{Column, ColumnType};

use crate::client::{meta_delete, meta_get, meta_set, quote_ident, sql_ref_to_json};
use crate::schema::ClientSchema;
use crate::values::{bytes_to_hex, column_value_to_json, json_to_column_value};

/// `_syncular_meta` key holding the persisted [`LocalSchemaDescriptor`] (D1).
pub const LOCAL_SCHEMA_DESCRIPTOR_KEY: &str = "localSchemaDescriptor";
/// `_syncular_meta` key holding only a capture REFUSAL. The successful record
/// lives inside the container file, so this key is absent when a container is
/// present. It stays in the replica because it is small and typed.
pub const PREVIOUS_VERSION_CONTEXT_KEY: &str = "previousVersionContext";
/// `_syncular_meta` key holding the pre-reset compatibility audit (D6, phase 2).
/// Declared here because a discard clears it.
pub const PREVIOUS_VERSION_AUDIT_KEY: &str = "previousVersionAudit";

/// RFC 0005 D3: the container is the sibling file `<replica path>.prev-context`.
/// The name is code-derived and never persisted in the replica database.
pub const PREVIOUS_VERSION_CONTAINER_SUFFIX: &str = ".prev-context";

/// The one non-reserved row table INSIDE the container file (D3).
const CONTAINER_TABLE: &str = "syncular_prev_context";
/// Container-local metadata table holding the [`PreviousVersionRecord`].
const CONTAINER_META_TABLE: &str = "_syncular_prev_context_meta";

const DESCRIPTOR_VERSION: i64 = 1;
const RECORD_VERSION: i64 = 1;
/// Rows copied per `INSERT` batch (A4 step 5).
const COPY_BATCH_ROWS: i64 = 500;

/// D2/D8/A4: capture bounds. Every bound is measured before materializing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviousVersionContextConfig {
    /// Feature flag, default off. Never a security control.
    pub enabled: bool,
    pub max_bytes: i64,
    pub max_rows: i64,
    pub max_tables: i64,
    pub max_row_bytes: i64,
}

impl Default for PreviousVersionContextConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_bytes: 8 * 1024 * 1024,
            max_rows: 20_000,
            max_tables: 32,
            max_row_bytes: 1024 * 1024,
        }
    }
}

impl PreviousVersionContextConfig {
    /// D8: every bound is a positive safe integer — the same validation the TS
    /// core runs on `previousVersionContext`, with the same error code.
    pub fn validate(&self) -> Result<(), String> {
        let bounds = [
            ("maxBytes", self.max_bytes),
            ("maxRows", self.max_rows),
            ("maxTables", self.max_tables),
            ("maxRowBytes", self.max_row_bytes),
        ];
        for (name, value) in bounds {
            if value <= 0 || u64::try_from(value).map_or(true, |v| v > MAX_SAFE_INTEGER) {
                return Err(format!(
                    "sync.invalid_request: previousVersionContext.{name} must be a positive safe integer"
                ));
            }
        }
        Ok(())
    }
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`; a Rust host crosses a JSON boundary,
/// so a bound past it could not survive the round trip.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn local_corrupt(what: &str) -> String {
    format!("sync.local_corrupt: persisted {what} is invalid")
}

/// The sibling container path for a file-backed replica. In-memory replicas
/// have no path and therefore no container (the feature resolves as off).
pub fn previous_version_container_path(replica_path: &str) -> String {
    format!("{replica_path}{PREVIOUS_VERSION_CONTAINER_SUFFIX}")
}

// ---------------------------------------------------------------------------
// Descriptor (D1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorColumn {
    pub name: String,
    /// The SEMANTIC local type (`localColumnType`): for an encrypted column
    /// that is its declared app type, because the local mirror is plaintext.
    pub ty: ColumnType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorTable {
    pub name: String,
    pub primary_key: String,
    pub columns: Vec<DescriptorColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSchemaDescriptor {
    pub version: i32,
    pub tables: Vec<DescriptorTable>,
}

impl LocalSchemaDescriptor {
    pub fn table(&self, name: &str) -> Option<&DescriptorTable> {
        self.tables.iter().find(|table| table.name == name)
    }
}

/// D1: the semantic local types of every table in the running generated
/// schema, built from the compiled LOCAL columns — never from SQLite affinity.
pub fn build_local_schema_descriptor(schema: &ClientSchema) -> LocalSchemaDescriptor {
    LocalSchemaDescriptor {
        version: schema.version,
        tables: schema
            .tables
            .iter()
            .map(|table| DescriptorTable {
                name: table.name.clone(),
                primary_key: table.primary_key.clone(),
                columns: table
                    .columns
                    .iter()
                    .map(|column| DescriptorColumn {
                        name: column.name.clone(),
                        ty: column.ty,
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn encode_local_schema_descriptor(descriptor: &LocalSchemaDescriptor) -> String {
    let tables = descriptor
        .tables
        .iter()
        .map(|table| {
            let columns = table
                .columns
                .iter()
                .map(|column| json!({ "name": column.name, "type": column.ty.name() }))
                .collect::<Vec<_>>();
            json!({
                "name": table.name,
                "primaryKey": table.primary_key,
                "columns": columns,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "v": DESCRIPTOR_VERSION,
        "version": descriptor.version,
        "tables": tables,
    })
    .to_string()
}

/// Strict shape comparison: exactly these keys, nothing else. Equivalent to
/// the TS core's sorted-key/length check.
fn has_exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

/// A non-negative safe integer, mirroring the TS `isCount` predicate.
fn as_count(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0 && u64::try_from(*value).map_or(false, |v| v <= MAX_SAFE_INTEGER))
}

fn decode_descriptor_column(value: &Value) -> Result<DescriptorColumn, String> {
    let Value::Object(column) = value else {
        return Err(local_corrupt("schema descriptor"));
    };
    if !has_exact_keys(column, &["name", "type"]) {
        return Err(local_corrupt("schema descriptor"));
    }
    let (Some(Value::String(name)), Some(Value::String(type_name))) =
        (column.get("name"), column.get("type"))
    else {
        return Err(local_corrupt("schema descriptor"));
    };
    let ty = ColumnType::from_name(type_name).ok_or_else(|| local_corrupt("schema descriptor"))?;
    Ok(DescriptorColumn {
        name: name.clone(),
        ty,
    })
}

fn decode_descriptor_table(value: &Value) -> Result<DescriptorTable, String> {
    let Value::Object(table) = value else {
        return Err(local_corrupt("schema descriptor"));
    };
    if !has_exact_keys(table, &["columns", "name", "primaryKey"]) {
        return Err(local_corrupt("schema descriptor"));
    }
    let (Some(Value::String(name)), Some(Value::String(primary_key)), Some(Value::Array(columns))) = (
        table.get("name"),
        table.get("primaryKey"),
        table.get("columns"),
    ) else {
        return Err(local_corrupt("schema descriptor"));
    };
    Ok(DescriptorTable {
        name: name.clone(),
        primary_key: primary_key.clone(),
        columns: columns
            .iter()
            .map(decode_descriptor_column)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

/// Strict decode: an unknown shape is corruption, never a best guess.
pub fn decode_local_schema_descriptor(raw: &str) -> Result<LocalSchemaDescriptor, String> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| local_corrupt("schema descriptor"))?;
    let Value::Object(record) = &parsed else {
        return Err(local_corrupt("schema descriptor"));
    };
    if !has_exact_keys(record, &["tables", "v", "version"])
        || as_count(record.get("v")) != Some(DESCRIPTOR_VERSION)
    {
        return Err(local_corrupt("schema descriptor"));
    }
    let version = as_count(record.get("version"))
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| local_corrupt("schema descriptor"))?;
    let Some(Value::Array(tables)) = record.get("tables") else {
        return Err(local_corrupt("schema descriptor"));
    };
    Ok(LocalSchemaDescriptor {
        version,
        tables: tables
            .iter()
            .map(decode_descriptor_table)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

/// D1: persist the descriptor. Callers write this beside every write of
/// [`LOCAL_SCHEMA_VERSION_KEY`]; a descriptor without a matching marker is
/// treated as absent at reset time.
pub fn set_local_schema_descriptor(conn: &Connection, schema: &ClientSchema) {
    meta_set(
        conn,
        LOCAL_SCHEMA_DESCRIPTOR_KEY,
        &encode_local_schema_descriptor(&build_local_schema_descriptor(schema)),
    );
}

/// Load and strictly decode the stored descriptor; `None` when absent/corrupt.
pub fn load_local_schema_descriptor(conn: &Connection) -> Option<LocalSchemaDescriptor> {
    let raw = meta_get(conn, LOCAL_SCHEMA_DESCRIPTOR_KEY)?;
    decode_local_schema_descriptor(&raw).ok()
}

// ---------------------------------------------------------------------------
// Container file (D3)
// ---------------------------------------------------------------------------

/// Drop both container tables. Also the unconditional orphan sweep (D5).
pub fn drop_previous_version_container(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {CONTAINER_TABLE}; DROP TABLE IF EXISTS {CONTAINER_META_TABLE};"
    ))
    .map_err(|error| error.to_string())
}

/// Successful capture record, stored INSIDE the container file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviousVersionRecord {
    pub previous_version: i32,
    pub current_version: i32,
    pub tables: Vec<DescriptorTable>,
    pub rows: i64,
    pub bytes: i64,
    pub created_at_ms: i64,
}

impl PreviousVersionRecord {
    /// The captured shape of one table — what a read needs to decode payloads.
    pub fn table(&self, name: &str) -> Option<&DescriptorTable> {
        self.tables.iter().find(|table| table.name == name)
    }
}

fn decode_record(raw: &str) -> Result<PreviousVersionRecord, String> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| local_corrupt("previous-version context"))?;
    let Value::Object(record) = &parsed else {
        return Err(local_corrupt("previous-version context"));
    };
    if !has_exact_keys(
        record,
        &[
            "bytes",
            "createdAtMs",
            "currentVersion",
            "previousVersion",
            "rows",
            "tables",
            "v",
        ],
    ) || as_count(record.get("v")) != Some(RECORD_VERSION)
    {
        return Err(local_corrupt("previous-version context"));
    }
    let count = |key: &str| {
        as_count(record.get(key))
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| local_corrupt("previous-version context"))
    };
    let Some(Value::Array(tables)) = record.get("tables") else {
        return Err(local_corrupt("previous-version context"));
    };
    Ok(PreviousVersionRecord {
        previous_version: count("previousVersion")?,
        current_version: count("currentVersion")?,
        tables: tables
            .iter()
            .map(decode_descriptor_table)
            .collect::<Result<Vec<_>, _>>()?,
        rows: as_count(record.get("rows")).ok_or_else(|| local_corrupt("previous-version context"))?,
        bytes: as_count(record.get("bytes")).ok_or_else(|| local_corrupt("previous-version context"))?,
        created_at_ms: as_count(record.get("createdAtMs"))
            .ok_or_else(|| local_corrupt("previous-version context"))?,
    })
}

fn encode_record(record: &PreviousVersionRecord) -> String {
    let tables = record
        .tables
        .iter()
        .map(|table| {
            let columns = table
                .columns
                .iter()
                .map(|column| json!({ "name": column.name, "type": column.ty.name() }))
                .collect::<Vec<_>>();
            json!({
                "name": table.name,
                "primaryKey": table.primary_key,
                "columns": columns,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "v": RECORD_VERSION,
        "previousVersion": record.previous_version,
        "currentVersion": record.current_version,
        "tables": tables,
        "rows": record.rows,
        "bytes": record.bytes,
        "createdAtMs": record.created_at_ms,
    })
    .to_string()
}

fn write_record(conn: &Connection, record: &PreviousVersionRecord) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {CONTAINER_META_TABLE} (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           record TEXT NOT NULL);
         DELETE FROM {CONTAINER_META_TABLE};"
    ))
    .map_err(|error| error.to_string())?;
    conn.execute(
        &format!("INSERT INTO {CONTAINER_META_TABLE}(id, record) VALUES (1, ?1)"),
        rusqlite::params![encode_record(record)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Read the container's own metadata record; `None` when absent/corrupt.
pub fn read_previous_version_container(
    conn: &Connection,
) -> Result<Option<PreviousVersionRecord>, String> {
    let present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            rusqlite::params![CONTAINER_META_TABLE],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if present == 0 {
        return Ok(None);
    }
    let raw: Option<String> = conn
        .query_row(
            &format!("SELECT record FROM {CONTAINER_META_TABLE} WHERE id = 1"),
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(raw.and_then(|raw| decode_record(&raw).ok()))
}

/// D7: read one previous table from the container, `limit + 1` rows so the
/// caller can report truncation. `rowIds` empty means every row of the table.
pub fn read_previous_version_rows(
    conn: &Connection,
    table: &DescriptorTable,
    row_ids: &[String],
    limit: i64,
) -> Result<(Vec<Map<String, Value>>, bool), String> {
    let filter = if row_ids.is_empty() {
        String::new()
    } else {
        let placeholders = (0..row_ids.len())
            .map(|index| format!("?{}", index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" AND row_id IN ({placeholders})")
    };
    let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(
        table.name.clone(),
    )];
    params.extend(
        row_ids
            .iter()
            .map(|row_id| rusqlite::types::Value::Text(row_id.clone())),
    );
    params.push(rusqlite::types::Value::Integer(limit + 1));
    let limit_placeholder = params.len();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT payload FROM {CONTAINER_TABLE}
               WHERE tbl = ?1{filter} ORDER BY row_id ASC LIMIT ?{limit_placeholder}"
        ))
        .map_err(|error| error.to_string())?;
    let payloads = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let truncated = payloads.len() as i64 > limit;
    let visible = if truncated {
        limit as usize
    } else {
        payloads.len()
    };
    let mut rows = Vec::with_capacity(visible);
    for payload in payloads.into_iter().take(visible) {
        rows.push(payload_to_row(table, &payload)?);
    }
    Ok((rows, truncated))
}

// ---------------------------------------------------------------------------
// Bounded capture (D2 / A4)
// ---------------------------------------------------------------------------

/// D2/A4: measure the capture BEFORE materializing anything. Ordered probes,
/// aborting on the first violation: table count; per-table row count with a
/// `LIMIT maxRows + 1` early-abort probe; a single-row probe for rows larger
/// than `maxRowBytes`; a bounded `SUM` over a `LIMIT`ed subquery. Only then is
/// anything copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CaptureMeasurement {
    pub tables: i64,
    pub rows: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviousVersionRefusalReason {
    NoPreviousDescriptor,
    CaptureExceededBudget,
}

impl PreviousVersionRefusalReason {
    pub fn name(self) -> &'static str {
        match self {
            Self::NoPreviousDescriptor => "no-previous-descriptor",
            Self::CaptureExceededBudget => "capture-exceeded-budget",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOutcome {
    Captured(CaptureMeasurement),
    Refused {
        reason: PreviousVersionRefusalReason,
        measurement: CaptureMeasurement,
    },
}

fn sum_bytes_expression(columns: &[DescriptorColumn]) -> String {
    columns
        .iter()
        .map(|column| format!("COALESCE(LENGTH(CAST({} AS BLOB)), 0)", quote_ident(&column.name)))
        .collect::<Vec<_>>()
        .join(" + ")
}

fn render_row_id(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => value.to_string(),
        ValueRef::Text(value) => String::from_utf8_lossy(value).into_owned(),
        ValueRef::Blob(value) => bytes_to_hex(value),
    }
}

/// A descriptor column as the row-value codec's column shape (`nullable` is
/// irrelevant to the local read, which is where the type is recovered).
fn column_ref(column: &DescriptorColumn) -> Column {
    Column {
        name: column.name.clone(),
        ty: column.ty,
        nullable: true,
    }
}

fn payload_to_row(table: &DescriptorTable, payload: &str) -> Result<Map<String, Value>, String> {
    let parsed: Value =
        serde_json::from_str(payload).map_err(|_| local_corrupt("previous-version payload"))?;
    let Value::Object(record) = parsed else {
        return Err(local_corrupt("previous-version payload"));
    };
    let mut row = Map::new();
    for column in &table.columns {
        let value = json_to_column_value(&column_ref(column), record.get(&column.name))
            .map_err(|_| local_corrupt("previous-version payload"))?;
        row.insert(column.name.clone(), column_value_to_json(&value));
    }
    Ok(row)
}

/// D3/D5 steps 3-5: copy the descriptor's tables into the container file, in
/// one container transaction and [`COPY_BATCH_ROWS`] batches.
pub fn capture_previous_version(
    replica: &Connection,
    container: &mut Connection,
    descriptor: &LocalSchemaDescriptor,
    current_version: i32,
    config: &PreviousVersionContextConfig,
    now_ms: i64,
) -> Result<CaptureOutcome, String> {
    let discovered: BTreeSet<String> = {
        let mut stmt = replica
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'
                   AND name NOT LIKE '_syncular_%' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|error| error.to_string())?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(|error| error.to_string())?;
        names
    };
    // Only descriptor-known tables carry semantic types; those are the tables
    // the copy would hold, and the count the table budget bounds.
    let tables: Vec<&DescriptorTable> = descriptor
        .tables
        .iter()
        .filter(|table| discovered.contains(&table.name))
        .collect();
    let refused = |rows: i64, bytes: i64| CaptureOutcome::Refused {
        reason: PreviousVersionRefusalReason::CaptureExceededBudget,
        measurement: CaptureMeasurement {
            tables: tables.len() as i64,
            rows,
            bytes,
        },
    };
    if tables.len() as i64 > config.max_tables {
        return Ok(refused(0, 0));
    }

    // Probe 2: rows per table, stopping at maxRows + 1 rather than counting a
    // hundred-million-row table in full.
    let mut measured_rows = 0i64;
    let mut per_table_rows: Vec<i64> = Vec::with_capacity(tables.len());
    for table in &tables {
        let count: i64 = replica
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM (SELECT 1 FROM {} LIMIT ?1)",
                    quote_ident(&table.name)
                ),
                rusqlite::params![config.max_rows + 1],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        measured_rows += count;
        per_table_rows.push(count);
        if measured_rows > config.max_rows {
            return Ok(refused(measured_rows, 0));
        }
    }

    // Probes 3-4: one oversized row is rejected before it is ever loaded, then
    // the byte total is summed over a bounded scan only.
    let mut measured_bytes = 0i64;
    for (index, table) in tables.iter().enumerate() {
        if table.columns.is_empty() {
            continue;
        }
        let byte_sum = sum_bytes_expression(&table.columns);
        let oversized: Option<i64> = replica
            .query_row(
                &format!(
                    "SELECT 1 FROM {} WHERE ({byte_sum}) > ?1 LIMIT 1",
                    quote_ident(&table.name)
                ),
                rusqlite::params![config.max_row_bytes],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if oversized.is_some() {
            return Ok(refused(measured_rows, measured_bytes));
        }
        let total: i64 = replica
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(bytes), 0) FROM (
                       SELECT ({byte_sum}) AS bytes FROM {} LIMIT ?1
                     )",
                    quote_ident(&table.name)
                ),
                rusqlite::params![per_table_rows[index]],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        measured_bytes += total;
        if measured_bytes > config.max_bytes {
            return Ok(refused(measured_rows, measured_bytes));
        }
    }

    // Step 5: copy in batches, so no step holds a whole table in memory.
    let mut copied_rows = 0i64;
    let transaction = container.transaction().map_err(|error| error.to_string())?;
    drop_previous_version_container(&transaction)?;
    transaction
        .execute_batch(&format!(
            "CREATE TABLE {CONTAINER_TABLE} (
               tbl TEXT NOT NULL,
               row_id TEXT NOT NULL,
               payload TEXT NOT NULL,
               PRIMARY KEY (tbl, row_id))"
        ))
        .map_err(|error| error.to_string())?;
    for table in &tables {
        let select_columns = table
            .columns
            .iter()
            .map(|column| quote_ident(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        let primary_key_index = table
            .columns
            .iter()
            .position(|column| column.name == table.primary_key);
        let select_sql = format!(
            "SELECT rowid, {select_columns} FROM {} WHERE rowid > ?1 ORDER BY rowid ASC LIMIT ?2",
            quote_ident(&table.name)
        );
        let mut last_row_id = -1i64;
        loop {
            let batch: Vec<(i64, String, String)> = {
                let mut stmt =
                    replica.prepare(&select_sql).map_err(|error| error.to_string())?;
                let mut rows = stmt
                    .query(rusqlite::params![last_row_id, COPY_BATCH_ROWS])
                    .map_err(|error| error.to_string())?;
                let mut batch = Vec::new();
                while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                    let row_id = primary_key_index.map_or_else(String::new, |index| {
                        row.get_ref(index + 1)
                            .map(render_row_id)
                            .unwrap_or_default()
                    });
                    let mut payload = Map::new();
                    for (index, column) in table.columns.iter().enumerate() {
                        let raw = row.get_ref(index + 1).map_err(|error| error.to_string())?;
                        payload.insert(
                            column.name.clone(),
                            sql_ref_to_json(&column_ref(column), raw),
                        );
                    }
                    batch.push((
                        row.get::<_, i64>(0).map_err(|error| error.to_string())?,
                        row_id,
                        Value::Object(payload).to_string(),
                    ));
                }
                batch
            };
            if batch.is_empty() {
                break;
            }
            {
                let mut insert = transaction
                    .prepare(&format!(
                        "INSERT INTO {CONTAINER_TABLE}(tbl, row_id, payload) VALUES (?1, ?2, ?3)"
                    ))
                    .map_err(|error| error.to_string())?;
                for (_, row_id, payload) in &batch {
                    insert
                        .execute(rusqlite::params![table.name, row_id, payload])
                        .map_err(|error| error.to_string())?;
                }
            }
            copied_rows += batch.len() as i64;
            last_row_id = batch.last().map_or(last_row_id, |entry| entry.0);
        }
    }
    write_record(
        &transaction,
        &PreviousVersionRecord {
            previous_version: descriptor.version,
            current_version,
            tables: tables
                .iter()
                .map(|table| (*table).clone())
                .collect(),
            rows: copied_rows,
            bytes: measured_bytes,
            created_at_ms: now_ms,
        },
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(CaptureOutcome::Captured(CaptureMeasurement {
        tables: tables.len() as i64,
        rows: copied_rows,
        bytes: measured_bytes,
    }))
}

// ---------------------------------------------------------------------------
// Durable refusal (the read surface for a capture that stored nothing)
// ---------------------------------------------------------------------------

/// Record a refusal in `_syncular_meta`, with counts only — never row content.
fn write_previous_version_refusal(
    conn: &Connection,
    reason: PreviousVersionRefusalReason,
    measurement: CaptureMeasurement,
) {
    meta_set(
        conn,
        PREVIOUS_VERSION_CONTEXT_KEY,
        &json!({
            "v": 1,
            "reason": reason.name(),
            "tables": measurement.tables,
            "rows": measurement.rows,
            "bytes": measurement.bytes,
        })
        .to_string(),
    );
}

// ---------------------------------------------------------------------------
// File-level lifecycle: sweep, capture orchestration, discard
// ---------------------------------------------------------------------------

/// Best-effort physical removal of the container file. The connection MUST be
/// closed first; the `-wal`/`-shm` siblings go with it.
fn remove_previous_version_files(path: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

/// D5 step 1: the unconditional orphan sweep. Drops the container tables,
/// removes the file, and clears a durable refusal recorded for it, so a
/// crash-interrupted reset cannot leave a container beside a matching marker.
/// A no-op when no container file exists.
pub fn sweep_previous_version_container(
    replica: &Connection,
    replica_path: &str,
) -> Result<(), String> {
    let path = previous_version_container_path(replica_path);
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    let container = Connection::open(&path)
        .map_err(|error| format!("open previous-version container {path:?}: {error}"))?;
    drop_previous_version_container(&container)?;
    let _ = container.close();
    remove_previous_version_files(&path);
    meta_delete(replica, PREVIOUS_VERSION_CONTEXT_KEY);
    Ok(())
}

/// D5 steps 2-5: load the stored descriptor, then capture into the container
/// file. A refused or failed capture stores nothing, records its reason, and
/// leaves NO container file behind.
pub fn capture_previous_version_from_replica(
    replica: &Connection,
    replica_path: &str,
    previous_version: i32,
    current_version: i32,
    config: &PreviousVersionContextConfig,
    now_ms: i64,
) -> Result<CaptureOutcome, String> {
    let path = previous_version_container_path(replica_path);
    let descriptor = load_local_schema_descriptor(replica)
        .filter(|descriptor| descriptor.version == previous_version);
    let Some(descriptor) = descriptor else {
        // D1: no fallback and no inference — a database last opened by an
        // unaware binary has no descriptor, and the capture is refused.
        let measurement = CaptureMeasurement::default();
        write_previous_version_refusal(
            replica,
            PreviousVersionRefusalReason::NoPreviousDescriptor,
            measurement,
        );
        return Ok(CaptureOutcome::Refused {
            reason: PreviousVersionRefusalReason::NoPreviousDescriptor,
            measurement,
        });
    };
    let mut container = Connection::open(&path)
        .map_err(|error| format!("open previous-version container {path:?}: {error}"))?;
    let outcome = capture_previous_version(
        replica,
        &mut container,
        &descriptor,
        current_version,
        config,
        now_ms,
    );
    let _ = container.close();
    match outcome {
        Ok(CaptureOutcome::Captured(measurement)) => {
            meta_delete(replica, PREVIOUS_VERSION_CONTEXT_KEY);
            Ok(CaptureOutcome::Captured(measurement))
        }
        Ok(CaptureOutcome::Refused {
            reason,
            measurement,
        }) => {
            write_previous_version_refusal(replica, reason, measurement);
            remove_previous_version_files(&path);
            Ok(CaptureOutcome::Refused {
                reason,
                measurement,
            })
        }
        Err(error) => {
            remove_previous_version_files(&path);
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviousVersionDiscardOutcome {
    pub present: bool,
    pub discarded: bool,
}

/// D7/D9/A2: the executable discard — drop the container and both metadata
/// records and remove the FILE. Idempotent: a no-op succeeds.
pub fn discard_previous_version(
    replica: &Connection,
    replica_path: &str,
) -> Result<PreviousVersionDiscardOutcome, String> {
    let path = previous_version_container_path(replica_path);
    let mut present = std::path::Path::new(&path).exists();
    if present {
        let container = Connection::open(&path)
            .map_err(|error| format!("open previous-version container {path:?}: {error}"))?;
        drop_previous_version_container(&container)?;
        let _ = container.close();
        remove_previous_version_files(&path);
    }
    if meta_get(replica, PREVIOUS_VERSION_CONTEXT_KEY).is_some()
        || meta_get(replica, PREVIOUS_VERSION_AUDIT_KEY).is_some()
    {
        present = true;
    }
    meta_delete(replica, PREVIOUS_VERSION_CONTEXT_KEY);
    meta_delete(replica, PREVIOUS_VERSION_AUDIT_KEY);
    Ok(PreviousVersionDiscardOutcome {
        present,
        discarded: present,
    })
}
#[cfg(test)]
mod tests {
    //! RFC 0005 phase-1 tests: descriptor round-trip and strict decode, the
    //! container in the sibling FILE with readable typed rows, every budget
    //! aborting with no file left, the no-descriptor refusal, and a discard
    //! that removes the PATH (read directly from storage, never through the
    //! feature's own read API).

    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;
    use crate::api::{ClientLimits, Mutation};
    use crate::client::SyncClient;
    use crate::schema::parse_schema_json;

    /// Removes every temp file the test created, so the container assertion
    /// "the path is gone" cannot pass because a later case reused the name.
    struct TempFiles {
        paths: Vec<PathBuf>,
    }

    impl TempFiles {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "syncular-prev-context-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            let paths = vec![
                path.clone(),
                PathBuf::from(previous_version_container_path(
                    path.to_str().expect("utf-8 temp path"),
                )),
            ];
            Self { paths }
        }

        fn replica(&self) -> &Path {
            &self.paths[0]
        }
    }

    impl Drop for TempFiles {
        fn drop(&mut self) {
            for path in &self.paths {
                let _ = std::fs::remove_file(path);
                let _ = std::fs::remove_file(format!("{}-wal", path.display()));
                let _ = std::fs::remove_file(format!("{}-shm", path.display()));
            }
        }
    }

    fn schema_json(version: i32) -> Value {
        json!({
            "version": version,
            "tables": [{
                "name": "things",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false },
                    { "name": "s", "type": "string", "nullable": true },
                    { "name": "i", "type": "integer", "nullable": true },
                    { "name": "f", "type": "float", "nullable": true },
                    { "name": "b", "type": "boolean", "nullable": true },
                    { "name": "j", "type": "json", "nullable": true },
                    { "name": "by", "type": "bytes", "nullable": true },
                    { "name": "cr", "type": "crdt", "nullable": true },
                    { "name": "br", "type": "blob_ref", "nullable": true },
                    { "name": "meta", "type": "string", "nullable": true }
                ],
                "scopes": []
            }, {
                "name": "notes",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "body", "type": "string", "nullable": true }
                ],
                "scopes": []
            }]
        })
    }

    fn schema(version: i32) -> ClientSchema {
        parse_schema_json(&schema_json(version)).expect("valid test schema")
    }

    /// The local DDL the client writes: bare column names, no declared type.
    fn seed_replica(path: &Path, rows: i64) {
        let replica = Connection::open(path).expect("open replica");
        replica
            .execute_batch(
                "CREATE TABLE _syncular_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE things (id, project_id, s, i, f, b, j, by, cr, br, meta);
                 CREATE TABLE notes (id, body);",
            )
            .expect("create local tables");
        for index in 0..rows {
            replica
                .execute(
                    "INSERT INTO things(rowid, id, project_id, s, i, f, b, j, by, cr, br, meta)
                       VALUES (?1, ?2, 'p1', 'hello', 7, 1.5, 1, '{\"a\":1}',
                               x'010203', x'0908', 'blob:xyz', 'm1')",
                    rusqlite::params![index + 1, format!("r{}", index + 1)],
                )
                .expect("insert row");
        }
        replica
            .execute(
                "INSERT INTO notes(id, body) VALUES ('n1', 'note')",
                [],
            )
            .expect("insert note");
        // D1: the descriptor the bump's capture reads, exactly as the client
        // writes it.
        set_local_schema_descriptor(&replica, &schema(1));
    }

    fn descriptor() -> LocalSchemaDescriptor {
        build_local_schema_descriptor(&schema(1))
    }

    #[test]
    fn previous_version_descriptor_round_trips_and_rejects_unknown_shapes() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch("CREATE TABLE _syncular_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .expect("create meta");
        let schema = schema(4);
        set_local_schema_descriptor(&conn, &schema);

        let stored = meta_get(&conn, LOCAL_SCHEMA_DESCRIPTOR_KEY).expect("descriptor written");
        let parsed: Value = serde_json::from_str(&stored).expect("descriptor is JSON");
        assert_eq!(parsed.as_object().expect("object").len(), 3, "{stored}");
        assert_eq!(parsed["v"], json!(1));
        assert_eq!(parsed["version"], json!(4));
        let tables = parsed["tables"].as_array().expect("tables array");
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0]["name"], json!("things"));
        assert_eq!(tables[0]["primaryKey"], json!("id"));
        assert_eq!(
            tables[0]["columns"][1],
            json!({ "name": "project_id", "type": "string" })
        );
        assert_eq!(
            tables[0]["columns"][5],
            json!({ "name": "b", "type": "boolean" })
        );
        assert_eq!(
            tables[0]["columns"][7],
            json!({ "name": "by", "type": "bytes" })
        );

        // Round trip through the strict decoder.
        assert_eq!(
            decode_local_schema_descriptor(&stored).expect("strict decode"),
            build_local_schema_descriptor(&schema)
        );
        assert_eq!(
            load_local_schema_descriptor(&conn).expect("loaded"),
            build_local_schema_descriptor(&schema)
        );

        // Strict decode: an unknown shape is corruption, never a best guess.
        for raw in [
            r#"{"v":1,"version":4,"tables":[],"extra":1}"#,
            r#"{"v":2,"version":4,"tables":[]}"#,
            r#"{"v":1,"version":4}"#,
            r#"{"v":1,"version":-1,"tables":[]}"#,
            r#"{"v":1,"version":4,"tables":{}}"#,
            r#"{"v":1,"version":4,"tables":[{"name":"t","primaryKey":"id"}]}"#,
            r#"{"v":1,"version":4,"tables":[{"name":"t","primaryKey":"id","columns":[{"name":"a","type":"nope"}]}]}"#,
            r#"{"v":1,"version":4,"tables":[{"name":"t","primaryKey":"id","columns":[]}],"x":0}"#,
            "not json",
        ] {
            assert!(
                decode_local_schema_descriptor(raw).is_err(),
                "must reject {raw}"
            );
        }

        // A corrupt stored value reads as absent (the reset then refuses).
        meta_set(&conn, LOCAL_SCHEMA_DESCRIPTOR_KEY, "{broken");
        assert_eq!(load_local_schema_descriptor(&conn), None);
    }

    #[test]
    fn previous_version_capture_writes_sibling_container_with_readable_rows() {
        let temp = TempFiles::new("capture");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 2);
        let replica = Connection::open(temp.replica()).expect("open replica");

        let outcome = capture_previous_version_from_replica(
            &replica,
            &replica_path,
            1,
            2,
            &PreviousVersionContextConfig::default(),
            1_700_000_000_000,
        )
        .expect("capture");
        let CaptureOutcome::Captured(measurement) = outcome else {
            panic!("expected a capture, got {outcome:?}");
        };
        assert_eq!(measurement.tables, 2);
        assert_eq!(measurement.rows, 3);
        assert!(measurement.bytes > 0);

        // The container is a SEPARATE file, and the replica cannot see it.
        let container_path = previous_version_container_path(&replica_path);
        assert!(Path::new(&container_path).exists());
        let visible: i64 = replica
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![CONTAINER_TABLE],
                |row| row.get(0),
            )
            .expect("count replica tables");
        assert_eq!(visible, 0);

        let container = Connection::open(&container_path).expect("open container");
        let record = read_previous_version_container(&container)
            .expect("read record")
            .expect("record present");
        assert_eq!(record.previous_version, 1);
        assert_eq!(record.current_version, 2);
        assert_eq!(record.rows, 3);
        assert_eq!(record.bytes, measurement.bytes);        assert_eq!(record.created_at_ms, 1_700_000_000_000);
        assert_eq!(record.tables.len(), 2);
        assert_eq!(record.tables[0].columns.len(), 11);

        let table = record.table("things").expect("things in the record");
        let (rows, truncated) = read_previous_version_rows(&container, table, &[], 50)
            .expect("read rows");
        assert!(!truncated);
        assert_eq!(rows.len(), 2);
        let row = &rows[0];
        assert_eq!(row["id"], json!("r1"));
        assert_eq!(row["s"], json!("hello"));
        assert_eq!(row["i"], json!(7));
        assert_eq!(row["f"], json!(1.5));
        assert_eq!(row["b"], json!(true));
        assert_eq!(row["j"], json!("{\"a\":1}"));
        assert_eq!(row["br"], json!("blob:xyz"));
        assert_eq!(row["by"], json!({ "$bytes": "010203" }));
        assert_eq!(row["cr"], json!({ "$bytes": "0908" }));
        assert!(!row.contains_key("_syncular_version"));
        assert!(!row.contains_key("_sync_version"));

        // Row selection and the `limit + 1` truncation probe.
        let (selected, _) =
            read_previous_version_rows(&container, table, &["r2".to_owned()], 50).expect("select");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["id"], json!("r2"));
        let (missing, _) =
            read_previous_version_rows(&container, table, &["absent".to_owned()], 50)
                .expect("select missing");
        assert!(missing.is_empty());
        let (limited, truncated) =
            read_previous_version_rows(&container, table, &[], 0).expect("limit 0");
        assert!(limited.is_empty());
        assert!(truncated);
    }

    #[test]
    fn previous_version_each_budget_refuses_and_leaves_no_file() {
        let temp = TempFiles::new("budget");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 2);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let container_path = previous_version_container_path(&replica_path);

        let cases = [
            (
                "maxTables",
                PreviousVersionContextConfig {
                    max_tables: 1,
                    ..Default::default()
                },
                0,
                false,
            ),
            (
                "maxRows",
                PreviousVersionContextConfig {
                    max_rows: 1,
                    ..Default::default()
                },
                2,
                false,
            ),
            (
                "maxBytes",
                PreviousVersionContextConfig {
                    max_bytes: 1,
                    ..Default::default()
                },
                3,
                true,
            ),
            (
                "maxRowBytes",
                PreviousVersionContextConfig {
                    max_row_bytes: 1,
                    ..Default::default()
                },
                3,
                false,
            ),
        ];
        for (label, config, expected_rows, bytes_measured) in cases {
            let outcome = capture_previous_version_from_replica(
                &replica, &replica_path, 1, 2, &config, 1,
            )
            .unwrap_or_else(|error| panic!("{label}: {error}"));
            let CaptureOutcome::Refused {
                reason,
                measurement,
            } = outcome
            else {
                panic!("{label}: expected a refusal, got {outcome:?}");
            };
            assert_eq!(
                reason,
                PreviousVersionRefusalReason::CaptureExceededBudget,
                "{label}"
            );
            assert_eq!(measurement.tables, 2, "{label}");
            assert_eq!(measurement.rows, expected_rows, "{label}");
            if bytes_measured {
                assert!(measurement.bytes > 1, "{label}");
            } else {
                assert_eq!(measurement.bytes, 0, "{label}");
            }
            // All-or-nothing: no partial copy, and no file at all.
            assert!(!Path::new(&container_path).exists(), "{label}");
            let refusal = meta_get(&replica, PREVIOUS_VERSION_CONTEXT_KEY)
                .unwrap_or_else(|| panic!("{label}: refusal recorded"));
            assert!(refusal.contains("capture-exceeded-budget"), "{refusal}");
        }
    }

    #[test]
    fn previous_version_missing_or_stale_descriptor_refuses_without_a_file() {
        let temp = TempFiles::new("no-descriptor");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 1);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let container_path = previous_version_container_path(&replica_path);

        // No descriptor at all: a database last opened by an unaware binary.
        meta_delete(&replica, LOCAL_SCHEMA_DESCRIPTOR_KEY);
        let outcome = capture_previous_version_from_replica(
            &replica,
            &replica_path,
            1,
            2,
            &PreviousVersionContextConfig::default(),
            1,
        )
        .expect("capture");
        assert_eq!(
            outcome,
            CaptureOutcome::Refused {
                reason: PreviousVersionRefusalReason::NoPreviousDescriptor,
                measurement: CaptureMeasurement::default(),
            }
        );
        assert!(!Path::new(&container_path).exists());
        let refusal = meta_get(&replica, PREVIOUS_VERSION_CONTEXT_KEY).expect("refusal");
        assert!(refusal.contains("no-previous-descriptor"), "{refusal}");

        // A descriptor for a DIFFERENT version is treated exactly the same.
        meta_set(
            &replica,
            LOCAL_SCHEMA_DESCRIPTOR_KEY,
            &encode_local_schema_descriptor(&descriptor()),
        );
        let outcome = capture_previous_version_from_replica(
            &replica,
            &replica_path,
            3,
            4,
            &PreviousVersionContextConfig::default(),
            1,
        )
        .expect("capture");
        assert!(matches!(
            outcome,
            CaptureOutcome::Refused {
                reason: PreviousVersionRefusalReason::NoPreviousDescriptor,
                ..
            }
        ));
        assert!(!Path::new(&container_path).exists());
    }

    #[test]
    fn previous_version_discard_removes_the_container_path() {
        let temp = TempFiles::new("discard");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 1);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let container_path = previous_version_container_path(&replica_path);

        let outcome = capture_previous_version_from_replica(
            &replica,
            &replica_path,
            1,
            2,
            &PreviousVersionContextConfig::default(),
            1,
        )
        .expect("capture");
        assert!(matches!(outcome, CaptureOutcome::Captured(_)));
        assert!(Path::new(&container_path).exists());
        meta_set(&replica, PREVIOUS_VERSION_AUDIT_KEY, "{\"v\":1}");

        let discarded = discard_previous_version(&replica, &replica_path).expect("discard");
        assert!(discarded.present);
        assert!(discarded.discarded);
        // The PATH is gone — not merely the tables inside it.
        assert!(!Path::new(&container_path).exists());
        assert!(!Path::new(&format!("{container_path}-wal")).exists());
        assert!(!Path::new(&format!("{container_path}-shm")).exists());
        assert_eq!(meta_get(&replica, PREVIOUS_VERSION_CONTEXT_KEY), None);
        assert_eq!(meta_get(&replica, PREVIOUS_VERSION_AUDIT_KEY), None);

        // A no-op discard succeeds (the RFC 0006 key-loss contract needs it).
        let again = discard_previous_version(&replica, &replica_path).expect("discard again");
        assert!(!again.present);
        assert!(!again.discarded);
    }

    #[test]
    fn previous_version_client_writes_descriptor_and_captures_on_bump() {
        let temp = TempFiles::new("client");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        let container_path = previous_version_container_path(&replica_path);

        // Fresh install at v1: the descriptor is written beside the marker and
        // the feature (default off) creates no container.
        {
            let mut client =
                SyncClient::open_path("pvc".to_owned(), &schema_json(1), ClientLimits::default(), &replica_path)
                    .expect("open v1");
            client
                .mutate(vec![Mutation::Upsert {
                    table: "things".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), json!("r1")),
                        ("project_id".to_owned(), json!("p1")),
                        ("s".to_owned(), json!("hello")),
                    ]),
                    base_version: None,
                }])
                .expect("seed a local row");
        }
        {
            let inspect = Connection::open(&replica_path).expect("inspect v1");
            let descriptor = load_local_schema_descriptor(&inspect).expect("descriptor after install");
            assert_eq!(descriptor.version, 1);
            assert_eq!(descriptor.tables.len(), 2);
            assert_eq!(descriptor.table("things").expect("things").columns.len(), 11);
        }
        assert!(!Path::new(&container_path).exists());

        // A same-version open backfills a descriptor an unaware binary never wrote.
        {
            let inspect = Connection::open(&replica_path).expect("inspect");
            meta_delete(&inspect, LOCAL_SCHEMA_DESCRIPTOR_KEY);
        }
        {
            let _client =
                SyncClient::open_path("pvc".to_owned(), &schema_json(1), ClientLimits::default(), &replica_path)
                    .expect("reopen v1");
        }
        {
            let inspect = Connection::open(&replica_path).expect("inspect v1 again");
            assert_eq!(
                load_local_schema_descriptor(&inspect).expect("backfilled").version,
                1
            );
        }

        // The bump captures the v1 row into the sibling file, and the replica
        // connection still cannot see the container table.
        {
            let limits = ClientLimits {
                previous_version_context: Some(PreviousVersionContextConfig {
                    enabled: true,
                    ..Default::default()
                }),
                ..Default::default()
            };
            SyncClient::open_path("pvc".to_owned(), &schema_json(2), limits, &replica_path)
                .expect("bump to v2");
        }
        assert!(Path::new(&container_path).exists());
        {
            let inspect = Connection::open(&replica_path).expect("inspect v2");
            assert_eq!(
                load_local_schema_descriptor(&inspect).expect("descriptor after bump").version,
                2
            );
            assert_eq!(
                inspect
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                        rusqlite::params![CONTAINER_TABLE],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("replica table count"),
                0
            );
        }
        {
            let container = Connection::open(&container_path).expect("open container");
            let record = read_previous_version_container(&container)
                .expect("read record")
                .expect("captured record");
            assert_eq!(record.previous_version, 1);
            assert_eq!(record.current_version, 2);
            assert_eq!(record.rows, 1);
            let (rows, _) = read_previous_version_rows(
                &container,
                record.table("things").expect("things"),
                &[],
                50,
            )
            .expect("read rows");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["s"], json!("hello"));
        }

        // Discard removes the path and both metadata records.
        {
            let inspect = Connection::open(&replica_path).expect("inspect v2");
            let outcome = discard_previous_version(&inspect, &replica_path).expect("discard");
            assert!(outcome.present && outcome.discarded);
        }
        assert!(!Path::new(&container_path).exists());
    }
}
