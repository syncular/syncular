import * as Y from 'yjs';
import {
  type SyncularCrdtProjectionDefinition,
  type SyncularCrdtProjectionEvent,
  type YjsDocumentBinding,
  type YjsDocumentRestoreReceipt,
} from './yjs-document-field-adapter';

export interface YjsProseMirrorBridgeOptions {
  containerKey: string;
  doc?: Y.Doc;
  localOrigin?: unknown;
  remoteOrigin?: unknown;
  ignoredOrigins?: readonly unknown[];
  onDocumentReplaced?: (event: YjsProseMirrorDocumentReplacedEvent) => void;
}

export interface YjsProseMirrorDocumentReplacedEvent {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  receipt?: YjsDocumentRestoreReceipt;
}

export interface YjsProseMirrorBridge extends YjsDocumentBinding {
  doc(): Y.Doc;
  fragment(): Y.XmlFragment;
  replaceDocumentFromState(
    state: Uint8Array,
    receipt?: YjsDocumentRestoreReceipt
  ): void;
  encodeStateAsUpdate(): Uint8Array;
  destroy(): void;
}

export interface ProseMirrorReadModel {
  table: string;
  rowId: string;
  field: string;
  prosemirrorJson: unknown;
  title: string;
  preview: string;
  outline: string[];
  searchText: string;
  stateVectorBase64: string;
  source: SyncularCrdtProjectionEvent['source'];
  reason: SyncularCrdtProjectionEvent['reason'];
  operation?: string;
  commitId?: string | null;
  commitSeq?: number | null;
  serverVersion?: number | null;
  documentKey?: string;
  pendingUpdates?: number;
  flushedUpdates?: number;
  ackedUpdates?: number;
  logUpdates?: number;
  updatedAt?: number;
  compactedAt?: number | null;
  latestUpdateId?: string;
  latestUpdateStatus?: string;
}

export interface ProseMirrorReadModelStore {
  upsert(
    model: ProseMirrorReadModel,
    event: SyncularCrdtProjectionEvent
  ): void | Promise<void>;
}

export interface ProseMirrorReadModelProjectionOptions {
  store: ProseMirrorReadModelStore;
  derive?: (value: unknown, event: SyncularCrdtProjectionEvent) => {
    prosemirrorJson: unknown;
    title: string;
    preview: string;
    outline: string[];
    searchText: string;
  };
}

const DEFAULT_REMOTE_ORIGIN = Symbol.for('syncular.crdt.remote');

export function createYjsProseMirrorBridge(
  options: YjsProseMirrorBridgeOptions
): YjsProseMirrorBridge {
  let doc = options.doc ?? new Y.Doc();
  let fragment = doc.getXmlFragment(options.containerKey);
  const remoteOrigin = options.remoteOrigin ?? DEFAULT_REMOTE_ORIGIN;
  const ignoredOrigins = new Set<unknown>([
    remoteOrigin,
    ...(options.ignoredOrigins ?? []),
  ]);
  const localListeners = new Set<(update: Uint8Array) => void>();
  const docUnsubscribers = new Map<(update: Uint8Array) => void, () => void>();

  const attachListener = (listener: (update: Uint8Array) => void) => {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (ignoredOrigins.has(origin)) return;
      listener(update);
    };
    doc.on('update', handler);
    docUnsubscribers.set(listener, () => {
      doc.off('update', handler);
    });
  };

  const attachAllListeners = () => {
    for (const listener of localListeners) attachListener(listener);
  };

  const detachAllListeners = () => {
    for (const unsubscribe of docUnsubscribers.values()) unsubscribe();
    docUnsubscribers.clear();
  };

  const replaceDoc = (
    nextDoc: Y.Doc,
    receipt?: YjsDocumentRestoreReceipt
  ) => {
    detachAllListeners();
    doc.destroy();
    doc = nextDoc;
    fragment = doc.getXmlFragment(options.containerKey);
    attachAllListeners();
    options.onDocumentReplaced?.({ doc, fragment, receipt });
  };

  return {
    subscribeLocalUpdates(listener) {
      localListeners.add(listener);
      attachListener(listener);
      return () => {
        localListeners.delete(listener);
        docUnsubscribers.get(listener)?.();
        docUnsubscribers.delete(listener);
      };
    },

    applyRemoteUpdate(update) {
      Y.applyUpdate(doc, update, remoteOrigin);
    },

    replaceDocumentState(state, receipt) {
      this.replaceDocumentFromState(state, receipt);
    },

    replaceMaterializedValue() {},

    doc() {
      return doc;
    },

    fragment() {
      return fragment;
    },

    replaceDocumentFromState(state, receipt) {
      const nextDoc = new Y.Doc();
      if (state.length > 0) {
        Y.applyUpdate(nextDoc, state, remoteOrigin);
      }
      replaceDoc(nextDoc, receipt);
    },

    encodeStateAsUpdate() {
      return Y.encodeStateAsUpdate(doc);
    },

    destroy() {
      detachAllListeners();
      localListeners.clear();
      doc.destroy();
    },
  };
}

export function prosemirrorJsonProjection(value: unknown): {
  prosemirrorJson: unknown;
  title: string;
  preview: string;
  outline: string[];
  searchText: string;
} {
  const text = extractProseMirrorText(value);
  const headings = extractProseMirrorHeadings(value);
  return {
    prosemirrorJson: value,
    title: headings[0] ?? firstLine(text) ?? '',
    preview: text.slice(0, 240),
    outline: headings,
    searchText: text,
  };
}

export function createProseMirrorReadModelProjection(
  options: ProseMirrorReadModelProjectionOptions
): SyncularCrdtProjectionDefinition<ProseMirrorReadModel> {
  return {
    derive(materialization, event) {
      const derived =
        options.derive?.(materialization.value, event) ??
        prosemirrorJsonProjection(materialization.value);
      return {
        table: event.field.table,
        rowId: event.field.rowId,
        field: event.field.field,
        ...derived,
        stateVectorBase64: event.stateVectorBase64,
        source: event.source,
        reason: event.reason,
        operation: event.operation,
        commitId: event.commitId,
        commitSeq: event.commitSeq,
        serverVersion: event.serverVersion,
        documentKey: event.documentSnapshot?.documentKey,
        pendingUpdates: event.documentSnapshot?.pendingUpdates,
        flushedUpdates: event.documentSnapshot?.flushedUpdates,
        ackedUpdates: event.documentSnapshot?.ackedUpdates,
        logUpdates: event.documentSnapshot?.logUpdates,
        updatedAt: event.documentSnapshot?.updatedAt,
        compactedAt: event.documentSnapshot?.compactedAt,
        latestUpdateId: event.latestUpdate?.updateId,
        latestUpdateStatus: event.latestUpdate?.status,
      };
    },

    apply(model, event) {
      return options.store.upsert(model, event);
    },
  };
}

export function extractProseMirrorText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (node == null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
    const content = record.content;
    if (Array.isArray(content)) {
      for (const child of content) visit(child);
    }
  };
  visit(value);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractProseMirrorHeadings(value: unknown): string[] {
  const headings: string[] = [];
  const visit = (node: unknown) => {
    if (node == null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'heading') {
      const text = extractProseMirrorText(record);
      if (text !== '') headings.push(text);
    }
    const content = record.content;
    if (Array.isArray(content)) {
      for (const child of content) visit(child);
    }
  };
  visit(value);
  return headings;
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
}
