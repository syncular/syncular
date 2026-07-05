/**
 * Bridge unit tests with an injected NativeModule + event-emitter double:
 * assert the `SyncClientLike` contract — method → command mapping, the query
 * fast path, event fanout to onInvalidate/onPresence, the `{$bytes:hex}`
 * convention, and lifecycle (pause/resume/close driving the native pump). Plus
 * a shape-parity test against the React `normalizeClient`, so a drift in
 * `SyncClientLike` breaks this suite (the bridge is the fifth host of that one
 * interface, after direct / worker / follower / Tauri).
 *
 * No device, no RN runtime — the native module is injected, exactly the
 * hermetic pattern the roadmap sets for the RN JS bridge.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeClient, type SyncClientLike } from '@syncular/react';
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

/** A responder answering create + the accessor commands with fixtures. */
function defaultResponder(
  method: string,
  _params: Record<string, unknown>,
): unknown {
  switch (method) {
    case 'query':
      return OK({
        rows: [{ id: 't1', title: 'hello', blob: { $bytes: 'deadbeef' } }],
      });
    case 'create':
      return OK({});
    case 'mutate':
      return OK({ clientCommitId: 'commit-1' });
    case 'conflicts':
      return OK({ conflicts: [] });
    case 'rejections':
      return OK({ rejections: [] });
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

  test('query encodes Uint8Array params as {$bytes:hex}', async () => {
    const { client, calls } = await build();
    await client.query('SELECT ?', [new Uint8Array([1, 255])]);
    const q = calls.findLast((c) => c.fn === 'query');
    expect((q?.arg as { params: unknown[] }).params[0]).toEqual({
      $bytes: '01ff',
    });
  });

  test('mutate returns the clientCommitId', async () => {
    const { client } = await build();
    const id = await client.mutate([
      { op: 'upsert', table: 'todo', values: { id: 't1', title: 'x' } },
    ]);
    expect(id).toBe('commit-1');
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

  test('invalidate events fan out to onInvalidate listeners', async () => {
    const { client, emit } = await build();
    const seen: Array<{ tables: string[]; scopeKeys: string[] }> = [];
    client.onInvalidate((event) => {
      seen.push({ tables: [...event.tables], scopeKeys: [...event.scopeKeys] });
    });
    emit({ type: 'invalidate', tables: ['todo'], scopeKeys: ['project:1'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toEqual(['todo']);
    expect(seen[0]?.scopeKeys).toEqual(['project:1']);
    emit({ type: 'invalidate' });
    expect(seen[1]?.tables).toEqual([]);
  });

  test('presence events fan out to onPresence listeners', async () => {
    const { client, emit } = await build();
    const scopeKeys: string[] = [];
    client.onPresence((key) => scopeKeys.push(key));
    emit({ type: 'presence', scopeKey: 'room:42' });
    expect(scopeKeys).toEqual(['room:42']);
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
    client.onInvalidate(() => {
      count += 1;
    });
    await client.close();
    expect(pump.closed).toBe(1);
    emit({ type: 'invalidate', tables: ['todo'] });
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

    expect(typeof normalized.onInvalidate(() => {})).toBe('function');
    expect(typeof normalized.onPresence(() => {})).toBe('function');

    expect(await normalized.query('SELECT 1')).toBeInstanceOf(Array);
    expect(await normalized.mutate([])).toBe('commit-1');
    expect(await normalized.conflicts()).toEqual([]);
    expect(await normalized.rejections()).toEqual([]);
    expect(await normalized.schemaFloor()).toBeUndefined();
    expect(await normalized.leaseState()).toBeUndefined();
    expect(await normalized.upgrading()).toBe(false);
    expect(await normalized.syncNeeded()).toBe(true);
    expect(await normalized.pendingCommits()).toEqual(['commit-1']);
    expect(await normalized.presence('room:1')).toEqual([]);
    await normalized.setPresence('room:1', { hi: true });
  });
});
