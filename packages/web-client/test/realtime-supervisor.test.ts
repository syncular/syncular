import { describe, expect, test } from 'bun:test';
import type {
  ClientDiagnosticsListener,
  ClientDiagnosticsSnapshot,
  RealtimeSupervisorLifecycleState,
  RealtimeSupervisorProtectionState,
  RealtimeSupervisorSignal,
} from '@syncular/client';
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
  RealtimeSupervisor,
  realtimeSupervisorSnapshot,
} from '@syncular/client';
import {
  makeClient,
  makeServer,
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
    version: 1,
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
    subscriptions: [],
    subscriptionsTruncated: false,
    storage: { status: 'healthy' },
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
    expect(realtime.calls.catchUp).toBe(1);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });

    realtime.emit('disconnected');
    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(realtime.calls.connect).toBe(3);
    expect(realtime.calls.catchUp).toBe(2);
    supervisor.stop();
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
    app.emit('active');
    timers.runNext();
    await settle();

    protection.emit('preflight');
    expect(supervisor.snapshot()).toEqual({ phase: 'protected', attempt: 0 });
    network.emit('offline');
    network.emit('online');
    expect(timers.pending()).toBe(0);
    protection.emit('active');
    timers.runNext();
    await settle();
    expect(realtime.calls.connect).toBe(3);
    supervisor.stop();
  });

  test('diagnostic offline and preflight remain fail-closed beside explicit signals', async () => {
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

    const connected = diagnostics('connected');
    realtime.emitSnapshot({
      ...connected,
      host: { ...connected.host, connectivity: 'offline' },
    });
    expect(supervisor.snapshot()).toEqual({ phase: 'offline', attempt: 0 });
    expect(timers.pending()).toBe(0);

    realtime.emitSnapshot(diagnostics('disconnected'));
    timers.runNext();
    await settle();
    realtime.emitSnapshot({
      ...diagnostics('connected'),
      securityLifecycle: 'preflight',
    });
    expect(supervisor.snapshot()).toEqual({ phase: 'protected', attempt: 0 });
    expect(timers.pending()).toBe(0);
    supervisor.stop();
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
    supervisor.stop();
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
    supervisor.stop();
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
    supervisor.stop();
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
    supervisor.stop();
  });

  test('a superseded connect attempt leaves the successor state and socket alone', async () => {
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

    app.emit('background');
    expect(supervisor.snapshot()).toEqual({ phase: 'background', attempt: 0 });
    expect(calls.disconnect).toBe(1);
    app.emit('active');
    timers.runNext();
    await settle();
    expect(calls.connect).toBe(2);

    resolvers[0]?.();
    await settle();
    expect(calls.disconnect).toBe(1);
    expect(supervisor.snapshot()).toEqual({ phase: 'connecting', attempt: 0 });

    resolvers[1]?.();
    await settle();
    expect(calls.catchUp).toBe(1);
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    supervisor.stop();
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
    a.stop();
    b.stop();
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
    supervisor.stop();
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
    supervisor.stop();
  });

  test('installing a second supervisor on one client throws', async () => {
    const timers = scheduler();
    const realtime = fixture();
    const client = installRealtimeSupervisor(realtime.client, {
      schedule: timers.schedule,
    });
    expect(() =>
      installRealtimeSupervisor(client, { schedule: timers.schedule }),
    ).toThrow('already has a supervisor');
    await client.close();
  });

  test('reconnect catches up a remote-only commit before claiming connected', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'supervisor-writer' });
    const b = await makeClient(server, { clientId: 'supervisor-reader' });
    for (const current of [a, b]) {
      current.client.subscribe({
        id: 'supervised-tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
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
      () => tableRows(b.db, 'tasks').length === 1,
      'remote-only catch-up',
    );
    expect(supervisor.snapshot()).toEqual({ phase: 'connected', attempt: 0 });
    expect(tableRows(b.db, 'tasks')[0]?.title).toBe('arrived after resume');
    supervisor.stop();
    await a.client.close();
    await b.client.close();
  });
});
