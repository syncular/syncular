/**
 * Simplified tasks client handler for runtime sync scenarios.
 */

import type { ClientTableHandler } from '@syncular/client';
import type { SyncChange, SyncSnapshot } from '@syncular/core';
import type { RuntimeClientDb } from './client-types';

type TaskRow = {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
};

export const tasksClientHandler: ClientTableHandler<RuntimeClientDb, 'tasks'> =
  {
    table: 'tasks',

    async onSnapshotStart(ctx): Promise<void> {
      await ctx.trx.deleteFrom('tasks').execute();
    },

    async applySnapshot(ctx, snapshot: SyncSnapshot): Promise<void> {
      const rows = (snapshot.rows ?? []) as TaskRow[];
      if (rows.length === 0) return;

      await ctx.trx
        .insertInto('tasks')
        .values(
          rows.map((r) => ({
            id: r.id,
            title: r.title,
            completed: r.completed,
            user_id: r.user_id,
            project_id: r.project_id,
            server_version: r.server_version ?? 0,
          }))
        )
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: (eb) => eb.ref('excluded.title'),
            completed: (eb) => eb.ref('excluded.completed'),
            user_id: (eb) => eb.ref('excluded.user_id'),
            project_id: (eb) => eb.ref('excluded.project_id'),
            server_version: (eb) => eb.ref('excluded.server_version'),
          })
        )
        .execute();
    },

    async clearAll(ctx): Promise<void> {
      await ctx.trx.deleteFrom('tasks').execute();
    },

    async applyChange(ctx, change: SyncChange): Promise<void> {
      if (change.op === 'delete') {
        await ctx.trx
          .deleteFrom('tasks')
          .where('id', '=', change.row_id)
          .execute();
        return;
      }

      const row = (change.row_json ?? {}) as Partial<TaskRow>;

      await ctx.trx
        .insertInto('tasks')
        .values({
          id: change.row_id,
          title: row.title ?? '',
          completed: row.completed ?? 0,
          user_id: row.user_id ?? '',
          project_id: row.project_id ?? '',
          server_version: change.row_version ?? row.server_version ?? 0,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: row.title ?? '',
            completed: row.completed ?? 0,
            user_id: row.user_id ?? '',
            project_id: row.project_id ?? '',
            server_version: change.row_version ?? row.server_version ?? 0,
          })
        )
        .execute();
    },
  };
