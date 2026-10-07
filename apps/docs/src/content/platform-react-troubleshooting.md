# React: troubleshooting

Match a React symptom to its cause and fix: stalled query phases, startup
failures, blocked clients, and router state that disagrees with the URL.

::meta{for="React developers debugging a screen that does not update" time="5 minutes" first="platform-react-reads-writes"}

## Find the symptom

| Symptom | Cause | Fix |
|---|---|---|
| A list is `loading` or `partial` after a switch | The newly claimed window is pending until bootstrap finishes. | [Troubleshooting](/troubleshooting/#a-list-switch-is-briefly-loading-or-partial) |
| A write does nothing and shows no error | `mutate` rejected and the app never rendered `useMutation().error`. | [Troubleshooting](/troubleshooting/#entermutate-silently-does-nothing) |
| Local rows exist and a query never advances | A routing or parity bug in the change batch. | [Troubleshooting](/troubleshooting/#data-is-in-the-local-database-the-ui-never-updates) |
| The provider throws on startup | The client factory failed and no `renderError` or `renderBoundary` handles it. | [below](#startup-failures) |
| `phase` is `error` while the list is incomplete | The latest sync attempt failed. | [below](#a-query-sits-in-error) |
| The URL changes and the route keeps its old search params | The router publishes state through a transition under constant store traffic. | [below](#router-state-lags-the-url) |
| `client.storage_busy` at startup | Another engine holds the OPFS pool. | [Troubleshooting](/troubleshooting/#clientstorage_busy-while-opening-the-app) |

## Startup failures

`SyncProvider` shows `fallback` while a client resource is pending. When the
factory rejects, the provider calls `renderError(error, retry)`, or
`renderBoundary` with a `startup-error` state. With neither prop, it throws the
error to the nearest React error boundary. `retry()` runs the factory again
without replacing the provider. A retryable `ClientSyncError` such as
`client.storage_busy` reports `retryable: true` in the boundary state; close the
competing app or tab and retry. Do not wipe the local database for this error.

`renderBoundary` also receives `migrating` and `blocked` states, which are not
startup errors:

| `blocked` reason | Meaning |
|---|---|
| `client-upgrade-required` | The server's required schema version is above the client's current version. The block is not retryable; ship the newer client. |
| `server-behind` | The server's latest schema version is below the client's current version. Not retryable. |
| `incompatible-schema` | The status reports a schema floor that neither of the two cases above explains. Not retryable. |
| `leader-unreachable` | In a follower tab, the leader tab answered no probe. See [Browser specifics](/platform-web-specifics/#leader-probes). |
| `leader-incompatible` | The tab holding the database runs another build. See [Browser specifics](/platform-web-specifics/#build-compatibility). |

## A query sits in error

A query returns `error` when its latest read failed, or when the latest sync
attempt failed while its required coverage was incomplete. The result keeps the
rows and revision of the last successful read. The error is a
`SyncRoundFailedError` with the attempt's stable `code`. Check `retryable`: when
true, the client has scheduled a retry after `retryDelayMs`, and the query
returns to `loading` or `partial` when that attempt starts. When false, no
automatic attempt follows; fix the cause in
[Troubleshooting](/troubleshooting/#error-code-index) and call `refresh()`.

## Router state lags the URL

Some React Router releases publish router state through a transition by
default, so under sustained store traffic a route can render a stale
`useSearchParams()`. Pass `useTransitions={false}` to `RouterProvider` at the
application router boundary. The full explanation is in
[Platform specifics](/platform-react-specifics/#router-transition-scheduling).
