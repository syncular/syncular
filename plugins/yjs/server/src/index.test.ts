import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import {
  buildYjsTextUpdate,
  createYjsServerModule,
  YJS_PAYLOAD_KEY,
  type YjsServerUpdateEnvelope,
} from './index';

function createUpdate(
  text: string,
  previousStateBase64?: string
): Promise<{ update: YjsServerUpdateEnvelope; state: string }> {
  const built = buildYjsTextUpdate({
    previousStateBase64,
    nextText: text,
    containerKey: 'content',
  });
  return built.then((value) => ({
    update: value.update,
    state: value.nextStateBase64,
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function createXmlInsert(
  text: string,
  previousStateBase64?: string
): { update: YjsServerUpdateEnvelope; state: string } {
  const doc = new Y.Doc();
  if (previousStateBase64) {
    Y.applyUpdate(
      doc,
      new Uint8Array(Buffer.from(previousStateBase64, 'base64'))
    );
  }

  const from = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment('content');
  doc.transact(() => {
    const paragraph = new Y.XmlElement('p');
    const xmlText = new Y.XmlText();
    xmlText.insert(0, text);
    paragraph.insert(0, [xmlText]);
    fragment.insert(fragment.length, [paragraph]);
  });

  const update = bytesToBase64(Y.encodeStateAsUpdate(doc, from));
  const state = bytesToBase64(Y.encodeStateAsUpdate(doc));
  doc.destroy();

  return {
    update: {
      updateId: `xml-${text}`,
      updateBase64: update,
    },
    state,
  };
}

function applyTextUpdates(args: {
  previousStateBase64?: string;
  updates: readonly YjsServerUpdateEnvelope[];
  containerKey?: string;
}): string {
  const doc = new Y.Doc();
  if (args.previousStateBase64) {
    Y.applyUpdate(
      doc,
      new Uint8Array(Buffer.from(args.previousStateBase64, 'base64'))
    );
  }
  for (const update of args.updates) {
    Y.applyUpdate(
      doc,
      new Uint8Array(Buffer.from(update.updateBase64, 'base64'))
    );
  }
  const text = doc.getText(args.containerKey ?? 'content').toString();
  doc.destroy();
  return text;
}

describe('@syncular/server-plugin-crdt-yjs', () => {
  it('buildYjsTextUpdate merges concurrent prepend and append without duplication', async () => {
    const base = await createUpdate('123');
    const prepend = await createUpdate('0123', base.state);
    const append = await createUpdate('1234', base.state);

    const mergedForward = applyTextUpdates({
      previousStateBase64: base.state,
      updates: [prepend.update, append.update],
      containerKey: 'content',
    });
    const mergedReverse = applyTextUpdates({
      previousStateBase64: base.state,
      updates: [append.update, prepend.update],
      containerKey: 'content',
    });

    expect(mergedForward).toBe('01234');
    expect(mergedReverse).toBe('01234');
  });

  it('applies Yjs envelopes against existing row state and strips envelope key', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const base = await createUpdate('Hello');
    const nextUpdate = await createUpdate('Hello world', base.state);

    const payload = {
      title: 'Task title',
      [YJS_PAYLOAD_KEY]: {
        content: nextUpdate.update,
      },
    };

    const nextPayload = await module.applyPayload({
      table: 'tasks',
      rowId: 'task-1',
      payload,
      existingRow: {
        id: 'task-1',
        content: 'Hello',
        content_yjs_state: base.state,
      },
    });

    expect(nextPayload.title).toBe('Task title');
    expect(nextPayload.content).toBe('Hello world');
    expect(typeof nextPayload.content_yjs_state).toBe('string');
    expect(YJS_PAYLOAD_KEY in nextPayload).toBe(false);
  });

  it('materializes outbound rows from Yjs state columns', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const base = await createUpdate('Derived text');
    const row = await module.materializeRow({
      table: 'tasks',
      row: {
        id: 'task-1',
        content: 'stale',
        content_yjs_state: base.state,
        [YJS_PAYLOAD_KEY]: {
          should_be_removed: true,
        },
      },
    });

    expect(row.content).toBe('Derived text');
    expect(YJS_PAYLOAD_KEY in row).toBe(false);
  });

  it('materializes rows when state is stored as UTF-8 bytes of a base64 string', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const base = await createUpdate('From bytes');
    const row = await module.materializeRow({
      table: 'tasks',
      row: {
        id: 'task-1',
        content: 'stale',
        content_yjs_state: new TextEncoder().encode(base.state),
      },
    });

    expect(row.content).toBe('From bytes');
  });

  it('throws in strict mode when envelope references unknown fields', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
      strict: true,
    });

    const update = await createUpdate('Hello');
    await expect(
      module.applyPayload({
        table: 'tasks',
        rowId: 'task-1',
        payload: {
          [YJS_PAYLOAD_KEY]: {
            unknown_field: update.update,
          },
        },
      })
    ).rejects.toThrow('No Yjs rule found for envelope field "unknown_field"');
  });

  it('prefers existing row state over stale payload state when applying envelopes', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
        },
      ],
    });

    const base = await createUpdate('Start');
    const otherClient = await createUpdate(
      'Start from other client',
      base.state
    );
    const localUpdate = await createUpdate(
      'Start from this client',
      base.state
    );

    const nextPayload = await module.applyPayload({
      table: 'tasks',
      rowId: 'task-1',
      payload: {
        content: 'Start from this client',
        content_yjs_state: localUpdate.state,
        [YJS_PAYLOAD_KEY]: {
          content: localUpdate.update,
        },
      },
      existingRow: {
        id: 'task-1',
        content: 'Start from other client',
        content_yjs_state: otherClient.state,
      },
    });

    expect(nextPayload.content).toContain('from other client');
    expect(nextPayload.content).toContain('from this client');
    expect(nextPayload.content_yjs_state).not.toBe(localUpdate.state);
  });

  it('materializes xml-fragment kind from Yjs state snapshots', async () => {
    const module = createYjsServerModule({
      rules: [
        {
          table: 'tasks',
          field: 'content',
          stateColumn: 'content_yjs_state',
          kind: 'xml-fragment',
        },
      ],
    });

    const xml = createXmlInsert('Hello XML');
    const row = await module.materializeRow({
      table: 'tasks',
      row: {
        id: 'task-1',
        content: 'stale',
        content_yjs_state: xml.state,
      },
    });

    expect(typeof row.content).toBe('string');
    expect(String(row.content)).toContain('Hello XML');
  });
});
