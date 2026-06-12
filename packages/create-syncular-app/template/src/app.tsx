import type { SyncularClientStatus } from '@syncular/client';
import { createSyncularReact } from '@syncular/react';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type AppDb,
  type AppSyncClient,
  appActorId,
  openAppClient,
  type Task,
} from './client/syncular';

// One hook set, bound to this app's database schema.
const {
  SyncProvider,
  useMutations,
  useOutboxStats,
  useSyncQuery,
  useSyncStatus,
} = createSyncularReact<AppDb>();

export function App() {
  const [client, setClient] = useState<AppSyncClient | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let opened: AppSyncClient | null = null;

    void openAppClient()
      .then((nextClient) => {
        if (disposed) {
          void nextClient.destroy().catch(() => undefined);
          return;
        }
        opened = nextClient;
        setClient(nextClient);
      })
      .catch((error) => {
        if (!disposed) setOpenError(errorMessage(error));
      });

    return () => {
      disposed = true;
      if (opened) void opened.destroy().catch(() => undefined);
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <p className="eyebrow">Syncular</p>
        <h1>Local-first tasks</h1>
      </header>

      {openError ? <p className="error-line">{openError}</p> : null}

      <section className="client-pane" aria-label="Tasks">
        {client ? (
          <SyncProvider client={client}>
            <TaskPane />
          </SyncProvider>
        ) : (
          <p className="empty-state">Opening local database…</p>
        )}
      </section>
    </main>
  );
}

function TaskPane() {
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
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = tasks ?? [];
  const doneCount = rows.filter((task) => task.completed).length;
  const queued = (outbox?.pending ?? 0) + (outbox?.sending ?? 0);

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
        user_id: appActorId,
        created_at: Date.now(),
      })
      .catch(() => undefined);
  };

  return (
    <>
      <div className="pane-header">
        <h2>Tasks</h2>
        <StatusBadge state={paneStatus(status)} />
      </div>

      <form className="add-row" onSubmit={addTask}>
        <input ref={inputRef} aria-label="New task" placeholder="New task" />
        <button type="submit" aria-label="Add task">
          +
        </button>
      </form>

      {mutations.$error ? (
        <p className="error-line">{mutations.$error.message}</p>
      ) : null}
      {queryError ? <p className="error-line">{queryError.message}</p> : null}
      {queued > 0 ? (
        <p className="offline-line">
          {queued} queued change{queued === 1 ? '' : 's'} waiting to sync.
        </p>
      ) : null}

      <div className="task-list">
        {rows.length === 0 ? (
          <p className="empty-state">
            No tasks yet. Add one above — it is written to the local database
            first and synced in the background.
          </p>
        ) : (
          rows.map((task) => (
            <TaskItem key={task.id} task={task} mutations={mutations} />
          ))
        )}
      </div>

      <p className="pane-footnote">
        {rows.length} task{rows.length === 1 ? '' : 's'} · {doneCount} done
      </p>
    </>
  );
}

function TaskItem({
  task,
  mutations,
}: {
  task: Task;
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
        aria-label={task.completed ? 'Mark task open' : 'Mark task done'}
        onClick={toggle}
      >
        {task.completed ? '✓' : '○'}
      </button>
      <span className={task.completed ? 'done' : undefined}>{task.title}</span>
      <button
        className="icon-button muted"
        type="button"
        aria-label="Delete task"
        onClick={remove}
      >
        ×
      </button>
    </div>
  );
}

type PaneStatus = 'syncing' | 'offline' | 'attention' | 'error' | 'ready';

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

function paneStatus(status: SyncularClientStatus): PaneStatus {
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
