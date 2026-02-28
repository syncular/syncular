import { describe, expect, it } from 'bun:test';
import type {
  SyncClientLocalMutationArgs,
  SyncClientPluginContext,
  SyncClientWsDeliveryArgs,
  SyncPullResponse,
  SyncPushRequest,
  SyncSubscriptionRequest,
} from '@syncular/client';
import {
  buildYjsTextUpdate,
  createYjsClientPlugin,
  YJS_PAYLOAD_KEY,
  type YjsClientUpdateEnvelope,
} from './index';

const ctx: SyncClientPluginContext = {
  actorId: 'actor-1',
  clientId: 'client-1',
};

const emptyPullRequest = {
  clientId: 'client-1',
  limitCommits: 100,
  subscriptions: [] as SyncSubscriptionRequest[],
};

async function callBeforePush(
  plugin: ReturnType<typeof createYjsClientPlugin>,
  request: SyncPushRequest
): Promise<SyncPushRequest> {
  const hook = plugin.beforePush;
  if (!hook) {
    throw new Error('Expected beforePush hook');
  }
  return await hook(ctx, request);
}

async function callAfterPull(
  plugin: ReturnType<typeof createYjsClientPlugin>,
  response: SyncPullResponse
): Promise<SyncPullResponse> {
  const hook = plugin.afterPull;
  if (!hook) {
    throw new Error('Expected afterPull hook');
  }
  return await hook(ctx, {
    request: emptyPullRequest,
    response,
  });
}

async function callBeforeApplyWsChanges(
  plugin: ReturnType<typeof createYjsClientPlugin>,
  args: SyncClientWsDeliveryArgs
): Promise<SyncClientWsDeliveryArgs> {
  const hook = plugin.beforeApplyWsChanges;
  if (!hook) {
    throw new Error('Expected beforeApplyWsChanges hook');
  }
  return await hook(ctx, args);
}

async function callBeforeApplyLocalMutations(
  plugin: ReturnType<typeof createYjsClientPlugin>,
  args: SyncClientLocalMutationArgs
): Promise<SyncClientLocalMutationArgs> {
  const hook = plugin.beforeApplyLocalMutations;
  if (!hook) {
    throw new Error('Expected beforeApplyLocalMutations hook');
  }
  return await hook(ctx, args);
}

function createUpdate(
  text: string,
  previousStateBase64?: string
): { update: YjsClientUpdateEnvelope; state: string } {
  const built = buildYjsTextUpdate({
    previousStateBase64,
    nextText: text,
    containerKey: 'content',
  });
  return { update: built.update, state: built.nextStateBase64 };
}

describe('@syncular/client-plugin-crdt-yjs', () => {
  it('materializes outgoing payload from Yjs envelope updates and strips envelope key', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const { update } = createUpdate('Hello Yjs');
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
            [YJS_PAYLOAD_KEY]: {
              content: update,
            },
          },
          base_version: null,
        },
      ],
    };

    const next = await callBeforePush(plugin, request);
    const op = next.operations[0];
    if (!op || op.op !== 'upsert' || !op.payload) {
      throw new Error('Expected transformed upsert payload');
    }

    expect(op.payload.content).toBe('Hello Yjs');
    expect(typeof op.payload.content_yjs_state).toBe('string');
    expect(YJS_PAYLOAD_KEY in op.payload).toBe(false);
  });

  it('uses cached row state from pull to apply future delta-only updates', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const first = createUpdate('Hello');
    const second = createUpdate('Hello world', first.state);

    const pulled = await callAfterPull(plugin, {
      ok: true,
      subscriptions: [
        {
          id: 'tasks',
          status: 'active',
          scopes: {},
          bootstrap: true,
          nextCursor: 1,
          bootstrapState: null,
          commits: [],
          snapshots: [
            {
              table: 'tasks',
              rows: [
                {
                  id: 'task-1',
                  content: 'stale',
                  content_yjs_state: first.state,
                  [YJS_PAYLOAD_KEY]: {
                    should_be_removed: true,
                  },
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const snapshotRow = pulled.subscriptions[0]?.snapshots?.[0]?.rows?.[0] as
      | Record<string, unknown>
      | undefined;
    if (!snapshotRow) {
      throw new Error('Expected transformed snapshot row');
    }
    expect(snapshotRow.content).toBe('Hello');
    expect(YJS_PAYLOAD_KEY in snapshotRow).toBe(false);

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
            [YJS_PAYLOAD_KEY]: {
              content: second.update,
            },
          },
          base_version: 1,
        },
      ],
    };

    const next = await callBeforePush(plugin, request);
    const payload = next.operations[0]?.payload as Record<string, unknown>;
    expect(payload.content).toBe('Hello world');
    expect(typeof payload.content_yjs_state).toBe('string');
  });

  it('materializes websocket inline changes through beforeApplyWsChanges', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const first = createUpdate('Live update');
    const next = await callBeforeApplyWsChanges(plugin, {
      cursor: 10,
      changes: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          row_json: {
            id: 'task-1',
            content: 'stale',
            content_yjs_state: first.state,
            [YJS_PAYLOAD_KEY]: {
              should_be_removed: true,
            },
          },
          row_version: 2,
          scopes: {},
        },
      ],
    });

    const row = next.changes[0]?.row_json as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error('Expected transformed row_json');
    }
    expect(row.content).toBe('Live update');
    expect(YJS_PAYLOAD_KEY in row).toBe(false);
  });

  it('materializes local mutation payloads through beforeApplyLocalMutations', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const { update } = createUpdate('Local update');
    const next = await callBeforeApplyLocalMutations(plugin, {
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            [YJS_PAYLOAD_KEY]: {
              content: update,
            },
          },
          base_version: null,
        },
      ],
    });

    const payload = next.operations[0]?.payload as
      | Record<string, unknown>
      | null
      | undefined;
    if (!payload) {
      throw new Error('Expected transformed local payload');
    }
    expect(payload.content).toBe('Local update');
    expect(typeof payload.content_yjs_state).toBe('string');
    expect(YJS_PAYLOAD_KEY in payload).toBe(false);
  });

  it('materializes rows when state is delivered as UTF-8 bytes of base64 text', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const first = createUpdate('Bytes snapshot');
    const next = await callAfterPull(plugin, {
      ok: true,
      subscriptions: [
        {
          id: 'tasks',
          status: 'active',
          scopes: {},
          bootstrap: true,
          nextCursor: 1,
          bootstrapState: null,
          commits: [],
          snapshots: [
            {
              table: 'tasks',
              rows: [
                {
                  id: 'task-1',
                  content: 'stale',
                  content_yjs_state: new TextEncoder().encode(first.state),
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const row = next.subscriptions[0]?.snapshots?.[0]?.rows?.[0] as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error('Expected transformed snapshot row');
    }
    expect(row.content).toBe('Bytes snapshot');
  });

  it('throws when strict mode is enabled and envelope references unknown fields', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
      strict: true,
    });

    const { update } = createUpdate('Hello');
    const request: SyncPushRequest = {
      clientId: 'client-1',
      clientCommitId: 'commit-3',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            [YJS_PAYLOAD_KEY]: {
              unknown_field: update,
            },
          },
          base_version: 1,
        },
      ],
    };

    await expect(callBeforePush(plugin, request)).rejects.toThrow(
      'No Yjs rule found for envelope field "unknown_field"'
    );
  });
});
