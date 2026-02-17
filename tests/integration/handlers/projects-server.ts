/**
 * Server-side projects table handler for integration tests
 */

import type { SyncOperation } from '@syncular/core';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerTableHandler,
} from '@syncular/server';
import type { ServerDb } from './db-types';

type ProjectSnapshotRow = {
  id: string;
  name: string;
  owner_id: string;
  server_version: number;
};

export const projectsServerShape: ServerTableHandler<ServerDb> = {
  table: 'projects',
  scopePatterns: ['user:{user_id}:project:{project_id}'],

  async resolveScopes(ctx) {
    return {
      user_id: ctx.actorId,
      project_id: Array.from({ length: 100 }, (_, i) => `p${i}`),
    };
  },

  extractScopes(row: Record<string, unknown>) {
    return {
      user_id: String(row.owner_id ?? ''),
      project_id: String(row.id ?? ''),
    };
  },

  async snapshot(ctx): Promise<{ rows: unknown[]; nextCursor: string | null }> {
    const userIdValue = ctx.scopeValues.user_id;
    const projectIdValue = ctx.scopeValues.project_id;
    const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;
    const projectId = Array.isArray(projectIdValue)
      ? projectIdValue[0]
      : projectIdValue;

    if (!userId || userId !== ctx.actorId)
      return { rows: [], nextCursor: null };
    if (!projectId) return { rows: [], nextCursor: null };

    const query = ctx.db
      .selectFrom('projects')
      .select(['id', 'name', 'owner_id', 'server_version'])
      .where('owner_id', '=', userId)
      .where('id', '=', projectId);

    const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
    const cursor = ctx.cursor;

    const rows = await (cursor ? query.where('id', '>', cursor) : query)
      .orderBy('id', 'asc')
      .limit(pageSize + 1)
      .execute();

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
    if (op.table !== 'projects') {
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
      const existing = await ctx.trx
        .selectFrom('projects')
        .select(['id'])
        .where('id', '=', op.row_id)
        .where('owner_id', '=', ctx.actorId)
        .executeTakeFirst();

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      const taskCount = await ctx.trx
        .selectFrom('tasks')
        .select((eb) => eb.fn.count<number>('id').as('c'))
        .where('project_id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .executeTakeFirst();

      if (taskCount && Number(taskCount.c) > 0) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'CANNOT_DELETE_PROJECT_WITH_TASKS',
            code: 'CONSTRAINT_VIOLATION',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      await ctx.trx
        .deleteFrom('projects')
        .where('id', '=', op.row_id)
        .where('owner_id', '=', ctx.actorId)
        .execute();

      const emitted: EmittedChange = {
        table: 'projects',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { user_id: ctx.actorId, project_id: op.row_id },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    const payload = (op.payload ?? {}) as { name?: string };

    const existing = await ctx.trx
      .selectFrom('projects')
      .select(['id', 'name', 'server_version'])
      .where('id', '=', op.row_id)
      .where('owner_id', '=', ctx.actorId)
      .executeTakeFirst();

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
            name: existing.name,
            owner_id: ctx.actorId,
            server_version: existing.server_version,
          },
        },
        emittedChanges: [],
      };
    }

    if (existing) {
      const nextVersion = existing.server_version + 1;
      await ctx.trx
        .updateTable('projects')
        .set({
          name: payload.name ?? existing.name,
          server_version: nextVersion,
        })
        .where('id', '=', op.row_id)
        .where('owner_id', '=', ctx.actorId)
        .execute();
    } else {
      await ctx.trx
        .insertInto('projects')
        .values({
          id: op.row_id,
          name: payload.name ?? '',
          owner_id: ctx.actorId,
          server_version: 1,
        })
        .execute();
    }

    const updated = await ctx.trx
      .selectFrom('projects')
      .select(['id', 'name', 'owner_id', 'server_version'])
      .where('id', '=', op.row_id)
      .where('owner_id', '=', ctx.actorId)
      .executeTakeFirstOrThrow();

    const rowJson: ProjectSnapshotRow = {
      id: updated.id,
      name: updated.name,
      owner_id: updated.owner_id,
      server_version: updated.server_version,
    };

    const emitted: EmittedChange = {
      table: 'projects',
      row_id: op.row_id,
      op: 'upsert',
      row_json: rowJson,
      row_version: updated.server_version,
      scopes: { user_id: ctx.actorId, project_id: updated.id },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
};
