/**
 * Client-side tasks table handler for integration tests
 */

import type { ClientTableHandler } from '@syncular/client';
import type { SyncChange, SyncSnapshot } from '@syncular/core';
import type { ClientDb } from './db-types';

type TaskRow = {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
};

export const tasksClientHandler: ClientTableHandler<ClientDb, 'tasks'> = {
  table: 'tasks',

  async onSnapshotStart(ctx): Promise<void> {
    const d = ctx.trx;
    const userId = ctx.scopes.user_id;
    const projectId = ctx.scopes.project_id;

    let query = d.deleteFrom('tasks');

    if (userId) {
      const userIds = Array.isArray(userId) ? userId : [userId];
      if (userIds.length === 1) {
        query = query.where('user_id', '=', userIds[0]!);
      } else {
        query = query.where('user_id', 'in', userIds);
      }
    }

    if (projectId) {
      const projectIds = Array.isArray(projectId) ? projectId : [projectId];
      if (projectIds.length === 1) {
        query = query.where('project_id', '=', projectIds[0]!);
      } else {
        query = query.where('project_id', 'in', projectIds);
      }
    }

    await query.execute();
  },

  async applySnapshot(ctx, snapshot: SyncSnapshot): Promise<void> {
    const d = ctx.trx;
    const parsedRows = (snapshot.rows ?? []) as TaskRow[];
    if (parsedRows.length === 0) return;

    await d
      .insertInto('tasks')
      .values(
        parsedRows.map((r) => ({
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
    const d = ctx.trx;
    const userId = ctx.scopes?.user_id;
    const projectId = ctx.scopes?.project_id;

    let query = d.deleteFrom('tasks');

    if (userId) {
      const userIds = Array.isArray(userId) ? userId : [userId];
      if (userIds.length === 1) {
        query = query.where('user_id', '=', userIds[0]!);
      } else {
        query = query.where('user_id', 'in', userIds);
      }
    }

    if (projectId) {
      const projectIds = Array.isArray(projectId) ? projectId : [projectId];
      if (projectIds.length === 1) {
        query = query.where('project_id', '=', projectIds[0]!);
      } else {
        query = query.where('project_id', 'in', projectIds);
      }
    }

    await query.execute();
  },

  async applyChange(ctx, change: SyncChange): Promise<void> {
    const d = ctx.trx;

    if (change.op === 'delete') {
      await d.deleteFrom('tasks').where('id', '=', change.row_id).execute();
      return;
    }

    const row = (change.row_json ?? {}) as Partial<TaskRow>;

    await d
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
