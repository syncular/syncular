import { describe, expect, it } from 'bun:test';
import {
  countByReadModel,
  defineSyncularClient,
  encryptedField,
  scope,
  syncedTable,
  toSyncularCodegenConfig,
  toSyncularCodegenJson,
  yjsText,
} from './app-contract';

describe('Syncular app contract authoring', () => {
  it('serializes typed table metadata to the low-level codegen config shape', () => {
    const app = defineSyncularClient({
      typescriptOutputPath: 'generated/typescript/syncular.generated.ts',
      typescriptServerOutputPath:
        'generated/typescript/syncular.server.generated.ts',
      typescriptRuntimeImportPath: '@syncular/client',
      clientSchemaSupport: { minSupported: 5, supported: [5, 6, 7] },
      tables: {
        tasks: syncedTable({
          table: 'tasks',
          subscriptionId: 'sub-tasks',
          subscriptionParams: { includeArchived: false },
          serverVersion: 'server_version',
          scopes: [
            scope('user_id', { column: 'owner_id', source: 'actorId' }),
            scope('project_id', {
              source: 'projectId',
              required: false,
            }),
          ],
          blobColumns: ['image'],
          crdt: {
            title: yjsText({ stateColumn: 'title_yjs_state' }),
          },
          encryptedFields: [encryptedField('title', { scope: 'tasks' })],
          softDelete: 'deleted',
          sqliteWithoutRowid: true,
        }),
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
    });

    expect(app.tables.tasks.table).toBe('tasks');
    expect(toSyncularCodegenConfig(app)).toEqual({
      typescriptOutputPath: 'generated/typescript/syncular.generated.ts',
      typescriptServerOutputPath:
        'generated/typescript/syncular.server.generated.ts',
      typescriptRuntimeImportPath: '@syncular/client',
      clientSchemaSupport: { minSupported: 5, supported: [5, 6, 7] },
      localReadModels: [
        {
          name: 'taskCountsByUserCompletion',
          kind: 'countBy',
          sourceTable: 'tasks',
          outputTable: 'syncular_task_counts',
          dimensions: ['user_id', 'completed'],
          countColumn: 'task_count',
        },
      ],
      tables: {
        tasks: {
          subscriptionId: 'sub-tasks',
          subscriptionParams: { includeArchived: false },
          serverVersionColumn: 'server_version',
          scopes: [
            {
              name: 'user_id',
              column: 'owner_id',
              source: 'actorId',
            },
            {
              name: 'project_id',
              column: 'project_id',
              source: 'projectId',
              required: false,
            },
          ],
          blobColumns: ['image'],
          crdtYjsFields: [
            {
              field: 'title',
              stateColumn: 'title_yjs_state',
              kind: 'text',
            },
          ],
          encryptedFields: [{ field: 'title', scope: 'tasks' }],
          softDeleteColumn: 'deleted',
          sqliteWithoutRowid: true,
        },
      },
    });
  });

  it('emits stable JSON for generated syncular.codegen.json files', () => {
    const app = defineSyncularClient({
      tables: {
        projects: syncedTable({
          table: 'projects',
          serverVersion: 'server_version',
          scopes: [scope('user_id', { column: 'owner_id', source: 'actorId' })],
        }),
      },
    });

    expect(toSyncularCodegenJson(app)).toBe(
      '{\n' +
        '  "tables": {\n' +
        '    "projects": {\n' +
        '      "serverVersionColumn": "server_version",\n' +
        '      "scopes": [\n' +
        '        {\n' +
        '          "name": "user_id",\n' +
        '          "column": "owner_id",\n' +
        '          "source": "actorId"\n' +
        '        }\n' +
        '      ]\n' +
        '    }\n' +
        '  }\n' +
        '}\n'
    );
  });
});
