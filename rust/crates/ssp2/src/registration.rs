//! Canonical JSON for digests (SPEC.md §11.2) and the digests over it: the
//! unit id and registration digest (§4.1), the echo digest (§4.4), and the
//! scope-map text of the scope digest (§3.5) and `X-Syncular-Scopes` (§5.5).
//! UTF-8, no insignificant whitespace, object keys sorted by UTF-16 code
//! unit, scope value lists sorted and deduplicated, every other array in its
//! stated order.

use sha2::{Digest, Sha256};

use crate::model::{EchoStatus, FencedRecord};
use crate::util::hex;

/// A JSON string literal; serde_json escapes exactly as `JSON.stringify`
/// does for well-formed strings.
fn json_str(value: &str) -> String {
    serde_json::to_string(value).expect("a string serializes")
}

fn sorted_by_code_unit<T>(items: &mut [T], key: impl Fn(&T) -> &str) {
    items.sort_by(|a, b| key(a).encode_utf16().cmp(key(b).encode_utf16()));
}

/// §11.2: the canonical JSON of a scope map of value lists.
pub fn canonical_scope_json(scopes: &[(String, Vec<String>)]) -> String {
    let mut entries: Vec<&(String, Vec<String>)> = scopes.iter().collect();
    sorted_by_code_unit(&mut entries, |entry| &entry.0);
    let parts: Vec<String> = entries
        .into_iter()
        .map(|(key, values)| {
            let mut values: Vec<&str> = values.iter().map(String::as_str).collect();
            sorted_by_code_unit(&mut values, |value| value);
            values.dedup();
            let list: Vec<String> = values.into_iter().map(json_str).collect();
            format!("{}:[{}]", json_str(key), list.join(","))
        })
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// §4.1: the canonical JSON of a unit's scope map.
pub fn canonical_unit_json(scopes: &[(String, String)]) -> String {
    let mut entries: Vec<&(String, String)> = scopes.iter().collect();
    sorted_by_code_unit(&mut entries, |entry| &entry.0);
    let parts: Vec<String> = entries
        .into_iter()
        .map(|(key, value)| format!("{}:{}", json_str(key), json_str(value)))
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// §4.1: lowercase hex of the first 16 bytes of SHA-256 over the canonical
/// JSON of the unit's scope map.
pub fn unit_id(scopes: &[(String, String)]) -> String {
    hex(&Sha256::digest(canonical_unit_json(scopes))[..16])
}

/// §4.1: SHA-256 over the canonical JSON array of the units' scope maps in
/// registration order.
pub fn registration_digest<'a>(
    units: impl IntoIterator<Item = &'a [(String, String)]>,
) -> [u8; 32] {
    let parts: Vec<String> = units.into_iter().map(canonical_unit_json).collect();
    Sha256::digest(format!("[{}]", parts.join(","))).into()
}

/// One unit of the effective list as the echo digest sees it (§4.4). A unit
/// answered `reset` enters with the status it has after the reset.
#[derive(Debug, Clone, Copy)]
pub struct UnitEcho<'a> {
    pub id: &'a str,
    pub status: EchoStatus,
    pub fenced: &'a [FencedRecord],
}

/// §4.4: SHA-256 over the canonical JSON array, in registration order, of
/// `{"fenced":[…],"id":…,"status":…}` per unit.
pub fn echo_digest<'a>(units: impl IntoIterator<Item = UnitEcho<'a>>) -> [u8; 32] {
    let parts: Vec<String> = units
        .into_iter()
        .map(|unit| {
            let fenced: Vec<String> = unit
                .fenced
                .iter()
                .map(|record| {
                    format!(
                        "{{\"scopes\":{},\"status\":{},\"table\":{}}}",
                        canonical_scope_json(&record.scopes),
                        json_str(record.status.name()),
                        json_str(&record.table)
                    )
                })
                .collect();
            format!(
                "{{\"fenced\":[{}],\"id\":{},\"status\":{}}}",
                fenced.join(","),
                json_str(unit.id),
                json_str(unit.status.name())
            )
        })
        .collect();
    Sha256::digest(format!("[{}]", parts.join(","))).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(key: &str, value: &str) -> Vec<(String, String)> {
        vec![(key.to_owned(), value.to_owned())]
    }

    /// The §4.1 worked example table.
    #[test]
    fn spec_worked_example() {
        let a = unit("campaign_id", "c1");
        let b = unit("ruleset_id", "r1");
        assert_eq!(canonical_unit_json(&a), r#"{"campaign_id":"c1"}"#);
        assert_eq!(unit_id(&a), "47c583f8f997e2a55f46dc618c2f1969");
        assert_eq!(unit_id(&b), "2aa6ecebeab5fd23a8d13f806b28e4c6");
        assert_eq!(
            hex(&registration_digest([a.as_slice(), b.as_slice()])),
            "2d52a2d80eed610872ef7239611c9cf9d768a6bce24d222f2985b129d4c929bf"
        );
        assert_eq!(
            hex(&registration_digest([])),
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        );
    }

    #[test]
    fn scope_lists_sort_by_code_unit_and_deduplicate() {
        let scopes = vec![
            ("！".to_owned(), vec!["b".to_owned()]),
            (
                "😀".to_owned(),
                vec!["！".to_owned(), "😀".to_owned(), "！".to_owned()],
            ),
        ];
        assert_eq!(
            canonical_scope_json(&scopes),
            r#"{"😀":["😀","！"],"！":["b"]}"#
        );
    }
}
