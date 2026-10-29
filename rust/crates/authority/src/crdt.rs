//! §5.10.2 CRDT mergers. With the `crdt-yjs` feature the authority registers
//! the `yjs-doc` merger of `@syncular/crdt-yjs` (apply `stored`, apply
//! `incoming`, encode the whole state); without it no merger is registered.

pub(crate) enum MergeError {
    /// No merger is registered for the column's `crdtType`.
    Unregistered,
    /// The merger refused the bytes.
    #[cfg_attr(not(feature = "crdt-yjs"), allow(dead_code))]
    Failed,
}

#[cfg(feature = "crdt-yjs")]
pub(crate) fn merge(
    crdt_type: &str,
    stored: Option<&[u8]>,
    incoming: &[u8],
) -> Result<Vec<u8>, MergeError> {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

    if crdt_type != "yjs-doc" {
        return Err(MergeError::Unregistered);
    }
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        for bytes in stored.into_iter().chain([incoming]) {
            if bytes.is_empty() {
                continue;
            }
            let update = Update::decode_v1(bytes).map_err(|_| MergeError::Failed)?;
            txn.apply_update(update).map_err(|_| MergeError::Failed)?;
        }
    }
    let merged = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(merged)
}

#[cfg(not(feature = "crdt-yjs"))]
pub(crate) fn merge(
    crdt_type: &str,
    stored: Option<&[u8]>,
    incoming: &[u8],
) -> Result<Vec<u8>, MergeError> {
    let _ = (crdt_type, stored, incoming);
    Err(MergeError::Unregistered)
}
