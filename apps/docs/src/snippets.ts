/**
 * The landing page's per-platform code tabs — one flow, six languages:
 * create → subscribe → write → sync → read. Every snippet is transcribed
 * from a binding README or the quickstart example; if an API changes,
 * change it here too (these are the most-read code in the project).
 */
export interface Tab {
  readonly id: string;
  readonly label: string;
  readonly lang: 'ts' | 'tsx' | 'swift' | 'kotlin' | 'dart' | 'rust';
  readonly code: string;
}

export const TABS: readonly Tab[] = [
  {
    id: 'ts',
    label: 'TS',
    lang: 'ts',
    code: `import { SyncClient, httpSyncTransport, httpSegmentDownloader } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { schema } from './syncular.generated';

const client = new SyncClient({
  database: openBunDatabase(),           // browser: sqlite-wasm on OPFS
  schema,
  clientId: 'device-1',
  transport: httpSyncTransport('https://your.server/sync'),
  segments: httpSegmentDownloader('https://your.server/segments'),
});
await client.start();

client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['inbox'] } });

client.mutate([{
  table: 'todos',
  op: 'upsert',
  values: { id: 't1', listId: 'inbox', title: 'Ship it', done: 0 },
}]);
await client.syncUntilIdle();

client.query('SELECT * FROM todos WHERE done = 0');`,
  },
  {
    id: 'react',
    label: 'REACT',
    lang: 'tsx',
    code: `import { useMutation, useRawSql } from '@syncular/react';

function Todos() {
  const { rows } = useRawSql(
    'SELECT * FROM todos WHERE done = 0 ORDER BY position',
  );
  const { mutate } = useMutation();

  return (
    <ul>
      {rows.map((todo) => (
        <li key={todo.id}>
          <button onClick={() => mutate([{
            table: 'todos',
            op: 'upsert',
            values: { ...todo, done: 1 },
          }])}>
            {todo.title}
          </button>
        </li>
      ))}
    </ul>
  );
  // Re-renders only when the todos table changes.
}`,
  },
  {
    id: 'swift',
    label: 'SWIFT',
    lang: 'swift',
    code: `import Syncular

let client = try SyncularClient(
    clientId: "device-1",
    schema: schemaJSON,
    config: SyncularConfig(
        baseUrl: "https://your.server/sync",
        dbPath: "\\(appSupport)/syncular.db"
    )
)

try client.subscribe(id: "todos", table: "todos", scopes: ["list_id": ["inbox"]])

try client.mutate([.object([
    "op": "upsert", "table": "todos",
    "values": .object(["id": "t1", "list_id": "inbox", "title": "Ship it"]),
])])
let outcome = try client.sync()

let rows = try client.query("SELECT * FROM todos WHERE done = ?", params: [.bool(false)])

client.onEvent = { event in
    if event.type == "sync-needed" { scheduleSync() }
}`,
  },
  {
    id: 'kotlin',
    label: 'KOTLIN',
    lang: 'kotlin',
    code: `import dev.syncular.*

val client = SyncularClient.create(
    clientId = "device-1",
    schema = schemaJson,
    config = SyncularConfig(
        baseUrl = "https://your.server/sync",
        dbPath = "$appData/syncular.db",
    ),
)

client.subscribe(id = "todos", table = "todos", scopes = mapOf("list_id" to listOf("inbox")))

client.mutate(listOf(JsonValue.obj(
    "op" to JsonValue.of("upsert"), "table" to JsonValue.of("todos"),
    "values" to JsonValue.obj("id" to JsonValue.of("t1"),
        "list_id" to JsonValue.of("inbox"), "title" to JsonValue.of("Ship it")),
)))
val outcome = client.sync()

val rows = client.query("SELECT * FROM todos WHERE done = ?", listOf(JsonValue.of(false)))

client.listener = SyncularEventListener { event ->
    if (event.type == "sync-needed") scheduleSync()
}`,
  },
  {
    id: 'dart',
    label: 'FLUTTER',
    lang: 'dart',
    code: `import 'package:syncular/syncular.dart';

final client = SyncularClient.create(
  clientId: 'device-1',
  schema: todoSchema,
  config: SyncularConfig(
    baseUrl: 'https://your.server',
    dbPath: '/path/to/todos.db',
  ),
);

client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});

client.mutate([
  {'op': 'upsert', 'table': 'todos',
   'values': {'id': 't1', 'list_id': 'inbox', 'title': 'Ship it'}},
]);
client.syncUntilIdle();

final rows = client.query(
  'SELECT * FROM todos WHERE done = ?', params: [false]);

client.events.listen((e) {
  if (e.type == 'sync-needed') client.sync();
});`,
  },
  {
    id: 'rust',
    label: 'RUST',
    lang: 'rust',
    code: `use syncular_client::{ClientLimits, Mutation, SyncClient};

let mut client = SyncClient::open_path(
    "device-1".into(), &schema_json, ClientLimits::default(), "todos.db")?;

client.subscribe(
    "todos".into(), "todos".into(),
    vec![("list_id".into(), vec!["inbox".into()])], None)?;

client.mutate(vec![Mutation::Upsert {
    table: "todos".into(),
    values: serde_json::json!({
        "id": "t1", "list_id": "inbox", "title": "Ship it"
    }).as_object().cloned().unwrap(),
    base_version: None,
}])?;

client.sync_until_idle(&mut transport, None);

let rows = client.query("SELECT * FROM todos WHERE done = 0", &[])?;`,
  },
];
