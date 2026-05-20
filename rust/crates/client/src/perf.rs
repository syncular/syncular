use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::json;
use std::time::{Duration, Instant};
use syncular_client::client::{SyncularClient, SyncularClientConfig};
use syncular_client::crdt_field::CrdtFieldId;
use syncular_client::diesel_sqlite::DieselSqliteStore;
use syncular_client::fixtures::todo::app_schema as generated_app_schema;
use syncular_client::fixtures::todo::generated::{
    NewTask, SyncularGeneratedMutationsExt, TaskPatch,
};
use syncular_client::store::{SyncStateStore, SyncStore};
use syncular_client::transport::{
    HttpSyncTransport, RealtimeEvent, RealtimeTransport, SyncTransport, SyncTransportConfig,
};
use syncular_testkit::{
    open_app_client_with_server_in_memory, AppFixtureOptions, AppTestHttpServer, AppTestServer,
};

const ACTOR_ID: &str = "rust-perf-user";
const PROJECT_ID: &str = "rust-perf-project";

#[derive(Debug, Clone, Copy)]
struct Options {
    operations: usize,
    rounds: usize,
    warmup_operations: usize,
    stress: bool,
    stress_writers: usize,
    stress_readers: usize,
    stress_batches: usize,
    stress_batch_size: usize,
    stress_transport: StressTransport,
    realtime_stress: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StressTransport {
    Http,
    Ws,
}

impl StressTransport {
    fn label(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Ws => "ws",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePerfReport {
    generated_at: String,
    options: NativePerfOptions,
    metrics: Vec<NativePerfMetric>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StressPerfReport {
    generated_at: String,
    options: StressPerfOptions,
    checks: StressChecks,
    metrics: Vec<NativePerfMetric>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePerfOptions {
    operations: usize,
    rounds: usize,
    warmup_operations: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StressPerfOptions {
    transport: &'static str,
    writers: usize,
    readers: usize,
    batches: usize,
    batch_size: usize,
    total_rows: usize,
    realtime: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePerfMetric {
    name: String,
    iterations: usize,
    mean: f64,
    median: f64,
    p95: f64,
    p99: f64,
    min: f64,
    max: f64,
    std_dev: f64,
    rows: usize,
    outbox_commits: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StressChecks {
    total_rows: usize,
    server_rows: usize,
    reader_rows: Vec<usize>,
    writer_outbox_commits: usize,
    realtime_events: usize,
}

fn main() -> Result<()> {
    let options = parse_options()?;
    if options.stress {
        let report = if options.realtime_stress {
            benchmark_long_lived_realtime_stress(options)?
        } else {
            benchmark_http_multi_client_stress(options)?
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    let report = NativePerfReport {
        generated_at: "runtime".to_string(),
        options: NativePerfOptions {
            operations: options.operations,
            rounds: options.rounds,
            warmup_operations: options.warmup_operations,
        },
        metrics: vec![
            benchmark_open_client(options)?,
            benchmark_insert_batch(options)?,
            benchmark_update_batch(options)?,
            benchmark_list_tasks_json(options)?,
            benchmark_crdt_text_updates(options)?,
            benchmark_e2e_push_batch(options)?,
            benchmark_e2e_pull_catchup(options)?,
            benchmark_e2e_client_to_client_catchup(options)?,
            benchmark_http_push_batch(options)?,
            benchmark_http_pull_catchup(options)?,
            benchmark_http_client_to_client_catchup(options)?,
            benchmark_ws_push_batch(options)?,
            benchmark_ws_client_to_client_catchup(options)?,
        ],
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn parse_options() -> Result<Options> {
    let mut options = Options {
        operations: 100,
        rounds: 5,
        warmup_operations: 10,
        stress: false,
        stress_writers: 4,
        stress_readers: 4,
        stress_batches: 20,
        stress_batch_size: 250,
        stress_transport: StressTransport::Http,
        realtime_stress: false,
    };

    for arg in std::env::args().skip(1) {
        if arg == "--json" {
            continue;
        }
        if arg == "--stress" {
            options.stress = true;
            continue;
        }
        if arg == "--realtime-stress" {
            options.stress = true;
            options.realtime_stress = true;
            options.stress_transport = StressTransport::Ws;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--operations=") {
            options.operations = parse_positive_usize("--operations", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--rounds=") {
            options.rounds = parse_positive_usize("--rounds", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--warmup=") {
            options.warmup_operations = parse_positive_usize("--warmup", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--stress-writers=") {
            options.stress_writers = parse_positive_usize("--stress-writers", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--stress-readers=") {
            options.stress_readers = parse_positive_usize("--stress-readers", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--stress-batches=") {
            options.stress_batches = parse_positive_usize("--stress-batches", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--stress-batch-size=") {
            options.stress_batch_size = parse_positive_usize("--stress-batch-size", value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--stress-transport=") {
            options.stress_transport = parse_stress_transport(value)?;
            continue;
        }
        bail!("unknown argument: {arg}");
    }

    Ok(options)
}

fn parse_stress_transport(value: &str) -> Result<StressTransport> {
    match value {
        "http" => Ok(StressTransport::Http),
        "ws" => Ok(StressTransport::Ws),
        _ => bail!("--stress-transport must be http or ws"),
    }
}

fn parse_positive_usize(name: &str, value: &str) -> Result<usize> {
    let parsed = value.parse::<usize>()?;
    if parsed == 0 {
        bail!("{name} must be greater than zero");
    }
    Ok(parsed)
}

fn open_client(name: &str) -> Result<SyncularClient> {
    Ok(SyncularClient::open_with_schema(
        SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url: "http://127.0.0.1:9/api/sync".to_string(),
            client_id: format!("rust-perf-{name}"),
            actor_id: ACTOR_ID.to_string(),
            project_id: Some(PROJECT_ID.to_string()),
        },
        generated_app_schema(),
    )?)
}

fn benchmark_open_client(options: Options) -> Result<NativePerfMetric> {
    for index in 0..options.warmup_operations {
        let _client = open_client(&format!("open-warmup-{index}"))?;
    }

    let mut times = Vec::with_capacity(options.rounds);
    for index in 0..options.rounds {
        let started_at = Instant::now();
        let mut client = open_client(&format!("open-measured-{index}"))?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);
        let rows = count_tasks(&mut client)?;
        if rows != 0 {
            bail!("new client unexpectedly had task rows: {rows}");
        }
    }

    summarize("rust_native_open_client", &times, 0, 0)
}

fn benchmark_insert_batch(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let mut client = open_client("insert-batch-warmup")?;
        insert_tasks(&mut client, "warmup-insert", 0, options.warmup_operations)?;
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for _ in 0..options.rounds {
        let mut client = open_client("insert-batch")?;
        let started_at = Instant::now();
        insert_tasks(&mut client, "measured-insert", 0, options.operations)?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);
        rows = count_tasks(&mut client)?;
        outbox_commits = count_outbox(&mut client)?;
    }

    summarize(
        &format!("rust_native_insert_batch_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_update_batch(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let mut client = open_client("update-batch-warmup")?;
        let ids = insert_tasks(&mut client, "update-warmup-seed", 0, options.operations)?;
        update_tasks(
            &mut client,
            &ids,
            "warmup-update",
            0,
            options.warmup_operations,
        )?;
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for _ in 0..options.rounds {
        let mut client = open_client("update-batch")?;
        let ids = insert_tasks(&mut client, "update-seed", 0, options.operations)?;
        let started_at = Instant::now();
        update_tasks(&mut client, &ids, "measured-update", 0, options.operations)?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);
        rows = count_tasks(&mut client)?;
        outbox_commits = count_outbox(&mut client)?;
    }

    summarize(
        &format!("rust_native_update_batch_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_list_tasks_json(options: Options) -> Result<NativePerfMetric> {
    for _ in 0..options.warmup_operations {
        let mut client = open_client("list-json-warmup")?;
        insert_tasks(&mut client, "list-warmup-seed", 0, options.operations * 4)?;
        let rows = count_tasks(&mut client)?;
        if rows < options.operations {
            bail!("list warmup returned too few rows: {rows}");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for _ in 0..options.rounds {
        let mut client = open_client("list-json")?;
        insert_tasks(&mut client, "list-seed", 0, options.operations * 4)?;
        let started_at = Instant::now();
        rows = count_tasks(&mut client)?;
        if rows < options.operations {
            bail!("list benchmark returned too few rows: {rows}");
        }
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);
        outbox_commits = count_outbox(&mut client)?;
    }

    summarize(
        &format!("rust_native_list_tasks_json_{}", options.operations * 4),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_crdt_text_updates(options: Options) -> Result<NativePerfMetric> {
    for index in 0..options.warmup_operations {
        let mut client = open_client("crdt-text-warmup")?;
        let row_id = format!("rust-perf-crdt-warmup-task-{index}");
        client
            .mutations()
            .tasks()
            .insert(NewTask::new(&row_id, "", ACTOR_ID, Some(PROJECT_ID)))?;
        let field = client.open_crdt_field(CrdtFieldId::new("tasks", &row_id, "title"))?;
        client.apply_crdt_field_text(&field, &format!("warmup CRDT {index}"))?;
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let mut client = open_client("crdt-text")?;
        let row_id = format!("rust-perf-crdt-task-{round}");
        client
            .mutations()
            .tasks()
            .insert(NewTask::new(&row_id, "", ACTOR_ID, Some(PROJECT_ID)))?;
        let field = client.open_crdt_field(CrdtFieldId::new("tasks", &row_id, "title"))?;
        let started_at = Instant::now();
        for index in 0..options.operations {
            client.apply_crdt_field_text(&field, &format!("measured CRDT {index}"))?;
        }
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        let materialized = client.materialize_crdt_field(&field)?;
        if !materialized
            .value
            .as_str()
            .unwrap_or_default()
            .contains("CRDT")
        {
            bail!("CRDT materialization mismatch");
        }
        rows = count_tasks(&mut client)?;
        outbox_commits = count_outbox(&mut client)?;
    }

    summarize(
        &format!("rust_native_crdt_text_updates_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_e2e_push_batch(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, _) = open_e2e_pair("push-warmup")?;
        insert_tasks(
            &mut writer.client,
            "e2e-push-warmup",
            0,
            options.warmup_operations,
        )?;
        writer.client.sync_http()?;
        if server.rows("tasks").len() != options.warmup_operations {
            bail!("e2e push warmup server row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, _) = open_e2e_pair(&format!("push-{round}"))?;
        insert_tasks(
            &mut writer.client,
            "e2e-push-measured",
            0,
            options.operations,
        )?;
        let started_at = Instant::now();
        writer.client.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        rows = server.rows("tasks").len();
        if rows != options.operations {
            bail!(
                "e2e push server row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer.client)?;
    }

    summarize(
        &format!("rust_e2e_push_batch_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_e2e_pull_catchup(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, _, mut reader) = open_e2e_pair("pull-warmup")?;
        commit_server_tasks(&server, "e2e-pull-warmup", 0, options.warmup_operations)?;
        reader.client.sync_http()?;
        let rows = count_tasks(&mut reader.client)?;
        if rows != options.warmup_operations {
            bail!("e2e pull warmup reader row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, _, mut reader) = open_e2e_pair(&format!("pull-{round}"))?;
        commit_server_tasks(&server, "e2e-pull-measured", 0, options.operations)?;
        let started_at = Instant::now();
        reader.client.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        rows = count_tasks(&mut reader.client)?;
        if rows != options.operations {
            bail!(
                "e2e pull reader row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut reader.client)?;
    }

    summarize(
        &format!("rust_e2e_pull_catchup_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_e2e_client_to_client_catchup(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, mut reader) = open_e2e_pair("client-to-client-warmup")?;
        insert_tasks(
            &mut writer.client,
            "e2e-client-to-client-warmup",
            0,
            options.warmup_operations,
        )?;
        writer.client.sync_http()?;
        reader.client.sync_http()?;
        if server.rows("tasks").len() != options.warmup_operations {
            bail!("e2e client-to-client warmup server row count mismatch");
        }
        let rows = count_tasks(&mut reader.client)?;
        if rows != options.warmup_operations {
            bail!("e2e client-to-client warmup reader row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, mut reader) = open_e2e_pair(&format!("client-to-client-{round}"))?;
        insert_tasks(
            &mut writer.client,
            "e2e-client-to-client-measured",
            0,
            options.operations,
        )?;
        let started_at = Instant::now();
        writer.client.sync_http()?;
        reader.client.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        if server.rows("tasks").len() != options.operations {
            bail!("e2e client-to-client server row count mismatch");
        }
        rows = count_tasks(&mut reader.client)?;
        if rows != options.operations {
            bail!(
                "e2e client-to-client reader row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer.client)?;
    }

    summarize(
        &format!("rust_e2e_client_to_client_catchup_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_http_push_batch(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, _) = open_http_pair("http-push-warmup")?;
        insert_tasks(
            &mut writer,
            "http-push-warmup",
            0,
            options.warmup_operations,
        )?;
        writer.sync_http()?;
        if server.app_server().rows("tasks").len() != options.warmup_operations {
            bail!("HTTP push warmup server row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, _) = open_http_pair(&format!("http-push-{round}"))?;
        insert_tasks(&mut writer, "http-push-measured", 0, options.operations)?;
        let started_at = Instant::now();
        writer.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        rows = server.app_server().rows("tasks").len();
        if rows != options.operations {
            bail!(
                "HTTP push server row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer)?;
    }

    summarize(
        &format!("rust_http_push_batch_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_http_pull_catchup(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, _, mut reader) = open_http_pair("http-pull-warmup")?;
        commit_server_tasks(
            server.app_server(),
            "http-pull-warmup",
            0,
            options.warmup_operations,
        )?;
        reader.sync_http()?;
        let rows = count_tasks(&mut reader)?;
        if rows != options.warmup_operations {
            bail!("HTTP pull warmup reader row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, _, mut reader) = open_http_pair(&format!("http-pull-{round}"))?;
        commit_server_tasks(
            server.app_server(),
            "http-pull-measured",
            0,
            options.operations,
        )?;
        let started_at = Instant::now();
        reader.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        rows = count_tasks(&mut reader)?;
        if rows != options.operations {
            bail!(
                "HTTP pull reader row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut reader)?;
    }

    summarize(
        &format!("rust_http_pull_catchup_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_http_client_to_client_catchup(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, mut reader) = open_http_pair("http-client-to-client-warmup")?;
        insert_tasks(
            &mut writer,
            "http-client-to-client-warmup",
            0,
            options.warmup_operations,
        )?;
        writer.sync_http()?;
        reader.sync_http()?;
        if server.app_server().rows("tasks").len() != options.warmup_operations {
            bail!("HTTP client-to-client warmup server row count mismatch");
        }
        let rows = count_tasks(&mut reader)?;
        if rows != options.warmup_operations {
            bail!("HTTP client-to-client warmup reader row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, mut reader) =
            open_http_pair(&format!("http-client-to-client-{round}"))?;
        insert_tasks(
            &mut writer,
            "http-client-to-client-measured",
            0,
            options.operations,
        )?;
        let started_at = Instant::now();
        writer.sync_http()?;
        reader.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        if server.app_server().rows("tasks").len() != options.operations {
            bail!("HTTP client-to-client server row count mismatch");
        }
        rows = count_tasks(&mut reader)?;
        if rows != options.operations {
            bail!(
                "HTTP client-to-client reader row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer)?;
    }

    summarize(
        &format!("rust_http_client_to_client_catchup_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_ws_push_batch(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, _) = open_http_pair("ws-push-warmup")?;
        insert_tasks(&mut writer, "ws-push-warmup", 0, options.warmup_operations)?;
        writer.sync_ws()?;
        if server.app_server().rows("tasks").len() != options.warmup_operations {
            bail!("WS push warmup server row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, _) = open_http_pair(&format!("ws-push-{round}"))?;
        insert_tasks(&mut writer, "ws-push-measured", 0, options.operations)?;
        let started_at = Instant::now();
        writer.sync_ws()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        rows = server.app_server().rows("tasks").len();
        if rows != options.operations {
            bail!(
                "WS push server row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer)?;
    }

    summarize(
        &format!("rust_ws_push_batch_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_ws_client_to_client_catchup(options: Options) -> Result<NativePerfMetric> {
    if options.warmup_operations > 0 {
        let (server, mut writer, mut reader) = open_http_pair("ws-client-to-client-warmup")?;
        insert_tasks(
            &mut writer,
            "ws-client-to-client-warmup",
            0,
            options.warmup_operations,
        )?;
        writer.sync_ws()?;
        reader.sync_http()?;
        if server.app_server().rows("tasks").len() != options.warmup_operations {
            bail!("WS client-to-client warmup server row count mismatch");
        }
        let rows = count_tasks(&mut reader)?;
        if rows != options.warmup_operations {
            bail!("WS client-to-client warmup reader row count mismatch");
        }
    }

    let mut times = Vec::with_capacity(options.rounds);
    let mut rows = 0;
    let mut outbox_commits = 0;
    for round in 0..options.rounds {
        let (server, mut writer, mut reader) =
            open_http_pair(&format!("ws-client-to-client-{round}"))?;
        insert_tasks(
            &mut writer,
            "ws-client-to-client-measured",
            0,
            options.operations,
        )?;
        let started_at = Instant::now();
        writer.sync_ws()?;
        reader.sync_http()?;
        times.push(started_at.elapsed().as_secs_f64() * 1000.0);

        if server.app_server().rows("tasks").len() != options.operations {
            bail!("WS client-to-client server row count mismatch");
        }
        rows = count_tasks(&mut reader)?;
        if rows != options.operations {
            bail!(
                "WS client-to-client reader row count mismatch: expected {}, got {rows}",
                options.operations
            );
        }
        outbox_commits = count_outbox(&mut writer)?;
    }

    summarize(
        &format!("rust_ws_client_to_client_catchup_{}", options.operations),
        &times,
        rows,
        outbox_commits,
    )
}

fn benchmark_http_multi_client_stress(options: Options) -> Result<StressPerfReport> {
    let total_rows = options.stress_batches * options.stress_batch_size;
    let transport = options.stress_transport.label();
    let server = AppTestHttpServer::start(generated_app_schema())?;
    let base_url = server.url();

    let mut writers = Vec::with_capacity(options.stress_writers);
    for index in 0..options.stress_writers {
        writers.push(open_http_client(
            &format!("stress-writer-{index}"),
            base_url.clone(),
        )?);
    }

    let mut readers = Vec::with_capacity(options.stress_readers);
    for index in 0..options.stress_readers {
        readers.push(open_http_client(
            &format!("stress-reader-{index}"),
            base_url.clone(),
        )?);
    }

    let total_started_at = Instant::now();
    let push_started_at = Instant::now();
    for batch in 0..options.stress_batches {
        let writer_index = batch % writers.len();
        let writer = &mut writers[writer_index];
        insert_tasks(
            writer,
            &format!("stress-w{writer_index}-batch-{batch}"),
            0,
            options.stress_batch_size,
        )?;
        match options.stress_transport {
            StressTransport::Http => writer.sync_http()?,
            StressTransport::Ws => writer.sync_ws()?,
        };
    }
    let push_ms = push_started_at.elapsed().as_secs_f64() * 1000.0;

    let server_rows = server.app_server().rows("tasks").len();
    if server_rows != total_rows {
        bail!("stress server row count mismatch: expected {total_rows}, got {server_rows}");
    }

    let pull_started_at = Instant::now();
    let mut reader_rows = Vec::with_capacity(readers.len());
    for reader in &mut readers {
        reader.sync_http()?;
        let rows = count_tasks(reader)?;
        if rows != total_rows {
            bail!("stress reader row count mismatch: expected {total_rows}, got {rows}");
        }
        reader_rows.push(rows);
    }
    let pull_ms = pull_started_at.elapsed().as_secs_f64() * 1000.0;
    let total_ms = total_started_at.elapsed().as_secs_f64() * 1000.0;

    let mut writer_outbox_commits = 0;
    for writer in &mut writers {
        writer_outbox_commits += count_outbox(writer)?;
    }

    Ok(StressPerfReport {
        generated_at: "runtime".to_string(),
        options: StressPerfOptions {
            transport,
            writers: options.stress_writers,
            readers: options.stress_readers,
            batches: options.stress_batches,
            batch_size: options.stress_batch_size,
            total_rows,
            realtime: false,
        },
        checks: StressChecks {
            total_rows,
            server_rows,
            reader_rows,
            writer_outbox_commits,
            realtime_events: 0,
        },
        metrics: vec![
            summarize(
                &format!(
                    "rust_stress_{}_multi_client_push_{}w_{}b_{}rows",
                    transport, options.stress_writers, options.stress_batches, total_rows
                ),
                &[push_ms],
                server_rows,
                writer_outbox_commits,
            )?,
            summarize(
                &format!(
                    "rust_stress_{}_multi_client_pull_{}r_{}rows",
                    transport, options.stress_readers, total_rows
                ),
                &[pull_ms],
                total_rows,
                0,
            )?,
            summarize(
                &format!(
                    "rust_stress_{}_multi_client_e2e_{}w_{}r_{}rows",
                    transport, options.stress_writers, options.stress_readers, total_rows
                ),
                &[total_ms],
                total_rows,
                writer_outbox_commits,
            )?,
        ],
    })
}

fn benchmark_long_lived_realtime_stress(options: Options) -> Result<StressPerfReport> {
    let total_rows = options.stress_batches * options.stress_batch_size;
    let transport = options.stress_transport.label();
    let server = AppTestHttpServer::start(generated_app_schema())?;
    let base_url = server.url();

    let mut writers = Vec::with_capacity(options.stress_writers);
    for index in 0..options.stress_writers {
        writers.push(open_http_client(
            &format!("realtime-stress-writer-{index}"),
            base_url.clone(),
        )?);
    }

    let mut readers = Vec::with_capacity(options.stress_readers);
    for index in 0..options.stress_readers {
        let client_id = format!("realtime-stress-reader-{index}");
        readers.push((
            open_http_client(&client_id, base_url.clone())?,
            open_realtime_socket(&client_id, base_url.clone())?,
        ));
    }

    let total_started_at = Instant::now();
    let push_started_at = Instant::now();
    let mut catchup_times = Vec::with_capacity(options.stress_batches * options.stress_readers);
    let mut realtime_events = 0usize;

    for batch in 0..options.stress_batches {
        let writer_index = batch % writers.len();
        let writer = &mut writers[writer_index];
        insert_tasks(
            writer,
            &format!("realtime-stress-w{writer_index}-batch-{batch}"),
            0,
            options.stress_batch_size,
        )?;
        match options.stress_transport {
            StressTransport::Http => writer.sync_http()?,
            StressTransport::Ws => writer.sync_ws()?,
        };

        for (reader, socket) in &mut readers {
            let catchup_started_at = Instant::now();
            wait_for_realtime_sync(socket, Duration::from_secs(5))?;
            realtime_events += 1;
            reader.sync_http()?;
            catchup_times.push(catchup_started_at.elapsed().as_secs_f64() * 1000.0);
        }
    }

    let push_ms = push_started_at.elapsed().as_secs_f64() * 1000.0;
    let total_ms = total_started_at.elapsed().as_secs_f64() * 1000.0;
    let server_rows = server.app_server().rows("tasks").len();
    if server_rows != total_rows {
        bail!(
            "realtime stress server row count mismatch: expected {total_rows}, got {server_rows}"
        );
    }

    let mut reader_rows = Vec::with_capacity(readers.len());
    for (reader, socket) in &mut readers {
        socket.close();
        let rows = count_tasks(reader)?;
        if rows != total_rows {
            bail!("realtime stress reader row count mismatch: expected {total_rows}, got {rows}");
        }
        reader_rows.push(rows);
    }

    let mut writer_outbox_commits = 0;
    for writer in &mut writers {
        writer_outbox_commits += count_outbox(writer)?;
    }

    Ok(StressPerfReport {
        generated_at: "runtime".to_string(),
        options: StressPerfOptions {
            transport,
            writers: options.stress_writers,
            readers: options.stress_readers,
            batches: options.stress_batches,
            batch_size: options.stress_batch_size,
            total_rows,
            realtime: true,
        },
        checks: StressChecks {
            total_rows,
            server_rows,
            reader_rows,
            writer_outbox_commits,
            realtime_events,
        },
        metrics: vec![
            summarize(
                &format!(
                    "rust_stress_realtime_{}_push_{}w_{}b_{}rows",
                    transport, options.stress_writers, options.stress_batches, total_rows
                ),
                &[push_ms],
                server_rows,
                writer_outbox_commits,
            )?,
            summarize(
                &format!(
                    "rust_stress_realtime_{}_wakeup_catchup_{}r_{}rows",
                    transport, options.stress_readers, total_rows
                ),
                &catchup_times,
                total_rows,
                0,
            )?,
            summarize(
                &format!(
                    "rust_stress_realtime_{}_e2e_{}w_{}r_{}rows",
                    transport, options.stress_writers, options.stress_readers, total_rows
                ),
                &[total_ms],
                total_rows,
                writer_outbox_commits,
            )?,
        ],
    })
}

fn open_realtime_socket(
    client_id: &str,
    base_url: String,
) -> Result<syncular_client::transport::RealtimeSocket> {
    let transport = HttpSyncTransport::new(SyncTransportConfig::new(
        base_url,
        format!("rust-perf-{client_id}"),
        ACTOR_ID,
    ))
    .with_schema_version(generated_app_schema().current_schema_version());
    Ok(transport.connect_realtime()?)
}

fn wait_for_realtime_sync(
    socket: &mut syncular_client::transport::RealtimeSocket,
    timeout: Duration,
) -> Result<()> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        match socket.read_event()? {
            Some(RealtimeEvent::Sync) => return Ok(()),
            Some(RealtimeEvent::Presence(_)) | Some(RealtimeEvent::Other(_)) | None => {}
        }
    }
    bail!("timed out waiting for realtime sync event")
}

fn open_e2e_pair(
    name: &str,
) -> Result<(
    AppTestServer,
    syncular_testkit::InMemoryAppFixture<AppTestServer>,
    syncular_testkit::InMemoryAppFixture<AppTestServer>,
)> {
    let app_schema = generated_app_schema();
    let server = AppTestServer::new(app_schema);
    let writer = open_app_client_with_server_in_memory(
        app_schema,
        server.clone(),
        e2e_options(&format!("{name}-writer")),
    )?;
    let reader = open_app_client_with_server_in_memory(
        app_schema,
        server.clone(),
        e2e_options(&format!("{name}-reader")),
    )?;
    Ok((server, writer, reader))
}

fn open_http_pair(
    name: &str,
) -> Result<(
    AppTestHttpServer,
    SyncularClient<DieselSqliteStore, HttpSyncTransport>,
    SyncularClient<DieselSqliteStore, HttpSyncTransport>,
)> {
    let server = AppTestHttpServer::start(generated_app_schema())?;
    let writer = open_http_client(&format!("{name}-writer"), server.url())?;
    let reader = open_http_client(&format!("{name}-reader"), server.url())?;
    Ok((server, writer, reader))
}

fn open_http_client(
    client_id: &str,
    base_url: String,
) -> Result<SyncularClient<DieselSqliteStore, HttpSyncTransport>> {
    Ok(SyncularClient::open_with_schema(
        SyncularClientConfig {
            db_path: ":memory:".to_string(),
            base_url,
            client_id: format!("rust-perf-{client_id}"),
            actor_id: ACTOR_ID.to_string(),
            project_id: Some(PROJECT_ID.to_string()),
        },
        generated_app_schema(),
    )?)
}

fn e2e_options(client_id: &str) -> AppFixtureOptions {
    AppFixtureOptions {
        db_prefix: format!("syncular-rust-perf-{client_id}"),
        base_url: "app-test-server://sync".to_string(),
        client_id: format!("rust-perf-{client_id}"),
        actor_id: ACTOR_ID.to_string(),
        project_id: Some(PROJECT_ID.to_string()),
    }
}

fn commit_server_tasks(
    server: &AppTestServer,
    prefix: &str,
    start_index: usize,
    count: usize,
) -> Result<()> {
    for index in 0..count {
        let absolute_index = start_index + index;
        server.commit_row(
            "tasks",
            json!({
                "id": format!("{prefix}-task-{absolute_index}"),
                "title": format!("{prefix} task {absolute_index}"),
                "completed": (absolute_index % 2) as i32,
                "user_id": ACTOR_ID,
                "project_id": PROJECT_ID,
                "server_version": 0
            }),
        )?;
    }
    Ok(())
}

fn insert_tasks(
    client: &mut SyncularClient<DieselSqliteStore, impl SyncTransport>,
    prefix: &str,
    start_index: usize,
    count: usize,
) -> Result<Vec<String>> {
    let rows = (0..count).map(|index| {
        let absolute_index = start_index + index;
        NewTask::new(
            &format!("{prefix}-task-{absolute_index}"),
            &format!("{prefix} task {absolute_index}"),
            ACTOR_ID,
            Some(PROJECT_ID),
        )
    });
    Ok(client.mutations().tasks().insert_many(rows)?.ids)
}

fn update_tasks(
    client: &mut SyncularClient<DieselSqliteStore, impl SyncTransport>,
    ids: &[String],
    prefix: &str,
    start_index: usize,
    count: usize,
) -> Result<()> {
    client.commit(|tx| {
        for index in 0..count {
            let absolute_index = start_index + index;
            let row_id = &ids[absolute_index % ids.len()];
            tx.tasks().update(
                TaskPatch::new(row_id)
                    .title(&format!("{prefix} task {absolute_index}"))
                    .completed((absolute_index % 2) as i32),
            )?;
        }
        Ok(())
    })?;
    Ok(())
}

fn count_tasks(
    client: &mut SyncularClient<DieselSqliteStore, impl SyncTransport>,
) -> Result<usize> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(&client.list_table_json("tasks")?)?;
    Ok(rows.len())
}

fn count_outbox<T>(client: &mut SyncularClient<DieselSqliteStore, T>) -> Result<usize>
where
    T: SyncTransport,
    DieselSqliteStore: SyncStore + SyncStateStore,
{
    Ok(client.outbox_summaries()?.len())
}

fn summarize(
    name: &str,
    times: &[f64],
    rows: usize,
    outbox_commits: usize,
) -> Result<NativePerfMetric> {
    if times.is_empty() {
        bail!("cannot summarize empty benchmark {name}");
    }

    let mut sorted = times.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    let variance = sorted
        .iter()
        .map(|value| {
            let delta = value - mean;
            delta * delta
        })
        .sum::<f64>()
        / sorted.len() as f64;
    let percentile = |p: f64| -> f64 {
        let index = ((sorted.len() - 1) as f64 * p).floor() as usize;
        sorted[index]
    };

    Ok(NativePerfMetric {
        name: name.to_string(),
        iterations: sorted.len(),
        mean,
        median: sorted[sorted.len() / 2],
        p95: percentile(0.95),
        p99: percentile(0.99),
        min: sorted[0],
        max: sorted[sorted.len() - 1],
        std_dev: variance.sqrt(),
        rows,
        outbox_commits,
    })
}
