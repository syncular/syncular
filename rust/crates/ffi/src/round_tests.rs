//! §8.7 round-over-socket framing, end-to-end against a scripted in-test WS
//! server (tungstenite accept loop) speaking §8.7 bytes built with the ssp2
//! codec — the loopback doctrine in Rust. These exercise the REAL native
//! transport (`HostTransport::Native`, driven through the public `Transport`
//! trait) so the tag framing, single-reader coordination, chunk reassembly,
//! delta-during-round queuing, and one-in-flight enforcement are all proven
//! against actual WebSocket traffic — no mocks below the socket.
//!
//! Only built with `native-transport` (the server + transport both need the
//! WS stack).

#![cfg(feature = "native-transport")]

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::json;
use ssp2::model::{Frame, Message, MsgKind};
use ssp2::{encode_message, MessageStreamScanner};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message as WsMessage;

use syncular_client::{Transport, REALTIME_TAG_DELTA, REALTIME_TAG_ROUND};

#[allow(clippy::result_large_err)]
fn assert_client_identity(
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    assert_eq!(
        request.uri().query(),
        Some("transport=round&clientId=c1"),
        "native realtime must retain host query params and replace the client identity"
    );
    Ok(response)
}

use crate::transport::{HostTransport, Inbound};

/// A minimal SSP2 response envelope (RESP_HEADER + END) — the reference
/// server's answer to a bare round.
fn response_bytes() -> Vec<u8> {
    encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Response,
        frames: vec![Frame::RespHeader {
            required_schema_version: None,
            latest_schema_version: None,
            log_epoch: None,
            reset_required: None,
        }],
    })
}

/// Read one complete tag-`0x01` request stream off the socket, reassembling
/// chunks to END and asserting the tag + a valid SSP2 request envelope.
fn read_round_request<S: std::io::Read + std::io::Write>(
    ws: &mut tungstenite::WebSocket<S>,
) -> Vec<u8> {
    let mut scanner = MessageStreamScanner::new();
    loop {
        match ws.read().expect("server read") {
            WsMessage::Binary(frame) => {
                assert_eq!(frame[0], REALTIME_TAG_ROUND, "request must be 0x01-tagged");
                if let Some(done) = scanner.push(&frame[1..]).expect("request scans") {
                    assert_eq!(done.excess, 0, "request ends exactly at END");
                    return done.message;
                }
            }
            WsMessage::Text(_) => { /* acks/control — ignore in these scripts */ }
            other => panic!("unexpected client frame: {other:?}"),
        }
    }
}

/// Spawn a one-shot scripted WS server on an ephemeral port. `script` runs
/// with the accepted, handshaken socket; it returns the port to connect to.
fn spawn_ws_server<F>(script: F) -> (u16, thread::JoinHandle<()>)
where
    F: FnOnce(&mut tungstenite::WebSocket<TcpStream>) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut ws = tungstenite::accept_hdr(stream, assert_client_identity).expect("ws accept");
        script(&mut ws);
        // Keep the connection alive until the client closes it. Readiness and
        // completion come from socket events; timeouts only bound failed tests.
        loop {
            match ws.read() {
                Ok(WsMessage::Close(_))
                | Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => break,
                Ok(_) => {}
                Err(error) => panic!("server awaiting client close: {error}"),
            }
        }
        let _ = ws.flush();
    });
    (port, server)
}

/// Build a `Native` transport pointed at `ws://127.0.0.1:{port}` and connect
/// its realtime socket. `baseUrl` is unused by these socket-only tests but is
/// required to select the `Native` arm.
fn connect_native(port: u16) -> HostTransport {
    let config = json!({
        "baseUrl": format!("http://127.0.0.1:{port}"),
        "wsUrl": format!("ws://127.0.0.1:{port}?transport=round&clientId=stale"),
    });
    let mut transport = HostTransport::from_config(&config).expect("native transport");
    transport
        .realtime_connect_for_client("c1")
        .expect("realtime connect");
    transport
}

fn request_bytes() -> Vec<u8> {
    encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Request,
        frames: vec![Frame::ReqHeader {
            client_id: "c1".to_owned(),
            schema_version: 1,
            log_epoch: None,
        }],
    })
}

#[test]
fn quiet_socket_reader_never_starves_round_sends() {
    const ROUNDS: usize = 12;
    let response = response_bytes();
    let server_response = response.clone();
    let (port, server) = spawn_ws_server(move |ws| {
        for _ in 0..ROUNDS {
            let _request = read_round_request(ws);
            let mut framed = vec![REALTIME_TAG_ROUND];
            framed.extend_from_slice(&server_response);
            ws.send(WsMessage::Binary(framed.into())).unwrap();
            ws.flush().unwrap();
        }
    });

    let mut transport = connect_native(port);
    let request = request_bytes();
    for _ in 0..ROUNDS {
        let got = transport.realtime_sync(&request).expect("round ok");
        assert_eq!(got, response);
    }
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn round_single_chunk_response_round_trips() {
    let response = response_bytes();
    let server_response = response.clone();
    let (port, server) = spawn_ws_server(move |ws| {
        let _request = read_round_request(ws);
        // Answer with the whole response as one 0x01 chunk.
        let mut framed = vec![REALTIME_TAG_ROUND];
        framed.extend_from_slice(&server_response);
        ws.send(WsMessage::Binary(framed.into())).unwrap();
        ws.flush().unwrap();
    });

    let mut transport = connect_native(port);
    let request = request_bytes();
    let got = transport.realtime_sync(&request).expect("round ok");
    assert_eq!(got, response, "reassembled response matches the server's");
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn round_chunked_response_reassembles() {
    let response = response_bytes();
    let server_response = response.clone();
    let (port, server) = spawn_ws_server(move |ws| {
        let _request = read_round_request(ws);
        // Send the response byte-by-byte, each in its own 0x01 chunk —
        // arbitrary boundaries (§8.7); the client concatenates to END.
        for byte in &server_response {
            ws.send(WsMessage::Binary(vec![REALTIME_TAG_ROUND, *byte].into()))
                .unwrap();
        }
        ws.flush().unwrap();
    });

    let mut transport = connect_native(port);
    let request = encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Request,
        frames: vec![Frame::ReqHeader {
            client_id: "c1".to_owned(),
            schema_version: 1,
            log_epoch: None,
        }],
    });
    let got = transport.realtime_sync(&request).expect("round ok");
    assert_eq!(got, response, "byte-chunked response reassembles exactly");
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn delta_during_round_is_queued_not_mixed_into_response() {
    let response = response_bytes();
    // A standalone delta the server (mis)behaves by sending mid-round; the
    // client must queue it to the inbound lane, not fold it into the round.
    let delta = encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Response,
        frames: vec![Frame::RespHeader {
            required_schema_version: Some(7),
            latest_schema_version: Some(7),
            log_epoch: None,
            reset_required: None,
        }],
    });
    let server_response = response.clone();
    let server_delta = delta.clone();
    let (port, server) = spawn_ws_server(move |ws| {
        let _request = read_round_request(ws);
        // Interleave a 0x00 delta before the round's response completes.
        let mut delta_frame = vec![REALTIME_TAG_DELTA];
        delta_frame.extend_from_slice(&server_delta);
        ws.send(WsMessage::Binary(delta_frame.into())).unwrap();
        let mut resp_frame = vec![REALTIME_TAG_ROUND];
        resp_frame.extend_from_slice(&server_response);
        ws.send(WsMessage::Binary(resp_frame.into())).unwrap();
        ws.flush().unwrap();
    });

    let mut transport = connect_native(port);
    let request = encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Request,
        frames: vec![Frame::ReqHeader {
            client_id: "c1".to_owned(),
            schema_version: 1,
            log_epoch: None,
        }],
    });
    let got = transport.realtime_sync(&request).expect("round ok");
    assert_eq!(got, response, "round response excludes the stray delta");
    // The delta is queued on the inbound lane (tag stripped — a bare SSP2
    // response the client would apply like a pull, §8.2).
    let inbound = transport.take_inbound();
    let deltas: Vec<Vec<u8>> = inbound
        .into_iter()
        .filter_map(|f| match f {
            Inbound::Binary(b) => Some(b),
            Inbound::Text(_) => None,
        })
        .collect();
    assert_eq!(
        deltas,
        vec![delta],
        "the mid-round delta is queued, tag stripped"
    );
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn mid_round_socket_drop_fails_the_round() {
    // The server accepts the round, then closes without answering: the client
    // must not hang — the reader detects the close and fails the in-flight
    // round (§8.7 mid-round drop) so `realtime_sync` returns an error, not a
    // deadlock. (One-round-in-flight enforcement itself is unit-tested at the
    // `RealtimeRound` level, `second_begin_while_in_flight_is_rejected`; the
    // synchronous client never issues two concurrent `realtime_sync` calls.)
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (port, server) = spawn_ws_server(move |ws| {
        let _request = read_round_request(ws);
        started_tx.send(()).ok();
        // Close immediately without a response.
        let _ = ws.close(None);
        let _ = ws.flush();
    });

    let mut transport = connect_native(port);
    let request = encode_message(&Message {
        wire_version: 1,
        msg_kind: MsgKind::Request,
        frames: vec![Frame::ReqHeader {
            client_id: "c1".to_owned(),
            schema_version: 1,
            log_epoch: None,
        }],
    });
    let outcome = transport.realtime_sync(&request);
    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("server saw the round");
    let err = outcome.expect_err("a mid-round close fails the round, never hangs");
    assert_eq!(err.code, "sync.transport_failed", "err: {}", err.message);
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn native_socket_flushes_large_messages_and_handles_ping_between_sends() {
    let payload = "x".repeat(4 * 1024 * 1024);
    let expected = payload.clone();
    let (port, server) = spawn_ws_server(move |ws| {
        ws.send(WsMessage::Ping(vec![1, 2, 3].into())).unwrap();
        let mut received = 0;
        let mut pong = false;
        while received < 2 || !pong {
            match ws.read().expect("server receives buffered writes") {
                WsMessage::Text(text) => {
                    if received == 0 {
                        assert_eq!(text.as_str(), expected);
                    } else {
                        assert_eq!(text.as_str(), "after-large-write");
                    }
                    received += 1;
                }
                WsMessage::Pong(bytes) => {
                    assert_eq!(&bytes[..], &[1, 2, 3]);
                    pong = true;
                }
                other => panic!("unexpected frame: {other:?}"),
            }
        }
        ws.send(WsMessage::Text("received".into())).unwrap();
    });
    let (notified, wake) = mpsc::sync_channel(1);
    let mut transport = HostTransport::from_config_with_notify(
        &json!({"baseUrl": format!("http://127.0.0.1:{port}"),
            "wsUrl": format!("ws://127.0.0.1:{port}?transport=round")}),
        Some(std::sync::Arc::new(move || {
            let _ = notified.try_send(());
        })),
    )
    .unwrap();
    transport.realtime_connect_for_client("c1").unwrap();
    transport
        .realtime_send(&payload)
        .expect("large write flushed");
    transport
        .realtime_send("after-large-write")
        .expect("subsequent write flushed");
    wake.recv_timeout(Duration::from_secs(5))
        .expect("server confirmed both writes");
    assert!(matches!(&transport.take_inbound()[..], [Inbound::Text(text)] if text == "received"));
    transport.shutdown();
    server.join().expect("server script completed");
}

#[test]
fn native_shutdown_wakes_idle_socket_and_rejects_later_send() {
    let (port, server) = spawn_ws_server(|_| {});
    let mut transport = connect_native(port);
    transport.shutdown();
    transport.shutdown();
    assert_eq!(
        transport.realtime_send("late").unwrap_err().code,
        "transport.failed"
    );
    server.join().expect("idle socket closed");
}
