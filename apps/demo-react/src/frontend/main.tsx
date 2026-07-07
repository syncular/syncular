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
 * - `useWindow` drives the list-filter dropdown: picking a list calls
 *   `setWindow([list])`, which subscribes+bootstraps that list and evicts the
 *   others (W1 value-sharded windowing, visible). `isComplete(list)` renders
 *   the completeness oracle honestly.
 */

import {
  createSyncClientHandle,
  type SyncClientHandle,
} from '@syncular/client';
import {
  SyncProvider,
  useMutation,
  useQuery,
  useRawSql,
  useSyncStatus,
  useWindow,
} from '@syncular/react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { schema, type TodosRow } from '../syncular.generated';
import { type ListTodosRow, listTodosQuery } from '../syncular.queries';

const LISTS = ['groceries', 'work', 'travel'] as const;
type ListId = (typeof LISTS)[number];
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

/** The window base: todos value-sharded by list_id (§4.8 / W1). */
const WINDOW_BASE = { table: 'todos', variable: 'list_id' } as const;

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
  const { units, setWindow, isComplete } = useWindow(WINDOW_BASE);
  const { mutate, isPending } = useMutation();

  // Window the selected list in on mount and whenever the dropdown changes:
  // one live unit at a time, so switching evicts the previous list (W1).
  useEffect(() => {
    void setWindow([list]);
  }, [list, setWindow]);

  // The live read — a NAMED query (typegen's sqlc-style tier): the SQL lives
  // in `queries/list-todos.sql`, typegen emits `listTodosQuery` (typed row +
  // exact `{tables}`), and `useQuery` runs it live, re-running exactly when
  // `todos` invalidates. This is the recommended type-safe read tier.
  const { rows, isLoading } = useQuery(listTodosQuery, { listId: list });

  // The escape-hatch tier: an aggregate for the header badge (done vs total),
  // via `useRawSql` — a guarded read-only string with its `{tables}` given
  // explicitly so invalidation stays exact.
  const { rows: summary } = useRawSql<{ total: number; done_count: number }>(
    'SELECT count(*) AS total, sum(done) AS done_count FROM todos WHERE list_id = ?',
    [list],
    { tables: ['todos'] },
  );
  const doneCount = summary[0]?.done_count ?? 0;

  const complete = isComplete(list);

  const add = (title: string) => {
    const position =
      rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: crypto.randomUUID(),
          list_id: list,
          title,
          done: false,
          position,
          updated_at_ms: Date.now(),
          attachment: null,
        } satisfies TodosRow,
      },
    ]);
  };

  const toggle = (row: ListTodosRow) => {
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          ...row,
          done: !row.done,
          updated_at_ms: Date.now(),
        } satisfies TodosRow,
      },
    ]);
  };

  const remove = (id: string) => {
    void mutate([{ table: 'todos', op: 'delete', rowId: id }]);
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
        <span className="hint">windowed-in: {units.join(', ') || '—'}</span>
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
        <button type="submit" disabled={isPending}>
          Add
        </button>
      </form>

      {isLoading ? (
        <div className="empty">loading…</div>
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

      {!complete ? (
        <div className="partial">
          this list is not fully windowed-in — data may be partial (I3)
        </div>
      ) : null}

      <footer>
        Worker + OPFS client, same server as the two-pane demo. The list
        dropdown drives <code>useWindow.setWindow([list])</code> — switching
        lists bootstraps the new list and evicts the previous one (W1
        value-sharded windowing). Writes go through <code>useMutation</code>{' '}
        (the outbox); the list read is a <code>useQuery</code> (typed{' '}
        <code>.sql</code>, exact invalidation) and the done-count badge is a{' '}
        <code>useRawSql</code> (raw tier) — both read-only.
      </footer>
    </>
  );
}

function Root() {
  const [handle, setHandle] = useState<SyncClientHandle | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live: SyncClientHandle | undefined;
    void createSyncClientHandle({
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
    })
      .then(async (h) => {
        live = h;
        // Connect-then-sync boot order (§8.7): the first round rides the
        // socket and registers this connection's subscriptions at round end.
        try {
          await h.connectRealtime();
        } catch {
          // HTTP sync still works without the socket.
        }
        setHandle(h);
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      void live?.close();
    };
  }, []);

  if (error !== undefined) {
    return <div className="empty">failed to start: {error}</div>;
  }
  if (handle === undefined) {
    return <div className="empty">starting client core…</div>;
  }
  return (
    <SyncProvider client={handle}>
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
