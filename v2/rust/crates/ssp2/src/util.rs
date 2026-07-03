//! Small helpers: base64 (for §11 renderings) and UTF-16 code-unit ordering
//! (Conventions: map keys are canonically sorted by code unit).

/// Standard base64 with padding (RFC 4648), encode only — used solely by the
/// §11 debug rendering.
pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Strict less-than by UTF-16 code units. The reference implementation is
/// TypeScript, whose string ordering compares UTF-16 code units; UTF-8 byte
/// order differs for U+E000..U+FFFF vs supplementary-plane characters, so we
/// match the code-unit contract exactly.
pub fn utf16_lt(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}
