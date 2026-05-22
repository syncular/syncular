import type { SyncularV2LifecycleState } from '@syncular/client';
import {
  CheckCircle2,
  Circle,
  Plus,
  Redo2,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type DemoClientHandle,
  type DemoClientName,
  type DemoTask,
  openDemoClient,
  selectTasks,
} from './client/syncular';

type ClientStatus = 'opening' | 'ready' | 'syncing' | 'offline' | 'error';

interface ClientState {
  handle: DemoClientHandle | null;
  tasks: DemoTask[];
  status: ClientStatus;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

const initialClientState: ClientState = {
  handle: null,
  tasks: [],
  status: 'opening',
  error: null,
  canUndo: false,
  canRedo: false,
};

export function App() {
  const [left, setLeft] = useState<ClientState>(initialClientState);
  const [right, setRight] = useState<ClientState>(initialClientState);

  const completedCount = useMemo(
    () => left.tasks.filter((task) => task.completed).length,
    [left.tasks]
  );

  useEffect(() => {
    const cleanups: Array<() => void | Promise<void>> = [];
    let disposed = false;

    const open = async (
      name: DemoClientName,
      setClient: Dispatch<SetStateAction<ClientState>>
    ) => {
      try {
        const handle = await openDemoClient(name);
        if (disposed) {
          await handle.close();
          return;
        }

        const applyLifecycle = () => {
          const nextStatus = statusFromLifecycle(
            handle.database.client.lifecycleState()
          );
          setClient((state) => ({
            ...state,
            status: nextStatus,
            error: nextStatus === 'offline' ? null : state.error,
          }));
        };

        const stopLifecycle = handle.database.client.addEventListener(
          'lifecycleChanged',
          applyLifecycle
        );

        const live = await handle.database.live(selectTasks(handle.database), {
          tables: ['tasks'],
          onChange: (rows) => {
            setClient((state) => ({
              ...state,
              tasks: rows.map(normalizeTask),
              error: null,
            }));
          },
        });

        cleanups.push(() => {
          stopLifecycle();
          live.unsubscribe();
          return handle.close();
        });

        const status = statusFromLifecycle(
          handle.database.client.lifecycleState()
        );
        const commandState = await readCommandState(handle);
        setClient((state) => ({
          ...state,
          handle,
          status,
          error: null,
          ...commandState,
        }));
      } catch (err) {
        setClient((state) => ({
          ...state,
          status: 'error',
          error: errorMessage(err),
        }));
      }
    };

    void (async () => {
      await open('left', setLeft);
      await open('right', setRight);
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) void cleanup();
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Demo status">
        <div>
          <p className="eyebrow">Rust client demo</p>
          <h1>Split view todo sync</h1>
        </div>
        <div
          className="sync-meter"
          role="status"
          aria-label="Synced task summary"
        >
          <span>{left.tasks.length} todos</span>
          <span>{completedCount} done</span>
        </div>
      </section>

      <section className="sync-lane" aria-label="Two browser clients">
        <ClientPane
          label="Client A"
          accent="left"
          state={left}
          setState={setLeft}
        />
        <div className="replication-rail" aria-hidden="true">
          <div className="rail-line" />
          <RefreshCw size={20} />
        </div>
        <ClientPane
          label="Client B"
          accent="right"
          state={right}
          setState={setRight}
        />
      </section>
    </main>
  );
}

function ClientPane({
  label,
  accent,
  state,
  setState,
}: {
  label: string;
  accent: DemoClientName;
  state: ClientState;
  setState: Dispatch<SetStateAction<ClientState>>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = inputRef.current?.value.trim();
    if (!title || !state.handle) return;

    inputRef.current!.value = '';
    await runClientAction(setState, state.handle, async (handle) => {
      await handle.database.mutations.tasks.insert({
        id: crypto.randomUUID(),
        title,
        completed: 0,
        user_id: 'demo-user',
        project_id: null,
      });
    });
  };

  const undo = async () => {
    if (!state.handle || !state.canUndo) return;
    await runClientAction(setState, state.handle, async (handle) => {
      await handle.database.commandHistory.undoLast();
    });
  };

  const redo = async () => {
    if (!state.handle || !state.canRedo) return;
    await runClientAction(setState, state.handle, async (handle) => {
      await handle.database.commandHistory.redoLast();
    });
  };

  return (
    <article className={`client-pane ${accent}`}>
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
            disabled={!state.handle || !state.canUndo}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="history-button"
            type="button"
            aria-label={`${label} redo last command`}
            title="Redo"
            onClick={redo}
            disabled={!state.handle || !state.canRedo}
          >
            <Redo2 size={17} />
          </button>
          <StatusBadge state={state} />
        </div>
      </header>

      <form className="add-row" onSubmit={addTask}>
        <input
          ref={inputRef}
          aria-label={`${label} new todo`}
          placeholder="New todo"
          disabled={!state.handle}
        />
        <button
          type="submit"
          aria-label={`${label} add todo`}
          disabled={!state.handle}
        >
          <Plus size={18} />
        </button>
      </form>

      {state.error ? <p className="error-line">{state.error}</p> : null}
      {state.status === 'offline' ? (
        <p className="offline-line">
          Offline. Local changes will sync when online.
        </p>
      ) : null}

      <div className="task-list" data-testid={`${accent}-tasks`}>
        {state.tasks.length === 0 ? (
          <p className="empty-state">No local rows yet.</p>
        ) : (
          state.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              handle={state.handle}
              setState={setState}
            />
          ))
        )}
      </div>
    </article>
  );
}

function TaskRow({
  task,
  handle,
  setState,
}: {
  task: DemoTask;
  handle: DemoClientHandle | null;
  setState: Dispatch<SetStateAction<ClientState>>;
}) {
  const toggle = async () => {
    if (!handle) return;
    await runClientAction(setState, handle, async (client) => {
      await client.database.mutations.tasks.update(
        task.id,
        {
          title: task.title,
          completed: task.completed ? 0 : 1,
          user_id: task.user_id,
          project_id: task.project_id,
          image: task.image,
        },
        { baseVersion: task.server_version }
      );
    });
  };

  const remove = async () => {
    if (!handle) return;
    await runClientAction(setState, handle, async (client) => {
      await client.database.mutations.tasks.delete(task.id, {
        baseVersion: task.server_version,
      });
    });
  };

  return (
    <div className="task-row">
      <button
        className="icon-button"
        type="button"
        aria-label={task.completed ? 'Mark todo open' : 'Mark todo done'}
        onClick={toggle}
        disabled={!handle}
      >
        {task.completed ? <CheckCircle2 size={19} /> : <Circle size={19} />}
      </button>
      <span className={task.completed ? 'done' : undefined}>{task.title}</span>
      <button
        className="icon-button muted"
        type="button"
        aria-label="Delete todo"
        onClick={remove}
        disabled={!handle}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}

function StatusBadge({ state }: { state: ClientState }) {
  const label =
    state.status === 'opening'
      ? 'Opening'
      : state.status === 'syncing'
        ? 'Syncing'
        : state.status === 'offline'
          ? 'Offline'
          : state.status === 'error'
            ? 'Error'
            : 'Ready';

  return (
    <div className={`status-badge ${state.status}`}>
      <span className="status-dot" />
      <span>{label}</span>
    </div>
  );
}

async function runClientAction(
  setState: Dispatch<SetStateAction<ClientState>>,
  handle: DemoClientHandle,
  action: (handle: DemoClientHandle) => Promise<void>
) {
  setState((state) => ({
    ...state,
    error: null,
  }));
  try {
    await action(handle);
    const status = statusFromLifecycle(handle.database.client.lifecycleState());
    const commandState = await readCommandState(handle);
    setState((state) => ({
      ...state,
      status,
      error: null,
      ...commandState,
    }));
  } catch (err) {
    setState((state) => ({
      ...state,
      status: 'error',
      error: errorMessage(err),
    }));
  }
}

async function readCommandState(
  handle: DemoClientHandle
): Promise<Pick<ClientState, 'canUndo' | 'canRedo'>> {
  const [canUndo, canRedo] = await Promise.all([
    handle.database.commandHistory.canUndo(),
    handle.database.commandHistory.canRedo(),
  ]);
  return { canUndo, canRedo };
}

function normalizeTask(row: Record<string, unknown>): DemoTask {
  return {
    id: String(row.id),
    title: String(row.title),
    completed: Number(row.completed ?? 0),
    user_id: String(row.user_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    image: row.image == null ? null : (row.image as DemoTask['image']),
    server_version: Number(row.server_version ?? 0),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusFromLifecycle(
  lifecycle: SyncularV2LifecycleState
): ClientStatus {
  if (
    lifecycle.phase === 'syncing' ||
    lifecycle.phase === 'recovering' ||
    lifecycle.phase === 'connecting'
  ) {
    return 'syncing';
  }
  if (lifecycle.phase === 'offline') return 'offline';
  if (lifecycle.requiresAction) return 'error';
  return 'ready';
}
