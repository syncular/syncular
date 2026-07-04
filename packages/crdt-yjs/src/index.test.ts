import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import { YjsColumn, yjsCrdtMergers, yjsDocMerger } from './index';

/** Produce a Yjs update for a doc whose text is `content`. */
function textUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('text').insert(0, content);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function readText(bytes: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const text = doc.getText('text').toString();
  doc.destroy();
  return text;
}

describe('yjs-doc merger (SPEC.md §5.10.2)', () => {
  it('is registered under the yjs-doc crdtType', () => {
    expect(typeof yjsCrdtMergers['yjs-doc']).toBe('function');
  });

  it('merges a null stored value with an incoming update (insert path)', async () => {
    const merged = await yjsDocMerger(null, textUpdate('hello'));
    expect(readText(merged)).toBe('hello');
  });

  it('is idempotent — re-merging the same update changes nothing', async () => {
    const update = textUpdate('hello');
    const once = await yjsDocMerger(null, update);
    const twice = await yjsDocMerger(once, update);
    expect(readText(twice)).toBe('hello');
    // Byte-stable: re-applying an already-incorporated update is a no-op.
    expect(readText(twice)).toBe(readText(once));
  });

  it('converges concurrent edits order-independently (commutativity)', async () => {
    // Two docs branch from a shared base, each inserts distinctly.
    const base = new Y.Doc();
    base.getText('text').insert(0, 'X');
    const baseBytes = Y.encodeStateAsUpdate(base);

    const a = new Y.Doc();
    Y.applyUpdate(a, baseBytes);
    a.getText('text').insert(1, 'A');
    const aUpdate = Y.encodeStateAsUpdate(a);

    const b = new Y.Doc();
    Y.applyUpdate(b, baseBytes);
    b.getText('text').insert(1, 'B');
    const bUpdate = Y.encodeStateAsUpdate(b);

    // Server sees A then B ...
    const ab = await yjsDocMerger(
      await yjsDocMerger(baseBytes, aUpdate),
      bUpdate,
    );
    // ... versus B then A: same converged text.
    const ba = await yjsDocMerger(
      await yjsDocMerger(baseBytes, bUpdate),
      aUpdate,
    );
    expect(readText(ab)).toBe(readText(ba));
    expect(readText(ab)).toContain('A');
    expect(readText(ab)).toContain('B');

    base.destroy();
    a.destroy();
    b.destroy();
  });
});

describe('YjsColumn client helper (SPEC.md §5.10.4)', () => {
  it('produces column bytes and applies server-merged bytes idempotently', async () => {
    const col = new YjsColumn();
    col.text().insert(0, 'draft');
    const local = col.columnBytes();

    // Server merges the local update (null stored) and returns merged bytes.
    const serverMerged = await yjsDocMerger(null, local);
    col.applyServerBytes(serverMerged); // no-op — already incorporated
    expect(col.text().toString()).toBe('draft');
    col.destroy();
  });
});
