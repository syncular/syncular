/**
 * Realtime session (SPEC.md §8): hello, subscription registration from
 * pulls, binary deltas, wake-ups, acks — transport-agnostic callbacks.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CommitFrame,
  decodeMessage,
  parseRealtimeServerEvent,
  type ScopeMap,
  type SubStartFrame,
} from '@syncular/core';
import {
  createRealtimeHub,
  type RealtimeHub,
  type StoredCommit,
} from '@syncular/server';
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
    segments: t.segments,
    resolveScopes: t.ctx.resolveScopes,
    ...(t.ctx.clock !== undefined ? { clock: t.ctx.clock } : {}),
    ...(maxDeltaBytes !== undefined ? { maxDeltaBytes } : {}),
  });
  // Wire the hub into the push path.
  Object.assign(t.ctx, { realtime: hub });
  return hub;
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
    const raw = wire.binaries[0] ?? new Uint8Array();
    // §8.7: standalone deltas carry channel tag 0x00 ahead of the SSP2
    // response message.
    expect(raw[0]).toBe(0x00);
    const delta = decodeMessage(raw.subarray(1));
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

  test('out-of-order commit notifications wake before sending a gap delta', async () => {
    const t = makeContext();
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const hub = makeHub(t);
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });
    expect(session.cursor).toBe(1);
    expect(session.lastKnownSeq).toBe(1);

    const captured: StoredCommit[] = [];
    Object.assign(t.ctx, {
      realtime: {
        notifyCommit: (_partition: string, commit: StoredCommit) => {
          captured.push(commit);
        },
      },
    });
    await sync(
      t,
      [pushCommit('c2', [upsert('tasks', 't2', taskRow('t2', 'p1'))])],
      { clientId: 'other-client' },
    );
    await sync(
      t,
      [pushCommit('c3', [upsert('tasks', 't3', taskRow('t3', 'p1'))])],
      { clientId: 'other-client' },
    );
    expect(captured.map((commit) => commit.commitSeq)).toEqual([2, 3]);

    await hub.notifyCommit('part-1', captured[1]!);
    await hub.notifyCommit('part-1', captured[0]!);

    expect(wire.binaries).toHaveLength(0);
    const wakes = wire.texts.slice(1).map((text) => {
      const parsed = parseRealtimeServerEvent(text);
      if (!parsed.known || parsed.event.event !== 'sync') {
        throw new Error('expected catch-up wake');
      }
      return parsed.event.data;
    });
    expect(wakes.map((wake) => wake.reason)).toEqual([
      'catchup-required',
      'catchup-required',
    ]);
    expect(wakes.map((wake) => wake.cursor)).toEqual([3, 3]);
    expect(session.cursor).toBe(1);
    expect(session.lastKnownSeq).toBe(3);
    expect(session.wakePending).toBe(true);
  });

  test('a catch-up ack advances the notification base before deltas resume', async () => {
    const t = makeContext();
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const hub = makeHub(t);
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });

    const captured: StoredCommit[] = [];
    Object.assign(t.ctx, {
      realtime: {
        notifyCommit: (_partition: string, commit: StoredCommit) => {
          captured.push(commit);
        },
      },
    });
    await sync(
      t,
      [pushCommit('c2', [upsert('tasks', 't2', taskRow('t2', 'p1'))])],
      { clientId: 'other-client' },
    );
    await sync(
      t,
      [pushCommit('c3', [upsert('tasks', 't3', taskRow('t3', 'p1'))])],
      { clientId: 'other-client' },
    );
    expect(captured.map((commit) => commit.commitSeq)).toEqual([2, 3]);

    // The shared client loop caught up through a pull on another binding.
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: 3 }));
    expect(session.lastKnownSeq).toBe(3);
    Object.assign(t.ctx, { realtime: hub });

    await sync(
      t,
      [pushCommit('c4', [upsert('tasks', 't4', taskRow('t4', 'p1'))])],
      { clientId: 'other-client' },
    );
    expect(wire.binaries).toHaveLength(1);
    expect(session.cursor).toBe(4);
    expect(session.lastKnownSeq).toBe(4);
  });

  test('duplicate and regressive notifications wake from an unsuppressed session', async () => {
    const t = makeContext();
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const hub = makeHub(t);
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: wire.send,
    });

    const captured: StoredCommit[] = [];
    Object.assign(t.ctx, {
      realtime: {
        notifyCommit: (_partition: string, commit: StoredCommit) => {
          captured.push(commit);
        },
      },
    });
    await sync(
      t,
      [pushCommit('c2', [upsert('tasks', 't2', taskRow('t2', 'p1'))])],
      { clientId: 'other-client' },
    );
    await sync(
      t,
      [pushCommit('c3', [upsert('tasks', 't3', taskRow('t3', 'p1'))])],
      { clientId: 'other-client' },
    );
    const second = captured[0]!;
    const third = captured[1]!;

    await hub.notifyCommit('part-1', second);
    expect(wire.binaries).toHaveLength(1);
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: 2 }));
    await hub.notifyCommit('part-1', second);
    expect(wire.binaries).toHaveLength(1);
    const duplicateWake = parseRealtimeServerEvent(wire.texts[1] ?? '');
    if (!duplicateWake.known || duplicateWake.event.event !== 'sync') {
      throw new Error('expected duplicate notification wake');
    }
    expect(duplicateWake.event.data.reason).toBe('catchup-required');
    expect(duplicateWake.event.data.cursor).toBe(2);
    expect(session.lastKnownSeq).toBe(2);
    expect(session.cursor).toBe(2);

    session.handleMessage(JSON.stringify({ type: 'ack', cursor: 2 }));
    await hub.notifyCommit('part-1', third);
    expect(wire.binaries).toHaveLength(2);
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: 3 }));
    await hub.notifyCommit('part-1', second);
    expect(wire.binaries).toHaveLength(2);
    const regressionWake = parseRealtimeServerEvent(wire.texts[2] ?? '');
    if (!regressionWake.known || regressionWake.event.event !== 'sync') {
      throw new Error('expected regressive notification wake');
    }
    expect(regressionWake.event.data.reason).toBe('catchup-required');
    expect(regressionWake.event.data.cursor).toBe(3);
    expect(session.lastKnownSeq).toBe(3);
    expect(session.cursor).toBe(3);
    expect(wire.texts).toHaveLength(3);
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

  test('acknowledgements persist the delivered cursor', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const { wire, session } = await connectedSession(t, hub);
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(wire.binaries).toHaveLength(1);
    const latest = await t.storage.getMaxCommitSeq('part-1');
    const advance = t.storage.advanceClientCursor.bind(t.storage);
    const pending: Promise<void>[] = [];
    t.storage.advanceClientCursor = (...args) => {
      const task = advance(...args);
      pending.push(task);
      return task;
    };
    session.handleMessage(JSON.stringify({ type: 'ack', cursor: latest }));
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(
      (await t.storage.getClientRecord('part-1', 'client-1'))?.cursor,
    ).toBe(latest);
  });

  test('delayed acknowledgements preserve newer subscription registration', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const { session } = await connectedSession(t, hub);
    const advance = t.storage.advanceClientCursor.bind(t.storage);
    const gate = Promise.withResolvers<void>();
    const pending: Promise<void>[] = [];
    t.storage.advanceClientCursor = (...args) => {
      const task = gate.promise.then(() => advance(...args));
      pending.push(task);
      return task;
    };
    try {
      session.handleMessage(JSON.stringify({ type: 'ack', cursor: 42 }));
      expect(pending).toHaveLength(1);
      const record = await t.storage.getClientRecord('part-1', 'client-1');
      if (!record) throw new Error('expected registered client');
      const updated = {
        ...record,
        cursor: 4,
        wireVersion: 2,
        subscriptions: [
          { id: 'new-sub', table: 'tasks', scopes: { project_id: ['p2'] } },
        ],
      };
      await t.storage.putClientRecord('part-1', updated);
      gate.resolve();
      await Promise.all(pending);
      expect(await t.storage.getClientRecord('part-1', 'client-1')).toEqual({
        ...updated,
        cursor: 42,
      });
    } finally {
      gate.resolve();
      await Promise.all(pending);
      session.close();
    }
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

describe('presence (§8.6)', () => {
  // Presence identity is (actorId, clientId); the test context binds every
  // client record to actor-1, so distinct clientIds are distinct peers.
  async function presentClient(
    t: TestContext,
    hub: RealtimeHub,
    clientId: string,
    scopes: ScopeMap = { project_id: ['p1'] },
  ) {
    await sync(t, [pullHeader(), subFrame('s1', 'tasks', scopes, -1)], {
      clientId,
    });
    const wire = makeWire();
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId,
      send: wire.send,
    });
    return { wire, session };
  }

  function lastPresence(wire: Wire): Record<string, unknown> | undefined {
    for (let i = wire.texts.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(wire.texts[i] ?? '{}') as {
        event?: string;
        data?: Record<string, unknown>;
      };
      if (parsed.event === 'presence') return parsed.data;
    }
    return undefined;
  }

  function presenceEvents(wire: Wire): Array<Record<string, unknown>> {
    return wire.texts
      .map(
        (t) =>
          JSON.parse(t) as { event?: string; data?: Record<string, unknown> },
      )
      .filter((m) => m.event === 'presence')
      .map((m) => m.data ?? {});
  }

  test('publish → join → update → leave fans out to a scope-mate', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const a = await presentClient(t, hub, 'client-a');
    const b = await presentClient(t, hub, 'client-b');

    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { cursor: 1 } },
      }),
    );
    let seen = lastPresence(b.wire);
    expect(seen?.kind).toBe('join');
    expect(seen?.actorId).toBe('actor-1');
    expect(seen?.clientId).toBe('client-a');
    expect(seen?.doc).toEqual({ cursor: 1 });

    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { cursor: 2 } },
      }),
    );
    seen = lastPresence(b.wire);
    expect(seen?.kind).toBe('update');
    expect(seen?.doc).toEqual({ cursor: 2 });

    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: null },
      }),
    );
    seen = lastPresence(b.wire);
    expect(seen?.kind).toBe('leave');
    expect(seen?.doc).toBe(null);
    // A publisher never receives its own fanout.
    expect(presenceEvents(a.wire)).toHaveLength(0);
  });

  test('disconnect implies leave to remaining peers (§8.6.1)', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const a = await presentClient(t, hub, 'client-a');
    const b = await presentClient(t, hub, 'client-b');
    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { x: 1 } },
      }),
    );
    expect(lastPresence(b.wire)?.kind).toBe('join');
    a.session.close();
    expect(lastPresence(b.wire)?.kind).toBe('leave');
  });

  test('a late joiner gets the snapshot join-burst (§8.6.4)', async () => {
    const t = makeContext();
    const hub = makeHub(t);
    const a = await presentClient(t, hub, 'client-a');
    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { who: 'a' } },
      }),
    );
    const c = await presentClient(t, hub, 'client-c');
    const snapshot = presenceEvents(c.wire);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.kind).toBe('join');
    expect(snapshot[0]?.clientId).toBe('client-a');
    expect(snapshot[0]?.doc).toEqual({ who: 'a' });
  });

  test('cross-scope isolation — no leakage to non-scope-mates (§8.6.3)', async () => {
    const t = makeContext();
    // The actor is allowed both scopes; the SUBSCRIPTIONS differ, so the
    // registrations (and thus presence grants) are disjoint by key.
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const hub = makeHub(t);
    const a = await presentClient(t, hub, 'client-a');
    // d holds a DIFFERENT scope key.
    const d = await presentClient(t, hub, 'client-d', { project_id: ['p2'] });
    const dWire = d.wire;
    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { x: 1 } },
      }),
    );
    expect(presenceEvents(dWire)).toHaveLength(0); // no leak to p2
    // d cannot publish onto p1 (unheld key) → presence.forbidden to d.
    d.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { evil: true } },
      }),
    );
    expect(lastPresence(dWire)?.error).toBe('presence.forbidden');
    expect(presenceEvents(a.wire)).toHaveLength(0); // a saw nothing from d
  });

  test('an over-cap document is rejected loudly to the publisher (§8.6.2)', async () => {
    const t = makeContext();
    const smallCapHub = createRealtimeHub({
      schema: t.ctx.schema,
      storage: t.ctx.storage,
      segments: t.segments,
      resolveScopes: t.ctx.resolveScopes,
      ...(t.ctx.clock !== undefined ? { clock: t.ctx.clock } : {}),
      maxPresenceBytes: 16,
    });
    Object.assign(t.ctx, { realtime: smallCapHub });
    const a = await presentClient(t, smallCapHub, 'client-a');
    const b = await presentClient(t, smallCapHub, 'client-b');
    a.session.handleMessage(
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'project:p1', doc: { big: 'x'.repeat(100) } },
      }),
    );
    expect(lastPresence(a.wire)?.error).toBe('presence.too_large');
    expect(presenceEvents(b.wire)).toHaveLength(0); // never fanned out
  });
});
