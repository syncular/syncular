// Hermetic, offline-first tests for the Dart wrapper against the LOCALLY-built
// libsyncular (check.sh / the CI lane build it and point SYNCULAR_LIBRARY_PATH
// at target/debug/libsyncular.{dylib,so}). No server — syncular is offline-first
// by design: a `mutate` is optimistic and immediately visible via readRows/query.
//
// Coverage mirrors the Swift/Kotlin suites: init/create, command round-trip,
// mutate → readRows (optimistic row, version -1), the query fast path, error
// surfacing, the offline outbox, a network command reporting transport.unavailable
// on the lean core, event-poll (initial diagnostics, then none while idle),
// close idempotence, and pause/resume.
import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:syncular/syncular.dart';
import 'package:test/test.dart';

Map<String, Object?> todoSchema() => {
      'version': 1,
      'tables': [
        {
          'name': 'todo',
          'primaryKey': 'id',
          'scopes': [
            {'pattern': 'todo:{id}'},
          ],
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

// Header sources are top-level functions: the auth isolate runs them. This
// one echoes its context into the headers, so the answers show it arrived.
Future<Map<String, String>> renewingHeaders(
        Map<String, String>? rejected, SyncularHeaderContext context) async =>
    {
      'authorization': rejected == null ? 'Bearer first' : 'Bearer renewed',
      'x-context':
          '${context.clientId} ${context.round ?? 'none'} ${context.target}',
    };

Future<Map<String, String>> failingHeaders(
        Map<String, String>? rejected, SyncularHeaderContext context) =>
    Future.error(StateError('signed out'));

void main() {
  test('init creates a client and subscribe reports active', () {
    final client = makeClient();
    addTearDown(client.close);
    final id = client.subscribe({'id': 't1'});
    expect(client.unit(id)?['status'], equals('active'));
    expect(client.unit(id)?['scopes'], equals({'id': 't1'}));
  });

  test('units, windows and catch-up cross the command surface', () {
    final client = makeClient();
    addTearDown(client.close);
    final ids = client.subscribeMany([
      {'id': 'a'},
      {'id': 'b'},
    ]);
    expect(ids, hasLength(2));
    expect(client.subscribe({'id': 'a'}), equals(ids[0]));
    expect(client.units(), hasLength(2));
    final catchup = client.unitCatchup(ids[0]);
    expect(catchup['state'], equals('known'));
    expect(catchup['bootstrapComplete'], isFalse);
    expect(client.unitCatchup('absent')['state'], equals('unknown'));
    client.unsubscribe(ids[1]);
    expect(client.unit(ids[1]), isNull);

    client.setWindow('id', ['c', 'd']);
    final window = client.windowState('id');
    expect(window.units, equals(['c', 'd']));
    expect(window.pending, equals(['c', 'd']));
    client.setWindow('id', const []);
    expect(client.windowState('id').units, isEmpty);
    expect(
      () => client.subscribe({'id': '*'}),
      throwsA(isA<SyncularError>().having(
          (error) => error.code, 'code', 'sync.invalid_subscription')),
    );
  });

  test('native transport policy reaches the core config', () {
    final client = SyncularClient.create(
      clientId: 'dart-policy',
      schema: todoSchema(),
      config: const SyncularConfig(
        requestTimeoutMs: 1000,
        roundDeadlineMs: 2000,
        maxRequestBytes: 1024,
        maxResponseBytes: 2048,
        redirects: 'deny',
        realtimeHeartbeatMs: 5000,
      ),
    );
    addTearDown(client.close);
    final id = client.subscribe({'id': 't1'});
    expect(client.unit(id)?['status'], equals('active'));

    // A zero deadline is rejected by the core's config validation, proving
    // the field is serialized into the config JSON.
    expect(
      () => SyncularClient.create(
        clientId: 'dart-policy-bad',
        schema: todoSchema(),
        config: const SyncularConfig(requestTimeoutMs: 0),
      ),
      throwsA(isA<SyncularError>()),
    );
  });

  test('a realtime-wake event is answered with drainRealtime, not delivered',
      () async {
    // The lean core has no socket, so the wake goes straight to the poll
    // loop's dispatch. On a closed client a command throws `client.closed`,
    // which shows the wake issued one while another event type issues none.
    final client = SyncularClient.create(
      clientId: 'dart-wake',
      schema: todoSchema(),
      pollInterval: const Duration(days: 1),
    );
    final delivered = <String>[];
    client.events.listen((event) => delivered.add(event.type));
    client.handleEvent('{"type":"realtime-wake"}');
    client.handleEvent('{"type":"presence","scopeKey":"room:1"}');
    client.handleEvent('{"type":"scopes-changed"}');
    await pumpEventQueue();
    expect(delivered, equals(['presence', 'scopes-changed']));
    client.close();
    expect(
      () => client.handleEvent('{"type":"realtime-wake"}'),
      throwsA(
        isA<SyncularError>().having((e) => e.code, 'code', 'client.closed'),
      ),
    );
  });

  test('localAuthorityPath reaches the core config', () {
    // An empty path is rejected by the core's config validation, proving the
    // field is serialized into the config JSON.
    expect(
      () => SyncularClient.create(
        clientId: 'dart-authority-bad',
        schema: todoSchema(),
        config: const SyncularConfig(localAuthorityPath: ''),
      ),
      throwsA(isA<SyncularError>()),
    );
  });

  test('syncUntilIdle forwards timeoutMs to the core', () {
    final client = makeClient();
    addTearDown(client.close);
    expect(
      () => client.syncUntilIdle(timeoutMs: 0),
      throwsA(
        isA<SyncularError>().having(
          (e) => e.code,
          'code',
          'sync.invalid_request',
        ),
      ),
    );
  });

  test('local authority commands without a configured authority', () {
    final client = makeClient();
    addTearDown(client.close);
    expect(client.localAuthorityState(), isNull);
    for (final call in [
      client.attachLocalAuthority,
      client.abandonLocalAuthorityAttach,
    ]) {
      expect(
        call,
        throwsA(
          isA<SyncularError>().having(
            (e) => e.code,
            'code',
            'client.local_authority_unconfigured',
          ),
        ),
      );
    }
  });

  test('a local authority serves rounds in process', () {
    final directory = Directory.systemTemp.createTempSync('syncular-authority');
    addTearDown(() => directory.deleteSync(recursive: true));
    // The authority serves only scoped tables (SPEC §3.1).
    Map<String, Object?> column(String name) =>
        {'name': name, 'type': 'string', 'nullable': false};
    final client = SyncularClient.create(
      clientId: 'dart-authority',
      schema: {
        'version': 1,
        'tables': [
          {
            'name': 'todo',
            'primaryKey': 'id',
            'scopes': [
              {'pattern': 'list:{list_id}', 'column': 'list_id'},
            ],
            'columns': [column('id'), column('list_id')],
          },
        ],
      },
      config: SyncularConfig(
        localAuthorityPath: '${directory.path}/authority.sqlite',
      ),
    );
    addTearDown(client.close);
    expect(client.localAuthorityState(), equals('local'));
    client.subscribe({'list_id': 'l1'});
    client.mutate([
      {
        'op': 'upsert',
        'table': 'todo',
        'values': {'id': 't1', 'list_id': 'l1'},
      },
    ]);
    client.syncUntilIdle();
    expect(client.pendingCommitIds(), isEmpty);
    // The authority acknowledged the commit: the row carries a server version.
    expect(client.readRows('todo').first['version'], equals(1));
  });

  test('mutate then readRows shows the optimistic row', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe({'id': 't1'});
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
    client.subscribe({'id': 't1'});
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
      'scopes': {'id': 't2'},
    });
    expect(result['id'], isA<String>());
  });

  test('a client with baseUrl requires a headers source', () {
    expect(
      () => SyncularClient.create(
        schema: todoSchema(),
        config: const SyncularConfig(baseUrl: 'https://api.example.com'),
      ),
      throwsA(isA<SyncularError>()
          .having((e) => e.code, 'code', 'client.headers_required')),
    );
  });

  test('a header request is answered from the source', () async {
    expect(
      await SyncularClient.answerHeaders(
          '{"requestId":1,"rejected":null,"clientId":"c1","round":7,"target":"sync"}',
          renewingHeaders),
      equals((1, '{"authorization":"Bearer first","x-context":"c1 7 sync"}')),
    );
    expect(
      await SyncularClient.answerHeaders(
          '{"requestId":2,"rejected":{"authorization":"Bearer first"},'
          '"clientId":"c1","round":null,"target":"realtime"}',
          renewingHeaders),
      equals((
        2,
        '{"authorization":"Bearer renewed","x-context":"c1 none realtime"}'
      )),
    );
  });

  test('a throwing source answers null headers', () async {
    expect(
      await SyncularClient.answerHeaders(
          '{"requestId":3,"rejected":null,"clientId":"c1","round":null,"target":"blob"}',
          failingHeaders),
      equals((3, 'null')),
    );
  });

  test('a request without context is answered with null headers', () async {
    expect(
      await SyncularClient.answerHeaders(
          '{"requestId":5,"rejected":null,"round":null}', renewingHeaders),
      equals((5, 'null')),
    );
  });

  test('events keep flowing while a header source is pending', () async {
    final gate = Completer<Map<String, String>>();
    final client = SyncularClient.create(
      clientId: 'dart-pending-source',
      schema: todoSchema(),
      pollInterval: const Duration(days: 1),
    );
    addTearDown(client.close);
    final delivered = <String>[];
    client.events.listen((event) => delivered.add(event.type));
    final answer = SyncularClient.answerHeaders(
        '{"requestId":4,"rejected":null,"clientId":"c1","round":1,"target":"segment"}',
        (_, __) => gate.future);
    client.handleEvent('{"type":"presence","scopeKey":"room:1"}');
    await pumpEventQueue();
    expect(delivered, equals(['presence']));
    gate.complete({'authorization': 'Bearer late'});
    expect(await answer, equals((4, '{"authorization":"Bearer late"}')));
  });

  test('a client with a header source runs commands and closes', () {
    // The auth isolate starts at create and is killed by close; a leaked
    // isolate would keep the test process from exiting.
    final client = SyncularClient.create(
      clientId: 'dart-auth-isolate',
      schema: todoSchema(),
      config: const SyncularConfig(headers: renewingHeaders),
    );
    final id = client.subscribe({'id': 't1'});
    expect(client.unit(id)?['status'], equals('active'));
    client.close();
    expect(
      () => client.readRows('todo'),
      throwsA(
        isA<SyncularError>().having((e) => e.code, 'code', 'client.closed'),
      ),
    );
  });

  test('a source the auth isolate cannot receive surfaces on events', () async {
    // A closure capturing a ReceivePort cannot be sent to another isolate.
    // The core is still freed at close: a leaked exit port would keep the
    // test process from exiting.
    final port = ReceivePort();
    addTearDown(port.close);
    final client = SyncularClient.create(
      clientId: 'dart-unsendable-source',
      schema: todoSchema(),
      config: SyncularConfig(
          headers: (_, __) async => {'port': '${port.hashCode}'}),
      pollInterval: const Duration(days: 1),
    );
    final failure = Completer<Object>();
    client.events.listen((_) {}, onError: failure.complete);
    expect(await failure.future, isA<ArgumentError>());
    client.close();
  });

  test('close before the spawn failure arrives still frees the core', () {
    final port = ReceivePort();
    addTearDown(port.close);
    SyncularClient.create(
      clientId: 'dart-unsendable-closed',
      schema: todoSchema(),
      config: SyncularConfig(
          headers: (_, __) async => {'port': '${port.hashCode}'}),
    ).close();
  });

  test('addEncryptionKeys reaches the core as hex keys by key id', () {
    final client = makeClient();
    addTearDown(client.close);
    client.addEncryptionKeys({'practice-v2': List.filled(32, 0x2b)});
    // The core refuses a key that is not 32 bytes and names it, so the key id
    // and the bytes both arrived.
    expect(
      () => client.addEncryptionKeys({
        'short': [0x00, 0xab]
      }),
      throwsA(isA<SyncularError>()
          .having((e) => (e.details as Map?)?['keyId'], 'keyId', 'short')),
    );
  });

  test('connectivity adapter pauses, resumes, and detaches', () async {
    final client = makeClient();
    addTearDown(client.close);
    final changes = StreamController<bool>.broadcast();
    final adapter = SyncularConnectivityAdapter(
      client,
      FlutterConnectivitySignal(online: false, changes: changes.stream),
    );
    expect(changes.hasListener, isTrue);
    changes.add(true);
    await Future<void>.value();
    client.subscribe({'id': 'after-connectivity'});
    await adapter.close();
    expect(changes.hasListener, isFalse);
    await changes.close();
  });

  test('error reply surfaces as SyncularError', () {
    final client = makeClient();
    addTearDown(client.close);
    expect(
        () => client.readRows('does_not_exist'), throwsA(isA<SyncularError>()));
  });

  test('snapshots and pending outcomes after an offline mutate', () {
    final client = makeClient();
    addTearDown(client.close);
    client.subscribe({'id': 't1'});
    final id = client.mutate([upsert('t1', 'x')]);
    expect(client.pendingCommitIds(), [id]);
    expect(client.statusSnapshot()['outbox'], 1);
    expect(
        client.querySnapshot('SELECT title FROM todo')['rows'], hasLength(1));
    expect(
        (client.diagnosticsSnapshot()['replica'] as Map)['pendingOutbox'], 1);
    expect(client.commitDelivery(id)['status'], 'pending');
    expect(client.commitOutcomes(), isEmpty);
    expect(client.rejections(), isEmpty);
    expect(
        () => client.resolveCommitOutcome(
            {'clientCommitId': id, 'resolution': 'dismissed'}),
        throwsA(isA<SyncularError>()));
    expect(
        () => client.replaceCommitOutcome({'clientCommitId': id, 'sequence': 1}),
        throwsA(isA<SyncularError>()
            .having((e) => e.code, 'code', 'sync.outcome_not_found')));
    for (final method in [
      'schemaFloor',
      'leaseState',
      'upgrading',
      'syncNeeded'
    ]) {
      expect(() => client.command(method, const {}),
          throwsA(isA<SyncularError>()));
    }
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

  test('poll loop delivers initial diagnostics then nothing when idle',
      () async {
    final client = makeClient();
    addTearDown(client.close);

    final initial = await client.events.first.timeout(
      const Duration(seconds: 2),
    );
    expect(initial.type, equals('diagnostics'));

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
    final id = client.subscribe({'id': 't1'});
    expect(client.unit(id)?['status'], equals('active'));
  });
}
