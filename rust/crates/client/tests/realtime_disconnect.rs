//! An unsolicited end of the realtime connection reaches the host through the
//! inbound buffer, and establishment fails with typed errors instead of
//! blocking or following a redirect.
#![cfg(feature = "native-transport")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Arc};
use std::time::Duration;
use syncular_client::native_transport::{HostTransport, Inbound};
use syncular_client::Transport;

fn transport_with_wake(url: &str) -> (HostTransport, mpsc::Receiver<()>) {
    let (wake_tx, wake_rx) = mpsc::channel();
    let transport = HostTransport::from_config_with_notify(
        &serde_json::json!({"baseUrl": url}),
        Some(Arc::new(move || {
            let _ = wake_tx.send(());
        })),
    )
    .unwrap();
    (transport, wake_rx)
}

#[test]
fn idle_reader_close_wakes_its_host_without_a_round_or_data_frame() {
    for graceful in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (close_tx, close_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            close_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            if graceful {
                ws.close(None).unwrap();
            }
        });
        let (mut transport, wake_rx) = transport_with_wake(&url);
        transport.realtime_connect().unwrap();
        assert!(transport.take_inbound().is_empty());
        close_tx.send(()).unwrap();
        let wake = wake_rx.recv_timeout(Duration::from_secs(2));
        let inbound = transport.take_inbound();
        transport.shutdown();
        server.join().unwrap();
        assert!(
            wake.is_ok(),
            "idle reader exit was never delivered to the host mailbox (graceful={graceful})"
        );
        assert!(matches!(inbound.as_slice(), [Inbound::Disconnected(_)]));
        assert!(
            transport.take_inbound().is_empty(),
            "explicit shutdown must not enqueue a stale termination"
        );
    }
}

#[test]
fn explicit_shutdown_does_not_deliver_a_stale_close_to_the_next_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            assert!(matches!(ws.read().unwrap(), tungstenite::Message::Close(_)));
        }
    });
    let (mut transport, wake_rx) = transport_with_wake(&url);
    for _ in 0..2 {
        transport.realtime_connect().unwrap();
        transport.shutdown();
        assert!(transport.take_inbound().is_empty());
        assert!(wake_rx.try_recv().is_err());
    }
    server.join().unwrap();
}

#[test]
fn failed_send_is_reported_even_when_the_caller_ignores_its_result() {
    // Delta acknowledgement ignores its send result in the client. A failed
    // native send must still tell the host that Connected is no longer true.
    let mut transport =
        HostTransport::from_config(&serde_json::json!({"baseUrl": "http://127.0.0.1:1"})).unwrap();
    let _ = transport.realtime_send("{\"type\":\"ack\",\"cursor\":1}");
    assert!(matches!(
        transport.take_inbound().as_slice(),
        [Inbound::Disconnected(_)]
    ));
}

#[test]
fn terminal_event_is_available_before_a_failed_round_can_reconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        assert!(matches!(
            ws.read().unwrap(),
            tungstenite::Message::Binary(_)
        ));
        ws.close(None).unwrap();
    });
    let (mut transport, wake_rx) = transport_with_wake(&url);
    transport.realtime_connect().unwrap();
    assert!(transport.realtime_sync(b"synthetic request").is_err());
    assert!(
        wake_rx.try_recv().is_ok(),
        "round must not finish before terminal notification"
    );
    assert!(transport
        .take_inbound()
        .iter()
        .any(|event| matches!(event, Inbound::Disconnected(_))));
    transport.shutdown();
    server.join().unwrap();
}

#[test]
fn a_redirecting_upgrade_fails_with_transport_redirect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(
                b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n",
            )
            .unwrap();
    });
    let mut transport = HostTransport::from_config(&serde_json::json!({"baseUrl": url})).unwrap();
    let error = transport.realtime_connect().unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, "transport.redirect");
    transport.shutdown();
}

#[test]
fn a_follow_redirect_policy_fails_realtime_connect_with_a_typed_error() {
    let mut transport = HostTransport::from_config(
        &serde_json::json!({"baseUrl": "http://127.0.0.1:1", "redirects": "follow"}),
    )
    .unwrap();
    let error = transport.realtime_connect().unwrap_err();
    assert_eq!(error.code, "transport.redirect");
    assert_eq!(
        error.message,
        "realtime establishment does not follow redirects"
    );
}
