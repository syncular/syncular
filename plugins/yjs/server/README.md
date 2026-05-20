# @syncular/server-plugin-yjs

Yjs-first server integration helpers for Syncular.

Implemented:
- Rule-based field mapping: `{ table, field, stateColumn }`.
- Kind-aware materialization: `text`, `xml-fragment`, `prosemirror`.
- Stable payload envelope key: `__yjs`.
- `createYjsServerModule()` with helpers:
  - `applyPayload(...)`: merge incoming Yjs envelopes into materialized payload + state column.
  - `materializeRow(...)`: derive projection field values from stored Yjs state.
  - `transformPullChanges(...)`: use client state-vector hints to send Yjs
    update envelopes instead of full CRDT state for eligible incremental pull
    rows.
- `createYjsServerPushPlugin()`:
  - `beforeApplyOperation`: CRDT envelope -> payload/state transform.
  - `afterApplyOperation`: materialize emitted rows + conflict rows.
  - `transformPullChanges`: wire the same state-vector diff behavior into
    Syncular server pulls.

For CRDT-only updates on existing rows, the server plugin carries existing row
columns forward before applying the Yjs envelope. This keeps default upsert
handlers from rejecting required non-CRDT columns while still letting the CRDT
field merge through Yjs.
- Utility exports:
  - `buildYjsTextUpdate`
  - `applyYjsTextUpdates`

## Example

```ts
import { createYjsServerModule } from '@syncular/server-plugin-yjs';

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
