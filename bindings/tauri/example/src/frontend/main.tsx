/**
 * React frontend for the syncular Tauri example — the real integration, no
 * hacks. The whole app is a `<SyncProvider>` over a `createTauriSyncClient()`
 * (the webview-side bridge to the NATIVE syncular instance running in the Tauri
 * host process) plus three hooks:
 *
 * - `useQuery` — generated dependencies, window coverage and row identity;
 *   rows/completeness/revision arrive in one native IPC snapshot.
 * - typed `useMutation` — add / toggle / delete through the outbox.
 * - `useSyncStatus`— the status line (outbox depth + upgrading / schema-floor).
 *
 * Everything below `<SyncProvider>` is host-agnostic: it is the SAME hook code
 * that runs against the browser worker client in apps/demo-react. The only
 * Tauri-specific line is constructing the client — there is zero custom IPC in
 * app land (the bridge owns all of it).
 */
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';
import {
  createSyncClientResource,
  SyncProvider,
  useMutation,
  useQuery,
  useSyncStatus,
} from '@syncular/react';
import { createTauriSyncClient } from '@syncular/tauri';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { schema, todosTable } from './syncular.generated';
import { type ListTodosRow, listTodosQuery } from './syncular.queries';

/** One demo list — the native instance syncs it against the dev server. */
const LIST_ID = 'groceries';

// -- app ----------------------------------------------------------------------

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
        <h1>syncular · tauri</h1>
        <span className="hint">React hooks over the native instance</span>
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
        A native syncular instance runs in the Tauri host process; this webview
        is a thin RPC client of it. Reads use a generated atomic query snapshot
        and writes use typed mutation helpers. The only Tauri-specific line is{' '}
        <code>createTauriSyncClient</code> — the hooks are identical to the
        browser demo.
      </footer>
    </>
  );
}

const clientResource = createSyncClientResource(async () => {
  const client = await createTauriSyncClient({ schema });
  // The native core runs in the Tauri host process behind every webview, so
  // `sharedTransport` keeps a hidden window from tearing down realtime for a
  // sibling window that is still visible.
  return installRealtimeSupervisor(client, {
    connectivity: browserConnectivitySignal(),
    lifecycle: documentLifecycleSignal(),
    sharedTransport: true,
  });
});

function Root() {
  return (
    <SyncProvider
      client={clientResource}
      fallback={<div className="empty">starting native syncular instance…</div>}
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
