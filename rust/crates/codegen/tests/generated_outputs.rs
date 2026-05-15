use std::process::Command;

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
