/**
 * Bridge unit tests with injected invoke/listen doubles: assert the
 * `SyncClientLike` contract — method → command mapping, the query fast path,
 * exact change fanout, presence, and lossless parameter envelopes.
 * Plus a shape-parity test against the React `normalizeClient`, so a drift in
 * `SyncClientLike` breaks this suite (the bridge is the fourth host of that
 * one interface).
 */
import { describe, expect, test } from 'bun:test';
import {
  INVALID_HOST_RESPONSE_CODE,
  installRealtimeSupervisor,
  realtimeSupervisorSnapshot,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
} from '@syncular/client';
import { normalizeClient, type SyncClientLike } from '@syncular/react';
import { hostBoolean } from '../../typegen/test/fixtures/basic/syncular.queries';
import { createTauriSyncClient, type TauriApi } from '../src/index';

/** A recording invoke/listen double. Commands answer from a scripted table. */
function makeTauri(
  responder: (cmd: string, args: Record<string, unknown>) => unknown,
): {
  tauri: TauriApi;
  calls: Array<{ cmd: string; args: Record<string, unknown> }>;
  emit: (payload: unknown) => void;
} {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const handlers = new Set<(event: { payload: unknown }) => void>();
  const tauri: TauriApi = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      return responder(cmd, args ?? {}) as T;
    },
    listen: async <T>(
      _event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      handlers.add(handler as (event: { payload: unknown }) => void);
      return () =>
        handlers.delete(handler as (event: { payload: unknown }) => void);
    },
  };
  const emit = (payload: unknown) => {
    for (const h of handlers) h({ payload });
  };
  return { tauri, calls, emit };
}

const OK = (result: unknown) => ({ result });

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

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

/** A responder that answers create + the accessor commands with fixtures. */
function defaultResponder(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === 'plugin:syncular|syncular_query') {
    if (String(args.sql).includes('SELECT id, done FROM tasks')) {
      return OK({ rows: [{ id: 't1', done: 0 }] });
    }
    return OK({
      rows: [{ id: 't1', title: 'hello', blob: { $bytes: 'deadbeef' } }],
    });
  }
  if (cmd === 'plugin:syncular|syncular_query_snapshot') {
    return OK({
      revision: '7',
      rows: [],
      coverage: { complete: true, pending: [], missing: [] },
    });
  }
  const command = args.command as
    | { method: string; params: Record<string, unknown> }
    | undefined;
  const method = command?.method;
  switch (method) {
    case 'create':
      return OK({});
    case 'mutate':
      return OK({ clientCommitId: 'commit-1' });
    case 'patch':
      return OK({ clientCommitId: 'patch-1' });
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
    case 'querySnapshot':
      return OK({
        revision: '7',
        rows: [],
        coverage: { complete: true, pending: [], missing: [] },
      });
    case 'localRevision':
      return OK({ revision: '7' });
    case 'statusSnapshot':
      return OK({
        currentSchemaVersion: 1,
        outbox: 0,
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
    case 'setPresence':
    case 'subscribe':
    case 'unsubscribe':
      return OK({});
    default:
      return OK({});
  }
}

async function build() {
  const { tauri, calls, emit } = makeTauri(defaultResponder);
  const client = await createTauriSyncClient({
    clientId: 'c1',
    schema: { version: 1, tables: [] },
    tauri,
  });
  return { client, calls, emit };
}

describe('createTauriSyncClient', () => {
  test('issues create through syncular_command on construction', async () => {
    const { calls } = await build();
    const create = calls.find(
      (c) =>
        c.cmd === 'plugin:syncular|syncular_command' &&
        (c.args.command as { method: string }).method === 'create',
    );
    expect(create).toBeDefined();
    expect(
      (create?.args.command as { params: { clientId: string } }).params
        .clientId,
    ).toBe('c1');
  });

  test('forwards portable encryption keys and row key-id columns on create', async () => {
    const { tauri, calls } = makeTauri(defaultResponder);
    await createTauriSyncClient({
      schema: { version: 1, tables: [] },
      encryption: {
        keys: { 'practice-key-v1': new Uint8Array(32).fill(0x2a) },
        keyIdColumns: { patients: 'encryption_key_id' },
      },
      tauri,
    });
    const create = calls.find(
      (call) =>
        call.cmd === 'plugin:syncular|syncular_command' &&
        (call.args.command as { method: string }).method === 'create',
    );
    expect(
      (
        create?.args.command as {
          params: {
            encryption: {
              keys: Record<string, unknown>;
              keyIdColumns: Record<string, string>;
            };
          };
        }
      ).params.encryption,
    ).toEqual({
      keys: {
        'practice-key-v1': {
          $bytes: '2a'.repeat(32),
        },
      },
      keyIdColumns: { patients: 'encryption_key_id' },
    });
  });

  test('preflight blocks fast reads, permits purge, and installs keys only on activation', async () => {
    const { tauri, calls } = makeTauri(defaultResponder);
    const client = await createTauriSyncClient({
      schema: { version: 1, tables: [] },
      securityPreflight: true,
      tauri,
    });

    expect(await client.securityLifecycle()).toBe('preflight');
    await expect(client.query('SELECT 1')).rejects.toMatchObject({
      code: SECURITY_PREFLIGHT_REQUIRED_CODE,
    });
    expect(calls.some((call) => call.cmd.endsWith('syncular_query'))).toBe(
      false,
    );
    await expect(
      client.setHeaders({ authorization: 'Bearer must-not-enter-native' }),
    ).rejects.toMatchObject({
      code: SECURITY_PREFLIGHT_REQUIRED_CODE,
    });
    expect(
      calls.some((call) => call.cmd.endsWith('syncular_set_headers')),
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
        keys: { 'practice-v2': new Uint8Array(32).fill(0x5a) },
        keyIdColumns: { patients: 'encryption_key_id' },
      },
    });
    expect(await client.securityLifecycle()).toBe('active');
    expect(await client.query('SELECT 1')).toBeInstanceOf(Array);
    const activation = calls.find(
      (call) =>
        call.cmd.endsWith('syncular_command') &&
        (call.args.command as { method?: string }).method ===
          'activateSecurity',
    );
    expect(
      (
        activation?.args.command as {
          params: { encryption: { keys: Record<string, unknown> } };
        }
      ).params.encryption.keys['practice-v2'],
    ).toEqual({ $bytes: '5a'.repeat(32) });

    const barrier = client.beginSecurityPreflight();
    await expect(client.query('SELECT 1')).rejects.toMatchObject({
      code: SECURITY_PREFLIGHT_REQUIRED_CODE,
    });
    await barrier;
    await client.close();
  });

  test('query uses the syncular_query fast path and decodes bytes', async () => {
    const { client, calls } = await build();
    const rows = await client.query('SELECT * FROM todo WHERE id = ?', ['t1']);
    const q = calls.find((c) => c.cmd === 'plugin:syncular|syncular_query');
    expect(q).toBeDefined();
    expect(q?.args.sql).toBe('SELECT * FROM todo WHERE id = ?');
    expect(q?.args.params).toEqual(['t1']);
    expect(rows).toHaveLength(1);
    // The {$bytes: hex} envelope decodes to a Uint8Array.
    expect(rows[0]?.blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[0]?.blob as Uint8Array)).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(rows[0]?.title).toBe('hello');
  });

  test('generated query decodes SQLite booleans on the Tauri surface', async () => {
    const { client } = await build();
    expect(await hostBoolean(client, { projectId: 'p1' })).toEqual([
      { id: 't1', done: false },
    ]);
  });

  test('query encodes Uint8Array params as {$bytes: hex}', async () => {
    const { client, calls } = await build();
    await client.query('SELECT ?', [new Uint8Array([1, 255])]);
    const q = calls.findLast((c) => c.cmd === 'plugin:syncular|syncular_query');
    expect((q?.args.params as unknown[])[0]).toEqual({ $bytes: '01ff' });
  });

  test('query round-trips bigint params and unsafe SQLite integers losslessly', async () => {
    const { tauri, calls } = makeTauri((cmd, args) => {
      if (cmd === 'plugin:syncular|syncular_query') {
        return OK({ rows: [{ value: { $bigint: '9007199254740993' } }] });
      }
      return defaultResponder(cmd, args);
    });
    const client = await createTauriSyncClient({
      schema: { version: 1, tables: [] },
      tauri,
    });
    const rows = await client.query('SELECT ?', [9_007_199_254_740_993n]);
    const query = calls.findLast(
      (call) => call.cmd === 'plugin:syncular|syncular_query',
    );
    expect(query?.args.params).toEqual([{ $bigint: '9007199254740993' }]);
    expect(rows).toEqual([{ value: 9_007_199_254_740_993n }]);
  });

  test('querySnapshot is one IPC read for rows, coverage, and exact revision', async () => {
    const { tauri, calls } = makeTauri((cmd, args) => {
      if (cmd === 'plugin:syncular|syncular_query_snapshot') {
        return OK({
          revision: '42',
          rows: [{ id: 't1', payload: { $bytes: '0102' } }],
          coverage: { complete: true, pending: [], missing: [] },
        });
      }
      return defaultResponder(cmd, args);
    });
    const client = await createTauriSyncClient({ schema: {}, tauri });
    const snapshot = await client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE list_id = ?',
      params: ['a'],
      coverage: [
        {
          base: { table: 'tasks', variable: 'list_id' },
          units: ['a'],
        },
      ],
    });
    expect(snapshot.revision).toBe(42n);
    expect(snapshot.coverage.complete).toBe(true);
    expect(snapshot.rows[0]?.payload).toEqual(new Uint8Array([1, 2]));
    const callsForSnapshot = calls.filter(
      (call) => call.cmd === 'plugin:syncular|syncular_query_snapshot',
    );
    expect(callsForSnapshot).toHaveLength(1);
    expect(callsForSnapshot[0]?.args).toEqual({
      sql: 'SELECT * FROM tasks WHERE list_id = ?',
      params: ['a'],
      coverage: [
        {
          base: { table: 'tasks', variable: 'list_id' },
          units: ['a'],
        },
      ],
    });
  });

  test('mutate returns the clientCommitId', async () => {
    const { client } = await build();
    const id = await client.mutate([
      { op: 'upsert', table: 'todo', values: { id: 't1', title: 'x' } },
    ]);
    expect(id).toBe('commit-1');
  });

  test('purgeLocalData forwards the exact bounded plan over the command bridge', async () => {
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
    const call = calls.findLast(
      (candidate) =>
        (
          candidate.args.command as
            | { method?: string; params?: unknown }
            | undefined
        )?.method === 'purgeLocalData',
    );
    expect(call?.args.command).toEqual({
      method: 'purgeLocalData',
      params: { input },
    });
  });

  test('rebootstrapLocalData forwards the exact idempotency key over the command bridge', async () => {
    const { client, calls } = await build();
    const input = { rebootstrapId: 'support-case-001' } as const;
    expect(await client.rebootstrapLocalData(input)).toEqual({
      alreadyApplied: false,
      retainedCommits: 3,
      resetSubscriptions: 4,
    });
    const call = calls.findLast(
      (candidate) =>
        (
          candidate.args.command as
            | { method?: string; params?: unknown }
            | undefined
        )?.method === 'rebootstrapLocalData',
    );
    expect(call?.args.command).toEqual({
      method: 'rebootstrapLocalData',
      params: { input },
    });
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
  ])('rejects a malformed rebootstrap command reply %#', async (value) => {
    const { tauri } = makeTauri((cmd, args) => {
      const method = (args.command as { readonly method?: string } | undefined)
        ?.method;
      if (method === 'rebootstrapLocalData') return OK(value);
      return defaultResponder(cmd, args);
    });
    const client = await createTauriSyncClient({
      clientId: 'invalid-rebootstrap-result',
      schema: { version: 1, tables: [] },
      tauri,
    });
    await expect(
      client.rebootstrapLocalData({ rebootstrapId: 'support-case-001' }),
    ).rejects.toMatchObject({ code: INVALID_HOST_RESPONSE_CODE });
  });

  test('query strips reserved _sync_* columns (RFC 0002 §2.1)', async () => {
    const { tauri } = makeTauri((cmd, args) => {
      if (cmd === 'plugin:syncular|syncular_query') {
        return OK({
          rows: [{ id: 't1', title: 'hello', _sync_version: 3 }],
        });
      }
      return defaultResponder(cmd, args);
    });
    const client = await createTauriSyncClient({
      clientId: 'c1',
      schema: { version: 1, tables: [] },
      tauri,
    });
    const rows = await client.query('SELECT * FROM todo');
    expect(rows).toEqual([{ id: 't1', title: 'hello' }]);
  });

  test('setHeaders posts the full set to syncular_set_headers (RFC 0002 §2.3)', async () => {
    const { client, calls } = await build();
    await client.setHeaders({ authorization: 'Bearer fresh' });
    const call = calls.find(
      (c) => c.cmd === 'plugin:syncular|syncular_set_headers',
    );
    expect(call?.args.headers).toEqual({ authorization: 'Bearer fresh' });
  });

  test('accessor methods unwrap their command replies', async () => {
    const { client } = await build();
    expect(await client.syncNeeded()).toBe(true);
    expect(await client.upgrading()).toBe(false);
    expect(await client.conflicts()).toEqual([]);
    expect(await client.commitOutcome('commit-1')).toMatchObject({
      status: 'applied',
    });
    expect(await client.commitOutcomes({ activeOnly: true })).toEqual([]);
    expect(
      await client.resolveCommitOutcome({
        clientCommitId: 'commit-1',
        resolution: 'dismissed',
      }),
    ).toMatchObject({ resolution: 'dismissed' });
    expect(await client.pendingCommits()).toEqual(['commit-1']);
    expect(await client.schemaFloor()).toBeUndefined();
  });

  test('an {error} reply throws a TauriSyncError with the code', async () => {
    const { tauri } = makeTauri((_cmd, args) => {
      const method = (args.command as { method: string } | undefined)?.method;
      if (method === 'create') return OK({});
      return { error: { code: 'client.failed', message: 'boom' } };
    });
    const client = await createTauriSyncClient({
      clientId: 'c1',
      schema: {},
      tauri,
    });
    await expect(client.conflicts()).rejects.toMatchObject({
      code: 'client.failed',
      message: 'boom',
    });
  });

  test('change batches fan out exactly and derive legacy invalidations', async () => {
    const { client, emit } = await build();
    const revisions: bigint[] = [];
    const seen: Array<{ tables: string[]; scopeKeys: string[] }> = [];
    client.onChange((batch) => revisions.push(batch.revision));
    client.onInvalidate((event) => {
      seen.push({
        tables: [...event.tables],
        scopeKeys: [...event.scopeKeys],
      });
    });
    emit({
      type: 'change',
      batch: {
        revision: '9',
        tables: [{ table: 'todo', scopeKeys: ['project:1'] }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    expect(revisions).toEqual([9n]);
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

  test('diagnostics commands and events preserve evidence and mark the Tauri host', async () => {
    const { client, calls, emit } = await build();
    const requested = await client.diagnosticsSnapshot({
      expectedSubscriptions: [{ id: 'membership', table: 'memberships' }],
    });
    expect(requested.host).toMatchObject({ kind: 'tauri', role: 'single' });
    expect(
      (
        calls.findLast(
          (call) =>
            (call.args.command as { method?: string } | undefined)?.method ===
            'diagnosticsSnapshot',
        )?.args.command as { params: unknown }
      ).params,
    ).toEqual({
      expectedSubscriptions: [{ id: 'membership', table: 'memberships' }],
    });

    const seen: string[] = [];
    client.onDiagnostics((snapshot) => seen.push(snapshot.host.kind));
    emit({ type: 'diagnostics', snapshot: DIAGNOSTICS });
    expect(seen).toEqual(['tauri']);
  });

  test('shared realtime supervisor reconnects and disposes through the Tauri bridge', async () => {
    const { client: rawClient, calls, emit } = await build();
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const client = installRealtimeSupervisor(rawClient, {
      schedule: (callback) => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      random: () => 0,
    });
    await settle();
    expect(realtimeSupervisorSnapshot(client)).toEqual({
      phase: 'connected',
      attempt: 0,
    });

    emit({
      type: 'diagnostics',
      snapshot: {
        ...DIAGNOSTICS,
        host: { ...DIAGNOSTICS.host, realtime: 'disconnected' },
      },
    });
    const retry = timers.find((timer) => !timer.cancelled);
    expect(retry).toBeDefined();
    retry?.callback();
    await settle();
    const methods = calls
      .map(
        (call) =>
          (call.args.command as { method?: string } | undefined)?.method,
      )
      .filter((method): method is string => method !== undefined);
    expect(methods).toContain('connectRealtime');
    expect(methods.filter((method) => method === 'syncUntilIdle').length).toBe(
      2,
    );

    await client.close();
    const closedMethods = calls
      .map(
        (call) =>
          (call.args.command as { method?: string } | undefined)?.method,
      )
      .filter((method): method is string => method !== undefined);
    expect(closedMethods.indexOf('disconnectRealtime')).toBeLessThan(
      closedMethods.indexOf('shutdown'),
    );
  });

  test('unsubscribing a listener stops delivery', async () => {
    const { client, emit } = await build();
    let count = 0;
    const off = client.onInvalidate(() => {
      count += 1;
    });
    emit({
      type: 'change',
      batch: {
        revision: '1',
        tables: [{ table: 'todo' }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    off();
    emit({
      type: 'change',
      batch: {
        revision: '2',
        tables: [{ table: 'todo' }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    expect(count).toBe(1);
  });

  test('close shuts down the native core and detaches the event listener', async () => {
    const { client, emit, calls } = await build();
    let count = 0;
    client.onInvalidate(() => {
      count += 1;
    });
    await client.close();
    expect(
      calls.some(
        (call) =>
          call.cmd.endsWith('syncular_command') &&
          (call.args.command as { method?: string }).method === 'shutdown',
      ),
    ).toBe(true);
    emit({
      type: 'change',
      batch: {
        revision: '1',
        tables: [{ table: 'todo' }],
        windows: [],
        conflictsChanged: false,
        rejectionsChanged: false,
      },
    });
    expect(count).toBe(0);
  });
});

describe('SyncClientLike parity', () => {
  test('the bridge is accepted by normalizeClient and drives every member', async () => {
    const { client } = await build();
    // The compile-time proof: assigning to SyncClientLike would fail to
    // typecheck on any missing/mismatched member. The runtime proof: every
    // normalized accessor resolves against the bridge.
    const like: SyncClientLike = client;
    const normalized = normalizeClient(like);

    // onInvalidate / onPresence return unsubscribe fns.
    expect(typeof normalized.onInvalidate(() => {})).toBe('function');
    expect(typeof normalized.onPresence(() => {})).toBe('function');
    expect(typeof normalized.onDiagnostics(() => {})).toBe('function');

    // Every async accessor resolves (the hooks call exactly these).
    expect(await normalized.query('SELECT 1')).toBeInstanceOf(Array);
    expect((await normalized.querySnapshot({ sql: 'SELECT 1' })).revision).toBe(
      7n,
    );
    expect(await normalized.statusSnapshot()).toMatchObject({
      currentSchemaVersion: 1,
      outbox: 0,
    });
    expect(await normalized.diagnosticsSnapshot()).toMatchObject({
      version: 1,
      host: { kind: 'tauri' },
    });
    expect(await normalized.mutate([])).toBe('commit-1');
    expect(await normalized.patch('todo', 't1', { title: 'next' })).toBe(
      'patch-1',
    );
    expect(
      await normalized.purgeLocalData({
        purgeId: 'purge-001',
        targets: [
          {
            table: 'todo',
            selectors: { project_id: ['project-1'] },
          },
        ],
      }),
    ).toEqual({
      alreadyApplied: false,
      purgedRows: 2,
      droppedCommits: 1,
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
