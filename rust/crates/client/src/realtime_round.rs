//! Transport-agnostic §8.7 sync-round-over-socket framing.
//!
//! The realtime channel carries one-byte channel-tagged binary messages
//! (§8.7): tag `0x00` is a standalone SSP2 response (a delta, §8.2), tag
//! `0x01` is a chunk of the in-flight round's byte stream. This module owns
//! the tag demux and the scanner-driven response reassembly — the protocol
//! logic — leaving the WS send/read plumbing to each native transport. It
//! is deliberately free of any WS dependency so it lives in the lean client
//! crate and both native transports (FFI + Tauri plugin) share it via their
//! existing `syncular-client` dependency (the honest single-source, since
//! the crates are in different cargo workspaces and cannot share a private
//! module directly).
//!
//! It mirrors the reference host reassembly in
//! `packages/conformance/src/drivers/rust-client.ts` (`#routeBinary` /
//! `#realtimeRound`), which is the reference client's socket-round path:
//! tag the request `0x01`, reassemble `0x01` response chunks to `END`,
//! reject bytes past `END`, and route `0x00` deltas + text frames to the
//! inbound queue for the command path to apply (§8.2). Deltas MUST NOT
//! arrive mid-round per server discipline (§8.7 interleaving), but the
//! honest client posture is tolerate-and-queue — matching the TS host,
//! which routes a stray delta to the inbound lane rather than failing.

use crate::{MessageStreamScanner, TransportError};

/// §8.7 channel tags. A closed registry per wire version.
pub const REALTIME_TAG_DELTA: u8 = 0x00;
pub const REALTIME_TAG_ROUND: u8 = 0x01;

/// What a native transport should do with one inbound binary frame that the
/// round demux classified.
#[derive(Debug)]
pub enum RoundInbound {
    /// A `0x00` delta payload (tag stripped) to hand to the client as an
    /// inbound realtime binary frame (queued for the command path, §8.2).
    Delta(Vec<u8>),
    /// A `0x01` round chunk that did not yet complete the response — nothing
    /// for the caller to do but keep reading.
    RoundProgress,
    /// The round's response is fully reassembled: the complete SSP2 response
    /// envelope bytes, ready to return from `realtime_sync`.
    RoundComplete(Vec<u8>),
    /// A `0x01` round chunk arrived with no round in flight, or an unknown
    /// tag: tolerated and ignored (§8.7 forward-compat).
    Ignored,
}

/// The per-connection round state: at most one round in flight (§8.7). A
/// native transport creates one of these per socket and drives it from its
/// reader loop (`route_binary`) and its `realtime_sync` call
/// (`begin`/`finish`).
#[derive(Default)]
pub struct RealtimeRound {
    /// The active round's response scanner, `Some` between `begin` and the
    /// response `END` (or a failure). Its presence is the "one round in
    /// flight" flag.
    scanner: Option<MessageStreamScanner>,
}

impl RealtimeRound {
    pub fn new() -> Self {
        Self::default()
    }

    /// True while a round is in flight (request sent, response not yet at
    /// `END`). The client-side enforcement of §8.7's "one round in flight".
    pub fn in_flight(&self) -> bool {
        self.scanner.is_some()
    }

    /// Frame the request for the socket: a `0x01` tag byte followed by the
    /// whole request envelope. Chunk boundaries are arbitrary (§8.7), so a
    /// single chunk carrying the entire request is legal and simplest; the
    /// request is already bounded (bulk rides segments over HTTP, §5.7), so
    /// there is nothing to gain by splitting it. Marks the round in flight.
    ///
    /// Returns an error if a round is already in flight (client-side §8.7
    /// one-in-flight enforcement — the caller must not pipeline).
    pub fn begin(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        if self.scanner.is_some() {
            return Err(TransportError::new(
                "sync.transport_failed",
                "a realtime sync round is already in flight (§8.7 one round per connection)",
            ));
        }
        self.scanner = Some(MessageStreamScanner::new());
        let mut framed = Vec::with_capacity(request.len() + 1);
        framed.push(REALTIME_TAG_ROUND);
        framed.extend_from_slice(request);
        Ok(framed)
    }

    /// Route one inbound binary frame (tag byte + payload) while a round may
    /// be in flight. `0x01` chunks feed the response scanner; `0x00` deltas
    /// are surfaced for the inbound queue; unknown tags are ignored.
    ///
    /// On a scanner error (bad envelope header) or bytes past `END`, the
    /// round is failed and the error returned — the caller wakes the pending
    /// `realtime_sync` with it and (per §8.7) the connection is unusable.
    pub fn route_binary(&mut self, frame: &[u8]) -> Result<RoundInbound, TransportError> {
        if frame.is_empty() {
            return Ok(RoundInbound::Ignored);
        }
        let tag = frame[0];
        let body = &frame[1..];
        match tag {
            REALTIME_TAG_ROUND => {
                let Some(scanner) = self.scanner.as_mut() else {
                    // A round chunk with no round in flight: tolerated and
                    // ignored (mirrors the TS host's `round === undefined`
                    // early return).
                    return Ok(RoundInbound::Ignored);
                };
                match scanner.push(body) {
                    Ok(None) => Ok(RoundInbound::RoundProgress),
                    Ok(Some(done)) => {
                        self.scanner = None;
                        if done.excess > 0 {
                            return Err(TransportError::new(
                                "sync.transport_failed",
                                "realtime round response has bytes past END (§8.7)",
                            ));
                        }
                        Ok(RoundInbound::RoundComplete(done.message))
                    }
                    Err(error) => {
                        self.scanner = None;
                        Err(TransportError::new(
                            "sync.transport_failed",
                            format!("realtime round response decode error: {}", error.detail),
                        ))
                    }
                }
            }
            REALTIME_TAG_DELTA => Ok(RoundInbound::Delta(body.to_vec())),
            // Unknown tag: tolerated and ignored (§8.7 closed registry,
            // forward-compat mirror of §8.1's unknown-event rule).
            _ => Ok(RoundInbound::Ignored),
        }
    }

    /// Abandon any in-flight round (socket dropped mid-round). Clears the
    /// in-flight flag so the connection can be re-established.
    pub fn abort(&mut self) {
        self.scanner = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssp2::model::{Frame, Message, MsgKind};
    use ssp2::{encode_message, MessageStreamScanner as _Scanner};

    fn response_bytes() -> Vec<u8> {
        // A minimal but real response envelope: RESP_HEADER + END.
        let message = Message {
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
            }],
        };
        encode_message(&message)
    }

    fn tagged(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut v = vec![tag];
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn begin_frames_request_with_round_tag_and_marks_in_flight() {
        let mut round = RealtimeRound::new();
        assert!(!round.in_flight());
        let framed = round.begin(&[0xde, 0xad]).unwrap();
        assert_eq!(framed, vec![REALTIME_TAG_ROUND, 0xde, 0xad]);
        assert!(round.in_flight());
    }

    #[test]
    fn second_begin_while_in_flight_is_rejected() {
        let mut round = RealtimeRound::new();
        round.begin(&[0x01]).unwrap();
        let err = round.begin(&[0x02]).unwrap_err();
        assert_eq!(err.code, "sync.transport_failed");
        assert!(err.message.contains("one round"));
    }

    #[test]
    fn single_chunk_response_completes_and_clears_in_flight() {
        let response = response_bytes();
        let mut round = RealtimeRound::new();
        round.begin(&[0x00]).unwrap();
        let frame = tagged(REALTIME_TAG_ROUND, &response);
        match round.route_binary(&frame).unwrap() {
            RoundInbound::RoundComplete(bytes) => assert_eq!(bytes, response),
            _ => panic!("expected RoundComplete"),
        }
        assert!(!round.in_flight(), "round clears after END");
    }

    #[test]
    fn chunked_response_reassembles_across_arbitrary_boundaries() {
        let response = response_bytes();
        for split in 1..response.len() {
            let mut round = RealtimeRound::new();
            round.begin(&[0x00]).unwrap();
            let first = tagged(REALTIME_TAG_ROUND, &response[..split]);
            assert!(matches!(
                round.route_binary(&first).unwrap(),
                RoundInbound::RoundProgress
            ));
            let second = tagged(REALTIME_TAG_ROUND, &response[split..]);
            match round.route_binary(&second).unwrap() {
                RoundInbound::RoundComplete(bytes) => {
                    assert_eq!(bytes, response, "split {split}")
                }
                _ => panic!("split {split}: expected RoundComplete"),
            }
        }
    }

    #[test]
    fn delta_during_round_is_queued_not_applied_to_round() {
        let response = response_bytes();
        let mut round = RealtimeRound::new();
        round.begin(&[0x00]).unwrap();
        // A stray delta arrives mid-round (server discipline forbids it, but
        // the client tolerates-and-queues): it is surfaced as a Delta, and
        // the round stays in flight.
        let delta = tagged(REALTIME_TAG_DELTA, &[0xaa, 0xbb]);
        match round.route_binary(&delta).unwrap() {
            RoundInbound::Delta(body) => assert_eq!(body, vec![0xaa, 0xbb]),
            _ => panic!("expected Delta"),
        }
        assert!(round.in_flight(), "delta does not end the round");
        // The round still completes normally afterwards.
        let frame = tagged(REALTIME_TAG_ROUND, &response);
        assert!(matches!(
            round.route_binary(&frame).unwrap(),
            RoundInbound::RoundComplete(_)
        ));
    }

    #[test]
    fn bytes_past_end_fail_the_round() {
        let mut response = response_bytes();
        response.extend_from_slice(&[0xff, 0xff]);
        let mut round = RealtimeRound::new();
        round.begin(&[0x00]).unwrap();
        let frame = tagged(REALTIME_TAG_ROUND, &response);
        let err = round.route_binary(&frame).unwrap_err();
        assert_eq!(err.code, "sync.transport_failed");
        assert!(err.message.contains("past END"));
        assert!(!round.in_flight());
    }

    #[test]
    fn round_chunk_with_no_round_in_flight_is_ignored() {
        let mut round = RealtimeRound::new();
        let frame = tagged(REALTIME_TAG_ROUND, &[0x01, 0x02]);
        assert!(matches!(
            round.route_binary(&frame).unwrap(),
            RoundInbound::Ignored
        ));
    }

    #[test]
    fn unknown_tag_is_ignored() {
        let mut round = RealtimeRound::new();
        round.begin(&[0x00]).unwrap();
        let frame = tagged(0x7f, &[0x01]);
        assert!(matches!(
            round.route_binary(&frame).unwrap(),
            RoundInbound::Ignored
        ));
        assert!(round.in_flight());
    }

    // Silence the unused-import lint for the aliased scanner (kept to document
    // the reassembly primitive the round drives).
    #[allow(dead_code)]
    fn _uses_scanner(_: _Scanner) {}
}
