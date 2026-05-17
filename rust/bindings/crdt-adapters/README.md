# @syncular/client-rust-crdt-adapters

Rich-editor CRDT adapters for `@syncular/client-rust`.

This package owns app-layer glue for Yjs-backed editors:

- local Yjs update capture and flushing
- compacted `stateBase64` restore
- Syncular row-change driven projection rebuilds
- ProseMirror read-model derivation
- bounded queue backpressure UX helpers
- WebView-to-host CRDT request facade for host-owned editor shells

Syncular runtime remains responsible for canonical CRDT persistence. ProseMirror
JSON, title, preview, outline, and search text remain derived app-owned read
models.

## Host-Owned WebViews

For Flutter/native shells where a WebView emits Yjs updates and Rust/Syncular
lives in the host, do not instantiate a second browser-side Syncular client for
the same editor field. Use `createSyncularCrdtWebViewHost()` inside the WebView
to expose the same async `SyncularCrdtFieldHost` contract, then let the host
handle the protocol messages and call Rust.

```ts
import {
  createRichEditorCrdtAdapter,
  createSyncularCrdtJsonTransport,
  createSyncularCrdtWebViewHost,
  createYjsProseMirrorBridge,
} from "@syncular/client-rust-crdt-adapters";

const bridge = createSyncularCrdtWebViewHost({
  transport: createSyncularCrdtJsonTransport({
    postJsonMessage(message) {
      window.ReactNativeWebView.postMessage(message);
    },
    addJsonMessageListener(listener) {
      const handler = (event: MessageEvent) => {
        listener(String(event.data));
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
  }),
});

const yjs = createYjsProseMirrorBridge({
  containerKey: "body",
  onDocumentReplaced({ doc, fragment }) {
    editorYjsBridge.rebind({ doc, fragment });
  },
});

const editorCrdt = createRichEditorCrdtAdapter(
  bridge.host,
  { table: "notes", rowId: noteId, field: "body" },
  yjs,
  readModelProjection,
  {
    field: { restoreOnStart: true },
    projections: { materializeOnStart: true },
  },
);
```

The host side can implement the `syncular.crdt.host.v1` request/response
messages directly, or use `createSyncularCrdtWebViewHostResponder()` when both
sides are JavaScript during tests. Rows-changed messages fan out through
`addRowsChangedListener`, so app projection materializers rebuild title,
preview, outline, search text, and ProseMirror JSON from canonical CRDT state
after local writes, remote apply, and compaction.

Hosts that already have a JavaScript boundary can use
`createSyncularCrdtHostResponseMessage()` or
`dispatchSyncularCrdtHostRequest()` to share the same method switch as the test
responder. Native event loops can turn Rust `nextEventJson()` rows-changed
events into WebView pushes with
`syncularCrdtRowsChangedMessageFromNativeEventJson()`.

## WebView Host Protocol

Messages are JSON objects with `protocol: "syncular.crdt.host.v1"`.

WebView request:

```json
{
  "protocol": "syncular.crdt.host.v1",
  "type": "syncular.crdt.host.request",
  "id": "request-1",
  "method": "enqueueCrdtFieldYjsUpdate",
  "request": {
    "table": "notes",
    "rowId": "note-1",
    "field": "body",
    "update": { "updateId": "u1", "updateBase64": "AQID" }
  }
}
```

Host success response:

```json
{
  "protocol": "syncular.crdt.host.v1",
  "type": "syncular.crdt.host.response",
  "id": "request-1",
  "ok": true,
  "response": "command-1"
}
```

Host rows-changed push:

```json
{
  "protocol": "syncular.crdt.host.v1",
  "type": "syncular.crdt.host.rowsChanged",
  "event": {
    "source": "remotePull",
    "changedTables": ["notes"],
    "changedRows": [
      {
        "table": "notes",
        "rowId": "note-1",
        "operation": "compact",
        "changedFields": ["body"],
        "crdtFields": ["body"],
        "commitId": "commit-1",
        "commitSeq": 12,
        "serverVersion": 44
      }
    ]
  }
}
```

Supported request methods are `openCrdtField`, `applyCrdtFieldYjsUpdate`,
`enqueueCrdtFieldYjsUpdate`, `materializeCrdtField`,
`crdtDocumentSnapshot`, `crdtUpdateLog`,
`snapshotCrdtFieldStateVector`, and `compactCrdtField`.

Native event forwarding:

```ts
const message = syncularCrdtRowsChangedMessageFromNativeEventJson(eventJson);
if (message) {
  webView.postMessage(JSON.stringify(message));
}
```
