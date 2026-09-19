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
use serde::Serialize;
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
    /// Feature flag, default off. A feature flag, never a security control.
    pub enabled: bool,
    pub max_bytes: i64,
    pub max_rows: i64,
    pub max_tables: i64,
    pub max_row_bytes: i64,
    /// D7/A1 TTL. Enforced ONLY by an aware binary, at boot and at read. It is
    /// a hygiene bound for aware binaries and says NOTHING about an unaware
    /// same-schema rollback, which runs none of this code and therefore leaves
    /// the container in place indefinitely.
    pub max_age_ms: i64,
}

impl Default for PreviousVersionContextConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_bytes: 8 * 1024 * 1024,
            max_rows: 20_000,
            max_tables: 32,
            max_row_bytes: 1024 * 1024,
            max_age_ms: 24 * 60 * 60 * 1000,
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
            ("maxAgeMs", self.max_age_ms),
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
        .filter(|value| *value >= 0 && u64::try_from(*value).is_ok_and(|v| v <= MAX_SAFE_INTEGER))
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
        rows: as_count(record.get("rows"))
            .ok_or_else(|| local_corrupt("previous-version context"))?,
        bytes: as_count(record.get("bytes"))
            .ok_or_else(|| local_corrupt("previous-version context"))?,
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
    let mut params: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(table.name.clone())];
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

    fn as_read_reason(self) -> PreviousVersionReason {
        match self {
            Self::NoPreviousDescriptor => PreviousVersionReason::NoPreviousDescriptor,
            Self::CaptureExceededBudget => PreviousVersionReason::CaptureExceededBudget,
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
        .map(|column| {
            format!(
                "COALESCE(LENGTH(CAST({} AS BLOB)), 0)",
                quote_ident(&column.name)
            )
        })
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
                let mut stmt = replica
                    .prepare(&select_sql)
                    .map_err(|error| error.to_string())?;
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
            tables: tables.iter().map(|table| (*table).clone()).collect(),
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
///
/// Everything here is best-effort: the file is the thing being deleted, so a
/// torn or unreadable container must not refuse its own removal and must not
/// block the client's open.
pub fn sweep_previous_version_container(
    replica: &Connection,
    replica_path: &str,
) -> Result<(), String> {
    let path = previous_version_container_path(replica_path);
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    if let Ok(container) = Connection::open(&path) {
        let _ = drop_previous_version_container(&container);
        let _ = container.close();
    }
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

/// D7: `limit` defaults to 50 and is capped at 200.
pub const PREVIOUS_VERSION_DEFAULT_LIMIT: i64 = 50;
pub const PREVIOUS_VERSION_MAX_LIMIT: i64 = 200;

/// D7: the read surface. `state` is always `previousVersion`, never
/// `complete`; the container never contributes to `querySnapshot().coverage`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousVersionSnapshot {
    pub state: &'static str,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<i32>,
    pub current_version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PreviousVersionReason>,
    pub rows: Vec<Map<String, Value>>,
    pub truncated: bool,
}

impl PreviousVersionSnapshot {
    fn unavailable(current_version: i32, reason: PreviousVersionReason) -> Self {
        Self {
            state: PREVIOUS_VERSION_STATE,
            available: false,
            previous_version: None,
            current_version,
            reason: Some(reason),
            rows: Vec::new(),
            truncated: false,
        }
    }
}

/// The one value `state` ever takes (D7).
pub const PREVIOUS_VERSION_STATE: &str = "previousVersion";

/// Every reason the read surface can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviousVersionReason {
    NotConfigured,
    NoPreviousDescriptor,
    CaptureExceededBudget,
    CoverageComplete,
    Expired,
    LeaseInactive,
    ScopeRevoked,
}

/// D7: the in-memory lifecycle facts the read surface consults. The client
/// computes them from its own state; the module owns the decision so it can be
/// tested with injected time and injected lifecycle state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PreviousVersionLifecycle {
    /// §7.3.5 lease error or expiry.
    pub lease_inactive: bool,
    /// §3.3 scope revocation (any revoked subscription).
    pub scope_revoked: bool,
    /// §7.4.5 replacement coverage complete.
    pub coverage_complete: bool,
}

/// D7 read spec.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreviousVersionReadSpec {
    pub table: String,
    pub row_ids: Vec<String>,
    pub limit: Option<i64>,
}

/// D7: `limit` defaults to 50, must be positive, and is capped at 200.
pub fn resolve_previous_version_limit(limit: Option<i64>) -> Result<i64, String> {
    match limit {
        None => Ok(PREVIOUS_VERSION_DEFAULT_LIMIT),
        Some(limit) if limit >= 1 => Ok(limit.min(PREVIOUS_VERSION_MAX_LIMIT)),
        Some(_) => Err(
            "sync.invalid_request: previousVersionSnapshot limit must be a positive number"
                .to_owned(),
        ),
    }
}

/// Read the container's own metadata record, opening the sibling file for that
/// window only. `None` when there is no file or the record is unreadable.
pub fn read_previous_version_record(
    replica_path: &str,
) -> Result<Option<PreviousVersionRecord>, String> {
    let path = previous_version_container_path(replica_path);
    if !std::path::Path::new(&path).exists() {
        return Ok(None);
    }
    let container = Connection::open(&path)
        .map_err(|error| format!("open previous-version container {path:?}: {error}"))?;
    let record = read_previous_version_container(&container);
    let _ = container.close();
    // A container this module cannot read is treated as absent metadata, which
    // the boot reconcile discards on the next open.
    Ok(record.unwrap_or(None))
}

/// D7: the read surface. `config` is the resolved feature config (`None` or
/// `enabled: false` ⇒ not configured); `lifecycle` is computed by the client
/// from in-memory state; `now_ms` is the injected clock.
///
/// Lease stop/expiry, scope revocation, coverage completion and the TTL all
/// DISCARD the container and close the read with their own reason — closing
/// reads without discarding would leave the plaintext behind.
pub fn previous_version_snapshot(
    replica: &Connection,
    replica_path: Option<&str>,
    config: Option<&PreviousVersionContextConfig>,
    lifecycle: PreviousVersionLifecycle,
    now_ms: i64,
    current_version: i32,
    spec: &PreviousVersionReadSpec,
) -> Result<PreviousVersionSnapshot, String> {
    let Some(config) = config.filter(|config| config.enabled) else {
        return Ok(PreviousVersionSnapshot::unavailable(
            current_version,
            PreviousVersionReason::NotConfigured,
        ));
    };
    let record = match replica_path {
        Some(replica_path) => read_previous_version_record(replica_path)?,
        None => None,
    };
    let discard = |reason: PreviousVersionReason| {
        if let Some(replica_path) = replica_path {
            discard_previous_version(replica, replica_path)?;
        }
        Ok(PreviousVersionSnapshot::unavailable(
            current_version,
            reason,
        ))
    };
    if lifecycle.lease_inactive {
        return discard(PreviousVersionReason::LeaseInactive);
    }
    if lifecycle.scope_revoked {
        return discard(PreviousVersionReason::ScopeRevoked);
    }
    if lifecycle.coverage_complete {
        return discard(PreviousVersionReason::CoverageComplete);
    }
    let Some(record) = record else {
        let reason = stored_previous_version_refusal(replica)
            .unwrap_or(PreviousVersionRefusalReason::NoPreviousDescriptor);
        return Ok(PreviousVersionSnapshot::unavailable(
            current_version,
            reason.as_read_reason(),
        ));
    };
    if now_ms - record.created_at_ms > config.max_age_ms {
        return discard(PreviousVersionReason::Expired);
    }
    let Some(table) = record.table(&spec.table) else {
        return Err(format!(
            "sync.invalid_request: previousVersionSnapshot names unknown previous table {:?}",
            spec.table
        ));
    };
    let Some(replica_path) = replica_path else {
        return Ok(PreviousVersionSnapshot::unavailable(
            current_version,
            PreviousVersionReason::NoPreviousDescriptor,
        ));
    };
    let path = previous_version_container_path(replica_path);
    let container = Connection::open(&path)
        .map_err(|error| format!("open previous-version container {path:?}: {error}"))?;
    let (rows, truncated) = read_previous_version_rows(
        &container,
        table,
        &spec.row_ids,
        resolve_previous_version_limit(spec.limit)?,
    )?;
    let _ = container.close();
    Ok(PreviousVersionSnapshot {
        state: PREVIOUS_VERSION_STATE,
        available: true,
        previous_version: Some(record.previous_version),
        current_version,
        reason: None,
        rows,
        truncated,
    })
}

/// Decode the durable refusal; `None` when absent or corrupt. The successful
/// record lives inside the container file, so this key is absent whenever a
/// container is present.
pub fn stored_previous_version_refusal(
    replica: &Connection,
) -> Option<PreviousVersionRefusalReason> {
    let raw = meta_get(replica, PREVIOUS_VERSION_CONTEXT_KEY)?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let Value::Object(record) = &parsed else {
        return None;
    };
    if as_count(record.get("v")) != Some(1) {
        return None;
    }
    match record.get("reason").and_then(Value::as_str) {
        Some("no-previous-descriptor") => Some(PreviousVersionRefusalReason::NoPreviousDescriptor),
        Some("capture-exceeded-budget") => {
            Some(PreviousVersionRefusalReason::CaptureExceededBudget)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviousVersionAuditReason {
    UnknownTable,
    UnknownColumn,
}

impl PreviousVersionAuditReason {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::UnknownTable => "unknown-table",
            Self::UnknownColumn => "unknown-column",
        }
    }
}

/// D6: one incompatible commit. Records the commit id, table, typed reason and
/// offending column ONLY — never an operation, row value or envelope field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousVersionAuditEntry {
    pub commit_id: String,
    pub table: String,
    pub reason: PreviousVersionAuditReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

/// D6: the advisory pre-reset compatibility audit. Bounded at
/// [`MAX_AUDIT_INCOMPATIBLE`] entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousVersionAudit {
    pub v: i64,
    pub at_ms: i64,
    pub from_version: i32,
    pub to_version: i32,
    pub pending: i64,
    pub encodable: i64,
    pub truncated: bool,
    pub incompatible: Vec<PreviousVersionAuditEntry>,
}

pub const MAX_AUDIT_INCOMPATIBLE: usize = 200;

/// One pending outbox commit as the audit needs it: its id, and `(table, value
/// keys)` per operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCommitAudit<'a> {
    pub commit_id: &'a str,
    pub operations: Vec<(&'a str, Vec<&'a str>)>,
}

/// The first reason these operations cannot re-encode under `schema`, mirroring
/// the TS `firstIncompatibility`. Shared with the §7.4.4 send-time drop so the
/// audit and the drop never disagree about what is incompatible.
pub fn first_incompatibility<'a>(
    schema: &ClientSchema,
    operations: &[(&'a str, Vec<&'a str>)],
) -> Option<(&'a str, PreviousVersionAuditReason, Option<&'a str>)> {
    for (table_name, value_keys) in operations {
        let Some(table) = schema.table(table_name) else {
            return Some((*table_name, PreviousVersionAuditReason::UnknownTable, None));
        };
        for key in value_keys {
            if !table.columns.iter().any(|column| column.name == *key) {
                return Some((
                    *table_name,
                    PreviousVersionAuditReason::UnknownColumn,
                    Some(*key),
                ));
            }
        }
    }
    None
}

/// D6: classify pending outbox commits against the NEW compiled schema, before
/// the wipe. Advisory only — it drops nothing.
pub fn build_previous_version_audit(
    schema: &ClientSchema,
    pending: &[PendingCommitAudit<'_>],
    from_version: i32,
    to_version: i32,
    at_ms: i64,
) -> PreviousVersionAudit {
    let mut incompatible = Vec::new();
    let mut incompatible_total = 0usize;
    let mut encodable = 0i64;
    for commit in pending {
        let Some((table, reason, column)) = first_incompatibility(schema, &commit.operations)
        else {
            encodable += 1;
            continue;
        };
        incompatible_total += 1;
        if incompatible.len() < MAX_AUDIT_INCOMPATIBLE {
            incompatible.push(PreviousVersionAuditEntry {
                commit_id: commit.commit_id.to_owned(),
                table: table.to_owned(),
                reason,
                column: column.map(str::to_owned),
            });
        }
    }
    PreviousVersionAudit {
        v: 1,
        at_ms,
        from_version,
        to_version,
        pending: pending.len() as i64,
        encodable,
        truncated: incompatible_total > MAX_AUDIT_INCOMPATIBLE,
        incompatible,
    }
}

pub fn write_previous_version_audit(replica: &Connection, audit: &PreviousVersionAudit) {
    if let Ok(encoded) = serde_json::to_string(audit) {
        meta_set(replica, PREVIOUS_VERSION_AUDIT_KEY, &encoded);
    }
}

/// Strict decode; `None` when absent or malformed.
pub fn stored_previous_version_audit(replica: &Connection) -> Option<PreviousVersionAudit> {
    let raw = meta_get(replica, PREVIOUS_VERSION_AUDIT_KEY)?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let Value::Object(record) = &parsed else {
        return None;
    };
    if !has_exact_keys(
        record,
        &[
            "atMs",
            "encodable",
            "fromVersion",
            "incompatible",
            "pending",
            "toVersion",
            "truncated",
            "v",
        ],
    ) || as_count(record.get("v")) != Some(1)
        || record.get("truncated").and_then(Value::as_bool).is_none()
    {
        return None;
    }
    let count = |key: &str| as_count(record.get(key));
    let Some(Value::Array(entries)) = record.get("incompatible") else {
        return None;
    };
    let mut incompatible = Vec::with_capacity(entries.len());
    for entry in entries {
        let Value::Object(entry) = entry else {
            return None;
        };
        let (Some(Value::String(commit_id)), Some(Value::String(table))) =
            (entry.get("commitId"), entry.get("table"))
        else {
            return None;
        };
        let reason = match entry.get("reason").and_then(Value::as_str) {
            Some("unknown-table") => PreviousVersionAuditReason::UnknownTable,
            Some("unknown-column") => PreviousVersionAuditReason::UnknownColumn,
            _ => return None,
        };
        let column = match entry.get("column") {
            None | Some(Value::Null) => None,
            Some(Value::String(column)) => Some(column.clone()),
            Some(_) => return None,
        };
        incompatible.push(PreviousVersionAuditEntry {
            commit_id: commit_id.clone(),
            table: table.clone(),
            reason,
            column,
        });
    }
    Some(PreviousVersionAudit {
        v: 1,
        at_ms: count("atMs")?,
        from_version: i32::try_from(count("fromVersion")?).ok()?,
        to_version: i32::try_from(count("toVersion")?).ok()?,
        pending: count("pending")?,
        encodable: count("encodable")?,
        truncated: record.get("truncated").and_then(Value::as_bool)?,
        incompatible,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviousVersionDiscardOutcome {
    pub present: bool,
    pub discarded: bool,
}

/// D9 boot hygiene: a container whose metadata is missing/undecodable, or
/// whose recorded `currentVersion` is not the running generated schema version,
/// is discarded before anything can read it.
///
/// This is the ONE gap the reset sweep cannot see. The capture commits in the
/// container's OWN transaction, independent of the replica's savepoint, so a
/// crash after that commit but before the replica commits leaves a container
/// whose `currentVersion` is the NEW schema beside the OLD marker. The next
/// open at the old schema version takes the same-version branch — no reset, no
/// sweep — and would otherwise serve that container. Idempotent: no container
/// file means no-op.
pub fn reconcile_previous_version_at_boot(
    replica: &Connection,
    replica_path: &str,
    current_version: i32,
    max_age_ms: Option<i64>,
    now_ms: i64,
) -> Result<(), String> {
    let path = previous_version_container_path(replica_path);
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    let record = match Connection::open(&path) {
        Ok(container) => {
            let record = read_previous_version_container(&container).unwrap_or(None);
            let _ = container.close();
            record
        }
        // Unreadable is the same decision as unknown metadata: discard it.
        Err(_) => None,
    };
    // D7/A1: the TTL is applied by an AWARE binary only (`max_age_ms` is set
    // when the feature is configured). It makes no claim about an unaware
    // same-schema rollback, which runs none of this code.
    let stale = match &record {
        // Missing or undecodable metadata: nothing can read it safely.
        None => true,
        Some(record) => {
            record.current_version != current_version
                || max_age_ms.is_some_and(|max_age_ms| now_ms - record.created_at_ms > max_age_ms)
        }
    };
    if !stale {
        return Ok(());
    }
    discard_previous_version(replica, replica_path)?;
    Ok(())
}

/// D7/D9/A2: the executable discard — drop the container and both metadata
/// records and remove the FILE. Idempotent: a no-op succeeds, and a container
/// that cannot even be opened (torn file) is still removed and reported as
/// discarded rather than failing. This is the RFC 0006 key-loss contract: a
/// throw here would block reactivation while the plaintext is gone.
pub fn discard_previous_version(
    replica: &Connection,
    replica_path: &str,
) -> Result<PreviousVersionDiscardOutcome, String> {
    let path = previous_version_container_path(replica_path);
    let mut present = std::path::Path::new(&path).exists();
    if present {
        if let Ok(container) = Connection::open(&path) {
            let _ = drop_previous_version_container(&container);
            let _ = container.close();
        }
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
    use crate::client::{SyncClient, LOCAL_SCHEMA_VERSION_KEY};
    use crate::schema::parse_schema_json;

    fn enabled_config() -> PreviousVersionContextConfig {
        PreviousVersionContextConfig {
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn previous_version_snapshot_reasons_use_injected_lifecycle_and_discard() {
        let temp = TempFiles::new("read-reasons");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 2);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let container_path = previous_version_container_path(&replica_path);
        let config = enabled_config();
        let spec = PreviousVersionReadSpec {
            table: "things".to_owned(),
            ..Default::default()
        };
        let lifecycle = PreviousVersionLifecycle::default();

        // 1. Off and disabled are the same read outcome.
        for config in [None, Some(&PreviousVersionContextConfig::default())] {
            let snapshot = previous_version_snapshot(
                &replica,
                Some(&replica_path),
                config,
                lifecycle,
                0,
                2,
                &spec,
            )
            .expect("snapshot");
            assert!(!snapshot.available);
            assert_eq!(snapshot.reason, Some(PreviousVersionReason::NotConfigured));
            assert_eq!(snapshot.state, "previousVersion");
            assert_eq!(snapshot.current_version, 2);
            assert!(snapshot.previous_version.is_none());
            assert!(snapshot.rows.is_empty());
        }

        // 2. A capture refused for want of a descriptor is a durable reason.
        let refused =
            capture_previous_version_from_replica(&replica, &replica_path, 3, 2, &config, 1_000)
                .expect("capture");
        assert!(matches!(
            refused,
            CaptureOutcome::Refused {
                reason: PreviousVersionRefusalReason::NoPreviousDescriptor,
                ..
            }
        ));
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000,
            2,
            &spec,
        )
        .expect("snapshot");
        assert_eq!(
            snapshot.reason,
            Some(PreviousVersionReason::NoPreviousDescriptor)
        );

        // 3. A budget refusal keeps its measured reason too.
        let tiny = PreviousVersionContextConfig {
            max_bytes: 1,
            enabled: true,
            ..Default::default()
        };
        capture_previous_version_from_replica(&replica, &replica_path, 1, 2, &tiny, 1_000)
            .expect("capture");
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000,
            2,
            &spec,
        )
        .expect("snapshot");
        assert_eq!(
            snapshot.reason,
            Some(PreviousVersionReason::CaptureExceededBudget)
        );
        assert!(!Path::new(&container_path).exists());

        // 4. A successful capture is readable with typed rows.
        let recapture = || {
            let outcome = capture_previous_version_from_replica(
                &replica,
                &replica_path,
                1,
                2,
                &config,
                1_000,
            )
            .expect("capture");
            assert!(matches!(outcome, CaptureOutcome::Captured(_)));
        };
        recapture();
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000,
            2,
            &spec,
        )
        .expect("snapshot");
        assert!(snapshot.available);
        assert_eq!(snapshot.previous_version, Some(1));
        assert_eq!(snapshot.current_version, 2);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.state, "previousVersion");
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.rows.len(), 2);
        assert_eq!(snapshot.rows[0]["s"], json!("hello"));
        assert_eq!(snapshot.rows[0]["b"], json!(true));
        assert_eq!(snapshot.rows[0]["by"], json!({ "$bytes": "010203" }));

        // Row selection, and an unknown previous table is a loud request error.
        let selected = PreviousVersionReadSpec {
            table: "things".to_owned(),
            row_ids: vec!["r2".to_owned()],
            limit: Some(1),
        };
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000,
            2,
            &selected,
        )
        .expect("snapshot");
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.rows[0]["id"], json!("r2"));
        let unknown = PreviousVersionReadSpec {
            table: "absent".to_owned(),
            ..Default::default()
        };
        assert!(previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000,
            2,
            &unknown
        )
        .expect_err("unknown previous table")
        .contains("unknown previous table"));

        // 5. Lease stop/expiry, scope revocation and coverage completion each
        // DISCARD the container and close the read with their own reason.
        for (lifecycle, expected) in [
            (
                PreviousVersionLifecycle {
                    lease_inactive: true,
                    ..Default::default()
                },
                PreviousVersionReason::LeaseInactive,
            ),
            (
                PreviousVersionLifecycle {
                    scope_revoked: true,
                    ..Default::default()
                },
                PreviousVersionReason::ScopeRevoked,
            ),
            (
                PreviousVersionLifecycle {
                    coverage_complete: true,
                    ..Default::default()
                },
                PreviousVersionReason::CoverageComplete,
            ),
        ] {
            recapture();
            assert!(Path::new(&container_path).exists());
            let snapshot = previous_version_snapshot(
                &replica,
                Some(&replica_path),
                Some(&config),
                lifecycle,
                1_000,
                2,
                &spec,
            )
            .expect("snapshot");
            assert!(!snapshot.available, "{expected:?}");
            assert_eq!(snapshot.reason, Some(expected));
            assert!(snapshot.rows.is_empty());
            assert!(
                !Path::new(&container_path).exists(),
                "{expected:?} must physically remove the container"
            );
            assert_eq!(meta_get(&replica, PREVIOUS_VERSION_CONTEXT_KEY), None);
        }
    }

    #[test]
    fn previous_version_ttl_applies_at_read_and_at_boot_with_injected_now() {
        let temp = TempFiles::new("ttl");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 1);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let container_path = previous_version_container_path(&replica_path);
        let config = enabled_config();
        let max_age_ms = config.max_age_ms;
        let spec = PreviousVersionReadSpec {
            table: "things".to_owned(),
            ..Default::default()
        };
        let lifecycle = PreviousVersionLifecycle::default();
        let capture_at = || {
            let outcome = capture_previous_version_from_replica(
                &replica,
                &replica_path,
                1,
                2,
                &config,
                1_000,
            )
            .expect("capture");
            assert!(matches!(outcome, CaptureOutcome::Captured(_)));
        };

        // At the boundary the capture is still good; one millisecond later the
        // read expires it and removes the file.
        capture_at();
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_000 + max_age_ms,
            2,
            &spec,
        )
        .expect("snapshot");
        assert!(snapshot.available);
        let snapshot = previous_version_snapshot(
            &replica,
            Some(&replica_path),
            Some(&config),
            lifecycle,
            1_001 + max_age_ms,
            2,
            &spec,
        )
        .expect("snapshot");
        assert_eq!(snapshot.reason, Some(PreviousVersionReason::Expired));
        assert!(!Path::new(&container_path).exists());

        // Boot: no TTL without an aware binary (`max_age_ms` is None when the
        // feature is off) — the container is NOT deleted by an unaware boot
        // path. This asserts the limitation: the TTL is an aware-binary
        // hygiene bound and nothing else.
        capture_at();
        reconcile_previous_version_at_boot(
            &replica,
            &replica_path,
            2,
            None,
            1_000 + max_age_ms * 10,
        )
        .expect("boot reconcile without a TTL");
        assert!(Path::new(&container_path).exists());

        // Boot: aware, within the TTL → kept; beyond it → discarded.
        reconcile_previous_version_at_boot(
            &replica,
            &replica_path,
            2,
            Some(max_age_ms),
            1_000 + max_age_ms,
        )
        .expect("boot reconcile");
        assert!(Path::new(&container_path).exists());
        reconcile_previous_version_at_boot(
            &replica,
            &replica_path,
            2,
            Some(max_age_ms),
            1_001 + max_age_ms,
        )
        .expect("boot reconcile");
        assert!(!Path::new(&container_path).exists());
    }

    #[test]
    fn previous_version_audit_records_typed_reasons_and_round_trips() {
        let temp = TempFiles::new("audit");
        seed_replica(temp.replica(), 1);
        let replica = Connection::open(temp.replica()).expect("open replica");
        let schema = schema(2);

        let pending = vec![
            PendingCommitAudit {
                commit_id: "c1",
                operations: vec![("things", vec!["id", "removed"])],
            },
            PendingCommitAudit {
                commit_id: "c2",
                operations: vec![("gone", vec![])],
            },
            PendingCommitAudit {
                commit_id: "c3",
                operations: vec![("things", vec!["id"])],
            },
        ];
        let audit = build_previous_version_audit(&schema, &pending, 1, 2, 42);
        assert_eq!(audit.v, 1);
        assert_eq!(audit.at_ms, 42);
        assert_eq!(audit.from_version, 1);
        assert_eq!(audit.to_version, 2);
        assert_eq!(audit.pending, 3);
        assert_eq!(audit.encodable, 1);
        assert!(!audit.truncated);
        assert_eq!(audit.incompatible.len(), 2);
        assert_eq!(
            audit.incompatible[0],
            PreviousVersionAuditEntry {
                commit_id: "c1".to_owned(),
                table: "things".to_owned(),
                reason: PreviousVersionAuditReason::UnknownColumn,
                column: Some("removed".to_owned()),
            }
        );
        assert_eq!(
            audit.incompatible[1],
            PreviousVersionAuditEntry {
                commit_id: "c2".to_owned(),
                table: "gone".to_owned(),
                reason: PreviousVersionAuditReason::UnknownTable,
                column: None,
            }
        );
        // The record carries a typed reason and NO envelope, operation or value.
        let encoded = serde_json::to_string(&audit).expect("encode audit");
        for forbidden in ["operations", "values", "payload", "envelope", "row_id"] {
            assert!(!encoded.contains(forbidden), "{encoded}");
        }
        assert!(encoded.contains("\"reason\":\"unknown-column\""));
        assert!(encoded.contains("\"reason\":\"unknown-table\""));

        write_previous_version_audit(&replica, &audit);
        assert_eq!(stored_previous_version_audit(&replica), Some(audit.clone()));
        // Strict decode: a malformed record reads as absent.
        meta_set(&replica, PREVIOUS_VERSION_AUDIT_KEY, "{\"v\":1}");
        assert_eq!(stored_previous_version_audit(&replica), None);
        meta_set(
            &replica,
            PREVIOUS_VERSION_AUDIT_KEY,
            "{\"v\":1,\"atMs\":0,\"fromVersion\":1,\"toVersion\":2,\"pending\":0,\"encodable\":0,\"truncated\":false,\"incompatible\":[{\"commitId\":\"c\",\"table\":\"t\",\"reason\":\"other\"}]}",
        );
        assert_eq!(stored_previous_version_audit(&replica), None);

        // Bounded at MAX_AUDIT_INCOMPATIBLE entries with `truncated`.
        let many = (0..MAX_AUDIT_INCOMPATIBLE + 5)
            .map(|_index| PendingCommitAudit {
                commit_id: "c",
                operations: vec![("gone", vec![])],
            })
            .collect::<Vec<_>>();
        let audit = build_previous_version_audit(&schema, &many, 1, 2, 0);
        assert_eq!(audit.pending, MAX_AUDIT_INCOMPATIBLE as i64 + 5);
        assert_eq!(audit.encodable, 0);
        assert_eq!(audit.incompatible.len(), MAX_AUDIT_INCOMPATIBLE);
        assert!(audit.truncated);
    }

    #[test]
    fn previous_version_limit_defaults_and_ceiling_match_ts() {
        assert_eq!(resolve_previous_version_limit(None), Ok(50));
        assert_eq!(resolve_previous_version_limit(Some(7)), Ok(7));
        assert_eq!(resolve_previous_version_limit(Some(999)), Ok(200));
        assert!(resolve_previous_version_limit(Some(0)).is_err());
        assert!(resolve_previous_version_limit(Some(-1)).is_err());
    }

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
            .execute("INSERT INTO notes(id, body) VALUES ('n1', 'note')", [])
            .expect("insert note");
        // D1: the descriptor the bump's capture reads, exactly as the client
        // writes it — plus the §7.4.1 marker of the version that wrote it.
        set_local_schema_descriptor(&replica, &schema(1));
        meta_set(&replica, LOCAL_SCHEMA_VERSION_KEY, "1");
    }

    fn descriptor() -> LocalSchemaDescriptor {
        build_local_schema_descriptor(&schema(1))
    }

    #[test]
    fn previous_version_descriptor_round_trips_and_rejects_unknown_shapes() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            "CREATE TABLE _syncular_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
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
        assert_eq!(record.bytes, measurement.bytes);
        assert_eq!(record.created_at_ms, 1_700_000_000_000);
        assert_eq!(record.tables.len(), 2);
        assert_eq!(record.tables[0].columns.len(), 11);

        let table = record.table("things").expect("things in the record");
        let (rows, truncated) =
            read_previous_version_rows(&container, table, &[], 50).expect("read rows");
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
            let outcome =
                capture_previous_version_from_replica(&replica, &replica_path, 1, 2, &config, 1)
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
    fn previous_version_torn_container_never_blocks_sweep_discard_or_open() {
        let temp = TempFiles::new("torn");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        let container_path = previous_version_container_path(&replica_path);

        // FIX 1: garbage at the sibling path makes the connection open but
        // every statement fail with "file is not a database".
        std::fs::write(&container_path, b"not a sqlite database").expect("write garbage");
        let replica = Connection::open(temp.replica()).expect("open replica");

        // The sweep must still remove it, and must not error.
        sweep_previous_version_container(&replica, &replica_path)
            .expect("a torn container must not fail the sweep");
        assert!(!Path::new(&container_path).exists());

        // The discard must report it and still remove it.
        std::fs::write(&container_path, b"not a sqlite database").expect("write garbage again");
        let discarded = discard_previous_version(&replica, &replica_path)
            .expect("a torn container must not fail the discard");
        assert!(discarded.present);
        assert!(discarded.discarded);
        assert!(!Path::new(&container_path).exists());

        // And a client opening over a torn container must still open, sweeping
        // it on the bump path.
        std::fs::write(&container_path, b"not a sqlite database")
            .expect("write garbage a third time");
        seed_replica(temp.replica(), 1);
        {
            SyncClient::open_path(
                "pvc".to_owned(),
                &schema_json(2),
                ClientLimits::default(),
                &replica_path,
            )
            .expect("a torn container must not block the client open");
        }
        assert!(!Path::new(&container_path).exists());
    }

    #[test]
    fn previous_version_same_version_open_discards_a_container_it_did_not_bump_to() {
        // Reproduces the exact cross-file interleaving: the replica savepoint
        // opens (marker still 1), the sweep runs, the container's OWN
        // transaction commits {previousVersion: 1, currentVersion: 2}, and the
        // process dies before the replica savepoint releases. The next open is
        // at the OLD schema version, so it runs no reset and no sweep.
        let temp = TempFiles::new("same-version-orphan");
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
        // The replica never committed: the marker is still 1.
        assert_eq!(
            meta_get(&replica, LOCAL_SCHEMA_VERSION_KEY).as_deref(),
            Some("1")
        );
        drop(replica);

        // Opening at the SAME version (1) must discard the stale container
        // before any read surface can see it, and open normally.
        {
            let client = SyncClient::open_path(
                "pvc".to_owned(),
                &schema_json(1),
                ClientLimits::default(),
                &replica_path,
            )
            .expect("the old-schema open must succeed");
            let rows = client
                .query("SELECT COUNT(*) AS c FROM things", &[])
                .expect("the client still serves ordinary queries");
            assert_eq!(rows.len(), 1);
        }
        // Read storage directly, never through a read API.
        assert!(!Path::new(&container_path).exists());
        let inspect = Connection::open(&replica_path).expect("inspect after open");
        assert_eq!(meta_get(&inspect, PREVIOUS_VERSION_CONTEXT_KEY), None);
        assert_eq!(meta_get(&inspect, PREVIOUS_VERSION_AUDIT_KEY), None);
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

        // A container whose recorded currentVersion MATCHES the running schema
        // is left alone (it is the container this boot would serve).
        let temp = TempFiles::new("same-version-live");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        seed_replica(temp.replica(), 1);
        let replica = Connection::open(temp.replica()).expect("open replica");
        capture_previous_version_from_replica(
            &replica,
            &replica_path,
            1,
            1,
            &PreviousVersionContextConfig::default(),
            1,
        )
        .expect("capture");
        drop(replica);
        let container_path = previous_version_container_path(&replica_path);
        assert!(Path::new(&container_path).exists());
        SyncClient::open_path(
            "pvc".to_owned(),
            &schema_json(1),
            ClientLimits::default(),
            &replica_path,
        )
        .expect("open v1 beside a matching container");
        assert!(Path::new(&container_path).exists());
    }

    #[test]
    fn previous_version_client_writes_descriptor_and_captures_on_bump() {
        let temp = TempFiles::new("client");
        let replica_path = temp.replica().to_str().expect("utf-8 path").to_owned();
        let container_path = previous_version_container_path(&replica_path);

        // Fresh install at v1: the descriptor is written beside the marker and
        // the feature (default off) creates no container.
        {
            let mut client = SyncClient::open_path(
                "pvc".to_owned(),
                &schema_json(1),
                ClientLimits::default(),
                &replica_path,
            )
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
            let descriptor =
                load_local_schema_descriptor(&inspect).expect("descriptor after install");
            assert_eq!(descriptor.version, 1);
            assert_eq!(descriptor.tables.len(), 2);
            assert_eq!(
                descriptor.table("things").expect("things").columns.len(),
                11
            );
        }
        assert!(!Path::new(&container_path).exists());

        // A same-version open backfills a descriptor an unaware binary never wrote.
        {
            let inspect = Connection::open(&replica_path).expect("inspect");
            meta_delete(&inspect, LOCAL_SCHEMA_DESCRIPTOR_KEY);
        }
        {
            let _client = SyncClient::open_path(
                "pvc".to_owned(),
                &schema_json(1),
                ClientLimits::default(),
                &replica_path,
            )
            .expect("reopen v1");
        }
        {
            let inspect = Connection::open(&replica_path).expect("inspect v1 again");
            assert_eq!(
                load_local_schema_descriptor(&inspect)
                    .expect("backfilled")
                    .version,
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
                load_local_schema_descriptor(&inspect)
                    .expect("descriptor after bump")
                    .version,
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
