/**
 * @syncular/server-hono - Console routes shared context.
 *
 * Holds the setup block (middleware, config, and closure helpers) that was
 * previously inlined at the top of createConsoleRoutes. Route modules receive
 * this context and destructure the bindings they need.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { createSyncularErrorResponse, logSyncEvent } from '@syncular/core';
import {
  coerceNumber,
  parseJsonValue,
  type SyncCoreDb,
  toDialectJsonValue,
} from '@syncular/server';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Generated, Kysely, Selectable } from 'kysely';
import { summarizeAuditChange } from '../../audit-redaction';
import { isBenignConsoleSchemaError } from '../schema-errors';
import {
  type ConsoleChange,
  type ConsoleClientDiagnosticRecord,
  ConsoleClientDiagnosticRecordSchema,
  type ConsoleDebugExportEvent,
  type ConsoleOperationEvent,
  type ConsoleOperationType,
  type ConsoleRequestEvent,
} from '../schemas';
import type { ConsoleAuthResult, CreateConsoleRoutesOptions } from '../types';
import {
  clientDiagnosticStoreKey,
  consoleRouteError,
  DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS,
  DEFAULT_CLIENT_DIAGNOSTICS_MAX_RECORDS,
  DEFAULT_OPERATION_EVENTS_MAX_AGE_MS,
  DEFAULT_OPERATION_EVENTS_MAX_ROWS,
  DEFAULT_REQUEST_EVENTS_MAX_AGE_MS,
  DEFAULT_REQUEST_EVENTS_MAX_ROWS,
  DEFAULT_TIMELINE_SCAN_MAX_ROWS,
  normalizeRequestEventType,
  parseResponseSummary,
  parseScopesSummary,
  readNonNegativeInteger,
  readStringProperty,
} from './shared';

interface SyncRequestEventsTable {
  event_id: number;
  partition_id: string;
  request_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  event_type: string;
  sync_path: string;
  transport_path: string;
  actor_id: string;
  client_id: string;
  status_code: number;
  outcome: string;
  response_status: string;
  error_code: string | null;
  duration_ms: number;
  commit_seq: number | null;
  operation_count: number | null;
  row_count: number | null;
  subscription_count: number | null;
  scopes_summary: unknown | null;
  response_summary: unknown | null;
  tables: unknown;
  error_message: string | null;
  payload_ref: string | null;
  created_at: string;
}

interface SyncRequestPayloadsTable {
  payload_ref: string;
  partition_id: string;
  request_payload: unknown;
  response_payload: unknown | null;
  created_at: string;
}

interface SyncApiKeysTable {
  key_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  key_type: string;
  scope_keys: unknown | null;
  actor_id: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface SyncOperationEventsTable {
  operation_id: Generated<number>;
  operation_type: string;
  console_user_id: string | null;
  partition_id: string | null;
  target_client_id: string | null;
  request_payload: unknown | null;
  result_payload: unknown | null;
  created_at: Generated<string>;
}

interface SyncRealtimeEventsTable {
  event_id: Generated<number>;
  partition_id: string;
  actor_id: string;
  client_id: string;
  transport_path: string;
  event_type: string;
  reason: string | null;
  cursor: number | null;
  latest_cursor: number | null;
  commit_seq: number | null;
  scope_count: number | null;
  skipped_count: number | null;
  sync_pack_encoding: string | null;
  created_at: Generated<string>;
}

interface SyncClientDiagnosticSnapshotsTable {
  snapshot_id: Generated<number>;
  partition_id: string;
  client_id: string;
  actor_id: string | null;
  runtime_kind: string | null;
  runtime_version: string | null;
  schema_version: number | null;
  reported_at: string;
  received_at: Generated<string>;
  lifecycle_phase: string | null;
  connection_state: string | null;
  freshness_state: string;
  health_max_severity: string | null;
  diagnostic_codes_summary: unknown | null;
  queue_summary: unknown | null;
  timing_summary: unknown | null;
  redaction_summary: unknown | null;
  snapshot_json: unknown;
}

type SyncOperationEventRow = Selectable<SyncOperationEventsTable>;
type SyncClientDiagnosticSnapshotRow =
  Selectable<SyncClientDiagnosticSnapshotsTable>;

interface ConsoleDb extends SyncCoreDb {
  sync_request_events: SyncRequestEventsTable;
  sync_request_payloads: SyncRequestPayloadsTable;
  sync_operation_events: SyncOperationEventsTable;
  sync_realtime_events: SyncRealtimeEventsTable;
  sync_client_diagnostic_snapshots: SyncClientDiagnosticSnapshotsTable;
  sync_api_keys: SyncApiKeysTable;
}

type PruneEventsRunResult = {
  requestEventsDeleted: number;
  operationEventsDeleted: number;
  realtimeEventsDeleted: number;
  payloadSnapshotsDeleted: number;
  totalDeleted: number;
};

export function createConsoleRoutesContext(
  options: CreateConsoleRoutesOptions
) {
  const routes = new Hono<{
    Variables: { consoleAuth: ConsoleAuthResult };
  }>();

  routes.onError((error, context) => {
    const message =
      error instanceof Error ? error.message : 'Unknown console error';
    console.error('[console] route error', error);
    return context.json(
      createSyncularErrorResponse('console.internal', { message }),
      500
    );
  });

  const db = options.db as Pick<
    Kysely<ConsoleDb>,
    'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
  >;
  const metricsAggregationMode = options.metrics?.aggregationMode ?? 'auto';
  const rawFallbackMaxEvents = Math.max(
    1,
    options.metrics?.rawFallbackMaxEvents ?? 5000
  );
  const requestEventsMaxAgeMs = readNonNegativeInteger(
    options.maintenance?.requestEventsMaxAgeMs,
    DEFAULT_REQUEST_EVENTS_MAX_AGE_MS
  );
  const requestEventsMaxRows = readNonNegativeInteger(
    options.maintenance?.requestEventsMaxRows,
    DEFAULT_REQUEST_EVENTS_MAX_ROWS
  );
  const operationEventsMaxAgeMs = readNonNegativeInteger(
    options.maintenance?.operationEventsMaxAgeMs,
    DEFAULT_OPERATION_EVENTS_MAX_AGE_MS
  );
  const operationEventsMaxRows = readNonNegativeInteger(
    options.maintenance?.operationEventsMaxRows,
    DEFAULT_OPERATION_EVENTS_MAX_ROWS
  );
  const timelineScanMaxRows = readNonNegativeInteger(
    options.maintenance?.timelineScanMaxRows,
    DEFAULT_TIMELINE_SCAN_MAX_ROWS
  );
  const autoEventsPruneIntervalMs = readNonNegativeInteger(
    options.maintenance?.autoPruneIntervalMs,
    DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS
  );
  const clientDiagnosticsMaxRecords = readNonNegativeInteger(
    options.maintenance?.clientDiagnosticsMaxRows,
    DEFAULT_CLIENT_DIAGNOSTICS_MAX_RECORDS
  );
  let lastEventsPruneRunAt = 0;

  // Ensure console schema exists before handlers query console tables.
  const consoleSchemaReadyPromise = (
    options.consoleSchemaReady ??
    options.dialect.ensureConsoleSchema?.(options.db) ??
    Promise.resolve()
  ).catch((err) => {
    if (isBenignConsoleSchemaError(err)) {
      return;
    }
    console.error('[console] Failed to ensure console schema:', err);
    throw err;
  });

  // CORS configuration
  const corsOrigins = options.corsOrigins ?? [
    'http://localhost:5173',
    'https://console.sync.dev',
  ];
  const allowWildcardCors = corsOrigins === '*';

  routes.use(
    '*',
    cors({
      origin: allowWildcardCors ? '*' : corsOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-Syncular-Transport-Path',
        'Baggage',
        'Sentry-Trace',
        'Traceparent',
        'Tracestate',
      ],
      exposeHeaders: ['X-Total-Count'],
      credentials: !allowWildcardCors,
    })
  );

  const ensureConsoleSchemaReady = async (
    c: Context
  ): Promise<Response | null> => {
    try {
      await consoleSchemaReadyPromise;
      return null;
    } catch {
      return consoleRouteError(c, 503, 'console.schema_unavailable');
    }
  };

  routes.use('*', async (c, next) => {
    const readyError = await ensureConsoleSchemaReady(c);
    if (readyError) {
      return readyError;
    }
    await next();
  });

  routes.use('*', async (c, next) => {
    if (c.req.method !== 'OPTIONS') {
      triggerAutomaticEventsPrune();
    }
    await next();
  });

  // Route auth middleware. Keep /events/live exempt so browser WebSocket
  // clients can authenticate with the first message instead of a header.
  routes.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path.endsWith('/events/live')) {
      await next();
      return;
    }

    const auth = await options.authenticate(c);
    if (!auth) {
      return consoleRouteError(c, 401, 'console.auth_required');
    }

    c.set('consoleAuth', auth);
    await next();
  });

  const requestEventSelectColumns = [
    'event_id',
    'partition_id',
    'request_id',
    'trace_id',
    'span_id',
    'event_type',
    'sync_path',
    'transport_path',
    'actor_id',
    'client_id',
    'status_code',
    'outcome',
    'response_status',
    'error_code',
    'duration_ms',
    'commit_seq',
    'operation_count',
    'row_count',
    'subscription_count',
    'scopes_summary',
    'response_summary',
    'tables',
    'error_message',
    'payload_ref',
    'created_at',
  ] as const;

  const mapRequestEvent = (
    row: SyncRequestEventsTable
  ): ConsoleRequestEvent => ({
    eventId: coerceNumber(row.event_id) ?? 0,
    partitionId: row.partition_id ?? 'default',
    requestId: row.request_id ?? '',
    traceId: row.trace_id ?? null,
    spanId: row.span_id ?? null,
    eventType: normalizeRequestEventType(row.event_type),
    syncPath: row.sync_path === 'ws-push' ? 'ws-push' : 'http-combined',
    transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
    actorId: row.actor_id ?? '',
    clientId: row.client_id ?? '',
    statusCode: coerceNumber(row.status_code) ?? 0,
    outcome: row.outcome ?? '',
    responseStatus: row.response_status ?? 'unknown',
    errorCode: row.error_code ?? null,
    durationMs: coerceNumber(row.duration_ms) ?? 0,
    commitSeq: coerceNumber(row.commit_seq),
    operationCount: coerceNumber(row.operation_count),
    rowCount: coerceNumber(row.row_count),
    subscriptionCount: coerceNumber(row.subscription_count),
    scopesSummary: parseScopesSummary(row.scopes_summary),
    responseSummary: parseResponseSummary(row.response_summary),
    tables: options.dialect.dbToArray(row.tables),
    errorMessage: row.error_message ?? null,
    payloadRef: row.payload_ref ?? null,
    createdAt: row.created_at ?? '',
  });

  const mapDebugExportEvent = (
    row: SyncRequestEventsTable
  ): ConsoleDebugExportEvent => {
    const mapped = mapRequestEvent(row);
    return {
      eventId: mapped.eventId,
      partitionId: mapped.partitionId,
      requestId: mapped.requestId,
      traceId: mapped.traceId,
      spanId: mapped.spanId,
      eventType: mapped.eventType,
      syncPath: mapped.syncPath,
      transportPath: mapped.transportPath,
      actorId: mapped.actorId,
      clientId: mapped.clientId,
      statusCode: mapped.statusCode,
      outcome: mapped.outcome,
      responseStatus: mapped.responseStatus,
      errorCode: mapped.errorCode,
      durationMs: mapped.durationMs,
      commitSeq: mapped.commitSeq,
      operationCount: mapped.operationCount,
      rowCount: mapped.rowCount,
      subscriptionCount: mapped.subscriptionCount,
      scopesSummary: mapped.scopesSummary,
      responseSummary: mapped.responseSummary,
      tables: mapped.tables,
      createdAt: mapped.createdAt,
    };
  };

  const operationEventSelectColumns = [
    'operation_id',
    'operation_type',
    'console_user_id',
    'partition_id',
    'target_client_id',
    'request_payload',
    'result_payload',
    'created_at',
  ] as const;

  const mapOperationEvent = (
    row: SyncOperationEventRow
  ): ConsoleOperationEvent => ({
    operationId: coerceNumber(row.operation_id) ?? 0,
    operationType:
      row.operation_type === 'prune' ||
      row.operation_type === 'compact' ||
      row.operation_type === 'notify_data_change' ||
      row.operation_type === 'evict_client'
        ? row.operation_type
        : 'prune',
    consoleUserId: row.console_user_id ?? null,
    partitionId: row.partition_id ?? null,
    targetClientId: row.target_client_id ?? null,
    requestPayload: parseJsonValue(row.request_payload),
    resultPayload: parseJsonValue(row.result_payload),
    createdAt: row.created_at ?? '',
  });

  const readRedactedCommitChanges = async (
    partitionId: string,
    commitSeqs: readonly number[]
  ): Promise<Map<number, ConsoleChange[]>> => {
    if (commitSeqs.length === 0) {
      return new Map();
    }

    const rows = await db
      .selectFrom('sync_changes')
      .select([
        'commit_seq',
        'change_id',
        'table',
        'row_id',
        'op',
        'row_json',
        'row_version',
        'scopes',
      ])
      .where('partition_id', '=', partitionId)
      .where('commit_seq', 'in', [...commitSeqs])
      .orderBy('commit_seq', 'asc')
      .orderBy('change_id', 'asc')
      .execute();

    const changesByCommitSeq = new Map<number, ConsoleChange[]>();
    for (const row of rows) {
      const commitSeq = coerceNumber(row.commit_seq);
      if (commitSeq === null) continue;
      const changes = changesByCommitSeq.get(commitSeq) ?? [];
      changes.push({
        ...summarizeAuditChange({
          table: row.table ?? '',
          op: row.op === 'delete' ? 'delete' : 'upsert',
          rowJson: row.row_json,
          scopes: row.scopes,
        }),
        changeId: coerceNumber(row.change_id) ?? 0,
        table: row.table ?? '',
        rowId: row.row_id ?? '',
        op: row.op === 'delete' ? 'delete' : 'upsert',
        rowVersion: coerceNumber(row.row_version),
      });
      changesByCommitSeq.set(commitSeq, changes);
    }

    return changesByCommitSeq;
  };

  const deleteUnreferencedPayloadSnapshots = async (): Promise<number> => {
    const result = await db
      .deleteFrom('sync_request_payloads')
      .where(
        'payload_ref',
        'not in',
        db
          .selectFrom('sync_request_events')
          .select('payload_ref')
          .where('payload_ref', 'is not', null)
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRequestEventsByAge = async (): Promise<number> => {
    if (requestEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - requestEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_request_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRequestEventsByCount = async (): Promise<number> => {
    if (requestEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_request_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();

    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= requestEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_request_events')
      .select(['event_id'])
      .orderBy('event_id', 'desc')
      .offset(requestEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffEventId = coerceNumber(cutoffRow?.event_id);
    if (cutoffEventId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_request_events')
      .where('event_id', '<=', cutoffEventId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneOperationEventsByAge = async (): Promise<number> => {
    if (operationEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - operationEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_operation_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneOperationEventsByCount = async (): Promise<number> => {
    if (operationEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_operation_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= operationEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_operation_events')
      .select(['operation_id'])
      .orderBy('operation_id', 'desc')
      .offset(operationEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffOperationId = coerceNumber(cutoffRow?.operation_id);
    if (cutoffOperationId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_operation_events')
      .where('operation_id', '<=', cutoffOperationId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRealtimeEventsByAge = async (): Promise<number> => {
    if (requestEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - requestEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_realtime_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRealtimeEventsByCount = async (): Promise<number> => {
    if (requestEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_realtime_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= requestEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_realtime_events')
      .select(['event_id'])
      .orderBy('event_id', 'desc')
      .offset(requestEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffEventId = coerceNumber(cutoffRow?.event_id);
    if (cutoffEventId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_realtime_events')
      .where('event_id', '<=', cutoffEventId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneConsoleEvents = async (): Promise<PruneEventsRunResult> => {
    const requestEventsDeletedByAge = await pruneRequestEventsByAge();
    const requestEventsDeletedByCount = await pruneRequestEventsByCount();
    const requestEventsDeleted =
      requestEventsDeletedByAge + requestEventsDeletedByCount;

    const operationEventsDeletedByAge = await pruneOperationEventsByAge();
    const operationEventsDeletedByCount = await pruneOperationEventsByCount();
    const operationEventsDeleted =
      operationEventsDeletedByAge + operationEventsDeletedByCount;

    const realtimeEventsDeletedByAge = await pruneRealtimeEventsByAge();
    const realtimeEventsDeletedByCount = await pruneRealtimeEventsByCount();
    const realtimeEventsDeleted =
      realtimeEventsDeletedByAge + realtimeEventsDeletedByCount;

    const payloadSnapshotsDeleted = await deleteUnreferencedPayloadSnapshots();
    const totalDeleted =
      requestEventsDeleted + operationEventsDeleted + realtimeEventsDeleted;

    return {
      requestEventsDeleted,
      operationEventsDeleted,
      realtimeEventsDeleted,
      payloadSnapshotsDeleted,
      totalDeleted,
    };
  };

  let eventsPrunePromise: Promise<PruneEventsRunResult> | null = null;

  const runEventsPrune = async (): Promise<PruneEventsRunResult> => {
    if (eventsPrunePromise) {
      return eventsPrunePromise;
    }

    let pending: Promise<PruneEventsRunResult>;
    pending = pruneConsoleEvents()
      .then((result) => {
        lastEventsPruneRunAt = Date.now();
        return result;
      })
      .finally(() => {
        if (eventsPrunePromise === pending) {
          eventsPrunePromise = null;
        }
      });

    eventsPrunePromise = pending;
    return pending;
  };

  const triggerAutomaticEventsPrune = (): void => {
    if (autoEventsPruneIntervalMs <= 0) {
      return;
    }
    if (eventsPrunePromise) {
      return;
    }
    if (Date.now() - lastEventsPruneRunAt < autoEventsPruneIntervalMs) {
      return;
    }

    void runEventsPrune()
      .then((result) => {
        if (result.totalDeleted <= 0 && result.payloadSnapshotsDeleted <= 0) {
          return;
        }

        logSyncEvent({
          event: 'console.prune_events_auto',
          deletedCount: result.totalDeleted,
          requestEventsDeleted: result.requestEventsDeleted,
          operationEventsDeleted: result.operationEventsDeleted,
          realtimeEventsDeleted: result.realtimeEventsDeleted,
          payloadDeletedCount: result.payloadSnapshotsDeleted,
        });
      })
      .catch((error) => {
        logSyncEvent({
          event: 'console.prune_events_auto_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const recordOperationEvent = async (event: {
    operationType: ConsoleOperationType;
    consoleUserId?: string;
    partitionId?: string | null;
    targetClientId?: string | null;
    requestPayload?: unknown;
    resultPayload?: unknown;
  }) => {
    await db
      .insertInto('sync_operation_events')
      .values({
        operation_type: event.operationType,
        console_user_id: event.consoleUserId ?? null,
        partition_id: event.partitionId ?? null,
        target_client_id: event.targetClientId ?? null,
        request_payload:
          event.requestPayload === undefined
            ? null
            : JSON.stringify(event.requestPayload),
        result_payload:
          event.resultPayload === undefined
            ? null
            : JSON.stringify(event.resultPayload),
      })
      .execute();
  };

  const parseClientDiagnosticSnapshotRow = (
    row: SyncClientDiagnosticSnapshotRow
  ): ConsoleClientDiagnosticRecord | null => {
    const parsed = parseJsonValue(row.snapshot_json);
    const record = ConsoleClientDiagnosticRecordSchema.safeParse(parsed);
    if (!record.success) {
      return null;
    }
    return record.data;
  };

  const readClientDiagnosticRecords = async (args: {
    clientId?: string;
    clientIds?: string[];
    latestOnly: boolean;
    limit?: number;
    offset?: number;
    partitionId?: string;
  }): Promise<{ items: ConsoleClientDiagnosticRecord[]; total: number }> => {
    let query = db.selectFrom('sync_client_diagnostic_snapshots').selectAll();

    if (args.partitionId) {
      query = query.where('partition_id', '=', args.partitionId);
    }
    if (args.clientId) {
      query = query.where('client_id', '=', args.clientId);
    }
    if (args.clientIds && args.clientIds.length > 0) {
      query = query.where('client_id', 'in', args.clientIds);
    }

    const rows = await query
      .orderBy('received_at', 'desc')
      .orderBy('snapshot_id', 'desc')
      .execute();
    const items: ConsoleClientDiagnosticRecord[] = [];
    const latestKeys = new Set<string>();

    for (const row of rows) {
      const record = parseClientDiagnosticSnapshotRow(row);
      if (!record) {
        continue;
      }
      if (args.latestOnly) {
        const key = clientDiagnosticStoreKey(
          record.partitionId,
          record.clientId
        );
        if (latestKeys.has(key)) {
          continue;
        }
        latestKeys.add(key);
      }
      items.push(record);
    }

    const offset = args.offset ?? 0;
    const limit = args.limit ?? items.length;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
    };
  };

  const writeClientDiagnosticRecord = async (
    record: ConsoleClientDiagnosticRecord
  ): Promise<void> => {
    await db
      .insertInto('sync_client_diagnostic_snapshots')
      .values({
        partition_id: record.partitionId,
        client_id: record.clientId,
        actor_id: record.actorId,
        runtime_kind:
          record.runtime?.rust?.crateName ??
          record.runtime?.packageName ??
          null,
        runtime_version:
          record.runtime?.rust?.crateVersion ??
          record.runtime?.packageVersion ??
          null,
        schema_version: record.runtime?.rust?.schemaVersion ?? null,
        reported_at: record.reportedAt,
        received_at: record.receivedAt,
        lifecycle_phase: readStringProperty(record.lifecycle, 'phase'),
        connection_state:
          readStringProperty(record.connection, 'realtime') ??
          readStringProperty(record.lifecycle, 'realtime'),
        freshness_state: record.freshnessState,
        health_max_severity: record.healthMaxSeverity,
        diagnostic_codes_summary: toDialectJsonValue(
          options.dialect,
          record.diagnosticCodesSummary
        ),
        queue_summary: toDialectJsonValue(options.dialect, record.queueSummary),
        timing_summary: toDialectJsonValue(
          options.dialect,
          record.timingSummary
        ),
        redaction_summary: toDialectJsonValue(
          options.dialect,
          record.redactionSummary
        ),
        snapshot_json: toDialectJsonValue(options.dialect, record),
      })
      .execute();
  };

  const pruneClientDiagnosticRecordsByCount = async (): Promise<void> => {
    if (clientDiagnosticsMaxRecords <= 0) {
      return;
    }

    const countRow = await db
      .selectFrom('sync_client_diagnostic_snapshots')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= clientDiagnosticsMaxRecords) {
      return;
    }

    const cutoffRow = await db
      .selectFrom('sync_client_diagnostic_snapshots')
      .select(['snapshot_id'])
      .orderBy('snapshot_id', 'desc')
      .offset(clientDiagnosticsMaxRecords)
      .limit(1)
      .executeTakeFirst();
    const cutoffSnapshotId = coerceNumber(cutoffRow?.snapshot_id);
    if (cutoffSnapshotId === null) {
      return;
    }

    await db
      .deleteFrom('sync_client_diagnostic_snapshots')
      .where('snapshot_id', '<=', cutoffSnapshotId)
      .executeTakeFirst();
  };

  const shouldUseRawMetrics = async (
    startIso: string,
    partitionId?: string
  ): Promise<boolean> => {
    if (metricsAggregationMode === 'raw') {
      return true;
    }
    if (metricsAggregationMode === 'aggregated') {
      return false;
    }

    let countQuery = db
      .selectFrom('sync_request_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('created_at', '>=', startIso);

    if (partitionId) {
      countQuery = countQuery.where('partition_id', '=', partitionId);
    }

    const countRow = await countQuery.executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    return total <= rawFallbackMaxEvents;
  };
  return {
    routes,
    options,
    db,
    metricsAggregationMode,
    rawFallbackMaxEvents,
    requestEventsMaxAgeMs,
    requestEventsMaxRows,
    operationEventsMaxAgeMs,
    operationEventsMaxRows,
    timelineScanMaxRows,
    autoEventsPruneIntervalMs,
    clientDiagnosticsMaxRecords,
    consoleSchemaReadyPromise,
    corsOrigins,
    allowWildcardCors,
    ensureConsoleSchemaReady,
    requestEventSelectColumns,
    mapRequestEvent,
    mapDebugExportEvent,
    operationEventSelectColumns,
    mapOperationEvent,
    readRedactedCommitChanges,
    deleteUnreferencedPayloadSnapshots,
    pruneRequestEventsByAge,
    pruneRequestEventsByCount,
    pruneOperationEventsByAge,
    pruneOperationEventsByCount,
    pruneRealtimeEventsByAge,
    pruneRealtimeEventsByCount,
    pruneConsoleEvents,
    runEventsPrune,
    triggerAutomaticEventsPrune,
    recordOperationEvent,
    parseClientDiagnosticSnapshotRow,
    readClientDiagnosticRecords,
    writeClientDiagnosticRecord,
    pruneClientDiagnosticRecordsByCount,
    shouldUseRawMetrics,
  };
}

export type ConsoleRoutesContext = ReturnType<
  typeof createConsoleRoutesContext
>;
