# Tauri: install & first sync

Add the plugin to the host, the bridge to the webview, and run a first sync
round. You finish with a native Syncular instance on a file-backed database and
a row that arrived from the server.

::meta{for="Developers adding sync to a Tauri v2 app" time="10 minutes" first="platform-tauri add-to-existing-app"}

:::terms
- **`SyncularConfig`**: The Rust struct that configures the plugin at registration.
- **Capability**: A Tauri permission file that lets a window call the plugin.
- **`native-transport`**: The plugin feature that compiles the HTTP and WebSocket stack.
:::

:::figure{title="Where each piece goes" note="Host, capability, webview" ticks}
<div class="d-row">
<div class="node hot"><span class="t">src-tauri/</span>Cargo dependency, <code>init(config)</code>, capability file</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Frontend</span><code>@syncular/tauri</code> and <code>@tauri-apps/api</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">First round</span><code>syncUntilIdle()</code></div>
</div>

::caption[The plugin owns the database path and the transport. The webview supplies the schema and optional limits.]
:::

This page assumes a generated `src/syncular.generated.ts`. For an existing app,
follow [Add Syncular to an existing app](/add-to-existing-app/) to install
`@syncular/typegen`, create the migration and manifest, and run generation. The
`bun create syncular-app my-app --template tauri` scaffold includes those inputs
and a `src-tauri/` host. The generated `schema` must match the schema your sync
server uses.

:::::steps
::::step{title="Install the dependencies" time="2 min"}
Install the JS bridge and its Tauri API peer in the frontend project:

```sh title="terminal"
bun add @syncular/tauri @tauri-apps/api
```

Add the Rust plugin from crates.io:

```toml title="src-tauri/Cargo.toml"
[dependencies]
tauri-plugin-syncular = { version = "0.0.0", features = ["native-transport"] }
```

To track unreleased changes, use a git dependency; cargo finds the package in
the repo by name, and `rev = "<commit>"` pins it. A local checkout works with a
path dependency to
[`bindings/tauri/plugin`](https://github.com/syncular/syncular/tree/main/bindings/tauri/plugin):

```toml title="src-tauri/Cargo.toml"
[dependencies]
tauri-plugin-syncular = { git = "https://github.com/syncular/syncular", features = ["native-transport"] }
```

`native-transport` compiles the plugin's blocking HTTP and WebSocket stack
(`ureq` and `tungstenite`, with no async runtime). Without it the plugin builds
a client-local core: network commands return errors while local reads and
writes keep working.

::checkpoint[`cargo check` in `src-tauri/` resolves the plugin, and `bun install` resolves the bridge.]
::::

::::step{title="Register the plugin" time="3 min"}
Initialize it with a `SyncularConfig` in the app's setup:

```rust title="src-tauri/src/lib.rs"
use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

tauri::Builder::default()
    .setup(|app| {
        // Persist the database under the OS app-data dir so it survives
        // restarts.
        let db_path = app.path().app_data_dir().ok().map(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("syncular.db").to_string_lossy().into_owned()
        });
        let config = SyncularConfig {
            base_url: Some("https://your.server".into()),
            db_path,
            auto_sync: true,
            ..Default::default()
        };
        app.handle().plugin(tauri_plugin_syncular::init(config))?;
        Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the app");
```

| Field | Meaning |
|---|---|
| `base_url` | Server base URL for the native HTTP and WebSocket transport. Absent: client-local only. |
| `ws_url` | Realtime WebSocket URL. Derived from `base_url` when absent. |
| `headers` | Extra request headers (auth, actor and project ids) as name and value pairs. |
| `request_timeout_ms` | Per-request network deadline. Absent: unbounded. |
| `round_deadline_ms` | One monotonic deadline for a whole sync round (uploads, continuations, the main request, every segment fetch). Absent: unbounded. |
| `max_request_bytes` | Largest request body the transport sends. Absent: unbounded. |
| `max_response_bytes` | Largest decoded (post-decompression) response body. Absent: unbounded. |
| `redirects` | `"deny"` (default) refuses every redirect, so credentials, URL userinfo, and signed capabilities never replay to another origin. `"follow"` follows a redirect only for a request with none of those. |
| `db_path` | On-disk SQLite path a `create` opens when it names no database. Absent: in-memory, and nothing survives a restart. |
| `database_dir` | Directory of named databases. A `create` with `database: 'name'` opens `<database_dir>/name.db`; the plugin creates the directory. Without `db_path`, every `create` must name a database. |
| `auto_sync` | Run the background host loop. Default `true`. |
| `authority_columns` | The native ceiling for authority reads; see [Platform specifics](/platform-tauri-specifics/#authority-evidence-before-activation). |

::checkpoint[The app starts and the plugin registers without an error in the Rust log.]
::::

::::step{title="Grant the permission" time="1 min"}
```json title="src-tauri/capabilities/default.json"
{ "identifier": "syncular", "windows": ["main"], "permissions": ["syncular:default"] }
```

::checkpoint[A webview call to the plugin no longer fails with a permission error.]
::::

::::step{title="Create the client and sync" time="3 min"}
Create one client for the webview and share it across components. Its
`subscribe`, `query`, and `mutate` methods return promises and work from any
frontend framework.

```ts title="src/sync.ts"
import { createTauriSyncClient } from '@syncular/tauri';
import { schema } from './syncular.generated';

export const client = await createTauriSyncClient({ schema });

await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
await client.syncUntilIdle();
console.log(await client.query('SELECT id, title FROM todos ORDER BY id'));
```

The JS side supplies the schema and optional `limits`; the native side owns the
database path. On first open the core generates a cryptographically random
client id and stores it in that database; later opens restore it. An explicit
`clientId` can initialize a new database. A different id for an existing
database fails with `client.identity_mismatch`. The bridge resolves
`@tauri-apps/api` automatically, or the ambient `window.__TAURI__` when
`withGlobalTauri` is enabled; tests inject `invoke` and `listen` doubles.

::checkpoint[The console prints the server's rows for `groceries`. Restart the app: the rows appear again without a round trip.]
::::
:::::

## React bindings

In a React app, install the hooks and pass the shared client to the provider.
The provider adapts the Tauri client for live queries, mutations, status, and
presence:

```sh title="terminal"
bun add @syncular/react
```

```tsx title="src/main.tsx"
import { SyncProvider } from '@syncular/react';
import { client } from './sync';

<SyncProvider client={client}>
  <App />
</SyncProvider>
```

See [React](/platform-react/) for the hooks and startup handling.

## One codebase, web and desktop

The same React tree runs over two hosts. In the browser, the client core lives
in a Web Worker on OPFS. On desktop it is this plugin's native Rust core. Every
`@syncular/react` hook targets `SyncClientLike`, so the only host-aware code is
an engine seam that picks the client:

```ts title="src/engine.ts"
import type { SyncClientLike } from '@syncular/react';
import { schema } from './syncular.generated';

/** Tauri v2 injects this into every webview it hosts. */
const isTauri = () =>
  '__TAURI_INTERNALS__' in window ||
  import.meta.env.VITE_FORCE_ENGINE === 'tauri';

export async function createEngine(): Promise<SyncClientLike> {
  if (isTauri()) {
    const { createTauriSyncClient } = await import('@syncular/tauri');
    return createTauriSyncClient({ schema });
  }
  const { createSyncClientHandle } = await import('@syncular/client');
  const WS = location.protocol === 'https:' ? 'wss' : 'ws';
  return createSyncClientHandle({
    worker: () =>
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: 'app' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
    },
  });
}
```

Render one `<SyncProvider client={await createEngine()}>` around the shared
tree. The dynamic imports keep each host's machinery out of the other's bundle:
the web build never ships the Tauri bridge, and the Tauri webview never loads
sqlite-wasm. `VITE_FORCE_ENGINE` develops the Tauri UI in a plain browser tab.

| | Web (worker) | Desktop (Tauri) |
|---|---|---|
| Core | TypeScript client in a Web Worker | Rust client in the host process |
| Storage | OPFS (`opfs-sahpool`) | On-disk SQLite under app-data |
| Transport | `fetch` and WebSocket from the worker | `ureq` and `tungstenite` in Rust |
| Query round trip | postMessage RPC | Tauri IPC to an independent read-only SQLite owner |
| Setup | [Vite config](/platform-web-install/#configure-vite) | Plugin registration above |

`bun create syncular-app my-app --template tauri` scaffolds the engine seam, the
shared React tree, the sync server, and a `src-tauri/` host. Run the web half
with `bun run dev` and the desktop half with `cargo tauri dev`.

## Next

- [Reads & writes](/platform-tauri-reads-writes/): queries, change events, and mutations.
- [Realtime & lifecycle](/platform-tauri-realtime/): the supervisor and credential rotation.
