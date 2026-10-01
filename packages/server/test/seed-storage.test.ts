import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  compileSchema,
  D1ServerStorage,
  MemorySegmentStore,
  PostgresServerStorage,
  SeedMutationError,
  type ServerStorage,
  SqliteServerStorage,
  type SyncServerConfig,
  seedMutations,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';
import { BunSQL, bunSqlExecutor, PG_URL } from './pg-real';
import { TEST_SCHEMA } from './helpers';

interface StorageFixture {
  readonly name: string;
  open(): Promise<{
    readonly storage: ServerStorage;
    readonly close: () => Promise<void>;
  }>;
}

const fixtures: readonly StorageFixture[] = [
  {
    name: 'SQLite/in-memory',
    open: async () => ({
      storage: new SqliteServerStorage(),
      close: async () => {},
    }),
  },
  {
    name: 'PostgreSQL/PGlite',
    open: async () => {
      const db = await PGlite.create();
      return {
        storage: new PostgresServerStorage(pgliteExecutor(db)),
        close: async () => db.close(),
      };
    },
  },
  {
    name: 'D1',
    open: async () => {
      // The fixture runs seed calls sequentially, which supplies the same
      // external serialization that a production D1 host gets from its DO.
      const storage = new D1ServerStorage(new D1DatabaseDouble(), {
        pushApplySerialized: true,
      });
      // D1 budgets DDL per invocation and resumes across invocations by
      // design, so open the fixture by stepping the migration to completion.
      while (
        !(await storage.migrateSchema(compileSchema(TEST_SCHEMA))).complete
      ) {}
      return { storage, close: async () => {} };
    },
  },
];

async function expectSeedError(
  work: Promise<void>,
): Promise<SeedMutationError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SeedMutationError);
    return error as SeedMutationError;
  }
  throw new Error('expected seedMutations to reject');
}

describe('seed rejection provenance', () => {
  for (const fixture of fixtures) {
    test(`${fixture.name}: cached rejection is structured and a new revision applies`, async () => {
      const { storage, close } = await fixture.open();
      const scopes = { value: { project_id: ['p1'] } };
      const now = { value: 1_000 };
      const config: SyncServerConfig = {
        schema: TEST_SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        resolveScopes: () => scopes.value,
        clock: () => now.value,
      };
      const target = {
        partition: 'part-1',
        actorId: 'actor-1',
        clientId: 'fixture-seed',
      };
      const mutation = {
        table: 'tasks',
        op: 'upsert' as const,
        values: {
          id: 'new-row',
          project_id: 'p1',
          title: 'corrected seed',
          done: false,
        },
      };

      try {
        await seedMutations(config, { ...target, commitId: 'baseline-v1' }, [
          {
            table: 'tasks',
            op: 'upsert',
            values: {
              id: 'unrelated',
              project_id: 'p1',
              title: 'keep me',
              done: false,
            },
          },
        ]);

        scopes.value = { project_id: ['other'] };
        now.value = 2_000;
        const fresh = await expectSeedError(
          seedMutations(config, { ...target, commitId: 'feature-v1' }, [
            mutation,
          ]),
        );
        expect(fresh).toMatchObject({
          clientId: 'fixture-seed',
          clientCommitId: 'feature-v1',
          opIndex: 0,
          code: 'sync.forbidden',
          replayed: false,
          retryable: false,
          recordedAtMs: 2_000,
        });
        expect(typeof fresh.cacheIdentity).toBe('string');

        scopes.value = { project_id: ['p1'] };
        now.value = 3_000;
        const replayed = await expectSeedError(
          seedMutations(config, { ...target, commitId: 'feature-v1' }, [
            mutation,
          ]),
        );
        expect(replayed).toMatchObject({
          clientId: 'fixture-seed',
          clientCommitId: 'feature-v1',
          opIndex: 0,
          code: 'sync.forbidden',
          replayed: true,
          retryable: false,
          recordedAtMs: 2_000,
          cacheIdentity: fresh.cacheIdentity,
        });

        await seedMutations(config, { ...target, commitId: 'feature-v2' }, [
          mutation,
        ]);
        expect(
          await storage.getRow('part-1', 'tasks', 'unrelated'),
        ).toBeDefined();
        expect(
          await storage.getRow('part-1', 'tasks', 'new-row'),
        ).toBeDefined();
      } finally {
        await close();
      }
    });
  }
});

describe('a commit above the PostgreSQL bind-parameter limit', () => {
  // 7 bound parameters per change: 72,000 changes would bind 504,002 in one
  // statement, far past PostgreSQL's 65,535.
  const UPSERTS = 72_000;
  const PROJECTS = 10;
  const target = { actorId: 'actor-1', clientId: 'bulk' };
  const deleted = Array.from({ length: 15 }, (_, k) => `old-${k}`);

  /** One atomic commit; deletes sit every 5,000 changes, and `old-1` is
   * deleted twice, in different statement chunks. */
  function bulkCommit() {
    const mutations: Parameters<typeof seedMutations>[2][number][] = [];
    for (let i = 0; i < UPSERTS; i += 1) {
      if (i % 5_000 === 0)
        mutations.push({
          table: 'tasks',
          op: 'delete',
          rowId: deleted[i / 5_000] ?? 'old-0',
        });
      mutations.push({
        table: 'tasks',
        op: 'upsert',
        values: {
          id: `bulk-${String(i).padStart(6, '0')}`,
          project_id: `p${i % PROJECTS}`,
          title: `bulk row ${i}`,
          done: i % 2 === 0,
        },
      });
    }
    mutations.push({ table: 'tasks', op: 'delete', rowId: 'old-1' });
    return mutations;
  }

  async function stored(fixture: StorageFixture) {
    const { storage, close } = await fixture.open();
    // A real database outlives the test; a fresh partition isolates each run.
    const partition = `bulk-${crypto.randomUUID()}`;
    const projects = Array.from({ length: PROJECTS }, (_, k) => `p${k}`);
    const config: SyncServerConfig = {
      schema: TEST_SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: projects }),
      clock: () => 1_000,
      limits: { maxOperationsPerRequest: 100_000 },
    };
    try {
      await seedMutations(
        config,
        { ...target, partition, commitId: 'baseline' },
        deleted.map((id, k) => ({
          table: 'tasks' as const,
          op: 'upsert' as const,
          values: {
            id,
            project_id: `p${k % PROJECTS}`,
            title: id,
            done: false,
          },
        })),
      );
      const started = performance.now();
      await seedMutations(
        config,
        { ...target, partition, commitId: 'bulk' },
        bulkCommit(),
      );
      const ms = performance.now() - started;
      const maxSeq = await storage.getMaxCommitSeq(partition);
      const windows = [];
      for (const project of projects) {
        const commits = await storage.readCommitWindow(partition, {
          table: 'tasks',
          scopeFilter: { project_id: [project] },
          afterSeq: 1,
          throughSeq: maxSeq,
          limitChanges: 1_000_000,
        });
        windows.push(
          commits.map((commit) => ({
            commitSeq: commit.commitSeq,
            changes: commit.changes.map((change) => ({
              rowId: change.rowId,
              op: change.op,
              rowVersion: change.rowVersion,
              scopes: change.scopes,
              payload: Buffer.from(change.payload ?? []).toString('hex'),
            })),
          })),
        );
      }
      const tx = await storage.begin(partition);
      const tombstones: Record<string, number | undefined> = {};
      for (const id of deleted)
        tombstones[id] = await tx.getTombstoneSeq('tasks', id);
      const sample = await tx.getRow('tasks', 'bulk-071999');
      await tx.rollback();
      return { ms, maxSeq, windows, tombstones, sample };
    } finally {
      await close();
    }
  }

  const url = PG_URL;
  const Sql = BunSQL;
  const realPg: StorageFixture | undefined =
    url !== undefined && Sql !== undefined
      ? {
          name: 'PostgreSQL/SYNCULAR_PG_URL',
          open: async () => {
            const executor = bunSqlExecutor(new Sql(url));
            return {
              storage: new PostgresServerStorage(executor),
              close: () => executor.close(),
            };
          },
        }
      : undefined;
  const postgres = [fixtures[1] as StorageFixture, ...(realPg ? [realPg] : [])];

  for (const fixture of postgres) {
    test(`${fixture.name} stores it atomically, identical to SQLite`, async () => {
      const sqlite = await stored(fixtures[0] as StorageFixture);
      const pg = await stored(fixture);
      console.log(
        `${UPSERTS + deleted.length + 1}-change commit: SQLite ${sqlite.ms.toFixed(0)} ms, ${fixture.name} ${pg.ms.toFixed(0)} ms`,
      );
      expect(pg.maxSeq).toBe(2);
      expect(pg.windows.flat()).toHaveLength(PROJECTS);
      expect(
        pg.windows
          .flat()
          .reduce((sum, commit) => sum + commit.changes.length, 0),
        // The second delete of `old-1` finds the row gone and records nothing.
      ).toBe(UPSERTS + deleted.length);
      expect(Object.values(pg.tombstones)).toEqual(deleted.map(() => 2));
      expect(pg.sample).toBeDefined();
      expect(pg.windows).toEqual(sqlite.windows);
      expect(pg.tombstones).toEqual(sqlite.tombstones);
      expect(pg.sample).toEqual(sqlite.sample);
    }, 600_000);
  }
});
