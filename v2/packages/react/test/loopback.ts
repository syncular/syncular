/**
 * A minimal loopback harness for the React integration + parity tests: a
 * real `SyncClient` (bun:sqlite) driving a real server core in-process
 * through bytes. Modeled on the web-client test harness, trimmed to what the
 * React tests need. This proves the hooks work against the SHIPPED
 * `SyncClient` with REAL choke-point invalidation — not a fake.
 */
import type { RowColumn, ScopeMap } from '@syncular-v2/core';
import {
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular-v2/server';
import {
  type ClientSchema,
  type SegmentFetchRequest,
  SyncClient,
} from '@syncular-v2/web-client';
import { BunClientDatabase } from '@syncular-v2/web-client/bun';

const PARTITION = 'part-1';

const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
];

const SCHEMA_TABLES = [
  {
    name: 'tasks',
    columns: TASK_COLUMNS,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
] as const;

const SERVER_SCHEMA: ServerSchema = { version: 1, tables: SCHEMA_TABLES };
export const CLIENT_SCHEMA: ClientSchema = {
  version: 1,
  tables: SCHEMA_TABLES,
};

export interface LoopbackServer {
  readonly storage: SqliteServerStorage;
  readonly segments: MemorySegmentStore;
  readonly now: { ms: number };
  ctxFor(actorId: string): SyncRequestContext;
}

export function makeServer(): LoopbackServer {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const now = { ms: 1_750_000_000_000 };
  const limits = {
    maxOperationsPerRequest: 500,
    inlineSegmentMaxBytes: 256 * 1024,
  };
  const resolveScopes = (): ScopeMap => ({ project_id: ['*'] });
  const hub = createRealtimeHub({
    schema: SERVER_SCHEMA,
    storage,
    resolveScopes,
    clock: () => now.ms,
    segments,
    limits,
  });
  return {
    storage,
    segments,
    now,
    ctxFor: (actorId) => ({
      partition: PARTITION,
      actorId,
      schema: SERVER_SCHEMA,
      storage,
      segments,
      resolveScopes,
      clock: () => now.ms,
      limits,
      realtime: hub,
    }),
  };
}

export async function makeClient(
  server: LoopbackServer,
  clientId: string,
): Promise<SyncClient> {
  const db = new BunClientDatabase();
  const actorId = 'actor-1';
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    clientId,
    now: () => server.now.ms,
    transport: (bytes) => handleSyncRequest(bytes, server.ctxFor(actorId)),
    segments: async (request: SegmentFetchRequest) => {
      const result = await handleSegmentDownload(server.ctxFor(actorId), {
        segmentId: request.segmentId,
        scopesHeader: request.requestedScopesJson,
      });
      return result.bytes;
    },
  });
  await client.start();
  return client;
}

export function taskValues(
  id: string,
  projectId: string,
  title = 'task',
): Record<string, unknown> {
  return { id, project_id: projectId, title, done: false };
}
