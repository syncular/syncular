import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  type ClientDiagnosticsSnapshot,
  ClientSyncError,
  SyncClient,
  type SyncProgress,
  httpSyncTransport,
  MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
  MAX_DIAGNOSTIC_QUERY_FAILURES,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { encodeMessage } from '@syncular/core';
import { CLIENT_SCHEMA, makeClient, makeServer, taskValues } from './helpers';

describe('privacy-safe client diagnostics', () => {
  test('publishes bounded transport evidence and clears it on recovery', async () => {
    const secret = 'https://user:password@example.invalid/private?token=secret';
    const response = encodeMessage({
      wireVersion: 3,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'epoch-1', resetRequired: true },
      ],
    });
    for (const fixture of [
      { kind: 'network', connectivity: 'offline', retry: undefined },
      { kind: 'status', status: 500, connectivity: 'online', retry: 250 },
      { kind: 'status', status: 401, connectivity: 'online', retry: undefined },
      { kind: 'timeout', connectivity: 'unknown', retry: 250 },
      { kind: 'unknown', connectivity: 'unknown', retry: 250 },
    ] as const) {
      const db = new BunClientDatabase();
      let healthy = false;
      const doFetch = Object.assign(
        async () => {
          if (healthy)
            return new Response(response.slice().buffer as ArrayBuffer);
          if (fixture.kind === 'network') throw new TypeError(secret);
          if (fixture.kind === 'timeout')
            throw new DOMException(secret, 'TimeoutError');
          if (fixture.kind === 'unknown') throw new Error(secret);
          return fixture.status === 401
            ? Response.json(
                {
                  code: 'sync.auth_required',
                  message: secret,
                  details: { secret },
                },
                { status: 401 },
              )
            : new Response(secret, { status: fixture.status });
        },
        { preconnect: fetch.preconnect },
      );
      const client = new SyncClient({
        schema: { version: 1, tables: [] },
        database: db,
        clientId: 'diagnostic-classification',
        transport: httpSyncTransport('https://example.invalid/sync', {
          fetch: doFetch,
        }),
      });
      const progress: SyncProgress[] = [];
      const diagnostics: ClientDiagnosticsSnapshot[] = [];
      client.onProgress((value) => progress.push(value));
      client.onDiagnostics((value) => diagnostics.push(value));
      try {
        await client.start();
        const code =
          'status' in fixture && fixture.status === 401
            ? 'sync.auth_required'
            : 'sync.transport_failed';
        const expected = {
          causeKind: fixture.kind,
          ...('status' in fixture ? { httpStatus: fixture.status } : {}),
        };
        await expect(client.sync()).rejects.toMatchObject({
          code,
          details: expected,
        });
        expect(client.progressSnapshot()).toMatchObject({
          state: 'failed',
          errorCode: code,
          ...expected,
        });
        expect(client.progressSnapshot()?.retryDelayMs).toBe(fixture.retry);
        const snapshot = client.diagnosticsSnapshot();
        expect(snapshot.host.connectivity).toBe(fixture.connectivity);
        expect(snapshot.lastRound).toMatchObject({
          status: 'failed',
          errorCode: code,
          ...expected,
        });
        expect(progress.at(-1)).toEqual(client.progressSnapshot());
        expect(diagnostics.at(-1)?.lastRound).toEqual(snapshot.lastRound);
        expect(JSON.stringify({ progress, diagnostics })).not.toContain(secret);

        healthy = true;
        await client.sync();
        expect(client.progressSnapshot()).toMatchObject({ state: 'complete' });
        expect(client.progressSnapshot()).not.toHaveProperty('causeKind');
        expect(client.progressSnapshot()).not.toHaveProperty('httpStatus');
        expect(client.diagnosticsSnapshot().host.connectivity).toBe('online');
        expect(client.diagnosticsSnapshot().lastRound).toMatchObject({
          status: 'succeeded',
        });
        expect(client.diagnosticsSnapshot().lastRound).not.toHaveProperty(
          'causeKind',
        );
        expect(client.diagnosticsSnapshot().lastRound).not.toHaveProperty(
          'httpStatus',
        );
      } finally {
        await client.close();
        db.close();
      }
    }
  });

  test('omits untrusted or malformed transport detail members', async () => {
    const secret = 'private-transport-value';
    for (const details of [
      { causeKind: secret, httpStatus: 500, secret },
      { causeKind: 'status', httpStatus: 600, secret },
      { causeKind: 'status', httpStatus: 500.5, secret },
      { causeKind: 'status', httpStatus: '500', secret },
      { causeKind: 'network', httpStatus: 500, secret },
    ]) {
      const db = new BunClientDatabase();
      const client = new SyncClient({
        schema: { version: 1, tables: [] },
        database: db,
        clientId: 'diagnostic-bounds',
        transport: async () => {
          throw new ClientSyncError(
            'sync.transport_failed',
            secret,
            true,
            details,
          );
        },
      });
      try {
        await client.start();
        await expect(client.sync()).rejects.toBeInstanceOf(ClientSyncError);
        const progress = client.progressSnapshot();
        const snapshot = client.diagnosticsSnapshot();
        expect(progress).not.toHaveProperty('httpStatus');
        expect(snapshot.lastRound).not.toHaveProperty('httpStatus');
        if (details.causeKind === secret) {
          expect(progress).not.toHaveProperty('causeKind');
          expect(snapshot.lastRound).not.toHaveProperty('causeKind');
        }
        expect(JSON.stringify({ progress, snapshot })).not.toContain(secret);
      } finally {
        await client.close();
        db.close();
      }
    }
  });

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
    expect(offline.host.connectivity).toBe('unknown');
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

  test('classifies, orders, bounds, and clears owned query failures', async () => {
    const server = makeServer();
    const fixture = await makeClient(server, {
      clientId: 'diagnostics-query-failures',
    });
    const database = fixture.db as unknown as {
      query: typeof fixture.db.query;
    };
    const originalQuery = database.query.bind(fixture.db);
    let sqliteCode = 266;
    database.query = (sql, params) => {
      if (sql === 'SELECT id FROM tasks /* fail-owned */') {
        const error = new Error('private SQLite prose');
        error.name = 'SQLiteError';
        Object.assign(error, { errno: sqliteCode });
        throw error;
      }
      return originalQuery(sql, params);
    };

    const owner = { id: 'queries:listTasks', tables: ['tasks', 'tasks'] };
    expect(() =>
      fixture.client.querySnapshot({
        sql: 'SELECT id FROM tasks /* fail-owned */',
        owner,
      }),
    ).toThrow('local SQLite storage I/O failed');
    expect(fixture.client.diagnosticsSnapshot().queryFailures).toEqual([
      {
        id: 'queries:listTasks',
        tables: ['tasks'],
        code: 'client.storage_io',
        sqliteCode: 266,
        atMs: server.now.ms,
      },
    ]);

    server.now.ms += 1;
    sqliteCode = 11;
    expect(() =>
      fixture.client.querySnapshot({
        sql: 'SELECT id FROM tasks /* fail-owned */',
        owner,
      }),
    ).toThrow('local SQLite storage is corrupt');
    expect(fixture.client.diagnosticsSnapshot().queryFailures[0]).toEqual({
      id: 'queries:listTasks',
      tables: ['tasks'],
      code: 'client.storage_corrupt',
      sqliteCode: 11,
      atMs: server.now.ms,
    });

    database.query = originalQuery;
    fixture.client.querySnapshot({ sql: 'SELECT id FROM tasks', owner });
    expect(fixture.client.diagnosticsSnapshot().queryFailures).toEqual([]);

    for (let index = 0; index <= MAX_DIAGNOSTIC_QUERY_FAILURES; index += 1) {
      expect(() =>
        fixture.client.querySnapshot({
          sql: `SELECT * FROM missing_${index}`,
          owner: { id: `query-${index}`, tables: ['tasks'] },
        }),
      ).toThrow();
    }
    const bounded = fixture.client.diagnosticsSnapshot().queryFailures;
    expect(bounded).toHaveLength(MAX_DIAGNOSTIC_QUERY_FAILURES);
    expect(bounded[0]?.id).toBe('query-1');
    expect(bounded.at(-1)).toMatchObject({
      id: `query-${MAX_DIAGNOSTIC_QUERY_FAILURES}`,
      code: 'client.query_failed',
    });
    expect(JSON.stringify(bounded)).not.toContain('missing_');
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
