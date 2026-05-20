import { describe, expect, it } from 'bun:test';
import type { SyncOperation } from '@syncular/core';
import { Kysely } from 'kysely';
import { readFileSync } from 'node:fs';
import { syncConformance } from '../../../examples/todo-app/conformance/sync-conformance';
import {
  deleteTaskOperation,
  newTaskOperation,
  patchTaskOperation,
  syncularAppChangedRows,
  syncularChangedRows,
  type SyncularAppDb,
  syncularGeneratedFieldEncryptionConfig,
  syncularGeneratedTableConfig,
  taskChangedRows,
  taskSubscription,
} from '../../../examples/todo-app/generated/typescript/syncular.generated';
import { createSyncularV2Commit, createSyncularV2Dialect } from './database';
import type { SyncularV2Client, SyncularV2LiveQueryEvent } from './types';

const conformance = JSON.parse(
  readFileSync(
    new URL('../../../examples/todo-app/conformance/generated-client.json', import.meta.url),
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
    expect(newTaskOperation(conformance.task.newInput)).toEqual(conformance.task.newOperation);
    expect(patchTaskOperation('task-native', { completed: 0 }, 11)).toEqual(
      conformance.task.patchOperation
    );
    expect(deleteTaskOperation('task-native', 12)).toEqual(conformance.task.deleteOperation);
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
      dialect: createSyncularV2Dialect(client, { appTables: ['tasks'] }),
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
      ])
      .where('user_id', '=', 'user-rust')
      .orderBy('server_version', 'desc')
      .limit(5)
      .compile();

    expect(compiled.sql).toBe(conformance.task.typescriptKyselyQuery.sql);
    expect(compiled.parameters).toEqual(conformance.task.typescriptKyselyQuery.params);
  });

  it('keeps generated field-encryption config aligned with the shared sync scenarios', () => {
    expect(
      syncularGeneratedFieldEncryptionConfig({
        keys: { default: syncConformance.e2ee.keyBase64 },
        envelopePrefix: syncConformance.e2ee.envelopePrefix,
        rules: [syncConformance.e2ee.rule],
      })
    ).toEqual({
      keys: { default: syncConformance.e2ee.keyBase64 },
      envelopePrefix: syncConformance.e2ee.envelopePrefix,
      rules: [syncConformance.e2ee.rule],
    });
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
    expect(syncularChangedRows.tasks(event)[0]?.raw.commitId).toBe('commit-delta');
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
    } satisfies SyncularV2Client;

    const commit = createSyncularV2Commit<SyncularAppDb>({
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
});

function fakeClient(): SyncularV2Client {
  const listeners = new Map<
    string,
    (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
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
    async startRealtime() {},
    async stopRealtime() {},
    async setSubscriptions() {},
    async applyMutation() {
      return 'commit';
    },
    async applyMutationsBatch(operations) {
      return operations.map((_, index) => `commit-${index}`);
    },
    async applyMutationsCommit() {
      return 'commit';
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
        packageName: '@syncular/client-rust',
        packageVersion: '0.0.0',
        workerProtocolVersion: 1,
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
  } satisfies SyncularV2Client;
}
