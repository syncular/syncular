# Realtime & lifecycle (Rust)

Schedule sync rounds, feed realtime frames into the core, and gate the transport when the app has no valid credential.

::meta{for="Rust developers writing the host loop around a SyncClient" time="8 minutes"}

The core has no timers, threads, or callbacks. The host decides when a round runs, which thread owns the client, and how inbound frames arrive.

:::figure{title="A host-driven loop" note="One owner thread" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Mailbox</span>mpsc channel into the<br>owning thread</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Owner thread</span>holds <code>SyncClient</code> and<br>the <code>Transport</code></div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Intents</span><code>drain_sync_intents()</code><br>says when to run a round</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Round</span><code>sync()</code> or<br><code>sync_until_idle()</code></div>
</div>

::caption[`SyncClient` is not `Sync`. Other threads post requests to the owner through a mailbox; the Tauri plugin and the FFI use the same pattern.]
:::

## Run rounds

`sync()` runs one combined push and pull round. `sync_until_idle(&mut transport, max_rounds)` repeats rounds until nothing is pending; `None` caps it at 20 rounds, and `Some(0)` fails with `sync.invalid_request`.

```rust title="src/main.rs"
use syncular_client::SyncOutcome;

match client.sync_until_idle(&mut transport, None) {
    SyncOutcome::Ok(report) => { /* report.pushed, report.commits_applied, report.conflicts */ }
    SyncOutcome::Failed { error_code, message, .. } => eprintln!("{error_code}: {message}"),
    SyncOutcome::RealtimeUnavailable { state, retry_delay_ms, .. } => { /* required policy */ }
    SyncOutcome::BudgetExhausted(report) => { /* not idle yet; run again */ }
}
```

Transport and protocol failures come back as `SyncOutcome::Failed`; `sync()` does not panic or error out of band. `BudgetExhausted` is a partial success that retains the aggregate report of every round that ran; read it as not idle. After a round, `sync_needed()` reports whether another round is already warranted.

A failed outcome from an HTTP refusal carries the server error body's `error_code`, `message`, `details`, and `recommended_action`. For `sync.invalid_client_id` the action is `resetClientId`; call `client.reset_client_id(&mut transport)` to rotate the id before the next round. The call closes a live socket and persists the new id in the replica.

## Async hosts

A host that cannot block, such as a browser worker answering with `fetch`, drives the same round through a split API. Prepare and apply stay on the owner; the host performs each network operation itself.

1. `prepare_sync_round(url_capable)` captures the request and the pending uploads. No network call happens here.
2. `next_operation()` names the next operation: `RoundOperation::UploadGrant`, `UploadPut`, `Upload`, `Sync { request, realtime }`, or `Downloads(fetches)`. Perform it in the host, then call `submit(RoundReply::…)`. Repeat until `next_operation()` returns `None`.
3. `finish()` returns the `CompletedSyncRound` for `apply_sync_round`.

```rust
use syncular_client::{AppliedSyncRound, RoundReply};

let mut prepared = client.prepare_sync_round(false)?;
while let Some(operation) = prepared.next_operation() {
    let reply = host_operation(&mut io, operation).await;
    prepared.submit(reply)?;
}
let outcome = match client.apply_sync_round(prepared.finish().expect("complete")) {
    AppliedSyncRound::Continue(_) => { /* an upload continued: run the next exchange */ }
    AppliedSyncRound::Complete { outcome, .. } => outcome,
};
```

`RoundReply::Upload` answers both `UploadPut` and `Upload`; a failed PUT makes `submit` ask for `Upload` next, the same fallback the blocking path takes. `RoundReply::Downloads` carries one result per fetch, in order. A failed `Sync` reply behaves exactly like a failed `Transport::sync`: a realtime round marks the socket `Lost`, the failure code rides the next request, and a retryable code schedules the background retry.

An upload exchange completes the round for that exchange. Apply it before the next exchange so the owner removes the blob pin, then continue from the returned `Continue` prepared round. `request_bytes()` returns the encoded round message when the host needs the bytes without a `next_operation` call. `exchange()` runs this sequence against a blocking `Transport`; both paths share every upload, segment, schema, and cursor decision.

## Know when to sync

`drain_sync_intents()` returns the coalesced `SyncIntent` values: `None`, `Interactive`, and `Background { delay_ms }`. The core classifies immediate work and transient retry backoff; the host owns the wait on the mailbox and the deadline.

A `Background { delay_ms }` intent obliges the host to run a sync round after `delay_ms`, whatever the realtime state is. A retryable in-band failure (`sync.schema_not_ready`, `sync.internal_error`) leaves the socket `Connected`, so reconnecting a socket never satisfies the intent. A host loop that acts on a Background intent only when the socket is down never retries that round, and the replica waits for the next realtime wake, which can be an hour on a quiet server. The core has no timer; `progress().snapshot().retry_delay_ms` carries the same delay after the intent was drained. Take the earliest deadline among the Background intents, and clear it when a round starts. `drain_change_batches()` returns the exact revisioned change batches for UI refresh.

## Realtime

Connect with `client.connect_realtime(&mut transport)?`, then feed inbound frames from your socket reader into the core:

- `client.on_realtime_text(&text)`: JSON control messages.
- `client.on_realtime_binary(&mut transport, &bytes)`: binary delta frames.

Applied deltas update the local tables directly, and `sync_needed()` flips when a round is warranted. `disconnect_realtime` closes the lane.

`HostTransport::take_inbound()` also returns `Inbound::Disconnected(TransportError)` when the socket ends without your calling `disconnect_realtime`: the server closed an idle connection, a read or write failed, or a send failed, including a delta acknowledgement whose result the client ignores. The reader pushes it and notifies the mailbox before it wakes any waiting round, so an idle replica learns of the loss. Pass it to `client.realtime_lost(&mut transport, &error)`. A `Connected` client becomes `Lost` with the transport code as the reason, the transport is released, and one `Background` intent asks you to reconnect and run a round. Calling it in any other state does nothing. A deliberate `shutdown` enqueues no event.

`realtime_connect` fails within 10 seconds across DNS, TCP, TLS, and the upgrade, with `transport.timeout` or `transport.failed` (`causeKind` names the stage). A 3xx upgrade response is `transport.redirect`, and so is a transport configured with `redirects: "follow"`: the handshake never follows a redirect. Connect failures are not retried; the `Refused` state and the Background intent drive the retry. While the socket is connected, the core routes rounds through `Transport::realtime_sync`. `HostTransport` runs the socket and its reader thread for you. [Realtime & the WS loop](/concepts-realtime/) explains the protocol.

## Realtime policy

`set_realtime_policy(RealtimePolicy::Required)` designates the socket as the sync path. While it is not connected, `sync` returns `SyncOutcome::RealtimeUnavailable { state, reason_code, retry_delay_ms }` without calling `Transport::sync`. `realtime_state()` reports `Connecting`, `Connected`, `Disconnected`, `Lost`, `Refused`, or `Disabled`. The default, `RealtimePolicy::Optional`, falls back to the HTTP round. SPEC §8.8 defines both.

## Transport gate

Call `client.set_transport_enabled(&mut transport, false)` before releasing startup intents when the app has local authorization but no fresh bearer. `transport_enabled()` reads the state.

- Local queries, mutations, and staged blobs continue.
- New rounds, realtime connects, presence sends, and uncached blob downloads fail with `sync.offline` before the transport is invoked.
- Reopening emits one interactive sync intent. Update the transport's headers first, then reopen, and let the host scheduler drain the queued commits.
- The gate defaults open on each new core and is never persisted. Security activation, header changes, and schema resets keep its value.
- A round whose network exchange already started finishes its captured exchange and applies it. A split-round host then calls `set_transport_enabled(&mut transport, false)` again to release the socket. The core sends no returned control frames and starts no follow-up round while closed.

Tauri implements this owner policy directly; see [Tauri](/platform-tauri/).
