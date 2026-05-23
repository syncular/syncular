import {
  createSyncularAppServerHandler,
  syncularGeneratedApp,
  syncularGeneratedSchemaVersion,
  type TaskMutationPayloadV6,
  type TaskMutationPayloadV7,
  type TaskRow,
  type TaskRowV6,
  type TaskRowV7,
} from './generated/typescript/syncular.server.generated';
import type {
  ApplyOperationResult,
  ServerSnapshotContext,
  SyncCoreDb,
  SyncServerAuth,
} from '@syncular/server';

export interface TodoServerAuth extends SyncServerAuth {
  workspaceIds: string[];
}

export interface TodoDocumentsTable {
  id: string;
  content: string;
  done: number;
  owner_id: string;
  workspace_id: string | null;
  revision: number;
  image_ref: string | null;
  title_yjs_state: string | null;
  description: string | null;
}

export interface TodoServerDb extends SyncCoreDb {
  documents: TodoDocumentsTable;
}

export interface TodoTaskRepository {
  snapshotTasks(
    ctx: ServerSnapshotContext<TodoServerDb, string, TodoServerAuth>
  ): Promise<readonly TodoDocumentsTable[]>;
  upsertTask(args: {
    rowId: string;
    actorId: string;
    payload: TaskMutationPayloadForSchema;
    schemaVersion: number;
  }): Promise<TodoDocumentsTable>;
  deleteTask(args: {
    rowId: string;
    actorId: string;
  }): Promise<{ rowId: string; revision: number }>;
}

export type TaskMutationPayloadForSchema =
  | TaskMutationPayloadV6
  | TaskMutationPayloadV7
  | Partial<Omit<TaskRow, 'id' | 'server_version'>>;

export type TaskRowForSchema = TaskRow | TaskRowV6 | TaskRowV7;

export function createTodoTaskServerHandler(repo: TodoTaskRepository) {
  return createSyncularAppServerHandler<TodoServerDb, TodoServerAuth>({
    table: syncularGeneratedApp.tables.tasks,
    resolveScopes: (ctx) => ({
      user_id: [ctx.actorId],
      project_id: ctx.auth.workspaceIds,
    }),
    async snapshot(ctx) {
      const rows = await repo.snapshotTasks(ctx);
      return {
        rows: rows.map((row) =>
          projectTaskRowForSchema(
            documentToCurrentTaskRow(row),
            ctx.schemaVersion
          )
        ),
        nextCursor: null,
      };
    },
    async applyOperation(ctx, op, opIndex) {
      if (op.op === 'delete') {
        const deleted = await repo.deleteTask({
          rowId: op.row_id,
          actorId: ctx.actorId,
        });
        return {
          result: { opIndex, status: 'applied' },
          emittedChanges: [
            {
              table: 'tasks',
              row_id: deleted.rowId,
              op: 'delete',
              row_json: null,
              row_version: deleted.revision,
              scopes: { user_id: ctx.actorId },
            },
          ],
        };
      }

      const stored = await repo.upsertTask({
        rowId: op.row_id,
        actorId: ctx.actorId,
        payload: op.payload as TaskMutationPayloadForSchema,
        schemaVersion: ctx.schemaVersion,
      });
      const currentRow = documentToCurrentTaskRow(stored);
      return appliedTaskChange(opIndex, currentRow);
    },
  });
}

export function documentToCurrentTaskRow(row: TodoDocumentsTable): TaskRow {
  return {
    id: row.id,
    title: row.content,
    completed: row.done,
    user_id: row.owner_id,
    project_id: row.workspace_id,
    server_version: row.revision,
    image: row.image_ref == null ? null : JSON.parse(row.image_ref),
    title_yjs_state: row.title_yjs_state,
    description: row.description,
  };
}

export function projectTaskRowForSchema(
  row: TaskRow,
  schemaVersion: number
): TaskRowForSchema {
  return syncularGeneratedApp.projectClientRowForVersion(
    'tasks',
    row,
    schemaVersion
  ) as TaskRowForSchema;
}

function appliedTaskChange(
  opIndex: number,
  row: TaskRow
): ApplyOperationResult {
  return {
    result: { opIndex, status: 'applied' },
    emittedChanges: [
      {
        table: 'tasks',
        row_id: row.id,
        op: 'upsert',
        row_json: row,
        row_version: row.server_version,
        scopes: {
          user_id: row.user_id,
          ...(row.project_id == null ? {} : { project_id: row.project_id }),
        },
      },
    ],
  };
}

export const currentTodoClientSchemaVersion = syncularGeneratedSchemaVersion;
