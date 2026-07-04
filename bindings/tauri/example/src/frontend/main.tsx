/**
 * React frontend for the syncular Tauri example — the real integration, no
 * hacks. The whole app is a `<SyncProvider>` over a `createTauriSyncClient()`
 * (the webview-side bridge to the NATIVE syncular instance running in the Tauri
 * host process) plus three hooks:
 *
 * - `useSyncQuery` — the live todo list; re-runs exactly when `todos`
 *   invalidates (one IPC round trip per run — see the README's pagination note).
 * - `useMutation`  — add / toggle / delete; writes go through the outbox.
 * - `useSyncStatus`— the status line (outbox depth + upgrading / schema-floor).
 *
 * Everything below `<SyncProvider>` is host-agnostic: it is the SAME hook code
 * that runs against the browser worker client in apps/demo-react. The only
 * Tauri-specific line is constructing the client — there is zero custom IPC in
 * app land (the bridge owns all of it).
 */
import {
  SyncProvider,
  useMutation,
  useSyncQuery,
  useSyncStatus,
} from '@syncular-v2/react';
import {
  createTauriSyncClient,
  type TauriSyncClient,
} from '@syncular-v2/tauri';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { schema, type TodosRow } from './syncular.generated';

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
  const { mutate, isPending } = useMutation();

  // Live local read: one IPC round trip, re-run only when `todos` invalidates.
  const { rows, isLoading } = useSyncQuery<TodosRow>(
    'SELECT id, list_id, title, done, position, updated_at_ms, attachment' +
      ' FROM todos WHERE list_id = ? ORDER BY position, id',
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
          list_id: LIST_ID,
          title,
          done: false,
          position,
          updated_at_ms: Date.now(),
          attachment: null,
        },
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
        },
      },
    ]);
  };

  const remove = (id: string) => {
    void mutate([{ table: 'todos', op: 'delete', rowId: id }]);
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
        <button type="submit" disabled={isPending}>
          add
        </button>
      </form>

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
        A native syncular instance runs in the Tauri host process; this webview
        is a thin RPC client of it. Reads are <code>useSyncQuery</code> (live,
        table-scoped invalidation), writes are <code>useMutation</code> (the
        outbox). The only Tauri-specific line is{' '}
        <code>createTauriSyncClient</code> — the hooks are identical to the
        browser demo.
      </footer>
    </>
  );
}

function Root() {
  const [client, setClient] = useState<TauriSyncClient | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live: TauriSyncClient | undefined;
    void createTauriSyncClient({ clientId: 'example-device', schema })
      .then((c) => {
        live = c;
        // Ride the socket for realtime; HTTP sync still works without it.
        void c.connectRealtime().catch(() => {});
        // Bring the list into the window so it bootstraps + streams.
        void c.subscribe({
          id: 'todos',
          table: 'todos',
          scopes: { list_id: [LIST_ID] },
        });
        setClient(c);
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      void live?.close();
    };
  }, []);

  if (error !== undefined) {
    return <div className="empty">failed to start: {error}</div>;
  }
  if (client === undefined) {
    return <div className="empty">starting native syncular instance…</div>;
  }
  return (
    <SyncProvider client={client}>
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
