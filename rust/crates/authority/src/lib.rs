//! SPEC.md §12 local authority: one partition of server semantics in the
//! client's process, over its own SQLite file, reached through the client's
//! transport seam. The TypeScript reference is `openLocalAuthority` in
//! `packages/server/src/local-authority.ts`; this crate implements the same
//! §12.2 profile and §12.3 attach for the native cores.

mod attach;
mod crdt;
mod push;
mod schema;
mod store;
mod sync;
#[cfg(test)]
mod tests;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use ssp2::model::{Op, Operation};

use crate::schema::Schema;
use crate::store::STATE_TABLE;

/// §12.3 state, persisted in the authority database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityState {
    Local,
    Attaching,
    Attached,
}

/// A failure with a stable code (§10): `sync.authority_unavailable` for a
/// refused request, `sync.attach_rejected` for a stopped attach, a remote
/// transport's own code, or a storage failure. Dynamic values live in
/// `details`, never in `message`.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorityError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl AuthorityError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        AuthorityError {
            code: code.to_owned(),
            message: message.to_owned(),
            details: None,
        }
    }

    pub(crate) fn with_details(code: &str, message: &str, details: Value) -> Self {
        AuthorityError {
            details: Some(details),
            ..AuthorityError::new(code, message)
        }
    }
}

pub(crate) fn storage_error(error: rusqlite::Error) -> AuthorityError {
    AuthorityError::with_details(
        "sync.internal_error",
        "the local authority storage failed",
        json!({ "cause": error.to_string() }),
    )
}

/// `.db()?`: a SQLite failure as `sync.internal_error`.
pub(crate) trait Db<T> {
    fn db(self) -> Result<T, AuthorityError>;
}

impl<T> Db<T> for rusqlite::Result<T> {
    fn db(self) -> Result<T, AuthorityError> {
        self.map_err(storage_error)
    }
}

fn unavailable(state: AuthorityState) -> AuthorityError {
    AuthorityError::with_details(
        "sync.authority_unavailable",
        "the local authority serves no requests",
        json!({ "state": match state {
            AuthorityState::Local => "local",
            AuthorityState::Attaching => "attaching",
            AuthorityState::Attached => "attached",
        } }),
    )
}

/// One authenticated request/response round trip to the remote server
/// (`POST <mount>/sync`), used by attach and abandon.
pub type RemoteTransport<'a> = dyn FnMut(&[u8]) -> Result<Vec<u8>, AuthorityError> + 'a;

/// SPEC.md §12 local authority.
pub struct LocalAuthority {
    conn: Connection,
    schema: Schema,
    state: AuthorityState,
}

impl LocalAuthority {
    /// Open (creating on demand) the authority database at `path`
    /// (`":memory:"` for tests) and migrate it to `schema_json`, the same
    /// schema JSON `SyncClient` takes (§12.2). Prunes under the §4.6 floors.
    pub fn open(path: &str, schema_json: &Value) -> Result<Self, AuthorityError> {
        let schema = schema::parse_schema(schema_json)?;
        let conn = Connection::open(path).db()?;
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {STATE_TABLE}(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        ))
        .db()?;
        let mut authority = LocalAuthority {
            conn,
            schema,
            state: AuthorityState::Local,
        };
        authority.state = match authority.read_meta("state")?.as_deref() {
            None | Some("local") => AuthorityState::Local,
            Some("attaching") => AuthorityState::Attaching,
            Some("attached") => AuthorityState::Attached,
            Some(other) => {
                return Err(AuthorityError::with_details(
                    "sync.internal_error",
                    "the local authority state is unreadable",
                    json!({ "state": other }),
                ))
            }
        };
        // §12.3: an attached authority keeps only its state.
        if authority.state != AuthorityState::Attached {
            store::migrate(&authority.conn, &authority.schema)?;
            store::prune(
                &authority.conn,
                store::now_ms(),
                store::MIN_RETAINED_COMMITS,
            )?;
        }
        Ok(authority)
    }

    pub fn state(&self) -> AuthorityState {
        self.state
    }

    /// One combined push+pull round (§1.5): SSP2 request bytes in, response
    /// bytes out. Bootstrap data rides inline rows segments only (§5.7), so
    /// no segment download endpoint exists. Refuses with
    /// `sync.authority_unavailable` (`details.state`) unless `Local`.
    pub fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, AuthorityError> {
        if self.state != AuthorityState::Local {
            return Err(unavailable(self.state));
        }
        sync::handle(&self.conn, &self.schema, request)
    }

    /// §12.3 attach: upload every live row to `remote`, resumable after a
    /// transport failure; on success the authority is `Attached` and keeps
    /// only its state.
    pub fn attach(&mut self, remote: &mut RemoteTransport<'_>) -> Result<(), AuthorityError> {
        match self.state {
            AuthorityState::Attached => return Ok(()),
            AuthorityState::Local => {
                self.write_meta(&[
                    ("state", Some("attaching".to_owned())),
                    ("attach_id", Some(uuid::Uuid::new_v4().to_string())),
                ])?;
                self.state = AuthorityState::Attaching;
            }
            AuthorityState::Attaching => {}
        }
        let attach_id = self.attach_id()?;
        let commits = attach::plan(&self.conn, &self.schema, &attach_id)?;
        let mut remote = attach::Remote::connect(remote, &attach_id, self.schema.version)?;
        for (index, commit) in commits.iter().enumerate() {
            // §12.3: `sent` before the request, `applied` after its result,
            // so an abandon knows which commits may have reached the remote.
            let sent = (index as i64).max(self.ordinal("sent")?);
            self.write_meta(&[("sent", Some(sent.to_string()))])?;
            if let Some(rejection) = remote.send(commit)? {
                return Err(rejection);
            }
            let applied = (index as i64).max(self.ordinal("applied")?);
            self.write_meta(&[("applied", Some(applied.to_string()))])?;
        }
        self.write_meta(&[
            ("state", Some("attached".to_owned())),
            ("sent", None),
            ("applied", None),
        ])?;
        self.state = AuthorityState::Attached;
        let tables: Vec<String> = self
            .conn
            .prepare(&format!(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '{STATE_TABLE}'"
            ))
            .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
            .db()?;
        for table in tables {
            self.conn
                .execute_batch(&format!("DROP TABLE IF EXISTS {}", store::quote(&table)))
                .db()?;
        }
        self.conn.execute_batch("VACUUM").db()?;
        Ok(())
    }

    /// §12.3 abandon: roll back the commits `remote` applied and return to
    /// `Local`. `remote` is required once an upload request may have reached
    /// the remote server (`sync.invalid_request` otherwise).
    pub fn abandon_attach(
        &mut self,
        remote: Option<&mut RemoteTransport<'_>>,
    ) -> Result<(), AuthorityError> {
        match self.state {
            AuthorityState::Attached => return Err(unavailable(self.state)),
            AuthorityState::Local => return Ok(()),
            AuthorityState::Attaching => {}
        }
        if self.ordinal("sent")? >= 0 {
            let Some(remote) = remote else {
                return Err(AuthorityError::new(
                    "sync.invalid_request",
                    "abandoning an attach that reached the remote server needs its transport",
                ));
            };
            self.rollback(remote)?;
        }
        self.write_meta(&[
            ("state", Some("local".to_owned())),
            ("attach_id", None),
            ("sent", None),
            ("applied", None),
        ])?;
        self.state = AuthorityState::Local;
        Ok(())
    }

    /// Settle the one commit whose outcome may be unknown, then delete the
    /// rows of every applied commit in reverse plan order, children first.
    fn rollback(&mut self, remote: &mut RemoteTransport<'_>) -> Result<(), AuthorityError> {
        let attach_id = self.attach_id()?;
        let commits = attach::plan(&self.conn, &self.schema, &attach_id)?;
        let mut remote = attach::Remote::connect(remote, &attach_id, self.schema.version)?;
        let mut through = self.ordinal("applied")?;
        let sent = self.ordinal("sent")?;
        if sent > through {
            let commit = commits
                .get(sent as usize)
                .ok_or_else(|| store::corrupt("attach sent ordinal"))?;
            if remote.send(commit)?.is_none() {
                through = sent;
            }
            self.write_meta(&[("applied", Some(through.to_string()))])?;
        }
        let deletes: Vec<Operation> = commits
            .iter()
            .take((through + 1) as usize)
            .flat_map(|(_, operations)| operations)
            .rev()
            .map(|operation| Operation {
                table: operation.table.clone(),
                row_id: operation.row_id.clone(),
                op: Op::Delete,
                base_version: None,
                payload: None,
            })
            .collect();
        for (k, chunk) in deletes.chunks(attach::OPERATION_BUDGET).enumerate() {
            let commit = (format!("{attach_id}:undo:{k}"), chunk.to_vec());
            if let Some(rejection) = remote.send(&commit)? {
                return Err(rejection);
            }
        }
        Ok(())
    }

    fn read_meta(&self, key: &str) -> Result<Option<String>, AuthorityError> {
        self.conn
            .query_row(
                &format!("SELECT value FROM {STATE_TABLE} WHERE key=?1"),
                [key],
                |row| row.get(0),
            )
            .optional()
            .db()
    }

    /// `-1` when the key is absent.
    fn ordinal(&self, key: &str) -> Result<i64, AuthorityError> {
        match self.read_meta(key)? {
            None => Ok(-1),
            Some(value) => value.parse().map_err(|_| store::corrupt("attach ordinal")),
        }
    }

    fn attach_id(&self) -> Result<String, AuthorityError> {
        self.read_meta("attach_id")?
            .ok_or_else(|| store::corrupt("attach id"))
    }

    /// One transaction; `None` removes the key.
    fn write_meta(&self, entries: &[(&str, Option<String>)]) -> Result<(), AuthorityError> {
        store::transaction(&self.conn, || {
            for (key, value) in entries {
                match value {
                    Some(value) => self.conn.execute(
                        &format!(
                            "INSERT OR REPLACE INTO {STATE_TABLE}(key, value) VALUES (?1, ?2)"
                        ),
                        params![key, value],
                    ),
                    None => self
                        .conn
                        .execute(&format!("DELETE FROM {STATE_TABLE} WHERE key=?1"), [key]),
                }
                .db()?;
            }
            Ok(())
        })
    }
}
