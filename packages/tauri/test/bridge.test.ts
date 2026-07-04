/**
 * Bridge unit tests with injected invoke/listen doubles: assert the
 * `SyncClientLike` contract — method → command mapping, the query fast path,
 * event fanout to onInvalidate/onPresence, and the `{$bytes: hex}` convention.
 * Plus a shape-parity test against the React `normalizeClient`, so a drift in
 * `SyncClientLike` breaks this suite (the bridge is the fourth host of that
 * one interface).
 */
import { describe, expect, test } from 'bun:test';
import { normalizeClient, type SyncClientLike } from '@syncular-v2/react';
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

/** A responder that answers create + the accessor commands with fixtures. */
function defaultResponder(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === 'plugin:syncular|syncular_query') {
    return OK({
      rows: [{ id: 't1', title: 'hello', blob: { $bytes: 'deadbeef' } }],
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

  test('query encodes Uint8Array params as {$bytes: hex}', async () => {
    const { client, calls } = await build();
    await client.query('SELECT ?', [new Uint8Array([1, 255])]);
    const q = calls.findLast((c) => c.cmd === 'plugin:syncular|syncular_query');
    expect((q?.args.params as unknown[])[0]).toEqual({ $bytes: '01ff' });
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

  test('invalidate events fan out to onInvalidate listeners', async () => {
    const { client, emit } = await build();
    const seen: Array<{ tables: string[]; scopeKeys: string[] }> = [];
    client.onInvalidate((event) => {
      seen.push({
        tables: [...event.tables],
        scopeKeys: [...event.scopeKeys],
      });
    });
    emit({ type: 'invalidate', tables: ['todo'], scopeKeys: ['project:1'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toEqual(['todo']);
    expect(seen[0]?.scopeKeys).toEqual(['project:1']);
    // A bare invalidate (no keys) yields empty sets, not a crash.
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

  test('unsubscribing a listener stops delivery', async () => {
    const { client, emit } = await build();
    let count = 0;
    const off = client.onInvalidate(() => {
      count += 1;
    });
    emit({ type: 'invalidate', tables: ['todo'] });
    off();
    emit({ type: 'invalidate', tables: ['todo'] });
    expect(count).toBe(1);
  });

  test('close detaches the event listener', async () => {
    const { client, emit } = await build();
    let count = 0;
    client.onInvalidate(() => {
      count += 1;
    });
    await client.close();
    emit({ type: 'invalidate', tables: ['todo'] });
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

    // Every async accessor resolves (the hooks call exactly these).
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
