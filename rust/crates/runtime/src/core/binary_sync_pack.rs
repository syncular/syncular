use crate::error::Result;
use crate::protocol::CombinedResponse;

pub use syncular_protocol::binary_sync_pack::{
    is_binary_sync_pack_content_type, SYNC_PACK_CONTENT_TYPE, SYNC_PACK_ENCODING_BINARY_V1,
    SYNC_PACK_ENCODING_JSON_V1,
};

pub fn decode_binary_sync_pack(bytes: &[u8]) -> Result<CombinedResponse> {
    Ok(syncular_protocol::binary_sync_pack::decode_binary_sync_pack(bytes)?)
}
