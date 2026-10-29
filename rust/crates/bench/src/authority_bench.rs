//! §12 local authority costs on file-backed databases:
//!
//! ```sh
//! cargo run --release -p syncular-bench --bin authority-bench -- [--dir PATH] [--writes 500] [--rows 100000] [--commit-rows 500]
//! ```
//!
//! Prints one JSON object (the databases are deleted unless `--dir` is given). Phases run in order against one authority file:
//! single-row `mutate` + `sync_until_idle` latency, bulk writes in
//! `--commit-rows` commits, file sizes, a fresh client's bootstrap, and attach
//! to a second authority acting as the remote server.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Map, Value};
use syncular_authority::LocalAuthority;
use syncular_client::native_transport::LocalAuthorityTransport;
use syncular_client::{
    ClientLimits, Mutation, SegmentRequest, SubscriptionRequest, SyncClient, SyncOutcome,
    Transport, TransportError,
};

/// The remote server: a second authority serving the attach upload.
struct AuthorityServer(LocalAuthority);

impl Transport for AuthorityServer {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.0.sync(request).map_err(|error| TransportError {
            code: error.code,
            message: error.message,
            details: error.details,
        })
    }
    fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "no socket"))
    }
    fn download_segment(
        &mut self,
        _request: &SegmentRequest,
        _on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::new("sync.transport_failed", "no segments"))
    }
    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Err(TransportError::new("sync.transport_failed", "no socket"))
    }
    fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
        Ok(())
    }
    fn realtime_close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn schema() -> Value {
    json!({
        "version": 1,
        "tables": [{
            "name": "entries",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "budget_id", "type": "string", "nullable": false },
                { "name": "label", "type": "string", "nullable": false },
                { "name": "amount", "type": "integer", "nullable": false },
                { "name": "note", "type": "string", "nullable": true }
            ],
            "primaryKey": "id",
            "scopes": [{ "pattern": "budget:{budget_id}", "column": "budget_id" }]
        }]
    })
}

fn entry(index: usize) -> Mutation {
    Mutation::Upsert {
        table: "entries".to_owned(),
        values: Map::from_iter([
            ("id".to_owned(), json!(format!("e{index:08}"))),
            ("budget_id".to_owned(), json!("b1")),
            ("label".to_owned(), json!(format!("Entry number {index}"))),
            ("amount".to_owned(), json!(index as i64 * 7 % 100_000)),
            ("note".to_owned(), json!(format!("note {index}"))),
        ]),
        base_version: None,
    }
}

fn open_client(path: &Path) -> SyncClient {
    let mut client = SyncClient::open_path_with_identity(
        None,
        &schema(),
        ClientLimits::default(),
        path.to_str().expect("utf-8 path"),
    )
    .expect("open the replica");
    client
        .subscribe_many(vec![SubscriptionRequest {
            id: "entries".to_owned(),
            table: "entries".to_owned(),
            scopes: vec![("budget_id".to_owned(), vec!["b1".to_owned()])],
            params: None,
        }])
        .expect("subscribe");
    client
}

fn sync_idle(client: &mut SyncClient, transport: &mut dyn Transport) {
    let outcome = client.sync_until_idle(transport, None);
    assert!(
        matches!(outcome, SyncOutcome::Ok(_)),
        "{:?}",
        outcome.to_json()
    );
}

/// Size of the main database file after a WAL checkpoint.
fn file_bytes(path: &Path) -> u64 {
    let conn = rusqlite::Connection::open(path).expect("open for checkpoint");
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .expect("checkpoint");
    std::fs::metadata(path).expect("stat").len()
}

fn count(path: &Path, sql: &str) -> i64 {
    rusqlite::Connection::open(path)
        .expect("open for count")
        .query_row(sql, [], |row| row.get(0))
        .expect("count")
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p).ceil() as usize).clamp(1, sorted.len()) - 1]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let option = |name: &str| {
        args.iter().position(|arg| arg == name).map(|at| {
            args.get(at + 1)
                .unwrap_or_else(|| panic!("{name} needs a value"))
        })
    };
    let number = |name: &str, default: usize| {
        option(name).map_or(default, |value| value.parse().expect("a number"))
    };
    let writes = number("--writes", 500);
    let rows = number("--rows", 100_000);
    let commit_rows = number("--commit-rows", 500);
    let dir: PathBuf = option("--dir").map_or_else(
        || std::env::temp_dir().join(format!("syncular-authority-bench-{}", std::process::id())),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir).expect("create the bench directory");
    let authority_path = dir.join("authority.sqlite");
    let replica_path = dir.join("replica.sqlite");
    let fresh_path = dir.join("fresh.sqlite");
    let remote_path = dir.join("remote.sqlite");
    for path in [&authority_path, &replica_path, &fresh_path, &remote_path] {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    let schema = schema();
    let remote = AuthorityServer(
        LocalAuthority::open(remote_path.to_str().unwrap(), &schema).expect("remote"),
    );
    let mut transport =
        LocalAuthorityTransport::new(authority_path.to_str().unwrap(), remote, true);
    transport
        .open_local_authority(&schema, Some(replica_path.to_str().unwrap()))
        .expect("open the local authority");
    let mut client = open_client(&replica_path);
    sync_idle(&mut client, &mut transport);

    let mut next = 0;
    let mut latencies = Vec::with_capacity(writes);
    for _ in 0..writes {
        let start = Instant::now();
        client.mutate(vec![entry(next)]).expect("mutate");
        sync_idle(&mut client, &mut transport);
        latencies.push(start.elapsed().as_secs_f64() * 1000.0);
        next += 1;
    }
    assert!(client.pending_commit_ids().is_empty());
    latencies.sort_by(f64::total_cmp);

    let bulk_start = Instant::now();
    let mut bulk_commits = 0;
    while next < writes + rows {
        let upper = (next + commit_rows).min(writes + rows);
        client
            .mutate((next..upper).map(entry).collect())
            .expect("mutate a commit");
        sync_idle(&mut client, &mut transport);
        bulk_commits += 1;
        next = upper;
    }
    let bulk_ms = bulk_start.elapsed().as_secs_f64() * 1000.0;
    assert!(client.pending_commit_ids().is_empty());
    let total = writes + rows;
    assert_eq!(
        count(&replica_path, "SELECT count(*) FROM entries") as usize,
        total
    );

    let replica_bytes = file_bytes(&replica_path);
    let authority_bytes = file_bytes(&authority_path);
    let retained_commits = count(&authority_path, "SELECT count(*) FROM sync_commits");

    let mut fresh = open_client(&fresh_path);
    let bootstrap_start = Instant::now();
    sync_idle(&mut fresh, &mut transport);
    let bootstrap_ms = bootstrap_start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(
        count(&fresh_path, "SELECT count(*) FROM entries") as usize,
        total
    );

    let attach_start = Instant::now();
    transport.attach_local_authority().expect("attach");
    let attach_ms = attach_start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(transport.local_authority_state(), Some("attached"));
    drop(transport);
    let remote_rows = count(&remote_path, "SELECT count(*) FROM entries");
    assert_eq!(remote_rows as usize, total);

    if option("--dir").is_none() {
        std::fs::remove_dir_all(&dir).expect("remove the bench directory");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "dir": dir,
            "writeLatencyMs": {
                "count": writes,
                "p50": percentile(&latencies, 0.50),
                "p95": percentile(&latencies, 0.95),
            },
            "bulk": {
                "rows": total,
                "commits": bulk_commits + writes,
                "bulkMs": bulk_ms,
                "replicaBytes": replica_bytes,
                "authorityBytes": authority_bytes,
                "authorityCommitsRetained": retained_commits,
            },
            "bootstrapMs": bootstrap_ms,
            "attachMs": attach_ms,
        }))
        .unwrap()
    );
}
