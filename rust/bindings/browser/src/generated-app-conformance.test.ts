import { describe, expect, it } from 'bun:test';
import type { SyncOperation } from '@syncular/core';
import { Kysely } from 'kysely';
import {
  deleteTaskOperation,
  newTaskOperation,
  patchTaskOperation,
  type SyncularAppDb,
  syncularGeneratedTableConfig,
  taskSubscription,
} from '../../../examples/todo-app/generated/typescript/syncular.generated';
import { createSyncularV2Commit, createSyncularV2Dialect } from './database';
import type { SyncularV2Client, SyncularV2LiveQueryEvent } from './types';

describe('generated app conformance', () => {
  it('keeps TypeScript task operation semantics aligned with native generated clients', () => {
    expect(
      newTaskOperation({
        id: 'task-native',
        title: 'Native smoke',
        completed: 1,
        user_id: 'user-rust',
        project_id: 'project-rust',
      })
    ).toEqual({
      table: 'tasks',
      row_id: 'task-native',
      op: 'upsert',
      payload: {
        title: 'Native smoke',
        completed: 1,
        user_id: 'user-rust',
        project_id: 'project-rust',
      },
      base_version: 0,
    });

    expect(patchTaskOperation('task-native', { completed: 0 }, 11)).toEqual({
      table: 'tasks',
      row_id: 'task-native',
      op: 'upsert',
      payload: { completed: 0 },
      base_version: 11,
    });

    expect(deleteTaskOperation('task-native', 12)).toEqual({
      table: 'tasks',
      row_id: 'task-native',
      op: 'delete',
      payload: null,
      base_version: 12,
    });
  });

  it('keeps TypeScript subscriptions and Kysely reads on the shared table contract', () => {
    expect(
      taskSubscription({
        actorId: 'user-rust',
        projectId: 'project-rust',
      })
    ).toEqual({
      id: 'sub-tasks',
      table: 'tasks',
      scopes: {
        user_id: 'user-rust',
        project_id: 'project-rust',
      },
      params: {},
    });

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

    expect(compiled.sql).toBe(
      'select "id", "title", "completed", "user_id", "project_id", "server_version", "image", "title_yjs_state" from "tasks" where "user_id" = ? order by "server_version" desc limit ?'
    );
    expect(compiled.parameters).toEqual(['user-rust', 5]);
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
      async applyLocalOperationsCommit(batch) {
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
    async applyLocalOperation() {
      return 'commit';
    },
    async applyLocalOperationsBatch(operations) {
      return operations.map((_, index) => `commit-${index}`);
    },
    async applyLocalOperationsCommit() {
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
    addLiveQueryListener(queryId, listener) {
      listeners.set(queryId, listener);
    },
    removeLiveQueryListener(queryId) {
      listeners.delete(queryId);
    },
  } satisfies SyncularV2Client;
}
