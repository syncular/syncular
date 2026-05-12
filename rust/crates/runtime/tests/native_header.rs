use std::collections::BTreeSet;

#[test]
fn native_c_header_lists_all_exported_ffi_symbols() {
    let ffi = include_str!("../src/native/ffi.rs");
    let header = include_str!("../../../bindings/c/syncular_native.h");

    let rust_symbols = exported_rust_symbols(ffi);
    let header_symbols = declared_header_symbols(header);

    let missing_from_header = rust_symbols
        .difference(&header_symbols)
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        missing_from_header.is_empty(),
        "header is missing Rust FFI exports: {missing_from_header:?}"
    );

    let stale_header_symbols = header_symbols
        .difference(&rust_symbols)
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        stale_header_symbols.is_empty(),
        "header declares symbols that are not exported by Rust: {stale_header_symbols:?}"
    );
}

#[test]
fn native_c_header_publishes_current_abi_version() {
    let header = include_str!("../../../bindings/c/syncular_native.h");
    assert!(header.contains("#define SYNCULAR_NATIVE_FFI_ABI_VERSION 1"));
}

fn exported_rust_symbols(source: &str) -> BTreeSet<String> {
    source
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("pub extern \"C\" fn ")
                .and_then(|rest| rest.split_once('('))
                .map(|(name, _)| name.trim().to_string())
        })
        .collect()
}

fn declared_header_symbols(header: &str) -> BTreeSet<String> {
    let mut declarations = Vec::new();
    let mut current = String::new();

    for line in header.lines().map(str::trim) {
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with("typedef")
            || line.starts_with("extern")
            || line.starts_with("}")
            || line.starts_with('*')
        {
            continue;
        }
        current.push(' ');
        current.push_str(line);
        if line.ends_with(';') {
            declarations.push(current.trim().to_string());
            current.clear();
        }
    }

    declarations
        .into_iter()
        .filter_map(|declaration| {
            declaration
                .split_once('(')
                .map(|(before_args, _)| before_args.to_string())
        })
        .filter_map(|before_args| {
            before_args
                .rsplit(|ch: char| ch.is_ascii_whitespace() || ch == '*')
                .find(|part| part.starts_with("syncular_"))
                .map(str::to_string)
        })
        .collect()
}
