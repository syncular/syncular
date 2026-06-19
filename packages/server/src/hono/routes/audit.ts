/**
 * Audit routes:
 * - GET /audit/commits
 * - GET /audit/debug/export
 * - GET /audit/commits/:commitSeq
 * - GET /audit/rows/:table/:rowId
 */

import { ErrorResponseSchema, type ScopeValues } from '@syncular/core';
import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import { coerceNumber } from '@syncular/server';
import { describeRoute, resolver } from 'hono-openapi';
import { sql } from 'kysely';
import { summarizeAuditChange } from '../audit-redaction';
import { syncError } from '../errors';
import { syncValidator as zValidator } from '../validation';
import type { SyncRoutesContext } from './context';
import {
  auditCommitDetailResponseSchema,
  auditCommitListQuerySchema,
  auditCommitListResponseSchema,
  auditCommitParamsSchema,
  auditDebugExportQuerySchema,
  auditDebugExportResponseSchema,
  auditRowHistoryParamsSchema,
  auditRowHistoryQuerySchema,
  auditRowHistoryResponseSchema,
  type SyncAuthResult,
  selectRequiredAuditScopes,
} from './shared';

export function registerAuditRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const {
    routes,
    getAuth,
    options,
    handlerRegistry,
    readVisibleAuditChanges,
    readAuditDebugRequestEvents,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /audit/commits
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/commits',
    describeRoute({
      tags: ['sync'],
      summary: 'List sync commits for audit UI',
      description:
        'Returns commit-level audit history scoped to the authenticated partition.',
      responses: {
        200: {
          description: 'Commit audit history',
          content: {
            'application/json': {
              schema: resolver(auditCommitListResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', auditCommitListQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const limit = query.limit ?? 50;

      const whereClauses = [sql`c.partition_id = ${partitionId}`];
      if (query.beforeCommitSeq !== undefined) {
        whereClauses.push(sql`c.commit_seq < ${query.beforeCommitSeq}`);
      }
      if (query.actorId) {
        whereClauses.push(sql`c.actor_id = ${query.actorId}`);
      }
      if (query.from) {
        whereClauses.push(sql`c.created_at >= ${query.from}`);
      }
      if (query.to) {
        whereClauses.push(sql`c.created_at <= ${query.to}`);
      }
      const tableFilter = query.table;
      if (tableFilter) {
        whereClauses.push(sql`
          exists (
            select 1
            from ${sql.table('sync_table_commits')} as ${sql.ref('tc')}
            where ${sql.raw('tc.partition_id')} = ${partitionId}
              and ${sql.raw('tc.commit_seq')} = ${sql.raw('c.commit_seq')}
              and ${sql.raw('tc.table')} = ${tableFilter}
          )
        `);
      }

      const rowsResult = await sql<{
        commit_seq: number;
        actor_id: string;
        client_id: string;
        client_commit_id: string;
        created_at: string;
        change_count: number;
        affected_tables: unknown;
      }>`
        select
          c.commit_seq,
          c.actor_id,
          c.client_id,
          c.client_commit_id,
          c.created_at,
          c.change_count,
          c.affected_tables
        from ${sql.table('sync_commits')} as ${sql.ref('c')}
        where ${sql.join(whereClauses, sql` and `)}
        order by c.commit_seq desc
        limit ${limit + 1}
      `.execute(options.db);
      const rows = rowsResult.rows;

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? Number(rows[limit]?.commit_seq ?? 0) : null;

      return c.json(
        {
          ok: true,
          commits: selectedRows.map((row) => ({
            commitSeq: Number(row.commit_seq),
            actorId: row.actor_id,
            clientId: row.client_id,
            clientCommitId: row.client_commit_id,
            createdAt: row.created_at,
            changeCount: Number(row.change_count),
            affectedTables: options.dialect.dbToArray(row.affected_tables),
          })),
          nextCursor,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/debug/export
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/debug/export',
    describeRoute({
      tags: ['sync'],
      summary: 'Export a redacted sync debug bundle',
      description:
        'Returns a size-bounded support bundle for the authenticated actor with visible redacted commit changes and own request events.',
      responses: {
        200: {
          description: 'Redacted sync debug export',
          content: {
            'application/json': {
              schema: resolver(auditDebugExportResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', auditDebugExportQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { limitCommits, limitEvents, from, to } = c.req.valid('query');

      const commitWhereClauses = [sql`partition_id = ${partitionId}`];
      if (from) {
        commitWhereClauses.push(sql`created_at >= ${from}`);
      }
      if (to) {
        commitWhereClauses.push(sql`created_at <= ${to}`);
      }

      const [commitResult, requestEventResult] = await Promise.all([
        sql<{
          commit_seq: number | string;
          actor_id: string;
          client_id: string;
          client_commit_id: string;
          created_at: string;
          change_count: number | string;
          affected_tables: unknown;
        }>`
          select
            commit_seq,
            actor_id,
            client_id,
            client_commit_id,
            created_at,
            change_count,
            affected_tables
          from ${sql.table('sync_commits')}
          where ${sql.join(commitWhereClauses, sql` and `)}
          order by commit_seq desc
          limit ${limitCommits + 1}
        `.execute(options.db),
        readAuditDebugRequestEvents({
          auth,
          partitionId,
          limit: limitEvents,
          from,
          to,
        }),
      ]);

      const selectedCommitRows = commitResult.rows.slice(0, limitCommits);
      const commitSeqs = selectedCommitRows
        .map((row) => coerceNumber(row.commit_seq))
        .filter((seq): seq is number => seq !== null);
      const changesByCommitSeq = await readVisibleAuditChanges({
        auth,
        partitionId,
        commitSeqs,
      });
      const commits = selectedCommitRows.flatMap((row) => {
        const commitSeq = coerceNumber(row.commit_seq) ?? 0;
        const changes = changesByCommitSeq.get(commitSeq) ?? [];
        if (changes.length === 0) return [];
        return [
          {
            commitSeq,
            actorId: row.actor_id,
            clientId: row.client_id,
            clientCommitId: row.client_commit_id,
            createdAt: row.created_at,
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
            changes,
          },
        ];
      });

      return c.json(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          partitionId,
          limits: {
            commits: limitCommits,
            requestEvents: limitEvents,
          },
          truncated: {
            commits: commitResult.rows.length > limitCommits,
            requestEvents: requestEventResult.truncated,
          },
          commits,
          requestEvents: requestEventResult.events,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/commits/:commitSeq
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/commits/:commitSeq',
    describeRoute({
      tags: ['sync'],
      summary: 'Read a sync commit with emitted changes',
      description:
        'Returns commit metadata and change rows for one commit within the authenticated partition.',
      responses: {
        200: {
          description: 'Commit audit detail',
          content: {
            'application/json': {
              schema: resolver(auditCommitDetailResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Commit not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', auditCommitParamsSchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { commitSeq } = c.req.valid('param');

      const commitResult = await sql<{
        commit_seq: number;
        actor_id: string;
        client_id: string;
        client_commit_id: string;
        created_at: string;
        change_count: number;
        affected_tables: unknown;
      }>`
        select
          commit_seq,
          actor_id,
          client_id,
          client_commit_id,
          created_at,
          change_count,
          affected_tables
        from ${sql.table('sync_commits')}
        where partition_id = ${partitionId}
          and commit_seq = ${commitSeq}
        limit 1
      `.execute(options.db);

      const commit = commitResult.rows[0];
      if (!commit) {
        return syncError(c, 404, 'sync.not_found');
      }

      const changesByCommitSeq = await readVisibleAuditChanges({
        auth,
        partitionId,
        commitSeqs: [commitSeq],
      });
      const changes = changesByCommitSeq.get(commitSeq) ?? [];
      if (changes.length === 0) {
        return syncError(c, 404, 'sync.not_found');
      }

      return c.json(
        {
          ok: true,
          commit: {
            commitSeq: Number(commit.commit_seq),
            actorId: commit.actor_id,
            clientId: commit.client_id,
            clientCommitId: commit.client_commit_id,
            createdAt: commit.created_at,
            changeCount: Number(commit.change_count),
            affectedTables: options.dialect.dbToArray(commit.affected_tables),
          },
          changes,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/rows/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/rows/:table/:rowId',
    describeRoute({
      tags: ['sync'],
      summary: 'Read scoped row audit history',
      description:
        'Returns redacted row-level audit history for one row within the authenticated partition and allowed scopes.',
      responses: {
        200: {
          description: 'Scoped row audit history',
          content: {
            'application/json': {
              schema: resolver(auditRowHistoryResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Row history not found in the authenticated scopes',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', auditRowHistoryParamsSchema),
    zValidator('query', auditRowHistoryQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { table, rowId } = c.req.valid('param');
      const query = c.req.valid('query');
      const limit = query.limit ?? 50;
      const handler = handlerRegistry.byTable.get(table);
      if (!handler) {
        return syncError(c, 404, 'sync.not_found');
      }

      let allowedScopes: ScopeValues;
      try {
        allowedScopes = await handler.resolveScopes({
          db: options.db,
          actorId: auth.actorId,
          auth,
        });
      } catch {
        return syncError(c, 404, 'sync.not_found');
      }

      const auditScopes = selectRequiredAuditScopes(
        handler.scopePatterns,
        allowedScopes
      );
      if (!auditScopes) {
        return syncError(c, 404, 'sync.not_found');
      }

      const rows = await options.dialect.readAuditRowHistory(options.db, {
        partitionId,
        table,
        rowId,
        scopes: auditScopes,
        limit,
        beforeCommitSeq: query.beforeCommitSeq,
        afterCommitSeq: query.afterCommitSeq,
      });
      if (rows.length === 0) {
        return syncError(c, 404, 'sync.not_found');
      }

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;

      return c.json(
        {
          ok: true,
          table,
          rowId,
          history: selectedRows.map((row) => {
            const summary = summarizeAuditChange({
              table: row.table,
              op: row.op,
              rowJson: row.row_json,
              scopes: row.scopes,
            });
            return {
              commitSeq: Number(row.commit_seq),
              actorId: row.actor_id,
              clientId: row.client_id,
              clientCommitId: row.client_commit_id,
              createdAt: row.created_at,
              changeId: Number(row.change_id),
              table: row.table,
              rowId: row.row_id,
              op: row.op,
              rowVersion:
                row.row_version === null ? null : Number(row.row_version),
              ...summary,
            };
          }),
          nextCursor,
        },
        200
      );
    }
  );
}
