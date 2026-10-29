//! The schema JSON `SyncClient` takes (SPEC.md §2.4), compiled to the server
//! view the reference `compileSchema` builds: wire column types, the primary
//! key, §3.1 scope patterns, declared indexes, §6.11 references and their
//! incoming edges, and `crdt` columns with their `crdtType`.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{json, Value};
use ssp2::segment::{Column, ColumnType};

use crate::AuthorityError;

#[derive(Deserialize)]
struct SchemaIr {
    #[serde(alias = "schemaVersion")]
    version: i64,
    tables: Vec<TableIr>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableIr {
    name: String,
    columns: Vec<ColumnIr>,
    primary_key: String,
    scopes: Vec<ScopeIr>,
    #[serde(default)]
    indexes: Vec<IndexIr>,
    #[serde(default)]
    references: Vec<ReferenceIr>,
}

#[derive(Deserialize)]
struct ColumnIr {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    nullable: bool,
    #[serde(default, rename = "crdtType")]
    crdt_type: Option<String>,
}

/// `'prefix:{variable}'` shorthand (column = variable) or the object form.
#[derive(Deserialize)]
#[serde(untagged)]
enum ScopeIr {
    Pattern(String),
    Object {
        pattern: String,
        #[serde(default)]
        column: Option<String>,
    },
}

#[derive(Deserialize)]
struct IndexIr {
    name: String,
    columns: Vec<String>,
    #[serde(default)]
    unique: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceIr {
    column: String,
    parent_table: String,
    #[serde(default)]
    on_delete: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnDelete {
    Restrict,
    Cascade,
    SetNull,
}

#[derive(Debug, Clone)]
pub(crate) struct Scope {
    pub variable: String,
    pub pattern: String,
    pub column: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct Index {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// An outgoing declared reference (§6.11).
#[derive(Debug, Clone)]
pub(crate) struct Reference {
    pub column: usize,
    pub parent: String,
}

/// An incoming declared reference: rows of `child` whose `column` names a
/// row of the table that carries this entry.
#[derive(Debug, Clone)]
pub(crate) struct Incoming {
    pub child: String,
    pub column: usize,
    pub on_delete: OnDelete,
}

#[derive(Debug, Clone)]
pub(crate) struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    pub pk: usize,
    pub scopes: Vec<Scope>,
    pub indexes: Vec<Index>,
    pub references: Vec<Reference>,
    pub referenced_by: Vec<Incoming>,
    /// `crdt` columns (§5.10.1): index and `crdtType`.
    pub crdt: Vec<(usize, String)>,
    /// `blob_ref` columns (§5.9).
    pub blob_refs: Vec<usize>,
}

impl Table {
    pub fn declares(&self, variable: &str) -> bool {
        self.scopes.iter().any(|scope| scope.variable == variable)
    }

    /// The stored-layout fingerprint the migration compares (§12.2): column
    /// names, types and nullability, the primary key, the scope patterns.
    pub fn layout(&self) -> Value {
        json!({
            "columns": self
                .columns
                .iter()
                .map(|c| json!([c.name, c.ty.name(), c.nullable]))
                .collect::<Vec<_>>(),
            "primaryKey": self.pk,
            "scopes": self
                .scopes
                .iter()
                .map(|s| json!([s.pattern, self.columns[s.column].name]))
                .collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Schema {
    pub version: i32,
    pub tables: Vec<Table>,
}

impl Schema {
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.iter().find(|table| table.name == name)
    }
}

fn invalid(reason: String) -> AuthorityError {
    AuthorityError::with_details(
        "sync.invalid_request",
        "the local authority schema is invalid",
        json!({ "reason": reason }),
    )
}

/// Table and column names share the namespace of the authority's own
/// `sync_*` tables and `_sync_*` meta columns.
fn reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.is_empty()
        || lower.starts_with("sync_")
        || lower.starts_with("_sync_")
        || lower.starts_with("sqlite_")
}

pub(crate) fn parse_schema(json: &Value) -> Result<Schema, AuthorityError> {
    let ir: SchemaIr =
        serde_json::from_value(json.clone()).map_err(|e| invalid(format!("bad schema IR: {e}")))?;
    let version = i32::try_from(ir.version)
        .ok()
        .filter(|version| *version >= 1)
        .ok_or_else(|| invalid("schema version must be an integer in 1..=2147483647".to_owned()))?;
    let mut tables: Vec<Table> = Vec::with_capacity(ir.tables.len());
    let mut on_deletes: Vec<Vec<OnDelete>> = Vec::with_capacity(ir.tables.len());
    for table in &ir.tables {
        if reserved(&table.name) {
            return Err(invalid(format!("table name {:?} is reserved", table.name)));
        }
        if tables.iter().any(|t| t.name == table.name) {
            return Err(invalid(format!("duplicate table {:?}", table.name)));
        }
        let mut columns = Vec::with_capacity(table.columns.len());
        let mut crdt = Vec::new();
        let mut blob_refs = Vec::new();
        for (index, column) in table.columns.iter().enumerate() {
            if reserved(&column.name) || columns.iter().any(|c: &Column| c.name == column.name) {
                return Err(invalid(format!(
                    "table {:?}: column name {:?} is reserved or duplicate",
                    table.name, column.name
                )));
            }
            let ty = ColumnType::from_name(&column.ty)
                .ok_or_else(|| invalid(format!("unknown column type {:?}", column.ty)))?;
            match ty {
                ColumnType::Crdt => match &column.crdt_type {
                    Some(crdt_type) if !crdt_type.is_empty() => {
                        crdt.push((index, crdt_type.clone()))
                    }
                    _ => {
                        return Err(invalid(format!(
                            "table {:?}: crdt column {:?} must declare a crdtType (§5.10.1)",
                            table.name, column.name
                        )))
                    }
                },
                ColumnType::BlobRef => blob_refs.push(index),
                _ => {}
            }
            columns.push(Column {
                name: column.name.clone(),
                ty,
                nullable: column.nullable,
            });
        }
        let index_of = |name: &str| columns.iter().position(|c| c.name == name);
        let pk = index_of(&table.primary_key).ok_or_else(|| {
            invalid(format!(
                "table {:?}: primary key {:?} is not a column",
                table.name, table.primary_key
            ))
        })?;
        if !matches!(
            columns[pk].ty,
            ColumnType::String | ColumnType::Integer | ColumnType::Boolean | ColumnType::Json
        ) {
            return Err(invalid(format!(
                "table {:?}: primary key has an ineligible column type (§2.4)",
                table.name
            )));
        }
        if table.scopes.is_empty() {
            return Err(invalid(format!(
                "table {:?}: every synced table declares at least one scope pattern (§3.1)",
                table.name
            )));
        }
        let mut scopes: Vec<Scope> = Vec::with_capacity(table.scopes.len());
        for scope in &table.scopes {
            let (pattern, column) = match scope {
                ScopeIr::Pattern(pattern) => (pattern, None),
                ScopeIr::Object { pattern, column } => (pattern, column.as_ref()),
            };
            // `^([^{}]+):\{([^{}:]+)\}$`
            let variable = pattern
                .strip_suffix('}')
                .and_then(|body| {
                    let open = body.find('{')?;
                    let prefix = body[..open].strip_suffix(':')?;
                    let variable = &body[open + 1..];
                    let clean = !prefix.is_empty()
                        && !prefix.contains(['{', '}'])
                        && !variable.is_empty()
                        && !variable.contains(['{', '}', ':']);
                    clean.then(|| variable.to_owned())
                })
                .ok_or_else(|| {
                    invalid(format!(
                        "table {:?}: scope pattern {pattern:?} must be 'prefix:{{variable}}'",
                        table.name
                    ))
                })?;
            let column_name = column.cloned().unwrap_or_else(|| variable.clone());
            let column = index_of(&column_name).ok_or_else(|| {
                invalid(format!(
                    "table {:?}: scope pattern {pattern:?} names unknown column {column_name:?}",
                    table.name
                ))
            })?;
            if scopes
                .iter()
                .any(|s| s.variable == variable && s.column != column)
            {
                return Err(invalid(format!(
                    "table {:?}: variable {variable:?} maps to two different columns (§3.1)",
                    table.name
                )));
            }
            scopes.push(Scope {
                variable,
                pattern: pattern.clone(),
                column,
            });
        }
        let mut indexes: Vec<Index> = Vec::with_capacity(table.indexes.len());
        for index in &table.indexes {
            if index.columns.is_empty()
                || indexes.iter().any(|i| i.name == index.name)
                || index.columns.iter().any(|c| index_of(c).is_none())
            {
                return Err(invalid(format!(
                    "table {:?}: index {:?} is duplicate, empty or names an unknown column",
                    table.name, index.name
                )));
            }
            indexes.push(Index {
                name: index.name.clone(),
                columns: index.columns.clone(),
                unique: index.unique,
            });
        }
        let mut references = Vec::with_capacity(table.references.len());
        let mut deletes = Vec::with_capacity(table.references.len());
        for reference in &table.references {
            let column = index_of(&reference.column).ok_or_else(|| {
                invalid(format!(
                    "table {:?}: reference column {:?} is not a column",
                    table.name, reference.column
                ))
            })?;
            let on_delete = match reference.on_delete.as_deref() {
                None | Some("RESTRICT") => OnDelete::Restrict,
                Some("CASCADE") => OnDelete::Cascade,
                Some("SET NULL") => OnDelete::SetNull,
                Some(other) => {
                    return Err(invalid(format!(
                        "table {:?}: reference column {:?} declares unknown onDelete {other:?}",
                        table.name, reference.column
                    )))
                }
            };
            references.push(Reference {
                column,
                parent: reference.parent_table.clone(),
            });
            deletes.push(on_delete);
        }
        tables.push(Table {
            name: table.name.clone(),
            columns,
            pk,
            scopes,
            indexes,
            references,
            referenced_by: Vec::new(),
            crdt,
            blob_refs,
        });
        on_deletes.push(deletes);
    }
    // §6.11 declaration rules, as the reference `compileSchema` enforces them.
    let patterns = |table: &Table| -> BTreeSet<String> {
        table.scopes.iter().map(|s| s.pattern.clone()).collect()
    };
    let mut incoming: BTreeMap<usize, Vec<Incoming>> = BTreeMap::new();
    for (child_index, child) in tables.iter().enumerate() {
        for (reference, on_delete) in child.references.iter().zip(&on_deletes[child_index]) {
            let column = &child.columns[reference.column];
            let fail = |reason: &str| {
                invalid(format!(
                    "table {:?}: reference column {:?} {reason} (§6.11)",
                    child.name, column.name
                ))
            };
            let parent_index = tables
                .iter()
                .position(|t| t.name == reference.parent)
                .ok_or_else(|| fail("names an unknown table"))?;
            let parent = &tables[parent_index];
            if column.ty != parent.columns[parent.pk].ty {
                return Err(fail("does not match the parent primary-key type"));
            }
            if *on_delete == OnDelete::SetNull && !column.nullable {
                return Err(fail("is not nullable but declares ON DELETE SET NULL"));
            }
            if patterns(child) != patterns(parent) {
                return Err(fail("targets a table whose scope patterns differ"));
            }
            if !child
                .indexes
                .iter()
                .any(|i| i.columns.len() == 1 && i.columns[0] == column.name)
            {
                return Err(fail("needs a declared single-column index"));
            }
            incoming.entry(parent_index).or_default().push(Incoming {
                child: child.name.clone(),
                column: reference.column,
                on_delete: *on_delete,
            });
        }
    }
    for (parent, entries) in incoming {
        tables[parent].referenced_by = entries;
    }
    Ok(Schema { version, tables })
}
