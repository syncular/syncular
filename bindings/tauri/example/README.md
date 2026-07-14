# syncular · Tauri example (React)

A minimal Tauri desktop app proving syncular works end to end: a simple todo
list built on **`@syncular/react` hooks** over a **native syncular instance**
running in the Tauri host process. The webview is a thin RPC client of that
instance — the hooks are the SAME ones the browser demo (`apps/demo-react`)
uses, unchanged.

```
┌── webview (this app) ──────┐        ┌── tauri host process ──────────────┐
│ @syncular/react hooks   │        │ tauri-plugin-syncular              │
│   useSyncQuery / useMutation│  IPC  │   SyncClient (rusqlite FILE db)    │
│   / useSyncStatus          │◀──────▶│   HostTransport (HTTP + WS)        │
│ @syncular/tauri bridge  │ events │   §8.4 host loop (auto-sync)       │
└────────────────────────────┘        └────────────────────────────────────┘
```

## Run

Three moving parts: a dev **server**, the **frontend bundle**, and the Tauri
**window**.

```sh
# 0) install (from the repo root — the example is a workspace member)
cd . && bun install

# 1) the sync server — apps/demo-react serves the `todos` schema on :8788
cd apps/demo-react && bun run dev        # http://localhost:8788

# 2) build the React frontend bundle (→ example/dist)
cd ../../bindings/tauri/example && bun run build-frontend

# 3) open the window (needs a real display + Rust/Tauri toolchain)
cargo tauri dev
```

`cargo tauri dev` also runs `build-frontend` first (it is wired as
`beforeDevCommand` in `tauri.conf.json`), so step 2 is only needed if you want
to build the bundle on its own. The window is a **human step** — a real display,
and on Linux `webkit2gtk`. A `cargo build` (below) plus the mock-runtime tests
are this rung's automated bar.

The example points its native instance at `http://localhost:8788` (the
`apps/demo-react` server), whose `todos` schema this frontend mirrors and which
seeds a `groceries` list — so the app shows rows the moment it syncs.

## Screenshot

<!-- TODO: drop a screenshot of the running window here (todo list + outbox badge). -->
_(screenshot placeholder — run `cargo tauri dev` and capture the window)_

## What to look at

The whole integration is ~40 lines in
[`src/frontend/main.tsx`](src/frontend/main.tsx). The Tauri-specific surface is a
single line — constructing the client — after which everything is host-agnostic
hooks:

```tsx
// The ONE Tauri line: the webview-side bridge to the native instance.
const client = await createTauriSyncClient({ schema });

// …then plain @syncular/react — identical to the browser demo:
<SyncProvider client={client}>
  <TodoApp />           // generated useQuery + typed mutations + useSyncStatus
</SyncProvider>
```

- **`useSyncQuery`** — the live todo list. One IPC round trip per run; re-runs
  only when `todos` invalidates.
- **`useMutation`** — add / toggle / delete; writes go through the outbox and
  sync via the §8.4 host loop.
- **`useSyncStatus`** — the `outbox N` badge + upgrading / schema-floor state.

There is **zero custom IPC in app land** — the `@syncular/tauri` bridge owns
all of it.

## Build (the automated proof)

```sh
cd bindings/tauri
bun --cwd example run build-frontend   # bundle → example/dist (tauri needs it at compile time)
bun --cwd example run typecheck        # tsc --noEmit over the frontend
cargo build -p syncular-tauri-example  # the wiring compiles
```

All three run inside `../check.sh` (the tauri-bindings gate). The frontend
bundle is built **first** because `tauri::generate_context!` validates
`frontendDist` (`../dist`) at compile time.

## Layout

| Path                         | What                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `src/frontend/main.tsx`      | The React app (provider + the three hooks).                 |
| `src/frontend/index.html`    | The HTML shell (loads `/app.js`).                           |
| `src/frontend/syncular.generated.ts` | The `todos` schema + row types — REAL `syncular generate` output from [`syncular.json`](syncular.json) + [`migrations/`](migrations). `check.sh` gates it with `generate --check`. |
| `syncular.json` / `migrations/` | The typegen manifest + migration that generate the schema above (mirrors `apps/demo-react`). |
| `build-frontend.ts`          | `Bun.build` → `dist/app.js` + `index.html` (no Vite).       |
| `src-tauri/`                 | The Tauri shell: registers `tauri-plugin-syncular`.         |
