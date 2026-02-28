import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi';
import { z } from 'zod';
import {
  closeUnauthenticatedSocket,
  parseBearerToken,
  parseWebSocketAuthToken,
} from './live-auth';
import type {
  ConsoleApiKey,
  ConsoleApiKeyBulkRevokeResponse,
  ConsoleApiKeyCreateResponse,
  ConsoleClearEventsResult,
  ConsoleClient,
  ConsoleCommitListItem,
  ConsoleCompactResult,
  ConsoleEvictResult,
  ConsoleOperationEvent,
  ConsolePaginatedResponse,
  ConsolePruneEventsResult,
  ConsolePrunePreview,
  ConsolePruneResult,
  ConsoleRequestEvent,
  ConsoleTimelineItem,
  LatencyPercentiles,
  LatencyStatsResponse,
  SyncStats,
  TimeseriesBucket,
  TimeseriesStatsResponse,
} from './schemas';
import {
  ApiKeyTypeSchema,
  ConsoleApiKeyBulkRevokeRequestSchema,
  ConsoleApiKeyBulkRevokeResponseSchema,
  ConsoleApiKeyCreateRequestSchema,
  ConsoleApiKeyCreateResponseSchema,
  ConsoleApiKeyRevokeResponseSchema,
  ConsoleApiKeySchema,
  ConsoleClearEventsResultSchema,
  ConsoleClientSchema,
  ConsoleCommitDetailSchema,
  ConsoleCommitListItemSchema,
  ConsoleCompactResultSchema,
  ConsoleEvictResultSchema,
  ConsoleHandlerSchema,
  ConsoleOperationEventSchema,
  ConsoleOperationsQuerySchema,
  ConsolePaginatedResponseSchema,
  ConsolePaginationQuerySchema,
  ConsolePartitionedPaginationQuerySchema,
  ConsolePartitionQuerySchema,
  ConsolePruneEventsResultSchema,
  ConsolePrunePreviewSchema,
  ConsolePruneResultSchema,
  ConsoleRequestEventSchema,
  ConsoleRequestPayloadSchema,
  ConsoleTimelineItemSchema,
  ConsoleTimelineQuerySchema,
  LatencyQuerySchema,
  LatencyStatsResponseSchema,
  SyncStatsSchema,
  TimeseriesQuerySchema,
  TimeseriesStatsResponseSchema,
} from './schemas';
import type { ConsoleAuthResult } from './types';

export interface ConsoleGatewayInstance {
  instanceId: string;
  label?: string;
  baseUrl: string;
  token?: string;
  enabled?: boolean;
}

interface ConsoleGatewayDownstreamSocket {
  onopen?: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
  send?: (data: string) => void;
}

export interface CreateConsoleGatewayRoutesOptions {
  instances: ConsoleGatewayInstance[];
  authenticate: (c: Context) => Promise<ConsoleAuthResult | null>;
  corsOrigins?: string[] | '*';
  fetchImpl?: typeof fetch;
  websocket?: {
    enabled?: boolean;
    upgradeWebSocket?: UpgradeWebSocket;
    heartbeatIntervalMs?: number;
    createWebSocket?: (url: string) => ConsoleGatewayDownstreamSocket;
  };
}

interface GatewayFailure {
  instanceId: string;
  reason: string;
  status?: number;
}

const GatewayFailureSchema = z.object({
  instanceId: z.string(),
  reason: z.string(),
  status: z.number().int().optional(),
});

const GatewayMetadataSchema = z.object({
  partial: z.boolean(),
  failedInstances: z.array(GatewayFailureSchema),
});

const GatewayInstanceSchema = z.object({
  instanceId: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
});

const GatewayInstancesResponseSchema = z.object({
  items: z.array(GatewayInstanceSchema),
});

const GatewayInstanceHealthSchema = GatewayInstanceSchema.extend({
  healthy: z.boolean(),
  status: z.number().int().optional(),
  reason: z.string().optional(),
  responseTimeMs: z.number().int().nonnegative(),
  checkedAt: z.string(),
});

const GatewayInstancesHealthResponseSchema = z.object({
  items: z.array(GatewayInstanceHealthSchema),
  partial: GatewayMetadataSchema.shape.partial,
  failedInstances: GatewayMetadataSchema.shape.failedInstances,
});

const GatewayInstanceFilterSchema = z.object({
  instanceId: z.string().min(1).optional(),
  instanceIds: z.string().min(1).optional(),
});

const GatewayStatsQuerySchema = ConsolePartitionQuerySchema.extend(
  GatewayInstanceFilterSchema.shape
);

const GatewayTimeseriesQuerySchema = TimeseriesQuerySchema.extend(
  GatewayInstanceFilterSchema.shape
);

const GatewayLatencyQuerySchema = LatencyQuerySchema.extend(
  GatewayInstanceFilterSchema.shape
);

const GatewaySingleInstanceQuerySchema = GatewayInstanceFilterSchema;

const GatewaySingleInstancePartitionQuerySchema =
  ConsolePartitionQuerySchema.extend(GatewayInstanceFilterSchema.shape);

type GatewayInstanceFilterQuery = {
  instanceId?: string;
  instanceIds?: string;
};

const GatewayApiKeyStatusSchema = z.enum(['active', 'revoked', 'expiring']);

const GatewayApiKeysQuerySchema = ConsolePaginationQuerySchema.extend({
  ...GatewayInstanceFilterSchema.shape,
  type: ApiKeyTypeSchema.optional(),
  status: GatewayApiKeyStatusSchema.optional(),
  expiresWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

const GatewayPaginatedQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend(
    GatewayInstanceFilterSchema.shape
  );

const GatewayTimelineQuerySchema = ConsoleTimelineQuerySchema.extend(
  GatewayInstanceFilterSchema.shape
);

const GatewayOperationsQuerySchema = ConsoleOperationsQuerySchema.extend(
  GatewayInstanceFilterSchema.shape
);

const GatewayEventsQuerySchema = ConsolePartitionedPaginationQuerySchema.extend(
  {
    ...GatewayInstanceFilterSchema.shape,
    eventType: z.enum(['push', 'pull']).optional(),
    actorId: z.string().optional(),
    clientId: z.string().optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    outcome: z.string().optional(),
  }
);

const GatewayEventPathParamSchema = z.object({
  id: z.string().min(1),
});

const GatewayCommitPathParamSchema = z.object({
  seq: z.string().min(1),
});

const GatewayClientPathParamSchema = z.object({
  id: z.string().min(1),
});

const GatewayApiKeyPathParamSchema = z.object({
  id: z.string().min(1),
});

const GatewayNotifyDataChangeRequestSchema = z.object({
  tables: z.array(z.string().min(1)).min(1),
  partitionId: z.string().optional(),
});

const GatewayNotifyDataChangeResponseSchema = z.object({
  commitSeq: z.number(),
  tables: z.array(z.string()),
  deletedChunks: z.number(),
});

const GatewayHandlersResponseSchema = z.object({
  items: z.array(ConsoleHandlerSchema),
});

const GatewayCommitItemSchema = ConsoleCommitListItemSchema.extend({
  instanceId: z.string(),
  federatedCommitId: z.string(),
});

const GatewayCommitDetailSchema = ConsoleCommitDetailSchema.extend({
  instanceId: z.string(),
  federatedCommitId: z.string(),
  localCommitSeq: z.number().int(),
});

const GatewayClientItemSchema = ConsoleClientSchema.extend({
  instanceId: z.string(),
  federatedClientId: z.string(),
});

const GatewayTimelineItemSchema = ConsoleTimelineItemSchema.extend({
  instanceId: z.string(),
  federatedTimelineId: z.string(),
  localCommitSeq: z.number().int().nullable(),
  localEventId: z.number().int().nullable(),
});

const GatewayOperationItemSchema = ConsoleOperationEventSchema.extend({
  instanceId: z.string(),
  federatedOperationId: z.string(),
  localOperationId: z.number().int(),
});

const GatewayEventItemSchema = ConsoleRequestEventSchema.extend({
  instanceId: z.string(),
  federatedEventId: z.string(),
  localEventId: z.number().int(),
});

const GatewayEventPayloadSchema = ConsoleRequestPayloadSchema.extend({
  instanceId: z.string(),
  federatedEventId: z.string(),
  localEventId: z.number().int(),
});

const GatewayStatsResponseSchema = SyncStatsSchema.extend({
  maxCommitSeqByInstance: z.record(z.string(), z.number().int()),
  minCommitSeqByInstance: z.record(z.string(), z.number().int()),
  partial: GatewayMetadataSchema.shape.partial,
  failedInstances: GatewayMetadataSchema.shape.failedInstances,
});

const GatewayTimeseriesResponseSchema = TimeseriesStatsResponseSchema.extend({
  partial: GatewayMetadataSchema.shape.partial,
  failedInstances: GatewayMetadataSchema.shape.failedInstances,
});

const GatewayLatencyResponseSchema = LatencyStatsResponseSchema.extend({
  partial: GatewayMetadataSchema.shape.partial,
  failedInstances: GatewayMetadataSchema.shape.failedInstances,
});

const GatewayPaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T
) =>
  ConsolePaginatedResponseSchema(itemSchema).extend({
    partial: GatewayMetadataSchema.shape.partial,
    failedInstances: GatewayMetadataSchema.shape.failedInstances,
  });

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Request failed';
}

function resolveBaseUrl(baseUrl: string, requestUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    return new URL(baseUrl, requestUrl);
  }
}

function normalizeInstances(
  instances: ConsoleGatewayInstance[]
): ConsoleGatewayInstance[] {
  if (instances.length === 0) {
    throw new Error('Console gateway requires at least one instance');
  }

  const seen = new Set<string>();
  return instances.map((instance) => {
    const normalizedInstanceId = instance.instanceId.trim();
    if (!normalizedInstanceId) {
      throw new Error('Console gateway instanceId cannot be empty');
    }
    if (seen.has(normalizedInstanceId)) {
      throw new Error(
        `Duplicate console gateway instanceId: ${normalizedInstanceId}`
      );
    }
    seen.add(normalizedInstanceId);

    const normalizedBaseUrl = instance.baseUrl.trim();
    if (!normalizedBaseUrl) {
      throw new Error(
        `Console gateway baseUrl cannot be empty for instance: ${normalizedInstanceId}`
      );
    }

    return {
      instanceId: normalizedInstanceId,
      label: instance.label?.trim() || normalizedInstanceId,
      baseUrl: normalizedBaseUrl,
      token: instance.token?.trim(),
      enabled: instance.enabled ?? true,
    };
  });
}

function parseRequestedInstanceIds(query: {
  instanceId?: string;
  instanceIds?: string;
}): Set<string> {
  const ids = new Set<string>();
  const single = query.instanceId?.trim();
  if (single) {
    ids.add(single);
  }

  const multi = query.instanceIds
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const value of multi ?? []) {
    ids.add(value);
  }

  return ids;
}

function selectInstances(args: {
  instances: ConsoleGatewayInstance[];
  query: { instanceId?: string; instanceIds?: string };
}): ConsoleGatewayInstance[] {
  const enabledInstances = args.instances.filter(
    (instance) => instance.enabled
  );
  const requestedIds = parseRequestedInstanceIds(args.query);
  if (requestedIds.size === 0) {
    return enabledInstances;
  }
  return enabledInstances.filter((instance) =>
    requestedIds.has(instance.instanceId)
  );
}

function findInstanceById(args: {
  instances: ConsoleGatewayInstance[];
  instanceId: string;
}): ConsoleGatewayInstance | null {
  const instance = args.instances.find(
    (candidate) =>
      candidate.instanceId === args.instanceId && Boolean(candidate.enabled)
  );
  return instance ?? null;
}

function parseFederatedNumericId(value: string): {
  instanceId: string;
  localId: number;
} | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  const instanceId = value.slice(0, separatorIndex).trim();
  const localIdRaw = value.slice(separatorIndex + 1).trim();
  const localId = Number(localIdRaw);
  if (!instanceId || !Number.isInteger(localId) || localId <= 0) {
    return null;
  }

  return { instanceId, localId };
}

function parseLocalNumericId(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function noInstancesSelectedResponse(): {
  ok: false;
  status: 400;
  error: 'NO_INSTANCES_SELECTED';
  message: string;
} {
  return {
    ok: false,
    status: 400,
    error: 'NO_INSTANCES_SELECTED',
    message: 'No enabled instances matched the provided instance filter.',
  };
}

function resolveSingleSelectedInstance(args: {
  instances: ConsoleGatewayInstance[];
  query: GatewayInstanceFilterQuery;
  onMultiple: { error: string; message: string };
}):
  | { ok: true; instance: ConsoleGatewayInstance }
  | { ok: false; status: 400; error: string; message: string } {
  const selectedInstances = selectInstances(args);
  if (selectedInstances.length === 0) {
    return noInstancesSelectedResponse();
  }
  if (selectedInstances.length > 1) {
    return {
      ok: false,
      status: 400,
      error: args.onMultiple.error,
      message: args.onMultiple.message,
    };
  }

  const instance = selectedInstances[0];
  if (!instance) {
    return noInstancesSelectedResponse();
  }
  return { ok: true, instance };
}

function resolveFederatedOrLocalNumericTarget(args: {
  id: string;
  instances: ConsoleGatewayInstance[];
  query: GatewayInstanceFilterQuery;
  invalidMessage: string;
  ambiguousError: string;
  ambiguousMessage: string;
}):
  | { ok: true; instance: ConsoleGatewayInstance; localId: number }
  | { ok: false; status: 400 | 404; error: string; message?: string } {
  const federated = parseFederatedNumericId(args.id);
  if (federated) {
    const instance = findInstanceById({
      instances: args.instances,
      instanceId: federated.instanceId,
    });
    if (!instance) {
      return {
        ok: false,
        status: 404,
        error: 'NOT_FOUND',
        message: 'Instance not found',
      };
    }
    return { ok: true, instance, localId: federated.localId };
  }

  const localId = parseLocalNumericId(args.id);
  if (localId === null) {
    return {
      ok: false,
      status: 400,
      error: 'INVALID_FEDERATED_ID',
      message: args.invalidMessage,
    };
  }

  const selection = resolveSingleSelectedInstance({
    instances: args.instances,
    query: args.query,
    onMultiple: {
      error: args.ambiguousError,
      message: args.ambiguousMessage,
    },
  });
  if (!selection.ok) return selection;

  return { ok: true, instance: selection.instance, localId };
}

function resolveEventTarget(args: {
  id: string;
  instances: ConsoleGatewayInstance[];
  query: GatewayInstanceFilterQuery;
}):
  | { ok: true; instance: ConsoleGatewayInstance; localEventId: number }
  | { ok: false; status: 400 | 404; error: string; message?: string } {
  const resolved = resolveFederatedOrLocalNumericTarget({
    id: args.id,
    instances: args.instances,
    query: args.query,
    invalidMessage:
      'Expected either "<instanceId>:<eventId>" or "<eventId>" with an explicit instance filter.',
    ambiguousError: 'AMBIGUOUS_EVENT_ID',
    ambiguousMessage:
      'Local event IDs are ambiguous across multiple instances. Use "<instanceId>:<eventId>" or select one instance.',
  });
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    instance: resolved.instance,
    localEventId: resolved.localId,
  };
}

function resolveCommitTarget(args: {
  seq: string;
  instances: ConsoleGatewayInstance[];
  query: GatewayInstanceFilterQuery;
}):
  | { ok: true; instance: ConsoleGatewayInstance; localCommitSeq: number }
  | { ok: false; status: 400 | 404; error: string; message?: string } {
  const resolved = resolveFederatedOrLocalNumericTarget({
    id: args.seq,
    instances: args.instances,
    query: args.query,
    invalidMessage:
      'Expected either "<instanceId>:<commitSeq>" or "<commitSeq>" with an explicit instance filter.',
    ambiguousError: 'AMBIGUOUS_COMMIT_ID',
    ambiguousMessage:
      'Local commit IDs are ambiguous across multiple instances. Use "<instanceId>:<commitSeq>" or select one instance.',
  });
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    instance: resolved.instance,
    localCommitSeq: resolved.localId,
  };
}

function resolveSingleInstanceTarget(args: {
  instances: ConsoleGatewayInstance[];
  query: GatewayInstanceFilterQuery;
}):
  | { ok: true; instance: ConsoleGatewayInstance }
  | { ok: false; status: 400; error: string; message: string } {
  return resolveSingleSelectedInstance({
    ...args,
    onMultiple: {
      error: 'INSTANCE_REQUIRED',
      message:
        'This endpoint requires exactly one target instance. Provide `instanceId` or a single-value `instanceIds` filter.',
    },
  });
}

function minNullable(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value !== null);
  if (filtered.length === 0) return null;
  return Math.min(...filtered);
}

function maxNullable(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value !== null);
  if (filtered.length === 0) return null;
  return Math.max(...filtered);
}

function compareIsoDesc(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
  if (!Number.isFinite(aMs)) return 1;
  if (!Number.isFinite(bMs)) return -1;
  return bMs - aMs;
}

interface TimeseriesBucketAccumulator {
  pushCount: number;
  pullCount: number;
  errorCount: number;
  latencySum: number;
  eventCount: number;
}

function createTimeseriesBucketAccumulator(): TimeseriesBucketAccumulator {
  return {
    pushCount: 0,
    pullCount: 0,
    errorCount: 0,
    latencySum: 0,
    eventCount: 0,
  };
}

function mergeTimeseriesBuckets(
  responses: TimeseriesStatsResponse[]
): TimeseriesBucket[] {
  const bucketMap = new Map<string, TimeseriesBucketAccumulator>();

  for (const response of responses) {
    for (const bucket of response.buckets) {
      const existing =
        bucketMap.get(bucket.timestamp) ?? createTimeseriesBucketAccumulator();
      existing.pushCount += bucket.pushCount;
      existing.pullCount += bucket.pullCount;
      existing.errorCount += bucket.errorCount;

      const bucketEventCount = bucket.pushCount + bucket.pullCount;
      if (bucketEventCount > 0) {
        existing.latencySum += bucket.avgLatencyMs * bucketEventCount;
        existing.eventCount += bucketEventCount;
      }

      bucketMap.set(bucket.timestamp, existing);
    }
  }

  return Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, bucket]) => ({
      timestamp,
      pushCount: bucket.pushCount,
      pullCount: bucket.pullCount,
      errorCount: bucket.errorCount,
      avgLatencyMs:
        bucket.eventCount > 0 ? bucket.latencySum / bucket.eventCount : 0,
    }));
}

function averagePercentiles(values: LatencyPercentiles[]): LatencyPercentiles {
  if (values.length === 0) {
    return { p50: 0, p90: 0, p99: 0 };
  }

  return {
    p50: values.reduce((acc, value) => acc + value.p50, 0) / values.length,
    p90: values.reduce((acc, value) => acc + value.p90, 0) / values.length,
    p99: values.reduce((acc, value) => acc + value.p99, 0) / values.length,
  };
}

function sanitizeForwardQueryParams(query: URLSearchParams): URLSearchParams {
  const sanitized = new URLSearchParams(query);
  sanitized.delete('instanceId');
  sanitized.delete('instanceIds');
  return sanitized;
}

function withPaging(
  params: URLSearchParams,
  paging: { limit: number; offset: number }
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('limit', String(paging.limit));
  next.set('offset', String(paging.offset));
  return next;
}

function buildConsoleEndpointUrl(args: {
  instance: ConsoleGatewayInstance;
  requestUrl: string;
  path: string;
  query?: URLSearchParams;
}): string {
  const baseUrl = resolveBaseUrl(args.instance.baseUrl, args.requestUrl);
  const basePath = baseUrl.pathname.endsWith('/')
    ? baseUrl.pathname.slice(0, -1)
    : baseUrl.pathname;
  const suffix = args.path.startsWith('/') ? args.path : `/${args.path}`;
  baseUrl.pathname = `${basePath}/console${suffix}`;
  baseUrl.search = args.query?.toString() ?? '';
  return baseUrl.toString();
}

function resolveForwardAuthorization(args: {
  c: Context;
  instance: ConsoleGatewayInstance;
}): string | null {
  if (args.instance.token) {
    return `Bearer ${args.instance.token}`;
  }
  const header = args.c.req.header('Authorization')?.trim();
  if (header) {
    return header;
  }
  return null;
}

async function fetchDownstreamJson<T>(args: {
  c: Context;
  instance: ConsoleGatewayInstance;
  path: string;
  query?: URLSearchParams;
  schema: z.ZodType<T>;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; data: T } | { ok: false; failure: GatewayFailure }> {
  const url = buildConsoleEndpointUrl({
    instance: args.instance,
    requestUrl: args.c.req.url,
    path: args.path,
    query: args.query,
  });

  const headers = new Headers();
  headers.set('Accept', 'application/json');
  const authorization = resolveForwardAuthorization({
    c: args.c,
    instance: args.instance,
  });
  if (authorization) {
    headers.set('Authorization', authorization);
  }

  try {
    const response = await args.fetchImpl(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      return {
        ok: false,
        failure: {
          instanceId: args.instance.instanceId,
          reason: `HTTP ${response.status}`,
          status: response.status,
        },
      };
    }

    const payload = await response.json();
    const parsed = args.schema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          instanceId: args.instance.instanceId,
          reason: 'Invalid response payload',
        },
      };
    }

    return { ok: true, data: parsed.data };
  } catch (error) {
    return {
      ok: false,
      failure: {
        instanceId: args.instance.instanceId,
        reason: toErrorMessage(error),
      },
    };
  }
}

async function parseDownstreamBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeDownstreamError(args: {
  body: unknown;
  status: number;
  instanceId: string;
}): Record<string, unknown> {
  if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) {
    return {
      ...(args.body as Record<string, unknown>),
      instanceId: args.instanceId,
    };
  }

  if (typeof args.body === 'string' && args.body.trim().length > 0) {
    return {
      error: 'DOWNSTREAM_ERROR',
      message: args.body,
      instanceId: args.instanceId,
    };
  }

  return {
    error: 'DOWNSTREAM_ERROR',
    status: args.status,
    instanceId: args.instanceId,
  };
}

async function forwardDownstreamJsonRequest<T>(args: {
  c: Context;
  instance: ConsoleGatewayInstance;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  responseSchema: z.ZodType<T>;
  fetchImpl: typeof fetch;
}): Promise<
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const url = buildConsoleEndpointUrl({
    instance: args.instance,
    requestUrl: args.c.req.url,
    path: args.path,
    query: args.query,
  });

  const headers = new Headers();
  headers.set('Accept', 'application/json');
  const authorization = resolveForwardAuthorization({
    c: args.c,
    instance: args.instance,
  });
  if (authorization) {
    headers.set('Authorization', authorization);
  }

  let requestBody: string | undefined;
  if (args.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(args.body);
  }

  try {
    const response = await args.fetchImpl(url, {
      method: args.method,
      headers,
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    });

    const payload = await parseDownstreamBody(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: normalizeDownstreamError({
          body: payload,
          status: response.status,
          instanceId: args.instance.instanceId,
        }),
      };
    }

    const parsed = args.responseSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        status: 502,
        body: {
          error: 'INVALID_DOWNSTREAM_RESPONSE',
          message: 'Downstream response failed validation.',
          instanceId: args.instance.instanceId,
        },
      };
    }

    return {
      ok: true,
      data: parsed.data,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'DOWNSTREAM_UNAVAILABLE',
        message: toErrorMessage(error),
        instanceId: args.instance.instanceId,
      },
    };
  }
}

async function fetchDownstreamPaged<T>(args: {
  c: Context;
  instance: ConsoleGatewayInstance;
  path: string;
  query: URLSearchParams;
  targetCount: number;
  schema: z.ZodType<ConsolePaginatedResponse<T>>;
  fetchImpl: typeof fetch;
}): Promise<
  | { ok: true; items: T[]; total: number }
  | { ok: false; failure: GatewayFailure }
> {
  const items: T[] = [];
  let total: number | null = null;
  let localOffset = 0;
  let pageCount = 0;

  while (
    items.length < args.targetCount &&
    (total === null || localOffset < total) &&
    pageCount < 100
  ) {
    const limit = Math.min(100, Math.max(1, args.targetCount - items.length));
    const pagedQuery = withPaging(args.query, { limit, offset: localOffset });
    const result = await fetchDownstreamJson({
      c: args.c,
      instance: args.instance,
      path: args.path,
      query: pagedQuery,
      schema: args.schema,
      fetchImpl: args.fetchImpl,
    });

    if (!result.ok) {
      return result;
    }

    const page = result.data;
    total = page.total;
    items.push(...page.items);
    localOffset += page.items.length;
    pageCount += 1;

    if (page.items.length === 0) {
      break;
    }
  }

  return {
    ok: true,
    items,
    total: total ?? items.length,
  };
}

async function checkDownstreamInstanceHealth(args: {
  c: Context;
  instance: ConsoleGatewayInstance;
  fetchImpl: typeof fetch;
}): Promise<z.infer<typeof GatewayInstanceHealthSchema>> {
  const startedAt = Date.now();
  const result = await fetchDownstreamJson({
    c: args.c,
    instance: args.instance,
    path: '/stats',
    schema: SyncStatsSchema,
    fetchImpl: args.fetchImpl,
  });

  const responseTimeMs = Math.max(0, Date.now() - startedAt);
  const checkedAt = new Date().toISOString();
  const base = {
    instanceId: args.instance.instanceId,
    label: args.instance.label ?? args.instance.instanceId,
    baseUrl: args.instance.baseUrl,
    enabled: args.instance.enabled ?? true,
    responseTimeMs,
    checkedAt,
  };

  if (result.ok) {
    return {
      ...base,
      healthy: true,
      status: 200,
    };
  }

  return {
    ...base,
    healthy: false,
    status: result.failure.status,
    reason: result.failure.reason,
  };
}

function unauthorizedResponse(c: Context): Response {
  return c.json({ error: 'UNAUTHORIZED' }, 401);
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function allInstancesFailedResponse(
  c: Context,
  failedInstances: GatewayFailure[]
): Response {
  return c.json(
    {
      error: 'DOWNSTREAM_UNAVAILABLE',
      failedInstances,
    },
    502
  );
}

export function createConsoleGatewayRoutes(
  options: CreateConsoleGatewayRoutesOptions
): Hono {
  const routes = new Hono();
  const instances = normalizeInstances(options.instances);
  const fetchImpl = options.fetchImpl ?? fetch;
  const corsOrigins = options.corsOrigins ?? '*';

  routes.use(
    '*',
    cors({
      origin: corsOrigins === '*' ? '*' : corsOrigins,
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
      credentials: true,
    })
  );

  routes.get(
    '/instances',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List configured downstream console instances',
      responses: {
        200: {
          description: 'Configured instances',
          content: {
            'application/json': {
              schema: resolver(GatewayInstancesResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': {
              schema: resolver(z.object({ error: z.string() })),
            },
          },
        },
      },
    }),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      return c.json({
        items: instances.map((instance) => ({
          instanceId: instance.instanceId,
          label: instance.label ?? instance.instanceId,
          baseUrl: instance.baseUrl,
          enabled: instance.enabled ?? true,
        })),
      });
    }
  );

  routes.get(
    '/instances/health',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Probe downstream console health by instance',
      responses: {
        200: {
          description: 'Per-instance health results',
          content: {
            'application/json': {
              schema: resolver(GatewayInstancesHealthResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': {
              schema: resolver(z.object({ error: z.string() })),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayInstanceFilterSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const items = await Promise.all(
        selectedInstances.map((instance) =>
          checkDownstreamInstanceHealth({
            c,
            instance,
            fetchImpl,
          })
        )
      );

      const failedInstances = items
        .filter((item) => !item.healthy)
        .map((item) => ({
          instanceId: item.instanceId,
          reason: item.reason ?? 'Health probe failed',
          ...(item.status !== undefined ? { status: item.status } : {}),
        }));

      return c.json({
        items,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/handlers',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'List handlers for a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Handlers',
          content: {
            'application/json': {
              schema: resolver(GatewayHandlersResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest({
        c,
        instance: target.instance,
        method: 'GET',
        path: '/handlers',
        query: forwardQuery,
        responseSchema: GatewayHandlersResponseSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/prune/preview',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Preview prune on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Prune preview',
          content: {
            'application/json': {
              schema: resolver(ConsolePrunePreviewSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<ConsolePrunePreview>({
        c,
        instance: target.instance,
        method: 'POST',
        path: '/prune/preview',
        query: forwardQuery,
        responseSchema: ConsolePrunePreviewSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/prune',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Trigger prune on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Prune result',
          content: {
            'application/json': {
              schema: resolver(ConsolePruneResultSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<ConsolePruneResult>({
        c,
        instance: target.instance,
        method: 'POST',
        path: '/prune',
        query: forwardQuery,
        responseSchema: ConsolePruneResultSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/compact',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Trigger compaction on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Compaction result',
          content: {
            'application/json': {
              schema: resolver(ConsoleCompactResultSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<ConsoleCompactResult>({
        c,
        instance: target.instance,
        method: 'POST',
        path: '/compact',
        query: forwardQuery,
        responseSchema: ConsoleCompactResultSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/notify-data-change',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Notify data change on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Notification result',
          content: {
            'application/json': {
              schema: resolver(GatewayNotifyDataChangeResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    zValidator('json', GatewayNotifyDataChangeRequestSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const body = c.req.valid('json');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest({
        c,
        instance: target.instance,
        method: 'POST',
        path: '/notify-data-change',
        query: forwardQuery,
        body,
        responseSchema: GatewayNotifyDataChangeResponseSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.delete(
    '/clients/:id',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Evict client on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Evict result',
          content: {
            'application/json': {
              schema: resolver(ConsoleEvictResultSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayClientPathParamSchema),
    zValidator('query', GatewaySingleInstancePartitionQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<ConsoleEvictResult>({
        c,
        instance: target.instance,
        method: 'DELETE',
        path: `/clients/${encodeURIComponent(id)}`,
        query: forwardQuery,
        responseSchema: ConsoleEvictResultSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.delete(
    '/events',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Clear request events on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Clear result',
          content: {
            'application/json': {
              schema: resolver(ConsoleClearEventsResultSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsoleClearEventsResult>({
          c,
          instance: target.instance,
          method: 'DELETE',
          path: '/events',
          query: forwardQuery,
          responseSchema: ConsoleClearEventsResultSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/events/prune',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Prune request events on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Prune events result',
          content: {
            'application/json': {
              schema: resolver(ConsolePruneEventsResultSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsolePruneEventsResult>({
          c,
          instance: target.instance,
          method: 'POST',
          path: '/events/prune',
          query: forwardQuery,
          responseSchema: ConsolePruneEventsResultSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.get(
    '/api-keys',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'List API keys for a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Paginated API key list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleApiKeySchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayApiKeysQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<
        ConsolePaginatedResponse<ConsoleApiKey>
      >({
        c,
        instance: target.instance,
        method: 'GET',
        path: '/api-keys',
        query: forwardQuery,
        responseSchema: ConsolePaginatedResponseSchema(ConsoleApiKeySchema),
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/api-keys',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Create API key on a single target instance (requires instance selection)',
      responses: {
        201: {
          description: 'Created API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    zValidator('json', ConsoleApiKeyCreateRequestSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const body = c.req.valid('json');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsoleApiKeyCreateResponse>({
          c,
          instance: target.instance,
          method: 'POST',
          path: '/api-keys',
          query: forwardQuery,
          body,
          responseSchema: ConsoleApiKeyCreateResponseSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.get(
    '/api-keys/:id',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Get API key from a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'API key details',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeySchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayApiKeyPathParamSchema),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<ConsoleApiKey>({
        c,
        instance: target.instance,
        method: 'GET',
        path: `/api-keys/${encodeURIComponent(id)}`,
        query: forwardQuery,
        responseSchema: ConsoleApiKeySchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.delete(
    '/api-keys/:id',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Revoke API key on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyRevokeResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayApiKeyPathParamSchema),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await forwardDownstreamJsonRequest<{ revoked: boolean }>({
        c,
        instance: target.instance,
        method: 'DELETE',
        path: `/api-keys/${encodeURIComponent(id)}`,
        query: forwardQuery,
        responseSchema: ConsoleApiKeyRevokeResponseSchema,
        fetchImpl,
      });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/api-keys/bulk-revoke',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Bulk revoke API keys on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Bulk revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyBulkRevokeResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    zValidator('json', ConsoleApiKeyBulkRevokeRequestSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const body = c.req.valid('json');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsoleApiKeyBulkRevokeResponse>({
          c,
          instance: target.instance,
          method: 'POST',
          path: '/api-keys/bulk-revoke',
          query: forwardQuery,
          body,
          responseSchema: ConsoleApiKeyBulkRevokeResponseSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/api-keys/:id/rotate/stage',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Stage-rotate API key on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Staged API key replacement',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayApiKeyPathParamSchema),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsoleApiKeyCreateResponse>({
          c,
          instance: target.instance,
          method: 'POST',
          path: `/api-keys/${encodeURIComponent(id)}/rotate/stage`,
          query: forwardQuery,
          responseSchema: ConsoleApiKeyCreateResponseSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.post(
    '/api-keys/:id/rotate',
    describeRoute({
      tags: ['console-gateway'],
      summary:
        'Rotate API key on a single target instance (requires instance selection)',
      responses: {
        200: {
          description: 'Rotated API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayApiKeyPathParamSchema),
    zValidator('query', GatewaySingleInstanceQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveSingleInstanceTarget({ instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            message: target.message,
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result =
        await forwardDownstreamJsonRequest<ConsoleApiKeyCreateResponse>({
          c,
          instance: target.instance,
          method: 'POST',
          path: `/api-keys/${encodeURIComponent(id)}/rotate`,
          query: forwardQuery,
          responseSchema: ConsoleApiKeyCreateResponseSchema,
          fetchImpl,
        });

      if (!result.ok) {
        return jsonResponse(result.body, result.status);
      }

      return jsonResponse(result.data, result.status);
    }
  );

  routes.get(
    '/stats',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged sync stats across instances',
      responses: {
        200: {
          description: 'Merged stats',
          content: {
            'application/json': {
              schema: resolver(GatewayStatsResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayStatsQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamJson({
            c,
            instance,
            path: '/stats',
            query: forwardQuery,
            schema: SyncStatsSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successfulResults = results.filter(
        (result): result is { ok: true; data: SyncStats } => result.ok
      );

      if (successfulResults.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const statsByInstance = new Map<string, SyncStats>();
      for (let i = 0; i < selectedInstances.length; i++) {
        const result = results[i];
        if (!result || !result.ok) continue;
        const instance = selectedInstances[i];
        if (!instance) continue;
        statsByInstance.set(instance.instanceId, result.data);
      }

      const statsValues = Array.from(statsByInstance.values());
      const sum = (selector: (stats: SyncStats) => number): number =>
        statsValues.reduce((acc, stats) => acc + selector(stats), 0);

      const minCommitSeqByInstance: Record<string, number> = {};
      const maxCommitSeqByInstance: Record<string, number> = {};
      for (const [instanceId, stats] of statsByInstance.entries()) {
        minCommitSeqByInstance[instanceId] = stats.minCommitSeq;
        maxCommitSeqByInstance[instanceId] = stats.maxCommitSeq;
      }

      return c.json({
        commitCount: sum((stats) => stats.commitCount),
        changeCount: sum((stats) => stats.changeCount),
        minCommitSeq: Math.min(
          ...statsValues.map((stats) => stats.minCommitSeq)
        ),
        maxCommitSeq: Math.max(
          ...statsValues.map((stats) => stats.maxCommitSeq)
        ),
        clientCount: sum((stats) => stats.clientCount),
        activeClientCount: sum((stats) => stats.activeClientCount),
        minActiveClientCursor: minNullable(
          statsValues.map((stats) => stats.minActiveClientCursor)
        ),
        maxActiveClientCursor: maxNullable(
          statsValues.map((stats) => stats.maxActiveClientCursor)
        ),
        minCommitSeqByInstance,
        maxCommitSeqByInstance,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/stats/timeseries',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged time-series stats across instances',
      responses: {
        200: {
          description: 'Merged time-series stats',
          content: {
            'application/json': {
              schema: resolver(GatewayTimeseriesResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayTimeseriesQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamJson({
            c,
            instance,
            path: '/stats/timeseries',
            query: forwardQuery,
            schema: TimeseriesStatsResponseSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successfulResults = results.filter(
        (result): result is { ok: true; data: TimeseriesStatsResponse } =>
          result.ok
      );

      if (successfulResults.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      return c.json({
        buckets: mergeTimeseriesBuckets(
          successfulResults.map((result) => result.data)
        ),
        interval: query.interval,
        range: query.range,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/stats/latency',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged latency stats across instances',
      responses: {
        200: {
          description: 'Merged latency stats',
          content: {
            'application/json': {
              schema: resolver(GatewayLatencyResponseSchema),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayLatencyQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamJson({
            c,
            instance,
            path: '/stats/latency',
            query: forwardQuery,
            schema: LatencyStatsResponseSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successfulResults = results.filter(
        (result): result is { ok: true; data: LatencyStatsResponse } =>
          result.ok
      );

      if (successfulResults.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      return c.json({
        push: averagePercentiles(
          successfulResults.map((result) => result.data.push)
        ),
        pull: averagePercentiles(
          successfulResults.map((result) => result.data.pull)
        ),
        range: query.range,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/commits',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List merged commits across instances',
      responses: {
        200: {
          description: 'Merged commits',
          content: {
            'application/json': {
              schema: resolver(
                GatewayPaginatedResponseSchema(GatewayCommitItemSchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayPaginatedQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const targetCount = query.offset + query.limit;
      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      forwardQuery.delete('limit');
      forwardQuery.delete('offset');
      const pageSchema = ConsolePaginatedResponseSchema(
        ConsoleCommitListItemSchema
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamPaged({
            c,
            instance,
            path: '/commits',
            query: forwardQuery,
            targetCount,
            schema: pageSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successful = results
        .map((result, index) => ({
          result,
          instance: selectedInstances[index],
        }))
        .filter(
          (
            entry
          ): entry is {
            result: { ok: true; items: ConsoleCommitListItem[]; total: number };
            instance: ConsoleGatewayInstance;
          } => Boolean(entry.instance) && entry.result.ok
        );

      if (successful.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const merged = successful
        .flatMap(({ result, instance }) =>
          result.items.map((commit) => ({
            ...commit,
            instanceId: instance.instanceId,
            federatedCommitId: `${instance.instanceId}:${commit.commitSeq}`,
          }))
        )
        .sort((a, b) => {
          const byTime = compareIsoDesc(a.createdAt, b.createdAt);
          if (byTime !== 0) return byTime;
          const byInstance = a.instanceId.localeCompare(b.instanceId);
          if (byInstance !== 0) return byInstance;
          return b.commitSeq - a.commitSeq;
        });

      return c.json({
        items: merged.slice(query.offset, query.offset + query.limit),
        total: successful.reduce((acc, entry) => acc + entry.result.total, 0),
        offset: query.offset,
        limit: query.limit,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/commits/:seq',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged commit detail by federated id',
      responses: {
        200: {
          description: 'Commit detail',
          content: {
            'application/json': {
              schema: resolver(GatewayCommitDetailSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayCommitPathParamSchema),
    zValidator(
      'query',
      ConsolePartitionQuerySchema.extend(GatewayInstanceFilterSchema.shape)
    ),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { seq } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveCommitTarget({ seq, instances, query });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            ...(target.message ? { message: target.message } : {}),
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await fetchDownstreamJson({
        c,
        instance: target.instance,
        path: `/commits/${target.localCommitSeq}`,
        query: forwardQuery,
        schema: ConsoleCommitDetailSchema,
        fetchImpl,
      });

      if (!result.ok) {
        if (result.failure.status === 404) {
          return c.json({ error: 'NOT_FOUND' }, 404);
        }
        return c.json(
          {
            error: 'DOWNSTREAM_UNAVAILABLE',
            failedInstances: [result.failure],
          },
          502
        );
      }

      return c.json({
        ...result.data,
        instanceId: target.instance.instanceId,
        federatedCommitId: `${target.instance.instanceId}:${result.data.commitSeq}`,
        localCommitSeq: result.data.commitSeq,
      });
    }
  );

  routes.get(
    '/clients',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List merged clients across instances',
      responses: {
        200: {
          description: 'Merged clients',
          content: {
            'application/json': {
              schema: resolver(
                GatewayPaginatedResponseSchema(GatewayClientItemSchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayPaginatedQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const targetCount = query.offset + query.limit;
      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      forwardQuery.delete('limit');
      forwardQuery.delete('offset');
      const pageSchema = ConsolePaginatedResponseSchema(ConsoleClientSchema);

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamPaged({
            c,
            instance,
            path: '/clients',
            query: forwardQuery,
            targetCount,
            schema: pageSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successful = results
        .map((result, index) => ({
          result,
          instance: selectedInstances[index],
        }))
        .filter(
          (
            entry
          ): entry is {
            result: { ok: true; items: ConsoleClient[]; total: number };
            instance: ConsoleGatewayInstance;
          } => Boolean(entry.instance) && entry.result.ok
        );

      if (successful.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const merged = successful
        .flatMap(({ result, instance }) =>
          result.items.map((client) => ({
            ...client,
            instanceId: instance.instanceId,
            federatedClientId: `${instance.instanceId}:${client.clientId}`,
          }))
        )
        .sort((a, b) => {
          const byTime = compareIsoDesc(a.updatedAt, b.updatedAt);
          if (byTime !== 0) return byTime;
          const byInstance = a.instanceId.localeCompare(b.instanceId);
          if (byInstance !== 0) return byInstance;
          return a.clientId.localeCompare(b.clientId);
        });

      return c.json({
        items: merged.slice(query.offset, query.offset + query.limit),
        total: successful.reduce((acc, entry) => acc + entry.result.total, 0),
        offset: query.offset,
        limit: query.limit,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/timeline',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List merged timeline items across instances',
      responses: {
        200: {
          description: 'Merged timeline',
          content: {
            'application/json': {
              schema: resolver(
                GatewayPaginatedResponseSchema(GatewayTimelineItemSchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayTimelineQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const targetCount = query.offset + query.limit;
      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      forwardQuery.delete('limit');
      forwardQuery.delete('offset');
      const pageSchema = ConsolePaginatedResponseSchema(
        ConsoleTimelineItemSchema
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamPaged({
            c,
            instance,
            path: '/timeline',
            query: forwardQuery,
            targetCount,
            schema: pageSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successful = results
        .map((result, index) => ({
          result,
          instance: selectedInstances[index],
        }))
        .filter(
          (
            entry
          ): entry is {
            result: { ok: true; items: ConsoleTimelineItem[]; total: number };
            instance: ConsoleGatewayInstance;
          } => Boolean(entry.instance) && entry.result.ok
        );

      if (successful.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const merged = successful
        .flatMap(({ result, instance }) =>
          result.items.map((item) => {
            const localCommitSeq =
              item.type === 'commit' ? (item.commit?.commitSeq ?? null) : null;
            const localEventId =
              item.type === 'event' ? (item.event?.eventId ?? null) : null;
            const localIdSegment =
              item.type === 'commit'
                ? String(localCommitSeq ?? 'unknown')
                : String(localEventId ?? 'unknown');

            return {
              ...item,
              instanceId: instance.instanceId,
              federatedTimelineId: `${instance.instanceId}:${item.type}:${localIdSegment}`,
              localCommitSeq,
              localEventId,
            };
          })
        )
        .sort((a, b) => {
          const byTime = compareIsoDesc(a.timestamp, b.timestamp);
          if (byTime !== 0) return byTime;
          const byInstance = a.instanceId.localeCompare(b.instanceId);
          if (byInstance !== 0) return byInstance;
          const aLocalId = a.localCommitSeq ?? a.localEventId ?? 0;
          const bLocalId = b.localCommitSeq ?? b.localEventId ?? 0;
          return bLocalId - aLocalId;
        });

      return c.json({
        items: merged.slice(query.offset, query.offset + query.limit),
        total: successful.reduce((acc, entry) => acc + entry.result.total, 0),
        offset: query.offset,
        limit: query.limit,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/operations',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List merged operation events across instances',
      responses: {
        200: {
          description: 'Merged operations',
          content: {
            'application/json': {
              schema: resolver(
                GatewayPaginatedResponseSchema(GatewayOperationItemSchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayOperationsQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const targetCount = query.offset + query.limit;
      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      forwardQuery.delete('limit');
      forwardQuery.delete('offset');
      const pageSchema = ConsolePaginatedResponseSchema(
        ConsoleOperationEventSchema
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamPaged({
            c,
            instance,
            path: '/operations',
            query: forwardQuery,
            targetCount,
            schema: pageSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successful = results
        .map((result, index) => ({
          result,
          instance: selectedInstances[index],
        }))
        .filter(
          (
            entry
          ): entry is {
            result: { ok: true; items: ConsoleOperationEvent[]; total: number };
            instance: ConsoleGatewayInstance;
          } => Boolean(entry.instance) && entry.result.ok
        );

      if (successful.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const merged = successful
        .flatMap(({ result, instance }) =>
          result.items.map((operation) => ({
            ...operation,
            instanceId: instance.instanceId,
            federatedOperationId: `${instance.instanceId}:${operation.operationId}`,
            localOperationId: operation.operationId,
          }))
        )
        .sort((a, b) => {
          const byTime = compareIsoDesc(a.createdAt, b.createdAt);
          if (byTime !== 0) return byTime;
          const byInstance = a.instanceId.localeCompare(b.instanceId);
          if (byInstance !== 0) return byInstance;
          return b.localOperationId - a.localOperationId;
        });

      return c.json({
        items: merged.slice(query.offset, query.offset + query.limit),
        total: successful.reduce((acc, entry) => acc + entry.result.total, 0),
        offset: query.offset,
        limit: query.limit,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  routes.get(
    '/events',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'List merged request events across instances',
      responses: {
        200: {
          description: 'Merged events',
          content: {
            'application/json': {
              schema: resolver(
                GatewayPaginatedResponseSchema(GatewayEventItemSchema)
              ),
            },
          },
        },
      },
    }),
    zValidator('query', GatewayEventsQuerySchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const query = c.req.valid('query');
      const selectedInstances = selectInstances({ instances, query });
      if (selectedInstances.length === 0) {
        return c.json(
          {
            error: 'NO_INSTANCES_SELECTED',
            message:
              'No enabled instances matched the provided instance filter.',
          },
          400
        );
      }

      const targetCount = query.offset + query.limit;
      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      forwardQuery.delete('limit');
      forwardQuery.delete('offset');
      const pageSchema = ConsolePaginatedResponseSchema(
        ConsoleRequestEventSchema
      );

      const results = await Promise.all(
        selectedInstances.map((instance) =>
          fetchDownstreamPaged({
            c,
            instance,
            path: '/events',
            query: forwardQuery,
            targetCount,
            schema: pageSchema,
            fetchImpl,
          })
        )
      );

      const failedInstances = results
        .filter(
          (result): result is { ok: false; failure: GatewayFailure } =>
            !result.ok
        )
        .map((result) => result.failure);
      const successful = results
        .map((result, index) => ({
          result,
          instance: selectedInstances[index],
        }))
        .filter(
          (
            entry
          ): entry is {
            result: { ok: true; items: ConsoleRequestEvent[]; total: number };
            instance: ConsoleGatewayInstance;
          } => Boolean(entry.instance) && entry.result.ok
        );

      if (successful.length === 0) {
        return allInstancesFailedResponse(c, failedInstances);
      }

      const merged = successful
        .flatMap(({ result, instance }) =>
          result.items.map((event) => ({
            ...event,
            instanceId: instance.instanceId,
            federatedEventId: `${instance.instanceId}:${event.eventId}`,
            localEventId: event.eventId,
          }))
        )
        .sort((a, b) => {
          const byTime = compareIsoDesc(a.createdAt, b.createdAt);
          if (byTime !== 0) return byTime;
          const byInstance = a.instanceId.localeCompare(b.instanceId);
          if (byInstance !== 0) return byInstance;
          return b.localEventId - a.localEventId;
        });

      return c.json({
        items: merged.slice(query.offset, query.offset + query.limit),
        total: successful.reduce((acc, entry) => acc + entry.result.total, 0),
        offset: query.offset,
        limit: query.limit,
        partial: failedInstances.length > 0,
        failedInstances,
      });
    }
  );

  if (
    options.websocket?.enabled &&
    options.websocket?.upgradeWebSocket !== undefined
  ) {
    const upgradeWebSocket = options.websocket.upgradeWebSocket;
    const heartbeatIntervalMs = options.websocket.heartbeatIntervalMs ?? 30000;
    const createDownstreamSocket =
      options.websocket.createWebSocket ??
      ((url: string): ConsoleGatewayDownstreamSocket => new WebSocket(url));

    type WebSocketLike = {
      send: (data: string) => void;
      close: (code?: number, reason?: string) => void;
    };

    const liveState = new WeakMap<
      WebSocketLike,
      {
        downstreamSockets: ConsoleGatewayDownstreamSocket[];
        heartbeatInterval: ReturnType<typeof setInterval> | null;
        authTimeout: ReturnType<typeof setTimeout> | null;
        isAuthenticated: boolean;
        startAuthenticatedSession: ((token: string | null) => void) | null;
      }
    >();

    routes.get(
      '/events/live',
      upgradeWebSocket(async (c) => {
        const initialAuth = await options.authenticate(c);
        const partitionId = c.req.query('partitionId')?.trim() || undefined;
        const replaySince = c.req.query('since')?.trim() || undefined;
        const replayLimitRaw = c.req.query('replayLimit');
        const replayLimitNumber = replayLimitRaw
          ? Number.parseInt(replayLimitRaw, 10)
          : Number.NaN;
        const replayLimit = Number.isFinite(replayLimitNumber)
          ? Math.max(1, Math.min(500, replayLimitNumber))
          : 100;

        const selectedInstances = selectInstances({
          instances,
          query: {
            instanceId: c.req.query('instanceId') ?? undefined,
            instanceIds: c.req.query('instanceIds') ?? undefined,
          },
        });

        const authenticateWithBearer = async (
          token: string
        ): Promise<ConsoleAuthResult | null> => {
          const trimmedToken = token.trim();
          if (!trimmedToken) {
            return null;
          }
          const authContext = {
            req: {
              header: (name: string) =>
                name === 'Authorization' ? `Bearer ${trimmedToken}` : undefined,
              query: () => undefined,
            },
          } as unknown as Context;
          return options.authenticate(authContext);
        };

        const cleanup = (ws: WebSocketLike) => {
          const state = liveState.get(ws);
          if (!state) return;
          if (state.heartbeatInterval) {
            clearInterval(state.heartbeatInterval);
          }
          if (state.authTimeout) {
            clearTimeout(state.authTimeout);
          }
          for (const downstream of state.downstreamSockets) {
            try {
              downstream.close();
            } catch {
              // no-op
            }
          }
          liveState.delete(ws);
        };

        return {
          onOpen(_event, ws) {
            if (selectedInstances.length === 0) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message:
                    'No enabled instances matched the provided instance filter.',
                })
              );
              ws.close(4004, 'No instances selected');
              return;
            }

            const state: {
              downstreamSockets: ConsoleGatewayDownstreamSocket[];
              heartbeatInterval: ReturnType<typeof setInterval> | null;
              authTimeout: ReturnType<typeof setTimeout> | null;
              isAuthenticated: boolean;
              startAuthenticatedSession:
                | ((token: string | null) => void)
                | null;
            } = {
              downstreamSockets: [],
              heartbeatInterval: null,
              authTimeout: null,
              isAuthenticated: false,
              startAuthenticatedSession: null,
            };
            liveState.set(ws, state);

            const startAuthenticatedSession = (
              upstreamBearerToken: string | null
            ) => {
              if (state.isAuthenticated) {
                return;
              }
              state.isAuthenticated = true;
              if (state.authTimeout) {
                clearTimeout(state.authTimeout);
                state.authTimeout = null;
              }

              for (const instance of selectedInstances) {
                const downstreamQuery = new URLSearchParams();
                if (partitionId) {
                  downstreamQuery.set('partitionId', partitionId);
                }
                if (replaySince) {
                  downstreamQuery.set('since', replaySince);
                }
                downstreamQuery.set('replayLimit', String(replayLimit));

                const downstreamUrl = buildConsoleEndpointUrl({
                  instance,
                  requestUrl: c.req.url,
                  path: '/events/live',
                  query: downstreamQuery,
                });

                const downstreamSocket = createDownstreamSocket(downstreamUrl);
                const downstreamToken =
                  instance.token?.trim() ?? upstreamBearerToken?.trim() ?? null;
                if (downstreamToken && downstreamSocket.send) {
                  downstreamSocket.onopen = () => {
                    try {
                      downstreamSocket.send?.(
                        JSON.stringify({
                          type: 'auth',
                          token: downstreamToken,
                        })
                      );
                    } catch {
                      // no-op
                    }
                  };
                }

                downstreamSocket.onmessage = (message: MessageEvent) => {
                  if (typeof message.data !== 'string') {
                    return;
                  }
                  try {
                    const payload = JSON.parse(message.data) as Record<
                      string,
                      unknown
                    >;
                    if (
                      typeof payload.type === 'string' &&
                      (payload.type === 'connected' ||
                        payload.type === 'heartbeat')
                    ) {
                      return;
                    }

                    const payloadData =
                      payload.data &&
                      typeof payload.data === 'object' &&
                      !Array.isArray(payload.data)
                        ? { ...payload.data, instanceId: instance.instanceId }
                        : { instanceId: instance.instanceId };

                    const event = {
                      ...payload,
                      data: payloadData,
                      instanceId: instance.instanceId,
                      timestamp:
                        typeof payload.timestamp === 'string'
                          ? payload.timestamp
                          : new Date().toISOString(),
                    };
                    ws.send(JSON.stringify(event));
                  } catch {
                    // Ignore malformed downstream events
                  }
                };

                downstreamSocket.onerror = () => {
                  try {
                    ws.send(
                      JSON.stringify({
                        type: 'instance_error',
                        instanceId: instance.instanceId,
                        timestamp: new Date().toISOString(),
                      })
                    );
                  } catch {
                    // ignore send errors
                  }
                };

                state.downstreamSockets.push(downstreamSocket);
              }

              ws.send(
                JSON.stringify({
                  type: 'connected',
                  timestamp: new Date().toISOString(),
                  instanceCount: selectedInstances.length,
                })
              );

              const heartbeatInterval = setInterval(() => {
                try {
                  ws.send(
                    JSON.stringify({
                      type: 'heartbeat',
                      timestamp: new Date().toISOString(),
                    })
                  );
                } catch {
                  clearInterval(heartbeatInterval);
                }
              }, heartbeatIntervalMs);
              state.heartbeatInterval = heartbeatInterval;
            };
            state.startAuthenticatedSession = startAuthenticatedSession;

            if (initialAuth) {
              startAuthenticatedSession(
                parseBearerToken(c.req.header('Authorization'))
              );
              return;
            }

            state.authTimeout = setTimeout(() => {
              const current = liveState.get(ws);
              if (!current || current.isAuthenticated) {
                return;
              }
              closeUnauthenticatedSocket(ws);
              cleanup(ws);
            }, 5_000);
          },
          async onMessage(event, ws) {
            const state = liveState.get(ws);
            if (!state || state.isAuthenticated) {
              return;
            }

            if (typeof event.data !== 'string') {
              closeUnauthenticatedSocket(ws);
              cleanup(ws);
              return;
            }

            const token = parseWebSocketAuthToken(event.data);

            if (!token) {
              closeUnauthenticatedSocket(ws);
              cleanup(ws);
              return;
            }

            const auth = await authenticateWithBearer(token);
            const current = liveState.get(ws);
            if (!current || current.isAuthenticated) {
              return;
            }
            if (!auth) {
              closeUnauthenticatedSocket(ws);
              cleanup(ws);
              return;
            }
            current.startAuthenticatedSession?.(token);
          },
          onClose(_event, ws) {
            cleanup(ws);
          },
          onError(_event, ws) {
            cleanup(ws);
          },
        };
      })
    );
  }

  routes.get(
    '/events/:id',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged event detail by federated id',
      responses: {
        200: {
          description: 'Event detail',
          content: {
            'application/json': {
              schema: resolver(GatewayEventItemSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayEventPathParamSchema),
    zValidator(
      'query',
      ConsolePartitionQuerySchema.extend(GatewayInstanceFilterSchema.shape)
    ),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveEventTarget({
        id,
        instances,
        query,
      });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            ...(target.message ? { message: target.message } : {}),
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await fetchDownstreamJson({
        c,
        instance: target.instance,
        path: `/events/${target.localEventId}`,
        query: forwardQuery,
        schema: ConsoleRequestEventSchema,
        fetchImpl,
      });

      if (!result.ok) {
        if (result.failure.status === 404) {
          return c.json({ error: 'NOT_FOUND' }, 404);
        }
        return c.json(
          {
            error: 'DOWNSTREAM_UNAVAILABLE',
            failedInstances: [result.failure],
          },
          502
        );
      }

      return c.json({
        ...result.data,
        instanceId: target.instance.instanceId,
        federatedEventId: `${target.instance.instanceId}:${result.data.eventId}`,
        localEventId: result.data.eventId,
      });
    }
  );

  routes.get(
    '/events/:id/payload',
    describeRoute({
      tags: ['console-gateway'],
      summary: 'Get merged event payload by federated id',
      responses: {
        200: {
          description: 'Event payload',
          content: {
            'application/json': {
              schema: resolver(GatewayEventPayloadSchema),
            },
          },
        },
      },
    }),
    zValidator('param', GatewayEventPathParamSchema),
    zValidator(
      'query',
      ConsolePartitionQuerySchema.extend(GatewayInstanceFilterSchema.shape)
    ),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) {
        return unauthorizedResponse(c);
      }

      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const target = resolveEventTarget({
        id,
        instances,
        query,
      });
      if (!target.ok) {
        return c.json(
          {
            error: target.error,
            ...(target.message ? { message: target.message } : {}),
          },
          target.status
        );
      }

      const forwardQuery = sanitizeForwardQueryParams(
        new URL(c.req.url).searchParams
      );
      const result = await fetchDownstreamJson({
        c,
        instance: target.instance,
        path: `/events/${target.localEventId}/payload`,
        query: forwardQuery,
        schema: ConsoleRequestPayloadSchema,
        fetchImpl,
      });

      if (!result.ok) {
        if (result.failure.status === 404) {
          return c.json({ error: 'NOT_FOUND' }, 404);
        }
        return c.json(
          {
            error: 'DOWNSTREAM_UNAVAILABLE',
            failedInstances: [result.failure],
          },
          502
        );
      }

      return c.json({
        ...result.data,
        instanceId: target.instance.instanceId,
        federatedEventId: `${target.instance.instanceId}:${target.localEventId}`,
        localEventId: target.localEventId,
      });
    }
  );

  return routes;
}
