//! Per-unit costs of one-row primary-key units (§4.1, §4.8) against the §12
//! local authority acting as the server:
//!
//! ```sh
//! cargo run --release -p syncular-bench --bin unit-bench -- [--dir PATH] [--sizes 500,2000,10000]
//! ```
//!
//! One authority file holds 20,000 `catalogue_codes` rows across two
//! releases. For each lane (`set_window` over `code_id`, then
//! `subscribe_many`) and size N, a fresh client file registers N units
//! `{ code_id }` (one per row, the `code:{code_id}` pattern on the primary
//! key) and the bench reports the first sync to idle, a steady-state sync,
//! a one-key window replace, a commit touching a referenced row, and the
//! client's persisted state. Prints one JSON object.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use syncular_authority::LocalAuthority;
use syncular_client::{
    ClientLimits, Mutation, SegmentRequest, SyncClient, SyncOutcome, Transport, TransportError,
    WindowBase,
};

const ROWS: usize = 20_000;

/// The authority as the server, counting rounds and bytes and timing `sync`.
struct Counted {
    authority: LocalAuthority,
    rounds: usize,
    request_bytes: Vec<usize>,
    response_bytes: usize,
    authority_time: Duration,
    authority_ms_per_round: Vec<f64>,
}

impl Counted {
    fn reset(&mut self) {
        self.rounds = 0;
        self.request_bytes.clear();
        self.response_bytes = 0;
        self.authority_time = Duration::ZERO;
        self.authority_ms_per_round.clear();
    }
}

impl Transport for Counted {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let start = Instant::now();
        let response = self.authority.sync(request);
        self.authority_time += start.elapsed();
        self.authority_ms_per_round.push(ms(start.elapsed()));
        self.rounds += 1;
        self.request_bytes.push(request.len());
        let response = response.map_err(|error| TransportError {
            code: error.code,
            message: error.message,
            details: error.details,
        })?;
        self.response_bytes += response.len();
        Ok(response)
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
            "name": "catalogue_codes",
            "columns": [
                { "name": "id", "type": "string", "nullable": false },
                { "name": "release_id", "type": "string", "nullable": false },
                { "name": "code", "type": "string", "nullable": false },
                { "name": "title", "type": "string", "nullable": false }
            ],
            "primaryKey": "id",
            "scopes": [
                { "pattern": "release:{release_id}", "column": "release_id" },
                { "pattern": "code:{code_id}", "column": "id" }
            ]
        }]
    })
}

fn code_id(index: usize) -> String {
    format!("c{index:05}")
}

fn row(index: usize, revision: usize) -> Mutation {
    Mutation::Upsert {
        table: "catalogue_codes".to_owned(),
        values: Map::from_iter([
            ("id".to_owned(), json!(code_id(index))),
            ("release_id".to_owned(), json!(format!("r{}", index % 2))),
            ("code".to_owned(), json!(format!("K{index:05}.{revision}"))),
            (
                "title".to_owned(),
                json!(format!("Catalogue code {index:05} revision {revision:06}")),
            ),
        ]),
        base_version: None,
    }
}

fn open_client(path: &Path) -> SyncClient {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    SyncClient::open_path_with_identity(
        None,
        &schema(),
        ClientLimits::default(),
        path.to_str().expect("utf-8 path"),
    )
    .expect("open the replica")
}

fn ok(outcome: SyncOutcome) {
    assert!(
        matches!(outcome, SyncOutcome::Ok(_)),
        "{:?}",
        outcome.to_json()
    );
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn count(path: &Path, sql: &str) -> i64 {
    rusqlite::Connection::open(path)
        .expect("open for count")
        .query_row(sql, [], |row| row.get(0))
        .expect("count")
}

/// Main file size after a WAL checkpoint, and bytes and rows per table.
fn persisted(path: &Path) -> Value {
    let conn = rusqlite::Connection::open(path).expect("open for size");
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .expect("checkpoint");
    let tables: Vec<(String, i64)> = conn
        .prepare("SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("dbstat");
    let tables: Map<String, Value> = tables
        .into_iter()
        .filter(|(_, bytes)| *bytes > 4096)
        .map(|(name, bytes)| {
            let rows = conn
                .query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |row| {
                    row.get::<_, i64>(0)
                })
                .ok();
            (name, json!({ "bytes": bytes, "rows": rows }))
        })
        .collect();
    json!({
        "fileBytes": std::fs::metadata(path).expect("stat").len(),
        "tables": tables,
    })
}

/// Rows the replica holds and its units per status and reason: a unit the
/// client failed during bootstrap holds no rows.
fn held(client: &SyncClient, path: &Path) -> Value {
    let mut units = Map::new();
    for unit in client.units().expect("units") {
        let key = format!(
            "{}{}{}",
            unit.status.name(),
            unit.reason_code.as_deref().map_or("", |_| ":"),
            unit.reason_code.as_deref().unwrap_or("")
        );
        let entry = units.entry(key).or_insert(json!(0));
        *entry = json!(entry.as_i64().unwrap() + 1);
    }
    json!({
        "rows": count(path, "SELECT count(*) FROM catalogue_codes"),
        "units": units,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let option = |name: &str| {
        args.iter().position(|arg| arg == name).map(|at| {
            args.get(at + 1)
                .unwrap_or_else(|| panic!("{name} needs a value"))
        })
    };
    let sizes: Vec<usize> = option("--sizes").map_or(vec![500, 2_000, 10_000], |value| {
        value
            .split(',')
            .map(|n| n.parse().expect("a size"))
            .collect()
    });
    let dir: PathBuf = option("--dir").map_or_else(
        || std::env::temp_dir().join(format!("syncular-unit-bench-{}", std::process::id())),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir).expect("create the bench directory");
    let authority_path = dir.join("authority.sqlite");
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", authority_path.display()));
    }
    let mut authority =
        LocalAuthority::open(authority_path.to_str().unwrap(), &schema()).expect("authority");
    authority.set_max_subscriptions_per_request(usize::MAX);
    let mut transport = Counted {
        authority,
        rounds: 0,
        request_bytes: Vec::new(),
        response_bytes: 0,
        authority_time: Duration::ZERO,
        authority_ms_per_round: Vec::new(),
    };

    // The writer seeds the rows and later touches referenced ones; it holds
    // no unit, so it only pushes.
    let mut writer = open_client(&dir.join("writer.sqlite"));
    for chunk in (0..ROWS).collect::<Vec<_>>().chunks(500) {
        writer
            .mutate(chunk.iter().map(|&index| row(index, 0)).collect())
            .expect("seed");
        ok(writer.sync_until_idle_with_deadline(&mut transport, None, None));
    }

    let base = WindowBase {
        variable: "code_id".to_owned(),
        fixed_scopes: Default::default(),
    };
    let mut results = Vec::new();
    let mut revision = 0;
    for lane in ["window", "subscribe"] {
        for &n in &sizes {
            let path = dir.join(format!("client-{lane}-{n}.sqlite"));
            let mut client = open_client(&path);
            let mut keys: Vec<String> = (0..n).map(code_id).collect();
            let unit = |key: &str| [("code_id".to_owned(), key.to_owned())].into();

            // First sync: register N units, sync to idle.
            transport.reset();
            let start = Instant::now();
            if lane == "window" {
                client.set_window(&base, &keys).expect("set window");
            } else {
                client
                    .subscribe_many(keys.iter().map(|key| unit(key)).collect())
                    .expect("subscribe");
            }
            let register = start.elapsed();
            ok(client.sync_until_idle_with_deadline(&mut transport, None, None));
            let first_wall = start.elapsed();
            let first = json!({
                "held": held(&client, &path),
                "registerMs": ms(register),
                "wallToIdleMs": ms(first_wall),
                "rounds": transport.rounds,
                "requestBytes": transport.request_bytes.iter().sum::<usize>(),
                "requestBytesPerRound": transport.request_bytes,
                "responseBytes": transport.response_bytes,
                "authorityMs": ms(transport.authority_time),
                "authorityMsPerRound": transport.authority_ms_per_round,
            });

            // Steady state: nothing changed, the list travels by digest.
            let mut steady = Vec::new();
            for _ in 0..20 {
                transport.reset();
                let start = Instant::now();
                ok(client.sync(&mut transport));
                let total = start.elapsed();
                assert_eq!(transport.rounds, 1);
                steady.push((
                    transport.request_bytes[0],
                    transport.response_bytes,
                    ms(transport.authority_time),
                    ms(total - transport.authority_time),
                ));
            }
            let steady = json!({
                "requestBytes": steady[0].0,
                "responseBytes": steady[0].1,
                "authorityMsMedian": median(steady.iter().map(|s| s.2).collect()),
                "clientMsMedian": median(steady.iter().map(|s| s.3).collect()),
            });

            // One key change: replace one key, sync to idle. The window lane
            // evicts the leaving row; unsubscribe keeps it.
            let mut changes = Vec::new();
            let mut failure = None;
            for k in 0..10 {
                let old = std::mem::replace(&mut keys[k], code_id(n + k));
                transport.reset();
                let start = Instant::now();
                let changed = if lane == "window" {
                    client.set_window(&base, &keys).map(|_| ())
                } else {
                    client
                        .unsubscribe(&ssp2::unit_id(&[("code_id".to_owned(), old.clone())]))
                        .and_then(|()| client.subscribe(unit(&keys[k])).map(|_| ()))
                };
                let local = start.elapsed();
                if let Err(error) = changed {
                    keys[k] = old;
                    failure = Some(json!({ "error": error, "afterMs": ms(local) }));
                    break;
                }
                ok(client.sync_until_idle_with_deadline(&mut transport, None, None));
                let total = start.elapsed();
                changes.push((
                    local,
                    transport.rounds,
                    transport.request_bytes.iter().copied().max().unwrap_or(0),
                    transport.response_bytes,
                    ms(transport.authority_time),
                    ms(total - transport.authority_time),
                ));
            }
            let change = match failure {
                Some(failure) => failure,
                None => json!({
                    "localChangeMsMedian": median(changes.iter().map(|c| ms(c.0)).collect()),
                    "roundsMedian": median(changes.iter().map(|c| c.1 as f64).collect()),
                    "travelingRequestBytesMedian": median(changes.iter().map(|c| c.2 as f64).collect()),
                    "responseBytesMedian": median(changes.iter().map(|c| c.3 as f64).collect()),
                    "authorityMsMedian": median(changes.iter().map(|c| c.4).collect()),
                    "clientMsMedian": median(changes.iter().map(|c| c.5).collect()),
                }),
            };

            // One commit touching a referenced row, then a sync to idle.
            let mut commits = Vec::new();
            for k in 0..10 {
                revision += 1;
                writer.mutate(vec![row(10 + k, revision)]).expect("touch");
                ok(writer.sync_until_idle_with_deadline(&mut transport, None, None));
                transport.reset();
                let start = Instant::now();
                ok(client.sync_until_idle_with_deadline(&mut transport, None, None));
                let total = start.elapsed();
                commits.push((
                    transport.rounds,
                    transport.response_bytes,
                    ms(transport.authority_time),
                    ms(total - transport.authority_time),
                ));
            }
            assert_eq!(
                count(
                    &path,
                    &format!(
                        "SELECT count(*) FROM catalogue_codes WHERE id='{}' AND code='K00019.{revision}'",
                        code_id(19)
                    )
                ),
                1
            );
            let commit = json!({
                "roundsMedian": median(commits.iter().map(|c| c.0 as f64).collect()),
                "responseBytesMedian": median(commits.iter().map(|c| c.1 as f64).collect()),
                "authorityMsMedian": median(commits.iter().map(|c| c.2).collect()),
                "clientMsMedian": median(commits.iter().map(|c| c.3).collect()),
            });

            let held_after = held(&client, &path);
            drop(client);
            results.push(json!({
                "heldAfter": held_after,
                "lane": lane,
                "n": n,
                "firstSync": first,
                "steadySync": steady,
                "oneKeyChange": change,
                "touchedRowCommit": commit,
                "persisted": persisted(&path),
            }));
        }
    }

    if option("--dir").is_none() {
        std::fs::remove_dir_all(&dir).expect("remove the bench directory");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({ "rows": ROWS, "sizes": results })).unwrap()
    );
}
