import { describe, expect, it } from 'bun:test';
import type { SyncOperation } from '@syncular/core';
import {
  syncularGeneratedClientSchemaSupport,
  syncularGeneratedSchemaVersion,
} from './generated/typescript/syncular.server.generated';
import {
  createTodoTaskServerHandler,
  documentToCurrentTaskRow,
  projectTaskRowForSchema,
  type TodoDocumentsTable,
  type TodoServerAuth,
  type TodoServerDb,
  type TodoTaskRepository,
} from './server-handlers';
import type {
  ServerApplyOperationContext,
  ServerSnapshotContext,
} from '@syncular/server';

describe('todo app generated server handler example', () => {
  it('projects authoritative server rows to the requested client schema', async () => {
    const repo = createMemoryTodoTaskRepository([
      {
        id: 'task-1',
        content: 'Server title',
        done: 0,
        owner_id: 'user-1',
        workspace_id: 'project-1',
        revision: 8,
        image_ref: null,
        title_yjs_state: null,
        description: 'current-only description',
      },
    ]);
    const handler = createTodoTaskServerHandler(repo);
    const page = await handler.snapshot(
      snapshotContext({
        schemaVersion: syncularGeneratedClientSchemaSupport.minSupported,
      }),
      undefined
    );

    expect(handler.table).toBe('tasks');
    expect(page.rows).toEqual([
      {
        id: 'task-1',
        title: 'Server title',
        completed: 0,
        user_id: 'user-1',
        project_id: 'project-1',
        server_version: 8,
        image: null,
        title_yjs_state: null,
      },
    ]);
  });

  it('emits canonical current rows after app-owned server translation', async () => {
    const repo = createMemoryTodoTaskRepository([]);
    const handler = createTodoTaskServerHandler(repo);
    const result = await handler.applyOperation(
      applyContext(),
      taskOperation(),
      0
    );

    expect(result.result).toEqual({ opIndex: 0, status: 'applied' });
    expect(result.emittedChanges[0]?.row_json).toEqual({
      id: 'task-1',
      title: 'Client title',
      completed: 1,
      user_id: 'user-1',
      project_id: 'project-1',
      server_version: 1,
      image: null,
      title_yjs_state: null,
      description: 'current description',
    });
  });

  it('exposes standalone projection helpers for custom handler branches', () => {
    const current = documentToCurrentTaskRow({
      id: 'task-1',
      content: 'Server title',
      done: 0,
      owner_id: 'user-1',
      workspace_id: 'project-1',
      revision: 8,
      image_ref: null,
      title_yjs_state: null,
      description: 'current-only description',
    });

    expect(
      projectTaskRowForSchema(current, syncularGeneratedSchemaVersion)
    ).toEqual(current);
    expect(
      projectTaskRowForSchema(
        current,
        syncularGeneratedClientSchemaSupport.minSupported
      )
    ).not.toHaveProperty('description');
  });
});

function createMemoryTodoTaskRepository(
  seed: readonly TodoDocumentsTable[]
): TodoTaskRepository {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  return {
    async snapshotTasks(ctx) {
      return [...rows.values()].filter(
        (row) =>
          row.owner_id === ctx.actorId &&
          (row.workspace_id == null ||
            ctx.auth.workspaceIds.includes(row.workspace_id))
      );
    },
    async upsertTask(args) {
      const payload = args.payload;
      const existing = rows.get(args.rowId);
      const row: TodoDocumentsTable = {
        id: args.rowId,
        content: String(payload.title ?? existing?.content ?? ''),
        done: Number(payload.completed ?? existing?.done ?? 0),
        owner_id: String(payload.user_id ?? existing?.owner_id ?? args.actorId),
        workspace_id:
          payload.project_id === undefined
            ? existing?.workspace_id ?? null
            : payload.project_id == null
              ? null
              : String(payload.project_id),
        revision: (existing?.revision ?? 0) + 1,
        image_ref: existing?.image_ref ?? null,
        title_yjs_state:
          typeof payload.title_yjs_state === 'string'
            ? payload.title_yjs_state
            : existing?.title_yjs_state ?? null,
        description:
          'description' in payload
            ? payload.description == null
              ? null
              : String(payload.description)
            : existing?.description ?? null,
      };
      rows.set(row.id, row);
      return row;
    },
    async deleteTask(args) {
      const existing = rows.get(args.rowId);
      rows.delete(args.rowId);
      return {
        rowId: args.rowId,
        revision: (existing?.revision ?? 0) + 1,
      };
    },
  };
}

function snapshotContext(
  overrides: Partial<ServerSnapshotContext<TodoServerDb, string, TodoServerAuth>> =
    {}
): ServerSnapshotContext<TodoServerDb, string, TodoServerAuth> {
  const auth: TodoServerAuth = {
    actorId: 'user-1',
    workspaceIds: ['project-1'],
  };
  return {
    db: {} as ServerSnapshotContext<TodoServerDb, string, TodoServerAuth>['db'],
    actorId: auth.actorId,
    auth,
    scopeValues: { user_id: 'user-1', project_id: 'project-1' },
    cursor: null,
    limit: 50,
    schemaVersion: syncularGeneratedSchemaVersion,
    ...overrides,
  };
}

function applyContext(
  overrides: Partial<ServerApplyOperationContext<TodoServerDb, TodoServerAuth>> =
    {}
): ServerApplyOperationContext<TodoServerDb, TodoServerAuth> {
  const auth: TodoServerAuth = {
    actorId: 'user-1',
    workspaceIds: ['project-1'],
  };
  const db = {} as ServerApplyOperationContext<
    TodoServerDb,
    TodoServerAuth
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

function taskOperation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    table: 'tasks',
    row_id: 'task-1',
    op: 'upsert',
    payload: {
      title: 'Client title',
      completed: 1,
      user_id: 'user-1',
      project_id: 'project-1',
      description: 'current description',
    },
    base_version: null,
    ...overrides,
  };
}
