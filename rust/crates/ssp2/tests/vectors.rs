//! Golden-vector conformance harness (spec/vectors/README.md).
//!
//! For every case listed in each per-kind `manifest.json`:
//! 1. decode succeeds and the §11 rendering deep-equals the committed `.json`;
//! 2. re-encoding the decoded value is byte-identical to the `.bin`;
//! 3. every `invalid/` case fails to decode with exactly the manifest's code.
//!
//! Realtime cases are `.json`-only: they must parse as §8 control messages
//! and render back to a deep-equal JSON document. The registration case is
//! `.json`-only too: every unit id, registration digest and echo digest is
//! recomputed from its inputs (§4.1, §4.4).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use ssp2::model::{EchoStatus, FencedRecord};
use ssp2::segment::{decode_sparse_row, encode_sparse_row, Column, ColumnType};
use ssp2::util::hex;
use ssp2::{
    canonical_unit_json, decode_message, decode_rows_segment, echo_digest, encode_message,
    encode_rows_segment, parse_control_value, registration_digest, render_control, render_message,
    render_rows_segment, render_sparse_row, unit_id, UnitEcho,
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
fn push_vectors() {
    let kind = "push";
    let manifest = read_manifest(kind);
    // A case's own column table overrides the kind's (spec/vectors/README.md).
    let table = |case: &Value| -> (Vec<Column>, usize) {
        let source = if case.get("columns").is_some() {
            case
        } else {
            &manifest
        };
        let columns: Vec<Column> = source["columns"]
            .as_array()
            .expect("push manifest has a column table")
            .iter()
            .map(|c| Column {
                name: str_field(c, "name").to_owned(),
                ty: ColumnType::from_name(str_field(c, "type")).expect("known column type"),
                nullable: c["nullable"].as_bool().expect("column nullable flag"),
            })
            .collect();
        let primary_key = str_field(source, "primaryKey");
        let primary_key_index = columns
            .iter()
            .position(|c| c.name == primary_key)
            .expect("primary key is a column of the table");
        (columns, primary_key_index)
    };

    let valid = cases(&manifest, "cases");
    assert!(!valid.is_empty(), "{kind}: no cases in manifest");
    for case in &valid {
        let (columns, primary_key_index) = table(case);
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected = read_json(kind, str_field(case, "json"));

        let row = decode_sparse_row(&columns, primary_key_index, &bin)
            .unwrap_or_else(|e| panic!("{kind}/{name}: decode failed: {e}"));
        let rendered = render_sparse_row(&columns, &row);
        assert_eq!(
            rendered, expected,
            "{kind}/{name}: rendering does not deep-equal the committed .json\nrendered: {rendered:#}\nexpected: {expected:#}"
        );
        let reencoded = encode_sparse_row(&columns, primary_key_index, &row);
        assert_eq!(
            reencoded, bin,
            "{kind}/{name}: re-encode is not byte-identical to the .bin"
        );
    }

    for case in &cases(&manifest, "invalid") {
        let (columns, primary_key_index) = table(case);
        let name = str_field(case, "name");
        let bin = read_bin(kind, str_field(case, "bin"));
        let expected_code = str_field(case, "error");
        match decode_sparse_row(&columns, primary_key_index, &bin) {
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

#[test]
fn registration_vectors() {
    let kind = "registration";
    let manifest = read_manifest(kind);
    let valid = cases(&manifest, "cases");
    assert_eq!(valid.len(), 1, "{kind}: one digests case");
    let vector = read_json(kind, str_field(&valid[0], "json"));
    let unit_scopes = |value: &Value| -> Vec<(String, String)> {
        value
            .as_object()
            .expect("a scope map")
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().expect("a scope value").to_owned()))
            .collect()
    };
    let status = |value: &Value| match value.as_str() {
        Some("active") => EchoStatus::Active,
        Some("revoked") => EchoStatus::Revoked,
        other => panic!("unknown echo status {other:?}"),
    };

    for case in vector["units"].as_array().expect("units") {
        let scopes = unit_scopes(&case["scopes"]);
        assert_eq!(
            canonical_unit_json(&scopes),
            str_field(case, "canonicalJson")
        );
        assert_eq!(unit_id(&scopes), str_field(case, "id"));
    }
    for case in vector["registrations"].as_array().expect("registrations") {
        let units: Vec<Vec<(String, String)>> = case["units"]
            .as_array()
            .expect("units")
            .iter()
            .map(unit_scopes)
            .collect();
        let digest = registration_digest(units.iter().map(Vec::as_slice));
        assert_eq!(hex(&digest), str_field(case, "digest"), "{case}");
    }
    for case in vector["echoes"].as_array().expect("echoes") {
        let units: Vec<(String, EchoStatus, Vec<FencedRecord>)> = case["units"]
            .as_array()
            .expect("units")
            .iter()
            .map(|unit| {
                let fenced = unit["fenced"]
                    .as_array()
                    .expect("fenced")
                    .iter()
                    .map(|record| FencedRecord {
                        table: str_field(record, "table").to_owned(),
                        status: status(&record["status"]),
                        scopes: record["scopes"]
                            .as_object()
                            .expect("fenced scopes")
                            .iter()
                            .map(|(k, v)| {
                                let values = v.as_array().expect("a value list");
                                let values = values.iter().map(|v| v.as_str().unwrap().to_owned());
                                (k.clone(), values.collect())
                            })
                            .collect(),
                    })
                    .collect();
                (
                    str_field(unit, "id").to_owned(),
                    status(&unit["status"]),
                    fenced,
                )
            })
            .collect();
        let digest = echo_digest(units.iter().map(|(id, status, fenced)| UnitEcho {
            id,
            status: *status,
            fenced,
        }));
        assert_eq!(hex(&digest), str_field(case, "digest"), "{case}");
    }
}
