import { useEffect, useState } from 'react';
import type { TasksTable } from '../shared/db';
import {
  addTask,
  initializeDemoSync,
  listTasks,
  removeTask,
  subscribeToTaskChanges,
  toggleTask,
} from './syncular';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TasksTable[]>([]);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    async function refresh() {
      const rows = await listTasks();
      if (!disposed) {
        setTasks(rows);
      }
    }

    async function boot() {
      try {
        await initializeDemoSync();
        await refresh();
        unsubscribe = await subscribeToTaskChanges(() => {
          void refresh();
        });
      } catch (nextError) {
        if (!disposed) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void boot();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const onAdd = async () => {
    const value = title.trim();
    if (value.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      await addTask(value);
      setTitle('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (task: TasksTable) => {
    try {
      await toggleTask(task);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const onRemove = async (taskId: string) => {
    try {
      await removeTask(taskId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <main className="page">
      <header>
        <h1>Syncular Demo</h1>
        <p>Hono + Vite React + WA-SQLite</p>
      </header>

      <section className="card">
        <h2>Tasks</h2>

        <div className="input-row">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void onAdd();
              }
            }}
            placeholder="What should be synced?"
          />
          <button type="button" onClick={() => void onAdd()} disabled={saving}>
            {saving ? 'Saving...' : 'Add'}
          </button>
        </div>

        {loading ? <p>Connecting local DB + sync engine...</p> : null}
        {error ? <p className="error">{error}</p> : null}

        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <label>
                <input
                  type="checkbox"
                  checked={task.completed === 1}
                  onChange={() => void onToggle(task)}
                />
                <span>{task.title}</span>
              </label>
              <button type="button" onClick={() => void onRemove(task.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
