// A minimal Flutter todo list on the syncular Dart binding — the proof that
// syncular compiles and runs on Flutter with a clean interface and no hacks.
//
// The whole syncular surface used here: SyncularClient.create (file-backed DB +
// server URL), subscribe, mutate (add/toggle), query (the live read), sync (the
// button + auto-sync on the event stream), close. It talks to the quickstart/
// demo server (apps/demo, port 8787) — start that first, then `flutter run`.
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:syncular/syncular.dart';

import 'syncular.generated.dart';

/// The demo/quickstart server mount (apps/demo serves POST /sync on 8787).
/// Android emulators reach the host loopback via 10.0.2.2.
const _serverBase = String.fromEnvironment('SYNCULAR_SERVER',
    defaultValue: 'http://localhost:8787');
const _listId = 'inbox';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dir = await getApplicationSupportDirectory();
  final base = Platform.isAndroid
      ? _serverBase.replaceFirst('localhost', '10.0.2.2')
      : _serverBase;
  final client = SyncularClient.create(
    clientId: 'flutter-demo',
    schema: syncularSchema,
    config: SyncularConfig(baseUrl: base, dbPath: '${dir.path}/todos.db'),
  );
  client.subscribe(
    'todos',
    SyncularTodoListSubscription.table,
    scopes: SyncularTodoListSubscription.scopes(listId: _listId),
  );
  runApp(TodoApp(client));
}

class TodoApp extends StatelessWidget {
  final SyncularClient client;
  const TodoApp(this.client, {super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'syncular todos',
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
        home: TodoPage(client),
      );
}

class TodoPage extends StatefulWidget {
  final SyncularClient client;
  const TodoPage(this.client, {super.key});

  @override
  State<TodoPage> createState() => _TodoPageState();
}

class _TodoPageState extends State<TodoPage> {
  final _input = TextEditingController();
  List<Map<String, Object?>> _todos = const [];
  bool _syncing = false;

  SyncularClient get _client => widget.client;

  @override
  void initState() {
    super.initState();
    _refresh();
    // Auto-sync: the core signals sync-needed on local writes and server pushes.
    _client.events.listen((event) {
      if (event.type == 'sync-needed') _sync();
    });
  }

  @override
  void dispose() {
    _input.dispose();
    _client.close();
    super.dispose();
  }

  void _refresh() {
    setState(() {
      // Select every column: upsert replaces the row, so toggle re-sends the
      // full row (the proven demo pattern — a partial upsert would drop columns).
      _todos = _client.query(
        'SELECT id, list_id, title, done, position, updated_at_ms '
        'FROM todos WHERE list_id = ? ORDER BY position',
        params: [_listId],
      );
    });
  }

  void _add() {
    final title = _input.text.trim();
    if (title.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    _client.mutate([
      {
        'op': 'upsert',
        'table': 'todos',
        'values': {
          'id': 't-$now',
          'list_id': _listId,
          'title': title,
          'done': false,
          'position': now,
          'updated_at_ms': now,
        },
      },
    ]);
    _input.clear();
    _refresh();
    _sync();
  }

  void _toggle(Map<String, Object?> todo) {
    final done = todo['done'] == 1 || todo['done'] == true;
    _client.mutate([
      {
        'op': 'upsert',
        'table': 'todos',
        // Full row: upsert replaces, so re-send every column with `done` flipped.
        'values': {
          ...todo,
          'done': !done,
          'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
        },
      },
    ]);
    _refresh();
    _sync();
  }

  Future<void> _sync() async {
    if (_syncing) return;
    setState(() => _syncing = true);
    try {
      _client.syncUntilIdle();
    } on SyncularError {
      // Offline: the outbox holds the writes; they push on the next sync.
    } finally {
      if (mounted) setState(() => _syncing = false);
      _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = _client.pendingCommitIds().length;
    return Scaffold(
      appBar: AppBar(
        title: const Text('syncular todos'),
        actions: [
          if (pending > 0)
            Center(child: Text('$pending unsynced ')),
          IconButton(
            icon: _syncing
                ? const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.sync),
            onPressed: _syncing ? null : _sync,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  decoration: const InputDecoration(
                      hintText: 'New todo', border: OutlineInputBorder()),
                  onSubmitted: (_) => _add(),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(onPressed: _add, child: const Text('Add')),
            ]),
          ),
          Expanded(
            child: ListView(
              children: [
                for (final todo in _todos)
                  CheckboxListTile(
                    value: todo['done'] == 1 || todo['done'] == true,
                    onChanged: (_) => _toggle(todo),
                    title: Text(todo['title'] as String? ?? ''),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
