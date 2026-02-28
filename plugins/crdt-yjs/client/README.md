# @syncular/client-plugin-crdt-yjs

Yjs-first CRDT plugin for Syncular client integration.

Implemented:
- Rule-based field mapping: `{ table, field, stateColumn }`.
- Stable payload envelope key: `__yjs`.
- `beforePush` transformation:
  - Applies Yjs update envelopes to local state.
  - Materializes projection field values.
  - Stores canonical snapshot state in `stateColumn`.
  - Strips the envelope key by default to keep payload DB-safe.
- `afterPull` transformation for snapshot and incremental rows.
- `beforeApplyWsChanges` transformation for websocket inline rows.
- Helpers:
  - `buildYjsTextUpdate`
  - `applyYjsTextUpdates`

## Envelope Format

Outgoing payload example:

```ts
{
  __yjs: {
    content: {
      updateId: "upd-123",
      updateBase64: "<base64-encoded-yjs-update>"
    }
  }
}
```

The plugin converts this to:

```ts
{
  content: "materialized text",
  content_yjs_state: "<base64-encoded-yjs-snapshot>"
}
```

## Example

```ts
import { createYjsClientPlugin } from '@syncular/client-plugin-crdt-yjs';

const yjs = createYjsClientPlugin({
  rules: [
    {
      table: 'tasks',
      field: 'content',
      stateColumn: 'content_yjs_state',
    },
  ],
});
```
