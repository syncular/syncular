import { describe, expect, test } from 'bun:test';
import type {
  ClientDiagnosticsListener,
  ClientDiagnosticsSnapshot,
  RealtimeSupervisorClient,
  RealtimeSupervisorLifecycleState,
  RealtimeSupervisorProtectionState,
  RealtimeSupervisorSignal,
} from '@syncular/client';
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
  RealtimeSupervisor,
  RealtimeSupervisorError,
  realtimeSupervisorSnapshot,
} from '@syncular/client';
import {
  makeClient,
  makeServer,
  PARTITION,
  tableRows,
  taskValues,
  waitFor,
} from './helpers';

function signal<State>(initial: State) {
  let state = initial;
  const listeners = new Set<(value: State) => void>();
  return {
    port: {
      current: () => state,
      subscribe(listener: (value: State) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies RealtimeSupervisorSignal<State>,
    emit(value: State) {
      state = value;
      for (const listener of listeners) listener(value);
    },
  };
}

function scheduler() {
  const tasks: { callback: () => void; delayMs: number; cancelled: boolean }[] =
    [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (!task) throw new Error('No scheduled task');
      task.cancelled = true;
      task.callback();
      return task.delayMs;
    },
    pending() {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    target: {
      addEventListener(type: string, listener: () => void) {
        const bucket = listeners.get(type) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

function diagnostics(
  realtime: 'connected' | 'disconnected' | 'unsupported',
): ClientDiagnosticsSnapshot {
  return {
    version: 2,
    capturedAtMs: 1,
    host: {
      kind: 'worker',
      role: 'leader',
      connectivity: 'online',
      realtime,
    },
    securityLifecycle: 'active',
    schema: { currentVersion: 1, upgrading: false },
    replica: { localRevision: '0', syncNeeded: false, pendingOutbox: 0 },
    lease: { state: 'none' },
    units: {
      bootstrapping: 0,
      complete: 0,
      reset: 0,
      revoked: 0,
      failed: 0,
      reasonCodes: [],
    },
    activeUnits: 0,
    replicaCursor: -1,
    storage: { status: 'healthy' },
    queryFailures: [],
  };
}

function fixture(
  connectResults: readonly ('resolve' | 'reject')[] = ['resolve'],
) {
  let diagnosticsListener: ClientDiagnosticsListener | undefined;
  let current = diagnostics('disconnected');
  const calls = { connect: 0, catchUp: 0, disconnect: 0, close: 0 };
  const emitSnapshot = (snapshot: ClientDiagnosticsSnapshot) => {
    current = snapshot;
    diagnosticsListener?.(current);
  };
  const emit = (state: 'connected' | 'disconnected' | 'unsupported') =>
    emitSnapshot(diagnostics(state));
  const client = {
    async connectRealtime() {
      const result = connectResults[calls.connect] ?? 'resolve';
      calls.connect += 1;
      if (result === 'reject') throw new Error('socket unavailable');
      emit('connected');
    },
    async syncUntilIdle() {
      calls.catchUp += 1;
    },
    disconnectRealtime() {
      calls.disconnect += 1;
      emitSnapshot({
        ...current,
        host: { ...current.host, realtime: 'disconnected' },
      });
    },
    diagnosticsSnapshot: () => current,
    onDiagnostics(listener: ClientDiagnosticsListener) {
      diagnosticsListener = listener;
      return () => {
        if (diagnosticsListener === listener) diagnosticsListener = undefined;
      };
    },
    async close() {
      calls.close += 1;
    },
  };
  return { client, calls, emit, emitSnapshot };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

describe('supported realtime host supervisor', () => {
  test('browser signals translate host events and unsubscribe cleanly', () => {
    const connectivityEvents = eventTarget();
    const network: { onLine: boolean } = { onLine: true };
    const connectivity = browserConnectivitySignal({
      events: connectivityEvents.target,
      network,
    });
    const connectivitySeen: string[] = [];
    const unsubscribeConnectivity = connectivity.subscribe((state) =>
      connectivitySeen.push(state),
    );
    network.onLine = false;
    connectivityEvents.emit('offline');
    unsubscribeConnectivity();
    network.onLine = true;
    connectivityEvents.emit('online');
    expect(connectivitySeen).toEqual(['offline']);

    const lifecycleEvents = eventTarget();
    const document: { visibilityState: string } = {
      visibilityState: 'visible',
    };
    const lifecycle = documentLifecycleSignal({
      events: lifecycleEvents.target,
      document,
    });
    const lifecycleSeen: string[] = [];
    const unsubscribeLifecycle = lifecycle.subscribe((state) =>
      lifecycleSeen.push(state),
    );
    document.visibilityState = 'hidden';
    lifecycleEvents.emit('visibilitychange');
    document.visibilityState = 'visible';
    lifecycleEvents.emit('pageshow');
    lifecycleEvents.emit('pagehide');
    unsubscribeLifecycle();
    lifecycleEvents.emit('pageshow');
    expect(lifecycleSeen).toEqual(['background', 'active', 'background']);
  });

  test('retries initial failure, catches up, and reconnects after socket close', async () => {
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const app = signal<RealtimeSupervisorLifecycleState>('active');
    const protection = signal<RealtimeSupervisorProtectionState>('active');
    const timers = scheduler();
    const realtime = fixture(['reject', 'resolve', 'resolve']);
    const supervisor = new RealtimeSupervisor(realtime.client, {
      connectivity: network.port,
      lifecycle: app.port,
      protection: protection.port,
      schedule: timers.schedule,
      random: () => 0,
    });

    supervisor.start();
    await settle();
    expect(timers.runNext()).toBe(0);
    await settle();
    expect(realtime.calls.connect).toBe(1);
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });
    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(realtime.calls.connect).toBe(2);
    // The failed first attempt drove one HTTP round, the connect a catch-up.
    expect(realtime.calls.catchUp).toBe(2);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });

    realtime.emit('disconnected');
    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(realtime.calls.connect).toBe(3);
    expect(realtime.calls.catchUp).toBe(3);
    await supervisor.stop();
  });

  test('pauses offline, background, and protected state without a retry storm', async () => {
    const network = signal<'online' | 'offline' | 'unknown'>('offline');
    const app = signal<RealtimeSupervisorLifecycleState>('active');
    const protection = signal<RealtimeSupervisorProtectionState>('active');
    const timers = scheduler();
    const realtime = fixture(['resolve', 'resolve', 'resolve']);
    const supervisor = new RealtimeSupervisor(realtime.client, {
      connectivity: network.port,
      lifecycle: app.port,
      protection: protection.port,
      schedule: timers.schedule,
      random: () => 0,
    });

    supervisor.start();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'offline', attempt: 0 });
    expect(timers.pending()).toBe(0);
    network.emit('online');
    timers.runNext();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });

    app.emit('background');
    expect(supervisor.snapshot()).toEqual({ phase: 'background', attempt: 0 });
    expect(timers.pending()).toBe(0);
    await settle();
    app.emit('active');
    timers.runNext();
    await settle();

    protection.emit('preflight');
    expect(supervisor.snapshot()).toEqual({ phase: 'protected', attempt: 0 });
    network.emit('offline');
    network.emit('online');
    expect(timers.pending()).toBe(0);
    await settle();
    protection.emit('active');
    timers.runNext();
    await settle();
    expect(realtime.calls.connect).toBe(3);
    await supervisor.stop();
  });

  test('a failed round is not connectivity evidence; preflight stays fail-closed', async () => {
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const protection = signal<RealtimeSupervisorProtectionState>('active');
    const timers = scheduler();
    const realtime = fixture(['resolve', 'resolve']);
    const supervisor = new RealtimeSupervisor(realtime.client, {
      connectivity: network.port,
      protection: protection.port,
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();

    // A round that failed with `network`/`connect` reports `offline` in the
    // client diagnostics. The host signal still says online, so the
    // supervisor keeps the socket and stays connectable (§1.8).
    const connected = diagnostics('connected');
    realtime.emitSnapshot({
      ...connected,
      host: { ...connected.host, connectivity: 'offline' },
    });
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(realtime.calls.disconnect).toBe(0);

    realtime.emitSnapshot({
      ...diagnostics('connected'),
      securityLifecycle: 'preflight',
    });
    expect(supervisor.snapshot()).toEqual({ phase: 'protected', attempt: 0 });
    expect(timers.pending()).toBe(0);
    await supervisor.stop();
  });

  test('a host online report drives syncUntilIdle while realtime is unsupported', async () => {
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const timers = scheduler();
    const realtime = fixture();
    realtime.emit('unsupported');
    const supervisor = new RealtimeSupervisor(realtime.client, {
      connectivity: network.port,
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'unsupported', attempt: 0 });

    network.emit('offline');
    await settle();
    expect(realtime.calls.catchUp).toBe(0);
    network.emit('online');
    await settle();
    expect(realtime.calls.catchUp).toBe(1);
    expect(realtime.calls.connect).toBe(0);
    expect(timers.pending()).toBe(0);
    await supervisor.stop();
  });

  test('resource close cancels pending retry and disconnects before close', async () => {
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const timers = scheduler();
    const realtime = fixture(['reject', 'resolve']);
    const client = installRealtimeSupervisor(realtime.client, {
      connectivity: network.port,
      schedule: timers.schedule,
      random: () => 0,
    });

    await settle();
    timers.runNext();
    await settle();
    expect(timers.pending()).toBe(1);
    await client.close();
    expect(realtime.calls.close).toBe(1);
    expect(timers.pending()).toBe(0);
    expect(realtimeSupervisorSnapshot(client)).toEqual({
      phase: 'stopped',
      attempt: 0,
    });
  });

  test('initial unsupported diagnostics never attempts a socket', async () => {
    const timers = scheduler();
    const realtime = fixture();
    realtime.emit('unsupported');
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'unsupported', attempt: 0 });
    expect(realtime.calls.connect).toBe(0);
    expect(timers.pending()).toBe(0);
    await supervisor.stop();
  });

  test('adopts one existing socket only after an explicit catch-up', async () => {
    const timers = scheduler();
    const realtime = fixture();
    realtime.emit('connected');
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    expect(realtime.calls.connect).toBe(0);
    expect(realtime.calls.catchUp).toBe(1);
    expect(timers.pending()).toBe(0);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await supervisor.stop();
  });

  test('disconnects a live transport when diagnostics declare it unsupported', async () => {
    const timers = scheduler();
    const realtime = fixture();
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    realtime.emit('unsupported');
    expect(realtime.calls.disconnect).toBe(1);
    expect(supervisor.snapshot()).toEqual({ phase: 'unsupported', attempt: 0 });
    expect(timers.pending()).toBe(0);
    await supervisor.stop();
  });

  test('steady-state connected diagnostics keep the adopted transport quiet', async () => {
    const timers = scheduler();
    const realtime = fixture();
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    const catchUps = realtime.calls.catchUp;
    let notifications = 0;
    supervisor.subscribe(() => {
      notifications += 1;
    });
    for (let index = 0; index < 5; index += 1) realtime.emit('connected');
    await settle();
    expect(realtime.calls.catchUp).toBe(catchUps);
    expect(notifications).toBe(0);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await supervisor.stop();
  });

  test('a successor waits for the superseded attempt and releases its late socket', async () => {
    const app = signal<RealtimeSupervisorLifecycleState>('active');
    const timers = scheduler();
    const resolvers: (() => void)[] = [];
    const calls = { connect: 0, catchUp: 0, disconnect: 0 };
    const client = {
      connectRealtime: () =>
        new Promise<void>((resolve) => {
          calls.connect += 1;
          resolvers.push(resolve);
        }),
      async syncUntilIdle() {
        calls.catchUp += 1;
      },
      disconnectRealtime() {
        calls.disconnect += 1;
      },
      diagnosticsSnapshot: () => diagnostics('disconnected'),
      onDiagnostics: () => () => undefined,
      async close() {},
    };
    const supervisor = new RealtimeSupervisor(client, {
      lifecycle: app.port,
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();
    expect(calls.connect).toBe(1);

    // The interrupted attempt counts, so a flap keeps the backoff.
    app.emit('background');
    expect(supervisor.snapshot()).toEqual({ phase: 'background', attempt: 1 });
    expect(calls.disconnect).toBe(1);
    // No successor opens while the first attempt is outstanding.
    app.emit('active');
    await settle();
    expect(timers.pending()).toBe(0);
    expect(calls.connect).toBe(1);

    // The late socket is released before the successor is scheduled.
    resolvers[0]?.();
    await settle();
    expect(calls.disconnect).toBe(2);
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });
    // The foreground return drove one HTTP round; the stale socket none.
    expect(calls.catchUp).toBe(1);

    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(calls.connect).toBe(2);
    resolvers[1]?.();
    await settle();
    expect(calls.catchUp).toBe(2);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await supervisor.stop();
  });

  test('sharedTransport keeps the shared socket alive when one tab backgrounds', async () => {
    const shared = { connected: false, connects: 0, disconnects: 0 };
    const listeners = new Set<ClientDiagnosticsListener>();
    const broadcast = () => {
      const snapshot = diagnostics(
        shared.connected ? 'connected' : 'disconnected',
      );
      for (const listener of listeners) listener(snapshot);
    };
    const makeTabClient = () => ({
      async connectRealtime() {
        shared.connects += 1;
        shared.connected = true;
        broadcast();
      },
      async syncUntilIdle() {},
      disconnectRealtime() {
        shared.disconnects += 1;
        shared.connected = false;
        broadcast();
      },
      diagnosticsSnapshot: () =>
        diagnostics(shared.connected ? 'connected' : 'disconnected'),
      onDiagnostics(listener: ClientDiagnosticsListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {},
    });
    const timersA = scheduler();
    const timersB = scheduler();
    const lifecycleB = signal<RealtimeSupervisorLifecycleState>('active');
    const a = new RealtimeSupervisor(makeTabClient(), {
      schedule: timersA.schedule,
      random: () => 0,
      sharedTransport: true,
    });
    const b = new RealtimeSupervisor(makeTabClient(), {
      lifecycle: lifecycleB.port,
      schedule: timersB.schedule,
      random: () => 0,
      sharedTransport: true,
    });
    a.start();
    b.start();
    await settle();
    timersA.runNext();
    await settle();
    expect(a.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(b.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(shared.connects).toBe(1);

    lifecycleB.emit('background');
    await settle();
    expect(shared.disconnects).toBe(0);
    expect(shared.connected).toBe(true);
    expect(a.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(b.snapshot()).toEqual({ phase: 'connected', attempt: 0 });

    lifecycleB.emit('active');
    await settle();
    expect(shared.connects).toBe(1);
    expect(a.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await a.stop();
    await b.stop();
  });

  test('disconnected diagnostics beside a pending retry keep the attempt count', async () => {
    const timers = scheduler();
    const realtime = fixture(['reject', 'reject', 'resolve']);
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });
    for (let index = 0; index < 6; index += 1) realtime.emit('disconnected');
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });
    expect(timers.pending()).toBe(1);
    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 2,
      retryDelayMs: 2_000,
    });
    expect(timers.runNext()).toBe(2_000);
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await supervisor.stop();
  });

  test('a later connected diagnostic recovers from a transient unsupported report', async () => {
    const timers = scheduler();
    const realtime = fixture();
    const supervisor = new RealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await settle();
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    realtime.emit('unsupported');
    expect(supervisor.snapshot()).toEqual({ phase: 'unsupported', attempt: 0 });
    realtime.emit('disconnected');
    expect(supervisor.snapshot()).toEqual({ phase: 'unsupported', attempt: 0 });
    expect(timers.pending()).toBe(0);
    realtime.emit('connected');
    await settle();
    expect(realtime.calls.catchUp).toBe(2);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    await supervisor.stop();
  });

  test('installing a second supervisor on one client throws', async () => {
    const timers = scheduler();
    const realtime = fixture();
    const client = installRealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    expect(() =>
      installRealtimeSupervisor(client, { schedule: timers.schedule }),
    ).toThrow('realtime.supervisor_already_installed');
    await client.close();
  });

  test('reconnect catches up a remote-only commit before claiming connected', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'supervisor-writer' });
    const b = await makeClient(server, { clientId: 'supervisor-reader' });
    for (const current of [a, b]) {
      current.client.subscribe({ project_id: 'p1' });
    }
    await a.client.syncUntilIdle();
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const timers = scheduler();
    const supervisor = new RealtimeSupervisor(b.client, {
      connectivity: network.port,
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await waitFor(
      () => supervisor.snapshot().phase === 'connected',
      (notify) => supervisor.subscribe(notify),
      'initial supervised catch-up',
    );

    network.emit('offline');
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('remote-only', 'p1', 'arrived after resume'),
      },
    ]);
    await a.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(0);

    network.emit('online');
    timers.runNext();
    await waitFor(
      () =>
        tableRows(b.db, 'tasks').length === 1 &&
        supervisor.snapshot().phase === 'connected',
      (notify) => supervisor.subscribe(notify),
      'remote-only catch-up',
    );
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(tableRows(b.db, 'tasks')[0]?.title).toBe('arrived after resume');
    await supervisor.stop();
    await a.client.close();
    await b.client.close();
  });

  test('a socket that never connects drives one HTTP round per attempt and on foreground', async () => {
    const app = signal<RealtimeSupervisorLifecycleState>('active');
    const timers = scheduler();
    const realtime = fixture(['reject', 'reject', 'reject', 'reject']);
    const supervisor = new RealtimeSupervisor(realtime.client, {
      lifecycle: app.port,
      sharedTransport: true,
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();
    expect(timers.runNext()).toBe(0);
    await settle();
    // §1.8: each failed attempt of the backoff schedule brings one round.
    expect(realtime.calls).toMatchObject({ connect: 1, catchUp: 1 });
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });
    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(realtime.calls).toMatchObject({ connect: 2, catchUp: 2 });
    expect(supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 2,
      retryDelayMs: 2_000,
    });

    // A return to the foreground brings one round without waiting for the
    // pending attempt; the backoff schedule stays as it was.
    app.emit('background');
    await settle();
    expect(realtime.calls.catchUp).toBe(2);
    app.emit('active');
    await settle();
    expect(realtime.calls).toMatchObject({ connect: 2, catchUp: 3 });
    expect(supervisor.snapshot().phase).toBe('retrying');
    expect(timers.pending()).toBe(1);

    await supervisor.stop();
    app.emit('active');
    await settle();
    expect(realtime.calls.catchUp).toBe(3);
  });

  test('a refused fetch behind a refused socket resumes on the next connect attempt', async () => {
    const server = makeServer();
    const writer = await makeClient(server, {
      clientId: 'supervisor-socketless',
    });
    const refusedSocket: RealtimeSupervisorClient = {
      connectRealtime: () => Promise.reject(new Error('socket refused')),
      disconnectRealtime: () => writer.client.disconnectRealtime(),
      syncUntilIdle: () => writer.client.syncUntilIdle(),
      diagnosticsSnapshot: () => writer.client.diagnosticsSnapshot(),
      onDiagnostics: (listener) => writer.client.onDiagnostics(listener),
      close: () => writer.client.close(),
    };
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const timers = scheduler();
    const supervisor = new RealtimeSupervisor(refusedSocket, {
      connectivity: network.port,
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();

    writer.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('socketless-edit', 'p1', 'written behind a proxy'),
      },
    ]);
    writer.faults.refuseConnectionOnce = true;
    await expect(writer.client.syncUntilIdle()).rejects.toMatchObject({
      details: { causeKind: 'connect' },
    });
    expect(writer.client.pendingCommits()).toHaveLength(1);

    // The host stays online, so only the connect attempt can drive the round.
    timers.runNext();
    await waitFor(
      () => writer.client.pendingCommits().length === 0,
      (notify) => writer.client.onProgress(notify),
      'the failed connect attempt pushes the pending edit',
    );
    expect(
      await server.storage.getRow(PARTITION, 'tasks', 'socketless-edit'),
    ).toBeDefined();
    expect(supervisor.snapshot().phase).toBe('retrying');
    await supervisor.stop();
    await writer.client.close();
  });

  test('an app-closed transport gate holds the supervisor offline without reconnecting', async () => {
    const server = makeServer();
    const { client } = await makeClient(server, {
      clientId: 'supervisor-gate',
    });
    let connects = 0;
    const counted: RealtimeSupervisorClient = {
      connectRealtime: () => {
        connects += 1;
        return client.connectRealtime();
      },
      disconnectRealtime: () => client.disconnectRealtime(),
      syncUntilIdle: () => client.syncUntilIdle(),
      diagnosticsSnapshot: () => client.diagnosticsSnapshot(),
      onDiagnostics: (listener) => client.onDiagnostics(listener),
      close: () => client.close(),
    };
    const timers = scheduler();
    const supervisor = new RealtimeSupervisor(counted, {
      schedule: timers.schedule,
      random: () => 0,
    });
    supervisor.start();
    await settle();
    timers.runNext();
    await waitFor(
      () => supervisor.snapshot().phase === 'connected',
      (notify) => supervisor.subscribe(notify),
      'initial connect',
    );

    client.setTransportEnabled(false);
    // The first attempt after the close meets the gate; its `sync.offline`
    // refusal is the evidence that holds the supervisor offline.
    const before = connects;
    timers.runNext();
    await settle();
    const refused = connects;
    expect(refused).toBe(before + 1);
    // The gate released the socket; that loss counted one attempt.
    expect(supervisor.snapshot()).toEqual({ phase: 'offline', attempt: 1 });
    expect(timers.pending()).toBe(0);
    client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await settle();
    expect(supervisor.snapshot().phase).toBe('offline');
    expect(timers.pending()).toBe(0);
    expect(connects).toBe(refused);

    client.setTransportEnabled(true);
    timers.runNext();
    await waitFor(
      () => supervisor.snapshot().phase === 'connected',
      (notify) => supervisor.subscribe(notify),
      'reconnect after the gate reopens',
    );
    expect(connects).toBe(refused + 1);
    await supervisor.stop();
    await client.close();
  });

  test('an unreachable round resumes on the host online report without a local write', async () => {
    const server = makeServer();
    const writer = await makeClient(server, {
      clientId: 'supervisor-unreachable',
      realtimePolicy: 'off',
    });
    const network = signal<'online' | 'offline' | 'unknown'>('online');
    const timers = scheduler();
    const supervisor = new RealtimeSupervisor(writer.client, {
      connectivity: network.port,
      schedule: timers.schedule,
    });
    supervisor.start();
    await settle();
    expect(supervisor.snapshot().phase).toBe('unsupported');

    writer.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('pending-edit', 'p1', 'written offline'),
      },
    ]);
    const intents = writer.intents.length;
    writer.faults.refuseConnectionOnce = true;
    await expect(writer.client.syncUntilIdle()).rejects.toMatchObject({
      code: 'sync.transport_failed',
      details: { causeKind: 'connect' },
    });
    // §1.8: no retry intent; the round's work stays owed for the resume.
    expect(writer.intents.length).toBe(intents);
    expect(writer.client.statusSnapshot().syncNeeded).toBe(true);
    expect(writer.client.pendingCommits()).toHaveLength(1);

    network.emit('offline');
    network.emit('online');
    await waitFor(
      () => writer.client.pendingCommits().length === 0,
      (notify) => writer.client.onProgress(notify),
      'the online report pushes the pending edit',
    );
    expect(
      await server.storage.getRow(PARTITION, 'tasks', 'pending-edit'),
    ).toBeDefined();
    await supervisor.stop();
    await writer.client.close();
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A socket, its catch-up rounds and a remote log, with gates on each step. */
function lifecycle(random: () => number = () => 0) {
  const network = signal<'online' | 'offline' | 'unknown'>('online');
  const app = signal<RealtimeSupervisorLifecycleState>('active');
  const protection = signal<RealtimeSupervisorProtectionState>('active');
  const timers = scheduler();
  const subscribers = { network: 0, app: 0, protection: 0 };
  const counted = <State>(
    source: ReturnType<typeof signal<State>>,
    key: keyof typeof subscribers,
  ): RealtimeSupervisorSignal<State> => ({
    current: () => source.port.current(),
    subscribe(listener) {
      subscribers[key] += 1;
      const unsubscribe = source.port.subscribe(listener);
      return () => {
        subscribers[key] -= 1;
        unsubscribe();
      };
    },
  });
  let listener: ClientDiagnosticsListener | undefined;
  let state: 'connected' | 'disconnected' = 'disconnected';
  let connectGate: Promise<void> | undefined;
  let disconnectGate: Promise<void> | undefined;
  let pullGate: Promise<void> | undefined;
  let connectFailures = 0;
  let pullFailures = 0;
  let connecting = 0;
  const counts = {
    sockets: 0,
    maximumSockets: 0,
    maximumConnecting: 0,
    connect: 0,
    sync: 0,
    close: 0,
  };
  const remote: number[] = [];
  const local: number[] = [];
  const emit = () => listener?.(diagnostics(state));
  const client = {
    async connectRealtime() {
      counts.connect += 1;
      connecting += 1;
      counts.maximumConnecting = Math.max(counts.maximumConnecting, connecting);
      try {
        await connectGate;
        if (connectFailures-- > 0) throw new Error('injected connect');
        counts.sockets += 1;
        counts.maximumSockets = Math.max(counts.maximumSockets, counts.sockets);
        state = 'connected';
        emit();
      } finally {
        connecting -= 1;
      }
    },
    async disconnectRealtime(): Promise<void> {
      await disconnectGate;
      counts.sockets = 0;
      state = 'disconnected';
      emit();
    },
    async syncUntilIdle() {
      counts.sync += 1;
      await pullGate;
      if (pullFailures-- > 0) throw new Error('injected pull');
      local.splice(0, local.length, ...remote);
    },
    diagnosticsSnapshot: async (): Promise<ClientDiagnosticsSnapshot> =>
      diagnostics(state),
    onDiagnostics(next: ClientDiagnosticsListener): () => void {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async close(): Promise<void> {
      counts.close += 1;
      counts.sockets = 0;
    },
  };
  const options = {
    connectivity: counted(network, 'network'),
    lifecycle: counted(app, 'app'),
    protection: counted(protection, 'protection'),
    random,
    schedule: timers.schedule,
  };
  const supervisor = new RealtimeSupervisor(client, options);
  return {
    client,
    supervisor,
    options,
    network,
    app,
    protection,
    timers,
    remote,
    local,
    counts,
    subscribers,
    async start() {
      supervisor.start();
      await settle();
    },
    async next() {
      const delayMs = timers.runNext();
      await settle();
      return delayMs;
    },
    failConnect(count: number) {
      connectFailures = count;
    },
    failPull() {
      pullFailures = 1;
    },
    closeSocket() {
      counts.sockets = 0;
      state = 'disconnected';
      emit();
    },
    blockConnect() {
      const blocked = deferred();
      connectGate = blocked.promise;
      return blocked;
    },
    blockDisconnect() {
      const blocked = deferred();
      disconnectGate = blocked.promise;
      return blocked;
    },
    blockPull() {
      const blocked = deferred();
      pullGate = blocked.promise;
      return blocked;
    },
  };
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** A rejection that names `secret` anywhere a log could read it. */
function leaks(error: unknown, secret: string): boolean {
  return (
    error instanceof Error &&
    `${JSON.stringify(error)} ${error.message} ${error.stack}`.includes(secret)
  );
}

/** Each unsubscribe returned by `onDiagnostics` throws after unsubscribing. */
function throwingUnsubscribe(
  client: ReturnType<typeof lifecycle>['client'],
  afterUnsubscribe: () => void = () => undefined,
) {
  const subscribe = client.onDiagnostics;
  client.onDiagnostics = (listener) => {
    const unsubscribe = subscribe(listener);
    return () => {
      unsubscribe();
      afterUnsubscribe();
      throw new Error('synthetic-private-unsubscribe');
    };
  };
}

/** The host timer's cancel throws; the timer stays armed. */
function throwingCancel(
  f: ReturnType<typeof lifecycle>,
  onSchedule = () => {},
) {
  f.options.schedule = (callback, delayMs) => {
    f.timers.schedule(callback, delayMs);
    onSchedule();
    return () => {
      throw new Error('synthetic-private-cancel');
    };
  };
}

describe('realtime supervisor lifecycle (SPEC §8.4)', () => {
  test('initial diagnostics settle after host flaps without stranding initialization', async () => {
    const f = lifecycle();
    const read = deferred();
    f.client.diagnosticsSnapshot = async () => {
      await read.promise;
      return diagnostics('disconnected');
    };
    f.supervisor.start();
    f.network.emit('offline');
    f.app.emit('background');
    f.network.emit('online');
    f.app.emit('active');
    read.resolve();
    await settle();
    expect(f.timers.pending()).toBe(1);
    await f.next();
    expect(f.counts.connect).toBe(1);
    await f.supervisor.stop();
  });

  test('socket loss during catch-up schedules another catch-up', async () => {
    const f = lifecycle();
    const pull = f.blockPull();
    await f.start();
    await f.next();
    f.remote.push(1);
    f.closeSocket();
    pull.resolve();
    await settle();
    expect(f.timers.pending()).toBe(1);
    f.remote.push(2);
    await f.next();
    expect(f.local).toEqual([1, 2]);
    expect(f.counts.sync).toBe(2);
    await f.supervisor.stop();
  });

  test('a resumed connect waits for the superseded attempt and an asynchronous disconnect', async () => {
    const f = lifecycle();
    const open = f.blockConnect();
    await f.start();
    await f.next();
    f.network.emit('offline');
    f.network.emit('online');
    await settle();
    expect(f.timers.pending()).toBe(0);
    expect(f.counts.maximumConnecting).toBe(1);
    open.resolve();
    await settle();
    await f.next();
    expect(f.supervisor.snapshot().phase).toBe('connected');

    const disposal = f.blockDisconnect();
    f.app.emit('background');
    f.app.emit('active');
    await settle();
    expect(f.timers.pending()).toBe(0);
    expect(f.counts.maximumSockets).toBe(1);
    disposal.resolve();
    await settle();
    await f.next();
    expect(f.counts.maximumSockets).toBe(1);
    expect(f.supervisor.snapshot().phase).toBe('connected');
    await f.supervisor.stop();
  });

  test('connectivity flaps and repeated diagnostics keep the bounded retry', async () => {
    const f = lifecycle();
    f.failConnect(20);
    await f.start();
    await f.next();
    for (let index = 0; index < 100; index += 1) {
      f.network.emit('offline');
      f.network.emit('online');
      f.closeSocket();
    }
    expect(f.counts.connect).toBe(1);
    expect(f.timers.pending()).toBe(1);
    expect(await f.next()).toBe(1_000);
    const delays: number[] = [];
    for (let index = 0; index < 10; index += 1) delays.push(await f.next());
    expect(delays).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      30_000,
    ]);
    await f.supervisor.stop();
  });

  test('maximum jitter stays under the ceiling and a completed catch-up resets the backoff', async () => {
    const f = lifecycle(() => 1);
    f.failConnect(6);
    await f.start();
    await f.next();
    const delays: number[] = [];
    for (let index = 0; index < 6; index += 1) delays.push(await f.next());
    expect(delays).toEqual([1_250, 2_500, 5_000, 10_000, 20_000, 30_000]);
    expect(f.supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    f.closeSocket();
    expect(f.supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_250,
    });
    await f.supervisor.stop();
  });

  test('every reconnect cause pulls remote-only commits before connected', async () => {
    const f = lifecycle();
    await f.start();
    f.remote.push(1);
    await f.next();
    const causes: [() => void, () => void][] = [
      [() => f.closeSocket(), () => undefined],
      [() => f.network.emit('offline'), () => f.network.emit('online')],
      [() => f.app.emit('background'), () => f.app.emit('active')],
      [() => f.protection.emit('preflight'), () => f.protection.emit('active')],
    ];
    for (const [pause, resume] of causes) {
      pause();
      f.remote.push(f.remote.length + 1);
      await settle();
      resume();
      await settle();
      await f.next();
      expect(f.local).toEqual(f.remote);
      expect(f.supervisor.snapshot().phase).toBe('connected');
      expect(f.counts.maximumSockets).toBe(1);
    }
    // Five catch-ups, plus the rounds the `online` and foreground reports
    // drive while the socket is down.
    expect(f.counts.sync).toBe(7);
    await f.supervisor.stop();
  });

  test('a failed catch-up cannot claim connected', async () => {
    const f = lifecycle();
    f.failPull();
    await f.start();
    await f.next();
    expect(f.supervisor.snapshot().phase).toBe('retrying');
    f.remote.push(1);
    await f.next();
    expect(f.local).toEqual([1]);
    expect(f.supervisor.snapshot().phase).toBe('connected');
    await f.supervisor.stop();
  });

  test('close waits for a late connect and releases its socket; repeated close is one operation', async () => {
    const f = lifecycle();
    const open = f.blockConnect();
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    await f.next();
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await settle();
    expect(client.close()).toBe(client.close());
    expect(closed).toBe(false);
    f.network.emit('offline');
    f.network.emit('online');
    f.app.emit('active');
    open.resolve();
    await closing;
    expect(f.counts).toMatchObject({
      sockets: 0,
      maximumSockets: 1,
      maximumConnecting: 1,
      close: 1,
      sync: 0,
    });
    expect(f.timers.pending()).toBe(0);
    expect(realtimeSupervisorSnapshot(client).phase).toBe('stopped');
    expect(f.subscribers).toEqual({ network: 0, app: 0, protection: 0 });
  });

  test('close and a host flap void a fired timer before its attempt opens', async () => {
    const f = lifecycle();
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    f.timers.runNext();
    await client.close();
    expect(f.counts).toMatchObject({ connect: 0, sockets: 0, close: 1 });

    const g = lifecycle();
    await g.start();
    g.timers.runNext();
    g.network.emit('offline');
    g.network.emit('online');
    await settle();
    expect(g.counts.connect).toBe(0);
    expect(g.timers.pending()).toBe(1);
    expect(await g.next()).toBe(1_000);
    expect(g.counts.maximumSockets).toBe(1);
    await g.supervisor.stop();
  });

  test('host connectivity supersedes a stale diagnostics sample; supervisors own separate sockets', async () => {
    const a = lifecycle();
    const b = lifecycle();
    a.client.diagnosticsSnapshot = async () => {
      const snapshot = diagnostics('disconnected');
      return {
        ...snapshot,
        host: { ...snapshot.host, connectivity: 'offline' },
      };
    };
    await Promise.all([a.start(), b.start()]);
    await a.next();
    await b.next();
    expect(a.supervisor.snapshot().phase).toBe('connected');
    expect(b.supervisor.snapshot().phase).toBe('connected');
    await a.supervisor.stop();
    b.remote.push(1);
    b.closeSocket();
    await b.next();
    expect(b.local).toEqual([1]);
    expect(a.counts.sockets).toBe(0);
    await b.supervisor.stop();
  });

  test('a socket that never connects drives an HTTP round on every attempt', async () => {
    const f = lifecycle();
    f.failConnect(100);
    await f.start();
    f.remote.push(1);
    await f.next();
    expect(f.local).toEqual([1]);
    const delays: number[] = [];
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      f.remote.push(attempt);
      delays.push(await f.next());
      expect(f.local).toEqual(f.remote);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(f.counts).toMatchObject({ sync: 6, connect: 6, sockets: 0 });
    expect(f.supervisor.snapshot()).toMatchObject({
      phase: 'retrying',
      attempt: 6,
    });
    await f.supervisor.stop();
  });

  test('a failed HTTP round keeps the schedule', async () => {
    const f = lifecycle();
    f.failConnect(100);
    f.failPull();
    await f.start();
    await f.next();
    expect(f.counts.sync).toBe(1);
    expect(f.timers.pending()).toBe(1);
    f.remote.push(1);
    await f.next();
    expect(f.local).toEqual([1]);
    await f.supervisor.stop();
  });

  test('online and foreground reports drive a round without touching the backoff', async () => {
    const f = lifecycle();
    f.failConnect(100);
    await f.start();
    await f.next();
    await f.next();
    await f.next();
    const before = f.counts.sync;
    f.network.emit('offline');
    await settle();
    expect(f.counts.sync).toBe(before);
    f.remote.push(1);
    f.network.emit('online');
    await settle();
    expect(f.counts.sync).toBe(before + 1);
    expect(f.local).toEqual([1]);
    f.app.emit('background');
    await settle();
    f.remote.push(2);
    f.app.emit('active');
    await settle();
    expect(f.counts.sync).toBe(before + 2);
    expect(f.local).toEqual([1, 2]);
    expect(f.counts.connect).toBe(3);
    expect(f.supervisor.snapshot()).toEqual({
      phase: 'retrying',
      attempt: 3,
      retryDelayMs: 4_000,
    });
    expect(f.timers.pending()).toBe(1);
    await f.supervisor.stop();
  });

  test('reports during a driven round add exactly one round after it', async () => {
    const f = lifecycle();
    f.failConnect(100);
    await f.start();
    const pull = f.blockPull();
    await f.next();
    for (let index = 0; index < 5; index += 1) {
      f.network.emit('offline');
      f.network.emit('online');
    }
    await settle();
    expect(f.counts.sync).toBe(1);
    f.blockPull().resolve();
    pull.resolve();
    await settle();
    expect(f.counts.sync).toBe(2);
    await f.supervisor.stop();
  });

  test('a protected host drives no round, and stop waits for a driven round', async () => {
    const f = lifecycle();
    f.failConnect(100);
    await f.start();
    await f.next();
    const base = f.counts.sync;
    f.protection.emit('preflight');
    f.app.emit('background');
    f.app.emit('active');
    await settle();
    expect(f.counts.sync).toBe(base);
    f.protection.emit('active');
    await settle();
    const pull = f.blockPull();
    f.app.emit('background');
    f.app.emit('active');
    await settle();
    expect(f.counts.sync).toBe(base + 1);
    let stopped = false;
    const stopping = f.supervisor.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    f.network.emit('online');
    pull.resolve();
    await stopping;
    expect(f.counts.sync).toBe(base + 1);
  });

  test('a connected socket carries the rounds; host reports add none', async () => {
    const f = lifecycle();
    const supervisor = new RealtimeSupervisor(f.client, {
      ...f.options,
      sharedTransport: true,
    });
    supervisor.start();
    await settle();
    await f.next();
    const base = f.counts.sync;
    f.network.emit('online');
    f.app.emit('background');
    f.app.emit('active');
    await settle();
    expect(supervisor.snapshot().phase).toBe('connected');
    expect(f.counts).toMatchObject({ sync: base, sockets: 1, connect: 1 });
    await supervisor.stop();
  });
});

describe('realtime supervisor failures (SPEC §8.4, §10.3)', () => {
  test('a close reentered by an unsubscribe shares the pending close and its failure', async () => {
    const f = lifecycle();
    let nested: Promise<void> | undefined;
    throwingUnsubscribe(f.client, () => {
      nested = f.client.close();
    });
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    await f.next();
    const outer = client.close();
    expect(nested).toBe(outer);
    const error = await rejection(outer);
    expect(error).toBeInstanceOf(RealtimeSupervisorError);
    expect(error).toMatchObject({ code: 'realtime.cleanup_failed' });
    expect(leaks(error, 'synthetic-private')).toBe(false);
    expect(f.counts.close).toBe(1);
    expect(f.timers.pending()).toBe(0);
  });

  test('a throwing unsubscribe still waits for an in-flight connect before close', async () => {
    const f = lifecycle();
    const open = f.blockConnect();
    throwingUnsubscribe(f.client);
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    await f.next();
    const outcome = rejection(client.close());
    await settle();
    expect(f.counts.close).toBe(0);
    expect(f.subscribers).toEqual({ network: 0, app: 0, protection: 0 });
    open.resolve();
    expect(await outcome).toMatchObject({ code: 'realtime.cleanup_failed' });
    expect(f.counts).toMatchObject({ close: 1, sockets: 0 });
    expect(f.timers.pending()).toBe(0);
  });

  test('concurrent stop callers share one failure', async () => {
    const f = lifecycle();
    const open = f.blockConnect();
    throwingUnsubscribe(f.client);
    await f.start();
    await f.next();
    const first = f.supervisor.stop();
    expect(f.supervisor.stop()).toBe(first);
    open.resolve();
    expect(await rejection(first)).toMatchObject({
      code: 'realtime.cleanup_failed',
    });
  });

  test('a throwing timer cancel still unsubscribes every source and voids the timer', async () => {
    const f = lifecycle();
    throwingCancel(f);
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    expect(f.timers.pending()).toBe(1);
    const error = await rejection(client.close());
    expect(error).toMatchObject({ code: 'realtime.cleanup_failed' });
    expect(leaks(error, 'synthetic-private')).toBe(false);
    expect(f.subscribers).toEqual({ network: 0, app: 0, protection: 0 });
    await f.next();
    expect(f.counts).toMatchObject({ connect: 0, close: 1 });
  });

  test('a throwing timer cancel latches the supervisor closed', async () => {
    for (const trigger of ['protection', 'unsupported'] as const) {
      const f = lifecycle();
      let deliver: ClientDiagnosticsListener | undefined;
      const subscribe = f.client.onDiagnostics;
      f.client.onDiagnostics = (listener) => {
        deliver = listener;
        return subscribe(listener);
      };
      throwingCancel(f);
      const client = installRealtimeSupervisor(f.client, f.options);
      await settle();
      if (trigger === 'protection') f.protection.emit('preflight');
      else deliver?.(diagnostics('unsupported'));
      expect(realtimeSupervisorSnapshot(client)).toMatchObject({
        phase: 'unsupported',
        failureCode: 'realtime.cleanup_failed',
      });
      expect(() => f.timers.runNext()).not.toThrow();
      await settle();
      expect(f.counts.connect).toBe(0);
      expect(await rejection(client.close())).toMatchObject({
        code: 'realtime.cleanup_failed',
      });
      expect(f.counts.close).toBe(1);
    }
  });

  test('a host signal that throws during initialization fails it closed', async () => {
    const f = lifecycle();
    throwingCancel(f, () => {
      f.options.protection.current = () => {
        throw new Error('synthetic-private-protection');
      };
    });
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    expect(realtimeSupervisorSnapshot(client)).toMatchObject({
      phase: 'unsupported',
      failureCode: 'realtime.diagnostics_unavailable',
    });
    expect(() => f.timers.runNext()).not.toThrow();
    await settle();
    expect(f.counts.connect).toBe(0);
    const error = await rejection(client.close());
    expect(error).toMatchObject({
      code: 'realtime.diagnostics_unavailable',
      cleanupFailureCode: 'realtime.cleanup_failed',
    });
    expect(leaks(error, 'synthetic-private')).toBe(false);
  });

  test('unreadable diagnostics latch the supervisor closed without a retry', async () => {
    const f = lifecycle();
    f.client.diagnosticsSnapshot = async () => {
      throw new Error('synthetic-private-diagnostics');
    };
    await f.start();
    expect(f.supervisor.snapshot()).toMatchObject({
      phase: 'unsupported',
      failureCode: 'realtime.diagnostics_unavailable',
    });
    expect(f.timers.pending()).toBe(0);
    expect(await rejection(f.supervisor.stop())).toMatchObject({
      code: 'realtime.diagnostics_unavailable',
    });
  });

  test('a failed disconnect latches the supervisor closed through a late catch-up', async () => {
    const f = lifecycle();
    const pull = f.blockPull();
    await f.start();
    await f.next();
    f.client.disconnectRealtime = async () => {
      throw new Error('synthetic-private-disconnect');
    };
    f.app.emit('background');
    await settle();
    expect(f.supervisor.snapshot()).toMatchObject({
      phase: 'unsupported',
      failureCode: 'realtime.disconnect_failed',
    });
    f.app.emit('active');
    expect(f.timers.pending()).toBe(0);
    pull.resolve();
    await settle();
    expect(f.supervisor.snapshot()).toMatchObject({
      phase: 'unsupported',
      failureCode: 'realtime.disconnect_failed',
    });
    expect(await rejection(f.supervisor.stop())).toMatchObject({
      code: 'realtime.disconnect_failed',
      disconnectCauseCode: 'unknown',
    });
  });

  test('a disconnect failure keeps only a Syncular cause code', async () => {
    let getterCalls = 0;
    const causes: [unknown, string][] = [
      [
        Object.assign(new Error('synthetic-sensitive-message'), {
          code: 'client.leader_handover',
        }),
        'client.leader_handover',
      ],
      [
        Object.assign(new Error('synthetic-sensitive-message'), {
          code: 'synthetic-sensitive-code',
        }),
        'unknown',
      ],
      [
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error('synthetic-sensitive-proxy');
            },
          },
        ),
        'unknown',
      ],
      [
        {
          get code() {
            getterCalls += 1;
            return 'client.leader_handover';
          },
        },
        'unknown',
      ],
      [undefined, 'unknown'],
    ];
    for (const [cause, disconnectCauseCode] of causes) {
      const f = lifecycle();
      await f.start();
      await f.next();
      f.client.disconnectRealtime = async () => {
        throw cause;
      };
      f.protection.emit('preflight');
      await settle();
      const error = await rejection(f.supervisor.stop());
      expect(error).toMatchObject({
        code: 'realtime.disconnect_failed',
        disconnectCauseCode,
      });
      expect(leaks(error, 'synthetic-sensitive')).toBe(false);
      expect(Object.hasOwn(error as object, 'cause')).toBe(false);
      expect(f.timers.pending()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  test('stop, disconnect and close failures combine into one named rejection', async () => {
    const f = lifecycle();
    throwingUnsubscribe(f.client);
    f.client.disconnectRealtime = async () => {
      throw Object.assign(new Error('synthetic-private-disconnect'), {
        code: 'client.leader_handover',
      });
    };
    let closeFailure: unknown;
    f.client.close = async () => {
      f.counts.close += 1;
      if (closeFailure !== undefined) throw closeFailure;
    };
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    await f.next();
    closeFailure = Object.assign(new Error('synthetic-private-close'), {
      code: 'client.worker_failed',
    });
    const first = client.close();
    expect(client.close()).toBe(first);
    const error = await rejection(first);
    expect(error).toMatchObject({
      code: 'realtime.disconnect_failed',
      stopFailureCode: 'realtime.disconnect_failed',
      disconnectCauseCode: 'client.leader_handover',
      cleanupFailureCode: 'realtime.cleanup_failed',
      closeFailureCode: 'client.worker_failed',
    });
    expect(leaks(error, 'synthetic-private')).toBe(false);
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    expect(f.counts.close).toBe(1);
    expect(f.timers.pending()).toBe(0);
  });

  test('a close failure without a supervisor failure propagates unchanged', async () => {
    const f = lifecycle();
    const failure = new Error('client close failed');
    f.client.close = async () => {
      throw failure;
    };
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    expect(await rejection(client.close())).toBe(failure);
  });

  test('diagnostics, disconnect and close failures keep distinct codes', async () => {
    const f = lifecycle();
    const read = deferred();
    f.client.diagnosticsSnapshot = async () => {
      await read.promise;
      return diagnostics('disconnected');
    };
    f.client.disconnectRealtime = async () => {
      throw Object.assign(new Error('synthetic-private-disconnect'), {
        code: 'client.worker_failed',
      });
    };
    f.client.close = async () => {
      throw Object.assign(new Error('synthetic-private-close'), {
        code: 'synthetic-private-code',
      });
    };
    const client = installRealtimeSupervisor(f.client, f.options);
    await settle();
    // A socket the host opened is released when the supervisor fails.
    await client.connectRealtime();
    read.reject(new Error('synthetic-private-diagnostics'));
    await settle();
    const error = await rejection(client.close());
    expect(error).toMatchObject({
      code: 'realtime.disconnect_failed',
      stopFailureCode: 'realtime.disconnect_failed',
      diagnosticsFailureCode: 'realtime.diagnostics_unavailable',
      disconnectCauseCode: 'client.worker_failed',
      closeFailureCode: 'unknown',
    });
    expect(leaks(error, 'synthetic-private')).toBe(false);
  });
});
