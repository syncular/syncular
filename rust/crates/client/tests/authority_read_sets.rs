//! §5.11 drift guard: typegen derives an authority query's read set from the
//! SYQL validator, the native ceiling from the SQLite authorizer. For every
//! authority query in the typegen fixtures, the authorizer's read set of the
//! generated statement must equal the emitted `reads`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::Value;
use syncular_client::{authority_read_set, AuthorityQuery, ClientLimits, SyncClient};

/// The `authority query` declarations in the fixture's `.syql` sources.
fn authored(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| {
            if path.is_dir() {
                authored(&path)
            } else if path.extension().is_some_and(|ext| ext == "syql") {
                std::fs::read_to_string(&path)
                    .unwrap()
                    .lines()
                    .filter(|line| {
                        let mut words = line.split_whitespace();
                        words.next() == Some("authority") && words.next() == Some("query")
                    })
                    .count()
            } else {
                0
            }
        })
        .sum()
}

#[test]
fn every_fixture_authority_read_set_matches_the_sqlite_authorizer() {
    let fixtures =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/typegen/test/fixtures");
    let mut checked = 0;
    for fixture in std::fs::read_dir(&fixtures).unwrap() {
        let dir = fixture.unwrap().path();
        let generated = dir.join("syncular.queries.rs");
        if !generated.exists() {
            continue;
        }
        // The Rust emitter writes each declaration as one JSON constant:
        // `pub const <NAME>_AUTHORITY: &str = r#"{...}"#;`.
        let queries: Vec<AuthorityQuery> = std::fs::read_to_string(&generated)
            .unwrap()
            .lines()
            .filter_map(|line| {
                let (head, json) = line.split_once(r##"_AUTHORITY: &str = r#""##)?;
                head.starts_with("pub const ").then_some(json)
            })
            .map(|json| {
                serde_json::from_str(json.strip_suffix(r##""#;"##).expect("one-line constant"))
                    .unwrap_or_else(|error| panic!("malformed authority declaration: {error}"))
            })
            .collect();
        assert_eq!(
            queries.len(),
            authored(&dir.join("queries")),
            "{}: every authored authority query is emitted",
            dir.display()
        );
        if queries.is_empty() {
            continue;
        }
        let uri = format!(
            "file:authority-read-set-{}?mode=memory&cache=shared",
            uuid::Uuid::new_v4()
        );
        let mut conn = rusqlite::Connection::open(&uri).unwrap();
        // Creation validates every declaration against the fixture schema.
        let _client = SyncClient::with_connection(
            "authority-read-sets".to_owned(),
            &serde_json::from_str::<Value>(
                &std::fs::read_to_string(dir.join("syncular.ir.json")).unwrap(),
            )
            .unwrap(),
            ClientLimits {
                authority_reads: queries.clone(),
                ..Default::default()
            },
            rusqlite::Connection::open(&uri).unwrap(),
        )
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
        for query in &queries {
            let actual: BTreeMap<String, BTreeSet<String>> = authority_read_set(&mut conn, query)
                .unwrap_or_else(|error| panic!("{}: {error:?}", query.name))
                .into_iter()
                .map(|(table, mut columns)| {
                    // An empty column reads the table without a column.
                    columns.remove("");
                    (table, columns)
                })
                .collect();
            let emitted: BTreeMap<String, BTreeSet<String>> = query
                .reads
                .iter()
                .map(|(table, columns)| (table.clone(), columns.iter().cloned().collect()))
                .collect();
            assert_eq!(actual, emitted, "{}: read set drift", query.name);
            checked += 1;
        }
    }
    assert!(
        checked > 0,
        "no typegen fixture declares an authority query to check"
    );
}
