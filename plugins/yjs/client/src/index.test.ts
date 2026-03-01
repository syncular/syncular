import { describe, expect, it } from 'bun:test';
import type {
  SyncClientLocalMutationArgs,
  SyncClientPluginContext,
  SyncClientWsDeliveryArgs,
  SyncPullResponse,
  SyncPushRequest,
  SyncSubscriptionRequest,
} from '@syncular/client';
import * as Y from 'yjs';
import {
  applyYjsTextUpdates,
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

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function createXmlState(text: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('content');
  doc.transact(() => {
    const paragraph = new Y.XmlElement('p');
    const xmlText = new Y.XmlText();
    xmlText.insert(0, text);
    paragraph.insert(0, [xmlText]);
    fragment.insert(0, [paragraph]);
  });
  const state = bytesToBase64(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return state;
}

describe('@syncular/client-plugin-crdt-yjs', () => {
  it('merges concurrent prepend and append updates without text duplication', () => {
    const base = buildYjsTextUpdate({
      nextText: '123',
      containerKey: 'content',
    });
    const prepend = buildYjsTextUpdate({
      previousStateBase64: base.nextStateBase64,
      nextText: '0123',
      containerKey: 'content',
    });
    const append = buildYjsTextUpdate({
      previousStateBase64: base.nextStateBase64,
      nextText: '1234',
      containerKey: 'content',
    });

    const mergedForward = applyYjsTextUpdates({
      previousStateBase64: base.nextStateBase64,
      updates: [prepend.update, append.update],
      containerKey: 'content',
    });
    const mergedReverse = applyYjsTextUpdates({
      previousStateBase64: base.nextStateBase64,
      updates: [append.update, prepend.update],
      containerKey: 'content',
    });

    expect(mergedForward.text).toBe('01234');
    expect(mergedReverse.text).toBe('01234');
  });

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

  it('can keep envelope key on push while still materializing payload', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
      stripEnvelopeBeforePush: false,
      stripEnvelopeBeforeApplyLocalMutations: true,
    });

    const { update } = createUpdate('Hello merge');
    const request: SyncPushRequest = {
      clientId: 'client-1',
      clientCommitId: 'commit-keep-envelope',
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

    const pushed = await callBeforePush(plugin, request);
    const pushedPayload = pushed.operations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (!pushedPayload) {
      throw new Error('Expected transformed push payload');
    }
    expect(pushedPayload.content).toBe('Hello merge');
    expect(typeof pushedPayload.content_yjs_state).toBe('string');
    expect(YJS_PAYLOAD_KEY in pushedPayload).toBe(true);

    const local = await callBeforeApplyLocalMutations(plugin, {
      operations: request.operations,
    });
    const localPayload = local.operations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (!localPayload) {
      throw new Error('Expected transformed local payload');
    }
    expect(localPayload.content).toBe('Hello merge');
    expect(typeof localPayload.content_yjs_state).toBe('string');
    expect(YJS_PAYLOAD_KEY in localPayload).toBe(false);
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

  it('invalidates cached row state after pull commit delete before row-id reuse', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const old = createUpdate('old');
    await callAfterPull(plugin, {
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
                  content_yjs_state: old.state,
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    await callAfterPull(plugin, {
      ok: true,
      subscriptions: [
        {
          id: 'tasks',
          status: 'active',
          scopes: {},
          bootstrap: false,
          nextCursor: 2,
          bootstrapState: null,
          snapshots: [],
          commits: [
            {
              commitSeq: 2,
              createdAt: '2026-03-01T00:00:00.000Z',
              actorId: 'actor-2',
              changes: [
                {
                  table: 'tasks',
                  row_id: 'task-1',
                  op: 'delete',
                  row_json: null,
                  row_version: null,
                  scopes: {},
                },
              ],
            },
          ],
        },
      ],
    });

    const fresh = createUpdate('new');
    const pushed = await callBeforePush(plugin, {
      clientId: 'client-1',
      clientCommitId: 'commit-reuse-after-delete',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            [YJS_PAYLOAD_KEY]: {
              content: fresh.update,
            },
          },
          base_version: null,
        },
      ],
    });

    const payload = pushed.operations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (!payload) {
      throw new Error('Expected transformed push payload');
    }

    expect(payload.content).toBe('new');
    expect(String(payload.content)).not.toContain('old');
  });

  it('evicts least-recently-used cached row state when maxTrackedRows is reached', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
      maxTrackedRows: 1,
    });

    const rowOne = createUpdate('old');
    const rowTwo = createUpdate('other');

    await callAfterPull(plugin, {
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
                  content_yjs_state: rowOne.state,
                },
                {
                  id: 'task-2',
                  content: 'stale',
                  content_yjs_state: rowTwo.state,
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const fullFromEmpty = createUpdate('new');
    const pushed = await callBeforePush(plugin, {
      clientId: 'client-1',
      clientCommitId: 'commit-eviction',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'task-1',
          op: 'upsert',
          payload: {
            [YJS_PAYLOAD_KEY]: {
              content: fullFromEmpty.update,
            },
          },
          base_version: null,
        },
      ],
    });

    const payload = pushed.operations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (!payload) {
      throw new Error('Expected transformed push payload');
    }

    expect(payload.content).toBe('new');
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

  it('materializes xml-fragment kind rows during pull', async () => {
    const plugin = createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
          kind: 'xml-fragment',
        },
      ],
    });

    const xmlState = createXmlState('Hello XML');
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
                  content_yjs_state: xmlState,
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
    expect(typeof row.content).toBe('string');
    expect(String(row.content)).toContain('Hello XML');
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
