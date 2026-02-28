/**
 * @syncular/demo - Media Sync tab
 *
 * Demonstrates blob upload/sync between two clients using
 * content-addressed hashing, chunked transfer, and deduplication.
 *
 * Client A (wa-sqlite) uploads images, Client B (PGlite) receives them.
 */

import type { ClientHandlerCollection } from '@syncular/client';
import {
  ClientPanel,
  DemoHeader,
  InfoPanel,
  MediaGallery,
  MediaThumbnail,
  TopologyPanel,
  TopologySvgMedia,
  type TransferEntry,
  TransferLog,
  UploadArea,
} from '@syncular/ui/demo';
import { StatusDot } from '@syncular/ui/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPgliteClient } from '../client/db-pglite';
import { createSqliteClient } from '../client/db-sqlite';
import { DEMO_CLIENT_STORES } from '../client/demo-data-reset';
import { getDemoAuthHeaders } from '../client/demo-identity';
import {
  createDemoPollingTransport,
  DEMO_DATA_CHANGE_DEBOUNCE_MS,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING,
  DEMO_POLL_INTERVAL_MS,
} from '../client/demo-transport';
import { tasksClientHandler } from '../client/handlers/tasks';
import { migrateClientDbWithTimeout } from '../client/migrate';
import { SyncProvider, useMutations, useSyncQuery } from '../client/react';
import type { ClientDb, TasksTable } from '../client/types.generated';
import {
  DemoClientSyncControls,
  useDemoClientSyncControls,
} from '../components/demo-client-sync-controls';
import { useKeyedConstant } from '../lib/use-keyed-constant';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const userId = 'demo-media-user';
const blobBaseUrl = '/api/sync';

const subscriptions = [
  { id: 'my-tasks', table: 'tasks' as const, scopes: { user_id: userId } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BlobRef {
  hash: string;
  size: number;
  mimeType: string;
}

function parseBlobRef(value: unknown): BlobRef | null {
  if (!value) return null;
  // Some DB layers may auto-deserialize JSON strings from TEXT columns,
  // so the value may already be an object or still be a string.
  const parsed =
    typeof value === 'object'
      ? (value as BlobRef)
      : (() => {
          try {
            return JSON.parse(value as string) as BlobRef;
          } catch {
            return null;
          }
        })();
  if (parsed?.hash && parsed.size && parsed.mimeType) return parsed;
  return null;
}

async function computeSha256(data: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(data).buffer as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeNow(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

let uploaderDbPromise: Promise<
  Awaited<ReturnType<typeof createSqliteClient>>
> | null = null;
async function getUploaderDb() {
  if (!uploaderDbPromise) {
    uploaderDbPromise = (async () => {
      const db = createSqliteClient(
        DEMO_CLIENT_STORES.mediaUploaderSqlite.location
      );
      await migrateClientDbWithTimeout(db, {
        clientStoreKey: DEMO_CLIENT_STORES.mediaUploaderSqlite.key,
      });
      return db;
    })();
  }
  return uploaderDbPromise;
}

let receiverDbPromise: ReturnType<typeof createPgliteClient> | null = null;
function getReceiverDb() {
  if (!receiverDbPromise) {
    receiverDbPromise = (async () => {
      const db = await createPgliteClient(
        DEMO_CLIENT_STORES.mediaReceiverPglite.location
      );
      await migrateClientDbWithTimeout(db, {
        clientStoreKey: DEMO_CLIENT_STORES.mediaReceiverPglite.key,
      });
      return db;
    })();
  }
  return receiverDbPromise;
}

// ---------------------------------------------------------------------------
// BlobImage - fetches a signed URL and displays an image
// ---------------------------------------------------------------------------

function BlobImage({ blobRef }: { blobRef: BlobRef }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(
          `${blobBaseUrl}/blobs/${encodeURIComponent(blobRef.hash)}/url`,
          { headers: getDemoAuthHeaders(userId) }
        );
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { url: string };
        if (!cancelled) setSrc(json.url);
      } catch {
        // ignore - image will not render
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [blobRef.hash]);

  return (
    <MediaThumbnail
      filename={blobRef.hash.slice(0, 16)}
      statusColor={src ? '#22c55e' : '#f59e0b'}
      src={src ?? undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// Gallery - shared gallery rendering for both panels
// ---------------------------------------------------------------------------

function TaskGallery() {
  const { data: tasks } = useSyncQuery<TasksTable[]>((ctx) =>
    ctx.selectFrom('tasks').where('user_id', '=', userId).selectAll()
  );

  const tasksWithBlobs = useMemo(
    () =>
      (tasks ?? [])
        .map((t) => ({ task: t, blob: parseBlobRef(t.image) }))
        .filter(
          (item): item is { task: TasksTable; blob: BlobRef } =>
            item.blob !== null
        ),
    [tasks]
  );

  if (tasksWithBlobs.length === 0) {
    return (
      <div className="text-center py-6">
        <span className="font-mono text-[10px] text-neutral-600">
          No media yet
        </span>
      </div>
    );
  }

  return (
    <MediaGallery>
      {tasksWithBlobs.map(({ task, blob }) => (
        <BlobImage key={task.id} blobRef={blob} />
      ))}
    </MediaGallery>
  );
}

// ---------------------------------------------------------------------------
// UploaderPanel
// ---------------------------------------------------------------------------

function UploaderPanel({
  onTransfer,
}: {
  onTransfer: (entry: TransferEntry) => void;
}) {
  const mutations = useMutations();
  const controls = useDemoClientSyncControls({
    clientKey: DEMO_CLIENT_STORES.mediaUploaderSqlite.key,
  });
  const [isUploading, setIsUploading] = useState(false);

  const handleChange = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;

      setIsUploading(true);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const hex = await computeSha256(data);
        const hash = `sha256:${hex}`;
        const size = data.byteLength;
        const mimeType = file.type || 'image/png';

        // Step 1: Initiate upload
        const initRes = await fetch(`${blobBaseUrl}/blobs/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getDemoAuthHeaders(userId),
          },
          body: JSON.stringify({ hash, size, mimeType }),
        });

        if (!initRes.ok) return;
        const initJson = (await initRes.json()) as {
          exists: boolean;
          uploadUrl?: string;
          uploadMethod?: string;
          uploadHeaders?: Record<string, string>;
        };

        if (initJson.exists) {
          // Blob already exists (dedup)
          onTransfer({
            type: 'DEDUP',
            name: file.name,
            size: formatBytes(size),
            time: timeNow(),
          });
        } else {
          // Step 2: Upload the actual bytes
          if (initJson.uploadUrl) {
            await fetch(initJson.uploadUrl, {
              method: initJson.uploadMethod ?? 'PUT',
              headers: {
                'Content-Type': mimeType,
                ...(initJson.uploadHeaders ?? {}),
              },
              body: data,
            });
          }

          // Step 3: Complete the upload
          await fetch(
            `${blobBaseUrl}/blobs/${encodeURIComponent(hash)}/complete`,
            {
              method: 'POST',
              headers: getDemoAuthHeaders(userId),
            }
          );

          onTransfer({
            type: 'UPLOAD',
            name: file.name,
            size: formatBytes(size),
            time: timeNow(),
          });
        }

        // Step 4: Create task row referencing the blob
        const taskId = crypto.randomUUID();
        await mutations.tasks.upsert(taskId, {
          title: file.name,
          user_id: userId,
          completed: 0,
          image: JSON.stringify({ hash, size, mimeType }),
        });

        onTransfer({
          type: 'SYNC',
          name: file.name,
          size: formatBytes(size),
          time: timeNow(),
        });
      } finally {
        setIsUploading(false);
      }
    },
    [mutations, onTransfer]
  );

  return (
    <ClientPanel
      label="Client A - Uploader"
      color="flow"
      footer={<DemoClientSyncControls controls={controls} />}
    >
      <UploadArea
        onChange={handleChange}
        accept="image/*"
        label={isUploading ? 'Uploading...' : 'Click to upload an image'}
        className="mb-3"
      />
      {isUploading ? (
        <div className="flex items-center gap-2 mb-3 px-2">
          <span className="inline-block w-2 h-2 rounded-full bg-flow animate-pulse" />
          <span className="font-mono text-[10px] text-neutral-400">
            Uploading and syncing...
          </span>
        </div>
      ) : null}
      <TaskGallery />
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// ReceiverPanel
// ---------------------------------------------------------------------------

function ReceiverPanel() {
  const controls = useDemoClientSyncControls({
    clientKey: DEMO_CLIENT_STORES.mediaReceiverPglite.key,
  });

  return (
    <ClientPanel
      label="Client B - Receiver"
      color="relay"
      footer={<DemoClientSyncControls controls={controls} />}
    >
      <TaskGallery />
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// ReceiverWrapper - waits for PGlite database to be ready
// ---------------------------------------------------------------------------

function InitErrorPanel({
  label,
  color,
  error,
}: {
  label: string;
  color: 'flow' | 'relay';
  error: string;
}) {
  return (
    <ClientPanel label={label} color={color}>
      <div className="px-3 py-3">
        <div className="text-xs text-red-300 font-mono break-all">
          Database initialization failed: {error}
        </div>
      </div>
    </ClientPanel>
  );
}

function UploaderWrapper({
  onTransfer,
}: {
  onTransfer: (entry: TransferEntry) => void;
}) {
  const clientId = 'client-media-uploader';
  const [db, setDb] = useState<Awaited<
    ReturnType<typeof createSqliteClient>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transport = useKeyedConstant(clientId, () =>
    createDemoPollingTransport(userId)
  );

  const sync = useKeyedConstant(clientId, () => {
    const handlers: ClientHandlerCollection<ClientDb> = [tasksClientHandler];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  useEffect(() => {
    let cancelled = false;
    getUploaderDb()
      .then((resolved) => {
        if (!cancelled) setDb(resolved);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <InitErrorPanel label="Client A - Uploader" color="flow" error={error} />
    );
  }

  if (!db) {
    return (
      <ClientPanel label="Client A - Uploader" color="flow">
        <div className="text-center py-6">
          <span className="font-mono text-[10px] text-neutral-600">
            Initializing wa-sqlite...
          </span>
        </div>
      </ClientPanel>
    );
  }

  return (
    <SyncProvider
      key={`${userId}:${clientId}`}
      db={db}
      transport={transport}
      sync={sync}
      identity={{ actorId: userId }}
      clientId={clientId}
      realtimeEnabled={true}
      dataChangeDebounceMs={DEMO_DATA_CHANGE_DEBOUNCE_MS}
      dataChangeDebounceMsWhenSyncing={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING
      }
      dataChangeDebounceMsWhenReconnecting={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING
      }
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
    >
      <UploaderPanel onTransfer={onTransfer} />
    </SyncProvider>
  );
}

function ReceiverWrapper() {
  const clientId = 'client-media-receiver';
  const [db, setDb] = useState<Awaited<
    ReturnType<typeof createPgliteClient>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transport = useKeyedConstant(clientId, () =>
    createDemoPollingTransport(userId)
  );

  const sync = useKeyedConstant(clientId, () => {
    const handlers: ClientHandlerCollection<ClientDb> = [tasksClientHandler];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  useEffect(() => {
    let cancelled = false;
    getReceiverDb()
      .then((resolved) => {
        if (!cancelled) setDb(resolved);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <InitErrorPanel label="Client B - Receiver" color="relay" error={error} />
    );
  }

  if (!db) {
    return (
      <ClientPanel label="Client B - Receiver" color="relay">
        <div className="text-center py-6">
          <span className="font-mono text-[10px] text-neutral-600">
            Initializing PGlite...
          </span>
        </div>
      </ClientPanel>
    );
  }

  return (
    <SyncProvider
      key={`${userId}:${clientId}`}
      db={db}
      transport={transport}
      sync={sync}
      identity={{ actorId: userId }}
      clientId={clientId}
      realtimeEnabled={true}
      dataChangeDebounceMs={DEMO_DATA_CHANGE_DEBOUNCE_MS}
      dataChangeDebounceMsWhenSyncing={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING
      }
      dataChangeDebounceMsWhenReconnecting={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING
      }
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
    >
      <ReceiverPanel />
    </SyncProvider>
  );
}

// ---------------------------------------------------------------------------
// MediaSyncTab (exported)
// ---------------------------------------------------------------------------

export function MediaSyncTab() {
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);

  const addTransfer = useCallback((entry: TransferEntry) => {
    setTransfers((prev) => [entry, ...prev]);
  }, []);

  const badges = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <StatusDot color="flow" size="sm" glow />
        <span className="font-mono text-[10px] text-neutral-500">Uploader</span>
        <span className="font-mono text-[10px] text-neutral-600">
          {'\u2192'}
        </span>
        <StatusDot color="relay" size="sm" glow />
        <span className="font-mono text-[10px] text-neutral-500">Receiver</span>
      </div>
    ),
    []
  );

  const stats = useMemo(
    () => (
      <span className="font-mono text-[10px] text-neutral-600">
        {transfers.length} transfers
      </span>
    ),
    [transfers.length]
  );

  const infoIcon = useMemo(
    () => (
      <svg
        className="w-5 h-5 text-flow"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="20" height="20" rx="2" />
        <path d="M7 2v20" />
        <path d="M17 2v20" />
        <path d="M2 12h20" />
        <path d="M2 7h5" />
        <path d="M2 17h5" />
        <path d="M17 7h5" />
        <path d="M17 17h5" />
      </svg>
    ),
    []
  );

  return (
    <>
      <DemoHeader
        title="Media Sync"
        subtitle="Blob storage with chunked transfer · deduplication · content-addressed hashing"
        right={badges}
      />

      <TopologyPanel label="Blob Transfer Topology" headerRight={stats}>
        <TopologySvgMedia />
      </TopologyPanel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <UploaderWrapper onTransfer={addTransfer} />
        <ReceiverWrapper />
      </div>

      <TransferLog entries={transfers} className="mt-4" />

      <InfoPanel
        icon={infoIcon}
        title="Content-addressed blob storage"
        description="Files are identified by their SHA-256 hash. Uploading the same file twice is a no-op thanks to server-side deduplication. Blobs are stored independently from the sync commit log and referenced via a JSON BlobRef in the tasks table."
        className="mt-4"
      />
    </>
  );
}
