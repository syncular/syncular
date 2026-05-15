# CRDT Adapter Examples

These examples live outside Syncular core on purpose. Syncular owns the durable
CRDT field primitive, Yjs/Yrs update persistence, compaction, encryption,
outbox/sync, and host bindings. Apps own editor schemas, editor plugins,
preview/title derivation, selection, undo stacks, and UI bridge messages.

## Generic Yjs Document Field

`yjs-document-field-adapter.ts` shows the intended app-layer shape for editors
that already expose Yjs binary updates, such as TipTap/ProseMirror through
`y-prosemirror`, or an Excalidraw integration backed by a Yjs document.

```ts
import {
  createYjsDocumentFieldAdapter,
  type YjsDocumentBinding,
} from "./yjs-document-field-adapter";
import { createSyncularV2WorkerClient } from "../../bindings/browser/src";

const syncular = await createSyncularV2WorkerClient({
  worker: new Worker(
    new URL("../../bindings/browser/src/worker-entry.ts", import.meta.url),
  ),
  config,
});

const tiptapBinding: YjsDocumentBinding = {
  subscribeLocalUpdates(listener) {
    const unsubscribe = editorYjsBridge.onUpdate((update: Uint8Array) => {
      listener(update);
    });
    return unsubscribe;
  },
  applyRemoteUpdate(update) {
    editorYjsBridge.applyUpdate(update);
  },
  replaceMaterializedValue(value) {
    viewModel.prosemirrorJson = value;
  },
};

const title = createYjsDocumentFieldAdapter(
  syncular,
  { table: "tasks", rowId: taskId, field: "title" },
  tiptapBinding,
  {
    flushDelayMs: 16,
    onFlushError(error) {
      reportDurableSaveFailure(error);
    },
  },
);

const stop = await title.start();

// After Syncular pulls remote changes or a live-query refresh invalidates the
// row, the app can update its view model from the durable materialized state.
await title.refreshMaterializedValue();

// Compact after idle periods, never on every keystroke.
await title.compact(100);

await stop();
```

The adapter intentionally does not import TipTap, ProseMirror, Excalidraw, or
Yjs directly. Each app connects its editor-specific update hooks to the small
`YjsDocumentBinding` interface.

The adapter preserves pending local updates if the Syncular write fails. A later
`flush()` retries the same update id instead of silently dropping editor state.
If the host exposes `enqueueCrdtFieldYjsUpdate`, the adapter uses that queued
path so native UI shells can return to the editor immediately while the Syncular
worker persists the update. Browser hosts can expose only
`applyCrdtFieldYjsUpdate`; the browser Worker still keeps SQLite and sync work
off the main thread.

Use `refreshMaterializedValue()` after Syncular live queries, realtime wakeups,
or row refreshes tell the app that durable state changed. `applyRemoteUpdate()`
is only for app/editor bridges that already receive raw Yjs updates from another
source; Syncular's normal host-facing refresh path is materialized state.

Executable coverage for the example lives next to it:

```sh
bun test rust/examples/crdt-adapters/yjs-document-field-adapter.test.ts
```

## What Not To Put In Core

Do not add TipTap node schemas, ProseMirror JSON transforms, slash-command
behavior, Excalidraw element derivation, editor undo stacks, or WebView bridge
message formats to Syncular runtime. Put those in app packages or optional
adapter packages above the generic CRDT field API.

For editors that only save whole JSON documents on close and do not expose a
real Yjs update stream, prefer a normal Syncular mutation plus app-level
conflict policy. Serializing whole JSON into a Yjs text field can corrupt JSON
under concurrent edits because text CRDTs merge characters, not semantic scene
objects.
