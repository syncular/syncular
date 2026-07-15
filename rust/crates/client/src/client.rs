//! The Syncular v2 Rust client core (SPEC.md client-behavior contract):
//! rusqlite local storage, §3.2/§3.3 effective-scope persistence + purge,
//! §4 pull/cursor/bootstrap (§4.7 resume, §5.6 segment application), §6
//! push with outbox order, §7 optimistic apply / rollback / replay-on-top,
//! §2.3 clientCommitId idempotency, §8 realtime client rules, §10 errors.
//!
//! Built from `SPEC.md` and the committed `ssp2` codec alone — no
//! reference to the v1 Rust tree or the v2 TypeScript client.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use ssp2::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, Column, ColumnType, ColumnValue, Row, RowsSegment};
use ssp2::{
    decode_message, encode_message, encode_presence_publish, parse_control, ControlMessage,
    PresenceKind,
};

use crate::api::{
    ClientChangeBatch, ClientLimits, CommandEffects, CommitOperation, CommitOperationOutcome,
    CommitOutcome, CommitOutcomeQuery, CommitOutcomeResolution, CommitOutcomeStatus,
    ConflictRecord, CoverageSnapshot, LeaseState, Mutation, PresencePeer, QuerySnapshot,
    RejectionDetails, RejectionRecord, ResolveCommitOutcomeInput, RowState, SchemaFloor,
    SubscriptionStateView, SyncIntent, SyncOutcome, SyncReport, SyncStatusSnapshot, TableChange,
    WindowBase, WindowChange, WindowCoverage, WindowState, WindowUnitRef,
};
use crate::schema::{parse_schema_json, ClientSchema};
use crate::transport::{BlobDownload, BlobUploadGrant, SegmentRequest, Transport, TransportError};
use crate::values::{
    bytes_to_hex, canonical_scope_json, column_value_to_json, decode_row_bytes, encode_row_json,
    json_to_column_value, json_to_scope_map, normalize_values_casing, render_row_id_json,
    scope_map_to_json, sort_scope_map,
};

/// §4.2 default: the rows baseline plus sqlite images (§5.3) — rusqlite
/// can always import an image, so the premier path is advertised unless
/// the host overrides `limits.accept`. Bit 3 (signed URLs, §5.4) is
/// added per transport capability at request-build time.
const DEFAULT_ACCEPT: u8 = 0b0111;
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;
const ACCEPT_EXTERNAL_ROWS: u8 = 1 << 1;
const ACCEPT_SQLITE: u8 = 1 << 2;
const ACCEPT_SIGNED_URLS: u8 = 1 << 3;

/// §7.4.1 persisted local schema-version marker (`_syncular_meta` key).
const LOCAL_SCHEMA_VERSION_KEY: &str = "localSchemaVersion";
const LOCAL_REVISION_KEY: &str = "localRevision";
const CLIENT_ID_KEY: &str = "clientId";
const LEASE_STATE_KEY: &str = "leaseState";
const SCHEMA_FLOOR_KEY: &str = "schemaFloor";
/// §7.4.4 client-local code: a pending outbox commit cannot re-encode under
/// the new schema after a bump. Never a wire code (§10.3).
const OUTBOX_INCOMPATIBLE_CODE: &str = "sync.outbox_incompatible";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Active,
    Revoked,
    Failed,
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use serde_json::json;

    fn client() -> SyncClient {
        SyncClient::new(
            "retry-test".to_owned(),
            &json!({
                "version": 1,
                "tables": [{
                    "name": "tasks",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "project:{project_id}" }]
                }]
            }),
            ClientLimits::default(),
        )
        .expect("test client")
    }

    #[test]
    fn background_retry_deadlines_back_off_and_reset() {
        let mut client = client();
        client.schedule_background_retry();
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ));
        client.schedule_background_retry();
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 500 }]
        ));
        client.reset_background_retry();
        client.schedule_background_retry();
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ));
    }

    #[test]
    fn secondary_unique_collision_preserves_existing_synced_row() {
        let client = SyncClient::new(
            "unique-upsert-test".to_owned(),
            &json!({
                "version": 1,
                "tables": [{
                    "name": "tasks",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false },
                        { "name": "title", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "project:{project_id}" }],
                    "indexes": [{
                        "name": "tasks_by_project_title",
                        "columns": ["project_id", "title"],
                        "unique": true
                    }]
                }]
            }),
            ClientLimits::default(),
        )
        .expect("test client");
        let table = client.schema.table("tasks").expect("tasks table");
        let sql = client.insert_row_sql(&base_table("tasks"), table);

        client
            .conn
            .execute(&sql, rusqlite::params!["t1", "p1", "original", 1])
            .expect("insert first row");
        client
            .conn
            .execute(&sql, rusqlite::params!["t1", "p1", "updated", 2])
            .expect("update same primary key");
        client
            .conn
            .execute(&sql, rusqlite::params!["t2", "p1", "original", 1])
            .expect("insert second row");
        assert!(client
            .conn
            .execute(&sql, rusqlite::params!["t3", "p1", "original", 2])
            .is_err());

        let rows = client
            .conn
            .prepare("SELECT id, title FROM _syncular_base_tasks ORDER BY id")
            .expect("prepare rows")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect rows");
        assert_eq!(
            rows,
            vec![
                ("t1".to_owned(), "updated".to_owned()),
                ("t2".to_owned(), "original".to_owned())
            ]
        );
    }

    #[test]
    fn reopening_active_subscriptions_emits_a_catch_up_intent() {
        let path = std::env::temp_dir().join(format!(
            "syncular-startup-intent-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        });

        {
            let mut first = SyncClient::open_path_with_identity(
                None,
                &schema,
                ClientLimits::default(),
                path.to_str().expect("UTF-8 temp path"),
            )
            .expect("first open");
            first
                .set_window(
                    &WindowBase {
                        table: "tasks".to_owned(),
                        variable: "project_id".to_owned(),
                        fixed_scopes: Vec::new(),
                        params: None,
                    },
                    &["persisted".to_owned()],
                )
                .expect("persist window");
        }

        let mut reopened = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("reopen");
        assert!(reopened.sync_needed());
        assert!(matches!(
            reopened.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn migrates_pre_envelope_outcome_journal_additively() {
        let path = std::env::temp_dir().join(format!(
            "syncular-outcome-migration-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).expect("open legacy database");
        conn.execute_batch(
            "CREATE TABLE _syncular_commit_outcomes (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               client_commit_id TEXT NOT NULL UNIQUE,
               status TEXT NOT NULL,
               recorded_at_ms INTEGER NOT NULL,
               results_json TEXT NOT NULL,
               resolution TEXT NOT NULL DEFAULT 'active',
               resolved_at_ms INTEGER,
               replacement_client_commit_id TEXT);",
        )
        .expect("create legacy outcome journal");
        drop(conn);
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        });
        let client = SyncClient::open_path(
            "migration-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("migrate database");
        let has_operations = client
            .conn
            .prepare("PRAGMA table_info(_syncular_commit_outcomes)")
            .expect("prepare table info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .filter_map(Result::ok)
            .any(|column| column == "operations_json");
        assert!(has_operations);
        drop(client);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn durable_conflict_outcome_and_resolution_survive_reopen() {
        let path = std::env::temp_dir().join(format!(
            "syncular-durable-outcome-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        });
        let conflict = ConflictRecord {
            client_commit_id: "losing-commit".to_owned(),
            op_index: 0,
            table: "tasks".to_owned(),
            row_id: "t1".to_owned(),
            code: "sync.version_conflict".to_owned(),
            message: "stale base version".to_owned(),
            server_version: 2,
            server_row: Map::from_iter([("id".to_owned(), json!("t1"))]),
            operation: Some(CommitOperation {
                table: "tasks".to_owned(),
                row_id: "t1".to_owned(),
                op: "upsert".to_owned(),
                base_version: Some(1),
                values: None,
                changed_fields: None,
            }),
        };
        let failed_operations = vec![
            OutboxOp {
                upsert: true,
                table: "tasks".to_owned(),
                row_id: "t1".to_owned(),
                base_version: Some(1),
                values: None,
                changed_fields: None,
            },
            OutboxOp {
                upsert: true,
                table: "tasks".to_owned(),
                row_id: "status-event-1".to_owned(),
                base_version: Some(0),
                values: None,
                changed_fields: None,
            },
        ];

        {
            let mut first = SyncClient::open_path(
                "durable-native".to_owned(),
                &schema,
                ClientLimits::default(),
                path.to_str().expect("UTF-8 temp path"),
            )
            .expect("first open");
            first
                .begin_observation("test_outcome")
                .expect("begin outcome");
            first
                .persist_commit_outcome(
                    "losing-commit",
                    CommitOutcomeStatus::Conflict,
                    &[CommitOperationOutcome::Conflict {
                        conflict: conflict.clone(),
                    }],
                    Some(&failed_operations),
                )
                .expect("persist outcome");
            first.conflicts.push(conflict);
            first
                .finish_observation(
                    "test_outcome",
                    ChangeAccumulator {
                        conflicts: true,
                        outcomes: true,
                        ..ChangeAccumulator::default()
                    },
                )
                .expect("commit outcome");
        }

        {
            let mut reopened = SyncClient::open_path(
                "durable-native".to_owned(),
                &schema,
                ClientLimits::default(),
                path.to_str().expect("UTF-8 temp path"),
            )
            .expect("reopen");
            assert_eq!(reopened.conflicts().len(), 1);
            let outcome = reopened
                .commit_outcome("losing-commit")
                .expect("read outcome")
                .expect("outcome");
            assert_eq!(outcome.status, CommitOutcomeStatus::Conflict);
            let operations = outcome.operations.expect("aggregate envelope");
            assert_eq!(operations.len(), 2);
            assert_eq!(operations[1].row_id, "status-event-1");
            let resolved = reopened
                .resolve_commit_outcome(ResolveCommitOutcomeInput {
                    client_commit_id: "losing-commit".to_owned(),
                    resolution: CommitOutcomeResolution::ResolvedKeepServer,
                    replacement_client_commit_id: None,
                })
                .expect("resolve");
            assert_eq!(
                resolved.resolution,
                CommitOutcomeResolution::ResolvedKeepServer
            );
            assert!(reopened.conflicts().is_empty());
        }

        let reopened = SyncClient::open_path(
            "durable-native".to_owned(),
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("second reopen");
        assert!(reopened.conflicts().is_empty());
        assert_eq!(
            reopened
                .commit_outcome("losing-commit")
                .expect("read outcome")
                .expect("outcome")
                .resolution,
            CommitOutcomeResolution::ResolvedKeepServer
        );
        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn file_snapshot_reader_matches_owner_rows_revision_and_coverage() {
        let path =
            std::env::temp_dir().join(format!("syncular-read-sidecar-{}.db", uuid::Uuid::new_v4()));
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }]
            }]
        });
        let mut client = SyncClient::open_path_with_identity(
            Some("sidecar-client".to_owned()),
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("open owner");
        let base = WindowBase {
            table: "tasks".to_owned(),
            variable: "project_id".to_owned(),
            fixed_scopes: Vec::new(),
            params: None,
        };
        client
            .set_window(&base, &["one".to_owned()])
            .expect("set window");
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("t1")),
                    ("project_id".to_owned(), Value::from("one")),
                ]),
                base_version: None,
            }])
            .expect("local mutate");

        let coverage = [WindowCoverage {
            base,
            units: vec!["one".to_owned(), "missing".to_owned()],
        }];
        let owner = client
            .query_snapshot(
                "SELECT id, project_id FROM tasks ORDER BY id",
                &[],
                &coverage,
            )
            .expect("owner snapshot");
        let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
        let sidecar = reader
            .query_snapshot(
                "SELECT id, project_id FROM tasks ORDER BY id",
                &[],
                &coverage,
            )
            .expect("sidecar snapshot");

        assert_eq!(sidecar.revision, owner.revision);
        assert_eq!(sidecar.rows, owner.rows);
        assert_eq!(
            serde_json::to_value(&sidecar.coverage).expect("serialize sidecar coverage"),
            serde_json::to_value(&owner.coverage).expect("serialize owner coverage")
        );
        assert_eq!(sidecar.revision, "2");
        assert_eq!(sidecar.rows[0]["id"], "t1");
        assert!(!sidecar.coverage.complete);
        assert_eq!(sidecar.coverage.pending.len(), 1);
        assert_eq!(sidecar.coverage.missing.len(), 1);

        drop(reader);
        drop(client);
        std::fs::remove_file(path).expect("remove temp database");
    }
}

impl SubState {
    fn name(self) -> &'static str {
        match self {
            SubState::Active => "active",
            SubState::Revoked => "revoked",
            SubState::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "revoked" => Self::Revoked,
            "failed" => Self::Failed,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone)]
struct Subscription {
    id: String,
    table: String,
    requested: Vec<(String, Vec<String>)>,
    params: Option<String>,
    cursor: i64,
    /// §4.7 resume token, round-tripped opaquely.
    bootstrap_state: Option<String>,
    state: SubState,
    reason_code: Option<String>,
    /// Last effective scopes echoed while active (§3.3: persisted for the
    /// purge contract; each active echo replaces it).
    effective: Option<Vec<(String, Vec<String>)>>,
    synced_once: bool,
}

#[derive(Debug, Clone)]
struct OutboxOp {
    upsert: bool,
    table: String,
    row_id: String,
    base_version: Option<i64>,
    /// Schema-agnostic local form (§0): driver JSON values, encoded with
    /// the current codec at send time.
    values: Option<Map<String, Value>>,
    /// Local-only patch intent; never encoded into SSP2 PUSH_COMMIT.
    changed_fields: Option<Vec<String>>,
}

impl From<&OutboxOp> for CommitOperation {
    fn from(operation: &OutboxOp) -> Self {
        Self {
            table: operation.table.clone(),
            row_id: operation.row_id.clone(),
            op: if operation.upsert { "upsert" } else { "delete" }.to_owned(),
            base_version: operation.base_version,
            values: operation.values.clone(),
            changed_fields: operation.changed_fields.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct OutboxCommit {
    client_commit_id: String,
    ops: Vec<OutboxOp>,
}

struct StoredCommitOutcomeRow {
    sequence: i64,
    client_commit_id: String,
    status: String,
    recorded_at_ms: i64,
    results_json: String,
    operations_json: Option<String>,
    resolution: String,
    resolved_at_ms: Option<i64>,
    replacement_client_commit_id: Option<String>,
}

/// Section outcome distinguishing the §5.6 subscription-local fail-closed
/// path from a round-aborting failure (§1.4 rule 5).
enum SectionError {
    FailClosed,
    Abort(String, String),
}

struct RequestMeta {
    pushed_ids: Vec<String>,
    /// Subscription id → the request carried `cursor < 0` and no resume
    /// token (§5.6 first-page detection: a *fresh* bootstrap).
    fresh: Vec<(String, bool)>,
    accept: u8,
    /// §6.1 splitBatch: outbox commits held back from THIS request because
    /// the running operation count reached the push cap — the next round
    /// pushes them (`sync_needed` stays set while any remain).
    deferred_commits: usize,
}

#[derive(Default)]
struct ChangeAccumulator {
    /// None means table-wide; Some is the exact scoped domain.
    tables: BTreeMap<String, Option<BTreeSet<String>>>,
    windows: BTreeMap<(String, String), BTreeSet<String>>,
    status: bool,
    conflicts: bool,
    rejections: bool,
    outcomes: bool,
}

impl ChangeAccumulator {
    fn table(&mut self, table: &str) {
        self.tables.insert(table.to_owned(), None);
    }

    fn scope(&mut self, table: &str, key: String) {
        match self.tables.get_mut(table) {
            Some(None) => {}
            Some(Some(keys)) => {
                keys.insert(key);
            }
            None => {
                self.tables
                    .insert(table.to_owned(), Some(BTreeSet::from([key])));
            }
        }
    }

    fn window(&mut self, base_key: &str, table: &str, unit: &str) {
        self.windows
            .entry((base_key.to_owned(), table.to_owned()))
            .or_default()
            .insert(unit.to_owned());
    }

    fn touched(&self) -> bool {
        !self.tables.is_empty()
            || !self.windows.is_empty()
            || self.status
            || self.conflicts
            || self.rejections
            || self.outcomes
    }
}

/// §6.1: the server caps total operations per request (reference default
/// 500) and rejects the whole batch with `sync.too_many_operations`; the
/// client "splits and retries". Splitting happens at build time: commits are
/// included IN ORDER until the operation budget is spent, the rest wait for
/// the next round.
const PUSH_OPS_PER_REQUEST: usize = 500;

pub struct SyncClient {
    conn: Connection,
    schema: ClientSchema,
    client_id: String,
    limits: ClientLimits,
    subs: Vec<Subscription>,
    outbox: Vec<OutboxCommit>,
    conflicts: Vec<ConflictRecord>,
    rejections: Vec<RejectionRecord>,
    schema_floor: Option<SchemaFloor>,
    /// §7.3.5: the opaque auth-lease state (from LEASE frames + lease errors).
    lease_state: Option<LeaseState>,
    /// §1.6: the schema-floor response stops syncing until an upgrade.
    stopped: bool,
    /// §7.4.5: true while a schema-bump reset + first re-bootstrap is in flight.
    upgrading: bool,
    /// §8.4 coalesced sync-needed signal.
    sync_needed: bool,
    realtime_connected: bool,
    /// §8.6 presence: scopeKey → (`actorId clientId` peer key → peer).
    presence: HashMap<String, HashMap<String, PresencePeer>>,
    /// Client clock (epoch ms) for the §5.4 `urlExpiresAtMs` check; the
    /// host may pin it (conformance runs on a virtual clock).
    now_ms: Option<i64>,
    /// §5.11 client-side encryption keys (`keyId → key bytes`). Empty ⇒ E2EE
    /// off. The encrypt/decrypt seam (`values.rs`) is compiled only under the
    /// `e2ee` feature; without it, a schema with encrypted columns fails loud.
    encryption: crate::values::EncryptionConfig,
    /// Per-table primary-key upsert SQL, built once per (full table name) —
    /// the row write path runs per row during bootstrap (§5.6), so the SQL
    /// string (and, via `prepare_cached`, its compiled statement) is reused
    /// instead of being rebuilt and re-prepared per row. Cleared on a §7.4.3
    /// schema reset (the column lists may have changed).
    insert_sql: RefCell<HashMap<String, String>>,
    /// §7.1 rebuild gate: true whenever the base tables or the outbox have
    /// diverged from the visible overlay since the last rebuild. Lets a
    /// no-op sync round skip the full base→visible copy.
    overlay_dirty: Cell<bool>,
    /// Exact observer-transaction output drained by command/FFI hosts.
    change_queue: VecDeque<ClientChangeBatch>,
    sync_intent_queue: VecDeque<SyncIntent>,
    /// Explicit exponential retry policy for transient transport failures.
    retry_delay_ms: u64,
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn base_table(name: &str) -> String {
    quote_ident(&format!("_syncular_base_{name}"))
}

/// §4.8: a stable, server-opaque key for a window base — table + variable +
/// canonical fixed scopes. Two `set_window` calls with the same base
/// address the same registry rows.
/// §4.8 deferred eviction record: (sub id, table, effective scope map).
type PendingEvict = (String, String, Vec<(String, Vec<String>)>);

fn window_base_key(base: &WindowBase) -> String {
    format!(
        "{}\0{}\0{}",
        base.table,
        base.variable,
        canonical_scope_json(&base.fixed_scopes)
    )
}

/// §4.8: the full requested scope map for one unit (fixed scopes + unit).
fn unit_scopes(base: &WindowBase, unit: &str) -> Vec<(String, Vec<String>)> {
    let mut scopes = base.fixed_scopes.clone();
    scopes.retain(|(k, _)| k != &base.variable);
    scopes.push((base.variable.clone(), vec![unit.to_owned()]));
    scopes
}

/// §4.1 guidance: `w:<table>:<sha256(canonical scope map)[0..16]>`. Ids are
/// echoed not interpreted by the server, so the exact hash is client
/// convention; SHA-256 matches the SPEC's worked example.
fn derive_sub_id(base: &WindowBase, unit: &str) -> String {
    let canonical = canonical_scope_json(&unit_scopes(base, unit));
    let digest = Sha256::digest(canonical.as_bytes());
    let hex = bytes_to_hex(&digest);
    format!("w:{}:{}", base.table, &hex[..16])
}

fn visible_table(name: &str) -> String {
    quote_ident(name)
}

/// §7.4.3: is a `sqlite_master` table name a synced table (visible or base),
/// i.e. NOT one of the durable bookkeeping tables the reset preserves?
fn is_synced_table_name(name: &str) -> bool {
    if name.starts_with("sqlite_") {
        return false;
    }
    if name.starts_with("_syncular_base_") {
        return true; // the base half of a synced table pair
    }
    // Bookkeeping: outbox, subscriptions, meta, blob cache/uploads.
    !name.starts_with("_syncular_")
}

/// `"sha256:" + hex` of the bytes — the content address (§5.9.1).
fn blob_id_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", bytes_to_hex(&digest))
}

/// One [`SyncClient::write_row`] bind parameter, borrowing the row-codec
/// value it wraps — strings/JSON/bytes bind as borrowed TEXT/BLOB (no copy
/// per row on the §5.6 bootstrap path), scalars bind owned.
enum RowParam<'a> {
    Cell(&'a Option<ColumnValue>),
    Version(i64),
}

impl rusqlite::ToSql for RowParam<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            RowParam::Version(v) => ToSqlOutput::Owned(SqlValue::Integer(*v)),
            RowParam::Cell(cell) => match cell {
                None => ToSqlOutput::Owned(SqlValue::Null),
                Some(ColumnValue::String(s)) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
                Some(ColumnValue::Integer(i)) => ToSqlOutput::Owned(SqlValue::Integer(*i)),
                Some(ColumnValue::Float(f)) => ToSqlOutput::Owned(SqlValue::Real(*f)),
                Some(ColumnValue::Boolean(b)) => {
                    ToSqlOutput::Owned(SqlValue::Integer(i64::from(*b)))
                }
                Some(ColumnValue::Json(raw)) | Some(ColumnValue::BlobRef(raw)) => {
                    ToSqlOutput::Borrowed(ValueRef::Text(raw.0.as_bytes()))
                }
                // §5.10: crdt bytes store as BLOB, like bytes.
                Some(ColumnValue::Bytes(b)) | Some(ColumnValue::Crdt(b)) => {
                    ToSqlOutput::Borrowed(ValueRef::Blob(b))
                }
            },
        })
    }
}

/// §5.3 image cell → bind parameter, strict per the declared column type
/// (`boolean` from INTEGER 0/1, `json` from its raw TEXT, NULL only when
/// nullable). Mismatches are image-producer violations. Returns the cell
/// borrowed when the stored representation already matches what the row
/// codec would write, or the normalized scalar (boolean → 0/1, float from
/// INTEGER → REAL) otherwise — the local write is byte-identical to the
/// old convert-then-insert path without allocating per cell.
fn image_cell_param<'a>(column: &Column, value: ValueRef<'a>) -> Result<ToSqlOutput<'a>, String> {
    use ssp2::segment::ColumnType;
    let mismatch = || {
        Err(format!(
            "image column {:?} holds a value of the wrong type",
            column.name
        ))
    };
    match value {
        ValueRef::Null => {
            if !column.nullable {
                return Err(format!(
                    "image column {:?} is NULL but not nullable",
                    column.name
                ));
            }
            Ok(ToSqlOutput::Owned(SqlValue::Null))
        }
        ValueRef::Integer(i) => match column.ty {
            ColumnType::Integer => Ok(ToSqlOutput::Borrowed(value)),
            ColumnType::Boolean => Ok(ToSqlOutput::Owned(SqlValue::Integer(i64::from(i != 0)))),
            ColumnType::Float => Ok(ToSqlOutput::Owned(SqlValue::Real(i as f64))),
            _ => mismatch(),
        },
        ValueRef::Real(_) => match column.ty {
            ColumnType::Float => Ok(ToSqlOutput::Borrowed(value)),
            _ => mismatch(),
        },
        ValueRef::Text(t) => {
            std::str::from_utf8(t)
                .map_err(|_| format!("image column {:?} is not UTF-8", column.name))?;
            match column.ty {
                ColumnType::String | ColumnType::Json | ColumnType::BlobRef => {
                    Ok(ToSqlOutput::Borrowed(value))
                }
                _ => mismatch(),
            }
        }
        ValueRef::Blob(_) => match column.ty {
            // §5.10: a crdt column stores its opaque bytes as BLOB, like bytes.
            ColumnType::Bytes | ColumnType::Crdt => Ok(ToSqlOutput::Borrowed(value)),
            _ => mismatch(),
        },
    }
}

fn sql_ref_to_json(column: &Column, value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => match column.ty {
            ssp2::segment::ColumnType::Boolean => Value::Bool(i != 0),
            ssp2::segment::ColumnType::Float => {
                serde_json::Number::from_f64(i as f64).map_or(Value::Null, Value::Number)
            }
            _ => Value::from(i),
        },
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(b)));
            Value::Object(map)
        }
    }
}

/// Bind a driver JSON value form as a rusqlite parameter for [`SyncClient::query`].
/// Objects are accepted in lossless `{"$bytes": hex}` and
/// `{"$bigint": decimal}` envelope forms.
fn json_param_to_sql(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("query param number {n} is out of range"));
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(_) => {
            if let Some(hex) = value.get("$bytes").and_then(Value::as_str) {
                SqlValue::Blob(crate::values::hex_to_bytes(hex)?)
            } else if let Some(decimal) = value.get("$bigint").and_then(Value::as_str) {
                SqlValue::Integer(decimal.parse::<i64>().map_err(|_| {
                    format!("query bigint param {decimal:?} is outside SQLite's i64 range")
                })?)
            } else {
                return Err(
                    "query object param must be a {$bytes: hex} or {$bigint: decimal} value"
                        .to_owned(),
                );
            }
        }
        Value::Array(_) => return Err("query array params are not supported".to_owned()),
    })
}

/// Map a rusqlite value with no schema column to consult (arbitrary query
/// output): integers/reals/text pass through by stored affinity, blobs ride
/// as `{"$bytes": hex}`. Distinct from [`sql_ref_to_json`], which uses the
/// schema column type to recover booleans/floats/json.
fn sql_ref_to_json_dynamic(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => {
            // JSON/Tauri IPC cannot represent every SQLite i64 exactly. Keep
            // ordinary UI-sized integers ergonomic and envelope only values
            // beyond JavaScript's safe range.
            const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
            if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                Value::from(i)
            } else {
                let mut map = Map::new();
                map.insert("$bigint".to_owned(), Value::from(i.to_string()));
                Value::Object(map)
            }
        }
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(b)));
            Value::Object(map)
        }
    }
}

fn query_connection(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Map<String, Value>>, String> {
    crate::query_guard::assert_read_only_query(sql)?;
    let bound: Vec<SqlValue> = params
        .iter()
        .map(json_param_to_sql)
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let column_names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let bound_refs: Vec<&dyn rusqlite::ToSql> =
        bound.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let mut sql_rows = stmt
        .query(bound_refs.as_slice())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = sql_rows.next().map_err(|e| e.to_string())? {
        let mut record = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let value = row.get_ref(i).map_err(|e| e.to_string())?;
            record.insert(name.clone(), sql_ref_to_json_dynamic(value));
        }
        out.push(record);
    }
    Ok(out)
}

fn persisted_window_state(conn: &Connection, base: &WindowBase) -> Result<WindowState, String> {
    let mut stmt = conn
        .prepare(
            "SELECT windows.unit, subscriptions.state_json
               FROM _syncular_windows AS windows
               JOIN _syncular_subscriptions AS subscriptions
                 ON subscriptions.id = windows.sub_id
              WHERE windows.base = ?1
              ORDER BY windows.unit ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![window_base_key(base)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut units = Vec::new();
    let mut pending = Vec::new();
    for row in rows {
        let (unit, raw) = row.map_err(|error| error.to_string())?;
        let state: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("invalid persisted window subscription: {error}"))?;
        let is_pending = state.get("status").and_then(Value::as_str) != Some("active")
            || state.get("cursor").and_then(Value::as_i64).unwrap_or(-1) < 0
            || state
                .get("bootstrapState")
                .is_some_and(|value| !value.is_null());
        if is_pending {
            pending.push(unit.clone());
        }
        units.push(unit);
    }
    Ok(WindowState { units, pending })
}

fn snapshot_connection(
    conn: &Connection,
    sql: &str,
    params: &[Value],
    coverage: &[WindowCoverage],
) -> Result<QuerySnapshot, String> {
    conn.execute_batch("SAVEPOINT syncular_snapshot_read")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let revision = conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![LOCAL_REVISION_KEY],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let rows = query_connection(conn, sql, params)?;
        let mut pending = Vec::new();
        let mut missing = Vec::new();
        for requested in coverage {
            let base_key = window_base_key(&requested.base);
            let state = persisted_window_state(conn, &requested.base)?;
            for unit in BTreeSet::from_iter(requested.units.iter().cloned()) {
                let reference = WindowUnitRef {
                    base_key: base_key.clone(),
                    unit: unit.clone(),
                };
                if !state.units.iter().any(|held| held == &unit) {
                    missing.push(reference);
                } else if state.pending.iter().any(|held| held == &unit) {
                    pending.push(reference);
                }
            }
        }
        Ok(QuerySnapshot {
            revision: revision.to_string(),
            rows,
            coverage: CoverageSnapshot {
                complete: pending.is_empty() && missing.is_empty(),
                pending,
                missing,
            },
        })
    })();
    match result {
        Ok(snapshot) => {
            conn.execute_batch("RELEASE syncular_snapshot_read")
                .map_err(|error| error.to_string())?;
            Ok(snapshot)
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO syncular_snapshot_read; RELEASE syncular_snapshot_read",
            );
            Err(error)
        }
    }
}

/// A long-lived read-only SQLite sidecar for latency-critical native views.
/// Network rounds stay serialized on the mutable core owner, while atomic
/// query snapshots use this independent connection and therefore never queue
/// behind HTTP/WebSocket latency.
pub struct FileQuerySnapshotReader {
    path: String,
    conn: Option<Connection>,
}

impl FileQuerySnapshotReader {
    #[must_use]
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            conn: None,
        }
    }

    fn connection(&mut self) -> Result<&Connection, String> {
        if self.conn.is_none() {
            let conn = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| format!("open read sidecar {:?}: {error}", self.path))?;
            conn.busy_timeout(std::time::Duration::from_millis(250))
                .map_err(|error| error.to_string())?;
            self.conn = Some(conn);
        }
        self.conn
            .as_ref()
            .ok_or_else(|| "read sidecar connection missing".to_owned())
    }

    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[Value],
        coverage: &[WindowCoverage],
    ) -> Result<QuerySnapshot, String> {
        snapshot_connection(self.connection()?, sql, params, coverage)
    }
}

impl SyncClient {
    pub fn new_with_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
    ) -> Result<Self, String> {
        let resolved = client_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::with_connection(resolved, schema_json, limits, conn)
    }

    pub fn new(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
    ) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    /// Build a client backed by an on-disk SQLite database at `path` — the
    /// seam a native host (Tauri plugin, FFI file-DB variant) uses to persist
    /// across process restarts. `create_tables` runs `IF NOT EXISTS`, so
    /// re-opening the same file reuses the persisted rows. Keeps rusqlite out
    /// of the command router's dependency set (the router only holds a path).
    pub fn open_path(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
    ) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    pub fn open_path_with_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
    ) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        // File-backed native clients use an independent read connection for
        // latency-critical snapshots. WAL is SQLite's intended reader/writer
        // concurrency mode: a view read never holds a rollback-journal lock
        // that delays the mutable client's next commit, and a short busy
        // timeout absorbs the tiny checkpoint/schema-lock windows.
        conn.busy_timeout(std::time::Duration::from_millis(250))
            .map_err(|error| format!("configure db {path:?} busy timeout: {error}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("configure db {path:?} WAL mode: {error}"))?;
        let persisted = conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = 'clientId'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();
        let resolved = persisted
            .clone()
            .or(client_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if let (Some(existing), Some(requested)) = (persisted, client_id) {
            if existing != requested {
                return Err(format!(
                    "client.identity_mismatch: this database belongs to {existing:?}; refusing to rebind it to {requested:?}"
                ));
            }
        }
        Self::with_connection(resolved, schema_json, limits, conn)
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Build a client over a caller-supplied rusqlite connection — the seam a
    /// native host (Tauri plugin, FFI file-DB variant) uses to back the core
    /// with an on-disk database (`Connection::open(path)`) rather than the
    /// default `:memory:`. The connection MUST be fresh (no pre-existing
    /// syncular tables); `create_tables` runs `IF NOT EXISTS`, so re-opening
    /// the same file across process restarts reuses the persisted rows.
    pub fn with_connection(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
        conn: Connection,
    ) -> Result<Self, String> {
        if limits.outcome_retention_max_entries == Some(0) {
            return Err(
                "sync.invalid_request: outcomeRetentionMaxEntries must be positive".to_owned(),
            );
        }
        let schema = parse_schema_json(schema_json)?;
        let mut client = SyncClient {
            conn,
            schema,
            client_id,
            limits,
            subs: Vec::new(),
            outbox: Vec::new(),
            conflicts: Vec::new(),
            rejections: Vec::new(),
            schema_floor: None,
            lease_state: None,
            stopped: false,
            upgrading: false,
            sync_needed: false,
            realtime_connected: false,
            presence: HashMap::new(),
            now_ms: None,
            encryption: crate::values::EncryptionConfig::default(),
            insert_sql: RefCell::new(HashMap::new()),
            overlay_dirty: Cell::new(false),
            change_queue: VecDeque::new(),
            sync_intent_queue: VecDeque::new(),
            retry_delay_ms: 250,
        };
        // The row write path leans on the prepared-statement cache (two
        // insert statements per synced table, plus the bookkeeping
        // statements); size it so a multi-table schema never thrashes.
        client
            .conn
            .set_prepared_statement_cache_capacity(64.max(client.schema.tables.len() * 4));
        client.create_tables()?;
        match client.get_meta(CLIENT_ID_KEY) {
            Some(existing) if existing != client.client_id => {
                return Err(format!(
                    "client.identity_mismatch: this database belongs to {existing:?}; refusing to rebind it to {:?}",
                    client.client_id
                ));
            }
            None => client.set_meta(CLIENT_ID_KEY, &client.client_id),
            _ => {}
        }
        client.restore_persisted_state()?;
        let marker = client
            .get_meta(LOCAL_SCHEMA_VERSION_KEY)
            .and_then(|value| value.parse::<i32>().ok());
        if marker != Some(client.schema.version) {
            client.run_schema_reset()?;
        } else if !client.outbox.is_empty() {
            // Reconstruct the visible optimistic overlay from the durable base
            // plus outbox instead of trusting a process-interrupted mirror.
            client.overlay_dirty.set(true);
            client.rebuild_overlay();
        }
        // Every persisted active subscription needs one catch-up pull on open:
        // realtime only covers changes after connection, while an idempotent
        // setWindow correctly creates no fresh command effect. Pending outbox
        // work has the same restart requirement. The core owns this intent so
        // native hosts never poll or require an application-issued sync().
        client.enqueue_startup_sync_if_needed();
        Ok(client)
    }

    /// Pin the client clock (epoch ms) — the §5.4 expiry check runs
    /// against this instead of system time (conformance virtual clock).
    pub fn set_now_ms(&mut self, now_ms: i64) {
        self.now_ms = Some(now_ms);
    }

    /// §5.11: install the client-side encryption keys (`keyId → key bytes`).
    /// The command router parses these from the `create` command's
    /// `encryption` config (keys as `{$bytes: hex}`).
    pub fn set_encryption(&mut self, encryption: crate::values::EncryptionConfig) {
        self.encryption = encryption;
    }

    fn clock_now_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        })
    }

    fn create_tables(&self) -> Result<(), String> {
        self.create_synced_tables()?;
        // Durable client bookkeeping (outbox + subscription + meta).
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS _syncular_outbox (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_commit_outcomes (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   client_commit_id TEXT NOT NULL UNIQUE,
                   status TEXT NOT NULL CHECK(status IN ('applied', 'cached', 'conflict', 'rejected')),
                   recorded_at_ms INTEGER NOT NULL,
                   results_json TEXT NOT NULL,
                   operations_json TEXT,
                   resolution TEXT NOT NULL DEFAULT 'active'
                     CHECK(resolution IN ('active', 'resolved_keep_server', 'superseded', 'dismissed')),
                   resolved_at_ms INTEGER,
                   replacement_client_commit_id TEXT);
                 CREATE INDEX IF NOT EXISTS _syncular_commit_outcomes_resolution_seq
                   ON _syncular_commit_outcomes(resolution, seq);
                 CREATE TABLE IF NOT EXISTS _syncular_subscriptions (
                   id TEXT PRIMARY KEY, tbl TEXT NOT NULL, state_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_meta (
                   key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_windows (
                   base TEXT NOT NULL, unit TEXT NOT NULL, sub_id TEXT NOT NULL,
                   PRIMARY KEY (base, unit));
                 CREATE TABLE IF NOT EXISTS _syncular_window_pending_evict (
                   sub_id TEXT PRIMARY KEY, tbl TEXT NOT NULL,
                   effective_scopes TEXT NOT NULL);",
            )
            .map_err(|e| e.to_string())?;
        // Migrate an outcome journal created before failed aggregate
        // envelopes were retained. Historical rows intentionally stay NULL.
        let _ = self
            .conn
            .execute_batch("ALTER TABLE _syncular_commit_outcomes ADD COLUMN operations_json TEXT");
        // §7.4.1: seed the persisted local schema-version marker on first
        // create (a fresh install is already at its generated version).
        if self.get_meta(LOCAL_SCHEMA_VERSION_KEY).is_none() {
            self.set_meta(LOCAL_SCHEMA_VERSION_KEY, &self.schema.version.to_string());
        }
        if self.get_meta(LOCAL_REVISION_KEY).is_none() {
            self.set_meta(LOCAL_REVISION_KEY, "0");
        }
        // §5.9.7 blob cache + pending-upload queue (created only when the
        // schema declares blob_ref columns; harmless otherwise). IF NOT EXISTS
        // so a reopened on-disk DB reuses the persisted bodies across restarts
        // (the §5.9.7 B1 storage model: bytes live as BLOBs in the client DB).
        if self.schema_has_blobs() {
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS _syncular_blobs (blob_id TEXT PRIMARY KEY,
                       bytes BLOB NOT NULL, byte_length INTEGER NOT NULL,
                       media_type TEXT, refcount INTEGER NOT NULL DEFAULT 0,
                       created_at_ms INTEGER NOT NULL,
                       last_used_ms INTEGER NOT NULL DEFAULT 0);
                     CREATE TABLE IF NOT EXISTS _syncular_blob_uploads (blob_id TEXT PRIMARY KEY,
                       media_type TEXT, created_at_ms INTEGER NOT NULL);",
                )
                .map_err(|e| e.to_string())?;
            // Migrate a cache created before the §5.9.7 B1 LRU column
            // (additive; the duplicate-column error on an already-migrated DB
            // is swallowed).
            let _ = self.conn.execute_batch(
                "ALTER TABLE _syncular_blobs ADD COLUMN last_used_ms INTEGER NOT NULL DEFAULT 0",
            );
        }
        Ok(())
    }

    /// True iff any synced table declares a `blob_ref` column (§5.9).
    fn schema_has_blobs(&self) -> bool {
        self.schema
            .tables
            .iter()
            .any(|t| t.columns.iter().any(|c| c.ty == ColumnType::BlobRef))
    }

    // -- meta (§7.4.1 marker, bookkeeping) ------------------------------------

    fn get_meta(&self, key: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .ok()
    }

    fn set_meta(&self, key: &str, value: &str) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        );
    }

    fn delete_meta(&self, key: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_meta WHERE key = ?1",
            rusqlite::params![key],
        );
    }

    fn restore_persisted_state(&mut self) -> Result<(), String> {
        self.subs = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, tbl, state_json FROM _syncular_subscriptions ORDER BY id ASC")
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            let mut subscriptions = Vec::new();
            for row in rows {
                let (id, table, raw) = row.map_err(|error| error.to_string())?;
                let state: Value = serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid persisted subscription {id:?}: {error}"))?;
                let requested = json_to_scope_map(
                    state.get("requested").unwrap_or(&Value::Object(Map::new())),
                )?;
                let effective = state
                    .get("effectiveScopes")
                    .filter(|value| !value.is_null())
                    .map(json_to_scope_map)
                    .transpose()?;
                subscriptions.push(Subscription {
                    id,
                    table,
                    requested,
                    params: state
                        .get("params")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cursor: state.get("cursor").and_then(Value::as_i64).unwrap_or(-1),
                    bootstrap_state: state
                        .get("bootstrapState")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    state: SubState::parse(
                        state
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("active"),
                    ),
                    reason_code: state
                        .get("reasonCode")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    effective,
                    synced_once: state
                        .get("syncedOnce")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
            subscriptions
        };

        self.outbox = {
            let mut stmt = self
                .conn
                .prepare("SELECT commit_id, ops_json FROM _syncular_outbox ORDER BY seq ASC")
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?;
            let mut commits = Vec::new();
            for row in rows {
                let (client_commit_id, raw) = row.map_err(|error| error.to_string())?;
                let entries: Vec<Value> = serde_json::from_str(&raw).map_err(|error| {
                    format!("invalid persisted outbox {client_commit_id:?}: {error}")
                })?;
                let mut ops = Vec::with_capacity(entries.len());
                for entry in entries {
                    let op = entry.get("op").and_then(Value::as_str).unwrap_or("delete");
                    ops.push(OutboxOp {
                        upsert: op == "upsert",
                        table: entry
                            .get("table")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "persisted outbox operation missing table".to_owned())?
                            .to_owned(),
                        row_id: entry
                            .get("rowId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "persisted outbox operation missing rowId".to_owned())?
                            .to_owned(),
                        base_version: entry.get("baseVersion").and_then(Value::as_i64),
                        values: entry.get("values").and_then(Value::as_object).cloned(),
                        changed_fields: entry.get("changedFields").and_then(Value::as_array).map(
                            |values| {
                                values
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            },
                        ),
                    });
                }
                commits.push(OutboxCommit {
                    client_commit_id,
                    ops,
                });
            }
            commits
        };

        self.prune_commit_outcomes()?;
        let active = self.commit_outcomes(CommitOutcomeQuery {
            active_only: true,
            ..CommitOutcomeQuery::default()
        })?;
        self.conflicts = active
            .iter()
            .flat_map(|outcome| outcome.results.iter())
            .filter_map(|result| match result {
                CommitOperationOutcome::Conflict { conflict } => Some(conflict.clone()),
                _ => None,
            })
            .collect();
        self.rejections = active
            .iter()
            .flat_map(|outcome| outcome.results.iter())
            .filter_map(|result| match result {
                CommitOperationOutcome::Error { rejection } => Some(rejection.clone()),
                _ => None,
            })
            .collect();

        self.lease_state = self
            .get_meta(LEASE_STATE_KEY)
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| format!("invalid persisted lease state: {error}"))?;
        self.schema_floor = self
            .get_meta(SCHEMA_FLOOR_KEY)
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| format!("invalid persisted schema floor: {error}"))?;
        self.stopped = self.schema_floor.is_some();
        Ok(())
    }

    #[must_use]
    pub fn local_revision(&self) -> u64 {
        self.get_meta(LOCAL_REVISION_KEY)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    }

    #[must_use]
    pub fn status_snapshot(&self) -> SyncStatusSnapshot {
        SyncStatusSnapshot {
            outbox: self.outbox.len(),
            upgrading: self.upgrading,
            lease_state: self.lease_state.clone(),
            schema_floor: self.schema_floor.clone(),
            sync_needed: self.sync_needed,
        }
    }

    pub fn drain_change_batches(&mut self) -> Vec<ClientChangeBatch> {
        self.change_queue.drain(..).collect()
    }

    pub fn drain_sync_intents(&mut self) -> Vec<SyncIntent> {
        self.sync_intent_queue.drain(..).collect()
    }

    fn schedule_background_retry(&mut self) {
        self.sync_intent_queue.push_back(SyncIntent::Background {
            delay_ms: self.retry_delay_ms,
        });
        self.retry_delay_ms = (self.retry_delay_ms * 2).min(30_000);
    }

    fn reset_background_retry(&mut self) {
        self.retry_delay_ms = 250;
    }

    fn retryable_transport_code(code: &str) -> bool {
        code == "transport.failed" || code == "sync.transport_failed"
    }

    fn set_sync_needed(&mut self, value: bool, interactive: bool) {
        if self.sync_needed != value {
            if self.begin_observation("syncular_status").is_ok() {
                self.sync_needed = value;
                let batch = ChangeAccumulator {
                    status: true,
                    ..ChangeAccumulator::default()
                };
                if self.finish_observation("syncular_status", batch).is_err() {
                    self.rollback_observation("syncular_status");
                }
            } else {
                self.sync_needed = value;
            }
        }
        if value && interactive {
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
    }

    fn begin_observation(&self, name: &str) -> Result<(), String> {
        self.conn
            .execute_batch(&format!("SAVEPOINT {name}"))
            .map_err(|error| error.to_string())
    }

    fn rollback_observation(&self, name: &str) {
        let _ = self
            .conn
            .execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
    }

    fn finish_observation(&mut self, name: &str, batch: ChangeAccumulator) -> Result<(), String> {
        if !batch.touched() {
            self.conn
                .execute_batch(&format!("RELEASE {name}"))
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        let revision = self
            .local_revision()
            .checked_add(1)
            .ok_or_else(|| "local revision exhausted u64".to_owned())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                rusqlite::params![LOCAL_REVISION_KEY, revision.to_string()],
            )
            .map_err(|error| error.to_string())?;
        let status = batch.status.then(|| self.status_snapshot());
        let event = ClientChangeBatch {
            revision: revision.to_string(),
            tables: batch
                .tables
                .into_iter()
                .map(|(table, scope_keys)| TableChange {
                    table,
                    scope_keys: scope_keys.map(|keys| keys.into_iter().collect()),
                })
                .collect(),
            windows: batch
                .windows
                .into_iter()
                .map(|((base_key, table), units)| WindowChange {
                    base_key,
                    table,
                    units: units.into_iter().collect(),
                })
                .collect(),
            status,
            conflicts_changed: batch.conflicts,
            rejections_changed: batch.rejections,
            outcomes_changed: batch.outcomes,
        };
        self.conn
            .execute_batch(&format!("RELEASE {name}"))
            .map_err(|error| error.to_string())?;
        self.change_queue.push_back(event);
        Ok(())
    }

    fn record_scope_map(
        &self,
        batch: &mut ChangeAccumulator,
        table_name: &str,
        scopes: &[(String, Vec<String>)],
    ) {
        let Some(table) = self.schema.table(table_name) else {
            return;
        };
        for (variable, values) in scopes {
            let Some(scope) = table
                .scope_variables
                .iter()
                .find(|scope| &scope.variable == variable)
            else {
                continue;
            };
            for value in values {
                batch.scope(table_name, format!("{}:{value}", scope.prefix));
            }
        }
    }

    /// Record a row's current scope keys from the base or visible table.
    fn record_row_scopes(
        &self,
        batch: &mut ChangeAccumulator,
        table_name: &str,
        row_id: &str,
        base: bool,
    ) -> bool {
        let Some(table) = self.schema.table(table_name) else {
            return false;
        };
        if table.scope_variables.is_empty() {
            return false;
        }
        let columns = table
            .scope_variables
            .iter()
            .map(|scope| quote_ident(&scope.column))
            .collect::<Vec<_>>()
            .join(", ");
        let full_table = if base {
            base_table(table_name)
        } else {
            visible_table(table_name)
        };
        let sql = format!(
            "SELECT {columns} FROM {full_table} WHERE CAST({} AS TEXT) = ?1 LIMIT 1",
            quote_ident(&table.primary_key)
        );
        let Ok(mut stmt) = self.conn.prepare(&sql) else {
            return false;
        };
        let values = stmt.query_row(rusqlite::params![row_id], |row| {
            let mut values = Vec::with_capacity(table.scope_variables.len());
            for index in 0..table.scope_variables.len() {
                values.push(row.get::<_, Option<String>>(index)?);
            }
            Ok(values)
        });
        let Ok(values) = values else {
            return false;
        };
        let mut recorded = false;
        for (scope, value) in table.scope_variables.iter().zip(values) {
            if let Some(value) = value {
                batch.scope(table_name, format!("{}:{value}", scope.prefix));
                recorded = true;
            }
        }
        recorded
    }

    fn record_commit_changes(
        &self,
        batch: &mut ChangeAccumulator,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) {
        for change in changes {
            let Some(table_name) = tables.get(change.table_index as usize) else {
                continue;
            };
            let mut precise = self.record_row_scopes(batch, table_name, &change.row_id, true);
            if let Some(table) = self.schema.table(table_name) {
                for (variable, value) in &change.scopes {
                    if let Some(scope) = table
                        .scope_variables
                        .iter()
                        .find(|scope| &scope.variable == variable)
                    {
                        batch.scope(table_name, format!("{}:{value}", scope.prefix));
                        precise = true;
                    }
                }
            }
            if !precise {
                batch.table(table_name);
            }
        }
    }

    fn scoped_rows_exist(&self, table_name: &str, effective: &[(String, Vec<String>)]) -> bool {
        if effective.is_empty() {
            return false;
        }
        let Some(table) = self.schema.table(table_name) else {
            return false;
        };
        let mut clauses = Vec::new();
        let mut params = Vec::new();
        for (variable, values) in effective {
            let Some(column) = table.scope_column(variable) else {
                return false;
            };
            if values.is_empty() {
                return false;
            }
            let placeholders = values
                .iter()
                .map(|value| {
                    params.push(SqlValue::Text(value.clone()));
                    "?"
                })
                .collect::<Vec<_>>()
                .join(", ");
            clauses.push(format!("{} IN ({placeholders})", quote_ident(column)));
        }
        let sql = format!(
            "SELECT 1 FROM {} WHERE {} LIMIT 1",
            base_table(table_name),
            clauses.join(" AND ")
        );
        self.conn
            .query_row(&sql, rusqlite::params_from_iter(params), |_| Ok(()))
            .is_ok()
    }

    /// §7.4.5: true while a schema-bump reset + first re-bootstrap runs.
    pub fn upgrading(&self) -> bool {
        self.upgrading
    }

    /// §7.4.2 "app ships new code": swap to a NEW generated schema while
    /// keeping this client's local database (identity, outbox, tables). The
    /// §7.4.1 marker check then fires the wipe/re-bootstrap flow when the
    /// version changed. Mirrors the TS client's boot-time detection —
    /// the Rust core has no persistent restart, so recreation IS the boot.
    pub fn recreate_with_schema(&mut self, schema_json: &Value) -> Result<(), String> {
        let new_schema = parse_schema_json(schema_json)?;
        let marker: Option<i32> = self
            .get_meta(LOCAL_SCHEMA_VERSION_KEY)
            .and_then(|v| v.parse().ok());
        self.schema = new_schema;
        if marker != Some(self.schema.version) {
            self.run_schema_reset()?;
        }
        // The conformance recreate is the in-memory equivalent of reopening a
        // durable client. Apply the same startup catch-up contract even when
        // the schema itself did not change.
        self.enqueue_startup_sync_if_needed();
        Ok(())
    }

    fn enqueue_startup_sync_if_needed(&mut self) {
        let startup_work = !self.stopped
            && (!self.outbox.is_empty()
                || self.subs.iter().any(|sub| sub.state == SubState::Active));
        if startup_work {
            self.sync_needed = true;
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
    }

    /// §7.4.3 reset: whole-database local reset EXCEPT the outbox, clientId,
    /// and leaseState. Drops/recreates every synced table from the new
    /// schema, resets subscription sync-state (keeping registrations), clears
    /// the schema-floor stop state, rewrites the marker, drops outbox commits
    /// that cannot re-encode (§7.4.4), and replays the survivors on top.
    fn run_schema_reset(&mut self) -> Result<(), String> {
        self.begin_observation("syncular_schema_reset")?;
        let mut batch = ChangeAccumulator::default();
        let result = self.run_schema_reset_observed(&mut batch);
        if let Err(error) = result {
            self.rollback_observation("syncular_schema_reset");
            return Err(error);
        }
        if let Err(error) = self.finish_observation("syncular_schema_reset", batch) {
            self.rollback_observation("syncular_schema_reset");
            return Err(error);
        }
        Ok(())
    }

    fn run_schema_reset_observed(&mut self, batch: &mut ChangeAccumulator) -> Result<(), String> {
        self.upgrading = true;
        batch.status = true;
        for table in &self.schema.tables {
            batch.table(&table.name);
        }
        for (base_key, unit, table) in self.load_registered_window_units() {
            batch.window(&base_key, &table, &unit);
        }
        // The per-table insert SQL is derived from the OLD column lists.
        self.insert_sql.borrow_mut().clear();
        self.overlay_dirty.set(true);
        // Drop every synced table (base + visible) that currently exists —
        // discovered from sqlite_master so a bump that adds/removes tables is
        // handled. Bookkeeping tables (`_syncular_outbox/_subscriptions/_meta`
        // and the blob cache) are preserved; base tables are `_syncular_base_*`
        // so they are matched explicitly, not by the bookkeeping filter.
        let existing: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok)
                .filter(|name| is_synced_table_name(name))
                .collect()
        };
        for name in &existing {
            if let Some(table) = name.strip_prefix("_syncular_base_") {
                batch.table(table);
            } else if !name.starts_with("_syncular_") {
                batch.table(name);
            }
        }
        for name in existing {
            let _ = self
                .conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), []);
        }
        // Recreate the synced tables from the NEW schema.
        self.create_synced_tables()?;
        // Reset every subscription's sync-state, keeping the registration.
        for sub in &mut self.subs {
            sub.cursor = -1;
            sub.bootstrap_state = None;
            sub.effective = None;
            sub.state = SubState::Active;
            sub.reason_code = None;
            sub.synced_once = false;
        }
        let subs = self.subs.clone();
        for sub in &subs {
            self.persist_sub(sub);
        }
        // The stop state is over: this client now ships a servable schema.
        self.stopped = false;
        self.schema_floor = None;
        self.delete_meta(SCHEMA_FLOOR_KEY);
        // Rewrite the marker LAST so a crash mid-reset re-runs the reset.
        self.set_meta(LOCAL_SCHEMA_VERSION_KEY, &self.schema.version.to_string());
        // §7.4.4: drop outbox commits that cannot re-encode under the new
        // schema (a referenced column/table the bump removed), surfacing each
        // as a `sync.outbox_incompatible` rejection.
        if self.drop_incompatible_outbox()? {
            batch.rejections = true;
            batch.status = true;
            batch.outcomes = true;
        }
        // Re-apply the surviving outbox optimistically over the empty tables.
        self.rebuild_overlay();
        Ok(())
    }

    /// §7.4.4: a persisted upsert whose values reference a column the current
    /// schema lacks (or a removed table) cannot be encoded. Drop the commit
    /// and raise a client-local `sync.outbox_incompatible` rejection.
    fn drop_incompatible_outbox(&mut self) -> Result<bool, String> {
        let schema = &self.schema;
        let incompatible = self
            .outbox
            .iter()
            .filter(|commit| {
                commit.ops.iter().any(|op| {
                    if !op.upsert {
                        return false;
                    }
                    match schema.table(&op.table) {
                        None => true,
                        Some(table) => op.values.as_ref().is_some_and(|values| {
                            values
                                .keys()
                                .any(|key| !table.columns.iter().any(|c| &c.name == key))
                        }),
                    }
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if incompatible.is_empty() {
            return Ok(false);
        }
        let mut rejections = Vec::new();
        for commit in &incompatible {
            let results = commit
                .ops
                .iter()
                .enumerate()
                .map(|(op_index, operation)| {
                    let rejection = RejectionRecord {
                        client_commit_id: commit.client_commit_id.clone(),
                        op_index: op_index as i32,
                        code: OUTBOX_INCOMPATIBLE_CODE.to_owned(),
                        message: "the persisted commit cannot encode under the current schema"
                            .to_owned(),
                        retryable: false,
                        details: None,
                        operation: Some(CommitOperation::from(operation)),
                    };
                    rejections.push(rejection.clone());
                    CommitOperationOutcome::Error { rejection }
                })
                .collect::<Vec<_>>();
            self.persist_commit_outcome(
                &commit.client_commit_id,
                CommitOutcomeStatus::Rejected,
                &results,
                Some(&commit.ops),
            )?;
            self.delete_outbox_persisted(&commit.client_commit_id)?;
        }
        self.prune_commit_outcomes()?;
        let incompatible_ids = incompatible
            .iter()
            .map(|commit| commit.client_commit_id.as_str())
            .collect::<BTreeSet<_>>();
        self.outbox
            .retain(|commit| !incompatible_ids.contains(commit.client_commit_id.as_str()));
        self.rejections.extend(rejections);
        Ok(true)
    }

    /// §7.4.3: (re)create the base + visible table pair for every synced
    /// table in the CURRENT schema (idempotent — `IF NOT EXISTS`).
    fn create_synced_tables(&self) -> Result<(), String> {
        for table in &self.schema.tables {
            // The base half + the visible half form the synced-table pair. An
            // index name is global in SQLite, so the base half's indexes are
            // name-prefixed (`_syncular_base_<index>`) to stay distinct.
            for (full, index_prefix) in [
                (base_table(&table.name), "_syncular_base_"),
                (visible_table(&table.name), ""),
            ] {
                let mut cols: Vec<String> =
                    table.columns.iter().map(|c| quote_ident(&c.name)).collect();
                cols.push("\"_syncular_version\" INTEGER NOT NULL".to_owned());
                let sql = format!(
                    "CREATE TABLE IF NOT EXISTS {full} ({} , PRIMARY KEY ({}))",
                    cols.join(", "),
                    quote_ident(&table.primary_key)
                );
                self.conn.execute(&sql, []).map_err(|e| e.to_string())?;
                // Local secondary indexes (CREATE INDEX subset). Created on
                // both halves so mirror reads hit an index on either. Runs on
                // both the initial create and the §7.4.3 reset recreate path.
                for index in &table.indexes {
                    let unique = if index.unique { "UNIQUE " } else { "" };
                    let index_name = quote_ident(&format!("{index_prefix}{}", index.name));
                    let cols_sql = index
                        .columns
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let index_sql = format!(
                        "CREATE {unique}INDEX IF NOT EXISTS {index_name} ON {full} ({cols_sql})"
                    );
                    self.conn
                        .execute(&index_sql, [])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    // -- persistence write-through --------------------------------------------

    fn persist_sub(&self, sub: &Subscription) {
        let state = serde_json::json!({
            "requested": scope_map_to_json(&sub.requested),
            "params": sub.params,
            "cursor": sub.cursor,
            "bootstrapState": sub.bootstrap_state,
            "status": sub.state.name(),
            "reasonCode": sub.reason_code,
            "effectiveScopes": sub.effective.as_ref().map(|e| scope_map_to_json(e)),
            "syncedOnce": sub.synced_once,
        });
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_subscriptions (id, tbl, state_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub.id, sub.table, state.to_string()],
        );
    }

    fn persist_outbox_insert(&self, commit: &OutboxCommit) {
        let ops: Vec<Value> = commit
            .ops
            .iter()
            .map(|op| {
                serde_json::json!({
                    "op": if op.upsert { "upsert" } else { "delete" },
                    "table": op.table,
                    "rowId": op.row_id,
                    "baseVersion": op.base_version,
                    "values": op.values.clone().map(Value::Object),
                    "changedFields": op.changed_fields,
                })
            })
            .collect();
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_outbox (commit_id, ops_json) VALUES (?1, ?2)",
            rusqlite::params![commit.client_commit_id, Value::Array(ops).to_string()],
        );
    }

    fn delete_outbox_persisted(&self, client_commit_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_outbox WHERE commit_id = ?1",
                rusqlite::params![client_commit_id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn outcome_status_name(status: CommitOutcomeStatus) -> &'static str {
        match status {
            CommitOutcomeStatus::Applied => "applied",
            CommitOutcomeStatus::Cached => "cached",
            CommitOutcomeStatus::Conflict => "conflict",
            CommitOutcomeStatus::Rejected => "rejected",
        }
    }

    fn outcome_resolution_name(resolution: CommitOutcomeResolution) -> &'static str {
        match resolution {
            CommitOutcomeResolution::Active => "active",
            CommitOutcomeResolution::ResolvedKeepServer => "resolved_keep_server",
            CommitOutcomeResolution::Superseded => "superseded",
            CommitOutcomeResolution::Dismissed => "dismissed",
        }
    }

    fn parse_outcome_status(value: &str) -> Result<CommitOutcomeStatus, String> {
        match value {
            "applied" => Ok(CommitOutcomeStatus::Applied),
            "cached" => Ok(CommitOutcomeStatus::Cached),
            "conflict" => Ok(CommitOutcomeStatus::Conflict),
            "rejected" => Ok(CommitOutcomeStatus::Rejected),
            _ => Err(format!("invalid persisted commit outcome status {value:?}")),
        }
    }

    fn parse_outcome_resolution(value: &str) -> Result<CommitOutcomeResolution, String> {
        match value {
            "active" => Ok(CommitOutcomeResolution::Active),
            "resolved_keep_server" => Ok(CommitOutcomeResolution::ResolvedKeepServer),
            "superseded" => Ok(CommitOutcomeResolution::Superseded),
            "dismissed" => Ok(CommitOutcomeResolution::Dismissed),
            _ => Err(format!(
                "invalid persisted commit outcome resolution {value:?}"
            )),
        }
    }

    fn persist_commit_outcome(
        &self,
        client_commit_id: &str,
        status: CommitOutcomeStatus,
        results: &[CommitOperationOutcome],
        operations: Option<&[OutboxOp]>,
    ) -> Result<(), String> {
        let results_json = serde_json::to_string(results).map_err(|error| error.to_string())?;
        let operations_json = operations
            .map(|items| {
                serde_json::to_string(&items.iter().map(CommitOperation::from).collect::<Vec<_>>())
            })
            .transpose()
            .map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "INSERT INTO _syncular_commit_outcomes (
                   client_commit_id, status, recorded_at_ms, results_json,
                   operations_json, resolution
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'active')",
                rusqlite::params![
                    client_commit_id,
                    Self::outcome_status_name(status),
                    self.clock_now_ms(),
                    results_json,
                    operations_json
                ],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn outcome_from_row(row: StoredCommitOutcomeRow) -> Result<CommitOutcome, String> {
        let StoredCommitOutcomeRow {
            sequence,
            client_commit_id,
            status,
            recorded_at_ms,
            results_json,
            operations_json,
            resolution,
            resolved_at_ms,
            replacement_client_commit_id,
        } = row;
        Ok(CommitOutcome {
            sequence,
            client_commit_id,
            status: Self::parse_outcome_status(&status)?,
            recorded_at_ms,
            results: serde_json::from_str(&results_json)
                .map_err(|error| format!("invalid persisted commit outcome results: {error}"))?,
            operations: operations_json
                .map(|value| {
                    serde_json::from_str(&value).map_err(|error| {
                        format!("invalid persisted commit outcome operations: {error}")
                    })
                })
                .transpose()?,
            resolution: Self::parse_outcome_resolution(&resolution)?,
            resolved_at_ms,
            replacement_client_commit_id,
        })
    }

    pub fn commit_outcome(&self, client_commit_id: &str) -> Result<Option<CommitOutcome>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT seq, client_commit_id, status, recorded_at_ms, results_json, operations_json,
                        resolution, resolved_at_ms, replacement_client_commit_id
                   FROM _syncular_commit_outcomes WHERE client_commit_id = ?1",
                rusqlite::params![client_commit_id],
                |row| {
                    Ok(StoredCommitOutcomeRow {
                        sequence: row.get(0)?,
                        client_commit_id: row.get(1)?,
                        status: row.get(2)?,
                        recorded_at_ms: row.get(3)?,
                        results_json: row.get(4)?,
                        operations_json: row.get(5)?,
                        resolution: row.get(6)?,
                        resolved_at_ms: row.get(7)?,
                        replacement_client_commit_id: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        row.map(Self::outcome_from_row).transpose()
    }

    pub fn commit_outcomes(&self, query: CommitOutcomeQuery) -> Result<Vec<CommitOutcome>, String> {
        if query.limit == Some(0) {
            return Err("sync.invalid_request: commit outcome limit must be positive".to_owned());
        }
        let mut sql = String::from(
            "SELECT seq, client_commit_id, status, recorded_at_ms, results_json, operations_json,
                    resolution, resolved_at_ms, replacement_client_commit_id
               FROM _syncular_commit_outcomes",
        );
        if query.active_only {
            sql.push_str(" WHERE resolution = 'active' AND status IN ('conflict', 'rejected')");
        }
        sql.push_str(" ORDER BY seq DESC");
        if let Some(limit) = query.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        let mut stmt = self.conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(StoredCommitOutcomeRow {
                    sequence: row.get(0)?,
                    client_commit_id: row.get(1)?,
                    status: row.get(2)?,
                    recorded_at_ms: row.get(3)?,
                    results_json: row.get(4)?,
                    operations_json: row.get(5)?,
                    resolution: row.get(6)?,
                    resolved_at_ms: row.get(7)?,
                    replacement_client_commit_id: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut outcomes = Vec::new();
        for row in rows {
            outcomes.push(Self::outcome_from_row(
                row.map_err(|error| error.to_string())?,
            )?);
        }
        Ok(outcomes)
    }

    fn prune_commit_outcomes(&self) -> Result<(), String> {
        let max_entries = self.limits.outcome_retention_max_entries.unwrap_or(1_000);
        let count = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM _syncular_commit_outcomes",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as usize;
        let excess = count.saturating_sub(max_entries);
        if excess == 0 {
            return Ok(());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq FROM _syncular_commit_outcomes
                  WHERE status IN ('applied', 'cached') OR resolution != 'active'
                  ORDER BY seq ASC LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![excess as i64], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        let sequences = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(stmt);
        for sequence in sequences {
            self.conn
                .execute(
                    "DELETE FROM _syncular_commit_outcomes WHERE seq = ?1",
                    rusqlite::params![sequence],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    // -- driver surface ---------------------------------------------------------

    pub fn subscribe(
        &mut self,
        id: String,
        table: String,
        scopes: Vec<(String, Vec<String>)>,
        params: Option<String>,
    ) -> Result<(), String> {
        if self.schema.table(&table).is_none() {
            return Err(format!("unknown table {table:?}"));
        }
        let sub = Subscription {
            id: id.clone(),
            table,
            requested: scopes,
            params,
            cursor: -1,
            bootstrap_state: None,
            state: SubState::Active,
            reason_code: None,
            effective: None,
            synced_once: false,
        };
        self.persist_sub(&sub);
        if let Some(existing) = self.subs.iter_mut().find(|s| s.id == id) {
            *existing = sub;
        } else {
            self.subs.push(sub);
        }
        Ok(())
    }

    pub fn unsubscribe(&mut self, id: &str) {
        self.subs.retain(|s| s.id != id);
        let _ = self.conn.execute(
            "DELETE FROM _syncular_subscriptions WHERE id = ?1",
            rusqlite::params![id],
        );
    }

    // -- windowed subscriptions (§4.8) ------------------------------------------

    /// §4.8: set the live window units for a base — a value-sharded family
    /// of subscriptions, one per unit. Added units get fresh subscriptions
    /// (image-lane bootstrap on the next sync); removed units are
    /// unsubscribed and evicted, fused in one local transaction (E1–E4).
    /// Idempotent; re-entry cancels any deferred eviction.
    pub fn set_window(
        &mut self,
        base: &WindowBase,
        units: &[String],
    ) -> Result<CommandEffects, String> {
        let table = self
            .schema
            .table(&base.table)
            .ok_or_else(|| format!("unknown table {:?}", base.table))?;
        if table.scope_column(&base.variable).is_none() {
            return Err(format!(
                "setWindow: table {:?} has no scope variable {:?} (§4.8)",
                base.table, base.variable
            ));
        }
        let base_key = window_base_key(base);
        let wanted: std::collections::HashSet<&String> = units.iter().collect();
        let live = self.load_window_units(&base_key);
        self.begin_observation("syncular_window")?;
        let mut batch = ChangeAccumulator::default();
        let mut changed = false;

        // Widen: units wanted but not live → fresh subscription + registry row.
        for unit in units {
            if live.iter().any(|(u, _)| u == unit) {
                continue;
            }
            let sub_id = derive_sub_id(base, unit);
            self.delete_pending_evict(&sub_id);
            self.insert_window_unit(&base_key, unit, &sub_id);
            self.subscribe(
                sub_id,
                base.table.clone(),
                unit_scopes(base, unit),
                base.params.clone(),
            )?;
            batch.window(&base_key, &base.table, unit);
            changed = true;
        }

        // Shrink: units live but not wanted → unsubscribe fused with eviction.
        for (unit, sub_id) in live {
            if wanted.contains(&unit) {
                continue;
            }
            let effective = self
                .subs
                .iter()
                .find(|sub| sub.id == sub_id)
                .and_then(|sub| sub.effective.clone())
                .unwrap_or_else(|| unit_scopes(base, &unit));
            self.record_scope_map(&mut batch, &base.table, &effective);
            batch.window(&base_key, &base.table, &unit);
            self.evict_unit(&base_key, base, &unit, &sub_id);
            changed = true;
        }
        if let Err(error) = self.finish_observation("syncular_window", batch) {
            self.rollback_observation("syncular_window");
            return Err(error);
        }
        Ok(if changed {
            CommandEffects::interactive()
        } else {
            CommandEffects::none()
        })
    }

    /// §4.8 completeness oracle (I3): the windowed-in units for a base plus
    /// the subset still bootstrap-pending. Registration alone is not
    /// completeness — a unit is pending until its subscription completes a
    /// bootstrap round (cursor advances past -1 with no resume token held).
    pub fn window_state(&self, base: &WindowBase) -> WindowState {
        let mut units = Vec::new();
        let mut pending = Vec::new();
        for (unit, sub_id) in self.load_window_units(&window_base_key(base)) {
            let is_pending = match self.subs.iter().find(|s| s.id == sub_id) {
                Some(sub) => {
                    sub.state != SubState::Active || sub.cursor < 0 || sub.bootstrap_state.is_some()
                }
                None => true,
            };
            if is_pending {
                pending.push(unit.clone());
            }
            units.push(unit);
        }
        WindowState { units, pending }
    }

    fn load_window_units(&self, base_key: &str) -> Vec<(String, String)> {
        let mut stmt = match self
            .conn
            .prepare("SELECT unit, sub_id FROM _syncular_windows WHERE base = ?1 ORDER BY unit ASC")
        {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(rusqlite::params![base_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn load_registered_window_units(&self) -> Vec<(String, String, String)> {
        let mut stmt = match self.conn.prepare(
            "SELECT windows.base, windows.unit, subscriptions.tbl
               FROM _syncular_windows AS windows
               JOIN _syncular_subscriptions AS subscriptions
                 ON subscriptions.id = windows.sub_id
               ORDER BY windows.base, windows.unit",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn window_unit_by_sub_id(&self, sub_id: &str) -> Option<(String, String)> {
        self.conn
            .query_row(
                "SELECT base, unit FROM _syncular_windows WHERE sub_id = ?1 LIMIT 1",
                rusqlite::params![sub_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    }

    fn insert_window_unit(&self, base_key: &str, unit: &str, sub_id: &str) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_windows(base, unit, sub_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![base_key, unit, sub_id],
        );
    }

    fn delete_window_unit(&self, base_key: &str, unit: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_windows WHERE base = ?1 AND unit = ?2",
            rusqlite::params![base_key, unit],
        );
    }

    /// §4.8 E1–E4: evict one departing unit, fused with unsubscription.
    /// Deletes the unit's rows except those pinned by a pending outbox
    /// commit (E1); records a deferred eviction if any pin remains; discards
    /// the subscription's cursor/resume/effective-echo (E3) and version
    /// state with the rows (E2). Fail-closed: no local mapping ⇒ evict
    /// nothing.
    fn evict_unit(&mut self, base_key: &str, base: &WindowBase, unit: &str, sub_id: &str) {
        let effective = self
            .subs
            .iter()
            .find(|s| s.id == sub_id)
            .and_then(|s| s.effective.clone())
            .unwrap_or_else(|| unit_scopes(base, unit));
        let pinned = self.pinned_row_ids(&base.table);
        let deferred = self
            .evict_scope_rows(&base.table, &effective, &pinned)
            .unwrap_or(false);
        self.delete_window_unit(base_key, unit);
        self.unsubscribe(sub_id);
        if deferred {
            self.save_pending_evict(sub_id, &base.table, &effective);
        } else {
            self.delete_pending_evict(sub_id);
        }
        self.rebuild_overlay();
    }

    /// §4.8 E1: delete base rows matching effective scopes EXCEPT pinned
    /// primary keys; returns `Ok(true)` iff a pinned row was left behind (so
    /// the eviction must be deferred). `Err(())` = fail-closed (no mapping).
    fn evict_scope_rows(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        pinned: &std::collections::HashSet<String>,
    ) -> Result<bool, ()> {
        if effective.is_empty() {
            return Ok(false);
        }
        let table = self.schema.table(table_name).ok_or(())?.clone();
        let mut clauses = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or(())?;
            let placeholders: Vec<String> = values
                .iter()
                .map(|v| {
                    params.push(SqlValue::Text(v.clone()));
                    "?".to_owned()
                })
                .collect();
            clauses.push(format!(
                "{} IN ({})",
                quote_ident(column),
                placeholders.join(", ")
            ));
        }
        let mut sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            clauses.join(" AND ")
        );
        if !pinned.is_empty() {
            let pk = quote_ident(&table.primary_key);
            let holes: Vec<String> = pinned
                .iter()
                .map(|id| {
                    params.push(SqlValue::Text(id.clone()));
                    "?".to_owned()
                })
                .collect();
            sql.push_str(&format!(" AND {} NOT IN ({})", pk, holes.join(", ")));
        }
        self.overlay_dirty.set(true);
        self.conn
            .execute(&sql, rusqlite::params_from_iter(params))
            .map_err(|_| ())?;
        if pinned.is_empty() {
            return Ok(false);
        }
        // A pin defers the eviction only if a pinned row actually falls
        // inside this unit's effective scopes — re-select the survivors.
        let mut where_params: Vec<SqlValue> = Vec::new();
        let mut where_clauses = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or(())?;
            let placeholders: Vec<String> = values
                .iter()
                .map(|v| {
                    where_params.push(SqlValue::Text(v.clone()));
                    "?".to_owned()
                })
                .collect();
            where_clauses.push(format!(
                "{} IN ({})",
                quote_ident(column),
                placeholders.join(", ")
            ));
        }
        let pk = quote_ident(&table.primary_key);
        let select = format!(
            "SELECT {} FROM {} WHERE {}",
            pk,
            base_table(table_name),
            where_clauses.join(" AND ")
        );
        let mut stmt = self.conn.prepare(&select).map_err(|_| ())?;
        let survivors: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(where_params), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| ())?
            .filter_map(Result::ok)
            .collect();
        Ok(survivors.iter().any(|id| pinned.contains(id)))
    }

    /// §4.8 E1: retry deferred evictions after the outbox drains. No
    /// pending records (the common case) means nothing to retry — and no
    /// overlay rebuild.
    fn drain_pending_evictions(&mut self) {
        let pending = self.load_pending_evictions();
        if pending.is_empty() {
            return;
        }
        for (sub_id, table_name, effective) in pending {
            if self.schema.table(&table_name).is_none() {
                self.delete_pending_evict(&sub_id);
                continue;
            }
            let pinned = self.pinned_row_ids(&table_name);
            let deferred = self
                .evict_scope_rows(&table_name, &effective, &pinned)
                .unwrap_or(false);
            if !deferred {
                self.delete_pending_evict(&sub_id);
            }
        }
        self.rebuild_overlay_if_dirty();
    }

    /// §4.8 E1: primary keys of `table` referenced by a pending outbox
    /// commit — rows that MUST NOT be evicted until the commit drains.
    fn pinned_row_ids(&self, table: &str) -> std::collections::HashSet<String> {
        let mut pinned = std::collections::HashSet::new();
        for commit in &self.outbox {
            for op in &commit.ops {
                if op.table == table {
                    pinned.insert(op.row_id.clone());
                }
            }
        }
        pinned
    }

    fn save_pending_evict(&self, sub_id: &str, table: &str, effective: &[(String, Vec<String>)]) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_window_pending_evict(sub_id, tbl, effective_scopes)
               VALUES (?1, ?2, ?3)",
            rusqlite::params![sub_id, table, scope_map_to_json(effective).to_string()],
        );
    }

    fn delete_pending_evict(&self, sub_id: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
            rusqlite::params![sub_id],
        );
    }

    fn load_pending_evictions(&self) -> Vec<PendingEvict> {
        let mut stmt = match self
            .conn
            .prepare("SELECT sub_id, tbl, effective_scopes FROM _syncular_window_pending_evict")
        {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        let mut out = Vec::new();
        if let Ok(rows) = rows {
            for entry in rows.filter_map(Result::ok) {
                let (sub_id, table, json) = entry;
                if let Ok(value) = serde_json::from_str::<Value>(&json) {
                    if let Ok(effective) = json_to_scope_map(&value) {
                        out.push((sub_id, table, effective));
                    }
                }
            }
        }
        out
    }

    /// Record one atomic local commit (§7.1) and apply it optimistically.
    pub fn mutate(&mut self, mutations: Vec<Mutation>) -> Result<String, String> {
        if mutations.is_empty() {
            return Err("a commit must contain at least one operation (§6.1)".to_owned());
        }
        let mut ops = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            match mutation {
                Mutation::Upsert {
                    table,
                    values,
                    base_version,
                } => {
                    let schema_table = self
                        .schema
                        .table(&table)
                        .ok_or_else(|| format!("unknown table {table:?}"))?;
                    // §5: value keys are accepted in snake_case AND the
                    // generated row types' camelCase; normalize to SQL truth
                    // before the pk lookup / codec see them.
                    let values = normalize_values_casing(schema_table, values)?;
                    let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                    // Validate the payload encodes with the current codec
                    // (and, §5.11, that the encrypt seam has its keys).
                    encode_row_json(schema_table, &row_id, &values, &self.encryption)?;
                    ops.push(OutboxOp {
                        upsert: true,
                        table,
                        row_id,
                        base_version,
                        values: Some(values),
                        changed_fields: None,
                    });
                }
                Mutation::Delete {
                    table,
                    row_id,
                    base_version,
                } => {
                    if self.schema.table(&table).is_none() {
                        return Err(format!("unknown table {table:?}"));
                    }
                    ops.push(OutboxOp {
                        upsert: false,
                        table,
                        row_id,
                        base_version,
                        values: None,
                        changed_fields: None,
                    });
                }
            }
        }
        self.record_outbox_commit(ops)
    }

    fn record_outbox_commit(&mut self, ops: Vec<OutboxOp>) -> Result<String, String> {
        let commit = OutboxCommit {
            client_commit_id: uuid::Uuid::new_v4().to_string(),
            ops,
        };
        self.begin_observation("syncular_mutation")?;
        let mut batch = ChangeAccumulator::default();
        for op in &commit.ops {
            let mut precise = self.record_row_scopes(&mut batch, &op.table, &op.row_id, false);
            if let Some(values) = &op.values {
                if let Some(table) = self.schema.table(&op.table) {
                    for scope in &table.scope_variables {
                        if let Some(Value::String(value)) = values.get(&scope.column) {
                            batch.scope(&op.table, format!("{}:{value}", scope.prefix));
                            precise = true;
                        }
                    }
                }
            }
            if !precise {
                batch.table(&op.table);
            }
        }
        self.persist_outbox_insert(&commit);
        let id = commit.client_commit_id.clone();
        self.outbox.push(commit);
        self.overlay_dirty.set(true);
        self.rebuild_overlay();
        batch.status = true;
        if let Err(error) = self.finish_observation("syncular_mutation", batch) {
            self.rollback_observation("syncular_mutation");
            return Err(error);
        }
        Ok(id)
    }

    /// Merge a partial update over the current visible local row, then record
    /// the ordinary full-row upsert. This keeps patch semantics identical
    /// across the TypeScript and native cores without weakening the wire's
    /// full-row invariant.
    pub fn patch(
        &mut self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<String, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?;
        let partial = normalize_values_casing(schema_table, partial)?;
        let mut values = self
            .read_rows(table)?
            .into_iter()
            .find(|row| row.row_id == row_id)
            .map(|row| row.values)
            .ok_or_else(|| {
                format!(
                    "sync.invalid_request: table {table:?} has no local row with primary key {row_id:?} to patch"
                )
            })?;
        let mut changed_fields = partial.keys().cloned().collect::<Vec<_>>();
        changed_fields.sort();
        values.extend(partial);
        let row_id_from_values = render_row_id_json(values.get(&schema_table.primary_key))?;
        if row_id_from_values != row_id {
            return Err("sync.invalid_request: patch cannot change the primary key".to_owned());
        }
        encode_row_json(schema_table, row_id, &values, &self.encryption)?;
        self.record_outbox_commit(vec![OutboxOp {
            upsert: true,
            table: table.to_owned(),
            row_id: row_id.to_owned(),
            base_version,
            values: Some(values),
            changed_fields: Some(changed_fields),
        }])
    }

    pub fn pending_commit_ids(&self) -> Vec<String> {
        self.outbox
            .iter()
            .map(|c| c.client_commit_id.clone())
            .collect()
    }

    pub fn conflicts(&self) -> &[ConflictRecord] {
        &self.conflicts
    }

    pub fn rejections(&self) -> &[RejectionRecord] {
        &self.rejections
    }

    pub fn resolve_commit_outcome(
        &mut self,
        input: ResolveCommitOutcomeInput,
    ) -> Result<CommitOutcome, String> {
        let current = self
            .commit_outcome(&input.client_commit_id)?
            .ok_or_else(|| {
                format!(
                    "sync.outcome_not_found: no durable outcome exists for {:?}",
                    input.client_commit_id
                )
            })?;
        if current.resolution != CommitOutcomeResolution::Active {
            return Ok(current);
        }
        if input.resolution == CommitOutcomeResolution::Active {
            return Err("sync.invalid_request: resolution must leave active state".to_owned());
        }
        match input.resolution {
            CommitOutcomeResolution::Superseded => {
                let replacement = input
                    .replacement_client_commit_id
                    .as_deref()
                    .filter(|value| !value.is_empty() && *value != input.client_commit_id)
                    .ok_or_else(|| {
                        "sync.invalid_request: superseded outcomes require a distinct replacementClientCommitId"
                            .to_owned()
                    })?;
                let _ = replacement;
            }
            _ if input.replacement_client_commit_id.is_some() => {
                return Err(
                    "sync.invalid_request: replacementClientCommitId is valid only for superseded outcomes"
                        .to_owned(),
                );
            }
            _ => {}
        }
        let allowed = match current.status {
            CommitOutcomeStatus::Conflict => matches!(
                input.resolution,
                CommitOutcomeResolution::ResolvedKeepServer | CommitOutcomeResolution::Superseded
            ),
            CommitOutcomeStatus::Rejected => {
                input.resolution == CommitOutcomeResolution::Superseded
            }
            CommitOutcomeStatus::Applied | CommitOutcomeStatus::Cached => {
                input.resolution == CommitOutcomeResolution::Dismissed
            }
        };
        if !allowed {
            return Err(format!(
                "sync.invalid_request: resolution {:?} is invalid for {:?} outcome",
                input.resolution, current.status
            ));
        }

        self.begin_observation("syncular_outcome_resolution")?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE _syncular_commit_outcomes
                        SET resolution = ?1, resolved_at_ms = ?2,
                            replacement_client_commit_id = ?3
                      WHERE client_commit_id = ?4 AND resolution = 'active'",
                    rusqlite::params![
                        Self::outcome_resolution_name(input.resolution),
                        self.clock_now_ms(),
                        input.replacement_client_commit_id,
                        input.client_commit_id
                    ],
                )
                .map_err(|error| error.to_string())?;
            let resolved = self
                .commit_outcome(&current.client_commit_id)?
                .ok_or_else(|| "sync.outcome_not_found: outcome disappeared".to_owned())?;
            self.prune_commit_outcomes()?;
            Ok(resolved)
        })();
        let resolved = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.rollback_observation("syncular_outcome_resolution");
                return Err(error);
            }
        };
        self.conflicts
            .retain(|record| record.client_commit_id != current.client_commit_id);
        self.rejections
            .retain(|record| record.client_commit_id != current.client_commit_id);
        let batch = ChangeAccumulator {
            conflicts: current.status == CommitOutcomeStatus::Conflict,
            rejections: current.status == CommitOutcomeStatus::Rejected,
            outcomes: true,
            ..ChangeAccumulator::default()
        };
        if let Err(error) = self.finish_observation("syncular_outcome_resolution", batch) {
            self.rollback_observation("syncular_outcome_resolution");
            return Err(error);
        }
        Ok(resolved)
    }

    pub fn schema_floor(&self) -> Option<&SchemaFloor> {
        self.schema_floor.as_ref()
    }

    /// §7.3.5: the client's opaque auth-lease state, if any.
    pub fn lease_state(&self) -> Option<&LeaseState> {
        self.lease_state.as_ref()
    }

    /// §7.3.5: record a request-level lease error (stop-and-surface). Only
    /// the two lease codes set it; other errors leave leaseState untouched.
    fn record_lease_error(&mut self, code: &str) {
        if code != "sync.auth_lease_required" && code != "sync.auth_lease_revoked" {
            return;
        }
        let mut next = self.lease_state.clone().unwrap_or_default();
        next.error_code = Some(code.to_owned());
        self.set_lease_state(Some(next));
    }

    fn set_lease_state(&mut self, next: Option<LeaseState>) {
        if self.lease_state == next {
            return;
        }
        if self.begin_observation("syncular_lease").is_err() {
            return;
        }
        self.lease_state = next;
        if let Some(lease) = &self.lease_state {
            if let Ok(json) = serde_json::to_string(lease) {
                self.set_meta(LEASE_STATE_KEY, &json);
            }
        } else {
            self.delete_meta(LEASE_STATE_KEY);
        }
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if self.finish_observation("syncular_lease", batch).is_err() {
            self.rollback_observation("syncular_lease");
        }
    }

    fn set_schema_floor(&mut self, next: Option<SchemaFloor>) {
        if self.schema_floor == next {
            return;
        }
        if self.begin_observation("syncular_schema_floor").is_err() {
            return;
        }
        self.schema_floor = next;
        self.stopped = self.schema_floor.is_some();
        if let Some(floor) = &self.schema_floor {
            if let Ok(json) = serde_json::to_string(floor) {
                self.set_meta(SCHEMA_FLOOR_KEY, &json);
            }
        } else {
            self.delete_meta(SCHEMA_FLOOR_KEY);
        }
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if self
            .finish_observation("syncular_schema_floor", batch)
            .is_err()
        {
            self.rollback_observation("syncular_schema_floor");
        }
    }

    fn set_upgrading(&mut self, value: bool) {
        if self.upgrading == value {
            return;
        }
        if self.begin_observation("syncular_upgrading").is_err() {
            return;
        }
        self.upgrading = value;
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if self
            .finish_observation("syncular_upgrading", batch)
            .is_err()
        {
            self.rollback_observation("syncular_upgrading");
        }
    }

    pub fn sync_needed(&self) -> bool {
        self.sync_needed
    }

    pub fn subscription_state(&self, id: &str) -> Option<SubscriptionStateView> {
        let sub = self.subs.iter().find(|s| s.id == id)?;
        Some(SubscriptionStateView {
            id: sub.id.clone(),
            table: sub.table.clone(),
            status: sub.state.name().to_owned(),
            cursor: sub.cursor,
            has_resume_token: sub.bootstrap_state.is_some(),
            effective_scopes: sub.effective.as_ref().map(|e| scope_map_to_json(e)),
            reason_code: sub.reason_code.clone(),
        })
    }

    pub fn read_rows(&self, table: &str) -> Result<Vec<RowState>, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?;
        let sql = format!(
            "SELECT * FROM {} ORDER BY {} ASC",
            visible_table(table),
            quote_ident(&schema_table.primary_key)
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut values = Map::new();
            for (i, column) in schema_table.columns.iter().enumerate() {
                let value = row.get_ref(i).map_err(|e| e.to_string())?;
                values.insert(column.name.clone(), sql_ref_to_json(column, value));
            }
            let version: i64 = row
                .get(schema_table.columns.len())
                .map_err(|e| e.to_string())?;
            let row_id = match values.get(&schema_table.primary_key) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Bool(b)) => b.to_string(),
                other => format!("{}", other.cloned().unwrap_or(Value::Null)),
            };
            out.push(RowState {
                row_id,
                version,
                values,
            });
        }
        Ok(out)
    }

    // -- §5.10.5 native CRDT (the `crdt-yjs` feature) --------------------------
    //
    // The Rust face of the §5.10.4 client model: a local crdt edit loads the
    // current stored (server-merged ⊕ pending-overlay) column bytes, applies
    // the op with `yrs`, re-encodes the whole doc state, and pushes it as a
    // baseVersion-less upsert through the ordinary `mutate` path (§5.10.3
    // "crdt-only divergence merges cleanly"). No local merge — merging is
    // server-side; the overlay's last-write-wins re-materializes the edit
    // immediately (optimistic apply, §7.1) and the server-merged bytes arrive
    // on the next pull, idempotently. Byte-compatible with `@syncular/crdt-yjs`.

    /// The current stored value of a `crdt` column for one row — the visible
    /// (optimistic) bytes, or `None` when the row is absent or the column is
    /// NULL (the empty document, §5.10.1). Errors if the column is not a
    /// `crdt` column (guards the app against a typo'd column name).
    #[cfg(feature = "crdt-yjs")]
    fn crdt_column_bytes(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?;
        let col = schema_table
            .columns
            .iter()
            .find(|c| c.name == column)
            .ok_or_else(|| format!("table {table:?} has no column {column:?}"))?;
        if col.ty != ColumnType::Crdt {
            return Err(format!("column {column:?} is not a crdt column (§5.10.1)"));
        }
        let sql = format!(
            "SELECT {} FROM {} WHERE CAST({} AS TEXT) = ?1",
            quote_ident(column),
            visible_table(table),
            quote_ident(&schema_table.primary_key)
        );
        let bytes: Option<Vec<u8>> = self
            .conn
            .query_row(&sql, rusqlite::params![row_id], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => "no such row".to_owned(),
                other => other.to_string(),
            })?;
        Ok(bytes)
    }

    /// §5.10.4 materialize: the collaborative text of a `crdt` column, decoded
    /// from the stored bytes with `yrs` — `YjsColumn.text(name).toString()`.
    /// An absent row / NULL column is the empty document (empty string).
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_text(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
    ) -> Result<String, String> {
        let bytes = self
            .crdt_column_bytes(table, row_id, column)?
            .unwrap_or_default();
        crate::crdt::text(&bytes, name)
    }

    /// §5.10.4 push-an-update: apply a text insert to a `crdt` column and push
    /// the resulting full-state update through the normal (baseVersion-less)
    /// mutate path. Returns the enqueued `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_insert_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        value: &str,
    ) -> Result<String, String> {
        let current = self
            .crdt_column_bytes(table, row_id, column)?
            .unwrap_or_default();
        let update = crate::crdt::insert_text(&current, name, index, value)?;
        self.crdt_push_update(table, row_id, column, &update)
    }

    /// §5.10.4 push-an-update: apply a text delete to a `crdt` column and push
    /// the resulting full-state update. Returns the enqueued `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_delete_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        len: u32,
    ) -> Result<String, String> {
        let current = self
            .crdt_column_bytes(table, row_id, column)?
            .unwrap_or_default();
        let update = crate::crdt::delete_text(&current, name, index, len)?;
        self.crdt_push_update(table, row_id, column, &update)
    }

    /// §5.10.4 generic escape hatch: apply an arbitrary Yjs update onto a
    /// `crdt` column's current state and push the resulting full state. The
    /// app authored the update with its own `yrs` model. Returns the enqueued
    /// `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_apply_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        update: &[u8],
    ) -> Result<String, String> {
        let current = self
            .crdt_column_bytes(table, row_id, column)?
            .unwrap_or_default();
        let next = crate::crdt::apply_update(&current, update)?;
        self.crdt_push_update(table, row_id, column, &next)
    }

    /// Shared tail of the crdt edit methods: build the full-row upsert that
    /// carries the new crdt bytes and enqueue it. The row's other columns are
    /// preserved from the current visible row (so a crdt edit does not clobber
    /// the LWW columns); a brand-new row is seeded with just the primary key +
    /// crdt column. Pushed baseVersion-less (§5.10.3 crdt-only-divergence rule).
    #[cfg(feature = "crdt-yjs")]
    fn crdt_push_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        crdt_bytes: &[u8],
    ) -> Result<String, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?
            .clone();
        // The current visible row's values (preserving LWW columns), or a
        // fresh row keyed by row_id if it does not exist yet.
        let mut values: Map<String, Value> = self
            .read_rows(table)?
            .into_iter()
            .find(|r| r.row_id == row_id)
            .map(|r| r.values)
            .unwrap_or_else(|| {
                let mut map = Map::new();
                map.insert(
                    schema_table.primary_key.clone(),
                    Value::from(row_id.to_owned()),
                );
                map
            });
        // Replace the crdt column with the new bytes in the driver envelope.
        let mut bytes_obj = Map::new();
        bytes_obj.insert("$bytes".to_owned(), Value::from(bytes_to_hex(crdt_bytes)));
        values.insert(column.to_owned(), Value::Object(bytes_obj));
        self.mutate(vec![Mutation::Upsert {
            table: table.to_owned(),
            values,
            base_version: None,
        }])
    }

    /// Run an arbitrary read-only SQL query against the local database and
    /// return each row as a `column-name → JSON value` map. This is the seam
    /// the React `useSyncQuery` live-query API needs (it takes app-authored
    /// SQL over the visible tables/views, not a fixed table read like
    /// [`read_rows`]).
    ///
    /// Bound `params` are the driver value forms: JSON strings/numbers/bools/
    /// null bind directly; a `{"$bytes": hex}` object binds as a BLOB — the
    /// same envelope the command surface uses everywhere else. Output BLOB
    /// columns come back as `{"$bytes": hex}` to round-trip cleanly.
    ///
    /// The result column typing is dynamic (SQLite's stored affinity), because
    /// arbitrary SQL can alias, join, and compute — there is no schema column
    /// to consult per output cell, unlike [`read_rows`].
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
        query_connection(&self.conn, sql, params)
    }

    /// Rows, coverage, and local revision from one SQLite read snapshot.
    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[Value],
        coverage: &[WindowCoverage],
    ) -> Result<QuerySnapshot, String> {
        snapshot_connection(&self.conn, sql, params, coverage)
    }

    // -- request building ---------------------------------------------------------

    fn build_request(&self, url_capable: bool) -> (Message, RequestMeta) {
        let mut frames = vec![Frame::ReqHeader {
            client_id: self.client_id.clone(),
            schema_version: self.schema.version,
        }];
        let mut pushed_ids = Vec::new();
        let mut ops_in_request = 0usize;
        let mut deferred_commits = 0usize;
        for (index, commit) in self.outbox.iter().enumerate() {
            // §6.1 splitBatch: stop at the operation cap — commits apply in
            // order, so everything from the first non-fitting commit on is
            // deferred to the next round. A single over-cap commit still goes
            // alone (commits are atomic and cannot be split).
            if ops_in_request > 0 && ops_in_request + commit.ops.len() > PUSH_OPS_PER_REQUEST {
                deferred_commits = self.outbox.len() - index;
                break;
            }
            ops_in_request += commit.ops.len();
            let operations = commit
                .ops
                .iter()
                .map(|op| {
                    let payload = op.values.as_ref().and_then(|values| {
                        let table = self.schema.table(&op.table)?;
                        // §0: outbox entries encode at send time with the
                        // current codec (validated at mutate()). §5.11:
                        // encrypted columns are encrypted here.
                        encode_row_json(table, &op.row_id, values, &self.encryption).ok()
                    });
                    ssp2::model::Operation {
                        table: op.table.clone(),
                        row_id: op.row_id.clone(),
                        op: if op.upsert { Op::Upsert } else { Op::Delete },
                        base_version: op.base_version,
                        payload,
                    }
                })
                .collect();
            frames.push(Frame::PushCommit {
                client_commit_id: commit.client_commit_id.clone(),
                operations,
            });
            pushed_ids.push(commit.client_commit_id.clone());
        }
        // §4.2/§5.4: bit 3 is advertised iff the transport can fetch a
        // bare URL — capability negotiation, decided per transport.
        let accept = self.limits.accept.unwrap_or(if url_capable {
            DEFAULT_ACCEPT | ACCEPT_SIGNED_URLS
        } else {
            DEFAULT_ACCEPT
        });
        frames.push(Frame::PullHeader {
            limit_commits: self.limits.limit_commits.unwrap_or(0),
            limit_snapshot_rows: self.limits.limit_snapshot_rows.unwrap_or(0),
            max_snapshot_pages: self.limits.max_snapshot_pages.unwrap_or(0),
            accept,
        });
        let mut fresh = Vec::new();
        for sub in &self.subs {
            if sub.state != SubState::Active {
                continue;
            }
            let mut scopes = sub.requested.clone();
            sort_scope_map(&mut scopes);
            frames.push(Frame::Subscription {
                id: sub.id.clone(),
                table: sub.table.clone(),
                scopes,
                params: sub.params.clone().map(RawJson),
                cursor: sub.cursor,
                bootstrap_state: sub.bootstrap_state.clone().map(RawJson),
            });
            fresh.push((
                sub.id.clone(),
                sub.cursor < 0 && sub.bootstrap_state.is_none(),
            ));
        }
        let message = Message {
            msg_kind: MsgKind::Request,
            frames,
        };
        (
            message,
            RequestMeta {
                pushed_ids,
                fresh,
                accept,
                deferred_commits,
            },
        )
    }

    // -- sync -------------------------------------------------------------------

    pub fn sync(&mut self, transport: &mut dyn Transport) -> SyncOutcome {
        if self.stopped {
            // §1.6: the client stopped at the schema floor; syncing is inert
            // until an upgrade. The outbox is preserved for replay.
            return SyncOutcome::Ok(SyncReport {
                schema_floor: self.schema_floor.clone(),
                ..SyncReport::default()
            });
        }
        // §8.4: the coalesced sync-needed signal clears when a pull round
        // BEGINS, so a wake-up landing mid-round survives it.
        self.set_sync_needed(false, false);
        // §5.9.7 B4: upload pending blobs before pushing the referencing
        // rows, so the server-side existence check (§6.6) passes.
        if self.schema_has_blobs() {
            if let Err(TransportError { code, message }) = self.flush_blob_uploads(transport) {
                if Self::retryable_transport_code(&code) {
                    self.schedule_background_retry();
                }
                return SyncOutcome::Failed {
                    error_code: code,
                    message,
                };
            }
        }
        let (message, meta) = self.build_request(transport.supports_url_fetch());
        let request_bytes = encode_message(&message);
        // §8.7: rounds ride the socket whenever it is connected (one
        // loop, no fallback pair); the transport seam stays bytes-in /
        // bytes-out either way. Registration-at-round-end is server-side.
        let round = if self.realtime_connected {
            transport.realtime_sync(&request_bytes)
        } else {
            transport.sync(&request_bytes)
        };
        let response_bytes = match round {
            Ok(bytes) => bytes,
            Err(TransportError { code, message }) => {
                // §7.3.5: a request-level lease code stops-and-surfaces —
                // record it in leaseState (no local-data purge, §7.3.4).
                self.record_lease_error(&code);
                if Self::retryable_transport_code(&code) {
                    self.schedule_background_retry();
                }
                return SyncOutcome::Failed {
                    error_code: code,
                    message,
                };
            }
        };
        let response = match decode_message(&response_bytes) {
            Ok(message) => message,
            Err(error) => {
                // §1.2 rule 1 / §1.4 rule 5: truncated or malformed
                // responses abort without persisting anything.
                return SyncOutcome::Failed {
                    error_code: error.code.as_str().to_owned(),
                    message: error.detail,
                };
            }
        };
        if response.msg_kind != MsgKind::Response {
            return SyncOutcome::Failed {
                error_code: "sync.invalid_request".to_owned(),
                message: "expected a response message".to_owned(),
            };
        }
        let outcome = self.process_response(transport, response, &meta);
        match &outcome {
            SyncOutcome::Ok(_) => self.reset_background_retry(),
            SyncOutcome::Failed { error_code, .. }
                if Self::retryable_transport_code(error_code) =>
            {
                self.schedule_background_retry();
            }
            SyncOutcome::Failed { .. } => {}
        }
        if meta.deferred_commits > 0 {
            // §6.1 splitBatch: commits past the operation cap wait for the
            // next round — keep the host's sync signal raised until then.
            self.set_sync_needed(true, true);
        }
        outcome
    }

    pub fn sync_until_idle(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
    ) -> SyncOutcome {
        let rounds = max_rounds.unwrap_or(12).max(1);
        let mut aggregate = SyncReport::default();
        for _ in 0..rounds {
            match self.sync(transport) {
                SyncOutcome::Failed {
                    error_code,
                    message,
                } => {
                    return SyncOutcome::Failed {
                        error_code,
                        message,
                    };
                }
                SyncOutcome::Ok(report) => {
                    aggregate.pushed += report.pushed;
                    aggregate.applied.extend(report.applied.iter().cloned());
                    aggregate.rejected.extend(report.rejected.iter().cloned());
                    aggregate.retryable.extend(report.retryable.iter().cloned());
                    aggregate.conflicts += report.conflicts;
                    aggregate.commits_applied += report.commits_applied;
                    aggregate.segment_rows_applied += report.segment_rows_applied;
                    aggregate.bootstrapping = report.bootstrapping.clone();
                    aggregate.resets.extend(report.resets.iter().cloned());
                    aggregate.revoked.extend(report.revoked.iter().cloned());
                    aggregate.failed.extend(report.failed.iter().cloned());
                    if report.schema_floor.is_some() {
                        aggregate.schema_floor = report.schema_floor.clone();
                    }
                    // §4.5: pull again whenever the response contained
                    // commits or segments; resets re-bootstrap; a pending
                    // resume token continues paging (§4.7); a raised
                    // sync-needed signal covers §6.1 splitBatch remainders
                    // (deferred outbox commits push on the next round).
                    let more = !report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty()
                        || self.sync_needed;
                    if !more {
                        break;
                    }
                }
            }
        }
        SyncOutcome::Ok(aggregate)
    }

    fn process_response(
        &mut self,
        transport: &mut dyn Transport,
        response: Message,
        meta: &RequestMeta,
    ) -> SyncOutcome {
        let mut report = SyncReport {
            pushed: meta.pushed_ids.len() as u32,
            ..SyncReport::default()
        };
        let mut rejection_details_by_commit: HashMap<String, BTreeMap<i32, RejectionDetails>> =
            HashMap::new();
        for frame in &response.frames {
            if let Frame::PushResultDetails {
                client_commit_id,
                entries,
            } = frame
            {
                let details = rejection_details_by_commit
                    .entry(client_commit_id.clone())
                    .or_default();
                for entry in entries {
                    let parsed = match RejectionDetails::parse(&entry.details.0) {
                        Ok(value) => value,
                        Err(message) => {
                            return SyncOutcome::Failed {
                                error_code: "sync.invalid_request".to_owned(),
                                message,
                            };
                        }
                    };
                    details.insert(entry.op_index, parsed);
                }
            }
        }
        let mut frames = response.frames.into_iter();
        match frames.next() {
            Some(Frame::RespHeader {
                required_schema_version,
                latest_schema_version,
            }) => {
                if let Some(required) = required_schema_version {
                    // §1.6 schema-floor response: nothing else is processed;
                    // stop syncing and surface the upgrade requirement.
                    let floor = SchemaFloor {
                        required_schema_version: Some(required),
                        latest_schema_version,
                    };
                    self.set_schema_floor(Some(floor.clone()));
                    report.schema_floor = Some(floor);
                    return SyncOutcome::Ok(report);
                }
            }
            _ => {
                return SyncOutcome::Failed {
                    error_code: "sync.invalid_request".to_owned(),
                    message: "response does not start with RESP_HEADER".to_owned(),
                };
            }
        }

        let mut failure: Option<(String, String)> = None;
        while let Some(frame) = frames.next() {
            match frame {
                Frame::PushResult {
                    client_commit_id,
                    status,
                    commit_seq: _,
                    results,
                } => {
                    self.handle_push_result(
                        &client_commit_id,
                        status,
                        &results,
                        rejection_details_by_commit.get(&client_commit_id),
                        &mut report,
                    );
                }
                Frame::PushResultDetails { .. } => {}
                Frame::SubStart {
                    id,
                    status,
                    reason_code,
                    effective_scopes,
                    bootstrap: _,
                } => {
                    let mut body = Vec::new();
                    let mut sub_end: Option<(i64, Option<String>)> = None;
                    for inner in frames.by_ref() {
                        match inner {
                            Frame::SubEnd {
                                next_cursor,
                                bootstrap_state,
                            } => {
                                sub_end = Some((next_cursor, bootstrap_state.map(|r| r.0)));
                                break;
                            }
                            Frame::Unknown { .. } => {}
                            other => body.push(other),
                        }
                    }
                    let Some((next_cursor, bootstrap_state)) = sub_end else {
                        failure = Some((
                            "sync.invalid_request".to_owned(),
                            "subscription section without SUB_END".to_owned(),
                        ));
                        break;
                    };
                    if let Err(SectionError::Abort(code, message)) = self.process_section(
                        transport,
                        &id,
                        status,
                        &reason_code,
                        effective_scopes,
                        body,
                        next_cursor,
                        bootstrap_state,
                        meta,
                        &mut report,
                    ) {
                        failure = Some((code, message));
                        break;
                    }
                }
                Frame::Lease {
                    lease_id,
                    expires_at_ms,
                } => {
                    // §7.3.5: persist the opaque lease; a fresh lease clears
                    // any prior lease error (the outage/revocation is over).
                    self.set_lease_state(Some(LeaseState {
                        lease_id: Some(lease_id),
                        expires_at_ms: Some(expires_at_ms),
                        error_code: None,
                    }));
                }
                Frame::Error { code, message, .. } => {
                    // §1.6: the whole request failed; already-completed
                    // subscriptions keep their applied data and cursors.
                    failure = Some((code, message));
                    break;
                }
                Frame::Unknown { .. } => {}
                _ => {
                    failure = Some((
                        "sync.invalid_request".to_owned(),
                        "unexpected frame in response".to_owned(),
                    ));
                    break;
                }
            }
        }

        // §7.1: reconciliation is outbox replay on top — whenever server
        // data has been applied, including a round that aborted mid-way.
        if self.overlay_dirty.get() {
            self.rebuild_overlay();
        }
        // §5.9.7 B1: refcounts follow the final visible rows at every response
        // boundary. Push-result handling can rebuild the overlay (and clear
        // `overlay_dirty`) before this point, so gating reconciliation on that
        // flag can leave a newly referenced body at refcount zero and make it
        // eligible for LRU eviction. The TypeScript core has the same
        // unconditional response-boundary reconciliation.
        self.reconcile_blob_refcounts(false);

        if let Some((error_code, message)) = failure {
            return SyncOutcome::Failed {
                error_code,
                message,
            };
        }
        // §4.8 E1: the push half may have drained commits that pinned rows of
        // a shrunk window unit — retry any deferred evictions now.
        self.drain_pending_evictions();
        self.ack_after_pull(transport);
        // §7.4.5: the reset is over once the first post-reset pull round
        // leaves no subscription mid-bootstrap — the tables are rebuilt.
        if self.upgrading && report.bootstrapping.is_empty() {
            self.set_upgrading(false);
        }
        SyncOutcome::Ok(report)
    }

    // -- push results (§6.3, §7.2) ------------------------------------------------

    fn handle_push_result(
        &mut self,
        client_commit_id: &str,
        status: PushStatus,
        results: &[OpResult],
        rejection_details: Option<&BTreeMap<i32, RejectionDetails>>,
        report: &mut SyncReport,
    ) {
        let Some(index) = self
            .outbox
            .iter()
            .position(|c| c.client_commit_id == client_commit_id)
        else {
            return;
        };
        if self.begin_observation("syncular_push_result").is_err() {
            return;
        }
        let mut batch = ChangeAccumulator::default();
        let operations = self.outbox[index].ops.clone();
        match status {
            PushStatus::Applied | PushStatus::Cached => {
                // §7.2: a lost ack replays as `cached` — proceed as if the
                // ack had arrived.
                let journal_results = results
                    .iter()
                    .map(|result| {
                        let op_index = match result {
                            OpResult::Applied { op_index }
                            | OpResult::Conflict { op_index, .. }
                            | OpResult::Error { op_index, .. } => *op_index,
                        };
                        CommitOperationOutcome::Applied { op_index }
                    })
                    .collect::<Vec<_>>();
                let outcome_status = if status == PushStatus::Applied {
                    CommitOutcomeStatus::Applied
                } else {
                    CommitOutcomeStatus::Cached
                };
                if self
                    .persist_commit_outcome(
                        client_commit_id,
                        outcome_status,
                        &journal_results,
                        None,
                    )
                    .and_then(|()| self.delete_outbox_persisted(client_commit_id))
                    .and_then(|()| self.prune_commit_outcomes())
                    .is_err()
                {
                    self.rollback_observation("syncular_push_result");
                    return;
                }
                report.applied.push(client_commit_id.to_owned());
                self.outbox.remove(index);
                self.overlay_dirty.set(true);
                batch.status = true;
                batch.outcomes = true;
            }
            PushStatus::Rejected => {
                if results.iter().any(|result| {
                    matches!(
                        result,
                        OpResult::Error {
                            code,
                            retryable: true,
                            ..
                        } if code == "sync.idempotency_cache_miss"
                    )
                }) {
                    // §6.3/§7.2: a serving failure, not an outcome — keep the
                    // exact commit queued for an identical retry.
                    report.retryable.push(client_commit_id.to_owned());
                    if self
                        .finish_observation("syncular_push_result", batch)
                        .is_err()
                    {
                        self.rollback_observation("syncular_push_result");
                    }
                    return;
                }

                let mut journal_results = Vec::with_capacity(results.len());
                let mut conflicts = Vec::new();
                let mut rejections = Vec::new();
                for result in results {
                    match result {
                        OpResult::Applied { op_index } => {
                            journal_results.push(CommitOperationOutcome::Applied {
                                op_index: *op_index,
                            });
                        }
                        OpResult::Conflict {
                            op_index,
                            code,
                            message,
                            server_version,
                            server_row,
                        } => {
                            let operation = operations
                                .get(*op_index as usize)
                                .map(CommitOperation::from);
                            let (table, row_id) = operation
                                .as_ref()
                                .map(|op| (op.table.clone(), op.row_id.clone()))
                                .unwrap_or_default();
                            let server_row_json = self
                                .schema
                                .table(&table)
                                .and_then(|t| {
                                    decode_row_bytes(t, server_row, &self.encryption)
                                        .ok()
                                        .map(|row| (t, row))
                                })
                                .map(|(t, row)| {
                                    let mut map = Map::new();
                                    for (i, column) in t.columns.iter().enumerate() {
                                        map.insert(
                                            column.name.clone(),
                                            column_value_to_json(row.get(i).unwrap_or(&None)),
                                        );
                                    }
                                    map
                                })
                                .unwrap_or_default();
                            let conflict = ConflictRecord {
                                client_commit_id: client_commit_id.to_owned(),
                                op_index: *op_index,
                                table,
                                row_id,
                                code: code.clone(),
                                message: message.clone(),
                                server_version: *server_version,
                                server_row: server_row_json,
                                operation,
                            };
                            journal_results.push(CommitOperationOutcome::Conflict {
                                conflict: conflict.clone(),
                            });
                            conflicts.push(conflict);
                        }
                        OpResult::Error {
                            op_index,
                            code,
                            message,
                            retryable,
                        } => {
                            let rejection = RejectionRecord {
                                client_commit_id: client_commit_id.to_owned(),
                                op_index: *op_index,
                                code: code.clone(),
                                message: message.clone(),
                                retryable: *retryable,
                                details: rejection_details
                                    .and_then(|details| details.get(op_index))
                                    .cloned(),
                                operation: operations
                                    .get(*op_index as usize)
                                    .map(CommitOperation::from),
                            };
                            journal_results.push(CommitOperationOutcome::Error {
                                rejection: rejection.clone(),
                            });
                            rejections.push(rejection);
                        }
                    }
                }
                let outcome_status = if conflicts.is_empty() {
                    CommitOutcomeStatus::Rejected
                } else {
                    CommitOutcomeStatus::Conflict
                };
                if self
                    .persist_commit_outcome(
                        client_commit_id,
                        outcome_status,
                        &journal_results,
                        Some(&operations),
                    )
                    .and_then(|()| self.delete_outbox_persisted(client_commit_id))
                    .and_then(|()| self.prune_commit_outcomes())
                    .is_err()
                {
                    self.rollback_observation("syncular_push_result");
                    return;
                }
                report.conflicts += conflicts.len() as u32;
                report.rejected.push(client_commit_id.to_owned());
                batch.conflicts = !conflicts.is_empty();
                batch.rejections = !rejections.is_empty();
                batch.status = true;
                batch.outcomes = true;
                self.conflicts.extend(conflicts);
                self.rejections.extend(rejections);
                self.outbox.remove(index);
                self.overlay_dirty.set(true);
            }
        }
        if batch.status {
            for operation in &operations {
                if !self.record_row_scopes(&mut batch, &operation.table, &operation.row_id, false) {
                    batch.table(&operation.table);
                }
            }
            self.rebuild_overlay_if_dirty();
        }
        if self
            .finish_observation("syncular_push_result", batch)
            .is_err()
        {
            self.rollback_observation("syncular_push_result");
        }
    }

    // -- subscription sections ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn process_section(
        &mut self,
        transport: &mut dyn Transport,
        id: &str,
        status: SubStatus,
        reason_code: &str,
        effective_scopes: Vec<(String, Vec<String>)>,
        body: Vec<Frame>,
        next_cursor: i64,
        bootstrap_state: Option<String>,
        meta: &RequestMeta,
        report: &mut SyncReport,
    ) -> Result<(), SectionError> {
        let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
            return Ok(()); // unknown echo: ignore
        };
        match status {
            SubStatus::Revoked => {
                self.begin_observation("syncular_revocation")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let mut batch = ChangeAccumulator::default();
                let registered = self.window_unit_by_sub_id(id);
                // §3.3: stop pulling, purge exactly the last effective grant.
                let (table, effective) = {
                    let sub = &self.subs[sub_index];
                    (sub.table.clone(), sub.effective.clone().unwrap_or_default())
                };
                let purged = self.purge_scope_rows(&table, &effective);
                match purged {
                    Ok(()) => {
                        self.record_scope_map(&mut batch, &table, &effective);
                        let sub = &mut self.subs[sub_index];
                        sub.state = SubState::Revoked;
                        sub.reason_code = Some(if reason_code.is_empty() {
                            "sync.scope_revoked".to_owned()
                        } else {
                            reason_code.to_owned()
                        });
                        report.revoked.push(id.to_owned());
                        let doomed_effective = effective;
                        let sub_table = table;
                        self.persist_sub(&self.subs[sub_index].clone());
                        let dropped = self
                            .drop_doomed_outbox(&sub_table, &doomed_effective)
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".to_owned(), message)
                            })?;
                        if dropped {
                            batch.status = true;
                            batch.rejections = true;
                            batch.outcomes = true;
                        }
                        // §5.9.7 B2: revocation deletes now-unauthorized blob
                        // bodies (evicted ≠ revoked).
                        self.reconcile_blob_refcounts(true);
                    }
                    Err(()) => {
                        // §3.3 fail closed: no local mapping — never clear by
                        // approximation; fatal configuration error.
                        let sub = &mut self.subs[sub_index];
                        sub.state = SubState::Failed;
                        sub.reason_code = Some("sync.scope_revoked".to_owned());
                        report.failed.push(id.to_owned());
                        self.persist_sub(&self.subs[sub_index].clone());
                    }
                }
                if let Some((base_key, unit)) = registered {
                    batch.window(&base_key, &self.subs[sub_index].table, &unit);
                }
                self.rebuild_overlay_if_dirty();
                self.finish_observation("syncular_revocation", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                Ok(())
            }
            SubStatus::Reset => {
                self.begin_observation("syncular_reset")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let mut batch = ChangeAccumulator::default();
                let registered = self.window_unit_by_sub_id(id);
                // §4.6: discard cursor + bootstrap state, keep local rows —
                // reset is a staleness signal, not a purge signal.
                let sub = &mut self.subs[sub_index];
                sub.cursor = -1;
                sub.bootstrap_state = None;
                report.resets.push(id.to_owned());
                self.persist_sub(&self.subs[sub_index].clone());
                if let Some((base_key, unit)) = registered {
                    batch.window(&base_key, &self.subs[sub_index].table, &unit);
                }
                self.finish_observation("syncular_reset", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                Ok(())
            }
            SubStatus::Active => {
                let fresh = meta
                    .fresh
                    .iter()
                    .find(|(fid, _)| fid == id)
                    .map(|(_, f)| *f)
                    .unwrap_or(false);
                let was_pending = self.subs[sub_index].cursor < 0
                    || self.subs[sub_index].bootstrap_state.is_some();
                let registered = self.window_unit_by_sub_id(id);
                // §3.3: each active echo replaces the persisted copy.
                self.subs[sub_index].effective = Some(effective_scopes);
                self.begin_observation("syncular_section")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let mut batch = ChangeAccumulator::default();
                let outcome = self.apply_section_body(
                    transport, sub_index, body, fresh, meta, report, &mut batch,
                );
                match outcome {
                    Ok(()) => {
                        let sub = &mut self.subs[sub_index];
                        // §1.4: durable cursor/resume state persists only at
                        // SUB_END.
                        sub.cursor = next_cursor;
                        sub.bootstrap_state = bootstrap_state;
                        sub.synced_once = true;
                        if sub.bootstrap_state.is_some() {
                            report.bootstrapping.push(id.to_owned());
                        }
                        let completed =
                            was_pending && sub.cursor >= 0 && sub.bootstrap_state.is_none();
                        self.persist_sub(&self.subs[sub_index].clone());
                        if completed {
                            if let Some((base_key, unit)) = registered.clone() {
                                batch.window(&base_key, &self.subs[sub_index].table, &unit);
                            }
                        }
                        self.rebuild_overlay_if_dirty();
                        self.finish_observation("syncular_section", batch)
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".to_owned(), message)
                            })?;
                        Ok(())
                    }
                    Err(SectionError::FailClosed) => {
                        // §5.6: subscription-local; the rest of the response
                        // still applies. SUB_END values are NOT persisted.
                        self.rollback_observation("syncular_section");
                        self.begin_observation("syncular_section_failure")
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".to_owned(), message)
                            })?;
                        let mut failure_batch = ChangeAccumulator::default();
                        let sub = &mut self.subs[sub_index];
                        sub.state = SubState::Failed;
                        sub.reason_code = Some("sync.scope_revoked".to_owned());
                        report.failed.push(id.to_owned());
                        self.persist_sub(&self.subs[sub_index].clone());
                        if let Some((base_key, unit)) = registered {
                            failure_batch.window(&base_key, &self.subs[sub_index].table, &unit);
                        }
                        self.finish_observation("syncular_section_failure", failure_batch)
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".to_owned(), message)
                            })?;
                        Ok(())
                    }
                    Err(SectionError::Abort(code, message)) => {
                        // §1.4 rule 5: roll back the open subscription; do
                        // not persist its SUB_END values.
                        self.rollback_observation("syncular_section");
                        Err(SectionError::Abort(code, message))
                    }
                }
            }
        }
    }

    // The section context and its transaction-owned change accumulator are
    // deliberately explicit here: folding either into shared mutable state
    // would weaken the atomic observation boundary.
    #[allow(clippy::too_many_arguments)]
    fn apply_section_body(
        &mut self,
        transport: &mut dyn Transport,
        sub_index: usize,
        body: Vec<Frame>,
        fresh: bool,
        meta: &RequestMeta,
        report: &mut SyncReport,
        batch: &mut ChangeAccumulator,
    ) -> Result<(), SectionError> {
        let mut saw_segment = false;
        for frame in body {
            match frame {
                Frame::Commit {
                    tables, changes, ..
                } => {
                    self.record_commit_changes(batch, &tables, &changes);
                    self.apply_commit_changes(&tables, &changes)
                        .map_err(|(c, m)| SectionError::Abort(c, m))?;
                    report.commits_applied += 1;
                }
                Frame::SegmentInline { payload } => {
                    let segment = decode_rows_segment(&payload)
                        .map_err(|e| SectionError::Abort(e.code.as_str().to_owned(), e.detail))?;
                    let first = !saw_segment;
                    saw_segment = true;
                    let effective = self.subs[sub_index].effective.clone().unwrap_or_default();
                    let cleared =
                        fresh && first && self.scoped_rows_exist(&segment.table, &effective);
                    let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                    if applied > 0 || cleared {
                        batch.table(&segment.table);
                    }
                    report.segment_rows_applied += applied;
                }
                Frame::SegmentRef {
                    segment_id,
                    media_type,
                    table,
                    row_count,
                    as_of_commit_seq,
                    scope_digest,
                    row_cursor,
                    next_row_cursor,
                    url,
                    url_expires_at_ms,
                    ..
                } => {
                    // §4.2: reject a descriptor whose mediaType was not
                    // advertised — never skip or guess.
                    let advertised = match media_type {
                        MediaType::Rows => {
                            meta.accept & ACCEPT_EXTERNAL_ROWS != 0
                                || meta.accept & ACCEPT_INLINE_ROWS != 0
                        }
                        MediaType::Sqlite => meta.accept & ACCEPT_SQLITE != 0,
                    };
                    if !advertised {
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            format!(
                                "SEGMENT_REF mediaType {} was not advertised in accept (§4.2)",
                                media_type.name()
                            ),
                        ));
                    }
                    let bytes = if let Some(url) = url {
                        // §5.4: a url-carrying descriptor MUST be fetched
                        // from that URL; failure invalidates the whole
                        // descriptor (no fall-through to §5.5 — re-pull
                        // recovers, §1.4 rule 5).
                        if meta.accept & ACCEPT_SIGNED_URLS == 0 {
                            return Err(SectionError::Abort(
                                "sync.invalid_request".to_owned(),
                                "SEGMENT_REF carries a url but accept bit 3 was not advertised (§5.4)"
                                    .to_owned(),
                            ));
                        }
                        // §5.4: MUST NOT start a fetch at/past expiry.
                        if url_expires_at_ms.is_some_and(|exp| exp <= self.clock_now_ms()) {
                            return Err(SectionError::Abort(
                                "sync.segment_expired".to_owned(),
                                format!(
                                    "signed URL for segment {segment_id} expired before fetch — re-pull mints fresh descriptors (§5.4)"
                                ),
                            ));
                        }
                        transport
                            .fetch_url(&url)
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    } else {
                        let requested_scopes_json =
                            canonical_scope_json(&self.subs[sub_index].requested);
                        transport
                            .download_segment(&SegmentRequest {
                                segment_id: segment_id.clone(),
                                table,
                                requested_scopes_json,
                            })
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    };
                    // §5.1: verify the content address before applying.
                    let digest = Sha256::digest(&bytes);
                    let expected = segment_id
                        .strip_prefix("sha256:")
                        .unwrap_or(segment_id.as_str());
                    if bytes_to_hex(&digest) != expected {
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "segment bytes do not match the content address (§5.1)".to_owned(),
                        ));
                    }
                    if media_type == MediaType::Sqlite {
                        // §5.3: images are whole-table — a paged sqlite
                        // descriptor is invalid.
                        if row_cursor.is_some() || next_row_cursor.is_some() {
                            return Err(SectionError::Abort(
                                "sync.invalid_request".to_owned(),
                                "sqlite segments are whole-table: rowCursor/nextRowCursor must be absent (§5.3)"
                                    .to_owned(),
                            ));
                        }
                        let first = !saw_segment;
                        saw_segment = true;
                        let sub_table = self.subs[sub_index].table.clone();
                        let effective = self.subs[sub_index].effective.clone().unwrap_or_default();
                        let cleared =
                            fresh && first && self.scoped_rows_exist(&sub_table, &effective);
                        let applied = self.apply_sqlite_segment(
                            sub_index,
                            &bytes,
                            fresh && first,
                            row_count,
                            as_of_commit_seq,
                            &scope_digest,
                        )?;
                        if applied > 0 || cleared {
                            batch.table(&sub_table);
                        }
                        report.segment_rows_applied += applied;
                    } else {
                        let segment = decode_rows_segment(&bytes).map_err(|e| {
                            SectionError::Abort(e.code.as_str().to_owned(), e.detail)
                        })?;
                        let first = row_cursor.is_none();
                        saw_segment = true;
                        let effective = self.subs[sub_index].effective.clone().unwrap_or_default();
                        let cleared =
                            fresh && first && self.scoped_rows_exist(&segment.table, &effective);
                        let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                        if applied > 0 || cleared {
                            batch.table(&segment.table);
                        }
                        report.segment_rows_applied += applied;
                    }
                }
                Frame::Unknown { .. } => {}
                _ => {
                    return Err(SectionError::Abort(
                        "sync.invalid_request".to_owned(),
                        "unexpected frame inside a subscription section".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn apply_commit_changes(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) -> Result<(), (String, String)> {
        for change in changes {
            let table_name = tables.get(change.table_index as usize).ok_or_else(|| {
                (
                    "sync.invalid_request".to_owned(),
                    "change tableIndex out of range".to_owned(),
                )
            })?;
            let table = self.schema.table(table_name).ok_or_else(|| {
                (
                    "sync.schema_mismatch".to_owned(),
                    format!("change targets unknown table {table_name:?}"),
                )
            })?;
            match change.op {
                Op::Upsert => {
                    let payload = change.row.as_ref().ok_or_else(|| {
                        (
                            "sync.invalid_request".to_owned(),
                            "upsert change without row payload".to_owned(),
                        )
                    })?;
                    // §5.11: decrypt encrypted columns on apply.
                    let row = decode_row_bytes(table, payload, &self.encryption)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    let version = change.row_version.unwrap_or(0);
                    let table_name = table.name.clone();
                    self.write_base_row(&table_name, &row, version)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                }
                Op::Delete => {
                    self.delete_base_row(table_name, &change.row_id)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                }
            }
        }
        Ok(())
    }

    /// §5.6 segment application: validate against the generated schema,
    /// clear the grant on a fresh bootstrap's first page (fail closed
    /// without a mapping), then replace-or-upsert each row with its
    /// segment-carried server version (§5.2).
    fn apply_segment(
        &mut self,
        sub_index: usize,
        segment: &RowsSegment,
        first_fresh_page: bool,
    ) -> Result<u32, SectionError> {
        let (sub_table, effective) = {
            let sub = &self.subs[sub_index];
            (sub.table.clone(), sub.effective.clone().unwrap_or_default())
        };
        let table = self.schema.table(&sub_table).cloned().ok_or_else(|| {
            SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                format!("subscription table {sub_table:?} is not in the client schema"),
            )
        })?;
        // §5.2: the column table validates against the generated schema —
        // order, names, types, nullability; mismatch is fatal. §5.11: the
        // server sends the WIRE types (bytes for an encrypted column), so
        // validate against wire_columns.
        let matches = segment.table == table.name
            && segment.schema_version == self.schema.version
            && segment.columns.len() == table.wire_columns.len()
            && segment
                .columns
                .iter()
                .zip(table.wire_columns.iter())
                .all(|(a, b)| a.name == b.name && a.ty == b.ty && a.nullable == b.nullable);
        if !matches {
            return Err(SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                "segment column table does not match the generated schema (§5.2)".to_owned(),
            ));
        }
        if first_fresh_page {
            // §5.6: delete local rows for the subscription's scope so
            // removed rows don't survive re-bootstrap; fail closed at the
            // clear too.
            self.purge_scope_rows(&table.name, &effective)
                .map_err(|()| SectionError::FailClosed)?;
        }
        let mut applied = 0u32;
        for block in &segment.blocks {
            for row in block {
                // §5.11: a bootstrap segment carries ciphertext for encrypted
                // columns; decrypt to plaintext before the local write. A
                // plaintext table writes the decoded row directly (no per-row
                // clone on the hot bootstrap path).
                let decrypted;
                let values = if table.has_encrypted_columns() {
                    let mut values = row.values.clone();
                    crate::values::decrypt_segment_row(&table, &mut values, &self.encryption)
                        .map_err(|m| SectionError::Abort("client.decrypt_failed".to_owned(), m))?;
                    decrypted = values;
                    &decrypted
                } else {
                    &row.values
                };
                // §5.6: the row record's serverVersion is the row's
                // last-known server_version, same as a COMMIT rowVersion.
                self.write_base_row(&table.name, values, row.server_version)
                    .map_err(|m| SectionError::Abort("sync.invalid_request".to_owned(), m))?;
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// §5.3 sqlite-image application: validate the in-file metadata
    /// against the descriptor, validate column names/order against the
    /// generated schema, run the §5.6 first-page clear when fresh, then
    /// replace-or-upsert every image row with its `_syncular_version`.
    /// Mechanics: the image lands in a temp file read through a second
    /// rusqlite connection (semantics identical to ATTACH + INSERT…SELECT;
    /// ATTACH is unavailable inside the open section savepoint).
    fn apply_sqlite_segment(
        &mut self,
        sub_index: usize,
        bytes: &[u8],
        first_fresh_page: bool,
        row_count: i64,
        as_of_commit_seq: i64,
        scope_digest: &str,
    ) -> Result<u32, SectionError> {
        let invalid = |detail: &str| {
            SectionError::Abort(
                "sync.invalid_request".to_owned(),
                format!("sqlite segment rejected: {detail} (§5.3)"),
            )
        };
        let (sub_table, effective) = {
            let sub = &self.subs[sub_index];
            (sub.table.clone(), sub.effective.clone().unwrap_or_default())
        };
        let table = self.schema.table(&sub_table).cloned().ok_or_else(|| {
            SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                format!("subscription table {sub_table:?} is not in the client schema"),
            )
        })?;

        let path = std::env::temp_dir().join(format!("syncular-image-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|_| invalid("image temp file write failed"))?;
        let img = match rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            Ok(conn) => conn,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                return Err(invalid("bytes do not open as a SQLite database"));
            }
        };
        let outcome = self.apply_sqlite_image(
            &img,
            &table,
            first_fresh_page,
            &effective,
            row_count,
            as_of_commit_seq,
            scope_digest,
        );
        drop(img);
        let _ = std::fs::remove_file(&path);
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_sqlite_image(
        &mut self,
        img: &rusqlite::Connection,
        table: &crate::schema::TableSchema,
        first_fresh_page: bool,
        effective: &[(String, Vec<String>)],
        row_count: i64,
        as_of_commit_seq: i64,
        scope_digest: &str,
    ) -> Result<u32, SectionError> {
        let invalid = |detail: String| {
            SectionError::Abort(
                "sync.invalid_request".to_owned(),
                format!("sqlite segment rejected: {detail} (§5.3)"),
            )
        };

        // 1. Metadata vs descriptor + client state (§5.3 rule 2; exactly
        //    one row).
        type MetaRow = (i64, String, i64, i64, String, i64, i64);
        let meta: MetaRow = img
            .query_row(
                "SELECT format, \"table\", \"schemaVersion\", \"asOfCommitSeq\",
                        \"scopeDigest\", \"rowCount\",
                        (SELECT count(*) FROM _syncular_segment)
                 FROM _syncular_segment",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .map_err(|_| invalid("missing or unreadable _syncular_segment metadata".to_owned()))?;
        let (format, meta_table, schema_version, pin, digest, meta_rows, meta_count) = meta;
        if meta_count != 1 {
            return Err(invalid(format!(
                "_syncular_segment must contain exactly one row, found {meta_count}"
            )));
        }
        if format != 1 {
            return Err(invalid(format!("format {format}")));
        }
        if meta_table != table.name {
            return Err(invalid(format!("image table {meta_table:?}")));
        }
        if schema_version != i64::from(self.schema.version) {
            return Err(invalid(format!("schemaVersion {schema_version}")));
        }
        if pin != as_of_commit_seq {
            return Err(invalid(format!("asOfCommitSeq {pin}")));
        }
        if digest != scope_digest {
            return Err(invalid("scopeDigest mismatch".to_owned()));
        }
        if meta_rows != row_count {
            return Err(invalid(format!("rowCount {meta_rows}")));
        }

        // 2. Column names and order vs the generated schema (§5.3 rule 3).
        let mut names: Vec<String> = Vec::new();
        {
            let mut stmt = img
                .prepare(&format!("PRAGMA table_info({})", quote_ident(&table.name)))
                .map_err(|_| invalid("image data table missing".to_owned()))?;
            let mut rows = stmt
                .query([])
                .map_err(|_| invalid("image data table unreadable".to_owned()))?;
            while let Some(row) = rows
                .next()
                .map_err(|_| invalid("image data table unreadable".to_owned()))?
            {
                names.push(
                    row.get::<_, String>(1)
                        .map_err(|_| invalid("image data table unreadable".to_owned()))?,
                );
            }
        }
        let mut expected: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
        expected.push("_syncular_version");
        if names.len() != expected.len() || names.iter().zip(expected.iter()).any(|(a, b)| a != b) {
            return Err(SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                "sqlite segment columns do not match the generated schema (§5.3)".to_owned(),
            ));
        }

        // 3. §5.6 first-page clear (fail closed without a mapping), then
        //    replace-or-upsert with the image-carried server versions.
        if first_fresh_page {
            self.purge_scope_rows(&table.name, effective)
                .map_err(|()| SectionError::FailClosed)?;
        }
        // One cached INSERT statement on our side, one SELECT cursor on the
        // image side; every cell is validated against the declared column
        // type and bound BORROWED (no per-cell allocation, no per-row
        // statement re-preparation) — the Rust analogue of the TS client's
        // one prepared primary-key upsert per imported row.
        self.overlay_dirty.set(true);
        // A fresh whole-table load pays secondary-index maintenance per row;
        // dropping the base half's NON-unique indexes for the load and
        // recreating them after replaces that with one bulk sort per index.
        // Unique indexes stay in place because they are semantics, not just
        // speed. A collision outside the primary key aborts the section and
        // preserves the existing row. The DDL rides the open section
        // savepoint (§1.4): an abort rolls the drop back.
        let bulk_indexes: Vec<&crate::schema::IndexSchema> = if first_fresh_page {
            table.indexes.iter().filter(|i| !i.unique).collect()
        } else {
            Vec::new()
        };
        for index in &bulk_indexes {
            let index_name = quote_ident(&format!("_syncular_base_{}", index.name));
            self.conn
                .execute(&format!("DROP INDEX IF EXISTS {index_name}"), [])
                .map_err(|e| invalid(e.to_string()))?;
        }
        let insert = self.insert_row_sql(&base_table(&table.name), table);
        let applied = {
            let mut ins = self
                .conn
                .prepare_cached(&insert)
                .map_err(|e| invalid(e.to_string()))?;
            let column_list: Vec<String> = names.iter().map(|n| quote_ident(n)).collect();
            let mut stmt = img
                .prepare(&format!(
                    "SELECT {} FROM {}",
                    column_list.join(", "),
                    quote_ident(&table.name)
                ))
                .map_err(|_| invalid("image data table unreadable".to_owned()))?;
            let mut rows = stmt
                .query([])
                .map_err(|_| invalid("image data table unreadable".to_owned()))?;
            let version_index = table.columns.len();
            let mut applied = 0u32;
            while let Some(row) = rows
                .next()
                .map_err(|_| invalid("image row unreadable".to_owned()))?
            {
                for (i, column) in table.columns.iter().enumerate() {
                    let cell = row
                        .get_ref(i)
                        .map_err(|_| invalid("image row unreadable".to_owned()))?;
                    let param = image_cell_param(column, cell).map_err(&invalid)?;
                    ins.raw_bind_parameter(i + 1, param)
                        .map_err(|e| invalid(e.to_string()))?;
                }
                let version: i64 = row
                    .get(version_index)
                    .map_err(|_| invalid("image row unreadable".to_owned()))?;
                if version < 1 {
                    return Err(invalid(format!(
                        "row _syncular_version must be >= 1, got {version}"
                    )));
                }
                ins.raw_bind_parameter(version_index + 1, version)
                    .map_err(|e| invalid(e.to_string()))?;
                ins.raw_execute().map_err(|e| invalid(e.to_string()))?;
                applied += 1;
            }
            applied
        };
        for index in &bulk_indexes {
            let index_name = quote_ident(&format!("_syncular_base_{}", index.name));
            let cols_sql = index
                .columns
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            self.conn
                .execute(
                    &format!(
                        "CREATE INDEX IF NOT EXISTS {index_name} ON {} ({cols_sql})",
                        base_table(&table.name)
                    ),
                    [],
                )
                .map_err(|e| invalid(e.to_string()))?;
        }
        if i64::from(applied) != row_count {
            return Err(invalid(format!(
                "image holds {applied} rows, descriptor says {row_count}"
            )));
        }
        Ok(applied)
    }

    // -- scope purge + doomed outbox (§3.3) ----------------------------------------

    /// Delete base rows matching the effective scopes; `Err(())` = no local
    /// scope-column mapping for a key (the fail-closed case).
    fn purge_scope_rows(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
    ) -> Result<(), ()> {
        if effective.is_empty() {
            return Ok(());
        }
        let table = self.schema.table(table_name).ok_or(())?.clone();
        let mut clauses = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or(())?;
            let placeholders: Vec<String> = values
                .iter()
                .map(|v| {
                    params.push(SqlValue::Text(v.clone()));
                    "?".to_owned()
                })
                .collect();
            clauses.push(format!(
                "{} IN ({})",
                quote_ident(column),
                placeholders.join(", ")
            ));
        }
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            clauses.join(" AND ")
        );
        self.overlay_dirty.set(true);
        self.conn
            .execute(&sql, rusqlite::params_from_iter(params))
            .map_err(|_| ())?;
        Ok(())
    }

    /// §3.3: drop pending commits whose upserts provably land in the
    /// revoked effective scopes — whole-commit, never per-operation.
    fn drop_doomed_outbox(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
    ) -> Result<bool, String> {
        if effective.is_empty() {
            return Ok(false);
        }
        let Some(table) = self.schema.table(table_name).cloned() else {
            return Ok(false);
        };
        let mut mappings: Vec<(&str, &Vec<String>)> = Vec::new();
        for (variable, values) in effective {
            match table.scope_column(variable) {
                Some(column) => mappings.push((column, values)),
                None => return Ok(false), // not provable without a mapping
            }
        }
        let doomed: Vec<OutboxCommit> = self
            .outbox
            .iter()
            .filter(|commit| {
                commit.ops.iter().any(|op| {
                    op.upsert
                        && op.table == table_name
                        && op.values.as_ref().is_some_and(|values| {
                            mappings
                                .iter()
                                .all(|(column, allowed)| match values.get(*column) {
                                    Some(Value::String(s)) => allowed.contains(s),
                                    Some(Value::Number(n)) => allowed.contains(&n.to_string()),
                                    _ => false,
                                })
                        })
                })
            })
            .cloned()
            .collect();
        if doomed.is_empty() {
            return Ok(false);
        }
        let mut rejections = Vec::new();
        for commit in &doomed {
            let results = commit
                .ops
                .iter()
                .enumerate()
                .map(|(op_index, operation)| {
                    let rejection = RejectionRecord {
                        client_commit_id: commit.client_commit_id.clone(),
                        op_index: op_index as i32,
                        code: "sync.scope_revoked".to_owned(),
                        message: "the commit was dropped because its effective scope was revoked"
                            .to_owned(),
                        retryable: false,
                        details: None,
                        operation: Some(CommitOperation::from(operation)),
                    };
                    rejections.push(rejection.clone());
                    CommitOperationOutcome::Error { rejection }
                })
                .collect::<Vec<_>>();
            self.persist_commit_outcome(
                &commit.client_commit_id,
                CommitOutcomeStatus::Rejected,
                &results,
                Some(&commit.ops),
            )?;
            self.delete_outbox_persisted(&commit.client_commit_id)?;
        }
        self.prune_commit_outcomes()?;
        let doomed_ids = doomed
            .iter()
            .map(|commit| commit.client_commit_id.as_str())
            .collect::<BTreeSet<_>>();
        self.outbox
            .retain(|commit| !doomed_ids.contains(commit.client_commit_id.as_str()));
        self.rejections.extend(rejections);
        self.overlay_dirty.set(true);
        Ok(true)
    }

    // -- blobs (§5.9) ----------------------------------------------------------------

    /// §5.9.7: hash bytes into the content address, cache them, queue the
    /// upload (flushed before the next push, B4). Returns the canonical
    /// BlobRef JSON `{blobId, byteLength, mediaType?}` for a `blob_ref`
    /// column value.
    pub fn upload_blob(
        &mut self,
        bytes: &[u8],
        media_type: Option<String>,
        name: Option<String>,
    ) -> Result<Value, String> {
        let blob_id = blob_id_for(bytes);
        let now = self.clock_now_ms();
        self.conn
            .execute(
                "INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, refcount, created_at_ms, last_used_ms) VALUES (?,?,?,?,0,?,?)
                 ON CONFLICT(blob_id) DO UPDATE SET last_used_ms = excluded.last_used_ms",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, media_type, now, now],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blob_uploads(blob_id, media_type, created_at_ms) VALUES (?,?,?)",
                rusqlite::params![blob_id, media_type, now],
            )
            .map_err(|e| e.to_string())?;
        // §5.9.7 B1: a staged upload is pinned (in _syncular_blob_uploads), so
        // the trim never evicts it; other zero-ref bodies may be over the cap.
        self.enforce_blob_cache_cap();
        let mut obj = Map::new();
        obj.insert("blobId".to_owned(), Value::from(blob_id));
        obj.insert("byteLength".to_owned(), Value::from(bytes.len() as i64));
        if let Some(mt) = media_type {
            obj.insert("mediaType".to_owned(), Value::from(mt));
        }
        if let Some(n) = name {
            obj.insert("name".to_owned(), Value::from(n));
        }
        Ok(Value::Object(obj))
    }

    /// §5.9.7: resolve blob bytes — a content-addressed cache hit serves
    /// with no fetch (B1); a miss downloads (§5.9.5), verifies the address,
    /// caches, and returns `{blobId, byteLength, bytes:{$bytes:hex}}`.
    pub fn fetch_blob(
        &mut self,
        transport: &mut dyn Transport,
        blob_id_or_ref: &str,
    ) -> Result<Value, (String, String)> {
        let simple = |m: String| ("client.failed".to_owned(), m);
        let blob_id = if blob_id_or_ref.starts_with("sha256:") {
            blob_id_or_ref.to_owned()
        } else {
            let value: Value = serde_json::from_str(blob_id_or_ref)
                .map_err(|_| simple("blob ref is not JSON".to_owned()))?;
            value
                .get("blobId")
                .and_then(Value::as_str)
                .ok_or_else(|| simple("blob ref has no blobId".to_owned()))?
                .to_owned()
        };
        if let Some(cached) = self.get_cached_blob(&blob_id).map_err(simple)? {
            return Ok(cached);
        }
        // §5.9.5: propagate the server's blob.* code (blob.forbidden /
        // blob.not_found) verbatim so the harness can assert on it. The
        // authorized endpoint serves bytes inline OR (always-issue, presign
        // configured) a signed url the client fetches directly — no host auth,
        // no fall-through: failure => re-request (the caller's next fetch_blob).
        let bytes = match transport
            .blob_download(&blob_id)
            .map_err(|e| (e.code, e.message))?
        {
            BlobDownload::Bytes(bytes) => bytes,
            BlobDownload::Url {
                url,
                url_expires_at_ms,
            } => {
                // §5.9.5: MUST NOT start a fetch at/past expiry.
                if url_expires_at_ms.is_some_and(|exp| exp <= self.clock_now_ms()) {
                    return Err((
                        "sync.segment_expired".to_owned(),
                        format!(
                            "blob url for {blob_id} expired before fetch — re-request mints a fresh url (§5.9.5)"
                        ),
                    ));
                }
                transport
                    .fetch_blob_url(&url)
                    .map_err(|e| (e.code, e.message))?
            }
        };
        // §5.9.5 inherits §5.1: verify the content address, reject mismatch.
        if blob_id_for(&bytes) != blob_id {
            return Err(simple(format!(
                "blob content address mismatch for {blob_id}"
            )));
        }
        let now = self.clock_now_ms();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, refcount, created_at_ms, last_used_ms) VALUES (?,?,?,NULL,0,?,?)",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, now, now],
            )
            .map_err(|e| simple(e.to_string()))?;
        self.enforce_blob_cache_cap();
        self.get_cached_blob(&blob_id)
            .map_err(simple)?
            .ok_or_else(|| simple("blob cache write failed".to_owned()))
    }

    fn get_cached_blob(&self, blob_id: &str) -> Result<Option<Value>, String> {
        // §5.9.7 B1 LRU: a cache-hit read touches "recently used" so a hot
        // image survives a cap trim.
        let _ = self.conn.execute(
            "UPDATE _syncular_blobs SET last_used_ms = ? WHERE blob_id = ?",
            rusqlite::params![self.clock_now_ms(), blob_id],
        );
        let mut stmt = self
            .conn
            .prepare("SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![blob_id])
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
            let byte_length: i64 = row.get(1).map_err(|e| e.to_string())?;
            let media_type: Option<String> = row.get(2).map_err(|e| e.to_string())?;
            let mut obj = Map::new();
            obj.insert("blobId".to_owned(), Value::from(blob_id.to_owned()));
            obj.insert("byteLength".to_owned(), Value::from(byte_length));
            let mut bytes_obj = Map::new();
            bytes_obj.insert("$bytes".to_owned(), Value::from(bytes_to_hex(&bytes)));
            obj.insert("bytes".to_owned(), Value::Object(bytes_obj));
            if let Some(mt) = media_type {
                obj.insert("mediaType".to_owned(), Value::from(mt));
            }
            return Ok(Some(Value::Object(obj)));
        }
        Ok(None)
    }

    /// §5.9.7 B4: upload every queued blob before push.
    fn flush_blob_uploads(&mut self, transport: &mut dyn Transport) -> Result<(), TransportError> {
        let pending: Vec<(String, Option<String>)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT blob_id, media_type FROM _syncular_blob_uploads ORDER BY created_at_ms",
                )
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            rows.filter_map(Result::ok).collect()
        };
        for (blob_id, media_type) in pending {
            let bytes: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT bytes FROM _syncular_blobs WHERE blob_id = ?",
                    rusqlite::params![blob_id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(bytes) = bytes {
                self.upload_one(transport, &blob_id, &bytes, media_type.as_deref())?;
            }
            let _ = self.conn.execute(
                "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                rusqlite::params![blob_id],
            );
        }
        Ok(())
    }

    /// §5.9.3: upload one blob, preferring the presigned direct-to-storage
    /// grant when the transport supports it, else streaming through the direct
    /// host-authenticated endpoint (capability, not fallback). A `Url` grant
    /// PUTs direct with no host auth; on a grant PUT failure the client streams
    /// through the direct endpoint — a *different, host-authenticated
    /// capability*, not a fall-through of the grant's authority.
    fn upload_one(
        &self,
        transport: &mut dyn Transport,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        match transport.blob_upload_grant(blob_id, bytes.len() as u64, media_type)? {
            BlobUploadGrant::Present => return Ok(()), // idempotent §5.9.3
            BlobUploadGrant::Url {
                url,
                url_expires_at_ms,
            } => {
                let live = url_expires_at_ms.is_none_or(|exp| exp > self.clock_now_ms());
                if live && transport.blob_put_url(&url, bytes, media_type).is_ok() {
                    return Ok(());
                }
                // Failed/expired grant PUT — stream through the direct endpoint.
            }
            BlobUploadGrant::None => {
                // No presign store — stream through the direct endpoint.
            }
        }
        transport.blob_upload(blob_id, bytes, media_type)
    }

    /// §5.9.7 B1 size cap + LRU eviction: when the sum of cached body sizes
    /// exceeds `blob_cache_max_bytes`, evict zero-ref, non-pinned bodies in
    /// least-recently-used order until back under the cap. NEVER evicts a
    /// referenced body (refcount > 0) nor a pending-upload-pinned body — if all
    /// over-cap bodies are referenced or pinned, the cache stays over the cap
    /// (correctness beats the cap). B3 re-enables the fetch for any evicted
    /// zero-ref body, so eviction only costs a future re-download. No-op if the
    /// cap is unset.
    fn enforce_blob_cache_cap(&self) {
        let Some(max_bytes) = self.limits.blob_cache_max_bytes else {
            return;
        };
        let mut total: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(byte_length), 0) FROM _syncular_blobs",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if total <= max_bytes {
            return;
        }
        let candidates: Vec<(String, i64)> = {
            let Ok(mut stmt) = self.conn.prepare(
                "SELECT blob_id, byte_length FROM _syncular_blobs
                 WHERE refcount = 0
                   AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
                 ORDER BY last_used_ms ASC, created_at_ms ASC",
            ) else {
                return;
            };
            let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            }) else {
                return;
            };
            rows.filter_map(Result::ok).collect()
        };
        for (blob_id, byte_length) in candidates {
            if total <= max_bytes {
                break;
            }
            let _ = self.conn.execute(
                "DELETE FROM _syncular_blobs WHERE blob_id = ?",
                rusqlite::params![blob_id],
            );
            total -= byte_length;
        }
    }

    /// §5.9.7 B1/B2: recompute cache refcounts from live `blob_ref` columns
    /// in the BASE tables; `delete_orphans` deletes zero-ref bodies not
    /// pinned by a pending upload (the revocation side, B2).
    fn reconcile_blob_refcounts(&mut self, delete_orphans: bool) {
        if !self.schema_has_blobs() {
            return;
        }
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for table in self.schema.tables.clone() {
            let blob_cols: Vec<String> = table
                .columns
                .iter()
                .filter(|c| c.ty == ColumnType::BlobRef)
                .map(|c| c.name.clone())
                .collect();
            for column in blob_cols {
                let sql = format!(
                    "SELECT {} FROM {} WHERE {} IS NOT NULL",
                    quote_ident(&column),
                    base_table(&table.name),
                    quote_ident(&column)
                );
                let Ok(mut stmt) = self.conn.prepare(&sql) else {
                    continue;
                };
                let Ok(rows) = stmt.query_map([], |row| row.get::<_, Option<String>>(0)) else {
                    continue;
                };
                for raw in rows.flatten().flatten() {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                        if let Some(id) = value.get("blobId").and_then(Value::as_str) {
                            *counts.entry(id.to_owned()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        let _ = self
            .conn
            .execute("UPDATE _syncular_blobs SET refcount = 0", []);
        for (blob_id, count) in &counts {
            let _ = self.conn.execute(
                "UPDATE _syncular_blobs SET refcount = ? WHERE blob_id = ?",
                rusqlite::params![count, blob_id],
            );
        }
        if delete_orphans {
            let _ = self.conn.execute(
                "DELETE FROM _syncular_blobs WHERE refcount = 0 AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)",
                [],
            );
        }
    }

    // -- local row storage ----------------------------------------------------------

    /// The cached per-table primary-key upsert SQL for `full_table` (see
    /// the `insert_sql` field: built once, reused per row).
    fn insert_row_sql(&self, full_table: &str, table: &crate::schema::TableSchema) -> String {
        if let Some(sql) = self.insert_sql.borrow().get(full_table) {
            return sql.clone();
        }
        let mut columns: Vec<String> = table.columns.iter().map(|c| quote_ident(&c.name)).collect();
        columns.push(quote_ident("_syncular_version"));
        let placeholders: Vec<&str> = columns.iter().map(|_| "?").collect();
        let primary_key = quote_ident(&table.primary_key);
        let updates = columns
            .iter()
            .filter(|column| **column != primary_key)
            .map(|column| format!("{column}=excluded.{column}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO {full_table} ({}) VALUES ({}) ON CONFLICT ({primary_key}) DO UPDATE SET {updates}",
            columns.join(", "),
            placeholders.join(", ")
        );
        self.insert_sql
            .borrow_mut()
            .insert(full_table.to_owned(), sql.clone());
        sql
    }

    fn write_base_row(&self, table_name: &str, row: &Row, version: i64) -> Result<(), String> {
        self.overlay_dirty.set(true);
        self.write_row(&base_table(table_name), table_name, row, version)
    }

    fn write_row(
        &self,
        full_table: &str,
        table_name: &str,
        row: &Row,
        version: i64,
    ) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        let sql = self.insert_row_sql(full_table, table);
        let mut stmt = self.conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        let params = row
            .iter()
            .map(RowParam::Cell)
            .chain(std::iter::once(RowParam::Version(version)));
        stmt.execute(rusqlite::params_from_iter(params))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete_base_row(&self, table_name: &str, row_id: &str) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        self.overlay_dirty.set(true);
        let sql = format!(
            "DELETE FROM {} WHERE CAST({} AS TEXT) = ?1",
            base_table(table_name),
            quote_ident(&table.primary_key)
        );
        let mut stmt = self.conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        stmt.execute(rusqlite::params![row_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// [`Self::rebuild_overlay`], skipped when neither the base tables nor
    /// the outbox changed since the last rebuild (the no-op sync round).
    fn rebuild_overlay_if_dirty(&mut self) {
        if self.overlay_dirty.get() {
            self.rebuild_overlay();
        }
    }

    /// §7.1: local reads see outbox state applied optimistically — rebuild
    /// every visible table as (base server state) + (pending outbox replay
    /// on top). Optimistic rows carry version `-1`.
    fn rebuild_overlay(&mut self) {
        self.exec("SAVEPOINT syncular_overlay");
        for table in self.schema.tables.clone() {
            let visible = visible_table(&table.name);
            let base = base_table(&table.name);
            self.exec(&format!("DELETE FROM {visible}"));
            self.exec(&format!("INSERT INTO {visible} SELECT * FROM {base}"));
        }
        for commit in self.outbox.clone() {
            for op in &commit.ops {
                let Some(table) = self.schema.table(&op.table).cloned() else {
                    continue;
                };
                if op.upsert {
                    let Some(values) = op.values.as_ref() else {
                        continue;
                    };
                    let mut row: Row = Vec::with_capacity(table.columns.len());
                    let mut ok = true;
                    for column in &table.columns {
                        match json_to_column_value(column, values.get(&column.name)) {
                            Ok(v) => row.push(v),
                            Err(_) => {
                                ok = false;
                                break;
                            }
                        }
                    }
                    if ok {
                        let _ = self.write_row(&visible_table(&table.name), &table.name, &row, -1);
                    }
                } else {
                    let sql = format!(
                        "DELETE FROM {} WHERE CAST({} AS TEXT) = ?1",
                        visible_table(&table.name),
                        quote_ident(&table.primary_key)
                    );
                    let _ = self.conn.execute(&sql, rusqlite::params![op.row_id]);
                }
            }
        }
        self.exec("RELEASE syncular_overlay");
        self.overlay_dirty.set(false);
    }

    fn exec(&self, sql: &str) {
        let _ = self.conn.execute_batch(sql);
    }

    // -- realtime (§8) ---------------------------------------------------------------

    pub fn connect_realtime(&mut self, transport: &mut dyn Transport) -> Result<(), String> {
        transport
            .realtime_connect_for_client(&self.client_id)
            .map_err(|e| format!("{}: {}", e.code, e.message))?;
        self.realtime_connected = true;
        Ok(())
    }

    pub fn disconnect_realtime(&mut self, transport: &mut dyn Transport) {
        let _ = transport.realtime_close();
        self.realtime_connected = false;
        self.presence.clear(); // §8.6.1: presence is per-connection
    }

    /// §8.6.2: publish (or clear, `doc: None`) this client's presence
    /// document for `scope_key`. Requires a live socket; the document is
    /// ephemeral (lost on disconnect). Authorization is the connection's
    /// registration (§8.6.3) — an unheld key is rejected loudly by the
    /// server with `presence.forbidden`.
    pub fn set_presence(
        &mut self,
        transport: &mut dyn Transport,
        scope_key: &str,
        doc: Option<&Value>,
    ) -> Result<(), String> {
        if !self.realtime_connected {
            return Err("setPresence requires a connected realtime socket (§8.6)".to_string());
        }
        let text = encode_presence_publish(scope_key, doc);
        transport
            .realtime_send(&text)
            .map_err(|e| format!("{}: {}", e.code, e.message))
    }

    /// §8.6: the peers currently present on a scope key (ephemeral).
    pub fn presence(&self, scope_key: &str) -> Vec<PresencePeer> {
        self.presence
            .get(scope_key)
            .map(|peers| peers.values().cloned().collect())
            .unwrap_or_default()
    }

    /// §8.6 apply an inbound presence fanout to the local map.
    fn apply_presence(
        &mut self,
        scope_key: String,
        kind: Option<PresenceKind>,
        actor_id: Option<String>,
        client_id: Option<String>,
        doc: Option<Value>,
        error: Option<String>,
    ) {
        // The publisher-directed error variant is out-of-band; nothing to
        // record in the peer map.
        if error.is_some() {
            return;
        }
        let (Some(kind), Some(actor_id), Some(client_id)) = (kind, actor_id, client_id) else {
            return;
        };
        let peer_key = format!("{actor_id} {client_id}");
        match kind {
            PresenceKind::Leave => {
                if let Some(peers) = self.presence.get_mut(&scope_key) {
                    peers.remove(&peer_key);
                    if peers.is_empty() {
                        self.presence.remove(&scope_key);
                    }
                }
            }
            _ => {
                let doc = match doc {
                    Some(Value::Object(_)) => doc.unwrap(),
                    _ => return,
                };
                self.presence.entry(scope_key).or_default().insert(
                    peer_key,
                    PresencePeer {
                        actor_id,
                        client_id,
                        doc,
                    },
                );
            }
        }
    }

    /// Inbound JSON control message (§8.1). Unknown events are tolerated.
    pub fn on_realtime_text(&mut self, text: &str) {
        match parse_control(text) {
            Ok(ControlMessage::Hello { requires_sync, .. }) => {
                if requires_sync {
                    // §8.1: pull before trusting the socket for continuity.
                    self.set_sync_needed(true, true);
                }
            }
            Ok(ControlMessage::Presence {
                scope_key,
                kind,
                actor_id,
                client_id,
                doc,
                error,
                ..
            }) => {
                self.apply_presence(scope_key, kind, actor_id, client_id, doc, error);
            }
            Ok(ControlMessage::Wake { .. }) => {
                // §8.3: any wake-up means "run a pull soon", never data.
                self.set_sync_needed(true, true);
            }
            _ => {}
        }
    }

    /// Inbound binary delta: a complete SSP2 response (§8.2), applied like
    /// a pull response per section; an unapplied delta is a wake-up.
    pub fn on_realtime_binary(&mut self, transport: &mut dyn Transport, bytes: &[u8]) {
        if self.stopped {
            return;
        }
        let message = match decode_message(bytes) {
            Ok(m) if m.msg_kind == MsgKind::Response => m,
            _ => {
                self.set_sync_needed(true, true);
                return;
            }
        };
        let mut frames = message.frames.into_iter();
        let mut applied_cursor: Option<i64> = None;
        let mut any_covered = false;
        let mut dropped = false;
        while let Some(frame) = frames.next() {
            let Frame::SubStart {
                id,
                status,
                effective_scopes,
                ..
            } = frame
            else {
                continue;
            };
            let mut body = Vec::new();
            let mut next_cursor: Option<i64> = None;
            for inner in frames.by_ref() {
                match inner {
                    Frame::SubEnd {
                        next_cursor: nc, ..
                    } => {
                        next_cursor = Some(nc);
                        break;
                    }
                    Frame::Unknown { .. } => {}
                    other => body.push(other),
                }
            }
            let Some(next_cursor) = next_cursor else {
                dropped = true;
                break;
            };
            let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
                dropped = true;
                continue;
            };
            let sub = &self.subs[sub_index];
            // §8.2: only locally active, not mid-bootstrap subscriptions
            // apply; skipped sections are repaired by the next pull.
            if status != SubStatus::Active
                || sub.state != SubState::Active
                || sub.bootstrap_state.is_some()
                || !sub.synced_once
            {
                dropped = true;
                continue;
            }
            if next_cursor <= sub.cursor {
                // Idempotent redelivery of an already-covered window.
                any_covered = true;
                continue;
            }
            let previous_effective = self.subs[sub_index].effective.clone();
            let previous_cursor = self.subs[sub_index].cursor;
            if self.begin_observation("syncular_delta").is_err() {
                dropped = true;
                continue;
            }
            self.subs[sub_index].effective = Some(effective_scopes);
            let mut batch = ChangeAccumulator::default();
            let mut failed = false;
            for inner in body {
                if let Frame::Commit {
                    tables, changes, ..
                } = inner
                {
                    self.record_commit_changes(&mut batch, &tables, &changes);
                    if self.apply_commit_changes(&tables, &changes).is_err() {
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                self.rollback_observation("syncular_delta");
                self.subs[sub_index].effective = previous_effective;
                self.subs[sub_index].cursor = previous_cursor;
                self.overlay_dirty.set(true);
                self.rebuild_overlay();
                dropped = true;
                continue;
            }
            let sub = &mut self.subs[sub_index];
            sub.cursor = next_cursor;
            self.persist_sub(&self.subs[sub_index].clone());
            self.rebuild_overlay_if_dirty();
            if self.finish_observation("syncular_delta", batch).is_err() {
                self.rollback_observation("syncular_delta");
                self.subs[sub_index].effective = previous_effective;
                self.subs[sub_index].cursor = previous_cursor;
                self.overlay_dirty.set(true);
                self.rebuild_overlay();
                dropped = true;
                continue;
            }
            applied_cursor = Some(applied_cursor.map_or(next_cursor, |c| c.max(next_cursor)));
        }
        if let Some(cursor) = applied_cursor {
            self.reconcile_blob_refcounts(false);
            // §8.2 ack point: the highest applied SUB_END.nextCursor.
            let ack = format!("{{\"type\":\"ack\",\"cursor\":{cursor}}}");
            let _ = transport.realtime_send(&ack);
        } else if !any_covered || dropped {
            // §8.2: a delta not applied at all is treated as a wake-up.
            self.set_sync_needed(true, true);
        }
    }

    /// §8.2 ack point after an HTTP pull on a live connection: the minimum
    /// cursor across active, non-bootstrapping subscriptions that have
    /// synced at least once. No such subscription, no ack.
    fn ack_after_pull(&mut self, transport: &mut dyn Transport) {
        if !self.realtime_connected {
            return;
        }
        let floor = self
            .subs
            .iter()
            .filter(|s| {
                s.state == SubState::Active
                    && s.bootstrap_state.is_none()
                    && s.synced_once
                    && s.cursor >= 0
            })
            .map(|s| s.cursor)
            .min();
        if let Some(cursor) = floor {
            let ack = format!("{{\"type\":\"ack\",\"cursor\":{cursor}}}");
            let _ = transport.realtime_send(&ack);
        }
    }
}
