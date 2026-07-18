import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  ClientSyncError,
  MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
} from '@syncular/client';
import { CLIENT_SCHEMA, makeClient, makeServer, taskValues } from './helpers';

describe('privacy-safe client diagnostics', () => {
  test('distinguishes intent, bootstrap, zero-row completion, local work, and offline failure', async () => {
    const server = makeServer();
    const fixture = await makeClient(server, {
      clientId: 'private-device-id',
    });
    const expected = [{ id: 'tasks-membership', table: 'tasks' }] as const;

    const missing = fixture.client.diagnosticsSnapshot({
      expectedSubscriptions: expected,
    });
    expect(missing).toMatchObject({
      version: 1,
      host: { kind: 'direct', role: 'single', connectivity: 'unknown' },
      subscriptions: [
        {
          id: 'tasks-membership',
          table: 'tasks',
          state: 'unregistered',
          complete: false,
        },
      ],
      storage: { status: 'healthy' },
    });

    const events: string[] = [];
    fixture.client.onDiagnostics((snapshot) => {
      events.push(snapshot.replica.localRevision);
    });
    fixture.client.subscribe({
      id: 'tasks-membership',
      table: 'tasks',
      scopes: { project_id: ['private-scope-value'] },
    });
    expect(
      fixture.client.diagnosticsSnapshot({
        expectedSubscriptions: expected,
      }).subscriptions[0],
    ).toMatchObject({ state: 'bootstrapping', complete: false, cursor: -1 });

    // A bootstrap with zero matching rows is complete, not missing/unknown.
    await fixture.client.syncUntilIdle();
    const complete = fixture.client.diagnosticsSnapshot({
      expectedSubscriptions: expected,
    });
    expect(complete.subscriptions[0]).toMatchObject({
      state: 'complete',
      complete: true,
    });
    expect(complete.lastRound).toMatchObject({ status: 'succeeded' });
    expect(complete.host.connectivity).toBe('online');

    fixture.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues(
          'private-row-id',
          'private-scope-value',
          'private-clinical-title',
        ),
      },
    ]);
    const queued = fixture.client.diagnosticsSnapshot();
    expect(queued.replica.pendingOutbox).toBe(1);
    expect(queued.storage.pendingOutboxBytesApprox).toBeGreaterThan(0);
    expect(queued.lastChange).toMatchObject({ tables: ['tasks'] });
    expect(events.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(queued);
    for (const forbidden of [
      'private-device-id',
      'private-scope-value',
      'private-row-id',
      'private-clinical-title',
      'SELECT ',
      'operations',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    fixture.faults.dropResponseOnce = true;
    await expect(fixture.client.sync()).rejects.toThrow();
    const offline = fixture.client.diagnosticsSnapshot();
    expect(offline.host.connectivity).toBe('offline');
    expect(offline.lastRound).toMatchObject({
      status: 'failed',
      errorCode: 'sync.transport_failed',
    });
  });

  test('bounds intent and remains protected during security preflight', async () => {
    const fixture = await makeClient(makeServer(), {
      clientId: 'diagnostics-policy',
    });
    expect(() =>
      fixture.client.diagnosticsSnapshot({
        expectedSubscriptions: Array.from(
          { length: MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS + 1 },
          (_, index) => ({ id: `sub-${index}`, table: 'tasks' }),
        ),
      }),
    ).toThrow('at most');

    for (let index = 0; index < 260; index += 1) {
      fixture.client.subscribe({
        id: `registered-${index}`,
        table: 'tasks',
        scopes: { project_id: ['private-scope'] },
      });
    }
    const bounded = fixture.client.diagnosticsSnapshot({
      expectedSubscriptions: [
        { id: 'registered-259', table: 'tasks' },
        { id: 'registered-0', table: 'docs' },
      ],
    });
    expect(bounded.subscriptions).toHaveLength(256);
    expect(bounded.subscriptionsTruncated).toBe(true);
    expect(bounded.subscriptions[0]?.id).toBe('registered-259');
    expect(bounded.subscriptions[1]).toMatchObject({
      id: 'registered-0',
      table: 'docs',
      state: 'failed',
      complete: false,
      reasonCode: 'client.subscription_intent_mismatch',
    });
    expect(JSON.stringify(bounded)).not.toContain('private-scope');

    await fixture.client.beginSecurityPreflight();
    try {
      fixture.client.diagnosticsSnapshot();
    } catch (error) {
      expect(error).toBeInstanceOf(ClientSyncError);
      expect((error as ClientSyncError).code).toBe(
        SECURITY_PREFLIGHT_REQUIRED_CODE,
      );
      return;
    }
    throw new Error('expected diagnostics to remain protected in preflight');
  });

  test('reports lease health without exposing the lease handle', async () => {
    const server = makeServer(undefined, { leases: { ttlMs: 100 } });
    const fixture = await makeClient(server, {
      clientId: 'diagnostics-lease',
    });
    fixture.client.subscribe({
      id: 'tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await fixture.client.syncUntilIdle();
    const active = fixture.client.diagnosticsSnapshot();
    expect(active.lease).toMatchObject({ state: 'active' });
    expect(JSON.stringify(active)).not.toContain('lease-private-id');

    server.resolverOutage.value = true;
    server.now.ms += 101;
    await expect(fixture.client.sync()).rejects.toMatchObject({
      code: 'sync.auth_lease_required',
    });
    const stopped = fixture.client.diagnosticsSnapshot();
    expect(stopped.lease).toMatchObject({
      state: 'stopped',
      errorCode: 'sync.auth_lease_required',
    });
    expect(JSON.stringify(stopped)).not.toContain('lease-private-id');
  });

  test('reports bounded blob-cache pressure without body or row details', async () => {
    const blobSchema: ClientSchema = {
      ...CLIENT_SCHEMA,
      tables: CLIENT_SCHEMA.tables.map((table) =>
        table.name === 'tasks'
          ? {
              ...table,
              columns: [
                ...table.columns,
                {
                  name: 'attachment',
                  type: 'blob_ref' as const,
                  nullable: true,
                },
              ],
            }
          : table,
      ),
    };
    const fixture = await makeClient(makeServer(), {
      clientId: 'diagnostics-pressure',
      schema: blobSchema,
      blobCacheMaxBytes: 0,
      blobs: {
        upload: async () => {},
        download: async () => ({
          kind: 'bytes',
          bytes: new Uint8Array(),
        }),
      },
    });
    await fixture.client.uploadBlob(new Uint8Array([1, 2, 3, 4]));
    const snapshot = fixture.client.diagnosticsSnapshot();
    expect(snapshot.storage).toMatchObject({
      status: 'pressure',
      blobCacheBytesApprox: 4,
      pressureReasonCode: 'client.blob_cache_over_limit',
    });
    expect(JSON.stringify(snapshot)).not.toContain('1,2,3,4');
  });

  test('reports an opened-but-unreadable storage probe without leaking its cause', async () => {
    const fixture = await makeClient(makeServer(), {
      clientId: 'diagnostics-unreadable',
    });
    const database = fixture.db as unknown as {
      query: typeof fixture.db.query;
    };
    const originalQuery = database.query.bind(fixture.db);
    database.query = (sql, params) => {
      if (sql === 'PRAGMA page_count') {
        throw new Error('/private/path/app.db is corrupt');
      }
      return originalQuery(sql, params);
    };
    const snapshot = fixture.client.diagnosticsSnapshot();
    expect(snapshot.storage).toEqual({ status: 'unreadable' });
    expect(JSON.stringify(snapshot)).not.toContain('/private/path');
    expect(JSON.stringify(snapshot)).not.toContain('corrupt');
  });
});
