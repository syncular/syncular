# Quickstart

Two independent client cores syncing through one server — in a terminal, no
browser, in about five minutes. Every snippet below is extracted from the
runnable [`examples/quickstart`](../../examples/quickstart) directory, which
also ships a smoke test that runs this exact path in CI so it cannot rot.

## 1. Copy the example

```sh
cp -r v2/examples/quickstart my-app && cd my-app
```

It contains a schema, a server, and a two-client script. We will walk through
each. (If you are reading this inside the repo, you can also just run the
example in place — `cd v2/examples/quickstart`.)

## 2. Describe the schema

Two files drive everything. The migration declares the table shape:

```sql
-- migrations/0001_initial/up.sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

The manifest names the synced tables, their **scopes** (how rows are
authorized — `list:{list_id}` means "a note belongs to the list in its
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
  "tables": [{ "name": "notes", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    {
      "name": "notesInList",
      "table": "notes",
      "scopes": { "list_id": ["{listId}"] }
    }
  ]
}
```

## 3. Generate the typed schema

```sh
bun run generate     # → syncular-v2 generate --manifest-dir .
```

This writes `src/syncular.generated.ts` — a zero-import module exporting a
`schema` object (used by both server and client) plus per-table row types.
Commit it; regenerate whenever the schema changes. See
[Schema & typegen](/guide-schema/) for the full workflow.

## 4. The server

The whole backend is one Bun process. `createSyncularHono` mounts the
protocol routes over the framework-free server core; storage is bun:sqlite.
The server manages its own internal `sync_*` tables — the app migration only
tells typegen the schema shape, it is never run here.

```ts
// src/server.ts
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createSyncularHono } from '@syncular-v2/server-hono';
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
Bun.serve({ port, fetch: app.fetch });
console.log(`syncular quickstart server: http://localhost:${port}`);
```

`resolveScopes` is the entire authorization story, and it runs in **your**
backend. Here the demo actor may see every list (`['*']`); a real backend
returns the list ids the authenticated user belongs to. See
[Scopes & authorization](/concepts-scopes/).

```sh
bun run server       # http://localhost:8787
```

## 5. Two clients

A `SyncClient` is plain library code — give it a database backend and a
transport and it runs anywhere. In the browser that is sqlite-wasm on OPFS;
here it is bun:sqlite + `fetch`, so it runs in a terminal. Everything else is
identical to a web build.

```ts
// src/make-client.ts
import { openBunDatabase } from '@syncular-v2/web-client/bun';
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
} from '@syncular-v2/web-client';
import { schema } from './syncular.generated';

export function makeClient(baseUrl: string, clientId: string): SyncClient {
  return new SyncClient({
    database: openBunDatabase(), // in-memory; pass a path to persist
    schema,
    clientId,
    transport: httpSyncTransport(`${baseUrl}/sync`),
    segments: httpSegmentDownloader(`${baseUrl}/segments`),
  });
}
```

Now write from A and read it back on B — two separate client cores, each with
its own local database, converging through the server:

```ts
// src/clients.ts (abridged — see the file for logging)
const a = makeClient(BASE_URL, 'client-a');
const b = makeClient(BASE_URL, 'client-b');
await a.start();
await b.start();

const sub = { id: 'notes', table: 'notes', scopes: { list_id: ['welcome'] } };
a.subscribe(sub);
b.subscribe(sub);

a.mutate([
  {
    table: 'notes',
    op: 'upsert',
    values: {
      id: 'note-1',
      list_id: 'welcome',
      body: 'Hello from client A',
      updated_at_ms: Date.now(),
    },
  },
]);
await a.syncUntilIdle(); // push A's outbox to the server
await b.syncUntilIdle(); // B bootstraps the list and applies A's note

console.log('B sees:', b.query('SELECT id, body FROM notes ORDER BY id'));
```

With the server still running, in a second terminal:

```sh
bun run clients
```

You should see:

```
A: wrote note-1, pushing…
B: syncing…
B sees: [
  {
    id: "note-1",
    body: "Hello from client A",
  }
]

✓ converged
```

That is the whole loop: `mutate` records a local commit and queues it,
`syncUntilIdle` runs combined push+pull rounds, and B's independent database
converges on A's write — filtered to the scope B is authorized for.

## Where to go from here

- **[Web client](/guide-client/)** — the real browser build (worker + OPFS),
  realtime, and offline replay.
- **[The demo app](../../apps/demo)** — two live panes with offline toggles,
  conflict surfacing, and file attachments.
- **[Conflicts & optimistic writes](/concepts-conflicts/)** — what happens
  when two clients edit the same row.
- **[Server setup](/guide-server/)** — Postgres, S3/R2 segments, ops events,
  pruning.
