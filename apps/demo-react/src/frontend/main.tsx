/**
 * demo-react: a single-pane hooks todo app dogfooding the whole React
 * surface against the SAME server as apps/demo:
 *
 * - `SyncProvider` wraps the worker-mode `SyncClientHandle` (whole core in a
 *   worker on persistent OPFS; the page talks RPC).
 * - `useQuery` (typegen's named-query tier) reads the visible list's todos,
 *   live — the SQL lives in `queries/list-todos.sql`, typed row + exact
 *   `{tables}` invalidation, no SQL strings in the component.
 * - `useRawSql` (the raw escape-hatch tier) computes the done/total badge —
 *   guarded read-only, exact `{tables}` given explicitly.
 * - `useMutation` adds/toggles/deletes (writes go through the outbox).
 * - `useSyncStatus` shows the outbox depth + upgrading/floor state.
 * - the generated query descriptor owns the list window claim. Rows,
 *   completeness and the exact local revision arrive as one atomic snapshot.
 */

import {
  browserConnectivitySignal,
  createSyncClientHandle,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';
import {
  retainViteSyncClientResource,
  SyncProvider,
  useMutation,
  useQuery,
  useRawSql,
  useSyncStatus,
} from '@syncular/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { schema, todosTable } from '../syncular.generated';
import { type ListTodosRow, listTodosQuery } from '../syncular.queries';

const LISTS = ['groceries', 'work', 'travel'] as const;
type ListId = (typeof LISTS)[number];
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

// -- app ----------------------------------------------------------------------

function StatusBadges() {
  const status = useSyncStatus();
  return (
    <>
      <span className={`badge ${status.outbox === 0 ? 'ok' : 'warn'}`}>
        outbox {status.outbox}
      </span>
      {status.upgrading ? <span className="badge warn">upgrading…</span> : null}
      {status.schemaFloor !== undefined ? (
        <span className="badge warn">schema floor</span>
      ) : null}
    </>
  );
}

function TodoApp() {
  const [list, setList] = useState<ListId>('groceries');
  const mutation = useMutation(todosTable);

  // The live read — a NAMED query (typegen's sqlc-style tier): the SQL lives
  // in `queries/list-todos.syql`. Typegen emits its exact dependencies,
  // window coverage, cache identity and row key. The store claims that window
  // and reads rows + completeness + revision atomically.
  const todos = useQuery(listTodosQuery, { listId: list });
  const { rows } = todos;

  // The escape-hatch tier: an aggregate for the header badge (done vs total),
  // via `useRawSql` — a guarded read-only string with its `{tables}` given
  // explicitly so invalidation stays exact.
  const { rows: summary } = useRawSql<{ total: number; done_count: number }>(
    'SELECT count(*) AS total, sum(done) AS done_count FROM todos WHERE list_id = ?',
    [list],
    { tables: ['todos'] },
  );
  const doneCount = summary[0]?.done_count ?? 0;

  const add = (title: string) => {
    const position =
      rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
    void mutation.upsert({
      id: crypto.randomUUID(),
      listId: list,
      title,
      done: false,
      position,
      updatedAtMs: Date.now(),
      attachment: null,
    });
  };

  const toggle = (row: ListTodosRow) => {
    void mutation.patch(row.id, {
      done: !row.done,
      updatedAtMs: Date.now(),
    });
  };

  const remove = (id: string) => {
    void mutation.remove(id);
  };

  return (
    <>
      <header>
        <h1>syncular v2 — demo-react</h1>
        <span className="hint">
          named query + raw SQL — {doneCount}/{rows.length} done
        </span>
        <StatusBadges />
      </header>

      <div className="toolbar">
        <label htmlFor="list">list:</label>
        <select
          id="list"
          value={list}
          onChange={(e) => setList(e.target.value as ListId)}
        >
          {LISTS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="hint">view phase: {todos.phase}</span>
      </div>

      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            'title',
          ) as HTMLInputElement;
          const value = input.value.trim();
          if (value.length === 0) return;
          input.value = '';
          add(value);
        }}
      >
        <input
          name="title"
          placeholder={`Add to "${list}"…`}
          autoComplete="off"
        />
        <button type="submit" disabled={mutation.isPending}>
          Add
        </button>
      </form>

      {todos.phase === 'loading' ? (
        <div className="empty">loading…</div>
      ) : todos.phase === 'error' ? (
        <div className="empty">query failed: {todos.error?.message}</div>
      ) : rows.length === 0 ? (
        <div className="empty">no todos in this list yet</div>
      ) : (
        <ul className="todos">
          {rows.map((row) => (
            <li key={row.id} className={row.done ? 'done' : ''}>
              <input
                type="checkbox"
                checked={Boolean(row.done)}
                onChange={() => toggle(row)}
              />
              <span className="title">{row.title}</span>
              <button
                type="button"
                className="del"
                title="delete"
                onClick={() => remove(row.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {todos.phase === 'partial' ? (
        <div className="partial">
          this list is not fully windowed-in — data may be partial (I3)
        </div>
      ) : null}

      <footer>
        Worker + OPFS client, same server as the two-pane demo. The list query's
        generated coverage claims the selected list, and its atomic snapshot
        drives loading/partial/ready without a separate window read. Writes use
        typed table helpers; the done-count badge remains a{' '}
        <code>useRawSql</code> escape hatch.
      </footer>
    </>
  );
}

async function createClient() {
  const handle = await createSyncClientHandle({
    worker: () => new Worker('/worker.js', { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: 'demo-react' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      blobsUrl: '/blobs',
      realtimeUrl: `${WS_PROTO}://${location.host}/realtime?clientId={clientId}`,
    },
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    autoSync: true,
    lockName: 'syncular-demo-react',
  });
  return installRealtimeSupervisor(handle, {
    connectivity: browserConnectivitySignal(),
    lifecycle: documentLifecycleSignal(),
  });
}

interface ViteHotContext {
  readonly data: Record<string, unknown>;
  invalidate(message?: string): void;
}

// Capture the number during this module evaluation. Never compare an old
// resource against the later value of a hot-updated ESM schema binding.
const capturedSchemaVersion = schema.version;
const hot = (import.meta as ImportMeta & { readonly hot?: ViteHotContext }).hot;
const retainedClient = await retainViteSyncClientResource(
  hot?.data,
  capturedSchemaVersion,
  createClient,
);
const clientResource = retainedClient.resource;

if (
  hot !== undefined &&
  retainedClient.ownerChanged &&
  retainedClient.disposalError === undefined
) {
  hot.invalidate('Syncular owner identity changed');
}

function Root() {
  return (
    <SyncProvider
      client={clientResource}
      renderBoundary={(state, actions) => (
        <div className="empty">
          sync unavailable: {state.state}
          {'reason' in state ? ` (${state.reason})` : ''}
          {state.state === 'startup-error' ? `: ${state.error.message}` : ''}
          {actions.retry !== undefined ? (
            <button type="button" onClick={() => void actions.retry?.()}>
              retry
            </button>
          ) : null}
        </div>
      )}
    >
      <TodoApp />
    </SyncProvider>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
