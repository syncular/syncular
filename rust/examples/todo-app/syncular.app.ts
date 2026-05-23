import {
  countByReadModel,
  defineSyncularClient,
  scope,
  syncedTable,
  toSyncularCodegenConfig,
  yjsText,
} from '@syncular/typegen';

export const app = defineSyncularClient({
  typescriptOutputPath: 'generated/typescript/syncular.generated.ts',
  typescriptServerOutputPath:
    'generated/typescript/syncular.server.generated.ts',
  typescriptRuntimeImportPath: '../../../../../packages/client/src',
  nativeSwiftOutputPath: 'generated/swift/SyncularApp.swift',
  nativeKotlinOutputPath: 'generated/kotlin/SyncularApp.kt',
  nativeAndroidKotlinOutputPath: 'generated/kotlin/android/SyncularApp.kt',
  nativeAndroidKotlinPackage: 'dev.syncular.client.generated',
  clientSchemaSupport: {
    minSupported: 6,
  },
  localReadModels: [
    countByReadModel({
      name: 'taskCountsByUserCompletion',
      sourceTable: 'tasks',
      outputTable: 'syncular_task_counts',
      dimensions: ['user_id', 'completed'],
      countColumn: 'task_count',
    }),
  ],
  tables: {
    projects: syncedTable({
      table: 'projects',
      subscriptionId: 'sub-projects',
      scopes: [
        scope('user_id', {
          column: 'owner_id',
          source: 'actorId',
          required: true,
        }),
      ],
      serverVersion: 'server_version',
      sqliteWithoutRowid: true,
    }),
    tasks: syncedTable({
      table: 'tasks',
      subscriptionId: 'sub-tasks',
      scopes: [
        scope('user_id', {
          source: 'actorId',
          required: true,
        }),
        scope('project_id', {
          source: 'projectId',
          required: false,
        }),
      ],
      serverVersion: 'server_version',
      sqliteWithoutRowid: true,
      blobColumns: ['image'],
      crdt: {
        title: yjsText({
          stateColumn: 'title_yjs_state',
          containerKey: 'title',
        }),
      },
    }),
    comments: syncedTable({
      table: 'comments',
      subscriptionId: 'sub-comments',
      scopes: [
        scope('user_id', {
          column: 'author_id',
          source: 'actorId',
          required: true,
        }),
        scope('project_id', {
          source: 'projectId',
          required: false,
        }),
      ],
      serverVersion: 'server_version',
      softDelete: 'deleted',
      sqliteWithoutRowid: true,
    }),
  },
});

export const syncularCodegenConfig = toSyncularCodegenConfig(app);
