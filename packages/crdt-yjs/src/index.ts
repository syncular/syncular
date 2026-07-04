/**
 * @syncular-v2/crdt-yjs — the reference Yjs binding for CRDT columns
 * (SPEC.md §5.10). Two faces of one Yjs integration:
 *
 * - the SERVER-side `yjsDocMerger` (§5.10.2): a `CrdtMerger` for `crdtType`
 *   `'yjs-doc'` — this is where Yjs is *required*, so it lives here, never in
 *   `@syncular-v2/core` or `@syncular-v2/server` (the blob-store rule,
 *   §5.9.2);
 * - the CLIENT-side `YjsColumn` helper (§5.10.4): a thin `Y.Doc` wrapper an
 *   app uses to produce update bytes for a `crdt` column and to apply
 *   server-merged bytes back. Codegen has no Yjs dependency; this accessor
 *   does.
 *
 * Yjs enters the dependency tree exactly here.
 */

import type { CrdtMerger, CrdtMergerRegistry } from '@syncular-v2/server';
import * as Y from 'yjs';

/** The one built-in `crdtType` this rung defines (§5.10.1). */
export const YJS_DOC_CRDT_TYPE = 'yjs-doc';

/**
 * §5.10.2 merger for `crdtType` `'yjs-doc'`. `stored` and `incoming` are Yjs
 * updates (or a full doc state — a state is a legal update). Merge = apply
 * both into a fresh doc and re-encode the whole state as one update. This is
 * commutative, associative, and idempotent (the Yjs CRDT contract), so
 * concurrent pushes converge order-independently and a replayed update is a
 * no-op (§5.10.3).
 */
export const yjsDocMerger: CrdtMerger = (stored, incoming) => {
  const doc = new Y.Doc();
  try {
    if (stored !== null && stored.length > 0) Y.applyUpdate(doc, stored);
    if (incoming.length > 0) Y.applyUpdate(doc, incoming);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
};

/** A registry pre-wired with the `yjs-doc` merger — pass to the server ctx
 * `crdtMergers` (§5.10.2). Spread to add host mergers. */
export const yjsCrdtMergers: CrdtMergerRegistry = {
  [YJS_DOC_CRDT_TYPE]: yjsDocMerger,
};

/**
 * §5.10.4 client helper: a `Y.Doc` bound to one `crdt` column value. The app
 * mutates the doc (its shared types) and reads `columnBytes()` to store in a
 * `mutate` (baseVersion-less, §5.10.3); on delivery of server-merged bytes it
 * calls `applyServerBytes()`. The raw bytes are the transport; the doc is the
 * app-visible collaborative value.
 */
export class YjsColumn {
  readonly doc: Y.Doc;

  constructor(initial?: Uint8Array | null) {
    this.doc = new Y.Doc();
    if (initial !== undefined && initial !== null && initial.length > 0) {
      Y.applyUpdate(this.doc, initial);
    }
  }

  /** A shared text (the common collaborative-text case). */
  text(name = 'text'): Y.Text {
    return this.doc.getText(name);
  }

  /** A shared map. */
  map(name = 'map'): Y.Map<unknown> {
    return this.doc.getMap(name);
  }

  /** The bytes to store in the `crdt` column (the full doc state as an
   * update). Idempotent on the server merger, so pushing the whole state is
   * safe even though it is larger than a per-edit delta — apps that want the
   * minimal delta can diff with `Y.encodeStateAsUpdate(doc, stateVector)`. */
  columnBytes(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Apply server-merged bytes (a pull COMMIT upsert, a segment row, or a
   * conflict `serverRow`) into the local doc — idempotent (§5.10.4). */
  applyServerBytes(bytes: Uint8Array): void {
    if (bytes.length > 0) Y.applyUpdate(this.doc, bytes);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

export { Y };
