use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use syncular_client::client::{SyncularClient, SyncularClientConfig};
use syncular_client::diesel_sqlite::DieselSqliteStore;
use syncular_client::fixtures::todo::app_schema as demo_todo_app_schema;
use syncular_client::fixtures::todo::rusqlite_sqlite::RusqliteStore;
use syncular_client::store::{DemoTaskStore, SyncStateStore, SyncStore};
use syncular_client::transport::RealtimeEvent;
use syncular_client::transport::{HttpSyncTransport, SyncTransportConfig};

#[derive(Parser, Debug)]
#[command(about = "Syncular native client storage POC")]
struct Cli {
    #[arg(long, default_value = ".context/syncular-client.sqlite")]
    db: String,
    #[arg(long, default_value = "http://localhost:9811/api/sync")]
    base_url: String,
    #[arg(long, default_value = "rust-client")]
    client_id: String,
    #[arg(long, default_value = "user-rust")]
    actor_id: String,
    #[arg(long)]
    project_id: Option<String>,
    #[arg(long, value_enum, default_value_t = StoreBackend::Diesel)]
    store: StoreBackend,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, ValueEnum)]
enum StoreBackend {
    Diesel,
    Rusqlite,
}

#[derive(Subcommand, Debug)]
enum Command {
    AddTask {
        title: String,
        #[arg(long)]
        id: Option<String>,
    },
    PatchTaskTitle {
        id: String,
        title: String,
    },
    Sync,
    SyncWs,
    Watch {
        #[arg(long, default_value_t = 30)]
        seconds: u64,
    },
    ListTasks,
    Migrations,
    Outbox,
    Conflicts,
    ResolveConflict {
        id: String,
        resolution: String,
    },
    RetryConflictKeepLocal {
        id: String,
    },
}

impl Cli {
    fn into_config(&self) -> SyncularClientConfig {
        SyncularClientConfig {
            db_path: self.db.clone(),
            base_url: self.base_url.clone(),
            client_id: self.client_id.clone(),
            actor_id: self.actor_id.clone(),
            project_id: self.project_id.clone(),
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = cli.into_config();

    match cli.store {
        StoreBackend::Diesel => {
            let app_schema = demo_todo_app_schema();
            let store = DieselSqliteStore::open_with_schema(&config.db_path, app_schema)?;
            let transport = HttpSyncTransport::new(SyncTransportConfig::new(
                config.base_url.clone(),
                config.client_id.clone(),
                config.actor_id.clone(),
            ))
            .with_schema_version(app_schema.current_schema_version());
            run_client(
                SyncularClient::with_app_schema_parts(config, store, transport, app_schema),
                cli.command,
            )
        }
        StoreBackend::Rusqlite => {
            let store = RusqliteStore::open(&config.db_path)?;
            let app_schema = demo_todo_app_schema();
            let transport = HttpSyncTransport::new(SyncTransportConfig::new(
                config.base_url.clone(),
                config.client_id.clone(),
                config.actor_id.clone(),
            ))
            .with_schema_version(app_schema.current_schema_version());
            run_client(
                SyncularClient::with_app_schema_parts(config, store, transport, app_schema),
                cli.command,
            )
        }
    }
}

fn run_client<S>(mut client: SyncularClient<S>, command: Command) -> Result<()>
where
    S: SyncStore + SyncStateStore + DemoTaskStore,
{
    match command {
        Command::AddTask { title, id } => {
            let task_id = client.add_task(title, id)?;
            println!("queued task {task_id}");
        }
        Command::PatchTaskTitle { id, title } => {
            client.patch_task_title(id.clone(), title)?;
            println!("queued task title patch {id}");
        }
        Command::Sync => {
            client.sync_http()?;
            println!("sync complete");
        }
        Command::SyncWs => {
            client.sync_ws()?;
            println!("websocket push sync complete");
        }
        Command::Watch { seconds } => {
            println!("watching websocket for {seconds}s");
            client.watch(seconds, |event| match event {
                RealtimeEvent::Sync => println!("ws event: sync"),
                RealtimeEvent::Presence(event) => {
                    println!("ws event: presence {} {}", event.action, event.scope_key)
                }
                RealtimeEvent::Other(event) => println!("ws event: {event}"),
            })?;
        }
        Command::ListTasks => {
            for task in client.list_tasks()? {
                println!(
                    "{} [{}] user={} project={} v{}",
                    task.title,
                    task.id,
                    task.user_id,
                    task.project_id.unwrap_or_else(|| "-".to_string()),
                    task.server_version
                );
            }
        }
        Command::Migrations => {
            for migration in client.applied_migrations()? {
                println!(
                    "{} {} {} {}",
                    migration.version, migration.name, migration.checksum, migration.applied_at
                );
            }
        }
        Command::Outbox => {
            for commit in client.outbox_summaries()? {
                println!(
                    "{} {} schema={}",
                    commit.client_commit_id, commit.status, commit.schema_version
                );
            }
        }
        Command::Conflicts => {
            for conflict in client.conflict_summaries()? {
                println!(
                    "{} {} op={} {} code={} server_version={} {}",
                    conflict.id,
                    conflict.client_commit_id,
                    conflict.op_index,
                    conflict.result_status,
                    conflict.code.unwrap_or_else(|| "-".to_string()),
                    conflict
                        .server_version
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                    conflict.message
                );
            }
        }
        Command::ResolveConflict { id, resolution } => {
            client.resolve_conflict(&id, &resolution)?;
            println!("resolved conflict {id} as {resolution}");
        }
        Command::RetryConflictKeepLocal { id } => {
            let client_commit_id = client.retry_conflict_keep_local(&id)?;
            println!("resolved conflict {id} as keep-local and queued retry {client_commit_id}");
        }
    }

    Ok(())
}
