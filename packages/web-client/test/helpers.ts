/**
 * Loopback harness (the loopback doctrine): two `SyncClient`s drive the
 * real B2 server library directly through bytes — `handleSyncRequest` for
 * sync, `handleSegmentDownload` for segment refs, `RealtimeHub.connect`
 * for the socket seam. No HTTP, no sockets. Fault injection happens at the
 * transport interface.
 */

import {
  type BlobTransport,
  type ClientSchema,
  type EncryptionConfig,
  type SegmentFetchRequest,
  SyncClient,
  type SyncClientConfig,
  type SyncClientLimits,
  type SyncIntent,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { RowColumn, ScopeMap } from '@syncular/core';
import {
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  type LeaseConfig,
  MemoryLeaseStore,
  MemorySegmentStore,
  RESOLVER_OUTAGE,
  type RealtimeHub,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  SyncError,
  type SyncRequestContext,
  type ValidatorRegistry,
} from '@syncular/server';

export const PARTITION = 'part-1';

export const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'priority', type: 'integer', nullable: true },
  { name: 'meta', type: 'json', nullable: true },
];

export const DOC_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'org_id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];

/** The same hand-written schema IR the server tests use (§2.4). */
const SCHEMA_TABLES = [
  {
    name: 'tasks',
    columns: TASK_COLUMNS,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
  {
    name: 'docs',
    columns: DOC_COLUMNS,
    primaryKey: 'id',
    scopes: [
      'org:{org_id}',
      { pattern: 'project:{projectId}', column: 'project_id' },
    ],
  },
] as const;

export const SERVER_SCHEMA: ServerSchema = {
  version: 1,
  tables: SCHEMA_TABLES,
};
export const CLIENT_SCHEMA: ClientSchema = {
  version: 1,
  tables: SCHEMA_TABLES,
};

export interface ServerFaults {
  /** Next getPushResult throws sync.idempotency_cache_miss (§6.3). */
  cacheMissOnce: boolean;
}

export interface TestServer {
  readonly storage: SqliteServerStorage;
  readonly segments: MemorySegmentStore;
  readonly hub: RealtimeHub;
  /** Allowed scopes per actor (§3.2 step 3); tests mutate freely. */
  readonly allowed: Record<string, ScopeMap>;
  readonly resolverError: { value: boolean };
  readonly resolverOutage: { value: boolean };
  readonly limits: {
    maxOperationsPerRequest: number;
    inlineSegmentMaxBytes: number;
  };
  readonly faults: ServerFaults;
  readonly now: { ms: number };
  ctxFor(actorId: string): SyncRequestContext;
}

function wrapStorage(
  storage: SqliteServerStorage,
  faults: ServerFaults,
): ServerStorage {
  return {
    ensureSchema: (s) => storage.ensureSchema(s),
    begin: (p) => storage.begin(p),
    getMaxCommitSeq: (p) => storage.getMaxCommitSeq(p),
    getHorizonSeq: (p) => storage.getHorizonSeq(p),
    setHorizonSeq: (p, s) => storage.setHorizonSeq(p, s),
    pruneCommitsThrough: (p, s) => storage.pruneCommitsThrough(p, s),
    getCommitSeqBefore: (p, t) => storage.getCommitSeqBefore(p, t),
    getRow: (p, t, r) => storage.getRow(p, t, r),
    getPushResult: (p, c, id) => {
      if (faults.cacheMissOnce) {
        faults.cacheMissOnce = false;
        throw new SyncError(
          'sync.idempotency_cache_miss',
          'simulated unreadable idempotency record',
        );
      }
      return storage.getPushResult(p, c, id);
    },
    readCommitWindow: (p, q) => storage.readCommitWindow(p, q),
    scanRows: (p, q) => storage.scanRows(p, q),
    getClientRecord: (p, c) => storage.getClientRecord(p, c),
    putClientRecord: (p, r) => storage.putClientRecord(p, r),
    listClientCursors: (p) => storage.listClientCursors(p),
  };
}

export function makeServer(
  schema: ServerSchema = SERVER_SCHEMA,
  options: {
    readonly validators?: ValidatorRegistry;
    readonly leases?: { readonly ttlMs: number };
  } = {},
): TestServer {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const allowed: Record<string, ScopeMap> = {};
  const resolverError = { value: false };
  const resolverOutage = { value: false };
  const faults: ServerFaults = { cacheMissOnce: false };
  const limits = {
    maxOperationsPerRequest: 500,
    inlineSegmentMaxBytes: 256 * 1024,
  };
  const now = { ms: 1_750_000_000_000 };
  const defaultAllowed: ScopeMap = {
    project_id: ['*'],
    projectId: ['*'],
    org_id: ['*'],
  };
  const resolveScopes = ({ actorId }: { actorId: string }) => {
    if (resolverError.value) throw new Error('resolver failure');
    if (resolverOutage.value) return RESOLVER_OUTAGE;
    return allowed[actorId] ?? defaultAllowed;
  };
  const leases: LeaseConfig | undefined =
    options.leases === undefined
      ? undefined
      : {
          ttlMs: options.leases.ttlMs,
          store: new MemoryLeaseStore({ leaseId: () => 'lease-private-id' }),
        };
  const wrapped = wrapStorage(storage, faults);
  const hub = createRealtimeHub({
    schema,
    storage: wrapped,
    resolveScopes,
    clock: () => now.ms,
    // §8.7: socket sync rounds ride the same segment store + limits as
    // the HTTP binding (one handler, two framings).
    segments,
    limits,
    ...(leases !== undefined ? { leases } : {}),
    ...(options.validators !== undefined
      ? { validators: options.validators }
      : {}),
  });
  const server: TestServer = {
    storage,
    segments,
    hub,
    allowed,
    resolverError,
    resolverOutage,
    limits,
    faults,
    now,
    ctxFor: (actorId) => ({
      partition: PARTITION,
      actorId,
      schema,
      storage: wrapped,
      segments,
      resolveScopes,
      clock: () => now.ms,
      limits,
      ...(leases !== undefined ? { leases } : {}),
      ...(options.validators !== undefined
        ? { validators: options.validators }
        : {}),
      realtime: hub,
    }),
  };
  return server;
}

export interface ClientFaults {
  /** Deliver the request to the server, then lose the response once. */
  dropResponseOnce: boolean;
  /** Corrupt the Nth remaining segment download (1 = next). 0 = off. */
  corruptSegmentDownload: number;
}

export interface TestClient {
  readonly client: SyncClient;
  readonly db: BunClientDatabase;
  readonly faults: ClientFaults;
  readonly wakes: Array<'hello' | string>;
  readonly intents: SyncIntent[];
}

export interface MakeClientOptions {
  readonly clientId: string;
  /** Re-openable local SQLite path; defaults to an isolated in-memory DB. */
  readonly databasePath?: string;
  /** Optional instrumented backend for database-boundary regression tests. */
  readonly database?: BunClientDatabase;
  readonly actorId?: string;
  readonly schema?: ClientSchema;
  readonly limits?: SyncClientLimits;
  readonly encryption?: EncryptionConfig;
  readonly blobs?: BlobTransport;
  readonly blobCacheMaxBytes?: number;
}

export async function makeClient(
  server: TestServer,
  options: MakeClientOptions,
): Promise<TestClient> {
  const db = options.database ?? new BunClientDatabase(options.databasePath);
  const actorId = options.actorId ?? 'actor-1';
  const faults: ClientFaults = {
    dropResponseOnce: false,
    corruptSegmentDownload: 0,
  };
  const wakes: Array<'hello' | string> = [];
  const intents: SyncIntent[] = [];
  let segmentCalls = 0;
  const config: SyncClientConfig = {
    database: db,
    schema: options.schema ?? CLIENT_SCHEMA,
    clientId: options.clientId,
    now: () => server.now.ms,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.encryption !== undefined
      ? { encryption: options.encryption }
      : {}),
    ...(options.blobs !== undefined ? { blobs: options.blobs } : {}),
    ...(options.blobCacheMaxBytes !== undefined
      ? { blobCacheMaxBytes: options.blobCacheMaxBytes }
      : {}),
    transport: async (bytes) => {
      const response = await handleSyncRequest(bytes, server.ctxFor(actorId));
      if (faults.dropResponseOnce) {
        faults.dropResponseOnce = false;
        throw new Error('simulated response loss');
      }
      return response;
    },
    segments: async (request: SegmentFetchRequest) => {
      const result = await handleSegmentDownload(server.ctxFor(actorId), {
        segmentId: request.segmentId,
        scopesHeader: request.requestedScopesJson,
      });
      segmentCalls += 1;
      if (faults.corruptSegmentDownload === segmentCalls) {
        faults.corruptSegmentDownload = 0;
        segmentCalls = 0;
        const corrupted = result.bytes.slice();
        corrupted[corrupted.length - 1] =
          (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        return corrupted;
      }
      return result.bytes;
    },
    realtime: async (handlers) => {
      const session = await server.hub.connect({
        partition: PARTITION,
        actorId,
        clientId: options.clientId,
        send: (data) => {
          if (typeof data === 'string') handlers.onText(data);
          else handlers.onBinary(data);
        },
        closeSocket: () => handlers.onClose?.(),
      });
      return {
        send: (text) => session.handleMessage(text),
        sendBytes: (bytes) => session.handleBinary(bytes),
        close: () => session.close(),
      };
    },
    onSyncNeeded: (reason) => {
      wakes.push(reason);
    },
    onSyncIntent: (intent) => intents.push(intent),
  };
  const client = new SyncClient(config);
  await client.start();
  return { client, db, faults, wakes, intents };
}

/** Readiness wait, never a sleep (test doctrine). */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what = 'condition',
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`${what} not reached`);
}

export function taskValues(
  id: string,
  projectId: string,
  title = 'task',
  done = false,
  priority: number | null = null,
  meta: string | null = null,
): Record<string, unknown> {
  return { id, project_id: projectId, title, done, priority, meta };
}

/** All rows of a local table, ordered by primary key. */
export function tableRows(
  db: BunClientDatabase,
  table: string,
): Record<string, unknown>[] {
  return db.query(`SELECT * FROM "${table}" ORDER BY id ASC`);
}
