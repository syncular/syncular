/**
 * Server-side tasks table handler for integration tests
 */

import type { SyncOperation } from '@syncular/core';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerTableHandler,
  SyncCoreDb,
} from '@syncular/server';
import { sql } from 'kysely';
import type { ServerDb } from './db-types';

type TaskSnapshotRow = {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
};

type TasksTable = TaskSnapshotRow;

export function createTasksServerShape<
  DB extends SyncCoreDb & { tasks: TasksTable },
>(): ServerTableHandler<DB> {
  return {
    table: 'tasks',
    scopePatterns: ['user:{user_id}:project:{project_id}'],

    async resolveScopes(ctx) {
      return {
        user_id: ctx.actorId,
        project_id: Array.from({ length: 100 }, (_, i) => `p${i}`),
      };
    },

    extractScopes(row: Record<string, unknown>) {
      return {
        user_id: String(row.user_id ?? ''),
        project_id: String(row.project_id ?? ''),
      };
    },

    async snapshot(
      ctx
    ): Promise<{ rows: unknown[]; nextCursor: string | null }> {
      const userIdValue = ctx.scopeValues.user_id;
      const projectIdValue = ctx.scopeValues.project_id;
      const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;
      const projectId = Array.isArray(projectIdValue)
        ? projectIdValue[0]
        : projectIdValue;

      if (!userId || userId !== ctx.actorId)
        return { rows: [], nextCursor: null };
      if (!projectId) return { rows: [], nextCursor: null };

      const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
      const cursor = ctx.cursor;

      const cursorFilter =
        cursor && cursor.length > 0
          ? sql`and ${sql.ref('id')} > ${sql.val(cursor)}`
          : sql``;

      const result = await sql<TaskSnapshotRow>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('project_id')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('user_id')} = ${sql.val(userId)}
        and ${sql.ref('project_id')} = ${sql.val(projectId)}
      ${cursorFilter}
      order by ${sql.ref('id')} asc
      limit ${sql.val(pageSize + 1)}
    `.execute(ctx.db);

      const rows = result.rows;
      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
      const nextCursor = hasMore
        ? (pageRows[pageRows.length - 1]?.id ?? null)
        : null;

      return {
        rows: pageRows,
        nextCursor:
          typeof nextCursor === 'string' && nextCursor.length > 0
            ? nextCursor
            : null,
      };
    },

    async applyOperation(
      ctx,
      op: SyncOperation,
      opIndex: number
    ): Promise<ApplyOperationResult> {
      if (op.table !== 'tasks') {
        return {
          result: {
            opIndex,
            status: 'error',
            error: `UNKNOWN_TABLE:${op.table}`,
            code: 'UNKNOWN_TABLE',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      if (op.op === 'delete') {
        const existingResult = await sql<{ id: string; project_id: string }>`
        select ${sql.ref('id')}, ${sql.ref('project_id')}
        from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
        limit ${sql.val(1)}
      `.execute(ctx.trx);
        const existing = existingResult.rows[0];

        if (!existing) {
          return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
        }

        await sql`
        delete from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      `.execute(ctx.trx);

        const emitted: EmittedChange = {
          table: 'tasks',
          row_id: op.row_id,
          op: 'delete',
          row_json: null,
          row_version: null,
          scopes: { user_id: ctx.actorId, project_id: existing.project_id },
        };

        return {
          result: { opIndex, status: 'applied' },
          emittedChanges: [emitted],
        };
      }

      const payload = (op.payload ?? {}) as {
        title?: string;
        completed?: number;
        project_id?: string;
      };

      const existingResult = await sql<{
        id: string;
        title: string;
        completed: number;
        project_id: string;
        server_version: number;
      }>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('project_id')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
        and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
      const existing = existingResult.rows[0];

      if (
        existing &&
        op.base_version != null &&
        existing.server_version !== op.base_version
      ) {
        return {
          result: {
            opIndex,
            status: 'conflict',
            message: `Version conflict: server=${existing.server_version}, base=${op.base_version}`,
            server_version: existing.server_version,
            server_row: {
              id: existing.id,
              title: existing.title,
              completed: existing.completed,
              user_id: ctx.actorId,
              project_id: existing.project_id,
              server_version: existing.server_version,
            },
          },
          emittedChanges: [],
        };
      }

      const projectId = payload.project_id ?? existing?.project_id;
      if (!projectId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'MISSING_PROJECT_ID',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      if (existing) {
        if (payload.project_id && payload.project_id !== existing.project_id) {
          return {
            result: {
              opIndex,
              status: 'error',
              error: 'CANNOT_MOVE_BETWEEN_PROJECTS',
              code: 'INVALID_REQUEST',
              retriable: false,
            },
            emittedChanges: [],
          };
        }

        const nextVersion = existing.server_version + 1;
        await sql`
        update ${sql.table('tasks')}
        set
          ${sql.ref('title')} = ${sql.val(payload.title ?? existing.title)},
          ${sql.ref('completed')} = ${sql.val(
            payload.completed ?? existing.completed
          )},
          ${sql.ref('server_version')} = ${sql.val(nextVersion)}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      `.execute(ctx.trx);
      } else {
        await sql`
        insert into ${sql.table('tasks')} (
          ${sql.ref('id')},
          ${sql.ref('title')},
          ${sql.ref('completed')},
          ${sql.ref('user_id')},
          ${sql.ref('project_id')},
          ${sql.ref('server_version')}
        ) values (
          ${sql.val(op.row_id)},
          ${sql.val(payload.title ?? '')},
          ${sql.val(payload.completed ?? 0)},
          ${sql.val(ctx.actorId)},
          ${sql.val(projectId)},
          ${sql.val(1)}
        )
      `.execute(ctx.trx);
      }

      const updatedResult = await sql<TaskSnapshotRow>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('project_id')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
        and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
      const updated = updatedResult.rows[0];
      if (!updated) throw new Error('TASKS_ROW_NOT_FOUND');

      const emitted: EmittedChange = {
        table: 'tasks',
        row_id: op.row_id,
        op: 'upsert',
        row_json: {
          id: updated.id,
          title: updated.title,
          completed: updated.completed,
          user_id: updated.user_id,
          project_id: updated.project_id,
          server_version: updated.server_version,
        },
        row_version: updated.server_version,
        scopes: { user_id: ctx.actorId, project_id: updated.project_id },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    },
  };
}

export const tasksServerShape = createTasksServerShape<ServerDb>();
