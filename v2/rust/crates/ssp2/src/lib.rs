//! # ssp2 — Syncular v2 wire codec (Rust POC)
//!
//! A fresh implementation of the SSP2 envelope, the SSG2 rows-segment format,
//! the §2.4 row codec, §8 realtime control messages, and the §11 canonical
//! JSON debug rendering — built **from `v2/SPEC.md` alone** (no reference to
//! the v1 Rust tree or the v2 TypeScript implementations) to prove the
//! written protocol contract is language-neutral. Conformance is pinned by
//! the golden vectors in `v2/spec/vectors/`.

pub mod blob_ref;
pub mod decode;
pub mod encode;
pub mod error;
pub mod model;
pub mod primitives;
pub mod realtime;
pub mod render;
pub mod segment;
pub mod stream;
pub mod util;

pub use decode::decode_message;
pub use encode::encode_message;
pub use error::{DecodeError, ErrorCode};
pub use model::{Frame, Message, MsgKind};
pub use realtime::{
    encode_presence_publish, parse_control, parse_control_value, render_control, ControlMessage,
    PresenceKind,
};
pub use render::{render_message, render_rows_segment};
pub use segment::{decode_rows_segment, encode_rows_segment, RowsSegment, SegmentRow};
pub use stream::{MessageStreamScanner, ScannedMessage};
