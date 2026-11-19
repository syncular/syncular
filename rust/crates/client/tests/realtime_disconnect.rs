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
        transport.realtime_connect("c1").unwrap();
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
        transport.realtime_connect("c1").unwrap();
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
    transport.realtime_connect("c1").unwrap();
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
    let error = transport.realtime_connect("c1").unwrap_err();
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
    let error = transport.realtime_connect("c1").unwrap_err();
    assert_eq!(error.code, "transport.redirect");
    assert_eq!(
        error.message,
        "realtime establishment does not follow redirects"
    );
}

/// Diego's Tauri app on 0.90 and 0.94: a round that outlasts the drive bound
/// while the server builds. Over HTTP and over the socket, the drive,
/// `lastRound` and progress report `sync.idle_timeout`.
#[test]
fn a_round_cut_by_the_drive_bound_reports_the_idle_timeout_on_both_paths() {
    use syncular_client::{ClientLimits, ProgressState, SyncClient, SyncOutcome, UnitScopes};
    for socket in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // The request arrives; the server builds and never answers.
            if socket {
                let mut ws = tungstenite::accept(stream).unwrap();
                while let Ok(message) = ws.read() {
                    if matches!(message, tungstenite::Message::Close(_)) {
                        break;
                    }
                }
            } else {
                let mut rest = Vec::new();
                let _ = stream.read_to_end(&mut rest);
            }
        });
        let schema = serde_json::json!({
            "version": 1,
            "tables": [{
                "name": "todo",
                "primaryKey": "id",
                "columns": [{ "name": "id", "type": "string", "nullable": false }],
                "scopes": [{ "pattern": "todo:{id}" }]
            }]
        });
        let mut client =
            SyncClient::new_with_identity(Some("c1".to_owned()), &schema, ClientLimits::default())
                .unwrap();
        client
            .subscribe(UnitScopes::from([("id".to_owned(), "one".to_owned())]))
            .unwrap();
        let (mut transport, _wake) = transport_with_wake(&url);
        if socket {
            client.connect_realtime(&mut transport).unwrap();
        }

        let outcome = client.sync_until_idle_with_deadline(&mut transport, None, Some(300));
        // The host drains the socket loss after the round, as the plugin does.
        for inbound in transport.take_inbound() {
            if let Inbound::Disconnected(error) = inbound {
                client.realtime_lost(&mut transport, &error);
            }
        }

        let SyncOutcome::Failed {
            error_code,
            details,
            ..
        } = outcome
        else {
            panic!("socket={socket}: expected the drive bound, got {outcome:?}");
        };
        assert_eq!(error_code, "sync.idle_timeout", "socket={socket}");
        let details = details.unwrap();
        assert_eq!(details["timeoutMs"], 300);
        assert_eq!(details["rounds"], 0);
        assert!(details["elapsedMs"].as_u64().unwrap() >= 300, "{details}");
        let diagnostics = client.diagnostics_snapshot().unwrap();
        let last_round = diagnostics.last_round.unwrap();
        assert_eq!(last_round.error_code.as_deref(), Some("sync.idle_timeout"));
        assert_eq!(last_round.cause_kind, None);
        let progress = client.progress().snapshot().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert_eq!(progress.error_code.as_deref(), Some("sync.idle_timeout"));
        assert_eq!(progress.cause_kind, None);
        if socket {
            assert_eq!(
                diagnostics.host.realtime_reason_code.as_deref(),
                Some("sync.idle_timeout")
            );
        }
        transport.shutdown();
        drop(transport);
        server.join().unwrap();
    }
}
