import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/server/bun-sqlite';
import { createSqliteServerDialect } from '@syncular/server/sqlite';
import {
  finalizeCommitIntegrity,
  SYNCULAR_COMMIT_GENESIS_ROOT,
} from './commit-integrity';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { notifyExternalDataChange } from './notify';
import { pull } from './pull';
import { pushCommit } from './push';
import type { SyncCoreDb } from './schema';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

const dialect = createSqliteServerDialect();
const sha256HexPattern = /^[a-f0-9]{64}$/;

describe('commit integrity metadata', () => {
  let db: ReturnType<typeof createBunSqliteDialect<TestDb>>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('writes deterministic commit digests and partition chain roots for pushes', async () => {
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);

    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'First', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-2',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-2',
            op: 'upsert',
            payload: { title: 'Second', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const commits = await db
      .selectFrom('sync_commits')
      .select(['commit_seq', 'commit_digest', 'commit_chain_root'])
      .orderBy('commit_seq', 'asc')
      .execute();

    expect(commits).toHaveLength(2);
    expect(commits[0]!.commit_digest).toMatch(sha256HexPattern);
    expect(commits[0]!.commit_chain_root).toMatch(sha256HexPattern);
    expect(commits[1]!.commit_digest).toMatch(sha256HexPattern);
    expect(commits[1]!.commit_chain_root).toMatch(sha256HexPattern);
    expect(commits[1]!.commit_chain_root).not.toBe(
      commits[0]!.commit_chain_root
    );

    const finalizedAgain = await finalizeCommitIntegrity({
      db,
      dialect,
      partitionId: 'default',
      commitSeq: Number(commits[1]!.commit_seq),
    });
    expect(finalizedAgain.previousChainRoot).toBe(
      commits[0]!.commit_chain_root
    );
    expect(finalizedAgain.commitDigest).toBe(commits[1]!.commit_digest);
    expect(finalizedAgain.commitChainRoot).toBe(commits[1]!.commit_chain_root);
  });

  it('bases the digest on persisted changes before client verification exists', async () => {
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Original', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });
    const before = await db
      .selectFrom('sync_commits')
      .select(['commit_digest', 'commit_chain_root'])
      .where('commit_seq', '=', result.response.commitSeq!)
      .executeTakeFirstOrThrow();

    await db
      .updateTable('sync_changes')
      .set({
        row_json: JSON.stringify({
          id: 'task-1',
          user_id: 'u1',
          title: 'Tampered',
          server_version: 1,
        }),
      })
      .where('commit_seq', '=', result.response.commitSeq!)
      .execute();

    const after = await finalizeCommitIntegrity({
      db,
      dialect,
      partitionId: 'default',
      commitSeq: result.response.commitSeq!,
    });

    expect(after.previousChainRoot).toBe(SYNCULAR_COMMIT_GENESIS_ROOT);
    expect(after.commitDigest).not.toBe(before.commit_digest);
    expect(after.commitChainRoot).not.toBe(before.commit_chain_root);
  });

  it('writes integrity metadata for synthetic external commits', async () => {
    const result = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['tasks'],
      actorId: 'pipeline',
    });

    const commit = await db
      .selectFrom('sync_commits')
      .select([
        'client_id',
        'commit_digest',
        'commit_chain_root',
        'change_count',
      ])
      .where('commit_seq', '=', result.commitSeq)
      .executeTakeFirstOrThrow();

    expect(commit.client_id).toBe('__external__');
    expect(commit.change_count).toBe(0);
    expect(commit.commit_digest).toMatch(sha256HexPattern);
    expect(commit.commit_chain_root).toMatch(sha256HexPattern);
  });

  it('surfaces commit integrity metadata in incremental pull responses', async () => {
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'writer',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Pulled', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const response = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'reader',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 0,
          },
        ],
      },
    });
    const subscription = response.response.subscriptions[0]!;
    const commit = subscription.commits[0]!;
    const integrity = subscription.integrity!;

    expect(integrity.partitionId).toBe('default');
    expect(integrity.previousChainRoot).toBe(SYNCULAR_COMMIT_GENESIS_ROOT);
    expect(integrity.commitChainRoot).toMatch(sha256HexPattern);
    expect(integrity.commitSeq).toBe(commit.commitSeq);

    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'writer',
        clientCommitId: 'commit-2',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-2',
            op: 'upsert',
            payload: { title: 'Pulled again', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const next = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'reader',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: commit.commitSeq,
            verifiedRoot: integrity.commitChainRoot,
          },
        ],
      },
    });
    const nextSubscription = next.response.subscriptions[0]!;
    const nextCommit = nextSubscription.commits[0]!;
    const nextIntegrity = nextSubscription.integrity!;
    expect(nextIntegrity.previousChainRoot).toBe(integrity.commitChainRoot);
    expect(nextIntegrity.commitChainRoot).toMatch(sha256HexPattern);
    expect(nextIntegrity.commitSeq).toBe(nextCommit.commitSeq);
  });
});
