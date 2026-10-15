use ssp2::model::{OpResult, PushResultDetail, PushStatus};
use ssp2::primitives::RawJson;
use ssp2::{decode_message, encode_message, Frame, Message, MsgKind};

fn header() -> Frame {
    Frame::RespHeader {
        required_schema_version: None,
        latest_schema_version: Some(1),
        log_epoch: Some("epoch-1".to_owned()),
        reset_required: Some(false),
    }
}

fn rejected() -> Frame {
    Frame::PushResult {
        client_commit_id: "commit-1".to_owned(),
        status: PushStatus::Rejected,
        commit_seq: None,
        results: vec![OpResult::Error {
            op_index: 0,
            code: "app.invalid".to_owned(),
            message: "diagnostic only".to_owned(),
            retryable: false,
        }],
    }
}

fn details(commit_id: &str, op_index: i32) -> Frame {
    Frame::PushResultDetails {
        client_commit_id: commit_id.to_owned(),
        entries: vec![PushResultDetail {
            op_index,
            details: RawJson(r#"{"reason":"invalid_value"}"#.to_owned()),
        }],
    }
}

#[test]
fn valid_companion_round_trips() {
    let message = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![header(), rejected(), details("commit-1", 0)],
    };
    let decoded = decode_message(&encode_message(&message)).expect("valid companion");
    assert_eq!(decoded, message);
}

#[test]
fn rejects_orphan_and_mismatched_companions() {
    let orphan = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![header(), details("commit-1", 0)],
    };
    assert!(decode_message(&encode_message(&orphan))
        .expect_err("orphan details must fail")
        .to_string()
        .contains("without a preceding PUSH_RESULT"));

    let mismatched = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![header(), rejected(), details("other-commit", 0)],
    };
    assert!(decode_message(&encode_message(&mismatched))
        .expect_err("mismatched details must fail")
        .to_string()
        .contains("does not match its rejected PUSH_RESULT"));

    let wrong_operation = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![header(), rejected(), details("commit-1", 1)],
    };
    assert!(decode_message(&encode_message(&wrong_operation))
        .expect_err("wrong operation details must fail")
        .to_string()
        .contains("does not match an error result"));
}

#[test]
fn rejects_details_that_break_the_host_safe_shape() {
    for raw in [
        r#"{"bogus":1}"#,
        r#"{}"#,
        r#"{"reason":"Not_A_Token"}"#,
        r#"{"reason":"trailing-"}"#,
        r#"{"fieldPaths":["a","a"]}"#,
        r#"{"fieldPaths":["1bad"]}"#,
        r#"{"references":{"parent":" padded"}}"#,
    ] {
        let message = Message {
            wire_version: ssp2::decode::WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![
                header(),
                rejected(),
                Frame::PushResultDetails {
                    client_commit_id: "commit-1".to_owned(),
                    entries: vec![PushResultDetail {
                        op_index: 0,
                        details: RawJson(raw.to_owned()),
                    }],
                },
            ],
        };
        assert!(
            decode_message(&encode_message(&message)).is_err(),
            "details {raw} must fail to decode"
        );
    }
}

#[test]
fn details_must_directly_follow_their_push_result() {
    let message = Message {
        wire_version: ssp2::decode::WIRE_VERSION,
        msg_kind: MsgKind::Response,
        frames: vec![
            header(),
            rejected(),
            Frame::Unknown {
                frame_type: 0xfe,
                payload: vec![1],
            },
            details("commit-1", 0),
        ],
    };
    assert!(decode_message(&encode_message(&message))
        .expect_err("separated details must fail")
        .to_string()
        .contains("without a preceding PUSH_RESULT"));
}
