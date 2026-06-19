/**
 * @syncular/server/hono - Console timeline, commit, and row-history routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema, type ScopeValues } from '@syncular/core';
import { coerceNumber, type SyncCoreDb } from '@syncular/server';
import { resolver } from 'hono-openapi';
import type { Kysely } from 'kysely';
import { summarizeAuditChange } from '../../audit-redaction';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  type ConsoleChange,
  type ConsoleCommitDetail,
  ConsoleCommitDetailSchema,
  type ConsoleCommitListItem,
  ConsoleCommitListItemSchema,
  type ConsoleDebugExportCommit,
  type ConsoleDebugExportResponse,
  ConsoleDebugExportResponseSchema,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  ConsolePartitionedPaginationQuerySchema,
  type ConsoleRowHistoryResponse,
  ConsoleRowHistoryResponseSchema,
  type ConsoleRowInvestigationClient,
  type ConsoleRowInvestigationFinding,
  type ConsoleRowInvestigationResponse,
  ConsoleRowInvestigationResponseSchema,
  type ConsoleTimelineItem,
  ConsoleTimelineItemSchema,
  ConsoleTimelineQuerySchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import {
  assessScopeEligibility,
  commitDetailQuerySchema,
  commitSeqParamSchema,
  consoleNotFound,
  debugExportQuerySchema,
  includesSearchTerm,
  parseDate,
  parseJsonStringArray,
  rowHistoryParamSchema,
  rowHistoryQuerySchema,
  rowInvestigationQuerySchema,
  summarizeRealtimeEvidence,
  summarizeRequestEvidence,
  summarizeSnapshotEvidence,
  summarizeSubscriptionEvidence,
} from './shared';

export function registerCommitRoutes(ctx: ConsoleRoutesContext): void {
  const {
    routes,
    options,
    db,
    timelineScanMaxRows,
    requestEventSelectColumns,
    mapRequestEvent,
    mapDebugExportEvent,
    readRedactedCommitChanges,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /timeline
  // -------------------------------------------------------------------------

  routes.get(
    '/timeline',
    describeConsoleRoute({
      summary: 'List timeline items',
      responses: {
        200: {
          description: 'Paginated merged timeline',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleTimelineItemSchema)
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
    zValidator('query', ConsoleTimelineQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        view,
        partitionId,
        eventType,
        actorId,
        clientId,
        requestId,
        traceId,
        syncAttemptId,
        table,
        outcome,
        search,
        from,
        to,
      } = c.req.valid('query');
      const resolvedTraceId = traceId ?? syncAttemptId;

      const items: ConsoleTimelineItem[] = [];
      const normalizedSearchTerm = search?.trim().toLowerCase() || null;
      const normalizedTable = table?.trim() || null;
      const timelineSourceScanLimit =
        timelineScanMaxRows > 0 ? timelineScanMaxRows : null;
      let timelineTruncated = false;

      if (
        view !== 'events' &&
        !eventType &&
        !outcome &&
        !requestId &&
        !resolvedTraceId
      ) {
        let commitsQuery = db
          .selectFrom('sync_commits')
          .select([
            'commit_seq',
            'actor_id',
            'client_id',
            'client_commit_id',
            'created_at',
            'change_count',
            'affected_tables',
          ]);

        if (partitionId) {
          commitsQuery = commitsQuery.where('partition_id', '=', partitionId);
        }
        if (actorId) {
          commitsQuery = commitsQuery.where('actor_id', '=', actorId);
        }
        if (clientId) {
          commitsQuery = commitsQuery.where('client_id', '=', clientId);
        }
        if (from) {
          commitsQuery = commitsQuery.where('created_at', '>=', from);
        }
        if (to) {
          commitsQuery = commitsQuery.where('created_at', '<=', to);
        }

        let commitsQueryWithOrdering = commitsQuery.orderBy(
          'created_at',
          'desc'
        );
        if (timelineSourceScanLimit !== null) {
          commitsQueryWithOrdering = commitsQueryWithOrdering.limit(
            timelineSourceScanLimit + 1
          );
        }

        const commitRows = await commitsQueryWithOrdering.execute();
        const scannedCommitRows =
          timelineSourceScanLimit === null
            ? commitRows
            : commitRows.slice(0, timelineSourceScanLimit);
        if (
          timelineSourceScanLimit !== null &&
          commitRows.length > timelineSourceScanLimit
        ) {
          timelineTruncated = true;
        }

        for (const row of scannedCommitRows) {
          const commit: ConsoleCommitListItem = {
            commitSeq: coerceNumber(row.commit_seq) ?? 0,
            actorId: row.actor_id ?? '',
            clientId: row.client_id ?? '',
            clientCommitId: row.client_commit_id ?? '',
            createdAt: row.created_at ?? '',
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
          };

          items.push({
            type: 'commit',
            timestamp: commit.createdAt,
            commit,
            event: null,
          });
        }
      }

      if (view !== 'commits') {
        let eventsQuery = db
          .selectFrom('sync_request_events')
          .select(requestEventSelectColumns);

        if (partitionId) {
          eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
        }
        if (eventType) {
          eventsQuery = eventsQuery.where('event_type', '=', eventType);
        }
        if (actorId) {
          eventsQuery = eventsQuery.where('actor_id', '=', actorId);
        }
        if (clientId) {
          eventsQuery = eventsQuery.where('client_id', '=', clientId);
        }
        if (requestId) {
          eventsQuery = eventsQuery.where('request_id', '=', requestId);
        }
        if (resolvedTraceId) {
          eventsQuery = eventsQuery.where('trace_id', '=', resolvedTraceId);
        }
        if (outcome) {
          eventsQuery = eventsQuery.where('outcome', '=', outcome);
        }
        if (from) {
          eventsQuery = eventsQuery.where('created_at', '>=', from);
        }
        if (to) {
          eventsQuery = eventsQuery.where('created_at', '<=', to);
        }

        let eventsQueryWithOrdering = eventsQuery.orderBy('created_at', 'desc');
        if (timelineSourceScanLimit !== null) {
          eventsQueryWithOrdering = eventsQueryWithOrdering.limit(
            timelineSourceScanLimit + 1
          );
        }

        const eventRows = await eventsQueryWithOrdering.execute();
        const scannedEventRows =
          timelineSourceScanLimit === null
            ? eventRows
            : eventRows.slice(0, timelineSourceScanLimit);
        if (
          timelineSourceScanLimit !== null &&
          eventRows.length > timelineSourceScanLimit
        ) {
          timelineTruncated = true;
        }

        for (const row of scannedEventRows) {
          const event = mapRequestEvent(row);

          items.push({
            type: 'event',
            timestamp: event.createdAt,
            commit: null,
            event,
          });
        }
      }

      const filteredItems = items.filter((item) => {
        if (item.type === 'commit') {
          const commit = item.commit;
          if (!commit) return false;

          if (
            normalizedTable &&
            !(commit.affectedTables ?? []).includes(normalizedTable)
          ) {
            return false;
          }

          if (!normalizedSearchTerm) return true;

          const searchableCommitFields = [
            String(commit.commitSeq),
            commit.actorId,
            commit.clientId,
            commit.clientCommitId,
            ...(commit.affectedTables ?? []),
          ];

          return searchableCommitFields.some((field) =>
            includesSearchTerm(field, normalizedSearchTerm)
          );
        }

        const event = item.event;
        if (!event) return false;

        if (
          normalizedTable &&
          !(event.tables ?? []).includes(normalizedTable)
        ) {
          return false;
        }

        if (!normalizedSearchTerm) return true;

        const searchableEventFields = [
          String(event.eventId),
          event.requestId,
          event.traceId ?? '',
          event.actorId,
          event.clientId,
          event.outcome,
          event.responseStatus,
          event.errorCode ?? '',
          event.errorMessage ?? '',
          ...(event.tables ?? []),
        ];

        return searchableEventFields.some((field) =>
          includesSearchTerm(field, normalizedSearchTerm)
        );
      });

      filteredItems.sort(
        (a, b) => (parseDate(b.timestamp) ?? 0) - (parseDate(a.timestamp) ?? 0)
      );

      const total = filteredItems.length;
      const pagedItems = filteredItems.slice(offset, offset + limit);

      const response: ConsolePaginatedResponse<ConsoleTimelineItem> = {
        items: pagedItems,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      if (timelineTruncated) {
        c.header('X-Timeline-Truncated', 'true');
        if (timelineSourceScanLimit !== null) {
          c.header('X-Timeline-Scan-Limit', String(timelineSourceScanLimit));
        }
      }
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /commits
  // -------------------------------------------------------------------------

  routes.get(
    '/commits',
    describeConsoleRoute({
      summary: 'List commits',
      responses: {
        200: {
          description: 'Paginated commit list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleCommitListItemSchema)
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

      let query = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ]);

      let countQuery = db
        .selectFrom('sync_commits')
        .select(({ fn }) => fn.countAll().as('total'));

      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('commit_seq', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleCommitListItem[] = rows.map((row) => ({
        commitSeq: coerceNumber(row.commit_seq) ?? 0,
        actorId: row.actor_id ?? '',
        clientId: row.client_id ?? '',
        clientCommitId: row.client_commit_id ?? '',
        createdAt: row.created_at ?? '',
        changeCount: coerceNumber(row.change_count) ?? 0,
        affectedTables: options.dialect.dbToArray(row.affected_tables),
      }));

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleCommitListItem> = {
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
  // GET /commits/:seq
  // -------------------------------------------------------------------------

  routes.get(
    '/commits/:seq',
    describeConsoleRoute({
      summary: 'Get commit details',
      responses: {
        200: {
          description: 'Commit with changes',
          content: {
            'application/json': { schema: resolver(ConsoleCommitDetailSchema) },
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
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', commitSeqParamSchema),
    zValidator('query', commitDetailQuerySchema),
    async (c) => {
      const { seq } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let commitQuery = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ])
        .where('commit_seq', '=', seq);

      if (partitionId) {
        commitQuery = commitQuery.where('partition_id', '=', partitionId);
      }

      const commitRow = await commitQuery.executeTakeFirst();

      if (!commitRow) {
        return consoleNotFound(c);
      }

      let changesQuery = db
        .selectFrom('sync_changes')
        .select([
          'change_id',
          'table',
          'row_id',
          'op',
          'row_json',
          'row_version',
          'scopes',
        ])
        .where('commit_seq', '=', seq);

      if (partitionId) {
        changesQuery = changesQuery.where('partition_id', '=', partitionId);
      }

      const changeRows = await changesQuery
        .orderBy('change_id', 'asc')
        .execute();

      const changes: ConsoleChange[] = changeRows.map((row) => {
        const op = row.op === 'delete' ? 'delete' : 'upsert';
        return {
          ...summarizeAuditChange({
            table: row.table ?? '',
            op,
            rowJson: row.row_json,
            scopes: row.scopes,
          }),
          changeId: coerceNumber(row.change_id) ?? 0,
          table: row.table ?? '',
          rowId: row.row_id ?? '',
          op,
          rowVersion: coerceNumber(row.row_version),
        };
      });

      const commit: ConsoleCommitDetail = {
        commitSeq: coerceNumber(commitRow.commit_seq) ?? 0,
        actorId: commitRow.actor_id ?? '',
        clientId: commitRow.client_id ?? '',
        clientCommitId: commitRow.client_commit_id ?? '',
        createdAt: commitRow.created_at ?? '',
        changeCount: coerceNumber(commitRow.change_count) ?? 0,
        affectedTables: parseJsonStringArray(commitRow.affected_tables),
        changes,
      };

      return c.json(commit, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /row-history/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/row-history/:table/:rowId',
    describeConsoleRoute({
      summary: 'Get redacted row history',
      responses: {
        200: {
          description: 'Redacted row history with request-event links',
          content: {
            'application/json': {
              schema: resolver(ConsoleRowHistoryResponseSchema),
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
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', rowHistoryParamSchema),
    zValidator('query', rowHistoryQuerySchema),
    async (c) => {
      const { table, rowId } = c.req.valid('param');
      const {
        partitionId: requestedPartitionId,
        limit,
        beforeCommitSeq,
        afterCommitSeq,
      } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      const rows = await options.dialect.readAuditRowHistory(
        options.db as unknown as Kysely<SyncCoreDb>,
        {
          partitionId,
          table,
          rowId,
          scopes: {},
          limit,
          beforeCommitSeq,
          afterCommitSeq,
        }
      );
      if (rows.length === 0) {
        return consoleNotFound(c);
      }

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;
      const commitSeqs = Array.from(
        new Set(selectedRows.map((row) => Number(row.commit_seq)))
      );

      const eventRows =
        commitSeqs.length > 0
          ? await db
              .selectFrom('sync_request_events')
              .select(['event_id', 'commit_seq', 'request_id', 'trace_id'])
              .where('partition_id', '=', partitionId)
              .where('commit_seq', 'in', commitSeqs)
              .orderBy('event_id', 'asc')
              .execute()
          : [];
      const eventLinksByCommitSeq = new Map<
        number,
        {
          eventIds: Set<number>;
          requestIds: Set<string>;
          traceIds: Set<string>;
        }
      >();
      for (const row of eventRows) {
        const commitSeq = coerceNumber(row.commit_seq);
        if (commitSeq === null) continue;
        const links = eventLinksByCommitSeq.get(commitSeq) ?? {
          eventIds: new Set<number>(),
          requestIds: new Set<string>(),
          traceIds: new Set<string>(),
        };
        const eventId = coerceNumber(row.event_id);
        if (eventId !== null) links.eventIds.add(eventId);
        if (row.request_id) links.requestIds.add(row.request_id);
        if (row.trace_id) links.traceIds.add(row.trace_id);
        eventLinksByCommitSeq.set(commitSeq, links);
      }

      const response: ConsoleRowHistoryResponse = {
        table,
        rowId,
        partitionId,
        history: selectedRows.map((row) => {
          const commitSeq = Number(row.commit_seq);
          const links = eventLinksByCommitSeq.get(commitSeq);
          const summary = summarizeAuditChange({
            table: row.table,
            op: row.op,
            rowJson: row.row_json,
            scopes: row.scopes,
          });
          return {
            commitSeq,
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
            requestEventIds: links ? Array.from(links.eventIds) : [],
            requestIds: links ? Array.from(links.requestIds) : [],
            traceIds: links ? Array.from(links.traceIds) : [],
          };
        }),
        nextCursor,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /row-investigation/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/row-investigation/:table/:rowId',
    describeConsoleRoute({
      summary: 'Investigate row visibility',
      responses: {
        200: {
          description: 'Redacted row investigation with client/event hints',
          content: {
            'application/json': {
              schema: resolver(ConsoleRowInvestigationResponseSchema),
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
    zValidator('param', rowHistoryParamSchema),
    zValidator('query', rowInvestigationQuerySchema),
    async (c) => {
      const { table, rowId } = c.req.valid('param');
      const {
        partitionId: requestedPartitionId,
        clientId,
        limit,
        beforeCommitSeq,
        afterCommitSeq,
      } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      const rows = await options.dialect.readAuditRowHistory(
        options.db as unknown as Kysely<SyncCoreDb>,
        {
          partitionId,
          table,
          rowId,
          scopes: {},
          limit,
          beforeCommitSeq,
          afterCommitSeq,
        }
      );

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;
      const commitSeqs = Array.from(
        new Set(selectedRows.map((row) => Number(row.commit_seq)))
      );

      const eventLinkRows =
        commitSeqs.length > 0
          ? await db
              .selectFrom('sync_request_events')
              .select(['event_id', 'commit_seq', 'request_id', 'trace_id'])
              .where('partition_id', '=', partitionId)
              .where('commit_seq', 'in', commitSeqs)
              .orderBy('event_id', 'asc')
              .execute()
          : [];
      const eventLinksByCommitSeq = new Map<
        number,
        {
          eventIds: Set<number>;
          requestIds: Set<string>;
          traceIds: Set<string>;
        }
      >();
      for (const row of eventLinkRows) {
        const commitSeq = coerceNumber(row.commit_seq);
        if (commitSeq === null) continue;
        const links = eventLinksByCommitSeq.get(commitSeq) ?? {
          eventIds: new Set<number>(),
          requestIds: new Set<string>(),
          traceIds: new Set<string>(),
        };
        const eventId = coerceNumber(row.event_id);
        if (eventId !== null) links.eventIds.add(eventId);
        if (row.request_id) links.requestIds.add(row.request_id);
        if (row.trace_id) links.traceIds.add(row.trace_id);
        eventLinksByCommitSeq.set(commitSeq, links);
      }

      const history = selectedRows.map((row) => {
        const commitSeq = Number(row.commit_seq);
        const links = eventLinksByCommitSeq.get(commitSeq);
        const summary = summarizeAuditChange({
          table: row.table,
          op: row.op,
          rowJson: row.row_json,
          scopes: row.scopes,
        });
        return {
          commitSeq,
          actorId: row.actor_id,
          clientId: row.client_id,
          clientCommitId: row.client_commit_id,
          createdAt: row.created_at,
          changeId: Number(row.change_id),
          table: row.table,
          rowId: row.row_id,
          op: row.op,
          rowVersion: row.row_version === null ? null : Number(row.row_version),
          ...summary,
          requestEventIds: links ? Array.from(links.eventIds) : [],
          requestIds: links ? Array.from(links.requestIds) : [],
          traceIds: links ? Array.from(links.traceIds) : [],
        };
      });

      const latestRow = selectedRows[0] ?? null;
      const latestCommitSeq = latestRow
        ? (coerceNumber(latestRow.commit_seq) ?? 0)
        : null;
      const latestOp =
        latestRow?.op === 'delete' || latestRow?.op === 'upsert'
          ? latestRow.op
          : null;

      const clientRow = clientId
        ? await db
            .selectFrom('sync_client_cursors')
            .select([
              'client_id',
              'actor_id',
              'cursor',
              'effective_scopes',
              'updated_at',
            ])
            .where('partition_id', '=', partitionId)
            .where('client_id', '=', clientId)
            .executeTakeFirst()
        : null;

      const eventRows = await db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('partition_id', '=', partitionId)
        .$if(Boolean(clientId), (query) =>
          query.where('client_id', '=', clientId ?? '')
        )
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(limit * 5, 25), 200))
        .execute();
      const relevantEvents = eventRows
        .map((row) => mapRequestEvent(row))
        .filter((event) => (event.tables ?? []).includes(table))
        .slice(0, limit);
      const subscriptionEvidence =
        summarizeSubscriptionEvidence(relevantEvents);
      const requestEvidence = summarizeRequestEvidence(relevantEvents);
      const snapshotEvidence = summarizeSnapshotEvidence(relevantEvents);
      const realtimeRows = clientId
        ? await db
            .selectFrom('sync_realtime_events')
            .select([
              'event_id',
              'event_type',
              'reason',
              'cursor',
              'latest_cursor',
            ])
            .where('partition_id', '=', partitionId)
            .where('client_id', '=', clientId)
            .orderBy('created_at', 'desc')
            .limit(Math.min(Math.max(limit * 5, 25), 200))
            .execute()
        : [];
      const realtimeEvidence = summarizeRealtimeEvidence(realtimeRows);

      const latestClientEvent = relevantEvents.find(
        (event) => !clientId || event.clientId === clientId
      );
      const clientScopes = clientRow
        ? (options.dialect.dbToScopes(
            clientRow.effective_scopes
          ) as ScopeValues)
        : null;
      const latestRowScopes = latestRow
        ? options.dialect.dbToScopes(latestRow.scopes)
        : null;
      const client: ConsoleRowInvestigationClient | null = clientRow
        ? {
            clientId: clientRow.client_id ?? '',
            actorId: clientRow.actor_id ?? '',
            cursor: coerceNumber(clientRow.cursor) ?? 0,
            effectiveScopeKeys: Object.keys(clientScopes ?? {}).sort(),
            updatedAt: clientRow.updated_at ?? '',
            lastRequestAt: latestClientEvent?.createdAt ?? null,
            lastRequestType: latestClientEvent?.eventType ?? null,
            lastRequestOutcome: latestClientEvent?.outcome ?? null,
          }
        : null;

      const scopeEligibility = assessScopeEligibility({
        rowScopes: latestRowScopes,
        clientScopes,
      });
      const findings: ConsoleRowInvestigationFinding[] = [];
      if (!latestRow) {
        findings.push({
          severity: 'warning',
          code: 'row.not_found',
          message:
            'No audit entry exists for this table and row in the selected partition.',
        });
      }
      if (!clientId) {
        findings.push({
          severity: 'info',
          code: 'client.not_selected',
          message:
            'Provide a client id to check cursor position and scope eligibility.',
        });
      } else if (!client) {
        findings.push({
          severity: 'warning',
          code: 'client.not_found',
          message:
            'No client cursor exists for this client in the selected partition.',
        });
      }
      if (latestOp === 'delete') {
        findings.push({
          severity: 'warning',
          code: 'row.deleted',
          message: 'The latest recorded operation for this row is a delete.',
        });
      }
      if (
        client &&
        latestCommitSeq !== null &&
        client.cursor < latestCommitSeq
      ) {
        findings.push({
          severity: 'warning',
          code: 'client.cursor_behind',
          message:
            'The client cursor is behind the latest row commit, so the row may not have been pulled yet.',
        });
      }
      if (scopeEligibility.status === 'not_eligible') {
        findings.push({
          severity: 'warning',
          code: 'scope.not_eligible',
          message:
            'The client effective scopes do not cover the latest row scopes.',
        });
      }
      if (relevantEvents.length === 0) {
        findings.push({
          severity: 'info',
          code: 'events.none_for_table',
          message:
            'No recent request events mention this table for the selected filters.',
        });
      } else if (subscriptionEvidence.status === 'revoked') {
        findings.push({
          severity: 'warning',
          code: 'subscription.revoked',
          message:
            'A relevant pull event reported at least one revoked subscription.',
        });
      } else if (subscriptionEvidence.status === 'unknown') {
        findings.push({
          severity: 'info',
          code: 'subscription.not_recorded',
          message:
            'Relevant events exist, but none include subscription-count evidence.',
        });
      } else if (subscriptionEvidence.status === 'not_observed') {
        findings.push({
          severity: 'warning',
          code: 'subscription.not_observed',
          message:
            'Relevant pull events did not report an active subscription for this table.',
        });
      }
      if (latestClientEvent && latestClientEvent.responseStatus !== 'success') {
        findings.push({
          severity: 'warning',
          code: 'events.latest_not_success',
          message:
            'The latest relevant request event did not complete successfully.',
        });
      }

      const response: ConsoleRowInvestigationResponse = {
        table,
        rowId,
        partitionId,
        clientId: clientId ?? null,
        rowKnown: history.length > 0,
        latestCommitSeq,
        latestOp,
        client,
        scopeEligibility,
        subscriptionEvidence,
        requestEvidence,
        snapshotEvidence,
        realtimeEvidence,
        history,
        relevantEvents,
        findings,
        nextCursor,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /debug/export
  // -------------------------------------------------------------------------

  routes.get(
    '/debug/export',
    describeConsoleRoute({
      summary: 'Export a redacted debug bundle',
      responses: {
        200: {
          description: 'Size-bounded redacted debug export',
          content: {
            'application/json': {
              schema: resolver(ConsoleDebugExportResponseSchema),
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
    zValidator('query', debugExportQuerySchema),
    async (c) => {
      const {
        partitionId: requestedPartitionId,
        limitCommits,
        limitEvents,
      } = c.req.valid('query');
      const { from, to } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      let commitsQuery = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ])
        .where('partition_id', '=', partitionId);
      if (from) commitsQuery = commitsQuery.where('created_at', '>=', from);
      if (to) commitsQuery = commitsQuery.where('created_at', '<=', to);

      let eventsQuery = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('partition_id', '=', partitionId);
      if (from) eventsQuery = eventsQuery.where('created_at', '>=', from);
      if (to) eventsQuery = eventsQuery.where('created_at', '<=', to);

      const [commitRows, eventRows] = await Promise.all([
        commitsQuery
          .orderBy('commit_seq', 'desc')
          .limit(limitCommits + 1)
          .execute(),
        eventsQuery
          .orderBy('created_at', 'desc')
          .limit(limitEvents + 1)
          .execute(),
      ]);

      const selectedCommitRows = commitRows.slice(0, limitCommits);
      const selectedEventRows = eventRows.slice(0, limitEvents);
      const commitSeqs = selectedCommitRows
        .map((row) => coerceNumber(row.commit_seq))
        .filter((seq): seq is number => seq !== null);
      const changesByCommitSeq = await readRedactedCommitChanges(
        partitionId,
        commitSeqs
      );

      const commits: ConsoleDebugExportCommit[] = selectedCommitRows.map(
        (row) => {
          const commitSeq = coerceNumber(row.commit_seq) ?? 0;
          return {
            commitSeq,
            actorId: row.actor_id ?? '',
            clientId: row.client_id ?? '',
            clientCommitId: row.client_commit_id ?? '',
            createdAt: row.created_at ?? '',
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
            changes: changesByCommitSeq.get(commitSeq) ?? [],
          };
        }
      );

      const response: ConsoleDebugExportResponse = {
        generatedAt: new Date().toISOString(),
        partitionId,
        limits: {
          commits: limitCommits,
          requestEvents: limitEvents,
        },
        truncated: {
          commits: commitRows.length > limitCommits,
          requestEvents: eventRows.length > limitEvents,
        },
        commits,
        requestEvents: selectedEventRows.map(mapDebugExportEvent),
      };

      return c.json(response, 200);
    }
  );
}
