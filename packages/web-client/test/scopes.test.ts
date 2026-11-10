/**
 * Effective-scope persistence and the §3.3 revocation purge contract:
 * purge is keyed on the LAST-echoed effective scopes (not the requested
 * map), doomed outbox writes are dropped, unrelated scopes survive, and a
 * missing local scope-column mapping fails closed.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  type ClientChangeBatch,
  SyncClient,
  type ClientSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  handleSyncRequest,
  MemorySegmentStore,
  PostgresServerStorage,
  SqliteServerStorage,
  ValidationRejection,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { schema as generatedSchema } from '../../typegen/test/fixtures/basic/syncular.generated';
import {
  docsInProjectQuery,
  facilityDocsQuery,
} from '../../typegen/test/fixtures/basic/syncular.queries';
import {
  DOC_COLUMNS,
  makeClient,
  makeServer,
  TASK_COLUMNS,
  tableRows,
  taskValues,
} from './helpers';

describe('effective-scope echo persistence (§3.2, §3.3)', () => {
  test('the persisted effective scopes are the intersection, not the request', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    await a.client.syncUntilIdle();
    // Requested [p1, p2] ∩ allowed [p1] = [p1] (§3.2 rule 4).
    expect(a.client.subscription('s1')?.effectiveScopes).toEqual({
      project_id: ['p1'],
    });
  });

  test('the echo refreshes on every active pull', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    await a.client.syncUntilIdle();
    server.allowed['actor-1'] = {
      project_id: ['p1', 'p2'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    await a.client.sync();
    expect(a.client.subscription('s1')?.effectiveScopes).toEqual({
      project_id: ['p1', 'p2'],
    });
  });
});

describe('re-arming a revoked subscription (§3.3)', () => {
  test('the same id and intent re-arms it and the rows arrive', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p2'],
      projectId: ['p2'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    const revoked = await a.client.syncUntilIdle();
    expect(revoked.revoked).toEqual(['s1']);
    expect(a.client.subscription('s1')?.status).toBe('revoked');

    // The grant arrives after the first subscribe; the app subscribes again
    // with the same id and intent.
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    a.intents.length = 0;
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    expect(a.client.subscription('s1')).toEqual({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
      cursor: -1,
      status: 'active',
    });
    expect(a.intents).toEqual([{ kind: 'interactive' }]);

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'tasks').map((row) => row.id)).toEqual(['t1']);
    expect(a.client.subscription('s1')?.effectiveScopes).toEqual({
      project_id: ['p1'],
    });
  });
});

describe('revocation purge (§3.3)', () => {
  test('purges exactly the last-effective rows and stops pulling', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      // p2 is requested but never becomes effective (§3.3: not purged).
      scopes: { project_id: ['p1', 'p2'] },
    });
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'synced'),
      },
    ]);
    await a.client.syncUntilIdle();
    // Local-only rows: one inside the subscribed table but in p2 (never
    // effective), one in a different table entirely.
    a.db.exec(
      `INSERT INTO "tasks" (id, project_id, title, done, priority, meta, _sync_version)
       VALUES ('local-p2', 'p2', 'local only', 0, NULL, NULL, 0)`,
    );
    a.db.exec(
      `INSERT INTO "docs" (id, org_id, project_id, body, _sync_version)
       VALUES ('d1', 'o1', 'p1', 'doc body', 0)`,
    );
    // Pending outbox commits at revocation time: one into the revoked
    // scope (guaranteed rejection), one into a still-held scope.
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t2', 'p1', 'doomed'),
      },
    ]);
    const keptCommit = a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t3', 'p3', 'kept') },
    ]);

    // The host re-homes the actor to p3 only: [p1,p2] ∩ [p3] = ∅ → revoked.
    server.allowed['actor-1'] = {
      project_id: ['p3'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const summary = await a.client.sync();
    expect(summary.revoked).toEqual(['s1']);
    // The doomed commit was rejected by write-path authorization (§3.4)
    // in the same combined request; the p3 commit applied.
    expect(summary.rejected).toHaveLength(1);
    expect(summary.applied).toEqual([keptCommit]);
    expect(a.client.rejections()[0]?.code).toBe('sync.forbidden');
    expect(a.client.pendingCommits()).toHaveLength(0);

    const sub = a.client.subscription('s1');
    expect(sub?.status).toBe('revoked');
    expect(sub?.reasonCode).toBe('sync.scope_revoked');
    expect(a.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      id: 's1',
      state: 'revoked',
      complete: false,
      reasonCode: 'sync.scope_revoked',
    });

    const ids = tableRows(a.db, 'tasks').map((r) => r.id);
    expect(ids).not.toContain('t1'); // purged: matches effective p1
    expect(ids).toContain('local-p2'); // requested-but-never-effective survives
    expect(ids).toContain('t3'); // the applied p3 row is not the purge's to destroy
    expect(tableRows(a.db, 'docs')).toHaveLength(1); // other table untouched

    // The subscription is no longer pulled.
    const next = await a.client.sync();
    expect(next.revoked).toHaveLength(0);
    expect(a.client.subscription('s1')?.status).toBe('revoked');
  });

  test('a throwing resolver revokes (fail loud, §3.2 rule 5)', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    server.resolverError.value = true;
    const summary = await a.client.sync();
    expect(summary.revoked).toEqual(['s1']);
    expect(tableRows(a.db, 'tasks')).toHaveLength(0);
  });

  test('fails closed when the table has no local mapping for an effective key', async () => {
    const server = makeServer();
    // A (mis)generated client schema whose tasks table maps variable
    // `proj`, so the echoed `project_id` key has no local column mapping.
    const mismatchedSchema: ClientSchema = {
      version: 1,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS,
          primaryKey: 'id',
          scopes: [{ pattern: 'project:{proj}', column: 'project_id' }],
        },
        {
          name: 'docs',
          columns: DOC_COLUMNS,
          primaryKey: 'id',
          scopes: ['org:{org_id}'],
        },
      ],
    };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: mismatchedSchema,
    });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    // The very first fresh bootstrap already needs the mapping (§5.6 uses
    // the §3.3 matching rule) — it fails closed immediately.
    const summary = await a.client.sync();
    expect(summary.applied).toHaveLength(1); // the push half still worked
    expect(summary.failed).toEqual(['s1']);
    // Precision or nothing: the table is NOT cleared as an approximation.
    expect(tableRows(a.db, 'tasks')).toHaveLength(1);
    const sub = a.client.subscription('s1');
    expect(sub?.status).toBe('failed');
    expect(sub?.reasonCode).toBe('sync.scope_revoked');
    expect(sub?.cursor).toBe(-1); // SUB_END was never persisted (§1.4)
    expect(a.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      id: 's1',
      state: 'failed',
      complete: false,
      reasonCode: 'sync.scope_revoked',
    });

    // The table is no longer synced.
    const next = await a.client.sync();
    expect(next.failed).toHaveLength(0);
    expect(a.client.subscription('s1')?.status).toBe('failed');

    // A failed registration is a configuration error, not a revocation:
    // subscribing again with the same intent leaves it failed.
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    expect(a.client.subscription('s1')?.status).toBe('failed');
  });
});

for (const backend of ['sqlite', 'pglite'] as const) {
  test(`${backend}: generated partial coverage synchronizes only authorized facility rows`, async () => {
    const pg = backend === 'pglite' ? await PGlite.create() : undefined;
    const storage = pg
      ? new PostgresServerStorage(pgliteExecutor(pg))
      : new SqliteServerStorage();
    const segments = new MemorySegmentStore();
    const serverSchema = {
      ...generatedSchema,
      tables: generatedSchema.tables.map((table) =>
        table.name === 'docs'
          ? { ...table, writeScopeVariables: ['org_id'] }
          : table,
      ),
    };
    const grants: Record<string, Record<string, string[]>> = {
      seed: { org_id: ['o1', 'o2'] },
      host: { org_id: ['o1'] },
      historical: { projectId: ['old'] },
      intersection: { org_id: ['o1'], projectId: ['old'] },
    };
    const databases = Array.from({ length: 4 }, () => new BunClientDatabase());
    const clients = ['seed', 'host', 'historical', 'intersection'].map(
      (actorId, index) =>
        new SyncClient({
          schema: generatedSchema,
          database: databases[index]!,
          clientId: `generated-${actorId}`,
          retainFailedCommits: true,
          transport: (bytes) =>
            handleSyncRequest(bytes, {
              partition: 'part-1',
              actorId,
              schema: serverSchema,
              storage,
              segments,
              resolveScopes: () => grants[actorId]!,
              validators: {
                docs: (operation) => {
                  if (operation.row?.body === 'reject') {
                    throw new ValidationRejection('app.rejected', 'rejected');
                  }
                },
              },
            }),
        }),
    );
    const [seed, host, historical, intersection] = clients;
    const row = (id: string, org_id: string, project_id: string) => ({
      id,
      org_id,
      project_id,
      body: id,
      score: null,
      attachment: null,
      body_doc: null,
      remote_blob: null,
    });
    try {
      for (const client of clients) await client.start();
      seed!.mutate([
        { op: 'upsert', table: 'docs', values: row('old', 'o1', 'old') },
        { op: 'upsert', table: 'docs', values: row('other', 'o1', 'other') },
        {
          op: 'upsert',
          table: 'docs',
          values: row('foreign', 'o2', 'foreign'),
        },
      ]);
      expect((await seed!.syncUntilIdle()).rejected).toEqual([]);
      const params = { orgId: 'o1' };
      const coverage = facilityDocsQuery.coverage(params);
      const facility = coverage[0]!;
      await host!.setWindow(facility.base, facility.units);
      const read = () =>
        host!.querySnapshot({
          sql: facilityDocsQuery.sqlFor?.(params) ?? facilityDocsQuery.sql,
          params: facilityDocsQuery.bind(params),
          coverage,
        });
      expect(read().coverage.complete).toBe(false);
      await host!.syncUntilIdle();
      expect(read().coverage.complete).toBe(true);
      expect(read().rows.map((item) => item.id)).toEqual(['old', 'other']);
      historical!.subscribe({
        id: 'exact',
        table: 'docs',
        scopes: { projectId: ['old'] },
      });
      await historical!.syncUntilIdle();
      const intersectionCoverage = docsInProjectQuery.coverage({
        orgId: 'o1',
        projectId: 'old',
      });
      await intersection!.setWindow(
        intersectionCoverage[0]!.base,
        intersectionCoverage[0]!.units,
      );
      await intersection!.syncUntilIdle();
      expect(intersection!.query('SELECT id FROM docs ORDER BY id')).toEqual([
        { id: 'old' },
      ]);
      host!.setTransportEnabled(false);
      host!.mutate([
        { op: 'upsert', table: 'docs', values: row('new', 'o1', 'new') },
      ]);
      expect(read().rows.map((item) => item.id)).toEqual([
        'new',
        'old',
        'other',
      ]);
      host!.setTransportEnabled(true);
      await host!.syncUntilIdle();
      await historical!.syncUntilIdle();
      await intersection!.syncUntilIdle();
      expect(historical!.query('SELECT id FROM docs ORDER BY id')).toEqual([
        { id: 'old' },
      ]);
      expect(intersection!.query('SELECT id FROM docs ORDER BY id')).toEqual([
        { id: 'old' },
      ]);
      const rejected = host!.patch('docs', 'old', { body: 'reject' });
      await host!.syncUntilIdle();
      const outcome = host!.commitOutcome(rejected)!;
      expect(await host!.proveCurrentBase(outcome)).toMatchObject({
        proven: true,
        rows: [{ rowId: 'old', serverRow: { body: 'old' }, serverVersion: 1 }],
      });
      grants.host = { org_id: [] };
      await host!.syncUntilIdle();
      expect(read().coverage.complete).toBe(false);
      expect(host!.query('SELECT id FROM docs')).toEqual([]);
    } finally {
      for (const client of clients) await client.close();
      for (const database of databases) database.close();
      if (pg) await pg.close();
      else if (storage instanceof SqliteServerStorage) storage.db.close();
    }
  });
}

describe('row ownership across overlapping subscriptions (§3.3, §4.8)', () => {
  const doc = (id: string, org: string, project: string) => ({
    table: 'docs',
    op: 'upsert' as const,
    values: { id, org_id: org, project_id: project, body: id },
  });

  test('window eviction keeps rows another active subscription covers', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('shared', 'p1') },
      { table: 'tasks', op: 'upsert', values: taskValues('window-only', 'p3') },
    ]);
    await a.client.syncUntilIdle();
    a.client.subscribe({
      id: 'all',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    const base = { table: 'tasks', variable: 'project_id' };
    await a.client.setWindow(base, ['p1', 'p3']);
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'tasks').map((row) => row.id)).toEqual([
      'shared',
      'window-only',
    ]);

    await a.client.setWindow(base, []);
    // `all` still covers p1 and keeps claiming completeness for it.
    expect(tableRows(a.db, 'tasks').map((row) => row.id)).toEqual(['shared']);
    expect(a.client.subscription('all')?.cursor).toBeGreaterThanOrEqual(0);
  });

  test('a revocation purge keeps rows another active subscription covers', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.mutate([doc('d1', 'o1', 'p1'), doc('d2', 'o2', 'p1')]);
    await a.client.syncUntilIdle();
    a.client.subscribe({
      id: 'org',
      table: 'docs',
      scopes: { org_id: ['o1'] },
    });
    a.client.subscribe({
      id: 'project',
      table: 'docs',
      scopes: { projectId: ['p1'] },
    });
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'docs').map((row) => row.id)).toEqual(['d1', 'd2']);

    server.allowed['actor-1'] = {
      project_id: ['*'],
      projectId: ['p9'],
      org_id: ['o1'],
    };
    const summary = await a.client.sync();
    expect(summary.revoked).toEqual(['project']);
    expect(a.client.subscription('org')?.status).toBe('active');
    // d1 stays under `org`; d2 had no other owner.
    expect(tableRows(a.db, 'docs').map((row) => row.id)).toEqual(['d1']);
  });

  test('a fresh first-page clear keeps rows a complete subscription owns', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 'org',
      table: 'docs',
      scopes: { org_id: ['o1'] },
    });
    await a.client.syncUntilIdle();
    // A row `org` holds that the p1 bootstrap does not deliver.
    a.db.exec(
      `INSERT INTO "docs" (id, org_id, project_id, body, _sync_version)
       VALUES ('held', 'o1', 'p1', 'held', 1), ('stale', 'o2', 'p1', 'stale', 1)`,
    );
    a.client.subscribe({
      id: 'project',
      table: 'docs',
      scopes: { projectId: ['p1'] },
    });
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'docs').map((row) => row.id)).toEqual(['held']);
  });

  test('a bulk delete whose map omits a scope variable invalidates the whole table', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.mutate([doc('d1', 'o1', 'p1')]);
    await a.client.syncUntilIdle();
    const base = { table: 'docs', variable: 'projectId' };
    await a.client.setWindow(base, ['p1']);
    await a.client.syncUntilIdle();
    const changes: ClientChangeBatch[] = [];
    const off = a.client.onChange((batch) => changes.push(batch));
    await a.client.setWindow(base, []);
    off();
    expect(tableRows(a.db, 'docs')).toEqual([]);
    // A live query keyed by `org:o1` must re-run: the eviction map names
    // only `projectId`, so the change carries no scope keys.
    expect(
      changes
        .flatMap((batch) => batch.tables)
        .filter((t) => t.table === 'docs'),
    ).toEqual([{ table: 'docs' }]);
  });
});
