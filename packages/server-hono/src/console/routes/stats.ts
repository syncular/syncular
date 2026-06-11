/**
 * @syncular/server-hono - Console stats routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema, logSyncEvent } from '@syncular/core';
import { coerceNumber, readSyncStats } from '@syncular/server';
import { resolver } from 'hono-openapi';
import { sql } from 'kysely';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  ConsolePartitionQuerySchema,
  type LatencyPercentiles,
  LatencyQuerySchema,
  type LatencyStatsResponse,
  LatencyStatsResponseSchema,
  type SyncStats,
  SyncStatsSchema,
  type TimeseriesBucket,
  TimeseriesQuerySchema,
  type TimeseriesStatsResponse,
  TimeseriesStatsResponseSchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import {
  calculatePercentiles,
  createEmptyTimeseriesAccumulator,
  createTimeseriesBucketMap,
  finalizeTimeseriesBuckets,
  intervalToMs,
  intervalToSqliteBucketFormat,
  normalizeBucketTimestamp,
  normalizeRequestEventType,
  parseDate,
  rangeToMs,
} from './shared';

export function registerStatsRoutes(ctx: ConsoleRoutesContext): void {
  const { routes, options, db, shouldUseRawMetrics } = ctx;

  // -------------------------------------------------------------------------
  // GET /stats
  // -------------------------------------------------------------------------

  routes.get(
    '/stats',
    describeConsoleRoute({
      summary: 'Get sync statistics',
      responses: {
        200: {
          description: 'Sync statistics',
          content: {
            'application/json': { schema: resolver(SyncStatsSchema) },
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
    zValidator('query', ConsolePartitionQuerySchema),
    async (c) => {
      const { partitionId } = c.req.valid('query');

      const stats: SyncStats = await readSyncStats(options.db, {
        partitionId,
      });

      logSyncEvent({
        event: 'console.stats',
        consoleUserId: c.var.consoleAuth.consoleUserId,
      });

      return c.json(stats, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /stats/timeseries
  // -------------------------------------------------------------------------

  routes.get(
    '/stats/timeseries',
    describeConsoleRoute({
      summary: 'Get time-series statistics',
      responses: {
        200: {
          description: 'Time-series statistics',
          content: {
            'application/json': {
              schema: resolver(TimeseriesStatsResponseSchema),
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
    zValidator('query', TimeseriesQuerySchema),
    async (c) => {
      const { interval, range, partitionId } = c.req.valid('query');

      const rangeMs = rangeToMs(range);
      const startTime = new Date(Date.now() - rangeMs);
      const startIso = startTime.toISOString();
      const intervalMs = intervalToMs(interval);
      const bucketMap = createTimeseriesBucketMap({
        startTime,
        rangeMs,
        intervalMs,
      });
      const useRawMetrics = await shouldUseRawMetrics(startIso, partitionId);

      if (useRawMetrics) {
        let eventsQuery = db
          .selectFrom('sync_request_events')
          .select(['event_type', 'duration_ms', 'outcome', 'created_at'])
          .where('created_at', '>=', startIso);

        if (partitionId) {
          eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
        }

        const events = await eventsQuery.orderBy('created_at', 'asc').execute();

        for (const event of events) {
          const eventTime = parseDate(event.created_at);
          if (eventTime === null) continue;
          const bucketIndex = Math.floor(
            (eventTime - startTime.getTime()) / intervalMs
          );
          const bucketTime = new Date(
            startTime.getTime() + bucketIndex * intervalMs
          ).toISOString();

          let bucket = bucketMap.get(bucketTime);
          if (!bucket) {
            bucket = createEmptyTimeseriesAccumulator();
            bucketMap.set(bucketTime, bucket);
          }

          if (event.event_type === 'push') {
            bucket.pushCount++;
          } else if (event.event_type === 'pull') {
            bucket.pullCount++;
          }

          if (event.outcome === 'error') {
            bucket.errorCount++;
          }

          const durationMs = coerceNumber(event.duration_ms);
          if (durationMs !== null) {
            bucket.totalLatency += durationMs;
            bucket.eventCount++;
          }
        }
      } else {
        const partitionFilter = partitionId
          ? sql`and partition_id = ${partitionId}`
          : sql``;

        if (options.dialect.family === 'sqlite') {
          const bucketFormat = intervalToSqliteBucketFormat(interval);
          const rowsResult = await sql<{
            bucket: unknown;
            push_count: unknown;
            pull_count: unknown;
            event_count: unknown;
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              strftime(${bucketFormat}, created_at) as bucket,
              sum(case when event_type = 'push' then 1 else 0 end) as push_count,
              sum(case when event_type = 'pull' then 1 else 0 end) as pull_count,
              count(*) as event_count,
              sum(case when outcome = 'error' then 1 else 0 end) as error_count,
              avg(duration_ms) as avg_latency_ms
            from ${sql.table('sync_request_events')}
            where created_at >= ${startIso}
            ${partitionFilter}
            group by 1
            order by 1 asc
          `.execute(options.db);

          for (const row of rowsResult.rows) {
            const bucketTimestamp = normalizeBucketTimestamp(row.bucket);
            if (!bucketTimestamp) continue;

            let bucket = bucketMap.get(bucketTimestamp);
            if (!bucket) {
              bucket = createEmptyTimeseriesAccumulator();
              bucketMap.set(bucketTimestamp, bucket);
            }

            const pushCount = coerceNumber(row.push_count) ?? 0;
            const pullCount = coerceNumber(row.pull_count) ?? 0;
            const rowEventCount = coerceNumber(row.event_count) ?? 0;
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);

            bucket.pushCount += pushCount;
            bucket.pullCount += pullCount;
            bucket.errorCount += errorCount;
            if (avgLatencyMs !== null && rowEventCount > 0) {
              bucket.totalLatency += avgLatencyMs * rowEventCount;
              bucket.eventCount += rowEventCount;
            }
          }
        } else {
          const rowsResult = await sql<{
            bucket: unknown;
            push_count: unknown;
            pull_count: unknown;
            event_count: unknown;
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              date_trunc(${interval}, created_at::timestamptz) as bucket,
              count(*) filter (where event_type = 'push') as push_count,
              count(*) filter (where event_type = 'pull') as pull_count,
              count(*) as event_count,
              count(*) filter (where outcome = 'error') as error_count,
              avg(duration_ms) as avg_latency_ms
            from ${sql.table('sync_request_events')}
            where created_at >= ${startIso}
            ${partitionFilter}
            group by 1
            order by 1 asc
          `.execute(options.db);

          for (const row of rowsResult.rows) {
            const bucketTimestamp = normalizeBucketTimestamp(row.bucket);
            if (!bucketTimestamp) continue;

            let bucket = bucketMap.get(bucketTimestamp);
            if (!bucket) {
              bucket = createEmptyTimeseriesAccumulator();
              bucketMap.set(bucketTimestamp, bucket);
            }

            const pushCount = coerceNumber(row.push_count) ?? 0;
            const pullCount = coerceNumber(row.pull_count) ?? 0;
            const rowEventCount = coerceNumber(row.event_count) ?? 0;
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);

            bucket.pushCount += pushCount;
            bucket.pullCount += pullCount;
            bucket.errorCount += errorCount;
            if (avgLatencyMs !== null && rowEventCount > 0) {
              bucket.totalLatency += avgLatencyMs * rowEventCount;
              bucket.eventCount += rowEventCount;
            }
          }
        }
      }

      const buckets: TimeseriesBucket[] = finalizeTimeseriesBuckets(bucketMap);

      const response: TimeseriesStatsResponse = {
        buckets,
        interval,
        range,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /stats/latency
  // -------------------------------------------------------------------------

  routes.get(
    '/stats/latency',
    describeConsoleRoute({
      summary: 'Get latency percentiles',
      responses: {
        200: {
          description: 'Latency percentiles',
          content: {
            'application/json': {
              schema: resolver(LatencyStatsResponseSchema),
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
    zValidator('query', LatencyQuerySchema),
    async (c) => {
      const { range, partitionId } = c.req.valid('query');

      const rangeMs = rangeToMs(range);
      const startTime = new Date(Date.now() - rangeMs);
      const startIso = startTime.toISOString();
      const useRawMetrics = await shouldUseRawMetrics(startIso, partitionId);

      if (!useRawMetrics && options.dialect.family !== 'sqlite') {
        const partitionFilter = partitionId
          ? sql`and partition_id = ${partitionId}`
          : sql``;
        const rowsResult = await sql<{
          event_type: unknown;
          p50: unknown;
          p90: unknown;
          p99: unknown;
        }>`
          select
            event_type,
            percentile_disc(0.5) within group (order by duration_ms) as p50,
            percentile_disc(0.9) within group (order by duration_ms) as p90,
            percentile_disc(0.99) within group (order by duration_ms) as p99
          from ${sql.table('sync_request_events')}
          where created_at >= ${startIso}
          ${partitionFilter}
          group by event_type
        `.execute(options.db);

        const push: LatencyPercentiles = { p50: 0, p90: 0, p99: 0 };
        const pull: LatencyPercentiles = { p50: 0, p90: 0, p99: 0 };

        for (const row of rowsResult.rows) {
          const eventType = normalizeRequestEventType(row.event_type);
          if (eventType === 'sync') continue;
          const target = eventType === 'push' ? push : pull;
          target.p50 = coerceNumber(row.p50) ?? 0;
          target.p90 = coerceNumber(row.p90) ?? 0;
          target.p99 = coerceNumber(row.p99) ?? 0;
        }

        const aggregatedResponse: LatencyStatsResponse = {
          push,
          pull,
          range,
        };
        return c.json(aggregatedResponse, 200);
      }

      // Raw fallback path (default for local/dev and SQLite)
      let eventsQuery = db
        .selectFrom('sync_request_events')
        .select(['event_type', 'duration_ms'])
        .where('created_at', '>=', startIso);

      if (partitionId) {
        eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
      }

      const events = await eventsQuery.execute();

      const pushLatencies: number[] = [];
      const pullLatencies: number[] = [];

      for (const event of events) {
        const durationMs = coerceNumber(event.duration_ms);
        if (durationMs !== null) {
          if (event.event_type === 'push') {
            pushLatencies.push(durationMs);
          } else if (event.event_type === 'pull') {
            pullLatencies.push(durationMs);
          }
        }
      }

      const response: LatencyStatsResponse = {
        push: calculatePercentiles(pushLatencies),
        pull: calculatePercentiles(pullLatencies),
        range,
      };

      return c.json(response, 200);
    }
  );
}
