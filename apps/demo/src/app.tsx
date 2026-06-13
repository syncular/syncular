import type {
  SyncularClientStatus,
  SyncularCommandHistory,
} from '@syncular/client';
import { createSyncularReact } from '@syncular/react';
import {
  CheckCircle2,
  Circle,
  Plus,
  Redo2,
  RefreshCw,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DemoClientHandle,
  type DemoDb,
  type DemoPaneName,
  type DemoTask,
  demoActorId,
  openDemoClient,
} from './client/syncular';

// One hook set, bound to the demo's database schema. Each pane gets its own
// <SyncProvider>, so the same hooks read from that pane's local database.
const {
  SyncProvider,
  useMutations,
  useOutboxStats,
  useRowsChanged,
  useSyncConnection,
  useSyncQuery,
  useSyncStatus,
} = createSyncularReact<DemoDb>();

export function App() {
  const [handles, setHandles] = useState<
    Partial<Record<DemoPaneName, DemoClientHandle>>
  >({});
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const opened: DemoClientHandle[] = [];

    void (async () => {
      for (const name of ['left', 'right'] as const) {
        try {
          const handle = await openDemoClient(name);
          if (disposed) {
            await handle.client.close();
            return;
          }
          opened.push(handle);
          setHandles((previous) => ({ ...previous, [name]: handle }));
        } catch (error) {
          if (!disposed) setOpenError(errorMessage(error));
          return;
        }
      }
    })();

    return () => {
      disposed = true;
      for (const handle of opened) {
        void handle.client.close().catch(() => undefined);
      }
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Demo header">
        <div>
          <p className="eyebrow">Syncular demo</p>
          <h1>Split view todo sync</h1>
        </div>
        <div className="sync-meter" role="note" aria-label="Demo setup">
          <span>One user</span>
          <span>Two devices</span>
        </div>
      </section>

      {openError ? <p className="error-line">{openError}</p> : null}

      <section className="sync-lane" aria-label="Two browser clients">
        <ClientPane label="Client A" accent="left" handle={handles.left} />
        <div className="replication-rail" aria-hidden="true">
          <div className="rail-line" />
          <RefreshCw size={20} />
        </div>
        <ClientPane label="Client B" accent="right" handle={handles.right} />
      </section>
    </main>
  );
}

function ClientPane({
  label,
  accent,
  handle,
}: {
  label: string;
  accent: DemoPaneName;
  handle: DemoClientHandle | undefined;
}) {
  return (
    <article className={`client-pane ${accent}`}>
      {handle ? (
        <SyncProvider client={handle.client}>
          <PaneContent label={label} accent={accent} history={handle.history} />
        </SyncProvider>
      ) : (
        <p className="empty-state">Opening local database…</p>
      )}
    </article>
  );
}

function PaneContent({
  label,
  accent,
  history,
}: {
  label: string;
  accent: DemoPaneName;
  history: SyncularCommandHistory;
}) {
  // Live query: re-renders whenever synced rows change, locally or remotely.
  const { data: tasks, error: queryError } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('tasks')
        .selectAll()
        .orderBy('completed', 'asc')
        .orderBy('created_at', 'desc'),
    { tables: ['tasks'] }
  );
  const mutations = useMutations();
  const outbox = useOutboxStats();
  const status = useSyncStatus();
  const { reconnect, disconnect } = useSyncConnection();
  const { canUndo, canRedo, undo, redo } = useCommandHistory(history);
  const [offline, setOffline] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = tasks ?? [];
  const doneCount = rows.filter((task) => task.completed).length;
  const queued = (outbox?.pending ?? 0) + (outbox?.sending ?? 0);
  const paneState = paneStatus(status, offline);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = inputRef.current?.value.trim();
    if (!title) return;
    inputRef.current!.value = '';
    void mutations.tasks
      .insert({
        id: crypto.randomUUID(),
        title,
        completed: 0,
        user_id: demoActorId,
        created_at: Date.now(),
      })
      .catch(() => undefined);
  };

  const toggleOffline = () => {
    if (offline) {
      setOffline(false);
      void reconnect().catch(() => undefined);
    } else {
      setOffline(true);
      void disconnect().catch(() => undefined);
    }
  };

  return (
    <>
      <header className="client-header">
        <div>
          <p className="pane-kicker">{label}</p>
          <h2>{accent === 'left' ? 'Planner' : 'Reviewer'}</h2>
        </div>
        <div className="pane-actions">
          <button
            className="history-button"
            type="button"
            aria-label={`${label} undo last command`}
            title="Undo"
            onClick={undo}
            disabled={!canUndo}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="history-button"
            type="button"
            aria-label={`${label} redo last command`}
            title="Redo"
            onClick={redo}
            disabled={!canRedo}
          >
            <Redo2 size={17} />
          </button>
          <button
            className="history-button"
            type="button"
            aria-label={
              offline ? `${label} go back online` : `${label} go offline`
            }
            title={offline ? 'Go online' : 'Simulate offline'}
            onClick={toggleOffline}
          >
            {offline ? <WifiOff size={17} /> : <Wifi size={17} />}
          </button>
          <StatusBadge state={paneState} />
        </div>
      </header>

      <form className="add-row" onSubmit={addTask}>
        <input
          ref={inputRef}
          aria-label={`${label} new todo`}
          placeholder="New todo"
        />
        <button type="submit" aria-label={`${label} add todo`}>
          <Plus size={18} />
        </button>
      </form>

      {mutations.$error ? (
        <p className="error-line">{mutations.$error.message}</p>
      ) : null}
      {queryError ? <p className="error-line">{queryError.message}</p> : null}
      {offline ? (
        <p className="offline-line">
          Offline.{' '}
          {queued > 0
            ? `${queued} queued change${queued === 1 ? '' : 's'} will`
            : 'Local changes'}{' '}
          sync when back online.
        </p>
      ) : null}
      {paneState === 'attention' ? (
        <p className="attention-line">Local sync state needs review.</p>
      ) : null}

      <div className="task-list" data-testid={`${accent}-tasks`}>
        {rows.length === 0 ? (
          <p className="empty-state">No local rows yet.</p>
        ) : (
          rows.map((task) => (
            <TaskItem key={task.id} task={task} mutations={mutations} />
          ))
        )}
      </div>

      <p className="pane-footnote">
        {rows.length} todo{rows.length === 1 ? '' : 's'} · {doneCount} done
      </p>
    </>
  );
}

function TaskItem({
  task,
  mutations,
}: {
  task: DemoTask;
  mutations: ReturnType<typeof useMutations>;
}) {
  const toggle = () => {
    void mutations.tasks
      .update(
        task.id,
        { completed: task.completed ? 0 : 1 },
        { baseVersion: task.server_version }
      )
      .catch(() => undefined);
  };

  const remove = () => {
    void mutations.tasks
      .delete(task.id, { baseVersion: task.server_version })
      .catch(() => undefined);
  };

  return (
    <div className="task-row">
      <button
        className="icon-button"
        type="button"
        aria-label={task.completed ? 'Mark todo open' : 'Mark todo done'}
        onClick={toggle}
      >
        {task.completed ? <CheckCircle2 size={19} /> : <Circle size={19} />}
      </button>
      <span className={task.completed ? 'done' : undefined}>{task.title}</span>
      <button
        className="icon-button muted"
        type="button"
        aria-label="Delete todo"
        onClick={remove}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}

function StatusBadge({ state }: { state: PaneStatus }) {
  const label =
    state === 'syncing'
      ? 'Syncing'
      : state === 'offline'
        ? 'Offline'
        : state === 'attention'
          ? 'Review'
          : state === 'error'
            ? 'Error'
            : 'Ready';

  return (
    <div className={`status-badge ${state}`}>
      <span className="status-dot" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Undo/redo state for one pane, kept fresh by re-reading the command history
 * whenever this pane's rows change (local mutations, undo, redo and remote
 * changes all surface as row changes).
 */
function useCommandHistory(history: SyncularCommandHistory) {
  const [state, setState] = useState({ canUndo: false, canRedo: false });

  const refresh = useCallback(() => {
    void Promise.all([history.canUndo(), history.canRedo()]).then(
      ([canUndo, canRedo]) => setState({ canUndo, canRedo })
    );
  }, [history]);

  useEffect(() => refresh(), [refresh]);
  useRowsChanged(refresh, { tables: ['tasks'] });

  const undo = useCallback(() => {
    void history
      .undoLast()
      .catch(() => undefined)
      .then(refresh);
  }, [history, refresh]);

  const redo = useCallback(() => {
    void history
      .redoLast()
      .catch(() => undefined)
      .then(refresh);
  }, [history, refresh]);

  return { ...state, undo, redo };
}

type PaneStatus = 'syncing' | 'offline' | 'attention' | 'error' | 'ready';

function paneStatus(
  status: SyncularClientStatus,
  offline: boolean
): PaneStatus {
  if (offline) return 'offline';
  const phase = status.lifecycle.phase;
  if (phase === 'syncing' || phase === 'recovering' || phase === 'connecting') {
    return 'syncing';
  }
  if (phase === 'offline') return 'offline';
  if (phase === 'authRequired') return 'error';
  if (status.requiresAction || phase === 'degraded') return 'attention';
  return 'ready';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
