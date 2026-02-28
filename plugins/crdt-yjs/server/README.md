# @syncular/server-plugin-crdt-yjs

Yjs-first server integration helpers for Syncular.

Implemented:
- Rule-based field mapping: `{ table, field, stateColumn }`.
- Stable payload envelope key: `__yjs`.
- `createYjsServerModule()` with helpers:
  - `applyPayload(...)`: merge incoming Yjs envelopes into materialized payload + state column.
  - `materializeRow(...)`: derive projection field values from stored Yjs state.
- Utility exports:
  - `buildYjsTextUpdate`
  - `applyYjsTextUpdates`

## Example

```ts
import { createYjsServerModule } from '@syncular/server-plugin-crdt-yjs';

const yjs = createYjsServerModule({
  rules: [
    {
      table: 'tasks',
      field: 'content',
      stateColumn: 'content_yjs_state',
    },
  ],
});

const nextPayload = yjs.applyPayload({
  table: 'tasks',
  rowId: 'task-1',
  payload: incomingPayload,
  existingRow: currentRow,
});
```
