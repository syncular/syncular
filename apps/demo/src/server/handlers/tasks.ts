/**
 * @syncular/demo - Server-side tasks table handler
 *
 * CRDT-aware task handler for demo purposes.
 * Scope: user:{user_id}
 */

import { createServerHandler, type EmittedChange } from '@syncular/server';
import { sql } from 'kysely';
import type { ClientDb } from '../../client/types.generated';
import type { ServerDb } from '../db';

interface TaskRow {
  id: string;
  title: string;
  completed: unknown;
  user_id: unknown;
  server_version: unknown;
  image: string | null;
  title_yjs_state: unknown;
}

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readOptionalString(value);
}

function readOptionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function coerceInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function tryReadBase64TextFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  try {
    const decoded = new TextDecoder().decode(bytes).trim();
    if (!decoded || !BASE64_PATTERN.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function normalizeYjsStateValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    const encoded = tryReadBase64TextFromBytes(value);
    if (encoded) return encoded;
    return bytesToBase64(value);
  }
  return null;
}

function normalizeOutboundTaskRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const nextRow: Record<string, unknown> = { ...row };

  const state = normalizeYjsStateValue(row.title_yjs_state);
  if (state !== null || row.title_yjs_state === null) {
    nextRow.title_yjs_state = state;
  } else {
    delete nextRow.title_yjs_state;
  }

  nextRow.server_version = coerceInteger(row.server_version, 1);
  nextRow.completed = coerceInteger(row.completed, 0);

  return nextRow;
}

export const tasksServerHandler = createServerHandler<
  ServerDb,
  ClientDb,
  'tasks'
>({
  table: 'tasks',
  scopes: ['user:{user_id}'],
  resolveScopes: async (ctx) => ({
    user_id: ctx.actorId,
  }),
  applyOperation: async (ctx, op, opIndex) => {
    if (op.table !== 'tasks') {
      return {
        result: {
          opIndex,
          status: 'error',
          error: `UNKNOWN_TABLE:${op.table}`,
          code: 'UNKNOWN_TABLE',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (op.op === 'delete') {
      const existingResult = await sql<Pick<TaskRow, 'id' | 'user_id'>>`
        select ${sql.ref('id')}, ${sql.ref('user_id')}
        from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
        limit ${sql.val(1)}
      `.execute(ctx.trx);
      const existing = existingResult.rows[0];

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      const existingUserId = readOptionalString(existing.user_id);
      if (!existingUserId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'MISSING_USER_ID',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      await sql`
        delete from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);

      const emitted: EmittedChange = {
        table: 'tasks',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { user_id: existingUserId },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    const payload = isRecord(op.payload) ? op.payload : {};

    const existingResult = await sql<TaskRow>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('server_version')},
        ${sql.ref('image')},
        ${sql.ref('title_yjs_state')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const existing = existingResult.rows[0];
    const existingVersion = existing
      ? coerceInteger(existing.server_version, 0)
      : 0;

    if (
      existing &&
      op.base_version != null &&
      existingVersion !== op.base_version
    ) {
      return {
        result: {
          opIndex,
          status: 'conflict',
          message: `Version conflict: server=${existingVersion}, base=${op.base_version}`,
          server_version: existingVersion,
          server_row: normalizeOutboundTaskRow(existing),
        },
        emittedChanges: [],
      };
    }

    if (!existing && op.base_version != null && op.base_version !== 0) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: 'ROW_NOT_FOUND_FOR_BASE_VERSION',
          code: 'ROW_MISSING',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    const mergedPayload = payload;

    const payloadUserId = readOptionalString(mergedPayload.user_id);
    const existingUserId = readOptionalString(existing?.user_id);
    if (existingUserId && payloadUserId && payloadUserId !== existingUserId) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: 'CANNOT_MOVE_BETWEEN_USERS',
          code: 'INVALID_REQUEST',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    const userId = payloadUserId ?? existingUserId;
    if (!userId) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: 'MISSING_USER_ID',
          code: 'INVALID_REQUEST',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    const payloadTitle = readOptionalString(mergedPayload.title);
    const nextTitle = payloadTitle ?? existing?.title ?? '';

    const payloadCompleted = readOptionalInteger(mergedPayload.completed);
    const nextCompleted =
      payloadCompleted ?? coerceInteger(existing?.completed, 0);

    const payloadImage = readOptionalStringOrNull(mergedPayload.image);
    const nextImage =
      payloadImage === undefined ? (existing?.image ?? null) : payloadImage;

    const payloadYjsState = readOptionalStringOrNull(
      mergedPayload.title_yjs_state
    );
    const existingYjsState = readOptionalStringOrNull(
      existing?.title_yjs_state
    );
    const nextTitleYjsState =
      payloadYjsState === undefined
        ? (existingYjsState ?? null)
        : payloadYjsState;

    if (existing) {
      await sql`
        update ${sql.table('tasks')}
        set
          ${sql.ref('title')} = ${sql.val(nextTitle)},
          ${sql.ref('completed')} = ${sql.val(nextCompleted)},
          ${sql.ref('image')} = ${sql.val(nextImage)},
          ${sql.ref('title_yjs_state')} = ${sql.val(nextTitleYjsState)},
          ${sql.ref('server_version')} = ${sql.val(existingVersion + 1)}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);
    } else {
      await sql`
        insert into ${sql.table('tasks')} (
          ${sql.join([
            sql.ref('id'),
            sql.ref('title'),
            sql.ref('completed'),
            sql.ref('user_id'),
            sql.ref('image'),
            sql.ref('title_yjs_state'),
            sql.ref('server_version'),
          ])}
        ) values (
          ${sql.join([
            sql.val(op.row_id),
            sql.val(nextTitle),
            sql.val(nextCompleted),
            sql.val(userId),
            sql.val(nextImage),
            sql.val(nextTitleYjsState),
            sql.val(1),
          ])}
        )
      `.execute(ctx.trx);
    }

    const updatedResult = await sql<TaskRow>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('server_version')},
        ${sql.ref('image')},
        ${sql.ref('title_yjs_state')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new Error(`Missing task row after write: ${op.row_id}`);
    }

    const updatedUserId = readOptionalString(updated.user_id);
    if (!updatedUserId) {
      throw new Error(`Missing user_id after write: ${op.row_id}`);
    }
    const updatedVersion = coerceInteger(updated.server_version, 1);

    const outboundRow = normalizeOutboundTaskRow(updated);
    outboundRow.user_id = updatedUserId;
    outboundRow.server_version = updatedVersion;

    const emitted: EmittedChange = {
      table: 'tasks',
      row_id: op.row_id,
      op: 'upsert',
      row_json: outboundRow,
      row_version: updatedVersion,
      scopes: { user_id: updatedUserId },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
});
