/**
 * @syncular/demo - Multi-Party Vault tab (Symmetric E2EE)
 *
 * Per-channel scope isolation with passphrase-derived keys.
 * Three actors (Designer, Developer, Viewer) each with their own
 * local database and encryption plugin.
 */

import {
  ClientTableRegistry,
  createIncrementingVersionPlugin,
} from '@syncular/client';
import { createFieldEncryptionPlugin } from '@syncular/client-plugin-encryption';
import { createWebSocketTransport } from '@syncular/transport-ws';
import {
  ActorPanel,
  ChannelSelector,
  DemoHeader,
  EncryptedBadge,
  EncryptionFlowDiagram,
  InfoPanel,
  NoteCard,
  TopologyPanel,
  TopologySvgSymmetric,
} from '@syncular/ui/demo';
import type { Kysely } from 'kysely';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPgliteClient } from '../client/db-pglite';
import { createSqliteClient } from '../client/db-sqlite';
import { migrateClientDb } from '../client/migrate';
import { SyncProvider, useMutation, useSyncQuery } from '../client/react';
import { patientNotesClientHandler } from '../client/shapes/patient-notes';
import type { ClientDb } from '../client/types.generated';
import {
  createPassphraseStore,
  createScopedKeyProvider,
} from '../lib/scoped-encryption';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNELS = [
  { id: 'alpha-launch', label: '#alpha-launch' },
  { id: 'beta-feedback', label: '#beta-feedback' },
  { id: 'internal-ops', label: '#internal-ops' },
];

const PenIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

const CodeIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

const EyeIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const ACTORS = [
  {
    id: 'designer',
    label: 'Designer',
    color: 'flow' as const,
    icon: <PenIcon />,
  },
  {
    id: 'developer',
    label: 'Developer',
    color: 'healthy' as const,
    icon: <CodeIcon />,
  },
  {
    id: 'viewer',
    label: 'Viewer',
    color: 'syncing' as const,
    icon: <EyeIcon />,
  },
];

// ---------------------------------------------------------------------------
// Passphrase state hook
// ---------------------------------------------------------------------------

function usePassphraseState() {
  const [, forceUpdate] = useState(0);
  const store = useMemo(() => {
    const s = createPassphraseStore();
    s.onChange(() => forceUpdate((v) => v + 1));
    return s;
  }, []);
  const passphrases = store.getAll();

  const setPassphrase = useCallback(
    (channelId: string, passphrase: string) => {
      store.set(`patient:${channelId}`, passphrase);
    },
    [store]
  );

  const clearPassphrase = useCallback(
    (channelId: string) => {
      store.delete(`patient:${channelId}`);
    },
    [store]
  );

  return { store, passphrases, setPassphrase, clearPassphrase };
}

type PassphraseState = ReturnType<typeof usePassphraseState>;

// ---------------------------------------------------------------------------
// Ciphertext detection
// ---------------------------------------------------------------------------

function isCiphertext(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('dgsync:e2ee:1:');
}

// ---------------------------------------------------------------------------
// Notes content (must be rendered inside SyncProvider)
// ---------------------------------------------------------------------------

function NotesContent({
  actorId,
  selectedChannel,
  canWrite,
}: {
  actorId: string;
  selectedChannel: string;
  canWrite: boolean;
}) {
  const { data: notes } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('patient_notes')
        .selectAll()
        .where('patient_id', '=', selectedChannel)
        .orderBy('created_at', 'desc'),
    { deps: [selectedChannel] }
  );

  const { mutate } = useMutation({ table: 'patient_notes' });

  const [newNote, setNewNote] = useState('');

  const handleAdd = useCallback(async () => {
    const text = newNote.trim();
    if (!text) return;
    await mutate({
      op: 'upsert',
      table: 'patient_notes',
      rowId: crypto.randomUUID(),
      payload: {
        patient_id: selectedChannel,
        note: text,
        created_by: actorId,
        created_at: new Date().toISOString(),
      },
    });
    setNewNote('');
  }, [mutate, newNote, selectedChannel, actorId]);

  const handleDelete = useCallback(
    async (rowId: string) => {
      await mutate({
        op: 'delete',
        table: 'patient_notes',
        rowId,
      });
    },
    [mutate]
  );

  return (
    <>
      {canWrite ? (
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
            placeholder="Add a note..."
            className="flex-1 bg-transparent border border-border rounded-md px-3 py-1.5 text-xs text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-neutral-600"
          />
        </div>
      ) : null}

      {notes?.length === 0 ? (
        <div className="text-center py-6 text-neutral-600 font-mono text-[10px]">
          No notes in this channel yet.
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {notes?.map((note) => (
          <NoteCard
            key={note.id}
            text={note.note}
            author={note.created_by}
            time={new Date(note.created_at).toLocaleTimeString()}
            isCiphertext={isCiphertext(note.note)}
            onDelete={canWrite ? () => handleDelete(note.id) : undefined}
          />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Actor vault panel (DB init + provider wiring)
// ---------------------------------------------------------------------------

function ActorVaultPanel({
  actor,
  passphraseState,
  createDb,
  clientId,
  selectedChannel,
  canWrite,
}: {
  actor: (typeof ACTORS)[number];
  passphraseState: PassphraseState;
  createDb: () => Kysely<ClientDb> | Promise<Kysely<ClientDb>>;
  clientId: string;
  selectedChannel: string;
  canWrite: boolean;
}) {
  const { store, passphrases, setPassphrase, clearPassphrase } =
    passphraseState;

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
        getHeaders: () => ({ 'x-user-id': actor.id }),
        getRealtimeParams: () => ({ userId: actor.id }),
      }),
    [actor.id]
  );

  const shapes = useMemo(() => {
    const registry = new ClientTableRegistry<ClientDb>();
    registry.register(patientNotesClientHandler);
    return registry;
  }, []);

  const plugins = useMemo(() => [createIncrementingVersionPlugin()], []);

  const subscriptions = useMemo(
    () =>
      CHANNELS.map((ch) => ({
        id: `channel-${ch.id}`,
        shape: 'patient_notes' as const,
        scopes: { patient_id: ch.id },
      })),
    []
  );

  const createEncryptionPlugin = useCallback(
    (channelId: string) =>
      createFieldEncryptionPlugin({
        rules: [
          { scope: 'patient_notes', table: 'patient_notes', fields: ['note'] },
        ],
        keys: createScopedKeyProvider(store, `patient:${channelId}`),
        decryptionErrorMode: 'keepCiphertext',
      }),
    [store]
  );

  const stateId = useMemo(() => {
    const passphrase = passphrases.get(`patient:${selectedChannel}`);
    const keyHash = passphrase ? btoa(passphrase).slice(0, 8) : 'no-key';
    return `symmetric-${selectedChannel}-${keyHash}`;
  }, [selectedChannel, passphrases]);

  const encryptionPlugin = useMemo(
    () => createEncryptionPlugin(selectedChannel),
    [createEncryptionPlugin, selectedChannel]
  );

  const allPlugins = useMemo(
    () => [...plugins, encryptionPlugin],
    [plugins, encryptionPlugin]
  );

  const hasPassphrase = passphrases.has(`patient:${selectedChannel}`);
  const currentPassphrase = passphrases.get(`patient:${selectedChannel}`) ?? '';

  if (!db) {
    return (
      <ActorPanel
        label={actor.label}
        color={actor.color}
        icon={actor.icon}
        badge={<EncryptedBadge locked />}
      >
        <div className="flex items-center justify-center h-[120px]">
          <span className="text-xs text-neutral-600 font-mono">
            Initializing database...
          </span>
        </div>
      </ActorPanel>
    );
  }

  return (
    <ActorPanel
      label={actor.label}
      color={actor.color}
      icon={actor.icon}
      badge={<EncryptedBadge locked={hasPassphrase} />}
    >
      <div className="flex gap-2 mb-3">
        <input
          type="password"
          value={currentPassphrase}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              setPassphrase(selectedChannel, val);
            } else {
              clearPassphrase(selectedChannel);
            }
          }}
          placeholder="Passphrase..."
          className="flex-1 bg-transparent border border-border rounded-md px-3 py-1.5 text-xs text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-neutral-600 font-mono"
        />
      </div>

      <SyncProvider
        db={db}
        transport={transport}
        shapes={shapes}
        clientId={clientId}
        actorId={actor.id}
        subscriptions={subscriptions}
        plugins={allPlugins}
        realtimeEnabled
        realtimeFallbackPollMs={10000}
        stateId={stateId}
      >
        <NotesContent
          actorId={actor.id}
          selectedChannel={selectedChannel}
          canWrite={canWrite}
        />
      </SyncProvider>
    </ActorPanel>
  );
}

// ---------------------------------------------------------------------------
// Stable factory callbacks
// ---------------------------------------------------------------------------

const createDesignerDb = () =>
  createSqliteClient('demo-symmetric-designer.sqlite');
const createDeveloperDb = () =>
  createPgliteClient('idb://sync-demo-symmetric-developer');
const createViewerDb = () => createSqliteClient('demo-symmetric-viewer.sqlite');

// ---------------------------------------------------------------------------
// Public: SymmetricTab
// ---------------------------------------------------------------------------

export function SymmetricTab() {
  const [selectedChannel, setSelectedChannel] = useState('alpha-launch');
  const designerState = usePassphraseState();
  const developerState = usePassphraseState();
  const viewerState = usePassphraseState();

  // Pre-set default passphrases for designer and developer
  useEffect(() => {
    for (const ch of CHANNELS) {
      if (!designerState.passphrases.has(`patient:${ch.id}`)) {
        designerState.setPassphrase(ch.id, 'team-secret-2024');
      }
      if (!developerState.passphrases.has(`patient:${ch.id}`)) {
        developerState.setPassphrase(ch.id, 'team-secret-2024');
      }
    }
  }, [designerState, developerState]); // Run once

  return (
    <>
      <DemoHeader
        title="Multi-Party Vault"
        subtitle="Per-channel scope isolation with passphrase-derived keys · PBKDF2 + XChaCha20"
      />

      <TopologyPanel
        label="Encryption Topology"
        headerRight={
          <ChannelSelector
            channels={CHANNELS}
            activeId={selectedChannel}
            onSelect={setSelectedChannel}
          />
        }
      >
        <TopologySvgSymmetric />
      </TopologyPanel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <ActorVaultPanel
          actor={ACTORS[0]!}
          passphraseState={designerState}
          createDb={createDesignerDb}
          clientId="client-symmetric-designer"
          selectedChannel={selectedChannel}
          canWrite
        />
        <ActorVaultPanel
          actor={ACTORS[1]!}
          passphraseState={developerState}
          createDb={createDeveloperDb}
          clientId="client-symmetric-developer"
          selectedChannel={selectedChannel}
          canWrite
        />
        <ActorVaultPanel
          actor={ACTORS[2]!}
          passphraseState={viewerState}
          createDb={createViewerDb}
          clientId="client-symmetric-viewer"
          selectedChannel={selectedChannel}
          canWrite={false}
        />
      </div>

      <EncryptionFlowDiagram className="mt-4" />

      <InfoPanel
        className="mt-4"
        icon={
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f472b6"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        }
        title="Deterministic key derivation"
        description={
          <>
            Each channel uses a separate PBKDF2-derived key from the shared
            passphrase. The same passphrase always produces the same 256-bit
            key, so any party who knows the passphrase can decrypt. The Viewer
            actor has no passphrase by default &mdash; enter the same passphrase
            as Designer/Developer to unlock the notes. The server only ever sees
            ciphertext.
          </>
        }
      />
    </>
  );
}
