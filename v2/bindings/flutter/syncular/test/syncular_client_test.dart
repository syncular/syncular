// Hermetic, offline-first tests for the Dart wrapper against the LOCALLY-built
// libsyncular (check.sh / the CI lane build it and point SYNCULAR_LIBRARY_PATH
// at target/debug/libsyncular.{dylib,so}). No server — syncular is offline-first
// by design: a `mutate` is optimistic and immediately visible via readRows/query.
//
// Coverage mirrors the Swift/Kotlin suites: init/create, command round-trip,
// mutate → readRows (optimistic row, version -1), the query fast path, error
// surfacing, the offline outbox, a network command reporting transport.unavailable
// on the lean core, event-poll (none pending when idle), close idempotence, and
// pause/resume.
import 'package:syncular/syncular.dart';
import 'package:test/test.dart';

Map<String, Object?> todoSchema() => {
      'version': 1,
      'tables': [
        {
          'name': 'todo',
          'primaryKey': 'id',
          'scopes': <Object?>[],
          'columns': [
            {'name': 'id', 'type': 'string', 'nullable': false},
            {'name': 'title', 'type': 'string', 'nullable': false},
          ],
        },
      ],
    };

Map<String, Object?> upsert(String id, String title) => {
      'op': 'upsert',
      'table': 'todo',
      'values': {'id': id, 'title': title},
    };

SyncularClient makeClient() =>
    SyncularClient.create(clientId: 'dart-test', schema: todoSchema());

void main() {
  test('init creates a client and subscribe reports active', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe('s1', 'todo');
    expect(client.subscriptionState('s1'), equals('active'));
  });

  test('mutate then readRows shows the optimistic row', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe('s1', 'todo');
    final commitId = client.mutate([upsert('t1', 'hello')]);
    expect(commitId, isNotEmpty);

    // Offline-first: the row is visible immediately.
    final rows = client.readRows('todo');
    expect(rows, hasLength(1));
    final values = rows.first['values'] as Map;
    expect(values['title'], equals('hello'));
    expect(rows.first['version'], equals(-1)); // optimistic / offline
  });

  test('query fast path returns flat columns', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe('s1', 'todo');
    client.mutate([upsert('t1', 'world')]);
    final rows =
        client.query('SELECT title FROM todo WHERE id = ?', params: ['t1']);
    expect(rows, hasLength(1));
    expect(rows.first['title'], equals('world'));
  });

  test('raw command round-trip', () {
    final client = makeClient();
    addTearDown(client.close);
    final result = client.command('subscribe', {
      'id': 's2',
      'table': 'todo',
      'scopes': <String, Object?>{},
    });
    expect(result, isA<Map>());
  });

  test('error reply surfaces as SyncularError', () {
    final client = makeClient();
    addTearDown(client.close);
    expect(() => client.readRows('does_not_exist'),
        throwsA(isA<SyncularError>()));
  });

  test('pending commits after an offline mutate', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe('s1', 'todo');
    client.mutate([upsert('t1', 'x')]);
    expect(client.pendingCommitIds(), isNotEmpty);
  });

  test('network command reports transport.unavailable on the lean core', () {
    final client = makeClient();
    addTearDown(client.close);
    // Lean core: sync() never errors out-of-band — it returns
    // {ok:false, errorCode} so the caller sees the failed round.
    final outcome = client.sync();
    expect(outcome['ok'], isFalse);
    expect(outcome['errorCode'], contains('transport'));
  });

  test('poll loop delivers nothing when idle', () async {
    final client = makeClient();
    addTearDown(client.close);
    var count = 0;
    final sub = client.events.listen((_) => count++);
    addTearDown(sub.cancel);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(count, equals(0));
  });

  test('close is idempotent and commands throw after', () {
    final client = makeClient();
    client.close();
    client.close(); // idempotent
    expect(
      () => client.readRows('todo'),
      throwsA(
        isA<SyncularError>().having((e) => e.code, 'code', 'client.closed'),
      ),
    );
  });

  test('pause/resume stops and restarts the poll loop', () {
    final client = makeClient();
    addTearDown(client.close);
    client.pause();
    client.resume();
    client.subscribe('s1', 'todo');
    expect(client.subscriptionState('s1'), equals('active'));
  });
}
