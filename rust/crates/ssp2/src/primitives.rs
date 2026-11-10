//! Conventions primitives (SPEC.md "Conventions and primitive encodings"):
//! little-endian fixed-width integers, `str`, `bytes`, `opt`, `bool`, `json`,
//! canonical maps. Shared by the envelope codec and the SSG2 segment codec.

use crate::error::{DecodeError, Result};
use crate::util::utf16_lt;

/// JS safe-integer contract: `i64` values must be within ±(2^53 − 1).
pub const I64_SAFE_MAX: i64 = 9_007_199_254_740_991;

const JSON_MAX_DEPTH: usize = 64;

/// Parse `raw` under the JSON validity rule (SPEC.md Conventions): RFC 8259,
/// at most 64 nested containers, finite numbers only, no U+0000 and no
/// unpaired surrogate in any string or key. The one definition for envelope
/// `json` fields, push-payload `json` columns and `blob_ref` values; the TS
/// core's `parseJsonDocument` accepts exactly the same documents.
///
/// `serde_json` itself rejects numbers that overflow binary64 (correctly
/// rounded through the `float_roundtrip` feature, so `f64::MAX` written in
/// full parses) and unpaired surrogate escapes; the walk adds depth and
/// U+0000.
pub fn parse_json_document(raw: &str, what: &str) -> Result<serde_json::Value> {
    use serde_json::Value;
    fn visit(node: &Value, depth: usize, what: &str) -> Result<()> {
        let check_str = |s: &str| {
            if s.contains('\0') {
                return Err(DecodeError::invalid(format!(
                    "{what} holds a string with U+0000"
                )));
            }
            Ok(())
        };
        match node {
            Value::Array(_) | Value::Object(_) if depth == JSON_MAX_DEPTH => {
                Err(DecodeError::invalid(format!(
                    "{what} nests deeper than {JSON_MAX_DEPTH} containers"
                )))
            }
            Value::Array(items) => items
                .iter()
                .try_for_each(|item| visit(item, depth + 1, what)),
            Value::Object(map) => map.iter().try_for_each(|(key, item)| {
                check_str(key)?;
                visit(item, depth + 1, what)
            }),
            Value::String(s) => check_str(s),
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        }
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| {
        DecodeError::invalid(format!(
            "{what} is not a JSON document under the validity rule"
        ))
    })?;
    visit(&value, 0, what)?;
    Ok(value)
}

/// A raw `json`-typed value: validated to parse as a JSON document at decode
/// time, but preserved byte-for-byte (host-opaque; round-trip fidelity, never
/// re-canonicalization — Conventions `json` row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawJson(pub String);

impl RawJson {
    pub fn parse(&self) -> serde_json::Value {
        // Validated at construction; a parse failure here is a codec bug.
        serde_json::from_str(&self.0).expect("RawJson holds validated JSON")
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    pub fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8]> {
        if n > self.remaining() {
            return Err(DecodeError::invalid(format!(
                "truncated: need {n} bytes for {what}, have {}",
                self.remaining()
            )));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self, what: &str) -> Result<u8> {
        Ok(self.take(1, what)?[0])
    }

    pub fn u16(&mut self, what: &str) -> Result<u16> {
        let b = self.take(2, what)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self, what: &str) -> Result<u32> {
        let b = self.take(4, what)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32(&mut self, what: &str) -> Result<i32> {
        let b = self.take(4, what)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i64(&mut self, what: &str) -> Result<i64> {
        let b = self.take(8, what)?;
        let v = i64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if !(-I64_SAFE_MAX..=I64_SAFE_MAX).contains(&v) {
            return Err(DecodeError::invalid(format!(
                "i64 field {what} = {v} outside the ±(2^53−1) safe-integer contract"
            )));
        }
        Ok(v)
    }

    pub fn f64(&mut self, what: &str) -> Result<f64> {
        let b = self.take(8, what)?;
        Ok(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn bool(&mut self, what: &str) -> Result<bool> {
        match self.u8(what)? {
            0x00 => Ok(false),
            0x01 => Ok(true),
            other => Err(DecodeError::invalid(format!(
                "bool field {what} has byte 0x{other:02x} (only 0x00/0x01 are valid)"
            ))),
        }
    }

    /// `opt(T)` presence byte: 0x00 absent, 0x01 present, anything else a
    /// decode error.
    pub fn presence(&mut self, what: &str) -> Result<bool> {
        match self.u8(what)? {
            0x00 => Ok(false),
            0x01 => Ok(true),
            other => Err(DecodeError::invalid(format!(
                "opt presence byte for {what} is 0x{other:02x} (only 0x00/0x01 are valid)"
            ))),
        }
    }

    pub fn str(&mut self, what: &str) -> Result<String> {
        let len = self.u32(what)? as usize;
        let raw = self.take(len, what)?;
        match std::str::from_utf8(raw) {
            Ok(s) => Ok(s.to_owned()),
            Err(_) => Err(DecodeError::invalid(format!(
                "str field {what} is not well-formed UTF-8"
            ))),
        }
    }

    pub fn bytes(&mut self, what: &str) -> Result<Vec<u8>> {
        let len = self.u32(what)? as usize;
        Ok(self.take(len, what)?.to_vec())
    }

    /// `json`: a `str` that must be a valid JSON document (Conventions JSON
    /// validity rule); the raw string is preserved verbatim for round-trip
    /// fidelity.
    pub fn json(&mut self, what: &str) -> Result<RawJson> {
        let s = self.str(what)?;
        parse_json_document(&s, what)?;
        Ok(RawJson(s))
    }

    /// `blob_ref` (§2.4 tag 7, §5.9.1): a `str` holding a canonical BlobRef
    /// document; validated at decode, raw string preserved for round-trip.
    pub fn blob_ref(&mut self, what: &str) -> Result<RawJson> {
        let s = self.str(what)?;
        crate::blob_ref::validate_blob_ref(&s)?;
        Ok(RawJson(s))
    }

    /// `map` of `str` → `list(str)`. Keys must be unique and in ascending
    /// code-unit order (canonical encoding); a violation is a decode error.
    pub fn scope_map(&mut self, what: &str) -> Result<Vec<(String, Vec<String>)>> {
        let count = self.u32(what)? as usize;
        let mut entries: Vec<(String, Vec<String>)> = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            let key = self.str(what)?;
            self.check_key_order(&entries.last().map(|(k, _)| k.as_str()), &key, what)?;
            let n = self.u32(what)? as usize;
            let mut values = Vec::with_capacity(n.min(1024));
            for _ in 0..n {
                values.push(self.str(what)?);
            }
            entries.push((key, values));
        }
        Ok(entries)
    }

    /// `map` of `str` → `str`, same canonical key rules.
    pub fn str_map(&mut self, what: &str) -> Result<Vec<(String, String)>> {
        let count = self.u32(what)? as usize;
        let mut entries: Vec<(String, String)> = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            let key = self.str(what)?;
            self.check_key_order(&entries.last().map(|(k, _)| k.as_str()), &key, what)?;
            let value = self.str(what)?;
            entries.push((key, value));
        }
        Ok(entries)
    }

    fn check_key_order(&self, prev: &Option<&str>, key: &str, what: &str) -> Result<()> {
        if let Some(prev) = prev {
            if !utf16_lt(prev, key) {
                return Err(DecodeError::invalid(format!(
                    "map {what}: key {key:?} is duplicate or out of canonical order after {prev:?}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Writer::default()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    pub fn raw(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn i64(&mut self, v: i64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn bool(&mut self, v: bool) {
        self.buf.push(u8::from(v));
    }

    pub fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.buf.extend_from_slice(s.as_bytes());
    }

    pub fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.buf.extend_from_slice(b);
    }

    pub fn opt<T>(&mut self, v: &Option<T>, mut write: impl FnMut(&mut Self, &T)) {
        match v {
            None => self.u8(0x00),
            Some(inner) => {
                self.u8(0x01);
                write(self, inner);
            }
        }
    }

    pub fn scope_map(&mut self, m: &[(String, Vec<String>)]) {
        self.u32(m.len() as u32);
        for (k, vs) in m {
            self.str(k);
            self.u32(vs.len() as u32);
            for v in vs {
                self.str(v);
            }
        }
    }

    pub fn str_map(&mut self, m: &[(String, String)]) {
        self.u32(m.len() as u32);
        for (k, v) in m {
            self.str(k);
            self.str(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_json_document;

    fn nested(open: &str, close: &str, depth: usize) -> String {
        format!("{}{}", open.repeat(depth), close.repeat(depth))
    }

    /// The same probe table as the TS core's `json-document.test.ts`.
    #[test]
    fn the_json_validity_rule_matches_the_ts_core() {
        let probes: Vec<(&str, String, bool)> = vec![
            ("arrays nested 64 deep", nested("[", "]", 64), true),
            ("arrays nested 65 deep", nested("[", "]", 65), false),
            (
                "objects nested 64 deep",
                format!("{}{{}}{}", "{\"a\":".repeat(63), "}".repeat(63)),
                true,
            ),
            (
                "objects nested 65 deep",
                format!("{}{{}}{}", "{\"a\":".repeat(64), "}".repeat(64)),
                false,
            ),
            ("1e999", "1e999".into(), false),
            ("-1e999 inside an array", "[-1e999]".into(), false),
            ("1e-999 underflows to zero", "1e-999".into(), true),
            ("negative zero", "-0".into(), true),
            (
                "largest finite binary64",
                "1.7976931348623157e308".into(),
                true,
            ),
            ("rounds to infinity", "1.7976931348623159e308".into(), false),
            (
                "integer beyond 2^64",
                "123456789012345678901234567890".into(),
                true,
            ),
            ("unpaired high surrogate", r#""\ud800""#.into(), false),
            ("unpaired low surrogate", r#""\udc00""#.into(), false),
            (
                "high surrogate before a letter",
                r#""\ud800x""#.into(),
                false,
            ),
            ("escaped surrogate pair", r#""😀""#.into(), true),
            ("unpaired surrogate key", r#"{"\ud800":1}"#.into(), false),
            ("U+0000 escape", r#""\u0000""#.into(), false),
            ("U+0000 key", r#"{"\u0000":1}"#.into(), false),
            ("U+0000 deep inside", r#"[{"a":["x\u0000"]}]"#.into(), false),
            ("U+0001 escape", r#""\u0001""#.into(), true),
            ("raw U+0000 in a string", "\"a\0b\"".into(), false),
            ("duplicate keys", r#"{"a":1,"a":2}"#.into(), true),
            (
                "insignificant whitespace",
                r#" { "a" : [ 1 , 2 ] } "#.into(),
                true,
            ),
            ("top-level true", "true".into(), true),
            ("top-level null", "null".into(), true),
            ("top-level string", r#""x""#.into(), true),
            ("top-level number", "7".into(), true),
            ("not JSON", "{not json".into(), false),
            ("trailing comma", "[1,]".into(), false),
            ("leading zero", "01".into(), false),
            ("NaN literal", "NaN".into(), false),
            ("byte order mark", "\u{feff}1".into(), false),
        ];
        for (name, raw, valid) in probes {
            match parse_json_document(&raw, "probe") {
                Ok(_) => assert!(valid, "{name}: accepted, expected a rejection"),
                Err(error) => {
                    assert!(!valid, "{name}: rejected: {}", error.detail);
                    assert_eq!(error.code.as_str(), "sync.invalid_request", "{name}");
                }
            }
        }
    }

    #[test]
    fn the_last_duplicate_key_wins() {
        let value = parse_json_document(r#"{"a":1,"a":[true]}"#, "probe").unwrap();
        assert_eq!(value, serde_json::json!({"a": [true]}));
    }
}
