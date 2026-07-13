/**
 * The shared React tree — every line below `<SyncProvider>` runs unchanged
 * on BOTH hosts. In a browser it talks to the worker core on OPFS; inside
 * the Tauri webview it talks to the native Rust core in the host process.
 * The only host-aware code is `createEngine()` in `./engine.ts`.
 *
 * - `useRawSql` — the live todo list; re-runs exactly when `todos`
 *   invalidates.
 * - `useMutation` — add / toggle / delete; writes go through the outbox.
 * - `useSyncStatus` — outbox depth + upgrading / schema-floor badges.
 */
import {
  SyncProvider,
  useMutation,
  useRawSql,
  useSyncStatus,
} from '@syncular/react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type TodosRow, todoListSubscription } from '../syncular.generated';
import { createEngine, type Engine } from './engine';

const LIST_ID = 'welcome';

// -- app (host-agnostic from here down) ---------------------------------------

function StatusLine() {
  const status = useSyncStatus();
  if (status.isLoading) return <span className="status">connecting…</span>;
  return (
    <span className="status">
      <span className={`badge ${status.outbox === 0 ? 'ok' : 'warn'}`}>
        outbox {status.outbox}
      </span>
      {status.upgrading ? <span className="badge warn">upgrading…</span> : null}
      {status.schemaFloor !== undefined ? (
        <span className="badge warn">schema floor</span>
      ) : null}
    </span>
  );
}

function TodoApp() {
  const { mutate, isPending, error } = useMutation();

  // Live local read: re-runs exactly when `todos` invalidates.
  const { rows, isLoading } = useRawSql<TodosRow>(
    'SELECT id, list_id AS listId, title, done, position,' +
      ' updated_at_ms AS updatedAtMs FROM todos WHERE list_id = ?' +
      ' ORDER BY position, id',
    [LIST_ID],
  );

  const add = (title: string) => {
    const position =
      rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: crypto.randomUUID(),
          listId: LIST_ID,
          title,
          done: false,
          position,
          updatedAtMs: Date.now(),
        },
      },
    ]);
  };

  const toggle = (row: TodosRow) => {
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: { ...row, done: !row.done, updatedAtMs: Date.now() },
      },
    ]);
  };

  const remove = (id: string) => {
    void mutate([{ table: 'todos', op: 'delete', rowId: id }]);
  };

  return (
    <>
      <header>
        <h1>__PROJECT_NAME__</h1>
        <StatusLine />
      </header>

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
        <input name="title" placeholder="a new todo" autoComplete="off" />
        <button type="submit" disabled={isPending}>
          add
        </button>
      </form>

      {/* Always render the write error: a dead worker/bridge RPC otherwise
          fails silently and "add does nothing" is undebuggable. */}
      {error !== undefined ? (
        <div className="error">write failed: {String(error)}</div>
      ) : null}

      {isLoading ? (
        <div className="empty">loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">no todos yet — add one</div>
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

      <footer>
        One React tree, two hosts: in the browser this is the worker core on
        OPFS; in the Tauri window it is the native Rust core. The seam is{' '}
        <code>src/frontend/engine.ts</code>.
      </footer>
    </>
  );
}

function Root() {
  const [engine, setEngine] = useState<Engine | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live: Engine | undefined;
    void createEngine()
      .then(async (e) => {
        live = e;
        await e.subscribe({
          id: 'todos',
          table: 'todos',
          scopes: todoListSubscription.scopes({ listId: LIST_ID }),
        });
        // Ride the socket for realtime; HTTP sync still works without it.
        try {
          await e.connectRealtime();
        } catch {
          // offline / no socket — the host loop keeps syncing over HTTP
        }
        setEngine(e);
      })
      .catch((err: unknown) => setError(String(err)));
    return () => {
      void live?.close();
    };
  }, []);

  if (error !== undefined) {
    return <div className="empty">failed to start: {error}</div>;
  }
  if (engine === undefined) {
    return <div className="empty">starting client core…</div>;
  }
  return (
    <SyncProvider client={engine}>
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
