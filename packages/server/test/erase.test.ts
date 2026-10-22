/**
 * `eraseScopeValue` (SPEC.md §4.6.1) on every in-tree storage: rows of the
 * binding leave through delete commits, the change log keeps no payload of
 * the binding, and blob bytes leave with their last reference.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  blobIdFor,
  compileSchema,
  D1ServerStorage,
  eraseScopeValue,
  type EraseScopeValueResult,
  MemoryBlobStore,
  MemorySegmentStore,
  PostgresServerStorage,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  StorageQueryError,
  type SyncServerConfig,
  seedMutations,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';

const PARTITION = 'part-1';

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'files',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'org_id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'file', type: 'blob_ref', nullable: true },
      ],
      primaryKey: 'id',
      scopes: ['org:{org_id}', 'project:{project_id}'],
    },
  ],
};

const fixtures: readonly {
  readonly name: string;
  open(): Promise<ServerStorage>;
}[] = [
  { name: 'SQLite', open: async () => new SqliteServerStorage() },
  {
    name: 'PostgreSQL/PGlite',
    open: async () =>
      new PostgresServerStorage(pgliteExecutor(await PGlite.create())),
  },
  {
    name: 'D1',
    open: async () => {
      // Sequential calls supply the serialization a D1 host gets from its DO.
      const storage = new D1ServerStorage(new D1DatabaseDouble(), {
        pushApplySerialized: true,
      });
      while (!(await storage.migrateSchema(compileSchema(SCHEMA))).complete) {}
      return storage;
    },
  },
];

async function eraseAll(
  config: SyncServerConfig,
  value: string,
): Promise<EraseScopeValueResult[]> {
  const steps: EraseScopeValueResult[] = [];
  for (;;) {
    const step = await eraseScopeValue(config, {
      partition: PARTITION,
      variable: 'project_id',
      value,
      maxRows: 2,
    });
    steps.push(step);
    if (step.done) return steps;
  }
}

describe('eraseScopeValue', () => {
  for (const fixture of fixtures) {
    test(`${fixture.name}: erases rows, history and unreferenced blobs of one binding`, async () => {
      const storage = await fixture.open();
      const blobs = new MemoryBlobStore();
      const config: SyncServerConfig = {
        schema: SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        blobs,
        resolveScopes: () => ({ project_id: ['*'], org_id: ['*'] }),
        // Erasure ignores app validators.
        commitValidator: () => {
          throw new Error('validators must not gate erasure');
        },
        clock: () => 1_000,
      };
      const own = new Uint8Array([1, 1]);
      const shared = new Uint8Array([2, 2]);
      const ownId = await blobIdFor(own);
      const sharedId = await blobIdFor(shared);
      await blobs.put(PARTITION, ownId, own, 1_000, 'image/png');
      await blobs.put(PARTITION, sharedId, shared, 1_000, 'image/png');
      const ref = (blobId: string) => JSON.stringify({ blobId, byteLength: 2 });
      const target = { partition: PARTITION, actorId: 'a', clientId: 'seed' };
      const { commitValidator, ...seedConfig } = config;
      const task = (id: string, project: string, title: string) => ({
        table: 'tasks',
        op: 'upsert' as const,
        values: { id, project_id: project, title },
      });
      const file = (id: string, project: string, blobId: string) => ({
        table: 'files',
        op: 'upsert' as const,
        values: { id, org_id: 'o1', project_id: project, file: ref(blobId) },
      });
      await seedMutations(seedConfig, { ...target, commitId: 'c1' }, [
        task('t1', 'p1', 'secret'),
        task('t2', 'p2', 'keep'),
        task('t3', 'p1', 'deleted before'),
        file('f1', 'p1', ownId),
        file('f2', 'p2', sharedId),
        file('f3', 'p1', sharedId),
      ]);
      await seedMutations(seedConfig, { ...target, commitId: 'c2' }, [
        task('t1', 'p1', 'secret, edited'),
        { table: 'tasks', op: 'delete', rowId: 't3' },
      ]);

      const steps = await eraseAll(config, 'p1');
      // 3 live rows at 2 per commit, then budgeted history passes, then
      // the empty pass.
      expect(steps.slice(0, 3).map((step) => step.rowsErased)).toEqual([
        2, 1, 0,
      ]);
      expect(steps.slice(2).every((step) => step.rowsErased === 0)).toBe(true);
      expect(steps.flatMap((step) => step.blobsErased)).toEqual([ownId]);
      expect(steps.slice(2, -1).every((step) => step.historyErased > 0)).toBe(
        true,
      );
      expect(steps.at(-1)?.historyErased).toBe(0);
      for (const id of ['t1', 't3'])
        expect(await storage.getRow(PARTITION, 'tasks', id)).toBeUndefined();
      for (const id of ['f1', 'f3'])
        expect(await storage.getRow(PARTITION, 'files', id)).toBeUndefined();
      expect(await storage.getRow(PARTITION, 'tasks', 't2')).toBeDefined();
      expect(await storage.getRow(PARTITION, 'files', 'f2')).toBeDefined();
      expect(await blobs.has(PARTITION, ownId)).toBe(false);
      expect(await blobs.has(PARTITION, sharedId)).toBe(true);

      // The log keeps the erasure deletes and no payload of the binding.
      const maxSeq = await storage.getMaxCommitSeq(PARTITION);
      const changes = [];
      for (let seq = 1; seq <= maxSeq; seq += 1) {
        const commit = await storage.getCommit!(PARTITION, seq);
        for (const change of commit?.changes ?? [])
          changes.push({ seq, ...change });
      }
      const bound = changes.filter(
        (change) => change.scopes.project_id === 'p1',
      );
      expect(bound.every((change) => change.op === 'delete')).toBe(true);
      expect(bound.map((change) => change.rowId).sort()).toEqual([
        'f1',
        'f3',
        't1',
        't3',
      ]);
      expect(
        changes.filter((change) => change.scopes.project_id === 'p2'),
      ).toHaveLength(2);
      // The change scope index names only commits that still hold a change.
      const activity = await storage.scopeActivity!(PARTITION, {
        variable: 'project_id',
        value: 'p1',
        limit: 100,
      });
      expect(
        activity.every((entry) =>
          bound.some(
            (change) =>
              change.seq === entry.commitSeq && change.table === entry.table,
          ),
        ),
      ).toBe(true);
      // The erasure commits advance the binding: no older segment is reused.
      for (const [table, step] of [
        ['tasks', steps[0]],
        ['files', steps[1]],
      ] as const) {
        expect(
          await storage.latestScopedChangeSeq(PARTITION, {
            table,
            scopeFilter: { project_id: ['p1'] },
          }),
        ).toBe(step!.commitSeq!);
      }

      // A finished erasure is a no-op.
      expect(await eraseAll(config, 'p1')).toEqual([
        { rowsErased: 0, historyErased: 0, blobsErased: [], done: true },
      ]);
    });
  }

  test('rejects an undeclared variable, an empty value and an oversized budget', async () => {
    const config: SyncServerConfig = {
      schema: SCHEMA,
      storage: new SqliteServerStorage(),
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({}),
    };
    for (const options of [
      { variable: 'user_id', value: 'u1' },
      { variable: 'project_id', value: '' },
      { variable: 'project_id', value: 'p1', maxRows: 501 },
    ]) {
      const erasing = eraseScopeValue(config, {
        partition: PARTITION,
        ...options,
      });
      await expect(erasing).rejects.toBeInstanceOf(StorageQueryError);
      await expect(erasing).rejects.toMatchObject({
        code: 'sync.storage.invalid_erase_query',
      });
    }
  });

  test('an unregistered partition has nothing to erase', async () => {
    const result = await eraseScopeValue(
      {
        schema: SCHEMA,
        storage: new SqliteServerStorage(),
        segments: new MemorySegmentStore(),
        resolveScopes: () => ({}),
      },
      { partition: 'nowhere', variable: 'project_id', value: 'p1' },
    );
    expect(result).toEqual({
      rowsErased: 0,
      historyErased: 0,
      blobsErased: [],
      done: true,
    });
  });
});
