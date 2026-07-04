/// syncular — an idiomatic Dart/Flutter wrapper over the syncular-ffi C-ABI
/// native core (the five functions in `rust/ffi.h`), via `dart:ffi`.
///
/// It is the Flutter sibling of `bindings/swift` (`SyncularClient`) and
/// `bindings/kotlin` (`SyncularClient` via FFM): one JSON command surface
/// (`{method, params}` in, `{result|error}` out, bytes as `{"$bytes":hex}`),
/// typed conveniences, a `poll_event`-driven event Stream, and a
/// pause/resume/close lifecycle owned in the wrapper.
///
/// ```dart
/// final client = SyncularClient.create(
///   clientId: 'device-a',
///   schema: todoSchema,
///   config: SyncularConfig(dbPath: '/path/to/todos.db'),
/// );
/// client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});
/// client.mutate([{'op': 'upsert', 'table': 'todos', 'values': {...}}]);
/// final rows = client.query('SELECT * FROM todos WHERE done = 0');
/// client.events.listen((e) { if (e.type == 'sync-needed') client.sync(); });
/// ```
library syncular;

export 'src/client.dart'
    show SyncularClient, SyncularConfig, SyncularEvent, SyncularError;
export 'src/ffi.dart' show SyncularFfi;
