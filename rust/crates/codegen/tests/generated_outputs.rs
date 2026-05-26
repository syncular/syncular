use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_test_dir(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "syncular-codegen-{name}-{}-{nanos}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp test dir");
    path
}

#[test]
fn generated_outputs_are_current() {
    let codegen_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let rust_dir = codegen_dir
        .parent()
        .and_then(std::path::Path::parent)
        .expect("rust dir");
    let runtime_dir = rust_dir.join("crates/runtime");
    let example_dir = rust_dir.join("examples/todo-app");

    let output = Command::new(env!("CARGO_BIN_EXE_syncular-codegen"))
        .arg("--manifest-dir")
        .arg(&runtime_dir)
        .arg("--codegen-config")
        .arg("syncular.codegen.json")
        .arg("--migrations-dir")
        .arg(runtime_dir.join("migrations"))
        .arg("--rust-output-dir")
        .arg(runtime_dir.join("src/fixtures/todo/generated"))
        .arg("--check")
        .output()
        .expect("run syncular-codegen --check for runtime generated modules");

    assert!(
        output.status.success(),
        "runtime generated outputs are out of date\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let output = Command::new(env!("CARGO_BIN_EXE_syncular-codegen"))
        .arg("--manifest-dir")
        .arg(&example_dir)
        .arg("--check")
        .output()
        .expect("run syncular-codegen --check for example app");

    assert!(
        output.status.success(),
        "example app generated outputs are out of date\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn init_generates_a_minimal_codegen_config_from_migrations() {
    let app_dir = temp_test_dir("init");
    let migration_dir = app_dir.join("migrations/0001_initial");
    fs::create_dir_all(&migration_dir).expect("create migration dir");
    fs::write(
        migration_dir.join("up.sql"),
        r#"
create table tasks (
  id text primary key not null,
  title text not null,
  user_id text not null,
  project_id text,
  server_version bigint not null default 0
);

create table search_cache (
  key text primary key not null,
  value text not null
);
"#,
    )
    .expect("write migration");

    let output = Command::new(env!("CARGO_BIN_EXE_syncular-codegen"))
        .arg("init")
        .arg("--manifest-dir")
        .arg(&app_dir)
        .output()
        .expect("run syncular-codegen init");
    assert!(
        output.status.success(),
        "syncular-codegen init failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let config_path = app_dir.join("generated/syncular.codegen.json");
    let config = fs::read_to_string(&config_path).expect("read generated config");
    assert!(config.contains(r#""tasks""#));
    assert!(config.contains(r#""subscriptionId": "sub-tasks""#));
    assert!(config.contains(r#""serverVersionColumn": "server_version""#));
    assert!(config.contains(r#""source": "actorId""#));
    assert!(config.contains(r#""source": "projectId""#));
    assert!(config.contains(r#""localOnlyTables": ["#));
    assert!(config.contains(r#""search_cache""#));

    let output = Command::new(env!("CARGO_BIN_EXE_syncular-codegen"))
        .arg("init")
        .arg("--manifest-dir")
        .arg(&app_dir)
        .arg("--check")
        .output()
        .expect("run syncular-codegen init --check");
    assert!(
        output.status.success(),
        "syncular-codegen init --check failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let _ = fs::remove_dir_all(&app_dir);
}
