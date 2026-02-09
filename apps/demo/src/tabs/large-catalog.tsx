/**
 * @syncular/demo - Bootstrap Observatory tab
 *
 * Syncs a 1,000,000+ row catalog via chunked snapshot bootstrapping.
 * All visual components come from @syncular/ui/demo.
 */

import { ClientTableRegistry } from '@syncular/client';
import type { SyncTransportOptions } from '@syncular/core';
import { createWebSocketTransport } from '@syncular/transport-ws';
import {
  CatalogTable,
  DemoHeader,
  InfoPanel,
  MetricCard,
} from '@syncular/ui/demo';
import type { Kysely } from 'kysely';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSqliteClient } from '../client/db-sqlite';
import { migrateClientDb } from '../client/migrate';
import {
  SyncProvider,
  useSyncContext,
  useSyncEngine,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import { catalogItemsClientHandler } from '../client/shapes/catalog-items';
import type { ClientDb } from '../client/types.generated';

/* ---------- Constants ---------- */

const CATALOG_ACTOR_ID = 'demo-user';
const CATALOG_CLIENT_ID = 'client-pglite-catalog-demo';
const CATALOG_STATE_ID = 'catalog-demo';
const CATALOG_SUBSCRIPTION_ID = 'catalog-items';

/* ---------- Helpers ---------- */

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/* ---------- Root tab (owns PGlite lifecycle + SyncProvider) ---------- */

export function LargeCatalogTab() {
  const [db, setDb] = useState<Kysely<ClientDb> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chunkStats, setChunkStats] = useState<ChunkStats>({
    downloads: 0,
    bytes: 0,
  });

  const initRef = useRef(false);

  /* Transport with chunk-tracking wrapper */
  const transport = useMemo(() => {
    const base = createWebSocketTransport({
      baseUrl: '/api',
      wsUrl: '/api/sync/realtime',
      getHeaders: () => ({ 'x-user-id': CATALOG_ACTOR_ID }),
      getRealtimeParams: () => ({ userId: CATALOG_ACTOR_ID }),
    });
    return {
      ...base,
      async fetchSnapshotChunk(
        request: { chunkId: string },
        transportOptions?: SyncTransportOptions
      ) {
        const bytes = await base.fetchSnapshotChunk(request, transportOptions);
        setChunkStats((prev) => ({
          downloads: prev.downloads + 1,
          bytes: prev.bytes + bytes.length,
        }));
        return bytes;
      },
    };
  }, []);

  /* Table registry (catalog_items only) */
  const tables = useMemo(
    () =>
      new ClientTableRegistry<ClientDb>().register(catalogItemsClientHandler),
    []
  );

  /* Init PGlite database */
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        const database = createSqliteClient('demo-catalog-v2.sqlite');
        await migrateClientDb(database);
        setDb(database);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  if (error) {
    return (
      <InfoPanel
        icon={<span className="text-red-400 text-sm">!</span>}
        title="Initialization Error"
        description={error}
      />
    );
  }

  if (!db) {
    return (
      <InfoPanel
        icon={<span className="text-flow text-sm">...</span>}
        title="Initializing"
        description="Setting up the local PGlite database for the catalog demo."
      />
    );
  }

  return (
    <SyncProvider
      db={db}
      transport={transport}
      shapes={tables}
      actorId={CATALOG_ACTOR_ID}
      clientId={CATALOG_CLIENT_ID}
      stateId={CATALOG_STATE_ID}
      subscriptions={[
        {
          id: CATALOG_SUBSCRIPTION_ID,
          shape: 'catalog_items',
          scopes: { catalog_id: 'demo' },
        },
      ]}
      limitSnapshotRows={5000}
      maxSnapshotPages={20}
      realtimeEnabled
      realtimeFallbackPollMs={10000}
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
  const { db } = useSyncContext();
  const { sync, disconnect, reconnect } = useSyncEngine();
  const { isSyncing } = useSyncStatus();

  const [serverTotalRows, setServerTotalRows] = useState(0);
  const [serverBusy, setServerBusy] = useState(false);
  const [filterInput, setFilterInput] = useState('');
  const debouncedFilter = useDebouncedValue(filterInput, 200).trim();

  /* --- Server status polling --- */

  const refreshServerStatus = useCallback(async () => {
    const res = await fetch('/api/demo/catalog/status');
    const json = (await res.json()) as { totalRows: number };
    setServerTotalRows(json.totalRows);
  }, []);

  useEffect(() => {
    void refreshServerStatus();
  }, [refreshServerStatus]);

  /* --- Server seeding --- */

  const seedServer = useCallback(
    async (args: { rows: number; force: boolean }) => {
      setServerBusy(true);
      try {
        let force = args.force;
        for (;;) {
          const res = await fetch('/api/demo/catalog/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: args.rows, force }),
          });
          const json = (await res.json()) as {
            totalRows: number;
            hasMore: boolean;
          };
          setServerTotalRows(json.totalRows);
          if (!json.hasMore) break;
          force = false;
        }
      } finally {
        setServerBusy(false);
      }
    },
    []
  );

  /* --- Clear server --- */

  const clearServer = useCallback(async () => {
    await fetch('/api/demo/catalog/clear', { method: 'POST' });
    refreshServerStatus();
  }, [refreshServerStatus]);

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
      return row ?? null;
    },
    { deps: [] }
  );

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

  /* --- Reset & re-bootstrap --- */

  const resetLocalAndBootstrap = useCallback(async () => {
    props.onResetChunkStats();
    disconnect();
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('catalog_items').execute();
      await trx
        .deleteFrom('sync_subscription_state')
        .where('state_id', '=', CATALOG_STATE_ID)
        .where('subscription_id', '=', CATALOG_SUBSCRIPTION_ID)
        .execute();
    });
    reconnect();
    await sync();
  }, [db, disconnect, props, reconnect, sync]);

  /* --- Render --- */

  const btnClass =
    'inline-flex items-center gap-1.5 px-3 py-1 rounded-md font-mono text-[10px] border border-border-bright bg-transparent text-neutral-400 hover:text-neutral-200 hover:border-flow/40 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const headerButtons = (
    <>
      <button
        type="button"
        className={btnClass}
        disabled={serverBusy}
        onClick={() => seedServer({ rows: 1_000_000, force: false })}
      >
        Seed 1M Rows
      </button>
      <button
        type="button"
        className={btnClass}
        disabled={serverBusy}
        onClick={() => clearServer()}
      >
        Clear
      </button>
      <button
        type="button"
        className={btnClass}
        onClick={() => resetLocalAndBootstrap()}
      >
        Re-bootstrap
      </button>
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
    <span className="font-mono text-[10px] text-neutral-600">
      Bootstrap: {subState?.status ?? 'pending'}
      {subState?.cursor ? ` | cursor: ${subState.cursor}` : ''}
    </span>
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
        />
        <MetricCard
          label="Local Rows"
          value={formatNumber(localCount)}
          progress={percentage}
          dotColor="healthy"
          dotPulse={isSyncing}
          progressLabel={`${percentage}%`}
        />
        <MetricCard
          label="Snapshot Chunks"
          value={`${props.chunkStats.downloads}`}
          subtext={formatBytes(props.chunkStats.bytes)}
          dotColor="syncing"
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
              snapshot into compressed <code>ndjson-gzip</code> chunks. The
              client downloads and applies them incrementally, tracked by{' '}
              <code>bootstrap_state_json</code> in the subscription state. This
              lets you sync millions of rows without blocking the UI or
              exhausting memory.
            </>
          }
        />
      </div>
    </>
  );
}
