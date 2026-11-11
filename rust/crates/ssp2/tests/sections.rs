//! Wire version 4 frame grammar the golden vectors leave out: §4.5 "Section
//! order", the §1.5 `UNIT`/`PROGRESS` placement, and the encoder's refusals.

use ssp2::decode::WIRE_VERSION;
use ssp2::model::{EchoStatus, FencedRecord, LiveStatus, SubStatus};
use ssp2::{decode_message, encode_message, Frame, Message, MsgKind};

const UNIT_ID: &str = "47c583f8f997e2a55f46dc618c2f1969";

fn message(msg_kind: MsgKind, frames: Vec<Frame>) -> Vec<u8> {
    encode_message(&Message {
        wire_version: WIRE_VERSION,
        msg_kind,
        frames,
    })
}

fn decode_error(msg_kind: MsgKind, frames: Vec<Frame>) -> String {
    decode_message(&message(msg_kind, frames))
        .expect_err("the grammar rejects this message")
        .detail
}

fn req_header() -> Frame {
    Frame::ReqHeader {
        client_id: "client-1".to_owned(),
        schema_version: 1,
        log_epoch: Some("epoch-1".to_owned()),
        outbox_id: Some("outbox-1".to_owned()),
    }
}

fn pull_header() -> Frame {
    Frame::PullHeader {
        limit_commits: 0,
        limit_snapshot_rows: 0,
        max_snapshot_pages: 0,
        accept: 0x03,
        cursor: 7,
        registration_digest: [1; 32],
        echo_digest: Some([2; 32]),
    }
}

fn unit() -> Frame {
    Frame::Unit {
        scopes: vec![("campaign_id".to_owned(), "c1".to_owned())],
    }
}

fn progress() -> Frame {
    Frame::Progress {
        id: UNIT_ID.to_owned(),
        cursor: -1,
        bootstrap_state: None,
    }
}

fn resp_header() -> Frame {
    Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: None,
        log_epoch: "epoch-1".to_owned(),
        reset_required: false,
    }
}

fn push_result() -> Frame {
    Frame::PushResult {
        client_commit_id: "commit-1".to_owned(),
        status: ssp2::model::PushStatus::Applied,
        commit_seq: Some(1),
        results: vec![],
    }
}

fn sub_start() -> Frame {
    Frame::SubStart {
        id: UNIT_ID.to_owned(),
        status: SubStatus::Active,
        reason_code: String::new(),
        bootstrap: false,
        fenced: vec![FencedRecord {
            table: "tasks".to_owned(),
            status: EchoStatus::Active,
            scopes: vec![("assignee".to_owned(), vec!["u1".to_owned()])],
        }],
    }
}

fn sub_end() -> Frame {
    Frame::SubEnd {
        next_cursor: 7,
        bootstrap_state: None,
    }
}

fn live_start() -> Frame {
    Frame::LiveStart {
        status: LiveStatus::Active,
        reason_code: String::new(),
    }
}

fn live_end() -> Frame {
    Frame::LiveEnd {
        through_seq: 7,
        echo_digest: Some([3; 32]),
    }
}

fn commit() -> Frame {
    Frame::Commit {
        commit_seq: 7,
        created_at_ms: 0,
        actor_id: "actor-1".to_owned(),
        tables: vec!["tasks".to_owned()],
        changes: vec![],
    }
}

#[test]
fn a_full_request_and_response_round_trip() {
    for (kind, frames) in [
        (
            MsgKind::Request,
            vec![req_header(), pull_header(), unit(), progress()],
        ),
        (
            MsgKind::Response,
            vec![
                resp_header(),
                push_result(),
                sub_start(),
                sub_end(),
                live_start(),
                commit(),
                live_end(),
            ],
        ),
    ] {
        let bytes = message(kind, frames.clone());
        let decoded = decode_message(&bytes).expect("valid message");
        assert_eq!(decoded.frames, frames);
        assert_eq!(encode_message(&decoded), bytes);
    }
}

#[test]
fn request_order_errors() {
    assert_eq!(
        decode_error(MsgKind::Request, vec![req_header(), progress()]),
        "PROGRESS frame without a preceding PULL_HEADER"
    );
    assert_eq!(
        decode_error(
            MsgKind::Request,
            vec![req_header(), pull_header(), unit(), pull_header()]
        ),
        "duplicate PULL_HEADER frame"
    );
    assert_eq!(
        decode_error(
            MsgKind::Request,
            vec![
                req_header(),
                pull_header(),
                progress(),
                Frame::RoundFailure {
                    code: "transport.timeout".to_owned()
                },
            ]
        ),
        "ROUND_FAILURE must immediately follow REQ_HEADER"
    );
}

#[test]
fn response_section_order_errors() {
    let cases = [
        (
            vec![resp_header(), commit()],
            "COMMIT frame outside the live section",
        ),
        (
            vec![resp_header(), live_start(), live_end(), commit()],
            "COMMIT frame outside the live section",
        ),
        (
            vec![resp_header(), live_end()],
            "LIVE_END without an open LIVE_START",
        ),
        (
            vec![resp_header(), sub_start(), sub_end(), push_result()],
            "PUSH_RESULT after a unit or live section (out of grammar order)",
        ),
        (
            vec![resp_header(), live_start(), live_end(), push_result()],
            "PUSH_RESULT after a unit or live section (out of grammar order)",
        ),
        (
            vec![
                resp_header(),
                live_start(),
                Frame::SegmentInline { payload: vec![] },
            ],
            "segment frame outside a unit section",
        ),
        (
            vec![
                resp_header(),
                live_start(),
                live_end(),
                sub_start(),
                sub_end(),
            ],
            "SUB_START inside or after the live section",
        ),
        (
            vec![resp_header(), sub_start(), live_start()],
            "LIVE_START inside a unit section",
        ),
        (
            vec![resp_header(), live_start(), sub_end()],
            "SUB_END without an open unit section",
        ),
    ];
    for (frames, expected) in cases {
        assert_eq!(decode_error(MsgKind::Response, frames), expected);
    }
}

#[test]
fn an_error_frame_may_close_an_open_section() {
    let error = Frame::Error {
        code: "sync.internal".to_owned(),
        message: "m".to_owned(),
        category: "server".to_owned(),
        retryable: true,
        recommended_action: "retry".to_owned(),
        details: None,
    };
    let bytes = message(MsgKind::Response, vec![resp_header(), live_start(), error]);
    assert!(decode_message(&bytes).is_ok());
}

#[test]
#[should_panic(expected = "SUB_START.fenced tables must be unique")]
fn the_encoder_refuses_repeated_fenced_tables() {
    let record = FencedRecord {
        table: "tasks".to_owned(),
        status: EchoStatus::Revoked,
        scopes: vec![],
    };
    message(
        MsgKind::Response,
        vec![
            resp_header(),
            Frame::SubStart {
                id: UNIT_ID.to_owned(),
                status: SubStatus::Active,
                reason_code: String::new(),
                bootstrap: false,
                fenced: vec![record.clone(), record],
            },
        ],
    );
}

#[test]
#[should_panic(expected = "REQ_HEADER.outboxId")]
fn the_encoder_refuses_an_outbox_id_over_64_bytes() {
    message(
        MsgKind::Request,
        vec![
            Frame::ReqHeader {
                client_id: "client-1".to_owned(),
                schema_version: 1,
                log_epoch: None,
                outbox_id: Some("x".repeat(65)),
            },
            pull_header(),
        ],
    );
}
