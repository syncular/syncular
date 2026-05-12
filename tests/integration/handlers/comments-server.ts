import type { SyncOperation } from '@syncular/core';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerTableHandler,
  SyncCoreDb,
} from '@syncular/server';
import { sql } from 'kysely';

type CommentSnapshotRow = {
  id: string;
  task_id: string;
  project_id: string;
  body: string;
  author_id: string;
  deleted: number;
  server_version: number;
};

type CommentsTable = CommentSnapshotRow;

export function createCommentsServerShape<
  DB extends SyncCoreDb & { comments: CommentsTable },
>(): ServerTableHandler<DB> {
  return {
    table: 'comments',
    scopePatterns: ['user:{user_id}:project:{project_id}'],

    async resolveScopes(ctx) {
      return {
        user_id: ctx.actorId,
        project_id: Array.from({ length: 100 }, (_, i) => `p${i}`),
      };
    },

    extractScopes(row) {
      return {
        user_id: String(row.author_id ?? ''),
        project_id: String(row.project_id ?? ''),
      };
    },

    async snapshot(ctx) {
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
      const cursorFilter =
        ctx.cursor && ctx.cursor.length > 0
          ? sql`and ${sql.ref('id')} > ${sql.val(ctx.cursor)}`
          : sql``;

      const result = await sql<CommentSnapshotRow>`
        select id, task_id, project_id, body, author_id, deleted, server_version
        from comments
        where author_id = ${sql.val(userId)}
          and project_id = ${sql.val(projectId)}
        ${cursorFilter}
        order by id asc
        limit ${sql.val(pageSize + 1)}
      `.execute(ctx.db);

      const hasMore = result.rows.length > pageSize;
      const pageRows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
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
      if (op.table !== 'comments') {
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
          select id, project_id from comments
          where id = ${sql.val(op.row_id)}
            and author_id = ${sql.val(ctx.actorId)}
          limit 1
        `.execute(ctx.trx);
        const existing = existingResult.rows[0];

        if (!existing) {
          return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
        }

        await sql`
          delete from comments
          where id = ${sql.val(op.row_id)}
            and author_id = ${sql.val(ctx.actorId)}
        `.execute(ctx.trx);

        return {
          result: { opIndex, status: 'applied' },
          emittedChanges: [
            {
              table: 'comments',
              row_id: op.row_id,
              op: 'delete',
              row_json: null,
              row_version: null,
              scopes: { user_id: ctx.actorId, project_id: existing.project_id },
            },
          ],
        };
      }

      const payload = (op.payload ?? {}) as {
        task_id?: string;
        project_id?: string;
        body?: string;
        deleted?: number;
      };
      const existingResult = await sql<{
        id: string;
        task_id: string;
        project_id: string;
        body: string;
        deleted: number;
        server_version: number;
      }>`
        select id, task_id, project_id, body, deleted, server_version
        from comments
        where id = ${sql.val(op.row_id)}
          and author_id = ${sql.val(ctx.actorId)}
        limit 1
      `.execute(ctx.trx);
      const existing = existingResult.rows[0];
      const projectId = payload.project_id ?? existing?.project_id;
      const taskId = payload.task_id ?? existing?.task_id;

      if (!projectId || !taskId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'MISSING_COMMENT_SCOPE',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      if (existing) {
        const nextVersion = existing.server_version + 1;
        await sql`
          update comments set
            body = ${sql.val(payload.body ?? existing.body)},
            deleted = ${sql.val(payload.deleted ?? existing.deleted)},
            server_version = ${sql.val(nextVersion)}
          where id = ${sql.val(op.row_id)}
            and author_id = ${sql.val(ctx.actorId)}
        `.execute(ctx.trx);
      } else {
        await sql`
          insert into comments (
            id, task_id, project_id, body, author_id, deleted, server_version
          ) values (
            ${sql.val(op.row_id)},
            ${sql.val(taskId)},
            ${sql.val(projectId)},
            ${sql.val(payload.body ?? '')},
            ${sql.val(ctx.actorId)},
            ${sql.val(payload.deleted ?? 0)},
            1
          )
        `.execute(ctx.trx);
      }

      const updatedResult = await sql<CommentSnapshotRow>`
        select id, task_id, project_id, body, author_id, deleted, server_version
        from comments
        where id = ${sql.val(op.row_id)}
          and author_id = ${sql.val(ctx.actorId)}
        limit 1
      `.execute(ctx.trx);
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new Error('COMMENTS_ROW_NOT_FOUND');
      }

      const emitted: EmittedChange = {
        table: 'comments',
        row_id: op.row_id,
        op: 'upsert',
        row_json: updated,
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
