import { describe, expect, it } from 'bun:test';
import type { SyncOperation } from '@syncular/core';
import {
  createSyncularAppServerHandler,
  syncularGeneratedClientSchemaForVersion,
  syncularGeneratedAppTables,
  syncularGeneratedClientSchemaSupport,
  syncularGeneratedSnapshotBinaryColumnsForVersion,
  syncularGeneratedSnapshotBinaryEncoderForVersion,
  syncularGeneratedSchemaVersion,
} from '../../../rust/examples/todo-app/generated/typescript/syncular.server.generated';
import type {
  TaskMutationPayloadV6,
  TaskRowV6,
} from '../../../rust/examples/todo-app/generated/typescript/syncular.server.generated';
import type {
  ApplyOperationResult,
  ServerApplyOperationContext,
  ServerSnapshotContext,
  SyncCoreDb,
  SyncServerAuth,
} from './index';
import { SyncClientSchemaUnsupportedError } from './index';

interface DocumentsTable {
  id: string;
  content: string;
  done: number;
  owner_id: string;
  workspace_id: string | null;
  revision: number;
}

interface DivergentServerDb extends SyncCoreDb {
  documents: DocumentsTable;
}

interface TestAuth extends SyncServerAuth {
  workspaceIds: string[];
}

function createSnapshotContext(
  overrides: Partial<ServerSnapshotContext<DivergentServerDb, string, TestAuth>> =
    {}
): ServerSnapshotContext<DivergentServerDb, string, TestAuth> {
  const auth: TestAuth = {
    actorId: 'user-1',
    workspaceIds: ['project-1'],
  };
  return {
    db: {} as ServerSnapshotContext<DivergentServerDb, string, TestAuth>['db'],
    actorId: auth.actorId,
    auth,
    scopeValues: { user_id: 'user-1', project_id: 'project-1' },
    cursor: null,
    limit: 50,
    schemaVersion: syncularGeneratedSchemaVersion,
    ...overrides,
  };
}

function createApplyContext(
  overrides: Partial<ServerApplyOperationContext<DivergentServerDb, TestAuth>> =
    {}
): ServerApplyOperationContext<DivergentServerDb, TestAuth> {
  const auth: TestAuth = {
    actorId: 'user-1',
    workspaceIds: ['project-1'],
  };
  const db = {} as ServerApplyOperationContext<
    DivergentServerDb,
    TestAuth
  >['db'];
  return {
    db,
    trx: db,
    actorId: auth.actorId,
    auth,
    clientId: 'client-1',
    commitId: 'commit-1',
    schemaVersion: syncularGeneratedSchemaVersion,
    ...overrides,
  };
}

function createTaskOperation(
  overrides: Partial<SyncOperation> = {}
): SyncOperation {
  return {
    table: 'tasks',
    row_id: 'task-1',
    op: 'upsert',
    payload: {
      title: 'Client title',
      completed: 1,
      user_id: 'user-1',
      project_id: 'project-1',
    },
    base_version: 4,
    ...overrides,
  };
}

function appliedResult(
  opIndex: number,
  op: SyncOperation
): ApplyOperationResult {
  return {
    result: { opIndex, status: 'applied' },
    emittedChanges: [
      {
        table: op.table,
        row_id: op.row_id,
        op: op.op,
        row_json: op.payload,
        row_version: 5,
        scopes: {
          user_id: 'user-1',
          project_id: 'project-1',
        },
      },
    ],
  };
}

describe('generated app server handler', () => {
  it('delegates divergent server/client table mapping to app-owned snapshot and apply handlers', async () => {
    const translatedWrites: DocumentsTable[] = [];
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: syncularGeneratedAppTables.tasks,
      resolveScopes: (ctx) => ({
        user_id: [ctx.actorId],
        project_id: ctx.auth.workspaceIds,
      }),
      async snapshot(ctx) {
        expect(ctx.scopeValues).toEqual({
          user_id: 'user-1',
          project_id: 'project-1',
        });

        const serverRows: DocumentsTable[] = [
          {
            id: 'task-1',
            content: 'Server title',
            done: 0,
            owner_id: ctx.actorId,
            workspace_id: 'project-1',
            revision: 3,
          },
        ];

        return {
          rows: serverRows.map((row) => ({
            id: row.id,
            title: row.content,
            completed: row.done,
            user_id: row.owner_id,
            project_id: row.workspace_id,
            server_version: row.revision,
            image: null,
            title_yjs_state: null,
            description: null,
          })),
          nextCursor: null,
        };
      },
      async applyOperation(_ctx, op, opIndex) {
        translatedWrites.push({
          id: op.row_id,
          content: String(op.payload?.title),
          done: Number(op.payload?.completed),
          owner_id: String(op.payload?.user_id),
          workspace_id:
            op.payload?.project_id == null
              ? null
              : String(op.payload.project_id),
          revision: 5,
        });
        return appliedResult(opIndex, op);
      },
    });

    expect(handler.table).toBe('tasks');
    expect(handler.primaryKeyColumn).toBe('id');
    expect(handler.scopePatterns).toEqual(['{user_id}', '{project_id}']);
    expect(handler.snapshotBinaryColumns?.map((column) => column.name)).toEqual(
      [
        'id',
        'title',
        'completed',
        'user_id',
        'project_id',
        'server_version',
        'image',
        'title_yjs_state',
        'description',
      ]
    );
    expect(
      handler
        .snapshotBinaryColumnsForVersion?.(6)
        ?.map((column) => column.name)
    ).toEqual(
      syncularGeneratedSnapshotBinaryColumnsForVersion('tasks', 6)?.map(
        (column) => column.name
      )
    );
    expect(
      handler.snapshotBinaryEncoderForVersion?.(syncularGeneratedSchemaVersion)
    ).toBe(handler.snapshotBinaryEncoder);
    expect(handler.snapshotBinaryEncoderForVersion?.(6)).toBeNull();
    expect(
      syncularGeneratedSnapshotBinaryEncoderForVersion(
        'tasks',
        syncularGeneratedSchemaVersion
      )
    ).toBe(handler.snapshotBinaryEncoder);
    expect(
      handler.extractScopes({
        id: 'task-1',
        user_id: 'user-1',
        project_id: 'project-1',
      })
    ).toEqual({ user_id: 'user-1', project_id: 'project-1' });

    const snapshot = await handler.snapshot(createSnapshotContext(), undefined);
    expect(snapshot).toEqual({
      rows: [
        {
          id: 'task-1',
          title: 'Server title',
          completed: 0,
          user_id: 'user-1',
          project_id: 'project-1',
          server_version: 3,
          image: null,
          title_yjs_state: null,
          description: null,
        },
      ],
      nextCursor: null,
    });

    const result = await handler.applyOperation(
      createApplyContext(),
      createTaskOperation(),
      2
    );
    expect(result.result).toEqual({ opIndex: 2, status: 'applied' });
    expect(translatedWrites).toEqual([
      {
        id: 'task-1',
        content: 'Client title',
        done: 1,
        owner_id: 'user-1',
        workspace_id: 'project-1',
        revision: 5,
      },
    ]);
  });

  it('validates snapshot rows against the targeted generated client schema', async () => {
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        return {
          rows: [
            {
              id: 'task-bad',
              title: null,
              completed: 0,
              user_id: 'user-1',
              project_id: null,
              server_version: 1,
              image: null,
              title_yjs_state: null,
            },
          ],
          nextCursor: null,
        };
      },
      async applyOperation(_ctx, op, opIndex) {
        return appliedResult(opIndex, op);
      },
    });

    await expect(
      handler.snapshot(createSnapshotContext(), undefined)
    ).rejects.toThrow('tasks.title: Column cannot be null');
  });

  it('rejects unsupported client schema versions before custom snapshot code runs', async () => {
    let called = false;
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        called = true;
        return { rows: [], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        return appliedResult(opIndex, op);
      },
    });

    await expect(
      handler.snapshot(
        createSnapshotContext({
          schemaVersion: syncularGeneratedClientSchemaSupport.minSupported - 1,
        }),
        undefined
      )
    ).rejects.toThrow(SyncClientSchemaUnsupportedError);
    expect(called).toBe(false);
  });

  it('allows supported historical schema versions through snapshot validation', async () => {
    let seenSchemaVersion = 0;
    const legacyRow: TaskRowV6 = {
      id: 'task-v6',
      title: 'Legacy snapshot title',
      completed: 0,
      user_id: 'user-1',
      project_id: 'project-1',
      server_version: 6,
      image: null,
      title_yjs_state: null,
    };
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot(ctx) {
        seenSchemaVersion = ctx.schemaVersion;
        return { rows: [legacyRow], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        return appliedResult(opIndex, op);
      },
    });

    await expect(
      handler.snapshot(createSnapshotContext({ schemaVersion: 6 }), undefined)
    ).resolves.toEqual({ rows: [legacyRow], nextCursor: null });
    expect(seenSchemaVersion).toBe(6);
  });

  it('rejects unsupported client schema versions before custom apply code runs', async () => {
    let called = false;
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        return { rows: [], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        called = true;
        return appliedResult(opIndex, op);
      },
    });

    const result = await handler.applyOperation(
      createApplyContext({
        schemaVersion: syncularGeneratedClientSchemaSupport.minSupported - 1,
      }),
      createTaskOperation(),
      7
    );

    expect(called).toBe(false);
    expect(result).toEqual({
      result: expect.objectContaining({
        opIndex: 7,
        status: 'error',
        code: 'sync.client_schema_unsupported',
        retriable: false,
      }),
      emittedChanges: [],
    });
  });

  it('lets custom handlers branch with generated historical schema types', async () => {
    const legacySchema = syncularGeneratedClientSchemaForVersion(6);
    expect(legacySchema?.schemaVersion).toBe(6);
    expect(
      legacySchema?.tables
        .find((table) => table.name === 'tasks')
        ?.columns.map((column) => column.name)
    ).toContain('title');
    expect(
      legacySchema?.tables
        .find((table) => table.name === 'tasks')
        ?.columns.map((column) => column.name)
    ).not.toContain('description');

    const legacyPayload: TaskMutationPayloadV6 = {
      title: 'Legacy task title',
      completed: 0,
      user_id: 'user-1',
      project_id: 'project-1',
    };
    const legacyRow: TaskRowV6 = {
      id: 'task-v6',
      title: 'Legacy task title',
      completed: 0,
      user_id: 'user-1',
      project_id: 'project-1',
      server_version: 6,
      image: null,
      title_yjs_state: null,
    };
    let branch:
      | { schemaVersion: 6; payload: TaskMutationPayloadV6; row: TaskRowV6 }
      | { schemaVersion: number }
      | null = null;

    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        return { rows: [legacyRow], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        if (_ctx.schemaVersion === 6) {
          branch = {
            schemaVersion: 6,
            payload: op.payload as TaskMutationPayloadV6,
            row: legacyRow,
          };
        } else {
          branch = { schemaVersion: _ctx.schemaVersion };
        }
        return appliedResult(opIndex, op);
      },
    });

    const result = await handler.applyOperation(
      createApplyContext({ schemaVersion: 6 }),
      createTaskOperation({ row_id: 'task-v6', payload: legacyPayload }),
      8
    );

    expect(result.result).toEqual({ opIndex: 8, status: 'applied' });
    expect(branch).toEqual({
      schemaVersion: 6,
      payload: legacyPayload,
      row: legacyRow,
    });
  });

  it('rejects wrong tables and invalid mutation payloads before custom apply code runs', async () => {
    let callCount = 0;
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        return { rows: [], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        callCount += 1;
        return appliedResult(opIndex, op);
      },
    });

    const wrongTable = await handler.applyOperation(
      createApplyContext(),
      createTaskOperation({ table: 'projects' }),
      3
    );
    expect(wrongTable).toEqual({
      result: expect.objectContaining({
        opIndex: 3,
        status: 'error',
        code: 'sync.invalid_request',
      }),
      emittedChanges: [],
    });
    expect(
      wrongTable.result.status === 'error' ? wrongTable.result.error : ''
    ).toContain('Expected operation table tasks');

    const invalidPayload = await handler.applyOperation(
      createApplyContext(),
      createTaskOperation({ payload: { missing_column: true } }),
      4
    );
    expect(invalidPayload).toEqual({
      result: expect.objectContaining({
        opIndex: 4,
        status: 'error',
        code: 'sync.invalid_request',
      }),
      emittedChanges: [],
    });
    expect(
      invalidPayload.result.status === 'error' ? invalidPayload.result.error : ''
    ).toContain('tasks.missing_column: Unknown column');

    const missingUpsertPayload = await handler.applyOperation(
      createApplyContext(),
      createTaskOperation({ payload: null }),
      5
    );
    expect(missingUpsertPayload).toEqual({
      result: expect.objectContaining({
        opIndex: 5,
        status: 'error',
        code: 'sync.invalid_request',
      }),
      emittedChanges: [],
    });
    expect(
      missingUpsertPayload.result.status === 'error'
        ? missingUpsertPayload.result.error
        : ''
    ).toContain('tasks.payload: Upsert payload is required');

    const deleteWithPayload = await handler.applyOperation(
      createApplyContext(),
      createTaskOperation({
        op: 'delete',
        payload: { title: 'not allowed' },
      }),
      6
    );
    expect(deleteWithPayload).toEqual({
      result: expect.objectContaining({
        opIndex: 6,
        status: 'error',
        code: 'sync.invalid_request',
      }),
      emittedChanges: [],
    });
    expect(
      deleteWithPayload.result.status === 'error'
        ? deleteWithPayload.result.error
        : ''
    ).toContain('tasks.payload: Delete payload must be null');
    expect(callCount).toBe(0);
  });

  it('applies the same validation gate to generated batch handlers', async () => {
    let delegated: SyncOperation[] = [];
    const handler = createSyncularAppServerHandler<DivergentServerDb, TestAuth>({
      table: 'tasks',
      resolveScopes: () => ({ user_id: ['user-1'] }),
      async snapshot() {
        return { rows: [], nextCursor: null };
      },
      async applyOperation(_ctx, op, opIndex) {
        return appliedResult(opIndex, op);
      },
      async applyOperationBatch(_ctx, operations) {
        delegated = operations.map(({ op }) => op);
        return operations.map(({ op, opIndex }) => appliedResult(opIndex, op));
      },
    });

    const valid = await handler.applyOperationBatch?.(createApplyContext(), [
      { op: createTaskOperation({ row_id: 'task-a' }), opIndex: 0 },
      { op: createTaskOperation({ row_id: 'task-b' }), opIndex: 1 },
    ]);
    expect(valid?.map(({ result }) => result)).toEqual([
      { opIndex: 0, status: 'applied' },
      { opIndex: 1, status: 'applied' },
    ]);
    expect(delegated.map((op) => op.row_id)).toEqual(['task-a', 'task-b']);

    delegated = [];
    const invalid = await handler.applyOperationBatch?.(createApplyContext(), [
      { op: createTaskOperation({ row_id: 'task-a' }), opIndex: 0 },
      {
        op: createTaskOperation({
          row_id: 'task-b',
          payload: { unknown: true },
        }),
        opIndex: 1,
      },
    ]);

    expect(invalid).toEqual([
      {
        result: expect.objectContaining({
          opIndex: 1,
          status: 'error',
          code: 'sync.invalid_request',
        }),
        emittedChanges: [],
      },
    ]);
    expect(delegated).toEqual([]);
  });
});
