/**
 * @syncular/demo - Dual-Client Sync tab
 *
 * Two independent clients (wa-sqlite OPFS + PGlite IndexedDB) syncing to
 * the same server in real-time over WebSocket transport.
 */

import {
  ClientTableRegistry,
  createIncrementingVersionPlugin,
} from '@syncular/client';
import { createWebSocketTransport } from '@syncular/transport-ws';
import {
  ClientPanel,
  ConflictPanel,
  DemoHeader,
  InfoPanel,
  SyncControls,
  SyncStatusBadge,
  TaskItem,
  TaskList,
  TopologyPanel,
  TopologySvgSplit,
} from '@syncular/ui/demo';
import { StatusDot } from '@syncular/ui/navigation';
import type { Kysely } from 'kysely';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPgliteClient } from '../client/db-pglite';
import { createSqliteClient } from '../client/db-sqlite';
import { migrateClientDb } from '../client/migrate';
import {
  SyncProvider,
  useConflicts,
  useMutations,
  useSyncConnection,
  useSyncEngine,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import { catalogItemsClientHandler } from '../client/shapes/catalog-items';
import { sharedTasksClientHandler } from '../client/shapes/shared-tasks';
import { tasksClientHandler } from '../client/shapes/tasks';
import type { ClientDb } from '../client/types.generated';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = 'demo-user';

// ---------------------------------------------------------------------------
// Inner: TasksContent (must be rendered inside SyncProvider)
// ---------------------------------------------------------------------------

function TasksContent({ color }: { color: 'flow' | 'relay' }) {
  const { data: tasks } = useSyncQuery((ctx) =>
    ctx.selectFrom('tasks').selectAll().orderBy('title', 'asc')
  );

  const mutations = useMutations({ sync: 'background' });

  const status = useSyncStatus();
  const engine = useSyncEngine();
  const connection = useSyncConnection();
  const { conflicts } = useConflicts();

  const [newTitle, setNewTitle] = useState('');

  const badgeStatus = useMemo(() => {
    if (!connection.isConnected && !status.isSyncing) return 'offline' as const;
    if (status.isSyncing) return 'syncing' as const;
    if (status.error) return 'error' as const;
    return 'synced' as const;
  }, [connection.isConnected, status.isSyncing, status.error]);

  const handleAdd = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    await mutations.tasks.insert({
      title,
      completed: 0,
      user_id: USER_ID,
    });
    setNewTitle('');
  }, [mutations, newTitle]);

  const handleToggle = useCallback(
    async (
      id: string,
      currentCompleted: number | undefined,
      baseVersion: number | undefined
    ) => {
      await mutations.tasks.update(
        id,
        { completed: currentCompleted ? 0 : 1 },
        { baseVersion: baseVersion ?? 0 }
      );
    },
    [mutations]
  );

  const handleDelete = useCallback(
    async (id: string, baseVersion: number | undefined) => {
      await mutations.tasks.delete(id, {
        baseVersion: baseVersion ?? 0,
      });
    },
    [mutations]
  );

  const handleToggleOffline = useCallback(() => {
    if (connection.isConnected) {
      engine.disconnect();
    } else {
      engine.reconnect();
    }
  }, [connection.isConnected, engine]);

  const handleReset = useCallback(() => {
    engine.reconnect();
  }, [engine]);

  return (
    <ClientPanel
      label={color === 'flow' ? 'Client A · wa-sqlite' : 'Client B · PGlite'}
      color={color}
      status={<SyncStatusBadge status={badgeStatus} />}
      footer={
        <SyncControls
          isOffline={!connection.isConnected}
          onToggleOffline={handleToggleOffline}
          onReset={handleReset}
        />
      }
    >
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Add a task..."
          className="flex-1 bg-transparent border border-border rounded-md px-3 py-1.5 text-xs text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-neutral-600"
        />
      </div>

      <TaskList emptyMessage="No tasks yet. Add one above.">
        {tasks?.map((task) => (
          <TaskItem
            key={task.id}
            checked={!!task.completed}
            text={task.title}
            meta={`v${task.server_version ?? 0}`}
            onToggle={() =>
              handleToggle(task.id, task.completed, task.server_version)
            }
            onDelete={() => handleDelete(task.id, task.server_version)}
          />
        ))}
      </TaskList>

      <ConflictPanel visible={conflicts.length > 0}>
        {conflicts.map((c) => (
          <div
            key={c.id}
            className="text-[11px] text-neutral-500 font-mono px-2 py-1 rounded bg-white/[0.02] border border-border"
          >
            {c.table}:{c.rowId} &mdash; {c.message}
          </div>
        ))}
      </ConflictPanel>
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// Inner: SyncClientPanel (DB init + provider wiring)
// ---------------------------------------------------------------------------

function SyncClientPanel({
  createDb,
  clientId,
  color,
}: {
  createDb: () => Kysely<ClientDb> | Promise<Kysely<ClientDb>>;
  clientId: string;
  color: 'flow' | 'relay';
}) {
  const [db, setDb] = useState<Kysely<ClientDb> | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    async function init() {
      const database = await createDb();
      await migrateClientDb(database);
      setDb(database);
    }
    init();
  }, [createDb]);

  const transport = useMemo(
    () =>
      createWebSocketTransport({
        baseUrl: '/api',
        wsUrl: '/api/sync/realtime',
        getHeaders: () => ({ 'x-user-id': USER_ID }),
        getRealtimeParams: () => ({ userId: USER_ID }),
      }),
    []
  );

  const shapes = useMemo(() => {
    const registry = new ClientTableRegistry<ClientDb>();
    registry.register(tasksClientHandler);
    registry.register(sharedTasksClientHandler);
    registry.register(catalogItemsClientHandler);
    return registry;
  }, []);

  const plugins = useMemo(() => [createIncrementingVersionPlugin()], []);

  const subscriptions = useMemo(
    () => [
      { id: 'my-tasks', shape: 'tasks' as const, scopes: { user_id: USER_ID } },
    ],
    []
  );

  if (!db) {
    return (
      <ClientPanel
        label={color === 'flow' ? 'Client A · wa-sqlite' : 'Client B · PGlite'}
        color={color}
      >
        <div className="flex items-center justify-center h-[120px]">
          <span className="text-xs text-neutral-600 font-mono">
            Initializing database...
          </span>
        </div>
      </ClientPanel>
    );
  }

  return (
    <SyncProvider
      db={db}
      transport={transport}
      shapes={shapes}
      clientId={clientId}
      actorId={USER_ID}
      subscriptions={subscriptions}
      plugins={plugins}
      realtimeEnabled
    >
      <TasksContent color={color} />
    </SyncProvider>
  );
}

// ---------------------------------------------------------------------------
// Stable factory callbacks
// ---------------------------------------------------------------------------

const createSqliteDb = () => createSqliteClient('demo-tasks-v5.sqlite');
const createPgliteDb = () => createPgliteClient('idb://sync-demo-pglite-v5');

// ---------------------------------------------------------------------------
// Public: SplitScreenTab
// ---------------------------------------------------------------------------

export function SplitScreenTab() {
  const badges = useMemo<ReactNode>(
    () => (
      <>
        <div className="flex items-center gap-1.5">
          <StatusDot color="flow" size="sm" />
          <span className="font-mono text-[10px] text-neutral-500">
            wa-sqlite (OPFS)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusDot color="relay" size="sm" />
          <span className="font-mono text-[10px] text-neutral-500">
            PGlite (IndexedDB)
          </span>
        </div>
      </>
    ),
    []
  );

  const stats = useMemo<ReactNode>(
    () => (
      <>
        <span className="font-mono text-[10px] text-neutral-600">
          Latency: <span className="text-neutral-400">&lt;50ms</span>
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          Commits: <span className="text-neutral-400">0</span>
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          Conflicts: <span className="text-neutral-400">0</span>
        </span>
      </>
    ),
    []
  );

  return (
    <>
      <DemoHeader
        title="Dual-Client Sync"
        subtitle="Two independent SQLite clients syncing to the same server in real-time"
        right={badges}
      />

      <TopologyPanel label="Sync Topology" headerRight={stats}>
        <TopologySvgSplit />
      </TopologyPanel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <SyncClientPanel
          createDb={createSqliteDb}
          clientId="client-sqlite-demo"
          color="flow"
        />
        <SyncClientPanel
          createDb={createPgliteDb}
          clientId="client-pglite-demo"
          color="relay"
        />
      </div>

      <InfoPanel
        className="mt-4"
        icon={
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#3b82f6"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        }
        title="How it works"
        description={
          <>
            Both clients maintain their own local database and outbox. Mutations
            are written locally first, then pushed to the server via the
            WebSocket transport. The server resolves ordering through a commit
            log, and each client pulls the merged state back down. Conflicts are
            detected using optimistic version checks on{' '}
            <code className="text-flow">server_version</code>.
          </>
        }
      />
    </>
  );
}
