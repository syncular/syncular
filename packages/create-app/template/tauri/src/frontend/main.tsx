/**
 * The shared React tree — every line below `<SyncProvider>` runs unchanged
 * on BOTH hosts. In a browser it talks to the worker core on OPFS; inside
 * the Tauri webview it talks to the native Rust core in the host process.
 * The only host-aware code is `createEngine()` in `./engine.ts`.
 *
 * - generated `useQuery` — exact dependencies, coverage, revision and row key.
 * - typed `useMutation` — add / toggle / delete through the outbox.
 * - `useSyncStatus` — outbox depth + upgrading / schema-floor badges.
 */
import {
  createSyncClientResource,
  SyncProvider,
  useMutation,
  useQuery,
  useSyncStatus,
} from '@syncular/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { todosTable } from '../syncular.generated';
import { type ListTodosRow, listTodosQuery } from '../syncular.queries';
import { createEngine } from './engine';

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
  const mutation = useMutation(todosTable);

  const todos = useQuery(listTodosQuery, { listId: LIST_ID });
  const { rows } = todos;

  const add = (title: string) => {
    const position =
      rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
    void mutation.upsert({
      id: crypto.randomUUID(),
      listId: LIST_ID,
      title,
      done: false,
      position,
      updatedAtMs: Date.now(),
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
        <button type="submit" disabled={mutation.isPending}>
          add
        </button>
      </form>

      {/* Always render the write error: a dead worker/bridge RPC otherwise
          fails silently and "add does nothing" is undebuggable. */}
      {mutation.error !== undefined ? (
        <div className="error">write failed: {mutation.error.message}</div>
      ) : null}

      {todos.phase === 'loading' ? (
        <div className="empty">loading…</div>
      ) : todos.phase === 'error' ? (
        <div className="empty">query failed: {todos.error?.message}</div>
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

const engineResource = createSyncClientResource(async () => {
  const engine = await createEngine();
  try {
    await engine.connectRealtime();
  } catch {
    // offline / no socket — the host loop keeps syncing over HTTP
  }
  return engine;
});

function Root() {
  return (
    <SyncProvider
      client={engineResource}
      fallback={<div className="empty">starting client core…</div>}
      renderError={(error) => (
        <div className="empty">failed to start: {error.message}</div>
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
