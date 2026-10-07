# Browser: troubleshooting

Match a browser symptom or error code to its cause and fix. Failures that apply
to every SDK live in [Troubleshooting](/troubleshooting/); this page holds the
segment-transport and local-storage failures, and routes the browser startup
and tab failures to their entries there.

::meta{for="Web developers debugging a failing client" time="5 minutes" first="platform-web-specifics"}

## Find the symptom

| Symptom or code | Cause | Where |
|---|---|---|
| `client.not_leader` in a second tab | The handle was created with `multiTab: false` and another tab leads. | [Troubleshooting](/troubleshooting/#clientnot_leader-on-a-second-tab) |
| `client.follower_timeout` | The leader tab answered no probe within `followerCallTimeoutMs`. | [Troubleshooting](/troubleshooting/#clientfollower_timeout-in-a-follower-tab) |
| `client.leader_incompatible` | The leader runs another multi-tab protocol or schema version. | [Troubleshooting](/troubleshooting/#clientleader_incompatible-in-a-follower-tab) |
| `client.storage_busy` at startup | Another live engine still holds the OPFS pool. | [Troubleshooting](/troubleshooting/#clientstorage_busy-while-opening-the-app) |
| Pending outbox on best-effort storage | The browser has not granted persistence. | [Troubleshooting](/troubleshooting/#pending-outbox-on-best-effort-browser-storage) |
| `client.worker_restart_required` | A dev server worker graph refers to a retired chunk. | [Troubleshooting](/troubleshooting/#clientworker_restart_required-after-a-package-upgrade) |
| Build errors naming `sqlite-wasm` or the worker | The Vite config lacks the optimizer exclusions or `worker.format: 'es'`. | [Install & first sync](/platform-web-install/#configure-vite) |
| `sync.transport_failed` while downloading a segment | The fetch failed or the response body was interrupted. | [below](#segment-transport-failures) |
| `client.storage_full` | SQLite ran out of capacity. | [below](#local-storage-failures) |

## Segment transport failures

`httpSegmentDownloader` reports a rejected fetch or an interrupted response body
as retryable `sync.transport_failed`. `ClientSyncError.details` holds `path`,
`causeMessage`, and `httpStatus` when a response arrived. The path omits URL
credentials, query parameters, and fragments. Worker and follower RPC preserve
these details. Treat `causeMessage` as operator evidence: it comes from the
runtime and sits outside the redacted diagnostics contract.

A direct endpoint's JSON error keeps the server's code and retry policy, plus
the request path and HTTP status. A failed signed URL carries
`sync.transport_failed` and invalidates the descriptor. The client aborts that
transfer, and the next pull obtains a fresh grant.

## Local storage failures

SQLite exhaustion raises the non-retryable `client.storage_full` on browser,
Bun, Node, and native clients. `details.sqliteCode` holds the numeric SQLite
code and `details.sqliteMessage` the first driver message. Cleanup failures
appear only in `details.rollbackFailure`. The core reconciles the transaction
before the next import. Restore capacity, then request sync again. The client
keeps its replica and its pending writes.

## Related

- [Platform specifics](/platform-web-specifics/): the startup retry schedule and the multi-tab protocol behind these codes.
- [Wiping OPFS for a clean test](/troubleshooting/#wiping-opfs-for-a-clean-test): reset a dev client to factory state.
- [Error code index](/troubleshooting/#error-code-index): every stable code across SDKs.
