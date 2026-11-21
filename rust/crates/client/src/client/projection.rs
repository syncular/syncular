use super::*;
use crate::schema::{LocalProjection, ProjectionType};

const REGISTRY: &str = "_syncular_local_projections";
const PENDING: &str = "_syncular_projection_pending";
use ssp2::primitives::{parse_json_document, I64_SAFE_MAX as MAX_COUNTER};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionInput {
    pub source_id: String,
    pub token: i64,
    #[serde(deserialize_with = "serde::Deserialize::deserialize")]
    pub values: Option<Map<String, Value>>,
}

struct ProjectionSql {
    name: String,
    relation: String,
    pk: String,
    from: String,
    source_id: String,
    identity: String,
    content: String,
    fields: String,
    identity_id: &'static str,
    fts: bool,
}

impl ProjectionSql {
    fn new(spec: &LocalProjection, source: &TableSchema) -> Self {
        let relation = quote_ident(&spec.name);
        let pk = quote_ident(&source.primary_key);
        Self {
            name: format!("'{}'", spec.name),
            source_id: format!("CAST(s.{pk} AS TEXT)"),
            from: format!("{} AS s", visible_table(&source.name)),
            fts: spec.fts.is_some(),
            identity: if spec.fts.is_some() {
                quote_ident(&format!("_syncular_fts_{}", spec.name))
            } else {
                relation.clone()
            },
            content: if spec.fts.is_some() {
                quote_ident(&format!("_syncular_projection_{}", spec.name))
            } else {
                relation.clone()
            },
            fields: std::iter::once(quote_ident(FTS_SOURCE_ID_COLUMN))
                .chain(spec.columns.iter().map(|column| quote_ident(&column.name)))
                .collect::<Vec<_>>()
                .join(","),
            identity_id: if spec.fts.is_some() {
                "source_id"
            } else {
                r#""_syncular_source_id""#
            },
            relation,
            pk,
        }
    }

    fn ids(&self, condition: &str) -> String {
        format!(
            "SELECT {} FROM {} WHERE {condition}",
            self.source_id, self.from
        )
    }

    fn clear(&self, select: &str) -> Vec<String> {
        let mut sql = Vec::new();
        if self.fts {
            let affected = format!(
                "rowid IN (SELECT id FROM {} WHERE source_id IN ({select}))",
                self.identity
            );
            sql.push(format!("INSERT INTO {relation}({relation},rowid,{fields}) SELECT 'delete',rowid,{fields} FROM {content} WHERE {affected}", relation=self.relation, fields=self.fields, content=self.content));
            sql.push(format!("DELETE FROM {} WHERE {affected}", self.content));
        }
        sql.push(format!(
            "DELETE FROM {} WHERE {} IN ({select})",
            self.identity, self.identity_id
        ));
        sql
    }

    fn pending(&self, condition: &str) -> [String; 2] {
        [
            format!(
                "INSERT INTO {PENDING}(name,source_id,token) SELECT {name},{source_id},p.token+row_number() OVER () FROM {from},{REGISTRY} AS p WHERE p.name={name} AND ({condition}) ON CONFLICT(name,source_id) DO UPDATE SET token=excluded.token",
                name=self.name, source_id=self.source_id, from=self.from,
            ),
            format!("UPDATE {REGISTRY} SET token=token+changes() WHERE name={}", self.name),
        ]
    }
}

impl SyncClient {
    pub(super) fn detach_projections(
        &self,
        kept: Option<&BTreeSet<String>>,
    ) -> Result<BTreeSet<String>, String> {
        let mut names = BTreeSet::new();
        if !self.stored(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [REGISTRY],
            |row| row.get::<_, bool>(0),
        ))? {
            return Ok(names);
        }
        let mut stmt = self.stored(self.conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_syncular_project_*'"))?;
        let triggers = self.stored(
            self.stored(stmt.query_map([], |row| row.get::<_, String>(0)))?
                .collect::<Result<Vec<_>, _>>(),
        )?;
        for name in triggers {
            self.stored(
                self.conn
                    .execute(&format!("DROP TRIGGER {}", quote_ident(&name)), []),
            )?;
        }
        let mut stmt = self.stored(self.conn.prepare(&format!(
            "SELECT name,generation,fts FROM {REGISTRY} WHERE generation IS NOT NULL"
        )))?;
        let stored = self.stored(stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        }))?;
        for (name, generation, fts) in self.stored(stored.collect::<Result<Vec<_>, _>>())? {
            let keep = self.schema.tables.iter().any(|source| {
                source.local_projections.iter().any(|spec| {
                    spec.name == name
                        && spec.generation == generation
                        && kept.is_none_or(|names| {
                            names.contains(&source.name)
                                && spec
                                    .dependencies
                                    .iter()
                                    .all(|dep| names.contains(&dep.table))
                        })
                })
            });
            if keep {
                if fts {
                    for shadow in ["data", "idx", "docsize", "config"] {
                        names.insert(format!("{name}_{shadow}"));
                    }
                }
                names.insert(name);
            } else {
                self.stored(
                    self.conn
                        .execute(&format!("DROP TABLE {}", quote_ident(&name)), []),
                )?;
                if fts {
                    self.stored(self.conn.execute(
                        &format!(
                            "DROP TABLE {}",
                            quote_ident(&format!("_syncular_fts_{name}"))
                        ),
                        [],
                    ))?;
                    self.stored(self.conn.execute(
                        &format!(
                            "DROP TABLE {}",
                            quote_ident(&format!("_syncular_projection_{name}"))
                        ),
                        [],
                    ))?;
                }
                self.stored(
                    self.conn
                        .execute(&format!("DELETE FROM {PENDING} WHERE name=?1"), [&name]),
                )?;
                self.stored(self.conn.execute(
                    &format!("UPDATE {REGISTRY} SET generation=NULL,epoch=epoch+1 WHERE name=?1"),
                    [&name],
                ))?;
            }
        }
        Ok(names)
    }

    pub(super) fn open_projections(&self) -> Result<(), String> {
        let projections: BTreeMap<_, _> = self
            .schema
            .tables
            .iter()
            .flat_map(|source| {
                source
                    .local_projections
                    .iter()
                    .map(move |spec| (spec.name.as_str(), (spec, source)))
            })
            .collect();
        if projections.is_empty() {
            return Ok(());
        }
        self.stored(self.conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {REGISTRY}(name TEXT PRIMARY KEY,generation TEXT,fts INTEGER NOT NULL,epoch INTEGER NOT NULL CHECK(epoch<={MAX_COUNTER}),token INTEGER NOT NULL DEFAULT 0 CHECK(token<={MAX_COUNTER}),reported INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS {PENDING}(name TEXT NOT NULL,source_id TEXT NOT NULL,token INTEGER,PRIMARY KEY(name,source_id)) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS _syncular_projection_tokens ON {PENDING}(name,token) WHERE token IS NOT NULL"
        )))?;
        for (name, (spec, source)) in projections {
            let sql = ProjectionSql::new(spec, source);
            let fields = spec
                .columns
                .iter()
                .map(|col| {
                    let ty = match col.declared_type {
                        ProjectionType::String | ProjectionType::Json => "TEXT",
                        ProjectionType::Integer | ProjectionType::Boolean => "INTEGER",
                        ProjectionType::Real => "REAL",
                    };
                    format!("{} {ty}", quote_ident(&col.name))
                })
                .collect::<Vec<_>>()
                .join(", ");
            if let Some(fts) = &spec.fts {
                self.stored(self.conn.execute(&format!("CREATE TABLE IF NOT EXISTS {}(rowid INTEGER PRIMARY KEY,{FTS_SOURCE_ID_COLUMN} TEXT NOT NULL,{fields})", sql.content), []))?;
                let fields = spec
                    .columns
                    .iter()
                    .map(|col| {
                        let field = quote_ident(&col.name);
                        if fts.columns.contains(&col.name) {
                            field
                        } else {
                            format!("{field} UNINDEXED")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                self.create_fts_storage(
                    name,
                    &fields,
                    &fts.tokenize,
                    &format!(",content='_syncular_projection_{name}'"),
                )?;
                let count = format!("(SELECT count(*) FROM {})", sql.content);
                let damaged: bool = self.stored(self.conn.query_row(&format!(
                    "SELECT {count}!=(SELECT count(*) FROM {}) OR {count}!=(SELECT count(*) FROM {})", sql.identity, quote_ident(&format!("{name}_docsize"))
                ), [], |row| row.get(0)))?;
                if damaged {
                    self.stored(self.conn.execute_batch(&format!("DELETE FROM {mapping};
                         INSERT INTO {mapping}(id,source_id) SELECT rowid,{FTS_SOURCE_ID_COLUMN} FROM {content};
                         INSERT INTO {fts}({fts}) VALUES ('rebuild')", mapping=sql.identity, content=sql.content, fts=sql.relation)))?;
                }
            } else {
                self.stored(self.conn.execute(&format!("CREATE TABLE IF NOT EXISTS {}({FTS_SOURCE_ID_COLUMN} TEXT NOT NULL PRIMARY KEY,{fields}) WITHOUT ROWID", sql.relation), []))?;
            }
            let epoch = (uuid::Uuid::new_v4().as_u128() & ((1 << 52) - 1)) as i64;
            self.stored(self.conn.execute(
                &format!("INSERT INTO {REGISTRY}(name,generation,fts,epoch) VALUES (?1,?2,?3,?4) ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,fts=excluded.fts"),
                rusqlite::params![name, spec.generation, sql.fts, epoch],
            ))?;
            self.stored(self.conn.execute_batch(&sql.pending(&format!(
                "NOT EXISTS(SELECT 1 FROM {identity} WHERE {identity_id}={source_id}) AND NOT EXISTS(SELECT 1 FROM {PENDING} WHERE name={name} AND source_id={source_id})",
                identity=sql.identity, identity_id=sql.identity_id, source_id=sql.source_id, name=sql.name,
            )).join(";")))?;

            let mut dependencies = BTreeMap::new();
            dependencies.insert(source.name.as_str(), Vec::new());
            for dep in &spec.dependencies {
                dependencies.entry(&dep.table).or_default().push(dep);
            }
            for (index, (table, columns)) in dependencies.into_iter().enumerate() {
                for (event, sides) in [
                    ("INSERT", &["new"][..]),
                    ("UPDATE", &["old", "new"][..]),
                    ("DELETE", &["old"][..]),
                ] {
                    let mut conditions: Vec<_> = columns
                        .iter()
                        .flat_map(|dep| {
                            sides.iter().map(|side| {
                                let left = format!("s.{}", quote_ident(&dep.source_column));
                                let right = format!("{side}.{}", quote_ident(&dep.column));
                                format!("({left}=+{right} AND +{left}=+{right})")
                            })
                        })
                        .collect();
                    let mut statements = Vec::new();
                    if table == source.name {
                        if event != "INSERT" {
                            let old_id = format!("SELECT CAST(old.{} AS TEXT)", sql.pk);
                            statements.extend(sql.clear(&old_id));
                            statements.push(format!(
                                "DELETE FROM {PENDING} WHERE name={} AND source_id IN ({old_id})",
                                sql.name
                            ));
                        }
                        if event != "DELETE" {
                            conditions.push(format!("s.{pk}=new.{pk}", pk = sql.pk));
                        }
                    }
                    if !conditions.is_empty() {
                        let condition = conditions.join(" OR ");
                        statements.extend(sql.clear(&sql.ids(&condition)));
                        statements.extend(sql.pending(&condition));
                    }
                    self.stored(self.conn.execute(
                        &format!(
                            "CREATE TRIGGER {} AFTER {event} ON {} BEGIN {}; END",
                            quote_ident(&format!("_syncular_project_{name}_{index}_{event}")),
                            quote_ident(table),
                            statements.join(";"),
                        ),
                        [],
                    ))?;
                }
            }
        }
        Ok(())
    }

    /// Called within the committing transaction. Advancing the watermark
    /// rolls back with its pending rows if the caller cannot commit.
    pub(super) fn collect_projection_pending(&self) -> Result<Vec<String>, String> {
        if !self
            .schema
            .tables
            .iter()
            .any(|table| !table.local_projections.is_empty())
        {
            return Ok(Vec::new());
        }
        let mut stmt = self.stored(self.conn.prepare_cached(&format!(
            "SELECT r.name FROM {REGISTRY} AS r WHERE r.token>r.reported AND EXISTS(SELECT 1 FROM {PENDING} p WHERE p.name=r.name AND p.token>r.reported) ORDER BY r.name"
        )))?;
        let rows = self.stored(stmt.query_map([], |row| row.get(0)))?;
        let names = self.stored(rows.collect::<Result<Vec<_>, _>>())?;
        self.stored(self.conn.execute(
            &format!("UPDATE {REGISTRY} SET reported=token WHERE token>reported"),
            [],
        ))?;
        Ok(names)
    }

    pub fn drain_projection_pending(&mut self) -> Vec<String> {
        self.projection_pending_queue.drain(..).collect()
    }

    fn require_projection(
        &self,
        name: &str,
    ) -> Result<(&LocalProjection, &TableSchema), ClientError> {
        if self.security_preflight() {
            return Err(ClientError {
                code: SECURITY_PREFLIGHT_REQUIRED_CODE.to_owned(),
                message: "protected reads require activateSecurity".to_owned(),
                details: None,
                retryable: false,
            });
        }
        self.lookup_projection(name)
    }

    pub(super) fn lookup_projection(
        &self,
        name: &str,
    ) -> Result<(&LocalProjection, &TableSchema), ClientError> {
        self.schema
            .tables
            .iter()
            .find_map(|source| {
                source
                    .local_projections
                    .iter()
                    .find(|spec| spec.name == name)
                    .map(|spec| (spec, source))
            })
            .ok_or_else(|| ClientError {
                code: "client.projection_unknown".to_owned(),
                message: "unknown local projection".to_owned(),
                details: Some(json!({"name": name})),
                retryable: false,
            })
    }

    fn projection_epoch(&self, name: &str) -> Result<i64, ClientError> {
        Ok(self.stored(self.conn.query_row(
            &format!("SELECT epoch FROM {REGISTRY} WHERE name=?1"),
            [name],
            |row| row.get(0),
        ))?)
    }

    pub fn projection_pending(&self, name: &str, limit: i64) -> Result<Value, ClientError> {
        self.require_projection(name)?;
        if !(0..=MAX_COUNTER).contains(&limit) {
            return Err(
                "sync.invalid_request: projection limit must be a nonnegative safe integer"
                    .to_owned()
                    .into(),
            );
        }
        let mut stmt = self.stored(self.conn.prepare_cached(&format!(
            "SELECT p.epoch,k.source_id,k.token FROM {REGISTRY} p LEFT JOIN (
                SELECT source_id,token FROM {PENDING} WHERE name=?1 AND token IS NOT NULL ORDER BY source_id LIMIT ?2
             ) k ON 1 WHERE p.name=?1 ORDER BY k.source_id"
        )))?;
        let mut rows = self.stored(stmt.query(rusqlite::params![name, limit]))?;
        let first = self.stored(rows.next())?.ok_or_else(|| {
            ClientError::from("sync.local_corrupt: missing projection epoch".to_owned())
        })?;
        let epoch: i64 = self.stored(first.get(0))?;
        let mut entries = Vec::new();
        let mut row = Some(first);
        while let Some(entry) = row {
            if let Some(source_id) = self.stored(entry.get::<_, Option<String>>(1))? {
                entries.push(
                    json!({"sourceId": source_id, "token": self.stored(entry.get::<_, i64>(2))?}),
                );
            }
            row = self.stored(rows.next())?;
        }
        Ok(json!({"epoch": epoch, "entries": entries}))
    }

    pub fn write_projection(
        &mut self,
        name: &str,
        epoch: i64,
        rows: &[ProjectionInput],
    ) -> Result<Value, ClientError> {
        let (spec, source) = self.require_projection(name)?;
        let sql = ProjectionSql::new(spec, source);
        let spec = spec.clone();
        if !(-MAX_COUNTER..=MAX_COUNTER).contains(&epoch)
            || rows
                .iter()
                .any(|row| !(-MAX_COUNTER..=MAX_COUNTER).contains(&row.token))
        {
            return Err(ClientError::from(
                "sync.invalid_request: invalid projection write".to_owned(),
            ));
        }
        self.begin_observation("syncular_projection_write")?;
        let result = (|| {
            let current = self.projection_epoch(name)?;
            let ProjectionSql {
                relation,
                identity,
                content,
                fields,
                ..
            } = sql;
            let binds = vec!["?"; spec.columns.len()].join(",");
            let mut written = Vec::new();
            let mut stale = Vec::new();
            for ProjectionInput {
                source_id,
                token,
                values,
            } in rows
            {
                let invalid = |column: &str| ClientError {
                    code: "client.projection_invalid".to_owned(),
                    message: "invalid local projection value".to_owned(),
                    details: Some(json!({"name": name, "column": column})),
                    retryable: false,
                };
                if let Some(values) = values {
                    for key in values.keys() {
                        if !spec.columns.iter().any(|column| column.name == *key) {
                            return Err(invalid(key));
                        }
                    }
                }
                let cells = values
                    .as_ref()
                    .map(|values| {
                        spec.columns
                            .iter()
                            .map(|column| {
                                let Some(value) =
                                    values.get(&column.name).filter(|value| !value.is_null())
                                else {
                                    return Ok(SqlValue::Null);
                                };
                                let cell = match column.declared_type {
                                    ProjectionType::String => {
                                        value.as_str().map(|value| SqlValue::Text(value.to_owned()))
                                    }
                                    ProjectionType::Integer => value
                                        .as_f64()
                                        .filter(|value| {
                                            value.fract() == 0.0
                                                && value.abs() <= MAX_COUNTER as f64
                                        })
                                        .map(|value| SqlValue::Integer(value as i64)),
                                    ProjectionType::Real => value.as_f64().map(SqlValue::Real),
                                    ProjectionType::Boolean => value
                                        .as_bool()
                                        .map(|value| SqlValue::Integer(i64::from(value))),
                                    ProjectionType::Json => value
                                        .as_str()
                                        .filter(|value| {
                                            parse_json_document(value, "projection value").is_ok()
                                        })
                                        .map(|value| SqlValue::Text(value.to_owned())),
                                };
                                cell.ok_or_else(|| invalid(&column.name))
                            })
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?;
                if epoch != current || !self.stored(self.conn.query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {PENDING} WHERE name=?1 AND source_id=?2 AND token=?3)"),
                    rusqlite::params![name, source_id, token], |row| row.get::<_, bool>(0),
                ))? {
                    stale.push(source_id);
                    continue;
                }
                if let Some(cells) = cells {
                    let mut values = vec![SqlValue::Text(source_id.clone())];
                    values.extend(cells);
                    if spec.fts.is_some() {
                        self.stored(self.conn.execute(
                            &format!("INSERT INTO {identity}(source_id) VALUES (?1)"),
                            [source_id],
                        ))?;
                        self.stored(self.conn.execute(&format!("INSERT INTO {content}(rowid,{fields}) VALUES(last_insert_rowid(),?,{binds})"), rusqlite::params_from_iter(values)))?;
                        self.stored(self.conn.execute(&format!("INSERT INTO {relation}(rowid,{fields}) SELECT rowid,{fields} FROM {content} WHERE rowid=last_insert_rowid()"), []))?;
                    } else {
                        self.stored(self.conn.execute(
                            &format!("INSERT INTO {relation}({fields}) VALUES(?,{binds})"),
                            rusqlite::params_from_iter(values),
                        ))?;
                    }
                    self.stored(self.conn.execute(
                        &format!("DELETE FROM {PENDING} WHERE name=?1 AND source_id=?2"),
                        rusqlite::params![name, source_id],
                    ))?;
                } else {
                    self.stored(self.conn.execute(
                        &format!("UPDATE {PENDING} SET token=NULL WHERE name=?1 AND source_id=?2"),
                        rusqlite::params![name, source_id],
                    ))?;
                }
                written.push(source_id);
            }
            let mut batch = ChangeAccumulator::default();
            if !written.is_empty() {
                batch.table(name);
            }
            self.finish_observation("syncular_projection_write", batch)?;
            Ok(json!({"written": written,"stale": stale}))
        })();
        if result.is_err() {
            self.rollback_observation("syncular_projection_write");
        }
        result
    }

    pub fn invalidate_projection(
        &mut self,
        name: &str,
        source_ids: Option<&[String]>,
    ) -> Result<(), ClientError> {
        self.require_projection(name)?;
        self.begin_observation("syncular_projection_invalidate")?;
        let result = (|| {
            self.clear_projection(name, source_ids)?;
            let mut batch = ChangeAccumulator::default();
            batch.table(name);
            self.finish_observation("syncular_projection_invalidate", batch)?;
            Ok(())
        })();
        if result.is_err() {
            self.rollback_observation("syncular_projection_invalidate");
        }
        result
    }
    pub(super) fn clear_projection(
        &self,
        name: &str,
        source_ids: Option<&[String]>,
    ) -> Result<usize, String> {
        let (spec, source) = self
            .lookup_projection(name)
            .map_err(|error| error.to_string())?;
        let sql = ProjectionSql::new(spec, source);
        let condition =
            source_ids.map(|_| format!("{} IN (SELECT value FROM json_each(?1))", sql.source_id));
        let filter = condition.as_deref().unwrap_or("1");
        let encoded_ids = source_ids.map(|ids| json!(ids).to_string());
        let [mark, bump] = sql.pending(filter);
        let binds = encoded_ids.as_slice();
        let purged = if source_ids.is_none() {
            if sql.fts {
                self.stored(self.conn.execute(
                    &format!(
                        "INSERT INTO {fts}({fts}) VALUES ('delete-all')",
                        fts = sql.relation
                    ),
                    [],
                ))?;
                self.stored(
                    self.conn
                        .execute(&format!("DELETE FROM {}", sql.content), []),
                )?;
            }
            self.stored(
                self.conn
                    .execute(&format!("DELETE FROM {}", sql.identity), []),
            )?
        } else {
            let mut removed = 0;
            for statement in sql.clear(&sql.ids(filter)) {
                removed = self.stored(
                    self.conn
                        .execute(&statement, rusqlite::params_from_iter(binds)),
                )?;
            }
            removed
        };
        self.stored(self.conn.execute(&mark, rusqlite::params_from_iter(binds)))?;
        self.stored(self.conn.execute(&bump, []))?;
        self.stored(self.conn.execute(
            &format!("UPDATE {REGISTRY} SET epoch=epoch+1 WHERE name=?1"),
            [name],
        ))?;
        Ok(purged)
    }
}

#[cfg(test)]
#[test]
fn dependency_statement_clears_three_hundred_fts_rows_in_its_transaction() {
    let schema = json!({"version": 1, "tables": [
        {"name": "sources", "primaryKey": "id", "scopes": [{"pattern": "space:{space_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false},
            {"name": "space_id", "type": "string", "nullable": false}
        ], "indexes": [{"name": "sources_by_space", "columns": ["space_id"], "unique": false}],
        "localProjections": [{"name": "local_names", "generation": "1", "columns": [{"name": "display_name", "declaredType": "string"}],
        "fts": {"tokenize": "unicode61", "columns": ["display_name"]}, "dependencies": [{"table": "grants", "column": "space_id", "sourceColumn": "space_id"}]}]},
        {"name": "grants", "primaryKey": "id", "scopes": [{"pattern": "space:{space_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false},
            {"name": "space_id", "type": "string", "nullable": false}
        ]}
    ]});
    let mut client =
        SyncClient::new("projection-timing".into(), &schema, ClientLimits::default()).unwrap();
    client.conn.execute_batch(
        "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<300) INSERT INTO sources SELECT CAST(n AS TEXT),'p1',1 FROM seq"
    ).unwrap();
    let batch = client.projection_pending("local_names", 300).unwrap();
    let entries = batch["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 300);
    let rows = entries
        .iter()
        .map(|entry| ProjectionInput {
            source_id: entry["sourceId"].as_str().unwrap().to_owned(),
            token: entry["token"].as_i64().unwrap(),
            values: Some(Map::from_iter([(
                "display_name".into(),
                json!("derived name"),
            )])),
        })
        .collect::<Vec<_>>();
    client
        .write_projection("local_names", batch["epoch"].as_i64().unwrap(), &rows)
        .unwrap();
    client
        .conn
        .execute("INSERT INTO grants VALUES ('grant','p2',1)", [])
        .unwrap();
    client.conn.execute_batch("BEGIN").unwrap();
    let start = std::time::Instant::now();
    client
        .conn
        .execute("UPDATE grants SET space_id='p1' WHERE id='grant'", [])
        .unwrap();
    let elapsed = start.elapsed();
    assert!(client
        .query(
            "SELECT display_name FROM local_names WHERE local_names MATCH 'derived'",
            &[]
        )
        .unwrap()
        .is_empty());
    let content: i64 = client
        .conn
        .query_row(
            "SELECT count(*) FROM _syncular_projection_local_names",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(content, 0);
    client.conn.execute_batch("COMMIT").unwrap();
    if std::env::var("SYNCULAR_PROJECTION_TIMING").as_deref() == Ok("1") {
        eprintln!(
            "Rust SQLite dependency statement with 300 filled FTS rows: {:.2} ms",
            elapsed.as_secs_f64() * 1_000.0
        );
    }
    assert!(client
        .query(
            "SELECT display_name FROM local_names WHERE local_names MATCH 'derived'",
            &[]
        )
        .unwrap()
        .is_empty());
    assert_eq!(
        client.projection_pending("local_names", 300).unwrap()["entries"]
            .as_array()
            .unwrap()
            .len(),
        300
    );
}
