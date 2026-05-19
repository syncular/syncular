use crate::{
    ProtocolError, Result, SnapshotChunkRef, SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
    SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
};

pub const SNAPSHOT_CHUNK_COMPRESSION_GZIP: &str = "gzip";

pub fn validate_snapshot_chunk_format(chunk: &SnapshotChunkRef) -> Result<()> {
    if chunk.compression != SNAPSHOT_CHUNK_COMPRESSION_GZIP {
        return Err(ProtocolError::message(format!(
            "unsupported snapshot chunk compression: {}",
            chunk.compression
        )));
    }
    match chunk.encoding.as_str() {
        SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 | SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 => {
            Ok(())
        }
        encoding => Err(ProtocolError::message(format!(
            "unsupported snapshot chunk encoding: {encoding}"
        ))),
    }
}

pub fn validate_snapshot_chunk_hash_hex(chunk: &SnapshotChunkRef, actual_hash: &str) -> Result<()> {
    if actual_hash != chunk.sha256 {
        return Err(snapshot_chunk_hash_mismatch(chunk, actual_hash));
    }
    Ok(())
}

pub fn validate_snapshot_chunk_hash_bytes(
    chunk: &SnapshotChunkRef,
    actual_hash: &[u8],
) -> Result<()> {
    let expected_hash = decode_snapshot_chunk_sha256(chunk)?;
    if actual_hash != expected_hash.as_slice() {
        return Err(snapshot_chunk_hash_mismatch(
            chunk,
            &hex::encode(actual_hash),
        ));
    }
    Ok(())
}

pub fn decode_snapshot_chunk_sha256(chunk: &SnapshotChunkRef) -> Result<[u8; 32]> {
    let decoded = hex::decode(&chunk.sha256).map_err(|err| {
        ProtocolError::message(format!("decode snapshot chunk expected hash: {err}"))
    })?;
    decoded.try_into().map_err(|_| {
        ProtocolError::message(format!(
            "snapshot chunk expected hash must decode to 32 bytes: {}",
            chunk.sha256
        ))
    })
}

fn snapshot_chunk_hash_mismatch(chunk: &SnapshotChunkRef, actual_hash: &str) -> ProtocolError {
    ProtocolError::message(format!(
        "snapshot chunk hash mismatch: expected {}, got {}",
        chunk.sha256, actual_hash
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn validates_snapshot_chunk_format_and_hash() {
        let compressed = b"chunk-body";
        let chunk = SnapshotChunkRef {
            id: "chunk-1".to_string(),
            byte_length: compressed.len() as i64,
            sha256: hex::encode(Sha256::digest(compressed)),
            encoding: SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1.to_string(),
            compression: SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string(),
        };

        validate_snapshot_chunk_format(&chunk).expect("format");
        validate_snapshot_chunk_hash_bytes(&chunk, &Sha256::digest(compressed)).expect("bytes");
        validate_snapshot_chunk_hash_hex(&chunk, &hex::encode(Sha256::digest(compressed)))
            .expect("hex");
    }
}
