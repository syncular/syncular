/**
 * @syncular/demo - Server-side shared_tasks table handler
 *
 * Scope: share:{share_id}
 *
 * Notes:
 * - This demo handler enforces "owner-only writes": only `owner_id` may upsert/delete.
 * - It's intended to demonstrate E2EE key sharing, not access control complexity.
 */

import type { EmittedChange } from '@syncular/server';
import { createServerHandler } from '@syncular/server';
import { sql } from 'kysely';
import type { ClientDb } from '../../client/types.generated';
import type { ServerDb } from '../db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const sharedTasksServerHandler = createServerHandler<
  ServerDb,
  ClientDb,
  'shared_tasks'
>({
  table: 'shared_tasks',
  scopes: ['share:{share_id}'],
  resolveScopes: async () => ({
    // Any authenticated actor can access shared tasks they have share_id for
    // In production, this would filter based on actual share memberships
    share_id: '*',
  }),
  // Custom applyOperation for owner-only writes
  applyOperation: async (ctx, op, opIndex) => {
    if (op.table !== 'shared_tasks') {
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

    // Handle delete
    if (op.op === 'delete') {
      const existingResult = await sql<{
        id: string;
        share_id: string;
        owner_id: string;
      }>`
        select ${sql.ref('id')}, ${sql.ref('share_id')}, ${sql.ref('owner_id')}
        from ${sql.table('shared_tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
        limit ${sql.val(1)}
      `.execute(ctx.trx);
      const existing = existingResult.rows[0];

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      // Owner-only delete
      if (existing.owner_id !== ctx.actorId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'FORBIDDEN',
            code: 'FORBIDDEN',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      await sql`
        delete from ${sql.table('shared_tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);

      const emitted: EmittedChange = {
        table: 'shared_tasks',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { share_id: existing.share_id },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    // Handle upsert
    const payload = isRecord(op.payload) ? op.payload : {};
    const payloadTitle =
      typeof payload.title === 'string' ? payload.title : undefined;
    const payloadCompleted =
      typeof payload.completed === 'number' ? payload.completed : undefined;
    const payloadShareId =
      typeof payload.share_id === 'string' ? payload.share_id : undefined;

    const existingResult = await sql<{
      id: string;
      share_id: string;
      title: string;
      completed: number;
      owner_id: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('share_id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('owner_id')},
        ${sql.ref('server_version')}
      from ${sql.table('shared_tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const existing = existingResult.rows[0];

    // Version conflict check
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
          server_row: existing,
        },
        emittedChanges: [],
      };
    }

    const shareId = payloadShareId ?? existing?.share_id;
    if (!shareId) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: 'MISSING_SHARE_ID',
          code: 'INVALID_REQUEST',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (existing) {
      // Owner-only update
      if (existing.owner_id !== ctx.actorId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'FORBIDDEN',
            code: 'FORBIDDEN',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      // Cannot move between shares
      if (payloadShareId && payloadShareId !== existing.share_id) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'CANNOT_MOVE_BETWEEN_SHARES',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      await sql`
        update ${sql.table('shared_tasks')}
        set
          ${sql.ref('title')} = ${sql.val(payloadTitle ?? existing.title)},
          ${sql.ref('completed')} = ${sql.val(payloadCompleted ?? existing.completed)},
          ${sql.ref('server_version')} = ${sql.val(existing.server_version + 1)}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);
    } else {
      // Insert - set owner_id to actorId
      await sql`
        insert into ${sql.table('shared_tasks')} (
          ${sql.join([
            sql.ref('id'),
            sql.ref('share_id'),
            sql.ref('title'),
            sql.ref('completed'),
            sql.ref('owner_id'),
            sql.ref('server_version'),
          ])}
        ) values (
          ${sql.join([
            sql.val(op.row_id),
            sql.val(shareId),
            sql.val(payloadTitle ?? ''),
            sql.val(payloadCompleted ?? 0),
            sql.val(ctx.actorId),
            sql.val(1),
          ])}
        )
      `.execute(ctx.trx);
    }

    const updatedResult = await sql<{
      id: string;
      share_id: string;
      title: string;
      completed: number;
      owner_id: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('share_id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('owner_id')},
        ${sql.ref('server_version')}
      from ${sql.table('shared_tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const updated = updatedResult.rows[0];
    if (!updated) throw new Error(`Missing shared_task row: ${op.row_id}`);

    const emitted: EmittedChange = {
      table: 'shared_tasks',
      row_id: op.row_id,
      op: 'upsert',
      row_json: updated,
      row_version: updated.server_version ?? 1,
      scopes: { share_id: updated.share_id },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
});
