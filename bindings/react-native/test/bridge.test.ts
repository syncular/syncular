/**
 * Bridge unit tests with an injected NativeModule + event-emitter double:
 * assert the `SyncClientLike` contract — method → command mapping, the query
 * fast path, exact change fanout, the `{$bytes:hex}`
 * convention, and lifecycle (pause/resume/close driving the native pump). Plus
 * a shape-parity test against the React `normalizeClient`, so a drift in
 * `SyncClientLike` breaks this suite (the bridge is the fifth host of that one
 * interface, after direct / worker / follower / Tauri).
 *
 * No device, no RN runtime — the native module is injected, exactly the
 * hermetic pattern the roadmap sets for the RN JS bridge.
 */
import { describe, expect, test } from 'bun:test';
import {
  INVALID_HOST_RESPONSE_CODE,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
} from '@syncular/client';
import { normalizeClient, type SyncClientLike } from '@syncular/react';
import { hostBoolean } from '../../../packages/typegen/test/fixtures/basic/syncular.queries';
import {
  createNativeSyncClient,
  type SyncularEvent,
  type SyncularEventEmitter,
  type SyncularNativeModule,
} from '../src/index';

/** A recording NativeModule + emitter double. Commands answer from a table. */
function makeNative(
  responder: (method: string, params: Record<string, unknown>) => unknown,
): {
  nativeModule: SyncularNativeModule;
  eventEmitter: SyncularEventEmitter;
  calls: Array<{ fn: string; arg: unknown }>;
  emit: (payload: SyncularEvent) => void;
  pump: { started: number; stopped: number; closed: number };
} {
  const calls: Array<{ fn: string; arg: unknown }> = [];
  const handlers = new Set<(payload: SyncularEvent) => void>();
  const pump = { started: 0, stopped: 0, closed: 0 };

  const nativeModule: SyncularNativeModule = {
    create: async (configJson, createJson) => {
      calls.push({ fn: 'create', arg: { configJson, createJson } });
      const params = JSON.parse(createJson) as Record<string, unknown>;
      return JSON.stringify(responder('create', params));
    },
    command: async (commandJson) => {
      const { method, params } = JSON.parse(commandJson) as {
        method: string;
        params: Record<string, unknown>;
      };
      calls.push({ fn: 'command', arg: { method, params } });
      return JSON.stringify(responder(method, params));
    },
    query: async (sql, paramsJson) => {
      calls.push({ fn: 'query', arg: { sql, params: JSON.parse(paramsJson) } });
      return JSON.stringify(responder('query', { sql }));
    },
    close: async () => {
      pump.closed += 1;
    },
    startEvents: () => {
      pump.started += 1;
    },
    stopEvents: () => {
      pump.stopped += 1;
    },
  };

  const eventEmitter: SyncularEventEmitter = {
    addListener: (_event, handler) => {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
  };

  const emit = (payload: SyncularEvent) => {
    for (const h of handlers) h(payload);
  };
  return { nativeModule, eventEmitter, calls, emit, pump };
}

const OK = (result: unknown) => ({ result });

const DIAGNOSTICS = {
  version: 1,
  capturedAtMs: 10,
  host: {
    kind: 'direct',
    role: 'single',
    connectivity: 'online',
    realtime: 'connected',
  },
  securityLifecycle: 'active',
  schema: { currentVersion: 1, upgrading: false },
  replica: { localRevision: '7', syncNeeded: false, pendingOutbox: 0 },
  lease: { state: 'none' },
  subscriptions: [],
  subscriptionsTruncated: false,
  storage: { status: 'healthy' },
} as const;

/** A responder answering create + the accessor commands with fixtures. */
function defaultResponder(
  method: string,
  params: Record<string, unknown>,
): unknown {
  switch (method) {
    case 'query':
      if (String(params.sql).includes('SELECT id, done FROM tasks')) {
        return OK({ rows: [{ id: 't1', done: 0 }] });
      }
      return OK({
        rows: [{ id: 't1', title: 'hello', blob: { $bytes: 'deadbeef' } }],
      });
    case 'querySnapshot':
      return OK({
        revision: '7',
        rows: [
          { id: 't1', title: 'hello', count: { $bigint: '9007199254740993' } },
        ],
        coverage: { complete: true, pending: [], missing: [] },
      });
    case 'create':
      return OK({});
    case 'mutate':
    case 'patch':
      return OK({ clientCommitId: 'commit-1' });
    case 'purgeLocalData':
      return OK({
        alreadyApplied: false,
        purgedRows: 2,
        droppedCommits: 1,
      });
    case 'rebootstrapLocalData':
      return OK({
        alreadyApplied: false,
        retainedCommits: 3,
        resetSubscriptions: 4,
      });
    case 'statusSnapshot':
      return OK({
        currentSchemaVersion: 1,
        outbox: 1,
        upgrading: false,
        syncNeeded: false,
      });
    case 'diagnosticsSnapshot':
      return OK(DIAGNOSTICS);
    case 'conflicts':
      return OK({ conflicts: [] });
    case 'rejections':
      return OK({ rejections: [] });
    case 'commitOutcome':
      return OK({
        outcome: {
          sequence: 1,
          clientCommitId: 'commit-1',
          status: 'applied',
          recordedAtMs: 1,
          results: [{ status: 'applied', opIndex: 0 }],
          resolution: 'active',
        },
      });
    case 'commitOutcomes':
      return OK({ outcomes: [] });
    case 'resolveCommitOutcome':
      return OK({
        outcome: {
          sequence: 1,
          clientCommitId: 'commit-1',
          status: 'applied',
          recordedAtMs: 1,
          results: [{ status: 'applied', opIndex: 0 }],
          resolution: 'dismissed',
          resolvedAtMs: 2,
        },
      });
    case 'schemaFloor':
      return OK({ floor: undefined });
    case 'leaseState':
      return OK({ lease: undefined });
    case 'upgrading':
      return OK({ value: false });
    case 'syncNeeded':
      return OK({ value: true });
    case 'pendingCommitIds':
      return OK({ ids: ['commit-1'] });
    case 'presence':
      return OK({ peers: [] });
    default:
      return OK({});
  }
}

async function build() {
  const { nativeModule, eventEmitter, calls, emit, pump } =
    makeNative(defaultResponder);
  const client = await createNativeSyncClient({
    clientId: 'c1',
    schema: { version: 1, tables: [] },
    nativeModule,
    eventEmitter,
  });
  return { client, calls, emit, pump };
}

describe('createNativeSyncClient', () => {
  test('issues create and starts the event pump on construction', async () => {
    const { calls, pump } = await build();
    const create = calls.find((c) => c.fn === 'create');
    expect(create).toBeDefined();
    const createParams = JSON.parse(
      (create?.arg as { createJson: string }).createJson,
    );
    expect(createParams.clientId).toBe('c1');
    expect(pump.started).toBe(1);
  });

  test('preflight blocks protected work and installs the portable keyring on activation', async () => {
    const { nativeModule, eventEmitter, calls, emit } =
      makeNative(defaultResponder);
    const client = await createNativeSyncClient({
      schema: { version: 1, tables: [] },
      securityPreflight: true,
      nativeModule,
      eventEmitter,
    });
    const create = calls.find((call) => call.fn === 'create');
    const createParams = JSON.parse(
      (create?.arg as { createJson: string }).createJson,
    );
    expect(createParams.securityPreflight).toBe(true);
    expect(await client.securityLifecycle()).toBe('preflight');
    await expect(client.query('SELECT 1')).rejects.toMatchObject({
      code: SECURITY_PREFLIGHT_REQUIRED_CODE,
    });
    emit({ type: 'sync-intent', intent: { kind: 'interactive' } });
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    expect(
      calls.some(
        (call) =>
          call.fn === 'command' &&
          (call.arg as { method?: string }).method === 'syncUntilIdle',
      ),
    ).toBe(false);

    await client.purgeLocalData({
      purgeId: 'directive-1',
      targets: [{ table: 'todo', selectors: { list_id: ['list-1'] } }],
    });
    await expect(
      client.rebootstrapLocalData({ rebootstrapId: 'blocked-repair' }),
    ).rejects.toMatchObject({ code: SECURITY_PREFLIGHT_REQUIRED_CODE });
    await client.activateSecurity({
      encryption: {
        keys: { 'practice-v2': new Uint8Array(32).fill(0x3c) },
        keyIdColumns: { patients: 'encryption_key_id' },
      },
    });
    expect(await client.securityLifecycle()).toBe('active');
    const activation = calls.find(
      (call) =>
        call.fn === 'command' &&
        (call.arg as { method?: string }).method === 'activateSecurity',
    );
    expect(
      (
        activation?.arg as {
          params: { encryption: { keys: Record<string, unknown> } };
        }
      ).params.encryption.keys['practice-v2'],
    ).toEqual({ $bytes: '3c'.repeat(32) });
    expect(await client.query('SELECT 1')).toBeInstanceOf(Array);
    await client.close();
  });

  test('query uses the query fast path and decodes bytes', async () => {
    const { client, calls } = await build();
    const rows = await client.query('SELECT * FROM todo WHERE id = ?', ['t1']);
    const q = calls.find((c) => c.fn === 'query');
    expect(q).toBeDefined();
    expect((q?.arg as { sql: string }).sql).toBe(
      'SELECT * FROM todo WHERE id = ?',
    );
    expect((q?.arg as { params: unknown[] }).params).toEqual(['t1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[0]?.blob as Uint8Array)).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(rows[0]?.title).toBe('hello');
  });

  test('generated query decodes SQLite booleans on the native surface', async () => {
    const { client } = await build();
    expect(await hostBoolean(client, { projectId: 'p1' })).toEqual([
      { id: 't1', done: false },
    ]);
  });

  test('query encodes Uint8Array params as {$bytes:hex}', async () => {
    const { client, calls } = await build();
    await client.query('SELECT ?', [new Uint8Array([1, 255])]);
    const q = calls.findLast((c) => c.fn === 'query');
    expect((q?.arg as { params: unknown[] }).params[0]).toEqual({
      $bytes: '01ff',
    });
  });

  test('querySnapshot is one atomic command and decodes bigint rows', async () => {
    const { client, calls } = await build();
    const snapshot = await client.querySnapshot({
      sql: 'SELECT id, count FROM todo',
    });
    const command = calls.find(
      (call) =>
        call.fn === 'command' &&
        (call.arg as { method: string }).method === 'querySnapshot',
    );
    expect(command).toBeDefined();
    expect(snapshot.revision).toBe(7n);
    expect(snapshot.coverage.complete).toBe(true);
    expect(snapshot.rows[0]?.count).toBe(9007199254740993n);
  });

  test('mutate returns the clientCommitId', async () => {
    const { client } = await build();
    const id = await client.mutate([
      { op: 'upsert', table: 'todo', values: { id: 't1', title: 'x' } },
    ]);
    expect(id).toBe('commit-1');
  });

  test('patch forwards a partial update without a full-row spread', async () => {
    const { client, calls } = await build();
    expect(await client.patch('todo', 't1', { done: true })).toBe('commit-1');
    const command = calls.findLast(
      (call) =>
        call.fn === 'command' &&
        (call.arg as { method: string }).method === 'patch',
    );
    expect(command?.arg).toMatchObject({
      method: 'patch',
      params: { table: 'todo', rowId: 't1', partial: { done: true } },
    });
  });

  test('purgeLocalData forwards the exact bounded plan', async () => {
    const { client, calls } = await build();
    const input = {
      purgeId: 'purge-001',
      targets: [
        {
          table: 'patient_notes',
          selectors: { encryption_key_id: ['key-revoked'] },
        },
      ],
    } as const;
    expect(await client.purgeLocalData(input)).toEqual({
      alreadyApplied: false,
      purgedRows: 2,
      droppedCommits: 1,
    });
    const command = calls.findLast(
      (call) =>
        call.fn === 'command' &&
        (call.arg as { method: string }).method === 'purgeLocalData',
    );
    expect(command?.arg).toEqual({
      method: 'purgeLocalData',
      params: { input },
    });
  });

  test('rebootstrapLocalData forwards the exact idempotency key', async () => {
    const { client, calls } = await build();
    const input = { rebootstrapId: 'support-case-001' } as const;
    expect(await client.rebootstrapLocalData(input)).toEqual({
      alreadyApplied: false,
      retainedCommits: 3,
      resetSubscriptions: 4,
    });
    const command = calls.findLast(
      (call) =>
        call.fn === 'command' &&
        (call.arg as { method: string }).method === 'rebootstrapLocalData',
    );
    expect(command?.arg).toEqual({
      method: 'rebootstrapLocalData',
      params: { input },
    });
  });

  test('returns the original native receipt counts after a client recreation', async () => {
    let applied = false;
    const { nativeModule, eventEmitter } = makeNative((method, params) => {
      if (method === 'rebootstrapLocalData') {
        const alreadyApplied = applied;
        applied = true;
        return OK({
          alreadyApplied,
          retainedCommits: 3,
          resetSubscriptions: 4,
        });
      }
      return defaultResponder(method, params);
    });
    const first = await createNativeSyncClient({
      clientId: 'receipt-replay',
      schema: { version: 1, tables: [] },
      nativeModule,
      eventEmitter,
    });
    expect(
      await first.rebootstrapLocalData({ rebootstrapId: 'repair-replay' }),
    ).toEqual({
      alreadyApplied: false,
      retainedCommits: 3,
      resetSubscriptions: 4,
    });
    await first.close();

    const reopened = await createNativeSyncClient({
      clientId: 'receipt-replay',
      schema: { version: 1, tables: [] },
      nativeModule,
      eventEmitter,
    });
    expect(
      await reopened.rebootstrapLocalData({ rebootstrapId: 'repair-replay' }),
    ).toEqual({
      alreadyApplied: true,
      retainedCommits: 3,
      resetSubscriptions: 4,
    });
    await reopened.close();
  });

  test.each([
    {},
    {
      alreadyApplied: false,
      retainedCommits: 1,
      resetSubscriptions: 1,
      extra: 1,
    },
    { alreadyApplied: false, retainedCommits: -1, resetSubscriptions: 1 },
    { alreadyApplied: false, retainedCommits: 1.5, resetSubscriptions: 1 },
    {
      alreadyApplied: false,
      retainedCommits: Number.NaN,
      resetSubscriptions: 1,
    },
    { alreadyApplied: false, retainedCommits: '1', resetSubscriptions: 1 },
    {
      alreadyApplied: false,
      retainedCommits: Number.MAX_SAFE_INTEGER + 1,
      resetSubscriptions: 1,
    },
  ])('rejects a malformed rebootstrap bridge reply %#', async (value) => {
    const { nativeModule, eventEmitter } = makeNative((method, params) => {
      if (method === 'rebootstrapLocalData') return OK(value);
      return defaultResponder(method, params);
    });
    const client = await createNativeSyncClient({
      clientId: 'invalid-rebootstrap-result',
      schema: { version: 1, tables: [] },
      nativeModule,
      eventEmitter,
    });
    await expect(
      client.rebootstrapLocalData({ rebootstrapId: 'support-case-001' }),
    ).rejects.toMatchObject({ code: INVALID_HOST_RESPONSE_CODE });
  });

  test('accessor methods unwrap their command replies', async () => {
    const { client } = await build();
    expect(await client.syncNeeded()).toBe(true);
    expect(await client.upgrading()).toBe(false);
    expect(await client.conflicts()).toEqual([]);
    expect(await client.pendingCommits()).toEqual(['commit-1']);
    expect(await client.schemaFloor()).toBeUndefined();
  });

  test('an {error} reply throws a NativeSyncError with the code', async () => {
    const { nativeModule, eventEmitter } = makeNative((method) => {
      if (method === 'create') return OK({});
      return { error: { code: 'client.failed', message: 'boom' } };
    });
    const client = await createNativeSyncClient({
      clientId: 'c1',
      schema: {},
      nativeModule,
      eventEmitter,
    });
    await expect(client.conflicts()).rejects.toMatchObject({
      code: 'client.failed',
      message: 'boom',
    });
  });

  test('exact change batches fan out and derive legacy invalidations', async () => {
    const { client, emit } = await build();
    const changes: bigint[] = [];
    const seen: Array<{ tables: string[]; scopeKeys: string[] }> = [];
    client.onChange((batch) => changes.push(batch.revision));
    client.onInvalidate((event) => {
      seen.push({ tables: [...event.tables], scopeKeys: [...event.scopeKeys] });
    });
    emit({
      type: 'change',
      batch: {
        revision: '8',
        tables: [{ table: 'todo', scopeKeys: ['project:1'] }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    expect(changes).toEqual([8n]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toEqual(['todo']);
    expect(seen[0]?.scopeKeys).toEqual(['project:1']);
  });

  test('presence events fan out to onPresence listeners', async () => {
    const { client, emit } = await build();
    const scopeKeys: string[] = [];
    client.onPresence((key) => scopeKeys.push(key));
    emit({ type: 'presence', scopeKey: 'room:42' });
    expect(scopeKeys).toEqual(['room:42']);
  });

  test('diagnostics commands and events preserve evidence and mark the React Native host', async () => {
    const { client, calls, emit } = await build();
    const requested = await client.diagnosticsSnapshot({
      expectedSubscriptions: [{ id: 'membership', table: 'memberships' }],
    });
    expect(requested.host).toMatchObject({
      kind: 'react-native',
      role: 'single',
    });
    expect(
      (
        calls.findLast(
          (call) =>
            call.fn === 'command' &&
            (call.arg as { method?: string }).method === 'diagnosticsSnapshot',
        )?.arg as { params: unknown }
      ).params,
    ).toEqual({
      expectedSubscriptions: [{ id: 'membership', table: 'memberships' }],
    });

    const seen: string[] = [];
    client.onDiagnostics((snapshot) => seen.push(snapshot.host.kind));
    emit({ type: 'diagnostics', snapshot: DIAGNOSTICS });
    expect(seen).toEqual(['react-native']);
  });

  test('interactive sync intents coalesce into one immediate native round', async () => {
    const { client, calls, emit } = await build();
    emit({ type: 'sync-intent', intent: { kind: 'interactive' } });
    emit({ type: 'sync-intent', intent: { kind: 'interactive' } });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(
      calls.filter(
        (call) =>
          call.fn === 'command' &&
          (call.arg as { method: string }).method === 'syncUntilIdle',
      ),
    ).toHaveLength(1);
    await client.close();
  });

  test('pause stops the pump; resume restarts it', async () => {
    const { client, pump } = await build();
    expect(pump.started).toBe(1);
    await client.pause();
    expect(pump.stopped).toBe(1);
    await client.resume();
    expect(pump.started).toBe(2);
  });

  test('close stops the pump, detaches the listener, and closes the core', async () => {
    const { client, emit, pump } = await build();
    let count = 0;
    client.onChange(() => {
      count += 1;
    });
    await client.close();
    expect(pump.closed).toBe(1);
    emit({
      type: 'change',
      batch: {
        revision: '9',
        tables: [{ table: 'todo' }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    expect(count).toBe(0);
    // Idempotent.
    await client.close();
    expect(pump.closed).toBe(1);
  });
});

describe('SyncClientLike parity', () => {
  test('the bridge is accepted by normalizeClient and drives every member', async () => {
    const { client } = await build();
    // Compile-time proof: assigning to SyncClientLike fails to typecheck on any
    // missing/mismatched member. Runtime proof: every normalized accessor
    // resolves against the bridge.
    const like: SyncClientLike = client;
    const normalized = normalizeClient(like);

    expect(typeof normalized.onChange(() => {})).toBe('function');
    expect(typeof normalized.onInvalidate(() => {})).toBe('function');
    expect(typeof normalized.onPresence(() => {})).toBe('function');
    expect(typeof normalized.onDiagnostics(() => {})).toBe('function');

    expect(await normalized.query('SELECT 1')).toBeInstanceOf(Array);
    expect((await normalized.querySnapshot({ sql: 'SELECT 1' })).revision).toBe(
      7n,
    );
    expect(await normalized.mutate([])).toBe('commit-1');
    expect(await normalized.patch('todo', 't1', { done: true })).toBe(
      'commit-1',
    );
    expect(
      await normalized.purgeLocalData({
        purgeId: 'purge-parity',
        targets: [
          {
            table: 'patient_notes',
            selectors: { encryption_key_id: ['key-revoked'] },
          },
        ],
      }),
    ).toEqual({
      alreadyApplied: false,
      purgedRows: 2,
      droppedCommits: 1,
    });
    expect(await normalized.statusSnapshot()).toMatchObject({
      currentSchemaVersion: 1,
      outbox: 1,
    });
    expect(await normalized.diagnosticsSnapshot()).toMatchObject({
      version: 1,
      host: { kind: 'react-native' },
    });
    expect(await normalized.conflicts()).toEqual([]);
    expect(await normalized.rejections()).toEqual([]);
    expect(await normalized.commitOutcome('commit-1')).toMatchObject({
      status: 'applied',
    });
    expect(await normalized.commitOutcomes()).toEqual([]);
    expect(
      await normalized.resolveCommitOutcome({
        clientCommitId: 'commit-1',
        resolution: 'dismissed',
      }),
    ).toMatchObject({ resolution: 'dismissed' });
    expect(await normalized.schemaFloor()).toBeUndefined();
    expect(await normalized.leaseState()).toBeUndefined();
    expect(await normalized.upgrading()).toBe(false);
    expect(await normalized.syncNeeded()).toBe(true);
    expect(await normalized.pendingCommits()).toEqual(['commit-1']);
    expect(await normalized.presence('room:1')).toEqual([]);
    await normalized.setPresence('room:1', { hi: true });
  });
});
