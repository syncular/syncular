import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { defineMigrations } from '@syncular/migrations';
import {
  countByReadModel,
  defineSyncularClient,
  encryptedField,
  loadSyncularClientContract,
  scope,
  scaffoldSyncularClientContract,
  syncedTable,
  toSyncularCodegenConfig,
  toSyncularCodegenJson,
  writeSyncularCodegenJson,
  writeSyncularCodegenJsonFromModule,
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
      localOnlyTables: ['local_preferences'],
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
      localOnlyTables: ['local_preferences'],
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

  it('emits stable JSON for generated Rust-codegen handoff files', () => {
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

  it('writes the generated Rust-codegen handoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syncular-codegen-'));
    const output = join(dir, 'nested', 'generated', 'syncular.codegen.json');
    const app = defineSyncularClient({
      tables: {
        tasks: syncedTable({
          table: 'tasks',
          serverVersion: 'server_version',
          scopes: [scope('user_id', { source: 'actorId' })],
        }),
      },
    });

    try {
      await writeSyncularCodegenJson(app, output);
      expect(await readFile(output, 'utf8')).toBe(toSyncularCodegenJson(app));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and writes a codegen handoff from a typed app module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syncular-app-module-'));
    const modulePath = join(dir, 'syncular.app.ts');
    const outputPath = join(dir, 'generated', 'syncular.codegen.json');
    const appContractImport = pathToFileURL(
      join(process.cwd(), 'packages/typegen/src/app-contract.ts')
    ).href;
    await writeFile(
      modulePath,
      [
        `import { defineSyncularClient, scope, syncedTable } from ${JSON.stringify(appContractImport)};`,
        'export const app = defineSyncularClient({',
        '  tables: {',
        '    tasks: syncedTable({',
        "      table: 'tasks',",
        "      serverVersion: 'server_version',",
        "      scopes: [scope('user_id', { source: 'actorId', required: true })],",
        '    }),',
        '  },',
        '});',
      ].join('\n')
    );

    try {
      const contract = await loadSyncularClientContract({ modulePath });
      await writeSyncularCodegenJsonFromModule({ modulePath, outputPath });

      expect(contract.tables.tasks.table).toBe('tasks');
      expect(await readFile(outputPath, 'utf8')).toBe(
        toSyncularCodegenJson(contract)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scaffolds a same-shape client contract from migrations', async () => {
    const migrations = defineMigrations({
      v1: {
        async up(db) {
          await db.schema
            .createTable('tasks')
            .addColumn('id', 'text', (column) => column.primaryKey())
            .addColumn('title', 'text', (column) => column.notNull())
            .addColumn('user_id', 'text', (column) => column.notNull())
            .addColumn('server_version', 'integer', (column) =>
              column.notNull().defaultTo(0)
            )
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('tasks').execute();
        },
      },
    });

    const app = await scaffoldSyncularClientContract({
      migrations,
      scopes: {
        tasks: [scope('user_id', { source: 'actorId', required: true })],
      },
      sqliteWithoutRowid: true,
    });

    expect(toSyncularCodegenConfig(app)).toEqual({
      tables: {
        tasks: {
          subscriptionId: 'sub-tasks',
          serverVersionColumn: 'server_version',
          scopes: [
            {
              name: 'user_id',
              column: 'user_id',
              source: 'actorId',
              required: true,
            },
          ],
          sqliteWithoutRowid: true,
        },
      },
    });
  });
});
