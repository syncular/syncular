//! §1.5 `ROUND_FAILURE` frame: round trip, rendering, and every rejection the
//! grammar names (duplicate, out of position, bad code, trailing payload
//! bytes).

use ssp2::model::frame_type as ft;
use ssp2::{decode_message, encode_message, render_message, Frame, Message, MsgKind};

fn s(value: &str) -> Vec<u8> {
    let mut out = (value.len() as u32).to_le_bytes().to_vec();
    out.extend(value.as_bytes());
    out
}

fn req_header_payload() -> Vec<u8> {
    let mut out = s("client-1");
    out.extend(1i32.to_le_bytes());
    out.push(0x01);
    out.extend(s("epoch-1"));
    out
}

fn pull_header_payload() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(10i32.to_le_bytes());
    out.extend(100i32.to_le_bytes());
    out.extend(2i32.to_le_bytes());
    out.push(0x03);
    out
}

fn push_commit_payload() -> Vec<u8> {
    let mut out = s("commit-1");
    out.extend(1u32.to_le_bytes());
    out.extend(s("tasks"));
    out.extend(s("row-1"));
    out.push(2); // delete
    out.push(0x00); // no baseVersion
    out.push(0x00); // no payload
    out
}

/// Assemble a raw request envelope from `(frameType, payload)` pairs, so a
/// negative case can carry bytes no encoder would produce.
fn raw_request(frames: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut bytes = b"SSP2".to_vec();
    bytes.extend(3u16.to_le_bytes());
    bytes.push(0x01);
    bytes.push(0x00);
    for (ty, payload) in frames {
        bytes.push(*ty);
        bytes.extend((payload.len() as u32).to_le_bytes());
        bytes.extend(payload);
    }
    bytes.push(ft::END);
    bytes.extend(0u32.to_le_bytes());
    bytes
}

fn decode_error(frames: &[(u8, Vec<u8>)]) -> String {
    decode_message(&raw_request(frames))
        .expect_err("the grammar rejects this request")
        .detail
}

#[test]
fn valid_round_failure_round_trips_and_renders() {
    let message = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Request,
        frames: vec![
            Frame::ReqHeader {
                client_id: "client-1".to_owned(),
                schema_version: 1,
                log_epoch: Some("epoch-1".to_owned()),
            },
            Frame::RoundFailure {
                code: "transport.timeout".to_owned(),
            },
            Frame::PullHeader {
                limit_commits: 10,
                limit_snapshot_rows: 100,
                max_snapshot_pages: 2,
                accept: 0x03,
            },
        ],
    };
    let bytes = encode_message(&message);
    let decoded = decode_message(&bytes).expect("valid request");
    assert_eq!(decoded, message);
    assert_eq!(encode_message(&decoded), bytes);
    assert_eq!(
        render_message(&decoded)["frames"][1],
        serde_json::json!({"type": "ROUND_FAILURE", "code": "transport.timeout"})
    );
}

#[test]
fn the_code_grammar_accepts_dotted_lowercase_codes_only() {
    let valid = [
        "sync.transport_failed",
        "client.round_download_missing",
        "a.b",
        "a1.b_2.c3",
    ];
    for code in valid {
        assert!(
            decode_message(&raw_request(&[
                (ft::REQ_HEADER, req_header_payload()),
                (ft::ROUND_FAILURE, s(code)),
                (ft::PULL_HEADER, pull_header_payload()),
            ]))
            .is_ok(),
            "{code} must decode"
        );
    }
    let overlong = "a.".to_owned() + &"b".repeat(63);
    assert_eq!(overlong.len(), 65);
    let invalid = [
        String::new(),
        "transport".to_owned(),
        "Transport.timeout".to_owned(),
        "transport..timeout".to_owned(),
        "transport.Timeout".to_owned(),
        ".timeout".to_owned(),
        "transport.timeout.".to_owned(),
        "transport_t imeout.x".to_owned(),
        "1transport.timeout".to_owned(),
        "_transport.timeout".to_owned(),
        overlong,
    ];
    for code in invalid {
        assert!(
            decode_error(&[
                (ft::REQ_HEADER, req_header_payload()),
                (ft::ROUND_FAILURE, s(&code)),
                (ft::PULL_HEADER, pull_header_payload()),
            ])
            .contains("ROUND_FAILURE.code"),
            "{code:?} must be rejected"
        );
    }
}

#[test]
fn the_frame_is_optional_but_at_most_once() {
    assert!(
        decode_message(&raw_request(&[
            (ft::REQ_HEADER, req_header_payload()),
            (ft::PULL_HEADER, pull_header_payload()),
        ]))
        .is_ok(),
        "a request without the frame stays valid"
    );
    assert_eq!(
        decode_error(&[
            (ft::REQ_HEADER, req_header_payload()),
            (ft::ROUND_FAILURE, s("transport.timeout")),
            (ft::ROUND_FAILURE, s("transport.failed")),
            (ft::PULL_HEADER, pull_header_payload()),
        ]),
        "duplicate ROUND_FAILURE frame"
    );
}

#[test]
fn the_frame_must_directly_follow_req_header() {
    assert_eq!(
        decode_error(&[
            (ft::REQ_HEADER, req_header_payload()),
            (ft::PUSH_COMMIT, push_commit_payload()),
            (ft::ROUND_FAILURE, s("transport.timeout")),
            (ft::PULL_HEADER, pull_header_payload()),
        ]),
        "ROUND_FAILURE must immediately follow REQ_HEADER"
    );
    assert_eq!(
        decode_error(&[
            (ft::REQ_HEADER, req_header_payload()),
            (ft::PULL_HEADER, pull_header_payload()),
            (ft::ROUND_FAILURE, s("transport.timeout")),
        ]),
        "ROUND_FAILURE must immediately follow REQ_HEADER"
    );
    // An unknown frame is a body frame for ordering purposes, as for LEASE.
    assert_eq!(
        decode_error(&[
            (ft::REQ_HEADER, req_header_payload()),
            (0x2f, vec![0x01]),
            (ft::ROUND_FAILURE, s("transport.timeout")),
            (ft::PULL_HEADER, pull_header_payload()),
        ]),
        "ROUND_FAILURE must immediately follow REQ_HEADER"
    );
}

#[test]
fn the_frame_does_not_make_a_request_legal_on_its_own() {
    assert_eq!(
        decode_error(&[
            (ft::REQ_HEADER, req_header_payload()),
            (ft::ROUND_FAILURE, s("transport.timeout")),
        ]),
        "request has neither PUSH_COMMIT nor PULL_HEADER frames"
    );
}

#[test]
fn trailing_bytes_inside_the_frame_are_a_decode_error() {
    let mut payload = s("transport.timeout");
    payload.push(0x00);
    assert!(decode_error(&[
        (ft::REQ_HEADER, req_header_payload()),
        (ft::ROUND_FAILURE, payload),
        (ft::PULL_HEADER, pull_header_payload()),
    ])
    .contains("trailing bytes inside ROUND_FAILURE frame"));
}

#[test]
#[should_panic(expected = "ROUND_FAILURE.code")]
fn the_encoder_refuses_a_code_outside_the_grammar() {
    encode_message(&Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Request,
        frames: vec![
            Frame::ReqHeader {
                client_id: "client-1".to_owned(),
                schema_version: 1,
                log_epoch: Some("epoch-1".to_owned()),
            },
            Frame::RoundFailure {
                code: "transport".to_owned(),
            },
            Frame::PullHeader {
                limit_commits: 10,
                limit_snapshot_rows: 100,
                max_snapshot_pages: 2,
                accept: 0x03,
            },
        ],
    });
}
