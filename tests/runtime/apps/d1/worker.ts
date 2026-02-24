/**
 * D1 runtime test worker.
 *
 * Runs in Cloudflare Workers runtime (via wrangler dev --local).
 * Exposes HTTP endpoints for conformance and sync scenarios.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  type ClientHandlerCollection,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import {
  codecs,
  createColumnCodecsPlugin,
  createDatabase,
} from '@syncular/core';
import { createD1Dialect } from '@syncular/dialect-d1';
import { createHttpTransport } from '@syncular/transport-http';
import type { Kysely } from 'kysely';
import type {
  ConformanceDb,
  RuntimeClientDb,
} from '../../shared/runtime-types';
import { tasksClientHandler } from '../../shared/tasks-handler';
import { assert, bytesToArray, jsonEqual } from '../../shared/test-helpers';

interface Env {
  DB: D1Database;
}

// --- Helpers ---

function buildLargeJsonPayload(): unknown {
  const bigString = 'x'.repeat(64 * 1024);
  return {
    unicode: 'こんにちは 🌍 — café — 😀',
    nested: {
      ok: true,
      bigString,
      list: Array.from({ length: 2000 }, (_, i) => ({ i, v: `value-${i}` })),
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

// --- Conformance ---

async function runConformance(env: Env): Promise<void> {
  const db = createDatabase<ConformanceDb>({
    dialect: createD1Dialect(env.DB),
    family: 'sqlite',
  }).withPlugin(
    createColumnCodecsPlugin({
      dialect: 'sqlite',
      codecs: (col) => {
        if (col.table !== 'dialect_conformance') return undefined;
        if (col.column === 'b_bool' || col.column === 'nullable_bool') {
          return codecs.numberBoolean();
        }
        if (
          col.column === 'j_json' ||
          col.column === 'j_large' ||
          col.column === 'nullable_json'
        ) {
          return codecs.stringJson();
        }
        if (col.column === 'd_date' || col.column === 'nullable_date') {
          return codecs.timestampDate();
        }
        return undefined;
      },
    })
  );
  try {
    // Create schema
    await db.schema
      .createTable('dialect_conformance')
      .ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('n_int', 'integer', (c) => c.notNull())
      .addColumn('n_bigint', 'integer', (c) => c.notNull())
      .addColumn('bigint_text', 'text', (c) => c.notNull())
      .addColumn('t_text', 'text', (c) => c.notNull())
      .addColumn('u_unique', 'text', (c) => c.notNull())
      .addColumn('b_bool', 'text', (c) => c.notNull())
      .addColumn('j_json', 'text', (c) => c.notNull())
      .addColumn('j_large', 'text', (c) => c.notNull())
      .addColumn('d_date', 'text', (c) => c.notNull())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addColumn('nullable_text', 'text')
      .addColumn('nullable_int', 'integer')
      .addColumn('nullable_bigint', 'integer')
      .addColumn('nullable_bool', 'text')
      .addColumn('nullable_bytes', 'blob')
      .addColumn('nullable_json', 'text')
      .addColumn('nullable_date', 'text')
      .execute();

    await db.schema
      .createIndex('dialect_conformance_u_unique_idx')
      .ifNotExists()
      .on('dialect_conformance')
      .column('u_unique')
      .unique()
      .execute();

    // Type roundtrip
    const now = new Date('2025-01-02T03:04:05.678Z');
    const payload = {
      a: 1,
      b: [true, null, { c: 'x', d: [1, 2, 3] }],
      e: { nested: { ok: true } },
    };
    const largePayload = buildLargeJsonPayload();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 42]);
    const bigText = '9007199254740993';
    const tText = 'unicode: 北京 — café — 😀 — newline:\nsecond-line';

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'row-1',
        n_int: 123,
        n_bigint: 42,
        bigint_text: bigText,
        t_text: tText,
        u_unique: 'u-1',
        b_bool: true,
        j_json: payload,
        j_large: largePayload,
        d_date: now,
        bytes,
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    const row = await db
      .selectFrom('dialect_conformance')
      .selectAll()
      .where('id', '=', 'row-1')
      .executeTakeFirstOrThrow();

    assert(row.n_int === 123, 'n_int mismatch');
    assert(row.bigint_text === bigText, 'bigint_text mismatch');
    assert(row.t_text === tText, 't_text mismatch');
    jsonEqual(row.j_json, payload, 'j_json');
    jsonEqual(row.j_large, largePayload, 'j_large');
    assert(row.b_bool === true, 'b_bool mismatch');
    assert(row.d_date instanceof Date, 'd_date should be Date');
    assert(row.d_date.getTime() === now.getTime(), 'd_date mismatch');
    // D1 may return various binary types depending on platform; just verify content
    const actualBytes = bytesToArray(row.bytes);
    assert(
      JSON.stringify(actualBytes) === JSON.stringify(Array.from(bytes)),
      `bytes mismatch: got ${JSON.stringify(actualBytes)} (type=${typeof row.bytes}, constructor=${row.bytes?.constructor?.name})`
    );

    // NULL toggles
    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'nulls-1',
        n_int: -1,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'row-1',
        u_unique: 'u-null-1',
        b_bool: false,
        j_json: { ok: false },
        j_large: { big: false },
        d_date: now,
        bytes: new Uint8Array([9, 8, 7]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    await db
      .updateTable('dialect_conformance')
      .set({
        nullable_text: 'hello',
        nullable_int: 2147483647,
        nullable_bigint: 42,
        nullable_bool: true,
        nullable_bytes: new Uint8Array([1, 2, 3, 4]),
        nullable_json: { ok: true },
        nullable_date: new Date('2025-02-03T04:05:06.007Z'),
      })
      .where('id', '=', 'nulls-1')
      .execute();

    const nulls = await db
      .selectFrom('dialect_conformance')
      .selectAll()
      .where('id', '=', 'nulls-1')
      .executeTakeFirstOrThrow();

    assert(nulls.nullable_text === 'hello', 'nullable_text mismatch');
    assert(nulls.nullable_int === 2147483647, 'nullable_int mismatch');
    assert(nulls.nullable_bool === true, 'nullable_bool mismatch');
    jsonEqual(nulls.nullable_json, { ok: true }, 'nullable_json');
    assert(nulls.nullable_date instanceof Date, 'nullable_date should be Date');

    // Unique constraints + upsert
    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-1',
        n_int: 1,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'one',
        u_unique: 'unique-key',
        b_bool: true,
        j_json: { ok: true },
        j_large: { ok: true },
        d_date: now,
        bytes: new Uint8Array([1]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-2',
        n_int: 2,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'two',
        u_unique: 'unique-key',
        b_bool: false,
        j_json: { ok: false },
        j_large: { ok: false },
        d_date: now,
        bytes: new Uint8Array([2]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .onConflict((oc) =>
        oc.column('u_unique').doUpdateSet({
          id: (eb) => eb.ref('excluded.id'),
          n_int: (eb) => eb.ref('excluded.n_int'),
          t_text: (eb) => eb.ref('excluded.t_text'),
          b_bool: (eb) => eb.ref('excluded.b_bool'),
        })
      )
      .execute();

    const uniq = await db
      .selectFrom('dialect_conformance')
      .select(['id', 'n_int', 't_text', 'b_bool', 'u_unique'])
      .where('u_unique', '=', 'unique-key')
      .executeTakeFirstOrThrow();

    assert(uniq.id === 'uniq-2', 'upsert id mismatch');
    assert(uniq.n_int === 2, 'upsert n_int mismatch');
    assert(uniq.t_text === 'two', 'upsert t_text mismatch');
    assert(uniq.b_bool === false, 'upsert b_bool mismatch');

    // Transaction rollback — skipped on D1 (transactions not supported by kysely-d1)
  } finally {
    await db.destroy();
  }
}

// --- Sync scenarios ---

async function createSyncClient(env: Env, serverUrl: string, actorId: string) {
  const db = createDatabase<RuntimeClientDb>({
    dialect: createD1Dialect(env.DB),
    family: 'sqlite',
  });
  await ensureClientSyncSchema(db);

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('completed', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('project_id', 'text', (c) => c.notNull())
    .addColumn('server_version', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  const handlers: ClientHandlerCollection<RuntimeClientDb> = [
    tasksClientHandler,
  ];

  const transport = createHttpTransport({
    baseUrl: serverUrl,
    getHeaders: () => ({ 'x-actor-id': actorId }),
  });

  return { db: db as Kysely<RuntimeClientDb>, handlers, transport };
}

async function runBootstrap(
  env: Env,
  params: { serverUrl: string; actorId: string; clientId: string }
): Promise<{ rowCount: number }> {
  const client = await createSyncClient(env, params.serverUrl, params.actorId);
  try {
    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [
        {
          id: 'tasks',
          table: 'tasks',
          scopes: { user_id: params.actorId, project_id: 'p1' },
        },
      ],
    });
    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { rowCount: rows.length };
  } finally {
    await client.db.destroy();
  }
}

async function runPushPull(
  env: Env,
  params: { serverUrl: string; actorId: string; clientId: string }
): Promise<{ finalRowCount: number }> {
  const client = await createSyncClient(env, params.serverUrl, params.actorId);
  try {
    const sub = {
      id: 'tasks',
      table: 'tasks',
      scopes: { user_id: params.actorId, project_id: 'p1' },
    };

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    await enqueueOutboxCommit(client.db, {
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'd1-task-1',
          op: 'upsert',
          payload: { title: 'D1 Task', completed: 0, project_id: 'p1' },
          base_version: null,
        },
      ],
    });

    const pushResult = await syncPushOnce(client.db, client.transport, {
      clientId: params.clientId,
    });

    if (!pushResult.pushed || pushResult.response?.status !== 'applied') {
      throw new Error(`Push failed: ${pushResult.response?.status}`);
    }

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { finalRowCount: rows.length };
  } finally {
    await client.db.destroy();
  }
}

// --- Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/conformance') {
      try {
        await runConformance(env);
        return jsonResponse({ ok: true });
      } catch (err) {
        return jsonResponse(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 }
        );
      }
    }

    if (url.pathname === '/bootstrap') {
      try {
        const params = (await request.json()) as {
          serverUrl: string;
          actorId: string;
          clientId: string;
        };
        const result = await runBootstrap(env, params);
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        return jsonResponse(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 }
        );
      }
    }

    if (url.pathname === '/push-pull') {
      try {
        const params = (await request.json()) as {
          serverUrl: string;
          actorId: string;
          clientId: string;
        };
        const result = await runPushPull(env, params);
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        return jsonResponse(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 }
        );
      }
    }

    return jsonResponse({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  },
};
