import { writeFile } from 'node:fs/promises';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/server/bun-sqlite';
import {
  createBlobRoutes,
  createSyncRoutes,
  getSyncWebSocketConnectionManager,
} from '@syncular/server/hono';
import { createSqliteServerDialect } from '@syncular/server/sqlite';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import {
  ensureHonoSyncTasksTable,
  type HonoAuthContext,
  type HonoSyncClientDb,
  type HonoSyncServerDb,
} from '../../../../packages/client/src/__tests__/fixtures/hono-sync-harness';
import {
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  createServerHandler,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
} from '../../../../packages/server/src';
import { syncConformance } from '../conformance/sync-conformance';
import {
  syncularGeneratedCodecs,
  syncularGeneratedSchemaVersion,
} from '../generated/typescript/syncular.generated';

const infoPath = process.env.SYNCULAR_NATIVE_HONO_INFO_PATH;
if (!infoPath) {
  throw new Error('SYNCULAR_NATIVE_HONO_INFO_PATH is required');
}

const conflict = syncConformance.conflictKeepLocal;
const e2ee = syncConformance.e2ee;
const schemaVersion = syncConformance.schemaVersion;
const blob = syncConformance.blob;
const futureSchemaVersion =
  syncularGeneratedSchemaVersion + schemaVersion.futureVersionOffset;
const nativeConflict = (rowId: string) => ({
  rowId,
  localTitle: conflict.localTitle,
  serverTitle: conflict.serverTitle,
  staleBaseVersion: conflict.staleBaseVersion,
  serverVersion: conflict.serverVersion,
  conflictCode: conflict.conflictCode,
  keepLocalResolution: 'keep-local',
  keepServerResolution: conflict.keepServerResolution,
  dismissResolution: conflict.dismissResolution,
  expectedInitialConflictCount: conflict.expectedInitialConflictCount,
  expectedAfterResolveConflictCount: conflict.expectedAfterResolveConflictCount,
  expectedAfterRetryConflictCount: conflict.expectedAfterRetryConflictCount,
});
const swiftConflict = nativeConflict(`${conflict.rowId}-swift`);
const swiftKeepServerConflict = nativeConflict(
  `${conflict.rowId}-swift-keep-server`
);
const swiftDismissConflict = nativeConflict(`${conflict.rowId}-swift-dismiss`);
const kotlinConflict = nativeConflict(`${conflict.rowId}-kotlin`);
const kotlinKeepServerConflict = nativeConflict(
  `${conflict.rowId}-kotlin-keep-server`
);
const kotlinDismissConflict = nativeConflict(
  `${conflict.rowId}-kotlin-dismiss`
);

const dialect = createSqliteServerDialect();
const db = createDatabase<HonoSyncServerDb>({
  dialect: createBunSqliteDialect({ path: ':memory:' }),
  family: 'sqlite',
});

await ensureSyncSchema(db, dialect);
await ensureBlobStorageSchemaSqlite(db);
await ensureHonoSyncTasksTable(db);
for (const task of [
  {
    id: 'native-server-task',
    title: 'Native server task',
    actorId: 'user-rust',
    projectId: null,
    serverVersion: 101,
  },
  {
    id: swiftConflict.rowId,
    title: swiftConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: swiftConflict.serverVersion,
  },
  {
    id: swiftKeepServerConflict.rowId,
    title: swiftKeepServerConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: swiftKeepServerConflict.serverVersion,
  },
  {
    id: swiftDismissConflict.rowId,
    title: swiftDismissConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: swiftDismissConflict.serverVersion,
  },
  {
    id: kotlinConflict.rowId,
    title: kotlinConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: kotlinConflict.serverVersion,
  },
  {
    id: kotlinKeepServerConflict.rowId,
    title: kotlinKeepServerConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: kotlinKeepServerConflict.serverVersion,
  },
  {
    id: kotlinDismissConflict.rowId,
    title: kotlinDismissConflict.serverTitle,
    actorId: 'user-rust',
    projectId: null,
    serverVersion: kotlinDismissConflict.serverVersion,
  },
] as const) {
  await db
    .insertInto('tasks')
    .values({
      id: task.id,
      title: task.title,
      description: null,
      completed: 0,
      user_id: task.actorId,
      project_id: task.projectId,
      server_version: task.serverVersion,
      image: null,
      title_yjs_state: null,
    })
    .execute();
}

const actorByToken = new Map([['Bearer user-rust', 'user-rust']]);
actorByToken.set('Bearer other-native', 'user-other-native');
const createTaskRoutes = (syncOverrides: Record<string, unknown> = {}) =>
  createSyncRoutes<HonoSyncServerDb, HonoAuthContext>({
    db,
    dialect,
    handlers: [
      createServerHandler<
        HonoSyncServerDb,
        HonoSyncClientDb,
        'tasks',
        HonoAuthContext
      >({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        codecs: syncularGeneratedCodecs,
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ],
    authenticate: async (c) => {
      const authorization = c.req.header('authorization');
      const actorId = authorization ? actorByToken.get(authorization) : null;
      return actorId ? { actorId } : null;
    },
    sync: {
      rateLimit: false,
      ...syncOverrides,
    },
  });

const routes = createTaskRoutes({
  websocket: {
    enabled: true,
    upgradeWebSocket,
    heartbeatIntervalMs: 0,
    allowedOrigins: '*',
  },
});
const requiredSchemaRoutes = createTaskRoutes({
  requiredSchemaVersion: futureSchemaVersion,
});
const latestSchemaRoutes = createTaskRoutes({
  latestSchemaVersion: futureSchemaVersion,
});

const connectionManager = getSyncWebSocketConnectionManager(routes);
if (!connectionManager) {
  throw new Error('Expected Hono sync websocket manager');
}

const app = new Hono()
  .route('/sync', routes)
  .route('/sync-required-schema', requiredSchemaRoutes)
  .route('/sync-latest-schema', latestSchemaRoutes);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
const baseUrl = `http://127.0.0.1:${server.port}/sync`;
const requiredSchemaBaseUrl = `http://127.0.0.1:${server.port}/sync-required-schema`;
const latestSchemaBaseUrl = `http://127.0.0.1:${server.port}/sync-latest-schema`;
const tokenSigner = createHmacTokenSigner('syncular-native-hono-blob-secret');
app.route(
  '/sync',
  createBlobRoutes({
    blobManager: createBlobManager({
      db,
      adapter: createDatabaseBlobStorageAdapter({
        db,
        baseUrl,
        tokenSigner,
      }),
    }),
    authenticate: async (c) => {
      const authorization = c.req.header('authorization');
      const actorId = authorization ? actorByToken.get(authorization) : null;
      return actorId ? { actorId } : null;
    },
    tokenSigner,
    db,
    canAccessBlob: async ({ actorId }) => actorId === 'user-rust',
  })
);

await writeFile(
  infoPath,
  JSON.stringify(
    {
      baseUrl,
      authorization: 'Bearer user-rust',
      staleAuthorization: 'Bearer stale-native',
      actorId: 'user-rust',
      revokedActorId: syncConformance.revokedSubscription.revokedActorId,
      projectId: null,
      websocketEnabled: true,
      task: {
        id: 'native-server-task',
        title: 'Native server task',
        serverVersion: 101,
      },
      schemaVersion: {
        requiredFutureBaseUrl: requiredSchemaBaseUrl,
        latestFutureBaseUrl: latestSchemaBaseUrl,
        expectedRequiredErrorPattern:
          schemaVersion.expectedRequiredErrorPattern,
      },
      ownerConflict: {
        secondActorId: 'user-other-native',
        secondAuthorization: 'Bearer other-native',
        expectedErrorPattern:
          syncConformance.ownerConflict.expectedErrorPattern,
      },
      conflicts: {
        swift: swiftConflict,
        swiftKeepServer: swiftKeepServerConflict,
        swiftDismiss: swiftDismissConflict,
        kotlin: kotlinConflict,
        kotlinKeepServer: kotlinKeepServerConflict,
        kotlinDismiss: kotlinDismissConflict,
      },
      e2ee: {
        keyBase64: e2ee.keyBase64,
        envelopePrefix: e2ee.envelopePrefix,
        rule: e2ee.rule,
        swiftTask: {
          id: `${e2ee.task.id}-swift-native`,
          title: e2ee.task.title,
          description: e2ee.task.description,
        },
        kotlinTask: {
          id: `${e2ee.task.id}-kotlin-native`,
          title: e2ee.task.title,
          description: e2ee.task.description,
        },
      },
      blob: {
        textMimeType: blob.textMimeType,
        authFailureText: blob.authFailureText,
        expectedProcessRetryableFailure: blob.expectedProcessRetryableFailure,
        expectedProcessPermanentFailure: blob.expectedProcessPermanentFailure,
        expectedUploadQueueBefore: blob.expectedUploadQueueBefore,
        expectedFailedQueue: blob.expectedFailedQueue,
        missingRef: {
          hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          size: 4,
          mimeType: 'application/octet-stream',
        },
      },
    },
    null,
    2
  )
);

let closed = false;
const close = async () => {
  if (closed) return;
  closed = true;
  server.stop(true);
  await db.destroy();
};

process.on('SIGINT', () => {
  void close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});

await new Promise(() => {});
