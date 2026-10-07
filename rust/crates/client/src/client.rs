//! The Syncular v2 Rust client core (SPEC.md client-behavior contract):
//! rusqlite local storage, §3.2/§3.3 effective-scope persistence + purge,
//! §4 pull/cursor/bootstrap (§4.7 resume, §5.6 segment application), §6
//! push with outbox order, §7 optimistic apply / rollback / replay-on-top,
//! §2.3 clientCommitId idempotency, §8 realtime client rules, §10 errors.
//!
//! Built from `SPEC.md` and the committed `ssp2` codec alone — no
//! reference to the v1 Rust tree or the v2 TypeScript client.

use crate::{ProgressObserver, ProgressPhase, ProgressState};
use ssp2::encode_message;
#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use ssp2::decode::WIRE_VERSION;
use ssp2::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, Column, ColumnType, ColumnValue, Row, RowsSegment};
use ssp2::{decode_message, encode_presence_publish, parse_control, ControlMessage, PresenceKind};

use crate::api::{
    ClientChangeBatch, ClientDiagnosticsHost, ClientDiagnosticsLease, ClientDiagnosticsReplica,
    ClientDiagnosticsRequest, ClientDiagnosticsSchema, ClientDiagnosticsSnapshot,
    ClientDiagnosticsStorage, ClientError, ClientLimits, CommandEffects, CommitOperation,
    CommitOperationOutcome, CommitOutcome, CommitOutcomeQuery, CommitOutcomeResolution,
    CommitOutcomeStatus, ConflictRecord, CoverageSnapshot, DiagnosticLastChange,
    DiagnosticLastRound, DiagnosticQueryFailure, DiagnosticRoundCounters, DiagnosticSubscription,
    FetchedBlob, LeaseState, LocalDataPurgeInput, LocalDataPurgeResult, LocalDataPurgeTarget,
    LocalDataRebootstrapInput, LocalDataRebootstrapResult, Mutation, PresencePeer,
    PreviousVersionStatus, QueryOwner, QueryReadFailure, QueryRow, QuerySnapshot, QueryValue,
    RejectionDetails, RejectionRecord, ResolveCommitOutcomeInput, RetainedCommitRow,
    RetainedUniqueConflict, RowState, SchemaFloor, SubscriptionStateView, SyncIntent, SyncOutcome,
    SyncReport, SyncStatusSnapshot, TableChange, WindowBase, WindowChange, WindowCoverage,
    WindowState, WindowUnitRef, CLIENT_DIAGNOSTICS_VERSION, MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
    MAX_DIAGNOSTIC_QUERY_FAILURES,
};
use crate::api::{RealtimePolicy, RealtimeState, REALTIME_UNAVAILABLE_CODE};
#[cfg(feature = "bench-internals")]
use crate::bench::{Phase, Recorder};
use crate::previous_version::{
    capture_previous_version_from_replica, first_incompatibility,
    reconcile_previous_version_at_boot, set_local_schema_descriptor,
    sweep_previous_version_container, PendingCommitAudit, PreviousVersionContextConfig,
    PreviousVersionLifecycle, PreviousVersionReadSpec, PreviousVersionSnapshot,
};
use crate::schema::{parse_schema_json, ClientSchema, FtsIndexSchema, TableSchema};
use crate::transport::{BlobDownload, SegmentRequest, Transport, TransportError};
use crate::values::{
    bytes_to_hex, canonical_scope_json, column_value_to_json, decode_row_bytes,
    encode_sparse_row_json, full_row_values, json_to_column_value, json_to_scope_map,
    normalize_values_casing, render_row_id_json, scope_map_to_json, sort_scope_map,
};

/// §4.2 default: rows and SQLite images, both applied in committed chunks.
/// Bit 3 (signed URLs, §5.4) is
/// added per transport capability at request-build time.
const DEFAULT_ACCEPT: u8 = 0b0111;
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;
const ACCEPT_EXTERNAL_ROWS: u8 = 1 << 1;
const ACCEPT_SQLITE: u8 = 1 << 2;
const ACCEPT_SIGNED_URLS: u8 = 1 << 3;
const MAX_DIAGNOSTIC_DOMAINS: usize = 256;

/// §7.4.1 persisted local schema-version marker (`_syncular_meta` key).
pub(crate) const LOCAL_SCHEMA_VERSION_KEY: &str = "localSchemaVersion";
const LOCAL_REVISION_KEY: &str = "localRevision";
const CLIENT_ID_KEY: &str = "clientId";
const LEASE_STATE_KEY: &str = "leaseState";
const SCHEMA_FLOOR_KEY: &str = "schemaFloor";
const LOG_EPOCH_KEY: &str = "logEpoch";
/// Persisted fail-closed quarantine marker: present while a security preflight
/// is pending and `activateSecurity` has yet to run. Storing it in the replica
/// keeps the gate with the data it protects, so a rebuilt host handle reopening
/// the same file returns in preflight even though its in-memory state is fresh.
const SECURITY_PREFLIGHT_PENDING_KEY: &str = "securityPreflightPending";
const LOCAL_REBOOTSTRAP_RECEIPT_VERSION: u8 = 2;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// §7.4.4 client-local code: a pending outbox commit cannot re-encode under
/// the new schema after a bump. Never a wire code (§10.3).
const OUTBOX_INCOMPATIBLE_CODE: &str = "sync.outbox_incompatible";
/// §5.11 client-local code: an encode at the push seam resolved no usable key
/// id or named an unknown key. Never a wire code (§10.3).
const ENCRYPT_FAILED_CODE: &str = "client.encrypt_failed";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedLocalDataRebootstrapReceipt {
    version: u8,
    retained_commits: u64,
    reset_subscriptions: u64,
}

fn invalid_local_rebootstrap_receipt() -> String {
    "sync.local_corrupt: persisted local rebootstrap receipt is invalid".to_owned()
}

fn encode_local_rebootstrap_receipt(
    retained_commits: usize,
    reset_subscriptions: usize,
) -> Result<String, String> {
    let retained_commits =
        u64::try_from(retained_commits).map_err(|_| invalid_local_rebootstrap_receipt())?;
    let reset_subscriptions =
        u64::try_from(reset_subscriptions).map_err(|_| invalid_local_rebootstrap_receipt())?;
    if retained_commits > MAX_JS_SAFE_INTEGER || reset_subscriptions > MAX_JS_SAFE_INTEGER {
        return Err(invalid_local_rebootstrap_receipt());
    }
    serde_json::to_string(&PersistedLocalDataRebootstrapReceipt {
        version: LOCAL_REBOOTSTRAP_RECEIPT_VERSION,
        retained_commits,
        reset_subscriptions,
    })
    .map_err(|_| invalid_local_rebootstrap_receipt())
}

fn decode_local_rebootstrap_receipt(value: &str) -> Result<(usize, usize), String> {
    // Pre-0.15.36 markers proved application but did not retain the receipt.
    if value == "v1" {
        return Ok((0, 0));
    }
    let receipt: PersistedLocalDataRebootstrapReceipt =
        serde_json::from_str(value).map_err(|_| invalid_local_rebootstrap_receipt())?;
    if receipt.version != LOCAL_REBOOTSTRAP_RECEIPT_VERSION
        || receipt.retained_commits > MAX_JS_SAFE_INTEGER
        || receipt.reset_subscriptions > MAX_JS_SAFE_INTEGER
    {
        return Err(invalid_local_rebootstrap_receipt());
    }
    Ok((
        usize::try_from(receipt.retained_commits)
            .map_err(|_| invalid_local_rebootstrap_receipt())?,
        usize::try_from(receipt.reset_subscriptions)
            .map_err(|_| invalid_local_rebootstrap_receipt())?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Active,
    Revoked,
    Failed,
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use crate::native_transport::HostTransport;
    use crate::values::encode_row_json;
    use serde_json::json;

    #[test]
    fn authority_policy_refuses_encrypted_and_undeclared_columns_before_open() {
        let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "secret", "type": "bytes", "encrypted": true, "declaredType": "string", "nullable": true}
        ]}]});
        for name in [
            "secret",
            "missing",
            "*",
            "id FROM authority; DELETE FROM authority",
            "_syncular_version",
        ] {
            let limits = ClientLimits {
                authority_reads: vec![crate::api::AuthorityReadDeclaration {
                    table: "authority".into(),
                    columns: vec!["id".into(), "actor_id".into(), name.into()],
                    scopes: [("actor_id".into(), vec!["a".into()])].into(),
                }],
                ..Default::default()
            };
            let error = SyncClient::new("authority".into(), &schema, limits)
                .err()
                .expect("forbidden policy");
            assert!(
                error.starts_with("client.authority_read_forbidden:"),
                "{error}"
            );
        }
    }

    #[test]
    fn authority_snapshot_observes_one_file_transaction_during_concurrent_writes() {
        let path = std::env::temp_dir().join(format!(
            "syncular-authority-snapshot-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "revision", "type": "integer", "nullable": false}
        ]}]});
        let limits = ClientLimits {
            authority_reads: vec![crate::api::AuthorityReadDeclaration {
                table: "authority".into(),
                columns: vec!["id".into(), "actor_id".into(), "revision".into()],
                scopes: [("actor_id".into(), vec!["a".into()])].into(),
            }],
            ..Default::default()
        };
        let mut client =
            SyncClient::open_path("authority".into(), &schema, limits, path.to_str().unwrap())
                .unwrap();
        client.begin_security_preflight();
        let update = |conn: &Connection, revision: i64| {
            conn.execute_batch("BEGIN IMMEDIATE").unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO _syncular_base_authority VALUES('one','a',?1,1)",
                [revision],
            )
            .unwrap();
            conn.execute(
                "UPDATE _syncular_meta SET value=?1 WHERE key='localRevision'",
                [revision.to_string()],
            )
            .unwrap();
            conn.execute("INSERT OR REPLACE INTO _syncular_subscriptions VALUES('s','authority',?1)", [json!({"requested": {"actor_id": ["a"]}, "effectiveScopes": {"actor_id": ["a"]}, "status": "active", "cursor": revision}).to_string()]).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        update(&client.conn, 1);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let writer_barrier = barrier.clone();
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let conn = Connection::open(writer_path).unwrap();
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            writer_barrier.wait();
            for revision in 2..=100 {
                update(&conn, revision);
            }
        });
        barrier.wait();
        for _ in 0..100 {
            let snapshot = client.authority_snapshot().unwrap();
            let revision = snapshot["revision"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap();
            assert_eq!(
                snapshot["tables"][0]["rows"][0]["values"]["revision"],
                revision
            );
            assert_eq!(snapshot["tables"][0]["persisted"][0]["cursor"], revision);
            assert_eq!(snapshot["complete"], true);
        }
        writer.join().unwrap();
        assert_eq!(client.authority_snapshot().unwrap()["revision"], "100");
        drop(client);
        let _ = std::fs::remove_file(path);
    }

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

    #[cfg(feature = "e2ee")]
    #[test]
    fn an_unresolvable_key_id_becomes_a_durable_rejection_at_the_push_seam() {
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "secrets",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "encryption_key_id", "type": "string", "nullable": true },
                    { "name": "note", "type": "bytes", "nullable": true,
                      "encrypted": true, "declaredType": "string" }
                ],
                "scopes": []
            }]
        });
        let mut client = SyncClient::new("encrypt-reject".into(), &schema, ClientLimits::default())
            .expect("test client");
        let mut config = crate::values::EncryptionConfig::default();
        config.keys.insert("k1".to_owned(), vec![0x2A; 32]);
        config
            .key_id_columns
            .insert("secrets".to_owned(), "encryption_key_id".to_owned());
        client.set_encryption(config);
        // The row exists, but its key selector is absent. The encrypted edit
        // authors locally and fails at the push seam.
        client
            .write_base_row(
                "secrets",
                &vec![Some(ColumnValue::String("ghost".into())), None, None],
                1,
            )
            .unwrap();
        client.rebuild_overlay().expect("rebuild overlay");
        let commit_id = client
            .patch(
                "secrets",
                "ghost",
                Map::from_iter([("note".to_owned(), json!("x"))]),
                None,
            )
            .expect("patch records without an author-time encrypt failure");
        assert_eq!(client.pending_commit_ids(), vec![commit_id.clone()]);
        // ...and the push seam raises a durable local rejection, not a throw.
        assert!(client.drop_unencodable_outbox().unwrap());
        assert!(client.pending_commit_ids().is_empty());
        let rejections = client.rejections();
        assert_eq!(rejections.len(), 1);
        assert_eq!(rejections[0].code, "client.encrypt_failed");
        assert_eq!(rejections[0].client_commit_id, commit_id);
        assert_eq!(
            client
                .commit_outcome(&commit_id)
                .unwrap()
                .map(|outcome| outcome.status),
            Some(CommitOutcomeStatus::Rejected)
        );
    }

    #[test]
    fn patch_scope_read_preserves_sqlite_failure() {
        let mut client = client();
        client
            .conn
            .execute_batch(
                "DROP TABLE tasks;
            CREATE VIEW tasks AS SELECT 't1' AS id, abs(-9223372036854775808) AS project_id;",
            )
            .unwrap();
        let error = client
            .patch(
                "tasks",
                "t1",
                Map::from_iter([("project_id".to_owned(), json!("p1"))]),
                None,
            )
            .expect_err("the scope read must fail");
        assert_ne!(error.code, "sync.invalid_request");
        assert_eq!(error.code, "client.failed");
        assert!(error.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap()
            .contains("integer overflow"));
        assert!(client.pending_commit_ids().is_empty());
        assert!(client.conn.is_autocommit());
    }

    #[test]
    fn patch_with_a_scope_column_matches_the_stored_local_row() {
        let mut client = client();
        client.create_synced_tables().unwrap();
        client
            .conn
            .execute(
                "INSERT INTO tasks (id, project_id, _syncular_version) VALUES ('t1', 'p1', 1)",
                [],
            )
            .unwrap();

        // §3.4 rule 5: a value equal to the stored local row is a no-op, so
        // the scope column leaves the presence set.
        client
            .patch(
                "tasks",
                "t1",
                Map::from_iter([
                    ("project_id".to_owned(), json!("p1")),
                    ("id".to_owned(), json!("t1")),
                ]),
                None,
            )
            .expect("an equal scope column is a no-op");
        let values = client.outbox[0].ops[0]
            .values
            .clone()
            .expect("the patch records values");
        assert_eq!(values.get("id"), Some(&json!("t1")));
        assert!(!values.contains_key("project_id"));

        // A differing value stays rejected.
        let differing = client.patch(
            "tasks",
            "t1",
            Map::from_iter([("project_id".to_owned(), json!("p2"))]),
            None,
        );
        let differing = differing.expect_err("a differing scope column is rejected");
        assert_eq!(differing.code, "sync.invalid_request");
        assert_eq!(differing.message, "the authoring request is invalid");
        assert!(
            differing
                .details
                .as_ref()
                .and_then(|details| details["legacyCause"].as_str())
                .is_some_and(|cause| cause.contains("patch cannot write scope column")),
            "{differing:?}"
        );

        // An absent local row leaves nothing to prove equality against, so
        // the patch fails closed.
        let absent = client.patch(
            "tasks",
            "ghost",
            Map::from_iter([("project_id".to_owned(), json!("p1"))]),
            None,
        );
        let absent = absent.expect_err("an absent local row is rejected");
        assert_eq!(absent.code, "sync.row_missing");
        assert!(absent.message.contains("requires a local row"));
        assert_eq!(client.pending_commit_ids().len(), 1);
    }

    #[test]
    fn patch_scope_column_parity_for_the_primary_key_and_coerced_values() {
        let schema = json!({
            "version": 1,
            "tables": [
                {
                    "name": "tenants",
                    "primaryKey": "tenant_id",
                    "columns": [
                        { "name": "tenant_id", "type": "string", "nullable": false },
                        { "name": "body", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "tenant:{tenant_id}" }]
                },
                {
                    "name": "buckets",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "bucket", "type": "float", "nullable": false },
                        { "name": "body", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "bucket:{bucket}" }]
                }
            ]
        });
        let mut client = SyncClient::new("scope-parity".into(), &schema, ClientLimits::default())
            .expect("test client");
        client.create_synced_tables().unwrap();

        // A primary key that is also a scope column still needs a local base.
        client
            .conn
            .execute(
                "INSERT INTO tenants (tenant_id, body, _syncular_version) VALUES ('t1', 'seed', 1)",
                [],
            )
            .unwrap();
        client
            .patch(
                "tenants",
                "t1",
                Map::from_iter([
                    ("tenant_id".to_owned(), json!("t1")),
                    ("body".to_owned(), json!("created")),
                ]),
                None,
            )
            .expect("the primary-key scope column is proven equal by construction");

        // A stored REAL scope value coerces from a supplied integer.
        client
            .conn
            .execute(
                "INSERT INTO buckets (id, bucket, body, _syncular_version) VALUES ('b1', 2.0, 'seed', 1)",
                [],
            )
            .unwrap();
        client
            .patch(
                "buckets",
                "b1",
                Map::from_iter([
                    ("bucket".to_owned(), json!(2)),
                    ("body".to_owned(), json!("coerced")),
                ]),
                None,
            )
            .expect("the stored REAL value coerces from a supplied integer");
        let values = client.outbox[1].ops[0]
            .values
            .clone()
            .expect("the patch records values");
        assert!(!values.contains_key("bucket"));

        // A differing value stays rejected.
        let differing = client.patch(
            "buckets",
            "b1",
            Map::from_iter([("bucket".to_owned(), json!(3))]),
            None,
        );
        let differing = differing.expect_err("a differing scope value is rejected");
        assert_eq!(differing.code, "sync.invalid_request");
        assert_eq!(differing.message, "the authoring request is invalid");
        assert!(
            differing
                .details
                .as_ref()
                .and_then(|details| details["legacyCause"].as_str())
                .is_some_and(|cause| cause.contains("patch cannot write scope column")),
            "{differing:?}"
        );
    }

    #[cfg(feature = "e2ee")]
    #[test]
    fn stored_key_fallback_resolves_an_integer_primary_key() {
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "patients",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "integer", "nullable": false },
                    { "name": "encryption_key_id", "type": "string", "nullable": true },
                    { "name": "note", "type": "bytes", "nullable": true,
                      "encrypted": true, "declaredType": "string" }
                ],
                "scopes": []
            }]
        });
        let mut client = SyncClient::new("int-key".into(), &schema, ClientLimits::default())
            .expect("test client");
        client.create_synced_tables().unwrap();
        client
            .conn
            .execute(
                "INSERT INTO patients (id, encryption_key_id, note, _syncular_version)
                 VALUES (5, 'k1', NULL, 1)",
                [],
            )
            .unwrap();
        let mut config = crate::values::EncryptionConfig::default();
        config.keys.insert("k1".to_owned(), vec![0x2A; 32]);
        config
            .key_id_columns
            .insert("patients".to_owned(), "encryption_key_id".to_owned());
        client.set_encryption(config);
        let table = client.schema.table("patients").unwrap();
        let fallback = client
            .stored_key_fallback(table, "5")
            .expect("the stored integer key resolves the fallback");
        assert_eq!(fallback[1], Some(ColumnValue::String("k1".to_owned())));
    }

    #[test]
    fn blob_staging_failures_preserve_durable_state_and_allow_retry() {
        let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
        for state in ["absent", "cached", "pinned"] {
            let path = std::env::temp_dir().join(format!(
                "syncular-blob-stage-{}.sqlite",
                uuid::Uuid::new_v4()
            ));
            let mut client = SyncClient::open_path(
                "stage-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            let bytes = b"atomic stage";
            if state != "absent" {
                client
                    .upload_blob(bytes, Some("text/plain".into()), None)
                    .unwrap();
                if state == "cached" {
                    client
                        .conn
                        .execute("DELETE FROM _syncular_blob_uploads", [])
                        .unwrap();
                }
            }
            let bodies = client.query("SELECT * FROM _syncular_blobs", &[]).unwrap();
            client
                .conn
                .execute_batch(
                    "CREATE TRIGGER fail_stage_insert BEFORE INSERT ON _syncular_blobs
                   BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END;
                 CREATE TRIGGER fail_stage_update BEFORE UPDATE ON _syncular_blobs
                   BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END;",
                )
                .unwrap();
            let error = client
                .upload_blob(bytes, Some("application/octet-stream".into()), None)
                .unwrap_err();
            assert!(error.contains("injected stage failure"), "{state}: {error}");
            assert!(client.conn.is_autocommit());
            let immediate = client.query("SELECT * FROM _syncular_blobs", &[]).unwrap();
            drop(client);
            let mut reopened = SyncClient::open_path(
                "stage-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            let durable = reopened
                .query("SELECT * FROM _syncular_blobs", &[])
                .unwrap();
            reopened
                .conn
                .execute_batch("DROP TRIGGER fail_stage_insert; DROP TRIGGER fail_stage_update")
                .unwrap();
            let retried = reopened.upload_blob(bytes, None, None).unwrap();
            assert_eq!(reopened.upload_blob(bytes, None, None).unwrap(), retried);
            assert_eq!(
                reopened
                    .query("SELECT blob_id FROM _syncular_blob_uploads", &[])
                    .unwrap(),
                vec![Map::from_iter([(
                    "blob_id".into(),
                    Value::from(blob_id_for(bytes)),
                )])]
            );
            drop(reopened);
            std::fs::remove_file(&path).unwrap();
            assert_eq!(durable, bodies, "{state}: reopened body state");
            assert_eq!(immediate, bodies, "{state}: immediate body state");
        }
    }

    #[test]
    fn blob_upload_failures_preserve_pins_and_original_commits_after_file_reopen() {
        let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
        for fault in [
            "missing",
            "body-type",
            "length",
            "hash",
            "pin-metadata",
            "read",
            "pin-delete",
        ] {
            let path = std::env::temp_dir().join(format!(
                "syncular-blob-upload-{}.sqlite",
                uuid::Uuid::new_v4()
            ));
            let mut client = SyncClient::open_path(
                "upload-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            let bytes = b"durable upload";
            let ref_value = client
                .upload_blob(bytes, Some("text/plain".into()), None)
                .unwrap();
            let commit = client
                .mutate(vec![Mutation::Upsert {
                    table: "attachments".into(),
                    values: Map::from_iter([
                        ("id".into(), Value::from("pending")),
                        (
                            "file".into(),
                            Value::from(format!(
                                "{{\"blobId\":\"{}\",\"byteLength\":{}}}",
                                blob_id_for(bytes),
                                bytes.len()
                            )),
                        ),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            client
                .conn
                .execute_batch("CREATE TABLE saved_bodies AS SELECT * FROM _syncular_blobs")
                .unwrap();
            client.conn.execute_batch(match fault {
                "missing" => "DELETE FROM _syncular_blobs",
                "body-type" => "UPDATE _syncular_blobs SET bytes = 'wrong type'",
                "length" => "UPDATE _syncular_blobs SET byte_length = byte_length + 1",
                "hash" => "UPDATE _syncular_blobs SET bytes = zeroblob(byte_length)",
                "pin-metadata" => "UPDATE _syncular_blob_uploads SET media_type = x'ff'",
                "read" => "ALTER TABLE _syncular_blobs RENAME TO unavailable_bodies",
                _ => "CREATE TRIGGER fail_pin_delete BEFORE DELETE ON _syncular_blob_uploads BEGIN SELECT RAISE(ABORT, 'injected pin deletion failure'); END",
            }).unwrap();
            let state = if fault == "read" {
                Vec::new()
            } else {
                client.query("SELECT * FROM _syncular_blobs", &[]).unwrap()
            };
            let mut transport = CountingRealtimeTransport::default();
            let error = client.flush_blob_uploads(&mut transport).unwrap_err();
            assert_eq!(
                error.code,
                if matches!(fault, "read" | "pin-delete") {
                    "client.failed"
                } else {
                    "sync.local_corrupt"
                },
                "{fault}"
            );
            assert_eq!(
                transport.blob_uploads.len(),
                usize::from(fault == "pin-delete"),
                "{fault}: corrupt bytes must never be uploaded"
            );
            assert_eq!(client.pending_commit_ids(), std::slice::from_ref(&commit));
            if fault != "read" {
                assert_eq!(
                    client.query("SELECT * FROM _syncular_blobs", &[]).unwrap(),
                    state
                );
            } else {
                client
                    .conn
                    .execute_batch("ALTER TABLE unavailable_bodies RENAME TO _syncular_blobs")
                    .unwrap();
            }
            drop(client);
            let mut reopened = SyncClient::open_path(
                "upload-test".into(),
                &schema,
                Default::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            assert_eq!(reopened.pending_commit_ids(), std::slice::from_ref(&commit));
            if fault != "read" {
                assert_eq!(
                    reopened
                        .query("SELECT * FROM _syncular_blobs", &[])
                        .unwrap(),
                    state
                );
            }
            if fault == "pin-delete" {
                reopened
                    .conn
                    .execute_batch("DROP TRIGGER fail_pin_delete")
                    .unwrap();
            }
            if fault == "pin-metadata" {
                reopened
                    .conn
                    .execute(
                        "UPDATE _syncular_blob_uploads SET media_type = 'text/plain'",
                        [],
                    )
                    .unwrap();
            }
            reopened
                .conn
                .execute_batch(
                    "DELETE FROM _syncular_blobs;
                     INSERT INTO _syncular_blobs SELECT * FROM saved_bodies",
                )
                .unwrap();
            transport.blob_uploads.clear();
            reopened.flush_blob_uploads(&mut transport).unwrap();
            assert_eq!(
                transport.blob_uploads,
                [(blob_id_for(bytes), bytes.to_vec())]
            );
            assert_eq!(
                reopened
                    .query("SELECT blob_id FROM _syncular_blob_uploads", &[])
                    .unwrap(),
                Vec::<Map<String, Value>>::new()
            );
            assert_eq!(reopened.pending_commit_ids(), [commit]);
            assert_eq!(
                reopened
                    .get_cached_blob_bytes(ref_value["blobId"].as_str().unwrap())
                    .unwrap()
                    .unwrap()
                    .bytes,
                bytes
            );
            drop(reopened);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn incoming_frame_transactions_preserve_prefix_cursor_and_revision_after_reopen() {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        for realtime in [false, true] {
            for fault in [
                "none",
                "row",
                "revision",
                "commit",
                "cursor",
                "error",
                "missing-end",
            ] {
                if realtime && fault == "missing-end" {
                    continue;
                }
                let path = std::env::temp_dir()
                    .join(format!("syncular-frame-{}.sqlite", uuid::Uuid::new_v4()));
                let mut client = SyncClient::open_path(
                    "frame-test".into(),
                    &schema,
                    Default::default(),
                    path.to_str().unwrap(),
                )
                .unwrap();
                client.set_meta(LOG_EPOCH_KEY, "epoch-1");
                client
                    .subscribe(
                        "tasks".into(),
                        "tasks".into(),
                        vec![("project_id".into(), vec!["p1".into()])],
                        None,
                    )
                    .unwrap();
                client.subs[0].cursor = 0;
                client.subs[0].synced_once = true;
                client.subs[0].effective = Some(vec![("project_id".into(), vec!["p1".into()])]);
                client.persist_sub(&client.subs[0]).unwrap();
                client.realtime_state = RealtimeState::Connected;
                client.realtime_reason_code = None;
                client.drain_change_batches();
                let mut transport = CountingRealtimeTransport::default();
                let (_, meta) = client.build_request(false).unwrap();
                let mut response = Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames: vec![
                        Frame::RespHeader {
                            required_schema_version: None,
                            latest_schema_version: None,
                            log_epoch: Some("epoch-1".into()),
                            reset_required: Some(false),
                        },
                        Frame::SubStart {
                            id: "tasks".into(),
                            status: SubStatus::Active,
                            reason_code: "".into(),
                            effective_scopes: vec![("project_id".into(), vec!["p1".into()])],
                            bootstrap: false,
                        },
                    ],
                };
                for (index, id) in ["first", "second"].iter().enumerate() {
                    let values = Map::from_iter([
                        ("id".into(), Value::from(*id)),
                        ("project_id".into(), Value::from("p1")),
                    ]);
                    response.frames.push(Frame::Commit {
                        commit_seq: index as i64 + 1,
                        actor_id: "writer".into(),
                        created_at_ms: 1,
                        tables: vec!["tasks".into()],
                        changes: vec![ssp2::model::Change {
                            table_index: 0,
                            row_id: (*id).into(),
                            op: Op::Upsert,
                            row_version: Some(index as i64 + 1),
                            scopes: vec![("project_id".into(), "p1".into())],
                            row: Some(
                                encode_row_json(
                                    client.schema.table("tasks").unwrap(),
                                    id,
                                    &values,
                                    &client.encryption,
                                )
                                .unwrap(),
                            ),
                        }],
                    });
                }
                response.frames.push(Frame::SubEnd {
                    next_cursor: 2,
                    bootstrap_state: None,
                });
                let valid = response.clone();
                match fault {
                    "row" => {
                        let Frame::Commit {changes, ..} = &mut response.frames[3] else {panic!("second frame")};
                        let mut malformed = changes[0].clone(); malformed.row_id = "malformed".into(); malformed.row = Some(vec![]); changes.push(malformed);
                    },
                    "revision" => client.conn.execute_batch("CREATE TRIGGER fail_frame BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND NEW.value = '2' AND EXISTS (SELECT 1 FROM _syncular_base_tasks WHERE id = 'second') BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END").unwrap(),
                    "commit" => client.conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE frame_parent(id INTEGER PRIMARY KEY); CREATE TABLE frame_child(id INTEGER REFERENCES frame_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_frame AFTER INSERT ON _syncular_base_tasks WHEN NEW.id = 'second' BEGIN INSERT INTO frame_child VALUES(1); END").unwrap(),
                    "cursor" => client.conn.execute_batch("CREATE TRIGGER fail_frame BEFORE INSERT ON _syncular_subscriptions BEGIN SELECT RAISE(FAIL, 'injected cursor failure'); END").unwrap(),
                    "error" => {response.frames.truncate(3);response.frames.push(Frame::Error {code:"sync.invalid_request".into(),message:"later error".into(),category:"protocol".into(),retryable:false,recommended_action:"retry".into(),details:None});},
                    "missing-end" => {response.frames.truncate(3);},
                    _ => {}
                }
                if realtime {
                    client.on_realtime_binary(&mut transport, &encode_message(&response));
                } else {
                    assert_eq!(
                        matches!(
                            client.process_response(&mut transport, response, &meta),
                            SyncOutcome::Ok(_)
                        ),
                        fault == "none",
                        "{fault}"
                    );
                }
                assert!(
                    client.conn.is_autocommit(),
                    "no open transaction after {realtime}/{fault}"
                );
                let count = if matches!(fault, "none" | "cursor") {
                    2
                } else {
                    1
                };
                let expected_revision = count + u64::from(realtime && fault != "none");
                assert_eq!(
                    client.local_revision(),
                    expected_revision,
                    "{realtime}/{fault}"
                );
                let batches = client.drain_change_batches();
                assert_eq!(
                    batches.len(),
                    expected_revision as usize,
                    "{realtime}/{fault}"
                );
                let row_batches: Vec<_> = batches
                    .iter()
                    .filter(|batch| !batch.tables.is_empty())
                    .collect();
                assert_eq!(row_batches.len(), count as usize);
                assert_eq!(
                    row_batches
                        .iter()
                        .map(|b| b.revision.clone())
                        .collect::<Vec<_>>(),
                    (1..=count).map(|r| r.to_string()).collect::<Vec<_>>()
                );
                for table in ["tasks", "_syncular_base_tasks"] {
                    assert_eq!(
                        client
                            .conn
                            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                                .get::<_, u64>(0))
                            .unwrap(),
                        count,
                        "{realtime}/{fault}/{table}"
                    );
                }
                assert_eq!(client.subs[0].cursor, if fault == "none" { 2 } else { 0 });
                assert_eq!(
                    transport
                        .messages
                        .iter()
                        .filter(|m| m.contains("\"ack\""))
                        .count(),
                    usize::from(fault == "none")
                );
                if matches!(fault, "revision" | "commit" | "cursor") {
                    client
                        .conn
                        .execute_batch("DROP TRIGGER fail_frame")
                        .unwrap();
                }
                drop(client);
                let mut reopened = SyncClient::open_path(
                    "frame-test".into(),
                    &schema,
                    Default::default(),
                    path.to_str().unwrap(),
                )
                .unwrap();
                assert_eq!(reopened.local_revision(), expected_revision);
                assert_eq!(
                    reopened
                        .query("SELECT id FROM tasks ORDER BY id", &[])
                        .unwrap()
                        .len(),
                    count as usize
                );
                assert_eq!(reopened.subs[0].cursor, if fault == "none" { 2 } else { 0 });
                let (_, meta) = reopened.build_request(false).unwrap();
                assert!(matches!(
                    reopened.process_response(&mut transport, valid, &meta),
                    SyncOutcome::Ok(_)
                ));
                assert_eq!(
                    reopened
                        .query("SELECT id FROM tasks ORDER BY id", &[])
                        .unwrap()
                        .len(),
                    2
                );
                assert_eq!(reopened.subs[0].cursor, 2);
                drop(reopened);
                std::fs::remove_file(path).unwrap();
            }
        }
    }

    #[test]
    fn failed_subscription_control_persistence_rolls_back_rows_outbox_and_memory() {
        for status in [SubStatus::Reset, SubStatus::Revoked] {
            for fault in ["subscription", "revision"] {
                let mut client = client();
                client
                    .subscribe(
                        "tasks".into(),
                        "tasks".into(),
                        vec![("project_id".into(), vec!["p1".into()])],
                        None,
                    )
                    .unwrap();
                client.subs[0].cursor = 41;
                client.subs[0].synced_once = true;
                client.subs[0].effective = Some(vec![("project_id".into(), vec!["p1".into()])]);
                client.persist_sub(&client.subs[0]).unwrap();
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "tasks".into(),
                        values: Map::from_iter([
                            ("id".into(), Value::from("pending")),
                            ("project_id".into(), Value::from("p1")),
                        ]),
                        base_version: None,
                    }])
                    .unwrap();
                let ids = client.pending_commit_ids();
                let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
                let revision = client.local_revision();
                client.drain_change_batches();
                let (_, meta) = client.build_request(false).unwrap();
                client.conn.execute_batch(if fault == "subscription" {
                    "CREATE TRIGGER fail_control BEFORE INSERT ON _syncular_subscriptions BEGIN SELECT RAISE(FAIL, 'injected subscription failure'); END"
                } else {
                    "CREATE TRIGGER fail_control BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END"
                }).unwrap();
                let mut transport = CountingRealtimeTransport::default();
                let mut report = SyncReport::default();
                // Reset changes window completeness and therefore needs a revision.
                if status == SubStatus::Reset {
                    client.conn.execute("INSERT INTO _syncular_windows(base,unit,sub_id) VALUES ('base','p1','tasks')", []).unwrap();
                }
                let result = client.process_section(
                    &mut transport,
                    "tasks",
                    status,
                    "sync.scope_revoked",
                    vec![],
                    vec![],
                    Some((42, None)),
                    &meta,
                    &mut report,
                );
                assert!(result.is_err(), "{status:?}/{fault}");
                assert!(client.conn.is_autocommit());
                assert_eq!(client.subs[0].cursor, 41);
                assert_eq!(client.subs[0].state, SubState::Active);
                assert_eq!(client.pending_commit_ids(), ids);
                assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
                assert!(client.rejections.is_empty());
                assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
                assert_eq!(client.local_revision(), revision);
                assert!(client.drain_change_batches().is_empty());
                assert!(report.revoked.is_empty() && report.resets.is_empty());
            }
        }
    }

    #[test]
    fn rows_segment_blocks_commit_independently_and_clear_with_the_first_block() {
        let mut client = client();
        client
            .subscribe(
                "tasks".into(),
                "tasks".into(),
                vec![("project_id".into(), vec!["p1".into()])],
                None,
            )
            .unwrap();
        client.subs[0].effective = Some(vec![("project_id".into(), vec!["p1".into()])]);
        client.conn.execute_batch("INSERT INTO _syncular_base_tasks VALUES ('stale','p1',1); INSERT INTO tasks VALUES ('stale','p1',1);
            CREATE TRIGGER fail_block BEFORE INSERT ON _syncular_base_tasks WHEN NEW.id = 'bad' BEGIN SELECT RAISE(FAIL,'injected later block failure'); END").unwrap();
        let row = |id: &str| ssp2::segment::SegmentRow {
            server_version: 1,
            values: vec![
                Some(ColumnValue::String(id.into())),
                Some(ColumnValue::String("p1".into())),
            ],
        };
        let segment = RowsSegment {
            table: "tasks".into(),
            schema_version: 1,
            columns: client.schema.table("tasks").unwrap().wire_columns.clone(),
            blocks: vec![vec![row("first")], vec![row("second"), row("bad")]],
        };
        assert!(client.apply_segment(0, &segment, true).is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(
            client
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .unwrap(),
            vec![Map::from_iter([("id".into(), Value::from("first"))])]
        );
        assert_eq!(client.local_revision(), 1);
        assert_eq!(client.drain_change_batches().len(), 1);
        assert_eq!(client.subs[0].cursor, -1);
        client
            .conn
            .execute_batch("DROP TRIGGER fail_block")
            .unwrap();
        assert!(matches!(client.apply_segment(0, &segment, true), Ok(3)));
        assert_eq!(client.local_revision(), 3);
        assert_eq!(client.drain_change_batches().len(), 2);
    }

    #[test]
    fn diagnostic_storage_reads_fresh_aggregates_after_writes_rollback_and_schema_changes() {
        assert_eq!(
            client().diagnostics_storage().blob_cache_bytes_approx,
            Some(0)
        );
        let client = SyncClient::new(
            "diagnostic-storage".to_owned(),
            &json!({
                "version": 1, "tables": [{"name": "attachments", "primaryKey": "id",
                    "columns": [{"name": "id", "type": "string", "nullable": false},
                        {"name": "body", "type": "blob_ref", "nullable": false}], "scopes": []}]
            }),
            ClientLimits {
                blob_cache_max_bytes: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        let empty = client.diagnostics_storage();
        assert_eq!(empty.status, "healthy");
        assert_eq!(empty.pending_outbox_bytes_approx, Some(0));
        assert_eq!(empty.retained_outcome_entries, Some(0));
        assert_eq!(empty.retained_outcome_bytes_approx, Some(0));
        assert_eq!(empty.blob_cache_bytes_approx, Some(0));
        client.conn.execute_batch("INSERT INTO _syncular_outbox(commit_id, ops_json) VALUES ('one', '[]');
            INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results_json,operations_json)
                VALUES ('one','applied',0,'[]',NULL),('two','rejected',0,'[]','[]');
            INSERT INTO _syncular_blobs(blob_id,bytes,byte_length,media_type,created_at_ms)
                VALUES ('body',zeroblob(8),8,NULL,0);").unwrap();
        let written = client.diagnostics_storage();
        assert_eq!(written.status, "pressure");
        assert_eq!(written.pending_outbox_bytes_approx, Some(2));
        assert_eq!(written.retained_outcome_entries, Some(2));
        assert_eq!(written.retained_outcome_bytes_approx, Some(6));
        assert_eq!(written.blob_cache_bytes_approx, Some(8));
        assert_eq!(
            written.pressure_reason_code.as_deref(),
            Some("client.blob_cache_over_limit")
        );
        client
            .conn
            .execute_batch(
                "BEGIN; UPDATE _syncular_outbox SET ops_json = '[1,2]';
            DELETE FROM _syncular_commit_outcomes; DELETE FROM _syncular_blobs;",
            )
            .unwrap();
        let staged = client.diagnostics_storage();
        assert_eq!(staged.pending_outbox_bytes_approx, Some(5));
        assert_eq!(staged.retained_outcome_entries, Some(0));
        assert_eq!(staged.blob_cache_bytes_approx, Some(0));
        assert_eq!(staged.status, "healthy");
        client.conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(client.diagnostics_storage(), written);
        client.conn.execute_batch("ALTER TABLE _syncular_commit_outcomes RENAME COLUMN results_json TO hidden_results").unwrap();
        let unreadable = client.diagnostics_storage();
        assert_eq!(unreadable.status, "unreadable");
        assert!(unreadable.database_bytes_approx.is_none());
        assert!(unreadable.pending_outbox_bytes_approx.is_none());
        assert!(unreadable.retained_outcome_entries.is_none());
        assert!(unreadable.retained_outcome_bytes_approx.is_none());
        assert!(unreadable.blob_cache_bytes_approx.is_none());
        client.conn.execute_batch("ALTER TABLE _syncular_commit_outcomes RENAME COLUMN hidden_results TO results_json").unwrap();
        let restored = client.diagnostics_storage();
        assert_eq!(restored.status, written.status);
        assert_eq!(
            restored.retained_outcome_bytes_approx,
            written.retained_outcome_bytes_approx
        );
        client.conn.set_prepared_statement_cache_capacity(0);
        assert_eq!(client.diagnostics_storage(), restored);
    }

    /// Answers every round with one server `ERROR` frame (§1.6).
    struct ServerErrorTransport {
        code: &'static str,
        retryable: bool,
    }

    impl Transport for ServerErrorTransport {
        fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            Ok(encode_message(&Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![
                    Frame::RespHeader {
                        required_schema_version: None,
                        latest_schema_version: None,
                        log_epoch: Some("epoch-1".to_owned()),
                        reset_required: Some(false),
                    },
                    Frame::Error {
                        code: self.code.to_owned(),
                        message: "server error".to_owned(),
                        category: "internal".to_owned(),
                        retryable: self.retryable,
                        recommended_action: "retryLater".to_owned(),
                        details: None,
                    },
                ],
            }))
        }

        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.sync(request)
        }

        fn download_segment(
            &mut self,
            _request: &SegmentRequest,
            _on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[test]
    fn retryable_server_error_schedules_a_background_retry() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        let mut transport = ServerErrorTransport {
            code: "sync.internal_error",
            retryable: true,
        };
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"
        ));
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ));
        assert_eq!(
            client.progress().snapshot().unwrap().retry_delay_ms,
            Some(250)
        );
        let mut transport = ServerErrorTransport {
            code: "sync.invalid_request",
            retryable: false,
        };
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.invalid_request"
        ));
        assert!(client.drain_sync_intents().is_empty());
        let progress = client.progress().snapshot().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert_eq!(progress.retry_delay_ms, None);
    }

    #[test]
    fn sync_until_idle_reports_budget_exhaustion_or_failure() {
        // §7.7: the exhausted outcome is a partial success, not a failure,
        // and serializes with an explicit flag.
        let exhausted = SyncOutcome::BudgetExhausted(SyncReport::default()).to_json();
        assert_eq!(exhausted["ok"], json!(true));
        assert_eq!(exhausted["budgetExhausted"], json!(true));
        assert!(exhausted["report"].is_object());

        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        // Zero explicit budget is a caller error, not an exhaustion.
        let mut idle_transport = HostTransport::new_from_config(&json!({})).unwrap();
        let zero = client.sync_until_idle(&mut idle_transport, Some(0));
        assert!(
            matches!(zero, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.invalid_request"),
            "{zero:?}"
        );
        // A real server failure stays a failure across the budget loop.
        let mut erroring = ServerErrorTransport {
            code: "sync.internal_error",
            retryable: false,
        };
        let failed = client.sync_until_idle(&mut erroring, Some(3));
        assert!(
            matches!(failed, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"),
            "{failed:?}"
        );
    }

    /// Returns one pre-built response per round so a test can pin a successful
    /// work-bearing round followed by a failure or a schema floor.
    struct ScriptedSyncTransport {
        responses: std::collections::VecDeque<Message>,
        calls: usize,
    }

    impl Transport for ScriptedSyncTransport {
        fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.calls += 1;
            let response = self.responses.pop_front().expect("scripted response");
            Ok(encode_message(&response))
        }

        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.sync(request)
        }

        fn download_segment(
            &mut self,
            _request: &SegmentRequest,
            _on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[test]
    fn sync_until_idle_success_then_failure_keeps_earlier_work() {
        let path = std::env::temp_dir().join(format!(
            "syncular-budget-script-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client = SyncClient::open_path(
            "budget-script".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client");
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        client
            .subscribe(
                "tasks".into(),
                "tasks".into(),
                vec![("project_id".into(), vec!["p1".into()])],
                None,
            )
            .unwrap();
        client.subs[0].cursor = 0;
        client.subs[0].synced_once = true;
        client.subs[0].effective = Some(vec![("project_id".into(), vec!["p1".into()])]);
        client.persist_sub(&client.subs[0]).unwrap();
        client.drain_change_batches();

        let row = encode_row_json(
            client.schema.table("tasks").unwrap(),
            "kept",
            &Map::from_iter([
                ("id".into(), json!("kept")),
                ("project_id".into(), json!("p1")),
            ]),
            &client.encryption,
        )
        .unwrap();
        let success = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-1".into()),
                    reset_required: Some(false),
                },
                Frame::SubStart {
                    id: "tasks".into(),
                    status: SubStatus::Active,
                    reason_code: String::new(),
                    effective_scopes: vec![("project_id".into(), vec!["p1".into()])],
                    bootstrap: false,
                },
                Frame::Commit {
                    commit_seq: 1,
                    created_at_ms: 1,
                    actor_id: "writer".into(),
                    tables: vec!["tasks".into()],
                    changes: vec![ssp2::model::Change {
                        table_index: 0,
                        row_id: "kept".into(),
                        op: Op::Upsert,
                        row_version: Some(1),
                        scopes: vec![("project_id".into(), "p1".into())],
                        row: Some(row),
                    }],
                },
                Frame::SubEnd {
                    next_cursor: 1,
                    bootstrap_state: None,
                },
            ],
        };
        let failure = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-1".into()),
                    reset_required: Some(false),
                },
                Frame::Error {
                    code: "sync.internal_error".into(),
                    message: "second round failed".into(),
                    category: "internal".into(),
                    retryable: false,
                    recommended_action: "retryLater".into(),
                    details: None,
                },
            ],
        };
        let mut transport = ScriptedSyncTransport {
            responses: std::collections::VecDeque::from([success, failure]),
            calls: 0,
        };
        let outcome = client.sync_until_idle(&mut transport, Some(2));
        assert!(
            matches!(outcome, SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.internal_error"),
            "{outcome:?}"
        );
        assert_eq!(
            transport.calls, 2,
            "one successful round then the failing round"
        );
        assert_eq!(
            client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
            json!("kept"),
            "the earlier round's durable work survives the later failure"
        );
        drop(client);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sync_until_idle_stops_on_a_schema_floor() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        let floor = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version: Some(2),
                latest_schema_version: Some(2),
                log_epoch: Some("epoch-1".into()),
                reset_required: Some(false),
            }],
        };
        let mut transport = ScriptedSyncTransport {
            responses: std::collections::VecDeque::from([floor.clone(), floor]),
            calls: 0,
        };
        let outcome = client.sync_until_idle(&mut transport, Some(3));
        match outcome {
            SyncOutcome::Ok(report) => assert_eq!(
                report
                    .schema_floor
                    .as_ref()
                    .and_then(|floor| floor.required_schema_version),
                Some(2),
                "the stop retains the latest schema floor"
            ),
            other => panic!("expected a schema-floor stop, got {other:?}"),
        }
        assert_eq!(
            transport.calls, 1,
            "a schema floor stops the budget loop after one round"
        );
    }

    #[test]
    fn sync_report_merge_schema_floor_is_latest_state() {
        let mut aggregate = SyncReport {
            schema_floor: Some(SchemaFloor {
                required_schema_version: Some(2),
                latest_schema_version: Some(2),
            }),
            ..SyncReport::default()
        };
        aggregate.merge(&SyncReport::default());
        assert!(
            aggregate.schema_floor.is_none(),
            "a later round without a floor clears it"
        );
    }

    #[test]
    fn push_capacity_limits_are_hard_and_keep_intent() {
        // The configured operation cap is hard for the first commit.
        let mut c = client();
        c.set_meta(LOG_EPOCH_KEY, "epoch-1");
        c.limits.max_push_operations_per_request = Some(1);
        let id = c
            .mutate(vec![
                Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("a")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                },
                Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("b")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                },
            ])
            .unwrap();
        let error = c.build_request(false).unwrap_err();
        let SyncOutcome::Failed {
            error_code,
            details,
            ..
        } = *error
        else {
            panic!("expected a capacity failure");
        };
        assert_eq!(error_code, "client.push_request_too_large");
        let details = details.expect("capacity details");
        assert_eq!(details["kind"], json!("operations"));
        assert_eq!(details["limit"], json!(1));
        assert_eq!(details["size"], json!(2));
        assert_eq!(details["clientCommitId"], json!(id));
        assert_eq!(c.pending_commit_ids(), vec![id]);

        // The commit-count cap defers whole later commits.
        let mut c = client();
        c.set_meta(LOG_EPOCH_KEY, "epoch-1");
        c.limits.max_push_commits_per_request = Some(1);
        let first = c
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("one")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let second = c
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("two")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let (_, meta) = c.build_request(false).unwrap();
        assert_eq!(meta.pushed_ids, vec![first.clone()]);
        assert_eq!(meta.deferred_commits, 1);
        assert_eq!(c.pending_commit_ids(), vec![first, second]);
    }

    #[test]
    fn push_request_byte_cap_defers_the_prefix_boundary_and_errors_the_head() {
        // Two small commits: a cap just below the full request defers the
        // last commit and sends the fitting prefix (header + first commit).
        let mut c = client();
        c.set_meta(LOG_EPOCH_KEY, "epoch-1");
        let first = c
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("one")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let second = c
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("two")),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let (message, meta) = c.build_request(false).unwrap();
        assert_eq!(meta.pushed_ids.len(), 2);
        let full = encode_message(&message).len();
        c.limits.max_push_request_bytes = Some(full - 1);
        let (_, meta) = c.build_request(false).unwrap();
        assert_eq!(meta.pushed_ids, vec![first.clone()]);
        assert_eq!(meta.deferred_commits, 1);
        assert_eq!(c.pending_commit_ids(), vec![first, second]);

        // A single commit larger than the budget is a typed capacity error and
        // stays queued, reporting the full projected request size.
        let mut c = client();
        c.set_meta(LOG_EPOCH_KEY, "epoch-1");
        let huge = c
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("x".repeat(20_000))),
                    ("project_id".into(), json!("p1")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let (message, meta) = c.build_request(false).unwrap();
        assert_eq!(meta.pushed_ids, vec![huge.clone()]);
        let with_huge = encode_message(&message).len();
        c.limits.max_push_request_bytes = Some(with_huge - 1);
        let error = c.build_request(false).unwrap_err();
        let SyncOutcome::Failed {
            error_code,
            details,
            ..
        } = *error
        else {
            panic!("expected a capacity failure");
        };
        assert_eq!(error_code, "client.push_request_too_large");
        let details = details.expect("capacity details");
        assert_eq!(details["kind"], json!("bytes"));
        assert_eq!(details["limit"], json!((with_huge - 1) as u64));
        assert_eq!(details["size"], json!(with_huge as u64));
        assert_eq!(details["clientCommitId"], json!(huge));
        assert_eq!(c.pending_commit_ids(), vec![huge]);

        // A cap smaller than the fixed frames reports no blocked commit.
        let mut c = client();
        c.set_meta(LOG_EPOCH_KEY, "epoch-1");
        c.limits.max_push_request_bytes = Some(1);
        let error = c.build_request(false).unwrap_err();
        let SyncOutcome::Failed { details, .. } = *error else {
            panic!("expected a capacity failure");
        };
        let details = details.expect("capacity details");
        assert_eq!(details["kind"], json!("bytes"));
        assert!(details.get("clientCommitId").is_none(), "{details}");
    }

    #[test]
    fn push_limits_validate_at_construction() {
        for limits in [
            ClientLimits {
                max_push_commits_per_request: Some(0),
                ..Default::default()
            },
            ClientLimits {
                max_push_operations_per_request: Some(0),
                ..Default::default()
            },
            ClientLimits {
                max_push_request_bytes: Some(0),
                ..Default::default()
            },
            ClientLimits {
                max_push_request_bytes: Some(u32::MAX as usize + 1),
                ..Default::default()
            },
        ] {
            let schema = json!({"version":1,"tables":[]});
            let error = SyncClient::with_connection(
                "bad-limits".into(),
                &schema,
                limits,
                Connection::open_in_memory().unwrap(),
            )
            .err();
            assert_eq!(
                error.as_deref(),
                Some("sync.invalid_request: push limit must be an integer in 1..=4294967295")
            );
        }
    }

    #[test]
    fn open_path_rejects_invalid_push_limits_before_storage() {
        for identity in [false, true] {
            let path = std::env::temp_dir().join(format!(
                "syncular-bad-limits-{}.sqlite",
                uuid::Uuid::new_v4()
            ));
            let schema = json!({"version":1,"tables":[]});
            let limits = ClientLimits {
                max_push_request_bytes: Some(0),
                ..Default::default()
            };
            let error = if identity {
                SyncClient::open_path_with_identity(None, &schema, limits, path.to_str().unwrap())
            } else {
                SyncClient::open_path("bad-limits".into(), &schema, limits, path.to_str().unwrap())
            }
            .err();
            assert_eq!(
                error.as_deref(),
                Some("sync.invalid_request: push limit must be an integer in 1..=4294967295")
            );
            assert!(
                !path.exists(),
                "an invalid limit is rejected before the database file is created"
            );
        }
    }

    #[test]
    fn failed_progress_retry_delay_doubles_to_the_cap() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        let mut transport = ServerErrorTransport {
            code: "sync.internal_error",
            retryable: true,
        };
        let delays: Vec<Option<u64>> = (0..9)
            .map(|_| {
                client.sync(&mut transport);
                client.progress().snapshot().unwrap().retry_delay_ms
            })
            .collect();
        assert_eq!(
            delays,
            [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].map(Some)
        );
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
    fn log_epoch_reset_requests_an_immediate_follow_up_round() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        client
            .subscribe(
                "epoch-tasks".to_owned(),
                "tasks".to_owned(),
                vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                None,
            )
            .expect("subscribe");
        client.drain_sync_intents();

        client
            .run_log_epoch_reset("epoch-2")
            .expect("reset partition log epoch");

        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
    }

    #[derive(Default)]
    struct CountingRealtimeTransport {
        connects: usize,
        closes: usize,
        messages: Vec<String>,
        blob_uploads: Vec<(String, Vec<u8>)>,
        blob_download: Option<Vec<u8>>,
        sync_calls: usize,
        realtime_sync_calls: usize,
        refuse_connect: bool,
    }

    impl Transport for CountingRealtimeTransport {
        fn blob_upload(
            &mut self,
            blob_id: &str,
            bytes: &[u8],
            _media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            self.blob_uploads.push((blob_id.to_owned(), bytes.to_vec()));
            Ok(())
        }

        fn blob_download(&mut self, _blob_id: &str) -> Result<BlobDownload, TransportError> {
            self.blob_download
                .clone()
                .map(BlobDownload::Bytes)
                .ok_or_else(|| TransportError::new("blob.not_found", "missing blob"))
        }

        fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.sync_calls += 1;
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.realtime_sync_calls += 1;
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn download_segment(
            &mut self,
            _request: &SegmentRequest,
            _on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            self.connects += 1;
            if self.refuse_connect {
                return Err(TransportError::new("transport.failed", "refused"));
            }
            Ok(())
        }

        fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
            self.messages.push(text.to_owned());
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            self.closes += 1;
            Ok(())
        }
    }

    #[test]
    fn blob_results_own_downloaded_bytes() {
        let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
        let bytes = b"owned typed result".to_vec();
        let blob_id = blob_id_for(&bytes);
        let mut transport = CountingRealtimeTransport {
            blob_download: Some(bytes.clone()),
            ..Default::default()
        };
        let result = {
            let mut client =
                SyncClient::new("owned-result".to_owned(), &schema, ClientLimits::default())
                    .unwrap();
            let result = client.fetch_blob_bytes(&mut transport, &blob_id).unwrap();
            assert_eq!(result.blob_id, blob_id);
            assert_eq!(result.byte_length, bytes.len() as i64);
            assert_eq!(result.bytes, bytes);
            assert_eq!(result.media_type, None);
            assert_eq!(
                client
                    .conn
                    .query_row(
                        "SELECT count(*) FROM _syncular_blob_uploads WHERE blob_id = ?",
                        rusqlite::params![blob_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0
            );
            result
        };
        assert_eq!(result.bytes, bytes);

        let mut client =
            SyncClient::new("blob-errors".to_owned(), &schema, ClientLimits::default()).unwrap();
        assert_eq!(
            client
                .fetch_blob_bytes(&mut transport, "not json")
                .unwrap_err(),
            (
                "client.failed".to_owned(),
                "blob ref is not JSON".to_owned()
            )
        );
    }

    #[test]
    fn visible_blob_references_survive_cache_trimming() {
        let schema = json!({"version":1,"tables":[
            {"name":"attachments","primaryKey":"id","columns":[
                {"name":"id","type":"string","nullable":false},
                {"name":"body","type":"blob_ref","nullable":true},
                {"name":"preview","type":"blob_ref","nullable":true}],"scopes":[]},
            {"name":"avatars","primaryKey":"id","columns":[
                {"name":"id","type":"string","nullable":false},
                {"name":"photo","type":"blob_ref","nullable":true}],"scopes":[]}
        ]});
        let bytes = b"referenced above cap".to_vec();
        let blob_id = blob_id_for(&bytes);
        let reference = json!({"blobId": blob_id, "byteLength": bytes.len()}).to_string();
        let mut client = SyncClient::new(
            "visible-blob-refs".to_owned(),
            &schema,
            ClientLimits {
                blob_cache_max_bytes: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        client.conn.execute(
            "INSERT INTO attachments VALUES ('one', ?, ?, 0), ('two', ?, 'malformed', 0), ('three', 12, ?, 0)",
            rusqlite::params![reference, reference, reference, reference],
        ).unwrap();
        client
            .conn
            .execute(
                "INSERT INTO avatars VALUES ('one', ?, 0), ('two', '{\"blobId\":12}', 0)",
                rusqlite::params![reference],
            )
            .unwrap();
        client.conn.execute(
            "INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES ('sha256:other', X'02', 1, NULL, 0)",
            [],
        ).unwrap();
        let mut transport = CountingRealtimeTransport {
            blob_download: Some(bytes.clone()),
            ..Default::default()
        };

        assert_eq!(
            client
                .fetch_blob_bytes(&mut transport, &blob_id)
                .unwrap()
                .bytes,
            bytes
        );
        let rows = client
            .conn
            .prepare("SELECT blob_id FROM _syncular_blobs ORDER BY blob_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows, vec![blob_id]);
    }

    #[test]
    fn closed_transport_never_invokes_network_and_reopen_is_host_owned() {
        let mut transport = CountingRealtimeTransport::default();
        let path = std::env::temp_dir().join(format!(
            "syncular-transport-gate-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false}],"scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client = SyncClient::open_path(
            "gate".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        client.connect_realtime(&mut transport).unwrap();
        client.set_transport_enabled(&mut transport, false);
        assert_eq!(transport.closes, 1);
        client.begin_security_preflight();
        client.activate_security(Default::default()).unwrap();
        client
            .subscribe(
                "tasks".into(),
                "tasks".into(),
                vec![("project_id".into(), vec!["p1".into()])],
                None,
            )
            .unwrap();
        for id in ["one", "two"] {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!(id)),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
        }
        assert_eq!(
            client
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .unwrap()
                .len(),
            2
        );
        assert!(
            matches!(client.sync(&mut transport), SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.offline")
        );
        assert!(client
            .connect_realtime(&mut transport)
            .unwrap_err()
            .starts_with("sync.offline:"));
        assert!(client
            .set_presence(&mut transport, "project:p1", None)
            .unwrap_err()
            .starts_with("sync.offline:"));
        assert_eq!(transport.sync_calls, 0);
        assert_eq!(transport.realtime_sync_calls, 0);
        assert_eq!(transport.connects, 1);
        assert!(transport.messages.is_empty());
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::None]
        ));
        let pending = client.pending_commit_ids();
        drop(client);
        let mut reopened = SyncClient::open_path(
            "gate".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        assert!(reopened.transport_enabled());
        reopened.set_transport_enabled(&mut transport, false);
        assert_eq!(reopened.pending_commit_ids(), pending);
        assert_eq!(
            reopened.query("SELECT id FROM tasks", &[]).unwrap().len(),
            2
        );
        reopened.set_transport_enabled(&mut transport, true);
        assert!(matches!(
            reopened.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
        reopened.set_transport_enabled(&mut transport, true);
        assert!(reopened.drain_sync_intents().is_empty());
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn realtime_connection_ownership_is_idempotent() {
        let mut client = client();
        let mut transport = CountingRealtimeTransport {
            connects: 0,
            closes: 0,
            ..Default::default()
        };
        client
            .connect_realtime(&mut transport)
            .expect("first connect");
        client
            .connect_realtime(&mut transport)
            .expect("idempotent connect");
        assert_eq!(transport.connects, 1);
        client.disconnect_realtime(&mut transport);
        client.disconnect_realtime(&mut transport);
        assert_eq!(transport.closes, 1);
        client
            .connect_realtime(&mut transport)
            .expect("deliberate reconnect");
        assert_eq!(transport.connects, 2);
    }

    #[test]
    fn required_policy_refuses_a_round_without_a_socket_and_never_uses_http() {
        let mut client = client();
        client
            .set_realtime_policy(RealtimePolicy::Required)
            .expect("set policy");
        let mut transport = CountingRealtimeTransport::default();
        match client.sync(&mut transport) {
            SyncOutcome::RealtimeUnavailable {
                state,
                reason_code,
                retry_delay_ms,
            } => {
                assert_eq!(state, RealtimeState::Disconnected);
                assert_eq!(reason_code, None);
                assert_eq!(retry_delay_ms, 250);
            }
            other => panic!("expected RealtimeUnavailable, got {other:?}"),
        }
        assert_eq!(transport.sync_calls, 0);
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Background { delay_ms: 250 }]
        ));
        let snapshot = client
            .diagnostics_snapshot(&ClientDiagnosticsRequest::default())
            .expect("diagnostics");
        assert_eq!(snapshot.host.realtime, RealtimeState::Disconnected);
        assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Required);
        assert_eq!(snapshot.host.realtime_reason_code, None);
        assert_eq!(snapshot.host.realtime_retry_delay_ms, Some(250));
        assert_eq!(
            snapshot
                .last_round
                .as_ref()
                .and_then(|round| round.error_code.clone()),
            Some(REALTIME_UNAVAILABLE_CODE.to_owned())
        );
    }

    #[test]
    fn refused_handshake_is_a_visible_state_and_a_required_round_does_not_fall_back() {
        let mut client = client();
        client
            .set_realtime_policy(RealtimePolicy::Required)
            .expect("set policy");
        let mut transport = CountingRealtimeTransport {
            refuse_connect: true,
            ..Default::default()
        };
        assert!(client.connect_realtime(&mut transport).is_err());
        assert_eq!(client.realtime_state(), RealtimeState::Refused);
        let snapshot = client
            .diagnostics_snapshot(&ClientDiagnosticsRequest::default())
            .expect("diagnostics");
        assert_eq!(
            snapshot.host.realtime_reason_code.as_deref(),
            Some("transport.failed")
        );
        match client.sync(&mut transport) {
            SyncOutcome::RealtimeUnavailable {
                state, reason_code, ..
            } => {
                assert_eq!(state, RealtimeState::Refused);
                assert_eq!(reason_code.as_deref(), Some("transport.failed"));
            }
            other => panic!("expected RealtimeUnavailable, got {other:?}"),
        }
        assert_eq!(transport.sync_calls, 0);
        assert_eq!(transport.realtime_sync_calls, 0);
    }

    #[test]
    fn a_failed_socket_round_is_lost_and_the_next_required_round_refuses_http() {
        let mut client = client();
        client
            .set_realtime_policy(RealtimePolicy::Required)
            .expect("set policy");
        let mut transport = CountingRealtimeTransport::default();
        client.connect_realtime(&mut transport).expect("connect");
        assert_eq!(client.realtime_state(), RealtimeState::Connected);
        assert!(
            client.set_realtime_policy(RealtimePolicy::Off).is_err(),
            "a policy change cannot silently re-route a connected socket"
        );
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { ref error_code, .. } if error_code == "sync.transport_failed"
        ));
        assert_eq!(client.realtime_state(), RealtimeState::Lost);
        assert_eq!(transport.realtime_sync_calls, 1);
        assert_eq!(transport.sync_calls, 0);
        let snapshot = client
            .diagnostics_snapshot(&ClientDiagnosticsRequest::default())
            .expect("diagnostics");
        assert_eq!(
            snapshot.host.realtime_reason_code.as_deref(),
            Some("sync.transport_failed")
        );
        assert_eq!(snapshot.host.realtime_retry_delay_ms, Some(250));
        match client.sync(&mut transport) {
            SyncOutcome::RealtimeUnavailable {
                state, reason_code, ..
            } => {
                assert_eq!(state, RealtimeState::Lost);
                assert_eq!(reason_code.as_deref(), Some("sync.transport_failed"));
            }
            other => panic!("expected RealtimeUnavailable, got {other:?}"),
        }
        assert_eq!(transport.sync_calls, 0);
        client.disconnect_realtime(&mut transport);
        assert_eq!(client.realtime_state(), RealtimeState::Disconnected);
        assert_eq!(transport.closes, 1);
        client.connect_realtime(&mut transport).expect("reconnect");
        assert_eq!(client.realtime_state(), RealtimeState::Connected);
        assert_eq!(transport.connects, 2);
    }

    #[test]
    fn off_policy_uses_http_and_refuses_an_explicit_connect() {
        let mut client = client();
        client
            .set_realtime_policy(RealtimePolicy::Off)
            .expect("set policy");
        let mut transport = CountingRealtimeTransport::default();
        assert!(client.connect_realtime(&mut transport).is_err());
        assert_eq!(client.realtime_state(), RealtimeState::Disabled);
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { .. }
        ));
        assert_eq!(transport.sync_calls, 1);
        assert_eq!(transport.realtime_sync_calls, 0);
        let snapshot = client
            .diagnostics_snapshot(&ClientDiagnosticsRequest::default())
            .expect("diagnostics");
        assert_eq!(snapshot.host.realtime, RealtimeState::Disabled);
        assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Off);
    }

    #[test]
    fn optional_policy_keeps_the_http_round() {
        let mut client = client();
        let mut transport = CountingRealtimeTransport::default();
        assert!(matches!(
            client.sync(&mut transport),
            SyncOutcome::Failed { .. }
        ));
        assert_eq!(transport.sync_calls, 1);
        assert_eq!(transport.realtime_sync_calls, 0);
        let snapshot = client
            .diagnostics_snapshot(&ClientDiagnosticsRequest::default())
            .expect("diagnostics");
        assert_eq!(snapshot.host.realtime, RealtimeState::Disconnected);
        assert_eq!(snapshot.host.realtime_policy, RealtimePolicy::Optional);
    }

    #[test]
    fn local_rebootstrap_is_atomic_idempotent_and_preserves_offline_work() {
        let mut client = client();
        client
            .subscribe(
                "repair-tasks".to_owned(),
                "tasks".to_owned(),
                vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                None,
            )
            .expect("subscribe");
        {
            let sub = client
                .subs
                .iter_mut()
                .find(|sub| sub.id == "repair-tasks")
                .expect("subscription");
            sub.cursor = 42;
            sub.synced_once = true;
            let persisted = sub.clone();
            client.persist_sub(&persisted).unwrap();
        }
        for table in ["_syncular_base_tasks", "tasks"] {
            client
                .conn
                .execute(
                    &format!(
                        "INSERT INTO {table}(id, project_id, _syncular_version) VALUES (?1, ?2, 1)"
                    ),
                    rusqlite::params!["server-row", "p1"],
                )
                .expect("seed server row");
        }
        let pending = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("offline-row")),
                    ("project_id".to_owned(), Value::from("p1")),
                ]),
                base_version: None,
            }])
            .expect("queue offline work");
        client.drain_change_batches();
        client.drain_sync_intents();

        assert_eq!(
            client
                .rebootstrap_local_data(&LocalDataRebootstrapInput {
                    rebootstrap_id: "support-case-001".to_owned(),
                })
                .expect("rebootstrap"),
            LocalDataRebootstrapResult {
                already_applied: false,
                retained_commits: 1,
                reset_subscriptions: 1,
            }
        );
        let visible_ids = client
            .conn
            .prepare("SELECT id FROM tasks ORDER BY id")
            .expect("prepare visible ids")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query visible ids")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect visible ids");
        assert_eq!(visible_ids, vec!["offline-row"]);
        assert_eq!(client.pending_commit_ids(), vec![pending]);
        assert_eq!(
            client
                .subscription_state("repair-tasks")
                .expect("subscription")
                .cursor,
            -1
        );
        assert!(client.upgrading());
        assert!(client.sync_needed());
        assert!(matches!(
            client.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
        assert_eq!(client.drain_change_batches().len(), 1);

        assert_eq!(
            client
                .rebootstrap_local_data(&LocalDataRebootstrapInput {
                    rebootstrap_id: "support-case-001".to_owned(),
                })
                .expect("idempotent retry"),
            LocalDataRebootstrapResult {
                already_applied: true,
                retained_commits: 1,
                reset_subscriptions: 1,
            }
        );
        assert!(client.drain_change_batches().is_empty());
    }

    #[test]
    fn local_rebootstrap_receipt_codec_is_bounded_and_legacy_compatible() {
        let encoded = encode_local_rebootstrap_receipt(3, 4).expect("encode receipt");
        assert_eq!(
            decode_local_rebootstrap_receipt(&encoded).expect("decode receipt"),
            (3, 4)
        );
        assert_eq!(
            decode_local_rebootstrap_receipt("v1").expect("legacy marker"),
            (0, 0)
        );
        for malformed in [
            "",
            "{}",
            r#"{"version":3,"retainedCommits":1,"resetSubscriptions":1}"#,
            r#"{"version":2,"retainedCommits":1,"resetSubscriptions":1,"extra":true}"#,
            r#"{"version":2,"retainedCommits":9007199254740992,"resetSubscriptions":1}"#,
        ] {
            assert_eq!(
                decode_local_rebootstrap_receipt(malformed)
                    .expect_err("malformed receipt must fail"),
                "sync.local_corrupt: persisted local rebootstrap receipt is invalid"
            );
        }
    }

    #[test]
    fn local_rebootstrap_replays_the_original_receipt_after_reopen() {
        let path = std::env::temp_dir().join(format!(
            "syncular-rebootstrap-receipt-{}.db",
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
        let path_string = path.to_str().expect("UTF-8 temp path");

        {
            let mut first = SyncClient::open_path(
                "repair-restart-client".to_owned(),
                &schema,
                ClientLimits::default(),
                path_string,
            )
            .expect("first open");
            first
                .subscribe(
                    "repair-tasks".to_owned(),
                    "tasks".to_owned(),
                    vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                    None,
                )
                .expect("subscribe");
            first
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), Value::from("offline-row")),
                        ("project_id".to_owned(), Value::from("p1")),
                    ]),
                    base_version: None,
                }])
                .expect("queue offline work");
            assert_eq!(
                first
                    .rebootstrap_local_data(&LocalDataRebootstrapInput {
                        rebootstrap_id: "restart-receipt".to_owned(),
                    })
                    .expect("first rebootstrap"),
                LocalDataRebootstrapResult {
                    already_applied: false,
                    retained_commits: 1,
                    reset_subscriptions: 1,
                }
            );
        }

        let mut reopened = SyncClient::open_path(
            "repair-restart-client".to_owned(),
            &schema,
            ClientLimits::default(),
            path_string,
        )
        .expect("reopen");
        reopened.drain_change_batches();
        reopened.drain_sync_intents();
        assert_eq!(
            reopened
                .rebootstrap_local_data(&LocalDataRebootstrapInput {
                    rebootstrap_id: "restart-receipt".to_owned(),
                })
                .expect("receipt replay"),
            LocalDataRebootstrapResult {
                already_applied: true,
                retained_commits: 1,
                reset_subscriptions: 1,
            }
        );
        assert!(reopened.drain_change_batches().is_empty());
        assert!(reopened.drain_sync_intents().is_empty());
        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn local_rebootstrap_fails_closed_on_malformed_or_unreadable_receipts() {
        let mut malformed = client();
        malformed
            .subscribe(
                "repair-tasks".to_owned(),
                "tasks".to_owned(),
                vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                None,
            )
            .expect("subscribe");
        malformed.set_meta("localRebootstrap:malformed", "{\"version\":2}");
        malformed.drain_change_batches();
        malformed.drain_sync_intents();
        let malformed_error = malformed
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "malformed".to_owned(),
            })
            .expect_err("malformed receipt must fail closed");
        assert_eq!(
            malformed_error,
            "sync.local_corrupt: persisted local rebootstrap receipt is invalid"
        );
        assert!(!malformed.upgrading());
        assert_eq!(
            malformed
                .subscription_state("repair-tasks")
                .expect("unchanged subscription")
                .cursor,
            -1
        );
        assert!(malformed.drain_change_batches().is_empty());
        assert!(malformed.drain_sync_intents().is_empty());

        let mut unreadable = client();
        unreadable
            .conn
            .execute(
                "INSERT INTO tasks(id, project_id, _syncular_version) VALUES (?1, ?2, 1)",
                rusqlite::params!["server-row", "p1"],
            )
            .expect("seed visible row");
        unreadable
            .conn
            .execute("DROP TABLE _syncular_meta", [])
            .expect("break marker storage");
        let unreadable_error = unreadable
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "unreadable".to_owned(),
            })
            .expect_err("unreadable marker storage must fail closed");
        assert_eq!(
            unreadable_error,
            "sync.local_corrupt: persisted local rebootstrap receipt is unreadable"
        );
        let visible_rows = unreadable
            .conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
            .expect("visible projection remains");
        assert_eq!(visible_rows, 1);
        assert!(!unreadable.upgrading());
        assert!(unreadable.drain_change_batches().is_empty());
        assert!(unreadable.drain_sync_intents().is_empty());
    }

    #[test]
    fn local_rebootstrap_cannot_bypass_schema_floor() {
        let mut client = client();
        client.set_schema_floor(Some(SchemaFloor {
            required_schema_version: Some(2),
            latest_schema_version: Some(2),
        }));
        let error = client
            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                rebootstrap_id: "blocked-floor".to_owned(),
            })
            .expect_err("schema floor must block repair");
        assert!(error.contains("cannot bypass an active schema-floor stop"));
    }

    #[test]
    fn diego_applied_sparse_moves_stay_visible_until_pull_image_arrives() {
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
            "columns":[{"name":"id","type":"string","nullable":false},
                {"name":"project_id","type":"string","nullable":false},
                {"name":"starts_at_ms","type":"integer","nullable":false},
                {"name":"version","type":"integer","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client =
            SyncClient::new("diego-ack-gap".into(), &schema, ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("t1".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::Integer(100)),
                    Some(ColumnValue::Integer(1)),
                ],
                1,
            )
            .unwrap();
        client.rebuild_overlay().expect("rebuild overlay");
        let first = client
            .patch(
                "tasks",
                "t1",
                Map::from_iter([
                    ("starts_at_ms".into(), json!(200)),
                    ("version".into(), json!(2)),
                ]),
                None,
            )
            .unwrap();
        let (_, first_request) = client.build_request(false).unwrap();
        // This second edit happens while the first request is in flight.
        let second = client
            .patch(
                "tasks",
                "t1",
                Map::from_iter([
                    ("starts_at_ms".into(), json!(300)),
                    ("version".into(), json!(3)),
                ]),
                None,
            )
            .unwrap();
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        for (id, seq, meta) in [
            (first, 2, first_request),
            (second, 3, client.build_request(false).unwrap().1),
        ] {
            let response = Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![
                    Frame::RespHeader {
                        required_schema_version: None,
                        latest_schema_version: None,
                        log_epoch: Some("epoch-1".into()),
                        reset_required: Some(false),
                    },
                    Frame::PushResult {
                        client_commit_id: id,
                        status: PushStatus::Applied,
                        commit_seq: Some(seq),
                        results: vec![OpResult::Applied { op_index: 0 }],
                    },
                ],
            };
            assert!(matches!(
                client.process_response(&mut transport, response, &meta),
                SyncOutcome::Ok(_)
            ));
            let row = &client
                .query("SELECT starts_at_ms, version FROM tasks WHERE id='t1'", &[])
                .unwrap()[0];
            assert_eq!(
                row["starts_at_ms"],
                json!(300),
                "an applied ACK without a pull image must not expose the old base"
            );
            assert_eq!(
                row["version"],
                json!(3),
                "the queued domain version must remain monotonic"
            );
        }
    }

    #[test]
    fn first_epoch_acquisition_preserves_tables_subscriptions_and_local_intent() {
        for stored in [None, Some("epoch-old")] {
            let mut client = client();
            client
                .subscribe(
                    "tasks".into(),
                    "tasks".into(),
                    vec![("project_id".into(), vec!["p1".into()])],
                    None,
                )
                .unwrap();
            client
                .conn
                .execute_batch(
                    "CREATE TRIGGER epoch_table_identity AFTER INSERT ON tasks BEGIN SELECT 1; END",
                )
                .unwrap();
            let id = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("offline")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            if let Some(epoch) = stored {
                client.set_meta(LOG_EPOCH_KEY, epoch);
            }
            let before = serde_json::to_value(client.subscription_state("tasks")).unwrap();
            let (_, meta) = client.build_request(false).unwrap();
            client.drain_change_batches();
            client.drain_sync_intents();
            let response = Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-new".into()),
                    reset_required: Some(true),
                }],
            };
            let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
            let outcome = client.process_response(&mut transport, response, &meta);
            let SyncOutcome::Ok(report) = outcome else {
                panic!("epoch round failed: {outcome:?}");
            };
            assert_eq!(
                report.resets,
                if stored.is_none() {
                    Vec::<String>::new()
                } else {
                    vec!["tasks".into()]
                }
            );
            assert_eq!(client.get_meta(LOG_EPOCH_KEY).as_deref(), Some("epoch-new"));
            assert_eq!(client.pending_commit_ids(), vec![id]);
            assert_eq!(
                client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
                json!("offline")
            );
            let trigger: i64 = client
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='epoch_table_identity'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if stored.is_none() {
                assert!(!client.upgrading);
                assert!(client
                    .drain_change_batches()
                    .iter()
                    .all(|batch| batch.status.as_ref().is_none_or(|status| !status.upgrading)));
                assert_eq!(
                    serde_json::to_value(client.subscription_state("tasks")).unwrap(),
                    before
                );
                assert_eq!(trigger, 1, "acquisition must not drop the synced table");
            } else {
                assert!(client.upgrading);
                assert_eq!(trigger, 0, "an epoch change must drop the old table");
            }
            assert!(matches!(
                client.drain_sync_intents().as_slice(),
                [SyncIntent::Interactive]
            ));
        }
    }

    #[test]
    fn epoch_acquisition_storage_failures_preserve_ready_state_and_intent() {
        for key in ["logEpoch", "localRevision"] {
            let mut client = client();
            let id = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("offline")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let revision = client.local_revision();
            let needed = client.sync_needed;
            client.drain_change_batches();
            client.drain_sync_intents();
            client.conn.execute_batch(&format!("CREATE TRIGGER fail_acquisition BEFORE INSERT ON _syncular_meta WHEN NEW.key='{key}' BEGIN SELECT RAISE(FAIL,'injected acquisition failure'); END")).unwrap();
            assert!(client.run_log_epoch_reset("epoch-new").is_err());
            assert!(client.get_meta(LOG_EPOCH_KEY).is_none());
            assert!(!client.upgrading);
            assert_eq!(client.sync_needed, needed);
            assert_eq!(client.local_revision(), revision);
            assert_eq!(client.pending_commit_ids(), [id]);
            assert!(client.drain_change_batches().is_empty());
            assert!(client.drain_sync_intents().is_empty());
        }
    }

    #[test]
    fn failed_log_epoch_resets_restore_memory_and_durable_state() {
        for key in [
            "localSchemaVersion",
            "localSchemaDescriptor",
            "logEpoch",
            "localRevision",
        ] {
            let mut client = client();
            client.set_meta(LOG_EPOCH_KEY, "epoch-old");
            let commit = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("offline")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            client.active_round = Some(uuid::Uuid::new_v4());
            client.overlay_dirty.set(false);
            let round = client.active_round;
            let needed = client.sync_needed;
            let revision = client.local_revision();
            let rows = serde_json::to_value(client.read_rows("tasks").unwrap()).unwrap();
            client.drain_change_batches();
            client.drain_sync_intents();
            client.conn.execute_batch(&format!("CREATE TRIGGER fail_reset BEFORE INSERT ON _syncular_meta WHEN NEW.key='{key}' BEGIN SELECT RAISE(FAIL,'injected reset failure'); END")).unwrap();
            assert!(client.run_log_epoch_reset("epoch-new").is_err(), "{key}");
            assert_eq!(client.get_meta(LOG_EPOCH_KEY).as_deref(), Some("epoch-old"));
            assert!(!client.upgrading);
            assert_eq!(client.active_round, round);
            assert!(!client.overlay_dirty.get());
            assert_eq!(client.sync_needed, needed);
            assert_eq!(client.local_revision(), revision);
            assert_eq!(
                client.pending_commit_ids().as_slice(),
                std::slice::from_ref(&commit)
            );
            assert_eq!(
                serde_json::to_value(client.read_rows("tasks").unwrap()).unwrap(),
                rows
            );
            assert!(client.drain_change_batches().is_empty());
            assert!(client.drain_sync_intents().is_empty());
            assert!(client.conn.is_autocommit());
            client
                .conn
                .execute_batch("DROP TRIGGER fail_reset")
                .unwrap();
            client.run_log_epoch_reset("epoch-new").unwrap();
            assert_eq!(client.get_meta(LOG_EPOCH_KEY).as_deref(), Some("epoch-new"));
            assert_eq!(client.pending_commit_ids(), [commit]);
        }
    }

    #[test]
    fn acknowledged_restore_and_replay_ignore_unrelated_subscription_count() {
        for subscriptions in [0, 2, 6, 12] {
            let mut client = SyncClient::new("ack-scope".into(), &json!({ "version": 1, "tables": [
                { "name": "tasks", "primaryKey": "id", "columns": [{ "name": "id", "type": "string", "nullable": false }, { "name": "project_id", "type": "string", "nullable": false }], "scopes": [{ "pattern": "project:{project_id}" }] },
                { "name": "docs", "primaryKey": "id", "columns": [{ "name": "id", "type": "string", "nullable": false }, { "name": "project_id", "type": "string", "nullable": false }], "scopes": [{ "pattern": "project:{project_id}" }] }
            ] }), ClientLimits::default()).unwrap();
            client.set_meta(LOG_EPOCH_KEY, "epoch-1");
            client.conn.execute_batch("CREATE TABLE ack_writes(kind TEXT); CREATE TRIGGER count_ack_restore AFTER DELETE ON tasks BEGIN INSERT INTO ack_writes VALUES('restore'); END; CREATE TRIGGER count_ack_replay AFTER INSERT ON tasks BEGIN INSERT INTO ack_writes VALUES('replay'); END;").unwrap();
            for index in 0..32 {
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "tasks".into(),
                        values: Map::from_iter([
                            ("id".into(), json!(format!("task-{index}"))),
                            ("project_id".into(), json!("p1")),
                        ]),
                        base_version: None,
                    }])
                    .unwrap();
            }
            let (_, meta) = client.build_request(false).unwrap();
            let mut frames = vec![Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: Some("epoch-1".into()),
                reset_required: Some(false),
            }];
            frames.extend(meta.pushed_ids.iter().enumerate().map(|(index, id)| {
                Frame::PushResult {
                    client_commit_id: id.clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(index as i64 + 1),
                    results: vec![OpResult::Applied { op_index: 0 }],
                }
            }));
            let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
            client.acknowledged_replay_count.set(0);
            client.conn.execute("DELETE FROM ack_writes", []).unwrap();
            assert!(matches!(
                client.process_response(
                    &mut transport,
                    Message {
                        wire_version: WIRE_VERSION,
                        msg_kind: MsgKind::Response,
                        frames
                    },
                    &meta
                ),
                SyncOutcome::Ok(_)
            ));
            assert_eq!(client.acknowledged_replay_count.get(), 32);
            assert_eq!(
                client
                    .query(
                        "SELECT count(*) AS n FROM ack_writes WHERE kind='restore'",
                        &[]
                    )
                    .unwrap()[0]["n"],
                json!(32)
            );
            assert_eq!(
                client
                    .query(
                        "SELECT count(*) AS n FROM ack_writes WHERE kind='replay'",
                        &[]
                    )
                    .unwrap()[0]["n"],
                json!(32)
            );
            client.conn.execute("DELETE FROM ack_writes", []).unwrap();
            client.acknowledged_replay_count.set(0);
            for index in 0..subscriptions {
                client
                    .subscribe(
                        format!("docs-{index}"),
                        "docs".into(),
                        vec![("project_id".into(), vec![format!("scope-{index}")])],
                        None,
                    )
                    .unwrap();
                let sub = client.subs.len() - 1;
                client.subs[sub].effective =
                    Some(vec![("project_id".into(), vec![format!("scope-{index}")])]);
                let segment = RowsSegment {
                    table: "docs".into(),
                    schema_version: 1,
                    columns: client.schema.table("docs").unwrap().wire_columns.clone(),
                    blocks: if index % 2 == 0 {
                        vec![vec![ssp2::segment::SegmentRow {
                            values: vec![
                                Some(ColumnValue::String(format!("doc-{index}"))),
                                Some(ColumnValue::String(format!("scope-{index}"))),
                            ],
                            server_version: 1,
                        }]]
                    } else {
                        vec![]
                    },
                };
                assert!(client.apply_segment(sub, &segment, true).is_ok());
            }
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM ack_writes", &[])
                    .unwrap()[0]["n"],
                json!(0),
                "unrelated bootstrap must not restore/replay tasks"
            );
            assert_eq!(
                client.acknowledged_replay_count.get(),
                0,
                "unrelated bootstrap must not decode task ACKs"
            );
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM tasks", &[])
                    .unwrap()[0]["n"],
                json!(32)
            );
            assert_eq!(
                client
                    .query("SELECT count(*) AS n FROM _syncular_acked_rows", &[])
                    .unwrap()[0]["n"],
                json!(32)
            );
        }
    }

    #[test]
    fn batched_push_acknowledgements_rebuild_overlay_once_per_response() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        const COMMIT_COUNT: usize = 32;

        for index in 0..COMMIT_COUNT {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), Value::from(format!("task-{index}"))),
                        ("project_id".to_owned(), Value::from("project-1")),
                    ]),
                    base_version: None,
                }])
                .expect("queue commit");
        }

        let (_, request_meta) = client.build_request(false).unwrap();
        assert_eq!(request_meta.pushed_ids.len(), COMMIT_COUNT);
        let mut frames = vec![Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: Some("epoch-1".to_owned()),
            reset_required: Some(false),
        }];
        frames.extend(request_meta.pushed_ids.iter().enumerate().map(
            |(index, client_commit_id)| Frame::PushResult {
                client_commit_id: client_commit_id.clone(),
                status: PushStatus::Applied,
                commit_seq: Some(index as i64 + 1),
                results: vec![OpResult::Applied { op_index: 0 }],
            },
        ));
        let response = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames,
        };
        let mut transport =
            HostTransport::new_from_config(&json!({})).expect("no-network host transport");

        client.overlay_rebuild_count.set(0);
        client.outcome_prune_count.set(0);
        let outcome = client.process_response(&mut transport, response, &request_meta);
        assert!(matches!(outcome, SyncOutcome::Ok(_)));
        assert!(client.pending_commit_ids().is_empty());
        assert_eq!(
            client.overlay_rebuild_count.get(),
            1,
            "one response must reconcile its acknowledged commits with one overlay rebuild"
        );
        assert_eq!(
            client.outcome_prune_count.get(),
            1,
            "one response must enforce outcome retention once"
        );
    }

    #[test]
    fn clean_commit_mirroring_matches_full_replay_with_fts_and_unique_indexes() {
        let schema = json!({ "version": 1, "tables": [{ "name": "tasks", "primaryKey": "id",
            "columns": [
                {"name":"id", "type":"string", "nullable":false},
                {"name":"project_id", "type":"string", "nullable":false},
                {"name":"title", "type":"string", "nullable":false}
            ], "scopes": [{"pattern":"project:{project_id}"}],
            "indexes": [{"name":"unique_title", "columns":["title"], "unique":true}],
            "ftsIndexes": [{"name":"tasks_fts", "columns":["title"], "tokenize":"unicode61"}]
        }] });
        let mut incremental =
            SyncClient::new("mirror".to_owned(), &schema, ClientLimits::default()).unwrap();
        let mut reference =
            SyncClient::new("mirror".to_owned(), &schema, ClientLimits::default()).unwrap();
        let tables = vec!["tasks".to_owned()];
        for index in 0..32 {
            let id = format!("task-{}", index % 8);
            let values = Map::from_iter([
                ("id".to_owned(), Value::from(id.clone())),
                (
                    "project_id".to_owned(),
                    Value::from(format!("p{}", index % 2)),
                ),
                ("title".to_owned(), Value::from(format!("needle{index}"))),
            ]);
            let payload = encode_row_json(
                incremental.schema.table("tasks").unwrap(),
                &id,
                &values,
                &incremental.encryption,
            )
            .unwrap();
            let change = ssp2::model::Change {
                table_index: 0,
                row_id: id,
                op: if index % 5 == 0 {
                    Op::Delete
                } else {
                    Op::Upsert
                },
                row_version: Some(index + 1),
                scopes: vec![("project_id".to_owned(), format!("p{}", index % 2))],
                row: Some(payload),
            };
            reference.overlay_dirty.set(true);
            for instance in [&mut incremental, &mut reference] {
                instance.begin_observation("mirror_test").unwrap();
                let mut batch = ChangeAccumulator::default();
                instance.record_commit_changes(&mut batch, &tables, std::slice::from_ref(&change));
                instance
                    .apply_commit_changes(&tables, std::slice::from_ref(&change))
                    .unwrap();
                instance
                    .rebuild_overlay_if_dirty()
                    .expect("rebuild overlay");
                instance.finish_observation("mirror_test", batch).unwrap();
            }
            for sql in [
                "SELECT * FROM tasks ORDER BY id",
                "SELECT _syncular_source_id, title FROM tasks_fts ORDER BY _syncular_source_id",
            ] {
                assert_eq!(
                    incremental.query(sql, &[]).unwrap(),
                    reference.query(sql, &[]).unwrap()
                );
            }
            assert_eq!(incremental.local_revision(), reference.local_revision());
            assert_eq!(
                serde_json::to_value(incremental.drain_change_batches()).unwrap(),
                serde_json::to_value(reference.drain_change_batches()).unwrap()
            );
        }
        assert_eq!(incremental.overlay_rebuild_count.get(), 0);
        assert_eq!(reference.overlay_rebuild_count.get(), 32);
    }

    #[test]
    fn row_id_lookups_preserve_text_matching_and_seek_lossless_keys() {
        let cases = [
            (
                "string",
                vec![
                    json!("1"),
                    json!("01"),
                    json!(""),
                    json!("nul\u{0}id"),
                    json!("é"),
                ],
            ),
            (
                "integer",
                vec![
                    json!(i64::MIN),
                    json!(-1),
                    json!(0),
                    json!(1),
                    json!(i64::MAX),
                ],
            ),
            ("boolean", vec![json!(false), json!(true)]),
            ("json", vec![json!("null"), json!("1"), json!("{\"a\":1}")]),
        ];
        for (kind, ids) in cases {
            let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
                "columns":[{"name":"id","type":kind,"nullable":false},
                    {"name":"project_id","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}]}]});
            let mut client =
                SyncClient::new("row-id-lookup".into(), &schema, ClientLimits::default()).unwrap();
            for (index, id) in ids.iter().enumerate() {
                let table = client.schema.table("tasks").unwrap();
                client
                    .write_base_row(
                        "tasks",
                        &vec![
                            json_to_column_value(&table.columns[0], Some(id)).unwrap(),
                            Some(ColumnValue::String(format!("p{index}"))),
                        ],
                        1,
                    )
                    .unwrap();
            }
            client.rebuild_overlay_if_dirty().expect("rebuild overlay");
            for base in [true, false] {
                let full = if base {
                    base_table("tasks")
                } else {
                    visible_table("tasks")
                };
                let predicate = row_id_predicate(client.schema.table("tasks").unwrap());
                for row_id in [
                    "1",
                    "01",
                    "1.0",
                    "1.0000000000000002",
                    "+1",
                    "1e0",
                    " 1",
                    "-1",
                    "0",
                    "9223372036854775807",
                    "-9223372036854775808",
                    "true",
                    "false",
                    "",
                    "nul\u{0}id",
                    "é",
                    "null",
                    "{\"a\":1}",
                ] {
                    let old_sql =
                        format!("SELECT project_id FROM {full} WHERE CAST(id AS TEXT) = ?1");
                    let new_sql = format!("SELECT project_id FROM {full} WHERE {predicate}");
                    let old = client
                        .conn
                        .prepare(&old_sql)
                        .unwrap()
                        .query_map([row_id], |row| row.get::<_, String>(0))
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap();
                    let new = client
                        .conn
                        .prepare_cached(&new_sql)
                        .unwrap()
                        .query_map([row_id], |row| row.get::<_, String>(0))
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap();
                    assert_eq!(old, new, "{kind}, base={base}, row_id={row_id:?}");
                    let mut batch = ChangeAccumulator::default();
                    assert_eq!(
                        client.record_row_scopes(&mut batch, "tasks", row_id, base),
                        !old.is_empty()
                    );
                    let expected = old.first().map(|scope| {
                        BTreeMap::from([(
                            "tasks".to_owned(),
                            Some(BTreeSet::from([format!("project:{scope}")])),
                        )])
                    });
                    assert_eq!(batch.tables, expected.unwrap_or_default());
                    client
                        .conn
                        .execute_batch("SAVEPOINT lookup_delete")
                        .unwrap();
                    if base {
                        client.delete_base_row("tasks", row_id).unwrap();
                    } else {
                        client
                            .apply_outbox_ops(&[OutboxOp {
                                upsert: false,
                                table: "tasks".into(),
                                row_id: row_id.into(),
                                base_version: None,
                                values: None,
                            }])
                            .expect("replay delete");
                    }
                    let remaining: i64 = client
                        .conn
                        .query_row(&format!("SELECT count(*) FROM {full}"), [], |row| {
                            row.get(0)
                        })
                        .unwrap();
                    assert_eq!(remaining, ids.len() as i64 - old.len() as i64);
                    client
                        .conn
                        .execute_batch("ROLLBACK TO lookup_delete; RELEASE lookup_delete")
                        .unwrap();
                    client.overlay_dirty.set(false);
                }
                for (predicate, expected) in [
                    ("CAST(id AS TEXT) = ?1".to_owned(), "SCAN"),
                    (predicate, "SEARCH"),
                ] {
                    let sql = format!("EXPLAIN QUERY PLAN SELECT project_id FROM {full} WHERE {predicate} LIMIT 1");
                    let details = client
                        .conn
                        .prepare(&sql)
                        .unwrap()
                        .query_map(["1"], |row| row.get::<_, String>(3))
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap();
                    assert!(
                        details.iter().any(|detail| detail.contains(expected)),
                        "{kind}: {details:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn primary_keys_reject_every_ineligible_column_type() {
        // §2.4: a `rowId` is a string, so a primary key type whose string form
        // differs per renderer, or cannot be reproduced by local storage
        // comparison, is a schema error rather than a silent lookup miss.
        for ty in ["float", "bytes", "crdt", "blob_ref"] {
            let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
                "columns":[{"name":"id","type":ty,"nullable":false},
                    {"name":"project_id","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}]}]});
            let error =
                match SyncClient::new("pk-eligibility".into(), &schema, ClientLimits::default()) {
                    Ok(_) => panic!("ineligible primary key {ty} must be rejected"),
                    Err(error) => error,
                };
            assert!(
                error.contains("has an ineligible column type (§2.4)"),
                "{ty}: {error}"
            );
        }
        for ty in ["string", "integer", "boolean", "json"] {
            let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id",
                "columns":[{"name":"id","type":ty,"nullable":false},
                    {"name":"project_id","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}]}]});
            SyncClient::new("pk-eligibility".into(), &schema, ClientLimits::default())
                .unwrap_or_else(|error| panic!("{ty}: {error}"));
        }
    }

    #[test]
    fn pending_row_reconciliation_matches_full_fifo_replay() {
        for unique in [false, true] {
            let schema = json!({"version": 1, "tables": (["tasks", "notes"].map(|name| json!({
                "name": name, "primaryKey": "id", "columns": [
                    {"name":"id", "type":"string", "nullable":false},
                    {"name":"project_id", "type":"string", "nullable":false},
                    {"name":"title", "type":"string", "nullable":false}],
                "scopes": [{"pattern":"project:{project_id}"}],
                "indexes": [{"name":format!("{name}_title"), "columns":["title"], "unique":unique || name == "notes"}],
                "ftsIndexes": [{"name":format!("{name}_fts"), "columns":["title"], "tokenize":"unicode61"}]
            })))});
            let mut incremental =
                SyncClient::new("pending".into(), &schema, ClientLimits::default()).unwrap();
            let mut reference =
                SyncClient::new("pending".into(), &schema, ClientLimits::default()).unwrap();
            let tables = vec!["tasks".to_owned(), "notes".to_owned()];
            for instance in [&mut incremental, &mut reference] {
                for table in &tables {
                    for index in 0..12 {
                        instance
                            .write_base_row(
                                table,
                                &vec![
                                    Some(ColumnValue::String(format!("row{index}"))),
                                    Some(ColumnValue::String("p0".into())),
                                    Some(ColumnValue::String(format!("base{index}"))),
                                ],
                                1,
                            )
                            .unwrap();
                    }
                }
                instance
                    .rebuild_overlay_if_dirty()
                    .expect("rebuild overlay");
            }
            for index in 0..80 {
                let mutations = (0..3)
                    .map(|offset| {
                        let table = tables[(index + offset) % 2].clone();
                        let id = format!("row{}", (index + offset) % 16);
                        if (index + offset) % 7 == 0 {
                            Mutation::Delete {
                                table,
                                row_id: id,
                                base_version: None,
                            }
                        } else {
                            Mutation::Upsert {
                                table,
                                values: Map::from_iter([
                                    ("id".into(), Value::from(id)),
                                    ("project_id".into(), Value::from(format!("p{}", index % 3))),
                                    (
                                        "title".into(),
                                        Value::from(format!("needle{}", (index + offset) % 16)),
                                    ),
                                ]),
                                base_version: None,
                            }
                        }
                    })
                    .collect::<Vec<_>>();
                for instance in [&mut incremental, &mut reference] {
                    instance.mutate(mutations.clone()).unwrap();
                }
                // Most frames touch only the table without unique constraints.
                // Mixed frames must retain full replay for both tables.
                let changes = (0..3)
                    .map(|offset| {
                        let table_index = if index % 4 == 0 { offset % 2 } else { 0 };
                        let id = format!("row{}", (index + offset) % 16);
                        let values = Map::from_iter([
                            ("id".into(), Value::from(id.clone())),
                            (
                                "project_id".into(),
                                Value::from(format!("p{}", (index + 1) % 3)),
                            ),
                            (
                                "title".into(),
                                Value::from(format!("remote{index}_{offset}")),
                            ),
                        ]);
                        ssp2::model::Change {
                            table_index: table_index as u16,
                            row_id: id.clone(),
                            op: if (index + offset) % 5 == 0 {
                                Op::Delete
                            } else {
                                Op::Upsert
                            },
                            row_version: Some(index as i64 + 2),
                            scopes: vec![],
                            row: Some(
                                encode_row_json(
                                    incremental.schema.table(&tables[table_index]).unwrap(),
                                    &id,
                                    &values,
                                    &incremental.encryption,
                                )
                                .unwrap(),
                            ),
                        }
                    })
                    .collect::<Vec<_>>();
                reference.overlay_dirty.set(true);
                incremental
                    .apply_commit_frame(&tables, &changes, None)
                    .unwrap();
                reference
                    .apply_commit_frame(&tables, &changes, None)
                    .unwrap();
                for table in &tables {
                    for sql in [format!("SELECT * FROM {table} ORDER BY id"),
                        format!("SELECT * FROM _syncular_base_{table} ORDER BY id"),
                        format!("SELECT _syncular_source_id, title FROM {table}_fts ORDER BY _syncular_source_id"),
                        format!("SELECT _syncular_source_id FROM {table}_fts WHERE {table}_fts MATCH 'needle1' ORDER BY _syncular_source_id")] {
                        assert_eq!(incremental.query(&sql, &[]).unwrap(), reference.query(&sql, &[]).unwrap(), "unique={unique}, frame={index}: {sql}");
                    }
                }
                assert_eq!(incremental.local_revision(), reference.local_revision());
                assert_eq!(
                    serde_json::to_value(incremental.drain_change_batches()).unwrap(),
                    serde_json::to_value(reference.drain_change_batches()).unwrap()
                );
            }
            assert_eq!(
                incremental.overlay_rebuild_count.get(),
                if unique { 81 } else { 21 }
            );
            assert_eq!(reference.overlay_rebuild_count.get(), 81);
        }
    }

    #[test]
    fn remote_unique_values_reconsider_pending_writes_on_other_rows() {
        let schema = json!({"version": 1, "tables": [{"name":"tasks", "primaryKey":"id",
            "columns":[{"name":"id", "type":"string", "nullable":false},
                {"name":"title", "type":"string", "nullable":false}],
            "scopes":[], "indexes":[{"name":"unique_title", "columns":["title"], "unique":true}]}]});
        let mut client =
            SyncClient::new("unique-pending".into(), &schema, ClientLimits::default()).unwrap();
        for (id, title) in [("a", "original"), ("b", "occupied")] {
            client
                .write_base_row(
                    "tasks",
                    &vec![
                        Some(ColumnValue::String(id.into())),
                        Some(ColumnValue::String(title.into())),
                    ],
                    1,
                )
                .unwrap();
        }
        client.rebuild_overlay_if_dirty().expect("rebuild overlay");
        let pending = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), Value::from("a")),
                    ("title".into(), Value::from("available")),
                ]),
                base_version: None,
            }])
            .unwrap();
        assert_eq!(
            client
                .conn
                .query_row("SELECT title FROM tasks WHERE id = 'a'", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "available"
        );
        for (title, expected) in [("available", "original"), ("occupied", "available")] {
            let change = ssp2::model::Change {
                table_index: 0,
                row_id: "b".into(),
                op: Op::Upsert,
                row_version: Some(2),
                scopes: vec![],
                row: Some(
                    encode_row_json(
                        client.schema.table("tasks").unwrap(),
                        "b",
                        &Map::from_iter([
                            ("id".into(), Value::from("b")),
                            ("title".into(), Value::from(title)),
                        ]),
                        &client.encryption,
                    )
                    .unwrap(),
                ),
            };
            client
                .apply_commit_frame(&["tasks".into()], &[change], None)
                .unwrap();
            assert_eq!(
                client
                    .conn
                    .query_row("SELECT title FROM tasks WHERE id = 'a'", [], |row| row
                        .get::<_, String>(
                        0
                    ))
                    .unwrap(),
                expected
            );
            assert_eq!(client.pending_commit_ids(), vec![pending.clone()]);
        }
        assert_eq!(client.overlay_rebuild_count.get(), 3);
    }

    fn measure_scoped_overlay(unchanged_rows: i64, rounds: i64) -> Vec<u128> {
        let schema = json!({ "version": 1, "tables": [
            { "name":"tasks", "primaryKey":"id", "columns":[
                {"name":"id","type":"string","nullable":false},
                {"name":"project_id","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}] },
            { "name":"catalogue", "primaryKey":"id", "columns":[
                {"name":"id","type":"string","nullable":false},
                {"name":"project_id","type":"string","nullable":false},
                {"name":"title","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}],
                "ftsIndexes":[{"name":"catalogue_fts","columns":["title"],"tokenize":"unicode61"}] }
        ] });
        let mut client =
            SyncClient::new("overlay-scope".into(), &schema, ClientLimits::default()).unwrap();
        if unchanged_rows > 0 {
            client.conn.execute_batch(&format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{unchanged_rows}) INSERT INTO _syncular_base_catalogue SELECT 'c'||i,'p1','needle '||i,1 FROM n")).unwrap();
        }
        client.rebuild_overlay().expect("rebuild overlay");
        client.conn.execute_batch("CREATE TABLE audit(tbl TEXT); CREATE TRIGGER catalogue_changed AFTER DELETE ON catalogue BEGIN INSERT INTO audit VALUES ('catalogue'); END;").unwrap();
        let mut elapsed = Vec::new();
        for round in 1..=rounds {
            let pending = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("t1")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let started = std::time::Instant::now();
            client
                .write_base_row(
                    "tasks",
                    &vec![
                        Some(ColumnValue::String("t1".into())),
                        Some(ColumnValue::String("p1".into())),
                    ],
                    round,
                )
                .unwrap();
            let mut report = SyncReport::default();
            client
                .handle_push_results(
                    &[Frame::PushResult {
                        client_commit_id: pending.clone(),
                        status: PushStatus::Applied,
                        commit_seq: Some(round),
                        results: vec![OpResult::Applied { op_index: 0 }],
                    }],
                    &HashSet::from([pending.as_str()]),
                    &HashMap::new(),
                    &mut report,
                    Some(&pending),
                )
                .unwrap();
            client.rebuild_overlay_if_dirty().expect("rebuild overlay");
            elapsed.push(started.elapsed().as_nanos());
        }
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0,
            "unchanged catalogue must never be copied"
        );
        assert_eq!(
            client
                .conn
                .query_row(
                    "SELECT count(*) FROM catalogue_fts WHERE catalogue_fts MATCH 'needle'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            unchanged_rows
        );
        assert_eq!(
            client.query("SELECT * FROM tasks", &[]).unwrap()[0]["_syncular_version"],
            json!(rounds)
        );
        elapsed
    }

    #[test]
    fn changed_overlay_leaves_large_unchanged_table_and_fts_untouched() {
        let elapsed = measure_scoped_overlay(100_000, 1);
        eprintln!(
            "table-scoped overlay with 100k unchanged rows: {} ns",
            elapsed[0]
        );
    }

    #[test]
    #[ignore = "isolated performance measurement; run with the shared heavy-check lock"]
    fn benchmark_scoped_overlay() {
        for rows in [0, 100_000, 200_000] {
            let mut elapsed = measure_scoped_overlay(rows, 30);
            elapsed.sort_unstable();
            eprintln!(
                "{}",
                json!({"unchangedRows": rows, "rounds": elapsed.len(),
                "medianNs": elapsed[elapsed.len()/2], "minNs": elapsed[0],
                "maxNs": elapsed[elapsed.len()-1], "unchangedDeletes": 0})
            );
        }
    }

    #[test]
    fn released_context_discards_in_flight_ack_and_server_rows() {
        for barrier in [
            "preflight",
            "purge",
            "rebootstrap",
            "subscription",
            "failed-purge-replay",
            "failed-purge-publish",
            "failed-rebootstrap",
        ] {
            let mut client = client();
            client.set_meta(LOG_EPOCH_KEY, "epoch");
            client
                .subscribe(
                    "tasks".into(),
                    "tasks".into(),
                    vec![("project_id".into(), vec!["p1".into()])],
                    None,
                )
                .unwrap();
            let commit = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("local")),
                        ("project_id".into(), json!("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let prepared = client.prepare_sync_round(false).unwrap();
            client.set_transport_enabled(&mut CountingRealtimeTransport::default(), false);
            let payload = encode_row_json(
                &client.schema.tables[0],
                "server",
                &Map::from_iter([
                    ("id".into(), json!("server")),
                    ("project_id".into(), json!("p1")),
                ]),
                &client.encryption,
            )
            .unwrap();
            let completed = crate::CompletedSyncRound {
                prepared,
                exchange: crate::round::ExchangeResult::Reply {
                    transport_failed: false,
                    downloads: Default::default(),
                    response: Ok(Message {
                        wire_version: WIRE_VERSION,
                        msg_kind: MsgKind::Response,
                        frames: vec![
                            Frame::RespHeader {
                                required_schema_version: None,
                                latest_schema_version: None,
                                log_epoch: Some("epoch".into()),
                                reset_required: Some(false),
                            },
                            Frame::PushResult {
                                client_commit_id: commit.clone(),
                                status: PushStatus::Applied,
                                commit_seq: Some(1),
                                results: vec![OpResult::Applied { op_index: 0 }],
                            },
                            Frame::SubStart {
                                id: "tasks".into(),
                                status: SubStatus::Active,
                                reason_code: String::new(),
                                effective_scopes: vec![("project_id".into(), vec!["p1".into()])],
                                bootstrap: true,
                            },
                            Frame::Commit {
                                commit_seq: 1,
                                created_at_ms: 0,
                                actor_id: "actor".into(),
                                tables: vec!["tasks".into()],
                                changes: vec![ssp2::model::Change {
                                    table_index: 0,
                                    row_id: "server".into(),
                                    op: Op::Upsert,
                                    row_version: Some(1),
                                    scopes: vec![("project_id".into(), "p1".into())],
                                    row: Some(payload),
                                }],
                            },
                            Frame::SubEnd {
                                next_cursor: 1,
                                bootstrap_state: None,
                            },
                        ],
                    }),
                },
            };
            match barrier {
                "preflight" => client.begin_security_preflight(),
                "purge" => {
                    client
                        .purge_local_data(&LocalDataPurgeInput {
                            purge_id: "pending-round".into(),
                            targets: vec![LocalDataPurgeTarget {
                                table: "tasks".into(),
                                selectors: BTreeMap::from([(
                                    "project_id".into(),
                                    vec!["p1".into()],
                                )]),
                            }],
                        })
                        .unwrap();
                }
                "rebootstrap" => {
                    client
                        .rebootstrap_local_data(&LocalDataRebootstrapInput {
                            rebootstrap_id: "pending-round".into(),
                        })
                        .unwrap();
                }
                "failed-purge-replay" | "failed-purge-publish" | "failed-rebootstrap" => {
                    let trigger = if barrier == "failed-purge-replay" {
                        "CREATE TRIGGER fail_local BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'local fault'); END"
                    } else {
                        "CREATE TRIGGER fail_local BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(ABORT, 'local fault'); END"
                    };
                    client.conn.execute_batch(trigger).unwrap();
                    let revision = client.local_revision();
                    if barrier == "failed-rebootstrap" {
                        assert!(client
                            .rebootstrap_local_data(&LocalDataRebootstrapInput {
                                rebootstrap_id: "failed-round".into(),
                            })
                            .is_err());
                    } else {
                        assert!(client
                            .purge_local_data(&LocalDataPurgeInput {
                                purge_id: "failed-round".into(),
                                targets: vec![LocalDataPurgeTarget {
                                    table: "tasks".into(),
                                    selectors: BTreeMap::from([(
                                        "project_id".into(),
                                        vec!["p1".into()]
                                    )]),
                                }],
                            })
                            .is_err());
                    }
                    assert_eq!(client.local_revision(), revision);
                    assert_eq!(client.pending_commit_ids(), vec![commit.clone()]);
                    client
                        .conn
                        .execute_batch("DROP TRIGGER fail_local")
                        .unwrap();
                    let applied = client.apply_sync_round(completed);
                    assert!(
                        matches!(
                            applied,
                            crate::AppliedSyncRound::Complete {
                                outcome: SyncOutcome::Ok(_),
                                ..
                            }
                        ),
                        "{barrier}"
                    );
                    assert!(client.pending_commit_ids().is_empty());
                    assert_eq!(
                        client
                            .query("SELECT id FROM tasks WHERE id = 'server'", &[])
                            .unwrap()
                            .len(),
                        1
                    );
                    continue;
                }
                "subscription" => {
                    client.unsubscribe("tasks");
                    client
                        .subscribe(
                            "tasks".into(),
                            "tasks".into(),
                            vec![("project_id".into(), vec!["p2".into()])],
                            None,
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            let pending_before_reply = client.pending_commit_ids();
            let revision = client.local_revision();
            let applied = client.apply_sync_round(completed);
            assert!(
                matches!(applied, crate::AppliedSyncRound::Complete { outcome: SyncOutcome::Failed { ref error_code, .. }, ref controls, .. } if error_code == "client.round_cancelled" && controls.is_empty())
            );
            assert_eq!(client.local_revision(), revision);
            assert!(client
                .conn
                .query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM tasks WHERE id='server')",
                    [],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap());
            assert_eq!(client.pending_commit_ids(), pending_before_reply);
        }
    }

    #[test]
    fn pending_row_reconciliation_failure_preserves_queue_and_frame_state() {
        for failure in ["visible", "revision", "commit"] {
            let mut client = client();
            let id = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), Value::from("t1")),
                        ("project_id".into(), Value::from("pending")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            client.drain_change_batches();
            let revision = client.local_revision();
            let before = client.query("SELECT * FROM tasks", &[]).unwrap();
            let trigger = match failure {
                "visible" => "CREATE TRIGGER fail_pending BEFORE INSERT ON tasks WHEN NEW.project_id = 'remote' BEGIN SELECT RAISE(ABORT, 'injected visible failure'); END".to_owned(),
                "revision" => format!("CREATE TRIGGER fail_pending BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{LOCAL_REVISION_KEY}' BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END"),
                _ => "PRAGMA foreign_keys = ON; CREATE TABLE pending_parent(id INTEGER PRIMARY KEY); CREATE TABLE pending_child(id INTEGER REFERENCES pending_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_pending AFTER INSERT ON _syncular_base_tasks BEGIN INSERT INTO pending_child VALUES(1); END".to_owned(),
            };
            client.conn.execute_batch(&trigger).unwrap();
            let change = ssp2::model::Change {
                table_index: 0,
                row_id: "t1".into(),
                op: Op::Upsert,
                row_version: Some(2),
                scopes: vec![],
                row: Some(
                    encode_row_json(
                        client.schema.table("tasks").unwrap(),
                        "t1",
                        &Map::from_iter([
                            ("id".into(), Value::from("t1")),
                            ("project_id".into(), Value::from("remote")),
                        ]),
                        &client.encryption,
                    )
                    .unwrap(),
                ),
            };
            assert!(client
                .apply_commit_frame(&["tasks".into()], std::slice::from_ref(&change), None)
                .is_err());
            assert!(client.conn.is_autocommit());
            assert!(!client.overlay_dirty.get());
            assert_eq!(client.local_revision(), revision);
            assert!(client.drain_change_batches().is_empty());
            assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
            assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), before);
            assert!(client
                .query("SELECT * FROM _syncular_base_tasks", &[])
                .unwrap()
                .is_empty());
            client
                .conn
                .execute_batch("DROP TRIGGER fail_pending")
                .unwrap();
            client
                .apply_commit_frame(&["tasks".into()], &[change], None)
                .unwrap();
            assert_eq!(client.local_revision(), revision + 1);
            assert_eq!(client.pending_commit_ids(), vec![id]);
            // The overlay keeps the pending write visible; the row now carries
            // the server row's version it is layered on (§7.1).
            let mut expected = before[0].clone();
            expected.insert("_syncular_version".to_owned(), Value::from(2));
            assert_eq!(
                client.query("SELECT * FROM tasks", &[]).unwrap(),
                vec![expected]
            );
            assert_eq!(
                client
                    .conn
                    .query_row("SELECT project_id FROM _syncular_base_tasks", [], |row| row
                        .get::<_, String>(0))
                    .unwrap(),
                "remote"
            );
        }
    }

    #[test]
    fn appended_overlay_matches_full_fifo_replay_with_constraints_and_fts() {
        let schema = json!({"version": 1, "tables": [{"name": "tasks", "primaryKey": "id",
            "columns": [
                {"name":"id", "type":"string", "nullable":false},
                {"name":"project_id", "type":"string", "nullable":false},
                {"name":"title", "type":"string", "nullable":false}],
            "scopes": [{"pattern":"project:{project_id}"}],
            "indexes": [{"name":"unique_title", "columns":["title"], "unique":true}],
            "ftsIndexes": [{"name":"tasks_fts", "columns":["title"], "tokenize":"unicode61"}]}]});
        let mut incremental =
            SyncClient::new("append".to_owned(), &schema, ClientLimits::default()).unwrap();
        let mut reference =
            SyncClient::new("append".to_owned(), &schema, ClientLimits::default()).unwrap();
        for instance in [&mut incremental, &mut reference] {
            for index in 0..16 {
                instance
                    .write_base_row(
                        "tasks",
                        &vec![
                            Some(ColumnValue::String(format!("task{index}"))),
                            Some(ColumnValue::String("p0".to_owned())),
                            Some(ColumnValue::String(format!("base{index}"))),
                        ],
                        1,
                    )
                    .unwrap();
            }
            instance
                .rebuild_overlay_if_dirty()
                .expect("rebuild overlay");
            instance.overlay_rebuild_count.set(0);
        }
        for index in 0..100 {
            let mutations = (0..1 + index % 4)
                .map(|offset| {
                    let id = format!("task{}", (index + offset) % 24);
                    if (index + offset) % 7 == 0 {
                        Mutation::Delete {
                            table: "tasks".to_owned(),
                            row_id: id,
                            base_version: None,
                        }
                    } else {
                        Mutation::Upsert {
                            table: "tasks".to_owned(),
                            values: Map::from_iter([
                                ("id".to_owned(), Value::from(id)),
                                (
                                    "project_id".to_owned(),
                                    Value::from(format!("p{}", index % 2)),
                                ),
                                (
                                    "title".to_owned(),
                                    Value::from(format!("needle{}", (index + offset) % 24)),
                                ),
                            ]),
                            base_version: None,
                        }
                    }
                })
                .collect::<Vec<_>>();
            reference.overlay_dirty.set(true);
            incremental.mutate(mutations.clone()).unwrap();
            reference.mutate(mutations).unwrap();
            for sql in ["SELECT * FROM tasks ORDER BY id", "SELECT _syncular_source_id, title FROM tasks_fts ORDER BY _syncular_source_id",
                "SELECT _syncular_source_id FROM tasks_fts WHERE tasks_fts MATCH 'needle1' ORDER BY _syncular_source_id"] {
                assert_eq!(incremental.query(sql, &[]).unwrap(), reference.query(sql, &[]).unwrap(), "commit {index}: {sql}");
            }
            assert_eq!(incremental.local_revision(), reference.local_revision());
            assert_eq!(
                serde_json::to_value(incremental.drain_change_batches()).unwrap(),
                serde_json::to_value(reference.drain_change_batches()).unwrap()
            );
        }
        assert_eq!(incremental.outbox.len(), 100);
        assert_eq!(incremental.overlay_rebuild_count.get(), 0);
        assert_eq!(reference.overlay_rebuild_count.get(), 100);
    }

    #[test]
    fn failed_append_rolls_back_durable_queue_visible_rows_and_memory() {
        for fail_at in ["outbox", "revision"] {
            let mut client = client();
            let values = Map::from_iter([
                ("id".to_owned(), Value::from("t1")),
                ("project_id".to_owned(), Value::from("p1")),
            ]);
            let mutation = Mutation::Upsert {
                table: "tasks".to_owned(),
                values,
                base_version: None,
            };
            let trigger = if fail_at == "outbox" {
                "CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_outbox BEGIN SELECT RAISE(FAIL, 'injected outbox failure'); END".to_owned()
            } else {
                format!("CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{LOCAL_REVISION_KEY}' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END")
            };
            client.conn.execute_batch(&trigger).unwrap();
            let revision = client.local_revision();
            assert!(client.mutate(vec![mutation.clone()]).is_err(), "{fail_at}");
            assert_eq!(client.local_revision(), revision);
            assert!(client.outbox.is_empty());
            assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
            assert_eq!(
                client
                    .conn
                    .query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(client.drain_change_batches().is_empty());
            assert!(!client.overlay_dirty.get());
            client
                .conn
                .execute_batch("DROP TRIGGER fail_append")
                .unwrap();
            client.mutate(vec![mutation]).unwrap();
            assert_eq!(client.outbox.len(), 1);
            assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap().len(), 1);
        }
    }

    #[test]
    fn mirrored_commit_failure_rolls_back_base_visible_and_revision() {
        let mut client = client();
        let tables = vec!["tasks".to_owned(), "missing".to_owned()];
        let values = Map::from_iter([
            ("id".to_owned(), Value::from("t1")),
            ("project_id".to_owned(), Value::from("p1")),
        ]);
        let payload = encode_row_json(
            client.schema.table("tasks").unwrap(),
            "t1",
            &values,
            &client.encryption,
        )
        .unwrap();
        let first = ssp2::model::Change {
            table_index: 0,
            row_id: "t1".to_owned(),
            op: Op::Upsert,
            row_version: Some(1),
            scopes: vec![("project_id".to_owned(), "p1".to_owned())],
            row: Some(payload),
        };
        let mut invalid = first.clone();
        invalid.table_index = 1;
        let revision = client.local_revision();
        client.begin_observation("failed_mirror").unwrap();
        assert!(client
            .apply_commit_changes(&tables, &[first, invalid])
            .is_err());
        client.rollback_observation("failed_mirror");
        client.rebuild_overlay_if_dirty().expect("rebuild overlay");
        assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_base_tasks", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert_eq!(client.local_revision(), revision);
        assert!(client.drain_change_batches().is_empty());
    }

    #[test]
    fn successful_acknowledgement_runs_are_atomic_and_preserve_completed_runs() {
        for failure in ["journal", "revision", "commit", "later-frame"] {
            let mut client = client();
            client.set_meta(LOG_EPOCH_KEY, "epoch-1");
            for id in ["first", "second"] {
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "tasks".to_owned(),
                        values: Map::from_iter([
                            ("id".to_owned(), Value::from(id)),
                            ("project_id".to_owned(), Value::from("p1")),
                        ]),
                        base_version: None,
                    }])
                    .unwrap();
            }
            let (_, meta) = client.build_request(false).unwrap();
            // A malicious or stale response must not drain an unsent local commit.
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), Value::from("later")),
                        ("project_id".to_owned(), Value::from("p1")),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let ids = client.pending_commit_ids();
            let rows = client
                .query("SELECT * FROM tasks ORDER BY id", &[])
                .unwrap();
            let revision = client.local_revision();
            client.drain_change_batches();
            if failure != "later-frame" {
                client.conn.execute_batch(match failure {
                    "journal" => "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 1 BEGIN SELECT RAISE(FAIL, 'injected second journal failure'); END",
                    "revision" => "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN SELECT RAISE(FAIL, 'injected run revision failure'); END",
                    _ => "PRAGMA foreign_keys = ON; CREATE TABLE ack_parent(id INTEGER PRIMARY KEY); CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_run AFTER INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN INSERT INTO ack_child VALUES (1); END",
                }).unwrap();
            }
            let mut response = Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Response,
                frames: vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-1".to_owned()),
                    reset_required: Some(false),
                }],
            };
            for id in [&ids[0], &ids[0], "unknown", &ids[1], &ids[2]] {
                response.frames.push(Frame::PushResult {
                    client_commit_id: id.to_owned(),
                    status: PushStatus::Applied,
                    commit_seq: Some(1),
                    results: vec![OpResult::Applied { op_index: 0 }],
                });
            }
            if failure == "later-frame" {
                response.frames.push(Frame::Error {
                    code: "sync.invalid_request".to_owned(),
                    message: "later error".to_owned(),
                    category: "protocol".to_owned(),
                    retryable: false,
                    recommended_action: "retry".to_owned(),
                    details: None,
                });
            }
            let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
            let outcome = client.process_response(&mut transport, response.clone(), &meta);
            assert!(
                matches!(outcome, SyncOutcome::Failed { error_code, .. } if error_code == if failure == "later-frame" { "sync.invalid_request" } else { "client.outcome_persistence_failed" })
            );
            if failure == "later-frame" {
                assert_eq!(client.pending_commit_ids(), ids[2..]);
                assert!(client.commit_outcome(&ids[0]).unwrap().is_some());
                assert!(client.commit_outcome(&ids[1]).unwrap().is_some());
                let batches = client.drain_change_batches();
                assert_eq!(batches.len(), 1);
                assert_eq!(batches[0].status.as_ref().unwrap().outbox, 1);
                assert_eq!(client.local_revision(), revision + 1);
                response.frames.pop();
            } else {
                assert_eq!(client.pending_commit_ids(), ids);
                assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
                assert!(client.commit_outcome(&ids[1]).unwrap().is_none());
                assert_eq!(client.local_revision(), revision);
                assert!(client.drain_change_batches().is_empty());
                assert_eq!(
                    client
                        .query("SELECT * FROM tasks ORDER BY id", &[])
                        .unwrap(),
                    rows
                );
                client.conn.execute_batch("DROP TRIGGER fail_run").unwrap();
            }
            for frame in &mut response.frames {
                if let Frame::PushResult { status, .. } = frame {
                    *status = PushStatus::Cached;
                }
            }
            let SyncOutcome::Ok(report) = client.process_response(&mut transport, response, &meta)
            else {
                panic!("retry failed");
            };
            assert_eq!(
                report.applied,
                if failure == "later-frame" {
                    vec![]
                } else {
                    ids[..2].to_vec()
                }
            );
            assert_eq!(client.pending_commit_ids(), ids[2..]);
            let batches = client.drain_change_batches();
            assert_eq!(batches.len(), usize::from(failure != "later-frame"));
            if let Some(batch) = batches.first() {
                assert_eq!(batch.status.as_ref().unwrap().outbox, 1);
            }
            assert_eq!(client.local_revision(), revision + 1);
        }
    }

    #[test]
    fn failed_push_result_preserves_memory_disk_and_retry_identity() {
        for failure in ["revision", "journal", "commit"] {
            for status in ["applied", "cached", "rejected", "conflict"] {
                let mut client = client();
                client.set_meta(LOG_EPOCH_KEY, "epoch-1");
                for id in ["first", "later"] {
                    client
                        .mutate(vec![Mutation::Upsert {
                            table: "tasks".to_owned(),
                            values: Map::from_iter([
                                ("id".to_owned(), Value::from(id)),
                                ("project_id".to_owned(), Value::from("p1")),
                            ]),
                            base_version: None,
                        }])
                        .unwrap();
                }
                let (_, meta) = client.build_request(false).unwrap();
                let ids = client.pending_commit_ids();
                let rows = client
                    .query("SELECT * FROM tasks ORDER BY id", &[])
                    .unwrap();
                let revision = client.local_revision();
                client.drain_change_batches();
                let (push_status, results) = match status {
                    "applied" => (PushStatus::Applied, vec![OpResult::Applied { op_index: 0 }]),
                    "cached" => (PushStatus::Cached, vec![OpResult::Applied { op_index: 0 }]),
                    "conflict" => (
                        PushStatus::Rejected,
                        vec![OpResult::Conflict {
                            op_index: 0,
                            code: "sync.version_conflict".to_owned(),
                            message: "conflict".to_owned(),
                            server_version: 1,
                            server_row: encode_row_json(
                                client.schema.table("tasks").unwrap(),
                                "first",
                                &Map::from_iter([
                                    ("id".to_owned(), Value::from("first")),
                                    ("project_id".to_owned(), Value::from("p1")),
                                ]),
                                &client.encryption,
                            )
                            .unwrap(),
                            conflict_columns: Vec::new(),
                        }],
                    ),
                    _ => (
                        PushStatus::Rejected,
                        vec![OpResult::Error {
                            op_index: 0,
                            code: "sync.validation_failed".to_owned(),
                            message: "rejected".to_owned(),
                            retryable: false,
                        }],
                    ),
                };
                let response = Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames: vec![
                        Frame::RespHeader {
                            required_schema_version: None,
                            latest_schema_version: None,
                            log_epoch: Some("epoch-1".to_owned()),
                            reset_required: Some(false),
                        },
                        Frame::PushResult {
                            client_commit_id: ids[0].clone(),
                            status: push_status,
                            commit_seq: Some(1),
                            results,
                        },
                    ],
                };
                client.conn.execute_batch(match failure {
                    "journal" => "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(FAIL, 'injected journal failure'); END",
                    "revision" => "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END",
                    _ => "PRAGMA foreign_keys = ON; CREATE TABLE ack_parent(id INTEGER PRIMARY KEY); CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_ack AFTER INSERT ON _syncular_commit_outcomes BEGIN INSERT INTO ack_child VALUES (1); END",
                }).unwrap();
                let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
                let outcome = client.process_response(&mut transport, response.clone(), &meta);
                assert_eq!(
                    client.pending_commit_ids(),
                    ids,
                    "{failure}/{status}: pending identity"
                );
                assert_eq!(
                    client.local_revision(),
                    revision,
                    "{failure}/{status}: revision"
                );
                assert!(client.commit_outcome(&ids[0]).unwrap().is_none());
                assert!(client.conflicts().is_empty());
                assert!(client.rejections().is_empty());
                assert!(client.drain_change_batches().is_empty());
                assert_eq!(
                    client
                        .query("SELECT * FROM tasks ORDER BY id", &[])
                        .unwrap(),
                    rows
                );
                assert!(
                    matches!(outcome, SyncOutcome::Failed { error_code, .. } if error_code == "client.outcome_persistence_failed"),
                    "{failure}/{status}: failed round"
                );
                client.conn.execute_batch("DROP TRIGGER fail_ack").unwrap();
                assert!(matches!(
                    client.process_response(&mut transport, response, &meta),
                    SyncOutcome::Ok(_)
                ));
                assert_eq!(client.pending_commit_ids(), ids[1..]);
                assert!(client.commit_outcome(&ids[0]).unwrap().is_some());
                assert_eq!(client.drain_change_batches().len(), 1);
            }
        }
    }

    #[test]
    fn mixed_push_results_reconcile_each_boundary_and_prune_once_per_response() {
        let mut client = client();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        for index in 0..4 {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), Value::from(format!("task-{index}"))),
                        ("project_id".to_owned(), Value::from("project-1")),
                    ]),
                    base_version: None,
                }])
                .expect("queue commit");
        }

        let (_, request_meta) = client.build_request(false).unwrap();
        let ids = &request_meta.pushed_ids;
        assert_eq!(ids.len(), 4);
        let response = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-1".to_owned()),
                    reset_required: Some(false),
                },
                Frame::PushResult {
                    client_commit_id: ids[0].clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(1),
                    results: vec![OpResult::Applied { op_index: 0 }],
                },
                Frame::PushResult {
                    client_commit_id: ids[1].clone(),
                    status: PushStatus::Cached,
                    commit_seq: Some(2),
                    results: vec![OpResult::Applied { op_index: 0 }],
                },
                Frame::PushResult {
                    client_commit_id: ids[2].clone(),
                    status: PushStatus::Rejected,
                    commit_seq: None,
                    results: vec![OpResult::Error {
                        op_index: 0,
                        code: "sync.validation_failed".to_owned(),
                        message: "rejected".to_owned(),
                        retryable: false,
                    }],
                },
                Frame::PushResult {
                    client_commit_id: ids[3].clone(),
                    status: PushStatus::Rejected,
                    commit_seq: None,
                    results: vec![OpResult::Error {
                        op_index: 0,
                        code: "sync.idempotency_cache_miss".to_owned(),
                        message: "retry".to_owned(),
                        retryable: true,
                    }],
                },
            ],
        };
        let mut transport =
            HostTransport::new_from_config(&json!({})).expect("no-network host transport");

        client.overlay_rebuild_count.set(0);
        client.outcome_prune_count.set(0);
        let outcome = client.process_response(&mut transport, response, &request_meta);
        let SyncOutcome::Ok(report) = outcome else {
            panic!("mixed push-result response failed");
        };

        assert_eq!(report.applied, ids[..2]);
        assert_eq!(report.rejected, ids[2..3]);
        assert_eq!(report.retryable, ids[3..4]);
        assert_eq!(client.pending_commit_ids(), ids[3..4]);
        assert_eq!(
            client
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .expect("query visible overlay"),
            ["task-0", "task-1", "task-3"]
                .map(|id| Map::from_iter([("id".to_owned(), Value::from(id))]))
                .to_vec()
        );
        // The successful ACK run and final rejection have distinct durable boundaries.
        assert_eq!(client.overlay_rebuild_count.get(), 2);
        assert_eq!(client.outcome_prune_count.get(), 1);
    }

    fn replay_schema(fts: bool) -> Value {
        json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"title","type":"string","nullable":false},
            {"name":"done","type":"boolean","nullable":false}
        ],"scopes":[{"pattern":"project:{project_id}"}], "ftsIndexes": if fts { json!([{"name":"tasks_fts","columns":["title"],"tokenize":"unicode61"}]) } else { json!([]) }}]})
    }

    #[test]
    fn aborted_schema_and_epoch_resets_restore_memory_and_durable_intent() {
        for schema_reset in [false, true] {
            let mut schema = replay_schema(false);
            let mut client =
                SyncClient::new("reset-failure".into(), &schema, ClientLimits::default()).unwrap();
            let id = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("queued")),
                        ("project_id".into(), json!("p1")),
                        ("title".into(), json!("old")),
                        ("done".into(), json!(false)),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            client.set_meta(LOG_EPOCH_KEY, "old");
            let revision = client.local_revision();
            let needed = client.sync_needed;
            client.drain_change_batches();
            client.drain_sync_intents();
            client.conn.execute_batch("CREATE TRIGGER refuse_revision BEFORE INSERT ON _syncular_meta WHEN NEW.key='localRevision' BEGIN SELECT RAISE(ABORT,'reset completion failed'); END;").unwrap();
            if schema_reset {
                schema["version"] = json!(2);
                schema["tables"][0]["columns"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|column| column["name"] != "title");
                client.schema = parse_schema_json(&schema).unwrap();
                assert!(client.run_schema_reset().is_err());
            } else {
                assert!(client.run_log_epoch_reset("new").is_err());
            }
            assert!(!client.upgrading);
            assert_eq!(client.sync_needed, needed);
            assert_eq!(client.local_revision(), revision);
            assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
            assert!(client.rejections.is_empty());
            assert!(client.commit_outcome(&id).unwrap().is_none());
            assert_eq!(client.get_meta(LOG_EPOCH_KEY).as_deref(), Some("old"));
            assert_eq!(
                client
                    .query("SELECT title FROM tasks WHERE id='queued'", &[])
                    .unwrap()[0]["title"],
                "old"
            );
            assert_eq!(
                client
                    .conn
                    .query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(client.drain_change_batches().is_empty());
            assert!(client.drain_sync_intents().is_empty());
            assert!(client.conn.is_autocommit());
        }
    }

    #[test]
    fn cached_blob_cleanup_propagates_delete_failures() {
        let schema = json!({"version":1,"tables":[{"name":"attachments","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"file","type":"blob_ref","nullable":true}],"scopes":[]}]});
        let mut client =
            SyncClient::new("blob-cleanup".into(), &schema, ClientLimits::default()).unwrap();
        client.conn.execute_batch("CREATE TRIGGER refuse_blob_cleanup BEFORE DELETE ON _syncular_blobs BEGIN SELECT RAISE(ABORT,'blob cleanup failed'); END;").unwrap();
        client.conn.execute("INSERT INTO _syncular_blobs(blob_id,bytes,byte_length,created_at_ms) VALUES ('test',X'01',1,0)", []).unwrap();
        client
            .subscribe("attachments".into(), "attachments".into(), vec![], None)
            .unwrap();
        client.subs[0].effective = Some(vec![]);
        client.persist_sub(&client.subs[0]).unwrap();
        let revision = client.local_revision();
        let (_, meta) = client.build_request(false).unwrap();
        let mut transport = CountingRealtimeTransport::default();
        let mut report = SyncReport::default();
        assert!(client
            .process_section(
                &mut transport,
                "attachments",
                SubStatus::Revoked,
                "sync.scope_revoked",
                vec![],
                vec![],
                Some((0, None)),
                &meta,
                &mut report
            )
            .is_err());
        assert_eq!(client.subs[0].state, SubState::Active);
        assert_eq!(client.local_revision(), revision);
        assert!(report.revoked.is_empty());
        assert!(client.conn.is_autocommit());
        client
            .conn
            .execute_batch("DROP TRIGGER refuse_blob_cleanup")
            .unwrap();
        assert!(client
            .process_section(
                &mut transport,
                "attachments",
                SubStatus::Revoked,
                "sync.scope_revoked",
                vec![],
                vec![],
                Some((0, None)),
                &meta,
                &mut report
            )
            .is_ok());
        assert_eq!(client.subs[0].state, SubState::Revoked);
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_blobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn overlay_replay_trigger_refuses_reopen_and_preserves_durable_intent() {
        let path =
            std::env::temp_dir().join(format!("syncular-replay-{}.db", uuid::Uuid::new_v4()));
        let schema = replay_schema(false);
        let mut client = SyncClient::open_path(
            "replay".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        let ids = ["early", "bad"].map(|id| {
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!(id)),
                        ("project_id".into(), json!("p1")),
                        ("title".into(), json!(id)),
                        ("done".into(), json!(false)),
                    ]),
                    base_version: None,
                }])
                .unwrap()
        });
        client.conn.execute_batch("DELETE FROM tasks; CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='bad' BEGIN SELECT RAISE(ABORT,'replay failed'); END;").unwrap();
        let revision = client.local_revision();
        drop(client);
        let error = SyncClient::open_path(
            "replay".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .err()
        .expect("reopen must fail");
        assert!(error.contains("replay failed"));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM _syncular_outbox", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            meta_get(&conn, LOCAL_REVISION_KEY),
            Some(revision.to_string())
        );
        conn.execute_batch("DROP TRIGGER fail_replay").unwrap();
        drop(conn);
        let reopened = SyncClient::open_path(
            "replay".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(reopened.pending_commit_ids(), ids);
        assert_eq!(
            reopened
                .query("SELECT id FROM tasks ORDER BY id", &[])
                .unwrap()
                .len(),
            2
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn overlay_replay_failure_rolls_back_push_and_pull_apply_boundaries() {
        let schema = replay_schema(false);
        let mut client =
            SyncClient::new("replay".into(), &schema, ClientLimits::default()).unwrap();
        client.set_meta(LOG_EPOCH_KEY, "epoch-1");
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("queued".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String("server".into())),
                    Some(ColumnValue::Boolean(false)),
                ],
                1,
            )
            .unwrap();
        client.rebuild_overlay().unwrap();
        let id = client
            .patch(
                "tasks",
                "queued",
                Map::from_iter([("title".into(), json!("local"))]),
                Some(1),
            )
            .unwrap();
        let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
        let base = client
            .query("SELECT * FROM _syncular_base_tasks", &[])
            .unwrap();
        let revision = client.local_revision();
        client.drain_change_batches();
        client.conn.execute_batch("CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.title='local' BEGIN SELECT RAISE(ABORT,'replay failed'); END").unwrap();
        let remote = vec![
            Some(ColumnValue::String("queued".into())),
            Some(ColumnValue::String("p1".into())),
            Some(ColumnValue::String("remote".into())),
            Some(ColumnValue::Boolean(false)),
        ];
        let bytes = crate::values::encode_row_json(
            client.schema.table("tasks").unwrap(),
            "queued",
            &Map::from_iter(
                client
                    .schema
                    .table("tasks")
                    .unwrap()
                    .columns
                    .iter()
                    .zip(&remote)
                    .map(|(column, value)| (column.name.clone(), column_value_to_json(value))),
            ),
            &client.encryption,
        )
        .unwrap();
        let change = ssp2::model::Change {
            table_index: 0,
            op: Op::Upsert,
            row_id: "queued".into(),
            row_version: Some(2),
            scopes: vec![("project_id".into(), "p1".into())],
            row: Some(bytes),
        };
        assert!(client
            .apply_commit_frame(&["tasks".into()], std::slice::from_ref(&change), Some(2))
            .is_err());
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
        assert_eq!(
            client
                .query("SELECT * FROM _syncular_base_tasks", &[])
                .unwrap(),
            base
        );
        assert_eq!(client.local_revision(), revision);
        assert!(client.drain_change_batches().is_empty());
        let response = Message {
            wire_version: 2,
            msg_kind: MsgKind::Response,
            frames: vec![
                Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch-1".into()),
                    reset_required: Some(false),
                },
                Frame::PushResult {
                    client_commit_id: id.clone(),
                    status: PushStatus::Applied,
                    commit_seq: Some(2),
                    results: vec![OpResult::Applied { op_index: 0 }],
                },
            ],
        };
        let (_, meta) = client.build_request(false).unwrap();
        let mut transport = HostTransport::new_from_config(&json!({})).unwrap();
        assert!(
            matches!(client.process_response(&mut transport,response.clone(),&meta),SyncOutcome::Failed { error_code,.. } if error_code=="client.outcome_persistence_failed")
        );
        assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
        assert!(client.commit_outcome(&id).unwrap().is_none());
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_acked_rows", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert_eq!(
            client
                .conn
                .query_row("SELECT count(*) FROM _syncular_row_deliveries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
        assert_eq!(client.local_revision(), revision);
        assert!(client.drain_change_batches().is_empty());
        client
            .conn
            .execute_batch("DROP TRIGGER fail_replay")
            .unwrap();
        assert!(matches!(
            client.process_response(&mut transport, response, &meta),
            SyncOutcome::Ok(_)
        ));
        client
            .apply_commit_frame(&["tasks".into()], &[change], Some(2))
            .unwrap();
        assert!(client.pending_commit_ids().is_empty());
        assert_eq!(
            client.query("SELECT title FROM tasks", &[]).unwrap()[0]["title"],
            json!("remote")
        );
    }

    #[test]
    fn overlay_replay_distinguishes_absence_from_sql_and_value_decode_errors() {
        let client = SyncClient::new(
            "replay".into(),
            &replay_schema(false),
            ClientLimits::default(),
        )
        .unwrap();
        let table = client.schema.table("tasks").unwrap();
        let patch = OutboxOp {
            table: "tasks".into(),
            row_id: "absent".into(),
            upsert: true,
            base_version: Some(1),
            values: Some(Map::from_iter([
                ("id".into(), json!("absent")),
                ("title".into(), json!("patch")),
            ])),
        };
        assert!(client.visible_row(table, "absent").unwrap().is_none());
        client
            .apply_outbox_ops([&patch])
            .expect("sparse replay over truly absent row");
        client
            .conn
            .execute_batch("INSERT INTO tasks VALUES ('bad','p1','title','invalid',1)")
            .unwrap();
        assert!(client
            .visible_row(table, "bad")
            .unwrap_err()
            .starts_with("sync.local_corrupt:"));
        let mut invalid = patch.clone();
        invalid.values = Some(Map::from_iter([
            ("id".into(), json!("bad-value")),
            ("project_id".into(), json!("p1")),
            ("title".into(), json!("title")),
            ("done".into(), json!({"bad":true})),
        ]));
        assert!(client
            .apply_outbox_ops([&invalid])
            .unwrap_err()
            .starts_with("sync.local_corrupt:"));
        client.conn.execute_batch("DROP TABLE tasks").unwrap();
        assert!(
            client.apply_outbox_ops([&patch]).is_err(),
            "SQL failure must not count as absence"
        );
    }

    #[test]
    fn overlay_replay_keeps_secondary_unique_deferral_and_lazy_base_precedence() {
        let mut schema = replay_schema(false);
        schema["tables"][0]["indexes"] =
            json!([{"name":"tasks_project_title", "columns":["project_id","title"],"unique":true}]);
        let mut client =
            SyncClient::new("replay".into(), &schema, ClientLimits::default()).unwrap();
        let id = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("queued")),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!("occupied")),
                    ("done".into(), json!(false)),
                ]),
                base_version: None,
            }])
            .unwrap();
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("server".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String("occupied".into())),
                    Some(ColumnValue::Boolean(false)),
                ],
                1,
            )
            .unwrap();
        client.rebuild_overlay_if_dirty().unwrap();
        assert_eq!(client.pending_commit_ids(), vec![id.clone()]);
        assert!(client
            .visible_row(client.schema.table("tasks").unwrap(), "queued")
            .unwrap()
            .is_none());
        assert!(client.rejections().is_empty());
        client.delete_base_row("tasks", "server").unwrap();
        client.rebuild_overlay_if_dirty().unwrap();
        assert!(client
            .visible_row(client.schema.table("tasks").unwrap(), "queued")
            .unwrap()
            .is_some());
        client
            .write_base_row(
                "tasks",
                &vec![
                    Some(ColumnValue::String("base".into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String("base-title".into())),
                    Some(ColumnValue::Boolean(false)),
                ],
                1,
            )
            .unwrap();
        client.conn.execute_batch("DROP TABLE tasks").unwrap();
        client
            .retain_failed_commit(
                "retained",
                &[OutboxOp {
                    table: "tasks".into(),
                    row_id: "base".into(),
                    upsert: true,
                    base_version: Some(1),
                    values: Some(Map::from_iter([
                        ("id".into(), json!("base")),
                        ("title".into(), json!("patch")),
                    ])),
                }],
            )
            .expect("an existing base must not read the unavailable visible table");
    }

    #[test]
    fn overlay_replay_fts_and_savepoint_release_failures_roll_back_all_visible_changes() {
        for failure in ["fts", "release"] {
            let mut client = SyncClient::new(
                "replay".into(),
                &replay_schema(true),
                ClientLimits::default(),
            )
            .unwrap();
            client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([
                        ("id".into(), json!("queued")),
                        ("project_id".into(), json!("p1")),
                        ("title".into(), json!("needle")),
                        ("done".into(), json!(false)),
                    ]),
                    base_version: None,
                }])
                .unwrap();
            let before = client.query("SELECT * FROM tasks", &[]).unwrap();
            let fts_before = client
                .query("SELECT _syncular_source_id,title FROM tasks_fts", &[])
                .unwrap();
            let triggers_before: Vec<String> = client
                .conn
                .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            if failure == "fts" {
                client.conn.execute_batch("CREATE TRIGGER fail_fts BEFORE INSERT ON _syncular_fts_tasks_fts BEGIN SELECT RAISE(ABORT,'fts replay failed'); END;").unwrap();
            } else {
                client.conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE deferred(id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_release AFTER INSERT ON tasks BEGIN INSERT INTO deferred VALUES ('missing'); END;").unwrap();
            }
            client.overlay_dirty.set(true);
            assert!(client.rebuild_overlay().is_err());
            assert!(client.overlay_dirty.get());
            assert!(client.conn.is_autocommit());
            assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), before);
            assert_eq!(
                client
                    .query("SELECT _syncular_source_id,title FROM tasks_fts", &[])
                    .unwrap(),
                fts_before
            );
            let original_triggers: Vec<String> = client.conn.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'fail_%' ORDER BY name").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
            assert_eq!(original_triggers, triggers_before);
            assert_eq!(client.pending_commit_ids().len(), 1);
            client
                .conn
                .execute_batch(if failure == "fts" {
                    "DROP TRIGGER fail_fts"
                } else {
                    "DROP TRIGGER fail_release"
                })
                .unwrap();
            client
                .rebuild_overlay()
                .expect("retry after removing the fault");
        }
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
    fn reopening_preserves_immutable_subscription_identity_and_progress() {
        let path = std::env::temp_dir().join(format!(
            "syncular-subscription-identity-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({
            "version": 1,
            "tables": [
                {
                    "name": "tasks",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "project:{project_id}" }]
                },
                {
                    "name": "docs",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "org_id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false }
                    ],
                    "scopes": [
                        { "pattern": "org:{org_id}" },
                        { "pattern": "project:{projectId}", "column": "project_id" }
                    ]
                }
            ]
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
                .subscribe(
                    "stable-subscription".to_owned(),
                    "tasks".to_owned(),
                    vec![(
                        "project_id".to_owned(),
                        vec!["p2".to_owned(), "p1".to_owned()],
                    )],
                    Some(r#"{"view":"v1"}"#.to_owned()),
                )
                .expect("persist subscription");
            let persisted = {
                let subscription = first
                    .subs
                    .iter_mut()
                    .find(|subscription| subscription.id == "stable-subscription")
                    .expect("subscription");
                subscription.cursor = 41;
                subscription.bootstrap_state = Some("resume-token".to_owned());
                subscription.effective = Some(vec![(
                    "project_id".to_owned(),
                    vec!["p1".to_owned(), "p2".to_owned()],
                )]);
                subscription.synced_once = true;
                subscription.clone()
            };
            first.persist_sub(&persisted).unwrap();
        }

        let mut reopened = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("reopen");
        let progress = reopened
            .subscription_state("stable-subscription")
            .expect("persisted state");
        assert_eq!(progress.cursor, 41);
        assert!(progress.has_resume_token);

        reopened
            .subscribe(
                "stable-subscription".to_owned(),
                "tasks".to_owned(),
                vec![(
                    "project_id".to_owned(),
                    vec!["p1".to_owned(), "p2".to_owned(), "p1".to_owned()],
                )],
                Some(r#"{"view":"v1"}"#.to_owned()),
            )
            .expect("canonical intent is idempotent");
        assert_eq!(
            reopened
                .subscription_state("stable-subscription")
                .expect("unchanged state")
                .cursor,
            progress.cursor
        );

        for (table, scopes, params) in [
            (
                "tasks",
                vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                Some(r#"{"view":"v1"}"#.to_owned()),
            ),
            (
                "tasks",
                vec![(
                    "project_id".to_owned(),
                    vec!["p2".to_owned(), "p1".to_owned()],
                )],
                Some(r#"{"view":"v2"}"#.to_owned()),
            ),
            (
                "docs",
                vec![
                    ("org_id".to_owned(), vec!["o1".to_owned()]),
                    ("projectId".to_owned(), vec!["p1".to_owned()]),
                ],
                Some(r#"{"view":"v1"}"#.to_owned()),
            ),
        ] {
            let error = reopened
                .subscribe(
                    "stable-subscription".to_owned(),
                    table.to_owned(),
                    scopes,
                    params,
                )
                .expect_err("identity rebind must fail");
            assert!(error.starts_with("client.subscription_intent_mismatch:"));
            assert_eq!(
                reopened
                    .subscription_state("stable-subscription")
                    .expect("unchanged state")
                    .cursor,
                progress.cursor
            );
        }

        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn reopening_clears_a_schema_floor_the_running_app_already_satisfies() {
        let path = std::env::temp_dir().join(format!(
            "syncular-satisfied-schema-floor-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({
            "version": 23,
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
                .subscribe(
                    "tasks".to_owned(),
                    "tasks".to_owned(),
                    vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                    None,
                )
                .expect("persist subscription");
            first.set_schema_floor(Some(SchemaFloor {
                required_schema_version: Some(22),
                latest_schema_version: Some(22),
            }));
        }

        let mut reopened = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("reopen");
        assert!(reopened.schema_floor().is_none());
        assert!(reopened.get_meta(SCHEMA_FLOOR_KEY).is_none());
        assert!(reopened.sync_needed());
        assert!(matches!(
            reopened.drain_sync_intents().as_slice(),
            [SyncIntent::Interactive]
        ));
        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn reopening_keeps_an_unsatisfied_schema_floor_stopped() {
        let path = std::env::temp_dir().join(format!(
            "syncular-unsatisfied-schema-floor-{}.db",
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
                .subscribe(
                    "tasks".to_owned(),
                    "tasks".to_owned(),
                    vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                    None,
                )
                .expect("persist subscription");
            first.set_schema_floor(Some(SchemaFloor {
                required_schema_version: Some(2),
                latest_schema_version: Some(2),
            }));
        }

        let reopened = SyncClient::open_path_with_identity(
            None,
            &schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("reopen");
        assert_eq!(
            reopened.schema_floor(),
            Some(&SchemaFloor {
                required_schema_version: Some(2),
                latest_schema_version: Some(2),
            })
        );
        assert!(!reopened.sync_needed());
        drop(reopened);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn schema_bump_precedes_index_ddl_and_prunes_removed_subscriptions() {
        let path = std::env::temp_dir().join(format!(
            "syncular-indexed-column-bump-{}.db",
            uuid::Uuid::new_v4()
        ));
        let old_schema = json!({
            "version": 1,
            "tables": [
                {
                    "name": "tasks",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "project:{project_id}" }]
                },
                {
                    "name": "legacy",
                    "primaryKey": "id",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "project_id", "type": "string", "nullable": false }
                    ],
                    "scopes": [{ "pattern": "project:{project_id}" }]
                }
            ]
        });
        {
            let mut first = SyncClient::open_path_with_identity(
                None,
                &old_schema,
                ClientLimits::default(),
                path.to_str().expect("UTF-8 temp path"),
            )
            .expect("open old schema");
            first
                .subscribe(
                    "legacy-sub".to_owned(),
                    "legacy".to_owned(),
                    vec![("project_id".to_owned(), vec!["p1".to_owned()])],
                    None,
                )
                .expect("persist legacy subscription");
        }

        let new_schema = json!({
            "version": 2,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "project_id", "type": "string", "nullable": false },
                    { "name": "facility_membership_id", "type": "string", "nullable": true }
                ],
                "scopes": [{ "pattern": "project:{project_id}" }],
                "indexes": [{
                    "name": "tasks_by_membership",
                    "columns": ["project_id", "facility_membership_id"],
                    "unique": false
                }]
            }]
        });
        let upgraded = SyncClient::open_path_with_identity(
            None,
            &new_schema,
            ClientLimits::default(),
            path.to_str().expect("UTF-8 temp path"),
        )
        .expect("open upgraded schema");
        let columns = upgraded
            .conn
            .prepare("PRAGMA table_info(tasks)")
            .expect("prepare columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");
        assert!(columns.contains(&"facility_membership_id".to_owned()));
        let index_count: i64 = upgraded
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'tasks_by_membership'",
                [],
                |row| row.get(0),
            )
            .expect("query index");
        assert_eq!(index_count, 1);
        assert!(upgraded.subscription_state("legacy-sub").is_none());
        drop(upgraded);
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
    fn retained_rejection_survives_file_reopen_and_security_purge() {
        let path =
            std::env::temp_dir().join(format!("syncular-retained-{}.db", uuid::Uuid::new_v4()));
        let schema = json!({ "version": 1, "tables": [{ "name": "tasks", "primaryKey": "id", "columns": [
            { "name": "id", "type": "string", "nullable": false },
            { "name": "project_id", "type": "string", "nullable": false },
            { "name": "title", "type": "string", "nullable": false }
        ], "scopes": [{ "pattern": "project:{project_id}" }] }] });
        {
            let mut first = SyncClient::open_path(
                "retained-native".to_owned(),
                &schema,
                ClientLimits::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            first
                .write_base_row(
                    "tasks",
                    &vec![
                        Some(ColumnValue::String("t1".into())),
                        Some(ColumnValue::String("p1".into())),
                        Some(ColumnValue::String("server".into())),
                    ],
                    1,
                )
                .unwrap();
            first.rebuild_overlay().expect("rebuild overlay");
            let operation = OutboxOp {
                table: "tasks".into(),
                row_id: "t1".into(),
                upsert: true,
                base_version: Some(1),
                values: Some(Map::from_iter([
                    ("id".into(), json!("t1")),
                    ("title".into(), json!("mine")),
                ])),
            };
            first
                .retain_failed_commit("retained", std::slice::from_ref(&operation))
                .unwrap();
            first
                .persist_commit_outcome(
                    "retained",
                    CommitOutcomeStatus::Rejected,
                    &[],
                    Some(&[operation]),
                )
                .unwrap();
            first.rebuild_overlay().expect("rebuild overlay");
        }
        {
            let mut reopened = SyncClient::open_path(
                "retained-native".to_owned(),
                &schema,
                ClientLimits::default(),
                path.to_str().unwrap(),
            )
            .unwrap();
            let row = reopened
                .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
                .expect("read visible row")
                .unwrap();
            assert_eq!(row.0[2], Some(ColumnValue::String("mine".into())));
            assert_eq!(
                reopened
                    .commit_outcome("retained")
                    .unwrap()
                    .unwrap()
                    .retained_rows
                    .unwrap()[0]
                    .server_row
                    .as_ref()
                    .unwrap()["title"],
                json!("server")
            );
            reopened
                .conn
                .execute("DELETE FROM _syncular_base_tasks WHERE id = 't1'", [])
                .unwrap();
            reopened.rebuild_overlay().expect("rebuild overlay");
            assert!(reopened
                .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
                .expect("read visible row")
                .is_none());
            let retained = reopened.commit_outcome("retained").unwrap().unwrap();
            assert!(retained.retained_rows.is_some());
            assert_eq!(
                retained.operations.unwrap()[0].values.as_ref().unwrap()["title"],
                json!("mine")
            );
            reopened
                .purge_local_data(&LocalDataPurgeInput {
                    purge_id: "protected-purge".into(),
                    targets: vec![LocalDataPurgeTarget {
                        table: "tasks".into(),
                        selectors: BTreeMap::from_iter([("project_id".into(), vec!["p1".into()])]),
                    }],
                })
                .unwrap();
            assert!(reopened
                .visible_row(reopened.schema.table("tasks").unwrap(), "t1")
                .expect("read visible row")
                .is_none());
            assert!(reopened
                .commit_outcome("retained")
                .unwrap()
                .unwrap()
                .retained_rows
                .is_none());
        }
        std::fs::remove_file(path).unwrap();
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
            conflict_columns: vec!["project_id".to_owned()],
            operation: Some(CommitOperation {
                table: "tasks".to_owned(),
                row_id: "t1".to_owned(),
                op: "upsert".to_owned(),
                base_version: Some(1),
                values: None,
            }),
        };
        let failed_operations = vec![
            OutboxOp {
                upsert: true,
                table: "tasks".to_owned(),
                row_id: "t1".to_owned(),
                base_version: Some(1),
                values: None,
            },
            OutboxOp {
                upsert: true,
                table: "tasks".to_owned(),
                row_id: "status-event-1".to_owned(),
                base_version: Some(0),
                values: None,
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
            assert_eq!(
                reopened.conflicts()[0].conflict_columns,
                vec!["project_id".to_owned()],
                "conflictColumns survives the journal round trip"
            );
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
                "SELECT id, project_id, _sync_version AS server_version FROM tasks ORDER BY id",
                &[],
                &coverage,
                None,
            )
            .expect("owner snapshot");
        let mut reader = FileQuerySnapshotReader::new(path.to_string_lossy());
        let sidecar = reader
            .query_snapshot(
                "SELECT id, project_id, _sync_version AS server_version FROM tasks ORDER BY id",
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
        assert_eq!(sidecar.rows[0]["server_version"], -1);
        assert!(!sidecar.coverage.complete);
        assert_eq!(sidecar.coverage.pending.len(), 1);
        assert_eq!(sidecar.coverage.missing.len(), 1);

        drop(reader);
        drop(client);
        std::fs::remove_file(path).expect("remove temp database");
    }

    #[test]
    fn owned_query_failures_classify_order_bound_and_clear() {
        let io = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(266),
            Some("private SQLite prose".to_owned()),
        ));
        assert_eq!(io.code, Some("client.storage_io"));
        assert_eq!(io.sqlite_code, Some(266));
        assert_eq!(io.message, "local SQLite storage I/O failed");
        let corrupt = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(26),
            None,
        ));
        assert_eq!(corrupt.code, Some("client.storage_corrupt"));
        assert!(!io.retryable());
        assert!(!corrupt.retryable());

        // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including extended codes, are
        // transient lock contention: classified busy and retryable.
        for (raw, extended) in [(5, 5), (5 | (1 << 8), 261), (6, 6), (6 | (1 << 8), 262)] {
            let busy = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(raw),
                Some("database is locked".to_owned()),
            ));
            assert_eq!(busy.code, Some("client.storage_busy"));
            assert_eq!(busy.sqlite_code, Some(extended));
            assert_eq!(busy.message, "local SQLite storage is busy");
            assert!(busy.retryable());
        }
        let unrelated = QueryReadFailure::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some("generic SQLite prose".to_owned()),
        ));
        assert_eq!(unrelated.code, None);
        assert!(!unrelated.retryable());

        let mut client = client();
        let generic = QueryReadFailure::from("private query prose".to_owned());
        client.record_query_read(
            QueryOwner {
                id: "first",
                tables: &["tasks", "tasks"],
            },
            Some(&generic),
        );
        client.record_query_read(
            QueryOwner {
                id: "second",
                tables: &["tasks"],
            },
            Some(&generic),
        );
        client.record_query_read(
            QueryOwner {
                id: "first",
                tables: &["docs"],
            },
            Some(&io),
        );
        let failures = &client
            .diagnostics_snapshot(&Default::default())
            .expect("diagnostics")
            .query_failures;
        assert_eq!(
            failures
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second", "first"]
        );
        assert_eq!(failures[1].tables, vec!["docs"]);
        assert_eq!(failures[1].code, "client.storage_io");

        for index in 0..=MAX_DIAGNOSTIC_QUERY_FAILURES {
            client.record_query_read(
                QueryOwner {
                    id: &format!("query-{index}"),
                    tables: &["tasks"],
                },
                Some(&generic),
            );
        }
        let failures = &client
            .diagnostics_snapshot(&Default::default())
            .expect("bounded diagnostics")
            .query_failures;
        assert_eq!(failures.len(), MAX_DIAGNOSTIC_QUERY_FAILURES);
        assert_eq!(failures.last().expect("last failure").id, "query-256");

        client
            .query_snapshot(
                "SELECT id FROM tasks",
                &[],
                &[],
                Some(QueryOwner {
                    id: "query-256",
                    tables: &["tasks"],
                }),
            )
            .expect("successful owned read");
        assert!(client
            .diagnostics_snapshot(&Default::default())
            .expect("cleared diagnostics")
            .query_failures
            .iter()
            .all(|entry| entry.id != "query-256"));
    }

    #[test]
    fn image_chunks_keep_their_committed_prefix_after_a_later_invalid_row() {
        let mut client = client();
        let image = Connection::open_in_memory().unwrap();
        image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, _syncular_version INTEGER NOT NULL);
            WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
            INSERT INTO tasks SELECT printf('%05d',x),CASE WHEN x=1500 THEN NULL ELSE 'p1' END,1 FROM n;
            CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
            INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',2050);").unwrap();
        let table = client.schema.table("tasks").unwrap().clone();
        let scopes = vec![("project_id".into(), vec!["p1".into()])];
        assert!(client
            .apply_sqlite_image(&image, &table, true, &scopes, 2050, 7, "digest")
            .is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            1024
        );
        assert_eq!(client.drain_change_batches().len(), 1);
        image
            .execute("UPDATE tasks SET project_id='p1' WHERE id='01500'", [])
            .unwrap();
        assert!(matches!(
            client.apply_sqlite_image(&image, &table, true, &scopes, 2050, 7, "digest"),
            Ok(2050)
        ));
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            2050
        );
        assert_eq!(client.drain_change_batches().len(), 3);
    }

    #[test]
    fn eviction_chunks_commit_before_failure_and_resume_with_exact_scope() {
        let mut client = client();
        let base = WindowBase {
            table: "tasks".into(),
            variable: "project_id".into(),
            fixed_scopes: Vec::new(),
            params: None,
        };
        client
            .set_window(&base, &["p1".into(), "p2".into()])
            .unwrap();
        client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
            INSERT INTO _syncular_base_tasks SELECT printf('%05d',x),'p1',1 FROM n;
            INSERT INTO _syncular_base_tasks VALUES ('held','p2',1);
            INSERT INTO tasks SELECT * FROM _syncular_base_tasks;
            CREATE TRIGGER interrupt_evict BEFORE DELETE ON tasks WHEN old.id='01500' BEGIN SELECT RAISE(ABORT,'interrupted chunk'); END;").unwrap();
        client.drain_change_batches();
        assert!(client.set_window(&base, &["p2".into()]).is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            1027
        );
        assert_eq!(client.window_state(&base).units, vec!["p2"]);
        assert_eq!(client.load_pending_evictions().unwrap().len(), 1);
        assert_eq!(client.drain_change_batches().len(), 1);
        client
            .conn
            .execute_batch("DROP TRIGGER interrupt_evict")
            .unwrap();
        client.drain_pending_evictions().unwrap();
        assert!(client.load_pending_evictions().unwrap().is_empty());
        assert_eq!(
            client.query("SELECT id FROM tasks", &[]).unwrap()[0]["id"],
            "held"
        );
        assert_eq!(client.drain_change_batches().len(), 2);
    }

    #[test]
    fn eviction_marker_failures_roll_back_window_changes() {
        let mut client = client();
        let base = WindowBase {
            table: "tasks".into(),
            variable: "project_id".into(),
            fixed_scopes: Vec::new(),
            params: None,
        };
        client.set_window(&base, &["p1".into()]).unwrap();
        client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050)
            INSERT INTO _syncular_base_tasks SELECT printf('%05d',x),'p1',1 FROM n;
            INSERT INTO tasks SELECT * FROM _syncular_base_tasks;
            CREATE TRIGGER fail_marker BEFORE INSERT ON _syncular_window_pending_evict BEGIN SELECT RAISE(ABORT,'marker failed'); END;").unwrap();
        let revision = client.local_revision();
        assert!(client.set_window(&base, &[]).is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(client.local_revision(), revision);
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            2050
        );
        assert_eq!(client.window_state(&base).units, vec!["p1"]);
        client.conn.execute_batch("DROP TRIGGER fail_marker;
            CREATE TRIGGER interrupt_evict BEFORE DELETE ON tasks WHEN old.id='01500' BEGIN SELECT RAISE(ABORT,'interrupted chunk'); END;").unwrap();
        assert!(client.set_window(&base, &[]).is_err());
        client.conn.execute_batch("DROP TRIGGER interrupt_evict;
            CREATE TRIGGER fail_marker BEFORE DELETE ON _syncular_window_pending_evict BEGIN SELECT RAISE(ABORT,'marker failed'); END;").unwrap();
        assert!(client.drain_pending_evictions().is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            2
        );
        assert!(client.set_window(&base, &["p1".into()]).is_err());
        assert!(client.conn.is_autocommit());
        assert!(client.window_state(&base).units.is_empty());
        assert!(client.subs.is_empty());
        assert_eq!(
            client
                .query(
                    "SELECT count(*) AS n FROM _syncular_window_pending_evict",
                    &[]
                )
                .unwrap()[0]["n"],
            1
        );
        client
            .conn
            .execute_batch("DROP TRIGGER fail_marker")
            .unwrap();
        client.set_window(&base, &["p1".into()]).unwrap();
        assert_eq!(client.window_state(&base).units, vec!["p1"]);
    }

    #[test]
    fn malformed_eviction_marker_is_reported_without_starting_cleanup() {
        let mut client = client();
        client
            .conn
            .execute(
                "INSERT INTO _syncular_window_pending_evict VALUES ('broken','tasks','{')",
                [],
            )
            .unwrap();
        assert_eq!(
            client.drain_pending_evictions().unwrap_err(),
            "sync.local_corrupt: invalid pending eviction scopes"
        );
        assert!(client.conn.is_autocommit());
        assert!(client.enqueue_startup_sync_if_needed().is_err());
    }

    #[test]
    fn image_chunks_reject_null_primary_keys() {
        let mut client = client();
        let image = Connection::open_in_memory().unwrap();
        image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
            WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1025)
            INSERT INTO tasks SELECT NULL,'p1',1 FROM n;
            CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
            INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1025);").unwrap();
        let table = client.schema.table("tasks").unwrap().clone();
        assert!(client
            .apply_sqlite_image(
                &image,
                &table,
                true,
                &[("project_id".into(), vec!["p1".into()])],
                1025,
                7,
                "digest"
            )
            .is_err());
        assert!(client.conn.is_autocommit());
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            0
        );
    }

    #[test]
    fn import_chunks_with_unique_constraints_match_full_pending_replay() {
        for images in [false, true] {
            let schema = json!({"version":1,"tables": (["tasks", "notes"].map(|name| json!({
                "name":name,"primaryKey":"id","columns":[
                    {"name":"id","type":"string","nullable":false},
                    {"name":"project_id","type":"string","nullable":false},
                    {"name":"title","type":"string","nullable":false}],
                "scopes":[{"pattern":"project:{project_id}"}],
                "indexes":[{"name":format!("{name}_unique_title"),"columns":["title"],"unique":true}],
                "ftsIndexes":[{"name":format!("{name}_fts"),"columns":["title"],"tokenize":"unicode61"}]
            })))});
            let mut actual =
                SyncClient::new("actual".into(), &schema, ClientLimits::default()).unwrap();
            let mut reference =
                SyncClient::new("reference".into(), &schema, ClientLimits::default()).unwrap();
            let scopes = vec![("project_id".into(), vec!["p1".into()])];
            for client in [&mut actual, &mut reference] {
                client
                    .subscribe("tasks".into(), "tasks".into(), scopes.clone(), None)
                    .unwrap();
                client.subs[0].effective = Some(scopes.clone());
                for (table, id, title) in [
                    ("tasks", "a", "original"),
                    ("tasks", "b", "occupied"),
                    ("tasks", "c", "deleted"),
                    ("notes", "n", "untouched"),
                ] {
                    client
                        .write_base_row(
                            table,
                            &vec![
                                Some(ColumnValue::String(id.into())),
                                Some(ColumnValue::String("p1".into())),
                                Some(ColumnValue::String(title.into())),
                            ],
                            1,
                        )
                        .unwrap();
                }
                client.rebuild_overlay_if_dirty().expect("rebuild overlay");
                client
                    .mutate(vec![
                        Mutation::Upsert {
                            table: "tasks".into(),
                            values: Map::from_iter([
                                ("id".into(), Value::from("a")),
                                ("project_id".into(), Value::from("p1")),
                                ("title".into(), Value::from("available")),
                            ]),
                            base_version: None,
                        },
                        Mutation::Delete {
                            table: "tasks".into(),
                            row_id: "c".into(),
                            base_version: None,
                        },
                        Mutation::Upsert {
                            table: "tasks".into(),
                            values: Map::from_iter([
                                ("id".into(), Value::from("local")),
                                ("project_id".into(), Value::from("p1")),
                                ("title".into(), Value::from("local value")),
                            ]),
                            base_version: None,
                        },
                        Mutation::Upsert {
                            table: "notes".into(),
                            values: Map::from_iter([
                                ("id".into(), Value::from("n")),
                                ("project_id".into(), Value::from("p1")),
                                ("title".into(), Value::from("pending note")),
                            ]),
                            base_version: None,
                        },
                    ])
                    .unwrap();
            }
            let pending = actual.pending_commit_ids();
            actual.overlay_rebuild_count.set(0);
            for (id, title) in [
                ("b", "available"),
                ("b", "occupied"),
                ("a", "server original"),
                ("d", "local value"),
                ("d", "released"),
                ("c", "redelivered"),
            ] {
                let table = actual.schema.table("tasks").unwrap().clone();
                let values = vec![
                    Some(ColumnValue::String(id.into())),
                    Some(ColumnValue::String("p1".into())),
                    Some(ColumnValue::String(title.into())),
                ];
                if images {
                    let image = Connection::open_in_memory().unwrap();
                    image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
                        CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
                        INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1);").unwrap();
                    image
                        .execute("INSERT INTO tasks VALUES (?1,'p1',?2,2)", [id, title])
                        .unwrap();
                    assert!(matches!(
                        actual.apply_sqlite_image(&image, &table, false, &scopes, 1, 7, "digest"),
                        Ok(1)
                    ));
                } else {
                    let segment = RowsSegment {
                        table: "tasks".into(),
                        schema_version: 1,
                        columns: table.wire_columns.clone(),
                        blocks: vec![vec![ssp2::segment::SegmentRow {
                            server_version: 2,
                            values: values.clone(),
                        }]],
                    };
                    assert!(matches!(actual.apply_segment(0, &segment, false), Ok(1)));
                }
                reference.write_base_row("tasks", &values, 2).unwrap();
                reference.rebuild_overlay().expect("rebuild overlay");
                for table in ["tasks", "notes"] {
                    for sql in [format!("SELECT * FROM {table} ORDER BY id"),format!("SELECT _syncular_source_id,title FROM {table}_fts ORDER BY _syncular_source_id"),format!("SELECT source_id FROM _syncular_fts_{table}_fts ORDER BY source_id")] {
                        assert_eq!(actual.query(&sql, &[]).unwrap(), reference.query(&sql, &[]).unwrap(), "images={images}, {id}/{title}: {sql}");
                    }
                }
                assert_eq!(actual.pending_commit_ids(), pending);
            }
            assert_eq!(
                actual.overlay_rebuild_count.get(),
                0,
                "each chunk must leave unrelated tables alone"
            );
            let before = actual
                .query("SELECT * FROM tasks ORDER BY id", &[])
                .unwrap();
            let fts_before = actual
                .query("SELECT * FROM tasks_fts ORDER BY _syncular_source_id", &[])
                .unwrap();
            let revision = actual.local_revision();
            actual.conn.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON tasks WHEN new.id='b' BEGIN SELECT RAISE(ABORT,'restore failed'); END").unwrap();
            let table = actual.schema.table("tasks").unwrap().clone();
            let segment = RowsSegment {
                table: "tasks".into(),
                schema_version: 1,
                columns: table.wire_columns.clone(),
                blocks: vec![vec![ssp2::segment::SegmentRow {
                    server_version: 3,
                    values: vec![
                        Some(ColumnValue::String("b".into())),
                        Some(ColumnValue::String("p1".into())),
                        Some(ColumnValue::String("fresh".into())),
                    ],
                }]],
            };
            assert!(actual.apply_segment(0, &segment, false).is_err());
            assert!(actual.conn.is_autocommit());
            assert_eq!(
                actual
                    .query("SELECT * FROM tasks ORDER BY id", &[])
                    .unwrap(),
                before
            );
            assert_eq!(
                actual
                    .query("SELECT * FROM tasks_fts ORDER BY _syncular_source_id", &[])
                    .unwrap(),
                fts_before
            );
            assert_eq!(actual.local_revision(), revision);
            assert_eq!(actual.pending_commit_ids(), pending);
        }
    }

    #[test]
    fn import_reconciliation_preserves_typed_pending_primary_keys() {
        for (kind, a, b) in [
            ("string", json!("a"), json!("b")),
            ("integer", json!(1), json!(2)),
            ("boolean", json!(true), json!(false)),
            ("json", json!("1"), json!("2")),
        ] {
            let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[{"name":"id","type":kind,"nullable":false},{"name":"title","type":"string","nullable":false}],"scopes":[],"indexes":[{"name":"unique_title","columns":["title"],"unique":true}]}]});
            for images in [false, true] {
                let mut client =
                    SyncClient::new("typed".into(), &schema, ClientLimits::default()).unwrap();
                let table = client.schema.table("tasks").unwrap().clone();
                client
                    .subscribe("tasks".into(), "tasks".into(), vec![], None)
                    .unwrap();
                for (id, title) in [(&a, "original"), (&b, "occupied")] {
                    client
                        .write_base_row(
                            "tasks",
                            &vec![
                                json_to_column_value(&table.columns[0], Some(id)).unwrap(),
                                Some(ColumnValue::String(title.into())),
                            ],
                            1,
                        )
                        .unwrap();
                }
                client.rebuild_overlay_if_dirty().expect("rebuild overlay");
                client
                    .mutate(vec![Mutation::Upsert {
                        table: "tasks".into(),
                        values: Map::from_iter([
                            ("id".into(), a.clone()),
                            ("title".into(), json!("available")),
                        ]),
                        base_version: None,
                    }])
                    .unwrap();
                client.overlay_rebuild_count.set(0);
                for (title, expected) in [("available", "original"), ("occupied", "available")] {
                    let values = vec![
                        json_to_column_value(&table.columns[0], Some(&b)).unwrap(),
                        Some(ColumnValue::String(title.into())),
                    ];
                    if images {
                        let image = Connection::open_in_memory().unwrap();
                        image.execute_batch("CREATE TABLE tasks(id PRIMARY KEY, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
                            CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);
                            INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1);").unwrap();
                        image
                            .execute(
                                "INSERT INTO tasks VALUES (?1,?2,2)",
                                rusqlite::params![RowParam::Cell(&values[0]), title],
                            )
                            .unwrap();
                        assert!(
                            matches!(
                                client.apply_sqlite_image(
                                    &image,
                                    &table,
                                    false,
                                    &[],
                                    1,
                                    7,
                                    "digest"
                                ),
                                Ok(1)
                            ),
                            "{kind}, images={images}"
                        );
                    } else {
                        let segment = RowsSegment {
                            table: "tasks".into(),
                            schema_version: 1,
                            columns: table.wire_columns.clone(),
                            blocks: vec![vec![ssp2::segment::SegmentRow {
                                server_version: 2,
                                values,
                            }]],
                        };
                        assert!(
                            matches!(client.apply_segment(0, &segment, false), Ok(1)),
                            "{kind}"
                        );
                    }
                    let key = json_to_column_value(&table.columns[0], Some(&a)).unwrap();
                    let actual: String = client
                        .conn
                        .query_row(
                            "SELECT title FROM tasks WHERE id=?1",
                            [RowParam::Cell(&key)],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(actual, expected, "{kind}, images={images}");
                }
                assert_eq!(client.overlay_rebuild_count.get(), 0);
            }
        }
    }

    fn unique_import_fixture(rows: usize) -> (SyncClient, Connection, TableSchema) {
        let schema = json!({"version":1,"tables": (["tasks", "notes"].map(|name| json!({
            "name":name,"primaryKey":"id","columns":[{"name":"id","type":"string","nullable":false},{"name":"project_id","type":"string","nullable":false},{"name":"title","type":"string","nullable":false}],
            "scopes":[{"pattern":"project:{project_id}"}],"indexes":[{"name":format!("{name}_title"),"columns":["title"],"unique":true}],
            "ftsIndexes":[{"name":format!("{name}_fts"),"columns":["title"],"tokenize":"unicode61"}]
        })))});
        let mut client =
            SyncClient::new("unique-import".into(), &schema, ClientLimits::default()).unwrap();
        client.conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO _syncular_base_notes SELECT printf('%08d',x),'p2','note-'||x,1 FROM n").unwrap();
        client.rebuild_overlay().expect("rebuild overlay");
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("offline")),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!("pending edit")),
                ]),
                base_version: None,
            }])
            .unwrap();
        let image = Connection::open_in_memory().unwrap();
        image.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
            CREATE TABLE _syncular_segment(format INTEGER, \"table\" TEXT, \"schemaVersion\" INTEGER, \"asOfCommitSeq\" INTEGER, \"scopeDigest\" TEXT, \"rowCount\" INTEGER);").unwrap();
        image.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO tasks SELECT printf('%08d',x),'p1','item-'||x,1 FROM n",[rows]).unwrap();
        image
            .execute(
                "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',?1)",
                [rows],
            )
            .unwrap();
        client.overlay_rebuild_count.set(0);
        let table = client.schema.table("tasks").unwrap().clone();
        (client, image, table)
    }

    #[test]
    fn sqlite_full_image_import_retains_the_first_code_and_recovers() {
        let (mut client, image, table) = unique_import_fixture(1);
        image
            .execute("UPDATE tasks SET title = ?1", ["full ".repeat(32768)])
            .unwrap();
        client
            .conn
            .execute_batch("PRAGMA max_page_count = 1")
            .unwrap();
        let effective = [("project_id".into(), vec!["p1".into()])];
        assert!(client
            .apply_sqlite_image(&image, &table, true, &effective, 1, 7, "digest")
            .is_err());
        let failure = client.storage_failure.borrow().clone().unwrap();
        assert_eq!(failure.code, Some("client.storage_full"));
        assert_eq!(failure.sqlite_code, Some(13));
        assert!(!failure.message.contains("rollback"));
        assert!(client.conn.is_autocommit());
        client
            .conn
            .execute_batch("PRAGMA max_page_count = 1073741823")
            .unwrap();
        assert!(matches!(
            client.apply_sqlite_image(&image, &table, true, &effective, 1, 7, "digest"),
            Ok(1)
        ));
        assert!(client.conn.is_autocommit());
    }

    #[test]
    fn authoring_storage_failures_are_structured_and_scoped() {
        let path = std::env::temp_dir().join(format!(
            "syncular-authoring-failure-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"title","type":"string","nullable":false}],"scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client = SyncClient::open_path(
            "authoring".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client");
        client.create_synced_tables().expect("create synced tables");
        // Return BUSY immediately rather than waiting out the file timeout.
        client.conn.busy_timeout(std::time::Duration::ZERO).unwrap();

        let upsert = |id: &str| {
            vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!(id)),
                    ("project_id".into(), json!("p1")),
                    ("title".into(), json!("first")),
                ]),
                base_version: None,
            }]
        };

        let locker = Connection::open(&path).expect("second connection");
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let busy = client.mutate(upsert("t1")).expect_err("busy write");
        assert_eq!(busy.code, "client.storage_busy");
        assert!(busy.retryable);
        assert_eq!(busy.details.as_ref().unwrap()["sqliteCode"], 5);
        assert!(client.pending_commit_ids().is_empty());
        assert_eq!(client.local_revision(), 0);

        // A stale classified failure must not classify a later unrelated one.
        let invalid = client.mutate(Vec::new()).expect_err("empty commit");
        assert_eq!(invalid.code, "sync.invalid_request");
        assert_eq!(invalid.message, "the authoring request is invalid");
        assert!(
            invalid.details.as_ref().unwrap()["legacyCause"]
                .as_str()
                .unwrap()
                .contains("at least one operation"),
            "{invalid:?}"
        );

        locker.execute_batch("ROLLBACK").unwrap();
        let id = client.mutate(upsert("t1")).expect("retry after busy");
        assert_eq!(client.pending_commit_ids(), vec![id]);
        assert_eq!(client.local_revision(), 1);

        // A later storage failure reports its own code and details.
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let busy_again = client.mutate(upsert("t2")).expect_err("busy write again");
        assert_eq!(busy_again.code, "client.storage_busy");
        assert!(busy_again.retryable);
        locker.execute_batch("ROLLBACK").unwrap();

        // Non-retryable classified failures keep their sqlite evidence too.
        let full = ClientError::from(QueryReadFailure::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(13),
            Some("database or disk is full".to_owned()),
        )));
        assert_eq!(full.code, "client.storage_full");
        assert!(!full.retryable);
        assert_eq!(full.details.as_ref().unwrap()["sqliteCode"], 13);

        drop(locker);
        drop(client);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn caller_value_failures_are_invalid_request_and_leave_no_outbox_entry() {
        let path = std::env::temp_dir().join(format!(
            "syncular-caller-values-{}.db",
            uuid::Uuid::new_v4()
        ));
        let schema = json!({"version":1,"tables":[{"name":"tasks","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"title","type":"string","nullable":false},
            {"name":"priority","type":"integer","nullable":false},
            {"name":"payload","type":"bytes","nullable":false}],"scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client = SyncClient::open_path(
            "caller-values".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client");
        client.create_synced_tables().expect("create synced tables");

        let values = |id: &str| {
            Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("project_id".to_owned(), json!("p1")),
                ("title".to_owned(), json!("first")),
                ("priority".to_owned(), json!(1)),
                ("payload".to_owned(), json!({"$bytes": "0a"})),
            ])
        };
        let upsert = |values: Map<String, Value>| {
            vec![Mutation::Upsert {
                table: "tasks".into(),
                values,
                base_version: None,
            }]
        };
        let seed = client.mutate(upsert(values("t1"))).expect("seed row");
        let rows = client.query("SELECT * FROM tasks", &[]).unwrap();

        // §6.1/§7.1: every caller value the authoring seam rejects reports the
        // same stable identity instead of the internal-failure default, keeps
        // the dynamic cause in `details.legacyCause`, and leaves the durable
        // outbox, the local revision and the projection untouched.
        for (label, override_value, cause) in [
            ("unknown column", ("nope", json!(1)), "unknown column"),
            (
                "internal sync column",
                ("_sync_version", json!(1)),
                "internal sync column",
            ),
            ("wrong value type", ("title", json!(7)), "expected a string"),
            (
                "malformed bytes envelope",
                ("payload", json!({"$bytes": "zz"})),
                "bad hex",
            ),
        ] {
            let mut full = values("t2");
            full.insert(override_value.0.to_owned(), override_value.1);
            let error = client.mutate(upsert(full)).expect_err(label);
            assert_eq!(error.code, "sync.invalid_request", "{label}: {error:?}");
            assert_eq!(error.message, "the authoring request is invalid", "{label}");
            assert!(!error.retryable, "{label}");
            let legacy = error.details.as_ref().unwrap()["legacyCause"]
                .as_str()
                .unwrap();
            assert!(
                legacy.starts_with("sync.invalid_request: ") && legacy.contains(cause),
                "{label}: {legacy}"
            );
            assert_eq!(client.pending_commit_ids(), vec![seed.clone()], "{label}");
            assert_eq!(client.local_revision(), 1, "{label}");
            assert_eq!(
                client.query("SELECT * FROM tasks", &[]).unwrap(),
                rows,
                "{label}"
            );
        }

        // A full-row upsert presents every column, so a missing required one is
        // the caller's failure too.
        let mut missing = values("t3");
        missing.remove("payload");
        let missing_error = client.mutate(upsert(missing)).expect_err("missing column");
        assert_eq!(missing_error.code, "sync.invalid_request");
        assert!(missing_error.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap()
            .contains("is not nullable"));

        // A primary key the wire cannot render is rejected before any op is
        // recorded.
        let mut bad_row_id = values("t4");
        bad_row_id.insert("id".to_owned(), json!({"nested": true}));
        let row_id_error = client.mutate(upsert(bad_row_id)).expect_err("bad rowId");
        assert_eq!(row_id_error.code, "sync.invalid_request");

        // The sparse route classifies the same value failures.
        for (label, partial, cause) in [
            (
                "patch wrong value type",
                ("priority", json!("high")),
                "expected an integer",
            ),
            ("patch unknown column", ("nope", json!(1)), "unknown column"),
        ] {
            let error = client
                .patch(
                    "tasks",
                    "t1",
                    Map::from_iter([(partial.0.to_owned(), partial.1)]),
                    None,
                )
                .expect_err(label);
            assert_eq!(error.code, "sync.invalid_request", "{label}: {error:?}");
            assert_eq!(error.message, "the authoring request is invalid", "{label}");
            assert!(
                error.details.as_ref().unwrap()["legacyCause"]
                    .as_str()
                    .unwrap()
                    .contains(cause),
                "{label}"
            );
        }
        assert_eq!(client.pending_commit_ids(), vec![seed.clone()]);
        assert_eq!(client.local_revision(), 1);
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);

        // Nothing is poisoned: the next valid authoring call succeeds.
        let next = client
            .mutate(upsert(values("t5")))
            .expect("valid after failures");
        assert_ne!(next, seed);

        drop(client);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn client_error_maps_legacy_codes_and_static_messages() {
        let code_only = ClientError::from("sync.unknown_table".to_owned());
        assert_eq!(code_only.code, "sync.unknown_table");
        assert_eq!(code_only.message, "the commit targets an unknown table");
        assert!(code_only.details.is_none());

        let dynamic = ClientError::from(
            "sync.invalid_request: table \"tasks\": patch cannot write scope column".to_owned(),
        );
        assert_eq!(dynamic.code, "sync.invalid_request");
        assert_eq!(dynamic.message, "the authoring request is invalid");
        assert!(dynamic.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap()
            .contains("patch cannot write scope column"));

        let unclassified =
            ClientError::from("a commit must contain at least one operation".to_owned());
        assert_eq!(unclassified.code, "client.failed");
        assert_eq!(unclassified.message, "the local authoring operation failed");
        assert!(unclassified.details.as_ref().unwrap()["legacyCause"]
            .as_str()
            .unwrap()
            .contains("at least one operation"));

        // An unclassified QueryReadFailure keeps its numeric SQLite evidence.
        let metadata = ClientError::from(QueryReadFailure {
            code: None,
            sqlite_code: Some(1),
            sqlite_message: Some("generic SQLite prose".to_owned()),
            rollback_failure: Some(Box::new(QueryReadFailure::from(
                rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), None),
            ))),
            message: "unclassified read".to_owned(),
        });
        assert_eq!(metadata.code, "client.failed");
        assert_eq!(metadata.message, "the local authoring operation failed");
        let details = metadata.details.as_ref().unwrap();
        assert_eq!(details["sqliteCode"], 1);
        assert_eq!(details["sqliteMessage"], "generic SQLite prose");
        assert_eq!(details["rollbackFailure"]["sqliteCode"], 1);
        assert_eq!(details["legacyCause"], "unclassified read");
    }

    #[test]
    fn schema_marker_read_keeps_storage_classification() {
        let busy = schema_marker_read_failure(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            Some("database is locked".to_owned()),
        ));
        assert!(busy.starts_with("client.storage_busy:"), "{busy}");
        let invalid = schema_marker_read_failure(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some("unreadable".to_owned()),
        ));
        assert_eq!(
            invalid,
            "sync.local_corrupt: persisted local schema marker is unreadable or invalid"
        );

        // A real exclusive lock on the marker read surfaces BUSY, not corrupt,
        // and the guard writes nothing.
        let path =
            std::env::temp_dir().join(format!("syncular-marker-busy-{}.db", uuid::Uuid::new_v4()));
        let setup = Connection::open(&path).expect("setup connection");
        setup
            .execute_batch(
                "CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value TEXT);\n                 INSERT INTO _syncular_meta VALUES ('localSchemaVersion','1');",
            )
            .unwrap();
        let locker = Connection::open(&path).expect("locker connection");
        locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let reader = Connection::open(&path).expect("reader connection");
        reader.busy_timeout(std::time::Duration::ZERO).unwrap();
        let locked = read_local_schema_version(&reader, 1).expect_err("locked marker read");
        assert!(locked.starts_with("client.storage_busy:"), "{locked}");
        locker.execute_batch("ROLLBACK").unwrap();
        assert_eq!(read_local_schema_version(&reader, 1).unwrap(), Some(1));
        let rows = setup
            .query_row("SELECT count(*) FROM _syncular_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(rows, 1, "the guard performed no writes");
        drop(reader);
        drop(locker);
        drop(setup);
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(feature = "crdt-yjs")]
    #[test]
    fn crdt_authoring_pre_read_preserves_storage_classification() {
        let path =
            std::env::temp_dir().join(format!("syncular-crdt-busy-{}.db", uuid::Uuid::new_v4()));
        let schema = json!({"version":1,"tables":[{"name":"notes","primaryKey":"id","columns":[
            {"name":"id","type":"string","nullable":false},
            {"name":"project_id","type":"string","nullable":false},
            {"name":"doc","type":"crdt","nullable":true,"crdtType":"yjs-doc"}],
            "scopes":[{"pattern":"project:{project_id}"}]}]});
        let mut client = SyncClient::open_path(
            "crdt-busy".into(),
            &schema,
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .expect("open client");
        client.create_synced_tables().expect("create synced tables");
        client.conn.busy_timeout(std::time::Duration::ZERO).unwrap();

        let locker = Connection::open(&path).expect("locker connection");
        locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let busy = client
            .crdt_apply_update("notes", "n1", "doc", &[])
            .expect_err("busy crdt pre-read");
        assert_eq!(busy.code, "client.storage_busy");
        assert!(busy.retryable);
        assert_eq!(busy.details.as_ref().unwrap()["sqliteCode"], 5);
        assert!(client.pending_commit_ids().is_empty());
        assert_eq!(client.local_revision(), 0);

        locker.execute_batch("ROLLBACK").unwrap();
        drop(locker);
        drop(client);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn large_unique_import_copies_no_unrelated_tables() {
        let (mut client, image, table) = unique_import_fixture(10240);
        let pending = client.pending_commit_ids();
        client.conn.execute_batch("CREATE TRIGGER unrelated_insert BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'unrelated insert'); END;
            CREATE TRIGGER unrelated_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'unrelated delete'); END;").unwrap();
        assert!(matches!(
            client.apply_sqlite_image(
                &image,
                &table,
                true,
                &[("project_id".into(), vec!["p1".into()])],
                10240,
                7,
                "digest"
            ),
            Ok(10240)
        ));
        assert_eq!(client.overlay_rebuild_count.get(), 0);
        assert_eq!(client.pending_commit_ids(), pending);
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks", &[])
                .unwrap()[0]["n"],
            10241
        );
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM tasks_fts", &[])
                .unwrap()[0]["n"],
            10241
        );
        assert_eq!(
            client
                .query("SELECT count(*) AS n FROM notes_fts", &[])
                .unwrap()[0]["n"],
            8192
        );
    }

    #[test]
    #[ignore = "manual scaling benchmark; see bench/README.md"]
    fn benchmark_unique_image_import() {
        let mut samples = Vec::new();
        for rows in [10240, 51200, 102400] {
            for trial in 0..4 {
                let (mut client, image, table) = unique_import_fixture(rows);
                let start = std::time::Instant::now();
                assert!(
                    matches!(client.apply_sqlite_image(&image,&table,true,&[("project_id".into(),vec!["p1".into()])],rows as i64,7,"digest"),Ok(n) if n as usize == rows)
                );
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(
                    client
                        .query("SELECT count(*) AS n FROM tasks", &[])
                        .unwrap()[0]["n"],
                    rows + 1
                );
                assert_eq!(
                    client
                        .query("SELECT count(*) AS n FROM tasks_fts", &[])
                        .unwrap()[0]["n"],
                    rows + 1
                );
                assert_eq!(
                    client
                        .query("SELECT count(*) AS n FROM notes_fts", &[])
                        .unwrap()[0]["n"],
                    8192
                );
                assert_eq!(client.pending_commit_ids().len(), 1);
                if trial > 0 {
                    samples.push(json!({"rows":rows,"trial":trial,"elapsedMs":elapsed,"fullRebuilds":client.overlay_rebuild_count.get()}));
                }
            }
        }
        let artifact = json!({"boundary":"Rust core; in-memory SQLite; one pending edit; secondary unique indexes and FTS; 8192 unrelated rows; one warmup per size","optimized":!cfg!(debug_assertions),"sqliteVersion":rusqlite::version(),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"sourceHash":bytes_to_hex(&Sha256::digest(include_str!("client.rs").as_bytes())),"samples":samples});
        let output = serde_json::to_string_pretty(&artifact).unwrap();
        if let Ok(path) = std::env::var("SYNCULAR_IMPORT_BENCH_OUTPUT") {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap();
            file.write_all(output.as_bytes()).unwrap();
        } else {
            println!("{output}");
        }
    }

    #[test]
    fn local_fts_projection_tracks_optimistic_overlay_rebuilds() {
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "catalogue_codes",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "release_id", "type": "string", "nullable": false },
                    { "name": "code", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "release:{release_id}" }],
                "ftsIndexes": [{
                    "name": "catalogue_codes_fts",
                    "columns": ["code", "title"],
                    "tokenize": "unicode61 remove_diacritics 2"
                }]
            }]
        });
        let mut client = SyncClient::new("fts-test".to_owned(), &schema, ClientLimits::default())
            .expect("FTS5 client");
        let insert_trigger: String = client
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_ai'",
                [],
                |row| row.get(0),
            )
            .expect("insert trigger");
        let replace_guard: String = client
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bi'",
                [],
                |row| row.get(0),
            )
            .expect("replace guard");
        assert!(!insert_trigger.contains("DELETE FROM"));
        assert!(replace_guard.contains("BEFORE INSERT"));
        assert!(replace_guard.contains("WHEN EXISTS"));
        let search = |client: &SyncClient, query: &str| {
            client
                .query(
                    "SELECT c.id FROM catalogue_codes_fts f JOIN catalogue_codes c ON CAST(c.id AS TEXT) = f._syncular_source_id WHERE catalogue_codes_fts MATCH ?1 ORDER BY c.id",
                    &[Value::from(query)],
                )
                .expect("FTS query")
        };

        client
            .mutate(vec![Mutation::Upsert {
                table: "catalogue_codes".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("c1")),
                    ("release_id".to_owned(), Value::from("r1")),
                    ("code".to_owned(), Value::from("A01")),
                    ("title".to_owned(), Value::from("Cholera")),
                ]),
                base_version: None,
            }])
            .expect("insert code");
        assert_eq!(search(&client, "cholera").len(), 1);
        let prior = client
            .query("SELECT rowid, * FROM catalogue_codes_fts", &[])
            .unwrap();
        client
            .conn
            .execute_batch("DROP TABLE _syncular_fts_catalogue_codes_fts")
            .unwrap();
        client.create_synced_tables().unwrap();
        assert_eq!(
            client
                .query("SELECT rowid, * FROM catalogue_codes_fts", &[])
                .unwrap(),
            prior
        );
        let plan = client.query("EXPLAIN QUERY PLAN SELECT rowid FROM catalogue_codes_fts WHERE rowid = (SELECT id FROM _syncular_fts_catalogue_codes_fts WHERE source_id = 'c1')", &[]).unwrap();
        let rendered = serde_json::to_string(&plan).unwrap();
        assert!(rendered.contains("COVERING INDEX"));
        assert!(rendered.contains("INDEX 0:="));
        client.conn.execute_batch("SAVEPOINT test_mapping; DELETE FROM catalogue_codes WHERE id='c1'; ROLLBACK TO test_mapping; RELEASE test_mapping").unwrap();
        assert_eq!(search(&client, "cholera").len(), 1);

        client
            .mutate(vec![Mutation::Upsert {
                table: "catalogue_codes".to_owned(),
                values: Map::from_iter([
                    ("id".to_owned(), Value::from("c1")),
                    ("release_id".to_owned(), Value::from("r1")),
                    ("code".to_owned(), Value::from("A01")),
                    ("title".to_owned(), Value::from("Enteric infection")),
                ]),
                base_version: None,
            }])
            .expect("update code");
        assert!(search(&client, "cholera").is_empty());
        assert_eq!(search(&client, "enteric").len(), 1);

        client
            .mutate(vec![Mutation::Delete {
                table: "catalogue_codes".to_owned(),
                row_id: "c1".to_owned(),
                base_version: None,
            }])
            .expect("delete code");
        assert!(search(&client, "enteric").is_empty());
    }

    #[test]
    fn application_authorized_local_purge_is_exact_atomic_and_idempotent() {
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "patient_notes",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "practice_id", "type": "string", "nullable": false },
                    { "name": "encryption_key_id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "practice:{practice_id}" }],
                "ftsIndexes": [{
                    "name": "patient_notes_fts",
                    "columns": ["title"],
                    "tokenize": "unicode61 remove_diacritics 2"
                }]
            }]
        });
        let mut client = SyncClient::new(
            "local-purge-test".to_owned(),
            &schema,
            ClientLimits::default(),
        )
        .expect("local purge client");
        client
            .conn
            .execute(
                "INSERT INTO _syncular_base_patient_notes(id, practice_id, encryption_key_id, title, _syncular_version) VALUES
                 ('target', 'practice-1', 'key-revoked', 'Target original', 1),
                 ('unrelated', 'practice-1', 'key-held', 'Unrelated original', 1)",
                [],
            )
            .expect("seed base rows");
        client.overlay_dirty.set(true);
        client.rebuild_overlay_if_dirty().expect("rebuild overlay");

        let note = |id: &str, key_id: &str, title: &str| {
            Map::from_iter([
                ("id".to_owned(), Value::from(id)),
                ("practice_id".to_owned(), Value::from("practice-1")),
                ("encryption_key_id".to_owned(), Value::from(key_id)),
                ("title".to_owned(), Value::from(title)),
            ])
        };
        let doomed = client
            .mutate(vec![
                Mutation::Upsert {
                    table: "patient_notes".to_owned(),
                    values: note("target", "key-revoked", "Target changed"),
                    base_version: None,
                },
                Mutation::Upsert {
                    table: "patient_notes".to_owned(),
                    values: note("unrelated", "key-held", "Unrelated changed"),
                    base_version: None,
                },
            ])
            .expect("doomed commit");
        let kept = client
            .mutate(vec![Mutation::Upsert {
                table: "patient_notes".to_owned(),
                values: note("kept", "key-held", "Kept optimistic"),
                base_version: None,
            }])
            .expect("kept commit");
        client.drain_change_batches();

        let input = LocalDataPurgeInput {
            purge_id: "purge-001".to_owned(),
            targets: vec![LocalDataPurgeTarget {
                table: "patient_notes".to_owned(),
                selectors: BTreeMap::from([(
                    "encryption_key_id".to_owned(),
                    vec!["key-revoked".to_owned()],
                )]),
            }],
        };
        assert_eq!(
            client.purge_local_data(&input).expect("apply purge"),
            LocalDataPurgeResult {
                already_applied: false,
                purged_rows: 1,
                dropped_commits: 1,
            }
        );
        let rows = client
            .query("SELECT id, title FROM patient_notes ORDER BY id", &[])
            .expect("visible rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "kept");
        assert_eq!(rows[1]["id"], "unrelated");
        assert_eq!(rows[1]["title"], "Unrelated original");
        let fts = client
            .query(
                "SELECT n.id FROM patient_notes_fts f JOIN patient_notes n ON CAST(n.id AS TEXT) = f._syncular_source_id WHERE patient_notes_fts MATCH 'target'",
                &[],
            )
            .expect("fts query");
        assert!(fts.is_empty());
        assert_eq!(client.outbox.len(), 1);
        assert_eq!(client.outbox[0].client_commit_id, kept);
        let outcome = client
            .commit_outcome(&doomed)
            .expect("read doomed outcome")
            .expect("doomed outcome");
        assert_eq!(outcome.status, CommitOutcomeStatus::Rejected);
        match &outcome.results[0] {
            CommitOperationOutcome::Error { rejection } => {
                assert_eq!(rejection.code, "client.local_data_purged");
                assert_eq!(rejection.client_commit_id, doomed);
            }
            other => panic!("expected local purge rejection, got {other:?}"),
        }
        assert_eq!(client.drain_change_batches().len(), 1);
        assert_eq!(
            client.purge_local_data(&input).expect("retry purge"),
            LocalDataPurgeResult {
                already_applied: true,
                purged_rows: 0,
                dropped_commits: 0,
            }
        );
        let conflicting = LocalDataPurgeInput {
            purge_id: input.purge_id.clone(),
            targets: vec![LocalDataPurgeTarget {
                table: "patient_notes".to_owned(),
                selectors: BTreeMap::from([(
                    "encryption_key_id".to_owned(),
                    vec!["key-held".to_owned()],
                )]),
            }],
        };
        assert!(client
            .purge_local_data(&conflicting)
            .expect_err("id collision must fail")
            .contains("already used with a different plan"));
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
    /// the current codec at send time. A key's presence IS the §6.1 sparse
    /// presence set — both the overlay and the wire payload derive from it.
    values: Option<Map<String, Value>>,
}

impl From<&OutboxOp> for CommitOperation {
    fn from(operation: &OutboxOp) -> Self {
        Self {
            table: operation.table.clone(),
            row_id: operation.row_id.clone(),
            op: if operation.upsert { "upsert" } else { "delete" }.to_owned(),
            base_version: operation.base_version,
            values: operation.values.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct OutboxCommit {
    client_commit_id: String,
    ops: Vec<OutboxOp>,
}

/// One commit's `(table, value keys)` per upsert operation — the classification
/// shape the §7.4.4 send-time drop and the RFC 0005 D6 audit share, so the two
/// can never disagree about which commits cannot re-encode.
fn commit_audit_operations(commit: &OutboxCommit) -> Vec<(&str, Vec<&str>)> {
    commit
        .ops
        .iter()
        .filter(|operation| operation.upsert)
        .map(|operation| {
            (
                operation.table.as_str(),
                operation
                    .values
                    .as_ref()
                    .map(|values| values.keys().map(String::as_str).collect())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

type FailedCommit = (OutboxCommit, Map<String, Value>);

#[derive(Debug, Clone)]
struct CompiledLocalDataPurgeTarget {
    table: String,
    selectors: Vec<(String, Vec<String>)>,
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

#[derive(Debug)]
pub(crate) struct RequestMeta {
    pushed_ids: Vec<String>,
    /// Subscription id → the request carried `cursor < 0` and no resume
    /// token (§5.6 first-page detection: a *fresh* bootstrap).
    fresh: Vec<(String, bool)>,
    pub(crate) accept: u8,
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
const MAX_LOCAL_PURGE_TARGETS: usize = 64;
const MAX_LOCAL_PURGE_SELECTORS: usize = 8;
const MAX_LOCAL_PURGE_VALUES: usize = 128;
const MAX_LOCAL_PURGE_VALUE_LENGTH: usize = 256;
pub const SECURITY_PREFLIGHT_REQUIRED_CODE: &str = "client.security_preflight_required";

/// Dirty visible tables; `None` means a whole-replica recovery/reset.
struct OverlayDirty(RefCell<Option<BTreeSet<String>>>);

impl OverlayDirty {
    fn clean() -> Self {
        Self(RefCell::new(Some(BTreeSet::new())))
    }
    fn get(&self) -> bool {
        self.0
            .borrow()
            .as_ref()
            .is_none_or(|tables| !tables.is_empty())
    }
    fn set(&self, dirty: bool) {
        *self.0.borrow_mut() = if dirty { None } else { Some(BTreeSet::new()) };
    }
    fn table(&self, table: &str) {
        if let Some(tables) = self.0.borrow_mut().as_mut() {
            tables.insert(table.to_owned());
        }
    }
    fn snapshot(&self) -> Option<BTreeSet<String>> {
        self.0.borrow().clone()
    }
    fn restore(&self, tables: Option<BTreeSet<String>>) {
        *self.0.borrow_mut() = tables;
    }
}

pub struct SyncClient {
    #[cfg(feature = "bench-internals")]
    benchmark_phases: Recorder,
    conn: Connection,
    schema: ClientSchema,
    client_id: String,
    limits: ClientLimits,
    subs: Vec<Subscription>,
    outbox: Vec<OutboxCommit>,
    failed_commits: Vec<FailedCommit>,
    retain_failed_commits: bool,
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
    /// §8.8: how sync rounds treat the realtime binding, and its exact
    /// availability state with the evidence behind a lost or refused one.
    realtime_policy: RealtimePolicy,
    realtime_state: RealtimeState,
    realtime_reason_code: Option<String>,
    realtime_retry_delay_ms: Option<u64>,
    /// §8.6 presence: scopeKey → (`actorId clientId` peer key → peer).
    presence: HashMap<String, HashMap<String, PresencePeer>>,
    /// Client clock (epoch ms) for the §5.4 `urlExpiresAtMs` check; the
    /// host may pin it (conformance runs on a virtual clock).
    now_ms: Option<i64>,
    /// §5.11 client-side encryption keys (`keyId → key bytes`). Empty ⇒ E2EE
    /// off. The encrypt/decrypt seam (`values.rs`) is compiled only under the
    /// `e2ee` feature; without it, a schema with encrypted columns fails loud.
    encryption: crate::values::EncryptionConfig,
    /// Fail-closed host bootstrap gate. While set, command hosts permit only
    /// status/lifecycle inspection and an exact authorized local purge.
    security_preflight: bool,
    transport_enabled: bool,
    /// RFC 0005 D2/D8: the previous-version capture config. `None` (default)
    /// means the feature is off; the descriptor write and the container orphan
    /// sweep still happen.
    previous_version: Option<PreviousVersionContextConfig>,
    /// Per-table primary-key upsert SQL, built once per (full table name) —
    /// the row write path runs per row during bootstrap (§5.6), so the SQL
    /// string (and, via `prepare_cached`, its compiled statement) is reused
    /// instead of being rebuilt and re-prepared per row. Cleared on a §7.4.3
    /// schema reset (the column lists may have changed).
    insert_sql: RefCell<HashMap<String, String>>,
    /// §7.1: reconcile only tables whose base/outbox changed. Whole-replica
    /// reset and restart explicitly invalidate every table.
    overlay_dirty: OverlayDirty,
    // First SQLite failure of the current operation, before savepoint cleanup.
    storage_failure: RefCell<Option<QueryReadFailure>>,
    /// Test-only structural performance signal: response processing must not
    /// turn a batch of acknowledgements into one full overlay rebuild each.
    #[cfg(test)]
    overlay_rebuild_count: Cell<usize>,
    #[cfg(test)]
    acknowledged_replay_count: Cell<usize>,
    /// Test-only structural performance signal: outcome retention is enforced
    /// once per response rather than once per acknowledgement.
    #[cfg(test)]
    outcome_prune_count: Cell<usize>,
    /// Exact observer-transaction output drained by command/FFI hosts.
    progress: ProgressObserver,
    change_queue: VecDeque<ClientChangeBatch>,
    sync_intent_queue: VecDeque<SyncIntent>,
    /// Explicit exponential retry policy for transient transport failures.
    retry_delay_ms: u64,
    /// §7.6: the background retry the current round scheduled, if any.
    round_retry_delay_ms: Option<u64>,
    active_round: Option<uuid::Uuid>,
    last_round: Option<DiagnosticLastRound>,
    last_change: Option<DiagnosticLastChange>,
    /// §7.6: latest failed owned snapshot read per owner id, oldest first.
    query_failures: Vec<DiagnosticQueryFailure>,
}

pub(crate) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
/// §7.4.1 `_syncular_meta` helpers. Free functions so RFC 0005's
/// previous-version module reads and writes the SAME records as the client
/// instead of growing a parallel meta layer.
pub(crate) fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM _syncular_meta WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO _syncular_meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    );
}

pub(crate) fn meta_delete(conn: &Connection, key: &str) {
    let _ = conn.execute(
        "DELETE FROM _syncular_meta WHERE key = ?1",
        rusqlite::params![key],
    );
}

/// Seek by the existing key while retaining the exact legacy text match.
fn row_id_predicate(table: &TableSchema) -> String {
    let key = quote_ident(&table.primary_key);
    let text_match = format!("CAST({key} AS TEXT) = ?1");
    match table.columns[table.pk_index].ty {
        ColumnType::String | ColumnType::Json => {
            format!("{key} = ?1 AND {text_match}")
        }
        // Native columns have no declared SQLite affinity. Match the stored
        // integer bind type explicitly. Unary + removes expression affinity so
        // SQLite can seek the typeless key; the text check preserves exact IDs.
        ColumnType::Integer | ColumnType::Boolean => {
            format!("{key} = +CAST(?1 AS INTEGER) AND {text_match}")
        }
        // REAL-to-text conversion can round distinct values to the same text.
        // Narrowing those matches by numeric equality would change behavior.
        _ => text_match,
    }
}

fn is_local_operation_code_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
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

const FTS_SOURCE_ID_COLUMN: &str = "_syncular_source_id";

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

// Retain a typed primary key across the current import chunk without copying row payloads.
fn owned_sql_value(param: impl rusqlite::ToSql) -> Result<SqlValue, String> {
    match param.to_sql().map_err(|error| error.to_string())? {
        ToSqlOutput::Owned(value) => Ok(value),
        ToSqlOutput::Borrowed(value) => {
            SqlValue::try_from(value).map_err(|error| error.to_string())
        }
        _ => Err("sync.invalid_request: unsupported SQLite key parameter".into()),
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

pub(crate) fn sql_ref_to_json(column: &Column, value: rusqlite::types::ValueRef<'_>) -> Value {
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

/// §7.5: SQLite failures classify by result code into [`QueryReadFailure`].
fn query_connection(
    conn: &Connection,
    sql: &str,
    params: &[QueryValue],
) -> Result<Vec<QueryRow>, QueryReadFailure> {
    crate::query_guard::assert_read_only_query(sql)?;
    let lowered_sql = crate::query_guard::lower_public_query_sql(sql);
    let bound: Vec<SqlValue> = params
        .iter()
        .map(json_param_to_sql)
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(&lowered_sql)?;
    let column_names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let bound_refs: Vec<&dyn rusqlite::ToSql> =
        bound.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let mut sql_rows = stmt.query(bound_refs.as_slice())?;
    let mut out = Vec::new();
    while let Some(row) = sql_rows.next()? {
        let mut record = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let value = row.get_ref(i)?;
            record.insert(name.clone(), sql_ref_to_json_dynamic(value));
        }
        out.push(record);
    }
    Ok(out)
}

fn persisted_window_state(
    conn: &Connection,
    base: &WindowBase,
) -> Result<WindowState, QueryReadFailure> {
    let mut stmt = conn.prepare(
        "SELECT windows.unit, subscriptions.state_json
           FROM _syncular_windows AS windows
           JOIN _syncular_subscriptions AS subscriptions
             ON subscriptions.id = windows.sub_id
          WHERE windows.base = ?1
          ORDER BY windows.unit ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![window_base_key(base)], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut units = Vec::new();
    let mut pending = Vec::new();
    for row in rows {
        let (unit, raw) = row?;
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
) -> Result<QuerySnapshot, QueryReadFailure> {
    conn.execute_batch("SAVEPOINT syncular_snapshot_read")?;
    let result: Result<QuerySnapshot, QueryReadFailure> = (|| {
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
            conn.execute_batch("RELEASE syncular_snapshot_read")?;
            Ok(snapshot)
        }
        Err(mut error) => {
            if let Err(rollback) = conn
                .execute_batch("ROLLBACK TO syncular_snapshot_read; RELEASE syncular_snapshot_read")
            {
                error.rollback_failure = Some(Box::new(QueryReadFailure::from(rollback)));
            }
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

    /// Hosts report an owned failure, and the first success after it, to the
    /// owning core through [`SyncClient::record_query_read`] (§7.6).
    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[Value],
        coverage: &[WindowCoverage],
    ) -> Result<QuerySnapshot, QueryReadFailure> {
        snapshot_connection(self.connection()?, sql, params, coverage)
    }
}

fn validate_authority_reads(
    schema: &ClientSchema,
    declarations: &[crate::api::AuthorityReadDeclaration],
) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for read in declarations {
        let table = schema
            .table(&read.table)
            .ok_or("client.authority_read_forbidden: authority table is not declared")?;
        let plain = |name: &str| {
            table.columns.iter().enumerate().any(|(i, c)| {
                c.name == name
                    && name != "authority_version"
                    && !name.starts_with("_sync")
                    && !table.encrypted_columns.iter().any(|e| e.index == i)
                    && matches!(
                        c.ty,
                        ssp2::segment::ColumnType::String
                            | ssp2::segment::ColumnType::Integer
                            | ssp2::segment::ColumnType::Float
                            | ssp2::segment::ColumnType::Boolean
                            | ssp2::segment::ColumnType::Json
                    )
            })
        };
        if !seen.insert(&read.table)
            || read.columns.is_empty()
            || read.columns.iter().collect::<BTreeSet<_>>().len() != read.columns.len()
            || !read.columns.contains(&table.primary_key)
            || !read.columns.iter().all(|c| plain(c))
            || read.scopes.is_empty()
            || !read.scopes.iter().all(|(v, values)| {
                table
                    .scope_column(v)
                    .is_some_and(|c| read.columns.iter().any(|column| column == c) && plain(c))
                    && !values.is_empty()
                    && values.iter().all(|v| !v.is_empty() && v != "*")
            })
        {
            return Err("client.authority_read_forbidden: authority reads require plain columns, a primary key and nonempty plain scope selectors".into());
        }
    }
    Ok(())
}

// §7.4.2: every open and recreation checks before any persistent writes.
/// A marker read that hit a recognized SQLite storage failure keeps that
/// classification (BUSY/LOCKED stay retryable); only an unclassified read
/// failure is the invalid-marker `sync.local_corrupt`.
fn schema_marker_read_failure(error: rusqlite::Error) -> String {
    let failure = QueryReadFailure::from(error);
    if failure.code.is_some() {
        failure.to_string()
    } else {
        "sync.local_corrupt: persisted local schema marker is unreadable or invalid".to_owned()
    }
}

/// §7.1: reject an invalid configured client limit before any storage is
/// opened or written. Zero would wedge the push queue and an out-of-range
/// value would differ per target; the TS core enforces the same bounds.
fn validate_client_limits(limits: &crate::api::ClientLimits) -> Result<(), String> {
    if limits.outcome_retention_max_entries == Some(0) {
        return Err("sync.invalid_request: outcomeRetentionMaxEntries must be positive".to_owned());
    }
    if [
        limits.max_push_commits_per_request,
        limits.max_push_operations_per_request,
        limits.max_push_request_bytes,
    ]
    .into_iter()
    .flatten()
    .any(|value| value == 0 || value > u32::MAX as usize)
    {
        return Err(
            "sync.invalid_request: push limit must be an integer in 1..=4294967295".to_owned(),
        );
    }
    Ok(())
}

fn read_local_schema_version(conn: &Connection, requested: i32) -> Result<Option<i32>, String> {
    let corrupt =
        || "sync.local_corrupt: persisted local schema marker is unreadable or invalid".to_owned();
    let table_type: Option<String> = conn
        .query_row(
            "SELECT type FROM sqlite_master WHERE name = '_syncular_meta'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(schema_marker_read_failure)?;
    let Some(table_type) = table_type else {
        return Ok(None);
    };
    if table_type != "table" {
        return Err(corrupt());
    }
    // §7.4.2: a duplicated marker cannot be resolved. `query_row` would take
    // whichever row SQLite returns first, and an older one would drive a
    // destructive reset over a newer replica.
    let mut statement = conn
        .prepare("SELECT value FROM _syncular_meta WHERE key = ?1")
        .map_err(schema_marker_read_failure)?;
    let mut rows = statement
        .query([LOCAL_SCHEMA_VERSION_KEY])
        .map_err(schema_marker_read_failure)?;
    let value: Option<String> = rows
        .next()
        .map_err(schema_marker_read_failure)?
        .map(|row| row.get(0))
        .transpose()
        .map_err(schema_marker_read_failure)?;
    if rows.next().map_err(schema_marker_read_failure)?.is_some() {
        return Err(corrupt());
    }
    let Some(value) = value else {
        let has_descriptor = conn
            .query_row(
                "SELECT 1 FROM _syncular_meta WHERE key = ?1 LIMIT 1",
                [crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY],
                |_| Ok(()),
            )
            .optional()
            .map_err(schema_marker_read_failure)?
            .is_some();
        if has_descriptor {
            return Err(corrupt());
        }
        return Ok(None);
    };
    if !matches!(value.as_bytes().first(), Some(b'1'..=b'9'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(corrupt());
    }
    let version = value.parse::<i32>().map_err(|_| corrupt())?;
    if version > requested {
        return Err(
            "client.schema_downgrade: persisted local schema is newer than the requested schema"
                .to_owned(),
        );
    }
    Ok(Some(version))
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
        validate_client_limits(&limits)?;
        parse_schema_json(schema_json)?;
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    pub fn open_path_with_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
    ) -> Result<Self, String> {
        validate_client_limits(&limits)?;
        // §7.4.2: an invalid requested version is refused before the replica is
        // even created, so a rejected constructor leaves no file behind.
        parse_schema_json(schema_json)?;
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        // A file-backed native client uses an independent read connection for
        // latency-critical snapshots. WAL is SQLite's intended reader/writer
        // concurrency mode: a view read never holds a rollback-journal lock
        // that delays the client's next commit. The busy timeout must precede
        // this replica's own startup transaction; WAL is applied only after
        // startup succeeded, because a refused open must leave the replica's
        // journal mode and contents untouched (§7.4.2).
        conn.busy_timeout(std::time::Duration::from_millis(250))
            .map_err(|error| format!("configure db {path:?} busy timeout: {error}"))?;
        let client = Self::with_connection_identity(client_id, schema_json, limits, conn)?;
        let journal_mode: String = client
            .conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
        if journal_mode != "wal" {
            return Err(
                "sync.invalid_request: file-backed client requires WAL journal mode".to_owned(),
            );
        }
        Ok(client)
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
        Self::with_connection_identity(Some(client_id), schema_json, limits, conn)
    }

    /// [`Self::with_connection`] for `open_path_with_identity`: no requested id
    /// means a durable replica's persisted `clientId` wins over a fresh one.
    fn with_connection_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        conn: Connection,
    ) -> Result<Self, String> {
        validate_client_limits(&limits)?;
        let schema = parse_schema_json(schema_json)?;
        validate_authority_reads(&schema, &limits.authority_reads)?;
        // RFC 0005 D8: resolve the previous-version config before the opening
        // reset runs — the capture happens inside it. Bad bounds fail loud.
        let previous_version = match limits.previous_version_context {
            Some(config) => {
                config.validate()?;
                Some(config)
            }
            None => None,
        };
        let mut client = SyncClient {
            #[cfg(feature = "bench-internals")]
            benchmark_phases: Recorder::default(),
            conn,
            schema,
            client_id: client_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            limits,
            subs: Vec::new(),
            outbox: Vec::new(),
            failed_commits: Vec::new(),
            retain_failed_commits: false,
            conflicts: Vec::new(),
            rejections: Vec::new(),
            schema_floor: None,
            lease_state: None,
            stopped: false,
            upgrading: false,
            sync_needed: false,
            realtime_policy: RealtimePolicy::Optional,
            realtime_state: RealtimeState::Disconnected,
            realtime_reason_code: None,
            realtime_retry_delay_ms: None,
            presence: HashMap::new(),
            now_ms: None,
            encryption: crate::values::EncryptionConfig::default(),
            security_preflight: false,
            transport_enabled: true,
            previous_version,
            insert_sql: RefCell::new(HashMap::new()),
            overlay_dirty: OverlayDirty::clean(),
            storage_failure: RefCell::new(None),
            #[cfg(test)]
            overlay_rebuild_count: Cell::new(0),
            #[cfg(test)]
            acknowledged_replay_count: Cell::new(0),
            #[cfg(test)]
            outcome_prune_count: Cell::new(0),
            progress: ProgressObserver::default(),
            change_queue: VecDeque::new(),
            sync_intent_queue: VecDeque::new(),
            retry_delay_ms: 250,
            round_retry_delay_ms: None,
            active_round: None,
            last_round: None,
            last_change: None,
            query_failures: Vec::new(),
        };
        // The row write path leans on the prepared-statement cache (two
        // insert statements per synced table, plus the bookkeeping
        // statements); size it so a multi-table schema never thrashes.
        client
            .conn
            .set_prepared_statement_cache_capacity(64.max(client.schema.tables.len() * 4));
        // §7.4.2: one write transaction (SQLite `BEGIN IMMEDIATE`, a reserved
        // writer) covers the marker read, the identity check, and every
        // bookkeeping/schema write, so a concurrent open that upgraded the
        // replica cannot interleave between the guard and the writes, and a
        // refusal leaves the replica unchanged.
        client
            .conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
        let startup = (|| -> Result<(), String> {
            // The marker guard runs inside the write transaction, so the version
            // it validates is the version every write below commits under.
            let marker = read_local_schema_version(&client.conn, client.schema.version)?;
            // New app indexes may reference columns that only exist after a
            // version-bump reset.
            client.create_bookkeeping_tables()?;
            match client.get_meta(CLIENT_ID_KEY) {
                Some(existing) => match client_id {
                    Some(requested) if existing != requested => {
                        return Err(format!(
                            "client.identity_mismatch: this database belongs to {existing:?}; refusing to rebind it to {requested:?}"
                        ))
                    }
                    _ => client.client_id = existing,
                },
                None => client.set_meta(CLIENT_ID_KEY, &client.client_id),
            }
            client.restore_persisted_state()?;
            client.failed_commits = client.load_failed_commits()?;
            match marker {
                None => {
                    client.create_synced_tables()?;
                    client.persist_schema_version()?;
                    client.save_subscription_scope_schema();
                }
                Some(version) if version == client.schema.version => {
                    client.create_synced_tables()?;
                    // RFC 0005 D1: the same-version open backfills the descriptor
                    // for a database first opened by an unaware binary, so the
                    // NEXT bump can capture without needing a schema bump first.
                    set_local_schema_descriptor(&client.conn, &client.schema)
                        .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
                    client.save_subscription_scope_schema();
                }
                Some(_) => client.run_schema_reset()?,
            }
            // RFC 0005 D9: the reset sweep cannot see a container whose capture
            // committed in its OWN file while the replica's savepoint never
            // released — a crash at that seam leaves a container beside a matching
            // OLD marker, and the next open at that version runs no reset. Discard
            // it before anything can read it. No-op when no container exists.
            client.reconcile_previous_version_at_boot()?;
            client.clear_satisfied_persisted_schema_floor();
            client.prune_unknown_subscriptions(false)?;
            if marker == Some(client.schema.version)
                && (!client.outbox.is_empty()
                    || !client.failed_commits.is_empty()
                    || client.has_acknowledged_rows())
            {
                // Reconstruct the visible optimistic overlay from the durable
                // base plus outbox instead of trusting a process-interrupted
                // mirror.
                client.overlay_dirty.set(true);
                client.rebuild_overlay()?;
            }
            // Every persisted active subscription needs one catch-up pull on
            // open: realtime only covers changes after connection, while an
            // idempotent setWindow correctly creates no fresh command effect.
            // Pending outbox work has the same restart requirement. The core
            // owns this intent so native hosts never poll or require an
            // application-issued sync().
            client.enqueue_startup_sync_if_needed()?;
            Ok(())
        })();
        match startup {
            Ok(()) => match client.conn.execute_batch("COMMIT") {
                Ok(()) => Ok(client),
                Err(error) => {
                    let failure = Self::sqlite_failure(&client.storage_failure, error);
                    if let Err(rollback) = client.conn.execute_batch("ROLLBACK") {
                        // Keep a failed rollback's typed storage classification.
                        let _ = Self::sqlite_failure(&client.storage_failure, rollback);
                    }
                    Err(failure)
                }
            },
            Err(error) => {
                if let Err(rollback) = client.conn.execute_batch("ROLLBACK") {
                    // Keep a failed rollback's typed storage classification.
                    let _ = Self::sqlite_failure(&client.storage_failure, rollback);
                }
                Err(error)
            }
        }
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

    #[must_use]
    pub fn security_lifecycle(&self) -> &'static str {
        if self.security_preflight {
            "preflight"
        } else {
            "active"
        }
    }

    #[must_use]
    pub fn security_preflight(&self) -> bool {
        self.security_preflight
    }

    /// Host-owned, non-persisted network gate. Local operations remain available.
    pub fn set_transport_enabled(&mut self, transport: &mut dyn Transport, enabled: bool) {
        if self.transport_enabled != enabled {
            self.transport_enabled = enabled;
            self.sync_intent_queue.clear();
            self.sync_intent_queue
                .push_back(if enabled && !self.security_preflight {
                    SyncIntent::Interactive
                } else {
                    SyncIntent::None
                });
        }
        // A captured reply keeps its normal apply/revocation semantics.
        if !enabled && self.active_round.is_none() {
            self.disconnect_realtime(transport);
        }
    }

    pub fn transport_enabled(&self) -> bool {
        self.transport_enabled
    }

    /// Quarantine this replica: enter the fail-closed gate, release all
    /// core-owned key material, and record the gate in the database so
    /// reopening re-enters preflight until `activate_security` clears it.
    ///
    /// Use [`SyncClient::seal_security_on_teardown`] for the shutdown barrier,
    /// which must NOT leave that durable mark.
    pub fn begin_security_preflight(&mut self) {
        self.seal_security_on_teardown();
        // Persist the quarantine so it survives handle teardown and restart:
        // reopening this replica re-enters preflight until activation clears it.
        self.set_meta(SECURITY_PREFLIGHT_PENDING_KEY, "1");
    }

    /// Release core-owned key material as a host tears the client down,
    /// WITHOUT recording a quarantine.
    ///
    /// Shutting an activated client down is not a quarantine event. Persisting
    /// the gate here marks every cleanly closed replica as pending, and the
    /// next plain `create` is then refused permanently: the reopen path
    /// restores the flag from the marker and the create guard rejects it. The
    /// in-memory flag still closes the gate for anything still holding this
    /// instance, which is all a teardown barrier needs.
    pub fn seal_security_on_teardown(&mut self) {
        self.cancel_sync_round();
        self.security_preflight = true;
        self.encryption = crate::values::EncryptionConfig::default();
        self.sync_intent_queue.clear();
    }

    /// Install the post-authentication keyring and release the host loop.
    pub fn activate_security(
        &mut self,
        encryption: crate::values::EncryptionConfig,
    ) -> Result<(), String> {
        if !self.security_preflight {
            return Err(
                "sync.invalid_request: activateSecurity requires security preflight".to_owned(),
            );
        }
        self.enqueue_startup_sync_if_needed()?;
        self.encryption = encryption;
        self.security_preflight = false;
        self.delete_meta(SECURITY_PREFLIGHT_PENDING_KEY);
        Ok(())
    }

    fn clock_now_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        })
    }

    fn create_bookkeeping_tables(&self) -> Result<(), String> {
        // Durable client bookkeeping (outbox + subscription + meta).
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS _syncular_outbox (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_row_deliveries (
                   tbl TEXT NOT NULL, id TEXT NOT NULL, commit_seq INTEGER NOT NULL, PRIMARY KEY(tbl,id));
                 CREATE TABLE IF NOT EXISTS _syncular_acked_rows (
                   commit_id TEXT NOT NULL, idx INTEGER NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL,
                   commit_seq INTEGER NOT NULL, op_json TEXT NOT NULL, intent_json TEXT,
                   PRIMARY KEY(commit_id, idx));
                 CREATE TABLE IF NOT EXISTS _syncular_failed_commits (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT, client_commit_id TEXT NOT NULL UNIQUE,
                   operations_json TEXT NOT NULL, initial_json TEXT NOT NULL);
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
                   effective_scopes TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_blob_commit_refs(
                   commit_id TEXT NOT NULL, blob_id TEXT NOT NULL,
                   PRIMARY KEY(commit_id, blob_id));
                 CREATE INDEX IF NOT EXISTS _syncular_blob_commit_refs_body
                   ON _syncular_blob_commit_refs(blob_id);",
            )
            .map_err(|e| e.to_string())?;
        // Migrate an outcome journal created before failed aggregate
        // envelopes were retained. Historical rows intentionally stay NULL.
        let _ = self
            .conn
            .execute_batch("ALTER TABLE _syncular_commit_outcomes ADD COLUMN operations_json TEXT");
        if self.get_meta(LOCAL_REVISION_KEY).is_none() {
            self.set_meta(LOCAL_REVISION_KEY, "0");
        }
        // §5.9.7 blob cache. Mutable upload state stays off the body row so
        // completing a large upload does not rewrite its BLOB record.
        if self.schema_has_blobs() {
            let exists = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_syncular_blobs')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?;
            if exists {
                let mut statement = self
                    .conn
                    .prepare("PRAGMA table_info(_syncular_blobs)")
                    .map_err(|e| e.to_string())?;
                let mut columns = statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                columns.sort();
                let mut expected = vec![
                    "blob_id",
                    "byte_length",
                    "bytes",
                    "created_at_ms",
                    "media_type",
                ];
                expected.sort_unstable();
                if columns != expected {
                    return Err(
                        "sync.schema_mismatch: Local blob schema is incompatible".to_owned()
                    );
                }
            } else {
                self.conn
                    .execute_batch(
                        "CREATE TABLE _syncular_blobs(
                           blob_id TEXT PRIMARY KEY,
                           bytes BLOB NOT NULL,
                           byte_length INTEGER NOT NULL,
                           media_type TEXT,
                           created_at_ms INTEGER NOT NULL);",
                    )
                    .map_err(|e| e.to_string())?;
            }
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS _syncular_blob_uploads(
                       blob_id TEXT PRIMARY KEY,
                       media_type TEXT,
                       created_at_ms INTEGER NOT NULL);",
                )
                .map_err(|e| e.to_string())?;
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
        meta_get(&self.conn, key)
    }

    fn get_meta_strict(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| {
                "sync.local_corrupt: persisted local rebootstrap receipt is unreadable".to_owned()
            })
    }

    // The caller holds the startup/reset transaction. Either both schema
    // records persist or the enclosing operation fails and rolls back.
    fn persist_schema_version(&self) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                rusqlite::params![LOCAL_SCHEMA_VERSION_KEY, self.schema.version.to_string()],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        set_local_schema_descriptor(&self.conn, &self.schema)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn set_meta(&self, key: &str, value: &str) {
        meta_set(&self.conn, key, value);
    }

    fn delete_meta(&self, key: &str) {
        meta_delete(&self.conn, key);
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
                        // A legacy entry's `changedFields` key is ignored:
                        // the values map is the presence set (§6.1).
                        values: entry.get("values").and_then(Value::as_object).cloned(),
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
        // A replica left in unactivated preflight reopens gated: the quarantine
        // decision persists with the data across handle teardown and restart.
        if self.get_meta(SECURITY_PREFLIGHT_PENDING_KEY).as_deref() == Some("1") {
            self.security_preflight = true;
        }
        Ok(())
    }

    fn save_subscription_scope_schema(&self) {
        let declarations: BTreeMap<_, BTreeMap<_, _>> = self
            .schema
            .tables
            .iter()
            .map(|table| {
                (
                    table.name.clone(),
                    table
                        .scope_variables
                        .iter()
                        .map(|scope| {
                            (
                                scope.variable.clone(),
                                [scope.prefix.clone(), scope.column.clone()],
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        self.set_meta(
            "subscriptionScopeSchema",
            &serde_json::to_string(&declarations).expect("scope schema serialization"),
        );
    }

    /// Remove registrations with incompatible table/key/prefix/column meaning.
    fn prune_unknown_subscriptions(&mut self, bump: bool) -> Result<(), String> {
        let previous: Option<BTreeMap<String, BTreeMap<String, [String; 2]>>> = if bump {
            self.get_meta("subscriptionScopeSchema")
                .map(|raw| serde_json::from_str(&raw))
                .transpose()
                .map_err(|error| format!("invalid persisted scope schema: {error}"))?
        } else {
            None
        };
        let compatible = |table_name: &str, requested: &[(String, Vec<String>)]| {
            let Some(table) = self.schema.table(table_name) else {
                return false;
            };
            if requested
                .iter()
                .any(|(variable, _)| table.scope_column(variable).is_none())
            {
                return false;
            }
            if !bump {
                return true;
            }
            let Some(old) = previous.as_ref().and_then(|tables| tables.get(table_name)) else {
                return false;
            };
            let variables: BTreeSet<_> = if requested.is_empty() {
                old.keys()
                    .cloned()
                    .chain(
                        table
                            .scope_variables
                            .iter()
                            .map(|scope| scope.variable.clone()),
                    )
                    .collect()
            } else {
                requested
                    .iter()
                    .map(|(variable, _)| variable.clone())
                    .collect()
            };
            variables.iter().all(|variable| {
                let current = table
                    .scope_variables
                    .iter()
                    .find(|scope| &scope.variable == variable);
                match (old.get(variable), current) {
                    (Some(old), Some(current)) => {
                        old == &[current.prefix.clone(), current.column.clone()]
                    }
                    _ => false,
                }
            })
        };
        let mut stale_ids: BTreeSet<_> = self
            .subs
            .iter()
            .filter(|sub| !compatible(&sub.table, &sub.requested))
            .map(|sub| sub.id.clone())
            .collect();
        for (id, table, effective) in self.load_pending_evictions()? {
            if !compatible(&table, &effective) {
                stale_ids.insert(id);
            }
        }
        for id in &stale_ids {
            for sql in [
                "DELETE FROM _syncular_windows WHERE sub_id = ?1",
                "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
                "DELETE FROM _syncular_subscriptions WHERE id = ?1",
            ] {
                self.conn
                    .execute(sql, rusqlite::params![id])
                    .map_err(|error| error.to_string())?;
            }
        }
        self.subs.retain(|sub| !stale_ids.contains(&sub.id));
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
            current_schema_version: self.schema.version,
            outbox: self.outbox.len(),
            upgrading: self.upgrading,
            lease_state: self.lease_state.clone(),
            schema_floor: self.schema_floor.clone(),
            sync_needed: self.sync_needed,
            previous_version_context: self.previous_version_status(),
        }
    }

    /// RFC 0005 A2: container presence for a host that must act on it (Diego's
    /// rollback precondition), read without creating the file.
    fn previous_version_status(&self) -> PreviousVersionStatus {
        let Some(replica_path) = self.previous_version_replica_path() else {
            return PreviousVersionStatus {
                present: false,
                created_at_ms: None,
            };
        };
        match crate::previous_version::read_previous_version_record(&replica_path) {
            Ok(Some(record)) => PreviousVersionStatus {
                present: true,
                created_at_ms: Some(record.created_at_ms),
            },
            _ => PreviousVersionStatus {
                present: std::path::Path::new(
                    &crate::previous_version::previous_version_container_path(&replica_path),
                )
                .exists(),
                created_at_ms: None,
            },
        }
    }

    /// RFC 0005 D7: read captured rows from the previous local schema. `state`
    /// is always `previousVersion`; the container never makes
    /// `query_snapshot()` coverage complete. Lease stop/expiry, scope
    /// revocation, coverage completion and the TTL DISCARD the container and
    /// close the read with their own reason.
    pub fn previous_version_snapshot(
        &self,
        spec: &PreviousVersionReadSpec,
    ) -> Result<PreviousVersionSnapshot, String> {
        let now_ms = self.clock_now_ms();
        crate::previous_version::previous_version_snapshot(
            &self.conn,
            self.previous_version_replica_path().as_deref(),
            self.previous_version.as_ref(),
            PreviousVersionLifecycle {
                lease_inactive: self.previous_version_lease_inactive(now_ms),
                scope_revoked: self.subs.iter().any(|sub| sub.state == SubState::Revoked),
                coverage_complete: self.previous_version_coverage_complete(),
            },
            now_ms,
            self.schema.version,
            spec,
        )
    }

    /// RFC 0005 D6: the advisory pre-reset compatibility audit.
    #[must_use]
    pub fn previous_version_audit(&self) -> Option<crate::previous_version::PreviousVersionAudit> {
        crate::previous_version::stored_previous_version_audit(&self.conn)
    }

    /// RFC 0005 A2/D9: the executable downgrade step. Drop the container file
    /// and both metadata records, and report whether anything was present.
    /// Idempotent: absence is a successful no-op.
    pub fn previous_version_discard(
        &self,
    ) -> crate::previous_version::PreviousVersionDiscardOutcome {
        self.drop_previous_version()
    }

    /// The module's discard has no failure path (it removes the file even when
    /// the container cannot be opened), so the only error a caller could ever
    /// see is a bug; report absence rather than claiming a discard happened.
    fn drop_previous_version(&self) -> crate::previous_version::PreviousVersionDiscardOutcome {
        let absent = crate::previous_version::PreviousVersionDiscardOutcome {
            present: false,
            discarded: false,
        };
        let Some(replica_path) = self.previous_version_replica_path() else {
            return absent;
        };
        crate::previous_version::discard_previous_version(&self.conn, &replica_path)
            .unwrap_or(absent)
    }

    /// RFC 0005 D7: `leaseState.errorCode` or an expired lease.
    fn previous_version_lease_inactive(&self, now_ms: i64) -> bool {
        let Some(lease) = &self.lease_state else {
            return false;
        };
        if lease.error_code.is_some() {
            return true;
        }
        lease.expires_at_ms.is_some_and(|expires| expires <= now_ms)
    }

    /// RFC 0005 D7: §7.4.5 replacement coverage — every ACTIVE subscription
    /// has `cursor >= 0` and no resume token. An empty active set is not
    /// completion (mirrors the TS predicate exactly).
    fn previous_version_coverage_complete(&self) -> bool {
        let active = self
            .subs
            .iter()
            .filter(|sub| sub.state == SubState::Active)
            .collect::<Vec<_>>();
        if active.is_empty() {
            return false;
        }
        active
            .iter()
            .all(|sub| sub.cursor >= 0 && sub.bootstrap_state.is_none())
    }

    /// RFC 0005 D7: lifetime triggers evaluated once per sync round, after the
    /// apply. A container that no longer has a reason to exist is discarded so
    /// the rows do not outlive the window they were kept for.
    fn previous_version_lifetime_check(&self) {
        let Some(config) = self.previous_version.filter(|config| config.enabled) else {
            return;
        };
        let now_ms = self.clock_now_ms();
        if self.previous_version_lease_inactive(now_ms) {
            let _ = self.drop_previous_version();
            return;
        }
        let Some(replica_path) = self.previous_version_replica_path() else {
            return;
        };
        let Ok(Some(record)) = crate::previous_version::read_previous_version_record(&replica_path)
        else {
            return;
        };
        if self.subs.iter().any(|sub| sub.state == SubState::Revoked) {
            let _ = self.drop_previous_version();
            return;
        }
        if now_ms - record.created_at_ms > config.max_age_ms {
            let _ = self.drop_previous_version();
            return;
        }
        if self.previous_version_coverage_complete() {
            let _ = self.drop_previous_version();
        }
    }

    pub fn diagnostics_snapshot(
        &self,
        request: &ClientDiagnosticsRequest,
    ) -> Result<ClientDiagnosticsSnapshot, String> {
        if request.expected_subscriptions.len() > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS {
            return Err(format!(
                "sync.invalid_request: diagnosticsSnapshot accepts at most {MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS} expected subscriptions"
            ));
        }
        let mut subscriptions = BTreeMap::<String, DiagnosticSubscription>::new();
        for sub in &self.subs {
            let reset = sub.cursor < 0 && sub.reason_code.as_deref() == Some("sync.cursor_expired");
            let complete =
                sub.state == SubState::Active && sub.cursor >= 0 && sub.bootstrap_state.is_none();
            let state = match sub.state {
                SubState::Revoked => "revoked",
                SubState::Failed => "failed",
                SubState::Active if reset => "reset",
                SubState::Active if complete => "complete",
                SubState::Active => "bootstrapping",
            };
            subscriptions.insert(
                sub.id.clone(),
                DiagnosticSubscription {
                    id: sub.id.clone(),
                    table: sub.table.clone(),
                    state: state.to_owned(),
                    complete,
                    cursor: Some(sub.cursor),
                    reason_code: sub.reason_code.as_deref().map(Self::diagnostic_code),
                },
            );
        }
        for expected in &request.expected_subscriptions {
            if expected.id.is_empty() || expected.table.is_empty() {
                return Err("sync.invalid_request: diagnosticsSnapshot expected subscriptions require non-empty id and table strings".to_owned());
            }
            if subscriptions
                .get(&expected.id)
                .is_some_and(|registered| registered.table != expected.table)
            {
                subscriptions.insert(
                    expected.id.clone(),
                    DiagnosticSubscription {
                        id: expected.id.clone(),
                        table: expected.table.clone(),
                        state: "failed".to_owned(),
                        complete: false,
                        cursor: None,
                        reason_code: Some("client.subscription_intent_mismatch".to_owned()),
                    },
                );
            } else {
                subscriptions.entry(expected.id.clone()).or_insert_with(|| {
                    DiagnosticSubscription {
                        id: expected.id.clone(),
                        table: expected.table.clone(),
                        state: "unregistered".to_owned(),
                        complete: false,
                        cursor: None,
                        reason_code: None,
                    }
                });
            }
        }
        let mut ordered_subscriptions = Vec::new();
        let mut included = BTreeSet::new();
        for expected in &request.expected_subscriptions {
            if included.insert(expected.id.clone()) {
                if let Some(subscription) = subscriptions.get(&expected.id) {
                    ordered_subscriptions.push(subscription.clone());
                }
            }
        }
        for (id, subscription) in &subscriptions {
            if included.insert(id.clone()) {
                ordered_subscriptions.push(subscription.clone());
            }
        }
        let subscriptions_truncated =
            ordered_subscriptions.len() > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS;
        ordered_subscriptions.truncate(MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS);
        let captured_at_ms = self.clock_now_ms();
        let lease = if let Some(error_code) = self
            .lease_state
            .as_ref()
            .and_then(|state| state.error_code.clone())
        {
            ClientDiagnosticsLease {
                state: "stopped".to_owned(),
                expires_at_ms: self
                    .lease_state
                    .as_ref()
                    .and_then(|state| state.expires_at_ms),
                error_code: Some(Self::diagnostic_code(&error_code)),
            }
        } else if let Some(expires_at_ms) = self
            .lease_state
            .as_ref()
            .and_then(|state| state.expires_at_ms)
        {
            ClientDiagnosticsLease {
                state: if expires_at_ms <= captured_at_ms {
                    "expired".to_owned()
                } else {
                    "active".to_owned()
                },
                expires_at_ms: Some(expires_at_ms),
                error_code: None,
            }
        } else {
            ClientDiagnosticsLease {
                state: "none".to_owned(),
                expires_at_ms: None,
                error_code: None,
            }
        };
        let connectivity = match self.last_round.as_ref() {
            _ if !self.transport_enabled && self.active_round.is_none() => "offline",
            Some(round) if round.status == "succeeded" => "online",
            Some(round)
                if round.status == "failed"
                    && round
                        .error_code
                        .as_deref()
                        .is_some_and(Self::retryable_transport_code) =>
            {
                "offline"
            }
            _ => "unknown",
        };
        Ok(ClientDiagnosticsSnapshot {
            version: CLIENT_DIAGNOSTICS_VERSION,
            captured_at_ms,
            host: ClientDiagnosticsHost {
                kind: "direct".to_owned(),
                role: "single".to_owned(),
                connectivity: connectivity.to_owned(),
                realtime: self.realtime_state,
                realtime_policy: self.realtime_policy,
                realtime_reason_code: self.realtime_reason_code.clone(),
                realtime_retry_delay_ms: self.realtime_retry_delay_ms,
            },
            security_lifecycle: self.security_lifecycle().to_owned(),
            schema: ClientDiagnosticsSchema {
                current_version: self.schema.version,
                upgrading: self.upgrading,
                required_version: self
                    .schema_floor
                    .as_ref()
                    .and_then(|floor| floor.required_schema_version),
                latest_version: self
                    .schema_floor
                    .as_ref()
                    .and_then(|floor| floor.latest_schema_version),
            },
            replica: ClientDiagnosticsReplica {
                local_revision: self.local_revision().to_string(),
                sync_needed: self.sync_needed,
                pending_outbox: self.outbox.len(),
            },
            lease,
            subscriptions: ordered_subscriptions,
            subscriptions_truncated,
            last_round: self.last_round.clone(),
            last_change: self.last_change.clone(),
            storage: self.diagnostics_storage(),
            query_failures: self.query_failures.clone(),
        })
    }

    fn diagnostics_storage(&self) -> ClientDiagnosticsStorage {
        let read = || -> Result<ClientDiagnosticsStorage, rusqlite::Error> {
            let page_count: i64 = self
                .conn
                .query_row("PRAGMA page_count", [], |row| row.get(0))?;
            let page_size: i64 = self
                .conn
                .query_row("PRAGMA page_size", [], |row| row.get(0))?;
            // Reuse compiled aggregates; every invocation still reads current storage.
            let outbox_bytes: i64 = self
                .conn
                .prepare_cached("SELECT COALESCE(SUM(LENGTH(ops_json)), 0) FROM _syncular_outbox")?
                .query_row([], |row| row.get(0))?;
            let (outcome_entries, outcome_bytes): (i64, i64) = self.conn.prepare_cached(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(results_json) + COALESCE(LENGTH(operations_json), 0)), 0) FROM _syncular_commit_outcomes",
            )?.query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let blob_bytes = if self.schema_has_blobs() {
                self.conn
                    .prepare_cached("SELECT COALESCE(SUM(byte_length), 0) FROM _syncular_blobs")?
                    .query_row([], |row| row.get(0))?
            } else {
                0
            };
            let pressure = self
                .limits
                .blob_cache_max_bytes
                .is_some_and(|limit| blob_bytes > limit);
            Ok(ClientDiagnosticsStorage {
                status: if pressure { "pressure" } else { "healthy" }.to_owned(),
                database_bytes_approx: Some(page_count.saturating_mul(page_size).max(0)),
                pending_outbox_bytes_approx: Some(outbox_bytes.max(0)),
                retained_outcome_bytes_approx: Some(outcome_bytes.max(0)),
                retained_outcome_entries: Some(outcome_entries.max(0)),
                blob_cache_bytes_approx: Some(blob_bytes.max(0)),
                pressure_reason_code: pressure.then(|| "client.blob_cache_over_limit".to_owned()),
            })
        };
        read().unwrap_or_else(|_| ClientDiagnosticsStorage {
            status: "unreadable".to_owned(),
            database_bytes_approx: None,
            pending_outbox_bytes_approx: None,
            retained_outcome_bytes_approx: None,
            retained_outcome_entries: None,
            blob_cache_bytes_approx: None,
            pressure_reason_code: None,
        })
    }

    pub fn drain_change_batches(&mut self) -> Vec<ClientChangeBatch> {
        self.change_queue.drain(..).collect()
    }

    pub fn drain_sync_intents(&mut self) -> Vec<SyncIntent> {
        let intents = self.sync_intent_queue.drain(..).collect();
        if self.transport_enabled {
            intents
        } else {
            vec![SyncIntent::None]
        }
    }

    fn schedule_background_retry(&mut self) -> u64 {
        let delay_ms = self.retry_delay_ms;
        self.sync_intent_queue
            .push_back(SyncIntent::Background { delay_ms });
        self.retry_delay_ms = (self.retry_delay_ms * 2).min(30_000);
        self.round_retry_delay_ms = Some(delay_ms);
        delay_ms
    }

    fn reset_background_retry(&mut self) {
        self.retry_delay_ms = 250;
    }

    fn retryable_transport_code(code: &str) -> bool {
        code == "transport.failed"
            || code == "transport.unavailable"
            || code == "sync.transport_failed"
    }

    /// A failed round worth a background retry: a transport failure, or a
    /// §10.2 code the catalog marks retryable (clients may hardcode the
    /// catalog metadata, §10.1). Matches the TypeScript core, which retries
    /// on the server's `retryable` flag.
    fn retryable_failure_code(code: &str) -> bool {
        Self::retryable_transport_code(code)
            || matches!(
                code,
                "sync.auth_required"
                    | "sync.auth_lease_required"
                    | "sync.auth_lease_revoked"
                    | "sync.internal_error"
                    | "sync.idempotency_cache_miss"
                    | "sync.schema_not_ready"
                    | "sync.segment_expired"
                    | "sync.rate_limited"
                    | "sync.websocket_connection_limit"
            )
    }

    fn diagnostic_code(code: &str) -> String {
        let valid = !code.is_empty()
            && code.len() <= 96
            && code.contains('.')
            && code
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase())
            && code.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        if valid {
            code.to_owned()
        } else {
            "client.unknown_failure".to_owned()
        }
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

    fn sqlite_failure(
        storage_failure: &RefCell<Option<QueryReadFailure>>,
        error: rusqlite::Error,
    ) -> String {
        let message = error.to_string();
        let failure = QueryReadFailure::from(error);
        let code = failure.code;
        if code.is_some() && storage_failure.borrow().is_none() {
            *storage_failure.borrow_mut() = Some(failure);
        }
        match code {
            Some(code) => format!("{code}: {message}"),
            None => message,
        }
    }

    fn begin_observation(&self, name: &str) -> Result<(), String> {
        self.conn
            .execute_batch(&format!("SAVEPOINT {name}"))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn rollback_observation(&self, name: &str) {
        if let Err(error) = self
            .conn
            .execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
        {
            if let Some(failure) = self.storage_failure.borrow_mut().as_mut() {
                if failure.rollback_failure.is_none() {
                    failure.rollback_failure = Some(Box::new(QueryReadFailure::from(error)));
                }
            }
        }
    }

    fn finish_observation(
        &mut self,
        name: &str,
        mut batch: ChangeAccumulator,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ObservationCommit);
        if self.failed_commits.iter().any(|(commit, _)| {
            commit
                .ops
                .iter()
                .any(|operation| batch.tables.contains_key(&operation.table))
        }) {
            batch.outcomes = true;
        }
        if !batch.touched() {
            self.conn
                .execute_batch(&format!("RELEASE {name}"))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut diagnostic_tables = event
            .tables
            .iter()
            .map(|entry| entry.table.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut diagnostic_windows = event
            .windows
            .iter()
            .map(|entry| entry.table.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let domains_truncated = diagnostic_tables.len() > MAX_DIAGNOSTIC_DOMAINS
            || diagnostic_windows.len() > MAX_DIAGNOSTIC_DOMAINS;
        diagnostic_tables.truncate(MAX_DIAGNOSTIC_DOMAINS);
        diagnostic_windows.truncate(MAX_DIAGNOSTIC_DOMAINS);
        self.last_change = Some(DiagnosticLastChange {
            revision: event.revision.clone(),
            recorded_at_ms: self.clock_now_ms(),
            tables: diagnostic_tables,
            windows: diagnostic_windows,
            domains_truncated,
            status_changed: event.status.is_some(),
            conflicts_changed: event.conflicts_changed,
            rejections_changed: event.rejections_changed,
            outcomes_changed: event.outcomes_changed,
        });
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
            "SELECT {columns} FROM {full_table} WHERE {} LIMIT 1",
            row_id_predicate(table)
        );
        let Ok(mut stmt) = self.conn.prepare_cached(&sql) else {
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
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ObservationPrepare);
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
    /// version increases. Recreation runs the same marker guard as opening
    /// a durable replica, holds the guard and every write it authorizes under
    /// one write transaction, and preserves the current client (compiled
    /// schema, outbox, tables) on refusal.
    pub fn recreate_with_schema(&mut self, schema_json: &Value) -> Result<(), String> {
        let new_schema = parse_schema_json(schema_json)?;
        validate_authority_reads(&new_schema, &self.limits.authority_reads)?;
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let prior_schema = std::mem::replace(&mut self.schema, new_schema);
        // §7.4.3/§7.4.4: a reset inside this transaction mutates in-memory
        // state (dropped outbox commits, rejections, upgrade and floor flags,
        // overlay dirtiness) and appends change/intent batches. A COMMIT that
        // fails after the reset succeeded rolls the database back, so every
        // one of those fields is captured here and restored with it.
        let prior_subs = self.subs.clone();
        let prior_outbox = self.outbox.clone();
        let prior_rejections = self.rejections.clone();
        let prior_upgrading = self.upgrading;
        let prior_stopped = self.stopped;
        let prior_schema_floor = self.schema_floor.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        let prior_sync_needed = self.sync_needed;
        let prior_active_round = self.active_round;
        let prior_changes = self.change_queue.len();
        let prior_intents = self.sync_intent_queue.len();
        let prior_last_change = self.last_change.clone();
        let guarded = (|| -> Result<(), String> {
            // §7.4.2: the marker is re-read under the write lock the caller
            // holds, so a replica another process upgraded meanwhile refuses
            // this recreation instead of having its marker and tables
            // downgraded.
            let marker = read_local_schema_version(&self.conn, self.schema.version)?;
            self.create_bookkeeping_tables()?;
            match marker {
                Some(version) if version < self.schema.version => self.run_schema_reset()?,
                None => {
                    self.create_synced_tables()?;
                    self.persist_schema_version()?;
                }
                _ => {}
            }
            if marker == Some(self.schema.version)
                && (!self.outbox.is_empty()
                    || !self.failed_commits.is_empty()
                    || self.has_acknowledged_rows())
            {
                self.overlay_dirty.set(true);
                self.rebuild_overlay()?;
            }
            self.prune_unknown_subscriptions(false)?;
            self.save_subscription_scope_schema();
            // The conformance recreate is the in-memory equivalent of reopening
            // a durable client. Apply the same startup catch-up contract even
            // when the schema itself did not change.
            self.enqueue_startup_sync_if_needed()?;
            Ok(())
        })();
        let outcome = match guarded {
            Ok(()) => self
                .conn
                .execute_batch("COMMIT")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error)),
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                // Keep a failed rollback's typed storage classification.
                let _ = Self::sqlite_failure(&self.storage_failure, rollback);
            }
            self.schema = prior_schema;
            self.subs = prior_subs;
            self.outbox = prior_outbox;
            self.rejections = prior_rejections;
            self.upgrading = prior_upgrading;
            self.stopped = prior_stopped;
            self.schema_floor = prior_schema_floor;
            self.overlay_dirty.restore(prior_overlay_dirty);
            self.sync_needed = prior_sync_needed;
            self.active_round = prior_active_round;
            self.change_queue.truncate(prior_changes);
            self.sync_intent_queue.truncate(prior_intents);
            self.last_change = prior_last_change;
            // Prepared insert statements were derived from the reverted schema.
            self.insert_sql.borrow_mut().clear();
            return Err(error);
        }
        Ok(())
    }

    fn enqueue_startup_sync_if_needed(&mut self) -> Result<(), String> {
        let startup_work = !self.stopped
            && (!self.outbox.is_empty()
                || self.has_acknowledged_rows()
                || !self.load_pending_evictions()?.is_empty()
                || self.subs.iter().any(|sub| sub.state == SubState::Active));
        if startup_work {
            self.sync_needed = true;
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
        Ok(())
    }

    /// A native client persists schema-floor stops across process restarts.
    /// Once the running app already satisfies that floor, the persisted stop
    /// is only stale evidence from an older server round (for example, the
    /// server was restarted after catching up to an app that was ahead).
    /// Clear it and let the normal startup pull re-negotiate. If the server is
    /// still incompatible it will return the floor again in that first round.
    fn clear_satisfied_persisted_schema_floor(&mut self) {
        let satisfied = self
            .schema_floor
            .as_ref()
            .and_then(|floor| floor.required_schema_version)
            .is_some_and(|required| self.schema.version >= required);
        if !satisfied {
            return;
        }
        self.schema_floor = None;
        self.stopped = false;
        self.delete_meta(SCHEMA_FLOOR_KEY);
    }

    /// RFC 0005 D1: discard an orphan or stale container at boot. The reset
    /// path already swept it; this covers a same-version or fresh-install open,
    /// which runs no reset and therefore no sweep — plus the D7 TTL, which only
    /// an aware binary can apply.
    fn reconcile_previous_version_at_boot(&self) -> Result<(), String> {
        let Some(replica_path) = self.previous_version_replica_path() else {
            return Ok(());
        };
        let max_age_ms = self
            .previous_version
            .filter(|config| config.enabled)
            .map(|config| config.max_age_ms);
        reconcile_previous_version_at_boot(
            &self.conn,
            &replica_path,
            self.schema.version,
            max_age_ms,
            self.clock_now_ms(),
        )
    }

    /// RFC 0005 D3: the sibling container path, or `None` when the replica has
    /// no file — an in-memory replica returns an empty path, and a `file:` URI
    /// has no plain sibling path — so the feature resolves as off there.
    fn previous_version_replica_path(&self) -> Option<String> {
        let path = self.conn.path()?;
        if path.is_empty() || path.starts_with("file:") {
            return None;
        }
        Some(path.to_owned())
    }

    /// §7.4.3 reset: whole-database local reset EXCEPT the outbox, clientId,
    /// and leaseState. Drops/recreates every synced table from the new
    /// schema, resets subscription sync-state (keeping registrations), clears
    /// the schema-floor stop state, rewrites the marker, drops outbox commits
    /// that cannot re-encode (§7.4.4), and replays the survivors on top.
    fn run_schema_reset(&mut self) -> Result<(), String> {
        self.begin_observation("syncular_schema_reset")?;
        let prior_subs = self.subs.clone();
        let prior_outbox = self.outbox.clone();
        let prior_rejections = self.rejections.clone();
        let prior_upgrading = self.upgrading;
        let prior_stopped = self.stopped;
        let prior_schema_floor = self.schema_floor.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        let prior_sync_needed = self.sync_needed;
        let prior_active_round = self.active_round;
        let mut batch = ChangeAccumulator::default();
        let result = self
            .run_schema_reset_observed(&mut batch, true)
            .and_then(|()| self.finish_observation("syncular_schema_reset", batch));
        if let Err(error) = result {
            self.rollback_observation("syncular_schema_reset");
            self.subs = prior_subs;
            self.outbox = prior_outbox;
            self.rejections = prior_rejections;
            self.upgrading = prior_upgrading;
            self.stopped = prior_stopped;
            self.schema_floor = prior_schema_floor;
            self.overlay_dirty.restore(prior_overlay_dirty);
            self.sync_needed = prior_sync_needed;
            self.active_round = prior_active_round;
            return Err(error);
        }
        Ok(())
    }

    fn run_log_epoch_reset(&mut self, log_epoch: &str) -> Result<Vec<String>, String> {
        if self.get_meta(LOG_EPOCH_KEY).is_none() {
            self.begin_observation("syncular_epoch_acquisition")?;
            let previous_sync_needed = self.sync_needed;
            if let Err(error) = self.conn.execute(
                "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                rusqlite::params![LOG_EPOCH_KEY, log_epoch],
            ) {
                self.rollback_observation("syncular_epoch_acquisition");
                return Err(Self::sqlite_failure(&self.storage_failure, error));
            }
            self.sync_needed = true;
            let batch = ChangeAccumulator {
                status: true,
                ..ChangeAccumulator::default()
            };
            if let Err(error) = self.finish_observation("syncular_epoch_acquisition", batch) {
                self.rollback_observation("syncular_epoch_acquisition");
                self.sync_needed = previous_sync_needed;
                return Err(error);
            }
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
            return Ok(Vec::new());
        }
        let resets = self.subs.iter().map(|sub| sub.id.clone()).collect();
        self.begin_observation("syncular_log_epoch_reset")?;
        let prior_subs = self.subs.clone();
        let prior_outbox = self.outbox.clone();
        let prior_rejections = self.rejections.clone();
        let prior_upgrading = self.upgrading;
        let prior_stopped = self.stopped;
        let prior_schema_floor = self.schema_floor.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        let prior_sync_needed = self.sync_needed;
        let prior_active_round = self.active_round;
        let mut batch = ChangeAccumulator::default();
        let result = self
            .run_schema_reset_observed(&mut batch, false)
            .and_then(|()| {
                self.conn
                    .execute(
                        "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                        rusqlite::params![LOG_EPOCH_KEY, log_epoch],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                self.sync_needed = true;
                batch.status = true;
                self.finish_observation("syncular_log_epoch_reset", batch)
            });
        if let Err(error) = result {
            self.rollback_observation("syncular_log_epoch_reset");
            self.subs = prior_subs;
            self.outbox = prior_outbox;
            self.rejections = prior_rejections;
            self.upgrading = prior_upgrading;
            self.stopped = prior_stopped;
            self.schema_floor = prior_schema_floor;
            self.overlay_dirty.restore(prior_overlay_dirty);
            self.sync_needed = prior_sync_needed;
            self.active_round = prior_active_round;
            return Err(error);
        }
        self.sync_intent_queue.push_back(SyncIntent::Interactive);
        Ok(resets)
    }

    fn run_schema_reset_observed(
        &mut self,
        batch: &mut ChangeAccumulator,
        capture: bool,
    ) -> Result<(), String> {
        // §7.4.2: the reset is the only path that wipes local tables for a
        // version bump, and it rewrites the marker last. Re-read the marker
        // under this reset's transaction: a replica another process upgraded
        // meanwhile refuses here instead of being reset to this client's
        // older schema.
        read_local_schema_version(&self.conn, self.schema.version)?;
        self.conn
            .execute_batch(
                "DELETE FROM _syncular_acked_rows; DELETE FROM _syncular_row_deliveries;",
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.cancel_sync_round();
        self.upgrading = true;
        batch.status = true;
        // RFC 0005 D6: classify the pending outbox against the NEW compiled
        // schema BEFORE the wipe, and record the advisory audit. It drops
        // nothing — the §7.4.4 send-time drop stays the only path that removes
        // a commit. The classification is shared with that drop so the two can
        // never disagree about what is incompatible.
        if self.previous_version.is_some_and(|config| config.enabled) {
            let previous_version = self
                .get_meta(LOCAL_SCHEMA_VERSION_KEY)
                .and_then(|value| value.parse::<i32>().ok())
                .unwrap_or(self.schema.version);
            let pending = self
                .outbox
                .iter()
                .map(|commit| PendingCommitAudit {
                    commit_id: &commit.client_commit_id,
                    operations: commit_audit_operations(commit),
                })
                .collect::<Vec<_>>();
            crate::previous_version::write_previous_version_audit(
                &self.conn,
                &crate::previous_version::build_previous_version_audit(
                    &self.schema,
                    &pending,
                    previous_version,
                    self.schema.version,
                    self.clock_now_ms(),
                ),
            );
        }
        // RFC 0005 D5: the container lives in its own FILE, so the reset can
        // never reach it. Sweep first (unconditional — also on the log-epoch
        // reset, which captures nothing), then capture BEFORE the wipe drops
        // any row. A refused capture records its reason and leaves no file.
        if let Some(replica_path) = self.previous_version_replica_path() {
            sweep_previous_version_container(&self.conn, &replica_path)?;
            if capture {
                if let Some(config) = self.previous_version.filter(|config| config.enabled) {
                    let previous_version = self
                        .get_meta(LOCAL_SCHEMA_VERSION_KEY)
                        .and_then(|value| value.parse::<i32>().ok())
                        .unwrap_or(self.schema.version);
                    capture_previous_version_from_replica(
                        &self.conn,
                        &replica_path,
                        previous_version,
                        self.schema.version,
                        &config,
                        self.clock_now_ms(),
                    )?;
                }
            }
        }
        for table in &self.schema.tables {
            batch.table(&table.name);
        }
        for (base_key, unit, table) in self.load_registered_window_units() {
            batch.window(&base_key, &table, &unit);
        }
        if capture {
            self.prune_unknown_subscriptions(true)?;
        }
        // The per-table insert SQL is derived from the OLD column lists.
        self.insert_sql.borrow_mut().clear();
        self.overlay_dirty.set(true);
        // Drop every synced table (base + visible) that currently exists —
        // discovered from sqlite_master so a bump that adds/removes tables is
        // handled. Bookkeeping tables (`_syncular_outbox/_subscriptions/_meta`
        // and the blob cache) are preserved; base tables are `_syncular_base_*`
        // so they are matched explicitly, not by the bookkeeping filter.
        // Drop virtual tables first so SQLite removes every FTS shadow table
        // atomically instead of the generic discovery tearing it apart.
        let virtual_tables: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            rows.filter_map(Result::ok)
                .filter(|name| is_synced_table_name(name))
                .collect()
        };
        for name in virtual_tables {
            self.conn
                .execute_batch(&format!(
                    "DROP TABLE IF EXISTS {}",
                    quote_ident(&format!("_syncular_fts_{name}"))
                ))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), [])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        let existing: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), [])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
            self.persist_sub(sub)?;
        }
        // The stop state is over: this client now ships a servable schema.
        self.stopped = false;
        self.schema_floor = None;
        self.delete_meta(SCHEMA_FLOOR_KEY);
        // Rewrite the marker LAST so a crash mid-reset re-runs the reset.
        self.persist_schema_version()?;
        self.save_subscription_scope_schema();
        // §7.4.3/§7.4.4: the reset preserves the outbox. A pending upsert that
        // cannot re-encode under the new schema stays pending and is classified
        // by the send-time prepass (`drop_incompatible_outbox` in
        // `prepare_sync_round`), matching the SPEC's rule that the send-time drop
        // is the only path that removes a commit, and the TypeScript core's
        // timing.
        // Re-apply the surviving outbox optimistically over the empty tables.
        self.rebuild_overlay()?;
        Ok(())
    }

    /// §7.4.4 send-time prepass: a persisted upsert whose values reference a
    /// column the current schema lacks (or a removed table) cannot be encoded
    /// (`commit_audit_operations` inspects upserts, so a value-free delete stays
    /// encodable and is validated by the server). Drop the commit, undo its
    /// optimistic projection, and raise a client-local
    /// `sync.outbox_incompatible` rejection.
    fn drop_incompatible_outbox(&mut self) -> Result<bool, String> {
        let incompatible = self
            .outbox
            .iter()
            .filter(|commit| {
                first_incompatibility(&self.schema, &commit_audit_operations(commit)).is_some()
            })
            .cloned()
            .collect::<Vec<_>>();
        if incompatible.is_empty() {
            return Ok(false);
        }
        // §7.4.4: one observation covers the durable outcome writes, the outbox
        // removal, the in-memory drop, and the overlay rebuild, so a storage
        // fault leaves the replica and the client unchanged and publishes no
        // change; a successful drop publishes exactly one batch carrying the
        // rejections, outcomes, status, and the tables whose projection changed.
        let prior_outbox = self.outbox.clone();
        let prior_rejections = self.rejections.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        let owns_transaction = self.conn.is_autocommit();
        self.begin_observation("syncular_outbox_drop")?;
        let mut batch = ChangeAccumulator::default();
        let dropped = (|| -> Result<(), String> {
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
                // A removed table has no local projection to invalidate; every
                // surviving table the dropped commit touched does.
                for operation in &commit.ops {
                    if self.schema.table(&operation.table).is_some() {
                        batch.table(&operation.table);
                    }
                }
            }
            self.prune_commit_outcomes()?;
            let incompatible_ids = incompatible
                .iter()
                .map(|commit| commit.client_commit_id.as_str())
                .collect::<BTreeSet<_>>();
            self.outbox
                .retain(|commit| !incompatible_ids.contains(commit.client_commit_id.as_str()));
            self.rejections.extend(rejections);
            // The dropped commits' purely-optimistic rows are undone: the
            // visible projection is re-derived from the surviving base + outbox.
            self.overlay_dirty.set(true);
            self.rebuild_overlay()?;
            batch.status = true;
            batch.rejections = true;
            batch.outcomes = true;
            Ok(())
        })();
        let result = dropped.and_then(|()| self.finish_observation("syncular_outbox_drop", batch));
        if let Err(error) = result {
            // An outer RELEASE is the COMMIT. Roll back that transaction
            // directly: retrying RELEASE after ROLLBACK TO still needs the
            // reader's lock. A nested observation only rolls back its savepoint.
            if owns_transaction {
                if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                    let mut failure = self.storage_failure.borrow_mut();
                    let failure =
                        failure.get_or_insert_with(|| QueryReadFailure::from(error.clone()));
                    failure.rollback_failure = Some(Box::new(QueryReadFailure::from(rollback)));
                }
            } else {
                self.rollback_observation("syncular_outbox_drop");
            }
            self.outbox = prior_outbox;
            self.rejections = prior_rejections;
            self.overlay_dirty.restore(prior_overlay_dirty);
            return Err(error);
        }
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
                self.conn
                    .execute(&sql, [])
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                }
            }
        }
        // FTS exists only on the visible half. It is a local search
        // projection, never a synced/base table or a wire-schema member.
        for table in &self.schema.tables {
            for index in &table.fts_indexes {
                self.create_fts_projection(table, index)?;
            }
        }
        Ok(())
    }

    fn fts_projection_exists(&self, index: &FtsIndexSchema) -> Result<bool, String> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![index.name],
                |row| row.get(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(count > 0)
    }

    fn drop_fts_triggers(&self, index: &FtsIndexSchema) -> Result<(), String> {
        for suffix in ["ai", "ad", "au"] {
            self.conn
                .execute(
                    &format!(
                        "DROP TRIGGER IF EXISTS {}",
                        quote_ident(&format!("{}_{suffix}", index.name))
                    ),
                    [],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(())
    }

    fn create_fts_triggers(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        let fts = quote_ident(&index.name);
        let source = visible_table(&table.name);
        let source_id = quote_ident(FTS_SOURCE_ID_COLUMN);
        let pk = quote_ident(&table.primary_key);
        let projection_columns = std::iter::once(source_id.clone())
            .chain(index.columns.iter().map(|column| quote_ident(column)))
            .collect::<Vec<_>>()
            .join(", ");
        let new_values = std::iter::once(format!("CAST(new.{pk} AS TEXT)"))
            .chain(
                index
                    .columns
                    .iter()
                    .map(|column| format!("new.{}", quote_ident(column))),
            )
            .collect::<Vec<_>>()
            .join(", ");
        let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
        let delete_new = format!("DELETE FROM {fts} WHERE rowid = (SELECT id FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)); DELETE FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)");
        let delete_old = format!("DELETE FROM {fts} WHERE rowid = (SELECT id FROM {mapping} WHERE source_id = CAST(old.{pk} AS TEXT)); DELETE FROM {mapping} WHERE source_id = CAST(old.{pk} AS TEXT)");
        let insert_new = format!("INSERT INTO {mapping}(source_id) VALUES (CAST(new.{pk} AS TEXT)); INSERT INTO {fts} (rowid, {projection_columns}) VALUES ((SELECT id FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)), {new_values})");
        let bi = quote_ident(&format!("{}_bi", index.name));
        let ai = quote_ident(&format!("{}_ai", index.name));
        let ad = quote_ident(&format!("{}_ad", index.name));
        let au = quote_ident(&format!("{}_au", index.name));
        let replacement_exists = format!("EXISTS (SELECT 1 FROM {source} WHERE {pk} = new.{pk})");
        let sql = format!(
            "DROP TRIGGER IF EXISTS {bi};
             DROP TRIGGER IF EXISTS {ai};
             DROP TRIGGER IF EXISTS {ad};
             DROP TRIGGER IF EXISTS {au};
             CREATE TRIGGER {bi} BEFORE INSERT ON {source} WHEN {replacement_exists} BEGIN {delete_new}; END;
             CREATE TRIGGER {ai} AFTER INSERT ON {source} BEGIN {insert_new}; END;
             CREATE TRIGGER {ad} AFTER DELETE ON {source} BEGIN {delete_old}; END;
             CREATE TRIGGER {au} AFTER UPDATE ON {source} BEGIN {delete_old}; {delete_new}; {insert_new}; END;",
        );
        self.conn
            .execute_batch(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn rebuild_fts_projection(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        let fts = quote_ident(&index.name);
        let source_id = quote_ident(FTS_SOURCE_ID_COLUMN);
        let pk = quote_ident(&table.primary_key);
        let indexed_columns = index
            .columns
            .iter()
            .map(|column| quote_ident(column))
            .collect::<Vec<_>>();
        let projection_columns = std::iter::once(source_id.clone())
            .chain(indexed_columns.iter().cloned())
            .collect::<Vec<_>>()
            .join(", ");
        let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
        let sql = format!(
            "DELETE FROM {fts}; DELETE FROM {mapping}; INSERT INTO {fts} ({projection_columns}) SELECT CAST({pk} AS TEXT), {columns} FROM {source}; INSERT INTO {mapping}(id, source_id) SELECT rowid, {source_id} FROM {fts};",
            columns = indexed_columns.join(", "),
            source = visible_table(&table.name),
        );
        self.conn
            .execute_batch(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn create_fts_projection(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        self.begin_observation("syncular_fts_schema")?;
        let result = (|| {
            let existed = self.fts_projection_exists(index)?;
            let tokenizer = index.tokenize.replace('\'', "''");
            let columns = index
                .columns
                .iter()
                .map(|column| quote_ident(column))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {fts} USING fts5({source_id} UNINDEXED, {columns}, tokenize='{tokenizer}')",
            fts = quote_ident(&index.name),
            source_id = quote_ident(FTS_SOURCE_ID_COLUMN),
        );
            self.conn.execute(&sql, []).map_err(|error| {
                format!(
                    "cannot create local FTS5 projection {:?}: {error}",
                    index.name
                )
            })?;
            let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
            let mapped: bool = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [format!("_syncular_fts_{}", index.name)],
                    |row| row.get(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.conn.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {mapping}(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE)")).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if !mapped && existed {
                self.conn
                    .execute_batch(&format!(
                        "INSERT INTO {mapping}(id, source_id) SELECT rowid, {} FROM {}",
                        quote_ident(FTS_SOURCE_ID_COLUMN),
                        quote_ident(&index.name)
                    ))
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            self.create_fts_triggers(table, index)?;
            if !existed {
                self.rebuild_fts_projection(table, index)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.rollback_observation("syncular_fts_schema");
            return Err(error);
        }
        if let Err(error) = self.conn.execute_batch("RELEASE syncular_fts_schema") {
            self.rollback_observation("syncular_fts_schema");
            return Err(error.to_string());
        }
        Ok(())
    }

    // -- persistence write-through --------------------------------------------

    fn persist_sub(&self, sub: &Subscription) -> Result<(), String> {
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
        self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_subscriptions (id, tbl, state_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub.id, sub.table, state.to_string()],
        ).map(|_| ()).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn persist_outbox_insert(&self, commit: &OutboxCommit) -> Result<(), String> {
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
                })
            })
            .collect();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_outbox (commit_id, ops_json) VALUES (?1, ?2)",
                rusqlite::params![commit.client_commit_id, Value::Array(ops).to_string()],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        for operation in &commit.ops {
            let Some(values) = &operation.values else {
                continue;
            };
            let Some(table) = self.schema.table(&operation.table) else {
                continue;
            };
            for column in table
                .columns
                .iter()
                .filter(|column| column.ty == ColumnType::BlobRef)
            {
                let Some(Value::String(raw)) = values.get(&column.name) else {
                    continue;
                };
                let Ok(blob_ref) = serde_json::from_str::<Value>(raw) else {
                    continue;
                };
                let Some(blob_id) = blob_ref.get("blobId").and_then(Value::as_str) else {
                    continue;
                };
                self.conn
                    .execute(
                        "INSERT OR IGNORE INTO _syncular_blob_commit_refs(commit_id, blob_id)
                         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM _syncular_blobs WHERE blob_id = ?2)",
                        rusqlite::params![commit.client_commit_id, blob_id],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
        }
        Ok(())
    }

    fn delete_outbox_persisted(&self, client_commit_id: &str) -> Result<(), String> {
        if let Some(commit) = self
            .outbox
            .iter()
            .find(|commit| commit.client_commit_id == client_commit_id)
        {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }

        self.conn
            .execute(
                "DELETE FROM _syncular_blob_commit_refs WHERE commit_id = ?1",
                rusqlite::params![client_commit_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.conn
            .execute(
                "DELETE FROM _syncular_outbox WHERE commit_id = ?1",
                rusqlite::params![client_commit_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.conn.execute("DELETE FROM _syncular_row_deliveries WHERE NOT EXISTS(SELECT 1 FROM _syncular_outbox,json_each(ops_json) WHERE json_extract(json_each.value,'$.table')=tbl AND json_extract(json_each.value,'$.rowId')=id)", [])
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
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
            retained_rows: None,
            resolution: Self::parse_outcome_resolution(&resolution)?,
            resolved_at_ms,
            replacement_client_commit_id,
        })
    }

    /// Resolve declared unique keys through SQLite, including affinity and NULL semantics.
    fn unique_conflicts(
        &self,
        table: &TableSchema,
        values: &Map<String, Value>,
        base: bool,
    ) -> Result<Vec<RetainedUniqueConflict>, String> {
        let source = if base {
            base_table(&table.name)
        } else {
            visible_table(&table.name)
        };
        let mut conflicts = Vec::new();
        for index in table.indexes.iter().filter(|index| index.unique) {
            let mut params = vec![json_param_to_sql(
                values.get(&table.primary_key).ok_or("sync.local_corrupt")?,
            )?];
            for name in &index.columns {
                let column = table
                    .columns
                    .iter()
                    .find(|column| column.name == *name)
                    .ok_or("sync.local_corrupt")?;
                let cell = json_to_column_value(column, values.get(name))?;
                params.push(owned_sql_value(RowParam::Cell(&cell))?);
            }
            let sql = format!(
                "SELECT * FROM {source} WHERE {} != ? AND {}",
                quote_ident(&table.primary_key),
                index
                    .columns
                    .iter()
                    .map(|column| format!("{} = ?", quote_ident(column)))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            );
            let mut statement = self
                .conn
                .prepare_cached(&sql)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let records = statement
                .query_map(rusqlite::params_from_iter(params), |record| {
                    let values = table
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(index, column)| {
                            let value = sql_ref_to_json(column, record.get_ref(index)?);
                            json_to_column_value(column, Some(&value)).map_err(|message| {
                                rusqlite::Error::ToSqlConversionFailure(message.into())
                            })
                        })
                        .collect::<Result<Row, _>>()?;
                    Ok((values, record.get::<_, i64>(table.columns.len())?))
                })
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            for record in records {
                let (row, version) =
                    record.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let row_id = render_row_id_json(Some(&column_value_to_json(&row[table.pk_index])))?;
                conflicts.push(RetainedUniqueConflict {
                    index: index.name.clone(),
                    columns: index.columns.clone(),
                    row_id,
                    server_row: table
                        .columns
                        .iter()
                        .zip(&row)
                        .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                        .collect(),
                    server_version: version,
                });
            }
        }
        Ok(conflicts)
    }

    fn attach_retained_rows(&self, mut outcome: CommitOutcome) -> Result<CommitOutcome, String> {
        if let Some((commit, initial)) = self
            .failed_commits
            .iter()
            .find(|(commit, _)| commit.client_commit_id == outcome.client_commit_id)
        {
            let mut rows = Vec::new();
            for operation in &commit.ops {
                let table = self
                    .schema
                    .table(&operation.table)
                    .ok_or_else(|| "sync.unknown_table".to_owned())?;
                let key =
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                let base = self.stored_row(table, &operation.row_id, true)?;
                rows.push(RetainedCommitRow {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    unique_conflicts: if operation.upsert {
                        self.unique_conflicts(
                            table,
                            initial
                                .get(&key)
                                .and_then(Value::as_object)
                                .or(operation.values.as_ref())
                                .ok_or("sync.local_corrupt")?,
                            true,
                        )?
                    } else {
                        Vec::new()
                    },
                    local_row: if operation.upsert {
                        initial
                            .get(&key)
                            .and_then(Value::as_object)
                            .cloned()
                            .or_else(|| operation.values.clone())
                    } else {
                        None
                    },
                    server_row: base.as_ref().map(|(values, _)| {
                        table
                            .columns
                            .iter()
                            .zip(values)
                            .map(|(column, value)| {
                                (column.name.clone(), column_value_to_json(value))
                            })
                            .collect()
                    }),
                    server_version: base.map(|(_, version)| version),
                });
            }
            outcome.retained_rows = Some(rows);
        }
        Ok(outcome)
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        row.map(|row| self.attach_retained_rows(Self::outcome_from_row(row)?))
            .transpose()
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
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut outcomes = Vec::new();
        for row in rows {
            outcomes.push(self.attach_retained_rows(Self::outcome_from_row(
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
            )?)?);
        }
        Ok(outcomes)
    }

    fn prune_commit_outcomes(&self) -> Result<(), String> {
        #[cfg(test)]
        self.outcome_prune_count
            .set(self.outcome_prune_count.get() + 1);
        let max_entries = self.limits.outcome_retention_max_entries.unwrap_or(1_000);
        let count = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM _syncular_commit_outcomes",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
            as usize;
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
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = stmt
            .query_map(rusqlite::params![excess as i64], |row| row.get::<_, i64>(0))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let sequences = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        drop(stmt);
        for sequence in sequences {
            self.conn
                .execute(
                    "DELETE FROM _syncular_commit_outcomes WHERE seq = ?1",
                    rusqlite::params![sequence],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
        if let Some(existing) = self.subs.iter().find(|subscription| subscription.id == id) {
            let same_intent = existing.table == table
                && canonical_scope_json(&existing.requested) == canonical_scope_json(&scopes)
                && existing.params == params;
            if same_intent {
                return Ok(());
            }
            return Err(
                "client.subscription_intent_mismatch: the subscription id is already registered for a different table, scopes, or params"
                    .to_owned(),
            );
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
        self.persist_sub(&sub)?;
        self.subs.push(sub);
        Ok(())
    }

    pub fn unsubscribe(&mut self, id: &str) {
        if self.subs.iter().any(|s| s.id == id) {
            self.cancel_sync_round();
        }
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
    /// unsubscribed with their first eviction chunk in one transaction (E1–E4).
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

        let prior_subs = self.subs.clone();
        let widened = (|| {
            // Widen: units wanted but not live → fresh subscription + registry row.
            for unit in units {
                if live.iter().any(|(u, _)| u == unit) {
                    continue;
                }
                let sub_id = derive_sub_id(base, unit);
                self.delete_pending_evict(&sub_id)?;
                self.insert_window_unit(&base_key, unit, &sub_id)?;
                self.subscribe(
                    sub_id,
                    base.table.clone(),
                    unit_scopes(base, unit),
                    base.params.clone(),
                )?;
                batch.window(&base_key, &base.table, unit);
                changed = true;
            }

            self.finish_observation("syncular_window", batch)
        })();
        if let Err(error) = widened {
            self.rollback_observation("syncular_window");
            self.subs = prior_subs;
            return Err(error);
        }
        for (unit, sub_id) in live {
            if wanted.contains(&unit) {
                continue;
            }
            self.rebuild_overlay_if_dirty()?;
            let prior_subs = self.subs.clone();
            self.begin_observation("syncular_window")?;
            let effective = self
                .subs
                .iter()
                .find(|sub| sub.id == sub_id)
                .and_then(|sub| sub.effective.clone())
                .unwrap_or_else(|| unit_scopes(base, &unit));
            let mut batch = ChangeAccumulator::default();
            self.record_scope_map(&mut batch, &base.table, &effective);
            batch.window(&base_key, &base.table, &unit);
            let result = self.evict_unit(&base_key, base, &unit, &sub_id);
            let remaining = match result {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.rollback_observation("syncular_window");
                    self.subs = prior_subs;
                    return Err(error);
                }
            };
            if let Err(error) = self.finish_observation("syncular_window", batch) {
                self.rollback_observation("syncular_window");
                self.subs = prior_subs;
                return Err(error);
            }
            if remaining {
                self.drain_pending_evictions()?;
            }
            changed = true;
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

    fn insert_window_unit(&self, base_key: &str, unit: &str, sub_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_windows(base, unit, sub_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![base_key, unit, sub_id],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn delete_window_unit(&self, base_key: &str, unit: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_windows WHERE base = ?1 AND unit = ?2",
                rusqlite::params![base_key, unit],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// §4.8 E1–E4: evict one departing unit, fused with unsubscription.
    /// Deletes the unit's rows except those pinned by a pending outbox
    /// commit (E1); records a deferred eviction if any pin remains; discards
    /// the subscription's cursor/resume/effective-echo (E3) and version
    /// state with the rows (E2). Fail-closed: no local mapping ⇒ evict
    /// nothing.
    fn evict_unit(
        &mut self,
        base_key: &str,
        base: &WindowBase,
        unit: &str,
        sub_id: &str,
    ) -> Result<bool, String> {
        let effective = self
            .subs
            .iter()
            .find(|s| s.id == sub_id)
            .and_then(|s| s.effective.clone())
            .unwrap_or_else(|| unit_scopes(base, unit));
        let pinned = self.pinned_row_ids(&base.table);
        let (remaining, deferred) = self.evict_scope_rows(&base.table, &effective, &pinned)?;
        self.delete_window_unit(base_key, unit)?;
        self.conn
            .execute(
                "DELETE FROM _syncular_subscriptions WHERE id = ?1",
                [sub_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.subs.retain(|sub| sub.id != sub_id);
        if deferred {
            self.save_pending_evict(sub_id, &base.table, &effective)?;
        } else {
            self.delete_pending_evict(sub_id)?;
        }
        Ok(remaining)
    }

    /// §4.8 E1: delete base rows matching effective scopes EXCEPT pinned
    /// primary keys. Returns (more unpinned work, any scoped rows remain).
    /// A missing scope-column mapping fails without deleting rows.
    fn evict_scope_rows(
        &self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        pinned: &std::collections::HashSet<String>,
    ) -> Result<(bool, bool), String> {
        if effective.is_empty() {
            return Ok((false, false));
        }
        let table = self.schema.table(table_name).ok_or("sync.unknown_table")?;
        let mut clauses = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or("sync.scope_revoked")?;
            if values.is_empty() {
                return Ok((false, false));
            }
            let holes = values
                .iter()
                .map(|v| {
                    params.push(SqlValue::Text(v.clone()));
                    "?"
                })
                .collect::<Vec<_>>()
                .join(", ");
            clauses.push(format!("{} IN ({holes})", quote_ident(column)));
        }
        let scope = clauses.join(" AND ");
        let scope_params = params.len();
        let pk = quote_ident(&table.primary_key);
        if !pinned.is_empty() {
            let holes = pinned
                .iter()
                .map(|id| {
                    params.push(SqlValue::Text(id.clone()));
                    "?"
                })
                .collect::<Vec<_>>()
                .join(", ");
            clauses.push(format!("{pk} NOT IN ({holes})"));
        }
        let predicate = clauses.join(" AND ");
        let base = base_table(table_name);
        let visible = visible_table(table_name);
        let mut ids: Vec<SqlValue> = Vec::new();
        for source in [&base, &visible] {
            let mut stmt = self
                .conn
                .prepare_cached(&format!(
                    "SELECT {pk} FROM {source} WHERE {predicate} LIMIT 1024"
                ))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            ids = stmt
                .query_map(rusqlite::params_from_iter(&params), |row| row.get(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
                .collect::<Result<_, _>>()
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if !ids.is_empty() {
                break;
            }
        }
        if !ids.is_empty() {
            for id in &ids {
                self.conn
                    .execute(
                        "DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2",
                        rusqlite::params![table_name, id],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            let holes = vec!["?"; ids.len()].join(", ");
            for source in [&base, &visible] {
                self.conn
                    .execute(
                        &format!("DELETE FROM {source} WHERE {pk} IN ({holes})"),
                        rusqlite::params_from_iter(&ids),
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
        }
        let mut remaining = false;
        let mut deferred = false;
        for source in [&base, &visible] {
            remaining |= self
                .conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {source} WHERE {predicate})"),
                    rusqlite::params_from_iter(&params),
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            deferred |= self
                .conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {source} WHERE {scope})"),
                    rusqlite::params_from_iter(&params[..scope_params]),
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok((remaining, deferred))
    }

    /// Resume committed eviction chunks, retaining outbox pins and their durable marker.
    fn drain_pending_evictions(&mut self) -> Result<(), String> {
        let pending = self.load_pending_evictions()?;
        if pending.is_empty() {
            return Ok(());
        }
        self.rebuild_overlay_if_dirty()?;
        for (sub_id, table_name, effective) in pending {
            if self.schema.table(&table_name).is_none() {
                self.delete_pending_evict(&sub_id)?;
                continue;
            }
            loop {
                std::thread::yield_now();
                self.begin_observation("syncular_evict")?;
                let pinned = self.pinned_row_ids(&table_name);
                let result = self.evict_scope_rows(&table_name, &effective, &pinned);
                let (remaining, deferred) = match result {
                    Ok(result) => result,
                    Err(error) => {
                        self.rollback_observation("syncular_evict");
                        return Err(error);
                    }
                };
                if !deferred {
                    if let Err(error) = self.delete_pending_evict(&sub_id) {
                        self.rollback_observation("syncular_evict");
                        return Err(error);
                    }
                }
                let mut batch = ChangeAccumulator::default();
                self.record_scope_map(&mut batch, &table_name, &effective);
                if let Err(error) = self.finish_observation("syncular_evict", batch) {
                    self.rollback_observation("syncular_evict");
                    return Err(error);
                }
                if !remaining {
                    break;
                }
            }
        }
        Ok(())
    }

    /// §4.8 E1: primary keys of `table` referenced by a pending outbox
    /// commit — rows that MUST NOT be evicted until the commit drains.
    fn pinned_row_ids(&self, table: &str) -> std::collections::HashSet<String> {
        let mut pinned = std::collections::HashSet::new();
        for commit in self
            .outbox
            .iter()
            .chain(self.failed_commits.iter().map(|(commit, _)| commit))
        {
            for op in &commit.ops {
                if op.table == table {
                    pinned.insert(op.row_id.clone());
                }
            }
        }
        pinned
    }

    fn save_pending_evict(
        &self,
        sub_id: &str,
        table: &str,
        effective: &[(String, Vec<String>)],
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_window_pending_evict(sub_id, tbl, effective_scopes) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub_id, table, scope_map_to_json(effective).to_string()],
        ).map(|_| ()).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn delete_pending_evict(&self, sub_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
                rusqlite::params![sub_id],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn load_pending_evictions(&self) -> Result<Vec<PendingEvict>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT sub_id, tbl, effective_scopes FROM _syncular_window_pending_evict")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (sub_id, table, json) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let value: Value = serde_json::from_str(&json)
                .map_err(|_| "sync.local_corrupt: invalid pending eviction scopes".to_owned())?;
            let effective = json_to_scope_map(&value)
                .map_err(|_| "sync.local_corrupt: invalid pending eviction scopes".to_owned())?;
            Ok((sub_id, table, effective))
        })
        .collect()
    }

    /// Select failed-intent retention; reload durable retained aggregates.
    pub fn set_retain_failed_commits(&mut self, enabled: bool) -> Result<(), String> {
        self.retain_failed_commits = enabled;
        for (commit, _) in &self.failed_commits {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        self.failed_commits = self.load_failed_commits()?;
        for (commit, _) in &self.failed_commits {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        Ok(())
    }

    fn load_failed_commits(&self) -> Result<Vec<FailedCommit>, String> {
        let mut statement = self.conn.prepare("SELECT client_commit_id, operations_json, initial_json FROM _syncular_failed_commits ORDER BY seq")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (id, operations, initial) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let operations: Vec<CommitOperation> =
                serde_json::from_str(&operations).map_err(|_| "sync.local_corrupt".to_owned())?;
            let initial =
                serde_json::from_str(&initial).map_err(|_| "sync.local_corrupt".to_owned())?;
            Ok((
                OutboxCommit {
                    client_commit_id: id,
                    ops: operations
                        .into_iter()
                        .map(|op| OutboxOp {
                            upsert: op.op == "upsert",
                            table: op.table,
                            row_id: op.row_id,
                            base_version: op.base_version,
                            values: op.values,
                        })
                        .collect(),
                },
                initial,
            ))
        })
        .collect()
    }

    fn retain_failed_commit(&mut self, id: &str, operations: &[OutboxOp]) -> Result<(), String> {
        let mut initial = Map::new();
        for operation in operations {
            let table = self
                .schema
                .table(&operation.table)
                .ok_or_else(|| "sync.unknown_table".to_owned())?;
            let initial_row = match self.stored_row(table, &operation.row_id, true)? {
                Some(row) => Some(row),
                None => self.visible_row(table, &operation.row_id)?,
            };
            if let Some((values, _)) = initial_row {
                let mut intended: Map<String, Value> = table
                    .columns
                    .iter()
                    .zip(values.iter())
                    .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                    .collect();
                if let Some(patch) = &operation.values {
                    intended.extend(patch.clone());
                }
                initial.insert(
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?,
                    Value::Object(intended),
                );
            }
        }
        self.conn.execute("INSERT INTO _syncular_failed_commits(client_commit_id, operations_json, initial_json) VALUES (?1, ?2, ?3)", rusqlite::params![id,
            serde_json::to_string(&operations.iter().map(CommitOperation::from).collect::<Vec<_>>()).map_err(|_| "sync.local_corrupt".to_owned())?,
            serde_json::to_string(&initial).map_err(|_| "sync.local_corrupt".to_owned())?])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.failed_commits.push((
            OutboxCommit {
                client_commit_id: id.to_owned(),
                ops: operations.to_vec(),
            },
            initial,
        ));
        Ok(())
    }

    fn drop_failed_commits(
        &mut self,
        matches: impl Fn(&str, &Map<String, Value>) -> bool,
    ) -> Result<Vec<OutboxCommit>, String> {
        let mut doomed = self.drop_acknowledged_rows(&matches)?;
        for (commit, initial) in &self.failed_commits {
            for operation in &commit.ops {
                let key =
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                if initial
                    .get(&key)
                    .and_then(Value::as_object)
                    .is_some_and(|values| matches(&operation.table, values))
                {
                    doomed.push(commit.clone());
                    break;
                }
            }
        }
        for commit in &doomed {
            self.conn
                .execute(
                    "DELETE FROM _syncular_failed_commits WHERE client_commit_id = ?1",
                    rusqlite::params![commit.client_commit_id],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        for commit in &doomed {
            self.conn.execute("UPDATE _syncular_commit_outcomes SET operations_json = NULL, results_json = '[]' WHERE client_commit_id = ?1", rusqlite::params![commit.client_commit_id]).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        self.conflicts.retain(|record| {
            !doomed
                .iter()
                .any(|commit| commit.client_commit_id == record.client_commit_id)
        });
        self.rejections.retain(|record| {
            !doomed
                .iter()
                .any(|commit| commit.client_commit_id == record.client_commit_id)
        });
        self.failed_commits.retain(|(commit, _)| {
            !doomed
                .iter()
                .any(|dropped| dropped.client_commit_id == commit.client_commit_id)
        });
        for commit in &doomed {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        Ok(doomed)
    }

    /// Record one commit of local mutations. The returned commit ID is the
    /// §2.3 idempotency key. Failures are structured so callers read
    /// `code`/`message`/`details` instead of parsing a string prefix.
    pub fn mutate(&mut self, mutations: Vec<Mutation>) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            if mutations.is_empty() {
                return Err(
                    "sync.invalid_request: a commit must contain at least one operation (§6.1)"
                        .to_owned(),
                );
            }
            let mut ops = Vec::with_capacity(mutations.len());
            for mutation in mutations {
                match mutation {
                    Mutation::Patch {
                        table,
                        values,
                        base_version,
                    } => {
                        let schema_table = self
                            .schema
                            .table(&table)
                            .ok_or_else(|| "sync.unknown_table".to_owned())?;
                        let values = normalize_values_casing(schema_table, values)?;
                        let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                        ops.push(self.prepare_patch(&table, &row_id, values, base_version)?);
                    }
                    Mutation::Upsert {
                        table,
                        values,
                        base_version,
                    } => {
                        let schema_table = self.schema.table(&table).ok_or_else(|| {
                            format!("sync.unknown_table: unknown table {table:?}")
                        })?;
                        // §5: value keys are accepted in snake_case AND the
                        // generated row types' camelCase; normalize to SQL truth
                        // before the pk lookup / codec see them.
                        let values = normalize_values_casing(schema_table, values)?;
                        let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                        // §6.7 `mutate` marks every column present: fill missing
                        // nullable columns with NULL before the payload is built.
                        let values = full_row_values(schema_table, values)?;
                        // §5.11: validate the payload encodes with the current
                        // codec. A key-selection or unknown-key failure is a
                        // durable rejection at the push seam (§10.3), never an
                        // author-time error. Full-row `mutate` presents every
                        // column, so no stored fallback is needed.
                        self.validate_author_encode(schema_table, &row_id, &values)?;
                        ops.push(OutboxOp {
                            upsert: true,
                            table,
                            row_id,
                            base_version,
                            values: Some(values),
                        });
                    }
                    Mutation::Delete {
                        table,
                        row_id,
                        base_version,
                    } => {
                        if self.schema.table(&table).is_none() {
                            return Err(format!("sync.unknown_table: unknown table {table:?}"));
                        }
                        ops.push(OutboxOp {
                            upsert: false,
                            table,
                            row_id,
                            base_version,
                            values: None,
                        });
                    }
                }
            }
            self.record_outbox_commit(ops)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// Scope the retained `storage_failure` diagnostic to this call so an
    /// earlier operation's failure cannot classify a new one, and surface the
    /// call's own classified failure with its details. A fresh classified
    /// failure replaces the retained diagnostic; otherwise the earlier one is
    /// kept for the next sync.
    fn finish_authoring(
        &self,
        prior: Option<QueryReadFailure>,
        outcome: Result<String, String>,
    ) -> Result<String, ClientError> {
        let fresh = self.storage_failure.borrow_mut().take();
        *self.storage_failure.borrow_mut() = fresh.clone().or(prior);
        match outcome {
            Ok(id) => Ok(id),
            Err(message) => Err(fresh
                .map(ClientError::from)
                .unwrap_or_else(|| ClientError::from(message))),
        }
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
        if let Err(error) = self.persist_outbox_insert(&commit) {
            self.rollback_observation("syncular_mutation");
            return Err(error);
        }
        let was_dirty = self.overlay_dirty.snapshot();
        // A clean overlay contains the FIFO fold of every previous commit, so
        // the new commit applies over it. §7.1: an operation that does not
        // apply (a secondary unique collision) fails the whole commit; the
        // savepoint rollback removes the outbox entry and every visible write.
        if let Err(error) = self.rebuild_overlay_if_dirty() {
            self.rollback_observation("syncular_mutation");
            self.overlay_dirty.restore(was_dirty.clone());
            return Err(error);
        }
        if let Some(error) = commit
            .ops
            .iter()
            .find_map(|op| self.apply_outbox_op(op).err())
        {
            self.rollback_observation("syncular_mutation");
            self.overlay_dirty.restore(was_dirty.clone());
            return Err(error);
        }
        let id = commit.client_commit_id.clone();
        self.outbox.push(commit);
        batch.status = true;
        if let Err(error) = self.finish_observation("syncular_mutation", batch) {
            self.rollback_observation("syncular_mutation");
            self.outbox.pop();
            self.overlay_dirty.restore(was_dirty.clone());
            return Err(error);
        }
        Ok(id)
    }

    /// Record one §6.1 sparse upsert: the primary key plus the supplied
    /// non-scope columns are present; every other column is absent and stays
    /// untouched on the server and in the local overlay. An absent local base
    /// refuses the whole batch with sync.row_missing before enqueueing (§7.1).
    /// Failures are structured so callers read `code`/`message`/`details`.
    pub fn patch(
        &mut self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = self.perform_patch(table, row_id, partial, base_version);
        self.finish_authoring(prior, outcome)
    }

    /// The unscoped patch body. Public authoring entry points scope
    /// `storage_failure` around the whole operation, including any pre-read.
    fn perform_patch(
        &mut self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<String, String> {
        let operation = self.prepare_patch(table, row_id, partial, base_version)?;
        self.record_outbox_commit(vec![operation])
    }

    fn prepare_patch(
        &self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<OutboxOp, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("sync.unknown_table: unknown table {table:?}"))?;
        let partial = normalize_values_casing(schema_table, partial)?;
        if let Some(pk) = partial.get(&schema_table.primary_key) {
            if pk.as_str() != Some(row_id) {
                return Err(format!(
                    "sync.invalid_request: table {table:?}: patch cannot change the primary key"
                ));
            }
        }
        // Existence reads only the key. Locked encrypted values stay opaque;
        // decoding the complete row here would reject a valid plain patch.
        let exists: bool = self
            .conn
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {} WHERE {})",
                    visible_table(table),
                    row_id_predicate(schema_table)
                ),
                rusqlite::params![row_id],
                |row| row.get(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        if !exists {
            return Err("sync.row_missing: a sparse patch requires a local row".to_owned());
        }
        // §3.4 rule 5 / §6.2: scope columns are immutable on update. The
        // server accepts a present scope column whose value equals the
        // stored row and applies it as a no-op, so a decoded envelope
        // round-trips. The local row is the only value the client can prove
        // equality against; when the row is absent locally the client cannot
        // prove equality against the server's stored row and fails closed.
        // A primary key that is also a scope column needs no stored-row
        // read: the primary key in a sparse payload is by construction the
        // row id being patched (§6.1), so its value is proven equal already.
        for scope in &schema_table.scope_variables {
            if !partial.contains_key(&scope.column) || scope.column == schema_table.primary_key {
                continue;
            }
            let Some(column) = schema_table
                .columns
                .iter()
                .find(|column| column.name == scope.column)
            else {
                continue;
            };
            let stored = self
                .conn
                .query_row(
                    &format!(
                        "SELECT {} FROM {} WHERE {}",
                        quote_ident(&scope.column),
                        visible_table(&schema_table.name),
                        row_id_predicate(schema_table)
                    ),
                    rusqlite::params![row_id],
                    |row| Ok(sql_ref_to_json(column, row.get_ref(0)?)),
                )
                .optional()
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            // Decode the supplied value through the same column-type path the
            // rest of the patch encoding uses, so a value that only equals
            // the stored one in another number representation still compares
            // equal.
            let incoming = json_to_column_value(column, partial.get(&scope.column))
                .ok()
                .map(|value| column_value_to_json(&value));
            // A stored blob never equals a patch value, matching the server's
            // scope-column comparison (§3.4): bytes are unstorable as scope
            // values.
            let equal = stored.as_ref().is_some_and(|stored| {
                stored.get("$bytes").is_none() && incoming.as_ref() == Some(stored)
            });
            if !equal {
                return Err(format!(
                    "sync.invalid_request: table {table:?}: patch cannot write scope column {:?} (§3.4)",
                    scope.column
                ));
            }
        }
        let mut values = partial;
        // Presence-set semantics: a proven-equal scope column is dropped, so
        // the patch leaves the stored value untouched (§6.2).
        for scope in &schema_table.scope_variables {
            values.remove(&scope.column);
        }
        values.insert(
            schema_table.primary_key.clone(),
            Value::from(row_id.to_owned()),
        );
        // §5.11: structural validation only; an absent key-id selector is
        // resolved at the push seam from the stored local row, and a
        // key-selection or unknown-key failure becomes a durable
        // `client.encrypt_failed` rejection there (§10.3), never an
        // author-time error.
        self.validate_author_encode(schema_table, row_id, &values)?;
        Ok(OutboxOp {
            upsert: true,
            table: table.to_owned(),
            row_id: row_id.to_owned(),
            base_version,
            values: Some(values),
        })
    }

    /// §5.11 key-id fallback: the stored local row's selector value as a
    /// positional row (only the selector slot filled). Returns None when no
    /// selector is configured, the row is locally absent, or the stored
    /// value is not a usable key id.
    fn stored_key_fallback(&self, table: &TableSchema, row_id: &str) -> Option<Row> {
        let selector = self.encryption.key_id_columns.get(&table.name)?;
        let index = table
            .columns
            .iter()
            .position(|column| &column.name == selector)?;
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            quote_ident(selector),
            visible_table(&table.name),
            row_id_predicate(table)
        );
        let key: Option<String> = self
            .conn
            .query_row(&sql, rusqlite::params![row_id], |row| row.get(0))
            .ok()?;
        let key = key.filter(|key| !key.is_empty())?;
        let mut fallback: Row = vec![None; table.columns.len()];
        fallback[index] = Some(ColumnValue::String(key));
        Some(fallback)
    }

    /// §5.11/§10.3 author-time encode check: a structural failure (a
    /// non-nullable NULL, a value the codec rejects) is an author-time
    /// error; a key-selection or unknown-key failure is deferred to the push
    /// seam, where it becomes a durable `client.encrypt_failed` rejection.
    fn validate_author_encode(
        &self,
        table: &TableSchema,
        row_id: &str,
        values: &Map<String, Value>,
    ) -> Result<(), String> {
        match encode_sparse_row_json(table, row_id, values, &self.encryption, None) {
            Err(error) if error.starts_with(ENCRYPT_FAILED_CODE) => Ok(()),
            result => result.map(|_| ()),
        }
    }

    /// §5.11/§10.3: drop every pending commit whose push encode fails with
    /// `client.encrypt_failed` (an unresolvable key id or an unknown key) and
    /// raise one durable rejection per commit. `sync()` never aborts for an
    /// encode failure. Mirrors §7.4.4's `drop_incompatible_outbox`, including
    /// undoing the dropped commit's purely-optimistic rows.
    fn drop_unencodable_outbox(&mut self) -> Result<bool, String> {
        if !self
            .schema
            .tables
            .iter()
            .any(|table| table.has_encrypted_columns())
        {
            return Ok(false);
        }
        let failures = self
            .outbox
            .iter()
            .filter_map(|commit| {
                commit
                    .ops
                    .iter()
                    .find_map(|op| {
                        let values = op.values.as_ref().filter(|_| op.upsert)?;
                        let table = self.schema.table(&op.table)?;
                        let fallback = self.stored_key_fallback(table, &op.row_id);
                        match encode_sparse_row_json(
                            table,
                            &op.row_id,
                            values,
                            &self.encryption,
                            fallback.as_ref(),
                        ) {
                            Err(error) if error.starts_with(ENCRYPT_FAILED_CODE) => Some(error),
                            _ => None,
                        }
                    })
                    .map(|error| (commit.clone(), error))
            })
            .collect::<Vec<_>>();
        if failures.is_empty() {
            return Ok(false);
        }
        for (commit, message) in failures {
            if self.retain_failed_commits {
                self.retain_failed_commit(&commit.client_commit_id, &commit.ops)?;
            }
            let rejection = RejectionRecord {
                client_commit_id: commit.client_commit_id.clone(),
                op_index: 0,
                code: ENCRYPT_FAILED_CODE.to_owned(),
                message,
                retryable: false,
                details: None,
                operation: commit.ops.first().map(CommitOperation::from),
            };
            self.persist_commit_outcome(
                &commit.client_commit_id,
                CommitOutcomeStatus::Rejected,
                &[CommitOperationOutcome::Error {
                    rejection: rejection.clone(),
                }],
                Some(&commit.ops),
            )?;
            self.delete_outbox_persisted(&commit.client_commit_id)?;
            self.outbox
                .retain(|candidate| candidate.client_commit_id != commit.client_commit_id);
            self.rejections.push(rejection);
        }
        self.prune_commit_outcomes()?;
        self.rebuild_overlay_if_dirty()?;
        Ok(true)
    }

    pub fn pending_commit_ids(&self) -> Vec<String> {
        self.outbox
            .iter()
            .map(|c| c.client_commit_id.clone())
            .collect()
    }

    /// §6.1: the sparse push payload bytes of every pending upsert operation,
    /// FIFO — exactly what the next push round would put on the wire. Used by
    /// conformance B.21(h) to pin cross-core byte identity.
    pub fn pending_payloads(&self) -> Vec<Vec<u8>> {
        let mut payloads = Vec::new();
        for commit in &self.outbox {
            for op in &commit.ops {
                let Some(values) = op.values.as_ref().filter(|_| op.upsert) else {
                    continue;
                };
                let Some(table) = self.schema.table(&op.table) else {
                    continue;
                };
                let fallback = self.stored_key_fallback(table, &op.row_id);
                if let Ok(payload) = encode_sparse_row_json(
                    table,
                    &op.row_id,
                    values,
                    &self.encryption,
                    fallback.as_ref(),
                ) {
                    payloads.push(payload);
                }
            }
        }
        payloads
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
                matches!(
                    input.resolution,
                    CommitOutcomeResolution::Superseded
                        | CommitOutcomeResolution::ResolvedKeepServer
                )
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
        let previous_failed = self.failed_commits.clone();
        let previous_conflicts = self.conflicts.clone();
        let previous_rejections = self.rejections.clone();
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
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let resolved = self
                .commit_outcome(&current.client_commit_id)?
                .ok_or_else(|| "sync.outcome_not_found: outcome disappeared".to_owned())?;
            self.conn
                .execute(
                    "DELETE FROM _syncular_failed_commits WHERE client_commit_id = ?1",
                    rusqlite::params![input.client_commit_id],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            for (commit, _) in &self.failed_commits {
                if commit.client_commit_id == input.client_commit_id {
                    for operation in &commit.ops {
                        self.overlay_dirty.table(&operation.table);
                    }
                }
            }
            self.failed_commits
                .retain(|(commit, _)| commit.client_commit_id != input.client_commit_id);
            self.prune_commit_outcomes()?;
            Ok(resolved)
        })();
        let resolved = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.rollback_observation("syncular_outcome_resolution");
                self.failed_commits = previous_failed;
                self.conflicts = previous_conflicts;
                self.rejections = previous_rejections;
                return Err(error);
            }
        };
        self.conflicts
            .retain(|record| record.client_commit_id != current.client_commit_id);
        self.rejections
            .retain(|record| record.client_commit_id != current.client_commit_id);
        let mut batch = ChangeAccumulator {
            conflicts: current.status == CommitOutcomeStatus::Conflict,
            rejections: current.status == CommitOutcomeStatus::Rejected,
            outcomes: true,
            ..ChangeAccumulator::default()
        };
        if let Some(operations) = &current.operations {
            for operation in operations {
                batch.table(&operation.table);
            }
        }
        if let Err(error) = self
            .rebuild_overlay_if_dirty()
            .and_then(|()| self.finish_observation("syncular_outcome_resolution", batch))
        {
            self.rollback_observation("syncular_outcome_resolution");
            self.failed_commits = previous_failed;
            self.conflicts = previous_conflicts;
            self.rejections = previous_rejections;
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
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query([])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut out = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        {
            let mut values = Map::new();
            for (i, column) in schema_table.columns.iter().enumerate() {
                let value = row
                    .get_ref(i)
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                values.insert(column.name.clone(), sql_ref_to_json(column, value));
            }
            let version: i64 = row
                .get(schema_table.columns.len())
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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
    // the op with `yrs`, re-encodes the whole doc state, and records a
    // baseVersion-less sparse upsert carrying only the primary key and the
    // crdt column (§5.10.3, §6.6). No local merge — merging is server-side;
    // the overlay re-materializes the edit immediately (optimistic apply,
    // §7.1) and the server-merged bytes arrive on the next pull, idempotently.
    // Byte-compatible with `@syncular/crdt-yjs`.

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
            "SELECT {} FROM {} WHERE {}",
            quote_ident(column),
            visible_table(table),
            row_id_predicate(schema_table)
        );
        let bytes: Option<Vec<u8>> = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
            .query_row(rusqlite::params![row_id], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => "no such row".to_owned(),
                other => Self::sqlite_failure(&self.storage_failure, other),
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

    /// §5.10.4 push-an-update: apply a text insert to a `crdt` column and
    /// record the resulting crdt-only sparse operation. Returns the enqueued
    /// `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_insert_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        value: &str,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let update = crate::crdt::insert_text(&current, name, index, value)?;
            self.perform_crdt_push_update(table, row_id, column, &update)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// §5.10.4 push-an-update: apply a text delete to a `crdt` column and
    /// record the resulting crdt-only sparse operation. Returns the enqueued
    /// `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_delete_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        len: u32,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let update = crate::crdt::delete_text(&current, name, index, len)?;
            self.perform_crdt_push_update(table, row_id, column, &update)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// §5.10.4 generic escape hatch: apply an arbitrary Yjs update onto a
    /// `crdt` column's current state and record the resulting crdt-only sparse
    /// operation. The app authored the update with its own `yrs` model.
    /// Returns the enqueued `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_apply_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        update: &[u8],
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let next = crate::crdt::apply_update(&current, update)?;
            self.perform_crdt_push_update(table, row_id, column, &next)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// Shared tail of the crdt edit methods: record a §6.1 sparse crdt-only
    /// upsert — the primary key plus the crdt column, no `baseVersion` — and
    /// enqueue it. The server merges the crdt column and leaves every other
    /// column untouched (§5.10.3), so a baseVersion-less crdt edit cannot
    /// clobber a concurrent edit to another column. A locally absent row
    /// records the same partial operation; the server answers per §6.2.
    #[cfg(feature = "crdt-yjs")]
    fn perform_crdt_push_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        crdt_bytes: &[u8],
    ) -> Result<String, String> {
        let mut bytes_obj = Map::new();
        bytes_obj.insert("$bytes".to_owned(), Value::from(bytes_to_hex(crdt_bytes)));
        let mut partial = Map::new();
        partial.insert(column.to_owned(), Value::Object(bytes_obj));
        self.perform_patch(table, row_id, partial, None)
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
    pub fn query(&self, sql: &str, params: &[QueryValue]) -> Result<Vec<QueryRow>, String> {
        query_connection(&self.conn, sql, params).map_err(|failure| failure.to_string())
    }

    /// Repository benchmark and conformance access, present only with `bench-internals`.
    #[cfg(feature = "bench-internals")]
    #[doc(hidden)]
    pub fn benchmark_connection(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Private benchmark intervals; absent from ordinary builds and diagnostics.
    #[cfg(feature = "bench-internals")]
    #[doc(hidden)]
    pub fn benchmark_phases(
        &self,
        enabled: Option<bool>,
        reset: bool,
    ) -> Result<Option<Value>, String> {
        self.benchmark_phases.configure(enabled, reset)?;
        Ok(self.benchmark_phases.snapshot())
    }

    /// One serialized, read-only authority observation, including durable coverage.
    pub fn authority_snapshot(&self) -> Result<Value, String> {
        validate_authority_reads(&self.schema, &self.limits.authority_reads)?;
        if self.limits.authority_reads.is_empty() {
            return Err("client.authority_read_forbidden: no authority reads were declared at client creation".into());
        }
        self.conn
            .execute_batch("SAVEPOINT authority_snapshot")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let revision = self
                .get_meta(LOCAL_REVISION_KEY)
                .ok_or("sync.local_corrupt: authority revision is missing")?;
            let parsed_revision = revision
                .parse::<u64>()
                .map_err(|_| "sync.local_corrupt: authority revision is invalid")?;
            if parsed_revision.to_string() != revision {
                return Err("sync.local_corrupt: authority revision is invalid".into());
            }
            let mut tables = Vec::new();
            for read in &self.limits.authority_reads {
                let table = self
                    .schema
                    .table(&read.table)
                    .ok_or("client.authority_read_forbidden: authority table is not declared")?;
                let scalar = |column: &str, value: &Value| -> Result<String, String> {
                    let ty = table
                        .columns
                        .iter()
                        .find(|c| c.name == column)
                        .expect("validated authority column")
                        .ty;
                    if ty == ColumnType::Boolean {
                        if let Some(value) = value.as_bool() {
                            return Ok(value.to_string());
                        }
                        return match value.as_i64() {
                            Some(0) => Ok("false".into()),
                            Some(1) => Ok("true".into()),
                            _ => Err("sync.local_corrupt: authority boolean is invalid".into()),
                        };
                    }
                    match value {
                        Value::String(s) => Ok(s.clone()),
                        Value::Number(n) => Ok(n.to_string()),
                        Value::Object(o) if ty == ColumnType::Integer && o.len() == 1 => o
                            .get("$bigint")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .ok_or("sync.local_corrupt: authority integer is invalid".into()),
                        _ => {
                            Err("sync.local_corrupt: authority scalar is missing or invalid".into())
                        }
                    }
                };
                let matches = |row: &QueryRow| -> Result<bool, String> {
                    for (variable, values) in &read.scopes {
                        let column = table
                            .scope_column(variable)
                            .expect("validated authority scope");
                        let value = row
                            .get(column)
                            .ok_or("sync.local_corrupt: authority scope column is missing")?;
                        if value.is_null() || !values.contains(&scalar(column, value)?) {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                };
                let selected = read
                    .columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(",");
                let mut intent = BTreeSet::new();
                let mut relevant = BTreeSet::new();
                for row in query_connection(&self.conn,
                    "SELECT id,values_json FROM (SELECT json_extract(value,'$.table') AS tbl,json_extract(value,'$.rowId') AS id,json_extract(value,'$.values') AS values_json FROM _syncular_outbox,json_each(ops_json) UNION ALL SELECT json_extract(value,'$.table'),json_extract(value,'$.rowId'),json_extract(value,'$.values') FROM _syncular_failed_commits,json_each(operations_json) UNION ALL SELECT tbl,id,intent_json FROM _syncular_acked_rows) WHERE tbl=?",
                    &[Value::String(read.table.clone())]).map_err(|e| e.to_string())? {
                    let id = row.get("id").and_then(Value::as_str).ok_or("sync.local_corrupt: authority intent id is invalid")?.to_owned();
                    intent.insert(id.clone());
                    if let Some(raw) = row.get("values_json").and_then(Value::as_str) {
                        let values: QueryRow = serde_json::from_str(raw).map_err(|_| "sync.local_corrupt: authority intent values are invalid")?;
                        if read.scopes.keys().all(|v| values.contains_key(table.scope_column(v).expect("validated scope"))) && matches(&values)? {relevant.insert(id);}
                    }
                }
                let mut rows = BTreeMap::new();
                for full in [base_table(&read.table), visible_table(&read.table)] {
                    for mut values in query_connection(
                        &self.conn,
                        &format!(
                            "SELECT {selected},_syncular_version AS authority_version FROM {full}"
                        ),
                        &[],
                    )
                    .map_err(|e| e.to_string())?
                    {
                        if !matches(&values)? {
                            continue;
                        }
                        let id = scalar(
                            &table.primary_key,
                            values
                                .get(&table.primary_key)
                                .expect("selected primary key"),
                        )?;
                        relevant.insert(id.clone());
                        if full == base_table(&read.table) {
                            let version = values
                                .remove("authority_version")
                                .expect("selected version");
                            let version = version
                                .as_i64()
                                .ok_or("sync.local_corrupt: authority server version is invalid")?;
                            if version >= 0 {
                                rows.insert(id.clone(), json!({"values": values, "version": version, "hasLocalIntent": intent.contains(&id)}));
                            }
                        }
                    }
                }
                intent.retain(|id| relevant.contains(id));
                let rows = rows.into_values().collect::<Vec<_>>();
                let mut persisted = Vec::new();
                for row in query_connection(
                    &self.conn,
                    "SELECT state_json FROM _syncular_subscriptions WHERE tbl=? ORDER BY rowid",
                    &[Value::String(read.table.clone())],
                )
                .map_err(|e| e.message)?
                {
                    let state: Value = serde_json::from_str(
                        row.get("state_json")
                            .and_then(Value::as_str)
                            .ok_or("sync.local_corrupt: authority subscription state is missing")?,
                    )
                    .map_err(|_| "sync.local_corrupt: authority subscription state is invalid")?;
                    let effective = state.get("effectiveScopes").and_then(Value::as_object);
                    let status = state
                        .get("status")
                        .and_then(Value::as_str)
                        .ok_or("sync.local_corrupt: authority subscription status is missing")?;
                    let cursor = state
                        .get("cursor")
                        .and_then(Value::as_i64)
                        .ok_or("sync.local_corrupt: authority subscription cursor is missing")?;
                    let complete = effective.is_some_and(|s| s.len() == read.scopes.len())
                        && status == "active"
                        && cursor >= 0
                        && state.get("bootstrapState").is_none_or(Value::is_null)
                        && state.get("params").is_none_or(Value::is_null);
                    let exposed = effective.map(|s| {
                        read.scopes
                            .keys()
                            .map(|v| (v.clone(), s.get(v).cloned().unwrap_or(json!([]))))
                            .collect::<Map<_, _>>()
                    });
                    let requested = read
                        .scopes
                        .keys()
                        .map(|v| {
                            (
                                v.clone(),
                                state
                                    .get("requested")
                                    .and_then(|s| s.get(v))
                                    .cloned()
                                    .unwrap_or(json!([])),
                            )
                        })
                        .collect::<Map<_, _>>();
                    persisted.push(json!({"requestedScopes": requested, "status": status, "cursor": cursor, "effectiveScopes": exposed, "complete": complete}));
                }
                fn covered(selectors: &[(&String, &Vec<String>)], candidates: &[&Value]) -> bool {
                    match selectors.split_first() {
                        None => !candidates.is_empty(),
                        Some(((variable, values), rest)) => values.iter().all(|value| {
                            covered(
                                rest,
                                &candidates
                                    .iter()
                                    .copied()
                                    .filter(|p| {
                                        p["effectiveScopes"][variable.as_str()]
                                            .as_array()
                                            .is_some_and(|held| {
                                                held.contains(&Value::String(value.clone()))
                                                    || held.contains(&Value::String("*".into()))
                                            })
                                    })
                                    .collect::<Vec<_>>(),
                            )
                        }),
                    }
                }
                let coverage = if covered(
                    &read.scopes.iter().collect::<Vec<_>>(),
                    &persisted
                        .iter()
                        .filter(|p| p["complete"] == true)
                        .collect::<Vec<_>>(),
                ) {
                    "complete"
                } else if persisted.iter().any(|p| {
                    p["status"] == "active"
                        && read.scopes.iter().all(|(v, values)| {
                            values.iter().any(|value| {
                                p["requestedScopes"][v].as_array().is_some_and(|held| {
                                    held.contains(&Value::String(value.clone()))
                                        || held.contains(&Value::String("*".into()))
                                })
                            })
                        })
                }) {
                    "pending"
                } else {
                    "missing"
                };
                tables.push(json!({"table": read.table, "rows": rows, "localIntentRowIds": intent, "scopes": read.scopes, "coverage": coverage, "persisted": persisted}));
            }
            Ok(
                json!({"revision": revision, "complete": tables.iter().all(|t| t["coverage"] == "complete"), "tables": tables}),
            )
        })();
        match result {
            Ok(snapshot) => {
                self.conn
                    .execute_batch("RELEASE authority_snapshot")
                    .map_err(|e| e.to_string())?;
                Ok(snapshot)
            }
            Err(error) => {
                self.conn
                    .execute_batch("ROLLBACK TO authority_snapshot; RELEASE authority_snapshot")
                    .map_err(|e| format!("{error}; rollback failed: {e}"))?;
                Err(error)
            }
        }
    }

    /// Rows, coverage, and local revision from one SQLite read snapshot.
    /// §7.5 atomic snapshot read. An `owner` records a failure in
    /// `diagnostics_snapshot().query_failures` until its next successful read.
    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[QueryValue],
        coverage: &[WindowCoverage],
        owner: Option<QueryOwner<'_>>,
    ) -> Result<QuerySnapshot, String> {
        let result = snapshot_connection(&self.conn, sql, params, coverage);
        if let Some(owner) = owner {
            self.record_query_read(owner, result.as_ref().err());
        }
        result.map_err(|failure| failure.to_string())
    }

    /// §7.6: record the outcome of one owned snapshot read, including reads a
    /// host ran on a separate connection. A success removes the owner's entry;
    /// an identical failure leaves it unchanged; a changed failure moves last.
    pub fn record_query_read(&mut self, owner: QueryOwner<'_>, failure: Option<&QueryReadFailure>) {
        let position = self
            .query_failures
            .iter()
            .position(|entry| entry.id == owner.id);
        let Some(failure) = failure else {
            if let Some(index) = position {
                self.query_failures.remove(index);
            }
            return;
        };
        let tables: Vec<String> = BTreeSet::from_iter(owner.tables.iter().copied())
            .into_iter()
            .map(str::to_owned)
            .collect();
        let code = failure.code.unwrap_or("client.query_failed").to_owned();
        if position.is_some_and(|index| {
            let entry = &self.query_failures[index];
            entry.tables == tables && entry.code == code && entry.sqlite_code == failure.sqlite_code
        }) {
            return;
        }
        if let Some(index) = position {
            self.query_failures.remove(index);
        }
        self.query_failures.push(DiagnosticQueryFailure {
            id: owner.id.to_owned(),
            tables,
            code,
            sqlite_code: failure.sqlite_code,
            at_ms: self.clock_now_ms(),
        });
        if self.query_failures.len() > MAX_DIAGNOSTIC_QUERY_FAILURES {
            self.query_failures.remove(0);
        }
    }

    // -- request building ---------------------------------------------------------

    fn build_request(&self, url_capable: bool) -> Result<(Message, RequestMeta), Box<SyncOutcome>> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::RequestPrepare);
        let log_epoch = self.get_meta(LOG_EPOCH_KEY);
        let max_commits = self.limits.max_push_commits_per_request;
        let max_ops = self
            .limits
            .max_push_operations_per_request
            .unwrap_or(PUSH_OPS_PER_REQUEST);
        let byte_cap = self.limits.max_push_request_bytes;
        // §4.2/§5.4: bit 3 is advertised iff the transport can fetch a
        // bare URL — capability negotiation, decided per transport.
        let accept = self.limits.accept.unwrap_or(if url_capable {
            DEFAULT_ACCEPT | ACCEPT_SIGNED_URLS
        } else {
            DEFAULT_ACCEPT
        });
        let header = Frame::ReqHeader {
            client_id: self.client_id.clone(),
            schema_version: self.schema.version,
            log_epoch: log_epoch.clone(),
        };
        let pull = Frame::PullHeader {
            limit_commits: self.limits.limit_commits.unwrap_or(0),
            limit_snapshot_rows: self.limits.limit_snapshot_rows.unwrap_or(0),
            max_snapshot_pages: self.limits.max_snapshot_pages.unwrap_or(0),
            accept,
        };
        let mut fresh = Vec::new();
        let mut sub_frames = Vec::new();
        for sub in &self.subs {
            if sub.state != SubState::Active {
                continue;
            }
            let mut scopes = sub.requested.clone();
            sort_scope_map(&mut scopes);
            sub_frames.push(Frame::Subscription {
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
        // The fixed frames (order-independent size) and the header+pull probe
        // both encode canonically, so the byte budget is the exact wire size.
        let fixed_bytes = match byte_cap {
            Some(_) => {
                let mut frames = vec![header.clone(), pull.clone()];
                frames.extend(sub_frames.iter().cloned());
                encode_message(&Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Request,
                    frames,
                })
                .len()
            }
            None => 0,
        };
        if let Some(cap) = byte_cap {
            if fixed_bytes > cap {
                return Err(Self::push_capacity_outcome("bytes", cap, fixed_bytes, None));
            }
        }
        let base_bytes = match byte_cap {
            Some(_) => encode_message(&Message {
                wire_version: WIRE_VERSION,
                msg_kind: MsgKind::Request,
                frames: vec![header.clone(), pull.clone()],
            })
            .len(),
            None => 0,
        };
        let total_outbox = if log_epoch.is_some() {
            self.outbox.len()
        } else {
            0
        };
        let mut push_frames: Vec<Frame> = Vec::new();
        let mut pushed_ids = Vec::new();
        let mut ops_in_request = 0usize;
        let mut bytes_in_request = 0usize;
        let mut deferred_commits = 0usize;
        #[cfg(feature = "bench-internals")]
        let outbox_phase = self.benchmark_phases.start(Phase::OutboxEncode);
        for (index, commit) in self.outbox.iter().take(total_outbox).enumerate() {
            // §6.1/§7.1: the commit-count and operation caps are hard. A
            // first commit over the operation cap is a typed capacity error
            // and stays queued; a later one defers with the complete suffix.
            if max_commits.is_some_and(|cap| push_frames.len() >= cap) {
                deferred_commits = total_outbox - index;
                break;
            }
            if ops_in_request + commit.ops.len() > max_ops {
                if push_frames.is_empty() {
                    return Err(Self::push_capacity_outcome(
                        "operations",
                        max_ops,
                        commit.ops.len(),
                        Some(commit.client_commit_id.as_str()),
                    ));
                }
                deferred_commits = total_outbox - index;
                break;
            }
            let operations = commit
                .ops
                .iter()
                .map(|op| {
                    let payload = op.values.as_ref().and_then(|values| {
                        let table = self.schema.table(&op.table)?;
                        // §0: outbox entries encode at send time with the
                        // current codec (validated at mutate()). §6.1: the
                        // values map's keys are the sparse presence set.
                        // §5.11: encrypted columns are encrypted here, with
                        // an absent key-id selector read from the stored row.
                        // `sync_inner` runs `drop_unencodable_outbox` first,
                        // so an encrypt failure cannot reach this encode; the
                        // author seam validated every other failure.
                        let fallback = self.stored_key_fallback(table, &op.row_id);
                        encode_sparse_row_json(
                            table,
                            &op.row_id,
                            values,
                            &self.encryption,
                            fallback.as_ref(),
                        )
                        .ok()
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
            let frame = Frame::PushCommit {
                client_commit_id: commit.client_commit_id.clone(),
                operations,
            };
            let frame_bytes = match byte_cap {
                Some(_) => {
                    encode_message(&Message {
                        wire_version: WIRE_VERSION,
                        msg_kind: MsgKind::Request,
                        frames: vec![header.clone(), frame.clone(), pull.clone()],
                    })
                    .len()
                        - base_bytes
                }
                None => 0,
            };
            // The head is always encoded so the caller can report the full
            // projected request size; a later commit defers once it no longer
            // fits.
            if let Some(cap) = byte_cap {
                if !push_frames.is_empty() && fixed_bytes + bytes_in_request + frame_bytes > cap {
                    deferred_commits = total_outbox - index;
                    break;
                }
            }
            push_frames.push(frame);
            pushed_ids.push(commit.client_commit_id.clone());
            ops_in_request += commit.ops.len();
            bytes_in_request += frame_bytes;
        }
        #[cfg(feature = "bench-internals")]
        drop(outbox_phase);
        if let Some(cap) = byte_cap {
            if fixed_bytes + bytes_in_request > cap {
                // The head alone does not fit this budget; the commit stays
                // queued and no transport round is attempted.
                let blocked = if push_frames.is_empty() {
                    None
                } else {
                    self.outbox.first().map(|c| c.client_commit_id.as_str())
                };
                return Err(Self::push_capacity_outcome(
                    "bytes",
                    cap,
                    fixed_bytes + bytes_in_request,
                    blocked,
                ));
            }
        }
        let mut frames = vec![header];
        frames.extend(push_frames);
        frames.push(pull);
        frames.extend(sub_frames);
        let message = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Request,
            frames,
        };
        Ok((
            message,
            RequestMeta {
                pushed_ids,
                fresh,
                accept,
                deferred_commits,
            },
        ))
    }

    /// §7.1: a configured push capacity limit cannot carry this request.
    fn push_capacity_outcome(
        kind: &str,
        limit: usize,
        size: usize,
        client_commit_id: Option<&str>,
    ) -> Box<SyncOutcome> {
        let mut details = Map::new();
        details.insert("kind".to_owned(), Value::from(kind));
        details.insert("limit".to_owned(), Value::from(limit as u64));
        details.insert("size".to_owned(), Value::from(size as u64));
        if let Some(id) = client_commit_id {
            details.insert("clientCommitId".to_owned(), Value::from(id));
        }
        Box::new(SyncOutcome::Failed {
            error_code: "client.push_request_too_large".into(),
            message: "the push request exceeds a configured capacity limit".into(),
            details: Some(Value::Object(details)),
        })
    }

    // -- sync -------------------------------------------------------------------

    /// Cloneable observation handle; no client lock is needed to read it.
    pub fn progress(&self) -> ProgressObserver {
        self.progress.clone()
    }

    pub fn sync(&mut self, transport: &mut dyn Transport) -> SyncOutcome {
        let prepared = match self.prepare_sync_round(transport.supports_url_fetch()) {
            Ok(prepared) => prepared,
            Err(outcome) => return *outcome,
        };
        let mut next = prepared;
        loop {
            match self.apply_sync_round(next.exchange(transport)) {
                crate::AppliedSyncRound::Continue(prepared) => next = prepared,
                crate::AppliedSyncRound::Complete {
                    outcome, controls, ..
                } => {
                    if self.transport_enabled {
                        for text in controls {
                            let _ = transport.realtime_send(&text);
                        }
                    } else {
                        self.disconnect_realtime(transport);
                    }
                    return outcome;
                }
            }
        }
    }

    fn finish_sync_round(&mut self, started_at_ms: i64, mut outcome: SyncOutcome) -> SyncOutcome {
        if let SyncOutcome::Failed {
            error_code,
            message,
            details,
        } = &mut outcome
        {
            if let Some(failure) = self.storage_failure.borrow().as_ref() {
                let code = failure
                    .code
                    .expect("retained storage failures are classified");
                *error_code = code.to_owned();
                *message = match code {
                    "client.storage_busy" => "local SQLite storage is busy",
                    "client.storage_full" => "local SQLite storage is full",
                    "client.storage_io" => "local SQLite storage I/O failed",
                    "client.storage_corrupt" => "local SQLite storage is corrupt",
                    _ => unreachable!("unrecognized classified storage failure"),
                }
                .to_owned();
                *details = failure.details();
            }
        }
        let retry_delay_ms = self.round_retry_delay_ms;
        self.progress.update(|p| match &outcome {
            SyncOutcome::Ok(report) | SyncOutcome::BudgetExhausted(report)
                if report.failed.is_empty() =>
            {
                p.state = ProgressState::Complete
            }
            SyncOutcome::Ok(_) | SyncOutcome::BudgetExhausted(_) => {
                p.state = ProgressState::Failed;
                p.error_code = Some("sync.scope_revoked".into());
            }
            SyncOutcome::Failed { error_code, .. } => {
                p.state = ProgressState::Failed;
                p.error_code = Some(Self::diagnostic_code(error_code));
                p.retry_delay_ms = retry_delay_ms;
            }
            SyncOutcome::RealtimeUnavailable { .. } => {
                p.state = ProgressState::Failed;
                p.error_code = Some(REALTIME_UNAVAILABLE_CODE.to_owned());
                p.retry_delay_ms = retry_delay_ms;
            }
        });
        let completed_at_ms = self.clock_now_ms();
        self.last_round = Some(match &outcome {
            SyncOutcome::Ok(report) | SyncOutcome::BudgetExhausted(report) => DiagnosticLastRound {
                status: "succeeded".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: Some(DiagnosticRoundCounters {
                    pushed: report.pushed,
                    applied: report.applied.len(),
                    rejected: report.rejected.len(),
                    retryable: report.retryable.len(),
                    conflicts: report.conflicts,
                    commits_applied: report.commits_applied,
                    segment_rows_applied: report.segment_rows_applied,
                    bootstrapping: report.bootstrapping.len(),
                    resets: report.resets.len(),
                    revoked: report.revoked.len(),
                    failed: report.failed.len(),
                    deferred_commits: report.deferred_commits,
                }),
                error_code: None,
            },
            SyncOutcome::Failed { error_code, .. } => DiagnosticLastRound {
                status: "failed".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: None,
                error_code: Some(Self::diagnostic_code(error_code)),
            },
            SyncOutcome::RealtimeUnavailable { .. } => DiagnosticLastRound {
                status: "failed".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: None,
                error_code: Some(REALTIME_UNAVAILABLE_CODE.to_owned()),
            },
        });
        outcome
    }

    /// Capture one request on the client owner. Mutations made after this
    /// call remain in the outbox for a later round; no network I/O occurs here.
    pub fn prepare_sync_round(
        &mut self,
        url_capable: bool,
    ) -> Result<crate::PreparedSyncRound, Box<SyncOutcome>> {
        if !self.transport_enabled {
            return Err(Box::new(SyncOutcome::Failed {
                error_code: "sync.offline".into(),
                message: "transport gate is closed".into(),
                details: None,
            }));
        }
        if self.active_round.is_some() {
            return Err(Box::new(SyncOutcome::Failed {
                error_code: "client.round_in_progress".into(),
                message: "a sync round is already in flight".into(),
                details: None,
            }));
        }
        self.storage_failure.borrow_mut().take();
        self.progress.start();
        self.round_retry_delay_ms = None;
        let started_at_ms = self.clock_now_ms();
        let prepared = (|| {
            if self.stopped {
                return Err(Box::new(SyncOutcome::Ok(SyncReport {
                    schema_floor: self.schema_floor.clone(),
                    ..SyncReport::default()
                })));
            }
            if self.security_preflight {
                return Err(Box::new(SyncOutcome::Failed {
                    error_code: SECURITY_PREFLIGHT_REQUIRED_CODE.into(),
                    message: "security preflight must complete before syncing".into(),
                    details: None,
                }));
            }
            self.set_sync_needed(false, false);
            self.drain_pending_evictions()
                .and_then(|_| self.drop_incompatible_outbox())
                .and_then(|_| self.drop_unencodable_outbox())
                .map_err(|message| {
                    Box::new(SyncOutcome::Failed {
                        error_code: "storage.failed".into(),
                        message,
                        details: None,
                    })
                })?;
            let uploads = if self.get_meta(LOG_EPOCH_KEY).is_some() && self.schema_has_blobs() {
                self.pending_blob_uploads().map_err(|e| {
                    Box::new(SyncOutcome::Failed {
                        error_code: e.code,
                        message: e.message,
                        details: e.details,
                    })
                })?
            } else {
                Vec::new()
            };
            if self.realtime_state != RealtimeState::Connected
                && self.realtime_policy == RealtimePolicy::Required
            {
                let retry_delay_ms = self.schedule_background_retry();
                self.realtime_retry_delay_ms = Some(retry_delay_ms);
                return Err(Box::new(SyncOutcome::RealtimeUnavailable {
                    state: self.realtime_state,
                    reason_code: self.realtime_reason_code.clone(),
                    retry_delay_ms,
                }));
            }
            let (message, meta) = self.build_request(url_capable)?;
            let id = uuid::Uuid::new_v4();
            self.active_round = Some(id);
            Ok(crate::PreparedSyncRound {
                id,
                started_at_ms,
                message,
                meta,
                uploads: uploads.into(),
                realtime: self.realtime_state == RealtimeState::Connected,
                scopes: self
                    .subs
                    .iter()
                    .map(|s| (s.id.clone(), canonical_scope_json(&s.requested)))
                    .collect(),
                #[cfg(feature = "bench-internals")]
                benchmark_phases: self.benchmark_phases.clone(),
                progress: self.progress.clone(),
                fixed_now: self.now_ms,
            })
        })();
        prepared.map_err(|outcome| Box::new(self.finish_sync_round(started_at_ms, *outcome)))
    }

    /// Discard the reply of an old authorization/subscription context. Its
    /// submitted commits stay durable and can be retried with the same ids.
    pub fn cancel_sync_round(&mut self) {
        self.active_round = None;
    }

    /// Apply captured network results on the owner, preserving all normal
    /// version, schema, content-address and cursor checks. No network I/O.
    pub fn apply_sync_round(
        &mut self,
        completed: crate::CompletedSyncRound,
    ) -> crate::AppliedSyncRound {
        let prepared = completed.prepared;
        if self.active_round != Some(prepared.id) || self.security_preflight {
            return crate::AppliedSyncRound::Complete {
                outcome: SyncOutcome::Failed {
                    error_code: "client.round_cancelled".into(),
                    message: "sync round belongs to a released client context".into(),
                    details: None,
                },
                controls: Vec::new(),
                more: false,
                bootstrap_advanced: false,
            };
        }
        self.storage_failure.borrow_mut().take();
        let (response, mut downloads, transport_failed) = match completed.exchange {
            crate::round::ExchangeResult::Upload { id, result } => {
                let result = result.and_then(|()| {
                    self.conn
                        .execute(
                            "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                            rusqlite::params![id],
                        )
                        .map(|_| ())
                        .map_err(|error| {
                            TransportError::new(
                                "client.failed",
                                Self::sqlite_failure(&self.storage_failure, error),
                            )
                        })
                });
                match result {
                    Ok(()) => return crate::AppliedSyncRound::Continue(prepared),
                    Err(TransportError {
                        code,
                        message,
                        details,
                    }) => {
                        self.active_round = None;
                        if Self::retryable_failure_code(&code) {
                            self.schedule_background_retry();
                        }
                        let outcome = self.finish_sync_round(
                            prepared.started_at_ms,
                            SyncOutcome::Failed {
                                error_code: code,
                                message,
                                details,
                            },
                        );
                        return crate::AppliedSyncRound::Complete {
                            outcome,
                            controls: Vec::new(),
                            more: false,
                            bootstrap_advanced: false,
                        };
                    }
                }
            }
            crate::round::ExchangeResult::Reply {
                response,
                downloads,
                transport_failed,
            } => (response, downloads, transport_failed),
        };
        self.active_round = None;
        let before = self
            .subs
            .iter()
            .map(|s| (s.id.clone(), s.bootstrap_state.clone()))
            .collect::<Vec<_>>();
        let outcome = (|| {
            let response = match response {
                Ok(response) => response,
                Err(TransportError {
                    code,
                    message,
                    details,
                }) => {
                    if transport_failed {
                        if prepared.realtime {
                            self.set_realtime_state(RealtimeState::Lost, Some(&code));
                        }
                        self.record_lease_error(&code);
                    }
                    if Self::retryable_failure_code(&code) {
                        let delay = self.schedule_background_retry();
                        if prepared.realtime && transport_failed {
                            self.realtime_retry_delay_ms = Some(delay);
                        }
                    }
                    return SyncOutcome::Failed {
                        error_code: code,
                        message,
                        details,
                    };
                }
            };
            let mut outcome = self.process_response(&mut downloads, response, &prepared.meta);
            if let SyncOutcome::Ok(report) = &mut outcome {
                report.deferred_commits = prepared.meta.deferred_commits;
            }
            match &outcome {
                SyncOutcome::Ok(_) => self.reset_background_retry(),
                SyncOutcome::Failed { error_code, .. }
                    if Self::retryable_failure_code(error_code) =>
                {
                    self.schedule_background_retry();
                }
                _ => {}
            }
            if prepared.meta.deferred_commits > 0 {
                self.set_sync_needed(true, true);
            }
            self.previous_version_lifetime_check();
            outcome
        })();
        let more = self.transport_enabled
            && matches!(&outcome, SyncOutcome::Ok(report)
                if report.schema_floor.is_none()
                    && (!report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty()
                        || report.deferred_commits > 0
                        || self.sync_needed));
        let bootstrap_advanced = matches!(&outcome, SyncOutcome::Ok(report) if report.segment_rows_applied > 0 && !report.bootstrapping.is_empty())
            && before
                != self
                    .subs
                    .iter()
                    .map(|s| (s.id.clone(), s.bootstrap_state.clone()))
                    .collect::<Vec<_>>();
        crate::AppliedSyncRound::Complete {
            outcome: self.finish_sync_round(prepared.started_at_ms, outcome),
            controls: if self.transport_enabled {
                downloads.controls
            } else {
                Vec::new()
            },
            more,
            bootstrap_advanced,
        }
    }

    pub fn sync_until_idle(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
    ) -> SyncOutcome {
        // §7.7: an explicit budget is a strict positive round count. Zero is a
        // caller error, not an exhaustion.
        if max_rounds == Some(0) {
            return SyncOutcome::Failed {
                details: None,
                error_code: "sync.invalid_request".into(),
                message: "maxRounds must be a positive integer".into(),
            };
        }
        let rounds = max_rounds.unwrap_or(20);
        let mut aggregate = SyncReport::default();
        let mut spent = 0;
        while spent < rounds {
            spent += 1;
            let before = self
                .subs
                .iter()
                .map(|sub| (sub.id.clone(), sub.bootstrap_state.clone()))
                .collect::<Vec<_>>();
            match self.sync(transport) {
                SyncOutcome::Failed {
                    error_code,
                    message,
                    details,
                } => {
                    return SyncOutcome::Failed {
                        details,
                        error_code,
                        message,
                    };
                }
                outcome @ SyncOutcome::RealtimeUnavailable { .. } => return outcome,
                SyncOutcome::BudgetExhausted(_) => {
                    unreachable!("sync() never exhausts a round budget")
                }
                SyncOutcome::Ok(report) => {
                    if max_rounds.is_none()
                        && report.segment_rows_applied > 0
                        && !report.bootstrapping.is_empty()
                        && before
                            != self
                                .subs
                                .iter()
                                .map(|sub| (sub.id.clone(), sub.bootstrap_state.clone()))
                                .collect::<Vec<_>>()
                    {
                        spent = 0;
                    }
                    // TS parity: a disabled transport or a schema floor ends
                    // the loop. The latest round still merges first.
                    let stop = !self.transport_enabled() || report.schema_floor.is_some();
                    aggregate.merge(&report);
                    if stop {
                        return SyncOutcome::Ok(aggregate);
                    }
                    // §4.5: pull again whenever the response contained
                    // commits or segments; resets re-bootstrap; a pending
                    // resume token continues paging (§4.7); deferred outbox
                    // commits and a raised sync-needed signal push on the next
                    // round.
                    let more = !report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty()
                        || report.deferred_commits > 0
                        || self.sync_needed;
                    if !more {
                        return SyncOutcome::Ok(aggregate);
                    }
                }
            }
        }
        // §7.7: partial success. The aggregate report is retained and the run
        // is explicitly not idle.
        SyncOutcome::BudgetExhausted(aggregate)
    }

    fn process_response(
        &mut self,
        transport: &mut dyn Transport,
        response: Message,
        meta: &RequestMeta,
    ) -> SyncOutcome {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ResponseApply);
        let mut report = SyncReport {
            pushed: meta.pushed_ids.len() as u32,
            ..SyncReport::default()
        };
        let mut rejection_details_by_commit: HashMap<String, BTreeMap<i32, RejectionDetails>> =
            HashMap::new();
        let pushed_ids = meta
            .pushed_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut last_final_push_result_id: Option<String> = None;
        for frame in &response.frames {
            match frame {
                Frame::PushResultDetails {
                    client_commit_id,
                    entries,
                } => {
                    let details = rejection_details_by_commit
                        .entry(client_commit_id.clone())
                        .or_default();
                    for entry in entries {
                        let parsed = match RejectionDetails::parse(&entry.details.0) {
                            Ok(value) => value,
                            Err(message) => {
                                return SyncOutcome::Failed {
                                    details: None,
                                    error_code: "sync.invalid_request".to_owned(),
                                    message,
                                };
                            }
                        };
                        details.insert(entry.op_index, parsed);
                    }
                }
                Frame::PushResult {
                    client_commit_id,
                    status,
                    results,
                    ..
                } if pushed_ids.contains(client_commit_id.as_str())
                    && Self::push_result_is_final(*status, results) =>
                {
                    last_final_push_result_id = Some(client_commit_id.clone());
                }
                _ => {}
            }
        }
        let mut frames = response.frames.into_iter().peekable();
        if response.wire_version < 2 {
            return SyncOutcome::Failed {
                details: None,
                error_code: "client.invalid_host_response".to_owned(),
                message: "server response does not carry wire version 2 log-epoch state".to_owned(),
            };
        }
        match frames.next() {
            Some(Frame::RespHeader {
                required_schema_version,
                latest_schema_version,
                log_epoch,
                reset_required,
            }) => {
                let Some(log_epoch) = log_epoch else {
                    return SyncOutcome::Failed {
                        details: None,
                        error_code: "client.invalid_host_response".to_owned(),
                        message: "response header omits logEpoch".to_owned(),
                    };
                };
                let Some(reset_required) = reset_required else {
                    return SyncOutcome::Failed {
                        details: None,
                        error_code: "client.invalid_host_response".to_owned(),
                        message: "response header omits resetRequired".to_owned(),
                    };
                };
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
                if reset_required {
                    if frames.next().is_some() {
                        return SyncOutcome::Failed {
                            details: None,
                            error_code: "client.invalid_host_response".to_owned(),
                            message: "log-epoch reset response contains body frames".to_owned(),
                        };
                    }
                    match self.run_log_epoch_reset(&log_epoch) {
                        Ok(resets) => {
                            report.resets = resets;
                            return SyncOutcome::Ok(report);
                        }
                        Err(message) => {
                            return SyncOutcome::Failed {
                                details: None,
                                error_code: "sync.local_corrupt".to_owned(),
                                message,
                            };
                        }
                    }
                }
                if self.get_meta(LOG_EPOCH_KEY).as_deref() != Some(log_epoch.as_str()) {
                    return SyncOutcome::Failed {
                        details: None,
                        error_code: "client.invalid_host_response".to_owned(),
                        message: "server changed logEpoch without requiring a reset".to_owned(),
                    };
                }
            }
            _ => {
                return SyncOutcome::Failed {
                    details: None,
                    error_code: "sync.invalid_request".to_owned(),
                    message: "response does not start with RESP_HEADER".to_owned(),
                };
            }
        }

        let mut failure: Option<(String, String)> = None;
        while let Some(frame) = frames.next() {
            match frame {
                frame @ Frame::PushResult { .. } => {
                    let successful = matches!(
                        &frame,
                        Frame::PushResult {
                            status: PushStatus::Applied | PushStatus::Cached,
                            ..
                        }
                    );
                    let mut results = vec![frame];
                    if successful {
                        while matches!(
                            frames.peek(),
                            Some(Frame::PushResult {
                                status: PushStatus::Applied | PushStatus::Cached,
                                ..
                            })
                        ) {
                            if let Some(next) = frames.next() {
                                results.push(next);
                            }
                        }
                    }
                    if self
                        .handle_push_results(
                            &results,
                            &pushed_ids,
                            &rejection_details_by_commit,
                            &mut report,
                            last_final_push_result_id.as_deref(),
                        )
                        .is_err()
                    {
                        failure = Some((
                            "client.outcome_persistence_failed".to_owned(),
                            "local commit outcome could not be persisted".to_owned(),
                        ));
                        break;
                    }
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
                    if let Err(SectionError::Abort(code, message)) = self.process_section(
                        transport,
                        &id,
                        status,
                        &reason_code,
                        effective_scopes,
                        body,
                        sub_end,
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

        if let Some((error_code, message)) = failure {
            return SyncOutcome::Failed {
                details: None,
                error_code,
                message,
            };
        }
        // Local apply boundaries already reconciled their affected overlay.
        // Refuse round success if any remaining dirty work fails to reconcile.
        if let Err(message) = self.rebuild_overlay_if_dirty() {
            return SyncOutcome::Failed {
                details: None,
                error_code: "storage.failed".into(),
                message,
            };
        }
        // §4.8 E1: the push half may have drained commits that pinned rows of
        // a shrunk window unit — retry any deferred evictions now.
        if let Err(message) = self.drain_pending_evictions() {
            return SyncOutcome::Failed {
                details: None,
                error_code: "storage.failed".into(),
                message,
            };
        }
        self.ack_after_pull(transport);
        // §7.4.5: the reset is over once the first post-reset pull round
        // leaves no subscription mid-bootstrap — the tables are rebuilt.
        if self.upgrading && report.bootstrapping.is_empty() {
            self.set_upgrading(false);
        }
        SyncOutcome::Ok(report)
    }

    // -- push results (§6.3, §7.2) ------------------------------------------------

    fn handle_push_results(
        &mut self,
        frames: &[Frame],
        pushed_ids: &HashSet<&str>,
        rejection_details_by_commit: &HashMap<String, BTreeMap<i32, RejectionDetails>>,
        report: &mut SyncReport,
        last_final_push_result_id: Option<&str>,
    ) -> Result<(), String> {
        self.begin_observation("syncular_push_results")?;
        let previous_failed = self.failed_commits.clone();
        let previous_sync_needed = self.sync_needed;
        let conflict_count = self.conflicts.len();
        let rejection_count = self.rejections.len();
        let applied_count = report.applied.len();
        let rejected_count = report.rejected.len();
        let retryable_count = report.retryable.len();
        let was_dirty = self.overlay_dirty.snapshot();
        let mut removed = Vec::new();
        let mut batch = ChangeAccumulator::default();
        let persisted = (|| {
            for frame in frames {
                let Frame::PushResult {
                    client_commit_id,
                    status,
                    results,
                    commit_seq,
                } = frame
                else {
                    return Err("unexpected acknowledgement frame".to_owned());
                };
                if !pushed_ids.contains(client_commit_id.as_str()) {
                    continue;
                }
                let Some(index) = self
                    .outbox
                    .iter()
                    .position(|commit| commit.client_commit_id == *client_commit_id)
                else {
                    continue;
                };
                let status = *status;
                let rejection_details = rejection_details_by_commit.get(client_commit_id);
                let operations = self.outbox[index].ops.clone();
                match status {
                    PushStatus::Applied | PushStatus::Cached => {
                        // §7.2: a lost ack replays as `cached` — proceed as if the
                        // ack had arrived.
                        let sequence =
                            commit_seq.ok_or_else(|| "ACK lacks a commit sequence".to_owned())?;
                        let affected: HashSet<_> = operations
                            .iter()
                            .map(|op| (op.table.as_str(), op.row_id.as_str()))
                            .collect();
                        let prior = self.acknowledged_operations(Some(&affected), None)?;
                        for (op_index, operation) in operations.iter().enumerate() {
                            let delivered: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM _syncular_row_deliveries WHERE tbl=?1 AND id=?2 AND commit_seq>=?3)", rusqlite::params![operation.table, operation.row_id, sequence], |row| row.get(0))
                                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                            if delivered {
                                continue;
                            }
                            let table = self
                                .schema
                                .table(&operation.table)
                                .ok_or_else(|| "sync.unknown_table".to_owned())?;
                            let mut intended: Map<String, Value> = self
                                .stored_row(table, &operation.row_id, true)?
                                .map(|(row, _)| {
                                    table
                                        .columns
                                        .iter()
                                        .zip(&row)
                                        .map(|(column, value)| {
                                            (column.name.clone(), column_value_to_json(value))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            let mut scope_image = intended.clone();
                            for op in prior
                                .iter()
                                .chain(
                                    self.failed_commits
                                        .iter()
                                        .flat_map(|(commit, _)| &commit.ops),
                                )
                                .chain(
                                    self.outbox
                                        .iter()
                                        .take(index)
                                        .flat_map(|commit| &commit.ops),
                                )
                                .chain(operations.iter().take(op_index + 1))
                            {
                                if op.table != operation.table || op.row_id != operation.row_id {
                                    continue;
                                }
                                if let Some(values) = &op.values {
                                    intended.extend(values.clone());
                                } else {
                                    scope_image = intended.clone();
                                    intended.clear();
                                }
                            }
                            self.conn.execute("INSERT INTO _syncular_acked_rows(commit_id,idx,tbl,id,commit_seq,op_json,intent_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                                rusqlite::params![client_commit_id, op_index as i64, operation.table, operation.row_id, sequence,
                                    serde_json::to_string(&CommitOperation::from(operation)).map_err(|_| "sync.local_corrupt".to_owned())?,
                                    serde_json::to_string(if operation.upsert { &intended } else { &scope_image }).map_err(|_| "sync.local_corrupt".to_owned())?])
                                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                        }
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
                        let persisted = self
                            .persist_commit_outcome(
                                client_commit_id,
                                outcome_status,
                                &journal_results,
                                None,
                            )
                            .and_then(|()| self.delete_outbox_persisted(client_commit_id));
                        persisted?;
                        for operation in &operations {
                            self.overlay_dirty.table(&operation.table);
                        }
                        self.sync_needed = true;
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
                            continue;
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
                                    conflict_columns: conflict_columns_bitmap,
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
                                                    column_value_to_json(
                                                        row.get(i).unwrap_or(&None),
                                                    ),
                                                );
                                            }
                                            map
                                        })
                                        .unwrap_or_default();
                                    // §6.3: decode the presence-layout bitmap
                                    // into the marked column names.
                                    let conflict_columns = self
                                        .schema
                                        .table(&table)
                                        .map(|t| {
                                            t.columns
                                                .iter()
                                                .enumerate()
                                                .filter(|(index, _)| {
                                                    conflict_columns_bitmap
                                                        .get(index / 8)
                                                        .is_some_and(|byte| {
                                                            byte & (1 << (index % 8)) != 0
                                                        })
                                                })
                                                .map(|(_, column)| column.name.clone())
                                                .collect::<Vec<_>>()
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
                                        conflict_columns,
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
                        if self.retain_failed_commits {
                            self.retain_failed_commit(client_commit_id, &operations)?;
                        }
                        let outcome_status = if conflicts.is_empty() {
                            CommitOutcomeStatus::Rejected
                        } else {
                            CommitOutcomeStatus::Conflict
                        };
                        let persisted = self
                            .persist_commit_outcome(
                                client_commit_id,
                                outcome_status,
                                &journal_results,
                                Some(&operations),
                            )
                            .and_then(|()| self.delete_outbox_persisted(client_commit_id));
                        persisted?;
                        batch.conflicts = !conflicts.is_empty();
                        batch.rejections = !rejections.is_empty();
                        batch.status = true;
                        batch.outcomes = true;
                        self.conflicts.extend(conflicts);
                        self.rejections.extend(rejections);
                        for operation in &operations {
                            self.overlay_dirty.table(&operation.table);
                        }
                    }
                }
                removed.push((index, self.outbox.remove(index)));
                if batch.status {
                    for operation in &operations {
                        if !self.record_row_scopes(
                            &mut batch,
                            &operation.table,
                            &operation.row_id,
                            false,
                        ) {
                            batch.table(&operation.table);
                        }
                    }
                }
                match status {
                    PushStatus::Applied | PushStatus::Cached => {
                        report.applied.push(client_commit_id.to_owned())
                    }
                    PushStatus::Rejected => report.rejected.push(client_commit_id.to_owned()),
                }
            }
            if batch.outcomes && frames.iter().any(|frame| matches!(frame, Frame::PushResult { client_commit_id, .. } if Some(client_commit_id.as_str()) == last_final_push_result_id)) {
                self.prune_commit_outcomes()?;
            }
            self.rebuild_overlay_if_dirty()?;
            self.finish_observation("syncular_push_results", batch)
        })();
        if let Err(error) = persisted {
            self.rollback_observation("syncular_push_results");
            self.failed_commits = previous_failed;
            self.sync_needed = previous_sync_needed;
            for (index, commit) in removed.into_iter().rev() {
                self.outbox.insert(index, commit);
            }
            self.conflicts.truncate(conflict_count);
            self.rejections.truncate(rejection_count);
            self.overlay_dirty.restore(was_dirty.clone());
            report.applied.truncate(applied_count);
            report.rejected.truncate(rejected_count);
            report.retryable.truncate(retryable_count);
            return Err(error);
        }
        if !previous_sync_needed && self.sync_needed {
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
        report.conflicts += (self.conflicts.len() - conflict_count) as u32;
        Ok(())
    }

    fn push_result_is_final(status: PushStatus, results: &[OpResult]) -> bool {
        status != PushStatus::Rejected
            || !results.iter().any(|result| {
                matches!(
                    result,
                    OpResult::Error {
                        code,
                        retryable: true,
                        ..
                    } if code == "sync.idempotency_cache_miss"
                )
            })
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
        sub_end: Option<(i64, Option<String>)>,
        meta: &RequestMeta,
        report: &mut SyncReport,
    ) -> Result<(), SectionError> {
        let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
            return Ok(()); // unknown echo: ignore
        };
        if status != SubStatus::Active && sub_end.is_none() {
            return Err(SectionError::Abort(
                "sync.invalid_request".into(),
                "subscription section without SUB_END".into(),
            ));
        }
        match status {
            SubStatus::Revoked => {
                self.begin_observation("syncular_revocation")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let previous = self.subs[sub_index].clone();
                let was_dirty = self.overlay_dirty.snapshot();
                let previous_outbox = self.outbox.clone();
                let previous_failed = self.failed_commits.clone();
                let previous_rejections = self.rejections.clone();
                let previous_conflicts = self.conflicts.clone();
                let revoked_count = report.revoked.len();
                let failed_count = report.failed.len();
                let result = (|| {
                    let mut batch = ChangeAccumulator::default();
                    let registered = self.window_unit_by_sub_id(id);
                    // §3.3: stop pulling, purge exactly the last effective grant.
                    let (table, effective) = {
                        let sub = &self.subs[sub_index];
                        (sub.table.clone(), sub.effective.clone().unwrap_or_default())
                    };
                    let scoped_table = self.schema.table(&table).cloned().ok_or_else(|| {
                        SectionError::Abort(
                            "sync.unknown_table".to_owned(),
                            "revoked scope references an unknown table".to_owned(),
                        )
                    })?;
                    let dropped = self
                        .drop_failed_commits(|name, values| {
                            name == table
                                && !effective.is_empty()
                                && effective.iter().all(|(variable, allowed)| {
                                    scoped_table
                                        .scope_column(variable)
                                        .and_then(|column| values.get(column))
                                        .and_then(Value::as_str)
                                        .is_some_and(|value| {
                                            allowed.iter().any(|allowed| allowed == value)
                                        })
                                })
                        })
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    for commit in dropped {
                        batch.conflicts = true;
                        batch.rejections = true;
                        batch.outcomes = true;
                        for operation in commit.ops {
                            batch.table(&operation.table);
                        }
                    }
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
                            self.persist_sub(&self.subs[sub_index].clone())
                                .map_err(|message| {
                                    SectionError::Abort("storage.failed".into(), message)
                                })?;
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
                            self.delete_unreferenced_cached_blobs().map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })?;
                        }
                        Err(()) => {
                            // §3.3 fail closed: no local mapping — never clear by
                            // approximation; fatal configuration error.
                            let sub = &mut self.subs[sub_index];
                            sub.state = SubState::Failed;
                            sub.reason_code = Some("sync.scope_revoked".to_owned());
                            report.failed.push(id.to_owned());
                            self.persist_sub(&self.subs[sub_index].clone())
                                .map_err(|message| {
                                    SectionError::Abort("storage.failed".into(), message)
                                })?;
                        }
                    }
                    if let Some((base_key, unit)) = registered {
                        batch.window(&base_key, &self.subs[sub_index].table, &unit);
                    }
                    self.rebuild_overlay_if_dirty()
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    self.finish_observation("syncular_revocation", batch)
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    Ok(())
                })();
                if result.is_err() {
                    self.rollback_observation("syncular_revocation");
                    self.subs[sub_index] = previous;
                    self.overlay_dirty.restore(was_dirty.clone());
                    self.outbox = previous_outbox;
                    self.failed_commits = previous_failed;
                    self.rejections = previous_rejections;
                    self.conflicts = previous_conflicts;
                    report.revoked.truncate(revoked_count);
                    report.failed.truncate(failed_count);
                }
                result
            }
            SubStatus::Reset => {
                self.begin_observation("syncular_reset")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let previous = self.subs[sub_index].clone();
                let was_dirty = self.overlay_dirty.snapshot();
                let reset_count = report.resets.len();
                let result = (|| {
                    let mut batch = ChangeAccumulator::default();
                    let registered = self.window_unit_by_sub_id(id);
                    // §4.6: discard cursor + bootstrap state, keep local rows —
                    // reset is a staleness signal, not a purge signal.
                    let sub = &mut self.subs[sub_index];
                    sub.cursor = -1;
                    sub.bootstrap_state = None;
                    report.resets.push(id.to_owned());
                    self.persist_sub(&self.subs[sub_index].clone())
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    if let Some((base_key, unit)) = registered {
                        batch.window(&base_key, &self.subs[sub_index].table, &unit);
                    }
                    self.finish_observation("syncular_reset", batch)
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    Ok(())
                })();
                if result.is_err() {
                    self.rollback_observation("syncular_reset");
                    self.subs[sub_index] = previous;
                    self.overlay_dirty.restore(was_dirty.clone());
                    report.resets.truncate(reset_count);
                }
                result
            }
            SubStatus::Active => {
                let fresh = meta
                    .fresh
                    .iter()
                    .find(|(fid, _)| fid == id)
                    .map(|(_, fresh)| *fresh)
                    .unwrap_or(false);
                let previous = self.subs[sub_index].clone();
                self.subs[sub_index].effective = Some(effective_scopes);
                let outcome = self
                    .apply_section_body(transport, sub_index, body, fresh, meta, report)
                    .and_then(|()| {
                        let (cursor, bootstrap_state) = sub_end.ok_or_else(|| {
                            SectionError::Abort(
                                "sync.invalid_request".into(),
                                "subscription section without SUB_END".into(),
                            )
                        })?;
                        self.apply_sub_end(sub_index, cursor, bootstrap_state)
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })
                    });
                match outcome {
                    Ok(()) => {
                        if self.subs[sub_index].bootstrap_state.is_some() {
                            report.bootstrapping.push(id.to_owned());
                        }
                        Ok(())
                    }
                    Err(SectionError::FailClosed) => {
                        self.subs[sub_index] = previous.clone();
                        self.begin_observation("syncular_section_failure")
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })?;
                        let persisted = (|| {
                            let mut batch = ChangeAccumulator::default();
                            if let Some((base_key, unit)) = self.window_unit_by_sub_id(id) {
                                batch.window(&base_key, &self.subs[sub_index].table, &unit);
                            }
                            self.subs[sub_index].state = SubState::Failed;
                            self.subs[sub_index].reason_code = Some("sync.scope_revoked".into());
                            self.persist_sub(&self.subs[sub_index])?;
                            self.finish_observation("syncular_section_failure", batch)
                        })();
                        if let Err(message) = persisted {
                            self.rollback_observation("syncular_section_failure");
                            self.subs[sub_index] = previous;
                            return Err(SectionError::Abort("storage.failed".into(), message));
                        }
                        report.failed.push(id.to_owned());
                        Ok(())
                    }
                    Err(error) => {
                        // Frame/block transactions already completed. Preserve their
                        // rows and revisions, but leave this subscription cursor unchanged.
                        self.subs[sub_index] = previous;
                        Err(error)
                    }
                }
            }
        }
    }

    fn apply_sub_end(
        &mut self,
        sub_index: usize,
        cursor: i64,
        bootstrap_state: Option<String>,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::CursorPersist);
        let previous = self.subs[sub_index].clone();
        self.begin_observation("syncular_sub_end")?;
        let persisted = (|| {
            let mut batch = ChangeAccumulator::default();
            let completed = (previous.cursor < 0 || previous.bootstrap_state.is_some())
                && cursor >= 0
                && bootstrap_state.is_none();
            if completed {
                let table = self
                    .schema
                    .table(&previous.table)
                    .ok_or_else(|| "sync.unknown_table".to_owned())?;
                let effective = previous.effective.as_deref().unwrap_or(&[]);
                let mut statement = self.conn.prepare("SELECT id,intent_json FROM _syncular_acked_rows WHERE tbl=?1 AND commit_seq<=?2")
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let rows = statement
                    .query_map(rusqlite::params![previous.table, cursor], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let mut covered = HashSet::new();
                for row in rows {
                    let (id, intent) =
                        row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                    let values: Map<String, Value> = serde_json::from_str(&intent)
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                    if !effective.is_empty()
                        && effective.iter().all(|(variable, allowed)| {
                            table
                                .scope_column(variable)
                                .and_then(|column| values.get(column))
                                .is_some_and(|value| {
                                    allowed.contains(
                                        &value
                                            .as_str()
                                            .map_or_else(|| value.to_string(), str::to_owned),
                                    )
                                })
                        })
                    {
                        covered.insert(id);
                    }
                }
                drop(statement);
                for id in covered {
                    self.conn.execute("DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2 AND commit_seq<=?3", rusqlite::params![previous.table, id, cursor])
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                    self.overlay_dirty.table(&previous.table);
                    batch.table(&previous.table);
                }
                self.rebuild_overlay_if_dirty()?;
                if let Some((base_key, unit)) = self.window_unit_by_sub_id(&previous.id) {
                    batch.window(&base_key, &previous.table, &unit);
                }
            }
            let sub = &mut self.subs[sub_index];
            sub.cursor = cursor;
            sub.bootstrap_state = bootstrap_state;
            sub.synced_once = true;
            self.persist_sub(&self.subs[sub_index])?;
            self.finish_observation("syncular_sub_end", batch)
        })();
        if persisted.is_err() {
            self.rollback_observation("syncular_sub_end");
            self.subs[sub_index] = previous;
        }
        persisted
    }

    fn apply_section_body(
        &mut self,
        transport: &mut dyn Transport,
        sub_index: usize,
        body: Vec<Frame>,
        fresh: bool,
        meta: &RequestMeta,
        report: &mut SyncReport,
    ) -> Result<(), SectionError> {
        let mut saw_segment = false;
        for frame in body {
            match frame {
                Frame::Commit {
                    tables,
                    changes,
                    commit_seq,
                    ..
                } => {
                    self.apply_commit_frame(&tables, &changes, Some(commit_seq))
                        .map_err(|(c, m)| SectionError::Abort(c, m))?;
                    report.commits_applied += 1;
                }
                Frame::SegmentInline { payload } => {
                    let segment = decode_rows_segment(&payload)
                        .map_err(|e| SectionError::Abort(e.code.as_str().to_owned(), e.detail))?;
                    self.progress.update(|p| {
                        p.phase = ProgressPhase::Import;
                        p.subscription_id = Some(self.subs[sub_index].id.clone());
                        p.table = Some(self.subs[sub_index].table.clone());
                        p.segment_id = None;
                        p.bytes_received = payload.len() as u64;
                        p.bytes_total = Some(payload.len() as u64);
                        p.rows_processed = 0;
                        p.rows_total =
                            Some(segment.blocks.iter().map(|block| block.len() as u64).sum());
                    });
                    let first = !saw_segment;
                    saw_segment = true;
                    let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                    report.segment_rows_applied += applied;
                }
                Frame::SegmentRef {
                    segment_id,
                    byte_length,
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
                    self.progress.update(|p| {
                        p.phase = ProgressPhase::Download;
                        p.subscription_id = Some(self.subs[sub_index].id.clone());
                        p.table = Some(table.clone());
                        p.segment_id = Some(segment_id.clone());
                        p.bytes_received = 0;
                        p.bytes_total = u64::try_from(byte_length).ok();
                        p.rows_processed = 0;
                        p.rows_total = u64::try_from(row_count).ok();
                    });
                    let observer = self.progress.clone();
                    let mut on_progress = |bytes| observer.update(|p| p.bytes_received = bytes);
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
                        if url_expires_at_ms.is_some_and(|exp| {
                            exp <= transport
                                .segment_fetch_started_at(&url)
                                .unwrap_or_else(|| self.clock_now_ms())
                        }) {
                            return Err(SectionError::Abort(
                                "sync.segment_expired".to_owned(),
                                format!(
                                    "signed URL for segment {segment_id} expired before fetch — re-pull mints fresh descriptors (§5.4)"
                                ),
                            ));
                        }
                        transport
                            .fetch_url(&url, &mut on_progress)
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    } else {
                        let requested_scopes_json =
                            canonical_scope_json(&self.subs[sub_index].requested);
                        transport
                            .download_segment(
                                &SegmentRequest {
                                    segment_id: segment_id.clone(),
                                    table,
                                    requested_scopes_json,
                                },
                                &mut on_progress,
                            )
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    };
                    // §5.1: verify the content address before applying.
                    on_progress(bytes.len() as u64);
                    let digest = Sha256::digest(&bytes);
                    let expected = segment_id
                        .strip_prefix("sha256:")
                        .unwrap_or(segment_id.as_str());
                    if bytes_to_hex(&digest) != expected {
                        // §5.1: the client discards the segment and re-pulls.
                        self.schedule_background_retry();
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "segment bytes do not match the content address (§5.1)".to_owned(),
                        ));
                    }
                    self.progress.update(|p| p.phase = ProgressPhase::Import);
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
                        let applied = self.apply_sqlite_segment(
                            sub_index,
                            &bytes,
                            fresh && first,
                            row_count,
                            as_of_commit_seq,
                            &scope_digest,
                        )?;
                        report.segment_rows_applied += applied;
                    } else {
                        let segment = decode_rows_segment(&bytes).map_err(|e| {
                            SectionError::Abort(e.code.as_str().to_owned(), e.detail)
                        })?;
                        let first = row_cursor.is_none();
                        saw_segment = true;
                        let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                        report.segment_rows_applied += applied;
                    }
                }
                Frame::Unknown { .. } => {}
                Frame::Error { code, message, .. } => {
                    return Err(SectionError::Abort(code, message))
                }
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

    // Both pull and realtime frames use the same durable observation boundary.
    fn apply_commit_frame(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
        commit_seq: Option<i64>,
    ) -> Result<(), (String, String)> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::CommitApply);
        let was_dirty = self.overlay_dirty.snapshot();
        self.begin_observation("syncular_commit")
            .map_err(|message| ("storage.failed".into(), message))?;
        let applied = (|| {
            let mut batch = ChangeAccumulator::default();
            self.record_commit_changes(&mut batch, tables, changes);
            if let Some(sequence) = commit_seq {
                for change in changes {
                    let table = tables.get(change.table_index as usize).ok_or_else(|| {
                        (
                            "sync.invalid_request".to_owned(),
                            "change tableIndex out of range".to_owned(),
                        )
                    })?;
                    if self
                        .outbox
                        .iter()
                        .flat_map(|commit| &commit.ops)
                        .any(|op| op.table == *table && op.row_id == change.row_id)
                    {
                        self.conn.execute("INSERT INTO _syncular_row_deliveries(tbl,id,commit_seq) VALUES (?1,?2,?3) ON CONFLICT(tbl,id) DO UPDATE SET commit_seq=MAX(commit_seq,excluded.commit_seq)", rusqlite::params![table, change.row_id, sequence])
                        .map_err(|error| ("storage.failed".to_owned(), Self::sqlite_failure(&self.storage_failure, error)))?;
                    }
                    self.conn.execute("DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2 AND commit_seq<=?3", rusqlite::params![table, change.row_id, sequence])
                        .map_err(|error| ("storage.failed".to_owned(), Self::sqlite_failure(&self.storage_failure, error)))?;
                }
            }
            self.apply_commit_changes(tables, changes)?;
            self.rebuild_overlay_if_dirty()
                .map_err(|message| ("storage.failed".into(), message))?;
            self.finish_observation("syncular_commit", batch)
                .map_err(|message| ("storage.failed".into(), message))
        })();
        if applied.is_err() {
            self.rollback_observation("syncular_commit");
            self.overlay_dirty.restore(was_dirty.clone());
        }
        applied
    }

    fn apply_commit_changes(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) -> Result<(), (String, String)> {
        // A clean overlay can reconcile changed primary keys independently
        // when their tables have no secondary unique constraints. Such a
        // constraint can change whether another row's pending write succeeds,
        // so those frames still require the complete FIFO replay below.
        let mirror_visible = !self.overlay_dirty.get()
            && self.failed_commits.is_empty()
            && ((self.outbox.is_empty() && !self.has_acknowledged_rows())
                || changes.iter().all(|change| {
                    tables
                        .get(change.table_index as usize)
                        .and_then(|name| self.schema.table(name))
                        .is_some_and(|table| !table.indexes.iter().any(|index| index.unique))
                }));
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
                    let row = {
                        #[cfg(feature = "bench-internals")]
                        let _phase = self.benchmark_phases.start(Phase::RowDecode);
                        decode_row_bytes(table, payload, &self.encryption)
                            .map_err(|m| ("sync.invalid_request".to_owned(), m))?
                    };
                    let version = change.row_version.unwrap_or(0);
                    let table_name = table.name.clone();
                    self.write_base_row(&table_name, &row, version)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    if mirror_visible {
                        self.write_row(&visible_table(&table_name), &table_name, &row, version)
                            .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    }
                }
                Op::Delete => {
                    self.delete_base_row(table_name, &change.row_id)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    if mirror_visible {
                        let sql = format!(
                            "DELETE FROM {} WHERE {}",
                            visible_table(table_name),
                            row_id_predicate(table)
                        );
                        self.conn
                            .prepare_cached(&sql)
                            .and_then(|mut statement| {
                                statement.execute(rusqlite::params![change.row_id])
                            })
                            .map_err(|error| {
                                ("sync.invalid_request".to_owned(), error.to_string())
                            })?;
                    }
                }
            }
        }
        if mirror_visible {
            {
                let changed_rows: HashSet<(&str, &str)> = changes
                    .iter()
                    .map(|change| {
                        (
                            tables[change.table_index as usize].as_str(),
                            change.row_id.as_str(),
                        )
                    })
                    .collect();
                let acknowledged = self
                    .acknowledged_operations(Some(&changed_rows), None)
                    .map_err(|error| ("storage.failed".to_owned(), error))?;
                self.apply_outbox_ops(&acknowledged)
                    .map_err(|message| ("storage.failed".into(), message))?;
                self.apply_outbox_ops(
                    self.outbox
                        .iter()
                        .flat_map(|commit| &commit.ops)
                        .filter(|op| {
                            changed_rows.contains(&(op.table.as_str(), op.row_id.as_str()))
                        }),
                )
                .map_err(|message| ("storage.failed".into(), message))?;
            }
            self.overlay_dirty.set(false);
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
        let mut applied = 0u32;
        let empty = Vec::new();
        let blocks = if segment.blocks.is_empty() {
            std::slice::from_ref(&empty)
        } else {
            &segment.blocks
        };
        for (index, block) in blocks.iter().enumerate() {
            let clear = first_fresh_page && index == 0;
            if !clear && block.is_empty() {
                continue;
            }
            let was_dirty = self.overlay_dirty.snapshot();
            let reconcile_pending = table.indexes.iter().any(|index| index.unique)
                && self
                    .outbox
                    .iter()
                    .flat_map(|commit| &commit.ops)
                    .any(|op| op.table == table.name);
            let mirror_visible = !reconcile_pending
                && (self.failed_commits.is_empty() && !self.has_acknowledged_rows());
            self.begin_observation("syncular_segment_block")
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let outcome = (|| {
                self.rebuild_overlay_if_dirty()
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                let mut changed_keys = Vec::new();
                let mut batch = ChangeAccumulator::default();
                if !block.is_empty() || (clear && self.scoped_rows_exist(&table.name, &effective)) {
                    batch.table(&table.name);
                }
                if clear {
                    self.purge_scope_rows(&table.name, &effective)
                        .map_err(|()| SectionError::FailClosed)?;
                }
                for (row_index, row) in block.iter().enumerate() {
                    let decrypted;
                    let values = if table.has_encrypted_columns() {
                        let mut values = row.values.clone();
                        crate::values::decrypt_segment_row(&table, &mut values, &self.encryption)
                            .map_err(|message| {
                            SectionError::Abort("client.decrypt_failed".into(), message)
                        })?;
                        decrypted = values;
                        &decrypted
                    } else {
                        &row.values
                    };
                    self.write_base_row(&table.name, values, row.server_version)
                        .map_err(|message| {
                            SectionError::Abort("sync.invalid_request".into(), message)
                        })?;
                    if reconcile_pending {
                        changed_keys.push(
                            owned_sql_value(RowParam::Cell(&values[table.pk_index])).map_err(
                                |message| SectionError::Abort("storage.failed".into(), message),
                            )?,
                        );
                    }
                    if mirror_visible {
                        self.write_row(
                            &visible_table(&table.name),
                            &table.name,
                            values,
                            row.server_version,
                        )
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    }
                    let processed = u64::from(applied) + row_index as u64 + 1;
                    if processed.is_multiple_of(1024) {
                        self.progress.update(|p| p.rows_processed = processed);
                    }
                }
                if reconcile_pending {
                    self.reconcile_imported_rows(&table, &mut changed_keys)
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                }
                if self.failed_commits.is_empty() && !self.has_acknowledged_rows() {
                    self.apply_outbox_ops(
                        self.outbox
                            .iter()
                            .flat_map(|commit| &commit.ops)
                            .filter(|op| op.table == table.name),
                    )
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    self.overlay_dirty.set(false);
                } else {
                    self.rebuild_overlay_if_dirty()
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                }
                self.finish_observation("syncular_segment_block", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))
            })();
            if let Err(error) = outcome {
                self.rollback_observation("syncular_segment_block");
                self.overlay_dirty.restore(was_dirty.clone());
                return Err(error);
            }
            applied += block.len() as u32;
            self.progress
                .update(|p| p.rows_processed = u64::from(applied));
            std::thread::yield_now();
        }
        self.progress
            .update(|p| p.rows_processed = u64::from(applied));
        Ok(applied)
    }

    /// §5.3 sqlite-image application: validate the in-file metadata
    /// against the descriptor, validate column names/order against the
    /// generated schema, run the §5.6 first-page clear when fresh, then
    /// replace-or-upsert every image row with its `_syncular_version`.
    /// Mechanics: the image lands in a temp file read through a second
    /// rusqlite connection, equivalent to ATTACH + INSERT…SELECT.
    /// Each image chunk commits its writes and revision before readers continue.
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
        let mut primary_keys: Vec<String> = Vec::new();
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
                if row
                    .get::<_, i64>(5)
                    .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?
                    > 0
                {
                    primary_keys.push(row.get(1).map_err(|error| {
                        invalid(Self::sqlite_failure(&self.storage_failure, error))
                    })?);
                }
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

        if primary_keys != vec![table.primary_key.clone()] {
            return Err(invalid(
                "image primary key does not match generated schema".into(),
            ));
        }
        let actual_count: i64 = img
            .query_row(
                &format!("SELECT count(*) FROM {}", quote_ident(&table.name)),
                [],
                |row| row.get(0),
            )
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        if actual_count != row_count {
            return Err(invalid("image row count does not match descriptor".into()));
        }
        let insert = self.insert_row_sql(&base_table(&table.name), table);
        let visible_insert = self.insert_row_sql(&visible_table(&table.name), table);
        let column_list = names
            .iter()
            .map(|n| quote_ident(n))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = img
            .prepare(&format!(
                "SELECT {column_list} FROM {} ORDER BY {}",
                quote_ident(&table.name),
                quote_ident(&table.primary_key)
            ))
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        let mut rows = stmt
            .query([])
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        let mut applied = 0u32;
        loop {
            let clear = applied == 0 && first_fresh_page;
            let was_dirty = self.overlay_dirty.snapshot();
            let reconcile_pending = table.indexes.iter().any(|index| index.unique)
                && self
                    .outbox
                    .iter()
                    .flat_map(|commit| &commit.ops)
                    .any(|op| op.table == table.name);
            let mirror_visible = !reconcile_pending
                && (self.failed_commits.is_empty() && !self.has_acknowledged_rows());
            self.begin_observation("syncular_image_chunk")
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let result = (|| {
                self.rebuild_overlay_if_dirty()
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                let mut changed_keys = Vec::new();
                let mut batch = ChangeAccumulator::default();
                if clear {
                    if self.scoped_rows_exist(&table.name, effective) {
                        batch.table(&table.name);
                    }
                    self.purge_scope_rows(&table.name, effective)
                        .map_err(|()| SectionError::FailClosed)?;
                }
                let mut processed = 0u32;
                {
                    let mut ins = self.conn.prepare_cached(&insert).map_err(|error| {
                        invalid(Self::sqlite_failure(&self.storage_failure, error))
                    })?;
                    let mut mirror = if mirror_visible {
                        Some(self.conn.prepare_cached(&visible_insert).map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?)
                    } else {
                        None
                    };
                    for _ in 0..1024 {
                        let Some(row) = rows.next().map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?
                        else {
                            break;
                        };
                        for (i, column) in table.columns.iter().enumerate() {
                            let cell = row.get_ref(i).map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                            let param = image_cell_param(column, cell).map_err(invalid)?;
                            ins.raw_bind_parameter(i + 1, &param).map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                            if let Some(mirror) = &mut mirror {
                                mirror.raw_bind_parameter(i + 1, &param).map_err(|error| {
                                    invalid(Self::sqlite_failure(&self.storage_failure, error))
                                })?;
                            }
                        }
                        let version_index = table.columns.len();
                        let version: i64 = row.get(version_index).map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?;
                        if version < 1 {
                            return Err(invalid("image row version must be positive".into()));
                        }
                        ins.raw_bind_parameter(version_index + 1, version)
                            .map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                        ins.raw_execute().map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?;
                        if let Some(mirror) = &mut mirror {
                            mirror
                                .raw_bind_parameter(version_index + 1, version)
                                .map_err(|error| {
                                    invalid(Self::sqlite_failure(&self.storage_failure, error))
                                })?;
                            mirror.raw_execute().map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                        }
                        if reconcile_pending {
                            changed_keys.push(row.get::<_, SqlValue>(table.pk_index).map_err(
                                |error| invalid(Self::sqlite_failure(&self.storage_failure, error)),
                            )?);
                        }
                        processed += 1;
                    }
                }
                if processed > 0 {
                    batch.table(&table.name);
                    self.overlay_dirty.table(&table.name);
                }
                if reconcile_pending {
                    self.reconcile_imported_rows(table, &mut changed_keys)
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                }
                if self.failed_commits.is_empty() && !self.has_acknowledged_rows() {
                    self.apply_outbox_ops(
                        self.outbox
                            .iter()
                            .flat_map(|commit| &commit.ops)
                            .filter(|op| op.table == table.name),
                    )
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    self.overlay_dirty.set(false);
                } else {
                    self.rebuild_overlay_if_dirty()
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                }
                self.finish_observation("syncular_image_chunk", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                Ok(processed)
            })();
            let processed = match result {
                Ok(processed) => processed,
                Err(error) => {
                    self.rollback_observation("syncular_image_chunk");
                    self.overlay_dirty.restore(was_dirty.clone());
                    return Err(error);
                }
            };
            applied += processed;
            self.progress
                .update(|p| p.rows_processed = u64::from(applied));
            std::thread::yield_now();
            if i64::from(applied) == actual_count {
                break;
            }
        }
        Ok(applied)
    }

    /// Restore only imported and pending row identities before FIFO replay. All pending
    /// identities participate: a server row can free a unique value for a different edit.
    /// The caller owns the chunk transaction and publishes its revision after replay.
    fn reconcile_imported_rows(
        &self,
        table: &TableSchema,
        keys: &mut Vec<SqlValue>,
    ) -> Result<(), String> {
        let visible = visible_table(&table.name);
        let base = base_table(&table.name);
        let pk = quote_ident(&table.primary_key);
        let predicate = row_id_predicate(table);
        let mut lookup = self.conn.prepare_cached(&format!(
            "SELECT {pk} FROM {base} WHERE {predicate} UNION SELECT {pk} FROM {visible} WHERE {predicate}"
        )).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut deleted = HashSet::new();
        for op in self
            .outbox
            .iter()
            .flat_map(|commit| &commit.ops)
            .filter(|op| op.table == table.name)
        {
            if op.upsert {
                if let Some(values) = &op.values {
                    let key = json_to_column_value(
                        &table.columns[table.pk_index],
                        values.get(&table.primary_key),
                    )?;
                    keys.push(owned_sql_value(RowParam::Cell(&key))?);
                }
            } else if deleted.insert(&op.row_id) {
                keys.extend(
                    lookup
                        .query_map([&op.row_id], |row| row.get::<_, SqlValue>(0))
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
                );
            }
        }
        // Delete the complete affected set before restoring any base value, so
        // old optimistic unique values cannot collide with the new server rows.
        for chunk in keys.chunks(400) {
            let holes = vec!["?"; chunk.len()].join(",");
            self.conn
                .prepare_cached(&format!("DELETE FROM {visible} WHERE {pk} IN ({holes})"))
                .and_then(|mut statement| statement.execute(rusqlite::params_from_iter(chunk)))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        let updates = table
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .chain(std::iter::once("_syncular_version"))
            .filter(|name| *name != table.primary_key)
            .map(|name| {
                let name = quote_ident(name);
                format!("{name}=excluded.{name}")
            })
            .collect::<Vec<_>>()
            .join(",");
        for chunk in keys.chunks(400) {
            let holes = vec!["?"; chunk.len()].join(",");
            self.conn.prepare_cached(&format!("INSERT INTO {visible} SELECT * FROM {base} WHERE {pk} IN ({holes}) ON CONFLICT ({pk}) DO UPDATE SET {updates}"))
                .and_then(|mut statement| statement.execute(rusqlite::params_from_iter(chunk)))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(())
    }

    // -- application-authorized local purge ---------------------------------------

    fn compile_local_data_purge(
        &self,
        input: &LocalDataPurgeInput,
    ) -> Result<(Vec<CompiledLocalDataPurgeTarget>, String), String> {
        let invalid = |message: String| format!("sync.invalid_request: {message}");
        if input.purge_id.is_empty()
            || input.purge_id.len() > 128
            || !is_local_operation_code_like(&input.purge_id)
        {
            return Err(invalid(
                "local purge purgeId must be a 1–128 character code-like identifier".to_owned(),
            ));
        }
        if input.targets.is_empty() || input.targets.len() > MAX_LOCAL_PURGE_TARGETS {
            return Err(invalid(format!(
                "local purge needs between 1 and {MAX_LOCAL_PURGE_TARGETS} targets"
            )));
        }

        let mut deduplicated: BTreeMap<
            String,
            (CompiledLocalDataPurgeTarget, LocalDataPurgeTarget),
        > = BTreeMap::new();
        for target in &input.targets {
            let table = self.schema.table(&target.table).ok_or_else(|| {
                invalid(format!(
                    "local purge names unknown table {:?}",
                    target.table
                ))
            })?;
            if target.selectors.is_empty() || target.selectors.len() > MAX_LOCAL_PURGE_SELECTORS {
                return Err(invalid(format!(
                    "local purge target {:?} needs between 1 and {MAX_LOCAL_PURGE_SELECTORS} selectors",
                    target.table
                )));
            }
            let mut selectors = Vec::with_capacity(target.selectors.len());
            let mut canonical_selectors = BTreeMap::new();
            for (column_name, raw_values) in &target.selectors {
                let Some((column_index, column)) = table
                    .columns
                    .iter()
                    .enumerate()
                    .find(|(_, column)| column.name == *column_name)
                else {
                    return Err(invalid(format!(
                        "local purge target {:?} names unknown column {:?}",
                        target.table, column_name
                    )));
                };
                let encrypted = table
                    .encrypted_columns
                    .iter()
                    .any(|candidate| candidate.index == column_index);
                if column.ty != ColumnType::String || encrypted {
                    return Err(invalid(format!(
                        "local purge selector {:?}.{:?} must be a plaintext string column",
                        target.table, column_name
                    )));
                }
                if raw_values.is_empty() || raw_values.len() > MAX_LOCAL_PURGE_VALUES {
                    return Err(invalid(format!(
                        "local purge selector {:?}.{:?} needs between 1 and {MAX_LOCAL_PURGE_VALUES} values",
                        target.table, column_name
                    )));
                }
                let mut values = raw_values.clone();
                values.sort();
                values.dedup();
                if values.iter().any(|value| {
                    value.is_empty()
                        || value.len() > MAX_LOCAL_PURGE_VALUE_LENGTH
                        || !is_local_operation_code_like(value)
                }) {
                    return Err(invalid(format!(
                        "local purge selector values must be 1–{MAX_LOCAL_PURGE_VALUE_LENGTH} character code-like identifiers"
                    )));
                }
                selectors.push((column_name.clone(), values.clone()));
                canonical_selectors.insert(column_name.clone(), values);
            }
            let canonical = LocalDataPurgeTarget {
                table: target.table.clone(),
                selectors: canonical_selectors,
            };
            let key = serde_json::to_string(&canonical).map_err(|error| error.to_string())?;
            deduplicated.insert(
                key,
                (
                    CompiledLocalDataPurgeTarget {
                        table: target.table.clone(),
                        selectors,
                    },
                    canonical,
                ),
            );
        }
        let targets = deduplicated
            .values()
            .map(|(compiled, _)| compiled.clone())
            .collect::<Vec<_>>();
        let canonical = deduplicated
            .values()
            .map(|(_, target)| target.clone())
            .collect::<Vec<_>>();
        let canonical_plan =
            serde_json::to_string(&canonical).map_err(|error| error.to_string())?;
        Ok((targets, canonical_plan))
    }

    fn local_purge_base_row_ids(
        &self,
        targets: &[CompiledLocalDataPurgeTarget],
    ) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
        let mut by_table: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for target in targets {
            let table = self
                .schema
                .table(&target.table)
                .ok_or_else(|| format!("sync.invalid_request: unknown table {:?}", target.table))?;
            let mut clauses = Vec::with_capacity(target.selectors.len());
            let mut params = Vec::new();
            for (column, values) in &target.selectors {
                clauses.push(format!(
                    "{} IN ({})",
                    quote_ident(column),
                    values.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
                ));
                params.extend(values.iter().cloned().map(SqlValue::Text));
            }
            let sql = format!(
                "SELECT CAST({} AS TEXT) FROM {} WHERE {}",
                quote_ident(&table.primary_key),
                base_table(&target.table),
                clauses.join(" AND ")
            );
            let mut statement = self
                .conn
                .prepare(&sql)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(params), |row| {
                    let value = sql_ref_to_json(&table.columns[table.pk_index], row.get_ref(0)?);
                    render_row_id_json(Some(&value))
                        .map_err(|message| rusqlite::Error::ToSqlConversionFailure(message.into()))
                })
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let ids = by_table.entry(target.table.clone()).or_default();
            for row in rows {
                ids.insert(
                    row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
                );
            }
        }
        Ok(by_table)
    }

    fn local_purge_values_match(
        target: &CompiledLocalDataPurgeTarget,
        values: &Map<String, Value>,
    ) -> bool {
        target.selectors.iter().all(|(column, allowed)| {
            values
                .get(column)
                .and_then(Value::as_str)
                .is_some_and(|value| allowed.iter().any(|candidate| candidate == value))
        })
    }

    /// Apply one host-authorized local security purge. The host MUST gate the
    /// corresponding subscriptions first; this primitive owns local SQLite
    /// cleanup and never grants/revokes server authority by itself.
    pub fn purge_local_data(
        &mut self,
        input: &LocalDataPurgeInput,
    ) -> Result<LocalDataPurgeResult, String> {
        let (targets, canonical_plan) = self.compile_local_data_purge(input)?;
        let meta_key = format!("localPurge:{}", input.purge_id);
        let applied_plan = self
            .conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![meta_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        if let Some(applied_plan) = applied_plan {
            if applied_plan != canonical_plan {
                return Err(format!(
                    "sync.invalid_request: local purge id {:?} was already used with a different plan",
                    input.purge_id
                ));
            }
            return Ok(LocalDataPurgeResult {
                already_applied: true,
                purged_rows: 0,
                dropped_commits: 0,
            });
        }

        // RFC 0005 D7: the container file cannot be a purge target (its name is
        // not in the running schema), so purge drops it as a fixed step, before
        // any mirror row is touched and unconditionally.
        let _ = self.drop_previous_version();

        let prior_outbox = self.outbox.clone();
        let prior_failed = self.failed_commits.clone();
        let prior_rejections = self.rejections.clone();
        let prior_conflicts = self.conflicts.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        self.begin_observation("syncular_local_purge")?;
        let applied = (|| -> Result<(ChangeAccumulator, LocalDataPurgeResult), String> {
            let row_ids = self.local_purge_base_row_ids(&targets)?;
            let retained_dropped = self.drop_failed_commits(|table, values| {
                targets.iter().any(|target| {
                    target.table == table && Self::local_purge_values_match(target, values)
                })
            })?;
            let doomed = self
                .outbox
                .iter()
                .filter(|commit| {
                    commit.ops.iter().any(|operation| {
                        let matching_targets = targets
                            .iter()
                            .filter(|target| target.table == operation.table)
                            .collect::<Vec<_>>();
                        if matching_targets.is_empty() {
                            return false;
                        }
                        if row_ids
                            .get(&operation.table)
                            .is_some_and(|ids| ids.contains(&operation.row_id))
                        {
                            return true;
                        }
                        operation.values.as_ref().is_some_and(|values| {
                            matching_targets
                                .iter()
                                .any(|target| Self::local_purge_values_match(target, values))
                        })
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            let doomed_ids = doomed
                .iter()
                .map(|commit| commit.client_commit_id.clone())
                .collect::<BTreeSet<_>>();
            let mut batch = ChangeAccumulator::default();
            for commit in &retained_dropped {
                batch.conflicts = true;
                batch.rejections = true;
                batch.outcomes = true;
                for operation in &commit.ops {
                    batch.table(&operation.table);
                }
            }
            let mut rejections = Vec::new();
            for commit in &doomed {
                for operation in &commit.ops {
                    batch.table(&operation.table);
                }
                let results = commit
                    .ops
                    .iter()
                    .enumerate()
                    .map(|(op_index, operation)| {
                        let rejection = RejectionRecord {
                            client_commit_id: commit.client_commit_id.clone(),
                            op_index: op_index as i32,
                            code: "client.local_data_purged".to_owned(),
                            message: "the commit was dropped by an application-authorized local data purge".to_owned(),
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
            if !doomed.is_empty() {
                self.outbox
                    .retain(|commit| !doomed_ids.contains(&commit.client_commit_id));
                self.rejections.extend(rejections);
                self.prune_commit_outcomes()?;
                batch.status = true;
                batch.rejections = true;
                batch.outcomes = true;
            }

            let mut purged_rows = 0usize;
            for (table, ids) in &row_ids {
                if ids.is_empty() {
                    continue;
                }
                batch.table(table);
                for row_id in ids {
                    self.delete_base_row(table, row_id)?;
                    purged_rows += 1;
                }
            }
            self.rebuild_overlay_if_dirty()?;
            self.delete_unreferenced_cached_blobs()?;
            self.conn
                .execute(
                    "INSERT INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                    rusqlite::params![meta_key, canonical_plan],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            Ok((
                batch,
                LocalDataPurgeResult {
                    already_applied: false,
                    purged_rows,
                    dropped_commits: doomed.len(),
                },
            ))
        })();
        let (batch, result) = match applied {
            Ok(value) => value,
            Err(error) => {
                self.rollback_observation("syncular_local_purge");
                self.outbox = prior_outbox;
                self.failed_commits = prior_failed;
                self.rejections = prior_rejections;
                self.conflicts = prior_conflicts;
                self.overlay_dirty.restore(prior_overlay_dirty.clone());
                return Err(error);
            }
        };
        if let Err(error) = self.finish_observation("syncular_local_purge", batch) {
            self.rollback_observation("syncular_local_purge");
            self.outbox = prior_outbox;
            self.failed_commits = prior_failed;
            self.rejections = prior_rejections;
            self.conflicts = prior_conflicts;
            self.overlay_dirty.restore(prior_overlay_dirty.clone());
            return Err(error);
        }
        self.cancel_sync_round();
        Ok(result)
    }

    /// Application-authorized recovery of the replicated projection. Unlike a
    /// local security purge, this retains the entire outbox, device identity,
    /// lease, outcomes, subscription registrations, and protected bookkeeping.
    /// The projection reset, subscription rewind, optimistic replay, and
    /// idempotency marker share one savepoint for interruption safety.
    pub fn rebootstrap_local_data(
        &mut self,
        input: &LocalDataRebootstrapInput,
    ) -> Result<LocalDataRebootstrapResult, String> {
        if input.rebootstrap_id.is_empty()
            || input.rebootstrap_id.len() > 128
            || !is_local_operation_code_like(&input.rebootstrap_id)
        {
            return Err(
                "sync.invalid_request: local rebootstrap rebootstrapId must be a 1–128 character code-like identifier"
                    .to_owned(),
            );
        }
        let meta_key = format!("localRebootstrap:{}", input.rebootstrap_id);
        if let Some(persisted) = self.get_meta_strict(&meta_key)? {
            let (retained_commits, reset_subscriptions) =
                decode_local_rebootstrap_receipt(&persisted)?;
            return Ok(LocalDataRebootstrapResult {
                already_applied: true,
                retained_commits,
                reset_subscriptions,
            });
        }
        if self.stopped || self.schema_floor.is_some() {
            return Err(
                "sync.invalid_request: local rebootstrap cannot bypass an active schema-floor stop; update the application first"
                    .to_owned(),
            );
        }

        let retained_commits = self.outbox.len();
        let reset_subscriptions = self.subs.len();
        let prior_subs = self.subs.clone();
        let prior_upgrading = self.upgrading;
        let prior_stopped = self.stopped;
        let prior_schema_floor = self.schema_floor.clone();
        let prior_overlay_dirty = self.overlay_dirty.snapshot();
        let prior_sync_needed = self.sync_needed;
        let prior_sync_intents = self.sync_intent_queue.clone();
        let receipt = encode_local_rebootstrap_receipt(retained_commits, reset_subscriptions)?;

        let prior_active_round = self.active_round;
        self.begin_observation("syncular_local_rebootstrap")?;
        let mut batch = ChangeAccumulator::default();
        let applied = (|| -> Result<(), String> {
            self.run_schema_reset_observed(&mut batch, false)?;
            self.conn
                .execute(
                    "INSERT INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                    rusqlite::params![meta_key, receipt],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.sync_needed = true;
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
            batch.status = true;
            Ok(())
        })();
        if let Err(error) = applied {
            self.rollback_observation("syncular_local_rebootstrap");
            self.active_round = prior_active_round;
            self.subs = prior_subs;
            self.upgrading = prior_upgrading;
            self.stopped = prior_stopped;
            self.schema_floor = prior_schema_floor;
            self.overlay_dirty.restore(prior_overlay_dirty.clone());
            self.sync_needed = prior_sync_needed;
            self.sync_intent_queue = prior_sync_intents;
            return Err(error);
        }
        if let Err(error) = self.finish_observation("syncular_local_rebootstrap", batch) {
            self.rollback_observation("syncular_local_rebootstrap");
            self.active_round = prior_active_round;
            self.subs = prior_subs;
            self.upgrading = prior_upgrading;
            self.stopped = prior_stopped;
            self.schema_floor = prior_schema_floor;
            self.overlay_dirty.restore(prior_overlay_dirty.clone());
            self.sync_needed = prior_sync_needed;
            self.sync_intent_queue = prior_sync_intents;
            return Err(error);
        }

        Ok(LocalDataRebootstrapResult {
            already_applied: false,
            retained_commits,
            reset_subscriptions,
        })
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
        self.overlay_dirty.table(table_name);
        self.conn
            .execute(&sql, rusqlite::params_from_iter(&params))
            .map_err(|_| ())?;
        self.conn
            .execute(
                &format!(
                    "DELETE FROM {} WHERE {}",
                    visible_table(table_name),
                    clauses.join(" AND ")
                ),
                rusqlite::params_from_iter(&params),
            )
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
        let tx = self
            .conn
            .transaction()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.execute(
            "INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES (?,?,?,?,?)
             ON CONFLICT(blob_id) DO NOTHING",
            rusqlite::params![blob_id, bytes, bytes.len() as i64, media_type, now],
        )
        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.execute(
            "INSERT OR IGNORE INTO _syncular_blob_uploads(blob_id, media_type, created_at_ms) VALUES (?,?,?)",
            rusqlite::params![blob_id, media_type, now],
        )
        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.commit()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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

    /// §5.9.7: resolve an owned blob body without driver encoding. A
    /// content-addressed cache hit serves with no fetch (B1); a miss downloads
    /// (§5.9.5), verifies the address, caches the bytes, and returns them.
    pub fn fetch_blob_bytes(
        &mut self,
        transport: &mut dyn Transport,
        blob_id_or_ref: &str,
    ) -> Result<FetchedBlob, (String, String)> {
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
        if let Some(cached) = self.get_cached_blob_bytes(&blob_id).map_err(simple)? {
            return Ok(cached);
        }
        if !self.transport_enabled {
            return Err(("sync.offline".into(), "transport gate is closed".into()));
        }
        // §5.9.5: propagate the server's blob.* code (blob.forbidden /
        // blob.not_found) verbatim so the harness can assert on it. The
        // authorized endpoint serves bytes inline OR (always-issue, presign
        // configured) a signed url the client fetches directly — no host auth,
        // no fall-through: failure => re-request (the caller's next fetch_blob_bytes).
        #[cfg(feature = "bench-internals")]
        let download_phase = self.benchmark_phases.start(Phase::BlobDownload);
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
        #[cfg(feature = "bench-internals")]
        drop(download_phase);
        #[cfg(feature = "bench-internals")]
        let validate_phase = self.benchmark_phases.start(Phase::BlobValidate);
        // §5.9.5 inherits §5.1: verify the content address, reject mismatch.
        if blob_id_for(&bytes) != blob_id {
            return Err(simple(format!(
                "blob content address mismatch for {blob_id}"
            )));
        }
        #[cfg(feature = "bench-internals")]
        drop(validate_phase);
        #[cfg(feature = "bench-internals")]
        let insert_phase = self.benchmark_phases.start(Phase::BlobCacheInsert);
        let now = self.clock_now_ms();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES (?,?,?,NULL,?)",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, now],
            )
            .map_err(|e| simple(e.to_string()))?;
        self.conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(|e| simple(e.to_string()))?;
        self.enforce_blob_cache_cap();
        #[cfg(feature = "bench-internals")]
        drop(insert_phase);
        self.get_cached_blob_bytes(&blob_id)
            .map_err(simple)?
            .ok_or_else(|| simple("blob cache write failed".to_owned()))
    }

    fn get_cached_blob_bytes(&self, blob_id: &str) -> Result<Option<FetchedBlob>, String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::BlobCacheRead);
        let mut stmt = self
            .conn
            .prepare("SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query(rusqlite::params![blob_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        if let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        {
            let bytes: Vec<u8> = row
                .get(0)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let byte_length: i64 = row
                .get(1)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let media_type: Option<String> = row
                .get(2)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            return Ok(Some(FetchedBlob {
                blob_id: blob_id.to_owned(),
                byte_length,
                bytes,
                media_type,
            }));
        }
        Ok(None)
    }

    /// §5.9.7 B4: upload every queued blob before push.
    fn pending_blob_uploads(&self) -> Result<Vec<crate::round::PendingUpload>, TransportError> {
        let pending: Vec<(String, Option<String>)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT blob_id, media_type FROM (
                      SELECT blob_id, media_type, created_at_ms FROM _syncular_blob_uploads
                      UNION ALL
                      SELECT DISTINCT r.blob_id, b.media_type, 9223372036854775807 AS created_at_ms
                      FROM _syncular_blob_commit_refs r LEFT JOIN _syncular_blobs b ON b.blob_id = r.blob_id
                      WHERE NOT EXISTS (SELECT 1 FROM _syncular_blob_uploads u WHERE u.blob_id = r.blob_id)
                    ) ORDER BY created_at_ms, blob_id",
                )
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            rows.collect::<Result<_, _>>()
                .map_err(|error| match error {
                    rusqlite::Error::InvalidColumnType(..)
                    | rusqlite::Error::FromSqlConversionFailure(..) => TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload metadata is invalid",
                    ),
                    _ => TransportError::new("client.failed", error.to_string()),
                })?
        };
        let mut uploads = Vec::new();
        for (blob_id, media_type) in pending {
            let bytes = (|| {
                let stored: Option<(SqlValue, SqlValue)> = self
                    .conn
                    .query_row(
                        "SELECT bytes, byte_length FROM _syncular_blobs WHERE blob_id = ?",
                        rusqlite::params![blob_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
                let Some((SqlValue::Blob(bytes), SqlValue::Integer(byte_length))) = stored else {
                    return Err(TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload body is missing or corrupt",
                    ));
                };
                if byte_length != bytes.len() as i64 || blob_id_for(&bytes) != blob_id {
                    return Err(TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload body is missing or corrupt",
                    ));
                }
                Ok(bytes)
            })();
            let failed = bytes.is_err();
            uploads.push(crate::round::PendingUpload {
                id: blob_id,
                bytes,
                media_type,
            });
            if failed {
                break;
            }
        }
        Ok(uploads)
    }

    #[cfg(test)]
    fn flush_blob_uploads(&mut self, transport: &mut dyn Transport) -> Result<(), TransportError> {
        for upload in self.pending_blob_uploads()? {
            self.upload_one(
                transport,
                &upload.id,
                &upload.bytes?,
                upload.media_type.as_deref(),
            )?;
            self.conn
                .execute(
                    "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                    rusqlite::params![upload.id],
                )
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
        }
        Ok(())
    }

    /// §5.9.3: upload one blob, preferring the presigned direct-to-storage
    /// grant when the transport supports it, else streaming through the direct
    /// host-authenticated endpoint (capability, not fallback). A `Url` grant
    /// PUTs direct with no host auth; on a grant PUT failure the client streams
    /// through the direct endpoint — a *different, host-authenticated
    /// capability*, not a fall-through of the grant's authority.
    #[cfg(test)]
    fn upload_one(
        &self,
        transport: &mut dyn Transport,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        crate::round::upload_one(transport, blob_id, bytes, media_type, self.now_ms)
    }

    fn visible_blob_ids_sql(&self) -> String {
        let mut selects = Vec::new();
        for table in &self.schema.tables {
            for column in table
                .columns
                .iter()
                .filter(|column| column.ty == ColumnType::BlobRef)
            {
                let identifier = quote_ident(&column.name);
                selects.push(format!(
                    "SELECT json_extract({identifier}, '$.blobId') AS blob_id FROM {} \
                     WHERE typeof({identifier}) = 'text' AND json_valid({identifier}) \
                     AND json_type({identifier}, '$.blobId') = 'text'",
                    quote_ident(&table.name),
                ));
            }
        }
        if selects.is_empty() {
            "SELECT NULL AS blob_id WHERE 0".to_owned()
        } else {
            selects.join(" UNION ")
        }
    }

    /// §5.9.7 B1 size cap. Visible rows, pending commits, and
    /// staged uploads pin bodies directly; no derived refcount is stored.
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
        let query = format!(
            "SELECT blob_id, byte_length FROM _syncular_blobs
             WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
               AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
               AND blob_id NOT IN ({})
             ORDER BY created_at_ms ASC, blob_id ASC",
            self.visible_blob_ids_sql(),
        );
        let candidates: Vec<(String, i64)> = {
            let Ok(mut stmt) = self.conn.prepare(&query) else {
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

    fn delete_unreferenced_cached_blobs(&mut self) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::BlobRetention);
        if !self.schema_has_blobs() {
            return Ok(());
        }
        self.rebuild_overlay_if_dirty()?;
        self.conn
            .execute(
                &format!(
                    "DELETE FROM _syncular_blobs
                 WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
                   AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
                   AND blob_id NOT IN ({})",
                    self.visible_blob_ids_sql(),
                ),
                [],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
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
        self.overlay_dirty.table(table_name);
        self.write_row(&base_table(table_name), table_name, row, version)
    }

    fn write_row(
        &self,
        full_table: &str,
        table_name: &str,
        row: &Row,
        version: i64,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::RowWrite);
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        let sql = self.insert_row_sql(full_table, table);
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let params = row
            .iter()
            .map(RowParam::Cell)
            .chain(std::iter::once(RowParam::Version(version)));
        stmt.execute(rusqlite::params_from_iter(params))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
    }

    fn delete_base_row(&self, table_name: &str, row_id: &str) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        self.overlay_dirty.table(table_name);
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            row_id_predicate(table)
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        stmt.execute(rusqlite::params![row_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
    }

    fn has_acknowledged_rows(&self) -> bool {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM _syncular_acked_rows)",
                [],
                |row| row.get(0),
            )
            .expect("read acknowledged intent")
    }

    fn acknowledged_operations(
        &self,
        rows: Option<&HashSet<(&str, &str)>>,
        tables: Option<&BTreeSet<&str>>,
    ) -> Result<Vec<OutboxOp>, String> {
        let keys = rows.map(|rows| {
            serde_json::to_string(
                &rows
                    .iter()
                    .map(|(table, id)| serde_json::to_string(&(table, id)).expect("row key"))
                    .collect::<Vec<_>>(),
            )
            .expect("row keys")
        });
        let mut statement = self
            .conn
            .prepare("SELECT op_json,intent_json FROM _syncular_acked_rows WHERE (?1 IS NULL OR json_array(tbl,id) IN(SELECT value FROM json_each(?1))) AND (?2 IS NULL OR tbl IN(SELECT value FROM json_each(?2))) ORDER BY commit_seq,idx")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map(
                rusqlite::params![
                    keys,
                    tables.map(|tables| serde_json::to_string(tables).expect("table keys"))
                ],
                |row| {
                    #[cfg(test)]
                    self.acknowledged_replay_count
                        .set(self.acknowledged_replay_count.get() + 1);
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                },
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (op, intent) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let op: CommitOperation =
                serde_json::from_str(&op).map_err(|_| "sync.local_corrupt".to_owned())?;
            let table = self
                .schema
                .table(&op.table)
                .ok_or_else(|| "sync.unknown_table".to_owned())?;
            let values = if op.op == "upsert" && self.visible_row(table, &op.row_id)?.is_none() {
                Some(serde_json::from_str(&intent).map_err(|_| "sync.local_corrupt".to_owned())?)
            } else {
                op.values
            };
            Ok(OutboxOp {
                table: op.table,
                row_id: op.row_id,
                upsert: op.op == "upsert",
                base_version: op.base_version,
                values,
            })
        })
        .collect()
    }

    fn drop_acknowledged_rows(
        &self,
        matches: impl Fn(&str, &Map<String, Value>) -> bool,
    ) -> Result<Vec<OutboxCommit>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT commit_id,tbl,intent_json,id FROM _syncular_acked_rows")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut doomed = HashSet::new();
        for row in rows {
            let (id, table, intent, row_id) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let values =
                serde_json::from_str(&intent).map_err(|_| "sync.local_corrupt".to_owned())?;
            let base_matches = self
                .schema
                .table(&table)
                .map(|schema| self.stored_row(schema, &row_id, true))
                .transpose()?
                .flatten()
                .is_some_and(|(base, _)| {
                    let schema = self.schema.table(&table).expect("acknowledged table");
                    let values = schema
                        .columns
                        .iter()
                        .zip(base.iter())
                        .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                        .collect();
                    matches(&table, &values)
                });
            if matches(&table, &values) || base_matches {
                doomed.insert(id);
            }
        }
        let mut dropped = Vec::new();
        for id in doomed {
            let mut statement = self
                .conn
                .prepare("SELECT op_json FROM _syncular_acked_rows WHERE commit_id=?1 ORDER BY idx")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let operations = statement
                .query_map([&id], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let mut ops = Vec::new();
            for operation in operations {
                let json = operation
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let op: CommitOperation =
                    serde_json::from_str(&json).map_err(|_| "sync.local_corrupt".to_owned())?;
                self.overlay_dirty.table(&op.table);
                ops.push(OutboxOp {
                    table: op.table,
                    row_id: op.row_id,
                    upsert: op.op == "upsert",
                    base_version: op.base_version,
                    values: op.values,
                });
            }
            dropped.push(OutboxCommit {
                client_commit_id: id.clone(),
                ops,
            });
            self.conn
                .execute("DELETE FROM _syncular_acked_rows WHERE commit_id=?1", [id])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(dropped)
    }

    /// [`Self::rebuild_overlay`], skipped when neither the base tables nor
    /// the outbox changed since the last rebuild (the no-op sync round).
    fn rebuild_overlay_if_dirty(&mut self) -> Result<(), String> {
        if self.overlay_dirty.get() {
            self.rebuild_overlay()?;
        }
        Ok(())
    }

    /// §7.1: local reads see outbox state applied optimistically — rebuild
    /// every visible table as (base server state) + (pending outbox replay
    /// on top). Optimistic rows carry version `-1`.
    fn rebuild_overlay(&mut self) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::OverlayRebuild);
        #[cfg(test)]
        self.overlay_rebuild_count
            .set(self.overlay_rebuild_count.get() + 1);
        let dirty = self.overlay_dirty.snapshot();
        let tables: Vec<_> = self
            .schema
            .tables
            .iter()
            .filter(|table| {
                dirty
                    .as_ref()
                    .is_none_or(|names| names.is_empty() || names.contains(&table.name))
            })
            .cloned()
            .collect();
        let names: BTreeSet<_> = tables.iter().map(|table| table.name.as_str()).collect();
        self.begin_observation("syncular_overlay")?;
        let rebuilt = (|| {
            for table in &tables {
                for index in &table.fts_indexes {
                    self.drop_fts_triggers(index)?;
                }
                let visible = visible_table(&table.name);
                let base = base_table(&table.name);
                self.conn
                    .execute_batch(&format!(
                        "DELETE FROM {visible}; INSERT INTO {visible} SELECT * FROM {base}"
                    ))
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            let acknowledged = self.acknowledged_operations(None, Some(&names))?;
            self.apply_outbox_ops(
                acknowledged
                    .iter()
                    .filter(|op| names.contains(op.table.as_str())),
            )?;
            for (commit, initial) in &self.failed_commits {
                for operation in &commit.ops {
                    if !names.contains(operation.table.as_str()) || !operation.upsert {
                        continue;
                    }
                    if let Some(table) = self.schema.table(&operation.table) {
                        if self.visible_row(table, &operation.row_id)?.is_none()
                            && operation.values.as_ref().is_some_and(|values| {
                                table
                                    .columns
                                    .iter()
                                    .all(|column| values.contains_key(&column.name))
                            })
                        {
                            let key = serde_json::to_string(&(
                                operation.table.clone(),
                                operation.row_id.clone(),
                            ))
                            .expect("row key serialization");
                            if let Some(Value::Object(values)) = initial.get(&key) {
                                self.apply_outbox_ops(&[OutboxOp {
                                    values: Some(values.clone()),
                                    ..operation.clone()
                                }])?;
                            }
                        }
                    }
                }
                self.apply_outbox_ops(
                    commit
                        .ops
                        .iter()
                        .filter(|op| names.contains(op.table.as_str())),
                )?;
            }
            for commit in &self.outbox {
                self.apply_outbox_ops(
                    commit
                        .ops
                        .iter()
                        .filter(|op| names.contains(op.table.as_str())),
                )?;
            }
            for table in &tables {
                for index in &table.fts_indexes {
                    self.rebuild_fts_projection(table, index)?;
                    self.create_fts_triggers(table, index)?;
                }
            }
            self.conn
                .execute_batch("RELEASE syncular_overlay")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            Ok(())
        })();
        if rebuilt.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO syncular_overlay; RELEASE syncular_overlay")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        } else {
            self.overlay_dirty.set(false);
        }
        rebuilt
    }

    /// §7.1 replay: every operation is applied over the current visible
    /// state. An operation that no longer applies (a server row now holds its
    /// unique value) stays pending and invisible until a later replay admits
    /// it or the server answers its push.
    fn apply_outbox_ops<'a>(
        &self,
        ops: impl IntoIterator<Item = &'a OutboxOp>,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let mut phase = self.benchmark_phases.start(Phase::PendingReplay);
        for op in ops {
            #[cfg(feature = "bench-internals")]
            if let Some(phase) = &mut phase {
                phase.unit();
            }
            if op.upsert {
                if let (Some(table), Some(values)) = (
                    self.schema
                        .table(&op.table)
                        .filter(|table| table.indexes.iter().any(|index| index.unique)),
                    op.values.as_ref(),
                ) {
                    let mut intended: Map<String, Value> = self
                        .visible_row(table, &op.row_id)?
                        .map(|(row, _)| {
                            table
                                .columns
                                .iter()
                                .zip(&row)
                                .map(|(column, value)| {
                                    (column.name.clone(), column_value_to_json(value))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    intended.extend(values.clone());
                    if !self.unique_conflicts(table, &intended, false)?.is_empty() {
                        continue;
                    }
                }
            }
            self.apply_outbox_op(op)?;
        }
        Ok(())
    }

    fn apply_outbox_op(&self, op: &OutboxOp) -> Result<(), String> {
        let Some(table) = self.schema.table(&op.table) else {
            return Ok(());
        };
        let visible = visible_table(&table.name);
        if !op.upsert {
            let sql = format!("DELETE FROM {visible} WHERE {}", row_id_predicate(table));
            self.conn
                .prepare_cached(&sql)
                .and_then(|mut statement| statement.execute(rusqlite::params![op.row_id]))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            return Ok(());
        }
        let Some(values) = op.values.as_ref() else {
            return Ok(());
        };
        // §7.1: the overlay applies the operation's PRESENT columns
        // over the current local row. A partial operation over an
        // absent local row leaves it absent — the server answers it
        // with sync.row_deleted or sync.row_missing (§6.2).
        let full = table
            .columns
            .iter()
            .all(|column| values.contains_key(&column.name));
        let local = self.visible_row(table, &op.row_id)?;
        if local.is_none() && !full {
            return Ok(());
        }
        let mut row: Row = Vec::with_capacity(table.columns.len());
        for (index, column) in table.columns.iter().enumerate() {
            let incoming = match values.get(&column.name) {
                Some(raw) => json_to_column_value(
                    if raw.get("$bytes").is_some()
                        && table
                            .encrypted_columns
                            .iter()
                            .any(|encrypted| encrypted.index == index)
                    {
                        &table.wire_columns[index]
                    } else {
                        column
                    },
                    Some(raw),
                ),
                None => Ok(local
                    .as_ref()
                    .and_then(|(values, _)| values.get(index).cloned())
                    .flatten()),
            };
            row.push(incoming.map_err(|_| {
                "sync.local_corrupt: persisted optimistic row value is invalid".to_owned()
            })?);
        }
        let version = local.as_ref().map_or(-1, |(_, version)| *version);
        self.write_row(&visible, &table.name, &row, version)
            .map_err(|error| {
                if error.starts_with("UNIQUE constraint failed:") {
                    "sync.constraint_violation: local write violates a unique constraint".to_owned()
                } else {
                    error
                }
            })
    }

    /// The visible (optimistic) row's values plus version, or `None` when the
    /// row is absent from the overlay.
    fn visible_row(&self, table: &TableSchema, row_id: &str) -> Result<Option<(Row, i64)>, String> {
        self.stored_row(table, row_id, false)
    }

    fn stored_row(
        &self,
        table: &TableSchema,
        row_id: &str,
        base: bool,
    ) -> Result<Option<(Row, i64)>, String> {
        let sql = format!(
            "SELECT * FROM {} WHERE {}",
            if base {
                base_table(&table.name)
            } else {
                visible_table(&table.name)
            },
            row_id_predicate(table)
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query(rusqlite::params![row_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        else {
            return Ok(None);
        };
        let mut values = Vec::with_capacity(table.columns.len());
        for (index, column) in table.columns.iter().enumerate() {
            let raw = row
                .get_ref(index)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if let rusqlite::types::ValueRef::Blob(bytes) = raw {
                if table
                    .encrypted_columns
                    .iter()
                    .any(|encrypted| encrypted.index == index)
                {
                    values.push(Some(ColumnValue::Bytes(bytes.to_vec())));
                    continue;
                }
            }
            let json = sql_ref_to_json(column, raw);
            values.push(json_to_column_value(column, Some(&json)).map_err(|_| {
                "sync.local_corrupt: persisted local row value is invalid".to_owned()
            })?);
        }
        let version: i64 = row
            .get(table.columns.len())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(Some((values, version)))
    }

    // -- realtime (§8) ---------------------------------------------------------------

    /// §8.8: the configured realtime policy.
    #[must_use]
    pub fn realtime_policy(&self) -> RealtimePolicy {
        self.realtime_policy
    }

    /// §8.8: the explicit realtime availability state.
    #[must_use]
    pub fn realtime_state(&self) -> RealtimeState {
        self.realtime_state
    }

    /// §8.8: set the realtime policy. Refused while the socket is connected:
    /// a policy change never silently re-routes an ownership state.
    pub fn set_realtime_policy(&mut self, policy: RealtimePolicy) -> Result<(), String> {
        if self.realtime_state == RealtimeState::Connected && policy != self.realtime_policy {
            return Err(
                "sync.invalid_request: disconnect realtime before changing the realtime policy"
                    .to_owned(),
            );
        }
        self.realtime_policy = policy;
        match policy {
            RealtimePolicy::Off => self.set_realtime_state(RealtimeState::Disabled, None),
            RealtimePolicy::Required | RealtimePolicy::Optional
                if self.realtime_state == RealtimeState::Disabled =>
            {
                self.set_realtime_state(RealtimeState::Disconnected, None);
            }
            RealtimePolicy::Required | RealtimePolicy::Optional => {}
        }
        Ok(())
    }

    /// Record an availability transition, keeping the reason code bounded and
    /// code-like (§7.6) and clearing it where it cannot apply.
    fn set_realtime_state(&mut self, state: RealtimeState, reason_code: Option<&str>) {
        self.realtime_state = state;
        self.realtime_reason_code = reason_code.map(Self::diagnostic_code);
        if matches!(state, RealtimeState::Connected | RealtimeState::Disabled) {
            self.realtime_reason_code = None;
            self.realtime_retry_delay_ms = None;
        }
    }

    #[must_use]
    fn realtime_connected(&self) -> bool {
        self.realtime_state == RealtimeState::Connected
    }

    pub fn connect_realtime(&mut self, transport: &mut dyn Transport) -> Result<(), String> {
        if !self.transport_enabled {
            return Err("sync.offline: transport gate is closed".into());
        }
        if self.realtime_policy == RealtimePolicy::Off {
            return Err(
                "sync.invalid_request: realtime is off; realtime connect is refused".to_owned(),
            );
        }
        if self.realtime_connected() {
            return Ok(());
        }
        self.realtime_state = RealtimeState::Connecting;
        match transport.realtime_connect_for_client(&self.client_id) {
            Ok(()) => {
                self.set_realtime_state(RealtimeState::Connected, None);
                Ok(())
            }
            Err(error) => {
                self.set_realtime_state(RealtimeState::Refused, Some(&error.code));
                Err(format!("{}: {}", error.code, error.message))
            }
        }
    }

    pub fn disconnect_realtime(&mut self, transport: &mut dyn Transport) {
        self.cancel_sync_round();
        // A deliberately disconnected or policy-disabled client has nothing
        // to release; a `lost` socket still does (the host owns the handle).
        if self.realtime_state == RealtimeState::Disconnected
            || self.realtime_state == RealtimeState::Disabled
        {
            return;
        }
        let _ = transport.realtime_close();
        self.set_realtime_state(
            if self.realtime_policy == RealtimePolicy::Off {
                RealtimeState::Disabled
            } else {
                RealtimeState::Disconnected
            },
            None,
        );
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
        if !self.transport_enabled {
            return Err("sync.offline: transport gate is closed".into());
        }
        if !self.realtime_connected() {
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
    /// Mailbox hosts send durable acknowledgements on their I/O executor.
    pub fn on_realtime_binary_queued(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut transport = crate::round::DownloadResults::default();
        self.on_realtime_binary(&mut transport, bytes);
        transport.controls
    }

    pub fn on_realtime_binary(&mut self, transport: &mut dyn Transport, bytes: &[u8]) {
        if self.stopped || !self.transport_enabled {
            return;
        }
        #[cfg(feature = "bench-internals")]
        let decode_phase = self.benchmark_phases.start(Phase::ResponseDecode);
        let message = match decode_message(bytes) {
            Ok(m) if m.msg_kind == MsgKind::Response => m,
            _ => {
                self.set_sync_needed(true, true);
                return;
            }
        };
        #[cfg(feature = "bench-internals")]
        drop(decode_phase);
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
            if next_cursor.is_some_and(|cursor| cursor <= sub.cursor) {
                // Idempotent redelivery of an already-covered window.
                any_covered = true;
                continue;
            }
            let previous_effective = self.subs[sub_index].effective.clone();
            let previous_cursor = self.subs[sub_index].cursor;
            self.subs[sub_index].effective = Some(effective_scopes);
            let mut failed = false;
            for inner in body {
                match inner {
                    Frame::Commit {
                        tables,
                        changes,
                        commit_seq,
                        ..
                    } => {
                        if self
                            .apply_commit_frame(&tables, &changes, Some(commit_seq))
                            .is_err()
                        {
                            failed = true;
                            break;
                        }
                    }
                    _ => {
                        failed = true;
                        break;
                    }
                }
            }
            let committed = next_cursor.filter(|_| !failed).and_then(|cursor| {
                self.apply_sub_end(sub_index, cursor, None)
                    .ok()
                    .map(|()| cursor)
            });
            let Some(next_cursor) = committed else {
                self.subs[sub_index].effective = previous_effective;
                self.subs[sub_index].cursor = previous_cursor;
                dropped = true;
                continue;
            };
            applied_cursor = Some(applied_cursor.map_or(next_cursor, |c| c.max(next_cursor)));
        }
        if let Some(cursor) = applied_cursor {
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
        if !self.realtime_connected() {
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

#[cfg(test)]
mod previous_version_wiring_tests {
    use super::*;
    use serde_json::{json, Value};

    fn previous_version_schema(version: i32) -> Value {
        json!({
            "version": version,
            "tables": [{
                "name": "tasks",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "note", "type": "string", "nullable": true }
                ],
                "scopes": []
            }]
        })
    }

    fn previous_version_limits() -> crate::api::ClientLimits {
        crate::api::ClientLimits {
            previous_version_context: Some(crate::previous_version::PreviousVersionContextConfig {
                enabled: true,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The configuration the live client carries, for a direct capture call.
    fn previous_version_config() -> crate::previous_version::PreviousVersionContextConfig {
        previous_version_limits()
            .previous_version_context
            .expect("configured")
    }

    /// Capture the container the way a bump would, so a read test starts from a
    /// container this client's own state will then decide about.
    fn recapture_previous_version(client: &SyncClient) {
        let replica_path = client
            .previous_version_replica_path()
            .expect("file-backed replica");
        let outcome = crate::previous_version::capture_previous_version_from_replica(
            &client.conn,
            &replica_path,
            2,
            2,
            &previous_version_config(),
            1,
        )
        .expect("capture");
        assert!(matches!(
            outcome,
            crate::previous_version::CaptureOutcome::Captured(_)
        ));
    }

    fn subscription(state: SubState, cursor: i64, bootstrap_state: Option<&str>) -> Subscription {
        Subscription {
            id: "wiring-sub".to_owned(),
            table: "tasks".to_owned(),
            requested: Vec::new(),
            params: None,
            cursor,
            bootstrap_state: bootstrap_state.map(str::to_owned),
            state,
            reason_code: None,
            effective: None,
            synced_once: false,
        }
    }

    #[test]
    fn schema_downgrade_refuses_all_opens_and_recreate_without_mutation() {
        let path =
            std::env::temp_dir().join(format!("syncular-downgrade-{}.db", uuid::Uuid::new_v4()));
        let path_str = path.to_str().expect("temp path");
        let schema = previous_version_schema(3);
        let mut older = previous_version_schema(2);
        older["tables"][0]["columns"] =
            json!([{ "name": "id", "type": "string", "nullable": false }]);
        let mut client = SyncClient::open_path(
            "downgrade".into(),
            &previous_version_schema(1),
            previous_version_limits(),
            path_str,
        )
        .expect("fresh");
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("accepted")),
                    ("note".into(), json!("old")),
                ]),
                base_version: None,
            }])
            .expect("v1 write");
        client
            .recreate_with_schema(&schema)
            .expect("upgrade captures context");
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("queued")),
                    ("note".into(), json!("v3-only")),
                ]),
                base_version: None,
            }])
            .expect("queued v3 write");
        let changes = client.conn.total_changes();
        let outbox = client.pending_commit_ids();
        assert!(outbox.contains(&commit));
        let descriptor = client.get_meta("localSchemaDescriptor");
        let container = format!(
            "{path_str}{}",
            crate::previous_version::PREVIOUS_VERSION_CONTAINER_SUFFIX
        );
        let context = std::fs::read(&container).expect("captured context");
        assert!(client
            .recreate_with_schema(&older)
            .expect_err("refuse recreate")
            .starts_with("client.schema_downgrade:"));
        assert_eq!(client.schema.version, 3);
        assert_eq!(client.conn.total_changes(), changes);
        assert_eq!(client.pending_commit_ids(), outbox);
        assert_eq!(client.get_meta("localSchemaDescriptor"), descriptor);
        assert_eq!(
            client
                .conn
                .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("queued row"),
            "v3-only"
        );
        assert_eq!(std::fs::read(&container).expect("context remains"), context);
        drop(client);
        let before = std::fs::read(&path).expect("replica bytes");
        // open_path uses DELETE journaling. The identity open must refuse
        // before its normal WAL configuration changes this database.
        for entry in 0..3 {
            let error = match entry {
                0 => SyncClient::open_path(
                    "downgrade".into(),
                    &older,
                    previous_version_limits(),
                    path_str,
                ),
                1 => SyncClient::open_path_with_identity(
                    None,
                    &older,
                    previous_version_limits(),
                    path_str,
                ),
                _ => SyncClient::with_connection(
                    "downgrade".into(),
                    &older,
                    previous_version_limits(),
                    Connection::open(&path).expect("connection"),
                ),
            }
            .err()
            .expect("refuse open");
            assert!(error.starts_with("client.schema_downgrade:"));
            let conn = Connection::open(&path).expect("inspect");
            assert_eq!(
                conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                    .expect("journal mode"),
                "delete"
            );
            drop(conn);
            assert_eq!(std::fs::read(&path).expect("replica unchanged"), before);
            assert_eq!(
                std::fs::read(&container).expect("context unchanged"),
                context
            );
        }
        let reopened = SyncClient::open_path(
            "downgrade".into(),
            &schema,
            previous_version_limits(),
            path_str,
        )
        .expect("compatible reopen");
        assert_eq!(reopened.pending_commit_ids(), outbox);
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("queued row remains"),
            "v3-only"
        );
        reopened.delete_meta(LOCAL_SCHEMA_VERSION_KEY);
        reopened.delete_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY);
        drop(reopened);
        let legacy = SyncClient::open_path(
            "downgrade".into(),
            &schema,
            previous_version_limits(),
            path_str,
        )
        .expect("legacy no-marker reopen");
        assert_eq!(legacy.pending_commit_ids(), outbox);
        assert!(!legacy.upgrading());
        assert_eq!(
            legacy
                .conn
                .query_row("SELECT note FROM tasks WHERE id = 'queued'", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("legacy row remains"),
            "v3-only"
        );
        drop(legacy);
        std::fs::remove_file(path).expect("remove replica");
        let _ = std::fs::remove_file(container);
    }

    #[test]
    fn schema_marker_errors_refuse_open_and_recreate_without_mutation() {
        for marker in [
            "''",
            "'bad'",
            "'0'",
            "'-1'",
            "'2.5'",
            "'03'",
            "'3\n'",
            "' 3'",
            "'+3'",
            "'3e0'",
            "'2147483648'",
            "NULL",
            "X'33'",
        ] {
            let conn = Connection::open_in_memory().expect("connection");
            conn.execute_batch(&format!("CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value); INSERT INTO _syncular_meta VALUES ('localSchemaVersion', {marker});")).expect("invalid marker fixture");
            let error = SyncClient::with_connection(
                "marker".into(),
                &previous_version_schema(3),
                ClientLimits::default(),
                conn,
            )
            .err()
            .expect("refuse marker");
            assert!(
                error.starts_with("sync.local_corrupt:"),
                "{marker}: {error}"
            );
        }
        for fault in [
            "UPDATE _syncular_meta SET value = 'bad' WHERE key = 'localSchemaVersion'",
            "ALTER TABLE _syncular_meta RENAME COLUMN value TO unreadable_value",
        ] {
            let mut client = SyncClient::new(
                "marker".into(),
                &previous_version_schema(3),
                ClientLimits::default(),
            )
            .expect("fresh");
            let commit = client
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".into(),
                    values: Map::from_iter([("id".into(), json!("queued"))]),
                    base_version: None,
                }])
                .expect("queued write");
            client.conn.execute_batch(fault).expect("marker fault");
            let changes = client.conn.total_changes();
            let error = client
                .recreate_with_schema(&previous_version_schema(4))
                .expect_err("refuse corrupt marker");
            assert!(error.starts_with("sync.local_corrupt:"));
            assert_eq!(client.conn.total_changes(), changes);
            assert_eq!(client.schema.version, 3);
            assert_eq!(client.pending_commit_ids(), vec![commit]);
        }
        for setup in [
            "CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY)",
            "CREATE VIEW _syncular_meta AS SELECT 'localSchemaVersion' AS key, '3' AS value",
        ] {
            let path =
                std::env::temp_dir().join(format!("syncular-marker-{}.db", uuid::Uuid::new_v4()));
            let conn = Connection::open(&path).expect("connection");
            conn.execute_batch(setup)
                .expect("unreadable metadata fixture");
            drop(conn);
            let before = std::fs::read(&path).expect("before");
            let error = SyncClient::open_path_with_identity(
                None,
                &previous_version_schema(3),
                ClientLimits::default(),
                path.to_str().expect("path"),
            )
            .err()
            .expect("refuse unreadable marker");
            assert!(error.starts_with("sync.local_corrupt:"));
            assert_eq!(std::fs::read(&path).expect("after"), before);
            std::fs::remove_file(path).expect("remove fixture");
        }
    }

    std::thread_local! {
        /// The pending concurrent upgrade a busy handler commits, so a lock
        /// collision deterministically becomes the marker race under test.
        static CONCURRENT_UPGRADE: RefCell<Option<Connection>> =
            const { RefCell::new(None) };
    }

    fn commit_concurrent_upgrade(attempts: i32) -> bool {
        CONCURRENT_UPGRADE.with(|slot| {
            if let Some(banner) = slot.borrow_mut().take() {
                banner
                    .execute_batch(
                        "UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion'; COMMIT",
                    )
                    .expect("commit the concurrent upgrade");
            }
        });
        attempts < 10
    }

    fn journal_mode(conn: &Connection) -> String {
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("journal mode")
    }

    fn temp_replica(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("syncular-{label}-{}.db", uuid::Uuid::new_v4()))
    }

    #[test]
    fn file_identity_constructor_requires_the_returned_wal_mode() {
        for path in [":memory:", ""] {
            let error = SyncClient::open_path_with_identity(
                None,
                &previous_version_schema(1),
                ClientLimits::default(),
                path,
            )
            .err()
            .expect("temporary SQLite databases cannot enter WAL mode");
            assert_eq!(
                error,
                "sync.invalid_request: file-backed client requires WAL journal mode"
            );
        }
        let path = temp_replica("confirmed-wal");
        let client = SyncClient::open_path_with_identity(
            None,
            &previous_version_schema(1),
            ClientLimits::default(),
            path.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(journal_mode(&client.conn), "wal");
        drop(client);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn non_positive_generated_schema_versions_are_refused_before_storage() {
        for version in [json!(0), json!(-1), json!(i32::MIN), json!(2147483648i64)] {
            let mut schema = previous_version_schema(1);
            schema["version"] = version.clone();
            let error = SyncClient::new("bad-version".into(), &schema, ClientLimits::default())
                .err()
                .expect("refuse an out-of-range generated version");
            assert_eq!(
                error,
                "sync.invalid_request: generated schema version must be an integer in 1..=2147483647"
            );
            // The file-backed seam refuses before the replica gains a table.
            let path = temp_replica("bad-version");
            let path_str = path.to_str().expect("path");
            for identity in [false, true] {
                let error = if identity {
                    SyncClient::open_path_with_identity(
                        None,
                        &schema,
                        ClientLimits::default(),
                        path_str,
                    )
                } else {
                    SyncClient::open_path(
                        "bad-version".into(),
                        &schema,
                        ClientLimits::default(),
                        path_str,
                    )
                }
                .err()
                .expect("refuse before storage");
                assert!(
                    error.starts_with("sync.invalid_request:"),
                    "{version}: {error}"
                );
                assert!(
                    !path.exists(),
                    "{version}: a refused constructor creates no replica file"
                );
            }
        }
        // A missing version is the same request error, not a parse failure.
        let mut schema = previous_version_schema(1);
        schema
            .as_object_mut()
            .expect("schema object")
            .remove("version");
        let error = SyncClient::new("bad-version".into(), &schema, ClientLimits::default())
            .err()
            .expect("refuse a missing version");
        assert!(error.starts_with("sync.invalid_request:"), "{error}");
    }

    #[test]
    fn a_duplicated_schema_marker_is_refused_without_a_reset() {
        let path = temp_replica("duplicate-marker");
        let path_str = path.to_str().expect("path");
        {
            // A hand-built/legacy metadata table without its primary key, with
            // the older marker first: `query_row` would pick it and reset.
            let conn = Connection::open(path_str).expect("fixture");
            conn.execute_batch(
                "CREATE TABLE _syncular_meta(key TEXT, value);
                 INSERT INTO _syncular_meta VALUES
                   ('localSchemaVersion', '1'),
                   ('localSchemaVersion', '2'),
                   ('clientId', 'duplicate');",
            )
            .expect("duplicate marker fixture");
        }
        let error = SyncClient::open_path_with_identity(
            None,
            &previous_version_schema(3),
            ClientLimits::default(),
            path_str,
        )
        .err()
        .expect("refuse a duplicated marker");
        assert!(error.starts_with("sync.local_corrupt:"), "{error}");
        let probe = Connection::open(path_str).expect("probe");
        assert_eq!(
            probe
                .query_row(
                    "SELECT COUNT(*) FROM _syncular_meta WHERE key = 'localSchemaVersion'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("marker rows"),
            2,
            "the duplicated rows are left for the operator, not collapsed"
        );
        assert_eq!(
            probe
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_syncular_%' AND name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("synced tables"),
            0,
            "a duplicated marker never drives the reset that recreates v3 tables"
        );
        assert_eq!(
            journal_mode(&probe),
            "delete",
            "the refusal leaves the journal mode alone"
        );
        drop(probe);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn a_refused_open_does_not_persist_wal_or_mutate_the_replica() {
        let path = temp_replica("refused-wal");
        let path_str = path.to_str().expect("path");
        // `open_path` leaves the default journal mode, so a refused open is
        // the only thing that could switch this replica to WAL.
        drop(
            SyncClient::open_path(
                "owner".into(),
                &previous_version_schema(2),
                ClientLimits::default(),
                path_str,
            )
            .expect("v2 replica"),
        );
        let before = std::fs::read(&path).expect("before");
        let error = SyncClient::open_path_with_identity(
            Some("intruder".into()),
            &previous_version_schema(2),
            ClientLimits::default(),
            path_str,
        )
        .err()
        .expect("refuse the identity mismatch");
        assert!(error.starts_with("client.identity_mismatch:"), "{error}");
        let probe = Connection::open(path_str).expect("probe");
        assert_eq!(
            journal_mode(&probe),
            "delete",
            "a refused open must not persist WAL"
        );
        assert_eq!(std::fs::read(&path).expect("after"), before);
        assert_eq!(
            meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY).as_deref(),
            Some("2")
        );
        drop(probe);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn a_concurrent_marker_upgrade_refuses_a_stale_open() {
        let path = temp_replica("marker-race");
        let path_str = path.to_str().expect("path");
        drop(
            SyncClient::open_path_with_identity(
                Some("stale".into()),
                &previous_version_schema(1),
                ClientLimits::default(),
                path_str,
            )
            .expect("v1 replica"),
        );
        // Another process holds the write lock with an uncommitted upgrade; a
        // stale open reads the v1 marker first and only then meets the lock.
        // The first busy therefore lands after this replica became v2.
        let banner = Connection::open(path_str).expect("banner");
        banner
            .execute_batch(
                "BEGIN IMMEDIATE; UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion';",
            )
            .expect("pending upgrade");
        CONCURRENT_UPGRADE.with(|slot| *slot.borrow_mut() = Some(banner));
        let conn = Connection::open(path_str).expect("stale connection");
        conn.busy_handler(Some(commit_concurrent_upgrade))
            .expect("busy handler");
        let error = SyncClient::with_connection(
            "stale".into(),
            &previous_version_schema(1),
            ClientLimits::default(),
            conn,
        )
        .err()
        .expect("a concurrent upgrade must refuse the stale open");
        assert!(error.starts_with("client.schema_downgrade:"), "{error}");
        let probe = Connection::open(path_str).expect("probe");
        assert_eq!(
            meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY).as_deref(),
            Some("2"),
            "the concurrent upgrade survives"
        );
        drop(probe);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn a_concurrent_marker_upgrade_refuses_a_stale_recreate() {
        let path = temp_replica("recreate-race");
        let path_str = path.to_str().expect("path");
        let mut client = SyncClient::open_path_with_identity(
            Some("stale".into()),
            &previous_version_schema(1),
            ClientLimits::default(),
            path_str,
        )
        .expect("v1 replica");
        client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([("id".into(), json!("queued"))]),
                base_version: None,
            }])
            .expect("queued write");
        let commit = client.pending_commit_ids();
        let banner = Connection::open(path_str).expect("banner");
        banner
            .execute_batch(
                "BEGIN IMMEDIATE; UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion';",
            )
            .expect("pending upgrade");
        CONCURRENT_UPGRADE.with(|slot| *slot.borrow_mut() = Some(banner));
        client
            .conn
            .busy_handler(Some(commit_concurrent_upgrade))
            .expect("busy handler");
        let error = client
            .recreate_with_schema(&previous_version_schema(1))
            .expect_err("a concurrent upgrade must refuse the stale recreate");
        assert!(error.starts_with("client.schema_downgrade:"), "{error}");
        assert_eq!(client.schema.version, 1, "the compiled schema is restored");
        assert_eq!(
            client.pending_commit_ids(),
            commit,
            "the outbox is preserved"
        );
        let probe = Connection::open(path_str).expect("probe");
        assert_eq!(
            meta_get(&probe, LOCAL_SCHEMA_VERSION_KEY).as_deref(),
            Some("2")
        );
        drop(probe);
        drop(client);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn failed_schema_record_writes_roll_back_recreation() {
        for key in [
            LOCAL_SCHEMA_VERSION_KEY,
            crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY,
        ] {
            let mut client = SyncClient::new(
                "schema-record".into(),
                &previous_version_schema(1),
                ClientLimits::default(),
            )
            .expect("v1");
            let marker = client.get_meta(LOCAL_SCHEMA_VERSION_KEY);
            let descriptor = client.get_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY);
            client.conn.execute_batch(&format!("CREATE TRIGGER refuse_schema_record BEFORE INSERT ON _syncular_meta WHEN NEW.key = '{key}' BEGIN SELECT RAISE(ABORT, 'refuse schema record'); END")).expect("fault");
            client
                .recreate_with_schema(&previous_version_schema(2))
                .expect_err("both record writes must propagate failure");
            assert_eq!(client.schema.version, 1);
            assert_eq!(client.get_meta(LOCAL_SCHEMA_VERSION_KEY), marker);
            assert_eq!(
                client.get_meta(crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY),
                descriptor
            );
            client
                .conn
                .execute_batch("DROP TRIGGER refuse_schema_record")
                .expect("remove fault");
            client
                .recreate_with_schema(&previous_version_schema(2))
                .expect("retry");
            assert_eq!(client.schema.version, 2);
        }
    }

    #[test]
    fn a_failed_outer_commit_restores_every_reset_side_effect() {
        let path = temp_replica("outer-commit");
        let path_str = path.to_str().expect("path");
        // A rollback-journal replica (no WAL), so a second read connection can
        // hold SHARED across the recreated transaction's COMMIT.
        let conn = Connection::open(path_str).expect("replica connection");
        let mut client = SyncClient::with_connection(
            "outer-commit".into(),
            &previous_version_schema(1),
            previous_version_limits(),
            conn,
        )
        .expect("v1 replica");
        assert_eq!(journal_mode(&client.conn), "delete");
        let commit = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("queued")),
                    ("note".into(), json!("dropped-by-v2")),
                ]),
                base_version: None,
            }])
            .expect("queued write");
        client.drain_change_batches();
        // v2 drops `note`, so the queued upsert cannot re-encode.
        let mut dropped = previous_version_schema(2);
        dropped["tables"][0]["columns"] =
            json!([{ "name": "id", "type": "string", "nullable": false }]);
        // Prior database and memory state: the refused COMMIT must restore all
        // of it.
        let marker = meta_get(&client.conn, LOCAL_SCHEMA_VERSION_KEY);
        let revision = client.local_revision();
        let rows = client.query("SELECT * FROM tasks", &[]).expect("rows");
        let columns: i64 = client
            .conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('tasks')",
                [],
                |row| row.get(0),
            )
            .expect("column count");
        let rebuilds = client.overlay_rebuild_count.get();
        let prior_subs = client.subs.len();
        let prior_changes = client.change_queue.len();
        let prior_intents = client.sync_intent_queue.len();
        let prior_last_change = client.last_change.clone();
        let prior_overlay_dirty = client.overlay_dirty.get();
        let prior_sync_needed = client.sync_needed;
        let prior_upgrading = client.upgrading;
        let prior_stopped = client.stopped;
        let prior_schema_floor = client.schema_floor.clone();
        let prior_active_round = client.active_round;
        // The reader holds SHARED for the whole attempt: the writer takes
        // RESERVED, runs the reset, and fails when COMMIT needs EXCLUSIVE.
        let reader = Connection::open(path_str).expect("reader");
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
            .expect("reader snapshot");
        client
            .conn
            .busy_timeout(std::time::Duration::ZERO)
            .expect("busy timeout");
        let error = client
            .recreate_with_schema(&dropped)
            .expect_err("a blocked COMMIT must refuse the recreation");
        assert!(error.starts_with("client.storage_busy:"), "{error}");
        assert!(
            client.overlay_rebuild_count.get() > rebuilds,
            "the reset ran to its overlay rebuild inside the transaction"
        );
        assert!(client.conn.is_autocommit(), "the transaction is released");
        // Database: the rolled-back reset left nothing behind.
        assert_eq!(meta_get(&client.conn, LOCAL_SCHEMA_VERSION_KEY), marker);
        assert_eq!(client.local_revision(), revision);
        assert_eq!(
            client.query("SELECT * FROM tasks", &[]).expect("rows"),
            rows
        );
        assert_eq!(
            client
                .conn
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('tasks')",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .expect("column count"),
            columns,
            "the previous table layout survives the rollback"
        );
        assert_eq!(client.pending_commit_ids(), vec![commit.clone()]);
        // Memory: every side effect of the successful reset is restored with
        // the rolled-back database.
        assert_eq!(client.schema.version, 1, "compiled schema");
        assert_eq!(client.subs.len(), prior_subs);
        assert_eq!(client.change_queue.len(), prior_changes);
        assert_eq!(client.sync_intent_queue.len(), prior_intents);
        assert_eq!(client.last_change, prior_last_change);
        assert_eq!(client.overlay_dirty.get(), prior_overlay_dirty);
        assert_eq!(client.sync_needed, prior_sync_needed);
        assert_eq!(client.upgrading, prior_upgrading);
        assert_eq!(client.stopped, prior_stopped);
        assert_eq!(client.schema_floor, prior_schema_floor);
        assert_eq!(client.active_round, prior_active_round);
        assert!(
            client.rejections.is_empty(),
            "the dropped-column rejection is rolled back too"
        );
        // The capture committed in its separate file before the failed replica
        // COMMIT. It belongs to v2 and cannot be exposed by the restored v1 core.
        let container = crate::previous_version::previous_version_container_path(path_str);
        assert!(std::path::Path::new(&container).exists());
        // The reader no longer needs its snapshot, so discard can clean the
        // replica's audit records along with the stale sibling file.
        drop(reader);
        let snapshot = client
            .previous_version_snapshot(&PreviousVersionReadSpec {
                table: "tasks".into(),
                ..Default::default()
            })
            .expect("refuse stale capture");
        assert!(!snapshot.available);
        assert_eq!(snapshot.current_version, 1);
        assert!(!std::path::Path::new(&container).exists());
        // The client remains usable: releasing the reader lets the identical
        // recreation run to completion, and the reset preserves the
        // incompatible intent until the send-time prepass classifies it
        // (§7.4.3/§7.4.4: the reset never touches the outbox).
        client
            .conn
            .busy_timeout(std::time::Duration::from_secs(1))
            .expect("busy timeout");
        client
            .recreate_with_schema(&dropped)
            .expect("the recreation succeeds once the reader releases");
        assert_eq!(client.schema.version, 2);
        assert_eq!(
            client.pending_commit_ids(),
            vec![commit.clone()],
            "the reset kept the incompatible commit pending"
        );
        assert!(
            client.rejections.is_empty(),
            "no rejection exists before the send-time prepass"
        );
        // The send boundary classifies and drops it.
        client
            .prepare_sync_round(false)
            .expect("the send prepass runs during round preparation");
        assert!(client.pending_commit_ids().is_empty());
        assert!(
            client
                .rejections
                .iter()
                .any(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE),
            "the dropped-column commit surfaced as a rejection at send time"
        );
        client.previous_version_discard();
        drop(client);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn the_send_time_incompatible_drop_is_atomic_and_publishes_once() {
        let v1 = previous_version_schema(1);
        let mut v2 = previous_version_schema(2);
        // v2 drops `note`, so the queued `dropped` upsert cannot re-encode.
        v2["tables"][0]["columns"] = json!([{ "name": "id", "type": "string", "nullable": false }]);
        let mut client = SyncClient::new("drop".to_string(), &v1, ClientLimits::default()).unwrap();
        let dropped = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("dropped")),
                    ("note".into(), json!("gone")),
                ]),
                base_version: None,
            }])
            .unwrap();
        // A full-row v1 upsert always carries the v1 columns, so the surviving
        // commit is a value-free delete (it encodes under any schema that still
        // has the table).
        let survivor = client
            .mutate(vec![Mutation::Delete {
                table: "tasks".into(),
                row_id: "gone".into(),
                base_version: None,
            }])
            .unwrap();
        client
            .recreate_with_schema(&v2)
            .expect("the reset preserves the outbox");
        assert_eq!(
            client.pending_commit_ids(),
            vec![dropped.clone(), survivor.clone()],
            "the reset preserves both commits"
        );
        assert!(client.rejections.is_empty(), "the reset classifies nothing");
        client.drain_change_batches();
        let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
        assert_eq!(rows.len(), 1, "only the dropped upsert has a visible row");

        // A fault anywhere in the atomic drop leaves the replica, the outbox,
        // the durable outcomes, the visible projection, the revision, and the
        // publish surface untouched. Clearing `syncNeeded` first keeps the
        // round's own status flip out of the assertion, so any published change
        // can only be the drop's.
        for fault in [
            "outcome-insert",
            "outbox-delete",
            "overlay-rebuild",
            "publish-revision",
        ] {
            client.set_sync_needed(false, false);
            client.drain_change_batches();
            let revision = client.local_revision();
            let trigger = match fault {
                "outcome-insert" => {
                    "CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(ABORT,'drop fault'); END"
                }
                "outbox-delete" => {
                    "CREATE TRIGGER fail_drop BEFORE DELETE ON _syncular_outbox BEGIN SELECT RAISE(ABORT,'drop fault'); END"
                }
                // The optimized replay removes only the dropped projection, so
                // the replay fault belongs on the DELETE; a publish fault lands
                // on the revision write that `finish_observation` performs after
                // every durable effect already succeeded.
                "publish-revision" => {
                    "CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(ABORT,'drop fault'); END"
                }
                _ => {
                    "CREATE TRIGGER fail_drop BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'drop fault'); END"
                }
            };
            client.conn.execute_batch(trigger).unwrap();
            let outcome = client
                .prepare_sync_round(false)
                .err()
                .unwrap_or_else(|| panic!("{fault}: a fault in the drop must fail the round"));
            assert!(
                matches!(*outcome, SyncOutcome::Failed { ref error_code, .. } if error_code == "storage.failed"),
                "{fault}: {outcome:?}"
            );
            client.conn.execute_batch("DROP TRIGGER fail_drop").unwrap();
            assert!(client.conn.is_autocommit(), "{fault}: no leaked savepoint");
            assert_eq!(
                client.pending_commit_ids(),
                vec![dropped.clone(), survivor.clone()],
                "{fault}: the outbox is restored"
            );
            assert!(
                client.rejections.is_empty(),
                "{fault}: no in-memory rejection survives"
            );
            assert!(
                client.commit_outcome(&dropped).unwrap().is_none(),
                "{fault}: the durable outcome rolled back"
            );
            assert_eq!(client.local_revision(), revision, "{fault}: revision");
            assert_eq!(
                client.query("SELECT * FROM tasks", &[]).unwrap(),
                rows,
                "{fault}: the visible projection is unchanged"
            );
            assert!(
                client.drain_change_batches().is_empty(),
                "{fault}: nothing is published"
            );
        }

        // A nested failure leaves the caller's transaction and earlier writes
        // intact; only the drop's savepoint is rolled back.
        client
            .conn
            .execute_batch(
                "BEGIN; INSERT INTO _syncular_meta(key,value) VALUES ('outerProbe','kept');
             CREATE TRIGGER fail_drop BEFORE INSERT ON _syncular_commit_outcomes
             BEGIN SELECT RAISE(ABORT,'nested drop fault'); END;",
            )
            .unwrap();
        assert!(client.drop_incompatible_outbox().is_err());
        assert!(!client.conn.is_autocommit());
        assert_eq!(client.get_meta("outerProbe").as_deref(), Some("kept"));
        assert_eq!(
            client.pending_commit_ids(),
            vec![dropped.clone(), survivor.clone()]
        );
        assert!(client.commit_outcome(&dropped).unwrap().is_none());
        client
            .conn
            .execute_batch("DROP TRIGGER fail_drop; COMMIT")
            .unwrap();

        // The successful drop publishes exactly once and leaves the surviving
        // intent queued for the same round. A log epoch is required before a
        // round builds push frames at all, so the classification provably runs
        // before any operation of the dropped commit is sent.
        client.set_meta(LOG_EPOCH_KEY, "epoch");
        client.set_sync_needed(false, false);
        client.drain_change_batches();
        let revision = client.local_revision();
        let prepared = client.prepare_sync_round(false).expect("the drop succeeds");
        assert_eq!(client.pending_commit_ids(), vec![survivor.clone()]);
        assert_eq!(
            prepared.meta.pushed_ids,
            vec![survivor.clone()],
            "the incompatible commit is classified before any operation is sent"
        );
        let rejection = client
            .rejections
            .iter()
            .find(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE)
            .expect("a sync.outbox_incompatible rejection");
        assert_eq!(rejection.client_commit_id, dropped);
        assert!(
            !rejection.retryable,
            "a schema-incompatible commit is final"
        );
        assert_eq!(
            client
                .commit_outcome(&dropped)
                .unwrap()
                .expect("a durable rejected outcome")
                .status,
            CommitOutcomeStatus::Rejected
        );
        assert_eq!(client.local_revision(), revision + 1, "one revision");
        let batches = client.drain_change_batches();
        assert_eq!(batches.len(), 1, "one change batch");
        assert!(
            batches[0].rejections_changed
                && batches[0].outcomes_changed
                && batches[0].status.is_some(),
            "{:?}",
            batches[0]
        );
        assert!(
            batches[0].tables.iter().any(|entry| entry.table == "tasks"),
            "{:?}",
            batches[0]
        );
        let visible = client.query("SELECT * FROM tasks", &[]).unwrap();
        assert!(
            visible.is_empty(),
            "the dropped projection is undone: {visible:?}"
        );

        // The observation's outer RELEASE (transaction COMMIT) is guarded too:
        // a rollback-journal reader holding SHARED makes it fail with the typed
        // busy classification, and releasing the reader lets the retry succeed.
        let path = temp_replica("outbox-drop-commit");
        let path_str = path.to_str().expect("path");
        let conn = Connection::open(path_str).expect("replica connection");
        let mut client =
            SyncClient::with_connection("drop-commit".into(), &v1, ClientLimits::default(), conn)
                .expect("v1 replica");
        let dropped = client
            .mutate(vec![Mutation::Upsert {
                table: "tasks".into(),
                values: Map::from_iter([
                    ("id".into(), json!("dropped")),
                    ("note".into(), json!("gone")),
                ]),
                base_version: None,
            }])
            .unwrap();
        client
            .recreate_with_schema(&v2)
            .expect("the reset preserves the outbox");
        assert_eq!(client.pending_commit_ids(), vec![dropped.clone()]);
        let rows = client.query("SELECT * FROM tasks", &[]).unwrap();
        assert_eq!(rows.len(), 1, "the optimistic row is visible");
        client.set_sync_needed(false, false);
        client.drain_change_batches();
        let revision = client.local_revision();
        let reader = Connection::open(path_str).expect("reader");
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM _syncular_meta;")
            .expect("reader snapshot");
        client
            .conn
            .busy_timeout(std::time::Duration::ZERO)
            .expect("busy timeout");
        let outcome = client
            .prepare_sync_round(false)
            .err()
            .expect("a blocked COMMIT must fail the round");
        assert!(
            matches!(*outcome, SyncOutcome::Failed { ref error_code, .. } if error_code == "client.storage_busy"),
            "{outcome:?}"
        );
        assert!(client.conn.is_autocommit(), "the savepoint is released");
        assert_eq!(client.pending_commit_ids(), vec![dropped.clone()]);
        assert!(client.rejections.is_empty());
        assert!(client.commit_outcome(&dropped).unwrap().is_none());
        assert_eq!(client.local_revision(), revision);
        assert_eq!(client.query("SELECT * FROM tasks", &[]).unwrap(), rows);
        assert!(client.drain_change_batches().is_empty());
        // The same round succeeds once the reader releases.
        drop(reader);
        client
            .conn
            .busy_timeout(std::time::Duration::from_secs(1))
            .expect("busy timeout");
        client
            .prepare_sync_round(false)
            .expect("the drop succeeds after the reader releases");
        assert!(client.pending_commit_ids().is_empty());
        assert!(client
            .rejections
            .iter()
            .any(|rejection| rejection.code == OUTBOX_INCOMPATIBLE_CODE));
        assert!(client.query("SELECT * FROM tasks", &[]).unwrap().is_empty());
        drop(client);
        std::fs::remove_file(path).expect("remove replica");
    }

    #[test]
    fn previous_version_read_reasons_come_from_live_client_state() {
        use crate::previous_version::{
            PreviousVersionReadSpec, PreviousVersionReason, PREVIOUS_VERSION_CONTAINER_SUFFIX,
        };
        let path = std::env::temp_dir()
            .join(format!("syncular-prev-wiring-{}.db", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let container = format!("{path}{PREVIOUS_VERSION_CONTAINER_SUFFIX}");
        {
            let mut setup = SyncClient::open_path(
                "wiring".to_owned(),
                &previous_version_schema(1),
                previous_version_limits(),
                &path,
            )
            .expect("v1 install");
            setup
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([("id".to_owned(), json!("t1"))]),
                    base_version: None,
                }])
                .expect("seed a row");
        }
        let mut client = SyncClient::open_path(
            "wiring".to_owned(),
            &previous_version_schema(2),
            previous_version_limits(),
            &path,
        )
        .expect("v2 bump captures");
        assert!(std::path::Path::new(&container).exists());
        let spec = PreviousVersionReadSpec {
            table: "tasks".to_owned(),
            ..Default::default()
        };

        // §7.3.5 lease error ⇒ lease-inactive, and the read discards.
        recapture_previous_version(&client);
        client.lease_state = Some(LeaseState {
            lease_id: None,
            expires_at_ms: None,
            error_code: Some("lease.expired".to_owned()),
        });
        let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
        assert_eq!(snapshot.reason, Some(PreviousVersionReason::LeaseInactive));
        assert!(!snapshot.available);
        assert!(!std::path::Path::new(&container).exists());

        // An expired lease uses the client clock (injected, no sleeps).
        recapture_previous_version(&client);
        client.set_now_ms(1_000);
        client.lease_state = Some(LeaseState {
            lease_id: Some("lease".to_owned()),
            expires_at_ms: Some(1_000),
            error_code: None,
        });
        let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
        assert_eq!(snapshot.reason, Some(PreviousVersionReason::LeaseInactive));
        assert!(!std::path::Path::new(&container).exists());
        client.lease_state = None;

        // A revoked subscription ⇒ scope-revoked.
        recapture_previous_version(&client);
        client.subs.push(subscription(SubState::Revoked, 0, None));
        let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
        assert_eq!(snapshot.reason, Some(PreviousVersionReason::ScopeRevoked));
        assert!(!std::path::Path::new(&container).exists());
        client.subs.clear();

        // Coverage completion: every ACTIVE subscription has a cursor and no
        // resume token — a still-resuming subscription is not completion.
        recapture_previous_version(&client);
        client
            .subs
            .push(subscription(SubState::Active, 0, Some("resume")));
        assert!(!client.previous_version_coverage_complete());
        let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
        assert!(snapshot.available);
        assert_eq!(snapshot.previous_version, Some(2));
        assert_eq!(snapshot.rows.len(), 1);

        recapture_previous_version(&client);
        client.subs[0].bootstrap_state = None;
        assert!(client.previous_version_coverage_complete());
        let snapshot = client.previous_version_snapshot(&spec).expect("snapshot");
        assert_eq!(
            snapshot.reason,
            Some(PreviousVersionReason::CoverageComplete)
        );
        assert!(!std::path::Path::new(&container).exists());
        client.subs.clear();

        // With no active subscription at all, coverage is NOT complete.
        assert!(!client.previous_version_coverage_complete());

        drop(client);
        let _ = std::fs::remove_file(&path);
    }

    /// RFC 0005 D7 lifetime drops. The read surface already proves the reasons
    /// come from live state; this proves the OTHER caller —
    /// `previous_version_lifetime_check`, the once-per-sync-round trigger —
    /// actually removes the container for lease-inactivity, coverage
    /// completion and scope revocation, and leaves it alone while the
    /// replacement bootstrap is still resuming.
    #[test]
    fn previous_version_lifetime_check_drops_on_lease_coverage_and_revocation() {
        let path = std::env::temp_dir()
            .join(format!(
                "syncular-prev-lifetime-{}.db",
                uuid::Uuid::new_v4()
            ))
            .to_string_lossy()
            .into_owned();
        let container = format!(
            "{path}{}",
            crate::previous_version::PREVIOUS_VERSION_CONTAINER_SUFFIX
        );
        let exists = || std::path::Path::new(&container).exists();
        {
            let mut setup = SyncClient::open_path(
                "lifetime".to_owned(),
                &previous_version_schema(1),
                previous_version_limits(),
                &path,
            )
            .expect("v1 install");
            setup
                .mutate(vec![Mutation::Upsert {
                    table: "tasks".to_owned(),
                    values: Map::from_iter([("id".to_owned(), json!("t1"))]),
                    base_version: None,
                }])
                .expect("seed a row");
        }
        let mut client = SyncClient::open_path(
            "lifetime".to_owned(),
            &previous_version_schema(2),
            previous_version_limits(),
            &path,
        )
        .expect("v2 bump captures");
        // Pin the clock so the 24h TTL never fires in this test (the TTL has
        // its own coverage); the capture record's createdAtMs is 1.
        client.set_now_ms(1_000);
        assert!(exists());

        // §7.3.5 lease error ⇒ the lifetime check drops the container.
        client.lease_state = Some(LeaseState {
            lease_id: None,
            expires_at_ms: None,
            error_code: Some("lease.expired".to_owned()),
        });
        client.previous_version_lifetime_check();
        assert!(!exists());
        client.lease_state = None;

        // §7.4.5 coverage completion (every active sub has a cursor and no
        // resume token) ⇒ drop.
        recapture_previous_version(&client);
        client.subs.push(subscription(SubState::Active, 0, None));
        client.previous_version_lifetime_check();
        assert!(!exists());
        client.subs.clear();

        // §3.3 scope revocation ⇒ drop.
        recapture_previous_version(&client);
        client.subs.push(subscription(SubState::Revoked, 0, None));
        client.previous_version_lifetime_check();
        assert!(!exists());
        client.subs.clear();

        // Negative control: a still-resuming active subscription is NOT
        // coverage completion, so the container survives the same call.
        recapture_previous_version(&client);
        client
            .subs
            .push(subscription(SubState::Active, 0, Some("resume")));
        client.previous_version_lifetime_check();
        assert!(exists());
        client.subs.clear();

        drop(client);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&container);
        let _ = std::fs::remove_file(format!("{container}-wal"));
        let _ = std::fs::remove_file(format!("{container}-shm"));
    }
}
