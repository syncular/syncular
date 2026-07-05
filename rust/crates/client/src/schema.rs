//! Client schema IR (SPEC.md §2.4) — the same JSON shape the conformance
//! fixture uses (`DriverSchema`): tables with typed columns, a primary key,
//! and §3.1 scope patterns (`'prefix:{variable}'`, column defaults to the
//! variable name).

use serde::Deserialize;
use ssp2::segment::{Column, ColumnType};

#[derive(Debug, Clone, Deserialize)]
pub struct SchemaIr {
    pub version: i32,
    pub tables: Vec<TableIr>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableIr {
    pub name: String,
    pub columns: Vec<ColumnIr>,
    pub primary_key: String,
    pub scopes: Vec<ScopePatternIr>,
    /// Local secondary indexes; absent in the IR for index-free tables
    /// (typegen omits the key), so default to empty on deserialize.
    #[serde(default)]
    pub indexes: Vec<IndexIr>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnIr {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub nullable: bool,
    /// §5.11: this column is encrypted end-to-end. When set, `column_type` is
    /// `bytes` (the wire type) and `declared_type` is the app type.
    #[serde(default)]
    pub encrypted: bool,
    /// §5.11: the app-side type of an encrypted column (`declaredType` in JSON).
    #[serde(default, rename = "declaredType")]
    pub declared_type: Option<String>,
}

/// One local secondary index (the CREATE INDEX migration subset, §2.4).
#[derive(Debug, Clone, Deserialize)]
pub struct IndexIr {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// One compiled local secondary index — created on the base + visible tables.
#[derive(Debug, Clone)]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScopePatternIr {
    pub pattern: String,
    #[serde(default)]
    pub column: Option<String>,
}

/// One declared scope variable, mapped to its local column (§3.1, §3.3).
#[derive(Debug, Clone)]
pub struct ScopeVariable {
    pub variable: String,
    pub column: String,
}

/// §5.11: one encrypted column — its positional index and its app-side
/// declared type name (`string`, `integer`, …). The wire `Column.ty` is
/// `bytes`; this carries the pre-flip type for the encrypt/decrypt seam.
#[derive(Debug, Clone)]
pub struct EncryptedColumn {
    pub index: usize,
    pub declared_type: String,
}

#[derive(Debug, Clone)]
pub struct TableSchema {
    pub name: String,
    /// LOCAL columns (declaration order). For an encrypted column (§5.11) the
    /// `ty` is the DECLARED type — the local mirror stores plaintext, so
    /// read-back and DDL use the real type. Identical to `wire_columns` when
    /// the table has no encrypted columns.
    pub columns: Vec<Column>,
    /// WIRE columns (§2.4 positional codec): identical to `columns` except an
    /// encrypted column's `ty` is `bytes` (the ciphertext envelope rides the
    /// bytes machinery). Used by `encode_row_json`/`decode_row_bytes` and the
    /// §5.2 segment column-table validation.
    pub wire_columns: Vec<Column>,
    pub primary_key: String,
    pub pk_index: usize,
    pub scope_variables: Vec<ScopeVariable>,
    /// Local secondary indexes, in declaration order (empty when none).
    pub indexes: Vec<IndexSchema>,
    /// §5.11: encrypted columns (index + declared type). Empty ⇒ no E2EE.
    pub encrypted_columns: Vec<EncryptedColumn>,
}

impl TableSchema {
    /// §5.11: true when any column is encrypted (skip the seam entirely else).
    pub fn has_encrypted_columns(&self) -> bool {
        !self.encrypted_columns.is_empty()
    }
}

impl TableSchema {
    /// §3.3 purge mapping: the generated local scope column for a variable,
    /// or `None` (the fail-closed case).
    pub fn scope_column(&self, variable: &str) -> Option<&str> {
        self.scope_variables
            .iter()
            .find(|s| s.variable == variable)
            .map(|s| s.column.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct ClientSchema {
    pub version: i32,
    pub tables: Vec<TableSchema>,
}

impl ClientSchema {
    pub fn table(&self, name: &str) -> Option<&TableSchema> {
        self.tables.iter().find(|t| t.name == name)
    }
}

fn parse_column_type(name: &str) -> Result<ColumnType, String> {
    match name {
        "string" => Ok(ColumnType::String),
        "integer" => Ok(ColumnType::Integer),
        "float" => Ok(ColumnType::Float),
        "boolean" => Ok(ColumnType::Boolean),
        "json" => Ok(ColumnType::Json),
        "bytes" => Ok(ColumnType::Bytes),
        "blob_ref" => Ok(ColumnType::BlobRef),
        "crdt" => Ok(ColumnType::Crdt),
        other => Err(format!("unknown column type {other:?}")),
    }
}

/// Extract `{variable}` from a `'prefix:{variable}'` pattern (§3.1).
fn parse_pattern_variable(pattern: &str) -> Result<String, String> {
    let open = pattern
        .find('{')
        .ok_or_else(|| format!("scope pattern {pattern:?} has no {{variable}}"))?;
    let close = pattern
        .rfind('}')
        .filter(|end| *end > open)
        .ok_or_else(|| format!("scope pattern {pattern:?} has no closing brace"))?;
    let variable = &pattern[open + 1..close];
    if variable.is_empty() {
        return Err(format!("scope pattern {pattern:?} has an empty variable"));
    }
    Ok(variable.to_owned())
}

pub fn compile_schema(ir: &SchemaIr) -> Result<ClientSchema, String> {
    let mut tables = Vec::with_capacity(ir.tables.len());
    for table in &ir.tables {
        // wire_columns carry the on-the-wire type (bytes for encrypted); the
        // local `columns` carry the declared type so the local mirror is
        // plaintext (§5.11).
        let mut wire_columns = Vec::with_capacity(table.columns.len());
        let mut columns = Vec::with_capacity(table.columns.len());
        let mut encrypted_columns = Vec::new();
        for (index, column) in table.columns.iter().enumerate() {
            let wire_ty = parse_column_type(&column.column_type)?;
            wire_columns.push(Column {
                name: column.name.clone(),
                ty: wire_ty,
                nullable: column.nullable,
            });
            if column.encrypted {
                let declared_name = column.declared_type.clone().ok_or_else(|| {
                    format!(
                        "table {:?}: encrypted column {:?} has no declaredType (§5.11)",
                        table.name, column.name
                    )
                })?;
                let declared_ty = parse_column_type(&declared_name)?;
                columns.push(Column {
                    name: column.name.clone(),
                    ty: declared_ty,
                    nullable: column.nullable,
                });
                encrypted_columns.push(EncryptedColumn {
                    index,
                    declared_type: declared_name,
                });
            } else {
                columns.push(Column {
                    name: column.name.clone(),
                    ty: wire_ty,
                    nullable: column.nullable,
                });
            }
        }
        let pk_index = columns
            .iter()
            .position(|c| c.name == table.primary_key)
            .ok_or_else(|| {
                format!(
                    "table {:?}: primary key {:?} is not a column",
                    table.name, table.primary_key
                )
            })?;
        let mut scope_variables = Vec::with_capacity(table.scopes.len());
        for scope in &table.scopes {
            let variable = parse_pattern_variable(&scope.pattern)?;
            let column = scope.column.clone().unwrap_or_else(|| variable.clone());
            scope_variables.push(ScopeVariable { variable, column });
        }
        let mut indexes = Vec::with_capacity(table.indexes.len());
        for index in &table.indexes {
            for col in &index.columns {
                if !columns.iter().any(|c| &c.name == col) {
                    return Err(format!(
                        "table {:?}: index {:?} names unknown column {col:?}",
                        table.name, index.name
                    ));
                }
            }
            indexes.push(IndexSchema {
                name: index.name.clone(),
                columns: index.columns.clone(),
                unique: index.unique,
            });
        }
        tables.push(TableSchema {
            name: table.name.clone(),
            columns,
            wire_columns,
            primary_key: table.primary_key.clone(),
            pk_index,
            scope_variables,
            indexes,
            encrypted_columns,
        });
    }
    Ok(ClientSchema {
        version: ir.version,
        tables,
    })
}

pub fn parse_schema_json(json: &serde_json::Value) -> Result<ClientSchema, String> {
    let ir: SchemaIr =
        serde_json::from_value(json.clone()).map_err(|e| format!("bad schema IR: {e}"))?;
    compile_schema(&ir)
}
