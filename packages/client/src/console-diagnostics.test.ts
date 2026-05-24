import { describe, expect, it } from 'bun:test';
import {
  buildSyncularConsoleDiagnosticsPayload,
  createSyncularConsoleDiagnosticsPublisher,
} from './console-diagnostics';
import type {
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLifecycleState,
  SyncularNetworkStatusSource,
  SyncularRuntimeClient,
} from './types';

describe('Syncular console diagnostics', () => {
  it('compacts oversized diagnostic snapshots before posting', () => {
    const snapshot = makeSnapshot({ diagnosticCount: 90, generatedAt: 1 });
    const result = buildSyncularConsoleDiagnosticsPayload({
      actorId: 'actor',
      clientId: 'client',
      lifecycle: makeLifecycle(),
      maxPayloadBytes: 12_000,
      snapshot,
    });

    expect(result.byteLength).toBeLessThanOrEqual(12_000);
    const body = JSON.parse(result.body) as {
      snapshot: {
        recentDiagnostics: Array<{ details?: Record<string, unknown> }>;
      };
    };
    expect(body.snapshot.recentDiagnostics.length).toBeLessThanOrEqual(10);
    for (const event of body.snapshot.recentDiagnostics) {
      expect(event.details?.changedRows).toBeUndefined();
      expect(event.details?.bootstrap).not.toHaveProperty('subscriptions');
    }
  });

  it('publishes managed diagnostics without subscribing to lifecycle changes', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({ input, init });
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    const fake = createFakeDiagnosticsClient();
    try {
      const publisher = createSyncularConsoleDiagnosticsPublisher(fake.client, {
        baseUrl: 'http://example.test/console',
        config: {
          actorId: 'actor',
          baseUrl: 'http://example.test/sync',
          clientId: 'client',
        },
        debounceMs: false,
        isClosed: () => false,
        network: alwaysOnlineNetwork(),
        token: 'console-token',
      });
      await tick();

      expect(requests).toHaveLength(1);
      expect(fake.eventNames).not.toContain('lifecycleChanged');
      expect(requests[0]?.input).toBe(
        'http://example.test/console/client-diagnostics'
      );
      expect(requests[0]?.init?.headers).toMatchObject({
        Authorization: 'Bearer console-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
        actorId: 'actor',
        clientId: 'client',
        partitionId: 'default',
      });

      publisher.destroy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dedupes unchanged snapshots even when generatedAt changes', async () => {
    const requests: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(init ?? {});
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    let generatedAt = 1;
    const fake = createFakeDiagnosticsClient(() =>
      makeSnapshot({ diagnosticCount: 1, generatedAt: generatedAt++ })
    );
    try {
      const publisher = createSyncularConsoleDiagnosticsPublisher(fake.client, {
        baseUrl: 'http://example.test/console',
        config: {
          actorId: 'actor',
          baseUrl: 'http://example.test/sync',
          clientId: 'client',
        },
        debounceMs: false,
        isClosed: () => false,
        network: alwaysOnlineNetwork(),
      });
      await tick();
      publisher.schedule();
      await tick();

      expect(requests).toHaveLength(1);
      publisher.destroy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createFakeDiagnosticsClient(
  snapshot: () => SyncularDiagnosticSnapshot = () =>
    makeSnapshot({ diagnosticCount: 1, generatedAt: 1 })
): {
  client: Pick<
    SyncularRuntimeClient,
    | 'addDiagnosticListener'
    | 'addEventListener'
    | 'diagnosticSnapshot'
    | 'lifecycleState'
  >;
  eventNames: string[];
} {
  const eventNames: string[] = [];
  return {
    client: {
      addDiagnosticListener() {
        return () => {};
      },
      addEventListener(event) {
        eventNames.push(event);
        return () => {};
      },
      async diagnosticSnapshot() {
        return snapshot();
      },
      lifecycleState() {
        return makeLifecycle();
      },
    },
    eventNames,
  };
}

function makeSnapshot(args: {
  diagnosticCount: number;
  generatedAt: number;
}): SyncularDiagnosticSnapshot {
  return {
    generatedAt: args.generatedAt,
    runtime: {
      packageName: '@syncular/client',
      packageVersion: '0.0.0',
      workerProtocolVersion: 2,
      storage: 'indexedDb',
      workerUrl:
        'http://localhost:5173/@fs/packages/client/src/worker-entry.ts',
      wasmGlueUrl:
        'http://localhost:5173/@fs/rust/bindings/javascript/dist/wasm/syncular.js',
      wasmUrl:
        'http://localhost:5173/@fs/rust/bindings/javascript/dist/wasm/syncular_bg.wasm',
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
      lastDiagnostic: makeDiagnostic(999),
    },
    subscriptions: [
      {
        bootstrapPhase: 0,
        bootstrapState: null,
        cursor: 100,
        id: 'sub-tasks',
        paramsKeys: [],
        paramsValueCount: 0,
        phase: 'live',
        progressPercent: 100,
        ready: true,
        scopeKeys: ['user_id'],
        scopeValueCount: 1,
        status: 'active',
        table: 'tasks',
      },
    ],
    recentDiagnostics: Array.from(
      { length: args.diagnosticCount },
      (_, index) => makeDiagnostic(index)
    ),
    recentSyncTimings: Array.from({ length: 30 }, (_, index) => ({
      commitApplyMs: index,
      notifyMs: index,
      pullApplyMs: index,
      pullRequestMs: index,
      pushMs: index,
      totalMs: index,
    })),
    bootstrap: {
      activePhase: null,
      channelPhase: 'live',
      complete: true,
      criticalReady: true,
      expectedSubscriptionIds: ['sub-tasks'],
      interactiveReady: true,
      isBootstrapping: false,
      pendingSubscriptionIds: [],
      phases: [{ phase: 0 }],
      progressPercent: 100,
      readySubscriptionIds: ['sub-tasks'],
      subscriptions: [{ id: 'sub-tasks' }],
    },
    conflictStats: { resolved: 0, total: 0, unresolved: 0 },
    outboxStats: { acked: 1, failed: 0, pending: 0, sending: 0, total: 1 },
  };
}

function makeLifecycle(): SyncularLifecycleState {
  return {
    online: true,
    pendingRequests: 0,
    phase: 'complete',
    realtime: 'connected',
    requiresAction: false,
    lastDiagnostic: makeDiagnostic(999),
  };
}

function makeDiagnostic(index: number): SyncularDiagnosticEvent {
  return {
    at: index,
    code: 'sync.syncOnce.completed',
    details: {
      bootstrap: {
        activePhase: null,
        complete: true,
        expectedSubscriptionIds: ['sub-tasks'],
        phases: [{ phase: 0 }],
        progressPercent: 100,
        readySubscriptionIds: ['sub-tasks'],
        subscriptions: [{ id: 'sub-tasks' }],
      },
      changedRowCount: 1,
      changedRows: [
        {
          changedFields: ['server_version'],
          commitId: String(index),
          commitSeq: index,
          operation: 'update',
          rowId: `row-${index}`,
          serverVersion: index,
          subscriptionId: 'sub-tasks',
          table: 'tasks',
        },
      ],
      changedRowsTruncated: false,
      changedTableCount: 1,
      changedTables: ['tasks'],
      durationMs: 12,
      pushedCommits: 1,
      requestType: 'syncOnce',
    },
    level: 'info',
    message: 'Syncular worker request syncOnce completed',
    source: 'sync',
    spanId: `span-${index}`,
    syncAttemptId: `attempt-${index}`,
    traceId: `trace-${index}`,
  };
}

function alwaysOnlineNetwork(): SyncularNetworkStatusSource {
  return {
    isOnline: () => true,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
