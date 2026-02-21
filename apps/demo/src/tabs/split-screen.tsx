/**
 * @syncular/demo - Dual-Client Sync tab
 *
 * Two independent clients (wa-sqlite OPFS + PGlite IndexedDB) syncing to
 * the same server in real-time over a service-worker wake-up channel.
 */

import {
  type ClientHandlerCollection,
  createIncrementingVersionPlugin,
  type SyncError,
  SyncTransportError,
} from '@syncular/client';
import {
  captureBrowserSentryMessage,
  logBrowserSentryMessage,
} from '@syncular/observability-sentry';
import {
  ClientPanel,
  ConflictPanel,
  DemoHeader,
  InfoPanel,
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
  useState,
} from 'react';
import {
  createPgliteClient,
  getPgliteDataDirState,
  PgliteClientInitializationError,
  rotatePgliteDataDir,
} from '../client/db-pglite';
import { createSqliteClient } from '../client/db-sqlite';
import { DEMO_CLIENT_STORES } from '../client/demo-data-reset';
import {
  createDemoPollingTransport,
  DEMO_POLL_INTERVAL_MS,
} from '../client/demo-transport';
import { catalogItemsClientHandler } from '../client/handlers/catalog-items';
import { sharedTasksClientHandler } from '../client/handlers/shared-tasks';
import { tasksClientHandler } from '../client/handlers/tasks';
import { migrateClientDbWithTimeout } from '../client/migrate';
import {
  SyncProvider,
  useCachedAsyncValue,
  useConflicts,
  useMutations,
  useResolveConflict,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import type { ClientDb } from '../client/types.generated';
import {
  DemoClientSyncControls,
  useDemoClientSyncControls,
} from '../components/demo-client-sync-controls';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID_SEED_STORAGE_KEY = 'sync-demo:split-screen:client-seed-v1';

function createClientIdSeed(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getSplitScreenClientIdSeed(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_SEED_STORAGE_KEY);
    if (existing) return existing;

    const created = createClientIdSeed();
    window.localStorage.setItem(CLIENT_ID_SEED_STORAGE_KEY, created);
    return created;
  } catch {
    return createClientIdSeed();
  }
}

function shouldShowBackendResetFromSyncError(error: SyncError | null): boolean {
  if (!error) return false;
  if (!error.message.toLowerCase().includes('push failed')) return false;
  if (error.cause instanceof SyncTransportError) {
    const status = error.cause.status;
    return typeof status === 'number' && status >= 500 && status < 600;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inner: TasksContent (must be rendered inside SyncProvider)
// ---------------------------------------------------------------------------

function TasksContent({
  actorId,
  color,
  clientStoreKey,
}: {
  actorId: string;
  color: 'flow' | 'relay';
  clientStoreKey: string;
}) {
  const { data: tasks, refetch } = useSyncQuery((ctx) =>
    ctx.selectFrom('tasks').selectAll().orderBy('title', 'asc')
  );

  const mutations = useMutations({ sync: 'background' });
  const status = useSyncStatus();
  const { conflicts, refresh: refreshConflicts } = useConflicts();
  const {
    resolve: resolveConflict,
    isPending: isResolvingConflict,
    error: resolveConflictError,
  } = useResolveConflict();

  const [newTitle, setNewTitle] = useState('');

  const controls = useDemoClientSyncControls({
    clientKey: clientStoreKey,
    onAfterReset: async () => {
      await refetch();
      await refreshConflicts();
    },
  });

  const backendResetRequired = useMemo(() => {
    if (shouldShowBackendResetFromSyncError(status.error)) {
      return true;
    }

    return conflicts.some(
      (conflict) =>
        conflict.resultStatus === 'error' &&
        (conflict.code === 'ROW_MISSING' ||
          conflict.message === 'ROW_NOT_FOUND_FOR_BASE_VERSION')
    );
  }, [conflicts, status.error]);

  const badgeStatus = useMemo(() => {
    if (controls.isOffline && !status.isSyncing) return 'offline' as const;
    if (status.isSyncing) return 'syncing' as const;
    if (status.error) return 'error' as const;
    return 'synced' as const;
  }, [controls.isOffline, status.error, status.isSyncing]);

  const handleAdd = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    await mutations.tasks.insert({
      title,
      completed: 0,
      user_id: actorId,
    });
    setNewTitle('');
  }, [actorId, mutations, newTitle]);

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

  const handleResolveConflict = useCallback(
    async (conflictId: string, resolution: 'accept' | 'reject') => {
      try {
        await resolveConflict(conflictId, resolution);
      } catch {
        // useResolveConflict exposes error state for UI feedback
      }
    },
    [resolveConflict]
  );

  return (
    <ClientPanel
      label={color === 'flow' ? 'Client A · wa-sqlite' : 'Client B · PGlite'}
      color={color}
      status={<SyncStatusBadge status={badgeStatus} />}
      footer={<DemoClientSyncControls controls={controls} />}
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

      {backendResetRequired ? (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-2.5">
          <div className="text-[11px] text-amber-100">
            Database backend is out of sync, probably due to a scheduled reset
            of demo data. Click below to reset local data and continue.
          </div>
          <button
            type="button"
            onClick={() => void controls.resetLocalData()}
            disabled={controls.isResetting}
            className="mt-2 rounded border border-amber-500/40 bg-amber-500/20 px-2 py-1 text-[10px] font-mono text-amber-100 hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {controls.isResetting ? 'Resetting local data...' : 'Reset my data'}
          </button>
          {controls.resetError ? (
            <div className="mt-2 text-[10px] text-red-300">
              Reset failed: {controls.resetError}
            </div>
          ) : null}
        </div>
      ) : null}

      <ConflictPanel visible={conflicts.length > 0}>
        <div className="text-[11px] text-neutral-300 font-mono px-2 py-1 rounded bg-white/[0.02] border border-border">
          Conflict of data detected. Click to use MY data or THEIRS.
        </div>
        {conflicts.map((c) => (
          <div
            key={c.id}
            className="text-[11px] text-neutral-500 font-mono px-2 py-2 rounded bg-white/[0.02] border border-border"
          >
            <div>
              {c.table}:{c.rowId} - {c.message}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void handleResolveConflict(c.id, 'reject')}
                disabled={isResolvingConflict}
                className="rounded border border-flow/50 px-2 py-1 text-[10px] text-flow hover:bg-flow/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Use MY data
              </button>
              <button
                type="button"
                onClick={() => void handleResolveConflict(c.id, 'accept')}
                disabled={isResolvingConflict}
                className="rounded border border-neutral-500/60 px-2 py-1 text-[10px] text-neutral-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Use THEIRS
              </button>
            </div>
          </div>
        ))}
        {resolveConflictError ? (
          <div className="text-[10px] text-red-300">
            Conflict resolution failed: {resolveConflictError.message}
          </div>
        ) : null}
      </ConflictPanel>
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// Inner: SyncClientPanel (DB init + provider wiring)
// ---------------------------------------------------------------------------

function SyncClientPanel({
  actorId,
  createDb,
  clientId,
  clientStoreKey,
  color,
  onRecoverFromInitError,
}: {
  actorId: string;
  createDb: () => Kysely<ClientDb> | Promise<Kysely<ClientDb>>;
  clientId: string;
  clientStoreKey: string;
  color: 'flow' | 'relay';
  onRecoverFromInitError?: () => Promise<void>;
}) {
  const [initAttempt, setInitAttempt] = useState(0);
  const [isRecoveringInitError, setIsRecoveringInitError] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const initKey = `${clientStoreKey}:attempt:${initAttempt}`;
  const [db, dbError] = useCachedAsyncValue(
    async () => {
      const database = await createDb();
      await migrateClientDbWithTimeout(database, {
        clientStoreKey,
      });
      return database;
    },
    {
      key: initKey,
      deps: [createDb, clientStoreKey],
    }
  );

  const initError = recoveryError ?? dbError?.message ?? null;

  useEffect(() => {
    if (!dbError) return;
    if (dbError instanceof PgliteClientInitializationError) {
      captureBrowserSentryMessage(
        'syncular.demo.client.db_init_failed.pglite',
        {
          level: 'error',
          tags: {
            base_data_dir: dbError.baseDataDir,
            active_data_dir: dbError.activeDataDir,
            client_store_key: clientStoreKey,
          },
        }
      );
      return;
    }

    captureBrowserSentryMessage('syncular.demo.client.db_init_failed', {
      level: 'error',
      tags: {
        client_store_key: clientStoreKey,
      },
    });
  }, [clientStoreKey, dbError]);

  const handleRetryInit = useCallback(() => {
    setRecoveryError(null);
    setInitAttempt((current) => current + 1);
  }, []);

  const handleRecoverFromInitError = useCallback(async () => {
    if (!onRecoverFromInitError || isRecoveringInitError) return;

    setIsRecoveringInitError(true);
    try {
      await onRecoverFromInitError();
      setRecoveryError(null);
      setInitAttempt((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecoveryError(message);
      captureBrowserSentryMessage(
        'syncular.demo.client.db_init_recovery_failed',
        {
          level: 'error',
          tags: {
            client_store_key: clientStoreKey,
          },
        }
      );
    } finally {
      setIsRecoveringInitError(false);
    }
  }, [clientStoreKey, isRecoveringInitError, onRecoverFromInitError]);

  const transport = useMemo(
    () => createDemoPollingTransport(actorId),
    [actorId]
  );

  const handlers = useMemo(() => {
    const configured: ClientHandlerCollection<ClientDb> = [
      tasksClientHandler,
      sharedTasksClientHandler,
      catalogItemsClientHandler,
    ];
    return configured;
  }, []);

  const plugins = useMemo(() => [createIncrementingVersionPlugin()], []);

  const subscriptions = useMemo(
    () => [
      { id: 'my-tasks', table: 'tasks' as const, scopes: { user_id: actorId } },
    ],
    [actorId]
  );
  const sync = useMemo(
    () => ({
      handlers,
      subscriptions: () => subscriptions,
    }),
    [handlers, subscriptions]
  );

  if (initError) {
    return (
      <ClientPanel
        label={color === 'flow' ? 'Client A · wa-sqlite' : 'Client B · PGlite'}
        color={color}
      >
        <div className="px-3 py-3">
          <div className="text-xs text-red-300 font-mono break-all">
            Database initialization failed: {initError}
          </div>
          <div className="mt-2 text-[10px] text-neutral-400 font-mono">
            Local data was not deleted automatically.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRetryInit}
              className="rounded border border-neutral-500/50 px-2 py-1 text-[10px] font-mono text-neutral-200 hover:bg-white/10"
            >
              Retry initialization
            </button>
            {onRecoverFromInitError ? (
              <button
                type="button"
                onClick={() => void handleRecoverFromInitError()}
                disabled={isRecoveringInitError}
                className="rounded border border-amber-500/50 px-2 py-1 text-[10px] font-mono text-amber-100 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRecoveringInitError
                  ? 'Preparing fresh local store...'
                  : 'Use fresh local store (keep old data)'}
              </button>
            ) : null}
          </div>
        </div>
      </ClientPanel>
    );
  }

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
      sync={sync}
      clientId={clientId}
      identity={{ actorId }}
      plugins={plugins}
      realtimeEnabled={true}
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
    >
      <TasksContent
        actorId={actorId}
        color={color}
        clientStoreKey={clientStoreKey}
      />
    </SyncProvider>
  );
}

// ---------------------------------------------------------------------------
// Stable factory callbacks
// ---------------------------------------------------------------------------

const createSqliteDb = () =>
  createSqliteClient(DEMO_CLIENT_STORES.splitSqlite.location);
const createPgliteDb = () =>
  createPgliteClient(DEMO_CLIENT_STORES.splitPglite.location);

// ---------------------------------------------------------------------------
// Public: SplitScreenTab
// ---------------------------------------------------------------------------

export function SplitScreenTab() {
  const clientIdSeed = useMemo(() => getSplitScreenClientIdSeed(), []);
  const actorId = useMemo(
    () => `demo-user::split-${clientIdSeed}`,
    [clientIdSeed]
  );
  const sqliteClientId = useMemo(
    () => `client-sqlite-demo-${clientIdSeed}`,
    [clientIdSeed]
  );
  const pgliteClientId = useMemo(
    () => `client-pglite-demo-${clientIdSeed}`,
    [clientIdSeed]
  );
  const recoverPgliteFromInitError = useCallback(async () => {
    const before = getPgliteDataDirState(
      DEMO_CLIENT_STORES.splitPglite.location
    );
    const after = rotatePgliteDataDir(DEMO_CLIENT_STORES.splitPglite.location);
    logBrowserSentryMessage('syncular.demo.client.db_init_recovery_rotated', {
      level: 'warn',
      attributes: {
        client_store_key: DEMO_CLIENT_STORES.splitPglite.key,
        previous_data_dir: before.activeDataDir,
        new_data_dir: after.activeDataDir,
      },
    });
  }, []);

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

  return (
    <>
      <DemoHeader
        title="Dual-Client Sync"
        subtitle="Two independent SQLite clients syncing to the same server in real-time"
        right={badges}
      />

      <TopologyPanel label="Sync Topology">
        <TopologySvgSplit />
      </TopologyPanel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <SyncClientPanel
          actorId={actorId}
          createDb={createSqliteDb}
          clientId={sqliteClientId}
          clientStoreKey={DEMO_CLIENT_STORES.splitSqlite.key}
          color="flow"
        />
        <SyncClientPanel
          actorId={actorId}
          createDb={createPgliteDb}
          clientId={pgliteClientId}
          clientStoreKey={DEMO_CLIENT_STORES.splitPglite.key}
          color="relay"
          onRecoverFromInitError={recoverPgliteFromInitError}
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
            are written locally first, then pushed to the server via the Sync
            transport. A service-worker realtime channel wakes other tabs
            immediately, and each client then pulls merged state from the commit
            log. Conflicts are detected using optimistic version checks on{' '}
            <code className="text-flow">server_version</code>.
          </>
        }
      />
    </>
  );
}
