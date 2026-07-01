/**
 * @syncular/server/hono - Console handler, operations, and maintenance routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema, logSyncEvent } from '@syncular/core';
import {
  coerceNumber,
  compactChanges,
  notifyExternalDataChange,
  previewPruneSync,
  pruneSync,
} from '@syncular/server';
import { resolver } from 'hono-openapi';
import { z } from 'zod';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  type ConsoleCompactResult,
  ConsoleCompactResultSchema,
  type ConsoleEvictResult,
  ConsoleEvictResultSchema,
  type ConsoleHandler,
  type ConsoleOperationEvent,
  ConsoleOperationEventSchema,
  ConsoleOperationsQuerySchema,
  ConsoleOpsReadinessIngestSchema,
  type ConsoleOpsReadinessInput,
  type ConsoleOpsReadinessReport,
  ConsoleOpsReadinessReportSchema,
  type ConsoleOpsReadinessResponse,
  ConsoleOpsReadinessResponseSchema,
  type ConsoleOpsReadinessTrendsQuery,
  ConsoleOpsReadinessTrendsQuerySchema,
  type ConsoleOpsReadinessTrendsResponse,
  ConsoleOpsReadinessTrendsResponseSchema,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  type ConsolePrunePreview,
  ConsolePrunePreviewSchema,
  type ConsolePruneResult,
  ConsolePruneResultSchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import {
  clientIdParamSchema,
  consoleRouteError,
  DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES,
  evictClientQuerySchema,
  findSensitiveDiagnosticField,
  handlersResponseSchema,
  jsonByteLength,
} from './shared';

function buildOpsReadinessReport(
  input: ConsoleOpsReadinessInput
): ConsoleOpsReadinessReport {
  return {
    artifactSchema: 'syncular.ops-readiness.v1',
    generatedAt: input.generatedAt,
    environment: input.environment,
    status: input.status,
    ready: input.ready,
    checks: input.checks,
    issueCount: input.issues.length,
    issues: input.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      recommendedAction: issue.recommendedAction,
      details: issue.details,
    })),
    redaction: {
      localPaths: 'omitted',
      sensitiveKeys: 'rejected',
    },
  };
}

const OPS_READINESS_TREND_RANGE_MS: Record<
  ConsoleOpsReadinessTrendsQuery['range'],
  number
> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

interface OpsReadinessIssueTrendAccumulator {
  code: string;
  severity: 'warning' | 'error';
  count: number;
  affectedTargets: Set<string>;
  latestSeenAt: string;
  latestAction: string;
}

interface OpsReadinessBucketAccumulator {
  bucketStart: string;
  reportCount: number;
  readyCount: number;
  notReadyCount: number;
  issueCount: number;
}

function isLaterIso(candidate: string, current: string): boolean {
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  if (!Number.isFinite(candidateMs)) return false;
  if (!Number.isFinite(currentMs)) return true;
  return candidateMs > currentMs;
}

function opsReadinessBucketStartIso(
  createdAt: string,
  range: ConsoleOpsReadinessTrendsQuery['range']
): string | null {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return null;

  const bucket = new Date(parsed);
  bucket.setUTCMinutes(0, 0, 0);
  if (range !== '24h') {
    bucket.setUTCHours(0, 0, 0, 0);
  }
  return bucket.toISOString();
}

function buildOpsReadinessTrendsResponse(args: {
  events: ConsoleOperationEvent[];
  matchedCount: number;
  range: ConsoleOpsReadinessTrendsQuery['range'];
  from: string;
  to: string;
  targetLabel: string;
}): ConsoleOpsReadinessTrendsResponse {
  const issueTrends = new Map<string, OpsReadinessIssueTrendAccumulator>();
  const buckets = new Map<string, OpsReadinessBucketAccumulator>();
  let reportCount = 0;
  let readyCount = 0;
  let notReadyCount = 0;
  let issueCount = 0;

  for (const event of args.events) {
    const parsedReport = ConsoleOpsReadinessReportSchema.safeParse(
      event.resultPayload
    );
    if (!parsedReport.success) continue;

    const report = parsedReport.data;
    reportCount += 1;
    if (report.ready) {
      readyCount += 1;
    } else {
      notReadyCount += 1;
    }
    issueCount += report.issueCount;

    const bucketStart = opsReadinessBucketStartIso(event.createdAt, args.range);
    if (bucketStart) {
      const bucket =
        buckets.get(bucketStart) ??
        ({
          bucketStart,
          reportCount: 0,
          readyCount: 0,
          notReadyCount: 0,
          issueCount: 0,
        } satisfies OpsReadinessBucketAccumulator);
      bucket.reportCount += 1;
      bucket.readyCount += report.ready ? 1 : 0;
      bucket.notReadyCount += report.ready ? 0 : 1;
      bucket.issueCount += report.issueCount;
      buckets.set(bucketStart, bucket);
    }

    for (const issue of report.issues) {
      const existing = issueTrends.get(issue.code);
      if (!existing) {
        issueTrends.set(issue.code, {
          code: issue.code,
          severity: issue.severity,
          count: 1,
          affectedTargets: new Set([args.targetLabel]),
          latestSeenAt: event.createdAt,
          latestAction: issue.recommendedAction,
        });
        continue;
      }

      existing.count += 1;
      existing.affectedTargets.add(args.targetLabel);
      if (issue.severity === 'error') {
        existing.severity = 'error';
      }
      if (isLaterIso(event.createdAt, existing.latestSeenAt)) {
        existing.latestSeenAt = event.createdAt;
        existing.latestAction = issue.recommendedAction;
      }
    }
  }

  return {
    range: args.range,
    from: args.from,
    to: args.to,
    matchedCount: args.matchedCount,
    scannedCount: args.events.length,
    reportCount,
    readyCount,
    notReadyCount,
    issueCount,
    truncated: args.matchedCount > args.events.length,
    issueTrends: Array.from(issueTrends.values())
      .map((trend) => ({
        ...trend,
        affectedTargets: Array.from(trend.affectedTargets).sort(),
      }))
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
        if (a.count !== b.count) return b.count - a.count;
        if (a.latestSeenAt === b.latestSeenAt) {
          return a.code.localeCompare(b.code);
        }
        return isLaterIso(a.latestSeenAt, b.latestSeenAt) ? -1 : 1;
      }),
    buckets: Array.from(buckets.values()).sort((a, b) =>
      a.bucketStart.localeCompare(b.bucketStart)
    ),
  };
}

export function registerMaintenanceRoutes(ctx: ConsoleRoutesContext): void {
  const {
    routes,
    options,
    db,
    operationEventSelectColumns,
    mapOperationEvent,
    recordOperationEvent,
  } = ctx;

  const readLatestOpsReadiness =
    async (): Promise<ConsoleOpsReadinessResponse> => {
      const row = await db
        .selectFrom('sync_operation_events')
        .select(operationEventSelectColumns)
        .where('operation_type', '=', 'ops_readiness')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (!row) {
        return {
          available: false,
          operationId: null,
          recordedAt: null,
          report: null,
        };
      }

      const operation = mapOperationEvent(row);
      const report = ConsoleOpsReadinessReportSchema.safeParse(
        operation.resultPayload
      );

      return {
        available: report.success,
        operationId: operation.operationId,
        recordedAt: operation.createdAt,
        report: report.success ? report.data : null,
      };
    };

  const readOpsReadinessTrends = async (
    query: ConsoleOpsReadinessTrendsQuery
  ): Promise<ConsoleOpsReadinessTrendsResponse> => {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - OPS_READINESS_TREND_RANGE_MS[query.range]);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const baseQuery = db
      .selectFrom('sync_operation_events')
      .where('operation_type', '=', 'ops_readiness')
      .where('created_at', '>=', fromIso)
      .where('created_at', '<=', toIso);

    const [rows, countRow] = await Promise.all([
      baseQuery
        .select(operationEventSelectColumns)
        .orderBy('created_at', 'desc')
        .limit(query.limit)
        .execute(),
      baseQuery
        .select(({ fn }) => fn.countAll().as('total'))
        .executeTakeFirst(),
    ]);

    return buildOpsReadinessTrendsResponse({
      events: rows.map((row) => mapOperationEvent(row)),
      matchedCount: coerceNumber(countRow?.total) ?? 0,
      range: query.range,
      from: fromIso,
      to: toIso,
      targetLabel: 'local',
    });
  };

  // -------------------------------------------------------------------------
  // GET /handlers
  // -------------------------------------------------------------------------

  routes.get(
    '/handlers',
    describeConsoleRoute({
      summary: 'List registered handlers',
      responses: {
        200: {
          description: 'Handler list',
          content: {
            'application/json': { schema: resolver(handlersResponseSchema) },
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
    async (c) => {
      const items: ConsoleHandler[] = options.handlers.map((handler) => ({
        table: handler.table,
        dependsOn: handler.dependsOn,
        snapshotChunkTtlMs: handler.snapshotChunkTtlMs,
      }));

      return c.json({ items }, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /operations - Operation audit log
  // -------------------------------------------------------------------------

  routes.get(
    '/operations',
    describeConsoleRoute({
      summary: 'List operation audit events',
      responses: {
        200: {
          description: 'Paginated operation events',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleOperationEventSchema)
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
    zValidator('query', ConsoleOperationsQuerySchema),
    async (c) => {
      const { limit, offset, operationType, partitionId } =
        c.req.valid('query');

      let query = db
        .selectFrom('sync_operation_events')
        .select(operationEventSelectColumns);

      let countQuery = db
        .selectFrom('sync_operation_events')
        .select(({ fn }) => fn.countAll().as('total'));

      if (operationType) {
        query = query.where('operation_type', '=', operationType);
        countQuery = countQuery.where('operation_type', '=', operationType);
      }
      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items = rows.map((row) => mapOperationEvent(row));
      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleOperationEvent> = {
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
  // GET /ops/readiness - Latest production ops readiness report
  // -------------------------------------------------------------------------

  routes.get(
    '/ops/readiness',
    describeConsoleRoute({
      summary: 'Get latest production ops readiness report',
      responses: {
        200: {
          description: 'Latest ops readiness report',
          content: {
            'application/json': {
              schema: resolver(ConsoleOpsReadinessResponseSchema),
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
    async (c) => c.json(await readLatestOpsReadiness(), 200)
  );

  // -------------------------------------------------------------------------
  // GET /ops/readiness/trends - Production ops readiness trends
  // -------------------------------------------------------------------------

  routes.get(
    '/ops/readiness/trends',
    describeConsoleRoute({
      summary: 'Get production ops readiness trends',
      responses: {
        200: {
          description: 'Ops readiness trends',
          content: {
            'application/json': {
              schema: resolver(ConsoleOpsReadinessTrendsResponseSchema),
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
    zValidator('query', ConsoleOpsReadinessTrendsQuerySchema),
    async (c) => c.json(await readOpsReadinessTrends(c.req.valid('query')), 200)
  );

  // -------------------------------------------------------------------------
  // POST /ops/readiness - Ingest production ops readiness report
  // -------------------------------------------------------------------------

  routes.post(
    '/ops/readiness',
    describeConsoleRoute({
      summary: 'Ingest production ops readiness report',
      responses: {
        202: {
          description: 'Accepted ops readiness report',
          content: {
            'application/json': {
              schema: resolver(ConsoleOpsReadinessResponseSchema),
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
    zValidator('json', ConsoleOpsReadinessIngestSchema),
    async (c) => {
      const input = c.req.valid('json');
      const sensitiveField = findSensitiveDiagnosticField(input);
      if (sensitiveField) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          fieldPath: sensitiveField,
          reason: 'ops_readiness_sensitive_field',
        });
      }

      const report = buildOpsReadinessReport(input);
      const recordBytes = jsonByteLength(report);
      if (recordBytes > DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          maxBytes: DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES,
          actualBytes: recordBytes,
          reason: 'ops_readiness_report_too_large',
        });
      }

      await recordOperationEvent({
        operationType: 'ops_readiness',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestPayload: {
          source: 'syncular.ops.check',
          generatedAt: input.generatedAt,
          environment: input.environment,
          status: input.status,
          ready: input.ready,
          issueCount: input.issues.length,
        },
        resultPayload: report,
      });

      logSyncEvent({
        event: 'console.ops_readiness',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        environment: input.environment ?? undefined,
        ready: input.ready,
        issueCount: input.issues.length,
      });

      return c.json(await readLatestOpsReadiness(), 202);
    }
  );

  // -------------------------------------------------------------------------
  // POST /prune/preview
  // -------------------------------------------------------------------------

  routes.post(
    '/prune/preview',
    describeConsoleRoute({
      summary: 'Preview pruning',
      responses: {
        200: {
          description: 'Prune preview',
          content: {
            'application/json': { schema: resolver(ConsolePrunePreviewSchema) },
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
    async (c) => {
      const previews = await previewPruneSync(options.db, options.prune);
      const watermarkCommitSeq = previews.reduce(
        (max, preview) => Math.max(max, preview.watermarkCommitSeq),
        0
      );
      const commitsToDelete = previews.reduce(
        (total, preview) => total + preview.commitsToDelete,
        0
      );

      const preview: ConsolePrunePreview = {
        watermarkCommitSeq,
        commitsToDelete,
      };

      return c.json(preview, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /prune
  // -------------------------------------------------------------------------

  routes.post(
    '/prune',
    describeConsoleRoute({
      summary: 'Trigger pruning',
      responses: {
        200: {
          description: 'Prune result',
          content: {
            'application/json': { schema: resolver(ConsolePruneResultSchema) },
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
    async (c) => {
      const previews = await previewPruneSync(options.db, options.prune);
      const watermarkCommitSeq = previews.reduce(
        (max, preview) => Math.max(max, preview.watermarkCommitSeq),
        0
      );
      let deletedCommits = 0;
      for (const preview of previews) {
        deletedCommits += await pruneSync(options.db, {
          partitionId: preview.partitionId,
          watermarkCommitSeq: preview.watermarkCommitSeq,
          keepNewestCommits: options.prune?.keepNewestCommits,
        });
      }

      logSyncEvent({
        event: 'console.prune',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCommits,
        watermarkCommitSeq,
      });
      await recordOperationEvent({
        operationType: 'prune',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestPayload: {
          watermarkCommitSeq,
          keepNewestCommits: options.prune?.keepNewestCommits ?? null,
        },
        resultPayload: { deletedCommits, watermarkCommitSeq },
      });

      const result: ConsolePruneResult = { deletedCommits };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /compact
  // -------------------------------------------------------------------------

  routes.post(
    '/compact',
    describeConsoleRoute({
      summary: 'Trigger compaction',
      responses: {
        200: {
          description: 'Compact result',
          content: {
            'application/json': {
              schema: resolver(ConsoleCompactResultSchema),
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
    async (c) => {
      const fullHistoryHours = options.compact?.fullHistoryHours ?? 24 * 7;

      const deletedChanges = await compactChanges(options.db, {
        dialect: options.dialect,
        options: { fullHistoryHours },
      });

      logSyncEvent({
        event: 'console.compact',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedChanges,
        fullHistoryHours,
      });
      await recordOperationEvent({
        operationType: 'compact',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestPayload: { fullHistoryHours },
        resultPayload: { deletedChanges },
      });

      const result: ConsoleCompactResult = { deletedChanges };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /notify-data-change
  // -------------------------------------------------------------------------

  const NotifyDataChangeRequestSchema = z.object({
    tables: z.array(z.string().min(1)).min(1),
    partitionId: z.string().optional(),
  });

  const NotifyDataChangeResponseSchema = z.object({
    commitSeq: z.number(),
    tables: z.array(z.string()),
    deletedChunks: z.number(),
  });

  routes.post(
    '/notify-data-change',
    describeConsoleRoute({
      summary: 'Notify external data change',
      description:
        'Creates a synthetic commit to force re-bootstrap for affected tables. ' +
        'Use after pipeline imports or direct DB writes to notify connected clients.',
      responses: {
        200: {
          description: 'Notification result',
          content: {
            'application/json': {
              schema: resolver(NotifyDataChangeResponseSchema),
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
    zValidator('json', NotifyDataChangeRequestSchema),
    async (c) => {
      const body = c.req.valid('json');

      const result = await notifyExternalDataChange({
        db: options.db,
        dialect: options.dialect,
        tables: body.tables,
        partitionId: body.partitionId,
      });

      logSyncEvent({
        event: 'console.notify_data_change',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        tables: body.tables,
        commitSeq: result.commitSeq,
        deletedChunks: result.deletedChunks,
      });
      await recordOperationEvent({
        operationType: 'notify_data_change',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        partitionId: body.partitionId ?? null,
        requestPayload: {
          tables: body.tables,
          partitionId: body.partitionId ?? null,
        },
        resultPayload: result,
      });

      // Wake all WS clients so they pull immediately
      if (options.wsConnectionManager) {
        options.wsConnectionManager.notifyAllClients(result.commitSeq);
      }

      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /clients/:id
  // -------------------------------------------------------------------------

  routes.delete(
    '/clients/:id',
    describeConsoleRoute({
      summary: 'Evict client',
      responses: {
        200: {
          description: 'Evict result',
          content: {
            'application/json': { schema: resolver(ConsoleEvictResultSchema) },
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
    zValidator('param', clientIdParamSchema),
    zValidator('query', evictClientQuerySchema),
    async (c) => {
      const { id: clientId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let deleteQuery = db
        .deleteFrom('sync_client_cursors')
        .where('client_id', '=', clientId);

      if (partitionId) {
        deleteQuery = deleteQuery.where('partition_id', '=', partitionId);
      }

      const res = await deleteQuery.executeTakeFirst();

      const evicted = Number(res?.numDeletedRows ?? 0) > 0;

      logSyncEvent({
        event: 'console.evict_client',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        clientId,
        evicted,
      });
      await recordOperationEvent({
        operationType: 'evict_client',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        partitionId: partitionId ?? null,
        targetClientId: clientId,
        requestPayload: { clientId, partitionId: partitionId ?? null },
        resultPayload: { evicted },
      });

      const result: ConsoleEvictResult = { evicted };
      return c.json(result, 200);
    }
  );
}
