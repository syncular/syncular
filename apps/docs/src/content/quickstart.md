# Quickstart

Run one server and two clients in a terminal, write on the first client, and
read the row back on the second. Each client runs its own core with its own
database.

::meta{for="Anyone trying Syncular for the first time" time="About 5 minutes"}

:::terms
- **Scope**: The group a row belongs to, such as one list.
- **Outbox**: The local queue of writes waiting to be sent.
- **Typegen**: The CLI that turns migrations into typed code.
:::

For an existing app, start with
[Add Syncular to an existing app](/add-to-existing-app/) to install the CLI and
generate your schema, then follow your platform guide.

:::figure{title="What you will run" note="All local, no account" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">Terminal 2 · client A</span>Own SQLite database<br>writes "Buy milk"</div>
<div class="node ok"><span class="t">Terminal 2 · client B</span>Own SQLite database<br>reads "Buy milk"</div>
</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Terminal 1 · server</span>One Bun process on port 8787<br>commit log in bun:sqlite</div>
</div>
:::

## Steps

:::::steps
::::step{title="Scaffold the project" time="1 min"}
```sh title="terminal 1"
bun create syncular-app my-app --template minimal
cd my-app
bun install
```

The scaffolder writes the project this page walks through:

```tree title="my-app/"
syncular.json                     # tables, scopes, subscriptions
migrations/
  0001_initial/
    up.sql                        # the todos table
syncular.migrations.lock.json     # locks deployed migration history
src/
  server.ts                       # the server, about 30 lines
  make-client.ts                  # builds one client
  clients.ts                      # writes on A, reads on B
  quickstart.test.ts              # the smoke test CI runs
```

Every snippet below comes from the runnable
[`examples/quickstart`](https://github.com/syncular/syncular/tree/main/examples/quickstart)
directory, which has the same shape; a CI smoke test runs this exact path. To
copy it by hand instead: `cp -r examples/quickstart my-app && cd my-app`.

Other templates: `--template web` scaffolds a Hono server and a single-pane
todo UI on the worker and OPFS client. `--template tauri` adds a `src-tauri/`
host that runs the native Rust core, for
[one codebase on web and desktop](/platform-tauri-install/#one-codebase-web-and-desktop).
::::

::::step{title="Read the schema" time="1 min"}
The migration declares the table:

```sql title="migrations/0001_initial/up.sql"
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

The manifest names the synced tables, their **scopes**, and any subscription
templates:

```json title="syncular.json"
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

:::rule{title="Read it as"}
`list:{list_id}` means "a todo belongs to the list named in its `list_id`
column." Access is granted per list; [Scopes](/concepts-scopes/) covers the
model.
:::
::::

::::step{title="Generate the typed schema" time="30 s"}
```sh title="terminal 1"
bun run generate     # runs: syncular generate --manifest-dir .
```

Typegen checks the immutable migration history and writes
`src/syncular.generated.ts`: one `schema` object that server and clients
share, plus a row type per table. Add a new migration rather than editing a
deployed one; [Schema & typegen](/guide-schema/) has the full workflow.

::checkpoint[`src/syncular.generated.ts` exists. Commit it together with the migration lock.]
::::

::::step{title="Start the server" time="1 min"}
The whole backend is one Bun process. `createSyncularHono` mounts the protocol
routes over the server core, and storage is bun:sqlite. The server manages its
own internal `sync_*` tables; the app migration only tells typegen the schema
shape, and this server does not run it.

```ts title="src/server.ts"
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

`resolveScopes` decides which rows an actor may sync, and it runs in your
backend. Here the demo actor may see every list (`['*']`); a real backend
returns the list ids the signed-in user belongs to.

```sh title="terminal 1"
bun run server
```

::checkpoint[The terminal prints `syncular quickstart server: http://localhost:8787`. Leave it running.]
::::

::::step{title="Run two clients" time="1 min"}
A `SyncClient` takes a database backend and a transport. In a browser the
database is sqlite-wasm on OPFS; here it is bun:sqlite with `fetch`, so the
clients run in a terminal and the rest matches a web build.

```ts title="src/make-client.ts"
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

The script writes on A and reads the row back on B:

```ts title="src/clients.ts (abridged)"
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

```sh title="terminal 2"
bun run clients
```

```output
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

::checkpoint[B printed A's row: two independent databases agree through the server.]
::::
:::::

## What just happened

:::figure{title="One row, five moves"}
<div class="d-row">
<div class="node hot"><span class="t">1 · A</span>mutate writes the row locally and queues a commit</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">2 · A → server</span>syncUntilIdle pushes the outbox</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">3 · Server</span>Checks scopes and appends the commit to the log</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">4 · Server → B</span>B bootstraps the list</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">5 · B</span>A local query returns the row</div>
</div>

::caption[Both subscriptions ask for the same list, so B receives what A wrote. [Subscriptions & the outbox](/concepts-subscriptions/) explains each move.]
:::

## Shortcuts this page took

Four settings keep the quickstart short. The platform pages replace each one:

| Here | In production | Guide |
|---|---|---|
| In-memory databases | Pass a file path. An in-memory database loses the outbox on restart. | Your platform page |
| `authenticate` accepts everyone | Return the signed-in user, or `null` for a 401. | [Authentication](/guide-auth/) |
| `resolveScopes` grants every list | Return the lists this user belongs to. | [Scopes](/concepts-scopes/) |
| Manual `syncUntilIdle()` | Connect realtime so changes arrive as they happen. | [Realtime](/concepts-realtime/) |

## Where to go from here

- **[Web (browser)](/platform-web/)**: the browser build (worker and OPFS)
  with realtime and offline replay. Other platforms:
  [Swift](/platform-swift/), [Kotlin](/platform-kotlin/),
  [Flutter](/platform-flutter/), [React Native](/platform-react-native/),
  [Tauri](/platform-tauri/), [Rust](/platform-rust/).
- **[Live demos](/demos/)**: two live panes with offline toggles, conflict
  surfacing, and file attachments.
- **[Conflicts & optimistic writes](/concepts-conflicts/)**: what happens when
  two clients edit the same row.
- **[Server setup](/guide-server/)**: Postgres, S3 or R2 segments, ops events,
  and pruning.
