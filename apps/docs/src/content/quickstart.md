# Quickstart

Two independent client cores converge through one server, all in a terminal,
in about five minutes.

## 1. Scaffold

```sh
bun create syncular-app my-app --template minimal
cd my-app
bun install
```

That is the fastest path: the scaffolder writes the project this page walks
through (a schema, a ~30-line server, a two-client script, a README, and a
smoke test). For a browser app, `--template web` scaffolds a Hono server +
a single-pane todo UI on the worker + OPFS client instead. For
[one codebase, web + desktop](/guide-web-desktop/), `--template tauri` adds a
`src-tauri/` host running the native Rust core behind the engine seam.

> Every snippet below comes from the runnable
> [`examples/quickstart`](https://github.com/syncular/syncular/tree/main/examples/quickstart)
> directory (the shape the scaffolder emits); a CI smoke test runs this exact
> path. To copy it by hand instead of scaffolding:
> `cp -r examples/quickstart my-app && cd my-app`. If you scaffolded above,
> you already have these files; skip to
> [step 3](#3-generate-the-typed-schema) to run them.

## 2. Describe and lock the schema

The scaffolder wrote a migration, manifest, and
`syncular.migrations.lock.json`. The migration declares the table shape:

```sql
-- migrations/0001_initial/up.sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

The manifest names the synced tables, their **scopes** (how rows are
authorized: `list:{list_id}` means "a todo belongs to the list in its
`list_id` column"), and any subscription templates:

```json
// syncular.json
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": {
    "ir": "./syncular.ir.json",
    "module": "./src/syncular.generated.ts"
  },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "todos", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    {
      "name": "todosInList",
      "table": "todos",
      "scopes": { "list_id": ["{listId}"] }
    }
  ]
}
```

## 3. Generate the typed schema

```sh
bun run generate     # → syncular generate --manifest-dir .
```

This verifies immutable migration history and writes
`src/syncular.generated.ts`, a zero-import module exporting a `schema` object
(used by both server and client) plus per-table row types. Commit the generated
module and migration lock; add a new migration rather than editing a deployed
one. See
[Schema & typegen](/guide-schema/) for the full workflow.

## 4. The server

The whole backend is one Bun process. `createSyncularHono` mounts the
protocol routes over the framework-free server core; storage is bun:sqlite.
The server manages its own internal `sync_*` tables. The app migration exists
to tell typegen the schema shape; this server does not run it.

```ts
// src/server.ts
import {
  ensureSyncServerReady,
  MemorySegmentStore,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { SqliteServerStorage } from '@syncular/server/sqlite';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage(process.env.QUICKSTART_DB ?? ':memory:'),
  segments: new MemorySegmentStore(),
  resolveScopes: () => ({ list_id: ['*'] }),
};

const app = createSyncularHono({
  config,
  // Replace with your real auth: return { actorId, partition } or null (401).
  authenticate: async () => ({ actorId: 'quickstart-user', partition: 'demo' }),
});

const port = Number(process.env.PORT ?? 8787);
await ensureSyncServerReady(config);
Bun.serve({ port, fetch: app.fetch });
console.log(`syncular quickstart server: http://localhost:${port}`);
```

`resolveScopes` decides which rows an actor may sync, and it runs in **your**
backend. Here the demo actor may see every list (`['*']`); a real backend
returns the list ids the authenticated user belongs to. See
[Scopes & authorization](/concepts-scopes/).

```sh
bun run server       # http://localhost:8787
```

## 5. Two clients

A `SyncClient` is plain library code: give it a database backend and a
transport and it runs anywhere. In the browser that is sqlite-wasm on OPFS;
here it is bun:sqlite + `fetch`, so it runs in a terminal. Everything else is
identical to a web build.

```ts
// src/make-client.ts
import { openSqliteDatabase } from '@syncular/client/sqlite';
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
} from '@syncular/client';
import { schema } from './syncular.generated';

export function makeClient(baseUrl: string, clientId: string): SyncClient {
  return new SyncClient({
    database: openSqliteDatabase(), // in-memory; pass a path to persist
    schema,
    clientId,
    transport: httpSyncTransport(`${baseUrl}/sync`),
    segments: httpSegmentDownloader(`${baseUrl}/segments`),
  });
}
```

Now write from A and read it back on B: two separate client cores, each with
its own local database, converging through the server.

```ts
// src/clients.ts (abridged; see the file for logging)
const a = makeClient(BASE_URL, 'client-a');
const b = makeClient(BASE_URL, 'client-b');
await a.start();
await b.start();

const sub = { id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } };
a.subscribe(sub);
b.subscribe(sub);

a.mutate([
  {
    table: 'todos',
    op: 'upsert',
    values: {
      id: 'todo-1',
      list_id: 'groceries',
      title: 'Buy milk',
      done: false,
      position: 1,
      updated_at_ms: Date.now(),
    },
  },
]);
await a.syncUntilIdle(); // push A's outbox to the server
await b.syncUntilIdle(); // B bootstraps the list and applies A's todo

console.log('B sees:', b.query('SELECT id, title FROM todos ORDER BY id'));
```

With the server still running, in a second terminal:

```sh
bun run clients
```

You should see:

```
A: wrote todo-1, pushing…
B: syncing…
B sees: [
  {
    id: "todo-1",
    title: "Buy milk",
  }
]

✓ converged
```

`mutate` records a local commit and queues it.
`syncUntilIdle` runs combined push+pull rounds until B's independent database
converges on A's write, filtered to the scope B is authorized for.

## Where to go from here

This page traded four production concerns for brevity: the database is
in-memory (pass a path to persist), `authenticate` accepts everyone,
`resolveScopes` grants every list, and sync runs on manual `syncUntilIdle()`
calls with no realtime connection. The platform pages restore all four.

- **[Web (browser)](/platform-web/)**: the real browser build (worker + OPFS)
  with realtime and offline replay. Or jump straight to your platform:
  [Swift](/platform-swift/), [Kotlin](/platform-kotlin/),
  [Flutter](/platform-flutter/), [React Native](/platform-react-native/),
  [Tauri](/platform-tauri/), [Rust](/platform-rust/).
- **[Live demos](/demos/)**: two live panes with offline toggles, conflict
  surfacing, and file attachments.
- **[Conflicts & optimistic writes](/concepts-conflicts/)**: what happens
  when two clients edit the same row.
- **[Server setup](/guide-server/)**: Postgres, S3/R2 segments, ops events,
  pruning.
