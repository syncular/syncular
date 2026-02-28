/**
 * @syncular/demo - CRDT/Yjs tab
 *
 * Two independent clients (wa-sqlite OPFS + PGlite IndexedDB) editing the
 * same CRDT-backed shared text document via Yjs envelopes over Syncular transport.
 */

import {
  type ClientHandlerCollection,
  createIncrementingVersionPlugin,
  type SyncError,
  SyncTransportError,
} from '@syncular/client';
import {
  buildYjsTextUpdate,
  createYjsClientPlugin,
  YJS_PAYLOAD_KEY,
} from '@syncular/client-plugin-crdt-yjs';
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
  TopologyPanel,
  TopologySvgSplit,
} from '@syncular/ui/demo';
import { StatusDot } from '@syncular/ui/navigation';
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { Kysely } from 'kysely';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  DEMO_DATA_CHANGE_DEBOUNCE_MS,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING,
  DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING,
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
  useMutation,
  useResolveConflict,
  useSyncQuery,
  useSyncStatus,
} from '../client/react';
import type { ClientDb } from '../client/types.generated';
import {
  DemoClientSyncControls,
  useDemoClientSyncControls,
} from '../components/demo-client-sync-controls';
import { useKeyedConstant } from '../lib/use-keyed-constant';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID_SEED_STORAGE_KEY = 'sync-demo:crdt-yjs:client-seed-v1';
const TASK_TITLE_YJS_STATE_COLUMN = 'title_yjs_state';
const TASK_TITLE_YJS_CONTAINER = 'title';
const EDITOR_DOC_ROW_ID = 'shared-doc-main';
const EDITOR_INITIAL_TEXT =
  'This is a shared Yjs text document.\n\nType in either client and watch it sync.';

function createClientIdSeed(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCrdtYjsClientIdSeed(): string {
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

function normalizeEditorText(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function plainTextToDocContent(text: string): JSONContent {
  const normalized = normalizeEditorText(text);
  const lines = normalized.split('\n');
  const content: JSONContent[] = lines.map((line) => {
    if (line.length === 0) {
      return { type: 'paragraph' };
    }
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    };
  });
  return { type: 'doc', content };
}

interface YjsTextEditorProps {
  value: string;
  onChange: (nextValue: string) => void;
}

function YjsTextEditor({ value, onChange }: YjsTextEditorProps) {
  const isApplyingRemote = useRef(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false,
        italic: false,
        strike: false,
        code: false,
        codeBlock: false,
        blockquote: false,
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
    ],
    content: plainTextToDocContent(value),
    editorProps: {
      attributes: {
        class:
          'min-h-[220px] whitespace-pre-wrap break-words rounded-md border border-border bg-transparent px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 font-mono leading-relaxed',
      },
    },
    onUpdate: ({ editor }) => {
      if (isApplyingRemote.current) return;
      const nextText = normalizeEditorText(
        editor.getText({ blockSeparator: '\n' })
      );
      onChange(nextText);
    },
  });

  useEffect(() => {
    if (!editor) return;
    const current = normalizeEditorText(
      editor.getText({ blockSeparator: '\n' })
    );
    const next = normalizeEditorText(value);
    if (current === next) return;

    isApplyingRemote.current = true;
    editor.commands.setContent(plainTextToDocContent(next), {
      emitUpdate: false,
    });
    isApplyingRemote.current = false;
  }, [editor, value]);

  if (!editor) {
    return (
      <div className="min-h-[220px] rounded-md border border-border bg-transparent px-3 py-2 text-xs text-neutral-500 font-mono">
        Initializing editor...
      </div>
    );
  }

  return <EditorContent editor={editor} />;
}

// ---------------------------------------------------------------------------
// Inner: EditorPanelContent (must be rendered inside SyncProvider)
// ---------------------------------------------------------------------------

function EditorPanelContent({
  actorId,
  color,
  clientStoreKey,
}: {
  actorId: string;
  color: 'flow' | 'relay';
  clientStoreKey: string;
}) {
  const { data: taskRows, refetch } = useSyncQuery((ctx) =>
    ctx.selectFrom('tasks').selectAll().orderBy('id', 'asc')
  );
  const titleMutation = useMutation({
    table: 'tasks',
    syncImmediately: true,
  });
  const status = useSyncStatus();
  const { conflicts, refresh: refreshConflicts } = useConflicts();
  const {
    resolve: resolveConflict,
    isPending: isResolvingConflict,
    error: resolveConflictError,
  } = useResolveConflict();

  const [draft, setDraft] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const documentRow = useMemo(
    () => taskRows?.find((row) => row.id === EDITOR_DOC_ROW_ID) ?? null,
    [taskRows]
  );

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

  const ensureEditorDocument = useCallback(async () => {
    if (documentRow) return;
    const initial = buildYjsTextUpdate({
      nextText: EDITOR_INITIAL_TEXT,
      containerKey: TASK_TITLE_YJS_CONTAINER,
    });
    await titleMutation.mutate({
      op: 'upsert',
      rowId: EDITOR_DOC_ROW_ID,
      payload: {
        title: initial.nextText,
        title_yjs_state: initial.nextStateBase64,
        completed: 0,
        user_id: actorId,
      },
    });
  }, [actorId, documentRow, titleMutation]);

  useEffect(() => {
    if (documentRow) return;
    void ensureEditorDocument();
  }, [documentRow, ensureEditorDocument]);

  useEffect(() => {
    setDraft(documentRow?.title ?? '');
  }, [documentRow?.title]);

  const saveDraft = useCallback(async () => {
    if (!documentRow) return;
    if (draft === documentRow.title) return;

    const update = buildYjsTextUpdate({
      previousStateBase64: documentRow.title_yjs_state ?? null,
      nextText: draft,
      containerKey: TASK_TITLE_YJS_CONTAINER,
    });

    setEditorError(null);
    await titleMutation.mutate({
      op: 'upsert',
      rowId: documentRow.id,
      payload: {
        title: update.nextText,
        completed: documentRow.completed ?? 0,
        user_id: documentRow.user_id ?? actorId,
        title_yjs_state: update.nextStateBase64,
        [YJS_PAYLOAD_KEY]: {
          title: update.update,
        },
      },
    });
  }, [actorId, documentRow, draft, titleMutation]);

  useEffect(() => {
    if (!documentRow) return;
    if (draft === documentRow.title) return;
    if (typeof window === 'undefined') return;

    const timer = window.setTimeout(() => {
      void saveDraft().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setEditorError(message);
      });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [documentRow, draft, saveDraft]);

  const handleResetEditor = useCallback(async () => {
    const update = buildYjsTextUpdate({
      previousStateBase64: documentRow?.title_yjs_state ?? null,
      nextText: '',
      containerKey: TASK_TITLE_YJS_CONTAINER,
    });

    setEditorError(null);
    await titleMutation.mutate({
      op: 'upsert',
      rowId: documentRow?.id ?? EDITOR_DOC_ROW_ID,
      payload: {
        title: update.nextText,
        completed: documentRow?.completed ?? 0,
        user_id: documentRow?.user_id ?? actorId,
        title_yjs_state: update.nextStateBase64,
        [YJS_PAYLOAD_KEY]: {
          title: update.update,
        },
      },
    });
  }, [actorId, documentRow, titleMutation]);

  const editorWordCount = useMemo(() => {
    const normalized = draft.trim();
    if (!normalized) return 0;
    return normalized.split(/\s+/).length;
  }, [draft]);

  const editorCharCount = draft.length;
  const editorVersion = documentRow?.server_version ?? 0;

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
      <div className="mb-2 flex items-center justify-between text-[10px] font-mono text-neutral-500">
        <span>doc: {EDITOR_DOC_ROW_ID}</span>
        <span>
          v{editorVersion} {titleMutation.isPending ? '· saving…' : ''}
        </span>
      </div>

      <YjsTextEditor
        value={draft}
        onChange={(nextValue) => {
          setDraft(nextValue);
        }}
      />

      <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-neutral-500">
        <span>
          {editorCharCount} chars · {editorWordCount} words
        </span>
        <button
          type="button"
          onClick={() => void handleResetEditor()}
          disabled={titleMutation.isPending}
          className="rounded border border-border px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Clear
        </button>
      </div>

      {editorError ? (
        <div className="mt-2 text-[10px] text-red-300 font-mono break-all">
          Save failed: {editorError}
        </div>
      ) : null}

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

  const transport = useKeyedConstant(actorId, () =>
    createDemoPollingTransport(actorId)
  );

  const plugins = useKeyedConstant(clientId, () => [
    createIncrementingVersionPlugin(),
    createYjsClientPlugin({
      rules: [
        {
          table: 'tasks',
          field: 'title',
          stateColumn: TASK_TITLE_YJS_STATE_COLUMN,
          containerKey: TASK_TITLE_YJS_CONTAINER,
        },
      ],
    }),
  ]);

  const sync = useKeyedConstant(actorId, () => {
    const handlers: ClientHandlerCollection<ClientDb> = [
      tasksClientHandler,
      sharedTasksClientHandler,
      catalogItemsClientHandler,
    ];
    const subscriptions = [
      { id: 'my-tasks', table: 'tasks' as const, scopes: { user_id: actorId } },
    ];
    return {
      handlers,
      subscriptions: () => subscriptions,
    };
  });

  const providerKey = useMemo(
    () => `${actorId}:${clientId}`,
    [actorId, clientId]
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
      key={providerKey}
      db={db}
      transport={transport}
      sync={sync}
      clientId={clientId}
      identity={{ actorId }}
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
    >
      <EditorPanelContent
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
  createSqliteClient(DEMO_CLIENT_STORES.crdtYjsSqlite.location);
const createPgliteDialect = () =>
  createPgliteClient(DEMO_CLIENT_STORES.crdtYjsPglite.location);

// ---------------------------------------------------------------------------
// Public: CrdtYjsTab
// ---------------------------------------------------------------------------

export function CrdtYjsTab() {
  const clientIdSeed = useMemo(() => getCrdtYjsClientIdSeed(), []);
  const actorId = useMemo(
    () => `demo-user::crdt-yjs-${clientIdSeed}`,
    [clientIdSeed]
  );
  const sqliteClientId = useMemo(
    () => `client-sqlite-crdt-yjs-${clientIdSeed}`,
    [clientIdSeed]
  );
  const pgliteClientId = useMemo(
    () => `client-pglite-crdt-yjs-${clientIdSeed}`,
    [clientIdSeed]
  );
  const recoverPgliteFromInitError = useCallback(async () => {
    const before = getPgliteDataDirState(
      DEMO_CLIENT_STORES.crdtYjsPglite.location
    );
    const after = rotatePgliteDataDir(
      DEMO_CLIENT_STORES.crdtYjsPglite.location
    );
    logBrowserSentryMessage('syncular.demo.client.db_init_recovery_rotated', {
      level: 'warn',
      attributes: {
        client_store_key: DEMO_CLIENT_STORES.crdtYjsPglite.key,
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
        title="CRDT / Yjs"
        subtitle="Two independent SQLite clients editing the same Yjs-backed shared document"
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
          clientStoreKey={DEMO_CLIENT_STORES.crdtYjsSqlite.key}
          color="flow"
        />
        <SyncClientPanel
          actorId={actorId}
          createDb={createPgliteDialect}
          clientId={pgliteClientId}
          clientStoreKey={DEMO_CLIENT_STORES.crdtYjsPglite.key}
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
            log. Editor changes are persisted as Yjs CRDT updates on{' '}
            <code>tasks.title</code> so concurrent edits merge automatically
            without manual conflict resolution.
          </>
        }
      />
    </>
  );
}
