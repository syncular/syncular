import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { SyncOperation } from '@syncular/core';
import { Kysely } from 'kysely';
import { syncConformance } from '../../../rust/examples/todo-app/conformance/sync-conformance';
import {
  deleteTaskOperation,
  newTaskOperation,
  patchTaskOperation,
  type SyncularAppDb,
  type SyncularAppMutations,
  syncularAppChangedRows,
  syncularChangedRows,
  syncularGeneratedAppMigrations,
  syncularGeneratedAppSchema,
  syncularGeneratedEmbeddedMigrations,
  syncularGeneratedFieldEncryptionConfig,
  syncularGeneratedTableConfig,
  taskChangedRows,
  taskSubscription,
} from '../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import {
  createSyncularCommandHistory,
  type SyncularCommandHistoryError,
} from './command-history';
import {
  createSyncularCommit,
  createSyncularDialect,
  createSyncularMutations,
} from './database';
import { SYNCULAR_WORKER_PROTOCOL_VERSION } from './runtime-contract';
import type { SyncularLiveQueryEvent, SyncularRuntimeClient } from './types';

const conformance = JSON.parse(
  readFileSync(
    new URL(
      '../../../rust/examples/todo-app/conformance/generated-client.json',
      import.meta.url
    ),
    'utf8'
  )
) as {
  task: {
    newInput: {
      id: string;
      title: string;
      completed: number;
      user_id: string;
      project_id: string;
    };
    newOperation: unknown;
    patchOperation: unknown;
    deleteOperation: unknown;
    subscription: unknown;
    typescriptKyselyQuery: {
      sql: string;
      params: unknown[];
    };
  };
};

describe('generated app conformance', () => {
  it('keeps TypeScript task operation semantics aligned with native generated clients', () => {
    expect(newTaskOperation(conformance.task.newInput)).toEqual(
      conformance.task.newOperation
    );
    expect(patchTaskOperation('task-native', { completed: 0 }, 11)).toEqual(
      conformance.task.patchOperation
    );
    expect(deleteTaskOperation('task-native', 12)).toEqual(
      conformance.task.deleteOperation
    );
  });

  it('keeps TypeScript subscriptions and Kysely reads on the shared table contract', () => {
    expect(
      taskSubscription({
        actorId: 'user-rust',
        projectId: 'project-rust',
      })
    ).toEqual(conformance.task.subscription);

    const client = fakeClient();
    const db = new Kysely<SyncularAppDb>({
      dialect: createSyncularDialect(client, { appTables: ['tasks'] }),
    });

    const compiled = db
      .selectFrom('tasks')
      .select([
        'id',
        'title',
        'completed',
        'user_id',
        'project_id',
        'server_version',
        'image',
        'title_yjs_state',
        'description',
      ])
      .where('user_id', '=', 'user-rust')
      .orderBy('server_version', 'desc')
      .limit(5)
      .compile();

    expect(compiled.sql).toBe(conformance.task.typescriptKyselyQuery.sql);
    expect(compiled.parameters).toEqual(
      conformance.task.typescriptKyselyQuery.params
    );
  });

  it('keeps generated field-encryption config aligned with the shared sync scenarios', () => {
    expect(
      syncularGeneratedFieldEncryptionConfig({
        keys: { default: syncConformance.e2ee.keyBase64 },
        envelopePrefix: syncConformance.e2ee.envelopePrefix,
      })
    ).toEqual({
      keys: { default: syncConformance.e2ee.keyBase64 },
      envelopePrefix: syncConformance.e2ee.envelopePrefix,
      rules: [syncConformance.e2ee.rule],
    });
  });

  it('embeds generated app migrations in the runtime app schema', () => {
    expect(syncularGeneratedAppSchema.migrations).toBe(
      syncularGeneratedEmbeddedMigrations
    );
    expect(syncularGeneratedEmbeddedMigrations).toHaveLength(
      syncularGeneratedAppMigrations.length
    );

    for (const [index, migration] of syncularGeneratedAppMigrations.entries()) {
      const embedded = syncularGeneratedEmbeddedMigrations[index];
      expect(embedded).toEqual({
        version: migration.version,
        schemaVersion: migration.schemaVersion,
        name: migration.name,
        upSql: migration.appSql.join('\n\n'),
      });
    }

    expect(syncularGeneratedEmbeddedMigrations[0]?.upSql).toContain(
      'CREATE TABLE IF NOT EXISTS projects'
    );
  });

  it('bundles generated app migrations without filesystem migration paths', async () => {
    const result = await Bun.build({
      entrypoints: [
        new URL(
          '../../../rust/examples/todo-app/generated/typescript/syncular.generated.ts',
          import.meta.url
        ).pathname,
      ],
      target: 'browser',
      format: 'esm',
      splitting: false,
      minify: false,
      write: false,
    });

    expect(result.logs).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);

    const bundled = await result.outputs[0]!.text();
    expect(bundled).toContain('syncularGeneratedEmbeddedMigrations');
    expect(bundled).toContain('CREATE TABLE IF NOT EXISTS projects');
    expect(bundled).not.toContain('migrations/0001_initial/up.sql');
  });

  it('turns generic row deltas into typed table helpers', () => {
    const event = {
      source: 'remotePull',
      changedTables: ['tasks'],
      changedRows: [
        {
          table: 'tasks',
          rowId: 'task-delta',
          operation: 'update',
          changedFields: ['title', 'title_yjs_state', 'unknown_column'],
          crdtFields: ['title_yjs_state'],
          crdtFieldChanges: [
            {
              field: 'title',
              stateColumn: 'title_yjs_state',
              containerKey: 'title',
              rowIdField: 'id',
              kind: 'text',
              syncMode: 'server-merge',
            },
            {
              field: 'unknown_column',
              stateColumn: 'unknown_yjs_state',
              containerKey: 'unknown',
              rowIdField: 'id',
              kind: 'text',
              syncMode: 'server-merge',
            },
          ],
          commitId: 'commit-delta',
        },
      ],
    };

    const [task] = taskChangedRows(event);
    expect(task?.rowId).toBe('task-delta');
    expect(task?.isUpdate).toBe(true);
    expect(task?.changed.title).toBe(true);
    expect(task?.changed.title_yjs_state).toBe(true);
    expect(task?.changed.completed).toBe(false);
    expect(task?.crdt.title_yjs_state).toBe(true);
    expect(task?.changedFields).toEqual(['title', 'title_yjs_state']);
    expect(task?.crdtFieldChanges).toEqual([
      expect.objectContaining({
        field: 'title',
        stateColumn: 'title_yjs_state',
      }),
    ]);
    expect(syncularChangedRows.tasks(event)[0]?.raw.commitId).toBe(
      'commit-delta'
    );
    expect(syncularAppChangedRows(event)).toHaveLength(1);
  });

  it('keeps Yjs envelopes in outbox operations while materializing local rows', async () => {
    const update = { updateId: 'u1', updateBase64: 'AQID' };
    let capturedBatch: Array<{
      operation: SyncOperation;
      localRow?: unknown | null;
    }> | null = null;
    const client = {
      ...fakeClient(),
      async applyYjsEnvelopeToPayload(args) {
        expect(args.payload.__yjs).toEqual({ title: update });
        const { __yjs: _ignored, ...payload } = args.payload;
        return {
          ...payload,
          title: 'Merged locally',
          title_yjs_state: 'state-base64',
        };
      },
      async applyMutationsCommit(batch) {
        capturedBatch = batch;
        return 'commit-yjs';
      },
    } satisfies SyncularRuntimeClient;

    const commit = createSyncularCommit<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    });

    await commit(async (tx) => {
      await tx.tasks.upsert('task-yjs', {
        title: 'Draft',
        __yjs: { title: update },
      });
    });

    expect(capturedBatch).toHaveLength(1);
    expect(capturedBatch?.[0]?.operation.payload).toEqual({
      __yjs: { title: update },
    });
    expect(capturedBatch?.[0]?.localRow).toEqual({
      id: 'task-yjs',
      title: 'Merged locally',
      title_yjs_state: 'state-base64',
    });
  });

  it('types generated mutations around generated inputs instead of full rows', async () => {
    let capturedBatch: Array<{
      operation: SyncOperation;
      localRow?: unknown | null;
    }> | null = null;
    const client = {
      ...fakeClient(),
      async applyMutationsCommit(batch) {
        capturedBatch = batch;
        return 'commit-generated';
      },
    } satisfies SyncularRuntimeClient;

    const mutations = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    }) as unknown as SyncularAppMutations;

    const insert = await mutations.tasks.insert({
      id: 'task-typed-mutation',
      title: 'Typed generated mutation',
      completed: 0,
      user_id: 'user-rust',
      project_id: null,
    });

    expect(insert).toEqual({
      commitId: 'commit-generated',
      clientCommitId: 'commit-generated',
      id: 'task-typed-mutation',
    });
    expect(capturedBatch).toHaveLength(1);
    expect(capturedBatch?.[0]?.operation).toEqual({
      table: 'tasks',
      row_id: 'task-typed-mutation',
      op: 'upsert',
      payload: {
        title: 'Typed generated mutation',
        completed: 0,
        user_id: 'user-rust',
        project_id: null,
      },
      base_version: null,
    });
    expect(capturedBatch?.[0]?.localRow).toEqual({
      id: 'task-typed-mutation',
      title: 'Typed generated mutation',
      completed: 0,
      user_id: 'user-rust',
      project_id: null,
    });
  });

  it('routes browser leased mutations through the strict leased commit path', async () => {
    let regularCommitCalled = false;
    let leasedBatch: Array<{
      operation: SyncOperation;
      localRow?: unknown | null;
    }> | null = null;
    const client = {
      ...fakeClient(),
      async applyMutationsCommit() {
        regularCommitCalled = true;
        return 'commit-regular';
      },
      async applyLeasedMutationsCommit(batch) {
        leasedBatch = batch;
        return 'commit-leased';
      },
    } satisfies SyncularRuntimeClient;

    const mutations = createSyncularMutations<SyncularAppDb>({
      client,
      requireAuthLease: true,
      tableConfig: syncularGeneratedTableConfig,
    }) as unknown as SyncularAppMutations;

    const insert = await mutations.tasks.insert({
      id: 'task-leased-browser',
      title: 'Leased browser mutation',
      completed: 0,
      user_id: 'user-rust',
      project_id: null,
    });

    expect(regularCommitCalled).toBe(false);
    expect(insert.commitId).toBe('commit-leased');
    expect(leasedBatch).toHaveLength(1);
    expect(leasedBatch?.[0]?.operation.row_id).toBe('task-leased-browser');
  });

  it('keeps generated partial updates as partial sync payloads with complete local rows', async () => {
    let capturedBatch: Array<{
      operation: SyncOperation;
      localRow?: unknown | null;
    }> | null = null;
    const client = {
      ...fakeClient(),
      async executeSql(sql, params) {
        if (sql.includes('select * from "tasks"')) {
          expect(params).toEqual(['task-partial-update']);
          return {
            rows: [
              {
                id: 'task-partial-update',
                title: 'Existing title',
                completed: 0,
                user_id: 'user-rust',
                project_id: null,
                server_version: 7,
              },
            ],
          };
        }
        if (sql.includes('"server_version"')) {
          return { rows: [{ version: 7 }] };
        }
        return { rows: [] };
      },
      async applyMutationsCommit(batch) {
        capturedBatch = batch;
        return 'commit-generated-update';
      },
    } satisfies SyncularRuntimeClient;

    const mutations = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    }) as unknown as SyncularAppMutations;

    await mutations.tasks.update('task-partial-update', { completed: 1 });

    expect(capturedBatch).toHaveLength(1);
    expect(capturedBatch?.[0]?.operation).toEqual({
      table: 'tasks',
      row_id: 'task-partial-update',
      op: 'upsert',
      payload: { completed: 1 },
      base_version: 7,
    });
    expect(capturedBatch?.[0]?.localRow).toEqual({
      id: 'task-partial-update',
      title: 'Existing title',
      completed: 1,
      user_id: 'user-rust',
      project_id: null,
    });
  });

  it('records generated command history and replays undo and redo as normal mutations', async () => {
    const state = createCommandHistoryFakeState();
    state.rows.set('tasks:task-history', {
      id: 'task-history',
      title: 'History task',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
      server_version: 0,
      image: null,
      title_yjs_state: null,
    });
    const client = commandHistoryFakeClient(state);
    const baseMutationApi = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    });
    const commandHistory = createSyncularCommandHistory<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
      mutations: baseMutationApi,
      leasedMutations: baseMutationApi,
      idFactory: () => 'cmd-history-1',
      nowMs: () => 1000 + state.nowTick++,
    });
    const mutations = commandHistory.wrapMutations(
      baseMutationApi,
      'mutations'
    ) as unknown as SyncularAppMutations;

    const update = await mutations.tasks.update('task-history', {
      completed: 1,
    });
    expect(update.clientCommitId).toBe('commit-history-1');
    expect(await commandHistory.history.canUndo()).toBe(true);
    state.rows.set('tasks:task-history', {
      ...state.rows.get('tasks:task-history')!,
      server_version: 12,
      title_yjs_state: 'server-ack-state',
    });

    const undo = await commandHistory.history.undoLast();
    expect(undo).toEqual({
      commandId: 'cmd-history-1',
      commitId: 'commit-history-2',
      clientCommitId: 'commit-history-2',
    });
    expect(state.rows.get('tasks:task-history')?.completed).toBe(0);
    expect(state.rows.get('tasks:task-history')?.server_version).toBe(12);

    const redo = await commandHistory.history.redoLast();
    expect(redo).toEqual({
      commandId: 'cmd-history-1',
      commitId: 'commit-history-3',
      clientCommitId: 'commit-history-3',
    });
    expect(state.rows.get('tasks:task-history')?.completed).toBe(1);
    expect(state.appliedOperations).toEqual([
      expect.objectContaining({
        table: 'tasks',
        row_id: 'task-history',
        op: 'upsert',
        payload: { completed: 1 },
      }),
      expect.objectContaining({
        table: 'tasks',
        row_id: 'task-history',
        op: 'upsert',
        payload: {
          title: 'History task',
          completed: 0,
          user_id: 'user-rust',
          project_id: 'project-rust',
          image: null,
        },
      }),
      expect.objectContaining({
        table: 'tasks',
        row_id: 'task-history',
        op: 'upsert',
        payload: {
          title: 'History task',
          completed: 1,
          user_id: 'user-rust',
          project_id: 'project-rust',
          image: null,
        },
      }),
    ]);
  });

  it('fails command-history undo when the current row no longer matches the recorded command', async () => {
    const state = createCommandHistoryFakeState();
    state.rows.set('tasks:task-conflict', {
      id: 'task-conflict',
      title: 'History conflict task',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
      server_version: 0,
      image: null,
      title_yjs_state: null,
    });
    const client = commandHistoryFakeClient(state);
    const baseMutationApi = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    });
    const commandHistory = createSyncularCommandHistory<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
      mutations: baseMutationApi,
      leasedMutations: baseMutationApi,
      idFactory: () => 'cmd-conflict-1',
      nowMs: () => 2000 + state.nowTick++,
    });
    const mutations = commandHistory.wrapMutations(
      baseMutationApi,
      'mutations'
    ) as unknown as SyncularAppMutations;

    await mutations.tasks.update('task-conflict', { completed: 1 });
    const conflictingRow = state.rows.get('tasks:task-conflict')!;
    expect(conflictingRow).toBeTruthy();
    state.rows.set('tasks:task-conflict', {
      ...conflictingRow,
      completed: 2,
    });

    await expect(commandHistory.history.undoLast()).rejects.toMatchObject({
      code: 'sync.command_history_conflict',
      commandId: 'cmd-conflict-1',
    } satisfies Partial<SyncularCommandHistoryError>);
  });

  it('rejects command-history replay for unsafe blob and CRDT field changes', async () => {
    const state = createCommandHistoryFakeState();
    state.rows.set('tasks:task-unsafe-history', {
      id: 'task-unsafe-history',
      title: 'Unsafe history task',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
      server_version: 0,
      image: null,
      title_yjs_state: null,
    });
    const client = commandHistoryFakeClient(state);
    const baseMutationApi = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    });
    const commandHistory = createSyncularCommandHistory<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
      mutations: baseMutationApi,
      leasedMutations: baseMutationApi,
      idFactory: () => `cmd-unsafe-${state.historyRows.length + 1}`,
      nowMs: () => 2500 + state.nowTick++,
    });
    const mutations = commandHistory.wrapMutations(
      baseMutationApi,
      'mutations'
    ) as unknown as SyncularAppMutations;

    await mutations.tasks.update('task-unsafe-history', {
      image: {
        hash: `sha256:${'a'.repeat(64)}`,
        size: 12,
        mimeType: 'image/png',
      },
    });

    await expect(commandHistory.history.undoLast()).rejects.toMatchObject({
      code: 'sync.command_history_unsafe_field',
      commandId: 'cmd-unsafe-1',
    } satisfies Partial<SyncularCommandHistoryError>);
    expect(state.appliedOperations).toHaveLength(1);

    await mutations.tasks.update('task-unsafe-history', {
      title: 'Unsafe CRDT title change',
    });

    await expect(commandHistory.history.undoLast()).rejects.toMatchObject({
      code: 'sync.command_history_unsafe_field',
      commandId: 'cmd-unsafe-2',
    } satisfies Partial<SyncularCommandHistoryError>);
    expect(state.appliedOperations).toHaveLength(2);
  });

  it('replays command history for insert, hard delete, soft delete, and grouped commits', async () => {
    const state = createCommandHistoryFakeState();
    state.rows.set('projects:project-history-delete', {
      id: 'project-history-delete',
      name: 'Project to delete',
      owner_id: 'user-rust',
      archived: 0,
      server_version: 0,
    });
    state.rows.set('comments:comment-history-soft-delete', {
      id: 'comment-history-soft-delete',
      task_id: 'task-history',
      project_id: 'project-rust',
      body: 'Comment to soft delete',
      author_id: 'user-rust',
      deleted: 0,
      server_version: 0,
    });
    state.rows.set('tasks:task-history-batch-a', {
      id: 'task-history-batch-a',
      title: 'Batch A',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
      server_version: 0,
      image: null,
      title_yjs_state: null,
    });
    state.rows.set('tasks:task-history-batch-b', {
      id: 'task-history-batch-b',
      title: 'Batch B',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
      server_version: 0,
      image: null,
      title_yjs_state: null,
    });

    const client = commandHistoryFakeClient(state);
    const baseMutationApi = createSyncularMutations<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
    });
    const commandHistory = createSyncularCommandHistory<SyncularAppDb>({
      client,
      tableConfig: syncularGeneratedTableConfig,
      mutations: baseMutationApi,
      leasedMutations: baseMutationApi,
      idFactory: () => `cmd-history-${state.historyRows.length + 1}`,
      nowMs: () => 3000 + state.nowTick++,
    });
    const mutations = commandHistory.wrapMutations(
      baseMutationApi,
      'mutations'
    ) as unknown as SyncularAppMutations;

    await mutations.tasks.insert({
      id: 'task-history-insert-crdt',
      title: 'Task with CRDT title to insert',
      completed: 0,
      user_id: 'user-rust',
      project_id: 'project-rust',
    });
    await commandHistory.history.undoLast();
    expect(state.rows.has('tasks:task-history-insert-crdt')).toBe(false);
    await commandHistory.history.redoLast();
    expect(state.rows.get('tasks:task-history-insert-crdt')?.title).toBe(
      'Task with CRDT title to insert'
    );

    await mutations.projects.insert({
      id: 'project-history-insert',
      name: 'Project to insert',
      owner_id: 'user-rust',
      archived: 0,
    });
    await commandHistory.history.undoLast();
    expect(state.rows.has('projects:project-history-insert')).toBe(false);
    await commandHistory.history.redoLast();
    expect(state.rows.get('projects:project-history-insert')?.name).toBe(
      'Project to insert'
    );

    await mutations.projects.delete('project-history-delete');
    expect(state.rows.has('projects:project-history-delete')).toBe(false);
    await commandHistory.history.undoLast();
    expect(state.rows.get('projects:project-history-delete')?.name).toBe(
      'Project to delete'
    );
    await commandHistory.history.redoLast();
    expect(state.rows.has('projects:project-history-delete')).toBe(false);

    await mutations.comments.delete('comment-history-soft-delete');
    expect(
      state.rows.get('comments:comment-history-soft-delete')?.deleted
    ).toBe(1);
    await commandHistory.history.undoLast();
    expect(
      state.rows.get('comments:comment-history-soft-delete')?.deleted
    ).toBe(0);
    await commandHistory.history.redoLast();
    expect(
      state.rows.get('comments:comment-history-soft-delete')?.deleted
    ).toBe(1);

    await mutations.$commit(async (tx) => {
      await tx.tasks.update('task-history-batch-a', { completed: 1 });
      await tx.tasks.update('task-history-batch-b', { completed: 1 });
    });
    expect(state.rows.get('tasks:task-history-batch-a')?.completed).toBe(1);
    expect(state.rows.get('tasks:task-history-batch-b')?.completed).toBe(1);
    await commandHistory.history.undoLast();
    expect(state.rows.get('tasks:task-history-batch-a')?.completed).toBe(0);
    expect(state.rows.get('tasks:task-history-batch-b')?.completed).toBe(0);
    await commandHistory.history.redoLast();
    expect(state.rows.get('tasks:task-history-batch-a')?.completed).toBe(1);
    expect(state.rows.get('tasks:task-history-batch-b')?.completed).toBe(1);
  });
});

function fakeClient(): SyncularRuntimeClient {
  const listeners = new Map<
    string,
    (event: SyncularLiveQueryEvent<Record<string, unknown>>) => void
  >();
  return {
    async executeSql() {
      return { rows: [] };
    },
    async subscribeQuery() {
      return { id: 'live-tasks', rows: [] };
    },
    async unsubscribeQuery() {},
    async drainLiveQueryEvents() {
      return [];
    },
    async close() {},
    async setAuthHeaders() {},
    async issueAuthLease() {
      throw new Error('issueAuthLease not implemented by fake client');
    },
    async upsertAuthLease() {},
    async authLease() {
      return null;
    },
    async activeAuthLeases() {
      return [];
    },
    async startRealtime() {},
    async stopRealtime() {},
    async setSubscriptions() {},
    async applyMutation() {
      return 'commit';
    },
    async applyLeasedMutation() {
      return 'leased-commit';
    },
    async applyMutationsBatch(operations) {
      return operations.map((_, index) => `commit-${index}`);
    },
    async applyMutationsCommit() {
      return 'commit';
    },
    async applyLeasedMutationsCommit() {
      return 'leased-commit';
    },
    async buildYjsTextUpdate() {
      return {
        update: { updateId: 'update', updateBase64: 'AQID' },
        nextStateBase64: 'state',
        nextText: 'text',
      };
    },
    async applyYjsTextUpdates() {
      return { nextStateBase64: 'state', text: 'text' };
    },
    async applyYjsEnvelopeToPayload(args) {
      return args.payload;
    },
    async syncPull() {
      return {};
    },
    async syncPush() {
      return {};
    },
    async syncOnce() {
      return {};
    },
    async resumeFromBackground() {
      return {};
    },
    async conflictSummaries() {
      return [];
    },
    async retryConflictKeepLocal() {
      return 'conflict-retry';
    },
    async resolveConflict() {},
    async listTable() {
      return [];
    },
    async storeBlob() {
      return { hash: 'sha256:test', size: 0 };
    },
    async retrieveBlob() {
      return new Uint8Array();
    },
    async isBlobLocal() {
      return false;
    },
    async processBlobUploadQueue() {
      return { uploaded: 0, failed: 0 };
    },
    async blobUploadQueueStats() {
      return { pending: 0, uploading: 0, failed: 0 };
    },
    async blobCacheStats() {
      return { count: 0, totalBytes: 0 };
    },
    async pruneBlobCache() {
      return 0;
    },
    async clearBlobCache() {},
    async compactStorage() {
      return {
        ackedOutboxCommitsDeleted: 0,
        resolvedConflictsDeleted: 0,
        failedBlobUploadsDeleted: 0,
        inactiveSubscriptionStatesDeleted: 0,
        tombstoneRowsDeleted: 0,
        blobCacheBytesPruned: 0,
        encryptedCrdtUpdatesDeleted: 0,
        encryptedCrdtCheckpointsDeleted: 0,
      };
    },
    async generatedSchemaState() {
      return { schemaVersion: 3, tables: [] };
    },
    async runtimeInfo() {
      return {
        packageName: '@syncular/client',
        packageVersion: '0.0.0',
        workerProtocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
        storage: 'memory',
        workerUrl: '',
        wasmGlueUrl: '',
        wasmUrl: '',
        rust: {
          crateName: 'syncular-runtime',
          crateVersion: '0.1.0',
          schemaVersion: 3,
          features: ['web-owned-sqlite'],
        },
      };
    },
    connectionState() {
      return {
        closed: false,
        pendingRequests: 0,
        realtime: 'disconnected',
      };
    },
    async diagnosticSnapshot() {
      const runtime = await this.runtimeInfo();
      const connection = this.connectionState();
      return {
        generatedAt: Date.now(),
        runtime,
        connection,
        subscriptions: [],
        recentDiagnostics: [],
        recentSyncTimings: [],
      };
    },
    addDiagnosticListener() {
      return () => undefined;
    },
    addRowsChangedListener() {
      return () => undefined;
    },
    addLiveQueryListener(queryId, listener) {
      listeners.set(queryId, listener);
    },
    removeLiveQueryListener(queryId) {
      listeners.delete(queryId);
    },
  } satisfies SyncularRuntimeClient;
}

function createCommandHistoryFakeState() {
  return {
    rows: new Map<string, Record<string, unknown>>(),
    historyRows: [] as Array<{
      id: string;
      mutation_scope: string;
      state: 'done' | 'undone';
      entries_json: string;
      client_commit_id: string;
      undo_client_commit_id: string | null;
      redo_client_commit_id: string | null;
      created_at: number;
      updated_at: number;
    }>,
    appliedOperations: [] as SyncOperation[],
    commitSeq: 0,
    nowTick: 0,
  };
}

function commandHistoryFakeClient(
  state: ReturnType<typeof createCommandHistoryFakeState>
): SyncularRuntimeClient & {
  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: Row[]; numAffectedRows?: number }>;
} {
  return {
    ...fakeClient(),
    async executeSql<
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(sql: string, params: readonly unknown[] = []) {
      const normalized = sql.toLowerCase();
      if (normalized.includes('from sync_command_history')) {
        const wantedState = params[0];
        const rows = state.historyRows
          .filter((row) => row.state === wantedState)
          .sort(
            (a, b) =>
              b.updated_at - a.updated_at ||
              b.created_at - a.created_at ||
              b.id.localeCompare(a.id)
          );
        return { rows: rows.slice(0, 1) as Row[] };
      }
      const table = ['tasks', 'projects', 'comments'].find((candidate) =>
        normalized.includes(`from "${candidate}"`)
      );
      if (table) {
        const row = state.rows.get(`${table}:${String(params[0])}`);
        return { rows: (row ? [{ ...row }] : []) as Row[] };
      }
      return { rows: [] as Row[] };
    },
    async executeUnsafeSql<
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(sql: string, params: readonly unknown[] = []) {
      const normalized = sql.trim().toLowerCase();
      if (
        normalized.startsWith('create table') ||
        normalized.startsWith('create index')
      ) {
        return { rows: [] as Row[] };
      }
      if (normalized.startsWith('delete from sync_command_history')) {
        const before = state.historyRows.length;
        state.historyRows = state.historyRows.filter(
          (row) => row.state !== 'undone'
        );
        return {
          rows: [] as Row[],
          numAffectedRows: before - state.historyRows.length,
        };
      }
      if (normalized.startsWith('insert into sync_command_history')) {
        state.historyRows.push({
          id: String(params[0]),
          mutation_scope: String(params[1]),
          state: 'done',
          entries_json: String(params[2]),
          client_commit_id: String(params[3]),
          undo_client_commit_id: null,
          redo_client_commit_id: null,
          created_at: Number(params[4]),
          updated_at: Number(params[5]),
        });
        return { rows: [] as Row[], numAffectedRows: 1 };
      }
      if (normalized.startsWith('update sync_command_history')) {
        const nextState = params[0] as 'done' | 'undone';
        const updatedAt = Number(params[1]);
        const replayCommitId = String(params[2]);
        const id = String(params[3]);
        const row = state.historyRows.find((entry) => entry.id === id);
        if (row) {
          row.state = nextState;
          row.updated_at = updatedAt;
          if (nextState === 'undone') {
            row.undo_client_commit_id = replayCommitId;
          } else {
            row.redo_client_commit_id = replayCommitId;
          }
        }
        return { rows: [] as Row[], numAffectedRows: row ? 1 : 0 };
      }
      throw new Error(`unexpected unsafe SQL in command-history fake: ${sql}`);
    },
    async applyMutationsCommit(batch) {
      state.commitSeq += 1;
      for (const { operation, localRow } of batch) {
        state.appliedOperations.push(operation);
        const key = `${operation.table}:${operation.row_id}`;
        if (operation.op === 'delete') {
          state.rows.delete(key);
          continue;
        }
        const existing = state.rows.get(key) ?? {};
        const patch = objectRecordForTest(localRow ?? operation.payload);
        const tableConfig = syncularGeneratedTableConfig[operation.table];
        const serverVersionColumn = tableConfig?.serverVersionColumn;
        if (serverVersionColumn && patch[serverVersionColumn] === undefined) {
          patch[serverVersionColumn] =
            operation.base_version ?? existing[serverVersionColumn] ?? 0;
        }
        state.rows.set(key, {
          ...existing,
          ...patch,
          id: operation.row_id,
        });
      }
      return `commit-history-${state.commitSeq}`;
    },
  };
}

function objectRecordForTest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}
