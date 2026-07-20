import { describe, expect, test } from 'bun:test';
import {
  type ClientDiagnosticsListener,
  type ClientDiagnosticsSnapshot,
  installRealtimeSupervisor,
  type RealtimeSupervisorSignal,
  realtimeSupervisorSnapshot,
  subscribeRealtimeSupervisor,
} from '@syncular/client';
import { normalizeClient } from '../src/client';
import { FakeClient } from './fake-client';

function diagnostics(
  realtime: 'connected' | 'disconnected',
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

function fixedSignal<State>(state: State): RealtimeSupervisorSignal<State> {
  return {
    current: () => state,
    subscribe: () => () => undefined,
  };
}

function scheduler() {
  const tasks: Array<{
    readonly callback: () => void;
    readonly delayMs: number;
    cancelled: boolean;
  }> = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    runNext(): number {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (task === undefined) throw new Error('no scheduled realtime task');
      task.cancelled = true;
      task.callback();
      return task.delayMs;
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('realtime supervisor through the normalized React client', () => {
  test('preserves snapshot and subscription identity without owning transport', async () => {
    let realtime: 'connected' | 'disconnected' = 'disconnected';
    let diagnosticsListener: ClientDiagnosticsListener | undefined;
    let connectCalls = 0;
    let closeCalls = 0;
    const timers = scheduler();
    const source = Object.assign(new FakeClient(), {
      async connectRealtime() {
        connectCalls += 1;
        if (connectCalls === 1) throw new Error('transient socket failure');
        realtime = 'connected';
        diagnosticsListener?.(diagnostics(realtime));
      },
      disconnectRealtime() {
        realtime = 'disconnected';
        diagnosticsListener?.(diagnostics(realtime));
      },
      async syncUntilIdle() {},
      async diagnosticsSnapshot() {
        return diagnostics(realtime);
      },
      onDiagnostics(listener: ClientDiagnosticsListener) {
        diagnosticsListener = listener;
        return () => {
          if (diagnosticsListener === listener) diagnosticsListener = undefined;
        };
      },
      async close() {
        closeCalls += 1;
      },
    });

    installRealtimeSupervisor(source, {
      connectivity: fixedSignal('online' as const),
      lifecycle: fixedSignal('active' as const),
      protection: fixedSignal('active' as const),
      schedule: timers.schedule,
      random: () => 0,
    });
    const normalized = normalizeClient(source);
    const observed: string[] = [];
    const unsubscribe = subscribeRealtimeSupervisor(normalized, () => {
      observed.push(realtimeSupervisorSnapshot(normalized).phase);
    });

    await settle();
    expect(realtimeSupervisorSnapshot(normalized)).toBe(
      realtimeSupervisorSnapshot(source),
    );
    expect(timers.runNext()).toBe(0);
    await settle();
    expect(realtimeSupervisorSnapshot(normalized)).toEqual({
      phase: 'retrying',
      attempt: 1,
      retryDelayMs: 1_000,
    });

    expect(timers.runNext()).toBe(1_000);
    await settle();
    expect(realtimeSupervisorSnapshot(normalized)).toEqual({
      phase: 'connected',
      attempt: 0,
    });
    expect(observed).toContain('retrying');
    expect(observed).toContain('connected');

    await source.close();
    expect(closeCalls).toBe(1);
    expect(realtimeSupervisorSnapshot(normalized)).toEqual({
      phase: 'stopped',
      attempt: 0,
    });
    unsubscribe();
  });
});
