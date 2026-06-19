import {
  createSyncularErrorResponse,
  type SyncularErrorCode,
} from '@syncular/core';
import type { Context } from 'hono';

type JsonErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

export function syncError(
  c: Context,
  status: JsonErrorStatus,
  code: SyncularErrorCode,
  message?: string
): Response {
  return c.json(createSyncularErrorResponse(code, { message }), status);
}

export function syncErrorResponse(
  status: JsonErrorStatus,
  code: SyncularErrorCode,
  message?: string
): Response {
  return Response.json(createSyncularErrorResponse(code, { message }), {
    status,
  });
}

export function syncLimitExceeded(
  c: Context,
  args: {
    limit: string;
    observed: number;
    max: number;
    message?: string;
  }
): Response {
  return c.json(
    createSyncularErrorResponse('runtime.limit_exceeded', {
      message:
        args.message ??
        `${args.limit} exceeded: ${args.observed} bytes > ${args.max} bytes`,
      details: {
        limit: args.limit,
        observed: args.observed,
        max: args.max,
      },
    }),
    413
  );
}
