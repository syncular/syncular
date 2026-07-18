import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
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
    open: async () => ({
      storage: new D1ServerStorage(new D1DatabaseDouble()),
      close: async () => {},
    }),
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
