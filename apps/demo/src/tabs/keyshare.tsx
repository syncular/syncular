/**
 * @syncular/demo - Encrypted Channel tab
 *
 * E2EE with BIP39 mnemonic key sharing between Alice (owner) and Bob (recipient).
 * Alice writes encrypted tasks via wa-sqlite; Bob reads via PGlite.
 * Before importing the key, Bob sees ciphertext; after, plaintext.
 */

import type { SyncClientPlugin } from '@syncular/client';
import {
  type ClientHandlerCollection,
  createIncrementingVersionPlugin,
} from '@syncular/client';
import {
  createFieldEncryptionPlugin,
  createStaticFieldEncryptionKeys,
  type FieldEncryptionKeys,
  type FieldEncryptionPlugin,
  generateSymmetricKey,
  keyToMnemonic,
  keyToShareUrl,
  mnemonicToKey,
  parseShareUrl,
} from '@syncular/client-plugin-encryption';
import {
  ClientPanel,
  DemoHeader,
  EncryptedBadge,
  EncryptionFlowDiagram,
  InfoPanel,
  MnemonicDisplay,
  SyncStatusBadge,
  type SyncStatus as SyncStatusType,
  TaskItem,
  TaskList,
  TopologyPanel,
  TopologySvgKeyshare,
} from '@syncular/ui/demo';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPgliteClient } from '../client/db-pglite';
import { createSqliteClient } from '../client/db-sqlite';
import { DEMO_CLIENT_STORES } from '../client/demo-data-reset';
import {
  createDemoPollingTransport,
  DEMO_DATA_CHANGE_DEBOUNCE_MS,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING,
  DEMO_POLL_INTERVAL_MS,
} from '../client/demo-transport';
import { sharedTasksClientHandler } from '../client/handlers/shared-tasks';
import { migrateClientDbWithTimeout } from '../client/migrate';
import {
  SyncProvider,
  useCachedAsyncValue,
  useMutation,
  useSyncContext,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import type { ClientDb, SharedTasksTable } from '../client/types.generated';
import {
  DemoClientSyncControls,
  useDemoClientSyncControls,
} from '../components/demo-client-sync-controls';
import { useKeyedConstant } from '../lib/use-keyed-constant';

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

interface KeyData {
  kid: string;
  key: Uint8Array;
}

type MnemonicImportState = 'empty' | 'debouncing' | 'ready' | 'invalid';

function shortKeyFingerprint(key: Uint8Array): string {
  const size = Math.min(8, key.length);
  const bytes = Array.from(key.slice(0, size));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function useStoredKey(storageKey: string): KeyData {
  return useMemo(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const existing = localStorage.getItem(storageKey);
        if (existing) {
          const parsed = parseShareUrl(existing);
          if (parsed.type === 'symmetric') {
            return { kid: parsed.kid ?? 'share-demo', key: parsed.key };
          }
        }
      }
    } catch {
      // ignore localStorage failures
    }

    const key = generateSymmetricKey();
    const kid = 'share-demo';

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, keyToShareUrl(key, kid));
      }
    } catch {
      // ignore
    }

    return { kid, key };
  }, [storageKey]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCiphertext(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('dgsync:e2ee:1:');
}

function deriveSyncBadgeStatus(
  status: ReturnType<typeof useSyncStatus>
): SyncStatusType {
  if (status.error) return 'error';
  if (!status.isOnline) return 'offline';
  if (status.isSyncing) return 'syncing';
  return 'synced';
}

// ---------------------------------------------------------------------------
// Alice (Owner) inner content - rendered inside SyncProvider
// ---------------------------------------------------------------------------

function AliceInner({
  shareId,
  actorId,
}: {
  shareId: string;
  actorId: string;
}) {
  const [newTitle, setNewTitle] = useState('');
  const syncStatus = useSyncStatus();
  const controls = useDemoClientSyncControls({
    clientKey: DEMO_CLIENT_STORES.keyshareAliceSqlite.key,
  });
  const badgeStatus = deriveSyncBadgeStatus(syncStatus);

  const { data: tasks, isLoading } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('shared_tasks')
        .selectAll()
        .where('share_id', '=', shareId)
        .orderBy('id', 'asc'),
    { deps: [shareId] }
  );

  const { mutate, isPending } = useMutation({ table: 'shared_tasks' });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || isPending) return;

    await mutate({
      op: 'upsert',
      table: 'shared_tasks',
      rowId: crypto.randomUUID(),
      payload: {
        share_id: shareId,
        title,
        completed: 0,
        owner_id: actorId,
      },
    });

    setNewTitle('');
  };

  const handleToggle = async (task: SharedTasksTable) => {
    if (isPending) return;
    const baseVersion =
      task.server_version && task.server_version > 0
        ? task.server_version
        : null;
    await mutate({
      op: 'upsert',
      table: 'shared_tasks',
      rowId: task.id,
      baseVersion,
      payload: {
        share_id: task.share_id,
        title: task.title,
        completed: task.completed ? 0 : 1,
        owner_id: task.owner_id,
      },
    });
  };

  const handleDelete = async (task: SharedTasksTable) => {
    if (isPending) return;
    await mutate({ op: 'delete', table: 'shared_tasks', rowId: task.id });
  };

  return (
    <ClientPanel
      label="Alice  /  wa-sqlite (OPFS)"
      color="flow"
      status={<SyncStatusBadge status={badgeStatus} />}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-mono text-[9px] text-neutral-600">
            {tasks?.length ?? 0} task{(tasks?.length ?? 0) === 1 ? '' : 's'}
          </span>
          <DemoClientSyncControls controls={controls} />
        </div>
      }
    >
      <form onSubmit={handleAdd} className="flex gap-2 mb-3">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add encrypted task..."
          className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-flow/40"
        />
        <button
          type="submit"
          disabled={isPending || !newTitle.trim()}
          className="px-3 py-1 text-xs font-mono rounded bg-flow/10 border border-flow/20 text-flow hover:bg-flow/20 transition-colors disabled:opacity-40"
        >
          Add
        </button>
      </form>

      {isLoading ? (
        <div className="text-xs text-neutral-600 py-4 text-center">
          Loading...
        </div>
      ) : (
        <TaskList emptyMessage="No shared tasks yet. Add one above.">
          {tasks?.map((task) => (
            <TaskItem
              key={task.id}
              checked={task.completed === 1}
              text={task.title}
              meta={`v${task.server_version ?? 0}`}
              onToggle={() => handleToggle(task)}
              onDelete={() => handleDelete(task)}
            />
          ))}
        </TaskList>
      )}
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// Alice panel wrapper with SyncProvider
// ---------------------------------------------------------------------------

function AlicePanel({
  shareId,
  keyData,
}: {
  shareId: string;
  keyData: KeyData;
}) {
  const actorId = 'alice';
  const clientId = 'client-keyshare-sqlite';
  const stateId = `keyshare-${shareId}-${keyData.kid}`;

  const [db, error] = useCachedAsyncValue(
    async () => {
      const created = createSqliteClient(
        DEMO_CLIENT_STORES.keyshareAliceSqlite.location
      );
      await migrateClientDbWithTimeout(created, {
        clientStoreKey: DEMO_CLIENT_STORES.keyshareAliceSqlite.key,
      });
      return created;
    },
    {
      key: DEMO_CLIENT_STORES.keyshareAliceSqlite.key,
    }
  );

  const transport = useKeyedConstant(actorId, () =>
    createDemoPollingTransport(actorId)
  );

  const keys = useMemo(
    () =>
      createStaticFieldEncryptionKeys({
        keys: { [keyData.kid]: keyData.key },
        encryptionKid: keyData.kid,
      }),
    [keyData]
  );

  const plugins: SyncClientPlugin[] = useMemo(
    () => [
      createIncrementingVersionPlugin(),
      createFieldEncryptionPlugin({
        rules: [
          { scope: 'shared_tasks', table: 'shared_tasks', fields: ['title'] },
        ],
        keys,
        decryptionErrorMode: 'keepCiphertext',
      }),
    ],
    [keys]
  );

  const sync = useKeyedConstant(shareId, () => {
    const handlers: ClientHandlerCollection<ClientDb> = [
      sharedTasksClientHandler,
    ];
    const subscriptions = [
      {
        id: `share-demo-${shareId}`,
        table: 'shared_tasks' as const,
        scopes: { share_id: shareId },
      },
    ];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  if (error) {
    return (
      <ClientPanel label="Alice  /  wa-sqlite (OPFS)" color="flow">
        <div className="text-xs text-red-400 py-4">Error: {error.message}</div>
      </ClientPanel>
    );
  }

  if (!db) {
    return (
      <ClientPanel label="Alice  /  wa-sqlite (OPFS)" color="flow">
        <div className="text-xs text-neutral-600 py-4 text-center">
          Initializing wa-sqlite...
        </div>
      </ClientPanel>
    );
  }

  return (
    <SyncProvider
      key={`${clientId}:${stateId}`}
      db={db}
      transport={transport}
      sync={sync}
      identity={{ actorId }}
      clientId={clientId}
      stateId={stateId}
      plugins={plugins}
      realtimeEnabled={true}
      dataChangeDebounceMs={DEMO_DATA_CHANGE_DEBOUNCE_MS}
      dataChangeDebounceMsWhenSyncing={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING
      }
      dataChangeDebounceMsWhenReconnecting={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING
      }
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
      onError={(e) => console.error('[Alice] Sync error:', e)}
    >
      <AliceInner shareId={shareId} actorId={actorId} />
    </SyncProvider>
  );
}

// ---------------------------------------------------------------------------
// Bob (Recipient) inner content - rendered inside SyncProvider
// ---------------------------------------------------------------------------

function BobInner({
  shareId,
  actorId,
  clientId,
  recipientKey,
  fieldEncryptionPlugin,
  onMnemonicChange,
  mnemonicValue,
  importState,
}: {
  shareId: string;
  actorId: string;
  clientId: string;
  recipientKey: Uint8Array | null;
  fieldEncryptionPlugin: FieldEncryptionPlugin;
  onMnemonicChange: (v: string) => void;
  mnemonicValue: string;
  importState: MnemonicImportState;
}) {
  const hasKey = recipientKey !== null;
  const { db, engine } = useSyncContext();
  const syncStatus = useSyncStatus();
  const controls = useDemoClientSyncControls({
    clientKey: DEMO_CLIENT_STORES.keyshareBobPglite.key,
  });
  const badgeStatus = deriveSyncBadgeStatus(syncStatus);

  useEffect(() => {
    if (!recipientKey) return;

    void (async () => {
      try {
        await fieldEncryptionPlugin.refreshEncryptedFields({
          db,
          engine,
          ctx: { actorId, clientId },
          targets: [
            {
              scope: 'shared_tasks',
              table: 'shared_tasks',
              fields: ['title'],
            },
          ],
        });
      } catch (err) {
        console.error('[Bob] Failed to refresh encrypted fields:', err);
      }
    })();
  }, [actorId, clientId, db, engine, fieldEncryptionPlugin, recipientKey]);

  const { data: tasks, isLoading } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('shared_tasks')
        .selectAll()
        .where('share_id', '=', shareId)
        .orderBy('id', 'asc'),
    { deps: [shareId] }
  );

  const importHint =
    importState === 'empty'
      ? 'Paste the 24-word phrase. Import runs automatically.'
      : importState === 'debouncing'
        ? 'Validating mnemonic...'
        : importState === 'ready'
          ? 'Mnemonic imported. Decryption refreshed.'
          : 'Invalid mnemonic. Keep typing all 24 words.';

  const importHintClassName =
    importState === 'invalid'
      ? 'text-red-400'
      : importState === 'ready'
        ? 'text-encrypt'
        : 'text-neutral-600';

  return (
    <ClientPanel
      label="Bob  /  PGlite (IndexedDB)"
      color="encrypt"
      status={
        <div className="flex items-center gap-2">
          <EncryptedBadge locked={!hasKey} />
          <SyncStatusBadge status={badgeStatus} />
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-mono text-[9px] text-neutral-600">
            {tasks?.length ?? 0} task{(tasks?.length ?? 0) === 1 ? '' : 's'}{' '}
            {hasKey ? '(decrypted)' : '(ciphertext)'}
          </span>
          <DemoClientSyncControls controls={controls} />
        </div>
      }
    >
      <div className="mb-3 space-y-2">
        <textarea
          value={mnemonicValue}
          onChange={(e) => onMnemonicChange(e.target.value)}
          placeholder="Enter 24-word mnemonic to decrypt..."
          rows={3}
          className="w-full bg-transparent border border-border rounded px-2 py-1.5 text-xs font-mono text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-encrypt/40 resize-none"
        />
        <p className={`text-[10px] font-mono ${importHintClassName}`}>
          {importHint}
        </p>
      </div>

      {isLoading ? (
        <div className="text-xs text-neutral-600 py-4 text-center">
          Loading...
        </div>
      ) : (
        <TaskList emptyMessage="Waiting for tasks from Alice...">
          {tasks?.map((task) => {
            const encrypted = isCiphertext(task.title);
            return (
              <TaskItem
                key={task.id}
                checked={task.completed === 1}
                text={encrypted ? `${task.title.slice(0, 48)}...` : task.title}
                meta={encrypted ? 'ciphertext' : 'plaintext'}
                trailing={
                  encrypted ? (
                    <EncryptedBadge locked label="encrypted" />
                  ) : undefined
                }
              />
            );
          })}
        </TaskList>
      )}
    </ClientPanel>
  );
}

// ---------------------------------------------------------------------------
// Bob panel wrapper with SyncProvider
// ---------------------------------------------------------------------------

function BobPanel({
  shareId,
  ownerKid,
  recipientKey,
  onMnemonicChange,
  mnemonicValue,
  importState,
}: {
  shareId: string;
  ownerKid: string;
  recipientKey: Uint8Array | null;
  onMnemonicChange: (v: string) => void;
  mnemonicValue: string;
  importState: MnemonicImportState;
}) {
  const actorId = 'bob';
  const clientId = 'client-keyshare-pglite';
  const stateId = `keyshare-${shareId}`;

  const [db, error] = useCachedAsyncValue(
    async () => {
      const created = await createPgliteClient(
        DEMO_CLIENT_STORES.keyshareBobPglite.location
      );
      await migrateClientDbWithTimeout(created, {
        clientStoreKey: DEMO_CLIENT_STORES.keyshareBobPglite.key,
      });
      return created;
    },
    {
      key: DEMO_CLIENT_STORES.keyshareBobPglite.key,
    }
  );
  const recipientKeyRef = useRef<Uint8Array | null>(recipientKey);

  const transport = useKeyedConstant(actorId, () =>
    createDemoPollingTransport(actorId)
  );

  useEffect(() => {
    recipientKeyRef.current = recipientKey;
  }, [recipientKey]);

  const keys = useMemo<FieldEncryptionKeys>(
    () => ({
      async getKey(kid: string): Promise<Uint8Array> {
        const key = recipientKeyRef.current;
        if (!key || kid !== ownerKid) {
          throw new Error(`Missing encryption key for kid "${kid}"`);
        }
        return key;
      },
      getEncryptionKid() {
        return ownerKid;
      },
    }),
    [ownerKid]
  );

  const fieldEncryptionPlugin = useMemo(
    () =>
      createFieldEncryptionPlugin({
        rules: [
          { scope: 'shared_tasks', table: 'shared_tasks', fields: ['title'] },
        ],
        keys,
        decryptionErrorMode: 'keepCiphertext',
      }),
    [keys]
  );

  const plugins: SyncClientPlugin[] = useMemo(
    () => [createIncrementingVersionPlugin(), fieldEncryptionPlugin],
    [fieldEncryptionPlugin]
  );

  const sync = useKeyedConstant(shareId, () => {
    const handlers: ClientHandlerCollection<ClientDb> = [
      sharedTasksClientHandler,
    ];
    const subscriptions = [
      {
        id: `share-demo-${shareId}`,
        table: 'shared_tasks' as const,
        scopes: { share_id: shareId },
      },
    ];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  if (error) {
    return (
      <ClientPanel label="Bob  /  PGlite (IndexedDB)" color="encrypt">
        <div className="text-xs text-red-400 py-4">Error: {error.message}</div>
      </ClientPanel>
    );
  }

  if (!db) {
    return (
      <ClientPanel label="Bob  /  PGlite (IndexedDB)" color="encrypt">
        <div className="text-xs text-neutral-600 py-4 text-center">
          Initializing PGlite...
        </div>
      </ClientPanel>
    );
  }

  return (
    <SyncProvider
      key={`${clientId}:${stateId}`}
      db={db}
      transport={transport}
      sync={sync}
      identity={{ actorId }}
      clientId={clientId}
      stateId={stateId}
      plugins={plugins}
      realtimeEnabled={true}
      dataChangeDebounceMs={DEMO_DATA_CHANGE_DEBOUNCE_MS}
      dataChangeDebounceMsWhenSyncing={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING
      }
      dataChangeDebounceMsWhenReconnecting={
        DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING
      }
      pollIntervalMs={DEMO_POLL_INTERVAL_MS}
      onError={(e) => console.error('[Bob] Sync error:', e)}
    >
      <BobInner
        shareId={shareId}
        actorId={actorId}
        clientId={clientId}
        recipientKey={recipientKey}
        fieldEncryptionPlugin={fieldEncryptionPlugin}
        onMnemonicChange={onMnemonicChange}
        mnemonicValue={mnemonicValue}
        importState={importState}
      />
    </SyncProvider>
  );
}

// ---------------------------------------------------------------------------
// Main tab export
// ---------------------------------------------------------------------------

export function KeyshareTab() {
  const ownerKeyData = useStoredKey('sync-demo:keyshare:owner-key-v3');
  const ownerMnemonic = useMemo(
    () => keyToMnemonic(ownerKeyData.key),
    [ownerKeyData.key]
  );

  const [recipientMnemonic, setRecipientMnemonic] = useState('');
  const [recipientKey, setRecipientKey] = useState<Uint8Array | null>(null);
  const [importState, setImportState] = useState<MnemonicImportState>('empty');

  const shareId = useMemo(
    () => `demo-share-${shortKeyFingerprint(ownerKeyData.key)}`,
    [ownerKeyData.key]
  );

  useEffect(() => {
    const normalized = recipientMnemonic.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      setRecipientKey(null);
      setImportState('empty');
      return;
    }

    setImportState('debouncing');
    const timer = window.setTimeout(() => {
      try {
        const key = mnemonicToKey(normalized);
        setRecipientKey(key);
        setImportState('ready');
      } catch {
        setImportState('invalid');
      }
    }, 380);

    return () => window.clearTimeout(timer);
  }, [recipientMnemonic]);

  const stats = useMemo(
    () => (
      <div className="flex items-center gap-3">
        <EncryptedBadge locked />
        <span className="font-mono text-[9px] text-neutral-600">
          XChaCha20-Poly1305
        </span>
      </div>
    ),
    []
  );

  return (
    <>
      <DemoHeader
        title="Encrypted Channel"
        subtitle="E2E encryption with key sharing  ·  XChaCha20-Poly1305"
        right={<EncryptedBadge locked />}
      />

      <TopologyPanel label="Key Exchange Topology" headerRight={stats}>
        <TopologySvgKeyshare />
      </TopologyPanel>

      <MnemonicDisplay
        words={ownerMnemonic.split(' ')}
        className="mt-4"
        copyValue={ownerMnemonic}
        copyButtonTone="prominent"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <AlicePanel shareId={shareId} keyData={ownerKeyData} />
        <BobPanel
          shareId={shareId}
          ownerKid={ownerKeyData.kid}
          recipientKey={recipientKey}
          onMnemonicChange={setRecipientMnemonic}
          mnemonicValue={recipientMnemonic}
          importState={importState}
        />
      </div>

      <EncryptionFlowDiagram className="mt-4" />

      <InfoPanel
        className="mt-4"
        icon={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-flow"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        }
        title="How it works"
        description={
          <>
            Alice generates a 256-bit symmetric key and shares it as a 24-word
            BIP39 mnemonic. All task titles are encrypted client-side with
            XChaCha20-Poly1305 before being pushed to the server. Bob enters the
            mnemonic to derive the same key and decrypt on pull. The server only
            ever stores ciphertext.
          </>
        }
      />
    </>
  );
}
