/**
 * demo-react: a single-pane hooks todo app dogfooding the whole React
 * surface against the SAME server as apps/demo:
 *
 * - `SyncProvider` wraps the worker-mode `SyncClientHandle` (whole core in a
 *   worker on persistent OPFS; the page talks RPC).
 * - `useTypedQuery` (Kysely-typed by the generated `Database`) reads the
 *   visible list's todos, live — no SQL strings, exact table invalidation.
 * - `useMutation` adds/toggles/deletes (writes go through the outbox).
 * - `useSyncStatus` shows the outbox depth + upgrading/floor state.
 * - `useWindow` drives the list-filter dropdown: picking a list calls
 *   `setWindow([list])`, which subscribes+bootstraps that list and evicts the
 *   others (W1 value-sharded windowing, visible). `isComplete(list)` renders
 *   the completeness oracle honestly.
 */
import {
  SyncProvider,
  useMutation,
  useSyncStatus,
  useWindow,
} from '@syncular-v2/react';
import { useTypedQuery } from '@syncular-v2/react/typed';
import {
  createSyncClientHandle,
  type SyncClientHandle,
} from '@syncular-v2/web-client';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Database, schema, type TodosRow } from '../syncular.generated';

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

  // The typed live read — re-runs exactly when `todos` invalidates.
  const { rows, isLoading } = useTypedQuery<Database, TodosRow>(
    (db) =>
      db
        .selectFrom('todos')
        .selectAll()
        .where('list_id', '=', list)
        .orderBy('position')
        .orderBy('id'),
    [list],
  );

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

  const toggle = (row: TodosRow) => {
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
        <span className="hint">hooks + Kysely-typed live queries</span>
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
        (the outbox); reads are <code>useTypedQuery</code> (Kysely, read-only).
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
