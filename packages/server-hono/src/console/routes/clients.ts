/**
 * @syncular/server-hono - Console client and client-diagnostics routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema } from '@syncular/core';
import { coerceNumber } from '@syncular/server';
import { resolver } from 'hono-openapi';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  type ConsoleClient,
  ConsoleClientDiagnosticIngestSchema,
  type ConsoleClientDiagnosticRecord,
  ConsoleClientDiagnosticRecordSchema,
  ConsoleClientSchema,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  ConsolePartitionedPaginationQuerySchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import {
  buildClientDiagnosticRecord,
  clientDiagnosticDetailQuerySchema,
  clientDiagnosticHistoryQuerySchema,
  clientDiagnosticsQuerySchema,
  clientIdParamSchema,
  consoleNotFound,
  consoleRouteError,
  DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES,
  findSensitiveDiagnosticField,
  getClientActivityState,
  jsonByteLength,
  normalizeRequestEventType,
} from './shared';

export function registerClientRoutes(ctx: ConsoleRoutesContext): void {
  const {
    routes,
    options,
    db,
    readClientDiagnosticRecords,
    writeClientDiagnosticRecord,
    pruneClientDiagnosticRecordsByCount,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /clients
  // -------------------------------------------------------------------------

  routes.get(
    '/clients',
    describeConsoleRoute({
      summary: 'List clients',
      responses: {
        200: {
          description: 'Paginated client list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleClientSchema)
              ),
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
    zValidator('query', ConsolePartitionedPaginationQuerySchema),
    async (c) => {
      const { limit, offset, partitionId } = c.req.valid('query');

      let clientsQuery = db
        .selectFrom('sync_client_cursors')
        .select([
          'client_id',
          'actor_id',
          'cursor',
          'effective_scopes',
          'updated_at',
        ]);
      let countQuery = db
        .selectFrom('sync_client_cursors')
        .select(({ fn }) => fn.countAll().as('total'));
      let maxCommitSeqQuery = db
        .selectFrom('sync_commits')
        .select(({ fn }) => fn.max('commit_seq').as('max_commit_seq'));

      if (partitionId) {
        clientsQuery = clientsQuery.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
        maxCommitSeqQuery = maxCommitSeqQuery.where(
          'partition_id',
          '=',
          partitionId
        );
      }

      const [rows, countRow, maxCommitSeqRow] = await Promise.all([
        clientsQuery
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
        maxCommitSeqQuery.executeTakeFirst(),
      ]);

      const maxCommitSeq = coerceNumber(maxCommitSeqRow?.max_commit_seq) ?? 0;
      const pagedClientIds = rows
        .map((row) => row.client_id)
        .filter((clientId): clientId is string => typeof clientId === 'string');

      const latestEventsByClientId = new Map<
        string,
        {
          createdAt: string;
          eventType: 'sync' | 'push' | 'pull';
          outcome: string;
          transportPath: 'direct' | 'relay';
        }
      >();
      const latestDiagnosticsByClientId = new Map<
        string,
        ConsoleClientDiagnosticRecord
      >();

      if (pagedClientIds.length > 0) {
        let recentEventsQuery = db
          .selectFrom('sync_request_events')
          .select([
            'client_id',
            'event_type',
            'outcome',
            'created_at',
            'transport_path',
          ])
          .where('client_id', 'in', pagedClientIds);

        if (partitionId) {
          recentEventsQuery = recentEventsQuery.where(
            'partition_id',
            '=',
            partitionId
          );
        }

        const recentEventRows = await recentEventsQuery
          .orderBy('created_at', 'desc')
          .execute();

        for (const row of recentEventRows) {
          const clientId = row.client_id;
          if (!clientId || latestEventsByClientId.has(clientId)) {
            continue;
          }

          const eventType = normalizeRequestEventType(row.event_type);

          latestEventsByClientId.set(clientId, {
            createdAt: row.created_at ?? '',
            eventType,
            outcome: row.outcome ?? '',
            transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
          });
        }

        const diagnosticRecords = await readClientDiagnosticRecords({
          clientIds: pagedClientIds,
          latestOnly: true,
          partitionId,
        });
        for (const record of diagnosticRecords.items) {
          if (!latestDiagnosticsByClientId.has(record.clientId)) {
            latestDiagnosticsByClientId.set(record.clientId, record);
          }
        }
      }

      const items: ConsoleClient[] = rows.map((row) => {
        const clientId = row.client_id ?? '';
        const cursor = coerceNumber(row.cursor) ?? 0;
        const latestEvent = latestEventsByClientId.get(clientId);
        const latestDiagnostic = latestDiagnosticsByClientId.get(clientId);
        const connectionCount =
          options.wsConnectionManager?.getConnectionCount(clientId) ?? 0;
        const connectionPath =
          options.wsConnectionManager?.getClientTransportPath(clientId) ??
          latestEvent?.transportPath ??
          'direct';

        return {
          clientId,
          actorId: row.actor_id ?? '',
          cursor,
          lagCommitCount: Math.max(0, maxCommitSeq - cursor),
          connectionPath,
          connectionMode: connectionCount > 0 ? 'realtime' : 'polling',
          realtimeConnectionCount: connectionCount,
          isRealtimeConnected: connectionCount > 0,
          activityState: getClientActivityState({
            connectionCount,
            updatedAt: row.updated_at,
          }),
          diagnosticFreshnessState: latestDiagnostic?.freshnessState ?? null,
          diagnosticHealthMaxSeverity:
            latestDiagnostic?.healthMaxSeverity ?? null,
          diagnosticReceivedAt: latestDiagnostic?.receivedAt ?? null,
          lastRequestAt: latestEvent?.createdAt ?? null,
          lastRequestType: latestEvent?.eventType ?? null,
          lastRequestOutcome: latestEvent?.outcome ?? null,
          effectiveScopes: options.dialect.dbToScopes(row.effective_scopes),
          updatedAt: row.updated_at ?? '',
        };
      });

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleClient> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /client-diagnostics
  // -------------------------------------------------------------------------

  routes.post(
    '/client-diagnostics',
    describeConsoleRoute({
      summary: 'Ingest a redacted Rust client diagnostic snapshot',
      responses: {
        202: {
          description: 'Accepted client diagnostic snapshot',
          content: {
            'application/json': {
              schema: resolver(ConsoleClientDiagnosticRecordSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
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
    zValidator('json', ConsoleClientDiagnosticIngestSchema),
    async (c) => {
      const payload = c.req.valid('json');
      const sensitiveField = findSensitiveDiagnosticField(payload);
      if (sensitiveField) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          fieldPath: sensitiveField,
          reason: 'client_diagnostic_sensitive_field',
        });
      }

      const record = buildClientDiagnosticRecord(payload, new Date());
      const recordBytes = jsonByteLength(record);
      if (recordBytes > DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          maxBytes: DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES,
          actualBytes: recordBytes,
          reason: 'client_diagnostic_snapshot_too_large',
        });
      }

      await writeClientDiagnosticRecord(record);
      await pruneClientDiagnosticRecordsByCount();
      return c.json(record, 202);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics',
    describeConsoleRoute({
      summary: 'List latest redacted Rust client diagnostic snapshots',
      responses: {
        200: {
          description: 'Paginated client diagnostic snapshots',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(
                  ConsoleClientDiagnosticRecordSchema
                )
              ),
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
    zValidator('query', clientDiagnosticsQuerySchema),
    async (c) => {
      const { limit, offset, partitionId, clientId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId,
        latestOnly: true,
        limit,
        offset,
        partitionId,
      });

      const response: ConsolePaginatedResponse<ConsoleClientDiagnosticRecord> =
        {
          items: records.items,
          total: records.total,
          offset,
          limit,
        };

      c.header('X-Total-Count', String(records.total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics/:id/history
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics/:id/history',
    describeConsoleRoute({
      summary: 'List retained redacted Rust client diagnostic snapshots',
      responses: {
        200: {
          description: 'Paginated client diagnostic snapshot history',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(
                  ConsoleClientDiagnosticRecordSchema
                )
              ),
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
    zValidator('param', clientIdParamSchema),
    zValidator('query', clientDiagnosticHistoryQuerySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { limit, offset, partitionId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId: id,
        latestOnly: false,
        limit,
        offset,
        partitionId,
      });

      const response: ConsolePaginatedResponse<ConsoleClientDiagnosticRecord> =
        {
          items: records.items,
          total: records.total,
          offset,
          limit,
        };

      c.header('X-Total-Count', String(records.total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics/:id
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics/:id',
    describeConsoleRoute({
      summary: 'Get latest redacted Rust client diagnostic snapshot',
      responses: {
        200: {
          description: 'Client diagnostic snapshot',
          content: {
            'application/json': {
              schema: resolver(ConsoleClientDiagnosticRecordSchema),
            },
          },
        },
        404: {
          description: 'Diagnostic snapshot not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', clientIdParamSchema),
    zValidator('query', clientDiagnosticDetailQuerySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId: id,
        latestOnly: true,
        limit: 1,
        offset: 0,
        partitionId,
      });
      const record = records.items[0] ?? null;
      if (!record) {
        return consoleNotFound(c, 'Client diagnostic snapshot not found.');
      }
      return c.json(record, 200);
    }
  );
}
