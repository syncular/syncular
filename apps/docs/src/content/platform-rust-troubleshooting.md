# Troubleshooting (Rust)

Match a symptom to its cause and fix.

::meta{for="Rust developers with a failing round or a rejected write" time="3 minutes"}

| Symptom | Cause | Fix |
|---|---|---|
| `sync` returns `Failed` with `transport.unavailable` | The `Transport` has no network (a null `HostTransport`, or no `baseUrl`) | Pass `baseUrl` in the transport config and build with `native-transport` |
| `HostTransport::from_config` returns an error for `baseUrl` | The crate was built without `native-transport` | Enable the feature |
| `sync.offline` before any request | `set_transport_enabled(.., false)` closed the gate | Install fresh headers, then reopen the gate |
| `SyncOutcome::RealtimeUnavailable` | The `Required` realtime policy is set and the socket is not connected | Call `connect_realtime`, or switch to `Optional` |
| `SyncOutcome::BudgetExhausted` | `sync_until_idle` hit its round cap before the client went idle | Run again, or raise `max_rounds` |
| `mutate` returns `sync.invalid_request` | An unknown column, a value of the wrong type, an absent required column, or an unrenderable primary key | Read `details.legacyCause`; nothing was recorded |
| `client.storage_busy` (retryable) | SQLite reported `BUSY` or `LOCKED` | Retry after the contention clears |
| `client.storage_full` | The disk is full (SQLite code 13) | Free space, then call `sync` again; the pending import runs on the same connection |
| `open_path_with_identity` fails with `sync.invalid_request` | WAL is unavailable, for example an empty path or `:memory:` | Pass a persistent file path |
| A legacy commit shows as rejected with `sync.outbox_incompatible` | The stored commit carries values the current codec refuses | Read `details.reason`; resolve it as any rejection |
| `transport.timeout`, `transport.request_too_large`, or `transport.response_too_large` | A `HostTransportPolicy` bound fired | Raise the bound; see [Platform specifics](/platform-rust-specifics/#native-transport-policy) |
| `transport.redirect` | The server redirected a credential-bearing request | Point `baseUrl` at the final URL |

For protocol-level failures (`sync.*` codes, revoked subscriptions, conflicts) see [Troubleshooting](/troubleshooting/).
