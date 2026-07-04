//! Incremental SSP2 message-stream scanner (SPEC.md §1.4, §8.7).
//!
//! The envelope grammar is self-delimiting — an 8-byte header, then
//! length-prefixed frames until `END` — so a byte stream split across
//! arbitrary chunk boundaries (WebSocket messages, §8.7) needs no
//! reassembly protocol beyond concatenation plus this scanner: feed
//! chunks, learn exactly where one complete envelope ends. Used by the
//! native transport for round-response reassembly (the Rust mirror of
//! `packages/core/src/stream.ts`'s `MessageStreamScanner`, the TS
//! reference the conformance host uses).
//!
//! The scanner validates only the 8-byte header (a stream whose header is
//! not a valid SSP2 envelope has no findable end, §8.7 connection-fatal
//! rule) and walks frame length prefixes; full decoding stays with
//! [`crate::decode_message`].

use crate::decode::{SSP2_MAGIC, WIRE_VERSION};
use crate::error::{DecodeError, Result};
use crate::model::frame_type;

/// A completed scan: the exact envelope bytes plus any surplus buffered
/// past the `END` frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedMessage {
    /// The complete envelope bytes (header through the `END` frame).
    pub message: Vec<u8>,
    /// Byte count buffered PAST the `END` frame — a §8.7 stream MUST end
    /// exactly at the `END` frame's last byte, so any excess is a protocol
    /// violation (pipelining) for the caller to act on.
    pub excess: usize,
}

/// Feed bytes, learn exactly where one complete SSP2 envelope ends.
///
/// Mirrors `MessageStreamScanner` in `packages/core/src/stream.ts` frame
/// for frame: header validation, frame-length walking, exact-`END`
/// detection, and excess reporting. Once complete, [`push`](Self::push)
/// must not be called again.
#[derive(Default)]
pub struct MessageStreamScanner {
    buffer: Vec<u8>,
    /// Parse cursor: start of the next frame header; `None` while the
    /// 8-byte envelope header is still incomplete.
    offset: Option<usize>,
    complete: bool,
}

impl MessageStreamScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// True once any bytes were fed.
    pub fn started(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// Feed one chunk. Returns `Ok(Some(..))` once the `END` frame is fully
    /// buffered, `Ok(None)` while more bytes are needed. Returns a
    /// `DecodeError` on an invalid envelope header (connection-fatal per
    /// §8.7). Panics on use after completion (a caller bug, mirroring the
    /// TS scanner's thrown error).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<ScannedMessage>> {
        assert!(
            !self.complete,
            "MessageStreamScanner: message already complete"
        );
        self.buffer.extend_from_slice(chunk);
        if self.offset.is_none() {
            if self.buffer.len() < 8 {
                return Ok(None);
            }
            self.check_header()?;
            self.offset = Some(8);
        }
        let mut offset = self.offset.expect("offset set once header parsed");
        loop {
            // Every frame is a 1-byte type + 4-byte little-endian length.
            if self.buffer.len() - offset < 5 {
                self.offset = Some(offset);
                return Ok(None);
            }
            let frame_type = self.buffer[offset];
            let frame_length = u32::from_le_bytes([
                self.buffer[offset + 1],
                self.buffer[offset + 2],
                self.buffer[offset + 3],
                self.buffer[offset + 4],
            ]) as usize;
            let frame_end = offset + 5 + frame_length;
            if self.buffer.len() < frame_end {
                self.offset = Some(offset);
                return Ok(None);
            }
            offset = frame_end;
            if frame_type == frame_type::END {
                self.complete = true;
                self.offset = Some(offset);
                return Ok(Some(ScannedMessage {
                    message: self.buffer[..frame_end].to_vec(),
                    excess: self.buffer.len() - frame_end,
                }));
            }
        }
    }

    fn check_header(&self) -> Result<()> {
        let b = &self.buffer;
        if b[0..4] != SSP2_MAGIC[..] {
            return Err(DecodeError::invalid("bad envelope magic (expected SSP2)"));
        }
        let wire_version = u16::from_le_bytes([b[4], b[5]]);
        if wire_version != WIRE_VERSION {
            return Err(DecodeError::invalid(format!(
                "unsupported wireVersion {wire_version}"
            )));
        }
        if b[6] != 0x01 && b[6] != 0x02 {
            return Err(DecodeError::invalid(format!(
                "unknown msgKind byte 0x{:02x}",
                b[6]
            )));
        }
        if b[7] != 0x00 {
            return Err(DecodeError::invalid(format!(
                "envelope flags must be 0x00, got 0x{:02x}",
                b[7]
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode_message;
    use crate::model::{Frame, Message, MsgKind};

    /// A small but real request envelope (REQ_HEADER + PULL_HEADER + END) —
    /// the same shape the TS scanner test uses.
    fn request_bytes() -> Vec<u8> {
        let message = Message {
            msg_kind: MsgKind::Request,
            frames: vec![
                Frame::ReqHeader {
                    client_id: "c1".to_owned(),
                    schema_version: 1,
                },
                Frame::PullHeader {
                    limit_commits: 0,
                    limit_snapshot_rows: 0,
                    max_snapshot_pages: 0,
                    accept: 0b0011,
                },
            ],
        };
        encode_message(&message)
    }

    #[test]
    fn whole_message_in_one_chunk_completes_with_zero_excess() {
        let request = request_bytes();
        let mut scanner = MessageStreamScanner::new();
        let result = scanner.push(&request).unwrap().expect("complete");
        assert_eq!(result.excess, 0);
        assert_eq!(result.message, request);
    }

    #[test]
    fn every_split_point_reassembles_byte_exactly() {
        let request = request_bytes();
        for split in 1..request.len() {
            let mut scanner = MessageStreamScanner::new();
            assert!(
                scanner.push(&request[..split]).unwrap().is_none(),
                "split {split}: first half must be incomplete"
            );
            let result = scanner
                .push(&request[split..])
                .unwrap()
                .unwrap_or_else(|| panic!("split {split}: second half must complete"));
            assert_eq!(result.excess, 0, "split {split}");
            assert_eq!(result.message, request, "split {split}");
        }
    }

    #[test]
    fn one_byte_at_a_time_trickle_completes() {
        let request = request_bytes();
        let mut scanner = MessageStreamScanner::new();
        let mut result = None;
        for byte in &request {
            result = scanner.push(&[*byte]).unwrap();
        }
        let result = result.expect("complete after last byte");
        assert_eq!(result.excess, 0);
        assert_eq!(result.message, request);
    }

    #[test]
    fn bytes_past_end_are_reported_as_excess() {
        let request = request_bytes();
        let mut with_excess = request.clone();
        with_excess.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
        let mut scanner = MessageStreamScanner::new();
        let result = scanner.push(&with_excess).unwrap().expect("complete");
        assert_eq!(result.excess, 3);
        assert_eq!(result.message, request);
    }

    #[test]
    fn two_message_stream_every_split_reassembles_first_exactly() {
        // The exhaustive split-point pattern over a *two*-message stream:
        // the scanner must find the first message's END regardless of where
        // the chunk boundary falls, reassembling it byte-exactly. Excess is
        // whatever second-message bytes were already buffered at the moment
        // the first message's END was consumed — the §8.7 pipelining signal.
        let first = request_bytes();
        let second = request_bytes();
        let mut stream = first.clone();
        stream.extend_from_slice(&second);
        for split in 1..stream.len() {
            let mut scanner = MessageStreamScanner::new();
            // Feed the first chunk; if it already completes (split at or past
            // the first message's END), the excess is what that chunk carried
            // past END. Otherwise feed the rest and complete then.
            let (result, buffered_at_completion) = match scanner.push(&stream[..split]).unwrap() {
                Some(done) => (done, split),
                None => {
                    let done = scanner
                        .push(&stream[split..])
                        .unwrap()
                        .unwrap_or_else(|| panic!("split {split}: first message must complete"));
                    (done, stream.len())
                }
            };
            assert_eq!(result.message, first, "split {split}: first message bytes");
            assert_eq!(
                result.excess,
                buffered_at_completion - first.len(),
                "split {split}: excess equals second-message bytes buffered at END"
            );
        }
    }

    #[test]
    fn bad_magic_is_a_decode_error_once_header_arrived() {
        let mut request = request_bytes();
        request[0] = 0x58;
        let mut scanner = MessageStreamScanner::new();
        assert!(scanner.push(&request[..4]).unwrap().is_none());
        assert!(scanner.push(&request[4..]).is_err());
    }

    #[test]
    fn non_zero_flags_and_unknown_msg_kind_are_decode_errors() {
        for (index, value) in [(6usize, 0x03u8), (7usize, 0x01u8)] {
            let mut request = request_bytes();
            request[index] = value;
            let mut scanner = MessageStreamScanner::new();
            assert!(scanner.push(&request).is_err(), "index {index}");
        }
    }

    #[test]
    #[should_panic(expected = "already complete")]
    fn push_after_completion_panics() {
        let request = request_bytes();
        let mut scanner = MessageStreamScanner::new();
        scanner.push(&request).unwrap();
        let _ = scanner.push(&[0]);
    }
}
