//! Golden-vector conformance harness (v2/spec/vectors/README.md).
//!
//! For every case listed in each per-kind `manifest.json`:
//! 1. decode succeeds and the §11 rendering deep-equals the committed `.json`;
//! 2. re-encoding the decoded value is byte-identical to the `.bin`;
//! 3. every `invalid/` case fails to decode with exactly the manifest's code.
//!
//! Realtime cases are `.json`-only: they must parse as §8 control messages
//! and render back to a deep-equal JSON document.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use ssp2::{
    decode_message, decode_rows_segment, encode_message, encode_rows_segment, parse_control_value,
    render_control, render_message, render_rows_segment,
};

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../spec/vectors")
}

fn read_manifest(kind: &str) -> Value {
    let path = vectors_dir().join(kind).join("manifest.json");
    let text =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad manifest {}: {e}", path.display()))
}

fn read_bin(kind: &str, rel: &str) -> Vec<u8> {
    let path = vectors_dir().join(kind).join(rel);
    fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn read_json(kind: &str, rel: &str) -> Value {
    let path = vectors_dir().join(kind).join(rel);
    let text =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad JSON {}: {e}", path.display()))
}

fn cases(manifest: &Value, key: &str) -> Vec<Value> {
    manifest[key]
        .as_array()
        .unwrap_or_else(|| panic!("manifest has no {key:?} array"))
        .clone()
}

fn str_field<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("manifest case missing {key:?}: {case}"))
}

/// Envelope kinds (`request`, `response`): decode → render → re-encode.
fn run_envelope_kind(kind: &str) {
    let manifest = read_manifest(kind);

    let valid = cases(&manifest, "cases");
    assert!(!valid.is_empty(), "{kind}: no cases in manifest");
    for case in &valid {
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected = read_json(kind, str_field(case, "json"));

        let msg =
            decode_message(&bin).unwrap_or_else(|e| panic!("{kind}/{name}: decode failed: {e}"));
        let rendered = render_message(&msg);
        assert_eq!(
            rendered, expected,
            "{kind}/{name}: rendering does not deep-equal the committed .json\nrendered: {rendered:#}\nexpected: {expected:#}"
        );
        let reencoded = encode_message(&msg);
        assert_eq!(
            reencoded, bin,
            "{kind}/{name}: re-encode is not byte-identical to the .bin"
        );
    }

    for case in &cases(&manifest, "invalid") {
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected_code = str_field(case, "error");
        match decode_message(&bin) {
            Ok(_) => panic!("{kind}/invalid/{name}: decode unexpectedly succeeded"),
            Err(e) => assert_eq!(
                e.code.as_str(),
                expected_code,
                "{kind}/invalid/{name}: wrong error code (detail: {})",
                e.detail
            ),
        }
    }
}

#[test]
fn request_vectors() {
    run_envelope_kind("request");
}

#[test]
fn response_vectors() {
    run_envelope_kind("response");
}

#[test]
fn segment_vectors() {
    let kind = "segment";
    let manifest = read_manifest(kind);

    let valid = cases(&manifest, "cases");
    assert!(!valid.is_empty(), "{kind}: no cases in manifest");
    for case in &valid {
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected = read_json(kind, str_field(case, "json"));

        let seg = decode_rows_segment(&bin)
            .unwrap_or_else(|e| panic!("{kind}/{name}: decode failed: {e}"));
        let rendered = render_rows_segment(&seg);
        assert_eq!(
            rendered, expected,
            "{kind}/{name}: rendering does not deep-equal the committed .json\nrendered: {rendered:#}\nexpected: {expected:#}"
        );
        let reencoded = encode_rows_segment(&seg);
        assert_eq!(
            reencoded, bin,
            "{kind}/{name}: re-encode is not byte-identical to the .bin"
        );
    }

    for case in &cases(&manifest, "invalid") {
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected_code = str_field(case, "error");
        match decode_rows_segment(&bin) {
            Ok(_) => panic!("{kind}/invalid/{name}: decode unexpectedly succeeded"),
            Err(e) => assert_eq!(
                e.code.as_str(),
                expected_code,
                "{kind}/invalid/{name}: wrong error code (detail: {})",
                e.detail
            ),
        }
    }
}

#[test]
fn realtime_vectors() {
    let kind = "realtime";
    let manifest = read_manifest(kind);

    let valid = cases(&manifest, "cases");
    assert!(!valid.is_empty(), "{kind}: no cases in manifest");
    for case in &valid {
        let name = str_field(case, "name");
        let expected = read_json(kind, str_field(case, "json"));

        let msg = parse_control_value(&expected)
            .unwrap_or_else(|e| panic!("{kind}/{name}: parse failed: {e}"));
        assert!(
            !matches!(msg, ssp2::ControlMessage::Unknown(_)),
            "{kind}/{name}: vector parsed as an unknown control event"
        );
        let rendered = render_control(&msg);
        assert_eq!(
            rendered, expected,
            "{kind}/{name}: round-tripped rendering does not deep-equal the committed .json"
        );
    }

    for case in &cases(&manifest, "invalid") {
        let name = str_field(case, "name");
        let expected_code = str_field(case, "error");
        let value = read_json(kind, str_field(case, "json"));
        match parse_control_value(&value) {
            Ok(_) => panic!("{kind}/invalid/{name}: control parse unexpectedly succeeded"),
            Err(e) => assert_eq!(
                e.code.as_str(),
                expected_code,
                "{kind}/invalid/{name}: wrong error code (detail: {})",
                e.detail
            ),
        }
    }
}
