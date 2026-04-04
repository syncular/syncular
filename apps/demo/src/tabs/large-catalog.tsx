/**
 * @syncular/demo - Bootstrap Observatory tab
 *
 * Syncs a 1,000,000+ row catalog via chunked snapshot bootstrapping.
 * All visual components come from @syncular/ui/demo.
 */

import { createServiceWorkerWakeTransport } from '@syncular/server-service-worker';
import {
  CatalogTable,
  DemoHeader,
  InfoPanel,
  MetricCard,
} from '@syncular/ui/demo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSqliteClient } from '../client/db-sqlite';
import { DEMO_CLIENT_STORES } from '../client/demo-data-reset';
import { getDemoAuthHeaders } from '../client/demo-identity';
import {
  DEMO_DATA_CHANGE_DEBOUNCE_MS,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING,
  DEMO_POLL_INTERVAL_MS,
} from '../client/demo-transport';
import { catalogItemsClientHandler } from '../client/handlers/catalog-items';
import { migrateClientDbWithTimeout } from '../client/migrate';
import {
  SyncProvider,
  useCachedAsyncValue,
  useSyncEngine,
  useSyncProgress,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import {
  DemoClientSyncControls,
  useDemoClientSyncControls,
} from '../components/demo-client-sync-controls';
import { useKeyedConstant } from '../lib/use-keyed-constant';

/* ---------- Constants ---------- */

const CATALOG_ACTOR_ID = 'demo-user';
const CATALOG_CLIENT_ID = 'client-pglite-catalog-demo';
const CATALOG_STATE_ID = 'catalog-demo';
const CATALOG_SUBSCRIPTION_ID = 'catalog-items';
const CATALOG_SNAPSHOT_ROWS_PER_PAGE = 50_000;
const CATALOG_MAX_SNAPSHOT_PAGES_PER_PULL = 20;
const CATALOG_SEED_PROGRESS_STEPS = 20;

/* ---------- Helpers ---------- */

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeSyncPhase(phase: string | undefined): string {
  switch (phase) {
    case 'starting':
      return 'starting sync';
    case 'bootstrapping':
      return 'downloading snapshot';
    case 'catching_up':
      return 'catching up';
    case 'live':
      return 'live';
    case 'error':
      return 'sync error';
    default:
      return 'idle';
  }
}

function resolveSeedStepRows(targetRows: number): number {
  return Math.min(
    CATALOG_SNAPSHOT_ROWS_PER_PAGE,
    Math.max(2_000, Math.ceil(targetRows / CATALOG_SEED_PROGRESS_STEPS))
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/* ---------- Types ---------- */

type ChunkStats = { downloads: number; bytes: number };
type SeedPhase = 'checking' | 'seeding' | 'syncing' | 'complete' | 'error';

interface SeedStatus {
  phase: SeedPhase;
  targetRows: number;
  seededRows: number;
  startedAt: number;
  errorMessage?: string;
}

/* ---------- Root tab (owns local SQLite lifecycle + SyncProvider) ---------- */

export function LargeCatalogTab() {
  const [db, dbError] = useCachedAsyncValue(
    async () => {
      const created = createSqliteClient(
        DEMO_CLIENT_STORES.catalogSqlite.location
      );
      await migrateClientDbWithTimeout(created, {
        clientStoreKey: DEMO_CLIENT_STORES.catalogSqlite.key,
      });
      return created;
    },
    {
      key: DEMO_CLIENT_STORES.catalogSqlite.key,
    }
  );
  const [chunkStats, setChunkStats] = useState<ChunkStats>({
    downloads: 0,
    bytes: 0,
  });

  /* Transport with chunk-tracking wrapper */
  const transport = useKeyedConstant(CATALOG_CLIENT_ID, () => {
    const trackChunkDownload = (byteLength: number) => {
      setChunkStats((prev) => ({
        downloads: prev.downloads + 1,
        bytes: prev.bytes + byteLength,
      }));
    };
    const countingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes('/api/sync/snapshot-chunks/')) {
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        trackChunkDownload(bytes.length);
      }

      return response;
    };

    return createServiceWorkerWakeTransport({
      baseUrl: '/api',
      getHeaders: () => getDemoAuthHeaders(CATALOG_ACTOR_ID),
      fetch: countingFetch,
    });
  });

  /* Sync handlers (catalog_items only) */
  const sync = useKeyedConstant(CATALOG_CLIENT_ID, () => {
    const handlers = [catalogItemsClientHandler];
    const subscriptions = [
      {
        id: CATALOG_SUBSCRIPTION_ID,
        table: 'catalog_items' as const,
        scopes: { catalog_id: 'demo' },
      },
    ];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  if (dbError) {
    return (
      <InfoPanel
        icon={<span className="text-red-400 text-sm">!</span>}
        title="Initialization Error"
        description={dbError.message}
      />
    );
  }

  if (!db) {
    return (
      <InfoPanel
        icon={<span className="text-flow text-sm">...</span>}
        title="Initializing"
        description="Setting up the local SQLite database for the catalog demo."
      />
    );
  }

  return (
    <SyncProvider
      db={db}
      transport={transport}
      sync={sync}
      identity={{ actorId: CATALOG_ACTOR_ID }}
      clientId={CATALOG_CLIENT_ID}
      stateId={CATALOG_STATE_ID}
      limitSnapshotRows={CATALOG_SNAPSHOT_ROWS_PER_PAGE}
      maxSnapshotPages={CATALOG_MAX_SNAPSHOT_PAGES_PER_PULL}
      realtimeEnabled={true}
      dataChangeDebounceMs={DEMO_DATA_CHANGE_DEBOUNCE_MS}
      dataChangeDebounceMsWhenSyncing={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING
      }
      dataChangeDebounceMsWhenReconnecting={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING
      }
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
      onError={(e) => console.error('[catalog-demo] Sync error:', e)}
    >
      <CatalogContent
        chunkStats={chunkStats}
        onResetChunkStats={() => setChunkStats({ downloads: 0, bytes: 0 })}
      />
    </SyncProvider>
  );
}

/* ---------- Inner content (lives inside SyncProvider) ---------- */

function CatalogContent(props: {
  chunkStats: ChunkStats;
  onResetChunkStats: () => void;
}) {
  const { chunkStats, onResetChunkStats } = props;
  const { isSyncing } = useSyncStatus();
  const { awaitBootstrapComplete } = useSyncEngine();
  const { progress: syncProgress } = useSyncProgress({ pollIntervalMs: 250 });
  const controls = useDemoClientSyncControls({
    clientKey: DEMO_CLIENT_STORES.catalogSqlite.key,
    onAfterReset: () => {
      onResetChunkStats();
    },
  });

  const [serverTotalRows, setServerTotalRows] = useState(0);
  const [serverBusy, setServerBusy] = useState(false);
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const debouncedFilter = useDebouncedValue(filterInput, 200).trim();

  const autoSeededRef = useRef(false);

  /* --- Server status polling --- */

  const refreshServerStatus = useCallback(async () => {
    const res = await fetch('/api/demo/catalog/status');
    if (!res.ok) {
      throw new Error(`Failed to load catalog status (${res.status})`);
    }
    const json = (await res.json()) as { totalRows: number };
    setServerTotalRows(json.totalRows);
    return json.totalRows;
  }, []);

  const restartClientAfterSeed = useCallback(() => {
    void controls
      .resetLocalData({ reconnect: true, forceReconnect: true })
      .then(async () => {
        await awaitBootstrapComplete({
          stateId: CATALOG_STATE_ID,
          subscriptionId: CATALOG_SUBSCRIPTION_ID,
          timeoutMs: 120_000,
        });
        setSeedStatus((current) => {
          if (!current || current.phase !== 'syncing') return current;
          return {
            ...current,
            phase: 'complete',
            seededRows: Math.max(current.seededRows, serverTotalRows),
          };
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setSeedStatus((current) => {
          if (!current || current.phase !== 'syncing') return current;
          return {
            ...current,
            phase: 'error',
            errorMessage: message,
          };
        });
      });
  }, [awaitBootstrapComplete, controls.resetLocalData, serverTotalRows]);

  /* --- Local row count --- */

  const { data: localStats } = useSyncQuery(
    async ({ selectFrom }) => {
      const t0 = performance.now();
      const row = await selectFrom('catalog_items')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirst();
      return { count: Number(row?.count ?? 0), ms: performance.now() - t0 };
    },
    { deps: [] }
  );

  const localCount = localStats?.count ?? 0;
  const percentage =
    serverTotalRows > 0
      ? Math.min(100, Math.round((localCount / serverTotalRows) * 100))
      : 0;

  /* --- Subscription state (bootstrap progress) --- */

  const { data: subState } = useSyncQuery(
    async ({ selectFrom }) => {
      const row = await selectFrom('sync_subscription_state')
        .select(['cursor', 'bootstrap_state_json', 'status'])
        .where('state_id', '=', CATALOG_STATE_ID)
        .where('subscription_id', '=', CATALOG_SUBSCRIPTION_ID)
        .executeTakeFirst();
      if (!row) return null;

      let rowCursor: string | null = null;
      if (typeof row.bootstrap_state_json === 'string') {
        try {
          const parsed = JSON.parse(row.bootstrap_state_json) as {
            rowCursor?: string | null;
          };
          if (
            typeof parsed.rowCursor === 'string' ||
            parsed.rowCursor === null
          ) {
            rowCursor = parsed.rowCursor ?? null;
          }
        } catch {
          rowCursor = null;
        }
      }

      return {
        cursor: row.cursor,
        rowCursor,
        status: row.status,
      };
    },
    { deps: [] }
  );

  /* --- Server seeding --- */

  const seedServer = useCallback(
    async (args: { rows: number; force: boolean }) => {
      const seedPhase = seedStatus?.phase;
      const seedWorkflowBusy =
        seedPhase === 'checking' ||
        seedPhase === 'seeding' ||
        seedPhase === 'syncing';
      if (serverBusy || seedWorkflowBusy) return;

      const targetRows = Math.max(0, Math.floor(args.rows));
      const stepRows = resolveSeedStepRows(targetRows);
      const startedAt = Date.now();
      let currentTotal = args.force ? 0 : serverTotalRows;
      let shouldForce = args.force;

      onResetChunkStats();
      setServerBusy(true);
      if (args.force) {
        setServerTotalRows(0);
      }
      setSeedStatus({
        phase: 'checking',
        targetRows,
        seededRows: currentTotal,
        startedAt,
      });

      try {
        if (!args.force) {
          currentTotal = await refreshServerStatus();
        }

        while (currentTotal < targetRows) {
          setSeedStatus({
            phase: 'seeding',
            targetRows,
            seededRows: currentTotal,
            startedAt,
          });

          const requestTargetRows = shouldForce
            ? Math.min(targetRows, stepRows)
            : Math.min(targetRows, currentTotal + stepRows);
          const res = await fetch('/api/demo/catalog/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rows: requestTargetRows,
              force: shouldForce,
            }),
          });
          if (!res.ok) {
            const message = (await res.text()).trim();
            throw new Error(
              message || `Seed request failed with status ${res.status}`
            );
          }

          const json = (await res.json()) as { totalRows?: number };
          const nextTotal = Number(json.totalRows ?? requestTargetRows);
          currentTotal = Number.isFinite(nextTotal)
            ? Math.max(currentTotal, nextTotal)
            : requestTargetRows;
          setServerTotalRows(currentTotal);
          shouldForce = false;
        }

        setSeedStatus({
          phase: 'syncing',
          targetRows,
          seededRows: currentTotal,
          startedAt,
        });
        restartClientAfterSeed();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSeedStatus({
          phase: 'error',
          targetRows,
          seededRows: currentTotal,
          startedAt,
          errorMessage: message,
        });
      } finally {
        setServerBusy(false);
      }
    },
    [
      onResetChunkStats,
      refreshServerStatus,
      restartClientAfterSeed,
      seedStatus?.phase,
      serverBusy,
      serverTotalRows,
    ]
  );

  /* --- Auto-seed on first load if server is empty --- */

  useEffect(() => {
    void refreshServerStatus().then((total) => {
      // Auto-seed 10k rows if server is empty (safe: uses onConflict doNothing)
      if (total === 0 && !autoSeededRef.current) {
        autoSeededRef.current = true;
        void seedServer({ rows: 10_000, force: false });
      }
    });
  }, [refreshServerStatus, seedServer]);

  useEffect(() => {
    if (seedStatus?.phase !== 'syncing') return;
    if (serverTotalRows <= 0 || localCount < serverTotalRows) return;

    setSeedStatus((current) => {
      if (!current || current.phase !== 'syncing') return current;
      return {
        ...current,
        phase: 'complete',
        seededRows: serverTotalRows,
      };
    });
  }, [localCount, seedStatus?.phase, serverTotalRows]);

  useEffect(() => {
    if (seedStatus?.phase !== 'complete') return;

    const timeoutId = window.setTimeout(() => {
      setSeedStatus((current) =>
        current?.phase === 'complete' ? null : current
      );
    }, 2_000);

    return () => window.clearTimeout(timeoutId);
  }, [seedStatus?.phase]);

  /* --- Clear server --- */

  const clearServer = useCallback(async () => {
    await fetch('/api/demo/catalog/clear', { method: 'POST' });
    setSeedStatus(null);
    onResetChunkStats();
    await refreshServerStatus();
  }, [onResetChunkStats, refreshServerStatus]);

  /* --- Filtered search --- */

  const { data: searchResults } = useSyncQuery(
    async ({ selectFrom }) => {
      const t0 = performance.now();
      let query = selectFrom('catalog_items')
        .select(['id', 'name'])
        .orderBy('id', 'asc')
        .limit(100);

      if (debouncedFilter) {
        query = query.where('name', 'ilike', `%${debouncedFilter}%`);
      }

      const rows = await query.execute();
      return {
        rows,
        ms: performance.now() - t0,
        filtered: debouncedFilter.length > 0,
      };
    },
    { deps: [debouncedFilter] }
  );

  /* --- Build catalog rows for the table --- */

  const catalogRows = (searchResults?.rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    sku: `SKU-${row.id}`,
    price: `$${(Number.parseInt(row.id, 10) * 0.99).toFixed(2)}`,
  }));

  const seedWorkflowBusy =
    seedStatus?.phase === 'checking' ||
    seedStatus?.phase === 'seeding' ||
    seedStatus?.phase === 'syncing';
  const seedProgress =
    seedStatus && seedStatus.targetRows > 0
      ? Math.min(
          100,
          Math.round((seedStatus.seededRows / seedStatus.targetRows) * 100)
        )
      : undefined;
  const syncPhaseLabel = describeSyncPhase(syncProgress?.channelPhase);
  const localProgressLabel =
    serverTotalRows <= 0
      ? 'Awaiting server data'
      : `${percentage}% · ${
          localCount >= serverTotalRows && !isSyncing
            ? 'live'
            : seedStatus?.phase === 'syncing' && !isSyncing
              ? 'starting sync'
              : syncPhaseLabel
        }`;
  const estimatedSnapshotChunks =
    serverTotalRows > CATALOG_SNAPSHOT_ROWS_PER_PAGE
      ? Math.ceil(serverTotalRows / CATALOG_SNAPSHOT_ROWS_PER_PAGE)
      : 0;
  const chunkDownloadLabel =
    estimatedSnapshotChunks > 0
      ? `${Math.min(chunkStats.downloads, estimatedSnapshotChunks)} / ${estimatedSnapshotChunks} chunks`
      : serverTotalRows > 0
        ? 'Inline snapshot'
        : 'No snapshot yet';
  const localBootstrapLabel =
    seedStatus?.phase === 'syncing'
      ? serverTotalRows > 0
        ? `Bootstrapping locally ${formatNumber(localCount)} / ${formatNumber(serverTotalRows)} rows (${percentage}%)`
        : `Bootstrapping locally (${syncProgress?.progressPercent ?? 0}%)`
      : undefined;
  const serverStatusLabel =
    seedStatus?.phase === 'checking'
      ? 'Checking server state...'
      : seedStatus?.phase === 'seeding'
        ? `Generating ${formatNumber(seedStatus.seededRows)} / ${formatNumber(seedStatus.targetRows)} rows`
        : seedStatus?.phase === 'syncing'
          ? `Server ready · ${formatNumber(seedStatus.seededRows)} rows`
          : seedStatus?.phase === 'complete'
            ? `Seeded ${formatNumber(seedStatus.seededRows)} rows`
            : seedStatus?.phase === 'error'
              ? `Seed failed: ${seedStatus.errorMessage ?? 'unknown error'}`
              : undefined;

  /* --- Render --- */

  const btnClass =
    'inline-flex items-center gap-1.5 px-3 py-1 rounded-md font-mono text-[10px] border border-border-bright bg-transparent text-neutral-400 hover:text-neutral-200 hover:border-flow/40 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const headerButtons = (
    <>
      <button
        type="button"
        className={btnClass}
        disabled={serverBusy || seedWorkflowBusy}
        onClick={() => seedServer({ rows: 1_000_000, force: false })}
      >
        {seedWorkflowBusy ? 'Seeding...' : 'Seed 1M Rows'}
      </button>
      <button
        type="button"
        className={btnClass}
        disabled={serverBusy || seedWorkflowBusy}
        onClick={() => clearServer()}
      >
        Clear
      </button>
      <DemoClientSyncControls controls={controls} />
    </>
  );

  const searchHeader = (
    <>
      <input
        type="text"
        value={filterInput}
        onChange={(e) => setFilterInput(e.target.value)}
        placeholder="Search by name..."
        className="bg-transparent border border-border rounded px-2 py-1 text-[11px] font-mono text-neutral-300 outline-none focus:border-flow/50 w-48"
      />
      {searchResults ? (
        <span className="font-mono text-[10px] text-neutral-500">
          {searchResults.filtered
            ? `${searchResults.rows.length} results in ${searchResults.ms.toFixed(0)}ms`
            : `Showing first ${searchResults.rows.length} rows (${searchResults.ms.toFixed(0)}ms)`}
        </span>
      ) : null}
    </>
  );

  const tableFooter = (
    <div className="flex w-full items-center justify-between gap-4 font-mono text-[10px] text-neutral-600">
      <span>
        {localBootstrapLabel ??
          serverStatusLabel ??
          `Server ready · ${formatNumber(serverTotalRows)} rows`}
      </span>
      <span>
        Sync: {syncPhaseLabel}
        {subState?.status ? ` · ${subState.status}` : ''}
        {subState?.rowCursor ? ` · row ${subState.rowCursor}` : ''}
        {subState?.cursor ? ` · cursor ${subState.cursor}` : ''}
      </span>
    </div>
  );

  return (
    <>
      <DemoHeader
        title="Bootstrap Observatory"
        subtitle="Sync 1,000,000+ rows with chunked snapshot bootstrapping"
        right={headerButtons}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <MetricCard
          label="Server Rows"
          value={formatNumber(serverTotalRows)}
          dotColor="flow"
          progress={seedProgress}
          progressColor="flow"
          progressLabel={serverStatusLabel}
        />
        <MetricCard
          label="Local Rows"
          value={formatNumber(localCount)}
          subtext={syncPhaseLabel}
          progress={percentage}
          dotColor="healthy"
          dotPulse={isSyncing}
          progressLabel={localProgressLabel}
        />
        <MetricCard
          label="Snapshot Chunks"
          value={
            estimatedSnapshotChunks > 0
              ? `${Math.min(chunkStats.downloads, estimatedSnapshotChunks)} / ${estimatedSnapshotChunks}`
              : `${chunkStats.downloads}`
          }
          subtext={`${formatBytes(chunkStats.bytes)} · ${syncPhaseLabel}`}
          dotColor="syncing"
          dotPulse={isSyncing}
          progress={
            estimatedSnapshotChunks > 0
              ? Math.min(
                  100,
                  Math.round(
                    (Math.min(chunkStats.downloads, estimatedSnapshotChunks) /
                      estimatedSnapshotChunks) *
                      100
                  )
                )
              : undefined
          }
          progressColor="syncing"
          progressLabel={chunkDownloadLabel}
        />
      </div>

      <div className="mt-6">
        <CatalogTable
          rows={catalogRows}
          label="Catalog Items"
          headerRight={searchHeader}
          footer={tableFooter}
          maxHeight={400}
        />
      </div>

      <div className="mt-4">
        <InfoPanel
          icon={<span className="text-flow text-sm">~</span>}
          title="How Chunked Bootstrap Works"
          description={
            <>
              When a client subscribes to a large table, the server splits the
              snapshot into compressed <code>json-row-frame-v1 + gzip</code>{' '}
              chunks. The client downloads and applies them incrementally,
              tracked by <code>bootstrap_state_json</code> in the subscription
              state. This lets you sync millions of rows without blocking the UI
              or exhausting memory.
            </>
          }
        />
      </div>
    </>
  );
}
