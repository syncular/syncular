//! §5.10.5 native CRDT (the `crdt-yjs` feature): the Rust face of the Yjs
//! binding, mirroring `@syncular/crdt-yjs`'s `YjsColumn` helper (§5.10.4)
//! exactly. Pure functions over `yrs` (the Rust Yjs port) — a `crdt` column's
//! opaque bytes in, materialized text or a full-state update out. No
//! networking, no SQLite: the [`SyncClient`](crate::SyncClient) crdt methods
//! layer the read-current-bytes → edit → mutate flow on top (§5.10.4
//! optimistic push-update-then-server-merges model).
//!
//! Byte compatibility with the TS helper is the whole point: `yrs` produces
//! Yjs-v1 update bytes, so a native edit and a `@syncular/crdt-yjs` edit merge
//! byte-identically on the server (§5.10.2 order-independent merge), which is
//! what makes the cross-core conformance pairing converge (Appendix B.14,
//! §5.10.5). We never merge locally — merging is server-side (§5.10.3); a
//! local edit only loads the current stored state, applies the op, and
//! re-encodes the whole state as the update to push.

use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

/// Load a `Y.Doc` from stored `crdt` column bytes (a Yjs-v1 update, or a full
/// state — a state is a legal update). Empty/`None` bytes yield a fresh empty
/// doc, matching `new YjsColumn(initial)` where a NULL column is the empty
/// document (§5.10.1). A malformed update is a loud error — the bytes are a
/// crdt column value the codec accepted as `bytes` but that is not valid Yjs.
fn load_doc(bytes: &[u8]) -> Result<Doc, String> {
    let doc = Doc::new();
    if !bytes.is_empty() {
        let update = Update::decode_v1(bytes)
            .map_err(|e| format!("crdt column is not a Yjs update: {e}"))?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|e| format!("applying crdt update failed: {e}"))?;
    }
    Ok(doc)
}

/// The whole doc state encoded as one Yjs-v1 update — the bytes to store in
/// the column, exactly `YjsColumn.columnBytes()` (`Y.encodeStateAsUpdate(doc)`,
/// §5.10.4). Idempotent on the server merger, so pushing full state is safe.
fn column_bytes(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// Materialize the collaborative text of a `crdt` column — `YjsColumn.text().
/// toString()` (§5.10.4). `bytes` is the stored (server-merged) column value;
/// `name` selects the shared text (default `"text"`, matching the TS helper).
pub fn text(bytes: &[u8], name: &str) -> Result<String, String> {
    let doc = load_doc(bytes)?;
    let text = doc.get_or_insert_text(name);
    let value = text.get_string(&doc.transact());
    Ok(value)
}

/// Apply a text insert to the `crdt` column and return the new full-state
/// update to push — mirrors `col.text(name).insert(index, value)` followed by
/// `col.columnBytes()`. `index` is a UTF-16 code-unit offset (Yjs text
/// semantics); an out-of-range index is a loud error.
pub fn insert_text(bytes: &[u8], name: &str, index: u32, value: &str) -> Result<Vec<u8>, String> {
    let doc = load_doc(bytes)?;
    let text = doc.get_or_insert_text(name);
    {
        let mut txn = doc.transact_mut();
        let len = text.len(&txn);
        if index > len {
            return Err(format!("crdt insert index {index} past text length {len}"));
        }
        text.insert(&mut txn, index, value);
    }
    Ok(column_bytes(&doc))
}

/// Apply a text delete to the `crdt` column and return the new full-state
/// update to push — mirrors `col.text(name).delete(index, len)` followed by
/// `col.columnBytes()`. `index`/`len` are UTF-16 code-unit offsets; a range
/// past the end is a loud error.
pub fn delete_text(bytes: &[u8], name: &str, index: u32, len: u32) -> Result<Vec<u8>, String> {
    let doc = load_doc(bytes)?;
    let text = doc.get_or_insert_text(name);
    {
        let mut txn = doc.transact_mut();
        let text_len = text.len(&txn);
        if index.saturating_add(len) > text_len {
            return Err(format!(
                "crdt delete range {index}+{len} past text length {text_len}"
            ));
        }
        text.remove_range(&mut txn, index, len);
    }
    Ok(column_bytes(&doc))
}

/// Generic escape hatch (§5.10.4): apply an arbitrary Yjs update onto the
/// stored `crdt` column bytes and return the new full state to push. This is
/// how an app that produces updates with a full `yrs` model of its own (maps,
/// arrays, XML) feeds them through the column — the same shape a raw
/// `Y.applyUpdate` + `columnBytes()` produces on the TS side. Idempotent: an
/// update already incorporated is a no-op (Yjs CRDT nature, §5.10.3).
pub fn apply_update(bytes: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
    let doc = load_doc(bytes)?;
    if !update.is_empty() {
        let update = Update::decode_v1(update)
            .map_err(|e| format!("crdt update is not a Yjs update: {e}"))?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|e| format!("applying crdt update failed: {e}"))?;
    }
    Ok(column_bytes(&doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_then_materialize_roundtrips() {
        let update = insert_text(&[], "text", 0, "hello").unwrap();
        assert_eq!(text(&update, "text").unwrap(), "hello");
        let update2 = insert_text(&update, "text", 5, " world").unwrap();
        assert_eq!(text(&update2, "text").unwrap(), "hello world");
    }

    #[test]
    fn delete_removes_range() {
        let update = insert_text(&[], "text", 0, "hello world").unwrap();
        let update = delete_text(&update, "text", 5, 6).unwrap();
        assert_eq!(text(&update, "text").unwrap(), "hello");
    }

    #[test]
    fn empty_bytes_is_empty_document() {
        assert_eq!(text(&[], "text").unwrap(), "");
    }

    #[test]
    fn apply_update_merges_and_is_idempotent() {
        let a = insert_text(&[], "text", 0, "A").unwrap();
        // Applying an update onto empty yields the same materialized text.
        let merged = apply_update(&[], &a).unwrap();
        assert_eq!(text(&merged, "text").unwrap(), "A");
        // Re-applying the same update is a no-op (idempotent, §5.10.3).
        let merged2 = apply_update(&merged, &a).unwrap();
        assert_eq!(text(&merged2, "text").unwrap(), "A");
    }

    #[test]
    fn malformed_bytes_error_loudly() {
        assert!(text(&[1, 2, 3, 4], "text").is_err());
        assert!(insert_text(&[9, 9, 9], "text", 0, "x").is_err());
    }
}
