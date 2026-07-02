/**
 * Realtime session (SPEC.md §8): hello, subscription registration from
 * pulls, binary deltas, wake-ups, acks — transport-agnostic callbacks.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CommitFrame,
  decodeMessage,
  parseRealtimeServerEvent,
  type SubStartFrame,
} from '@syncular-v2/core';
import { createRealtimeHub, type RealtimeHub } from '@syncular-v2/server';
import {
  makeContext,
  pullHeader,
  pushCommit,
  subFrame,
  sync,
  type TestContext,
  taskRow,
  upsert,
} from './helpers';

interface Wire {
  texts: string[];
  binaries: Uint8Array[];
  send: (data: string | Uint8Array) => void;
}

function makeWire(): Wire {
  const texts: string[] = [];
  const binaries: Uint8Array[] = [];
  return {
    texts,
    binaries,
    send: (data) => {
      if (typeof data === 'string') texts.push(data);
      else binaries.push(data);
    },
  };
}

function makeHub(t: TestContext, maxDeltaBytes?: number): RealtimeHub {
  const hub = createRealtimeHub({
    schema: t.ctx.schema,
    storage: t.ctx.storage,
    resolveScopes: t.ctx.resolveScopes,
    ...(t.ctx.clock !== undefined ? { clock: t.ctx.clock } : {}),
    ...(maxDeltaBytes !== undefined ? { maxDeltaBytes } : {}),
  });
  // Wire the hub into the push path.
  Object.assign(t.ctx, { realtime: hub });
  return hub;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('handshake (§8.1)', () => {
  test('a client that never pulled gets hello with requiresSync and no deltas', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const wire = makeWire();
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'fresh-client',
      send: wire.send,
    });
    const hello = parseRealtimeServerEvent(wire.texts[0] ?? '');
    if (!hello.known || hello.event.event !== 'hello') {
      throw new Error('expected hello');
    }
    expect(hello.event.data.requiresSync).toBe(true);
    expect(hello.event.data.cursor).toBe(-1);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(wire.binaries).toHaveLength(0); // no registered subscriptions
  });

  test('a caught-up client gets requiresSync false', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const wire = makeWire();
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    const hello = parseRealtimeServerEvent(wire.texts[0] ?? '');
    if (!hello.known || hello.event.event !== 'hello') {
      throw new Error('expected hello');
    }
    expect(hello.event.data.requiresSync).toBe(false);
    expect(hello.event.data.cursor).toBe(hello.event.data.latestCursor);
  });

  test('a clientId bound to another actor cannot connect (§1.5)', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const wire = makeWire();
    await expect(
      hub.connect({
        partition: 'part-1',
        actorId: 'actor-2',
        clientId: 'client-1',
        send: wire.send,
      }),
    ).rejects.toMatchObject({ code: 'sync.invalid_client_id' });
  });
});

describe('delta delivery (§8.2)', () => {
  async function connectedSession(t: TestContext, hub: RealtimeHub) {
    // Register subscriptions via a pull, then connect.
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    return { wire, session };
  }

  test('a matching commit is pushed as a complete SSP2 response', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const { wire } = await connectedSession(t, hub);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1', 'live'))]),
    ]);
    expect(wire.binaries).toHaveLength(1);
    const delta = decodeMessage(wire.binaries[0] ?? new Uint8Array());
    expect(delta.msgKind).toBe('response');
    const start = delta.frames.find(
      (f): f is SubStartFrame => f.type === 'SUB_START',
    );
    expect(start?.id).toBe('s1');
    expect(start?.status).toBe('active');
    const commit = delta.frames.find(
      (f): f is CommitFrame => f.type === 'COMMIT',
    );
    expect(commit?.changes[0]?.rowId).toBe('t1');
    const end = delta.frames.find((f) => f.type === 'SUB_END');
    expect(end?.type === 'SUB_END' && end.nextCursor).toBe(
      commit?.commitSeq ?? -1,
    );
  });

  test('a commit outside the registered scopes produces nothing', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const hub = makeHub(t);
    const { wire } = await connectedSession(t, hub);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 'tx', taskRow('tx', 'p2'))]),
    ]);
    expect(wire.binaries).toHaveLength(0);
    expect(wire.texts).toHaveLength(1); // hello only
  });

  test('an oversized delta degrades to a delta-too-large wake-up (§8.3)', async () => {
    const t = makeContext();
    const hub = makeHub(t, 64); // tiny delta budget
    const { wire } = await connectedSession(t, hub);
    await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'x'.repeat(500))),
      ]),
    ]);
    expect(wire.binaries).toHaveLength(0);
    const wake = parseRealtimeServerEvent(wire.texts[1] ?? '');
    if (!wake.known || wake.event.event !== 'sync')
      throw new Error('expected wake');
    expect(wake.event.data.reason).toBe('delta-too-large');
    expect(wake.event.data.requiresPull).toBe(true);
  });

  test('a behind client gets catchup-required wake-ups, never gap deltas; acks resume deltas', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    // Advance the log while the client is offline.
    await sync(
      t,
      [pushCommit('c1', [upsert('tasks', 'ta', taskRow('ta', 'p1'))])],
      { clientId: 'other-client' },
    );
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    // A new matching commit while behind → wake, not delta (§8.2 contiguity).
    await sync(
      t,
      [pushCommit('c2', [upsert('tasks', 'tb', taskRow('tb', 'p1'))])],
      { clientId: 'other-client' },
    );
    expect(wire.binaries).toHaveLength(0);
    const wake = parseRealtimeServerEvent(wire.texts[1] ?? '');
    if (!wake.known || wake.event.event !== 'sync')
      throw new Error('expected wake');
    expect(wake.event.data.reason).toBe('catchup-required');
    // The client pulls + acks the latest cursor; deltas resume.
    const latest = await t.storage.getMaxCommitSeq('part-1');
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: latest }));
    await sync(
      t,
      [pushCommit('c3', [upsert('tasks', 'tc', taskRow('tc', 'p1'))])],
      { clientId: 'other-client' },
    );
    expect(wire.binaries).toHaveLength(1);
  });

  test('acks update the client cursor record without an HTTP pull (§8.2)', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const { wire, session } = await connectedSession(t, hub);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(wire.binaries).toHaveLength(1);
    const latest = await t.storage.getMaxCommitSeq('part-1');
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: latest }));
    await waitFor(async () => {
      const record = await t.storage.getClientRecord('part-1', 'client-1');
      return record?.cursor === latest;
    });
  });

  test('closed sessions receive nothing', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const { wire, session } = await connectedSession(t, hub);
    session.close();
    expect(hub.sessionCount).toBe(0);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(wire.binaries).toHaveLength(0);
  });
});

describe('control plane (§8.3, §8.5)', () => {
  test('hub.wake broadcasts a reset-required wake-up', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const wire = makeWire();
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    hub.wake('part-1', 'reset-required');
    const wake = parseRealtimeServerEvent(wire.texts[1] ?? '');
    if (!wake.known || wake.event.event !== 'sync')
      throw new Error('expected wake');
    expect(wake.event.data.reason).toBe('reset-required');
  });

  test('heartbeats parse as §8.5 events; garbage inbound is tolerated', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    session.sendHeartbeat();
    const beat = parseRealtimeServerEvent(wire.texts[1] ?? '');
    if (!beat.known) throw new Error('expected heartbeat');
    expect(beat.event.event).toBe('heartbeat');
    session.handleMessage('not json at all'); // must not throw
    session.handleMessage('{"type":"presence"}'); // unknown → ignored
  });
});
