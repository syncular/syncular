//! Client schema IR (SPEC.md §2.4) — the same JSON shape the conformance
//! fixture uses (`DriverSchema`): tables with typed columns, a primary key,
//! and §3.1 scope patterns (`'prefix:{variable}'`, column defaults to the
//! variable name).

use std::collections::BTreeSet;

use serde::Deserialize;
use ssp2::segment::{Column, ColumnType};

#[derive(Debug, Clone, Deserialize)]
pub struct SchemaIr {
    #[serde(alias = "schemaVersion")]
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
    #[serde(default)]
    pub local_projections: Vec<LocalProjection>,
    /// §7.4.3 table generation (typegen); absent for hand-written schemas.
    #[serde(default)]
    pub generation: Option<String>,
    /// Built-in FTS left this key in 0.102; its presence is refused so an
    /// old generated schema never silently loses search.
    #[serde(default)]
    pub fts_indexes: Option<serde_json::Value>,
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
    /// §6.7: the server sets this column inside the push; a client never
    /// authors it (`serverOwned` in JSON).
    #[serde(default, rename = "serverOwned")]
    pub server_owned: bool,
}

/// One local secondary index (the CREATE INDEX migration subset, §2.4).
#[derive(Debug, Clone, Deserialize)]
pub struct IndexIr {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalProjection {
    pub name: String,
    pub generation: String,
    pub columns: Vec<ProjectionColumn>,
    pub fts: Option<ProjectionFts>,
    #[serde(default)]
    pub dependencies: Vec<ProjectionDependency>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionColumn {
    pub name: String,
    pub declared_type: ProjectionType,
    /// The source-table column a built-in projection copies (SPEC "Built-in
    /// FTS5 projections"); absent on every column of an app-filled one.
    #[serde(default)]
    pub source: Option<String>,
}

impl LocalProjection {
    /// Every column names a source; the loader refuses a mix.
    pub fn built_in(&self) -> bool {
        self.columns.iter().any(|column| column.source.is_some())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionType {
    String,
    Integer,
    Real,
    Boolean,
    Json,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionFts {
    pub tokenize: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionDependency {
    pub table: String,
    pub column: String,
    pub source_column: String,
}

fn fts_tokenizer(tokenizer: &str) -> bool {
    matches!(
        tokenizer,
        "unicode61"
            | "unicode61 remove_diacritics 0"
            | "unicode61 remove_diacritics 1"
            | "unicode61 remove_diacritics 2"
            | "porter unicode61"
            | "trigram"
    )
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
    pub prefix: String,
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
    pub local_projections: Vec<LocalProjection>,
    /// §5.11: encrypted columns (index + declared type). Empty ⇒ no E2EE.
    pub encrypted_columns: Vec<EncryptedColumn>,
    /// §6.7: indices of server-owned columns. Empty ⇒ every column is authored.
    pub server_owned_columns: Vec<usize>,
    /// §7.4.3: a schema bump keeps the table while this equals the persisted one.
    pub generation: Option<String>,
}

impl TableSchema {
    /// §5.11: true when any column is encrypted (skip the seam entirely else).
    pub fn has_encrypted_columns(&self) -> bool {
        !self.encrypted_columns.is_empty()
    }

    /// §5.11 sealed apply: the reserved `_sync_sealed_key` and `_sync_sealed`
    /// columns every table with an encrypted column stores after
    /// `_syncular_version`, in this order.
    pub fn sealed_columns(&self) -> &'static [&'static str] {
        if self.has_encrypted_columns() {
            &["_sync_sealed_key", "_sync_sealed"]
        } else {
            &[]
        }
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
    // §7.4.2: the persisted marker is a canonical positive i32 and a replica
    // refuses any requested version outside that range before it touches
    // storage, so a client can never persist a marker it would reject on the
    // next open.
    if ir.version < 1 {
        return Err(
            "sync.invalid_request: generated schema version must be an integer in 1..=2147483647"
                .to_owned(),
        );
    }
    let mut tables = Vec::with_capacity(ir.tables.len());
    let mut schema_object_names = BTreeSet::new();
    for table in &ir.tables {
        if table.fts_indexes.is_some() {
            return Err(format!(
                "client.schema_invalid: table {:?} declares ftsIndexes; regenerate the schema",
                table.name
            ));
        }
        if !schema_object_names.insert(table.name.clone()) {
            return Err(format!("duplicate table or schema object {:?}", table.name));
        }
    }
    for table in &ir.tables {
        // wire_columns carry the on-the-wire type (bytes for encrypted); the
        // local `columns` carry the declared type so the local mirror is
        // plaintext (§5.11).
        let mut wire_columns = Vec::with_capacity(table.columns.len());
        let mut columns = Vec::with_capacity(table.columns.len());
        let mut encrypted_columns = Vec::new();
        let mut server_owned_columns = Vec::new();
        for (index, column) in table.columns.iter().enumerate() {
            // §6.7: typegen and the servers refuse an ineligible column.
            if column.server_owned {
                server_owned_columns.push(index);
            }
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
        // §2.4 primary-key eligibility: a primary key MUST render to a
        // `rowId` string every implementation produces identically and local
        // storage resolves without deferring to a SQLite build.
        if !matches!(
            columns[pk_index].ty,
            ColumnType::String | ColumnType::Integer | ColumnType::Boolean | ColumnType::Json
        ) {
            return Err(format!(
                "table {:?}: primary key {:?} has an ineligible column type (§2.4); a primary key must be string, integer, boolean, or json",
                table.name, table.primary_key
            ));
        }
        let mut scope_variables = Vec::with_capacity(table.scopes.len());
        for scope in &table.scopes {
            let variable = parse_pattern_variable(&scope.pattern)?;
            let column = scope.column.clone().unwrap_or_else(|| variable.clone());
            if !columns.iter().any(|c| {
                c.name == column && matches!(c.ty, ColumnType::String | ColumnType::Integer)
            }) {
                return Err(format!(
                    "table {:?}: scope column {column:?} must be a string or integer column (§3.1)",
                    table.name
                ));
            }
            let open = scope.pattern.find('{').expect("validated scope pattern");
            let prefix = scope.pattern[..open]
                .strip_suffix(':')
                .unwrap_or(&scope.pattern[..open])
                .to_owned();
            scope_variables.push(ScopeVariable {
                variable,
                column,
                prefix,
            });
        }
        let mut indexes = Vec::with_capacity(table.indexes.len());
        for index in &table.indexes {
            if !schema_object_names.insert(index.name.clone()) {
                return Err(format!(
                    "table {:?}: index {:?} conflicts with another schema object",
                    table.name, index.name
                ));
            }
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
        if table.generation.as_deref() == Some("") {
            return Err(format!(
                "table {:?}: generation must be a non-empty string (§7.4.3)",
                table.name
            ));
        }
        tables.push(TableSchema {
            generation: table.generation.clone(),
            name: table.name.clone(),
            columns,
            wire_columns,
            primary_key: table.primary_key.clone(),
            pk_index,
            scope_variables,
            indexes,
            local_projections: table.local_projections.clone(),
            encrypted_columns,
            server_owned_columns,
        });
    }
    let mut names: BTreeSet<_> = schema_object_names
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    for source in &tables {
        for spec in &source.local_projections {
            let invalid =
                || "client.schema_invalid: invalid local projection declaration".to_owned();
            let valid_ident = |name: &str| {
                let lower = name.to_ascii_lowercase();
                name.len() <= 63
                    && !lower.starts_with("_sync")
                    && !lower.starts_with("sync_")
                    && !lower.starts_with("sqlite_")
                    && name
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            };
            let lower = spec.name.to_ascii_lowercase();
            if !valid_ident(&spec.name)
                || !names.insert(lower.clone())
                || spec.generation.is_empty()
                || spec.columns.is_empty()
                || spec.fts.as_ref().is_some_and(|fts| {
                    !fts_tokenizer(&fts.tokenize)
                        || fts.columns.is_empty()
                        || fts.columns.iter().collect::<BTreeSet<_>>().len() != fts.columns.len()
                        || !fts.columns.iter().all(|field| {
                            spec.columns.iter().any(|col| {
                                col.name == *field && col.declared_type == ProjectionType::String
                            })
                        })
                })
            {
                return Err(invalid());
            }
            // A built-in projection copies string columns of its own table
            // and has no pending work for a dependency to invalidate.
            if spec.built_in()
                && (spec.fts.is_none()
                    || !spec.dependencies.is_empty()
                    || !spec.columns.iter().all(|column| {
                        column.declared_type == ProjectionType::String
                            && column.source.as_ref().is_some_and(|name| {
                                source.columns.iter().any(|col| {
                                    col.name == *name && matches!(col.ty, ColumnType::String)
                                })
                            })
                    }))
            {
                return Err(invalid());
            }
            let mut columns = BTreeSet::new();
            if spec.fts.is_some() {
                columns.extend([lower, "rank".to_owned(), "rowid".to_owned()]);
            }
            for column in &spec.columns {
                if !valid_ident(&column.name) || !columns.insert(column.name.to_ascii_lowercase()) {
                    return Err(invalid());
                }
            }
            for dependency in &spec.dependencies {
                let dep = tables
                    .iter()
                    .find(|table| table.name == dependency.table)
                    .ok_or_else(invalid)?;
                let plaintext = |table: &TableSchema, name: &str| {
                    table
                        .columns
                        .iter()
                        .position(|col| col.name == name)
                        .is_some_and(|index| {
                            !table.encrypted_columns.iter().any(|col| col.index == index)
                        })
                };
                if !plaintext(dep, &dependency.column)
                    || !plaintext(source, &dependency.source_column)
                    || (dependency.source_column != source.primary_key
                        && !source
                            .indexes
                            .iter()
                            .any(|index| index.columns.first() == Some(&dependency.source_column)))
                {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(ClientSchema {
        version: ir.version,
        tables,
    })
}

pub fn parse_schema_json(json: &serde_json::Value) -> Result<ClientSchema, String> {
    // §7.4.2: validate the requested version before the typed IR decode, so a
    // missing, non-integer, or out-of-i32-range version is a request error
    // (matching the TS core) instead of a generic parse failure. `SchemaIr`
    // accepts the server IR spelling `schemaVersion` as an alias; giving both
    // spellings stays a duplicate-field error from the decode below.
    let version = json
        .get("version")
        .or_else(|| json.get("schemaVersion"))
        .and_then(serde_json::Value::as_i64);
    if !version.is_some_and(|version| (1..=i32::MAX as i64).contains(&version)) {
        return Err(
            "sync.invalid_request: generated schema version must be an integer in 1..=2147483647"
                .to_owned(),
        );
    }
    let ir: SchemaIr = serde_json::from_value(json.clone()).map_err(|e| {
        if json
            .get("tables")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|tables| {
                tables.iter().any(|table| {
                    table.get("localProjections").is_some_and(|projections| {
                        serde_json::from_value::<Vec<LocalProjection>>(projections.clone()).is_err()
                    })
                })
            })
        {
            "client.schema_invalid: invalid local projection declaration".to_owned()
        } else {
            format!("bad schema IR: {e}")
        }
    })?;
    compile_schema(&ir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema_with_fts(column: serde_json::Value, tokenize: &str) -> serde_json::Value {
        json!({
            "version": 1,
            "tables": [{
                "name": "docs",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "org_id", "type": "string", "nullable": false },
                    column
                ],
                "scopes": [{ "pattern": "org:{org_id}" }],
                "localProjections": [{
                    "name": "docs_fts",
                    "generation": "1",
                    "columns": [{ "name": "body", "declaredType": "string", "source": "body" }],
                    "fts": { "tokenize": tokenize, "columns": ["body"] }
                }]
            }]
        })
    }

    #[test]
    fn accepts_the_schema_version_alias_and_refuses_conflicting_spellings() {
        let schema = json!({
            "schemaVersion": 2,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [{ "name": "id", "type": "string", "nullable": false }],
                "scopes": []
            }]
        });
        let compiled = parse_schema_json(&schema).expect("the server IR alias compiles");
        assert_eq!(compiled.version, 2);
        // Both spellings name the same field: the duplicate is a decode error,
        // never a silent choice between the two values.
        let mut both = schema.clone();
        both["version"] = json!(3);
        let error = parse_schema_json(&both).expect_err("duplicate version spellings");
        assert!(error.starts_with("bad schema IR:"), "{error}");
        // The alias is subject to the same range check.
        let mut out_of_range = schema.clone();
        out_of_range["schemaVersion"] = json!(0);
        let error = parse_schema_json(&out_of_range).expect_err("out-of-range alias");
        assert!(error.starts_with("sync.invalid_request:"), "{error}");
    }

    #[test]
    fn compiles_server_owned_column_indices() {
        let compiled = parse_schema_json(&json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": true },
                    { "name": "stamp", "type": "string", "nullable": true, "serverOwned": true }
                ],
                "scopes": []
            }]
        }))
        .expect("compiles");
        assert_eq!(compiled.tables[0].server_owned_columns, vec![2]);
    }

    #[test]
    fn compiles_an_allowlisted_string_fts_projection() {
        let schema = parse_schema_json(&schema_with_fts(
            json!({ "name": "body", "type": "string", "nullable": false }),
            "unicode61 remove_diacritics 2",
        ))
        .expect("valid FTS schema");
        assert!(schema.tables[0].local_projections[0].built_in());
    }

    #[test]
    fn accepts_encrypted_declared_strings_and_rejects_other_fts_definitions() {
        let encrypted = schema_with_fts(
            json!({
                "name": "body", "type": "bytes", "nullable": false,
                "encrypted": true, "declaredType": "string"
            }),
            "unicode61",
        );
        parse_schema_json(&encrypted).expect("local plaintext FTS accepts encrypted strings");

        let non_string = schema_with_fts(
            json!({ "name": "body", "type": "integer", "nullable": false }),
            "unicode61",
        );
        assert!(parse_schema_json(&non_string)
            .expect_err("non-string FTS must fail")
            .starts_with("client.schema_invalid:"));

        let tokenizer = schema_with_fts(
            json!({ "name": "body", "type": "string", "nullable": false }),
            "custom",
        );
        assert!(parse_schema_json(&tokenizer)
            .expect_err("custom tokenizer must fail")
            .starts_with("client.schema_invalid:"));
    }

    #[test]
    fn refuses_a_mixed_or_fts_less_built_in_projection() {
        let body = json!({ "name": "body", "type": "string", "nullable": false });
        let mut mixed = schema_with_fts(body.clone(), "unicode61");
        mixed["tables"][0]["localProjections"][0]["columns"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": "note", "declaredType": "string" }));
        let mut without_fts = schema_with_fts(body.clone(), "unicode61");
        without_fts["tables"][0]["localProjections"][0]
            .as_object_mut()
            .unwrap()
            .remove("fts");
        let mut unknown_source = schema_with_fts(body, "unicode61");
        unknown_source["tables"][0]["localProjections"][0]["columns"][0]["source"] =
            json!("missing");
        for schema in [mixed, without_fts, unknown_source] {
            assert_eq!(
                parse_schema_json(&schema).expect_err("invalid built-in projection"),
                "client.schema_invalid: invalid local projection declaration"
            );
        }
    }
}
