# Tauri

A Tauri app runs a native Syncular instance inside the host process.
`tauri-plugin-syncular` consumes the Rust client core as a crate, with no FFI
layer, and the webview reaches it through `@syncular/tauri`, a thin JS bridge
that implements the same `SyncClientLike` interface every other host does. The
bridge works with Vue, React, Svelte, or plain TypeScript. This overview shows
how the pieces connect and the calls of a first sync.

::meta{for="Desktop developers with a Tauri v2 app" runs="Rust core in the Tauri host process, on-disk SQLite (rusqlite)" package="`@syncular/tauri` (npm) and `tauri-plugin-syncular` (crates.io)" threading="One owning thread holds the mutable core; a second owner serves read snapshots" time="5 minutes"}

:::terms
- **Plugin**: `tauri-plugin-syncular`, the Rust crate that hosts the core in the Tauri process.
- **Bridge**: `@syncular/tauri`, the JS client the webview calls.
- **Owner**: A thread that owns one SQLite connection.
- **IPC**: Tauri's message channel between the webview and the host process.
:::

## How the pieces connect

:::figure{title="Tauri SDK" note="One host process" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Webview</span>Your UI calls <code>createTauriSyncClient</code> methods</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Host process · Rust</p>
<div class="d-stack">
<div class="node"><span class="t">Plugin</span><code>syncular-command</code> router, the same one the C FFI uses</div>
<div class="node hot"><span class="t">Mutable owner</span>Outbox, subscriptions, sync rounds</div>
<div class="node ok"><span class="t">Read owner</span>Read-only SQLite connection for query snapshots</div>
</div>
</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Your server</span><code>ureq</code> HTTP and <code>tungstenite</code> WebSocket</div>
</div>

::caption[The webview is a thin RPC client. Webview OPFS is eviction-prone and differs across WKWebView and webkitgtk, so the full client runs in the host process on a real SQLite file.]
:::

## First sync in four calls

[Install & first sync](/platform-tauri-install/) covers the Rust and JS setup.
The webview side:

```ts title="src/sync.ts"
import { createTauriSyncClient } from '@syncular/tauri';
import { schema } from './syncular.generated';

// 1. Create: opens the database the plugin configured.
export const client = await createTauriSyncClient({ schema });

// 2. Subscribe: which rows this device receives.
await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });

// 3. Write: visible to local reads at once, queued in the outbox.
await client.mutate([
  { table: 'todos', op: 'upsert', values: { id: crypto.randomUUID(), list_id: 'groceries', title: 'Hello', done: false } },
]);

// 4. Sync: push the outbox, pull new rows.
await client.syncUntilIdle();
```

:::warning{title="Set a database path"}
Without `db_path` or `database_dir` in the plugin config, the database is
in-memory and nothing survives a restart. A file-backed database also gets the
independent read owner.
:::

## The pages of this SDK

| Page | Type | You get |
|---|---|---|
| [Install & first sync](/platform-tauri-install/) | How-to | The npm and crate dependencies, plugin registration, the capability, and a first round. |
| [Reads & writes](/platform-tauri-reads-writes/) | How-to | Subscriptions, queries, change events, mutations, durable outcomes, and CRDT text. |
| [Realtime & lifecycle](/platform-tauri-realtime/) | How-to | The realtime supervisor, credential rotation, one replica per actor, and closing. |
| [Platform specifics](/platform-tauri-specifics/) | Reference, advanced | Threading, the command surface, the performance contract, authority evidence, local activation. |
| [Troubleshooting](/platform-tauri-troubleshooting/) | Reference | Slow or partial views, identity and database-name errors, closed-client errors. |

Hooks for React live in [React](/platform-react/); the crate the plugin
consumes is documented in [Rust](/platform-rust/). The runnable
[`bindings/tauri/example`](https://github.com/syncular/syncular/tree/main/bindings/tauri/example)
registers the plugin with `native-transport` against a local dev server and
renders a React todo list over `createTauriSyncClient`.
