import { describe, expect, test } from 'bun:test';
import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '@syncular/core';
import {
  createFieldEncryptionPlugin,
  createStaticFieldEncryptionKeys,
  generateSymmetricKey,
} from '../index';

const keyId = 'scope-resolution';
const keys = createStaticFieldEncryptionKeys({
  keys: { [keyId]: generateSymmetricKey() },
  encryptionKid: keyId,
});

const plugin = createFieldEncryptionPlugin({
  rules: [
    {
      scope: 'workspace_tasks',
      table: 'tasks',
      fields: ['title'],
    },
  ],
  keys,
});

const context = { actorId: 'actor-1', clientId: 'client-1' };

async function buildEncryptedTitle(): Promise<string> {
  const request: SyncPushRequest = {
    clientId: 'client-1',
    clientCommitId: 'commit-1',
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'task-1',
        op: 'upsert',
        payload: {
          id: 'task-1',
          title: 'Secret title',
        },
        base_version: null,
      },
    ],
  };

  const encrypted = await plugin.beforePush!(context, request);
  const encryptedTitle = encrypted.operations[0]?.payload?.title;
  if (typeof encryptedTitle !== 'string') {
    throw new Error('Expected encrypted title to be a string');
  }
  return encryptedTitle;
}

describe('Field encryption scope/table resolution', () => {
  test('encrypts beforePush when rule scope differs from operation table', async () => {
    const request: SyncPushRequest = {
      clientId: 'client-1',
      clientCommitId: 'commit-1',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            id: 'task-1',
            title: 'Secret title',
            completed: false,
          },
          base_version: null,
        },
      ],
    };

    const encrypted = await plugin.beforePush!(context, request);
    const payload = encrypted.operations[0]?.payload;
    const encryptedTitle = payload?.title;

    expect(typeof encryptedTitle).toBe('string');
    expect(encryptedTitle).not.toBe('Secret title');
    expect(String(encryptedTitle).startsWith('dgsync:e2ee:1:')).toBe(true);
    expect(payload?.completed).toBe(false);
  });

  test('decrypts afterPush conflict rows with scope/table mismatch rules', async () => {
    const encryptedTitle = await buildEncryptedTitle();

    const request: SyncPushRequest = {
      clientId: 'client-1',
      clientCommitId: 'commit-2',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            id: 'task-1',
            title: 'Secret title',
          },
          base_version: null,
        },
      ],
    };

    const response: SyncPushResponse = {
      ok: true,
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'conflict',
          message: 'conflict',
          server_version: 2,
          server_row: {
            id: 'task-1',
            title: encryptedTitle,
          },
        },
      ],
    };

    const next = await plugin.afterPush!(context, { request, response });
    const conflict = next.results[0];

    if (!conflict || conflict.status !== 'conflict') {
      throw new Error('Expected conflict result in afterPush response');
    }
    if (!('server_row' in conflict)) {
      throw new Error('Expected conflict server_row in afterPush response');
    }
    if (
      typeof conflict.server_row !== 'object' ||
      conflict.server_row === null ||
      Array.isArray(conflict.server_row)
    ) {
      throw new Error('Expected conflict server_row to be an object');
    }
    expect(conflict.server_row.title).toBe('Secret title');
  });

  test('decrypts incremental pull rows when change.table is the scope name', async () => {
    const encryptedTitle = await buildEncryptedTitle();

    const request: SyncPullRequest = {
      clientId: 'client-1',
      limitCommits: 50,
      subscriptions: [],
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'workspace-sub',
          status: 'active',
          scopes: {},
          bootstrap: false,
          nextCursor: 1,
          commits: [
            {
              commitSeq: 1,
              createdAt: new Date(0).toISOString(),
              actorId: 'actor-1',
              changes: [
                {
                  table: 'workspace_tasks',
                  row_id: 'task-1',
                  op: 'upsert',
                  row_json: {
                    id: 'task-1',
                    title: encryptedTitle,
                  },
                  row_version: 2,
                  scopes: {},
                },
              ],
            },
          ],
        },
      ],
    };

    const next = await plugin.afterPull!(context, { request, response });
    const change =
      next.subscriptions[0]?.commits[0]?.changes[0]?.row_json ?? null;
    if (
      typeof change !== 'object' ||
      change === null ||
      Array.isArray(change)
    ) {
      throw new Error('Expected decrypted change row_json object');
    }
    expect(change.title).toBe('Secret title');
  });
});
