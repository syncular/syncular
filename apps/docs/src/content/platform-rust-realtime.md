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

## Know when to sync

`drain_sync_intents()` returns the coalesced `SyncIntent` values: `None`, `Interactive`, and `Background { delay_ms }`. The core classifies immediate work and transient retry backoff; the host owns the wait on the mailbox and the deadline. `drain_change_batches()` returns the exact revisioned change batches for UI refresh.

## Realtime

Connect with `client.connect_realtime(&mut transport)?`, then feed inbound frames from your socket reader into the core:

- `client.on_realtime_text(&text)`: JSON control messages.
- `client.on_realtime_binary(&mut transport, &bytes)`: binary delta frames.

Applied deltas update the local tables directly, and `sync_needed()` flips when a round is warranted. `disconnect_realtime` closes the lane. While the socket is connected, the core routes rounds through `Transport::realtime_sync`. `HostTransport` runs the socket and its reader thread for you. [Realtime & the WS loop](/concepts-realtime/) explains the protocol.

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
