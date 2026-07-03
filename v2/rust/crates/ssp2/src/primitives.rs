//! Conventions primitives (SPEC.md "Conventions and primitive encodings"):
//! little-endian fixed-width integers, `str`, `bytes`, `opt`, `bool`, `json`,
//! canonical maps. Shared by the envelope codec and the SSG2 segment codec.

use crate::error::{DecodeError, Result};
use crate::util::utf16_lt;

/// JS safe-integer contract: `i64` values must be within ±(2^53 − 1).
pub const I64_SAFE_MAX: i64 = 9_007_199_254_740_991;

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

    /// `json`: a `str` that must parse as a JSON document; the raw string is
    /// preserved verbatim for round-trip fidelity.
    pub fn json(&mut self, what: &str) -> Result<RawJson> {
        let s = self.str(what)?;
        if serde_json::from_str::<serde_json::Value>(&s).is_err() {
            return Err(DecodeError::invalid(format!(
                "json field {what} does not parse as a JSON document"
            )));
        }
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
