// SyncularClient — an idiomatic Dart wrapper over the syncular-ffi C core, the
// Flutter/Dart sibling of bindings/swift and bindings/kotlin. Deliberately
// THIN: it owns the opaque handle, marshals JSON, exposes typed conveniences
// over the common commands, and runs the `poll_event` loop delivering events to
// a broadcast Stream. Sync/lifecycle logic the core doesn't own lives here (the
// wrapper owns lifecycle per the roadmap): pause()/resume()/close().
//
// The core is thread-affine (drive one handle from one thread). Dart's default
// concurrency model makes this natural: all command dispatch AND the poll loop
// run on the same isolate (the one that created the handle). The poll loop is a
// Timer.periodic doing NON-BLOCKING polls (timeout_ms = 0), so it never blocks
// the isolate and never races the command path — the honest simple choice over
// a background isolate (which the callback-free FFI would not need and which
// cannot share the non-Sendable handle without a second core). See README's
// "Event delivery" note.
import 'dart:async';
import 'dart:ffi';

import 'ffi.dart';

/// An event surfaced by the native core's `poll_event`: an exact revisioned
/// `change` batch, explicit `sync-intent`, or ephemeral `presence`. The full
/// decoded object is preserved in [payload]; [type] is lifted for switching.
class SyncularEvent {
  /// The event discriminator (`"change"`, `"sync-intent"`, …).
  final String type;

  /// The full decoded event object (includes any extra fields like `count`).
  final Map<String, Object?> payload;

  const SyncularEvent(this.type, this.payload);

  @override
  String toString() => 'SyncularEvent($type, $payload)';
}

/// The error a `{error}` reply surfaces (mirrors the Swift `SyncularError` and
/// the Kotlin `SyncularException`): a stable [code] plus a [message].
class SyncularError implements Exception {
  final String code;
  final String message;
  const SyncularError(this.code, this.message);

  @override
  String toString() => 'SyncularError($code): $message';
}

/// §4.8 completeness oracle (I3): the windowed-in [units] of a window base,
/// plus the [pending] subset whose bootstrap has not yet completed.
/// Registration alone is not completeness — a pending unit's local replica
/// may be empty or partial, so render it as loading/partial, never complete.
/// A unit with zero server rows still completes once its bootstrap finishes.
class WindowState {
  const WindowState({required this.units, required this.pending});

  /// Windowed-in units for the base, ordered by value.
  final List<String> units;

  /// Registered units whose bootstrap has not yet completed.
  final List<String> pending;

  /// The per-unit verdict: registered AND bootstrap-complete.
  bool complete(String unit) =>
      units.contains(unit) && !pending.contains(unit);
}

/// Configuration for a [SyncularClient]. [baseUrl] engages the native HTTP+WS
/// transport (only in a `native-transport` core build); omit it for the
/// dependency-lean, offline-first local core. [dbPath] installs a file-backed
/// SQLite database so state persists across launches; omit for in-memory.
class SyncularConfig {
  /// Base URL of the sync server mount, e.g. `https://host/sync`. Requires a
  /// core built with `native-transport`; ignored by the lean core (network
  /// commands then fail with `transport.unavailable`).
  final String? baseUrl;

  /// Optional explicit realtime socket URL. Derived from [baseUrl] if null.
  final String? wsUrl;

  /// Extra request headers (auth, tenant, …) for the native transport.
  final Map<String, String> headers;

  /// Path to the on-disk SQLite database. Null → in-memory (no persistence).
  final String? dbPath;

  const SyncularConfig({
    this.baseUrl,
    this.wsUrl,
    this.headers = const {},
    this.dbPath,
  });

  /// The `syncular_client_new` config JSON (transport fields only; `dbPath`
  /// rides on `create`).
  Map<String, Object?> _newConfigJson() {
    final object = <String, Object?>{};
    if (baseUrl != null) object['baseUrl'] = baseUrl;
    if (wsUrl != null) object['wsUrl'] = wsUrl;
    if (headers.isNotEmpty) object['headers'] = headers;
    return object;
  }
}

/// The idiomatic wrapper. Construct with [SyncularClient.create] (a schema +
/// optional clientId, which issue the native `create`), then use the typed conveniences
/// or the raw [command]. Listen to [events] for client-observable events.
class SyncularClient {
  final SyncularFfi _ffi;
  Pointer<Void> _handle;
  final Duration _pollInterval;

  Timer? _pollTimer;
  bool _closed = false;

  final StreamController<SyncularEvent> _eventController =
      StreamController<SyncularEvent>.broadcast();

  SyncularClient._(this._ffi, this._handle, this._pollInterval);

  /// A broadcast stream of client-observable events (delivered on the owning
  /// isolate's event loop, so listeners can touch UI state directly).
  Stream<SyncularEvent> get events => _eventController.stream;

  /// Create the native core and issue `create` with the given schema,
  /// then start the event poll loop.
  ///
  /// - [clientId]: optional explicit stable id. When omitted, the core creates
  ///   and persists one in the database.
  /// - [schema]: the generated schema JSON (from typegen) as a Dart Map.
  /// - [config]: transport + db-path configuration.
  /// - [limits]: optional §4.2 client limits, forwarded to `create`.
  /// - [libraryPath]: explicit dylib path override (tests point it at the built
  ///   core); null uses the per-platform default / `SYNCULAR_LIBRARY_PATH`.
  /// - [pollInterval]: how often the non-blocking poll runs (default 40 ms).
  static SyncularClient create({
    String? clientId,
    required Map<String, Object?> schema,
    SyncularConfig config = const SyncularConfig(),
    Map<String, Object?>? limits,
    String? libraryPath,
    Duration pollInterval = const Duration(milliseconds: 40),
  }) {
    final ffi = SyncularFfi(libraryPath: libraryPath);
    final handle = ffi.clientNew(encodeJson(config._newConfigJson()));
    if (handle == nullptr) {
      throw const SyncularError(
        'client.failed',
        'syncular_client_new returned null (malformed config or unsupported transport)',
      );
    }
    final client = SyncularClient._(ffi, handle, pollInterval);
    final createParams = <String, Object?>{'schema': schema};
    if (clientId != null) createParams['clientId'] = clientId;
    if (config.dbPath != null) createParams['dbPath'] = config.dbPath;
    if (limits != null) createParams['limits'] = limits;
    client.command('create', createParams);
    client._startPollLoop();
    return client;
  }

  // -- Raw command ------------------------------------------------------------

  /// Run one raw JSON command through the core. Returns the `result` value (a
  /// `Map<String, Object?>`), or throws [SyncularError] on an `{error}` reply.
  Map<String, Object?> command(String method, Map<String, Object?> params) {
    if (_closed) {
      throw const SyncularError('client.closed', 'client is closed');
    }
    final request = {'method': method, 'params': params};
    final replyJson = _ffi.clientCommand(_handle, encodeJson(request));
    if (replyJson == null) {
      throw const SyncularError('client.failed', 'null reply (null handle)');
    }
    final reply = decodeJson(replyJson);
    if (reply is! Map) {
      throw const SyncularError('client.failed', 'non-object reply');
    }
    final error = reply['error'];
    if (error is Map) {
      throw SyncularError(
        (error['code'] as String?) ?? 'client.failed',
        (error['message'] as String?) ?? 'command failed',
      );
    }
    final result = reply['result'];
    if (result is Map) return result.cast<String, Object?>();
    return reply.cast<String, Object?>();
  }

  // -- Typed conveniences (mirror the command surface) ------------------------

  /// Apply local mutations optimistically; returns the client commit id. Works
  /// OFFLINE — the row is visible immediately via [readRows]/[query].
  String mutate(List<Map<String, Object?>> mutations) {
    final result = command('mutate', {'mutations': mutations});
    final id = result['clientCommitId'];
    if (id is! String) {
      throw const SyncularError(
          'client.failed', 'mutate returned no clientCommitId');
    }
    return id;
  }

  // -- Native CRDT (SPEC.md §5.10.5; needs the FFI `crdt-yjs` feature) ---------

  /// Materialize a `crdt` column's collaborative text — decoded from the stored
  /// (server-merged) Yjs bytes. [name] selects the shared text (default
  /// `'text'`). An absent row / NULL column is the empty document.
  String crdtText(String table, String rowId, String column,
      {String name = 'text'}) {
    final result = command('crdtText', {
      'table': table,
      'rowId': rowId,
      'column': column,
      'name': name,
    });
    final text = result['text'];
    if (text is! String) {
      throw const SyncularError('client.failed', 'crdtText returned no text');
    }
    return text;
  }

  /// Insert [value] at UTF-16 offset [index] in a `crdt` column's text and push
  /// the resulting Yjs update (baseVersion-less). Returns the commit id.
  String crdtInsertText(
    String table,
    String rowId,
    String column,
    int index,
    String value, {
    String name = 'text',
  }) =>
      _crdtCommitId('crdtInsertText', {
        'table': table,
        'rowId': rowId,
        'column': column,
        'name': name,
        'index': index,
        'value': value,
      });

  /// Delete [len] UTF-16 code units at [index] in a `crdt` column's text.
  String crdtDeleteText(
    String table,
    String rowId,
    String column,
    int index,
    int len, {
    String name = 'text',
  }) =>
      _crdtCommitId('crdtDeleteText', {
        'table': table,
        'rowId': rowId,
        'column': column,
        'name': name,
        'index': index,
        'len': len,
      });

  /// Escape hatch: apply an arbitrary Yjs [update] onto a `crdt` column.
  String crdtApplyUpdate(
      String table, String rowId, String column, List<int> update) {
    final hex = StringBuffer();
    for (final b in update) {
      hex.write((b & 0xff).toRadixString(16).padLeft(2, '0'));
    }
    return _crdtCommitId('crdtApplyUpdate', {
      'table': table,
      'rowId': rowId,
      'column': column,
      'update': {r'$bytes': hex.toString()},
    });
  }

  String _crdtCommitId(String method, Map<String, Object?> params) {
    final result = command(method, params);
    final id = result['clientCommitId'];
    if (id is! String) {
      throw SyncularError('client.failed', '$method returned no clientCommitId');
    }
    return id;
  }

  /// Register a subscription (table + scope map). Local; sync fills it.
  void subscribe(
    String id,
    String table, {
    Map<String, List<String>> scopes = const {},
    String? params,
  }) {
    final p = <String, Object?>{'id': id, 'table': table, 'scopes': scopes};
    if (params != null) p['params'] = params;
    command('subscribe', p);
  }

  /// Remove a subscription.
  void unsubscribe(String id) => command('unsubscribe', {'id': id});

  /// Run one sync round against the server (needs `native-transport`). Never
  /// errors out-of-band; inspect `ok`/`errorCode` on the returned map.
  Map<String, Object?> sync() => command('sync', const {});

  /// Drive sync to quiescence (needs `native-transport`).
  Map<String, Object?> syncUntilIdle({int? maxRounds}) {
    final p = <String, Object?>{};
    if (maxRounds != null) p['maxRounds'] = maxRounds;
    return command('syncUntilIdle', p);
  }

  /// Read all locally-visible rows of a table as RowState maps
  /// (`{rowId, version, values}`; `version == -1` = optimistic/offline).
  List<Map<String, Object?>> readRows(String table) {
    final result = command('readRows', {'table': table});
    final rows = result['rows'];
    if (rows is List) {
      return rows.map((r) => (r as Map).cast<String, Object?>()).toList();
    }
    return const [];
  }

  /// Run arbitrary read-only SQL over the local visible tables (the live-query
  /// fast path). Params ride as driver value forms; bytes as `{"$bytes":hex}`.
  /// Returns flat SQL rows.
  List<Map<String, Object?>> query(String sql,
      {List<Object?> params = const []}) {
    final result = command('query', {'sql': sql, 'params': params});
    final rows = result['rows'];
    if (rows is List) {
      return rows.map((r) => (r as Map).cast<String, Object?>()).toList();
    }
    return const [];
  }

  /// Pending client commit ids (the offline outbox — non-empty after a local
  /// [mutate] until sync drains it). The honest "unsynced work" signal.
  List<String> pendingCommitIds() {
    final result = command('pendingCommitIds', const {});
    final ids = result['ids'];
    if (ids is List) return ids.whereType<String>().toList();
    return const [];
  }

  /// The current sync-needed flag (§8.4 wake signal).
  bool syncNeeded() {
    final result = command('syncNeeded', const {});
    return result['value'] == true;
  }

  /// A subscription's status string (`active`/`revoked`/`failed`).
  String? subscriptionState(String id) {
    final result = command('subscriptionState', {'id': id});
    final state = result['state'];
    if (state is Map) return state['status'] as String?;
    return null;
  }

  /// Current conflicts (§6).
  List<Map<String, Object?>> conflicts() {
    final result = command('conflicts', const {});
    final list = result['conflicts'];
    if (list is List) {
      return list.map((c) => (c as Map).cast<String, Object?>()).toList();
    }
    return const [];
  }

  /// Presence peers for a scope key (§8.6).
  List<Map<String, Object?>> presence(String scopeKey) {
    final result = command('presence', {'scopeKey': scopeKey});
    final peers = result['peers'];
    if (peers is List) {
      return peers.map((p) => (p as Map).cast<String, Object?>()).toList();
    }
    return const [];
  }

  /// Publish (or clear, with null) a presence doc for a scope key.
  void setPresence(String scopeKey, Object? doc) =>
      command('setPresence', {'scopeKey': scopeKey, 'doc': doc});

  /// §4.8 windowed sync: set the active window (a base descriptor + the value
  /// set). Widening bootstraps the new units; narrowing evicts the removed ones.
  void setWindow(Map<String, Object?> base, List<String> units) =>
      command('setWindow', {'base': base, 'units': units});

  /// §4.8 windowed sync: the completeness oracle for a base descriptor —
  /// the windowed-in units plus the subset whose bootstrap has not yet
  /// completed. Registration alone is not completeness: render a
  /// [WindowState.pending] unit as loading/partial, never as complete.
  WindowState windowState(Map<String, Object?> base) {
    final result = command('windowState', {'base': base});
    final units = result['units'];
    final pending = result['pending'];
    return WindowState(
      units: units is List ? units.whereType<String>().toList() : const [],
      pending:
          pending is List ? pending.whereType<String>().toList() : const [],
    );
  }

  /// Open the realtime socket (needs `native-transport`).
  void connectRealtime() => command('connectRealtime', const {});

  /// Close the realtime socket.
  void disconnectRealtime() => command('disconnectRealtime', const {});

  // -- Lifecycle (the wrapper owns it, per the roadmap) -----------------------

  /// Pause background activity — stop the event poll loop and disconnect the
  /// realtime socket. Call from `AppLifecycleState.paused` / a connectivity-lost
  /// handler. The database and offline outbox are intact; mutations still queue.
  /// [resume] restarts the loop and socket. Honest scope: the core has no single
  /// "stop everything" command, so pause = stop-poll + disconnect.
  void pause() {
    _stopPollLoop();
    try {
      disconnectRealtime(); // lean/offline core has no socket
    } on SyncularError {
      // best-effort
    }
  }

  /// Resume after [pause] — reconnect realtime (if present) and restart the poll.
  void resume() {
    try {
      connectRealtime();
    } on SyncularError {
      // best-effort
    }
    _startPollLoop();
  }

  /// Close the core, releasing its database/transport/socket. Idempotent;
  /// commands throw `client.closed` after. Stops the poll loop first, so the
  /// handle is never freed under an in-flight poll (the poll runs on THIS
  /// isolate, so stopping the Timer synchronously guarantees no overlap).
  void close() {
    _stopPollLoop();
    if (_closed) return;
    _closed = true;
    _ffi.clientClose(_handle);
    _handle = nullptr;
    _eventController.close();
  }

  // -- Event poll loop --------------------------------------------------------

  void _startPollLoop() {
    if (_closed || _pollTimer != null) return;
    _pollTimer = Timer.periodic(_pollInterval, (_) => _drainEvents());
  }

  void _stopPollLoop() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Drain all events currently queued in the core with NON-BLOCKING polls
  /// (timeout_ms = 0), delivering each to [events]. Non-blocking means the
  /// isolate is never parked inside the FFI — the poll returns immediately when
  /// the queue is empty. Runs on the owning isolate, so it can never race an
  /// in-flight command.
  void _drainEvents() {
    if (_closed) return;
    while (true) {
      final eventJson = _ffi.clientPollEvent(_handle, 0);
      if (eventJson == null) return;
      final value = decodeJson(eventJson);
      if (value is! Map) continue;
      final type = value['type'];
      if (type is! String) continue;
      _eventController.add(
        SyncularEvent(type, value.cast<String, Object?>()),
      );
    }
  }
}
