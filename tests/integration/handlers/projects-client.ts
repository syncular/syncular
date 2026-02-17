/**
 * Client-side projects table handler for integration tests
 */

import type { ClientTableHandler } from '@syncular/client';
import type { SyncChange, SyncSnapshot } from '@syncular/core';
import type { ClientDb } from './db-types';

type ProjectRow = {
  id: string;
  name: string;
  owner_id: string;
  server_version: number;
};

export const projectsClientHandler: ClientTableHandler<ClientDb, 'projects'> = {
  table: 'projects',

  async onSnapshotStart(ctx): Promise<void> {
    const d = ctx.trx;
    // Server handler uses user_id as scope key; client receives it as owner_id
    const ownerId = ctx.scopes.owner_id;
    const projectId = ctx.scopes.project_id;

    let query = d.deleteFrom('projects');

    if (ownerId) {
      const ownerIds = Array.isArray(ownerId) ? ownerId : [ownerId];
      if (ownerIds.length === 1) {
        query = query.where('owner_id', '=', ownerIds[0]!);
      } else {
        query = query.where('owner_id', 'in', ownerIds);
      }
    }

    if (projectId) {
      const projectIds = Array.isArray(projectId) ? projectId : [projectId];
      if (projectIds.length === 1) {
        query = query.where('id', '=', projectIds[0]!);
      } else {
        query = query.where('id', 'in', projectIds);
      }
    }

    await query.execute();
  },

  async applySnapshot(ctx, snapshot: SyncSnapshot): Promise<void> {
    const d = ctx.trx;
    const parsedRows = (snapshot.rows ?? []) as ProjectRow[];
    if (parsedRows.length === 0) return;

    await d
      .insertInto('projects')
      .values(
        parsedRows.map((r) => ({
          id: r.id,
          name: r.name,
          owner_id: r.owner_id,
          server_version: r.server_version ?? 0,
        }))
      )
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: (eb) => eb.ref('excluded.name'),
          owner_id: (eb) => eb.ref('excluded.owner_id'),
          server_version: (eb) => eb.ref('excluded.server_version'),
        })
      )
      .execute();
  },

  async clearAll(ctx): Promise<void> {
    const d = ctx.trx;
    const ownerId = ctx.scopes?.owner_id;
    const projectId = ctx.scopes?.project_id;

    let query = d.deleteFrom('projects');

    if (ownerId) {
      const ownerIds = Array.isArray(ownerId) ? ownerId : [ownerId];
      if (ownerIds.length === 1) {
        query = query.where('owner_id', '=', ownerIds[0]!);
      } else {
        query = query.where('owner_id', 'in', ownerIds);
      }
    }

    if (projectId) {
      const projectIds = Array.isArray(projectId) ? projectId : [projectId];
      if (projectIds.length === 1) {
        query = query.where('id', '=', projectIds[0]!);
      } else {
        query = query.where('id', 'in', projectIds);
      }
    }

    await query.execute();
  },

  async applyChange(ctx, change: SyncChange): Promise<void> {
    const d = ctx.trx;

    if (change.op === 'delete') {
      await d.deleteFrom('projects').where('id', '=', change.row_id).execute();
      return;
    }

    const row = (change.row_json ?? {}) as Partial<ProjectRow>;

    await d
      .insertInto('projects')
      .values({
        id: change.row_id,
        name: row.name ?? '',
        owner_id: row.owner_id ?? '',
        server_version: change.row_version ?? row.server_version ?? 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: row.name ?? '',
          owner_id: row.owner_id ?? '',
          server_version: change.row_version ?? row.server_version ?? 0,
        })
      )
      .execute();
  },
};
